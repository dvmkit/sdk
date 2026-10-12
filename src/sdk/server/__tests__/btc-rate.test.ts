import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  CreateFxFetcherOpts,
  FxFetcher,
  FxRateSnapshot,
  FxRateUnavailableError,
} from "../../pricing/fx";
import type { ServerBtcRate } from "../btc-rate";

/**
 * The server-side twin of `src/lib/__tests__/btc-rate.test.ts`.
 * `resolveServerBtcUsdRate` resolves BTC/USD through the host's `FxFetcher` —
 * the same fetcher the quote path uses — so these tests inject a
 * fetcher rather than driving `src/lib/currency.ts`, which the resolver no
 * longer reaches. Live-path cases use a real `createFxFetcher` (its last-known
 * snapshot is populated by a successful fetch, exactly as in production); the
 * degradation cases inject a spy fetcher so `fetch()` failure and the
 * TTL-ignoring `lastKnown()` snapshot are controlled directly.
 *
 * A fresh module graph per test resets the resolver's `cooldownUntil` /
 * `staleEpisode` latches. `FxRateUnavailableError` is re-imported from the same
 * graph — `resetModules` gives it a new class identity, so a statically
 * imported one would fail every `toBeInstanceOf`.
 */
async function loadResolver(): Promise<{
  resolveServerBtcUsdRate: (fetcher?: FxFetcher) => Promise<ServerBtcRate>;
  rateUnavailablePaymentError: () => {
    body: Record<string, unknown>;
    status: number;
  };
  STALE_RATE_COOLDOWN_MS: number;
  createFxFetcher: (opts?: CreateFxFetcherOpts) => FxFetcher;
  FxRateUnavailableErrorClass: typeof FxRateUnavailableError;
}> {
  vi.resetModules();
  const mod = await import("../btc-rate");
  const pricing = await import("../../pricing/fx");
  return {
    resolveServerBtcUsdRate: mod.resolveServerBtcUsdRate,
    rateUnavailablePaymentError: mod.rateUnavailablePaymentError,
    STALE_RATE_COOLDOWN_MS: mod.STALE_RATE_COOLDOWN_MS,
    createFxFetcher: pricing.createFxFetcher,
    FxRateUnavailableErrorClass: pricing.FxRateUnavailableError
  };
}

/** A CoinGecko-shaped `fetch` for the live path (`createFxFetcher` parses `{ bitcoin: { usd } }`). */
const coingeckoOk = (btc: number): typeof fetch =>
  vi.fn(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ bitcoin: { usd: btc } })
    })
  ) as unknown as typeof fetch;

function snapshot(usd: number): FxRateSnapshot {
  return { rates: { usd } as FxRateSnapshot["rates"], as_of: new Date(0).toISOString() };
}

/**
 * A spy fetcher whose live `fetch()` is scriptable and whose `lastKnown()`
 * returns a fixed snapshot (or `null` for a cold process). The resolver reads
 * `lastKnown()` — ignoring freshness TTL — as its offline degradation source.
 */
function spyFetcher(opts: {
  fetch: () => Promise<FxRateSnapshot>;
  lastKnown: { snapshot: FxRateSnapshot; cachedAt: number } | null;
}): FxFetcher {
  return {
    fetch: vi.fn(opts.fetch),
    supportedCurrencies: () => ["usd"],
    lastKnown: () => opts.lastKnown
  };
}

const THREE_HOURS_MS = 3 * 60 * 60 * 1000;

describe("resolveServerBtcUsdRate", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("returns the live rate, not stale, when the source answers", async () => {
    const { resolveServerBtcUsdRate, createFxFetcher } = await loadResolver();
    const fx = createFxFetcher({ fetchFn: coingeckoOk(68_000), currencies: ["usd"] });

    await expect(resolveServerBtcUsdRate(fx)).resolves.toEqual({ rate: 68_000, stale: false });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("keeps pricing off the last snapshot the fetcher saw when the source starts failing", async () => {
    // The blast radius the last-known snapshot exists to absorb: a DVM that
    // booted fine, then the source fails mid-life. Its next priced request must
    // not fail.
    const { resolveServerBtcUsdRate, createFxFetcher } = await loadResolver();
    let respondOk = true;
    const fetchFn = vi.fn(() =>
      respondOk
        ? Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ bitcoin: { usd: 68_000 } })
          })
        : Promise.resolve({
            ok: false,
            status: 429,
            json: () => Promise.resolve({})
          })
    ) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      currencies: ["usd"],
      now: () => Date.now()
    });

    await resolveServerBtcUsdRate(fx); // warms the fetcher's last-known snapshot

    respondOk = false;
    vi.setSystemTime(Date.now() + THREE_HOURS_MS); // past the fetcher's 5-min fresh window

    const resolved = await resolveServerBtcUsdRate(fx);
    expect(resolved.rate).toBe(68_000);
    expect(resolved.stale).toBe(true);
    vi.useRealTimers();
  });

  it("serves the cached snapshot through a cool-down rather than re-probing a source that just failed", async () => {
    // Without a cool-down every priced request past the fetcher's fresh window
    // re-attempts the live fetch and eats the full retry budget before falling
    // back — against a source already failing us.
    const { resolveServerBtcUsdRate, STALE_RATE_COOLDOWN_MS } = await loadResolver();
    let recovered = false;
    const fetchSpy = vi.fn(() =>
      recovered ? Promise.resolve(snapshot(71_000)) : Promise.reject(new Error("fx source down"))
    );
    const fx = spyFetcher({
      fetch: fetchSpy,
      lastKnown: {
        snapshot: snapshot(70_000),
        cachedAt: Date.now() - THREE_HOURS_MS
      }
    });

    const first = await resolveServerBtcUsdRate(fx);
    const second = await resolveServerBtcUsdRate(fx);
    const third = await resolveServerBtcUsdRate(fx);

    expect([first, second, third].map((r) => r.rate)).toEqual([70_000, 70_000, 70_000]);
    expect([first, second, third].every((r) => r.stale)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The cool-down bounds the recovery lag: once it lapses, the next request
    // probes again and a recovered source takes the host straight back live.
    vi.setSystemTime(Date.now() + STALE_RATE_COOLDOWN_MS + 1000);
    recovered = true;

    await expect(resolveServerBtcUsdRate(fx)).resolves.toEqual({
      rate: 71_000,
      stale: false
    });
    vi.useRealTimers();
  });

  it("warns once per stale episode, and again after the source recovers and re-fails", async () => {
    const { resolveServerBtcUsdRate, STALE_RATE_COOLDOWN_MS } = await loadResolver();
    let recovered = false;
    const fx = spyFetcher({
      fetch: () => (recovered ? Promise.resolve(snapshot(71_000)) : Promise.reject(new Error("fx source down"))),
      lastKnown: {
        snapshot: snapshot(70_000),
        cachedAt: Date.now() - THREE_HOURS_MS
      }
    });

    await resolveServerBtcUsdRate(fx);
    await resolveServerBtcUsdRate(fx);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toBe(
      '{"event":"btc_rate_stale_fallback","level":"warn"}'
    );

    // Source recovers, then fails again. Unlike the CLI's once-per-process
    // latch, a host that runs for weeks should say so on a *new* outage.
    vi.setSystemTime(Date.now() + STALE_RATE_COOLDOWN_MS + 1000);
    recovered = true;
    await resolveServerBtcUsdRate(fx);
    recovered = false;
    vi.setSystemTime(Date.now() + THREE_HOURS_MS);
    await resolveServerBtcUsdRate(fx);

    expect(console.warn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("raises a typed, relayable fx_rate_unavailable on a cold process with a down source", async () => {
    const { resolveServerBtcUsdRate, FxRateUnavailableErrorClass } = await loadResolver();
    const fx = spyFetcher({
      fetch: () => Promise.reject(new Error("fx source down")),
      lastKnown: null
    });

    const err = await resolveServerBtcUsdRate(fx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FxRateUnavailableErrorClass);
    const fxErr = err as FxRateUnavailableError;
    // Same code the quote path already returns, so an agent has one retry rule.
    expect(fxErr.code).toBe("fx_rate_unavailable");
    expect(fxErr.display).toContain("nothing was charged");
    expect(fxErr.hint).toContain("Retry");
  });

  it("refuses rather than pricing off a poisoned zero rate", async () => {
    // A `0` here would price a paid request at nothing — give the work away
    // rather than fail it. Refuse instead.
    const { resolveServerBtcUsdRate } = await loadResolver();
    const fx = spyFetcher({
      fetch: () => Promise.reject(new Error("fx source down")),
      lastKnown: {
        snapshot: snapshot(0),
        cachedAt: Date.now() - THREE_HOURS_MS
      }
    });

    await expect(resolveServerBtcUsdRate(fx)).rejects.toMatchObject({
      code: "fx_rate_unavailable"
    });
  });

  it("refuses a platform known-stale refusal even with a usable last-known snapshot", async () => {
    // The whole point: a long-lived DVM that cached a good rate must NOT price
    // off it once the platform explicitly refuses the snapshot as ≥5d stale —
    // that would defeat the platform's refusal. Fail closed instead of degrading.
    const { resolveServerBtcUsdRate, FxRateUnavailableErrorClass } = await loadResolver();
    const fetchSpy = vi.fn(() =>
      Promise.reject(
        new FxRateUnavailableErrorClass("stale", undefined, {
          staleDays: 6,
          staleSource: "coingecko",
          thresholdDays: 5
        })
      )
    );
    const fx = spyFetcher({
      fetch: fetchSpy,
      lastKnown: {
        snapshot: snapshot(70_000),
        cachedAt: Date.now() - THREE_HOURS_MS
      }
    });

    const err = await resolveServerBtcUsdRate(fx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FxRateUnavailableErrorClass);
    const fxErr = err as FxRateUnavailableError;
    expect(fxErr.code).toBe("fx_rate_unavailable");
    expect(fxErr.knownStale?.staleDays).toBe(6);
    // Copy names staleness, not unreachability — the DVM *has* a cached rate.
    expect(fxErr.display).toContain("stale");
    expect(fxErr.display).toContain("nothing was charged");
    expect(fxErr.hint).toContain("6 days stale");
  });

  it("still degrades to last-known on a transient blip that carries no knownStale (preserved)", async () => {
    // Same usable snapshot as the refusal case above; the only difference is the
    // error is a plain unreachability, so degradation must still happen.
    const { resolveServerBtcUsdRate } = await loadResolver();
    const fx = spyFetcher({
      fetch: () => Promise.reject(new Error("connection reset")),
      lastKnown: {
        snapshot: snapshot(70_000),
        cachedAt: Date.now() - THREE_HOURS_MS
      }
    });

    await expect(resolveServerBtcUsdRate(fx)).resolves.toEqual({
      rate: 70_000,
      stale: true,
      cachedAt: expect.any(Number) as number
    });
  });
});

describe("rateUnavailablePaymentError", () => {
  it("is a 503 an agent can relay verbatim, not a 402 blaming the payment", async () => {
    const { rateUnavailablePaymentError } = await loadResolver();

    const detail = rateUnavailablePaymentError();

    // 503, not 402: the caller's payment isn't the problem, our pricing is.
    expect(detail.status).toBe(503);
    expect(detail.body).toMatchObject({
      error: "fx_rate_unavailable",
      retryable: true,
      display: expect.stringContaining("nothing was charged") as string
    });
    expect(detail.body.hint).toBeTruthy();
  });
});
