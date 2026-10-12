import { DvmError } from "../errors";
import type { MppxChallenge, MppxCredential } from "../messages/types";

/**
 * The USD micro-units a Tempo challenge names. mppx transforms the DVM's
 * decimal amount into atomic units when it issues the challenge
 * (`parseUnits(amount, decimals)`), and Tempo's settlement token carries 6
 * decimals, so the wire figure is already micro-USD.
 *
 * Throws `DvmError("tempo_amount_invalid", ...)` on anything that isn't a
 * positive integer — the x402 twin of `x402_amount_invalid`.
 */
export function tempoChallengeAmountMicro(challenge: MppxChallenge): bigint {
  const advertised = (challenge.request as { amount?: unknown } | undefined)?.amount;
  if (typeof advertised !== "string" || !/^[1-9]\d*$/.test(advertised)) {
    throw new DvmError(
      "tempo_amount_invalid",
      `The DVM advertised an invalid Tempo charge amount: '${String(advertised)}'.`,
      "Do not pay this. Ask the DVM operator to return a positive integer number of USDC micro-units."
    );
  }
  return BigInt(advertised);
}

/**
 * The figure a credential actually authorizes, read back off its own bound
 * challenge. The ledger books this rather than the caller's ask — the two are
 * allowed to differ by the advertised tolerance the caller enforces, and
 * booking the ask under-reports the spend by exactly that gap.
 */
export function tempoCredentialAmountMicro(credential: MppxCredential): bigint {
  return tempoChallengeAmountMicro(credential.challenge as MppxChallenge);
}

/**
 * How long past signing an mppx Tempo charge credential can still settle —
 * mppx's own client-side `validBefore` offset, mirrored here.
 *
 * `tempo.charge().createCredential` signs a Tempo transaction with
 * `nonceKey: "expiring"` and `validBefore = min(now + 25s, challenge.expires)`,
 * so the resulting credential is un-includable a few seconds after it
 * exists. That is two orders of magnitude shorter than x402's ten-minute
 * `exact` authorization, and it is the number every consumer of a *journalled*
 * credential has to reason against: past it, re-presenting the signature buys
 * nothing and the funding has to be signed afresh.
 *
 * A mirror rather than a read, because mppx exposes the deadline nowhere on the
 * serialized credential — the only alternative is decoding the signed Tempo
 * transaction. If mppx moves the offset this constant drifts, which is why
 * every consumer treats it as a *ceiling* on usefulness rather than a promise:
 * re-presenting a credential that has in fact expired is refused by the rail,
 * never double-settled.
 */
export const TEMPO_CHARGE_CREDENTIAL_TTL_SECONDS = 25;

/**
 * Unix seconds after which a Tempo charge credential can no longer settle,
 * reproducing mppx's own `min(signedAt + TTL, challenge.expires)`. `undefined`
 * when the challenge carries an unreadable `expires` — naming a deadline the
 * signature does not have is worse than naming none.
 */
export function tempoCredentialValidBefore(
  credential: MppxCredential,
  signedAtMs: number
): number | undefined {
  const ttlDeadline = Math.floor(signedAtMs / 1000) + TEMPO_CHARGE_CREDENTIAL_TTL_SECONDS;
  const expires = (credential.challenge as { expires?: unknown }).expires;
  if (expires === undefined) return ttlDeadline;
  if (typeof expires !== "string") return undefined;
  const challengeDeadline = Math.floor(new Date(expires).getTime() / 1000);
  if (!Number.isFinite(challengeDeadline)) return undefined;
  return Math.min(ttlDeadline, challengeDeadline);
}
