import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs");
vi.mock("../../defaults", () => ({
  CONFIG_DIR: "/mock/.dvm",
  BTC_RATE_FILE: "/mock/.dvm/btc-rate.json",
}));

import { existsSync, readFileSync } from "fs";

import {
  costAnchor,
  msatsToUsd,
  usdToMsats
} from "../currency";

describe("msatsToUsd", () => {
  it("converts millisats to USD", () => {
    expect(msatsToUsd(100_000_000, 100_000)).toBeCloseTo(100);
  });

  it("handles small amounts", () => {
    expect(msatsToUsd(1000, 100_000)).toBeCloseTo(0.001);
  });
});

describe("usdToMsats", () => {
  it("converts USD to millisats", () => {
    expect(usdToMsats(1, 100_000)).toBe(1_000_000);
  });

  it("round-trips with msatsToUsd", () => {
    const rate = 65000;
    const usd = 0.5;
    const msats = usdToMsats(usd, rate);
    expect(msatsToUsd(msats, rate)).toBeCloseTo(usd);
  });
});

describe("costAnchor", () => {
  it("uses the USD anchor bands at their inclusive and exclusive boundaries", () => {
    for (const [amount, expected] of [
      [0.001, "fraction of a cent"], [0.009, "fraction of a cent"],
      [0.01, "comparable to an API call"], [0.05, "comparable to an API call"], [0.1, "comparable to an API call"],
      [0.11, "comparable to a ChatGPT query"], [0.5, "comparable to a ChatGPT query"], [1, "comparable to a ChatGPT query"],
      [1.01, "comparable to a coffee"], [5, "comparable to a coffee"], [10, "comparable to a coffee"],
      [10.01, "significant purchase — review carefully"], [50, "significant purchase — review carefully"],
    ] as const) {
      expect(costAnchor(amount), String(amount)).toBe(expected);
    }
  });

  it("applies JPY-scale bands when currency is jpy", () => {
    // 300 JPY ≈ $2 — must NOT hit "significant purchase" the way USD bands would.
    expect(costAnchor(300, "jpy")).toBe("comparable to a coffee");
    expect(costAnchor(0.5, "jpy")).toBe("fraction of a cent");
    expect(costAnchor(2000, "jpy")).toBe("significant purchase — review carefully");
  });

  it("falls back to USD bands for an unknown currency", () => {
    expect(costAnchor(0.05, "chf")).toBe("comparable to an API call");
  });
});

describe("fetchBtcUsdRate", () => {
  // Each test gets a fresh module to reset the in-memory cache
  let fetchBtcUsdRate: () => Promise<number>;

  const coingeckoOk = (btc: unknown, usdc: unknown = 1): typeof fetch =>
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ bitcoin: { usd: btc }, "usd-coin": { usd: usdc } }),
      })
    ) as unknown as typeof fetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.stubGlobal("fetch", coingeckoOk(68000.5));
    const mod = await import("../currency");
    fetchBtcUsdRate = mod.fetchBtcUsdRate;
  });

  it("fetches rate from CoinGecko", async () => {
    const rate = await fetchBtcUsdRate();

    expect(rate).toBe(68000.5);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads from disk cache when available", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rate: 70000, timestamp: Date.now() }));

    const rate = await fetchBtcUsdRate();

    expect(rate).toBe(70000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores expired disk cache", async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ rate: 70000, timestamp: Date.now() - 10 * 60 * 1000 })
    );

    const rate = await fetchBtcUsdRate();

    expect(rate).toBe(68000.5);
    expect(fetch).toHaveBeenCalled();
  });

  it("rejects an unparseable rate (NaN) instead of caching it", async () => {
    vi.stubGlobal("fetch", coingeckoOk("not-a-number"));
    await expect(fetchBtcUsdRate()).rejects.toThrow();
  });

  it("rejects an implausibly large rate", async () => {
    vi.stubGlobal("fetch", coingeckoOk(99_999_999));
    await expect(fetchBtcUsdRate()).rejects.toThrow(/implausible/);
  });

  it("rejects a non-positive rate", async () => {
    vi.stubGlobal("fetch", coingeckoOk(0));
    await expect(fetchBtcUsdRate()).rejects.toThrow();
  });

  it("tolerates a degraded usd-coin.usd field — the CLI USD path only needs BTC", async () => {
    // CoinGecko occasionally returns `bitcoin.usd` but a malformed/missing
    // `usd-coin.usd`. Pre-fix, this blew up the entire formatAmountBestEffort
    // path. Post-fix, only bitcoin.usd is required.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ bitcoin: { usd: 68000.5 } }),
        })
      ) as unknown as typeof fetch
    );
    const rate = await fetchBtcUsdRate();
    expect(rate).toBe(68000.5);
  });

  it("ignores a poisoned disk cache (NaN/≤0) within the TTL window", async () => {
    // Earlier binaries could write a NaN rate to disk. On upgrade the
    // fresh-cache path used to return it verbatim for one full CACHE_TTL.
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rate: NaN, timestamp: Date.now() }));

    const rate = await fetchBtcUsdRate();
    expect(rate).toBe(68000.5);
    expect(fetch).toHaveBeenCalled();
  });
});
