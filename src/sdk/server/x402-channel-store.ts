import { AsyncLocalStorage } from "node:async_hooks";
import { isDeepStrictEqual } from "node:util";

import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import type {
  Channel,
  ChannelStorage,
  ChannelUpdateResult,
} from "@x402/evm/batch-settlement/server";
import type { Pool, PoolClient, PoolConfig } from "pg";

import { applyRetryToPool } from "../../lib/pg-retry";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence, type HostedFundingReservation } from "./hosting-cleanup-fence";

/** Query surface shared by the pool and an open Postgres transaction. */
export type X402ChannelQuerier = Pick<Pool, "query">;

/**
 * Durable phase of an irreversible x402 facilitator settlement.
 *
 * `written_off` is the operator's terminal: a settlement whose
 * ledger leg cannot be completed, reviewed and closed so it leaves the repair
 * queue without pretending it booked. It is deliberately reversible — a later
 * reconcile still accepts it, because it moved nothing.
 */
export type X402SettlementStatus =
  | "prepared"
  | "submitting"
  | "settled"
  | "complete"
  | "written_off";

/** Recovery record binding one chain settlement to one credit-ledger effect. */
export interface X402SettlementIntent {
  settlementId: string;
  channelId: string;
  operation: "fund" | "refund";
  effectId: string;
  paymentId: string;
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  channelBefore: Channel;
  /**
   * The channel as it stood when the settlement was handed to the facilitator —
   * after the refund's mandatory on-chain refresh, which {@link channelBefore}
   * precedes.
   *
   * The facilitator sizes a cooperative refund from *live* state
   * (`balance − chargedCumulativeAmount`) and signs it against the *live*
   * `refundNonce`, so this is the snapshot chain evidence has to be derived
   * from. `channelBefore` is a pre-verify mirror kept for the voucher restore,
   * and whenever it was stale a refund that settled read as one that never
   * happened. Absent on rows an older build wrote, and on any row that never
   * reached `submitting`.
   */
  channelAtSubmission?: Channel;
  submissionBlock?: string;
  pendingId?: string;
  status: X402SettlementStatus;
  response?: SettleResponse;
  /** Epoch ms the row was first prepared. */
  createdAt: number;
  /** Epoch ms of the last status write — what the repair queue ages against. */
  updatedAt: number;
  /** Operator's reason, recorded by {@link PostgresX402ChannelStorage.writeOffSettlement}. */
  writeOffNote?: string;
  /** Epoch ms an operator reconciled or wrote this settlement off. */
  resolvedAt?: number;
}

/** The caller-supplied half of a settlement row — everything the store does not stamp itself. */
export type X402SettlementIdentity = Omit<
  X402SettlementIntent,
  | "status"
  | "response"
  | "createdAt"
  | "updatedAt"
  | "writeOffNote"
  | "resolvedAt"
  | "channelAtSubmission"
>;

/**
 * Keyset position in the repair queue's `(created_at, settlement_id)` ordering.
 *
 * `createdAt` is Postgres's own rendering of the `TIMESTAMPTZ`, carried as text
 * and handed straight back as one — never a `Date`. `created_at` has microsecond
 * resolution and `Date` has millisecond, so a cursor that round-tripped through
 * epoch ms would land *before* the row it was taken from and re-serve it on
 * every page, which at `limit: 1` never advances at all.
 */
export interface X402SettlementCursor {
  createdAt: string;
  settlementId: string;
}

/** One page of the repair queue, plus the position to resume from. */
export interface X402SettlementPage {
  settlements: X402SettlementIntent[];
  /** Absent when this page was not full — there is nothing behind it. */
  nextAfter?: X402SettlementCursor;
}

/**
 * A settlement CAS that lost: the row moved on between the read that chose this
 * write and the write itself.
 *
 * Typed rather than a bare `Error` because it is reachable by ordinary
 * concurrency — two operator repairs on one settlement, or a caller retry
 * completing it mid-repair — and the operator surface owes those a structured
 * refusal rather than a 500 out of a rollback.
 */
export class X402SettlementRaceError extends Error {}

/**
 * Fleet-wide serialisation of the self-relay's chain submissions.
 *
 * Narrow on purpose, and implemented by {@link PostgresX402ChannelStorage}: the
 * relay asks for one thing — exclusive use of its gas EOA for the length of one
 * submission — and must not acquire the ability to touch a channel or a
 * settlement row. Handing it this instead of the host `Pool` is what keeps the
 * acquire off the pool the channel transaction is already holding a client from.
 */
export interface X402RelaySubmissionLock {
  withRelaySubmissionLock<T>(key: string, operation: () => Promise<T>): Promise<T>;
}

export interface X402ChannelStorageOpts {
  /** Original hosted chain identity, persisted only on a channel's first write. */
  hostedNetwork?: string;
  /**
   * Override the relay submission lock's wait ceiling, in milliseconds.
   *
   * A test seam: the production ceiling is tens of seconds, which no test can
   * wait out, and the refusal path is exactly what needs pinning.
   */
  relaySubmissionLockTimeoutMs?: number;
  /**
   * Retire ledger credit when a fresh chain observation proves its channel
   * has no unclaimed backing. Runs under the channel transaction so the
   * channel-first, credit-second lock order stays fleet-wide.
   */
  terminalizeUnbackedCredit?: (
    evidence: {
      channelId: string;
      channelBalanceNative: bigint;
      totalClaimedNative: bigint;
      observedAt: number;
    },
    tx: X402ChannelQuerier
  ) => Promise<unknown>;
}

/** Best-effort identification of the backend holding the relay submission lock. */
export interface X402RelayLockHolder {
  pid: number;
  applicationName?: string;
  clientAddr?: string;
  state?: string;
  /** Seconds since the holder's current statement started. */
  heldSeconds?: number;
}

/**
 * The fleet-wide relay submission lock was still held when the wait ceiling expired.
 *
 * Typed, and `retryable`, because it is an availability outcome rather than a
 * fault in the payment: a fleet-mate whose RPC is retrying holds the lock, and
 * the same request works once it lets go. It refuses rather than proceeding —
 * two machines submitting from one EOA collide on the nonce — and it refuses
 * rather than blocking, which is the defect: the old acquire had no
 * `lock_timeout`, so a wedged holder pinned a host-pool client and a channel
 * advisory lock for as long as it took.
 */
export class X402RelaySubmissionLockError extends Error {
  readonly code = "x402_relay_submission_lock_timeout";
  readonly retryable = true;

  constructor(
    readonly lockKey: string,
    readonly timeoutMs: number,
    readonly holder?: X402RelayLockHolder
  ) {
    super(
      `x402 self-relay submission lock '${lockKey}' still held after ${String(timeoutMs)}ms${
        holder ? ` (held by ${describeHolder(holder)})` : ""
      }`
    );
    this.name = "X402RelaySubmissionLockError";
  }
}

/** Outcome of {@link PostgresX402ChannelStorage.writeOffSettlement} — `written` is the transition bit. */
export interface X402SettlementWriteOff {
  intent: X402SettlementIntent;
  written: boolean;
}

/** Statuses a settlement can sit in between "chain paid" and "ledger booked". */
export const X402_WEDGED_SETTLEMENT_STATUSES: X402SettlementStatus[] = ["submitting", "settled"];

/**
 * The wedged statuses plus `written_off` — the audit view.
 *
 * `complete` is deliberately absent: unlike a reconciled Lightning invoice,
 * every drain that ever worked is `complete`, so including it would bury the
 * queue in ordinary traffic. A reconciled settlement is confirmed by the
 * reconcile's own response and by {@link PostgresX402ChannelStorage.getSettlementById}.
 */
export const X402_RESOLVED_SETTLEMENT_STATUSES: X402SettlementStatus[] = [
  ...X402_WEDGED_SETTLEMENT_STATUSES,
  "written_off",
];

/**
 * Statuses that stop a channel-backed credit being **spent**.
 *
 * The wedged pair plus `written_off`, and that third one is the deliberate
 * asymmetry with {@link X402_WEDGED_SETTLEMENT_STATUSES}: a written-off refund
 * is precisely the one nobody could get a definitive chain answer for, so the
 * escrow behind the credit may already have been paid out. The balance stays
 * *reclaimable* — a fresh drain id still works, which is the exit —
 * but it must not buy work the DVM can never claim against.
 */
export const X402_SPEND_BLOCKING_SETTLEMENT_STATUSES: X402SettlementStatus[] = [
  ...X402_WEDGED_SETTLEMENT_STATUSES,
  "written_off",
];

/** The refund standing between a channel and the credit it backs. */
export interface X402UnresolvedRefund {
  settlementId: string;
  /** `${creditId}:${drainId}` — the drain this settlement belongs to. */
  effectId: string;
  status: X402SettlementStatus;
}

/**
 * The credit ledger's read into durable x402 settlement state.
 *
 * Narrow on purpose: the ledger asks one question — is this channel's refund
 * still unresolved — and must not acquire the ability to move a settlement.
 * Implemented by {@link PostgresX402ChannelStorage.pendingRefundSettlement}.
 */
export interface X402RefundSettlementGate {
  pendingRefundSettlement(
    channelId: string,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined>;
}

/**
 * Isolate settlement writes and credit spend-gate reads from the host pool,
 * avoiding nested checkout deadlocks. Reserve a fifth slot for the relay lock,
 * held through chain submission and serialized once per process. Gate reads
 * fail closed if checkout exceeds SETTLEMENT_CONNECT_TIMEOUT_MS; this fixed
 * capacity may need revisiting when host concurrency grows.
 */
const SETTLEMENT_POOL_MAX = 5;
/** Exhaustion of the settlement pool must surface as an error, never a hang. */
const SETTLEMENT_CONNECT_TIMEOUT_MS = 10_000;
/** Ceiling on how long a waiting fleet-lock acquire may pin a pooled client. */
const FLEET_LOCK_TIMEOUT_MS = 30_000;
/**
 * Ceiling on how long a relay submission may wait for a fleet-mate.
 *
 * Same reasoning and same magnitude as {@link FLEET_LOCK_TIMEOUT_MS}: the holder
 * is doing one chain submission, so a wait past this is a wedged fleet-mate
 * rather than ordinary contention.
 */
const RELAY_SUBMISSION_LOCK_TIMEOUT_MS = 30_000;
/** `lock_timeout` expiry — Postgres reports it as `lock_not_available`. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Postgres implementation of x402's server-side {@link ChannelStorage}.
 *
 * `updateChannel` takes an advisory transaction lock before it reads the row,
 * so the read/callback/write sequence is atomic even for a first deposit whose
 * row does not exist yet. {@link withChannelTransaction} exposes the same
 * transaction to the credit ledger: the fixed lock order is channel first,
 * credit second, and no credit-ledger path calls back into this store.
 *
 * Two pools, and the split is load-bearing. The settlement markers
 * must write *outside* the ledger transaction, which means a second connection
 * taken while the transaction's client is still checked out — on the shared
 * host pool that is a self-deadlock the moment concurrent deposits reach its
 * `max`, with no error and no timeout because every waiter is also a holder.
 * They therefore run on a small dedicated pool that acquires nothing itself,
 * so nothing can ever queue behind them. The rule this rests on: a client held
 * from one pool may only ever be used to acquire from a pool that is terminal.
 * {@link withFleetSettlementLock} and {@link withRelaySubmissionLock} are the
 * other two nesting sites and are bounded a different way — see their docs.
 */
export class PostgresX402ChannelStorage implements ChannelStorage {
  private hostingCleanupFence?: HostingCleanupFence;

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }

  async assertHostingFundingReservation(reservation: HostedFundingReservation | undefined): Promise<void> {
    if (!this.hostingCleanupFence) return;
    if (!reservation) throw new Error("Hosted x402 funding requires an original admission");
    await this.hostingCleanupFence.withNewIntent({
      admissionId: reservation.admissionId, creditId: reservation.creditId,
      fundId: reservation.fundId, callerPubkey: reservation.callerPubkey,
      fundingCommitment: reservation.commitment,
    }, (tx) => this.hostingCleanupFence!.assertFundingReservation(tx, reservation));
  }
  private readonly transaction = new AsyncLocalStorage<PoolClient>();
  private readonly hostedFunding = new WeakMap<PoolClient, HostedFundingReservation>();
  private readonly refundBase = new AsyncLocalStorage<string>();
  private settlementPool?: Promise<Pool>;
  private fleetLock: Promise<unknown> = Promise.resolve();
  private fleetLockQueueDepth = 0;
  private readonly relayLockTimeoutMs: number;
  private readonly terminalizeUnbackedCredit?: NonNullable<
    X402ChannelStorageOpts["terminalizeUnbackedCredit"]
  >;
  private readonly hostedNetwork?: string;

  constructor(
    private readonly pool: Pool,
    opts?: X402ChannelStorageOpts
  ) {
    this.relayLockTimeoutMs =
      opts?.relaySubmissionLockTimeoutMs ?? RELAY_SUBMISSION_LOCK_TIMEOUT_MS;
    this.terminalizeUnbackedCredit = opts?.terminalizeUnbackedCredit;
    this.hostedNetwork = opts?.hostedNetwork;
    if (this.hostedNetwork && !x402NetworkByCaip2(this.hostedNetwork)) {
      throw new Error("Hosted x402 batch channel network is unsupported");
    }
    // Postgres interprets lock_timeout=0 as an unlimited wait.
    if (!Number.isInteger(this.relayLockTimeoutMs) || this.relayLockTimeoutMs <= 0) {
      throw new Error("relaySubmissionLockTimeoutMs must be a positive integer number of ms");
    }
  }

  async init(): Promise<void> {
    this.settlementPool ??= createSettlementPool(this.pool);
    await withSdkInitLock(this.pool, async () => {
      const before = await this.pool.query<{ existed: boolean }>(
        "SELECT to_regclass('x402_batch_channels') IS NOT NULL AS existed"
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_batch_channels (
          channel_id                  TEXT PRIMARY KEY,
          channel_config              JSONB NOT NULL,
          charged_cumulative_amount   NUMERIC(78, 0) NOT NULL,
          signed_max_claimable         NUMERIC(78, 0) NOT NULL,
          signature                   TEXT NOT NULL,
          balance                     NUMERIC(78, 0) NOT NULL,
          total_claimed                NUMERIC(78, 0) NOT NULL,
          withdraw_requested_at        BIGINT NOT NULL,
          refund_nonce                 BIGINT NOT NULL,
          onchain_synced_at             BIGINT,
          last_request_timestamp       BIGINT NOT NULL,
          pending_request              JSONB,
          hosting_binding              JSONB
        )
      `);
      await this.pool.query(
        `ALTER TABLE x402_batch_channels ADD COLUMN IF NOT EXISTS hosting_binding JSONB`
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_batch_channel_tombstones (
          channel_id TEXT PRIMARY KEY,
          hosting_binding JSONB,
          charged_cumulative_amount NUMERIC(78,0) NOT NULL,
          signed_max_claimable NUMERIC(78,0) NOT NULL,
          refund_nonce BIGINT NOT NULL,
          pending_request JSONB,
          deleted_at_ms BIGINT NOT NULL
        )
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_batch_channel_history (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          complete BOOLEAN NOT NULL
        )
      `);
      await this.pool.query(
        `INSERT INTO x402_batch_channel_history (singleton,complete) VALUES (TRUE,$1)
         ON CONFLICT (singleton) DO NOTHING`, [!before.rows[0].existed]
      );
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_x402_batch_channels_withdrawal
           ON x402_batch_channels(withdraw_requested_at)
         WHERE withdraw_requested_at <> 0`
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_batch_settlements (
          settlement_id       TEXT PRIMARY KEY,
          channel_id          TEXT NOT NULL,
          operation           TEXT NOT NULL CHECK (operation IN ('fund', 'refund')),
          effect_id           TEXT NOT NULL,
          payment_id          TEXT NOT NULL,
          payment_payload     JSONB NOT NULL,
          payment_requirements JSONB NOT NULL,
          channel_before      JSONB,
          submission_block    NUMERIC(78, 0),
          pending_id          TEXT,
          status              TEXT NOT NULL,
          settle_response     JSONB,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (operation, effect_id),
          UNIQUE (operation, payment_id)
        )
      `);
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements ADD COLUMN IF NOT EXISTS channel_before JSONB`
      );
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements ADD COLUMN IF NOT EXISTS submission_block NUMERIC(78, 0)`
      );
      // The submission-time channel snapshot. Written by the same
      // CAS that writes `submission_block` and cleared by the same one that
      // clears it: both describe the instant the settlement left for the
      // facilitator, and evidence derived from one while the other moved is
      // evidence for a different submission.
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements ADD COLUMN IF NOT EXISTS channel_at_submission JSONB`
      );
      // The operator repair's own columns. Added rather than folded
      // into the CREATE above: a table created by an earlier build never gets a
      // new column from a `CREATE TABLE IF NOT EXISTS`.
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements ADD COLUMN IF NOT EXISTS write_off_note TEXT`
      );
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements ADD COLUMN IF NOT EXISTS resolved_at BIGINT`
      );
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements
           DROP CONSTRAINT IF EXISTS x402_batch_settlements_status_check`
      );
      await this.pool.query(
        `ALTER TABLE x402_batch_settlements
           ADD CONSTRAINT x402_batch_settlements_status_check
           CHECK (status IN ('prepared', 'submitting', 'settled', 'complete', 'written_off'))`
      );
      // The repair queue's keyset ordering, on `created_at` because it is
      // immutable: a keyset over `updated_at` moves a row across pages whenever
      // anything writes to it, so a concurrent repair could push an unexamined
      // row past the cursor and out of the operator's walk entirely. Partial,
      // and deliberately excludes both terminals a healthy DVM produces:
      // `prepared` is the ordinary pre-submission phase, and `complete` is every
      // drain that ever worked — indexing those would make the queue's index the
      // size of all traffic.
      await this.pool.query(`DROP INDEX IF EXISTS idx_x402_batch_settlements_repair`);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_x402_batch_settlements_repair_created
           ON x402_batch_settlements(created_at, settlement_id)
         WHERE status IN ('submitting', 'settled', 'written_off')`
      );
      // The spend gate's lookup: every fresh draw on a
      // channel-backed credit asks whether that channel's refund is still
      // unresolved, so it has to be an index hit rather than a scan. Same
      // partial predicate as the queue's — a `complete` row never blocks
      // anything, and indexing it would make this the size of all traffic.
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_x402_batch_settlements_channel_open
           ON x402_batch_settlements(channel_id, created_at)
         WHERE operation = 'refund'
           AND status IN ('submitting', 'settled', 'written_off')`
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS x402_batch_settlement_state (
          scope          TEXT PRIMARY KEY,
          pending_settle BOOLEAN NOT NULL,
          updated_at     BIGINT NOT NULL
        )
      `);
    });
  }

  /**
   * Read the fleet's durable "claimed funds are awaiting transfer" marker.
   *
   * Upstream keeps this in process memory, which a multi-machine fleet cannot
   * share: the machine that won a claim tick is rarely the one that wins the
   * next settle tick. An unset scope reads false, so a receiver that has never
   * claimed never submits a settlement.
   *
   * Both accessors run on the settlement pool: every caller reads or writes the
   * marker while {@link withFleetSettlementLock} holds a host-pool client, which
   * is the nesting the split exists to keep off a non-terminal pool.
   */
  async isSettlePending(scope: string): Promise<boolean> {
    const reader = await this.settlementWriter();
    const { rows } = await reader.query<{ pending_settle: boolean }>(
      `SELECT pending_settle FROM x402_batch_settlement_state WHERE scope = $1`,
      [scope]
    );
    return rows[0]?.pending_settle ?? false;
  }

  /** Record whether a claim's funds still need a `settle(receiver, token)` transfer. */
  async setSettlePending(scope: string, pending: boolean): Promise<void> {
    const writer = await this.settlementWriter();
    await writer.query(
      `INSERT INTO x402_batch_settlement_state (scope, pending_settle, updated_at)
         VALUES ($1, $2, $3)
       ON CONFLICT (scope) DO UPDATE
         SET pending_settle = EXCLUDED.pending_settle,
             updated_at = EXCLUDED.updated_at`,
      [scope, pending, Date.now()]
    );
  }

  /**
   * Look up the durable settlement state for one credit-ledger effect.
   *
   * On the dedicated settlement pool like every other marker, and for a sharper
   * reason than they had: this and {@link prepareSettlement} now run *inside*
   * the channel transaction, which holds a host-pool client for its
   * whole duration. Taking a second client from that same pool is the
   * self-deadlock fixed — at pool max every client is a holder and a
   * waiter — and moving these calls under the transaction is exactly what would
   * reintroduce it.
   */
  async getSettlement(
    operation: "fund" | "refund",
    effectId: string
  ): Promise<X402SettlementIntent | undefined> {
    const { rows } = await (
      await this.settlementWriter()
    ).query<X402SettlementRow>(
      `SELECT * FROM x402_batch_settlements WHERE operation = $1 AND effect_id = $2`,
      [operation, effectId]
    );
    return rows[0] ? toSettlementIntent(rows[0]) : undefined;
  }

  /**
   * The refund on this channel that is neither finished nor abandoned, if there
   * is one — the credit ledger's spend gate.
   *
   * `statuses` is the caller's, because the two gates disagree by design: a
   * draw is blocked by {@link X402_SPEND_BLOCKING_SETTLEMENT_STATUSES}, a fresh
   * drain only by {@link X402_WEDGED_SETTLEMENT_STATUSES}.
   *
   * On the dedicated settlement pool, and that is what makes the gate callable
   * at all: a draw routinely runs inside an open channel transaction holding a
   * host-pool client, and taking a second one from that pool is the
   * self-deadlock. The oldest blocking row wins, so a channel that somehow
   * accumulated two names the one an operator should reach for first.
   *
   * Projects three columns rather than decoding a whole {@link
   * X402SettlementIntent}: the decoder refuses a legacy row that carries
   * no reconciliation snapshot, and a gate that throws on one would take every
   * draw on that channel down with it — when the row is exactly the kind that
   * ought to block them.
   */
  async pendingRefundSettlement(
    channelId: string,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined> {
    const { rows } = await (
      await this.settlementWriter()
    ).query<Pick<X402SettlementRow, "settlement_id" | "effect_id" | "status">>(
      `SELECT settlement_id, effect_id, status FROM x402_batch_settlements
        WHERE channel_id = $1 AND operation = 'refund' AND status = ANY($2::text[])
        ORDER BY created_at, settlement_id
        LIMIT 1`,
      [normalizeChannelId(channelId), statuses]
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return { settlementId: row.settlement_id, effectId: row.effect_id, status: row.status };
  }

  /**
   * Read one settlement by its own identifier — the handle an operator holds
   * Same dedicated pool as {@link getSettlement}, for the same
   * reason: the repair reads this while a channel transaction may be open.
   */
  async getSettlementById(settlementId: string): Promise<X402SettlementIntent | undefined> {
    const { rows } = await (
      await this.settlementWriter()
    ).query<X402SettlementRow>(`SELECT * FROM x402_batch_settlements WHERE settlement_id = $1`, [
      settlementId,
    ]);
    return rows[0] ? toSettlementIntent(rows[0]) : undefined;
  }

  /** Lazily move a legacy settlement row onto its authorization/effect-scoped replay key. */
  async normalizeLegacyPaymentId(
    settlementId: string,
    operation: "fund" | "refund",
    legacyPaymentId: string,
    paymentId: string
  ): Promise<X402SettlementIntent> {
    const writer = await this.settlementWriter();
    const updated = await writer.query<X402SettlementRow>(
      `UPDATE x402_batch_settlements
          SET payment_id = $3
        WHERE settlement_id = $1 AND operation = $4 AND payment_id = $2
        RETURNING *`,
      [settlementId, legacyPaymentId, paymentId, operation]
    );
    if (updated.rows[0]) return toSettlementIntent(updated.rows[0]);

    // Another retry can win the same harmless normalization between our read
    // and write. Accept only that exact result; anything else is a corrupted
    // identity and must retain the existing fail-closed behaviour.
    const existing = await this.getSettlementById(settlementId);
    if (existing?.operation === operation && existing.paymentId === paymentId) return existing;
    throw new Error(`x402 settlement ${settlementId} legacy payment identity changed`);
  }

  /**
   * The operator's repair queue: settlements stuck between "chain paid" and
   * "ledger booked", oldest write first.
   *
   * Keyset-paginated on `(created_at, settlement_id)` for the reason the
   * blocked-invoice queue is: a wedged row never self-clears, so a fixed first
   * page of rows the operator has declined to act on would starve everything
   * behind it on every run, forever.
   *
   * The keyset is on `created_at`, which never moves, while `updatedBeforeMs`
   * filters on `updated_at`, which does — so a row an operator touches mid-walk
   * can leave the queue but can never jump the cursor and be skipped. The cursor
   * itself is Postgres's text rendering of that timestamp, handed back verbatim;
   * see {@link X402SettlementCursor} for why a `Date` cannot carry it.
   *
   * `updatedBeforeMs` is the staleness floor. A healthy settlement passes
   * through `submitting` and `settled` inside one request, so anything younger
   * than the floor is in flight rather than wedged and must not be offered as
   * repairable work.
   */
  async listSettlements(args: {
    statuses: X402SettlementStatus[];
    updatedBeforeMs: number;
    limit: number;
    after?: X402SettlementCursor;
  }): Promise<X402SettlementPage> {
    const { rows } = await (
      await this.settlementWriter()
    ).query<X402SettlementRow & { created_at_key: string }>(
      `SELECT *, created_at::text AS created_at_key FROM x402_batch_settlements
        WHERE status = ANY($1::text[])
          AND updated_at <= to_timestamp($2::double precision / 1000)
          AND ($3::text IS NULL
               OR (created_at, settlement_id) > ($3::timestamptz, $4::text))
        ORDER BY created_at, settlement_id
        LIMIT $5`,
      [
        args.statuses,
        args.updatedBeforeMs,
        args.after?.createdAt ?? null,
        args.after?.settlementId ?? null,
        args.limit,
      ]
    );
    const last = rows.length === args.limit ? rows[rows.length - 1] : undefined;
    return {
      settlements: rows.map(toSettlementIntent),
      ...(last
        ? { nextAfter: { createdAt: last.created_at_key, settlementId: last.settlement_id } }
        : {}),
    };
  }

  /**
   * Close a wedged settlement without booking anything.
   *
   * A single-statement CAS on the wedged statuses, on the settlement pool —
   * there is no ledger effect to be atomic with, which is the whole point:
   * the write-off records that an operator reviewed this settlement and is not
   * completing it, and no dvmkit table moves. Idempotent, and the first note
   * wins; `written` is the transition bit the caller logs on, so the one place
   * the amount is ever recorded gets exactly one entry.
   *
   * Reversible by construction: a later reconcile calls
   * {@link recordSettlementResponse}, whose `status <> 'complete'` CAS lifts a
   * written-off row back to `settled`.
   */
  async writeOffSettlement(
    settlementId: string,
    note: string | undefined,
    nowMs: number
  ): Promise<X402SettlementWriteOff | undefined> {
    const writer = await this.settlementWriter();
    const updated = await writer.query<X402SettlementRow>(
      `UPDATE x402_batch_settlements
          SET status = 'written_off', write_off_note = $2, resolved_at = $3, updated_at = NOW()
        WHERE settlement_id = $1 AND status = ANY($4::text[])
        RETURNING *`,
      [settlementId, note ?? null, nowMs, X402_WEDGED_SETTLEMENT_STATUSES]
    );
    if (updated.rows[0]) return { intent: toSettlementIntent(updated.rows[0]), written: true };
    const existing = await this.getSettlementById(settlementId);
    return existing ? { intent: existing, written: false } : undefined;
  }

  /** Persist the reconciliation identity, refreshing a prepared retry's transient reservation. */
  async prepareSettlement(
    intent: X402SettlementIdentity, hostingFunding?: HostedFundingReservation
  ): Promise<X402SettlementIntent> {
    const settlements = await this.settlementWriter();
    const insert = (q: X402ChannelQuerier) => q.query(
      `INSERT INTO x402_batch_settlements (
         settlement_id, channel_id, operation, effect_id, payment_id,
         payment_payload, payment_requirements, channel_before, pending_id, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'prepared')
       ON CONFLICT DO NOTHING`,
      [
        intent.settlementId,
        normalizeChannelId(intent.channelId),
        intent.operation,
        intent.effectId,
        intent.paymentId,
        intent.payload,
        intent.requirements,
        intent.channelBefore,
        intent.pendingId ?? null,
      ]
    );
    if (this.hostingCleanupFence && intent.operation === "fund") {
      if (!hostingFunding || intent.effectId !== `${hostingFunding.creditId}:${hostingFunding.fundId}`) {
        throw new Error("Hosted x402 settlement has no matching original funding admission");
      }
      await this.hostingCleanupFence.withNewIntentOn(
        await this.settlementPoolRef(), {
          admissionId: hostingFunding.admissionId,
          creditId: hostingFunding.creditId,
          fundId: hostingFunding.fundId,
          callerPubkey: hostingFunding.callerPubkey,
          fundingCommitment: hostingFunding.commitment,
        }, async (tx) => {
          await this.hostingCleanupFence!.assertFundingReservation(tx, hostingFunding);
          await insert(tx);
        }
      );
    } else {
      await insert(settlements);
    }
    const { rows } = await settlements.query<X402SettlementRow>(
      `SELECT * FROM x402_batch_settlements
        WHERE settlement_id = $1
           OR (operation = $2 AND effect_id = $3)
           OR (operation = $2 AND payment_id = $4)
        ORDER BY settlement_id = $1 DESC
        LIMIT 1`,
      [intent.settlementId, intent.operation, intent.effectId, intent.paymentId]
    );
    let stored = rows[0] ? toSettlementIntent(rows[0]) : undefined;
    if (
      stored?.settlementId !== intent.settlementId ||
      stored.channelId !== normalizeChannelId(intent.channelId) ||
      stored.operation !== intent.operation ||
      stored.effectId !== intent.effectId
    ) {
      throw new Error("x402 settlement identity conflicts with a prior credit effect");
    }
    if (
      stored.paymentId !== intent.paymentId ||
      !isDeepStrictEqual(stored.payload, intent.payload) ||
      !isDeepStrictEqual(stored.requirements, intent.requirements)
    ) {
      if (!canRefreshPreparedDepositAuthorization(stored, intent, Date.now())) {
        throw new Error("x402 settlement identity conflicts with a prior credit effect");
      }
      const refreshed = await settlements.query<X402SettlementRow>(
        `UPDATE x402_batch_settlements
            SET payment_id = $2, payment_payload = $3, channel_before = $4,
                pending_id = $5, updated_at = NOW()
          WHERE settlement_id = $1 AND status = 'prepared'
            AND payment_id = $6 AND payment_payload = $7
          RETURNING *`,
        [
          intent.settlementId,
          intent.paymentId,
          intent.payload,
          intent.channelBefore,
          intent.pendingId ?? null,
          stored.paymentId,
          stored.payload,
        ]
      );
      if (refreshed.rows[0]) return toSettlementIntent(refreshed.rows[0]);

      // Only one refreshed authorization may replace the expired payload. An
      // exact concurrent request can share the winner; a different signature
      // must wait for that winner's own deadline rather than overwrite the
      // evidence a submission is about to bind.
      const raced = await this.getSettlementById(intent.settlementId);
      if (
        raced?.paymentId !== intent.paymentId ||
        !isDeepStrictEqual(raced.payload, intent.payload) ||
        !isDeepStrictEqual(raced.requirements, intent.requirements)
      ) {
        throw new Error("x402 settlement identity conflicts with a prior credit effect");
      }
      stored = raced;
    }
    if (
      stored.status === "prepared" &&
      (!isDeepStrictEqual(stored.channelBefore, intent.channelBefore) ||
        stored.pendingId !== intent.pendingId)
    ) {
      const refreshed = await settlements.query<X402SettlementRow>(
        `UPDATE x402_batch_settlements
            SET channel_before = $2, pending_id = $3, updated_at = NOW()
          WHERE settlement_id = $1 AND status = 'prepared'
          RETURNING *`,
        [intent.settlementId, intent.channelBefore, intent.pendingId ?? null]
      );
      if (refreshed.rowCount !== 1) {
        throw new Error(`x402 settlement ${intent.settlementId} is no longer prepared for retry`);
      }
      return toSettlementIntent(refreshed.rows[0]);
    }
    if (!isDeepStrictEqual(stored.channelBefore, intent.channelBefore)) {
      throw new Error("x402 settlement identity conflicts with a prior credit effect");
    }
    return stored;
  }

  /**
   * Mark that the next operation is the ambiguous external-call boundary.
   *
   * `channelAtSubmission` is the live channel the facilitator is about to size
   * and sign the settlement against — bookmarked here, with the
   * block height, because these two are the only description of that instant
   * that survives the call.
   */
  async markSettlementSubmitting(
    settlementId: string,
    submissionBlock: string,
    channelAtSubmission?: Channel
  ): Promise<void> {
    if (!/^\d+$/.test(submissionBlock)) {
      throw new Error(`x402 settlement ${settlementId} has an invalid submission block`);
    }
    const writer = await this.settlementWriter();
    const result = await writer.query(
      `UPDATE x402_batch_settlements
          SET status = 'submitting', submission_block = $2,
              channel_at_submission = $3, updated_at = NOW()
        WHERE settlement_id = $1 AND status = 'prepared'`,
      [settlementId, submissionBlock, channelAtSubmission ?? null]
    );
    if (result.rowCount !== 1) {
      throw new Error(`x402 settlement ${settlementId} is not prepared for submission`);
    }
  }

  /** Return an explicitly failed facilitator submission to the safe retry phase. */
  async markSettlementRetryable(settlementId: string): Promise<void> {
    const writer = await this.settlementWriter();
    const result = await writer.query(
      `UPDATE x402_batch_settlements
          SET status = 'prepared', submission_block = NULL,
              channel_at_submission = NULL, updated_at = NOW()
        WHERE settlement_id = $1 AND status = 'submitting'`,
      [settlementId]
    );
    if (result.rowCount !== 1) {
      throw new Error(`x402 settlement ${settlementId} is not awaiting a submission result`);
    }
  }

  /**
   * Record a successful facilitator response independently of the enclosing
   * ledger transaction.
   *
   * The write-off columns are cleared, not carried: this CAS is what lifts a
   * `written_off` row back to `settled` (which is what makes the write-off
   * reversible), and a row that is no longer written off must not still be
   * carrying the note and resolution timestamp of a decision that has been
   * reversed. On the live path the columns are already `NULL` and this is a
   * no-op.
   */
  async recordSettlementResponse(settlementId: string, response: SettleResponse): Promise<void> {
    const writer = await this.settlementWriter();
    const result = await writer.query(
      `UPDATE x402_batch_settlements
          SET status = 'settled', settle_response = $2,
              write_off_note = NULL, resolved_at = NULL, updated_at = NOW()
        WHERE settlement_id = $1 AND status <> 'complete'`,
      [settlementId, response]
    );
    if (result.rowCount !== 1) {
      throw new X402SettlementRaceError(`x402 settlement ${settlementId} is not recoverable`);
    }
  }

  /**
   * Mark the external settlement and ledger effect complete in the active transaction.
   *
   * `resolvedAtMs` is set only by the operator repair, so an audit
   * read can tell a settlement that completed on its own from one a human had
   * to finish.
   */
  async completeSettlement(settlementId: string, resolvedAtMs?: number): Promise<void> {
    const q = this.transaction.getStore() ?? this.pool;
    const result = await q.query(
      `UPDATE x402_batch_settlements
          SET status = 'complete',
              resolved_at = COALESCE($2::bigint, resolved_at),
              updated_at = NOW()
        WHERE settlement_id = $1 AND status = 'settled'`,
      [settlementId, resolvedAtMs ?? null]
    );
    if (result.rowCount !== 1) {
      throw new X402SettlementRaceError(
        `x402 settlement ${settlementId} has no recorded facilitator response`
      );
    }
  }

  async get(channelId: string): Promise<Channel | undefined> {
    const q = this.transaction.getStore() ?? this.pool;
    const { rows } = await q.query<X402ChannelRow>(
      `SELECT * FROM x402_batch_channels WHERE channel_id = $1`,
      [normalizeChannelId(channelId)]
    );
    return rows[0] ? toChannel(rows[0]) : undefined;
  }

  /** List all channel snapshots in stable channel-id order. */
  async list(): Promise<Channel[]> {
    const q = this.transaction.getStore() ?? this.pool;
    const { rows } = await q.query<X402ChannelRow>(
      `SELECT * FROM x402_batch_channels ORDER BY channel_id`
    );
    return rows.map(toChannel);
  }

  /** Atomic backend-level read/modify/write for one channel. */
  async updateChannel(
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined
  ): Promise<ChannelUpdateResult> {
    const active = this.transaction.getStore();
    if (active) return this.updateInTransaction(active, channelId, update, true);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await this.updateInTransaction(client, channelId, update, false);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run channel state and its ledger effect under the channel lock.
   *
   * Upstream's voucher-only settle updates `chargedCumulativeAmount` through
   * `updateChannel`. Keeping that update and `commitMarkedFunding` in this one
   * transaction means a ledger refusal rolls the voucher state back. External
   * deposit/refund responses are recorded separately before this transaction
   * commits, leaving a durable reconciliation row if COMMIT fails.
   */
  /**
   * Sanction one cooperative-refund base for the updates inside `operation`.
   *
   * The store cannot derive the base — it comes from the credit ledger — so
   * this is how the settlement layer says "this exact decrease is the one the
   * payer's verified refund voucher authorises". Outside this scope a decrease
   * of `chargedCumulativeAmount` is refused flat, which is what keeps the
   * arbitrary-decrease guard meaningful.
   */
  withSanctionedRefundBase<T>(base: string, operation: () => Promise<T>): Promise<T> {
    return this.refundBase.run(base, operation);
  }

  async withChannelTransaction<T>(
    channelId: string,
    operation: (tx: PoolClient) => Promise<T>,
    hostingFunding?: HostedFundingReservation
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (this.hostingCleanupFence && hostingFunding) {
        await this.hostingCleanupFence.assertFundingReservation(client, hostingFunding);
        this.hostedFunding.set(client, hostingFunding);
      }
      await lockChannel(client, channelId);
      const result = await this.transaction.run(client, () => operation(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      this.hostedFunding.delete(client);
      client.release();
    }
  }

  /** Durable effect bookkeeping reached while a caller already holds a host-pool client. */
  async withSettlementTransaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    const client = await (await this.settlementPoolRef()).connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Run one fleet-wide settlement operation, optionally waiting for the current owner.
   *
   * The lock is session-scoped, so its client stays checked out for the whole
   * operation — and `operation()` (upstream's claim/settle) re-enters the pool
   * through {@link updateChannel}. Two bounds keep that from wedging the pool
   * local callers are serialized in-process, so this holds at most
   * one client per process no matter how many requests arrive, and a waiting
   * acquire carries a `lock_timeout` so a wedged fleet-mate can't pin that
   * client — and the caller's request — indefinitely. A timeout reports the
   * lock as not acquired, which is what every caller already handles.
   *
   * The queue depth is reserved synchronously, before the promise chain can
   * yield. That makes the non-waiting form a true local try-lock even while the
   * first caller is still acquiring its connection: an overlapping request
   * returns `false` instead of queuing behind the facilitator operation.
   */
  async withFleetSettlementLock(operation: () => Promise<unknown>, wait = false): Promise<boolean> {
    // Mirrors pg_try_advisory_lock: a local reservation means "someone is
    // already settling", so don't queue behind its acquire or operation.
    if (!wait && this.fleetLockQueueDepth > 0) return false;
    this.fleetLockQueueDepth += 1;
    const turn = this.fleetLock.then(() => this.runUnderFleetLock(operation, wait));
    this.fleetLock = turn.catch(() => undefined);
    try {
      return await turn;
    } finally {
      this.fleetLockQueueDepth -= 1;
    }
  }

  /**
   * Hold the fleet-wide self-relay submission lock for one chain submission.
   *
   * The session lock keeps one per-DVM gas EOA to one in-flight submission
   * across the whole fleet — two machines submitting at once collide on the
   * nonce. It is reached from `resource.settlePayment` inside
   * {@link withChannelTransaction} and from upstream's claim/settle inside
   * {@link withFleetSettlementLock}, so on both paths a host-pool client is
   * already checked out: it therefore acquires from the terminal settlement
   * pool, which is the rule in this class's doc, and never from the host pool
   * the caller is holding.
   *
   * The wait is bounded by `lock_timeout` and a timeout **refuses** rather than
   * proceeding unlocked, which is where this differs from
   * {@link withFleetSettlementLock}: a fleet lock nobody got means the claim is
   * someone else's turn, while a submission lock nobody got means the caller
   * must not submit at all. The refusal is typed and retryable, and names the
   * holder when Postgres will tell us who it is.
   *
   * The relay's own in-process tail serialises callers before they reach here,
   * so one process pins at most one settlement-pool client no matter how many
   * deposits arrive.
   */
  async withRelaySubmissionLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const pool = await this.settlementPoolRef();
    const client = await pool.connect();
    let locked = false;
    let destroyClient = false;
    try {
      await client.query(`SET lock_timeout = ${String(this.relayLockTimeoutMs)}`);
      try {
        await client.query(RELAY_LOCK_SQL, [key]);
        locked = true;
      } catch (error) {
        if (!isLockTimeout(error)) throw error;
        throw new X402RelaySubmissionLockError(
          key,
          this.relayLockTimeoutMs,
          await relayLockHolder(client, key)
        );
      }
      return await operation();
    } finally {
      if (locked) {
        await client.query(RELAY_UNLOCK_SQL, [key]).catch(() => {
          // An unreleased session lock outlives the request and wedges the
          // fleet, so the connection goes rather than back into the pool.
          destroyClient = true;
        });
      }
      // The client goes back to a shared pool, so the session setting must not.
      await client.query(`RESET lock_timeout`).catch(() => {
        destroyClient = true;
      });
      client.release(destroyClient);
    }
  }

  /** Release the dedicated settlement pool; the host-owned pool is left alone. */
  async close(): Promise<void> {
    const settlement = this.settlementPool;
    this.settlementPool = undefined;
    if (settlement) await (await settlement).end();
  }

  private async settlementWriter(): Promise<X402ChannelQuerier> {
    return this.settlementPoolRef();
  }

  private async settlementPoolRef(): Promise<Pool> {
    this.settlementPool ??= createSettlementPool(this.pool);
    return this.settlementPool;
  }

  private async runUnderFleetLock(
    operation: () => Promise<unknown>,
    wait: boolean
  ): Promise<boolean> {
    const client = await this.pool.connect();
    let locked = false;
    let timeoutSet = false;
    try {
      if (wait) {
        await client.query(`SET lock_timeout = ${FLEET_LOCK_TIMEOUT_MS}`);
        timeoutSet = true;
        try {
          await client.query(
            `SELECT pg_advisory_lock(hashtextextended('x402-batch-settlement', 1762))`
          );
          locked = true;
        } catch (error) {
          if (!isLockTimeout(error)) throw error;
        }
      } else {
        const { rows } = await client.query<{ locked: boolean }>(
          `SELECT pg_try_advisory_lock(hashtextextended('x402-batch-settlement', 1762)) AS locked`
        );
        locked = rows[0]?.locked ?? false;
      }
      if (!locked) return false;
      await operation();
      return true;
    } finally {
      // A failed unlock or RESET means this session still carries state the next
      // borrower must not inherit — a held advisory lock here wedges the fleet
      // lock for the life of the connection, which is the hazard
      // `withRelaySubmissionLock` is written to avoid and this path shared.
      let destroyClient = false;
      if (locked) {
        await client
          .query(`SELECT pg_advisory_unlock(hashtextextended('x402-batch-settlement', 1762))`)
          .catch(() => {
            destroyClient = true;
          });
      }
      // The client goes back to a shared pool, so the session setting must not.
      if (timeoutSet) {
        await client.query(`RESET lock_timeout`).catch(() => {
          destroyClient = true;
        });
      }
      client.release(destroyClient);
    }
  }

  private async updateInTransaction(
    client: PoolClient,
    channelId: string,
    update: (current: Channel | undefined) => Channel | undefined,
    alreadyLocked: boolean
  ): Promise<ChannelUpdateResult> {
    const normalized = normalizeChannelId(channelId);
    if (!alreadyLocked) await lockChannel(client, normalized);
    const { rows } = await client.query<X402ChannelRow>(
      `SELECT * FROM x402_batch_channels WHERE channel_id = $1 FOR UPDATE`,
      [normalized]
    );
    const current = rows[0] ? toChannel(rows[0]) : undefined;
    const next = update(current);

    if (next === undefined) {
      if (!current) return { channel: undefined, status: "unchanged" };
      await client.query(
        `INSERT INTO x402_batch_channel_tombstones
         (channel_id,hosting_binding,charged_cumulative_amount,signed_max_claimable,refund_nonce,pending_request,deleted_at_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (channel_id) DO UPDATE SET
           charged_cumulative_amount=GREATEST(x402_batch_channel_tombstones.charged_cumulative_amount,
             EXCLUDED.charged_cumulative_amount),
           signed_max_claimable=GREATEST(x402_batch_channel_tombstones.signed_max_claimable,
             EXCLUDED.signed_max_claimable),
           refund_nonce=GREATEST(x402_batch_channel_tombstones.refund_nonce,EXCLUDED.refund_nonce),
           pending_request=COALESCE(x402_batch_channel_tombstones.pending_request,EXCLUDED.pending_request)`,
        [normalized, rows[0].hosting_binding, rows[0].charged_cumulative_amount,
          rows[0].signed_max_claimable, rows[0].refund_nonce, rows[0].pending_request, Date.now()]
      );
      await client.query(`DELETE FROM x402_batch_channels WHERE channel_id = $1`, [normalized]);
      return { channel: undefined, status: "deleted" };
    }

    assertChannelTransition(current, next, normalized, this.refundBase.getStore());
    if (this.hostingCleanupFence &&
      (!current || BigInt(next.chargedCumulativeAmount) > BigInt(current.chargedCumulativeAmount) ||
        BigInt(next.signedMaxClaimable) > BigInt(current.signedMaxClaimable))) {
      const funding = this.hostedFunding.get(client);
      if (funding) await this.hostingCleanupFence.assertFundingReservation(client, funding);
      else await this.hostingCleanupFence.assertNewIntent(client);
    }
    if (
      this.terminalizeUnbackedCredit &&
      next.onchainSyncedAt !== undefined &&
      next.onchainSyncedAt !== current?.onchainSyncedAt &&
      next.withdrawRequestedAt === 0 &&
      BigInt(next.balance) === BigInt(next.totalClaimed)
    ) {
      await this.terminalizeUnbackedCredit(
        {
          channelId: normalized,
          channelBalanceNative: BigInt(next.balance),
          totalClaimedNative: BigInt(next.totalClaimed),
          observedAt: next.onchainSyncedAt,
        },
        client
      );
    }
    if (current && sameChannel(current, next)) {
      return { channel: current, status: "unchanged" };
    }
    const prior = !current && this.hostedNetwork
      ? await client.query<{ hosting_binding: unknown }>(
          "SELECT hosting_binding FROM x402_batch_channel_tombstones WHERE channel_id=$1", [normalized]
        ) : undefined;
    await writeChannel(client, normalized, next, this.hostedNetwork,
      prior?.rows[0] ? prior.rows[0].hosting_binding : undefined);
    return { channel: cloneChannel(next), status: "updated" };
  }
}

interface X402ChannelRow {
  channel_id: string;
  channel_config: Channel["channelConfig"];
  charged_cumulative_amount: string;
  signed_max_claimable: string;
  signature: string;
  balance: string;
  total_claimed: string;
  withdraw_requested_at: string;
  refund_nonce: string;
  onchain_synced_at: string | null;
  last_request_timestamp: string;
  pending_request: Channel["pendingRequest"] | null;
  hosting_binding: unknown;
}

interface X402SettlementRow {
  settlement_id: string;
  channel_id: string;
  operation: "fund" | "refund";
  effect_id: string;
  payment_id: string;
  payment_payload: PaymentPayload;
  payment_requirements: PaymentRequirements;
  channel_before: Channel | null;
  channel_at_submission: Channel | null;
  submission_block: string | null;
  pending_id: string | null;
  status: X402SettlementStatus;
  settle_response: SettleResponse | null;
  created_at: Date;
  updated_at: Date;
  write_off_note: string | null;
  resolved_at: string | null;
}

/**
 * Build the dedicated settlement pool from the host pool's own configuration,
 * so it lands on the same database (and the same `search_path`) with no second
 * connection string to wire.
 */
async function createSettlementPool(pool: Pool): Promise<Pool> {
  const pg = await import("pg");
  const options = (pool as unknown as { options?: PoolConfig }).options ?? {};
  const settlement = new pg.default.Pool({
    ...options,
    // pg defines `password` non-enumerably on `pool.options`, so a spread drops
    // it — read it through explicitly or every connection fails to authenticate.
    ...(options.password !== undefined ? { password: options.password } : {}),
    max: SETTLEMENT_POOL_MAX,
    connectionTimeoutMillis: SETTLEMENT_CONNECT_TIMEOUT_MS,
  });
  applyRetryToPool(settlement, "x402-settlement");
  return settlement;
}

/**
 * The relay lock's key encoding, unchanged since it lived in `x402-self-relay.ts`.
 *
 * A rolling deploy runs both builds at once, so old and new machines have to
 * hash the same key into the same lock class or the fleet briefly has two
 * machines free to submit from one EOA.
 */
const RELAY_LOCK_SQL = `SELECT pg_advisory_lock(hashtextextended($1, 1759))`;
const RELAY_UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended($1, 1759))`;

/**
 * Ask Postgres who is holding the relay lock — best effort, never load-bearing.
 *
 * `pg_locks` splits a single-key advisory lock into the high and low halves of
 * the key as OIDs, so the key is re-derived server-side and masked rather than
 * compared as one bigint (`hashtextextended` is signed and the halves are not).
 * The holder can also let go between the timeout and this read, and a role
 * without `pg_read_all_stats` sees only its own backends' details — both are
 * fine, since the refusal stands either way.
 */
async function relayLockHolder(
  client: PoolClient,
  key: string
): Promise<X402RelayLockHolder | undefined> {
  try {
    const { rows } = await client.query<{
      pid: number;
      application_name: string | null;
      client_addr: string | null;
      state: string | null;
      held_seconds: number | null;
    }>(
      `SELECT a.pid,
              a.application_name,
              a.client_addr::text AS client_addr,
              a.state,
              EXTRACT(EPOCH FROM (NOW() - a.query_start))::float8 AS held_seconds
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory'
          AND l.granted
          AND l.classid = ((hashtextextended($1, 1759) >> 32) & 4294967295)::oid
          AND l.objid = (hashtextextended($1, 1759) & 4294967295)::oid
        LIMIT 1`,
      [key]
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      pid: row.pid,
      ...(row.application_name ? { applicationName: row.application_name } : {}),
      ...(row.client_addr ? { clientAddr: row.client_addr } : {}),
      ...(row.state ? { state: row.state } : {}),
      ...(row.held_seconds !== null ? { heldSeconds: Math.round(row.held_seconds) } : {}),
    };
  } catch {
    return undefined;
  }
}

function describeHolder(holder: X402RelayLockHolder): string {
  const parts = [`pid ${String(holder.pid)}`];
  if (holder.applicationName) parts.push(holder.applicationName);
  if (holder.clientAddr) parts.push(holder.clientAddr);
  if (holder.state) parts.push(holder.state);
  if (holder.heldSeconds !== undefined) parts.push(`${String(holder.heldSeconds)}s in`);
  return parts.join(", ");
}

function isLockTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === LOCK_NOT_AVAILABLE
  );
}

function toSettlementIntent(row: X402SettlementRow): X402SettlementIntent {
  if (!row.channel_before) {
    throw new Error(`x402 settlement ${row.settlement_id} has no reconciliation snapshot`);
  }
  return {
    settlementId: row.settlement_id,
    channelId: row.channel_id,
    operation: row.operation,
    effectId: row.effect_id,
    paymentId: row.payment_id,
    payload: row.payment_payload,
    requirements: row.payment_requirements,
    channelBefore: row.channel_before,
    ...(row.channel_at_submission ? { channelAtSubmission: row.channel_at_submission } : {}),
    ...(row.submission_block !== null ? { submissionBlock: row.submission_block } : {}),
    ...(row.pending_id ? { pendingId: row.pending_id } : {}),
    status: row.status,
    ...(row.settle_response ? { response: row.settle_response } : {}),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    ...(row.write_off_note !== null ? { writeOffNote: row.write_off_note } : {}),
    ...(row.resolved_at !== null ? { resolvedAt: Number(row.resolved_at) } : {}),
  };
}

function canRefreshPreparedDepositAuthorization(
  stored: X402SettlementIntent,
  intent: X402SettlementIdentity,
  nowMs: number
): boolean {
  if (
    stored.status !== "prepared" ||
    stored.operation !== "fund" ||
    !isDeepStrictEqual(stored.requirements, intent.requirements)
  )
    return false;
  const before = refreshableDepositAuthorization(stored.payload);
  const after = refreshableDepositAuthorization(intent.payload);
  if (!before || !after || !isDeepStrictEqual(before.shape, after.shape)) return false;
  const nowSeconds = BigInt(Math.floor(nowMs / 1_000));
  return before.validBefore < nowSeconds && after.validBefore > nowSeconds;
}

function refreshableDepositAuthorization(
  payload: PaymentPayload
): { validBefore: bigint; shape: PaymentPayload } | undefined {
  const shape = structuredClone(payload);
  const body = objectRecord(shape.payload);
  const deposit = objectRecord(body?.deposit);
  const wrapper = objectRecord(deposit?.authorization);
  const authorization = objectRecord(wrapper?.erc3009Authorization);
  const validBefore = authorization?.validBefore;
  const signature = authorization?.signature;
  if (
    !authorization ||
    body?.type !== "deposit" ||
    typeof validBefore !== "string" ||
    !/^\d+$/.test(validBefore) ||
    typeof signature !== "string" ||
    signature.length === 0
  )
    return undefined;
  delete authorization.validBefore;
  delete authorization.salt;
  delete authorization.signature;
  return { validBefore: BigInt(validBefore), shape };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function lockChannel(client: PoolClient, channelId: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 1762))`, [
    normalizeChannelId(channelId),
  ]);
}

async function writeChannel(
  client: PoolClient,
  channelId: string,
  channel: Channel,
  hostedNetwork?: string,
  priorBinding?: unknown
): Promise<void> {
  const binding = priorBinding !== undefined ? priorBinding : hostedNetwork ? {
    network: hostedNetwork,
    chainId: Number(x402NetworkByCaip2(hostedNetwork)?.caip2.split(":")[1]),
    contract: BATCH_SETTLEMENT_ADDRESS.toLowerCase(),
    version: "x402-batch-settlement-v1",
    channelId,
  } : null;
  await client.query(
    `INSERT INTO x402_batch_channels (
       channel_id, channel_config, charged_cumulative_amount, signed_max_claimable,
       signature, balance, total_claimed, withdraw_requested_at, refund_nonce,
       onchain_synced_at, last_request_timestamp, pending_request, hosting_binding
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (channel_id) DO UPDATE SET
       channel_config = EXCLUDED.channel_config,
       charged_cumulative_amount = EXCLUDED.charged_cumulative_amount,
       signed_max_claimable = EXCLUDED.signed_max_claimable,
       signature = EXCLUDED.signature,
       balance = EXCLUDED.balance,
       total_claimed = EXCLUDED.total_claimed,
       withdraw_requested_at = EXCLUDED.withdraw_requested_at,
       refund_nonce = EXCLUDED.refund_nonce,
       onchain_synced_at = EXCLUDED.onchain_synced_at,
       last_request_timestamp = EXCLUDED.last_request_timestamp,
       pending_request = EXCLUDED.pending_request`,
    [
      channelId,
      channel.channelConfig,
      channel.chargedCumulativeAmount,
      channel.signedMaxClaimable,
      channel.signature,
      channel.balance,
      channel.totalClaimed,
      channel.withdrawRequestedAt,
      channel.refundNonce,
      channel.onchainSyncedAt ?? null,
      channel.lastRequestTimestamp,
      channel.pendingRequest ?? null,
      binding,
    ]
  );
}

function toChannel(row: X402ChannelRow): Channel {
  return {
    channelId: row.channel_id,
    channelConfig: row.channel_config,
    chargedCumulativeAmount: row.charged_cumulative_amount,
    signedMaxClaimable: row.signed_max_claimable,
    signature: row.signature,
    balance: row.balance,
    totalClaimed: row.total_claimed,
    withdrawRequestedAt: safeInteger(row.withdraw_requested_at, "withdraw_requested_at"),
    refundNonce: safeInteger(row.refund_nonce, "refund_nonce"),
    ...(row.onchain_synced_at !== null
      ? { onchainSyncedAt: safeInteger(row.onchain_synced_at, "onchain_synced_at") }
      : {}),
    lastRequestTimestamp: safeInteger(row.last_request_timestamp, "last_request_timestamp"),
    ...(row.pending_request ? { pendingRequest: row.pending_request } : {}),
  };
}

function assertChannelTransition(
  current: Channel | undefined,
  next: Channel,
  expectedId: string,
  sanctionedRefundBase: string | undefined
): void {
  if (normalizeChannelId(next.channelId) !== expectedId) {
    throw new Error(`x402 channel update changed channelId ${expectedId}`);
  }
  if (!current) return;
  if (!isDeepStrictEqual(current.channelConfig, next.channelConfig)) {
    throw new Error(`x402 channel ${expectedId} attempted to mutate immutable channelConfig`);
  }
  // A cooperative drain lowers claim authority to a base the settlement layer
  // derives from the credit ledger, so the store cannot recompute it — but it
  // must not therefore admit *any* decrease. The base is handed in through
  // `withSanctionedRefundBase` for the one update that applies it, and only
  // that exact figure is accepted; every other path keeps the flat "never
  // decrease" rule. The floor (`totalClaimed`), the untouched payer voucher and
  // the absence of a live reservation are checked on top.
  const revokesUnclaimedAuthority =
    sanctionedRefundBase !== undefined &&
    BigInt(next.chargedCumulativeAmount) < BigInt(current.chargedCumulativeAmount) &&
    BigInt(next.chargedCumulativeAmount) === BigInt(sanctionedRefundBase) &&
    BigInt(next.chargedCumulativeAmount) >= BigInt(next.totalClaimed) &&
    next.signedMaxClaimable === current.signedMaxClaimable &&
    next.signature === current.signature &&
    current.pendingRequest === undefined &&
    next.pendingRequest === undefined;
  if (
    BigInt(next.chargedCumulativeAmount) < BigInt(current.chargedCumulativeAmount) &&
    !revokesUnclaimedAuthority
  ) {
    throw new Error(`x402 channel ${expectedId} attempted to decrease chargedCumulativeAmount`);
  }
  if (BigInt(next.totalClaimed) < BigInt(current.totalClaimed)) {
    throw new Error(`x402 channel ${expectedId} attempted to decrease totalClaimed`);
  }
  // The refund's own reservation re-signs the voucher at exactly the revoked
  // base, so `signedMaxClaimable` drops to `chargedCumulativeAmount` and no
  // lower — never to an arbitrary figure.
  const reservesRevokedVoucher =
    BigInt(next.signedMaxClaimable) < BigInt(current.signedMaxClaimable) &&
    next.chargedCumulativeAmount === current.chargedCumulativeAmount &&
    next.signedMaxClaimable === next.chargedCumulativeAmount &&
    current.pendingRequest === undefined &&
    next.pendingRequest !== undefined;
  if (
    BigInt(next.signedMaxClaimable) < BigInt(current.signedMaxClaimable) &&
    !reservesRevokedVoucher &&
    (!current.pendingRequest ||
      next.pendingRequest ||
      BigInt(next.signedMaxClaimable) < BigInt(next.chargedCumulativeAmount))
  ) {
    throw new Error(`x402 channel ${expectedId} attempted to decrease signedMaxClaimable`);
  }
  if (next.refundNonce < current.refundNonce) {
    throw new Error(`x402 channel ${expectedId} attempted to decrease refundNonce`);
  }
}

function sameChannel(left: Channel, right: Channel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneChannel(channel: Channel): Channel {
  return structuredClone(channel);
}

function normalizeChannelId(channelId: string): string {
  const normalized = channelId.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`x402 channelId must be a canonical bytes32 value; got ${channelId}`);
  }
  return normalized;
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`x402 channel ${field} exceeds JavaScript's safe integer range`);
  }
  return parsed;
}
