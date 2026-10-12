import { describe, expect, it } from "vitest";

import { parseCreditMenu, parseCreditTerms } from "../types";

const TERMS = {
  min_micro: 100_000,
  max_micro: 5_000_000,
  ttl_ms: 86_400_000,
  currency: "usd",
  funding: ["cashu"],
};

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

  it("keeps caller echoes on quote and 402 menus", () => {
    const parsed = parseCreditMenu({ ...TERMS, credit_id: "credit-1", balance_micro: 200_000 });
    expect(parsed).toMatchObject({ credit_id: "credit-1", balance_micro: 200_000 });
  });

  it("rejects incomplete public terms", () => {
    expect(parseCreditTerms({ min_micro: 100_000 })).toBeUndefined();
    expect(parseCreditTerms({ ...TERMS, funding: ["cashu", 42] })).toBeUndefined();
  });
});
