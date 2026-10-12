/* The non-identity ratio checks structured expected_micro. Pre-settlement refusals allow corrected payment;
 * post-settlement refusals must not tell the caller to submit the same money again. */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";

vi.mock("../../../lib/cashu/verify", () => ({
  verifyCashuToken: vi.fn(),
}));
vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { verifyCashuToken } = await import("../../../lib/cashu/verify");
const { verifyX402Payment } = await import("../../../lib/x402");
const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");
const { verifyUpfrontPayment } = await import("../payment");

const RATE = 100_000;
const DVM_ID = "dvm-fund-mismatch";
const CALLER = "aa".repeat(32);
const MINT = "https://mint.example";
const CASHU_TOKEN = "cashuAdeadbeef";
/** Undecodable on purpose — the header that reaches the post-settlement backstop. */
const X402_HEADER = "base64_header";

// 3174 fiat micro per 100000 msats deliberately makes fiat and rail units unequal.
const PRICE_MICRO = 3_174;
const PRICE_MSATS = 100_000;

const PAID_MSATS = 150_000;
const GROSS_MSATS = 151_000;
const INPUT_FEE_MSATS = GROSS_MSATS - PAID_MSATS;
const EXPECTED_MICRO = 4_761;
const CALLER_SIGNED_MICRO = 4_800;

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
  return { ledger: new MemoryCreditLedger(), processedPayments: new MemoryProcessedPaymentStore() };
}

// The accumulator DB is a sentinel: the pre-commit amount gate must not access it.
function cashuFundAndDraw(h: Harness, amountMicro: number) {
  return verifyUpfrontPayment({
    cashuToken: CASHU_TOKEN,
    requestId: "fund-amount-cashu",
    mints: [MINT],
    cashuMode: "p2pk-accumulator",
    accumulatorDb: {} as never,
    lockPubkeys: ["02" + "ab".repeat(32)] as never,
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: "job-1",
    creditEnvelope: {
      creditId: "c1",
      drawId: "d1",
      fund: { amountMicro, commitment: fundingCommitment(CASHU_TOKEN) },
    },
  });
}

// The header authorizes a 1.5x native overpayment, independently of the msat fallback.
const X402_DECODABLE_HEADER = encodePayment({
  x402Version: X402_V1_VERSION,
  scheme: "exact",
  network: X402.network,
  payload: {
    signature: "0x" + "cd".repeat(32),
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: X402.payTo,
      value: String(EXPECTED_MICRO),
      validAfter: "0",
      validBefore: "99999999999",
      nonce: "0x" + "ef".repeat(32),
    },
  },
});

function x402FundAndDraw(h: Harness, amountMicro: number, paymentHeader = X402_HEADER) {
  return verifyUpfrontPayment({
    x402Payment: paymentHeader,
    x402Config: X402,
    requiredMsats: PRICE_MSATS,
    fxFetcher: warmFetcher(),
    creditLedger: h.ledger,
    processedPayments: h.processedPayments,
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    callerPubkey: CALLER,
    dvmId: DVM_ID,
    jobId: "job-1",
    creditEnvelope: {
      creditId: "c1",
      drawId: "d1",
      fund: { amountMicro, commitment: fundingCommitment(paymentHeader) },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.mocked(verifyCashuToken).mockReturnValue({
    mint: MINT,
    totalMsats: PAID_MSATS,
    unit: "sat",
  });
  vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
    try {
      verifyCashuToken(opts.cashuToken, opts.mints);
    } catch (err) {
      return {
        kind: "rejected",
        code: "invalid_token",
        message: err instanceof Error ? err.message : "invalid token",
      };
    }
    const accepted = {
      grossMsats: GROSS_MSATS,
      inputFeeMsats: INPUT_FEE_MSATS,
      mintUrl: MINT,
      netMsats: PAID_MSATS,
      paidMsats: PAID_MSATS,
    };
    await opts.beforeCommit?.(accepted);
    await opts.withCommitTx?.({} as never, accepted);
    return { kind: "accumulated", ...accepted };
  });

  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: PAID_MSATS,
    amountUsdcMicro: EXPECTED_MICRO,
    txHash: "0xsettled",
    settleResponseHeader: "hdr",
  });
});

describe("cashu fund-and-draw — the pre-commit amount branch", () => {
  it("states the provider's valuation as expected_micro", async () => {
    const h = harness();
    const result = await cashuFundAndDraw(h, CALLER_SIGNED_MICRO);

    const body = result.error?.body;
    expect(result.error?.status).toBe(402);
    expect(body?.error).toBe("funding_commitment_mismatch");

    expect(body?.expected_micro).toBe(EXPECTED_MICRO);
    expect(await h.ledger.get("c1")).toBeUndefined();
    expect(await h.ledger.getDraw({ creditId: "c1", drawId: "d1" })).toBeUndefined();
    const hint = result.error?.body.hint as string;
    expect(hint).toContain(String(EXPECTED_MICRO));
    expect(hint).toContain("re-sign");

    expect(hint).toMatch(/nothing was captured/i);
  });

  it("passes the gate when the caller signed the pro-rata figure", async () => {
    const h = harness();
    const result = await cashuFundAndDraw(h, EXPECTED_MICRO);

    expect(result.error).toBeUndefined();
    expect(await h.ledger.get("c1")).toMatchObject({ balanceMicro: 4_761, availableMicro: 1_587 });
    expect(await h.ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({ status: "pending", amountMicro: 3_174 });
  });

  it("falls through a token it cannot decode, leaving the canonical code", async () => {
    const h = harness();
    vi.mocked(verifyCashuToken).mockImplementation(() => {
      throw new Error("undecodable");
    });

    const result = await cashuFundAndDraw(h, CALLER_SIGNED_MICRO);
    expect(result.error?.body.error).toBe("invalid_token");
  });
});

describe("x402 fund-and-draw — the pre-settle amount branch", () => {
  it("states the same valuation, from a local decode", async () => {
    const h = harness();
    const result = await x402FundAndDraw(h, CALLER_SIGNED_MICRO, X402_DECODABLE_HEADER);

    const body = result.error?.body;
    expect(body?.error).toBe("funding_commitment_mismatch");

    expect(body?.expected_micro).toBe(EXPECTED_MICRO);
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
    expect(await h.ledger.get("c1")).toBeUndefined();
    const hint = result.error?.body.hint as string;
    expect(hint).toContain(String(EXPECTED_MICRO));
    // Cashu re-signs a token; x402 re-attaches the header it already signed.
    // Neither rail may borrow the other's copy — "nothing was captured" is
    // false here, and "X-PAYMENT" is meaningless there.
    expect(hint).toMatch(/nothing was settled/i);
    expect(hint).toContain("X-PAYMENT");
  });

  it("passes the gate when the caller signed the pro-rata figure", async () => {
    const h = harness();
    const result = await x402FundAndDraw(h, EXPECTED_MICRO, X402_DECODABLE_HEADER);

    expect(result.error).toBeUndefined();
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalledTimes(1);
    expect(await h.ledger.get("c1")).toMatchObject({ balanceMicro: 4_761, availableMicro: 1_587 });
  });
});

describe("x402 fund-and-draw — the post-settlement backstop", () => {
  it("states expected_micro but never hints a re-present", async () => {
    const h = harness();
    const result = await x402FundAndDraw(h, CALLER_SIGNED_MICRO);

    const body = result.error?.body;
    expect(body?.error).toBe("funding_commitment_mismatch");
    expect(body?.expected_micro).toBe(EXPECTED_MICRO);

    expect(body?.hint).not.toMatch(/re-sign this same/i);
    expect(body?.hint).not.toMatch(/resubmit|re-attach/i);
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalledTimes(1);
    expect(await h.ledger.get("c1")).toBeUndefined();
  });

});

describe("the commitment-hash branch carries no figure", () => {
  it("omits expected_micro when the artifact doesn't hash to the commitment", async () => {
    const h = harness();
    const result = await verifyUpfrontPayment({
      cashuToken: CASHU_TOKEN,
      mints: [MINT],
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      lockPubkeys: ["02" + "ab".repeat(32)] as never,
      requiredMsats: PRICE_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: h.ledger,
      processedPayments: h.processedPayments,
      priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
      callerPubkey: CALLER,
      dvmId: DVM_ID,
      jobId: "job-1",
      creditEnvelope: {
        creditId: "c1",
        drawId: "d1",
        fund: {
          amountMicro: EXPECTED_MICRO,
          commitment: fundingCommitment("a-different-artifact"),
        },
      },
    });

    expect(result.error?.body.error).toBe("funding_commitment_mismatch");

    expect(result.error?.body.expected_micro).toBeUndefined();
  });
});
