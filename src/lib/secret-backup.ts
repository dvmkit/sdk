import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Copy a secret file aside before it is replaced, so an overwrite is
 * recoverable from disk rather than only from an off-machine backup.
 *
 * Returns the backup path, or null when there was nothing to preserve: no
 * prior file, or a prior file whose contents match `nextContent` (re-importing
 * the same words shouldn't litter the config dir). Omit `nextContent` when the
 * file is being deleted rather than replaced.
 *
 * The copy lands next to the original as `<file>.<timestamp>.bak`, created
 * with mode 0600 under the `wx` flag: the secret is never on disk at a wider
 * mode even momentarily, and the exclusive create means we can't land on top
 * of a backup another process made between the name check and the write.
 */
export function backupSecretFile(file: string, nextContent?: string): string | null {
  const content = existsSync(file) ? readFileSync(file) : null;
  if (content === null) return null;
  if (content.toString("utf-8").trim() === nextContent?.trim()) return null;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Distinct suffixes preserve both backups when timestamps collide.
  // Bounded: an unbounded retry would spin forever against a filesystem that
  // reports every create as a collision, and 100 collisions in one millisecond
  // is already past the point where another suffix helps.
  for (let n = 0; n < 100; n++) {
    const backup = n === 0 ? `${file}.${stamp}.bak` : `${file}.${stamp}-${String(n)}.bak`;
    try {
      writeFileSync(backup, content, { mode: 0o600, flag: "wx" });
      return backup;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Could not create a backup of ${file}: 100 candidate paths already exist.`);
}
