import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("cross-machine NOTIFY-driven resolver wake", () => {
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
    await storeA.initStreaming();
    await storeB.initStreaming();
  });

  afterEach(async () => {
    await poolA.query("DELETE FROM job_messages");
    await poolA.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await storeA.shutdownStreaming();
    await storeB.shutdownStreaming();
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

  it("A's resolver wakes via NOTIFY when B's Tx C commits credit", async () => {
    const jobId = "wake-1";
    await seedJob(jobId, 0, 7_000);

    // A: simulate a suspended handler's NOTIFY-driven counter-watch loop.
    // On each notification, re-read counters; resolve when satisfied.
    let resolvedCounters: { paidMsats: number; pending?: number } | null = null;
    const woke = new Promise<void>((resolve) => {
      void storeA.subscribeNotifications(jobId, () => {
        void storeA.getCounters(jobId).then((counters) => {
          if (resolvedCounters) return;
          if (counters && counters.paidMsats >= 7_000) {
            resolvedCounters = {
              paidMsats: counters.paidMsats,
              pending: counters.pendingPaymentMsats,
            };
            resolve();
          }
        });
      });
    });

    // B: record inbound + Tx C verify+credit. NOTIFY fires from B's pool.
    const seq = await storeB.recordInbound(jobId, {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 7_000 },
    });
    await storeB.verifyAndCredit(jobId, seq, {
      paidMsatsDelta: 7_000,
      clearPending: true,
      paymentRail: "cashu",
    });

    // A's listener wakes from NOTIFY fired by B's commit. With server-allocated
    // seq and the existing `LISTEN job_messages` channel, the cross-pool
    // notification round-trip lands well under a second.
    await Promise.race([
      woke,
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(new Error("resolver did not wake within 3s"));
        }, 3000)
      ),
    ]);

    const snap = resolvedCounters as { paidMsats: number; pending?: number } | null;
    expect(snap?.paidMsats).toBe(7_000);
    expect(snap?.pending).toBeUndefined();
  });

  it("Tx C atomically credits paid_msats and clears pending_payment_msats", async () => {
    const jobId = "atomic-1";
    await seedJob(jobId, 1_000, 5_000);
    const seq = await storeB.recordInbound(jobId, {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 5_000 },
    });

    const before = await storeA.getCounters(jobId);
    expect(before?.paidMsats).toBe(1_000);
    expect(before?.pendingPaymentMsats).toBe(5_000);

    const { counters, alreadyVerified } = await storeB.verifyAndCredit(jobId, seq, {
      paidMsatsDelta: 5_000,
      clearPending: true,
      paymentRail: "cashu",
      paymentMint: "https://mint.example",
    });
    expect(alreadyVerified).toBe(false);
    expect(counters.paidMsats).toBe(6_000);
    expect(counters.pendingPaymentMsats).toBeUndefined();

    // A reads the same counters — Tx C committed atomically.
    const after = await storeA.getCounters(jobId);
    expect(after?.paidMsats).toBe(6_000);
    expect(after?.pendingPaymentMsats).toBeUndefined();
  });
});
