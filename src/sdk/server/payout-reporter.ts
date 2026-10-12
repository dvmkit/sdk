import { diagnosticConsole } from "../../observability/diagnostic-console";
/**
 * Payouts record landed builder custody, distinct from job revenue, caller deposits and
 * refunds. Cashu funding is reported here only when later melted; a caller channel exit and a
 * stuck movement are not payouts.
 */
import { createHash, randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { ChannelDrainCursor, CreditDrainRecord } from "./credit-ledger";
import type { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import { withSdkInitLock } from "./init-lock";
import type { RevenueReporterQuerier } from "./revenue-reporter";

/** The rails a payout lands on. Lightning never pays out: credits fund straight into the receive wallet. */
export type PayoutRail = "cashu" | "x402" | "tempo";

/**
 * Transfers aggregate payments: a Cashu melt, x402 batch to pay_to, or Tempo recipient
 * settlement/close.
 */
export type PayoutKind = "melt" | "batch" | "close" | "settle";

export type PayoutRepairKind =
  | "x402_settlement_reconciled"
  | "lightning_invoice_reconciled"
  | "tempo_close_reconciled";

/**
 * One landed movement into builder custody. Platform retries deduplicate by (dvmId,
 * payoutId); repaired redelivery upgrades that movement rather than adding another.
 */
export interface PayoutReportPayload {
  /**
   * Platform record ID; must match the bearer token’s DVM.
   */
  dvmId: string;
  /** Required. The DVM's own id for the movement — `cashu:melt:<quote>`, `x402:batch:<uuid>`, `tempo:<tx>`. */
  payoutId: string;
  rail: PayoutRail;
  kind: PayoutKind;
  /**
   * Positive rail-native atomic units: sats or USDC micro.
   */
  nativeAmount: number;
  nativeAsset: "sats" | "usdc";
  /** Where it landed; `null` for a melt, whose Lightning destination the platform never records. */
  recipient: string | null;
  /**
   * Descriptive mechanism references, never an arithmetic basis.
   */
  refs: Record<string, unknown>;
  /** Required. When the money landed (epoch ms). */
  landedAt: number;
  repaired?: boolean;
  /** Required iff `repaired`. */
  repairKind?: PayoutRepairKind;
}

export interface PayoutWedge {
  id: string;
  /**
   * `settle`: an x402 batch whose transfer keeps failing (auto-retried).
   * `refund`: an x402 cooperative refund wedged between chain and ledger —
   * caller money, not in the pool. `close`: a Tempo close wedged the same way.
   * `melt`: cashu rows whose builder-side melt failed.
   */
  kind: "settle" | "refund" | "close" | "melt";
  /** Epoch ms the wedge was first observed. */
  since: number;
  /** Retry count where the retry is automatic, else null. */
  attempts: number | null;
  /** Epoch ms of the next automatic retry, else null. */
  nextRetry: number | null;
  lastError: string | null;
  /** Rail-native amount held up, when known. */
  native?: number;
}

export interface PayoutPool {
  id: string;
  native: number;
  label?: string;
}

/**
 * A replaceable snapshot of one rail’s pending builder funds. Best-effort delivery uses no
 * durable queue; a later tick supersedes a lost report.
 */
export interface PayoutPendingPayload {
  dvmId: string;
  rail: PayoutRail;
  /** Everything on this rail still moving toward the builder, in atomic units. */
  poolNative: number;
  nativeAsset: "sats" | "usdc";
  items: number;
  pools: PayoutPool[];
  wedged: PayoutWedge[];
  /** This DVM's clock when the snapshot was taken (epoch ms). */
  snapshotAt: number;
}

export interface PayoutTransport {
  /**
   * Queue a payout through the caller's open transaction, so the row and the
   * fact it reports commit or roll back together; without `tx` it is queued on
   * its own. Durable once committed — the retry loop delivers it, or
   * {@link PayoutTransport.drainPending} when a caller wants it now.
   */
  enqueuePayout(payload: PayoutReportPayload, tx?: RevenueReporterQuerier): Promise<void>;
  enqueueHostedPayout?(payload: PayoutReportPayload, obligationIds: string[],
    tx?: RevenueReporterQuerier): Promise<void>;
  /** Queue a payout on its own and try to deliver it at once. */
  reportPayout(payload: PayoutReportPayload): Promise<void>;
  /** Best-effort: one POST, replaced by the next snapshot. */
  reportPayoutPending(payload: PayoutPendingPayload): Promise<void>;
  /** Deliver what is queued now rather than on the next retry tick. */
  drainPending?(): Promise<void>;
}

/**
 * enqueue joins the money transaction and must throw on failure so its fact rolls back.
 * committed runs after commit, when delivery and snapshots can safely read the new state.
 */
export interface TransactionalPayoutHook<E> {
  enqueue(event: E, tx: RevenueReporterQuerier): Promise<void>;
  committed(): void;
}

export interface CashuMeltCompleted {
  rows: { id: string; mintUrl: string; proofAmount: number }[];
  meltQuoteId: string;
  paymentPreimage: string;
}

export interface TempoSessionSettled {
  txHash: string;
  channelId: string;
  trigger: "settle" | "close" | "scheduled";
  /** Cumulative amount settled to the payee on this channel, atomic units. */
  amount: bigint;
  /** Newly settled to the payee by this transaction, atomic units. */
  delta: bigint;
}

export interface TempoCloseReconciled {
  channelId: string;
  txHash: string;
  /** Captured by the payee — this DVM — per the receipt, atomic units as a decimal string. */
  settledToPayee: string;
}

export interface X402TrackedChannel {
  channelId: string;
  chargedCumulativeAmount: string;
  totalClaimed: string;
}

export interface X402WedgedRefund {
  settlementId: string;
  /** Epoch ms the settlement was first prepared. */
  createdAt: number;
  native?: number;
}

/**
 * The most a batch-settlement channel may ever claim: `min(charged, earned)`.
 * `charged` includes the caller's unspent credit deposit, which stays the
 * caller's; `earned` is what the bound credit's settled draws have earned. The
 * claim selector presents this figure and the payout reporter counts only what
 * lies between it and `totalClaimed` as pending; both read it through this
 * helper.
 */
export type X402EarnedCeiling =
  | { kind: "ceiling"; ceiling: bigint }
  /** The channel has no bound credit, so nothing it holds is earned. */
  | { kind: "unbound" }
  /** The ledger read threw; the channel's earned figure is unknown. */
  | { kind: "unresolved"; error: unknown };

/** Rail-native value the channel's credit has earned; `undefined` when no credit is bound. */
export type X402EarnedNative = (channelId: string) => Promise<number | undefined>;

export async function x402EarnedCeiling(
  channel: { channelId: string; chargedCumulativeAmount: string },
  earnedNative: X402EarnedNative
): Promise<X402EarnedCeiling> {
  let earned: number | undefined;
  try {
    // The ledger records the id `accept()` bound to the credit, which is the
    // lowercased form.
    earned = await earnedNative(channel.channelId.toLowerCase());
  } catch (error) {
    return { kind: "unresolved", error };
  }
  if (earned === undefined) return { kind: "unbound" };
  const charged = BigInt(channel.chargedCumulativeAmount);
  const wanted = BigInt(earned);
  // The clamp keeps a claim inside the payer's authorization even if the
  // ledger reports more than was charged.
  return { kind: "ceiling", ceiling: wanted < charged ? wanted : charged };
}

export interface X402PayoutContext {
  /** `${network}|${payTo}|${token}` — the scope the settle-pending marker is keyed on. */
  scope: string;
  payTo: string;
  network: string;
  storage: { list(): Promise<X402TrackedChannel[]> };
  /**
   * The claim ceiling's earned figure for a channel. Pending counts only what a
   * claim could present, so a channel's unspent deposit is never reported as
   * the builder's.
   */
  earnedNative: X402EarnedNative;
  /** The scheduler's settle cadence — what a wedge's `nextRetry` is derived from. */
  settleIntervalMs: number;
  listWedgedRefunds?: () => Promise<X402WedgedRefund[]>;
}

export interface X402TrackedManager {
  claim(...args: never[]): Promise<{ vouchers: number; transaction: string }[]>;
  settle(): Promise<{ transaction: string }>;
  refund?(channelIds?: string[]): Promise<{ channel: string; transaction: string }[]>;
}

/**
 * The batch-settlement server's view of the reporter: attach once with the
 * scope, then route every claim and settle through the tracked manager so
 * the open batch is kept and the settle emits the payout.
 */
export interface X402PayoutObserver {
  attach(ctx: X402PayoutContext): void;
  trackManager<M extends X402TrackedManager>(manager: M): M;
  /** A settle that landed outside the tracked manager — the manual claim-and-settle's own retry loop. */
  recordSettle(transaction: string): Promise<void>;
  /** A settle attempt that failed outside the tracked manager. One call per attempt a builder would count as one. */
  recordSettleFailure(error: unknown): Promise<void>;
  /** A credit-drain refund's bundled claim, recorded after its exact pre-effect reservation. */
  recordRefundClaim?(transaction: string, delta: bigint): Promise<void>;
}

export interface TempoPayoutReader {
  recipient?: string;
  /** CAIP-2 network for the refs, when known. */
  network?: string;
  listActive?: (
    limit: number,
    cursor?: { updatedAt: number; key: string }
  ) => Promise<{ key: string; state: Record<string, unknown>; updatedAt: number }[]>;
  listChannelDrains?: (args: {
    limit: number;
    after?: ChannelDrainCursor;
    createdBeforeMs: number;
    rail: "tempo";
  }) => Promise<CreditDrainRecord[]>;
}

/**
 * Claims accumulated since the last settle. The batch is durable across machines: claims and
 * eventual settlement can run on different hosts under the fleet lock.
 */
export interface X402OpenBatch {
  scope: string;
  batchId: string;
  claimedNative: bigint;
  voucherCount: number;
  claims: number;
  openedAt: number;
  attempts: number;
  firstFailedAt: number | null;
  lastError: string | null;
  nextRetryAt: number | null;
  obligationIds?: string[];
}

export interface X402BatchStore {
  get(scope: string): Promise<X402OpenBatch | undefined>;
  put(batch: X402OpenBatch): Promise<void>;
  delete(scope: string): Promise<void>;
  /**
   * Atomically delete the matching batch and enqueue its payout. Failed enqueue preserves the
   * batch for retry; false means the scope no longer holds batchId and nothing was queued.
   */
  settle(
    scope: string,
    batchId: string,
    enqueue: (tx?: RevenueReporterQuerier) => Promise<void>
  ): Promise<boolean>;
}

export class MemoryX402BatchStore implements X402BatchStore {
  private readonly batches = new Map<string, X402OpenBatch>();

  get(scope: string): Promise<X402OpenBatch | undefined> {
    return Promise.resolve(this.batches.get(scope));
  }

  put(batch: X402OpenBatch): Promise<void> {
    this.batches.set(batch.scope, { ...batch });
    return Promise.resolve();
  }

  delete(scope: string): Promise<void> {
    this.batches.delete(scope);
    return Promise.resolve();
  }

  async settle(
    scope: string,
    batchId: string,
    enqueue: (tx?: RevenueReporterQuerier) => Promise<void>
  ): Promise<boolean> {
    const open = this.batches.get(scope);
    if (open?.batchId !== batchId) return false;
    this.batches.delete(scope);
    try {
      await enqueue();
    } catch (err) {
      // No transaction to roll back here: put the batch back by hand, so the
      // next settle still reports it.
      this.batches.set(scope, open);
      throw err;
    }
    return true;
  }
}

export class PostgresX402BatchStore implements X402BatchStore {
  constructor(private readonly db: Pool) {}

  async init(): Promise<void> {
    await withSdkInitLock(this.db, async () => {
      await this.db.query(`
        CREATE TABLE IF NOT EXISTS payout_x402_batches (
          scope           TEXT PRIMARY KEY,
          batch_id        TEXT NOT NULL,
          claimed_native  NUMERIC(78, 0) NOT NULL DEFAULT 0,
          voucher_count   INTEGER NOT NULL DEFAULT 0,
          claims          INTEGER NOT NULL DEFAULT 0,
          opened_at       BIGINT NOT NULL,
          attempts        INTEGER NOT NULL DEFAULT 0,
          first_failed_at BIGINT,
          last_error      TEXT,
          next_retry_at   BIGINT,
          obligation_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at      BIGINT NOT NULL
        )
      `);
      await this.db.query(
        "ALTER TABLE payout_x402_batches ADD COLUMN IF NOT EXISTS obligation_ids JSONB NOT NULL DEFAULT '[]'::jsonb"
      );
    });
  }

  async get(scope: string): Promise<X402OpenBatch | undefined> {
    const { rows } = await this.db.query<{
      scope: string;
      batch_id: string;
      claimed_native: string;
      voucher_count: number;
      claims: number;
      opened_at: string;
      attempts: number;
      first_failed_at: string | null;
      last_error: string | null;
      next_retry_at: string | null;
      obligation_ids: string[];
    }>("SELECT * FROM payout_x402_batches WHERE scope = $1", [scope]);
    const row = rows.at(0);
    if (!row) return undefined;
    return {
      scope: row.scope,
      batchId: row.batch_id,
      claimedNative: BigInt(row.claimed_native),
      voucherCount: row.voucher_count,
      claims: row.claims,
      openedAt: Number(row.opened_at),
      attempts: row.attempts,
      firstFailedAt: row.first_failed_at === null ? null : Number(row.first_failed_at),
      lastError: row.last_error,
      nextRetryAt: row.next_retry_at === null ? null : Number(row.next_retry_at),
      ...(row.obligation_ids.length ? { obligationIds: row.obligation_ids } : {}),
    };
  }

  async put(batch: X402OpenBatch): Promise<void> {
    await this.db.query(
      `INSERT INTO payout_x402_batches (
         scope, batch_id, claimed_native, voucher_count, claims, opened_at,
         attempts, first_failed_at, last_error, next_retry_at, obligation_ids, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (scope) DO UPDATE SET
         batch_id = EXCLUDED.batch_id,
         claimed_native = EXCLUDED.claimed_native,
         voucher_count = EXCLUDED.voucher_count,
         claims = EXCLUDED.claims,
         opened_at = EXCLUDED.opened_at,
         attempts = EXCLUDED.attempts,
         first_failed_at = EXCLUDED.first_failed_at,
         last_error = EXCLUDED.last_error,
         next_retry_at = EXCLUDED.next_retry_at,
         obligation_ids = EXCLUDED.obligation_ids,
         updated_at = EXCLUDED.updated_at`,
      [
        batch.scope,
        batch.batchId,
        batch.claimedNative.toString(),
        batch.voucherCount,
        batch.claims,
        batch.openedAt,
        batch.attempts,
        batch.firstFailedAt,
        batch.lastError,
        batch.nextRetryAt,
        JSON.stringify(batch.obligationIds ?? []),
        Date.now(),
      ]
    );
  }

  async delete(scope: string): Promise<void> {
    await this.db.query("DELETE FROM payout_x402_batches WHERE scope = $1", [scope]);
  }

  async settle(
    scope: string,
    batchId: string,
    enqueue: (tx?: RevenueReporterQuerier) => Promise<void>
  ): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query(
        "DELETE FROM payout_x402_batches WHERE scope = $1 AND batch_id = $2",
        [scope, batchId]
      );
      if (!rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await enqueue(client);
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

export interface PayoutReporterOpts {
  dvmId: string;
  transport: PayoutTransport;
  /**
   * Postgres holds durable x402 batches and supplies Cashu snapshots. Without it, the default
   * batch store is memory and Cashu snapshots are omitted.
   */
  db?: Pool;
  /**
   * Only accumulator hosts create wallet_accumulator; enabling this on another host makes
   * each snapshot query fail.
   */
  cashu?: boolean;
  /** Override the batch store (tests); defaults to Postgres on `db`, memory without. */
  batchStore?: X402BatchStore;
  hostedObligations?: HostedSettlementReportObligations;
  /** Snapshot cadence, ms. Default 5 minutes. */
  snapshotIntervalMs?: number;
  now?: () => number;
}

export const PAYOUT_SNAPSHOT_INTERVAL_MS = 5 * 60_000;

/**
 * Cashu melts and repaired Tempo closes enqueue inside their caller’s transaction and
 * propagate failures. x402 reporting and pending snapshots instead log failures; failed x402
 * enqueue preserves the open batch for retry.
 */
export class PayoutReporter implements PayoutTransport {
  private readonly dvmId: string;
  private readonly transport: PayoutTransport;
  private readonly db?: Pool;
  private readonly cashu: boolean;
  private readonly batches: X402BatchStore;
  private readonly ownsBatchStore: boolean;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly hostedObligations?: HostedSettlementReportObligations;
  private lastX402SnapshotAt = 0;
  private x402?: X402PayoutContext;
  private tempo?: TempoPayoutReader;
  private timer: ReturnType<typeof setInterval> | null = null;
  private warmup: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PayoutReporterOpts) {
    this.dvmId = opts.dvmId;
    this.transport = opts.transport;
    this.db = opts.db;
    this.cashu = opts.cashu ?? false;
    this.ownsBatchStore = !opts.batchStore;
    this.batches =
      opts.batchStore ??
      (opts.db ? new PostgresX402BatchStore(opts.db) : new MemoryX402BatchStore());
    this.intervalMs = opts.snapshotIntervalMs ?? PAYOUT_SNAPSHOT_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.hostedObligations = opts.hostedObligations;
  }

  async init(): Promise<void> {
    if (this.ownsBatchStore && this.batches instanceof PostgresX402BatchStore) {
      await this.batches.init();
    }
  }

  /**
   * Start the snapshot loop. Unref'd, so it never keeps a scale-to-zero
   * machine awake; a first snapshot runs shortly after boot so a fresh process
   * reports without waiting a whole interval.
   */
  start(): void {
    if (this.timer) return;
    this.warmup = setTimeout(() => {
      void this.snapshot();
      void this.reconcileHosted();
    }, WARMUP_MS);
    this.warmup.unref();
    this.timer = setInterval(() => {
      void this.snapshot();
      void this.reconcileHosted();
    }, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.warmup) clearTimeout(this.warmup);
    this.warmup = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async reconcileHosted(): Promise<void> {
    if (!this.hostedObligations) return;
    try {
      for (const failure of await this.hostedObligations.recoverOriginalX402Refunds()) {
        warn("hosted_refund_recovery_pending", { id: failure.id, error: message(failure.error) });
      }
      for (const candidate of await this.hostedObligations.recoveryCandidates()) {
        if (candidate.blockHash) continue;
        try {
          await this.hostedObligations.observeCanonical(candidate.id);
        } catch (error) {
          warn("hosted_effect_observation_pending", { id: candidate.id, error: message(error) });
        }
      }
      for (const failure of await this.hostedObligations.reconcileX402Batches()) {
        warn("hosted_batch_recovery_pending", { id: failure.id, error: message(failure.error) });
      }
      for (const candidate of await this.hostedObligations.recoveryCandidates()) {
        if (!candidate.blockHash || candidate.reportId) continue;
        try {
          if (candidate.rail === "tempo" &&
            (candidate.operation === "settle" || candidate.operation === "close") &&
            candidate.deltaNative !== null && BigInt(candidate.deltaNative) > 0n) {
            await this.tempoSettled({ txHash: candidate.txHash, channelId: candidate.channelId,
              trigger: candidate.operation, amount: BigInt(candidate.deltaNative),
              delta: BigInt(candidate.deltaNative) });
          } else if (candidate.rail === "x402" && candidate.operation === "settle" && this.x402) {
            await this.recordX402Settle(this.x402, candidate.txHash);
          }
        } catch (error) {
          warn("hosted_effect_report_pending", { id: candidate.id, error: message(error) });
        }
      }
    } catch (error) {
      warn("hosted_effect_recovery_pending", { error: message(error) });
    }
  }

  enqueuePayout(payload: PayoutReportPayload, tx?: RevenueReporterQuerier): Promise<void> {
    return this.transport.enqueuePayout(payload, tx);
  }

  reportPayout(payload: PayoutReportPayload): Promise<void> {
    return this.transport.reportPayout(payload);
  }

  reportPayoutPending(payload: PayoutPendingPayload): Promise<void> {
    return this.transport.reportPayoutPending(payload);
  }

  /** Deliver what is queued now; a transport without the seam waits for its retry loop. */
  async flush(): Promise<void> {
    try {
      await this.transport.drainPending?.();
    } catch (err) {
      warn("payout_flush_failed", { error: message(err) });
    }
  }

  meltHook(): TransactionalPayoutHook<CashuMeltCompleted> {
    return {
      enqueue: (event, tx) => this.cashuMelted(event, tx),
      committed: () => {
        void this.flush();
        void this.snapshotCashu();
      },
    };
  }

  /**
   * Report melted face value per mint, not the Lightning amount received after fees. Hash the
   * payment preimage; do not publish it. With tx, propagate enqueue failures and defer
   * delivery until commit. Without tx, enqueue independently and start delivery.
   */
  async cashuMelted(event: CashuMeltCompleted, tx?: RevenueReporterQuerier): Promise<void> {
    const byMint = new Map<string, { sats: number; proofs: number }>();
    for (const row of event.rows) {
      const group = byMint.get(row.mintUrl) ?? { sats: 0, proofs: 0 };
      group.sats += row.proofAmount;
      group.proofs += 1;
      byMint.set(row.mintUrl, group);
    }
    const preimageHash = createHash("sha256").update(event.paymentPreimage).digest("hex");
    const landedAt = this.now();
    const mints = [...byMint.entries()];
    for (const [index, [mint, group]] of mints.entries()) {
      if (group.sats <= 0) continue;
      await this.enqueuePayout(
        {
          dvmId: this.dvmId,
          payoutId:
            mints.length === 1
              ? `cashu:melt:${event.meltQuoteId}`
              : `cashu:melt:${event.meltQuoteId}:${index}`,
          rail: "cashu",
          kind: "melt",
          nativeAmount: group.sats,
          nativeAsset: "sats",
          recipient: null,
          refs: {
            mint,
            meltQuoteId: event.meltQuoteId,
            preimageHash,
            proofCount: group.proofs,
          },
          landedAt,
        },
        tx
      );
    }
    if (!tx) {
      void this.flush();
      void this.snapshotCashu();
    }
  }

  attachTempo(reader: TempoPayoutReader): void {
    this.tempo = reader;
  }

  /**
   * A Tempo channel settled or closed on chain. `delta` is what this
   * transaction newly paid the recipient; a transaction that paid nothing new
   * (a close of a fully settled channel) is no payout.
   */
  async tempoSettled(event: TempoSessionSettled): Promise<void> {
    try {
      let hostedIds: string[] | undefined;
      if (this.hostedObligations) {
        hostedIds = await this.hostedObligations.submittedIds("tempo",
          event.trigger === "close" ? "close" : "settle", event.txHash);
        if (hostedIds.length === 1) {
          const observed = await this.hostedObligations.observeCanonical(hostedIds[0]);
          if (BigInt(observed.deltaNative) !== event.delta) {
            throw new Error("Hosted Tempo callback differs from finalized settlement amount");
          }
        } else if (await this.hostedObligations.hasCompleteHistory()) {
          throw new Error("Hosted Tempo payout has no exact original settlement obligation");
        }
      }
      if (event.delta <= 0n) return;
      const payload: PayoutReportPayload = {
        dvmId: this.dvmId,
        payoutId: `tempo:${event.txHash}`,
        rail: "tempo",
        kind: event.trigger === "close" ? "close" : "settle",
        nativeAmount: Number(event.delta),
        nativeAsset: "usdc",
        recipient: this.tempo?.recipient ?? null,
        refs: {
          channelId: event.channelId,
          txHash: event.txHash,
          trigger: event.trigger,
          ...(this.tempo?.network ? { network: this.tempo.network } : {}),
        },
        landedAt: this.now(),
      };
      if (this.hostedObligations) {
        if (hostedIds?.length !== 1 || !this.transport.enqueueHostedPayout) {
          if (await this.hostedObligations.hasCompleteHistory()) {
            throw new Error("Hosted Tempo payout has no exact original settlement obligation");
          }
          await this.reportPayout(payload);
        } else {
          await this.transport.enqueueHostedPayout(payload, hostedIds);
          void this.flush();
        }
      } else {
        await this.reportPayout(payload);
      }
    } catch (err) {
      warn("payout_report_failed", { rail: "tempo", kind: event.trigger, error: message(err) });
      if (this.hostedObligations) throw err;
    }
    void this.snapshotTempo();
  }

  tempoRepairHook(): TransactionalPayoutHook<TempoCloseReconciled> {
    return {
      enqueue: (event, tx) => this.tempoCloseReconciled(event, tx),
      committed: () => {
        void this.flush();
        void this.snapshotTempo();
      },
    };
  }

  /**
   * Report the receipt’s payee total under the live close’s transaction ID, flagged repaired.
   * The platform upgrades a live row if one exists. Join tx and propagate enqueue failures;
   * this does not report the caller refund.
   */
  async tempoCloseReconciled(
    event: TempoCloseReconciled,
    tx?: RevenueReporterQuerier
  ): Promise<void> {
    let settled = BigInt(event.settledToPayee);
    let hostedIds: string[] | undefined;
    if (this.hostedObligations) {
      hostedIds = await this.hostedObligations.submittedIds("tempo", "close", event.txHash);
      if (hostedIds.length === 1) {
        const alreadySettled = await this.hostedObligations.originalTempoCloseSettled(
          hostedIds[0], event.channelId, event.txHash
        );
        settled -= alreadySettled;
        if (settled < 0n) throw new Error("Hosted Tempo repair precedes its original settled amount");
      } else if (await this.hostedObligations.hasCompleteHistory(tx)) {
        throw new Error("Hosted Tempo repair has no original close obligation");
      }
    }
    if (settled <= 0n) return;
    const payload: PayoutReportPayload = {
        dvmId: this.dvmId,
        payoutId: `tempo:${event.txHash}`,
        rail: "tempo",
        kind: "close",
        nativeAmount: Number(settled),
        nativeAsset: "usdc",
        recipient: this.tempo?.recipient ?? null,
        refs: {
          channelId: event.channelId,
          txHash: event.txHash,
          trigger: "close",
          ...(this.tempo?.network ? { network: this.tempo.network } : {}),
        },
        landedAt: this.now(),
        repaired: true,
        repairKind: "tempo_close_reconciled",
      };
    if (hostedIds?.length === 1) {
      if (!this.transport.enqueueHostedPayout) {
        throw new Error("Hosted Tempo repair lacks its durable report queue");
      }
      await this.transport.enqueueHostedPayout(payload, hostedIds, tx);
    } else {
      await this.enqueuePayout(payload, tx);
    }
    if (!tx) {
      void this.flush();
      void this.snapshotTempo();
    }
  }

  x402Observer(): X402PayoutObserver {
    return {
      attach: (ctx) => {
        this.x402 = ctx;
      },
      trackManager: <M extends X402TrackedManager>(manager: M): M => this.trackX402Manager(manager),
      recordSettle: async (transaction) => {
        const ctx = this.x402;
        if (ctx) await this.recordX402Settle(ctx, transaction);
        void this.snapshotX402();
      },
      recordSettleFailure: async (error) => {
        const ctx = this.x402;
        if (ctx) await this.recordX402SettleFailure(ctx, error);
        void this.snapshotX402();
      },
      recordRefundClaim: async (transaction, delta) => {
        const ctx = this.x402;
        if (!ctx) throw new Error("Hosted x402 refund has no payout context");
        await this.recordX402Claim(ctx, { delta, vouchers: 1,
          transactions: [transaction], operation: "refund" });
        void this.snapshotX402();
      },
    };
  }

  /**
   * Read claim deltas from storage because upstream returns voucher counts. Under the fleet
   * lock, before/after reads are consistent. A deleted channel contributes its pre-claim
   * unclaimed value, including refund claim-then-delete.
   */
  private trackX402Manager<M extends X402TrackedManager>(manager: M): M {
    const claim = async (...args: never[]) => {
      const ctx = this.x402;
      const before = ctx ? await claimedByChannel(ctx.storage) : new Map<string, ClaimedView>();
      const results = await manager.claim(...args);
      if (ctx && results.length > 0) {
        const after = await claimedByChannel(ctx.storage);
        let delta = 0n;
        for (const [channelId, now] of after) {
          const prior = before.get(channelId)?.claimed ?? 0n;
          if (now.claimed > prior) delta += now.claimed - prior;
        }
        for (const [channelId, prior] of before) {
          if (!after.has(channelId) && prior.charged > prior.claimed) {
            delta += prior.charged - prior.claimed;
          }
        }
        await this.recordX402Claim(ctx, {
          delta,
          vouchers: results.reduce((sum, r) => sum + r.vouchers, 0),
          transactions: results.map((result) => result.transaction),
        });
        void this.snapshotX402();
      }
      return results;
    };
    const settle = async () => {
      const ctx = this.x402;
      try {
        const result = await manager.settle();
        if (ctx) await this.recordX402Settle(ctx, result.transaction);
        void this.snapshotX402();
        return result;
      } catch (err) {
        if (ctx) await this.recordX402SettleFailure(ctx, err);
        void this.snapshotX402();
        throw err;
      }
    };
    const refund = async (channelIds?: string[]) => {
      const ctx = this.x402;
      const before = ctx ? await claimedByChannel(ctx.storage) : new Map<string, ClaimedView>();
      const results = await manager.refund!(channelIds);
      if (ctx && this.hostedObligations) {
        for (const result of results) {
          const original = before.get(result.channel.toLowerCase());
          if (!original) throw new Error("Hosted x402 refund lost its original channel snapshot");
          const delta = original.charged - original.claimed;
          if (delta > 0n) {
            await this.recordX402Claim(ctx, { delta, vouchers: 1,
              transactions: [result.transaction], operation: "refund" });
          }
        }
      }
      return results;
    };
    return new Proxy(manager, {
      get(target, prop, receiver) {
        if (prop === "claim") return claim;
        if (prop === "settle") return settle;
        if (prop === "refund" && target.refund) return refund;
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  }

  private async recordX402Claim(
    ctx: X402PayoutContext,
    claim: { delta: bigint; vouchers: number; transactions: string[];
      operation?: "claim" | "refund" }
  ): Promise<void> {
    try {
      const now = this.now();
      const existing = await this.batches.get(ctx.scope);
      if (this.hostedObligations && !existing) {
        throw new Error("Hosted x402 claim lost its pre-effect payout batch");
      }
      const open = existing ?? {
        scope: ctx.scope,
        batchId: randomUUID(),
        claimedNative: 0n,
        voucherCount: 0,
        claims: 0,
        openedAt: now,
        attempts: 0,
        firstFailedAt: null,
        lastError: null,
        nextRetryAt: null,
      };
      open.claimedNative += claim.delta;
      open.voucherCount += claim.vouchers;
      open.claims += 1;
      if (this.hostedObligations) {
        const ids = (await Promise.all(claim.transactions.map((txHash) =>
          this.hostedObligations!.submittedIds("x402", claim.operation ?? "claim",
            txHash, open.batchId)))).flat();
        if (!ids.length || ids.length < claim.vouchers || new Set(ids).size !== ids.length) {
          throw new Error("Hosted x402 claim has no exact reserved voucher set");
        }
        open.obligationIds = [...new Set([...(open.obligationIds ?? []), ...ids])];
      }
      await this.batches.put(open);
    } catch (err) {
      warn("payout_batch_track_failed", { scope: ctx.scope, error: message(err) });
      if (this.hostedObligations) throw err;
    }
  }

  private async recordX402Settle(ctx: X402PayoutContext, transaction: string): Promise<void> {
    try {
      const open = await this.batches.get(ctx.scope);
      if (!open) {
        warn("payout_batch_untracked", { scope: ctx.scope, transaction });
        return;
      }
      if (open.claimedNative <= 0n) {
        await this.batches.delete(ctx.scope);
        warn("payout_batch_empty", { scope: ctx.scope, transaction, batchId: open.batchId });
        return;
      }
      if (this.hostedObligations) {
        if (!open.obligationIds?.length) {
          throw new Error("Hosted x402 payout has no original claim identities");
        }
        const settleId = await this.hostedObligations.settlementId(open.batchId, transaction);
        const settled = await this.hostedObligations.observeCanonical(settleId);
        if (BigInt(settled.deltaNative) !== open.claimedNative) {
          throw new Error("Hosted x402 settled amount differs from its original batch");
        }
        let claimed = 0n;
        for (const id of open.obligationIds) {
          claimed += BigInt((await this.hostedObligations.observeCanonical(id)).deltaNative);
        }
        if (claimed !== open.claimedNative) {
          throw new Error("Hosted x402 batch amount differs from finalized original claims");
        }
      }
      const payload: PayoutReportPayload = {
        dvmId: this.dvmId,
        payoutId: `x402:batch:${open.batchId}`,
        rail: "x402",
        kind: "batch",
        nativeAmount: Number(open.claimedNative),
        nativeAsset: "usdc",
        recipient: ctx.payTo,
        refs: {
          batchId: open.batchId,
          txHash: transaction,
          voucherCount: open.voucherCount,
          claims: open.claims,
          network: ctx.network,
        },
        landedAt: this.now(),
      };
      const closed = await this.batches.settle(ctx.scope, open.batchId, async (tx) => {
        if (!this.hostedObligations) return this.enqueuePayout(payload, tx);
        if (!this.transport.enqueueHostedPayout || !open.obligationIds?.length) {
          throw new Error("Hosted x402 payout lacks its original claims or durable queue");
        }
        const settleId = await this.hostedObligations.settlementId(open.batchId, transaction);
        await this.transport.enqueueHostedPayout(payload,
          [...open.obligationIds, settleId], tx);
      });
      if (!closed) {
        warn("payout_batch_raced", { scope: ctx.scope, transaction, batchId: open.batchId });
        return;
      }
    } catch (err) {
      warn("payout_report_failed", { rail: "x402", kind: "batch", error: message(err) });
      if (this.hostedObligations) throw err;
      return;
    }
    void this.flush();
  }

  private async recordX402SettleFailure(ctx: X402PayoutContext, err: unknown): Promise<void> {
    try {
      const open = await this.batches.get(ctx.scope);
      if (!open) return;
      const now = this.now();
      open.attempts += 1;
      open.firstFailedAt ??= now;
      open.lastError = settleErrorReason(err);
      open.nextRetryAt = now + ctx.settleIntervalMs;
      await this.batches.put(open);
    } catch (trackErr) {
      warn("payout_batch_track_failed", { scope: ctx.scope, error: message(trackErr) });
    }
  }

  /** Every rail this reporter can read, each on its own failure boundary. */
  async snapshot(): Promise<void> {
    await this.snapshotCashu();
    await this.snapshotX402();
    await this.snapshotTempo();
  }

  /**
   * Cashu: every unmelted proof in the accumulator, per mint. Rows whose
   * builder-side melt failed are still in the pool (they are still at the
   * mint) and listed as wedged until `restart-failed` clears them.
   */
  async snapshotCashu(): Promise<void> {
    if (!this.db || !this.cashu) return;
    try {
      const { rows } = await this.db.query<{
        mint_url: string;
        melt_status: string | null;
        sats: string;
        proofs: number;
        since: string;
      }>(
        `SELECT mint_url, melt_status, SUM(proof_amount)::text AS sats,
                COUNT(*)::int AS proofs, MIN(received_at)::text AS since
           FROM wallet_accumulator
          WHERE dvm_id = $1 AND melted_at IS NULL
          GROUP BY mint_url, melt_status`,
        [this.dvmId]
      );
      const byMint = new Map<string, { native: number; proofs: number }>();
      const wedged: PayoutWedge[] = [];
      let poolNative = 0;
      for (const row of rows) {
        const sats = Number(row.sats);
        poolNative += sats;
        const pool = byMint.get(row.mint_url) ?? { native: 0, proofs: 0 };
        pool.native += sats;
        pool.proofs += row.proofs;
        byMint.set(row.mint_url, pool);
        if (row.melt_status === "failed") {
          wedged.push({
            id: `cashu:melt-failed:${row.mint_url}`,
            kind: "melt",
            since: Number(row.since),
            attempts: null,
            nextRetry: null,
            lastError: "melt_failed",
            native: sats,
          });
        }
      }
      await this.reportPayoutPending({
        dvmId: this.dvmId,
        rail: "cashu",
        poolNative,
        nativeAsset: "sats",
        items: byMint.size,
        pools: [...byMint.entries()].map(([mint, pool]) => ({
          id: mint,
          native: pool.native,
          label: `${pool.proofs} proofs`,
        })),
        wedged,
        snapshotAt: this.now(),
      });
    } catch (err) {
      warn("payout_pending_snapshot_failed", { rail: "cashu", error: message(err) });
    }
  }

  /**
   * x402: the open batch (claimed, not yet transferred) plus every channel's
   * earned value not yet claimed — a channel whose earned figure cannot be
   * read contributes nothing; wedged when the settle keeps failing, and the
   * refund settlements stuck between chain and ledger beside it.
   */
  async snapshotX402(): Promise<void> {
    const ctx = this.x402;
    if (!ctx) return;
    // Reserve the timestamp before the first read. Snapshot construction can
    // overlap, so stamping at delivery lets a slow older read masquerade as
    // newer state. The strict increment matters because the platform accepts
    // equal timestamps as replacements too.
    const snapshotAt = Math.max(this.now(), this.lastX402SnapshotAt + 1);
    this.lastX402SnapshotAt = snapshotAt;
    try {
      const pools: PayoutPool[] = [];
      const wedged: PayoutWedge[] = [];
      const open = await this.batches.get(ctx.scope);
      if (open && open.claimedNative > 0n) {
        pools.push({
          id: open.batchId,
          native: Number(open.claimedNative),
          label: "claimed, awaiting settle",
        });
        if (open.attempts > 0) {
          wedged.push({
            id: open.batchId,
            kind: "settle",
            since: open.firstFailedAt ?? open.openedAt,
            attempts: open.attempts,
            nextRetry: open.nextRetryAt,
            lastError: open.lastError,
            native: Number(open.claimedNative),
          });
        }
      }
      const unclaimed: PayoutPool[] = [];
      for (const channel of await ctx.storage.list()) {
        const claimed = BigInt(channel.totalClaimed);
        // Nothing left under the authorization: skip the ledger read, as the
        // claim selector does.
        if (BigInt(channel.chargedCumulativeAmount) <= claimed) continue;
        let resolved: X402EarnedCeiling;
        try {
          resolved = await x402EarnedCeiling(channel, ctx.earnedNative);
        } catch (err) {
          resolved = { kind: "unresolved", error: err };
        }
        if (resolved.kind === "unresolved") {
          warn("payout_pending_snapshot_failed", {
            rail: "x402",
            "channel.id": channel.channelId,
            error: message(resolved.error),
          });
          continue;
        }
        if (resolved.kind === "unbound") continue;
        const owed = resolved.ceiling - claimed;
        if (owed > 0n) {
          unclaimed.push({
            id: channel.channelId,
            native: Number(owed),
            label: "earned, awaiting claim",
          });
        }
      }
      // The open batch keeps its own pool whatever the cap — it is what a
      // wedge points at — so the channels share what is left of the row.
      pools.push(...capPools(unclaimed, MAX_POOLS - pools.length));
      if (ctx.listWedgedRefunds) {
        for (const refund of await ctx.listWedgedRefunds()) {
          wedged.push({
            id: refund.settlementId,
            kind: "refund",
            since: refund.createdAt,
            attempts: null,
            nextRetry: null,
            lastError: null,
            ...(refund.native !== undefined ? { native: refund.native } : {}),
          });
        }
      }
      await this.reportPayoutPending({
        dvmId: this.dvmId,
        rail: "x402",
        poolNative: pools.reduce((sum, pool) => sum + pool.native, 0),
        nativeAsset: "usdc",
        items: pools.length,
        pools,
        wedged,
        snapshotAt,
      });
    } catch (err) {
      warn("payout_pending_snapshot_failed", { rail: "x402", error: message(err) });
    }
  }

  /**
   * Tempo: each active channel's spent-but-unsettled balance — earned, not
   * yet paid to the recipient — and the cooperative closes wedged between
   * chain and ledger, aged past the same floor the repair queue
   * uses so an in-flight close is not reported as stuck.
   */
  async snapshotTempo(): Promise<void> {
    const reader = this.tempo;
    if (!reader?.listActive) return;
    try {
      const pools: PayoutPool[] = [];
      let cursor: { updatedAt: number; key: string } | undefined;
      for (let page = 0; page < MAX_TEMPO_PAGES; page++) {
        const rows = await reader.listActive(100, cursor);
        for (const row of rows) {
          const state = row.state;
          if (state.finalized === true) continue;
          const spent = asBigInt(state.spent);
          const settled = asBigInt(state.settledOnChain);
          if (spent === undefined || settled === undefined || spent <= settled) continue;
          pools.push({
            id: typeof state.channelId === "string" ? state.channelId : row.key,
            native: Number(spent - settled),
            label: "earned, awaiting settlement",
          });
        }
        if (rows.length < 100) break;
        const last = rows[rows.length - 1];
        cursor = { updatedAt: last.updatedAt, key: last.key };
      }
      const wedged: PayoutWedge[] = [];
      if (reader.listChannelDrains) {
        const drains = await reader.listChannelDrains({
          limit: 50,
          createdBeforeMs: this.now() - WEDGE_MIN_AGE_MS,
          rail: "tempo",
        });
        for (const drain of drains) {
          wedged.push({
            id: `${drain.creditId}:${drain.drainId}`,
            kind: "close",
            since: drain.createdAt,
            attempts: null,
            nextRetry: null,
            lastError: null,
            ...(drain.drainedNative !== null ? { native: drain.drainedNative } : {}),
          });
        }
      }
      const capped = capPools(pools);
      await this.reportPayoutPending({
        dvmId: this.dvmId,
        rail: "tempo",
        poolNative: capped.reduce((sum, pool) => sum + pool.native, 0),
        nativeAsset: "usdc",
        items: capped.length,
        pools: capped,
        wedged,
        snapshotAt: this.now(),
      });
    } catch (err) {
      warn("payout_pending_snapshot_failed", { rail: "tempo", error: message(err) });
    }
  }
}

const WARMUP_MS = 5_000;
/** How old a pending channel drain must be before it counts as wedged — the repair queue's own floor. */
const WEDGE_MIN_AGE_MS = 5 * 60_000;
/** Bound on the channels one snapshot lists individually; the tail is one aggregate pool. */
const MAX_POOLS = 50;
const MAX_TEMPO_PAGES = 20;

interface ClaimedView {
  claimed: bigint;
  charged: bigint;
}

async function claimedByChannel(storage: {
  list(): Promise<X402TrackedChannel[]>;
}): Promise<Map<string, ClaimedView>> {
  const view = new Map<string, ClaimedView>();
  for (const channel of await storage.list()) {
    view.set(channel.channelId.toLowerCase(), {
      claimed: BigInt(channel.totalClaimed),
      charged: BigInt(channel.chargedCumulativeAmount),
    });
  }
  return view;
}

/**
 * Keep the largest pools whole and fold the rest into one, so a wide fleet
 * still fits a row: the result never exceeds `limit` entries.
 */
function capPools(pools: PayoutPool[], limit = MAX_POOLS): PayoutPool[] {
  const keep = Math.max(1, limit);
  if (pools.length <= keep) return pools;
  const sorted = [...pools].sort((a, b) => b.native - a.native);
  const head = sorted.slice(0, keep - 1);
  const tail = sorted.slice(keep - 1);
  head.push({
    id: "other",
    native: tail.reduce((sum, pool) => sum + pool.native, 0),
    label: `${tail.length} more`,
  });
  return head;
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * A settle failure's class, never its message verbatim: upstream builds the
 * message from whatever the signer threw, and a viem error can quote the
 * credential-bearing RPC URL. The reason enum is safe; otherwise
 * the error's name plus a URL-stripped, bounded excerpt.
 */
function settleErrorReason(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    typeof (err as { errorReason?: unknown }).errorReason === "string"
  ) {
    return (err as { errorReason: string }).errorReason;
  }
  const name = err instanceof Error ? err.name : "Error";
  const text = message(err)
    .replace(/https?:\/\/\S+/g, "<url>")
    .slice(0, 160);
  return text ? `${name}: ${text}` : name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(level: string, fields: Record<string, unknown>): void {
  diagnosticConsole.warn({ level, ...fields });
}
