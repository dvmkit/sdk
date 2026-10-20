import { createHash, randomUUID } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";

import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { commitBalancePayment } from "../balance-payment";
import { HostingControl } from "../hosting-control";
import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const RUN = !!process.env.DATABASE_URL;
const schema = `sdk_balance_${randomUUID().replaceAll("-", "")}`;
const key = Buffer.from("12".repeat(32), "hex");
const caller = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
const domain = { audience: { dvm_id: "example-dvm", builder_pubkey: "ab".repeat(32) }, method: "POST", path: "/v1/job/job/messages", capability: null };
const signer = createSignedRequestVerifier(z.object({}), { replayStore: null });
let now = Math.floor(Date.now() / 1000);
const auth = secp256k1Auth({ now: () => now });
const tokenHash = createHash("sha256").update("token").digest("hex");

describe.skipIf(!RUN)("balance payment atomic persistence", () => {
  let pool: Pool;
  let other: Pool;
  let ledger: CreditLedger;
  let store: PostgresJobStore;
  beforeAll(async () => {
    await recreateSchema(schema);
    pool = await pinnedPool(schema);
    other = await pinnedPool(schema);
    ledger = new CreditLedger(pool);
    store = new PostgresJobStore(pool);
    await ledger.init();
    await store.init();
  });
  beforeEach(async () => {
    now = Math.floor(Date.now() / 1000);
    await pool.query("TRUNCATE credit_balance_payments, job_messages, jobs, credit_draws, credit_fundings, credit_funding_lots, credits CASCADE");
    await ledger.fund({ creditId: "credit", callerPubkey: caller, currency: "usd", amountMicro: 10_000,
      expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: 100_000 } });
    await store.save({ id: "job", tags: [], capability: "run", input: "", params: {},
      requesterId: "caller", requesterPubkey: caller, requesterTokenHash: tokenHash,
      status: "awaiting-input", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
      stepCache: [], state: {}, createdAt: Date.now(), lastActivityAt: Date.now() });
    await store.appendOutgoing("job", { from: "provider", type: "payment-request", timestamp: now,
      content: { amount_msats: 10_000, reason: "work", credit: { amount_micro: 1_000, currency: "usd" } } },
    { awaitingInput: true, pendingPaymentDelta: 10_000, pendingPaymentFiatMicro: 1_000, pendingPaymentFiatCurrency: "usd" });
  });
  afterAll(async () => {
    await pool?.end();
    await other?.end();
    await dropSchemas(schema);
  });

  function signed(overrides: Record<string, unknown> = {}, timestamp = now) {
    return signer.signRequest(key, { credit_id: "credit", draw_id: "draw", payment_id: "payment",
      request_seq: 1, amount_micro: 1_000, currency: "usd", ...overrides }, { timestamp }, domain);
  }
  function pay(raw: unknown = signed(), second = false) {
    return commitBalancePayment({ pool: second ? other : pool, ledger: second ? new CreditLedger(other) : ledger,
      auth, domain, jobId: "job", dvmId: "example-dvm", raw });
  }

  it("finishes concurrent duplicate acceptance with a supported two-connection pool", async () => {
    const pg = await import("pg");
    const bounded = new pg.default.Pool({ connectionString: process.env.DATABASE_URL,
      options: `-c search_path=${schema}`, max: 2, connectionTimeoutMillis: 500 });
    try {
      const raw = signed();
      const accept = () => commitBalancePayment({ pool: bounded, ledger: new CreditLedger(bounded),
        auth, domain, jobId: "job", dvmId: "example-dvm", raw });
      expect((await Promise.all([accept(), accept()])).map((result) => result.response))
        .toEqual([{ seq: 2 }, { seq: 2 }]);
      expect((await ledger.get("credit"))?.availableMicro).toBe(9_000);
    } finally { await bounded.end(); }
  });

  it("releases a dead worker's zero-rail paid hold without sending an unsupported msat notice", async () => {
    await pool.query("UPDATE credits SET msats_remaining=1 WHERE credit_id='credit'");
    await pay();
    await pool.query("UPDATE jobs SET status='processing',last_activity_at=$1 WHERE id='job'", [Date.now() - 60_000]);
    const deaths: unknown[] = [];
    const descriptor = configureDVM({ name: "example-dvm", capability: "run", onJob(ctx) { ctx.complete("done"); } });
    const manager = new JobManager(descriptor, { env: {}, store: new MemoryKVStore(), jobStore: store,
      db: pool, creditLedger: ledger, fxFetcher: createFxFetcher(), dvmId: "example-dvm", processingWatchdogMs: 1000,
      staleJobSweepIntervalMs: 86_400_000, heartbeatIntervalMs: 0, onPaidJobDeath: (info) => { deaths.push(info); } });
    try {
      expect((await store.get("job"))?.paidMsats).toBe(0);
      expect(await manager.sweepStaleJobs()).toEqual({ swept: 1 });
      expect(deaths).toHaveLength(0);
      expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("released");
      expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
      expect(await manager.sweepStaleJobs()).toEqual({ swept: 0 });
      expect(deaths).toHaveLength(0);
    } finally { manager.shutdown(); }
  });

  it("serializes duplicate delivery across connections and retains the original terminal outcome beyond drift", async () => {
    const raw = signed();
    const outcomes = await Promise.all([pay(raw), pay(raw, true)]);
    expect(outcomes.map((outcome) => outcome.response)).toEqual([{ seq: 2 }, { seq: 2 }]);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(1);
    expect((await ledger.get("credit"))?.availableMicro).toBe(9_000);
    expect((await store.getMessages("job", 0)).filter((message) => message.type === "payment")).toHaveLength(1);
    await pool.query("UPDATE jobs SET status='completed' WHERE id='job'");
    await ledger.settle({ creditId: "credit", drawId: "draw" });
    now += 3_600;
    expect(await pay(raw, true)).toEqual({ response: { seq: 2 }, replayed: true });
    expect(await pay(signed({}, now), true)).toEqual({ response: { seq: 2 }, replayed: true });
    expect((await ledger.get("credit"))?.balanceMicro).toBe(9_000);
    expect(await commitBalancePayment({ pool, ledger, auth, domain, jobId: "job", dvmId: "example-dvm", raw, allowFresh: false }))
      .toEqual({ response: { seq: 2 }, replayed: true });
  });

  it("competing IDs cannot pay the same ask twice, and altered reuse cannot select another job or amount", async () => {
    const outcomes = await Promise.allSettled([pay(signed()), pay(signed({ payment_id: "other" }), true)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(1_000);
    const winner = outcomes[0].status === "fulfilled" ? "payment" : "other";
    await expect(pay(signed({ payment_id: winner, amount_micro: 2_000 }))).rejects.toMatchObject({ status: 409, body: { error: "credit_payment_conflict" } });
    await expect(commitBalancePayment({ pool, ledger, auth, domain: { ...domain, path: "/v1/job/other/messages" }, jobId: "other", dvmId: "example-dvm", raw: signed({ payment_id: winner }) })).rejects.toMatchObject({ sub_reason: "signature_invalid" });
  });

  it("insufficient balance leaves no draw, inbound or reserved payment ID and can retry after funding", async () => {
    await pool.query("UPDATE credits SET balance_micro=400 WHERE credit_id='credit'");
    await expect(pay()).rejects.toMatchObject({ status: 402, body: { error: "insufficient_credit", remaining_micro: 400, shortfall_micro: 600 } });
    expect((await pool.query("SELECT * FROM credit_balance_payments")).rowCount).toBe(0);
    expect((await pool.query("SELECT * FROM credit_draws")).rowCount).toBe(0);
    expect((await store.getMessages("job", 0)).filter((message) => message.type === "payment")).toHaveLength(0);
    expect((await store.get("job"))?.pendingPaymentMsats).toBe(10_000);
    await ledger.fund({ creditId: "credit", callerPubkey: caller, currency: "usd", amountMicro: 1_000,
      expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: 10_000 } });
    expect(await pay()).toMatchObject({ response: { seq: 2 }, replayed: false });
  });

  it.each([
    [{ request_seq: 0 }, "credit_payment_ask_mismatch"],
    [{ amount_micro: 999 }, "credit_payment_ask_mismatch"],
    [{ currency: "eur" }, "credit_payment_ask_mismatch"],
  ])("refuses an authorization that does not match the durable ask: %j", async (changes, error) => {
    await expect(pay(signed(changes))).rejects.toMatchObject({ status: 409, body: { error } });
    expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
  });

  it("checks owner, currency, freshness and signature before placing a hold", async () => {
    await pool.query("UPDATE credits SET caller_pubkey=$1 WHERE credit_id='credit'", ["ff".repeat(32)]);
    await expect(pay()).rejects.toMatchObject({ body: { error: "credit_payment_owner_mismatch" } });
    await pool.query("UPDATE credits SET caller_pubkey=$1,currency='eur' WHERE credit_id='credit'", [caller]);
    await expect(pay()).rejects.toMatchObject({ body: { error: "credit_payment_currency_mismatch" } });
    await expect(pay(signed({}, now - 301))).rejects.toMatchObject({ sub_reason: "timestamp_drift" });
    const raw = signed();
    await expect(pay({ ...raw, amount_micro: 2_000 })).rejects.toMatchObject({ sub_reason: "signature_invalid" });
    expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
  });

  it("grows the existing draw and releases its entire hold on cancellation", async () => {
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await pool.query("UPDATE jobs SET credit_id='credit',draw_id='draw' WHERE id='job'");
    await pay();
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(3_000);
    await pool.query("UPDATE jobs SET status='cancelled' WHERE id='job'");
    await ledger.release({ creditId: "credit", drawId: "draw" });
    expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
    expect(await pay()).toMatchObject({ response: { seq: 2 }, replayed: true });
  });

  it("keeps a later ask independent of an earlier payment replay", async () => {
    await pay();
    await store.appendOutgoing("job", { from: "provider", type: "payment-request", timestamp: now,
      content: { amount_msats: 10_000, reason: "second step", credit: { amount_micro: 1_000, currency: "usd" } } },
    { awaitingInput: true, pendingPaymentDelta: 10_000, pendingPaymentFiatMicro: 1_000, pendingPaymentFiatCurrency: "usd" });
    expect(await pay()).toMatchObject({ response: { seq: 2 }, replayed: true });
    expect((await store.get("job"))?.pendingPaymentMsats).toBe(10_000);
    expect(await pay(signed({ payment_id: "second", request_seq: 3 }))).toMatchObject({ response: { seq: 4 } });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_000);
    expect((await ledger.get("credit"))?.availableMicro).toBe(8_000);
  });

  it("refuses a stale full-ask authorization after partial rail growth instead of clipping the signed spend", async () => {
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await ledger.growDraw({ creditId: "credit", drawId: "draw", addAmountMicro: 400, capMicro: 1_000, jobId: "job" });
    await pool.query("UPDATE jobs SET credit_id='credit',draw_id='draw' WHERE id='job'");
    await expect(pay()).rejects.toMatchObject({ body: { error: "credit_payment_ask_mismatch" } });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_400);
    expect((await ledger.get("credit"))?.availableMicro).toBe(7_600);
    expect((await pool.query("SELECT * FROM credit_balance_payments")).rowCount).toBe(0);
  });

  it("does not place a hold after cancellation wins the job-row lock", async () => {
    const cancel = await other.connect();
    try {
      await cancel.query("BEGIN");
      await cancel.query("SELECT id FROM jobs WHERE id='job' FOR UPDATE");
      const payment = pay();
      await cancel.query("UPDATE jobs SET status='cancelled' WHERE id='job'");
      await cancel.query("COMMIT");
      await expect(payment).rejects.toMatchObject({ body: { error: "job_not_active" } });
      expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
    } finally {
      await cancel.query("ROLLBACK");
      cancel.release();
    }
  });

  it("fresh balance growth enforces expiry without changing accepted rail top-up semantics", async () => {
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await pool.query("UPDATE jobs SET credit_id='credit',draw_id='draw' WHERE id='job'");
    await pool.query("UPDATE credits SET expiry_ms=1 WHERE credit_id='credit'");
    await expect(pay()).rejects.toMatchObject({ body: { error: "credit_expired" } });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_000);
    expect((await ledger.growDraw({ creditId: "credit", drawId: "draw", addAmountMicro: 1_000 })).amountMicro).toBe(3_000);
  });

  it("takes the Tempo channel lock before growing an existing hold and refuses closing collateral", async () => {
    const sessions = new PostgresTempoSessionStore(pool);
    await sessions.init();
    const channelId = "0x" + "ab".repeat(32);
    await sessions.put(channelId, { finalized: false, closeRequestedAt: 0n, spent: 0n,
      settledOnChain: 0n, highestVoucherAmount: 100_000n });
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await pool.query("UPDATE jobs SET credit_id='credit',draw_id='draw' WHERE id='job'");
    await pool.query("UPDATE credits SET tempo_channel_id=$1 WHERE credit_id='credit'", [channelId]);
    await sessions.update(channelId, (current) => ({ op: "set", value: { ...(current as object), closeRequestedAt: 1n }, result: undefined }));
    await expect(commitBalancePayment({ pool, ledger: new CreditLedger(pool, sessions), auth, domain,
      jobId: "job", dvmId: "example-dvm", raw: signed() })).rejects.toMatchObject({ body: { error: "tempo_channel_closing" } });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_000);
  });

  it("refuses existing x402 collateral while its refund settlement is unresolved", async () => {
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await pool.query("UPDATE jobs SET credit_id='credit',draw_id='draw' WHERE id='job'");
    await pool.query("UPDATE credits SET x402_channel_id='channel' WHERE credit_id='credit'");
    ledger.useX402SettlementGate({ pendingRefundSettlement: async () => ({ settlementId: "settlement", effectId: "credit:drain", status: "submitting" }) });
    try {
      await expect(pay()).rejects.toMatchObject({ body: { error: "settlement_pending" } });
      expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_000);
    } finally {
      ledger.useX402SettlementGate({ pendingRefundSettlement: async () => undefined });
    }
  });

  it("refuses growth after hosted closure through the existing durable intent fence", async () => {
    const control = new HostingControl(pool, "example-dvm", {
      secret: "test-only-balance-hosting-secret-32-bytes", scope: "example-scope",
    });
    await control.init();
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 2_000, jobId: "job" });
    await pool.query("UPDATE jobs SET dvm_id='example-dvm',credit_id='credit',draw_id='draw' WHERE id='job'");
    await pool.query(`INSERT INTO sdk_hosting_admissions(id,dvm_id,scope,job_id,admitted_at_ms,outcome)
      VALUES('admission','example-dvm','example-scope','job',0,'accepted')`);
    await pool.query("UPDATE sdk_hosting_control SET state='closed',closed_at_ms=1,closed_at_us=1000");
    const fenced = new CreditLedger(pool);
    fenced.useHostingCleanupFence(control.cleanupFence);
    const request = () => commitBalancePayment({ pool, ledger: fenced, auth, domain,
      jobId: "job", dvmId: "example-dvm", raw: signed() });
    await expect(request()).rejects.toThrow("Hosted payment has no pre-closure inbound intent");
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(2_000);
    expect((await ledger.get("credit"))?.availableMicro).toBe(8_000);
    expect((await store.get("job"))?.pendingPaymentMsats).toBe(10_000);
    expect((await pool.query("SELECT * FROM credit_balance_payments")).rowCount).toBe(0);
    expect((await store.getMessages("job", 0)).filter((message) => message.type === "payment")).toHaveLength(0);
    await pool.query("UPDATE sdk_hosting_control SET state='draining',closed_at_ms=NULL,closed_at_us=NULL");
    expect(await request()).toMatchObject({ response: { seq: 2 } });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.amountMicro).toBe(3_000);
  });

  it("rolls debit and verified inbound back when persisting the payment identity fails", async () => {
    await pool.query(`CREATE FUNCTION refuse_balance_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'write unavailable'; END $$`);
    await pool.query("CREATE TRIGGER refuse_balance_payment BEFORE INSERT ON credit_balance_payments FOR EACH ROW EXECUTE FUNCTION refuse_balance_payment()");
    try {
      await expect(pay()).rejects.toThrow("write unavailable");
      expect((await ledger.get("credit"))?.availableMicro).toBe(10_000);
      expect((await store.get("job"))?.pendingPaymentMsats).toBe(10_000);
      expect((await pool.query("SELECT * FROM credit_draws")).rowCount).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER refuse_balance_payment ON credit_balance_payments");
      await pool.query("DROP FUNCTION refuse_balance_payment()");
    }
    expect(await pay()).toMatchObject({ response: { seq: 2 } });
  });
});
