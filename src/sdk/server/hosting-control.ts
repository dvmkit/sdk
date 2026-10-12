import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence } from "./hosting-cleanup-fence";
import { HOSTED_SETTLEMENT_UNRESOLVED_SQL } from "./hosting-settlement-report-obligations";
import { HostedChannelEvidenceReader, readHostedChannelSnapshot } from "./hosting-channel-evidence";

export interface HostingControlConfig {
  /** Dedicated management key. Use at least 32 random bytes; never reuse a caller or builder key. */
  secret: string;
  /** Deployment scope shared by the platform and this DVM, independent of its caller origin. */
  scope: string;
}

export interface HostingControlCommand {
  /** Version two is required for resume; version one remains valid for drain and status. */
  version?: 2;
  action: "drain" | "resume" | "status";
  scope: string;
  dvmId: string;
  timestampMs: number;
  nonce: string;
  generation?: number;
  deadlineMs?: number;
  leaseExpiresAtMs?: number;
}

/** Ordered JSON arrays are the versioned wire signing contract. */
export function signHostingControl(secret: string, command: HostingControlCommand): string {
  const signed = command.version === 2
    ? ["dvmkit-hosting-v2", command.action, command.scope, command.dvmId,
        command.generation ?? null, command.leaseExpiresAtMs ?? null,
        command.deadlineMs ?? null, command.timestampMs, command.nonce]
    : ["dvmkit-hosting-v1", command.action, command.scope, command.dvmId,
        command.generation ?? null, command.deadlineMs ?? null, command.timestampMs, command.nonce];
  return createHmac("sha256", secret)
    .update(JSON.stringify(signed))
    .digest("hex");
}

export interface HostingClosureCommand {
  version: 3;
  action: "close" | "certificate";
  scope: string;
  dvmId: string;
  generation: number;
  operationId: string;
  timestampMs: number;
  nonce: string;
}

export function signHostingClosure(secret: string, command: HostingClosureCommand): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(["dvmkit-hosting-closure-v3", command.action, command.scope,
      command.dvmId, command.generation, command.operationId, command.timestampMs, command.nonce]))
    .digest("hex");
}

export interface HostingClosureEvidence {
  dvmId: string;
  scope: string;
  instanceId: string;
  bootEpoch: number;
  generation: number;
  operationId: string;
  cutoffTxid: string;
  closedAtMs: number;
  complete: boolean;
  eligible: boolean;
  reasons: string[];
  liabilities: { currency: string; amountMicro: string }[];
}

export interface HostingClosureSupport {
  singleMount: boolean;
  durableLedger: boolean;
  durableJobStore: boolean;
  durableReporter: boolean;
  durablePaymentReplay: boolean;
  knownRailStores: boolean;
}

export interface HostingControlStatus {
  state: "accepting" | "draining" | "closed";
  generation: number;
  deadlineMs: number | null;
  leaseExpiresAtMs: number | null;
  activeJobIds: string[];
  unownedActiveJobIds: string[];
  pendingAdmissionCount: number;
  pendingAdmissions: { admissionId: string; workId: string }[];
  unresolvedAdmissionCount: number;
  unresolvedAdmissions: { admissionId: string; jobId: string }[];
  /** Version of the job-identity response-head field this deployment emits. */
  jobIdentityHeader: "v1";
}

export class HostingControl {
  readonly cleanupFence: HostingCleanupFence;
  private bootEpoch: number | undefined;
  constructor(
    private readonly pool: Pool,
    private readonly dvmId: string,
    private readonly config: HostingControlConfig,
    private readonly channelReader?: HostedChannelEvidenceReader
  ) {
    if (Buffer.byteLength(config.secret) < 32 || !config.scope) {
      throw new Error("Hosting control requires a 32-byte secret and a non-empty scope");
    }
    this.cleanupFence = new HostingCleanupFence(pool, dvmId, config.scope);
  }

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, async () => {
      await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sdk_hosting_control (
        dvm_id TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL,
        generation BIGINT NOT NULL, deadline_ms BIGINT, lease_expires_at_ms BIGINT,
        PRIMARY KEY (dvm_id, scope)
      );
      CREATE TABLE IF NOT EXISTS sdk_hosting_nonces (
        dvm_id TEXT NOT NULL, scope TEXT NOT NULL, nonce TEXT NOT NULL,
        created_at_ms BIGINT NOT NULL,
        PRIMARY KEY (dvm_id, scope, nonce)
      );
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS lease_expires_at_ms BIGINT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS instance_id TEXT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS boot_epoch BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS closed_operation_id TEXT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS closed_at_ms BIGINT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS closed_at_us BIGINT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS cutoff_txid BIGINT;
      ALTER TABLE sdk_hosting_control ADD COLUMN IF NOT EXISTS channel_evidence JSONB;
      CREATE TABLE IF NOT EXISTS sdk_hosting_admissions (
        id TEXT PRIMARY KEY, dvm_id TEXT NOT NULL, scope TEXT NOT NULL,
        job_id TEXT NOT NULL, admitted_at_ms BIGINT NOT NULL,
        outcome TEXT NOT NULL DEFAULT 'pending', drain_deadline_ms BIGINT,
        credit_id TEXT, fund_id TEXT, caller_pubkey TEXT, funding_commitment TEXT,
        payment_artifact_hash TEXT
      );
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS drain_deadline_ms BIGINT;
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS credit_id TEXT;
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS fund_id TEXT;
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS caller_pubkey TEXT;
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS funding_commitment TEXT;
      ALTER TABLE sdk_hosting_admissions ADD COLUMN IF NOT EXISTS payment_artifact_hash TEXT;
      CREATE INDEX IF NOT EXISTS sdk_hosting_admissions_pending
        ON sdk_hosting_admissions (dvm_id, scope) WHERE outcome = 'pending';
      CREATE INDEX IF NOT EXISTS sdk_hosting_admissions_unresolved
        ON sdk_hosting_admissions (dvm_id, scope) WHERE outcome = 'unresolved';
      CREATE INDEX IF NOT EXISTS sdk_hosting_admissions_artifact
        ON sdk_hosting_admissions (dvm_id, scope, payment_artifact_hash)
        WHERE payment_artifact_hash IS NOT NULL;
      CREATE INDEX IF NOT EXISTS sdk_hosting_admissions_job
        ON sdk_hosting_admissions (dvm_id, job_id, scope);
      CREATE INDEX IF NOT EXISTS sdk_hosting_nonces_age ON sdk_hosting_nonces (created_at_ms);
      `);
      await this.pool.query(
        `INSERT INTO sdk_hosting_control (dvm_id, scope, state, generation)
         VALUES ($1, $2, 'draining', 0) ON CONFLICT DO NOTHING`,
        [this.dvmId, this.config.scope]
      );
      // Rows created by an older SDK may have admitted paid work. Close admission
      // without discarding their jobs, and retain a bounded recovery window.
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const boot = await client.query<{ boot_epoch: string }>(
          `UPDATE sdk_hosting_control
           SET instance_id=COALESCE(instance_id,$3), boot_epoch=boot_epoch+1
           WHERE dvm_id=$1 AND scope=$2 RETURNING boot_epoch`,
          [this.dvmId, this.config.scope, randomUUID()]
        );
        if (!boot.rows[0]) throw new Error("Hosting control identity was not initialized");
        this.bootEpoch = Number(boot.rows[0].boot_epoch);
        const migrated = await client.query<{ deadline_ms: string }>(
          `UPDATE sdk_hosting_control SET state='draining',
             deadline_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint + 3600000
           WHERE dvm_id=$1 AND scope=$2 AND state='accepting' AND lease_expires_at_ms IS NULL
           RETURNING deadline_ms`,
          [this.dvmId, this.config.scope]
        );
        if (migrated.rows[0]) await this.pinAdmissionDeadlines(client, Number(migrated.rows[0].deadline_ms));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async authorize(command: HostingControlCommand, signature: string | undefined): Promise<boolean> {
    if ((command.version !== undefined && command.version !== 2) ||
      (command.version === 2 && command.action !== "resume") ||
      (command.version === undefined && command.leaseExpiresAtMs !== undefined) ||
      command.scope !== this.config.scope || command.dvmId !== this.dvmId ||
      !Number.isSafeInteger(command.timestampMs) || Math.abs(Date.now() - command.timestampMs) > 300_000 ||
      typeof command.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(command.nonce) ||
      !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const actual = Buffer.from(signature, "hex");
    const expected = Buffer.from(signHostingControl(this.config.secret, command), "hex");
    if (!timingSafeEqual(actual, expected)) return false;
    const result = await this.pool.query(
      `INSERT INTO sdk_hosting_nonces (dvm_id, scope, nonce, created_at_ms)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [this.dvmId, this.config.scope, command.nonce, Date.now()]
    );
    await this.pool.query("DELETE FROM sdk_hosting_nonces WHERE created_at_ms < $1", [Date.now() - 600_000]);
    return result.rowCount === 1;
  }

  async authorizeClosure(command: HostingClosureCommand, signature: string | undefined): Promise<boolean> {
    if (command?.version !== 3 || (command.action !== "close" && command.action !== "certificate") ||
      command.scope !== this.config.scope || command.dvmId !== this.dvmId ||
      !Number.isSafeInteger(command.generation) || command.generation < 1 ||
      typeof command.operationId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(command.operationId) ||
      !Number.isSafeInteger(command.timestampMs) || Math.abs(Date.now() - command.timestampMs) > 300_000 ||
      typeof command.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(command.nonce) ||
      !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    if (!timingSafeEqual(Buffer.from(signature, "hex"),
      Buffer.from(signHostingClosure(this.config.secret, command), "hex"))) return false;
    const inserted = await this.pool.query(
      `INSERT INTO sdk_hosting_nonces (dvm_id, scope, nonce, created_at_ms)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [this.dvmId, this.config.scope, command.nonce, Date.now()]
    );
    return inserted.rowCount === 1;
  }

  async close(command: HostingClosureCommand, support: HostingClosureSupport): Promise<"ok" | "conflict"> {
    if (command.action !== "close") return "conflict";
    if (!Object.values(support).every(Boolean)) return "conflict";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        state: string; generation: string; deadline_ms: string | null;
        closed_operation_id: string | null;
      }>(
        `SELECT state, generation, deadline_ms, closed_operation_id FROM sdk_hosting_control
         WHERE dvm_id=$1 AND scope=$2 FOR UPDATE`,
        [this.dvmId, this.config.scope]
      );
      const prior = locked.rows[0];
      if (!prior) throw new Error("Hosting control identity is unavailable");
      if (prior.state === "closed") {
        await client.query("COMMIT");
        return Number(prior.generation) === command.generation &&
          prior.closed_operation_id === command.operationId ? "ok" : "conflict";
      }
      if (command.generation <= Number(prior.generation)) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const now = await this.databaseNow(client);
      const deadline = prior.deadline_ms === null
        ? now + 3_600_000 : Math.min(Number(prior.deadline_ms), now + 3_600_000);
      await client.query(
        `UPDATE sdk_hosting_control
         SET state='closed', generation=$3, closed_operation_id=$4,
             closed_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
             closed_at_us=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint,
             cutoff_txid=txid_current(), channel_evidence=NULL,
             lease_expires_at_ms=NULL, deadline_ms=$5
         WHERE dvm_id=$1 AND scope=$2`,
        [this.dvmId, this.config.scope, command.generation, command.operationId, deadline]
      );
      await this.pinAdmissionDeadlines(client, deadline);
      await client.query("COMMIT");
      return "ok";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async certificate(
    command: HostingClosureCommand,
    support: HostingClosureSupport
  ): Promise<HostingClosureEvidence | undefined> {
    if (command.action !== "certificate" || this.bootEpoch === undefined) return undefined;
    const observedClosure = await this.pool.query<{
      state: string; generation: string; closed_operation_id: string | null;
      boot_epoch: string; cutoff_txid: string | null; instance_id: string | null;
    }>(`SELECT state,generation,closed_operation_id,boot_epoch,cutoff_txid,instance_id
        FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2`, [this.dvmId, this.config.scope]);
    const observed = observedClosure.rows[0];
    if (observed?.state !== "closed" || observed.closed_operation_id !== command.operationId ||
      Number(observed.generation) !== command.generation ||
      Number(observed.boot_epoch) !== this.bootEpoch || observed.cutoff_txid === null ||
      observed.instance_id === null) return undefined;
    // RPC is outside the row-lock transaction; the exact closure and local rows are rechecked below.
    const channelObservation = this.channelReader
      ? await this.channelReader.observe({ dvmId: this.dvmId, scope: this.config.scope,
          instanceId: observed.instance_id }).catch(() => undefined) : undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        state: string; generation: string; instance_id: string | null; boot_epoch: string;
        closed_operation_id: string | null; closed_at_ms: string | null;
        closed_at_us: string | null; cutoff_txid: string | null;
      }>(
        `SELECT state,generation,instance_id,boot_epoch,closed_operation_id,closed_at_ms,
                closed_at_us,cutoff_txid
         FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2 FOR UPDATE`,
        [this.dvmId, this.config.scope]
      );
      const row = locked.rows[0];
      if (!row || row.state !== "closed" || row.closed_operation_id !== command.operationId ||
        Number(row.generation) !== command.generation || Number(row.boot_epoch) !== this.bootEpoch ||
        row.instance_id === null || row.instance_id !== observed.instance_id ||
        row.closed_at_ms === null || row.closed_at_us === null ||
        row.cutoff_txid === null || row.cutoff_txid !== observed.cutoff_txid) {
        await client.query("ROLLBACK");
        return undefined;
      }

      const reasons: string[] = [];
      if (!support.singleMount) reasons.push("multi_mount_ledger_unowned");
      if (!support.durableLedger) reasons.push("credit_ledger_unavailable");
      if (!support.durableJobStore) reasons.push("job_store_unavailable");
      if (!support.durableReporter) reasons.push("reporter_unavailable");
      if (!support.durablePaymentReplay) reasons.push("payment_replay_unavailable");
      if (!support.knownRailStores) reasons.push("rail_store_unsupported");

      const tables = ["jobs", "job_messages", "request_id_claims", "sdk_hosting_admissions", "credits", "credit_draws",
        "credit_drains", "credit_invoices", "credit_fundings", "pending_dvm_reports", "payout_x402_batches",
        "x402_exact_settlement_intents", "x402_batch_settlements", "x402_batch_settlement_state", "x402_batch_channels",
        "mpp_tempo_channels", "mpp_tempo_close_intents", "tempo_settlement_readiness",
        "mpp_tempo_charge_replays", "sdk_hosted_tempo_charge_intents",
        "sdk_hosted_settlement_report_history", "sdk_hosted_settlement_report_obligations"];
      const present = await client.query<{ name: string; exists: boolean }>(
        `SELECT name, to_regclass(name) IS NOT NULL AS exists FROM unnest($1::text[]) AS name`,
        [tables]
      );
      const exists = new Set(present.rows.filter((table) => table.exists).map((table) => table.name));
      for (const required of ["jobs", "job_messages", "request_id_claims", "sdk_hosting_admissions", "credits", "credit_draws",
        "credit_drains", "credit_invoices", "credit_fundings", "pending_dvm_reports",
        "payout_x402_batches", "sdk_hosted_settlement_report_history",
        "sdk_hosted_settlement_report_obligations"]) {
        if (!exists.has(required)) reasons.push(`missing_${required}`);
      }
      const count = async (table: string, predicate: string, params: unknown[] = []): Promise<number> => {
        if (!exists.has(table)) return 0;
        const result = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM ${table} WHERE ${predicate}`, params
        );
        return Number(result.rows[0].n);
      };
      if (await count("sdk_hosting_admissions", "dvm_id=$1 AND scope=$2 AND outcome IN ('pending','unresolved')",
        [this.dvmId, this.config.scope])) reasons.push("admissions_unresolved");
      if (await count("sdk_hosting_admissions", "dvm_id<>$1 OR scope<>$2",
        [this.dvmId, this.config.scope])) reasons.push("historical_admission_owner_unknown");
      if (exists.has("sdk_hosting_admissions") && exists.has("credit_fundings")) {
        const unbooked = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM sdk_hosting_admissions a
           WHERE a.dvm_id=$1 AND a.scope=$2 AND a.outcome='accepted'
             AND a.credit_id IS NOT NULL AND a.fund_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM credit_fundings f
               WHERE f.credit_id=a.credit_id AND f.fund_id=a.fund_id)`,
          [this.dvmId, this.config.scope]
        );
        if (Number(unbooked.rows[0].n)) reasons.push("funding_intents_unbooked");
      }
      if (await count("jobs", "(dvm_id=$1 OR dvm_id IS NULL) AND status NOT IN ('completed','failed','cancelled')",
        [this.dvmId])) reasons.push("jobs_in_flight_or_unowned");
      if (await count("jobs", "dvm_id IS DISTINCT FROM $1", [this.dvmId])) {
        reasons.push("historical_job_owner_unknown");
      }
      if (await count("jobs", "dvm_id=$1 AND status IN ('completed','failed','cancelled') AND terminal_report_enqueued IS DISTINCT FROM TRUE",
        [this.dvmId])) reasons.push("terminal_reports_unenqueued");
      if (await count("job_messages", "status IN ('pending-verification','failed-verify') AND data->>'type'='payment'")) {
        reasons.push("inbound_payments_unresolved");
      }
      if (exists.has("request_id_claims") && exists.has("jobs")) {
        const claims = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM request_id_claims c
           LEFT JOIN jobs j ON j.id=c.job_id WHERE j.id IS NULL`
        );
        if (Number(claims.rows[0].n)) reasons.push("request_claims_unowned");
      }
      if (await count("credit_draws", "status='pending'")) reasons.push("draws_pending");
      if (await count("credit_invoices", "status NOT IN ('settled','reconciled')")) {
        reasons.push("invoices_unresolved");
      }
      if (await count("credit_invoices", "hosting_admission_id IS NULL")) {
        reasons.push("historical_invoice_owner_unknown");
      }
      if (await count("credit_fundings",
        "caller_pubkey IS NULL OR balance_after_micro IS NULL OR rail IS NULL")) {
        reasons.push("funding_facts_incomplete");
      }
      if (await count("pending_dvm_reports", "TRUE")) reasons.push("reports_pending_or_unowned");
      if (exists.has("sdk_hosted_settlement_report_history")) {
        const history = await client.query<{ complete: boolean }>(
          "SELECT complete FROM sdk_hosted_settlement_report_history WHERE singleton=TRUE"
        );
        if (history.rows[0]?.complete !== true) reasons.push("historical_settlement_report_provenance_unknown");
      }
      if (await count("sdk_hosted_settlement_report_obligations",
        HOSTED_SETTLEMENT_UNRESOLVED_SQL)) {
        reasons.push("settlement_reports_unresolved");
      }
      if (await count("sdk_hosted_settlement_report_obligations",
        "dvm_id<>$1 OR scope<>$2 OR instance_id<>$3",
        [this.dvmId, this.config.scope, row.instance_id])) {
        reasons.push("historical_settlement_owner_unknown");
      }
      if (await count("payout_x402_batches", "TRUE")) reasons.push("x402_payout_batches_pending");
      if (await count("x402_exact_settlement_intents", "status NOT IN ('complete','rejected')")) {
        reasons.push("x402_exact_unresolved");
      }
      if (await count("x402_batch_settlements", "status <> 'complete'")) {
        reasons.push("x402_batch_unresolved");
      }
      if (exists.has("x402_batch_channels") && !exists.has("x402_batch_settlement_state")) {
        reasons.push("x402_payout_transfer_state_missing");
      }
      if (await count("x402_batch_settlement_state", "pending_settle=TRUE")) {
        reasons.push("x402_payout_transfer_pending");
      }
      const channelSnapshot = await readHostedChannelSnapshot(client);
      if (this.channelReader && !channelObservation) reasons.push("channel_evidence_unavailable");
      if (channelSnapshot.present.includes("x402_batch_channels") &&
        channelSnapshot.x402HistoryComplete !== true) reasons.push("x402_channel_history_incomplete");
      if (channelSnapshot.present.includes("mpp_tempo_channels") &&
        channelSnapshot.tempoHistoryComplete !== true) reasons.push("tempo_channel_history_incomplete");
      const observationCurrent = channelObservation?.digest === channelSnapshot.digest;
      const x402FactCount = channelSnapshot.x402.length + channelSnapshot.x402Tombstones.length;
      if (x402FactCount && (!observationCurrent || !channelObservation?.x402 ||
        channelObservation.x402.channels.length !== x402FactCount)) {
        reasons.push("x402_channel_evidence_unresolved");
      }
      const tempoFactCount = new Set([...channelSnapshot.tempo, ...channelSnapshot.tempoTombstones]
        .map((channel) => channel.channel_key)).size;
      if ((tempoFactCount || channelSnapshot.tempoCloses.length) &&
        (!observationCurrent || !channelObservation?.tempo ||
          channelObservation.tempo.channels.length !== tempoFactCount)) {
        reasons.push("tempo_channel_evidence_unresolved");
      }
      if (channelObservation && !observationCurrent) reasons.push("channel_evidence_stale");
      if (channelObservation?.reasons.length) reasons.push(...channelObservation.reasons);
      if (await count("tempo_settlement_readiness", "failure_latched=TRUE")) {
        reasons.push("tempo_settlement_unresolved");
      }
      if (support.knownRailStores && !exists.has("sdk_hosted_tempo_charge_intents") &&
        exists.has("mpp_tempo_charge_replays")) reasons.push("tempo_charge_intents_missing");
      if (await count("sdk_hosted_tempo_charge_intents", "status <> 'complete'")) {
        reasons.push("tempo_charge_unresolved");
      }
      if (await count("mpp_tempo_charge_replays", "TRUE")) {
        reasons.push("tempo_charge_store_not_quiescent");
      }

      const liabilities: { currency: string; amountMicro: string }[] = [];
      if (exists.has("credits") && exists.has("credit_drains")) {
        const balances = await client.query<{ currency: string; amount_micro: string }>(
          `SELECT currency, SUM(amount_micro)::text AS amount_micro FROM (
             SELECT currency, balance_micro AS amount_micro FROM credits WHERE balance_micro > 0
             UNION ALL
             SELECT c.currency, d.amount_micro FROM credit_drains d
             JOIN credits c ON c.credit_id=d.credit_id WHERE d.status <> 'sent' AND d.status <> 'released'
           ) owed GROUP BY currency ORDER BY currency`
        );
        liabilities.push(...balances.rows.map((balance) => ({
          currency: balance.currency, amountMicro: balance.amount_micro,
        })));
        if (await count("credit_drains", "status <> 'sent' AND status <> 'released' AND owed_sats IS NULL")) {
          reasons.push("drain_value_unpriced");
        }
        const orphan = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM credit_drains d
           LEFT JOIN credits c ON c.credit_id=d.credit_id WHERE c.credit_id IS NULL`
        );
        if (Number(orphan.rows[0].n)) reasons.push("drain_owner_unknown");
      }
      if (liabilities.length) reasons.push("caller_liability_positive");
      if (reasons.length === 0 && observationCurrent && channelObservation) {
        const persisted = { dvmId: this.dvmId, scope: this.config.scope,
          instanceId: row.instance_id, bootEpoch: this.bootEpoch,
          generation: command.generation, operationId: command.operationId,
          cutoffTxid: row.cutoff_txid, digest: channelSnapshot.digest,
          x402: channelObservation.x402, tempo: channelObservation.tempo };
        const saved = await client.query<{ channel_evidence: typeof persisted }>(
          `UPDATE sdk_hosting_control SET channel_evidence=$3::jsonb
           WHERE dvm_id=$1 AND scope=$2 RETURNING channel_evidence`,
          [this.dvmId, this.config.scope, JSON.stringify(persisted)]
        );
        if (saved.rows[0]?.channel_evidence?.digest !== channelSnapshot.digest ||
          saved.rows[0]?.channel_evidence?.operationId !== command.operationId ||
          saved.rows[0]?.channel_evidence?.bootEpoch !== this.bootEpoch) {
          throw new Error("Hosting channel evidence could not be persisted for this closure");
        }
      }
      await client.query("COMMIT");
      const complete = reasons.length === 0;
      return { dvmId: this.dvmId, scope: this.config.scope, instanceId: row.instance_id,
        bootEpoch: this.bootEpoch, generation: command.generation, operationId: command.operationId,
        cutoffTxid: row.cutoff_txid, closedAtMs: Number(row.closed_at_ms),
        complete, eligible: complete, reasons, liabilities };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async admit(id: string, jobId: string, details?: {
    creditId?: string; fundId?: string; callerPubkey?: string;
    fundingCommitment?: string; paymentArtifactHash?: string;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ state: string; lease_expires_at_ms: string | null; deadline_ms: string | null }>(
        `SELECT state, lease_expires_at_ms, deadline_ms FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2 FOR UPDATE`,
        [this.dvmId, this.config.scope]
      );
      const now = await this.databaseNow(client);
      const current = rows[0];
      if (current) await this.expireIfNeeded(client, current, now);
      if (current?.state !== "accepting" || current.lease_expires_at_ms === null ||
        Number(current.lease_expires_at_ms) <= now) {
        await client.query("COMMIT");
        return false;
      }
      await client.query(
        `INSERT INTO sdk_hosting_admissions
         (id, dvm_id, scope, job_id, admitted_at_ms, credit_id, fund_id,
          caller_pubkey, funding_commitment, payment_artifact_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, this.dvmId, this.config.scope, jobId, now,
          details?.creditId ?? null, details?.fundId ?? null,
          details?.callerPubkey ?? null, details?.fundingCommitment ?? null,
          details?.paymentArtifactHash ?? null]
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptedJobByPaymentArtifactHash(hash: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ job_id: string }>(
      `SELECT a.job_id FROM sdk_hosting_admissions a
       JOIN jobs j ON j.id=a.job_id
       WHERE a.dvm_id=$1 AND a.scope=$2 AND a.payment_artifact_hash=$3
         AND a.outcome IN ('accepted', 'unresolved', 'pending')
       ORDER BY a.admitted_at_ms DESC LIMIT 1`,
      [this.dvmId, this.config.scope, hash]
    );
    return rows[0]?.job_id;
  }

  async acceptedFundingAdmission(
    creditId: string, fundId: string, callerPubkey: string, commitment: string,
    paymentArtifactHash: string | undefined
  ): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM sdk_hosting_admissions
       WHERE dvm_id=$1 AND scope=$2 AND credit_id=$3 AND fund_id=$4
         AND caller_pubkey=$5 AND funding_commitment=$6
         AND payment_artifact_hash IS NOT DISTINCT FROM $7
         AND outcome IN ('pending','accepted','unresolved')
       ORDER BY admitted_at_ms, id LIMIT 1`,
      [this.dvmId, this.config.scope, creditId, fundId, callerPubkey, commitment,
        paymentArtifactHash ?? null]
    );
    return rows[0]?.id;
  }

  async rebindAdmissionJob(id: string, jobId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sdk_hosting_admissions SET job_id=$2 WHERE id=$1 AND outcome='pending'`,
      [id, jobId]
    );
  }

  async finishAdmission(id: string, outcome: "accepted" | "failed" | "unresolved", jobId?: string): Promise<void> {
    await this.pool.query(
      `UPDATE sdk_hosting_admissions SET outcome=$2, job_id=COALESCE($3, job_id)
       WHERE id=$1 AND outcome='pending'`,
      [id, outcome, jobId ?? null]
    );
  }

  async jobDeadline(jobId: string): Promise<number | null> {
    const { rows } = await this.pool.query<{ drain_deadline_ms: string | null }>(
      `SELECT MIN(drain_deadline_ms)::text AS drain_deadline_ms
       FROM sdk_hosting_admissions WHERE dvm_id=$1 AND scope=$2 AND job_id=$3`,
      [this.dvmId, this.config.scope, jobId]
    );
    return rows[0]?.drain_deadline_ms === null || !rows[0]
      ? null : Number(rows[0].drain_deadline_ms);
  }

  async dispatchDeadlineReached(jobId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ reached: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM sdk_hosting_admissions
         WHERE dvm_id=$1 AND scope=$2 AND job_id=$3
           AND drain_deadline_ms <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       ) OR EXISTS (
         SELECT 1 FROM sdk_hosting_control
         WHERE dvm_id=$1 AND scope=$2 AND state IN ('draining','closed')
           AND deadline_ms <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       ) AS reached`,
      [this.dvmId, this.config.scope, jobId]
    );
    return rows[0]?.reached ?? false;
  }

  private async databaseNow(client: PoolClient): Promise<number> {
    const { rows } = await client.query<{ now_ms: string }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms`
    );
    return Number(rows[0].now_ms);
  }

  private async pinAdmissionDeadlines(client: PoolClient, deadlineMs: number): Promise<void> {
    await client.query(
      `UPDATE sdk_hosting_admissions SET drain_deadline_ms=
         CASE WHEN drain_deadline_ms IS NULL THEN $3 ELSE LEAST(drain_deadline_ms, $3) END
       WHERE dvm_id=$1 AND scope=$2 AND outcome <> 'failed'`,
      [this.dvmId, this.config.scope, deadlineMs]
    );
  }

  private async expireIfNeeded(
    client: PoolClient,
    row: { state: string; lease_expires_at_ms: string | null; deadline_ms: string | null },
    now: number
  ): Promise<void> {
    if (row.state !== "accepting" ||
      (row.lease_expires_at_ms !== null && Number(row.lease_expires_at_ms) > now)) return;
    const deadline = row.deadline_ms === null ? now + 3_600_000 : Number(row.deadline_ms);
    await client.query(
      `UPDATE sdk_hosting_control SET state='draining', deadline_ms=$3
       WHERE dvm_id=$1 AND scope=$2`,
      [this.dvmId, this.config.scope, deadline]
    );
    row.state = "draining";
    row.deadline_ms = String(deadline);
    await this.pinAdmissionDeadlines(client, deadline);
  }

  async transition(command: HostingControlCommand): Promise<"ok" | "conflict"> {
    if ((command.action !== "drain" && command.action !== "resume") ||
      !Number.isSafeInteger(command.generation) || command.generation! < 1 ||
      (command.action === "drain" && (command.version !== undefined ||
        !Number.isSafeInteger(command.deadlineMs) || command.leaseExpiresAtMs !== undefined)) ||
      (command.action === "resume" && (command.version !== 2 ||
        !Number.isSafeInteger(command.leaseExpiresAtMs) ||
        !Number.isSafeInteger(command.deadlineMs)))) return "conflict";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ state: string; generation: string; deadline_ms: string | null; lease_expires_at_ms: string | null }>(
        `SELECT state, generation, deadline_ms, lease_expires_at_ms FROM sdk_hosting_control
         WHERE dvm_id=$1 AND scope=$2 FOR UPDATE`,
        [this.dvmId, this.config.scope]
      );
      const prior = rows[0];
      if (!prior) throw new Error("Hosting control was not initialized");
      if (prior.state === "closed") {
        await client.query("ROLLBACK");
        return "conflict";
      }
      const now = await this.databaseNow(client);
      await this.expireIfNeeded(client, prior, now);
      const generation = Number(prior.generation);
      const nextState = command.action === "drain" ? "draining" : "accepting";
      if (command.generation === generation && prior.state === nextState &&
        Number(prior.deadline_ms ?? 0) === (command.deadlineMs ?? 0) &&
        (command.action !== "resume" ||
          Number(prior.lease_expires_at_ms ?? 0) === command.leaseExpiresAtMs)) {
        await client.query("COMMIT");
        return "ok";
      }
      if (command.generation! <= generation) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      if (command.action === "drain" &&
        (command.deadlineMs! <= now || command.deadlineMs! > now + 86_400_000)) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      if (command.action === "resume" &&
        (command.leaseExpiresAtMs! <= now || command.leaseExpiresAtMs! > now + 3_600_000 ||
          command.deadlineMs! <= command.leaseExpiresAtMs! ||
          command.deadlineMs! > command.leaseExpiresAtMs! + 3_600_000)) {
        await client.query("ROLLBACK");
        return "conflict";
      }
      await client.query(
        `UPDATE sdk_hosting_control SET state=$3, generation=$4, deadline_ms=$5,
           lease_expires_at_ms=$6
         WHERE dvm_id=$1 AND scope=$2`,
        [this.dvmId, this.config.scope, nextState, command.generation, command.deadlineMs ?? null,
          command.action === "resume" ? command.leaseExpiresAtMs : null]
      );
      if (command.action === "drain") {
        await this.pinAdmissionDeadlines(client, command.deadlineMs!);
      }
      await client.query("COMMIT");
      return "ok";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async status(): Promise<HostingControlStatus> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ state: string; deadline_ms: string | null; lease_expires_at_ms: string | null }>(
        `SELECT state, deadline_ms, lease_expires_at_ms FROM sdk_hosting_control
         WHERE dvm_id=$1 AND scope=$2 FOR UPDATE`, [this.dvmId, this.config.scope]
      );
      if (locked.rows[0]) await this.expireIfNeeded(client, locked.rows[0], await this.databaseNow(client));
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    await this.pool.query(
      `UPDATE sdk_hosting_admissions a SET outcome='accepted'
       WHERE a.dvm_id=$1 AND a.scope=$2 AND a.outcome='pending'
         AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=a.job_id)`,
      [this.dvmId, this.config.scope]
    );
    const creditTable = await this.pool.query<{ present: boolean }>(
      "SELECT to_regclass('credit_fundings') IS NOT NULL AS present"
    );
    await this.pool.query(
      `UPDATE sdk_hosting_admissions a SET outcome='accepted'
       WHERE a.dvm_id=$1 AND a.scope=$2 AND a.outcome='unresolved'
         AND (EXISTS (SELECT 1 FROM jobs j WHERE j.id=a.job_id)
           ${creditTable.rows[0].present ? `OR (a.credit_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM credit_fundings f WHERE f.credit_id=a.credit_id AND f.fund_id=a.fund_id
           ))` : ""})`,
      [this.dvmId, this.config.scope]
    );
    const { rows } = await this.pool.query<{ state: HostingControlStatus["state"]; generation: string; deadline_ms: string | null; lease_expires_at_ms: string | null }>(
      `SELECT state, generation, deadline_ms, lease_expires_at_ms FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2`,
      [this.dvmId, this.config.scope]
    );
    const active = await this.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j WHERE j.dvm_id=$1
         AND j.status IN ('processing', 'working', 'awaiting-input')
         AND EXISTS (SELECT 1 FROM sdk_hosting_admissions a
           WHERE a.dvm_id=j.dvm_id AND a.job_id=j.id AND a.scope=$2)
       ORDER BY j.id`,
      [this.dvmId, this.config.scope]
    );
    const unowned = await this.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j WHERE j.dvm_id=$1
         AND j.status IN ('processing', 'working', 'awaiting-input')
         AND NOT EXISTS (SELECT 1 FROM sdk_hosting_admissions a
           WHERE a.dvm_id=j.dvm_id AND a.job_id=j.id)
       ORDER BY j.id`,
      [this.dvmId]
    );
    const pending = await this.pool.query<{ pending: string; unresolved: string }>(
      `SELECT COUNT(*) FILTER (WHERE outcome='pending')::text AS pending,
              COUNT(*) FILTER (WHERE outcome='unresolved')::text AS unresolved
       FROM sdk_hosting_admissions WHERE dvm_id=$1 AND scope=$2`,
      [this.dvmId, this.config.scope]
    );
    const unresolved = await this.pool.query<{ id: string; job_id: string }>(
      `SELECT id, job_id FROM sdk_hosting_admissions
       WHERE dvm_id=$1 AND scope=$2 AND outcome='unresolved' ORDER BY admitted_at_ms, id`,
      [this.dvmId, this.config.scope]
    );
    const inFlight = await this.pool.query<{ id: string; job_id: string }>(
      `SELECT id, job_id FROM sdk_hosting_admissions
       WHERE dvm_id=$1 AND scope=$2 AND outcome='pending' ORDER BY admitted_at_ms, id`,
      [this.dvmId, this.config.scope]
    );
    return { state: rows[0].state, generation: Number(rows[0].generation),
      deadlineMs: rows[0].deadline_ms === null ? null : Number(rows[0].deadline_ms),
      leaseExpiresAtMs: rows[0].lease_expires_at_ms === null ? null : Number(rows[0].lease_expires_at_ms),
      activeJobIds: active.rows.map((row) => row.id),
      unownedActiveJobIds: unowned.rows.map((row) => row.id),
      pendingAdmissionCount: Number(pending.rows[0].pending),
      pendingAdmissions: inFlight.rows.map((row) => ({ admissionId: row.id, workId: row.job_id })),
      unresolvedAdmissionCount: Number(pending.rows[0].unresolved),
      unresolvedAdmissions: unresolved.rows.map((row) => ({ admissionId: row.id, jobId: row.job_id })),
      jobIdentityHeader: "v1" };
  }
}
