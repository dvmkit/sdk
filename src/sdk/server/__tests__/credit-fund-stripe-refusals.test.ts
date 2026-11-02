/* Card credit's refusals: what a card balance may never be drained to, what Stripe's error
 * text may never reach, and the failures where nothing (or the wrong thing) was charged. */
import { readFileSync } from "node:fs";

import { Challenge, Credential } from "mppx";
import { afterEach, describe, expect, it, vi } from "vitest";

import { derivedFundCreditId } from "../funding";
import { createStripeCreditRail } from "../stripe-credit";
import {
  CALLER,
  cardServer,
  credentialFor,
  drain,
  fakeStripe,
  fund,
  HMAC,
  jobSigner,
  paymentChallenges,
  PRIVKEY,
  rateFx,
} from "./__helpers__/card-credit";

interface Exchange {
  status: number;
  body: Record<string, unknown>;
}
const { refusals } = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/credit-fund-stripe-v1.json", import.meta.url), "utf8")
) as { refusals: Record<"token_unusable" | "drain_card_credit", Exchange> };

afterEach(() => {
  vi.restoreAllMocks();
});

/** Every line the server writes to the console while `run` executes. */
async function consoleOutput<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...values: unknown[]) => {
      lines.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
    });
  }
  const result = await run();
  return { result, logged: lines.join("\n") };
}

describe("card-funded credit drains only back to the card", () => {
  it("refuses cashu, x402 and tempo drains and records no drain", async () => {
    const { app, ledger } = await cardServer();
    const credential = await credentialFor(app, "held");
    expect((await fund(app, { fundId: "held", credential })).status).toBe(200);
    const creditId = derivedFundCreditId(CALLER, "held");

    const attempts: { method: string; payout: Record<string, string> }[] = [
      { method: "cashu", payout: { refund_pubkey: `02${"a".repeat(64)}` } },
      { method: "x402", payout: { address: `0x${"1".repeat(40)}` } },
      { method: "tempo", payout: { address: `0x${"1".repeat(40)}` } },
    ];
    for (const [index, attempt] of attempts.entries()) {
      const response = await drain(app, { creditId, drainId: `d${index}`, ...attempt });
      expect(response.status, attempt.method).toBe(refusals.drain_card_credit.status);
      const body = await response.json();
      expect(body).toMatchObject(refusals.drain_card_credit.body);
      expect(body.hint).not.toMatch(/cashu|ecash/i);
      expect(body.hint).toMatch(/method "stripe"/);
    }
    expect((await ledger.get(creditId))?.balanceMicro).toBe(600_000);
    expect(await ledger.listPendingDrains()).toEqual([]);
  });

  it("tells the caller an expired card balance goes back to the card", async () => {
    const { app, ledger } = await cardServer();
    await ledger.fund({
      creditId: "expired-card",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 600_000,
      expiryMs: Date.now() - 60_000,
      basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 60, fundingRef: "pi_old" },
    });
    const response = await drain(app, {
      creditId: "expired-card",
      drainId: "d",
      method: "cashu",
      payout: { refund_pubkey: `02${"a".repeat(64)}` },
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.display).toMatch(/has expired/);
    expect(body.display).toMatch(/refunded there automatically/);
  });

  it("refuses a card-credit drain at the ledger, whichever route asks", async () => {
    const { app, ledger } = await cardServer();
    const credential = await credentialFor(app, "direct");
    expect((await fund(app, { fundId: "direct", credential })).status).toBe(200);
    await expect(
      ledger.requestDrain({
        creditId: derivedFundCreditId(CALLER, "direct"),
        drainId: "d",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"a".repeat(64)}` },
      })
    ).rejects.toMatchObject({ code: "rail_mismatch" });
    expect(await ledger.listPendingDrains()).toEqual([]);
  });
});

describe("Stripe's error text", () => {
  it("never reaches the log or the response, even when it quotes the token", async () => {
    for (const mode of ["decline", "unusable-token", "lose-first-response"] as const) {
      const { app } = await cardServer({ stripe: fakeStripe(mode) });
      const credential = await credentialFor(app, mode);
      const { result, logged } = await consoleOutput(() => fund(app, { fundId: mode, credential }));
      const body = await result.text();
      expect(body, mode).not.toContain("spt_");
      expect(logged, mode).not.toContain("spt_");
      expect(logged, mode).toContain("credit_rejected");
    }
  });
});

describe("card charges where nothing, or the wrong thing, was charged", () => {
  it("refuses a token Stripe rejects as terminal, with a fresh challenge and a new-approval hint", async () => {
    const { app, ledger } = await cardServer({ stripe: fakeStripe("unusable-token") });
    const credential = await credentialFor(app, "used");
    const response = await fund(app, { fundId: "used", credential });
    expect(response.status).toBe(refusals.token_unusable.status);
    expect(paymentChallenges(response)).toHaveLength(1);
    const body = await response.json();
    expect(body).toMatchObject({ ...refusals.token_unusable.body, stripe_error_code: "resource_missing" });
    expect(body.hint).toMatch(/new top-up in Link/);
    // A token that may already have been charged by an unanswered request is resent, not replaced.
    expect(body.hint).toMatch(/resend that same request .* first/);
    expect(await ledger.get(derivedFundCreditId(CALLER, "used"))).toBeUndefined();
  });

  it("books nothing when Stripe reports a PaymentIntent for another amount", async () => {
    const { app, ledger } = await cardServer({ stripe: fakeStripe("wrong-amount") });
    const credential = await credentialFor(app, "odd");
    const response = await fund(app, { fundId: "odd", credential });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ reason: "mismatch", payment_intent: "pi_test_1" });
    expect(await ledger.get(derivedFundCreditId(CALLER, "odd"))).toBeUndefined();
  });

  it("tells a replay of a card credential it was already used, in card terms", async () => {
    const { app } = await cardServer();
    const credential = await credentialFor(app, "once");
    expect((await fund(app, { fundId: "once", credential })).status).toBe(200);
    const body = await (await fund(app, { fundId: "again", credential })).json();
    expect(body.error).toBe("replay_rejected");
    expect(`${body.display} ${body.hint}`).not.toMatch(/proof|ecash/i);
    expect(body.hint).toMatch(/Link/);
  });
});

describe("the job surface and card credentials", () => {
  it("refuses a stripe credential on /v1/job without calling Stripe", async () => {
    const { app, stripe } = await cardServer({ fx: rateFx });
    const credential = await credentialFor(app, "job");
    const response = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: credential },
      body: JSON.stringify({ capability: "run", data: jobSigner.signRequest(PRIVKEY, {}) }),
    });
    expect(response.status).toBe(402);
    expect(stripe!.calls).toHaveLength(0);
  });
});

describe("card challenges across a binding-key rotation", () => {
  const ROTATED = "55".repeat(32);

  async function credentialUnder(secret: string): Promise<string> {
    const issuer = createStripeCreditRail({ secretKey: "sk_test_fake", networkId: "profile_test", hmacSecret: secret });
    const challenge: Challenge.Challenge = await issuer.issueChallenge({
      amountMicro: 600_000,
      resourcePath: "/v1/credit",
      expires: new Date(Date.now() + 60_000).toISOString(),
    });
    return Credential.serialize(Credential.from({ challenge, payload: { spt: "spt_test" } }));
  }

  it("charges a credential bound under the previous key while its window is open", async () => {
    const stripe = fakeStripe();
    const rail = createStripeCreditRail({
      secretKey: "sk_test_fake",
      networkId: "profile_test",
      hmacSecret: ROTATED,
      previousHmacSecret: () => Promise.resolve(HMAC),
      apiBase: "https://stripe.invalid",
      fetch: stripe.fetchImpl,
    });
    const outcome = await rail.charge(await credentialUnder(HMAC), {
      amountMicro: 600_000,
      resourcePath: "/v1/credit",
    });
    expect(outcome).toMatchObject({ ok: true, paymentIntentId: "pi_test_1" });
  });

  it("refuses it without charging once no previous key is held", async () => {
    const stripe = fakeStripe();
    const rail = createStripeCreditRail({
      secretKey: "sk_test_fake",
      networkId: "profile_test",
      hmacSecret: ROTATED,
      previousHmacSecret: () => Promise.resolve(undefined),
      apiBase: "https://stripe.invalid",
      fetch: stripe.fetchImpl,
    });
    const outcome = await rail.charge(await credentialUnder(HMAC), {
      amountMicro: 600_000,
      resourcePath: "/v1/credit",
    });
    expect(outcome).toMatchObject({ ok: false, reason: "invalid_credential" });
    expect(stripe.calls).toHaveLength(0);
  });
});
