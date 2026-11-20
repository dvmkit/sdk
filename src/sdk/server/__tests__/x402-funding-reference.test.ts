import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { msatsToUsdc } from "../../../lib/currency";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { creditDepositPayload, verifyUpfrontPayment } from "../payment";
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
const NONCE = `0x${"cd".repeat(32)}`;
const FROM = `0x${"ab".repeat(20)}`;
const CALLER = "aa".repeat(32);
const DVM_ID = "dvm-1";
const LEGACY_ID = `eip3009:${FROM}:${NONCE}`;
// Digest of the normalized legacy identity, computed independently.
const AUTHORIZATION_ID = "eip3009:sha256:4c71c1dccd5fff3d021b506b75057c7e9b68838c55a71b70716be79f93faf7d4";

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

function paymentHeader(from = FROM, nonce = NONCE): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: "0xdeadbeef",
      authorization: { from, to: X402.payTo, value: "10000",
        validAfter: "0", validBefore: "9999999999", nonce },
    },
  });
}

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
    const pay = (header: string, drawId = "d1") => verifyUpfrontPayment({
      x402Payment: header,
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments,
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
      creditEnvelope: {
        creditId: "c1",
        drawId,
        fund: {
          amountMicro: PRICE_FIAT.amountMicro,
          commitment: fundingCommitment(header),
        },
      },
    });

    const result = await pay(paymentHeader(`0x${"Ab".repeat(20)}`, `0x${"Cd".repeat(32)}`));
    expect(result.error).toBeUndefined();
    expect(result.funding?.fundingId).toBe(AUTHORIZATION_ID);
    expect(await ledger.getFunding({ creditId: "c1", fundId: AUTHORIZATION_ID }))
      .toMatchObject({ amountMicro: PRICE_FIAT.amountMicro });
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({ status: "pending" });
    // A differently cased presentation of the authorization still collides.
    expect((await pay(paymentHeader(), "d2")).error).toMatchObject({
      status: 409, replayPaymentId: AUTHORIZATION_ID,
    });
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d2" })).toBeUndefined();
    expect((await ledger.get("c1"))?.balanceMicro).toBe(PRICE_FIAT.amountMicro);
  });

  it("keys an implicit N=1 funding on the authorization", async () => {
    const ledger = new MemoryCreditLedger();
    const result = await verifyUpfrontPayment({
      x402Payment: paymentHeader(),
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(REQUIRED_MSATS);
    expect(result.creditId).toBe(`imp:x402:${AUTHORIZATION_ID}`);
    expect(result.upfrontPayment?.draw_id).toBe(AUTHORIZATION_ID);
    expect(creditDepositPayload(DVM_ID, result.funding!)).toMatchObject({
      fundingId: AUTHORIZATION_ID,
      creditId: `imp:x402:${AUTHORIZATION_ID}`,
    });
    expect(await ledger.getDraw({ creditId: `imp:x402:${AUTHORIZATION_ID}`, drawId: AUTHORIZATION_ID }))
      .toMatchObject({ status: "pending", amountMicro: PRICE_FIAT.amountMicro });
  });

  it.each([true, false])("refuses a legacy funding replay before opening a second credit or draw (marker store: %s)", async (withMarkers) => {
    const ledger = new MemoryCreditLedger();
    const processedPayments = withMarkers ? new MemoryProcessedPaymentStore() : undefined;
    const creditId = `imp:x402:${LEGACY_ID}`;
    await ledger.fund({
      creditId, callerPubkey: CALLER, currency: "usd", amountMicro: PRICE_FIAT.amountMicro,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "x402", paidMsats: REQUIRED_MSATS, fundingRef: LEGACY_ID },
    });
    await ledger.draw({ creditId, drawId: LEGACY_ID, amountMicro: PRICE_FIAT.amountMicro });
    await processedPayments?.record({ dvmId: DVM_ID, rail: "x402", paymentId: LEGACY_ID, creditId, drawId: LEGACY_ID });

    const replay = await verifyUpfrontPayment({
      x402Payment: paymentHeader(),
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments,
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
      dvmId: DVM_ID,
    });

    expect(replay.error).toMatchObject({ status: 409, replayPaymentId: AUTHORIZATION_ID });
    expect(JSON.stringify(replay.error)).not.toContain(FROM);
    expect(replay.funding).toBeUndefined();
    expect(await processedPayments?.get({ dvmId: DVM_ID, rail: "x402", paymentId: AUTHORIZATION_ID })).toBeUndefined();
    expect(await ledger.get(`imp:x402:${AUTHORIZATION_ID}`)).toBeUndefined();
    expect(await ledger.listPendingDraws(creditId)).toHaveLength(1);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(PRICE_FIAT.amountMicro);
  });

  it("recovers the original job under a historical payment reference", async () => {
    const onJob = vi.fn((ctx: { complete(message: string): void }) => ctx.complete("done"));
    const ledger = new MemoryCreditLedger();
    const server = await createDVMServer(configureDVM({
      name: "x402-funding-replay",
      capabilities: { run: { input: z.object({ input: z.string() }), price: "$0.01", onJob } },
    }), {
      env: {}, devMode: true, store: new MemoryKVStore(), jobStore: new MemoryJobStore(),
      dvmId: DVM_ID, x402: X402, fxFetcher: warmFetcher(), creditLedger: ledger,
    });
    const submit = (input: string) => server.app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
      body: JSON.stringify({ capability: "run", data: { input } }),
    });
    try {
      // Seed the marker, draw and job with the identifiers a historical recovery could have persisted.
      vi.mocked(verifyX402Payment).mockResolvedValueOnce({
        verified: true, amountMsats: REQUIRED_MSATS, amountUsdcMicro: PRICE_FIAT.amountMicro,
        txHash: LEGACY_ID, settleResponseHeader: "hdr",
      });
      const original = await submit("original");
      const identity = await original.json();
      expect(original.status).toBe(200);
      expect(identity).toHaveProperty("job_id");

      const replay = await submit("original");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ job_id: identity.job_id });
      const mismatch = await submit("different");
      expect(mismatch.status).toBe(409);
      expect(await mismatch.text()).not.toContain(FROM);
      expect(onJob).toHaveBeenCalledTimes(1);
      expect(await ledger.get(`imp:x402:${AUTHORIZATION_ID}`)).toBeUndefined();
    } finally {
      await server.shutdown();
    }
  });
});
