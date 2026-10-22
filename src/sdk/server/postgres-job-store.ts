import { callerDeadline, hasCallerDeadline } from "./job";
import { applyContentHoldMutation, ContentHoldError, type ContentHoldHistory, type ContentHoldMutation } from "./content-retention";
import { diagnosticConsole } from "../../observability/diagnostic-console";
import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ListenChannel } from "../../lib/listen-channel";
import type { Message } from "../../lib/messages/types";
import type { JobReceipt } from "../../lib/receipt";
import type { StepRecord } from "../step-cache";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence } from "./hosting-cleanup-fence";
import type {
  AppendOutgoingOptions,
  JobCounters,
  JobRecord,
  JobRetentionCursor,
  JobStatus,
  OutgoingMessage,
  PaymentCreditDelta,
  ReceiptIssuingStore,
  RequestIdClaim,
  RequestIdClaimResult,
  StreamableJobStore,
  VerifyAndCreditResult,
} from "./job-store";

const JOB_MESSAGES_CHANNEL = "job_messages";
const JOB_DVM_ID = Symbol("jobDvmId");
type DvmScopedJobRecord = JobRecord & { [JOB_DVM_ID]?: string };

interface MessageSubscriber {
  afterSeq: number;
  cb: (msg: Message) => void;
}

interface NotifySubscriber {
  cb: () => void;
}

/** Postgres-backed JobStore with cross-machine message streaming via LISTEN/NOTIFY. */
export class PostgresJobStore implements StreamableJobStore, ReceiptIssuingStore {
  private pool: Pool;
  private hostingCleanupFence?: HostingCleanupFence;
  private listenChannel: ListenChannel | null = null;
  private messageSubscribers = new Map<string, Set<MessageSubscriber>>();
  private notifySubscribers = new Map<string, Set<NotifySubscriber>>();
  private requestIdClaimLocks = new Map<
    string,
    {
      client: PoolClient;
      lockKey: string;
      requesterPubkey: string;
      requestId: string;
    }
  >();

  constructor(pool: Pool) {
    this.pool = pool;
  }

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }

  /** Run the CREATE TABLE migration. Call once at startup. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  private async createTables(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS credit_balance_payments (
      payment_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      job_id TEXT NOT NULL,
      request_seq BIGINT NOT NULL,
      response JSONB NOT NULL,
      UNIQUE(job_id, request_seq)
    )`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id                          TEXT PRIMARY KEY,
        tags                        JSONB NOT NULL DEFAULT '[]',
        input                       TEXT NOT NULL,
        params                      JSONB NOT NULL DEFAULT '{}',
        requester_id                TEXT NOT NULL,
        status                      TEXT NOT NULL DEFAULT 'processing',
        summary                     TEXT,
        messages                    JSONB NOT NULL DEFAULT '[]',
        seq                         INTEGER NOT NULL DEFAULT 0,
        paid_msats                  BIGINT NOT NULL DEFAULT 0,
        payment_mint                TEXT,
        received_proofs             JSONB NOT NULL DEFAULT '[]',
        pending_payment_msats       BIGINT,
        -- Keeps its mpp spelling past rail rename: it
        -- holds mppx challenge ids — objects of the MPP envelope the Tempo rail
        -- rides, not the rail key — and it is server-internal anti-replay state
        -- that never reaches a caller.
        pending_mpp_challenge_ids   JSONB,
        pending_x402_nonce          TEXT,
        pending_x402_amount_usdc_micro TEXT,
        step_cache                  JSONB NOT NULL DEFAULT '[]',
        state                       JSONB NOT NULL DEFAULT '{}',
        created_at                  BIGINT NOT NULL,
        last_activity_at            BIGINT NOT NULL
      );
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS timing_known BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS terminal_at_ms BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS caller_wait_ms BIGINT NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS awaiting_input_at_ms BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ended_by TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS terminal_report_enqueued BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_mpp_challenge_ids JSONB;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_x402_nonce TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_x402_amount_usdc_micro TEXT;
      ALTER TABLE jobs DROP COLUMN IF EXISTS pending_payment_hash;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_rail TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_tx_hash TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payment_transaction_hash TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS native_amount DOUBLE PRECISION;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS native_asset TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cashu_flow TEXT;
      -- what the job cost the BUILDER to serve, declared by the
      -- handler through ctx.cost(). NULL is "unreported", deliberately
      -- distinguishable from a declared zero.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_amount_micro BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_currency TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_revision BIGINT;
      -- Cost-only reports are queued after the terminal row lands. Keep the
      -- owning DVM and the last durably-enqueued revision on that row so a
      -- restarted (or sibling) process can close that crash window without
      -- replaying another mount's jobs.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS dvm_id TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cost_reported_revision BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_msats BIGINT;
      -- next_seq is intentionally absent from isolate_jobs (platform/db.ts).
      -- It powers StreamableJobStore cross-machine seq allocation; isolate
      -- DVMs are single-machine and use basic JobStore only.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS next_seq INTEGER NOT NULL DEFAULT 1;
      -- the rail formerly written as 'mpp' is 'tempo'. A live job's
      -- mid-job payment compares this against the incoming rail, and the
      -- receipt reports it.
      UPDATE jobs SET payment_rail = 'tempo' WHERE payment_rail = 'mpp';
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS capability TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requester_token_hash TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requester_token TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS requester_pubkey TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS request_id TEXT;
      -- the route accepted by the live auth gate. Kept outside the
      -- caller-controlled envelope so reactivation cannot derive its expected
      -- route from the proof it is meant to check.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auth_request_path TEXT;
      -- the signed receipt, written once at terminal by saveReceipt,
      -- plus the per-DVM terminal counter value this job holds. Neither is in
      -- save's column list — a stale snapshot must not be able to clear a
      -- receipt or re-allocate a sequence number.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt JSONB;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS receipt_seq BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS redacted_at BIGINT;
      CREATE TABLE IF NOT EXISTS job_content_holds (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_content_holds_job_idx ON job_content_holds(job_id);
      CREATE TABLE IF NOT EXISTS job_content_hold_events (
        event_position BIGSERIAL UNIQUE,
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        data JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_content_hold_events_job_idx ON job_content_hold_events(job_id);

      -- credit-ledger linkage. Written at submission alongside the
      -- payment fields; the terminal funnel settles/releases the draw and the
      -- receipt countersigns the ReceiptCredit block from it.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS credit_id TEXT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS draw_id TEXT;
      -- the original signed funding artifact and the snapshot served
      -- with a fund-and-draw response. INSERT-only for replay stability.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS funding_receipt JSONB;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS funding_credit JSONB;
      -- the outstanding mid-job ask, denominated in fiat micro at the
      -- instant it was emitted. The top-up's ledger leg funds and grows the
      -- draw in this figure, so it must not move with the BTC/USD rate between
      -- the ask and the payment (and the paying machine is often not the one
      -- that asked, so it has to be durable rather than handler-local).
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_payment_fiat_micro BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pending_payment_fiat_currency TEXT;
      -- the same figure accumulated over the job's whole life, which
      -- is what caps mid-job draw growth. It has to be its own column rather
      -- than a read of the one above: Tx C decrements the outstanding figure as
      -- payments land, and a cap that shrank with it would let a duplicate
      -- payment buy the same ask twice.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS asked_topup_micro BIGINT;
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS asked_topup_currency TEXT;
      -- why the ceiling above is absent, on the jobs where it is. The
      -- durable half of the -1 sentinel — an uncapped job has to be findable by
      -- query, not by grepping a log line off a machine that may be long gone.
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS topup_cap_unenforced_reason TEXT;
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'jobs' AND column_name = 'result'
        ) THEN
          ALTER TABLE jobs RENAME COLUMN result TO summary;
        END IF;
      END
      $migration$;
      UPDATE jobs SET next_seq = seq + 1 WHERE next_seq <= seq;
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
      CREATE INDEX IF NOT EXISTS idx_jobs_retention
        ON jobs (last_activity_at, id)
        WHERE redacted_at IS NULL AND status IN ('completed', 'failed', 'cancelled');
      -- Terminal cost recovery runs at boot and every 30s on each machine.
      -- Indexing only rows whose latest revision is not yet enqueued keeps each
      -- pass proportional to that backlog; marking a row drops it from the
      -- index. listUnreportedTerminalCosts' WHERE clause must imply this
      -- predicate or the planner falls back to scanning terminal history.
      DROP INDEX IF EXISTS idx_jobs_pending_cost_report;
      CREATE INDEX IF NOT EXISTS idx_jobs_unreported_terminal_cost
        ON jobs (dvm_id, id)
        WHERE cost_revision IS NOT NULL
          AND (cost_reported_revision IS NULL OR cost_reported_revision < cost_revision)
          AND (
            status IN ('failed', 'cancelled')
            OR (status = 'completed' AND paid_msats = 0)
          );
      -- the idempotent-replay lookup. payment_tx_hash carries the
      -- caller's X-Cashu-Request-Id on the accumulator path, so a retried paid
      -- submit finds the job its payment already created.
      CREATE INDEX IF NOT EXISTS idx_jobs_payment_tx_hash ON jobs (payment_tx_hash);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_request_id_caller
        ON jobs (requester_pubkey, request_id)
        WHERE request_id IS NOT NULL;

      -- Public request ids keep a permanent identity/job binding. A live
      -- Postgres advisory lock serializes the paid accept path; unlike a held
      -- row, that lock disappears when its owning process or connection dies,
      -- allowing an exact retry to reach the rail's durable idempotency row.
      CREATE TABLE IF NOT EXISTS request_id_claims (
        requester_pubkey   TEXT NOT NULL,
        request_id         TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        requester_id       TEXT NOT NULL,
        job_id             TEXT NOT NULL UNIQUE,
        created_at         BIGINT NOT NULL,
        updated_at         BIGINT NOT NULL,
        PRIMARY KEY (requester_pubkey, request_id)
      );

      CREATE TABLE IF NOT EXISTS job_messages (
        job_id  TEXT NOT NULL,
        seq     INTEGER NOT NULL,
        data    JSONB NOT NULL,
        status  TEXT NOT NULL DEFAULT 'verified',
        created_at_ms BIGINT,
        PRIMARY KEY (job_id, seq)
      );
      ALTER TABLE job_messages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'verified';
      ALTER TABLE job_messages ADD COLUMN IF NOT EXISTS created_at_ms BIGINT;

      -- per-DVM monotonic receipt counter. Single row by
      -- construction (the CHECK pins the key), and per-DVM by construction
      -- too — the SDK runs one database per DVM (see postgres-kv-store.ts).
      -- Allocated with the same UPDATE … RETURNING trick as jobs.next_seq so
      -- concurrent machines can't hand two jobs the same number.
      CREATE TABLE IF NOT EXISTS receipt_counter (
        id BOOLEAN PRIMARY KEY DEFAULT TRUE,
        n  BIGINT NOT NULL DEFAULT 0,
        CONSTRAINT receipt_counter_singleton CHECK (id)
      );
      INSERT INTO receipt_counter (id, n) VALUES (TRUE, 0) ON CONFLICT (id) DO NOTHING;
    `);
  }

  async get(id: string): Promise<JobRecord | undefined> {
    const { rows } = await this.pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    if (rows.length === 0) return undefined;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  /**
   * Indexed by `idx_jobs_payment_tx_hash`. `paymentTxHash` is unique
   * per settlement in practice — the accumulator's
   * `UNIQUE(dvm_id, request_id, proof_secret)` is what makes a second job under
   * the same request id impossible — but order by `created_at` so a
   * hypothetical duplicate resolves to the job the caller actually paid for.
   */
  async findJobByPaymentTxHash(txHash: string): Promise<JobRecord | undefined> {
    const { rows } = await this.pool.query(
      "SELECT * FROM jobs WHERE payment_tx_hash = $1 ORDER BY created_at ASC LIMIT 1",
      [txHash]
    );
    if (rows.length === 0) return undefined;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async findJobByRequestId(
    requestId: string,
    requesterPubkey: string
  ): Promise<JobRecord | undefined> {
    const { rows } = await this.pool.query(
      `SELECT * FROM jobs
        WHERE requester_pubkey = $1 AND request_id = $2
        ORDER BY created_at ASC
        LIMIT 1`,
      [requesterPubkey, requestId]
    );
    if (rows.length === 0) return undefined;
    return rowToRecord(rows[0] as Record<string, unknown>);
  }

  async claimRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined> {
    return this.acquireRequestIdClaim(claim, true);
  }

  async resumeRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined> {
    return this.acquireRequestIdClaim(claim, false);
  }

  private async acquireRequestIdClaim(
    claim: RequestIdClaim,
    createBinding: boolean
  ): Promise<RequestIdClaimResult | undefined> {
    const client = await this.pool.connect();
    const lockKey = requestIdAdvisoryLockKey(claim.requesterPubkey, claim.requestId);
    let locked = false;
    let transactional = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [lockKey]
      );
      if (!lock.rows[0]?.acquired) return undefined;
      locked = true;
      if (createBinding && this.hostingCleanupFence) {
        await client.query("BEGIN");
        transactional = true;
        await this.hostingCleanupFence.assertNewIntent(client);
      }

      const now = Date.now();
      const inserted = createBinding
        ? await client.query<{ job_id: string }>(
            `INSERT INTO request_id_claims (
               requester_pubkey, request_id, request_fingerprint, requester_id,
               job_id, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $6)
             ON CONFLICT (requester_pubkey, request_id) DO NOTHING
             RETURNING job_id`,
            [
              claim.requesterPubkey,
              claim.requestId,
              claim.requestFingerprint,
              claim.requesterId,
              claim.jobId,
              now,
            ]
          )
        : { rowCount: 0, rows: [] };

      let result: RequestIdClaimResult | undefined;
      if (inserted.rowCount === 1) {
        result = { jobId: inserted.rows[0].job_id, replayed: false };
      } else {
        const existing = await client.query<{
          job_id: string;
          request_fingerprint: string;
          requester_id: string;
        }>(
          `SELECT job_id, request_fingerprint, requester_id
             FROM request_id_claims
            WHERE requester_pubkey = $1 AND request_id = $2`,
          [claim.requesterPubkey, claim.requestId]
        );
        const row = existing.rows.at(0);
        if (
          row?.request_fingerprint === claim.requestFingerprint &&
          row.requester_id === claim.requesterId
        ) {
          result = { jobId: row.job_id, replayed: true };
        }
      }

      if (transactional) {
        await client.query("COMMIT");
        transactional = false;
      }
      if (!result) return undefined;
      this.requestIdClaimLocks.set(claim.claimToken, {
        client,
        lockKey,
        requesterPubkey: claim.requesterPubkey,
        requestId: claim.requestId,
      });
      return result;
    } catch (error) {
      if (transactional) await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      if (!this.requestIdClaimLocks.has(claim.claimToken)) {
        let discard = false;
        if (locked) {
          try {
            await client.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
          } catch {
            discard = true;
          }
        }
        client.release(discard);
      }
    }
  }

  async releaseRequestIdClaim(claim: RequestIdClaim): Promise<void> {
    const held = this.requestIdClaimLocks.get(claim.claimToken);
    if (held?.requesterPubkey !== claim.requesterPubkey || held.requestId !== claim.requestId) {
      return;
    }
    this.requestIdClaimLocks.delete(claim.claimToken);
    try {
      const unlocked = await held.client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
        [held.lockKey]
      );
      if (!unlocked.rows[0]?.unlocked) {
        throw new Error("request-id advisory lock was not owned by this connection");
      }
    } catch (err) {
      held.client.release(true);
      throw err;
    }
    held.client.release();
  }

  async saveStep(jobId: string, record: StepRecord): Promise<void> {
    const result = await this.pool.query(
      `UPDATE jobs SET step_cache = CASE
         WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(step_cache) AS step
                      WHERE step->>'id' = $2::jsonb->>'id') THEN step_cache
         ELSE step_cache || jsonb_build_array($2::jsonb) END
       WHERE id = $1 AND status NOT IN ('completed', 'failed', 'cancelled')
         AND redacted_at IS NULL`,
      [jobId, JSON.stringify(record)],
    );
    if (result.rowCount !== 1) throw new Error("Step persistence requires a live job");
  }

  async save(record: JobRecord): Promise<void> {
    const dvmId = (record as DvmScopedJobRecord)[JOB_DVM_ID];
    for (let attempt = 0; ; attempt++) {
      try {
        await this.saveRecord(record, dvmId);
        return;
      } catch (error) {
        if (attempt >= 7 || !(await this.canRetrySnapshot(error, record))) throw error;
        await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  }

  /** Persist a job while retaining its mount identity for cost-report recovery. */
  async saveForDvm(record: JobRecord, dvmId: string): Promise<void> {
    const scoped = record as DvmScopedJobRecord;
    scoped[JOB_DVM_ID] = dvmId;
    try {
      // Route through the public override point. Fault-injecting and custom
      // subclasses rely on `save()` remaining the one persistence seam.
      await this.save(scoped);
    } finally {
      delete scoped[JOB_DVM_ID];
    }
  }

  private async canRetrySnapshot(error: unknown, record: JobRecord): Promise<boolean> {
    if (error === null || typeof error !== "object") return false;
    const { code, constraint } = error as { code?: unknown; constraint?: unknown };
    // A deadlock aborts the statement/transaction. Hosted saves roll back and
    // release their client before reaching this retry boundary.
    if (code === "40P01") return true;
    if (code !== "23505" || constraint !== "idx_jobs_request_id_caller") return false;
    // ON CONFLICT(id) arbitrates only the primary key. A concurrent insert or
    // indexed-status UPDATE can make its secondary unique-index check fail for
    // the very same job. Retry only after proving the pair's durable owner;
    // another job claiming it must remain a uniqueness violation.
    const { rows } = await this.pool.query<{ id: string }>(
      "SELECT id FROM jobs WHERE requester_pubkey=$1 AND request_id=$2",
      [record.requesterPubkey, record.requestId]
    );
    return rows[0]?.id === record.id;
  }

  private async saveRecord(record: JobRecord, dvmId?: string): Promise<void> {
    // `next_seq` is owned by the transactional write paths
    // (`appendOutgoing` / `recordInbound`) — `save` only persists handler-
    // visible snapshot fields, never the seq allocator. The snapshot's
    // `seq` field is kept in sync with the highest message seq written by
    // those paths so durable-replay readers see the right `replayHighSeq`.
    const now = Date.now();
    const write = (q: Pool | PoolClient) => q.query(
      `INSERT INTO jobs (
        id, tags, capability, input, params, requester_id, status, summary,
        messages, seq, paid_msats, payment_mint, payment_rail,
        payment_tx_hash, payment_transaction_hash, native_amount, native_asset, cashu_flow,
        cost_amount_micro, cost_currency, cost_revision,
        received_proofs, pending_payment_msats, pending_mpp_challenge_ids,
        pending_x402_nonce, pending_x402_amount_usdc_micro, required_msats, step_cache, state, created_at,
        last_activity_at, next_seq, requester_token_hash, requester_token,
        request_fingerprint, requester_pubkey, request_id, credit_id, draw_id,
        pending_payment_fiat_micro, pending_payment_fiat_currency, auth_request_path,
        funding_receipt, funding_credit, dvm_id, terminal_at_ms, caller_wait_ms, awaiting_input_at_ms, ended_by, timing_known
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$51)
      ON CONFLICT (id) DO UPDATE SET
        terminal_at_ms = COALESCE(jobs.terminal_at_ms, EXCLUDED.terminal_at_ms),
        ended_by = CASE WHEN jobs.status IN ('completed', 'failed', 'cancelled') THEN jobs.ended_by ELSE EXCLUDED.ended_by END,
        caller_wait_ms = CASE WHEN jobs.status IN ('completed', 'failed', 'cancelled') THEN jobs.caller_wait_ms
          ELSE jobs.caller_wait_ms + CASE WHEN jobs.status = 'awaiting-input' AND EXCLUDED.status <> 'awaiting-input'
            THEN GREATEST(0, $50 - COALESCE(jobs.awaiting_input_at_ms, jobs.last_activity_at)) ELSE 0 END END,
        awaiting_input_at_ms = CASE WHEN EXCLUDED.status = 'awaiting-input'
          THEN COALESCE(jobs.awaiting_input_at_ms, $50) ELSE NULL END,
        status = EXCLUDED.status,
        summary = EXCLUDED.summary,
        messages = EXCLUDED.messages,
        -- GREATEST keeps seq monotonic: a stale snapshot from a machine
        -- whose in-memory job.seq is behind the DB high-water mark must
        -- not regress jobs.seq.
        seq = GREATEST(jobs.seq, EXCLUDED.seq),
        payment_mint = EXCLUDED.payment_mint,
        payment_rail = EXCLUDED.payment_rail,
        payment_tx_hash = EXCLUDED.payment_tx_hash,
        payment_transaction_hash = COALESCE(jobs.payment_transaction_hash, EXCLUDED.payment_transaction_hash),
        native_amount = EXCLUDED.native_amount,
        native_asset = EXCLUDED.native_asset,
        cashu_flow = EXCLUDED.cashu_flow,
        -- Cost declarations are revisioned because a terminal snapshot can be
        -- re-saved by a different machine. Never let a stale persisted prefix
        -- replace the handler owner's later cumulative declaration; a higher
        -- revision with NULL amount/currency is an intentional invalidation.
        cost_amount_micro = CASE
          WHEN EXCLUDED.cost_revision IS NOT NULL
            AND (jobs.cost_revision IS NULL OR EXCLUDED.cost_revision >= jobs.cost_revision)
          THEN EXCLUDED.cost_amount_micro
          ELSE jobs.cost_amount_micro
        END,
        cost_currency = CASE
          WHEN EXCLUDED.cost_revision IS NOT NULL
            AND (jobs.cost_revision IS NULL OR EXCLUDED.cost_revision >= jobs.cost_revision)
          THEN EXCLUDED.cost_currency
          ELSE jobs.cost_currency
        END,
        cost_revision = CASE
          WHEN EXCLUDED.cost_revision IS NOT NULL
            AND (jobs.cost_revision IS NULL OR EXCLUDED.cost_revision >= jobs.cost_revision)
          THEN EXCLUDED.cost_revision
          ELSE jobs.cost_revision
        END,
        dvm_id = COALESCE(jobs.dvm_id, EXCLUDED.dvm_id),
        received_proofs = EXCLUDED.received_proofs,
        pending_mpp_challenge_ids = EXCLUDED.pending_mpp_challenge_ids,
        pending_x402_nonce = EXCLUDED.pending_x402_nonce,
        pending_x402_amount_usdc_micro = EXCLUDED.pending_x402_amount_usdc_micro,
        required_msats = EXCLUDED.required_msats,
        -- A stale snapshot must not erase a step committed by saveStep.
        -- First stored result wins for each id, matching cached replay.
        step_cache = (
          SELECT COALESCE(jsonb_agg(entry ORDER BY position), '[]'::jsonb)
          FROM (
            SELECT DISTINCT ON (entry->>'id') entry, position
            FROM jsonb_array_elements(jobs.step_cache || EXCLUDED.step_cache)
              WITH ORDINALITY AS steps(entry, position)
            ORDER BY entry->>'id', position
          ) AS merged_steps
        ),
        state = EXCLUDED.state,
        last_activity_at = CASE WHEN jobs.status IN ('completed', 'failed', 'cancelled') THEN jobs.last_activity_at ELSE EXCLUDED.last_activity_at END
      -- terminal is terminal. On a multi-machine DVM a DELETE can
      -- land on a machine that isn't running the handler, which cancels the
      -- job in the store only; the handler's machine never learns of it and
      -- would otherwise persist completed over the cancelled row. Once a row is
      -- terminal, only a re-save of the SAME terminal status lands (an
      -- idempotent re-persist of the same outcome); a different status is
      -- rejected wholesale, so the row can't end up as a Frankenstein of a
      -- cancelled status and a completed snapshot.
      WHERE jobs.redacted_at IS NULL
        AND (jobs.status NOT IN ('completed', 'failed', 'cancelled')
          OR jobs.status = EXCLUDED.status)`,
      [
        record.id,
        JSON.stringify(record.tags),
        record.capability,
        record.input,
        JSON.stringify(record.params),
        record.requesterId,
        record.status,
        record.summary ?? null,
        JSON.stringify(record.messages),
        record.seq,
        record.paidMsats,
        record.paymentMint ?? null,
        record.paymentRail ?? null,
        record.paymentTxHash ?? null,
        record.paymentTransactionHash ?? null,
        record.nativeAmount ?? null,
        record.nativeAsset ?? null,
        record.cashuFlow ?? null,
        record.costAmountMicro ?? null,
        record.costCurrency ?? null,
        record.costRevision ?? null,
        JSON.stringify(record.receivedProofs),
        record.pendingPaymentMsats ?? null,
        record.pendingMppChallengeIds ? JSON.stringify(record.pendingMppChallengeIds) : null,
        record.pendingX402Nonce ?? null,
        record.pendingX402AmountUsdcMicro ?? null,
        record.requiredMsats ?? null,
        JSON.stringify(record.stepCache),
        JSON.stringify(record.state),
        record.createdAt,
        record.lastActivityAt,
        Math.max(record.seq + 1, 1),
        record.requesterTokenHash ?? null,
        // submission-time provenance. Like requester_token_hash,
        // these are INSERT-only — the ON CONFLICT branch above never touches
        // them, so a later snapshot save can't rewrite what the caller must
        // reproduce to recover the job.
        record.requesterToken ?? null,
        record.requestFingerprint ?? null,
        record.requesterPubkey ?? null,
        record.requestId ?? null,
        // ledger linkage — INSERT-only for the same reason.
        record.creditId ?? null,
        record.drawId ?? null,
        // the pinned mid-job ask. INSERT-only, exactly like its
        // companion `pending_payment_msats` — both are owned by the
        // transactional paths (`appendOutgoing` sets them, `verifyAndCredit`
        // clears them), so a stale snapshot must not be able to reset one
        // while the other stands.
        record.pendingPaymentFiatMicro ?? null,
        record.pendingPaymentFiatCurrency ?? null,
        // submission provenance, INSERT-only with the fingerprint
        // and caller identity above. Snapshot saves cannot rewrite the route
        // whose live gate accepted this proof.
        record.authRequestPath ?? null,
        record.fundingReceipt ? JSON.stringify(record.fundingReceipt) : null,
        record.fundingCredit ? JSON.stringify(record.fundingCredit) : null,
        dvmId ?? null,
        isTerminalStatus(record.status) ? now : null,
        record.callerWaitMs ?? 0,
        record.status === "awaiting-input" ? record.awaitingInputAtMs ?? now : null,
        isTerminalStatus(record.status) && record.status !== "completed" ? record.endedBy ?? "provider" : null,
        now,
        record.timingKnown ?? true,
      ]
    );
    let rowCount: number | null;
    const tx = await this.pool.connect();
    try {
      await tx.query("BEGIN");
      // Lock an existing row before speculative insertion touches its unique
      // indexes. Otherwise a concurrent indexed UPDATE can become the deadlock
      // victim, and retrying only this save cannot recover that other writer.
      const existing = await tx.query<{ dvm_id: string | null }>(
        "SELECT dvm_id FROM jobs WHERE id=$1 FOR UPDATE", [record.id]
      );
      if (this.hostingCleanupFence) {
        if (existing.rows[0]) {
          if (existing.rows[0].dvm_id !== null &&
            existing.rows[0].dvm_id !== this.hostingCleanupFence.dvmId) {
            throw new Error("Hosted job belongs to another DVM");
          }
        } else {
          await this.hostingCleanupFence.assertNewIntent(tx, { jobId: record.id });
        }
      }
      ({ rowCount } = await write(tx));
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }

    if (rowCount === 0) {
      // The terminal guard above rejected the write. Log it — a handler that
      // got this far on a job someone else already reaped is a zombie, and the
      // operator wants to see it.
      diagnosticConsole.warn(
        {
          level: "job_save_rejected_terminal",
          jobId: record.id,
          attemptedStatus: record.status,
        }
      );
      return;
    }

    if (
      record.status === "completed" ||
      record.status === "failed" ||
      record.status === "cancelled"
    ) {
      await this.deleteResolvedMessages(record.id).catch(() => undefined);
    }
  }

  /** Advance only after the reporter durably enqueued or deduplicated the event. */
  async markTerminalReported(jobId: string): Promise<void> {
    await this.pool.query("UPDATE jobs SET terminal_report_enqueued = true WHERE id = $1", [jobId]);
  }

  /** Bounded crash recovery for terminal events not yet queued. */
  async listUnreportedTerminalReports(dvmId: string, capabilities: string[] | null, afterJobId?: string): Promise<JobRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM jobs WHERE dvm_id = $1 AND terminal_report_enqueued = false AND terminal_at_ms IS NOT NULL AND timing_known = true
       AND status IN ('completed', 'failed', 'cancelled')
       AND ($2::text[] IS NULL OR capability = ANY($2))
       AND ($3::text IS NULL OR id > $3) ORDER BY id LIMIT 100`,
      [dvmId, capabilities, afterJobId ?? null]
    );
    return rows.map(rowToRecord);
  }

  /**
   * Read terminal zero-revenue jobs whose latest declared-cost revision has
   * not yet reached the durable reporter outbox. Keep the filter in step with
   * `idx_jobs_unreported_terminal_cost`, which bounds each pass to the backlog.
   * Completed balance-paid work carries cost through revenue even when its
   * allocated rail value is zero; its durable acceptance excludes a cost-only replay.
   */
  async listUnreportedTerminalCosts(args: {
    dvmId: string;
    limit: number;
    afterJobId?: string;
  }): Promise<JobRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT *
       FROM jobs
       WHERE dvm_id = $1
         AND cost_revision IS NOT NULL
         AND (cost_reported_revision IS NULL OR cost_reported_revision < cost_revision)
         AND (
           status IN ('failed', 'cancelled')
           OR (status = 'completed' AND paid_msats = 0 AND NOT EXISTS (
             SELECT 1 FROM credit_balance_payments p WHERE p.job_id=jobs.id
           ))
         )
         AND ($2::text IS NULL OR id > $2)
       ORDER BY id
       LIMIT $3`,
      [args.dvmId, args.afterJobId ?? null, args.limit]
    );
    return rows.map(rowToRecord);
  }

  /** Mark one revision only after its report has reached durable enqueue. */
  async markTerminalCostReported(jobId: string, costRevision: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs
       SET cost_reported_revision = GREATEST(COALESCE(cost_reported_revision, -1), $2)
       WHERE id = $1 AND cost_revision = $2`,
      [jobId, costRevision]
    );
    return rowCount === 1;
  }

  async delete(id: string): Promise<void> {
    if (this.hostingCleanupFence) {
      throw new Error("Hosted job deletion cannot discard obligation evidence");
    }
    await this.pool.query("DELETE FROM jobs WHERE id = $1", [id]);
    await this.deleteResolvedMessages(id).catch(() => undefined);
  }

  async listJobsForRetention(args: {
    lastActivityBeforeMs: number;
    limit: number;
    capabilities: string[] | null;
    after?: JobRetentionCursor;
  }): Promise<JobRecord[]> {
    const after = args.after;
    const capabilityClause = args.capabilities === null ? "" : "AND capability = ANY($5::text[])";
    const params: unknown[] = [
      args.lastActivityBeforeMs,
      args.limit,
      after?.lastActivityAt ?? null,
      after?.id ?? null,
    ];
    if (args.capabilities !== null) params.push(args.capabilities);
    const { rows } = await this.pool.query(
      `SELECT * FROM jobs
        WHERE redacted_at IS NULL
          AND status IN ('completed', 'failed', 'cancelled')
          AND last_activity_at < $1
          AND ($3::bigint IS NULL OR (last_activity_at, id) > ($3::bigint, $4::text))
          ${capabilityClause}
        ORDER BY last_activity_at, id
        LIMIT $2`,
      params
    );
    return rows.map((row) => rowToRecord(row as Record<string, unknown>));
  }

  async redactJob(args: {
    jobId: string;
    expectedLastActivityAt: number;
    redactedAt: number;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Acquire the same fence as hold placement before taking the UPDATE snapshot.
      await client.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [args.jobId]);
      const { rowCount } = await client.query(
        `UPDATE jobs SET
         input = '',
         params = '{}'::jsonb,
         summary = NULL,
         messages = '[]'::jsonb,
         received_proofs = '[]'::jsonb,
         pending_payment_msats = NULL,
         pending_mpp_challenge_ids = NULL,
         pending_x402_nonce = NULL,
         pending_x402_amount_usdc_micro = NULL,
         pending_payment_fiat_micro = NULL,
         pending_payment_fiat_currency = NULL,
         step_cache = '[]'::jsonb,
         state = '{}'::jsonb,
         requester_token = NULL,
         request_fingerprint = NULL,
         auth_request_path = NULL,
         redacted_at = $3
       WHERE id = $1
         AND last_activity_at = $2
         AND redacted_at IS NULL
         AND status IN ('completed', 'failed', 'cancelled')
         AND NOT EXISTS (SELECT 1 FROM job_content_holds h WHERE h.job_id=jobs.id AND h.data->'cleared_at' = 'null'::jsonb)
         AND ($4::boolean = false OR NOT EXISTS (
           SELECT 1 FROM job_messages m WHERE m.job_id=jobs.id
             AND m.data->>'type'='payment'
             AND m.status IN ('pending-verification','failed-verify')))`,
        [args.jobId, args.expectedLastActivityAt, args.redactedAt, !!this.hostingCleanupFence]
      );
      if (rowCount === 1) {
        // Streamed messages and the job snapshot are one retention unit. If
        // this delete fails, rolling the row update back keeps it visible to
        // the next keyset scan instead of permanently stranding caller content.
        await client.query("DELETE FROM job_messages WHERE job_id = $1", [args.jobId]);
      }
      await client.query("COMMIT");
      return rowCount === 1;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getContentSnapshot(jobId: string, dvmId?: string): Promise<{ job: JobRecord; history: ContentHoldHistory } | undefined> {
    const { rows } = await this.pool.query(
      `SELECT j.*, COALESCE((SELECT jsonb_agg(h.data ORDER BY h.data->>'created_at', h.id) FROM job_content_holds h WHERE h.job_id=j.id), '[]'::jsonb) AS content_holds,
       COALESCE((SELECT jsonb_agg(e.data ORDER BY e.event_position) FROM job_content_hold_events e WHERE e.job_id=j.id), '[]'::jsonb) AS content_hold_events
       FROM jobs j WHERE j.id=$1 AND ($2::text IS NULL OR j.dvm_id IS NULL OR j.dvm_id=$2)`, [jobId, dvmId ?? null]
    );
    if (!rows[0]) return undefined;
    return { job: rowToRecord(rows[0]), history: { holds: rows[0].content_holds, events: rows[0].content_hold_events } };
  }

  async mutateContentHold(jobId: string, mutation: ContentHoldMutation, dvmId?: string): Promise<ContentHoldHistory> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT * FROM jobs WHERE id=$1 AND ($2::text IS NULL OR dvm_id IS NULL OR dvm_id=$2) FOR UPDATE", [jobId, dvmId ?? null]);
      if (!rows[0]) throw new ContentHoldError("job_not_found");
      const holds = await client.query("SELECT data FROM job_content_holds WHERE job_id=$1 ORDER BY data->>'created_at', id", [jobId]);
      const events = await client.query("SELECT data FROM job_content_hold_events WHERE job_id=$1 ORDER BY event_position", [jobId]);
      const history = applyContentHoldMutation(rowToRecord(rows[0]), { holds: holds.rows.map((row) => row.data), events: events.rows.map((row) => row.data) }, mutation);
      const event = history.events.at(-1)!;
      const hold = history.holds.find((item) => item.id === event.hold_id)!;
      await client.query(`INSERT INTO job_content_holds(id,job_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`, [hold.id, jobId, JSON.stringify(hold)]);
      // Events are inserted once, never updated by renew or clear.
      await client.query("INSERT INTO job_content_hold_events(id,job_id,data) VALUES($1,$2,$3)", [event.id, jobId, JSON.stringify(event)]);
      await client.query("COMMIT");
      return history;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claimReceiptSeq(jobId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // FOR UPDATE serialises concurrent issuers on the job row, so the
      // counter bump below happens at most once per job however many machines
      // reach the terminal at the same moment.
      const { rows } = await client.query<{ receipt_seq: string | null }>(
        "SELECT receipt_seq FROM jobs WHERE id = $1 FOR UPDATE",
        [jobId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`claimReceiptSeq: job ${jobId} not found`);
      }
      const existing = rows[0].receipt_seq;
      if (existing != null) {
        await client.query("ROLLBACK");
        return Number(existing);
      }
      const { rows: counterRows } = await client.query<{ n: string }>(
        "UPDATE receipt_counter SET n = n + 1 WHERE id = TRUE RETURNING n"
      );
      const seq = Number(counterRows[0].n);
      await client.query("UPDATE jobs SET receipt_seq = $2 WHERE id = $1", [jobId, seq]);
      await client.query("COMMIT");
      return seq;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async saveReceipt(jobId: string, receipt: JobReceipt): Promise<JobReceipt | undefined> {
    const { rows } = await this.pool.query<{ receipt: JobReceipt }>(
      "UPDATE jobs SET receipt = COALESCE(receipt, $2::jsonb) WHERE id = $1 RETURNING receipt",
      [jobId, JSON.stringify(receipt)]
    );
    if (rows.length === 0) return undefined;
    return rows[0].receipt;
  }

  async appendOutgoing(
    jobId: string,
    message: OutgoingMessage,
    opts?: AppendOutgoingOptions
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ seq: number }>(
        `UPDATE jobs SET next_seq = next_seq + 1, last_activity_at = CASE WHEN status IN ('completed','failed','cancelled') THEN last_activity_at ELSE $2 END,
           awaiting_input_at_ms = CASE WHEN $3::boolean AND status NOT IN ('completed', 'failed', 'cancelled')
             THEN COALESCE(awaiting_input_at_ms, $2) ELSE awaiting_input_at_ms END,
           status = CASE WHEN $3::boolean AND status NOT IN ('completed', 'failed', 'cancelled')
             THEN 'awaiting-input' ELSE status END
           WHERE id = $1 AND redacted_at IS NULL
           RETURNING (next_seq - 1) AS seq`,
        [jobId, Date.now(), opts?.awaitingInput ?? false]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`appendOutgoing: job ${jobId} not found`);
      }
      const seq = rows[0].seq;
      const fullMessage = { ...message, seq } as Message;
      await client.query(
        "INSERT INTO job_messages (job_id, seq, data, status) VALUES ($1, $2, $3, 'verified')",
        [jobId, seq, JSON.stringify(fullMessage)]
      );
      if (opts?.pendingPaymentDelta !== undefined) {
        await client.query(
          `UPDATE jobs SET
             pending_payment_msats = COALESCE(pending_payment_msats, 0) + $2,
             pending_mpp_challenge_ids = $3,
             pending_x402_nonce = $4,
             pending_x402_amount_usdc_micro = $5,
             -- accumulate the fiat ask alongside the msat one when the
             -- currency matches what's already outstanding, replace when it
             -- doesn't. A NULL micro clears both — an ask that couldn't be
             -- priced in fiat must not leave a stale figure the top-up would
             -- then fund against.
             pending_payment_fiat_micro = CASE
               WHEN $6::bigint IS NULL THEN NULL
               WHEN pending_payment_fiat_currency IS NOT DISTINCT FROM $7 THEN
                 COALESCE(pending_payment_fiat_micro, 0) + $6
               ELSE $6
             END,
             pending_payment_fiat_currency = CASE WHEN $6::bigint IS NULL THEN NULL ELSE $7 END,
             -- the cumulative ask total, the ceiling on this job's
             -- draw growth. Same accumulate rule as above, minus the reset —
             -- it is monotonic by definition. Mirrors accumulateAskedTopUp
             -- in job-store.ts; edit the two together. -1 is the sticky "can't
             -- bound anything" sentinel: it leaves asks missing from the sum,
             -- so a ceiling built on it would clip a legitimate payment.
             asked_topup_micro = CASE
               WHEN asked_topup_micro = -1 THEN -1
               WHEN $6::bigint IS NULL THEN -1
               WHEN asked_topup_micro IS NULL THEN $6
               WHEN asked_topup_currency IS NOT DISTINCT FROM $7 THEN asked_topup_micro + $6
               ELSE -1
             END,
             -- First-write-wins because this is
             -- the job's own ask denomination, read back by ctx.requestPayment
             -- so every later ask pins in it. The ELSE -1 arm above is the
             -- backstop for a row an older build wrote, not a live path.
             asked_topup_currency = COALESCE(asked_topup_currency, $7),
             -- the sticky reason the ceiling is gone, mirroring the
             -- sentinel's own stickiness through COALESCE. NULL arms mean "no
             -- new poison" — an already-poisoned row keeps its first reason.
             topup_cap_unenforced_reason = COALESCE(topup_cap_unenforced_reason, CASE
               WHEN asked_topup_micro = -1 THEN NULL
               WHEN $6::bigint IS NULL THEN 'ask_unpriceable'
               WHEN asked_topup_micro IS NULL THEN NULL
               WHEN asked_topup_currency IS NOT DISTINCT FROM $7 THEN NULL
               ELSE 'ask_currency_switch'
             END)
           WHERE id = $1`,
          [
            jobId,
            opts.pendingPaymentDelta,
            opts.pendingMppChallengeIds ? JSON.stringify(opts.pendingMppChallengeIds) : null,
            opts.pendingX402Nonce ?? null,
            opts.pendingX402AmountUsdcMicro ?? null,
            opts.pendingPaymentFiatMicro ?? null,
            opts.pendingPaymentFiatCurrency ?? null,
          ]
        );
      }
      await client.query("SELECT pg_notify('job_messages', $1)", [jobId]);
      await client.query("COMMIT");
      return seq;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async recordInbound(jobId: string, message: OutgoingMessage): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (message.type === "payment") await this.hostingCleanupFence?.assertNewIntent(client);
      const { rows } = await client.query<{ seq: number }>(
        `UPDATE jobs SET next_seq = next_seq + 1, last_activity_at = CASE WHEN status IN ('completed','failed','cancelled') THEN last_activity_at ELSE $2 END
           WHERE id = $1 AND redacted_at IS NULL
           RETURNING (next_seq - 1) AS seq`,
        [jobId, Date.now()]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        throw new Error(`recordInbound: job ${jobId} not found`);
      }
      const seq = rows[0].seq;
      const fullMessage = { ...message, seq } as Message;
      await client.query(
        `INSERT INTO job_messages (job_id, seq, data, status, created_at_ms)
         VALUES ($1, $2, $3, 'pending-verification',
           FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)`,
        [jobId, seq, JSON.stringify(fullMessage)]
      );
      await client.query("SELECT pg_notify('job_messages', $1)", [jobId]);
      await client.query("COMMIT");
      return seq;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async verifyAndCredit(
    jobId: string,
    seq: number,
    credit: PaymentCreditDelta | null
  ): Promise<VerifyAndCreditResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        "UPDATE job_messages SET status='verified' WHERE job_id = $1 AND seq = $2 AND status = 'pending-verification'",
        [jobId, seq]
      );
      if (!rowCount) {
        const counters = await this.fetchCountersTx(client, jobId);
        // the binding is read back on this path too. A retry after a
        // lost COMMIT ack lands here, and it is the only way the caller learns
        // whether the attempt it thought had failed actually bound its credit.
        const binding = await this.fetchCreditBindingTx(client, jobId);
        await client.query("COMMIT");
        if (!counters) throw new Error(`verifyAndCredit: job ${jobId} not found`);
        return { counters, alreadyVerified: true, ...binding };
      }

      let counters: JobCounters | undefined;
      let binding: { creditId?: string; drawId?: string } = {};
      if (credit) {
        const sameRail = credit.paymentRail !== undefined && credit.accumulateNative === true;
        const params: unknown[] = [
          jobId,
          credit.paidMsatsDelta,
          credit.clearPending ?? false,
          credit.paymentMint ?? null,
          credit.paymentRail ?? null,
          credit.paymentTxHash ?? null,
          credit.nativeAmount ?? null,
          credit.nativeAsset ?? null,
          credit.cashuFlow ?? null,
          sameRail,
          credit.clearPendingX402Binding ?? false,
          Date.now(),
          credit.creditId ?? null,
          credit.drawId ?? null,
        ];
        const { rows } = await client.query<{
          status: JobStatus;
          paid_msats: string | number;
          pending_payment_msats: string | number | null;
          credit_id: string | null;
          draw_id: string | null;
        }>(
          `UPDATE jobs SET
             paid_msats = paid_msats + $2,
             pending_payment_msats = CASE
               WHEN $3::boolean THEN NULL
               ELSE GREATEST(0, COALESCE(pending_payment_msats, 0) - $2)
             END,
             -- the pinned fiat ask dies with the msat ask it denominates.
             -- Cleared outright rather than decremented: a partially-paid ask keeps
             -- its original fiat envelope so the remainder still funds at the rate
             -- the caller was quoted.
             pending_payment_fiat_micro = CASE
               WHEN $3::boolean OR pending_payment_msats IS NULL OR pending_payment_msats <= $2
                 THEN NULL ELSE pending_payment_fiat_micro END,
             pending_payment_fiat_currency = CASE
               WHEN $3::boolean OR pending_payment_msats IS NULL OR pending_payment_msats <= $2
                 THEN NULL ELSE pending_payment_fiat_currency END,
             -- Set-if-null: a mid-job top-up that minted a fresh implicit credit
             -- binds it here; a job that already has one keeps it, because the
             -- top-up grew that draw rather than opening a second one.
             credit_id = COALESCE(credit_id, $13),
             draw_id = COALESCE(draw_id, $14),
             payment_mint = COALESCE($4, payment_mint),
             payment_rail = COALESCE($5, payment_rail),
             payment_tx_hash = COALESCE($6, payment_tx_hash),
             native_amount = CASE
               WHEN $7::double precision IS NULL THEN native_amount
               WHEN $10::boolean THEN COALESCE(native_amount, 0) + $7
               ELSE $7
             END,
             native_asset = COALESCE($8, native_asset),
             cashu_flow = COALESCE($9, cashu_flow),
             pending_x402_nonce = CASE WHEN $11::boolean THEN NULL ELSE pending_x402_nonce END,
             pending_x402_amount_usdc_micro = CASE WHEN $11::boolean THEN NULL ELSE pending_x402_amount_usdc_micro END,
             last_activity_at = CASE WHEN status IN ('completed','failed','cancelled') THEN last_activity_at ELSE $12 END
           WHERE id = $1
           RETURNING status, paid_msats, pending_payment_msats, credit_id, draw_id`,
          params
        );
        if (rows.length === 0) {
          await client.query("ROLLBACK");
          throw new Error(`verifyAndCredit: job ${jobId} not found`);
        }
        counters = {
          status: rows[0].status,
          paidMsats: Number(rows[0].paid_msats),
          pendingPaymentMsats:
            rows[0].pending_payment_msats == null
              ? undefined
              : Number(rows[0].pending_payment_msats),
        };
        // `RETURNING` is post-COALESCE, so this is the binding the
        // row actually kept — not the one we asked it to take.
        binding = {
          ...(rows[0].credit_id !== null && { creditId: rows[0].credit_id }),
          ...(rows[0].draw_id !== null && { drawId: rows[0].draw_id }),
        };
      } else {
        counters = await this.fetchCountersTx(client, jobId);
        if (!counters) {
          await client.query("ROLLBACK");
          throw new Error(`verifyAndCredit: job ${jobId} not found`);
        }
        binding = await this.fetchCreditBindingTx(client, jobId);
      }

      await client.query("SELECT pg_notify('job_messages', $1)", [jobId]);
      await client.query("COMMIT");
      return { counters, alreadyVerified: false, ...binding };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async getVerifiedInbound(jobId: string, seq: number): Promise<VerifyAndCreditResult | undefined> {
    // One pooled statement, no transaction: this runs when Tx C's COMMITs are
    // failing, so anything needing its own commit would fail alongside them.
    // The JOIN is the whole test — `job_messages.status` only reads `verified`
    // once a Tx C for this seq committed, and a missing row (never recorded, or
    // swept when the job went terminal) is deliberately no answer at all.
    const { rows } = await this.pool.query<
      CountersRow & { credit_id: string | null; draw_id: string | null }
    >(
      `SELECT j.status, j.paid_msats, j.pending_payment_msats, j.summary, j.credit_id, j.draw_id
         FROM jobs j
         JOIN job_messages m ON m.job_id = j.id AND m.seq = $2
        WHERE j.id = $1 AND m.status = 'verified'`,
      [jobId, seq]
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      counters: rowToCounters(row),
      alreadyVerified: true,
      ...(row.credit_id !== null && { creditId: row.credit_id }),
      ...(row.draw_id !== null && { drawId: row.draw_id }),
    };
  }

  async markInboundFailed(jobId: string, seq: number, _reason: string): Promise<void> {
    await this.pool.query(
      "UPDATE job_messages SET status='failed-verify' WHERE job_id = $1 AND seq = $2 AND status = 'pending-verification'",
      [jobId, seq]
    );
  }

  async findStaleJobs(
    processingThresholdMs: number,
    awaitingThresholdMs: number,
    limit: number,
    capabilities: string[] | null
  ): Promise<JobRecord[]> {
    // Two status-aware cutoffs: a tight worker-liveness watchdog for
    // actively-processing rows (the SDK heartbeats live workers, so a frozen
    // last_activity_at means the worker died) and the long caller-input idle
    // timeout for `awaiting-input`. A negative cutoff disables that arm.
    const staleClause = `(
        ((status IN ('processing', 'working')) AND last_activity_at <= $1)
        OR (status = 'awaiting-input' AND last_activity_at <= $2)
      )`;
    const sql =
      capabilities === null
        ? `SELECT * FROM jobs
           WHERE ${staleClause}
           ORDER BY last_activity_at ASC
           LIMIT $3`
        : `SELECT * FROM jobs
           WHERE ${staleClause}
             AND capability = ANY($4::text[])
           ORDER BY last_activity_at ASC
           LIMIT $3`;
    const params: unknown[] =
      capabilities === null
        ? [processingThresholdMs, awaitingThresholdMs, limit]
        : [processingThresholdMs, awaitingThresholdMs, limit, capabilities];
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r) => rowToRecord(r as Record<string, unknown>));
  }

  async heartbeatActiveJobs(jobIds: string[], now: number): Promise<void> {
    if (jobIds.length === 0) return;
    await this.pool.query(
      `UPDATE jobs SET last_activity_at = $1
       WHERE id = ANY($2::text[]) AND status IN ('processing', 'working')`,
      [now, jobIds]
    );
  }

  cancelStaleJob(
    jobId: string,
    expectedActivityBefore: number,
    reason: string,
    terminalStatus: "failed" | "cancelled"
  ): Promise<boolean> {
    return this.terminateJob(jobId, reason, terminalStatus, expectedActivityBefore, null);
  }

  cancelJob(jobId: string, reason: string): Promise<boolean> {
    return this.terminateJob(jobId, reason, "cancelled", null, "caller");
  }

  cancelJobForHosting(jobId: string, reason: string): Promise<boolean> {
    return this.terminateJob(jobId, reason, "cancelled", null, "provider");
  }

  async getCounters(jobId: string): Promise<JobCounters | undefined> {
    const { rows } = await this.pool.query<CountersRow>(
      `SELECT status, paid_msats, pending_payment_msats, summary,
        EXISTS (SELECT 1 FROM credit_balance_payments p WHERE p.job_id=jobs.id
          AND p.request_seq=(SELECT MAX(m.seq) FROM job_messages m WHERE m.job_id=jobs.id
            AND m.data->>'type'='payment-request' AND m.data->>'from'='provider'
            AND m.status='verified')) AS balance_payment_satisfied
       FROM jobs WHERE id = $1`,
      [jobId]
    );
    if (rows.length === 0) return undefined;
    return rowToCounters(rows[0]);
  }

  async claimForProcessing(jobId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status='processing', last_activity_at=$2,
       caller_wait_ms = caller_wait_ms + GREATEST(0, $2 - COALESCE(awaiting_input_at_ms, last_activity_at)),
       awaiting_input_at_ms = NULL WHERE id=$1 AND status='awaiting-input'`,
      [jobId, Date.now()]
    );
    return rowCount === 1;
  }

  async tryReactivationLock<T>(
    jobId: string,
    fn: () => Promise<T>
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ got: boolean }>(
        "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got",
        [jobId]
      );
      if (!rows[0]?.got) {
        await client.query("ROLLBACK");
        return { acquired: false };
      }
      try {
        const result = await fn();
        await client.query("COMMIT");
        return { acquired: true, result };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    } finally {
      client.release();
    }
  }

  async subscribeMessages(
    jobId: string,
    afterSeq: number,
    onMessage: (msg: Message) => void
  ): Promise<() => void> {
    // Register subscriber first (catches notifications arriving during initial fetch)
    const sub: MessageSubscriber = { afterSeq, cb: onMessage };
    let subs = this.messageSubscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      this.messageSubscribers.set(jobId, subs);
    }
    subs.add(sub);

    const existing = await this.getMessages(jobId, afterSeq);
    for (const msg of existing) {
      if (msg.seq > sub.afterSeq) {
        sub.afterSeq = msg.seq;
        onMessage(msg);
      }
    }

    const subSet = subs;
    return () => {
      subSet.delete(sub);
      if (subSet.size === 0) this.messageSubscribers.delete(jobId);
    };
  }

  subscribeNotifications(jobId: string, onNotify: () => void): Promise<() => void> {
    const sub: NotifySubscriber = { cb: onNotify };
    let subs = this.notifySubscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      this.notifySubscribers.set(jobId, subs);
    }
    subs.add(sub);
    const subSet = subs;
    return Promise.resolve(() => {
      subSet.delete(sub);
      if (subSet.size === 0) this.notifySubscribers.delete(jobId);
    });
  }

  async getMessages(jobId: string, afterSeq: number): Promise<Message[]> {
    const { rows } = await this.pool.query<{ data: Message | string }>(
      "SELECT data FROM job_messages WHERE job_id = $1 AND seq > $2 AND status = 'verified' ORDER BY seq",
      [jobId, afterSeq]
    );
    return rows.map((r) => (typeof r.data === "string" ? JSON.parse(r.data) : r.data) as Message);
  }

  async initStreaming(): Promise<void> {
    this.listenChannel = new ListenChannel(this.pool, {
      channel: JOB_MESSAGES_CHANNEL,
      onNotification: (payload) => {
        this.dispatch(payload);
      },
      onLost: (_err) => {
        diagnosticConsole.warn(
          {
            level: "job_messages_listen_lost",
            error: undefined,
          }
        );
      },
      onReconnectFailed: (attempt, _err) => {
        diagnosticConsole.warn(
          {
            level: "job_messages_listen_connect_failed",
            attempt,
            error: undefined,
          }
        );
      },
    });
    await this.listenChannel.start();
  }

  async shutdownStreaming(): Promise<void> {
    if (this.listenChannel) {
      await this.listenChannel.stop();
      this.listenChannel = null;
    }
    this.messageSubscribers.clear();
    this.notifySubscribers.clear();
  }

  private dispatch(jobId: string | undefined): void {
    if (!jobId) return;

    const notifySubs = this.notifySubscribers.get(jobId);
    if (notifySubs) {
      for (const sub of notifySubs) sub.cb();
    }

    const subs = this.messageSubscribers.get(jobId);
    if (!subs || subs.size === 0) return;

    const minSeq = Math.min(...[...subs].map((s) => s.afterSeq));
    this.getMessages(jobId, minSeq)
      .then((msgs) => {
        for (const sub of subs) {
          for (const msg of msgs) {
            if (msg.seq > sub.afterSeq) {
              sub.afterSeq = msg.seq;
              sub.cb(msg);
            }
          }
        }
      })
      .catch(() => undefined);
  }

  /**
   * Drive a non-terminal job to `terminalStatus` and append its final `cancel`
   * message in one transaction. Backs both `cancelStaleJob` (which passes an
   * `expectedActivityBefore` cutoff, so the flip only lands while the row is
   * still stale — a live worker that heartbeats in between keeps its job) and
   * `cancelJob` (which passes `null`: an operator/caller cancel is
   * unconditional, gated only on the row still being non-terminal).
   *
   * The `SELECT … FOR UPDATE` makes the whole thing a CAS: two machines racing
   * to terminate the same job serialise on the row lock, and the loser's
   * status filter no longer matches. `pg_notify` fires inside the tx so the
   * machine running the handler wakes as soon as the terminal status is
   * visible.
   */
  private async terminateJob(
    jobId: string,
    reason: string,
    terminalStatus: "failed" | "cancelled",
    expectedActivityBefore: number | null,
    endedBy: "caller" | "provider" | null
  ): Promise<boolean> {
    const staleOnly = expectedActivityBefore !== null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<Record<string, unknown> & { next_seq: number }>(
        `SELECT * FROM jobs
         WHERE id = $1
           AND status IN ('processing', 'working', 'awaiting-input')
           ${staleOnly ? "AND last_activity_at <= $2" : ""}
         FOR UPDATE`,
        staleOnly ? [jobId, expectedActivityBefore] : [jobId]
      );
      if (rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      let terminalMessages: Message[] | undefined;
      if (staleOnly) {
        const record = rowToRecord(rows[0]);
        const { rows: messages } = await client.query<{ data: Message }>(
          "SELECT data FROM job_messages WHERE job_id=$1 AND status='verified' ORDER BY seq", [jobId]);
        const history = messages.length ? messages.map((row) => row.data) : record.messages;
        terminalMessages = history;
        const deadline = callerDeadline({ ...record, messages: history });
        const awaiting = deadline !== undefined || (record.status === "awaiting-input" && !hasCallerDeadline(history));
        if ((terminalStatus === "cancelled") !== awaiting || (deadline !== undefined && Date.now() < deadline)) {
          await client.query("ROLLBACK");
          return false;
        }
      }
      const nextSeq = rows[0].next_seq;
      const now = Date.now();
      const cancelMsg: Message = {
        seq: nextSeq,
        from: "provider",
        timestamp: Math.floor(now / 1000),
        type: "cancel",
        content: { reason },
      } as Message;
      // Insert the cancel row into `job_messages` *inside* the transaction so
      // any cross-machine SSE subscriber whose NOTIFY-driven `getMessages` runs
      // after COMMIT picks up the cancel via the live stream — mirrors the
      // normal `appendOutgoing` → `save` ordering. The terminal-cleanup
      // DELETE happens post-commit below, matching `save`'s best-effort pattern.
      await client.query(
        "INSERT INTO job_messages (job_id, seq, data, status) VALUES ($1, $2, $3, 'verified')",
        [jobId, nextSeq, JSON.stringify(cancelMsg)]
      );
      // The row is held by the `FOR UPDATE` above, so the id alone identifies
      // it — the status/activity predicates were already evaluated there.
      await client.query(
        `UPDATE jobs SET
           ended_by = COALESCE($7::text, CASE WHEN status = 'awaiting-input' THEN 'caller' ELSE 'provider' END),
           terminal_at_ms = $5,
           caller_wait_ms = caller_wait_ms + CASE WHEN status = 'awaiting-input'
             THEN GREATEST(0, $5 - COALESCE(awaiting_input_at_ms, last_activity_at)) ELSE 0 END,
           awaiting_input_at_ms = NULL,
           status = $6,
           summary = COALESCE(summary, $2),
           messages = ${staleOnly ? "$3::jsonb" : "COALESCE(messages, '[]'::jsonb) || $3::jsonb"},
           seq = $4,
           next_seq = $4 + 1,
           last_activity_at = $5
         WHERE id = $1`,
        [jobId, reason, JSON.stringify([...(terminalMessages ?? []), cancelMsg]), nextSeq, now, terminalStatus,
          staleOnly ? (terminalStatus === "cancelled" ? "caller" : "provider") : endedBy]
      );
      await client.query("SELECT pg_notify('job_messages', $1)", [jobId]);
      await client.query("COMMIT");
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
      }
      throw err;
    } finally {
      client.release();
    }
    // Post-commit cleanup of incremental rows, mirroring `save`'s pattern.
    // Best-effort: the snapshot's `messages` array is already the source of
    // truth at terminal, so a transient cleanup failure is recoverable.
    await this.deleteResolvedMessages(jobId).catch(() => undefined);
    return true;
  }

  private async deleteResolvedMessages(jobId: string): Promise<void> {
    // An HTTP payment admitted before the terminal snapshot may still be
    // committing its accounting. Keep its CAS row until verification resolves;
    // hosted cleanup also needs failed payment evidence for reconciliation.
    await this.pool.query(
      `DELETE FROM job_messages WHERE job_id=$1 AND NOT (
         data->>'type'='payment' AND (status='pending-verification'
           OR ($2::boolean AND status='failed-verify')))`,
      [jobId, !!this.hostingCleanupFence]
    );
  }

  private async fetchCountersTx(
    client: PoolClient,
    jobId: string
  ): Promise<JobCounters | undefined> {
    const { rows } = await client.query<CountersRow>(
      "SELECT status, paid_msats, pending_payment_msats, summary FROM jobs WHERE id = $1",
      [jobId]
    );
    if (rows.length === 0) return undefined;
    return rowToCounters(rows[0]);
  }

  /**
   * The credit binding on the job row, read inside Tx C. Used on the
   * paths that don't get it from a `RETURNING` — the `alreadyVerified` skip and
   * a non-payment inbound.
   */
  private async fetchCreditBindingTx(
    client: PoolClient,
    jobId: string
  ): Promise<{ creditId?: string; drawId?: string }> {
    const { rows } = await client.query<{ credit_id: string | null; draw_id: string | null }>(
      "SELECT credit_id, draw_id FROM jobs WHERE id = $1",
      [jobId]
    );
    if (rows.length === 0) return {};
    const row = rows[0];
    return {
      ...(row.credit_id !== null && { creditId: row.credit_id }),
      ...(row.draw_id !== null && { drawId: row.draw_id }),
    };
  }
}

function requestIdAdvisoryLockKey(requesterPubkey: string, requestId: string): string {
  return createHash("sha256")
    .update(requesterPubkey, "utf8")
    .update("\0", "utf8")
    .update(requestId, "utf8")
    .digest()
    .readBigInt64BE(0)
    .toString();
}

interface CountersRow {
  status: JobStatus;
  paid_msats: string | number;
  pending_payment_msats: string | number | null;
  summary: string | null;
  balance_payment_satisfied?: boolean;
}

function rowToCounters(row: CountersRow): JobCounters {
  return {
    status: row.status,
    ...(row.balance_payment_satisfied && { balancePaymentSatisfied: true }),
    paidMsats: Number(row.paid_msats),
    pendingPaymentMsats:
      row.pending_payment_msats == null ? undefined : Number(row.pending_payment_msats),
    summary: row.summary ?? undefined,
  };
}

function rowToRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: row.id as string,
    tags: row.tags as string[],
    // Earlier rows persisted before this migration shipped may carry NULL
    // here. Fall back to "" so reactivation lookups surface a clear
    // "unknown capability" error rather than crashing on a typed read.
    capability: (row.capability ?? "") as string,
    input: row.input as string,
    params: row.params as Record<string, string>,
    requesterId: row.requester_id as string,
    requesterTokenHash: (row.requester_token_hash ?? undefined) as string | undefined,
    requesterToken: (row.requester_token ?? undefined) as string | undefined,
    requestFingerprint: (row.request_fingerprint ?? undefined) as string | undefined,
    requesterPubkey: (row.requester_pubkey ?? undefined) as string | undefined,
    requestId: (row.request_id ?? undefined) as string | undefined,
    authRequestPath: (row.auth_request_path ?? undefined) as string | undefined,
    status: row.status as JobRecord["status"],
    timingKnown: row.timing_known === true,
    endedBy: (row.ended_by ?? undefined) as JobRecord["endedBy"],
    terminalAtMs: row.terminal_at_ms == null ? undefined : Number(row.terminal_at_ms),
    callerWaitMs: Number(row.caller_wait_ms ?? 0),
    awaitingInputAtMs: row.awaiting_input_at_ms == null ? undefined : Number(row.awaiting_input_at_ms),
    summary: row.summary as string | undefined,
    messages: row.messages as JobRecord["messages"],
    seq: row.seq as number,
    paidMsats: Number(row.paid_msats),
    paymentMint: row.payment_mint as string | undefined,
    paymentRail: (row.payment_rail ?? undefined) as JobRecord["paymentRail"],
    paymentTxHash: row.payment_tx_hash as string | undefined,
    paymentTransactionHash: (row.payment_transaction_hash ?? undefined) as string | undefined,
    nativeAmount: row.native_amount as number | undefined,
    nativeAsset: row.native_asset as JobRecord["nativeAsset"],
    cashuFlow: row.cashu_flow as JobRecord["cashuFlow"],
    costAmountMicro:
      row.cost_amount_micro == null ? undefined : Number(row.cost_amount_micro),
    costCurrency: (row.cost_currency ?? undefined) as string | undefined,
    costRevision: row.cost_revision == null ? undefined : Number(row.cost_revision),
    creditId: (row.credit_id ?? undefined) as string | undefined,
    drawId: (row.draw_id ?? undefined) as string | undefined,
    fundingReceipt: (row.funding_receipt ?? undefined) as JobRecord["fundingReceipt"],
    fundingCredit: (row.funding_credit ?? undefined) as JobRecord["fundingCredit"],
    receivedProofs: row.received_proofs as JobRecord["receivedProofs"],
    pendingPaymentMsats:
      row.pending_payment_msats == null ? undefined : Number(row.pending_payment_msats),
    pendingMppChallengeIds: (row.pending_mpp_challenge_ids ?? undefined) as string[] | undefined,
    pendingX402Nonce: (row.pending_x402_nonce ?? undefined) as string | undefined,
    pendingX402AmountUsdcMicro: (row.pending_x402_amount_usdc_micro ?? undefined) as
      | string
      | undefined,
    pendingPaymentFiatMicro:
      row.pending_payment_fiat_micro == null ? undefined : Number(row.pending_payment_fiat_micro),
    pendingPaymentFiatCurrency: (row.pending_payment_fiat_currency ?? undefined) as
      | string
      | undefined,
    askedTopUpMicro: row.asked_topup_micro == null ? undefined : Number(row.asked_topup_micro),
    askedTopUpCurrency: (row.asked_topup_currency ?? undefined) as string | undefined,
    topUpCapUnenforcedReason: (row.topup_cap_unenforced_reason ??
      undefined) as JobRecord["topUpCapUnenforcedReason"],
    requiredMsats: row.required_msats == null ? undefined : Number(row.required_msats),
    receipt: (row.receipt ?? undefined) as JobRecord["receipt"],
    stepCache: row.step_cache as JobRecord["stepCache"],
    state: row.state,
    createdAt: Number(row.created_at),
    lastActivityAt: Number(row.last_activity_at),
    redactedAt: row.redacted_at == null ? undefined : Number(row.redacted_at),
  };
}

function isTerminalStatus(status: JobStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
