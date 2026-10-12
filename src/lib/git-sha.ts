/**
 * Deploy-sha provenance markers, shared by every layer that emits or renders
 * a baked `GIT_SHA`.
 *
 * Lives in `lib/` because the producer and the consumers sit on opposite sides
 * of the codebase: `dvmctl` bakes the value at deploy time, while the SDK's
 * `/healthz` + `/v1/info` and the platform's `/healthz` render it back. They
 * have to agree on the shape, and a truncation rule that silently dropped the
 * marker in one of them would make the same image report clean on one endpoint
 * and dirty on another.
 */

/**
 * Suffix marking a sha whose image was built from a tree that didn't match it.
 *
 * Mirrors `git describe --dirty`. Deliberately not a valid sha shape: a marked
 * sha is not a resolvable rev, and consumers must either render it verbatim or
 * fail rather than silently treat the image as reproducible from that commit.
 */
export const DIRTY_SUFFIX = "-dirty";

/**
 * Split a possibly-marked sha into its commit and its dirty flag.
 *
 * Use this anywhere a deployed sha is fed back to git or compared against a
 * commit — passing the marked form to `git log`/`rev-parse` just fails.
 */
export function splitDirtySha(sha: string): { base: string; dirty: boolean } {
  return sha.endsWith(DIRTY_SUFFIX)
    ? { base: sha.slice(0, -DIRTY_SUFFIX.length), dirty: true }
    : { base: sha, dirty: false };
}

/**
 * Abbreviate a sha for display, keeping any dirty marker visible.
 *
 * The reason this exists rather than a bare `.slice(0, 7)`: truncating to
 * seven characters cuts the marker off the end, which turns a deliberately
 * un-reproducible sha back into something that reads as an ordinary commit.
 */
export function shortSha(sha: string): string {
  const { base, dirty } = splitDirtySha(sha);
  return base.slice(0, 7) + (dirty ? DIRTY_SUFFIX : "");
}
