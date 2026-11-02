import { describe, expect, it } from "vitest";

import { stripeCreditConfigFromEnv } from "../stripe-credit";

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
});
