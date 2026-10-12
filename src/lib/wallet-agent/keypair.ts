import { secp256k1 } from "@noble/curves/secp256k1.js";

import { DvmError } from "../errors";

export interface AgentKeypair {
  /** 32-byte secp256k1 private key, lowercase hex (64 chars). */
  privkey: string;
  /** 33-byte compressed secp256k1 public key, lowercase hex (66 chars, prefix `02`/`03`). */
  pubkey: string;
}

export const PRIVKEY_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * Generate a fresh secp256k1 keypair for the agent wallet.
 *
 * Privkey is 32 random bytes drawn from the OS CSPRNG via `@noble/curves`.
 * Pubkey is the compressed 33-byte form (matches NUT-11 P2PK and what
 * cashu-ts's `asP2PK({ pubkey })` accepts).
 */
export function generateAgentKeypair(): AgentKeypair {
  const { secretKey, publicKey } = secp256k1.keygen();
  return {
    privkey: bytesToHex(secretKey),
    pubkey: bytesToHex(publicKey),
  };
}

/**
 * Derive the compressed secp256k1 public key from a hex-encoded private key.
 * Throws `DvmError("invalid_privkey", ...)` on malformed input or scalars
 * outside the curve order (zero / >= n).
 */
export function derivePubkeyFromPrivkey(privkey: string): string {
  if (!PRIVKEY_HEX_RE.test(privkey)) {
    throw new DvmError(
      "invalid_privkey",
      "Privkey must be 64 hex characters (32 bytes).",
      "Provide a valid secp256k1 private key as a 64-char hex string."
    );
  }
  const bytes = hexToBytes(privkey);
  if (!secp256k1.utils.isValidSecretKey(bytes)) {
    throw new DvmError(
      "invalid_privkey",
      "Privkey is not a valid secp256k1 scalar (zero or out of curve order).",
      "Generate a fresh key with: dvm wallet init"
    );
  }
  const pub = secp256k1.getPublicKey(bytes);
  return bytesToHex(pub);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
