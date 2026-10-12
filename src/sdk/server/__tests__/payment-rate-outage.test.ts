import { beforeEach, describe, expect, it, vi } from "vitest";

import { msatsToUsdc } from "../../../lib/currency";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { buildContext } from "../context";
import type { ServerJob } from "../job";
import type { MppxServer } from "../mpp-setup";
import { processIncomingPayment, verifyIncomingPayment, verifyUpfrontPayment } from "../payment";

/**
 * Cached FX survives a source outage; cold FX refuses with retryable 503. A later rate must not
 * change the already-advertised exact stablecoin credit.
 */

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const APPRECIATED_BTC_RATE = 200_000;
const REQUIRED_MSATS = 1000;
const USD_PRICE_MICRO = 25_000;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

/** Minimal mppx handle — `issueUpfrontChallenges` only reads `methods`/`issueChallenge`. */
function fakeMpp(): MppxServer {
  return {
    realm: "test.example",
    methods: [{ name: "tempo", intent: "charge" }],
    issueChallenge: vi.fn(() => Promise.resolve({ id: "ch_1" })),
    broadcastCredential: vi.fn(),
  } as unknown as MppxServer;
}

function fakeJob(): ServerJob {
  return {
    id: "job_1",
    status: "awaiting-input",
    paidMsats: 0,
    pendingPaymentMsats: REQUIRED_MSATS,
    receivedProofs: [],
    messages: [],
    listeners: new Set(),
    pendingPrompts: new Map(),
    pendingPayment: null,
    abort: new AbortController(),
    replayHighSeq: null,
    replayPaymentIndex: 0,
    replayProviderSkip: 0,
  } as unknown as ServerJob;
}

/**
 * A spy `FxFetcher` whose live `fetch()` always fails (the source is down),
 * degrading to whatever `lastKnown()` returns. `fetch`/`lastKnown` are `vi.fn`s
 * so a test can assert a rail never touched the rate at all.
 */
function downFetcher(lastKnown: { snapshot: FxRateSnapshot; cachedAt: number } | null): FxFetcher {
  return {
    fetch: vi.fn(() => Promise.reject(new Error("fx source returned HTTP 429"))),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => lastKnown),
  };
}

function snapshot(usd: number): FxRateSnapshot {
  return { rates: { usd } as FxRateSnapshot["rates"], as_of: new Date(0).toISOString() };
}

/** The source is down and this process has a snapshot from before it went down. */
function warmButDown(): FxFetcher {
  return downFetcher({ snapshot: snapshot(RATE), cachedAt: Date.now() - 3_600_000 });
}

/** A healthy source returning a newer BTC/USD rate than the advertised payment used. */
function liveFetcher(rate: number): FxFetcher {
  return {
    fetch: vi.fn(() => Promise.resolve(snapshot(rate))),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

/** The source is down and this process has never seen a snapshot (cold boot). */
function coldAndDown(): FxFetcher {
  return downFetcher(null);
}

describe("payment paths across rate refreshes and outages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: REQUIRED_MSATS,
      amountUsdcMicro: msatsToUsdc(REQUIRED_MSATS, RATE),
      txHash: "0xtx",
      settleResponseHeader: "hdr",
    });
  });

  it("advertises USD-priced x402 without consulting a down rate provider", async () => {
    const fx = coldAndDown();
    const result = await verifyUpfrontPayment({
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      priceFiat: { currency: "usd", amountMicro: USD_PRICE_MICRO },
      fxFetcher: fx,
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({ error: "payment_required" });
    expect(result.error?.x402Requirements).toHaveLength(1);
    expect(result.error?.x402Requirements?.[0]?.maxAmountRequired).toBe(
      String(USD_PRICE_MICRO)
    );
    expect(fx.fetch).not.toHaveBeenCalled();
    expect(fx.lastKnown).not.toHaveBeenCalled();
  });

  it("accepts USD-priced x402 without consulting a down rate provider", async () => {
    vi.mocked(verifyX402Payment).mockResolvedValueOnce({
      verified: true,
      amountMsats: 0,
      amountUsdcMicro: USD_PRICE_MICRO,
      txHash: "0xtx",
      settleResponseHeader: "hdr",
    });
    const fx = coldAndDown();
    const result = await verifyUpfrontPayment({
      x402Payment: "base64_header",
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      priceFiat: { currency: "usd", amountMicro: USD_PRICE_MICRO },
      fxFetcher: fx,
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(REQUIRED_MSATS);
    expect(verifyX402Payment).toHaveBeenCalledWith(
      "base64_header",
      X402,
      BigInt(USD_PRICE_MICRO),
      "/v1/job",
      0,
      { v1: true, v2: true }
    );
    expect(fx.fetch).not.toHaveBeenCalled();
    expect(fx.lastKnown).not.toHaveBeenCalled();
  });

  it("still requires a rate when a USD-priced x402 DVM also advertises MPP", async () => {
    const fx = coldAndDown();
    const result = await verifyUpfrontPayment({
      x402Payment: "base64_header",
      x402Config: X402,
      mpp: fakeMpp(),
      requiredMsats: REQUIRED_MSATS,
      priceFiat: { currency: "usd", amountMicro: USD_PRICE_MICRO },
      fxFetcher: fx,
    });

    expect(result.error?.status).toBe(503);
    expect(result.error?.body).toMatchObject({ error: "fx_rate_unavailable" });
    expect(fx.fetch).toHaveBeenCalledOnce();
    expect(fx.lastKnown).toHaveBeenCalled();
    expect(verifyX402Payment).not.toHaveBeenCalled();
  });

  it("refuses an upfront mpp credential with the same typed 503 on a cold host", async () => {
    const result = await verifyUpfrontPayment({
      mppCredential: { challenge: { id: "ch_1", method: "tempo" } } as never,
      mpp: fakeMpp(),
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: coldAndDown(),
    });

    expect(result.error?.status).toBe(503);
    expect(result.error?.body).toMatchObject({ error: "fx_rate_unavailable" });
  });

  it("never asks for a rate at all on a Cashu-only DVM", async () => {
    // The default first-party config: sats end to end, no x402, no mppx. Nothing
    // on this path converts, so the fx source must not be on the payment hot
    // path — during an outage that would be a retry-budget stall per priced
    // request on the one rail that is structurally immune to it.
    const fetch = vi.fn(() => Promise.reject(new Error("fx source returned HTTP 429")));
    const lastKnown = vi.fn(() => ({ snapshot: snapshot(RATE), cachedAt: Date.now() - 3_600_000 }));
    const fx: FxFetcher = { fetch, supportedCurrencies: () => ["usd"], lastKnown };

    const result = await verifyUpfrontPayment({
      requiredMsats: REQUIRED_MSATS,
      mints: ["https://mint.test"],
      fxFetcher: fx,
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({ error: "payment_required" });
    expect(fetch).not.toHaveBeenCalled();
    expect(lastKnown).not.toHaveBeenCalled();
  });

  it("still hands an unpaid caller a payable Cashu 402 when non-USD pricing gates x402", async () => {
    // Cashu is quoted in sats and needs no rate. A non-USD DVM must omit x402
    // without taking down the rail that remains payable.
    const result = await verifyUpfrontPayment({
      requiredMsats: REQUIRED_MSATS,
      mints: ["https://mint.test"],
      x402Config: X402,
      fxFetcher: coldAndDown(),
      priceFiat: { currency: "eur", amountMicro: 25_000 },
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "payment_required",
      required_msats: REQUIRED_MSATS,
      mints: ["https://mint.test"],
    });
    // The x402 `accepts` block is absent because this DVM is not USD-priced.
    expect(result.error?.x402Requirements).toBeUndefined();
  });

  it("does not advertise x402 when a non-USD DVM has no other rail", async () => {
    const result = await verifyUpfrontPayment({
      requiredMsats: REQUIRED_MSATS,
      x402Config: X402,
      fxFetcher: coldAndDown(),
      priceFiat: { currency: "eur", amountMicro: 25_000 },
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({ error: "payment_required" });
    expect(result.error?.x402Requirements).toBeUndefined();
    expect(verifyX402Payment).not.toHaveBeenCalled();
  });

  it("credits a mid-job x402 payment off the last-known rate when the provider 429s", async () => {
    const job = fakeJob();
    job.pendingX402AmountUsdcMicro = "1050";

    const err = await processIncomingPayment(
      job,
      { type: "payment", content: { x402_payment: "base64_header" } },
      { x402Config: X402, fxFetcher: warmButDown() }
    );

    expect(err).toBeNull();
    expect(job.paidMsats).toBe(REQUIRED_MSATS);
    expect(job.status).toBe("processing");
    expect(verifyX402Payment).toHaveBeenCalledWith(
      "base64_header",
      X402,
      1050n,
      "/v1/job",
      RATE,
      undefined
    );
    expect(job.pendingX402AmountUsdcMicro).toBeUndefined();
  });

  it("resumes after BTC appreciation makes the settled USDC convert to fewer msats", async () => {
    vi.mocked(verifyX402Payment).mockResolvedValueOnce({
      verified: true,
      amountMsats: 525,
      amountUsdcMicro: 1050,
      txHash: "0xtx",
      settleResponseHeader: "hdr",
    });
    const job = fakeJob();
    job.pendingX402AmountUsdcMicro = "1050";

    const err = await processIncomingPayment(
      job,
      { type: "payment", content: { x402_payment: "base64_header" } },
      { x402Config: X402, fxFetcher: liveFetcher(APPRECIATED_BTC_RATE) }
    );

    expect(err).toBeNull();
    expect(job.paidMsats).toBe(REQUIRED_MSATS);
    expect(job.nativeAmount).toBe(1050);
    expect(job.pendingPaymentMsats).toBeUndefined();
    expect(job.status).toBe("processing");
    expect(verifyX402Payment).toHaveBeenCalledWith(
      "base64_header",
      X402,
      1050n,
      "/v1/job",
      APPRECIATED_BTC_RATE,
      undefined
    );
  });

  it("uses the persisted advertised amount in the cross-machine verification path", async () => {
    vi.mocked(verifyX402Payment).mockResolvedValueOnce({
      verified: true,
      amountMsats: 525,
      amountUsdcMicro: 1050,
      txHash: "0xtx",
      settleResponseHeader: "hdr",
    });
    const result = await verifyIncomingPayment(
      { type: "payment", content: { x402_payment: "base64_header" } },
      { x402Config: X402, fxFetcher: liveFetcher(APPRECIATED_BTC_RATE) },
      {
        pendingPaymentMsats: REQUIRED_MSATS,
        pendingX402AmountUsdcMicro: "1050",
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.verified?.paidMsats).toBe(REQUIRED_MSATS);
    expect(result.verified?.nativeAmount).toBe(1050);
    expect(verifyX402Payment).toHaveBeenCalledWith(
      "base64_header",
      X402,
      1050n,
      "/v1/job",
      APPRECIATED_BTC_RATE,
      undefined
    );
  });

  it("refuses a mid-job x402 payment with the typed 503 on a cold host", async () => {
    const job = fakeJob();

    const err = await processIncomingPayment(
      job,
      { type: "payment", content: { x402_payment: "base64_header" } },
      { x402Config: X402, fxFetcher: coldAndDown() }
    );

    expect(err?.status).toBe(503);
    expect(err?.body).toMatchObject({ error: "fx_rate_unavailable" });
    expect(job.paidMsats).toBe(0);
    expect(verifyX402Payment).not.toHaveBeenCalled();
  });

  it("raises the typed error out of ctx.requestPayment rather than a bare CoinGecko string", async () => {
    // A mid-job charge on a cold host: the handler's `requestPayment` needs a
    // rate to price its mppx challenge. It fails — but with something a DVM can
    // catch and an agent can relay, not `Error: coingecko returned HTTP 429`.
    const job = fakeJob();
    job.status = "processing";
    job.pendingPaymentMsats = undefined;

    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      paymentMethods: ["tempo"],
      mpp: fakeMpp(),
      fxFetcher: coldAndDown(),
    });

    const err = await ctx.requestPayment(REQUIRED_MSATS, "transcription").catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: "fx_rate_unavailable",
      display: expect.stringContaining("nothing was charged") as string,
    });
  });
});
