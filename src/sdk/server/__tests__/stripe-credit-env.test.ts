import { describe, expect, it } from "vitest";

import { createStripeCreditRail, stripeCreditConfigFromEnv } from "../stripe-credit";

const HMAC = { DVMKIT_TEMPO_SECRET_KEY: "44".repeat(32) };
const SECRET = { DVMKIT_STRIPE_SECRET_KEY: "sk_test_x" };
const NETWORK = { DVMKIT_STRIPE_NETWORK_ID: "profile_x" };

describe("card-credit configuration from the environment", () => {
  it("leaves card credit off when neither Stripe variable is set", () => {
    expect(stripeCreditConfigFromEnv(HMAC)).toBeUndefined();
  });

  it("refuses to boot with only one of the two Stripe variables", () => {
    expect(() => stripeCreditConfigFromEnv({ ...HMAC, ...SECRET })).toThrow(
      "DVMKIT_STRIPE_NETWORK_ID"
    );
    expect(() => stripeCreditConfigFromEnv({ ...HMAC, ...NETWORK })).toThrow(
      "DVMKIT_STRIPE_SECRET_KEY"
    );
  });

  it("refuses to boot without the MPP challenge-binding secret", () => {
    expect(() => stripeCreditConfigFromEnv({ ...SECRET, ...NETWORK })).toThrow(
      /DVMKIT_TEMPO_SECRET_KEY.*Tempo and card credit/
    );
  });

  it("enables card credit when both Stripe variables and the binding secret are set", () => {
    expect(stripeCreditConfigFromEnv({ ...HMAC, ...SECRET, ...NETWORK })).toEqual({
      secretKey: "sk_test_x",
      networkId: "profile_x",
      hmacSecret: HMAC.DVMKIT_TEMPO_SECRET_KEY,
    });
  });

  it("reads the card minimum as a decimal dollar amount", () => {
    const base = { ...HMAC, ...SECRET, ...NETWORK };
    expect(stripeCreditConfigFromEnv({ ...base, DVMKIT_STRIPE_MIN_USD: " 2.50 " })).toMatchObject({
      minUsd: "2.50",
    });
    expect(stripeCreditConfigFromEnv({ ...base, DVMKIT_STRIPE_MIN_USD: "" })).not.toHaveProperty(
      "minUsd"
    );
  });

  it.each(["0.25", "0.499999", "abc", "-5", "1e1", "5.0000001", "$5"])(
    "refuses to boot on a card minimum of %s, naming the variable",
    (value) => {
      expect(() =>
        stripeCreditConfigFromEnv({ ...HMAC, ...SECRET, ...NETWORK, DVMKIT_STRIPE_MIN_USD: value })
      ).toThrow("DVMKIT_STRIPE_MIN_USD");
    }
  );
});

describe("card-credit rail minimum option", () => {
  const base = { secretKey: "sk_test_x", networkId: "profile_x", hmacSecret: "44".repeat(32) };

  it("exposes the builder's minimum in micro-USD, and none when unset", () => {
    expect(createStripeCreditRail({ ...base, minUsd: 2.5 }).minMicro).toBe(2_500_000);
    expect(createStripeCreditRail({ ...base, minUsd: "0.50" }).minMicro).toBe(500_000);
    expect(createStripeCreditRail(base).minMicro).toBeUndefined();
  });

  it("rejects a minimum under $0.50 or not a number, naming the option", () => {
    expect(() => createStripeCreditRail({ ...base, minUsd: 0.25 })).toThrow("minUsd");
    expect(() => createStripeCreditRail({ ...base, minUsd: "abc" })).toThrow("minUsd");
    expect(() => createStripeCreditRail({ ...base, minUsd: Number.NaN })).toThrow("minUsd");
  });
});
