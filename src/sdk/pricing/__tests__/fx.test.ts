import { describe, expect, it, vi } from "vitest";

import { UnsupportedCurrencyError } from "../currency";
import type { FxFetcher } from "../fx";
import {
  createFxFetcher,
  DEFAULT_FX_CURRENCIES,
  fxRateFor,
  FxRateUnavailableError,
  resolveFxSourceFromEnv,
  warmFxSnapshot,
} from "../fx";

const multiCurrencyBody = JSON.stringify({
  bitcoin: { usd: 80_000, eur: 73_000, gbp: 63_000, jpy: 12_000_000 }
});

describe("createFxFetcher", () => {
  it.each(["direct", "platform"] as const)("classifies exhausted %s source failures without trusting prose", async (kind) => {
    const source = kind === "direct" ? "https://example.com/rates?token=URL_SECRET"
      : { kind: "platform" as const, url: "https://example.com/rates?token=URL_SECRET", token: "BEARER_SECRET" };
    for (const [input, category, httpStatus] of [
      [() => Promise.reject(new Error("BODY_SECRET 429")), "network_error", undefined],
      [() => Promise.resolve(new Response("BODY_SECRET", { status: 429 })), "http_error", 429],
      [() => Promise.resolve(new Response("BODY_SECRET", { status: 200 })), "invalid_body", undefined],
      [() => Promise.resolve(new Response("null", { status: 200 })), "invalid_body", undefined],
      [() => Promise.resolve(Response.json({ bitcoin: [], rates: [] })), "invalid_body", undefined],
      [() => Promise.resolve(Response.json({ bitcoin: { usd: 0 }, rates: { usd: 0 } })), "no_usable_rate", undefined],
    ] as const) {
      const fetchFn = vi.fn(input) as unknown as typeof fetch;
      const fx = createFxFetcher({ source, fetchFn, retries: 1, retryDelayMs: 0 });
      await expect(fx.fetch()).rejects.toMatchObject({ sourceFailure: { category, ...(httpStatus && { httpStatus }) } });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps only the last attempt's source observation", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new Error("network 429"))
      .mockResolvedValueOnce(new Response("provider", { status: 503 })) as unknown as typeof fetch;
    await expect(createFxFetcher({ fetchFn, retries: 1, retryDelayMs: 0 }).fetch())
      .rejects.toMatchObject({ sourceFailure: { category: "http_error", httpStatus: 503 } });
  });

  it.each(["429", 99, 600, 429.5, NaN])("does not retain invalid typed source status %s", (httpStatus) => {
    const error = new FxRateUnavailableError("provider", undefined, undefined, {
      category: "http_error", httpStatus: httpStatus as number,
    });
    expect(error.sourceFailure).toEqual({ category: "http_error" });
  });

  it("does not execute constructor metadata accessors or accept arbitrary categories", () => {
    const getter = vi.fn(() => { throw new Error("METADATA_SECRET"); });
    const metadata = Object.defineProperties({}, {
      category: { get: getter }, httpStatus: { get: getter },
    });
    expect(new FxRateUnavailableError("provider", undefined, undefined, metadata as never).sourceFailure)
      .toEqual({ category: "unknown" });
    expect(getter).not.toHaveBeenCalled();
    expect(new FxRateUnavailableError("provider", undefined, undefined, { category: "METADATA_SECRET" } as never).sourceFailure)
      .toEqual({ category: "unknown" });
    const statusMetadata = Object.defineProperty({ category: "http_error" }, "httpStatus", { get: getter });
    expect(new FxRateUnavailableError("provider", undefined, undefined, statusMetadata as never).sourceFailure)
      .toEqual({ category: "http_error" });
    expect(getter).not.toHaveBeenCalled();
    const proxy = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("METADATA_SECRET"); } });
    expect(new FxRateUnavailableError("provider", undefined, undefined, proxy as never).sourceFailure)
      .toEqual({ category: "unknown" });
  });

  it("retry exhaustion reads injected metadata without executing its accessor", async () => {
    const getter = vi.fn(() => { throw new Error("METADATA_SECRET"); });
    const failure = new FxRateUnavailableError("provider text");
    Object.defineProperty(failure, "sourceFailure", { get: getter });
    const fetchFn = vi.fn(async () => { throw failure; }) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, retries: 1, retryDelayMs: 0 });
    await expect(fx.fetch()).rejects.toMatchObject({ sourceFailure: { category: "unknown" } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(getter).not.toHaveBeenCalled();
  });

  it("preserves injected typed stale refusal and bypasses retries after warming a cache", async () => {
    const refusal = new FxRateUnavailableError("stale", undefined, { staleDays: 6 });
    const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ bitcoin: { usd: 100_000 } }))
      .mockRejectedValue(refusal) as unknown as typeof fetch;
    let now = 0;
    const fx = createFxFetcher({ currencies: ["usd"], now: () => now, cacheTtlMs: 1, fetchFn, retries: 1, retryDelayMs: 0 });
    await fx.fetch();
    now = 2;
    await expect(fx.fetch()).rejects.toBe(refusal);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("retains observed HTTP failure when the optional platform refusal body is null", async () => {
    const fetchFn = vi.fn(async () => Response.json(null, { status: 503 })) as unknown as typeof fetch;
    const fx = createFxFetcher({ source: { kind: "platform", url: "https://example.com/fx", token: "fake" }, fetchFn, retries: 1, retryDelayMs: 0 });
    await expect(fx.fetch()).rejects.toMatchObject({ sourceFailure: { category: "http_error", httpStatus: 503 } });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("parses every configured currency from a CoinGecko-shaped response", async () => {
    const fetchFn = vi.fn(
      async () => new Response(multiCurrencyBody, { status: 200 })
    ) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn });
    const snap = await fx.fetch();
    expect(DEFAULT_FX_CURRENCIES).toEqual(["usd", "eur", "gbp", "jpy"]);
    expect(fx.supportedCurrencies()).toEqual(["usd", "eur", "gbp", "jpy"]);
    expect(snap.rates).toEqual({ usd: 80_000, eur: 73_000, gbp: 63_000, jpy: 12_000_000 });
    expect(snap.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("supportedCurrencies() reflects the configured set without forcing a fetch", () => {
    const fx = createFxFetcher({ currencies: ["usd", "eur"] });
    expect(fx.supportedCurrencies()).toEqual(["usd", "eur"]);
  });

  it("caches within the TTL window", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => new Response(multiCurrencyBody, { status: 200 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              bitcoin: {
                usd: 90_000,
                eur: 82_000,
                gbp: 71_000,
                jpy: 13_500_000
              }
            }),
            { status: 200 }
          )
      ) as unknown as typeof fetch;
    let now = 1000;
    const fx = createFxFetcher({ fetchFn, now: () => now, cacheTtlMs: 60_000 });
    const a = await fx.fetch();
    now = 30_000;
    const b = await fx.fetch();
    expect(a.rates.usd).toBe(b.rates.usd);
    expect((fetchFn as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("re-fetches once the TTL passes", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => new Response(multiCurrencyBody, { status: 200 }))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({
              bitcoin: {
                usd: 90_000,
                eur: 82_000,
                gbp: 71_000,
                jpy: 13_500_000
              }
            }),
            { status: 200 }
          )
      ) as unknown as typeof fetch;
    let now = 1000;
    const fx = createFxFetcher({ fetchFn, now: () => now, cacheTtlMs: 60_000 });
    const a = await fx.fetch();
    now = 1000 + 70_000;
    const b = await fx.fetch();
    expect(a.rates.usd).toBe(80_000);
    expect(b.rates.usd).toBe(90_000);
  });

  it("dedupes concurrent fetches via the in-flight promise", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return new Response(multiCurrencyBody, { status: 200 });
    }) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn });
    const [a, b, c] = await Promise.all([fx.fetch(), fx.fetch(), fx.fetch()]);
    expect(a.rates.usd).toBe(80_000);
    expect(b.rates.eur).toBe(73_000);
    expect(c.rates.jpy).toBe(12_000_000);
    expect(calls).toBe(1);
  });

  it("retries the configured number of times before giving up", async () => {
    let attempts = 0;
    const fetchFn = (async () => {
      attempts++;
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, retries: 2, cacheTtlMs: 60_000, retryDelayMs: 0 });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
    expect(attempts).toBe(3);
  });

  it("raises FxRateUnavailableError on persistent HTTP failure", async () => {
    const fetchFn = (async () =>
      new Response("server error", { status: 503 })) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, retries: 1, retryDelayMs: 0 });
    try {
      await fx.fetch();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FxRateUnavailableError);
      expect((err as FxRateUnavailableError).code).toBe("fx_rate_unavailable");
    }
  });

  it("keeps the currencies that parsed when one of them is unusable", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: { usd: 80_000, eur: "nope" } }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "eur"]
    });
    const snap = await fx.fetch();
    // A usd-priced DVM keeps pricing; the eur one is told the rate is missing,
    // not that its own quote is malformed.
    expect(snap.rates).toEqual({ usd: 80_000 });
    expect(fxRateFor(snap, "usd")).toBe(80_000);
    expect(snap.unavailable).toEqual(["eur"]);
  });

  it("answers a configured-but-absent currency as a rate outage, not a bad currency", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: { usd: 80_000 } }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "eur"]
    });
    const snap = await fx.fetch();
    // `unsupported_currency` reaches the quote path as a 400 telling the
    // caller's agent not to retry; a source that dropped `eur` for a minute is
    // a retryable 503.
    const err = (() => {
      try {
        fxRateFor(snap, "eur");
      } catch (e: unknown) {
        return e;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(FxRateUnavailableError);
    expect((err as FxRateUnavailableError).code).toBe("fx_rate_unavailable");
    // Not a known-stale refusal, so a consumer still degrades on it.
    expect((err as FxRateUnavailableError).knownStale).toBeUndefined();
  });

  it("keeps raising UnsupportedCurrencyError for a currency nothing configured", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: { usd: 80_000 } }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, retries: 0, currencies: ["usd"] });
    const snap = await fx.fetch();
    expect(snap.unavailable).toBeUndefined();
    expect(() => fxRateFor(snap, "chf")).toThrow(UnsupportedCurrencyError);
  });

  it("carries a dropped currency forward instead of evicting it", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ bitcoin: { usd: 80_000, gbp: 63_000 } }), { status: 200 })
      )
      .mockImplementationOnce(
        async () =>
          new Response(JSON.stringify({ bitcoin: { usd: 81_000 } }), {
            status: 200
          })
      ) as unknown as typeof fetch;
    let now = 1000;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "gbp"],
      now: () => now
    });
    await fx.fetch();
    now += 400_000; // past the freshness TTL, so the second body is fetched
    const snap = await fx.fetch();

    // The fresh usd rate lands; gbp keeps the rate it had rather than the whole
    // snapshot — and with it the fetcher's degradation source — being narrowed.
    expect(snap.rates).toEqual({ usd: 81_000, gbp: 63_000 });
    expect(snap.carried_forward).toEqual(["gbp"]);
    expect(snap.unavailable).toBeUndefined();
    expect(fxRateFor(snap, "gbp")).toBe(63_000);
    expect(fx.lastKnown?.()?.snapshot.rates.gbp).toBe(63_000);
  });

  it("stops carrying a currency forward once the source serves it again", async () => {
    const bodies = [{ usd: 80_000, gbp: 63_000 }, { usd: 81_000 }, { usd: 82_000, gbp: 64_000 }];
    let call = 0;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: bodies[call++] }), {
        status: 200
      })) as unknown as typeof fetch;
    let now = 1000;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "gbp"],
      now: () => now
    });
    await fx.fetch();
    now += 400_000;
    await fx.fetch();
    now += 400_000;
    const snap = await fx.fetch();
    expect(snap.rates).toEqual({ usd: 82_000, gbp: 64_000 });
    expect(snap.carried_forward).toBeUndefined();
  });

  it("warns once per partial-body episode rather than on every fetch", async () => {
    const bodies = [{ usd: 80_000 }, { usd: 81_000 }, { usd: 82_000, gbp: 64_000 }, { usd: 83_000 }];
    let call = 0;
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: bodies[call++] }), {
        status: 200
      })) as unknown as typeof fetch;
    let now = 1000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let events: Record<string, unknown>[];
    try {
      const fx = createFxFetcher({
        fetchFn,
        retries: 0,
        currencies: ["usd", "gbp"],
        now: () => now
      });
      for (const _ of bodies) {
        await fx.fetch();
        now += 400_000;
      }
      events = warn.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
        .filter((row) => row.event === "fx_rates_partial");
    } finally {
      warn.mockRestore();
    }
    // Fetch 1 and 2 are the same gap — one line. Fetch 3 recovers, which
    // re-arms; fetch 4 is a fresh episode and is news again.
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      { event: "fx_rates_partial", level: "warn" },
      { event: "fx_rates_partial", level: "warn" }
    ]);
  });

  it("still raises when the body carries no usable currency at all", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: { usd: "nope", eur: 0 } }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "eur"]
    });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  it("backs off between retry attempts rather than firing the budget at once", async () => {
    const waits: number[] = [];
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const fetchFn = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, retries: 2, retryDelayMs: 1 });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
    for (const call of timeout.mock.calls) waits.push(call[1] as number);
    timeout.mockRestore();
    // Doubling, and only between attempts — never after the last one.
    expect(waits).toEqual([1, 2]);
  });

  it("custom currency set filters the snapshot and supportedCurrencies()", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ bitcoin: { usd: 80_000, eur: 73_000 } }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({ fetchFn, currencies: ["usd"] });
    expect(fx.supportedCurrencies()).toEqual(["usd"]);
    const snap = await fx.fetch();
    expect(Object.keys(snap.rates)).toEqual(["usd"]);
  });
});

describe("createFxFetcher — platform source", () => {
  const platformBody = JSON.stringify({
    rates: { usd: 95_000, eur: 87_000, gbp: 75_000, jpy: 14_000_000 },
    as_of: "2026-05-25T08:15:00.000Z"
  });

  it("parses the {rates, as_of} envelope served by the platform endpoint", async () => {
    const fetchFn = vi.fn(async () => new Response(platformBody, { status: 200 })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    const snap = await fx.fetch();
    expect(snap.rates).toEqual({
      usd: 95_000,
      eur: 87_000,
      gbp: 75_000,
      jpy: 14_000_000
    });
    expect(snap.as_of).toBe("2026-05-25T08:15:00.000Z");
  });

  it("sends a Bearer Authorization header with the configured token", async () => {
    const fetchFn = vi.fn(async () => new Response(platformBody, { status: 200 })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "secret"
      }
    });
    await fx.fetch();
    const call = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(call[0]).toBe("http://platform.invalid/_internal/fx");
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret");
  });

  it("raises FxRateUnavailableError on 503 from the platform endpoint", async () => {
    const fetchFn = (async () => new Response("svc down", { status: 503 })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 1,
      retryDelayMs: 0,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  // the platform's deliberate known-stale refusal
  // must survive the fetch boundary as a typed signal — a generic
  // "returned 503" would be indistinguishable from a transient blip.
  const staleRefusalBody = JSON.stringify({
    error: {
      code: "fx_rate_unavailable",
      message: "fx snapshot stale: newest coingecko rate_date 2026-07-16 is 6d old",
      detail: {
        stale_source: "coingecko",
        newest_rate_date: "2026-07-16",
        stale_days: 6,
        threshold_days: 5
      }
    }
  });

  it("threads the platform's known-stale refusal through as FxRateUnavailableError.knownStale", async () => {
    const fetchFn = (async () =>
      new Response(staleRefusalBody, {
        status: 503
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 2,
      retryDelayMs: 0,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    const err = await fx.fetch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FxRateUnavailableError);
    expect((err as FxRateUnavailableError).sourceFailure).toEqual({ category: "http_error", httpStatus: 503 });
    expect((err as FxRateUnavailableError).knownStale).toEqual({
      staleDays: 6,
      staleSource: "coingecko",
      thresholdDays: 5
    });
  });

  it("does not retry a deterministic known-stale refusal (short-circuits the retry budget)", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(staleRefusalBody, { status: 503 });
    }) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 2,
      retryDelayMs: 0,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
    expect(calls).toBe(1);
  });

  it("retries a plain (untyped) 503 the full budget and carries no knownStale", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response("svc down", { status: 503 });
    }) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 2,
      retryDelayMs: 0,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    const err = await fx.fetch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FxRateUnavailableError);
    expect((err as FxRateUnavailableError).knownStale).toBeUndefined();
    expect(calls).toBe(3);
  });

  it("treats the cold-start fx_snapshot_unavailable 503 as transient (no knownStale)", async () => {
    // No `detail` block → not a staleness refusal; must degrade, not fail closed.
    const coldStartBody = JSON.stringify({
      error: {
        code: "fx_snapshot_unavailable",
        message: "btc_usd missing from fx_rates"
      }
    });
    const fetchFn = (async () => new Response(coldStartBody, { status: 503 })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      source: {
        kind: "platform",
        url: "http://platform.invalid/_internal/fx",
        token: "tok"
      }
    });
    const err = await fx.fetch().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FxRateUnavailableError);
    expect((err as FxRateUnavailableError).knownStale).toBeUndefined();
  });

  it("keeps the currencies the platform body does carry", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ rates: { usd: 95_000 }, as_of: "x" }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd", "eur"],
      source: { kind: "platform", url: "http://p/_internal/fx", token: "t" }
    });
    const snap = await fx.fetch();
    expect(snap.rates).toEqual({ usd: 95_000 });
    expect(snap.unavailable).toEqual(["eur"]);
  });

  it("raises when the platform body carries no usable currency", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ rates: { usd: -1 }, as_of: "x" }), {
        status: 200
      })) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      retries: 0,
      currencies: ["usd"],
      source: { kind: "platform", url: "http://p/_internal/fx", token: "t" }
    });
    await expect(fx.fetch()).rejects.toBeInstanceOf(FxRateUnavailableError);
  });

  it("falls back to wall-clock as_of when the platform omits it", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          rates: { usd: 95_000, eur: 87_000, gbp: 75_000, jpy: 14e6 }
        }),
        {
          status: 200
        }
      )) as unknown as typeof fetch;
    const fx = createFxFetcher({
      fetchFn,
      source: { kind: "platform", url: "http://p/_internal/fx", token: "t" }
    });
    const snap = await fx.fetch();
    expect(snap.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("resolveFxSourceFromEnv", () => {
  it("returns undefined when DVMKIT_FX_SOURCE is unset (CoinGecko default kicks in)", () => {
    expect(resolveFxSourceFromEnv({})).toBeUndefined();
  });

  it('returns a platform source when DVMKIT_FX_SOURCE="platform" and platform env is present', () => {
    const out = resolveFxSourceFromEnv({
      DVMKIT_FX_SOURCE: "platform",
      DVMKIT_PLATFORM_URL: "http://platform.example.com:8080",
      DVMKIT_PLATFORM_TOKEN: "tok-abc"
    });
    expect(out).toEqual({
      kind: "platform",
      url: "http://platform.example.com:8080/_internal/fx",
      token: "tok-abc"
    });
  });

  it("strips trailing slashes from DVMKIT_PLATFORM_URL when building the endpoint URL", () => {
    const out = resolveFxSourceFromEnv({
      DVMKIT_FX_SOURCE: "platform",
      DVMKIT_PLATFORM_URL: "http://platform.example.com:8080///",
      DVMKIT_PLATFORM_TOKEN: "tok"
    });
    expect(out).toEqual({
      kind: "platform",
      url: "http://platform.example.com:8080/_internal/fx",
      token: "tok"
    });
  });

  it('throws when DVMKIT_FX_SOURCE="platform" but DVMKIT_PLATFORM_URL/TOKEN are missing', () => {
    expect(() =>
      resolveFxSourceFromEnv({ DVMKIT_FX_SOURCE: "platform", DVMKIT_PLATFORM_URL: "x" })
    ).toThrow(/DVMKIT_PLATFORM_URL and DVMKIT_PLATFORM_TOKEN/);
    expect(() =>
      resolveFxSourceFromEnv({ DVMKIT_FX_SOURCE: "platform", DVMKIT_PLATFORM_TOKEN: "x" })
    ).toThrow(/DVMKIT_PLATFORM_URL and DVMKIT_PLATFORM_TOKEN/);
  });

  it("returns the URL verbatim when DVMKIT_FX_SOURCE is a CoinGecko-shaped override", () => {
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";
    expect(resolveFxSourceFromEnv({ DVMKIT_FX_SOURCE: url })).toBe(url);
  });
});

describe("warmFxSnapshot", () => {
  it("primes lastKnown() so a later failing fetch has something to degrade onto", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => new Response(multiCurrencyBody, { status: 200 }))
      .mockImplementation(() => Promise.reject(new Error("rate source down")));
    const fx = createFxFetcher({ fetchFn: fetchFn as unknown as typeof fetch, retryDelayMs: 0 });

    expect(fx.lastKnown?.()).toBeNull();
    warmFxSnapshot(fx);
    await vi.waitFor(() => {
      expect(fx.lastKnown?.()).not.toBeNull();
    });
    expect(fx.lastKnown?.()?.snapshot.rates.usd).toBe(80_000);
  });

  it("swallows a failing warm-up — no throw, no rejection, nothing cached", async () => {
    const fetchFn = vi.fn(() => Promise.reject(new Error("rate source down")));
    const fx = createFxFetcher({
      fetchFn: fetchFn as unknown as typeof fetch,
      retries: 0,
      retryDelayMs: 0
    });

    expect(() => {
      warmFxSnapshot(fx);
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(fetchFn).toHaveBeenCalled();
    });
    expect(fx.lastKnown?.()).toBeNull();
  });

  it("swallows an injected fetcher that throws before it returns a promise", () => {
    // `fetch` is typed async, but nothing stops an injected implementation from
    // throwing synchronously — and that escapes a `.catch` on the return value.
    // The boot must not hear about it either way.
    const fx: FxFetcher = {
      supportedCurrencies: () => ["usd"],
      lastKnown: () => null,
      fetch: () => {
        throw new Error("bad source");
      }
    };

    expect(() => {
      warmFxSnapshot(fx);
    }).not.toThrow();
  });

  it("no-ops against a fetcher that already holds a snapshot", async () => {
    const fetchFn = vi.fn(async () => new Response(multiCurrencyBody, { status: 200 }));
    const fx = createFxFetcher({ fetchFn: fetchFn as unknown as typeof fetch });
    await fx.fetch();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    warmFxSnapshot(fx);
    await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("costs one upstream fetch when it races a first real request", async () => {
    const fetchFn = vi.fn(async () => new Response(multiCurrencyBody, { status: 200 }));
    const fx = createFxFetcher({ fetchFn: fetchFn as unknown as typeof fetch });

    warmFxSnapshot(fx);
    await fx.fetch();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("fxRateFor", () => {
  it("returns the rate for a supported currency", () => {
    const snap = {
      rates: { usd: 80_000, eur: 73_000 },
      as_of: "2026-04-30T00:00:00Z"
    };
    expect(fxRateFor(snap, "usd")).toBe(80_000);
    expect(fxRateFor(snap, "eur")).toBe(73_000);
  });

  it("throws UnsupportedCurrencyError naming the snapshot's actual keys", () => {
    const snap = { rates: { usd: 80_000 }, as_of: "x" };
    try {
      fxRateFor(snap, "eur");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCurrencyError);
      expect((err as UnsupportedCurrencyError).supported).toEqual(["usd"]);
      expect((err as Error).message).toBe('fx fetcher supports [usd]; got "eur"');
    }
  });
});
