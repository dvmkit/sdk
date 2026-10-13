import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { AGENT_MNEMONIC_FILE } from "../../defaults";
import { ensureConfigDir } from "../config-dir";
import { DvmError } from "../errors";
import { backupSecretFile } from "../secret-backup";

export interface WriteAgentMnemonicResult {
  /**
   * Path of the timestamped 0600 copy of the mnemonic that was replaced, or
   * null when nothing was replaced (no prior file, or identical words).
   */
  backupFile: string | null;
}

/**
 * Read the agent wallet's BIP-39 mnemonic from `~/.dvm/wallet.mnemonic`.
 *
 * Returns `null` when the file is absent — callers treat that as the
 * NUT-13-inactive "degraded mode" and skip `bip39seed` on the cashu-ts
 * `Wallet` constructor (see `getWallet` in `src/lib/cashu/wallet.ts`).
 *
 * The mnemonic is normalised on the way out (trimmed; words lower-cased
 * and joined by a single space) so any callsite gets the exact form
 * `mnemonicToSeedSync` expects.
 */
export function readAgentMnemonic(): string | null {
  if (!existsSync(AGENT_MNEMONIC_FILE)) return null;
  const raw = readFileSync(AGENT_MNEMONIC_FILE, "utf-8");
  return raw.trim().toLowerCase().split(/\s+/).join(" ");
}

/**
 * Throw `agent_mnemonic_exists` if `~/.dvm/wallet.mnemonic` is present and
 * `force` wasn't passed. {@link writeAgentMnemonic} calls this itself, so the
 * guard can't be skipped; commands call it early — before they print words the
 * user is asked to write down — so a run that is going to refuse fails before
 * it walks someone through backing up a wallet it never creates.
 */
export function assertAgentMnemonicReplaceable(opts: { force?: boolean } = {}): void {
  if (existsSync(AGENT_MNEMONIC_FILE) && !opts.force) {
    throw new DvmError(
      "agent_mnemonic_exists",
      `An agent wallet recovery mnemonic already exists at ${AGENT_MNEMONIC_FILE}.`,
      "Re-run with --force to replace it. WARNING: funds locked to keys derived from the current words become unrecoverable without a backup. The replaced mnemonic is copied to a timestamped .bak sibling."
    );
  }
}

/**
 * Atomically write the agent wallet's BIP-39 mnemonic with mode 0600.
 *
 * Mirrors {@link saveAgentWallet}'s tmp + rename pattern so a crash
 * mid-write leaves either the previous file or the new one, never a
 * truncated mix.
 *
 * Refuses to replace an existing mnemonic unless `force` is passed — the
 * builder-side twin of `writeBuilderMnemonic`. The wallet commands
 * gate on `walletExists()`, which says nothing about an orphan mnemonic file
 * whose words may still hold funds, so the guard lives here too. A forced
 * overwrite copies the prior words aside first and reports that path back.
 */
export function writeAgentMnemonic(
  mnemonic: string,
  opts: { force?: boolean } = {}
): WriteAgentMnemonicResult {
  const normalised = mnemonic.trim().toLowerCase().split(/\s+/).join(" ");

  assertAgentMnemonicReplaceable(opts);

  ensureConfigDir();
  const backupFile = backupSecretFile(AGENT_MNEMONIC_FILE, normalised);

  const tmp = `${AGENT_MNEMONIC_FILE}.tmp`;
  writeFileSync(tmp, normalised + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, AGENT_MNEMONIC_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; leftover .tmp is harmless next run
    }
    throw err;
  }
  // Re-chmod after rename — the move may have widened the mode on some
  // filesystems, same rationale as `writeIdentity`.
  try {
    chmodSync(AGENT_MNEMONIC_FILE, 0o600);
  } catch {
    // POSIX-only; no-op on Windows.
  }

  return { backupFile };
}

/**
 * Remove `~/.dvm/wallet.mnemonic` if it exists. Used by `dvm wallet
 * recover --force` (hex-privkey branch) and the `--force` overwrite paths
 * to avoid leaving a stale mnemonic behind whose fingerprint would no
 * longer match the wallet's `mnemonic_fingerprint`.
 *
 * Copies the words aside before unlinking and returns that path — recovering
 * from a hex privkey drops NUT-13, and the mnemonic it discards may still be
 * the only route to funds derived from it. Discarding is at least
 * as destructive as replacing, so callers gate on
 * {@link assertAgentMnemonicReplaceable} first rather than letting this run
 * unguarded.
 */
export function deleteAgentMnemonic(): { backupFile: string | null } {
  if (!existsSync(AGENT_MNEMONIC_FILE)) return { backupFile: null };
  const backupFile = backupSecretFile(AGENT_MNEMONIC_FILE);
  unlinkSync(AGENT_MNEMONIC_FILE);
  return { backupFile };
}
