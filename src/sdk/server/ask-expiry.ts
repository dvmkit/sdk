/**
 * How long an ask (`prompt` or `payment-request`) stays answerable past its
 * advertised `content.expires_at_ms`. A payment can be in flight when the
 * deadline passes — a Cashu token is already locked to this DVM by the time it
 * arrives — so expiry waits this long before ending the job, and a payment
 * that arrives inside the window still pays the ask.
 */
export const ASK_EXPIRY_GRACE_MS = 30_000;

/** The instant an ask stamped with `expiresAtMs` expires: its deadline plus the grace. */
export function askExpiryAtMs(expiresAtMs: number): number {
  return expiresAtMs + ASK_EXPIRY_GRACE_MS;
}

/** True once an ask stamped with `expiresAtMs` can no longer be paid or answered. */
export function askExpired(expiresAtMs: number | undefined, nowMs: number): boolean {
  return expiresAtMs !== undefined && Number.isSafeInteger(expiresAtMs) && nowMs >= askExpiryAtMs(expiresAtMs);
}
