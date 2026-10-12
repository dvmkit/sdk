import type {
  ArtifactContent,
  MessageType,
  PaymentContent,
  ResponseContent,
} from "../../lib/messages/types";
import { createNoopLogger } from "../logger";
import { type Currency, validateCurrency } from "../pricing/index";
import { createInstrumentedFetch } from "../server/instrumented-fetch";
import { JobCancelledError } from "../server/job";
import { MemoryKVStore } from "../store";
import type {
  JobCost,
  KVStore,
  Logger,
  PromptOpts,
  SDKJobContext,
  SDKPaymentRequestOpts,
} from "../types";

/** Recorded outbound message. */
export interface RecordedMessage {
  type: MessageType;
  content: Record<string, unknown>;
}

export interface TestContextOpts<State = Record<string, unknown>, Input = string> {
  /** Override the job ID. Default: "test-job-1". */
  jobId?: string;
  /** Freeform tags describing the job type. Default: []. */
  tags?: string[];
  /** Job input — string for unstructured, or the parsed type for schema-based DVMs. */
  input?: Input;
  params?: Record<string, string>;
  /** Opaque requester identifier. */
  requesterId?: string;
  /** Total msats paid so far. */
  paidMsats?: number;
  /** Initial per-job state (cloned to avoid test pollution). */
  state?: State;
  /** Environment variables available via ctx.env. */
  env?: Record<string, string>;
  /** KV store instance. Default: in-memory MemoryKVStore. */
  store?: KVStore;
  /** Logger instance. Default: no-op logger. */
  log?: Logger;
  /** Pre-programmed responses for prompt() calls, keyed by prompt ID. */
  responses?: Record<string, ResponseContent>;
  /** Pre-programmed payment for requestPayment() calls. */
  payment?: PaymentContent;
}

/** Extended SDKJobContext exposing test inspection properties. */
export interface TestJobContext<
  State = Record<string, unknown>,
  Input = string,
> extends SDKJobContext<State, Input> {
  /** All outbound messages sent during the handler. */
  readonly messages: RecordedMessage[];
  readonly completed: boolean;
  readonly failed: boolean;
  /** Whether fail() was called with `{ refund: true }`. */
  readonly refundRequested: boolean;
  readonly summary: string | undefined;
  readonly failError: string | undefined;
  /**
   * What the handler declared through `ctx.cost()`, summed, in 1e-6 of
   * `currency` — exactly what the runtime would report to the platform.
   * `undefined` when the handler declared nothing, and also when it declared
   * two different currencies, which the runtime refuses to report.
   */
  readonly reportedCost: { amountMicro: number; currency: string } | undefined;
  /**
   * Cancel the job under test — aborts `ctx.signal` exactly as a
   * caller cancel, idle timeout, or stale-sweep would in the real runtime, and
   * puts the context into the same post-terminal shape: every emitter
   * (`text` / `artifact` / `sendMessage` / `working` / `progress` /
   * `complete` / `fail`) becomes a no-op, and `prompt` / `requestPayment`
   * reject with `JobCancelledError` rather than hanging. Use it to assert your
   * handler stops work after cancellation.
   */
  cancel(reason?: string): void;
}

/** Create a test-only SDKJobContext for unit testing DVM handlers. */
export function createTestContext<State = Record<string, unknown>, Input = string>(
  opts?: TestContextOpts<State, Input>
): TestJobContext<State, Input> {
  const messages: RecordedMessage[] = [];
  const abort = new AbortController();
  let cancelled = false;
  let completed = false;
  let failed = false;
  let refundRequested = false;
  let summary: string | undefined;
  let failError: string | undefined;
  /** Major units, summed; only the total is rounded — mirrors the runtime. */
  let costAmount = 0;
  let costMicro = 0;
  let costCurrency: Currency | undefined;
  let costPoisoned = false;
  const state = opts?.state !== undefined ? structuredClone(opts.state) : ({} as State);
  const store = opts?.store ?? new MemoryKVStore();
  const env = opts?.env ?? {};
  const log = opts?.log ?? createNoopLogger();
  const input = (opts?.input ?? "") as Input;

  const ctx: TestJobContext<State, Input> = {
    jobId: opts?.jobId ?? "test-job-1",
    tags: opts?.tags ?? [],
    input,
    params: opts?.params ?? {},
    requesterId: opts?.requesterId ?? "test-requester",
    paidMsats: opts?.paidMsats ?? 0,

    get messages() {
      return messages;
    },
    get completed() {
      return completed;
    },
    get failed() {
      return failed;
    },
    get refundRequested() {
      return refundRequested;
    },
    get summary() {
      return summary;
    },
    get failError() {
      return failError;
    },
    get reportedCost() {
      if (costPoisoned || costCurrency === undefined) return undefined;
      return { amountMicro: costMicro, currency: costCurrency };
    },

    text(message: string): void {
      if (cancelled) return;
      messages.push({ type: "text", content: { text: message } });
    },
    artifact(content: ArtifactContent): void {
      if (cancelled) return;
      messages.push({
        type: "artifact",
        content: content as unknown as Record<string, unknown>,
      });
    },
    sendMessage(type: MessageType, content: Record<string, unknown>): void {
      if (cancelled) return;
      messages.push({ type, content });
    },

    prompt(id: string, text: string, promptOpts?: PromptOpts): Promise<ResponseContent> {
      if (cancelled) return Promise.reject(new JobCancelledError());
      messages.push({
        type: "prompt",
        content: { id, text, ...promptOpts },
      });
      const response = opts?.responses?.[id];
      if (!response) {
        return Promise.reject(
          new Error(
            `TestContext: no pre-programmed response for prompt "${id}". ` +
              `Pass responses: { "${id}": { prompt_id: "${id}", text: "..." } } to createTestContext.`
          )
        );
      }
      return Promise.resolve(response);
    },
    requestPayment(
      amount: number | { amount: number; currency: Currency },
      reason: string,
      payOpts?: SDKPaymentRequestOpts
    ): Promise<PaymentContent> {
      if (cancelled) return Promise.reject(new JobCancelledError());
      messages.push({
        type: "payment-request",
        content: { amount, reason, ...payOpts },
      });
      const payment = opts?.payment;
      if (!payment) {
        return Promise.reject(
          new Error(
            "TestContext: no pre-programmed payment. " +
              "Pass payment: { amount_msats: ... } to createTestContext."
          )
        );
      }
      return Promise.resolve(payment);
    },
    working(estimateSeconds?: number, hint?: string): void {
      if (cancelled) return;
      messages.push({
        type: "working",
        content: { estimate_seconds: estimateSeconds, hint },
      });
    },
    progress(percentComplete: number, phase?: string, hint?: string): void {
      if (cancelled) return;
      const pct = Math.max(0, Math.min(100, percentComplete));
      const content: Record<string, unknown> = { percent_complete: pct };
      if (phase) content.current_phase = phase;
      if (hint) content.hint = hint;
      messages.push({ type: "progress", content });
    },
    complete(s: string): void {
      // Mirrors the runtime's terminal guard: a cancelled job can't
      // be resurrected by a handler that kept running.
      if (cancelled) return;
      completed = true;
      summary = s;
      messages.push({ type: "complete", content: { summary: s } });
    },
    fail(error: string, failOpts?: { refund?: boolean }): void {
      if (cancelled) return;
      failed = true;
      failError = error;
      if (failOpts?.refund) refundRequested = true;
      messages.push({ type: "cancel", content: { reason: error } });
    },
    cancel(reason = "Job cancelled"): void {
      if (cancelled) return;
      cancelled = true;
      abort.abort(new JobCancelledError(reason));
    },

    cost(declared: JobCost): void {
      // Mirrors the runtime: terminal is terminal, a currency switch reports
      // nothing rather than something wrong, and declarations are summed in
      // major units and rounded once so a sub-millionth call is not floored
      // away. `step` below never caches, so it can execute declarations in its
      // body directly without needing the runtime's replay metadata.
      if (cancelled) return;
      const currency = validateCurrency(declared.currency);
      const total = costAmount + declared.amount;
      const micro = Math.round(total * 1e6);
      if (!Number.isFinite(declared.amount) || declared.amount < 0 || !Number.isSafeInteger(micro)) {
        throw new RangeError(
          `ctx.cost amounts must each be a finite, non-negative number of currency units, and ` +
            `must total no more than ${Math.floor(Number.MAX_SAFE_INTEGER / 1e6)}; got ` +
            `${String(declared.amount)}`
        );
      }
      if (costCurrency !== undefined && costCurrency !== currency) costPoisoned = true;
      costCurrency ??= currency;
      if (costPoisoned) return;
      costAmount = total;
      costMicro = micro;
    },

    async step<T>(_id: string, fn: () => Promise<T>): Promise<T> {
      return fn();
    },

    state,
    store,
    fetch: createInstrumentedFetch(abort.signal),
    signal: abort.signal,
    env,
    log,
  };

  return ctx;
}
