import { describe, expect, it } from "vitest";

import { fetchCoinGeckoBtcUsd, fetchCoinGeckoSpot } from "../fx-coingecko";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchCoinGeckoSpot", () => {
  it("parses bitcoin.usd and usd-coin.usd", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({
        bitcoin: { usd: 80000.5 },
        "usd-coin": { usd: 1.0001 },
      })) as typeof fetch;

    const spot = await fetchCoinGeckoSpot({ fetchImpl });
    expect(spot.btc_usd).toBe(80000.5);
    expect(spot.usdc_usd).toBe(1.0001);
    expect(spot.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("throws on non-OK status", async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response("rate limited", { status: 429 })) as typeof fetch;

    await expect(fetchCoinGeckoSpot({ fetchImpl })).rejects.toThrow(/HTTP 429/);
  });

  it("throws when bitcoin.usd is missing", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({ "usd-coin": { usd: 1 } })) as typeof fetch;

    await expect(fetchCoinGeckoSpot({ fetchImpl })).rejects.toThrow(/bitcoin\.usd/);
  });

  it("throws when usd-coin.usd is missing", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({ bitcoin: { usd: 80000 } })) as typeof fetch;

    await expect(fetchCoinGeckoSpot({ fetchImpl })).rejects.toThrow(/usd-coin\.usd/);
  });

  it("rejects negative or zero rates", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({
        bitcoin: { usd: 0 },
        "usd-coin": { usd: 1 },
      })) as typeof fetch;

    await expect(fetchCoinGeckoSpot({ fetchImpl })).rejects.toThrow(/bitcoin\.usd/);
  });

  it("sends a User-Agent header by default", async () => {
    let observed: Record<string, string> | undefined;
    const fetchImpl: typeof fetch = (async (_url: string, init?: RequestInit) => {
      observed = init?.headers as Record<string, string>;
      return jsonResponse({ bitcoin: { usd: 1 }, "usd-coin": { usd: 1 } });
    }) as typeof fetch;

    await fetchCoinGeckoSpot({ fetchImpl });
    expect(observed?.["User-Agent"]).toMatch(/dvmkit-platform/);
  });
});

describe("fetchCoinGeckoBtcUsd", () => {
  it("parses BTC and a timestamp without a USDC field", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({ bitcoin: { usd: 80000.5 } })) as typeof fetch;

    const spot = await fetchCoinGeckoBtcUsd({ fetchImpl });
    expect(spot.btc_usd).toBe(80000.5);
    expect(spot.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("hits the bitcoin-only URL by default", async () => {
    let observedUrl: string | undefined;
    const fetchImpl: typeof fetch = (async (url: string) => {
      observedUrl = url;
      return jsonResponse({ bitcoin: { usd: 1 } });
    }) as typeof fetch;

    await fetchCoinGeckoBtcUsd({ fetchImpl });
    expect(observedUrl).toContain("ids=bitcoin&vs_currencies=usd");
    expect(observedUrl).not.toContain("usd-coin");
  });

  it("throws when bitcoin.usd is missing", async () => {
    const fetchImpl: typeof fetch = (async () =>
      jsonResponse({ "usd-coin": { usd: 1 } })) as typeof fetch;

    await expect(fetchCoinGeckoBtcUsd({ fetchImpl })).rejects.toThrow(/bitcoin\.usd/);
  });
});
