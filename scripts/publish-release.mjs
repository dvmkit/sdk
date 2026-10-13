#!/usr/bin/env node
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const defaultRegistry = "https://registry.npmjs.org";
const expectedPackageName = "@dvmkit/sdk";
const defaultTimeoutMs = 30 * 60_000;
const requestTimeoutMs = 30_000;
const defaultRetryDelayMs = 15_000;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/** Publishes an archive once, or accepts an exact prior registry publication after a disrupted run. */
/**
 * @param {{ archive: string, distTag: string, fetchFn?: typeof fetch, publishFn?: (archive: string, distTag: string) => number | Promise<number>, registry?: string, check?: boolean, timeoutMs?: number, nowFn?: () => number, attempts?: number, retryDelayMs?: number, waitFn?: (ms: number) => Promise<void> }} options
 */
export async function publishRelease({
  archive,
  distTag,
  fetchFn = fetch,
  publishFn = publishArchive,
  registry = defaultRegistry,
  check = false,
  timeoutMs = defaultTimeoutMs,
  nowFn = () => performance.now(),
  attempts = Infinity,
  retryDelayMs = defaultRetryDelayMs,
  waitFn = wait,
}) {
  if (!(timeoutMs > 0 && timeoutMs <= defaultTimeoutMs)) throw new Error("invalid release timeout");
  if (!(attempts === Infinity || (Number.isInteger(attempts) && attempts > 0))) throw new Error("invalid attempts");
  if (!(retryDelayMs >= 0 && Number.isFinite(retryDelayMs))) throw new Error("invalid retry delay");
  const absoluteArchive = resolve(archive);
  const local = archiveIdentity(absoluteArchive);
  assertReleaseIdentity(local, distTag);
  const expected = { ...local, distTag };
  /** @param {number} deadline */
  const inspect = (deadline) => inspectPublishedRelease({ expected, fetchFn, registry, timeoutMs: Math.min(requestTimeoutMs, deadline - nowFn()) });
  // Preflight is read-only. The visibility window starts after the single upload returns.
  const initialDeadline = nowFn() + timeoutMs;
  const initial = await inspect(initialDeadline);
  if (initial === "match") {
    process.stdout.write(`npm release already matches ${local.packageName}@${local.packageVersion} (${distTag})\n`);
    return "already-published";
  }
  if (initial === "mismatch") throw new Error("existing npm release does not match the reviewed archive and dist-tag");

  let publishStatus;
  if (initial === "missing" && !check) publishStatus = await publishFn(absoluteArchive, distTag);
  const deadline = initial === "missing" && !check ? nowFn() + timeoutMs : initialDeadline;
  for (let attempt = 1; attempt <= attempts && nowFn() < deadline; attempt += 1) {
    const observed = await inspect(deadline);
    if (nowFn() >= deadline) break;
    if (observed === "match") {
      process.stdout.write(`npm release matches ${local.packageName}@${local.packageVersion} (${distTag})\n`);
      return initial === "missing" && !check ? "published" : "already-published";
    }
    if (observed === "mismatch") throw new Error("published npm release does not match the reviewed archive and dist-tag");
    if (attempt < attempts && nowFn() < deadline) await waitFn(Math.min(retryDelayMs, 15_000, deadline - nowFn()));
  }
  throw new Error(`exact npm release visibility deadline exhausted (publish exit ${publishStatus ?? "not attempted"}); npm may still be processing. Run read-only --check verification before rerunning the immutable signed tag; do not upload again while pending`);
}

/** Returns whether the exact version is absent, pending its tarball, byte-for-byte matching, or conflicting. */
/**
 * @param {{ expected: { packageName: string, packageVersion: string, sha256: string, distTag: string }, fetchFn?: typeof fetch, registry?: string, timeoutMs?: number }} options
 */
export async function inspectPublishedRelease({ expected, fetchFn = fetch, registry = defaultRegistry, timeoutMs = requestTimeoutMs }) {
  return boundedRequest(async (signal) => {
    const registryUrl = new URL(registry);
    const packageUrl = new URL(`${encodeURIComponent(expected.packageName)}?release_check=${Date.now()}`, registryUrl);
    const metadataResponse = await fetchFn(packageUrl, {
      signal,
      cache: "no-store",
      headers: {
        accept: "application/vnd.npm.install-v1+json",
        "cache-control": "no-cache",
      },
      redirect: "error",
    });
    if (metadataResponse.status === 404) return "missing";
    if (!metadataResponse.ok) throw new Error(`npm registry metadata request failed (${metadataResponse.status})`);
    const metadata = await metadataResponse.json();
    const version = metadata?.versions?.[expected.packageVersion];
    if (!version) return "missing";
    if (
      version.name !== expected.packageName ||
      version.version !== expected.packageVersion ||
      metadata?.["dist-tags"]?.[expected.distTag] !== expected.packageVersion
    ) {
      return "mismatch";
    }
    const tarball = version.dist?.tarball;
    if (typeof tarball !== "string") return "mismatch";
    const tarballUrl = new URL(tarball);
    if (tarballUrl.origin !== registryUrl.origin) return "mismatch";
    const tarballResponse = await fetchFn(tarballUrl, { signal, cache: "no-store", redirect: "error" });
    if (tarballResponse.status === 404) return "pending";
    if (!tarballResponse.ok) throw new Error(`npm registry tarball request failed (${tarballResponse.status})`);
    const remoteBytes = Buffer.from(await tarballResponse.arrayBuffer());
    const integrity = version.dist?.integrity;
    if (integrity !== undefined && integrity !== `sha512-${createHash("sha512").update(remoteBytes).digest("base64")}`) return "mismatch";
    return sha256(remoteBytes) === expected.sha256 ? "match" : "mismatch";
  }, Math.min(timeoutMs, requestTimeoutMs));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const archive = required(options, "archive");
  const distTag = required(options, "dist-tag");
  await publishRelease({ archive, distTag, check: options.check === "true" });
}

/** @param {string} archive */
function archiveIdentity(archive) {
  const manifest = JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" }));
  return {
    packageName: manifest.name,
    packageVersion: manifest.version,
    sha256: sha256(readFileSync(archive)),
  };
}

/** @param {{ packageName: string, packageVersion: string }} identity @param {string} distTag */
function assertReleaseIdentity(identity, distTag) {
  if (identity.packageName !== expectedPackageName) throw new Error(`archive package name is not ${expectedPackageName}`);
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(identity.packageVersion)) {
    if (distTag !== "latest") throw new Error("stable versions must use npm dist-tag latest");
  } else if (/^[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$/u.test(identity.packageVersion)) {
    if (distTag !== "next") throw new Error("release candidates must use npm dist-tag next");
  } else {
    throw new Error("archive version must be stable or an rc");
  }
}

/** @param {string} archive @param {string} distTag */
function publishArchive(archive, distTag) {
  const publisher = resolve(import.meta.dirname, "pinned-publish-npm.mjs");
  const result = spawnSync(process.execPath, [publisher, "publish", archive, "--tag", distTag], { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/** @param {string[]} args @returns {Record<string, string>} */
function parseArguments(args) {
  /** @type {Record<string, string>} */
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (key === "--check") {
      if (result.check) throw new Error("duplicate argument: --check");
      result.check = "true";
      index -= 1;
      continue;
    }
    if (key !== "--archive" && key !== "--dist-tag") throw new Error(`unknown argument: ${key ?? ""}`);
    if (Object.hasOwn(result, key.slice(2))) throw new Error(`duplicate argument: ${key}`);
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--")) throw new Error(`invalid argument: ${key ?? ""}`);
    result[key.slice(2)] = value;
  }
  return result;
}

/** @param {Record<string, string>} options @param {string} name @returns {string} */
function required(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

/** @param {Buffer} bytes */
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** @template T @param {(signal: AbortSignal) => Promise<T>} operation @param {number} timeoutMs */
async function boundedRequest(operation, timeoutMs) {
  if (!(timeoutMs > 0)) throw new Error("npm registry request deadline exhausted; npm may still be processing; use read-only --check before recovery");
  const controller = new AbortController();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("npm registry request/body deadline exhausted; npm may still be processing; use read-only --check before recovery"));
          controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // A missing response may still have an unread streaming body.
    controller.abort();
  }
}

/** @param {number} milliseconds @returns {Promise<void>} */
function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isMainModule() {
  return typeof process.argv[1] === "string" && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

/** @param {string} message */
function fail(message) {
  console.error(`release publish: ${message}`);
  process.exitCode = 1;
}
