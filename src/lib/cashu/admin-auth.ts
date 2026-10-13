import { randomBytes } from "node:crypto";

import { sha256 } from "@noble/hashes/sha2.js";

import { signChallenge } from "../wallet-agent/sign";

/**
 * 5-minute sliding nonce-replay window — aligned with NUT-19 cache TTLs.
 * Re-exported from `src/sdk/server/admin-cashu.ts` for callers that don't
 * import the SDK route module.
 */
export const ADMIN_AUTH_NONCE_TTL_SECONDS = 300;

/** 30-second clock-skew tolerance enforced on `unix_seconds`. */
export const ADMIN_AUTH_CLOCK_SKEW_SECONDS = 30;

/** Stable response code for unavailable database-backed admin signer state. */
export const ADMIN_STATE_UNAVAILABLE = "admin_state_unavailable";

/**
 * Build the canonical 32-byte challenge that an `Authorization: P2PK …`
 * admin header is signed over. Bind `method || path || dvm_id` so a `GET`
 * signature can't be replayed against a `POST`. Pure function — shared by
 * the SDK admin verifier (`src/sdk/server/admin-cashu.ts`) and the CLI
 * client (`src/lib/admin-cashu-client.ts`).
 */
export function buildAdminChallenge(args: {
  method: string;
  path: string;
  dvmId: string;
  nonceHex: string;
  unixSeconds: number | string;
}): Uint8Array {
  const msg = `dvmkit-admin:${args.method}:${args.path}:${args.dvmId}:${args.nonceHex}:${args.unixSeconds}`;
  return sha256(new TextEncoder().encode(msg));
}

export interface AdminAuthHeader {
  header: string;
  /** 16-byte hex nonce — exposed so callers/tests can introspect it. */
  nonceHex: string;
  /** Request timestamp in unix seconds — exposed for the same reason. */
  unixSeconds: number;
}

/**
 * Build a signed `Authorization: P2PK <nonce>.<unix>.<sig>` header for a
 * dvmkit admin request. The CLI calls this once per request; the
 * `nonceHex` + `unixSeconds` are returned so tests can replay them through
 * `buildAdminChallenge` to verify the signed payload.
 *
 * The privkey must be the per-DVM lock privkey derived via
 * `deriveBuilderLockKeypair` — the same key the DVM advertises on
 * `/v1/info.cashu.lock_pubkeys[0]`.
 */
export function buildAdminAuthHeader(args: {
  method: string;
  path: string;
  dvmId: string;
  privkeyHex: string;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — defaults to `crypto.randomBytes(16)`. */
  randomNonce?: () => Uint8Array;
}): AdminAuthHeader {
  const nowMs = args.now ? args.now() : Date.now();
  const unixSeconds = Math.floor(nowMs / 1000);
  const nonceBytes = args.randomNonce ? args.randomNonce() : Uint8Array.from(randomBytes(16));
  const nonceHex = Buffer.from(nonceBytes).toString("hex");
  const challenge = buildAdminChallenge({
    method: args.method,
    path: args.path,
    dvmId: args.dvmId,
    nonceHex,
    unixSeconds,
  });
  const sigHex = signChallenge(args.privkeyHex, challenge);
  return {
    header: `P2PK ${nonceHex}.${unixSeconds}.${sigHex}`,
    nonceHex,
    unixSeconds,
  };
}
