#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === "--root" && args[1])) {
  fail("use no arguments, or --root directory");
}
const root = args.length ? resolve(args[1]) : resolve(import.meta.dirname, "..");

try {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const baseline = JSON.parse(readFileSync(join(root, "api-baseline.json"), "utf8"));
  if (typeof manifest.version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u.test(manifest.version)) {
    fail("package.json version must be stable X.Y.Z or X.Y.Z-rc.N");
  }
  const version = components(manifest.version);
  const tags = execFileSync("git", ["tag", "--list", "v*"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const previous = tags.split("\n")
    .filter((tag) => /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(tag))
    .map((tag) => ({ tag, version: components(tag.slice(1)) }))
    .filter((entry) => compare(entry.version, version) < 0)
    .sort((a, b) => compare(b.version, a.version))[0];
  if (!previous) fail(`no stable release tag below ${manifest.version}; fetch the complete release tags before checking rollover`);
  if (baseline.version !== previous.tag.slice(1)) {
    fail(`api-baseline.json version ${baseline.version} must equal ${previous.tag.slice(1)} (previous stable release); fetch tags and run node scripts/check-api-surface.mjs --baseline-from-tag ${previous.tag}`);
  }

  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const sections = changelog.split(/^##[\t ]+/mu).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split("\n");
    if (/^(?:Unreleased|\[Unreleased\](?:\([^\n]*\))?)\s*$/iu.test(heading) && body.join("\n").trim()) {
      fail(`CHANGELOG.md Unreleased must be empty when preparing ${manifest.version}; move its notes into the ${manifest.version} release section`);
    }
  }
  console.log(`release rollover ok: ${manifest.version} compares against ${previous.tag}, with no Unreleased notes`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

/** @param {string} version @returns {bigint[]} */
function components(version) {
  return version.split("-", 1)[0].split(".").map((part) => BigInt(part));
}

/** @param {bigint[]} left @param {bigint[]} right */
function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release rollover: ${message}`);
  process.exit(1);
}
