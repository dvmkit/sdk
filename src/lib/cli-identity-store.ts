import { schnorr } from "@noble/curves/secp256k1.js";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";

import { IDENTITIES_FILE } from "../defaults";
import { ensureConfigDir } from "./config-dir";
import { DvmError } from "./errors";

const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRIES = 30;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 1_000;

export const IDENTITIES_VERSION = 1 as const;

/** One stored caller signing identity. The `name` is the file's record key. */
export interface CliIdentityEntry {
  /** 32-byte secp256k1 secret key, lowercase hex (64 chars). Never sent to any server. */
  privkey: string;
  /** 32-byte BIP-340 x-only public key, lowercase hex (64 chars). */
  pubkey: string;
  /** Epoch millis when the entry was generated or imported. */
  createdAt: number;
}

/**
 * Persistent on-disk shape of `~/.dvm/identities.json` (mode 0600). Stores the
 * caller signing identities `dvm request` / `dvm quote` use to auto-sign
 * descriptor-auth submissions.
 */
export interface IdentitiesFile {
  version: typeof IDENTITIES_VERSION;
  identities: Record<string, CliIdentityEntry>;
}

/** Whether `~/.dvm/identities.json` exists. Cheap presence check; does not parse. */
export function identitiesFileExists(): boolean {
  return existsSync(IDENTITIES_FILE);
}

export function loadIdentities(): IdentitiesFile | null {
  if (!existsSync(IDENTITIES_FILE)) return null;

  const raw = readFileSync(IDENTITIES_FILE, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DvmError(
      "identities_corrupt",
      `Identities file at ${IDENTITIES_FILE} is not valid JSON.`,
      `Restore a backup or delete the file and run 'dvm init'. Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new DvmError(
      "identities_corrupt",
      `Identities file at ${IDENTITIES_FILE} is missing a version field.`,
      "Restore a backup or delete the file and run 'dvm init'."
    );
  }

  const version = (parsed as { version: unknown }).version;
  if (version !== IDENTITIES_VERSION) {
    throw new DvmError(
      "identities_unknown_version",
      `Unknown identities file version ${String(version)} (this CLI understands version ${String(IDENTITIES_VERSION)}).`,
      "Upgrade dvm CLI: a newer version wrote this file."
    );
  }

  const identities = (parsed as { identities?: unknown }).identities;
  if (typeof identities !== "object" || identities === null || Array.isArray(identities)) {
    throw new DvmError(
      "identities_corrupt",
      `Identities file at ${IDENTITIES_FILE} has a malformed identities map.`,
      "Restore a backup or delete the file and run 'dvm init'."
    );
  }

  return {
    version: IDENTITIES_VERSION,
    identities: identities as Record<string, CliIdentityEntry>,
  };
}

/**
 * Atomically write the identities file with mode 0600. POSIX guarantees rename atomicity within a filesystem,
 * so a crash mid-write leaves either the previous file or the new one.
 *
 * Callers performing a read-modify-write cycle must hold {@link withIdentitiesLock}
 * across the cycle so two concurrent `dvm identity …` invocations cannot
 * clobber each other's writes.
 */
export function saveIdentities(file: IdentitiesFile): void {
  ensureConfigDir();
  const tmp = `${IDENTITIES_FILE}.tmp`;
  const data = JSON.stringify(file, null, 2) + "\n";
  writeFileSync(tmp, data, { mode: 0o600 });
  try {
    renameSync(tmp, IDENTITIES_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/** Lock acquisition budget; retry and stale-lock values are in milliseconds. */
export interface WithIdentitiesLockOptions {
  /** Stale-lock threshold in ms. A lock whose mtime is older than this is reclaimed. Default 30_000. */
  stale?: number;
  /** Number of acquisition retries before failing. Default 30. */
  retries?: number;
  /** Milliseconds between retries. Default 1_000. */
  retryIntervalMs?: number;
}

/**
 * Run `fn` while holding an OS-level exclusive lock on the identities file,
 * so concurrent `dvm identity …` invocations serialise their
 * read-modify-write cycles instead of clobbering each other. The lock file
 * lives at `~/.dvm/identities.json.lock` and is reclaimed automatically if a
 * previous holder died without releasing.
 *
 * Throws `DvmError("identities_locked", …)` when the lock can't be acquired
 * within the retry budget (~30s by default).
 */
export async function withIdentitiesLock<T>(
  fn: () => Promise<T> | T,
  opts: WithIdentitiesLockOptions = {}
): Promise<T> {
  ensureConfigDir();
  const lockPath = `${IDENTITIES_FILE}.lock`;

  const stale = opts.stale ?? DEFAULT_LOCK_STALE_MS;
  const retries = opts.retries ?? DEFAULT_LOCK_RETRIES;
  const interval = opts.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;

  let release: () => Promise<void>;
  try {
    release = await lockfile.lock(IDENTITIES_FILE, {
      lockfilePath: lockPath,
      stale,
      realpath: false,
      retries: { retries, factor: 1, minTimeout: interval, maxTimeout: interval },
    });
  } catch (err) {
    throw new DvmError(
      "identities_locked",
      `Could not acquire the identities lock at ${lockPath} within the retry budget.`,
      `Another dvm CLI may be writing to ${IDENTITIES_FILE}. Wait a moment and retry. If no other dvm CLI is running, remove ${lockPath} and try again.`,
      { lock_file: lockPath, underlying: err instanceof Error ? err.message : String(err) }
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await release();
    } catch {
      // best-effort: lock may have been auto-reclaimed as stale, or already released
    }
  }
}

/**
 * Generate a fresh secp256k1 keypair as a {@link CliIdentityEntry}. The
 * private key is 32 cryptographically-random bytes; the public key is the
 * BIP-340 x-only form — same convention as the SDK's
 * `createSignedRequestVerifier.signRequest`.
 */
export function generateIdentity(now: number = Date.now()): CliIdentityEntry {
  const { secretKey, publicKey } = schnorr.keygen();
  return {
    privkey: bytesToHex(secretKey),
    pubkey: bytesToHex(publicKey),
    createdAt: now,
  };
}

/**
 * Validate a 64-char lowercase hex private key and derive the matching
 * BIP-340 x-only pubkey. Throws `DvmError("invalid_privkey", ...)` on a
 * malformed input. Used by `dvm identity import` and the
 * `DVM_IDENTITY_KEY` env override resolver.
 */
export function deriveIdentityFromPrivkey(
  privkeyHex: string,
  now: number = Date.now()
): CliIdentityEntry {
  if (!/^[0-9a-f]{64}$/.test(privkeyHex)) {
    throw new DvmError(
      "invalid_privkey",
      "Private key must be 64 lowercase hex characters (32 bytes).",
      "Generate a fresh one with 'dvm identity create <name>'."
    );
  }
  const privkeyBytes = hexToBytes(privkeyHex);
  const pubkeyBytes = schnorr.getPublicKey(privkeyBytes);
  return {
    privkey: privkeyHex,
    pubkey: bytesToHex(pubkeyBytes),
    createdAt: now,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
