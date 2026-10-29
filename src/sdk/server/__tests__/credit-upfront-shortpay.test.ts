/* Implicit upfront short pays forfeit without a job. Explicit funding remains refundable unless its draw is covered. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import type { CreditDepositPayload } from "../revenue-reporter";

vi.mock("../../../lib/cashu/verify", () => ({
  verifyCashuToken: vi.fn(),
}));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { verifyCashuToken } = await import("../../../lib/cashu/verify");
const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");

const RATE = 100_000;
const DVM_ID = "dvm-1";
const CALLER = "aa".repeat(32);
const JOB_ID = "job-1";
const MINT = "https://mint.example";
const CASHU_TOKEN = "cashuTok";
const REQUEST_ID = "req-short";

const CREDIT_ID = `imp:cashu:${REQUEST_ID}`;
const EXPLICIT_CREDIT_ID = "credit-explicit";
const EXPLICIT_DRAW_ID = "draw-explicit";

const PRICE_MICRO = 100_000;
const PRICE_MSATS = 100_000;
const SHORT_MSATS = 30_000;
const SHORT_MICRO = 30_000;

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

interface Harness {
  ledger: MemoryCreditLedger;
  processedPayments: MemoryProcessedPaymentStore;
  deposits: CreditDepositPayload[];
}

function harness(): Harness {
  return {
    ledger: new MemoryCreditLedger(),
    processedPayments: new MemoryProcessedPaymentStore(),
    deposits: [],
  };
}

// The stub invokes the real receive commit hook with no explicit envelope and no midJob context.
function shortUpfrontPay(h: Harness) {
  vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
    const accepted = {
      grossMsats: SHORT_MSATS,
      inputFeeMsats: 0,
      mintUrl: MINT,
      netMsats: SHORT_MSATS,
      paidMsats: SHORT_MSATS,
      requestId: opts.requestId ?? "",
    };
    await opts.withCommitTx?.({} as never, accepted);
    return { kind: "accumulated" as const, ...accepted };
  });
  return verifyUpfrontPayment({
    cashuToken: CASHU_TOKEN,
    cashuMode: "p2pk-accumulator",
    accumulatorDb: {} as never,
    lockPubkeys: ["02" + "ab".repeat(32)] as never,
    mints: [MINT],
    requestId: REQUEST_ID,
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    enqueueCreditDeposit: async (_tx, payload) => {
      h.deposits.push(payload);
    },
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: JOB_ID,
  });
}

function explicitShortUpfrontPay(h: Harness) {
  vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
    const accepted = {
      grossMsats: SHORT_MSATS + 1_000,
      inputFeeMsats: 1_000,
      mintUrl: MINT,
      netMsats: SHORT_MSATS,
      paidMsats: SHORT_MSATS,
      requestId: opts.requestId ?? "",
    };
    await opts.beforeCommit?.(accepted);
    await opts.withCommitTx?.({} as never, accepted);
    return { kind: "accumulated" as const, ...accepted };
  });
  return verifyUpfrontPayment({
    cashuToken: CASHU_TOKEN,
    cashuMode: "p2pk-accumulator",
    accumulatorDb: {} as never,
    lockPubkeys: ["02" + "ab".repeat(32)] as never,
    mints: [MINT],
    requestId: REQUEST_ID,
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    enqueueCreditDeposit: async (_tx, payload) => {
      h.deposits.push(payload);
    },
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: JOB_ID,
    creditEnvelope: {
      creditId: EXPLICIT_CREDIT_ID,
      drawId: EXPLICIT_DRAW_ID,
      fund: {
        amountMicro: SHORT_MICRO,
        commitment: fundingCommitment(CASHU_TOKEN),
      },
    },
  });
}

function seedExplicitBalance(h: Harness, amountMicro: number): Promise<unknown> {
  return h.ledger.fund({
    creditId: EXPLICIT_CREDIT_ID,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro,
    expiryMs: Date.now() + 86_400_000,
    basis: {
      rail: "cashu",
      paidMsats: amountMicro,
      mint: MINT,
      fundingRef: "earlier-funding",
    },
  });
}

describe("an upfront short pay's 402 names no credit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyCashuToken).mockReturnValue({
      mint: MINT,
      totalMsats: SHORT_MSATS,
      unit: "sat",
    });
  });

  it("settles the short pay as a forfeit — no job will ever carry it", async () => {
    const h = harness();
    const { error, paidMsats } = await shortUpfrontPay(h);

    expect(error?.status).toBe(402);
    expect(error?.body.error).toBe("payment_insufficient");
    // The positive half of the split, and the reason the negative half holds:
    // the proofs are committed under today's keep-the-money posture, so the
    // implicit draw that landed with them is closed on the spot. The route
    // books it under a synthetic job id tagged `short_pay_forfeit`.
    expect(error?.forfeit).toMatchObject({
      paymentId: REQUEST_ID,
      paidMsats: SHORT_MSATS,
      mint: MINT,
      creditId: CREDIT_ID,
      drawId: REQUEST_ID,
      amountMicro: SHORT_MICRO,
      currency: "usd",
    });
    expect(error?.forfeit?.settledAt).toEqual(expect.any(Number));

    const draw = await h.ledger.getDraw({ creditId: CREDIT_ID, drawId: REQUEST_ID });
    expect(draw?.status).toBe("settled");

    const credit = await h.ledger.get(CREDIT_ID);
    expect(credit?.balanceMicro).toBe(0);
    expect(credit?.availableMicro).toBe(0);

    expect(error?.body.credit_id).toBeUndefined();
    expect(error?.body.credited_micro).toBeUndefined();
    expect(error?.body.credit_currency).toBeUndefined();

    const hint = error?.body.hint as string;
    expect(hint).toContain("required_msats");
    expect(hint).not.toContain("drain");
    expect(hint).not.toContain("credit");
    expect(hint).not.toContain(CREDIT_ID);

    expect(error?.funding).toBeUndefined();

    expect(error?.body.required_msats).toBe(PRICE_MSATS);
    expect(error?.body.received_msats).toBe(SHORT_MSATS);
    expect(error?.body.mints).toEqual([MINT]);

    expect(paidMsats).toBe(0);
  });

});

describe("explicit upfront short deposits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyCashuToken).mockReturnValue({
      mint: MINT,
      totalMsats: SHORT_MSATS,
      unit: "sat",
    });
  });

  it("runs the full-price draw when the existing balance covers the short deposit", async () => {
    const h = harness();
    await seedExplicitBalance(h, PRICE_MICRO - SHORT_MICRO);

    const result = await explicitShortUpfrontPay(h);

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(PRICE_MSATS);
    expect(result.creditId).toBe(EXPLICIT_CREDIT_ID);
    expect(result.drawId).toBe(EXPLICIT_DRAW_ID);
    expect(result.drawAmountMicro).toBe(PRICE_MICRO);
    expect(result.funding).toMatchObject({
      creditId: EXPLICIT_CREDIT_ID,
      fundingId: REQUEST_ID,
      paidMsats: SHORT_MSATS,
      grossPaidMsats: SHORT_MSATS + 1_000,
      cashuInputFeeMsats: 1_000,
      amountMicro: SHORT_MICRO,
      currency: "usd",
    });
    expect(h.deposits).toEqual([
      expect.objectContaining({
        paidMsats: SHORT_MSATS,
        grossPaidMsats: SHORT_MSATS + 1_000,
        cashuInputFeeMsats: 1_000,
        amountMicro: SHORT_MICRO,
      }),
    ]);

    const draw = await h.ledger.getDraw({
      creditId: EXPLICIT_CREDIT_ID,
      drawId: EXPLICIT_DRAW_ID,
    });
    expect(draw?.status).toBe("pending");
    expect(draw?.amountMicro).toBe(PRICE_MICRO);
    const credit = await h.ledger.get(EXPLICIT_CREDIT_ID);
    expect(credit?.balanceMicro).toBe(PRICE_MICRO);
    expect(credit?.availableMicro).toBe(0);
  });

  it("keeps the deposit and refuses only the uncovered draw", async () => {
    const h = harness();
    const earlierMicro = 50_000;
    await seedExplicitBalance(h, earlierMicro);

    const result = await explicitShortUpfrontPay(h);

    expect(result.paidMsats).toBe(0);
    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "insufficient_credit",
      remaining_micro: earlierMicro + SHORT_MICRO,
      balance_micro: earlierMicro + SHORT_MICRO,
      shortfall_micro: PRICE_MICRO - earlierMicro - SHORT_MICRO,
      credit_id: EXPLICIT_CREDIT_ID,
      credited_micro: SHORT_MICRO,
      credit_currency: "usd",
    });
    expect(result.error?.body.display).toContain("deposit was added");
    expect(result.error?.body.display).toContain("job did not run");
    expect(result.error?.body.hint).toContain("shortfall_micro");
    expect(result.error?.body.hint).toContain('op "drain"');
    expect(result.error?.funding).toMatchObject({
      creditId: EXPLICIT_CREDIT_ID,
      fundingId: REQUEST_ID,
      paidMsats: SHORT_MSATS,
      grossPaidMsats: SHORT_MSATS + 1_000,
      cashuInputFeeMsats: 1_000,
      amountMicro: SHORT_MICRO,
      currency: "usd",
    });
    expect(result.error?.forfeit).toBeUndefined();
    expect(
      await h.ledger.getDraw({
        creditId: EXPLICIT_CREDIT_ID,
        drawId: EXPLICIT_DRAW_ID,
      })
    ).toBeUndefined();
    const credit = await h.ledger.get(EXPLICIT_CREDIT_ID);
    expect(credit?.balanceMicro).toBe(earlierMicro + SHORT_MICRO);
    expect(credit?.availableMicro).toBe(earlierMicro + SHORT_MICRO);
    expect(credit?.lastLedgerSeq).toBe(0);
  });
});
