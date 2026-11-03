/* Refunding card-funded credit to the card: the fee rule, lot order, retries that must never
 * refund twice, and the pairings of funding rail and drain method that are refused. */
import { readFileSync } from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { Credential } from "mppx";
import { describe, expect, it, vi } from "vitest";

import { runCardRefundSweep } from "../card-refund-sweep";
import { runStripeDrain } from "../stripe-drain-leg";
import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import type { CardChargeJournal } from "../card-charge-journal";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import type { CreditLedgerLike } from "../credit-ledger";
import { derivedFundCreditId } from "../funding";
import { toLockPubkey } from "../lock-pubkey-store";
import { createStripeCreditRail } from "../stripe-credit";
import { createStripeRefundApi } from "../stripe-refund-api";
import {
  CALLER,
  cardServer,
  credentialFor,
  drain,
  fund,
  HMAC,
  paymentChallenges,
  type App,
} from "./__helpers__/card-credit";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { cardFee, fakeStripeAccount, type FakeStripeAccount } from "./__helpers__/fake-stripe-account";

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
  blocked: Exchange;
  written_off: Exchange;
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

describe("one card refund at a time", () => {
  it("refuses a second card refund while the first is unfinished, then refunds what is left", async () => {
    const account = fakeStripeAccount();
    const { app, ledger } = await cardServer({ stripe: account });
    const now = Date.now();
    for (const [index, pi] of ["pi_1", "pi_2"].entries()) {
      account.seedIntent({ id: pi, amount: 1000 });
      await ledger.fund({
        creditId: "busy",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 10_000_000,
        expiryMs: now + DAY_MS,
        basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 1000, fundingRef: pi },
        nowMs: now - (2 - index) * 1000,
      });
    }
    // A job holds $5 while the first refund ($15) starts; its first call to Stripe is lost
    // before Stripe records anything, so the oldest charge has no refund yet.
    await ledger.draw({ creditId: "busy", drawId: "hold", amountMicro: 5_000_000, jobId: "hold" });
    account.control.unreachableRefunds = 1;
    const first = await (await cardDrain(app, "busy", "A")).json();
    expect(first.drain.status).toBe("pending");
    await ledger.release({ creditId: "busy", drawId: "hold" });

    // A second plan now could size its refund against charge room the first still needs.
    const second = await cardDrain(app, "busy", "B");
    expect(second.status).toBe(409);
    const refusal = await second.json();
    expect(refusal).toMatchObject({ error: "drain_conflict", retryable: true, blocking_drain_id: "A" });
    expect(refusal.hint).toMatch(/Poll drain A/);
    expect((await ledger.get("busy"))?.balanceMicro).toBe(5_000_000);

    expect((await (await cardDrain(app, "busy", "A")).json()).drain.status).toBe("sent");
    const last = await (await cardDrain(app, "busy", "B")).json();
    expect(last.drain.status).toBe("sent");
    // Every refund fit its charge (none refused as too large), and the whole $20 went back
    // less each $10 charge's full fee: 2000 − 2 × 59 cents.
    const refunded = [...account.refunds.values()].reduce((sum, refund) => sum + refund.amount, 0);
    expect(refunded).toBe(2000 - 2 * cardFee(1000));
    expect((await ledger.get("busy"))?.balanceMicro).toBe(0);
  });
});

describe("drain ids a card refund cannot take", () => {
  it("reserves the expiry refund's drain ids and caps their length", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, {
      fundId: "ids",
      amountMicro: 600_000,
      drawnMicro: 0,
    });
    for (const drainId of ["expiry-1790000000000", "x".repeat(129)]) {
      const response = await cardDrain(app, creditId, drainId);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    }
    expect((await ledger.get(creditId))?.balanceMicro).toBe(600_000);
    expect(refundCreates(account)).toHaveLength(0);
  });
});

describe("a top-up of an expired card credit", () => {
  it("is refused before any challenge or charge, so the expired balance still goes back to the card", async () => {
    const account = fakeStripeAccount();
    const { app, ledger } = await cardServer({ stripe: account });
    account.seedIntent({ id: "pi_old", amount: 60 });
    await ledger.fund({
      creditId: "old",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 600_000,
      expiryMs: Date.now() - 1000,
      nowMs: Date.now() - DAY_MS,
      basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 60, fundingRef: "pi_old" },
    });
    const response = await fund(app, { fundId: "revive", creditId: "old" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "credit_closed" });
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(account.calls).toHaveLength(0);
  });
});

describe("the charge journal", () => {
  it("records a charge only after its challenge verifies, so a forged one leaves no row", async () => {
    const account = fakeStripeAccount();
    const recorded: string[] = [];
    const journal: CardChargeJournal = {
      record: (challengeId) => {
        recorded.push(challengeId);
        return Promise.resolve();
      },
      listUnresolved: () => Promise.resolve([]),
      resolve: () => Promise.resolve(),
    };
    const { app } = await cardServer({
      stripe: null,
      serverOpts: {
        stripeCredit: createStripeCreditRail({
          secretKey: "sk_test_fake",
          networkId: "profile_test",
          hmacSecret: HMAC,
          apiBase: "https://stripe.invalid",
          fetch: account.fetchImpl,
          chargeJournal: journal,
        }),
      },
    });

    const discovery = await fund(app, { fundId: "forged" });
    const [challenge] = paymentChallenges(discovery);
    const forged = Credential.serialize(
      Credential.from({ challenge: { ...challenge!, id: "made-up-challenge-id" }, payload: { spt: "spt_test" } })
    );
    const refused = await fund(app, { fundId: "forged", credential: forged });
    expect(refused.status).not.toBe(200);
    expect(recorded).toEqual([]);
    expect(account.calls).toHaveLength(0);

    const genuine = await credentialFor(app, "genuine");
    expect((await fund(app, { fundId: "genuine", credential: genuine })).status).toBe(200);
    expect(recorded).toEqual([Credential.deserialize(genuine).challenge.id]);
  });
});

describe("a charge the journal cannot record", () => {
  it("is refused before Stripe is called, and the same credential books once the journal is back", async () => {
    const account = fakeStripeAccount();
    let journalDown = true;
    const recorded: string[] = [];
    const journal: CardChargeJournal = {
      record: (challengeId) => {
        if (journalDown) return Promise.reject(new Error("connection terminated"));
        recorded.push(challengeId);
        return Promise.resolve();
      },
      listUnresolved: () => Promise.resolve([]),
      resolve: () => Promise.resolve(),
    };
    const { app, ledger } = await cardServer({
      stripe: null,
      serverOpts: {
        stripeCredit: createStripeCreditRail({
          secretKey: "sk_test_fake",
          networkId: "profile_test",
          hmacSecret: HMAC,
          apiBase: "https://stripe.invalid",
          fetch: account.fetchImpl,
          chargeJournal: journal,
        }),
      },
    });
    const credential = await credentialFor(app, "journal-down");

    const refused = await fund(app, { fundId: "journal-down", credential });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ reason: "unavailable", retryable: true });
    expect(account.calls).toHaveLength(0);
    expect(await ledger.get(derivedFundCreditId(CALLER, "journal-down"))).toBeUndefined();

    journalDown = false;
    expect((await fund(app, { fundId: "journal-down", credential })).status).toBe(200);
    expect(recorded).toEqual([Credential.deserialize(credential).challenge.id]);
    expect(account.intents.size).toBe(1);
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

  function decide(admin: Hono, action: "close" | "replan", creditId: string, decisionId = "decision-1", reason = "Reviewed refund evidence") {
    const path = `/admin/credit/${action}-card-drain`;
    return admin.request(path, { method: "POST", headers: {
      "Content-Type": "application/json", Authorization: signAuth("POST", path),
    }, body: JSON.stringify({ credit_id: creditId, drain_id: "refund-1", decision_id: decisionId, reason }) });
  }

  it.each([
    ["exhausted", "charges_exhausted"], ["nonrefundable", "charge_not_refundable"],
  ])("blocks a %s charge and leaves it visible as an unpaid liability", async (kind, code) => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, { fundId: kind, amountMicro: 2_000_000, drawnMicro: 300_000 });
    const intent = account.intents.get("pi_test_1")!;
    if (kind === "exhausted") intent.refunded = intent.amount;
    else intent.status = "canceled";
    const blocked = await (await cardDrain(app, creditId)).json();
    if (kind === "exhausted") expect(blocked).toMatchObject(fixture.blocked.body);
    expect(blocked.drain).toMatchObject({ status: "refund_blocked", card_refund: { recovery: { blocked_reason: code } } });
    const calls = account.calls.length;
    await cardDrain(app, creditId);
    await runCardRefundSweep({ ledger, stripe: createStripeRefundApi({ secretKey: "sk_test_fake", fetch: account.fetchImpl }), drainReport: {} });
    expect(account.calls).toHaveLength(calls);
    expect(await ledger.listPendingDrains()).toEqual([expect.objectContaining({ status: "refund_blocked", amountMicro: 1_700_000 })]);
    await expect(ledger.requestDrain({ creditId, drainId: "second", callerPubkey: CALLER, method: "stripe", payout: {} }))
      .rejects.toMatchObject({ code: "drain_conflict" });
    const admin = adminApp(ledger, account);
    const listed = await admin.request("/admin/credit/pending-drains", { headers: { Authorization: signAuth("GET", "/admin/credit/pending-drains") } });
    expect(await listed.json()).toMatchObject({ drains: [{ status: "refund_blocked" }], liability: { card_micro: 1_700_000 } });
    const closed = await decide(admin, "close", creditId);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ status: "written_off", replayed: false,
      card_refund: { recovery: { writtenOffMicro: 1_700_000, refundedGrossMicro: 0, decisions: [{ reason: "Reviewed refund evidence" }] } } });
    expect(await ledger.listPendingDrains()).toEqual([]);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
    expect(await (await decide(admin, "close", creditId)).json()).toMatchObject({ status: "written_off", replayed: true });
    expect((await decide(admin, "close", creditId, "decision-1", "Changed decision")).status).toBe(409);
    expect(await (await cardDrain(app, creditId)).json()).toMatchObject(fixture.written_off.body);
    expect(refundCreates(account)).toHaveLength(0);
  });

  async function partiallyBlocked(account: FakeStripeAccount, firstStatus = "succeeded") {
    const { app, ledger } = await cardServer({ stripe: account });
    for (const [index, pi] of ["pi_first", "pi_second"].entries()) {
      account.seedIntent({ id: pi, amount: 200 });
      await ledger.fund({ creditId: "partial", callerPubkey: CALLER, currency: "usd", amountMicro: 2_000_000,
        expiryMs: Date.now() + DAY_MS, nowMs: Date.now() - 1000 + index,
        basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 200, fundingRef: pi } });
    }
    await drawAndSettle(ledger, "partial", 1_000_000);
    // First establish the fixed plan with two definite refusals, then let one refund pay
    // while a dashboard refund makes the second allocation too large.
    account.control.rejectRefunds = 2;
    await cardDrain(app, "partial");
    account.intents.get("pi_second")!.refunded = 150;
    account.control.refundStatus = firstStatus === "lost" ? "succeeded" : firstStatus;
    if (firstStatus === "lost") account.control.loseRefundResponses = 1;
    expect((await (await cardDrain(app, "partial")).json()).drain.status).toBe("refund_blocked");
    return { app, ledger, admin: adminApp(ledger, account) };
  }

  it("writes off only the unpaid gross remainder after a partial card refund", async () => {
    const account = fakeStripeAccount();
    const { ledger, admin } = await partiallyBlocked(account);
    const before = refundCreates(account).length;
    expect(await (await decide(admin, "close", "partial")).json()).toMatchObject({ status: "written_off",
      card_refund: { refunded_cents: 164, fee_share_cents: 36, recovery: { refundedGrossMicro: 2_000_000, writtenOffMicro: 1_000_000 } } });
    const record = await ledger.getDrain({ creditId: "partial", drainId: "refund-1" });
    expect(record?.cardRefund?.entries[0]).toMatchObject({ status: "succeeded", grossCents: 200, amountCents: 164 });
    expect(record?.sentRef).toBeNull();
    expect(record?.receipts).not.toContainEqual(expect.objectContaining({ event: "sent" }));
    expect(refundCreates(account)).toHaveLength(before);
    expect((await ledger.get("partial"))?.balanceMicro).toBe(0);
  });

  it("replans only unpaid credit and retains the successful allocation and its fee", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, admin } = await partiallyBlocked(account);
    account.seedIntent({ id: "pi_extra", amount: 100 });
    await ledger.fund({ creditId: "partial", callerPubkey: CALLER, currency: "usd", amountMicro: 1_000_000,
      expiryMs: Date.now() + DAY_MS, basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 100, fundingRef: "pi_extra" } });
    const response = await decide(admin, "replan", "partial");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "sent", replayed: false, card_refund: { recovery: { revision: 1 } } });
    const record = await ledger.getDrain({ creditId: "partial", drainId: "refund-1" });
    expect(record?.cardRefund?.entries.map((entry) => [entry.paymentIntentId, entry.grossCents, entry.status])).toEqual([
      ["pi_first", 200, "succeeded"], ["pi_second", 50, "succeeded"], ["pi_extra", 50, "succeeded"],
    ]);
    expect([...account.refunds.values()].filter((refund) => refund.payment_intent === "pi_first")).toHaveLength(1);
    const creates = refundCreates(account).length;
    expect(await (await decide(admin, "replan", "partial")).json()).toMatchObject({ status: "sent", replayed: true });
    await cardDrain(app, "partial");
    expect(refundCreates(account)).toHaveLength(creates);
    expect((await ledger.get("partial"))?.balanceMicro).toBe(1_000_000);
    expect(new Set(refundCreates(account).map((call) => call.idempotencyKey)).size).toBe(refundCreates(account).length);
  });

  it.each(["close", "replan"] as const)("refuses to %s while another refund may still pay", async (action) => {
    const account = fakeStripeAccount();
    const { ledger, admin } = await partiallyBlocked(account, "pending");
    const creates = refundCreates(account).length;
    expect(await (await decide(admin, action, "partial")).json()).toMatchObject({ error: "card_refund_uncertain" });
    expect((await ledger.getDrain({ creditId: "partial", drainId: "refund-1" }))?.status).toBe("refund_blocked");
    expect(refundCreates(account)).toHaveLength(creates);
    for (const refund of account.refunds.values()) refund.status = "succeeded";
    if (action === "close") expect(await (await decide(admin, action, "partial")).json()).toMatchObject({
      status: "written_off", card_refund: { recovery: { writtenOffMicro: 1_000_000 } },
    });
  });

  it("blocks a dispute lost after planning but keeps an open dispute retryable", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, { fundId: "lost-dispute", amountMicro: 2_000_000, drawnMicro: 300_000 });
    account.control.rejectRefunds = 1;
    await cardDrain(app, creditId);
    account.dispute("pi_test_1");
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");
    account.settleDisputes("pi_test_1", "lost");
    expect((await (await cardDrain(app, creditId)).json()).drain).toMatchObject({ status: "refund_blocked",
      card_refund: { recovery: { blocked_reason: "charge_dispute_lost" } } });
    const calls = account.calls.length;
    await cardDrain(app, creditId);
    expect(account.calls).toHaveLength(calls);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(0);
  });

  it("requires admin authentication and a reason before any recovery side effect", async () => {
    const account = fakeStripeAccount();
    const { ledger, creditId } = await fundedCard(account, { fundId: "auth-recovery", amountMicro: 2_000_000, drawnMicro: 0 });
    const admin = adminApp(ledger, account);
    const calls = account.calls.length;
    for (const action of ["close", "replan"] as const) {
      expect((await admin.request(`/admin/credit/${action}-card-drain`, { method: "POST", body: "{}" })).status).toBe(401);
      expect((await decide(admin, action, creditId, "decision", " ")).status).toBe(400);
    }
    expect(account.calls).toHaveLength(calls);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(2_000_000);
  });

  it("retries a fresh drain behind 201 blocked drains in one sweep pass", async () => {
    const account = fakeStripeAccount();
    const { ledger } = await cardServer({ stripe: account });
    const stripe = createStripeRefundApi({ secretKey: "sk_test_fake", fetch: account.fetchImpl });
    const deps = { ledger, stripe, drainReport: {} };
    for (let index = 0; index < 202; index++) {
      const creditId = `page-${index}`;
      const pi = `pi_page_${index}`;
      account.seedIntent({ id: pi, amount: 100, refunded: index < 201 ? 100 : 0 });
      await ledger.fund({ creditId, callerPubkey: CALLER, currency: "usd", amountMicro: 1_000_000,
        expiryMs: Date.now() + DAY_MS, basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 100, fundingRef: pi } });
      const { drain: record } = await ledger.requestDrain({ creditId, drainId: "refund", callerPubkey: CALLER, method: "stripe", payout: {} });
      if (index < 201) await runStripeDrain(deps, record);
    }
    const calls = account.calls.length;
    const pass = await runCardRefundSweep(deps);
    expect(pass.completed).toEqual(["page-201:refund"]);
    expect(pass.pending).toEqual([]);
    expect(account.calls.slice(calls).filter((call) => call.path.startsWith("/v1/payment_intents/"))
      .every((call) => call.path.endsWith("pi_page_201"))).toBe(true);
    expect([...account.refunds.values()].map((refund) => [refund.payment_intent, refund.amount])).toEqual([["pi_page_201", 67]]);
    const after = account.calls.length;
    await runCardRefundSweep(deps);
    expect(account.calls).toHaveLength(after);
  });


  it("resumes a replan interrupted before its replacement plan is stored", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, admin } = await partiallyBlocked(account);
    account.intents.get("pi_second")!.refunded = 0;
    const save = vi.spyOn(ledger, "saveCardRefund").mockRejectedValueOnce(new Error("storage unavailable"));
    const interrupted = await decide(admin, "replan", "partial");
    expect(await interrupted.json()).toMatchObject({ status: "pending", card_refund: { recovery: { revision: 1 } } });
    save.mockRestore();
    const before = await ledger.getDrain({ creditId: "partial", drainId: "refund-1" });
    expect(before?.cardRefund?.entries).toHaveLength(1);
    const completed = await (await cardDrain(app, "partial")).json();
    expect(completed.drain.status).toBe("sent");
    expect([...account.refunds.values()].map((refund) => [refund.payment_intent, refund.amount])).toEqual([
      ["pi_first", 164], ["pi_second", 82],
    ]);
  });

  it("books a newly completed refund instead of writing off a paid drain", async () => {
    const account = fakeStripeAccount();
    const { ledger, admin } = await partiallyBlocked(account, "pending");
    const held = (await ledger.getDrain({ creditId: "partial", drainId: "refund-1" }))!;
    const rejected = held.cardRefund!.entries[1]!;
    account.intents.get("pi_second")!.refunded = 0;
    const stripe = createStripeRefundApi({ secretKey: "sk_test_fake", fetch: account.fetchImpl });
    await stripe.createRefund({ paymentIntentId: "pi_second", amount: 82, idempotencyKey: "external-recovery",
      metadata: { dvmkit_drain: "partial:refund-1", dvmkit_lot: rejected.lotId, dvmkit_revision: "0" } });
    for (const refund of account.refunds.values()) refund.status = "succeeded";
    expect(await (await decide(admin, "close", "partial")).json()).toMatchObject({ status: "sent",
      card_refund: { recovery: { writtenOffMicro: 0 } } });
    expect((await ledger.getDrain({ creditId: "partial", drainId: "refund-1" }))?.sentRef).toMatchObject({ refunded_cents: 246 });
  });


  it("parks a lost dispute even while an existing refund is processing", async () => {
    const account = fakeStripeAccount();
    const { app, creditId } = await fundedCard(account, { fundId: "pending-dispute", amountMicro: 2_000_000, drawnMicro: 0 });
    account.control.refundStatus = "pending";
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("pending");
    account.dispute("pi_test_1", "lost");
    expect((await (await cardDrain(app, creditId)).json()).drain).toMatchObject({ status: "refund_blocked",
      card_refund: { recovery: { blocked_reason: "charge_dispute_lost" } } });
    const calls = account.calls.length;
    await cardDrain(app, creditId);
    expect(account.calls).toHaveLength(calls);
  });


  it("answers a competing caller with a retryable conflict before any Stripe call", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, { fundId: "busy-refund", amountMicro: 2_000_000, drawnMicro: 0 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const calls = account.calls.length;
    const lock = ledger.withCardRefundLock!(creditId, async () => { await gate; });
    try {
      const response = await cardDrain(app, creditId);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "card_refund_busy", retryable: true, drain_registered: true, drain_id: "refund-1" });
      expect(account.calls).toHaveLength(calls);
    } finally { release(); await lock; }
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
  });


  it("recovers a lost response after a rejected attempt from a later refund-history page", async () => {
    const account = fakeStripeAccount();
    const { ledger } = await partiallyBlocked(account, "lost");
    const before = await ledger.getDrain({ creditId: "partial", drainId: "refund-1" });
    expect(before?.cardRefund?.entries[0]).toMatchObject({ status: "planned", lastError: "stripe_unreachable", refundId: null });
    const paged = { ...account, fetchImpl: (async (input, init) => {
      const url = new URL(String(input));
      const response = await account.fetchImpl(input, init);
      if (url.pathname !== "/v1/refunds" || (init?.method ?? "GET") !== "GET") return response;
      const body = await response.json();
      if (url.searchParams.has("starting_after")) return Response.json({ ...body, has_more: false });
      return Response.json({ has_more: true, data: [{ id: "re_unrelated", amount: 1, status: "succeeded", metadata: {} }] });
    }) as typeof fetch };
    const creates = refundCreates(account).length;
    expect(await (await decide(adminApp(ledger, paged), "close", "partial")).json()).toMatchObject({ status: "written_off",
      card_refund: { refunded_cents: 164, recovery: { refundedGrossMicro: 2_000_000, writtenOffMicro: 1_000_000 } } });
    expect(refundCreates(account)).toHaveLength(creates);
    expect(account.refunds.size).toBe(1);
  });


  it("replans against another refundable charge when an older charge is permanently unavailable", async () => {
    const account = fakeStripeAccount();
    const { app, ledger, creditId } = await fundedCard(account, { fundId: "alternate-charge", amountMicro: 2_000_000, drawnMicro: 0 });
    account.intents.get("pi_test_1")!.status = "canceled";
    expect((await (await cardDrain(app, creditId)).json()).drain.status).toBe("refund_blocked");
    account.seedIntent({ id: "pi_alternate", amount: 200 });
    await ledger.fund({ creditId, callerPubkey: CALLER, currency: "usd", amountMicro: 2_000_000,
      expiryMs: Date.now() + DAY_MS, basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 200, fundingRef: "pi_alternate" } });
    expect(await (await decide(adminApp(ledger, account), "replan", creditId)).json()).toMatchObject({ status: "sent" });
    expect([...account.refunds.values()].map((refund) => [refund.payment_intent, refund.amount])).toEqual([["pi_alternate", 164]]);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(2_000_000);
  });

});
