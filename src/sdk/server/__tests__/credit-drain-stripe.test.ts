/* Refunding card-funded credit to the card: the fee rule, lot order, retries that must never
 * refund twice, and the pairings of funding rail and drain method that are refused. */
import { readFileSync } from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import type { CreditLedgerLike } from "../credit-ledger";
import { derivedFundCreditId } from "../funding";
import { toLockPubkey } from "../lock-pubkey-store";
import { createStripeRefundApi } from "../stripe-refund-api";
import { CALLER, cardServer, credentialFor, drain, fund, type App } from "./__helpers__/card-credit";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { fakeStripeAccount, type FakeStripeAccount } from "./__helpers__/fake-stripe-account";

interface Exchange {
  status: number;
  body: Record<string, unknown>;
}
const fixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/credit-drain-stripe-v1.json", import.meta.url), "utf8")
) as {
  fee_example: Record<string, number>;
  sent: Exchange;
  pending: Exchange;
  refusals: Record<
    "card_credit_other_method" | "stripe_for_non_card_credit" | "stripe_with_payout" | "closed_card_credit",
    Exchange
  >;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A card credit funded through the real fund route, then drawn down by `drawnMicro`. */
async function fundedCard(
  account: FakeStripeAccount,
  args: { fundId: string; amountMicro: number; drawnMicro: number }
) {
  const server = await cardServer({ stripe: account });
  const credential = await credentialFor(server.app, args.fundId, args.amountMicro);
  const funded = await fund(server.app, { fundId: args.fundId, amountMicro: args.amountMicro, credential });
  expect(funded.status).toBe(200);
  const creditId = derivedFundCreditId(CALLER, args.fundId);
  await drawAndSettle(server.ledger, creditId, args.drawnMicro);
  return { ...server, creditId };
}

async function drawAndSettle(ledger: CreditLedgerLike, creditId: string, amountMicro: number) {
  if (amountMicro === 0) return;
  await ledger.draw({ creditId, drawId: "job-1", amountMicro, jobId: "job-1" });
  await ledger.settle({ creditId, drawId: "job-1" });
}

async function cardDrain(app: App, creditId: string, drainId = "refund-1"): Promise<Response> {
  return drain(app, { creditId, drainId, method: "stripe", payout: {} });
}

function refundCreates(account: FakeStripeAccount) {
  return account.calls.filter((call) => call.method === "POST" && call.path === "/v1/refunds");
}

describe("a stripe drain of card credit", () => {
  it("refunds the unspent balance to the card, less the refund's share of Stripe's fee", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "two-dollars",
      amountMicro: 2_000_000,
      drawnMicro: 300_000,
    });

    const response = await cardDrain(app, creditId);
    expect(response.status).toBe(fixture.sent.status);
    const body = await response.json();
    expect(body).toMatchObject(fixture.sent.body);
    expect(body.drain.refund_ids).toEqual([expect.stringMatching(/^re_/)]);
    expect(body.drain.sent.refund_ids).toEqual(body.drain.refund_ids);
    // The plain-words account of the deduction, in dollars.
    expect(body.display).toContain("$1.39 went back to the card");
    expect(body.display).toContain("$0.31 of the $1.70 balance");

    const creates = refundCreates(account);
    expect(creates).toHaveLength(1);
    expect(creates[0]!.body.get("payment_intent")).toBe("pi_test_1");
    expect(creates[0]!.body.get("amount")).toBe(String(fixture.fee_example.refunded_cents));
    expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
    expect(await ledger.listPendingDrains()).toEqual([]);

    // A poll returns the booked refund and calls Stripe for nothing more.
    const poll = await cardDrain(app, creditId);
    expect((await poll.json()).drain.status).toBe("sent");
    expect(refundCreates(account)).toHaveLength(1);
  });

  it("charges the caller no fee share when the whole top-up was spent", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "spent",
      amountMicro: 600_000,
      drawnMicro: 600_000,
    });
    const response = await cardDrain(app, creditId);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("nothing_to_drain");
    expect(refundCreates(account)).toHaveLength(0);
    expect(await ledger.listPendingDrains()).toEqual([]);
  });

  it("refunds the oldest top-up first and splits the balance across top-ups", async () => {
    const account = fakeStripeAccount();
    const { app, ledger } = await cardServer({ stripe: account });
    const now = Date.now();
    for (const [index, pi] of ["pi_older", "pi_newer"].entries()) {
      account.seedIntent({ id: pi, amount: 60 });
      await ledger.fund({
        creditId: "two-lots",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 600_000,
        expiryMs: now + DAY_MS,
        basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 60, fundingRef: pi },
        nowMs: now - (2 - index) * 1000,
      });
    }
    await drawAndSettle(ledger, "two-lots", 300_000);

    const body = await (await cardDrain(app, "two-lots")).json();
    expect(body.drain.status).toBe("sent");
    // 90 cents back: all 60 of the older charge, then 30 of the newer. Each 60-cent charge
    // cost round(1.74) + 30 = 32 cents in fees, so the older refund keeps all 32 and the
    // newer one round(32 × 30 / 60) = 16.
    expect(refundCreates(account).map((call) => [call.body.get("payment_intent"), call.body.get("amount")])).toEqual([
      ["pi_older", "28"],
      ["pi_newer", "14"],
    ]);
    expect(body.drain.card_refund).toMatchObject({ refunded_cents: 42, stripe_fee_share_cents: 48 });
  });

  it("refunds whole cents and reports the sub-cent remainder it cannot carry", async () => {
    const account = fakeStripeAccount();
    const { app, creditId } = await fundedCard(account, {
      fundId: "sub-cent",
      amountMicro: 2_000_000,
      drawnMicro: 305_000,
    });
    const body = await (await cardDrain(app, creditId)).json();
    // $1.695 drained: 169 whole cents, fee share round(36 × 169 / 200) = round(30.42) = 30.
    expect(body.drain).toMatchObject({
      status: "sent",
      amount_micro: 1_695_000,
      card_refund: { refunded_cents: 139, stripe_fee_share_cents: 30, sub_cent_micro: 5_000 },
    });
    expect(body.display).toContain("Less than one cent");
  });
});

describe("a card refund Stripe does not finish", () => {
  it("stays pending when Stripe rejects it, and a retry completes it with one refund", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "rejected",
      amountMicro: 2_000_000,
      drawnMicro: 300_000,
    });
    account.control.rejectRefunds = 1;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await cardDrain(app, creditId);
    // The pending refund reaches the operator log with what is needed to find it.
    const logged = warn.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
    warn.mockRestore();
    expect(logged).toContainEqual(
      expect.objectContaining({
        event: "card_refund_pending",
        credit_id: creditId,
        drain_id: "refund-1",
        stage: "refund",
        refund_status: "rejected",
        error_code: "charge_disputed",
      })
    );
    expect(first.status).toBe(fixture.pending.status);
    const pending = await first.json();
    expect(pending).toMatchObject(fixture.pending.body);
    expect(pending.drain.card_refund.refunds).toEqual([
      expect.objectContaining({ status: "rejected", refund_id: null }),
    ]);
    expect((await ledger.listPendingDrains()).map((d) => d.method)).toEqual(["stripe"]);

    const retried = await (await cardDrain(app, creditId)).json();
    expect(retried.drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
    // Stripe replays a key's first answer, rejection included: the retry needs a new key.
    const keys = refundCreates(account).map((call) => call.idempotencyKey);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("adopts a refund whose answer was lost instead of making a second one", async () => {
    const account = fakeStripeAccount();
    const { app, creditId } = await fundedCard(account, {
      fundId: "lost",
      amountMicro: 2_000_000,
      drawnMicro: 300_000,
    });
    account.control.loseRefundResponses = 1;

    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");
    // The retry comes after Stripe's idempotency window, so the key alone cannot dedupe it.
    account.forgetIdempotencyKeys();
    const retried = await (await cardDrain(app, creditId)).json();
    expect(retried.drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
    expect(retried.drain.refund_ids).toEqual([...account.refunds.keys()]);
  });

  it("books the drain only once Stripe reports a pending refund as succeeded", async () => {
    const account = fakeStripeAccount();
    const { app, creditId } = await fundedCard(account, {
      fundId: "slow",
      amountMicro: 2_000_000,
      drawnMicro: 300_000,
    });
    account.control.refundStatus = "pending";
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");
    for (const refund of account.refunds.values()) refund.status = "succeeded";
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
  });
});

describe("drain methods and funding rails that do not pair", () => {
  it("refuses a stripe drain of credit no card paid for", async () => {
    const account = fakeStripeAccount();
    const { app, ledger } = await cardServer({ stripe: account });
    await fundCredit(ledger, {
      creditId: "ecash",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 600_000,
      expiryMs: Date.now() + DAY_MS,
    });
    const response = await cardDrain(app, "ecash");
    expect(response.status).toBe(fixture.refusals.stripe_for_non_card_credit.status);
    expect(await response.json()).toMatchObject(fixture.refusals.stripe_for_non_card_credit.body);
    expect((await ledger.get("ecash"))?.balanceMicro).toBe(600_000);
    await expect(
      ledger.requestDrain({ creditId: "ecash", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} })
    ).rejects.toMatchObject({ code: "rail_mismatch" });
    expect(account.calls).toHaveLength(0);
  });

  it("refuses a stripe drain that names a payout destination", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "payout",
      amountMicro: 600_000,
      drawnMicro: 0,
    });
    const response = await drain(app, {
      creditId,
      drainId: "d",
      method: "stripe",
      payout: { address: `0x${"1".repeat(40)}` },
    });
    expect(response.status).toBe(fixture.refusals.stripe_with_payout.status);
    expect(await response.json()).toMatchObject(fixture.refusals.stripe_with_payout.body);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(600_000);
  });

  it("points a card credit drained on another method at the stripe method", async () => {
    const account = fakeStripeAccount();
    const { app, creditId } = await fundedCard(account, {
      fundId: "cashu-card",
      amountMicro: 600_000,
      drawnMicro: 0,
    });
    const response = await drain(app, {
      creditId,
      drainId: "d",
      method: "cashu",
      payout: { refund_pubkey: `02${"a".repeat(64)}` },
    });
    expect(response.status).toBe(fixture.refusals.card_credit_other_method.status);
    const body = await response.json();
    expect(body).toMatchObject(fixture.refusals.card_credit_other_method.body);
    expect(body.hint).toMatch(/method "stripe"/);
  });
});

describe("the operator's view of a pending card refund", () => {
  const PRIVKEY_HEX = "11".repeat(32);
  const LOCK_PUBKEY = `02${Buffer.from(schnorr.getPublicKey(Buffer.from(PRIVKEY_HEX, "hex"))).toString("hex")}`;
  const DVM_ID = "dvm-card-refund";

  function signAuth(method: string, path: string): string {
    const nonceHex = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    const unixSeconds = Math.floor(Date.now() / 1000);
    const digest = buildAdminChallenge({ method, path, dvmId: DVM_ID, nonceHex, unixSeconds });
    const sig = Buffer.from(schnorr.sign(digest, Buffer.from(PRIVKEY_HEX, "hex"))).toString("hex");
    return `P2PK ${nonceHex}.${unixSeconds}.${sig}`;
  }

  function adminApp(ledger: CreditLedgerLike, account: FakeStripeAccount): Hono {
    const app = new Hono();
    installAdminCreditRoutes(app, {
      db: {} as never,
      dvmId: DVM_ID,
      ledger,
      fxFetcher: { fetch: () => Promise.reject(new Error("no rate needed")), supportedCurrencies: () => ["usd"] },
      getLockPubkeyState: () => Promise.resolve({ current: toLockPubkey(LOCK_PUBKEY), retired: [] }),
      nonceStore: new MemoryConsumedCredentialStore({ maxEntries: 100 }),
      accumulatorWired: false,
      receiptIssuer: undefined,
      creditTtlMs: () => DAY_MS,
      creditCurrency: () => "usd",
      stripeRefunds: createStripeRefundApi({
        secretKey: "sk_test_fake",
        apiBase: "https://stripe.invalid",
        fetch: account.fetchImpl,
      }),
    });
    return app;
  }

  it("lists a rejected card refund with its status, and mark-drain-sent retries it once", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "operator",
      amountMicro: 2_000_000,
      drawnMicro: 300_000,
    });
    account.control.rejectRefunds = 1;
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");

    const admin = adminApp(ledger, account);
    const listed = await admin.request("/admin/credit/pending-drains", {
      headers: { Authorization: signAuth("GET", "/admin/credit/pending-drains") },
    });
    expect(listed.status).toBe(200);
    const { drains, liability } = await listed.json();
    expect(drains).toEqual([
      expect.objectContaining({
        method: "stripe",
        settlement: "card",
        amount_micro: 1_700_000,
        card_refund: expect.objectContaining({
          planned: true,
          refunds: [expect.objectContaining({ status: "rejected", last_error: "charge_disputed" })],
        }),
      }),
    ]);
    expect(liability.card_micro).toBe(1_700_000);

    const retry = () =>
      admin.request("/admin/credit/mark-drain-sent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: signAuth("POST", "/admin/credit/mark-drain-sent"),
        },
        // An operator's own evidence is ignored: only Stripe's answer books a card refund.
        body: JSON.stringify({ credit_id: creditId, drain_id: "refund-1", sent_ref: { by: "hand" } }),
      });
    const first = await retry();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "sent", replayed: false });
    const again = await retry();
    expect(await again.json()).toMatchObject({ status: "sent", replayed: true });
    expect(account.refunds.size).toBe(1);
    const booked = await ledger.getDrain({ creditId, drainId: "refund-1" });
    expect(booked?.sentRef).not.toHaveProperty("by");
  });
});
