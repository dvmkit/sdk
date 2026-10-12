import { schnorr } from "@noble/curves/secp256k1.js";

import { canonicaliseForSigning, type JsonValue } from "./canonical-json";

/**
 * BIP-340 verification over canonical JSON, with a 32-byte x-only public key
 * and a 64-byte signature, both hex-encoded. Bad wire encoding or failed crypto
 * verification returns false; unsupported payload serialization can throw.
 */
export function verifyCanonicalSignedRequest(
  payload: JsonValue,
  signatureHex: string,
  pubkeyHex: string
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(pubkeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) {
    return false;
  }
  const data = canonicaliseForSigning(payload);
  const signature = hexToBytes(signatureHex);
  const pubkey = hexToBytes(pubkeyHex);
  try {
    return schnorr.verify(signature, data, pubkey);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
