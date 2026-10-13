import { schnorr } from "@noble/curves/secp256k1.js";

import { canonicaliseForSigning, type JsonValue } from "./cast-auth";
import {
  canonicalSignedRequestStatement,
  type SignedRequestDomain,
  type SignedRequestStatementHeader,
  signedRequestStatementHeader,
} from "./signed-request-statement";

/**
 * Envelope fields the CLI signer adds around the caller's request body
 * Matches the shape `createSignedRequestVerifier.signRequest`
 * produces so any descriptor-auth DVM verifying with the SDK accepts the
 * envelope.
 */
export interface SignedRequestEnvelope {
  /** Signer's BIP-340 x-only pubkey, lowercase hex (64 chars). */
  pubkey: string;
  /** Unix-seconds when the envelope was signed. */
  timestamp: number;
  /** Per-call replay nonce (URL-safe base64). */
  nonce: string;
  /** BIP-340 Schnorr signature over `canonicaliseForSigning({pubkey, timestamp, nonce, ...body})`, hex. */
  signature: string;
}

/** Audience and operation header carried by v2 DVM caller proofs. */
export interface DomainBoundSignedRequestEnvelope extends SignedRequestEnvelope {
  auth_statement: SignedRequestStatementHeader;
}

export interface SignRequestDataOpts {
  /** Defaults to `Math.floor(Date.now() / 1000)`. */
  timestamp?: number;
  /** Defaults to a fresh 12-byte URL-safe base64 string. */
  nonce?: string;
}

/**
 * Build a signed request envelope from `body` and a 32-byte secp256k1
 * private key (lowercase hex). Returns `{ pubkey, timestamp, nonce,
 * signature, ...body }` ready to ship as the `/v1/job` or `/v1/quote` body.
 *
 * The canonical bytes the signature covers are produced by
 * {@link canonicaliseForSigning} over the unsigned object — the same
 * canonicalisation the SDK's `createSignedRequestVerifier` uses, so a DVM
 * built with the SDK verifies CLI-signed envelopes without further wiring.
 */
export function signRequestData(
  privkeyHex: string,
  body: Record<string, unknown>,
  opts: SignRequestDataOpts = {}
): Record<string, unknown> & SignedRequestEnvelope {
  const privkey = hexToBytes(privkeyHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(privkey));
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomNonce();

  const unsigned: Record<string, unknown> = {
    pubkey,
    timestamp,
    nonce,
    ...body,
  };
  const signature = bytesToHex(
    schnorr.sign(canonicaliseForSigning(unsigned as JsonValue), privkey)
  );
  return { ...unsigned, signature } as Record<string, unknown> & SignedRequestEnvelope;
}

/** Sign a DVM protocol request under the audience-bound v2 statement. */
export function signDvmRequestData(
  privkeyHex: string,
  body: Record<string, unknown>,
  domain: SignedRequestDomain,
  opts: SignRequestDataOpts = {}
): Record<string, unknown> & DomainBoundSignedRequestEnvelope {
  const privkey = hexToBytes(privkeyHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(privkey));
  const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? randomNonce();
  const authStatement = signedRequestStatementHeader(domain);
  const input: Record<string, unknown> = { pubkey, timestamp, nonce, ...body };
  const signature = bytesToHex(
    schnorr.sign(canonicalSignedRequestStatement(authStatement, input), privkey)
  );
  return { ...input, auth_statement: authStatement, signature } as Record<string, unknown> &
    DomainBoundSignedRequestEnvelope;
}

/**
 * Inverse of {@link signRequestData}: split a signed wire body back into the
 * caller's body and the pubkey it was signed with. Returns `null` when `body`
 * doesn't carry a complete envelope.
 *
 * A signature is only valid for ~5 minutes (`createSignedRequestVerifier`
 * rejects on timestamp drift, default 300s), so anything that has to re-send a
 * request later must persist the unsigned body and re-sign at send time.
 */
export function unsignRequestData(
  body: Record<string, unknown> | undefined
): { body: Record<string, unknown>; pubkey: string } | null {
  if (!body) return null;
  const { pubkey, timestamp, nonce, signature, auth_statement: _authStatement, ...rest } = body;
  if (
    typeof pubkey !== "string" ||
    typeof timestamp !== "number" ||
    typeof nonce !== "string" ||
    typeof signature !== "string"
  ) {
    return null;
  }
  return { body: rest, pubkey };
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function randomNonce(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
