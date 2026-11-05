/*
 * Terminal revenue recovery on Postgres stores: a draw-backed terminal job whose settled draw
 * never reached the reporter is booked by the background pass, byte-identically to the
 * in-line booking, exactly once across passes and restarts.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { CreditLedger } from "../credit-ledger";
import { JobManager, type JobManagerOpts } from "../job-manager";
import { PostgresJobStore } from "../postgres-job-store";

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];
type CostReport = Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0];

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_terminal_revenue_recovery";
const CALLER = "ef".repeat(32);
const DVM_ID = "dvm-revenue-recovery";
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-11-01T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe.skipIf(!RUN)("terminal revenue recovery (Postgres stores)", () => {
  let pool: pg.Pool;
  let jobStore: PostgresJobStore;
  let ledger: CreditLedger;
  const managers: JobManager<unknown, undefined>[] = [];

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
    jobStore = new PostgresJobStore(pool);
    ledger = new CreditLedger(pool);
    await jobStore.init();
    await ledger.init();
  });

  afterEach(async () => {
    for (const jm of managers.splice(0)) jm.shutdown();
    vi.restoreAllMocks();
    await pool.query("TRUNCATE jobs, credit_draws, credit_funding_lots, credit_fundings, credits CASCADE");
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  /** A manager on the shared stores, standing in for one DVM process. */
  function manager(onJobCompleted: JobManagerOpts["onJobCompleted"], costs: CostReport[] = []) {
    const descriptor = configureDVM({ name: "revenue-recovery", capability: "do", tag: "test", onJob() {} });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      creditLedger: ledger,
      fxFetcher: stubFx,
      devMode: true,
      dvmId: DVM_ID,
      onJobCompleted,
      onJobCost: (info) => {
        costs.push(info);
      },
      orphanDrawSweepIntervalMs: 0,
      staleJobTimeoutMs: 0,
      processingWatchdogMs: 0,
      heartbeatIntervalMs: 0,
    });
    managers.push(jm as never);
    return jm;
  }

  /**
   * A cancelled metered job whose finished part settled on its draw, as a stored-terminal
   * path leaves it: the row is terminal and the draw settled, and nothing has booked it yet.
   */
  async function strandedCancelledJob(jm: JobManager<unknown, undefined>, terminalAgoMs = 120_000) {
    const snapshot = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "cashu", paidMsats: 1_000_000, mint: "https://mint.example.com", fundingRef: "req-recovery" },
    });
    const credit = { creditId: snapshot.creditId, drawId: "metered-draw" };
    await ledger.draw({ ...credit, amountMicro: 300_000 });
    await ledger.resolveDraw({ ...credit, settleMicro: 240_000 });
    const job = jm.createJob(
      { input: "hi" },
      "requester-1",
      {
        paidMsats: 300_000,
        paymentRail: "cashu",
        paymentMint: "https://mint.example.com",
        paymentTxHash: "req-recovery-job",
        cashuFlow: "p2pk_accumulator",
        receivedProofs: [],
        ...credit,
      },
      300_000,
      "do"
    );
    job.status = "cancelled";
    job.endedBy = "caller";
    job.summary = "Job timed out (idle)";
    job.costAmountMicro = 1_500;
    job.costCurrency = "usd";
    job.costRevision = 1;
    await jm.persistJob(job);
    // The terminal save stamps its own instant; age it as a row from an earlier pass would be.
    await pool.query("UPDATE jobs SET terminal_at_ms = terminal_at_ms - $2 WHERE id = $1", [job.id, terminalAgoMs]);
    return { jobId: job.id, ...credit };
  }

  const settle = () => new Promise((done) => setTimeout(done, 20));

  it("books a stranded job exactly as the in-line funnel does, once, across passes and a restart", async () => {
    const inline: RevenueReport[] = [];
    const first = manager((info) => {
      inline.push(info);
    });
    const job = await strandedCancelledJob(first);
    await first.finalizeStoredTerminal(job.jobId);
    await settle();
    expect(inline).toEqual([
      expect.objectContaining({ jobId: job.jobId, creditId: job.creditId, drawId: job.drawId, drawAmountMicro: 240_000 }),
    ]);
    // Losing the marker is the state a crash after the draw settled, or an SDK whose stored
    // terminal paths never booked, leaves behind.
    await pool.query("UPDATE jobs SET revenue_report_enqueued = false WHERE id = $1", [job.jobId]);

    const recovered: RevenueReport[] = [];
    const costs: CostReport[] = [];
    const sweeper = manager((info) => {
      recovered.push(info);
    }, costs);
    await sweeper.recoverTerminalCosts();
    expect(JSON.stringify(recovered)).toBe(JSON.stringify(inline));
    // The booking carried the declared cost, so cost recovery sends no zero-revenue event for it.
    expect(costs).toEqual([]);

    await sweeper.recoverTerminalCosts();
    const restarted = manager((info) => {
      recovered.push(info);
    }, costs);
    await restarted.recoverTerminalCosts();
    expect(recovered).toHaveLength(1);
    expect(costs).toEqual([]);
  });

  it("does not book a job its in-line funnel already reported", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    const job = await strandedCancelledJob(jm);
    await jm.finalizeStoredTerminal(job.jobId);
    await settle();

    await jm.recoverTerminalCosts();
    await manager((info) => {
      reports.push(info);
    }).recoverTerminalCosts();

    expect(reports).toHaveLength(1);
  });

  it("leaves a job that just ended to its own terminal funnel", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    await strandedCancelledJob(jm, 0);

    await jm.recoverTerminalCosts();

    expect(reports).toEqual([]);
  });

  it("retries a booking the reporter refused, and stops once it is enqueued", async () => {
    const reports: RevenueReport[] = [];
    let refuse = true;
    const jm = manager((info) => {
      if (refuse) return Promise.reject(new Error("outbox unavailable"));
      reports.push(info);
      return Promise.resolve();
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const job = await strandedCancelledJob(jm);

    await jm.recoverTerminalCosts();
    expect(reports).toEqual([]);

    refuse = false;
    await jm.recoverTerminalCosts();
    await jm.recoverTerminalCosts();
    expect(reports).toEqual([expect.objectContaining({ jobId: job.jobId, drawAmountMicro: 240_000, rail: "cashu" })]);
  });

  it("marks a job whose draw was released, so recovery never revisits it", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    const job = await strandedCancelledJob(jm);
    // Re-point the row at a draw that released whole.
    await ledger.draw({ creditId: job.creditId, drawId: "released-draw", amountMicro: 100_000 });
    await ledger.release({ creditId: job.creditId, drawId: "released-draw" });
    await pool.query("UPDATE jobs SET draw_id = 'released-draw' WHERE id = $1", [job.jobId]);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await jm.recoverTerminalCosts();

    expect(reports).toEqual([]);
    const { rows } = await pool.query("SELECT revenue_report_enqueued FROM jobs WHERE id = $1", [job.jobId]);
    expect(rows[0]).toEqual({ revenue_report_enqueued: true });
  });

  /** Capture `revenue_skipped_unsettled_draw` warnings from here on. */
  function unsettledWarnings(): { count: () => number } {
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    return { count: () => lines.filter((line) => line.includes("revenue_skipped_unsettled_draw")).length };
  }

  const marked = async (jobId: string) =>
    (await pool.query("SELECT revenue_report_enqueued FROM jobs WHERE id = $1", [jobId])).rows[0]
      .revenue_report_enqueued as boolean;

  it("keeps a job whose draw is missing undecided, warns once, and books it once the draw reads settled", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    const job = await strandedCancelledJob(jm);
    await pool.query("UPDATE jobs SET draw_id = 'late-draw' WHERE id = $1", [job.jobId]);
    const warnings = unsettledWarnings();

    await jm.recoverTerminalCosts();
    await jm.recoverTerminalCosts();
    expect(reports).toEqual([]);
    expect(await marked(job.jobId)).toBe(false);
    expect(warnings.count()).toBe(1);

    await ledger.draw({ creditId: job.creditId, drawId: "late-draw", amountMicro: 100_000 });
    await ledger.resolveDraw({ creditId: job.creditId, drawId: "late-draw", settleMicro: 100_000 });
    await jm.recoverTerminalCosts();
    expect(reports).toEqual([expect.objectContaining({ jobId: job.jobId, drawId: "late-draw", drawAmountMicro: 100_000 })]);
    expect(await marked(job.jobId)).toBe(true);
  });

  it("keeps a job whose draw could not be read undecided and books it on a later pass", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    const job = await strandedCancelledJob(jm);
    unsettledWarnings();
    const read = vi.spyOn(ledger, "getDraw").mockRejectedValue(new Error("ledger unavailable"));

    await jm.recoverTerminalCosts();
    expect(reports).toEqual([]);
    expect(await marked(job.jobId)).toBe(false);

    read.mockRestore();
    await jm.recoverTerminalCosts();
    expect(reports).toEqual([expect.objectContaining({ jobId: job.jobId, drawAmountMicro: 240_000 })]);
  });

  it("leaves a pending draw to the reconciler's grace, then warns about it once", async () => {
    const reports: RevenueReport[] = [];
    const jm = manager((info) => {
      reports.push(info);
    });
    const job = await strandedCancelledJob(jm);
    await ledger.draw({ creditId: job.creditId, drawId: "pending-draw", amountMicro: 100_000 });
    await pool.query("UPDATE jobs SET draw_id = 'pending-draw' WHERE id = $1", [job.jobId]);
    const warnings = unsettledWarnings();

    await jm.recoverTerminalCosts();
    await jm.recoverTerminalCosts();
    expect(warnings.count()).toBe(0);

    // Past the default 30-minute reconciler grace, a draw still pending is worth one warning.
    await pool.query("UPDATE jobs SET terminal_at_ms = terminal_at_ms - $2 WHERE id = $1", [job.jobId, 31 * 60_000]);
    await jm.recoverTerminalCosts();
    await jm.recoverTerminalCosts();
    expect(warnings.count()).toBe(1);
    expect(reports).toEqual([]);
    expect(await marked(job.jobId)).toBe(false);
  });

  it("marks completed rows booked when the marker arrives and leaves other endings to recovery", async () => {
    const jm = manager(() => {});
    const cancelled = await strandedCancelledJob(jm);
    const completed = await strandedCancelledJob(jm);
    await pool.query("UPDATE jobs SET status = 'completed' WHERE id = $1", [completed.jobId]);
    await pool.query("ALTER TABLE jobs DROP COLUMN revenue_report_enqueued");

    await new PostgresJobStore(pool).init();

    const { rows } = await pool.query("SELECT id, revenue_report_enqueued FROM jobs ORDER BY id");
    expect(Object.fromEntries(rows.map((row: { id: string; revenue_report_enqueued: boolean }) => [row.id, row.revenue_report_enqueued])))
      .toEqual({ [cancelled.jobId]: false, [completed.jobId]: true });
  });
});
