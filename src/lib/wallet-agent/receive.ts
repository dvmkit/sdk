
import type { Wallet } from "@cashu/cashu-ts";
import { Amount, getP2PKExpectedWitnessPubkeys, getTokenMetadata } from "@cashu/cashu-ts";

import { toLockPubkey } from "../cashu/lock-pubkey";
import { getWallet } from "../cashu/wallet";
import { DvmError } from "../errors";
import { toAgentProof } from "./proof";
import { loadAgentWallet, saveAgentWallet, withWalletLock } from "./store";

export interface ReceiveResult {
  mintUrl: string;
  /** Total sats claimed into spendable balance. */
  claimedSats: number;
  proofCount: number;
}

export interface ReceiveOptions {
  /** Override `getWallet` for tests. */
  getWalletForMint?: (mintUrl: string) => Promise<Wallet>;
  now?: () => number;
}

/**
 * Claim `token` into the agent wallet, re-locking the proofs to the wallet's
 * own `lock_pubkey` so future spends use the wallet's master key. Plain or
 * unlocked inputs, and expired locks without a refund path, pass the
 * preflight; any P2PK input with an expected witness, including an expired
 * lock with a refund path, must list the master pubkey. Adds the token's mint
 * to `wallet.mints` if absent. Throws
 * `cashu_not_claimable` for a token locked to a third party (no silent loss —
 * the original proofs stay intact at the mint).
 *
 * Scope: this path matches **only** against the agent's master `lock_pubkey`.
 * Per-DVM refund-tag tokens (NUT-11 `refund` tag = the agent's per-DVM refund
 * subkey, derived under `m/1789'/2'/hashed(canonical_dvm_id)'` — see
 * `src/lib/cashu/agent-refund-subkey.ts`) intentionally aren't claimable here
 * — their refund pubkey is a different curve point per DVM. Use
 * `dvm wallet release` instead, which carries the canonical DVM id and can
 * derive the matching refund privkey on demand.
 */
export async function receiveToAgentWallet(
  token: string,
  opts: ReceiveOptions = {}
): Promise<ReceiveResult> {
  const initial = loadAgentWallet();
  if (!initial) {
    throw new DvmError(
      "wallet_missing",
      "No agent wallet found.",
      "Run `dvm wallet init` first to generate a lock keypair."
    );
  }

  let mintUrl: string;
  try {
    mintUrl = getTokenMetadata(token).mint;
  } catch {
    throw new DvmError(
      "invalid_token",
      "Could not decode the Cashu token.",
      "Pass a complete `cashu...` token string."
    );
  }

  const cashuWallet = await (opts.getWalletForMint ?? getWallet)(mintUrl);

  const ours = toLockPubkey(initial.lock_pubkey);
  for (const p of cashuWallet.decodeToken(token).proofs) {
    let allowed: string[];
    try {
      allowed = getP2PKExpectedWitnessPubkeys(p.secret);
    } catch {
      continue; // not a NUT-11 secret — plain proof, claimable by anyone
    }
    if (allowed.length === 0) continue; // unlocked, or the lock has expired
    if (!allowed.map(toLockPubkey).includes(ours)) {
      throw new DvmError(
        "cashu_not_claimable",
        "This token is P2PK-locked to a key that isn't your agent wallet's master lock pubkey.",
        "If it was issued to you as a per-DVM refund (NUT-11 `refund` tag), claim it via `dvm wallet release` instead — that path derives the matching per-DVM refund privkey. Otherwise it was issued to a third party; ask the sender for a token locked to your wallet, or one with no lock."
      );
    }
  }
  const proofs = await cashuWallet.receive(
    token,
    { privkey: initial.lock_privkey },
    { type: "p2pk", options: { pubkey: initial.lock_pubkey } }
  );

  const agentProofs = proofs.map((p) => toAgentProof(p, mintUrl, initial.lock_pubkey));
  const claimedSats = proofs.reduce((sum, p) => sum + Amount.from(p.amount).toNumber(), 0);

  await withWalletLock(() => {
    const fresh = loadAgentWallet() ?? initial;
    const mints = fresh.mints.includes(mintUrl) ? fresh.mints : [...fresh.mints, mintUrl];
    saveAgentWallet({
      ...fresh,
      mints,
      proofs: [...fresh.proofs, ...agentProofs],
    });
  });

  return { mintUrl, claimedSats, proofCount: agentProofs.length };
}
