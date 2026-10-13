#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const temporaryRoot = mkdtempSync(join(tmpdir(), "dvmkit-sdk-package-"));

try {
  const first = packInto(join(temporaryRoot, "first"));
  const second = packInto(join(temporaryRoot, "second"));
  if (first.sha256 !== second.sha256) {
    fail("two consecutive packs produced different SHA-256 digests, so the release artifact is not reproducible");
  }
  if (JSON.stringify(first.files) !== JSON.stringify(second.files)) {
    fail("two consecutive packs produced different file shapes");
  }

  const { files } = first;
  const required = [
    "LICENSE",
    "NOTICE",
    "recipes/postgres/financial-export-v1.sql",
    "README.md",
    "package.json",
    ...Object.values(manifest.exports).flatMap((target) =>
      Object.values(target).map((path) => path.replace(/^\.\//u, ""))
    ),
  ];
  for (const path of new Set(required)) {
    if (!files.includes(path)) fail(`packed package is missing ${path}`);
  }

  const forbidden = files.filter(
    (path) =>
      path.endsWith(".map") ||
      path.endsWith(".tsbuildinfo") ||
      /(?:^|\/)(?:src|test|scripts|docs|coverage|node_modules|\.github|\.tooling|\.artifacts)(?:\/|$)/u.test(path)
  );
  if (forbidden.length > 0) fail(`packed package contains forbidden paths: ${forbidden.join(", ")}`);

  const packed = first.manifest;
  assertNoLifecycleHooks(packed);
  if (packed.name !== manifest.name || packed.version !== manifest.version) {
    fail("packed manifest identity differs from the repository manifest");
  }
  if (packed.type !== "module") fail("packed manifest must stay an ES module package");
  if (packed.sideEffects !== false) fail("packed manifest must declare every built module side-effect-free");
  if (packed.license !== "Apache-2.0") fail("packed manifest must keep its Apache-2.0 license field");
  if (packed.publishConfig?.access !== "public") fail("packed manifest must publish with public access");
  if (typeof packed.repository?.url !== "string" || !packed.repository.url.startsWith("git+https://")) {
    fail("packed manifest must carry an https repository url");
  }
  if (JSON.stringify(packed.exports) !== JSON.stringify(manifest.exports)) {
    fail("packed manifest exports differ from the repository manifest");
  }
  const declaredEntries = Object.keys(packed.exports).sort();
  // `./internal` is declared but unsupported: it exists so the dvmkit platform can share this
  // source instead of forking it, and it carries no stability promise. It is pinned here with the
  // three public entries so that adding or dropping an entry point stays a deliberate act.
  if (JSON.stringify(declaredEntries) !== JSON.stringify([".", "./internal", "./server", "./testing"])) {
    fail(
      `packed manifest must expose exactly ., ./internal, ./server and ./testing; found ${declaredEntries.join(", ")}`
    );
  }
  for (const field of ["dependencies", "optionalDependencies"]) {
    if (JSON.stringify(packed[field]) !== JSON.stringify(manifest[field])) {
      fail(`packed manifest ${field} differ from the repository manifest`);
    }
  }
  const floating = Object.entries({ ...packed.dependencies, ...packed.optionalDependencies }).filter(
    ([, range]) => !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u.test(range)
  );
  if (floating.length > 0) {
    fail(`installed dependencies must be exact versions: ${floating.map(([name]) => name).join(", ")}`);
  }

  console.log(
    `package ok: ${files.length} files, ${declaredEntries.length} declared entry points, two identical packs (sha256 ${first.sha256.slice(0, 12)}…)`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

/** @param {string} destination */
function packInto(destination) {
  mkdirSync(destination, { recursive: true });
  const [packed] = JSON.parse(
    npm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination, root])
  );
  const archive = join(destination, packed.filename);
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((entry) => {
      if (!entry.startsWith("package/") || entry.includes("../")) fail(`archive has an unsafe file path: ${entry}`);
      return entry.slice("package/".length);
    })
    .filter((entry) => !entry.endsWith("/"))
    .sort();
  if (files.length === 0 || new Set(files).size !== files.length) fail("archive has an invalid file shape");
  return {
    archive,
    files,
    manifest: JSON.parse(execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })),
    sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
  };
}

/** @param {any} packedManifest */
function assertNoLifecycleHooks(packedManifest) {
  const lifecycle = new Set([
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
  const found = Object.keys(packedManifest.scripts ?? {}).filter((name) => lifecycle.has(name));
  if (found.length > 0) fail(`packed manifest contains lifecycle hooks: ${found.join(", ")}`);
}

/** @param {string[]} args */
function npm(args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("run this check through npm so the active npm executable is unambiguous");
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`package: ${message}`);
  process.exit(1);
}
