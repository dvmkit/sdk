/* Card refunds on Postgres: the expiry refund that closes a card credit for good, the
 * dispute that freezes one, the charge that was never booked, and the drain report. */
import { readFileSync } from "node:fs";
import { Credential } from "mppx";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresCardChargeJournal } from "../card-charge-journal";
import { runCardRefundSweep } from "../card-refund-sweep";
import { cardExpiryDrainId, CreditLedger } from "../credit-ledger";
import type { CreditDrainPayload } from "../revenue-reporter";
import { recoverCardDrain, runStripeDrain } from "../stripe-drain-leg";
import { createStripeCreditRail } from "../stripe-credit";
import { createStripeRefundApi, StripeApiError } from "../stripe-refund-api";
import { CALLER, cardServer, credentialFor, drain, fund, HMAC } from "./__helpers__/card-credit";
import { fakeStripeAccount, type FakeStripeAccount } from "./__helpers__/fake-stripe-account";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_credit_drain_stripe";
const HOUR_MS = 60 * 60 * 1000;

async function pool(schema?: string): Promise<Pool> {
  const pg = await import("pg");
  return new pg.default.Pool({
    connectionString: DATABASE_URL,
    ...(schema && { options: `-c search_path=${schema}` }),
  });
}

describe.skipIf(!RUN)("card refunds on Postgres", () => {
  let db: Pool;
  let ledger: CreditLedger;

  beforeAll(async () => {
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    db = await pool(SCHEMA);
    ledger = new CreditLedger(db);
    await ledger.init();
  });

  afterAll(async () => {
    await db.end();
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  function stripeApi(account: FakeStripeAccount) {
    return createStripeRefundApi({
      secretKey: "sk_test_fake",
      apiBase: "https://stripe.invalid",
      fetch: account.fetchImpl,
    });
  }

  /** A card credit funded at `pi` for `cents`, expiring at `expiryMs`. */
  async function cardCredit(
    account: FakeStripeAccount,
    args: { creditId: string; pi: string; cents: number; expiryMs: number; fundedAtMs?: number }
  ) {
    account.seedIntent({ id: args.pi, amount: args.cents });
    await ledger.fund({
      ...(args.fundedAtMs !== undefined && { nowMs: args.fundedAtMs }),
      creditId: args.creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: args.cents * 10_000,
      expiryMs: args.expiryMs,
      basis: {
        rail: "stripe",
        paidMsats: 0,
        nativeAsset: "usd-cents",
        nativeAmount: args.cents,
        fundingRef: args.pi,
      },
    });
  }

  it("refunds an expired card balance to the card, reports it as a drain, and closes the credit", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    const expiryMs = now - HOUR_MS;
    await cardCredit(account, { creditId: "expired", pi: "pi_expired", cents: 200, expiryMs });
    await ledger.draw({ creditId: "expired", drawId: "j", amountMicro: 300_000, jobId: "j", nowMs: expiryMs - HOUR_MS });
    await ledger.settle({ creditId: "expired", drawId: "j" });

    // The release sweep leaves card credit alone: it is never released to the builder.
    expect((await ledger.sweepExpiredCredits({ nowMs: now })).released).toEqual([]);

    const reports: CreditDrainPayload[] = [];
    const summary = await runCardRefundSweep(
      {
        ledger,
        stripe: stripeApi(account),
        drainReport: {
          db,
          dvmId: "dvm-card",
          enqueueCreditDrain: (_tx, payload) => {
            reports.push(payload);
            return Promise.resolve();
          },
        },
      },
      { nowMs: now }
    );
    expect(summary.expiryRefunds).toEqual(["expired"]);
    const drainId = cardExpiryDrainId(expiryMs);
    expect(summary.completed).toEqual([`expired:${drainId}`]);

    // $1.70 owed; Stripe's fee on $2.00 is 36 cents, so the card gets 170 − 31 = 139.
    expect([...account.refunds.values()].map((r) => [r.payment_intent, r.amount])).toEqual([
      ["pi_expired", 139],
    ]);
    const credit = await ledger.get("expired");
    expect(credit).toMatchObject({ status: "refunded", balanceMicro: 0 });
    const booked = await ledger.getDrain({ creditId: "expired", drainId });
    expect(booked).toMatchObject({ method: "stripe", status: "sent", amountMicro: 1_700_000 });
    expect(booked?.sentRef).toMatchObject({ refunded_cents: 139, fee_share_cents: 31 });
    // The platform nets the whole drained credit; the fee share is Stripe's, not revenue.
    expect(reports).toEqual([
      expect.objectContaining({ creditId: "expired", method: "stripe", amountMicro: 1_700_000, status: "sent" }),
    ]);
    const { rows: releases } = await db.query(`SELECT 1 FROM credit_expiry_releases WHERE credit_id = 'expired'`);
    expect(releases).toEqual([]);

    // Closed for good: no top-up revives it, and a second pass refunds nothing more.
    await expect(
      ledger.fund({
        creditId: "expired",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 600_000,
        expiryMs: now + HOUR_MS,
        basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 60, fundingRef: "pi_revive" },
      })
    ).rejects.toMatchObject({ code: "credit_closed" });
    const again = await runCardRefundSweep(
      { ledger, stripe: stripeApi(account), drainReport: {} },
      { nowMs: now + HOUR_MS }
    );
    expect(again.expiryRefunds).toEqual([]);
    expect(account.refunds.size).toBe(1);
  });

  it("refunds the part a partial settle released to the card at expiry", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    const expiryMs = now - HOUR_MS;
    const fundedAtMs = expiryMs - 2 * HOUR_MS;
    await cardCredit(account, { creditId: "part-settled", pi: "pi_part", cents: 100, expiryMs, fundedAtMs });
    await ledger.draw({ creditId: "part-settled", drawId: "j", amountMicro: 1_000_000, jobId: "j", nowMs: fundedAtMs + 1 });
    await ledger.resolveDraw({ creditId: "part-settled", drawId: "j", settleMicro: 600_000 });

    const summary = await runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {} }, { nowMs: now });
    expect(summary.expiryRefunds).toContain("part-settled");
    // $0.40 released; Stripe's fee on $1.00 is 33 cents, 13 of them on that $0.40, so the card gets 27.
    expect([...account.refunds.values()].map((r) => [r.payment_intent, r.amount])).toEqual([["pi_part", 27]]);
    expect(await ledger.getDrain({ creditId: "part-settled", drainId: cardExpiryDrainId(expiryMs) }))
      .toMatchObject({ method: "stripe", status: "sent", amountMicro: 400_000 });
    expect(await ledger.get("part-settled")).toMatchObject({ status: "refunded", balanceMicro: 0 });
  });

  it("settles, releases and part-settles holds on a credit frozen by a dispute", async () => {
    const account = fakeStripeAccount();
    await cardCredit(account, { creditId: "frozen-holds", pi: "pi_frozen_holds", cents: 200, expiryMs: Date.now() + HOUR_MS });
    for (const [drawId, amountMicro] of [["part", 1_000_000], ["none", 300_000], ["whole", 200_000], ["gone", 100_000]] as const) {
      await ledger.draw({ creditId: "frozen-holds", drawId, amountMicro, jobId: `frozen-${drawId}` });
    }
    expect(await ledger.freezeCardCreditsForPaymentIntent("pi_frozen_holds")).toEqual(["frozen-holds"]);

    await expect(ledger.resolveDraw({ creditId: "frozen-holds", drawId: "part", settleMicro: 600_000 }))
      .resolves.toMatchObject({ status: "settled", amountMicro: 600_000, partialSettle: { releasedMicro: 400_000 } });
    await expect(ledger.resolveDraw({ creditId: "frozen-holds", drawId: "none", settleMicro: 0 }))
      .resolves.toMatchObject({ status: "released" });
    await expect(ledger.settle({ creditId: "frozen-holds", drawId: "whole" })).resolves.toMatchObject({ status: "settled" });
    await expect(ledger.release({ creditId: "frozen-holds", drawId: "gone" })).resolves.toMatchObject({ status: "released" });

    // Charged $0.80 of $2.00; the rest stays frozen with the credit until the dispute ends.
    expect(await ledger.get("frozen-holds")).toMatchObject({ status: "disputed", balanceMicro: 1_200_000, availableMicro: 0 });
    expect(await ledger.listPendingDraws("frozen-holds")).toEqual([]);
  });

  it("tells the caller a refunded card credit is closed and where its refund went", async () => {
    const account = fakeStripeAccount();
    const { app } = await cardServer({ stripe: account, ledger });
    const now = Date.now();
    await cardCredit(account, { creditId: "closed", pi: "pi_closed", cents: 60, expiryMs: now - HOUR_MS });
    await runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {} }, { nowMs: now });

    const response = await drain(app, { creditId: "closed", drainId: "late", method: "stripe", payout: {} });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "credit_closed", retryable: false });
  });

  it("freezes the remaining balance of a credit whose card payment is disputed", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    await cardCredit(account, { creditId: "disputed", pi: "pi_disputed", cents: 200, expiryMs: now + HOUR_MS });
    await cardCredit(account, { creditId: "bystander", pi: "pi_fine", cents: 200, expiryMs: now + HOUR_MS });
    account.dispute("pi_disputed");

    const summary = await runCardRefundSweep(
      { ledger, stripe: stripeApi(account), drainReport: {} },
      { nowMs: now }
    );
    expect(summary.frozen).toEqual(["disputed"]);
    expect(await ledger.get("disputed")).toMatchObject({ status: "disputed", balanceMicro: 2_000_000, availableMicro: 0 });
    await expect(
      ledger.draw({ creditId: "disputed", drawId: "j", amountMicro: 100_000, jobId: "j" })
    ).rejects.toMatchObject({ code: "credit_closed" });
    await expect(
      ledger.requestDrain({ creditId: "disputed", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} })
    ).rejects.toMatchObject({ code: "credit_closed" });
    expect((await ledger.get("bystander"))?.status).toBe("active");
    expect(account.refunds.size).toBe(0);
  });

  it("refunds in full a charge this DVM made that never reached a credit", async () => {
    const account = fakeStripeAccount();
    const journal = await createPostgresCardChargeJournal(db);
    const { app } = await cardServer({
      stripe: null,
      ledger,
      serverOpts: {
        stripeCredit: createStripeCreditRail({
          secretKey: "sk_test_fake",
          networkId: "profile_test",
          minUsd: "0.50",
          hmacSecret: HMAC,
          apiBase: "https://stripe.invalid",
          fetch: account.fetchImpl,
          chargeJournal: journal,
        }),
      },
    });
    // A booked top-up: journaled, charged, and on a credit.
    const booked = await credentialFor(app, "booked");
    expect((await fund(app, { fundId: "booked", credential: booked })).status).toBe(200);
    // A charge Stripe made for a journaled challenge whose booking never happened.
    const stranded = await credentialFor(app, "stranded");
    const challengeId = Credential.deserialize(stranded).challenge.id;
    await journal.record(challengeId);
    account.seedIntent({ id: "pi_stranded", amount: 60, metadata: { mpp_challenge_id: challengeId } });
    // Another DVM's charge on the same Stripe account: not in this journal, never touched.
    account.seedIntent({ id: "pi_elsewhere", amount: 60, metadata: { mpp_challenge_id: "someone-else" } });

    const summary = await runCardRefundSweep(
      { ledger, stripe: stripeApi(account), drainReport: {}, journal },
      { nowMs: Date.now() + HOUR_MS }
    );
    expect(summary.strandedRefunds).toEqual(["pi_stranded"]);
    expect([...account.refunds.values()].map((r) => [r.payment_intent, r.amount])).toEqual([
      ["pi_stranded", 60],
    ]);
    expect(await journal.listUnresolved({ olderThanMs: Date.now() + HOUR_MS, limit: 10 })).toEqual([]);
    const rerun = await runCardRefundSweep(
      { ledger, stripe: stripeApi(account), drainReport: {}, journal },
      { nowMs: Date.now() + 2 * HOUR_MS }
    );
    expect(rerun.strandedRefunds).toEqual([]);
    expect(account.refunds.size).toBe(1);
  });

  it("keeps sweeping when the dispute listing fails, or one credit cannot be refunded", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    await cardCredit(account, { creditId: "sweep-a", pi: "pi_sweep_a", cents: 200, expiryMs: now - 2 * HOUR_MS });
    await cardCredit(account, { creditId: "sweep-b", pi: "pi_sweep_b", cents: 200, expiryMs: now - HOUR_MS });
    // A restricted key without dispute access gets a 403 on every listing.
    const stripe = {
      ...stripeApi(account),
      listDisputes: () => Promise.reject(new StripeApiError(403, { type: "invalid_request_error" })),
    };
    const brokenLedger = Object.create(ledger, {
      openCardExpiryRefund: {
        value: (args: { creditId: string; nowMs?: number }) =>
          args.creditId === "sweep-a"
            ? Promise.reject(new Error("connection reset"))
            : ledger.openCardExpiryRefund(args),
      },
    }) as CreditLedger;

    const summary = await runCardRefundSweep({ ledger: brokenLedger, stripe, drainReport: {} }, { nowMs: now });
    expect(summary.failedSteps).toEqual(["disputes"]);
    expect(summary.expiryRefunds).toEqual(["sweep-b"]);
    expect(await ledger.get("sweep-b")).toMatchObject({ status: "refunded", balanceMicro: 0 });
    expect((await ledger.get("sweep-a"))?.status).toBe("active");
  });

  it("does not open an expiry refund beside an unfinished card refund, even one named like it", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    const expiryMs = now - HOUR_MS;
    const fundedAtMs = expiryMs - 2 * HOUR_MS;
    await cardCredit(account, { creditId: "squatter", pi: "pi_squat", cents: 200, expiryMs, fundedAtMs });
    await cardCredit(account, { creditId: "neighbour", pi: "pi_next", cents: 200, expiryMs: expiryMs + 1, fundedAtMs });
    // Straight to the ledger, past the route that reserves the name: the sweep must survive it.
    await ledger.draw({ creditId: "squatter", drawId: "hold", amountMicro: 300_000, jobId: "hold", nowMs: fundedAtMs + 1 });
    await ledger.requestDrain({
      creditId: "squatter",
      drainId: cardExpiryDrainId(expiryMs),
      callerPubkey: CALLER,
      method: "stripe",
      payout: {},
      nowMs: fundedAtMs + 2,
    });
    await ledger.release({ creditId: "squatter", drawId: "hold" });
    // The same race with an ordinary drain id.
    await cardCredit(account, { creditId: "waiting", pi: "pi_wait", cents: 200, expiryMs, fundedAtMs });
    await ledger.draw({ creditId: "waiting", drawId: "hold", amountMicro: 300_000, jobId: "hold", nowMs: fundedAtMs + 1 });
    await ledger.requestDrain({
      creditId: "waiting",
      drainId: "mine",
      callerPubkey: CALLER,
      method: "stripe",
      payout: {},
      nowMs: fundedAtMs + 2,
    });
    await ledger.release({ creditId: "waiting", drawId: "hold" });

    // Waiting credits leave the listing's page to the rest, and are refused if asked directly.
    const listed = await ledger.listExpiredCardCredits({ nowMs: now });
    expect(listed).toContain("neighbour");
    expect(listed).not.toContain("waiting");
    expect(listed).not.toContain("squatter");
    expect(await ledger.openCardExpiryRefund({ creditId: "waiting", nowMs: now })).toBeUndefined();

    const summary = await runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {} }, { nowMs: now });
    expect(summary.failedSteps).toEqual([]);
    // Credits from earlier tests share this schema, so look only at these two.
    expect(summary.expiryRefunds).toContain("neighbour");
    expect(summary.expiryRefunds).not.toContain("squatter");
    expect(summary.expiryRefunds).not.toContain("waiting");
    // The released $0.30 waits for the unfinished refund; it is not planned against the same charge twice.
    expect(await ledger.get("squatter")).toMatchObject({ status: "active", balanceMicro: 300_000 });
    expect(await ledger.get("waiting")).toMatchObject({ status: "active", balanceMicro: 300_000 });
    const { rows } = await db.query(
      `SELECT credit_id FROM credit_drains WHERE credit_id IN ('squatter', 'waiting') ORDER BY credit_id`
    );
    expect(rows.map((row) => row.credit_id)).toEqual(["squatter", "waiting"]);
  });

  it("unfreezes a credit whose dispute was won and refunds it at expiry; a lost one stays frozen", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    const expiryMs = now + HOUR_MS;
    await cardCredit(account, { creditId: "won", pi: "pi_won", cents: 200, expiryMs });
    await cardCredit(account, { creditId: "lost", pi: "pi_lost", cents: 200, expiryMs });
    account.dispute("pi_won");
    account.dispute("pi_lost");
    const sweep = (nowMs: number) =>
      runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {} }, { nowMs });
    expect((await sweep(now)).frozen.sort()).toEqual(["lost", "won"]);

    account.settleDisputes("pi_won", "won");
    account.settleDisputes("pi_lost", "lost");
    const settled = await sweep(now + 1000);
    expect(settled.unfrozen).toEqual(["won"]);
    expect(settled.frozen).toEqual([]);
    expect((await ledger.get("won"))?.status).toBe("active");
    expect((await ledger.get("lost"))?.status).toBe("disputed");

    // A later pass does not freeze it again, and expiry refunds it like any card credit.
    const later = await sweep(expiryMs + HOUR_MS);
    expect(later.frozen).toEqual([]);
    expect(later.expiryRefunds).toContain("won");
    expect(await ledger.get("won")).toMatchObject({ status: "refunded", balanceMicro: 0 });
    // Nothing was spent: $2.00 less the whole 36-cent fee.
    expect([...account.refunds.values()].map((r) => [r.payment_intent, r.amount])).toEqual([["pi_won", 164]]);
    expect((await ledger.get("lost"))?.status).toBe("disputed");
  });

  it("keeps a credit frozen for a lost dispute that has aged out of the recent listing", async () => {
    const account = fakeStripeAccount();
    const DAY_MS = 24 * HOUR_MS;
    const now = Date.now();
    const expiryMs = now + 400 * DAY_MS;
    for (const pi of ["pi_aged_lost", "pi_recent_won"]) {
      await cardCredit(account, { creditId: "two-disputes", pi, cents: 1000, expiryMs, fundedAtMs: now - 300 * DAY_MS });
    }
    const sweep = (nowMs: number) =>
      runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {} }, { nowMs });

    // 100 days ago the lost dispute was recent, and froze the credit.
    account.dispute("pi_aged_lost", "lost", now - 200 * DAY_MS);
    expect((await sweep(now - 100 * DAY_MS)).frozen).toContain("two-disputes");

    // Now it is older than the listing reaches, and a dispute on the other top-up is won.
    account.dispute("pi_recent_won", "won", now - 10 * DAY_MS);
    const pass = await sweep(now);
    expect(pass.unfrozen).not.toContain("two-disputes");
    expect((await ledger.get("two-disputes"))?.status).toBe("disputed");
    await expect(
      ledger.draw({ creditId: "two-disputes", drawId: "j", amountMicro: 15_000_000, jobId: "j" })
    ).rejects.toMatchObject({ code: "credit_closed" });
  });

  it("keeps searching for a charge Stripe does not show yet, within a day", async () => {
    const account = fakeStripeAccount();
    const journal = await createPostgresCardChargeJournal(db);
    await journal.record("challenge-not-indexed-yet");
    const sweep = (nowMs: number) =>
      runCardRefundSweep({ ledger, stripe: stripeApi(account), drainReport: {}, journal }, { nowMs });
    const unresolved = async (nowMs: number) =>
      (await journal.listUnresolved({ olderThanMs: nowMs, limit: 100 })).map((a) => a.challengeId);

    await sweep(Date.now() + HOUR_MS);
    expect(await unresolved(Date.now() + HOUR_MS)).toContain("challenge-not-indexed-yet");
    await sweep(Date.now() + 25 * HOUR_MS);
    expect(await unresolved(Date.now() + 25 * HOUR_MS)).not.toContain("challenge-not-indexed-yet");
  });

  it("serializes operator recovery across ledger instances and works with a one-connection pool", async () => {
    const account = fakeStripeAccount();
    await cardCredit(account, { creditId: "recovery-race", pi: "pi_race", cents: 200, expiryMs: Date.now() + HOUR_MS });
    account.intents.get("pi_race")!.refunded = 200;
    const { drain: requested } = await ledger.requestDrain({ creditId: "recovery-race", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    const deps = { ledger, stripe: stripeApi(account), drainReport: {} };
    expect((await runStripeDrain(deps, requested)).drain.status).toBe("refund_blocked");
    account.intents.get("pi_race")!.refunded = 0;
    const pg = await import("pg");
    const single = new pg.default.Pool({ connectionString: DATABASE_URL, max: 1, options: `-c search_path=${SCHEMA}` });
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const stripe = { ...stripeApi(account), retrieveCharge: async (id: string) => {
      entered(); await gate; return stripeApi(account).retrieveCharge(id);
    } };
    const replan = recoverCardDrain({ ledger: new CreditLedger(single), stripe, drainReport: {} }, {
      creditId: "recovery-race", drainId: "d", decisionId: "replan", action: "replan", reason: "Funding repaired" });
    try {
      await started;
      await expect(recoverCardDrain({ ...deps, ledger: new CreditLedger(db) }, {
        creditId: "recovery-race", drainId: "d", decisionId: "close", action: "close", reason: "No refund" }))
        .rejects.toMatchObject({ code: "card_refund_busy" });
    } finally { release(); }
    try {
      expect((await replan).drain.status).toBe("sent");
      expect([...account.refunds.values()].map((refund) => refund.amount)).toEqual([164]);
      expect((await ledger.getDrain({ creditId: "recovery-race", drainId: "d" }))?.cardRecovery?.decisions)
        .toEqual([expect.objectContaining({ decisionId: "replan", action: "replan" })]);
    } finally { await single.end(); }
  });

  it.each([
    ["sql-null", null], ["json-null", "null"],
  ])("plans and completes a refund whose saved plan is %s", async (suffix, storedPlan) => {
    const account = fakeStripeAccount();
    const creditId = `empty-plan-${suffix}`;
    const pi = `pi_empty_${suffix}`;
    await cardCredit(account, { creditId, pi, cents: 200, expiryMs: Date.now() + HOUR_MS });
    const { drain: requested } = await ledger.requestDrain({ creditId, drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    await db.query("UPDATE credit_drains SET card_refund=$3::jsonb WHERE credit_id=$1 AND drain_id=$2", [creditId, "d", storedPlan]);
    const result = await runStripeDrain({ ledger, stripe: stripeApi(account), drainReport: {} }, requested);
    expect(result).toMatchObject({ completed: true, drain: { status: "sent", sentRef: { refunded_cents: 164 } } });
    expect([...account.refunds.values()].map((refund) => [refund.payment_intent, refund.amount])).toEqual([[pi, 164]]);
    expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
  });

  it("lets expiry refund remaining released holds after a blocked drain is written off", async () => {
    const account = fakeStripeAccount();
    const now = Date.now();
    await cardCredit(account, { creditId: "recover-expiry", pi: "pi_recover_expiry", cents: 200, expiryMs: now + HOUR_MS });
    await ledger.draw({ creditId: "recover-expiry", drawId: "hold", amountMicro: 300_000, jobId: "hold" });
    const { drain: requested } = await ledger.requestDrain({ creditId: "recover-expiry", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    account.intents.get("pi_recover_expiry")!.refunded = 200;
    const deps = { ledger, stripe: stripeApi(account), drainReport: {} };
    await runStripeDrain(deps, requested);
    await ledger.release({ creditId: "recover-expiry", drawId: "hold" });
    const expiry = now + 2 * HOUR_MS;
    expect(await ledger.openCardExpiryRefund({ creditId: "recover-expiry", nowMs: expiry })).toBeUndefined();
    await recoverCardDrain(deps, { creditId: "recover-expiry", drainId: "d", decisionId: "close", action: "close", reason: "Reviewed permanent refusal" });
    account.intents.get("pi_recover_expiry")!.refunded = 170;
    const summary = await runCardRefundSweep(deps, { nowMs: expiry });
    expect(summary.expiryRefunds).toContain("recover-expiry");
    expect((await ledger.getDrain({ creditId: "recover-expiry", drainId: cardExpiryDrainId(now + HOUR_MS) }))?.status).toBe("sent");
    expect([...account.refunds.values()].map((refund) => refund.amount)).toEqual([25]);
    expect((await ledger.getDrain({ creditId: "recover-expiry", drainId: "d" }))?.cardRecovery?.writtenOffMicro).toBe(1_700_000);
    expect(await ledger.get("recover-expiry")).toMatchObject({ status: "refunded", balanceMicro: 0 });
  });

  it("preserves refund evidence across the additive recovery migration", async () => {
    const account = fakeStripeAccount();
    await cardCredit(account, { creditId: "legacy-refund", pi: "pi_legacy_refund", cents: 200, expiryMs: Date.now() + HOUR_MS });
    const { drain: requested } = await ledger.requestDrain({ creditId: "legacy-refund", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    account.control.rejectRefunds = 1;
    await runStripeDrain({ ledger, stripe: stripeApi(account), drainReport: {} }, requested);
    const before = await ledger.getDrain({ creditId: "legacy-refund", drainId: "d" });
    await db.query("ALTER TABLE credit_drains DROP COLUMN card_recovery");
    const migrated = new CreditLedger(db);
    await migrated.init();
    await migrated.init();
    const after = await migrated.getDrain({ creditId: "legacy-refund", drainId: "d" });
    expect(after?.cardRefund).toEqual(before?.cardRefund);
    expect(after?.cardRecovery).toBeNull();
    expect((await runStripeDrain({ ledger: migrated, stripe: stripeApi(account), drainReport: {} }, after!)).drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
  });


  it("rolls booking back with the outbox while retaining completed Stripe refunds for retry", async () => {
    const account = fakeStripeAccount();
    await cardCredit(account, { creditId: "report-rollback", pi: "pi_report_rollback", cents: 200, expiryMs: Date.now() + HOUR_MS });
    const { drain: requested } = await ledger.requestDrain({ creditId: "report-rollback", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    const stripe = stripeApi(account);
    await expect(runStripeDrain({ ledger, stripe, drainReport: { db, dvmId: "example", enqueueCreditDrain: async () => { throw new Error("outbox unavailable"); } } }, requested))
      .rejects.toThrow("outbox unavailable");
    const pending = (await ledger.getDrain({ creditId: "report-rollback", drainId: "d" }))!;
    expect(pending).toMatchObject({ status: "pending", sentRef: null, cardRefund: { entries: [expect.objectContaining({ status: "succeeded" })] } });
    const reports: CreditDrainPayload[] = [];
    expect((await runStripeDrain({ ledger, stripe, drainReport: { db, dvmId: "example", enqueueCreditDrain: async (_tx, report) => { reports.push(report); } } }, pending)).drain.status).toBe("sent");
    expect(account.refunds.size).toBe(1);
    expect(reports).toEqual([expect.objectContaining({ status: "sent", amountMicro: 2_000_000 })]);
  });

  it("exports write-off amounts and decisions without operator free text", async () => {
    const account = fakeStripeAccount();
    await cardCredit(account, { creditId: "export-close", pi: "pi_export_close", cents: 200, expiryMs: Date.now() + HOUR_MS });
    account.intents.get("pi_export_close")!.refunded = 200;
    const { drain: requested } = await ledger.requestDrain({ creditId: "export-close", drainId: "d", callerPubkey: CALLER, method: "stripe", payout: {} });
    const deps = { ledger, stripe: stripeApi(account), drainReport: {} };
    await runStripeDrain(deps, requested);
    await recoverCardDrain(deps, { creditId: "export-close", drainId: "d", action: "close", decisionId: "private-decision-sentinel", reason: "private-reason-sentinel" });
    const recipe = readFileSync(new URL("../../../../recipes/postgres/financial-export-v1.sql", import.meta.url), "utf8");
    const client = await db.connect();
    try {
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      const exported = results.find((result) => result.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;
      expect(exported.drains).toContainEqual(expect.objectContaining({ credit_id: "export-close", status: "written_off",
        card_recovery: { revision: 0, blockedAt: expect.any(Number), blockedReason: "charges_exhausted", refundedGrossMicro: 0,
          writtenOffMicro: 2_000_000, decisions: [{ action: "close", decidedAt: expect.any(Number) }] } }));
      expect(JSON.stringify(exported)).not.toContain("private-reason-sentinel");
      expect(JSON.stringify(exported)).not.toContain("private-decision-sentinel");
    } finally { client.release(); }
  });

});
