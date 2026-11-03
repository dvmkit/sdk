import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { parseCreditMenu, parseCreditTerms } from "../types";

const TERMS = {
  min_micro: 100_000,
  max_micro: 5_000_000,
  ttl_ms: 86_400_000,
  currency: "usd",
  funding: ["cashu"],
};

const cardFixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/credit-fund-stripe-v1.json", import.meta.url), "utf8")
);
const STRIPE_TERMS = cardFixture.menu.credit.stripe;
const PARSERS = [
  { name: "parseCreditTerms", parse: parseCreditTerms },
  { name: "parseCreditMenu", parse: parseCreditMenu },
];

describe("parseCreditTerms", () => {
  it("whitelists public fields and strips caller echoes", () => {
    const parsed = parseCreditTerms({
      ...TERMS,
      tempo: {
        methods: [{ method: "tempo", intent: "session", private_key: "private" }],
        withheld: [{ method: "tempo", intent: "charge", reason: "unavailable", secret: "private" }],
        channel_secret: "private",
      },
      x402: {
        schemes: [{ scheme: "exact", network: "eip155:8453", secret: "private" }],
        token: "private",
      },
      lightning_min_micro: 200_000,
      credit_id: "private",
      balance_micro: 2_000_000,
      remaining_micro: 1_500_000,
      expiry_ms: 123,
      unknown_future_key: "private too",
    });
    expect(parsed).toEqual({
      ...TERMS,
      tempo: {
        methods: [{ method: "tempo", intent: "session" }],
        withheld: [{ method: "tempo", intent: "charge", reason: "unavailable" }],
      },
      x402: { schemes: [{ scheme: "exact", network: "eip155:8453" }] },
      lightning_min_micro: 200_000,
    });
  });

  it("accepts JIT refund park support only as literal true", () => {
    expect(parseCreditTerms({ ...TERMS, jit_refund_park: true })?.jit_refund_park).toBe(true);
    for (const value of [false, "true", 1]) {
      expect(parseCreditTerms({ ...TERMS, jit_refund_park: value })?.jit_refund_park).toBeUndefined();
    }
    expect(parseCreditTerms(TERMS)?.jit_refund_park).toBeUndefined();
  });

  it("keeps caller echoes on quote and 402 menus", () => {
    const parsed = parseCreditMenu({ ...TERMS, credit_id: "credit-1", balance_micro: 200_000 });
    expect(parsed).toMatchObject({ credit_id: "credit-1", balance_micro: 200_000 });
  });

  it.each(PARSERS)("preserves card terms through $name", ({ parse }) => {
    const terms = { ...TERMS, funding: ["stripe"], stripe: STRIPE_TERMS };
    expect(parse(JSON.parse(JSON.stringify(terms)))).toEqual(terms);
    expect(parse({ ...terms, stripe: { ...STRIPE_TERMS, min_micro: 1_250_000 } })).toEqual({
      ...terms,
      stripe: { network_id: "profile_test", min_micro: 1_250_000, currency: "usd" },
    });
  });

  it("strips unknown card fields without retaining the input object", () => {
    const stripe = { ...STRIPE_TERMS, unknown_future_key: "private" };
    const parsed = parseCreditTerms({ ...TERMS, stripe });
    expect(parsed).toEqual({
      ...TERMS,
      stripe: { network_id: "profile_test", min_micro: 500_000, currency: "usd" },
    });
    stripe.network_id = "profile_changed";
    expect(parsed?.stripe?.network_id).toBe("profile_test");
  });

  it.each(PARSERS)("accepts terms without cards through $name", ({ parse }) => {
    expect(parse(TERMS)).toEqual(TERMS);
  });

  it.each([
    null,
    [],
    "stripe",
    {},
    { min_micro: 500_000, currency: "usd" },
    { ...STRIPE_TERMS, network_id: 42 },
    { ...STRIPE_TERMS, min_micro: undefined },
    { ...STRIPE_TERMS, min_micro: "500000" },
    { ...STRIPE_TERMS, min_micro: 0 },
    { ...STRIPE_TERMS, min_micro: -1 },
    { ...STRIPE_TERMS, min_micro: 0.5 },
    { ...STRIPE_TERMS, min_micro: NaN },
    { ...STRIPE_TERMS, min_micro: Infinity },
    { ...STRIPE_TERMS, min_micro: Number.MAX_SAFE_INTEGER + 1 },
    { ...STRIPE_TERMS, currency: undefined },
    { ...STRIPE_TERMS, currency: "eur" },
  ].map((stripe) => ({ stripe })))("rejects malformed card terms: $stripe", ({ stripe }) => {
    expect(parseCreditTerms({ ...TERMS, stripe })).toBeUndefined();
    expect(parseCreditMenu({ ...TERMS, stripe })).toBeUndefined();
  });

  it("rejects incomplete public terms", () => {
    expect(parseCreditTerms({ min_micro: 100_000 })).toBeUndefined();
    expect(parseCreditTerms({ ...TERMS, funding: ["cashu", 42] })).toBeUndefined();
  });
});
