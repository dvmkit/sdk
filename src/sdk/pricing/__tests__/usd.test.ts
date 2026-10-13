import { describe, expect, it } from "vitest";

import {
  fiatToSatsCeil,
  formatFiat,
  formatUsd,
  InvalidFxRateError,
  roundUsd,
  satsToFiat,
} from "../usd";

describe("fiatToSatsCeil", () => {
  it("rounds up to cover the quoted fiat amount", () => {
    expect(fiatToSatsCeil(0.005, 100_000)).toBe(5);
    expect(fiatToSatsCeil(0.005_01, 100_000)).toBe(6);
  });

  it("collapses negative / non-finite amounts to 0 ($0 charge is well-defined)", () => {
    expect(fiatToSatsCeil(-1, 80_000)).toBe(0);
    expect(fiatToSatsCeil(NaN, 80_000)).toBe(0);
  });

  it("throws InvalidFxRateError on bad ratePerBtc", () => {
    expect(() => fiatToSatsCeil(1, 0)).toThrow(InvalidFxRateError);
    expect(() => fiatToSatsCeil(1, -1)).toThrow(InvalidFxRateError);
    expect(() => fiatToSatsCeil(1, NaN)).toThrow(InvalidFxRateError);
  });

  it("is currency-agnostic — the same math applies to a EUR-per-BTC rate", () => {
    expect(fiatToSatsCeil(1, 73_000)).toBe(1370);
  });
});

describe("satsToFiat", () => {
  it("inverts fiatToSatsCeil up to rounding", () => {
    expect(satsToFiat(5, 100_000)).toBeCloseTo(0.005);
  });

  it("throws InvalidFxRateError when the rate is non-finite or non-positive", () => {
    expect(() => satsToFiat(1000, 0)).toThrow(InvalidFxRateError);
    expect(() => satsToFiat(1000, -1)).toThrow(InvalidFxRateError);
    expect(() => satsToFiat(1000, NaN)).toThrow(InvalidFxRateError);
  });
});

describe("roundUsd", () => {
  it("rounds to 4 decimal places", () => {
    expect(roundUsd(0.000_123_4)).toBe(0.000_1);
    expect(roundUsd(0.123_456)).toBe(0.123_5);
  });
});

describe("formatUsd", () => {
  it("uses 2 decimals when >= $0.01, 4 decimals below", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(0.005)).toBe("$0.0050");
  });
});

describe("formatFiat", () => {
  it("renders USD with the $ symbol and adaptive precision matching formatUsd", () => {
    expect(formatFiat(0, "usd")).toBe("$0.00 USD");
    expect(formatFiat(0.01, "usd")).toBe("$0.01 USD");
    expect(formatFiat(0.05, "usd")).toBe("$0.05 USD");
    expect(formatFiat(0.005, "usd")).toBe("$0.0050 USD");
  });

  it("renders EUR and GBP with their currency symbols", () => {
    expect(formatFiat(0.05, "eur")).toBe("€0.05 EUR");
    expect(formatFiat(1.5, "gbp")).toBe("£1.50 GBP");
  });

  it("renders JPY with zero decimals — no sub-yen denomination in practice", () => {
    expect(formatFiat(5, "jpy")).toBe("¥5 JPY");
    expect(formatFiat(0, "jpy")).toBe("¥0 JPY");
  });

  it("falls back to ISO code only for an unsymboled currency", () => {
    expect(formatFiat(1.5, "chf")).toBe("1.50 CHF");
  });
});
