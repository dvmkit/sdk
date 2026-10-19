import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loggers } from "../../../observability/loggers";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { buildAdminChallenge } from "../admin-cashu";
import { createDVMServer } from "../app";
import { installAdminCreditRoutes } from "../admin-credit";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { CreditLedger, type TempoDrainDecisionArgs } from "../credit-ledger";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { initLockPubkeyTable, seedLockPubkeyState, toLockPubkey } from "../lock-pubkey-store";
import { PayoutReporter } from "../payout-reporter";
import { PostgresJobStore } from "../postgres-job-store";
import { RevenueReporter } from "../revenue-reporter";
import type { TempoDrainRail } from "../tempo-drain-leg";
import { completeTempoChannelDrain } from "../tempo-drain-leg";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import { stringifyStoreValue } from "../store-json";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const schema = `sdk_tempo_decisions_${randomUUID().replaceAll("-", "")}`;
const channelId = `0x${"3a".repeat(32)}`;
const callerPubkey = "ab".repeat(32);
const secret = new Uint8Array(32).fill(17);
const lock = toLockPubkey(`02${Buffer.from(schnorr.getPublicKey(secret)).toString("hex")}`);
const nowMs = 1_800_000_001_000;
const dvmId = "dvm-tempo-example";
const recipe = readFileSync(new URL("../../../../recipes/postgres/financial-export-v1.sql", import.meta.url), "utf8");
const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/tempo-drain-decisions.json", import.meta.url), "utf8"));
const request = { credit_id: "credit-example", drain_id: "drain-example", reason: "Full refund independently confirmed", evidence: "receipt-example" };
const args: TempoDrainDecisionArgs = { creditId: request.credit_id, drainId: request.drain_id,
  decision: "book_refunded", reason: request.reason, evidence: request.evidence, nowMs };

function auth(method: string, path: string, at = nowMs): string {
  const nonceHex = randomUUID().replaceAll("-", "");
  const unixSeconds = Math.floor(at / 1000);
  const digest = buildAdminChallenge({ method, path, dvmId, nonceHex, unixSeconds });
  return `P2PK ${nonceHex}.${unixSeconds}.${Buffer.from(schnorr.sign(digest, secret)).toString("hex")}`;
}

describe.skipIf(!RUN)("held Tempo drain decisions", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  let sessions: PostgresTempoSessionStore;
  let reporter: RevenueReporter;

  beforeAll(async () => {
    await recreateSchema(schema);
    pool = await pinnedPool(schema);
    sessions = new PostgresTempoSessionStore(pool);
    await sessions.init();
    ledger = new CreditLedger(pool, sessions);
    await ledger.init();
    reporter = new RevenueReporter(pool, "https://platform.example.com", "example-token");
    await reporter.init();
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE credit_drains, credit_draws, credit_funding_lots, credit_fundings, credits, pending_dvm_reports, mpp_tempo_channels, mpp_tempo_close_intents");
  });
  afterAll(async () => {
    reporter?.stop();
    await pool?.end();
    await dropSchemas(schema);
  });

  async function held(status: "pending" | "exit_required" = "exit_required", lifecycle: Record<string, unknown> = { finalized: true }) {
    await sessions.put(channelId, { channelId, deposit: 0n, spent: 100n, highestVoucherAmount: 1000n,
      settledOnChain: 100n, closeRequestedAt: 0n, finalized: false, ...lifecycle });
    await ledger.fund({ creditId: args.creditId, callerPubkey, currency: "usd", amountMicro: 1000,
      expiryMs: nowMs + 86_400_000, nowMs,
      basis: { rail: "tempo", nativeAmount: 1200, paidMsats: 2500, tempoSession: { channelId, cumulativeAmount: "1200" } } });
    await ledger.requestDrain({ creditId: args.creditId, drainId: args.drainId, callerPubkey,
      method: "tempo", payout: {}, nowMs });
    if (status === "exit_required") await ledger.requireTempoDrainExit(args);
  }

  function app(failReport = false, persistent = true, options: { hosted?: boolean; reporting?: boolean; rail?: TempoDrainRail } = {}): Hono {
    const app = new Hono();
    app.onError(() => new Response("failed", { status: 500 }));
    installAdminCreditRoutes(app, { db: pool, dvmId, ledger: persistent ? ledger : new MemoryCreditLedger(),
      fxFetcher: { fetch: () => { throw new Error("No FX on an exact restore"); }, supportedCurrencies: () => ["usd"] },
      getLockPubkeyState: () => Promise.resolve({ current: lock, retired: [] }),
      nonceStore: new MemoryConsumedCredentialStore(), accumulatorWired: false, receiptIssuer: undefined,
      creditTtlMs: () => 86_400_000, creditCurrency: () => "usd", now: () => nowMs,
      tempoDrainRail: () => Promise.resolve(options.rail ?? { getTempoSessionCloseIntent: () => Promise.resolve(null) }),
      requireDrainReport: options.hosted,
      ...(options.reporting === false ? {} : { enqueueCreditDrain: failReport ? async () => { throw new Error("outbox unavailable"); } : reporter.enqueueCreditDrain.bind(reporter) }),
    });
    return app;
  }
  function post(decision: "book" | "release", body: unknown = decision === "release" ? fixture.release.request : request, signed = true, target: Pick<Hono, "request"> = app(), at = nowMs) {
    const path = `/admin/credit/${decision}-tempo-drain`;
    return target.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(signed ? { Authorization: auth("POST", path, at) } : {}) }, body: JSON.stringify(body) });
  }
  async function reports() {
    return (await pool.query("SELECT kind, payload FROM pending_dvm_reports ORDER BY created_at")).rows;
  }
  const auto = () => completeTempoChannelDrain({ deps: { ledger, drainReport: { db: pool, dvmId, enqueueCreditDrain: reporter.enqueueCreditDrain.bind(reporter) } },
    creditId: args.creditId, drainId: args.drainId, channelId, reference: `0x${"b1".repeat(32)}`, refundedNative: 1200n, debitedNative: 1200 });

  it.each(["book", "release"] as const)("authenticates and validates %s before any durable decision", async decision => {
    await held();
    expect((await post(decision, null, false)).status).toBe(401);
    for (const body of [null, [], { ...request, reason: " " }, { ...request, reason: "x".repeat(2001) },
      { ...request, evidence: 4 }, { ...request, evidence: "x".repeat(4001) }, { ...request, amount_micro: 1 }, { ...request, refund_payment_proven: false }, { ...request, proven_refund_native: "0" }]) {
      expect((await post(decision, body)).status).toBe(400);
    }
    expect((await post(decision, request, true, app(false, false))).status).toBe(503);
    expect(await ledger.getDrain(args)).toMatchObject({ status: "exit_required", operatorDecision: null });
    expect(await reports()).toEqual([]);
  });

  it.each(["book", "release"] as const)("refuses absent or incompatible %s targets without changing the debit", async decision => {
    await held();
    for (const body of [{ ...request, credit_id: "absent" }, { ...request, drain_id: "absent" }]) {
      expect((await post(decision, body)).status).toBe(404);
    }
    await pool.query("UPDATE credit_drains SET method='cashu'");
    const incompatible = await post(decision);
    expect(incompatible.status).toBe(422);
    expect(await incompatible.json()).toMatchObject({ error: "drain_not_repairable" });
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
    expect((await ledger.getDrain(args))?.operatorDecision).toBeNull();
    expect(await reports()).toEqual([]);
  });

  async function submittedClose() {
    await sessions.withCloseIntent(channelId, args.drainId, async () => undefined);
    await sessions.resolveCloseForecast(channelId, args.drainId, "proceed");
    await sessions.confirmClose(channelId, args.drainId, `0x${"b1".repeat(32)}`);
  }

  it("requires a valid last-attempt settlement snapshot before close broadcast", async () => {
    await held("pending", { finalized: false, settledOnChain: 0n });
    await sessions.withCloseIntent(channelId, args.drainId, async () => undefined);
    await sessions.resolveCloseForecast(channelId, args.drainId, "proceed");
    await sessions.beginClose(channelId, args.drainId);
    expect((await sessions.getCloseRecovery(channelId))?.settledBeforeClose).toBe(0n);
    const state = await sessions.get(channelId) as Record<string, unknown>;
    await sessions.put(channelId, { ...state, settledOnChain: 200n });
    await sessions.beginClose(channelId, args.drainId);
    expect((await sessions.getCloseRecovery(channelId))?.settledBeforeClose).toBe(200n);
    for (const settledOnChain of [undefined, 0, -1n, 10n ** 78n]) {
      // Corrupt historical snapshots must not erase an already durable broadcast marker.
      await pool.query("UPDATE mpp_tempo_channels SET state_json=$2 WHERE channel_key=$1", [channelId, stringifyStoreValue({ ...state, settledOnChain })]);
      await expect(sessions.beginClose(channelId, args.drainId)).rejects.toThrow("settlement snapshot is unavailable or invalid");
      expect((await sessions.getCloseRecovery(channelId))?.settledBeforeClose).toBe(200n);
    }
  });

  it.each(["pending", "exit_required"] as const)("refuses unpaid release of a %s drain while its submitted close can still land", async status => {
    await held(status, { finalized: false });
    await submittedClose();
    const before = (await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits")).rows;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await post("release");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "tempo_drain_close_pending", message: expect.stringContaining("may still pay") });
      expect(await ledger.getDrain(args)).toMatchObject({ status, operatorDecision: null });
      expect((await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits")).rows).toEqual(before);
      expect(await reports()).toEqual([]);
      expect(warn.mock.calls).toEqual([]);
      await expect(ledger.draw({ creditId: args.creditId, drawId: "unsafe-spend", amountMicro: 500, nowMs })).rejects.toMatchObject({ code: "insufficient_credit" });
      expect((await sessions.getClose(channelId))?.reference).toBe(`0x${"b1".repeat(32)}`);
    } finally { warn.mockRestore(); }
  });

  it.each(["pending", "exit_required"] as const)("refuses a legacy-ready %s drain with no hash or broadcast snapshot", async status => {
    await held(status, { finalized: false });
    await sessions.withCloseIntent(channelId, args.drainId, async () => undefined);
    await pool.query("UPDATE mpp_tempo_close_intents SET forecast_pending=FALSE, settled_before_close=NULL, reference=NULL WHERE channel_id=$1", [channelId]);
    const before = (await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits")).rows;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await post("release");
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "tempo_drain_close_pending", message: expect.stringContaining("Reconcile its final outcome") });
      expect(await ledger.getDrain(args)).toMatchObject({ status, operatorDecision: null });
      expect((await pool.query("SELECT balance_micro, native_remaining, msats_remaining FROM credits")).rows).toEqual(before);
      expect((await pool.query("SELECT forecast_pending, settled_before_close, reference FROM mpp_tempo_close_intents WHERE channel_id=$1", [channelId])).rows)
        .toEqual([{ forecast_pending: false, settled_before_close: null, reference: null }]);
      expect(await reports()).toEqual([]);
      expect(warn.mock.calls).toEqual([]);
      expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
      await expect(ledger.draw({ creditId: args.creditId, drawId: "legacy-unsafe-spend", amountMicro: 500, nowMs })).rejects.toMatchObject({ code: "insufficient_credit" });
    } finally { warn.mockRestore(); }
  });

  it("preserves a genuine release replay even if a submitted close is recorded later", async () => {
    await held("pending", { finalized: false });
    await sessions.withCloseIntent(channelId, args.drainId, async () => undefined);
    expect((await pool.query("SELECT forecast_pending FROM mpp_tempo_close_intents WHERE channel_id=$1", [channelId])).rows)
      .toEqual([{ forecast_pending: true }]);
    expect((await sessions.getCloseRecovery(channelId))?.settledBeforeClose).toBeNull();
    const accepted = await post("release");
    expect(accepted.status).toBe(200);
    const original = await accepted.json();
    await submittedClose();
    await pool.query("UPDATE mpp_tempo_close_intents SET settled_before_close=0 WHERE channel_id=$1", [channelId]);
    expect(await (await post("release")).json()).toEqual({ ...original, replayed: true });
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(1000);
  });

  async function shortRefund(amount: bigint) {
    return completeTempoChannelDrain({ deps: { ledger, drainReport: { db: pool, dvmId, enqueueCreditDrain: reporter.enqueueCreditDrain.bind(reporter) } },
      creditId: args.creditId, drainId: args.drainId, channelId, reference: `0x${"b1".repeat(32)}`, refundedNative: amount, debitedNative: 1200 });
  }

  it("retains a proven partial refund and permits only a whole-refund attestation after the remainder is returned", async () => {
    await held();
    await expect(shortRefund(400n)).rejects.toMatchObject({ code: "drain_conflict" });
    expect(await ledger.getDrain(args)).toMatchObject({ holdReason: "refund_short", provenRefundNative: "400" });
    const response = await post("release");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "tempo_drain_refund_paid" });
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
    expect(await reports()).toEqual([]);
    expect((await post("book", { ...request, reason: "The remaining 800 native units were returned off-path" })).status).toBe(200);
    expect(await reports()).toHaveLength(1);
  });

  it("distinguishes proven zero from unknown historical short-refund evidence", async () => {
    await held();
    await ledger.recordTempoDrainHold({ ...args, reason: "refund_short" });
    await ledger.recordTempoDrainHold({ ...args, reason: "close_evidence_missing" });
    const unknown = await post("release");
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: "tempo_drain_refund_unknown" });
    await expect(shortRefund(0n)).rejects.toMatchObject({ code: "drain_conflict" });
    expect((await ledger.getDrain(args))?.provenRefundNative).toBe("0");
    expect((await post("release")).status).toBe(200);
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(1000);
    expect(await reports()).toEqual([]);
  });

  it("keeps positive refund evidence across a rolled-back admin reconciliation and later missing reads or zero observations", async () => {
    await held();
    let missing = false;
    const rail: TempoDrainRail = { getTempoSessionCloseIntent: () => Promise.resolve({ channelId, drainId: args.drainId, reference: `0x${"b1".repeat(32)}` }),
      getTempoSessionCloseAmounts: () => missing ? Promise.reject(new Error("RPC unavailable")) : Promise.resolve({ refundedToPayer: 400n, settledToPayee: 800n }) };
    const path = "/admin/credit/reconcile-tempo-drain";
    const target = app(false, true, { rail });
    const reconcile = () => target.request(path, { method: "POST", headers: { Authorization: auth("POST", path), "Content-Type": "application/json" }, body: JSON.stringify(request) });
    expect((await reconcile()).status).toBe(409);
    expect(await ledger.getDrain(args)).toMatchObject({ status: "exit_required", provenRefundNative: "400", operatorDecision: null });
    await ledger.recordTempoDrainHold({ ...args, reason: "close_evidence_missing" });
    missing = true;
    expect((await reconcile()).status).toBe(502);
    await ledger.recordTempoDrainRefund({ ...args, refundedNative: 0n });
    expect((await ledger.getDrain(args))?.provenRefundNative).toBe("400");
    expect(await (await post("release")).json()).toMatchObject({ error: "tempo_drain_refund_paid" });
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
    expect(await reports()).toEqual([]);
  });

  it("keeps monetary proof fail-closed and preserves definitive refusal when only the cosmetic label write fails", async () => {
    await held();
    const warning = vi.spyOn(loggers.tempo, "warn");
    const label = vi.spyOn(ledger, "recordTempoDrainHold").mockRejectedValue(new Error("label write unavailable"));
    await expect(shortRefund(400n)).rejects.toMatchObject({ code: "drain_conflict" });
    expect(warning).toHaveBeenCalledWith("tempo_drain_hold_reason_write_failed", {});
    expect((await ledger.getDrain(args))?.provenRefundNative).toBe("400");
    expect(await (await post("release")).json()).toMatchObject({ error: "tempo_drain_refund_paid" });
    label.mockRestore();
    const proof = vi.spyOn(ledger, "recordTempoDrainRefund").mockRejectedValue(new Error("proof write unavailable"));
    await expect(shortRefund(500n)).rejects.toThrow("proof write unavailable");
    expect(warning).toHaveBeenCalledWith("tempo_drain_refund_evidence_write_failed", {});
    expect((await ledger.getDrain(args))?.provenRefundNative).toBe("400");
    expect(await reports()).toEqual([]);
    proof.mockRestore(); warning.mockRestore();
  });

  it("preserves the background wedged filter while admin explicitly includes held write-offs", async () => {
    await held("pending");
    await ledger.writeOffDrain({ ...args, note: "Reviewed", nowMs });
    expect(await ledger.listChannelDrains({ limit: 50, createdBeforeMs: nowMs + 1, rail: "tempo" })).toEqual([]);
    expect(await ledger.listChannelDrains({ limit: 50, createdBeforeMs: nowMs + 1, rail: "tempo", includeWrittenOff: true })).toHaveLength(1);
    const pending = vi.spyOn(reporter, "reportPayoutPending").mockResolvedValue(undefined);
    const payouts = new PayoutReporter({ db: pool, dvmId, transport: reporter, now: () => nowMs + 600_000 });
    try {
      await payouts.init();
      payouts.attachTempo({ listActive: sessions.listActive.bind(sessions), listChannelDrains: ledger.listChannelDrains.bind(ledger) });
      await payouts.snapshotTempo();
      expect(pending.mock.calls[0][0].wedged).toEqual([]);
      await ledger.clearDrainWriteOff(args);
      await payouts.snapshotTempo();
      expect(pending.mock.calls.at(-1)![0].wedged).toEqual([expect.objectContaining({ id: `${args.creditId}:${args.drainId}`, native: 1200 })]);
    } finally { payouts.stop(); pending.mockRestore(); }
  });

  it.each(["standalone", "hosted-option", "hosted-env"])("guards actual reporter wiring with a custom completion hook: %s", async mode => {
    await held();
    const jobs = new PostgresJobStore(pool);
    await jobs.init();
    await initLockPubkeyTable(pool);
    await seedLockPubkeyState(pool, dvmId, lock);
    const server = await createDVMServer(configureDVM({ name: "tempo-decisions", capability: "echo", tag: "test", onJob(ctx) { ctx.complete("done"); } }),
      { env: mode === "hosted-env" ? { DVMKIT_PLATFORM_URL: "https://platform.example.com" } : {},
        ...(mode === "hosted-option" ? { platformUrl: "https://platform.example.com" } : {}),
        platformToken: "example-token", dvmId, db: pool, creditLedger: ledger, store: new MemoryKVStore(), jobStore: jobs,
        lockPubkey: lock, onJobCompleted: () => undefined, adminCashuNonceStore: new MemoryConsumedCredentialStore() });
    try {
      const response = await post("book", request, true, server.app, Date.now());
      expect(response.status).toBe(mode === "standalone" ? 200 : 503);
      if (mode !== "standalone") {
        expect(await response.json()).toMatchObject({ error: "tempo_drain_decision_unavailable" });
        expect(await ledger.getDrain(args)).toMatchObject({ status: "exit_required", operatorDecision: null });
        expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
        expect((await post("release", fixture.release.request, true, server.app, Date.now())).status).toBe(200);
      }
      expect(await reports()).toEqual([]);
    } finally { await server.shutdown(); }
  });

  it("preserves book replay when hosted reporting is temporarily missing", async () => {
    await held();
    expect((await post("book")).status).toBe(200);
    expect(await (await post("book", request, true, app(false, true, { hosted: true, reporting: false }))).json()).toMatchObject({ status: "sent", replayed: true });
    expect(await reports()).toHaveLength(1);
  });

  it("retains an opaque drain reference while suppressing unsafe caller-chosen IDs and free text", async () => {
    await held();
    const credit = "private customer name\ncredit";
    const drain = "private input/secret drain";
    await pool.query("UPDATE credits SET credit_id=$1", [credit]);
    await pool.query("UPDATE credit_drains SET credit_id=$1, drain_id=$2", [credit, drain]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await post("release", { ...fixture.release.request, credit_id: credit, drain_id: drain });
      expect(response.status).toBe(200);
      const event = JSON.parse(String(warn.mock.calls[0][0]));
      expect(event).toMatchObject({ event: "tempo_drain_released", channel_id: channelId, amount_micro: 1000, amount_native: "1200",
        drain_reference: `sha256:${createHash("sha256").update(JSON.stringify([credit, drain])).digest("hex")}` });
      expect(event).not.toHaveProperty("credit_id"); expect(event).not.toHaveProperty("drain_id");
      expect(JSON.stringify(event)).not.toMatch(/private|secret|reason|evidence/);
      expect(await response.json()).toMatchObject({ credit_id: credit, drain_id: drain });
    } finally { warn.mockRestore(); }
  });

  it("books the fixture's whole refund with one report and no invented chain or repair evidence", async () => {
    await held("pending");
    await ledger.writeOffDrain({ ...args, note: "Earlier unbooked review", nowMs: nowMs - 1 });
    const response = await post("book", fixture.book.request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(fixture.book.response);
    expect(await reports()).toEqual([{ kind: "drain", payload: fixture.book.report }]);
    const drain = await ledger.getDrain(args);
    expect(drain?.sentRef).toEqual({ source: "operator", channel_id: channelId });
    expect(drain).toMatchObject({ writeOffNote: null, writtenOffAt: null });
    expect(drain?.operatorDecision).toEqual(fixture.book.response.decision);
    await ledger.init();
    expect((await new CreditLedger(pool, sessions).getDrain(args))?.operatorDecision).toEqual(drain?.operatorDecision);
  });

  it.each(["pending", "exit_required"] as const)("rolls back the decision, prior write-off, and outbox from %s when report enqueue fails", async status => {
    await held(status);
    if (status === "pending") await ledger.writeOffDrain({ ...args, note: "Earlier review", nowMs: nowMs - 1 });
    expect((await post("book", request, true, app(true))).status).toBe(500);
    expect(await ledger.getDrain(args)).toMatchObject({ status, operatorDecision: null, sentRef: null,
      writeOffNote: status === "pending" ? "Earlier review" : null, writtenOffAt: status === "pending" ? nowMs - 1 : null });
    expect(await reports()).toEqual([]);
    expect((await post("release")).status).toBe(200);
    expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(1000);
  });

  it.each(["pending", "exit_required"] as const)("restores exact debit and rail amounts from %s once without reporting a payout", async status => {
    await held(status);
    await pool.query("UPDATE credits SET status='unbacked', balance_micro=7, native_remaining=9, msats_remaining=11 WHERE credit_id=$1", [args.creditId]);
    const response = await post("release", fixture.release.request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...fixture.release.response, balance_micro: 1007 });
    const raw = (await pool.query("SELECT balance_micro, native_remaining, msats_remaining, status FROM credits")).rows;
    expect(raw).toEqual([{ balance_micro: "1007", native_remaining: "1209", msats_remaining: "2511", status: "unbacked" }]);
    const replay = await post("release", fixture.release.request);
    expect(await replay.json()).toMatchObject({ balance_micro: 1007, spendable_micro: 0, replayed: true });
    expect(await reports()).toEqual([]);
    await expect(ledger.draw({ creditId: args.creditId, drawId: "new", amountMicro: 1, nowMs })).rejects.toMatchObject({ code: "credit_unbacked" });
    expect((await sessions.get(channelId) as Record<string, unknown>).finalized).toBe(true);
  });

  it.each([{ finalized: true }, { closeRequestedAt: 1n }, { finalized: false }] as const)(
    "reports effective spendability and preserves channel draw gates: %s", async lifecycle => {
    await held("pending", lifecycle);
    const response = await post("release");
    const blocked = !!lifecycle.finalized || "closeRequestedAt" in lifecycle;
    expect(await response.json()).toMatchObject({ balance_micro: 1000, spendable_micro: blocked ? 0 : 1000 });
    const draw = ledger.draw({ creditId: args.creditId, drawId: "new", amountMicro: 1, nowMs });
    if (blocked) await expect(draw).rejects.toMatchObject({ code: "tempo_channel_closing" });
    else expect(await draw).toMatchObject({ status: "pending" });
  });

  it("restores an expired balance without granting new spending", async () => {
    await held("pending", { finalized: false });
    await pool.query("UPDATE credits SET expiry_ms=$1", [nowMs]);
    expect(await (await post("release")).json()).toMatchObject({ balance_micro: 1000, spendable_micro: 0 });
    await expect(ledger.draw({ creditId: args.creditId, drawId: "new", amountMicro: 1, nowMs })).rejects.toMatchObject({ code: "credit_expired" });
  });

  it.each(["book", "release"] as const)("keeps the %s decision immutable across replay, conflicting intent, and later automatic booking", async decision => {
    await held();
    const intent = decision === "release" ? fixture.release.request : request;
    const first = await (await post(decision)).json();
    expect(await (await post(decision, { ...intent, reason: ` ${intent.reason} `, evidence: ` ${intent.evidence} ` })).json()).toEqual({ ...first, replayed: true });
    expect((await post(decision, { ...intent, reason: "Changed" })).status).toBe(409);
    expect((await post(decision, { ...intent, evidence: "Changed" })).status).toBe(409);
    expect((await post(decision === "book" ? "release" : "book")).status).toBe(409);
    if (decision === "book") expect(await auto()).toMatchObject({ replayed: true });
    else await expect(auto()).rejects.toMatchObject({ code: "invalid_drain_state" });
    expect((await ledger.getDrain(args))?.operatorDecision).toEqual(first.decision);
    expect(await reports()).toHaveLength(decision === "book" ? 1 : 0);
  });

  it("serializes opposing decisions", async () => {
    await held();
    const opposing = await Promise.all([post("book"), post("release")]);
    expect(opposing.map(r => r.status).sort()).toEqual([200, 409]);
    const winner = (await ledger.getDrain(args))?.status;
    expect(await reports()).toHaveLength(winner === "sent" ? 1 : 0);
  });

  it("queues one report when identical bookings race", async () => {
    await held();
    const duplicate = await Promise.all([post("book"), post("book")]);
    const bodies = await Promise.all(duplicate.map(r => r.json()));
    expect(bodies.map(row => row.replayed).sort()).toEqual([false, true]);
    expect(await reports()).toHaveLength(1);
  });

  it.each(["book", "release"] as const)("excludes an operator %s racing automatic booking", async decision => {
    await held();
    const [operator, automatic] = await Promise.all([post(decision), auto().then(value => ({ value }), error => ({ error }))]);
    const drain = await ledger.getDrain(args);
    if (drain?.operatorDecision?.decision === "release") {
      expect(operator.status).toBe(200);
      expect(automatic).toMatchObject({ error: { code: "invalid_drain_state" } });
      expect(await reports()).toEqual([]);
      expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(1000);
    } else {
      expect(drain?.status).toBe("sent");
      expect(operator.status).toBe(drain?.operatorDecision ? 200 : 409);
      expect(await reports()).toHaveLength(1);
      expect((await ledger.get(args.creditId, { nowMs }))?.balanceMicro).toBe(0);
    }
  });

  it.each(["book", "release"] as const)("exports %s action and time while excluding free text and retaining financial amounts", async decision => {
    await held("pending");
    if (decision === "book") await ledger.writeOffDrain({ ...args, note: "Earlier review", nowMs: nowMs - 1 });
    await ledger.recordTempoDrainRefund({ ...args, refundedNative: decision === "book" ? 9007199254740993n : 0n });
    await post(decision, { ...request, reason: "private reason sentinel", evidence: "private evidence sentinel" });
    await pool.query(`UPDATE credit_drains SET operator_decision=operator_decision || '{"request":{"raw":"private request sentinel"}}'::jsonb`);
    const client = await pool.connect();
    try {
      const begin = recipe.indexOf("BEGIN TRANSACTION");
      await client.query(recipe.slice(0, begin));
      const results = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      const exported = results.find(result => result.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;
      expect(exported.drains).toEqual([expect.objectContaining({ amount_micro: 1000, drained_native: 1200, drained_msats: 2500,
        status: decision === "book" ? "sent" : "released", written_off_at: null,
        proven_refund_native: decision === "book" ? "9007199254740993" : "0", refund_payment_proven: decision === "book", operator_decision: { source: "operator", decision: decision === "book" ? "book_refunded" : "release", decidedAt: nowMs } })]);
      expect(JSON.stringify(exported)).not.toContain("private ");
      await client.query("ALTER TABLE credit_drains DROP COLUMN operator_decision, DROP COLUMN hold_reason, DROP COLUMN proven_refund_native, DROP COLUMN refund_payment_proven");
      const legacy = await client.query(recipe.slice(begin)) as unknown as import("pg").QueryResult[];
      const old = legacy.find(result => result.rows?.[0]?.jsonb_build_object)?.rows[0].jsonb_build_object;
      expect(old.drains[0]).toMatchObject({ amount_micro: 1000, drained_native: 1200 });
      expect(old.drains[0]).not.toHaveProperty("operator_decision");
      await ledger.init();
    } finally { client.release(); }
  });

  it("keeps terminal decisions in the audit view and excludes them from the held queue", async () => {
    await held();
    await post("release");
    const configured = app();
    const target = new URL("http://example.com/admin/credit/tempo-drains?min_age_ms=0&evidence=false&include_resolved=true");
    const audit = await configured.request(target.pathname + target.search, { headers: { Authorization: auth("GET", target.pathname) } });
    expect(await audit.json()).toMatchObject({ drains: [{ status: "released", held_reason: null, decision: { decision: "release" } }] });
    target.searchParams.delete("include_resolved");
    const pending = await configured.request(target.pathname + target.search, { headers: { Authorization: auth("GET", target.pathname) } });
    expect(await pending.json()).toEqual({ drains: [] });
  });

  it.each(["book", "release"] as const)("emits the catalogued %s event with exact amounts only for the winner", async decision => {
    await held();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await post(decision); await post(decision);
      const event = decision === "book" ? "tempo_drain_booked_as_refunded" : "tempo_drain_released";
      const events = warn.mock.calls.map(call => JSON.parse(String(call[0]))).filter(row => row.event === event);
      expect(events).toEqual([{ event, level: "warn", dataset: "tempo", credit_id: args.creditId,
        drain_id: args.drainId, channel_id: channelId,
        drain_reference: `sha256:${createHash("sha256").update(JSON.stringify([args.creditId, args.drainId])).digest("hex")}`, amount_micro: 1000, amount_native: "1200", currency: "usd" }]);
    } finally { warn.mockRestore(); }
  });
});
