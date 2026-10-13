import { describe, expect, it } from "vitest";

import { InvalidCurrencyError, UnsupportedCurrencyError, validateCurrency } from "../currency";

describe("validateCurrency", () => {
  it("accepts 3-letter lowercase codes", () => {
    expect(validateCurrency("usd")).toBe("usd");
    expect(validateCurrency("eur")).toBe("eur");
    expect(validateCurrency("jpy")).toBe("jpy");
  });

  it("rejects non-lowercase, wrong-length, and non-letter codes", () => {
    for (const code of ["USD", "Usd", "us", "usdt", "", "u$d", "123"]) {
      expect(() => validateCurrency(code), code).toThrow(InvalidCurrencyError);
    }
  });

  it("UnsupportedCurrencyError names the supported set in the message", () => {
    const err = new UnsupportedCurrencyError("eur", ["usd"]);
    expect(err.message).toBe('fx fetcher supports [usd]; got "eur"');
    expect(err.code).toBe("unsupported_currency");
  });

  it("UnsupportedCurrencyError carries the fetcher's actual supported set", () => {
    const err = new UnsupportedCurrencyError("chf", ["usd", "eur", "gbp", "jpy"]);
    expect(err.message).toBe('fx fetcher supports [usd,eur,gbp,jpy]; got "chf"');
    expect(err.supported).toEqual(["usd", "eur", "gbp", "jpy"]);
  });
});
