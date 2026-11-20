import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = "src/observability/__tests__/fixtures/projection/batch-pins.json";
const releaseVersionFile = ".release-please-manifest.json";
const releaseTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/u;

/** @param {string} root */
export function checkProjectionHistory(root) {
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("fetch full history and release tags before checking the projection corpus");
  }

  // A release build can run at the new tag itself. Compare against its predecessor.
  const tagsAtHead = new Set(git("tag", "--points-at", "HEAD").split("\n"));
  const tags = git("tag", "--merged", "HEAD", "--list", "v*").split("\n").filter(Boolean);
  const candidates = tags.filter((tag) => releaseTag.test(tag) && !tagsAtHead.has(tag));
  if (candidates.length === 0) {
    throw new Error("no previous reachable release tag; fetch the release tags before checking the projection corpus");
  }
  const previous = git("describe", "--tags", "--abbrev=0", `--candidates=${candidates.length}`,
    ...candidates.flatMap((tag) => ["--match", tag]), "HEAD");
  const previousRef = `refs/tags/${previous}`;
  // The next release can be prepared before its tag exists. Two version
  // rollovers since the selected tag mean at least one preceding tag is absent.
  const rollovers = git("log", "-2", "--first-parent", "--format=%H", `${previousRef}..HEAD`, "--", releaseVersionFile);
  if (rollovers.includes("\n")) {
    throw new Error(`release tags are incomplete after ${previous}; fetch the release tags`);
  }
  const current = readPins(readFileSync(resolve(root, manifest), "utf8"));
  if (!git("ls-tree", previousRef, "--", manifest)) {
    if (git("log", "-1", "--format=%H", previousRef, "--", manifest) ||
      candidates.some((tag) => git("ls-tree", `refs/tags/${tag}`, "--", manifest))) {
      throw new Error(`${previous} is missing its previously tracked projection corpus`);
    }
    return `first release of the projection corpus (predecessor ${previous})`;
  }

  const published = readPins(git("show", `${previousRef}:${manifest}`));
  const previousEpoch = Math.max(...published.map(({ epoch }) => epoch));
  const currentEpoch = Math.max(...current.map(({ epoch }) => epoch));
  if (currentEpoch < previousEpoch) throw new Error(`projection epoch moved backwards from ${previous}`);

  const currentById = new Map(current.map((batch) => [batch.id, batch]));
  for (const batch of published) {
    const next = currentById.get(batch.id);
    if (next?.epoch === batch.epoch && next.sha256 === batch.sha256) continue;
    if (currentEpoch > previousEpoch && batch.epoch < currentEpoch) continue;
    throw new Error(`published projection batch ${batch.id} changed or disappeared since ${previous}`);
  }
  return `published projection batches checked against ${previous}`;
}

/** @param {string} json @returns {{ id: string, epoch: number, sha256: string }[]} */
function readPins(json) {
  const pins = JSON.parse(json);
  if (!Array.isArray(pins) || pins.length === 0 ||
    pins.some((pin) => !pin || typeof pin.id !== "string" || !pin.id ||
      !Number.isSafeInteger(pin.epoch) || pin.epoch < 1 ||
      typeof pin.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(pin.sha256)) ||
    new Set(pins.map((pin) => pin.id)).size !== pins.length) {
    throw new Error("invalid projection batch pins");
  }
  return pins;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = checkProjectionHistory(resolve(import.meta.dirname, ".."));
    console.log(`projection history ok: ${result}`);
  } catch (error) {
    console.error(`projection history: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
