import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { SAFE_DATABASE_NAME } from "./safe-database-name.mjs";

export const CLOSE_TEST = "shares one close search between a caller poll and the concurrent sweep";
const CLOSE_FILE = "src/sdk/server/__tests__/hosted-tempo-close-route.db.test.ts";
const root = resolve(import.meta.dirname, "..");
const artifacts = resolve(root, ".artifacts/tempo-close-stress");

/** @typedef {{ success: boolean, testResults: { assertionResults: { fullName: string, status: string, failureMessages?: string[] }[] }[] }} TestReport */

/** @param {TestReport} report @param {{ negativeControl?: boolean }} options */
export function assertTempoCloseReport(report, { negativeControl = false } = {}) {
  const results = report.testResults.flatMap(file => file.assertionResults)
    .filter(test => test.fullName.endsWith(CLOSE_TEST));
  if (negativeControl) {
    if (report.success || results.length !== 1 || results[0].status !== "failed" ||
        !results[0].failureMessages?.some(message => /called 1 times, but got 2 times/.test(message))) {
      throw new Error("Negative control must fail because two searches started");
    }
  } else if (!report.success || results.length !== 1 || results[0].status !== "passed") {
    throw new Error("The close-sharing case must run and pass; skipped runs prove nothing");
  }
}

async function stress() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !SAFE_DATABASE_NAME.test(databaseUrl)) {
    throw new Error("Tempo close stress requires DATABASE_URL naming an accepted test database");
  }
  mkdirSync(artifacts, { recursive: true });
  const database = `dvmkit_test_${randomBytes(4).toString("hex")}`;
  const focusedUrl = new URL(databaseUrl);
  focusedUrl.pathname = `/${database}`;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let created = false;
  /** @type {Set<import('node:child_process').ChildProcess>} */
  const children = new Set();

  /** @param {string} label @param {boolean} focused @param {boolean} negativeControl @param {string} sourceRoot */
  async function run(label, focused, negativeControl = false, sourceRoot = root) {
    const log = resolve(artifacts, `${label}.log`);
    const reportPath = resolve(artifacts, `${label}.json`);
    rmSync(reportPath, { force: true });
    const fd = openSync(log, "w");
    const child = spawn(process.execPath, [
      resolve(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.db.config.ts",
      ...(focused ? [CLOSE_FILE, "-t", CLOSE_TEST] : []),
      "--reporter=json", `--outputFile=${reportPath}`,
    ], { cwd: sourceRoot, env: { ...process.env, DATABASE_URL: focused ? focusedUrl.href : databaseUrl },
      stdio: ["ignore", fd, fd] });
    closeSync(fd);
    children.add(child);
    try {
      const status = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (negativeControl ? status !== 1 : status !== 0) {
        throw new Error(`${label} exited with unexpected status ${status}`);
      }
      assertTempoCloseReport(JSON.parse(readFileSync(reportPath, "utf8")), { negativeControl });
      console.log(`${label}: ${negativeControl ? "detected two searches" : "passed"}`);
    } catch (error) {
      console.error(readFileSync(log, "utf8"));
      throw error;
    } finally {
      children.delete(child);
    }
  }

  try {
    await client.query(`CREATE DATABASE "${database}"`);
    created = true;
    const controlRoot = mkdtempSync(join(tmpdir(), "tempo-close-control-"));
    try {
      const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        { cwd: root, maxBuffer: 16 * 1024 * 1024 }).toString("utf8").split("\0").filter(Boolean);
      for (const relative of files) {
        const sourceFile = resolve(root, relative);
        if (lstatSync(sourceFile).isSymbolicLink()) throw new Error(`Refusing source symlink ${relative}`);
        const destination = resolve(controlRoot, relative);
        mkdirSync(dirname(destination), { recursive: true });
        cpSync(sourceFile, destination);
      }
      symlinkSync(resolve(root, "node_modules"), resolve(controlRoot, "node_modules"), "dir");
      const sourcePath = resolve(controlRoot, "src/sdk/server/mpp-setup.ts");
      const source = readFileSync(sourcePath, "utf8");
      const lookup = "const existing = finalizedCloseSearches.get(key);";
      if (source.split(lookup).length !== 2) throw new Error("Cannot locate shared-search lookup");
      writeFileSync(sourcePath, source.replace(lookup, "const existing = undefined;"));
      await run("negative-control", true, true, controlRoot);
    } finally {
      rmSync(controlRoot, { recursive: true, force: true });
    }

    let focusedDone = false;
    let failed = false;
    /** @type {unknown} */
    let failure;
    /** @param {() => Promise<void>} work */
    const guard = async (work) => {
      try {
        await work();
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
        for (const child of children) child.kill("SIGTERM");
      }
    };
    await Promise.all([
      guard(async () => {
        let iteration = 0;
        do {
          await run(`full-${++iteration}`, false);
        } while (!focusedDone && !failed);
      }),
      guard(async () => {
        try {
          for (let iteration = 1; iteration <= 20 && !failed; iteration++) {
            await run(`focused-${iteration}`, true);
          }
        } finally {
          focusedDone = true;
        }
      }),
    ]);
    if (failed) throw failure;
    console.log("Twenty consecutive close-sharing cases passed alongside the full database suite");
  } finally {
    try {
      if (created) await client.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await client.end();
    }
  }
}

const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  stress().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
