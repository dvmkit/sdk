import { createHash } from "node:crypto";

import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

/**
 * dvmkit's BIP-32 purpose number. Arbitrary but committed — picked so paths
 * sort distinctly from BIP-44/49/84 in mnemonic-scanning tools.
 */
const PURPOSE_INDEX = 1789;

/** Role index for builder lock subkeys (`m/1789'/0'/...`). */
const BUILDER_ROLE_INDEX = 0;

/**
 * Derived per-DVM builder lock keypair. Both halves are hex; the privkey is 32
 * bytes (64 chars), the pubkey is the 33-byte compressed secp256k1 encoding
 * (66 chars starting with `02` or `03`).
 */
export interface BuilderLockKeypair {
  privkey: string;
  pubkey: string;
}

/**
 * Compute the BIP-32 child index for a canonical DVM id, per the spec
 * (`§"BIP-32 derivation"`):
 *
 * `(sha256(canonical_dvm_id)[0..4] as u32_be) & 0x7FFFFFFF`
 *
 * The high bit is masked off so the result is a valid hardened-child index
 * once BIP-32 sets `0x80000000` at derivation time. Input is hashed as UTF-8
 * bytes, so any string form of the canonical_id (numeric, UUIDv4) hashes
 * the same way on every CLI.
 */
export function hashedCanonicalDvmId(canonicalDvmId: string): number {
  const digest = createHash("sha256").update(canonicalDvmId, "utf8").digest();
  const u32 = digest.readUInt32BE(0);
  return u32 & 0x7fffffff;
}

/**
 * BIP-32 derivation path for the per-DVM builder lock subkey at a given
 * rotation index: `m/1789'/0'/hashed(canonical_dvm_id)'/<rotation_index>'`.
 *
 * Exported for golden-vector testing and for `dvmctl melt-pending`,
 * which derives matching privkeys for proofs locked under historical rotation
 * indices in the grace window.
 */
export function builderLockPath(canonicalDvmId: string, rotationIndex: number): string {
  if (!Number.isInteger(rotationIndex) || rotationIndex < 0 || rotationIndex > 0x7fffffff) {
    throw new Error(
      `rotation_index out of range: ${rotationIndex} (must be a non-negative 31-bit integer)`
    );
  }
  const dvmIndex = hashedCanonicalDvmId(canonicalDvmId);
  return `m/${PURPOSE_INDEX}'/${BUILDER_ROLE_INDEX}'/${dvmIndex}'/${rotationIndex}'`;
}

/**
 * Derive the builder's per-DVM lock keypair from a BIP-39 mnemonic.
 *
 * The privkey must never leave the builder's machine — only the pubkey is
 * sent to the platform or advertised on `/v1/info`. The mnemonic plus
 * `(canonicalDvmId, rotationIndex)` is sufficient to re-derive any past key,
 * which is what makes rotation work without dead capital.
 */
export function deriveBuilderLockKeypair(
  mnemonic: string,
  canonicalDvmId: string,
  rotationIndex: number
): BuilderLockKeypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(builderLockPath(canonicalDvmId, rotationIndex));
  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive builder lock keypair from mnemonic");
  }
  return {
    privkey: Buffer.from(child.privateKey).toString("hex"),
    pubkey: Buffer.from(child.publicKey).toString("hex"),
  };
}

export function deriveBuilderLockPubkey(
  mnemonic: string,
  canonicalDvmId: string,
  rotationIndex: number
): string {
  return deriveBuilderLockKeypair(mnemonic, canonicalDvmId, rotationIndex).pubkey;
}
