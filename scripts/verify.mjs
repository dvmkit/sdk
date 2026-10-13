#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { SAFE_DATABASE_NAME } from "./safe-database-name.mjs";
import { dispatchVerification } from "./verify-dispatch.mjs";

const root = resolve(import.meta.dirname, "..");
const requireDatabase = process.argv.includes("--require-database");
const cleanSource = process.argv.includes("--clean-source");
const knownArguments = new Set(["--require-database", "--clean-source"]);
const unknown = process.argv.slice(2).filter((argument) => !knownArguments.has(argument));
if (unknown.length > 0) fail(`unknown argument: ${unknown[0]}`);
if (cleanSource && process.env.DVMKIT_SDK_CLEAN_SOURCE !== "1") {
  fail("--clean-source is internal to the isolated clean-install gate");
}

const npmCli =
  process.env.npm_execpath ??
  fail("run the gate as `npm run verify` so the active npm executable is unambiguous");

const databaseUrl = process.env.DATABASE_URL;
if (requireDatabase && !databaseUrl) {
  fail("--require-database was passed but DATABASE_URL is unset, so the database suite would silently verify nothing");
}
if (requireDatabase && databaseUrl && !SAFE_DATABASE_NAME.test(databaseUrl)) {
  fail(
    `--require-database was passed but DATABASE_URL does not name a database the suite accepts (must match ${SAFE_DATABASE_NAME}), so the database suite would silently skip every migrated test`
  );
}

// Mint-dependent suites skip without the local mint; the complete gate makes that a failure.
if (requireDatabase) process.env.DVMKIT_SDK_REQUIRE_MINT = "1";

/** @type {string[]} */
const results = [];
dispatchVerification({
  cleanSource,
  requireDatabase,
  databaseUrl,
  packedSafetyReport: process.env.DVMKIT_SDK_PACKED_SAFETY_REPORT,
  run: runStep,
});
report(results);
const skipped = cleanSource
  ? results.filter((line) => line.includes("SKIPPED"))
  : databaseUrl
    ? []
    : ["database tests: SKIPPED (DATABASE_URL is unset)"];
if (skipped.length > 0) {
  console.log(
    `verify passed with ${skipped.length} step(s) skipped — those verified nothing, so do not report them as green`
  );
} else {
  console.log("verify passed: every gate step ran");
}

/** @param {{ name: string, args: string[], skip?: string }} step */
function runStep(step) {
  if (step.skip) {
    results.push(`${step.name}: SKIPPED (${step.skip})`);
    console.log(`\n=== ${step.name}: skipped, ${step.skip} ===`);
    return;
  }
  console.log(`\n=== ${step.name} ===`);
  const started = Date.now();
  const result = spawnSync(process.execPath, [npmCli, ...step.args], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`${step.name} could not be started: ${result.error.message}`);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.status !== 0) {
    results.push(`${step.name}: FAILED after ${seconds}s`);
    report(results);
    fail(`${step.name} failed`);
  }
  results.push(`${step.name}: ok in ${seconds}s`);
}

/** @param {string[]} lines */
function report(lines) {
  console.log("\n=== verify summary ===");
  for (const line of lines) console.log(`  ${line}`);
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`verify: ${message}`);
  process.exit(1);
}
