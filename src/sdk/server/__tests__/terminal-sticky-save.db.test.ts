/**
 * Durable terminal status must survive stale snapshots, even if a remote cancel notification has
 * not been adopted yet.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord, JobStatus } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("terminal-sticky save", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  function record(status: JobStatus, summary?: string): JobRecord {
    return {
      id: "job-sticky-1",
      tags: [],
      capability: "test",
      input: "hello",
      params: {},
      requesterId: "requester-1",
      status,
      summary,
      messages: [],
      seq: 0,
      paidMsats: 5_000,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  it("keeps a cancelled row cancelled when a zombie handler saves `completed`", async () => {
    await store.save(record("processing"));
    // A DELETE lands on another machine — store-only cancel.
    await store.save(record("cancelled", "caller cancelled"));

    // The handler, still running on its own machine, finishes its work.
    await store.save(record("completed", "resurrected"));

    const after = await store.get("job-sticky-1");
    expect(after?.status).toBe("cancelled");
    expect(after?.summary).toBe("caller cancelled");
  });

  it("keeps a failed row failed when the reaped worker saves `completed`", async () => {
    await store.save(record("processing"));
    await store.save(record("failed", "worker_died_mid_job"));

    await store.save(record("completed", "resurrected"));

    const after = await store.get("job-sticky-1");
    expect(after?.status).toBe("failed");
    expect(after?.summary).toBe("worker_died_mid_job");
  });

  it("still allows an idempotent re-save of the same terminal status", async () => {
    await store.save(record("processing"));
    await store.save(record("completed", "done"));
    await store.save(record("completed", "done (repersisted)"));

    const after = await store.get("job-sticky-1");
    expect(after?.status).toBe("completed");
    expect(after?.summary).toBe("done (repersisted)");
  });

  it("still allows the first terminal transition and ordinary non-terminal saves", async () => {
    await store.save(record("processing"));
    await store.save(record("awaiting-input"));
    expect((await store.get("job-sticky-1"))?.status).toBe("awaiting-input");

    await store.save(record("completed", "done"));
    expect((await store.get("job-sticky-1"))?.status).toBe("completed");
  });
});
