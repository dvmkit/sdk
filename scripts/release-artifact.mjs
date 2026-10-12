#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

/** @typedef {{ _: string[] } & Record<string, string>} ParsedArguments */

const options = parseArguments(process.argv.slice(2));
const command = options._[0];

if (command === "create") {
  const first = requiredPath(options, "first");
  const second = requiredPath(options, "second");
  const output = requiredPath(options, "output");
  const release = releaseIdentity(options);
  const firstDetails = archiveDetails(first);
  const secondDetails = archiveDetails(second);
  if (firstDetails.sha256 !== secondDetails.sha256) fail("the two package archives have different SHA-256 digests");
  if (JSON.stringify(firstDetails.files) !== JSON.stringify(secondDetails.files)) {
    fail("the two package archives have different file shapes");
  }
  assertPackageBinding(firstDetails, release);
  writeFileSync(
    output,
    `${JSON.stringify(
      {
        artifact: basename(first),
        distTag: release.distTag,
        files: firstDetails.files,
        packageName: firstDetails.packageName,
        packageVersion: firstDetails.packageVersion,
        sha256: firstDetails.sha256,
        tag: release.tag,
      },
      null,
      2
    )}\n`
  );
  process.stdout.write(`${firstDetails.sha256}  ${basename(first)}\n`);
} else if (command === "verify") {
  const directory = requiredPath(options, "directory");
  const release = releaseIdentity(options);
  const digestPath = join(directory, "release-digest.json");
  if (!existsSync(digestPath)) fail("release-digest.json is missing");
  const digest = JSON.parse(readFileSync(digestPath, "utf8"));
  if (!isDigestManifest(digest)) fail("release digest has an invalid shape");
  const entries = readdirSync(directory).sort();
  if (entries.length !== 2 || !entries.includes("release-digest.json") || !entries.includes(digest.artifact)) {
    fail("release artifact directory must contain only its tarball and digest manifest");
  }
  if (
    digest.tag !== release.tag ||
    digest.distTag !== release.distTag ||
    digest.packageVersion !== release.version
  ) {
    fail("release digest does not bind the expected tag, version, and dist-tag");
  }
  const archive = join(directory, digest.artifact);
  const details = archiveDetails(archive);
  if (details.sha256 !== digest.sha256 || JSON.stringify(details.files) !== JSON.stringify(digest.files)) {
    fail("release tarball does not match its digest manifest");
  }
  if (details.packageName !== digest.packageName || details.packageVersion !== digest.packageVersion) {
    fail("release tarball package metadata does not match its digest manifest");
  }
  assertPackageBinding(details, release);
  process.stdout.write(`${archive}\n`);
} else {
  fail("use create or verify");
}

/** @param {string[]} args @returns {ParsedArguments} */
function parseArguments(args) {
  const result = /** @type {ParsedArguments} */ (/** @type {unknown} */ ({ _: /** @type {string[]} */ ([]) }));
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      result._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    const value = args[index + 1];
    if (!key || !value || value.startsWith("--")) fail(`missing value for ${argument}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

/** @param {ParsedArguments} options @param {string} name @returns {string} */
function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) fail(`--${name} is required`);
  return value;
}

/** @param {ParsedArguments} options @param {string} name */
function requiredPath(options, name) {
  return resolve(required(options, name));
}

/** @param {ParsedArguments} options */
function releaseIdentity(options) {
  const tag = required(options, "tag");
  const version = required(options, "version");
  const distTag = required(options, "dist-tag");
  if (tag !== `v${version}`) fail("tag must exactly match the package version");
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    if (distTag !== "latest") fail("stable versions must use npm dist-tag latest");
  } else if (/^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/u.test(version)) {
    if (distTag !== "next") fail("release candidates must use npm dist-tag next");
  } else {
    fail("version must be X.Y.Z or X.Y.Z-rc.N");
  }
  return { distTag, tag, version };
}

/** @param {string} archive */
function archiveDetails(archive) {
  if (!existsSync(archive)) fail(`archive does not exist: ${archive}`);
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/") || entry.includes("../")) fail("archive has an unsafe file path");
      return entry.slice("package/".length);
    })
    .sort();
  if (files.length === 0 || new Set(files).size !== files.length) fail("archive has an invalid file shape");
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
  );
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    fail("archive package metadata is incomplete");
  }
  return {
    files,
    packageName: manifest.name,
    packageVersion: manifest.version,
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  };
}

/** @param {{ packageName: string, packageVersion: string }} details @param {{ version: string }} release */
function assertPackageBinding(details, release) {
  if (details.packageName !== "@dvmkit/sdk") fail("archive package name is not @dvmkit/sdk");
  if (details.packageVersion !== release.version) fail("archive package version does not match the tag");
}

/** @param {any} value */
function isDigestManifest(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.artifact === "string" &&
    typeof value.distTag === "string" &&
    Array.isArray(value.files) &&
    value.files.every((/** @type {unknown} */ entry) => typeof entry === "string") &&
    typeof value.packageName === "string" &&
    typeof value.packageVersion === "string" &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256) &&
    typeof value.tag === "string"
  );
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release artifact: ${message}`);
  process.exit(1);
}
