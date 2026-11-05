/*
 * Every way a terminal job that carries a credit draw ends without a revenue booking names
 * itself. Driven through the stored-terminal funnel (`finalizeStoredTerminal`), which cancel
 * routes, idle expiry and the stale reaper share.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import type { CreditFundingBasis, CreditLedgerLike } from "../credit-ledger";
import { JobManager, type JobManagerOpts } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { LegacyNullRailLedger } from "./__helpers__/credit-fixtures";

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];

const CALLER = "ab".repeat(32);
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-11-01T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};
const CASHU: CreditFundingBasis = {
  rail: "cashu",
  paidMsats: 1_000_000,
  mint: "https://mint.example.com",
  fundingRef: "req-skip",
};

const managers: JobManager<unknown, undefined>[] = [];
afterEach(() => {
  for (const jm of managers.splice(0)) jm.shutdown();
  vi.restoreAllMocks();
});

/** Fund a credit and hold `amountMicro` on it for one job. */
async function draw(ledger: CreditLedgerLike, basis: CreditFundingBasis = CASHU, amountMicro = 100_000) {
  const snapshot = await ledger.fund({
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 1_000_000,
    expiryMs: Date.now() + 3_600_000,
    basis,
  });
  await ledger.draw({ creditId: snapshot.creditId, drawId: "job-draw", amountMicro });
  return { creditId: snapshot.creditId, drawId: "job-draw" };
}

/**
 * Persist a cancelled job paid by `credit`, then run the stored-terminal funnel over it the
 * way a cancel route does. Returns the revenue reports and every diagnostic event emitted.
 */
async function cancelStored(opts: {
  ledger?: CreditLedgerLike;
  credit: { creditId: string; drawId: string };
  paidMsats?: number;
  paymentRail?: null;
  reporter?: boolean;
  extra?: Partial<JobManagerOpts>;
}): Promise<{ reports: RevenueReport[]; events: string[] }> {
  const reports: RevenueReport[] = [];
  const descriptor = configureDVM({
    name: "revenue-skip-diagnostics",
    capability: "do",
    tag: "test",
    onJob() {},
  });
  const jm = new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    devMode: true,
    dvmId: "dvm-skip",
    ...(opts.ledger && { creditLedger: opts.ledger }),
    ...(opts.reporter !== false && {
      onJobCompleted: (info: RevenueReport) => {
        reports.push(info);
      },
    }),
    orphanDrawSweepIntervalMs: 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
    ...opts.extra,
  });
  managers.push(jm as never);
  const lines: string[] = [];
  const capture = (line: unknown) => {
    lines.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
  const job = jm.createJob(
    { input: "hi" },
    "requester-1",
    {
      paidMsats: opts.paidMsats ?? 100_000,
      ...(opts.paymentRail === null ? {} : { paymentRail: "cashu" as const }),
      receivedProofs: [],
      ...opts.credit,
    },
    100_000,
    "do"
  );
  job.status = "cancelled";
  job.endedBy = "caller";
  await jm.persistJob(job);
  await jm.finalizeStoredTerminal(job.id);
  await new Promise((done) => setTimeout(done, 10));
  const events = lines.flatMap((line) => {
    try {
      const event = (JSON.parse(line) as { event?: unknown }).event;
      return typeof event === "string" && event.startsWith("revenue_") ? [event] : [];
    } catch {
      return [];
    }
  });
  return { reports, events };
}

describe("a terminal draw-backed job that books no revenue says why", () => {
  it("books a cancelled job's settled draw and names no skip", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    await ledger.resolveDraw({ ...credit, settleMicro: 60_000 });

    const { reports, events } = await cancelStored({ ledger, credit });

    expect(reports).toEqual([expect.objectContaining({ ...credit, drawAmountMicro: 60_000, rail: "cashu" })]);
    expect(events).toEqual([]);
  });

  it("names a released draw", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    await ledger.release(credit);

    const { reports, events } = await cancelStored({ ledger, credit });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_released_draw"]);
  });

  it("names an abandoned deferred x402 authorization", async () => {
    const release = vi.fn(() => Promise.resolve());
    const { reports, events } = await cancelStored({
      ledger: new MemoryCreditLedger(),
      credit: { creditId: "x402d:intent-1", drawId: "intent-1" },
      extra: {
        deferredX402: { hold: () => {}, settle: () => Promise.resolve("settled"), release } as never,
      },
    });

    expect(release).toHaveBeenCalledOnce();
    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_released_draw"]);
  });

  it("names a draw still pending because its resolution failed", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    vi.spyOn(ledger, "resolveDraw").mockRejectedValue(new Error("ledger unavailable"));

    const { reports, events } = await cancelStored({ ledger, credit });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_unsettled_draw"]);
    expect((await ledger.getDraw(credit))?.status).toBe("pending");
  });

  it("names a draw the ledger could not read", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    await ledger.resolveDraw({ ...credit, settleMicro: 60_000 });
    vi.spyOn(ledger, "getDraw").mockRejectedValue(new Error("ledger unavailable"));

    const { reports, events } = await cancelStored({ ledger, credit });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_unsettled_draw"]);
  });

  it("names a draw the ledger has no record of", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);

    const { reports, events } = await cancelStored({ ledger, credit: { ...credit, drawId: "never-drawn" } });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_unsettled_draw"]);
  });

  it("names a manager with no ledger to read the draw", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);

    const { reports, events } = await cancelStored({ credit });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_no_ledger"]);
  });

  it("names a settled draw on a manager with no revenue reporter", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    await ledger.resolveDraw({ ...credit, settleMicro: 60_000 });

    const { events } = await cancelStored({ ledger, credit, reporter: false });

    expect(events).toEqual(["revenue_skipped_no_reporter"]);
  });

  it("names a settled draw with no rail value and no msats to book under", async () => {
    // A credit with no recorded rail, and a job whose own counter carries nothing.
    const ledger = new LegacyNullRailLedger();
    const credit = await draw(ledger);
    await ledger.resolveDraw({ ...credit, settleMicro: 60_000 });

    const { reports, events } = await cancelStored({ ledger, credit, paidMsats: 0 });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_unbookable_draw"]);
  });

  it("names a settled draw whose job row lost its rail", async () => {
    const ledger = new MemoryCreditLedger();
    const credit = await draw(ledger);
    await ledger.resolveDraw({ ...credit, settleMicro: 60_000 });

    const { reports, events } = await cancelStored({ ledger, credit, paymentRail: null });

    expect(reports).toEqual([]);
    expect(events).toEqual(["revenue_skipped_no_rail"]);
  });
});
