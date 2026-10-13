import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const correctness = {
  "no-constant-condition": "error",
  "no-fallthrough": "error",
  eqeqeq: ["error", "always", { null: "ignore" }],
};

const unusedBindings = [
  "error",
  {
    argsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    destructuredArrayIgnorePattern: "^_",
    varsIgnorePattern: "^_",
  },
];

export default [
  {
    ignores: [".artifacts/**", ".tooling/**", "coverage/**", "dist/**", "node_modules/**"],
  },
  {
    linterOptions: {
      // `src/` is an export of a larger codebase and carries that codebase's disable directives
      // for type-aware rules this package does not enable. Reporting them would fail the gate on
      // every re-export without saying anything about this repository's own code.
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    ...eslint.configs.recommended,
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
      sourceType: "module",
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...correctness,
      "no-unused-vars": unusedBindings,
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: globals.node,
      parser: tseslint.parser,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      ...correctness,
      // TypeScript itself resolves identifiers and reports unused bindings with type awareness,
      // so the base rules would only duplicate `tsc` and misreport type-only references.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": unusedBindings,
    },
  },
];
