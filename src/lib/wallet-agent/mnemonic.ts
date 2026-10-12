import { createHash } from "node:crypto";

import { HDKey } from "@scure/bip32";
import {
  generateMnemonic,
  mnemonicToEntropy,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Shared BIP-32 purpose with builder lock and per-DVM refund derivation. */
export const MNEMONIC_PURPOSE_INDEX = 1789;

/** Role index for the agent master keypair (`m/1789'/1'`). */
export const AGENT_MASTER_ROLE_INDEX = 1;

/** Number of entropy bits we ask BIP-39 to encode — 128 bits ⇒ 12 words. */
const MNEMONIC_STRENGTH_BITS = 128;

/** The agent master keypair derived from a BIP-39 mnemonic. Both halves are hex. */
export interface AgentMasterKeypair {
  /** 32-byte secp256k1 private key, lowercase hex (64 chars). */
  privkey: string;
  /** 33-byte compressed secp256k1 public key, lowercase hex (66 chars). */
  pubkey: string;
}

export type MnemonicValidationResult =
  | { ok: true }
  | { ok: false; reason: "unknown_word"; badWordIndex: number; badWord: string }
  | { ok: false; reason: "wrong_length"; wordCount: number }
  | { ok: false; reason: "checksum" };

/** Agent master role 1 is distinct from builder lock role 0 and per-DVM refund role 2. */
export function agentMasterKeypairPath(): string {
  return `m/${MNEMONIC_PURPOSE_INDEX}'/${AGENT_MASTER_ROLE_INDEX}'`;
}

/** Generate a fresh 12-word BIP-39 mnemonic for a new agent wallet. */
export function generateAgentMnemonic(): string {
  return generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
}

/** The wallet signing identity at `m/1789'/1'`; persistence is handled separately. */
export function deriveAgentMasterKeypair(mnemonic: string): AgentMasterKeypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(agentMasterKeypairPath());
  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive agent master keypair from mnemonic");
  }
  return {
    privkey: Buffer.from(child.privateKey).toString("hex"),
    pubkey: Buffer.from(child.publicKey).toString("hex"),
  };
}

/**
 * Validate a candidate mnemonic and report which check failed, so the CLI can
 * point at the misspelled word slot (acceptance criterion) instead of a
 * generic "mnemonic invalid" message. Returns `{ ok: true }` on success.
 *
 * Checks in order: word count (must be 12), every word is in the English
 * BIP-39 wordlist (returns the first offender's 1-based index), and finally
 * the BIP-39 checksum. The checksum is the only failure mode `@scure/bip39`'s
 * `validateMnemonic` can report on its own.
 */
export function validateAgentMnemonic(mnemonic: string): MnemonicValidationResult {
  const words = mnemonic.trim().toLowerCase().split(/\s+/);
  if (words.length !== 12) {
    return { ok: false, reason: "wrong_length", wordCount: words.length };
  }
  for (let i = 0; i < words.length; i++) {
    if (!wordlist.includes(words[i])) {
      return { ok: false, reason: "unknown_word", badWordIndex: i + 1, badWord: words[i] };
    }
  }
  if (!validateMnemonic(words.join(" "), wordlist)) {
    return { ok: false, reason: "checksum" };
  }
  return { ok: true };
}

/**
 * Heuristic: is the input a (space-separated) mnemonic rather than a hex
 * privkey? Whitespace is the only thing we need — a 64-hex string never
 * contains whitespace. Used by `dvm wallet recover` to pick the validation
 * path; `validateAgentMnemonic` then does the strict check.
 */
export function looksLikeMnemonic(input: string): boolean {
  return /\s/.test(input.trim());
}

/**
 * Derive the wallet's `mnemonic_fingerprint` — `sha256(bip39 entropy)`
 * lowercase hex — per §4.6 of the cashu-from-first-principles design note.
 *
 * Persisted on `AgentWallet.mnemonic_fingerprint` so `getWallet` can detect
 * a mismatch between `~/.dvm/wallet.mnemonic` (the actual seed material)
 * and `~/.dvm/wallet.json` (everything else). Hashing the entropy rather
 * than the words means a normalised-whitespace re-typing produces the same
 * fingerprint as the original.
 *
 * Assumes the mnemonic is already valid — callers run
 * {@link validateAgentMnemonic} first.
 */
export function mnemonicFingerprint(mnemonic: string): string {
  const normalised = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");
  const entropy = mnemonicToEntropy(normalised, wordlist);
  return createHash("sha256").update(entropy).digest("hex");
}
