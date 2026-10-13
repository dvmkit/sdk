import { describe, expect, it } from "vitest";

import { InvalidCurrencyError } from "../currency";
import { buildUpfront } from "../upfront";

describe("buildUpfront", () => {
  it("returns a validated upfront envelope", () => {
    expect(buildUpfront({ amount: 0.02, currency: "usd" })).toEqual({
      amount: 0.02,
      currency: "usd",
    });
  });

  it("rejects bad currency", () => {
    expect(() => buildUpfront({ amount: 1, currency: "USD" })).toThrow(InvalidCurrencyError);
  });

  it("rejects negative or non-finite amount", () => {
    expect(() => buildUpfront({ amount: -1, currency: "usd" })).toThrow();
    expect(() => buildUpfront({ amount: NaN, currency: "usd" })).toThrow();
  });

  it("allows zero (some DVMs may quote free preflight)", () => {
    expect(buildUpfront({ amount: 0, currency: "usd" })).toEqual({
      amount: 0,
      currency: "usd",
    });
  });
});
