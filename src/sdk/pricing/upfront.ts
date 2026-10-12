import { type Currency, validateCurrency } from "./currency";

/**
 * Upfront fiat commitment converted to sats at settlement time. This is the
 * total cost for fixed-price jobs; two-phase jobs may request more mid-job
 * through `ctx.requestPayment`.
 */
export interface Upfront {
  amount: number;
  currency: Currency;
}

/**
 * Build a validated `Upfront` literal. Throws `InvalidCurrencyError` when
 * `currency` doesn't match `/^[a-z]{3}$/`, and a plain `Error` when `amount`
 * is non-finite or negative. Operators should call this at the boundary of
 * their `onQuote` handler so a malformed envelope can't escape to the wire.
 */
export function buildUpfront(input: { amount: number; currency: string }): Upfront {
  const currency = validateCurrency(input.currency);
  const amount = input.amount;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`invalid upfront amount: ${String(amount)} (must be a non-negative number)`);
  }
  return { amount, currency };
}
