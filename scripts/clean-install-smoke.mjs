#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { dispatchCleanInstall } from "./clean-install-dispatch.mjs";

const root = resolve(import.meta.dirname, "..");
const requireDatabase = process.argv.includes("--require-database");
const unknown = process.argv.slice(2).filter((argument) => argument !== "--require-database");
if (unknown.length > 0) fail(`unknown argument: ${unknown[0]}`);
const temporaryRoot = mkdtempSync(join(tmpdir(), "dvmkit-sdk-clean-install-"));
/** @type {string | undefined} */
let failure;

try {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (!files.includes("package-lock.json")) {
    throw new Error("package-lock.json is not committed, so a clean install cannot be reproduced");
  }

  for (const relative of files) {
    const source = join(root, relative);
    if (lstatSync(source).isSymbolicLink()) throw new Error(`refusing source symlink ${relative}`);
    const destination = join(temporaryRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination);
  }

  const installStarted = Date.now();
  dispatchCleanInstall({
    requireDatabase,
    npm: (args) => {
      npm(args, temporaryRoot, {
        ...process.env,
        ...(args[0] === "ci"
          ? {}
          : {
              DVMKIT_SDK_CLEAN_SOURCE: "1",
              DVMKIT_SDK_PACKED_SAFETY_REPORT: join(root, ".artifacts", "public-safety-packed-report.json"),
            }),
      });
      if (args[0] === "ci") console.log(`clean install: locked dependencies installed in ${secondsSince(installStarted)}s`);
    },
  });
  publishVerifiedDist(temporaryRoot);
  console.log(
    `clean install ok: ${files.length} repository files, locked install, complete source gate, packed-package checks, verified dist published`
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
if (failure) fail(failure);

/** @param {string} sourceRoot */
function publishVerifiedDist(sourceRoot) {
  const source = join(sourceRoot, "dist");
  if (!lstatSync(source).isDirectory()) throw new Error("the clean build did not produce a dist directory");

  const artifacts = join(root, ".artifacts");
  const staged = join(artifacts, `verified-dist-${process.pid}`);
  const destination = join(root, "dist");
  mkdirSync(artifacts, { recursive: true });
  rmSync(staged, { recursive: true, force: true });
  try {
    cpSync(source, staged, { recursive: true });
    rmSync(destination, { recursive: true, force: true });
    renameSync(staged, destination);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

/** @param {string[]} args @param {string} cwd @param {NodeJS.ProcessEnv} env */
function npm(args, cwd, env) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("run this check through npm so the active npm executable is unambiguous");
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    env: { ...env, npm_config_audit: "false", npm_config_fund: "false" },
    stdio: "inherit",
  });
  if (result.error) throw new Error(`npm ${args.join(" ")} could not be started: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`npm ${args.join(" ")} failed`);
}

/** @param {number} started */
function secondsSince(started) {
  return ((Date.now() - started) / 1000).toFixed(1);
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`clean install: ${message}`);
  process.exit(1);
}
