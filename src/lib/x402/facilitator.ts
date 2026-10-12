import { createPrivateKey, randomBytes } from "node:crypto";

import { type FacilitatorConfig, HTTPFacilitatorClient } from "@x402/core/server";
import { importJWK, importPKCS8, type JWK, SignJWT } from "jose";

import { X402_DEFAULT_FACILITATOR } from "./constants";
import type { X402Config } from "./types";

const AUTH_HEADER_TTL_MS = 60_000;
const AUTH_TOKEN_TTL_SECONDS = 120;
const FACILITATOR_PATHS = {
  verify: "POST",
  settle: "POST",
  supported: "GET",
} as const;

type FacilitatorAuthHeaders = Awaited<
  ReturnType<NonNullable<FacilitatorConfig["createAuthHeaders"]>>
>;

/**
 * Build the upstream path-keyed auth callback for a configured facilitator.
 * CDP JWTs bind the method, host, and full facilitator path, so one token
 * cannot be replayed against another operation.
 */
export function createX402FacilitatorAuthHeaders(
  config: Pick<X402Config, "facilitator" | "facilitatorAuth">
): FacilitatorConfig["createAuthHeaders"] | undefined {
  const auth = config.facilitatorAuth;
  if (!auth) return undefined;

  const facilitator = new URL(config.facilitator ?? X402_DEFAULT_FACILITATOR);
  const basePath = facilitator.pathname.replace(/\/+$/, "");
  let cached: { headers: FacilitatorAuthHeaders; refreshAtMs: number } | undefined;

  return async () => {
    const nowMs = Date.now();
    if (cached && nowMs < cached.refreshAtMs) return cached.headers;

    const entries = await Promise.all(
      Object.entries(FACILITATOR_PATHS).map(async ([path, method]) => {
        const requestPath = `${basePath}/${path}`;
        const jwt = await generateCdpJwt(
          auth.keyId,
          auth.keySecret,
          `${method} ${facilitator.host}${requestPath}`
        );
        return [path, { Authorization: `Bearer ${jwt}` }] as const;
      })
    );
    const headers = Object.fromEntries(entries) as FacilitatorAuthHeaders;
    cached = { headers, refreshAtMs: nowMs + AUTH_HEADER_TTL_MS };
    return headers;
  };
}

export function createX402FacilitatorClient(
  config: Pick<X402Config, "facilitator" | "facilitatorAuth">,
  opts: { timeoutMs?: number } = {}
): HTTPFacilitatorClient {
  return new HTTPFacilitatorClient({
    url: config.facilitator ?? X402_DEFAULT_FACILITATOR,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(config.facilitatorAuth
      ? { createAuthHeaders: createX402FacilitatorAuthHeaders(config) }
      : {}),
  });
}

async function generateCdpJwt(keyId: string, keySecret: string, uri: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const claims = { sub: keyId, iss: "cdp", uris: [uri] };

  try {
    const ecKey = await importPKCS8(normalizeEs256KeySecret(keySecret), "ES256");
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256", kid: keyId, typ: "JWT", nonce })
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + AUTH_TOKEN_TTL_SECONDS)
      .sign(ecKey);
  } catch {
    // CDP's other secret format is 64 base64 bytes: Ed25519 seed + public key.
  }

  const decoded = Buffer.from(keySecret, "base64");
  if (decoded.length !== 64) {
    throw new Error("Invalid CDP key secret: expected an ES256 PEM or base64 Ed25519 key");
  }
  const jwk: JWK = {
    kty: "OKP",
    crv: "Ed25519",
    d: decoded.subarray(0, 32).toString("base64url"),
    x: decoded.subarray(32).toString("base64url"),
  };
  const edKey = await importJWK(jwk, "EdDSA");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: keyId, typ: "JWT", nonce })
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + AUTH_TOKEN_TTL_SECONDS)
    .sign(edKey);
}

function normalizeEs256KeySecret(keySecret: string): string {
  if (!keySecret.includes("-----BEGIN EC PRIVATE KEY-----")) return keySecret;
  return createPrivateKey(keySecret).export({ format: "pem", type: "pkcs8" });
}
