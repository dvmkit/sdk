import { describe, expect, it } from "vitest";

import type { FxFetcher } from "../../pricing/index";
import { FxRateUnavailableError, UnsupportedCurrencyError } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { buildContext } from "../context";
import type { ServerJob } from "../job";

const FX_RATE_USD = 100_000;
const FX_RATE_EUR = 73_000;

// Pre-fund the upfront pool so `requestPayment` resolves via the auto-credit
// path instead of yielding for a real payment message — these tests
// exercise the fx-conversion arithmetic, not the yield path.
function fundedJob(): ServerJob {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 100_000_000_000,
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
  };
}

const multiFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({
      rates: {
        usd: FX_RATE_USD,
        eur: FX_RATE_EUR,
        gbp: 63_000,
        jpy: 12_000_000,
      },
      as_of: "2026-05-13T00:00:00Z",
    }),
  supportedCurrencies: () => ["usd", "eur", "gbp", "jpy"],
};

const usdOnlyFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({
      rates: { usd: FX_RATE_USD },
      as_of: "2026-05-13T00:00:00Z",
    }),
  supportedCurrencies: () => ["usd"],
};

/**
 * Let the yield path's microtask chain settle — fx fetch, fiat pin,
 * `providerMessage`. A counted number of `Promise.resolve()` ticks is exact
 * only for one arrangement of the awaits above the emit; drain instead, so a
 * change in that arrangement isn't reported as a missing payment-request.
 */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("buildContext.requestPayment — multi-currency", () => {
  it("EUR amount converts via fx.rates.eur against a multi-currency fetcher", async () => {
    const job = fundedJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: multiFx,
    });
    const result = await ctx.requestPayment({ amount: 1, currency: "eur" }, "test");
    // 1 EUR × 1e8 / 73_000 = 1369.86... sats → ceil 1370 → × 1000 msats
    expect(result.amount_msats).toBe(1370 * 1000);
  });

  it("USD amount still converts via fx.rates.usd against a multi-currency fetcher", async () => {
    const job = fundedJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: multiFx,
    });
    const result = await ctx.requestPayment({ amount: 0.005, currency: "usd" }, "test");
    // $0.005 × 1e8 / 100_000 = 5 sats → × 1000 msats
    expect(result.amount_msats).toBe(5 * 1000);
  });

  it("rejects EUR against a USD-only fetcher with UnsupportedCurrencyError whose set names usd", async () => {
    const job = fundedJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: usdOnlyFx,
    });
    try {
      await ctx.requestPayment({ amount: 1, currency: "eur" }, "test");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCurrencyError);
      expect((err as UnsupportedCurrencyError).supported).toEqual(["usd"]);
      expect((err as Error).message).toBe('fx fetcher supports [usd]; got "eur"');
    }
  });

  it("error message tracks the fetcher's actual supported set on a non-USD-only fetcher", async () => {
    const job = fundedJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: multiFx,
    });
    try {
      await ctx.requestPayment({ amount: 1, currency: "chf" }, "test");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCurrencyError);
      expect((err as Error).message).toBe('fx fetcher supports [usd,eur,gbp,jpy]; got "chf"');
    }
  });

  it("raises a retryable rate error for a currency the snapshot dropped", async () => {
    // The fetcher advertises `gbp`, so this is the rate source narrowing rather
    // than a builder naming a currency this DVM never quotes — and it reaches
    // the caller's agent on the retryable envelope instead of an
    // `unsupported_currency` that reads as a permanent config error.
    const narrowedFx: FxFetcher = {
      fetch: () =>
        Promise.resolve({
          rates: { usd: FX_RATE_USD },
          as_of: "2026-05-13T00:00:00Z",
          unavailable: ["gbp"],
        }),
      supportedCurrencies: () => ["usd", "gbp"],
    };
    const ctx = buildContext(fundedJob(), {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: narrowedFx,
    });
    const err = await ctx
      .requestPayment({ amount: 1, currency: "gbp" }, "test")
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FxRateUnavailableError);
    expect(err).not.toBeInstanceOf(UnsupportedCurrencyError);
  });

  it("attaches fiat_amount to the on-wire payment-request when the caller used the fiat envelope", async () => {
    // Unfunded job → requestPayment yields and emits a payment-request message
    // we can inspect on `job.messages`. We don't await the call because the
    // resolver suspends pending an inbound payment.
    const job = fundedJob();
    job.paidMsats = 0;
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: multiFx,
    });
    void ctx.requestPayment({ amount: 0.05, currency: "usd" }, "scrape https://example.com");
    await drain();
    const pr = job.messages.find((m) => m.type === "payment-request");
    expect(pr).toBeDefined();
    const content = pr?.content as { amount_msats: number; fiat_amount?: unknown };
    // $0.05 × 1e8 / $100,000/BTC = 50 sats → × 1000 = 50,000 msats
    expect(content.amount_msats).toBe(50 * 1000);
    expect(content.fiat_amount).toEqual({ amount: 0.05, currency: "usd" });
    expect(job.pendingPaymentFiatMicro).toBe(50_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
  });

  it("omits fiat_amount when the caller passed a sats-only amount", async () => {
    const job = fundedJob();
    job.paidMsats = 0;
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: multiFx,
    });
    void ctx.requestPayment(1234, "size surcharge");
    await drain();
    const pr = job.messages.find((m) => m.type === "payment-request");
    expect(pr).toBeDefined();
    const content = pr?.content as { amount_msats: number; fiat_amount?: unknown };
    expect(content.amount_msats).toBe(1234);
    expect(content.fiat_amount).toBeUndefined();
  });
});

// The accept side — `resolveTopUpLedgerContext` reading this pin off the job
// row — is covered in `credit-midjob-topup.test.ts`, which sets the fields
// directly. These pin them for real, through the ask.
describe("buildContext.requestPayment — pins the ask's fiat envelope", () => {
  async function ask(
    amount: number | { amount: number; currency: string },
    fx: FxFetcher = multiFx
  ): Promise<ServerJob> {
    const job = fundedJob();
    job.paidMsats = 0;
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {}, fxFetcher: fx });
    void ctx.requestPayment(amount as number, "test");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return job;
  }

  it("converts a non-USD ask into the credit's currency", async () => {
    // The ledger pin speaks the credit's denomination on every job, not just the
    // ones whose fiat pool happened to read — that is what makes the ceiling on
    // the job's draw growth enforceable. €1 at €73,000/BTC ceils to 1370 sats,
    // which is $1.37 at $100,000.
    const job = await ask({ amount: 1, currency: "eur" });
    expect(job.pendingPaymentFiatMicro).toBe(1_370_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
    const request = job.messages.find((message) => message.type === "payment-request");
    expect((request?.content as { fiat_amount?: unknown }).fiat_amount).toEqual({ amount: 1, currency: "eur" });
  });

  it("converts a bare-msats ask, the one form with no envelope of its own", async () => {
    // Numeric mid-job requestPayment remains supported and must pin fiat at ask
    // time rather than accept time.
    const job = await ask(50_000);
    // 50 sats × $100,000/BTC ÷ 1e8 = $0.05
    expect(job.pendingPaymentFiatMicro).toBe(50_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
  });

  it("still emits the ask when the rate provider is down", async () => {
    const downFx: FxFetcher = {
      fetch: () => Promise.reject(new Error("fx down")),
      supportedCurrencies: () => ["usd"],
    };
    const job = await ask(50_000, downFx);
    expect(job.pendingPaymentMsats).toBe(50_000);
    expect(job.pendingPaymentFiatMicro).toBeUndefined();
    expect(job.messages.find((m) => m.type === "payment-request")).toBeDefined();
  });
});
