#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
const root = resolve(import.meta.dirname, "..");
const expected = JSON.parse(readFileSync(join(root, "api-surface.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const actual = [];
for (const [name, target] of Object.entries(manifest.exports)) {
  const declaration = join(root, target.types);
  const program = ts.createProgram({ rootNames: [declaration], options: { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true, target: ts.ScriptTarget.ES2024 } });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(declaration);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`could not inspect ${target.types}`);
  actual.push({ export: name, declaration: target.types, names: checker.getExportsOfModule(symbol).map((item) => item.getName()).sort() });
}
if (JSON.stringify(actual) !== JSON.stringify(expected.exports)) throw new Error("declaration names changed");
const count = expected.exports.reduce(
  (/** @type {number} */ sum, /** @type {{ names: string[] }} */ entry) => sum + entry.names.length,
  0
);
console.log(`SDK API surface ok: ${count} named exports`);
