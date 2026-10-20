/* Direct payment verification uses a mocked facilitator and real ledger allocation.
 * Funding is a deposit; this job earns only its draw, not the whole prepaid amount. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { msatsToUsdc } from "../../../lib/currency";
import { verifyFundingReceipt } from "../../../lib/receipt";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { CreditLedgerError } from "../credit-ledger";
import { drawSettlementRef, fundingCommitment, IMPLICIT_CREDIT_TTL_MS } from "../funding";
import { fundingReceiptFor } from "../funding-receipt";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import { ReceiptIssuer } from "../receipt-issuer";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const DVM_ID = "dvm-1";
const CALLER = "aa".repeat(32);

const PRICE_MICRO = 100_000;
const PRICE_MSATS = 100_000;
const FUNDED_MICRO = 20 * PRICE_MICRO;
const FUNDED_MSATS = 20 * PRICE_MSATS;
const FUNDED_USDC = msatsToUsdc(FUNDED_MSATS, RATE);
const TX_HASH = "0xfundingsettlement";
const X402_HEADER = "base64_header";

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

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
}

function harness(): Harness {
  return {
    ledger: new MemoryCreditLedger(),
    processedPayments: new MemoryProcessedPaymentStore(),
  };
}

function fundAndDraw(h: Harness, drawId: string) {
  return verifyUpfrontPayment({
    x402Payment: X402_HEADER,
    x402Config: X402,
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: `job-${drawId}`,
    creditEnvelope: {
      creditId: "c1",
      drawId,
      fund: { amountMicro: FUNDED_MICRO, commitment: fundingCommitment(X402_HEADER) },
    },
  });
}

function pureDraw(h: Harness, drawId: string) {
  return verifyUpfrontPayment({
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: `job-${drawId}`,
    creditEnvelope: { creditId: "c1", drawId },
  });
}

describe("fund and draw in one request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: FUNDED_MSATS,
      amountUsdcMicro: FUNDED_USDC,
      txHash: TX_HASH,
      settleResponseHeader: "hdr",
    });
  });

  it("books the draw's slice, not the whole funding", async () => {
    const h = harness();
    const result = await fundAndDraw(h, "d1");

    expect(result.error).toBeUndefined();
    expect(result.funding).toEqual({
      creditId: "c1",
      callerPubkey: CALLER,
      fundingId: TX_HASH,
      rail: "x402",
      paidMsats: FUNDED_MSATS,
      grossPaidMsats: undefined,
      cashuInputFeeMsats: undefined,
      nativeAmount: FUNDED_USDC,
      nativeAsset: "usdc",
      mint: undefined,
      amountMicro: FUNDED_MICRO,
      currency: "usd",
      fundedAt: expect.any(Number) as number,
      expiryMs: expect.any(Number) as number,
      instrument: "x402_exact",
      tempoSession: undefined,
      tempoChannel: undefined,
    });

    const snap = await h.ledger.get("c1");
    expect(snap?.balanceMicro).toBe(FUNDED_MICRO);
    expect(snap?.availableMicro).toBe(FUNDED_MICRO - PRICE_MICRO);

    expect(result.paidMsats).toBe(PRICE_MSATS);
    expect(result.nativeAmount).toBe(FUNDED_USDC / 20);
    expect(result.drawAmountMicro).toBe(PRICE_MICRO);
    expect(result.creditCurrency).toBe("usd");
    expect(result.creditId).toBe("c1");
    expect(result.drawId).toBe("d1");
    expect(result.fundingCredit).toMatchObject({
      availableMicro: FUNDED_MICRO,
      lastLedgerSeq: 0,
    });
    expect(result.fundingCredit?.availableMicro).not.toBe(
      (await h.ledger.get("c1"))?.availableMicro
    );
    const funding = await h.ledger.getFunding({ creditId: "c1", fundId: TX_HASH });
    if (!funding) throw new Error("funding row missing");
    const fundingReceipt = await fundingReceiptFor(
      h.ledger,
      new ReceiptIssuer({ secret: "55".repeat(32), dvm: "fund-draw", dvmId: DVM_ID }),
      funding
    );
    expect(fundingReceipt).toMatchObject({
      funded_micro: FUNDED_MICRO,
      balance_after_micro: FUNDED_MICRO,
      ledger_seq: 0,
    });
    expect(fundingReceipt && verifyFundingReceipt(fundingReceipt)).toBe(true);

    // Each draw needs a distinct settlement reference because funding backs multiple revenue events.
    expect(result.paymentTxHash).toBe(drawSettlementRef(DVM_ID, "c1", "d1"));
    expect(result.paymentTxHash).not.toBe(TX_HASH);
  });

  it("reports the deposit once — the credit's later draws carry none", async () => {
    const h = harness();
    await fundAndDraw(h, "d1");
    await h.ledger.settle({ creditId: "c1", drawId: "d1" });

    const second = await pureDraw(h, "d2");
    expect(second.error).toBeUndefined();

    expect(second.funding).toBeUndefined();
    expect(second.paidMsats).toBe(PRICE_MSATS);
    expect(second.nativeAmount).toBe(FUNDED_USDC / 20);
    expect(second.paymentTxHash).toBe(drawSettlementRef(DVM_ID, "c1", "d2"));
  });

  it("conserves the funding's rail value across the twenty jobs it bought", async () => {
    const h = harness();
    let msats = 0;
    let usdc = 0;

    const first = await fundAndDraw(h, "d0");
    await h.ledger.settle({ creditId: "c1", drawId: "d0" });
    msats += first.paidMsats;
    usdc += first.nativeAmount ?? 0;

    for (let i = 1; i < 20; i++) {
      const r = await pureDraw(h, `d${i}`);
      await h.ledger.settle({ creditId: "c1", drawId: `d${i}` });
      msats += r.paidMsats;
      usdc += r.nativeAmount ?? 0;
    }

    expect(msats).toBe(FUNDED_MSATS);
    expect(usdc).toBe(FUNDED_USDC);
    const snap = await h.ledger.get("c1");
    expect(snap?.balanceMicro).toBe(0);
  });

  it("refuses a fund-and-draw onto a credit opened on another rail, pre-payment", async () => {
    const h = harness();
    await h.ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: PRICE_MICRO,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "cashu", paidMsats: PRICE_MSATS },
    });

    const result = await fundAndDraw(h, "d1");

    expect(result.error?.body.error).toBe("payment_invalid");
    expect(result.error?.body.credit_rail).toBe("cashu");
    // `fund` would raise `rail_mismatch` anyway — from inside the transaction,
    // with the facilitator already settled and nothing to hand back.
    expect(vi.mocked(verifyX402Payment).mock.calls.length).toBe(0);
    expect((await h.ledger.get("c1"))?.balanceMicro).toBe(PRICE_MICRO);
  });

  it("reports a late binding mismatch as a paid terminal reconciliation", async () => {
    const h = harness();
    vi.spyOn(h.ledger, "fund").mockRejectedValueOnce(
      new CreditLedgerError(
        "rail_mismatch",
        "credit c1 belongs to a different funding instrument",
        {
          expectedRail: "tempo",
          expectedInstrument: "tempo_session",
          expectedChannelId: "0xtempo-channel",
        }
      )
    );

    const result = await fundAndDraw(h, "d-late-mismatch");

    expect(verifyX402Payment).toHaveBeenCalledOnce();
    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_session",
        credit_channel_id: "0xtempo-channel",
        retryable: false,
      },
    });
    expect(result.error?.body.display).toContain("payment went through");
    expect(result.error?.body.display).not.toContain("Nothing was charged");
    expect(result.error?.body.hint).toContain("Do not pay again");
  });

  it.each([
    { previousDays: 30, expectedDays: 90 },
    { previousDays: 180, expectedDays: 180 },
  ])("preserves a $previousDays-day credit until top-up and reports its $expectedDays-day expiry", async ({ previousDays, expectedDays }) => {
    const h = harness();
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await h.ledger.fund({
      creditId: "c1", callerPubkey: CALLER, currency: "usd", amountMicro: FUNDED_MICRO,
      expiryMs: now + previousDays * 86_400_000,
      basis: { rail: "x402", paidMsats: FUNDED_MSATS, nativeAmount: FUNDED_USDC, nativeAsset: "USDC" },
    });
    expect((await pureDraw(h, "old-draw")).error).toBeUndefined();
    expect((await h.ledger.get("c1"))?.expiryMs).toBe(now + previousDays * 86_400_000);

    const result = await fundAndDraw(h, "topup-draw");
    expect(result.error).toBeUndefined();
    expect(result.funding?.expiryMs).toBe(now + expectedDays * 86_400_000);
    expect((await h.ledger.get("c1"))?.expiryMs).toBe(now + expectedDays * 86_400_000);
  });

  it("leaves implicit N=1 carrying the rail's own values verbatim", async () => {
    const h = harness();
    const fundedAt = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fundedAt);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: PRICE_MSATS,
      amountUsdcMicro: msatsToUsdc(PRICE_MSATS, RATE),
      txHash: TX_HASH,
      settleResponseHeader: "hdr",
    });

    const result = await verifyUpfrontPayment({
      x402Payment: X402_HEADER,
      x402Config: X402,
      requiredMsats: PRICE_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: h.ledger,
      processedPayments: h.processedPayments,
      priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
      callerPubkey: CALLER,
      dvmId: DVM_ID,
      jobId: "job-implicit",
    });

    expect(result.paidMsats).toBe(PRICE_MSATS);
    expect(result.paymentTxHash).toBe(TX_HASH);
    expect(result.nativeAmount).toBe(msatsToUsdc(PRICE_MSATS, RATE));

    expect(result.funding?.amountMicro).toBe(PRICE_MICRO);
    expect(IMPLICIT_CREDIT_TTL_MS).toBe(7_776_000_000);
    expect(result.funding?.expiryMs).toBe(fundedAt + 7_776_000_000);
    expect((await h.ledger.get(result.funding!.creditId))?.expiryMs).toBe(fundedAt + 7_776_000_000);
  });
});
