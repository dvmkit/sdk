/**
 * Postgres-backed coverage for the status-aware stale-job sweeper
 * arms — `findStaleJobs` (two cutoffs), `heartbeatActiveJobs`, and
 * `cancelStaleJob` (both terminal statuses + the CAS guard) — against real
 * Postgres so the rewritten SQL / placeholder renumbering can't drift past the
 * MemoryJobStore-only unit suite.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("status-aware stale-job sweeper (Postgres)", () => {
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

  async function seedJob(
    jobId: string,
    status: JobRecord["status"],
    lastActivityAt: number
  ): Promise<void> {
    const record: JobRecord = {
      id: jobId,
      tags: [],
      capability: "synthesise",
      input: "",
      params: {},
      requesterId: "test",
      status,
      messages: [],
      seq: 0,
      paidMsats: 1000,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: lastActivityAt,
      lastActivityAt,
    };
    await store.save(record);
  }

  async function statusOf(jobId: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [
      jobId,
    ]);
    return rows[0]?.status;
  }

  async function lastActivityOf(jobId: string): Promise<number> {
    const { rows } = await pool.query<{ last_activity_at: string }>(
      "SELECT last_activity_at FROM jobs WHERE id = $1",
      [jobId]
    );
    return Number(rows[0].last_activity_at);
  }

  it("findStaleJobs applies the tight processing cutoff and the long awaiting cutoff independently", async () => {
    const now = Date.now();
    const procCutoff = now - 5 * 60_000; // processing watchdog
    const awaitCutoff = now - 2 * 3600_000; // long idle timeout

    // processing: one stale (older than proc cutoff), one live (newer)
    await seedJob("proc-stale", "processing", procCutoff - 1000);
    await seedJob("proc-live", "processing", now - 1000);
    // working aliases processing in the watchdog arm
    await seedJob("work-stale", "working", procCutoff - 1000);
    // awaiting-input: stale only past the *long* cutoff, not the tight one
    await seedJob("await-recent", "awaiting-input", procCutoff - 1000);
    await seedJob("await-stale", "awaiting-input", awaitCutoff - 1000);
    // terminal rows are never swept
    await seedJob("done", "completed", procCutoff - 1000);

    const stale = await store.findStaleJobs(procCutoff, awaitCutoff, 100, null);
    const ids = new Set(stale.map((j) => j.id));

    expect(ids).toEqual(new Set(["proc-stale", "work-stale", "await-stale"]));
  });

  it("a negative processing cutoff disables the watchdog arm", async () => {
    const now = Date.now();
    const awaitCutoff = now - 2 * 3600_000;
    await seedJob("proc-old", "processing", now - 10 * 60_000);
    await seedJob("await-old", "awaiting-input", awaitCutoff - 1000);

    const stale = await store.findStaleJobs(-1, awaitCutoff, 100, null);
    expect(stale.map((j) => j.id)).toEqual(["await-old"]);
  });

  it("findStaleJobs honours the capability filter", async () => {
    const now = Date.now();
    const procCutoff = now - 5 * 60_000;
    await seedJob("match", "processing", procCutoff - 1000);
    await seedJob("other", "processing", procCutoff - 1000);
    await pool.query("UPDATE jobs SET capability = 'list-voices' WHERE id = 'other'");

    const stale = await store.findStaleJobs(procCutoff, procCutoff, 100, ["synthesise"]);
    expect(stale.map((j) => j.id)).toEqual(["match"]);
  });

  it("heartbeatActiveJobs bumps processing/working rows but not awaiting-input or terminal", async () => {
    const old = Date.now() - 30 * 60_000;
    await seedJob("hb-proc", "processing", old);
    await seedJob("hb-work", "working", old);
    await seedJob("hb-await", "awaiting-input", old);
    await seedJob("hb-done", "completed", old);

    const beat = old + 10 * 60_000;
    await store.heartbeatActiveJobs(["hb-proc", "hb-work", "hb-await", "hb-done"], beat);

    expect(await lastActivityOf("hb-proc")).toBe(beat);
    expect(await lastActivityOf("hb-work")).toBe(beat);
    expect(await lastActivityOf("hb-await")).toBe(old);
    expect(await lastActivityOf("hb-done")).toBe(old);
  });

  it("cancelStaleJob marks a dead-worker job failed and an awaiting job cancelled", async () => {
    const stamp = Date.now() - 60_000;
    await seedJob("dead-worker", "processing", stamp);
    await seedJob("no-terminal", "awaiting-input", stamp);

    expect(await store.cancelStaleJob("dead-worker", stamp, "worker_died_mid_job", "failed")).toBe(
      true
    );
    expect(
      await store.cancelStaleJob("no-terminal", stamp, "stale_no_terminal_status", "cancelled")
    ).toBe(true);

    expect(await statusOf("dead-worker")).toBe("failed");
    expect(await statusOf("no-terminal")).toBe("cancelled");
  });

  it("cancelStaleJob CAS no-ops when the row was heartbeated after the cutoff", async () => {
    const cutoff = Date.now() - 5 * 60_000;
    // Row is fresher than the cutoff — a live worker heartbeated it.
    await seedJob("live", "processing", cutoff + 60_000);

    const cancelled = await store.cancelStaleJob("live", cutoff, "worker_died_mid_job", "failed");
    expect(cancelled).toBe(false);
    expect(await statusOf("live")).toBe("processing");
  });
});
