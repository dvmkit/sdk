import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { drawSettlementRef, implicitCreditId } from "../funding";
import type { ServerJob } from "../job";
import { JobManager } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { LegacyNullRailLedger } from "./__helpers__/credit-fixtures";

const RATE = 25_000;
const DVM_ID = "dvm-1";
const CALLER = "aa".repeat(32);
const JOB_ID = "job-1";
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

/**
 * One credit funded at $2.00 for 4000 sats — 2 msats per usd-micro, the ratio
 * a deposit taken at $50k/BTC pins. A $1.00 job draws half: 1_000_000 micro,
 * and `allocateDrawValue` hands it 2_000_000 msats of rail value.
 */
const FUND_MICRO = 2_000_000;
const FUND_MSATS = 4_000_000;
const DRAW_MICRO = 1_000_000;
const DRAW_MSATS = 2_000_000;

/**
 * The ask, at a rate that has since halved to $25k. $0.60 is 2_400_000 msats —
 * more than the whole slice, though it is well inside the $1.00 draw.
 */
const ASK = { amount: 0.6, currency: "usd" } as const;
const ASK_MSATS = 2_400_000;
const ASK_MICRO = 600_000;

function warmFetcher(): FxFetcher {
  return {
    fetch: vi.fn(() =>
      Promise.resolve({
        rates: { usd: RATE } as FxRateSnapshot["rates"],
        as_of: new Date(0).toISOString(),
      })
    ),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

function manager(ledger: MemoryCreditLedger): JobManager<Record<string, unknown>, undefined> {
  const descriptor = configureDVM({
    name: "draw-pool-test",
    capability: "test",
    tag: "test",
    onJob: () => undefined,
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: warmFetcher(),
    dvmId: DVM_ID,
    creditLedger: ledger,
  });
}

function drawnJob(overrides: Partial<ServerJob> = {}): ServerJob {
  return {
    id: JOB_ID,
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: DRAW_MSATS,
    paymentRail: "cashu",
    creditId: "c1",
    drawId: "d1",
    paymentTxHash: drawSettlementRef(DVM_ID, "c1", "d1"),
    receivedProofs: [],
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: {},
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

async function seed(
  ledger: MemoryCreditLedger,
  opts: { creditId: string; drawId: string; rail?: "cashu" | "x402" | "tempo" } = {
    creditId: "c1",
    drawId: "d1",
  }
): Promise<void> {
  await ledger.fund({
    creditId: opts.creditId,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: FUND_MICRO,
    expiryMs: FUTURE_MS,
    basis: {
      rail: opts.rail ?? "cashu",
      paidMsats: FUND_MSATS,
      nativeAmount: undefined,
      nativeAsset: undefined,
      fundingRef: "req-upfront",
    },
  });
  await ledger.draw({
    creditId: opts.creditId,
    drawId: opts.drawId,
    amountMicro: DRAW_MICRO,
    jobId: JOB_ID,
  });
}

async function ask(ledger: MemoryCreditLedger, job: ServerJob, count = 1): Promise<ServerJob> {
  const ctx = manager(ledger).buildAndAttachContext(job, {});
  void (async () => {
    for (let i = 0; i < count; i++) await ctx.requestPayment(ASK, `stage ${i + 1}`);
  })().catch(() => undefined);
  for (let i = 0; i < 8 * count; i++) await new Promise((r) => setTimeout(r, 0));
  return job;
}

describe("JobManager draw pool — regime discriminator", () => {
  it("gives an explicit draw a fiat pool, so the ask its slice refuses lands", async () => {
    const ledger = new MemoryCreditLedger();
    await seed(ledger);

    const job = await ask(ledger, drawnJob());

    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
  });

  it("leaves an implicit N=1 draw on msats, where its own figures are exact", async () => {
    // `fundAndDraw` derives both ids from the rail's payment id, so the shape is
    // `imp:<rail>:<paymentId>` paired with `drawId: <paymentId>` — the one thing
    // no caller-chosen envelope can reproduce.
    const ledger = new MemoryCreditLedger();
    const creditId = implicitCreditId("cashu", "req-upfront");
    await seed(ledger, { creditId, drawId: "req-upfront" });

    const job = await ask(ledger, drawnJob({ creditId, drawId: "req-upfront" }));

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(ASK_MSATS);
  });

  it("still reads as explicit after a mid-job payment overwrote payment_tx_hash", async () => {
    const ledger = new MemoryCreditLedger();
    await seed(ledger);

    const job = await ask(ledger, drawnJob({ paymentTxHash: "0xmidjobsettlement" }));

    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
  });

  it("keeps the msat comparison when the credit predates rail-value basis", async () => {
    // Legacy NULL-rail projections leave the job’s original paidMsats intact; explicit priced
    // draws must instead use their fiat pool.
    const ledger = new LegacyNullRailLedger();
    await seed(ledger, { creditId: "c1", drawId: "d1" });

    const job = await ask(ledger, drawnJob({ paidMsats: ASK_MSATS }));

    expect(job.status).toBe("processing");
    expect(job.messages.length).toBe(0);
  });

  it("yields rather than spend msats it can't price, when the draw row is gone", async () => {
    const job = await ask(new MemoryCreditLedger(), drawnJob({ paidMsats: ASK_MSATS }));

    expect(job.status).toBe("awaiting-input");
    expect(job.pendingPaymentMsats).toBe(ASK_MSATS);
  });

  it("depletes the pool across asks, and a top-up restores exactly what it bought", async () => {
    // Rebuilding the context must consume the same pinned asks after growth; top-up cannot
    // buy a second copy of an already consumed ask.
    const ledger = new MemoryCreditLedger();
    await seed(ledger);

    const before = await ask(ledger, drawnJob(), 2);

    expect(before.status).toBe("awaiting-input");
    expect(before.messages.filter((m) => m.type === "payment-request").length).toBe(1);
    expect(before.pendingPaymentFiatMicro).toBe(ASK_MICRO);

    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: ASK_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: ASK_MSATS, fundingRef: "req-topup" },
    });
    const grown = await ledger.growDraw({
      creditId: "c1",
      drawId: "d1",
      addAmountMicro: ASK_MICRO,
      addRailValue: { drawMsats: ASK_MSATS, drawNative: null },
      jobId: JOB_ID,
    });
    expect(grown.amountMicro).toBe(DRAW_MICRO + ASK_MICRO);

    const after = await ask(ledger, drawnJob(), 2);

    expect(after.status).toBe("processing");
    expect(after.messages.length).toBe(0);
  });
});
