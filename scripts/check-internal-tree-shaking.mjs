#!/usr/bin/env node
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const fixture = resolve(root, "test/fixtures/internal-caller-bundle.ts");

const forbidden = [
  {
    name: "Hono",
    pattern: /(?:^|\/)node_modules\/(?:@hono\/node-server|hono)\//u,
  },
  {
    name: "PostgreSQL",
    pattern: /(?:^|\/)node_modules\/(?:pg(?:-[^/]+)?|pgpass|postgres-[^/]+|split2|xtend)\//u,
  },
  {
    name: "Undici",
    pattern: /(?:^|\/)node_modules\/undici\//u,
  },
  {
    name: "x402 core server/facilitator",
    pattern: /(?:^|\/)node_modules\/@x402\/core\/dist\/(?:cjs|esm)\/(?:server|facilitator)\//u,
  },
  {
    name: "x402 EVM batch facilitator",
    pattern:
      /(?:^|\/)node_modules\/@x402\/evm\/dist\/(?:cjs|esm)\/batch-settlement\/facilitator\//u,
  },
];

const result = await build({
  absWorkingDir: root,
  bundle: true,
  entryPoints: [fixture],
  format: "esm",
  legalComments: "none",
  logLevel: "silent",
  metafile: true,
  platform: "node",
  target: "node22",
  write: false,
});

const parsedInputPaths = Object.keys(result.metafile.inputs).map(normalizePath);
const retainedInputPaths = [
  ...new Set(
    Object.values(result.metafile.outputs).flatMap((builtOutput) =>
      Object.entries(builtOutput.inputs)
        .filter(([, contribution]) => contribution.bytesInOutput > 0)
        .map(([path]) => normalizePath(path))
    )
  ),
];
const output = result.outputFiles.map((file) => file.text).join("\n");
const found = forbidden.flatMap(({ name, pattern }) => {
  const inputs = retainedInputPaths.filter((path) => pattern.test(path));
  const markerFound = pattern.test(output);
  return inputs.length > 0 || markerFound ? [`${name}: ${inputs.join(", ") || "output marker"}`] : [];
});

if (found.length > 0) {
  fail(`caller fixture retained server modules:\n${found.map((line) => `  ${line}`).join("\n")}`);
}
if (!output.includes("callerSurface")) fail("caller fixture exports were removed from the bundle");

console.log(
  `internal tree shaking ok: ${Buffer.byteLength(output)} byte caller bundle, ${retainedInputPaths.length} retained of ${parsedInputPaths.length} parsed inputs, no server modules`
);

/** @param {string} path */
function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`internal tree shaking: ${message}`);
  process.exit(1);
}
