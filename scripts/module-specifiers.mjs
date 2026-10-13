import ts from "typescript";

/**
 * Collect every statically knowable module specifier TypeScript can represent.
 * @param {ts.SourceFile} source
 * @returns {string[]}
 */
export function collectModuleSpecifiers(source) {
  /** @type {string[]} */
  const specifiers = [];
  const pushLiteral = (/** @type {ts.Node | undefined} */ node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.push(node.text);
  };
  const isRequireResolve = (/** @type {ts.Node} */ node) =>
    (ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.name.text === "resolve") ||
    (ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === "resolve");
  const visit = (/** @type {ts.Node} */ node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      pushLiteral(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      pushLiteral(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        isRequireResolve(node.expression)) &&
      node.arguments.length > 0
    ) {
      pushLiteral(node.arguments[0]);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      pushLiteral(node.argument.literal);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

/** Fail if a parser edit stops covering any import form guarded by the SDK boundary. */
export function assertModuleSpecifierSyntaxCoverage() {
  const fixture = ts.createSourceFile(
    "boundary-syntax.ts",
    [
      'import value from "value-import";',
      'import type { TypeOnly } from "type-import";',
      'export { value as exported } from "value-export";',
      'export type { TypeOnly as ExportedType } from "type-export";',
      'const lazy = import("dynamic-import");',
      'const common = require("commonjs-require");',
      'const resolved = require.resolve("require-resolve");',
      'const elementResolved = require["resolve"]("require-element-resolve");',
      'import equals = require("import-equals");',
      'type Imported = import("import-type").Imported;',
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const expected = [
    "value-import",
    "type-import",
    "value-export",
    "type-export",
    "dynamic-import",
    "commonjs-require",
    "require-resolve",
    "require-element-resolve",
    "import-equals",
    "import-type",
  ].sort();
  const actual = collectModuleSpecifiers(fixture).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `module-specifier parser missed syntax: ${JSON.stringify({ expected, actual })}`
    );
  }
}
