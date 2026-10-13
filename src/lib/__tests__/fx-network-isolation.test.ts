/**
 * Network stubs do not isolate currency's disk cache: all workers share one
 * sandbox file. These controls require canned upstream rates and tests that
 * stub disk readers or redirect the cache instead of depending on shared state.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  TEST_BTC_USD_RATE,
  TEST_USDC_USD_RATE,
} from "../../test-support/setup-fx-mock";
import { fetchCoinGeckoSpot } from "../fx-coingecko";

describe("FX network isolation", () => {
  it("serves CoinGecko from the global stub, never the live provider", async () => {
    const spot = await fetchCoinGeckoSpot();

    expect(spot.btc_usd).toBe(TEST_BTC_USD_RATE);
    expect(spot.usdc_usd).toBe(TEST_USDC_USD_RATE);
  });

});

/** The `src/lib/currency.ts` readers that reach the on-disk cache. */
const DISK_CACHE_READERS = ["fetchBtcUsdRate", "getLastKnownBtcRate"];

describe("FX state isolation", () => {
  /**
   * A disk-reader reference needs an explicit reader override (inline or
   * vi.hoisted), a currency automock, or a defaults mock naming BTC_RATE_FILE.
   * Automocking defaults leaves primitive exports intact and does not isolate
   * the file. Inspect factory bodies so importOriginal spreads cannot exempt a
   * reader they leave real.
   *
   * Scope is per-file identifiers: strings/comments and indirect production
   * calls are invisible. TypeScript parses incomplete files best-effort, so a
   * malformed untracked file can under-report until its own typecheck runs.
   */
  // Whole-repository reads can exceed the default timeout on a cold filesystem.
  it("no test file reads the shared BTC/USD disk cache", { timeout: 20_000 }, () => {
    const root = join(__dirname, "..", "..", "..");
    const files = walkFiles(join(root, "src"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => relative(root, file));

    const offenders: string[] = [];

    for (const rel of files) {
      const abs = join(root, rel);
      offenders.push(...scanSource(readFileSync(abs, "utf8"), rel));
    }

    expect(offenders).toEqual([]);
  });

  it("is not fooled by a regex literal inside a mock factory", () => {
    const source = [
      `import { getLastKnownBtcRate } from "../currency";`,
      `vi.mock("../currency", () => ({`,
      `  fetchBtcUsdRate: vi.fn(),`,
      `  leadingCount: (s: string) => /^\\((\\d+)/.exec(s),`,
      `}));`,
      `it("prices something", () => getLastKnownBtcRate());`,
    ].join("\n");

    expect(scanSource(source, "fixture.test.ts")).toEqual([
      expect.stringContaining("calls getLastKnownBtcRate with nothing stubbing it"),
    ]);
  });
});

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
  });
}

/**
 * Every unstubbed disk-cache reader `source` calls, one message each. Empty for
 * a file that names no reader, or that takes one of the three exemption routes
 * in the tripwire above.
 */
function scanSource(source: string, rel: string): string[] {

  // A substring prefilter may include prose; the AST below discards it.
  if (!DISK_CACHE_READERS.some((reader) => source.includes(reader))) return [];
  const parsed = ts.createSourceFile(
    rel,
    source,

    { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone },
    false,
    ts.ScriptKind.TS
  );
  const mocks = mockCalls(parsed);

  if (mocks.some((m) => m.specifier.includes("defaults") && m.names.has("BTC_RATE_FILE")))
    return [];
  const currencyMocks = mocks.filter((m) => m.specifier.includes("currency"));

  if (currencyMocks.some((m) => !m.hasFactory)) return [];

  const names = identifiersIn(parsed);
  const offenders: string[] = [];
  for (const reader of DISK_CACHE_READERS) {
    if (!names.has(reader)) continue;
    if (currencyMocks.some((m) => m.names.has(reader))) continue;
    offenders.push(
      `${rel}: calls ${reader} with nothing stubbing it — name it in a lib/currency ` +
        `mock factory (inline, or in a vi.hoisted binding the factory references), ` +
        `automock the module with a factory-less vi.mock("../currency"), or repoint ` +
        `BTC_RATE_FILE in a defaults mock`
    );
  }
  return offenders;
}

interface MockCall {
  specifier: string;
  names: Set<string>;
  hasFactory: boolean;
}

/**
 * Every `vi.mock("<specifier>", …)` call in `parsed`. `names` is every
 * identifier the call itself mentions, plus those in the body of any
 * `vi.hoisted(…)` binding it references — passing the factory by reference is
 * only legal through `vi.hoisted`, since a plain `const` is still in its TDZ
 * when the hoisted `vi.mock` runs, so following those covers every
 * by-reference shape. `hasFactory` is false for a bare `vi.mock("…")` automock.
 */
function mockCalls(parsed: ts.SourceFile): MockCall[] {
  const hoisted = hoistedBindings(parsed);
  const calls: MockCall[] = [];
  visit(parsed, (node) => {
    if (!isCallTo(node, "vi", "mock")) return;
    const specifier = node.arguments.at(0);
    if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
    const names = identifiersIn(node);
    for (const name of [...names]) {
      for (const referenced of hoisted.get(name) ?? []) names.add(referenced);
    }
    calls.push({ specifier: specifier.text, names, hasFactory: node.arguments.length > 1 });
  });
  return calls;
}

function hoistedBindings(parsed: ts.SourceFile): Map<string, Set<string>> {
  const bindings = new Map<string, Set<string>>();
  visit(parsed, (node) => {
    if (!ts.isVariableDeclaration(node)) return;
    if (node.initializer === undefined || !isCallTo(node.initializer, "vi", "hoisted")) return;
    const body = identifiersIn(node.initializer);
    for (const name of identifiersIn(node.name)) bindings.set(name, body);
  });
  return bindings;
}

function identifiersIn(node: ts.Node): Set<string> {
  const names = new Set<string>();
  visit(node, (child) => {
    if (ts.isIdentifier(child)) names.add(child.text);
  });
  return names;
}

function isCallTo(node: ts.Node, object: string, property: string): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === object &&
    callee.name.text === property
  );
}

function visit(node: ts.Node, onNode: (node: ts.Node) => void): void {
  onNode(node);
  ts.forEachChild(node, (child) => {
    visit(child, onNode);
  });
}
