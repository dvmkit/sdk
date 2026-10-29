import type { CashuConfig, ResolvedCashuConfig } from "./types";

/**
 * Shortest NUT-11 refund `locktime`, in seconds from now, that `/v1/info`
 * advertises as `cashu.min_locktime` when the builder sets no floor. Banked
 * proofs wait for the batch melt, so a refund path must stay closed for at
 * least this long.
 */
export const CASHU_MIN_LOCKTIME_SECONDS = 604_800;

/**
 * Slack subtracted from the signed floor when enforcing it. The reference
 * caller locks to `now + max(48h, min_locktime)` and re-sends an
 * unacknowledged payment for at most 24 hours, so an honest resume still
 * clears the enforced floor.
 */
export const CASHU_LOCKTIME_RESUME_MARGIN_SECONDS = 86_400;

/** Smallest unsigned floor a builder may configure. */
export const CASHU_LOCKTIME_FLOOR_MINIMUM_SECONDS = 3_600;

/**
 * Smallest signed floor a builder may configure: the resume margin plus an
 * hour, so the enforced signed floor always lies at least an hour ahead.
 */
export const CASHU_SIGNED_LOCKTIME_FLOOR_MINIMUM_SECONDS =
  CASHU_LOCKTIME_RESUME_MARGIN_SECONDS + CASHU_LOCKTIME_FLOOR_MINIMUM_SECONDS;

/** The enforced lock window for a DVM that sets no `cashu` floor. */
export const DEFAULT_CASHU_LOCK_WINDOW_SECONDS = CASHU_MIN_LOCKTIME_SECONDS - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS;

/**
 * Enforced lock window, in seconds after receipt, for a payment that may come
 * from a signed caller: the advertised `cashu.min_locktime` less the resume
 * margin.
 */
export function signedCashuLockWindowSeconds(cashu: ResolvedCashuConfig | undefined): number {
  return (cashu?.minLocktimeSeconds ?? CASHU_MIN_LOCKTIME_SECONDS) - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS;
}

/**
 * Enforced lock window for an unsigned `POST /v1/job` payment sent without
 * `X-Cashu-Request-Id`, as a NUT-24 wallet sends it. No resume margin applies:
 * such a wallet cannot read `cashu.min_locktime` first and does not resume.
 */
export function unsignedCashuLockWindowSeconds(cashu: ResolvedCashuConfig | undefined): number {
  return cashu?.unsignedMinLocktimeSeconds ?? DEFAULT_CASHU_LOCK_WINDOW_SECONDS;
}

/**
 * The shortest enforced lock window any accepted payment may carry: the
 * signed one, or the unsigned one too when this DVM serves unsigned payers.
 */
export function shortestCashuLockWindowSeconds(
  cashu: ResolvedCashuConfig | undefined,
  servesUnsigned: boolean
): number {
  const signed = signedCashuLockWindowSeconds(cashu);
  return servesUnsigned ? Math.min(signed, unsignedCashuLockWindowSeconds(cashu)) : signed;
}

/**
 * Validate a builder's `cashu` block and fill its defaults, or return
 * `undefined` when there is none, which keeps every floor at its default.
 */
export function resolveCashuConfig(cashu: CashuConfig | undefined): ResolvedCashuConfig | undefined {
  if (cashu === undefined) return undefined;
  if (typeof cashu !== "object" || cashu === null || Array.isArray(cashu)) {
    throw new Error(`configureDVM: cashu must be an object of refund-locktime floors; received ${JSON.stringify(cashu)}`);
  }
  const minLocktimeSeconds =
    validFloor(cashu.minLocktimeSeconds, "minLocktimeSeconds", CASHU_SIGNED_LOCKTIME_FLOOR_MINIMUM_SECONDS) ??
    CASHU_MIN_LOCKTIME_SECONDS;
  const unsignedMinLocktimeSeconds =
    validFloor(cashu.unsignedMinLocktimeSeconds, "unsignedMinLocktimeSeconds", CASHU_LOCKTIME_FLOOR_MINIMUM_SECONDS) ??
    minLocktimeSeconds - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS;
  // An unsigned payer picks its floor by sending X-Cashu-Request-Id or not,
  // so it always gets the shorter one: a longer unsigned floor protects nothing.
  const signedWindow = minLocktimeSeconds - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS;
  if (unsignedMinLocktimeSeconds > signedWindow) {
    throw new Error(
      `configureDVM: cashu.unsignedMinLocktimeSeconds (${unsignedMinLocktimeSeconds}) must not exceed cashu.minLocktimeSeconds less 86400 (${signedWindow}); a payer without a signature can take the signed floor instead by sending X-Cashu-Request-Id`
    );
  }
  return { minLocktimeSeconds, unsignedMinLocktimeSeconds };
}

function validFloor(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `configureDVM: cashu.${field} must be a whole number of seconds, at least ${minimum}; received ${JSON.stringify(value)}`
    );
  }
  return value;
}
