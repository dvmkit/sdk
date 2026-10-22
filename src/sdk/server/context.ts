import { AsyncLocalStorage } from "node:async_hooks";
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
import type { JobCost, KVStore, PaymentMethod, SDKJobContext } from "../types";
import { resolveServerBtcUsdRate } from "./btc-rate";
import type { FiatDenominationFailure, PriceFiat } from "./funding";
import { pinAskFiat, resolveFxSnapshot } from "./funding";
import { createInstrumentedFetch } from "./instrumented-fetch";
import { instrumentKVStore } from "./instrumented-kv";
import type { ServerJob } from "./job";
import { isTerminal, JobCancelledError, providerMessage } from "./job";
import type { JobCounters } from "./job-store";
import { accumulateAskedTopUp } from "./job-store";
import type { MppxServer } from "./mpp-setup";
import { fiatMicroToMethodAmount, msatsToMethodAmount } from "./mpp-units";
import type { CanonicalEnvelope } from "./signed-request";
import type { X402FacilitatorHealthLike } from "./x402-facilitator-support";

/**
 * What unit `ctx.requestPayment`'s upfront-pool auto-credit may compare a job's
 * remaining pool in.
 *
 * Three answers, deliberately distinct — the two that mean "no fiat pool" and
 * "I could not read the fiat pool" are not the same money. `rail` says
 * `job.paidMsats` is the rail's own traffic and the msat comparison is exact;
 * `draw` carries the fiat figure an explicit fund-and-draw actually spent;
 * `unpriced` says the job is draw-funded — so `paidMsats` is a slice of the
 * credit's rail value at a ratio pinned whenever the credit was funded — but
 * the pool behind it could not be read or denominated.
 *
 * `creditCurrency` on the two non-fiat arms is the credit's denomination, not a
 * pool figure. The gate can't spend it, but the mid-job ask still
 * has to be *pinned* in it — including on the `rail` arm, which is where an
 * implicit N=1 credit (the ordinary per-job payment) lands. Its absence there
 * means exactly "this job is bound to no credit", the free-then-paid shape.
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
  /** Persist a remaining prompt wait after accepted payment, without repeating verification. */
  onPaymentResume?: () => Promise<void>;
  paymentMethods?: PaymentMethod[];
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
   * The job's draw, read as a fiat pool — the unit
   * `ctx.requestPayment`'s upfront-pool auto-credit compares in when the job's
   * `paidMsats` is draw-derived rather than rail traffic. Omitted entirely by a
   * `JobManager` with no credit ledger, which is the `rail` answer.
   *
   * Never rejects, and never answers `rail` on a guess: a ledger it cannot read
   * for a job that demonstrably drew resolves `unpriced`, which the gate
   * declines to auto-credit from rather than fall back to a figure it knows is
   * denominated wrong.
   *
   * A function rather than a value because the draw grows: a mid-job top-up
   * commits on whichever machine took the payment, so the pool must
   * be re-read per ask, never captured when the context is built.
   */
  drawPool?: () => Promise<DrawPool>;
  /**
   * The DVM's declared pricing currency — and therefore the currency
   * of every credit it opens. Seeds the denomination a mid-job ask is pinned in
   * on a job that holds no credit yet, which is the currency the credit that
   * first payment opens will carry. Defaults to `"usd"`.
   */
  pricingCurrency?: string;
}

/**
 * The cost declarations captured by each active `ctx.step()` miss
 *
 * Every declaration is copied into every frame in the current async branch.
 * That makes an inner miss part of both its own record and its outer miss's
 * record; replaying an inner hit while an outer miss is active does the same.
 * Sibling steps only see the frames they inherited, so a fanned-out batch does
 * not leak one step's costs into another step's record. The owner also keeps a
 * different job started from the same async call tree from inheriting them.
 */
const stepCostScope = new AsyncLocalStorage<{ owner: object; frames: JobCost[][] }>();

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

  // Per-context running counters of what the handler has consumed via
  // successful `requestPayment` calls. Subtracted from the job's pool to find
  // its remaining balance — when the pool covers the next request, auto-credit
  // instead of yielding. Both reset per ctx, which is rebuilt on
  // every reactivation, so replay re-derives consumption from the same call
  // sequence.
  //
  // Two units, kept in lockstep. The msat counter runs against
  // `job.paidMsats`, which is exact whenever that figure is the rail's own
  // traffic. The fiat counter runs against the job's DRAW, which is what an
  // explicit fund-and-draw actually spent — see the gate below for why the
  // msat view can't answer for it.
  let creditedToHandlerMsats = 0;
  let creditedToHandlerMicro = 0;
  // Sticky: set the first time an ask resolves a fiat pool. `job.paidMsats` is
  // then a draw-derived figure for the rest of this context, so the msat
  // comparisons stop being apples-to-apples even on a later ask whose own pool
  // read failed. Governs the cross-machine resume gate below.
  let poolBasis = false;

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
  const stepCostOwner = {};

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
    const scope = stepCostScope.getStore();
    if (scope?.owner === stepCostOwner) {
      for (const frame of scope.frames) frame.push(replayable);
    }

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

  return {
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
      if (type === "payment-request" && typeof content.amount_msats === "number") job.pendingPaymentMsats = content.amount_msats;
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
      job.status = "awaiting-input";
      const original = job.replayHighSeq === null ? undefined : job.messages.find(
        (m) => m.from === "provider" && m.type === "prompt" && m.content.id === id && m.seq <= job.replayHighSeq!
      );
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
      // Same reasoning as `prompt` — a cancelled job will never be paid.
      if (terminated("requestPayment")) {
        throw new JobCancelledError(`Job already ${job.status}`);
      }
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

      // The job's pool, in the unit it was actually paid in. Read
      // per ask, never captured per context: a mid-job top-up grows the draw on
      // whichever machine took the payment, and `reactivateJob` builds the
      // context before that growth is even committed.
      const pool: DrawPool = opts.drawPool
        ? await opts.drawPool().catch((): DrawPool => ({ basis: "unpriced" }))
        : { basis: "rail" };
      const poolCurrency = pool.basis === "draw" ? pool.currency : undefined;
      poolBasis ||= pool.basis !== "rail";

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
      // 2. The currency of the credit this job is actually bound to — the fiat
      // pool's when there is one, otherwise the credit's own, which the
      // `rail` arm now carries for the implicit N=1 case.
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
      // other form needs the fx hop — took that branch out of
      // `resolvePriceFiat` when it removed numeric *prices*, but
      // `ctx.requestPayment(50_000, …)` is still a supported ask. It returns
      // `undefined` rather than throwing when the rate provider is down
      // the top-up then degrades to ledger-less, which the accept
      // path warns about.
      //
      // Denominated in `askCurrency` — the credit's, on every job shape rather
      // than only the ones whose fiat pool happened to read. That is
      // what makes the figure the gate spends the same figure `growDraw` adds
      // back and caps against: `resolveTopUpFiat` takes the pin verbatim when it
      // already speaks the credit's currency, so the ceiling and the funded
      // amount are one pinned integer and a rate move between the ask and the
      // payment is structurally incapable of clipping a payment the caller owes.
      //
      // An ask naming some other currency converts rather than being refused —
      // it is still the builder's ask, and the wire's `fiat_amount` below keeps
      // their currency verbatim. Only the ledger pin moves.
      //
      // Memoised: computed at most once per ask, and only when something below
      // actually needs it. Fails soft on a rate outage — the ask
      // still goes out, and the job's ask total records why it lost its ceiling.
      //
      // the fetch degrades onto the fetcher's last-known snapshot
      // (`resolveFxSnapshot`) rather than reading one blip at the rate provider
      // as "no rate". This leg is free on a fiat-form ask — `fxSnapshot` already
      // holds the snapshot that sized the msats — so bare msats is the only
      // shape where pinning opens a failure door at all, and losing the pin
      // there costs the receipt its whole `credit` block. When it *is* lost, say
      // which failure did it: an unnamed cause here is what made the same skip
      // at the verify-time leg undiagnosable after the fact.
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
        // `credit_topup_stale_rate`. Without this the ask half of the ladder is
        // invisible, and an operator reading correct-looking ledger rows has no
        // way to know how old the rate behind them was. Two rungs degrade: the
        // whole snapshot came from `lastKnown()`, or the source stopped carrying
        // this one currency and it was carried forward. An ask that
        // pins verbatim reads no rate at all, so neither applies to it.
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

      // Auto-credit from the upfront pool. `verifyUpfrontPayment` may
      // have credited the job above the worst-case ceiling at /v1/job time
      // (dynamic-priced DVMs that quote `upfront = base + worst-case surcharge`
      // and emit per-stage `requestPayment` calls — scrape, narrate, cast all
      // do this). Without this short-circuit the handler suspends on a
      // payment-request the agent has no reason to satisfy (it already paid
      // upfront), and the job idle-times-out at 120s.
      //
      // measured in the same unit as what the job actually drew. Under
      // an explicit fund-and-draw `job.paidMsats` is `withDrawBasis`'s pro-rata
      // slice of the credit's rail value — an msat figure derived from a *fiat*
      // draw at the credit's pinned ratio — while `amountMsats` converts at the
      // rate live right now. Those drift both ways: a fallen rate makes the pool
      // look too small and suspends the handler on work the caller already paid
      // for; a risen rate makes it look too large and gives away asks the draw
      // never covered. Under implicit N=1 no draw pool resolves, `paidMsats` is
      // the rail's own traffic, and the msat comparison stays exact.
      //
      // A job that drew but whose pool can't be read or priced auto-credits from
      // NEITHER: `paidMsats` is known to be a slice of the credit's rail value
      // at a ratio pinned whenever the credit was funded — days ago, on a credit
      // that backs N jobs — so spending against it is spending a figure we know
      // is denominated wrong. Yielding instead costs at worst an ask the caller
      // can see, log, and decline; auto-crediting on that figure gives work away
      // silently and unrecoverably. Yielding is not refusing — the
      // handler suspends on a payment-request exactly as it does for any charge
      // the pool genuinely doesn't cover.
      //
      // The same doctrine covers a pin that reads fine but in the WRONG unit
      // `askCurrency`'s top rung is the job's own denomination, so
      // it no longer derives from this pool the way it did when `pinAsk` always
      // denominated in `poolCurrency` — a job whose first ask resolved its
      // currency elsewhere (that ask's pool read flapped, or the operator has
      // since flipped `DVMConfig.currency`) can now be pinned in one currency
      // while bound to a credit in another. Comparing across that is the mixed-
      // unit gate exists to prevent, and it is silently wrong in both
      // directions, so a disagreement yields exactly as an unpriceable pool does.
      const askMicro =
        pool.basis === "draw" && askCurrency === pool.currency
          ? (await pinAsk())?.amountMicro
          : undefined;
      let covered: boolean;
      if (pool.basis === "rail") {
        covered = job.paidMsats - creditedToHandlerMsats >= amountMsats;
      } else if (pool.basis === "draw" && askMicro !== undefined) {
        covered = pool.amountMicro - creditedToHandlerMicro >= askMicro;
      } else {
        covered = false;
        log.warn("requestPayment pool unpriceable — yielding rather than guessing", {
          amountMsats,
          reason,
          poolBasis: pool.basis,
          askCurrency,
          // `draw` here means the pool read fine and either the ASK wouldn't pin
          // an fx outage on a bare-msats ask, or a sub-micro amount — or it
          // pinned in a currency this pool isn't denominated in.
          ...(pool.basis === "draw" && { poolCurrency: pool.currency }),
        });
      }
      if (covered) {
        creditedToHandlerMsats += amountMsats;
        creditedToHandlerMicro += askMicro ?? 0;
        log.info("requestPayment auto-credited from upfront pool", {
          amountMsats,
          reason,
          ...(pool.basis === "draw" && askMicro !== undefined
            ? {
                amountMicro: askMicro,
                poolCurrency: pool.currency,
                poolRemainingMicro: pool.amountMicro - creditedToHandlerMicro,
              }
            : { poolRemaining: job.paidMsats - creditedToHandlerMsats }),
        });
        if (job.replayHighSeq !== null) {
          job.status = job.pendingPrompts.size > 0 ? "awaiting-input" : "processing";
          opts.onCallerResume?.();
        }
        advanceReplayPaymentIndex(job);
        return { amount_msats: amountMsats };
      }

      const replayedPaymentRequest = job.replayHighSeq !== null &&
        job.replayPaymentIndex >= job.messages.filter((m) => m.from === "requester" && m.type === "payment").length
        ? job.messages.findLast((m) => m.from === "provider" && m.type === "payment-request" && m.seq <= job.replayHighSeq! &&
          m.seq > (job.messages.findLast((message) => message.from === "requester" && message.type === "payment")?.seq ?? -1))
        : undefined;
      const originalAsk = replayedPaymentRequest?.type === "payment-request" ? replayedPaymentRequest.content : undefined;
      if (originalAsk) amountMsats = originalAsk.amount_msats;
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
        job.pendingX402Nonce = originalAsk.x402?.nonce;
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
        };

        // x402 payment option
        let paymentRate: number | undefined;
        let x402Nonce: string | undefined;
        let x402AmountUsdcMicro: string | undefined;
        const hasExplicitX402 = Boolean(payOpts?.x402);
        // USDC can state a USD-denominated ask exactly. On any other DVM
        // currency it would require a fresh FX conversion, so x402 is withheld
        // even when the handler supplies an explicit per-ask override.
        if ((opts.pricingCurrency ?? "usd") === "usd") {
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
        if (payOpts?.mpp) {
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
      // replay *does* re-emit. Emitting-then-suppressing here
      // would consume a skip slot that the auto-credit short-circuit above
      // silently steals — the stale skip then swallowed the artifact.
      if (job.replayHighSeq !== null) {
        const payments = job.messages.filter((m) => m.type === "payment" && m.from === "requester" && m.seq <= job.replayHighSeq!);
        if (job.replayPaymentIndex < payments.length) {
          const payment = payments[job.replayPaymentIndex];
          job.replayPaymentIndex++;
          // The caller must have credited the job before replay.
          // Tx C sets this one-way runtime marker after it clears the current
          // ask. Do not use `job.status`: a cached prompt earlier in the same
          // replay can set it back to `processing` even when this payment was
          // left pending. Do not compare `paidMsats` to this ask: an explicit
          // draw makes `paidMsats` a draw-derived rail slice while the ask is
          // live-rate msats.
          const balance = (payment.content as PaymentContent).credit;
          const accepted = balance
            ? await opts.acceptedBalancePayment?.(payment.seq, pendingFiat?.amountMicro, pendingFiat?.currency)
            : job.reactivationPaymentApplied === true;
          if (!accepted) throw new Error("[internal_error] payment replay reached without credit");
          job.pendingPaymentMsats = undefined;
          job.pendingPaymentFiatMicro = undefined;
          job.pendingPaymentFiatCurrency = undefined;
          job.pendingMppChallengeIds = undefined;
          job.pendingX402Nonce = undefined;
          job.pendingX402AmountUsdcMicro = undefined;
          job.status = job.pendingPrompts.size > 0 ? "awaiting-input" : "processing";
          opts.onCallerResume?.();
          creditedToHandlerMsats += amountMsats;
          creditedToHandlerMicro += pendingFiat?.amountMicro ?? 0;
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
      if (!originalAsk) providerMessage(job, "payment-request", paymentRequestContent);

      // Register resolver synchronously. Wrap `resolve` so the upfront-pool
      // counter advances when the agent's payment satisfies this yield —
      // mirrors the auto-credit + replay branches above so subsequent calls
      // see the consumption regardless of how the prior one settled.
      //
      // also subscribe to NOTIFY so a cross-machine Tx C wakes
      // this resolver. When the inbound lands on a different process,
      // `job.pendingPayment` never resolves locally — the notify-driven
      // counter re-read is the only signal the handler gets. First firing
      // wins (in-process dispatch and notify-driven wake both call the
      // shared `doResolve`).
      //
      // The job's rail-msat total at the instant it suspended. Under
      // a fiat pool this is what the resume gate measures against: see the
      // gate itself for why the running msat counter can no longer answer.
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
          creditedToHandlerMsats += amountMsats;
          // The payment that satisfied this ask funded the credit and grew the
          // draw by the same pinned figure, so the pool the next ask
          // reads is larger by exactly what this line consumes — the two cancel
          // and `pool − consumed` is invariant across paid asks. That is what
          // lets a reactivation replay re-walk the whole sequence against the
          // grown draw and reach the same decisions.
          //
          // The cancellation is exact whenever the pin and the growth are the
          // same number, and they are on both sides of it: no pin means no
          // `growDraw` at all (the top-up degrades to ledger-less), and a pin in
          // a currency the credit doesn't speak is refused by the mid-job
          // preflight, which leaves this line over-consuming — the direction
          // that yields, never the one that gives work away.
          creditedToHandlerMicro += pendingFiat?.amountMicro ?? 0;
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
              // Did the caller satisfy THIS ask? Under a fiat pool the running
              // msat counter can't answer: it tracks asks priced at
              // live rates against a `paidMsats` seeded from a pinned draw, so
              // it reads too low in one rate direction — a fully-paid job never
              // resumes — and too high in the other, where this check fires on
              // stale headroom before any payment lands and the handler does the
              // work for free. The rail-msat delta since the yield is exact on
              // every accept path and needs no unit conversion: cashu earmarks
              // the money it just received, x402/mpp credit the ask exactly,
              // dev mode credits the ask, and a payment whose ledger leg was
              // skipped still credits its raw rail value. It is also implied by
              // the expression below whenever `creditedToHandlerMsats <=
              // paidMsats`, which is every non-pool job — so implicit N=1 keeps
              // the original comparison and its original behaviour.
              // Balance authorization pays the pinned fiat ask, so its stored
              // rail conversion need not reach this ask's current msat value.
              const satisfied = counters.balancePaymentSatisfied === true || (poolBasis
                ? counters.paidMsats - paidMsatsAtYield >= amountMsats
                : counters.paidMsats - creditedToHandlerMsats >= amountMsats);
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
              // upfront-pool check above and the subscribe call.
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
    complete: (summary) => {
      if (terminated("complete")) return;
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

    step: async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (job.stepCache.has(id)) {
        const record = job.stepCache.getRecord(id);
        for (const declared of record.costs ?? []) declareCost(declared);
        return record.value as T;
      }
      const costs: JobCost[] = [];
      const scope = stepCostScope.getStore();
      const parentFrames = scope?.owner === stepCostOwner ? scope.frames : [];
      const result = await stepCostScope.run(
        { owner: stepCostOwner, frames: [...parentFrames, costs] },
        fn
      );
      job.stepCache.set(id, result, costs);
      return result;
    },

    state: job.state as Record<string, unknown>,
    store: instrumentedStore,
    fetch: instrumentedFetch,
    signal: job.abort.signal,
    env: opts.env,
    log,
  };
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

/**
 * when the upfront-pool branch of `requestPayment` short-circuits
 * instead of yielding, consuming the satisfaction without advancing the
 * positional payment index would let a later yield re-claim a payment this
 * call already accounted for. No-op outside replay; no-op when the index has
 * already drained past every requester `payment` message.
 */
function advanceReplayPaymentIndex(job: ServerJob): void {
  if (job.replayHighSeq === null) return;
  const payments = job.messages.filter((m) => m.type === "payment" && m.from === "requester" && m.seq <= job.replayHighSeq!);
  if (job.replayPaymentIndex < payments.length) {
    job.replayPaymentIndex++;
  }
}
