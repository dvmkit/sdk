import { randomBytes } from "node:crypto";

import { msatsToUsdc } from "../../lib/payment-amounts";
import type { MppxChallenge, PaymentContent, ResponseContent } from "../../lib/messages/types";
import { buildPaymentRequiredV2 } from "../../lib/x402/spec";
import type { X402Config } from "../../lib/x402/types";
import { loggers } from "../../observability/loggers";
import { createConsoleLogger } from "../logger";
import type { Currency, FxFetcher, FxRateSnapshot } from "../pricing/index";
import {
  createFxFetcher,
  fiatToSatsCeil,
  fxRateFor,
  FxRateUnavailableError,
  UnsupportedCurrencyError,
  validateCurrency,
} from "../pricing/index";
import type { StepRecord } from "../step-cache";
import { createStepRunner } from "../step-runner";
import type { JobCost, KVStore, PaymentMethod, SDKJobContext } from "../types";
import { resolveServerBtcUsdRate } from "./btc-rate";
import type { FiatDenominationFailure, PriceFiat } from "./funding";
import { deferredX402IntentId, pinAskFiat, resolveFxSnapshot } from "./funding";
import { createInstrumentedFetch } from "./instrumented-fetch";
import { instrumentKVStore } from "./instrumented-kv";
import type { ServerJob } from "./job";
import { AskAlreadyOpenError, isTerminal, JobCancelledError, providerMessage } from "./job";
import type { JobCounters } from "./job-store";
import { accumulateAskedTopUp } from "./job-store";
import type { MppxServer } from "./mpp-setup";
import { fiatMicroToMethodAmount, msatsToMethodAmount } from "./mpp-units";
import { chargedIfDeclinedMicro, checkFinishedCharge, finishRunningPiece, runningPiece } from "./pieces";
import type { CanonicalEnvelope } from "./signed-request";
import type { X402FacilitatorHealthLike } from "./x402-facilitator-support";

/**
 * The job's draw as `ctx.requestPayment` reads it, for the denomination a mid-job ask is pinned
 * in.
 *
 * `rail` is a job whose counters are its rail's own traffic, `draw` a job bound to a credit
 * whose draw read in its currency, and `unpriced` a job that drew but whose draw could not be
 * read. `creditCurrency` on the two non-draw arms is the credit's denomination; its absence on
 * `rail` means the job is bound to no credit yet, the free-then-paid shape.
 */
export type DrawPool =
  | { basis: "rail"; creditCurrency?: string }
  | { basis: "draw"; amountMicro: number; currency: string }
  | { basis: "unpriced"; creditCurrency?: string };

export interface BuildContextOpts {
  mints?: string[];
  store: KVStore;
  env: Record<string, string>;
  /** Pre-parsed input (from schema validation). Overrides job.input when set. */
  parsedInput?: unknown;
  /**
   * Verified caller identity, set when the descriptor's `auth` scheme fired
   * upstream of the handler. Handlers read it as `ctx.auth`.
   */
  auth?: { pubkey: string; envelope: CanonicalEnvelope & Record<string, unknown> };
  /**
   * Called when the job reaches a terminal state (completed, failed). May be
   * async — the returned promise is the tail of `job.terminalWork`, which the
   * submit path awaits so a job that finishes within the request can carry its
   * signed receipt on the synchronous 200.
   */
  onTerminal?: () => void | Promise<void>;
  /** Called at yield points (prompt, payment-request) and terminal states to persist job state. */
  onYield?: () => Promise<void>;
  onCallerResume?: () => void;
  /** Persist a completed step before returning its value to the handler. */
  onStep?: (record: StepRecord) => Promise<void>;
  /** Persist a remaining prompt wait after accepted payment, without repeating verification. */
  onPaymentResume?: () => Promise<void>;
  paymentMethods?: PaymentMethod[];
  /**
   * The job is an unsigned paid call, so its mid-job asks offer Cashu alone.
   * A push-mode Tempo wallet broadcasts its transfer before the server sees the
   * credential, so refusing the credential afterwards cannot stop the payment;
   * the ask must not advertise the rail at all.
   */
  cashuOnly?: boolean;
  x402?: X402Config;
  /** Live facilitator capabilities used to suppress unavailable mid-job asks. */
  x402FacilitatorHealth?: X402FacilitatorHealthLike;

  mpp?: MppxServer;
  /**
   * Shared fx fetcher used to convert fiat-form `ctx.requestPayment` calls
   * Optional so unit tests that never exercise the fiat path don't
   * need to wire one; the first fiat call lazily falls back to
   * `createFxFetcher()` against the default CoinGecko source.
   */
  fxFetcher?: FxFetcher;
  /**
   * Subscribe to NOTIFY events for this job. Wired by `JobManager`
   * when the store is streamable. `requestPayment` uses it to wake when
   * cross-machine credit lands in Tx C — the in-process `pendingPayment`
   * resolver wouldn't fire because the inbound never reached this process.
   */
  subscribeNotifications?: (onNotify: () => void) => Promise<() => void>;
  /**
   * Read the latest counters from the store (paidMsats, pendingPaymentMsats,
   * status). Paired with `subscribeNotifications` — on each notify, the
   * resolver re-reads counters and decides whether to wake.
   */
  getCounters?: () => Promise<JobCounters | undefined>;
  /** Durable acceptance of this cached balance payment for the replayed fiat ask. */
  acceptedBalancePayment?: (seq: number, amountMicro: number | undefined, currency: string | undefined) => Promise<boolean>;
  /**
   * Single-execution claim. Atomically flip the job
   * `awaiting-input → processing`, returning `true` only if this handler won.
   * Called by the NOTIFY-woken `requestPayment` resolver before it resumes, so
   * a reactivation replay on the paying machine can't also drive the job. Wired
   * by `JobManager` when the store is streamable. The optional continuation
   * stays inside the job's local resume queue through any durable wait reopen.
   */
  claimForProcessing?: (resume?: () => Promise<void>) => Promise<boolean>;
  /**
   * Tear down this machine's local scaffold (idle timer, activeJobs entry) when
   * the handler is superseded — a reactivation replay won the single-execution
   * claim while this handler was still suspended. Wired by
   * `JobManager`.
   */
  onSuperseded?: () => void;
  /**
   * The job's draw, read for the currency a mid-job ask is pinned in. Omitted by a
   * `JobManager` with no credit ledger, which is the `rail` answer. Never rejects: a ledger
   * it cannot read for a job that drew resolves `unpriced`.
   *
   * A function rather than a value because a mid-job top-up commits on whichever machine
   * took the payment, so it is re-read per ask.
   */
  drawPool?: () => Promise<DrawPool>;
  /**
   * The DVM's declared pricing currency — and therefore the currency
   * of every credit it opens. Seeds the denomination a mid-job ask is pinned in
   * on a job that holds no credit yet, which is the currency the credit that
   * first payment opens will carry. Defaults to `"usd"`.
   */
  pricingCurrency?: string;
  /**
   * The one rail that can pay into the credit this job is bound to, read per
   * ask. A payment on any other rail lands on a fresh credit as balance and
   * leaves the ask unpaid, so the ask offers this rail alone. Undefined when
   * the job holds no credit, the credit takes any rail, or none of the rails
   * the ask could offer pays into it; the ask then offers every rail.
   */
  creditRail?: () => Promise<CreditRail | undefined>;
}

/** A rail a mid-job ask can offer. */
export type CreditRail = "cashu" | "x402" | "tempo";

/**
 * Offer only the rail that can pay into the job's credit. When the ask would
 * not otherwise offer that rail, nothing is withheld: an ask with no payable
 * rail strands the job, while a payment on another rail still lands as
 * balance. A withdrawn Tempo option takes its job binding with it. A withdrawn
 * x402 option leaves the job bound to a fresh nonce nobody was shown, so an x402
 * payment sent anyway is refused before it settles rather than settled and
 * landed as balance.
 */
function restrictToCreditRail(content: Record<string, unknown>, rail: CreditRail | undefined, job: ServerJob): void {
  if (!rail) return;
  const offered: Record<CreditRail, boolean> = {
    cashu: content.mints !== undefined,
    x402: content.x402 !== undefined,
    tempo: content.tempo !== undefined,
  };
  if (!offered[rail]) return;
  if (rail !== "cashu") {
    delete content.mints;
    delete content.min_locktime_seconds;
  }
  if (rail !== "x402" && offered.x402) {
    delete content.x402;
    job.pendingX402Nonce = `0x${randomBytes(32).toString("hex")}`;
    job.pendingX402AmountUsdcMicro = undefined;
  }
  if (rail !== "tempo" && offered.tempo) {
    delete content.tempo;
    job.pendingMppChallengeIds = undefined;
  }
}

export function buildContext(
  job: ServerJob,
  opts: BuildContextOpts
): SDKJobContext<unknown, unknown> {
  const log = createConsoleLogger(job.id);
  const instrumentedStore = instrumentKVStore(opts.store);
  const instrumentedFetch = createInstrumentedFetch(job.abort.signal);

  // a handler that keeps running after the job went terminal (the
  // caller cancelled, the job idled out, the stale sweeper reaped it) must not
  // be able to write over that terminal state — an unguarded `ctx.complete()`
  // resurrected cancelled jobs as `completed`, booked revenue on them, and
  // reported success to the caller who cancelled. Every context call that
  // writes `job.status` or emits a message routes through this guard. It warns
  // rather than throws: a well-behaved handler racing the cancel shouldn't
  // crash the host.
  const terminated = (op: string): boolean => {
    if (!isTerminal(job.status)) return false;
    log.warn(`ctx.${op}() ignored — job already ${job.status}`, { op, status: job.status });
    return true;
  };

  // Persist the terminal snapshot, then hand off to the JobManager's terminal
  // handling (revenue report, receipt signing, cleanup scheduling). The whole
  // chain is parked on `job.terminalWork` **synchronously**, at the instant the
  // handler called `complete()`/`fail()` — that's what lets `POST /v1/job` put
  // a receipt on the synchronous 200. It can't await the chain it
  // hasn't seen started, and a job that terminates within the request tick has
  // always terminated before the route re-reads its status.
  //
  // Never rejects: each leg swallows its own failure, so an awaiting caller
  // resumes either way.
  const runTerminal = (): void => {
    const chain = opts.onYield
      ? opts
          .onYield()
          .catch((err: unknown) => {
            log.error("Failed to persist job at terminal", { error: String(err) });
          })
          .then(() => opts.onTerminal?.())
      : Promise.resolve(opts.onTerminal?.());
    job.terminalWork = chain.catch((err: unknown) => {
      log.error("Terminal handling failed", { error: String(err) });
    });
  };

  // Concurrent branches can reach their persisted prompts after another
  // branch has moved past payment replay. Keep each prompt available once,
  // independently of that mutable replay cursor.
  let replayPrompts: ServerJob["messages"] | undefined;
  const captureReplayPrompts = (): void => {
    if (replayPrompts === undefined && job.replayHighSeq !== null) {
      replayPrompts = job.messages.filter((m) => m.from === "provider" && m.type === "prompt" && m.seq <= job.replayHighSeq!);
    }
  };

  let askInFlight = false;

  // `ctx.complete` with a payment request open withdraws it: the handler stops waiting, and a
  // payment that arrives once the job has ended lands on credit as balance.
  const withdrawAsk = (): void => {
    const pending = job.pendingPayment;
    job.pendingPayment = null;
    job.pendingPaymentMsats = undefined;
    job.pendingPaymentFiatMicro = undefined;
    job.pendingPaymentFiatCurrency = undefined;
    job.pendingMppChallengeIds = undefined;
    job.pendingX402Nonce = undefined;
    job.pendingX402AmountUsdcMicro = undefined;
    pending?.reject(new JobCancelledError("The job completed; its open payment request was withdrawn"));
  };

  // Per-context running total of what the handler has declared through
  // `ctx.cost()`, in MAJOR units of `declaredCostCurrency`.
  //
  // Major, not micro, because the declarations are summed before they are
  // rounded. Rounding each call on its own would floor anything finer than a
  // millionth to zero, and a thousand such calls would still total zero — a
  // DECLARED zero, which reads as a 100% margin, when the honest answer is
  // the sum. Per-token LLM pricing lands in exactly that range, and "declare
  // each cost where you incur it" is what the docs ask for, so the fine-
  // grained case is the expected one rather than a corner. Only the total is
  // rounded, at assignment.
  //
  // Per-context, like the credited counters above, and for the same reason:
  // this context is rebuilt on every reactivation and the handler re-runs from
  // the top, so the total is RE-DERIVED from the call sequence and ASSIGNED
  // onto the job, never incremented onto whatever the row already held. An
  // incrementing counter would double a replayed job's cost — `fromJobRecord`
  // rehydrates the persisted figure, so `+=` would sum this attempt's total
  // onto the last attempt's.
  //
  // Declarations inside a step body are persisted with that step and replayed
  // through the same accumulator on a cache hit. The exact call sequence is
  // retained rather than only its sum so floating-point addition, range
  // validation, and currency-switch poisoning are identical on replay.
  //
  // `costPoisoned` is the currency-switch arm. One job's cost is one number in
  // one currency; a handler that names two has told us something we cannot
  // report, so the job reports no cost at all rather than a wrong one. Unlike
  // the step refusal this is deliberately NOT a throw: which currencies a
  // handler names can be data-dependent, so the switch can first appear in
  // production, mid-job, after the caller has already been served — and
  // failing a delivered job over an analytics field is the worse outcome. It
  // degrades to "unreported", which is a state the platform already shows
  // honestly, and says so in the log. Mirrors `accumulateAskedTopUp`'s
  // `ask_currency_switch` poison.
  let declaredCostAmount = 0;
  let declaredCostCurrency: Currency | undefined;
  let declaredCostRevision = 0;
  let costPoisoned = false;

  const declareCost = (declared: JobCost): void => {
    if (terminated("cost")) return;
    const currency = validateCurrency(declared.currency);
    // Sum first, round once — see the counter's declaration above for why.
    // Persisting each call on its enclosing step records keeps this addition
    // sequence bit-for-bit identical on a cache hit.
    const total = declaredCostAmount + declared.amount;
    const micro = Math.round(total * 1e6);
    if (!Number.isFinite(declared.amount) || declared.amount < 0 || !Number.isSafeInteger(micro)) {
      throw new RangeError(
          `ctx.cost amounts must each be a finite, non-negative number of currency units, and ` +
          `must total no more than ${Math.floor(Number.MAX_SAFE_INTEGER / 1e6)}; got ` +
          `${String(declared.amount)}`
      );
    }

    declaredCostRevision += 1;
    job.costRevision = declaredCostRevision;

    // Copy only the validated declaration. The handler may retain and mutate
    // its input object after this call, but persisted replay must not change.
    const replayable = { amount: declared.amount, currency };
    steps.recordCost(replayable);

    if (declaredCostCurrency !== undefined && declaredCostCurrency !== currency) {
      costPoisoned = true;
      log.error("ctx.cost() currency switched mid-job — this job reports no cost", {
        declared: currency,
        pinned: declaredCostCurrency,
      });
    }
    declaredCostCurrency ??= currency;
    if (costPoisoned) {
      job.costAmountMicro = undefined;
      job.costCurrency = undefined;
      return;
    }
    declaredCostAmount = total;
    // Assigned, never incremented — see the counter's declaration above.
    job.costAmountMicro = micro;
    job.costCurrency = currency;
  };

  const steps = createStepRunner(job.stepCache, declareCost, opts.onStep);

  const ctx: SDKJobContext<unknown, unknown> = {
    jobId: job.id,
    tags: job.tags,
    input: opts.parsedInput ?? (job.input as unknown),
    params: job.params,
    requesterId: job.requesterId,
    get paidMsats() {
      return job.paidMsats;
    },
    auth: opts.auth,

    text: (message) => {
      if (terminated("text")) return;
      providerMessage(job, "text", { text: message });
    },
    artifact: (content) => {
      if (terminated("artifact")) return;
      providerMessage(job, "artifact", content);
    },
    sendMessage: (type, content) => {
      if (terminated("sendMessage")) return;
      if ((type === "prompt" || type === "payment-request") && deferredX402IntentId(job.creditId)) {
        throw new Error(
          `ctx.sendMessage("${type}") is unavailable: this job was paid by an x402 authorization that settles only when it succeeds`
        );
      }
      if (type === "payment-request" && typeof content.amount_msats === "number") job.pendingPaymentMsats = content.amount_msats;
      // Any payment-request finishes the piece in progress, in its Tx A and here.
      if (type === "payment-request" && job.pieces) job.pieces = finishRunningPiece(job.pieces);
      providerMessage(job, type, content);
      if ((type === "prompt" || type === "payment-request") && opts.onYield) {
        void opts.onYield().catch((err: unknown) => {
          log.error("Failed to persist event-driven wait", { error: String(err) });
        });
      }
    },

    prompt: (id, text, promptOpts) => {
      // A prompt against a terminal job can never be answered — the cancel
      // path rejected the pending resolvers and the wire layer 409s further
      // inbound messages. Reject rather than hang the handler on a promise
      // nothing will settle.
      if (terminated("prompt")) {
        return Promise.reject(new JobCancelledError(`Job already ${job.status}`));
      }
      if (deferredX402IntentId(job.creditId)) {
        return Promise.reject(
          new Error("ctx.prompt is unavailable: this job was paid by an x402 authorization that settles only when it succeeds")
        );
      }
      job.status = "awaiting-input";
      captureReplayPrompts();
      const originalIndex = replayPrompts?.findIndex((m) => m.type === "prompt" && m.content.id === id) ?? -1;
      const original = originalIndex < 0 ? undefined : replayPrompts!.splice(originalIndex, 1)[0];
      if (original) {
        // Each concurrent ask consumes its own history slot. An unanswered
        // prompt does not end replay for its still-pending siblings.
        if (job.replayProviderSkip > 0) job.replayProviderSkip--;
        const response = job.messages.find(
          (m) => m.type === "response" && m.from === "requester" && m.content.prompt_id === id && m.seq > original.seq
        );
        if (response) {
          job.status = job.pendingPrompts.size > 0 || job.pendingPayment ? "awaiting-input" : "processing";
          opts.onCallerResume?.();
          return Promise.resolve(response.content as ResponseContent);
        }
      } else {
        job.replayHighSeq = null;
        job.replayProviderSkip = 0;
        providerMessage(job, "prompt", {
          id, text,
          ...(promptOpts?.options && { options: promptOpts.options }),
          ...(promptOpts?.schema && { schema: promptOpts.schema }),
        });
      }

      // Register resolver synchronously — no await before this, so no race with incoming responses
      const p = new Promise<ResponseContent>((resolve, reject) => {
        job.pendingPrompts.set(id, { resolve, reject });
      });
      // Persist state + step cache before suspending (fire-and-forget with error logging)
      if (opts.onYield) {
        void opts.onYield().catch((err: unknown) => {
          log.error("Failed to persist job at yield", { error: String(err) });
        });
      }
      return p;
    },
    requestPayment: async (amount, reason, payOpts) => {
      captureReplayPrompts();
      // Same reasoning as `prompt` — a cancelled job will never be paid.
      if (terminated("requestPayment")) {
        throw new JobCancelledError(`Job already ${job.status}`);
      }
      // Its draw does not exist until the job succeeds, so there is nothing
      // for a top-up to grow.
      if (deferredX402IntentId(job.creditId)) {
        throw new Error(
          "ctx.requestPayment is unavailable: this job was paid by an x402 authorization that settles only when it succeeds"
        );
      }
      const finishedChargeMicro = payOpts?.finishedChargeMicro;
      let amountMsats: number;
      let fiatAmount: { amount: number; currency: Currency } | undefined;
      // Hoisted so the pin below converts on the SAME snapshot that sized the
      // ask's msats — no second fetch, no second failure door, and
      // the wire ask and the ledger pin can't disagree about the rate.
      let fxSnapshot: FxRateSnapshot | undefined;
      if (typeof amount === "number") {
        amountMsats = amount;
      } else {
        // Fiat envelope. Validate the currency, preflight against
        // the fetcher's configured set so an unsupported currency raises a
        // structured error before any network hit, then live-convert via
        // the shared fx fetcher so every fiat-form mid-job charge on this
        // process shares the same 60s cache window with the upfront quote.
        const currency = validateCurrency(amount.currency);
        const fetcher = opts.fxFetcher ?? lazyFxFetcher();
        const supported = fetcher.supportedCurrencies();
        if (!supported.includes(currency)) {
          throw new UnsupportedCurrencyError(currency, supported);
        }
        fxSnapshot = await fetcher.fetch();
        amountMsats = fiatToSatsCeil(amount.amount, fxRateFor(fxSnapshot, currency)) * 1000;
        fiatAmount = { amount: amount.amount, currency };
      }

      // Read per ask, never captured per context: a mid-job top-up grows the draw on whichever
      // machine took the payment, and `reactivateJob` builds the context before that growth is
      // even committed.
      const pool: DrawPool = opts.drawPool
        ? await opts.drawPool().catch((): DrawPool => ({ basis: "unpriced" }))
        : { basis: "rail" };
      const poolCurrency = pool.basis === "draw" ? pool.currency : undefined;

      // The denomination this job's asks are pinned in, and the ceiling on its
      // draw growth is summed in. Three rungs, most durable first:
      //
      // 1. The job's OWN denomination, if it has already made an ask. It is
      // first-write-wins in Tx A (`COALESCE(asked_topup_currency, …)`) and
      // round-trips through reactivation, so reading it back is what makes a
      // mid-job currency switch unexpressible rather than merely unlikely —
      // independent of a flapping pool read, of which machine took the ask,
      // and of an operator changing `DVMConfig.currency` mid-flight. The
      // accumulator's switch arm poisons the total to a permanent `-1`, so
      // "usually agrees" is not good enough here.
      // 2. The currency of the credit this job is actually bound to — the draw's
      // when it read, otherwise the credit's own, which the `rail` arm carries
      // for the implicit N=1 case.
      // 3. The DVM's declared currency, which is what a credit opened by this
      // job's first payment will be denominated in.
      const askCurrency =
        job.askedTopUpCurrency ??
        poolCurrency ??
        (pool.basis === "draw" ? undefined : pool.creditCurrency) ??
        opts.pricingCurrency ??
        "usd";

      // what this ask is worth in fiat, pinned now. The mid-job
      // payment that satisfies it becomes a `fund_credit` + `growDraw` on the
      // job's credit, and that ledger leg is fiat-denominated — pricing it at
      // accept time instead would let a rate move between the ask and the
      // payment drift the ledger away from what the caller was quoted, and would
      // drop the exactness a fiat-form ask already has.
      //
      // A fiat-form ask already in `askCurrency` is exact and pins verbatim. Any
      // other form needs the fx hop; `ctx.requestPayment(50_000, …)` is still a
      // supported ask. It returns `undefined` rather than throwing when the rate
      // provider is down, and the job's ask total records why it lost its ceiling.
      //
      // Denominated in `askCurrency`, so the figure `growDraw` adds and caps
      // against is one pinned integer and a rate move between the ask and the
      // payment cannot clip a payment the caller owes. An ask naming some other
      // currency converts rather than being refused; the wire's `fiat_amount`
      // keeps the builder's currency verbatim.
      //
      // The fetch degrades onto the fetcher's last-known snapshot
      // (`resolveFxSnapshot`) rather than reading one blip at the rate provider
      // as "no rate". This leg is free on a fiat-form ask — `fxSnapshot` already
      // holds the snapshot that sized the msats. When the pin is lost, say which
      // failure did it.
      let pinned: PriceFiat | undefined;
      let pinnedDone = false;
      const pinAsk = async (): Promise<PriceFiat | undefined> => {
        if (pinnedDone) return pinned;
        pinnedDone = true;
        let fx: FxRateSnapshot;
        let staleSnapshot = false;
        let cachedAt: number | undefined;
        if (fxSnapshot) {
          fx = fxSnapshot;
        } else {
          const resolved = await resolveFxSnapshot(opts.fxFetcher ?? lazyFxFetcher());
          if (!resolved.ok) {
            warnPinLost(job.id, askCurrency, amountMsats, resolved.reason, resolved.detail);
            return undefined;
          }
          fx = resolved.snapshot;
          staleSnapshot = resolved.stale;
          cachedAt = resolved.cachedAt;
        }
        // The pin is the figure that goes on the ledger and that `growDraw` caps
        // against, so "priced off a rate nothing could re-confirm" is exactly as
        // material here as at the verify-time leg — which reports it as
        // `credit_topup_stale_rate`. Two rungs degrade: the whole snapshot came
        // from `lastKnown()`, or the source stopped carrying this one currency and
        // it was carried forward. An ask that pins verbatim reads no rate at all.
        const pinReadsRate = fiatAmount?.currency !== askCurrency;
        const carriedForward = pinReadsRate && (fx.carried_forward?.includes(askCurrency) ?? false);
        if (pinReadsRate && (staleSnapshot || carriedForward)) {
          loggers.isolate.warn("dvm.ask_pin_stale_rate", {
            job_id: job.id,
            ask_currency: askCurrency,
            ask_msats: amountMsats,
            ...(carriedForward && { rate_carried_forward: true }),
            ...(cachedAt !== undefined && {
              rate_cached_at: new Date(cachedAt).toISOString(),
            }),
          });
        }
        try {
          pinned = pinAskFiat({
            msats: amountMsats,
            currency: askCurrency,
            fx,
            exact: fiatAmount,
          });
        } catch (err) {
          warnPinLost(
            job.id,
            askCurrency,
            amountMsats,
            // A currency the snapshot never carried is the rate source
            // narrowing, not one this DVM doesn't speak.
            err instanceof FxRateUnavailableError ? "rate_unavailable" : "unsupported_currency",
            err instanceof Error ? err.message : String(err)
          );
          pinned = undefined;
        }
        return pinned;
      };

      const replayedPaymentRequest = job.replayHighSeq !== null &&
        job.replayPaymentIndex >= job.messages.filter((m) => m.from === "requester" && m.type === "payment").length
        ? job.messages.findLast((m) => m.from === "provider" && m.type === "payment-request" && m.seq <= job.replayHighSeq! &&
          m.seq > (job.messages.findLast((message) => message.from === "requester" && message.type === "payment")?.seq ?? -1))
        : undefined;
      const originalAsk = replayedPaymentRequest?.type === "payment-request" ? replayedPaymentRequest.content : undefined;
      if (originalAsk) amountMsats = originalAsk.amount_msats;
      // Every ask is new money. A replay re-walks asks the job already made: their pieces were
      // finished when they were first written, so only an ask about to be written is checked.
      const replayingPaidAsk = job.replayHighSeq !== null && job.replayPaymentIndex <
        job.messages.filter((m) => m.type === "payment" && m.from === "requester" && m.seq <= job.replayHighSeq!).length;
      if (!originalAsk && !replayingPaidAsk) checkFinishedCharge(runningPiece(job.pieces), finishedChargeMicro);
      const pendingFiat = originalAsk
        ? (originalAsk.credit ? { amountMicro: originalAsk.credit.amount_micro, currency: originalAsk.credit.currency } : undefined)
        : await pinAsk();
      job.pendingPaymentMsats = amountMsats;
      job.pendingPaymentFiatMicro = pendingFiat?.amountMicro;
      job.pendingPaymentFiatCurrency = pendingFiat?.currency;

      // Replay reuses the original challenge bindings as well as its deadline.
      let paymentRequestContent: Record<string, unknown>;
      if (originalAsk) {
        paymentRequestContent = { ...originalAsk };
        // An ask that withheld x402 carries no nonce; keep the unadvertised one its row holds.
        job.pendingX402Nonce = originalAsk.x402 ? originalAsk.x402.nonce : job.pendingX402Nonce;
        job.pendingX402AmountUsdcMicro = originalAsk.x402?.required_usdc_micro;
        job.pendingMppChallengeIds = originalAsk.tempo?.challenges.map((challenge) => challenge.id);
      } else {
        // Build the payment-request content, resolving x402/MPP from explicit opts or server config
        paymentRequestContent = {
          amount_msats: amountMsats,
          reason,
          ...(pendingFiat && { credit: { amount_micro: pendingFiat.amountMicro, currency: pendingFiat.currency } }),
          ...(fiatAmount && { fiat_amount: fiatAmount }),
          ...(payOpts?.mints && { mints: payOpts.mints }),
          ...(payOpts?.minLocktimeSeconds && { min_locktime_seconds: payOpts.minLocktimeSeconds }),
          ...(!payOpts?.mints && opts.mints && { mints: opts.mints }),
          // What declining this ask costs: the pieces finished so far, this ask finishing the
          // one in progress. Absent on a job accepted before piece accounting.
          ...(job.pieces && {
            charged_if_declined_micro: chargedIfDeclinedMicro(finishRunningPiece(job.pieces, finishedChargeMicro)),
          }),
        };

        // x402 payment option
        let paymentRate: number | undefined;
        let x402Nonce: string | undefined;
        let x402AmountUsdcMicro: string | undefined;
        const hasExplicitX402 = Boolean(payOpts?.x402);
        // USDC can state a USD-denominated ask exactly. On any other DVM
        // currency it would require a fresh FX conversion, so x402 is withheld
        // even when the handler supplies an explicit per-ask override.
        if (!opts.cashuOnly && (opts.pricingCurrency ?? "usd") === "usd") {
          if (payOpts?.x402) {
            paymentRequestContent.x402 = payOpts.x402;
          } else if (
            opts.paymentMethods?.includes("x402") &&
            opts.x402 &&
            (opts.x402FacilitatorHealth?.support().available ?? true)
          ) {
            paymentRequestContent.x402 = {
              pay_to: opts.x402.payTo,
              network: opts.x402.network,
              asset: opts.x402.asset ?? "USDC",
              ...(opts.x402.facilitator && { facilitator: opts.x402.facilitator }),
            };
          }
        }
        // Per-job x402 binding: stamp a fresh 32-byte CSPRNG nonce on
        // the outbound x402 envelope and capture it on the job. The caller signs
        // the EIP-3009 `TransferWithAuthorization` against this exact `bytes32`;
        // `processIncomingPayment` rejects credentials whose decoded
        // authorization nonce differs, blocking a cross-job replay of a payload
        // signed for the right `(payTo, value)` against an unrelated job before
        // its `transferWithAuthorization` lands on chain. Mirrors the MPP
        // `pendingMppChallengeIds` shape; single scalar because x402 carries one
        // credential per payment-request.
        if (paymentRequestContent.x402) {
          paymentRate = (await resolveServerBtcUsdRate(opts.fxFetcher)).rate;
          x402Nonce = `0x${randomBytes(32).toString("hex")}`;
          x402AmountUsdcMicro = msatsToUsdc(amountMsats, paymentRate).toString();
          const x402Request = paymentRequestContent.x402 as {
            pay_to: string;
            network: string;
            asset?: string;
            facilitator?: string;
          };
          const challengeConfig: X402Config = {
            payTo: x402Request.pay_to,
            network: x402Request.network,
            ...(x402Request.asset ? { asset: x402Request.asset } : {}),
            ...(x402Request.facilitator ? { facilitator: x402Request.facilitator } : {}),
          };
          Object.assign(x402Request, {
            nonce: x402Nonce,
            required_usdc_micro: x402AmountUsdcMicro,
            ...(hasExplicitX402 || (opts.x402FacilitatorHealth?.support().exact.v2 ?? true)
              ? {
                  payment_required: buildPaymentRequiredV2({
                    x402Config: challengeConfig,
                    requiredUsdcMicro: BigInt(x402AmountUsdcMicro),
                    resource: `/v1/job/${job.id}/messages`,
                    description: reason,
                  }),
                }
              : {}),
          });
        }
        // Always assign — `undefined` clears any stale binding from a prior
        // payment-request that included x402 but is now superseded.
        job.pendingX402Nonce = x402Nonce;
        job.pendingX402AmountUsdcMicro = x402AmountUsdcMicro;

        // MPP payment option — issue one mppx challenge per registered method.
        // Each Challenge carries its own HMAC-bound id, recipient, currency,
        // and amount, so no flat fields beside it. Multi-rail = multiple
        // entries; clients pick the one matching their wallet's method.
        //
        // Capture the issued challenge ids on the job so
        // `processIncomingPayment` can reject a credential whose challenge
        // wasn't issued for *this* job — mppx HMAC-binds challenges to
        // realm/method/amount/expiry but not to the dvmkit job-id, so
        // without this binding a credential lifted from a sibling job that
        // requested the same fields could satisfy this payment-request.
        let mppChallengeIds: string[] | undefined;
        if (opts.cashuOnly) {
          // No Tempo challenge on an unsigned job; see `cashuOnly`.
        } else if (payOpts?.mpp) {
          // Pre-issued challenges get the same session filter as the issuer
          // below: a builder handing `requestPayment` its own list
          // would otherwise advertise a reusable channel both mid-job verifiers
          // are now obliged to refuse.
          const challenges = payOpts.mpp.challenges.filter((c) => c.intent !== "session");
          if (challenges.length > 0) {
            paymentRequestContent.tempo = { challenges };
            mppChallengeIds = challenges.map((c) => c.id);
          }
        } else if (opts.paymentMethods?.includes("tempo") && opts.mpp) {
          // Degrades to the last rate this process saw when the provider is down,
          // and raises a typed `fx_rate_unavailable` (code/display/hint) when it
          // has none — a mid-job charge priced at `0` would give the work away
          const rate = paymentRate ?? (await resolveServerBtcUsdRate(opts.fxFetcher)).rate;
          const challenges: MppxChallenge[] = [];
          for (const m of opts.mpp.methods) {
            // Method.AnyServer collapses to `any`; narrow to the structural
            // shape guaranteed at runtime so the lookup stays well-typed.
            const meta = m as { name: string; intent: string };
            // Reusable channels fund credits and nothing else. mppx
            // charges a session channel *before* the handler runs and disclaims
            // charge-only-on-success, which is exactly the pre-handler semantics
            // the `/v1/credit`-only confinement exists to avoid — and a mid-job
            // ask is per-job work, not a credit top-up instrument. The upfront
            // issuer partitions the same way (`issueUpfrontChallenges`), and both
            // mid-job verifiers now refuse a session credential outright — but
            // the emitted id would otherwise land in `pendingMppChallengeIds`,
            // so the job would be advertising an instrument it must then reject.
            if (meta.intent === "session") continue;
            const amount =
              pendingFiat?.currency === "usd"
                ? fiatMicroToMethodAmount(pendingFiat.amountMicro, meta.name)
                : msatsToMethodAmount(amountMsats, meta.name, rate);
            const ch = await opts.mpp.issueChallenge(meta.name, meta.intent, {
              amount,
              description: reason,
            });
            challenges.push(ch);
          }
          // A handle whose only method is session-intent leaves nothing to ask
          // for — omit the block rather than advertise an empty challenge list.
          if (challenges.length > 0) {
            paymentRequestContent.tempo = { challenges };
            mppChallengeIds = challenges.map((c) => c.id);
          }
        }
        // Always assign — `undefined` clears any stale binding from a prior
        // payment-request that included MPP but is now superseded.
        job.pendingMppChallengeIds = mppChallengeIds;
        restrictToCreditRail(
          paymentRequestContent,
          opts.creditRail ? await opts.creditRail().catch(() => undefined) : undefined,
          job
        );
      }

      // Only recovered history can satisfy replay. A payment arriving after a
      // replayed wait suspends is consumed by its live resolver, never again
      // by the next requestPayment call.
      // Replay: if this payment was already received, resolve immediately
      // (positional match). The `payment-request` is NOT re-emitted here —
      // it's already in history and the replay resolves from the cached
      // `payment` message. This keeps the `replayProviderSkip` invariant
      // simple: replay never re-emits a payment-request, so the skip budget
      // (seeded in `runReactivation`) counts only the provider messages the
      // replay *does* re-emit.
      if (job.replayHighSeq !== null) {
        const payments = job.messages.filter((m) => m.type === "payment" && m.from === "requester" && m.seq <= job.replayHighSeq!);
        if (job.replayPaymentIndex < payments.length) {
          const payment = payments[job.replayPaymentIndex];
          job.replayPaymentIndex++;
          // The caller must have credited the job before replay. A payment that bought a
          // piece did, and so did one the handler already resumed past: the job's history
          // holds provider output after it. Otherwise Tx C sets this one-way runtime marker
          // after it clears the current ask. Do not use `job.status`: a cached prompt earlier
          // in the same replay can set it back to `processing` even when this payment was
          // left pending. Do not compare `paidMsats` to this ask: an explicit
          // draw makes `paidMsats` a draw-derived rail slice while the ask is
          // live-rate msats.
          const balance = (payment.content as PaymentContent).credit;
          const accepted = balance
            ? await opts.acceptedBalancePayment?.(payment.seq, pendingFiat?.amountMicro, pendingFiat?.currency)
            : job.pieces?.some((piece) => piece.paidSeq === payment.seq) === true ||
              job.messages.some((m) => m.from === "provider" && m.seq > payment.seq) ||
              job.reactivationPaymentApplied === true;
          if (!accepted) throw new Error("[internal_error] payment replay reached without credit");
          job.pendingPaymentMsats = undefined;
          job.pendingPaymentFiatMicro = undefined;
          job.pendingPaymentFiatCurrency = undefined;
          job.pendingMppChallengeIds = undefined;
          job.pendingX402Nonce = undefined;
          job.pendingX402AmountUsdcMicro = undefined;
          job.status = job.pendingPrompts.size > 0 ? "awaiting-input" : "processing";
          opts.onCallerResume?.();
          return payment.content as PaymentContent;
        }
        // A persisted unpaid ask may have concurrently replaying siblings.
        if (!originalAsk) {
          job.replayHighSeq = null;
          job.replayProviderSkip = 0;
        }
      }

      // the cumulative total that caps this job's draw growth. The
      // store accumulates it durably in Tx A, inside the `providerMessage`
      // below; this keeps the in-memory job — which is what the mid-job
      // preflight reads — in step on the machine that asked.
      //
      // It sits HERE, under the replay bail, and not beside the
      // `pendingPayment*` assignments above: those are idempotent writes that
      // survive being re-walked, a running sum is not. A replay re-walks every
      // ask the handler already made without re-emitting them, so accumulating
      // above would double the in-memory total on every reactivation while the
      // durable column stayed put — and the phantom headroom would let the next
      // ask's duplicate grow the draw, which is the bug the cap exists to stop.
      if (!originalAsk) {
        const askedTotal = accumulateAskedTopUp(
          {
            micro: job.askedTopUpMicro,
            currency: job.askedTopUpCurrency,
            reason: job.topUpCapUnenforcedReason,
          },
          { micro: pendingFiat?.amountMicro, currency: pendingFiat?.currency }
        );
        job.askedTopUpMicro = askedTotal.micro;
        job.askedTopUpCurrency = askedTotal.currency;
        // the ceiling just went away, and this is the only moment that
        // knows why. The reason rides Tx A onto the job row so the affected jobs
        // are a query rather than a log grep; the span is what an alarm counts.
        // If that counter stays at zero the remaining door is theoretical.
        if (askedTotal.reason && !job.topUpCapUnenforcedReason) {
          job.topUpCapUnenforcedReason = askedTotal.reason;
          loggers.isolate.warn("dvm.topup_cap_unenforceable", {
            job_id: job.id,
            reason: askedTotal.reason,
            ask_currency: askCurrency,
            ask_msats: amountMsats,
          });
        }

      }
      // An unanswered replay keeps the original message and payment bindings.
      job.status = "awaiting-input";
      if (!originalAsk) {
        // Sending the ask finishes the piece in progress; its Tx A does the same durably.
        if (job.pieces) job.pieces = finishRunningPiece(job.pieces, finishedChargeMicro);
        job.finishingChargeMicro = finishedChargeMicro;
        providerMessage(job, "payment-request", paymentRequestContent);
      }

      // Register the resolver synchronously, and subscribe to NOTIFY so a cross-machine Tx C wakes
      // this resolver. When the inbound lands on a different process,
      // `job.pendingPayment` never resolves locally — the notify-driven
      // counter re-read is the only signal the handler gets. First firing
      // wins (in-process dispatch and notify-driven wake both call the
      // shared `doResolve`).
      //
      // The job's rail-msat total at the instant it suspended, which the cross-machine resume
      // gate measures this ask's payment against.
      const paidMsatsAtYield = job.paidMsats;
      const p = new Promise<PaymentContent>((resolve, reject) => {
        let resolved = false;
        let unsubscribeNotify: (() => void) | undefined;
        const cleanup = (): void => {
          unsubscribeNotify?.();
          unsubscribeNotify = undefined;
        };
        const doResolve = async (pc: PaymentContent): Promise<void> => {
          if (resolved) return;
          if (job.pendingPayment?.resolve === doResolve) {
            job.status = job.pendingPrompts.size > 0 ? "awaiting-input" : "processing";
            const persist = opts.onPaymentResume ?? opts.onYield;
            if (job.status === "awaiting-input" && persist) await persist();
            // Cancellation may reject this wait while its snapshot is retried.
            if (resolved) return;
            job.pendingPayment = null;
          }
          // A live settlement moves execution beyond recovered history, even
          // when NOTIFY supplied counters without a local payment message.
          job.replayHighSeq = null;
          job.replayProviderSkip = 0;
          opts.onCallerResume?.();
          resolved = true;
          cleanup();
          resolve(pc);
        };
        const doReject = (err: Error): void => {
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(err);
        };
        job.pendingPayment = { resolve: doResolve, reject: doReject };

        if (opts.subscribeNotifications && opts.getCounters) {
          const subscribeNotifications = opts.subscribeNotifications;
          const getCounters = opts.getCounters;
          const check = async (): Promise<void> => {
            if (resolved) return;
            try {
              const counters = await getCounters();
              if (!counters || resolved) return;
              // Did the caller pay THIS ask? Every ask is new money, so only what was
              // credited since the yield counts, never the upfront payment. The rail-msat
              // delta is exact on every accept path: cashu earmarks the money it just
              // received, x402 and Tempo credit the ask exactly and dev mode credits the
              // ask. A balance authorization pays the pinned fiat ask, so its stored rail
              // conversion need not reach this ask's current msat value.
              const satisfied = counters.balancePaymentSatisfied === true ||
                counters.paidMsats - paidMsatsAtYield >= amountMsats;
              if (satisfied) {
                // Single-execution claim: win the
                // `awaiting-input → processing` CAS before resuming, so a
                // reactivation replay on the paying machine stands down instead
                // of double-executing.
                const resume = async (): Promise<void> => {
                  // Keep credit visibility and the pending resolver in the same
                  // local resume operation as the durable claim.
                  job.paidMsats = counters.paidMsats;
                  job.pendingPaymentMsats = counters.pendingPaymentMsats;
                  // The piece this payment bought, so the next ask finishes it.
                  if (counters.pieces) job.pieces = counters.pieces;
                  await doResolve({ amount_msats: amountMsats } as PaymentContent);
                };
                if (opts.claimForProcessing) {
                  const won = await opts.claimForProcessing(resume);
                  if (resolved) return;
                  if (!won) {
                    // A reactivation replay already claimed the job and is
                    // driving it to completion. Stand down silently: do NOT
                    // resolve (would run a duplicate execution) nor reject
                    // (would emit a terminal that clobbers the winner's
                    // snapshot). Park the suspended handler and tear down local
                    // scaffold. Rare — only when the replay wins the grace race.
                    resolved = true;
                    cleanup();
                    opts.onSuperseded?.();
                    return;
                  }
                }
                await resume();
              }
            } catch (err) {
              log.error("requestPayment NOTIFY check failed", { error: String(err) });
            }
          };
          void subscribeNotifications(() => {
            void check();
          })
            .then((u) => {
              if (resolved) {
                u();
                return;
              }
              unsubscribeNotify = u;
              // Run an immediate check in case Tx C committed between the
              // ask and the subscribe call.
              void check();
            })
            .catch((err: unknown) => {
              log.error("requestPayment NOTIFY subscribe failed", { error: String(err) });
            });
        }
      });
      if (opts.onYield) {
        void opts.onYield().catch((err: unknown) => {
          log.error("Failed to persist job at yield", { error: String(err) });
        });
      }
      return p;
    },

    working: (estimateSeconds, hint) => {
      if (terminated("working")) return;
      const content: Record<string, unknown> = {};
      if (estimateSeconds !== undefined) content.estimate_seconds = estimateSeconds;
      if (hint) content.hint = hint;
      providerMessage(job, "working", content);
      job.status = "working";
    },
    progress: (percentComplete, phase, hint) => {
      // Non-yield heartbeat: SSE stays open and `job.status` is left alone
      // (the job is still actively processing). Clamp the percent to [0, 100]
      // so a buggy DVM can't ship out-of-range values to agents.
      if (terminated("progress")) return;
      const pct = Math.max(0, Math.min(100, percentComplete));
      const content: Record<string, unknown> = { percent_complete: pct };
      if (phase) content.current_phase = phase;
      if (hint) content.hint = hint;
      providerMessage(job, "progress", content);
    },
    complete: (summary, completeOpts) => {
      if (terminated("complete")) return;
      // Completing finishes the piece in progress, at a lower charge when one is given.
      const running = runningPiece(job.pieces);
      checkFinishedCharge(running, completeOpts?.finishedChargeMicro);
      if (job.pendingPayment || job.pendingPaymentMsats !== undefined) withdrawAsk();
      // Finish the piece this handler was working on, and only it: a payment that bought
      // another piece paid an ask this completion withdrew. A job accepted before piece
      // accounting is one piece, finished whole.
      job.pieceEnding = job.pieces === undefined
        ? { kind: "finish" }
        : running
          ? { kind: "finish", paidSeq: running.paidSeq, chargeMicro: completeOpts?.finishedChargeMicro }
          : { kind: "release" };
      job.status = "completed";
      job.summary = summary;
      providerMessage(job, "complete", { summary });
      runTerminal();
    },
    // `failOpts.refund` is a caller-fault annotation and nothing more
    // No rail hands value backwards: a failed job's debit is the
    // credit draw the terminal funnel releases, and the caller reclaims that
    // balance through the `drain` op. The Cashu branch that used to
    // send proofs back here was dead — `job.receivedProofs` has been empty on
    // every path since the accumulator became the commit boundary for inbound
    // proofs — and the accumulator-debit rewrite that would
    // have revived it, was cancelled as superseded by the ledger.
    fail: (error) => {
      if (terminated("fail")) return;
      job.status = "failed";
      providerMessage(job, "cancel", { reason: error });
      runTerminal();
    },

    cost: declareCost,

    step: steps.step,

    state: job.state as Record<string, unknown>,
    store: instrumentedStore,
    fetch: instrumentedFetch,
    signal: job.abort.signal,
    env: opts.env,
    log,
  };

  // One open ask at a time, counted from the call rather than the emission: a second call
  // while the first is still pricing its ask would otherwise overwrite it.
  const ask = ctx.requestPayment;
  ctx.requestPayment = (amount, reason, payOpts) => {
    if (!isTerminal(job.status) && (askInFlight || job.pendingPayment)) {
      return Promise.reject(new AskAlreadyOpenError(job.id));
    }
    askInFlight = true;
    return ask(amount, reason, payOpts).finally(() => {
      askInFlight = false;
    });
  };
  return ctx;
}

/**
 * Process-wide fallback fx fetcher for callers (typically unit tests) that
 * don't thread `opts.fxFetcher` through. Instantiated lazily on first fiat
 * `ctx.requestPayment` call so unit tests that never exercise the fiat path
 * pay no boot cost.
 */
let _lazyFxFetcher: FxFetcher | null = null;
function lazyFxFetcher(): FxFetcher {
  _lazyFxFetcher ??= createFxFetcher();
  return _lazyFxFetcher;
}

/**
 * Log why an emitted ask lost its fiat pin; the separate cap-loss span counts the affected
 * ceiling.
 */
function warnPinLost(
  jobId: string,
  currency: string,
  amountMsats: number,
  reason: FiatDenominationFailure,
  detail?: string
): void {
  loggers.isolate.warn("dvm.ask_pin_lost", {
    job_id: jobId,
    ask_currency: currency,
    ask_msats: amountMsats,
    cause: reason,
    ...(detail !== undefined && { detail }),
  });
}
