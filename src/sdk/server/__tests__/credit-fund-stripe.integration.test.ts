/* Card-funded credit against Stripe test mode: a real test Shared Payment Token, a real
 * PaymentIntent, the ledger booking it, and the refund of what is left. Runs only with STRIPE_TEST_SECRET_KEY (an sk_test_
 * or rk_test_ key); every other run skips it and stays offline. */
import { Credential } from "mppx";
import { describe, expect, it } from "vitest";

import { announceTier } from "../../../test-support/tier-announce";
import { derivedFundCreditId } from "../funding";
import { createStripeCreditRail } from "../stripe-credit";
import {
  CALLER,
  cardServer,
  drain,
  fund,
  HMAC,
  paymentChallenges,
  type App,
} from "./__helpers__/card-credit";

const KEY = process.env.STRIPE_TEST_SECRET_KEY;
// A restricted test key (rk_test_) proves the permissions OPERATING.md lists.
if (KEY && !/^(sk|rk)_test_/.test(KEY)) {
  throw new Error("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode key (sk_test_… or rk_test_…)");
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

async function stripeGet<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
  });
  return (await response.json()) as T;
}

async function paymentIntent(id: string): Promise<{ amount: number; status: string }> {
  return stripeGet(`/v1/payment_intents/${id}`);
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

async function credential(app: App, fundId: string, spt: string, amountMicro = AMOUNT_MICRO): Promise<string> {
  const discovery = await fund(app, { fundId, amountMicro });
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

  it("refunds what is left of a $2 top-up to the card, less the matching share of Stripe's fee", async () => {
    const { app, ledger } = await liveServer();
    const card = await credential(app, "live-refund", await testSpt("pm_card_visa", 200), 2_000_000);
    expect((await fund(app, { fundId: "live-refund", credential: card, amountMicro: 2_000_000 })).status).toBe(200);
    const creditId = derivedFundCreditId(CALLER, "live-refund");
    await ledger.draw({ creditId, drawId: "job", amountMicro: 300_000, jobId: "job" });
    await ledger.settle({ creditId, drawId: "job" });

    // Stripe attaches the charge's fee a few seconds after the charge; until then the drain
    // stays pending and each poll (the same drain request again) retries it.
    let body: { drain: Record<string, any>; credit: Record<string, any> } | undefined;
    for (let poll = 0; poll < 20; poll++) {
      const response = await drain(app, { creditId, drainId: "refund", method: "stripe", payout: {} });
      expect(response.status).toBe(200);
      body = await response.json();
      if (body!.drain.status !== "pending") break;
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    body = body!;
    expect(body.drain).toMatchObject({ method: "stripe", status: "sent", amount_micro: 1_700_000 });
    expect(body.credit.balance_micro).toBe(0);
    expect(body.drain.refund_ids).toHaveLength(1);

    // The fee comes from Stripe's own balance transaction, read here independently of the leg.
    const [lot] = await ledger.listFundingLots(creditId);
    const intent = await stripeGet<{ latest_charge: { balance_transaction: { amount: number; fee: number } } }>(
      `/v1/payment_intents/${lot!.fundingRef}?expand[]=latest_charge.balance_transaction`
    );
    // Both in the account's settlement currency, which need not be USD: the ratio carries over.
    const { amount: settled, fee } = intent.latest_charge.balance_transaction;
    const feeShare = Math.round((fee * 170) / settled);
    expect(body.drain.card_refund).toMatchObject({ refunded_cents: 170 - feeShare, stripe_fee_share_cents: feeShare });

    const refund = await stripeGet<{ amount: number; payment_intent: string; status: string }>(
      `/v1/refunds/${body.drain.refund_ids[0]}`
    );
    expect(refund).toMatchObject({ amount: 170 - feeShare, payment_intent: lot!.fundingRef, status: "succeeded" });
  }, 120_000);
});
