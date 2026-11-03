import { expect, it } from "vitest";

import { configureDVM } from "../../../configure";
import type { FxFetcher } from "../../../pricing/index";
import { MemoryKVStore } from "../../../store";
import type { CreditFundingBasis, CreditLedgerLike } from "../../credit-ledger";
import { JobManager, type JobManagerOpts } from "../../job-manager";
import type { JobStore } from "../../job-store";
import type { PaymentInfo } from "../../payment";

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];
type CostReport = Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0];

const CALLER = "cd".repeat(32);
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-11-01T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/**
 * Register the revenue contract for a job that ends without completing while its draw is
 * already settled in part: the settled part books once, with the builder's cost on it, and a
 * whole release books nothing. Each case gets fresh stores from `make`, so the scenario runs
 * unchanged against every job store.
 */
export function describePartialDrawRevenue(
  make: () => Promise<{ jobStore: JobStore; ledger: CreditLedgerLike }>
): void {
  it("books the settled part of an x402 credit draw once for a job that failed", async () => {
    const { jobStore, ledger } = await make();
    const credit = await fundAndDraw(ledger, {
      rail: "x402",
      paidMsats: 0,
      nativeAmount: 1_000_000,
      nativeAsset: "usdc",
      fundingRef: "0xfund-partial",
    });
    const settled = await resolve(ledger, credit, 60_000);

    const { reports, costs } = await failJob(jobStore, ledger, credit, {
      paidMsats: 50_000,
      paymentRail: "x402",
      nativeAmount: 100_000,
      nativeAsset: "usdc",
    });

    // 60% of the hold settled: 60% of the leg's msats, the draw's settled native value.
    expect(reports).toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        drawId: credit.drawId,
        drawAmountMicro: 60_000,
        paidMsats: 30_000,
        nativeAmount: 60_000,
        nativeAsset: "usdc",
        rail: "x402",
        settledAt: settled.resolvedAt,
        cost: { amountMicro: 1_000, currency: "usd" },
      }),
    ]);
    expect(costs).toEqual([]);
  });

  it.each(["whole", "partial"] as const)("books nothing for a %s settlement after the x402 channel closes", async (mode) => {
    const { jobStore, ledger } = await make();
    const channelId = `0x${"de".repeat(32)}`;
    const credit = await fundAndDraw(ledger, {
      rail: "x402",
      paidMsats: 0,
      nativeAmount: 1_000_000,
      nativeAsset: "usdc",
      x402Channel: { channelId, maxClaimableAmount: "1000000" },
    });
    await ledger.terminalizeX402Credit({
      channelId,
      channelBalanceNative: 0n,
      totalClaimedNative: 0n,
    });
    if (mode === "whole") await ledger.settle(credit);
    else await resolve(ledger, credit, 60_000);

    const { reports, costs } = await failJob(jobStore, ledger, credit, {
      paidMsats: 50_000,
      paymentRail: "x402",
      nativeAmount: 100_000,
      nativeAsset: "usdc",
    });

    expect(reports).toEqual([]);
    expect(costs).toEqual([expect.objectContaining({ outcome: "failed", cost: { amountMicro: 1_000, currency: "usd" } })]);
  });

  it("books the settled part of a Cashu credit draw at the funding lot's rate", async () => {
    const { jobStore, ledger } = await make();
    const credit = await fundAndDraw(ledger, {
      rail: "cashu",
      paidMsats: 1_000_000,
      mint: "https://mint.example.com",
      fundingRef: "req-partial",
    });
    await resolve(ledger, credit, 60_000);

    const { reports } = await failJob(jobStore, ledger, credit, { paidMsats: 100_000, paymentRail: "cashu" });

    // The hold forecast 100,000 msats for 100,000 micro; 60,000 micro of the lot is 60 sats.
    expect(reports).toEqual([
      expect.objectContaining({ drawAmountMicro: 60_000, paidMsats: 60_000, rail: "cashu" }),
    ]);
  });

  it("books nothing for a failed job whose draw is released whole, and reports its cost", async () => {
    const { jobStore, ledger } = await make();
    const credit = await fundAndDraw(ledger, {
      rail: "x402",
      paidMsats: 0,
      nativeAmount: 1_000_000,
      nativeAsset: "usdc",
      fundingRef: "0xfund-released",
    });

    const { reports, costs } = await failJob(jobStore, ledger, credit, {
      paidMsats: 50_000,
      paymentRail: "x402",
      nativeAmount: 100_000,
      nativeAsset: "usdc",
    });

    expect(reports).toEqual([]);
    expect(costs).toEqual([expect.objectContaining({ outcome: "failed", cost: { amountMicro: 1_000, currency: "usd" } })]);
    expect(await ledger.getDraw(credit)).toMatchObject({ status: "released", amountMicro: 100_000 });
  });
}

async function fundAndDraw(
  ledger: CreditLedgerLike,
  basis: CreditFundingBasis
): Promise<{ creditId: string; drawId: string }> {
  const snapshot = await ledger.fund({
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 1_000_000,
    expiryMs: Date.now() + 3_600_000,
    basis,
  });
  await ledger.draw({ creditId: snapshot.creditId, drawId: "partial-draw", amountMicro: 100_000 });
  return { creditId: snapshot.creditId, drawId: "partial-draw" };
}

async function resolve(
  ledger: CreditLedgerLike,
  draw: { creditId: string; drawId: string },
  settleMicro: number
) {
  if (!ledger.resolveDraw) throw new Error("ledger does not implement resolveDraw");
  return ledger.resolveDraw({ ...draw, settleMicro });
}

/**
 * Run one job paid by `draw` to a handler failure, then go through the paths that re-enter its
 * terminal accounting: a receipt read and the draw reconciler.
 */
async function failJob(
  jobStore: JobStore,
  ledger: CreditLedgerLike,
  draw: { creditId: string; drawId: string },
  payment: Pick<PaymentInfo, "paidMsats" | "paymentRail" | "nativeAmount" | "nativeAsset">
): Promise<{ reports: RevenueReport[]; costs: CostReport[] }> {
  const reports: RevenueReport[] = [];
  const costs: CostReport[] = [];
  const descriptor = configureDVM({
    name: "partial-draw-revenue",
    capability: "do",
    tag: "test",
    idleTimeout: 120,
    onJob(ctx) {
      ctx.cost({ amount: 0.001, currency: "usd" });
      ctx.fail("stopped partway");
    },
  });
  const jm = new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    fxFetcher: stubFx,
    devMode: true,
    dvmId: "dvm-partial",
    creditLedger: ledger,
    onJobCompleted: (info) => {
      reports.push(info);
    },
    onJobCost: (info) => {
      costs.push(info);
    },
    orphanDrawAgeMs: 1,
    terminalDrawReconcileAgeMs: 1,
    orphanDrawSweepIntervalMs: 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
  });
  try {
    const job = jm.createJob(
      { input: "hi" },
      "requester-1",
      { ...payment, receivedProofs: [], ...draw },
      100_000,
      "do"
    );
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, "hi"));
    await job.terminalWork;
    const record = await jobStore.get(job.id);
    expect(record?.status).toBe("failed");
    await jm.issueReceipt(record!);
    await jm.sweepOrphanDraws();
    // Revenue and cost callbacks are fired off the terminal path without being awaited.
    await new Promise((done) => setTimeout(done, 25));
  } finally {
    jm.shutdown();
  }
  return { reports, costs };
}
