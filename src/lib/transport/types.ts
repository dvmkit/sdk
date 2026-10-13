import type { Message, MessageType, MppxChallenge, MppxCredential } from "../messages/types";
import type { FundingReceipt, JobReceipt as SignedJobReceipt } from "../receipt";
import type { ReceiptTrustAnchor } from "../receipt-verify";
import type { SignedRequestAudience } from "../signed-request-statement";
import type { PaymentRequired, X402Version } from "../x402/spec";

/** Why a receipt value offered by a provider could not cross the structural guard. */
export type ReceiptParseError = "shape_invalid";

/** The highest protocol version this client supports. */
export const SUPPORTED_PROTOCOL_VERSION = 1;

export interface ProviderRef {
  endpoint: string;
}

export interface JobEnvelope {
  /**
   * Capability name on the target DVM. Set by callers that already
   * know the canonical slash form (`cast/add-episode`) — when omitted,
   * transports leave it off the wire and the SDK rejects the request with
   * `capability_required`. The CLI auto-fills this for the bare
   * `-d <dvm>` form against single-capability DVMs.
   */
  capability?: string;
  input: string;
  params?: [string, string][];
  /** Structured data for dynamic pricing (conforms to provider's quote schema) */
  data?: Record<string, unknown>;
  outputType?: string;
  /** Max bid in millisatoshis */
  bidMsats?: number;
}

export interface Payment {
  /** Cashu token (for X-Cashu header) */
  cashuToken?: string;
  /** Base64-encoded x402 `PaymentPayload` (for `X-PAYMENT` header). */
  x402Payment?: string;
  /** Selects the v2 or legacy HTTP payment header name. */
  x402Version?: X402Version;
  /** Structured MPP credential (`{ challenge, payload, source? }`). */
  mppCredential?: MppxCredential;
  /** Verbatim serialized MPP Authorization value, for durable credential replay. */
  mppCredentialRaw?: string;
  /** UUIDv4 per-call identifier for the agent-wallet path. */
  cashuRequestId?: string;
}

/**
 * upfront is the binding fiat commitment. priceMsats is advisory; the 402
 * handshake supplies the actual settlement amount.
 */
export interface Quote {
  /**
   * Protocol-enforced fiat upfront commitment.
   *
   * `amount_micro` is the provider's own integer price in 1e-6 units
   * of `currency` — `/v1/quote`'s `upfront.amount_micro`, or `price_micro` off
   * a 402 — and is the figure a fund-and-draw's `fund.amount_micro` must be
   * derived from. Reconstructing it from `amount` is lossy against any provider
   * that renders a rounded decimal, so prefer this and treat its absence (a
   * provider that predates the field) as the reason to fall back, not as
   * licence to round. `amount` keeps its meaning either way.
   */
  upfront: { amount: number; currency: string; amount_micro?: number };
  /** Prose description of what the upfront buys and how pricing works. */
  description: string;
  /** Optional follow-up prose (e.g. two-phase pricing explanation). */
  hint?: string;
  /** Optional pricing shape — `"fixed"` for fully-known prices, `"rate"` for metered. */
  shape?: "fixed" | "rate";
  /** Optional rate descriptor when `shape === "rate"`. */
  rate?: {
    per_unit: { amount: number; currency: string };
    unit: string;
    max_units?: number;
  };
  /**
   * Client-derived advisory sats estimate (`upfront.amount × current fx`).
   * Not binding — actual settlement msats lands via the 402 handshake.
   * Always populated by the transport so the CLI's pay flow can budget;
   * 0 when fx is unavailable.
   */
  priceMsats: number;
  /** Exact USDC micro-unit amount from the selected x402 requirement. */
  requiredUsdcMicro?: string;
  /** Versioned x402 challenge used to construct the payment payload. */
  x402PaymentRequired?: PaymentRequired;
  /** Cashu mints accepted by the provider. */
  mints?: string[];
  /** Quote expiration (unix seconds). */
  expiresAt?: number;
  /**
   * Rail refundability is separate from failed-job cost: failure releases the
   * pending credit draw, while the credit menu states whether its value can be
   * reclaimed. Legacy providers omit refundable.
   */
  payment?: { methods: string[]; refundable: Record<string, boolean> };
  /**
   * The provider's prepaid-credit funding menu, when it offers one.
   * `max_micro` bounds the **residual balance**, not a funding amount. The
   * `credit_id` / `balance_micro` / `remaining_micro` / `expiry_ms` echo is
   * present only when the quote was signed by a caller who already holds a
   * credit here — so one round trip answers cost + remaining balance.
   * Undefined for providers that don't offer credit (including every
   * isolate-runtime DVM, per the isolate-runtime rule).
   */
  credit?: CreditMenu;
}

/** Public prepaid-credit terms advertised on `/v1/info`. Snake_case: wire shape. */
export interface CreditTerms {
  /** Smallest funding accepted, in 1e-6 units of `currency`. */
  min_micro: number;
  /** Largest residual balance a caller may hold, in 1e-6 units of `currency`. */
  max_micro: number;
  /** Credit lifetime from the most recent funding, in ms. */
  ttl_ms: number;
  /** Currency the block — and the resulting credit — is denominated in. */
  currency: string;
  /** Rails a top-up may be funded over. */
  funding: string[];
  /**
   * MPP instruments this credit accepts; reusable sessions are preferred when
   * present.
   *
   * `withheld` names an instrument the DVM is configured for and is not
   * offering at this instant, with a reason. It is advisory and
   * never payable on its own — attempt only what `methods` lists — with one
   * exception the caller relies on: a credit already bound to a Tempo channel
   * may still be topped up over `tempo/session` while it is withheld, because
   * the pause covers *new* channels and a bound credit can be funded no other
   * way.
   */
  tempo?: {
    methods: { method: string; intent: "charge" | "session" }[];
    withheld?: { method: string; intent: "charge" | "session"; reason: string }[];
  };
  /**
   * Which x402 flavours a top-up may arrive on, and the chain each rides
   * `exact` whenever the rail is on at all — a per-call
   * authorization funds a credit on `POST /v1/credit` just as it settles a
   * job; `batch-settlement` only where a reusable channel is actually wired.
   * A caller that would open a channel must find that scheme here first,
   * because a DVM offering only `exact` answers a channel open with no
   * requirement it can sign against.
   */
  x402?: { schemes: { scheme: string; network: string }[] };
  /**
   * Smallest funding the `lightning` rail accepts, in 1e-6 units of
   * `currency` — the deployment's receive floor, fiat-rendered
   * with a safety margin so funding exactly this figure always clears.
   * Absent from pre-floor servers and when `lightning` isn't offered; rails
   * without an entry have no floor beyond `min_micro`.
   */
  lightning_min_micro?: number;
}

/** Prepaid-credit funding menu on a quote or 402. Snake_case: wire shape. */
export interface CreditMenu extends CreditTerms {
  /** The caller's credit this echo describes. */
  credit_id?: string;
  /** Funded balance, pending holds NOT subtracted. */
  balance_micro?: number;
  /** Spendable balance — what a draw is checked against. */
  remaining_micro?: number;
  /** Absolute expiry of the echoed credit, ms since epoch. */
  expiry_ms?: number;
}

/**
 * Validate and whitelist public prepaid-credit terms received from a DVM.
 *
 * The caller deliberately treats partial terms as absent: every provider that
 * offers credit sends the sizing fields, and sizing against a missing value
 * would create made-up bounds. Returning a new object is the privacy boundary:
 * caller echo fields and unknown future keys cannot survive into a public
 * registry projection.
 */
export function parseCreditTerms(raw: unknown): CreditTerms | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const credit = raw as Record<string, unknown>;
  if (
    typeof credit.min_micro !== "number" ||
    typeof credit.max_micro !== "number" ||
    typeof credit.ttl_ms !== "number" ||
    typeof credit.currency !== "string" ||
    !Array.isArray(credit.funding) ||
    !credit.funding.every((method) => typeof method === "string") ||
    (credit.lightning_min_micro !== undefined && typeof credit.lightning_min_micro !== "number")
  )
    return undefined;

  const tempo = credit.tempo === undefined ? undefined : parseCreditTempoTerms(credit.tempo);
  if (credit.tempo !== undefined && !tempo) return undefined;
  const x402 = credit.x402 === undefined ? undefined : parseCreditX402Terms(credit.x402);
  if (credit.x402 !== undefined && !x402) return undefined;

  return {
    min_micro: credit.min_micro,
    max_micro: credit.max_micro,
    ttl_ms: credit.ttl_ms,
    currency: credit.currency,
    funding: [...credit.funding] as string[],
    ...(tempo && { tempo }),
    ...(x402 && { x402 }),
    ...(typeof credit.lightning_min_micro === "number" && {
      lightning_min_micro: credit.lightning_min_micro,
    }),
  };
}

/** Validate a quote/402 credit menu, preserving only well-typed caller echo fields. */
export function parseCreditMenu(raw: unknown): CreditMenu | undefined {
  const terms = parseCreditTerms(raw);
  if (!terms) return undefined;
  const credit = raw as Record<string, unknown>;
  return {
    ...terms,
    ...(typeof credit.credit_id === "string" && { credit_id: credit.credit_id }),
    ...(typeof credit.balance_micro === "number" && { balance_micro: credit.balance_micro }),
    ...(typeof credit.remaining_micro === "number" && {
      remaining_micro: credit.remaining_micro,
    }),
    ...(typeof credit.expiry_ms === "number" && { expiry_ms: credit.expiry_ms }),
  };
}

function parseCreditTempoTerms(raw: unknown): CreditTerms["tempo"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const block = raw as { methods?: unknown; withheld?: unknown };
  if (!Array.isArray(block.methods) || !block.methods.every(isCreditTempoMethod)) return undefined;
  if (
    block.withheld !== undefined &&
    (!Array.isArray(block.withheld) || !block.withheld.every(isCreditTempoWithheldMethod))
  )
    return undefined;
  return {
    methods: block.methods.map((method) => ({
      method: (method as { method: string }).method,
      intent: (method as { intent: "charge" | "session" }).intent,
    })),
    ...(Array.isArray(block.withheld) && {
      withheld: block.withheld.map((method) => ({
        method: (method as { method: string }).method,
        intent: (method as { intent: "charge" | "session" }).intent,
        reason: (method as { reason: string }).reason,
      })),
    }),
  };
}

function isCreditTempoMethod(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    typeof (raw as { method?: unknown }).method === "string" &&
    ((raw as { intent?: unknown }).intent === "charge" ||
      (raw as { intent?: unknown }).intent === "session")
  );
}

function isCreditTempoWithheldMethod(raw: unknown): boolean {
  return isCreditTempoMethod(raw) && typeof (raw as { reason?: unknown }).reason === "string";
}

function parseCreditX402Terms(raw: unknown): CreditTerms["x402"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const schemes = (raw as { schemes?: unknown }).schemes;
  if (
    !Array.isArray(schemes) ||
    !schemes.every(
      (entry) =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as { scheme?: unknown }).scheme === "string" &&
        typeof (entry as { network?: unknown }).network === "string"
    )
  )
    return undefined;
  return {
    schemes: schemes.map((entry) => ({
      scheme: (entry as { scheme: string }).scheme,
      network: (entry as { network: string }).network,
    })),
  };
}

/**
 * The invoice a DVM issues for a `fund.method: "lightning"` top-up.
 * Snake_case: wire shape. Arrives on a `lightning_settlement_pending` 402, not
 * on a success body — Lightning is a funding option, never an attach rail, so
 * there is no header for the caller to hang a proof on.
 */
export interface LightningFundingOffer {
  invoice: string;
  /** Payment hash, for reconciling against the wallet's own record. */
  payment_hash: string;
  /** What the invoice is for — the figure the local budget cap is checked against. */
  amount_msats: number;
  /** Absolute bolt11 expiry, ms since epoch. */
  expires_at_ms: number;
}

/**
 * Wire projection of one credit as `POST /v1/credit` serves it.
 * Snake_case: wire shape. `remaining_micro` is spendable (holds subtracted) —
 * the figure a caller acts on; `balance_micro` is funded.
 */
export interface CreditWire {
  /** Ledger lifecycle. `unbacked` is terminal and exposes no spendable value. */
  status?: "active" | "unbacked";
  /** Credit identifier — caller-chosen, or `imp:`/`fnd:`-derived server-side. */
  credit_id: string;
  /** Currency the balance is denominated in. */
  currency: string;
  /** Funded balance, pending holds NOT subtracted, in 1e-6 units. */
  balance_micro: number;
  /** Spendable balance, in 1e-6 units. */
  remaining_micro: number;
  /** Absolute expiry, ms since epoch. */
  expiry_ms: number;
  /** True once expiry has passed — the credit refuses draws but keeps its balance. */
  expired: boolean;
  /** True when a drain could reclaim a positive balance. */
  drainable: boolean;
  /** True when the server could not complete the chain read needed to confirm backing. */
  reconciliation_pending?: boolean;
  /** Per-credit monotonic sequence of the last ledger event. */
  ledger_seq: number;
}

/** Wire projection of a reclaim (`POST /v1/credit` op `drain`). */
export interface DrainWire {
  /** This drain's identifier — doubles as the poll/pickup key. */
  drain_id: string;
  /** Credit the drain was taken against. */
  credit_id: string;
  /** Payout rail: `cashu` | `x402` | `tempo`. */
  method: string;
  /** Lifecycle state: `pending` | `parked` | `picked_up` | `sent` | `released`. */
  status: string;
  /** Amount reclaimed, in 1e-6 units of `currency`. */
  amount_micro: number;
  /** Currency the drain is denominated in. */
  currency: string;
  /**
   * The in-kind obligation where the rail has one: a Bitcoin reclaim
   * returns the deposited sats pro rata at the rate each funding landed at, so
   * this figure was fixed when the reclaim was requested and does not move with
   * the market. Absent on rails that carry no such promise.
   */
  owed_sats?: number;
  /** Ledger sequence the drain consumed. */
  ledger_seq: number;
  /** Epoch ms the drain was recorded. */
  created_at: number;
  /** Cashu token P2PK-locked to the caller's refund key, once parked. */
  token?: string;
  /** Structured settlement evidence for a non-cashu payout, once sent. */
  sent?: Record<string, unknown>;
  /** Opaque receipt observations; consumers must shape-check and authenticate them. */
  receipts: unknown[];
}

/**
 * POST /v1/credit operation response.
 */
export interface CreditOpResult {
  op: "fund" | "balance" | "drain";
  /** Micro-units actually credited by a `fund` (pro-rata of the artifact's value). */
  funded_micro?: number;
  /** True when a `fund` replayed an already-recorded `(credit_id, fund_id)`. */
  replayed?: boolean;
  /** Builder-attested proof of the funding-time balance tuple. */
  fundingReceipt?: FundingReceipt;
  /** Present when an offered funding receipt failed the structural guard. */
  fundingReceiptParseError?: ReceiptParseError;
  /**
   * True when a Lightning `fund` settled onto a credit the caller never named —
   * the provider's operator repaired a blocked invoice. The balance
   * is on `credit.credit_id`, not the `credit_id` that was polled.
   */
  reconciled?: boolean;
  credit?: CreditWire;
  /** Every credit this caller holds here (`balance` op; includes expired). */
  credits?: CreditWire[];
  /**
   * The DVM's funding menu, echoed on the `balance` op — the same
   * block `/v1/quote` and every 402 advertise, so one read states both what the
   * caller holds and what they may add. Additive on the wire: absence means
   * "this server said nothing", never "this DVM has no menu", so a caller
   * treats it as no update and keeps whatever snapshot it already holds.
   */
  menu?: CreditMenu;
  drain?: DrainWire;
  /** Relay-safe one-liner from the DVM (drain op). */
  display?: string;
  /** What-to-do-next prose from the DVM (drain op). */
  hint?: string;
  /**
   * Verbatim batch-settlement acknowledgement header. Transport metadata,
   * never part of the DVM's JSON body; the caller advances cumulative state
   * only after processing it.
   */
  x402PaymentResponse?: string;
  /** Tempo settlement transaction from the validated `Payment-Receipt` header. */
  transactionHash?: string;
}

/**
 * Receipt returned after job submission.
 *
 * Not to be confused with {@link SignedJobReceipt} (`src/lib/receipt.ts`) — the
 * DVM-signed proof-of-purchase, which rides on this envelope's {@link receipt}
 * field. This type is the transport's view of the whole `POST /v1/job`
 * response; that one is a single block inside it.
 */
export interface JobReceipt {
  jobId: string;
  status:
    | "completed"
    | "processing"
    | "payment-required"
    | "failed"
    | "cancelled"
    | "awaiting-input";
  /** Tempo settlement transaction from the validated `Payment-Receipt` header. */
  transactionHash?: string;
  /** Human-readable summary of the completed job (one-liner; not the payload). Present when the job completed inline. */
  summary?: string;
  /** True when the provider emitted artifact messages — agents should fetch `dvm messages <job-id>` to retrieve the payload. */
  hasArtifacts?: boolean;
  /** Count of artifact messages (present when `hasArtifacts` is true). */
  artifactCount?: number;
  /** Tells agents where the payload lives: `"summary"` when the summary string is the full payload; `"messages"` when artifacts hold the actual output. */
  payloadIn?: "summary" | "messages";
  quotes?: Quote[];
  /** Estimated seconds until completion (for async jobs) */
  estimatedSeconds?: number;
  /**
   * Third-party/legacy X-Cashu-Change token. Current SDK overpayment funds
   * the caller's credit; transports retain this token for compatible recovery.
   */
  cashuChange?: string;
  /**
   * Opaque per-job token issued at create-time when the DVM resolved
   * the caller as anonymous. Required on subsequent reads/writes for this job
   * the CLI persists it on the local job record and sets it as
   * `X-Job-Token` on every follow-up request. A caller that lost its local record
   * can use the standalone CLI's `--endpoint` plus `--job-token` overrides, or
   * `DVM_JOB_ENDPOINT` plus `DVM_JOB_TOKEN`, for status/messages/message/cancel;
   * `pay` still requires the local pending request and spending policy. Absent
   * for authenticated callers (bearer / signed-request), who get gated on
   * `requesterId` instead.
   */
  jobToken?: string;
  /**
   * Router-issued claim binding this receipt's job ID to the platform DVM that
   * proxied it. The CLI persists it for `dvm feedback --job`; providers cannot
   * forge a usable value because the platform verifies its HMAC.
   */
  feedbackClaim?: string;
  /**
   * signed receipt, present when the job reached a terminal status on
   * this response and the DVM issues receipts. Absent means either "not a
   * terminal response" or "this DVM doesn't do receipts" — `/v1/info`'s
   * `receipts` flag ({@link ProviderInfo.receipts}) is what tells them apart.
   */
  receipt?: SignedJobReceipt;
  /** Present when the response offered a `receipt` value that failed the structural guard. */
  receiptParseError?: ReceiptParseError;
  /** Funding evidence on an explicit fund-and-draw submission. */
  fundingReceipt?: FundingReceipt;
  fundingReceiptParseError?: ReceiptParseError;
  fundedMicro?: number;
  credit?: CreditWire;
}

export interface SubmitOptions {
  /** Wait for result in ms. 0 = fire-and-forget. Default 30000. */
  timeoutMs?: number;
}

export interface StatusOptions {
  /** How long to subscribe/poll in ms. Default 5000. */
  timeoutMs?: number;
  /** opaque per-job token issued at create-time; sent as `X-Job-Token`. */
  jobToken?: string;
}

export interface MessagePollOptions {
  /** How long to poll/subscribe in ms. */
  timeoutMs?: number;
  /** opaque per-job token issued at create-time; sent as `X-Job-Token`. */
  jobToken?: string;
}

/** Outbound message from the client — server assigns seq/timestamp/from. */
export interface OutboundMessage {
  type: MessageType;
  content: Record<string, unknown>;
}

export interface JobStatus {
  jobId: string;
  status: "processing" | "completed" | "failed" | "awaiting-input" | "cancelled";
  /** Human-readable summary of the completed job (one-liner; not the payload). Present when status is `completed`. */
  summary?: string;
  /** True when the provider emitted artifact messages — agents should fetch `dvm messages <job-id>` to retrieve the payload. */
  hasArtifacts?: boolean;
  /** Count of artifact messages (present when `hasArtifacts` is true). */
  artifactCount?: number;
  /** Tells agents where the payload lives: `"summary"` when the summary string is the full payload; `"messages"` when artifacts hold the actual output. */
  payloadIn?: "summary" | "messages";
  message?: string;
  /**
   * Third-party/legacy X-Cashu-Change token. Current SDK overpayment funds
   * the caller's credit; transports retain this token for compatible recovery.
   */
  cashuChange?: string;
  /**
   * signed receipt, present once the job is terminal. This is the
   * recovery capture point: a receipt the submit path never saw (an async job,
   * or an SSE drop) is picked up here on the next read.
   */
  receipt?: SignedJobReceipt;
  /** Present when the response offered a `receipt` value that failed the structural guard. */
  receiptParseError?: ReceiptParseError;
  /** Funding evidence retained on a fund-and-draw job replay/read. */
  fundingReceipt?: FundingReceipt;
  fundingReceiptParseError?: ReceiptParseError;
  fundedMicro?: number;
  credit?: CreditWire;
}

/**
 * Per-capability advertisement on `/v1/info.capabilities`. One entry
 * per capability name (tag-shape: lowercase, hyphens, no slashes). This is the
 * wire shape both tiers emit and the caller reads — the container's
 * `renderCapabilities` (`src/sdk/server/app.ts`), the isolate's re-emit, and
 * the platform storage descriptor (whose `CapabilityMeta` aliases this) all
 * build it.
 */
export interface V1InfoCapability {
  description?: string;
  /** JSON Schema for the capability's job input (`toJSONSchema(..., {io:"input"})`). */
  input_schema?: Record<string, unknown>;
  /**
   * Builder-supplied example input payload. The CLI prefers this
   * over schema-derived placeholders so cross-field refinements (e.g. narrate's
   * text-XOR-dialogue) get a runnable `--data` value.
   */
  example?: Record<string, unknown>;
  /**
   * Pricing surface — `quote.schema` for dynamic-priced capabilities, `max`
   * for static-priced ones, plus `rates` on either when the builder declared a
   * rate card. A free capability omits the block entirely (it cannot declare
   * rates): a
   * static `price` is a USD literal run through `parseUsdPrice`, which rejects
   * anything below `$0.0001`, so `max: { amount: 0 }` is unreachable.
   */
  pricing?: {
    max?: { amount: number; currency: string };
    quote?: { schema: Record<string, unknown> };
    /**
     * Builder-declared rate card, published exactly as declared (order and
     * strings untouched). Present on static-priced and quoted capabilities
     * alike; for a quoted capability it describes how the quote is computed.
     */
    rates?: Array<{ label?: string; amount: string; currency: "USD"; per: string }>;
  };
}

/**
 * Authoritative `/v1/info` response wire type — the single source of truth both
 * emit handlers construct against so a field add/rename is a compile error
 * across tiers. Snake_case matches the emitted JSON exactly; fields
 * are optional where they're emitted conditionally.
 *
 * The container tier (`handleInfo` in `src/sdk/server/app.ts`) and the isolate
 * tier's `/v1/info` route each emit a subset — this type is the superset. The
 * caller parses it into the narrowed camelCase {@link ProviderInfo} view in
 * `HttpsTransport.describe`.
 */
export interface V1InfoResponse {
  name: string;
  /** Provider description (omitted when empty). */
  description?: string;
  tags: string[];
  /** Auth schemes supported (e.g. `["none"]`, `["secp256k1-schnorr-v2"]`). */
  auth: string[];
  /** Audience bound into v2 signed caller statements. */
  auth_audience?: SignedRequestAudience;
  /** Protocol version the provider speaks (currently `1`). */
  protocol_version: number;
  /** Git SHA the deployed image was built from; `"unknown"` when absent. */
  sdk_sha: string;
  /** Candidate-unique rollout marker injected by the platform; absent on legacy images and platform-re-emitted isolate metadata. */
  deploy_id?: string;
  /** Owner display identity. Omitted on pre-unification DVMs. */
  owner?: {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    type: string;
  };
  /** Builder identity attestation. Omitted when unsigned. */
  builder?: {
    pubkey: string;
    attestation: Record<string, unknown>;
    signature: string;
  };
  /**
   * True when this DVM signs a receipt for every terminal job.
   * Omitted — never `false` — when no receipt key is wired, so absence is the
   * "not supported here" signal (pre-receipt deploys, the isolate tier).
   */
  receipts?: boolean;
  /** True when signed request-id lookup is supported. */
  request_recovery?: boolean;
  /** Provider prepaid-credit menu, without a caller-specific balance echo. */
  credit?: CreditTerms;
  /** Accepted Cashu mints. */
  mints?: string[];
  /** Per-capability advertisement. */
  capabilities?: Record<string, V1InfoCapability>;
  /**
   * Accepted payment methods, nested envelope. Emitted unconditionally
   * by both handlers but typed optional so the imperative builders can assign it
   * after the base literal without a missing-required error.
   */
  payment?: { methods: string[] };
  /** Fiat ceiling — isolate tier only; container runtimes configure it per capability. */
  pricing?: { max: { amount: number; currency: string } };
  /** Top-level input schema — isolate single-capability mirror only. */
  input_schema?: Record<string, unknown>;
  /** Top-level quote schema — isolate single-capability mirror only. */
  quote?: { schema: Record<string, unknown> };
  /** x402 stablecoin config. Container tier only. */
  x402?: {
    pay_to: string;
    network: string;
    asset: string;
    facilitator?: string;
    dual_serve: boolean;
  };
  /** MPP multi-rail discovery hint. Container tier only. */
  tempo?: {
    methods: { method: string; intent: string }[];
    /** Omitted when the server has no configured MPP realm. */
    realm?: string;
    /** One-shot and session recipient resolved by the running server. */
    recipient?: string;
    /** TIP-20 token accepted by one-shot charges and session deposits. */
    payment_token?: string;
    /** Session settlement account; omitted when sessions are not configured. */
    operator?: string;
    /** Token the session operator uses for settlement fees. */
    fee_token?: string;
  };
  /** Cashu P2PK acceptance hint. Container tier only. */
  cashu?: {
    mints: string[];
    lock_pubkeys: string[];
    lock_pubkey_grace_seconds: number;
    min_locktime: number;
    canonical_id: string | null;
  };
}

/**
 * Provider capabilities and metadata from `/v1/info`, as the **caller** consumes
 * it. Intentionally a distinct, narrowed **camelCase** view over the emitted
 * {@link V1InfoResponse} wire — `HttpsTransport.describe` (`https.ts`) maps the
 * snake_case wire into these names and drops fields the caller doesn't need
 * (`dual_serve`, `lock_pubkey_grace_seconds`). `about` deliberately stays `about`
 * (not `description`): this shape is spread verbatim into `dvm describe`'s JSON
 * output, so its field names are their own published contract — do not collapse
 * it into the wire type.
 */
export interface ProviderInfo {
  name?: string;
  /** Provider description (wire `description`; kept as `about` for the `dvm describe` output contract) */
  about?: string;
  tags?: string[];
  /** Auth schemes supported (e.g. ["none"], ["secp256k1-schnorr-v2"]) */
  auth?: string[];
  /** Audience advertised for v2 signed caller statements. */
  authAudience?: SignedRequestAudience;
  /**
   * Pricing info advertised on `/v1/info`.
   *
   * `max` is the fiat ceiling — `{ amount, currency }`. `max_msats` is the
   * legacy sats-only form emitted by old container images and some
   * self-hosted servers; agents can fall back to it when `max` is absent.
   */
  pricing?: { max?: { amount: number; currency: string }; max_msats?: number };
  mints?: string[];
  /** Quote configuration with JSON Schema for structured inputs (onQuote.schema). */
  quote?: { schema: Record<string, unknown> };
  /**
   * JSON Schema describing the DVM's job input shape (top-level `input_schema`
   * on `/v1/info`). Present when the descriptor declares `inputSchema`. Used
   * by the CLI to detect structured-input DVMs on the error path.
   */
  inputSchema?: Record<string, unknown>;
  /** Protocol version supported by the provider */
  protocolVersion?: number;
  paymentMethods?: string[];
  /** Provider prepaid-credit capability advertised on `/v1/info`. */
  credit?: CreditTerms;
  x402?: { pay_to: string; network: string; asset: string; facilitator?: string };
  /**
   * MPP multi-rail discovery hint. Lists the `method/intent` pairs the DVM
   * accepts; concrete recipients/amounts land per-job in `payment-request`
   * challenges. `realm` is the server identity bound into challenge HMACs.
   */
  tempo?: {
    methods: { method: string; intent: string }[];
    /** Omitted when the server has no configured MPP realm. */
    realm?: string;
    recipient?: string;
    payment_token?: string;
    operator?: string;
    fee_token?: string;
  };
  /** Cashu P2PK acceptance hint emitted by DVMs running + SDK. */
  cashu?: {
    mints: string[];
    lock_pubkeys: string[];
    min_locktime: number;
    canonical_id: string | null;
  };
  /** Git SHA the deployed image was built from. `"unknown"` when baked-in SHA is absent. */
  sdkSha?: string;
  /**
   * True when this DVM signs a receipt for every terminal job.
   * Omitted — never `false` — so absence is the "not supported here" signal.
   * The caller uses it to tell a missing receipt apart from a DVM that never
   * issues one, and to decide whether a follow-up read is worth a round-trip.
   */
  receipts?: boolean;
  /** True when the provider supports authenticated public request recovery. */
  requestRecovery?: boolean;
  /**
   * Builder identity attestation, served verbatim off `/v1/info`.
   * The trust anchor a signed receipt chains to: its `receipt_pubkey` is the
   * key the DVM's builder vouched for. Absent on dev-mode and unsigned DVMs,
   * which is what makes a receipt `verified_unattested` rather than `verified`.
   *
   * The **only** place a caller may read this DVM's identity from, and only
   * through `attestedDvmIdentity` / `providerDvmIdentity`. There was
   * once a `dvmId` beside this block, lifted out of `attestation.dvm_id` after
   * a shape check; the attestation is self-signed, so that field let any
   * endpoint claim another's identity and resolve its credit record.
   */
  builder?: ReceiptTrustAnchor;
  /**
   * Per-capability advertisement. Keys are capability names (tag-
   * shape — lowercase, hyphens, no slashes); values carry the optional
   * `description`, `input_schema`, and `pricing` block. The CLI uses the
   * keys to validate `-d <dvm>/<capability>` identifiers and to auto-fill
   * the capability for single-capability DVMs.
   */
  capabilities?: Record<
    string,
    {
      description?: string;
      input_schema?: Record<string, unknown>;
      /**
       * Builder-supplied example input payload. `dvm describe --human`
       * renders this as the `Example:` `--data` value instead of a
       * schema-derived placeholder, so cross-field refinements not encoded in
       * JSON Schema (e.g. narrate's `text` XOR `dialogue`) still get a
       * runnable suggestion.
       */
      example?: Record<string, unknown>;
      pricing?: unknown;
    }
  >;
}

export interface StreamOptions {
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Callback invoked as each message arrives (for progress/logging). */
  onMessage?: (msg: Message) => void;
  /** opaque per-job token issued at create-time; sent as `X-Job-Token`. */
  jobToken?: string;
}

export interface SendMessageOptions {
  /** opaque per-job token issued at create-time; sent as `X-Job-Token`. */
  jobToken?: string;
}

export interface CancelOptions {
  /** opaque per-job token issued at create-time; sent as `X-Job-Token`. */
  jobToken?: string;
}

export interface StreamResult {
  /** All messages received during this stream session. */
  messages: Message[];
  /** Why the stream ended. */
  reason: "yield" | "complete" | "cancel" | "timeout" | "error";
}

/** Transport-agnostic interface for interacting with a DVM provider. */
export interface Transport {
  describe(provider: ProviderRef, options?: DescribeOptions): Promise<ProviderInfo>;
  /** Request a price quote for a job. */
  quote(provider: ProviderRef, job: JobEnvelope): Promise<Quote[]>;
  submit(
    provider: ProviderRef,
    job: JobEnvelope,
    payment?: Payment,
    options?: SubmitOptions
  ): Promise<JobReceipt>;
  /** Perform an authenticated read-only lookup of one caller-generated request id. */
  requestResult?(
    provider: ProviderRef,
    requestId: string,
    signedJob: JobEnvelope
  ): Promise<JobReceipt>;
  /** Materialize only a request whose payment/draw already committed server-side. */
  requestResume?(
    provider: ProviderRef,
    requestId: string,
    signedJob: JobEnvelope,
    options?: SubmitOptions
  ): Promise<void>;
  status(jobId: string, provider?: ProviderRef, options?: StatusOptions): Promise<JobStatus>;
  getMessages(
    jobId: string,
    after: number,
    provider?: ProviderRef,
    options?: MessagePollOptions
  ): Promise<Message[]>;
  sendMessage(
    jobId: string,
    message: OutboundMessage,
    provider?: ProviderRef,
    options?: SendMessageOptions
  ): Promise<void>;
  cancel(
    jobId: string,
    reason?: string,
    provider?: ProviderRef,
    options?: CancelOptions
  ): Promise<void>;
  /** Open a message stream for a job. Blocks until the provider yields. */
  stream?(
    jobId: string,
    afterSeq: number,
    provider?: ProviderRef,
    options?: StreamOptions
  ): Promise<StreamResult>;
  /**
   * Probe a DVM for the `WWW-Authenticate: Payment` challenges it would emit
   * on the upfront-payment path. Issues a no-payment POST and
   * parses the 402 response's MPP headers. Returns an empty array when the
   * DVM doesn't advertise MPP or accepts the no-payment request. Throws on
   * non-402 / non-2xx responses.
   */
  probeMppChallenges?(provider: ProviderRef, job: JobEnvelope): Promise<MppxChallenge[]>;
  /**
   * Execute a signed credit op against `POST /v1/credit`. The CLI
   * signs `signedBody` itself (same secp256k1 envelope as `/v1/job`); a fund
   * op's rail artifact rides `payment` on the same headers as a job submit.
   * Non-2xx answers throw a structured `DvmError` carrying the DVM's own code
   * plus any credit context fields (`shortfall_micro`, `fundable_micro`, …).
   */
  credit?(
    provider: ProviderRef,
    signedBody: Record<string, unknown>,
    payment?: Payment,
    options?: SubmitOptions
  ): Promise<CreditOpResult>;
  close?(): void;
}

/** Options controlling a provider metadata read. */
export interface DescribeOptions {
  /** Stop waiting for `/v1/info` after this many milliseconds. */
  timeoutMs?: number;
}
