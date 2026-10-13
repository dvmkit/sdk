
export type StablecoinCreditInstrument =
  | "tempo_charge"
  | "tempo_session"
  | "x402_exact"
  | "x402_batch_settlement";

/**
 * Whether a stablecoin instrument may fund prepaid credit under the builder's
 * policy. Reusable channels are always admitted; one-payment instruments need
 * an explicit literal `true`, so absent, malformed, and older config fails
 * closed without changing per-call payment handling.
 */
export function stablecoinCreditInstrumentAllowed(
  allowOneShotStablecoin: unknown,
  instrument: StablecoinCreditInstrument
): boolean {
  if (instrument === "tempo_session" || instrument === "x402_batch_settlement") return true;
  return allowOneShotStablecoin === true;
}
