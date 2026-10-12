import { X402_BATCH_SETTLEMENT_SCHEME, X402_EXACT_SCHEME } from "./x402/spec";

/** Which x402 funding flavour a top-up at this DVM would take. */
export type X402CreditFlavour = typeof X402_BATCH_SETTLEMENT_SCHEME | typeof X402_EXACT_SCHEME;

/**
 * Rails accepted by caller funding selection and pin validation. Each rail's orchestration still
 * owns its availability and payment protocol.
 */
export const CREDIT_FUND_RAILS = ["cashu", "lightning", "x402", "tempo"] as const;

export type CreditFundRail = (typeof CREDIT_FUND_RAILS)[number];

/**
 * Lightning invoices fund credit but do not provide a reclaim credential; reclaim uses the other
 * supported payout rails.
 */
export const CREDIT_DRAIN_RAILS = ["cashu", "x402", "tempo"] as const;

export type CreditDrainRail = (typeof CREDIT_DRAIN_RAILS)[number];

export function isCreditFundRail(value: unknown): value is CreditFundRail {
  return typeof value === "string" && (CREDIT_FUND_RAILS as readonly string[]).includes(value);
}

/**
 * The two rails that hold value in a stablecoin, and the only ones where the
 * caller has an instrument to choose. Ecash and Lightning fund a
 * credit by paying once; neither has a reusable form, so a funding mode narrows
 * the eligible set to these two rather than reordering the whole list.
 */
export const STABLECOIN_FUND_RAILS = ["x402", "tempo"] as const;

export function isStablecoinFundRail(rail: CreditFundRail): boolean {
  return (STABLECOIN_FUND_RAILS as readonly string[]).includes(rail);
}

/**
 * How a stablecoin credit funding is paid for — the customer-level choice
 * underneath a rail.
 *
 * Both modes fund **prepaid credit**; they are not "pay one job" versus "buy
 * credit". What differs is the instrument: a `one-shot` funding is a single
 * payment that settles and is done, while a `reusable` one puts up channel
 * collateral that later top-ups draw against. The rail-native names —
 * `charge` / `session` on Tempo, `exact` / `batch-settlement` on x402 — are the
 * wire spelling of the same two choices and stay subordinate to them.
 */
export const CREDIT_FUNDING_MODES = ["one-shot", "reusable"] as const;

/** One-shot payment or reusable channel collateral, for a stablecoin funding. */
export type CreditFundingMode = (typeof CREDIT_FUNDING_MODES)[number];

export function isCreditFundingMode(value: unknown): value is CreditFundingMode {
  return typeof value === "string" && (CREDIT_FUNDING_MODES as readonly string[]).includes(value);
}

export function fundingModeForTempoIntent(intent: "charge" | "session"): CreditFundingMode {
  return intent === "session" ? "reusable" : "one-shot";
}

export function fundingModeForX402Flavour(flavour: X402CreditFlavour): CreditFundingMode {
  return flavour === X402_BATCH_SETTLEMENT_SCHEME ? "reusable" : "one-shot";
}

/**
 * The `fund.amount_micro` a fund-and-draw must sign for a token of
 * `fundMsats`, mirroring the server's `fundedMicroFor` exactly:
 * pro-rata at the quote-pinned ratio `priceMicroServer ↔ requiredMsats`,
 * with the exact-payment case returning the fiat price with zero drift.
 * Both inputs must be **server-authored**, and since the behavior was introduced both are exact
 * integers on the same 402: `required_msats` and `price_micro`, resolved
 * against one fx snapshot. A client-fx-derived figure — or one reconstructed by
 * multiplying a rendered decimal price by a million — is refused with
 * `funding_commitment_mismatch` after the spend has already committed. Taking
 * the fiat half from a separate `/v1/quote` hop is the weaker fallback for
 * providers that state no `price_micro`: that hop re-prices, so its figure and
 * the 402's `required_msats` are two independent resolutions of one ratio.
 *
 * Cashu-shaped, which is all v1 funds on: x402 takes the same ratio against
 * the 402's advertised `maxAmountRequired` in µUSDC rather than through
 * millisatoshis, so a caller-side x402 fund needs its
 * own derivation rather than this one.
 */
export function fundWireAmountMicro(
  priceMicroServer: number,
  fundMsats: number,
  requiredMsats: number
): number {
  if (fundMsats === requiredMsats) return priceMicroServer;
  return Math.round((priceMicroServer * fundMsats) / requiredMsats);
}

/**
 * What a `funding_commitment_mismatch` refusal says about the provider's own
 * valuation of the artifact attached.
 *
 * The three cases are not interchangeable to a caller holding proofs that are
 * already P2PK-locked to the provider: only `absent` means no re-sign can ever
 * land, and only that case is safe to give up on.
 */
export type FundValuation =
  /** A usable figure. A corrected re-sign carries exactly this. */
  | { kind: "figure"; micro: number }
  /** The provider stated a valuation, but not one that can be signed (zero, negative, fractional, out of range). */
  | { kind: "malformed" }
  /** No valuation stated at all: the commitment-hash branch, which re-signing can never fix. */
  | { kind: "absent" };

/**
 * Read the provider's valuation off a `funding_commitment_mismatch` body — the
 * figure a corrected re-sign must carry. Prefers the structured
 * `expected_micro` field; falls back to the figure the message states ("… at
 * the quoted price (130769)") for providers that predate it, including when the
 * structured field is present but unusable.
 *
 * A provider that stated *something* is on the amount branch even when what it
 * stated is garbage, so that case returns `malformed` rather than `absent`. The
 * two must not collapse: a caller that treats "the provider emitted a bad field"
 * as "uncorrectable" drops the entry and burns proofs it could have held.
 *
 * Shared by both recovery legs: the in-flight retry in `request.ts` and the
 * crash-resume sweep in `wallet-agent/recovery-submissions.ts`.
 */
export function readFundValuation(fields: {
  expectedMicro?: unknown;
  message?: string;
}): FundValuation {
  const structured = usableMicro(fields.expectedMicro);
  if (structured !== undefined) return { kind: "figure", micro: structured };

  const match = /quoted price \((\d+)\)/.exec(fields.message ?? "");
  const stated = match ? usableMicro(Number(match[1])) : undefined;
  if (stated !== undefined) return { kind: "figure", micro: stated };

  const providerStatedSomething = fields.expectedMicro !== undefined || match !== null;
  return providerStatedSomething ? { kind: "malformed" } : { kind: "absent" };
}

function usableMicro(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
