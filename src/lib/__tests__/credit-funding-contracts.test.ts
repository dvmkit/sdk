import { describe, expect, it } from "vitest";
import {
  CREDIT_DRAIN_RAILS,
  CREDIT_FUNDING_MODES,
  CREDIT_FUND_RAILS,
  STABLECOIN_FUND_RAILS,
  fundingModeForTempoIntent,
  fundingModeForX402Flavour,
  isCreditFundingMode,
  isStablecoinFundRail
} from "../credit-funding-contracts";
import { microToSats } from "../payment-amounts";

describe("shared credit funding contracts", () => {
  it("preserves the funding and reclaim wire registries and stablecoin subset", () => {
    expect(CREDIT_FUND_RAILS).toEqual(["cashu", "lightning", "x402", "tempo"]);
    expect(CREDIT_DRAIN_RAILS).toEqual(["cashu", "x402", "tempo"]);
    expect(STABLECOIN_FUND_RAILS).toEqual(["x402", "tempo"]);
    expect(CREDIT_FUND_RAILS.filter(isStablecoinFundRail)).toEqual(["x402", "tempo"]);
  });

  it("maps each native funding instrument to its exact wire mode", () => {
    expect(CREDIT_FUNDING_MODES).toEqual(["one-shot", "reusable"]);
    expect(fundingModeForTempoIntent("charge")).toBe("one-shot");
    expect(fundingModeForTempoIntent("session")).toBe("reusable");
    expect(fundingModeForX402Flavour("exact")).toBe("one-shot");
    expect(fundingModeForX402Flavour("batch-settlement")).toBe("reusable");
    for (const mode of ["one-shot", "reusable"]) expect(isCreditFundingMode(mode)).toBe(true);
    for (const bad of [null, undefined, 0, {}, "charge", "session", "exact", "ONE-SHOT", " reusable"])
      expect(isCreditFundingMode(bad)).toBe(false);
  });

  it("ceilings whole sats after the existing rounded millisatoshi conversion", () => {
    expect(microToSats(50_000, 50_000)).toBe(100);
    expect(microToSats(50_001, 50_000)).toBe(101);
    expect(microToSats(1, 50_000)).toBe(1);
    expect(microToSats(0, 50_000)).toBe(0);
    expect(microToSats(1, 1_000_000)).toBe(0);
  });

});
