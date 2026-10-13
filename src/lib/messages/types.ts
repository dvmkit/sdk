import type { Challenge, Credential } from "mppx";

import type { Currency } from "../../sdk/pricing/currency";
import type { PaymentRequiredV2 } from "../x402/spec";

export type MessageFrom = "requester" | "provider";

/** Single mppx-shaped MPP challenge carried in `payment-request` messages. */
export type MppxChallenge = Challenge.Challenge;

/** Structured MPP credential (`{ challenge, payload, source? }`) carried in `payment` messages. */
export type MppxCredential = Credential.Credential;

export type MessageType =
  | "text"
  | "prompt"
  | "response"
  | "artifact"
  | "payment-request"
  | "payment"
  | "approval"
  | "cancel"
  | "complete"
  | "working"
  | "progress";

interface MessageBase {
  /** Monotonic sequence number, assigned by provider/server. */
  seq: number;
  from: MessageFrom;
  /** Unix timestamp (seconds). */
  timestamp: number;
}

export interface TextContent {
  text: string;
}

/** Provider prompt requesting input from the requester. */
export interface PromptContent {
  id: string;
  text: string;
  options?: string[];
  /** JSON Schema describing the expected response shape for structured prompts. */
  schema?: Record<string, unknown>;
}

/** Requester's response to a provider prompt. */
export interface ResponseContent {
  prompt_id: string;
  text: string;
  /** Structured response data conforming to the prompt's schema. */
  data?: Record<string, unknown>;
}

/** Job output — inline data or a URL reference. */
export interface ArtifactContent {
  name?: string;
  mime_type?: string;
  /** Inline data (string or base64 for binary). */
  data?: string;
  /** Encoding of inline data: "utf-8" for text, "base64" for binary. */
  encoding?: "utf-8" | "base64";
  url?: string;
  /** Size in bytes (for URL-referenced artifacts). */
  size_bytes?: number;
  /** SHA-256 hash for integrity verification. */
  sha256?: string;
}

/** Provider requests payment to continue. */
export interface PaymentRequestContent {
  amount_msats: number;
  reason: string;
  /**
   * The operator's fiat-denominated intent when the DVM priced this charge in
   * fiat (V9's fiat-first push extends to mid-job `requestPayment`). The SDK
   * derived `amount_msats` from this at send-time using a live fx rate;
   * recording the fiat envelope on the wire lets the caller's CLI render the
   * operator's actual USD/EUR/GBP/JPY intent instead of a sats figure that
   * obscures it. Absent when the DVM priced in sats directly.
   */
  fiat_amount?: { amount: number; currency: Currency };
  mints?: string[];
  min_locktime_seconds?: number;
  /**
   * NUT-11 P2PK lock pubkey the requester should lock cashu outputs to.
   * When absent, the requester falls back to `/v1/info`'s `cashu.lock_pubkeys[0]`.
   */
  lock_pubkey?: string;
  /** x402 stablecoin payment option. */
  x402?: {
    pay_to: string;
    network: string;
    asset: string;
    facilitator?: string;
    /** Exact USDC micro-unit amount the server requires the caller to sign. */
    required_usdc_micro?: string;
    /** Full v2 challenge echoed into the caller's payment payload; absent selects legacy v1. */
    payment_required?: PaymentRequiredV2;
    /**
     * Server-issued EIP-3009 `bytes32` nonce (0x-prefixed 32-byte hex) the
     * caller MUST use when signing `TransferWithAuthorization` for this
     * payment-request. Binds the credential to this job so a payload signed
     * for job A cannot satisfy job B within the pre-settlement window
     * Optional on the wire for backwards-compat — pre-fix DVMs
     * never set it; verify-side gate keys on `pendingX402Nonce !== undefined`.
     */
    nonce?: string;
  };
  /**
   * Tempo payment option. One challenge per `method/intent` the DVM
   * accepts; clients pick the entry that matches their wallet's method and
   * construct a `Credential` against it. Each challenge carries its own
   * recipient/currency/amount/HMAC-bound id, so no flat fields beside it.
   */
  tempo?: {
    challenges: MppxChallenge[];
  };
}

/** Requester sends payment proof, or provider sends change/refund. */
export interface PaymentContent {
  cashu_token?: string;
  mint?: string;
  amount_msats?: number;
  /**
   * UUIDv4 per-call identifier for the agent-wallet path.
   * Mid-job equivalent of the upfront flow's `X-Cashu-Request-Id` header —
   * threaded into the SDK accumulator's `(dvm_id, request_id)` replay key.
   */
  cashu_request_id?: string;
  refund_key?: string;
  /** For provider-sent payments: "change" or "refund". */
  reason?: "change" | "refund";
  /** Base64-encoded x402 `PaymentPayload` (mid-job equivalent of `X-PAYMENT`). */
  x402_payment?: string;
  /**
   * Structured Tempo credential (`{ challenge, payload, source? }` — see
   * `mppx`'s `Credential.Credential`). The embedded challenge carries the
   * method, intent, and HMAC-bound id, so no separate `method`/`challenge_id`
   * fields are needed.
   */
  tempo_credential?: MppxCredential;
  /**
   * Dev-only: satisfy the ask with no proof at all. The `/_dev`
   * console has no wallet, so its auto-approve button sends this instead of a
   * rail credential. Admitted only by a `devMode` server, and only on a
   * message that carries none of the proofs above — money on the wire always
   * takes its rail. Never set it from a real caller; a production server
   * rejects the message.
   */
  dev_auto?: boolean;
}

/** Requester approves a proposed action or cost. */
export interface ApprovalContent {
  ref_seq?: number;
  comment?: string;
}

/** Requester or provider cancels the job. */
export interface CancelContent {
  reason?: string;
}

/** Provider signals job completion. */
export interface CompleteContent {
  /** Human-readable summary of the completed job (same value emitted on the status endpoint as `summary`). Not the payload — artifacts carry that. */
  summary?: string;
}

/** Provider signals it's busy — client should disconnect and check back later. */
export interface WorkingContent {
  estimate_seconds?: number;
  hint?: string;
}

/**
 * Provider heartbeat with a structured progress signal. Non-yield: the SSE
 * stream stays open across heartbeats so clients can render progress live.
 * Different from `working`, which yields and asks the client to disconnect.
 */
export interface ProgressContent {
  /** Estimated completion as a percentage 0–100. */
  percent_complete: number;
  /** Coarse-grained phase label (DVM-defined; e.g. "transcribing", "diarising"). */
  current_phase?: string;
  /** Optional human-readable hint about what's happening right now. */
  hint?: string;
}

export type Message =
  | (MessageBase & { type: "text"; content: TextContent })
  | (MessageBase & { type: "prompt"; content: PromptContent })
  | (MessageBase & { type: "response"; content: ResponseContent })
  | (MessageBase & { type: "artifact"; content: ArtifactContent })
  | (MessageBase & { type: "payment-request"; content: PaymentRequestContent })
  | (MessageBase & { type: "payment"; content: PaymentContent })
  | (MessageBase & { type: "approval"; content: ApprovalContent })
  | (MessageBase & { type: "cancel"; content: CancelContent })
  | (MessageBase & { type: "complete"; content: CompleteContent })
  | (MessageBase & { type: "working"; content: WorkingContent })
  | (MessageBase & { type: "progress"; content: ProgressContent });

export function isPromptMessage(
  msg: Message
): msg is MessageBase & { type: "prompt"; content: PromptContent } {
  return msg.type === "prompt";
}

export function isArtifactMessage(
  msg: Message
): msg is MessageBase & { type: "artifact"; content: ArtifactContent } {
  return msg.type === "artifact";
}

export function isPaymentRequestMessage(
  msg: Message
): msg is MessageBase & { type: "payment-request"; content: PaymentRequestContent } {
  return msg.type === "payment-request";
}

export function isTextMessage(
  msg: Message
): msg is MessageBase & { type: "text"; content: TextContent } {
  return msg.type === "text";
}

export function isCompleteMessage(
  msg: Message
): msg is MessageBase & { type: "complete"; content: CompleteContent } {
  return msg.type === "complete";
}

export function isCancelMessage(
  msg: Message
): msg is MessageBase & { type: "cancel"; content: CancelContent } {
  return msg.type === "cancel";
}

export function isWorkingMessage(
  msg: Message
): msg is MessageBase & { type: "working"; content: WorkingContent } {
  return msg.type === "working";
}

export function isProgressMessage(
  msg: Message
): msg is MessageBase & { type: "progress"; content: ProgressContent } {
  return msg.type === "progress";
}
