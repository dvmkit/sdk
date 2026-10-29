import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { canonicalize, type JsonValue } from "../../lib/cast-auth/canonical-json";
import type { CreditEnvelope } from "./credit-envelope";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence } from "./hosting-cleanup-fence";
import type { ProcessedPaymentQuerier } from "./processed-payment-store";

export type X402ExactSettlementStatus =
  | "prepared"
  | "submitting"
  | "settled"
  | "local_committed"
  | "ambiguous"
  | "rejected"
  | "released"
  | "complete";

/** Serializable local economic effect that follows an exact settlement. */
export interface X402ExactSettlementEffect {
  priceFiat: { currency: string; amountMicro: number };
  requiredMsats: number;
  callerId: string;
  dvmId: string;
  jobId?: string;
  hostingAdmissionId?: string;
  hostingPaymentSeq?: number;
  /** Upfront job request bound to this payment; omitted for credit-only and mid-job effects. */
  jobAdmission?: { requestFingerprint: string; authFingerprint?: string };
  creditEnvelope?: CreditEnvelope;
  fundOnly?: {
    creditId: string;
    fundId: string;
    commitment: string;
    allowOneShotStablecoin?: boolean;
  };
  topUp?: { creditId: string; drawId: string };
  topUpCapMicro?: number;
  askSatisfied?: true;
  midJob?: true;
  drawBasis: boolean;
  ttlMs: number;
  paidMsats: number;
  fundedMicro: number;
  nativeAmount: number;
}

/** Canonical authorization facts retained without the bearer signature. */
export interface X402ExactAuthorizationFacts {
  network: string;
  asset: string;
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  fingerprint: string;
}

export interface X402ExactSettlementIntent extends X402ExactAuthorizationFacts {
  id: string;
  dvmId: string;
  resource: string;
  status: X402ExactSettlementStatus;
  effect?: X402ExactSettlementEffect;
  submissionBlock?: string;
  transaction?: string;
  settleResponse?: Record<string, unknown>;
  lastOutcome?: string;
  createdAt: number;
  updatedAt: number;
  resolvedAt?: number;
}

/** Evidence recorded around one facilitator settlement call. */
export interface X402ExactSettlementAttempt {
  id: string;
  intentId: string;
  outcome: "submitting" | "success" | "rejected" | "timeout" | "missing_reference";
  detail?: string;
  transaction?: string;
  createdAt: number;
}

/** Persistence contract for exact x402 settlement recovery. */
export interface X402ExactSettlementStore {
  prepare(
    intent: Omit<X402ExactSettlementIntent, "status" | "createdAt" | "updatedAt" | "resolvedAt">
  ): Promise<X402ExactSettlementIntent>;
  get(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent | undefined>;
  markSubmitting(args: {
    dvmId: string;
    intentId: string;
    submissionBlock?: string;
  }): Promise<boolean>;
  recordOutcome(args: {
    dvmId: string;
    intentId: string;
    status: Extract<X402ExactSettlementStatus, "settled" | "ambiguous" | "rejected">;
    outcome: X402ExactSettlementAttempt["outcome"];
    detail?: string;
    transaction?: string;
    settleResponse?: Record<string, unknown>;
  }): Promise<X402ExactSettlementIntent>;
  finalize<T>(
    dvmId: string,
    intentId: string,
    fn: (intent: X402ExactSettlementIntent, tx?: ProcessedPaymentQuerier) => Promise<T>
  ): Promise<{ intent: X402ExactSettlementIntent; value?: T; replayed: boolean }>;
  /**
   * Retire a `prepared` intent whose work did not succeed so it is never sent
   * for settlement. Returns false for any other status, which keeps a
   * submitted or settled authorization from being disowned.
   */
  release(args: { dvmId: string; intentId: string; reason: string }): Promise<boolean>;
  markAdmissionComplete(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent>;
  list(args: {
    dvmId: string;
    limit: number;
    includeResolved?: boolean;
  }): Promise<X402ExactSettlementIntent[]>;
  attempts(dvmId: string, intentId: string): Promise<X402ExactSettlementAttempt[]>;
}

export class PostgresX402ExactSettlementStore implements X402ExactSettlementStore {
  private hostingCleanupFence?: HostingCleanupFence;

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_exact_settlement_intents (
          dvm_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          network TEXT NOT NULL,
          asset TEXT NOT NULL,
          authorizer TEXT NOT NULL,
          recipient TEXT NOT NULL,
          value TEXT NOT NULL,
          valid_after TEXT NOT NULL,
          valid_before TEXT NOT NULL,
          nonce TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          status TEXT NOT NULL,
          effect JSONB,
          submission_block TEXT,
          transaction TEXT,
          settle_response JSONB,
          last_outcome TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          resolved_at BIGINT,
          PRIMARY KEY (dvm_id, intent_id)
        )
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_exact_settlement_attempts (
          id TEXT PRIMARY KEY,
          dvm_id TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          outcome TEXT NOT NULL,
          detail TEXT,
          transaction TEXT,
          created_at BIGINT NOT NULL
        )
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_exact_job_auth_bindings (
          dvm_id TEXT NOT NULL,
          auth_fingerprint TEXT NOT NULL,
          intent_id TEXT NOT NULL,
          PRIMARY KEY (dvm_id, auth_fingerprint)
        )
      `);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_x402_exact_settlement_queue
           ON x402_exact_settlement_intents (dvm_id, status, updated_at)`
      );
    });
  }

  async prepare(
    intent: Omit<X402ExactSettlementIntent, "status" | "createdAt" | "updatedAt" | "resolvedAt">
  ): Promise<X402ExactSettlementIntent> {
    const now = Date.now();
    const existing = await this.get(intent.dvmId, intent.id);
    if (existing && !sameIntentBinding(existing, intent)) {
      throw new X402ExactIntentConflictError(intent.id);
    }
    const write = async (q: Pick<Pool, "query">): Promise<void> => {
      const authFingerprint = intent.effect?.jobAdmission?.authFingerprint;
      if (authFingerprint) {
      await q.query(
        `INSERT INTO x402_exact_job_auth_bindings (dvm_id, auth_fingerprint, intent_id)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [intent.dvmId, authFingerprint, intent.id]
      );
      const { rows } = await q.query<{ intent_id: string }>(
        `SELECT intent_id FROM x402_exact_job_auth_bindings
          WHERE dvm_id = $1 AND auth_fingerprint = $2`,
        [intent.dvmId, authFingerprint]
      );
      if (rows[0]?.intent_id !== intent.id) throw new X402ExactIntentConflictError(intent.id);
      }
      if (existing) return;
      await q.query(
      `INSERT INTO x402_exact_settlement_intents
         (dvm_id, intent_id, resource, network, asset, authorizer, recipient, value,
          valid_after, valid_before, nonce, fingerprint, status, effect, submission_block,
          transaction, settle_response, last_outcome, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'prepared',$13,$14,$15,$16,$17,$18,$18)
       ON CONFLICT (dvm_id, intent_id) DO NOTHING`,
      [
        intent.dvmId,
        intent.id,
        intent.resource,
        intent.network,
        intent.asset,
        intent.from,
        intent.to,
        intent.value,
        intent.validAfter,
        intent.validBefore,
        intent.nonce,
        intent.fingerprint,
        intent.effect ? JSON.stringify(intent.effect) : null,
        intent.submissionBlock ?? null,
        intent.transaction ?? null,
        intent.settleResponse ? JSON.stringify(intent.settleResponse) : null,
        intent.lastOutcome ?? null,
        now,
      ]
      );
    };
    if (this.hostingCleanupFence && !existing) {
      const effect = intent.effect;
      await this.hostingCleanupFence.withNewIntent({
        admissionId: effect?.hostingAdmissionId,
        jobId: effect?.jobId,
        paymentSeq: effect?.hostingPaymentSeq,
        creditId: effect?.jobId ? undefined : effect?.fundOnly?.creditId,
        fundId: effect?.fundOnly?.fundId,
        callerPubkey: effect?.jobId ? undefined : effect?.callerId,
      }, write);
    } else {
      await write(this.pool);
    }
    if (existing) return existing;
    const stored = await this.get(intent.dvmId, intent.id);
    if (!stored) throw new Error(`x402 exact intent ${intent.id} was not persisted`);
    if (!sameIntentBinding(stored, intent)) {
      throw new X402ExactIntentConflictError(intent.id);
    }
    return stored;
  }

  async get(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent | undefined> {
    const { rows } = await this.pool.query<X402ExactIntentRow>(
      `SELECT * FROM x402_exact_settlement_intents WHERE dvm_id = $1 AND intent_id = $2`,
      [dvmId, intentId]
    );
    return rows[0] ? rowToIntent(rows[0]) : undefined;
  }

  async markSubmitting(args: {
    dvmId: string;
    intentId: string;
    submissionBlock?: string;
  }): Promise<boolean> {
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        `UPDATE x402_exact_settlement_intents
            SET status = 'submitting', submission_block = COALESCE(submission_block, $3),
                last_outcome = 'submitting', updated_at = $4
          WHERE dvm_id = $1 AND intent_id = $2
            AND status IN ('prepared', 'submitting', 'ambiguous')`,
        [args.dvmId, args.intentId, args.submissionBlock ?? null, now]
      );
      if (rowCount === 1) {
        await this.insertAttempt(
          client,
          args.dvmId,
          args.intentId,
          "submitting",
          undefined,
          undefined,
          now
        );
      }
      await client.query("COMMIT");
      return rowCount === 1;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async recordOutcome(args: {
    dvmId: string;
    intentId: string;
    status: Extract<X402ExactSettlementStatus, "settled" | "ambiguous" | "rejected">;
    outcome: X402ExactSettlementAttempt["outcome"];
    detail?: string;
    transaction?: string;
    settleResponse?: Record<string, unknown>;
  }): Promise<X402ExactSettlementIntent> {
    const now = Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<X402ExactIntentRow>(
        `UPDATE x402_exact_settlement_intents
            SET status = $3, last_outcome = $4,
                transaction = COALESCE($5, transaction),
                settle_response = COALESCE($6, settle_response), updated_at = $7
          WHERE dvm_id = $1 AND intent_id = $2
            AND status NOT IN ('complete', 'local_committed')
            AND (status <> 'settled' OR $3 = 'settled')
          RETURNING *`,
        [
          args.dvmId,
          args.intentId,
          args.status,
          args.outcome,
          args.transaction ?? null,
          args.settleResponse ? JSON.stringify(args.settleResponse) : null,
          now,
        ]
      );
      const current =
        rows.at(0) ??
        (
          await client.query<X402ExactIntentRow>(
            `SELECT * FROM x402_exact_settlement_intents
              WHERE dvm_id = $1 AND intent_id = $2 FOR UPDATE`,
            [args.dvmId, args.intentId]
          )
        ).rows.at(0);
      if (!current) throw new Error(`x402 exact intent ${args.intentId} disappeared`);
      await this.insertAttempt(
        client,
        args.dvmId,
        args.intentId,
        args.outcome,
        args.detail,
        args.transaction,
        now
      );
      await client.query("COMMIT");
      return rowToIntent(current);
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async finalize<T>(
    dvmId: string,
    intentId: string,
    fn: (intent: X402ExactSettlementIntent, tx?: ProcessedPaymentQuerier) => Promise<T>
  ): Promise<{ intent: X402ExactSettlementIntent; value?: T; replayed: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<X402ExactIntentRow>(
        `SELECT * FROM x402_exact_settlement_intents
          WHERE dvm_id = $1 AND intent_id = $2 FOR UPDATE`,
        [dvmId, intentId]
      );
      if (!rows[0]) throw new Error(`x402 exact intent ${intentId} was not found`);
      const intent = rowToIntent(rows[0]);
      if (intent.status === "complete" || intent.status === "local_committed") {
        await client.query("COMMIT");
        return { intent, replayed: true };
      }
      if (intent.status !== "settled" || !intent.transaction) {
        throw new X402ExactSettlementNotReadyError(intentId, intent.status);
      }
      const value = await fn(intent, client);
      const now = Date.now();
      const status = intent.effect?.jobAdmission ? "local_committed" : "complete";
      await client.query(
        `UPDATE x402_exact_settlement_intents
            SET status = $3,
                resolved_at = CASE WHEN $3 = 'complete' THEN $4::bigint ELSE NULL::bigint END,
                updated_at = $4::bigint
          WHERE dvm_id = $1 AND intent_id = $2`,
        [dvmId, intentId, status, now]
      );
      await client.query("COMMIT");
      return {
        intent: {
          ...intent,
          status,
          resolvedAt: status === "complete" ? now : undefined,
          updatedAt: now,
        },
        value,
        replayed: false,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async release(args: { dvmId: string; intentId: string; reason: string }): Promise<boolean> {
    const now = Date.now();
    const { rowCount } = await this.pool.query(
      `UPDATE x402_exact_settlement_intents
          SET status = 'released', last_outcome = $3, resolved_at = $4, updated_at = $4
        WHERE dvm_id = $1 AND intent_id = $2 AND status = 'prepared'`,
      [args.dvmId, args.intentId, args.reason, now]
    );
    return rowCount === 1;
  }

  async markAdmissionComplete(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent> {
    const now = Date.now();
    const { rows } = await this.pool.query<X402ExactIntentRow>(
      `UPDATE x402_exact_settlement_intents
          SET status = 'complete', resolved_at = $3, updated_at = $3
        WHERE dvm_id = $1 AND intent_id = $2 AND status = 'local_committed'
      RETURNING *`,
      [dvmId, intentId, now]
    );
    const intent = rows[0] ? rowToIntent(rows[0]) : await this.get(dvmId, intentId);
    if (!intent) throw new Error(`x402 exact intent ${intentId} was not found`);
    if (intent.status !== "complete") {
      throw new X402ExactSettlementNotReadyError(intentId, intent.status);
    }
    return intent;
  }

  async list(args: {
    dvmId: string;
    limit: number;
    includeResolved?: boolean;
  }): Promise<X402ExactSettlementIntent[]> {
    const { rows } = await this.pool.query<X402ExactIntentRow>(
      `SELECT * FROM x402_exact_settlement_intents
        WHERE dvm_id = $1 ${args.includeResolved ? "" : "AND status NOT IN ('complete', 'rejected', 'released')"}
        ORDER BY updated_at ASC LIMIT $2`,
      [args.dvmId, args.limit]
    );
    return rows.map(rowToIntent);
  }

  async attempts(dvmId: string, intentId: string): Promise<X402ExactSettlementAttempt[]> {
    const { rows } = await this.pool.query<X402ExactAttemptRow>(
      `SELECT * FROM x402_exact_settlement_attempts
        WHERE dvm_id = $1 AND intent_id = $2 ORDER BY created_at, id`,
      [dvmId, intentId]
    );
    return rows.map(rowToAttempt);
  }

  private async insertAttempt(
    q: ProcessedPaymentQuerier,
    dvmId: string,
    intentId: string,
    outcome: X402ExactSettlementAttempt["outcome"],
    detail: string | undefined,
    transaction: string | undefined,
    createdAt: number
  ): Promise<void> {
    await q.query(
      `INSERT INTO x402_exact_settlement_attempts
         (id, dvm_id, intent_id, outcome, detail, transaction, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), dvmId, intentId, outcome, detail ?? null, transaction ?? null, createdAt]
    );
  }
}

/** In-memory exact settlement store used by dev and unit tests. */
export class MemoryX402ExactSettlementStore implements X402ExactSettlementStore {
  private readonly intents = new Map<string, X402ExactSettlementIntent>();
  private readonly evidence = new Map<string, X402ExactSettlementAttempt[]>();
  private readonly authBindings = new Map<string, string>();
  private readonly locks = new Map<string, Promise<void>>();

  prepare(
    intent: Omit<X402ExactSettlementIntent, "status" | "createdAt" | "updatedAt" | "resolvedAt">
  ): Promise<X402ExactSettlementIntent> {
    const key = intentKey(intent.dvmId, intent.id);
    const existing = this.intents.get(key);
    if (existing && !sameIntentBinding(existing, intent)) {
      throw new X402ExactIntentConflictError(intent.id);
    }
    const authFingerprint = intent.effect?.jobAdmission?.authFingerprint;
    if (authFingerprint) {
      const bindingKey = intentKey(intent.dvmId, authFingerprint);
      const owner = this.authBindings.get(bindingKey);
      if (owner !== undefined && owner !== intent.id) {
        throw new X402ExactIntentConflictError(intent.id);
      }
      this.authBindings.set(bindingKey, intent.id);
    }
    if (existing) return Promise.resolve(existing);
    const now = Date.now();
    const stored: X402ExactSettlementIntent = {
      ...intent,
      status: "prepared",
      createdAt: now,
      updatedAt: now,
    };
    this.intents.set(key, stored);
    return Promise.resolve(stored);
  }

  get(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent | undefined> {
    return Promise.resolve(this.intents.get(intentKey(dvmId, intentId)));
  }

  markSubmitting(args: {
    dvmId: string;
    intentId: string;
    submissionBlock?: string;
  }): Promise<boolean> {
    const key = intentKey(args.dvmId, args.intentId);
    const intent = this.intents.get(key);
    if (
      intent?.status !== "prepared" &&
      intent?.status !== "submitting" &&
      intent?.status !== "ambiguous"
    ) {
      return Promise.resolve(false);
    }
    const updated = {
      ...intent,
      status: "submitting" as const,
      submissionBlock: intent.submissionBlock ?? args.submissionBlock,
      lastOutcome: "submitting",
      updatedAt: Date.now(),
    };
    this.intents.set(key, updated);
    this.addAttempt(args.dvmId, args.intentId, "submitting");
    return Promise.resolve(true);
  }

  recordOutcome(args: {
    dvmId: string;
    intentId: string;
    status: Extract<X402ExactSettlementStatus, "settled" | "ambiguous" | "rejected">;
    outcome: X402ExactSettlementAttempt["outcome"];
    detail?: string;
    transaction?: string;
    settleResponse?: Record<string, unknown>;
  }): Promise<X402ExactSettlementIntent> {
    const key = intentKey(args.dvmId, args.intentId);
    const intent = this.intents.get(key);
    if (!intent) throw new Error(`x402 exact intent ${args.intentId} was not found`);
    const updateState =
      intent.status !== "complete" &&
      intent.status !== "local_committed" &&
      (intent.status !== "settled" || args.status === "settled");
    const updated: X402ExactSettlementIntent = updateState
      ? {
          ...intent,
          status: args.status,
          lastOutcome: args.outcome,
          transaction: args.transaction ?? intent.transaction,
          settleResponse: args.settleResponse ?? intent.settleResponse,
          updatedAt: Date.now(),
        }
      : intent;
    if (updateState) this.intents.set(key, updated);
    this.addAttempt(args.dvmId, args.intentId, args.outcome, args.detail, args.transaction);
    return Promise.resolve(updated);
  }

  async finalize<T>(
    dvmId: string,
    intentId: string,
    fn: (intent: X402ExactSettlementIntent, tx?: ProcessedPaymentQuerier) => Promise<T>
  ): Promise<{ intent: X402ExactSettlementIntent; value?: T; replayed: boolean }> {
    return this.withLock(intentKey(dvmId, intentId), async () => {
      const key = intentKey(dvmId, intentId);
      const intent = this.intents.get(key);
      if (!intent) throw new Error(`x402 exact intent ${intentId} was not found`);
      if (intent.status === "complete" || intent.status === "local_committed") {
        return { intent, replayed: true };
      }
      if (intent.status !== "settled" || !intent.transaction) {
        throw new X402ExactSettlementNotReadyError(intentId, intent.status);
      }
      const value = await fn(intent, undefined);
      const now = Date.now();
      const status = intent.effect?.jobAdmission ? "local_committed" : "complete";
      const committed: X402ExactSettlementIntent = {
        ...intent,
        status,
        resolvedAt: status === "complete" ? now : undefined,
        updatedAt: now,
      };
      this.intents.set(key, committed);
      return { intent: committed, value, replayed: false };
    });
  }

  release(args: { dvmId: string; intentId: string; reason: string }): Promise<boolean> {
    const key = intentKey(args.dvmId, args.intentId);
    const intent = this.intents.get(key);
    if (intent?.status !== "prepared") return Promise.resolve(false);
    const now = Date.now();
    this.intents.set(key, {
      ...intent,
      status: "released",
      lastOutcome: args.reason,
      resolvedAt: now,
      updatedAt: now,
    });
    return Promise.resolve(true);
  }

  markAdmissionComplete(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent> {
    const key = intentKey(dvmId, intentId);
    const intent = this.intents.get(key);
    if (!intent) throw new Error(`x402 exact intent ${intentId} was not found`);
    if (intent.status === "complete") return Promise.resolve(intent);
    if (intent.status !== "local_committed") {
      throw new X402ExactSettlementNotReadyError(intentId, intent.status);
    }
    const now = Date.now();
    const complete: X402ExactSettlementIntent = {
      ...intent,
      status: "complete",
      resolvedAt: now,
      updatedAt: now,
    };
    this.intents.set(key, complete);
    return Promise.resolve(complete);
  }

  list(args: {
    dvmId: string;
    limit: number;
    includeResolved?: boolean;
  }): Promise<X402ExactSettlementIntent[]> {
    return Promise.resolve(
      [...this.intents.values()]
        .filter(
          (intent) =>
            intent.dvmId === args.dvmId &&
            ((args.includeResolved ?? false) ||
              (intent.status !== "complete" &&
                intent.status !== "rejected" &&
                intent.status !== "released"))
        )
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, args.limit)
    );
  }

  attempts(dvmId: string, intentId: string): Promise<X402ExactSettlementAttempt[]> {
    return Promise.resolve(this.evidence.get(intentKey(dvmId, intentId)) ?? []);
  }

  private addAttempt(
    dvmId: string,
    intentId: string,
    outcome: X402ExactSettlementAttempt["outcome"],
    detail?: string,
    transaction?: string
  ): void {
    const key = intentKey(dvmId, intentId);
    const attempts = this.evidence.get(key) ?? [];
    attempts.push({
      id: randomUUID(),
      intentId,
      outcome,
      detail,
      transaction,
      createdAt: Date.now(),
    });
    this.evidence.set(key, attempts);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    this.locks.set(key, queued);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }
}

/** Raised when the same on-chain authorization is presented for a different local effect. */
export class X402ExactIntentConflictError extends Error {
  constructor(readonly intentId: string) {
    super(`x402 exact intent ${intentId} conflicts with its durable authorization or effect`);
    this.name = "X402ExactIntentConflictError";
  }
}

/** Raised when local finalization is attempted before settlement is evidenced. */
export class X402ExactSettlementNotReadyError extends Error {
  constructor(
    readonly intentId: string,
    readonly status: X402ExactSettlementStatus
  ) {
    super(`x402 exact intent ${intentId} is ${status}, not settled`);
    this.name = "X402ExactSettlementNotReadyError";
  }
}

interface X402ExactIntentRow {
  dvm_id: string;
  intent_id: string;
  resource: string;
  network: string;
  asset: string;
  authorizer: string;
  recipient: string;
  value: string;
  valid_after: string;
  valid_before: string;
  nonce: string;
  fingerprint: string;
  status: X402ExactSettlementStatus;
  effect: X402ExactSettlementEffect | null;
  submission_block: string | null;
  transaction: string | null;
  settle_response: Record<string, unknown> | null;
  last_outcome: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

interface X402ExactAttemptRow {
  id: string;
  intent_id: string;
  outcome: X402ExactSettlementAttempt["outcome"];
  detail: string | null;
  transaction: string | null;
  created_at: string;
}

function rowToIntent(row: X402ExactIntentRow): X402ExactSettlementIntent {
  return {
    id: row.intent_id,
    dvmId: row.dvm_id,
    resource: row.resource,
    network: row.network,
    asset: row.asset,
    from: row.authorizer,
    to: row.recipient,
    value: row.value,
    validAfter: row.valid_after,
    validBefore: row.valid_before,
    nonce: row.nonce,
    fingerprint: row.fingerprint,
    status: row.status,
    effect: row.effect ?? undefined,
    submissionBlock: row.submission_block ?? undefined,
    transaction: row.transaction ?? undefined,
    settleResponse: row.settle_response ?? undefined,
    lastOutcome: row.last_outcome ?? undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    resolvedAt: row.resolved_at === null ? undefined : Number(row.resolved_at),
  };
}

function rowToAttempt(row: X402ExactAttemptRow): X402ExactSettlementAttempt {
  return {
    id: row.id,
    intentId: row.intent_id,
    outcome: row.outcome,
    detail: row.detail ?? undefined,
    transaction: row.transaction ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function intentKey(dvmId: string, intentId: string): string {
  return `${dvmId}\u0000${intentId}`;
}

function sameIntentBinding(
  stored: X402ExactSettlementIntent,
  incoming: Omit<X402ExactSettlementIntent, "status" | "createdAt" | "updatedAt" | "resolvedAt">
): boolean {
  if (stored.fingerprint !== incoming.fingerprint || stored.resource !== incoming.resource) {
    return false;
  }
  // A retry gets a new server allocation and, after the drift window, a new
  // verified auth envelope. Keep requestFingerprint and callerId untouched;
  // prepare reserves each incoming auth fingerprint to this intent separately.
  const incomingEffect =
    stored.effect?.jobAdmission && incoming.effect?.jobAdmission
      ? {
          ...incoming.effect,
          jobId: stored.effect.jobId,
          jobAdmission: {
            ...incoming.effect.jobAdmission,
            authFingerprint:
              stored.effect.jobAdmission.authFingerprint !== undefined &&
              incoming.effect.jobAdmission.authFingerprint !== undefined
                ? stored.effect.jobAdmission.authFingerprint
                : incoming.effect.jobAdmission.authFingerprint,
          },
        }
      : incoming.effect;
  return (
    canonicalize((stored.effect ?? null) as JsonValue) ===
    canonicalize((incomingEffect ?? null) as JsonValue)
  );
}
