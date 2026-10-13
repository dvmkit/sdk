/* Sweep holds whose job never persisted and reconcile terminal draws whose inline resolution failed. */
import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { CreditLedgerError, type CreditLedgerLike, type DrawRecord } from "../credit-ledger";
import { JobManager, type JobManagerOpts } from "../job-manager";
import type { JobRecord, JobStatus } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "ab".repeat(32);
const ORPHAN_AGE_MS = 15 * 60_000;

const RECONCILE_AGE_MS = 30 * 60_000;

const SCAN_PAGE_LIMIT = 50;

const BLIND_SPOT_PROBE_LIMIT = 1;
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const TERMINAL: JobStatus[] = ["completed", "failed", "cancelled"];
const NON_TERMINAL: JobStatus[] = ["processing", "working", "awaiting-input"];

function buildManager(
  jobStore: MemoryJobStore,
  creditLedger: CreditLedgerLike,
  overrides: Pick<
    JobManagerOpts,
    "orphanDrawSweepIntervalMs" | "terminalDrawReconcileAgeMs" | "onJobCompleted" | "onRevenueSkippedNoRail"
  > = {}
): JobManager<unknown, undefined> {
  const descriptor = configureDVM({
    name: "orphan-draw-test",
    capability: "test",
    tag: "test",
    idleTimeout: 120,
    onJob(ctx) {
      ctx.complete("ok");
    }
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    creditLedger,
    devMode: true,
    dvmId: "dvm-under-test",
    fxFetcher: createFxFetcher(),
    orphanDrawAgeMs: ORPHAN_AGE_MS,
    terminalDrawReconcileAgeMs: overrides.terminalDrawReconcileAgeMs ?? RECONCILE_AGE_MS,
    onJobCompleted: overrides.onJobCompleted,
    onRevenueSkippedNoRail: overrides.onRevenueSkippedNoRail,
    // Disable every timer; tests drive sweepOrphanDraws() directly.
    orphanDrawSweepIntervalMs: overrides.orphanDrawSweepIntervalMs ?? 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0
  });
}

async function seedDraw(
  ledger: CreditLedgerLike,
  opts: { drawId: string; jobId?: string; ageMs: number; amountMicro?: number }
): Promise<{ creditId: string; amountMicro: number }> {
  const amountMicro = opts.amountMicro ?? 30_000;
  const { creditId } = await fundCredit(ledger, {
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 100_000,
    expiryMs: FUTURE_MS
  });
  await ledger.draw({
    creditId,
    drawId: opts.drawId,
    amountMicro,
    jobId: opts.jobId,
    nowMs: Date.now() - opts.ageMs
  });
  return { creditId, amountMicro };
}

// Put live holds ahead of the orphan in cursor order; skipping them must still advance the scan.
async function seedUnsweepableWall(ledger: CreditLedgerLike, store: MemoryJobStore, count: number): Promise<string> {
  const { creditId } = await fundCredit(ledger, {
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 10_000_000,
    expiryMs: FUTURE_MS
  });
  // One credit, one instant: `ledger_seq` orders them, so the wall sits ahead
  // of any later-aged orphan under `(createdAt, creditId, ledgerSeq)`.
  const createdAt = Date.now() - (ORPHAN_AGE_MS + 600_000);
  for (let i = 0; i < count; i++) {
    await ledger.draw({
      creditId,
      drawId: `wall-${i}`,
      amountMicro: 1,
      jobId: `wall-job-${i}`,
      nowMs: createdAt
    });
    await store.save(jobRecord(`wall-job-${i}`, "awaiting-input"));
  }
  return creditId;
}

// Persist payment linkage and cost so a new manager can report without the crashed handler’s memory.
function jobRecord(
  id: string,
  status: JobStatus,
  paid?: {
    creditId?: string;
    drawId?: string;
    unknownRail?: true;

    cost?: { amountMicro: number; currency: string };
  }
): JobRecord {
  return {
    id,
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status,
    messages: [],
    seq: 0,
    paidMsats: paid ? 21_000 : 0,
    ...(paid && {
      // The credit has a rail; only the job row omits it, distinguishing this diagnostic from legacy credits.
      ...(paid.unknownRail ? {} : { paymentRail: "cashu" as const }),
      paymentTxHash: `tx-${id}`,
      creditId: paid.creditId,
      drawId: paid.drawId,
      ...(paid.cost && {
        costAmountMicro: paid.cost.amountMicro,
        costCurrency: paid.cost.currency
      })
    }),
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: Date.now(),
    lastActivityAt: Date.now()
  };
}

describe("JobManager orphan-draw sweeper", () => {

  it.each<JobStatus>(NON_TERMINAL)(
    "never touches an aged hold whose job row is still running (%s) — the funnel owns it",
    async (status) => {
      const ledger = new MemoryCreditLedger();
      const store = new MemoryJobStore();
      const { creditId } = await seedDraw(ledger, {
        drawId: "d1",
        jobId: "job-1",

        ageMs: RECONCILE_AGE_MS + 60_000,
      });
      await store.save(jobRecord("job-1", status, { creditId, drawId: "d1" }));

      const jm = buildManager(store, ledger);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({ released: 0, reconciled: 0 });
        const summary = warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .find((entry) => entry.event === "orphan_draw_sweep_no_progress");
        expect(summary).toBeDefined();
        expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("pending");
        expect((await ledger.get(creditId))?.availableMicro).toBe(70_000);
      } finally {
        warn.mockRestore();
        jm.shutdown();
      }
    }
  );

  it("leaves a hold younger than the threshold alone", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-in-flight",
      ageMs: ORPHAN_AGE_MS - 60_000
    });

    const jm = buildManager(store, ledger);
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("pending");
    } finally {
      jm.shutdown();
    }
  });

  it("ages out a hold with no job linkage at all", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      ageMs: ORPHAN_AGE_MS + 60_000
    });

    const jm = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 1,
          reconciled: 0
        });
        const logged = warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .find((entry) => entry.event === "orphan_draw_released");
        expect(logged).toBeDefined();
      } finally {
        warn.mockRestore();
      }
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("released");
    } finally {
      jm.shutdown();
    }
  });

  it("two machines sweeping the same ledger release exactly once", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-never-persisted",
      ageMs: ORPHAN_AGE_MS + 60_000
    });

    expect((await ledger.get(creditId))?.availableMicro).toBe(70_000);

    const a = buildManager(store, ledger);
    const b = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let releases: { released: number }[];
      let logged: Record<string, unknown>[];
      try {
        releases = await Promise.all([a.sweepOrphanDraws(), b.sweepOrphanDraws()]);
        logged = warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .filter((entry) => entry.event === "orphan_draw_released");
      } finally {
        warn.mockRestore();
      }

      expect(releases.reduce((n, r) => n + r.released, 0)).toBe(1);
      expect(logged.length).toBeGreaterThanOrEqual(1);

      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("released");

      const snap = await ledger.get(creditId);
      expect(snap?.availableMicro).toBe(100_000);
      expect(snap?.balanceMicro).toBe(100_000);

      expect(await a.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
    } finally {
      a.shutdown();
      b.shutdown();
    }
  });

  it("keeps sweeping when one release loses the race to the terminal funnel", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    await seedDraw(ledger, {
      drawId: "contended",
      jobId: "job-a",
      ageMs: ORPHAN_AGE_MS + 120_000
    });
    const other = await seedDraw(ledger, {
      drawId: "sweepable",
      jobId: "job-b",
      ageMs: ORPHAN_AGE_MS + 60_000
    });

    // Stand in for a concurrent settle landing between the scan and the release.
    const release = vi.spyOn(ledger, "release").mockImplementationOnce(() =>
      Promise.reject(
        new CreditLedgerError("invalid_draw_state", "already settled", {
          currentStatus: "settled"
        })
      )
    );

    const jm = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 1,
          reconciled: 0
        });
        logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
      } finally {
        warn.mockRestore();
      }

      expect(logged.some((entry) => entry.event === "orphan_draw_release_failed")).toBe(true);
      expect(logged.some((entry) => entry.event === "orphan_draw_released")).toBe(true);
      expect(
        (
          await ledger.getDraw({
            creditId: other.creditId,
            drawId: "sweepable"
          })
        )?.status
      ).toBe("released");
    } finally {
      release.mockRestore();
      jm.shutdown();
    }
  });

  it("is a no-op without a credit ledger", async () => {
    const store = new MemoryJobStore();
    const descriptor = configureDVM({
      name: "orphan-draw-test",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      devMode: true,
      fxFetcher: createFxFetcher(),
      staleJobTimeoutMs: 0,
      processingWatchdogMs: 0,
      heartbeatIntervalMs: 0
    });
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
    } finally {
      jm.shutdown();
    }
  });

  it("reads one page and stops when the scan comes back short", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const seen: number[] = [];
    const list = vi
      .spyOn(ledger, "listStalePendingDraws")
      .mockImplementation(async (args): Promise<DrawRecord[]> => {
        seen.push(args.limit);
        return [];
      });

    const jm = buildManager(store, ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await jm.sweepOrphanDraws();

      expect(seen).toEqual([SCAN_PAGE_LIMIT, BLIND_SPOT_PROBE_LIMIT]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      list.mockRestore();
      jm.shutdown();
    }
  });

  it("pages past a wall of aged holds it may not release, and still frees the orphan", async () => {
    // A 51-hold wall crosses the 50-row page boundary before the orphan.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    await seedUnsweepableWall(ledger, store, 51);
    const orphan = await seedDraw(ledger, {
      drawId: "orphan",
      jobId: "job-never-persisted",
      ageMs: ORPHAN_AGE_MS + 60_000
    });

    const jm = buildManager(store, ledger);
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 1,
        reconciled: 0
      });
      expect((await ledger.getDraw({ creditId: orphan.creditId, drawId: "orphan" }))?.status).toBe("released");

      expect(
        (
          await ledger.listStalePendingDraws({
            createdBeforeMs: Date.now(),
            limit: 200
          })
        ).length
      ).toBe(51);
    } finally {
      jm.shutdown();
    }
  });

  it("logs a truncated tick and resumes it on the next sweep", async () => {
    // 50-row pages × a 20-page cap = 1000 candidates per tick. A wall exactly
    // that long consumes a whole tick; the orphan behind it is only reached
    // because the next tick resumes from the cursor instead of the top.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    await seedUnsweepableWall(ledger, store, 1000);
    const orphan = await seedDraw(ledger, {
      drawId: "orphan",
      jobId: "job-never-persisted",
      ageMs: ORPHAN_AGE_MS + 60_000
    });

    const jm = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let truncated: Record<string, unknown> | undefined;
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 0
        });
        truncated = warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .find((entry) => entry.event === "orphan_draw_sweep_truncated");
      } finally {
        warn.mockRestore();
      }

      expect(truncated).toBeDefined();

      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 1,
        reconciled: 0
      });
      expect((await ledger.getDraw({ creditId: orphan.creditId, drawId: "orphan" }))?.status).toBe("released");
    } finally {
      jm.shutdown();
    }
  });

  it("runs one sweep timer per ledger, not one per mount", async () => {
    // Mounts share a ledger: timer ownership must be released on shutdown so the next boot can sweep.
    vi.useFakeTimers();
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const list = vi.spyOn(ledger, "listStalePendingDraws").mockResolvedValue([]);
    const mountA = buildManager(store, ledger, { orphanDrawSweepIntervalMs: 1_000 });
    const mountB = buildManager(store, ledger, { orphanDrawSweepIntervalMs: 1_000 });
    try {
      await vi.advanceTimersByTimeAsync(3_500);

      const ticks = (): number =>
        list.mock.calls.filter(([args]) => args.limit === SCAN_PAGE_LIMIT).length;
      expect(ticks()).toBe(3);

      mountA.shutdown();
      mountB.shutdown();
      list.mockClear();
      const rebooted = buildManager(store, ledger, { orphanDrawSweepIntervalMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(ticks()).toBe(1);
      rebooted.shutdown();
    } finally {
      list.mockRestore();
      mountA.shutdown();
      mountB.shutdown();
      vi.useRealTimers();
    }
  });
});

describe("JobManager terminal-draw reconciler", () => {

  function reconcileLines(calls: unknown[][]): Record<string, unknown>[] {
    return calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter(
        (entry) =>
          entry.event === "credit_draw_reconciled" ||
          entry.event === "credit_draw_reconcile_failed"
      );
  }

  function warnLines(calls: unknown[][], event: string): Record<string, unknown>[] {
    return calls
      .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
      .filter((entry) => entry.event === event);
  }

  it("settles an aged hold whose job completed, debits once, and books the revenue", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const booked: {
      creditId?: string;
      drawId?: string;
      drawAmountMicro?: number;
    }[] = [];
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(jobRecord("job-1", "completed", { creditId, drawId: "d1" }));

    const jm = buildManager(store, ledger, {
      onJobCompleted: (info) => {
        booked.push(info);
      }
    });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
        logged = reconcileLines(warn.mock.calls);
      } finally {
        warn.mockRestore();
      }

      expect(logged).toHaveLength(1);
      expect(logged[0]).toEqual(expect.objectContaining({ event: "credit_draw_reconciled", level: "warn" }));

      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("settled");

      const snap = await ledger.get(creditId);
      expect(snap?.balanceMicro).toBe(70_000);
      expect(snap?.availableMicro).toBe(70_000);

      expect(booked).toHaveLength(1);
      expect(booked[0]).not.toHaveProperty("cost");
      expect(booked[0]).toMatchObject({
        dvmId: "dvm-under-test",
        jobId: "job-1",
        creditId,
        drawId: "d1",
        drawAmountMicro: 30_000,
        rail: "cashu",
        paymentTxHash: "tx-job-1"
      });
    } finally {
      jm.shutdown();
    }
  });

  it("books the cost the crashed handler declared, off the row rather than memory", async () => {
    // Cost must survive a crash between persisted terminal state and the report; this manager never ran the handler.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const booked: { cost?: { amountMicro: number; currency: string } }[] = [];
    const { creditId } = await seedDraw(ledger, {
      drawId: "d-cost",
      jobId: "job-cost",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(
      jobRecord("job-cost", "completed", {
        creditId,
        drawId: "d-cost",
        cost: { amountMicro: 21_500, currency: "usd" }
      })
    );

    const jm = buildManager(store, ledger, {
      onJobCompleted: (info) => {
        booked.push(info);
      }
    });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
      } finally {
        warn.mockRestore();
      }
      expect(booked).toHaveLength(1);
      expect(booked[0].cost).toEqual({ amountMicro: 21_500, currency: "usd" });
    } finally {
      jm.shutdown();
    }
  });

  it("settles but logs booked: false when the job has no rail to report under", async () => {
    // A settled legacy draw can still lack a revenue rail; booked:false must expose the missing event.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const booked: unknown[] = [];
    const alerts: unknown[] = [];
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(
      jobRecord("job-1", "completed", {
        creditId,
        drawId: "d1",
        unknownRail: true
      })
    );

    const jm = buildManager(store, ledger, {
      onJobCompleted: (info) => {
        booked.push(info);
      },
      onRevenueSkippedNoRail: (info) => {
        alerts.push(info);
      }
    });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      let skipped: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
        logged = reconcileLines(warn.mock.calls);
        skipped = warnLines(warn.mock.calls, "revenue_skipped_no_rail");
      } finally {
        warn.mockRestore();
      }

      expect(logged).toHaveLength(1);
      expect(logged[0]).toEqual(expect.objectContaining({ event: "credit_draw_reconciled", level: "warn" }));

      // The diagnostic identifies the missing job-row rail and the actual draw amount.
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toEqual({
        level: "warn",
        event: "revenue_skipped_no_rail"
      });

      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("settled");
      expect((await ledger.get(creditId))?.balanceMicro).toBe(70_000);
      expect(booked).toEqual([]);
      expect(alerts).toEqual([
        expect.objectContaining({
          dvmId: "dvm-under-test",
          jobId: "job-1",
          creditId,
          drawId: "d1",
          drawAmountMicro: 30_000,
          creditRail: "cashu",
          reason: "job_rail_missing"
        })
      ]);
    } finally {
      jm.shutdown();
    }
  });

  it.each<JobStatus>(["failed", "cancelled"])(
    "releases an aged hold whose job %s, restores the balance, and books nothing",
    async (status) => {
      const ledger = new MemoryCreditLedger();
      const store = new MemoryJobStore();
      const booked: unknown[] = [];
      const { creditId } = await seedDraw(ledger, {
        drawId: "d1",
        jobId: "job-1",
        ageMs: RECONCILE_AGE_MS + 60_000,
      });
      await store.save(jobRecord("job-1", status, { creditId, drawId: "d1" }));

      const jm = buildManager(store, ledger, {
        onJobCompleted: (info) => {
          booked.push(info);
        }
      });
      try {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        let logged: Record<string, unknown>[];
        try {
          expect(await jm.sweepOrphanDraws()).toEqual({ released: 0, reconciled: 1 });
          logged = reconcileLines(warn.mock.calls);
        } finally {
          warn.mockRestore();
        }

        expect(logged[0]).toEqual(
          expect.objectContaining({ event: "credit_draw_reconciled", level: "warn" })
        );

        expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("released");
        const snap = await ledger.get(creditId);
        expect(snap?.availableMicro).toBe(100_000);
        expect(snap?.balanceMicro).toBe(100_000);

        expect(booked).toEqual([]);
      } finally {
        jm.shutdown();
      }
    }
  );

  it.each<JobStatus>(TERMINAL)(
    "leaves a terminal job's hold (%s) alone until the reconcile gate, not the orphan one",
    async (status) => {
      // Terminal reconciliation has a wider grace period than the missing-job orphan arm.
      const ledger = new MemoryCreditLedger();
      const store = new MemoryJobStore();
      const { creditId } = await seedDraw(ledger, {
        drawId: "d1",
        jobId: "job-1",
        ageMs: ORPHAN_AGE_MS + 60_000,
      });
      await store.save(jobRecord("job-1", status, { creditId, drawId: "d1" }));

      const jm = buildManager(store, ledger);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({ released: 0, reconciled: 0 });
        const summary = warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .find((entry) => entry.event === "orphan_draw_sweep_no_progress");
        expect(summary).toBeDefined();
        expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("pending");
      } finally {
        warn.mockRestore();
        jm.shutdown();
      }
    }
  );

  it("releases rather than settles a completed job's hold the row isn't bound to", async () => {
    // Funding commits before set-if-null binding; a loser’s unbound hold must release, not settle as a second job payment.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const booked: unknown[] = [];
    const { creditId } = await seedDraw(ledger, {
      drawId: "unbound",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(jobRecord("job-1", "completed", { creditId, drawId: "the-real-one" }));

    const jm = buildManager(store, ledger, {
      onJobCompleted: (info) => {
        booked.push(info);
      }
    });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
        logged = reconcileLines(warn.mock.calls);
      } finally {
        warn.mockRestore();
      }

      expect(logged[0]).toEqual(
        expect.objectContaining({ event: "credit_draw_reconciled", level: "warn" })
      );
      expect((await ledger.getDraw({ creditId, drawId: "unbound" }))?.status).toBe("released");
      expect((await ledger.get(creditId))?.balanceMicro).toBe(100_000);
      expect(booked).toEqual([]);
    } finally {
      jm.shutdown();
    }
  });

  it("releases a completed job's hold when the row carries no credit linkage at all", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });

    await store.save(jobRecord("job-1", "completed"));

    const jm = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
        logged = reconcileLines(warn.mock.calls);
      } finally {
        warn.mockRestore();
      }

      expect(logged[0]).toEqual(
        expect.objectContaining({ event: "credit_draw_reconciled", level: "warn" })
      );
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("released");
      expect((await ledger.get(creditId))?.balanceMicro).toBe(100_000);
    } finally {
      jm.shutdown();
    }
  });

  it("two machines reconciling the same completed job settle and book exactly once", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const booked: unknown[] = [];
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(jobRecord("job-1", "completed", { creditId, drawId: "d1" }));

    const onJobCompleted = (info: unknown): void => {
      booked.push(info);
    };
    const a = buildManager(store, ledger, { onJobCompleted });
    const b = buildManager(store, ledger, { onJobCompleted });
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let counts: { released: number; reconciled: number }[];
      let logged: Record<string, unknown>[];
      try {
        counts = await Promise.all([a.sweepOrphanDraws(), b.sweepOrphanDraws()]);
        logged = reconcileLines(warn.mock.calls);
      } finally {
        warn.mockRestore();
      }

      expect(counts.reduce((n, r) => n + r.reconciled, 0)).toBe(1);
      expect(logged.length).toBeGreaterThanOrEqual(1);
      expect(booked).toHaveLength(1);

      expect((await ledger.get(creditId))?.balanceMicro).toBe(70_000);
    } finally {
      a.shutdown();
      b.shutdown();
    }
  });

  it("keeps sweeping when one reconcile loses the race to the in-line funnel", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const contended = await seedDraw(ledger, {
      drawId: "contended",
      jobId: "job-a",
      ageMs: RECONCILE_AGE_MS + 120_000
    });
    await store.save(
      jobRecord("job-a", "completed", {
        creditId: contended.creditId,
        drawId: "contended"
      })
    );
    const other = await seedDraw(ledger, {
      drawId: "reconcilable",
      jobId: "job-b",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(
      jobRecord("job-b", "completed", {
        creditId: other.creditId,
        drawId: "reconcilable"
      })
    );

    // Stand in for the funnel releasing the draw between the scan and the settle.
    const settle = vi.spyOn(ledger, "settle").mockImplementationOnce(() =>
      Promise.reject(
        new CreditLedgerError("invalid_draw_state", "already released", {
          currentStatus: "released"
        })
      )
    );

    const jm = buildManager(store, ledger);
    try {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let logged: Record<string, unknown>[];
      try {
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 0,
          reconciled: 1
        });
        logged = reconcileLines(warn.mock.calls);
      } finally {
        warn.mockRestore();
      }

      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(
        (
          await ledger.getDraw({
            creditId: other.creditId,
            drawId: "reconcilable"
          })
        )?.status
      ).toBe("settled");
    } finally {
      settle.mockRestore();
      jm.shutdown();
    }
  });

  it("clamps a reconcile gate set below orphanDrawAgeMs up to the scan's own cutoff", async () => {
    // Both arms share the orphan scan cutoff, so terminal grace cannot be narrower than it.
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const young = await seedDraw(ledger, {
      drawId: "inside-scan-cutoff",
      jobId: "job-young",
      ageMs: ORPHAN_AGE_MS - 5 * 60_000
    });
    await store.save(
      jobRecord("job-young", "completed", {
        creditId: young.creditId,
        drawId: "inside-scan-cutoff"
      })
    );
    const old = await seedDraw(ledger, {
      drawId: "past-scan-cutoff",
      jobId: "job-old",
      ageMs: ORPHAN_AGE_MS + 5 * 60_000
    });
    await store.save(
      jobRecord("job-old", "completed", {
        creditId: old.creditId,
        drawId: "past-scan-cutoff"
      })
    );

    const jm = buildManager(store, ledger, {
      terminalDrawReconcileAgeMs: 60_000
    });
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 1
      });
      expect(
        (
          await ledger.getDraw({
            creditId: young.creditId,
            drawId: "inside-scan-cutoff"
          })
        )?.status
      ).toBe("pending");
      expect(
        (
          await ledger.getDraw({
            creditId: old.creditId,
            drawId: "past-scan-cutoff"
          })
        )?.status
      ).toBe("settled");
    } finally {
      jm.shutdown();
    }
  });

  it("disables the arm at terminalDrawReconcileAgeMs: 0, leaving the orphan arm intact", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const terminal = await seedDraw(ledger, {
      drawId: "terminal",
      jobId: "job-1",
      ageMs: RECONCILE_AGE_MS + 60_000
    });
    await store.save(
      jobRecord("job-1", "completed", {
        creditId: terminal.creditId,
        drawId: "terminal"
      })
    );
    const orphan = await seedDraw(ledger, {
      drawId: "orphan",
      jobId: "job-never-persisted",
      ageMs: RECONCILE_AGE_MS + 60_000
    });

    const jm = buildManager(store, ledger, { terminalDrawReconcileAgeMs: 0 });
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 1,
        reconciled: 0
      });
      expect(
        (
          await ledger.getDraw({
            creditId: terminal.creditId,
            drawId: "terminal"
          })
        )?.status
      ).toBe("pending");
      expect((await ledger.getDraw({ creditId: orphan.creditId, drawId: "orphan" }))?.status).toBe("released");
    } finally {
      jm.shutdown();
    }
  });
});

// A backward wall-clock step can hide aged holds; the manager’s monotonic projection must keep them visible.
describe("JobManager orphan-draw sweeper clock guard", () => {
  it("resolves an eligible hold after the process clock steps backwards past the draw age", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const ledger = new MemoryCreditLedger();
      const store = new MemoryJobStore();
      const { creditId } = await seedDraw(ledger, {
        drawId: "d1",
        jobId: "job-never-persisted",
        ageMs: ORPHAN_AGE_MS + 5 * 60_000
      });

      // The manager must exist before the step — its clock anchor is what the
      // guard projects forward from. A process born after the step has no way
      // to know one happened.
      const jm = buildManager(store, ledger);
      try {
        vi.setSystemTime(t0 - 2 * ORPHAN_AGE_MS);
        expect(await jm.sweepOrphanDraws()).toEqual({
          released: 1,
          reconciled: 0
        });
        expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("released");
        expect((await ledger.get(creditId))?.availableMicro).toBe(100_000);
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports an empty scan that a hold stamped in the future hid from it", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    // A hold created ahead of this manager’s clock requires the blind-spot probe, not its local clock-step guard.
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-never-persisted",
      ageMs: -(60 * 60_000)
    });

    const jm = buildManager(store, ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
      const summary = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "orphan_draw_sweep_no_progress");
      expect(summary).toBeDefined();
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("pending");
    } finally {
      warn.mockRestore();
      jm.shutdown();
    }
  });

  it("reports an empty scan while a hold past the age gate exists", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const { creditId } = await seedDraw(ledger, {
      drawId: "d1",
      jobId: "job-never-persisted",
      ageMs: ORPHAN_AGE_MS + 10 * 60_000
    });
    // An empty scan with an aged hold must report a blind spot rather than appear clean.
    const listPage = ledger.listStalePendingDraws.bind(ledger);
    const list = vi
      .spyOn(ledger, "listStalePendingDraws")
      .mockImplementation(async (args): Promise<DrawRecord[]> =>
        args.limit === SCAN_PAGE_LIMIT ? [] : listPage(args)
      );

    const jm = buildManager(store, ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
      const summary = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "orphan_draw_sweep_no_progress");
      expect(summary).toBeDefined();
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("pending");
    } finally {
      warn.mockRestore();
      list.mockRestore();
      jm.shutdown();
    }
  });

  it("reports, rather than fails, a tick whose blind-spot probe throws", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    // Probe failure is diagnostic; it must not reject a sweep that already completed.
    const list = vi.spyOn(ledger, "listStalePendingDraws").mockImplementation(async (args): Promise<DrawRecord[]> => {
      if (args.limit === SCAN_PAGE_LIMIT) return [];
      throw new Error("ledger unreachable");
    });

    const jm = buildManager(store, ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });
      const summary = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .find((entry) => entry.event === "orphan_draw_sweep_no_progress");
      expect(summary).toBeDefined();
      expect(JSON.stringify(summary)).not.toContain("ledger unreachable");
    } finally {
      warn.mockRestore();
      list.mockRestore();
      jm.shutdown();
    }
  });

  it("stays quiet when the scan is empty only because every hold is young", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    await seedDraw(ledger, { drawId: "d1", jobId: "job-1", ageMs: 1_000 });

    const jm = buildManager(store, ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await jm.sweepOrphanDraws()).toEqual({
        released: 0,
        reconciled: 0
      });

      expect(
        warn.mock.calls
          .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
          .find((entry) => entry.event === "orphan_draw_sweep_no_progress")
      ).toBeUndefined();
    } finally {
      warn.mockRestore();
      jm.shutdown();
    }
  });
});
