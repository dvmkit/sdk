import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

export const publicEntryPoints = [".", "./server", "./testing"];

/** @param {string} root @param {string} entryPoint */
export function readStability(root, entryPoint) {
  const path = join(root, "src/sdk", entryPoint === "." ? "index.ts" : `${entryPoint.slice(2)}/index.ts`);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  /** @type {Map<string, string>} */
  const levels = new Map();
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
    for (const item of statement.exportClause.elements) {
      const tags = ts.getJSDocTags(item).filter((tag) => tag.tagName.text === "stability");
      const inherited = ts.getJSDocTags(statement).filter((tag) => tag.tagName.text === "stability");
      const selected = tags.length ? tags : inherited;
      const level = selected[0]?.comment;
      if (selected.length !== 1 || (level !== "stable" && level !== "experimental")) {
        throw new Error(`${entryPoint}:${item.name.text} needs exactly one @stability stable or @stability experimental doc comment`);
      }
      levels.set(item.name.text, level);
    }
  }
  return levels;
}

/** @param {string} root @param {string[]} declarations */
function declarationProgram(root, declarations) {
  return ts.createProgram({ rootNames: declarations.map((declaration) => join(root, declaration)), options: {
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true, target: ts.ScriptTarget.ES2024,
    // Declarations already spell out their types; this is inspection, not a
    // second typecheck. Avoid loading unrelated ambient libraries per fixture.
    noLib: true, types: [],
  } });
}

/** @param {string} root @param {string} declaration @param {ts.Program} [program] */
export function inspectDeclaration(root, declaration, program = declarationProgram(root, [declaration])) {
  const path = join(root, declaration);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(path);
  const symbol = source && checker.getSymbolAtLocation(source);
  if (!symbol) throw new Error(`could not inspect ${declaration}`);
  return { checker, symbols: checker.getExportsOfModule(symbol).sort((a, b) => a.getName().localeCompare(b.getName())) };
}

/** @param {ts.Symbol} exported @param {ts.TypeChecker} checker */
export function hasValueExport(exported, checker) {
  /** @type {Set<ts.Symbol>} */
  const aliases = new Set();
  /** @type {Map<ts.Symbol, Set<string>>} */
  const modules = new Map();

  /** @param {ts.Symbol | undefined} module @param {string} name @returns {boolean} */
  function fromModule(module, name) {
    if (!module) return false;
    const binding = checker.getExportsOfModule(module).find((symbol) => symbol.getName() === name);
    if (!binding) return false;
    const active = modules.get(module) ?? new Set();
    if (active.has(name)) return false;
    modules.set(module, active);
    active.add(name);
    try {
      const sources = module.declarations?.map((node) => node.getSourceFile()) ?? [];
      if (binding.declarations?.some((node) => sources.includes(node.getSourceFile()))) return fromSymbol(binding);
      // Star forwarding can return the original symbol without an alias node.
      // Follow value-bearing paths rather than losing an `export type *` edge.
      return sources.some((source) => source.statements.some((node) =>
        ts.isExportDeclaration(node) && !node.exportClause && !node.isTypeOnly && node.moduleSpecifier &&
        fromModule(checker.getSymbolAtLocation(node.moduleSpecifier), name)
      ));
    } finally {
      active.delete(name);
    }
  }

  /** @param {ts.Symbol} symbol @returns {boolean} */
  function fromSymbol(symbol) {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    if (!(target.flags & ts.SymbolFlags.Value)) return false;
    if (!(symbol.flags & ts.SymbolFlags.Alias)) return true;
    // Unwrapping every alias at once loses type-only export/import modifiers.
    if (aliases.has(symbol) || symbol.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)) return false;
    aliases.add(symbol);
    try {
      for (const node of symbol.declarations ?? []) {
        if (ts.isExportSpecifier(node) && node.parent.parent.moduleSpecifier) {
          return fromModule(checker.getSymbolAtLocation(node.parent.parent.moduleSpecifier), (node.propertyName ?? node.name).text);
        }
        if (ts.isImportSpecifier(node)) {
          return fromModule(checker.getSymbolAtLocation(node.parent.parent.parent.moduleSpecifier), (node.propertyName ?? node.name).text);
        }
        if (ts.isImportClause(node)) return fromModule(checker.getSymbolAtLocation(node.parent.moduleSpecifier), "default");
      }
      const immediate = checker.getImmediateAliasedSymbol(symbol);
      return immediate ? fromSymbol(immediate) : false;
    } finally {
      aliases.delete(symbol);
    }
  }

  return fromSymbol(exported);
}

/**
 * Include reachable local declarations: printing only `f(input: Options): Result`
 * would miss changes to Options or Result. Canonical names discard the bundler's
 * incidental alias suffixes. Dependency declarations remain external contracts.
 * @param {ts.Symbol} exported @param {ts.TypeChecker} checker
 */
export function signatureOf(exported, checker) {
  /** @param {ts.Symbol} symbol */
  const unalias = (symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const root = unalias(exported);
  /** @type {Map<ts.Symbol, string>} */
  const names = new Map([[root, "T0"]]);
  const pending = [root];
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  /** @type {string[]} */
  const declarations = [];

  /** @param {ts.Declaration} node */
  function isLocalTopLevel(node) {
    if (node.getSourceFile().fileName.includes("/node_modules/")) return false;
    return ts.isSourceFile(node.parent) ||
      (ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) && ts.isSourceFile(node.parent.parent.parent));
  }

  for (let index = 0; index < pending.length; index++) {
    const symbol = pending[index];
    const nodes = symbol.declarations?.filter(isLocalTopLevel) ?? [];
    if (!nodes.length) {
      // TypeScript names dependency modules with quoted absolute paths. Keep
      // their package-relative identity so a clean install has the same hash.
      let identity = symbol.getName();
      if (identity.startsWith('"') && identity.endsWith('"')) {
        const modulePath = identity.slice(1, -1).replaceAll("\\", "/");
        const marker = "/node_modules/";
        const dependency = modulePath.lastIndexOf(marker);
        if (dependency >= 0) identity = JSON.stringify(modulePath.slice(dependency + marker.length));
      }
      declarations.push(`external ${identity}`);
      continue;
    }
    for (const node of nodes) {
      const transformed = ts.transform(node, [(context) => {
        /** @type {ts.Visitor} */
        const visit = (current) => {
          if (ts.canHaveModifiers(current) && !ts.isConstructorDeclaration(current) && ts.getModifiers(current)?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)) return undefined;
          if (ts.isIdentifier(current)) {
            const found = checker.getSymbolAtLocation(current);
            const target = found && unalias(found);
            if (target && target.declarations?.some(isLocalTopLevel)) {
              if (!names.has(target)) {
                names.set(target, `T${names.size}`);
                pending.push(target);
              }
              return ts.factory.createIdentifier(/** @type {string} */ (names.get(target)));
            }
          }
          return ts.visitEachChild(current, visit, context);
        };
        return (input) => /** @type {ts.Declaration} */ (ts.visitNode(input, visit));
      }]);
      declarations.push(printer.printNode(ts.EmitHint.Unspecified, transformed.transformed[0], node.getSourceFile()));
      transformed.dispose();
    }
  }
  // Declaration-only types already encode their lack of a value. A class,
  // function or namespace behind a type-only alias needs this extra distinction.
  const availability = root.flags & ts.SymbolFlags.Value && !hasValueExport(exported, checker) ? "type-only alias\n" : "";
  return createHash("sha256").update(availability + declarations.join("\n")).digest("hex");
}

/**
 * @typedef {{export: string, declaration: string, names: string[], signatures?: Record<string, {stability: string, signature: string}>}} SurfaceEntry
 */

/** @param {string} root @param {{exports: Record<string, {types: string}>}} manifest @returns {SurfaceEntry[]} */
export function inspectSurface(root, manifest) {
  const program = declarationProgram(root, Object.values(manifest.exports).map((target) => target.types));
  return Object.entries(manifest.exports).map(([entryPoint, target]) => {
    const { checker, symbols } = inspectDeclaration(root, target.types, program);
    const names = symbols.map((symbol) => symbol.getName()).sort();
    const entry = { export: entryPoint, declaration: target.types, names };
    if (!publicEntryPoints.includes(entryPoint)) return entry;
    const levels = readStability(root, entryPoint);
    const signatures = Object.fromEntries(symbols.map((symbol) => {
      const stability = levels.get(symbol.getName());
      if (!stability) throw new Error(`${entryPoint}:${symbol.getName()} is missing a stability doc comment`);
      return [symbol.getName(), { stability, signature: signatureOf(symbol, checker) }];
    }));
    return { ...entry, signatures };
  });
}

/** @param {string} changelog @param {string} version @param {string} baselineVersion */
export function hasBreakingMarker(changelog, version, baselineVersion) {
  const sections = changelog.split(/^## /mu).slice(1).map((text) => {
    const end = text.indexOf("\n");
    return { heading: text.slice(0, end).trim(), body: text.slice(end + 1) };
  });
  // Once a release section exists, stray Unreleased notes cannot authorize it.
  const release = sections.find(({ heading }) => heading === version || heading.startsWith(`[${version}]`));
  const section = version !== baselineVersion && release
    ? release
    : sections.find(({ heading }) => heading === "Unreleased");
  if (!section) return false;
  const lines = section.body.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!/^### (?:⚠\s*)?Breaking (?:API )?changes\s*$/iu.test(lines[index])) continue;
    const body = [];
    for (let next = index + 1; next < lines.length && !/^#{1,3} /u.test(lines[next]); next++) body.push(lines[next]);
    const text = body.join("\n").trim();
    if (text && !/^(?:[-*]\s*)?none[.!]?$/iu.test(text)) return true;
  }
  return false;
}

/** @param {any} baseline @param {string} packageName */
export function validateBaseline(baseline, packageName) {
  if (baseline.package !== packageName || !/^\d+\.\d+\.\d+$/u.test(baseline.version)) throw new Error("invalid API baseline identity");
  for (const entryPoint of publicEntryPoints) {
    const entries = baseline.exports?.filter((/** @type {SurfaceEntry} */ entry) => entry.export === entryPoint);
    if (entries?.length !== 1) throw new Error(`API baseline must contain exactly one ${entryPoint} entry`);
    const entry = entries[0];
    if (!entry.signatures || JSON.stringify(Object.keys(entry.signatures).sort()) !== JSON.stringify([...entry.names].sort())) throw new Error(`baseline is missing signatures for ${entryPoint}`);
    for (const signature of Object.values(entry.signatures)) {
      const value = /** @type {{signature: string, stability: string}} */ (signature);
      if (!/^[a-f0-9]{64}$/u.test(value.signature) || !["stable", "experimental"].includes(value.stability)) throw new Error(`invalid signature baseline for ${entryPoint}`);
    }
  }
}
