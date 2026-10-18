import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loggers } from "../../../observability/loggers";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import { createDVMServer } from "../app";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { CreditLedger } from "../credit-ledger";
import { HostingControl } from "../hosting-control";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { initLockPubkeyTable, seedLockPubkeyState, toLockPubkey } from "../lock-pubkey-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";

const PRIVKEY = new Uint8Array(32).fill(17);
const LOCK_PUBKEY = "02" + Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");
const DVM_ID = "dvm-admin-credit-test";
const TEMPO_CHANNEL = `0x${"3a".repeat(32)}`;
const TEMPO_TX = `0x${"b1".repeat(32)}`;
const stubFx = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};
const closeReportFixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/tempo-close-reports.json", import.meta.url), "utf8")
) as {
  list: { response: { reports: Record<string, unknown>[] } };
  audit: { response: { reports: (Record<string, unknown> & { obligation_id: string })[] } };
  retry: { request: { obligation_id: string }; response: Record<string, unknown> };
  write_off: { request: { obligation_id: string; note: string }; response: Record<string, unknown> };
};

function signAuth(method: string, path: string): string {
  const nonceHex = randomUUID().replaceAll("-", "");
  const unixSeconds = Math.floor(Date.now() / 1000);
  const digest = buildAdminChallenge({ method, path, dvmId: DVM_ID, nonceHex, unixSeconds });
  const sigHex = Buffer.from(schnorr.sign(digest, PRIVKEY)).toString("hex");
  return `P2PK ${nonceHex}.${unixSeconds}.${sigHex}`;
}

async function call(app: Pick<Hono, "request">, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method, headers: { Authorization: signAuth(method, path), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function callQuery(app: Pick<Hono, "request">, path: string, query: string): Promise<Response> {
  return app.request(path + query, { headers: { Authorization: signAuth("GET", path) } });
}

function makeHarness(db: pg.Pool, store: HostedSettlementReportObligations, scope: string): Hono {
  const app = new Hono();
  const reports = { store, scope };
  installAdminCreditRoutes(app, {
    db, dvmId: DVM_ID, ledger: new MemoryCreditLedger(), fxFetcher: stubFx,
    getLockPubkeyState: async () => ({ current: toLockPubkey(LOCK_PUBKEY), retired: [] }),
    nonceStore: new MemoryConsumedCredentialStore({ maxEntries: 100 }),
    accumulatorWired: false, receiptIssuer: undefined, creditTtlMs: () => 60_000,
    creditCurrency: () => "usd", hostedSettlementReports: reports,
  });
  return app;
}

const CLOSE_REPORT_DB = process.env.DATABASE_URL;
const RUN_CLOSE_REPORT_DB = !!CLOSE_REPORT_DB && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(CLOSE_REPORT_DB);

describe.skipIf(!RUN_CLOSE_REPORT_DB)("Tempo close-report durable route contracts", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function reports(owner = DVM_ID, scope = "test-deployment") {
    const admin = new pg.Pool({ connectionString: CLOSE_REPORT_DB });
    const schema = `close_reports_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const db = new pg.Pool({ connectionString: CLOSE_REPORT_DB, options: `-c search_path=${schema},public` });
    cleanups.push(async () => {
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    });
    await new HostingControl(db, owner, {
      secret: "test-only-close-report-secret-32-bytes", scope,
    }).init();
    const store = new HostedSettlementReportObligations(db, owner, scope);
    await store.init();
    const app = makeHarness(db, store, scope);
    async function seed(state: string, overrides: {
      id?: string; dvmId?: string; scope?: string; rail?: string; operation?: string; txHash?: string;
      channelId?: string;
    } = {}) {
      const id = overrides.id ?? randomUUID();
      await db.query(`INSERT INTO sdk_hosted_settlement_report_obligations
        (id,source_key,dvm_id,scope,instance_id,boot_epoch,rail,operation,network,contract,
         channel_id,original,state,tx_hash,close_search_before,created_at_ms,updated_at_ms)
        VALUES ($1,$1,$2,$3,'test-instance',1,$4,$5,'eip155:42431',$6,$7,$8,$9,$10,42,1000,2000)`,
      [id, overrides.dvmId ?? owner, overrides.scope ?? scope, overrides.rail ?? "tempo",
        overrides.operation ?? "close", `0x${"12".repeat(20)}`, overrides.channelId ?? TEMPO_CHANNEL,
        { highestVoucherAmount: "9007199254741003", settledOnChain: "10" },
        state, overrides.txHash ?? null]);
      return id;
    }
    return { app, db, seed, store, scope };
  }

  it("lists actionable unmatched reports with exact native amounts and timestamps, scoped to this deployment", async () => {
    const { app, seed } = await reports();
    const unmatched = await seed("unmatched");
    const noReport = await seed("no_report", { channelId: `0x${"4a".repeat(32)}` });
    for (const state of ["reserved", "observed", "report_queued", "delivered", "exhausted"]) {
      await seed(state, { channelId: `channel-${state}` });
    }
    await seed("unmatched", { dvmId: "other-dvm" });
    await seed("unmatched", { scope: "other-deployment" });
    await seed("unmatched", { rail: "x402" });
    await seed("unmatched", { operation: "settle" });
    await seed("unmatched", { txHash: TEMPO_TX, channelId: "submitted-channel" });
    const res = await call(app, "GET", "/admin/credit/tempo-close-reports");
    expect(res.status).toBe(200);
    const body = await res.json() as { reports: Record<string, unknown>[] };
    expect(body.reports).toEqual([
      { ...closeReportFixture.list.response.reports[0], obligation_id: unmatched },
    ]);
    const audit = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?all=1")).json() as { reports: Record<string, unknown>[] };
    expect(audit.reports).toContainEqual(expect.objectContaining({
      obligation_id: noReport, status: "no_report", retryable: true, write_off_allowed: false,
    }));
  });

  it("pages terminal reports without losing equal-timestamp rows", async () => {
    const { app, seed } = await reports();
    const ids = [await seed("unmatched"), await seed("unmatched", { channelId: "second-channel" })].sort();
    const first = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?limit=1")).json() as {
      reports: { obligation_id: string }[]; next_after: string;
    };
    expect(first.reports.map(row => row.obligation_id)).toEqual([ids[0]]);
    const second = await (await callQuery(app, "/admin/credit/tempo-close-reports",
      `?limit=1&after=${encodeURIComponent(first.next_after)}`)).json() as { reports: { obligation_id: string }[] };
    expect(second.reports.map(row => row.obligation_id)).toEqual([ids[1]]);
  });

  it.each(["unmatched", "no_report"])("retries %s by reopening the durable search and clearing its cursor", async state => {
    const { app, db, seed } = await reports();
    const id = await seed(state, { id: closeReportFixture.retry.request.obligation_id });
    const res = await call(app, "POST", "/admin/credit/retry-tempo-close-report", closeReportFixture.retry.request);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(closeReportFixture.retry.response);
    expect((await db.query("SELECT state,close_search_before FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows)
      .toEqual([{ state: "reserved", close_search_before: null }]);
  });

  it("returns the exact amount forgone, persists the decision, and emits its channel and amount once", async () => {
    const { app, db, seed } = await reports();
    const id = await seed("unmatched", { id: closeReportFixture.write_off.request.obligation_id });
    const warn = vi.spyOn(loggers.tempo, "warn");
    const body = { ...closeReportFixture.write_off.request, note: " History irrecoverable " };
    const res = await call(app, "POST", "/admin/credit/write-off-tempo-close-report", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(closeReportFixture.write_off.response);
    expect((await db.query("SELECT state,close_write_off_note FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows)
      .toEqual([{ state: "no_report", close_write_off_note: "History irrecoverable" }]);
    expect(warn).toHaveBeenCalledWith("tempo_session_close_report_written_off", {
      channel_id: TEMPO_CHANNEL, obligation_id: id, amount_forgone_native: "9007199254740993",
    });
    expect((await call(app, "POST", "/admin/credit/write-off-tempo-close-report", body)).status).toBe(409);
    expect(warn.mock.calls.filter(([event]) => event === "tempo_session_close_report_written_off")).toHaveLength(1);
  });

  it.each(["retry", "write-off"])("distinguishes missing and foreign reports from refused states for %s", async action => {
    const { app, seed } = await reports();
    const path = `/admin/credit/${action}-tempo-close-report`;
    for (const id of ["absent", await seed("unmatched", { scope: "foreign" }),
      await seed("unmatched", { dvmId: "foreign" }), await seed("unmatched", { rail: "x402" }),
      await seed("unmatched", { operation: "settle" })]) {
      const res = await call(app, "POST", path, { obligation_id: id, note: "reviewed" });
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "tempo_close_report_not_found" });
    }
    const states = action === "retry" ? ["reserved", "observed", "report_queued", "delivered", "exhausted"]
      : ["reserved", "observed", "report_queued", "delivered", "exhausted", "no_report"];
    for (const state of states) {
      const id = await seed(state);
      const res = await call(app, "POST", path, { obligation_id: id, note: "reviewed" });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "tempo_close_report_conflict", obligation_id: id });
    }
    const submitted = await seed("unmatched", { txHash: TEMPO_TX });
    expect((await call(app, "POST", path, { obligation_id: submitted, note: "reviewed" })).status).toBe(409);
  });

  it("refuses retry when another close report already owns the channel", async () => {
    const { app, db, seed } = await reports();
    const id = await seed("no_report");
    await seed("reserved");
    const res = await call(app, "POST", "/admin/credit/retry-tempo-close-report", { obligation_id: id });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "tempo_close_report_conflict" });
    expect((await db.query("SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows)
      .toEqual([{ state: "no_report" }]);
  });

  it("validates report ids, write-off notes, and page queries before changing state", async () => {
    const { app, db, seed } = await reports();
    const id = await seed("unmatched");
    for (const action of ["retry", "write-off"]) {
      for (const body of [null, {}, { obligation_id: 123 }, { obligation_id: " " }]) {
        const res = await call(app, "POST", `/admin/credit/${action}-tempo-close-report`, body);
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "invalid_request" });
      }
    }
    for (const note of [undefined, null, 123, " ", "x".repeat(2001)]) {
      expect((await call(app, "POST", "/admin/credit/write-off-tempo-close-report", { obligation_id: id, note })).status).toBe(400);
    }
    for (const query of ["?limit=0", "?limit=51", "?after=invalid", "?all=invalid"]) {
      const res = await callQuery(app, "/admin/credit/tempo-close-reports", query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_query" });
    }
    expect((await db.query("SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows)
      .toEqual([{ state: "unmatched" }]);
  });

  it.each(["delivered", "reserved"])("hides retired reports replaced by %s and reports the refusal in audit", async successorState => {
    const { app, seed } = await reports();
    const id = await seed("no_report", { id: closeReportFixture.audit.response.reports[0]!.obligation_id });
    await seed(successorState);
    const pending = await call(app, "GET", "/admin/credit/tempo-close-reports");
    expect(await pending.json()).toEqual({ reports: [] });
    const audit = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?all=1")).json() as { reports: Record<string, unknown>[] };
    expect(audit.reports).toEqual(closeReportFixture.audit.response.reports);
    const retry = await call(app, "POST", "/admin/credit/retry-tempo-close-report", { obligation_id: id });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: "tempo_close_report_conflict" });
  });

  it("a listed retryable report really reopens its durable search", async () => {
    const { app, seed } = await reports();
    const id = await seed("unmatched");
    const listed = await (await call(app, "GET", "/admin/credit/tempo-close-reports")).json() as { reports: Record<string, unknown>[] };
    expect(listed.reports).toEqual([expect.objectContaining({ obligation_id: id, retryable: true, write_off_allowed: true })]);
    expect((await call(app, "POST", "/admin/credit/retry-tempo-close-report", { obligation_id: id })).status).toBe(200);
  });

  it("keeps written-off decisions out of the default queue and retains their timestamp through recovery", async () => {
    const { app, db, seed } = await reports();
    const id = await seed("unmatched");
    const before = Number((await db.query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS at")).rows[0].at);
    expect((await call(app, "POST", "/admin/credit/write-off-tempo-close-report", { obligation_id: id, note: "Reviewed history" })).status).toBe(200);
    expect(await (await call(app, "GET", "/admin/credit/tempo-close-reports")).json()).toEqual({ reports: [] });
    const audit = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?all=1")).json() as { reports: {
      obligation_id: string; retryable: boolean; write_off_allowed: boolean; written_off: boolean;
      write_off_note: string; written_off_at_ms: number;
    }[] };
    expect(audit.reports).toEqual([expect.objectContaining({ obligation_id: id, retryable: true,
      write_off_allowed: false, written_off: true, write_off_note: "Reviewed history" })]);
    const recordedAt = audit.reports[0]!.written_off_at_ms;
    expect(recordedAt).toBeGreaterThanOrEqual(before);
    const after = Number((await db.query("SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS at")).rows[0].at);
    expect(recordedAt).toBeLessThanOrEqual(after);
    expect((await call(app, "POST", "/admin/credit/retry-tempo-close-report", { obligation_id: id })).status).toBe(200);
    expect((await db.query("SELECT close_written_off_at_ms::text AS at FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id])).rows)
      .toEqual([{ at: String(recordedAt) }]);
  });

  it("keeps a resolved payer exit in audit while permitting an explicit history correction", async () => {
    const { app, seed, store } = await reports();
    const id = await seed("reserved");
    await store.resolveTempoCloseExit(id);
    expect(await (await call(app, "GET", "/admin/credit/tempo-close-reports")).json()).toEqual({ reports: [] });
    const audit = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?all=1")).json() as { reports: Record<string, unknown>[] };
    expect(audit.reports).toEqual([expect.objectContaining({ obligation_id: id, retryable: true,
      write_off_allowed: false, written_off: false, write_off_note: null, written_off_at_ms: null })]);
    expect((await call(app, "POST", "/admin/credit/retry-tempo-close-report", { obligation_id: id })).status).toBe(200);
  });

  it.each(["retry", "write-off"])("normalizes surrounding whitespace for %s", async action => {
    const { app, seed } = await reports();
    const id = await seed("unmatched");
    const res = await call(app, "POST", `/admin/credit/${action}-tempo-close-report`, { obligation_id: ` ${id} `, note: "Reviewed history" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ obligation_id: id });
  });

  it("uses the injected store identity for list, actions, and missing-versus-refused decisions", async () => {
    const { db, seed, store } = await reports("store-owner", "store-deployment");
    const app = makeHarness(db, store, "different-route-scope");
    const retryId = await seed("unmatched");
    const writeOffId = await seed("unmatched", { channelId: "write-off-channel" });
    const listed = await (await call(app, "GET", "/admin/credit/tempo-close-reports")).json() as { reports: { obligation_id: string }[] };
    expect(listed.reports.map(row => row.obligation_id).sort()).toEqual([retryId, writeOffId].sort());
    for (const [action, id] of [["retry", retryId], ["write-off", writeOffId]]) {
      const path = `/admin/credit/${action}-tempo-close-report`;
      expect((await call(app, "POST", path, { obligation_id: id, note: "Reviewed history" })).status).toBe(200);
      expect((await call(app, "POST", path, { obligation_id: id, note: "Reviewed history" })).status).toBe(409);
      expect((await call(app, "POST", path, { obligation_id: "absent", note: "Reviewed history" })).status).toBe(404);
    }
  });

  it.each([
    { prior: "unmatched", writtenOff: false },
    { prior: "no_report", writtenOff: false },
    { prior: "no_report", writtenOff: true },
  ])("audits a retry from $prior with written-off history $writtenOff exactly once", async ({ prior, writtenOff }) => {
    const { app, seed } = await reports();
    const id = await seed(writtenOff ? "unmatched" : prior);
    if (writtenOff) await call(app, "POST", "/admin/credit/write-off-tempo-close-report", { obligation_id: id, note: "Reviewed history" });
    const info = vi.spyOn(loggers.tempo, "info");
    const body = { obligation_id: id };
    expect((await call(app, "POST", "/admin/credit/retry-tempo-close-report", body)).status).toBe(200);
    expect(info).toHaveBeenCalledWith("tempo_session_close_report_reopened", {
      obligation_id: id, channel_id: TEMPO_CHANNEL, prior_status: prior, written_off: writtenOff,
      amount_native: "9007199254740993",
    });
    expect((await call(app, "POST", "/admin/credit/retry-tempo-close-report", body)).status).toBe(409);
    expect(info.mock.calls.filter(([event]) => event === "tempo_session_close_report_reopened")).toHaveLength(1);
  });

  it("upgrades legacy write-off rows without inventing their decision timestamp", async () => {
    const { app, db, seed, store } = await reports();
    const id = await seed("no_report");
    await db.query("ALTER TABLE sdk_hosted_settlement_report_obligations DROP COLUMN IF EXISTS close_written_off_at_ms");
    await db.query("UPDATE sdk_hosted_settlement_report_obligations SET close_write_off_note='Legacy decision' WHERE id=$1", [id]);
    await store.init();
    const audit = await (await callQuery(app, "/admin/credit/tempo-close-reports", "?all=1")).json() as { reports: Record<string, unknown>[] };
    expect(audit.reports).toEqual([expect.objectContaining({ obligation_id: id, written_off: true,
      write_off_note: "Legacy decision", written_off_at_ms: null, retryable: true })]);
  });

  it("a hosted app wires working close-report routes through production construction", async () => {
    const { db, seed, scope } = await reports();
    const jobs = new PostgresJobStore(db);
    const ledger = new CreditLedger(db);
    await jobs.init();
    await ledger.init();
    await initLockPubkeyTable(db);
    await seedLockPubkeyState(db, DVM_ID, toLockPubkey(LOCK_PUBKEY));
    const id = await seed("unmatched");
    const server = await createDVMServer(configureDVM({
      name: "admin-close-report-test", capability: "echo", tag: "test", idleTimeout: 120,
      onJob(ctx) { ctx.complete("done"); },
    }), { env: {}, store: new MemoryKVStore(), jobStore: jobs, db, dvmId: DVM_ID,
      devMode: true, lockPubkey: LOCK_PUBKEY, creditLedger: ledger,
      hostingControl: { secret: "test-only-close-report-secret-32-bytes", scope },
      adminCashuNonceStore: new MemoryConsumedCredentialStore({ maxEntries: 100 }),
    });
    try {
      const res = await call(server.app, "GET", "/admin/credit/tempo-close-reports");
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ reports: [expect.objectContaining({ obligation_id: id })] });
    } finally { await server.shutdown(); }
  });

});
