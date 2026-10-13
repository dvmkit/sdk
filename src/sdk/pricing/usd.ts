import type { Currency } from "./currency";

/**
 * Thrown by `fiatToSatsCeil` / `satsToFiat` when the supplied `ratePerBtc` is
 * non-finite or non-positive. Surfaces a misconfigured fx fetcher loudly
 * instead of silently producing a 0-sats charge or a 0-fiat display string —
 * callers obtain a valid rate
 * from the SDK's fx fetcher (which raises `FxRateUnavailableError` on
 * upstream failure); this error is the defence-in-depth backstop for any
 * caller that constructs a rate by other means.
 */
export class InvalidFxRateError extends Error {
  readonly code = "invalid_fx_rate";
  readonly ratePerBtc: unknown;
  constructor(ratePerBtc: unknown) {
    super(
      `invalid fx rate ${String(ratePerBtc)} — expected a finite positive number of fiat per BTC`
    );
    this.ratePerBtc = ratePerBtc;
  }
}

/**
 * Convert a fiat amount to integer sats at the supplied fiat-per-BTC rate.
 * Rounds up to cover the fiat amount. Negative or non-finite amounts
 * collapse to 0 (a $0 charge is
 * well-defined). A non-finite or non-positive `ratePerBtc` raises
 * `InvalidFxRateError` — a silent 0 would mask a misconfigured fetcher into
 * shipping a free charge. The math is currency-agnostic — `ratePerBtc` is the
 * number of units of *some* fiat per 1 BTC; the caller looks the right rate
 * out of an `FxRateSnapshot`.
 */
export function fiatToSatsCeil(amount: number, ratePerBtc: number): number {
  if (!Number.isFinite(ratePerBtc) || ratePerBtc <= 0) {
    throw new InvalidFxRateError(ratePerBtc);
  }
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.ceil((amount * 1e8) / ratePerBtc);
}

/**
 * Convert integer sats back to a fiat amount at the supplied fiat-per-BTC
 * rate. A non-finite or non-positive `ratePerBtc` raises
 * `InvalidFxRateError` — the silent `0` would land in display strings and
 * mislead callers about the value at hand.
 */
export function satsToFiat(sats: number, ratePerBtc: number): number {
  if (!Number.isFinite(ratePerBtc) || ratePerBtc <= 0) {
    throw new InvalidFxRateError(ratePerBtc);
  }
  return (sats / 1e8) * ratePerBtc;
}

/**
 * Thrown when a builder-declared USD price literal is malformed.
 * Carries the offending value and the config field it came from so
 * `configureDVM`'s boot check can surface both without re-deriving them.
 */
export class InvalidUsdPriceError extends Error {
  readonly code = "invalid_usd_price";
  constructor(
    readonly field: string,
    readonly value: unknown,
    detail: string
  ) {
    super(`${field}: ${detail}`);
    this.name = "InvalidUsdPriceError";
  }
}

/**
 * Parse a builder-declared USD price literal (`"$0.05"`) into a bare USD
 * number. The single parser for every price surface — capability `price`,
 * `credit.min`/`credit.max`, the `/v1/info` pricing ceiling, and the ledger's
 * fiat denomination — so those surfaces cannot drift on what they accept.
 *
 * Strict by construction on both format and precision:
 *
 * - The grammar is `$` followed by a decimal number, so `"$1abc"` (which every
 * ad-hoc `parseFloat(v.slice(1))` used to accept as 1) is rejected.
 * - The amount must be expressible at {@link roundUsd}'s four decimal places,
 * which is the precision **every** advertisement surface carries — `/v1/info`
 * pricing ceilings, `/v1/quote` upfronts, the isolate tier's re-emit. A price
 * finer than that advertises as a different number than it charges, and one
 * below `$0.0001` advertises as `$0` while still gating the job: advertised
 * paid, apparently free, which is the mismatch this parser exists to close.
 *
 * The floor is deliberately 100× coarser than the credit ledger's micro-unit.
 * The ledger could denominate `$0.000001`; no surface a caller reads can
 * express it, so blessing it here would only move the incoherence downstream.
 */
export function parseUsdPrice(value: string, field: string): number {
  if (!USD_PRICE_RE.test(value)) {
    throw new InvalidUsdPriceError(
      field,
      value,
      `${JSON.stringify(value)} is not a USD price literal. Use a "$X.XX" string, e.g. "$0.05".`
    );
  }
  const usd = parseFloat(value.slice(1));
  if (!Number.isFinite(usd) || usd < MIN_USD_PRICE) {
    throw new InvalidUsdPriceError(
      field,
      value,
      `${JSON.stringify(value)} is below ${MIN_USD_PRICE_LITERAL}, the smallest price the wire can ` +
        `carry — every price surface rounds to four decimals, so this would advertise as $0 and then ` +
        `charge anyway. Charge at least ${MIN_USD_PRICE_LITERAL}, or omit the price for a free capability.`
    );
  }
  if (roundUsd(usd) !== usd) {
    throw new InvalidUsdPriceError(
      field,
      value,
      `${JSON.stringify(value)} carries more than four decimal places. Every price surface rounds to ` +
        `four, so this would advertise ${formatUsd(roundUsd(usd))} and charge something else. Use at ` +
        `most four decimals.`
    );
  }
  if (!Number.isSafeInteger(Math.round(usd * 1_000_000))) {
    throw new InvalidUsdPriceError(
      field,
      value,
      `${JSON.stringify(value)} is too large to denominate. Use an amount under $9,007,199,254.`
    );
  }
  return usd;
}

/**
 * Round a USD value to 4 decimal places. This is the **storage / accounting**
 * precision — preserves
 * sub-cent amounts so a `$0.0150` per-minute rate doesn't collapse to
 * `$0.02` before it ever reaches a multiplier.
 */
export function roundUsd(usd: number): number {
  return Math.round(usd * 10_000) / 10_000;
}

/**
 * Format a USD amount with adaptive precision so sub-cent amounts don't
 * render as `$0.00`. The 2dp/4dp boundary at $0.01 is **human-render**
 * precision and is intentionally coarser than {@link roundUsd}'s storage
 * precision: a value like `0.015` keeps four decimals through `roundUsd`
 * (storage / multiplier inputs) but renders as `$0.02` here (human display).
 * Don't try to unify the two — they serve different surfaces.
 */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/**
 * Format a fiat amount with currency-aware symbol, precision, and ISO code.
 * Used by the CLI to render payment-request `fiat_amount` envelopes ("$0.05
 * USD", "€0.05 EUR", "¥5 JPY"). Precision is adaptive: JPY has no sub-yen
 * denomination so renders as 0 decimals, every other currency uses 2 decimals
 * at or above 0.01 and 4 below so sub-cent figures don't collapse to 0.00.
 * Unknown currencies (anything not in {@link FIAT_SYMBOLS}) render with the
 * uppercased ISO code and no leading symbol.
 */
export function formatFiat(amount: number, currency: Currency): string {
  const code = currency.toUpperCase();
  const symbol = FIAT_SYMBOLS[currency] ?? "";
  const digits = currency === "jpy" ? 0 : amount >= 0.01 || amount === 0 ? 2 : 4;
  const body = `${amount.toFixed(digits)} ${code}`;
  return symbol ? `${symbol}${body}` : body;
}

/** `$` followed by a plain decimal — no signs, no separators, no exponent. */
const USD_PRICE_RE = /^\$\d+(\.\d+)?$/;

/**
 * Smallest declarable price: one unit of {@link roundUsd}'s four-decimal
 * precision, which is what every price surface a caller reads can express.
 */
const MIN_USD_PRICE = 0.0001;
const MIN_USD_PRICE_LITERAL = '"$0.0001"';

const FIAT_SYMBOLS: Record<string, string> = {
  usd: "$",
  eur: "€",
  gbp: "£",
  jpy: "¥",
};
