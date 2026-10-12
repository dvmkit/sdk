#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const expectedPackageName = "@dvmkit/sdk";
const defaultTimeoutMs = 30 * 60_000;
const installAttemptTimeoutMs = 2 * 60_000;
const defaultRetryDelayMs = 15_000;

if (isMainModule()) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Installs one exact published SDK version, retrying only its transient registry propagation errors.
 * `--prefer-online` makes every attempt revalidate npm's cached package listing: the registry marks it
 * fresh for longer than the whole retry window, so a stale first read would otherwise be replayed by
 * every retry.
 */
/**
 * @param {{ version: string, prefix: string, timeoutMs?: number, attemptTimeoutMs?: number, nowFn?: () => number, attempts?: number, retryDelayMs?: number, waitFn?: (ms: number) => Promise<void>, runFn?: (args: string[], prefix: string, timeoutMs: number) => { status: number | null, output: string } | Promise<{ status: number | null, output: string }> }} options
 */
export async function installPublishedRelease({
  version,
  prefix,
  timeoutMs = defaultTimeoutMs,
  attemptTimeoutMs = installAttemptTimeoutMs,
  nowFn = () => performance.now(),
  attempts = Infinity,
  retryDelayMs = defaultRetryDelayMs,
  waitFn = wait,
  runFn = runNpm,
}) {
  assertVersion(version);
  if (!(timeoutMs > 0 && timeoutMs <= defaultTimeoutMs)) throw new Error("invalid install timeout");
  if (!(attemptTimeoutMs > 0 && attemptTimeoutMs <= installAttemptTimeoutMs)) throw new Error("invalid attempt timeout");
  if (!(attempts === Infinity || (Number.isInteger(attempts) && attempts >= 1))) throw new Error("attempts must be a positive integer");
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new Error("retry delay must be non-negative");

  const specifier = `${expectedPackageName}@${version}`;
  const args = ["install", "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", specifier];
  const deadline = nowFn() + timeoutMs;
  for (let attempt = 1; attempt <= attempts && nowFn() < deadline; attempt += 1) {
    const budget = Math.min(attemptTimeoutMs, deadline - nowFn());
    const result = await runFn(args, prefix, budget);
    if (nowFn() >= deadline) break;
    if (result.status === 0) return;
    if (!isExactPropagationError(result.output, specifier)) {
      throw new Error(`npm install failed for ${specifier}: ${result.output.trim() || `exit ${result.status ?? "unknown"}`}`);
    }
    if (attempt === attempts) {
      throw new Error(`npm registry did not expose ${specifier} after ${attempts} install attempts`);
    }
    if (result.output) process.stderr.write(result.output);
    await waitFn(Math.min(retryDelayMs, 15_000, Math.max(0, deadline - nowFn())));
  }
  throw new Error(`npm registry install deadline exhausted for ${specifier}; npm may still be processing. Run read-only release --check before immutable-tag recovery`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await installPublishedRelease({ version: required(options, "version"), prefix: required(options, "prefix") });
}

/** @param {string[]} args @param {string} prefix @param {number} timeoutMs */
function runNpm(args, prefix, timeoutMs) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: prefix,
      detached: true,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const stopGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ESRCH") throw error;
      }
    };
    const timer = setTimeout(() => {
      // npm descendants may retain pipes after the parent exits; kill the whole process group.
      try { stopGroup(); } catch (error) { reject(error); return; }
      reject(new Error("npm install subprocess deadline exhausted (including descendants); use read-only release --check before recovery"));
    }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => {
      clearTimeout(timer);
      // A descendant can outlive npm even after closing its inherited pipes.
      try { stopGroup(); } catch (error) { reject(error); return; }
      resolvePromise({ status, output });
    });
  });
}

/** @param {string} output @param {string} specifier */
function isExactPropagationError(output, specifier) {
  const escapedSpecifier = specifier.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const version = specifier.slice(`${expectedPackageName}@`.length);
  const exactTarball = `https://registry.npmjs.org/${expectedPackageName}/-/sdk-${version}.tgz`;
  const targetUnavailable = new RegExp(
    `No matching version found for ${escapedSpecifier}(?:\\.(?=\\s|$)|(?=\\s|$))|404\\s+['"]${escapedSpecifier}['"]\\s+is not in this registry\\.`,
    "u"
  );
  const npmRecords = output.split(/\r?\n/u).filter((line) => /^npm (?:ERR!|error) /u.test(line));
  const errorCodes = npmRecords.flatMap((line) => [...line.matchAll(/ code ([A-Z0-9_]+)/gu)].map((match) => match[1]));
  if (errorCodes.length === 0 || errorCodes.some((code) => code !== "E404" && code !== "ETARGET")) return false;
  const urls = npmRecords.flatMap((line) => [...line.matchAll(/https?:\/\/[^\s]+/gu)].map((match) => match[0]));
  if (urls.some((url) => url !== exactTarball)) return false;
  const namedTargets = npmRecords.filter(
    (line) => line.includes("No matching version found for") || line.includes("is not in this registry")
  );
  if (namedTargets.some((line) => !targetUnavailable.test(line))) return false;
  return (
    errorCodes.some((code) => code === "E404" || code === "ETARGET") &&
    npmRecords.some((line) => targetUnavailable.test(line) || line.includes(exactTarball))
  );
}

/** @param {string} version */
function assertVersion(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/u.test(version)) {
    throw new Error("version must be stable or an rc");
  }
}

/** @param {string[]} args @returns {Record<string, string>} */
function parseArguments(args) {
  /** @type {Record<string, string>} */
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (key !== "--version" && key !== "--prefix") throw new Error(`unknown argument: ${key ?? ""}`);
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

/** @param {number} milliseconds @returns {Promise<void>} */
function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isMainModule() {
  return typeof process.argv[1] === "string" && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

/** @param {string} message */
function fail(message) {
  console.error(`release consumer install: ${message}`);
  process.exitCode = 1;
}
