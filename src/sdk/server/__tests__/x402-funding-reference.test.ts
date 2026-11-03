import { beforeEach, describe, expect, it, vi } from "vitest";

import { msatsToUsdc } from "../../../lib/currency";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";

/**
 * An x402 settle that returns no transaction hash still moved money, so the
 * ledger leg keys its marker and funding on the EIP-3009 authorization, which
 * is single-use on chain. Neither an implicit N=1 payment nor an explicitly
 * signed `fund` block is accepted without a ledger row.
 */

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const REQUIRED_MSATS = 10_000;
const PRICE_FIAT = { currency: "usd", amountMicro: 10_000 };
const NONCE = `0x${"12".repeat(32)}`;
const FROM = "0x2222222222222222222222222222222222222222";
const X402_HEADER = encodePayment({
  x402Version: 1,
  scheme: "exact",
  network: "eip155:8453",
  payload: {
    signature: "0xdeadbeef",
    authorization: { from: FROM, to: "0x1111111111111111111111111111111111111111", value: "10000",
      validAfter: "0", validBefore: "9999999999", nonce: NONCE },
  },
});
const AUTHORIZATION_ID = `eip3009:${FROM}:${NONCE}`;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

function snapshot(usd: number): FxRateSnapshot {
  return { rates: { usd } as FxRateSnapshot["rates"], as_of: new Date(0).toISOString() };
}

function warmFetcher(): FxFetcher {
  return {
    fetch: vi.fn(() => Promise.resolve(snapshot(RATE))),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

describe("x402 settle without a transaction reference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: REQUIRED_MSATS,
      amountUsdcMicro: msatsToUsdc(REQUIRED_MSATS, RATE),
      txHash: undefined,
      settleResponseHeader: "hdr",
    });
  });

  it("records an explicitly signed fund block under the authorization", async () => {
    const ledger = new MemoryCreditLedger();
    const processedPayments = new MemoryProcessedPaymentStore();
    const pay = () => verifyUpfrontPayment({
      x402Payment: X402_HEADER,
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments,
      priceFiat: PRICE_FIAT,
      callerPubkey: "aa".repeat(32),
      creditEnvelope: {
        creditId: "c1",
        drawId: "d1",
        fund: {
          amountMicro: PRICE_FIAT.amountMicro,
          commitment: fundingCommitment(X402_HEADER),
        },
      },
    });

    const result = await pay();
    expect(result.error).toBeUndefined();
    expect(await ledger.getFunding({ creditId: "c1", fundId: AUTHORIZATION_ID }))
      .toMatchObject({ amountMicro: PRICE_FIAT.amountMicro });
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({ status: "pending" });
    // The authorization keys the marker too: presenting it again funds nothing more.
    await pay();
    expect((await ledger.get("c1"))?.balanceMicro).toBe(PRICE_FIAT.amountMicro);
  });

  it("keys an implicit N=1 funding on the authorization", async () => {
    const ledger = new MemoryCreditLedger();
    const result = await verifyUpfrontPayment({
      x402Payment: X402_HEADER,
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      priceFiat: PRICE_FIAT,
      callerPubkey: "aa".repeat(32),
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(REQUIRED_MSATS);
    expect(result.creditId).toBe(`imp:x402:${AUTHORIZATION_ID}`);
    expect(await ledger.getDraw({ creditId: `imp:x402:${AUTHORIZATION_ID}`, drawId: AUTHORIZATION_ID }))
      .toMatchObject({ status: "pending", amountMicro: PRICE_FIAT.amountMicro });
  });
});
