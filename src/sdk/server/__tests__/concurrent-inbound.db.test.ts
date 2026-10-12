import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("concurrent inbound + advisory lock", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresJobStore;
  let storeB: PostgresJobStore;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new PostgresJobStore(poolA);
    storeB = new PostgresJobStore(poolB);
    await storeA.init();
  });

  afterEach(async () => {
    await poolA.query("DELETE FROM job_messages");
    await poolA.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await poolA.end();
    await poolB.end();
  });

  async function seedJob(jobId: string, paidMsats = 0, pending = 0): Promise<void> {
    const record: JobRecord = {
      id: jobId,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "test",
      status: "awaiting-input",
      messages: [],
      seq: 0,
      paidMsats,
      pendingPaymentMsats: pending || undefined,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await storeA.save(record);
  }

  it("server-allocated seq survives concurrent inbound on two stores", async () => {
    const jobId = "concurrent-seq-1";
    await seedJob(jobId);

    // Fire 10 inbound writes from each store concurrently. Without
    // server-allocated seq (UPDATE jobs SET next_seq RETURNING), the two
    // processes would collide on the (job_id, seq) PK and at least one
    // INSERT would fail.
    const N = 10;
    const ops: Promise<number>[] = [];
    for (let i = 0; i < N; i++) {
      ops.push(
        storeA.recordInbound(jobId, {
          from: "requester",
          type: "response",
          timestamp: i,
          content: { prompt_id: `a-${i}`, text: "a" },
        })
      );
      ops.push(
        storeB.recordInbound(jobId, {
          from: "requester",
          type: "response",
          timestamp: i,
          content: { prompt_id: `b-${i}`, text: "b" },
        })
      );
    }
    const seqs = await Promise.all(ops);

    expect(seqs.toSorted((a, b) => a - b)).toEqual(
      Array.from({ length: 2 * N }, (_, index) => index + 1)
    );

    const { rows } = await poolA.query<{ count: string }>(
      "SELECT COUNT(*) FROM job_messages WHERE job_id = $1",
      [jobId]
    );
    expect(Number(rows[0].count)).toBe(2 * N);
  });

  it("advisory lock prevents two simultaneous reactivations on the same job", async () => {
    const jobId = "concurrent-lock-1";
    await seedJob(jobId);

    let acquiredA!: () => void;
    let releaseA!: () => void;
    const enteredA = new Promise<void>((resolve) => { acquiredA = resolve; });
    const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
    const aPromise = storeA.tryReactivationLock(jobId, async () => {
      acquiredA();
      await heldA;
      return "a-done";
    });
    await enteredA;
    try {
      expect(await storeB.tryReactivationLock(jobId, async () => "b-done")).toEqual({
        acquired: false,
      });
    } finally {
      releaseA();
    }
    expect(await aPromise).toEqual({ acquired: true, result: "a-done" });
  });

  it("save() does not regress the DB seq with a stale in-memory snapshot", async () => {
    const jobId = "seq-monotonic-1";
    await seedJob(jobId);

    const fresh = await storeA.get(jobId);
    if (!fresh) throw new Error("seed missing");
    fresh.seq = 5;
    await storeA.save(fresh);
    expect((await storeA.get(jobId))?.seq).toBe(5);

    const stale: JobRecord = { ...fresh, seq: 0 };
    await storeB.save(stale);
    expect((await storeA.get(jobId))?.seq).toBe(5);
  });

  it("Tx C is idempotent — a repeat call returns alreadyVerified", async () => {
    const jobId = "tx-c-idempotent-1";
    await seedJob(jobId, 0, 5_000);

    const seq = await storeA.recordInbound(jobId, {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 5_000 },
    });

    const first = await storeA.verifyAndCredit(jobId, seq, {
      paidMsatsDelta: 5_000,
      clearPending: true,
      paymentRail: "cashu",
    });
    expect(first.alreadyVerified).toBe(false);
    expect(first.counters.paidMsats).toBe(5_000);
    expect(first.counters.pendingPaymentMsats).toBeUndefined();

    const second = await storeA.verifyAndCredit(jobId, seq, {
      paidMsatsDelta: 5_000,
      clearPending: true,
      paymentRail: "cashu",
    });
    expect(second.alreadyVerified).toBe(true);
    expect(second.counters.paidMsats).toBe(5_000);
  });

  it("getVerifiedInbound answers only once Tx C has committed", async () => {
    const jobId = "tx-c-readback-1";
    await seedJob(jobId, 0, 5_000);

    const seq = await storeA.recordInbound(jobId, {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 5_000 },
    });

    expect(await storeA.getVerifiedInbound(jobId, seq)).toBeUndefined();
    expect(await storeA.getVerifiedInbound(jobId, seq + 99)).toBeUndefined();

    await storeA.verifyAndCredit(jobId, seq, {
      paidMsatsDelta: 5_000,
      clearPending: true,
      paymentRail: "cashu",
      creditId: "imp:cashu:readback",
      drawId: "readback",
    });

    expect(await storeB.getVerifiedInbound(jobId, seq)).toEqual({
      counters: { status: "awaiting-input", paidMsats: 5_000, pendingPaymentMsats: undefined },
      alreadyVerified: true,
      creditId: "imp:cashu:readback",
      drawId: "readback",
    });
  });

  it("getVerifiedInbound does not report a failed-verify inbound", async () => {
    const jobId = "tx-c-readback-2";
    await seedJob(jobId, 0, 5_000);

    const seq = await storeA.recordInbound(jobId, {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 5_000 },
    });
    await storeA.markInboundFailed(jobId, seq, "payment_unapplied");

    expect(await storeA.getVerifiedInbound(jobId, seq)).toBeUndefined();
  });
});
