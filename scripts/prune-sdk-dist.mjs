#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { assertModuleSpecifierSyntaxCoverage, collectModuleSpecifiers } from "./module-specifiers.mjs";
const packageRoot = resolve(import.meta.dirname, "..");
const distRoot = join(packageRoot, "dist");
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
/** @type {(dir: string) => string[]} */
const walk = (dir) => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]) : [];
const files = walk(distRoot).filter((/** @type {string} */ file) => /\.(?:js|d\.ts)$/.test(file)).map((/** @type {string} */ file) => relative(packageRoot, file));
const reachable = new Set();
const queue = Object.values(manifest.exports).flatMap((target) => Object.values(target).map((path) => path.replace(/^\.\//, "")));
assertModuleSpecifierSyntaxCoverage();
while (queue.length > 0) {
  const file = queue.shift();
  if (reachable.has(file)) continue;
  if (!files.includes(file)) throw new Error(`SDK dist graph is missing ${file}`);
  reachable.add(file);
  const absolute = join(packageRoot, file);
  const source = ts.createSourceFile(absolute, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".d.ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  for (const specifier of collectModuleSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const js = relative(packageRoot, resolve(dirname(absolute), specifier));
    const declaration = js.replace(/\.js$/, ".d.ts");
    const resolved =
      file.endsWith(".d.ts") && files.includes(declaration)
        ? declaration
        : files.includes(js)
          ? js
          : files.includes(declaration)
            ? declaration
            : undefined;
    if (!resolved) throw new Error(`${file} imports missing SDK dist file ${specifier}`);
    queue.push(resolved);
  }
}
const extras = files.filter((file) => !reachable.has(file));
for (const file of extras) unlinkSync(join(packageRoot, file));
console.log(`pruned SDK dist: ${reachable.size} reachable files, ${extras.length} removed`);
