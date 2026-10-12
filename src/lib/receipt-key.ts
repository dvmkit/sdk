import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface ReceiptKeypair {
  /** secp256k1 BIP-340 x-only pubkey, 32 bytes hex (64 chars). */
  pubkey: string;
  /** secp256k1 secret, 32 bytes hex (64 chars). */
  secret: string;
}

/** HKDF salt. Domain-separates receipt-key derivation from every other use of the builder secret. */
const RECEIPT_KDF_SALT = "dvmkit/receipt/v1";

/**
 * Derive a DVM's receipt-signing secret from the builder identity secret
 *
 * The builder identity key is cold — it never leaves `~/.dvmkit/builder.key`
 * but a deployed DVM has to sign receipts at runtime, so *something* keyed
 * to the builder has to reach the container. This derives that something with
 * HKDF-SHA256 under a per-DVM `info` tag, so:
 *
 * - it is **one-way**: HKDF-Extract is `HMAC-SHA256(salt, ikm)`, so a leaked
 * `DVMKIT_RECEIPT_KEY` (which lives in the deployed env, readable by
 * anyone who can read Fly secrets) does not reveal the builder secret;
 * - it is **per-DVM**: compromising one DVM's receipt key says nothing about
 * any sibling DVM's;
 * - it is **stateless**: no new secret file to back up, and the same DVM ID
 * re-derives the same key from any machine holding the builder identity,
 * so redeploying doesn't silently rotate the key that older receipts
 * chain to.
 *
 * The key rotates only when the builder identity rotates — which already
 * forces a redeploy to refresh every DVM's attestation.
 *
 * HKDF output is uniform over 32 bytes, so it can in principle land outside
 * the secp256k1 scalar range (probability ~2^-128). We re-derive with a
 * counter suffix rather than clamping, keeping every derived key a uniform
 * draw from the valid range.
 */
export function deriveReceiptSecret(builderSecretHex: string, dvmId: string): string {
  const ikm = hexToBytes(builderSecretHex);
  const salt = new TextEncoder().encode(RECEIPT_KDF_SALT);
  for (let counter = 0; counter < 256; counter++) {
    const info = new TextEncoder().encode(
      counter === 0
        ? `${RECEIPT_KDF_SALT}/${dvmId}`
        : `${RECEIPT_KDF_SALT}/${dvmId}#${String(counter)}`
    );
    const candidate = hkdf(sha256, ikm, salt, info, 32);
    if (secp256k1.utils.isValidSecretKey(candidate)) return bytesToHex(candidate);
  }
  // Unreachable short of a broken HKDF: 256 consecutive invalid draws is a
  // ~2^-32768 event. Throwing beats returning an invalid key silently.
  throw new Error(`deriveReceiptSecret: no valid secp256k1 scalar for DVM ID "${dvmId}"`);
}

export function receiptPubkeyFromSecret(secretHex: string): string {
  return bytesToHex(schnorr.getPublicKey(hexToBytes(secretHex)));
}

/** The pubkey is advertised in the attestation; only the secret reaches the deployed environment. */
export function deriveReceiptKeypair(builderSecretHex: string, dvmId: string): ReceiptKeypair {
  const secret = deriveReceiptSecret(builderSecretHex, dvmId);
  return { secret, pubkey: receiptPubkeyFromSecret(secret) };
}

/**
 * Mint a throwaway receipt keypair for a dev-mode boot (`dvmctl dev`,
 * `serve({ devMode: true })`). Receipts still sign and verify locally, but
 * nothing attests the pubkey — consumers see `receipts: true` with no
 * `/v1/info#builder` block and treat them as verifiable-but-unattested.
 * Never used outside dev mode: replicas would each sign under a different key.
 */
export function generateEphemeralReceiptKey(): ReceiptKeypair {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secret: bytesToHex(secretKey), pubkey: bytesToHex(publicKey) };
}
