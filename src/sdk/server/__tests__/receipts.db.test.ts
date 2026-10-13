/**
 * Real SQL concurrency must allocate one sequence and keep one receipt's bytes for competing
 * issuers. Memory-store tests cannot establish the row-lock guarantee.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { computeResultHash, verifyReceipt } from "../../../lib/receipt";
import { deriveReceiptKeypair } from "../../../lib/receipt-key";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { ReceiptIssuer } from "../receipt-issuer";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const DVM_ID = "dvm-receipt-db-test";
const RECEIPT = deriveReceiptKeypair("44".repeat(32), DVM_ID);

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-21T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe.skipIf(!RUN)("signed receipts (Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;
  const issuer = new ReceiptIssuer({
    secret: RECEIPT.secret,
    dvm: "receipt-db-test",
    dvmId: DVM_ID,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM jobs");
    await pool.query("UPDATE receipt_counter SET n = 0 WHERE id = TRUE");
  });

  afterAll(async () => {
    await pool.end();
  });

  function record(jobId: string, overrides: Partial<JobRecord> = {}): JobRecord {
    const now = Date.now();
    return {
      id: jobId,
      tags: [],
      capability: "count",
      input: "",
      params: {},
      requesterId: "test",
      status: "completed",
      summary: "done",
      messages: [],
      seq: 0,
      paidMsats: 19_000,
      paymentRail: "cashu",
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: now,
      lastActivityAt: now,
      ...overrides,
    };
  }

  async function seed(jobId: string, overrides: Partial<JobRecord> = {}): Promise<JobRecord> {
    const rec = record(jobId, overrides);
    await store.save(rec);
    return rec;
  }

  describe("claimReceiptSeq", () => {
    it("hands concurrent issuers of the SAME job one number, burning none", async () => {
      // The suppression-detection story rests on gaps meaning something. Two
      // machines racing on one job must not consume two numbers.
      await seed("job-1");
      const claims = await Promise.all([
        store.claimReceiptSeq("job-1"),
        store.claimReceiptSeq("job-1"),
      ]);
      expect(new Set(claims).size).toBe(1);
      expect(await store.claimReceiptSeq("job-1")).toBe(claims[0]);
      await seed("job-2");
      expect(await store.claimReceiptSeq("job-2")).toBe(claims[0] + 1);
    });

    it("hands concurrent issuers of DIFFERENT jobs distinct numbers", async () => {
      const ids = ["job-1", "job-2"];
      for (const id of ids) await seed(id);
      const claims = await Promise.all(ids.map((id) => store.claimReceiptSeq(id)));
      expect(new Set(claims).size).toBe(ids.length);
      expect([...claims].sort((a, b) => a - b)).toEqual([1, 2]);
    });
  });

  describe("saveReceipt", () => {
    it("is write-once — the loser of a race gets the winner's bytes", async () => {
      const rec = await seed("job-1");
      const first = issuer.issue(rec, 1);
      const second = issuer.issue({ ...rec, summary: "other output" }, 1);
      expect(second.result_hash).not.toBe(first.result_hash);

      const stored = await store.saveReceipt("job-1", first);
      const attempted = await store.saveReceipt("job-1", second);
      expect(attempted).toEqual(stored);
      expect((await store.get("job-1"))?.receipt).toEqual(first);
      await store.save({ ...rec, receipt: undefined });
      expect((await store.get("job-1"))?.receipt).toEqual(first);
    });

    it("returns undefined for a job that no longer exists", async () => {
      const orphan = issuer.issue(record("gone"), 1);
      expect(await store.saveReceipt("gone", orphan)).toBeUndefined();
    });
  });

  describe("terminal paths without a live handler", () => {
    function manager(): JobManager<unknown, undefined> {
      const descriptor = configureDVM({
        name: "receipt-db-test",
        capability: "count",
        tag: "test",
        idleTimeout: 120,
        input: z.object({ text: z.string() }),
        onJob: () => undefined,
      });
      return new JobManager(descriptor, {
        env: {},
        store: new MemoryKVStore(),
        jobStore: store,
        devMode: true,
        fxFetcher: stubFx,
        staleJobTimeoutMs: 0,
        processingWatchdogMs: 0,
        staleJobSweepIntervalMs: 0,
        heartbeatIntervalMs: 0,
        receiptIssuer: issuer,
        dvmId: "dvm-1",
      }) as unknown as JobManager<unknown, undefined>;
    }

    it("attests a job the crash watchdog reaped", async () => {
      // The case receipts matter most for: the caller paid, the worker died,
      // and this receipt is the evidence a refund claim rests on.
      const jm = manager();
      const stale = Date.now() - 10 * 60_000;
      await seed("job-1", { status: "processing", summary: undefined, lastActivityAt: stale });

      const claimed = await store.cancelStaleJob(
        "job-1",
        Date.now() - 5 * 60_000,
        "worker_died_mid_job",
        "failed"
      );
      expect(claimed).toBe(true);
      await jm.issueReceiptForStoredJob("job-1");

      const receipt = (await store.get("job-1"))?.receipt;
      expect(receipt).toBeDefined();
      if (!receipt) return;
      expect(verifyReceipt(receipt)).toBe(true);
      expect(receipt).toMatchObject({
        outcome: "failed",
        reason: "worker_died_mid_job",
        paid: { msats: 19_000, rail: "cashu" },
      });
      // `cancelStaleJob` writes `summary = COALESCE(summary, reason)`, so the
      // row's summary is now the reason string. It must not be hashed as
      // delivered output: this job handed the caller nothing, and a verifier
      // recomputing from the (empty) message stream has to land on `null`.
      expect((await store.get("job-1"))?.summary).toBe("worker_died_mid_job");
      expect(receipt.result_hash).toBeNull();
      jm.shutdown();
    });

    it("binds the artifacts a reaped job did deliver, without the reason", async () => {
      // The other half of the refund-evidence distinction: partial output is
      // still hashed, recomputable from the message stream alone.
      const jm = manager();
      const artifact = { name: "partial.json", mime_type: "application/json", data: '{"n":6}' };
      await seed("job-1", {
        status: "processing",
        summary: undefined,
        lastActivityAt: Date.now() - 10 * 60_000,
        messages: [{ seq: 1, type: "artifact", content: artifact }] as JobRecord["messages"],
      });
      await store.cancelStaleJob("job-1", Date.now() - 5 * 60_000, "worker_died_mid_job", "failed");
      await jm.issueReceiptForStoredJob("job-1");

      const receipt = (await store.get("job-1"))?.receipt;
      expect(receipt?.result_hash).toBe(computeResultHash(undefined, [artifact]));
      jm.shutdown();
    });

    it("re-issues after a crash between the seq claim and the receipt write", async () => {
      // `claimReceiptSeq` commits before `saveReceipt`; a process death in that
      // window would strand the number permanently, and a permanent gap is
      // indistinguishable from the suppression `seq` exists to expose.
      const jm = manager();
      await seed("job-1", { status: "processing", summary: undefined });
      await store.cancelJob("job-1", "caller changed their mind");
      const claimed = await store.claimReceiptSeq("job-1");

      const repaired = await jm.issueReceiptForStoredJob("job-1");
      expect(repaired?.seq).toBe(claimed);
      const { rows } = await pool.query<{ n: string }>("SELECT n FROM receipt_counter");
      expect(Number(rows[0].n)).toBe(claimed);
      jm.shutdown();
    });

    it("attests a cancel that landed on a machine not running the job", async () => {
      const jm = manager();
      await seed("job-1", { status: "processing", summary: undefined });
      expect(await store.cancelJob("job-1", "caller changed their mind")).toBe(true);
      await jm.issueReceiptForStoredJob("job-1");

      const receipt = (await store.get("job-1"))?.receipt;
      expect(receipt).toBeDefined();
      if (!receipt) return;
      expect(verifyReceipt(receipt)).toBe(true);
      expect(receipt).toMatchObject({
        outcome: "cancelled",
        reason: "caller changed their mind",
      });
      jm.shutdown();
    });

    it("converges when both machines issue for the same cancel", async () => {
      const jm = manager();
      await seed("job-1", { status: "processing", summary: undefined });
      await store.cancelJob("job-1", "caller changed their mind");
      const [a, b] = await Promise.all([
        jm.issueReceiptForStoredJob("job-1"),
        jm.issueReceiptForStoredJob("job-1"),
      ]);
      expect(a).toEqual(b);
      // Exactly one sequence number consumed between the two of them.
      const { rows } = await pool.query<{ n: string }>("SELECT n FROM receipt_counter");
      expect(Number(rows[0].n)).toBe(1);
      jm.shutdown();
    });

    it("never issues for a non-terminal job", async () => {
      const jm = manager();
      await seed("job-1", { status: "processing", summary: undefined });
      expect(await jm.issueReceiptForStoredJob("job-1")).toBeUndefined();
      const { rows } = await pool.query<{ n: string }>("SELECT n FROM receipt_counter");
      expect(Number(rows[0].n)).toBe(0);
      jm.shutdown();
    });
  });
});
