#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const signerAllowList = join(root, ".github", "release-signers");
const options = parseArguments(process.argv.slice(2));
const tag = options.tag;

if (!tag || !isReleaseTag(tag)) fail("--tag must be vX.Y.Z or vX.Y.Z-rc.N");

const manifest = readJson("package.json");
const releaseManifest = readJson(".release-please-manifest.json");
if (manifest.version !== releaseManifest["."]) fail("package.json and .release-please-manifest.json versions differ");
if (tag !== `v${manifest.version}`) fail("tag must exactly match package.json version");

assertCleanWorktree();
assertDefaultBranchTip();
assertTagAbsent();
assertSigningCapability();

if (options.dryRun) {
  console.log(`release tag dry run passed: ${tag} at ${git(["rev-parse", "HEAD"])}`);
  process.exit(0);
}

signedTag(root, tag, `Release ${tag}`, "HEAD");
try {
  verifyTag(root, tag);
} catch (error) {
  fail(`created ${tag} but could not verify its signature: ${error instanceof Error ? error.message : String(error)}`);
}
console.log(`created and verified signed release tag ${tag}`);

/** @param {string[]} args @returns {{ dryRun: boolean, tag?: string }} */
function parseArguments(args) {
  /** @type {{ dryRun: boolean, tag?: string }} */
  const options = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (argument === "--tag") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) fail("--tag requires a value");
      options.tag = value;
      index += 1;
      continue;
    }
    fail(`unknown argument: ${argument}`);
  }
  return options;
}

/** @param {string} value */
function isReleaseTag(value) {
  return /^v[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/u.test(value);
}

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertCleanWorktree() {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    fail("worktree is not clean");
  }
}

function assertDefaultBranchTip() {
  const remoteHead = git(["ls-remote", "--symref", "--exit-code", "origin", "HEAD"]);
  const defaultRef = remoteHead
    .split("\n")
    .find((line) => /^ref:\s+refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*\s+HEAD$/u.test(line));
  const remoteHeadOid = remoteHead
    .split("\n")
    .find((line) => /^[a-f0-9]{40}\s+HEAD$/u.test(line))
    ?.split(/\s+/u)[0];
  if (!defaultRef || !remoteHeadOid) fail("origin default branch is unavailable");
  const head = git(["rev-parse", "HEAD"]);
  if (head !== remoteHeadOid) {
    fail(`HEAD (${head}) is not the current remote default-branch tip (${defaultRef})`);
  }
}

function assertTagAbsent() {
  const local = spawnGit(["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
  if (local.status === 0) fail(`tag ${tag} already exists locally`);
  if (local.status !== 1) fail(`could not determine whether ${tag} exists locally`);

  const remote = spawnGit(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]);
  if (remote.status === 0) fail(`tag ${tag} already exists on origin`);
  if (remote.status !== 2) fail(`could not determine whether ${tag} exists on origin`);
}

function assertSigningCapability() {
  // `git config --get` exits 1 for an unset key, which git() would rethrow as a raw command
  // failure. Read it through spawnGit so an unconfigured signing key reports the real reason.
  const signingKey = spawnGit(["config", "--get", "user.signingkey"]);
  if (signingKey.status === 1 || signingKey.stdout.trim() === "") {
    fail("Git user.signingkey is not configured");
  }
  if (signingKey.status !== 0) fail("could not read Git user.signingkey");
  const scratch = mkdtempSync(join(tmpdir(), "dvmkit-sdk-release-signing-"));
  try {
    git(["clone", "--no-checkout", "--local", root, scratch]);
    copyGitConfig(scratch, "user.name");
    copyGitConfig(scratch, "user.email");
    copyGitConfig(scratch, "user.signingkey");
    signedTag(scratch, "release-signing-probe", "release signing capability probe", "HEAD");
    verifyTag(scratch, "release-signing-probe");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** @param {string} directory @param {string} name @param {string} message @param {string} target */
function signedTag(directory, name, message, target) {
  git([
    "-C",
    directory,
    "-c",
    "gpg.format=ssh",
    "-c",
    `gpg.ssh.allowedSignersFile=${signerAllowList}`,
    "tag",
    "-s",
    "-m",
    message,
    name,
    target,
  ]);
}

/** @param {string} directory @param {string} name */
function verifyTag(directory, name) {
  git([
    "-C",
    directory,
    "-c",
    "gpg.format=ssh",
    "-c",
    `gpg.ssh.allowedSignersFile=${signerAllowList}`,
    "tag",
    "-v",
    name,
  ]);
}

/** @param {string} directory @param {string} name */
function copyGitConfig(directory, name) {
  const result = spawnGit(["config", "--get", name]);
  if (result.status !== 0) return;
  git(["-C", directory, "config", name, result.stdout.trim()]);
}

/** @param {string[]} args */
function git(args) {
  const result = spawnGit(args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

/** @param {string[]} args */
function spawnGit(args) {
  return spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release tag: ${message}`);
  process.exit(1);
}
