import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("concurrent job snapshots", () => {
  const schema = `snapshot_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let snapshots: pg.Pool;
  let updates: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    snapshots = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
    updates = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
    store = new PostgresJobStore(snapshots);
    await store.init();
  });

  afterAll(async () => {
    await snapshots?.end();
    await updates?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  function record(): JobRecord {
    const id = randomUUID();
    return {
      id, tags: [], capability: "test", input: "hello", params: {}, requesterId: "requester",
      requesterPubkey: "11".repeat(32), requestId: id, status: "processing",
      messages: [], seq: 0, paidMsats: 0, receivedProofs: [], stepCache: [], state: {},
      createdAt: Date.now(), lastActivityAt: Date.now(),
    };
  }

  function save(job: JobRecord, worker: number) {
    return worker % 2 ? store.saveForDvm({ ...job }, "snapshot-test") : store.save({ ...job });
  }

  function failures(results: PromiseSettledResult<unknown>[]) {
    return results.flatMap(result => result.status === "rejected" ? [{
      code: (result.reason as { code?: string }).code,
      constraint: (result.reason as { constraint?: string }).constraint,
      message: String(result.reason),
    }] : []);
  }

  it.each([false, true])("saves 100 concurrent waves with pre-existing row = %s", async (seed) => {
    const errors: ReturnType<typeof failures> = [];
    for (let wave = 0; wave < 100; wave++) {
      const job = record();
      if (seed) await store.save(job);
      errors.push(...failures(await Promise.allSettled(Array.from({ length: 16 }, (_, worker) => save(job, worker)))));
      expect((await store.get(job.id))?.requestId).toBe(job.requestId);
    }
    expect(errors).toEqual([]);
  }, 30_000);

  it("saves an existing row during continuous indexed-status and sequence updates", async () => {
    const job = record();
    await store.save(job);
    const results = await Promise.all(Array.from({ length: 16 }, async (_, worker) => {
      const errors: ReturnType<typeof failures> = [];
      for (let iteration = 0; iteration < 100; iteration++) {
        const status = iteration % 2 ? "processing" : "awaiting-input";
        errors.push(...failures(await Promise.allSettled([
          worker < 8 ? save({ ...job, status }, worker) : updates.query(
            "UPDATE jobs SET next_seq = next_seq + 1, status = $2 WHERE id = $1", [job.id, status]
          ),
        ])));
      }
      return errors;
    }));
    expect(results.flat()).toEqual([]);
    const counter = await snapshots.query("SELECT next_seq FROM jobs WHERE id=$1", [job.id]);
    expect(counter.rows[0].next_seq).toBe(801);
  }, 30_000);

  it("rejects another job with the same caller/request pair without modifying its owner", async () => {
    const original = record();
    await store.save(original);
    for (const worker of [0, 1]) {
      await expect(save({ ...original, id: randomUUID(), input: "intruder" }, worker))
        .rejects.toMatchObject({ code: "23505", constraint: "idx_jobs_request_id_caller" });
    }
    expect(await store.get(original.id)).toMatchObject({ input: "hello", requestId: original.requestId });
    const count = await snapshots.query("SELECT count(*)::int AS n FROM jobs WHERE request_id=$1", [original.requestId]);
    expect(count.rows[0].n).toBe(1);
  });

  it("keeps transactional credit and counters while terminal snapshots race inbound messages", async () => {
    const job = record();
    await store.save(job);
    const terminal = { ...job, status: "completed" as const, summary: "done" };
    const allocated = await Promise.all(Array.from({ length: 8 }, (_, worker) => store.recordInbound(job.id, {
      from: "requester", type: "payment", timestamp: Date.now(), content: { worker },
    })));
    const results = await Promise.allSettled([
      ...Array.from({ length: 8 }, (_, worker) => save(terminal, worker)),
      ...allocated.map(seq => store.verifyAndCredit(job.id, seq, { paidMsatsDelta: 1000, clearPending: true })),
    ]);
    expect(failures(results)).toEqual([]);
    expect(allocated.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await store.get(job.id)).toMatchObject({ status: "completed", summary: "done", paidMsats: 8000 });
    const counter = await snapshots.query("SELECT next_seq FROM jobs WHERE id=$1", [job.id]);
    expect(counter.rows[0].next_seq).toBe(9);
  });

  it("preserves terminal state and payment/sequence counters under stale snapshots", async () => {
    const job = record();
    await store.save(job);
    const seq = await store.recordInbound(job.id, { from: "requester", type: "payment", timestamp: Date.now(), content: {} });
    await store.verifyAndCredit(job.id, seq, { paidMsatsDelta: 5000, clearPending: true });
    const paid = await store.get(job.id);
    await store.save({ ...paid!, status: "completed", summary: "done", seq });
    await Promise.all(Array.from({ length: 16 }, (_, worker) => save(job, worker)));
    expect(await store.get(job.id)).toMatchObject({ status: "completed", summary: "done", paidMsats: 5000, seq });
    const counter = await snapshots.query("SELECT next_seq FROM jobs WHERE id=$1", [job.id]);
    expect(counter.rows[0].next_seq).toBe(seq + 1);
  });
});
