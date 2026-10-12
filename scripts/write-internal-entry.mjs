#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const outputDirectory = join(root, "dist", "internal");
const callerRuntimeNames = runtimeExportNames(join(outputDirectory, "caller.js"));
const serverRuntimeNames = runtimeExportNames(join(outputDirectory, "server.js"));
if (callerRuntimeNames.length === 0) throw new Error("internal caller build has no runtime exports");
if (serverRuntimeNames.length === 0) throw new Error("internal server build has no runtime exports");

// Explicit runtime re-exports let esbuild resolve each imported name to one half without loading
// the other. `export *` is retained in the declaration wrapper so type-only names also flow.
const runtimeEntry = [
  `export { ${callerRuntimeNames.sort().join(", ")} } from "./caller.js";`,
  `export { ${serverRuntimeNames.sort().join(", ")} } from "./server.js";`,
  "",
].join("\n");
const declarationEntry = 'export * from "./caller.js";\nexport * from "./server.js";\n';

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, "index.js"), runtimeEntry);
writeFileSync(join(outputDirectory, "index.d.ts"), declarationEntry);
console.log("wrote tree-shakeable internal entry");

/** @param {string} path */
function runtimeExportNames(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  return source.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) return [];
    if (!ts.isNamedExports(statement.exportClause)) return [];
    return statement.exportClause.elements.map((element) => element.name.text);
  });
}
