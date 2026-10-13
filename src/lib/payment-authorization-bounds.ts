/** Maximum lifetime of an exact x402 EIP-3009 authorization after signing. */
export const X402_EXACT_AUTHORIZATION_TTL_SECONDS = 600;

/** Maximum post-intent Base window scanned before proving an exact x402 transfer absent. */
export const X402_REFUSAL_TRANSACTION_DISCOVERY_WINDOW_MS = 15 * 60_000;
