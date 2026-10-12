import type { z } from "zod";

import type { SignedRequestError } from "./signed-request";
import { SIGNED_ENVELOPE_FIELDS } from "./signed-request";
import { humanizeZodIssues } from "./zod-error";

export interface AuthErrorBodyOpts {
  /**
   * Absolute URL of this DVM's `/v1/info`, for the schema-violation hint. The
   * route knows its own origin; the helper doesn't. Defaults to the bare path
   * when a caller can't supply one.
   */
  schemaUrl?: string;
}

/**
 * Disclose published input-schema issues, never signing-envelope details.
 * Malformed envelope issues map to signature_invalid; input issues carry
 * actionable display and hint fields. Credit, job and quote routes share this classifier.
 */
export function authErrorBody(
  err: SignedRequestError,
  opts: AuthErrorBodyOpts = {}
): Record<string, unknown> {
  const schemaUrl = opts.schemaUrl ?? "/v1/info";
  const inputIssues = err.sub_reason === "schema_invalid" ? callerInputIssues(err.issues) : [];
  if (inputIssues.length > 0) {
    const { message, hint } = humanizeZodIssues(inputIssues, { schemaUrl });
    return {
      error: "auth_error",
      sub_reason: "schema_invalid",
      display: `Request input doesn't satisfy the published schema — ${message}`,
      // The humanised hint carries the actionable fix (chunking guidance for an
      // oversized field, a pointer at the schema otherwise); the sentence after
      // it exists because the copy this replaced instructed the exact wrong
      // remedy, and an agent that re-signs verbatim burns another round trip.
      hint: `${hint} This is an input problem, not a signature one: re-signing the same payload will fail identically.`,
    };
  }

  // Envelope-side: a missing/malformed envelope, an envelope that parsed but
  // came back mistyped, or a real signature failure. One answer for all of them.
  const subReason = err.sub_reason === "schema_invalid" ? "signature_invalid" : err.sub_reason;
  const display = (() => {
    switch (subReason) {
      case "signature_invalid":
        return "Request signature didn't match the supplied pubkey";
      case "timestamp_drift":
        return "Request timestamp is outside the 5-minute drift window";
      case "replay_detected":
        return "Replay detected — same signed envelope already submitted";
      default:
        // A future `sub_reason` must still yield a string — agents are
        // intermediaries that branch on `display`, so `undefined` here would
        // be a TypeError on their side; every authentication response must
        // keep a string `display` even for a future sub-reason.
        return "Authentication failed";
    }
  })();
  return {
    error: "auth_error",
    sub_reason: subReason,
    display,
    hint: "Regenerate the request with the current timestamp + a fresh nonce; sign with secp256k1+BIP-340 Schnorr over the canonical JSON form of the input.",
  };
}

/**
 * This DVM's own `/v1/info`, absolute — the schema pointer an input-shape hint
 * carries when the offending schema is one `/v1/info` publishes.
 *
 * Lives beside {@link authErrorBody} rather than in `app.ts` because both the
 * app routes and the credit routes build this envelope, and a second copy is
 * how the two would drift. Takes the request URL rather than a Hono context so
 * the module stays free of the app's types.
 */
export function infoSchemaUrl(requestUrl: string, publicOrigin?: string): string {
  return `${publicOrigin ?? new URL(requestUrl).origin}/v1/info`;
}

/**
 * The issues that are about the caller's input rather than their signing
 * envelope — the disclosable half.
 *
 * Keyed on the **first** path segment, so a nested field named `signature`
 * under an input object is still input. An issue with an empty path is input
 * too: that's `unrecognized_keys` on a top-level `.strict()` schema, which is
 * the typo'd-field case this whole change exists to name.
 *
 * Exported because `app.ts`'s capability-input gate draws the same line one
 * step earlier: it answers the input half with a 400 and leaves a
 * failure naming only envelope fields to the auth gate below it. Two
 * definitions of "is this the caller's input or their signing?" is exactly how
 * the two gates would come to disagree.
 */
export function callerInputIssues(
  issues: readonly z.core.$ZodIssue[] | undefined
): readonly z.core.$ZodIssue[] {
  if (!issues) return [];
  return issues.filter((issue) => {
    const head = issue.path[0];
    return typeof head !== "string" || !ENVELOPE_FIELDS.has(head);
  });
}

const ENVELOPE_FIELDS: ReadonlySet<string> = new Set(SIGNED_ENVELOPE_FIELDS);
