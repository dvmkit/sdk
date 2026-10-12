#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "ownership/caller-migration.json"), "utf8"));
const controls = {
  "channel-static": 'import { loadConfig } from "../identity";',
  "channel-type": 'import type { Config } from "../identity";',
  "channel-dynamic": 'const config = await import("../identity");',
  "channel-inline-type": 'type BadCallerConfig = import("../identity").Config;',
  "channel-template-dynamic": 'const config = await import(`../identity`);',
  "channel-alias": 'import type { Config } from "@ownership-config";',
  "channel-transitive": 'import { x402ChannelReservation } from "./voucher-cap";',

  "recovery-static": 'import { loadConfig } from "./identity";',
  "recovery-type": 'import type { Config } from "./identity";',
  "recovery-dynamic": 'const config = await import("./identity");',
  "recovery-inline-type": 'type BadCallerConfig = import("./identity").Config;',
  "recovery-template-dynamic": 'const config = await import(`./identity`);',
  "recovery-alias": 'import type { Config } from "@ownership-config";',
  "recovery-transitive": 'import type { TrustAnchorRead } from "./receipt-contracts";',
  "recovery-shared": 'import type { TrustAnchorRead } from "./receipt-contracts";',
  "funding-menu": 'import type { X402CreditFlavour } from "./x402/menu";',
  "funding-static": 'import { loadConfig } from "./identity";',
  "funding-type": 'import type { Config } from "./identity";',
  "funding-dynamic": 'const config = await import("./identity");',
  "funding-inline-type": 'type BadCallerConfig = import("./identity").Config;',
  "funding-template-dynamic": 'const config = await import(`./identity`);',
  "funding-alias": 'import type { Config } from "@ownership-config";',
  "funding-transitive": 'import type { Config } from "./identity";',
  "budget-config": 'import { loadConfig } from "./identity";',
  static: 'import { loadConfig } from "./identity";',
  type: 'import type { Config } from "./identity";',
  dynamic: 'const config = await import("./identity");',
  "inline-type": 'type BadCallerConfig = import("./identity").Config;',
  "template-dynamic": 'const config = await import(`./identity`);',
  alias: 'import type { Config } from "@ownership-config";',
  "shared-currency": 'import type { Currency } from "../sdk/pricing/currency";',
};
const bindingControls = ["malformed-binding", "missing-binding", "wrong-origin", "unknown-mode", "malformed-group", "missing-type-binding", "duplicate-allocation"];
const direct = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
const control = direct ? process.argv[2]?.replace(/^--(?:negative|positive)-control=/u, "") : undefined;
if (control && !Object.hasOwn(controls, control) && !bindingControls.includes(control)) throw new Error("unknown ownership guard argument");
if (direct && process.argv.length > 3) throw new Error("unknown ownership guard argument");
if (manifest.schemaVersion !== 2 || manifest.phase !== "trimmed") throw new Error("unsupported ownership manifest");

if (control === "duplicate-allocation") {
  const allocated = manifest.modules.find((/** @type {{allocations: unknown[]}} */ row) => row.allocations.length > 0);
  allocated.allocations.push(structuredClone(allocated.allocations[0]));
}
for (const entry of manifest.modules) {
  const seen = new Set();
  for (const allocation of entry.allocations) {
    for (const symbol of allocation.symbols) {
      if (seen.has(symbol)) throw new Error(`duplicate symbol allocation: ${entry.module}#${symbol}`);
      seen.add(symbol);
    }
  }
}

const files = readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith(".ts") && !file.includes("__tests__") && !file.includes("test-support"))
  .map((file) => `src/${file.replaceAll("\\", "/")}`)
  .sort();
for (const entry of manifest.modules) {
  if (!files.includes(entry.module)) throw new Error(`recorded declaring module is missing: ${entry.module}`);
}
const fileSet = new Set(files);
const configuration = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
if (configuration.error) throw new Error("cannot read ownership TypeScript configuration");
const compilerOptions = ts.parseJsonConfigFileContent(configuration.config, ts.sys, root).options;
if (control === "alias" || control === "funding-alias" || control === "recovery-alias" || control === "channel-alias") {
  compilerOptions.baseUrl = root;
  compilerOptions.paths = { ...compilerOptions.paths, "@ownership-config": ["./src/lib/identity.ts"] };
}
const resolutionCache = ts.createModuleResolutionCache(root, (file) => ts.sys.useCaseSensitiveFileNames ? file : file.toLowerCase(), compilerOptions);
/** @param {keyof typeof controls} [sourceControl] */
export function assertSharedCoreBoundary(sourceControl) {
  /** @type {Map<string, string[]>} */
  const graph = new Map();
  /** @param {string} file @returns {string[]} */
  function dependencies(file) {
    const cached = graph.get(file);
    if (cached) return cached;
    let source = readFileSync(join(root, file), "utf8");
    if (sourceControl && Object.hasOwn(controls, sourceControl) && file === (sourceControl.startsWith("channel-") ? "src/lib/x402/voucher-pending.ts" : sourceControl.startsWith("recovery-") ? "src/lib/submission-policy.ts" : sourceControl === "budget-config" ? "src/lib/budget-core.ts" : sourceControl === "funding-transitive" ? "src/lib/payment-amounts.ts" : sourceControl.startsWith("funding-") ? "src/lib/credit-funding-contracts.ts" : "src/lib/wallet-credentials.ts")) source += `\n${controls[/** @type {keyof typeof controls} */ (sourceControl)]}\n`;
    if (sourceControl === "recovery-transitive" && file === "src/lib/receipt-contracts.ts") source += '\nimport type { ReceiptCapture } from "./receipt-capture";\n';
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    /** @type {string[]} */
    const edges = [];
    /** @param {ts.Node} node */
    function visit(node) {
      const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
          ? node.argument.literal
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
            ? node.arguments[0]
            : undefined;
      if (specifier && (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier))) {
        const resolved = ts.resolveModuleName(specifier.text, join(root, file), compilerOptions, ts.sys, resolutionCache).resolvedModule;
        const missingPath = specifier.text === "@ownership-config"
          ? "src/lib/identity.ts"
          : specifier.text.startsWith(".")
            ? relative(root, resolve(root, file, "..", specifier.text)).replaceAll("\\", "/") + ".ts"
            : undefined;
        const target = resolved ? relative(root, resolved.resolvedFileName).replaceAll("\\", "/") : missingPath;
        if (target && (fileSet.has(target) || manifest.sharedCoreBoundary.forbiddenModules.includes(target))) edges.push(target);
        else if (target?.endsWith(".json") && existsSync(join(root, target))) return;
        else if (specifier.text.startsWith(".") || (resolved && !resolved.isExternalLibraryImport)) {
          throw new Error(`unresolved local dependency: ${file} -> ${specifier.text}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    graph.set(file, edges);
    return edges;
  }

  const forbidden = new Set(manifest.sharedCoreBoundary.forbiddenModules);
  if (new Set(manifest.modules.map((/** @type {{module: string}} */ entry) => entry.module)).size !== manifest.modules.length) throw new Error("duplicate module allocation");
  const allocatedModules = new Set(manifest.modules.map((/** @type {{ module: string }} */ entry) => entry.module));
  for (const core of manifest.sharedCoreBoundary.modules) {
    /** @type {Set<string>} */
    const visited = new Set();
    /** @param {string} file @param {string[]} chain */
    function walk(file, chain) {
      if (forbidden.has(file)) throw new Error(`shared core depends on caller implementation: ${[...chain, file].join(" -> ")}`);
      if (!allocatedModules.has(file)) throw new Error(`shared core dependency needs an explicit ownership allocation: ${file}`);
      if (visited.has(file)) return;
      visited.add(file);
      for (const dependency of dependencies(file)) walk(dependency, [...chain, file]);
    }
    walk(core, []);
  }
}
assertSharedCoreBoundary(/** @type {keyof typeof controls | undefined} */ (control && Object.hasOwn(controls, control) ? control : undefined));
const program = ts.createProgram(files.map((file) => join(root, file)), compilerOptions);
const checker = program.getTypeChecker();
const entryFiles = {
  ".": "src/sdk/index.ts",
  "./server": "src/sdk/server/index.ts",
  "./testing": "src/sdk/testing/index.ts",
  "./internal": "src/sdk/internal/index.ts",
};
const modes = new Set(["runtime", "type", "dynamic", "generated-runtime", "generated-type"]);
if (!Array.isArray(manifest.consumerBindings) || !manifest.consumerBindings.length) throw new Error("missing consumer binding schema");
if (bindingControls.includes(control ?? "")) {
  const binding = manifest.consumerBindings.find((/** @type {{ role: string, exportedName: string }} */ row) => row.role === "builder" && row.exportedName === "getWallet");
  if (!binding) throw new Error("binding control target is missing");
  if (control === "malformed-binding") binding.exportedName = [binding.exportedName];
  if (control === "missing-binding") binding.exportedName = "missingGetWallet";
  if (control === "missing-type-binding") { binding.exportedName = "missingSharedType"; binding.modes = ["type"]; }
  if (control === "wrong-origin") binding.declaringModule = "src/lib/errors.ts";
  if (control === "unknown-mode") binding.modes = ["unknown"];
  if (control === "malformed-group") {
    const group = manifest.consumers.find((/** @type {{ role: string, bindings: { symbol: string }[] }} */ row) => row.role === "builder" && row.bindings.some((entry) => entry.symbol === "getWallet"));
    group.bindings.find((/** @type {{ symbol: string }} */ entry) => entry.symbol === "getWallet").symbol = ["getWallet"];
  }
}
/** @param {typeof manifest.consumers} groups */
export function assertGroupedConsumerBindings(groups) {
  if (!Array.isArray(groups) || !groups.length) throw new Error("invalid grouped consumer binding schema");
  for (const group of groups) {
    if (!group || typeof group.role !== "string" || typeof group.entry !== "string" || !Object.hasOwn(entryFiles, group.entry)
      || typeof group.module !== "string" || !Array.isArray(group.bindings) || !group.bindings.length
      || group.bindings.some((/** @type {{ symbol: unknown, declaredSymbol: unknown, modes: unknown, sites: unknown }} */ binding) => !binding
        || typeof binding.symbol !== "string" || !binding.symbol || typeof binding.declaredSymbol !== "string" || !binding.declaredSymbol
        || !Array.isArray(binding.modes) || !binding.modes.length || !Array.isArray(binding.sites) || !binding.sites.length)) {
      throw new Error("invalid grouped consumer binding schema");
    }
  }
}
assertGroupedConsumerBindings(manifest.consumers);
/** @param {typeof manifest.consumerBindings[number]} binding */
export function assertConsumerBinding(binding) {
  if (!binding || !["caller", "builder", "service", "operator", "acceptance"].includes(binding.role)
    || typeof binding.sdkEntry !== "string" || !Object.hasOwn(entryFiles, binding.sdkEntry)
    || typeof binding.exportedName !== "string" || !binding.exportedName
    || typeof binding.declaringModule !== "string" || (!fileSet.has(binding.declaringModule) && binding.declaringModule !== "external:zod")
    || typeof binding.declaredSymbol !== "string" || !binding.declaredSymbol
    || !Array.isArray(binding.sites) || !binding.sites.length || binding.sites.some((/** @type {unknown} */ site) => typeof site !== "string" || !site)
    || !Array.isArray(binding.modes) || !binding.modes.length || binding.modes.some((/** @type {unknown} */ mode) => typeof mode !== "string" || !modes.has(mode))) {
    throw new Error("invalid consumer binding schema");
  }
  const entryFile = entryFiles[/** @type {keyof typeof entryFiles} */ (binding.sdkEntry)];
  const source = program.getSourceFile(join(root, entryFile));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const declaration = moduleSymbol && checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === binding.exportedName);
  if (!declaration) throw new Error(`consumer export is missing: ${binding.sdkEntry}#${binding.exportedName}`);
  const actual = declaration.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(declaration) : declaration;
  const localDeclaration = actual.declarations?.some((node) => resolve(node.getSourceFile().fileName) === join(root, binding.declaringModule));
  // External namespaces (z) are explicitly forwarded by an SDK export declaration.
  const externalForward = binding.declaringModule === "external:zod"
    && actual.declarations?.some((node) => node.getSourceFile().fileName.replaceAll("\\", "/").includes("/node_modules/zod/"))
    && declaration.declarations?.some((node) => fileSet.has(relative(root, node.getSourceFile().fileName).replaceAll("\\", "/")));
  if ((!localDeclaration || actual.name !== binding.declaredSymbol) && !(externalForward && declaration.name === binding.declaredSymbol)) {
    throw new Error(`consumer declaring module mismatch: ${binding.sdkEntry}#${binding.exportedName}`);
  }
  if (binding.modes.some((/** @type {string} */ mode) => ["runtime", "dynamic", "generated-runtime"].includes(mode)) && !(actual.flags & ts.SymbolFlags.Value)) {
    throw new Error(`consumer runtime binding has no value: ${binding.sdkEntry}#${binding.exportedName}`);
  }
}
for (const binding of manifest.consumerBindings) assertConsumerBinding(binding);
const canonicalBindings = new Set(manifest.consumerBindings.map((/** @type {unknown} */ row) => JSON.stringify(row)));
if (canonicalBindings.size !== manifest.consumerBindings.length) throw new Error("duplicate canonical consumer binding");
const groupedBindings = new Set(manifest.consumers.flatMap((/** @type {{ role: string, entry: string, module: string, bindings: {symbol: string, declaredSymbol: string, modes: string[], sites: string[]}[] }} */ group) => group.bindings.map((binding) => JSON.stringify({ role: group.role, sdkEntry: group.entry, exportedName: binding.symbol, declaringModule: group.module, declaredSymbol: binding.declaredSymbol, modes: binding.modes, sites: binding.sites }))));
if (canonicalBindings.size !== groupedBindings.size || [...canonicalBindings].some((row) => !groupedBindings.has(row))) throw new Error("grouped consumer binding evidence differs from canonical rows");
for (const entry of manifest.modules) {
  const source = program.getSourceFile(join(root, entry.module));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  const declared = moduleSymbol ? checker.getExportsOfModule(moduleSymbol) : [];
  for (const allocation of entry.allocations) {
    if (allocation.decision !== "retain" || allocation.destination !== "sdk" || !allocation.reason || !allocation.consumerEvidence?.length) throw new Error(`incomplete ownership allocation: ${entry.module}`);
    for (const symbol of allocation.symbols) {
      const declaration = declared.find((candidate) => candidate.name === symbol);
      if (!declaration) throw new Error(`allocated symbol has no declaration: ${entry.module}#${symbol}`);
      const actual = declaration.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(declaration) : declaration;
      if (!actual.declarations?.some((node) => resolve(node.getSourceFile().fileName) === join(root, entry.module))) {
        throw new Error(`allocation must name the declaring module: ${entry.module}#${symbol}`);
      }
    }
  }
}
console.log(`caller ownership ok: ${files.length} snapshot modules checked; shared cores exclude caller static, type and dynamic dependencies`);
