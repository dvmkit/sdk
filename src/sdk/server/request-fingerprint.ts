import { createHash } from "node:crypto";

import { canonicalize, type JsonValue } from "../../lib/cast-auth/canonical-json";

/** The `POST /v1/job` body fields that identify *which* call the caller is making. */
export interface FingerprintableRequest {
  capability: string;
  input?: string;
  params?: Record<string, string>;
  data?: unknown;
}

/**
 * Stable fingerprint of a job submission. Two `POST /v1/job` calls
 * fingerprint the same iff they ask the DVM to do the same work.
 *
 * This is the proof-of-origin gate on the idempotent-replay path: a caller
 * whose paid submit timed out gets the original job back only by reproducing
 * the request it paid for. Holding the (already-spent) Cashu token alone is
 * not enough — the token is a bearer secret, and handing `job_id` +
 * `job_token` to whoever presents it would give the job away.
 *
 * Auth-envelope fields are stripped when the descriptor declares an auth
 * scheme, because the resume sweep **re-signs on every attempt**
 * (`signRequestData` in `recovery-submissions.ts`) — the DVM rejects a stale
 * timestamp before it ever looks at the payment, so a frozen envelope could
 * only 401. Fingerprinting the raw body would therefore never match on a
 * signed DVM. The caller's `pubkey` is pinned separately (persisted on the
 * job record and compared on replay), so stripping it here loses nothing.
 */
export function requestFingerprint(
  req: FingerprintableRequest,
  opts: { stripAuthEnvelope: boolean }
): string {
  const canonical = canonicalize({
    capability: req.capability,
    input: req.input ?? "",
    params: (req.params ?? {}) as JsonValue,
    data: (opts.stripAuthEnvelope ? stripEnvelope(req.data) : req.data) as JsonValue,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The signed-request envelope keys a signer adds to `body.data` — every one of
 * them is re-minted on each resume attempt, and `auth_statement` names that
 * attempt's concrete route, so none can be part of the work fingerprint.
 */
const ENVELOPE_KEYS = new Set(["pubkey", "signature", "timestamp", "nonce", "auth_statement"]);

function stripEnvelope(data: unknown): unknown {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (ENVELOPE_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}
