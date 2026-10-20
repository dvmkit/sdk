/**
 * the per-job cost column, round-tripped through Postgres.
 *
 * Two things only the real database can catch. `cost_amount_micro` is a
 * BIGINT, which node-postgres hands back as a *string* — a mapper that forgets
 * to convert would put `"21500"` on the wire, where the platform's arithmetic
 * silently stops being arithmetic. And the handler writes this column *after*
 * the row exists, so unlike the insert-only provenance columns it has to be in
 * `save`'s `ON CONFLICT DO UPDATE` branch or a declared cost never lands at
 * all.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { JobManager, type JobManagerOpts } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { RevenueReporter } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("per-job cost persistence", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;
  // Unreachable platform: delivery fails fast and every queued report stays
  // in the outbox for inspection.
  let reporter: RevenueReporter;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
    reporter = new RevenueReporter(pool, "http://127.0.0.1:9", "token");
    await reporter.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM pending_dvm_reports");
    await pool.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  function record(cost?: {
    amountMicro: number;
    currency: string;
    revision: number;
  }): JobRecord {
    return {
      id: "job-cost-1",
      tags: [],
      capability: "test",
      input: "hello",
      params: {},
      requesterId: "requester-1",
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: 5_000,
      ...(cost && {
        costAmountMicro: cost.amountMicro,
        costCurrency: cost.currency,
        costRevision: cost.revision,
      }),
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
  }

  it("leaves both halves undefined when the handler declared nothing", async () => {
    await store.save(record());
    const back = await store.get("job-cost-1");
    // Undefined, not 0 — the column is NULL and the distinction is the point.
    expect(back?.costAmountMicro).toBeUndefined();
    expect(back?.costCurrency).toBeUndefined();
    expect(back?.costRevision).toBeUndefined();
  });

  it("keeps a declared zero apart from no declaration", async () => {
    await store.save(record({ amountMicro: 0, currency: "usd", revision: 1 }));
    const back = await store.get("job-cost-1");
    expect(back?.costAmountMicro).toBe(0);
    expect(back?.costCurrency).toBe("usd");
    expect(back?.costRevision).toBe(1);
  });

  it("updates the cost on a later save of an existing row", async () => {
    // The handler declares as it goes, so every save after the first lands on
    // the ON CONFLICT branch. A cost that only ever arrived on INSERT would
    // pin the row to whatever the first snapshot happened to hold.
    await store.save(record({ amountMicro: 400, currency: "usd", revision: 1 }));
    const inserted = await store.get("job-cost-1");
    expect(inserted?.costAmountMicro).toBe(400);
    expect(inserted?.costCurrency).toBe("usd");
    expect(inserted?.costRevision).toBe(1);
    await store.save(record({ amountMicro: 21_500, currency: "usd", revision: 3 }));
    const back = await store.get("job-cost-1");
    expect(back?.costAmountMicro).toBe(21_500);
    expect(typeof back?.costAmountMicro).toBe("number");
    expect(back?.costCurrency).toBe("usd");
    expect(back?.costRevision).toBe(3);

    // A stale snapshot from another machine cannot replace the later
    // cumulative declaration.
    await store.save(record({ amountMicro: 900, currency: "usd", revision: 2 }));
    const afterStaleSave = await store.get("job-cost-1");
    expect(afterStaleSave?.costAmountMicro).toBe(21_500);
    expect(afterStaleSave?.costRevision).toBe(3);
  });

  it("recovers terminal cost-only revisions left before durable outbox enqueue", async () => {
    const descriptor = configureDVM({
      name: "cost-recovery-test",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    const dvmId = "dvm-cost-recovery";

    // Simulate a process exiting after these terminal saves and before it can
    // call reportCost(): there is deliberately no outbox row or marker yet.
    await store.saveForDvm(
      {
        ...record({ amountMicro: 21_500, currency: "usd", revision: 1 }),
        id: "failed-cost",
        status: "failed",
      },
      dvmId
    );
    await store.saveForDvm(
      {
        ...record({ amountMicro: 400, currency: "usd", revision: 1 }),
        id: "free-cost",
        status: "completed",
        paidMsats: 0,
      },
      dvmId
    );
    await store.saveForDvm(
      {
        ...record({ amountMicro: 900, currency: "usd", revision: 1 }),
        id: "other-dvm-cost",
        status: "failed",
      },
      "dvm-other-mount"
    );

    // A fresh server boot must discover both rows before it starts serving.
    const runtime = await createDVMServer(descriptor, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "token",
        DVMKIT_PLATFORM_URL: "http://127.0.0.1:9",
      },
      store: new MemoryKVStore(),
      jobStore: store,
      db: pool,
      devMode: true,
      dvmId,
      fxFetcher: createFxFetcher(),
    });
    try {
      const first = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM pending_dvm_reports WHERE kind = 'cost' ORDER BY payload->>'jobId'`
      );
      expect(first.rows.map((row) => row.payload)).toEqual([
        {
          dvmId,
          jobId: "failed-cost",
          capability: "test",
          outcome: "failed",
          costRevision: 1,
          cost: { amountMicro: 21_500, currency: "usd" },
        },
        {
          dvmId,
          jobId: "free-cost",
          capability: "test",
          outcome: "completed",
          costRevision: 1,
          cost: { amountMicro: 400, currency: "usd" },
        },
      ]);
      expect(
        await pool.query(
          `SELECT 1 FROM jobs
           WHERE id = 'other-dvm-cost' AND cost_reported_revision IS NULL`
        )
      ).toMatchObject({ rowCount: 1 });
      await expect(runtime.jobManager.recoverTerminalCosts()).resolves.toEqual({
        examined: 0,
        queued: 0,
        complete: true,
      });

      // A later null revision invalidates the prior amount and becomes
      // eligible again; the marker never suppresses fresher state.
      await store.saveForDvm(
        {
          ...record(),
          id: "failed-cost",
          status: "failed",
          costRevision: 2,
        },
        dvmId
      );
      await expect(runtime.jobManager.recoverTerminalCosts()).resolves.toEqual({
        examined: 1,
        queued: 1,
        complete: true,
      });
      const invalidation = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM pending_dvm_reports
         WHERE kind = 'cost' AND payload->>'jobId' = 'failed-cost'
         ORDER BY (payload->>'costRevision')::int DESC LIMIT 1`
      );
      expect(invalidation.rows[0]?.payload).toMatchObject({
        dvmId,
        jobId: "failed-cost",
        outcome: "failed",
        costRevision: 2,
        cost: null,
      });
    } finally {
      await runtime.shutdown();
    }
  });

  describe("concurrent recovery", () => {
    const dvmId = "dvm-cost-race";
    const managers: JobManager<unknown, undefined>[] = [];

    afterEach(() => {
      for (const manager of managers.splice(0)) manager.shutdown();
    });

    function recoverer(onJobCost: JobManagerOpts["onJobCost"]): JobManager<unknown, undefined> {
      const manager = new JobManager(
        configureDVM({
          name: "cost-race-test",
          capability: "test",
          tag: "test",
          onJob(ctx) {
            ctx.complete("ok");
          },
        }),
        {
          env: {},
          store: new MemoryKVStore(),
          jobStore: store,
          devMode: true,
          fxFetcher: createFxFetcher(),
          dvmId,
          onJobCost,
          onJobCompleted: (info) => reporter.report(info),
          staleJobTimeoutMs: 0,
          processingWatchdogMs: 0,
          heartbeatIntervalMs: 0,
        }
      );
      managers.push(manager);
      return manager;
    }

    /** A recoverer that pauses on `race-cost` after its outbox insert commits but before it marks the row. */
    function pausedAfterEnqueue(): {
      manager: JobManager<unknown, undefined>;
      enqueued: Promise<void>;
      release: () => void;
    } {
      let enqueuedResolve!: () => void;
      const enqueued = new Promise<void>((resolve) => (enqueuedResolve = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const manager = recoverer(async (info) => {
        await reporter.reportCost(info);
        if (info.jobId === "race-cost") {
          enqueuedResolve();
          await gate;
        }
      });
      return { manager, enqueued, release };
    }

    async function seedFailed(revision: number): Promise<void> {
      await store.saveForDvm(
        {
          ...record({ amountMicro: 2_500, currency: "usd", revision }),
          id: "race-cost",
          status: "failed",
        },
        dvmId
      );
    }

    /** The handler owner's later mixed-currency declaration invalidates the total. */
    async function persistNullRevision(revision: number): Promise<void> {
      await store.saveForDvm(
        { ...record(), id: "race-cost", status: "failed", costRevision: revision },
        dvmId
      );
    }

    async function queuedCosts(): Promise<Record<string, unknown>[]> {
      const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM pending_dvm_reports WHERE kind = 'cost'
         ORDER BY payload->>'jobId', (payload->>'costRevision')::int`
      );
      return rows.map((row) => row.payload);
    }

    it("keeps a revision written during enqueue eligible until a later pass queues it", async () => {
      await seedFailed(2);
      await store.saveForDvm(
        {
          ...record({ amountMicro: 400, currency: "usd", revision: 1 }),
          id: "free-cost",
          status: "completed",
          paidMsats: 0,
        },
        dvmId
      );
      // A paid completion carries its cost on the revenue report, so recovery
      // must neither send a cost-only event nor book revenue for it.
      await store.saveForDvm(
        {
          ...record({ amountMicro: 900, currency: "usd", revision: 1 }),
          id: "paid-cost",
          status: "completed",
          paymentRail: "cashu",
        },
        dvmId
      );

      const first = pausedAfterEnqueue();
      const firstPass = first.manager.recoverTerminalCosts();
      await first.enqueued;
      await persistNullRevision(3);
      first.release();
      // Revision 2 reached the outbox but is no longer the row's state, so it
      // must not mark the row and hide revision 3.
      await expect(firstPass).resolves.toEqual({ examined: 2, queued: 1, complete: true });
      expect(
        (await store.listUnreportedTerminalCosts({ dvmId, limit: 10 })).map((r) => [
          r.id,
          r.costRevision,
        ])
      ).toEqual([["race-cost", 3]]);

      const restarted = recoverer((info) => reporter.reportCost(info));
      await expect(restarted.recoverTerminalCosts()).resolves.toEqual({
        examined: 1,
        queued: 1,
        complete: true,
      });
      expect(await store.listUnreportedTerminalCosts({ dvmId, limit: 10 })).toEqual([]);
      expect(await queuedCosts()).toEqual([
        {
          dvmId,
          jobId: "free-cost",
          capability: "test",
          outcome: "completed",
          costRevision: 1,
          cost: { amountMicro: 400, currency: "usd" },
        },
        {
          dvmId,
          jobId: "race-cost",
          capability: "test",
          outcome: "failed",
          costRevision: 2,
          cost: { amountMicro: 2_500, currency: "usd" },
        },
        {
          dvmId,
          jobId: "race-cost",
          capability: "test",
          outcome: "failed",
          costRevision: 3,
          cost: null,
        },
      ]);
      expect(
        await pool.query(`SELECT 1 FROM pending_dvm_reports WHERE kind <> 'cost'`)
      ).toMatchObject({ rowCount: 0 });
    });

    it("cannot regress a sibling's fresher marker with a late stale mark", async () => {
      await seedFailed(2);

      const slow = pausedAfterEnqueue();
      const slowPass = slow.manager.recoverTerminalCosts();
      await slow.enqueued;
      await persistNullRevision(3);
      // A sibling machine queues and marks the final revision while the slow
      // machine still holds its revision-2 payload.
      const sibling = recoverer((info) => reporter.reportCost(info));
      await expect(sibling.recoverTerminalCosts()).resolves.toEqual({
        examined: 1,
        queued: 1,
        complete: true,
      });
      slow.release();
      await expect(slowPass).resolves.toEqual({ examined: 1, queued: 0, complete: true });

      const { rows } = await pool.query<{ cost_reported_revision: string }>(
        `SELECT cost_reported_revision FROM jobs WHERE id = 'race-cost'`
      );
      expect(Number(rows[0]?.cost_reported_revision)).toBe(3);
      expect(await store.listUnreportedTerminalCosts({ dvmId, limit: 10 })).toEqual([]);
      expect((await queuedCosts()).map((p) => [p.costRevision, p.cost])).toEqual([
        [2, { amountMicro: 2_500, currency: "usd" }],
        [3, null],
      ]);
    });
  });

  it("serves recovery pages from the unreported-cost index", async () => {
    // Recovery runs at boot and every 30s on each machine. If the query and
    // the backlog-only partial index drift apart, the planner silently walks
    // the DVM's whole costed terminal history instead.
    const spy = vi.spyOn(pool, "query");
    let issued: [string, unknown[]];
    try {
      await store.listUnreportedTerminalCosts({ dvmId: "dvm-plan", limit: 100, afterJobId: "a" });
      issued = spy.mock.calls.at(-1) as unknown as [string, unknown[]];
    } finally {
      spy.mockRestore();
    }
    const [text, values] = issued;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const { rows } = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON) ${text}`,
        values
      );
      // Job reads stay on the backlog index. Balance acceptance is an indexed
      // lookup by job, not a scan of every accepted payment. A drifted job
      // predicate could otherwise reach reported history through a BitmapOr.
      const scans: string[] = [];
      const walk = (node: Record<string, unknown>): void => {
        const type = node["Node Type"] as string;
        if (type.endsWith("Scan") && type !== "Bitmap Heap Scan") {
          scans.push(`${type}:${String(node["Index Name"] ?? node["Relation Name"])}`);
        }
        for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? []) walk(child);
      };
      walk((rows[0]?.["QUERY PLAN"] as { Plan: Record<string, unknown> }[])[0].Plan);
      expect(scans).toHaveLength(2);
      expect(scans).toEqual(expect.arrayContaining([
        expect.stringMatching(/Index.*Scan:idx_jobs_unreported_terminal_cost$/),
        expect.stringMatching(/Index.*Scan:credit_balance_payments_job_id_request_seq_key$/),
      ]));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
