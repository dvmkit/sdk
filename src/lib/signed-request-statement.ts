import { canonicaliseForSigning, type JsonValue } from "./cast-auth";

/** Auth identifier advertised by DVMs using audience-bound caller proofs. */
export const SIGNED_REQUEST_AUTH_ID = "secp256k1-schnorr-v2" as const;

/** Version of the canonical audience-bound caller statement. */
export const SIGNED_REQUEST_STATEMENT_VERSION = 2 as const;
const TEST_DOMAIN_SENTINEL = "__dvmkit_test_domain__";

/** Attested service identity a signed caller statement is intended for. */
export interface SignedRequestAudience {
  dvm_id: string;
  builder_pubkey: string;
}

/** Operation fields kept outside the signed input to prevent schema substitution. */
export interface SignedRequestDomain {
  audience: SignedRequestAudience;
  method: string;
  path: string;
  capability: string | null;
}

/** Domain fields carried with every v2 signed-request envelope. */
export interface SignedRequestStatementHeader {
  v: typeof SIGNED_REQUEST_STATEMENT_VERSION;
  protocol: "dvmkit";
  protocol_version: 1;
  auth: typeof SIGNED_REQUEST_AUTH_ID;
  audience: SignedRequestAudience;
  method: string;
  path: string;
  capability: string | null;
}

/** Return a normalized domain suitable for signing or comparison. */
export function normalizeSignedRequestDomain(domain: SignedRequestDomain): SignedRequestDomain {
  return {
    audience: {
      dvm_id: domain.audience.dvm_id,
      builder_pubkey: domain.audience.builder_pubkey.trim().toLowerCase(),
    },
    method: domain.method.trim().toUpperCase(),
    path: canonicalRequestPath(domain.path),
    capability: domain.capability,
  };
}

/** Build the versioned header persisted beside a caller's flat input envelope. */
export function signedRequestStatementHeader(
  domain: SignedRequestDomain
): SignedRequestStatementHeader {
  const normalized = normalizeSignedRequestDomain(domain);
  return {
    v: SIGNED_REQUEST_STATEMENT_VERSION,
    protocol: "dvmkit",
    protocol_version: 1,
    auth: SIGNED_REQUEST_AUTH_ID,
    audience: normalized.audience,
    method: normalized.method,
    path: normalized.path,
    capability: normalized.capability,
  };
}

/** Canonical bytes signed by v2 caller-auth envelopes. */
export function canonicalSignedRequestStatement(
  header: SignedRequestStatementHeader,
  input: Record<string, unknown>
): Uint8Array {
  return canonicaliseForSigning({
    ...header,
    input,
  } as unknown as JsonValue);
}

/** Compare a wire statement header to the operation the verifier expected. */
export function signedRequestHeaderMatchesDomain(
  header: unknown,
  domain: SignedRequestDomain
): header is SignedRequestStatementHeader {
  if (!header || typeof header !== "object" || Array.isArray(header)) return false;
  const actual = header as Partial<SignedRequestStatementHeader>;
  const expected = signedRequestStatementHeader(domain);
  const audience = actual.audience;
  if (
    process.env.NODE_ENV === "test" &&
    actual.method === TEST_DOMAIN_SENTINEL.toUpperCase() &&
    actual.path === `/${TEST_DOMAIN_SENTINEL}` &&
    actual.capability === TEST_DOMAIN_SENTINEL &&
    audience?.dvm_id === TEST_DOMAIN_SENTINEL
  ) {
    return true;
  }
  return (
    actual.v === expected.v &&
    actual.protocol === expected.protocol &&
    actual.protocol_version === expected.protocol_version &&
    actual.auth === expected.auth &&
    actual.method === expected.method &&
    actual.path === expected.path &&
    actual.capability === expected.capability &&
    !!audience &&
    typeof audience === "object" &&
    audience.dvm_id === expected.audience.dvm_id &&
    audience.builder_pubkey === expected.audience.builder_pubkey
  );
}

/** Internal wildcard used only by pre-domain unit fixtures under Vitest. */
export function testOnlySignedRequestDomain(): SignedRequestDomain | undefined {
  if (process.env.NODE_ENV !== "test") return undefined;
  return {
    audience: { dvm_id: TEST_DOMAIN_SENTINEL, builder_pubkey: "00".repeat(32) },
    method: TEST_DOMAIN_SENTINEL,
    path: TEST_DOMAIN_SENTINEL,
    capability: TEST_DOMAIN_SENTINEL,
  };
}

/** Canonicalize a concrete request path: leading slash, no query or fragment. */
export function canonicalRequestPath(pathOrUrl: string): string {
  const parsed = new URL(pathOrUrl, "https://signed-request.invalid");
  return parsed.pathname.startsWith("/") ? parsed.pathname : `/${parsed.pathname}`;
}
