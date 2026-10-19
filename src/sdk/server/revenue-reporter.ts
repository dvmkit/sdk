import { diagnosticConsole } from "../../observability/diagnostic-console";
import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import type { X402SelfRelayRpcFailureReason } from "../../lib/x402/types";
import { withSdkInitLock } from "./init-lock";
import type { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import type { PayoutPendingPayload, PayoutReportPayload } from "./payout-reporter";

/**
 * JSON wire shape POSTed to the platform's `/_internal/job-revenue` endpoint
 * and stored in `pending_dvm_reports.payload` for durable retry.
 */
export interface RevenueReportPayload {
  /** Platform DVM record ID (`dvms.id`). Identifies which DVM earned the revenue. */
  dvmId: string;
  /** Job identifier used by the platform to de-duplicate revenue rows and link to the job record. */
  jobId: string;
  /**
   * Capability selected by dispatch for this job. Omitted for
   * reports from older SDKs and legacy persisted jobs that predate capability
   * dispatch; absence must not be rewritten as a capability name.
   */
  capability?: string;
  /** Total amount paid by the caller in millisatoshis, across all credits that satisfied the job. */
  paidMsats: number;
  /** Cashu mint URL from which the payment tokens were issued. Set only for the `cashu` rail; omitted for all other rails. */
  paymentMint?: string;
  /**
   * Payment rail identifier (`"cashu"`, `"tempo"`, `"x402"`, `"stripe"`).
   * Mirrors `PaymentMethod` on the platform; carried as a plain string over the wire
   * so the SDK has no platform-type dependency.
   */
  rail: string;
  /**
   * Settlement reference for the credit: EVM tx hash for `x402`, credential
   * challenge ID for `tempo`, `X-Cashu-Request-Id` UUID for `cashu`. Required by the
   * platform revenue ledger for `tempo`/`x402` rails (recordJobRevenue throws without it);
   * nullable for `cashu`.
   */
  paymentTxHash?: string;
  /**
   * Rail-native payment amount in atomic units: USDC microunits for `tempo` and
   * `x402`, USD cents for `stripe`. Omitted for `cashu` (platform derives
   * `paidMsats / 1000`). Must be set together with `nativeAsset`.
   */
  nativeAmount?: number;
  /**
   * Asset tag paired with `nativeAmount`: `"sats"`, `"usdc"`, `"usdc.e"`, or
   * `"usd-cents"`. Both fields must be present for the platform to write a non-cashu
   * revenue row.
   */
  nativeAsset?: string;
  /**
   * Cashu flow discriminator. Set to `"p2pk_accumulator"` when the cashu
   * accumulator path satisfied the job; omitted for legacy cashu. Written into
   * `revenue_events.metadata.cashu_flow` by the platform so ops can split per-call cashu
   * rows by source.
   */
  cashuFlow?: string;
  /**
   * What the job cost the **builder** to serve, as declared by the
   * handler through `ctx.cost()` — the other half of the
   * margin the dashboard states. `amountMicro` is 1e-6 of `currency`, which
   * is the currency the builder incurred the cost in and need not be the
   * credit's.
   *
   * Never netted against `paidMsats` or `drawAmountMicro`: what the caller
   * paid and what serving them cost are two questions, so they are two fields.
   *
   * **Absent means unreported, not zero.** A handler that declares nothing
   * sends no `cost` key at all, and the platform shows the margin as unknown
   * rather than as 100%. A handler that declares `{ amount: 0 }` is making the
   * opposite, positive claim and sends `amountMicro: 0`.
   *
   * Additive on the wire: a platform build that does not read this key keeps
   * accepting the report unchanged.
   */
  cost?: { amountMicro: number; currency: string };
  /**
   * Credit this job's payment drew against. Present on
   * every job a ledger-backed payment satisfied; its presence is what tells
   * the platform the row is a **draw-keyed** revenue event rather than a
   * pre-credits per-call one.
   */
  creditId?: string;
  /** The draw this job settled — one draw, one revenue row. */
  drawId?: string;
  /** The draw's fiat amount, 1e-6 of `creditCurrency`. The exact liability offset. */
  drawAmountMicro?: number;
  /** Currency the credit is denominated in (lowercase ISO, e.g. `usd`). */
  creditCurrency?: string;
  /**
   * Settlement instant (epoch ms) — draws are revenue *when they
   * settle*, so this dates the row. Omitted for pre-credits rows, which the
   * platform dates at record time as before.
   */
  settledAt?: number;
  /** The funding's own rail reference, for reconciling a draw back to its deposit. */
  fundingRef?: string;
  /**
   * Revenue class when this row is not ordinary service revenue.
   * `short_pay_forfeit` marks money kept from an underpayment that bought no
   * job so analytics can exclude it.
   */
  kind?: string;
}

/** Privacy-preserving terminal evidence; contains no caller or payment references. */
export interface JobTerminalReportPayload {
  dvmId: string;
  jobId: string;
  capability: string;
  outcome: "completed" | "failed" | "cancelled";
  endedBy: "caller" | "provider" | null;
  paid: boolean;
  acceptedAtMs: number;
  terminalAtMs: number;
  callerWaitMs: number;
  receiptSeq: number | null;
}

/**
 * JSON wire shape POSTed to the platform's `/_internal/job-cost` endpoint
 * when a terminal job incurred a declared builder cost but produced no
 * revenue report.
 *
 * Unlike {@link RevenueReportPayload}, this event has no payment rail or
 * revenue amount: a failed, cancelled, or free job is not a sale. The
 * platform upserts it by `(dvmId, jobId)`, independently of the revenue
 * ledger's rail-keyed constraint. It replaces the stored value only when
 * `costRevision` is higher; equal revisions must be byte-identical. That rule
 * makes a persisted prefix and a later in-memory total converge regardless of
 * delivery order.
 */
export interface JobCostReportPayload {
  /** Platform DVM record ID (`dvms.id`); bound to the authenticating token. */
  dvmId: string;
  /** Job identifier and the report's platform-side idempotency key. */
  jobId: string;
  /** Capability selected by dispatch; absent only on legacy persisted jobs. */
  capability?: string;
  /** Terminal outcome that explains why this event carries no revenue. */
  outcome: "completed" | "failed" | "cancelled";
  /**
   * Number of declarations incorporated into `cost`; the
   * platform keeps the payload with the highest revision for this job.
   */
  costRevision: number;
  /**
   * The builder's cumulative declared cost, in millionths of its currency.
   * `null` at a higher revision invalidates an earlier prefix when the handler
   * switched currencies and the final total is therefore unreportable.
   */
  cost: { amountMicro: number; currency: string } | null;
}

/**
 * JSON wire shape POSTed to the platform's `/_internal/credit-deposit`
 * endpoint. A funding event is a **deposit** — a liability until
 * drawn — reported separately and never summed into revenue (the deposit-accounting rule).
 *
 * Idempotent on `(dvmId, creditId, fundingId)`, so the shared retry loop can
 * redeliver freely.
 */
export interface CreditDepositPayload {
  /** Platform DVM record ID (`dvms.id`); must match the bearer token's DVM. */
  dvmId: string;
  creditId: string;
  /** Canonical owner of the funded credit. */
  callerPubkey: string;
  /** The rail's settlement reference — the deposit's idempotency key. */
  fundingId: string;
  /** Payment rail (`"cashu"`, `"tempo"`, `"x402"`). */
  rail: string;
  /** Rail value received, in millisatoshis. */
  paidMsats: number;
  /** Cashu only. Full received proof face before its receiver input fee. */
  grossPaidMsats?: number;
  /** Cashu only. Standalone NUT-02 fee reserved by the received proofs. */
  cashuInputFeeMsats?: number;
  /** Rail-native atomic units; omitted for cashu (derived from `paidMsats`). */
  nativeAmount?: number;
  /** Asset tag paired with `nativeAmount`. */
  nativeAsset?: string;
  /** Cashu mint URL the funding proofs were issued from. */
  paymentMint?: string;
  /** Fiat micro credited to the ledger — the liability this deposit creates. */
  amountMicro: number;
  /** Currency `amountMicro` is 1e-6 of. */
  creditCurrency: string;
  /** When the funding committed (epoch ms). */
  fundedAt: number;
  /** Current credit expiry after this funding committed (epoch ms). */
  expiryMs: number;
  /**
   * The stablecoin instrument behind the funded credit, read from the
   * credit's stored binding rather than inferred from `fundingId`'s shape.
   * Present on every x402 and Tempo deposit; absent on Cashu and Lightning,
   * which have only one instrument each.
   */
  instrument?: "x402_exact" | "x402_channel" | "tempo_charge" | "tempo_session";
  /**
   * Tempo session funding only: the TIP-1034 channel this deposit
   * arrived on, registered so the platform's close observer can route a
   * `CloseRequested` event back to the DVM that owns the channel.
   *
   * Rides the deposit report rather than a side channel on purpose — accepting
   * the voucher and booking the registration then share the one durable commit
   * boundary, so a registered channel can never be a channel whose funding
   * rolled back, and the existing retry drain delivers it after a crash. The
   * registration is therefore asynchronous relative to the close: an event can
   * legitimately arrive first, which is what the platform's payee fallback is
   * for.
   */
  tempoChannel?: {
    chainId: number;
    /** 32-byte channel id, `0x`-prefixed and lowercased. */
    channelId: string;
    /** TIP-1034 escrow the channel was opened against. */
    escrow: string;
    /** The DVM's on-chain recipient — the fallback routing key. */
    payee?: string;
  };
  /**
   * Tempo session funding only: which channel this deposit's voucher
   * was accepted on, emitted **whenever the funding was session-based** —
   * independently of whether {@link CreditDepositPayload.tempoChannel} could be
   * read. That independence is the entire point: `rail: "tempo"` covers both
   * `tempo/session` and the `tempo/charge` one-shot, and a charge legitimately
   * carries no channel at all, so without this the platform cannot tell a
   * routine charge deposit from a session whose chain binding was lost — the
   * shape, where the close observer silently never watches the escrow.
   *
   * Carries only the channel id, not the chain binding: a DVM that could read
   * the binding sends `tempoChannel` too, and one that could not still names
   * the channel an operator has to go and look at.
   */
  tempoSession?: {
    /** 32-byte channel id, `0x`-prefixed and lowercased. */
    channelId: string;
  };
  /**
   * Set by the blocked-invoice repair: this deposit is a paid
   * Lightning invoice the builder's agent reconciled onto a credit. The money
   * landed in the receive wallet at payment time and this deposit is the one
   * row it gets, so the settlements table types it `repair` off this flag
   * rather than off a second row.
   */
  repaired?: boolean;
}

/** Completed-draw reversal posted to /_internal/credit-draw-refund. */
export interface CreditDrawRefundPayload {
  dvmId: string;
  creditId: string;
  drawId: string;
  jobId: string;
  refundId: string;
  amountMicro: number;
  creditCurrency: string;
  ledgerSeq: number;
  refundedAt: number;
  reason?: string;
}

export type CreditDrawRefundEnqueue = (
  tx: RevenueReporterQuerier,
  payload: CreditDrawRefundPayload
) => Promise<void>;

/**
 * JSON wire shape POSTed to the platform's `/_internal/credit-draw-release`
 * endpoint. A released hold leaves the credit balance intact, but
 * marks that slice of the outstanding liability as failure churn rather than
 * untouched prefunding.
 *
 * Idempotent on `(dvmId, creditId, drawId)`, so the reporter queue can
 * redeliver freely.
 */
export interface CreditDrawReleasePayload {
  /** Platform DVM record ID (`dvms.id`); must match the bearer token's DVM. */
  dvmId: string;
  creditId: string;
  /** Released draw; the platform idempotency key with DVM and credit. */
  drawId: string;
  /** Fiat micro restored to availability. */
  amountMicro: number;
  /** Currency `amountMicro` is 1e-6 of. */
  creditCurrency: string;
  /** Per-credit gap-free sequence assigned when the draw was placed. */
  ledgerSeq: number;
  /** When the hold reached `released` (epoch ms). */
  releasedAt: number;
}

export type CreditDrainRepairKind =
  | "x402_settlement_reconciled"
  | "tempo_close_reconciled";

/**
 * Terminal picked_up/sent drains report reclaimed fiat micro-units, reducing
 * outstanding liability rather than adding revenue. Requested or parked drains
 * have not paid the caller. Idempotency key: (dvmId, creditId, drainId).
 */
export interface CreditDrainPayload {
  /** Platform DVM record ID (`dvms.id`); must match the bearer token's DVM. */
  dvmId: string;
  creditId: string;
  /** Canonical owner of the reclaimed credit. */
  callerPubkey: string;
  /** The drain's own idempotency key. */
  drainId: string;
  /** Payout rail (`"cashu"`, `"x402"`, `"tempo"`). */
  method: string;
  /** Fiat micro reclaimed — the liability this drain extinguishes. */
  amountMicro: number;
  /** Currency `amountMicro` is 1e-6 of. */
  creditCurrency: string;
  /** Terminal state: `"picked_up"` for cashu, `"sent"` for other rails. */
  status: string;
  /** When the money left (epoch ms). */
  drainedAt: number;
  /** Per-credit gap-free ledger sequence, for reconciling against the DVM's ledger. */
  ledgerSeq?: number;
  /** Set when an operator repair verb completed this reclaim. */
  repaired?: boolean;
  /** Required iff `repaired`; identifies the repair path that completed the reclaim. */
  repairKind?: CreditDrainRepairKind;
}

/**
 * Open Postgres transaction handle accepted by the reporter-owned outbox
 * enqueue. The payment rail owns BEGIN/COMMIT; the reporter owns its table.
 */
export interface RevenueReporterQuerier {
  query: Pool["query"];
}

/**
 * Transactional deposit-outbox seam threaded through each rail commit.
 *
 * Implemented by {@link RevenueReporter.enqueueDeposit}; callers must await it
 * before committing the rail receive and ledger funding.
 */
export type CreditDepositEnqueue = (
  tx: RevenueReporterQuerier,
  payload: CreditDepositPayload
) => Promise<void>;

/** Transactional draw-release outbox seam used by the credit ledger. */
export type CreditDrawReleaseEnqueue = (
  tx: RevenueReporterQuerier,
  payload: CreditDrawReleasePayload
) => Promise<void>;

/**
 * Transactional drain-outbox seam threaded through each terminal drain
 * transition.
 *
 * Implemented by {@link RevenueReporter.enqueueCreditDrain}; callers must await
 * it before committing the status CAS that moved the money.
 */
export type CreditDrainEnqueue = (
  tx: RevenueReporterQuerier,
  payload: CreditDrainPayload
) => Promise<void>;

/**
 * JSON wire shape POSTed to the platform's `/_internal/credit-expiry-release`
 * endpoint. A prepaid credit that reaches its TTL with an undrawn
 * remainder RELEASES that remainder to the builder: on cashu, Lightning and
 * x402 the funding value reached builder custody at funding time or on the
 * settlement cycle, so expiry extinguishes the caller's remaining claim.
 * Reported so committed value nets to
 * `deposited − drawn − drained − released`; without it an expired credit is
 * owed forever on paper, exactly like an unreported drain.
 *
 * Never sent for a Tempo credit. Tempo balances are channel-backed and undrawn
 * channel value returns to the *caller* at exit, so no release exists on that
 * rail — the sweep skips them and the platform refuses one outright.
 *
 * Two reports share this shape, distinguished only by `reversedAt`:
 *
 * - **The release**, written by the expiry sweep with `reversedAt` absent.
 * - **The reversal**, written when a later funding revives the credit
 * (`CreditLedger.fund` overwrites `expiry_ms`, so the recorded remainder is
 * no longer final). It repeats the whole payload rather than sending a
 * reference, because the retry loop can deliver the two out of order and the
 * platform's upsert must be able to land either one first.
 *
 * Idempotent on `(dvmId, creditId, releaseId)`, so the shared retry loop can
 * redeliver freely.
 */
export interface CreditExpiryReleasePayload {
  /** Platform DVM record ID (`dvms.id`); must match the bearer token's DVM. */
  dvmId: string;
  creditId: string;
  /** Per-expiry-episode key; the platform idempotency key with DVM and credit. */
  releaseId: string;
  callerPubkey: string;
  /** Funding rail. `null` on a credit funded before the basis became mandatory. */
  rail: string | null;
  /** Fiat micro released — the liability this expiry extinguishes. */
  amountMicro: number;
  /** Currency `amountMicro` is 1e-6 of. */
  creditCurrency: string;
  /** When the credit's TTL ran out (epoch ms) — when the liability ended. */
  expiryMs: number;
  /** When the sweep observed the expiry (epoch ms). */
  releasedAt: number;
  /** Set only on the reversal report: when the revival funding landed (epoch ms). */
  reversedAt?: number | null;
}

/**
 * Transactional expiry-release outbox seam, threaded through the sweep's insert
 * and through the funding that reverses a release.
 *
 * Implemented by {@link RevenueReporter.enqueueCreditExpiryRelease}; callers
 * must await it before committing the write that made the release (or its
 * reversal) true, for the same reason the drain seam does — a report lost
 * between the two overstates or understates committed value forever.
 */
export type CreditExpiryReleaseEnqueue = (
  tx: RevenueReporterQuerier,
  payload: CreditExpiryReleasePayload
) => Promise<void>;

/**
 * JSON wire shape POSTed to the platform's `/_internal/paid-job-death` endpoint
 * when the stale-job reaper force-fails a *paid* job — its pending
 * credit draw is released rather than settled, so the caller's payment is back
 * on their credit balance and reclaimable by drain. The platform resolves fiat
 * + owner and sends an ambient notice via the shared alert sink. Unlike
 * {@link RevenueReportPayload} this carries no durable-retry semantics: the
 * reaper's `stale_job_failed` structured log is the durable backstop, so a lost
 * report degrades to log-only rather than blocking the sweep.
 */
export interface PaidJobDeathPayload {
  /** Platform DVM record ID (`dvms.id`). Bound to the authenticating token. */
  dvmId: string;
  jobId: string;
  capability: string;
  /** Amount of the released credit draw in millisatoshis. */
  paidMsats: number;
  /** Payment rail of the released draw (`"cashu"`, `"tempo"`, `"x402"`). */
  rail: string;
  /** Reaper reason: dead worker or never-terminal idle job. */
  reason: string;
  /** Rail-native released amount, paired with `nativeAsset`. */
  nativeAmount?: number;
  /** Asset tag for `nativeAmount` (`"sats"` / `"usdc"` / …). */
  nativeAsset?: string;
  /** Cashu mint URL the credit draw's tokens were issued from. */
  paymentMint?: string;
}

export type RevenueSkippedNoRailReason =
  | "credit_rail_null"
  | "credit_rail_unrecognized"
  | "job_rail_missing"
  | "ledger_not_configured";

/**
 * JSON wire shape POSTed to the platform's `/_internal/revenue-skipped-no-rail`
 * endpoint when a settled credit draw has no usable payment rail
 * for its revenue event. This is an operator notice rather than a durable
 * accounting report: the SDK's structured log remains the durable backstop,
 * and a failed alert must never block terminal handling or reconciliation.
 */
export interface RevenueSkippedNoRailPayload {
  /** Platform DVM record ID (`dvms.id`). Bound to the authenticating token. */
  dvmId: string;
  jobId: string;
  creditId: string;
  drawId: string;
  /** Caller payment captured for the job, in millisatoshis. */
  paidMsats: number;
  /** Settled draw amount in 1e-6 of `creditCurrency`. */
  drawAmountMicro?: number;
  /** Currency the draw amount is denominated in. */
  creditCurrency?: string;
  /** Credit funding rail as stored on the draw, or null for legacy rows. */
  creditRail: string | null;
  reason: RevenueSkippedNoRailReason;
}

/** Gas-balance observation POSTed by a platform-hosted x402 self-relay. */
export interface X402SelfRelayGasBalancePayload {
  /** Platform DVM record ID, bound to the authenticating platform token. */
  dvmId: string;
  /** Dedicated relay EOA whose Base ETH balance was read. */
  address: `0x${string}`;
  /** CAIP-2 Base network identifier. */
  network: string;
  /** Current native balance as a decimal wei string. */
  balanceWei: string;
  /** Configured paging floor as a decimal wei string. */
  lowBalanceWei: string;
  /** Millisecond timestamp at which the DVM read the balance. */
  checkedAt: number;
}

/** RPC-health transition POSTed by a platform-hosted x402 self-relay. */
export type X402SelfRelayRpcHealthPayload =
  | {
      /** Platform DVM record ID, bound to the authenticating platform token. */
      dvmId: string;
      /** Dedicated relay EOA identifying the affected self-relay. */
      address: `0x${string}`;
      /** CAIP-2 Base network identifier. */
      network: string;
      /** Healthy transition clears an open RPC page. */
      status: "healthy";
      /** Millisecond timestamp at which the DVM observed the transition. */
      checkedAt: number;
    }
  | {
      /** Platform DVM record ID, bound to the authenticating platform token. */
      dvmId: string;
      /** Dedicated relay EOA identifying the affected self-relay. */
      address: `0x${string}`;
      /** CAIP-2 Base network identifier. */
      network: string;
      /** Failed transition opens or refreshes an RPC page. */
      status: "failed";
      /** Redacted failure class; never the provider error or endpoint URL. */
      reason: X402SelfRelayRpcFailureReason;
      /** Millisecond timestamp at which the DVM observed the transition. */
      checkedAt: number;
    };

/** Configured Tempo operator fee-token balance POSTed by a hosted DVM. */
export interface TempoSettlementBalancePayload {
  dvmId: string;
  address: `0x${string}`;
  network: string;
  token: `0x${string}`;
  balanceMicro: string;
  lowBalanceMicro: string;
  checkedAt: number;
  ready: boolean;
}

/** Redacted Tempo operator fee-funding rejection POSTed by a hosted DVM. */
export interface TempoSettlementFailurePayload {
  dvmId: string;
  address: `0x${string}`;
  network: string;
  token: `0x${string}`;
  operation: "settle" | "close";
  errorClass: "InsufficientFundsError";
  checkedAt: number;
  balanceMicro?: string;
  channelId?: string;
  creditId?: string;
  drainId?: string;
}

type ReportKind =
  | "job_terminal"
  | "revenue"
  | "cost"
  | "deposit"
  | "refund"
  | "release"
  | "drain"
  | "payout"
  | "expiry_release";

const ENDPOINTS: Record<ReportKind, string> = {
  job_terminal: "/_internal/job-terminal",
  revenue: "/_internal/job-revenue",
  cost: "/_internal/job-cost",
  deposit: "/_internal/credit-deposit",
  release: "/_internal/credit-draw-release",
  refund: "/_internal/credit-draw-refund",
  drain: "/_internal/credit-drain",
  payout: "/_internal/payout",
  expiry_release: "/_internal/credit-expiry-release",
};

const PENDING_DVM_REPORTS_TABLE = "pending_dvm_reports";
const LEGACY_PENDING_REPORTS_TABLE = "pending_revenue_reports";
const SDK_REPORT_TABLE_BASE_COLUMNS = [
  "id",
  "payload",
  "retry_count",
  "next_retry_at",
  "stale",
  "created_at",
] as const;
const PLATFORM_REPORT_TABLE_COLUMNS = [
  "id",
  "payload",
  "source",
  "retry_count",
  "next_retry_at",
  "last_error",
  "created_at",
] as const;

/**
 * Durable revenue reporter for container-runtime DVMs.
 *
 * On job completion the SDK calls `report()`, which persists the payload to
 * a local Postgres table and attempts an immediate POST to the platform.
 * A background retry loop picks up un-acked rows with exponential backoff.
 * Gauge and health notifications are best-effort: failed delivery is logged
 * and dropped rather than queued for retry.
 */
export class RevenueReporter {
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly RETRY_INTERVAL_MS = 30_000;
  private static readonly MAX_BACKOFF_MS = 300_000; // 5 min
  private static readonly ABANDON_AFTER_MS = 24 * 60 * 60 * 1000; // 24h of failed retries

  constructor(
    private readonly db: Pool,
    private readonly platformUrl: string,
    private readonly platformToken: string,
    private readonly hostedObligations?: HostedSettlementReportObligations
  ) {}

  /** Create the pending-reports table and migrate the legacy SDK outbox (idempotent). */
  async init(): Promise<void> {
    await withSdkInitLock(this.db, () => this.createTables());
  }

  private async createTables(): Promise<void> {
    // SDK-owned DVM outbox. The platform's unrelated revenue dead-letter queue
    // intentionally keeps the legacy `pending_revenue_reports` name.
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS ${PENDING_DVM_REPORTS_TABLE} (
        id            TEXT PRIMARY KEY,
        payload       JSONB NOT NULL,
        retry_count   INTEGER NOT NULL DEFAULT 0,
        next_retry_at BIGINT NOT NULL DEFAULT 0,
        stale         BOOLEAN NOT NULL DEFAULT false,
        stale_reason  TEXT,
        created_at    BIGINT NOT NULL,
        kind          TEXT NOT NULL DEFAULT 'revenue'
      )
    `);
    await this.db.query(`CREATE TABLE IF NOT EXISTS reported_job_terminals (
      dvm_id TEXT NOT NULL, job_id TEXT NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY (dvm_id, job_id)
    )`);
    await this.assertSdkTableShape(PENDING_DVM_REPORTS_TABLE);
    // Migration for tables created before stale_reason / kind existed. The
    // `revenue` default is what makes rows queued by an older process still
    // deliverable after an upgrade.
    await this.db.query(
      `ALTER TABLE ${PENDING_DVM_REPORTS_TABLE} ADD COLUMN IF NOT EXISTS stale_reason TEXT`
    );
    await this.db.query(
      `ALTER TABLE ${PENDING_DVM_REPORTS_TABLE} ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'revenue'`
    );
    await this.migrateLegacySdkOutbox();
  }

  private async migrateLegacySdkOutbox(): Promise<void> {
    const columns = await this.tableColumns(LEGACY_PENDING_REPORTS_TABLE);
    if (columns.size === 0) return;

    if (PLATFORM_REPORT_TABLE_COLUMNS.every((column) => columns.has(column))) {
      return;
    }
    this.assertSdkColumns(LEGACY_PENDING_REPORTS_TABLE, columns);

    // Older SDK builds may predate either optional column. Normalize the old
    // table first so the copy is one static, retry-safe statement.
    await this.db.query(
      `ALTER TABLE ${LEGACY_PENDING_REPORTS_TABLE} ADD COLUMN IF NOT EXISTS stale_reason TEXT`
    );
    await this.db.query(
      `ALTER TABLE ${LEGACY_PENDING_REPORTS_TABLE} ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'revenue'`
    );
    // Move and retire in one statement: `copied` identifies rows inserted now,
    // while the second arm covers a prior boot that copied the row but stopped
    // before retiring it. A source row is never removed without a target row.
    await this.db.query(`
      WITH copied AS (
        INSERT INTO ${PENDING_DVM_REPORTS_TABLE}
        (id, payload, retry_count, next_retry_at, stale, stale_reason, created_at, kind)
        SELECT id, payload, retry_count, next_retry_at, stale, stale_reason, created_at, kind
        FROM ${LEGACY_PENDING_REPORTS_TABLE}
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      )

      DELETE FROM ${LEGACY_PENDING_REPORTS_TABLE} AS legacy
      WHERE EXISTS (SELECT 1 FROM copied WHERE copied.id = legacy.id)
         OR EXISTS (
           SELECT 1 FROM ${PENDING_DVM_REPORTS_TABLE} AS migrated
           WHERE migrated.id = legacy.id
         )
    `);
  }

  private async assertSdkTableShape(tableName: string): Promise<void> {
    this.assertSdkColumns(tableName, await this.tableColumns(tableName));
  }

  private assertSdkColumns(tableName: string, columns: ReadonlySet<string>): void {
    const matchesSdk =
      SDK_REPORT_TABLE_BASE_COLUMNS.every((column) => columns.has(column)) &&
      !columns.has("source");
    if (matchesSdk) return;

    throw new Error(
      `RevenueReporter.init(): table "${tableName}" is not the SDK revenue outbox shape. ` +
        `The SDK owns "${PENDING_DVM_REPORTS_TABLE}"; the platform owns ` +
        `"${LEGACY_PENDING_REPORTS_TABLE}". Refusing to boot before credit funding can ` +
        `reach a mismatched outbox. Found columns: ${[...columns].sort().join(", ") || "none"}.`
    );
  }

  private async tableColumns(tableName: string): Promise<Set<string>> {
    const { rows } = await this.db.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1`,
      [tableName]
    );
    return new Set(rows.map((row) => row.column_name));
  }

  /** Persist a revenue report and attempt immediate delivery. */
  async report(payload: RevenueReportPayload): Promise<void> {
    return this.enqueue("revenue", payload, payload.jobId);
  }

  /** The permanent deduplication claim and outbox insert commit together.
   * The claim survives successful delivery, including for custom job stores.
   */
  async reportTerminal(payload: JobTerminalReportPayload): Promise<void> {
    const id = randomUUID();
    const { rowCount } = await this.db.query(
      `WITH claimed AS (
         INSERT INTO reported_job_terminals (dvm_id, job_id, created_at)
         VALUES ($5, $1, $4) ON CONFLICT DO NOTHING RETURNING job_id
       ) INSERT INTO ${PENDING_DVM_REPORTS_TABLE} (id, payload, created_at, kind)
         SELECT $2, $3::jsonb, $4, 'job_terminal' FROM claimed`,
      [payload.jobId, id, JSON.stringify(payload), Date.now(), payload.dvmId]
    );
    if (rowCount) void this.attemptDelivery(id, payload, "job_terminal", payload.jobId).catch(() => undefined);
  }

  /** Persist a zero-revenue job cost and attempt immediate delivery. */
  async reportCost(payload: JobCostReportPayload): Promise<void> {
    return this.enqueue("cost", payload, payload.jobId);
  }

  /**
   * Join a credit deposit to the caller-owned rail transaction.
   *
   * This method performs no network I/O: it only writes the reporter-owned
   * durable queue row through `tx`. The retry drain delivers the row after the
   * rail transaction commits, including after a process restart.
   */
  async enqueueDeposit(tx: RevenueReporterQuerier, payload: CreditDepositPayload): Promise<void> {
    await this.insertPending(tx, "deposit", payload);
  }

  /** Persist without network delivery before the refund accounting transaction commits. */
  async enqueueCreditDrawRefund(tx: RevenueReporterQuerier, payload: CreditDrawRefundPayload): Promise<void> {
    await this.insertPending(tx, "refund", payload);
  }

  /** Join a released draw to the transaction that made the hold terminal. */
  async enqueueCreditDrawRelease(
    tx: RevenueReporterQuerier,
    payload: CreditDrawReleasePayload
  ): Promise<void> {
    await this.insertPending(tx, "release", payload);
  }

  /**
   * Await durable queue insertion through tx so the terminal drain and its
   * report commit or roll back together; no network I/O here.
   */
  async enqueueCreditDrain(tx: RevenueReporterQuerier, payload: CreditDrainPayload): Promise<void> {
    await this.insertPending(tx, "drain", payload);
  }

  /**
   * Join a payout to the transaction that commits the movement it reports
   * the batch close, the accumulator mark, the drain booking.
   * No network I/O, only the durable queue row through `tx`, the discipline
   * {@link enqueueCreditDrain} set and for the same reason: the money has
   * already moved on a rail this ledger does not own, so the platform row is
   * the only record the builder's dashboard has of it, and a row lost between
   * the fact and the queue would understate "paid out" forever. Without `tx`
   * the row is queued on the pool, for callers with no fact of their own to
   * commit. Idempotent on `(dvmId, payoutId)` platform-side, so the retry
   * loop redelivers freely.
   */
  async enqueuePayout(payload: PayoutReportPayload, tx?: RevenueReporterQuerier): Promise<void> {
    if (this.hostedObligations && (payload.rail === "x402" || payload.rail === "tempo") &&
      await this.hostedObligations.hasCompleteHistory(tx ?? this.db)) {
      throw new Error("Hosted channel payout requires its original settlement obligation");
    }
    await this.insertPending(tx ?? this.db, "payout", payload);
  }

  async enqueueHostedPayout(payload: PayoutReportPayload, obligationIds: string[],
    tx?: RevenueReporterQuerier): Promise<void> {
    if (!this.hostedObligations || (payload.rail !== "x402" && payload.rail !== "tempo")) {
      throw new Error("Hosted channel payout has no managed obligation recorder");
    }
    const enqueue = async (query: RevenueReporterQuerier): Promise<void> => {
      if (await this.hostedObligations!.hasOriginalReport(obligationIds, payload.payoutId,
        payload as unknown as Record<string, unknown>, query)) return;
      const reportId = await this.insertPending(query, "payout", payload);
      await this.hostedObligations!.queueReport(obligationIds, payload.payoutId,
        reportId, payload as unknown as Record<string, unknown>, query);
    };
    if (tx) return enqueue(tx);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await enqueue(client);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Report one landed payout on its own and try to deliver it at once — the
   * live Tempo settlement, which has no dvmkit transaction to join. Durable
   * like {@link report}.
   */
  async reportPayout(payload: PayoutReportPayload): Promise<void> {
    return this.enqueue("payout", payload, payload.payoutId);
  }

  /**
   * Report one rail's pending-pool snapshot. Best-effort and
   * fire-and-forget, deliberately unlike {@link reportPayout}: a snapshot is
   * replaced by the next tick, so queueing a stale one behind an outage would
   * only deliver figures the platform already has newer ones for.
   */
  async reportPayoutPending(payload: PayoutPendingPayload): Promise<void> {
    const url = `${this.platformUrl}/_internal/payout-pending`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "payout_pending_report_failed",
            rail: payload.rail,
            status: res.status,
          }
        );
      }
    } catch (_err) {
      diagnosticConsole.warn(
        {
          level: "payout_pending_report_failed",
          rail: payload.rail,
          error: undefined,
        }
      );
    }
  }

  /**
   * Await durable queue insertion through tx so expiry release or reversal and
   * its report commit together. A missing reversal would overstate builder value.
   */
  async enqueueCreditExpiryRelease(
    tx: RevenueReporterQuerier,
    payload: CreditExpiryReleasePayload
  ): Promise<void> {
    await this.insertPending(tx, "expiry_release", payload);
  }

  /**
   * Report a reaper-force-failed paid job to the platform so the
   * operator receives an ambient notice that a DVM died or wedged mid-job.
   * Best-effort and fire-and-forget: unlike {@link report} there is no local
   * durable queue — a non-2xx or transport failure is structured-logged
   * (`paid_job_death_report_failed`) and dropped, since the reaper's own
   * `stale_job_failed` log is the durable record and a failed *alert* must never
   * wedge the sweep.
   */
  async reportPaidJobDeath(payload: PaidJobDeathPayload): Promise<void> {
    const url = `${this.platformUrl}/_internal/paid-job-death`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "paid_job_death_report_failed",
            jobId: payload.jobId,
            status: res.status,
          }
        );
      }
    } catch (_err) {
      diagnosticConsole.warn(
        {
          level: "paid_job_death_report_failed",
          jobId: payload.jobId,
          error: undefined,
        }
      );
    }
  }

  /**
   * Report a settled draw whose revenue event was skipped.
   * Best-effort and fire-and-forget: the SDK's structured
   * `revenue_skipped_no_rail` log is the durable backstop, so a failed notice
   * must never wedge terminal handling or the orphan-draw reconciler.
   */
  async reportRevenueSkippedNoRail(payload: RevenueSkippedNoRailPayload): Promise<void> {
    const url = `${this.platformUrl}/_internal/revenue-skipped-no-rail`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "revenue_skipped_no_rail_report_failed",
            jobId: payload.jobId,
            drawId: payload.drawId,
            reason: payload.reason,
            status: res.status,
          }
        );
      }
    } catch (_err) {
      diagnosticConsole.warn(
        {
          level: "revenue_skipped_no_rail_report_failed",
          jobId: payload.jobId,
          drawId: payload.drawId,
          reason: payload.reason,
          error: undefined,
        }
      );
    }
  }

  async reportX402SelfRelayGasBalance(payload: X402SelfRelayGasBalancePayload): Promise<void> {
    const url = `${this.platformUrl}/_internal/x402-self-relay-gas-balance`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "x402_self_relay_gas_balance_report_failed",
            address: payload.address,
            status: res.status,
          }
        );
      }
    } catch (_err) {
      diagnosticConsole.warn(
        {
          level: "x402_self_relay_gas_balance_report_failed",
          address: payload.address,
          error: undefined,
        }
      );
    }
  }

  async reportX402SelfRelayRpcHealth(payload: X402SelfRelayRpcHealthPayload): Promise<void> {
    const url = `${this.platformUrl}/_internal/x402-self-relay-rpc-health`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "x402_self_relay_rpc_health_report_failed",
            address: payload.address,
            status: res.status,
          }
        );
      }
    } catch {
      diagnosticConsole.warn(
        {
          level: "x402_self_relay_rpc_health_report_failed",
          address: payload.address,
          reason: "transport",
        }
      );
    }
  }

  async reportTempoSettlementBalance(payload: TempoSettlementBalancePayload): Promise<void> {
    await this.postTempoSettlementReadiness("balance", payload);
  }

  async reportTempoSettlementFailure(payload: TempoSettlementFailurePayload): Promise<void> {
    await this.postTempoSettlementReadiness("failure", payload);
  }

  private async postTempoSettlementReadiness(
    kind: "balance" | "failure",
    payload: TempoSettlementBalancePayload | TempoSettlementFailurePayload
  ): Promise<void> {
    const url = `${this.platformUrl}/_internal/tempo-settlement-${kind}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        diagnosticConsole.warn(
          {
            level: "tempo_settlement_readiness_report_failed",
            kind,
            address: payload.address,
            status: res.status,
          }
        );
      }
    } catch {
      diagnosticConsole.warn(
        {
          level: "tempo_settlement_readiness_report_failed",
          kind,
          address: payload.address,
          reason: "transport",
        }
      );
    }
  }

  startRetryLoop(): void {
    if (this.retryTimer) return;
    this.retryTimer = setInterval(() => {
      void this.drainPending();
    }, RevenueReporter.RETRY_INTERVAL_MS);
  }

  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Operator-facing queue snapshot: distinguishes the live retry queue from
   * terminal (stale) rows and breaks the latter down by classification reason
   * (`token_rotated`, `client_error:<status>`, `abandoned`). Lets monitoring tell
   * transient backlog apart from permanently-failed rows.
   */
  async getQueueStats(): Promise<{
    liveRetry: number;
    stale: number;
    byReason: Record<string, number>;
  }> {
    const { rows } = await this.db.query<{
      stale: boolean;
      stale_reason: string | null;
      count: string;
    }>(
      `SELECT stale, stale_reason, COUNT(*)::int AS count
       FROM ${PENDING_DVM_REPORTS_TABLE}
       GROUP BY stale, stale_reason`
    );
    let liveRetry = 0;
    let stale = 0;
    const byReason: Record<string, number> = {};
    for (const row of rows) {
      const count = Number(row.count);
      if (row.stale) {
        stale += count;
        const reason = row.stale_reason ?? "unknown";
        byReason[reason] = (byReason[reason] ?? 0) + count;
      } else {
        liveRetry += count;
      }
    }
    return { liveRetry, stale, byReason };
  }

  /**
   * Deliver one bounded batch from the durable queue.
   *
   * Processes due, non-stale rows; failures back off up to five minutes and
   * become terminal after 24 hours. Successful deliveries remove their rows.
   */
  async drainPending(): Promise<void> {
    try {
      const { rows } = await this.db.query<{
        id: string;
        payload: Partial<JobTerminalReportPayload> &
          Partial<RevenueReportPayload> &
          Partial<JobCostReportPayload> &
          Partial<CreditDepositPayload> &
          Partial<CreditDrawReleasePayload> &
          Partial<CreditDrawRefundPayload> &
          Partial<CreditDrainPayload> &
          Partial<PayoutReportPayload> &
          Partial<CreditExpiryReleasePayload>;
        retry_count: number;
        created_at: string; // BIGINT — pg returns it as a string
        kind: ReportKind;
      }>(
        `SELECT id, payload, retry_count, created_at, kind FROM ${PENDING_DVM_REPORTS_TABLE}
         WHERE stale = false AND next_retry_at <= $1
         ORDER BY created_at LIMIT 10`,
        [Date.now()]
      );

      for (const row of rows) {
        const label = row.payload.jobId ?? row.payload.creditId ?? row.payload.payoutId ?? row.id;
        try {
          await this.attemptDelivery(row.id, row.payload, row.kind, label);
        } catch {
          const retryCount = row.retry_count + 1;
          // Bound the queue: after 24h of failed (5xx/transport) retries, retire the
          // row instead of retrying forever. 4xx rows are already terminal and never
          // reach here (attemptDelivery marks them stale without throwing).
          if (Date.now() - Number(row.created_at) >= RevenueReporter.ABANDON_AFTER_MS) {
            await this.markStale(row.id, "abandoned");
            diagnosticConsole.warn(
              {
                level: "revenue_reporter_abandoned",
                id: row.id,
                kind: row.kind,
                retryCount,
                dvmId: row.payload.dvmId,
                label,
                // A drain names its payout rail `method`; every other kind
                // carries `rail`. An abandoned row is the one place an
                // operator sees this payload at all, so don't log it blank.
                rail: row.payload.rail ?? row.payload.method,
              }
            );
            continue;
          }
          const backoff = Math.min(
            30_000 * Math.pow(2, retryCount - 1),
            RevenueReporter.MAX_BACKOFF_MS
          );
          await this.db.query(
            `UPDATE ${PENDING_DVM_REPORTS_TABLE}
             SET retry_count = $1, next_retry_at = $2
             WHERE id = $3`,
            [retryCount, Date.now() + backoff, row.id]
          );
        }
      }
    } catch (err) {
      diagnosticConsole.error("[revenue-reporter] Retry loop error:", err);
    }
  }

  private async enqueue(kind: ReportKind, payload: object, label: string): Promise<void> {
    if (kind === "payout" && this.hostedObligations) {
      const rail = (payload as Partial<PayoutReportPayload>).rail;
      if ((rail === "x402" || rail === "tempo") &&
        await this.hostedObligations.hasCompleteHistory()) {
        throw new Error("Hosted channel payout requires its original settlement obligation");
      }
    }
    const id = await this.insertPending(this.db, kind, payload);
    void this.attemptDelivery(id, payload, kind, label).catch(() => {
      // Failure is expected — the retry loop will pick it up
    });
  }

  private async insertPending(
    q: RevenueReporterQuerier,
    kind: ReportKind,
    payload: object
  ): Promise<string> {
    const id = randomUUID();
    await q.query(
      `INSERT INTO ${PENDING_DVM_REPORTS_TABLE} (id, payload, created_at, kind)
       VALUES ($1, $2, $3, $4)`,
      [id, JSON.stringify(payload), Date.now(), kind]
    );
    return id;
  }

  private async attemptDelivery(
    id: string,
    payload: object,
    kind: ReportKind,
    label: string
  ): Promise<void> {
    if (kind === "payout" && this.hostedObligations &&
      ((payload as Partial<PayoutReportPayload>).rail === "x402" ||
        (payload as Partial<PayoutReportPayload>).rail === "tempo")) {
      await this.hostedObligations.assertReportReady(id, payload as Record<string, unknown>);
    }
    const url = `${this.platformUrl}${ENDPOINTS[kind]}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.platformToken}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      // Transport-level failure (DNS, timeout, abort, TLS, connection refused).
      // The outer drainPending swallows the throw silently, so log here or
      // operators have no signal that delivery is dark.
      const reason = err instanceof Error ? err.message : String(err);
      diagnosticConsole.warn(
        `[revenue-reporter] delivery failed for ${id}: transport error (${reason}) — will retry`
      );
      throw err;
    }

    if (res.ok) {
      if (this.hostedObligations && kind === "payout") {
        const client = await this.db.connect();
        try {
          await client.query("BEGIN");
          const rail = (payload as Partial<PayoutReportPayload>).rail;
          const requireLinked = (rail === "x402" || rail === "tempo") &&
            await this.hostedObligations.hasCompleteHistory(client);
          await this.hostedObligations.acknowledgeDelivered(id, client, requireLinked);
          await client.query(`DELETE FROM ${PENDING_DVM_REPORTS_TABLE} WHERE id = $1`, [id]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      } else {
        await this.db.query(`DELETE FROM ${PENDING_DVM_REPORTS_TABLE} WHERE id = $1`, [id]);
      }
      diagnosticConsole.log(`[revenue-reporter] reported ${kind} ${label}`);
      return;
    }

    // The original revenue report can arrive after its refund. Preserve this dependency
    // failure in the durable retry queue; other client errors remain terminal.
    if (kind === "refund" && res.status === 409) {
      throw new Error("Original draw revenue has not arrived yet");
    }

    if (res.status === 401) {
      await this.markStale(id, "token_rotated");
      diagnosticConsole.warn(
        `[revenue-reporter] Report ${id} got 401 — marking stale (token likely rotated)`
      );
      return;
    }

    // Any other 4xx is a permanent client error: 400 (malformed payload) and 403
    // (token's DVM ≠ body's dvmId) can never succeed on retry. Mark stale and stop —
    // do not throw, or the retry loop would pointlessly bump retry_count on a dead row.
    if (res.status >= 400 && res.status < 500) {
      await this.markStale(id, `client_error:${res.status}`);
      diagnosticConsole.warn(
        `[revenue-reporter] Report ${id} got HTTP ${res.status} — marking stale (permanent client error, will not retry)`
      );
      return;
    }

    // 5xx (and any other non-2xx) is the legitimate transient-failure path — retry.
    diagnosticConsole.warn(`[revenue-reporter] delivery failed for ${id}: HTTP ${res.status} — will retry`);
    throw new Error(`Platform returned ${res.status}`);
  }

  private async markStale(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE ${PENDING_DVM_REPORTS_TABLE} SET stale = true, stale_reason = $1 WHERE id = $2`,
      [reason, id]
    );
  }
}
