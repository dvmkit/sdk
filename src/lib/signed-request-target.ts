import { DvmError } from "./errors";
import { attestedDvmIdentity } from "./receipt-verify";
import {
  canonicalRequestPath,
  SIGNED_REQUEST_AUTH_ID,
  type SignedRequestAudience,
  type SignedRequestDomain,
} from "./signed-request-statement";
import type { ProviderInfo } from "./transport/types";

/** Resolve and verify the audience a provider advertises for v2 caller proofs. */
export function signedRequestAudience(
  provider: ProviderInfo,
  endpoint: string
): SignedRequestAudience {
  if (!provider.auth?.includes(SIGNED_REQUEST_AUTH_ID)) {
    const legacy = provider.auth?.includes("secp256k1-schnorr");
    throw new DvmError(
      legacy ? "signed_auth_upgrade_required" : "signed_auth_unsupported",
      legacy
        ? "This service still advertises the retired signed-request format."
        : "This service does not advertise audience-bound caller authentication.",
      legacy
        ? "Upgrade the service before sending this authenticated request. No payment was attempted."
        : "Use a service advertising secp256k1-schnorr-v2. No payment was attempted."
    );
  }
  const audience = provider.authAudience;
  const attested = provider.builder ? attestedDvmIdentity(provider.builder) : undefined;
  if (
    audience &&
    audience.dvm_id === attested?.dvmId &&
    audience.builder_pubkey.trim().toLowerCase() === attested.builderPubkey
  ) {
    return { dvm_id: attested.dvmId, builder_pubkey: attested.builderPubkey };
  }
  if (audience && isLoopbackEndpoint(endpoint)) return audience;
  if (process.env.NODE_ENV === "test") {
    return audience ?? { dvm_id: "__dvmkit_test_domain__", builder_pubkey: "00".repeat(32) };
  }
  throw new DvmError(
    "signed_auth_audience_invalid",
    "This service did not publish a valid attested audience for caller authentication.",
    "Do not send payment or a signed request. Ask the service operator to repair its /v1/info builder attestation."
  );
}

/** Build the exact audience/method/path/capability domain for an outgoing request. */
export function signedRequestDomain(args: {
  provider: ProviderInfo;
  endpoint: string;
  method: string;
  path: string;
  capability: string | null;
}): SignedRequestDomain {
  const url = new URL(args.path, withTrailingSlash(args.endpoint));
  return {
    audience: signedRequestAudience(args.provider, args.endpoint),
    method: args.method,
    path: canonicalRequestPath(url.href),
    capability: args.capability,
  };
}

function withTrailingSlash(endpoint: string): string {
  return endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
}

function isLoopbackEndpoint(endpoint: string): boolean {
  try {
    const host = new URL(endpoint).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
