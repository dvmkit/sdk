import type { Hono, MiddlewareHandler } from "hono";

import type {
  ApprovalContent,
  ArtifactContent,
  CancelContent,
  MessageType,
  MppxChallenge,
  PaymentContent,
  ProgressContent,
  ResponseContent,
} from "../lib/messages/types";
import type { SignedRequestAudience } from "../lib/signed-request-statement";
import type { X402BatchSettlementConfig, X402Config, X402FacilitatorAuth } from "../lib/x402/types";
import type { Currency } from "./pricing/index";
import type { ClientCompatibilityRequirement } from "./server/client-compatibility";
import type { MppOpts, MppxServer } from "./server/mpp-setup";
import type { CanonicalEnvelope } from "./server/signed-request";

export type { DVMAuthScheme } from "./server/secp256k1-auth";
import type { DVMAuthScheme } from "./server/secp256k1-auth";

// Re-export message content types so SDK consumers don't need to import from lib
export type {
  ApprovalContent,
  ArtifactContent,
  CancelContent,
  PaymentContent,
  ProgressContent,
  ResponseContent,
};
export type { MppOpts, MppxServer, X402BatchSettlementConfig, X402Config, X402FacilitatorAuth };

/** Structural type matching any Zod schema. Avoids a hard dependency on zod. */
export interface ZodLike<T = unknown> {

  _zod: unknown;

  parse(data: unknown): T;

  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
}

export type InputType<T> = T extends ZodLike<infer O> ? O : string;

/**
 * Zod examples use the schema output type, including transforms. Plain JSON Schema examples have
 * no equivalent static validation.
 */
export type ExampleType<InputSchema> = [InputSchema] extends [ZodLike<infer O>]
  ? O
  : Record<string, unknown>;

export function isZodSchema(value: unknown): value is ZodLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "_zod" in value &&
    "parse" in value &&
    "safeParse" in value
  );
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Persistent cross-job key-value storage scoped to the DVM. */
export interface KVStore {
  /** Retrieve a value by key. Returns undefined if not found or expired. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Store a value. Optionally set a TTL in seconds. */
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys, optionally filtered by prefix. */
  list(prefix?: string): Promise<string[]>;
}

export interface PromptOpts {
  /** Preset choices the client can select from. */
  options?: string[];
  /** JSON Schema describing the expected structured response. */
  schema?: Record<string, unknown>;
}

export interface SDKPaymentRequestOpts {

  mints?: string[];
  /** Minimum P2PK locktime in seconds. */
  minLocktimeSeconds?: number;
  /** x402 stablecoin payment details to include in the payment request. */
  x402?: { pay_to: string; network: string; asset: string; facilitator?: string };
  /**
   * MPP multi-rail payment details to include in the payment request. One
   * pre-issued mppx challenge per accepted method/intent. Overrides the
   * SDK's auto-issued challenges; if omitted, and the SDK is configured for
   * MPP, challenges are issued automatically. Each challenge's `id` becomes
   * part of this job's per-job replay binding.
   *
   * `session`-intent challenges are dropped from this list, whoever issued
   * them: reusable channels fund credits on `POST /v1/credit` and are refused
   * everywhere on the job surface.
   */
  mpp?: { challenges: MppxChallenge[] };
}

/**
 * What one job cost the builder to serve, as declared by the handler through
 * {@link SDKJobContext.cost}.
 *
 * The builder's own cost, in the currency they incurred it — a vendor API
 * call, a GPU minute, a per-request licence fee. It is never netted against
 * what the caller paid: revenue and cost are two different questions and the
 * platform keeps two different fields for them.
 */
export interface JobCost {
  /**
   * Amount in **major** currency units, like every other money figure a
   * handler passes in (`ctx.requestPayment`, `QuoteResult.upfront`): `0.0003`
   * is three hundredths of a cent.
   *
   * Declarations are summed as major units and only the job's total is
   * rounded, to a millionth of a unit. So an individual charge finer than a
   * millionth — per-token LLM pricing, say — is not floored away on its own;
   * a thousand of them add up to a figure that gets reported.
   *
   * Must be finite and non-negative, and the job's total must not exceed
   * ~9e9 units; anything else is a `RangeError`.
   */
  amount: number;
  /** ISO 4217 lowercase, e.g. `"usd"`. */
  currency: Currency;
}

export interface SDKJobContext<State = Record<string, unknown>, Input = string> {

  readonly jobId: string;

  readonly tags: string[];
  /** Job input — raw string or parsed/validated object when an input schema is defined. */
  readonly input: Input;
  readonly params: Record<string, string>;
  /** Opaque requester identifier (derived from auth token or "anonymous"). */
  readonly requesterId: string;
  /** Total msats paid so far for this job. */
  readonly paidMsats: number;
  /**
   * Verified caller identity from the descriptor's `auth` scheme.
   * Present when the DVM declares `auth: secp256k1Auth(...)`; undefined for
   * DVMs without descriptor-level auth and for unsigned paid jobs admitted by
   * `secp256k1Auth({ allowUnsignedPaid: true })`. The envelope is the same `T &
   * CanonicalEnvelope` the auth scheme produced — handlers can read
   * `ctx.auth.envelope.<field>` instead of re-parsing the input.
   */
  readonly auth?: {
    pubkey: string;
    envelope: CanonicalEnvelope & Record<string, unknown>;
  };

  text(message: string): void;

  artifact(content: ArtifactContent): void;
  /** Send a raw typed message (escape hatch). */
  sendMessage(type: MessageType, content: Record<string, unknown>): void;

  /** Ask the client a question. Resolves when the client responds. */
  prompt(id: string, text: string, opts?: PromptOpts): Promise<ResponseContent>;
  /**
   * Request payment; resolves when the ask is satisfied by the upfront pool or a payment.
   * Numbers are millisatoshis. Fiat envelopes use major units in the supplied
   * supported currency; the ledger pin is converted into the job's denomination.
   * x402 is offered only for USD; other configured rails can use supported FX currencies.
   */
  requestPayment(
    amount: number | { amount: number; currency: Currency },
    reason: string,
    opts?: SDKPaymentRequestOpts
  ): Promise<PaymentContent>;
  /** Signal that processing will take a while. Handler continues running. */
  working(estimateSeconds?: number, hint?: string): void;
  /**
   * Emit a progress heartbeat with structured `percent_complete` and optional
   * `current_phase` / `hint`. Non-blocking and non-yield: the SSE stream stays
   * open so clients render heartbeats live. Use during long-running phases to
   * keep agents informed; pair with `withProgressHeartbeat` to cover slow
   * single-call operations (Whisper transcribe, diariser polling, …).
   */
  progress(percentComplete: number, phase?: string, hint?: string): void;
  /** Complete the job with a human-readable summary. The summary is a one-liner for relaying to humans; artifacts emitted with `ctx.artifact()` carry the actual payload. */
  complete(summary: string): void;
  /**
   * Fail the job with an error message. No debit happens either way — the
   * terminal funnel releases the credit draw ({@link RAIL_REFUNDABLE}).
   * `{ refund: true }` annotates the failure as caller-fault; it
   * moves no money on any rail and never has.
   */
  fail(error: string, opts?: { refund?: boolean }): void;

  /**
   * Declare what this job cost **you**, the builder, to serve.
   *
   * The SDK reports it to the platform alongside the job's revenue, so the
   * dashboard can state a margin. Without it the margin is unknowable, and the
   * board says so rather than guessing:
   *
   * ```ts
   * const res = await ctx.fetch("https://api.vendor.example/v1/transcribe", { ... });
   * ctx.cost({ amount: 0.0004, currency: "usd" });
   * ```
   *
   * **Repeated calls add up.** Declare each cost where you incur it — once per
   * vendor call — rather than summing them yourself. Every call must name the
   * same currency; a job that mixes two reports no cost at all and logs an
   * error, because one number in two currencies is not a cost.
   *
   * **Nothing declared means nothing reported.** The cost field is absent from
   * the report, which is distinct from a declared cost of zero — "we don't
   * know" and "it was free" are different facts and the dashboard shows them
   * differently. `ctx.cost({ amount: 0, currency: "usd" })` is the way to say
   * a job genuinely cost you nothing.
   *
   * **Declare costs where they are incurred, including inside {@link step}.**
   * The step cache carries declarations with the result and applies them once
   * when a replay skips the body:
   *
   * ```ts
   * const r = await ctx.step("transcribe", async () => {
   * const result = await whisper(audio);
   * ctx.cost({ amount: result.seconds * 0.0001, currency: "usd" });
   * return result;
   * });
   * ```
   *
   * **Terminal jobs report declared cost.** A paid completion carries cost on
   * its revenue report. A free completion, failure, or cancellation uses a
   * separate cost report and does not create revenue. On multi-machine hosts,
   * cumulative declarations are revisioned so a later in-memory total replaces
   * an earlier persisted prefix regardless of delivery order.
   *
   * Throws `InvalidCurrencyError` for a currency that is not ISO 4217
   * lowercase, and `RangeError` for an amount that is not finite or is
   * negative. After the job is terminal the call is a no-op, like every other
   * context write.
   */
  cost(cost: JobCost): void;

  /**
   * Cache the result of an async operation for durable replay.
   *
   * With a store supporting per-step writes (including Postgres), the result and
   * captured costs are persisted before this promise resolves. After three failed
   * write attempts, the SDK logs `step_persist_failed` and returns the result anyway.
   * Custom stores without that support persist steps at yield and terminal snapshots;
   * in-memory stores provide no durability across process death.
   *
   * Cached replay skips the body, but execution is at-least-once: a crash during the
   * body or between its side effect and persistence, or exhausted writes, can repeat
   * the action. For irreversible actions, use an external idempotency key stable
   * across replay, or check the external system for a prior result before acting.
   * @example
   * ```ts
   * const stepId = "reserve";
   * const reservation = await ctx.step(stepId, () =>
   *   instrument.reserve({ idempotencyKey: `${ctx.jobId}:${stepId}` })
   * );
   * ```
   */
  step<T>(id: string, fn: () => Promise<T>): Promise<T>;

  /** Per-job typed state, auto-loaded and auto-persisted. */
  state: State;
  /** Persistent storage shared across jobs. */
  store: KVStore;
  /**
   * Instrumented fetch — emits `dvm.fetch` spans with redacted URLs, and
   * aborts every in-flight request when the job is cancelled (`signal` below
   * is merged into each request, alongside any per-request signal you pass).
   */
  fetch: typeof globalThis.fetch;
  /**
   * Cancellation signal for this job. Aborts when the caller
   * cancels, the job idles out, or the handler is superseded. `ctx.fetch`
   * already carries it; pass it into anything else that can be torn down —
   * a provider SDK's `signal` option, a `spawn`, your own sleeps — so a
   * cancelled job stops burning provider spend. After cancel, `ctx.complete`
   * / `ctx.fail` are no-ops: the job stays `cancelled`.
   */
  readonly signal: AbortSignal;

  env: Record<string, string>;
  log: Logger;
}

export interface QuoteContext<QuoteData = Record<string, unknown>> {
  /** Quote data, parsed by the configured Zod schema when present. */
  data: QuoteData;
  /** The client's raw input string, when supplied. */
  input?: string;

  params?: Record<string, string>;
  /**
   * Operator environment — same object threaded into `JobContext.env`.
   * Quote handlers read it for pre-payment checks (API-key presence, feature
   * flags, model overrides) so failures surface as a structured 400 rather
   * than after the upfront fee has been debited.
   */
  env: Record<string, string>;
  /**
   * Instrumented fetch — same one threaded into `JobContext.fetch`. Provided
   * for symmetry; quote handlers that need to reach upstream (e.g. to size a
   * payload via HEAD) use this so the call lands inside the dvm.quote span.
   */
  fetch: typeof globalThis.fetch;
  /**
   * Verified caller pubkey from the signed-request envelope. Present only when
   * the descriptor declares an auth scheme and the
   * envelope verified — `/v1/quote` runs `checkAuth` before the handler, so by
   * the time this is set the signature is good. Undefined on unauthenticated
   * DVMs and for unsigned paid requests on a
   * `secp256k1Auth({ allowUnsignedPaid: true })` DVM, where any anonymous
   * caller can make the handler run while pricing `POST /v1/job`; quote
   * handlers that price per-caller or call paid upstreams must handle that.
   */
  callerPubkey?: string;
  /**
   * The authenticated caller's standing prepaid credit at this DVM, if any,
   * so one round trip answers "cost + my remaining
   * credit". Undefined when the DVM doesn't offer credit, the caller is
   * unauthenticated, or they hold no live credit in this DVM's currency.
   *
   * Read-only by construction: a snapshot, never the ledger handle. Quote
   * handlers must not attempt to spend against it — draws happen on the job
   * path, under the ledger's row lock.
   */
  credit?: CreditView;
}

/**
 * Read-only snapshot of a caller's credit, surfaced on {@link QuoteContext};
 * it mirrors the ledger's `CreditSnapshot` minus the write surface
 * and the fields a quote handler has no business branching on.
 */
export interface CreditView {
  /** Which credit this describes — a caller may hold several at one DVM. */
  creditId: string;
  /** Currency the balance is denominated in; amounts are 1e-6 of it. */
  currency: string;
  /** Funded balance in 1e-6 currency units. Pending holds are NOT subtracted. */
  balanceMicro: number;
  /** Spendable balance: `balanceMicro` minus pending holds. */
  availableMicro: number;
  /** Absolute expiry, ms since epoch. */
  expiryMs: number;
  /** True once past `expiryMs` — draws refuse, the balance stays the caller's. */
  expired: boolean;
}

/**
 * Result returned by the onQuote handler — the fiat-first envelope.
 *
 * The protocol enforces exactly one hard invariant — `upfront` — and pushes
 * every other pricing detail into prose. LLM-agent intermediaries read
 * `description` and `hint` directly and may relay, paraphrase, or synthesise
 * them; typed agents can additionally inspect `shape` and `rate`.
 *
 * Sats binding happens at the 402 handshake on `/v1/job`, not here — `upfront`
 * is the indicative fiat commitment the agent commits to before submitting.
 */
export interface QuoteResult {
  /**
   * Hard invariant — the protocol-enforced fiat amount the caller commits up
   * front to engage the job. The SDK derives sats from this and a snapshot
   * fx rate at settlement time. For fixed-price DVMs this is the total cost;
   * for two-phase DVMs more may be requested via `ctx.requestPayment` as the
   * job runs — `description` and `hint` explain that.
   */
  upfront: { amount: number; currency: Currency };

  /**
   * Prose description of what the upfront commitment buys and how pricing
   * works. Concise is ideal; multi-line is fine when multi-component
   * breakdowns or two-phase pricing need explanation. LLM agents read this
   * directly — they may pass it through, paraphrase, or synthesise it into
   * their own response to the human they speak to.
   */
  description: string;

  /**
   * Optional follow-up prose. For two-phase DVMs: "You'll be charged the
   * per-minute rate × actual duration after the transcription completes."
   * For fixed-price DVMs: omit.
   */
  hint?: string;

  /**
   * Optional predefined pricing shape for common patterns. Typed agents may
   * read; LLM agents rely on `description`/`hint` instead.
   */
  shape?: "fixed" | "rate";

  /**
   * Optional rate descriptor when `shape === "rate"`. Lets typed agents
   * compute their own ceiling from a known unit count. Multi-component
   * breakdowns live in `description` prose for v1.
   */
  rate?: {
    per_unit: { amount: number; currency: Currency };
    /**
     * Unit name. Untyped string so DVMs can define units flexibly.
     * Recommended vocabulary (use these when applicable so common cases stay
     * legible to typed agents): "minute", "second", "char", "token", "byte",
     * "mb", "gb", "request".
     */
    unit: string;
    /**
     * Optional hard cap. Lets a typed agent compute the worst-case ceiling
     * as `per_unit.amount × max_units` without parsing prose. Falsy/omitted
     * = no ceiling. Operators surface this when an enforced cap exists
     * (e.g. scribe's `MAX_INPUT_MINUTES`).
     */
    max_units?: number;
  };
}

export interface QuoteConfig<QuoteData = Record<string, unknown>> {

  schema: ZodLike<QuoteData> | Record<string, unknown>;

  handler(ctx: QuoteContext<QuoteData>): Promise<QuoteResult>;
}

export interface IncomingMessage {
  /** Message type (e.g. "response", "payment", "approval", "cancel"). */
  type: MessageType;
  content: Record<string, unknown>;
}

/**
 * A builder-declared price — a USD literal, always (`"$0.05"`).
 *
 * Fiat is the only static price form. The credit ledger is
 * fiat-micro denominated, so a raw-msats price could only reach the ledger
 * through a BTC/USD lookup that may be unavailable — which is how a
 * numeric-priced DVM under a cold-start rate outage used to take money and
 * record no draw. Rails are unaffected: callers still pay sats,
 * the SDK converts at request time.
 */
export type PriceValue = string;

export type PaymentMethod = "cashu" | "x402" | "tempo";

/**
 * One line of a capability's published rate card, declared on `CapabilityConfig.rates`.
 * Example: `{ label: "balanced", amount: "0.00015", currency: "USD", per: "character" }`.
 *
 * `amount` is decimal dollars written as a string (`/^\d+(\.\d+)?$/`, above
 * zero, at most 12 characters). `per` names the unit and `label` optionally
 * names a tier; each is 1 to 24 characters with no leading or trailing
 * whitespace. `/v1/info` publishes the entries exactly as written, in order.
 */
export interface CapabilityRate {
  label?: string;
  amount: string;
  currency: "USD";
  per: string;
}

/**
 * Rails that may fund a prepaid **credit**.
 *
 * A deliberate superset of {@link PaymentMethod}, not a widening of it.
 * `lightning` funds a credit through the interactive invoice leg on
 * `POST /v1/credit` — the DVM issues a bolt11 over a receive-only NWC
 * connection and credits when settlement is observed — but it is **not** an
 * attached-proof wire method: there is no header a caller can hang a bolt11
 * on, nothing to verify inline, and no `lightning` entry in `/v1/info` or
 * `/v1/quote`'s `payment.methods`. Keeping the two types distinct is what
 * stops that dead rail from reappearing every time the funding menu grows.
 */
export type FundingMethod = PaymentMethod | "lightning";

/**
 * Whether the payment rail returns value when a job fails. No rail reverses
 * `ctx.fail`: Cashu proofs are committed to the accumulator; Tempo and x402
 * credentials settle without an SDK reversal.
 *
 * Failed credit jobs release their draw hold back to the caller's balance.
 * Reclaiming that balance uses `drain`; this flag describes rail reversal,
 * independently of the credit ledger. `{ refund: true }` records caller fault
 * and does not move funds.
 */
export const RAIL_REFUNDABLE: Record<PaymentMethod, boolean> = {
  cashu: false,
  x402: false,
  tempo: false,
};

/**
 * Cashu receive mode for builder DVMs.
 *
 * `"p2pk-accumulator"` — accept P2PK-locked proofs from agent wallets and persist
 * them in `wallet_accumulator`. Melting runs builder-local via `dvmctl melt-pending`
 * the SDK only monitors batches for `t_expire` proximity.
 */
export type CashuMode = "p2pk-accumulator";

/**
 * Prepaid-credit sizing this DVM advertises.
 *
 * Declaring the block is the opt-in: a DVM without `credit` never offers the
 * funding menu on `/v1/quote` or the 402, and `/v1/credit` refuses with
 * `credit_not_supported`. Every payment still funds and draws the ledger
 * internally (the implicit N=1 case) — this block is only about
 * whether callers may hold a balance across jobs.
 *
 * Isolate-runtime DVMs never advertise credit regardless of this config
 * (the isolate-runtime rule): they have no Postgres of their own, so the money-safety
 * conditions the ledger relies on can't hold there.
 */
export interface CreditConfig {
  /**
   * Smallest funding this DVM accepts, as a `PriceValue` ("$0.10").
   * A dust floor — below it the rail fees dominate. Default `"$0.10"`.
   *
   * Declared in USD even on a DVM whose {@link DVMConfig.currency} is not
   * `"usd"`: `PriceValue` has one grammar, and the funding menu converts both
   * bounds into the DVM's currency on a single fx snapshot.
   */
  min?: PriceValue;
  /**
   * Largest **residual balance** a caller may hold, as a `PriceValue`.
   * Binds the balance, not the funding amount (the balance-sizing contract): a job priced above
   * `max` still clears as fund-and-immediately-draw. Bounds the DVM's
   * prepaid-deposit liability. Default `"$5.00"`.
   */
  max?: PriceValue;
  /**
   * Credit lifetime in **seconds**, from the most recent funding. Post-TTL
   * the credit refuses new draws; the balance stays the caller's (the caller-ownership contract).
   * Default 90 days. Existing expiries change only on funding, which never shortens them.
   */
  ttl?: number;
  /**
   * Permit one-payment stablecoin instruments to fund prepaid credit:
   * Tempo `charge` and x402 `exact`. Default `false`.
   *
   * Reusable Tempo sessions and x402 batch-settlement channels return unused
   * collateral through their channel lifecycle. A one-payment top-up does
   * not: accepting one makes every unused balance a manual refund obligation
   * for the builder, surfaced through the stablecoin drains-owed queue.
   */
  allowOneShotStablecoin?: boolean;
}

/**
 * A {@link CreditConfig} with every optional field filled from the platform
 * defaults — what `configureDVM` puts on the descriptor so no downstream
 * consumer re-derives a default. `min`/`max` stay in their declared USD form:
 * the funding menu quotes in the DVM's pricing currency
 * ({@link DVMConfig.currency}), and converting there (rather than here) keeps
 * one fx snapshot behind both bounds.
 */
export interface ResolvedCreditConfig {
  min: PriceValue;
  max: PriceValue;
  ttlSeconds: number;
  /** Whether Tempo `charge` and x402 `exact` may fund prepaid credit. */
  allowOneShotStablecoin: boolean;
}

/**
 * Refund-locktime floors for Cashu payments. A payer may lock proofs with a
 * NUT-11 `locktime`; the DVM refuses one that passes before the proofs can be
 * melted. Shortening a floor below its default is safe only when the builder
 * melts more often than the floor: once a proof's locktime passes, an
 * unmelted proof can be spent by the payer's refund key or, when the proof
 * names no refund key, by anyone holding it.
 */
export interface CashuConfig {
  /**
   * Shortest refund `locktime`, in seconds from now, a signed caller must
   * use. Advertised as `cashu.min_locktime` on `/v1/info`; the DVM enforces it
   * less 24 hours so a caller resuming an unacknowledged payment still
   * clears it. Default 604800 (7 days). A whole number of at least 90000
   * (25 hours), so the enforced floor is always at least an hour away.
   */
  minLocktimeSeconds?: number;
  /**
   * Shortest refund `locktime`, in seconds from receipt, for an unsigned
   * `POST /v1/job` payment sent without `X-Cashu-Request-Id` (a NUT-24
   * wallet) to a DVM without auth or one built with
   * `secp256k1Auth({ allowUnsignedPaid: true })`. Such a wallet cannot be
   * told this floor and locks to its own default, so it is enforced exactly,
   * with no resume margin, and advertised as `cashu.unsigned_min_locktime`.
   * A payment carrying `X-Cashu-Request-Id` takes the signed floor. Default
   * `minLocktimeSeconds` less 24 hours (518400 when that is unset). A whole
   * number of at least 3600, and no more than `minLocktimeSeconds` less 24
   * hours: an unsigned payer can send `X-Cashu-Request-Id` to take the signed
   * floor instead, so a longer unsigned floor would protect nothing.
   */
  unsignedMinLocktimeSeconds?: number;
}

/** A {@link CashuConfig} with both floors filled from their defaults. */
export interface ResolvedCashuConfig {
  minLocktimeSeconds: number;
  unsignedMinLocktimeSeconds: number;
}

/** Platform default for {@link CreditConfig.min} — a dust floor below which rail fees dominate. */
export const DEFAULT_CREDIT_MIN: PriceValue = "$0.10";

/**
 * Platform default for {@link CreditConfig.max} — the largest residual balance
 * a caller may hold. Pocket-money sizing (the exposure limit: prepaid exposure is
 * capped by policy at pocket-money size), set above the caller-side tier-1
 * cap of $2 so an established caller can actually reach the builder ceiling.
 */
export const DEFAULT_CREDIT_MAX: PriceValue = "$5.00";

/** Platform default for {@link CreditConfig.ttl}: 90 days. */
export const DEFAULT_CREDIT_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Default lifetime of caller-controlled job content before it is redacted. */
export const DEFAULT_JOB_RETENTION_DAYS = 730;

/**
 * Per-capability configuration for the multi-capability shape.
 * Each capability is an independent unit a caller pays for: its own input
 * schema, pricing, handler, and (optional) message handlers. DVM-level
 * concerns (auth, payment rails, tags, builder) stay on the parent
 * `DVMConfig` and are inherited.
 */
export interface CapabilityConfig<
  State = Record<string, unknown>,
  InputSchema extends ZodLike | undefined = undefined,
> {
  /** Human-readable description surfaced on `/v1/info`. */
  description?: string;
  /** Zod schema for structured job input. When set, ctx.input is parsed and typed. */
  input?: InputSchema;
  /**
   * Example input payload surfaced on `/v1/info`. Lets the CLI render
   * a runnable `dvm quote --data '<payload>'` line when the JSON Schema alone
   * is ambiguous — e.g. cross-field Zod refinements that don't survive
   * serialization (narrate's `text` XOR `dialogue`). Must satisfy the schema
   * including any `.refine()` checks.
   *
   * Typed via `ExampleType<InputSchema>`: narrows to the schema's
   * output type when `input` is a Zod schema, falls back to
   * `Record<string, unknown>` otherwise.
   */
  example?: ExampleType<InputSchema>;
  /** Per-job state shape and defaults — cloned for each new job under this capability. */
  state?: State;
  /** Static price — a USD literal ("$0.05"). Free capabilities omit this and `onQuote`. */
  price?: PriceValue;
  onQuote?: QuoteConfig;
  /**
   * Rate card published on `/v1/info` as `pricing.rates`: 1 to 5
   * {@link CapabilityRate} entries, exactly as declared. Allowed only on a
   * priced capability (`price` or `onQuote`); a free capability that declares
   * rates is refused when the server starts, as is any entry outside the
   * limits on {@link CapabilityRate} or carrying another key. For a quoted
   * capability the rates describe how the quote is computed; they never
   * change the quote itself.
   */
  rates?: CapabilityRate[];
  /** Handle a newly submitted job for this capability (required). */
  onJob: (ctx: SDKJobContext<State, InputType<InputSchema>>) => void | Promise<void>;
  /** Handle a client response to a prompt within a job of this capability. */
  onResponse?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ResponseContent
  ) => void | Promise<void>;
  /** Handle a client payment within a job of this capability. */
  onPayment?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: PaymentContent
  ) => void | Promise<void>;
  /** Handle a client approval within a job of this capability. */
  onApproval?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ApprovalContent
  ) => void | Promise<void>;
  /** Handle a client cancellation within a job of this capability. */
  onCancel?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: CancelContent
  ) => void | Promise<void>;
  /** Catch-all for messages without a type-specific handler. */
  onMessage?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    msg: IncomingMessage
  ) => void | Promise<void>;
}

/**
 * Desugared per-capability descriptor. `configureDVM` produces one
 * of these per capability — the SDK runtime always operates on this shape.
 */
export interface CapabilityDescriptor<
  State = unknown,
  InputSchema extends ZodLike | undefined = undefined,
> {
  /** Capability name (the key in `capabilities[…]`). */
  readonly name: string;
  /** Human-readable description; empty string when not provided. */
  readonly description: string;
  /** Zod schema for structured job input. */
  readonly input?: InputSchema;
  /** Example input payload surfaced on `/v1/info`. See `CapabilityConfig.example`. */
  readonly example?: ExampleType<InputSchema>;
  /** Default per-job state for jobs of this capability. */
  readonly state: State;
  /** Static price — a USD literal ("$0.05"). Undefined for dynamic-priced or free. */
  readonly price?: PriceValue;
  readonly onQuote?: QuoteConfig;
  /** Rate card published on `/v1/info`. See `CapabilityConfig.rates`. */
  readonly rates?: CapabilityRate[];
  readonly onJob: (ctx: SDKJobContext<State, InputType<InputSchema>>) => void | Promise<void>;
  /** Handle a client response to a prompt. */
  readonly onResponse?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ResponseContent
  ) => void | Promise<void>;
  /** Handle a client payment. */
  readonly onPayment?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: PaymentContent
  ) => void | Promise<void>;
  /** Handle a client approval. */
  readonly onApproval?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ApprovalContent
  ) => void | Promise<void>;
  /** Handle a client cancellation. */
  readonly onCancel?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: CancelContent
  ) => void | Promise<void>;
  /** Catch-all message handler. */
  readonly onMessage?: (
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    msg: IncomingMessage
  ) => void | Promise<void>;
}

/**
 * Configuration object passed to configureDVM().
 *
 * Two equivalent shapes:
 *
 * - **Flat single-capability shape** — declare `capability: "<name>"` plus
 * the per-capability fields (`input`, `state`, `price`/`onQuote`, `onJob`,
 * `onResponse`, …) at the top level. Desugars internally to a one-entry
 * `capabilities` map. Ergonomic for the common case (narrate, scribe,
 * scrape).
 *
 * - **Explicit multi-capability shape** — declare `capabilities: { "<name>":
 * { input, onJob, … } }`. Used by services that expose several operations
 * on a shared resource model (cast's add-episode / update-feed /
 * delete-episode / delete-feed).
 *
 * The two are mutually exclusive: providing both throws at `configureDVM`.
 * DVM-level concerns (tags, payment rails, idle timeout, lifecycle,
 * descriptor routes) live on `DVMConfig` regardless of shape.
 */
export interface DVMConfig<
  State = Record<string, unknown>,
  InputSchema extends ZodLike | undefined = undefined,
> {
  name: string;
  description?: string;
  /**
   * Single-capability name for the flat shape. Mutually exclusive
   * with `capabilities`. Single-capability DVMs declare it here and put the
   * per-capability fields (`input`, `state`, `price`/`onQuote`, `onJob`,
   * `onResponse`, …) at the top level; `configureDVM` desugars to a
   * one-entry `capabilities` map internally.
   */
  capability?: string;
  /**
   * Explicit multi-capability block. Mutually exclusive with the
   * flat shape's `capability` + top-level handler fields. Each key is a
   * capability name (tag-shape: lowercase letters/digits/hyphens, no
   * slashes); each value carries its own `input`, `state`, `price`/`onQuote`,
   * `onJob`, and optional message handlers.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capabilities?: Record<string, CapabilityConfig<any, any>>;
  /** Single tag (convenience). */
  tag?: string;
  /** Multiple tags (explicit). */
  tags?: string[];
  /**
   * The currency this DVM prices in — and therefore the one its credit ledger
   * is denominated in. ISO 4217 lowercase; default `"usd"`.
   *
   * The single authoritative answer to "what denomination does this DVM deal
   * in", read by the funding menu, `POST /v1/credit`, and the quote balance
   * echo alike. Before it existed, `/v1/credit` had no quote to read a currency
   * off and assumed USD, so a EUR-pricing DVM funded top-ups in a denomination
   * none of its jobs would ever draw from.
   *
   * Two consequences, both enforced rather than documented:
   *
   * - **`onQuote` must return it.** A quote denominated in anything else is a
   * builder config error, refused as `quote_currency_mismatch` — never
   * coerced, never converted.
   * - **Static `price` literals are USD-only** (`"$0.05"` — that is the whole
   * grammar), so declaring a non-USD currency alongside one is a
   * `configureDVM` error. Price a non-USD DVM dynamically with `onQuote`.
   *
   * The rails are unaffected: callers still pay sats, and the SDK converts at
   * request time through whichever rate the fx fetcher carries for this
   * currency.
   */
  currency?: Currency;
  /** Static price — a USD literal ("$0.05"). Flat shape only. */
  price?: PriceValue;
  /** Zod schema for structured job input. Flat shape only. */
  input?: InputSchema;
  /** Example input payload surfaced on `/v1/info`. Flat shape only — see `CapabilityConfig.example`. */
  example?: ExampleType<InputSchema>;
  /** Per-job state shape and defaults. Flat shape only. */
  state?: State;
  /** Caller answer/payment window from emission, in whole seconds (1–604800). Default: 3600. Processing time is excluded. */
  idleTimeout?: number;
  /**
   * Seconds a job may sit in `processing`/`working` with no SDK liveness
   * heartbeat before the stale-job watchdog declares its worker dead and marks
   * it `failed`. The SDK heartbeats locally-active jobs every ~30s,
   * so this bounds *crashed/OOM-killed-worker* detection — not legitimate
   * handler runtime, which the heartbeat keeps fresh regardless of how long it
   * runs. Distinct from `idleTimeout`, which governs the `awaiting-input`
   * pay/prompt wait. Default: 300 (5 min). Widen only for a DVM that blocks the
   * event loop synchronously for longer than the heartbeat interval.
   */
  processingWatchdog?: number;
  /**
   * Days terminal job content remains available before the SDK redacts it.
   * The durable row, payment linkage, and signed receipt remain for accounting
   * and request-id safety. Default: 730. Set to `0` to disable automatic
   * redaction.
   */
  jobRetentionDays?: number;
  /**
   * Descriptor-level auth scheme. Fires on `/v1/job` and
   * `/v1/quote` before payment verification and handler dispatch — unsigned
   * or malformed envelopes reject with HTTP 401, no payment is attempted.
   *
   * When set, the active capability's `input` schema is reused for
   * verification; one scheme covers every capability under the DVM.
   * Advertised on `/v1/info#auth` as `[scheme.id]`, or `[scheme.id, "none"]`
   * when the scheme also admits unsigned paid jobs.
   */
  auth?: DVMAuthScheme;

  /** Run once when the server starts, before accepting jobs. Use for validation or initialization. */
  onBoot?(env: Record<string, string>): void | Promise<void>;

  /** Run once when the server shuts down. Use for cleanup. */
  onShutdown?(): void | Promise<void>;

  /**
   * Handle a newly submitted job. Required for the flat single-capability
   * shape; for the explicit `capabilities` block, declare `onJob` per
   * capability instead.
   */
  onJob?(ctx: SDKJobContext<State, InputType<InputSchema>>): void | Promise<void>;
  /** Handle a client response to a prompt. Flat shape only. */
  onResponse?(
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ResponseContent
  ): void | Promise<void>;
  /** Handle a client payment. Flat shape only. */
  onPayment?(
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: PaymentContent
  ): void | Promise<void>;
  /** Handle a client approval. Flat shape only. */
  onApproval?(
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: ApprovalContent
  ): void | Promise<void>;
  /** Handle a client cancellation. Flat shape only. */
  onCancel?(
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    content: CancelContent
  ): void | Promise<void>;
  /** Catch-all for messages without a type-specific handler. Flat shape only. */
  onMessage?(
    ctx: SDKJobContext<State, InputType<InputSchema>>,
    msg: IncomingMessage
  ): void | Promise<void>;
  /** Quote handler for dynamic pricing. Flat shape only. */
  onQuote?: QuoteConfig;
  /** Rate card published on `/v1/info`. Flat shape only — see `CapabilityConfig.rates`. */
  rates?: CapabilityRate[];
  /** Payment methods this DVM accepts. Default: derived from configured rails — adds "cashu" when `mints` is set, "x402" when `x402` is set, "tempo" when `tempo` is set. */
  paymentMethods?: PaymentMethod[];
  /** x402 stablecoin payment configuration (provider-side). */
  x402?: X402Config;
  /** MPP multi-rail payment handle (provider-side, built via `createMppFromOpts`). */
  mpp?: MppxServer;
  /**
   * Prepaid-credit sizing. Declaring the block opts this DVM into
   * the funding menu on `/v1/quote` / the 402 and into `POST /v1/credit`;
   * omitting it leaves callers on per-call payment. See {@link CreditConfig}.
   */
  credit?: CreditConfig;
  /** Cashu refund-locktime floors. See {@link CashuConfig}. */
  cashu?: CashuConfig;
  /**
   * Register DVM-scoped non-protocol routes on the descriptor's Hono sub-app
   * Invoked once per `host.mount(dvm)` against the sub-app that
   * receives `/v1/info`, `/v1/job`, etc. — any prefix passed to `host.mount`
   * applies automatically, so a route registered as `/feeds/:owner/:slug` on
   * a DVM mounted under `/cast` becomes `/cast/feeds/:owner/:slug` externally.
   *
   * Use this for routes that belong to a single DVM (feed XML, cleanup
   * endpoints, asset hosting). Cross-DVM routes live on `host.app` instead.
   *
   * Typed as `Hono<any, any, any>` because the host wires SDK-internal Env
   * `Variables` (`requesterId`, etc.) onto the sub-app — builders shouldn't
   * have to know about that, and the SDK shouldn't leak it publicly.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes?(app: Hono<any, any, any>, context: DVMRouteContext): void | Promise<void>;
}

/** Deployment identity shared with DVM-scoped custom routes. */
export interface DVMRouteContext {
  /** Audience custom signed-request routes must bind caller proofs to. */
  readonly authAudience?: SignedRequestAudience;
  /** Pre-handler compatibility gate for one custom endpoint. */
  readonly requireClientCompatibility: (
    requirement: ClientCompatibilityRequirement
  ) => MiddlewareHandler;
}

/** Immutable descriptor returned by configureDVM(). */
export interface DVMDescriptor<
  State = Record<string, unknown>,
  InputSchema extends ZodLike | undefined = undefined,
> {
  readonly name: string;
  /** Human-readable description (empty string if not provided). */
  readonly description: string;
  readonly tags: string[];
  /**
   * Resolved pricing currency — `config.currency` after validation,
   * or `"usd"` when the builder declared none. Always present, so no consumer
   * re-derives the default, and always the exact code the ledger compares
   * against (`"EUR"` is a `configureDVM` error, not a case to normalise: the
   * ledger's currency column is compared verbatim, so admitting both spellings
   * would make one credit two unreachable denominations). See
   * {@link DVMConfig.currency}.
   */
  readonly currency: Currency;
  /**
   * Raw price as declared by the builder for single-capability DVMs.
   * Mirrors `capabilities[only].price` after desugar; undefined for
   * multi-capability DVMs (read the per-capability price instead).
   */
  readonly price: PriceValue | undefined;
  /**
   * Zod schema for structured job input for single-capability DVMs.
   * Mirrors `capabilities[only].input` after desugar; undefined for
   * multi-capability DVMs (look up by capability name).
   */
  readonly inputSchema: InputSchema;
  /**
   * Default per-job state for single-capability DVMs. Mirrors
   * `capabilities[only].state` after desugar; `{}` for multi-capability
   * DVMs — the SDK runtime always seeds state from the per-capability map.
   */
  readonly state: State;
  /** Seconds before an idle job is auto-cancelled. */
  readonly idleTimeout: number;
  /** Seconds before a worker-stranded `processing`/`working` job is marked `failed`. Undefined → SDK default (5 min). */
  readonly processingWatchdog?: number;
  /** Days terminal job content is retained; `0` disables automatic redaction. */
  readonly jobRetentionDays: number;
  /** Reference to the original DVMConfig (handler functions, quote config, etc.). */
  readonly config: DVMConfig<State, InputSchema>;
  /**
   * Desugared per-capability descriptors. The SDK runtime always
   * operates on this map: single-capability DVMs have one entry keyed by
   * `config.capability`; multi-capability DVMs have N entries with the
   * names declared in `config.capabilities`.
   *
   * Typed as `<any, any>` so consumers can pass a typed test context to
   * `descriptor.capabilities[name].onJob(ctx)` without re-casting — the
   * runtime erases the per-capability generics, and forcing callers through
   * a narrowed `unknown` adds nothing.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly capabilities: Record<string, CapabilityDescriptor<any, any>>;
  /** Payment methods this DVM accepts. */
  readonly paymentMethods?: PaymentMethod[];
  /** x402 stablecoin payment configuration. */
  readonly x402?: X402Config;
  /** MPP multi-rail payment handle. */
  readonly mpp?: MppxServer;
  /**
   * Prepaid-credit sizing, with every optional field resolved to
   * its platform default. Present iff `configureDVM` was called with a
   * `credit` block — the presence check IS the opt-in gate.
   */
  readonly credit?: ResolvedCreditConfig;
  /** Cashu refund-locktime floors, present iff `configureDVM` was given a `cashu` block. */
  readonly cashu?: ResolvedCashuConfig;
  /**
   * Descriptor-level auth scheme. Set when `configureDVM` was
   * called with `auth: secp256k1Auth(...)` — the SDK fires this on
   * `/v1/job` and `/v1/quote` before payment verification.
   */
  readonly auth?: DVMAuthScheme;
}
