import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager, type JobManagerOpts } from "../job-manager";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";

const STALE_AGE_MS = 10 * 60_000;

function seedRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "stuck-job-1",
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 19_000,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: Date.now() - STALE_AGE_MS,
    lastActivityAt: Date.now() - STALE_AGE_MS,
    ...overrides
  };
}

function buildManager(
  jobStore: MemoryJobStore,
  staleJobTimeoutMs: number,
  processingWatchdogMs: number = staleJobTimeoutMs,
  onPaidJobDeath?: JobManagerOpts["onPaidJobDeath"],
  extra: Partial<JobManagerOpts> = {}
) {
  const descriptor = configureDVM({
    name: "stale-test",
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
    devMode: true,
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs,
    processingWatchdogMs,
    onPaidJobDeath,
    // Disable the timers; tests drive sweepStaleJobs() / heartbeatActiveJobs() directly.
    staleJobSweepIntervalMs: 24 * 60 * 60_000,
    heartbeatIntervalMs: 0,
    ...extra
  });
}

describe("JobManager stale-job sweeper", () => {

  it("fails a stuck `processing` job (dead worker) and appends a cancel message", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord());
    const jm = buildManager(store, 1_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);

      const record = await store.get("stuck-job-1");
      expect(record).toBeDefined();
      // a stranded *processing* job is a dead worker → `failed`.
      expect(record?.status).toBe("failed");
      expect(record?.messages).toHaveLength(1);
      const cancel = record?.messages[0];
      expect(cancel?.type).toBe("cancel");
      expect((cancel?.content as { reason?: string }).reason).toBe("worker_died_mid_job");
      expect(cancel?.from).toBe("provider");
      expect((await jm.sweepStaleJobs()).swept).toBe(0);
      expect((await store.get("stuck-job-1"))?.messages).toHaveLength(1);
    } finally {
      jm.shutdown();
    }
  });

  it("ignores fresh jobs whose lastActivityAt is within the threshold", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord({ id: "fresh-job-1", lastActivityAt: Date.now() }));
    const jm = buildManager(store, 60_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(0);

      const record = await store.get("fresh-job-1");
      expect(record?.status).toBe("processing");
      expect(record?.messages).toHaveLength(0);
    } finally {
      jm.shutdown();
    }
  });

  it("sweeps `working` (→ failed) and `awaiting-input` (→ cancelled), skips terminal", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord({ id: "working-job", status: "working" }));
    await store.save(seedRecord({ id: "awaiting-job", status: "awaiting-input" }));
    await store.save(
      seedRecord({
        id: "completed-job",
        status: "completed",
        lastActivityAt: Date.now() - STALE_AGE_MS
      })
    );
    const jm = buildManager(store, 1_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(2);

      // actively-processing → failed (dead worker); awaiting-input →
      // cancelled (caller never paid/responded).
      expect((await store.get("working-job"))?.status).toBe("failed");
      expect((await store.get("awaiting-job"))?.status).toBe("cancelled");
      // Already-terminal rows are untouched.
      expect((await store.get("completed-job"))?.status).toBe("completed");
    } finally {
      jm.shutdown();
    }
  });

  it("durably reports a reaped job's declared cost without treating it as revenue", async () => {
    const store = new MemoryJobStore();
    await store.save(
      seedRecord({
        costAmountMicro: 3_200,
        costCurrency: "usd",
        costRevision: 1
      })
    );
    const costs: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0][] = [];
    const revenue = vi.fn();
    const jm = buildManager(store, 1_000, 1_000, undefined, {
      dvmId: "dvm-cost-reaper",
      onJobCompleted: revenue,
      onJobCost: (info) => {
        costs.push(info);
      }
    });

    try {
      expect(await jm.sweepStaleJobs()).toEqual({ swept: 1 });
      expect(revenue).not.toHaveBeenCalled();
      expect(costs).toEqual([
        {
          dvmId: "dvm-cost-reaper",
          jobId: "stuck-job-1",
          capability: "test",
          outcome: "failed",
          costRevision: 1,
          cost: { amountMicro: 3_200, currency: "usd" }
        }
      ]);
    } finally {
      jm.shutdown();
    }
  });

  it("versions a persisted prefix below the owner total when another machine reaps", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let declareRemainder!: () => void;
    const prefixHeld = new Promise<void>((resolve) => (declareRemainder = resolve));
    let remainderDeclared!: () => void;
    const latestReady = new Promise<void>((resolve) => (remainderDeclared = resolve));
    const ownerCosts: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0][] = [];
    const reaperCosts: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0][] = [];
    const descriptor = configureDVM({
      name: "cross-machine-reap-cost",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      async onJob(ctx) {
        ctx.cost({ amount: 0.001, currency: "usd" });
        await prefixHeld;
        // This second declaration remains only in the handler owner's memory
        // while the remote reaper reads and reports the persisted prefix.
        ctx.cost({ amount: 0.0022, currency: "usd" });
        remainderDeclared();
        await blocked;
      }
    });
    const managerOpts = {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      devMode: true,
      fxFetcher: createFxFetcher(),
      dvmId: "dvm-cross-machine-reap",
      staleJobTimeoutMs: 1_000,
      processingWatchdogMs: 1_000,
      staleJobSweepIntervalMs: 24 * 60 * 60_000,
      heartbeatIntervalMs: 0
    } satisfies JobManagerOpts;
    const owner = new JobManager(descriptor, {
      ...managerOpts,
      onJobCost: (info) => {
        ownerCosts.push(info);
      }
    });
    const reaper = new JobManager(descriptor, {
      ...managerOpts,
      store: new MemoryKVStore(),
      onJobCost: (info) => {
        reaperCosts.push(info);
      }
    });

    try {
      const job = owner.createJob(
        { input: "hello" },
        "requester-1",
        { paidMsats: 0, receivedProofs: [] },
        undefined,
        "test"
      );
      const ctx = owner.buildAndAttachContext(job, "hello");
      await owner.persistJob(job);
      owner.runHandler(job, ctx);
      expect(job.costAmountMicro).toBe(1_000);
      expect(job.costRevision).toBe(1);
      await owner.persistJob(job);

      const stale = await store.get(job.id);
      if (!stale) throw new Error("expected persisted job");
      expect(stale.costAmountMicro).toBe(1_000);
      expect(stale.costRevision).toBe(1);
      stale.lastActivityAt = Date.now() - STALE_AGE_MS;
      await store.save(stale);
      declareRemainder();
      await latestReady;
      expect(job.costAmountMicro).toBe(3_200);
      expect(job.costRevision).toBe(2);

      expect(await reaper.sweepStaleJobs()).toEqual({ swept: 1 });
      await new Promise((resolve) => setImmediate(resolve));

      expect(reaperCosts).toEqual([
        {
          dvmId: "dvm-cross-machine-reap",
          jobId: job.id,
          capability: "test",
          outcome: "failed",
          costRevision: 1,
          cost: { amountMicro: 1_000, currency: "usd" }
        }
      ]);
      expect(ownerCosts).toEqual([
        {
          dvmId: "dvm-cross-machine-reap",
          jobId: job.id,
          capability: "test",
          outcome: "failed",
          costRevision: 2,
          cost: { amountMicro: 3_200, currency: "usd" }
        }
      ]);
    } finally {
      release();
      owner.shutdown();
      reaper.shutdown();
    }
  });

  it("ignores stuck jobs owned by a sibling capability (multi-mount safety)", async () => {
    // A second DVM mounted on the same DB has its own JobManager; it must not
    // steal stuck rows that belong to this descriptor's capability set,
    // because the local activeJobs teardown only makes sense on the owning
    // JobManager. The CAS keeps it correct cross-process, but unscoped
    // findStaleJobs would still cancel rows the local instance doesn't host.
    const store = new MemoryJobStore();
    await store.save(seedRecord({ id: "ours", capability: "test" }));
    await store.save(seedRecord({ id: "theirs", capability: "other-cap" }));
    const jm = buildManager(store, 1_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect((await store.get("ours"))?.status).toBe("failed");
      // Sibling-capability row is untouched — its owning JobManager will
      // sweep it on its own tick.
      expect((await store.get("theirs"))?.status).toBe("processing");
    } finally {
      jm.shutdown();
    }
  });
});

describe("status-aware watchdog + worker heartbeat", () => {
  it("applies a tight processing watchdog but the long idle timeout to awaiting-input", async () => {
    const now = Date.now();
    const store = new MemoryJobStore();
    // Both ~4 min idle. With a 5-min processing watchdog and a 3-min idle
    // timeout: the processing job is still live (4 < 5), the awaiting-input job
    // is stale (4 > 3).
    await store.save(
      seedRecord({ id: "proc", status: "processing", lastActivityAt: now - 4 * 60_000 })
    );
    await store.save(
      seedRecord({ id: "await", status: "awaiting-input", lastActivityAt: now - 4 * 60_000 })
    );
    const jm = buildManager(store, 3 * 60_000, 5 * 60_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect((await store.get("proc"))?.status).toBe("processing");
      expect((await store.get("await"))?.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });

  it("a disabled arm (timeout 0) never sweeps that status", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord({ id: "proc", status: "processing" }));
    await store.save(seedRecord({ id: "await", status: "awaiting-input" }));
    // Disable the awaiting-input arm; only the processing watchdog runs.
    const jm = buildManager(store, 0, 1_000);

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect((await store.get("proc"))?.status).toBe("failed");
      expect((await store.get("await"))?.status).toBe("awaiting-input");
    } finally {
      jm.shutdown();
    }
  });

  it("store.heartbeatActiveJobs bumps processing/working rows but not awaiting/terminal", async () => {
    const store = new MemoryJobStore();
    const stale = Date.now() - STALE_AGE_MS;
    await store.save(seedRecord({ id: "proc", status: "processing", lastActivityAt: stale }));
    await store.save(seedRecord({ id: "work", status: "working", lastActivityAt: stale }));
    await store.save(seedRecord({ id: "await", status: "awaiting-input", lastActivityAt: stale }));
    await store.save(seedRecord({ id: "done", status: "completed", lastActivityAt: stale }));

    const now = Date.now();
    await store.heartbeatActiveJobs(["proc", "work", "await", "done"], now);

    expect((await store.get("proc"))?.lastActivityAt).toBe(now);
    expect((await store.get("work"))?.lastActivityAt).toBe(now);
    // awaiting-input must keep aging so its idle timeout still fires.
    expect((await store.get("await"))?.lastActivityAt).toBe(stale);
    expect((await store.get("done"))?.lastActivityAt).toBe(stale);
  });

  it("heartbeat keeps a live processing job out of the sweep", async () => {
    const store = new MemoryJobStore();
    await store.save(
      seedRecord({ id: "proc", status: "processing", lastActivityAt: Date.now() - STALE_AGE_MS })
    );
    const jm = buildManager(store, 1_000, 1_000);

    try {
      // Simulate the heartbeat firing for the live worker right before a sweep.
      await store.heartbeatActiveJobs(["proc"], Date.now());
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(0);
      expect((await store.get("proc"))?.status).toBe("processing");
    } finally {
      jm.shutdown();
    }
  });
});

describe("JobManager paid-job-death alert on reaper force-fail", () => {
  type DeathInfo = Parameters<NonNullable<JobManagerOpts["onPaidJobDeath"]>>[0];

  it("fires onPaidJobDeath once for a paid `processing` job reaped as a dead worker", async () => {
    const store = new MemoryJobStore();
    await store.save(
      seedRecord({
        paidMsats: 67_000,
        paymentRail: "cashu",
        paymentMint: "https://mint.example"
      })
    );
    const deaths: DeathInfo[] = [];
    const jm = buildManager(store, 1_000, 1_000, (info) => {
      deaths.push(info);
    });

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect(deaths).toHaveLength(1);
      expect(deaths[0]).toMatchObject({
        jobId: "stuck-job-1",
        capability: "test",
        paidMsats: 67_000,
        rail: "cashu",
        reason: "worker_died_mid_job",
        paymentMint: "https://mint.example"
      });
    } finally {
      jm.shutdown();
    }
  });

  it("does NOT fire for a free job reaped the same way", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord({ paidMsats: 0, paymentRail: undefined }));
    const deaths: DeathInfo[] = [];
    const jm = buildManager(store, 1_000, 1_000, (info) => {
      deaths.push(info);
    });

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect(deaths).toHaveLength(0);
    } finally {
      jm.shutdown();
    }
  });

  it("fires with reason `stale_no_terminal_status` when a paid `awaiting-input` job is reaped", async () => {
    const store = new MemoryJobStore();
    await store.save(
      seedRecord({
        id: "awaiting-paid",
        status: "awaiting-input",
        paidMsats: 42_000,
        paymentRail: "tempo"
      })
    );
    const deaths: DeathInfo[] = [];
    const jm = buildManager(store, 1_000, 1_000, (info) => {
      deaths.push(info);
    });

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect((await store.get("awaiting-paid"))?.status).toBe("cancelled");
      expect(deaths).toHaveLength(1);
      expect(deaths[0]).toMatchObject({
        reason: "stale_no_terminal_status",
        rail: "tempo"
      });
    } finally {
      jm.shutdown();
    }
  });

  it("a throwing onPaidJobDeath does not wedge the sweep", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord({ paidMsats: 67_000, paymentRail: "cashu" }));
    const jm = buildManager(store, 1_000, 1_000, () => {
      throw new Error("report endpoint down");
    });

    try {
      const { swept } = await jm.sweepStaleJobs();
      expect(swept).toBe(1);
      expect((await store.get("stuck-job-1"))?.status).toBe("failed");
    } finally {
      jm.shutdown();
    }
  });
});

/**
 * the sweep's two cutoffs are `Date.now()` samples compared against
 * `lastActivityAt`, stamped from a different sample at a different moment. A
 * backwards step of the host clock between them makes every row look more
 * recently active than it is, the query matches nothing, and both watchdogs go
 * quiet for the length of the skew — taking the paid-job-death alert
 * with them. The same defect fixed on the orphan-draw sweep, on the
 * same host class.
 *
 * The guard is bounded here, because eager means force-failing a live job
 * rather than releasing an unclaimed hold: compensation stops at half each
 * arm's own window. So a row must be stale by `step + window / 2` to survive
 * the step — the tests below step back by twice the window and age their rows
 * well past that.
 */
describe("JobManager stale-job sweeper clock guard", () => {
  const WATCHDOG_MS = 5 * 60_000;
  /** Twice the watchdog — under a bare `Date.now()` cutoff the sweep is blind. */
  const BACK_STEP_MS = 2 * WATCHDOG_MS;
  /**
   * Stale by more than `BACK_STEP_MS + WATCHDOG_MS / 2` (the bounded guard's
   * reach) but less than `BACK_STEP_MS + WATCHDOG_MS` (what the unguarded
   * cutoff would need). Straddling the two is what makes these tests fail
   * against a bare `Date.now()` sweep rather than passing either way.
   */
  const DEEP_STALE_MS = BACK_STEP_MS + Math.floor(0.7 * WATCHDOG_MS);

  it("still fails a dead worker's job after the clock steps backwards past the watchdog", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "proc", lastActivityAt: t0 - DEEP_STALE_MS }));
      // The manager must exist before the step — its clock anchor is what the
      // guard projects forward from. A process born after has no way to know.
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS);

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        const { swept } = await jm.sweepStaleJobs();
        expect(swept).toBe(1);
        expect((await store.get("proc"))?.status).toBe("failed");
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the reaped job's real age, not the stepped wall's version of it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "proc", lastActivityAt: t0 - DEEP_STALE_MS }));
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS);

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        expect((await jm.sweepStaleJobs()).swept).toBe(1);
        // The wall would say `DEEP_STALE_MS - BACK_STEP_MS` — 3.5 min against a
        // 5 min watchdog, which reads as a false reap on an incident.
        expect(warn).toHaveBeenCalledWith(
          '{"event":"stale_job_failed","level":"warn","ageMs":810000,"skewMs":600000}'
        );
      } finally {
        jm.shutdown();
      }
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("still cancels a stranded `awaiting-input` job across the same step", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(
        seedRecord({ id: "await", status: "awaiting-input", lastActivityAt: t0 - DEEP_STALE_MS })
      );
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS);

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        const { swept } = await jm.sweepStaleJobs();
        expect(swept).toBe(1);
        expect((await store.get("await"))?.status).toBe("cancelled");
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("still pages the operator for a paid job reaped across the step", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(
        seedRecord({
          lastActivityAt: t0 - DEEP_STALE_MS,
          paidMsats: 67_000,
          paymentRail: "cashu"
        })
      );
      const deaths: unknown[] = [];
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS, (info) => {
        deaths.push(info);
      });

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        expect((await jm.sweepStaleJobs()).swept).toBe(1);
        expect(deaths).toHaveLength(1);
        expect(deaths[0]).toMatchObject({
          reason: "worker_died_mid_job",
          rail: "cashu"
        });
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the bound holds: a live heartbeated worker is not reaped under the step", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "live", lastActivityAt: t0 - DEEP_STALE_MS }));
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS);

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        // The live worker beats on the stepped clock, exactly as it would in
        // production — a low, post-step stamp. Full compensation would claim
        // it anyway; the half-window cap is what keeps it out of the sweep.
        await store.heartbeatActiveJobs(["live"], Date.now());
        const { swept } = await jm.sweepStaleJobs();
        expect(swept).toBe(0);
        expect((await store.get("live"))?.status).toBe("processing");
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a disabled arm stays disabled across the step", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "proc", lastActivityAt: t0 - DEEP_STALE_MS }));
      await store.save(
        seedRecord({ id: "await", status: "awaiting-input", lastActivityAt: t0 - DEEP_STALE_MS })
      );
      // Awaiting arm off; only the processing watchdog runs.
      const jm = buildManager(store, 0, WATCHDOG_MS);

      try {
        vi.setSystemTime(t0 - BACK_STEP_MS);
        const { swept } = await jm.sweepStaleJobs();
        expect(swept).toBe(1);
        expect((await store.get("proc"))?.status).toBe("failed");
        expect((await store.get("await"))?.status).toBe("awaiting-input");
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("a watchdog configured close to the beat cadence compensates nothing at all", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      // A 40 s watchdog against the 30 s default beat: half the window is less
      // than one heartbeat, so a half-window cap alone would force-fail a
      // worker beating exactly on schedule the moment the clock stepped. The
      // second cap term collapses the compensation to zero instead — late,
      // which is where this pair already was, rather than wrong.
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "live", lastActivityAt: t0 }));
      const jm = buildManager(store, 0, 40_000, undefined, { heartbeatIntervalMs: 30_000 });

      try {
        vi.setSystemTime(t0 - 50 * 60_000);
        // One beat ago on the stepped clock — a healthy worker.
        await store.heartbeatActiveJobs(["live"], Date.now() - 30_000);
        const { swept } = await jm.sweepStaleJobs();
        expect(swept).toBe(0);
        expect((await store.get("live"))?.status).toBe("processing");
      } finally {
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("the reactivation claim grace still expires after a backwards step", async () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "await", status: "awaiting-input", lastActivityAt: t0 }));
      const jm = buildManager(store, 0, 0, undefined, { reactivationClaimGraceMs: 50 });

      // The step has to land *after* the deadline is taken, which is the only
      // ordering that reproduces the bug: the clock jumps behind a deadline
      // already set. Do it from the loop's own first store read.
      const get = store.get.bind(store);
      let stepped = false;
      store.get = (id) => {
        if (!stepped) {
          stepped = true;
          vi.setSystemTime(t0 - 60_000);
        }
        return get(id);
      };

      try {
        // Off the wall clock the 50 ms window is now 60 s out of reach, and
        // the loop polls the store every 25 ms for the whole step with the
        // caller's reactivation hanging on it.
        const claim = jm.claimAwaitingInputForReactivation("await");
        let settled = false;
        void claim.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(300);
        expect(settled).toBe(true);
        expect(await claim).toBe(true);
        expect((await store.get("await"))?.status).toBe("processing");
      } finally {
        store.get = get;
        jm.shutdown();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the skew it is compensating, and stays quiet on an untroubled clock", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const t0 = Date.now();
      const store = new MemoryJobStore();
      await store.save(seedRecord({ id: "fresh", lastActivityAt: t0 }));
      const jm = buildManager(store, WATCHDOG_MS, WATCHDOG_MS);

      try {
        // No step yet: nothing to say.
        await jm.sweepStaleJobs();
        expect(warn).not.toHaveBeenCalled();

        vi.setSystemTime(t0 - BACK_STEP_MS);
        await jm.sweepStaleJobs();
        expect(warn).toHaveBeenCalledWith(
          '{"event":"stale_job_sweep_clock_skew","level":"warn","skewMs":600000}'
        );
      } finally {
        jm.shutdown();
      }
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

/** The first JSON warn line at `level`, if this sweep emitted one. */
function _warnLine(
  warn: { mock: { calls: unknown[][] } },
  level: string
): Record<string, unknown> | undefined {
  return warn.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .find((entry) => entry.level === level);
}
