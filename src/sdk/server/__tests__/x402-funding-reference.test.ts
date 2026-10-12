import { beforeEach, describe, expect, it, vi } from "vitest";

import { msatsToUsdc } from "../../../lib/currency";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";

/**
 * An x402 settle that returns no transaction hash
 * leaves the ledger leg with nothing to key the processed-payment marker on.
 * Implicit N=1 degrades to legacy semantics (money is never refused for a rail
 * metadata gap), but an explicitly signed `fund` block is a commitment the
 * caller expects to be recorded — silently minting no credit would leave them
 * believing a credit exists. That case fails closed instead.
 */

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const REQUIRED_MSATS = 10_000;
const PRICE_FIAT = { currency: "usd", amountMicro: 10_000 };
const X402_HEADER = "base64_header";

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

  it("refuses an explicitly signed fund block — the funding cannot be recorded idempotently", async () => {
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
      creditEnvelope: {
        creditId: "c1",
        drawId: "d1",
        fund: {
          amountMicro: PRICE_FIAT.amountMicro,
          commitment: fundingCommitment(X402_HEADER),
        },
      },
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "payment_invalid",
      message: expect.stringContaining("no transaction reference") as string,
    });
    // Nothing was minted: the caller can see the funding did not land.
    expect(await ledger.get("c1")).toBeUndefined();
  });

  it("keeps legacy semantics for implicit N=1 — the payment is accepted, no credit minted", async () => {
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
    expect(result.creditId).toBeUndefined();
  });
});
