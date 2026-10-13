import { describe, expect, it, vi } from "vitest";

import { initLoggers } from "../../../observability/loggers";
import { SpanWriter } from "../../../observability/span-writer";
import type { SpanRow } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { createFxFetcher, type FxFetcher, warmFxSnapshot } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import type { BuildContextOpts } from "../context";
import { buildContext } from "../context";
import type { ServerJob } from "../job";

/**
 * `job.askedTopUpMicro` is the in-memory half of the ceiling
 * `growDraw` caps a mid-job top-up at. The durable half is `jobs.asked_topup_micro`,
 * accumulated by Tx A — the `appendOutgoing` that persists the `payment-request`
 * message — so the two only stay in step if this side accumulates on exactly the
 * asks that emit one. It is a running sum, not an assignment, so unlike the
 * neighbouring `pendingPayment*` writes it does not survive being re-walked.
 */
function blankJob(paidMsats = 0): ServerJob {
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
    paidMsats,
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
    lastActivityAt: 0
  };
}

/** Fixed-rate fx, so every ask's pinned micro figure is exact and stated. */
const fx: FxFetcher = {
  fetch: () =>
    Promise.resolve({
      rates: { usd: 100_000, eur: 80_000 },
      as_of: "2026-07-31T00:00:00Z"
    }),
  supportedCurrencies: () => ["usd", "eur"]
};

/** A draw pool that never covers, so no ask is auto-credited out from under the test. */
const emptyPool: NonNullable<BuildContextOpts["drawPool"]> = () =>
  Promise.resolve({ basis: "draw" as const, amountMicro: 0, currency: "usd" });

/** `{ amount, currency }` in the fiat form `ctx.requestPayment` accepts. */
function usd(amount: number): { amount: number; currency: "usd" } {
  return { amount, currency: "usd" };
}

/** Let the suspended `requestPayment` promise reach its yield. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("buildContext.requestPayment — cumulative ask total", () => {
  it("accumulates one ask per emitted payment-request", async () => {
    const job = blankJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      drawPool: emptyPool
    });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();
    expect(job.askedTopUpMicro).toBe(600_000);
    expect(job.askedTopUpCurrency).toBe("usd");

    // Second stage of the same job: the ceiling is the sum, not the latest ask.
    job.pendingPayment = null;
    void ctx.requestPayment(usd(0.4), "surcharge");
    await tick();
    expect(job.askedTopUpMicro).toBe(1_000_000);
  });

  it("converts a later ask in another currency into the job's denomination", async () => {
    // and the visible behaviour change: this used to poison the total
    // to `-1` and silently switch the ceiling off for the rest of the job. The
    // asks now sum, because every one of them is pinned in the job's own
    // denomination — €0.40 at €80k/BTC is 5000 sats, which is $0.50 at $100k.
    const job = blankJob();
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {}, fxFetcher: fx });

    void ctx.requestPayment(usd(0.6), "base");
    await tick();
    job.pendingPayment = null;
    void ctx.requestPayment({ amount: 0.4, currency: "eur" }, "surcharge");
    await tick();

    expect(job.askedTopUpMicro).toBe(1_100_000);
    expect(job.askedTopUpCurrency).toBe("usd");
    expect(job.topUpCapUnenforcedReason).toBeUndefined();
  });

  it("pins in the DVM's declared currency when the job holds no credit yet", async () => {
    // The free-then-paid shape. There is no pool to agree with, and the credit
    // this job's first payment opens will be denominated in the declaration —
    // so seeding from it is what stops the ask total and the credit disagreeing
    // the moment that credit exists.
    const job = blankJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      pricingCurrency: "eur"
    });

    void ctx.requestPayment(usd(0.5), "base");
    await tick();

    // $0.50 at $100k/BTC is 500 sats, which is €0.40 at €80k.
    expect(job.askedTopUpMicro).toBe(400_000);
    expect(job.askedTopUpCurrency).toBe("eur");
  });

  it("pins in the credit's currency on an implicit N=1 job, not the declaration", async () => {
    // `resolveDrawPool` answers `rail` for an implicit N=1 credit — the ordinary
    // per-job payment — so before the ask fell to a hardcoded `"usd"`
    // and the cap was unenforceable on essentially every job of a non-USD DVM.
    const job = blankJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      pricingCurrency: "usd",
      drawPool: () => Promise.resolve({ basis: "rail" as const, creditCurrency: "eur" })
    });

    void ctx.requestPayment(500_000, "base");
    await tick();

    // 500 sats at €80k/BTC.
    expect(job.askedTopUpMicro).toBe(400_000);
    expect(job.askedTopUpCurrency).toBe("eur");
  });

  it("keeps the job's own denomination when the DVM's declaration changes", async () => {
    // An operator flipping `DVMConfig.currency` redeploys, and every in-flight
    // job is reactivated on the new build. Reading the denomination back off the
    // job — where Tx A wrote it first-write-wins — is what keeps that from
    // poisoning the total of a job whose credit is still the old currency.
    const job = blankJob();
    job.askedTopUpMicro = 600_000;
    job.askedTopUpCurrency = "usd";
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      pricingCurrency: "eur"
    });

    void ctx.requestPayment(usd(0.4), "surcharge");
    await tick();

    expect(job.askedTopUpMicro).toBe(1_000_000);
    expect(job.askedTopUpCurrency).toBe("usd");
  });

  it("pins a sub-micro ask at one micro rather than poisoning the total", async () => {
    // Four tenths of a micro-unit. `resolvePriceFiat` refuses to denominate it,
    // which cost the job its whole ceiling; one micro is an upper bound on what
    // was asked, which is the only direction a ceiling may err in.
    const job = blankJob();
    const ctx = buildContext(job, { store: new MemoryKVStore(), env: {}, fxFetcher: fx });

    void ctx.requestPayment(usd(0.0000004), "dust");
    await tick();

    expect(job.askedTopUpMicro).toBe(1);
    expect(job.topUpCapUnenforcedReason).toBeUndefined();
  });

  it("records why the ceiling went away when the rate provider is down", async () => {
    // The one door left. The charge still goes out — it needs no rate to be
    // quoted or collected — but the job is now uncapped, and that has to be
    // findable by query rather than by log archaeology.
    const job = blankJob();
    const down: FxFetcher = {
      fetch: () => Promise.reject(new Error("fx down")),
      supportedCurrencies: () => ["usd"]
    };
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: down
    });

    void ctx.requestPayment(500_000, "base");
    await tick();

    expect(job.askedTopUpMicro).toBe(-1);
    expect(job.topUpCapUnenforcedReason).toBe("ask_unpriceable");
    expect(job.messages.filter((m) => m.type === "payment-request")).toHaveLength(1);

    // Sticky: a later ask the rate is back for does not restore the ceiling,
    // because the ask it is missing is still missing.
    job.pendingPayment = null;
    const back = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx
    });
    void back.requestPayment(usd(0.6), "surcharge");
    await tick();

    expect(job.askedTopUpMicro).toBe(-1);
    expect(job.topUpCapUnenforcedReason).toBe("ask_unpriceable");
  });

  it("pins a bare-msats ask off the last-known snapshot when the live fetch fails", async () => {
    // This leg is free on a fiat-form ask — the snapshot that sized
    // the msats is already in hand — so bare msats is the only shape where
    // pinning opens a failure door, and losing the pin costs the receipt its
    // whole `credit` block. `FxFetcher.lastKnown` exists as the payment rail's
    // offline degradation source; this leg used to ignore it.
    const job = blankJob();
    const warm: FxFetcher = {
      fetch: () => Promise.reject(new Error("coingecko 429")),
      supportedCurrencies: () => ["usd"],
      lastKnown: () => ({
        snapshot: { rates: { usd: 100_000 }, as_of: "2026-07-31T00:00:00Z" },
        cachedAt: 1_700_000_000_000
      })
    };
    const spans: SpanRow[] = [];
    initLoggers(new SpanWriter({ send: async () => {} }), "test");
    setEmitter((row) => spans.push(row));
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: warm
    });

    void ctx.requestPayment(500_000, "base");
    await tick();
    setEmitter(null);

    // 500k msats = 500 sats = $0.50 at $100k/BTC.
    expect(job.pendingPaymentFiatMicro).toBe(500_000);
    expect(job.pendingPaymentFiatCurrency).toBe("usd");
    expect(job.askedTopUpMicro).toBe(500_000);
    expect(job.topUpCapUnenforcedReason).toBeUndefined();
    expect(spans.map((row) => row.name)).toEqual(["dvm.ask_pin_stale_rate"]);
    expect(spans[0].attributes.rate_cached_at).toBeUndefined();
  });

  it("pins off the snapshot the boot warm-up left behind, having never served a quote", async () => {
    // and the case ladder could not reach: a free-to-submit
    // DVM. Nothing on its request path fetches a rate, so the ask-time pin is
    // the process's first fetch and `lastKnown()` is null exactly when the rung
    // is needed. `warmFxSnapshot` is what `host.serve()` calls at boot; this
    // fetcher then loses its source before the first ask, so the pin can only
    // land off what the warm-up cached.
    const job = blankJob();
    let live = true;
    const fetchFn = (): Promise<Response> =>
      live
        ? Promise.resolve(
            new Response(JSON.stringify({ bitcoin: { usd: 100_000 } }), {
              status: 200
            })
          )
        : Promise.reject(new Error("coingecko 429"));
    const booted = createFxFetcher({
      currencies: ["usd"],
      fetchFn: fetchFn as unknown as typeof fetch,
      // No cache window, so the ask below takes the live path and genuinely
      // degrades rather than being served a still-fresh entry.
      cacheTtlMs: 0,
      retries: 0,
      retryDelayMs: 0
    });

    expect(booted.lastKnown?.()).toBeNull();
    warmFxSnapshot(booted);
    await vi.waitFor(() => {
      expect(booted.lastKnown?.()).not.toBeNull();
    });
    live = false;

    const spans: SpanRow[] = [];
    initLoggers(new SpanWriter({ send: async () => {} }), "test");
    setEmitter((row) => spans.push(row));
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: booted
    });

    void ctx.requestPayment(500_000, "base");
    await tick();
    setEmitter(null);

    expect(job.pendingPaymentFiatMicro).toBe(500_000);
    expect(job.askedTopUpMicro).toBe(500_000);
    expect(job.topUpCapUnenforcedReason).toBeUndefined();
    expect(spans.map((row) => row.name)).toEqual(["dvm.ask_pin_stale_rate"]);
  });

  it("reports an ask pinned off a rate the source dropped and the fetcher carried", async () => {
    // The other degradation rung: the fetch landed, but this one
    // currency came from an earlier body. The pin is still made — that is the
    // whole point of carrying it forward — and the ask half of the ladder says
    // so, exactly as the verify half does with `credit_topup_stale_rate`.
    const job = blankJob();
    const narrowed: FxFetcher = {
      fetch: () =>
        Promise.resolve({
          rates: { usd: 100_000 },
          as_of: "2026-07-31T00:00:00Z",
          carried_forward: ["usd"]
        }),
      supportedCurrencies: () => ["usd"]
    };
    const spans: SpanRow[] = [];
    initLoggers(new SpanWriter({ send: async () => {} }), "test");
    setEmitter((row) => spans.push(row));
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: narrowed
    });

    void ctx.requestPayment(500_000, "base");
    await tick();
    setEmitter(null);

    expect(job.askedTopUpMicro).toBe(500_000);
    expect(spans.map((row) => row.name)).toEqual(["dvm.ask_pin_stale_rate"]);
    expect(spans[0].attributes.rate_carried_forward).toBe(true);
    expect(spans[0].attributes.rate_cached_at).toBeUndefined();
  });

  it("does not re-accumulate an ask the replay resolves from history", async () => {
    // The regression: a payment landing on a machine that isn't running the
    // handler reactivates the job, and the replay re-walks every ask already
    // paid. The durable column doesn't move — `providerMessage` is suppressed on
    // this branch, so Tx A never runs — so an accumulate above the bail would
    // leave the in-memory total at 2x what was asked. That phantom headroom is
    // exactly what lets the next ask's duplicate grow the draw.
    const job = blankJob(2_400_000);
    job.messages = [
      {
        seq: 1,
        type: "payment-request",
        from: "provider",
        content: {},
        timestamp: 0
      },
      {
        seq: 2,
        type: "payment",
        from: "requester",
        content: { amount_msats: 2_400_000 },
        timestamp: 0
      }
    ] as ServerJob["messages"];
    job.seq = 2;
    job.replayHighSeq = 2;
    // Tx C applied the cached payment before this reactivation.
    job.reactivationPaymentApplied = true;
    // Reactivation rebuilt this from the durable row, which Tx A already summed.
    job.askedTopUpMicro = 600_000;
    job.askedTopUpCurrency = "usd";

    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      drawPool: emptyPool
    });

    const replayed = await ctx.requestPayment(usd(0.6), "base");

    expect(replayed.amount_msats).toBe(2_400_000);
    expect(job.askedTopUpMicro).toBe(600_000);
    // The genuine next ask, past the exhausted replay, still accumulates once.
    void ctx.requestPayment(usd(0.4), "surcharge");
    await tick();
    expect(job.askedTopUpMicro).toBe(1_000_000);
  });

  it("does not accumulate an ask the upfront pool auto-credits", async () => {
    // No payment-request is emitted, so Tx A never runs and the durable total
    // stays put; an in-memory accumulate here would drift the two apart in the
    // direction that lets a top-up over-grow the draw.
    const job = blankJob();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      drawPool: () =>
        Promise.resolve({
          basis: "draw" as const,
          amountMicro: 1_000_000,
          currency: "usd"
        })
    });

    await ctx.requestPayment(usd(0.6), "base");

    expect(job.askedTopUpMicro).toBeUndefined();
    expect(job.messages).toHaveLength(0);
  });
});
