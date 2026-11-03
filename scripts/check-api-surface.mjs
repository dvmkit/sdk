#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasBreakingMarker, inspectSurface, publicEntryPoints, validateBaseline } from "./api-surface.mjs";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex < 0 ? resolve(import.meta.dirname, "..") : resolve(args.splice(rootIndex, 2)[1]);
const baselineTag = args[0] === "--baseline-from-tag" ? args[1] : undefined;
if (args.length && !(args.length === 1 && args[0] === "--write") && !(args.length === 2 && baselineTag)) {
  throw new Error("use --write, --baseline-from-tag vX.Y.Z, or no arguments; optionally --root directory");
}
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (baselineTag) {
  if (!/^v\d+\.\d+\.\d+$/u.test(baselineTag)) throw new Error("baseline must come from a stable vX.Y.Z release tag");
  const released = JSON.parse(execFileSync("git", ["show", `${baselineTag}:api-surface.json`], { cwd: root, encoding: "utf8" }));
  validateBaseline(released, manifest.name);
  if (`v${released.version}` !== baselineTag) throw new Error("release tag version differs from its signature snapshot");
  writeFileSync(join(root, "api-baseline.json"), `${JSON.stringify(released, null, 2)}\n`);
  console.log(`API comparison baseline advanced to ${baselineTag}; run check:api`);
} else {
  const expected = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8"));
  const baseline = JSON.parse(readFileSync(join(root, "api-baseline.json"), "utf8"));
  validateBaseline(baseline, manifest.name);
  const actual = inspectSurface(root, manifest);
  const changes = [];
  for (const previous of baseline.exports) {
    if (!publicEntryPoints.includes(previous.export)) continue;
    const current = actual.find((entry) => entry.export === previous.export);
    for (const [name, signature] of Object.entries(previous.signatures)) {
      if (JSON.stringify(current?.signatures?.[name]) !== JSON.stringify(signature)) changes.push(`${previous.export}:${name}`);
    }
  }
  if (changes.length && !hasBreakingMarker(readFileSync(join(root, "CHANGELOG.md"), "utf8"), manifest.version, baseline.version)) {
    throw new Error(`public signatures changed without a breaking-change section in current release notes: ${changes.join(", ")}`);
  }
  if (args[0] === "--write") {
    writeFileSync(join(root, "api-surface.json"), `${JSON.stringify({ ...expected, exports: actual }, null, 2)}\n`);
    console.log("updated api-surface.json; compatibility baseline unchanged");
  } else {
    if (JSON.stringify(actual) !== JSON.stringify(expected.exports)) throw new Error("declaration surface changed; rebuild and run node scripts/check-api-surface.mjs --write, then npm run docs:api");
    const count = actual.reduce((sum, entry) => sum + entry.names.length, 0);
    console.log(`SDK API surface ok: ${count} named exports; signatures and stability checked against ${baseline.version}`);
  }
}
