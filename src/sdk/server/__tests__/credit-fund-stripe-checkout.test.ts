import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { parseCreditMenu, parseCreditTerms } from "../../../lib/transport/types";
import { runCardRefundSweep } from "../card-refund-sweep";
import { derivedFundCreditId } from "../funding";
import type { CreditDepositPayload } from "../revenue-reporter";
import { CHECKOUT_ABANDONED_AFTER_MS, CHECKOUT_RECOVERY_BACKOFF_MS } from "../stripe-checkout-recovery";
import { stripeCreditConfigFromEnv } from "../stripe-credit";
import { CALLER, cardServer, drain } from "./__helpers__/card-credit";
import { fundStripeCheckout, CHECKOUT_CREATE_WINDOW_MS } from "../stripe-checkout-funding";
import { checkoutFund, checkoutServer, checkoutTestStore } from "./__helpers__/stripe-checkout";

const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/credit-fund-stripe-checkout-v1.json", import.meta.url), "utf8"));

async function exchange(response: Response, expected: { status: number; body: object }) {
  expect(response.status).toBe(expected.status);
  const body = await response.json();
  expect(body).toMatchObject(expected.body);
  return body;
}

async function sweep(server: Awaited<ReturnType<typeof checkoutServer>>, delay = 0) {
  return runCardRefundSweep({ ledger: server.ledger, stripe: server.rail.refunds,
    checkout: server.rail.checkout, drainReport: {} }, {
    nowMs: Date.now() + CHECKOUT_ABANDONED_AFTER_MS + 1000 + delay,
  });
}

describe("hosted card top-ups", () => {
  it("serves the signed wire fixture, reuses one session, and books one normal card deposit", async () => {
    const deposits: CreditDepositPayload[] = [];
    const server = await checkoutServer({ deposits });
    const { app, account, ledger } = server;
    const { credit_id: _credit, checkout, ...pendingBody } = fixture.pending.body;
    const { expires_at: _expires, ...checkoutBody } = checkout;
    const pending = await exchange(await checkoutFund(app, fixture.request.fund.fund_id, fixture.request.fund),
      { status: fixture.pending.status, body: { ...pendingBody, checkout: checkoutBody } });
    expect(pending.credit_id).toBe(derivedFundCreditId(CALLER, "checkout"));
    expect(pending.checkout.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000) + 3500);
    expect(await (await checkoutFund(app)).json()).toEqual(pending);
    expect(account.forms).toHaveLength(1);
    account.paid("checkout");
    await exchange(await checkoutFund(app), fixture.funded);
    expect((await (await checkoutFund(app)).json()).replayed).toBe(true);
    expect(await ledger.listFundingLots(pending.credit_id)).toMatchObject([
      { rail: "stripe", fundingRef: "pi_cs_test_1", creditedMicro: 5_000_000, remainingMicro: 5_000_000 },
    ]);
    expect(deposits).toMatchObject([
      { rail: "stripe", fundingId: "pi_cs_test_1", nativeAmount: 500, nativeAsset: "usd-cents" },
    ]);
    expect(deposits).toHaveLength(1);
    const summary = await sweep(server);
    expect(summary.strandedRefunds).toEqual([]);
    expect(account.refunds).toEqual([]);
  });

  it("sends fixed USD card/link parameters and leaves email collection to Stripe", async () => {
    const { app, account } = await checkoutServer();
    await checkoutFund(app);
    const form = account.forms[0]!;
    expect(Object.fromEntries(form)).toMatchObject({
      mode: "payment", submit_type: "pay", client_reference_id: "checkout",
      "line_items[0][price_data][currency]": "usd", "line_items[0][price_data][unit_amount]": "500",
      "line_items[0][price_data][product_data][name]": "card-credit prepaid credit",
      "line_items[0][quantity]": "1", "payment_method_types[0]": "card", "payment_method_types[1]": "link",
      success_url: "https://example.com/complete", "adaptive_pricing[enabled]": "false",
    });
    for (const key of ["customer_email", "customer", "customer_creation", "payment_intent_data[metadata][mpp_challenge_id]", "allow_promotion_codes", "automatic_tax[enabled]"]) expect(form.has(key)).toBe(false);
    for (const prefix of ["metadata", "payment_intent_data[metadata]"]) {
      expect(form.get(`${prefix}[fund_id]`)).toBe("checkout");
      expect(form.get(`${prefix}[credit_id]`)).toBe(derivedFundCreditId(CALLER, "checkout"));
      expect(form.get(`${prefix}[caller_pubkey]`)).toBe(CALLER);
    }
    expect(account.headers[0]!.get("Idempotency-Key")).toMatch(/^dvmkit-checkout-[0-9a-f]{64}$/);
  });

  it("authenticates and journals before creating a Stripe session", async () => {
    const store = checkoutTestStore();
    const server = await checkoutServer({ checkoutStore: store });
    const unsigned = await server.app.request("/v1/credit", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fixture.request),
    });
    expect(unsigned.status).toBe(401);
    expect(await store.get("checkout")).toBeUndefined();
    store.create = () => Promise.reject(new Error("Database unavailable"));
    expect((await checkoutFund(server.app)).status).toBe(503);
    expect(server.account.forms).toEqual([]);
  });

  it("recovers a lost create reply with identical parameters and key", async () => {
    const { app, account } = await checkoutServer();
    account.loseCreateReply();
    expect((await checkoutFund(app)).status).toBe(503);
    expect((await checkoutFund(app)).status).toBe(202);
    expect(account.sessions.size).toBe(1);
    expect(account.forms[0]!.toString()).toBe(account.forms[1]!.toString());
    expect(account.headers[0]!.get("Idempotency-Key")).toBe(account.headers[1]!.get("Idempotency-Key"));
  });

  it("expires unpaid sessions without a deposit", async () => {
    const { app, account, ledger } = await checkoutServer();
    await checkoutFund(app);
    account.sessions.get("cs_test_1")!.status = "expired";
    await exchange(await checkoutFund(app), fixture.checkout_expired);
    expect(await ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
  });

  it.each(["fund_id", "credit_id", "caller_pubkey", "dvmkit_dvm_id", "dvmkit_checkout_store", "amount", "currency", "pi_metadata", "pi_dvm", "pi_store", "payment_status"])(
    "refuses paid evidence with mismatched %s before any credit is booked", async (field) => {
      const { app, account, ledger } = await checkoutServer();
      await checkoutFund(app);
      const session = account.paid("checkout");
      if (["fund_id", "credit_id", "caller_pubkey", "dvmkit_dvm_id", "dvmkit_checkout_store"].includes(field)) session.metadata[field] = "wrong";
      if (field === "amount") session.payment_intent!.amount = 501;
      if (field === "currency") session.payment_intent!.currency = "eur";
      if (field === "pi_metadata") session.payment_intent!.metadata.credit_id = "wrong";
      if (field === "pi_dvm") session.payment_intent!.metadata.dvmkit_dvm_id = "wrong";
      if (field === "pi_store") session.payment_intent!.metadata.dvmkit_checkout_store = "wrong";
      if (field === "payment_status") session.payment_status = "unpaid";
      const response = await checkoutFund(app);
      expect(response.status).not.toBe(200);
      expect(await ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
    }
  );

  it("refuses a changed signed amount under an existing fund id", async () => {
    const { app, account } = await checkoutServer();
    await checkoutFund(app);
    expect((await checkoutFund(app, "checkout", { amount_micro: 4_000_000 })).status).toBe(409);
    expect(account.forms).toHaveLength(1);
  });

  it("books nothing on a Stripe read timeout and lets the same paid poll retry", async () => {
    const { app, account, ledger } = await checkoutServer();
    await checkoutFund(app);
    account.paid("checkout");
    account.failReads();
    await exchange(await checkoutFund(app), { status: 503, body: { retryable: true } });
    expect(await ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
    account.failReads(false);
    expect((await checkoutFund(app)).status).toBe(200);
  });

  it("refunds an abandoned payment and makes a late poll terminal", async () => {
    const server = await checkoutServer();
    await checkoutFund(server.app);
    server.account.paid("checkout");
    const early = await runCardRefundSweep({ ledger: server.ledger, stripe: server.rail.refunds,
      checkout: server.rail.checkout, drainReport: {} }, { nowMs: Date.now() + 2 * 3600_000 });
    expect(early.strandedRefunds).toEqual([]);
    expect(server.account.refunds).toEqual([]);
    expect((await sweep(server)).strandedRefunds).toEqual(["pi_cs_test_1"]);
    const body = await exchange(await checkoutFund(server.app), fixture.checkout_expired);
    expect(body.hint).toContain("refunded to the card");
    expect(await server.ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
    await sweep(server);
    expect(server.account.refunds).toMatchObject([{ amount: 500 }]);
    expect(server.account.refunds).toHaveLength(1);
  });

  it.each(["needs_response", "under_review", "warning_needs_response", "warning_under_review", "appeal_under_review", "warning_closed", "prevented", "won", "lost"])(
    "recovers a disputed abandoned charge by dispute status: %s", async (status) => {
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      const server = await checkoutServer();
      await checkoutFund(server.app);
      server.account.paid("checkout");
      server.account.dispute("pi_cs_test_1", status);
      const summary = await sweep(server);
      const record = (await server.store.get("checkout"))!;
      expect(await server.ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
      if (["won", "warning_closed", "prevented"].includes(status)) {
        expect(summary.strandedRefunds).toEqual(["pi_cs_test_1"]);
        expect(server.account.refunds).toMatchObject([{ payment_intent: "pi_cs_test_1", amount: 500 }]);
        expect(record.state).toBe("refunded");
      } else if (status === "lost") {
        expect(record).toMatchObject({ state: "expired", terminalReason: "dispute_lost" });
        expect(server.account.refunds).toEqual([]);
        expect(warnings.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({
          event: "card_checkout_dispute_lost", session_id: "cs_test_1", payment_intent: "pi_cs_test_1",
        }));
        const response = await exchange(await checkoutFund(server.app), fixture.checkout_expired);
        expect(response.hint).toBe(fixture.checkout_expired.dispute_lost_hint);
        await sweep(server, CHECKOUT_RECOVERY_BACKOFF_MS + 1000);
        expect(server.account.refunds).toEqual([]);
      } else {
        expect(record.state).toBe("refunding");
        expect(record.nextRecoveryAt).toBeGreaterThan(Date.now() + CHECKOUT_ABANDONED_AFTER_MS);
        expect(server.account.refunds).toEqual([]);
      }
    }
  );

  it("refunds only the undisputed remainder after a partial loss and a prior refund", async () => {
    const server = await checkoutServer();
    await checkoutFund(server.app);
    server.account.paid("checkout");
    server.account.dispute("pi_cs_test_1", "lost", 200);
    server.account.refunds.push({ id: "re_prior", amount: 100, payment_intent: "pi_cs_test_1", status: "succeeded", metadata: {} });
    server.account.loseRefundReply();
    await sweep(server);
    expect(server.account.refunds).toMatchObject([{ amount: 100 }, { payment_intent: "pi_cs_test_1", amount: 200 }]);
    expect((await sweep(server, CHECKOUT_RECOVERY_BACKOFF_MS + 1000)).strandedRefunds).toEqual(["pi_cs_test_1"]);
    expect(server.account.refunds).toHaveLength(2);
    expect((await server.store.get("checkout"))?.state).toBe("refunded");
    await exchange(await checkoutFund(server.app), fixture.checkout_expired);
    expect(await server.ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
  });

  it.each([403, 404])("diagnoses an unreadable recorded session (%s) without losing its obligation", async (status) => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await checkoutServer();
    await checkoutFund(server.app);
    server.account.paid("checkout");
    server.account.rejectReads(status);
    await sweep(server);
    expect(warnings.mock.calls.map(([value]) => JSON.parse(value))).toContainEqual(expect.objectContaining({
      event: status === 403 ? "card_checkout_session_permission_denied" : "card_checkout_session_missing",
      session_id: "cs_test_1", retry_after_ms: CHECKOUT_RECOVERY_BACKOFF_MS,
    }));
    expect(warnings.mock.calls.map(([value]) => JSON.parse(value).event)).not.toContain("card_checkout_recovery_deferred");
    expect((await server.store.get("checkout"))?.state).toBe("open");
    expect(server.account.refunds).toEqual([]);
    expect(await server.ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
    server.account.rejectReads(0);
    expect((await sweep(server, CHECKOUT_RECOVERY_BACKOFF_MS + 1000)).strandedRefunds).toEqual(["pi_cs_test_1"]);
  });

  it("reconciles a lost refund reply without opening booking or refunding twice", async () => {
    const server = await checkoutServer();
    await checkoutFund(server.app);
    server.account.paid("checkout");
    server.account.loseRefundReply();
    await sweep(server);
    await exchange(await checkoutFund(server.app), fixture.checkout_expired);
    expect((await sweep(server, CHECKOUT_RECOVERY_BACKOFF_MS + 1000)).strandedRefunds).toEqual(["pi_cs_test_1"]);
    expect(server.account.refunds).toHaveLength(1);
  });

  it("does not recover an unrecorded session in a shared Stripe account", async () => {
    const accountOwner = await checkoutServer();
    await checkoutFund(accountOwner.app);
    accountOwner.account.paid("checkout");
    const other = await checkoutServer({ account: accountOwner.account });
    await sweep(other);
    expect(other.account.refunds).toEqual([]);
  });

  it("refuses unsupported checkout and unknown via with actionable errors", async () => {
    const { app } = await cardServer();
    const unsupported = await exchange(await checkoutFund(app), { status: 409, body: { error: "checkout_not_supported" } });
    expect(unsupported.hint).toContain("token path");
    expect((await checkoutFund(app, "other", { via: "unknown" })).status).toBe(400);
    expect((await checkoutFund(app, "other", { method: "lightning" })).status).toBe(400);
  });

  it("advertises opt-in through both caller menu parsers", async () => {
    const { app } = await checkoutServer();
    const info = await (await app.request("/v1/info")).json();
    expect(info.credit.stripe.checkout).toBe(true);
    expect(parseCreditTerms(info.credit)?.stripe?.checkout).toBe(true);
    expect(parseCreditMenu(info.credit)?.stripe?.checkout).toBe(true);
    expect(parseCreditTerms({ ...info.credit, stripe: { ...info.credit.stripe, checkout: "yes" } })).toBeUndefined();
    const plain = await cardServer();
    expect((await (await plain.app.request("/v1/info")).json()).credit.stripe).not.toHaveProperty("checkout");
  });

  it.each(["store", "DVM"])("scopes equal fund blocks by %s on a shared Stripe account", async (binding) => {
    const a = await checkoutServer({ serverOpts: { dvmId: "seller-a" } });
    const isolated = checkoutTestStore();
    const b = await checkoutServer({ account: a.account,
      checkoutStore: binding === "DVM" ? { ...isolated, namespace: a.store.namespace } : isolated,
      serverOpts: { dvmId: binding === "DVM" ? "seller-b" : "seller-a" },
    });
    const first = await (await checkoutFund(a.app, "shared")).json();
    const second = await (await checkoutFund(b.app, "shared")).json();
    expect(second.checkout.url).not.toBe(first.checkout.url);
    const paid = a.account.paid("shared");
    expect((await checkoutFund(a.app, "shared")).status).toBe(200);
    expect((await checkoutFund(b.app, "shared")).status).toBe(202);
    expect(await b.ledger.get(derivedFundCreditId(CALLER, "shared"))).toBeUndefined();
    // Substituting the other store's evidence is refused even with an identical signed fund.
    const own = a.account.sessions.get("cs_test_2")!;
    a.account.sessions.set("cs_test_2", { ...paid, id: own.id });
    expect((await checkoutFund(b.app, "shared")).status).toBe(409);
    expect(await b.ledger.get(derivedFundCreditId(CALLER, "shared"))).toBeUndefined();
  });

  it("attributes Checkout to the server's canonical DVM identity", async () => {
    const server = await checkoutServer({ serverOpts: { dvmId: "deployment-id", canonicalDvmId: fixture.stripe_metadata.dvmkit_dvm_id } });
    await checkoutFund(server.app);
    const form = server.account.forms[0]!;
    expect(form.get("metadata[dvmkit_dvm_id]")).toBe(fixture.stripe_metadata.dvmkit_dvm_id);
    expect(form.get("payment_intent_data[metadata][dvmkit_dvm_id]")).toBe(fixture.stripe_metadata.dvmkit_dvm_id);
  });

  it.each([403, 400, 404])("returns a terminal cause for Stripe create %s", async (status) => {
    const server = await checkoutServer();
    server.account.rejectCreates(status);
    const response = await checkoutFund(server.app);
    const body = await response.json();
    expect(response.status).toBe(502);
    if (status === 403) expect(body).toMatchObject(fixture.permission_error.body);
    expect(body).toMatchObject({ error: "checkout_unavailable", retryable: false,
      cause: status === 403 ? "permission_denied" : "invalid_request", stripe_status: status });
    expect((await server.store.get("checkout"))?.state).toBe("expired");
  });

  it.each([403, 404])("returns a terminal cause for Stripe read %s and retains refund recovery", async (status) => {
    const server = await checkoutServer();
    await checkoutFund(server.app);
    server.account.rejectReads(status);
    const response = await checkoutFund(server.app);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ retryable: false, stripe_status: status,
      cause: status === 403 ? "permission_denied" : "resource_missing" });
    expect((await server.store.get("checkout"))?.state).toBe("open");
  });

  it("rejects oversized fund ids and sizing refusals without persisting attempts", async () => {
    const server = await checkoutServer();
    const long = "x".repeat(201);
    expect((await checkoutFund(server.app, long)).status).toBe(400);
    expect(await server.store.get(long)).toBeUndefined();
    expect((await checkoutFund(server.app, "small", { amount_micro: 10_000 })).status).toBe(400);
    expect(await server.store.get("small")).toBeUndefined();
    expect(server.account.forms).toEqual([]);
  });

  it("expires an unshown create retry after the 30-minute window without a Stripe lookup", async () => {
    const server = await checkoutServer();
    server.account.loseCreateReply();
    expect((await checkoutFund(server.app)).status).toBe(503);
    const snapshot = (await server.store.get("checkout"))!;
    const result = await fundStripeCheckout({ rail: server.rail.checkout!, opts: { requiredMsats: 0, creditLedger: server.ledger },
      fundId: "checkout", creditId: snapshot.creditId, callerPubkey: CALLER, amountMicro: 5_000_000,
      productName: snapshot.productName, preflight: async () => undefined,
      nowMs: snapshot.createdAt + CHECKOUT_CREATE_WINDOW_MS + 1 });
    expect(result.funded).toBe(false);
    if (!result.funded) expect((await result.response.json()).error).toBe("checkout_expired");
    expect(server.account.forms).toHaveLength(1);
    expect(server.account.refunds).toEqual([]);
    expect(server.account.searches).toBe(0);
  });

  it("drains Checkout credit against its original PaymentIntent", async () => {
    const server = await checkoutServer();
    await checkoutFund(server.app);
    const paid = server.account.paid("checkout");
    expect((await checkoutFund(server.app)).status).toBe(200);
    const creditId = derivedFundCreditId(CALLER, "checkout");
    const response = await drain(server.app, { creditId, drainId: "return-checkout", method: "stripe", payout: {} });
    expect(response.status).toBe(200);
    expect((await response.json()).drain.status).toBe("sent");
    expect(server.account.refunds).toMatchObject([{ payment_intent: paid.payment_intent!.id, amount: 455 }]);
    expect((await server.ledger.get(creditId))?.balanceMicro).toBe(0);
  });

  it.each(["", "http://example.com", "invalid", "https://user:password@example.com"])("fails startup for invalid success URL %j", (value) => {
    expect(() => stripeCreditConfigFromEnv({ DVMKIT_STRIPE_CHECKOUT_SUCCESS_URL: value })).toThrow("DVMKIT_STRIPE_CHECKOUT_SUCCESS_URL");
  });
});
