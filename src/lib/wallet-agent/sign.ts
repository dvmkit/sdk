import { schnorr } from "@noble/curves/secp256k1.js";

import { DvmError } from "../errors";
import { PRIVKEY_HEX_RE } from "./keypair";

const PUBKEY_COMPRESSED_HEX_RE = /^0[23][0-9a-f]{64}$/i;
const PUBKEY_XONLY_HEX_RE = /^[0-9a-f]{64}$/i;
const SIG_HEX_RE = /^[0-9a-f]{128}$/i;

/**
 * Returns a BIP-340 signature as lowercase hex (64 bytes, 128 characters).
 * Omitting auxRand gives each signature fresh randomness; verification remains deterministic.
 */
export function signChallenge(privkeyHex: string, challenge: Uint8Array): string {
  if (!PRIVKEY_HEX_RE.test(privkeyHex)) {
    throw new DvmError(
      "invalid_privkey",
      "Privkey must be 64 hex characters (32 bytes).",
      "Provide a valid secp256k1 private key as a 64-char hex string."
    );
  }
  if (challenge.length !== 32) {
    throw new DvmError(
      "invalid_challenge",
      `Challenge must be exactly 32 bytes; got ${challenge.length}.`,
      "Pass the SHA-256 digest output (32 bytes)."
    );
  }
  const sig = schnorr.sign(challenge, hexToBytes(privkeyHex));
  return bytesToHex(sig);
}

/** BIP-340 verification accepts compressed or x-only public keys; compressed parity bytes are dropped. */
export function verifyChallenge(pubkeyHex: string, challenge: Uint8Array, sigHex: string): boolean {
  if (!SIG_HEX_RE.test(sigHex)) return false;
  if (challenge.length !== 32) return false;

  let xonly: Uint8Array;
  if (PUBKEY_COMPRESSED_HEX_RE.test(pubkeyHex)) {
    xonly = hexToBytes(pubkeyHex.slice(2));
  } else if (PUBKEY_XONLY_HEX_RE.test(pubkeyHex)) {
    xonly = hexToBytes(pubkeyHex);
  } else {
    return false;
  }

  try {
    return schnorr.verify(hexToBytes(sigHex), challenge, xonly);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
