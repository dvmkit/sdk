import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";

import { hashedCanonicalDvmId } from "./builder-subkey";

/**
 * dvmkit's BIP-32 purpose number. Arbitrary but committed — kept in lockstep
 * with `builder-subkey.ts` so any future shared module factors them together.
 */
const PURPOSE_INDEX = 1789;

/** Role index for the per-DVM agent refund subkey (`m/1789'/2'/...`). */
const AGENT_REFUND_ROLE_INDEX = 2;

/**
 * Derived per-DVM agent refund keypair. Both halves are hex; the privkey is
 * 32 bytes (64 chars), the pubkey is the 33-byte compressed secp256k1
 * encoding (66 chars starting with `02` or `03`).
 *
 * The privkey must never be persisted to disk — it is regenerated on demand
 * from the agent's mnemonic when `dvm wallet release` needs to sign refund
 * witnesses on unshipped pre-fund proofs.
 */
export interface AgentRefundKeypair {
  privkey: string;
  pubkey: string;
}

/**
 * BIP-32 derivation path for the per-DVM agent refund subkey:
 * `m/1789'/2'/hashed(canonical_dvm_id)'`.
 *
 * Per spec (§4.5), the agent's per-DVM refund subkey has **no** rotation
 * index — agents do not rotate per-DVM in v1. Per-call agent-pubkey rotation
 * is a separate v2 surface (NUT-28 P2BK / master keypair rotation).
 *
 * Exported for golden-vector testing and for `dvm wallet release`,
 * which regenerates the matching privkey on demand to sign NUT-11 refund
 * witnesses post-`t_expire`.
 */
export function agentRefundSubkeyPath(canonicalDvmId: string): string {
  const dvmIndex = hashedCanonicalDvmId(canonicalDvmId);
  return `m/${PURPOSE_INDEX}'/${AGENT_REFUND_ROLE_INDEX}'/${dvmIndex}'`;
}

/**
 * Derive the agent's per-DVM refund keypair from a BIP-39 mnemonic.
 *
 * The pubkey is attached as the NUT-11 `refund` tag on pre-fund proofs minted
 * by `dvm wallet reserve --builder <handle>` **and**, since the behavior was introduced, on every
 * per-call swap output; the privkey signs refund witnesses on the matching
 * proofs after `t_expire` (`dvm wallet release`, and the auto-reclaim in
 * `sweepPendingSubmissions`).
 *
 * Per-DVM scoping means colluding builders cannot correlate the agent's
 * identity across DVMs from refund tags alone — each DVM sees a different
 * agent pubkey. What does trade away, deliberately, is *within*-DVM
 * unlinkability: one DVM now sees the same refund pubkey on every call from
 * this agent. The operator accepted that in exchange for eliminating
 * caller-side money loss. The mnemonic + `canonical_dvm_id` is the stable
 * derivation root; nothing else needs to be persisted to recover the keypair.
 */
export function deriveAgentRefundSubkey(
  mnemonic: string,
  canonicalDvmId: string
): AgentRefundKeypair {
  const seed = mnemonicToSeedSync(mnemonic);
  const hd = HDKey.fromMasterSeed(seed);
  const child = hd.derive(agentRefundSubkeyPath(canonicalDvmId));
  if (!child.privateKey || !child.publicKey) {
    throw new Error("Failed to derive agent refund subkey from mnemonic");
  }
  return {
    privkey: Buffer.from(child.privateKey).toString("hex"),
    pubkey: Buffer.from(child.publicKey).toString("hex"),
  };
}

export function deriveAgentRefundSubkeyPubkey(mnemonic: string, canonicalDvmId: string): string {
  return deriveAgentRefundSubkey(mnemonic, canonicalDvmId).pubkey;
}
