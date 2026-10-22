import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("durable step records", () => {
  const schema = `steps_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresJobStore;
  const managers: { shutdown(): void }[] = [];

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    store = new PostgresJobStore(pool);
    await store.init();
  });
  afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });
  afterAll(async () => {
    await store?.shutdownStreaming();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  function manager(onJob: (ctx: SDKJobContext) => Promise<void>) {
    const descriptor = configureDVM({ name: "durable-step-test", capability: "test", onJob });
    const jm = new JobManager(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true, staleJobTimeoutMs: 0, fxFetcher: createFxFetcher(),
    });
    managers.push(jm);
    return jm;
  }

  function record(): JobRecord {
    return {
      id: randomUUID(), tags: [], capability: "test", input: "", params: {}, requesterId: "requester",
      status: "processing", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
      stepCache: [], state: {}, createdAt: Date.now(), lastActivityAt: Date.now(),
    };
  }

  it("stores the result and costs before a handler yields or finishes", async () => {
    const stepped = Promise.withResolvers<void>();
    const hang = Promise.withResolvers<void>();
    const jm = manager(async ctx => {
      await ctx.step("reserve", async () => {
        ctx.cost({ amount: 0.25, currency: "usd" });
        return { reservation: "booking-1" };
      });
      stepped.resolve();
      await hang.promise;
    });
    const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, ""));
    try {
      await stepped.promise;
      jm.shutdown();
      const restored = await new PostgresJobStore(pool).get(job.id);
      expect(restored).toMatchObject({ status: "processing", messages: [], stepCache: [{
        id: "reserve", value: { reservation: "booking-1" }, costs: [{ amount: 0.25, currency: "usd" }],
      }] });
    } finally {
      hang.resolve();
    }
  });

  it("replays on a fresh manager without repeating a side effect after the prompt snapshot fails", async () => {
    let bookings = 0;
    const answered = Promise.withResolvers<unknown>();
    const handler = async (ctx: SDKJobContext) => {
      await ctx.step("reserve", async () => {
        bookings++;
        ctx.cost({ amount: 0.25, currency: "usd" });
        return "booking-1";
      });
      const answer = await ctx.prompt("continue", "Continue?");
      answered.resolve(answer);
    };
    const first = manager(handler);
    const job = first.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
    await first.persistJob(job);
    const failed = Promise.withResolvers<void>();
    const save = vi.spyOn(store, "save").mockImplementation(async () => {
      failed.resolve();
      throw new Error("snapshot unavailable");
    });
    first.runHandler(job, first.buildAndAttachContext(job, ""));
    await failed.promise;
    await job.messageAppenderTail;
    first.shutdown();
    save.mockRestore();

    const persisted = (await store.get(job.id))!;
    expect(persisted.status).toBe("awaiting-input");
    const second = manager(handler);
    const snapshot = vi.spyOn(second, "persistJob");
    const restored = second.reactivateJob(persisted);
    second.runHandler(restored.job, restored.sdkCtx);
    await vi.waitFor(() => expect(restored.job.pendingPrompts.has("continue")).toBe(true));
    await snapshot.mock.results[0].value;
    await second.dispatchMessage(restored.job, "response", { prompt_id: "continue", text: "yes" });
    expect(await answered.promise).toMatchObject({ prompt_id: "continue", text: "yes" });
    expect(bookings).toBe(1);
    expect(restored.job.costAmountMicro).toBe(250_000);
    await restored.job.messageAppenderTail;
  });

  it("merges concurrent steps and stale snapshots without changing unrelated fields", async () => {
    const job = record();
    await store.save(job);
    const seq = await store.recordInbound(job.id, { from: "requester", type: "payment", timestamp: Date.now(), content: {} });
    await store.verifyAndCredit(job.id, seq, { paidMsatsDelta: 1000, clearPending: true });
    const beforeSteps = (await pool.query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows[0];
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.saveStep(job.id, {
      id: `step-${i}`, value: i, costs: [{ amount: 0.25, currency: "usd" }],
    })));
    const afterSteps = (await pool.query("SELECT * FROM jobs WHERE id=$1", [job.id])).rows[0];
    expect({ ...afterSteps, step_cache: [] }).toEqual({ ...beforeSteps, step_cache: [] });
    const committed = (await store.get(job.id))!;
    expect(committed.stepCache.map(step => step.id).sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `step-${i}`).sort(),
    );
    expect(committed).toMatchObject({ status: "processing", state: {}, paidMsats: 1000 });
    await Promise.all([
      store.save(job),
      store.saveForDvm(job, "step-test"),
      store.saveStep(job.id, { id: "last", value: 13 }),
    ]);
    const restored = (await store.get(job.id))!;
    expect(restored.stepCache).toEqual(expect.arrayContaining(committed.stepCache));
    expect(restored.stepCache).toHaveLength(13);
    expect(restored.paidMsats).toBe(1000);
    expect((await pool.query("SELECT next_seq FROM jobs WHERE id=$1", [job.id])).rows[0].next_seq).toBe(seq + 1);
  });

  it("keeps the first stored result on retries and conflicting snapshots", async () => {
    const job = record();
    await store.save(job);
    const step = { id: "reserve", value: "first", costs: [{ amount: 0.25, currency: "usd" }] };
    await store.saveStep(job.id, step);
    await store.saveStep(job.id, { id: "reserve", value: "second" });
    await store.save({ ...job, stepCache: [{ id: "reserve", value: "stale" }] });
    expect((await store.get(job.id))?.stepCache).toEqual([step]);
  });

  it.each(["completed", "failed", "cancelled", "redacted", "missing"] as const)(
    "rejects writes to a %s job", async state => {
      const job = record();
      if (state !== "missing") {
        await store.save({ ...job, status: state === "redacted" ? "processing" : state });
        if (state === "redacted") await pool.query("UPDATE jobs SET redacted_at=$2 WHERE id=$1", [job.id, Date.now()]);
      }
      await expect(store.saveStep(job.id, { id: "reserve", value: "booking" })).rejects.toThrow("live job");
      expect((await store.get(job.id))?.stepCache ?? []).toEqual([]);
    },
  );
});
