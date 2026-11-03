/* Card-funded credit through POST /v1/credit, against a fake Stripe API: the real mppx stripe
 * method, HMAC binding and ledger, with only the PaymentIntent endpoint simulated. */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { derivedFundCreditId } from "../funding";
import type { CreditDepositPayload } from "../revenue-reporter";
import {
  CALLER,
  cardServer,
  credentialFor,
  fakeStripe,
  fund,
  jobSigner,
  paymentChallenges,
  PRIVKEY,
  rateFx,
} from "./__helpers__/card-credit";

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../protocol-fixtures/${name}`, import.meta.url), "utf8"));
interface MenuCase {
  credit: { funding_includes: string; stripe: Record<string, unknown> };
  payment_methods_exclude: string[];
}
interface Exchange {
  status: number;
  body: Record<string, unknown>;
}
const discoveryFixture = readFixture("payment-method-discovery-v1.json") as { card_credit: MenuCase };
const fundFixture = readFixture("credit-fund-stripe-v1.json") as {
  menu: MenuCase;
  discovery: Exchange & { challenge: Record<string, unknown> };
  funded: Exchange & { lot: { rail: string; funding_ref_prefix: string; credited_micro: number } };
  refusals: Record<
    "below_minimum" | "declined" | "commitment_mismatch" | "replayed_credential",
    Exchange
  >;
};

async function expectExchange(response: Response, expected: Exchange) {
  expect(response.status).toBe(expected.status);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body).toMatchObject(expected.body);
  return body;
}

describe("card-funded credit discovery", () => {
  it("advertises card funding on /v1/info only as a credit rail", async () => {
    const { app } = await cardServer();
    const body = await (await app.request("/v1/info")).json();
    for (const menu of [discoveryFixture.card_credit, fundFixture.menu]) {
      expect(body.credit.funding).toContain(menu.credit.funding_includes);
      expect(body.credit.stripe).toEqual(menu.credit.stripe);
      for (const method of menu.payment_methods_exclude) {
        expect(body.payment.methods).not.toContain(method);
      }
    }
  });

  it("advertises nothing for cards without the rail", async () => {
    const { app } = await cardServer({ stripe: null });
    const body = await (await app.request("/v1/info")).json();
    expect(body.credit.funding).not.toContain("stripe");
    expect(body.credit).not.toHaveProperty("stripe");
  });

  it("answers an unpaid card fund with one stripe challenge for the amount in cents", async () => {
    const { app, stripe } = await cardServer();
    const response = await fund(app, { fundId: "discover", amountMicro: 600_000 });
    const challenges = paymentChallenges(response);
    const body = await expectExchange(response, fundFixture.discovery);
    expect(body.hint).toEqual(expect.stringContaining("Authorization"));
    expect(challenges).toHaveLength(1);
    expect(challenges[0]).toMatchObject(fundFixture.discovery.challenge);
    expect(stripe!.calls).toHaveLength(0);
  });

  it("never issues a stripe challenge on the job surface", async () => {
    const { app } = await cardServer({ fx: rateFx });
    const response = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "run", data: jobSigner.signRequest(PRIVKEY, {}) }),
    });
    expect(response.status).toBe(402);
    const methods = paymentChallenges(response).map((c) => c.method);
    expect(methods).toContain("tempo");
    expect(methods).not.toContain("stripe");
  });
});

describe("card-funded credit charge", () => {
  it("charges the token once and books the PaymentIntent as the funding", async () => {
    const deposits: CreditDepositPayload[] = [];
    const { app, ledger, stripe } = await cardServer({ deposits });
    const credential = await credentialFor(app, "first");
    await expectExchange(await fund(app, { fundId: "first", credential }), fundFixture.funded);

    expect(stripe!.calls).toHaveLength(1);
    expect(stripe!.calls[0]!.body.get("amount")).toBe("60");
    expect(stripe!.calls[0]!.body.get("currency")).toBe("usd");
    expect(stripe!.calls[0]!.body.get("shared_payment_granted_token")).toBe("spt_test");

    const creditId = derivedFundCreditId(CALLER, "first");
    const lots = await ledger.listFundingLots(creditId);
    const lot = fundFixture.funded.lot;
    expect(lots).toMatchObject([
      { rail: lot.rail, creditedMicro: lot.credited_micro, remainingMicro: lot.credited_micro },
    ]);
    expect(lots[0]!.fundingRef).toBe("pi_test_1");
    expect(lots[0]!.fundingRef!.startsWith(lot.funding_ref_prefix)).toBe(true);
    expect((await ledger.get(creditId))?.rail).toBe("stripe");
    expect(deposits).toMatchObject([
      { rail: "stripe", fundingId: "pi_test_1", nativeAmount: 60, nativeAsset: "usd-cents" },
    ]);
  });

  it("books nothing new when the same credential is replayed under another fund_id", async () => {
    const { app, ledger, stripe } = await cardServer();
    const credential = await credentialFor(app, "original");
    expect((await fund(app, { fundId: "original", credential })).status).toBe(200);

    const replay = await fund(app, { fundId: "replayed", credential });
    await expectExchange(replay, fundFixture.refusals.replayed_credential);
    // Stripe answered the replay from its idempotency cache: still one PaymentIntent.
    expect(new Set(stripe!.calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(await ledger.get(derivedFundCreditId(CALLER, "replayed"))).toBeUndefined();
    const lots = await ledger.listFundingLots(derivedFundCreditId(CALLER, "original"));
    expect(lots).toHaveLength(1);
  });

  it("refuses a credential whose commitment the signed body does not carry, before charging", async () => {
    const { app, ledger, stripe } = await cardServer();
    const credential = await credentialFor(app, "mismatch");
    const response = await fund(app, {
      fundId: "mismatch",
      credential,
      commitment: "ab".repeat(32),
    });
    await expectExchange(response, fundFixture.refusals.commitment_mismatch);
    expect(stripe!.calls).toHaveLength(0);
    expect(await ledger.get(derivedFundCreditId(CALLER, "mismatch"))).toBeUndefined();
  });

  it("refuses a top-up below the card minimum with a hint, before charging", async () => {
    const { app, stripe } = await cardServer({ minUsd: "0.50" });
    const response = await fund(app, { fundId: "small", amountMicro: 300_000 });
    const body = await expectExchange(response, fundFixture.refusals.below_minimum);
    expect(body.hint).toEqual(expect.stringContaining("$0.50"));
    expect(stripe!.calls).toHaveLength(0);
  });

  it("defaults the card minimum to $5, so a $1 top-up is refused before charging", async () => {
    const { app, stripe } = await cardServer({ minUsd: null });
    const info = await (await app.request("/v1/info")).json();
    expect(info.credit.stripe.min_micro).toBe(5_000_000);
    const response = await fund(app, { fundId: "one-dollar", amountMicro: 1_000_000 });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ error: "below_rail_minimum", rail: "stripe", min_micro: 5_000_000 });
    expect(body.hint).toEqual(expect.stringContaining("$5.00"));
    expect(stripe!.calls).toHaveLength(0);
  });

  it("accepts a $1 top-up once the builder sets a $1 card minimum", async () => {
    const { app, ledger } = await cardServer({ minUsd: "1" });
    const info = await (await app.request("/v1/info")).json();
    expect(info.credit.stripe.min_micro).toBe(1_000_000);
    const credential = await credentialFor(app, "one-dollar", 1_000_000);
    const response = await fund(app, { fundId: "one-dollar", amountMicro: 1_000_000, credential });
    expect(response.status).toBe(200);
    expect((await ledger.get(derivedFundCreditId(CALLER, "one-dollar")))?.balanceMicro).toBe(1_000_000);
  });

  it("still offers card when the credit maximum is under $5, with the maximum as the minimum", async () => {
    const { app } = await cardServer({ minUsd: null, credit: { min: "$0.10", max: "$3.00" } });
    const info = await (await app.request("/v1/info")).json();
    expect(info.credit.funding).toContain("stripe");
    expect(info.credit.stripe.min_micro).toBe(3_000_000);
  });

  it("refuses to boot when the builder's card minimum is above the credit maximum", async () => {
    await expect(
      cardServer({ minUsd: "6", credit: { min: "$0.10", max: "$5.00" } })
    ).rejects.toThrow(/DVMKIT_STRIPE_MIN_USD.*\$0\.50 to \$5/);
  });

  it("refuses a declined card with a relayable hint and books nothing", async () => {
    const { app, ledger, stripe } = await cardServer({ stripe: fakeStripe("decline") });
    const credential = await credentialFor(app, "declined");
    const response = await fund(app, { fundId: "declined", credential });
    const body = await expectExchange(response, fundFixture.refusals.declined);
    expect(body.decline_code).toBe("generic_decline");
    expect(body.hint).toEqual(expect.stringContaining("Link"));
    expect(stripe!.calls).toHaveLength(1);
    expect(await ledger.get(derivedFundCreditId(CALLER, "declined"))).toBeUndefined();
  });

  it("books a charge whose outcome was lost when the same credential is resent", async () => {
    const stripe = fakeStripe("lose-first-response");
    const { app, ledger } = await cardServer({ stripe });
    const credential = await credentialFor(app, "lost");
    const creditId = derivedFundCreditId(CALLER, "lost");

    const unknown = await fund(app, { fundId: "lost", credential });
    expect(unknown.status).toBe(503);
    expect(paymentChallenges(unknown)).toEqual([]);
    expect(await unknown.json()).toMatchObject({ reason: "indeterminate", retryable: true });
    expect(await ledger.get(creditId)).toBeUndefined();

    const resent = await fund(app, { fundId: "lost", credential });
    expect(resent.status).toBe(200);
    expect(new Set(stripe.calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(await ledger.listFundingLots(creditId)).toMatchObject([
      { rail: "stripe", fundingRef: "pi_test_1", creditedMicro: 600_000 },
    ]);
  });

  it("refuses a credential bound to a different amount, before charging", async () => {
    const { app, stripe } = await cardServer();
    const credential = await credentialFor(app, "amount", 600_000);
    const response = await fund(app, { fundId: "amount", credential, amountMicro: 700_000 });
    expect(response.status).toBe(402);
    expect((await response.json()).reason).toBe("invalid_credential");
    expect(stripe!.calls).toHaveLength(0);
  });

  it("refuses card funding on a DVM without the rail", async () => {
    const { app } = await cardServer({ stripe: null });
    const response = await fund(app, { fundId: "none" });
    expect(response.status).toBe(409);
    expect((await response.json()).hint).toEqual(expect.stringContaining("credit.funding"));
  });
});
