#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { isApprovedCommitEmail } from "./check-commit-identity.mjs";

// Fingerprints reject private product labels without publishing those labels in the guard.
const privateProductFingerprints = new Set([
  "a931f5f94c3d767c112f06c67615839b4c7f32d4da219b988ced3f86759ccf53",
]);

const options = parseArguments(process.argv.slice(2));
const root = resolve(options.root ?? process.cwd());
const reportPath = resolve(options.report ?? join(root, ".artifacts", "public-safety-report.json"));

/**
 * GitHub repositories this organisation publishes. Any other `dvmkit`-owned locator is private.
 * `dvm-cli` is the published caller package, which the contribution policy links to as the sibling
 * repository a builder is most likely to want next.
 */
const publicRepositories = new Set(["dvmkit/sdk", "dvmkit/dvm-cli", "dvmkit/dvmctl"]);
/** Explicitly public hosts whose suffix otherwise resembles private infrastructure. */
const publicSpecialHosts = new Set(["metadata.google.internal", "dvmkit-testmint.fly.dev"]);
const safeEmailSuffixes = ["@users.noreply.github.com", "@example.com", "@example.invalid"];
// Support publishes its contact address only in SUPPORT.md; security reports use GitHub
// private vulnerability reporting. Retain the two explicit role-address exemptions without
// allowing the whole project domain, so a personal name at that domain still fails the scan.
const safeEmailAddresses = new Set([
  "noreply@github.com",
  "alice@getalby.com",
  "security@dvmkit.com",
  "support@dvmkit.com",
]);

/** @type {{ category: string, location: string }[]} */
const violations = [];
const seenLocations = new Set();
const counts = { files: 0, commits: 0, packedFiles: 0, pullRequestBodies: 0 };
/** @type {string | undefined} */
let packageTemporaryRoot;

try {
  if (!options.packOnly) {
    scanRepositoryFiles();
    if (!options.skipGit) scanGitMetadata();
    const pullRequestBodyPath = options.prBodyFile ?? process.env.PUBLIC_SAFETY_PR_BODY_PATH;
    if (pullRequestBodyPath) {
      classifyText(readFileSync(resolve(pullRequestBodyPath), "utf8"), "pull-request-body");
      counts.pullRequestBodies += 1;
    }
  }
  if (!options.skipPack) scanPackedPackage();
} catch (error) {
  addViolation(`scanner_error:${error instanceof Error ? error.message : String(error)}`, "scanner");
} finally {
  if (packageTemporaryRoot) rmSync(packageTemporaryRoot, { recursive: true, force: true });
}

writeReport();
if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`public safety: ${violation.category} at ${violation.location}`);
  }
  process.exit(1);
}
console.log(
  `public safety ok: ${counts.files} repository files, ${counts.packedFiles} packed files, ${counts.commits} commits, ${counts.pullRequestBodies} pull request bodies`
);

/** @param {string[]} args */
function parseArguments(args) {
  /** @type {{ gitMetadataFile?: string, packOnly: boolean, prBodyFile?: string, report?: string, root?: string, skipGit: boolean, skipPack: boolean }} */
  const parsed = { packOnly: false, skipGit: false, skipPack: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--pack-only") parsed.packOnly = true;
    else if (argument === "--skip-git") parsed.skipGit = true;
    else if (argument === "--skip-pack") parsed.skipPack = true;
    else if (argument === "--root") parsed.root = requireValue(args, (index += 1), argument);
    else if (argument === "--report") parsed.report = requireValue(args, (index += 1), argument);
    else if (argument === "--pr-body-file") parsed.prBodyFile = requireValue(args, (index += 1), argument);
    else throw new Error(`unknown argument ${argument}`);
  }
  if (parsed.packOnly && parsed.skipPack) {
    throw new Error("--pack-only cannot be combined with --skip-pack");
  }
  return parsed;
}

/** @param {string[]} args @param {number} index @param {string} flag @returns {string} */
function requireValue(args, index, flag) {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

/**
 * Scan exactly what Git would carry into a public repository: tracked files plus untracked files
 * that are not ignored. A raw directory walk would also read `node_modules`, `dist` and
 * `.artifacts`, none of which can ever become public, and would report them as leaks.
 */
function scanRepositoryFiles() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const relative of files) {
    const absolute = join(root, relative);
    const location = relative.split(sep).join("/");
    if (lstatSync(absolute).isSymbolicLink()) {
      addViolation("symlink", location);
      continue;
    }
    counts.files += 1;
    if (generatedLeak(location)) addViolation("generated_artifact", location);
    if (location.endsWith(".map")) addViolation("source_map", location);
    const content = readFileSync(absolute);
    if (content.includes(0)) continue;
    classifyText(content.toString("utf8"), location);
  }
}

/** @param {string} text @param {string} location */
function classifyText(text, location) {
  for (const token of text.match(/[a-z][a-z0-9]*/giu) ?? []) {
    const fingerprint = createHash("sha256").update(token.toLowerCase()).digest("hex");
    if (privateProductFingerprints.has(fingerprint)) addViolation("private_product_name", location);
  }
  for (const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu) ?? []) {
    if (!safeEmail(email)) addViolation("personal_email", location);
  }

  const userPath = /(?:^|[\s"'`=(])(?:\/(?:Users|home)\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/u;
  if (userPath.test(text)) addViolation("absolute_private_path", location);

  classifyRepositoryLocators(text, location);
  classifyHosts(text, location);
  // Small lowercase runtime IDs remain valid. Long numbered labels and descriptive
  // fixture prefixes are tracker-shaped; explicit issue context also identifies short keys.
  const trackerKey = /\bDVM-[0-9]+\b/u;
  const numberedFixture = /\bdvm[-_]?(?:[0-9]{4,}(?:\b|[a-z_])|[0-9]{3,}[-_][a-z])/iu;
  const embeddedFixture = /\b(?:lnbcrt[0-9]+|0x)dvm[0-9]{4,}[a-z0-9_]*/iu;
  const contextualKey = /\b(?:issue|ticket|incident|regression)\s+(?:id\s+)?dvm[-_]?[0-9]+\b/iu;
  if (trackerKey.test(text) || numberedFixture.test(text) || embeddedFixture.test(text) || contextualKey.test(text)) {
    addViolation("internal_issue_id", location);
  }
  if (/\blinear\.app\//u.test(text)) addViolation("internal_tracker_link", location);
  if (
    isShippedSource(location) &&
    ["CLAUDE.md", "AGENTS.md", ".claude/"].some((pointer) => text.includes(pointer))
  ) {
    addViolation("internal_agent_config", location);
  }

  const secretPatterns = [
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{40,}-----END (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    /\bnpm_[A-Za-z0-9]{20,}\b/u,
    /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\bsk_live_[A-Za-z0-9]{16,}\b/u,
    // This package's own domain: a bech32 Nostr private key, and a wallet connection string that
    // carries its spending secret inline.
    /\bnsec1[02-9ac-hj-np-z]{58}\b/u,
    /nostr\+walletconnect:\/\/[^\s"'`]*[?&]secret=[A-Za-z0-9]{32,}/u,
  ];
  if (secretPatterns.some((pattern) => pattern.test(text))) addViolation("secret", location);
}

/** @param {string} location */
function isShippedSource(location) {
  return /^(?:src|dist)\//u.test(location) || location.startsWith("package/dist/");
}

/** @param {string} text @param {string} location */
function classifyRepositoryLocators(text, location) {
  const locators = [
    ...text.matchAll(
      /https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s#?/"'`,)\]]|$)/giu
    ),
    ...text.matchAll(/git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[\s#?"'`,)\]]|$)/giu),
  ];
  for (const match of locators) {
    const owner = match[1]?.toLowerCase();
    const repository = match[2]?.toLowerCase();
    if (!owner || !repository) continue;
    // A first-party locator outside the published set names a repository that is not public.
    if (owner === "dvmkit" && !publicRepositories.has(`${owner}/${repository}`)) {
      addViolation("private_repository", location);
    }
  }
}

/** @param {string} text @param {string} location */
function classifyHosts(text, location) {
  const hosts = text.matchAll(/\b(?:[A-Za-z0-9-]+\.)+(?:internal|ts\.net|tailnet|fly\.dev|flycast|local)\b/giu);
  for (const match of hosts) {
    const host = match[0].toLowerCase();
    if (publicSpecialHosts.has(host)) continue;
    addViolation("non_public_host", location);
  }
}

/** @param {string} email */
function safeEmail(email) {
  const normalized = email.toLowerCase();
  return (
    safeEmailSuffixes.some((suffix) => normalized.endsWith(suffix)) || safeEmailAddresses.has(normalized)
  );
}

/** @param {string} path */
function generatedLeak(path) {
  return (
    /(^|\/)(?:coverage|test-results|playwright-report|artifacts|\.artifacts|\.verify-logs|\.tooling)(\/|$)/u.test(path) ||
    /(?:\.log|\.jsonl|\.tgz|\.tar\.gz|\.zip)$/u.test(path)
  );
}

function scanGitMetadata() {
  for (const commit of git(["rev-list", "--all", "HEAD"]).trim().split("\n").filter(Boolean)) {
    const record = git(["show", "-s", "--format=%H%x1f%ae%x1f%ce%x1f%B", commit]);
    const [sha, authorEmail, committerEmail, ...messageParts] = record.split("\x1f");
    const shortSha = typeof sha === "string" ? sha.slice(0, 12) : "unknown";
    if (!isApprovedCommitEmail(String(authorEmail ?? ""))) addViolation("unsafe_commit_author_email", `git:${shortSha}`);
    if (!isApprovedCommitEmail(String(committerEmail ?? ""))) {
      addViolation("unsafe_commit_committer_email", `git:${shortSha}`);
    }
    classifyText(messageParts.join("\x1f"), `git:${shortSha}:message`);
    counts.commits += 1;
  }
  for (const reference of git(["for-each-ref", "--format=%(refname)"]).trim().split("\n").filter(Boolean)) {
    classifyText(reference, "git:refs");
  }
}

function scanPackedPackage() {
  packageTemporaryRoot = mkdtempSync(join(tmpdir(), "dvmkit-sdk-public-pack-"));
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm executable is unavailable for packed-file inspection");
  const output = execFileSync(
    process.execPath,
    [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", packageTemporaryRoot, root],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const packed = JSON.parse(output)[0];
  const destination = join(packageTemporaryRoot, "unpacked");
  mkdirSync(destination);
  execFileSync("tar", ["-xzf", join(packageTemporaryRoot, packed.filename), "-C", destination]);
  for (const file of packed.files) {
    const path = file.path.split(sep).join("/");
    counts.packedFiles += 1;
    if (path.endsWith(".map") || /(^|\/)(?:src|test|scripts|docs|\.github|coverage|node_modules)(?:\/|$)/u.test(path)) {
      addViolation("forbidden_packed_path", `package/${path}`);
    }
  }
  const packedManifest = JSON.parse(readFileSync(join(destination, "package", "package.json"), "utf8"));
  for (const hook of lifecycleHooks(packedManifest)) {
    addViolation("packed_lifecycle_hook", `package/package.json:${hook}`);
  }
  walkPacked(join(destination, "package"), "package");
}

/** @param {string} directory @param {string} label */
function walkPacked(directory, label) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const location = `${label}/${entry.name}`;
    if (entry.isSymbolicLink()) addViolation("symlink", location);
    else if (entry.isDirectory()) walkPacked(absolute, location);
    else if (entry.isFile()) {
      const content = readFileSync(absolute);
      if (!content.includes(0)) classifyText(content.toString("utf8"), location);
    } else addViolation("unsupported_file_type", location);
  }
}

/** @param {any} manifest */
function lifecycleHooks(manifest) {
  const hooks = new Set([
    "preinstall",
    "install",
    "postinstall",
    "prepack",
    "prepare",
    "postpack",
    "prepublish",
    "prepublishOnly",
    "publish",
    "postpublish",
  ]);
  return Object.keys(manifest?.scripts ?? {}).filter((name) => hooks.has(name));
}

/** @param {string[]} args @returns {string} */
function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} category @param {string} location */
function addViolation(category, location) {
  const safeLocation = sanitizeLocation(location);
  const key = `${category}\0${safeLocation}`;
  if (seenLocations.has(key)) return;
  seenLocations.add(key);
  violations.push({ category, location: safeLocation });
}

/** @param {string} location */
function sanitizeLocation(location) {
  const value = String(location).replaceAll("\\", "/");
  const normalizedRoot = root.replaceAll("\\", "/");
  if (value.startsWith(normalizedRoot)) return value.slice(normalizedRoot.length).replace(/^\//u, "") || ".";
  return value.startsWith("/") || /^[A-Za-z]:\//u.test(value) ? "external-input" : value;
}

function writeReport() {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { status: violations.length === 0 ? "passed" : "failed", scanned: counts, violations },
      null,
      2
    )}\n`
  );
}
