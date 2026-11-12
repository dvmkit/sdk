import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppEnv } from "../app";
import { runCardRefundSweep } from "../card-refund-sweep";
import { CreditLedger } from "../credit-ledger";
import { handleCreditRequest } from "../credit-routes";
import { derivedFundCreditId } from "../funding";
import { HostingControl, type HostingClosureCommand } from "../hosting-control";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { PostgresX402BatchStore } from "../payout-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { CHECKOUT_ABANDONED_AFTER_MS } from "../stripe-checkout-recovery";
import { createPostgresStripeCheckoutStore } from "../stripe-checkout-store";
import { CALLER, noRateFx } from "./__helpers__/card-credit";
import { checkoutFund, checkoutServer } from "./__helpers__/stripe-checkout";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_checkout_hosting";
const dvmId = "checkout-hosted";
const scope = "test-deployment";
const support = { singleMount: true, durableLedger: true, durableJobStore: true,
  durableReporter: true, durablePaymentReplay: true, knownRailStores: true };

describe.skipIf(!RUN)("hosted Checkout admission and closure", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let control: HostingControl;
  let ledger: CreditLedger;
  let server: Awaited<ReturnType<typeof checkoutServer>>;
  let app: Hono<AppEnv>;
  let admissions: number;

  beforeEach(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
    await new HostedSettlementReportObligations(pool, dvmId, scope).init();
    const jobs = new PostgresJobStore(pool); await jobs.init();
    ledger = new CreditLedger(pool); await ledger.init();
    const processed = new PostgresProcessedPaymentStore(pool); await processed.init();
    await new RevenueReporter(pool, "https://example.com", "test-token").init();
    await new PostgresX402BatchStore(pool).init();
    control = new HostingControl(pool, dvmId, { secret: "test-only-hosting-cleanup-secret-32-bytes", scope });
    await control.init();
    jobs.useHostingCleanupFence(control.cleanupFence);
    ledger.useHostingCleanupFence(control.cleanupFence);
    expect(await control.transition({ action: "resume", version: 2, dvmId, scope, generation: 1,
      leaseExpiresAtMs: Date.now() + 60_000, deadlineMs: Date.now() + 90_000,
      timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}` })).toBe("ok");
    server = await checkoutServer({ ledger, checkoutStore: await createPostgresStripeCheckoutStore(pool),
      serverOpts: { processedPayments: processed, dvmId },
    });
    const menu = (await (await server.app.request("/v1/info")).json()).credit;
    admissions = 0;
    app = new Hono<AppEnv>();
    app.post("/v1/credit", (c) => handleCreditRequest(c, {
      menu: async () => menu, creditConfig: undefined, auth: secp256k1Auth(), ledger, fxFetcher: noRateFx,
      railOpts: async () => ({ requiredMsats: 0, creditLedger: ledger, processedPayments: processed, dvmId }),
      onDeposit: () => {}, drainReport: {}, receiptIssuer: undefined, lightning: undefined,
      settleLightning: async () => {}, stripeCredit: server.rail,
      withFundingAdmission: async (_c, body, run) => {
        admissions++;
        const id = randomUUID();
        const fundId = body.fund!.fund_id;
        const creditId = derivedFundCreditId(body.pubkey, fundId);
        if (!await control.admit(id, `credit-fund:${creditId}:${fundId}`, { creditId, fundId, callerPubkey: body.pubkey })) {
          return Response.json({ error: "hosting_draining" }, { status: 503 });
        }
        const response = await run();
        await control.finishAdmission(id, response.ok ? "accepted" : "failed");
        return response;
      },
    }));
  });

  afterEach(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await admin.end();
  });

  async function close() {
    const command: HostingClosureCommand = { version: 3, action: "close", dvmId, scope, generation: 2,
      operationId: `operation_${randomUUID().replaceAll("-", "")}`, timestampMs: Date.now(),
      nonce: `nonce_${randomUUID().replaceAll("-", "")}` };
    expect(await control.close(command, support)).toBe("ok");
    return () => control.certificate({ ...command, action: "certificate" }, support);
  }

  it("re-admits a failed create before exposing a URL and can book under the hosting fence", async () => {
    server.account.loseCreateReply();
    expect((await checkoutFund(app, "hiccup")).status).toBe(503);
    expect((await server.store.get("hiccup"))?.state).toBe("creating");
    expect((await checkoutFund(app, "hiccup")).status).toBe(202);
    server.account.paid("hiccup");
    expect((await checkoutFund(app, "hiccup")).status).toBe(200);
    expect(admissions).toBe(2);
    expect((await ledger.get(derivedFundCreditId(CALLER, "hiccup")))?.balanceMicro).toBe(5_000_000);
  });

  it("does not persist a session when sizing or hosting admission refuses it", async () => {
    expect((await checkoutFund(app, "small", { amount_micro: 10_000 })).status).toBe(400);
    expect(await server.store.get("small")).toBeUndefined();
    await close();
    expect((await checkoutFund(app, "closed")).status).toBe(503);
    expect(await server.store.get("closed")).toBeUndefined();
    expect(server.account.forms).toEqual([]);
  });

  it("blocks closure for a creating attempt even though its admission failed", async () => {
    server.account.loseCreateReply();
    expect((await checkoutFund(app)).status).toBe(503);
    const certificate = await close();
    expect((await certificate())?.reasons).toContain("checkout_sessions_unresolved");
  });

  it("blocks closure for an open session and releases an expired unbooked admission", async () => {
    expect((await checkoutFund(app)).status).toBe(202);
    const certificate = await close();
    expect((await certificate())?.reasons).toContain("checkout_sessions_unresolved");
    server.account.sessions.get("cs_test_1")!.status = "expired";
    expect((await checkoutFund(app)).status).toBe(409);
    expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
  });

  it("releases hosted closure after a lost dispute without refunding or booking the charge", async () => {
    await checkoutFund(app);
    server.account.paid("checkout");
    server.account.dispute("pi_cs_test_1", "under_review");
    const certificate = await close();
    const recover = (nowMs: number) => runCardRefundSweep({ ledger, stripe: server.rail.refunds,
      checkout: server.rail.checkout, drainReport: {} }, { nowMs });
    const now = Date.now() + CHECKOUT_ABANDONED_AFTER_MS + 1000;
    await recover(now);
    expect((await certificate())?.reasons).toContain("checkout_sessions_unresolved");
    server.account.dispute("pi_cs_test_1", "lost");
    await recover(now + 3600_000 + 1000);
    expect((await server.store.get("checkout"))?.state).toBe("expired");
    expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
    expect(server.account.refunds).toEqual([]);
    expect((await checkoutFund(app)).status).toBe(409);
    expect(await ledger.get(derivedFundCreditId(CALLER, "checkout"))).toBeUndefined();
  });

  it("blocks closure through an abandoned refund and releases its unbooked admission afterward", async () => {
    expect((await checkoutFund(app)).status).toBe(202);
    server.account.paid("checkout");
    const certificate = await close();
    // A closed hosting fence cannot book fresh money; the durable session must keep recovery alive.
    expect((await checkoutFund(app)).status).toBe(503);
    expect((await certificate())?.reasons).toContain("checkout_sessions_unresolved");
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    server.account.onRefund(async () => { enter(); await held; });
    const recovering = runCardRefundSweep({ ledger, stripe: server.rail.refunds, checkout: server.rail.checkout, drainReport: {} },
      { nowMs: Date.now() + CHECKOUT_ABANDONED_AFTER_MS + 1000 });
    await entered;
    try { expect((await certificate())?.reasons).toContain("checkout_sessions_unresolved"); }
    finally { release(); }
    expect((await recovering).strandedRefunds).toEqual(["pi_cs_test_1"]);
    expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
  });
});
