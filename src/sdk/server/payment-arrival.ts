import type { Message } from "../../lib/messages/types";
import { askExpired } from "./ask-expiry";
import type { JobStatus } from "./job-store";

/**
 * How long a payment intent holds its job open. An intent is written when a
 * payment arrives and resolves when its outcome is recorded (`verifyAndCredit`
 * or `markInboundFailed`). Until then the job cannot go terminal, so a cancel
 * or an ask expiry that races verification commits after the payment, never
 * through it. The lease bounds that hold if the verifying process dies: once it
 * passes, the job can end, and a verification that still completes late lands
 * as balance because its draw is no longer pending. Two minutes covers the
 * 60 second settlement window an x402 authorization advertises.
 */
export const PAYMENT_INTENT_LEASE_MS = 120_000;

/** Why a payment that arrived bought nothing, as decided at arrival from the job row. */
export type ArrivalBalanceReason = "job_ended" | "ask_expired" | "no_open_ask";

/**
 * Why a payment bought nothing and landed on credit as balance: an arrival
 * reason, or one the ledger leg found. `rail_mismatch` means the job's credit
 * holds another rail or channel, so the payment funded a fresh credit;
 * `credit_unavailable` means the job's credit or draw could not take funds.
 */
export type PaymentBalanceReason = ArrivalBalanceReason | "rail_mismatch" | "credit_unavailable";

/** A balance landing, with the rail the job's credit holds when that is why. */
export interface BalanceLanding {
  reason: PaymentBalanceReason;
  jobRail?: string;
}

/**
 * What an arriving payment is for, decided under the job row lock at arrival:
 * pay the open ask, or land on credit as balance the caller can spend or drain.
 */
export type PaymentDisposition =
  | { disposition: "ask" }
  | { disposition: "balance"; reason: ArrivalBalanceReason };

/** The arrival a store recorded, with the sequence its inbound message holds. */
export interface RecordedPaymentArrival {
  seq: number;
  disposition: PaymentDisposition;
}

/**
 * Decide an arriving payment's disposition from the locked job row. The ask is
 * open while the job is live and `pending_payment_msats` is positive, until 30
 * seconds past the latest ask's `expires_at_ms`. Arrival time decides it, not
 * the time verification completes, so a slow mint cannot demote a payment that
 * arrived in time.
 */
export function decidePaymentDisposition(args: {
  status: JobStatus;
  pendingPaymentMsats: number | undefined;
  /** The latest verified provider `payment-request`, if the store still holds it. */
  ask: Pick<Message, "content"> | undefined;
  arrivedAtMs: number;
}): PaymentDisposition {
  if (args.status === "completed" || args.status === "failed" || args.status === "cancelled") {
    return { disposition: "balance", reason: "job_ended" };
  }
  if (!((args.pendingPaymentMsats ?? 0) > 0)) return { disposition: "balance", reason: "no_open_ask" };
  const expiresAtMs = (args.ask?.content as { expires_at_ms?: unknown } | undefined)?.expires_at_ms;
  if (typeof expiresAtMs === "number" && askExpired(expiresAtMs, args.arrivedAtMs)) {
    return { disposition: "balance", reason: "ask_expired" };
  }
  return { disposition: "ask" };
}

/**
 * Thrown by a job store asked to make a job terminal while a payment intent on
 * it is still open. Nothing was written; retry at or after `retryAtMs`, by
 * which the intent has resolved or its lease has run out.
 */
export class PaymentIntentOpenError extends Error {
  readonly code = "payment_intent_open";
  constructor(readonly jobId: string, readonly retryAtMs: number) {
    super(`job ${jobId} has a payment being verified; it cannot end before ${new Date(retryAtMs).toISOString()}`);
    this.name = "PaymentIntentOpenError";
  }
}

/**
 * Job-store support for payment intents, implemented by the built-in memory and
 * Postgres stores. A store without it keeps its previous behavior: arrivals are
 * recorded without a lock-time disposition and terminal writes are not held.
 */
export interface PaymentArrivalStore {
  /**
   * Tx B for a payment: under the job row lock, record the inbound message as
   * `pending-verification`, decide its disposition, and open an intent that
   * holds the job non-terminal until Tx C or a refusal resolves it, or until
   * `leaseMs` passes. Accepts a job that already ended (the payment lands as
   * balance); throws for a missing or redacted job.
   */
  recordPaymentArrival(
    jobId: string,
    message: { from: "requester"; type: "payment"; timestamp: number; content: Record<string, unknown> },
    opts: { arrivedAtMs: number; leaseMs: number }
  ): Promise<RecordedPaymentArrival>;
  /** The latest lease expiry among this job's open intents, or undefined when none is open. */
  openPaymentIntentUntil(jobId: string, nowMs: number): Promise<number | undefined>;
}

export function isPaymentArrivalStore(store: object): store is PaymentArrivalStore {
  return "recordPaymentArrival" in store && "openPaymentIntentUntil" in store;
}

/** The first wait before a terminal write held by a payment intent looks again. */
export const PAYMENT_INTENT_POLL_MS = 100;

/** The longest wait between looks; the waits double up to it. */
export const PAYMENT_INTENT_POLL_MAX_MS = 2_000;

/**
 * How long a caller's HTTP request may wait on a payment being verified before
 * it is answered 409 `payment_in_progress` instead, well inside common proxy
 * timeouts. The intent's own lease still bounds how long the job stays open.
 */
export const PAYMENT_INTENT_REQUEST_WAIT_MS = 5_000;

/** The open-intent refusal behind `error`, unwrapping a snapshot persistence wrapper. */
export function paymentIntentOpen(error: unknown): PaymentIntentOpenError | undefined {
  if (error instanceof PaymentIntentOpenError) return error;
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof PaymentIntentOpenError ? cause : undefined;
}

/**
 * How long to wait before the `attempt`th retry of a write an open intent
 * refused: doubling from {@link PAYMENT_INTENT_POLL_MS} to
 * {@link PAYMENT_INTENT_POLL_MAX_MS}, and never past the intent's lease.
 */
export function paymentIntentRetryDelayMs(retryAtMs: number, attempt: number, nowMs = Date.now()): number {
  const backoff = Math.min(PAYMENT_INTENT_POLL_MAX_MS, PAYMENT_INTENT_POLL_MS * 2 ** Math.min(attempt, 16));
  return Math.max(1, Math.min(backoff, retryAtMs - nowMs));
}

/**
 * Run a terminal write, waiting out any payment intent that refuses it. Each
 * intent resolves or its lease passes, so the wait is bounded by
 * {@link PAYMENT_INTENT_LEASE_MS} past the last arrival. With `maxWaitMs`, the
 * refusal is rethrown once that much time has passed, for a caller that must
 * answer sooner.
 */
export async function afterPaymentIntents<T>(write: () => Promise<T>, opts: { maxWaitMs?: number } = {}): Promise<T> {
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      const open = paymentIntentOpen(error);
      if (!open) throw error;
      await waitBeforeRetry(paymentIntentRetryDelayMs(open.retryAtMs, attempt), started, opts.maxWaitMs, open);
    }
  }
}

/**
 * Wait until no payment intent holds `jobId` open. A store without intents
 * never holds one. With `maxWaitMs`, throws {@link PaymentIntentOpenError}
 * once that much time has passed with an intent still open.
 */
export async function waitForPaymentIntents(store: object, jobId: string, opts: { maxWaitMs?: number } = {}): Promise<void> {
  if (!isPaymentArrivalStore(store)) return;
  const started = performance.now();
  for (let attempt = 0; ; attempt++) {
    const until = await store.openPaymentIntentUntil(jobId, Date.now());
    if (until === undefined) return;
    await waitBeforeRetry(paymentIntentRetryDelayMs(until, attempt), started, opts.maxWaitMs,
      new PaymentIntentOpenError(jobId, until));
  }
}

async function waitBeforeRetry(delayMs: number, started: number, maxWaitMs: number | undefined, open: PaymentIntentOpenError): Promise<void> {
  if (maxWaitMs !== undefined) {
    const left = started + maxWaitMs - performance.now();
    if (left <= 0) throw open;
    delayMs = Math.min(delayMs, left);
  }
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
