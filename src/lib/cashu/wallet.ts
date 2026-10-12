import { Wallet } from "@cashu/cashu-ts";
import { mnemonicToSeedSync } from "@scure/bip39";

import { callerLoggers } from "../caller-loggers";
import { DvmError } from "../errors";
import { readAgentMnemonic } from "../wallet-agent/agent-mnemonic-file";
import { mnemonicFingerprint } from "../wallet-agent/mnemonic";
import { PersistentCounterSource } from "../wallet-agent/nut13-counters";
import { loadAgentWallet } from "../wallet-agent/store";
import { assertNutSupport } from "./health";

const walletCache = new Map<string, Wallet>();

/**
 * Global registry mapping 31-bit keyset residues to the first keyset that
 * claimed that residue. Populated on wallet construction. If two keysets from
 * different mints share the same residue, NUT-13 deterministic secret
 * derivation would reuse identical BIP-32 path components — an exploitable
 * collision. The guard throws before any wallet with a colliding keyset is used.
 */
const keysetResidueRegistry = new Map<bigint, { keysetId: string; mintUrl: string }>();

const NUT13_MODULUS = BigInt(2 ** 31 - 1);

function assertNoKeysetCollision(keysets: { id: string }[], mintUrl: string): void {
  for (const keyset of keysets) {
    let residue: bigint;
    try {
      residue = BigInt("0x" + keyset.id) % NUT13_MODULUS;
    } catch {
      throw new DvmError(
        "cashu_keyset_collision",
        `Mint ${mintUrl} has keyset ID "${keyset.id}" that is not valid hex. Cannot verify NUT-13 collision safety.`,
        "Contact the mint operator to ensure the mint returns standard keyset IDs."
      );
    }
    const existing = keysetResidueRegistry.get(residue);
    if (existing && existing.keysetId !== keyset.id) {
      throw new DvmError(
        "cashu_keyset_collision",
        `Keyset collision detected: mint ${mintUrl} keyset ${keyset.id} and mint ${existing.mintUrl} keyset ${existing.keysetId} share the same 31-bit NUT-13 residue. Cannot safely derive deterministic secrets.`,
        "Contact the affected mint operators to rotate their keyset IDs."
      );
    }
    keysetResidueRegistry.set(residue, { keysetId: keyset.id, mintUrl });
  }
}

/**
 * Get or create a cashu-ts Wallet for a mint, calling loadMint() once per
 * session.
 *
 * When the agent has a mnemonic on disk at `~/.dvm/wallet.mnemonic` AND
 * the wallet's `mnemonic_fingerprint` matches it, NUT-13
 * deterministic secrets are eligible: the constructor receives `bip39seed`
 * derived via `mnemonicToSeedSync` and a {@link PersistentCounterSource}
 * backed by `wallet.nut13_counters`.
 *
 * NUT-13 is resolved per mint. Deterministic derivation is unsafe over an
 * selected V1 output keyset (`id` prefix `00`) — the 2026-01 keyset-ID-collision
 * disclosure — so a wallet bound to V1 is degraded to random-secret mode for
 * that mint alone, rather than refused. Retired V1 keysets remain published so
 * their proofs can be verified and spent, but cannot produce new outputs; a
 * V2-bound wallet (`id` prefix `01`) keeps NUT-13. The
 * {@link assertNoKeysetCollision} guard only protects the derivation path, so
 * it runs only for mints where NUT-13 stays active.
 *
 * When the agent wallet or its sibling mnemonic file is absent (e.g. on a
 * DVM server, or a CLI process that only touches the builder-side
 * cashu-proofs flow), NUT-13 stays inactive everywhere — `new Wallet(mintUrl)`
 * with no options, random secrets.
 */
export async function getWallet(mintUrl: string): Promise<Wallet> {
  const cached = walletCache.get(mintUrl);
  if (cached) return cached;

  return callerLoggers.cashu.span("cashu.get_wallet", { mint_url: mintUrl }, async () => {
    let nut13 = loadNut13Config(mintUrl);
    let wallet = await buildAndLoadWallet(mintUrl, nut13);
    if (nut13) {
      // cashu-ts binds this sat wallet to one active keyset during loadMint().
      // Only that keyset can receive its new deterministic outputs, so an
      // unrelated active V1 keyset must not degrade a V2-bound wallet.
      if (wallet.getKeyset().id.startsWith("00")) {
        nut13 = null;
        wallet = await buildAndLoadWallet(mintUrl, null);
      }
    }

    assertNutSupport(mintUrl, wallet.getMintInfo().cache.nuts as Record<string, unknown>);

    // The keyset-residue collision guard protects every NUT-13 derivation
    // path. Restore explicitly walks all V2 keysets for this sat wallet's
    // unit, including retired ones, so retain them here; V1 keysets used
    // random secrets before this feature and are not restore-eligible.
    if (nut13) {
      const restoreKeysets = wallet.keyChain
        .getKeysets()
        .filter((keyset) => keyset.unit === wallet.unit && !keyset.id.startsWith("00"));
      assertNoKeysetCollision(restoreKeysets, mintUrl);
    }

    walletCache.set(mintUrl, wallet);
    return wallet;
  });
}

/**
 * Construct a cashu-ts Wallet for a mint and call loadMint(), mapping any
 * connection failure to a `cashu_mint_unreachable` {@link DvmError}. Passes
 * NUT-13 deterministic-secret options through when `nut13` is non-null.
 */
async function buildAndLoadWallet(
  mintUrl: string,
  nut13: { bip39seed: Uint8Array; counterSource: PersistentCounterSource } | null
): Promise<Wallet> {
  const wallet = nut13 ? new Wallet(mintUrl, nut13) : new Wallet(mintUrl);
  try {
    await wallet.loadMint();
  } catch {
    throw new DvmError(
      "cashu_mint_unreachable",
      `Cannot connect to mint: ${mintUrl}`,
      "The mint is not responding. Try again later."
    );
  }
  return wallet;
}

/**
 * Resolve the NUT-13 activation options for a given mint, or `null` to
 * keep cashu-ts in random-secret mode.
 *
 * Returns `null` (degraded) when:
 * - No agent wallet on disk.
 * - Agent wallet exists but has no `mnemonic_fingerprint` (e.g. a
 * hex-privkey-recovered wallet that never bound a mnemonic).
 * - No sibling `wallet.mnemonic` file on disk.
 *
 * Throws `wallet_mnemonic_mismatch` when both fingerprints are present
 * but disagree — the sibling file does not belong to this wallet.
 */
function loadNut13Config(
  mintUrl: string
): { bip39seed: Uint8Array; counterSource: PersistentCounterSource } | null {
  const wallet = loadAgentWallet();
  if (!wallet?.mnemonic_fingerprint) return null;
  const mnemonic = readAgentMnemonic();
  if (!mnemonic) return null;
  const actual = mnemonicFingerprint(mnemonic);
  if (actual !== wallet.mnemonic_fingerprint) {
    throw new DvmError(
      "wallet_mnemonic_mismatch",
      "The mnemonic at ~/.dvm/wallet.mnemonic does not match the fingerprint recorded on ~/.dvm/wallet.json.",
      "Either restore the matching mnemonic file from a backup, or run `dvm wallet restore --force --file <path>` (or pipe the mnemonic via stdin) with the wallet's actual mnemonic to rebuild from scratch."
    );
  }
  return {
    bip39seed: mnemonicToSeedSync(mnemonic),
    counterSource: new PersistentCounterSource(mintUrl),
  };
}
