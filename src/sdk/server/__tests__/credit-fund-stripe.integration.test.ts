/* Card-funded credit against Stripe test mode: a real test Shared Payment Token, a real
 * PaymentIntent, and the ledger booking it. Runs only with STRIPE_TEST_SECRET_KEY (an sk_test_
 * key); every other run skips it and stays offline. */
import { Credential } from "mppx";
import { describe, expect, it } from "vitest";

import { announceTier } from "../../../test-support/tier-announce";
import { derivedFundCreditId } from "../funding";
import { createStripeCreditRail } from "../stripe-credit";
import {
  CALLER,
  cardServer,
  fund,
  HMAC,
  paymentChallenges,
  type App,
} from "./__helpers__/card-credit";

const KEY = process.env.STRIPE_TEST_SECRET_KEY;
if (KEY && !KEY.startsWith("sk_test_")) {
  throw new Error("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode key (sk_test_…)");
}
if (KEY) announceTier("stripe test mode", "ran", "STRIPE_TEST_SECRET_KEY is set");

const AMOUNT_MICRO = 600_000;

/** Stripe's test helper stands in for the human approving a spend request in Link. */
async function testSpt(paymentMethod: string, cents: number): Promise<string> {
  const response = await fetch(
    "https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        payment_method: paymentMethod,
        "usage_limits[currency]": "usd",
        "usage_limits[max_amount]": String(cents),
        "usage_limits[expires_at]": String(Math.floor(Date.now() / 1000) + 3600),
      }),
    }
  );
  const body = (await response.json()) as { id?: string; error?: { message?: string } };
  if (!response.ok || !body.id) throw new Error(`test SPT: ${body.error?.message ?? response.status}`);
  return body.id;
}

async function paymentIntent(id: string): Promise<{ amount: number; status: string }> {
  const response = await fetch(`https://api.stripe.com/v1/payment_intents/${id}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
  });
  return (await response.json()) as { amount: number; status: string };
}

async function liveServer() {
  return cardServer({
    stripe: null,
    serverOpts: {
      stripeCredit: createStripeCreditRail({
        secretKey: KEY!,
        // What mppx's own test-mode suite uses; the charge never sends it to Stripe.
        networkId: "internal",
        hmacSecret: HMAC,
      }),
    },
  });
}

async function credential(app: App, fundId: string, spt: string): Promise<string> {
  const discovery = await fund(app, { fundId, amountMicro: AMOUNT_MICRO });
  expect(discovery.status).toBe(402);
  const [challenge] = paymentChallenges(discovery);
  expect(challenge?.method).toBe("stripe");
  return Credential.serialize(Credential.from({ challenge: challenge!, payload: { spt } }));
}

describe.skipIf(!KEY)("card-funded credit in Stripe test mode", () => {
  it("charges one PaymentIntent, books it, and books a replay of it nothing", async () => {
    const { app, ledger } = await liveServer();
    const card = await credential(app, "live-visa", await testSpt("pm_card_visa", 60));

    const funded = await fund(app, { fundId: "live-visa", credential: card });
    expect(funded.status).toBe(200);
    expect((await funded.json()).credit.balance_micro).toBe(AMOUNT_MICRO);

    const creditId = derivedFundCreditId(CALLER, "live-visa");
    const lots = await ledger.listFundingLots(creditId);
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ rail: "stripe", creditedMicro: AMOUNT_MICRO });
    expect(lots[0]!.fundingRef).toMatch(/^pi_/);
    expect(await paymentIntent(lots[0]!.fundingRef!)).toMatchObject({
      amount: 60,
      status: "succeeded",
    });

    const replay = await fund(app, { fundId: "live-visa-replay", credential: card });
    expect(replay.status).toBe(409);
    expect(await ledger.get(derivedFundCreditId(CALLER, "live-visa-replay"))).toBeUndefined();
    expect(await ledger.listFundingLots(creditId)).toHaveLength(1);
  }, 30_000);

  it("refuses a declined card with a hint and books nothing", async () => {
    const { app, ledger } = await liveServer();
    const card = await credential(app, "live-decline", await testSpt("pm_card_chargeDeclined", 60));
    const response = await fund(app, { fundId: "live-decline", credential: card });
    expect(response.status).toBe(402);
    const body = await response.json();
    expect(body.reason).toBe("declined");
    expect(typeof body.hint).toBe("string");
    expect(await ledger.get(derivedFundCreditId(CALLER, "live-decline"))).toBeUndefined();
  }, 30_000);
});
