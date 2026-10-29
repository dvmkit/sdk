import { describe, expect, it } from "vitest";

import type { FxFetcher, FxRateSnapshot } from "../../pricing/index";
import { proofSetRequestId, withFxHistory } from "../cashu-payment-request";

describe("proofSetRequestId", () => {
  it("names a proof set the same however a wallet orders its proofs", () => {
    expect(proofSetRequestId(["b", "a", "c"])).toBe(proofSetRequestId(["c", "b", "a"]));
  });

  it("names a different set differently, including a subset of it", () => {
    const whole = proofSetRequestId(["a", "b"]);
    expect(proofSetRequestId(["a"])).not.toBe(whole);
    expect(proofSetRequestId(["a", "c"])).not.toBe(whole);
    // Joining secrets without a delimiter would make these collide.
    expect(proofSetRequestId(["ab", "c"])).not.toBe(proofSetRequestId(["a", "bc"]));
  });
});

describe("withFxHistory", () => {
  function fetcher(rates: number[]): FxFetcher {
    let call = 0;
    return {
      // A fresh object on every call, as a fetcher re-reading its source would return.
      fetch: () => Promise.resolve({ rates: { usd: rates[Math.min(call++, rates.length - 1)]! }, as_of: `t${call}` }),
      supportedCurrencies: () => ["usd"],
    };
  }

  const at = (usd: number) => ({ rates: { usd }, as_of: "any" }) as FxRateSnapshot;

  it("keeps the replaced rates reachable while later fetches return the same rates", async () => {
    const fx = withFxHistory(fetcher([100, 80, 80, 80]));
    await fx.fetch();
    expect(fx.previousFor(at(100))).toBeUndefined();
    await fx.fetch();
    await fx.fetch();
    await fx.fetch();
    expect(fx.previousFor(at(80))?.rates.usd).toBe(100);
  });

  it("times the hold from the last price at the replaced rates, so an idle DVM does not honour an old quote", async () => {
    let clock = 0;
    const fx = withFxHistory(fetcher([100, 100, 80]), { holdWindowMs: 600_000, now: () => clock });
    await fx.fetch();
    clock = 1_000_000;
    await fx.fetch(); // the same rates priced another request
    clock = 1_000_001;
    await fx.fetch(); // the refresh
    clock = 1_600_000;
    expect(fx.previousFor(at(80))?.rates.usd).toBe(100);
    clock += 1;
    expect(fx.previousFor(at(80))).toBeUndefined();
  });

  it("gives no hold when the replaced rates last priced anything longer ago than the window", async () => {
    let clock = 0;
    const fx = withFxHistory(fetcher([100, 80]), { holdWindowMs: 600_000, now: () => clock });
    await fx.fetch();
    clock = 5_000_000; // idle for hours, then the first request after waking sees new rates
    await fx.fetch();
    expect(fx.previousFor(at(80))).toBeUndefined();
  });

  it("holds against the rates that priced the request, not whichever rates a later refresh made current", async () => {
    const fx = withFxHistory(fetcher([100, 80, 64]));
    await fx.fetch();
    const pricedAt = await fx.fetch();
    await fx.fetch(); // a refresh landing while the request is being verified
    expect(fx.previousFor(pricedAt)?.rates.usd).toBe(100);
    expect(fx.previousFor(at(64))?.rates.usd).toBe(80);
  });
});
