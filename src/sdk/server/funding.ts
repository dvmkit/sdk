import { createHash } from "node:crypto";

import { IMPLICIT_CREDIT_TTL_MS } from "../../lib/credit-implicit";
import type { FxFetcher, FxRateSnapshot, FxSourceFailure } from "../pricing/fx";
import { FxRateUnavailableError, readFxSourceFailure } from "../pricing/fx";
import { fxRateFor, parseUsdPrice, satsToFiat } from "../pricing/index";

/**
 * Fiat denomination of the job price, pinned per request.
 *
 * The credit ledger is fiat-micro denominated: 1e-6 of the DVM's pricing
 * currency, never msats. The conversion pins at
 * quote time: the verify path already fixes both the fiat price and its msat
 * equivalent, so the implicit N=1 fund credits the QUOTED fiat amount when
 * the attached token satisfies the quoted msats — no fresh BTC/USD lookup in
 * the rail verify hot path, and fund = draw = quoted price means zero
 * rounding drift at N=1.
 */
export interface PriceFiat {
  /** Lowercase currency code, e.g. `"usd"`. */
  currency: string;
  /** Job price in 1e-6 currency units. */
  amountMicro: number;
}

/** Implicit per-call credits expire after 90 days by default. */
export { IMPLICIT_CREDIT_TTL_MS };

/**
 * Paid requests pin the validated fiat price without an FX lookup. Free jobs
 * return undefined. configureDVM and validateQuoteResult enforce micro-unit
 * range and the DVM's declared currency before this helper is called; neither
 * guard converts a mismatched currency.
 */
export function resolvePriceFiat(args: {
  price: string | undefined;
  priceMsats: number | undefined;
  /** Fiat envelope from a dynamic quote, when the price came from `onQuote`. */
  dynamicUpfront?: { amount: number; currency: string };
}): PriceFiat | undefined {
  if (!args.priceMsats) return undefined;
  return priceFiatMicro(args);
}

/**
 * Shared exact integer for quote, 402 and ledger valuation. Callers must sign
 * this micro-unit figure rather than reconstruct it from a rounded display.
 * Unlike resolvePriceFiat, advertisement callers need no msat price in hand.
 */
export function priceFiatMicro(args: {
  price?: string | undefined;
  /** Fiat envelope from a dynamic quote, when the price came from `onQuote`. */
  dynamicUpfront?: { amount: number; currency: string };
}): PriceFiat | undefined {
  if (args.dynamicUpfront) {
    const amountMicro = Math.round(args.dynamicUpfront.amount * 1_000_000);
    if (!Number.isSafeInteger(amountMicro) || amountMicro < 1) return undefined;
    return { currency: args.dynamicUpfront.currency.toLowerCase(), amountMicro };
  }
  if (args.price === undefined) return undefined;
  const amountMicro = Math.round(parseUsdPrice(args.price, "price") * 1_000_000);
  if (!Number.isSafeInteger(amountMicro) || amountMicro < 1) return undefined;
  return { currency: "usd", amountMicro };
}

/** Reasons are kept distinct so a skipped ledger leg identifies its cause. */
export type FiatDenominationFailure =
  /** Nothing to convert — a zero-msat ask. */
  | "no_msats"
  /** Worth less than one micro-unit of the target currency at the live rate. */
  | "sub_micro"
  /** The snapshot carries no rate for this currency, and this DVM never quotes it. */
  | "unsupported_currency"
  /**
   * No live rate and no last-known snapshot to degrade onto — including a
   * snapshot that arrived without this currency and had none to carry forward.
   */
  | "rate_unavailable"
  /** The platform declared its snapshot known-stale and we refused to degrade. */
  | "rate_stale_refused";

/**
 * An fx snapshot plus how fresh it is, or why there is none. `stale` means the
 * live fetch failed and this is the last snapshot the fetcher saw;
 * `cachedAt` is the Unix ms it landed.
 */
export type ResolvedFx =
  | { ok: true; snapshot: FxRateSnapshot; stale: boolean; cachedAt?: number }
  | { ok: false; reason: FiatDenominationFailure; detail?: string; sourceFailure?: FxSourceFailure };

/**
 * The result of denominating an msat amount. See {@link msatsToFiatMicro}.
 *
 * `stale` covers both degradation rungs and `carriedForward` distinguishes
 * them: either the whole snapshot came from `lastKnown()` because the live
 * fetch failed, or the fetch succeeded and only *this* currency was carried
 * over from an earlier one because the body omitted it. They read
 * differently to an operator — the rate source down, versus the rate source
 * having quietly narrowed — so the log says which.
 */
export type FiatDenomination =
  | { ok: true; price: PriceFiat; stale: boolean; cachedAt?: number; carriedForward?: boolean }
  | { ok: false; reason: FiatDenominationFailure; detail?: string; sourceFailure?: FxSourceFailure };

/**
 * A live fetch failure may use lastKnown(), but a known-stale refusal never
 * does: that would use the very snapshot the platform refused. No shared
 * cooldown suppresses the recovery probe on a later mid-job ask.
 */
export async function resolveFxSnapshot(fetcher: FxFetcher): Promise<ResolvedFx> {
  try {
    return { ok: true, snapshot: await fetcher.fetch(), stale: false };
  } catch (err) {
    if (err instanceof FxRateUnavailableError && err.knownStale) {
      return {
        ok: false,
        reason: "rate_stale_refused",
        detail: `snapshot ${err.knownStale.staleDays.toString()}d stale`,
        sourceFailure: readFxSourceFailure(err),
      };
    }
    const cached = fetcher.lastKnown?.();
    if (cached) {
      return { ok: true, snapshot: cached.snapshot, stale: true, cachedAt: cached.cachedAt };
    }
    return {
      ok: false,
      reason: "rate_unavailable",
      detail: err instanceof Error ? err.message : String(err),
      sourceFailure: err instanceof FxRateUnavailableError
        ? readFxSourceFailure(err) ?? { category: "unknown" }
        : { category: "unknown" },
    };
  }
}

/**
 * Bare-msat mid-job asks need an FX conversion into the credit's currency.
 * Failure carries a reason: callers accept the payment and skip its ledger
 * leg rather than refusing over an outage. Upfront prices use resolvePriceFiat
 * and require no rate, so they do not share this fail-soft behavior.
 */
export async function msatsToFiatMicro(args: {
  msats: number;
  currency: string;
  fxFetcher: FxFetcher;
  /**
   * A snapshot already in hand. The mid-job ask path fetches one to
   * size a fiat-form ask's msats; converting on that same snapshot costs no
   * second fetch and keeps the two figures arithmetically consistent.
   */
  snapshot?: FxRateSnapshot;
}): Promise<FiatDenomination> {
  if (!args.msats) return { ok: false, reason: "no_msats" };
  let fx: FxRateSnapshot;
  let stale = false;
  let cachedAt: number | undefined;
  if (args.snapshot) {
    fx = args.snapshot;
  } else {
    const resolved = await resolveFxSnapshot(args.fxFetcher);
    if (!resolved.ok) return resolved;
    ({ snapshot: fx, stale, cachedAt } = resolved);
  }
  // This currency's rate is older than the rest of the snapshot —
  // priced, but degrading, and the caller reports it as such.
  const carriedForward = fx.carried_forward?.includes(args.currency) ?? false;
  if (carriedForward) stale = true;
  let amount: number;
  try {
    amount = satsToFiat(args.msats / 1000, fxRateFor(fx, args.currency));
  } catch (err) {
    return {
      ok: false,
      // A currency the snapshot never carried is the rate source narrowing, not
      // a currency this DVM doesn't speak — `fxRateFor` separates the two.
      reason: err instanceof FxRateUnavailableError ? "rate_unavailable" : "unsupported_currency",
      detail: err instanceof Error ? err.message : String(err),
      ...(err instanceof FxRateUnavailableError && {
        sourceFailure: readFxSourceFailure(err) ?? { category: "unknown" },
      }),
    };
  }
  const amountMicro = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(amountMicro) || amountMicro < 1) {
    return { ok: false, reason: "sub_micro" };
  }
  return {
    ok: true,
    price: { currency: args.currency, amountMicro },
    stale,
    cachedAt,
    ...(carriedForward && { carriedForward: true }),
  };
}

/**
 * The mid-job ask's fiat pin, in the target currency — what the cap
 * on this job's cumulative draw growth is summed from, and what the top-up
 * funds against.
 *
 * Two differences from {@link msatsToFiatMicro}, both scoped to the ask:
 *
 * - **A fiat-form ask already in the target currency is taken verbatim**, so a
 * `ctx.requestPayment({ amount, currency })` keeps the exactness it has and
 * never round-trips through a rate. Any other form converts `msats` on the
 * caller's snapshot — including a fiat-form ask in some *other* currency,
 * which converts on the very snapshot that sized its msats, so the pin and
 * the wire ask can't disagree about the rate.
 * - **Floors at one micro-unit rather than returning `undefined`.**
 * `ctx.requestPayment(500)` is half a micro at $100k/BTC — a legitimate, if
 * tiny, ask, and refusing to denominate it poisons the job's whole ask total
 * and with it the ceiling. One micro is provably conservative for a ceiling:
 * the ask is worth less than that. `resolvePriceFiat` and `msatsToFiatMicro`
 * keep their sub-micro refusals, which are load-bearing on the upfront path.
 *
 * Throws only what `fxRateFor` throws — an unsupported target currency, or an
 * `fx_rate_unavailable` for one the snapshot never carried. The ask path catches
 * both and degrades to an unpinnable ask, naming which it was.
 */
export function pinAskFiat(args: {
  msats: number;
  currency: string;
  fx: FxRateSnapshot;
  exact?: { amount: number; currency: string };
}): PriceFiat | undefined {
  if (!args.msats) return undefined;
  const amount =
    args.exact?.currency === args.currency
      ? args.exact.amount
      : satsToFiat(args.msats / 1000, fxRateFor(args.fx, args.currency));
  const rounded = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(rounded)) return undefined;
  return { currency: args.currency, amountMicro: Math.max(1, rounded) };
}

/**
 * Fiat micro-units actually funded for a rail payment of `paidMsats` against
 * a job quoted at `requiredMsats` ↔ `priceFiat`. An overpayment funds and draws
 * the full paid amount so ledger value matches money received.
 * Pro-rata at the quote-pinned ratio, so the exact-payment case — what every
 * conformant client sends — is `priceFiat.amountMicro` with zero drift.
 */
export function fundedMicroFor(
  priceFiat: PriceFiat,
  paidMsats: number,
  requiredMsats: number
): number {
  // A missing reference price is a caller bug; dividing by it would surface
  // as the payer's `payment_invalid` instead of a server fault.
  if (!Number.isFinite(requiredMsats) || requiredMsats <= 0) {
    throw new Error(`fundedMicroFor needs a positive reference price in msats (got ${requiredMsats})`);
  }
  if (paidMsats === requiredMsats) return priceFiat.amountMicro;
  return Math.round((priceFiat.amountMicro * paidMsats) / requiredMsats);
}

/**
 * USD micro-units are already USDC's six-decimal units. Advertise them verbatim
 * and value settlement against the same figure; a BTC conversion would add
 * rounding and an unpinned rate between challenge and settlement.
 * Non-USD callers fail closed rather than implicitly introducing that FX hop.
 */
export function x402RequiredUsdcMicro(priceFiat: PriceFiat): number {
  if (priceFiat.currency !== "usd") {
    throw new Error(`x402 is not offered for ${priceFiat.currency}-priced DVMs`);
  }
  return priceFiat.amountMicro;
}

/**
 * Value a settled authorization against the advertised USDC amount, preserving
 * the quote at exact payment and prorating genuine over/underpayment. Use this
 * ratio for both fiat and msat frames: a USDC-to-msat round trip can round an
 * exact payment into a false overpayment and invalidate its signed commitment.
 */
export function x402SettledShare(
  quoted: number,
  requiredUsdcMicro: number,
  settledUsdcMicro: number
): number {
  if (requiredUsdcMicro <= 0 || settledUsdcMicro === requiredUsdcMicro) return quoted;
  return Math.round((quoted * settledUsdcMicro) / requiredUsdcMicro);
}

/**
 * SHA-256 hex over the raw funding artifact — the value an explicit
 * fund-and-draw request must sign as `fund.commitment` (the funding-commitment rule).
 * The artifact is the exact header-borne string: the `X-Cashu` header value,
 * the `X-PAYMENT` header value, or the extracted `Payment <…>` mpp scheme
 * string. Hashing the verbatim wire string keeps the commitment computable by
 * the client without any decode step.
 */
export function fundingCommitment(artifact: string): string {
  return createHash("sha256").update(artifact, "utf8").digest("hex");
}

/**
 * Deterministic credit id for an implicit N=1 funding — namespaced so a
 * caller-chosen explicit `credit_id` can never collide with it.
 */
export function implicitCreditId(rail: "cashu" | "x402" | "tempo", paymentId: string): string {
  return `imp:${rail}:${paymentId}`;
}

/**
 * Seconds an authorization must outlive the job's runtime bound: the
 * facilitator rejects one within 6 seconds of `validBefore`, and `/settle`
 * itself takes time.
 */
export const DEFERRED_X402_SETTLE_MARGIN_SECONDS = 15;

/** Extra validity advertised so ordinary signing and network delay cannot trip the guard. */
export const DEFERRED_X402_SIGNING_ALLOWANCE_SECONDS = 15;

/** Authorization lifetime a deferred-settlement capability needs and advertises. */
export function deferredX402Window(maxRuntimeSeconds: number): {
  minValidSeconds: number;
  advertisedTimeoutSeconds: number;
} {
  const minValidSeconds = maxRuntimeSeconds + DEFERRED_X402_SETTLE_MARGIN_SECONDS;
  return {
    minValidSeconds,
    advertisedTimeoutSeconds: minValidSeconds + DEFERRED_X402_SIGNING_ALLOWANCE_SECONDS,
  };
}

const DEFERRED_ID_PREFIX = "x402d:";

/**
 * Credit and draw id of a job paid by a deferred x402 authorization. The ids
 * are fixed at admission, before any ledger row exists, and name the intent so
 * the terminal funnel can settle or release it from the job record alone.
 */
export function deferredX402Id(intentId: string): string {
  return `${DEFERRED_ID_PREFIX}${intentId}`;
}

/** The intent a deferred-settlement credit id names, or undefined for any other credit. */
export function deferredX402IntentId(creditId: string | undefined): string | undefined {
  return creditId?.startsWith(DEFERRED_ID_PREFIX)
    ? creditId.slice(DEFERRED_ID_PREFIX.length)
    : undefined;
}

/**
 * Id prefixes the SERVER derives: `imp:` for an implicit N=1 funding,
 * `fnd:` for a `/v1/credit` top-up that names no credit.
 */
const DERIVED_CREDIT_ID_PREFIXES = ["imp:", "fnd:"];

/**
 * Whether a credit id sits in a namespace the server derives — which a caller
 * may **reference** but must never **create**.
 *
 * Both namespaces are computable by a third party: `imp:` from the rail's
 * payment id, `fnd:` from `(pubkey, fund_id)`. `CreditLedger.fund` INSERTs at
 * whatever id it is handed, so without this rule anyone could pre-open a
 * credit at an id the server would later derive for someone else. The victim's
 * top-up then settles on the rail before `fund` refuses with `caller_mismatch`
 * they pay and hold nothing. Keeping creation server-side means a derived id
 * is only ever owned by the caller it was derived for.
 *
 * Referencing stays open, and has to: the id of a credit opened this way is
 * handed back to its owner, and naming it is how a later top-up stacks onto it
 * or a job draws from it.
 */
export function isDerivedCreditId(creditId: string): boolean {
  return DERIVED_CREDIT_ID_PREFIXES.some((prefix) => creditId.startsWith(prefix));
}

/**
 * Deterministic credit id for a `/v1/credit` top-up that names no credit —
 * the documented "omit `credit_id` to open a new one" flow.
 *
 * Minting a fresh random id per attempt would make that flow the one top-up
 * shape that is *not* retry-safe: the second attempt looks up
 * `(fresh_uuid, fund_id)`, finds no funding, and re-presents an artifact the
 * rail has already spent. Deriving from `(callerPubkey, fundId)` instead
 * makes the retry land on the same credit, so the `credit_fundings` key does
 * its job and the caller gets the original outcome back.
 *
 * Namespaced (`fnd:`) and hashed: the pubkey never appears in an id that
 * shows up on the wire, and a caller-chosen `credit_id` can't collide with a
 * derived one by accident. The id is deterministic, so it is also predictable
 * to anyone who knows the caller's pubkey — {@link isDerivedCreditId} is what
 * stops that from being useful, by keeping the namespace server-created.
 */
export function derivedFundCreditId(callerPubkey: string, fundId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([callerPubkey, fundId]), "utf8")
    .digest("hex");
  return `fnd:${digest}`;
}

/**
 * Settlement reference stamped on the revenue event of an **explicit** draw;
 * one funding backs N draws, so the funding's own rail reference
 * cannot key them: `revenue_events` carries a global `UNIQUE (rail, tx_hash)`
 * that deliberately drops cross-job reuse of a settlement reference, and
 * reusing it would silently discard every draw but the first.
 *
 * Hashed rather than concatenated because `draw_id` is caller-generated: the
 * DVM id is mixed in so two DVMs whose callers both pick `draw_id: "1"` can't
 * collide, and the hash keeps caller-controlled bytes out of a column ops
 * reads. Deterministic, so a replayed report lands on the same row.
 */
export function drawSettlementRef(dvmId: string, creditId: string, drawId: string): string {
  const digest = createHash("sha256")
    .update(`${dvmId}\n${creditId}\n${drawId}`, "utf8")
    .digest("hex");
  return `draw:${digest}`;
}
