import type { UpfrontPayment } from "../../lib/upfront-payment";
import type { ProofLike } from "@cashu/cashu-ts";

import type { Message, MessageType } from "../../lib/messages/types";
import type { FundingReceipt, JobReceipt } from "../../lib/receipt";
import type { StepRecord } from "../step-cache";
import type { FundingMethod } from "../types";
import type { CreditSnapshot } from "./credit-ledger";

export type JobStatus =
  | "processing"
  | "completed"
  | "failed"
  | "awaiting-input"
  | "cancelled"
  | "working";

export interface JobRecord {
  id: string;
  tags: string[];
  /**
   * Capability name this job dispatches to. Populated from the
   * `POST /v1/job` body's `capability` field at submission time; persisted
   * so reactivation on another machine routes to the same handler.
   */
  capability: string;
  input: string;
  params: Record<string, string>;
  requesterId: string;
  /**
   * SHA-256 hex of the per-job opaque token issued at creation time for
   * anonymous requesters. When set, all `/v1/job/:id/*` reads/writes
   * gate on the caller presenting the matching `X-Job-Token` header — this is
   * the mechanism that prevents cross-caller transcript leaks for free DVMs
   * where every caller otherwise resolves to `requesterId === "anonymous"`.
   * Undefined for authenticated jobs (bearer / signed-request), which gate on
   * `requesterId` instead.
   */
  requesterTokenHash?: string;
  /**
   * The `job_token` itself, in the clear. Kept so a caller whose
   * paid submit timed out can replay it and be handed back the very token the
   * lost response carried — the alternative (minting a fresh one) would be
   * rejected by whichever machine is still running the job, since its
   * `activeJobs` copy holds the original hash.
   *
   * The cost is that DB read access now also confers job *control* (cancel,
   * feed input), not just read access. Accepted: the same database holds the
   * accumulator's Cashu proofs, which are bearer money — a reader who gets
   * that far has strictly better targets. `requesterTokenHash` remains the
   * only thing the ownership check reads.
   */
  requesterToken?: string;
  /**
   * Fingerprint of the submission that created this job — see
   * `requestFingerprint`. The replay gate: a retried paid submit is handed the
   * original job only when it reproduces this.
   */
  requestFingerprint?: string;
  /**
   * secp256k1 x-only pubkey of the caller that signed the submission, on
   * DVMs with descriptor-level auth. Second half of the replay
   * gate — the signature envelope is re-minted on every resume attempt, so
   * the identity behind it is pinned here instead.
   */
  requesterPubkey?: string;
  /** Caller-generated public recovery id bound to this request fingerprint. */
  requestId?: string;
  /** HTTP path whose live auth gate accepted the persisted caller proof. */
  authRequestPath?: string;
  status: JobStatus;
  /** False on jobs accepted before complete lifecycle timing was available. */
  timingKnown?: boolean;
  /** SDK terminal attribution; never accepted from a handler. */
  endedBy?: "caller" | "provider";
  /** Unix ms when the terminal status committed; immutable afterwards. */
  terminalAtMs?: number;
  /** Accumulated awaiting-input time, excluding the currently open stretch. */
  callerWaitMs?: number;
  /** Unix ms at which the current awaiting-input stretch began. */
  awaitingInputAtMs?: number;
  summary?: string;
  messages: Message[];
  seq: number;
  /** Original acceptance snapshot; absent for historical records. INSERT-only. */
  upfrontPayment?: UpfrontPayment;
  paidMsats: number;
  paymentMint?: string;
  /** Rail of the most recent successful credit (cashu / x402 / tempo). */
  paymentRail?: FundingMethod;
  /**
   * Settlement reference threaded into the platform revenue ledger
   * (`revenue_events.tx_hash`). EVM tx hash for x402, mppx `challenge.id`
   * for mpp; cashu accumulator path sets this to the
   * `X-Cashu-Request-Id` UUID. Persisted so it survives durable
   * replay.
   */
  paymentTxHash?: string;
  /** Chain transaction returned to callers recovering x402 or Tempo acceptance. */
  paymentTransactionHash?: string;
  /**
   * Accumulated same-rail stablecoin micro-units for Tempo/x402; resets when the rail changes.
   * Cashu revenue uses paidMsats.
   */
  nativeAmount?: number;
  /** Native asset tag paired with `nativeAmount`. */
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";

  cashuFlow?: "p2pk_accumulator";
  /**
   * What this job cost the **builder** to serve, in 1e-6 of
   * {@link JobRecord.costCurrency}. Mirror of
   * `ServerJob.costAmountMicro`; see that field. Absent means unreported,
   * which the platform treats differently from a declared zero.
   */
  costAmountMicro?: number;
  /** Currency {@link JobRecord.costAmountMicro} is 1e-6 of (lowercase ISO-4217). */
  costCurrency?: string;
  /**
   * Number of `ctx.cost()` declarations incorporated into the current cost
   * state. Lets the platform deterministically replace a stale persisted
   * prefix with the handler owner's later cumulative value.
   */
  costRevision?: number;
  /**
   * Credit the upfront payment funded/drew. The terminal funnel
   * settles the draw on success and releases it on failure/cancel, and the
   * receipt countersigns the `ReceiptCredit` block from it.
   */
  creditId?: string;
  /** The draw placed for this job on `creditId`. */
  drawId?: string;
  /** Funding-time evidence returned on explicit fund-and-draw submissions. */
  fundingReceipt?: FundingReceipt;
  fundingCredit?: CreditSnapshot;
  receivedProofs: ProofLike[];
  pendingPaymentMsats?: number;
  /**
   * Per-job MPP credential binding. Challenge ids issued in the
   * most-recent `requestPayment` yield; the SDK rejects mid-job credentials
   * whose `challenge.id` isn't in this set.
   *
   * Keeps its `mpp` spelling past rail rename. The ids
   * are mppx challenge ids — objects of the MPP envelope the Tempo rail rides,
   * which is not itself a rail — and this is server-internal anti-replay state
   * that is never serialised to a caller. It persists as
   * `jobs.pending_mpp_challenge_ids` / `isolate_jobs.pending_mpp_challenge_ids`.
   */
  pendingMppChallengeIds?: string[];
  /**
   * Per-job x402 credential binding. 0x-prefixed 32-byte hex nonce
   * issued in the most-recent `requestPayment` yield; the SDK rejects mid-job
   * x402 payments whose decoded `authorization.nonce` differs from this value.
   */
  pendingX402Nonce?: string;
  /**
   * Exact USDC microunit amount advertised with `pendingX402Nonce`. Verification
   * reuses this value so an FX refresh between request and payment cannot change
   * the facilitator requirements.
   */
  pendingX402AmountUsdcMicro?: string;
  /**
   * The outstanding `requestPayment` ask denominated in fiat micro-units, pinned
   * when the payment-request was emitted — the mid-job analogue of
   * `resolvePriceFiat` pinning the quote. The ledger is fiat-denominated, so the
   * top-up's `fund` + `growDraw` need a figure that doesn't move with the BTC/USD
   * rate between the ask and the payment. Absent when the ask couldn't be priced
   * in fiat (cold-start fx outage), which degrades that top-up to ledger-less.
   */
  pendingPaymentFiatMicro?: number;
  /** Currency of {@link pendingPaymentFiatMicro} (lowercase ISO-4217). */
  pendingPaymentFiatCurrency?: string;
  /**
   * What this job has **cumulatively** asked for mid-job, in fiat micro-units
   * of {@link askedTopUpCurrency} — the ceiling `growDraw` caps the
   * job's draw growth at. Monotonic: written by the same Tx A that emits each
   * payment-request, and never decremented, which is exactly what
   * `pendingPaymentFiatMicro` is not (Tx C drains it as payments land). A cap
   * derived from the outstanding figure would let a duplicate payment arriving
   * in the window before Tx C see a full ask that the winner had already
   * bought.
   *
   * `-1` is a sticky "not expressible" sentinel — after the one door
   * left to it is an ask the rate provider was down for. Undefined means no
   * mid-job ask has been recorded (including a row written before this
   * existed). Either way the cap is skipped and growth is unbounded, as it was
   * before: a guessed ceiling on a money path is worse than none.
   */
  askedTopUpMicro?: number;
  /**
   * Currency of {@link askedTopUpMicro} (lowercase ISO-4217) — and, from
   * the job's own ask denomination: first-write-wins, and read back
   * by `ctx.requestPayment` so every later ask pins in it too. That is what
   * makes a mid-job currency switch unexpressible rather than merely unlikely.
   */
  askedTopUpCurrency?: string;
  /**
   * Why this job's draw growth is **not** capped, when it isn't —
   * the durable half of the `-1` sentinel, so an operator can list the affected
   * jobs after the fact rather than reconstruct them from log lines. Sticky
   * first-writer-wins, like the sentinel itself. Null on every job whose ceiling
   * is enforceable, which is the overwhelming majority.
   */
  topUpCapUnenforcedReason?: TopUpCapUnenforcedReason;
  /** Price the job was charged at (msats). Used to detect overpayment for change/melt gating. */
  requiredMsats?: number;
  /**
   * The DVM-signed proof of this job's outcome. Written once at the
   * terminal transition via `saveReceipt` and never rewritten — `save` leaves
   * the column alone so a stale in-memory snapshot can't clear it. Absent on
   * non-terminal jobs, and on every job when the DVM has no receipt key wired.
   */
  receipt?: JobReceipt;
  stepCache: StepRecord[];
  state: unknown;
  createdAt: number;
  lastActivityAt: number;
  /** When caller-controlled content was removed by the retention sweep. */
  redactedAt?: number;
}

/**
 * Counter snapshot used by the NOTIFY-driven resolver and the
 * `verifyAndCredit` flow. Carries just the handler-visible state
 * needed to decide whether a pending payment yield can resolve, plus
 * the terminal reason so a machine adopting another machine's cancel can hand
 * the caller's own words to `ctx.signal.reason` and the `onCancel` hook.
 */
export interface JobCounters {
  /** The latest durable payment request was satisfied by a balance authorization. */
  balancePaymentSatisfied?: boolean;
  status: JobStatus;
  paidMsats: number;
  pendingPaymentMsats?: number;
  /**
   * `jobs.summary`. Set to the cancel/fail reason by `cancelJob` /
   * `cancelStaleJob`, and to the completion summary by a handler's
   * `ctx.complete(summary)`. Undefined when nothing recorded one.
   */
  summary?: string;
}

/**
 * Credit delta written inside the Tx C transaction when an
 * inbound payment verifies. Fields mirror what the rails produce in
 * `payment.ts`; `paidMsatsDelta` is the only required key.
 */
export interface PaymentCreditDelta {
  paidMsatsDelta: number;
  /** When true, set `pending_payment_msats = NULL`; otherwise decrement by the delta. */
  clearPending?: boolean;
  paymentMint?: string;
  paymentRail?: FundingMethod;
  paymentTxHash?: string;
  nativeAmount?: number;
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";
  cashuFlow?: "p2pk_accumulator";
  /** When true, accumulate `nativeAmount` onto the existing same-rail value; otherwise overwrite. */
  accumulateNative?: boolean;
  /** Clear the pending nonce + advertised amount after an x402 credit succeeds. */
  clearPendingX402Binding?: boolean;
  /**
   * Credit this payment funded. Only ever set when the mid-job
   * top-up minted a *fresh* implicit credit — a free-then-paid job whose
   * upfront leg placed no draw. Written set-if-null: a job already bound to a
   * credit keeps that binding, because the top-up grew its existing draw
   * rather than opening a second one.
   */
  creditId?: string;
  /** The draw opened alongside {@link creditId}. Same set-if-null rule. */
  drawId?: string;
}

/** Atomic side effects applied with an outgoing provider message. */
export interface AppendOutgoingOptions {
  /** A suspending SDK prompt/payment yield; event-driven messages leave status unchanged. */
  awaitingInput?: boolean;
  pendingPaymentDelta?: number;
  pendingMppChallengeIds?: string[];
  pendingX402Nonce?: string;
  pendingX402AmountUsdcMicro?: string;
  /**
   * Fiat envelope pinned for this ask. Accumulates alongside
   * `pendingPaymentDelta` when the currency matches what's already recorded,
   * and replaces it when it doesn't — the same shape `pending_payment_msats`
   * uses, so stacked asks stay summable.
   */
  pendingPaymentFiatMicro?: number;
  pendingPaymentFiatCurrency?: string;
}

/**
 * Why a job's cumulative ask total can't bound its draw growth.
 *
 * - `ask_unpriceable` — an ask the rate provider was down for, or one whose
 * fiat figure isn't a safe integer. The only door left after and
 * deliberately still open: failing the charge to protect a ledger comparison
 * would break a payment that doesn't need the rate to be quoted or collected.
 * - `ask_currency_switch` — two asks on one job in different denominations.
 * Unreachable through `ctx.requestPayment`, which pins every ask in the job's
 * own sticky denomination; kept as the backstop for a record written by an
 * older build, and because the accumulator must not silently sum two units.
 */
export type TopUpCapUnenforcedReason = "ask_unpriceable" | "ask_currency_switch";

/**
 * Fold one mid-job ask into a job's cumulative ask total.
 *
 * The rules are shared by three implementations that must not drift — the Tx A
 * `CASE` in `PostgresJobStore.appendOutgoing`, `MemoryJobStore.appendOutgoing`,
 * and the in-memory job `ctx.requestPayment` updates — so they live here once.
 * Once poisoned the total stays poisoned: a job that asked for something the
 * cap can't express never regains an enforceable ceiling, because the asks it
 * already made are missing from the sum. `reason` is poisoned stickily with it,
 * and is what makes an uncapped job findable by query rather than by log
 * archaeology.
 */
export function accumulateAskedTopUp(
  prior: { micro?: number; currency?: string; reason?: TopUpCapUnenforcedReason },
  ask: { micro?: number; currency?: string }
): { micro: number; currency?: string; reason?: TopUpCapUnenforcedReason } {
  const poisoned = (
    reason: TopUpCapUnenforcedReason
  ): { micro: number; currency?: string; reason?: TopUpCapUnenforcedReason } => ({
    micro: UNCAPPABLE_ASK_TOTAL,
    currency: prior.currency,
    reason: prior.reason ?? reason,
  });
  if (prior.micro === UNCAPPABLE_ASK_TOTAL) {
    return { micro: prior.micro, currency: prior.currency, reason: prior.reason };
  }
  if (ask.micro === undefined) return poisoned("ask_unpriceable");
  if (prior.micro === undefined) {
    return { micro: ask.micro, currency: ask.currency, reason: prior.reason };
  }
  if (prior.currency !== ask.currency) return poisoned("ask_currency_switch");
  return { micro: prior.micro + ask.micro, currency: prior.currency, reason: prior.reason };
}

/** Sentinel for {@link JobRecord.askedTopUpMicro}: this job's ask total can't bound anything. */
export const UNCAPPABLE_ASK_TOTAL = -1;

/**
 * Result of a Tx C `verifyAndCredit` call. `alreadyVerified` is set when the
 * inbound row was previously marked verified (idempotency guard); the credit
 * is skipped in that case.
 */
export interface VerifyAndCreditResult {
  counters: JobCounters;
  alreadyVerified: boolean;
  /**
   * The credit the job row holds **after** this call — the authoritative
   * answer, read back rather than assumed.
   *
   * {@link PaymentCreditDelta.creditId} is written set-if-null, so a caller
   * that passes one cannot know whether it won the bind: on a free-then-paid
   * job two concurrent top-ups each mint their own implicit credit and only
   * one lands. Reading it back is what lets `processPayment` mirror the row
   * truthfully and name the loser's deposit to the caller instead of silently
   * recording a binding the row rejected.
   */
  creditId?: string;
  /** The draw the job row holds after this call. Same read-back rule. */
  drawId?: string;
}

/** Secret-free identity for atomically reserving one public request id. */
export interface RequestIdClaim {
  /** Caller-generated id carried inside the signed request body. */
  requestId: string;
  /** Verified x-only secp256k1 caller public key. */
  requesterPubkey: string;
  /** Server-resolved requester identity used by normal job ownership checks. */
  requesterId: string;
  /** Fingerprint of the request body with only the expiring auth fields removed. */
  requestFingerprint: string;
  /** Job id allocated before payment and reused by every exact recovery attempt. */
  jobId: string;
  /** Server-generated owner token for the live serialization lock. */
  claimToken: string;
}

/** Result of acquiring the live lock for a durable public request-id binding. */
export interface RequestIdClaimResult {
  /** Stable job id first assigned to this caller/request id. */
  jobId: string;
  /** True when the durable identity binding existed before this lock acquisition. */
  replayed: boolean;
}

export interface JobStore {

  get(id: string): Promise<JobRecord | undefined>;
  /**
   * Retrieve the job a settlement reference paid for. On the cashu
   * accumulator path `paymentTxHash` is the caller's `X-Cashu-Request-Id`, so
   * this is what makes a retried paid submit idempotent: the replay finds the
   * job its (already-spent) payment created instead of a bare 409.
   */
  findJobByPaymentTxHash(txHash: string): Promise<JobRecord | undefined>;
  /** Read a signed caller's job by public recovery id, when the store supports it. */
  findJobByRequestId?(requestId: string, requesterPubkey: string): Promise<JobRecord | undefined>;
  /**
   * Atomically bind and lock a caller/request id before pricing, payment
   * verification, credit draw, or handler work. Returns undefined when
   * another live request holds it or its durable binding has different
   * provenance. A process death releases the live lock but not the binding.
   */
  claimRequestId?(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined>;
  /**
   * Lock an existing exact caller/request binding without creating one.
   * Used only by the explicit recovery route, which must prove the original
   * submit reached the server before it can inspect durable acceptance state.
   */
  resumeRequestId?(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined>;
  /**
   * Release the live serialization lock after this route finishes. The opaque
   * owner token prevents a delayed request from releasing a newer holder; the
   * durable caller/fingerprint/job binding remains retained.
   */
  releaseRequestIdClaim?(claim: RequestIdClaim): Promise<void>;

  /**
   * Durably add a completed step, including its costs, without rewriting the job snapshot.
   * Existing step ids keep their first stored record. Implementations must preserve
   * these records in later snapshots and reject missing, terminal or redacted jobs.
   * Stores without this method retain yield-time step persistence.
   */
  saveStep?(jobId: string, record: StepRecord): Promise<void>;
  save(record: JobRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/** Total-order cursor for terminal job retention scans. */
export interface JobRetentionCursor {
  lastActivityAt: number;
  id: string;
}

/** Store operations required by the automatic terminal-job retention sweep. */
export interface JobRetentionStore extends JobStore {
  listJobsForRetention(args: {
    lastActivityBeforeMs: number;
    limit: number;
    capabilities: string[] | null;
    after?: JobRetentionCursor;
  }): Promise<JobRecord[]>;
  /**
   * Redact caller-controlled content if the row is still the terminal snapshot
   * selected by the sweep. Returns false when a concurrent change won.
   */
  redactJob(args: {
    jobId: string;
    expectedLastActivityAt: number;
    redactedAt: number;
  }): Promise<boolean>;
}

export function isJobRetentionStore(store: JobStore): store is JobRetentionStore {
  return "listJobsForRetention" in store && "redactJob" in store;
}

/**
 * JobStore extension for signed job receipts. Implemented by both
 * container-tier stores (`MemoryJobStore`, `PostgresJobStore`); the isolate
 * tier's `IsolateJobStore` deliberately doesn't, which is what keeps the
 * out-of-scope isolate gap a compile-time fact rather than a runtime surprise.
 */
export interface ReceiptIssuingStore {
  /**
   * Allocate this job's receipt sequence number, or return the one it already
   * holds. Idempotent per job and monotonic per DVM: two machines racing to
   * issue the same job's receipt get the same number, and the loser burns no
   * sequence.
   *
   * Gaps in the issued sequence are the completeness signal that exposes
   * receipt suppression, so a read-then-write counter (which can hand two jobs
   * the same number under concurrency) is not acceptable — the allocation has
   * to be atomic against every other machine.
   */
  claimReceiptSeq(jobId: string): Promise<number>;
  /**
   * Persist a signed receipt iff the job doesn't already have one, returning
   * whichever receipt is stored afterwards. Write-once: a racing second issuer
   * gets the winner's bytes back, so every reader of the job — sync response,
   * poll, later re-read — sees byte-identical JSON.
   *
   * Returns `undefined` when the job row is gone.
   */
  saveReceipt(jobId: string, receipt: JobReceipt): Promise<JobReceipt | undefined>;
}

export function isReceiptIssuingStore(store: JobStore): store is JobStore & ReceiptIssuingStore {
  return "claimReceiptSeq" in store && "saveReceipt" in store;
}

/**
 * JobStore extension for cross-machine message streaming + the
 * transactional model (Tx A / Tx B / Tx C).
 *
 * Tx A — outgoing message + immediate counter consequence (`appendOutgoing`).
 * Single tx: server-allocate seq, append `job_messages` row with
 * `status='verified'`, bump `pending_payment_msats` for payment-request
 * messages, and `pg_notify`.
 *
 * Tx B — incoming message marked `pending-verification` (`recordInbound`).
 * Single tx: server-allocate seq, append `job_messages` row with
 * `status='pending-verification'`, and `pg_notify`. External verification
 * (Cashu mint, x402 facilitator, MPP server) runs OUTSIDE the tx.
 *
 * Tx C — verification outcome + credit (`verifyAndCredit`). Single tx:
 * flip the `job_messages.status` to `'verified'`, bump `paid_msats` /
 * clear `pending_payment_msats` per the credit delta, and `pg_notify`.
 * Idempotent — a repeat call returns `alreadyVerified: true` without
 * re-crediting.
 */
export interface StreamableJobStore extends JobStore {
  /**
   * Tx A — append an outgoing message and apply its immediate counter
   * consequence. Returns the server-allocated seq. The caller's `message`
   * carries no `seq` (it's allocated inside the tx). For payment-request
   * messages, pass the amount via `pendingPaymentDelta` so the bump and
   * the message land in the same tx.
   */
  appendOutgoing(
    jobId: string,
    message: OutgoingMessage,
    opts?: AppendOutgoingOptions
  ): Promise<number>;

  /**
   * Tx B — record an inbound message durably with `pending-verification`
   * status. Returns the server-allocated seq.
   */
  recordInbound(jobId: string, message: OutgoingMessage): Promise<number>;

  /**
   * Tx C — flip an inbound message from `pending-verification` to either
   * `verified` (with a credit delta when it's a payment) or `failed-verify`
   * (when verification rejected). Idempotent: a repeat call with a row
   * already in `verified`/`failed-verify` returns `alreadyVerified: true`
   * and skips the credit.
   *
   * Pass `credit: null` for non-payment messages (response/cancel/approval).
   */
  verifyAndCredit(
    jobId: string,
    seq: number,
    credit: PaymentCreditDelta | null
  ): Promise<VerifyAndCreditResult>;

  /**
   * Read back what Tx C committed for an inbound message, without opening a
   * transaction of its own.
   *
   * A `verifyAndCredit` that throws is ambiguous: the error may have been
   * raised at or after its COMMIT, in which case the write is durable and the
   * caller has simply lost the acknowledgement. Retrying resolves that — until
   * the retries run out, and the last attempt's error is as ambiguous as any
   * other's. This is the read that settles it: `undefined` means Tx C has not
   * committed for this seq, anything else is the outcome it committed.
   *
   * Implementations MUST answer without a transaction (no `BEGIN`/`COMMIT`) and
   * MUST NOT write, because the caller reaches for it precisely when writes are
   * failing. `alreadyVerified` is always `true` on the returned value — the
   * credit landed in an earlier call, not this one.
   */
  getVerifiedInbound(jobId: string, seq: number): Promise<VerifyAndCreditResult | undefined>;

  /**
   * Mark an inbound message as failed-verify without crediting. Used when
   * external verification rejects the payment (Cashu mint says SPENT, x402
   * facilitator returns invalid, mppx HMAC mismatch).
   */
  markInboundFailed(jobId: string, seq: number, reason: string): Promise<void>;

  /** Read the counters used by the resolver (status / paid / pending). */
  getCounters(jobId: string): Promise<JobCounters | undefined>;

  /**
   * Single-execution claim. Atomically flip a job from
   * `awaiting-input` to `processing`, returning `true` only for the caller
   * that won the transition. After a mid-job payment lands cross-machine, the
   * live original handler (woken via NOTIFY) and a reactivation replay on the
   * paying machine both race to drive the job; the CAS winner proceeds and the
   * loser stands down, so a healthy worker never double-executes (double
   * substrate spend, clobbered artifact). Also bumps `last_activity_at` so the
   * claimant is covered by the processing watchdog. A no-op returning `false`
   * for a job that is no longer `awaiting-input` (already claimed / terminal).
   */
  claimForProcessing(jobId: string): Promise<boolean>;

  /**
   * Run `fn` while holding a tx-scoped advisory lock keyed on the job id.
   * Resolves with `{ acquired: false }` when the lock is already held by
   * another transaction — the caller decides what to do (typically: skip
   * reactivation, the other holder will handle it). The lock releases on
   * commit/rollback of the wrapping tx.
   */
  tryReactivationLock<T>(
    jobId: string,
    fn: () => Promise<T>
  ): Promise<{ acquired: true; result: T } | { acquired: false }>;

  /**
   * Subscribe to messages for a job. Delivers existing messages (seq > afterSeq)
   * from the `job_messages` table first, then forwards new ones via NOTIFY.
   * Returns an unsubscribe function.
   *
   * Only messages with `status='verified'` are delivered — pending and
   * failed-verify rows are internal to the verification flow.
   */
  subscribeMessages(
    jobId: string,
    afterSeq: number,
    onMessage: (msg: Message) => void
  ): Promise<() => void>;

  /**
   * Subscribe to raw NOTIFY events for a job. Fires once per `pg_notify`
   * delivery; no message decoding. Used by `Context.requestPayment` to
   * re-read counters when cross-machine credit lands.
   */
  subscribeNotifications(jobId: string, onNotify: () => void): Promise<() => void>;

  /**
   * Read verified history without advancing past a pending payment. Terminal
   * output releases the cutoff. Snapshot reconstruction uses includeHeld to
   * retain every verified message, independently of incremental delivery.
   */
  getMessages(jobId: string, afterSeq: number, options?: { includeHeld?: boolean }): Promise<Message[]>;

  /**
   * Find stale non-terminal jobs. Two status-aware
   * cutoffs (both Unix ms): `processing`/`working` rows older than
   * `processingThresholdMs` (worker-liveness watchdog — the SDK heartbeats
   * live workers, so a frozen `last_activity_at` here means the worker died),
   * and `awaiting-input` rows older than `awaitingThresholdMs` (the
   * caller-input idle timeout). Pass a negative cutoff to disable that arm.
   * Returns at most `limit` records, oldest first. Consumed exclusively by the
   * `JobManager` stale-job sweeper; not safe to feed into handler dispatch.
   *
   * `capabilities` scopes the query to jobs the calling JobManager owns —
   * multi-mount hosts where two descriptors share a DB must not steal
   * each other's stuck rows (the activeJobs teardown only fires on the
   * descriptor that actually hosted the zombie). Pass `null` only from
   * single-descriptor deployments.
   */
  findStaleJobs(
    processingThresholdMs: number,
    awaitingThresholdMs: number,
    limit: number,
    capabilities: string[] | null
  ): Promise<JobRecord[]>;

  /**
   * Atomically transition a stale job to `terminalStatus` (`failed` for a
   * dead worker, `cancelled` for an idle caller-wait) and append a final
   * `cancel` message in the same transaction. The
   * `expectedActivityBefore` clause is an optimistic CAS — the flip only
   * lands when the job is still non-terminal AND `last_activity_at <=
   * expectedActivityBefore`. Returns true when this caller claimed the
   * transition, false when another machine got there first OR the job's
   * activity bumped (recovered). Caller cancellations additionally require a
   * row whose outstanding stamped deadline has elapsed;
   * processing failures remain governed by the activity cutoff.
   * Mirrors `save`'s terminal cleanup by
   * deleting incremental `job_messages` rows once the snapshot is final.
   */
  cancelStaleJob(
    jobId: string,
    expectedActivityBefore: number,
    reason: string,
    terminalStatus: "failed" | "cancelled"
  ): Promise<boolean>;

  /**
   * Atomically cancel a job from a machine that isn't running its handler.
   * Same transaction shape as {@link cancelStaleJob} minus the
   * activity cutoff — the CAS guards only on the job still being non-terminal,
   * so this replaces the read-then-`save` the DELETE route used to do (a TOCTOU
   * against a concurrent terminal write).
   *
   * The `cancel` message and the terminal status commit together and `pg_notify`
   * fires inside the tx, so the machine actually running the handler wakes on
   * its per-job notification subscription, adopts the terminal status, and
   * aborts `ctx.signal` within a NOTIFY round-trip instead of at the handler's
   * next store write. Returns false when the job was already terminal (another
   * machine won).
   */
  cancelJob(jobId: string, reason: string): Promise<boolean>;

  /**
   * Bump `last_activity_at` to `now` (Unix ms) for the given jobs that are
   * still in `processing`/`working`. Called on a
   * tick by the `JobManager` for its locally-active jobs so a live worker's
   * row stays fresh and the processing watchdog only fires when the process
   * has actually died. A no-op for rows that have since gone terminal or
   * `awaiting-input` (the SQL `WHERE` guards the status).
   */
  heartbeatActiveJobs(jobIds: string[], now: number): Promise<void>;

  /** Acquire the dedicated LISTEN connection. Call once at startup. */
  initStreaming(): Promise<void>;

  /** Release the dedicated LISTEN connection. Call on shutdown. */
  shutdownStreaming(): Promise<void>;
}

/**
 * Message shape passed to `appendOutgoing` / `recordInbound`. The store
 * allocates `seq` server-side inside the tx, so the caller doesn't supply it.
 */
export interface OutgoingMessage {
  from: "provider" | "requester";
  type: MessageType;
  timestamp: number;
  content: Record<string, unknown> | object;
}

/**
 * Runtime type guard for StreamableJobStore. Duck-typed, so it has to name every
 * member the callers reach for — a store written against an earlier version of
 * the interface would otherwise pass the guard and TypeError inside the route
 * that calls the member it's missing.
 */
export function isStreamableJobStore(store: JobStore): store is StreamableJobStore {
  return (
    "appendOutgoing" in store &&
    "recordInbound" in store &&
    "verifyAndCredit" in store &&
    "getVerifiedInbound" in store &&
    "subscribeMessages" in store &&
    "subscribeNotifications" in store &&
    "getCounters" in store &&
    "getMessages" in store &&
    "cancelJob" in store &&
    "initStreaming" in store
  );
}

/**
 * The stale-job reaper surface — the two methods a sweeper needs to
 * find and atomically reap worker-stranded jobs. A strict subset of
 * `StreamableJobStore`: `MemoryJobStore` and `PostgresJobStore` satisfy it via
 * the full streamable interface, and the platform's `IsolateJobStore` (a plain
 * single-machine `JobStore`, not streamable) implements just these two so the
 * `IsolateJobManager` reaper can sweep the `isolate_jobs` table without taking
 * on the streaming/LISTEN machinery it doesn't need.
 */
export interface StaleJobReapable {
  /** See {@link StreamableJobStore.findStaleJobs}. */
  findStaleJobs(
    processingThresholdMs: number,
    awaitingThresholdMs: number,
    limit: number,
    capabilities: string[] | null
  ): Promise<JobRecord[]>;

  /** See {@link StreamableJobStore.cancelStaleJob}. */
  cancelStaleJob(
    jobId: string,
    expectedActivityBefore: number,
    reason: string,
    terminalStatus: "failed" | "cancelled"
  ): Promise<boolean>;
}

export function isStaleJobReapable(store: JobStore): store is JobStore & StaleJobReapable {
  return "findStaleJobs" in store && "cancelStaleJob" in store;
}
