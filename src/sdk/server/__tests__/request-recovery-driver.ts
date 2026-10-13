import { signDvmRequestData } from "../../../lib/cli-sign-request";
import { canonicalRequestPath } from "../../../lib/signed-request-statement";

/** Minimal wire fixture for server recovery tests; it owns no caller state or payment behavior. */
export interface RecoveryIntent {
  requestId: string;
  endpoint: string;
  capability: string;
  callerPubkey: string;
  authAudience: { dvm_id: string; builder_pubkey: string };
  body: { capability: string; input: string; data: Record<string, unknown> };
  policy?: unknown;
  createdAt?: number;
}

/** Exercise the production resume route with a freshly signed persisted-intent envelope. */
export async function resumeAcceptedRequest(
  intent: RecoveryIntent,
  privkey: string
): Promise<Record<string, unknown>> {
  const path = `/v1/request-resume/${intent.requestId}`;
  const data = signDvmRequestData(privkey, intent.body.data, {
    audience: intent.authAudience,
    method: "POST",
    path: canonicalRequestPath(new URL(path, intent.endpoint).href),
    capability: intent.capability,
  });
  const response = await fetch(new URL(path, intent.endpoint), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ input: intent.body.input, capability: intent.body.capability, data }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    const error = Object.assign(new Error(payload.error ?? `resume failed: ${response.status}`), {
      code: payload.code ?? payload.error,
      data: payload,
    });
    throw error;
  }
  return (await response.json()) as Record<string, unknown>;
}
