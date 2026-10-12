/**
 * Currency-code identifier used throughout the SDK's pricing surface. Validated
 * to ISO 4217-style three-letter lowercase ("usd", "eur", "jpy", …) at SDK
 * boundaries via `validateCurrency`.
 */
export type Currency = string;

/**
 * Thrown by `validateCurrency` when the input doesn't match `/^[a-z]{3}$/`.
 * Surfaced to operators as a structured error envelope; never seen by callers
 * — invalid currencies are always a developer bug in the DVM, not an agent's
 * fault.
 */
export class InvalidCurrencyError extends Error {
  readonly code = "invalid_currency";
  readonly raw: unknown;
  constructor(raw: unknown) {
    super(
      `invalid currency "${rawCurrencyDisplay(raw)}" — expected ISO 4217 lowercase (e.g. "usd")`
    );
    this.raw = raw;
  }
}

function rawCurrencyDisplay(raw: unknown): string {
  if (typeof raw === "string") return raw;
  return "(non-string)";
}

/**
 * A valid currency code that the configured FX snapshot cannot price.
 * The error message names the supported set so the builder can correct it.
 */
export class UnsupportedCurrencyError extends Error {
  readonly code = "unsupported_currency";
  constructor(
    public readonly raw: string,
    public readonly supported: readonly string[]
  ) {
    super(`fx fetcher supports [${supported.join(",")}]; got "${raw}"`);
  }
}

const CURRENCY_RE = /^[a-z]{3}$/;

/** Validate `raw` is a 3-letter lowercase ISO 4217-style currency code. */
export function validateCurrency(raw: string): Currency {
  if (typeof raw !== "string" || !CURRENCY_RE.test(raw)) {
    throw new InvalidCurrencyError(raw);
  }
  return raw;
}
