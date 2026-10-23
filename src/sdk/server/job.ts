import type { UpfrontPayment } from "../../lib/upfront-payment";
import type { ProofLike } from "@cashu/cashu-ts";

import type {
  Message,
  MessageType,
  PaymentContent,
  ResponseContent,
} from "../../lib/messages/types";
import type { FundingReceipt, JobReceipt } from "../../lib/receipt";
import { StepCache } from "../step-cache";
import type { FundingMethod, SDKJobContext } from "../types";
import type { CreditSnapshot } from "./credit-ledger";
import type { AppendOutgoingOptions, JobRecord, TopUpCapUnenforcedReason } from "./job-store";

export interface PromptResolver {
  resolve: (value: ResponseContent) => void;
  reject: (reason: Error) => void;
}

export interface PaymentResolver {
  resolve: (value: PaymentContent) => void;
  reject: (reason: Error) => void;
}

export interface ServerJob {
  /** Runtime configuration; persisted deadlines live in the emitted messages. */
  idleTimeoutMs?: number;
  id: string;
  tags: string[];
  /**
   * Capability name this job belongs to. Set at submission from
   * `POST /v1/job` body's `capability` field; routes the SDK runtime to the
   * right `onJob` / `onResponse` / `onPayment` handler and the right input
   * schema. Required — the wire layer rejects requests that omit it.
   */
  capability: string;
  input: string;
  params: Record<string, string>;
  requesterId: string;
  /**
   * SHA-256 hex of the per-job opaque `job_token` minted at creation for
   * anonymous callers. Mirror of `JobRecord.requesterTokenHash`;
   * see that field for the wire-level gating semantics.
   */
  requesterTokenHash?: string;
  /**
   * Submission provenance — mirrors `JobRecord.requesterToken` /
   * `requestFingerprint` / `requesterPubkey`. Carried on the job purely so
   * `toJobRecord` persists it; nothing in the runtime reads it. It's the
   * replay gate: a retried paid submit that reproduces the fingerprint (and,
   * on a signed DVM, the pubkey) is handed this token back.
   */
  requesterToken?: string;
  requestFingerprint?: string;
  requesterPubkey?: string;
  requestId?: string;
  /** HTTP path independently recorded when the caller proof was accepted. */
  authRequestPath?: string;
  status: "processing" | "completed" | "failed" | "awaiting-input" | "cancelled" | "working";
  /** Mirrors the durable completeness marker; false for legacy accepted jobs. */
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
  /** Rail of the most recent successful credit. Set on each credit branch in payment processing. */
  paymentRail?: FundingMethod;
  /**
   * Settlement reference for the most-recent successful credit. Threaded
   * into `onJobCompleted` so the platform revenue ledger can populate
   * `revenue_events.tx_hash`. mpp/x402 carry the credential's `challenge.id`
   * / EVM tx hash from the facilitator; cashu accumulator carries
   * the `X-Cashu-Request-Id` UUID. Updated on every credit
   * (upfront or mid-job via `processIncomingPayment`).
   * Single-row-per-job accounting keeps the most recent credit's hash,
   * mirroring `paymentRail`.
   */
  paymentTxHash?: string;
  /** Chain transaction returned to callers recovering x402 or Tempo acceptance. */
  paymentTransactionHash?: string;
  /**
   * Rail-native atomic units accumulated across same-rail credits: Tempo and
   * x402 use stablecoin micro-units. A rail switch resets this amount; Cashu
   * revenue is derived from paidMsats instead.
   */
  nativeAmount?: number;
  /** Native asset tag paired with `nativeAmount`. */
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";

  cashuFlow?: "p2pk_accumulator";
  /**
   * What this job cost the **builder** to serve, in 1e-6 of
   * {@link ServerJob.costCurrency} — the running total the handler declared
   * through `ctx.cost()`. Absent until a handler declares
   * something; absent is "unreported", which is not the same fact as a
   * declared zero and is reported differently.
   *
   * Persisted on the row rather than held in the context because the report
   * has to survive a crash between the job finishing and the report landing:
   * the terminal funnel writes this row before it books, and Postgres cost
   * reconciliation retries any revision whose durable-enqueue marker still
   * lags. Never netted against `paidMsats` or the draw — the builder's cost
   * and the caller's payment are two questions.
   */
  costAmountMicro?: number;
  /** Currency {@link ServerJob.costAmountMicro} is 1e-6 of (lowercase ISO-4217). */
  costCurrency?: string;
  /** Number of `ctx.cost()` declarations incorporated into the current cost state. */
  costRevision?: number;
  /** Credit the upfront payment funded/drew. See `JobRecord.creditId`. */
  creditId?: string;
  /** The draw placed for this job on `creditId`. */
  drawId?: string;
  /** Original funding artifact returned by an explicit fund-and-draw. */
  fundingReceipt?: FundingReceipt;
  fundingCredit?: CreditSnapshot;
  receivedProofs: ProofLike[];
  pendingPaymentMsats?: number;
  /**
   * Per-job binding for MPP credentials. Contains the `challenge.id` of every
   * mppx challenge issued in the most-recent `requestPayment` yield. mppx HMAC
   * binds challenges to realm/method/amount/expiry, not to the dvmkit job-id;
   * verifying the incoming credential's `challenge.id` is in this set blocks
   * a credential lifted from a sibling job that requested the same fields.
   * Cleared on successful credit.
   */
  pendingMppChallengeIds?: string[];
  /**
   * Per-job binding for x402 mid-job credentials. 32-byte 0x-hex
   * nonce issued by `requestPayment` and stamped onto the outbound x402
   * envelope; the caller signs `TransferWithAuthorization` against this exact
   * `bytes32`. Verification rejects an incoming `x402_payment` whose decoded
   * authorization nonce differs before crediting the job. Cleared on
   * successful credit.
   */
  pendingX402Nonce?: string;
  /**
   * Exact USDC microunit amount paired with `pendingX402Nonce`. Kept as a
   * decimal string so the EIP-3009 uint256 value remains lossless.
   */
  pendingX402AmountUsdcMicro?: string;
  /**
   * Fiat micro-units the outstanding `requestPayment` ask is worth, pinned when
   * the payment-request was emitted. See `JobRecord`.
   */
  pendingPaymentFiatMicro?: number;
  /** Currency of {@link pendingPaymentFiatMicro} (lowercase ISO-4217). */
  pendingPaymentFiatCurrency?: string;
  /**
   * Cumulative fiat micro this job has asked for mid-job, the ceiling on its
   * draw growth. See `JobRecord.askedTopUpMicro` for the sentinel.
   */
  askedTopUpMicro?: number;
  /**
   * Currency of {@link askedTopUpMicro} — and this job's sticky ask
   * denomination. See `JobRecord.askedTopUpCurrency`.
   */
  askedTopUpCurrency?: string;
  /**
   * Why this job's draw growth is not capped, when it isn't. Mirror
   * of `JobRecord.topUpCapUnenforcedReason`.
   */
  topUpCapUnenforcedReason?: TopUpCapUnenforcedReason;
  /** Price the job was charged at (msats). Used to detect overpayment for change/melt gating. */
  requiredMsats?: number;
  /**
   * The signed receipt for this job's terminal outcome. Mirror of
   * `JobRecord.receipt`, set once the terminal funnel has signed and persisted
   * it so the local read paths (which serve from `activeJobs` during the
   * cleanup window) hand back the same bytes as a cross-machine re-read.
   */
  receipt?: JobReceipt;
  /**
   * The in-flight terminal chain — persist, then sign + store the receipt
   * Assigned synchronously by `ctx.complete()` / `ctx.fail()` at
   * the instant the job goes terminal, so the `POST /v1/job` fast path can
   * await it (bounded) and put the receipt on the synchronous 200 rather than
   * making the caller poll for it. Never rejects — the chain swallows its own
   * failures.
   */
  terminalWork?: Promise<void>;
  listeners: Set<(msg: Message) => void>;
  /**
   * Cancellation signal for the running handler. Aborted whenever
   * the job is cancelled on this process — caller cancel, idle timeout,
   * stale-sweep teardown, supersession. Surfaced to builders as `ctx.signal`
   * and auto-threaded into `ctx.fetch`, so an in-flight provider call
   * (ElevenLabs, Scrapfly, …) is torn down instead of billing the caller for
   * work they just cancelled. Per-process runtime state like `listeners` —
   * never persisted, and re-created fresh on reactivation.
   */
  abort: AbortController;
  /**
   * Hook for cross-machine message persistence (Tx A). Set by
   * `JobManager` when the store is streamable. The appender runs the
   * outgoing-message tx atomically with any payment-request counter bump so
   * `(message, pending_payment_msats)` land together — never separately.
   *
   * Per-job serialised: each call chains onto `messageAppenderTail`
   * so two synchronous `providerMessage` calls (e.g. `artifact` followed by
   * `complete`) can't race for the DB-side seq allocation.
   */
  messageAppender?: (msg: Message, opts?: AppendOutgoingOptions) => void;
  /**
   * Tail of the per-job appender chain. `wireMessageAppender` updates
   * this on every call so `persistJob` can await it before the terminal snapshot
   * save runs `DELETE FROM job_messages`.
   */
  messageAppenderTail?: Promise<unknown>;
  sdkCtx?: SDKJobContext<unknown, unknown>;
  stepCache: StepCache;
  state: unknown;
  pendingPrompts: Map<string, PromptResolver>;
  pendingPayment: PaymentResolver | null;
  /** When not null, indicates replay mode — prompt/payment scan message history for cached responses. */
  replayHighSeq: number | null;
  /** Number of provider messages to suppress during replay. Cleared on handler error. */
  replayProviderSkip: number;
  /** Index of the next payment to match during replay (for multi-payment handlers). */
  replayPaymentIndex: number;
  /**
   * Set once Tx C applies the current payment ask during this reactivation.
   * Runtime-only: replayed prompts may mutate `status`, but never clear this
   * marker before the matching payment is consumed.
   */
  reactivationPaymentApplied?: true;
  /** Unix ms timestamp of job creation. */
  createdAt: number;
  /** Unix ms timestamp of last activity (message, yield, terminal). */
  lastActivityAt: number;
}

export function toJobRecord(job: ServerJob): JobRecord {
  return {
    id: job.id,
    tags: job.tags,
    capability: job.capability,
    input: job.input,
    params: job.params,
    requesterId: job.requesterId,
    requesterTokenHash: job.requesterTokenHash,
    requesterToken: job.requesterToken,
    requestFingerprint: job.requestFingerprint,
    requesterPubkey: job.requesterPubkey,
    requestId: job.requestId,
    authRequestPath: job.authRequestPath,
    status: job.status,
    summary: job.summary,
    timingKnown: job.timingKnown,
    endedBy: job.endedBy,
    terminalAtMs: job.terminalAtMs,
    callerWaitMs: job.callerWaitMs,
    awaitingInputAtMs: job.awaitingInputAtMs,
    messages: job.messages,
    seq: job.seq,
    upfrontPayment: job.upfrontPayment,
    paidMsats: job.paidMsats,
    paymentMint: job.paymentMint,
    paymentRail: job.paymentRail,
    paymentTxHash: job.paymentTxHash,
    paymentTransactionHash: job.paymentTransactionHash,
    nativeAmount: job.nativeAmount,
    nativeAsset: job.nativeAsset,
    cashuFlow: job.cashuFlow,
    costAmountMicro: job.costAmountMicro,
    costCurrency: job.costCurrency,
    costRevision: job.costRevision,
    creditId: job.creditId,
    drawId: job.drawId,
    fundingReceipt: job.fundingReceipt,
    fundingCredit: job.fundingCredit,
    receivedProofs: job.receivedProofs,
    pendingPaymentMsats: job.pendingPaymentMsats,
    pendingMppChallengeIds: job.pendingMppChallengeIds,
    pendingX402Nonce: job.pendingX402Nonce,
    pendingX402AmountUsdcMicro: job.pendingX402AmountUsdcMicro,
    pendingPaymentFiatMicro: job.pendingPaymentFiatMicro,
    pendingPaymentFiatCurrency: job.pendingPaymentFiatCurrency,
    askedTopUpMicro: job.askedTopUpMicro,
    askedTopUpCurrency: job.askedTopUpCurrency,
    topUpCapUnenforcedReason: job.topUpCapUnenforcedReason,
    requiredMsats: job.requiredMsats,
    receipt: job.receipt,
    stepCache: job.stepCache.serialize(),
    state: job.state,
    createdAt: job.createdAt,
    lastActivityAt: job.lastActivityAt,
  };
}

/** Restored snapshots receive fresh process-local listeners, cancellation and prompt state. */
export function fromJobRecord(record: JobRecord): ServerJob {
  return {
    id: record.id,
    tags: record.tags,
    capability: record.capability,
    input: record.input,
    params: record.params,
    requesterId: record.requesterId,
    requesterTokenHash: record.requesterTokenHash,
    status: record.status,
    summary: record.summary,
    timingKnown: record.timingKnown,
    endedBy: record.endedBy,
    terminalAtMs: record.terminalAtMs,
    callerWaitMs: record.callerWaitMs,
    awaitingInputAtMs: record.awaitingInputAtMs,
    messages: [...record.messages],
    seq: record.seq,
    upfrontPayment: record.upfrontPayment,
    paidMsats: record.paidMsats,
    paymentMint: record.paymentMint,
    paymentRail: record.paymentRail,
    paymentTxHash: record.paymentTxHash,
    paymentTransactionHash: record.paymentTransactionHash,
    nativeAmount: record.nativeAmount,
    nativeAsset: record.nativeAsset,
    cashuFlow: record.cashuFlow,
    costAmountMicro: record.costAmountMicro,
    costCurrency: record.costCurrency,
    costRevision: record.costRevision,
    creditId: record.creditId,
    drawId: record.drawId,
    fundingReceipt: record.fundingReceipt,
    fundingCredit: record.fundingCredit,
    receivedProofs: [...record.receivedProofs],
    pendingPaymentMsats: record.pendingPaymentMsats,
    pendingMppChallengeIds: record.pendingMppChallengeIds
      ? [...record.pendingMppChallengeIds]
      : undefined,
    requesterToken: record.requesterToken,
    requestFingerprint: record.requestFingerprint,
    requesterPubkey: record.requesterPubkey,
    requestId: record.requestId,
    authRequestPath: record.authRequestPath,
    pendingX402Nonce: record.pendingX402Nonce,
    pendingX402AmountUsdcMicro: record.pendingX402AmountUsdcMicro,
    pendingPaymentFiatMicro: record.pendingPaymentFiatMicro,
    pendingPaymentFiatCurrency: record.pendingPaymentFiatCurrency,
    askedTopUpMicro: record.askedTopUpMicro,
    askedTopUpCurrency: record.askedTopUpCurrency,
    topUpCapUnenforcedReason: record.topUpCapUnenforcedReason,
    requiredMsats: record.requiredMsats,
    receipt: record.receipt,
    listeners: new Set(),
    abort: new AbortController(),
    messageAppender: undefined,
    messageAppenderTail: undefined,
    stepCache: StepCache.deserialize(record.stepCache),
    state: record.state,
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
  };
}

/**
 * Signal cancellation to a running handler. Idempotent — aborting an
 * already-aborted controller is a no-op, so the overlapping teardown paths
 * (caller cancel then stale sweep, say) can each call it unconditionally.
 */
export function abortJob(job: ServerJob, reason: string): void {
  job.abort.abort(new JobCancelledError(reason));
}

/**
 * Reason carried on `ctx.signal.reason` and thrown by post-terminal `ctx.prompt`
 * / `ctx.requestPayment` calls. Builders can `instanceof`-check it to tell a
 * cancellation apart from a provider-side abort.
 */
export class JobCancelledError extends Error {
  constructor(message = "Job cancelled") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export function providerMessage(
  job: ServerJob,
  type: MessageType,
  // Content is typed per message type at the call site but stored as the union
  content: Record<string, unknown> | object
): void {
  if (job.replayProviderSkip > 0) {
    job.replayProviderSkip--;
    return; // suppressed during replay — message already in job.messages from the record
  }
  if (type === "prompt" || type === "payment-request") {
    content = { ...content, expires_at_ms: Date.now() + (job.idleTimeoutMs ?? 3600_000) };
  }
  const msg = localMessage(job, "provider", type, content);
  // Tx A semantics: for payment-request messages, the pending amount
  // and per-rail bindings land in the same tx as the message insert. The
  // appender handles the atomic write; Context.requestPayment sets the matching
  // in-memory state before this fires.
  if (type === "payment-request") {
    const paymentRequest = content as {
      amount_msats?: unknown;
      tempo?: { challenges?: { id?: unknown }[] };
      x402?: { nonce?: unknown; required_usdc_micro?: unknown };
    };
    const pendingPaymentDelta =
      typeof paymentRequest.amount_msats === "number" ? paymentRequest.amount_msats : undefined;
    const pendingMppChallengeIds = paymentRequest.tempo?.challenges
      ?.map((challenge) => challenge.id)
      .filter((id): id is string => typeof id === "string");
    job.messageAppender?.(msg, {
      awaitingInput: job.status === "awaiting-input",
      pendingPaymentDelta,
      pendingMppChallengeIds,
      pendingX402Nonce:
        typeof paymentRequest.x402?.nonce === "string" ? paymentRequest.x402.nonce : undefined,
      pendingX402AmountUsdcMicro:
        typeof paymentRequest.x402?.required_usdc_micro === "string"
          ? paymentRequest.x402.required_usdc_micro
          : undefined,
      // read off the job rather than the content — the fiat envelope
      // is ledger state, not part of the wire shape, and `requestPayment` has
      // already pinned it on the job by the time this fires (same ordering the
      // `pendingPaymentMsats` comment above describes).
      pendingPaymentFiatMicro: job.pendingPaymentFiatMicro,
      pendingPaymentFiatCurrency: job.pendingPaymentFiatCurrency,
    });
    return;
  }
  job.messageAppender?.(msg, type === "prompt" ? { awaitingInput: job.status === "awaiting-input" } : undefined);
}

const historyHolds = new WeakMap<ServerJob, Set<number>>();
const heldNotifications = new WeakMap<ServerJob, Message[]>();

export function holdJobHistory(job: ServerJob, seq: number): void {
  let holds = historyHolds.get(job);
  if (!holds) {
    holds = new Set();
    historyHolds.set(job, holds);
  }
  holds.add(seq);
}

/** A cursor must never advance beyond a payment that may still become visible. */
export function visibleJobMessages(job: ServerJob): Message[] {
  const holds = historyHolds.get(job);
  if (!holds?.size) return job.messages;
  const boundary = Math.min(...holds);
  return job.messages.filter(message => message.seq < boundary);
}

export function releaseJobHistory(job: ServerJob, seq: number, accepted?: Message): void {
  const holds = historyHolds.get(job);
  const wasPending = holds?.delete(seq);
  if (accepted && wasPending) {
    const next = job.messages.findIndex(existing => existing.seq > accepted.seq);
    job.messages.splice(next < 0 ? job.messages.length : next, 0, accepted);
    const queued = heldNotifications.get(job) ?? [];
    queued.push(accepted);
    heldNotifications.set(job, queued);
  }
  flushJobHistory(job);
}

function flushJobHistory(job: ServerJob): void {
  const holds = historyHolds.get(job);
  const boundary = holds?.size ? Math.min(...holds) : Infinity;
  const queued = heldNotifications.get(job) ?? [];
  queued.sort((a, b) => a.seq - b.seq);
  heldNotifications.set(job, queued.filter(message => message.seq >= boundary));
  for (const message of queued) {
    if (message.seq < boundary) {
      for (const listener of job.listeners) listener(message);
    }
  }
}

/**
 * Push a message into the in-memory log and fan it out to this machine's SSE
 * listeners without appending it to the store — store writes happen elsewhere.
 * The DELETE route lets the following persistJob carry its cancel to the store;
 * an adopted remote cancel is already durable and must not be appended again.
 * Fan-out closes open SSE streams. Cancellation also releases buffered output
 * and prevents an in-flight payment appearing behind the terminal cursor later.
 */
export function localMessage(
  job: ServerJob,
  from: "provider" | "requester",
  type: MessageType,
  content: Record<string, unknown> | object
): Message {
  if (type === "cancel") {
    historyHolds.get(job)?.clear();
    flushJobHistory(job);
  }
  job.seq++;
  const msg = {
    seq: job.seq,
    from,
    timestamp: Math.floor(Date.now() / 1000),
    type,
    content,
  } as Message;
  job.messages.push(msg);
  const holds = historyHolds.get(job);
  if (holds?.size && msg.seq >= Math.min(...holds)) {
    const queued = heldNotifications.get(job) ?? [];
    queued.push(msg);
    heldNotifications.set(job, queued);
  } else {
    for (const listener of job.listeners) listener(msg);
  }
  return msg;
}

export function isTerminal(status: ServerJob["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isYieldMessage(msg: Message): boolean {
  return (
    msg.type === "prompt" ||
    msg.type === "payment-request" ||
    msg.type === "working" ||
    msg.type === "complete" ||
    msg.type === "cancel"
  );
}

type WaitingJob = Pick<JobRecord, "status" | "messages" | "pendingPaymentMsats" | "lastActivityAt" | "awaitingInputAtMs">;

/** Recover outstanding asks from verified history; text and unrelated responses never extend a turn. */
export function callerDeadline(job: WaitingJob, legacyTimeoutMs?: number): number | undefined {
  if (isTerminal(job.status)) return undefined;
  const prompts = new Map<string, Message & { type: "prompt" }>();
  let payment: (Message & { type: "payment-request" }) | undefined;
  for (const message of job.messages) {
    if (message.from === "provider" && message.type === "prompt") prompts.set(message.content.id, message);
    if (message.from === "provider" && message.type === "payment-request") payment = message;
    if (message.from === "requester" && message.type === "response") prompts.delete(message.content.prompt_id);
  }
  const asks = [...prompts.values(), ...(payment && (job.pendingPaymentMsats ?? 0) > 0 ? [payment] : [])];
  const deadlines = asks.map((ask) => ask.content.expires_at_ms).filter((stamp): stamp is number => Number.isSafeInteger(stamp));
  if (deadlines.length > 0) return Math.min(...deadlines);
  // Legacy snapshots did not carry millisecond emission timestamps.
  if (job.status === "awaiting-input" && legacyTimeoutMs !== undefined && (asks.length > 0 || job.messages.length === 0)) {
    return (job.awaitingInputAtMs ?? job.lastActivityAt) + legacyTimeoutMs;
  }
  return undefined;
}

/** Distinguish completed stamped waits from legacy rows without deadline evidence. */
export function hasCallerDeadline(messages: Message[]): boolean {
  return messages.some((message) => message.from === "provider" &&
    (message.type === "prompt" || message.type === "payment-request") &&
    Number.isSafeInteger(message.content.expires_at_ms));
}
