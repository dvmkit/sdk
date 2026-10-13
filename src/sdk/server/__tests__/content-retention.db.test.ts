import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyDrainReceipt, verifyFundingReceipt, verifyReceipt, type DrainReceipt, type FundingReceipt, type JobReceipt } from "../../../lib/receipt";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { ContentHoldError } from "../content-retention";
import { CreditLedger } from "../credit-ledger";
import { PostgresConsumedCredentialStore } from "../postgres-consumed-credential-store";
import { PostgresJobStore } from "../postgres-job-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { ACTIVITY, ADMIN_KEY, contentJob } from "./__helpers__/content-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const recipe = readFileSync(process.env.FINANCIAL_EXPORT_RECIPE ?? new URL("../../../../recipes/postgres/financial-export-v1.sql", import.meta.url), "utf8");
const place = { action: "placed" as const, purpose: "dispute" as const, reason: "case", review_due_at: ACTIVITY + 100, actor: ADMIN_KEY, at: ACTIVITY };

async function waitForLock(pool: pg.Pool, application: string): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const { rows } = await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [application]);
    if (rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Expected ${application} to wait on the job fence`);
}

describe.skipIf(!RUN)("durable content holds and financial export", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
    await new CreditLedger(pool).init();
  });
  afterEach(async () => {
    await pool.query("DELETE FROM job_messages; DELETE FROM request_id_claims; DELETE FROM jobs; DELETE FROM credit_drains; DELETE FROM credit_draws; DELETE FROM credit_fundings; DELETE FROM credit_funding_lots; DELETE FROM credit_invoices; DELETE FROM credit_expiry_releases; DELETE FROM credits;");
  });
  afterAll(async () => { await pool.end(); });

  it("persists multiple holds/history through restart and freezes legacy terminal clocks", async () => {
    await store.save(contentJob());
    const first = await store.mutateContentHold("example-job", place);
    await store.mutateContentHold("example-job", { ...place, purpose: "support" });
    const restarted = new PostgresJobStore(pool);
    await restarted.init();
    const initial = await restarted.getContentSnapshot("example-job");
    expect(initial?.history.holds).toHaveLength(2);
    expect(initial?.history.events[0]).toEqual(first.events[0]);
    await restarted.mutateContentHold("example-job", { action: "renewed", hold_id: first.holds[0].id, reason: "still open", review_due_at: ACTIVITY + 500, actor: "second-admin", at: ACTIVITY });
    await restarted.mutateContentHold("example-job", { action: "cleared", hold_id: first.holds[0].id, reason: "resolved", actor: "second-admin", at: ACTIVITY });
    const history = (await restarted.getContentSnapshot("example-job"))!.history;
    expect(history.events.map((event) => event.action)).toEqual(["placed", "placed", "renewed", "cleared"]);
    expect(history.events[0]).toEqual(first.events[0]);
    expect(history.holds[0].actor).toBe(ADMIN_KEY);
    expect(await restarted.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: Date.now() })).toBe(false);
    await restarted.save({ ...contentJob(), lastActivityAt: Date.now() });
    await restarted.appendOutgoing("example-job", { type: "text", from: "provider", timestamp: 1, content: { text: "late" } });
    await restarted.recordInbound("example-job", { type: "text", from: "requester", timestamp: 1, content: { text: "late" } });
    expect((await restarted.get("example-job"))?.lastActivityAt).toBe(ACTIVITY);
  });

  it("refuses a stale retention scan clock before erasing terminal content", async () => {
    await store.save(contentJob());
    expect(await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY - 1, redactedAt: Date.now() })).toBe(false);
    expect((await store.get("example-job"))?.summary).toBe("raw-output-secret");
    expect(await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: Date.now() })).toBe(true);
    expect((await store.get("example-job"))?.summary).toBeNull();
  });

  it("refuses admin mutations for a job bound to another service while accepting legacy local rows", async () => {
    await store.saveForDvm(contentJob(), "other-service");
    await expect(store.mutateContentHold("example-job", place, "example-dvm")).rejects.toEqual(new ContentHoldError("job_not_found"));
    expect(await store.getContentSnapshot("example-job", "example-dvm")).toBeUndefined();
    await store.save(contentJob("legacy"));
    expect((await store.mutateContentHold("legacy", place, "example-dvm")).holds).toHaveLength(1);
  });

  it("rolls back hold placement if its append-only event cannot be committed", async () => {
    await store.save(contentJob());
    await pool.query("ALTER TABLE job_content_hold_events ADD CONSTRAINT content_test_event_reject CHECK(data->>'reason' <> 'reject-event')");
    try {
      await expect(store.mutateContentHold("example-job", { ...place, reason: "reject-event" })).rejects.toMatchObject({ code: "23514" });
      expect((await store.getContentSnapshot("example-job"))?.history).toEqual({ holds: [], events: [] });
      expect((await store.get("example-job"))?.summary).toBe("raw-output-secret");
    } finally { await pool.query("ALTER TABLE job_content_hold_events DROP CONSTRAINT content_test_event_reject"); }
  });

  it("a committed hold wins a sweep already competing for the row fence", async () => {
    await store.save(contentJob());
    const holdPool = new pg.Pool({ connectionString: DATABASE_URL, application_name: "content-hold-racer" });
    const sweepPool = new pg.Pool({ connectionString: DATABASE_URL, application_name: "content-sweep-racer" });
    const blocker = await pool.connect();
    let placing: ReturnType<PostgresJobStore["mutateContentHold"]> | undefined;
    let sweeping: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM jobs WHERE id='example-job' FOR UPDATE");
      placing = new PostgresJobStore(holdPool).mutateContentHold("example-job", place);
      await waitForLock(pool, "content-hold-racer");
      sweeping = new PostgresJobStore(sweepPool).redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: Date.now() });
      await waitForLock(pool, "content-sweep-racer");
      await blocker.query("COMMIT");
      expect((await placing).holds).toHaveLength(1);
      expect(await sweeping).toBe(false);
      expect((await store.get("example-job"))?.summary).toBe("raw-output-secret");
      expect((await store.get("example-job"))?.redactedAt).toBeUndefined();
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.allSettled([placing, sweeping]);
      await Promise.all([holdPool.end(), sweepPool.end()]);
    }
  });

  it("redaction winning first refuses a later hold while retaining signed outcome evidence", async () => {
    await store.save(contentJob());
    const issuer = new ReceiptIssuer({ secret: "22".repeat(32), dvm: "example", dvmId: "example-dvm" });
    const receipt = issuer.issue(contentJob(), await store.claimReceiptSeq("example-job"));
    await store.saveReceipt("example-job", receipt);
    expect(await store.redactJob({ jobId: "example-job", expectedLastActivityAt: ACTIVITY, redactedAt: Date.now() })).toBe(true);
    await expect(store.mutateContentHold("example-job", place)).rejects.toEqual(new ContentHoldError("content_unavailable"));
    const row = (await store.get("example-job"))!;
    expect(row).toMatchObject({ input: "", messages: [], paidMsats: 21000, status: "completed", receipt });
    expect(verifyReceipt(row.receipt!)).toBe(true);
  });

  it("atomically consumes admin nonces across replicas and accepts an expired nonce only once", async () => {
    let now = 1000;
    const first = new PostgresConsumedCredentialStore(pool, { now: () => now, gcSampleRate: 1 });
    const second = new PostgresConsumedCredentialStore(pool, { now: () => now, gcSampleRate: 0 });
    await first.init();
    const key = `nonce-${Date.now()}`;
    await second.mark("content-test", `${key}-expired`, 0);
    now = 1001;
    expect(await first.consume("content-test", `${key}-gc`, 1)).toBe(true);
    await expect.poll(async () => (await pool.query("SELECT 1 FROM consumed_credentials WHERE realm='content-test' AND challenge_id=$1", [`${key}-expired`])).rowCount).toBe(0);
    expect((await Promise.all([first.consume("content-test", key, 1), second.consume("content-test", key, 1)])).sort()).toEqual([false, true]);
    now = 2001;
    expect((await Promise.all([first.consume("content-test", key, 1), second.consume("content-test", key, 1)])).sort()).toEqual([false, true]);
  });

  it("fences cached and cross-replica SSE after a real committed sweep", async () => {
    const descriptor = configureDVM({ name: "example", capability: "work", jobRetentionDays: 1, onJob(ctx) { ctx.complete("private replica output"); } });
    const first = await createDVMServer(descriptor, { env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true });
    const second = await createDVMServer(descriptor, { env: {}, store: new MemoryKVStore(), jobStore: new PostgresJobStore(pool), devMode: true });
    const now = Date.now;
    try {
      const body = await (await first.app.request("/v1/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "work", input: "private replica input" }) })).json();
      const path = `/v1/job/${body.job_id}/messages`;
      const headers = { "X-Job-Token": body.job_token, Accept: "text/event-stream" };
      expect(first.jobManager.activeJobs.has(body.job_id)).toBe(true);
      expect(second.jobManager.activeJobs.has(body.job_id)).toBe(false);
      for (const runtime of [first, second]) expect(await (await runtime.app.request(path, { headers })).text()).toContain("private replica output");
      Date.now = () => now() + 2 * 86400000;
      expect((await first.jobManager.sweepJobRetention()).redacted).toBe(1);
      expect((await store.get(body.job_id))?.redactedAt).toBeDefined();
      for (const runtime of [first, second]) expect(await (await runtime.app.request(path, { headers })).text()).toBe("");
    } finally { Date.now = now; first.jobManager.shutdown(); second.jobManager.shutdown(); }
  });

  it("preserves deposit basis, repriced allocations and refund costs while excluding nested unsigned secrets", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path=pg_temp;
        CREATE TEMP TABLE credit_funding_lots(lot_id text, credit_id text, rail text, sats_funded bigint, credited_micro bigint, remaining_micro bigint, funding_ref text, created_at bigint);
        INSERT INTO credit_funding_lots VALUES('lot','credit','lightning',2000,1000000,0,'paid-hash',1);
        CREATE TEMP TABLE credit_draws(credit_id text, draw_id text, job_id text, draw_msats bigint, allocated_msats bigint, status text);
        INSERT INTO credit_draws VALUES('credit','draw','job',1000000,500000,'settled');
        CREATE TEMP TABLE credit_drains(credit_id text, drain_id text, method text, status text, owed_sats bigint, fulfilment jsonb, lot_debits jsonb, sent_ref jsonb);
        CREATE TEMP TABLE x402_exact_settlement_intents(intent_id text, effect jsonb, settle_response jsonb);
        CREATE TEMP TABLE x402_batch_channels(channel_id text, balance numeric, total_claimed numeric, signature text);
        CREATE TEMP TABLE mpp_tempo_channels(channel_key text, state_json text, updated_at bigint);
        INSERT INTO x402_batch_channels VALUES('channel',400000,100000,'unsigned-secret');`);
      await client.query("INSERT INTO mpp_tempo_channels VALUES('tempo',$1,1)", [JSON.stringify({ channelId: "tempo", deposit: "2000#__bigint", spent: "500#__bigint", settledOnChain: "400#__bigint", highestVoucherAmount: "600#__bigint", private_note: "unsigned-secret", voucher: { signature: "unsigned-secret" } })]);
      const fulfilment = { source: "jit_mint", mintUrl: "https://mint.example.com", quoteId: "quote", faceSats: 500, reserveSats: 10, invoiceMsats: 503000, routingFeeMsats: 1000, private_note: "unsigned-secret" };
      const effect = { jobId: "job", paidMsats: 21000, fundedMicro: 1000000, nativeAmount: 2000, priceFiat: { currency: "usd", amountMicro: 500000, raw_input: "unsigned-secret" }, topUp: { creditId: "credit", drawId: "draw", credential: "unsigned-secret" } };
      await client.query("INSERT INTO credit_drains VALUES('credit','drain','cashu','picked_up',500,$1,$2,$3)", [fulfilment, JSON.stringify([{ lotId: "lot", micro: 500000, sats: 1000, bearer_token: "unsigned-secret" }]), { transaction: "0xabc", settled_amount: "500000", surplus_native: "100000", repaired: true, raw_output: "unsigned-secret" }]);
      await client.query("INSERT INTO x402_exact_settlement_intents VALUES('intent',$1,$2)", [effect, { transaction: "0xdef", amount: "2000", success: true, credential: "unsigned-secret" }]);
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const run = async () => {
        const results = await client.query(recipe.slice(begin)) as unknown as pg.QueryResult[];
        return results.find((result) => result.command === "SELECT")!.rows[0].jsonb_build_object;
      };
      const exported = await run();
      expect(exported.funding_lots).toEqual([{ lot_id: "lot", credit_id: "credit", rail: "lightning", sats_funded: 2000, credited_micro: 1000000, remaining_micro: 0, funding_ref: "paid-hash", created_at: 1 }]);
      expect(exported.draws[0]).toMatchObject({ draw_msats: 1000000, allocated_msats: 500000 });
      expect(exported.drains[0].fulfilment).toEqual({ source: "jit_mint", mintUrl: "https://mint.example.com", quoteId: "quote", faceSats: 500, reserveSats: 10, invoiceMsats: 503000, routingFeeMsats: 1000 });
      expect(exported.drains[0].lot_debits).toEqual([{ lotId: "lot", micro: 500000, sats: 1000 }]);
      expect(exported.drains[0].sent_ref).toEqual({ transaction: "0xabc", settled_amount: "500000", surplus_native: "100000", repaired: true });
      expect(exported.x402_exact_settlements[0].effect).toMatchObject({ paidMsats: 21000, fundedMicro: 1000000, nativeAmount: 2000, priceFiat: { currency: "usd", amountMicro: 500000 }, topUp: { creditId: "credit", drawId: "draw" } });
      expect(exported.x402_channels).toEqual([{ channel_id: "channel", balance: 400000, total_claimed: 100000 }]);
      expect(exported.tempo_channels[0].state_json).toEqual({ channelId: "tempo", deposit: "2000", spent: "500", settledOnChain: "400", highestVoucherAmount: "600" });
      expect(JSON.stringify(exported)).not.toContain("unsigned-secret");
      // Every supported scalar position rejects both object and array payloads.
      for (const injected of [{ bearer_token: "unsigned-secret", raw_input: "unsigned-secret" }, ["unsigned-secret", { private_note: "unsigned-secret" }]]) {
        await client.query("UPDATE credit_drains SET sent_ref=$1, fulfilment=$2, lot_debits=$3", [{ transaction: injected, settled_amount: injected, repaired: injected }, { ...fulfilment, faceSats: injected, quoteId: injected }, JSON.stringify([{ lotId: injected, micro: injected, sats: 1000 }])]);
        await client.query("UPDATE x402_exact_settlement_intents SET effect=$1, settle_response=$2", [{ ...effect, paidMsats: injected, priceFiat: { currency: injected, amountMicro: injected }, topUp: injected }, { transaction: injected, amount: injected, success: injected }]);
        await client.query("UPDATE mpp_tempo_channels SET state_json=$1", [JSON.stringify({ deposit: injected, spent: injected, highestVoucherAmount: injected, voucher: { signature: "unsigned-secret" } })]);
        const safe = await run();
        expect(JSON.stringify(safe)).not.toContain("unsigned-secret");
        expect(safe.drains[0].sent_ref).toEqual({});
        expect(safe.drains[0].fulfilment).not.toHaveProperty("faceSats");
        expect(safe.x402_exact_settlements[0].settle_response).toEqual({});
      }
    } finally { await client.query("ROLLBACK; DISCARD TEMP; RESET search_path"); client.release(); }
  });

  it("exports signed financial tuples and recovery links without raw data, bearer proofs or payout secrets", async () => {
    await store.save(contentJob());
    const issuer = new ReceiptIssuer({ secret: "22".repeat(32), dvm: "example", dvmId: "example-dvm" });
    const receipt = issuer.issue(contentJob(), await store.claimReceiptSeq("example-job"));
    const funding = issuer.issueFunding({ creditId: "credit", fundId: "fund", fundedMicro: 1000000, balanceAfterMicro: 1000000, ledgerSeq: 1, callerPubkey: ADMIN_KEY });
    const drain = issuer.issueDrain({ creditId: "credit", drainId: "drain", event: "sent", method: "x402", amountMicro: 500000, balanceAfterMicro: 500000, ledgerSeq: 3, callerPubkey: ADMIN_KEY });
    await store.saveReceipt("example-job", receipt);
    await pool.query("INSERT INTO credits(credit_id,caller_pubkey,currency,balance_micro,expiry_ms,status,created_at) VALUES('credit',$1,'usd',500000,$2,'active',$2)", [ADMIN_KEY, ACTIVITY]);
    await pool.query("INSERT INTO credit_fundings(credit_id,fund_id,amount_micro,created_at,receipt) VALUES('credit','fund',1000000,$1,$2)", [ACTIVITY, JSON.stringify(funding)]);
    await pool.query("INSERT INTO credit_draws(credit_id,draw_id,job_id,amount_micro,ledger_seq,status,balance_after_micro,created_at) VALUES('credit','draw','example-job',500000,2,'released',1000000,$1)", [ACTIVITY]);
    await pool.query("INSERT INTO credit_drains(credit_id,drain_id,method,payout,amount_micro,balance_after_micro,ledger_seq,status,token,sent_ref,receipts,created_at) VALUES('credit','drain','x402',$1,500000,500000,3,'sent','bearer-token-secret',$2,$3,$4)", [JSON.stringify({ key: "payout-secret" }), JSON.stringify({ transaction: "transaction", credential: "operational-secret" }), JSON.stringify([drain]), ACTIVITY]);
    await pool.query("INSERT INTO credit_invoices(credit_id,fund_id,caller_pubkey,currency,amount_micro,amount_msats,payment_hash,bolt11,status,expires_at,created_at,reconciled_credit_id,reconciled_fund_id,resolved_at,write_off_note) VALUES('credit','blocked',$1,'usd',1000000,21000,'hash','invoice-secret','resolved',$2,$2,'credit','fund',$2,'private-note-secret')", [ADMIN_KEY, ACTIVITY]);
    const client = await pool.connect();
    try {
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      // psql sends these commands separately, before the snapshot transaction.
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as pg.QueryResult[];
      const exported = results.find((result) => result.command === "SELECT")!.rows[0].jsonb_build_object;
      expect(exported).toMatchObject({ format: "dvmkit-financial-evidence", version: 1, jobs: [{ id: "example-job", status: "completed", paid_msats: 21000 }], credits: [{ currency: "usd", balance_micro: 500000 }], draws: [{ job_id: "example-job", status: "released" }], invoices: [{ reconciled_credit_id: "credit", reconciled_fund_id: "fund", status: "resolved" }] });
      expect(exported.drains[0].sent_ref).toEqual({ transaction: "transaction" });
      expect(exported.jobs[0].receipt).toEqual(receipt);
      expect(verifyReceipt(exported.jobs[0].receipt as JobReceipt)).toBe(true);
      expect(verifyFundingReceipt(exported.fundings[0].receipt as FundingReceipt)).toBe(true);
      expect(verifyDrainReceipt(exported.drains[0].receipts[0] as DrainReceipt)).toBe(true);
      for (const secret of ["raw-input-secret", "raw-param-secret", "raw-output-secret", "bearer-proof-secret", "bearer-token-secret", "payout-secret", "operational-secret", "invoice-secret", "private-note-secret", "extension-secret"]) expect(JSON.stringify(exported)).not.toContain(secret);
      for (const unsupported of [
        { ...receipt, v: 2 },
        { ...receipt, kind: "future_kind" },
        { ...receipt, raw_input: "extension-secret" },
        { ...receipt, paid: { ...receipt.paid, raw_input: "extension-secret" } },
        { ...receipt, credit: { credit_id: "credit", draw_id: "draw", amount: 1, balance_after: 0, ledger_seq: 1, token: "extension-secret" } },
      ]) {
        await pool.query("UPDATE jobs SET receipt=$1 WHERE id='example-job'", [unsupported]);
        await expect(client.query(recipe.slice(begin))).rejects.toThrow(/financial export v1: unsupported/);
        await client.query("ROLLBACK");
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
