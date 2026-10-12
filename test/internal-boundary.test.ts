import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The built package, not the source tree: `./internal` is an entry point, and what a consumer
// resolves through it is `dist/internal/index.js`. The gate builds before it tests.
import * as internal from "../dist/internal/index.js";

/**
 * The reviewed api-surface.json pins every built declaration name. The compiler
 * identifies which exports from the authored barrel have a value side and must
 * therefore survive in JavaScript. Inspecting the authored declarations also
 * preserves explicit `export type` modifiers that declaration bundling can
 * flatten. This avoids a second generated baseline while still rejecting
 * equal-size remove/add swaps.
 */
function declaredRuntimeExports(): string[] {
  const declaration = fileURLToPath(new URL("../src/sdk/internal/index.ts", import.meta.url));
  const program = ts.createProgram({
    rootNames: [declaration],
    options: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2024,
    },
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(declaration);
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error("could not inspect the internal export declarations");

  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((exported) => {
      if (
        exported.flags & ts.SymbolFlags.Alias &&
        exported.declarations?.length &&
        exported.declarations.every((node) => {
          if (ts.isExportSpecifier(node)) {
            const exportDeclaration = node.parent.parent;
            return (
              node.isTypeOnly ||
              (ts.isExportDeclaration(exportDeclaration) && exportDeclaration.isTypeOnly)
            );
          }
          return ts.isExportDeclaration(node) && node.isTypeOnly;
        })
      ) {
        return false;
      }
      const symbol =
        exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
      return Boolean(symbol.flags & ts.SymbolFlags.Value);
    })
    .map((exported) => exported.getName())
    .sort();
}

const EXPECTED_RUNTIME_EXPORTS = declaredRuntimeExports();

describe("internal SDK entry point", () => {
  it("exposes every platform-shared runtime binding through the built entry point", () => {
    const expected = EXPECTED_RUNTIME_EXPORTS;
    const actual = Object.keys(internal).sort();
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);

    expect({
      missing: expected.filter((name) => !actualSet.has(name)),
      unexpected: actual.filter((name) => !expectedSet.has(name)),
    }).toEqual({ missing: [], unexpected: [] });
  });

  it("keeps the aliased collisions reachable under both names", () => {
    // `sdk/server/lock-pubkey-store` re-exports `lib/cashu/lock-pubkey`, so one name cannot carry
    // both blocks. The alias is the same binding, not a second implementation.
    expect(internal.lockPubkeyStoreToLockPubkey).toBe(internal.toLockPubkey);
  });

  it("keeps the caller's colliding identity generator distinct from the builder's", () => {
    // Unlike the alias above, these are two different functions that happen to
    // share a name: `lib/cli-identity-store` writes a caller signing identity,
    // `lib/builder-identity` a builder attestation key. Exporting only one would
    // hand the caller CLI the wrong implementation under the right name.
    expect(internal.cliIdentityStoreGenerateIdentity).toBeTypeOf("function");
    expect(internal.generateIdentity).toBeTypeOf("function");
    expect(internal.cliIdentityStoreGenerateIdentity).not.toBe(internal.generateIdentity);
  });
});
