import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { signReceipt } from "../../../lib/receipt";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import type { CreditDrawRefundArgs } from "../credit-draw-refund";
import { CreditLedger } from "../credit-ledger";
import { toLockPubkey } from "../lock-pubkey-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { RevenueReporter } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const schema = `sdk_draw_refund_${randomUUID().replaceAll("-", "")}`;
const callerPubkey = "ab".repeat(32);
const refundPubkey = `02${"cd".repeat(32)}`;
const nowMs = 1_800_000_001_000;
const expiryMs = nowMs + 86_400_000;
const secret = Buffer.from("11".repeat(32), "hex");
const lock = toLockPubkey(`02${Buffer.from(schnorr.getPublicKey(secret)).toString("hex")}`);
const path = "/admin/credit/refund-draw";
const recipe = readFileSync(new URL("../../../../recipes/postgres/financial-export-v1.sql", import.meta.url), "utf8");
const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/credit-draw-refund.json", import.meta.url), "utf8"));

function auth(dvmId = "dvm-refund-example"): string {
  const nonceHex = randomUUID().replaceAll("-", "");
  const unixSeconds = nowMs / 1000;
  const challenge = buildAdminChallenge({ method: "POST", path, dvmId, nonceHex, unixSeconds });
  return `P2PK ${nonceHex}.${unixSeconds}.${Buffer.from(schnorr.sign(challenge, secret)).toString("hex")}`;
}

describe.skipIf(!RUN)("completed credit draw refunds", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  let reporter: RevenueReporter;
  let outbox: CreditDrawRefundArgs["outbox"];

  beforeAll(async () => {
    await recreateSchema(schema);
    pool = await pinnedPool(schema);
    ledger = new CreditLedger(pool);
    await ledger.init();
    await pool.query("CREATE TABLE jobs (id TEXT PRIMARY KEY, dvm_id TEXT, receipt JSONB)");
    reporter = new RevenueReporter(pool, "https://platform.example.com", "example-token");
    await reporter.init();
    outbox = { dvmId: "dvm-refund-example", enqueue: reporter.enqueueCreditDrawRefund.bind(reporter) };
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE reported_job_terminals, jobs, credit_draw_refunds, credit_draws, credit_drains, credit_funding_lots, credit_fundings, credits, pending_dvm_reports");
  });

  afterAll(async () => {
    reporter?.stop();
    await pool?.end();
    await dropSchemas(schema);
  });

  async function fund(creditId = "c", micro = 1_000, sats = 100, at = nowMs - 1_000): Promise<void> {
    await ledger.fund({ creditId, callerPubkey, currency: "usd", amountMicro: micro, expiryMs,
      basis: { rail: "cashu", paidMsats: sats * 1_000 }, nowMs: at });
  }

  async function completed(creditId = "c", drawId = "d", micro = 1_000, jobId = "j"): Promise<void> {
    await ledger.draw({ creditId, drawId, amountMicro: micro, jobId, nowMs });
    await ledger.settle({ creditId, drawId, nowMs });
    await pool.query("INSERT INTO reported_job_terminals(dvm_id, job_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [outbox.dvmId, jobId, nowMs]);
  }

  function refund(refundId: string, amountMicro?: number, creditId = "c", drawId = "d") {
    return ledger.refundDraw({ creditId, drawId, refundId, ...(amountMicro === undefined ? {} : { amountMicro }), outbox, nowMs });
  }

  function app(options: { reporting?: boolean; persistent?: boolean; dvmId?: string; receiptSecret?: string } = {}): Hono {
    const app = new Hono();
    installAdminCreditRoutes(app, {
      db: pool, dvmId: options.dvmId ?? outbox.dvmId, ledger: options.persistent === false ? new MemoryCreditLedger() : ledger,
      getLockPubkeyState: () => Promise.resolve({ current: lock, retired: [] }),
      nonceStore: new MemoryConsumedCredentialStore(), accumulatorWired: false, receiptIssuer: options.receiptSecret ? new ReceiptIssuer({ secret: options.receiptSecret, dvmId: options.dvmId ?? outbox.dvmId, dvm: "example" }) : undefined,
      fxFetcher: { fetch: () => { throw new Error("Refunds must never fetch current FX"); }, supportedCurrencies: () => ["usd"] },
      creditTtlMs: () => 86_400_000, creditCurrency: () => "usd", now: () => nowMs,
      ...(options.reporting === false ? {} : { enqueueCreditDrawRefund: outbox.enqueue }),
    });
    return app;
  }

  async function post(app: Hono, body: unknown, signed = true, dvmId?: string): Promise<Response> {
    return app.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(signed ? { Authorization: auth(dvmId) } : {}) }, body: JSON.stringify(body) });
  }

  it("authenticates before parsing or accounting and fails closed without persistent reporting", async () => {
    await fund(); await completed();
    expect((await post(app(), null, false)).status).toBe(401);
    expect((await post(app(), { jobId: "j", refundId: "r", amountMicro: 0 })).status).toBe(400);
    for (const configured of [{ reporting: false }, { persistent: false }]) {
      const response = await post(app(configured), { jobId: "j", refundId: "r" });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "credit_refund_unavailable", hint: expect.any(String) });
    }
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
    expect((await pool.query("SELECT * FROM credit_draw_refunds")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toEqual([]);
  });

  it("returns the wire fixture and queues that exact report in the accounting transaction", async () => {
    await fund("credit-refund-example");
    await completed("credit-refund-example", "draw-refund-example", 1_000, "job-refund-example");
    const response = await post(app(), fixture.request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fixture.response);
    const { rows } = await pool.query("SELECT kind, payload FROM pending_dvm_reports");
    expect(rows).toEqual([{ kind: "refund", payload: fixture.report }]);
    const remainder = await ledger.refundDraw({ jobId: "job-refund-example", refundId: "remainder", outbox, nowMs });
    expect(remainder).toMatchObject({ amountMicro: 600, balanceAfterMicro: 1_000, ledgerSeq: 3 });
    // A fresh store must return the original facts after spending, expiry, and later refunds.
    await ledger.draw({ creditId: "credit-refund-example", drawId: "later", amountMicro: 900, nowMs });
    const replay = await new CreditLedger(pool).refundDraw({ ...fixture.request, outbox, nowMs: expiryMs + 1 });
    expect(replay).toEqual({ refundId: "refund-example", creditId: "credit-refund-example", drawId: "draw-refund-example",
      jobId: "job-refund-example", amountMicro: 400, currency: "usd", ledgerSeq: 2, refundedAt: nowMs,
      balanceAfterMicro: 400, replayed: true });
    expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toHaveLength(2);
    for (const patch of [{ amountMicro: 401 }, { reason: "Different reason" }, { jobId: "another-job" }]) {
      await expect(ledger.refundDraw({ ...fixture.request, ...patch, outbox, nowMs })).rejects.toMatchObject({ code: "refund_conflict" });
    }
  });

  it("keeps omitted remainder intent stable and rejects explicit-amount reuse", async () => {
    await fund(); await completed();
    const first = await refund("r");
    await expect(refund("r", 1_000)).rejects.toMatchObject({ code: "refund_conflict" });
    expect(await refund("r")).toEqual({ ...first, replayed: true });
    await expect(refund("another")).rejects.toMatchObject({ code: "refund_exceeds_draw" });
  });

  it("binds both selectors and persisted replays to the authenticated DVM on a shared ledger", async () => {
    await fund(); await completed();
    const foreign = { ...outbox, dvmId: "another-dvm" };
    for (const selector of [{ jobId: "j" }, { creditId: "c", drawId: "d" }]) {
      await expect(ledger.refundDraw({ ...selector, refundId: "foreign", outbox: foreign, nowMs })).rejects.toMatchObject({ code: "draw_not_found" });
      const response = await post(app({ dvmId: foreign.dvmId }), { ...selector, refundId: "foreign-route" }, true, foreign.dvmId);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "draw_not_found" });
    }
    const original = await refund("owned", 100);
    await expect(ledger.refundDraw({ creditId: "c", drawId: "d", refundId: "owned", amountMicro: 100,
      outbox: foreign, nowMs })).rejects.toMatchObject({ code: "refund_conflict" });
    await pool.query("DELETE FROM jobs; DELETE FROM reported_job_terminals");
    expect(await refund("owned", 100)).toEqual({ ...original, replayed: true });
    expect(await refund("after-retention", 100)).toMatchObject({ amountMicro: 100 });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(200);
  });

  it("requires immutable owner evidence for legacy NULL jobs and rejects conflicting evidence", async () => {
    await fund(); await completed();
    await pool.query("INSERT INTO jobs(id, dvm_id) VALUES ('j', NULL)");
    expect(await refund("terminal-proof", 100)).toMatchObject({ amountMicro: 100 });
    await pool.query("UPDATE credit_draws SET refund_dvm_id = NULL");
    await pool.query("DELETE FROM reported_job_terminals");
    await expect(refund("no-proof", 100)).rejects.toMatchObject({ code: "draw_not_found" });
    await pool.query("UPDATE jobs SET dvm_id = $1 WHERE id = 'j'", [outbox.dvmId]);
    await pool.query("INSERT INTO reported_job_terminals VALUES ('another-dvm', 'j', $1)", [nowMs]);
    await expect(refund("conflicting-proof", 100)).rejects.toMatchObject({ code: "draw_not_found" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(100);
  });

  it("uses only the configured receipt key as legacy ownership proof and refuses a re-signed foreign-key spoof", async () => {
    await fund(); await completed();
    await pool.query("DELETE FROM reported_job_terminals");
    const makeReceipt = (signingSecret: Uint8Array) => signReceipt({ v: 1, job_id: "j", dvm_id: outbox.dvmId,
      dvm: "example", capability: "test", outcome: "completed", reason: null, seq: 1, issued_at: nowMs / 1000,
      requester_pubkey: callerPubkey, paid: { msats: 100_000, rail: "cashu", native_amount: null, native_asset: null, tx_hash: null, mint: null }, result_hash: null,
      receipt_pubkey: Buffer.from(schnorr.getPublicKey(signingSecret)).toString("hex") }, Buffer.from(signingSecret).toString("hex"));
    const receipt = makeReceipt(secret);
    const trustedReceiptPubkey = receipt.receipt_pubkey;
    await pool.query("INSERT INTO jobs VALUES ('j', NULL, $1)", [JSON.stringify(receipt)]);
    const args = { jobId: "j", outbox, nowMs, trustedReceiptPubkey, amountMicro: 100 };
    expect(await ledger.refundDraw({ ...args, refundId: "receipt-proof" })).toMatchObject({ amountMicro: 100 });
    const rotated = await post(app({ receiptSecret: "22".repeat(32) }), { jobId: "j", refundId: "receipt-proof", amountMicro: 100 });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toMatchObject({ amount_micro: 100, balance_after_micro: 100, replayed: true });
    const afterRotation = await post(app({ receiptSecret: "22".repeat(32) }), { jobId: "j", refundId: "after-key-rotation", amountMicro: 100 });
    expect(afterRotation.status).toBe(200);
    expect(await afterRotation.json()).toMatchObject({ amount_micro: 100, balance_after_micro: 200, replayed: false });
    await pool.query("UPDATE credit_draws SET refund_dvm_id = NULL");
    await pool.query("UPDATE jobs SET receipt = receipt || $1::jsonb", [JSON.stringify({ dvm_id: "another-dvm" })]);
    await expect(ledger.refundDraw({ ...args, refundId: "edited-receipt" })).rejects.toMatchObject({ code: "draw_not_found" });
    const spoof = makeReceipt(Buffer.from("22".repeat(32), "hex"));
    await pool.query("UPDATE jobs SET receipt = $1::jsonb", [JSON.stringify(spoof)]);
    await expect(ledger.refundDraw({ ...args, refundId: "re-signed-spoof" })).rejects.toMatchObject({ code: "draw_not_found" });
    const response = await post(app({ receiptSecret: secret.toString("hex") }), {
      jobId: "j", refundId: "spoof-via-route", trustedReceiptPubkey: spoof.receipt_pubkey,
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "draw_not_found", hint: expect.stringContaining("ownership") });
    await pool.query("UPDATE jobs SET receipt = $1::jsonb", [JSON.stringify(receipt)]);
    await expect(refund("no-configured-key", 100)).rejects.toMatchObject({ code: "draw_not_found" });
    const accepted = await post(app({ receiptSecret: secret.toString("hex") }), { jobId: "j", refundId: "trusted-via-route", amountMicro: 100 });
    expect(accepted.status).toBe(200);
  });

  it("serializes distinct partial refunds across stores and bounds the cumulative total", async () => {
    await fund(); await completed();
    const other = new CreditLedger(pool);
    const results = await Promise.allSettled([
      refund("one", 600), other.refundDraw({ jobId: "j", refundId: "two", amountMicro: 600, outbox, nowMs }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "refund_exceeds_draw" } }]);
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(600);
    expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toHaveLength(1);
    await refund("rest");
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(1_000);
  });

  it("serializes same-ID replays and conflicts even across different credit selectors", async () => {
    await fund(); await completed();
    const first = await Promise.all([refund("same", 300), refund("same", 300)]);
    expect(first.map(value => value.replayed).sort()).toEqual([false, true]);
    await fund("other"); await completed("other", "d", 1_000, "other-job");
    const results = await Promise.allSettled([refund("cross", 100), refund("cross", 100, "other")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "refund_conflict" } }]);
    expect((await pool.query("SELECT * FROM credit_draw_refunds")).rows).toHaveLength(2);
  });

  it("rolls back balance, sequence, lots, history, and an inserted outbox row together", async () => {
    await fund(); await completed();
    const before = (await pool.query("SELECT * FROM credits")).rows;
    const lots = (await pool.query("SELECT * FROM credit_funding_lots")).rows;
    await expect(ledger.refundDraw({ jobId: "j", refundId: "rollback", outbox: { dvmId: outbox.dvmId,
      enqueue: async (tx, payload) => { await outbox.enqueue(tx, payload); throw new Error("outbox unavailable"); } }, nowMs })).rejects.toThrow("outbox unavailable");
    expect((await pool.query("SELECT * FROM credits")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM credit_funding_lots")).rows).toEqual(lots);
    expect((await pool.query("SELECT * FROM credit_draw_refunds")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toEqual([]);
    expect(await refund("rollback")).toMatchObject({ amountMicro: 1_000, replayed: false });
  });

  it("restores aggregate original sats across changed-rate lots and partial refunds through a drain", async () => {
    await fund("c", 600, 100, nowMs - 2_000);
    await fund("c", 400, 40);
    await completed("c", "d", 800);
    expect((await ledger.getDraw({ creditId: "c", drawId: "d" }))?.railValue.drawMsats).toBe(120_000);
    await refund("partial", 200);
    await refund("remaining");
    const { drain } = await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey,
      method: "cashu", payout: { refund_pubkey: refundPubkey }, nowMs });
    expect(drain).toMatchObject({ amountMicro: 1_000, owedSats: 132 });
    expect((await pool.query("SELECT drained_msats FROM credit_drains WHERE drain_id = 'drain'")).rows[0].drained_msats).toBe("140000");
  });

  it("restores the original lot value when a hold forecast made settlement floor the pooled remainder", async () => {
    await fund("c", 1_000, 10, nowMs - 2_000);
    await fund("c", 1_000, 100, nowMs - 1_000);
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "j", amountMicro: 1_000, nowMs });
    const first = await ledger.requestDrain({ creditId: "c", drainId: "first", callerPubkey, method: "cashu", payout: {}, nowMs });
    expect(first.drain).toMatchObject({ amountMicro: 1_000, owedSats: 2 });
    await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    await pool.query("INSERT INTO reported_job_terminals VALUES ($1, 'j', $2)", [outbox.dvmId, nowMs]);
    const settled = await pool.query(`SELECT c.msats_remaining, d.draw_msats, d.allocated_msats
      FROM credits c JOIN credit_draws d USING (credit_id) WHERE c.credit_id = 'c'`);
    expect(settled.rows).toEqual([{ msats_remaining: "0", draw_msats: "100000", allocated_msats: "55000" }]);
    await refund("original-value");
    expect((await pool.query("SELECT msats_remaining FROM credits WHERE credit_id = 'c'")).rows[0].msats_remaining).toBe("100000");
    expect((await ledger.bitcoinDepositLiability()).depositSats).toBe(100);
    const restored = await ledger.requestDrain({ creditId: "c", drainId: "restored", callerPubkey, method: "cashu", payout: {}, nowMs });
    expect(restored.drain).toMatchObject({ amountMicro: 1_000, owedSats: 92 });
    // The two exact obligations plus their eight-sat delivery reserves account for all
    // 110 deposited sats; the earlier 55-sat pooled hold was only a forecast.
    expect(first.drain.owedSats! + 8 + restored.drain.owedSats! + 8).toBe(110);
  });

  it("keeps known-zero rounding eligible without FX fallback in drains and deposit liability", async () => {
    await fund("c", 100, 1); await completed("c", "d", 100);
    await refund("zero", 1);
    expect(await ledger.listFundingLots("c")).toMatchObject([{ satsFunded: 0, satsBasisKnown: true, remainingMicro: 1 }]);
    expect(await ledger.bitcoinDepositLiability()).toMatchObject({ depositSats: 0, uncoveredCredits: 0, unbackedCredits: 0 });
    await expect(ledger.requestDrain({ creditId: "c", drainId: "dust", callerPubkey, method: "cashu", payout: {}, nowMs })).rejects.toMatchObject({ code: "drain_below_dust" });
    // Consuming a known-zero refund lot must produce another proven-zero completed draw.
    await completed("c", "zero-draw", 1, "zero-job");
    await refund("zero-again", undefined, "c", "zero-draw");
    await refund("remaining");
    expect((await pool.query("SELECT SUM(sats_funded) AS sats FROM credit_funding_lots WHERE remaining_micro > 0")).rows[0].sats).toBe("1");
    expect((await ledger.bitcoinDepositLiability()).unbackedCredits).toBe(0);
  });

  it("keeps actual settlement basis but refuses historical markers, forecasts, default zeros, and missing or basisless lots", async () => {
    await fund("historical", 600, 100, nowMs - 2_000); await fund("historical", 400, 40);
    await completed("historical", "d", 800, "historical-job");
    expect(await refund("proven", 100, "historical")).toMatchObject({ amountMicro: 100 });
    await pool.query("UPDATE credit_draws SET settled_sats = NULL WHERE credit_id = 'historical'");
    const before = (await pool.query("SELECT balance_micro, msats_remaining, last_ledger_seq FROM credits WHERE credit_id = 'historical'")).rows;
    const response = await post(app(), { jobId: "historical-job", refundId: "marker-only", settledSats: 120 });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual(fixture.refusals.basis.response);
    await expect(refund("marker-only-selector", undefined, "historical")).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
    expect((await pool.query("SELECT balance_micro, msats_remaining, last_ledger_seq FROM credits WHERE credit_id = 'historical'")).rows).toEqual(before);
    expect((await pool.query("SELECT refund_id FROM credit_draw_refunds")).rows).toEqual([{ refund_id: "proven" }]);
    expect((await pool.query("SELECT kind FROM pending_dvm_reports")).rows).toEqual([{ kind: "refund" }]);
    for (const [id, kind] of [["forecast", "forecast"], ["zero", "zero"], ["missing", "missing"], ["basisless", "basisless"]]) {
      await fund(id, 1_000, kind === "basisless" ? 0 : 100);
      if (kind === "missing") await pool.query("DELETE FROM credit_funding_lots WHERE credit_id = $1", [id]);
      await completed(id, "d", 500, `${id}-job`);
      if (kind === "forecast" || kind === "zero") await pool.query("UPDATE credit_draws SET settled_sats = NULL, allocated_msats = NULL, draw_msats = $2 WHERE credit_id = $1", [id, kind === "zero" ? 0 : 50_000]);
      await expect(refund(`refund-${id}`, undefined, id)).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
      expect((await ledger.get(id, { nowMs }))?.balanceMicro).toBe(500);
    }
  });

  it("upgrades historical tables without inventing basis and prices only an actual post-upgrade settlement", async () => {
    await fund(); await completed("c", "d", 500);
    await fund("old-pending");
    await ledger.draw({ creditId: "old-pending", drawId: "d", jobId: "pending-job", amountMicro: 500, nowMs });
    await pool.query("ALTER TABLE credit_draws DROP COLUMN settled_sats");
    await pool.query("ALTER TABLE credit_funding_lots DROP COLUMN sats_basis_known");
    await ledger.init(); await ledger.init();
    // Replaying a completed settlement after upgrade must not manufacture old asset proof.
    await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    await expect(refund("unknown-migrated")).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
    await ledger.settle({ creditId: "old-pending", drawId: "d", nowMs });
    await pool.query("INSERT INTO reported_job_terminals VALUES ($1, 'pending-job', $2)", [outbox.dvmId, nowMs]);
    expect(await refund("actually-settled", undefined, "old-pending")).toMatchObject({ amountMicro: 500 });
    await pool.query("UPDATE credits SET rail = NULL WHERE credit_id = 'c'");
    await expect(refund("unknown-rail")).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(500);
  });

  it("restores one-payment stablecoin native value cumulatively without treating it as channel credit", async () => {
    await ledger.fund({ creditId: "exact", callerPubkey, currency: "usd", amountMicro: 1_000, expiryMs,
      basis: { rail: "x402", paidMsats: 23_000, nativeAmount: 2_001, nativeAsset: "usdc" }, nowMs });
    await completed("exact", "d", 1_000, "exact-job");
    await refund("partial-exact", 333, "exact");
    await refund("rest-exact", undefined, "exact");
    expect((await ledger.get("exact", { nowMs }))?.nativeAvailable).toBe(2_001);
    expect((await pool.query("SELECT msats_remaining FROM credits WHERE credit_id = 'exact'")).rows[0].msats_remaining).toBe("23000");
  });

  it("preserves integer asset allocation beyond floating-point product precision", async () => {
    await fund("c", 1_000_001, 9_000_000_000_000);
    await completed("c", "d", 1_000_001);
    await refund("large-partial", 500_000);
    expect(await ledger.listFundingLots("c")).toMatchObject([{ satsFunded: 4_499_995_500_004 }]);
    await refund("large-rest");
    expect((await ledger.bitcoinDepositLiability()).depositSats).toBe(9_000_000_000_000);
  });

  it("returns relayable hints for every eligibility refusal and changed-argument reuse", async () => {
    const check = async (body: unknown, code: string, status = 422) => {
      const response = await post(app(), body);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: code, hint: expect.any(String) });
    };
    await check({ jobId: "missing", refundId: "missing" }, "draw_not_found", 404);
    await fund();
    await pool.query("INSERT INTO jobs(id, dvm_id) VALUES ('j', $1)", [outbox.dvmId]);
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "j", amountMicro: 500, nowMs });
    await check({ jobId: "j", refundId: "pending" }, "draw_not_completed");
    await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    await check({ jobId: "j", refundId: "excess", amountMicro: 501 }, "refund_exceeds_draw");
    await refund("recorded", 100);
    await check({ jobId: "j", refundId: "recorded", amountMicro: 101 }, "refund_conflict", 409);
    await pool.query("UPDATE credits SET expiry_ms = $1 WHERE credit_id = 'c'", [nowMs]);
    await check({ jobId: "j", refundId: "expired" }, "credit_not_open");
    await pool.query("UPDATE credits SET expiry_ms = $1, tempo_channel_id = 'example-channel' WHERE credit_id = 'c'", [expiryMs]);
    await check({ jobId: "j", refundId: "channel" }, "credit_refund_channel_unsupported");
    await pool.query("UPDATE credits SET tempo_channel_id = NULL WHERE credit_id = 'c'");
    await pool.query("UPDATE credit_draws SET settled_sats = NULL, allocated_msats = NULL WHERE credit_id = 'c'");
    await check({ jobId: "j", refundId: "basis" }, "credit_refund_basis_unavailable");
  });

  it("binds job and draw ownership, refuses ambiguous jobs, and requires a completed draw", async () => {
    await expect(refund("missing")).rejects.toMatchObject({ code: "draw_not_found" });
    await fund();
    await pool.query("INSERT INTO jobs(id, dvm_id) VALUES ('j', $1)", [outbox.dvmId]);
    await ledger.draw({ creditId: "c", drawId: "d", amountMicro: 100, jobId: "j", nowMs });
    await expect(refund("pending")).rejects.toMatchObject({ code: "draw_not_completed" });
    await ledger.release({ creditId: "c", drawId: "d", nowMs });
    await expect(refund("released")).rejects.toMatchObject({ code: "draw_not_completed" });
    await completed("c", "completed", 100);
    await expect(ledger.refundDraw({ jobId: "j", refundId: "ambiguous", outbox, nowMs })).rejects.toMatchObject({ code: "draw_not_found" });
    await expect(refund("foreign", 10, "other", "completed")).rejects.toMatchObject({ code: "draw_not_found" });
    await expect(refund("large", 101, "c", "completed")).rejects.toMatchObject({ code: "refund_exceeds_draw" });
  });

  it("refuses expired, retired, and drained credits but admits one reopened and fully spent again", async () => {
    await fund(); await completed("c", "d", 500);
    await expect(ledger.refundDraw({ jobId: "j", refundId: "expired", outbox, nowMs: expiryMs })).rejects.toMatchObject({ code: "credit_not_open" });
    await pool.query("UPDATE credits SET status = 'unbacked' WHERE credit_id = 'c'");
    await expect(refund("retired")).rejects.toMatchObject({ code: "credit_not_open" });
    await pool.query("UPDATE credits SET status = 'active' WHERE credit_id = 'c'");
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await expect(refund("drained")).rejects.toMatchObject({ code: "credit_not_open" });
    await fund("c", 500, 50, nowMs + 1);
    await completed("c", "reopened", 500, "reopened-job");
    await pool.query("UPDATE credits SET last_funding_ledger_seq = NULL WHERE credit_id = 'c'");
    expect(await refund("reopened-refund", undefined, "c", "reopened")).toMatchObject({ amountMicro: 500, balanceAfterMicro: 500 });
  });

  it("does not treat a zero-amount draw as reopening a fully drained credit", async () => {
    await fund(); await completed("c", "d", 500);
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await ledger.draw({ creditId: "c", drawId: "free", jobId: "free-job", amountMicro: 0, nowMs });
    await expect(refund("closed-after-free")).rejects.toMatchObject({ code: "credit_not_open" });
  });

  it("refunds a completed pre-drain hold grown by a later top-up", async () => {
    await fund();
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "j", amountMicro: 500, nowMs });
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await fund("c", 500, 50, nowMs);
    await ledger.growDraw({ creditId: "c", drawId: "d", addAmountMicro: 500, nowMs });
    await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    await pool.query("INSERT INTO reported_job_terminals VALUES ($1, 'j', $2)", [outbox.dvmId, nowMs]);
    await pool.query("UPDATE credits SET last_funding_ledger_seq = NULL WHERE credit_id = 'c'");
    expect(await refund("grown")).toMatchObject({ amountMicro: 1_000, balanceAfterMicro: 1_000 });
  });

  it.each([true, false])("uses committed funding/drain order for a zero hold grown later (reopened=%s)", async reopened => {
    await fund("c", 500, 50, nowMs);
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "j", amountMicro: 0, nowMs });
    const grow = async () => {
      await ledger.growDraw({ creditId: "c", drawId: "d", addAmountMicro: 500, nowMs });
      await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    };
    if (!reopened) await grow();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (reopened) {
        await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, tx: client, nowMs });
        const funding = fund("c", 500, 50, nowMs);
        await client.query("COMMIT");
        await funding;
      } else {
        await ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro: 500, expiryMs,
          basis: { rail: "cashu", paidMsats: 50_000 }, tx: client, nowMs });
        const drain = ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
        await client.query("COMMIT");
        await drain;
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
    if (reopened) await grow();
    await pool.query("INSERT INTO reported_job_terminals VALUES ($1, 'j', $2)", [outbox.dvmId, nowMs]);
    if (reopened) expect(await refund("ordered")).toMatchObject({ amountMicro: 500 });
    else await expect(refund("ordered")).rejects.toMatchObject({ code: "credit_not_open" });
  });

  it.each([true, false])("refuses indistinguishable historical reopening order before effects (actually reopened=%s)", async reopened => {
    const funding = () => ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro: 500, expiryMs,
      basis: { rail: "x402", paidMsats: 0, nativeAmount: 500, nativeAsset: "usdc" }, nowMs });
    const grow = async () => {
      await ledger.growDraw({ creditId: "c", drawId: "d", addAmountMicro: 500, nowMs });
      await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    };
    await funding();
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "j", amountMicro: 0, nowMs });
    if (!reopened) await grow();
    if (!reopened) await funding();
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "x402", payout: {}, nowMs });
    if (reopened) { await funding(); await grow(); }
    await pool.query("INSERT INTO reported_job_terminals VALUES ($1, 'j', $2)", [outbox.dvmId, nowMs]);
    // The watermark did not exist in old ledgers. Neither equal timestamps nor the
    // current process version can recover these opposite funding/growth orders.
    await pool.query("UPDATE credits SET last_funding_ledger_seq = NULL WHERE credit_id = 'c'");
    const before = (await pool.query("SELECT balance_micro, msats_remaining, native_remaining, last_ledger_seq FROM credits")).rows;
    for (const selector of [{ jobId: "j" }, { creditId: "c", drawId: "d" }]) {
      const response = await post(app(), { ...selector, refundId: `unknown-${Object.keys(selector)[0]}` });
      expect(response.status).toBe(fixture.refusals.state.status);
      expect(await response.json()).toEqual(fixture.refusals.state.response);
    }
    expect((await pool.query("SELECT balance_micro, msats_remaining, native_remaining, last_ledger_seq FROM credits")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM credit_draw_refunds")).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toEqual([]);
    expect((await pool.query("SELECT refund_dvm_id FROM credit_draws")).rows).toEqual([{ refund_dvm_id: null }]);
  });

  it("uses retained funding sequence evidence to prove historical reopening", async () => {
    await fund(); await completed("c", "d", 500);
    await ledger.draw({ creditId: "c", drawId: "old-hold", jobId: "held-job", amountMicro: 0, nowMs });
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const snapshot = await ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro: 500, expiryMs,
        basis: { rail: "cashu", paidMsats: 50_000 }, tx: client, nowMs });
      await ledger.recordFunding({ creditId: "c", fundId: "top-up", amountMicro: 500, rail: "cashu", tx: client, nowMs });
      await ledger.completeFunding({ creditId: "c", fundId: "top-up", callerPubkey,
        balanceAfterMicro: snapshot.balanceMicro, ledgerSeq: snapshot.lastLedgerSeq, tx: client });
      await client.query("COMMIT");
    } finally { client.release(); }
    await ledger.growDraw({ creditId: "c", drawId: "old-hold", addAmountMicro: 500, nowMs });
    await ledger.settle({ creditId: "c", drawId: "old-hold", nowMs });
    // The zero hold predates the drain, isolating retained funding evidence from
    // later-draw proof. Only the new watermark is absent in the historical fixture.
    await pool.query("UPDATE credits SET last_funding_ledger_seq = NULL");
    expect(await refund("funding-proven")).toMatchObject({ amountMicro: 500 });
  });

  it("replays original facts before new historical-state and basis refusals", async () => {
    await fund(); await completed("c", "d", 500);
    const args = { jobId: "j", refundId: "original", amountMicro: 100 };
    const first = await post(app(), args);
    const result = await first.json();
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await pool.query("UPDATE credits SET last_funding_ledger_seq = NULL");
    await pool.query("UPDATE credit_draws SET settled_sats = NULL");
    const replay = await post(app(), args);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...result, replayed: true });
    const conflict = await post(app(), { ...args, amountMicro: 101 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "refund_conflict" });
    const refused = await post(app(), { ...args, refundId: "new" });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual(fixture.refusals.state.response);
    expect((await pool.query("SELECT amount_micro FROM credit_draw_refunds")).rows).toEqual([{ amount_micro: "100" }]);
  });

  it("does not mark failed or rolled-back funding as reopening a drained credit", async () => {
    await fund(); await completed("c", "d", 500);
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await expect(ledger.fund({ creditId: "c", callerPubkey: "ef".repeat(32), currency: "usd", amountMicro: 500, expiryMs,
      basis: { rail: "cashu", paidMsats: 50_000 }, nowMs })).rejects.toMatchObject({ code: "caller_mismatch" });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro: 500, expiryMs,
        basis: { rail: "cashu", paidMsats: 50_000 }, tx: client, nowMs });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    await expect(refund("not-reopened")).rejects.toMatchObject({ code: "credit_not_open" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
  });

  it.each(["tempo", "x402"] as const)("refuses %s channel-backed credits", async rail => {
    await ledger.fund({ creditId: rail, callerPubkey, currency: "usd", amountMicro: 1_000, expiryMs,
      basis: { rail, paidMsats: 0, nativeAmount: 1_000,
        ...(rail === "tempo" ? { tempoSession: { channelId: `0x${"12".repeat(32)}`, cumulativeAmount: "1000" } } :
          { x402Channel: { channelId: `0x${"23".repeat(32)}`, maxClaimableAmount: "1000" } }) }, nowMs });
    await completed(rail, "d", 500, `${rail}-job`);
    await expect(refund(`refund-${rail}`, undefined, rail)).rejects.toMatchObject({ code: "credit_refund_channel_unsupported" });
  });

  it("exports durable refund and original-basis facts without request or reason text", async () => {
    await fund(); await completed();
    await ledger.refundDraw({ jobId: "j", refundId: "export", amountMicro: 100,
      reason: "private reason must not be exported", outbox, nowMs });
    await pool.query(`UPDATE credit_draw_refunds SET result = result ||
      '{"reason":"private reason must not be exported","jobId":{"raw":"private nested value"}}'::jsonb`);
    const client = await pool.connect();
    try {
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      const evidence = results.find(result => result.command === "SELECT")!.rows[0].jsonb_build_object;
      expect(evidence.draw_refunds).toEqual([{ refund_id: "export", credit_id: "c", draw_id: "d", amount_micro: 100,
        restored_sats: 10, result: { refundId: "export", creditId: "c", drawId: "d", amountMicro: 100,
          currency: "usd", ledgerSeq: 2, refundedAt: nowMs, balanceAfterMicro: 100 } }]);
      expect(evidence.draws[0]).toMatchObject({ settled_sats: 100 });
      expect(evidence.funding_lots).toEqual(expect.arrayContaining([expect.objectContaining({ sats_basis_known: true, sats_funded: 10 })]));
      expect(JSON.stringify(evidence)).not.toContain("private");
      expect(evidence.draw_refunds[0]).not.toHaveProperty("request");
    } finally { client.release(); }
  });

  it("keeps old financial export rows compatible when refund tables and basis columns are absent", async () => {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path = pg_temp;
        CREATE TEMP TABLE credit_funding_lots(lot_id TEXT, sats_funded BIGINT);
        INSERT INTO credit_funding_lots VALUES ('old-lot', 0);
        CREATE TEMP TABLE credit_draws(credit_id TEXT, draw_id TEXT, draw_msats BIGINT);
        INSERT INTO credit_draws VALUES ('old-credit', 'old-draw', 0)`);
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      const evidence = results.find(result => result.command === "SELECT")!.rows[0].jsonb_build_object;
      expect(evidence).toMatchObject({ version: 1, draw_refunds: [],
        funding_lots: [{ lot_id: "old-lot", sats_funded: 0 }],
        draws: [{ credit_id: "old-credit", draw_id: "old-draw", draw_msats: 0 }] });
      expect(evidence.funding_lots[0]).not.toHaveProperty("sats_basis_known");
      expect(evidence.draws[0]).not.toHaveProperty("settled_sats");
    } finally {
      await client.query("ROLLBACK");
      await client.query("DROP TABLE IF EXISTS pg_temp.credit_funding_lots, pg_temp.credit_draws");
      await client.query("RESET search_path");
      client.release();
    }
  });

  it("retries the persisted report after restart on missing revenue and retires excess as a client error", async () => {
    await fund(); await completed(); await refund("delivery", 200);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 409 })).mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const restarted = new RevenueReporter(pool, "https://platform.example.com", "example-token");
    try {
      await restarted.drainPending();
      expect((await pool.query("SELECT stale, retry_count FROM pending_dvm_reports")).rows).toEqual([{ stale: false, retry_count: 1 }]);
      await pool.query("UPDATE pending_dvm_reports SET next_retry_at = 0");
      await restarted.drainPending();
      expect(fetch).toHaveBeenLastCalledWith("https://platform.example.com/_internal/credit-draw-refund", expect.objectContaining({ method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer example-token" } }));
      expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toMatchObject({ refundId: "delivery", jobId: "j", amountMicro: 200 });
      expect((await pool.query("SELECT * FROM pending_dvm_reports")).rows).toEqual([]);
      await refund("rejected", 100);
      fetch.mockResolvedValueOnce(new Response("{}", { status: 422 }));
      await restarted.drainPending();
      expect((await pool.query("SELECT stale, stale_reason FROM pending_dvm_reports")).rows).toEqual([{ stale: true, stale_reason: "client_error:422" }]);
    } finally { restarted.stop(); fetch.mockRestore(); }
  });
});
