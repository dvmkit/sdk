import { createHash } from "node:crypto";

import { canonicaliseForSigning, type JsonValue } from "../cast-auth";
import type { JobPolicy } from "../submission-policy";
import type { PendingSubmissionContext } from "./store";

/** Public, credential-free fields that bind one strict Cashu submission to its exact request. */
export interface CashuSubmissionBinding {
  /** Immutable DVM identity resolved from the live descriptor. */
  dvmId: string;
  capability: string;
  /** Exact unsigned `/v1/job` payload persisted for same-request recovery. */
  requestBody: Record<string, unknown>;
  /** Exact mint selected for the swap. */
  mint: string;
  /** Caller signing pubkey, or null for an anonymous request. */
  signer: string | null;
  /** Exact job policy approved by the caller. */
  policy: JobPolicy;
}

/** SHA-256 over canonical JSON for one exact strict Cashu submission binding. */
export function cashuSubmissionBindingFingerprint(binding: CashuSubmissionBinding): string {
  return createHash("sha256")
    .update(canonicaliseForSigning(binding as unknown as JsonValue))
    .digest("hex");
}

export function cashuSubmissionBindingFromContext(
  context: PendingSubmissionContext
): CashuSubmissionBinding | null {
  if (
    context.strict_per_call !== true ||
    context.route === "credit" ||
    typeof context.dvm_id !== "string" ||
    context.dvm_id.length === 0 ||
    typeof context.capability !== "string" ||
    context.capability.length === 0 ||
    typeof context.pinned_mint !== "string" ||
    context.pinned_mint.length === 0 ||
    !context.policy
  ) {
    return null;
  }
  return {
    dvmId: context.dvm_id,
    capability: context.capability,
    requestBody: context.submit_body,
    mint: context.pinned_mint,
    signer: context.signing_pubkey ?? null,
    policy: context.policy,
  };
}
