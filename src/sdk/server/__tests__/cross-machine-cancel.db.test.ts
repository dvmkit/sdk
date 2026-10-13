/**
 * a handler runs on machine A; the caller's DELETE lands on machine
 * B, which cancels the job in the store only. B's `cancelJob` commits the
 * terminal status, the `cancel` message, and the `pg_notify` in one
 * transaction; A's per-job notification subscription wakes, re-reads the
 * durable status, adopts it, and aborts `ctx.signal` — so the in-flight
 * provider call stops instead of running to completion.
 *
 * The in-process twin of this (two JobManagers over one MemoryJobStore, via
 * two apps) is `cross-machine-cancel.test.ts`; this one proves the same thing
 * over real Postgres LISTEN/NOTIFY, on two separate pools.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { JobManager, type JobManagerOpts } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

type Handler = (ctx: SDKJobContext<unknown, unknown>) => Promise<void> | void;

/** Wait for `promise`, failing the test rather than hanging if it never settles. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => {
        reject(new Error(`${what} did not happen within ${String(ms)}ms`));
      }, ms)
    ),
  ]);
}

/** The store's per-job notify subscribers, so a leaked watcher is visible. */
function notifySubscriberCount(store: PostgresJobStore, jobId: string): number {
  const subs = (store as unknown as { notifySubscribers: Map<string, Set<unknown>> })
    .notifySubscribers;
  return subs.get(jobId)?.size ?? 0;
}

class FaultInjectingPostgresJobStore extends PostgresJobStore {
  private pendingSaveFailures = 0;

  failNextSave(): void {
    this.pendingSaveFailures++;
  }

  override save(record: JobRecord): Promise<void> {
    if (this.pendingSaveFailures > 0) {
      this.pendingSaveFailures--;
      return Promise.reject(new Error("simulated terminal cost merge failure"));
    }
    return super.save(record);
  }
}

describe.skipIf(!RUN)("cross-machine cancel aborts the handler", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: FaultInjectingPostgresJobStore;
  let storeB: PostgresJobStore;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new FaultInjectingPostgresJobStore(poolA);
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

  /** Machine A: a JobManager whose handler runs against the Postgres store. */
  function machineA(
    onJob: Handler,
    onJobCost?: JobManagerOpts["onJobCost"]
  ): JobManager<unknown, undefined> {
    const descriptor = configureDVM({
      name: "cross-machine-cancel-db",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob,
    });
    return new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: storeA,
      devMode: true,
      fxFetcher: createFxFetcher(),
      dvmId: "dvm-1",
      onJobCost,
      staleJobTimeoutMs: 0,
      processingWatchdogMs: 0,
      heartbeatIntervalMs: 0,
    });
  }

  it("B's DELETE aborts A's handler within a NOTIFY round-trip", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let sawAbort!: () => void;
    const abortReached = new Promise<void>((resolve) => (sawAbort = resolve));
    const handler = { abortedWhenResumed: undefined as boolean | undefined };
    const costs: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0][] = [];
    let reportAttempted!: () => void;
    const reportAttempt = new Promise<void>((resolve) => (reportAttempted = resolve));

    const jm = machineA(
      async (ctx) => {
        ctx.cost({ amount: 0.001, currency: "usd" });
        ctx.cost({ amount: 0.0015, currency: "usd" });
        ctx.signal.addEventListener("abort", () => {
          sawAbort();
        });
        await blocked;
        handler.abortedWhenResumed = ctx.signal.aborted;
        // The zombie's last gasp — the adopted terminal status must block both.
        ctx.text("late");
        ctx.complete("resurrect");
      },
      (info) => {
        costs.push(info);
        reportAttempted();
        // Stand in for an exit before the outbox enqueue commits. The adopted
        // terminal row must already hold A's fresher revision so a new process
        // can recover it.
        throw new Error("simulated report enqueue failure");
      }
    );

    try {
      const job = jm.createJob(
        { input: "hello" },
        "requester-1",
        { paidMsats: 5_000, receivedProofs: [], paymentRail: "cashu" },
        5_000,
        "test"
      );
      const ctx = jm.buildAndAttachContext(job, "hello");
      await jm.persistJob(job);
      jm.runHandler(job, ctx as SDKJobContext<unknown, unknown>);

      // The last normal save reached only A's first declaration. A still has
      // revision 2 in memory when B writes the terminal row from this prefix.
      await poolA.query(
        `UPDATE jobs
         SET cost_amount_micro = 1000, cost_currency = 'usd', cost_revision = 1
         WHERE id = $1`,
        [job.id]
      );
      // The first owner-side merge fails after local terminal adoption. Since
      // later NOTIFY checks intentionally stop at terminal, the dedicated
      // handoff retry must carry revision 2 to durability and reporting.
      storeA.failNextSave();

      // Machine B's store-only DELETE (`app.ts` handleDeleteJob, no local job).
      const cancelled = await storeB.cancelJob(job.id, "caller changed their mind");
      expect(cancelled).toBe(true);

      // A hears it over LISTEN/NOTIFY — before the handler writes anything.
      await within(abortReached, 3000, "A's handler abort");
      expect(job.abort.signal.aborted).toBe(true);
      expect(job.status).toBe("cancelled");
      expect((job.abort.signal.reason as Error).message).toBe("caller changed their mind");
      await within(reportAttempt, 3000, "A's cost report attempt");
      expect(await storeA.get(job.id)).toMatchObject({
        costAmountMicro: 2_500,
        costCurrency: "usd",
        costRevision: 2,
      });
      expect(costs).toEqual([
        {
          dvmId: "dvm-1",
          jobId: job.id,
          capability: "test",
          outcome: "cancelled",
          costRevision: 2,
          cost: { amountMicro: 2_500, currency: "usd" },
        },
      ]);

      // A fresh owner recovers the exact revision that failed to enqueue; the
      // remote terminal writer's empty prefix cannot erase it.
      const recovered: typeof costs = [];
      const recovery = machineA(() => undefined, (info) => {
        recovered.push(info);
      });
      try {
        await expect(recovery.recoverTerminalCosts()).resolves.toEqual({
          examined: 1,
          queued: 1,
          complete: true,
        });
        expect(recovered).toEqual(costs);
      } finally {
        recovery.shutdown();
      }
      // A adopts the whole terminal row: the reason (else a later `persistJob`
      // writes `summary = NULL` over it) and the `cancel` message itself, which
      // is what A's own read paths serve during the cleanup window.
      expect(job.summary).toBe("caller changed their mind");
      const cancelMsg = job.messages.find((m) => m.type === "cancel");
      expect(cancelMsg?.content).toMatchObject({ reason: "caller changed their mind" });

      release();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(handler.abortedWhenResumed).toBe(true);
      const record = await storeA.get(job.id);
      expect(record?.status).toBe("cancelled");
      expect(record?.summary).toBe("caller changed their mind");
      expect(record?.messages.some((m) => m.type === "complete" || m.type === "text")).toBe(false);
      // The watcher shares A's single LISTEN connection — it must not outlive
      // the job.
      expect(notifySubscriberCount(storeA, job.id)).toBe(0);
    } finally {
      release();
      jm.shutdown();
    }
  });

  it("refuses to cancel a job that already reached a terminal status", async () => {
    const jm = machineA(() => undefined);
    try {
      const job = jm.createJob(
        { input: "hello" },
        "requester-1",
        { paidMsats: 0, receivedProofs: [] },
        undefined,
        "test"
      );
      job.status = "completed";
      await jm.persistJob(job);

      // The CAS is the whole point: no phantom `cancel` on a finished job, and
      // the caller-facing DELETE turns this `false` into a 409.
      expect(await storeB.cancelJob(job.id, "too late")).toBe(false);
      const record = await storeA.get(job.id);
      expect(record?.status).toBe("completed");
      expect(record?.messages.some((m) => m.type === "cancel")).toBe(false);
    } finally {
      jm.shutdown();
    }
  });
});
