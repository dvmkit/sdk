/**
 * mkdirSync applies mode only on creation; existing directories need explicit
 * repair. Owner-only directories hide configured rails and public receipt files
 * from other local users, in addition to each secret file's own mode.
 */
import { chmodSync, mkdirSync, statSync } from "fs";

import { CONFIG_DIR } from "../defaults";

/** Owner-only mode `~/.dvm` is meant to carry. */
export const CONFIG_DIR_MODE = 0o700;

/** Outcome of a {@link repairConfigDirMode} pass. Never throws; failures land in `error`. */
export interface ConfigDirModeResult {

  path: string;
  /** Whether the directory exists. False also when the stat itself failed (see `error`). */
  exists: boolean;
  /** Mode after the pass, e.g. `"0700"`. Null when absent, unreadable, or off-POSIX. */
  modeOctal: string | null;
  /** Mode found before the pass, when {@link repaired} is true. */
  previousModeOctal?: string;
  /** True when this call tightened a group/other-accessible directory to 0700. */
  repaired: boolean;
  /** True on Windows, where POSIX modes are meaningless and the pass is a no-op. */
  skippedNonPosix: boolean;
  /** Underlying message when the stat or chmod failed. */
  error?: string;
}

/** Create the caller-state directory owner-only; existing modes are unchanged. */
export function ensureConfigDir(): void {
  ensureConfigSubdir(CONFIG_DIR);
}

/**
 * Create a caller-state subdirectory owner-only. Recursive mkdir may also create
 * CONFIG_DIR, so every creation path must carry the same owner-only mode.
 */
export function ensureConfigSubdir(path: string): void {
  mkdirSync(path, { recursive: true, mode: CONFIG_DIR_MODE });
}

/**
 * Tighten an existing `CONFIG_DIR` to 0700 when it is group- or
 * other-accessible. Does not create the directory — an absent one is reported,
 * not conjured, so read-mostly callers (`dvm doctor`) stay honest.
 *
 * Only *loosening* is corrected: a directory an operator deliberately set
 * stricter than 0700 (e.g. 0500) is left alone, so a shared-service setup is
 * not fought with on every run. No-op on Windows.
 */
export function repairConfigDirMode(): ConfigDirModeResult {
  const base: ConfigDirModeResult = {
    path: CONFIG_DIR,
    exists: false,
    modeOctal: null,
    repaired: false,
    skippedNonPosix: process.platform === "win32",
  };

  if (base.skippedNonPosix) return base;

  let mode: number;
  try {
    mode = statSync(CONFIG_DIR).mode & 0o777;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
    return missing ? base : { ...base, error: message };
  }

  if ((mode & 0o077) === 0) {
    return { ...base, exists: true, modeOctal: toOctal(mode) };
  }

  try {
    chmodSync(CONFIG_DIR, CONFIG_DIR_MODE);
  } catch (err) {
    return {
      ...base,
      exists: true,
      modeOctal: toOctal(mode),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  return {
    ...base,
    exists: true,
    modeOctal: toOctal(CONFIG_DIR_MODE),
    previousModeOctal: toOctal(mode),
    repaired: true,
  };
}

function toOctal(mode: number): string {
  return "0" + mode.toString(8).padStart(3, "0");
}
