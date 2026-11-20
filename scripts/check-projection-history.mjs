import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = "src/observability/__tests__/fixtures/projection/batch-pins.json";
const releaseVersionFile = ".release-please-manifest.json";
const releaseTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/u;

/** @param {string} root */
function checkProjectionHistory(root) {
  /** @param {...string} args */
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();

  if (git("rev-parse", "--is-shallow-repository") !== "false") {
    throw new Error("fetch full history and release tags before checking the projection corpus");
  }

  /** @param {string} ref */
  const committedPins = (ref) => git("ls-tree", ref, "--", manifest)
    ? readPins(git("show", `${ref}:${manifest}`))
    : undefined;

  const tagsAtHead = new Set(git("tag", "--points-at", "HEAD").split("\n"));
  const tags = git("tag", "--merged", "HEAD", "--list", "v*").split("\n").filter((tag) => releaseTag.test(tag));
  const headTag = tags.find((tag) => tagsAtHead.has(tag));
  const candidates = tags.filter((tag) => !tagsAtHead.has(tag));
  if (candidates.length === 0) {
    throw new Error("no previous reachable release tag; fetch the release tags before checking the projection corpus");
  }

  const previous = git("describe", "--tags", "--abbrev=0", `--candidates=${candidates.length}`,
    ...candidates.flatMap((tag) => ["--match", tag]), "HEAD");
  const previousRef = `refs/tags/${previous}`;
  // The next release can be prepared before its tag exists. Two version
  // rollovers since the selected tag mean at least one preceding tag is absent.
  const rollover = git("log", "-2", "--first-parent", "--format=%H", `${previousRef}..HEAD`, "--", releaseVersionFile);
  if (rollover.includes("\n")) {
    throw new Error(`release tags are incomplete after ${previous}; fetch the release tags`);
  }

  const current = readPins(readFileSync(resolve(root, manifest), "utf8"));
  const published = committedPins(previousRef);
  if (!published && (git("log", "-1", "--format=%H", previousRef, "--", manifest) ||
    candidates.some((tag) => git("ls-tree", `refs/tags/${tag}`, "--", manifest)))) {
    throw new Error(`${previous} is missing its previously tracked projection corpus`);
  }

  if (headTag) {
    const tagged = committedPins("HEAD");
    if (published) {
      if (!tagged) throw new Error(`${headTag} is missing its previously tracked projection corpus`);
      checkPins(published, tagged, previous);
    }
    if (tagged) {
      checkPins(tagged, current, headTag);
      return `published projection batches checked against ${headTag} (predecessor ${previous})`;
    }
  }

  if (published) checkPins(published, current, previous);

  if (!headTag && rollover) {
    // A prepared release and a release with a missing tag look alike locally.
    // Use committed pins from that version, including fixes after preparation.
    const changes = git("log", "--first-parent", "--format=%H", `${rollover}..HEAD`, "--", manifest);
    const version = JSON.parse(git("show", `${rollover}:${releaseVersionFile}`))["."];
    if (typeof version !== "string" || !releaseTag.test(`v${version}`)) {
      throw new Error("invalid prepared release version");
    }
    let checked = false;
    for (const ref of [rollover, ...changes.split("\n").filter(Boolean)]) {
      const pins = committedPins(ref);
      if (!pins) continue;
      checkPins(pins, current, `v${version} (committed pins; fetch the release tag if published)`);
      checked = true;
    }
    if (checked) return `committed projection pins for v${version} checked (predecessor ${previous})`;
  }

  return published
    ? `published projection batches checked against ${previous}`
    : `first release of the projection corpus (predecessor ${previous})`;
}

/**
 * @param {ReturnType<typeof readPins>} published
 * @param {ReturnType<typeof readPins>} current
 * @param {string} release
 */
function checkPins(published, current, release) {
  const previousEpoch = Math.max(...published.map(({ epoch }) => epoch));
  const currentEpoch = Math.max(...current.map(({ epoch }) => epoch));
  if (currentEpoch < previousEpoch) throw new Error(`projection epoch moved backwards from ${release}`);

  const currentById = new Map(current.map((batch) => [batch.id, batch]));
  for (const batch of published) {
    const next = currentById.get(batch.id);
    if (next?.epoch === batch.epoch && next.sha256 === batch.sha256) continue;
    if (currentEpoch > previousEpoch && batch.epoch < currentEpoch) continue;
    throw new Error(`published projection batch ${batch.id} changed or disappeared since ${release}`);
  }
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

try {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === "--root" && args[1])) {
    throw new Error("use no arguments, or --root directory");
  }
  const root = args.length ? resolve(args[1]) : resolve(import.meta.dirname, "..");
  console.log(`projection history ok: ${checkProjectionHistory(root)}`);
} catch (error) {
  console.error(`projection history: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
