import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId, fundingCommitment } from "../funding";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { CALLER, cardServer, credentialFor, fakeStripe, paymentChallenges, PRIVKEY, rateFx, type App } from "./__helpers__/card-credit";
import { checkoutServer, fakeCheckoutAccount } from "./__helpers__/stripe-checkout";

const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/credit-fund-stripe-upgrade-v1.json", import.meta.url), "utf8"));
const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function signedFund(extra: Record<string, unknown> = {}) {
  return JSON.stringify(signer.signRequest(PRIVKEY, {
    op: "fund", fund: { ...fixture.fund, ...extra },
  }));
}

function post(app: App, body = signedFund(), headers: Record<string, string> = fixture.request_headers) {
  return app.request("/v1/credit", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body,
  });
}

async function tokenAndCheckoutServer() {
  const stripe = fakeStripe();
  const account = fakeCheckoutAccount();
  const server = await checkoutServer({ account: { ...account,
    fetchImpl: (input, init) => new URL(String(input)).pathname === "/v1/payment_intents" && init?.method === "POST"
      ? stripe.fetchImpl(input, init) : account.fetchImpl(input, init),
  } });
  return { ...server, stripe };
}

describe("old clients funding card credit on a Checkout-enabled server", () => {
  it("returns the portable upgrade notice without creating funding, Checkout, or replay state", async () => {
    const auth = secp256k1Auth();
    const recordReplay = vi.spyOn(auth, "recordReplay");
    const { app, ledger, store, account } = await checkoutServer({ auth });
    const response = await post(app);
    expect(response.status).toBe(fixture.response.status);
    expect(response.headers.get("DVM-Protocol-Version")).toBe(fixture.response.headers["DVM-Protocol-Version"]);
    expect(response.headers.has("WWW-Authenticate")).toBe(false);
    expect(await response.json()).toEqual(fixture.response.body);
    expect(await ledger.getForCaller(CALLER)).toEqual([]);
    expect(await ledger.getFunding({ creditId: derivedFundCreditId(CALLER, "upgrade"), fundId: "upgrade" })).toBeUndefined();
    expect(await store.get("upgrade")).toBeUndefined();
    expect(account.forms).toEqual([]);
    expect(account.sessions.size).toBe(0);
    expect(recordReplay).not.toHaveBeenCalled();
  });

  it.each(["0.18.99", "0.19.0-rc.1", "0.19.0-rc.1+build.2"])("gates SemVer %s below the first Checkout client", async (version) => {
    const { app } = await checkoutServer();
    const response = await post(app, signedFund(), { "DVM-Client": `dvm/${version}` });
    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({ current_client_version: version, minimum_client_version: "0.19.0" });
  });

  it.each([undefined, "dvm/latest", "other/0.15.3", "dvm/0.19.0", "dvm/0.19.0+build.1", "dvm/0.20.0", "dvm/1.0.0"])(
    "preserves the Link challenge for client header %s", async (client) => {
      const { app } = await checkoutServer();
      const response = await post(app, signedFund(), client === undefined ? {} : { "DVM-Client": client });
      expect(response.status).toBe(402);
      expect(paymentChallenges(response)).toMatchObject([{ method: "stripe", intent: "charge" }]);
    }
  );

  it("preserves the Link challenge when Checkout is not configured", async () => {
    const { app, stripe } = await cardServer();
    const response = await post(app);
    expect(response.status).toBe(402);
    expect(paymentChallenges(response)).toMatchObject([{ method: "stripe" }]);
    expect(stripe!.calls).toEqual([]);
  });

  it("preserves sizing refusals before considering an upgrade", async () => {
    const { app } = await checkoutServer();
    const response = await post(app, signedFund({ amount_micro: 100_000 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "below_rail_minimum", min_micro: 500_000 });
  });

  it("returns a booked funding replay to an old unpaid client even when its new amount fails sizing", async () => {
    const { app, ledger, stripe } = await tokenAndCheckoutServer();
    const credential = await credentialFor(app, "upgrade", 5_000_000);
    const paid = await post(app, signedFund({ commitment: fundingCommitment(credential) }), { Authorization: credential });
    expect(paid.status).toBe(200);
    const response = await post(app, signedFund({ amount_micro: 100_000 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, funded_micro: 5_000_000 });
    expect(stripe.calls).toHaveLength(1);
    expect(await ledger.listFundingLots(derivedFundCreditId(CALLER, "upgrade"))).toHaveLength(1);
  });

  it("lets the same signed envelope attach a credential after the upgrade refusal without burning its nonce", async () => {
    const { app, stripe } = await tokenAndCheckoutServer();
    const credential = await credentialFor(app, "upgrade", 5_000_000);
    const body = signedFund({ commitment: fundingCommitment(credential) });
    expect((await post(app, body)).status).toBe(426);
    const paid = await post(app, body, { ...fixture.request_headers, Authorization: credential });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ replayed: false, funded_micro: 5_000_000 });
    expect(stripe.calls).toHaveLength(1);
  });

  it.each(["X-Cashu", "X-PAYMENT", "PAYMENT-SIGNATURE", "Authorization"])("does not gate a request carrying %s", async (header) => {
    const { app } = await checkoutServer();
    const response = await post(app, signedFund(), { ...fixture.request_headers,
      [header]: header === "Authorization" ? "payment invalid-credential" : "invalid-proof",
    });
    expect(response.status).toBe(402);
    expect((await response.json()).error).not.toBe("client_upgrade_required");
  });

  it("lets an old client explicitly request Checkout", async () => {
    const { app } = await checkoutServer();
    const body = JSON.stringify(signer.signRequest(PRIVKEY, {
      op: "fund", fund: { method: "stripe", via: "checkout", fund_id: "upgrade", amount_micro: 5_000_000 },
    }));
    const response = await post(app, body);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "pending", checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_1" } });
  });

  it.each([
    { method: "lightning", commitment: undefined, expectedStatus: 503 },
    { method: "tempo", intent: "session", expectedStatus: 402 },
    { method: undefined, expectedStatus: 402 },
  ])("does not gate non-card funding $method", async ({ expectedStatus, ...extra }) => {
    const { app } = await checkoutServer({ fx: rateFx });
    const response = await post(app, signedFund(extra));
    expect(response.status).toBe(expectedStatus);
    expect((await response.json()).error).not.toBe("client_upgrade_required");
  });
});
