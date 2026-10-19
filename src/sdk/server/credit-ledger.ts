import { diagnosticConsole } from "../../observability/diagnostic-console";
import { randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { isSignedJobReceipt, verifyReceipt, type FundingReceipt } from "../../lib/receipt";
import type { FundingMethod } from "../types";
import {
  depleteLots,
  DRAIN_DELIVERY_RESERVE_SATS,
  type FundingLot,
  inKindDrawMsats,
  isInKindDepletion,
  isNonChannelBitcoinRail,
  type LotDebit,
  netOwedSats,
  type NonChannelBitcoinRail,
} from "./credit-lots";
import { refundAssetDelta, refundRequest, type CreditDrawRefundArgs, type CreditDrawRefundResult } from "./credit-draw-refund";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence } from "./hosting-cleanup-fence";
import type {
  CreditDepositEnqueue,
  CreditDepositPayload,
  CreditDrawReleaseEnqueue,
  CreditExpiryReleaseEnqueue,
  CreditExpiryReleasePayload,
} from "./revenue-reporter";
import {
  X402_SPEND_BLOCKING_SETTLEMENT_STATUSES,
  X402_WEDGED_SETTLEMENT_STATUSES,
  type X402RefundSettlementGate,
  type X402SettlementStatus,
  type X402UnresolvedRefund,
} from "./x402-channel-store";

export interface TempoSessionSettlementStore {
  withDrawPlacement<value>(
    channelId: string,
    operation: (tx: CreditLedgerQuerier, lifecycle: TempoSessionLifecycle) => Promise<value>,
    tx?: CreditLedgerQuerier
  ): Promise<value>;
  withTerminalConsumption<value>(
    channelId: string,
    operation: (
      tx: CreditLedgerQuerier,
      lifecycle: TempoSessionLifecycle
    ) => Promise<{
      value: value;
      amount: bigint;
      consume: boolean;
    }>
  ): Promise<value>;
}

export interface TempoSessionLifecycle {
  finalized: boolean;
  closeRequestedAt: bigint;
  spent: bigint;
  settledOnChain: bigint;
  highestVoucherAmount: bigint;
}

/** Chain-proven evidence used to retire credit whose Tempo backing is gone. */
export interface TempoCreditLossEvidence {
  channelId: string;
  settledOnChainNative: bigint;
  highestVoucherNative: bigint;
  consumedNative: bigint;
  observedAt?: number;
}

export interface TempoCreditLoss {
  creditId: string;
  channelId: string;
  callerPubkey: string;
  currency: string;
  formerBalanceMicro: number;
  settledOnChainNative: bigint;
  highestVoucherNative: bigint;
  consumedServiceMicro: number;
  consumedNative: bigint;
  observedAt: number;
}

/** Chain-proven evidence that an x402 channel no longer backs its bound credit. */
export interface X402CreditLossEvidence {
  channelId: string;
  channelBalanceNative: bigint;
  totalClaimedNative: bigint;
  observedAt?: number;
}

export interface X402CreditLoss {
  creditId: string;
  channelId: string;
  callerPubkey: string;
  currency: string;
  formerBalanceMicro: number;
  channelBalanceNative: bigint;
  totalClaimedNative: bigint;
  consumedServiceMicro: number;
  observedAt: number;
}

/**
 * Every write to credit_draws takes SELECT … FOR UPDATE on its parent credit within the same
 * transaction. That lock keeps the pending-hold sum and available balance stable across
 * machines; KV storage cannot provide this money boundary.
 *
 * The ledger is host-wide: credit_id and caller_pubkey identify rows, without a per-mount
 * dvm_id. Draws hold funds until settlement or release, and share a gap-free per-credit
 * ledger_seq with drains and completed-draw refunds.
 */
export class CreditLedger {
  /**
   * Postgres-backed: balances survive a restart and are shared across the
   * fleet, so this DVM may advertise credit.
   */
  readonly durable = true;

  private x402Settlements?: X402RefundSettlementGate;

  private expiryReleaseOutbox?: CreditExpiryReleaseOutbox;
  private hostingCleanupFence?: HostingCleanupFence;
  private readonly invoiceSettlementClients = new WeakSet<CreditLedgerQuerier>();

  constructor(
    private readonly pool: CreditLedgerPool,
    private readonly tempoSessionStore?: TempoSessionSettlementStore
  ) {}

  /**
   * Bound after construction because the settlement store shares this ledger and is
   * initialized separately. Ledger effects and route preflights use the same refund gate.
   */
  useX402SettlementGate(gate: X402RefundSettlementGate): void {
    this.x402Settlements = gate;
  }

  /**
   * Expiry release and revival reports join the ledger transaction. A caller-owned funding
   * transaction must not commit a reversal independently of its outbox row. Without this
   * wiring, ledger transitions still run.
   */
  useCreditExpiryReleaseOutbox(outbox: CreditExpiryReleaseOutbox): void {
    this.expiryReleaseOutbox = outbox;
  }

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credits (
        credit_id        TEXT PRIMARY KEY,
        caller_pubkey    TEXT NOT NULL,
        currency         TEXT NOT NULL,
        balance_micro    BIGINT NOT NULL,
        expiry_ms        BIGINT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'active',
        last_ledger_seq  BIGINT NOT NULL DEFAULT 0,
        created_at       BIGINT NOT NULL,
        rail             TEXT,
        native_asset     TEXT,
        mint             TEXT,
        funding_ref      TEXT,
        tempo_channel_id TEXT,
        msats_remaining  BIGINT NOT NULL DEFAULT 0,
        native_remaining BIGINT,
        x402_channel_id  TEXT
      );
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tempo_credit_losses (
        credit_id                 TEXT PRIMARY KEY,
        channel_id                TEXT NOT NULL,
        caller_pubkey             TEXT NOT NULL,
        currency                  TEXT NOT NULL,
        former_balance_micro      BIGINT NOT NULL,
        settled_on_chain_native   BIGINT NOT NULL,
        highest_voucher_native    BIGINT NOT NULL,
        consumed_service_micro    BIGINT NOT NULL,
        consumed_native           BIGINT NOT NULL,
        observed_at               BIGINT NOT NULL
      );
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_tempo_credit_losses_observed
         ON tempo_credit_losses(observed_at, credit_id);`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS x402_credit_losses (
        credit_id                 TEXT PRIMARY KEY,
        channel_id                TEXT NOT NULL,
        caller_pubkey             TEXT NOT NULL,
        currency                  TEXT NOT NULL,
        former_balance_micro      BIGINT NOT NULL,
        channel_balance_native    BIGINT NOT NULL,
        total_claimed_native      BIGINT NOT NULL,
        consumed_service_micro    BIGINT NOT NULL,
        observed_at               BIGINT NOT NULL
      );
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_x402_credit_losses_observed
         ON x402_credit_losses(observed_at, credit_id);`
    );
    // rail-value basis on credits created before it existed. NULL
    // `native_remaining` is meaningful — it marks a rail that reports no
    // native amount (cashu, where msats is the only basis), distinct from a
    // fully-drawn credit at 0.
    for (const column of [
      "rail TEXT",
      "native_asset TEXT",
      "mint TEXT",
      "funding_ref TEXT",
      "tempo_channel_id TEXT",
      "msats_remaining BIGINT NOT NULL DEFAULT 0",
      "native_remaining BIGINT",
      "x402_channel_id TEXT",
      "last_funding_ledger_seq BIGINT",
    ]) {
      await this.pool.query(`ALTER TABLE credits ADD COLUMN IF NOT EXISTS ${column}`);
    }
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credits_caller ON credits(caller_pubkey);`
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS credits_x402_channel_uidx
         ON credits(x402_channel_id) WHERE x402_channel_id IS NOT NULL;`
    );
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_draws (
        credit_id           TEXT NOT NULL,
        draw_id             TEXT NOT NULL,
        amount_micro        BIGINT NOT NULL,
        job_id              TEXT,
        ledger_seq          BIGINT NOT NULL,
        status              TEXT NOT NULL,
        balance_after_micro BIGINT NOT NULL,
        created_at          BIGINT NOT NULL,
        resolved_at         BIGINT,
        draw_msats          BIGINT NOT NULL DEFAULT 0,
        draw_native         BIGINT,
        grown_micro         BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (credit_id, draw_id)
      );
    `);
    // `grown_micro` is the cumulative mid-job growth `growDraw` has
    // applied, tracked apart from `amount_micro` so the cap bounds only the
    // top-up portion and the upfront draw needs no figure of its own. 0 is the
    // right historical default — a row written before this existed is bounded
    // by nothing, and the preflight refuses to cap a job it has no ask total
    // for anyway.
    // what `allocateDrawValue` stamped on this draw when the payment
    // landed, kept only where the settle's FIFO re-price later moved
    // `draw_msats` off it. NULL is the whole of history and every row that was
    // never re-priced — there `draw_msats` *is* the allocation, so a backfill
    // would write the column it already reads. It exists because the job row's
    // `paid_msats` can carry legs the draw never absorbed (a cross-rail
    // mid-job top-up books no ledger row at all), so booking revenue means
    // correcting the draw's own component of that total rather than replacing
    // it — and that needs both figures.
    for (const column of [
      "draw_msats BIGINT NOT NULL DEFAULT 0",
      "draw_native BIGINT",
      "grown_micro BIGINT NOT NULL DEFAULT 0",
      "allocated_msats BIGINT",
      "settled_sats BIGINT",
      "refund_dvm_id TEXT",
    ]) {
      await this.pool.query(`ALTER TABLE credit_draws ADD COLUMN IF NOT EXISTS ${column}`);
    }
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_draw_refunds (
        refund_id TEXT PRIMARY KEY,
        credit_id TEXT NOT NULL,
        draw_id TEXT NOT NULL,
        request TEXT NOT NULL,
        amount_micro BIGINT NOT NULL CHECK (amount_micro > 0),
        restored_sats BIGINT,
        result JSONB NOT NULL
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS credit_draw_refunds_draw_idx
      ON credit_draw_refunds(credit_id, draw_id)`);
    // The unique index prevents duplicate sequence ownership if a later write path violates
    // the locking protocol.
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_draws_seq_uidx
         ON credit_draws(credit_id, ledger_seq);`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_draws_pending
         ON credit_draws(credit_id) WHERE status = 'pending';`
    );
    // the orphan sweeper's read is host-wide and age-ordered, so the
    // per-credit partial index above can't serve it. Normally matches nothing
    // a hold only survives past the age cutoff when its job row never landed.
    // Columns are the sweeper's full `ORDER BY`, so its keyset cursor seeks
    // straight to the next page instead of re-walking the rows it skipped.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_draws_pending_age
         ON credit_draws(created_at, credit_id, ledger_seq) WHERE status = 'pending';`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_draws_job_id
         ON credit_draws(job_id) WHERE job_id IS NOT NULL;`
    );
    // fund is additive and has no idempotency key. Rail replay markers protect implicit
    // payments; fund-only top-ups use (credit_id, fund_id) to prevent double funding.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_fundings (
        credit_id    TEXT NOT NULL,
        fund_id      TEXT NOT NULL,
        amount_micro BIGINT NOT NULL,
        rail         TEXT,
        created_at   BIGINT NOT NULL,
        PRIMARY KEY (credit_id, fund_id)
      );
    `);
    // CREATE TABLE does not upgrade existing tables; add the nullable rail metadata
    // idempotently.
    await this.pool.query(`ALTER TABLE credit_fundings ADD COLUMN IF NOT EXISTS rail TEXT`);
    for (const column of [
      "caller_pubkey TEXT",
      "balance_after_micro BIGINT",
      "ledger_seq BIGINT",
      "receipt JSONB",
    ]) {
      await this.pool.query(`ALTER TABLE credit_fundings ADD COLUMN IF NOT EXISTS ${column}`);
    }
    // Funding lots retain each non-channel Bitcoin deposit’s sats and purchased credit micro.
    // credit_fundings has neither the instrument amount nor every funding event. FIFO uses
    // (created_at, lot_id); a surrogate ID avoids coordinating concurrent fundings on a lot
    // counter.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_funding_lots (
        lot_id          TEXT PRIMARY KEY,
        credit_id       TEXT NOT NULL,
        rail            TEXT NOT NULL,
        sats_funded     BIGINT NOT NULL,
        credited_micro  BIGINT NOT NULL,
        remaining_micro BIGINT NOT NULL,
        funding_ref     TEXT,
        created_at      BIGINT NOT NULL
      );
    `);
    // Existing zero-sat lots have no recorded basis; only explicit new evidence can mark
    // zero as known. Positive legacy lots already prove their sats denomination.
    await this.pool.query(`ALTER TABLE credit_funding_lots
      ADD COLUMN IF NOT EXISTS sats_basis_known BOOLEAN NOT NULL DEFAULT false`);
    // Every read here is "this credit's open lots, oldest first" — depletion
    // on settle, depletion on reclaim, and the liability rollup. Depleted lots
    // stay on the table as the deposit's audit trail but are out of the index.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_funding_lots_open
         ON credit_funding_lots(credit_id, created_at, lot_id) WHERE remaining_micro > 0;`
    );
    await this.backfillFundingLots();
    // A drain debits available balance and records the outstanding reclaim. Its (credit_id,
    // drain_id) primary key is a separate idempotency boundary from draws, implicit payments
    // and fund-only top-ups.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_drains (
        credit_id           TEXT NOT NULL,
        drain_id            TEXT NOT NULL,
        method              TEXT NOT NULL,
        payout              JSONB NOT NULL,
        amount_micro        BIGINT NOT NULL,
        balance_after_micro BIGINT NOT NULL,
        drained_msats       BIGINT NOT NULL DEFAULT 0,
        drained_native      BIGINT,
        owed_sats           BIGINT,
        lot_debits          JSONB,
        ledger_seq          BIGINT NOT NULL,
        status              TEXT NOT NULL,
        token               TEXT,
        sent_ref            JSONB,
        receipts            JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at          BIGINT NOT NULL,
        parked_at           BIGINT,
        picked_up_at        BIGINT,
        sent_at             BIGINT,
        released_at         BIGINT,
        PRIMARY KEY (credit_id, drain_id)
      );
    `);
    // Upgrade existing tables idempotently. Legacy drains have no recorded receipt balance,
    // so the historical default is zero.
    await this.pool.query(
      `ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS balance_after_micro BIGINT NOT NULL DEFAULT 0`
    );
    await this.pool.query(
      `ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS drained_msats BIGINT NOT NULL DEFAULT 0`
    );
    await this.pool.query(
      `ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS drained_native BIGINT`
    );
    // owed_sats fixes the in-kind reclaim at request time. NULL means the funding lots cannot
    // price it, including legacy basisless or uncovered credit; consumers fall back to a live
    // rate.
    await this.pool.query(`ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS owed_sats BIGINT`);
    await this.pool.query(`ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS lot_debits JSONB`);
    await this.pool.query(`ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS released_at BIGINT`);
    // how a parked refund was actually sourced, and what handing it
    // over cost. NULL on every row parked out of the accumulator, which is the
    // ordinary case and needs no evidence — the consumed rows are the record.
    await this.pool.query(`ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS fulfilment JSONB`);
    // the operator's decision on a channel drain the payout floor
    // refused. Two nullable columns rather than a separate drain status, because
    // a write-off books nothing and moves no money — the drain is still
    // `pending`, its balance still debited, and a later reconcile still books
    // it through the ordinary `pending → sent` CAS with no widening.
    await this.pool.query(`ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS write_off_note TEXT`);
    await this.pool.query(
      `ALTER TABLE credit_drains ADD COLUMN IF NOT EXISTS written_off_at BIGINT`
    );
    // Tempo's native unit is the ledger's six-decimal micro unit. Rows from
    // before drain release existed need that basis reconstructed or releasing
    // one would restore fiat with no channel value behind future draws.
    await this.pool.query(
      `UPDATE credit_drains d SET drained_native = d.amount_micro
       FROM credits c
       WHERE d.credit_id = c.credit_id
         AND c.tempo_channel_id IS NOT NULL
         AND d.drained_native IS NULL`
    );
    // Rename stored mpp rail values to tempo so legitimate top-ups and revenue reads
    // recognize them. Preserve opaque imp:mpp credit IDs referenced by other tables;
    // processed-payment markers, not rederived credit IDs, guard payment replay.
    await this.pool.query(`UPDATE credits SET rail = 'tempo' WHERE rail = 'mpp'`);
    await this.pool.query(`UPDATE credit_fundings SET rail = 'tempo' WHERE rail = 'mpp'`);
    await this.pool.query(`UPDATE credit_drains SET method = 'tempo' WHERE method = 'mpp'`);
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_drains_seq_uidx
         ON credit_drains(credit_id, ledger_seq);`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_drains_pending
         ON credit_drains(status) WHERE status = 'pending';`
    );
    // The durable invoice binds a bolt11 to its credit and funding ID while payment settles
    // outside the request. Re-polling (credit_id, fund_id) returns that invoice; unique
    // payment_hash prevents one wallet payment from binding to two fundings.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_invoices (
        credit_id     TEXT NOT NULL,
        fund_id       TEXT NOT NULL,
        caller_pubkey TEXT NOT NULL,
        currency      TEXT NOT NULL,
        amount_micro  BIGINT NOT NULL,
        amount_msats  BIGINT NOT NULL,
        payment_hash  TEXT NOT NULL,
        bolt11        TEXT NOT NULL,
        status        TEXT NOT NULL,
        blocked_reason TEXT,
        expires_at    BIGINT NOT NULL,
        created_at    BIGINT NOT NULL,
        settled_at    BIGINT,
        hosting_admission_id TEXT,
        created_at_db_us BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint,
        PRIMARY KEY (credit_id, fund_id)
      );
    `);
    // CREATE TABLE IF NOT EXISTS cannot add blocked_reason to an existing invoice table.
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS blocked_reason TEXT`
    );
    // Keep the wallet settlement instant separate from a later operator resolution;
    // bookkeeping must not redate the payment.
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS reconciled_credit_id TEXT`
    );
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS reconciled_fund_id TEXT`
    );
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS resolved_at BIGINT`
    );
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS write_off_note TEXT`
    );
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS hosting_admission_id TEXT`
    );
    await this.pool.query(
      `ALTER TABLE credit_invoices ADD COLUMN IF NOT EXISTS created_at_db_us BIGINT NOT NULL
       DEFAULT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000000)::bigint`
    );
    await this.pool.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS credit_invoices_hash_uidx
         ON credit_invoices(payment_hash);`
    );
    // Only pending invoices need wallet lookup. Terminal rows must not occupy the bounded
    // settlement window and starve payable invoices.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_invoices_pending
         ON credit_invoices(caller_pubkey, created_at) WHERE status = 'pending';`
    );
    // The operator queue spans callers and pages blocked invoices by this compound key.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_invoices_blocked
         ON credit_invoices(created_at, credit_id, fund_id) WHERE status = 'blocked';`
    );
    // Each expiry release is an episode, keyed by expiry instant and a sequence counted under
    // the credit lock. Funding reverses standing releases; a revival at the same expiry can
    // later produce a new episode.
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS credit_expiry_releases (
        credit_id     TEXT NOT NULL,
        release_id    TEXT NOT NULL,
        caller_pubkey TEXT NOT NULL,
        currency      TEXT NOT NULL,
        rail          TEXT,
        amount_micro  BIGINT NOT NULL,
        expiry_ms     BIGINT NOT NULL,
        released_at   BIGINT NOT NULL,
        reversed_at   BIGINT,
        PRIMARY KEY (credit_id, release_id)
      );
    `);
    // The sweep's exclusion read and the revival's update both ask the same
    // question — does this credit have a release that still stands — so the
    // index is partial on exactly that.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_credit_expiry_releases_open
         ON credit_expiry_releases(credit_id) WHERE reversed_at IS NULL;`
    );
  }

  /**
   * Backfill an open non-channel Bitcoin credit only when it has no funding lot. Pair
   * balance_micro with current msats_remaining; credit_fundings lacks historical instrument
   * amounts and does not cover every funding path. Historical per-funding rates cannot be
   * recovered. Existing lots are left untouched, so this does not repair partial coverage
   * gaps.
   */
  private async backfillFundingLots(): Promise<void> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO credit_funding_lots
         (lot_id, credit_id, rail, sats_funded, credited_micro, remaining_micro, funding_ref, created_at)
       SELECT 'lot:backfill:' || c.credit_id, c.credit_id, c.rail,
              c.msats_remaining / 1000, c.balance_micro, c.balance_micro, c.funding_ref, c.created_at
         FROM credits c
        WHERE ${BITCOIN_CREDIT_PREDICATE}
          AND NOT EXISTS (SELECT 1 FROM credit_funding_lots l WHERE l.credit_id = c.credit_id)
       ON CONFLICT (lot_id) DO NOTHING`
    );
    // Report uncovered balance separately from lots with no sats basis. Any basisless lot
    // makes the entire reclaim use the live-rate fallback; a mixture cannot be priced partly
    // in kind.
    const { rows } = await this.pool.query<{ uncovered: string; unbacked: string }>(
      `SELECT COUNT(*) FILTER (WHERE cov.covered_micro < c.balance_micro) AS uncovered,
              COUNT(*) FILTER (WHERE cov.covered_micro >= c.balance_micro AND cov.basisless_micro > 0)
                AS unbacked
         FROM credits c
         CROSS JOIN LATERAL (${LOT_COVERAGE_LATERAL}) cov
        WHERE ${BITCOIN_CREDIT_PREDICATE}`
    );
    const uncovered = Number(rows[0]?.uncovered ?? 0);
    const unbacked = Number(rows[0]?.unbacked ?? 0);
    if (rowCount === 0 && uncovered === 0 && unbacked === 0) return;
    diagnosticConsole.warn(
      {
        level: uncovered > 0 ? "warn" : "info",
        event: "credit_funding_lot_backfill",
        backfilled: rowCount ?? 0,
        uncovered_credits: uncovered,
        unbacked_credits: unbacked,
        message:
          undefined,
      }
    );
  }

  /**
   * Funding adds balance and overwrites expiry, reviving an expired credit. It is additive,
   * not idempotent: the caller’s rail marker or funding record must prevent replay. Owner and
   * currency must match; rail and reusable-channel bindings cannot be mixed with other
   * instruments. A legacy NULL rail adopts its first typed top-up.
   *
   * With tx, all writes join the caller’s transaction without transaction control. Otherwise
   * the ledger owns a transaction covering balance, funding lot, reversal of standing expiry
   * releases and their reports. A partial revival would leave restored balance with a release
   * still counted.
   *
   * An incoming x402 channel with an unresolved refund is refused before the upsert. That
   * preflight is not atomic with a concurrent cooperative drain; see the incoming-channel
   * gate below.
   */
  async fund(args: CreditFundArgs): Promise<CreditSnapshot> {
    assertAmount(args.amountMicro, { min: 1 });
    if (!Number.isSafeInteger(args.expiryMs) || args.expiryMs <= 0) {
      throw new CreditLedgerError(
        "invalid_expiry",
        `expiryMs must be a positive safe integer (got ${args.expiryMs})`
      );
    }
    const b = assertFundingBasis(args.basis);
    const nowMs = args.nowMs ?? Date.now();
    const creditId = args.creditId ?? randomUUID();
    if (args.tx) return this.fundOn(args.tx, args, b, nowMs, creditId);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const snapshot = await this.fundOn(client, args, b, nowMs, creditId);
      await client.query("COMMIT");
      return snapshot;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {
        // The transaction is already unusable; the original error is what matters.
      });
      throw err;
    } finally {
      client.release();
    }
  }

  private async fundOn(
    q: CreditLedgerQuerier,
    args: CreditFundArgs,
    b: CreditFundingBasis,
    nowMs: number,
    creditId: string
  ): Promise<CreditSnapshot> {
    if (this.hostingCleanupFence &&
      (args.hostingInvoicePaymentHash || args.hostingInvoiceRepairPaymentHash) &&
      !this.invoiceSettlementClients.has(q)) {
      throw new Error("Hosted invoice settlement must use its original locked transaction");
    }
    await this.hostingCleanupFence?.assertNewIntent(q, {
      admissionId: args.hostingAdmissionId,
      jobId: args.hostingJobId,
      paymentSeq: args.hostingPaymentSeq,
      creditId: args.hostingJobId ? undefined : creditId,
      fundId: args.hostingFundId,
      callerPubkey: args.hostingJobId ? undefined : args.callerPubkey,
      invoicePaymentHash: args.hostingInvoicePaymentHash,
      invoiceRepairPaymentHash: args.hostingInvoiceRepairPaymentHash,
      amountMicro: args.amountMicro,
    });
    // Gate the incoming channel before the upsert: a refund may have paid back its escrow,
    // leaving new deposits unclaimable. A basis without that channel is rejected by the
    // symmetric binding guard. Funding never gets the repair effect-ID exemption.
    //
    // This read takes no credit lock, so a deposit can still race a cooperative drain and
    // must remain reclaimable under its recorded drain ID. It is a preflight, not an
    // atomicity guarantee.
    const wedged = await this.blockingX402Refund(
      b.x402Channel?.channelId,
      X402_SPEND_BLOCKING_SETTLEMENT_STATUSES
    );
    if (wedged) throw x402SettlementPending(creditId, wedged);
    let rows: CreditRow[];
    try {
      ({ rows } = await q.query<CreditRow>(
        `INSERT INTO credits (credit_id, caller_pubkey, currency, balance_micro, expiry_ms, status, created_at,
                            rail, native_asset, mint, funding_ref, msats_remaining, native_remaining,
                            tempo_channel_id, x402_channel_id, last_funding_ledger_seq)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
       ON CONFLICT (credit_id) DO UPDATE
         SET balance_micro    = credits.balance_micro + EXCLUDED.balance_micro,
             last_funding_ledger_seq = credits.last_ledger_seq,
             expiry_ms        = EXCLUDED.expiry_ms,
             rail             = COALESCE(credits.rail, EXCLUDED.rail),
             native_asset     = COALESCE(EXCLUDED.native_asset, credits.native_asset),
             mint             = COALESCE(EXCLUDED.mint, credits.mint),
             funding_ref      = COALESCE(EXCLUDED.funding_ref, credits.funding_ref),
             tempo_channel_id = COALESCE(credits.tempo_channel_id, EXCLUDED.tempo_channel_id),
             msats_remaining  = credits.msats_remaining + EXCLUDED.msats_remaining,
             native_remaining = CASE
               WHEN EXCLUDED.native_remaining IS NULL THEN credits.native_remaining
               ELSE COALESCE(credits.native_remaining, 0) + EXCLUDED.native_remaining
             END,
             x402_channel_id = COALESCE(credits.x402_channel_id, EXCLUDED.x402_channel_id)
         WHERE credits.caller_pubkey = EXCLUDED.caller_pubkey
           AND credits.status = 'active'
           AND credits.currency = EXCLUDED.currency
           AND (credits.rail IS NULL OR credits.rail = EXCLUDED.rail)
           AND ((credits.tempo_channel_id IS NULL AND EXCLUDED.tempo_channel_id IS NULL)
                OR credits.tempo_channel_id = EXCLUDED.tempo_channel_id)
           AND ((credits.x402_channel_id IS NULL AND EXCLUDED.x402_channel_id IS NULL)
                OR credits.x402_channel_id = EXCLUDED.x402_channel_id)
       RETURNING *`,
        [
          creditId,
          args.callerPubkey,
          args.currency,
          args.amountMicro,
          args.expiryMs,
          nowMs,
          b.rail,
          b.nativeAsset ?? null,
          b.mint ?? null,
          b.fundingRef ?? null,
          b.paidMsats,
          b.nativeAmount ?? null,
          b.tempoSession?.channelId.toLowerCase() ?? null,
          b.x402Channel?.channelId ?? null,
        ]
      ));
    } catch (err) {
      // The credit-id upsert target does not cover the channel-wide unique
      // index. A channel already bound to another credit therefore arrives as
      // 23505 before the ordinary diagnosis ladder below can run. Look the
      // committed owner up on the pool (the caller-owned transaction is now
      // aborted and must remain under its caller's control), then translate
      // the pg errno into the ledger taxonomy every payment path understands.
      if (b.x402Channel && isUniqueViolation(err)) {
        const channelId = b.x402Channel.channelId;
        const { rows: bound } = await this.pool.query<
          Pick<CreditRow, "credit_id" | "rail" | "x402_channel_id">
        >(
          `SELECT credit_id, rail, x402_channel_id
             FROM credits
            WHERE x402_channel_id = $1`,
          [channelId]
        );
        throw new CreditLedgerError(
          "rail_mismatch",
          bound[0]
            ? `x402 channel ${channelId} is already bound to credit ${bound[0].credit_id}`
            : `x402 channel ${channelId} is already bound to another credit`,
          {
            expectedRail: bound[0]?.rail ?? "x402",
            expectedInstrument: "x402_channel",
            expectedChannelId: channelId,
            ...(bound[0] ? { boundCreditId: bound[0].credit_id } : {}),
          },
          { cause: err }
        );
      }
      throw err;
    }
    if (rows.length === 0) {
      // Conflict row exists but the WHERE refused the update — diagnose which
      // identity field differs. Plain reads, so a caller-owned `tx` survives.
      const { rows: existing } = await q.query<
        Pick<
          CreditRow,
          "caller_pubkey" | "currency" | "status" | "rail" | "tempo_channel_id" | "x402_channel_id"
        >
      >(
        `SELECT caller_pubkey, currency, status, rail, tempo_channel_id, x402_channel_id
         FROM credits WHERE credit_id = $1`,
        [creditId]
      );
      const row = existing[0];
      if (row.caller_pubkey !== args.callerPubkey) {
        throw new CreditLedgerError(
          "caller_mismatch",
          `credit ${creditId} belongs to a different caller pubkey`
        );
      }
      if (row.status !== "active") throw terminalCreditError(creditId, row.status);
      if (row.currency !== args.currency) {
        throw new CreditLedgerError(
          "currency_mismatch",
          `credit ${creditId} is denominated in ${row.currency}, not ${args.currency}`
        );
      }
      // The rail rung goes above the instrument rungs (the order
      // `MemoryCreditLedger.fundSync` already keeps): a cross-rail top-up also
      // disagrees about both channel columns, and diagnosing it as an
      // instrument mismatch would name an instrument the credit never had.
      // A legacy `rail IS NULL` row skips it and adopts whatever rail tops it
      // up, exactly as the `COALESCE` in the upsert does.
      if (row.rail !== null && row.rail !== b.rail) {
        throw new CreditLedgerError(
          "rail_mismatch",
          `credit ${creditId} was funded on the ${row.rail} rail, not ${b.rail}`,
          { expectedRail: row.rail }
        );
      }
      // Both instrument rungs below say only what the row proves. A legacy
      // `rail IS NULL` row has no readable instrument — it may predate rail
      // recording on any rail — so neither the message nor
      // `expectedInstrument` may name one, and `err.message` rides the wire
      // verbatim for an agent to relay.
      const incomingTempoChannel = b.tempoSession?.channelId.toLowerCase() ?? null;
      if (row.tempo_channel_id !== incomingTempoChannel) {
        throw new CreditLedgerError(
          "rail_mismatch",
          row.tempo_channel_id
            ? `credit ${creditId} belongs to Tempo session channel ${row.tempo_channel_id}`
            : row.rail === "tempo"
              ? `credit ${creditId} was funded by a one-shot Tempo charge and cannot accept a Tempo session voucher`
              : `credit ${creditId} is not bound to a Tempo session channel and cannot adopt one`,
          {
            expectedRail: row.rail,
            ...(row.tempo_channel_id || row.rail === "tempo"
              ? { expectedInstrument: row.tempo_channel_id ? "tempo_session" : "tempo_charge" }
              : {}),
            expectedChannelId: row.tempo_channel_id,
          }
        );
      }
      if (row.x402_channel_id !== (b.x402Channel?.channelId ?? null)) {
        throw new CreditLedgerError(
          "rail_mismatch",
          row.x402_channel_id
            ? `credit ${creditId} is bound to x402 settlement channel ${row.x402_channel_id}`
            : row.rail === "x402"
              ? `credit ${creditId} was funded by a one-shot x402 exact payment and cannot accept an x402 batch-settlement channel deposit`
              : `credit ${creditId} is not bound to an x402 batch-settlement channel and cannot adopt one`,
          {
            expectedRail: row.rail,
            ...(row.x402_channel_id || row.rail === "x402"
              ? { expectedInstrument: row.x402_channel_id ? "x402_channel" : "x402_exact" }
              : {}),
            expectedChannelId: row.x402_channel_id,
          }
        );
      }
      throw new CreditLedgerError(
        "rail_mismatch",
        `credit ${creditId} was funded on the ${row.rail} rail, not ${b.rail}`,
        { expectedRail: row.rail }
      );
    }
    await this.recordFundingLot(q, creditId, args.amountMicro, b, nowMs);
    const revived = await this.reverseExpiryReleases(q, creditId, nowMs);
    return this.snapshotFromRow(revived ?? rows[0], q, nowMs);
  }

  /**
   * Funding reverses standing expiry releases, restores their released micro and queues
   * reversal reports on the funding transaction. Do this even when the new expiry is already
   * past: the next sweep must release the enlarged remainder as a new episode.
   *
   * Returns the row after restoration, or undefined when no release stood. The upsert’s
   * RETURNING row predates the restoration and is not the final balance.
   */
  private async reverseExpiryReleases(
    q: CreditLedgerQuerier,
    creditId: string,
    nowMs: number
  ): Promise<CreditRow | undefined> {
    const { rows } = await q.query<CreditExpiryReleaseRow>(
      `UPDATE credit_expiry_releases
          SET reversed_at = $2
        WHERE credit_id = $1 AND reversed_at IS NULL
        RETURNING *`,
      [creditId, nowMs]
    );
    if (rows.length === 0) return undefined;
    const restoredMicro = rows.reduce((sum, row) => sum + toSafeInt(row.amount_micro), 0);
    const { rows: restored } = await q.query<CreditRow>(
      `UPDATE credits SET balance_micro = balance_micro + $2 WHERE credit_id = $1 RETURNING *`,
      [creditId, restoredMicro]
    );
    const outbox = this.expiryReleaseOutbox;
    if (outbox) {
      for (const row of rows) {
        await outbox.enqueue(q, expiryReleaseReport(outbox.dvmId, row));
      }
    }
    return restored[0];
  }

  /**
   * Release expired undrawn balances, retaining readable credit records. Tempo rail or
   * channel-backed credits are excluded because their collateral returns to the caller
   * through the channel lifecycle.
   *
   * Pending holds prevent release: jobs accepted before expiry may still settle or release.
   * Candidates are rechecked under the same parent-credit lock used by draw writes. The
   * balance debit, episode record and report commit together; standing releases exclude
   * repeat work. A later revival may reuse the expiry instant but receives a new release
   * sequence.
   */
  async sweepExpiredCredits(args?: {
    nowMs?: number;
    limit?: number;
  }): Promise<{ released: CreditExpiryRelease[] }> {
    const nowMs = args?.nowMs ?? Date.now();
    const limit = args?.limit ?? DEFAULT_EXPIRY_SWEEP_LIMIT;
    const { rows: candidates } = await this.pool.query<{ credit_id: string }>(
      `SELECT c.credit_id
         FROM credits c
        WHERE c.expiry_ms <= $1
          AND c.balance_micro > 0
          AND c.status = 'active'
          AND c.tempo_channel_id IS NULL
          AND COALESCE(c.rail, '') <> 'tempo'
          AND NOT EXISTS (
            SELECT 1 FROM credit_expiry_releases r
             WHERE r.credit_id = c.credit_id AND r.reversed_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM credit_draws d
             WHERE d.credit_id = c.credit_id AND d.status = 'pending'
          )
        ORDER BY c.expiry_ms
        LIMIT $2`,
      [nowMs, limit]
    );

    const released: CreditExpiryRelease[] = [];
    for (const candidate of candidates) {
      const row = await this.withCreditLock(candidate.credit_id, (client, credit) =>
        this.releaseExpiredCreditLocked(client, credit, nowMs)
      );
      if (row) released.push(expiryReleaseFromRow(row));
    }
    return { released };
  }

  /**
   * Recheck eligibility under the credit lock and zero the released balance in the same
   * transaction as its episode/report. Otherwise requestDrain, which intentionally ignores
   * expiry, could reclaim value already released to the builder.
   *
   * Keep status active so future funding can revive it. Funding lots remain intact: balance
   * zero excludes this credit from Bitcoin liability, and reversal restores that liability.
   */
  private async releaseExpiredCreditLocked(
    client: PoolClient,
    credit: CreditRow,
    nowMs: number
  ): Promise<CreditExpiryReleaseRow | undefined> {
    const expiryMs = toSafeInt(credit.expiry_ms);
    const balanceMicro = toSafeInt(credit.balance_micro);
    if (expiryMs > nowMs || balanceMicro <= 0 || credit.status !== "active") return undefined;
    if (credit.tempo_channel_id !== null || credit.rail === "tempo") return undefined;
    const pending = await this.pendingSums(client, credit.credit_id);
    if (pending.micro > 0) return undefined;
    const { rows: open } = await client.query<{ one: number }>(
      `SELECT 1 AS one FROM credit_expiry_releases
        WHERE credit_id = $1 AND reversed_at IS NULL`,
      [credit.credit_id]
    );
    if (open.length > 0) return undefined;
    // Episode number, counted under the lock every release write is taken
    // under. See `expiryReleaseId` for why the expiry alone is not enough.
    const { rows: episodes } = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM credit_expiry_releases WHERE credit_id = $1`,
      [credit.credit_id]
    );
    const seq = toSafeInt(episodes[0].n) + 1;

    const { rows } = await client.query<CreditExpiryReleaseRow>(
      `INSERT INTO credit_expiry_releases
         (credit_id, release_id, caller_pubkey, currency, rail, amount_micro, expiry_ms, released_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (credit_id, release_id) DO NOTHING
       RETURNING *`,
      [
        credit.credit_id,
        expiryReleaseId(expiryMs, seq),
        credit.caller_pubkey,
        credit.currency,
        credit.rail,
        balanceMicro,
        expiryMs,
        nowMs,
      ]
    );
    // `DO NOTHING` returns no row when a concurrent pass already wrote this
    // episode's key — the same release, so there is nothing to report or zero
    // twice.
    if (rows.length === 0) return undefined;
    const row = rows[0];
    await client.query(
      `UPDATE credits SET balance_micro = balance_micro - $2 WHERE credit_id = $1`,
      [credit.credit_id, balanceMicro]
    );
    const outbox = this.expiryReleaseOutbox;
    if (outbox) await outbox.enqueue(client, expiryReleaseReport(outbox.dvmId, row));
    return row;
  }

  /**
   * Record non-channel Bitcoin funding lots on the funding transaction. An implicit payment
   * also needs a lot: its draw is initially only a hold, and failure releases the whole
   * balance for reclaim. Channel collateral is excluded from Bitcoin lots.
   *
   * A zero-sats basis still records a lot, distinguishing covered but basisless credit from a
   * missing-lot coverage gap.
   */
  private async recordFundingLot(
    q: CreditLedgerQuerier,
    creditId: string,
    amountMicro: number,
    basis: CreditFundingBasis,
    nowMs: number
  ): Promise<void> {
    if (!isNonChannelBitcoinRail(basis.rail)) return;
    if (basis.tempoSession || basis.x402Channel) return;
    await q.query(
      `INSERT INTO credit_funding_lots
         (lot_id, credit_id, rail, sats_funded, credited_micro, remaining_micro, funding_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`,
      [
        `lot:${randomUUID()}`,
        creditId,
        basis.rail,
        Math.floor(basis.paidMsats / 1000),
        amountMicro,
        basis.fundingRef ?? null,
        nowMs,
      ]
    );
  }

  /**
   * Place a pending hold with the next shared per-credit sequence. A matching (creditId,
   * drawId) replay returns its recorded tuple without another hold; conflicting amount or
   * jobId is draw_conflict.
   *
   * Replay precedes expiry and settlement gates so a lost response stays recoverable. Fresh
   * draws require spendable credit. With tx, take the parent-credit lock on the caller’s
   * transaction without issuing transaction control.
   */
  async draw(args: {
    creditId: string;
    /** Client-generated draw id from the signed request body (spec condition 1). */
    drawId: string;
    amountMicro: number;
    jobId?: string;
    hostingAdmissionId?: string;
    hostingPaymentSeq?: number;
    /** External transaction handle — caller owns BEGIN/COMMIT (spec condition 3). */
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrawResult> {
    assertAmount(args.amountMicro, { min: 0 });
    const nowMs = args.nowMs ?? Date.now();
    const jobId = args.jobId ?? null;
    const run = async (
      client: CreditLedgerQuerier,
      credit: CreditRow,
      tempoLifecycle?: TempoSessionLifecycle
    ): Promise<DrawResult> => {
      const existing = await this.readDraw(client, args.creditId, args.drawId);
      if (existing) {
        const recordedJobId = existing.job_id ?? null;
        if (toSafeInt(existing.amount_micro) !== args.amountMicro || recordedJobId !== jobId) {
          throw new CreditLedgerError(
            "draw_conflict",
            `draw ${args.drawId} on credit ${args.creditId} was recorded with different parameters`,
            {
              expectedAmountMicro: toSafeInt(existing.amount_micro),
              expectedJobId: recordedJobId,
            }
          );
        }
        return { ...drawResultFromRow(existing, credit), replayed: true };
      }
      if (credit.status !== "active") throw terminalCreditError(args.creditId, credit.status);
      if (tempoLifecycle && (tempoLifecycle.finalized || tempoLifecycle.closeRequestedAt !== 0n)) {
        throw new CreditLedgerError(
          "tempo_channel_closing",
          `credit ${args.creditId} is bound to a Tempo channel that is closing or finalized`
        );
      }
      // Read refund status under the credit lock. A cooperative drain holds that lock across
      // the facilitator call, so a pre-lock observation could become stale while waiting. The
      // gate reads through its own pool without adding a lock-order dependency.
      const x402Refund = await this.blockingX402Refund(
        credit.x402_channel_id,
        X402_SPEND_BLOCKING_SETTLEMENT_STATUSES
      );
      if (x402Refund) throw x402SettlementPending(args.creditId, x402Refund);
      const balanceMicro = toSafeInt(credit.balance_micro);
      const expiryMs = toSafeInt(credit.expiry_ms);
      if (expiryMs <= nowMs) {
        throw new CreditLedgerError("credit_expired", `credit ${args.creditId} expired`, {
          expiryMs,
          balanceMicro,
        });
      }
      const pending = await this.pendingSums(client, args.creditId);
      const available = balanceMicro - pending.micro;
      if (args.amountMicro > available) {
        throw new CreditLedgerError(
          "insufficient_credit",
          `draw of ${args.amountMicro} exceeds available balance ${available}`,
          { availableMicro: available, balanceMicro, requestedMicro: args.amountMicro }
        );
      }
      // allocate this draw's share of the rail value still unspent,
      // under the lock we already hold. Both remainders are net of pending
      // holds, exactly like `available` above, so a released hold returns its
      // allocation to the pool automatically.
      const nativeRemaining =
        credit.native_remaining === null ? null : toSafeInt(credit.native_remaining);
      const railValue = allocateDrawValue({
        amountMicro: args.amountMicro,
        availableMicro: available,
        availableMsats: Math.max(0, toSafeInt(credit.msats_remaining) - pending.msats),
        availableNative:
          nativeRemaining === null ? null : Math.max(0, nativeRemaining - pending.native),
      });
      const ledgerSeq = toSafeInt(credit.last_ledger_seq) + 1;
      const balanceAfterMicro = available - args.amountMicro;
      await this.hostingCleanupFence?.assertNewIntent(client, {
        admissionId: args.hostingAdmissionId, jobId: args.jobId,
        paymentSeq: args.hostingPaymentSeq,
      });
      await client.query(`UPDATE credits SET last_ledger_seq = $2 WHERE credit_id = $1`, [
        args.creditId,
        ledgerSeq,
      ]);
      await client.query(
        `INSERT INTO credit_draws
           (credit_id, draw_id, amount_micro, job_id, ledger_seq, status, balance_after_micro, created_at,
            draw_msats, draw_native)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9)`,
        [
          args.creditId,
          args.drawId,
          args.amountMicro,
          jobId,
          ledgerSeq,
          balanceAfterMicro,
          nowMs,
          railValue.drawMsats,
          railValue.drawNative,
        ]
      );
      return {
        creditId: args.creditId,
        drawId: args.drawId,
        amountMicro: args.amountMicro,
        balanceAfterMicro,
        ledgerSeq,
        status: "pending" as const,
        replayed: false,
        railValue: { ...railValue, ...creditBasisFromRow(credit) },
        resolvedAt: null,
      };
    };
    const query = args.tx ?? this.pool;
    // The Tempo channel binding is read above the credit lock because taking
    // the channel lock is what it decides — the fixed channel → credit order.
    const { rows } = await query.query<{ tempo_channel_id: string | null }>(
      `SELECT tempo_channel_id FROM credits WHERE credit_id = $1`,
      [args.creditId]
    );
    const channelId = rows[0]?.tempo_channel_id;
    if (channelId && this.tempoSessionStore) {
      return this.tempoSessionStore.withDrawPlacement(
        channelId,
        async (tx, lifecycle) => {
          const credit = await this.lockCreditRow(tx, args.creditId);
          return run(tx, credit, lifecycle);
        },
        args.tx
      );
    }
    if (args.tx) {
      const credit = await this.lockCreditRow(args.tx, args.creditId);
      return run(args.tx, credit);
    }
    return this.withCreditLock(args.creditId, (client, credit) => run(client, credit));
  }

  /**
   * Return the unresolved refund that blocks an effect on this channel, or undefined. Route
   * preflights use the same rule before moving money; draw and drain also read it under the
   * credit lock.
   */
  async blockingX402Refund(
    channelId: string | null | undefined,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined> {
    if (!channelId || !this.x402Settlements) return undefined;
    return this.x402Settlements.pendingRefundSettlement(channelId, statuses);
  }

  /**
   * Grow an accepted job’s pending hold while preserving its original ledger_seq. The balance
   * tuple is updated at that sequence, so interleaved draws need not form a monotonic balance
   * trajectory. No expiry check applies to an already accepted job.
   *
   * Available balance excludes every pending hold, including this one. An earmark allocates
   * the incoming funding’s rail value; absent one, growth uses the pool.
   *
   * Growth has no independent replay key: compose it with the rail’s replay protection in one
   * transaction. capMicro bounds cumulative growth at the job’s cumulative ask. Excess
   * remains caller-owned funded balance; partial or zero growth returns that excess rather
   * than throwing and rolling back accepted proofs.
   */
  async growDraw(args: {
    creditId: string;
    drawId: string;
    addAmountMicro: number;
    /**
     * Rail value that funded this growth, earmarked to the increment instead
     * of allocated pro-rata. Pass it whenever `addAmountMicro` is
     * money that landed in this same transaction; omit it when the growth
     * spends balance the credit already held.
     */
    addRailValue?: { drawMsats: number; drawNative: number | null };
    /**
     * Ceiling on this draw's **cumulative** growth, in fiat micro of the
     * credit's currency — the job's total mid-job ask. Growth is
     * clipped to `capMicro - grown_micro`; a second payment for an ask the
     * first already satisfied gets zero. Omit it only when the caller genuinely
     * has no ask total to bound against; growth is then unbounded, as before.
     */
    capMicro?: number;
    /** Defensive binding check — the draw must already be recorded for this job. */
    jobId?: string;
    /** External transaction handle — caller owns BEGIN/COMMIT (spec condition 3). */
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<GrownDrawResult> {
    assertAmount(args.addAmountMicro, { min: 1 });
    const run = async (
      client: CreditLedgerQuerier,
      credit: CreditRow
    ): Promise<GrownDrawResult> => {
      const existing = await this.readDraw(client, args.creditId, args.drawId);
      if (!existing) {
        throw new CreditLedgerError(
          "draw_not_found",
          `draw ${args.drawId} not found on credit ${args.creditId}`
        );
      }
      if (existing.status !== "pending") {
        throw new CreditLedgerError(
          "invalid_draw_state",
          `cannot grow draw ${args.drawId}: status is ${existing.status}`,
          { currentStatus: existing.status }
        );
      }
      if (credit.status !== "active") throw terminalCreditError(args.creditId, credit.status);
      if (args.jobId !== undefined && (existing.job_id ?? null) !== args.jobId) {
        throw new CreditLedgerError(
          "draw_conflict",
          `draw ${args.drawId} on credit ${args.creditId} belongs to a different job`,
          { expectedJobId: existing.job_id ?? null }
        );
      }
      // what the job's cumulative ask still leaves room for. Read
      // under the same `FOR UPDATE` as the write, which is what makes two
      // concurrent payments for one ask serialise: the loser sees the winner's
      // `grown_micro` and has no headroom left.
      const priorGrown = toSafeInt(existing.grown_micro);
      const headroom =
        args.capMicro === undefined ? args.addAmountMicro : Math.max(0, args.capMicro - priorGrown);
      const grantMicro = Math.min(args.addAmountMicro, headroom);
      const balanceMicro = toSafeInt(credit.balance_micro);
      const pending = await this.pendingSums(client, args.creditId);
      // Net of *every* hold, this draw's own included — exactly what `draw()`
      // would have seen for a fresh draw of `addAmountMicro`. Growth must not
      // get a discount its own hold pays for.
      const available = balanceMicro - pending.micro;
      if (grantMicro <= 0) {
        // Nothing to grow: the draw already covers everything this job asked
        // for. Write nothing and report the refusal — the funding that landed
        // in this transaction stays available balance on the credit.
        return {
          creditId: args.creditId,
          drawId: args.drawId,
          amountMicro: toSafeInt(existing.amount_micro),
          balanceAfterMicro: toSafeInt(existing.balance_after_micro),
          ledgerSeq: toSafeInt(existing.ledger_seq),
          status: "pending" as const,
          replayed: false,
          railValue: {
            drawMsats: toSafeInt(existing.draw_msats),
            drawNative: existing.draw_native === null ? null : toSafeInt(existing.draw_native),
            ...creditBasisFromRow(credit),
          },
          resolvedAt: null,
          addedRailValue: { drawMsats: 0, drawNative: null },
          addedAmountMicro: 0,
          cappedMicro: args.addAmountMicro,
        };
      }
      if (grantMicro > available) {
        throw new CreditLedgerError(
          "insufficient_credit",
          `top-up draw of ${grantMicro} exceeds available balance ${available}`,
          { availableMicro: available, balanceMicro, requestedMicro: grantMicro }
        );
      }
      const priorMsats = toSafeInt(existing.draw_msats);
      const priorNative = existing.draw_native === null ? null : toSafeInt(existing.draw_native);
      const nativeRemaining =
        credit.native_remaining === null ? null : toSafeInt(credit.native_remaining);
      const added = growthRailValue({
        earmark: clipEarmark(args.addRailValue, grantMicro, args.addAmountMicro),
        amountMicro: grantMicro,
        availableMicro: available,
        availableMsats: Math.max(0, toSafeInt(credit.msats_remaining) - pending.msats),
        availableNative:
          nativeRemaining === null ? null : Math.max(0, nativeRemaining - pending.native),
      });
      const amountMicro = toSafeInt(existing.amount_micro) + grantMicro;
      const balanceAfterMicro = available - grantMicro;
      const drawMsats = priorMsats + added.drawMsats;
      const drawNative =
        added.drawNative === null ? priorNative : (priorNative ?? 0) + added.drawNative;
      await client.query(
        `UPDATE credit_draws
            SET amount_micro = $3, balance_after_micro = $4, draw_msats = $5, draw_native = $6,
                grown_micro = $7
          WHERE credit_id = $1 AND draw_id = $2`,
        [
          args.creditId,
          args.drawId,
          amountMicro,
          balanceAfterMicro,
          drawMsats,
          drawNative,
          priorGrown + grantMicro,
        ]
      );
      return {
        creditId: args.creditId,
        drawId: args.drawId,
        amountMicro,
        balanceAfterMicro,
        ledgerSeq: toSafeInt(existing.ledger_seq),
        status: "pending" as const,
        replayed: false,
        railValue: { drawMsats, drawNative, ...creditBasisFromRow(credit) },
        resolvedAt: null,
        addedRailValue: added,
        addedAmountMicro: grantMicro,
        cappedMicro: args.addAmountMicro - grantMicro,
      };
    };
    if (args.tx) {
      const credit = await this.lockCreditRow(args.tx, args.creditId);
      return run(args.tx, credit);
    }
    return this.withCreditLock(args.creditId, run);
  }

  /** Restore a completed draw and its report under one durable transaction. */
  async refundDraw(args: CreditDrawRefundArgs): Promise<CreditDrawRefundResult> {
    const request = refundRequest(args);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Refund IDs are host-wide. Serialize even conflicting selectors before taking a
      // credit lock, so a simultaneous reuse on another credit cannot move money twice.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [args.refundId]);
      const prior = await client.query<{ request: string; result: CreditDrawRefundResult }>(
        "SELECT request, result FROM credit_draw_refunds WHERE refund_id = $1", [args.refundId]);
      if (prior.rows[0]) {
        if (prior.rows[0].request !== request) {
          throw new CreditLedgerError("refund_conflict", "This refundId was recorded with different arguments.");
        }
        await client.query("COMMIT");
        return { ...prior.rows[0].result, replayed: true };
      }
      let creditId = args.creditId;
      let drawId = args.drawId;
      if (args.jobId !== undefined) {
        const matches = await client.query<{ credit_id: string; draw_id: string }>(
          "SELECT credit_id, draw_id FROM credit_draws WHERE job_id = $1 LIMIT 2", [args.jobId]);
        if (matches.rows.length === 1) {
          creditId = matches.rows[0].credit_id;
          drawId = matches.rows[0].draw_id;
        }
      }
      if (creditId === undefined || drawId === undefined) {
        throw new CreditLedgerError("draw_not_found", "No unique credit draw matches this job.");
      }
      // Read absent credits as absent draws rather than exposing another refusal contract.
      let credit: CreditRow;
      try {
        credit = await this.lockCreditRow(client, creditId);
      } catch (error) {
        if (error instanceof CreditLedgerError && error.code === "credit_not_found") {
          throw new CreditLedgerError("draw_not_found", "No draw matches this credit.");
        }
        throw error;
      }
      const draw = await this.readDraw(client, creditId, drawId);
      if (!credit || !draw || !draw.job_id || args.jobId !== undefined && draw.job_id !== args.jobId) {
        throw new CreditLedgerError("draw_not_found", "No job-bound draw matches this selector.");
      }
      const owners = new Set<string>(draw.refund_dvm_id ? [draw.refund_dvm_id] : []);
      const sources = await client.query<{ jobs: string | null; terminals: string | null }>(
        "SELECT to_regclass('jobs')::text AS jobs, to_regclass('reported_job_terminals')::text AS terminals");
      if (sources.rows[0].jobs) {
        const jobs = await client.query<{ dvm_id: string | null; receipt: unknown }>(
          "SELECT dvm_id, receipt FROM jobs WHERE id = $1", [draw.job_id]);
        const job = jobs.rows[0];
        if (job?.dvm_id) owners.add(job.dvm_id);
        const receipt = job?.receipt;
        if (args.trustedReceiptPubkey !== undefined && isSignedJobReceipt(receipt) &&
          receipt.receipt_pubkey === args.trustedReceiptPubkey && receipt.job_id === draw.job_id && verifyReceipt(receipt)) {
          owners.add(receipt.dvm_id);
        }
      }
      if (sources.rows[0].terminals) {
        const terminals = await client.query<{ dvm_id: string }>(
          "SELECT dvm_id FROM reported_job_terminals WHERE job_id = $1", [draw.job_id]);
        for (const terminal of terminals.rows) owners.add(terminal.dvm_id);
      }
      // Draws outlive job content. Persist only a proved namespace; NULL legacy job owners
      // are not permission to refund through whichever DVM happens to receive the request.
      if (owners.size !== 1 || !owners.has(args.outbox.dvmId)) {
        throw new CreditLedgerError("draw_not_found", "No draw with proven ownership matches this DVM.");
      }
      if (draw.status !== "settled") {
        throw new CreditLedgerError("draw_not_completed", "Only a settled completed draw can be refunded.");
      }
      const nowMs = args.nowMs ?? Date.now();
      // A partial drain retaining pending holds did not close the credit. A later positive
      // draw or a successful funding watermark proves a fully drained credit reopened;
      // zero-value draws advance the sequence but restore no spendable money.
      const drained = await client.query(`SELECT 1 FROM credit_drains d
        WHERE d.credit_id = $1 AND d.status <> 'released' AND d.balance_after_micro = 0
          AND (SELECT MAX(ledger_seq) FROM credit_drains WHERE credit_id = $1 AND status <> 'released') = d.ledger_seq
          AND ($2::bigint IS NULL OR $2::bigint < d.ledger_seq)
          AND NOT EXISTS (SELECT 1 FROM credit_draws later WHERE later.credit_id = $1
            AND later.ledger_seq > d.ledger_seq AND later.amount_micro > 0)
          AND NOT EXISTS (SELECT 1 FROM credit_fundings f WHERE f.credit_id = $1
            AND f.ledger_seq >= d.ledger_seq AND f.amount_micro > 0)
        LIMIT 1`, [creditId, credit.last_funding_ledger_seq]);
      if (credit.status !== "active" || toSafeInt(credit.expiry_ms) <= nowMs) {
        throw new CreditLedgerError("credit_not_open", "The original credit is no longer open for refunds.");
      }
      if (credit.tempo_channel_id || credit.x402_channel_id) {
        throw new CreditLedgerError("credit_refund_channel_unsupported", "Channel collateral cannot back a refund of settled spending.");
      }
      if (toSafeInt(credit.balance_micro) === 0 && drained.rows.length > 0) {
        if (credit.last_funding_ledger_seq === null) {
          throw new CreditLedgerError("credit_refund_state_unavailable", "The original credit's historical funding and drain order cannot be established.");
        }
        throw new CreditLedgerError("credit_not_open", "The original credit is no longer open for refunds.");
      }
      const totals = await client.query<{ refunded: string }>(`SELECT COALESCE(SUM(amount_micro), 0) AS refunded
        FROM credit_draw_refunds WHERE credit_id = $1 AND draw_id = $2`, [creditId, drawId]);
      const before = toSafeInt(totals.rows[0].refunded);
      const originalMicro = toSafeInt(draw.amount_micro);
      const amountMicro = args.amountMicro ?? originalMicro - before;
      if (amountMicro <= 0 || amountMicro > originalMicro - before) {
        throw new CreditLedgerError("refund_exceeds_draw", "The refund exceeds the draw's remaining unrefunded charge.");
      }
      const after = before + amountMicro;
      if (!isFundingRail(credit.rail)) {
        throw new CreditLedgerError("credit_refund_basis_unavailable", "The original funding rail is not recorded on this older credit.");
      }
      const bitcoin = isNonChannelBitcoinRail(credit.rail);
      // Only actual settlement records authoritative draw sats. Old repricing markers
      // and funding receipts cannot independently prove which assets that draw consumed.
      const originalSats = draw.settled_sats === null ? null : toSafeInt(draw.settled_sats);
      if (bitcoin && originalSats === null) {
        throw new CreditLedgerError("credit_refund_basis_unavailable", "The original Bitcoin value is not provable from this older draw.");
      }
      const restoredSats = bitcoin ? refundAssetDelta(originalSats!, originalMicro, before, after) : null;
      const restoredMsats = restoredSats === null ?
        refundAssetDelta(toSafeInt(draw.draw_msats), originalMicro, before, after) : restoredSats * 1000;
      const restoredNative = draw.draw_native === null ? null :
        refundAssetDelta(toSafeInt(draw.draw_native), originalMicro, before, after);
      const balanceAfterMicro = toSafeInt(toSafeInt(credit.balance_micro) + amountMicro);
      const ledgerSeq = toSafeInt(toSafeInt(credit.last_ledger_seq) + 1);
      toSafeInt(toSafeInt(credit.msats_remaining) + restoredMsats);
      if (credit.native_remaining !== null) toSafeInt(toSafeInt(credit.native_remaining) + (restoredNative ?? 0));
      await client.query(`UPDATE credit_draws SET refund_dvm_id = $3
        WHERE credit_id = $1 AND draw_id = $2`, [creditId, drawId, args.outbox.dvmId]);
      await client.query(`UPDATE credits SET balance_micro = $2, last_ledger_seq = $3,
        msats_remaining = msats_remaining + $4,
        native_remaining = CASE WHEN native_remaining IS NULL THEN NULL ELSE native_remaining + $5 END
        WHERE credit_id = $1`, [creditId, balanceAfterMicro, ledgerSeq, restoredMsats, restoredNative ?? 0]);
      if (bitcoin) {
        await client.query(`INSERT INTO credit_funding_lots
          (lot_id, credit_id, rail, sats_funded, credited_micro, remaining_micro, funding_ref, created_at, sats_basis_known)
          VALUES ($1, $2, $3, $4, $5, $5, $6, $7, true)`,
          [`lot:refund:${randomUUID()}`, creditId, credit.rail, restoredSats, amountMicro, args.refundId, nowMs]);
      }
      const result: CreditDrawRefundResult = {
        refundId: args.refundId, creditId, drawId, jobId: draw.job_id, amountMicro,
        currency: credit.currency, ledgerSeq, refundedAt: nowMs, balanceAfterMicro, replayed: false,
      };
      await client.query(`INSERT INTO credit_draw_refunds
        (refund_id, credit_id, draw_id, request, amount_micro, restored_sats, result)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [args.refundId, creditId, drawId, request, amountMicro, restoredSats, JSON.stringify(result)]);
      await args.outbox.enqueue(client, {
        dvmId: args.outbox.dvmId, creditId, drawId, jobId: draw.job_id, refundId: args.refundId,
        amountMicro, creditCurrency: credit.currency, ledgerSeq, refundedAt: nowMs,
        ...(args.reason === undefined ? {} : { reason: args.reason }),
      });
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
   * Finalize a pending draw: the hold becomes a real debit
   * (`balance_micro −= amount`). Available balance is unchanged — the amount
   * moves from "held" to "spent" — so the `balanceAfterMicro` trajectory
   * recorded at draw time stays truthful for settled draws, which is what the
   * receipt chain countersigns. Idempotent: settling a settled draw returns
   * the original tuple. A released draw cannot be settled
   * (`invalid_draw_state`) — release-then-settle would debit money the caller
   * was already told is theirs again.
   *
   * Deliberately **no expiry check** here (nor on `release`): a job accepted
   * pre-expiry routinely reaches its terminal post-expiry, and refusing would
   * leak the hold forever. Expiry gates new draws only.
   */
  async settle(args: {
    creditId: string;
    drawId: string;
    releaseOutbox?: CreditDrawReleaseOutbox;
    nowMs?: number;
  }): Promise<DrawResolution> {
    if (!this.tempoSessionStore) return this.resolveDraw({ ...args, to: "settled" });
    const { rows } = await this.pool.query<{ tempo_channel_id: string | null }>(
      `SELECT tempo_channel_id FROM credits WHERE credit_id = $1`,
      [args.creditId]
    );
    const channelId = rows[0]?.tempo_channel_id;
    if (!channelId) return this.resolveDraw({ ...args, to: "settled" });

    return this.tempoSessionStore.withTerminalConsumption(channelId, async (tx, lifecycle) => {
      const credit = await this.lockCreditRow(tx, args.creditId);
      const draw = await this.readDraw(tx, args.creditId, args.drawId);
      if (!draw) {
        throw new CreditLedgerError(
          "draw_not_found",
          `draw ${args.drawId} not found on credit ${args.creditId}`
        );
      }
      const drawNative = draw.draw_native === null ? null : BigInt(draw.draw_native);
      if (drawNative === null) {
        throw new CreditLedgerError(
          "invalid_basis",
          `Tempo session draw ${args.drawId} has no native value to consume`
        );
      }
      if (draw.status === "settled") {
        const value = await this.resolveDrawLocked(tx, credit, { ...args, to: "settled" });
        return { value, amount: drawNative, consume: false };
      }
      if (credit.status === "unbacked") {
        const value = await this.resolveDrawLocked(tx, credit, {
          ...args,
          to: "released",
        });
        return { value, amount: 0n, consume: false };
      }
      const closing = lifecycle.finalized || lifecycle.closeRequestedAt !== 0n;
      // A partial watermark cannot be allocated draw-by-draw without another
      // durable reservation counter: covered settlements deliberately leave
      // `spent` unchanged, so two holds could otherwise reuse the same slice.
      // The forced-close observer settles to highestVoucherAmount, and only
      // that full watermark proves every accepted hold is already collected.
      const covered = lifecycle.settledOnChain >= lifecycle.highestVoucherAmount;
      if (closing && !covered) {
        if (!lifecycle.finalized) {
          throw new CreditLedgerError(
            "tempo_settlement_pending",
            `Tempo channel settlement has not yet covered draw ${args.drawId}`
          );
        }
        const value = await this.resolveDrawLocked(tx, credit, {
          ...args,
          to: "released",
        });
        return { value, amount: 0n, consume: false };
      }
      const value = await this.resolveDrawLocked(tx, credit, { ...args, to: "settled" });
      return {
        value,
        amount: drawNative,
        consume: !closing && !value.replayed,
      };
    });
  }

  /**
   * Release a pending draw: the hold evaporates, the balance is untouched —
   * this is how "no debit on job failure" is mechanically real (the credit lifecycle contract).
   * Idempotent: releasing a released draw returns the original tuple. A
   * settled draw cannot be released (`invalid_draw_state`) — un-settling
   * booked revenue is a reconciliation problem, not a ledger verb.
   */
  async release(args: {
    creditId: string;
    drawId: string;
    releaseOutbox?: CreditDrawReleaseOutbox;
    nowMs?: number;
  }): Promise<DrawResolution> {
    return this.resolveDraw({ ...args, to: "released" });
  }

  /**
   * Record the fund-only replay key without moving money. A duplicate (credit_id, fund_id)
   * raises funding_replayed. Compose this insert, fund and rail acceptance on the same
   * caller-owned transaction; a retry reads the recorded funding outcome.
   */
  async recordFunding(args: {
    creditId: string;
    fundId: string;
    amountMicro: number;
    /** Rail the money arrived on, for the deposit audit trail. */
    rail?: string;
    hostingAdmissionId?: string;
    hostingCallerPubkey?: string;
    hostingJobId?: string;
    hostingPaymentSeq?: number;
    hostingInvoicePaymentHash?: string;
    hostingInvoiceRepairPaymentHash?: string;
    /** External transaction handle — caller owns BEGIN/COMMIT (spec condition 3). */
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<FundingRecord> {
    assertAmount(args.amountMicro, { min: 1 });
    if (this.hostingCleanupFence &&
      (args.hostingInvoicePaymentHash || args.hostingInvoiceRepairPaymentHash) &&
      (!args.tx || !this.invoiceSettlementClients.has(args.tx))) {
      throw new Error("Hosted invoice settlement must use its original locked transaction");
    }
    if (this.hostingCleanupFence && !args.tx) {
      return this.hostingCleanupFence.withNewIntent({
        admissionId: args.hostingAdmissionId,
        jobId: args.hostingJobId, paymentSeq: args.hostingPaymentSeq,
        creditId: args.hostingJobId ? undefined : args.creditId,
        fundId: args.hostingJobId ? undefined : args.fundId,
        callerPubkey: args.hostingJobId ? undefined : args.hostingCallerPubkey,
        invoicePaymentHash: args.hostingInvoicePaymentHash, amountMicro: args.amountMicro,
        invoiceRepairPaymentHash: args.hostingInvoiceRepairPaymentHash,
      }, (tx) => this.recordFunding({ ...args, tx }));
    }
    const q = args.tx ?? this.pool;
    if (args.tx) await this.hostingCleanupFence?.assertNewIntent(args.tx, {
      admissionId: args.hostingAdmissionId,
      jobId: args.hostingJobId, paymentSeq: args.hostingPaymentSeq,
      creditId: args.hostingJobId ? undefined : args.creditId,
      fundId: args.hostingJobId ? undefined : args.fundId,
      callerPubkey: args.hostingJobId ? undefined : args.hostingCallerPubkey,
      invoicePaymentHash: args.hostingInvoicePaymentHash, amountMicro: args.amountMicro,
      invoiceRepairPaymentHash: args.hostingInvoiceRepairPaymentHash,
    });
    const nowMs = args.nowMs ?? Date.now();
    const { rows } = await q.query<FundingRow>(
      `INSERT INTO credit_fundings (credit_id, fund_id, amount_micro, rail, created_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (credit_id, fund_id) DO NOTHING
       RETURNING *`,
      [args.creditId, args.fundId, args.amountMicro, args.rail ?? null, nowMs]
    );
    if (rows.length === 0) {
      throw new CreditLedgerError(
        "funding_replayed",
        `funding ${args.fundId} on credit ${args.creditId} was already recorded`
      );
    }
    return fundingRecordFromRow(rows[0]);
  }

  /**
   * Read one funding record (no lock). The `/v1/credit` fund path checks this
   * **before** touching a rail, so a retried top-up costs nothing and returns
   * the original outcome instead of presenting an artifact the rail would
   * refuse as spent.
   */
  async getFunding(args: { creditId: string; fundId: string }): Promise<FundingRecord | undefined> {
    const { rows } = await this.pool.query<FundingRow>(
      `SELECT * FROM credit_fundings WHERE credit_id = $1 AND fund_id = $2`,
      [args.creditId, args.fundId]
    );
    return rows.length > 0 ? fundingRecordFromRow(rows[0]) : undefined;
  }

  /** Fix the funding-time receipt tuple inside the rail's open transaction. */
  async completeFunding(args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    balanceAfterMicro: number;
    ledgerSeq: number;
    tx?: CreditLedgerQuerier;
  }): Promise<FundingRecord> {
    const q = args.tx ?? this.pool;
    const { rows } = await q.query<FundingRow>(
      `UPDATE credit_fundings
          SET caller_pubkey = COALESCE(caller_pubkey, $3),
              balance_after_micro = COALESCE(balance_after_micro, $4),
              ledger_seq = COALESCE(ledger_seq, $5)
        WHERE credit_id = $1 AND fund_id = $2
        RETURNING *`,
      [args.creditId, args.fundId, args.callerPubkey, args.balanceAfterMicro, args.ledgerSeq]
    );
    if (rows.length === 0) {
      throw new CreditLedgerError(
        "credit_not_found",
        `funding ${args.fundId} on credit ${args.creditId} was not recorded`
      );
    }
    return fundingRecordFromRow(rows[0]);
  }

  /** Persist the first signature for a funding; concurrent issuers read back the winner. */
  async saveFundingReceipt(args: {
    creditId: string;
    fundId: string;
    receipt: FundingReceipt;
  }): Promise<FundingReceipt> {
    const { rows } = await this.pool.query<FundingRow>(
      `UPDATE credit_fundings SET receipt = COALESCE(receipt, $3::jsonb)
        WHERE credit_id = $1 AND fund_id = $2
        RETURNING *`,
      [args.creditId, args.fundId, JSON.stringify(args.receipt)]
    );
    if (!rows[0]?.receipt) {
      throw new CreditLedgerError(
        "credit_not_found",
        `funding ${args.fundId} on credit ${args.creditId} was not recorded`
      );
    }
    return rows[0].receipt;
  }

  /**
   * Record the bolt11 issued for a `(creditId, fundId)` top-up, or
   * return the one already issued for it.
   *
   * **Returning the existing row is the point.** A caller re-polling an unpaid
   * top-up must get the invoice they were handed the first time; minting a
   * fresh bolt11 per attempt is the double-charge bug — they pay the second
   * one, the first stays payable, and both settle onto one `fund_id` that can
   * only be credited once.
   */
  async recordInvoice(args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    currency: string;
    amountMicro: number;
    amountMsats: number;
    paymentHash: string;
    bolt11: string;
    expiresAt: number;
    nowMs?: number;
  }): Promise<CreditInvoiceRecord> {
    assertAmount(args.amountMicro, { min: 1 });
    const nowMs = args.nowMs ?? Date.now();
    let rows: InvoiceRow[];
    try {
      const insert = async (q: CreditLedgerQuerier) => {
        const hostingAdmissionId = this.hostingCleanupFence
          ? await this.hostingCleanupFence.fundingAdmission(q, args.creditId, args.fundId,
              args.callerPubkey) : null;
        return q.query<InvoiceRow>(
        `INSERT INTO credit_invoices (credit_id, fund_id, caller_pubkey, currency, amount_micro,
                                      amount_msats, payment_hash, bolt11, status, expires_at, created_at,
                                      hosting_admission_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10, $11)
         ON CONFLICT (credit_id, fund_id) DO NOTHING
         RETURNING *`,
        [
          args.creditId,
          args.fundId,
          args.callerPubkey,
          args.currency,
          args.amountMicro,
          args.amountMsats,
          args.paymentHash,
          args.bolt11,
          args.expiresAt,
          nowMs,
          hostingAdmissionId,
        ]
        );
      };
      ({ rows } = this.hostingCleanupFence
        ? await this.hostingCleanupFence.withNewIntent({
            creditId: args.creditId, fundId: args.fundId, callerPubkey: args.callerPubkey,
          }, insert)
        : await insert(this.pool));
    } catch (err) {
      // The `ON CONFLICT` target covers the PK only, so a `payment_hash`
      // collision arrives as a raw unique violation: this wallet handed us a
      // hash it already bound to a different funding. Refuse — one payment
      // must never be creditable to two fundings — but refuse in the ledger's
      // own taxonomy, so the route branches on a code rather than a pg errno.
      if (isUniqueViolation(err)) {
        throw new CreditLedgerError(
          "invoice_conflict",
          `payment hash ${args.paymentHash} is already bound to another funding`,
          {},
          { cause: err }
        );
      }
      throw err;
    }
    if (rows.length > 0) return invoiceRecordFromRow(rows[0]);
    const existing = await this.getInvoice({ creditId: args.creditId, fundId: args.fundId });
    if (!existing) {
      // Unreachable: `DO NOTHING` returned no row, so the PK collided, so the
      // row is there to read back.
      throw new CreditLedgerError(
        "invoice_not_found",
        `invoice for funding ${args.fundId} on credit ${args.creditId} vanished between write and read`
      );
    }
    return existing;
  }

  async getInvoice(args: {
    creditId: string;
    fundId: string;
  }): Promise<CreditInvoiceRecord | undefined> {
    const { rows } = await this.pool.query<InvoiceRow>(
      `SELECT * FROM credit_invoices WHERE credit_id = $1 AND fund_id = $2`,
      [args.creditId, args.fundId]
    );
    return rows.length > 0 ? invoiceRecordFromRow(rows[0]) : undefined;
  }

  /**
   * A caller's outstanding invoices, oldest first — the settlement sweep's
   * read. Local and indexed, so the wallet is only consulted when something is
   * genuinely outstanding.
   */
  async listPendingInvoices(args: {
    callerPubkey: string;
    creditId?: string;
    limit: number;
  }): Promise<CreditInvoiceRecord[]> {
    const { rows } = await this.pool.query<InvoiceRow>(
      `SELECT * FROM credit_invoices
        WHERE caller_pubkey = $1 AND status = 'pending'
          AND ($2::text IS NULL OR credit_id = $2)
        ORDER BY created_at, fund_id
        LIMIT $3`,
      [args.callerPubkey, args.creditId ?? null, args.limit]
    );
    return rows.map(invoiceRecordFromRow);
  }

  /**
   * Serialize settlement on the invoice row, which exists before the first credit does.
   * Funding record, balance, invoice status and optional deposit outbox commit together. An
   * interrupted transaction leaves the prior invoice status intact for retry; a settled replay
   * moves no money.
   */
  async settleInvoice(args: {
    creditId: string;
    fundId: string;
    expiryMs: number;
    /**
     * Funding rail value pinned when this invoice was issued.
     */
    basis: CreditFundingBasis;
    /**
     * Reporter-owned deposit outbox write. Runs on the invoice transaction
     * after the ledger/status writes and before COMMIT.
     */
    depositOutbox?: {
      enqueue: CreditDepositEnqueue;
      payload: CreditDepositPayload;
    };
    settledAtMs?: number;
    nowMs?: number;
  }): Promise<InvoiceSettlement> {
    // Above `BEGIN`, not left to the inner `fund`: the invoice row is already
    // locked by then, and a refusal this deterministic should never have taken
    // a lock or a connection to reach.
    assertFundingBasis(args.basis);
    const nowMs = args.nowMs ?? Date.now();
    const settledAt = args.settledAtMs ?? nowMs;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<InvoiceRow>(
        `SELECT * FROM credit_invoices WHERE credit_id = $1 AND fund_id = $2 FOR UPDATE`,
        [args.creditId, args.fundId]
      );
      if (rows.length === 0) {
        throw new CreditLedgerError(
          "invoice_not_found",
          `no invoice for funding ${args.fundId} on credit ${args.creditId}`
        );
      }
      const invoice = invoiceRecordFromRow(rows[0]);
      if (invoice.status === "settled") {
        await client.query("COMMIT");
        const [funding, credit] = await Promise.all([
          this.getFunding({ creditId: args.creditId, fundId: args.fundId }),
          this.get(args.creditId, { nowMs }),
        ]);
        return { invoice, funding, credit, replayed: true };
      }
      this.invoiceSettlementClients.add(client);
      const funding = await this.recordFunding({
        creditId: invoice.creditId,
        fundId: invoice.fundId,
        amountMicro: invoice.amountMicro,
        rail: "lightning",
        hostingInvoicePaymentHash: invoice.paymentHash,
        hostingCallerPubkey: invoice.callerPubkey,
        tx: client,
        nowMs,
      });
      const credit = await this.fund({
        creditId: invoice.creditId,
        callerPubkey: invoice.callerPubkey,
        currency: invoice.currency,
        amountMicro: invoice.amountMicro,
        expiryMs: args.expiryMs,
        basis: args.basis,
        hostingInvoicePaymentHash: invoice.paymentHash,
        hostingFundId: invoice.fundId,
        tx: client,
        nowMs,
      });
      await this.completeFunding({
        creditId: invoice.creditId,
        fundId: invoice.fundId,
        callerPubkey: invoice.callerPubkey,
        balanceAfterMicro: credit.availableMicro,
        ledgerSeq: credit.lastLedgerSeq,
        tx: client,
      });
      const settled = await client.query<InvoiceRow>(
        `UPDATE credit_invoices SET status = 'settled', settled_at = $3
          WHERE credit_id = $1 AND fund_id = $2
          RETURNING *`,
        [args.creditId, args.fundId, settledAt]
      );
      if (args.depositOutbox) {
        await args.depositOutbox.enqueue(client, args.depositOutbox.payload);
      }
      await client.query("COMMIT");
      return {
        invoice: invoiceRecordFromRow(settled.rows[0]),
        funding,
        credit,
        replayed: false,
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back or connection dead
      }
      throw err;
    } finally {
      this.invoiceSettlementClients.delete(client);
      client.release();
    }
  }

  /**
   * Retire an invoice that expired without being paid — bookkeeping only, no
   * ledger effect. A CAS on `pending` so it can never overwrite a settlement
   * observed concurrently.
   */
  async markInvoiceExpired(args: {
    creditId: string;
    fundId: string;
  }): Promise<CreditInvoiceRecord | undefined> {
    await this.pool.query(
      `UPDATE credit_invoices SET status = 'expired'
        WHERE credit_id = $1 AND fund_id = $2 AND status = 'pending'`,
      [args.creditId, args.fundId]
    );
    return this.getInvoice(args);
  }

  /**
   * Mark a paid invoice blocked when its payment cannot be credited. This removes it from the
   * bounded pending sweep and leaves its reason for operator repair. The pending-only CAS
   * cannot overwrite a committed settlement.
   */
  async markInvoiceBlocked(args: {
    creditId: string;
    fundId: string;
    reason: string;
  }): Promise<CreditInvoiceRecord | undefined> {
    await this.pool.query(
      `UPDATE credit_invoices SET status = 'blocked', blocked_reason = $3
        WHERE credit_id = $1 AND fund_id = $2 AND status = 'pending'`,
      [args.creditId, args.fundId, args.reason]
    );
    return this.getInvoice(args);
  }

  async getInvoiceByPaymentHash(paymentHash: string): Promise<CreditInvoiceRecord | undefined> {
    const { rows } = await this.pool.query<InvoiceRow>(
      `SELECT * FROM credit_invoices WHERE payment_hash = $1`,
      [paymentHash]
    );
    return rows.length > 0 ? invoiceRecordFromRow(rows[0]) : undefined;
  }

  /**
   * Host-wide operator queue, keyset-paginated so an untouched blocked row does not starve
   * later rows. includeResolved also exposes reconciled and written-off history; the ledger
   * has no per-mount dvm_id.
   */
  async listBlockedInvoices(args: {
    limit: number;
    after?: BlockedInvoiceCursor;
    includeResolved?: boolean;
  }): Promise<CreditInvoiceRecord[]> {
    const statuses = args.includeResolved ? ["blocked", "reconciled", "written_off"] : ["blocked"];
    const { rows } = await this.pool.query<InvoiceRow>(
      `SELECT * FROM credit_invoices
        WHERE status = ANY($1::text[])
          AND ($2::bigint IS NULL
               OR (created_at, credit_id, fund_id) > ($2::bigint, $3::text, $4::text))
        ORDER BY created_at, credit_id, fund_id
        LIMIT $5`,
      [
        statuses,
        args.after?.createdAt ?? null,
        args.after?.creditId ?? null,
        args.after?.fundId ?? null,
        args.limit,
      ]
    );
    return rows.map(invoiceRecordFromRow);
  }

  /**
   * Apply a blocked or written-off invoice to an operator-named credit. Lock the invoice by
   * its unique payment_hash before funding the credit, matching settlement’s
   * invoice-to-credit lock order. Funding, balance, resolution and optional outbox share one
   * transaction.
   *
   * The repair funding key is (targetCreditId, paymentHash), distinct from the original
   * caller-chosen fundId. Invoice status determines replay. A caller can still occupy the
   * repair key with another payment; funding_replayed must remain a refusal, not be absorbed
   * as already reconciled. Preserve blocked_reason and the wallet’s settlement instant.
   */
  async reconcileBlockedInvoice(args: {
    paymentHash: string;
    /** Credit the money lands on. The caller identity comes off the invoice row. */
    targetCreditId: string;
    expiryMs: number;
    /** Rail-value basis, rebuilt from the invoice row by the caller. */
    basis: CreditFundingBasis;
    /** The wallet's settlement instant, re-observed by the operator's verb. */
    settledAtMs?: number;
    depositOutbox?: {
      enqueue: CreditDepositEnqueue;
      payload: CreditDepositPayload;
    };
    nowMs?: number;
  }): Promise<InvoiceReconciliation> {
    // Above `BEGIN`, for the same reason `settleInvoice` does it: a refusal
    // this deterministic should never have taken a lock or a connection.
    assertFundingBasis(args.basis);
    const nowMs = args.nowMs ?? Date.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<InvoiceRow>(
        `SELECT * FROM credit_invoices WHERE payment_hash = $1 FOR UPDATE`,
        [args.paymentHash]
      );
      if (rows.length === 0) {
        throw new CreditLedgerError(
          "invoice_not_found",
          `no invoice for payment hash ${args.paymentHash}`
        );
      }
      const invoice = invoiceRecordFromRow(rows[0]);
      if (invoice.status === "reconciled") {
        // Commit before the read-back rather than holding the lock across two
        // more round trips — `settleInvoice`'s replay branch, exactly.
        await client.query("COMMIT");
        const [funding, credit] = await Promise.all([
          invoice.reconciledCreditId && invoice.reconciledFundId
            ? this.getFunding({
                creditId: invoice.reconciledCreditId,
                fundId: invoice.reconciledFundId,
              })
            : Promise.resolve(undefined),
          invoice.reconciledCreditId
            ? this.get(invoice.reconciledCreditId, { nowMs })
            : Promise.resolve(undefined),
        ]);
        return { invoice, funding, credit, replayed: true };
      }
      if (invoice.status !== "blocked" && invoice.status !== "written_off") {
        throw new CreditLedgerError(
          "invoice_not_blocked",
          `invoice ${args.paymentHash} is ${invoice.status}; only a blocked or written-off invoice can be reconciled`
        );
      }
      this.invoiceSettlementClients.add(client);
      const funding = await this.recordFunding({
        creditId: args.targetCreditId,
        fundId: invoice.paymentHash,
        amountMicro: invoice.amountMicro,
        rail: "lightning",
        hostingInvoiceRepairPaymentHash: invoice.paymentHash,
        hostingCallerPubkey: invoice.callerPubkey,
        tx: client,
        nowMs,
      });
      const credit = await this.fund({
        creditId: args.targetCreditId,
        callerPubkey: invoice.callerPubkey,
        currency: invoice.currency,
        amountMicro: invoice.amountMicro,
        expiryMs: args.expiryMs,
        basis: args.basis,
        hostingInvoiceRepairPaymentHash: invoice.paymentHash,
        hostingFundId: invoice.paymentHash,
        tx: client,
        nowMs,
      });
      await this.completeFunding({
        creditId: args.targetCreditId,
        fundId: invoice.paymentHash,
        callerPubkey: invoice.callerPubkey,
        balanceAfterMicro: credit.availableMicro,
        ledgerSeq: credit.lastLedgerSeq,
        tx: client,
      });
      // `blocked_reason` is deliberately untouched — it is why this row needed
      // an operator, and that stays true after they act.
      const reconciled = await client.query<InvoiceRow>(
        `UPDATE credit_invoices
            SET status = 'reconciled',
                reconciled_credit_id = $2,
                reconciled_fund_id = $3,
                resolved_at = $4,
                settled_at = COALESCE($5, settled_at)
          WHERE payment_hash = $1
          RETURNING *`,
        [
          args.paymentHash,
          args.targetCreditId,
          invoice.paymentHash,
          nowMs,
          args.settledAtMs ?? null,
        ]
      );
      if (args.depositOutbox) {
        await args.depositOutbox.enqueue(client, args.depositOutbox.payload);
      }
      await client.query("COMMIT");
      return {
        invoice: invoiceRecordFromRow(reconciled.rows[0]),
        funding,
        credit,
        replayed: false,
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back or connection dead
      }
      throw err;
    } finally {
      this.invoiceSettlementClients.delete(client);
      client.release();
    }
  }

  /**
   * Write off an invoice without crediting or moving money. Only the first transition records
   * the note; its written bit controls the audit event. An operator can later reconcile a
   * written-off invoice, because write-off did not return its payment.
   */
  async writeOffBlockedInvoice(args: {
    paymentHash: string;
    note?: string;
    nowMs?: number;
  }): Promise<InvoiceWriteOff | undefined> {
    const { rowCount } = await this.pool.query(
      `UPDATE credit_invoices SET status = 'written_off', write_off_note = $2, resolved_at = $3
        WHERE payment_hash = $1 AND status = 'blocked'`,
      [args.paymentHash, args.note ?? null, args.nowMs ?? Date.now()]
    );
    const invoice = await this.getInvoiceByPaymentHash(args.paymentHash);
    if (!invoice) return undefined;
    return { invoice, written: (rowCount ?? 0) > 0 };
  }

  /** Read one credit (no lock). Expired credits stay fully readable. */
  async get(creditId: string, opts?: { nowMs?: number }): Promise<CreditSnapshot | undefined> {
    const { rows } = await this.pool.query<CreditRow>(
      `SELECT * FROM credits WHERE credit_id = $1`,
      [creditId]
    );
    if (rows.length === 0) return undefined;
    return this.snapshotFromRow(rows[0], this.pool, opts?.nowMs ?? Date.now());
  }

  /** Read all credits held by a caller pubkey, oldest first (no lock). */
  async getForCaller(callerPubkey: string, opts?: { nowMs?: number }): Promise<CreditSnapshot[]> {
    const { rows } = await this.pool.query<CreditRow>(
      `SELECT * FROM credits WHERE caller_pubkey = $1 ORDER BY created_at, credit_id`,
      [callerPubkey]
    );
    const nowMs = opts?.nowMs ?? Date.now();
    const out: CreditSnapshot[] = [];
    for (const row of rows) {
      out.push(await this.snapshotFromRow(row, this.pool, nowMs));
    }
    return out;
  }

  async getDraw(args: { creditId: string; drawId: string }): Promise<DrawRecord | undefined> {
    const { rows } = await this.pool.query<DrawRow & CreditBasisRow>(
      `${DRAW_WITH_BASIS_SELECT} WHERE d.credit_id = $1 AND d.draw_id = $2`,
      [args.creditId, args.drawId]
    );
    return rows[0] ? drawRecordFromRow(rows[0], rows[0]) : undefined;
  }

  /** Read the sole draw bound to a pre-allocated job id; ambiguity fails closed. */
  async getDrawByJobId(jobId: string): Promise<DrawRecord | undefined> {
    const { rows } = await this.pool.query<DrawRow & CreditBasisRow>(
      `${DRAW_WITH_BASIS_SELECT} WHERE d.job_id = $1 ORDER BY d.created_at LIMIT 2`,
      [jobId]
    );
    return rows.length === 1 ? drawRecordFromRow(rows[0], rows[0]) : undefined;
  }

  async listDrawsByJobId(jobId: string): Promise<DrawRecord[]> {
    const { rows } = await this.pool.query<DrawRow & CreditBasisRow>(
      `${DRAW_WITH_BASIS_SELECT} WHERE d.job_id = $1 ORDER BY d.created_at, d.credit_id, d.ledger_seq`,
      [jobId]
    );
    return rows.map((row) => drawRecordFromRow(row, row));
  }

  /**
   * All pending holds on a credit, in `ledger_seq` order (no lock). Read
   * surface for the sweeper wiring — a worker that dies mid-job
   * leaves its hold `pending` until something releases it.
   */
  async listPendingDraws(creditId: string): Promise<DrawRecord[]> {
    const { rows } = await this.pool.query<DrawRow & CreditBasisRow>(
      `${DRAW_WITH_BASIS_SELECT} WHERE d.credit_id = $1 AND d.status = 'pending' ORDER BY d.ledger_seq`,
      [creditId]
    );
    return rows.map((row) => drawRecordFromRow(row, row));
  }

  /**
   * Page host-wide pending holds older than createdBeforeMs by (created_at, credit_id,
   * ledger_seq). Use the same compound key for ordering and continuation, preserving
   * same-millisecond rows. Terminal resolution still rechecks state under the parent-credit
   * lock.
   */
  async listStalePendingDraws(args: {
    createdBeforeMs: number;
    limit: number;
    after?: StalePendingDrawCursor;
  }): Promise<DrawRecord[]> {
    const after = args.after;
    const { rows } = await this.pool.query<DrawRow & CreditBasisRow>(
      `${DRAW_WITH_BASIS_SELECT}
         WHERE d.status = 'pending' AND d.created_at < $1
           AND ($3::bigint IS NULL
                OR (d.created_at, d.credit_id, d.ledger_seq) > ($3::bigint, $4::text, $5::bigint))
         ORDER BY d.created_at, d.credit_id, d.ledger_seq
         LIMIT $2`,
      [
        args.createdBeforeMs,
        args.limit,
        after?.createdAt ?? null,
        after?.creditId ?? null,
        after?.ledgerSeq ?? null,
      ]
    );
    return rows.map((row) => drawRecordFromRow(row, row));
  }

  /**
   * Sum settled draws’ native value for the credit bound to this x402 channel.
   * Pending/released holds and drains earn nothing. Return undefined for an unbound channel,
   * distinct from earned zero, so settlement cannot guess a claim limit.
   */
  async earnedNativeForX402Channel(channelId: string): Promise<number | undefined> {
    const { rows } = await this.pool.query<{ earned: string }>(
      `SELECT COALESCE(
                (SELECT SUM(d.draw_native)
                   FROM credit_draws d
                  WHERE d.credit_id = c.credit_id
                    AND d.status = 'settled'
                    AND d.draw_native IS NOT NULL),
                0
              )::text AS earned
         FROM credits c
        WHERE c.x402_channel_id = $1`,
      [channelId]
    );
    if (rows.length === 0) return undefined;
    return toSafeInt(rows[0].earned);
  }

  /**
   * Resolve the unique credit bound to the channel. The ID is opaque and can contain colons;
   * do not reconstruct it by splitting settlement effect IDs.
   */
  async getCreditByX402Channel(channelId: string): Promise<CreditSnapshot | undefined> {
    const { rows } = await this.pool.query<CreditRow>(
      `SELECT * FROM credits WHERE x402_channel_id = $1`,
      [channelId]
    );
    return rows[0] ? this.snapshotFromRow(rows[0], this.pool, Date.now()) : undefined;
  }

  async terminalizeTempoCredits(
    evidence: TempoCreditLossEvidence,
    tx?: CreditLedgerQuerier
  ): Promise<TempoCreditLoss[]> {
    const channelId = evidence.channelId.toLowerCase();
    const observedAt = evidence.observedAt ?? Date.now();
    if (tx) return this.terminalizeTempoCreditsLocked(tx, evidence, channelId, observedAt);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const losses = await this.terminalizeTempoCreditsLocked(
        client,
        evidence,
        channelId,
        observedAt
      );
      await client.query("COMMIT");
      return losses;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async terminalizeTempoCreditsLocked(
    q: CreditLedgerQuerier,
    evidence: TempoCreditLossEvidence,
    channelId: string,
    observedAt: number
  ): Promise<TempoCreditLoss[]> {
    const { rows: credits } = await q.query<CreditRow>(
      `SELECT * FROM credits
        WHERE tempo_channel_id = $1
        ORDER BY credit_id
        FOR UPDATE`,
      [channelId]
    );
    for (const credit of credits) {
      if (credit.status === "unbacked") continue;
      if (credit.status !== "active") throw terminalCreditError(credit.credit_id, credit.status);
      const { rows: consumed } = await q.query<{ amount: string }>(
        `SELECT COALESCE(SUM(amount_micro), 0)::text AS amount
           FROM credit_draws
          WHERE credit_id = $1 AND status = 'settled'`,
        [credit.credit_id]
      );
      await q.query(
        `INSERT INTO tempo_credit_losses
           (credit_id, channel_id, caller_pubkey, currency, former_balance_micro,
            settled_on_chain_native, highest_voucher_native, consumed_service_micro,
            consumed_native, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (credit_id) DO NOTHING`,
        [
          credit.credit_id,
          channelId,
          credit.caller_pubkey,
          credit.currency,
          credit.balance_micro,
          evidence.settledOnChainNative.toString(),
          evidence.highestVoucherNative.toString(),
          consumed[0]?.amount ?? "0",
          evidence.consumedNative.toString(),
          observedAt,
        ]
      );
      await q.query(`UPDATE credits SET status = 'unbacked' WHERE credit_id = $1`, [
        credit.credit_id,
      ]);
    }
    return this.readTempoCreditLosses(q, { channelId });
  }

  async listTempoCreditLosses(args?: { limit?: number }): Promise<TempoCreditLoss[]> {
    return this.readTempoCreditLosses(this.pool, { limit: args?.limit ?? 50 });
  }

  /**
   * Reconcile the credit bound to a chain-proven empty x402 channel.
   *
   * A channel with no unclaimed backing makes every remaining customer
   * liability unsafe, so those credits become terminal. A fully settled credit
   * has neither a balance nor an unfinished drain and is safe to retain for a
   * later deposit. This also repairs a zero-liability row an older build
   * terminalized from the same observation.
   */
  async terminalizeX402Credit(
    evidence: X402CreditLossEvidence,
    tx?: CreditLedgerQuerier
  ): Promise<X402CreditLoss[]> {
    const channelId = evidence.channelId.toLowerCase();
    const observedAt = evidence.observedAt ?? Date.now();
    if (tx) return this.terminalizeX402CreditLocked(tx, evidence, channelId, observedAt);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const losses = await this.terminalizeX402CreditLocked(
        client,
        evidence,
        channelId,
        observedAt
      );
      await client.query("COMMIT");
      return losses;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async terminalizeX402CreditLocked(
    q: CreditLedgerQuerier,
    evidence: X402CreditLossEvidence,
    channelId: string,
    observedAt: number
  ): Promise<X402CreditLoss[]> {
    const { rows: credits } = await q.query<CreditRow>(
      `SELECT * FROM credits WHERE x402_channel_id = $1 FOR UPDATE`,
      [channelId]
    );
    if (credits.length > 0) {
      const credit = credits[0];
      if (credit.status !== "active" && credit.status !== "unbacked") {
        throw terminalCreditError(credit.credit_id, credit.status);
      }
      const { rows: drains } = await q.query<{ outstanding: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM credit_drains
            WHERE credit_id = $1 AND status IN ('pending', 'parked')
         ) AS outstanding`,
        [credit.credit_id]
      );
      const hasLiability = toSafeInt(credit.balance_micro) > 0 || drains[0]?.outstanding;
      if (!hasLiability) {
        // An empty channel is reusable. Repairing the prior false terminal
        // state under this same channel-first transaction makes a refill's
        // following ledger upsert safe and idempotent.
        if (credit.status === "unbacked") {
          await q.query(`UPDATE credits SET status = 'active' WHERE credit_id = $1`, [
            credit.credit_id,
          ]);
          await q.query(`DELETE FROM x402_credit_losses WHERE credit_id = $1`, [credit.credit_id]);
        }
        return this.readX402CreditLosses(q, { channelId });
      }
      if (credit.status !== "unbacked") {
        const { rows: consumed } = await q.query<{ amount: string }>(
          `SELECT COALESCE(SUM(amount_micro), 0)::text AS amount
             FROM credit_draws
            WHERE credit_id = $1 AND status = 'settled'`,
          [credit.credit_id]
        );
        await q.query(
          `INSERT INTO x402_credit_losses
             (credit_id, channel_id, caller_pubkey, currency, former_balance_micro,
              channel_balance_native, total_claimed_native, consumed_service_micro, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (credit_id) DO NOTHING`,
          [
            credit.credit_id,
            channelId,
            credit.caller_pubkey,
            credit.currency,
            credit.balance_micro,
            evidence.channelBalanceNative.toString(),
            evidence.totalClaimedNative.toString(),
            consumed[0]?.amount ?? "0",
            observedAt,
          ]
        );
        await q.query(`UPDATE credits SET status = 'unbacked' WHERE credit_id = $1`, [
          credit.credit_id,
        ]);
      }
    }
    return this.readX402CreditLosses(q, { channelId });
  }

  async listX402CreditLosses(args?: { limit?: number }): Promise<X402CreditLoss[]> {
    return this.readX402CreditLosses(this.pool, { limit: args?.limit ?? 50 });
  }

  /**
   * Move all available balance to a drain liability under the credit lock; pending holds stay
   * reserved. Expiry alone does not prevent reclaim before a sweep releases the balance.
   * Repeating (creditId, drainId) returns the recorded liability; owner, method and payout
   * conflicts refuse.
   *
   * An unresolved channel refund blocks fresh drain IDs but admits its own effect ID for
   * repair. Caller-supplied payout validation belongs to the route. With tx, join the channel
   * transaction without controlling it.
   */
  async requestDrain(args: {
    creditId: string;
    drainId: string;
    /** Verified caller pubkey — a drain may only be requested by the owner. */
    callerPubkey: string;
    method: DrainMethod;
    /** Method-specific payout target, validated by the route before it lands here. */
    payout: Record<string, string>;
    /** Refuse atomically unless every funded micro is currently available. */
    requireNoPending?: boolean;
    /** External channel transaction; caller owns BEGIN/COMMIT. */
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainRequestResult> {
    const nowMs = args.nowMs ?? Date.now();
    const run = async (client: CreditLedgerQuerier, credit: CreditRow) => {
      if (credit.caller_pubkey !== args.callerPubkey) {
        throw new CreditLedgerError(
          "caller_mismatch",
          `credit ${args.creditId} belongs to a different caller pubkey`
        );
      }
      const existing = await this.readDrain(client, args.creditId, args.drainId);
      if (existing) {
        if (
          existing.method !== args.method ||
          JSON.stringify(existing.payout) !== JSON.stringify(args.payout)
        ) {
          throw new CreditLedgerError(
            "drain_conflict",
            `drain ${args.drainId} on credit ${args.creditId} was recorded with a different method or payout`
          );
        }
        return {
          drain: drainRecordFromRow(existing, credit),
          credit: await this.snapshotFromRow(credit, client, nowMs),
          replayed: true,
        };
      }
      if (credit.status !== "active") throw terminalCreditError(args.creditId, credit.status);
      // Under the credit lock, off the locked row, for the same reason as
      // `draw` — the cooperative drain holds this row across its facilitator
      // call, so a read above the lock would answer from before the wedge it
      // exists to catch. The settlement being repaired is excluded by its own
      // effect id: the wedged drain's ledger row was rolled back with the
      // transaction that raised the refusal, so both the caller's retry and
      // the operator reconcile re-enter here with that same drain id, and
      // gating them on the settlement they exist to resolve would make the
      // wedge permanent.
      const blocking = await this.blockingX402Refund(
        credit.x402_channel_id,
        X402_WEDGED_SETTLEMENT_STATUSES
      );
      if (blocking && blocking.effectId !== `${args.creditId}:${args.drainId}`) {
        throw x402SettlementPending(args.creditId, blocking);
      }
      const balanceMicro = toSafeInt(credit.balance_micro);
      const pending = await this.pendingSums(client, args.creditId);
      const availableMicro = balanceMicro - pending.micro;
      if (args.requireNoPending && pending.micro > 0) {
        throw new CreditLedgerError(
          "drain_conflict",
          `credit ${args.creditId} has pending draws that must finish before it can drain`,
          { drainConflict: "pending_draws" }
        );
      }
      if (availableMicro <= 0) {
        throw new CreditLedgerError(
          "nothing_to_drain",
          `credit ${args.creditId} has no available balance to drain`,
          { availableMicro, balanceMicro }
        );
      }
      // Deplete the credit’s own FIFO lots. Each debit is the decrease in its floored
      // remaining sats obligation, not an independently floored slice; delivery reserve is
      // deducted once from the aggregate obligation. Uncovered or basisless lots leave
      // owedSats null for the live-rate fallback.
      const inKind = isNonChannelBitcoinRail(credit.rail)
        ? await this.reclaimInKind(client, args.creditId, availableMicro)
        : undefined;
      if (inKind?.owedSats === 0) {
        // Every micro is backed by a real sats basis and the reclaim still
        // nets to zero — the balance is worth less than one satoshi, or no
        // more than the reserve it costs to hand over. Either way
        // there is nothing to send and no drain worth opening: a zero-value
        // row would sit pending forever and hold the servicer's queue open.
        // The remainder stays with the provider as dust, and the
        // balance remains the caller's — reclaimable again on any top-up that
        // lifts it over the line.
        //
        // Its own code rather than `nothing_to_drain`, which means "the
        // balance is zero or held by running jobs" and is `retryable: true`
        // with a wait-and-retry hint. Here there is real balance on the row
        // and waiting achieves nothing — an agent relaying that copy would
        // hand its human a permanent refusal dressed as a transient one.
        throw new CreditLedgerError(
          "drain_below_dust",
          `credit ${args.creditId} holds ${availableMicro} micro, worth ${inKind.grossSats ?? 0} sats at the rate it was funded — no more than the ${DRAIN_DELIVERY_RESERVE_SATS} sats it costs to hand back`,
          { availableMicro, balanceMicro }
        );
      }
      const ledgerSeq = toSafeInt(credit.last_ledger_seq) + 1;
      const balanceAfter = balanceMicro - availableMicro;
      const drainedMsats = Math.max(0, toSafeInt(credit.msats_remaining) - pending.msats);
      const drainedNative =
        credit.native_remaining === null
          ? null
          : Math.max(0, toSafeInt(credit.native_remaining) - pending.native);
      // The rail-value remainder leaves with the fiat, exactly as a settled
      // draw's slice does — only what pending holds have allocated
      // stays behind. Leaving the basis untouched would let a post-drain
      // top-up over-allocate draw_msats and over-book revenue. LEAST guards
      // legacy zero-basis credits from being inflated to the pending sum.
      await client.query(
        `UPDATE credits
           SET balance_micro    = $2,
               last_ledger_seq  = $3,
               msats_remaining  = LEAST(msats_remaining, $4),
               native_remaining = CASE WHEN native_remaining IS NULL THEN NULL
                                       ELSE LEAST(native_remaining, $5) END
         WHERE credit_id = $1`,
        [args.creditId, balanceAfter, ledgerSeq, pending.msats, pending.native]
      );
      const { rows } = await client.query<DrainRow>(
        `INSERT INTO credit_drains
           (credit_id, drain_id, method, payout, amount_micro, balance_after_micro,
            drained_msats, drained_native, owed_sats, lot_debits, ledger_seq, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', $12)
         RETURNING *`,
        [
          args.creditId,
          args.drainId,
          args.method,
          JSON.stringify(args.payout),
          availableMicro,
          balanceAfter,
          drainedMsats,
          drainedNative,
          inKind?.owedSats ?? null,
          inKind ? JSON.stringify(inKind.debits) : null,
          ledgerSeq,
          nowMs,
        ]
      );
      if (inKind) await this.applyLotDebits(client, inKind.debits, -1);
      const updated: CreditRow = {
        ...credit,
        balance_micro: String(balanceAfter),
        last_ledger_seq: String(ledgerSeq),
      };
      return {
        drain: drainRecordFromRow(rows[0], credit),
        credit: await this.snapshotFromRow(updated, client, nowMs),
        replayed: false,
      };
    };
    if (args.tx) {
      return run(args.tx, await this.lockCreditRow(args.tx, args.creditId));
    }
    return this.withCreditLock(args.creditId, run);
  }

  async getDrain(args: {
    creditId: string;
    drainId: string;
  }): Promise<CreditDrainRecord | undefined> {
    const { rows } = await this.pool.query<DrainJoinRow>(
      `SELECT d.*, ${DRAIN_CREDIT_COLUMNS} FROM credit_drains d
       JOIN credits c ON c.credit_id = d.credit_id
       WHERE d.credit_id = $1 AND d.drain_id = $2`,
      [args.creditId, args.drainId]
    );
    return rows.length > 0 ? drainRecordFromJoinRow(rows[0]) : undefined;
  }

  /**
   * One credit's undepleted funding lots, oldest first — the
   * public read behind the reclaim's own arithmetic, for anything that needs
   * to show its work.
   */
  async listFundingLots(creditId: string): Promise<FundingLot[]> {
    return this.openLots(this.pool, creditId);
  }

  /**
   * Host-wide in-kind Bitcoin deposit liability, excluding channel collateral. Credits with
   * missing coverage or any basisless lot are reported as gaps and use the live-rate fallback
   * rather than a guessed sats obligation. Group fiat micro by currency; never sum
   * denominations.
   * Pending job holds remain liabilities until settled because they may release to the caller.
   */
  async bitcoinDepositLiability(): Promise<BitcoinDepositLiability> {
    const { rows } = await this.pool.query<BitcoinLiabilityRow>(
      `SELECT c.rail, c.currency,
              COUNT(*) AS credits,
              COALESCE(SUM(cov.owed_sats) FILTER (WHERE ${IN_KIND_PREDICATE}), 0) AS owed_sats,
              COALESCE(SUM(c.balance_micro), 0) AS balance_micro,
              COUNT(*) FILTER (WHERE cov.covered_micro < c.balance_micro) AS uncovered_credits,
              COALESCE(SUM(c.balance_micro) FILTER (WHERE cov.covered_micro < c.balance_micro), 0)
                AS uncovered_micro,
              COUNT(*) FILTER (WHERE cov.covered_micro >= c.balance_micro AND cov.basisless_micro > 0)
                AS unbacked_credits,
              COALESCE(SUM(c.balance_micro)
                FILTER (WHERE cov.covered_micro >= c.balance_micro AND cov.basisless_micro > 0), 0)
                AS unbacked_micro
         FROM credits c
         CROSS JOIN LATERAL (${LOT_COVERAGE_LATERAL}) cov
        WHERE ${BITCOIN_CREDIT_PREDICATE}
        GROUP BY c.rail, c.currency
        ORDER BY c.rail, c.currency`
    );
    const liability: BitcoinDepositLiability = {
      depositSats: 0,
      credits: 0,
      byRail: [],
      byCurrency: [],
      uncoveredCredits: 0,
      uncoveredByCurrency: [],
      unbackedCredits: 0,
      unbackedByCurrency: [],
    };
    const byRail = new Map<
      string,
      { rail: NonChannelBitcoinRail; sats: number; credits: number }
    >();
    const byCurrency = new Map<string, { currency: string; micro: number; credits: number }>();
    const uncoveredByCurrency = new Map<
      string,
      { currency: string; micro: number; credits: number }
    >();
    const unbackedByCurrency = new Map<
      string,
      { currency: string; micro: number; credits: number }
    >();
    for (const row of rows) {
      const sats = toSafeInt(row.owed_sats);
      const credits = toSafeInt(row.credits);
      const uncoveredCredits = toSafeInt(row.uncovered_credits);
      const unbackedCredits = toSafeInt(row.unbacked_credits);
      liability.depositSats += sats;
      liability.credits += credits;
      liability.uncoveredCredits += uncoveredCredits;
      liability.unbackedCredits += unbackedCredits;
      if (uncoveredCredits > 0) {
        const currency = uncoveredByCurrency.get(row.currency) ?? {
          currency: row.currency,
          micro: 0,
          credits: 0,
        };
        currency.micro += toSafeInt(row.uncovered_micro);
        currency.credits += uncoveredCredits;
        uncoveredByCurrency.set(row.currency, currency);
      }
      if (unbackedCredits > 0) {
        const currency = unbackedByCurrency.get(row.currency) ?? {
          currency: row.currency,
          micro: 0,
          credits: 0,
        };
        currency.micro += toSafeInt(row.unbacked_micro);
        currency.credits += unbackedCredits;
        unbackedByCurrency.set(row.currency, currency);
      }
      const rail = byRail.get(row.rail) ?? { rail: row.rail, sats: 0, credits: 0 };
      rail.sats += sats;
      rail.credits += credits;
      byRail.set(row.rail, rail);
      // Grouped rather than summed: an admin read is host-wide, and a
      // multi-mount host can hold credits in two denominations whose micro
      // figures add up to a number nobody can act on. The sats total has no
      // such problem, which is the point of the in-kind figure.
      const currency = byCurrency.get(row.currency) ?? {
        currency: row.currency,
        micro: 0,
        credits: 0,
      };
      currency.micro += toSafeInt(row.balance_micro);
      currency.credits += credits;
      byCurrency.set(row.currency, currency);
    }
    liability.byRail = [...byRail.values()];
    liability.byCurrency = [...byCurrency.values()];
    liability.uncoveredByCurrency = [...uncoveredByCurrency.values()];
    liability.unbackedByCurrency = [...unbackedByCurrency.values()];
    return liability;
  }

  /**
   * Every unfulfilled drain, oldest first (no lock) — the builder batch
   * job's work list and the outstanding-refund-liability read the
   * scoped-budget assertion sums over. `pending` means un-parked (Cashu) or
   * un-sent (Lightning/x402/mpp); `parked` value is already committed to a
   * caller-locked token, so it is out of the liability the LN send budget
   * must cover.
   */
  async listPendingDrains(): Promise<CreditDrainRecord[]> {
    const { rows } = await this.pool.query<DrainJoinRow>(
      `SELECT d.*, ${DRAIN_CREDIT_COLUMNS} FROM credit_drains d
       JOIN credits c ON c.credit_id = d.credit_id
       WHERE d.status IN ('pending','exit_required') ORDER BY d.created_at, d.credit_id, d.drain_id`
    );
    return rows.map(drainRecordFromJoinRow);
  }

  /**
   * Page pending Tempo-channel drains by (created_at, credit_id, drain_id), optionally
   * age-bounded, excluding written-off rows. Accept the legacy mpp stored method as well as
   * tempo so pre-migration drains remain repairable. Use the compound key for both ordering
   * and continuation.
   */
  async listChannelDrains(args: {
    limit: number;
    after?: ChannelDrainCursor;
    createdBeforeMs: number;
    rail: "tempo";
    includeResolved?: boolean;
  }): Promise<CreditDrainRecord[]> {
    const params: unknown[] = [args.createdBeforeMs, args.limit];
    let keyset = "";
    if (args.after) {
      params.push(args.after.createdAt, args.after.creditId, args.after.drainId);
      keyset = ` AND (d.created_at, d.credit_id, d.drain_id) > ($3, $4, $5)`;
    }
    const { rows } = await this.pool.query<DrainJoinRow>(
      `SELECT d.*, ${DRAIN_CREDIT_COLUMNS} FROM credit_drains d
       JOIN credits c ON c.credit_id = d.credit_id
       WHERE d.status IN ('pending','exit_required')
         AND d.method = 'tempo'
         AND c.tempo_channel_id IS NOT NULL
         AND d.created_at <= $1
         ${args.includeResolved ? "" : "AND d.written_off_at IS NULL"}
         ${keyset}
       ORDER BY d.created_at, d.credit_id, d.drain_id
       LIMIT $2`,
      params
    );
    return rows.map(drainRecordFromJoinRow);
  }

  /**
   * Record that an operator reviewed a floor-refused channel drain and is not
   * booking it. Books nothing anywhere — no status change, no
   * balance movement, no platform report.
   *
   * A single-statement CAS on `written_off_at IS NULL`, so the first note on
   * file wins: a second operator asking for the same decision finds one
   * already recorded and is told so (`written: false`) rather than writing
   * over a colleague's reason. Only a `pending` drain may be written off — a
   * terminal one has an answer already.
   */
  async writeOffDrain(args: {
    creditId: string;
    drainId: string;
    note?: string;
    nowMs?: number;
  }): Promise<DrainWriteOff | undefined> {
    const { rowCount } = await this.pool.query(
      `UPDATE credit_drains SET write_off_note = $3, written_off_at = $4
        WHERE credit_id = $1 AND drain_id = $2
          AND status = 'pending' AND written_off_at IS NULL`,
      [args.creditId, args.drainId, args.note ?? null, args.nowMs ?? Date.now()]
    );
    const drain = await this.getDrain({ creditId: args.creditId, drainId: args.drainId });
    if (!drain) return undefined;
    return { drain, written: (rowCount ?? 0) > 0 };
  }

  /**
   * Drop a recorded write-off, inside the transaction that books the drain.
   *
   * This is the reversibility half, and its placement is the whole guarantee:
   * a reconcile clears the note in the same transaction as the `pending →
   * sent` CAS, so a ledger leg that rolls back leaves the operator's decision
   * exactly as it found it. The x402 repair needs an explicit compensating
   * restore for this because its settlement row lives outside the ledger's
   * transaction; here the two are one row.
   */
  async clearDrainWriteOff(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
  }): Promise<void> {
    const q = args.tx ?? this.pool;
    await q.query(
      `UPDATE credit_drains SET write_off_note = NULL, written_off_at = NULL
        WHERE credit_id = $1 AND drain_id = $2`,
      [args.creditId, args.drainId]
    );
  }

  /** Keep the debit and close intent while the caller uses its timed channel exit. */
  async requireTempoDrainExit(args: {
    creditId: string; drainId: string; tx?: CreditLedgerQuerier;
  }): Promise<DrainTransitionResult> {
    const q = args.tx ?? this.pool;
    const { rows } = await q.query<DrainRow>(
      `UPDATE credit_drains d SET status='exit_required'
       FROM credits c WHERE d.credit_id=c.credit_id AND d.credit_id=$1 AND d.drain_id=$2
         AND d.status='pending' AND d.method='tempo' AND c.tempo_channel_id IS NOT NULL
       RETURNING d.*`, [args.creditId, args.drainId]
    );
    if (rows.length) return { drain: await this.rejoin(q, rows[0]), replayed: false };
    return this.refuseTransition(q, args.creditId, args.drainId, {
      idempotentWhen: (row) => row.status === "exit_required" || row.status === "sent",
      verb: "require timed exit",
    });
  }

  /**
   * Cancel an unfulfilled Tempo cooperative drain and restore the exact
   * balance plus rail basis it removed (`pending -> released`). This is only
   * for a close the channel reconciliation proved cannot pay; ordinary payout
   * rails never re-credit a liability after it has been handed to a worker.
   */
  async releaseDrain(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainReleaseResult> {
    const nowMs = args.nowMs ?? Date.now();
    const run = async (client: CreditLedgerQuerier, credit: CreditRow) => {
      const row = await this.readDrain(client, args.creditId, args.drainId);
      if (!row) {
        throw new CreditLedgerError(
          "drain_not_found",
          `drain ${args.drainId} on credit ${args.creditId} not found`
        );
      }
      if (row.status === "released") {
        return {
          drain: drainRecordFromRow(row, credit),
          credit: await this.snapshotFromRow(credit, client, nowMs),
          replayed: true,
        };
      }
      if (row.status !== "pending") {
        throw new CreditLedgerError(
          "invalid_drain_state",
          `cannot release ${row.method} drain ${args.drainId} from status ${row.status}`
        );
      }
      const { rows } = await client.query<DrainRow>(
        `UPDATE credit_drains SET status = 'released', released_at = $3
         WHERE credit_id = $1 AND drain_id = $2 AND status = 'pending'
         RETURNING *`,
        [args.creditId, args.drainId, nowMs]
      );
      if (!rows[0]) {
        throw new CreditLedgerError(
          "invalid_drain_state",
          `drain ${args.drainId} changed while it was being released`
        );
      }
      await client.query(
        `UPDATE credits
           SET balance_micro = balance_micro + $2,
               msats_remaining = msats_remaining + $3,
               native_remaining = CASE
                 WHEN native_remaining IS NULL OR $4::BIGINT IS NULL THEN native_remaining
                 ELSE native_remaining + $4
               END
         WHERE credit_id = $1`,
        [args.creditId, row.amount_micro, row.drained_msats, row.drained_native]
      );
      // and the funding lots the drain consumed, exactly as it took
      // them — which is why the drain records its debits rather than the
      // release re-deriving them. No Bitcoin drain reaches this verb today
      // (only a Tempo close the chain proved cannot pay is released, and a
      // channel credit has no lots), but the restore is unconditional so the
      // "lot remainders track `balance_micro`" invariant needs no exception.
      await this.applyLotDebits(client, row.lot_debits ?? [], 1);
      const restored = await this.lockCreditRow(client, args.creditId);
      return {
        drain: drainRecordFromRow(rows[0], restored),
        credit: await this.snapshotFromRow(restored, client, nowMs),
        replayed: false,
      };
    };
    if (args.tx) return run(args.tx, await this.lockCreditRow(args.tx, args.creditId));
    return this.withCreditLock(args.creditId, run);
  }

  /**
   * Attach the parked Cashu token to a pending drain (`pending → parked`).
   * A single-statement CAS on `status = 'pending'` — no credit lock needed;
   * the money already left the balance at request time. Idempotent: parking
   * an already-parked/picked-up drain with the same token returns the
   * recorded row (the builder's park retry after a lost response); a
   * different token refuses with `drain_conflict` rather than silently
   * replacing notes the caller may already hold.
   *
   * Pass `tx` to commit the park atomically with the accumulator row swap
   * the admin route performs alongside it.
   */
  async parkDrain(args: {
    creditId: string;
    drainId: string;
    token: string;
    /** Cost evidence for a just-in-time mint; absent on an accumulator park. */
    fulfilment?: DrainFulfilment;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<CreditDrainRecord> {
    const q = args.tx ?? this.pool;
    const nowMs = args.nowMs ?? Date.now();
    const { rows } = await q.query<DrainRow>(
      `UPDATE credit_drains
          SET status = 'parked', token = $3, parked_at = $4,
              fulfilment = COALESCE($5::jsonb, fulfilment)
       WHERE credit_id = $1 AND drain_id = $2 AND status = 'pending' AND method = 'cashu'
       RETURNING *`,
      [
        args.creditId,
        args.drainId,
        args.token,
        nowMs,
        args.fulfilment ? JSON.stringify(args.fulfilment) : null,
      ]
    );
    if (rows.length > 0) return this.rejoin(q, rows[0]);
    const refusal = await this.refuseTransition(q, args.creditId, args.drainId, {
      idempotentWhen: (row) =>
        (row.status === "parked" || row.status === "picked_up") && row.token === args.token,
      verb: "park",
    });
    return refusal.drain;
  }

  /**
   * Record that the caller collected the parked token (`parked →
   * picked_up`). Idempotent on `picked_up` — pickup must survive response
   * loss, so the caller's re-poll keeps returning the same token either way.
   *
   * Returns `replayed` because this is a **terminal** transition and the money
   * has left at exactly one of these calls: the platform drain
   * report must be emitted by that caller and no other. Pass `tx` to write the
   * report through the same transaction as the CAS.
   */
  async markDrainPickedUp(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult> {
    const q = args.tx ?? this.pool;
    const nowMs = args.nowMs ?? Date.now();
    const { rows } = await q.query<DrainRow>(
      `UPDATE credit_drains SET status = 'picked_up', picked_up_at = $3
       WHERE credit_id = $1 AND drain_id = $2 AND status = 'parked'
       RETURNING *`,
      [args.creditId, args.drainId, nowMs]
    );
    if (rows.length > 0) return { drain: await this.rejoin(q, rows[0]), replayed: false };
    return this.refuseTransition(q, args.creditId, args.drainId, {
      idempotentWhen: (row) => row.status === "picked_up",
      verb: "mark picked up",
    });
  }

  /**
   * Record a completed send-back (`pending → sent`) for the non-parked
   * methods — the builder's batch job paid the Lightning invoice or shipped
   * the on-chain transfer and posts the settlement reference. Idempotent on
   * `sent` (the recorded `sent_ref` wins; a retry after a lost response
   * carries the same reference or none at all).
   *
   * `replayed` and `tx` carry the same meaning as on {@link markDrainPickedUp},
   * and matter more here: the builder's batch job re-POSTs `mark-drain-sent`
   * on every recovery pass, so the replay is the routine case rather than the
   * exception.
   */
  async markDrainSent(args: {
    creditId: string;
    drainId: string;
    /** Settlement evidence — e.g. `{ preimage, amount_msats }` for Lightning. */
    sentRef: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult> {
    const q = args.tx ?? this.pool;
    const nowMs = args.nowMs ?? Date.now();
    const { rows } = await q.query<DrainRow>(
      `UPDATE credit_drains SET status = 'sent', sent_ref = $3, sent_at = $4
       WHERE credit_id = $1 AND drain_id = $2 AND status IN ('pending','exit_required') AND method <> 'cashu'
       RETURNING *`,
      [args.creditId, args.drainId, JSON.stringify(args.sentRef), nowMs]
    );
    if (rows.length > 0) return { drain: await this.rejoin(q, rows[0]), replayed: false };
    return this.refuseTransition(q, args.creditId, args.drainId, {
      idempotentWhen: (row) => row.status === "sent",
      verb: "mark sent",
    });
  }

  /**
   * Append an opaque supplied receipt observation to the drain’s JSONB evidence array.
   * Issuance and authentication belong to callers/consumers; this store does not verify
   * signatures. Preserve append order on replay/poll reads.
   */
  async appendDrainReceipt(args: {
    creditId: string;
    drainId: string;
    receipt: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
  }): Promise<void> {
    const q = args.tx ?? this.pool;
    await q.query(
      `UPDATE credit_drains SET receipts = receipts || $3::jsonb
       WHERE credit_id = $1 AND drain_id = $2`,
      [args.creditId, args.drainId, JSON.stringify([args.receipt])]
    );
  }

  private async readDrain(
    q: CreditLedgerQuerier,
    creditId: string,
    drainId: string
  ): Promise<DrainRow | undefined> {
    const { rows } = await q.query<DrainRow>(
      `SELECT * FROM credit_drains WHERE credit_id = $1 AND drain_id = $2`,
      [creditId, drainId]
    );
    return rows[0];
  }

  private async rejoin(q: CreditLedgerQuerier, row: DrainRow): Promise<CreditDrainRecord> {
    const { rows } = await q.query<DrainCreditJoin>(
      `SELECT currency, caller_pubkey, tempo_channel_id, x402_channel_id
         FROM credits WHERE credit_id = $1`,
      [row.credit_id]
    );
    return drainRecordFromRow(row, rows[0]);
  }

  private async refuseTransition(
    q: CreditLedgerQuerier,
    creditId: string,
    drainId: string,
    opts: { idempotentWhen: (row: DrainRow) => boolean; verb: string }
  ): Promise<DrainTransitionResult> {
    const row = await this.readDrain(q, creditId, drainId);
    if (!row) {
      throw new CreditLedgerError(
        "drain_not_found",
        `drain ${drainId} not found on credit ${creditId}`
      );
    }
    if (opts.idempotentWhen(row)) return { drain: await this.rejoin(q, row), replayed: true };
    throw new CreditLedgerError(
      row.status === "parked" || row.status === "picked_up" || row.status === "sent"
        ? "drain_conflict"
        : "invalid_drain_state",
      `cannot ${opts.verb} drain ${drainId}: status is ${row.status} (method ${row.method})`
    );
  }

  /**
   * Deplete FIFO lots even when they cannot price the reclaim; stale open lots must not
   * remain behind a debited balance. Publish owedSats only with complete positive sats
   * coverage, net of one delivery reserve. Otherwise preserve null for a live-rate fallback.
   * Returned debits allow an unpaid drain release to restore the exact lots.
   */
  private async reclaimInKind(
    q: CreditLedgerQuerier,
    creditId: string,
    amountMicro: number
  ): Promise<{ owedSats: number | null; grossSats: number | null; debits: LotDebit[] }> {
    const depletion = depleteLots(await this.openLots(q, creditId), amountMicro);
    const inKind = isInKindDepletion(depletion, amountMicro);
    return {
      owedSats: inKind ? netOwedSats(depletion.satsOwed) : null,
      grossSats: inKind ? depletion.satsOwed : null,
      debits: depletion.debits,
    };
  }

  /**
   * This credit's undepleted funding lots, oldest first.
   *
   * Ordered in SQL on the same `(created_at, lot_id)` key the partial index
   * carries, so FIFO is the index's own order rather than something a reader
   * re-establishes. Depleted lots stay on the table as the deposit's audit
   * trail and are excluded here — they price nothing.
   */
  private async openLots(q: CreditLedgerQuerier, creditId: string): Promise<FundingLot[]> {
    const { rows } = await q.query<FundingLotRow>(
      `SELECT * FROM credit_funding_lots
        WHERE credit_id = $1 AND remaining_micro > 0
        ORDER BY created_at, lot_id`,
      [creditId]
    );
    return rows.map(fundingLotFromRow);
  }

  /**
   * Move `debits` out of (`sign: -1`) or back into (`sign: 1`) their lots.
   *
   * Always runs under the credit row lock the caller already holds, on that
   * caller's handle, so the read-then-write is serialized per credit exactly
   * as every other balance move is.
   */
  private async applyLotDebits(
    q: CreditLedgerQuerier,
    debits: LotDebit[],
    sign: 1 | -1
  ): Promise<void> {
    for (const debit of debits) {
      await q.query(
        `UPDATE credit_funding_lots
            SET remaining_micro = GREATEST(LEAST(remaining_micro + $2, credited_micro), 0)
          WHERE lot_id = $1`,
        [debit.lotId, sign * debit.micro]
      );
    }
  }

  private async resolveDraw(args: {
    creditId: string;
    drawId: string;
    to: "settled" | "released";
    releaseOutbox?: CreditDrawReleaseOutbox;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrawResolution> {
    if (args.tx) {
      const credit = await this.lockCreditRow(args.tx, args.creditId);
      return this.resolveDrawLocked(args.tx, credit, args);
    }
    return this.withCreditLock(args.creditId, (client, credit) =>
      this.resolveDrawLocked(client, credit, args)
    );
  }

  private async resolveDrawLocked(
    client: CreditLedgerQuerier,
    credit: CreditRow,
    args: {
      creditId: string;
      drawId: string;
      to: "settled" | "released";
      releaseOutbox?: CreditDrawReleaseOutbox;
      nowMs?: number;
    }
  ): Promise<DrawResolution> {
    const nowMs = args.nowMs ?? Date.now();
    const draw = await this.readDraw(client, args.creditId, args.drawId);
    if (!draw) {
      throw new CreditLedgerError(
        "draw_not_found",
        `draw ${args.drawId} not found on credit ${args.creditId}`
      );
    }
    let balanceMicro = toSafeInt(credit.balance_micro);
    let replayed = false;
    if (draw.status === args.to) {
      replayed = true;
    } else if (draw.status !== "pending") {
      throw new CreditLedgerError(
        "invalid_draw_state",
        `cannot ${args.to === "settled" ? "settle" : "release"} draw ${args.drawId}: status is ${draw.status}`,
        { currentStatus: draw.status }
      );
    } else {
      await client.query(
        `UPDATE credit_draws SET status = $3, resolved_at = $4
           WHERE credit_id = $1 AND draw_id = $2`,
        [args.creditId, args.drawId, args.to, nowMs]
      );
      if (args.to === "settled") {
        const amountMicro = toSafeInt(draw.amount_micro);
        balanceMicro -= amountMicro;
        // FIFO lot depletion determines a non-channel Bitcoin draw’s settled sats value,
        // replacing its pooled hold forecast. Preserve that forecast as allocated_msats so
        // revenue adjusts only the draw component of a job’s paid_msats. Channels and
        // basisless lots keep the pooled allocation; zero is a real superseded forecast, not
        // absence.
        const forecastMsats = toSafeInt(draw.draw_msats);
        let settledMsats = forecastMsats;
        if (isNonChannelBitcoinRail(credit.rail)) {
          const depletion = depleteLots(await this.openLots(client, args.creditId), amountMicro);
          const inKindMsats = inKindDrawMsats(depletion, amountMicro);
          settledMsats = inKindMsats ?? forecastMsats;
          await client.query(`UPDATE credit_draws SET settled_sats = $3
            WHERE credit_id = $1 AND draw_id = $2`,
            [args.creditId, args.drawId, inKindMsats === null ? null : inKindMsats / 1000]);
          await this.applyLotDebits(client, depletion.debits, -1);
        }
        if (settledMsats !== forecastMsats) {
          // Write allocated_msats only when repricing changes the value. NULL continues to
          // mean draw_msats is the original allocation.
          await client.query(
            `UPDATE credit_draws SET draw_msats = $3, allocated_msats = $4
               WHERE credit_id = $1 AND draw_id = $2`,
            [args.creditId, args.drawId, settledMsats, forecastMsats]
          );
          draw.draw_msats = String(settledMsats);
          draw.allocated_msats = String(forecastMsats);
        }
        // Subtracting the rail value consumed by the draw leaves the credit with
        // its fiat balance. GREATEST guards a credit funded before the basis
        // columns existed (remainders 0) from going negative, as well as a
        // Bitcoin credit whose earlier draws consumed a cheaper lot than the
        // pooled forecast predicted. `draw_native` is untouched by the
        // re-price: neither Cashu nor Lightning reports a native amount, so
        // both remainders are NULL on every rail that carries lots.
        await client.query(
          `UPDATE credits
               SET balance_micro    = $2,
                   msats_remaining  = GREATEST(msats_remaining - $3, 0),
                   native_remaining = CASE WHEN native_remaining IS NULL THEN NULL
                                           ELSE GREATEST(native_remaining - $4, 0) END
             WHERE credit_id = $1`,
          [args.creditId, balanceMicro, settledMsats, Number(draw.draw_native ?? 0)]
        );
      }
    }
    const availableMicro =
      credit.status === "unbacked"
        ? 0
        : balanceMicro - (await this.pendingSums(client, args.creditId)).micro;
    const resolution: DrawResolution = {
      ...drawResultFromRow(draw, credit),
      status: args.to,
      replayed,
      availableMicro,
      resolvedAt: draw.status === "pending" ? nowMs : Number(draw.resolved_at ?? nowMs),
    };
    if (!replayed && args.to === "released" && resolution.amountMicro > 0 && args.releaseOutbox) {
      await args.releaseOutbox.enqueue(client, {
        dvmId: args.releaseOutbox.dvmId,
        creditId: resolution.creditId,
        drawId: resolution.drawId,
        amountMicro: resolution.amountMicro,
        creditCurrency: credit.currency,
        ledgerSeq: resolution.ledgerSeq,
        releasedAt: resolution.resolvedAt,
      });
    }
    return resolution;
  }

  /**
   * Run `fn` inside a transaction holding `SELECT … FOR UPDATE` on the credit
   * row — the lock every `credit_draws` write must be under. Commits on
   * success (harmless for read-only replay paths), rolls back on throw.
   */
  private async withCreditLock<T>(
    creditId: string,
    fn: (client: PoolClient, credit: CreditRow) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const credit = await this.lockCreditRow(client, creditId);
      const result = await fn(client, credit);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back or connection dead
      }
      throw err;
    } finally {
      client.release();
    }
  }

  private async lockCreditRow(q: CreditLedgerQuerier, creditId: string): Promise<CreditRow> {
    const { rows } = await q.query<CreditRow>(
      `SELECT * FROM credits WHERE credit_id = $1 FOR UPDATE`,
      [creditId]
    );
    if (rows.length === 0) {
      throw new CreditLedgerError("credit_not_found", `credit ${creditId} not found`);
    }
    return rows[0];
  }

  private async readDraw(
    q: CreditLedgerQuerier,
    creditId: string,
    drawId: string
  ): Promise<DrawRow | undefined> {
    const { rows } = await q.query<DrawRow>(
      `SELECT * FROM credit_draws WHERE credit_id = $1 AND draw_id = $2`,
      [creditId, drawId]
    );
    return rows[0];
  }

  /**
   * Held-but-unresolved totals for a credit, in all three units at once — the
   * fiat micro that defines available balance plus the rail-value remainders
   * a new draw allocates against. One round-trip, since every
   * caller needs the micro sum anyway.
   */
  private async pendingSums(
    q: CreditLedgerQuerier,
    creditId: string
  ): Promise<{ micro: number; msats: number; native: number }> {
    const { rows } = await q.query<{ micro: string; msats: string; native: string }>(
      `SELECT COALESCE(SUM(amount_micro), 0) AS micro,
              COALESCE(SUM(draw_msats), 0)   AS msats,
              COALESCE(SUM(draw_native), 0)  AS native
       FROM credit_draws WHERE credit_id = $1 AND status = 'pending'`,
      [creditId]
    );
    return {
      micro: toSafeInt(rows[0].micro),
      msats: toSafeInt(rows[0].msats),
      native: toSafeInt(rows[0].native),
    };
  }

  private async snapshotFromRow(
    row: CreditRow,
    q: CreditLedgerQuerier,
    nowMs: number
  ): Promise<CreditSnapshot> {
    const balanceMicro = toSafeInt(row.balance_micro);
    const expiryMs = toSafeInt(row.expiry_ms);
    const pending = await this.pendingSums(q, row.credit_id);
    const live = row.status === "active";
    return {
      creditId: row.credit_id,
      callerPubkey: row.caller_pubkey,
      currency: row.currency,
      balanceMicro,
      availableMicro: live ? balanceMicro - pending.micro : 0,
      nativeAvailable:
        row.native_remaining === null
          ? null
          : live
            ? Math.max(0, toSafeInt(row.native_remaining) - pending.native)
            : 0,
      expiryMs,
      expired: expiryMs <= nowMs,
      status: row.status === "unbacked" ? "unbacked" : "active",
      lastLedgerSeq: toSafeInt(row.last_ledger_seq),
      createdAt: toSafeInt(row.created_at),
      rail: row.rail,
      tempoChannelId: row.tempo_channel_id ?? null,
      x402ChannelId: row.x402_channel_id,
    };
  }

  private async readTempoCreditLosses(
    q: CreditLedgerQuerier,
    args: { channelId?: string; limit?: number }
  ): Promise<TempoCreditLoss[]> {
    const { rows } = await q.query<TempoCreditLossRow>(
      `SELECT * FROM tempo_credit_losses
        WHERE ($1::text IS NULL OR channel_id = $1)
        ORDER BY observed_at DESC, credit_id
        LIMIT $2`,
      [args.channelId ?? null, args.limit ?? 1000]
    );
    return rows.map(tempoCreditLossFromRow);
  }

  private async readX402CreditLosses(
    q: CreditLedgerQuerier,
    args: { channelId?: string; limit?: number }
  ): Promise<X402CreditLoss[]> {
    const { rows } = await q.query<X402CreditLossRow>(
      `SELECT * FROM x402_credit_losses
        WHERE ($1::text IS NULL OR channel_id = $1)
        ORDER BY observed_at DESC, credit_id
        LIMIT $2`,
      [args.channelId ?? null, args.limit ?? 1000]
    );
    return rows.map(x402CreditLossFromRow);
  }
}

/**
 * Implemented by durable Postgres and per-process memory ledgers. Production funding menus
 * require durable storage; memory is for explicit development and tests. Mutations accepting
 * tx join the caller’s transaction; memory implementations ignore that handle.
 */
export interface CreditLedgerLike {
  /**
   * True when balances survive a restart and are visible fleet-wide
   * The funding menu is suppressed on a non-durable ledger
   * outside devMode: a caller who funds on machine A and draws on machine B
   * would get `credit_not_found`, so advertising credit there misadvertises.
   */
  readonly durable: boolean;
  /**
   * Bind the durable x402 settlement state spending is gated on.
   *
   * Optional because a host may wire a ledger implementation that has no such
   * gate; the SDK's own two both do. See
   * {@link CreditLedger.useX402SettlementGate}.
   */
  useX402SettlementGate?(gate: X402RefundSettlementGate): void;
  /**
   * Bind the outbox that reports credit-expiry releases and their revivals
   *
   * Optional, and absent on `MemoryCreditLedger`: an expiry release is a
   * durable liability fact, and a ledger whose balances do not survive a
   * restart has none to report. A host on a non-durable ledger simply never
   * sweeps. See {@link CreditLedger.useCreditExpiryReleaseOutbox}.
   */
  useCreditExpiryReleaseOutbox?(outbox: CreditExpiryReleaseOutbox): void;
  /**
   * Release the undrawn remainder of every credit past its TTL.
   * Optional on the same terms as the binder above. See
   * {@link CreditLedger.sweepExpiredCredits}.
   */
  sweepExpiredCredits?(args?: {
    nowMs?: number;
    limit?: number;
  }): Promise<{ released: CreditExpiryRelease[] }>;
  /**
   * Ask that gate directly, so a route can refuse a wedged channel **before**
   * the rail moves anything. Optional on the same terms as the
   * binder above; an implementation without it simply gets no preflight, and
   * the ledger effect stays the authority. See
   * {@link CreditLedger.blockingX402Refund}.
   */
  blockingX402Refund?(
    channelId: string | null | undefined,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined>;
  fund(args: {
    creditId?: string;
    callerPubkey: string;
    currency: string;
    amountMicro: number;
    expiryMs: number;
    basis: CreditFundingBasis;
    hostingAdmissionId?: string;
    hostingJobId?: string;
    hostingFundId?: string;
    hostingPaymentSeq?: number;
    hostingInvoicePaymentHash?: string;
    hostingInvoiceRepairPaymentHash?: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<CreditSnapshot>;
  draw(args: {
    creditId: string;
    drawId: string;
    amountMicro: number;
    jobId?: string;
    hostingAdmissionId?: string;
    hostingPaymentSeq?: number;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrawResult>;
  growDraw(args: {
    creditId: string;
    drawId: string;
    addAmountMicro: number;
    addRailValue?: { drawMsats: number; drawNative: number | null };
    capMicro?: number;
    jobId?: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<GrownDrawResult>;
  refundDraw(args: CreditDrawRefundArgs): Promise<CreditDrawRefundResult>;
  settle(args: {
    creditId: string;
    drawId: string;
    releaseOutbox?: CreditDrawReleaseOutbox;
    nowMs?: number;
  }): Promise<DrawResolution>;
  release(args: {
    creditId: string;
    drawId: string;
    releaseOutbox?: CreditDrawReleaseOutbox;
    nowMs?: number;
  }): Promise<DrawResolution>;
  recordFunding(args: {
    creditId: string;
    fundId: string;
    amountMicro: number;
    rail?: string;
    hostingAdmissionId?: string;
    hostingCallerPubkey?: string;
    hostingJobId?: string;
    hostingPaymentSeq?: number;
    hostingInvoicePaymentHash?: string;
    hostingInvoiceRepairPaymentHash?: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<FundingRecord>;
  getFunding(args: { creditId: string; fundId: string }): Promise<FundingRecord | undefined>;
  completeFunding(args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    balanceAfterMicro: number;
    ledgerSeq: number;
    tx?: CreditLedgerQuerier;
  }): Promise<FundingRecord>;
  saveFundingReceipt(args: {
    creditId: string;
    fundId: string;
    receipt: FundingReceipt;
  }): Promise<FundingReceipt>;
  recordInvoice(args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    currency: string;
    amountMicro: number;
    amountMsats: number;
    paymentHash: string;
    bolt11: string;
    expiresAt: number;
    nowMs?: number;
  }): Promise<CreditInvoiceRecord>;
  getInvoice(args: { creditId: string; fundId: string }): Promise<CreditInvoiceRecord | undefined>;
  listPendingInvoices(args: {
    callerPubkey: string;
    creditId?: string;
    limit: number;
  }): Promise<CreditInvoiceRecord[]>;
  settleInvoice(args: {
    creditId: string;
    fundId: string;
    expiryMs: number;
    basis: CreditFundingBasis;
    depositOutbox?: {
      enqueue: CreditDepositEnqueue;
      payload: CreditDepositPayload;
    };
    settledAtMs?: number;
    nowMs?: number;
  }): Promise<InvoiceSettlement>;
  markInvoiceExpired(args: {
    creditId: string;
    fundId: string;
  }): Promise<CreditInvoiceRecord | undefined>;
  markInvoiceBlocked(args: {
    creditId: string;
    fundId: string;
    reason: string;
  }): Promise<CreditInvoiceRecord | undefined>;
  getInvoiceByPaymentHash(paymentHash: string): Promise<CreditInvoiceRecord | undefined>;
  listBlockedInvoices(args: {
    limit: number;
    after?: BlockedInvoiceCursor;
    includeResolved?: boolean;
  }): Promise<CreditInvoiceRecord[]>;
  reconcileBlockedInvoice(args: {
    paymentHash: string;
    targetCreditId: string;
    expiryMs: number;
    basis: CreditFundingBasis;
    settledAtMs?: number;
    depositOutbox?: {
      enqueue: CreditDepositEnqueue;
      payload: CreditDepositPayload;
    };
    nowMs?: number;
  }): Promise<InvoiceReconciliation>;
  writeOffBlockedInvoice(args: {
    paymentHash: string;
    note?: string;
    nowMs?: number;
  }): Promise<InvoiceWriteOff | undefined>;
  get(creditId: string, opts?: { nowMs?: number }): Promise<CreditSnapshot | undefined>;
  getForCaller(callerPubkey: string, opts?: { nowMs?: number }): Promise<CreditSnapshot[]>;
  getDraw(args: { creditId: string; drawId: string }): Promise<DrawRecord | undefined>;
  getDrawByJobId(jobId: string): Promise<DrawRecord | undefined>;
  listDrawsByJobId(jobId: string): Promise<DrawRecord[]>;
  listPendingDraws(creditId: string): Promise<DrawRecord[]>;
  listStalePendingDraws(args: {
    createdBeforeMs: number;
    limit: number;
    after?: StalePendingDrawCursor;
  }): Promise<DrawRecord[]>;
  earnedNativeForX402Channel(channelId: string): Promise<number | undefined>;
  getCreditByX402Channel(channelId: string): Promise<CreditSnapshot | undefined>;
  terminalizeTempoCredits(
    evidence: TempoCreditLossEvidence,
    tx?: CreditLedgerQuerier
  ): Promise<TempoCreditLoss[]>;
  listTempoCreditLosses(args?: { limit?: number }): Promise<TempoCreditLoss[]>;
  terminalizeX402Credit(
    evidence: X402CreditLossEvidence,
    tx?: CreditLedgerQuerier
  ): Promise<X402CreditLoss[]>;
  listX402CreditLosses(args?: { limit?: number }): Promise<X402CreditLoss[]>;
  requestDrain(args: {
    creditId: string;
    drainId: string;
    callerPubkey: string;
    method: DrainMethod;
    payout: Record<string, string>;
    requireNoPending?: boolean;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainRequestResult>;
  getDrain(args: { creditId: string; drainId: string }): Promise<CreditDrainRecord | undefined>;
  listPendingDrains(): Promise<CreditDrainRecord[]>;
  /** See {@link CreditLedger.bitcoinDepositLiability} — the in-kind deposit floor. */
  bitcoinDepositLiability(): Promise<BitcoinDepositLiability>;
  listFundingLots(creditId: string): Promise<FundingLot[]>;
  listChannelDrains(args: {
    limit: number;
    after?: ChannelDrainCursor;
    createdBeforeMs: number;
    rail: "tempo";
    includeResolved?: boolean;
  }): Promise<CreditDrainRecord[]>;
  writeOffDrain(args: {
    creditId: string;
    drainId: string;
    note?: string;
    nowMs?: number;
  }): Promise<DrainWriteOff | undefined>;
  clearDrainWriteOff(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
  }): Promise<void>;
  requireTempoDrainExit?(args: {
    creditId: string; drainId: string; tx?: CreditLedgerQuerier;
  }): Promise<DrainTransitionResult>;
  releaseDrain(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainReleaseResult>;
  parkDrain(args: {
    creditId: string;
    drainId: string;
    token: string;
    fulfilment?: DrainFulfilment;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<CreditDrainRecord>;
  markDrainPickedUp(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult>;
  markDrainSent(args: {
    creditId: string;
    drainId: string;
    sentRef: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult>;
  appendDrainReceipt(args: {
    creditId: string;
    drainId: string;
    receipt: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
  }): Promise<void>;
}

/**
 * Subset of `pg.Pool` the ledger uses for plain queries. `Pool` and
 * `PoolClient` both satisfy this — which is what lets `fund` run on an
 * external transaction handle owned by the verifier (spec condition 3).
 */
export interface CreditLedgerQuerier {
  query: Pool["query"];
}

export interface CreditDrawReleaseOutbox {
  /** Platform DVM record ID bound into the report. */
  dvmId: string;
  /** Reporter-owned insert executed through the ledger transaction. */
  enqueue: CreditDrawReleaseEnqueue;
}

export interface CreditExpiryReleaseOutbox {
  /** Platform DVM record ID bound into the report. */
  dvmId: string;
  /** Reporter-owned insert executed through the ledger transaction. */
  enqueue: CreditExpiryReleaseEnqueue;
}

/**
 * One committed expiry episode. The sweep releases the undrawn remainder; later funding sets
 * reversedAt and restores that release on the same transaction. Multiple episodes may share
 * an expiry instant.
 */
export interface CreditExpiryRelease {
  creditId: string;
  /**
   * Key derived from expiry instant and the release sequence counted under the credit lock.
   */
  releaseId: string;
  callerPubkey: string;
  currency: string;
  /** Funding rail, or `null` on a credit funded before the basis was mandatory. */
  rail: string | null;
  /** Fiat micro released, 1e-6 of `currency`. */
  amountMicro: number;
  /**
   * Nominal credit expiry, ms since epoch; the claim is released only when the sweep commits.
   */
  expiryMs: number;
  /**
   * When the sweep recorded this release, ms since epoch.
   */
  releasedAt: number;
  /** When a funding revived the credit and undid this release. */
  reversedAt: number | null;
}

export type CreditLedgerPool = Pick<Pool, "query" | "connect">;

/**
 * unbacked credit is unavailable for spending or reclaim while channel collateral is gone. An
 * x402 credit with no remaining liability can be restored to active by channel
 * reconciliation.
 */
export type CreditStatus = "active" | "unbacked";

/** Draw lifecycle: two-phase hold → terminal settle/release. */
export type DrawStatus = "pending" | "settled" | "released";

/**
 * Drain payout rails. Direct Lightning send is excluded: deployments reclaiming Bitcoin can
 * use Cashu notes without putting a spending wallet credential in the DVM.
 */
export type DrainMethod = "cashu" | "x402" | "tempo";

export const DRAIN_METHODS = ["cashu", "x402", "tempo"] as const satisfies readonly DrainMethod[];

/**
 * True when `value` names a payout rail this build reclaims over.
 *
 * The wire carries `drain.method` as a bare string precisely so this guard —
 * not a schema enum — owns the narrowing, and a removed rail (`lightning`) or a
 * typo both get one typed refusal instead of an untyped schema error.
 */
export function isDrainMethod(value: string): value is DrainMethod {
  return (DRAIN_METHODS as readonly string[]).includes(value);
}

/**
 * Drain lifecycle. `pending` — liability recorded, not yet fulfilled.
 * Cashu: `pending → parked` (token attached by the builder batch job)
 * `→ picked_up` (caller collected it). x402:
 * `pending → sent` (builder batch job shipped the send-back). MPP either
 * reaches `sent` through cooperative close or `released` with its exact basis
 * restored when chain reconciliation proves that close cannot complete.
 * `exit_required` ends cooperative attempts without restoring the debit;
 * a late confirmed close can still fulfill it as `sent`.
 */
export type DrainStatus = "pending" | "parked" | "picked_up" | "sent" | "released" | "exit_required";

/**
 * The sats a DVM owes back on undrawn non-channel Bitcoin credit —
 * the deposit pot inside the hub's balance, which the operator's sweep may
 * never bank below.
 */
export interface BitcoinDepositLiability {
  /**
   * Total owed in kind, across every rail and denomination. Counts only
   * credits whose reclaim would actually settle in kind — the two gap
   * categories below are excluded, not partially folded in.
   */
  depositSats: number;
  /** Open Bitcoin credits, including the ones the gap counts describe. */
  credits: number;
  byRail: { rail: NonChannelBitcoinRail; sats: number; credits: number }[];
  /** Every open credit's balance in ledger currency, grouped — never summed across currencies. */
  byCurrency: { currency: string; micro: number; credits: number }[];
  /** Credits holding balance no funding lot backs — a defect, not a liability figure. */
  uncoveredCredits: number;
  /** Whole balances of short-covered credits, by ledger currency; reclaim uses a live rate. */
  uncoveredByCurrency: { currency: string; micro: number; credits: number }[];
  /** Credits holding any open micro with no sats basis, so their reclaim prices off a live rate. */
  unbackedCredits: number;
  /** Whole balances of basisless credits, by ledger currency. */
  unbackedByCurrency: { currency: string; micro: number; credits: number }[];
}

/**
 * What it cost to put a just-in-time-minted refund in the caller's hands
 * itemized on the drain row so the spend is auditable against the
 * hub's own transaction history long after the worker's log has rotated.
 *
 * `faceSats` is what the caller receives and equals the drain's published
 * `owed_sats`; everything else came out of the delivery reserve already
 * deducted from it. The reserve is flat, so `reserveSats − (mint + routing)`
 * is the dust the provider keeps, or — where it goes negative — the overage
 * the provider absorbed rather than re-pricing a promise it had made.
 */
export interface DrainFulfilment {
  source: "jit_mint";
  mintUrl: string;
  quoteId: string;
  /** Face value of the parked notes, in sats. */
  faceSats: number;
  /** Reserve withheld from the gross obligation when the drain was requested. */
  reserveSats: number;
  /** What the mint's quote asked for the face value. */
  invoiceMsats: number;
  /** Lightning routing the sending wallet reported, where it reported any. */
  routingFeeMsats: number | null;
}

/**
 * One drain liability, camel-cased, joined with its credit's `currency` and
 * `callerPubkey` so consumers (route, admin surface, batch job) never need a
 * second read to price or address it.
 */
export interface CreditDrainRecord {
  creditId: string;
  drainId: string;
  callerPubkey: string;
  currency: string;
  method: DrainMethod;
  /**
   * Reusable Tempo or x402 channel backing this drain, or null for one-payment/non-channel
   * credit. The channel’s cooperative lifecycle owns fulfillment; the operator’s manual sent
   * route refuses channel-bound drains.
   */
  channelId: string | null;
  /** Method-specific payout target as signed by the caller. */
  payout: Record<string, string>;
  /** Amount reclaimed, 1e-6 currency units — fixed at request time. */
  amountMicro: number;
  /**
   * The same reclaim expressed in the rail's own units, fixed at request time;
   * `null` on a rail that reports no native basis. This — not `amountMicro` —
   * is what an on-chain payout must be sized against, because the fiat figure
   * and the rail figure drift with the rate between funding and drain
   */
  drainedNative: number | null;
  /**
   * In-kind sats obligation fixed at request time: the decrease in FIFO lots’ remaining
   * floored obligations, net of one delivery reserve. A non-null obligation is not repriced.
   * Null on unpriceable non-channel Bitcoin refunds requires the live-rate Cashu fallback.
   * Channel and stablecoin refunds also use null: they have no sats obligation and follow
   * their native/channel payout lifecycle, using `drainedNative` where applicable.
   */
  owedSats: number | null;
  /**
   * Credit balance immediately after the drain debit (= the pending job
   * holds at request time), fixed when the drain was first recorded — the
   * figure every reclaim-event receipt attests. Replays return it unchanged.
   */
  balanceAfterMicro: number;
  /** Per-credit gap-free sequence shared with draws. */
  ledgerSeq: number;
  status: DrainStatus;
  /** Parked Cashu token, present from `parked` onwards. */
  token: string | null;
  /** Settlement evidence, present on `sent`. */
  sentRef: Record<string, unknown> | null;
  /**
   * How a parked refund was sourced and what delivering it cost.
   *
   * `null` on an accumulator park — there the consumed rows *are* the record —
   * and on every non-cashu rail. Set only where the notes were minted just in
   * time, because that is the path whose cost leaves no other trace: the sats
   * came out of the hub over Lightning rather than out of proofs this DVM was
   * already holding.
   */
  fulfilment: DrainFulfilment | null;
  /**
   * Opaque supplied reclaim-event observations in append order; consumers shape-check and
   * authenticate them.
   */
  receipts: Record<string, unknown>[];
  createdAt: number;
  parkedAt: number | null;
  pickedUpAt: number | null;
  sentAt: number | null;
  /** When an unfulfilled Tempo drain was restored to the credit balance. */
  releasedAt: number | null;
  /**
   * Why an operator closed this drain out without booking it, and
   * when. Set only on a channel drain the payout floor refused: the chain paid
   * the caller less than this ledger was extinguishing, the operator reviewed
   * the two figures and is not booking the difference.
   *
   * It is **not** a status. The drain stays `pending` and its balance stays
   * debited, because a write-off books nothing anywhere — which is also what
   * makes it reversible: `reconcile` still takes the row through the ordinary
   * `pending → sent` CAS and clears both columns in that same transaction.
   */
  writeOffNote: string | null;
  writtenOffAt: number | null;
}

/**
 * Keyset cursor for {@link CreditLedger.listChannelDrains} — the last row of
 * the page just served, verbatim. Taken from the row rather than rebuilt by a
 * caller, so the walk cannot re-serve its own cursor.
 */
export interface ChannelDrainCursor {
  createdAt: number;
  creditId: string;
  drainId: string;
}

/**
 * Result of {@link CreditLedger.writeOffDrain}.
 *
 * `written` is the transition bit, and it is load-bearing twice: the route
 * logs only on it (this note is the single record the decision gets, so an
 * unconditional emit would read as two decisions about one drain), and it
 * tells the operator whether their reason or someone else's is on file.
 */
export interface DrainWriteOff {
  drain: CreditDrainRecord;
  written: boolean;
}

export interface DrainReleaseResult {
  drain: CreditDrainRecord;
  credit: CreditSnapshot;
  replayed: boolean;
}

/**
 * Result of a terminal drain transition — {@link CreditLedger.markDrainPickedUp}
 * and {@link CreditLedger.markDrainSent}.
 *
 * The record alone can't answer "did I move this money", because the CAS
 * winner and an idempotent replay return the same row. Anything that must
 * happen exactly once per reclaim — the platform drain report — keys off
 * `replayed`.
 */
export interface DrainTransitionResult {
  drain: CreditDrainRecord;
  /** True when the drain was already terminal and this call changed nothing. */
  replayed: boolean;
}

export interface DrainRequestResult {
  drain: CreditDrainRecord;
  /** The credit as of this call — balance already debited on a fresh drain. */
  credit: CreditSnapshot;
  /** True when this call was an idempotent replay (the poll/pickup read). */
  replayed: boolean;
}

/**
 * Read model with funded balance and pending holds. Expiry is computed at read time and does
 * not erase the record; unbacked credit has no available balance.
 */
export interface CreditSnapshot {
  creditId: string;
  callerPubkey: string;
  currency: string;
  /** Funded balance, 1e-6 currency units. Pending holds are NOT subtracted. */
  balanceMicro: number;
  /**
   * Balance minus pending holds, or zero while backing is unbacked.
   */
  availableMicro: number;
  /**
   * `availableMicro` in the funding rail's own units — the ceiling any
   * rail-denominated payout must respect. `null` marks a rail that reports no
   * native basis, which is why a channel drain refuses rather than guessing
   */
  nativeAvailable: number | null;
  expiryMs: number;
  expired: boolean;
  status: CreditStatus;
  /**
   * High-water sequence shared by draw placements, drains, and completed-draw refunds.
   */
  lastLedgerSeq: number;
  createdAt: number;
  /**
   * The rail this balance was funded on; `null` on a credit opened
   * before rail basis was recorded, which conflicts with nothing. Exposed so a
   * route can refuse a cross-rail top-up **before** taking the payment `fund`
   * would then refuse `rail_mismatch`.
   */
  rail: string | null;
  /** TIP-1034 channel that exclusively backs this credit, when session-funded. */
  tempoChannelId: string | null;
  /** Reusable x402 channel bound to this credit, if one funded it. */
  x402ChannelId: string | null;
}

export interface DrawResult {
  creditId: string;
  drawId: string;
  amountMicro: number;
  /**
   * Recorded balance after placement or latest growth, at the draw’s original sequence.
   */
  balanceAfterMicro: number;
  /**
   * Per-credit gap-free sequence shared with drains and refunds; growth keeps the original value.
   */
  ledgerSeq: number;
  status: DrawStatus;
  /** True when this call was an idempotent replay of an already-recorded state. */
  replayed: boolean;
  /** Rail value allocated to this draw, plus the credit's rail identity. */
  railValue: DrawRailValue;
  /** When the draw reached its terminal state; `null` while pending. */
  resolvedAt: number | null;
}

/**
 * A draw’s rail value and funding identity. Placement records a pooled forecast; settling
 * non-channel Bitcoin can replace it with FIFO lot pricing while retaining the original as
 * allocatedMsats. Native null means no native amount was reported, distinct from zero.
 */
export interface DrawRailValue {
  /** Millisatoshis of rail value allocated to this draw. */
  drawMsats: number;
  /** Rail-native atomic units allocated, or `null` when the rail reports none (cashu). */
  drawNative: number | null;
  /**
   * Rail that funded the credit — a {@link FundingMethod} on any row `fund`
   * wrote, `null` on one it opened before recorded the column. Stays
   * `string` rather than the union: this is a database read, and a fleet
   * mid-rollout can hold a rail a newer build wrote ({@link isFundingRail}).
   */
  rail: string | null;
  /** Native asset tag paired with `drawNative` (`usdc`, `sats`, …). */
  nativeAsset: string | null;
  /** Cashu mint the funding proofs were issued from. */
  mint: string | null;
  /** The funding's rail settlement reference (tx hash / challenge id / request id). */
  fundingRef: string | null;
  /** The credit's denomination — the currency `amountMicro` is 1e-6 of. */
  creditCurrency: string | null;
}

/**
 * Result of `growDraw` — the draw's post-growth tuple, plus the
 * slice this top-up added. The added slice is what the mid-job rail result
 * reports as its `paidMsats` delta: the job's counters accumulate increments,
 * not the running total the draw now holds.
 */
export interface GrownDrawResult extends DrawResult {
  /** Rail value this growth allocated, on top of what the draw already held. */
  addedRailValue: { drawMsats: number; drawNative: number | null };
  /** Fiat micro this growth added — `amountMicro` minus the pre-growth amount. */
  addedAmountMicro: number;
  /**
   * Fiat micro the cap refused, because growing by it would have
   * pushed the draw past what the job cumulatively asked. Zero on every
   * ordinary top-up. Non-zero means money landed on the credit that this job
   * did not buy anything with — it stays the caller's available balance, and
   * the caller has to be told (`UnappliedCredit` on the 201).
   */
  cappedMicro: number;
}

/** Result of `settle` / `release` — the draw's recorded tuple plus a fresh available-balance read. */
export interface DrawResolution extends DrawResult {
  /** Available balance after this resolution, read under the same lock. */
  availableMicro: number;
  /** Settlement instant — the timestamp a draw-keyed revenue event is dated by. */
  resolvedAt: number;
}

export interface DrawRecord extends Omit<DrawResult, "replayed"> {
  jobId: string | null;
  createdAt: number;
  /**
   * What `allocateDrawValue` allocated this draw when the payment landed
   * the pro-rata slice of the credit's pooled rail value that
   * `withDrawBasis` mirrored onto the job's `paidMsats` counter.
   *
   * Equal to `railValue.drawMsats` on every draw the settle did not re-price,
   * which is every draw off a rail carrying no funding lots. Where it differs,
   * `railValue.drawMsats` is the authority on what the draw was worth and this
   * is the superseded forecast, kept because the job's counter was built from
   * it: correcting that counter is `paidMsats − allocatedMsats + drawMsats`,
   * which leaves any leg the draw never absorbed alone.
   */
  allocatedMsats: number;
}

/**
 * Keyset cursor into {@link CreditLedgerLike.listStalePendingDraws}, holding the
 * sort key of the last row a caller examined; offset paging would not
 * do: the scan skips holds it can't resolve (their job row exists), so those
 * rows stay `pending` and reappear at the head of every subsequent page. The
 * tuple is `(createdAt, creditId, ledgerSeq)`, matching the read's `ORDER BY`;
 * `(creditId, ledgerSeq)` is unique, so the key is total and never re-serves
 * or skips a row.
 */
export interface StalePendingDrawCursor {
  createdAt: number;
  creditId: string;
  ledgerSeq: number;
}

/**
 * Runtime set checked against FundingMethod at compile time, so adding a supported rail
 * requires naming it here. Own-property lookup rejects inherited keys such as toString on
 * untrusted stored values.
 */
export const FUNDING_RAILS: Record<FundingMethod, true> = {
  cashu: true,
  x402: true,
  tempo: true,
  lightning: true,
};

/**
 * Whether a stored `credits.rail` is a rail this build knows how to book
 * revenue under. `null` from a legacy credit with no recorded rail is not.
 *
 * Uses `Object.hasOwn`, not `in`: `"toString" in FUNDING_RAILS` is true.
 */
export function isFundingRail(rail: string | null | undefined): rail is FundingMethod {
  return typeof rail === "string" && Object.hasOwn(FUNDING_RAILS, rail);
}

/**
 * Validate the required write basis before taking a connection or lock. Missing/unknown rail
 * and invalid instrument amounts are typed invalid_basis refusals even for JavaScript
 * callers. Nullable stored rails remain readable for legacy data.
 */
export function assertFundingBasis(basis: CreditFundingBasis | undefined): CreditFundingBasis {
  if (!basis) {
    throw new CreditLedgerError("invalid_basis", "basis is required");
  }
  if (!isFundingRail(basis.rail)) {
    throw new CreditLedgerError(
      "invalid_basis",
      `basis.rail must be one of ${Object.keys(FUNDING_RAILS).join(", ")} (got ${String(basis.rail)})`
    );
  }
  if (!Number.isSafeInteger(basis.paidMsats) || basis.paidMsats < 0) {
    throw new CreditLedgerError(
      "invalid_basis",
      `basis.paidMsats must be a non-negative safe integer (got ${String(basis.paidMsats)})`
    );
  }
  return basis;
}

/**
 * Rail value one funding contributes to a credit. Recorded so a
 * later draw can be allocated its share of what the rail actually paid, and so
 * the platform can book the funding as a deposit.
 */
export interface CreditFundingBasis {
  /**
   * The rail whose value this funding carries. A top-up on another rail is
   * refused (`rail_mismatch`).
   *
   * Narrowed from `string` to {@link FundingMethod} by — the same type
   * {@link FUNDING_RAILS} is keyed by — so a rail cannot enter `credits.rail`
   * that the terminal has no way to book revenue under. That silently costs
   * every draw the credit backs its booking, which is what happened when
   * `lightning` reached the ledger before the reader's allow-list.
   */
  rail: FundingMethod;
  /** Rail payment value in millisatoshis. */
  paidMsats: number;
  /** Rail-native atomic units; omitted for cashu, where msats is the basis. */
  nativeAmount?: number;
  /** Asset tag paired with `nativeAmount`. */
  nativeAsset?: string;
  /** Cashu mint URL, for the deposit's `chain_id`. */
  mint?: string;
  /** Rail settlement reference: EVM tx hash / Tempo challenge id / cashu request id. */
  fundingRef?: string;
  /** TIP-1034 natural identity when this Tempo funding came from a session voucher. */
  tempoSession?: {
    channelId: string;
    cumulativeAmount: string;
  };
  /** Batch-settlement identity; binds one reusable channel to one credit. */
  x402Channel?: { channelId: string; maxClaimableAmount: string };
}

export interface CreditFundArgs {
  /**
   * Omit to mint a credit ID; provide to add funding to that credit. Replay prevention is the
   * caller’s responsibility.
   */
  creditId?: string;
  callerPubkey: string;
  /** The DVM's pricing currency; `amountMicro` is 1e-6 of it. */
  currency: string;
  amountMicro: number;
  /** Absolute expiry, ms since epoch. Overwrites the previous value on top-up. */
  expiryMs: number;
  /**
   * Rail value contributed by this funding; required on writes.
   */
  basis: CreditFundingBasis;
  /** Server-verified original hosted admission, never accepted from the caller body. */
  hostingAdmissionId?: string;
  hostingJobId?: string;
  hostingFundId?: string;
  hostingPaymentSeq?: number;
  hostingInvoicePaymentHash?: string;
  hostingInvoiceRepairPaymentHash?: string;
  /**
   * External transaction handle; caller owns BEGIN, COMMIT and ROLLBACK.
   */
  tx?: CreditLedgerQuerier;
  nowMs?: number;
}

/**
 * Allocate a draw's share of a credit's unspent rail value. Pure —
 * shared by the Postgres and in-memory ledgers so the two can't drift.
 *
 * `availableMicro` and both remainders must be net of pending holds; the
 * caller has already refused `amountMicro > availableMicro`.
 */
export function allocateDrawValue(args: {
  amountMicro: number;
  availableMicro: number;
  availableMsats: number;
  availableNative: number | null;
}): { drawMsats: number; drawNative: number | null } {
  const share = (remaining: number): number => {
    if (args.availableMicro <= 0 || args.amountMicro <= 0 || remaining <= 0) return 0;
    return Math.min(remaining, Math.round((remaining * args.amountMicro) / args.availableMicro));
  };
  return {
    drawMsats: share(args.availableMsats),
    drawNative: args.availableNative === null ? null : share(args.availableNative),
  };
}

/**
 * An earmark assigns the growth’s incoming funding rather than a share of a blended pool,
 * avoiding a short paid_msats delta after a rate change. Clamp it to available rail value.
 * Without an earmark, allocate a pooled share; preserve native null rather than inventing a
 * unit.
 */
export function growthRailValue(args: {
  earmark?: { drawMsats: number; drawNative: number | null };
  amountMicro: number;
  availableMicro: number;
  availableMsats: number;
  availableNative: number | null;
}): { drawMsats: number; drawNative: number | null } {
  const { earmark } = args;
  if (!earmark) return allocateDrawValue(args);
  return {
    drawMsats: Math.min(Math.max(0, earmark.drawMsats), args.availableMsats),
    drawNative:
      args.availableNative === null
        ? null
        : Math.min(Math.max(0, earmark.drawNative ?? 0), args.availableNative),
  };
}

/**
 * Scale an earmark to the growth actually granted by the cap. Round up so a fully paid ask is
 * not one millisatoshi short of its resume threshold. Clamp to the original earmark; unclipped
 * growth returns it unchanged. The growth allocator separately bounds it to available rail
 * value.
 */
export function clipEarmark(
  earmark: { drawMsats: number; drawNative: number | null } | undefined,
  grantMicro: number,
  addAmountMicro: number
): { drawMsats: number; drawNative: number | null } | undefined {
  if (!earmark || grantMicro >= addAmountMicro || addAmountMicro <= 0) return earmark;
  const scale = (value: number): number =>
    Math.min(value, Math.ceil((value * grantMicro) / addAmountMicro));
  return {
    drawMsats: scale(earmark.drawMsats),
    drawNative: earmark.drawNative === null ? null : scale(earmark.drawNative),
  };
}

export interface FundingRecord {
  creditId: string;
  fundId: string;
  amountMicro: number;
  /** Rail the money arrived on, when the funder recorded one. */
  rail: string | null;
  createdAt: number;
  /** Original funding-time tuple, fixed atomically with the ledger credit. */
  callerPubkey: string | null;
  balanceAfterMicro: number | null;
  ledgerSeq: number | null;
  /** First signed artifact; write-once so retries are byte-stable. */
  receipt: FundingReceipt | null;
}

/**
 * Lifecycle of a Lightning funding invoice.
 *
 * Only `pending` is live; everything else is terminal. The two that carry no
 * balance carry opposite money: `expired` was never paid and owes nobody
 * anything, while `blocked` **was** paid and cannot be credited, so it needs an
 * operator. Both exist so that a row the sweep can never advance stops being
 * swept.
 *
 * `reconciled` and `written_off` are where a `blocked` row goes once
 * that operator acts — respectively, the money was credited onto a credit they
 * named, or they decided it would not be. Neither is `settled`: that one means
 * the ledger applied the payment to the top-up the caller asked for, and
 * collapsing the operator-resolved cases into it would erase the fact that a
 * human had to intervene.
 */
export type CreditInvoiceStatus =
  | "pending"
  | "settled"
  | "expired"
  | "blocked"
  | "reconciled"
  | "written_off";

export interface CreditInvoiceRecord {
  creditId: string;
  fundId: string;
  callerPubkey: string;
  currency: string;
  /** Top-up amount in 1e-6 units of `currency` — pinned when the invoice was issued. */
  amountMicro: number;
  /** The bolt11's amount in millisatoshis, pinned at the same instant. */
  amountMsats: number;
  paymentHash: string;
  bolt11: string;
  status: CreditInvoiceStatus;
  /**
   * Why a `blocked` invoice can never be credited — the operator's starting
   * point. **Preserved through a reconcile or a write-off**: it is the audit
   * trail for why a human had to touch this row at all.
   */
  blockedReason: string | null;
  /** Credit an operator sent a blocked invoice's money to. */
  reconciledCreditId: string | null;
  /** Funding key on that credit — the payment hash. See `reconcileBlockedInvoice`. */
  reconciledFundId: string | null;
  /** When an operator resolved this row, ms since epoch. Distinct from `settledAt`. */
  resolvedAt: number | null;
  /** The operator's note on a `written_off` row — why they chose not to credit. */
  writeOffNote: string | null;
  /** Absolute bolt11 expiry, ms since epoch. */
  expiresAt: number;
  createdAt: number;
  /** When the payment landed at the wallet — never the instant an operator acted on it. */
  settledAt: number | null;
}

export interface InvoiceSettlement {
  invoice: CreditInvoiceRecord;
  /** The `credit_fundings` row; absent only if a legacy row somehow lacks one. */
  funding: FundingRecord | undefined;
  credit: CreditSnapshot | undefined;
  /** True when this settlement had already been applied — nothing moved. */
  replayed: boolean;
}

/**
 * Reconciliation keeps the original invoice identity; funding and credit describe the
 * operator-selected target credit, which may differ from the invoice’s original credit.
 */
export interface InvoiceReconciliation {
  invoice: CreditInvoiceRecord;
  funding: FundingRecord | undefined;
  credit: CreditSnapshot | undefined;
  /** True when this reconcile had already been applied — nothing moved. */
  replayed: boolean;
}

export interface InvoiceWriteOff {
  invoice: CreditInvoiceRecord;
  /** False when the invoice was already written off, so nothing changed. */
  written: boolean;
}

/** Keyset position in `listBlockedInvoices`'s `(created_at, credit_id, fund_id)` ordering. */
export interface BlockedInvoiceCursor {
  createdAt: number;
  creditId: string;
  fundId: string;
}

export type CreditLedgerErrorCode =
  | "credit_not_found"
  | "credit_expired"
  | "credit_unbacked"
  | "tempo_channel_closing"
  | "tempo_settlement_pending"
  | "settlement_pending"
  | "insufficient_credit"
  | "draw_conflict"
  | "invalid_refund"
  | "draw_not_completed"
  | "refund_conflict"
  | "refund_exceeds_draw"
  | "credit_not_open"
  | "credit_refund_channel_unsupported"
  | "credit_refund_basis_unavailable"
  | "credit_refund_state_unavailable"
  | "draw_not_found"
  | "invalid_draw_state"
  | "funding_replayed"
  | "currency_mismatch"
  | "caller_mismatch"
  | "rail_mismatch"
  | "invalid_amount"
  | "invalid_expiry"
  | "invalid_basis"
  | "nothing_to_drain"
  | "drain_below_dust"
  | "drain_not_found"
  | "drain_conflict"
  | "invalid_drain_state"
  | "invoice_not_found"
  | "invoice_conflict"
  | "invoice_not_blocked"
  | "below_rail_minimum";

/**
 * Structured drain_conflict reasons select caller instructions without matching prose. A
 * refund_floor shortfall needs operator resolution, unlike duplicate payout; foreign_credit
 * discloses no liability to the wrong owner; drain_id_retired requires a fresh ID.
 */
export type DrainConflictReason = "pending_draws" | "balance_moved" | "refund_floor";

export interface CreditLedgerErrorDetails {
  /** On `drain_conflict`: which conflict it is, so a route can answer it without matching on prose. */
  drainConflict?: DrainConflictReason;
  /** On `insufficient_credit`: the spendable balance the draw exceeded. */
  availableMicro?: number;
  /** On `insufficient_credit`: the draw amount that was refused, so the wire can state the shortfall. */
  requestedMicro?: number;
  /** On `insufficient_credit` / `credit_expired`: the funded balance. */
  balanceMicro?: number;
  /** On `credit_expired`: when the credit expired. */
  expiryMs?: number;
  /** On `invalid_draw_state`: the draw's actual status. */
  currentStatus?: DrawStatus;
  /** On `draw_conflict`: the amount the draw was originally recorded with. */
  expectedAmountMicro?: number;
  /** On `draw_conflict`: the job the draw was originally recorded for. */
  expectedJobId?: string | null;
  /** On `rail_mismatch`: the rail the credit was originally funded on. */
  expectedRail?: string | null;
  /** On `rail_mismatch`: the rail-specific funding instrument already bound to the credit. */
  expectedInstrument?: "tempo_charge" | "tempo_session" | "x402_exact" | "x402_channel";
  /** On `rail_mismatch`: the reusable channel already bound to the credit, when there is one. */
  expectedChannelId?: string | null;
  /** On a channel-wide `rail_mismatch`: the other credit that already owns the channel. */
  boundCreditId?: string;
  /** On `settlement_pending`: the unresolved x402 refund holding this credit. */
  settlementId?: string;
  /** On `settlement_pending`: that settlement's status, so an operator sees which repair applies. */
  settlementStatus?: string;
  /** On `settlement_pending`: the drain id that settlement is under — the one id this gate admits. */
  blockingDrainId?: string;
}

/**
 * Thrown by every {@link CreditLedger} method on refusal. Carries a `code`
 * discriminator (plus structured `details`) so callers branch on a field
 * instead of string-matching messages — the quote surface maps
 * `insufficient_credit` + `details.availableMicro` onto the structured
 * 402-class wire error.
 */
export class CreditLedgerError extends Error {
  readonly code: CreditLedgerErrorCode;
  readonly details: CreditLedgerErrorDetails;

  constructor(
    code: CreditLedgerErrorCode,
    message: string,
    details: CreditLedgerErrorDetails = {},
    opts?: ErrorOptions
  ) {
    super(message, opts);
    this.name = "CreditLedgerError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Build the shared settlement_pending refusal. Extract a blocking drain ID only from an
 * effect prefixed by this exact opaque credit ID, which may contain colons. written_off
 * withholds that old ID: spending remains blocked, but reclaim requires a fresh drain.
 */
export function x402SettlementPending(
  creditId: string,
  refund: X402UnresolvedRefund
): CreditLedgerError {
  const drainId =
    X402_WEDGED_SETTLEMENT_STATUSES.includes(refund.status) &&
    refund.effectId.startsWith(`${creditId}:`)
      ? refund.effectId.slice(creditId.length + 1)
      : "";
  return new CreditLedgerError(
    "settlement_pending",
    `credit ${creditId} is bound to an x402 channel whose refund ${refund.settlementId} is ${refund.status}`,
    {
      settlementId: refund.settlementId,
      settlementStatus: refund.status,
      ...(drainId ? { blockingDrainId: drainId } : {}),
    }
  );
}

function terminalCreditError(creditId: string, status: string): CreditLedgerError {
  return new CreditLedgerError(
    "credit_unbacked",
    `credit ${creditId} is terminal (${status}); its Tempo backing finalized before the DVM was protected`
  );
}

/** Postgres `unique_violation` (SQLSTATE 23505), however the driver wrapped it. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";
}

interface CreditBasisRow {
  rail: string | null;
  native_asset: string | null;
  mint: string | null;
  funding_ref: string | null;
  tempo_channel_id?: string | null;
  currency: string | null;
}

/** Raw `credits` row. BIGINTs arrive as strings from pg. */
interface CreditRow extends CreditBasisRow {
  credit_id: string;
  caller_pubkey: string;
  currency: string;
  balance_micro: string;
  expiry_ms: string;
  status: string;
  last_ledger_seq: string;
  last_funding_ledger_seq: string | null;
  created_at: string;
  msats_remaining: string;
  native_remaining: string | null;
  x402_channel_id: string | null;
}

interface CreditExpiryReleaseRow {
  credit_id: string;
  release_id: string;
  caller_pubkey: string;
  currency: string;
  rail: string | null;
  amount_micro: string;
  expiry_ms: string;
  released_at: string;
  reversed_at: string | null;
}

interface TempoCreditLossRow {
  credit_id: string;
  channel_id: string;
  caller_pubkey: string;
  currency: string;
  former_balance_micro: string;
  settled_on_chain_native: string;
  highest_voucher_native: string;
  consumed_service_micro: string;
  consumed_native: string;
  observed_at: string;
}

interface X402CreditLossRow {
  credit_id: string;
  channel_id: string;
  caller_pubkey: string;
  currency: string;
  former_balance_micro: string;
  channel_balance_native: string;
  total_claimed_native: string;
  consumed_service_micro: string;
  observed_at: string;
}

interface DrawRow {
  credit_id: string;
  draw_id: string;
  amount_micro: string;
  job_id: string | null;
  ledger_seq: string;
  status: DrawStatus;
  balance_after_micro: string;
  created_at: string;
  resolved_at: string | null;
  draw_msats: string;
  draw_native: string | null;
  grown_micro: string;
  allocated_msats: string | null;
  settled_sats: string | null;
  refund_dvm_id: string | null;
}

interface FundingRow {
  credit_id: string;
  fund_id: string;
  amount_micro: string;
  rail: string | null;
  created_at: string;
  caller_pubkey: string | null;
  balance_after_micro: string | null;
  ledger_seq: string | null;
  receipt: FundingReceipt | null;
}

interface BitcoinLiabilityRow {
  rail: NonChannelBitcoinRail;
  currency: string;
  credits: string;
  owed_sats: string;
  balance_micro: string;
  uncovered_credits: string;
  uncovered_micro: string;
  unbacked_credits: string;
  unbacked_micro: string;
}

interface FundingLotRow {
  lot_id: string;
  credit_id: string;
  rail: NonChannelBitcoinRail;
  sats_funded: string;
  sats_basis_known: boolean;
  credited_micro: string;
  remaining_micro: string;
  funding_ref: string | null;
  created_at: string;
}

interface InvoiceRow {
  credit_id: string;
  fund_id: string;
  caller_pubkey: string;
  currency: string;
  amount_micro: string;
  amount_msats: string;
  payment_hash: string;
  bolt11: string;
  status: CreditInvoiceStatus;
  blocked_reason: string | null;
  reconciled_credit_id: string | null;
  reconciled_fund_id: string | null;
  resolved_at: string | null;
  write_off_note: string | null;
  expires_at: string;
  created_at: string;
  settled_at: string | null;
}

const DRAW_WITH_BASIS_SELECT = `
  SELECT d.*, c.rail, c.native_asset, c.mint, c.funding_ref, c.currency
  FROM credit_draws d
  LEFT JOIN credits c ON c.credit_id = d.credit_id`;

/** Raw `credit_drains` row. JSONB columns arrive pre-parsed from pg. */
interface DrainRow {
  credit_id: string;
  drain_id: string;
  method: DrainMethod;
  payout: Record<string, string>;
  amount_micro: string;
  balance_after_micro: string;
  drained_msats: string;
  drained_native: string | null;
  owed_sats: string | null;
  lot_debits: LotDebit[] | null;
  fulfilment: DrainFulfilment | null;
  ledger_seq: string;
  status: DrainStatus;
  token: string | null;
  sent_ref: Record<string, unknown> | null;
  receipts: Record<string, unknown>[];
  created_at: string;
  parked_at: string | null;
  picked_up_at: string | null;
  sent_at: string | null;
  released_at: string | null;
  write_off_note: string | null;
  written_off_at: string | null;
}

/**
 * The credit columns every drain record is projected against — identity, and
 * the channel binding that says whether the reclaim settles itself.
 */
type DrainCreditJoin = Pick<
  CreditRow,
  "currency" | "caller_pubkey" | "tempo_channel_id" | "x402_channel_id"
>;

interface DrainJoinRow extends DrainRow, DrainCreditJoin {}

const DRAIN_CREDIT_COLUMNS = "c.currency, c.caller_pubkey, c.tempo_channel_id, c.x402_channel_id";

/**
 * The credits a funding lot exists for: non-channel Bitcoin, still
 * holding value. A channel-backed credit is in-kind structurally — the escrow
 * retains the unused value — so it has no lots and must never be counted as
 * deposit liability here. Written against the alias `c`.
 */
const BITCOIN_CREDIT_PREDICATE = `c.rail IN ('cashu', 'lightning')
          AND c.tempo_channel_id IS NULL
          AND c.x402_channel_id IS NULL
          AND c.balance_micro > 0`;

/**
 * One credit's open-lot rollup, correlated on `c.credit_id`.
 *
 * `owed_sats` floors **per lot** rather than over the sum, which is the
 * arithmetic the reclaim itself performs: each lot converts at its own funding
 * rate and its sub-satoshi tail stays with the provider. Integer division on
 * BIGINT does that floor; `NULLIF` guards a lot that somehow bought nothing,
 * and `SUM` drops the resulting NULL rather than poisoning the total.
 *
 * `basisless_micro` is open micro sitting in lots that record no sats basis.
 * It exists because {@link isInKindDepletion} is all-or-nothing: one such lot
 * sends the *whole* reclaim to a live rate, so a credit holding any of it owes
 * nothing in kind however much of its balance the other lots back. Summing
 * `sats_funded` cannot see that — a mixture sums non-zero and would read as
 * fully backed.
 */
const LOT_COVERAGE_LATERAL = `SELECT
            COALESCE(SUM(l.remaining_micro), 0) AS covered_micro,
            COALESCE(SUM(l.remaining_micro) FILTER (WHERE l.sats_funded = 0 AND NOT l.sats_basis_known), 0) AS basisless_micro,
            COALESCE(SUM(FLOOR(l.sats_funded::numeric * l.remaining_micro / NULLIF(l.credited_micro, 0))), 0) AS owed_sats
          FROM credit_funding_lots l
         WHERE l.credit_id = c.credit_id AND l.remaining_micro > 0`;

/**
 * Whether a credit's reclaim would settle in kind, written against the
 * `LOT_COVERAGE_LATERAL` alias `cov`. The SQL twin of
 * {@link isInKindDepletion}, and it has to stay one: a credit counted into
 * `deposit_liability_sats` that the reclaim then prices off a live rate is a
 * sweep floor that does not match the money.
 */
const IN_KIND_PREDICATE = `cov.covered_micro >= c.balance_micro AND cov.basisless_micro = 0`;

/**
 * Parse a pg BIGINT string into a JS number, refusing anything outside the
 * safe-integer range. Throws (plain invariant error, not a typed refusal) —
 * silent truncation past 2^53 would corrupt balance arithmetic. 2^53 micro
 * ≈ 9e9 currency units, far beyond any credit this ledger will hold.
 */
function toSafeInt(value: string | number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`credit ledger: BIGINT value ${value} outside safe integer range`);
  }
  return n;
}

/**
 * Gate a caller-supplied amount: a negative draw would *increase* available
 * balance, and a non-integer corrupts BIGINT arithmetic. `min: 0` admits
 * zero-amount draws (a free job under a credit still gets a seq'd receipt
 * entry); `fund` requires `min: 1`.
 */
function assertAmount(amountMicro: number, opts: { min: number }): void {
  if (!Number.isSafeInteger(amountMicro) || amountMicro < opts.min) {
    throw new CreditLedgerError(
      "invalid_amount",
      `amountMicro must be a safe integer ≥ ${opts.min} (got ${amountMicro})`
    );
  }
}

function creditBasisFromRow(row: CreditBasisRow): Omit<DrawRailValue, "drawMsats" | "drawNative"> {
  return {
    rail: row.rail,
    nativeAsset: row.native_asset,
    mint: row.mint,
    fundingRef: row.funding_ref,
    creditCurrency: row.currency,
  };
}

function railValueFromRow(row: DrawRow, basis: CreditBasisRow): DrawRailValue {
  return {
    drawMsats: toSafeInt(row.draw_msats),
    drawNative: row.draw_native === null ? null : toSafeInt(row.draw_native),
    ...creditBasisFromRow(basis),
  };
}

function drawResultFromRow(
  row: DrawRow,
  basis: CreditBasisRow
): Omit<DrawResult, "replayed"> & { replayed: false } {
  return {
    creditId: row.credit_id,
    drawId: row.draw_id,
    amountMicro: toSafeInt(row.amount_micro),
    balanceAfterMicro: toSafeInt(row.balance_after_micro),
    ledgerSeq: toSafeInt(row.ledger_seq),
    status: row.status,
    replayed: false,
    railValue: railValueFromRow(row, basis),
    resolvedAt: row.resolved_at === null ? null : toSafeInt(row.resolved_at),
  };
}

function drawRecordFromRow(row: DrawRow, basis: CreditBasisRow): DrawRecord {
  const { replayed: _replayed, ...rest } = drawResultFromRow(row, basis);
  return {
    ...rest,
    jobId: row.job_id,
    createdAt: toSafeInt(row.created_at),
    allocatedMsats:
      row.allocated_msats === null ? rest.railValue.drawMsats : toSafeInt(row.allocated_msats),
  };
}

function tempoCreditLossFromRow(row: TempoCreditLossRow): TempoCreditLoss {
  return {
    creditId: row.credit_id,
    channelId: row.channel_id,
    callerPubkey: row.caller_pubkey,
    currency: row.currency,
    formerBalanceMicro: toSafeInt(row.former_balance_micro),
    settledOnChainNative: BigInt(row.settled_on_chain_native),
    highestVoucherNative: BigInt(row.highest_voucher_native),
    consumedServiceMicro: toSafeInt(row.consumed_service_micro),
    consumedNative: BigInt(row.consumed_native),
    observedAt: toSafeInt(row.observed_at),
  };
}

function x402CreditLossFromRow(row: X402CreditLossRow): X402CreditLoss {
  return {
    creditId: row.credit_id,
    channelId: row.channel_id,
    callerPubkey: row.caller_pubkey,
    currency: row.currency,
    formerBalanceMicro: toSafeInt(row.former_balance_micro),
    channelBalanceNative: BigInt(row.channel_balance_native),
    totalClaimedNative: BigInt(row.total_claimed_native),
    consumedServiceMicro: toSafeInt(row.consumed_service_micro),
    observedAt: toSafeInt(row.observed_at),
  };
}

function drainRecordFromRow(row: DrainRow, credit: DrainCreditJoin): CreditDrainRecord {
  return {
    creditId: row.credit_id,
    drainId: row.drain_id,
    callerPubkey: credit.caller_pubkey,
    currency: credit.currency,
    method: row.method,
    // One column or the other, never both: a credit binds to at most one
    // channel, and the two rails' ids never coexist on a row.
    channelId: credit.tempo_channel_id ?? credit.x402_channel_id,
    payout: row.payout,
    amountMicro: toSafeInt(row.amount_micro),
    drainedNative: row.drained_native === null ? null : toSafeInt(row.drained_native),
    owedSats: row.owed_sats === null ? null : toSafeInt(row.owed_sats),
    balanceAfterMicro: toSafeInt(row.balance_after_micro),
    ledgerSeq: toSafeInt(row.ledger_seq),
    status: row.status,
    token: row.token,
    sentRef: row.sent_ref,
    fulfilment: row.fulfilment,
    receipts: row.receipts,
    createdAt: toSafeInt(row.created_at),
    parkedAt: row.parked_at === null ? null : toSafeInt(row.parked_at),
    pickedUpAt: row.picked_up_at === null ? null : toSafeInt(row.picked_up_at),
    sentAt: row.sent_at === null ? null : toSafeInt(row.sent_at),
    releasedAt: row.released_at === null ? null : toSafeInt(row.released_at),
    writeOffNote: row.write_off_note,
    writtenOffAt: row.written_off_at === null ? null : toSafeInt(row.written_off_at),
  };
}

function drainRecordFromJoinRow(row: DrainJoinRow): CreditDrainRecord {
  return drainRecordFromRow(row, {
    currency: row.currency,
    caller_pubkey: row.caller_pubkey,
    tempo_channel_id: row.tempo_channel_id,
    x402_channel_id: row.x402_channel_id,
  });
}

function fundingLotFromRow(row: FundingLotRow): FundingLot {
  return {
    lotId: row.lot_id,
    creditId: row.credit_id,
    rail: row.rail,
    satsFunded: toSafeInt(row.sats_funded),
    satsBasisKnown: row.sats_basis_known,
    creditedMicro: toSafeInt(row.credited_micro),
    remainingMicro: toSafeInt(row.remaining_micro),
    fundingRef: row.funding_ref,
    createdAt: toSafeInt(row.created_at),
  };
}

function fundingRecordFromRow(row: FundingRow): FundingRecord {
  return {
    creditId: row.credit_id,
    fundId: row.fund_id,
    amountMicro: toSafeInt(row.amount_micro),
    rail: row.rail,
    createdAt: toSafeInt(row.created_at),
    callerPubkey: row.caller_pubkey,
    balanceAfterMicro: row.balance_after_micro === null ? null : toSafeInt(row.balance_after_micro),
    ledgerSeq: row.ledger_seq === null ? null : toSafeInt(row.ledger_seq),
    receipt: row.receipt,
  };
}

function invoiceRecordFromRow(row: InvoiceRow): CreditInvoiceRecord {
  return {
    creditId: row.credit_id,
    fundId: row.fund_id,
    callerPubkey: row.caller_pubkey,
    currency: row.currency,
    amountMicro: toSafeInt(row.amount_micro),
    amountMsats: toSafeInt(row.amount_msats),
    paymentHash: row.payment_hash,
    bolt11: row.bolt11,
    status: row.status,
    blockedReason: row.blocked_reason,
    reconciledCreditId: row.reconciled_credit_id,
    reconciledFundId: row.reconciled_fund_id,
    resolvedAt: row.resolved_at === null ? null : toSafeInt(row.resolved_at),
    writeOffNote: row.write_off_note,
    expiresAt: toSafeInt(row.expires_at),
    createdAt: toSafeInt(row.created_at),
    settledAt: row.settled_at === null ? null : toSafeInt(row.settled_at),
  };
}

/**
 * Credits released per sweep pass.
 *
 * Bounds the work a DVM does when it wakes after a long idle with a batch of
 * credits that all lapsed while it was down: each release takes the credit's
 * row lock and writes an outbox row, and the next pass picks up the rest a
 * sweep interval later. Nothing is lost by deferring — an expired credit stays
 * expired.
 */
const DEFAULT_EXPIRY_SWEEP_LIMIT = 200;

/**
 * Key each expiry episode by expiryMs plus a sequence counted under the credit lock. fund
 * accepts the provided expiry verbatim, so a revival can reuse the same instant; expiry alone
 * would collide with its reversed release and suppress the next episode.
 */
function expiryReleaseId(expiryMs: number, seq: number): string {
  return `xrel:${expiryMs}:${seq}`;
}

function expiryReleaseFromRow(row: CreditExpiryReleaseRow): CreditExpiryRelease {
  return {
    creditId: row.credit_id,
    releaseId: row.release_id,
    callerPubkey: row.caller_pubkey,
    currency: row.currency,
    rail: row.rail,
    amountMicro: toSafeInt(row.amount_micro),
    expiryMs: toSafeInt(row.expiry_ms),
    releasedAt: toSafeInt(row.released_at),
    reversedAt: row.reversed_at === null ? null : toSafeInt(row.reversed_at),
  };
}

function expiryReleaseReport(
  dvmId: string,
  row: CreditExpiryReleaseRow
): CreditExpiryReleasePayload {
  const release = expiryReleaseFromRow(row);
  return {
    dvmId,
    creditId: release.creditId,
    releaseId: release.releaseId,
    callerPubkey: release.callerPubkey,
    rail: release.rail,
    amountMicro: release.amountMicro,
    creditCurrency: release.currency,
    expiryMs: release.expiryMs,
    releasedAt: release.releasedAt,
    reversedAt: release.reversedAt,
  };
}
