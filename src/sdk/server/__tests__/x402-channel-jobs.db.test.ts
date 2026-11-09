/* A capability name is unique only within a channel, so a job must dispatch by its persisted channel. */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { PostgresJobStore } from "../postgres-job-store";
import type { JobTerminalReportPayload } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("jobs on two channels sharing a capability name (Postgres)", () => {
  const schema = `x402_channel_${randomUUID().replaceAll("-", "")}`;
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
  afterEach(() => {
    for (const manager of managers.splice(0)) manager.shutdown();
  });
  afterAll(async () => {
    await store?.shutdownStreaming();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  /** Which definition ran, and the input it parsed, per job id. */
  const ran = new Map<string, { definition: string; input: unknown }>();

  function manager(onJobTerminal?: (info: JobTerminalReportPayload) => Promise<void>) {
    const descriptor = configureDVM({
      name: "channel-dispatch-test",
      x402: { network: "eip155:84532", payTo: "0x1111111111111111111111111111111111111111" },
      capabilities: {
        fetch: {
          input: z.object({ url: z.string(), depth: z.number() }),
          price: "$0.02",
          onJob(ctx) {
            ran.set(ctx.jobId, { definition: "job", input: ctx.input });
            ctx.complete("crawled");
          },
        },
        "fetch-x402": {
          name: "fetch",
          channels: { job: false, x402: {} },
          input: z.object({ url: z.string() }),
          price: "$0.01",
          maxRuntimeSeconds: 9,
          onJob(ctx) {
            ran.set(ctx.jobId, { definition: "x402", input: ctx.input });
            ctx.complete("fetched");
          },
        },
      },
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      devMode: true,
      dvmId: "channel-dispatch-dvm",
      staleJobTimeoutMs: 0,
      fxFetcher: createFxFetcher(),
      ...(onJobTerminal ? { onJobTerminal } : {}),
    });
    managers.push(jm);
    return jm;
  }

  async function submit(
    jm: JobManager<unknown, undefined>,
    data: Record<string, unknown>,
    channel?: "x402"
  ) {
    const input = JSON.stringify(data);
    const job = jm.createJob({ input }, "anonymous", { paidMsats: 0, receivedProofs: [] }, undefined, "fetch", undefined, {
      ...(channel ? { channel } : {}),
    });
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, jm.parseInput({ input }, "fetch", channel === "x402", channel)));
    await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
    await job.terminalWork;
    return job;
  }

  it("runs each channel's own definition, and a restarted manager re-dispatches the x402 job to its x402 definition", async () => {
    const reports: JobTerminalReportPayload[] = [];
    const first = manager(async (info) => {
      reports.push(info);
    });
    const viaJob = await submit(first, { url: "https://example.com", depth: 2 });
    const viaX402 = await submit(first, { url: "https://example.com" }, "x402");

    expect(ran.get(viaJob.id)).toEqual({ definition: "job", input: { url: "https://example.com", depth: 2 } });
    expect(ran.get(viaX402.id)).toEqual({ definition: "x402", input: { url: "https://example.com" } });
    expect((await store.get(viaX402.id))?.channel).toBe("x402");
    expect((await store.get(viaJob.id))?.channel).toBeUndefined();

    // Reports keep the two apart: the x402 job says so, the dvmkit-protocol one keeps its old shape.
    expect(reports.find((r) => r.jobId === viaX402.id)).toMatchObject({ capability: "fetch", channel: "x402" });
    expect(reports.find((r) => r.jobId === viaJob.id)).not.toHaveProperty("channel");

    // A fresh manager, as after a restart, rebuilds the job from its row alone.
    first.shutdown();
    ran.delete(viaX402.id);
    const restarted = manager();
    const record = await store.get(viaX402.id);
    if (!record) throw new Error("x402 job row missing");
    const { job, sdkCtx } = restarted.reactivateJob({ ...record, status: "processing" });
    restarted.runHandler(job, sdkCtx);
    await vi.waitFor(() => expect(ran.get(viaX402.id)).toEqual({ definition: "x402", input: { url: "https://example.com" } }));
  });
});
