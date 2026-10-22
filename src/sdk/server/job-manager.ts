import { callerDeadline, hasCallerDeadline } from "./job";
import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { PaidJobCompletion, PaymentMode } from "./payment-mode";
import type { DisposableCashuCommit } from "./disposable-cashu-store";
import { randomBytes } from "node:crypto";

import type { Pool } from "pg";

import type { LockPubkey } from "../../lib/cashu/lock-pubkey";
import type {
  ApprovalContent,
  CancelContent,
  Message,
  MessageType,
  PaymentContent,
  ResponseContent,
} from "../../lib/messages/types";
import { createMonotonicClock } from "../../lib/monotonic-clock";
import type { DrawFundingReceipt, JobReceipt, ReceiptCredit } from "../../lib/receipt";
import type {
  SignedRequestAudience,
  SignedRequestDomain,
} from "../../lib/signed-request-statement";
import type { X402Config } from "../../lib/x402/types";
import { loggers } from "../../observability/loggers";
import type { FxFetcher } from "../pricing/index";
import { fiatToSatsCeil, fxRateFor, parseUsdPrice, roundUsd } from "../pricing/index";
import { StepCache } from "../step-cache";
import type {
  CapabilityDescriptor,
  CashuMode,
  DVMDescriptor,
  KVStore,
  PaymentMethod,
  PriceValue,
  SDKJobContext,
  ZodLike,
} from "../types";
import { isZodSchema } from "../types";
import type { DrawPool } from "./context";
import { buildContext } from "./context";
import {
  CreditLedgerError,
  type CreditLedgerLike,
  type DrawRecord,
  type FundingRecord,
  isFundingRail,
  type StalePendingDrawCursor,
} from "./credit-ledger";
import { implicitCreditId } from "./funding";
import type { ServerJob } from "./job";
import {
  abortJob,
  fromJobRecord,
  isTerminal,
  JobCancelledError,
  localMessage,
  providerMessage,
  toJobRecord,
} from "./job";
import type {
  JobRecord,
  JobRetentionCursor,
  JobStatus,
  JobStore,
  PaymentCreditDelta,
  VerifyAndCreditResult,
} from "./job-store";
import {
  isJobRetentionStore,
  isReceiptIssuingStore,
  isStreamableJobStore,
} from "./job-store";
import { MemoryJobStore } from "./memory-job-store";
import { PostgresJobStore } from "./postgres-job-store";
import type { MintHealthTracker } from "./mint-health-tracker";
import type { MppxServer } from "./mpp-setup";
import type { CreditFundingReport, PaymentInfo, VerifiedIncomingPayment } from "./payment";
import {
  applyPaymentInfoToJob,
  creditDepositPayload,
  devModeSkipsPaymentVerification,
  hasPaymentProof,
  paymentErrorBody,
  verifyIncomingPayment,
} from "./payment";
import type { ProcessedPaymentStore } from "./processed-payment-store";
import { drawFundingReceiptFor } from "./funding-receipt";
import type { ReceiptIssuer } from "./receipt-issuer";
import { isReceiptableStatus } from "./receipt-issuer";
import { stripProtocolEnvelope } from "./request-envelope";
import type {
  CreditDepositEnqueue,
  CreditDepositPayload,
  CreditDrawReleaseEnqueue,
  JobCostReportPayload,
  JobTerminalReportPayload,
  RevenueSkippedNoRailPayload,
} from "./revenue-reporter";
import { type CanonicalEnvelope, SignedRequestError, signedRequestInput } from "./signed-request";
import {
  type AccumulatorMonitorHandle,
  startAccumulatorMonitor,
} from "./wallet-accumulator-monitor";
import type { X402ExactSettlementServer } from "./x402-exact-settlement";
import type { X402FacilitatorHealthLike } from "./x402-facilitator-support";

/**
 * Headroom added on top of `2 × idleTimeout` for the stale-job watchdog
 * default. Matches scrape's `JOB_TIMEOUT_MS` per-handler wall-
 * clock bound; builders whose handler bound exceeds this MUST override
 * `JobManagerOpts.staleJobTimeoutMs` or the watchdog will fire on a
 * legitimate in-flight handler.
 */
const STALE_JOB_WATCHDOG_HEADROOM_MS = 90_000;

/**
 * Default worker-liveness watchdog: a job in `processing`/`working`
 * whose persisted `last_activity_at` is older than this is treated as a dead
 * worker and marked `failed`. Safe to keep tight because the SDK heartbeats
 * locally-active jobs every `DEFAULT_HEARTBEAT_INTERVAL_MS`, so a live handler
 * never looks stale regardless of how long it legitimately runs. Override
 * per-DVM via `DVMConfig.processingWatchdog` (or `JobManagerOpts`).
 */
const DEFAULT_PROCESSING_WATCHDOG_MS = 5 * 60_000;

const TERMINAL_COST_RECOVERY_BATCH = 100;
const TERMINAL_COST_RECOVERY_MAX_PAGES = 10;
const TERMINAL_COST_RECOVERY_INTERVAL_MS = 30_000;

/**
 * Default interval at which the JobManager bumps `last_activity_at` for its
 * locally-active `processing`/`working` jobs. Must be comfortably
 * below `DEFAULT_PROCESSING_WATCHDOG_MS` so several ticks land inside one
 * watchdog window.
 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Grace window a reactivating machine waits for a live original
 * handler to claim an `awaiting-input` job (flip it to `processing` via its
 * NOTIFY wake) before replaying it itself. Comfortably above same-region
 * Postgres NOTIFY latency, so a healthy original worker wins the claim and
 * stays the single executor. If it's ever too tight, the fallback is a
 * reactivation replay — correct, just a wasteful double execution — not a
 * stuck job.
 */
const DEFAULT_REACTIVATION_CLAIM_GRACE_MS = 150;

/** Poll interval while waiting out the reactivation claim grace window. */
const REACTIVATION_CLAIM_POLL_MS = 25;

/**
 * Age at which a `pending` credit draw with no job row is treated as orphaned
 * The window it covers — draw commit → `persistJob` — is normally
 * milliseconds, so 15 minutes is a ~100× margin: no in-flight draw-then-persist
 * can be swept, and a caller whose submit crashed gets their balance back
 * within the quarter hour rather than never.
 */
const DEFAULT_ORPHAN_DRAW_AGE_MS = 15 * 60_000;

/**
 * Age at which a `pending` credit draw whose job row **is** terminal is
 * reconciled against that row's outcome. Deliberately wider than
 * {@link DEFAULT_ORPHAN_DRAW_AGE_MS}, for two reasons.
 *
 * It gates a `settle` — a real, irreversible debit — where the orphan arm only
 * ever releases, so the conservative direction is the other way round. And
 * every free in-line repair path has to have had its chance first:
 * `ensureReceipt` re-attempts the resolution on **every** read of a terminal
 * job, and the stale-job sweep's `issueReceiptForStoredJob` does the same on a
 * reap. Both are idempotent and both fix the receipt as well as the hold, so a
 * caller who polls once more repairs this for free; the reconciler exists for
 * the hold nobody ever came back for.
 */
const DEFAULT_TERMINAL_DRAW_RECONCILE_AGE_MS = 30 * 60_000;

/**
 * Sweep interval for the orphan-draw watchdog. Slack relative to
 * {@link DEFAULT_ORPHAN_DRAW_AGE_MS} is deliberate — orphans are crash debris,
 * not a steady-state flow, so the scan normally returns nothing.
 */
const DEFAULT_ORPHAN_DRAW_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Daily content-retention pass, matching the platform retention cron cadence. */
const DEFAULT_JOB_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;

/** Catch expired content even when an autostopped DVM wakes only briefly. */
const DEFAULT_JOB_RETENTION_BOOT_DELAY_MS = 30_000;

const JOB_RETENTION_SWEEP_BATCH = 50;

/** Bound one pass while retaining a keyset cursor for the next tick. */
const JOB_RETENTION_SWEEP_MAX_PAGES = 20;

const DAY_MS = 24 * 60 * 60_000;

/** Orphan candidates read per page, mirroring the stale-job batch. */
const ORPHAN_DRAW_SWEEP_BATCH = 50;

/**
 * Pages the orphan sweep will walk in one tick, bounding a tick to
 * {@link ORPHAN_DRAW_SWEEP_BATCH} × this many candidate reads. The scan skips
 * aged-but-legitimate holds — an `awaiting-input` job on a 30-minute idle
 * timeout keeps its hold `pending` well past the orphan cutoff — and those
 * rows stay at the head of the age ordering, so paging past them is what keeps
 * a real orphan from starving behind a wall of them. Hitting the cap logs
 * `orphan_draw_sweep_truncated` — a starved sweep must not look like a clean
 * one — and hands its cursor to the next tick, so the tail is reached rather
 * than re-skipped. Only a tick that runs the scan out restarts from the top,
 * which is how holds that have since crossed the age cutoff get seen.
 */
const ORPHAN_DRAW_SWEEP_MAX_PAGES = 20;

/**
 * An age cutoff no `created_at` can sit behind, so `listStalePendingDraws`
 * degrades to "the oldest `pending` hold, whatever its age". Used
 * only to tell an empty scan that is genuinely clean from one the age gate
 * has gone blind to.
 */
const ANY_DRAW_AGE_CUTOFF_MS = Number.MAX_SAFE_INTEGER;

/**
 * Ledgers already claimed by a running orphan-draw timer, so a
 * multi-mount host runs one sweeper rather than one per mount. `sweepStaleJobs`
 * sidesteps this by being capability-scoped; the orphan sweep can't be — a draw
 * carries no capability and the read is host-wide by construction. Duplicates
 * would be *safe* (`release` is idempotent) but every mount past the first
 * would log `orphan_draw_released` with `replayed: true` for the same hold on
 * every tick, indistinguishable from a real double-release. Keyed by ledger
 * instance because that is precisely what a host's mounts share — `host.ts`
 * hands one `creditLedger` to every `createDVMServer` call. `shutdown()`
 * returns the claim, so a re-boot in the same process sweeps again.
 */
const ORPHAN_SWEEP_CLAIMS = new WeakSet<CreditLedgerLike>();

/**
 * Rails a job's payment can attach on, and therefore the only rails an implicit
 * N=1 credit id can name. Narrower than the set `credits.rail` holds:
 * Lightning funds credits but never pays for a job, so a Lightning
 * credit is explicit by construction.
 */
const ATTACH_RAILS = ["cashu", "x402", "tempo"] as const satisfies readonly PaymentMethod[];

/**
 * Attempts Tx C gets before a mid-job payment is answered as unapplied
 * Small on purpose: the caller is holding an open HTTP request and
 * the exhausted path is itself a complete answer — it names the credit the
 * money landed on — so a longer ladder buys a slower failure, not a better one.
 */
export const CREDIT_INBOUND_ATTEMPTS = 3;

/** Base backoff between Tx C attempts, multiplied by the attempt number. */
const CREDIT_INBOUND_BACKOFF_MS = 50;
const TERMINAL_COST_HANDOFF_RETRY_INITIAL_MS = 100;
const TERMINAL_COST_HANDOFF_RETRY_MAX_MS = 30_000;

/**
 * Attempts the post-exhaustion read-back gets, on the same backoff.
 *
 * The read is the last word on whether the money landed, and the pool it runs
 * on is the one that just failed `CREDIT_INBOUND_ATTEMPTS` COMMITs — often
 * because a single checked-out connection went bad, which a second attempt
 * clears by drawing a fresh one. Reading once and giving up would answer
 * "nothing landed" on the strength of a read that never reached the row.
 */
export const CREDIT_INBOUND_READ_ATTEMPTS = 2;

export interface JobManagerOpts {
  env: Record<string, string>;
  store: KVStore;
  mints?: string[];
  /** Durable in production; defaults to memory only in development/test mode. */
  jobStore?: JobStore;
  /** Skips payment only when no payment rail is configured. Wired rails still verify. */
  devMode?: boolean;
  /** Payment methods this DVM accepts. Default: derived by the server from configured rails. */
  paymentMethods?: PaymentMethod[];
  x402?: X402Config;
  /** Durable exact-settlement coordinator shared with upfront verification. */
  x402ExactSettlement?: X402ExactSettlementServer;
  /** Live facilitator capabilities for version-specific mid-job payment handling. */
  x402FacilitatorHealth?: X402FacilitatorHealthLike;

  mpp?: MppxServer;

  cashuMode?: CashuMode;
  /** Builder's NUT-11 P2PK lock pubkey. Required for accumulator mode. */
  lockPubkey?: string;
  /** Test-only atomic Cashu backend, supplied by the development host. */
  disposableCashu?: DisposableCashuCommit;
  /** Postgres pool for wallet accumulator persistence. */
  db?: Pool;
  /**
   * Agent-wallet: per-DVM identifier used for the scheduler advisory
   * lock and the `(dvm_id, request_id)` replay key. Defaults to `DVMKIT_DVM_ID`
   * env at boot in `createDVMHost()`.
   */
  dvmId?: string;
  /** Audience expected by persisted v2 caller statements. */
  authAudience?: SignedRequestAudience;
  /**
   * Shared fx fetcher used to convert USD-string descriptor prices and
   * fiat-form `requestPayment` calls into sats. The SDK server owns
   * one per process so concurrent quotes share the 60s cache window.
   */
  fxFetcher: FxFetcher;
  /**
   * Signs a receipt at every terminal transition. Absent when the
   * DVM has no receipt key wired — jobs then terminate exactly as before and
   * `/v1/info` doesn't advertise `receipts`.
   */
  receiptIssuer?: ReceiptIssuer;
  /**
   * Credit ledger for the terminal funnel: a job carrying a
   * `creditId`/`drawId` settles its draw on success and releases it on
   * failure/cancel — this is how "no debit on job failure" is mechanically
   * real. The resolution runs before receipt issuance so the receipt's
   * `credit` block countersigns the post-resolution balance.
   */
  creditLedger?: CreditLedgerLike;
  /**
   * Durable processed-payment markers, threaded through to the
   * mid-job top-up path so an x402/mpp payment's marker, `fund`, and
   * `growDraw` commit together.
   */
  processedPayments?: ProcessedPaymentStore;
  /**
   * Reporter-owned transactional deposit enqueue threaded into mid-job rail
   * commits.
   */
  enqueueCreditDeposit?: CreditDepositEnqueue;
  /** Reporter outbox inserted atomically with a terminal draw release. */
  enqueueCreditDrawRelease?: CreditDrawReleaseEnqueue;
  /** Credit lifetime a top-up mints with, from the DVM's advertised `credit.ttl`. */
  creditTtlMs?: number;
  /**
   * The DVM's declared pricing currency, which is the currency of
   * every credit it opens. Threaded into the job context so a mid-job ask on a
   * job that holds no credit yet is still pinned in the denomination its first
   * payment will open the credit in. `DVMServer` passes its resolved
   * `pricingCurrency`; a host building a `JobManager` directly falls back to the
   * descriptor, and then to `"usd"`.
   */
  pricingCurrency?: string;
  /**
   * Callback fired when a mid-job top-up moves money onto a credit.
   * The platform books it as a **deposit** — a liability until drawn, never
   * summed into revenue — so a top-up that skipped this would leave the
   * outstanding-liability view short. Mirrors `DVMServer.reportCreditDeposit`,
   * which handles the upfront and `/v1/credit` legs.
   */
  onCreditFunded?: (info: CreditDepositPayload) => void | Promise<void>;
  /**
   * Callback fired when a paid job completes. Container-runtime DVMs
   * use this to report revenue to the platform via `RevenueReporter`. Mirrors
   * the isolate path's `IsolateJobManager.opts.onJobCompleted`.
   */
  onPaidJobCompleted?: (event: PaidJobCompletion) => void | Promise<void>;
  paymentMode?: PaymentMode;
  onJobCompleted?: (info: {
    dvmId: string;
    jobId: string;
    /** Dispatched capability. Omitted only for legacy persisted jobs that predate dispatch. */
    capability?: string;
    paidMsats: number;
    paymentMint?: string;
    rail: string;
    paymentTxHash?: string;
    nativeAmount?: number;
    nativeAsset?: string;
    cashuFlow?: string;
    cost?: { amountMicro: number; currency: string };
    creditId?: string;
    drawId?: string;
    drawAmountMicro?: number;
    creditCurrency?: string;
    settledAt?: number;
    fundingRef?: string;
    kind?: string;
  }) => void | Promise<void>;
  /**
   * Callback fired when a terminal job declared a builder cost but emitted no
   * revenue report. Container-runtime DVMs use the reporter's
   * durable `job-cost` outbox path. The receiver de-duplicates by DVM + job,
   * independently of the rail-keyed revenue ledger.
   */
  onJobCost?: (info: JobCostReportPayload) => void | Promise<void>;
  /** SDK-owned hosted terminal outbox callback. */
  onJobTerminal?: (info: JobTerminalReportPayload) => Promise<void>;
  /**
   * Callback fired when the stale-job reaper force-fails a *paid* job — its
   * pending credit draw is released rather than settled, because only a
   * completed job settles a draw. Container-runtime DVMs wire this
   * to a paid-job-death report → operator `notice`. Never fires for
   * free jobs (`paidMsats === 0`). Fired fire-and-forget so a throw or a slow
   * report can't wedge the sweep.
   */
  onPaidJobDeath?: (info: {
    dvmId: string;
    jobId: string;
    capability: string;
    paidMsats: number;
    rail: string;
    reason: "worker_died_mid_job" | "stale_no_terminal_status";
    nativeAmount?: number;
    nativeAsset?: string;
    paymentMint?: string;
  }) => void | Promise<void>;
  /**
   * Callback fired when a settled credit draw cannot book a revenue event
   * because no usable payment rail is available. Container-runtime
   * DVMs auto-wire this to the platform's deduped operator notice. Fired
   * fire-and-forget so alert delivery cannot block terminal handling or draw
   * reconciliation.
   */
  onRevenueSkippedNoRail?: (info: RevenueSkippedNoRailPayload) => void | Promise<void>;
  /**
   * Awaiting-input age in milliseconds before cancellation. Defaults to
   * twice descriptor.idleTimeout (seconds), converted to milliseconds, plus
   * STALE_JOB_WATCHDOG_HEADROOM_MS. Set to 0 to disable this arm; processing
   * jobs use processingWatchdogMs.
   */
  staleJobTimeoutMs?: number;
  /**
   * Sweep interval for the stale-job watchdog. Default: `min(60s, max(15s,
   * tightestActiveTimeout / 4))`. Tests override to fire deterministically.
   */
  staleJobSweepIntervalMs?: number;
  /**
   * Worker-liveness watchdog in ms. Jobs in `processing`/`working`
   * whose `lastActivityAt` is older than this are marked `failed` (dead
   * worker), separately from the longer `awaiting-input` idle timeout above.
   * Default: `descriptor.processingWatchdog * 1000` or
   * `DEFAULT_PROCESSING_WATCHDOG_MS`. Set to `0` to disable (test seam).
   */
  processingWatchdogMs?: number;
  /**
   * Interval at which locally-active `processing`/`working` jobs have their
   * `lastActivityAt` bumped so the processing watchdog only fires on a truly
   * dead worker. Default: `DEFAULT_HEARTBEAT_INTERVAL_MS`. Set to
   * `0` to disable (test seam). Also floors how far the clock guard
   * may compensate a backwards step on the processing arm — a cadence close to
   * `processingWatchdogMs` leaves it no room and it compensates nothing.
   */
  heartbeatIntervalMs?: number;
  /**
   * Age in ms at which a `pending` credit draw whose `job_id` matches no row in
   * the job store is released as orphaned. The draw commits before
   * the job row is persisted, so a crash or a fail-closed refusal in that
   * window strands a hold no terminal path can ever reach. Must stay
   * comfortably above the submit path's draw→persist latency. Set to `0` to
   * disable the watchdog entirely — stranded holds then stay stranded, so
   * treat it as a money knob, not a tuning one. Default:
   * {@link DEFAULT_ORPHAN_DRAW_AGE_MS}.
   */
  orphanDrawAgeMs?: number;
  /**
   * Age in ms at which a `pending` credit draw whose job row **is** terminal is
   * reconciled against that row's outcome — settled for a
   * `completed` job, released for a `failed`/`cancelled` one. Covers the hole
   * `orphanDrawAgeMs` cannot: `resolveCreditDraw` throwing on a ledger error
   * leaves a terminal job whose hold no later path retries.
   *
   * Rides the same scan as the orphan arm, which has two consequences for the
   * value you set here. Setting `orphanDrawAgeMs` to `0` disables this arm too.
   * And the effective gate is `max(orphanDrawAgeMs, terminalDrawReconcileAgeMs)`
   * the scan never returns a row younger than its own cutoff, so anything
   * below `orphanDrawAgeMs` is silently clamped up to it. That floor is
   * deliberate rather than a wart: honouring a narrower value would mean
   * widening the scan, which hands the orphan arm rows younger than
   * `orphanDrawAgeMs` that it must not release. It can only ever delay a
   * settle, never advance one, which is the safe direction for a debit.
   *
   * Set to `0` to disable this arm alone — a money knob, not a tuning one.
   * Default: {@link DEFAULT_TERMINAL_DRAW_RECONCILE_AGE_MS}.
   */
  terminalDrawReconcileAgeMs?: number;
  /**
   * Sweep interval for the orphan-draw watchdog. Default:
   * {@link DEFAULT_ORPHAN_DRAW_SWEEP_INTERVAL_MS}. Set to `0` to disable — the
   * test seam, since suites drive `sweepOrphanDraws()` directly.
   */
  orphanDrawSweepIntervalMs?: number;
  /** Retention sweep cadence. Default: daily; `0` disables the interval. */
  jobRetentionSweepIntervalMs?: number;
  /** Delay before the first retention pass. Default: 30s; `0` disables it. */
  jobRetentionSweepBootDelayMs?: number;
  /** Operator-alert boundary invoked whenever a retention pass fails. */
  onJobRetentionSweepFailed?: (info: {
    dvmId: string;
    dvmName: string;
    retentionDays: number;
    error: string;
  }) => void | Promise<void>;
  /** Clear-on-recovery boundary invoked after every complete, clean pass. */
  onJobRetentionSweepRecovered?: (info: {
    dvmId: string;
    dvmName: string;
    retentionDays: number;
    examined: number;
    redacted: number;
  }) => void | Promise<void>;
  /**
   * Grace window in ms a reactivating machine waits for a live original handler
   * to win the single-execution claim before replaying an `awaiting-input` job
   * itself. Default: `DEFAULT_REACTIVATION_CLAIM_GRACE_MS`. Widen if
   * cross-machine NOTIFY latency causes spurious double executions; lower in
   * tests for speed.
   */
  reactivationClaimGraceMs?: number;
}

type ResolvedInput<I extends ZodLike | undefined> = I extends ZodLike<infer O> ? O : string;

/**
 * A deposit this payment funded that the job row did **not** take.
 *
 * Reached when two mid-job top-ups race on a free-then-paid job: each opens its
 * own implicit credit, and `verifyAndCredit`'s set-if-null bind keeps one. The
 * loser's money is real, owned by the caller, and reclaimable — but nothing
 * named it, so the caller would have to derive `imp:<rail>:<payment_id>` to
 * reach their own balance. This rides the 201 so they don't have to.
 *
 * The response is the fast surface, not the only one: the credit is opened
 * under the caller's verified pubkey, so `POST /v1/credit` op `balance` lists
 * it and op `drain` reclaims it once the hold resolves.
 */
export interface UnappliedCredit {
  credit_id: string;
  credited_micro: number;
  credit_currency: string;
  display: string;
  hint: string;
}

/**
 * What {@link JobManager.processPayment} tells the route. `error` is a refusal
 * to serialise verbatim; otherwise the payment was accepted, optionally
 * carrying an {@link UnappliedCredit} to fold into the 201.
 */
export type ProcessPaymentOutcome =
  | {
      error: { body: Record<string, unknown>; status: number };
      unappliedCredit?: undefined;
      drawFundingReceipt?: undefined;
    }
  | {
      error?: undefined;
      unappliedCredit?: UnappliedCredit;
      /**
       * Signed evidence that this payment funded the job's credit against its
       * pending draw. Absent when the payment ran ledger-less, opened a fresh
       * credit, or the DVM has no receipt key.
       */
      drawFundingReceipt?: DrawFundingReceipt;
    };

/**
 * What `bookRevenue` reads off a job. Structural rather than `ServerJob` or
 * `JobRecord` so both satisfy it: the in-line funnel books from the live job it
 * just terminated, the reconciler from the row its sweep read.
 */
type RevenueBookableJob = Pick<
  JobRecord,
  | "id"
  | "capability"
  | "status"
  | "paidMsats"
  | "paymentMint"
  | "paymentRail"
  | "paymentTxHash"
  | "nativeAmount"
  | "nativeAsset"
  | "cashuFlow"
  | "costAmountMicro"
  | "costCurrency"
  | "costRevision"
  | "creditId"
  | "drawId"
>;

/** Postgres-only surface that closes the terminal-row-to-cost-outbox crash window. */
interface TerminalCostRecoveryStore extends JobStore {
  saveForDvm(record: JobRecord, dvmId: string): Promise<void>;
  listUnreportedTerminalCosts(args: {
    dvmId: string;
    limit: number;
    afterJobId?: string;
  }): Promise<JobRecord[]>;
  markTerminalCostReported(jobId: string, costRevision: number): Promise<boolean>;
}

function isTerminalCostRecoveryStore(store: JobStore): store is TerminalCostRecoveryStore {
  return (
    "saveForDvm" in store &&
    "listUnreportedTerminalCosts" in store &&
    "markTerminalCostReported" in store
  );
}

/**
 * Transport-agnostic job lifecycle manager.
 *
 * Handles job creation, handler invocation, message dispatch, persistence,
 * idle timeout, and durable replay. Shared by both the HTTP server and
 * relay provider.
 */
export class JobManager<State, InputSchema extends ZodLike | undefined> {
  private readonly descriptor: DVMDescriptor<State, InputSchema>;
  private readonly opts: JobManagerOpts;
  private readonly _activeJobs = new Map<string, ServerJob>();
  private readonly jobStore: JobStore;
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Cost revisions held only by a terminal handler owner until its durable merge succeeds. */
  private readonly terminalCostHandoffRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  /** Per-job NOTIFY unsubscribe handles for the durable-status watch. */
  private readonly statusWatchers = new Map<string, () => void>();
  /** Job ids whose durable-status re-read is in flight — coalesces notify storms. */
  private readonly statusChecksInFlight = new Set<string>();
  /** Job ids that were notified mid-re-read and must be re-checked. */
  private readonly statusChecksQueued = new Set<string>();
  // Bind live resolvers and recovery scaffolds to the store-allocated ask identity.
  private readonly paymentAskSeqs = new WeakMap<object, number>();
  private readonly reactivationAskSeqs = new WeakMap<ServerJob, number>();

  // Every local input resume holds this queue through its durable wait update.
  // A prompt response and a payment NOTIFY must not mistake each other for a
  // different machine's successful claim.
  private readonly inputResumeTails = new WeakMap<ServerJob, Promise<unknown>>();
  // A failed partial-wait snapshot leaves our durable claim in processing.
  // Retain its continuation so a later input can finish it without a new claim.
  private readonly claimedPaymentResumes = new WeakMap<ServerJob, () => Promise<void>>();
  private readonly sessionId = randomBytes(3).toString("hex");
  private nextJobId = 1;
  private accumulatorMonitor?: AccumulatorMonitorHandle;
  private readonly staleJobTimeoutMs: number;
  private readonly processingWatchdogMs: number;
  private readonly reactivationClaimGraceMs: number;
  /**
   * Worker-heartbeat cadence. Also floors the clock
   * guard's compensation on the processing arm — see
   * {@link staleSweepCompensationCapMs}.
   */
  private readonly heartbeatIntervalMs: number;
  private readonly orphanDrawAgeMs: number;
  private readonly terminalDrawReconcileAgeMs: number;
  private staleSweepTimer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private orphanDrawSweepTimer?: ReturnType<typeof setInterval>;
  private terminalCostRecoveryTimer?: ReturnType<typeof setInterval>;
  private jobRetentionSweepTimer?: ReturnType<typeof setInterval>;
  private jobRetentionBootTimer?: ReturnType<typeof setTimeout>;
  /** This manager holds {@link ORPHAN_SWEEP_CLAIMS} for its ledger. */
  private orphanSweepClaimed = false;
  /** Where a page-capped tick left off; cleared once a tick reaches the end. */
  private orphanSweepResumeFrom?: StalePendingDrawCursor;
  private jobRetentionResumeFrom?: JobRetentionCursor;
  /**
   * A `Date.now()` reading that cannot regress within this manager's lifetime
   * Anchored at construction, so a manager already running when
   * the clock stepped is covered. The stale-job sweep's two cutoffs, the
   * orphan-draw age gate and the reactivation claim grace all read it; see
   * {@link createMonotonicClock} for what it costs and where it is clamped.
   */
  private readonly monotonicNowMs = createMonotonicClock();
  private sweepInFlight = false;
  private orphanSweepInFlight = false;
  private terminalCostRecoveryInFlight = false;
  private terminalCostRecoveryResumeAfter?: string;
  private jobRetentionSweepInFlight = false;
  private heartbeatInFlight = false;
  /**
   * The denomination of every credit this DVM opens. Resolved once,
   * with the same boundary fallback `DVMServer` applies for direct JavaScript
   * callers that force an incomplete value past the descriptor contract.
   */
  private readonly pricingCurrency: string;

  constructor(descriptor: DVMDescriptor<State, InputSchema>, opts: JobManagerOpts) {
    this.descriptor = descriptor;
    this.opts = opts;
    this.pricingCurrency =
      opts.pricingCurrency ?? (descriptor.currency as string | undefined) ?? "usd";
    // mirror the host's boot guard (host.ts:218-225). A missing
    // jobStore silently regressing to MemoryJobStore is the wiring-drift bug
    // class V20 set out to retire — only the documented dev/test escape
    // hatches may fall back to the in-memory store.
    if (opts.jobStore) {
      this.jobStore = opts.jobStore;
    } else if (opts.devMode || process.env.NODE_ENV === "test") {
      this.jobStore = new MemoryJobStore();
    } else {
      throw new Error(
        "JobManager requires a persistent jobStore in production. Pass `jobStore` " +
          "explicitly, set `devMode: true`, or construct via createDVMHost (which boots " +
          "a PostgresJobStore from DATABASE_URL)."
      );
    }

    // a receipt key is only half of what issuance needs — the store
    // has to own the sequence allocation and the write-once persist too.
    // `jobStore` is a public `DVMHostOpts` option, so a builder can wire a
    // custom store that satisfies `JobStore` but not `ReceiptIssuingStore`.
    // Say so at boot rather than letting every job terminate receipt-less
    // while `/v1/info` keeps its promise (which `receiptsEnabled` also
    // withholds in that case).
    if (opts.receiptIssuer && !isReceiptIssuingStore(this.jobStore)) {
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "receipts_disabled_store_unsupported",
          message:
            undefined,
        }
      );
    }

    // Start the agent-wallet accumulator monitor when accumulator
    // persistence is wired. The monitor emits expiry events only; melting
    // runs builder-local via `dvmctl melt-pending`.
    if (opts.cashuMode === "p2pk-accumulator" && opts.db && opts.dvmId) {
      try {
        this.accumulatorMonitor = startAccumulatorMonitor({
          pool: opts.db,
          dvmId: opts.dvmId,
        });
      } catch (_err) {
        diagnosticConsole.error(
          {
            level: "wallet_accumulator_monitor_start_failed",
            error: undefined,
          }
        );
      }
    }

    // Stale-job watchdog. The in-process idle timer is a
    // per-process backstop — process death, OOM, or a silent `messageAppender`
    // failure leaves the DB row stuck with no terminal status ever landing.
    // Sweep the persistent store on a tick with two status-aware thresholds:
    // • `awaiting-input` rows past `staleJobTimeoutMs` → `cancelled` (the
    // caller never paid / responded — the original behaviour).
    // • `processing`/`working` rows past `processingWatchdogMs` → `failed`
    // (the worker died mid-job). Kept tight because the heartbeat below
    // refreshes live workers' `lastActivityAt`, so only a dead process
    // lets the row go stale and exposes the stranded job to the watchdog.
    this.staleJobTimeoutMs =
      opts.staleJobTimeoutMs ?? 2 * descriptor.idleTimeout * 1000 + STALE_JOB_WATCHDOG_HEADROOM_MS;
    this.processingWatchdogMs =
      opts.processingWatchdogMs ??
      (descriptor.processingWatchdog !== undefined
        ? descriptor.processingWatchdog * 1000
        : DEFAULT_PROCESSING_WATCHDOG_MS);
    this.reactivationClaimGraceMs =
      opts.reactivationClaimGraceMs ?? DEFAULT_REACTIVATION_CLAIM_GRACE_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const sweepActive = this.staleJobTimeoutMs > 0 || this.processingWatchdogMs > 0;
    if (sweepActive && isStreamableJobStore(this.jobStore)) {
      const tightest = Math.min(
        this.processingWatchdogMs > 0 ? this.processingWatchdogMs : Infinity,
        this.staleJobTimeoutMs > 0 ? this.staleJobTimeoutMs : Infinity
      );
      const intervalMs =
        opts.staleJobSweepIntervalMs ??
        Math.min(60_000, Math.max(15_000, Math.floor(tightest / 4)));
      this.staleSweepTimer = setInterval(() => {
        void this.sweepStaleJobs().catch((_err: unknown) => {
          diagnosticConsole.error(
            {
              level: "stale_job_sweep_failed",
              error: undefined,
            }
          );
        });
      }, intervalMs);
      this.staleSweepTimer.unref();

      // Worker heartbeat: refresh `lastActivityAt` for jobs this
      // process is actively running so the processing watchdog only fires once
      // the process is genuinely gone. The timer dies with the process, so a
      // crashed/OOM-killed worker stops refreshing and the row goes stale.
      if (this.processingWatchdogMs > 0 && this.heartbeatIntervalMs > 0) {
        this.heartbeatTimer = setInterval(() => {
          void this.heartbeatActiveJobs().catch((_err: unknown) => {
            diagnosticConsole.error(
              {
                level: "job_heartbeat_failed",
                error: undefined,
              }
            );
          });
        }, this.heartbeatIntervalMs);
        this.heartbeatTimer.unref();
      }
    }

    // Orphan-draw watchdog. The stale-job sweep above only reaches
    // holds whose job row exists; a draw commits with its `job_id` *before*
    // `persistJob` writes that row, so a crash or a fail-closed refusal in
    // between strands a hold with no terminal path to it at all — the release
    // keys off the `creditId`/`drawId` persisted on the job. Runs on the
    // memory ledger too: an in-process `replay_detected` 401 strands a hold
    // just the same.
    //
    // the same scan carries a second arm for the mirror-image hole —
    // a hold whose job row *did* land and reached terminal, but whose in-line
    // resolution threw. Same timer, same cursor, same one-sweeper-per-ledger
    // claim; only the per-row decision differs.
    this.orphanDrawAgeMs = opts.orphanDrawAgeMs ?? DEFAULT_ORPHAN_DRAW_AGE_MS;
    this.terminalDrawReconcileAgeMs =
      opts.terminalDrawReconcileAgeMs ?? DEFAULT_TERMINAL_DRAW_RECONCILE_AGE_MS;
    const orphanIntervalMs =
      opts.orphanDrawSweepIntervalMs ?? DEFAULT_ORPHAN_DRAW_SWEEP_INTERVAL_MS;
    if (
      opts.creditLedger &&
      orphanIntervalMs > 0 &&
      this.orphanDrawAgeMs > 0 &&
      !ORPHAN_SWEEP_CLAIMS.has(opts.creditLedger)
    ) {
      // One sweeper per ledger, not per mount — see ORPHAN_SWEEP_CLAIMS.
      ORPHAN_SWEEP_CLAIMS.add(opts.creditLedger);
      this.orphanSweepClaimed = true;
      this.orphanDrawSweepTimer = setInterval(() => {
        void this.sweepOrphanDraws().catch((_err: unknown) => {
          diagnosticConsole.error(
            {
              level: "orphan_draw_sweep_failed",
              error: undefined,
            }
          );
        });
      }, orphanIntervalMs);
      this.orphanDrawSweepTimer.unref();
    }

    // Terminal job content retention. The row itself survives so receipts,
    // payment reconciliation, and durable request-id bindings keep their
    // referent; only caller-controlled and replay-only material is redacted.
    // A boot pass matters for scale-to-zero DVMs that may never stay awake for
    // a daily interval. Custom stores can opt out by omitting the retention
    // surface, which is made loud at boot.
    if (descriptor.jobRetentionDays > 0) {
      if (!isJobRetentionStore(this.jobStore)) {
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "job_retention_store_unsupported",
            dvm: descriptor.name,
            retentionDays: descriptor.jobRetentionDays,
          }
        );
      } else {
        const pass = (): void => {
          void this.sweepJobRetention().catch(() => undefined);
        };
        const bootDelayMs = opts.jobRetentionSweepBootDelayMs ?? DEFAULT_JOB_RETENTION_BOOT_DELAY_MS;
        if (bootDelayMs > 0) {
          this.jobRetentionBootTimer = setTimeout(pass, bootDelayMs);
          this.jobRetentionBootTimer.unref();
        }
        const intervalMs =
          opts.jobRetentionSweepIntervalMs ?? DEFAULT_JOB_RETENTION_SWEEP_INTERVAL_MS;
        if (intervalMs > 0) {
          this.jobRetentionSweepTimer = setInterval(pass, intervalMs);
          this.jobRetentionSweepTimer.unref();
        }
      }
    }

    // A terminal job row and its cost-only outbox row cannot share a
    // transaction: the job store is also a public/custom seam. Postgres rows
    // therefore retain an enqueue marker, and every live sibling retries the
    // bounded gap scan. createDVMServer also awaits one pass before boot
    // completes, so scale-to-zero restarts do not wait for this interval.
    if (opts.dvmId && (opts.onJobCost || opts.onJobTerminal) && isTerminalCostRecoveryStore(this.jobStore)) {
      this.terminalCostRecoveryTimer = setInterval(() => {
        void this.recoverTerminalCosts().catch((_err: unknown) => {
          diagnosticConsole.error(
            {
              level: "terminal_cost_recovery_failed",
              error: undefined,
            }
          );
        });
      }, TERMINAL_COST_RECOVERY_INTERVAL_MS);
      this.terminalCostRecoveryTimer.unref();
    }
  }

  get activeJobs(): Map<string, ServerJob> {
    return this._activeJobs;
  }

  get store(): JobStore {
    return this.jobStore;
  }

  /**
   * True when this DVM will actually issue receipts — a key *and*
   * a store that can allocate sequence numbers and persist bytes write-once.
   * `/v1/info#receipts` reads this rather than the key alone, so the flag can
   * never promise something `issueReceipt` silently declines to do.
   */
  get receiptsEnabled(): boolean {
    return this.opts.receiptIssuer !== undefined && isReceiptIssuingStore(this.jobStore);
  }

  hasCapability(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.descriptor.capabilities, name);
  }

  capabilityNames(): string[] {
    return Object.keys(this.descriptor.capabilities);
  }

  /**
   * Resolve a capability's static `price` to msats.
   *
   * `"$X.XX"` is parsed as USD and converted via the SDK's shared fx fetcher.
   * Returns `undefined` for dynamic-priced capabilities (those that declare
   * `onQuote`) — the caller falls back to `computeDynamicPrice` in that path.
   */
  async currentPriceMsats(capability: string): Promise<number | undefined> {
    const cap = this.requireCapability(capability);
    if (cap.price === undefined) return undefined;
    return resolveStaticPriceMsats(cap.price, this.opts.fxFetcher);
  }

  /**
   * Translate a capability's static `price` into the fiat envelope used by
   * the per-capability `pricing.max` advertised on `/v1/info`.
   * Returns `undefined` for dynamic-priced capabilities and for unknown
   * names (the route handler validates the name before invoking this).
   */
  currentPricingMax(capability: string): { amount: number; currency: string } | undefined {
    const cap = this.getCapability(capability);
    if (!cap) return undefined;
    return resolvePricingMax(cap.price);
  }

  /**
   * Parse a request body through a capability's input schema.
   *
   * Resolution order when a capability declares an `input` schema:
   * 1. `body.data` is preferred — agents pass structured fields directly
   * (CLI builds this from `--param k=v`).
   * 2. Fallback: `JSON.parse(body.input)` for clients still on the legacy
   * JSON-string contract.
   * 3. Neither usable → throw `MissingStructuredInputError` so the route can
   * return `invalid_input` with a hint pointing at `/v1/info`.
   *
   * When the capability has no `input` schema, returns `body.input` raw
   * (primitive path).
   *
   * The credit envelope is removed before the schema runs, on both
   * branches — it rides the signed body but is protocol-level, so a
   * top-level `.strict()` capability schema would otherwise reject every
   * explicit draw as an unknown key, before the envelope was even extracted.
   * The persisted `record.input` the reactivation path re-reads is the
   * pre-Zod wire form, so it comes through the second branch carrying them too.
   */
  parseInput(body: { input?: string; data?: unknown }, capability: string): unknown {
    const cap = this.requireCapability(capability);
    const rawSchema: unknown = cap.input;
    if (!rawSchema || !isZodSchema(rawSchema)) return body.input ?? "";
    const schema = rawSchema;
    if (body.data !== undefined) {
      return schema.parse(stripProtocolEnvelope(schema, body.data));
    }
    if (typeof body.input === "string" && body.input.length > 0) {
      const json: unknown = JSON.parse(body.input);
      return schema.parse(stripProtocolEnvelope(schema, json));
    }
    throw new MissingStructuredInputError();
  }

  /**
   * Look up the per-capability descriptor by name. Throws when the
   * name doesn't exist — the route layer validates body.capability first, so
   * reaching this with an unknown name is a programmer error.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private requireCapability(name: string): CapabilityDescriptor<any, any> {
    const cap = this.getCapability(name);
    if (!cap) {
      throw new Error(
        `JobManager: capability "${name}" is not defined on descriptor "${this.descriptor.name}"`
      );
    }
    return cap;
  }

  /**
   * Soft capability lookup — `undefined` when the name isn't defined. The
   * single place the `descriptor.capabilities` index cast lives; callers that
   * tolerate a missing capability (the route layer pre-validates, or the cap
   * was deleted from the descriptor after a job was persisted) route through
   * here instead of re-casting inline.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getCapability(name: string): CapabilityDescriptor<any, any> | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.descriptor.capabilities[name] as CapabilityDescriptor<any, any> | undefined;
  }

  /**
   * Allocate the id the next job will be created under. The
   * submit path calls this BEFORE payment verification so the ledger draw
   * commits with its job linkage, then passes the id back through
   * `createJob`'s provenance. Ids allocated for requests whose payment is
   * refused are simply never used — the sequence has gaps, which nothing
   * reads meaning into.
   */
  allocateJobId(): string {
    return `job-${this.sessionId}-${this.nextJobId++}`;
  }

  /**
   * Create a new job from a request body. `provenance` is what the
   * idempotent-replay path on `POST /v1/job` reads back: the raw `job_token`
   * to re-issue, and the fingerprint + caller pubkey a retry must reproduce
   * to be given it.
   */
  createJob(
    body: { input: string; params?: Record<string, string> },
    requesterId: string,
    payment: PaymentInfo,
    requiredMsats: number | undefined,
    capability: string,
    requesterTokenHash?: string,
    provenance?: {
      requesterToken?: string;
      requestFingerprint?: string;
      requesterPubkey?: string;
      requestId?: string;
      authRequestPath?: string;
      /**
       * Pre-allocated id from {@link allocateJobId} — the submit
       * path allocates before payment verification so the ledger draw can
       * record the job it pays for.
       */
      jobId?: string;
    }
  ): ServerJob {
    const cap = this.requireCapability(capability);
    const id = provenance?.jobId ?? this.allocateJobId();
    const now = Date.now();
    const job: ServerJob = {
      id,
      tags: this.descriptor.tags,
      capability,
      input: body.input,
      params: body.params ?? {},
      requesterId,
      requesterTokenHash,
      requesterToken: provenance?.requesterToken,
      requestFingerprint: provenance?.requestFingerprint,
      requesterPubkey: provenance?.requesterPubkey,
      requestId: provenance?.requestId,
      authRequestPath: provenance?.authRequestPath,
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: payment.paidMsats,
      paymentMint: payment.paymentMint,
      paymentRail: payment.paymentRail,
      paymentTxHash: payment.paymentTxHash,
      paymentTransactionHash: payment.paymentTransactionHash,
      nativeAmount: payment.nativeAmount,
      nativeAsset: payment.nativeAsset,
      cashuFlow: payment.cashuFlow,
      creditId: payment.creditId,
      drawId: payment.drawId,
      fundingReceipt: payment.fundingReceipt,
      fundingCredit: payment.fundingCredit,
      receivedProofs: payment.receivedProofs,
      requiredMsats,
      listeners: new Set(),
      abort: new AbortController(),
      stepCache: new StepCache(),
      state: structuredClone(cap.state),
      pendingPrompts: new Map(),
      pendingPayment: null,
      replayHighSeq: null,
      replayProviderSkip: 0,
      replayPaymentIndex: 0,
      createdAt: now,
      lastActivityAt: now,
    };
    this._activeJobs.set(id, job);
    this.wireMessageAppender(job);
    this.watchDurableStatus(job);
    return job;
  }

  buildAndAttachContext(
    job: ServerJob,
    parsedInput: unknown
  ): SDKJobContext<State, ResolvedInput<InputSchema>> {
    const auth = deriveAuthFromParsedInput(this.descriptor, parsedInput);
    const sdkCtx = buildContext(job, { ...this.buildContextOpts(job), parsedInput, auth });
    job.sdkCtx = sdkCtx;
    return sdkCtx as SDKJobContext<State, ResolvedInput<InputSchema>>;
  }

  runHandler(job: ServerJob, sdkCtx: SDKJobContext<unknown, unknown>): void {
    // `descriptor.capabilities` is typed as a dense `Record`, but a job
    // persisted before its capability was deleted from the descriptor would
    // land here with no matching entry. Fail it explicitly rather than letting
    // a NoMethodError leak out of onJob.
    const cap = this.getCapability(job.capability);
    const onError = (err: unknown): void => {
      if (isTerminal(job.status)) return;
      job.replayProviderSkip = 0; // stop suppressing so cancel message emits
      job.status = "failed";
      providerMessage(job, "cancel", {
        reason: err instanceof Error ? err.message : String(err),
      });
      // An uncaught handler throw is a terminal like any other:
      // it gets a receipt, and the row gets persisted here rather than
      // waiting for the crash watchdog to notice a `processing` row whose
      // handler is long gone.
      job.terminalWork = this.finalizeTerminal(job);
      void job.terminalWork;
    };
    if (!cap) {
      // A missing capability is unrecoverable — the handler can never run.
      // No handler exists to resume any pending prompt or payment yield.
      if (!isTerminal(job.status)) {
        const reason = `Unknown capability "${job.capability}" on descriptor "${this.descriptor.name}"`;
        job.replayProviderSkip = 0; // stop suppressing so the cancel message emits
        for (const [, p] of job.pendingPrompts) p.reject(new Error(reason));
        if (job.pendingPayment) job.pendingPayment.reject(new Error(reason));
        job.pendingPrompts.clear();
        job.pendingPayment = null;
        job.status = "failed";
        providerMessage(job, "cancel", { reason });
        job.terminalWork = this.finalizeTerminal(job);
        void job.terminalWork;
      }
      return;
    }
    try {
      const result = loggers.isolate.span(
        "dvm.handler",
        { handler: "job", job_id: job.id, capability: job.capability },
        () => cap.onJob(sdkCtx)
      );
      void result.catch(onError);
    } catch (err) {
      onError(err);
    }
  }

  async dispatchMessage(job: ServerJob, type: MessageType, content: unknown): Promise<void> {
    if (type !== "response" && type !== "payment") {
      return this.dispatchMessageNow(job, type, content);
    }
    // A partial response reopens the durable wait before the next response
    // claims it. Cancellation must remain able to interrupt a blocked claim.
    const pending = type === "payment"
      ? job.pendingPayment
      : job.pendingPrompts.get((content as ResponseContent).prompt_id);
    await this.queueInputResume(job, async () => {
      // A NOTIFY wake or an earlier dispatch may have consumed this input
      // while it queued. It must not fall through to an event handler.
      const current = type === "payment"
        ? job.pendingPayment
        : job.pendingPrompts.get((content as ResponseContent).prompt_id);
      if (pending && current !== pending) return;
      return this.dispatchMessageNow(job, type, content);
    });
  }

  private async queueInputResume<T>(job: ServerJob, resume: () => Promise<T>): Promise<T> {
    const previous = this.inputResumeTails.get(job) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await this.claimedPaymentResumes.get(job)?.();
      return resume();
    });
    this.inputResumeTails.set(job, next);
    try {
      return await next;
    } finally {
      if (this.inputResumeTails.get(job) === next) this.inputResumeTails.delete(job);
    }
  }

  private async claimLocalInput(job: ServerJob): Promise<boolean> {
    await job.messageAppenderTail;
    const askSeq = job.pendingPayment ? this.paymentAskSeqs.get(job.pendingPayment) : undefined;
    // A failed ask append cannot borrow satisfaction from the preceding ask.
    if (job.pendingPayment && this.opts.db && this.jobStore instanceof PostgresJobStore && askSeq === undefined) return false;
    return this.claimInputForAsk(job.id, askSeq);
  }

  private async claimInputForAsk(jobId: string, askSeq: number | undefined): Promise<boolean> {
    if (!isStreamableJobStore(this.jobStore)) return true;
    if (askSeq === undefined || !this.opts.db || !(this.jobStore instanceof PostgresJobStore)) return this.jobStore.claimForProcessing(jobId);
    const tx = await this.opts.db.connect();
    try {
      await tx.query("BEGIN");
      const { rows: [record] } = await tx.query("SELECT status FROM jobs WHERE id=$1 FOR UPDATE", [jobId]);
      const { rows: [ask] } = await tx.query(
        `SELECT MAX(seq) AS seq FROM job_messages WHERE job_id=$1 AND status='verified'
         AND data->>'from'='provider' AND data->>'type'='payment-request'`, [jobId]);
      if (record?.status !== "awaiting-input" || Number(ask?.seq) !== askSeq) {
        await tx.query("ROLLBACK");
        return false;
      }
      await tx.query(
        `UPDATE jobs SET status='processing', last_activity_at=$2,
         caller_wait_ms=caller_wait_ms+GREATEST(0,$2-COALESCE(awaiting_input_at_ms,last_activity_at)),
         awaiting_input_at_ms=NULL WHERE id=$1`, [jobId, Date.now()]);
      await tx.query("COMMIT");
      return true;
    } catch (error) {
      await tx.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { tx.release(); }
  }

  private async adoptPaymentMetadata(job: ServerJob, pending: ServerJob["pendingPayment"]): Promise<boolean> {
    const record = await this.jobStore.get(job.id);
    if (!record || job.pendingPayment !== pending || isTerminal(job.status) || isTerminal(record.status)) return false;
    job.paidMsats = record.paidMsats;
    job.pendingPaymentMsats = record.pendingPaymentMsats;
    job.creditId = record.creditId;
    job.drawId = record.drawId;
    job.paymentRail = record.paymentRail;
    job.paymentMint = record.paymentMint;
    job.paymentTxHash = record.paymentTxHash;
    job.nativeAmount = record.nativeAmount;
    job.nativeAsset = record.nativeAsset;
    job.pendingPaymentFiatMicro = record.pendingPaymentFiatMicro;
    job.pendingPaymentFiatCurrency = record.pendingPaymentFiatCurrency;
    job.pendingMppChallengeIds = record.pendingMppChallengeIds;
    job.pendingX402Nonce = record.pendingX402Nonce;
    job.pendingX402AmountUsdcMicro = record.pendingX402AmountUsdcMicro;
    return true;
  }

  private async resumeClaimedPayment(job: ServerJob, resume: () => Promise<void>): Promise<void> {
    const retry = async (): Promise<void> => {
      try {
        if (!isTerminal(job.status) && !(await this.adoptDurableTerminal(job))) await resume();
        this.claimedPaymentResumes.delete(job);
      } catch (error) {
        if (!(error instanceof JobSnapshotPersistenceError)) this.claimedPaymentResumes.delete(job);
        throw error;
      }
    };
    this.claimedPaymentResumes.set(job, retry);
    await retry();
  }

  private async dispatchMessageNow(job: ServerJob, type: MessageType, content: unknown): Promise<void> {
    const ctx = job.sdkCtx;
    const cap = this.getCapability(job.capability);

    if (type === "response") {
      const rc = content as ResponseContent;
      const pending = job.pendingPrompts.get(rc.prompt_id);
      if (pending) {
        if (!(await this.claimLocalInput(job))) {
          await this.adoptDurableTerminal(job);
          return;
        }
        if (job.pendingPrompts.get(rc.prompt_id) !== pending || isTerminal(job.status)) return;
        job.pendingPrompts.delete(rc.prompt_id);
        job.status =
          job.pendingPrompts.size > 0 || job.pendingPayment ? "awaiting-input" : "processing";
        if (job.status === "awaiting-input") await this.persistJob(job);
        this.startIdleTimer(job);
        pending.resolve(rc);
      } else if (cap?.onResponse && ctx) {
        this.startIdleTimer(job);
        await cap.onResponse(ctx, rc);
      }
    } else if (type === "payment") {
      const pc = content as PaymentContent;
      if (job.pendingPayment) {
        const pp = job.pendingPayment;
        if (!(await this.claimLocalInput(job))) {
          await this.adoptDurableTerminal(job);
          return;
        }
        if (job.pendingPayment !== pp || isTerminal(job.status)) return;
        await this.resumeClaimedPayment(job, async () => {
          job.status = job.pendingPrompts.size > 0 ? "awaiting-input" : "processing";
          // Keep the paid wait reachable until the remaining prompt wait is
          // durable. Retry only this snapshot while holding the local resume queue.
          if (job.status === "awaiting-input") await retryJobSnapshot(() => this.persistJob(job));
          if (job.pendingPayment !== pp || isTerminal(job.status)) return;
          job.pendingPayment = null;
          await pp.resolve(pc);
        });
      } else if (cap?.onPayment && ctx) {
        this.startIdleTimer(job);
        await cap.onPayment(ctx, pc);
      }
    } else if (type === "approval" && cap?.onApproval && ctx) {
      await cap.onApproval(ctx, content as ApprovalContent);
    } else if (type === "cancel") {
      const reason = (content as CancelContent | undefined)?.reason ?? "Job cancelled";
      // Signal the running handler *first* so it stops burning provider spend on
      // work the caller just cancelled. `ctx.fetch` carries this signal, so an
      // in-flight provider call aborts; builders can thread `ctx.signal` into
      // anything else they own. Hoisted above `onCancel`: a
      // cleanup hook that does network I/O would otherwise hold the abort back
      // for exactly as long as it runs — the window the spend keeps flowing in.
      abortJob(job, reason);
      // Terminal *before* the hook. `onCancel` is a cleanup hook —
      // release a lock, delete a staged upload — and the terminal guard makes
      // its `ctx` emits no-op warnings. That has to hold on both machines: the
      // machine adopting a remote cancel cannot let the hook emit (the durable
      // log is closed and its `job_messages` rows are already swept), so if this
      // path let it, a builder emitting from `onCancel` would see it work in dev
      // and silently vanish on a multi-machine deploy. Closing it here also
      // shuts the last hole: an `onCancel` calling `ctx.complete()` was
      // still able to resurrect the cancelled job as `completed` and book
      // revenue on it.
      job.endedBy = "caller";
      job.status = "cancelled";
      if (cap?.onCancel && ctx) {
        await cap.onCancel(ctx, content as CancelContent);
      }
      for (const [, p] of job.pendingPrompts) p.reject(new JobCancelledError("Job cancelled"));
      if (job.pendingPayment) job.pendingPayment.reject(new JobCancelledError("Job cancelled"));
      // Clear the resolver maps, not just reject them: a `response`
      // for an already-rejected prompt would otherwise still match in
      // `dispatchMessage` above and flip the job back to `processing`.
      job.pendingPrompts.clear();
      job.pendingPayment = null;
      this.clearIdleTimer(job.id);
      // The DELETE route dispatches straight here without persisting, so
      // without this the `cancelled` status would live only in `activeJobs` —
      // the store would still read `processing` and the stale sweeper would
      // eventually flip the row to `failed`. folds receipt issuance
      // into the same step: a cancelled job is attestable too, and a caller
      // who paid and then cancelled needs the evidence as much as one whose
      // job succeeded.
      await this.finalizeTerminal(job);
      this.scheduleCleanup(job);
    } else if (cap?.onMessage && ctx) {
      await cap.onMessage(ctx, {
        type,
        content: content as Record<string, unknown>,
      });
    }
  }

  /**
   * Persist a job to the backing store.
   *
   * Awaits the per-job appender tail so that:
   * 1. The snapshot's `messages` is consistent with the `job_messages` table
   * no row is still in flight at snapshot time.
   * 2. For terminal saves, the `DELETE FROM job_messages` inside `save()`
   * can't race a still-pending `appendOutgoing` for the final yield
   * message (which would otherwise wipe the row before an in-flight SSE
   * subscriber's NOTIFY-driven fetch can see it).
   */
  async persistJob(job: ServerJob): Promise<void> {
    if (job.messageAppenderTail) {
      await job.messageAppenderTail.catch(() => undefined);
    }
    if (await this.adoptDurableTerminal(job)) return;
    const record = toJobRecord(job);
    if (isTerminal(job.status) && isStreamableJobStore(this.jobStore)) {
      // rebuild the terminal snapshot from the durable `job_messages`
      // log so it carries DB-allocated seqs and every durably-recorded message
      // including a caller message a *different* machine recorded via Tx B,
      // which never entered this process's in-memory `job.messages` array. Two
      // counters (in-memory `job.seq`, DB `next_seq`) only agree when one
      // machine drives the whole job; the durable log is the single
      // authoritative numbering. The appender tail is drained above, so the log
      // is complete and is a superset of `job.messages` by content.
      //
      // Guard: if the durable read returns FEWER messages than the in-memory
      // array — a rolled-back `appendOutgoing` (DB outage, already logged as
      // `job_message_append_failed`) or an unverified/rejected inbound this
      // machine still holds in memory — keep the in-memory snapshot rather than
      // wipe durably-absent messages. `getMessages` filters `status='verified'`,
      // so accepted cross-machine caller messages are included and rejected ones
      // stay out.
      const durable = await this.jobStore.getMessages(job.id, 0);
      if (durable.length >= record.messages.length) {
        record.messages = durable;
        const highSeq = durable.length ? durable[durable.length - 1].seq : record.seq;
        // Keep `jobs.seq` monotonic (save uses GREATEST) and realign
        // `next_seq - 1` with the surviving array length for forensics.
        record.seq = Math.max(record.seq, highSeq);
      }
    }
    try {
      if (this.opts.dvmId && isTerminalCostRecoveryStore(this.jobStore)) {
        await this.jobStore.saveForDvm(record, this.opts.dvmId);
      } else {
        await this.jobStore.save(record);
      }
    } catch (error) {
      throw new JobSnapshotPersistenceError(error);
    }
    const saved = await this.jobStore.get(job.id);
    if (saved) {
      job.timingKnown = saved.timingKnown;
      job.endedBy = saved.endedBy;
      job.terminalAtMs = saved.terminalAtMs;
      job.callerWaitMs = saved.callerWaitMs;
      job.awaitingInputAtMs = saved.awaitingInputAtMs;
    }
  }

  /**
   * Cross-machine terminal guard. `buildContext`'s guard reads the
   * in-memory `job.status`, so on its own it only protects the machine running
   * the handler. On a multi-machine DVM a `DELETE /v1/job/:id` routinely lands
   * on a machine that isn't running the job — `app.ts` cancels it in the store
   * and this process learns of it only through the durable row.
   *
   * Adopting the durable status blocks the rest of the handler's writes via the
   * local guard, makes `handleJobTerminal` see a non-completed job so it skips
   * the revenue report, rejects a suspended handler's prompt/payment yields, and
   * fires `job.abort` so in-flight `ctx.fetch` calls tear down. Returns true when
   * the durable state won and the caller must skip its save.
   *
   * Two triggers: `watchDurableStatus`'s NOTIFY subscription fires
   * this within a round-trip of the remote cancel committing, which is what
   * actually stops the provider spend; `persistJob` calls it again on every save
   * as the backstop for the window where a cancel commits between a handler's
   * read and its write (the check-then-write it can still lose is covered by the
   * stores' terminal-sticky `save`, which keeps the row itself correct).
   */
  private async adoptDurableTerminal(job: ServerJob): Promise<boolean> {
    const counters = isStreamableJobStore(this.jobStore)
      ? await this.jobStore.getCounters(job.id).catch(() => undefined)
      : await this.jobStore.get(job.id).catch(() => undefined);
    if (!counters || !isTerminal(counters.status) || counters.status === job.status) return false;
    const durable = await this.jobStore.get(job.id);
    if (!durable) return false;

    diagnosticConsole.warn(
      {
        level: "job_terminal_elsewhere",
        jobId: job.id,
        durableStatus: durable.status,
        localStatus: job.status,
      }
    );
    job.status = durable.status;
    // Adopt the whole terminal row, not just its status. The stores' sticky
    // `save` admits a same-status re-save, so a `persistJob` after this point
    // would otherwise write `summary = NULL` over the caller's cancel reason.
    job.summary = durable.summary;
    job.timingKnown = durable.timingKnown;
    job.endedBy = durable.endedBy;
    job.terminalAtMs = durable.terminalAtMs;
    job.callerWaitMs = durable.callerWaitMs;
    job.awaitingInputAtMs = durable.awaitingInputAtMs;
    // `cancelJob` / `cancelStaleJob` record why they terminated the job in
    // `summary`, so the caller's own words reach `ctx.signal.reason` and the
    // `onCancel` hook instead of a generic "Job cancelled". A
    // `completed` summary is the handler's completion text, not a reason.
    const reason =
      durable.status !== "completed" && durable.summary ? durable.summary : `Job ${durable.status}`;
    for (const [, p] of job.pendingPrompts) p.reject(new JobCancelledError(reason));
    job.pendingPayment?.reject(new JobCancelledError(reason));
    job.pendingPrompts.clear();
    job.pendingPayment = null;
    abortJob(job, reason);
    // The terminal writer can only know the last persisted cost snapshot.
    // `ctx.cost()` is intentionally in-memory until the next yield, so merge
    // the handler owner's fresher revision immediately after stopping its work.
    // The report remains later: if this process exits between the two,
    // terminal-cost recovery finds the owner's complete declaration rather
    // than the remote writer's stale prefix. A remotely completed job is
    // excluded because its normal completion path carries cost with revenue.
    const terminalCostPersisted =
      durable.status === "completed" ? true : await this.tryPersistAdoptedTerminalCost(job, 1);
    // Materialise the terminal `cancel` the other machine wrote. The
    // job stays in `activeJobs` for the cleanup window, and every local read
    // path serves from memory — a GET returns `job.messages`, a fresh SSE stream
    // replays it and closes on the yield, and an SSE stream opened *before* the
    // cancel only closes when a yield reaches `job.listeners`. Without this, a
    // caller whose poll happens to land on the handler's own machine can't see
    // the cancel that every other machine serves from the durable log. Pushed
    // locally rather than re-emitted: the row is already in the durable log
    // (`terminateJob` wrote it in the same transaction as the status), and its
    // `job_messages` rows may already have been swept by the terminal cleanup.
    // `completed` is excluded — its durable terminal is a `complete`, not a
    // `cancel`, and it can only be adopted from a machine that reactivated and
    // finished the job itself.
    if (durable.status !== "completed") {
      localMessage(job, "provider", "cancel", { reason });
    }
    // Run the builder's cleanup hook on the machine that actually holds the
    // resources. Before the NOTIFY watch, `onCancel` only ever fired
    // on whichever machine the DELETE happened to land on — so a handler holding
    // a lock, a staged upload, or a browser session elsewhere never got to
    // release it. Cancelled-only: a `failed` status adopted from the stale-job
    // sweeper is not a cancel. Fire-and-forget, and after `abortJob` — a hook
    // that does network I/O must not hold the abort back. Like the
    // local path (`dispatchMessage`), it runs against an already-terminal job,
    // so its `ctx` emits are no-op warnings.
    const cap = this.getCapability(job.capability);
    if (durable.status === "cancelled" && cap?.onCancel && job.sdkCtx) {
      const ctx = job.sdkCtx;
      const onCancel = cap.onCancel;
      void Promise.resolve(onCancel(ctx, { reason })).catch((err: unknown) => {
        diagnosticConsole.error(`[${job.id}] onCancel hook failed after cross-machine cancel:`, err);
      });
    }
    this.clearIdleTimer(job.id);
    // whichever machine gets there first issues the receipt — the one
    // that wrote the terminal (`app.ts`'s store-only cancel) or this one
    // adopting it. Both read the committed row and both go through the store's
    // write-once persist, so the loser gets the winner's bytes rather than a
    // second signature.
    void this.issueReceiptForStoredJob(job.id).then(() => this.reportTerminalJob(job.id));
    this.scheduleCleanup(job);
    if (durable.status !== "completed" && terminalCostPersisted) {
      await this.reportJobCost(job);
    }
    return true;
  }

  /**
   * Persist an adopted terminal cost, retaining the in-memory revision for a
   * later retry when the durable store is transiently unavailable.
   */
  private async tryPersistAdoptedTerminalCost(job: ServerJob, attempt: number): Promise<boolean> {
    try {
      await this.persistAdoptedTerminalCost(job);
      return true;
    } catch (err) {
      this.scheduleTerminalCostHandoffRetry(job, attempt, err);
      return false;
    }
  }

  /** Retry outside the status watcher, which correctly stops once the job is terminal. */
  private scheduleTerminalCostHandoffRetry(
    job: ServerJob,
    attempt: number,
    _err: unknown
  ): void {
    if (this.terminalCostHandoffRetryTimers.has(job.id)) return;
    const delayMs = Math.min(
      TERMINAL_COST_HANDOFF_RETRY_INITIAL_MS * 2 ** Math.min(attempt - 1, 8),
      TERMINAL_COST_HANDOFF_RETRY_MAX_MS
    );
    diagnosticConsole.error(
      {
        level: "terminal_cost_handoff_retry_scheduled",
        jobId: job.id,
        attempt,
        delayMs,
        error: undefined,
      }
    );
    const timer = setTimeout(() => {
      this.terminalCostHandoffRetryTimers.delete(job.id);
      void this.retryTerminalCostHandoff(job, attempt + 1);
    }, delayMs);
    timer.unref();
    this.terminalCostHandoffRetryTimers.set(job.id, timer);
  }

  private async retryTerminalCostHandoff(job: ServerJob, attempt: number): Promise<void> {
    if (!(await this.tryPersistAdoptedTerminalCost(job, attempt))) return;
    await this.reportJobCost(job);
    await this.reportTerminalJob(job.id);
  }

  /** Durably merge a terminal handler owner's latest cost before reporting it. */
  private async persistAdoptedTerminalCost(job: ServerJob): Promise<void> {
    const dvmId = this.opts.dvmId;
    const localRevision = job.costRevision;
    if (
      localRevision === undefined ||
      !dvmId ||
      !isTerminalCostRecoveryStore(this.jobStore)
    ) {
      return;
    }

    // Start from the terminal writer's committed snapshot so this cost-only
    // merge cannot replace its reason, message log, or other terminal fields
    // with the handler owner's stale in-memory copy.
    const durable = await this.jobStore.get(job.id);
    if (!durable || durable.status !== job.status) {
      throw new Error(`Terminal cost merge lost durable job ${job.id}`);
    }

    // Another owner may already have persisted a later declaration. Mirror it
    // locally for the immediate report; the store's revision-aware upsert also
    // protects the read/save race from regression.
    if ((durable.costRevision ?? -1) > localRevision) {
      job.costAmountMicro = durable.costAmountMicro;
      job.costCurrency = durable.costCurrency;
      job.costRevision = durable.costRevision;
      return;
    }

    await this.jobStore.saveForDvm(
      {
        ...durable,
        costAmountMicro: job.costAmountMicro,
        costCurrency: job.costCurrency,
        costRevision: localRevision,
      },
      dvmId
    );
  }

  /**
   * Watch the durable status of a locally-active job.
   *
   * `ctx.signal` is raised by `dispatchMessage`, which only runs on the machine
   * holding the job in `activeJobs`. On a multi-machine DVM the `DELETE` usually
   * lands somewhere else, and that machine's store-only cancel (`cancelJob`)
   * commits the terminal status, appends the `cancel` message, and `pg_notify`s
   * in one transaction. This subscription is how the handler's machine hears it:
   * on each notify, re-read the durable status and adopt it if it went terminal.
   * Without it, the handler only notices at its next store write, and the
   * in-flight provider call — the spend the cancel was meant to stop — runs to
   * completion.
   *
   * Every locally-emitted message notifies this machine too, so the re-read is
   * coalesced: at most one `getCounters` in flight per job, and none once the
   * job is locally terminal.
   */
  private watchDurableStatus(job: ServerJob): void {
    if (!isStreamableJobStore(this.jobStore)) return;
    const store = this.jobStore;
    const jobId = job.id;
    // Placeholder so an `unwatchDurableStatus` racing the subscribe below still
    // sees the job as watched, and the resolved handle is dropped on arrival.
    this.statusWatchers.set(jobId, () => undefined);
    void store
      .subscribeNotifications(jobId, () => {
        void this.checkDurableTerminal(job);
      })
      .then((unsubscribe) => {
        if (!this.statusWatchers.has(jobId)) {
          unsubscribe();
          return;
        }
        this.statusWatchers.set(jobId, unsubscribe);
      })
      .catch((_err: unknown) => {
        diagnosticConsole.error(
          {
            level: "job_status_watch_subscribe_failed",
            jobId,
            error: undefined,
          }
        );
        this.statusWatchers.delete(jobId);
      });
  }

  /**
   * Tear down a job's durable-status subscription. Must be called
   * wherever a job leaves `activeJobs` — a leaked subscriber outlives the job on
   * the store's shared LISTEN connection. Idempotent.
   */
  unwatchDurableStatus(jobId: string): void {
    const unsubscribe = this.statusWatchers.get(jobId);
    if (!unsubscribe) return;
    this.statusWatchers.delete(jobId);
    this.statusChecksQueued.delete(jobId);
    unsubscribe();
  }

  /**
   * NOTIFY-driven durable-status re-read, coalesced per job.
   *
   * A notify that arrives while a re-read is in flight is queued rather than
   * dropped: the in-flight read may have observed the row a moment *before* the
   * cancel committed, and dropping its notify would leave the local handler
   * running until its next store write instead of aborting promptly.
   */
  private async checkDurableTerminal(job: ServerJob): Promise<void> {
    if (this.statusChecksInFlight.has(job.id)) {
      this.statusChecksQueued.add(job.id);
      return;
    }
    this.statusChecksInFlight.add(job.id);
    try {
      do {
        this.statusChecksQueued.delete(job.id);
        if (isTerminal(job.status)) return;
        if (await this.adoptDurableTerminal(job)) return;
      } while (this.statusChecksQueued.has(job.id));
    } catch (_err) {
      diagnosticConsole.error(
        {
          level: "job_status_watch_check_failed",
          jobId: job.id,
          error: undefined,
        }
      );
    } finally {
      this.statusChecksInFlight.delete(job.id);
      this.statusChecksQueued.delete(job.id);
    }
  }

  /**
   * Wire the Tx A appender when the store supports streaming.
   *
   * Tx A: outgoing message + `pending_payment_msats` bump land in
   * the same transaction. The DB allocates the row's seq via
   * `UPDATE jobs SET next_seq = next_seq + 1 RETURNING` so concurrent inbound
   * traffic on different machines can never collide on the `(job_id, seq)` PK.
   * In-memory `job.seq` keeps its own counter for same-machine SSE listeners.
   *
   * Per-job serialisation: chained through `job.messageAppenderTail`
   * so two synchronous `providerMessage` calls (e.g. `artifact` followed by
   * `complete`) commit their `appendOutgoing` transactions in call order.
   * Without this, the two transactions race for the `jobs` row lock and the
   * DB-side seq can be allocated in the opposite order — which both renumbers
   * the persisted messages and reorders the NOTIFY events feeding the
   * cross-machine SSE subscriber. The subscriber closes the stream on the
   * first yield message it sees, so a NOTIFY for `complete` arriving before
   * `artifact`'s NOTIFY silently drops the artifact.
   */
  private wireMessageAppender(job: ServerJob): void {
    if (!isStreamableJobStore(this.jobStore)) return;
    const store = this.jobStore;
    const jobId = job.id;
    job.messageAppender = (msg, opts) => {
      const prev = job.messageAppenderTail ?? Promise.resolve();
      const next = prev.then(() => {
        const pending = job.pendingPayment;
        return store
          .appendOutgoing(
            jobId,
            {
              from: msg.from,
              type: msg.type,
              timestamp: msg.timestamp,
              content: msg.content,
            },
            opts
          )
          .then((stored) => {
            if (msg.type === "payment-request" && pending && job.pendingPayment === pending) {
              this.paymentAskSeqs.set(pending, stored);
            }
          })
          .catch((_err: unknown) => {
            diagnosticConsole.error(
              {
                level: "job_message_append_failed",
                jobId,
                // In-memory counter, NOT the authoritative DB-allocated seq:
                // `appendOutgoing` allocates the real seq via `UPDATE ...
                // RETURNING` inside the transaction that just failed, so no DB
                // seq was assigned for this message.
                localSeq: msg.seq,
                note: undefined,
                error: undefined,
              }
            );
          });
      });
      job.messageAppenderTail = next;
    };
  }

  startIdleTimer(job: ServerJob, deadline = callerDeadline(job, this.descriptor.idleTimeout * 1000)): void {
    this.clearIdleTimer(job.id);
    if (deadline === undefined) return;
    const timeoutMs = Math.min(2_147_483_647, Math.max(0, deadline - Date.now()));
    const timer = setTimeout(() => {
      void this.cancelJobIdle(job).catch(() => undefined);
    }, timeoutMs);
    this.idleTimers.set(job.id, timer);
  }

  clearIdleTimer(id: string): void {
    const timer = this.idleTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(id);
    }
  }

  /** Cancel a job due to idle timeout. Exposed for the reactivation path's idle-expiry guard. */
  async cancelJobIdle(job: ServerJob): Promise<void> {
    if (isTerminal(job.status)) return;

    // re-check the persisted status before mutating local state or
    // writing the cancel snapshot. Another machine may have driven the job to
    // terminal via Tx C (cross-machine credit + reactivation) while our idle
    // timer was ticking; `persistJob` would otherwise clobber the winner's
    // paid_msats / status / messages from our stale local view, and the
    // `providerMessage("cancel", …)` call would inject a phantom Tx A cancel
    // into the cross-machine stream.
    const current = await this.jobStore.get(job.id);
    if (current && isTerminal(current.status)) {
      const reason = `Job reached terminal status "${current.status}" elsewhere`;
      for (const [, p] of job.pendingPrompts) p.reject(new Error(reason));
      if (job.pendingPayment) job.pendingPayment.reject(new Error(reason));
      job.pendingPrompts.clear();
      job.pendingPayment = null;
      job.status = current.status;
      abortJob(job, reason);
      this.scheduleCleanup(job);
      return;
    }

    const waiting = current ?? job;
    if (current && isStreamableJobStore(this.jobStore)) {
      const messages = await this.jobStore.getMessages(job.id, 0);
      if (messages.length) waiting.messages = messages;
    }
    const deadline = callerDeadline(waiting, this.descriptor.idleTimeout * 1000);
    if (deadline === undefined) {
      this.clearIdleTimer(job.id);
      return;
    }
    if (Date.now() < deadline) {
      this.startIdleTimer(job, deadline);
      return;
    }
    if (current && isStreamableJobStore(this.jobStore)) {
      const claimed = await this.jobStore.cancelStaleJob(job.id, current.lastActivityAt, "Job timed out (idle)", "cancelled");
      if (claimed) await this.finalizeStoredTerminal(job.id);
      await this.adoptDurableTerminal(job);
      if (!claimed && !isTerminal(job.status)) this.startIdleTimer(job, Date.now() + 1);
      return;
    }

    for (const [, p] of job.pendingPrompts) p.reject(new Error("Job timed out (idle)"));
    if (job.pendingPayment) job.pendingPayment.reject(new Error("Job timed out (idle)"));
    job.pendingPrompts.clear();
    job.pendingPayment = null;

    job.endedBy = "caller";
    job.status = "cancelled";
    abortJob(job, "Job timed out (idle)");
    providerMessage(job, "cancel", { reason: "Job timed out (idle)" });
    job.terminalWork = this.finalizeTerminal(job);
    void job.terminalWork;
    this.scheduleCleanup(job);
  }

  /**
   * Force-terminate stale non-terminal jobs. Two status-aware arms:
   * • `awaiting-input` past `staleJobTimeoutMs` → `cancelled`
   * (`stale_no_terminal_status`) — the caller never paid / responded.
   * • `processing`/`working` past `processingWatchdogMs` → `failed`
   * (`worker_died_mid_job`) — the worker died mid-job. Before claiming a
   * processing row, skip and heartbeat it if this manager still holds a live
   * `processing`/`working` job. After a process pause, the sweep may run before
   * the heartbeat timer; stale activity alone does not prove a local worker
   * died. Superseded handlers leave `_activeJobs` and receive no protection.
   *
   * Fires on a timer (wired in the constructor) and also callable on demand
   * (tests, ops). The CAS in `cancelStaleJob` makes this safe to run
   * concurrently from multiple DVM machines. Scoped to capabilities this
   * JobManager owns so multi-mount hosts don't steal stuck rows from sibling
   * descriptors — the local activeJobs teardown only makes sense on the
   * JobManager that actually hosted the zombie handler.
   * Local liveness prevents this manager's claim; the activity CAS continues
   * to protect against other machines claiming a row refreshed after find.
   *
   * **Both cutoffs float off the wall clock.** Each is one
   * `Date.now()` sample compared against `last_activity_at`, stamped from a
   * different sample at a different moment, so a backwards step between the
   * two makes every row look more recently active than it is: the query
   * matches nothing and both arms go silent for the length of the skew. The
   * dead worker's job keeps its `processing` status, its credit hold stays
   * `pending`, and the paid-job-death alert — wired to this reaper —
   * never fires. Same defect, same host class, as orphan sweep.
   *
   * **The compensation is capped** — see {@link staleSweepCompensationCapMs}
   * for where each arm's cap comes from — which did not need to do. Its eagerness costs at worst an early release
   * of an unclaimed hold, refused outright for any live job row; ours
   * force-*fails* a running job. `cancelStaleJob`'s CAS does not cover that:
   * `expectedActivityBefore` is the same compensated threshold the query used,
   * and a live worker's post-step heartbeat writes the low, post-step
   * `Date.now()`, so `last_activity_at <= expectedActivityBefore` still holds.
   * The CAS guards a job checking in *between* the find and the claim with a
   * stamp above the cutoff — a race, not a clock.
   *
   * **Some blindness is inherent, and no cap choice removes it.** A backwards
   * step of `S` inverts the stamp ordering: everything stamped after it reads
   * `S` older than everything stamped before. A live worker heartbeating right
   * now stamps `wall - S`; a job genuinely idle for `age` stamps `wall - age`.
   * The stale row is the lower of the two — the one a cutoff reaches first —
   * only once `age` exceeds `S`. Below that the reaper cannot tell them apart,
   * so any cutoff that claimed the stale job would force-fail every live
   * worker on the host with it. The cap picks where on that curve to sit: on
   * the defaults a row must have been silent for `S + window / 2`, and a live
   * worker keeps five missed heartbeats of margin. The
   * alternative to a missed reap is mild and self-healing — the orphan sweep
   * backstops the hold, and the arm recovers when the wall catches up. The
   * alternative to a false reap is an irreversible force-fail of paid work.
   *
   * The stamps themselves stay wall-clock epoch-ms on purpose — they are
   * written by whichever machine touched the job and read by every other one,
   * so only the reading side can float.
   */
  async sweepStaleJobs(): Promise<{ swept: number }> {
    if (!isStreamableJobStore(this.jobStore)) return { swept: 0 };
    if (this.sweepInFlight) return { swept: 0 };
    this.sweepInFlight = true;
    try {
      // One non-regressing reading for the whole tick, and the wall beside it.
      // Order matters: `monotonicNowMs` reads the wall itself, so sampling it
      // afterwards keeps an untroubled clock at exactly zero skew rather than
      // the millisecond that would put a diagnostic line on every tick.
      const monoNow = this.monotonicNowMs();
      const now = Date.now();
      const skewMs = Math.max(0, monoNow - now);
      const processingCompensationMs = Math.min(
        skewMs,
        this.staleSweepCompensationCapMs(this.processingWatchdogMs, true)
      );
      const awaitingCompensationMs = Math.min(
        skewMs,
        this.staleSweepCompensationCapMs(this.staleJobTimeoutMs, false)
      );
      // A negative cutoff disables that arm (timeout set to 0).
      const processingThreshold =
        this.processingWatchdogMs > 0
          ? now + processingCompensationMs - this.processingWatchdogMs
          : -1;
      const awaitingThreshold =
        this.staleJobTimeoutMs > 0 ? now + awaitingCompensationMs - this.staleJobTimeoutMs : -1;
      const stale = await this.jobStore.findStaleJobs(
        processingThreshold,
        awaitingThreshold,
        50,
        this.capabilityNames()
      );
      let swept = 0;
      for (const record of stale) {
        const messages = await this.jobStore.getMessages(record.id, 0);
        const history = messages.length ? messages : record.messages;
        const deadline = callerDeadline({ ...record, messages: history });
        if (deadline !== undefined && now < deadline) continue;
        const orphanedInput = record.status === "awaiting-input" && deadline === undefined && hasCallerDeadline(history);
        const awaiting = deadline !== undefined || (record.status === "awaiting-input" && !orphanedInput);
        const terminalStatus = awaiting ? "cancelled" : "failed";
        const reason = awaiting ? "stale_no_terminal_status" : "worker_died_mid_job";
        // Accepted input is no longer the caller's responsibility. A worker
        // that never claims it gets the processing grace period before failure.
        const expectedActivityBefore = awaiting && record.status === "awaiting-input" ? awaitingThreshold : processingThreshold;
        if (expectedActivityBefore < 0 || record.lastActivityAt > expectedActivityBefore) continue;
        const local = this._activeJobs.get(record.id);
        if (
          (record.status === "processing" || record.status === "working") &&
          local && (local.status === "processing" || local.status === "working")
        ) {
          // Use the store write directly: the timer heartbeat may already be
          // in flight, in which case heartbeatActiveJobs() returns early.
          await this.jobStore.heartbeatActiveJobs([record.id], Date.now());
          diagnosticConsole.warn({
            level: "stale_job_local_live_skipped",
            ageMs: monoNow - record.lastActivityAt,
          });
          continue;
        }
        const claimed = await this.jobStore.cancelStaleJob(
          record.id,
          expectedActivityBefore,
          reason,
          terminalStatus
        );
        if (claimed) {
          swept++;
          // the reaper bypasses `handleJobTerminal`, so issue the
          // receipt here. This is the case the receipt matters most for — the
          // paid job failed, the worker died, and the receipt
          // (`outcome: "failed"`, `reason: "worker_died_mid_job"`) is evidence
          // of the failed delivery and released draw. Re-read rather than reuse
          // `record`: the CAS just wrote the terminal status and reason we want
          // to attest.
          await this.finalizeStoredTerminal(record.id);
          diagnosticConsole.warn(
            {
              level: awaiting ? "stale_job_cancelled" : "stale_job_failed",
              jobId: record.id,
              capability: record.capability,
              priorStatus: record.status,
              terminalStatus,
              reason,
              lastActivityAt: record.lastActivityAt,
              // Off `monoNow`, not the wall: the age the *decision* was made
              // on. Under a backwards step the wall reads the row as younger
              // than the window it was just reaped for, which on an incident
              // reads as a false reap. `skewMs` here is the same number the
              // end-of-tick `stale_job_sweep_clock_skew` line reports, repeated
              // per row so one reap line explains itself without correlating.
              ageMs: monoNow - record.lastActivityAt,
              skewMs: skewMs > 0 ? skewMs : undefined,
              paidMsats: record.paidMsats,
              paymentRail: record.paymentRail,
            }
          );
          // a *paid* job reaped here had its pending credit draw
          // released rather than settled. Report the failed delivery so the
          // platform can send an ambient notice; this is not a payment-loss
          // page. Fire-and-forget so a throw or a slow report never wedges the
          // sweep.
          if (record.paidMsats > 0 && record.paymentRail && this.opts.onPaidJobDeath) {
            // Guard both sync throws and async rejections so a failing report
            // never wedges the remaining sweep work.
            try {
              void Promise.resolve(
                this.opts.onPaidJobDeath({
                  dvmId: this.opts.dvmId ?? "",
                  jobId: record.id,
                  capability: record.capability,
                  paidMsats: record.paidMsats,
                  rail: record.paymentRail,
                  reason,
                  nativeAmount: record.nativeAmount,
                  nativeAsset: record.nativeAsset,
                  paymentMint: record.paymentMint,
                })
              ).catch((err: unknown) => {
                diagnosticConsole.error(`[${record.id}] paid-job-death report failed:`, err);
              });
            } catch (err) {
              diagnosticConsole.error(`[${record.id}] paid-job-death report failed:`, err);
            }
          }
          // Tear down any local in-memory scaffold (idle timer, activeJobs
          // entry) so a zombie handler on this process can't keep ticking
          // after the DB row reached terminal.
          const active = this._activeJobs.get(record.id);
          if (active) {
            this.clearIdleTimer(record.id);
            // Adopt the reaped status locally and abort the zombie:
            // the in-memory status is what the context's terminal guard reads,
            // so without this the still-running handler could `ctx.complete()`
            // and persist a `completed` snapshot over the row we just reaped.
            active.status = terminalStatus;
            abortJob(active, reason);
            this.scheduleCleanup(active);
          }
        }
      }
      if (skewMs > 0) {
        // The wall stepped back and this manager is holding its reading
        // forward. The end of the tick, not the start: the shape
        // most worth seeing is skew present and nothing claimed, which is what
        // an arm running behind its cap looks like, and which logs nothing at
        // all today. `skewMs - <arm>CompensatedMs` is how far behind that arm
        // is; the two differ, so there is no combined number to report.
        diagnosticConsole.warn(
          {
            level: "stale_job_sweep_clock_skew",
            skewMs,
            processingCompensatedMs:
              this.processingWatchdogMs > 0 ? processingCompensationMs : undefined,
            awaitingCompensatedMs: this.staleJobTimeoutMs > 0 ? awaitingCompensationMs : undefined,
            examined: stale.length,
            swept,
          }
        );
      }
      return { swept };
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * How far one watchdog arm may lean on {@link monotonicNowMs} past the wall
   * clock to cover a backwards step. The compensation is capped,
   * not free: a claimed row must still have been silent for
   * `windowMs - cap`, and unlike the orphan sweep, claiming eagerly here
   * force-fails a job that may well be alive.
   *
   * **Half the window** is the floor that governs a wide window — five missed
   * heartbeats on the processing defaults. On the `awaiting-input` arm it also
   * preserves a real invariant: with the derived
   * `2 x idleTimeout + headroom`, half is `idleTimeout + 45s`, so the sweeper
   * still cannot fire before the in-process idle timer would have. (A builder
   * who overrides `staleJobTimeoutMs` below `2 x idleTimeout` has already
   * opted out of that, guard or no guard.)
   *
   * **Two heartbeat intervals** is the floor that governs a window configured
   * close to the beat cadence — `processingWatchdog: 40` against the 30s
   * default beat, where half the window is less than one beat and a worker
   * heartbeating exactly on schedule would be reaped the moment the host's
   * clock stepped. That pair is marginal already; the guard must not make it
   * deterministic. The cap collapses to zero there, which is today's
   * behaviour: late, never wrong. The `awaiting-input` arm takes no such term
   * nothing heartbeats it by design, and its refresh is an inbound caller
   * message on no cadence at all.
   *
   * **Why a magnitude and not a predicate.** The tempting sharper rule is to
   * compensate per row, fully, for any stamp that reads ahead of our wall —
   * one our own post-step heartbeat could not have written. It is unsafe: a
   * future-stamped row is equally what a live job heartbeated by a peer whose
   * clock runs fast looks like, and from the stamp alone the two are
   * indistinguishable. The same reasoning bounds the cap from the other side —
   * while our clock is stepped, the guard force-fails the live jobs of any
   * peer slower than `windowMs - cap`, which is 2.5 minutes of tolerated
   * disagreement on the defaults, far outside anything NTP-managed hosts show.
   */
  private staleSweepCompensationCapMs(windowMs: number, heartbeated: boolean): number {
    if (windowMs <= 0) return 0;
    const halfWindow = Math.floor(windowMs / 2);
    if (!heartbeated || this.heartbeatIntervalMs <= 0) return halfWindow;
    return Math.max(0, Math.min(halfWindow, windowMs - 2 * this.heartbeatIntervalMs));
  }

  /**
   * Redact terminal job content beyond this DVM's configured window.
   *
   * The scan advances over every candidate, including rows that fail draw
   * resolution, so one money-path fault cannot starve everything behind it.
   * Any failed row remains unredacted and the next tick restarts from the head;
   * a page-capped clean pass instead retains its cursor and resumes at the
   * tail. Failure and recovery callbacks are awaited but never allowed to
   * change the sweep result.
   */
  async sweepJobRetention(): Promise<{
    examined: number;
    redacted: number;
    complete: boolean;
  }> {
    const idle = { examined: 0, redacted: 0, complete: false };
    if (this.descriptor.jobRetentionDays <= 0 || !isJobRetentionStore(this.jobStore)) return idle;
    if (this.jobRetentionSweepInFlight) return idle;
    this.jobRetentionSweepInFlight = true;

    let examined = 0;
    let redacted = 0;
    let complete = false;
    let cursor = this.jobRetentionResumeFrom;
    const failures: Error[] = [];
    const now = Date.now();
    const lastActivityBeforeMs = now - this.descriptor.jobRetentionDays * DAY_MS;

    try {
      for (let page = 0; page < JOB_RETENTION_SWEEP_MAX_PAGES; page++) {
        const candidates = await this.jobStore.listJobsForRetention({
          lastActivityBeforeMs,
          limit: JOB_RETENTION_SWEEP_BATCH,
          capabilities: this.capabilityNames(),
          after: cursor,
        });
        for (const record of candidates) {
          examined++;
          cursor = { lastActivityAt: record.lastActivityAt, id: record.id };
          try {
            await this.prepareJobForRedaction(record, now);
            const changed = await this.jobStore.redactJob({
              jobId: record.id,
              expectedLastActivityAt: record.lastActivityAt,
              redactedAt: now,
            });
            if (changed) redacted++;
          } catch (err) {
            const failure = err instanceof Error ? err : new Error(String(err));
            failures.push(failure);
            diagnosticConsole.error(
              {
                level: "error",
                event: "job_retention_candidate_failed",
                jobId: record.id,
                error: undefined,
              }
            );
          }
        }
        if (candidates.length < JOB_RETENTION_SWEEP_BATCH) {
          complete = true;
          break;
        }
      }

      if (failures.length > 0) {
        // Retry every failed head on the next tick. The keyset was still used
        // within this pass, so later candidates were not starved.
        this.jobRetentionResumeFrom = undefined;
        throw new AggregateError(failures, `${failures.length} job retention candidate(s) failed`);
      }

      this.jobRetentionResumeFrom = complete ? undefined : cursor;
      diagnosticConsole.log(
        {
          level: "info",
          event: "job_retention_swept",
          retentionDays: this.descriptor.jobRetentionDays,
          cutoffMs: lastActivityBeforeMs,
          examined,
          redacted,
          complete,
        }
      );
      if (complete) {
        await this.notifyJobRetentionRecovered({ examined, redacted });
      }
      return { examined, redacted, complete };
    } catch (err) {
      this.jobRetentionResumeFrom = undefined;
      const error = err instanceof Error ? err.message : String(err);
      diagnosticConsole.error(
        {
          level: "error",
          event: "job_retention_sweep_failed",
          retentionDays: this.descriptor.jobRetentionDays,
          examined,
          redacted,
          error,
        }
      );
      await this.notifyJobRetentionFailed(error);
      throw err;
    } finally {
      this.jobRetentionSweepInFlight = false;
    }
  }

  /** Resolve every hold and persist any configured receipt before content disappears. */
  private async prepareJobForRedaction(record: JobRecord, nowMs: number): Promise<void> {
    const ledger = this.opts.creditLedger;
    if (!ledger) {
      if (record.creditId || record.drawId) {
        throw new Error("job carries a credit draw but no ledger is configured");
      }
    } else {
      const draws = await ledger.listDrawsByJobId(record.id);
      for (const draw of draws) {
        if (draw.status !== "pending") continue;
        await this.reconcileTerminalDraw(ledger, draw, record, nowMs);
      }
      const stillPending = (await ledger.listDrawsByJobId(record.id)).filter(
        (draw) => draw.status === "pending"
      );
      if (stillPending.length > 0) {
        throw new Error(
          `job still has ${stillPending.length} pending credit draw(s): ${stillPending
            .map((draw) => draw.drawId)
            .join(", ")}`
        );
      }
    }

    if (
      !record.receipt &&
      this.opts.receiptIssuer &&
      isReceiptIssuingStore(this.jobStore) &&
      !(await this.issueReceipt(record))
    ) {
      throw new Error("signed receipt could not be persisted");
    }
  }

  private async notifyJobRetentionFailed(error: string): Promise<void> {
    const callback = this.opts.onJobRetentionSweepFailed;
    if (!callback) return;
    try {
      await callback({
        dvmId: this.opts.dvmId ?? "",
        dvmName: this.descriptor.name,
        retentionDays: this.descriptor.jobRetentionDays,
        error,
      });
    } catch (_callbackError) {
      diagnosticConsole.error(
        {
          level: "error",
          event: "job_retention_alert_failed",
          error: undefined,
        }
      );
    }
  }

  private async notifyJobRetentionRecovered(result: {
    examined: number;
    redacted: number;
  }): Promise<void> {
    const callback = this.opts.onJobRetentionSweepRecovered;
    if (!callback) return;
    try {
      await callback({
        dvmId: this.opts.dvmId ?? "",
        dvmName: this.descriptor.name,
        retentionDays: this.descriptor.jobRetentionDays,
        ...result,
      });
    } catch (_callbackError) {
      diagnosticConsole.error(
        {
          level: "error",
          event: "job_retention_recovery_alert_failed",
          error: undefined,
        }
      );
    }
  }

  /**
   * Resolve `pending` credit draws the terminal funnel can no longer reach.
   * Two arms over one scan, distinguished by whether the draw's job row exists.
   *
   * **No job row — release.** allocates the job id and
   * commits the ledger draw, with its `job_id` linkage, before `recordReplay`
   * and `persistJob` write the job row. A crash, a `draw_conflict` 409, or a
   * fail-closed `replay_detected` 401 in that window leaves a committed hold
   * that **no** terminal path can ever reach: `issueReceipt` →
   * `resolveCreditDraw` keys off the `creditId`/`drawId` persisted on the job
   * row, so with no row there is no release path at all and the caller's
   * available balance stays reduced forever. Cosmetic for an implicit N=1
   * credit, a silent balance shrink for an explicit N>1 one.
   *
   * **Terminal job row — reconcile to its outcome.** The funnel
   * demonstrably fails: `resolveCreditDraw` throws on a ledger/DB error,
   * `issueReceipt` catches it, logs `credit_resolve_failed` and returns
   * nothing, and until now nothing retried. Same stranded hold, reached through
   * a different door — and for a `completed` job it strands the platform's
   * books too, since draws *are* the revenue events: the caller is
   * charged nothing, the balance never moves, and outstanding liability
   * (`deposits − draw revenue`) overstates forever. So a late settle books, off
   * the committed draw row, through the ordinary reporter path.
   *
   * **A non-terminal job row is still never touched** — the stale-job sweep
   * above drives those to terminal first, and its `issueReceiptForStoredJob`
   * resolves the draw on the way. Those skipped holds are why the scan
   * keyset-paginates rather than re-reading one batch: they stay `pending`
   * indefinitely (an `awaiting-input` job on a 30-minute idle timeout sits well
   * past the orphan cutoff), so a fixed first page of them would starve every
   * real orphan behind it, on every tick, forever. The cursor advances over
   * every row examined; a tick that hits {@link ORPHAN_DRAW_SWEEP_MAX_PAGES}
   * logs `orphan_draw_sweep_truncated` and the next one resumes where it
   * stopped, so progress is bounded per tick but never blocked.
   *
   * Fires on a timer (wired in the constructor) and also callable on demand
   * (tests, ops). Both `settle` and `release` are idempotent under the credit
   * row's `FOR UPDATE`, so concurrent sweepers on several machines — and a
   * sweeper racing the in-line funnel — resolve the hold exactly once; the
   * losers see `replayed: true` and book nothing.
   */
  async sweepOrphanDraws(): Promise<{ released: number; reconciled: number }> {
    const ledger = this.opts.creditLedger;
    const idle = { released: 0, reconciled: 0 };
    if (!ledger) return idle;
    if (this.orphanSweepInFlight) return idle;
    this.orphanSweepInFlight = true;
    try {
      // One non-regressing clock for the whole tick. Both sides of
      // the age gate are wall-clock samples — `created_at` is stamped by
      // whichever process placed the draw — so a backwards step between them
      // makes every hold look younger than it is, and the cutoff matches
      // nothing. See `createMonotonicClock` for what that costs.
      const now = this.monotonicNowMs();
      const createdBeforeMs = now - this.orphanDrawAgeMs;
      // rides the scan, so its (wider) gate is a per-row
      // check rather than a second query. `<= 0` disables the arm outright.
      const reconcileBeforeMs =
        this.terminalDrawReconcileAgeMs > 0 ? now - this.terminalDrawReconcileAgeMs : -Infinity;
      let cursor = this.orphanSweepResumeFrom;
      let released = 0;
      let reconciled = 0;
      let examined = 0;
      let skipped = 0;
      let deferred = 0;
      for (let page = 0; page < ORPHAN_DRAW_SWEEP_MAX_PAGES; page++) {
        const candidates = await ledger.listStalePendingDraws({
          createdBeforeMs,
          limit: ORPHAN_DRAW_SWEEP_BATCH,
          after: cursor,
        });
        for (const draw of candidates) {
          examined++;
          // Advance over every row we look at, resolved or not. A skipped hold
          // stays `pending`, so without the cursor the next read would serve
          // the same wall of them and never reach what's behind it.
          cursor = {
            createdAt: draw.createdAt,
            creditId: draw.creditId,
            ledgerSeq: draw.ledgerSeq,
          };
          const record = draw.jobId !== null ? await this.jobStore.get(draw.jobId) : undefined;
          if (record) {
            // The funnel (or the stale-job sweep, which drives it there) still
            // owns a job that hasn't finished.
            if (!isTerminal(record.status)) {
              skipped++;
              continue;
            }
            // Terminal, but inside the window where the free in-line repair
            // paths still get first refusal — see
            // DEFAULT_TERMINAL_DRAW_RECONCILE_AGE_MS.
            if (draw.createdAt >= reconcileBeforeMs) {
              deferred++;
              continue;
            }
            if (await this.reconcileTerminalDraw(ledger, draw, record, now)) reconciled++;
            continue;
          }
          // A jobless hold is defensive cover: today's verifier always sets a
          // `job_id` (the fund-only top-up path takes no draw at all), so this
          // arm only fires if some future draw site forgets the linkage. It
          // cannot be reconciled either way, so age it out.
          //
          // Otherwise: no job row ⇒ the row never landed. Nothing in the SDK
          // deletes a `jobs` row — `JobStore.delete` has no production caller,
          // `scheduleCleanup` only evicts the in-process map, and neither store
          // has a TTL. A future jobs-retention sweep MUST resolve holds before
          // pruning, or this reads pruned history as crash debris.
          const reason = draw.jobId === null ? "no_job_linkage" : "job_never_landed";
          try {
            const resolution = await ledger.release(
              this.drawResolutionArgs(draw.creditId, draw.drawId)
            );
            if (!resolution.replayed) released++;
            diagnosticConsole.warn(
              {
                level: "orphan_draw_released",
                creditId: draw.creditId,
                drawId: draw.drawId,
                jobId: draw.jobId,
                amountMicro: draw.amountMicro,
                createdAt: draw.createdAt,
                ageMs: now - draw.createdAt,
                reason,
                replayed: resolution.replayed,
                availableMicro: resolution.availableMicro,
              }
            );
          } catch (err) {
            // A concurrent terminal funnel settling the same draw is the
            // expected loss here (`invalid_draw_state`); log and keep sweeping
            // so one contended hold can't strand the rest of the batch.
            diagnosticConsole.warn(
              {
                level: "orphan_draw_release_failed",
                creditId: draw.creditId,
                drawId: draw.drawId,
                jobId: draw.jobId,
                code: err instanceof CreditLedgerError ? err.code : undefined,
                error: undefined,
              }
            );
          }
        }
        // A short page is the end of the scan: start the next tick from the
        // top so holds that have since crossed the age cutoff are seen.
        if (candidates.length < ORPHAN_DRAW_SWEEP_BATCH) {
          this.orphanSweepResumeFrom = undefined;
          await this.reportSweepOutcome(ledger, now, {
            examined,
            skipped,
            deferred,
            released,
            reconciled,
          });
          return { released, reconciled };
        }
      }
      // Page cap hit with rows still behind the cursor. Log it — a starved
      // sweep must not be indistinguishable from a clean one — and hand the
      // cursor to the next tick so the tail is reached rather than re-skipped.
      // `skipped` (job still running) and `deferred` (terminal, too young to
      // reconcile) stay separate counters: merged, the line stops saying which
      // kind of wall the tick starved behind.
      this.orphanSweepResumeFrom = cursor;
      diagnosticConsole.warn(
        {
          level: "orphan_draw_sweep_truncated",
          examined,
          skipped,
          deferred,
          released,
          reconciled,
          maxPages: ORPHAN_DRAW_SWEEP_MAX_PAGES,
          resumeAfterCreatedAt: cursor?.createdAt,
        }
      );
      return { released, reconciled };
    } finally {
      this.orphanSweepInFlight = false;
    }
  }

  /**
   * The end-of-scan line for a tick that resolved nothing. Two shapes are
   * worth a warning, and neither is the ordinary
   * one — the timer runs every 5 minutes per ledger in production.
   *
   * `examined > 0`: aged candidates were looked at and none moved. Usually
   * legitimate (their jobs are still running, or terminal inside the reconcile
   * grace period), but it is also what a silently skipped hold looks like.
   *
   * `examined === 0`: the query returned nothing. Ordinarily that means there
   * is nothing to do — but it is equally what a blinded scan looks like, which
   * is the case the gate could not reach. Probe for the oldest
   * `pending` hold at any age and speak up when one exists the scan should
   * have seen and didn't: already past the age gate outright, stamped ahead of
   * our clock (some other process's clock is fast), or hidden while our own
   * clock is held forward over a backwards step. A ledger holding nothing but
   * young draws stays quiet.
   *
   * The probe is diagnostics, so it is wrapped: a tick that swept cleanly must
   * never report failure because the extra read fell over. A probe that throws
   * says so on the same line rather than replacing the tick's outcome.
   */
  private async reportSweepOutcome(
    ledger: CreditLedgerLike,
    nowMs: number,
    tally: {
      examined: number;
      skipped: number;
      deferred: number;
      released: number;
      reconciled: number;
    }
  ): Promise<void> {
    if (tally.released > 0 || tally.reconciled > 0) return;
    let oldestPendingAgeMs: number | undefined;
    let probeError: string | undefined;
    if (tally.examined === 0) {
      let oldest: DrawRecord | undefined;
      try {
        oldest = (
          await ledger.listStalePendingDraws({
            createdBeforeMs: ANY_DRAW_AGE_CUTOFF_MS,
            limit: 1,
          })
        ).at(0);
      } catch (err) {
        probeError = err instanceof Error ? err.message : String(err);
      }
      if (probeError === undefined) {
        if (!oldest) return;
        // Three shapes are worth the line. The first is the plain one the
        // gate was built for and could not reach from an empty scan:
        // a hold the age cutoff should have returned, and didn't. The other
        // two are the clock — a hold stamped ahead of us, or our own reading
        // currently held forward over a backwards step.
        const pastAgeGate = oldest.createdAt < nowMs - this.orphanDrawAgeMs;
        const stampedAhead = oldest.createdAt > nowMs;
        const clockHeldForward = nowMs > Date.now();
        if (!pastAgeGate && !stampedAhead && !clockHeldForward) return;
        oldestPendingAgeMs = nowMs - oldest.createdAt;
      }
    }
    const clockSkewMs = nowMs - Date.now();
    diagnosticConsole.warn(
      {
        level: "orphan_draw_sweep_no_progress",
        examined: tally.examined,
        skipped: tally.skipped,
        deferred: tally.deferred,
        released: tally.released,
        reconciled: tally.reconciled,
        // A negative age is a hold stamped in the future — the signature of
        // the clock skew that hides it from the age gate.
        oldestPendingAgeMs,
        clockSkewMs: clockSkewMs > 0 ? clockSkewMs : undefined,
        probeError,
      }
    );
  }

  /**
   * Resolve one aged `pending` draw whose job row reached terminal,
   * mirroring what `resolveCreditDraw` would have done in line. Returns true
   * when this call is the one that moved the draw — the caller counts it, and
   * only it books.
   *
   * **The settle is gated on the job row naming _this_ draw.** The scan finds
   * the draw by `credit_draws.job_id`, but the job's own `credit_id`/`draw_id`
   * are written by a *later* transaction than the one that committed the draw
   * (`verifyIncomingPayment` commits fund+draw; `verifyAndCredit` binds the
   * row), and a free-then-paid job binds set-if-null. A store failure or a
   * second concurrent top-up therefore leaves a hold tagged with the job whose
   * row points somewhere else, or nowhere. Settling that would debit the caller
   * a second time for one job — and invisibly, since `revenue_events`'
   * `UNIQUE (dvm_id, job_id, rail)` would drop the booking. So an unbound hold
   * is **released**, never settled: the job's payment was the draw it is bound
   * to, and this one bought nothing.
   *
   * Concurrency needs no guard of its own. `settle`/`release` run under the
   * credit row's `FOR UPDATE`, so exactly one caller — a sibling reconciler,
   * or the in-line funnel arriving late — sees `replayed: false`, which makes
   * the booking gate a true mutex rather than a hopeful one. The one race left
   * open is another machine's `handleJobTerminal` stalled between resolving the
   * draw and booking it, which would double-report; the platform's
   * `(dvm_id, credit_id, draw_id)` and `(dvm_id, job_id, rail)` unique indexes
   * absorb that.
   *
   * `invalid_draw_state` — the funnel having already resolved the draw to the
   * other state — is the expected loss, logged and swallowed like the orphan
   * arm's, so one contended hold can't strand the rest of the batch.
   */
  private async reconcileTerminalDraw(
    ledger: CreditLedgerLike,
    draw: DrawRecord,
    record: JobRecord,
    nowMs: number
  ): Promise<boolean> {
    const args = this.drawResolutionArgs(draw.creditId, draw.drawId);
    const bound = record.creditId === draw.creditId && record.drawId === draw.drawId;
    const settle = bound && this.settlesDraw(record.status);
    try {
      const resolution = settle ? await ledger.settle(args) : await ledger.release(args);
      // Draws are the revenue events, so a late settle books one —
      // off the committed draw row, through the same reporter path the funnel
      // uses. A released draw books nothing, which is what keeps "no debit on
      // job failure" true in the books as well as the ledger. `bookRevenue`
      // re-reads the draw off `record`, which is the one we just settled:
      // `settle` implies `bound`, so the two pairs are equal by construction.
      const booked = settle && !resolution.replayed ? await this.bookRevenue(record) : false;
      diagnosticConsole.warn(
        {
          level: "credit_draw_reconciled",
          creditId: draw.creditId,
          drawId: draw.drawId,
          jobId: draw.jobId,
          jobStatus: record.status,
          resolution: settle ? "settled" : "released",
          reason: bound ? "job_terminal" : "draw_unbound",
          amountMicro: draw.amountMicro,
          createdAt: draw.createdAt,
          ageMs: nowMs - draw.createdAt,
          replayed: resolution.replayed,
          availableMicro: resolution.availableMicro,
          booked,
        }
      );
      return !resolution.replayed;
    } catch (err) {
      diagnosticConsole.warn(
        {
          level: "credit_draw_reconcile_failed",
          creditId: draw.creditId,
          drawId: draw.drawId,
          jobId: draw.jobId,
          jobStatus: record.status,
          code: err instanceof CreditLedgerError ? err.code : undefined,
          error: undefined,
        }
      );
      return false;
    }
  }

  /**
   * Refresh `lastActivityAt` for jobs this process is actively running
   * (`processing`/`working`) so the processing watchdog only fires once the
   * worker is genuinely dead. `awaiting-input` jobs are
   * deliberately excluded — their idle timeout must still elapse. Fires on the
   * heartbeat timer; also callable on demand for tests.
   */
  async heartbeatActiveJobs(): Promise<{ beat: number }> {
    if (!isStreamableJobStore(this.jobStore)) return { beat: 0 };
    if (this.heartbeatInFlight) return { beat: 0 };
    this.heartbeatInFlight = true;
    try {
      const ids: string[] = [];
      for (const job of this._activeJobs.values()) {
        if (job.status === "processing" || job.status === "working") ids.push(job.id);
      }
      if (ids.length === 0) return { beat: 0 };
      // Wall-clock epoch-ms, deliberately — this is a *stamp*, and every other
      // machine's sweep reads it. Floating it off this host's clock (
      // floats the reading side) would write a value only this process can
      // interpret. Same for the other stamps in this file: `createJob`'s
      // `createdAt`/`lastActivityAt`, `recordInboundPending`'s message
      // timestamp and its `lastActivityAt` bump.
      await this.jobStore.heartbeatActiveJobs(ids, Date.now());
      return { beat: ids.length };
    } finally {
      this.heartbeatInFlight = false;
    }
  }

  /**
   * Single-execution claim for a reactivating machine. Before
   * replaying an `awaiting-input` job, wait a bounded grace window for a live
   * original handler to win the `awaiting-input → processing` CAS via its
   * NOTIFY wake. Resolves:
   * • `false` — the row left `awaiting-input` during the window (the original
   * handler claimed it / drove it terminal). Stand down; do not replay.
   * • `true` — the window elapsed still `awaiting-input` (the original worker
   * is gone or has no live resolver) AND this machine won the claim CAS.
   * Replay for dead-worker recovery.
   *
   * Biasing the original handler to win kills the double execution (double
   * substrate spend, clobbered artifact) without heartbeating `awaiting-input`
   * (which would break the caller-input idle timeout). Non-streamable stores
   * have no cross-machine race, so the claim is a no-op `true`.
   */
  async claimAwaitingInputForReactivation(jobId: string): Promise<boolean> {
    if (!isStreamableJobStore(this.jobStore)) return true;
    const store = this.jobStore;
    const scaffold = this._activeJobs.get(jobId);
    const askSeq = scaffold ? this.reactivationAskSeqs.get(scaffold) : undefined;
    // Both samples read the non-regressing clock. Off the wall this
    // is the same two-sample shape as the stale sweep, and a backwards step
    // between them holds the deadline out of reach: the loop keeps polling
    // every REACTIVATION_CLAIM_POLL_MS for the length of the step, hanging the
    // caller's reactivation on it. Nothing is traded for the guard here — the
    // window measures elapsed time and never compares against a stored stamp.
    const deadline = this.monotonicNowMs() + this.reactivationClaimGraceMs;
    for (;;) {
      if (this.monotonicNowMs() >= deadline) {
        // Window elapsed; either we win the CAS (original worker absent) or a
        // just-woken original handler beat us to it (CAS returns false).
        if (scaffold && this._activeJobs.get(jobId) !== scaffold) return false;
        return this.claimInputForAsk(jobId, askSeq);
      }
      const record = await store.get(jobId);
      if (record?.status !== "awaiting-input") return false;
      await new Promise((resolve) => {
        setTimeout(resolve, REACTIVATION_CLAIM_POLL_MS);
      });
    }
  }

  /**
   * Record an inbound client message durably via Tx B and append
   * it to the in-memory `job.messages` array. Returns the DB-allocated seq
   * (`null` when the store isn't streamable — non-Postgres test fallback).
   *
   * Status starts as `pending-verification`; a follow-up Tx C call
   * (`processPayment` for payments, `markInboundVerified` for everything
   * else) transitions it to `verified` once the inbound is accepted.
   */
  async recordInboundPending(
    job: ServerJob,
    msgType: MessageType,
    msgContent: Record<string, unknown>
  ): Promise<number | null> {
    const timestamp = Math.floor(Date.now() / 1000);
    let txSeq: number | null = null;
    if (isStreamableJobStore(this.jobStore)) {
      txSeq = await this.jobStore.recordInbound(job.id, {
        from: "requester",
        type: msgType,
        timestamp,
        content: msgContent,
      });
    }
    job.seq++;
    job.messages.push({
      seq: job.seq,
      from: "requester",
      timestamp,
      type: msgType,
      content: msgContent,
    } as Message);
    job.lastActivityAt = Date.now();
    return txSeq;
  }

  /**
   * Tx C complement for non-payment inbound messages — flip the row to
   * `verified` so cross-machine readers see it via `subscribeMessages`.
   */
  async markInboundVerified(jobId: string, inboundSeq: number | null): Promise<void> {
    if (inboundSeq === null) return;
    if (!isStreamableJobStore(this.jobStore)) return;
    await this.jobStore.verifyAndCredit(jobId, inboundSeq, null);
  }

  /**
   * Reactivate a suspended/event-driven job from the store. Builds the
   * in-memory `ServerJob`, wires the appender, builds the context, starts
   * the idle timer. The caller has already recorded the inbound via Tx B
   * and run Tx C (verify + credit); reactivation is now decoupled from
   * credit. The caller decides whether to run the
   * handler (Pattern A: status was `awaiting-input`) or to dispatch the
   * message to a custom handler (Pattern B).
   *
   * For DVMs that declare descriptor-level auth, the persisted
   * `record.input` carries the original signed envelope. We re-verify the
   * signature here so a DB-layer tamper — compromised admin, SQL
   * injection, malicious operator with DB access — can't silently feed an
   * attacker-supplied pubkey/envelope into the handler. The drift window
   * and replay store are deliberately skipped: the persisted timestamp is
   * from the original signing instant (long past the 5-min drift bound for
   * any long-running job), and the nonce was already committed at submission.
   * On failure: throws `SignedRequestError` ({@link AuthSchemaError} when
   * the capability has no input schema to verify against); the caller is
   * expected to mark the row failed and surface a 401 / 500 to the inbound
   * caller.
   *
   * What gets re-verified is the persisted row read back through
   * {@link signedRequestInput} — `app.ts` stores the pre-Zod wire form, so
   * those are the caller's own signed bytes, the same ones `/v1/quote` and the
   * submit checked. That makes the tamper check strictly stronger
   * than the parsed form it replaced: an injected key the capability schema
   * doesn't declare used to be stripped before the signature was checked, so
   * it re-verified clean.
   */
  reactivateJob(record: JobRecord): {
    job: ServerJob;
    sdkCtx: SDKJobContext<unknown, unknown>;
  } {
    const parsedInput = this.parseInput({ input: record.input }, record.capability);

    if (this.descriptor.auth) {
      const cap = this.requireCapability(record.capability);
      if (!cap.input || !isZodSchema(cap.input)) {
        throw new ReactivationAuthSchemaError(record.id, record.capability);
      }
      try {
        const domain = persistedSignedRequestDomain(
          record.authRequestPath,
          record.capability,
          this.opts.authAudience
        );
        this.descriptor.auth.recheckSignature(
          cap.input,
          signedRequestInput({ input: record.input }),
          domain
        );
      } catch (err) {
        diagnosticConsole.warn(
          {
            level: "auth_reverify_failed",
            jobId: record.id,
            capability: record.capability,
            sub_reason: err instanceof SignedRequestError ? err.sub_reason : "unknown",
          }
        );
        throw err;
      }
    }

    const job = fromJobRecord(record);
    const ask = record.messages.findLast((message) => message.from === "provider" && message.type === "payment-request");
    if (ask) this.reactivationAskSeqs.set(job, ask.seq);
    this._activeJobs.set(job.id, job);
    this.wireMessageAppender(job);
    this.watchDurableStatus(job);

    const auth = deriveAuthFromParsedInput(this.descriptor, parsedInput);
    const sdkCtx = buildContext(job, { ...this.buildContextOpts(job), parsedInput, auth });
    job.sdkCtx = sdkCtx;
    return { job, sdkCtx: sdkCtx };
  }

  /**
   * Verify an inbound payment and apply the credit via Tx C.
   * The inbound message must have been recorded via Tx B already
   * (`recordInboundPending` returned `inboundSeq`). For non-streamable
   * stores (`inboundSeq === null`), falls back to in-memory mutation via
   * `applyPaymentInfoToJob`.
   *
   * Dev-mode short-circuit: auto-credits the outstanding
   * `pendingPaymentMsats` without external verification. Gated on
   * `devModeSkipsPaymentVerification` — the same predicate the upfront path
   * reads, so a dev server wired to a mint verifies mid-job payments for real
   * plus the explicit `dev_auto` opt-out the dev console uses,
   * which is the one caller that has no wallet to pay from. `dev_auto` loses to
   * any proof riding the same message: money on the wire always takes the rail,
   * so the flag can never leave a real token unspent against a credited job.
   *
   * Tx C is not atomic with the rail commit. `verifyIncomingPayment`
   * commits the proofs *and* the ledger leg in one transaction and returns;
   * only then does `verifyAndCredit` write the job row, on its own connection.
   * Everything after that call therefore runs with the caller's money already
   * moved, which is why the write is retried rather than left to throw, and why
   * an exhausted retry answers with the credit it landed on instead of a bare
   * 500. See `creditInbound`.
   */
  async processPayment(
    job: ServerJob,
    body: { type: MessageType; content: Record<string, unknown> },
    inboundSeq: number | null,
    extra?: {
      lockPubkeys?: LockPubkey[];
      mintHealthTracker?: MintHealthTracker;
    }
  ): Promise<ProcessPaymentOutcome> {
    if (body.type !== "payment") return {};

    const devAuto =
      this.opts.devMode === true &&
      body.content.dev_auto === true &&
      !hasPaymentProof(body.content);
    if (devAuto || devModeSkipsPaymentVerification(this.opts)) {
      const hadPendingPayment = job.pendingPaymentMsats !== undefined;
      const delta = job.pendingPaymentMsats ?? 0;
      if (inboundSeq !== null && isStreamableJobStore(this.jobStore)) {
        const credit: PaymentCreditDelta | null = delta
          ? { paidMsatsDelta: delta, clearPending: true }
          : null;
        // No ledger leg ran here, so there is no committed money to strand —
        // the retry is for the transient store error alone.
        const { counters } = await this.creditInbound(job.id, inboundSeq, credit);
        job.paidMsats = counters.paidMsats;
        job.pendingPaymentMsats = counters.pendingPaymentMsats;
        if (
          hadPendingPayment &&
          delta > 0 &&
          (counters.pendingPaymentMsats === undefined || counters.pendingPaymentMsats === 0)
        ) {
          job.reactivationPaymentApplied = true;
        }
        if (
          counters.pendingPaymentMsats === undefined &&
          job.status === "awaiting-input" &&
          job.pendingPrompts.size === 0
        ) {
          job.status = "processing";
        }
      } else if (delta) {
        job.paidMsats += delta;
        job.pendingPaymentMsats = undefined;
        if (hadPendingPayment) job.reactivationPaymentApplied = true;
        if (job.status === "awaiting-input" && job.pendingPrompts.size === 0) job.status = "processing";
      }
      return {};
    }

    const verifyResult = await verifyIncomingPayment(
      body,
      {
        mints: this.opts.mints,
        x402Config: this.opts.x402,
        pricingCurrency: this.pricingCurrency,
        x402ExactSettlement: this.opts.x402ExactSettlement,
        x402ExactVersions: this.opts.x402FacilitatorHealth?.support().exact,
        mpp: this.opts.mpp,
        resourcePath: `/v1/job/${job.id}/messages`,
        cashuMode: this.opts.cashuMode,
        accumulatorDb: this.opts.cashuMode === "p2pk-accumulator" ? this.opts.db : undefined,
      disposableCashu: this.opts.disposableCashu,
        dvmId: this.opts.dvmId,
        lockPubkeys: extra?.lockPubkeys,
        mintHealthTracker: extra?.mintHealthTracker,
        fxFetcher: this.opts.fxFetcher,
        // the ledger leg — a mid-job payment is a top-up that funds
        // the job's credit and grows its draw, atomically with the rail commit.
        creditLedger: this.opts.creditLedger,
        processedPayments: this.opts.processedPayments,
        enqueueCreditDeposit: this.opts.enqueueCreditDeposit,
        jobId: job.id,
        hostingPaymentSeq: inboundSeq ?? undefined,
        creditTtlMs: this.opts.creditTtlMs,
      },
      {
        pendingPaymentMsats: job.pendingPaymentMsats,
        pendingMppChallengeIds: job.pendingMppChallengeIds,
        pendingX402Nonce: job.pendingX402Nonce,
        pendingX402AmountUsdcMicro: job.pendingX402AmountUsdcMicro,
        paymentRail: job.paymentRail,
        creditId: job.creditId,
        drawId: job.drawId,
        paymentTxHash: job.paymentTxHash,
        pendingPaymentFiatMicro: job.pendingPaymentFiatMicro,
        pendingPaymentFiatCurrency: job.pendingPaymentFiatCurrency,
        askedTopUpMicro: job.askedTopUpMicro,
        askedTopUpCurrency: job.askedTopUpCurrency,
        topUpCapUnenforcedReason: job.topUpCapUnenforcedReason,
        requesterPubkey: job.requesterPubkey,
        requesterId: job.requesterId,
      }
    );

    if (verifyResult.error) {
      if (inboundSeq !== null && isStreamableJobStore(this.jobStore)) {
        const rawCode = verifyResult.error.body.error;
        const code = typeof rawCode === "string" ? rawCode : "verify_failed";
        await this.jobStore.markInboundFailed(job.id, inboundSeq, code).catch(() => undefined);
      }
      // a short mid-job pay funded a credit and then 402'd, with no
      // draw placed or grown against it. The money is the caller's — available
      // balance on a credit they own, reclaimable under the drain — so
      // the deposit is booked here too. Skipping it because the request failed
      // would leave the platform holding an unrecorded liability.
      this.reportCreditDeposit(verifyResult.error.funding);
      // A replayed mid-job payment is the retry after a lost acknowledgement.
      // The money moved once; hand back the original funding evidence so the
      // caller can reconcile without paying again.
      const replayed = await this.replayedDrawFundingReceipt(job, verifyResult.error.replayPaymentId);
      return {
        error: {
          body: { ...verifyResult.error.body, ...(replayed && { draw_funding_receipt: replayed }) },
          status: verifyResult.error.status,
        },
      };
    }

    const info = verifyResult.verified;
    if (!info) return {};
    // Issued before Tx C: the funding row committed with the rail leg, so the
    // artifact exists whether or not the job row write below succeeds, and a
    // `payment_unapplied` answer can still carry it. Never fatal — an issuance
    // or save failure must not turn an accepted payment into a refusal; the
    // job read re-issues from the same row.
    const drawFundingReceipt = await this.drawFundingReceiptFor(info.drawFunding, info.funding?.currency);

    let unappliedCredit: UnappliedCredit | undefined;
    // the whole payment landed on the credit and grew no draw — a
    // second payment for an ask this job's draw already covers. It bought
    // nothing, so Tx C moves no counters: adding it to `paid_msats` would
    // silently pre-satisfy the *next* ask's auto-credit gate, giving away a
    // stage of work the caller never paid for. The inbound row is still CAS'd
    // verified, which is what stops it being retried.
    const fullyUnapplied =
      info.unappliedMicro !== undefined &&
      info.funding !== undefined &&
      info.unappliedMicro >= info.funding.amountMicro;
    const hadPendingPayment = job.pendingPaymentMsats !== undefined;
    if (inboundSeq !== null && isStreamableJobStore(this.jobStore)) {
      let result: VerifyAndCreditResult;
      try {
        result = await this.creditInbound(
          job.id,
          inboundSeq,
          fullyUnapplied
            ? null
            : {
                paidMsatsDelta: info.paidMsats,
                clearPending: false,
                paymentMint: info.paymentMint,
                paymentRail: info.paymentRail,
                paymentTxHash: info.paymentTxHash,
                nativeAmount: info.nativeAmount,
                nativeAsset: info.nativeAsset,
                cashuFlow: info.cashuFlow,
                accumulateNative: info.sameRail,
                clearPendingX402Binding: info.paymentRail === "x402",
                creditId: info.creditId,
                drawId: info.drawId,
              }
        );
      } catch (err) {
        const unapplied = await this.reportUnappliedPayment(job, inboundSeq, info, err);
        return {
          error: {
            body: { ...unapplied.body, ...(drawFundingReceipt && { draw_funding_receipt: drawFundingReceipt }) },
            status: unapplied.status,
          },
        };
      }
      const { counters } = result;
      job.paidMsats = counters.paidMsats;
      job.pendingPaymentMsats = counters.pendingPaymentMsats;
      if (
        !fullyUnapplied &&
        hadPendingPayment &&
        (counters.pendingPaymentMsats === undefined || counters.pendingPaymentMsats === 0)
      ) {
        job.reactivationPaymentApplied = true;
      }
      // take the binding the row actually holds rather than assuming
      // ours won. `credit_id`/`draw_id` are written set-if-null, so on a
      // free-then-paid job a concurrent top-up can have bound its own credit
      // first — mirroring `info` here would record a binding the row rejected
      // and leave `resolveCreditDraw` chasing a draw the job doesn't own.
      //
      // A store that reports neither is a store predating the read-back (the
      // fields are optional on the interface, and `StreamableJobStore` is a
      // surface builders implement). Silence there means "didn't say", not
      // "holds nothing" — so fall back to the set-if-null mirror
      // rather than wiping a live binding and calling every top-up unapplied.
      if (result.creditId !== undefined || result.drawId !== undefined) {
        job.creditId = result.creditId;
        job.drawId = result.drawId;
        if (info.creditId && result.creditId !== info.creditId) {
          // Our deposit lost the bind. It is still the caller's money on a
          // credit they own; name it so they don't have to derive the id
          // (short-pay 402 does the same for the same reason).
          unappliedCredit = this.unappliedCredit(info.funding, info.creditId, "unbound");
          diagnosticConsole.warn(
            {
              level: "warn",
              event: "credit_topup_unbound",
              job_id: job.id,
              credit_id: info.creditId,
              draw_id: info.drawId,
              bound_credit_id: result.creditId,
              bound_draw_id: result.drawId,
            }
          );
        }
      } else {
        job.creditId ??= info.creditId;
        job.drawId ??= info.drawId;
      }
      // Sync denormalized fields in-memory so the SSE listeners and the
      // change-token / terminal-callback paths see the credit immediately.
      // Skipped wholesale for a fully-unapplied payment: Tx C wrote
      // none of them, and mirroring them anyway would stamp the job with a
      // settlement reference and a native amount belonging to money it never
      // took — the same double-count the null delta above exists to avoid.
      if (!fullyUnapplied) {
        if (info.paymentMint) job.paymentMint = info.paymentMint;
        if (info.paymentTxHash) job.paymentTxHash = info.paymentTxHash;
        job.paymentRail = info.paymentRail;
        if (info.nativeAsset) job.nativeAsset = info.nativeAsset;
        if (info.cashuFlow) job.cashuFlow = info.cashuFlow;
        if (info.nativeAmount !== undefined) {
          job.nativeAmount = info.sameRail
            ? (job.nativeAmount ?? 0) + info.nativeAmount
            : info.nativeAmount;
        }
        if (info.paymentRail === "tempo") job.pendingMppChallengeIds = undefined;
        if (info.paymentRail === "x402") {
          job.pendingX402Nonce = undefined;
          job.pendingX402AmountUsdcMicro = undefined;
        }
      }
      // An outstanding prompt keeps the durable wait: its response can only be
      // claimed from `awaiting-input`, and a balance-paid ask leaves the
      // counter undefined, so an excess payment would otherwise strand it.
      if (
        counters.pendingPaymentMsats === undefined &&
        job.status === "awaiting-input" &&
        job.pendingPrompts.size === 0
      ) {
        job.status = "processing";
      }
    } else {
      applyPaymentInfoToJob(job, info);
      if (
        !fullyUnapplied &&
        hadPendingPayment &&
        (job.pendingPaymentMsats === undefined || job.pendingPaymentMsats === 0)
      ) {
        job.reactivationPaymentApplied = true;
      }
    }
    // part or all of this payment funded the credit without buying
    // anything. Name it on the 201 — unlike the loser, no draw holds
    // it, so it is drainable the moment the caller asks. Reported after the
    // bind check so a payment that is both unbound and over-ask keeps the
    // unbound copy, which is the stricter of the two (its money is held until
    // the job goes terminal).
    if (!unappliedCredit && info.unappliedMicro !== undefined && info.unappliedMicro > 0) {
      // The credit the money landed on, not `info.creditId` — that one is set
      // only when the top-up minted a *fresh* credit, and this shape is the
      // opposite case (a job already bound to one).
      unappliedCredit = this.unappliedCredit(info.funding, info.funding?.creditId, "over_ask", {
        creditedMicro: info.unappliedMicro,
      });
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "credit_topup_over_ask",
          job_id: job.id,
          credit_id: info.funding?.creditId,
          draw_id: info.drawId,
          unapplied_micro: info.unappliedMicro,
          funded_micro: info.funding?.amountMicro,
        }
      );
    }
    // money that landed on a credit is a liability whatever happens to
    // the job, so the deposit is reported on the same footing as the upfront and
    // `/v1/credit` legs. Fire-and-forget: a reporting hiccup must never fail the
    // payment that just succeeded.
    this.reportCreditDeposit(info.funding);
    return {
      ...(unappliedCredit && { unappliedCredit }),
      ...(drawFundingReceipt && { drawFundingReceipt }),
    };
  }

  /** Issue (or reuse) the signed draw funding receipt for a committed funding row; never throws. */
  private async drawFundingReceiptFor(
    funding: FundingRecord | undefined,
    currency: string | undefined
  ): Promise<DrawFundingReceipt | undefined> {
    const ledger = this.opts.creditLedger;
    if (!funding || !ledger || currency === undefined) return undefined;
    try {
      return await drawFundingReceiptFor(ledger, this.opts.receiptIssuer, funding, currency);
    } catch (err) {
      diagnosticConsole.error({
        level: "error",
        event: "draw_funding_receipt_unavailable",
        credit_id: funding.creditId,
        fund_id: funding.fundId,
        error: errText(err),
      });
      return undefined;
    }
  }

  /**
   * Every signed draw funding receipt for a job's draw, oldest first, reissuing
   * any the acknowledgement never carried. Empty when the ledger cannot list
   * draw fundings or the job holds no draw; a lookup failure is logged and
   * answered as empty rather than failing the read.
   */
  async drawFundingReceipts(job: Pick<JobRecord, "id" | "creditId" | "drawId">): Promise<DrawFundingReceipt[]> {
    const ledger = this.opts.creditLedger;
    // Without an issuer nothing can be signed, so the read costs no lookup at
    // all; with one, the credit is read only once a draw funding row exists,
    // which keeps the common poll of an unfunded job to a single list.
    if (!ledger?.listDrawFundings || !this.opts.receiptIssuer || !job.creditId || !job.drawId) {
      return [];
    }
    try {
      const fundings = (
        await ledger.listDrawFundings({ creditId: job.creditId, drawId: job.drawId })
      ).filter((funding) => funding.jobId === job.id);
      if (fundings.length === 0) return [];
      const credit = await ledger.get(job.creditId);
      if (!credit) return [];
      const receipts: DrawFundingReceipt[] = [];
      for (const funding of fundings) {
        const receipt = await drawFundingReceiptFor(ledger, this.opts.receiptIssuer, funding, credit.currency);
        if (receipt) receipts.push(receipt);
      }
      return receipts;
    } catch (err) {
      diagnosticConsole.error({
        level: "error",
        event: "draw_funding_receipts_unavailable",
        job_id: job.id,
        error: errText(err),
      });
      return [];
    }
  }

  /** The stored evidence for a replayed mid-job payment, looked up by the payment id the marker collided on. */
  private async replayedDrawFundingReceipt(
    job: ServerJob,
    replayPaymentId: string | undefined
  ): Promise<DrawFundingReceipt | undefined> {
    const ledger = this.opts.creditLedger;
    if (!replayPaymentId || !ledger || !job.creditId) return undefined;
    try {
      const [credit, funding] = await Promise.all([
        ledger.get(job.creditId),
        ledger.getFunding({ creditId: job.creditId, fundId: replayPaymentId }),
      ]);
      if (!credit || !funding || funding.jobId !== job.id) return undefined;
      return await drawFundingReceiptFor(ledger, this.opts.receiptIssuer, funding, credit.currency);
    } catch (err) {
      diagnosticConsole.error({
        level: "error",
        event: "draw_funding_receipt_unavailable",
        job_id: job.id,
        fund_id: replayPaymentId,
        error: errText(err),
      });
      return undefined;
    }
  }

  /**
   * Tx C with a bounded retry.
   *
   * By the time this runs on the verified path, the rail commit and the ledger
   * leg have already committed in a transaction this call is not part of — so a
   * throw here is money moved against a job row that records none of it, and
   * letting it propagate was the bug. A transient store error is the ordinary
   * cause and a second attempt clears it.
   *
   * The retry is safe by construction, not by convention: `verifyAndCredit`
   * CASes on `job_messages.status = 'pending-verification'` inside its own
   * transaction, so a call whose COMMIT actually landed before the ack was lost
   * finds the row already `verified` and returns `alreadyVerified: true`
   * carrying the counters and binding that first attempt committed. Re-applying
   * the delta is impossible either way.
   *
   * That argument covers every attempt but the last, whose error nothing
   * re-checks — and a connection-level fault is exactly the shape that loses
   * the ack on *all* of them, idempotent replays included (the no-op path
   * COMMITs too). So the exhausted path asks the row before reporting a
   * failure: `getVerifiedInbound` reads, transaction-free, whether a Tx C for
   * this seq committed. Without it a fully credited, fully bound job answers
   * `payment_unapplied` and invites a retry, and a caller who takes it pays
   * twice for one ask — the second payment growing the now-bound draw and
   * settling as revenue.
   *
   * The read runs on the pool that just failed those COMMITs, so it is retried
   * too, and a read that fails all the way through is reported as *unknown*
   * rather than as nothing: `CreditInboundExhaustedError.readError` is what
   * separates "checked the row, nothing landed" from "couldn't check", both on
   * the operator's log line and in the copy the caller acts on.
   */
  private async creditInbound(
    jobId: string,
    seq: number,
    credit: PaymentCreditDelta | null
  ): Promise<VerifyAndCreditResult> {
    const store = this.jobStore;
    if (!isStreamableJobStore(store)) {
      throw new Error("creditInbound requires a streamable job store");
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= CREDIT_INBOUND_ATTEMPTS; attempt++) {
      try {
        return await store.verifyAndCredit(jobId, seq, credit);
      } catch (err) {
        lastErr = err;
        if (attempt === CREDIT_INBOUND_ATTEMPTS) break;
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "credit_job_row_retry",
            job_id: jobId,
            seq,
            attempt,
            error: undefined,
          }
        );
        await new Promise((resolve) => setTimeout(resolve, CREDIT_INBOUND_BACKOFF_MS * attempt));
      }
    }
    // The read gets the same ladder for the same reason the writes did — see
    // `CREDIT_INBOUND_READ_ATTEMPTS`. A read that *fails* is not a read that
    // found nothing: it leaves the job's credit state unknown, so the failure
    // rides out on the error rather than being swallowed into the same silence
    // as a row that genuinely never committed.
    let landed: VerifyAndCreditResult | undefined;
    let readErr: unknown;
    for (let attempt = 1; attempt <= CREDIT_INBOUND_READ_ATTEMPTS; attempt++) {
      try {
        landed = await store.getVerifiedInbound(jobId, seq);
        readErr = undefined;
        break;
      } catch (err) {
        readErr = err;
        if (attempt === CREDIT_INBOUND_READ_ATTEMPTS) break;
        await new Promise((resolve) => setTimeout(resolve, CREDIT_INBOUND_BACKOFF_MS * attempt));
      }
    }
    if (landed) {
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "credit_job_row_recovered",
          job_id: jobId,
          seq,
          credit_id: landed.creditId,
          draw_id: landed.drawId,
          error: undefined,
        }
      );
      return landed;
    }
    throw new CreditInboundExhaustedError(lastErr, readErr);
  }

  /**
   * Answer a payment whose rail and ledger legs committed but whose job row
   * could not be written — every retry spent, the money real.
   *
   * The refusal names the credit the money landed on so the caller can act on
   * it directly, mirroring the short mid-job pay's 402 (`payment.ts`). It is a
   * 500 rather than a 402 on purpose: the payment was valid and was accepted,
   * so telling the caller it was insufficient would be a lie, and this is a
   * fault an operator should see in their 5xx rate. `retryable` is true because
   * the ask is genuinely still outstanding.
   *
   * Nothing is released here. The hold is left to the reconciler,
   * which makes the same decision — unbound draw ⇒ release, never settle — but
   * under the credit row's `FOR UPDATE`, after the job is terminal, where it
   * cannot race an in-flight COMMIT. Releasing from here would also be
   * irreversible: a released draw can be neither re-grown nor re-opened, so one
   * bad call would silently de-ledger every later top-up on the job.
   *
   * Whether the row was *read* is load-bearing on both surfaces. When the
   * post-exhaustion read-back failed as well, `credit_job_row_unwritten` says so
   * (`row_checked: false` plus the read's own error) instead of implying an
   * operator can trust the row is clean, and the caller gets the `"unconfirmed"`
   * copy rather than a flat "pay it again" it could be charged twice for.
   *
   * That copy overrides `display` as well as `hint`, on every branch including
   * the ledger-less one. `display` is the sentence an agent relays to its human
   * (repo convention: JSON carries the words, not just the facts), so a body
   * whose `hint` says the outcome is unknown while its `display` still asserts
   * the ask is outstanding is read as "pay again" by the audience that acts on
   * it — and a payment that did land is charged on top.
   */
  private async reportUnappliedPayment(
    job: ServerJob,
    inboundSeq: number,
    info: VerifiedIncomingPayment,
    err: unknown
  ): Promise<{ body: Record<string, unknown>; status: number }> {
    const funding = info.funding;
    // Only an exhausted Tx C knows whether the row was read; anything else
    // reaching here never got that far, so `false` is the honest answer.
    const readErr = err instanceof CreditInboundExhaustedError ? err.readError : undefined;
    const rowChecked = err instanceof CreditInboundExhaustedError && readErr === undefined;
    diagnosticConsole.error(
      {
        level: "error",
        event: "credit_job_row_unwritten",
        job_id: job.id,
        seq: inboundSeq,
        rail: info.paymentRail,
        paid_msats: info.paidMsats,
        credit_id: funding?.creditId ?? info.creditId,
        draw_id: info.drawId,
        error: undefined,
        // `false` means the job row's credit state is unknown, not that it is
        // clean — the difference between a payment that provably didn't land and
        // one nobody could ask about.
        row_checked: rowChecked,
        ...(readErr !== undefined && { read_error: errText(readErr) }),
      }
    );
    // Safe to run unconditionally, including when the row was never read: the
    // CAS is on `pending-verification`, so an inbound a Tx C did verify is left
    // alone rather than being marked failed on a guess.
    if (isStreamableJobStore(this.jobStore)) {
      await this.jobStore
        .markInboundFailed(job.id, inboundSeq, "payment_unapplied")
        .catch(() => undefined);
    }
    // Parity with the 402 path. On the shipped outbox wiring this is already
    // durable — `fundAndDraw` enqueued the deposit inside the rail transaction —
    // so this covers the `onCreditFunded` hook, not the money.
    this.reportCreditDeposit(funding);
    const reason = rowChecked ? "unapplied" : "unconfirmed";
    const held = this.unappliedCredit(funding, funding?.creditId, reason);
    // Both fields ride, always. `display` is what an agent hands its human
    // verbatim, so leaving it to the registry default would answer "the job's
    // payment request is still outstanding" inside a body whose `hint` says the
    // outcome is unknown — and ledger-less (no `held` to draw from) it would say
    // that on the surface that matters most, since there is no credit to name
    // and nothing else in the body to contradict it.
    const copy = held ?? unappliedCopy(reason, undefined);
    return {
      body: paymentErrorBody("payment_unapplied", {
        message: rowChecked
          ? `Payment of ${info.paidMsats} msats verified on ${info.paymentRail} but the job row could not be credited.`
          : `Payment of ${info.paidMsats} msats verified on ${info.paymentRail}; whether the job row was credited could not be determined.`,
        display: copy.display,
        hint: copy.hint,
        extra: {
          ...(held && {
            credit_id: held.credit_id,
            credited_micro: held.credited_micro,
            credit_currency: held.credit_currency,
          }),
        },
      }),
      status: 500,
    };
  }

  /**
   * Describe a deposit the job row never took, in the shape both the 201 and
   * the `payment_unapplied` 500 carry. `undefined` when the payment
   * ran ledger-less (no credit ledger wired, or the top-up preflight skipped) —
   * there is no credit to name, so the 201 carries no `credit` block and the
   * 500 takes its words from `unappliedCopy` directly.
   */
  private unappliedCredit(
    funding: CreditFundingReport | undefined,
    creditId: string | undefined,
    reason: UnappliedReason,
    /**
     * The unapplied slice, when it is smaller than the funding: a
     * clipped over-ask payment did buy part of the job, so reporting the whole
     * deposit would overstate what the caller can reclaim.
     */
    opts?: { creditedMicro?: number }
  ): UnappliedCredit | undefined {
    if (!funding || !creditId || funding.creditId !== creditId) return undefined;
    return {
      credit_id: creditId,
      credited_micro: opts?.creditedMicro ?? funding.amountMicro,
      credit_currency: funding.currency,
      ...unappliedCopy(reason, creditId),
    };
  }

  /** Book a mid-job top-up's funding as a deposit (the deposit-accounting rule). */
  private reportCreditDeposit(funding: CreditFundingReport | undefined): void {
    const onCreditFunded = this.opts.onCreditFunded;
    if (!funding || !onCreditFunded || !this.opts.dvmId) return;
    // Same builder as the reporter's outbox, so the override cannot report a
    // narrower deposit than the SDK-owned path.
    Promise.resolve(onCreditFunded(creditDepositPayload(this.opts.dvmId, funding))).catch(
      (err: unknown) => {
        diagnosticConsole.error(`[${funding.creditId}] Deposit reporting failed:`, err);
      }
    );
  }

  /**
   * Internal: build the BuildContextOpts shared between `createJob` and
   * `reactivateJob`. Centralised so persistence/terminal callbacks and the
   * NOTIFY-driven cross-machine wake stay in one place.
   */
  private buildContextOpts(job: ServerJob): Parameters<typeof buildContext>[1] {
    const jobStore = this.jobStore;
    job.idleTimeoutMs = this.descriptor.idleTimeout * 1000;
    return {
      mints: this.opts.mints,
      store: this.opts.store,
      env: this.opts.env,
      paymentMethods: this.opts.paymentMethods,
      x402: this.opts.x402,
      x402FacilitatorHealth: this.opts.x402FacilitatorHealth,
      mpp: this.opts.mpp,
      fxFetcher: this.opts.fxFetcher,
      onTerminal: () => this.handleJobTerminal(job),
      onYield: () => {
        this.startIdleTimer(job);
        return this.persistJob(job);
      },
      onCallerResume: () => this.startIdleTimer(job),
      onPaymentResume: () => retryJobSnapshot(() => this.persistJob(job)),
      subscribeNotifications: isStreamableJobStore(jobStore)
        ? (cb: () => void) => jobStore.subscribeNotifications(job.id, cb)
        : undefined,
      acceptedBalancePayment: this.opts.db && jobStore instanceof PostgresJobStore
        ? async (seq, amountMicro, currency) => {
            const { rowCount } = await this.opts.db!.query(
              `SELECT 1 FROM credit_balance_payments p
               JOIN job_messages m ON m.job_id=p.job_id AND m.seq=(p.response->>'seq')::bigint AND m.status='verified'
               JOIN job_messages a ON a.job_id=p.job_id AND a.seq=p.request_seq AND a.status='verified'
               WHERE p.job_id=$1 AND m.seq=$2 AND a.data->>'type'='payment-request'
                 AND (m.data->'content'->'credit'->>'request_seq')::bigint=p.request_seq
                 AND a.data->'content'->'credit'->>'amount_micro'=$3
                 AND a.data->'content'->'credit'->>'currency'=$4`,
              [job.id, seq, amountMicro === undefined ? null : String(amountMicro), currency ?? null]);
            return rowCount === 1;
          }
        : undefined,
      getCounters: isStreamableJobStore(jobStore) ? async () => {
        // Do not interpret an unpersisted yield as a paid ask. A balance payment
        // can allocate a different msat value while satisfying the exact fiat ask.
        await job.messageAppenderTail;
        return jobStore.getCounters(job.id);
      } : undefined,
      drawPool: this.opts.creditLedger ? () => this.resolveDrawPool(job) : undefined,
      pricingCurrency: this.pricingCurrency,
      claimForProcessing: isStreamableJobStore(jobStore)
        ? (resume) => {
            const pending = job.pendingPayment;
            return this.queueInputResume(job, async () => {
              if (!pending || job.pendingPayment !== pending || isTerminal(job.status)) return false;
              if (!(await this.claimLocalInput(job))) return false;
              if (job.pendingPayment !== pending || isTerminal(job.status)) return false;
              let resumed = false;
              await this.resumeClaimedPayment(job, async () => {
                if (!(await this.adoptPaymentMetadata(job, pending))) return;
                await resume?.();
                resumed = true;
              });
              return resumed;
            });
          }
        : undefined,
      onSuperseded: () => {
        // a reactivation replay won the single-execution claim while
        // this handler was suspended. Drop the local scaffold so a stale idle
        // timer can't later fire `cancelJobIdle` and clobber the winner, and
        // abort the parked handler so it stops doing paid work the
        // winner is already redoing.
        this.clearIdleTimer(job.id);
        this.unwatchDurableStatus(job.id);
        abortJob(job, "Job superseded by a reactivation replay");
        this._activeJobs.delete(job.id);
      },
    };
  }

  /**
   * Internal: what unit `ctx.requestPayment`'s auto-credit gate may measure this
   * job's remaining pool in.
   *
   * The regime is read off the DRAW, never off the job. Implicit N=1 is exactly
   * `credit_id === imp:<rail>:<draw_id>`, because `fundAndDraw` derives both
   * from the same rail payment id — a fact about a row that was written once
   * and never moves. The tempting alternative, comparing `job.payment_tx_hash`
   * against `drawSettlementRef` (what the mid-job preflight does to inherit
   * `drawBasis`), silently rots: Tx C overwrites that column on every mid-job
   * credit, and a payment whose ledger leg was skipped — a cross-rail top-up,
   * an fx outage, a draw already resolved — leaves the rail's own reference
   * there, so an explicit-draw job would read as implicit from then on.
   *
   * Never throws, and never answers `rail` on a guess. `rail` is claimed only
   * where `withDrawBasis` demonstrably left `PaymentInfo.paidMsats` alone — no
   * draw at all, or a draw carrying no rail value to overlay it with. A job that
   * drew and whose pool this can't read or denominate answers `unpriced`, which
   * the gate declines to auto-credit from: the msat figure it would otherwise
   * fall back on is a slice of the credit's rail value at a ratio pinned
   * whenever that credit was funded, so it cannot safely fund a new ask.
   */
  private async hasAcceptedBalancePayment(jobId: string): Promise<boolean> {
    return this.jobStore instanceof PostgresJobStore && !!this.opts.db && !!(await this.opts.db.query(
      "SELECT 1 FROM credit_balance_payments WHERE job_id=$1 LIMIT 1", [jobId])).rowCount;
  }

  private async resolveDrawPool(job: ServerJob): Promise<DrawPool> {
    const ledger = this.opts.creditLedger;
    // No ledger, or a job that never drew: `paidMsats` is the rail's own
    // traffic. The only shape that answers with no `creditCurrency` at all,
    // which is what tells `ctx.requestPayment` to seed the ask denomination
    // from the DVM's declaration instead.
    if (!ledger || !job.creditId || !job.drawId) return { basis: "rail" };
    let draw: DrawRecord | undefined;
    try {
      draw = await ledger.getDraw({ creditId: job.creditId, drawId: job.drawId });
    } catch (err) {
      this.warnDrawPool(
        job,
        "ledger_unreachable",
        err instanceof Error ? err.message : String(err)
      );
      return { basis: "unpriced" };
    }
    // The job carries a draw id the ledger has no row for. Nothing here can be
    // concluded about `paidMsats`, so conclude nothing.
    if (!draw) {
      this.warnDrawPool(job, "draw_not_found");
      return { basis: "unpriced" };
    }
    // `creditCurrency` rides every arm below, including the two that carry no
    // spendable pool. The gate can't use it — but the ask still has
    // to be *pinned* in the credit's denomination for the mid-job cap to mean
    // anything, and an implicit N=1 credit (the ordinary per-job payment) takes
    // the `rail` arm. Erasing it here is what made the cap unenforceable on
    // essentially every job of a DVM that prices in anything but USD.
    const { rail, drawMsats, creditCurrency } = draw.railValue;
    // Legacy rail acceptance overlays only positive allocations. A durable
    // balance authorization instead spends exact fiat even when its rail slice
    // rounds to zero; its accepted fact keeps that pool denominated in fiat.
    if (!rail || drawMsats <= 0) {
      const acceptedBalance = await this.hasAcceptedBalancePayment(job.id);
      if (!acceptedBalance) return { basis: "rail", creditCurrency: creditCurrency ?? undefined };
    }
    // Schema-impossible (`credits.currency` is NOT NULL) — the join's type
    // admits it, and a pool with no denomination can't be compared in.
    if (!creditCurrency) {
      this.warnDrawPool(job, "credit_currency_missing");
      return { basis: "unpriced" };
    }
    // Lightning funds credits but never attaches to a job, so a rail
    // outside the attach set can only be explicit — `implicitCreditId` takes the
    // attach rails for that reason, and narrowing through the list keeps the
    // claim checked rather than cast.
    const attachRail = ATTACH_RAILS.find((r) => r === rail);
    if (attachRail && draw.creditId === implicitCreditId(attachRail, draw.drawId)) {
      return { basis: "rail", creditCurrency };
    }
    return { basis: "draw", amountMicro: draw.amountMicro, currency: creditCurrency };
  }

  /** Internal: structured warn for the one path that can't price a drawn job's pool. */
  private warnDrawPool(job: ServerJob, reason: string, error?: string): void {
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "draw_pool_unpriced",
        reason,
        jobId: job.id,
        creditId: job.creditId,
        drawId: job.drawId,
        ...(error !== undefined && { error }),
      }
    );
  }

  /**
   * Issue the signed receipt for a job that has reached a terminal status
   * Idempotent and safe to call from every terminal path — the
   * store owns both the sequence allocation and the write-once persist, so
   * two machines racing on the same job converge on identical bytes and burn
   * exactly one sequence number.
   *
   * Never throws. A receipt is evidence about a job, not part of delivering
   * it: if signing or persistence fails we log structured and serve the
   * response without one (same posture as the `cashu_refund_failed` branch in
   * `context.ts`). The gap is visible to callers — the `seq` series skips a
   * number — which is precisely the completeness signal receipts exist for.
   */
  private async observePaidCompletion(record: JobRecord): Promise<void> {
    const callback = this.opts.onPaidJobCompleted;
    if (!callback || record.status !== "completed" || !record.paymentRail ||
        !record.creditId || !record.drawId || !this.opts.creditLedger) return;
    const draw = await this.opts.creditLedger.getDraw({ creditId: record.creditId, drawId: record.drawId }).catch(() => undefined);
    // Only settled accounting is evidence. paidMsats can include dev_auto counters.
    const rail = draw?.railValue.rail;
    const currency = draw?.railValue.creditCurrency;
    if (draw?.status !== "settled" || draw.amountMicro <= 0 || !currency ||
        !rail || !isFundingRail(rail)) return;
    const testFunds = rail === "lightning" ? null : this.opts.paymentMode?.rails[rail].testFunds ?? null;
    try {
      await callback({ jobId: record.id, rail, amountMicro: draw.amountMicro, currency, testFunds });
    } catch (error) {
      diagnosticConsole.error(`[${record.id}] Paid completion observer failed:`, error);
    }
  }

  async issueReceipt(record: JobRecord): Promise<JobReceipt | undefined> {
    if (record.receipt) {
      await this.observePaidCompletion(record);
      return record.receipt;
    }
    if (!isReceiptableStatus(record.status)) return undefined;
    // resolve the credit draw FIRST — settle on completed, release
    // on failed/cancelled — so the receipt's `credit` block countersigns the
    // post-resolution balance. Runs on every terminal funnel path (all of
    // them converge here), receipt key or not, so pending holds never leak.
    // A resolution failure leaves the receipt unissued: the read-path
    // `ensureReceipt` retry then re-attempts BOTH (resolution is idempotent).
    let credit: ReceiptCredit | undefined;
    try {
      credit = await this.resolveCreditDraw(record);
    } catch (_err) {
      diagnosticConsole.error(
        {
          level: "error",
          event: "credit_resolve_failed",
          jobId: record.id,
          creditId: record.creditId,
          drawId: record.drawId,
          status: record.status,
          error: undefined,
        }
      );
      return undefined;
    }
    const issuer = this.opts.receiptIssuer;
    if (!issuer) {
      await this.observePaidCompletion(record);
      return undefined;
    }
    if (!isReceiptIssuingStore(this.jobStore)) return undefined;
    const store = this.jobStore;
    try {
      // Two commits, not one: the sequence number lands on the job row here,
      // the signed bytes land below. A crash in between leaves a claimed-but
      // -unused number — which is why the claim is idempotent per job and why
      // `ensureReceipt` re-attempts on the read paths. Without that retry the
      // stranded number would read as a permanent suppression gap.
      const seq = await store.claimReceiptSeq(record.id);
      const receipt = issuer.issue(record, seq, undefined, credit);
      const saved = (await store.saveReceipt(record.id, receipt)) ?? receipt;
      await this.observePaidCompletion(record);
      return saved;
    } catch (_err) {
      diagnosticConsole.error(
        {
          level: "error",
          event: "receipt_issue_failed",
          jobId: record.id,
          status: record.status,
          error: undefined,
        }
      );
      return undefined;
    }
  }

  /** Build the common settle/release args, adding the hosted release outbox when wired. */
  private drawResolutionArgs(creditId: string, drawId: string) {
    const enqueue = this.opts.enqueueCreditDrawRelease;
    const dvmId = this.opts.dvmId;
    return {
      creditId,
      drawId,
      ...(enqueue && dvmId ? { releaseOutbox: { dvmId, enqueue } } : {}),
    };
  }

  /**
   * Settle or release a terminal job's credit draw: `completed`
   * settles (the hold becomes a real debit); `failed`/`cancelled` releases
   * (the hold evaporates — "no debit on job failure", mechanically
   * superseding the 974 no-op refund for credit-paid jobs, including
   * the `ctx.fail` path and the stale-sweeper reap). Idempotent — a replayed
   * resolution returns the recorded state. Returns the `ReceiptCredit` block
   * for the receipt: `balance_after` is the recorded draw trajectory for a
   * settled draw, and the restored available balance for a released one.
   */
  private async resolveCreditDraw(record: JobRecord): Promise<ReceiptCredit | undefined> {
    const ledger = this.opts.creditLedger;
    if (!ledger || !record.creditId || !record.drawId) return undefined;
    const args = this.drawResolutionArgs(record.creditId, record.drawId);
    try {
      const res = this.settlesDraw(record.status)
        ? await ledger.settle(args)
        : await ledger.release(args);
      return {
        credit_id: res.creditId,
        draw_id: res.drawId,
        amount: res.amountMicro,
        balance_after: res.status === "settled" ? res.balanceAfterMicro : res.availableMicro,
        ledger_seq: res.ledgerSeq,
      };
    } catch (err) {
      // A draw already resolved to the OTHER state (e.g. a cross-machine race
      // between a cancel and a completion — the terminal-sticky save decides
      // the winner) surfaces as invalid_draw_state. The ledger state is
      // authoritative and final; attest the recorded draw rather than wedging
      // receipt issuance forever.
      if (err instanceof CreditLedgerError && err.code === "invalid_draw_state") {
        const rec = await ledger.getDraw(args);
        if (!rec) return undefined;
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "credit_resolve_state_mismatch",
            jobId: record.id,
            creditId: record.creditId,
            drawId: record.drawId,
            jobStatus: record.status,
            drawStatus: rec.status,
          }
        );
        return {
          credit_id: rec.creditId,
          draw_id: rec.drawId,
          amount: rec.amountMicro,
          balance_after: rec.balanceAfterMicro,
          ledger_seq: rec.ledgerSeq,
        };
      }
      throw err;
    }
  }

  /**
   * The one place a terminal job's status becomes a ledger verb:
   * `completed` settles the hold into a real debit, `failed`/`cancelled`
   * release it. Read by the in-line funnel (`resolveCreditDraw`) and by the
   * late reconciler (`reconcileTerminalDraw`) — two paths that must never
   * disagree about what an outcome means for the caller's money.
   */
  private settlesDraw(status: JobStatus): boolean {
    return status === "completed";
  }

  /**
   * Sign a locally-held terminal job's receipt and mirror it onto the
   * in-memory job, so the read paths served out of `activeJobs` during the
   * cleanup window hand back the same bytes as a cross-machine re-read.
   */
  private async attachReceipt(job: ServerJob): Promise<void> {
    const record = await this.jobStore.get(job.id);
    if (!record || !isTerminal(record.status)) return;
    const receipt = await this.issueReceipt(record);
    if (receipt) job.receipt = receipt;
  }

  /**
   * Read-path repair for a terminal job carrying no receipt, for
   * either an in-memory job or a store record. Free in the steady state — it
   * returns on the `receipt` check without touching the store — so it costs
   * only on the cases it exists for:
   *
   * - **A crash between the two store calls.** `claimReceiptSeq` commits the
   * sequence number to the job row before `saveReceipt` writes the bytes; a
   * process death in that window would otherwise strand that number
   * forever, and a permanent gap is indistinguishable from the deliberate
   * suppression `seq` exists to expose. Re-issuing here reuses the already
   * committed number (the claim is idempotent per job) rather than
   * allocating a second one.
   * - **A transient store failure** at the terminal: `issueReceipt` logs
   * `receipt_issue_failed` and returns nothing rather than failing the job,
   * so the next read retries.
   * - **Jobs that terminated before the DVM had a receipt key.** They pick one
   * up on first read, with `issued_at` reflecting when it was signed.
   */
  async ensureReceipt(target: ServerJob | JobRecord): Promise<void> {
    if (target.receipt) {
      if (isTerminal(target.status)) await this.reportTerminalJob(target.id);
      return;
    }
    const record = "listeners" in target ? await this.jobStore.get(target.id) : target;
    if (!record || !isTerminal(record.status)) return;
    const receipt = await this.issueReceipt(record);
    if (receipt) target.receipt = receipt;
    if (isTerminal(target.status)) await this.reportTerminalJob(target.id);
  }

  /** Commit the terminal snapshot before resolving money and signing its durable evidence. */
  private async finalizeTerminal(job: ServerJob): Promise<void> {
    await this.persistJob(job);
    await this.attachReceipt(job);
    await this.reportJobCost(job);
    await this.reportTerminalJob(job.id);
  }

  /**
   * Issue a receipt for a job this process doesn't hold in `activeJobs` — a
   * cross-machine cancel, or a row the stale sweeper just reaped. Re-reads the
   * record so the receipt is built from the committed terminal row rather than
   * from whatever the caller happened to have in hand.
   */
  async issueReceiptForStoredJob(jobId: string): Promise<JobReceipt | undefined> {
    // No issuer guard here: `issueReceipt` also resolves the
    // credit draw, which must run on reaped/cross-machine terminals even on
    // a DVM without a receipt key — a pending hold must never leak.
    if (!this.opts.receiptIssuer && !this.opts.creditLedger) return undefined;
    const record = await this.jobStore.get(jobId).catch(() => undefined);
    if (!record) return undefined;
    const receipt = await this.issueReceipt(record);
    // The job may still be live in this process's `activeJobs` (the adopting
    // machine's path), so mirror the bytes there too.
    const active = this._activeJobs.get(jobId);
    if (active && receipt) active.receipt = receipt;
    return receipt;
  }

  /**
   * Finish accounting for a terminal written directly to the store — the
   * stale reaper and a cancel handled on a different machine.
   */
  async finalizeStoredTerminal(jobId: string): Promise<JobReceipt | undefined> {
    const receipt = await this.issueReceiptForStoredJob(jobId);
    const record = await this.jobStore.get(jobId).catch(() => undefined);
    if (record && isTerminal(record.status)) {
      await this.reportJobCost(record);
      await this.reportTerminalJob(jobId);
    }
    return receipt;
  }

  private async reportTerminalJob(jobId: string): Promise<void> {
    try {
      const callback = this.opts.onJobTerminal;
      const dvmId = this.opts.dvmId;
      if (!callback || !dvmId) return;
      const record = await this.jobStore.get(jobId);
      if (!record || !isReceiptableStatus(record.status) || record.timingKnown === false || record.terminalAtMs === undefined ||
          (record.status !== "completed" && !record.endedBy)) return;
      // Resolve money and persist receipt evidence before exposing the terminal event.
      const receipt = await this.issueReceipt(record);
      if (this.opts.receiptIssuer && !receipt) return;
      if (record.creditId && record.drawId && this.opts.creditLedger) {
        const draw = await this.opts.creditLedger.getDraw({creditId: record.creditId, drawId: record.drawId});
        if (!draw || draw.status === "pending") return;
      }
      await callback({
        dvmId, jobId: record.id, capability: record.capability, outcome: record.status,
        endedBy: record.status === "completed" ? null : record.endedBy ?? "provider",
        paid: record.paidMsats > 0 || (record.nativeAmount ?? 0) > 0 || !!record.drawId,
        acceptedAtMs: record.createdAt,
        terminalAtMs: record.terminalAtMs,
        callerWaitMs: record.callerWaitMs ?? 0,
        receiptSeq: receipt?.seq ?? null,
      });
      if ("markTerminalReported" in this.jobStore) {
        await (this.jobStore as JobStore & { markTerminalReported(jobId: string): Promise<void> }).markTerminalReported(jobId);
      }
    } catch (error) {
      diagnosticConsole.error(`[${jobId}] Terminal reporting failed:`, error);
    }
  }

  private terminalReportRecoveryCursor?: string;

  private async recoverTerminalReports(): Promise<void> {
    const store = this.jobStore;
    const dvmId = this.opts.dvmId;
    if (!this.opts.onJobTerminal || !dvmId || !("listUnreportedTerminalReports" in store)) return;
    const recovery = store as JobStore & {
      listUnreportedTerminalReports(dvmId: string, capabilities: string[] | null, afterJobId?: string): Promise<JobRecord[]>;
    };
    const records = await recovery.listUnreportedTerminalReports(dvmId, this.capabilityNames(), this.terminalReportRecoveryCursor);
    for (const record of records) await this.reportTerminalJob(record.id);
    this.terminalReportRecoveryCursor = records.length === 100 ? records[records.length - 1].id : undefined;
  }

  private async handleJobTerminal(job: ServerJob): Promise<void> {
    this.clearIdleTimer(job.id);
    // sign the receipt before the cleanup timer starts, so a caller
    // polling inside the 60s window is served from `activeJobs` with the
    // receipt already attached. `context.ts` persisted the terminal snapshot
    // immediately before invoking this, so no second save is needed.
    //
    // ordering: this also settles the credit draw, and draws ARE the
    // revenue events — so it has to run before `bookRevenue`, not after.
    if (await this.adoptDurableTerminal(job)) return;
    const durable = await this.jobStore.get(job.id);
    // A failed yield save must not settle a draw or report completion from an
    // in-memory terminal that never committed. Retry that save before accounting.
    if (!durable || !isTerminal(durable.status)) await this.persistJob(job);
    await this.attachReceipt(job);
    // Every `false` that costs a revenue booking logs from inside
    // `bookRevenue`; the return value also distinguishes the jobs whose
    // declared cost needs its own zero-revenue event.
    const booked = await this.bookRevenue(job);
    if (!booked) await this.reportJobCost(job);
    await this.reportTerminalJob(job.id);
    this.scheduleCleanup(job);
  }

  /**
   * Re-enqueue terminal cost-only rows left between the job commit and outbox
   * insert. The marker advances only after `onJobCost` resolves, which for the
   * SDK reporter means the local durable insert has committed; a crash after
   * that insert but before the marker can duplicate a payload, but the
   * revisioned platform contract makes that replay harmless.
   */
  async recoverTerminalCosts(): Promise<{
    examined: number;
    queued: number;
    complete: boolean;
  }> {
    const store = this.jobStore;
    const dvmId = this.opts.dvmId;
    await this.recoverTerminalReports();
    if (!dvmId || !this.opts.onJobCost || !isTerminalCostRecoveryStore(store)) {
      return { examined: 0, queued: 0, complete: true };
    }
    if (this.terminalCostRecoveryInFlight) {
      return { examined: 0, queued: 0, complete: false };
    }

    this.terminalCostRecoveryInFlight = true;
    let examined = 0;
    let queued = 0;
    let cursor = this.terminalCostRecoveryResumeAfter;
    try {
      for (let page = 0; page < TERMINAL_COST_RECOVERY_MAX_PAGES; page++) {
        const candidates = await store.listUnreportedTerminalCosts({
          dvmId,
          limit: TERMINAL_COST_RECOVERY_BATCH,
          ...(cursor ? { afterJobId: cursor } : {}),
        });
        for (const record of candidates) {
          examined++;
          cursor = record.id;
          if (await this.reportJobCost(record)) queued++;
        }
        if (candidates.length < TERMINAL_COST_RECOVERY_BATCH) {
          this.terminalCostRecoveryResumeAfter = undefined;
          if (examined > 0) {
            diagnosticConsole.log(
              {
                level: "info",
                event: "terminal_cost_recovery_complete",
                dvmId,
                examined,
                queued,
              }
            );
          }
          return { examined, queued, complete: true };
        }
      }

      this.terminalCostRecoveryResumeAfter = cursor;
      diagnosticConsole.warn(
        {
          level: "terminal_cost_recovery_truncated",
          dvmId,
          examined,
          queued,
          resumeAfterJobId: cursor,
        }
      );
      return { examined, queued, complete: false };
    } finally {
      this.terminalCostRecoveryInFlight = false;
    }
  }

  /** Report the latest declared-cost state only when no revenue event carried it. */
  private async reportJobCost(job: RevenueBookableJob): Promise<boolean> {
    const onJobCost = this.opts.onJobCost;
    if (
      !onJobCost ||
      (job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled")
    ) {
      return false;
    }
    const costRevision =
      job.costRevision ??
      (job.costAmountMicro !== undefined && job.costCurrency !== undefined ? 0 : undefined);
    if (costRevision === undefined) return false;

    const payload: JobCostReportPayload = {
      dvmId: this.opts.dvmId ?? "",
      jobId: job.id,
      ...(job.capability ? { capability: job.capability } : {}),
      outcome: job.status,
      costRevision,
      cost:
        job.costAmountMicro !== undefined && job.costCurrency !== undefined
          ? { amountMicro: job.costAmountMicro, currency: job.costCurrency }
          : null,
    };
    try {
      await onJobCost(payload);
      if (isTerminalCostRecoveryStore(this.jobStore)) {
        const marked = await this.jobStore.markTerminalCostReported(job.id, costRevision);
        if (!marked) {
          // The row changed to a fresher revision while this payload queued.
          // Leave it eligible so the next pass sends the new state.
          return false;
        }
      }
    } catch (err) {
      diagnosticConsole.error(`[${job.id}] Job cost reporting failed:`, err);
      return false;
    }
    return true;
  }

  /**
   * Report a completed paid job's revenue under its durable job identity.
   * Fire-and-forget — the `RevenueReporter` owns persistence and retry.
   *
   * For a **credit-backed** job the revenue event is the *settled draw* (spec
   * §10), and since the behavior was introduced the sats figure corrects the job's mirror of that
   * draw against the draw itself: `withDrawBasis` stamps the job when the
   * payment lands, but a Bitcoin credit's settle re-prices the draw against
   * the funding lots it consumed. The correction is a delta, because a job's
   * counter can carry legs no draw ever absorbed — except where the draw's
   * forecast was zero and the counter therefore never held a component to
   * correct. The event is dated at settlement rather than at report time. A
   * released draw — the failed/cancelled path — is deliberately unreachable
   * here, which is what makes "no debit on job failure" true in the books as
   * well as the ledger.
   *
   * For everything else (free-then-paid jobs, isolate-shaped flows, a DVM
   * whose price couldn't be fiat-denominated) nothing changes: the pre-credits
   * payload is reported verbatim.
   *
   * Takes the fields rather than a `ServerJob` so the reconciler — a
   * background sweep that holds no in-process job — books through this exact
   * path off the row it read. `paymentTxHash` is passed **verbatim**, never
   * recomputed as a `drawSettlementRef`: it is the same column the in-line
   * funnel reads, so the two bookings are byte-identical by construction and
   * the platform's `UNIQUE (rail, tx_hash)` dedupes them. Deriving it instead
   * would diverge on an implicit N=1 job (whose row carries the rail's own
   * reference) and on any job whose column a mid-job top-up overwrote — the
   * same rot `resolveDrawPool` documents as the reason not to read regime off
   * this column.
   *
   * Returns whether the report was handed to `onJobCompleted`, so a caller
   * that logs the booking says what actually happened rather than what it
   * assumed — the guards below still drop legitimate shapes (a free job, a
   * DVM with no reporter). Every drop that costs a booking logs first.
   *
   * The rail check sits **below** the draw re-read, not in the entry guard
   * a settled draw the terminal can't report under is a real debit
   * with no revenue event, permanently overstating outstanding liability
   * (`deposits − draw revenue`), and it used to return here in silence. Placed
   * after the re-read, `revenue_skipped_no_rail` can name the draw and its
   * amount, and can distinguish the four causes — see its `reason` below.
   */
  private async bookRevenue(job: RevenueBookableJob): Promise<boolean> {
    const onJobCompleted = this.opts.onJobCompleted;
    const onRevenueSkippedNoRail = this.opts.onRevenueSkippedNoRail;
    if (!onJobCompleted && !onRevenueSkippedNoRail) return false;
    if (job.status !== "completed") return false;

    let credit: Record<string, unknown> = {};
    // `null` = a legacy row written before recorded a rail.
    // `undefined` = the block below never ran, which on a job that carries a
    // draw can only mean this manager holds no `creditLedger` — a failed
    // `getDraw` returns above as `revenue_skipped_unsettled_draw`, and
    // `railValue.rail` is `string | null`, never `undefined`. That state is
    // unreachable through `createDVMServer`, which defaults the ledger to a
    // `MemoryCreditLedger` before constructing this class; the only door is a
    // host that builds the exported `JobManager` itself. A builder who meant
    // to wire Postgres and didn't lands on that memory default instead, and
    // its empty `getDraw` after a restart is the skip above, not the one below.
    let creditRail: string | null | undefined;
    let drawAmountMicro: number | undefined;
    let bookedMsats = job.paidMsats;
    if (job.creditId && job.drawId && this.opts.creditLedger) {
      const args = { creditId: job.creditId, drawId: job.drawId };
      const draw = await this.opts.creditLedger.getDraw(args).catch(() => undefined);
      if (draw?.status !== "settled") {
        // `attachReceipt` above settles every completed job's draw, so getting
        // here means that resolution failed (already logged loud as
        // `credit_resolve_failed`). Booking an unsettled hold as revenue would
        // recognise money the ledger still says is held — skip and say so.
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "revenue_skipped_unsettled_draw",
            jobId: job.id,
            creditId: job.creditId,
            drawId: job.drawId,
            drawStatus: draw?.status ?? "missing",
          }
        );
        return false;
      }
      creditRail = draw.railValue.rail;
      drawAmountMicro = draw.amountMicro;
      // the settled draw is the authority on what the *draw* was
      // worth. On the Bitcoin rails the settle re-prices it off the funding
      // lots it actually consumed, so the pooled slice `allocateDrawValue`
      // stamped when the hold was placed — which could not yet know which
      // deposit the draw would take — is a forecast the ledger has since
      // corrected. Booking the forecast leaves a residue between sats revenue
      // and sats received on a credit topped up at a second rate. The job row
      // and its receipt keep it deliberately: they attest what the caller's
      // payment was worth when it landed, which is the question they were
      // asked.
      //
      // Applied as a **delta**, not a substitution. `job.paidMsats` is a sum
      // of legs, and only the legs that reached the ledger are inside the
      // draw's allocation: the "degrades rather than refusing money" paths
      // (`credit-midjob-topup.test.ts`) take a mid-job payment that writes no
      // ledger row at all — a cross-rail top-up, an exact top-up on a
      // channel-bound credit, a top-up on a draw that already settled — and
      // `withDrawBasis` leaves those legs the rail's own msats. Replacing the
      // whole figure would book those sats nowhere; correcting this draw's
      // component leaves them where they are.
      //
      // A **zero forecast** is the one shape where the counter holds a figure
      // the ledger never allocated, so there is nothing to subtract:
      // `withDrawBasis` and `recordedDrawPayment` (`app.ts:4314`) both overlay
      // only a positive allocation, leaving the leg at the rail's own msats —
      // the ask. Not a hypothetical on an upgraded host: a legacy multi-rate
      // credit whose pooled `msats_remaining` has clamped to 0 (legacy
      // settles decremented it by the blend while the lots shed the cheaper
      // FIFO figure) forecasts 0 on every draw while the lots still price the
      // settle, so booking the counter would preserve an unbacked ask value
      // straight through the upgrade. The settled figure replaces the total
      // there, which does give up the delta's one virtue on that one credit —
      // a no-ledger-row top-up gets absorbed with the ask — against an
      // alternative that books a price no deposit backs on every job it runs.
      //
      // A credit with no sats basis at all allocates nothing and re-prices
      // nothing (`isInKindDepletion` is false on basisless lots): both figures
      // are 0 and the counter stands. And on a draw the settle never re-priced
      // the delta is a no-op, `allocatedMsats` reading back as `drawMsats`.
      if (draw.allocatedMsats > 0) {
        bookedMsats = Math.max(0, job.paidMsats - draw.allocatedMsats + draw.railValue.drawMsats);
      } else if (draw.railValue.drawMsats > 0) {
        bookedMsats = draw.railValue.drawMsats;
      }
      credit = {
        creditId: draw.creditId,
        drawId: draw.drawId,
        drawAmountMicro: draw.amountMicro,
        creditCurrency: draw.railValue.creditCurrency ?? undefined,
        fundingRef: draw.railValue.fundingRef ?? undefined,
        settledAt: draw.resolvedAt ?? undefined,
      };
    }

    if (job.paidMsats <= 0 && !(drawAmountMicro !== undefined && drawAmountMicro > 0 &&
        typeof credit.creditCurrency === "string" && creditRail && isFundingRail(creditRail))) return false;

    if (!job.paymentRail) {
      // A job with no draw and no rail is a legitimately free/unpaid shape —
      // nothing was debited, so nothing is missing. Only a job that drew is a
      // loss, and wherever the draw was read it is confirmed `settled`, so
      // there are no false positives. Read off the job's own record rather
      // than `credit`, so a job whose draw this manager has no ledger to read
      // still reports rather than vanishing — the one arm below where the
      // debit is unconfirmed, and where the amount fields are absent with it.
      if (job.creditId && job.drawId) {
        const creditCurrency =
          typeof credit.creditCurrency === "string" ? credit.creditCurrency : undefined;
        const reason: RevenueSkippedNoRailPayload["reason"] =
          creditRail === undefined
            ? "ledger_not_configured"
            : creditRail === null
              ? "credit_rail_null"
              : isFundingRail(creditRail)
                ? "job_rail_missing"
                : "credit_rail_unrecognized";
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "revenue_skipped_no_rail",
            jobId: job.id,
            creditId: job.creditId,
            drawId: job.drawId,
            drawAmountMicro,
            creditCurrency,
            paidMsats: job.paidMsats,
            creditRail: creditRail ?? null,
            // Four distinct causes needing four distinct fixes, so none of them
            // is the else-branch: the credit predates and has no rail
            // (`credit_rail_null`); it carries one this build doesn't list, the
            // sibling class (`credit_rail_unrecognized`); the credit's
            // rail is perfectly good and it is the *job row* that lost its own
            // (`job_rail_missing`), which no change to the ledger would fix; or
            // this manager was built with no `creditLedger` to read the draw
            // with (`ledger_not_configured`, whose one door is documented at
            // the declaration above) — a host-wiring fault rather than a
            // database one, and the only arm where the debit is reported on
            // the job row's word rather than the ledger's.
            reason,
          }
        );
        if (onRevenueSkippedNoRail) {
          Promise.resolve(
            onRevenueSkippedNoRail({
              dvmId: this.opts.dvmId ?? "",
              jobId: job.id,
              creditId: job.creditId,
              drawId: job.drawId,
              paidMsats: job.paidMsats,
              drawAmountMicro,
              creditCurrency,
              creditRail: creditRail ?? null,
              reason,
            })
          ).catch((err: unknown) => {
            diagnosticConsole.error(`[${job.id}] Revenue skip alert reporting failed:`, err);
          });
        }
      }
      return false;
    }

    if (!onJobCompleted) return false;

    Promise.resolve(
      onJobCompleted({
        dvmId: this.opts.dvmId ?? "",
        jobId: job.id,
        // Legacy Postgres rows surface a missing capability as `""`. Keep
        // that absence distinct from every real capability name on the wire.
        ...(job.capability ? { capability: job.capability } : {}),
        paidMsats: bookedMsats,
        paymentMint: job.paymentMint,
        rail: job.paymentRail,
        paymentTxHash: job.paymentTxHash,
        nativeAmount: job.nativeAmount,
        nativeAsset: job.nativeAsset,
        cashuFlow: job.cashuFlow,
        // Absent unless the handler declared one, and absent is a fact: the
        // platform shows "no costs reported" rather than a zero cost and a
        // 100% margin. Both halves or neither — a bare amount
        // in an unnamed currency is not a cost.
        ...(job.costAmountMicro !== undefined && job.costCurrency !== undefined
          ? { cost: { amountMicro: job.costAmountMicro, currency: job.costCurrency } }
          : {}),
        ...credit,
      })
    ).catch((err: unknown) => {
      diagnosticConsole.error(`[${job.id}] Revenue reporting failed:`, err);
    });
    return true;
  }

  /** Schedule job removal from activeJobs after a delay so clients can still poll final status. */
  scheduleCleanup(job: ServerJob): void {
    this.clearIdleTimer(job.id);
    // Every terminal path funnels through here, and a terminal job has nothing
    // left to adopt — drop the NOTIFY subscription now rather than 60s later.
    this.unwatchDurableStatus(job.id);
    const timer = setTimeout(() => {
      this._activeJobs.delete(job.id);
      this.cleanupTimers.delete(job.id);
    }, 60_000);
    this.cleanupTimers.set(job.id, timer);
  }

  shutdown(): void {
    for (const [id] of this.idleTimers) {
      this.clearIdleTimer(id);
    }
    for (const [id, timer] of this.cleanupTimers) {
      clearTimeout(timer);
      this.cleanupTimers.delete(id);
    }
    for (const [id, timer] of this.terminalCostHandoffRetryTimers) {
      clearTimeout(timer);
      this.terminalCostHandoffRetryTimers.delete(id);
    }
    for (const id of [...this.statusWatchers.keys()]) {
      this.unwatchDurableStatus(id);
    }
    if (this.accumulatorMonitor) {
      this.accumulatorMonitor.stop();
      this.accumulatorMonitor = undefined;
    }
    if (this.staleSweepTimer) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.orphanDrawSweepTimer) {
      clearInterval(this.orphanDrawSweepTimer);
      this.orphanDrawSweepTimer = undefined;
    }
    if (this.terminalCostRecoveryTimer) {
      clearInterval(this.terminalCostRecoveryTimer);
      this.terminalCostRecoveryTimer = undefined;
    }
    if (this.jobRetentionBootTimer) {
      clearTimeout(this.jobRetentionBootTimer);
      this.jobRetentionBootTimer = undefined;
    }
    if (this.jobRetentionSweepTimer) {
      clearInterval(this.jobRetentionSweepTimer);
      this.jobRetentionSweepTimer = undefined;
    }
    // Hand the ledger's sweep claim back, so a host re-booted over the same
    // ledger in this process sweeps again instead of silently never starting.
    if (this.orphanSweepClaimed && this.opts.creditLedger) {
      ORPHAN_SWEEP_CLAIMS.delete(this.opts.creditLedger);
      this.orphanSweepClaimed = false;
    }
  }
}

/**
 * Sentinel thrown by `parseInput` when an `inputSchema` is declared but the
 * request body provides neither `body.data` nor a non-empty `body.input`.
 * The route handler maps this to `invalid_input` with a hint at `/v1/info`.
 */
export class MissingStructuredInputError extends Error {
  constructor() {
    super("Request requires either body.data (structured) or body.input (JSON-encoded string)");
    this.name = "MissingStructuredInputError";
  }
}

/**
 * Thrown by `reactivateJob` when the descriptor declares auth but
 * the capability has no input schema for the auth scheme to re-verify
 * against. Mirrors `AuthSchemaError` in `app.ts` on the submit path: this is
 * always a builder-side wiring bug, not a runtime tamper signal.
 */
export class ReactivationAuthSchemaError extends Error {
  constructor(
    readonly jobId: string,
    readonly capability: string
  ) {
    super(
      `Cannot re-verify auth on reactivation: capability "${capability}" has no input schema (jobId=${jobId})`
    );
    this.name = "ReactivationAuthSchemaError";
  }
}

/**
 * Thrown by `creditInbound` when Tx C has spent every attempt,
 * carrying what the post-exhaustion read-back was able to establish.
 *
 * `writeError` is the last `verifyAndCredit` failure — the one the message and
 * the 5xx are built from, so it is also this error's own message. `readError`
 * is set **only** when `getVerifiedInbound` failed too, and that presence is the
 * whole point: without it "the row says nothing landed" and "nobody could ask
 * the row" collapse into one indistinguishable answer, and both the operator's
 * log line and the caller's copy would assert the first while living in the
 * second.
 */
class CreditInboundExhaustedError extends Error {
  constructor(
    readonly writeError: unknown,
    readonly readError: unknown
  ) {
    super(errText(writeError), { cause: writeError });
    this.name = "CreditInboundExhaustedError";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a verified mid-job payment isn't charged to the job. */
type UnappliedReason = "unapplied" | "unbound" | "unconfirmed" | "over_ask";

/**
 * The caller-facing words for a deposit the job row never took.
 *
 * The three reasons need different words because they imply different actions.
 * `"unapplied"` is Tx C demonstrably never landing: the ask still stands, so
 * the caller should pay it — with a *fresh* payment, since the rail's replay
 * key rejects the one it already spent. `"unbound"` is the concurrent
 * free-then-paid race: the delta reached `paid_msats`, so the ask is covered
 * and paying again would only open a second deposit. `"unconfirmed"` is the
 * exhausted Tx C whose read-back *also* failed — the row may hold either
 * outcome, so the one thing the caller must not do is take "pay again" on
 * faith: if the write did land, that second payment is charged in full.
 *
 * With a credit, all three point at op `drain` for *later*, never now. The
 * deposit's own draw is still `pending`, so it holds the whole balance
 * (`available_micro: 0`) and a drain today answers `nothing_to_drain`;
 * reconciler releases the unbound hold once the job is terminal, and
 * only then is there anything to reclaim. Telling an agent to drain immediately
 * hands its human a refusal. `"unconfirmed"` promises less again — a write that
 * did land binds the draw, which settles as revenue rather than becoming
 * reclaimable at all.
 *
 * `"over_ask"` is the fourth, and it is the one that promises the
 * drain **now**. A duplicate payment for an ask the job's draw already covers
 * grows no draw at all, so nothing holds the money: it is available balance the
 * instant it lands, exactly like a short mid-job pay's deposit and unlike every
 * reason above. Sharing their "once this job reaches a terminal status" clause
 * would tell an agent to wait for a reclaim it could take immediately.
 *
 * Without one (`creditId` undefined) the money reached the rail and no ledger
 * recorded it, so neither field may name a credit, a balance, or a drain that
 * doesn't exist — the reclaim clause becomes "the provider is the only route".
 * The `"unbound"` and `"over_ask"` arms are unreachable there today (that
 * surface is the 201's `credit` block, which needs a credit to name) but are
 * written honestly rather than left to fall through to copy meant for a
 * different outcome.
 */
function unappliedCopy(
  reason: UnappliedReason,
  creditId: string | undefined
): Pick<UnappliedCredit, "display" | "hint"> {
  if (!creditId) {
    const noLedger = `This service holds no prepaid balance, so anything this job doesn't charge for can only be recovered from the provider directly.`;
    return {
      unapplied: {
        display:
          "The payment was received, but it wasn't applied to this job and this service isn't holding it as prepaid balance. The job's payment request is still outstanding.",
        hint: `The payment does not reduce what this job owes. Send a new payment to satisfy the request — re-sending this one will be rejected as already used. ${noLedger}`,
      },
      unbound: {
        display:
          "The payment was received, but another payment had already covered this job's request — so it wasn't charged to this job.",
        hint: `Don't re-send it: this job's payment request is already satisfied. ${noLedger}`,
      },
      unconfirmed: {
        display:
          "The payment was received, but a fault at the service left it unclear whether it was applied to this job.",
        hint: `Read this job's status before paying again: if its payment request is still outstanding, satisfy it with a new payment — re-sending this one will be rejected as already used — and if it is no longer outstanding, this payment covered it and a second one would be charged on top. ${noLedger}`,
      },
      over_ask: {
        display:
          "The payment was received, but this job had already been paid for what it asked — so none of it was charged to this job.",
        hint: `Don't re-send it: this job's payment request is already satisfied. ${noLedger}`,
      },
    }[reason];
  }
  const reclaim = `It becomes reclaimable with op "drain" at POST /v1/credit once this job reaches a terminal status — until then the balance is held against this job and a drain has nothing to pay out.`;
  return {
    unapplied: {
      display:
        "The payment was received and is held as prepaid balance with this service, but it wasn't applied to this job. The job's payment request is still outstanding.",
      hint: `The payment is held on credit ${creditId} and does not reduce what this job owes. Send a new payment to satisfy the request — re-sending this one will be rejected as already used. ${reclaim}`,
    },
    unbound: {
      display:
        "The payment was received, but another payment had already covered this job's request — so the amount is held as prepaid balance with this service rather than charged to this job.",
      hint: `The payment is held on credit ${creditId}. Don't re-send it: this job's payment request is already satisfied. ${reclaim}`,
    },
    unconfirmed: {
      display:
        "The payment was received and added to your prepaid balance with this service, but a fault at the service left it unclear whether it was applied to this job.",
      hint: `The payment is held on credit ${creditId}. Read this job's status before paying again: if its payment request is still outstanding, satisfy it with a new payment — re-sending this one will be rejected as already used — and if it is no longer outstanding, this payment covered it and a second one would be charged on top. Whatever this job doesn't charge becomes reclaimable with op "drain" at POST /v1/credit once the job reaches a terminal status.`,
    },
    over_ask: {
      display:
        "The payment was received, but this job had already been paid for what it asked — so the amount is prepaid balance with this service rather than a charge against this job.",
      hint: `The balance is on credit ${creditId} and nothing is holding it. Don't re-send this payment: this job's payment request is already satisfied. Spend the balance on a later request, or reclaim it now with op "drain" at POST /v1/credit.`,
    },
  }[reason];
}

/**
 * Resolve a descriptor's static `price` — a USD literal (`"$0.01"`) — to the
 * msats a caller must actually settle. Converted via the SDK's shared fx
 * fetcher so every USD-denominated price on this process shares one cache
 * window, and so the figure matches what `/v1/quote` advertised.
 */
async function resolveStaticPriceMsats(price: PriceValue, fxFetcher: FxFetcher): Promise<number> {
  const usd = parseUsdPrice(price, "price");
  const fx = await fxFetcher.fetch();
  return fiatToSatsCeil(usd, fxRateFor(fx, "usd")) * 1000;
}

/**
 * Derive `ctx.auth` from a parsed input when the descriptor declares an auth
 * scheme. The envelope fields (pubkey/signature/timestamp/nonce)
 * are part of the capability's Zod schema, so the parsed input already
 * carries them — we just surface them as a typed `{ pubkey, envelope }` on
 * `ctx.auth`.
 *
 * Verification of the envelope is the caller's responsibility: the submit
 * path runs `auth.checkAuth` in `app.ts` before `buildAndAttachContext`, and
 * the reactivation path runs `auth.recheckSignature` inside `reactivateJob`
 * This helper itself does not verify.
 */
function deriveAuthFromParsedInput(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptor: DVMDescriptor<any, any>,
  parsedInput: unknown
): { pubkey: string; envelope: CanonicalEnvelope & Record<string, unknown> } | undefined {
  if (!descriptor.auth) return undefined;
  if (parsedInput === null || typeof parsedInput !== "object") return undefined;
  const env = parsedInput as CanonicalEnvelope & Record<string, unknown>;
  if (typeof env.pubkey !== "string") return undefined;
  return { pubkey: env.pubkey, envelope: env };
}

function persistedSignedRequestDomain(
  authRequestPath: string | undefined,
  capability: string,
  audience: SignedRequestAudience | undefined
): SignedRequestDomain {
  if (!audience || !authRequestPath) {
    throw new SignedRequestError("persisted signed-request domain is missing", "schema_invalid");
  }
  return { audience, method: "POST", path: authRequestPath, capability };
}

/**
 * Translate a capability's static `price` (a USD literal) into the fiat
 * envelope advertised per-capability on `/v1/info.capabilities[*].pricing.max`
 * Returns `undefined` for dynamic-priced capabilities so the route
 * handler emits `pricing.quote.schema` instead. No fx: the price is already
 * the advertised currency.
 *
 * The hardcoded `"usd"` stays correct under DVM-level pricing
 * currency, and structurally so: a static price is a USD literal, and
 * `configureDVM` refuses one on a DVM that declares any other currency — so a
 * capability with a static price is always a capability on a USD DVM.
 */
function resolvePricingMax(
  raw: PriceValue | undefined
): { amount: number; currency: string } | undefined {
  if (raw === undefined) return undefined;
  return { amount: roundUsd(parseUsdPrice(raw, "price")), currency: "usd" };
}

/** Identifies a failed snapshot separately from handler and payment failures. */
export class JobSnapshotPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Job snapshot could not be persisted", { cause });
    this.name = "JobSnapshotPersistenceError";
  }
}

// The callback must contain only persistence, never payment verification or dispatch.
export async function retryJobSnapshot(persist: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await persist();
      return;
    } catch (error) {
      if (!(error instanceof JobSnapshotPersistenceError) || attempt >= 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
