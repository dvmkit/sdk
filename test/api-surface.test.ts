import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { hasValueExport, inspectDeclaration, inspectSurface } from "../scripts/api-surface.mjs";

const script = resolve("scripts/check-api-surface.mjs");
const directories: string[] = [];
const entryPoints = [".", "./server", "./testing"];
const declaration = `
interface Input { value: string; }
type Result = { ok: boolean };
declare function run(input: Input): Result;
declare class Worker {
  constructor(input: Input);
  execute(value: string): Result;
  protected retry(count: number): void;
  private cache;
}
declare function overloaded(value: string): string;
declare function overloaded(value: number): number;
declare function generic<T extends string>(value: T): T;
export { run, Worker, overloaded, generic };
`;
let template: string;

function json(root: string, path: string, value: unknown) {
  writeFileSync(join(root, path), JSON.stringify(value, null, 2) + "\n");
}

function declarationPath(entryPoint: string) {
  return entryPoint === "." ? "dist/index.d.ts" : `dist/${entryPoint.slice(2)}/index.d.ts`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sdk-api-fixture-"));
  directories.push(root);
  cpSync(template, root, { recursive: true });
  return root;
}

function change(root: string, from: string, to: string, entryPoint = ".") {
  writeFileSync(join(root, declarationPath(entryPoint)), declaration.replace(from, to));
}

function notes(root: string, text = "### Breaking changes\n\n- Update run's contract.\n") {
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\n${text}`);
}

function check(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
}

function refreshCurrent(root: string) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  json(root, "api-surface.json", { package: manifest.name, version: manifest.version, exports: inspectSurface(root, manifest) });
}

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "sdk-api-template-"));
  const exports = Object.fromEntries(entryPoints.map((entryPoint) => [entryPoint, { types: `./${declarationPath(entryPoint)}` }]));
  for (const entryPoint of entryPoints) {
    const sub = entryPoint === "." ? "" : `${entryPoint.slice(2)}/`;
    mkdirSync(join(template, `dist/${sub}`), { recursive: true });
    mkdirSync(join(template, `src/sdk/${sub}`), { recursive: true });
    writeFileSync(join(template, declarationPath(entryPoint)), declaration);
    const level = entryPoint === "./server" ? "experimental" : "stable";
    writeFileSync(join(template, `src/sdk/${sub}index.ts`), `/** @stability ${level} */\nexport { run, Worker, overloaded, generic } from "./implementation";\n`);
  }
  mkdirSync(join(template, "dist/internal"), { recursive: true });
  writeFileSync(join(template, "dist/internal/index.d.ts"), "export declare function internal(value: string): void;\n");
  exports["./internal"] = { types: "./dist/internal/index.d.ts" };
  json(template, "package.json", { name: "@dvmkit/sdk", version: "1.0.0", exports });
  refreshCurrent(template);
  cpSync(join(template, "api-surface.json"), join(template, "api-baseline.json"));
  notes(template, "");
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

afterAll(() => rmSync(template, { recursive: true, force: true }));

describe("public signature gate", () => {
  it.each(entryPoints)("rejects an unmarked parameter change in %s even after refreshing the current snapshot", (entryPoint) => {
    const root = fixture();
    change(root, "run(input: Input)", "run(input: number)", entryPoint);
    refreshCurrent(root);
    const result = check(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`without a breaking-change section`);
    expect(result.stderr).toContain(`${entryPoint}:run`);
  });

  it.each(["### Breaking changes", "### Breaking API changes", "### ⚠ BREAKING CHANGES"])("accepts the same parameter change with %s", (heading) => {
    const root = fixture();
    change(root, "run(input: Input)", "run(input: number)");
    notes(root, `${heading}\n\n- run now accepts a number.\n`);
    const baseline = readFileSync(join(root, "api-baseline.json"), "utf8");
    expect(check(root, "--write").status).toBe(0);
    expect(check(root).status).toBe(0);
    expect(readFileSync(join(root, "api-baseline.json"), "utf8")).toBe(baseline);
  });

  const typeOnlyExports = [
    ["declaration modifier", "export { run, overloaded, generic };\nexport type { Worker };"],
    ["specifier modifier", "export { run, type Worker, overloaded, generic };"],
  ];

  it.each(entryPoints.flatMap((entryPoint) => typeOnlyExports.map(([style, replacement]) => [entryPoint, style, replacement])))(
    "rejects an unmarked constructor removal in %s through a %s",
    (entryPoint, _style, replacement) => {
      const root = fixture();
      change(root, "export { run, Worker, overloaded, generic };", replacement, entryPoint);
      refreshCurrent(root);
      const result = check(root);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("without a breaking-change section");
      expect(result.stderr).toContain(`${entryPoint}:Worker`);
    }
  );

  it.each(typeOnlyExports)("accepts a disclosed constructor removal through a %s", (_style, replacement) => {
    const root = fixture();
    change(root, "export { run, Worker, overloaded, generic };", replacement);
    notes(root, "### Breaking changes\n\n- Worker is now available only as a type.\n");
    expect(check(root, "--write").status).toBe(0);
    expect(check(root).status).toBe(0);
  });

  it.each([
    "export { run, overloaded, generic } from './implementation'; export type { Worker } from './implementation';",
    "export { run, type Worker, overloaded, generic } from './implementation';",
    "export { run, overloaded, generic } from './implementation'; import type { Worker } from './implementation'; export { Worker };",
    "export type * from './implementation';",
    "export type * from './implementation'; export { run, overloaded, generic } from './implementation';",
  ])("detects type-only availability through an intermediate alias: %s", (middle) => {
    const root = fixture();
    writeFileSync(join(root, "dist/implementation.d.ts"), declaration);
    writeFileSync(join(root, "dist/middle.d.ts"), "export { run, Worker, overloaded, generic } from './implementation';");
    writeFileSync(join(root, "dist/index.d.ts"), "export { run, Worker, overloaded, generic } from './middle';");
    const fingerprint = () => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      return inspectSurface(root, manifest).find((entry) => entry.export === ".")!.signatures!.Worker.signature;
    };
    const availability = () => {
      const { checker, symbols } = inspectDeclaration(root, "dist/index.d.ts");
      return hasValueExport(symbols.find((symbol) => symbol.getName() === "Worker")!, checker);
    };
    const before = fingerprint();
    expect(availability()).toBe(true);
    writeFileSync(join(root, "dist/middle.d.ts"), middle);
    expect(availability()).toBe(false);
    expect(fingerprint()).not.toBe(before);
  });

  it("preserves value availability and fingerprints through ordinary star forwarding", () => {
    const root = fixture();
    writeFileSync(join(root, "dist/implementation.d.ts"), declaration);
    writeFileSync(join(root, "dist/index.d.ts"), "export { run, Worker, overloaded, generic } from './implementation';");
    const fingerprint = () => {
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      return inspectSurface(root, manifest).find((entry) => entry.export === ".")!.signatures!.Worker.signature;
    };
    const before = fingerprint();
    writeFileSync(join(root, "dist/middle.d.ts"), "export type * from './implementation'; export * from './implementation';");
    writeFileSync(join(root, "dist/index.d.ts"), "export { run, Worker, overloaded, generic } from './middle';");
    const { checker, symbols } = inspectDeclaration(root, "dist/index.d.ts");
    expect(hasValueExport(symbols.find((symbol) => symbol.getName() === "Worker")!, checker)).toBe(true);
    expect(fingerprint()).toBe(before);
  });

  it.each([
    ["return type", "run(input: Input): Result", "run(input: Input): number", ".:run"],
    ["reachable parameter member", "value: string", "value: number", ".:run"],
    ["reachable result member", "ok: boolean", "ok: string", ".:run"],
    ["class method", "execute(value: string)", "execute(value: number)", ".:Worker"],
    ["constructor", "constructor(input: Input)", "constructor(input: boolean)", ".:Worker"],
    ["protected method", "retry(count: number)", "retry(count: string)", ".:Worker"],
    ["overload", "overloaded(value: number): number", "overloaded(value: boolean): number", ".:overloaded"],
    ["generic constraint", "T extends string", "T extends number", ".:generic"],
    ["export removal", "export { run, Worker, overloaded, generic };", "export { Worker, overloaded, generic };", ".:run"],
  ])("detects a changed %s", (_label, from, to, symbol) => {
    const root = fixture();
    change(root, from, to);
    const result = check(root, "--write");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("without a breaking-change section");
    expect(result.stderr).toContain(symbol);
  });

  it.each([
    "### Breaking changes\n\n",
    "### Breaking changes\n\n### Fixes\n\n- Correct output.\n",
    "### Breaking changes\n\nNone.\n",
    "## [0.9.0]\n\n### Breaking changes\n\n- An older break.\n",
    "## [1.0.0]\n\n### Breaking changes\n\n- An already baselined break.\n",
  ])("rejects empty or historical markers: %s", (text) => {
    const root = fixture();
    change(root, "run(input: Input)", "run(input: number)");
    notes(root, text);
    expect(check(root, "--write").stderr).toContain("without a breaking-change section");
  });

  it("accepts a newly bumped release section and does not borrow its Unreleased marker", () => {
    const root = fixture();
    change(root, "run(input: Input)", "run(input: number)");
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    json(root, "package.json", { ...manifest, version: "1.1.0" });
    notes(root, "### Breaking changes\n\n- Development break.\n\n## [1.1.0](https://example.com/release)\n\n### Fixes\n\n- A fix.\n");
    expect(check(root, "--write").stderr).toContain("without a breaking-change section");
    notes(root, "## [1.1.0](https://example.com/release)\n\n### ⚠ BREAKING CHANGES\n\n- run accepts a number.\n");
    expect(check(root, "--write").status).toBe(0);
  });

  it.each(["", "/** @stability unknown */\n", "/** @stability stable\n * @stability experimental\n */\n"])("rejects missing or invalid stability comments: %s", (tag) => {
    const root = fixture();
    writeFileSync(join(root, "src/sdk/index.ts"), `${tag}export { run, Worker, overloaded, generic } from "./implementation";\n`);
    expect(check(root, "--write").stderr).toContain("needs exactly one @stability");
  });

  it("requires disclosure when an existing stable entry becomes experimental", () => {
    const root = fixture();
    const path = join(root, "src/sdk/index.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("stable", "experimental"));
    expect(check(root, "--write").stderr).toContain("without a breaking-change section");
  });

  it("allows promoting an experimental export to stable without marking the release breaking", () => {
    const root = fixture();
    const path = join(root, "src/sdk/server/index.ts");
    writeFileSync(path, readFileSync(path, "utf8").replace("experimental", "stable"));
    expect(check(root, "--write").status).toBe(0);
    expect(check(root).status).toBe(0);
  });

  it("ignores comments, formatting, private fields and bundled local alias names", () => {
    const root = fixture();
    const text = declaration.replaceAll("Input", "RenamedInput").replaceAll("Result", "RenamedResult").replace("private cache;", "private differentCache;").replace("value: string", "/* prose */ value : string");
    writeFileSync(join(root, declarationPath(".")), text);
    expect(check(root).status).toBe(0);
  });

  it("still rejects a stale current snapshot even when the break is disclosed", () => {
    const root = fixture();
    change(root, "run(input: Input)", "run(input: number)");
    notes(root);
    expect(check(root).stderr).toContain("declaration surface changed");
  });

  it("keeps unsupported signatures exempt while still pinning their names", () => {
    const root = fixture();
    writeFileSync(join(root, "dist/internal/index.d.ts"), "export declare function internal(value: number): void;\n");
    expect(check(root).status).toBe(0);
    writeFileSync(join(root, "dist/internal/index.d.ts"), "export declare function renamed(): void;\n");
    expect(check(root).stderr).toContain("declaration surface changed");
    expect(check(root, "--write").status).toBe(0);
  });

  it("rolls the baseline forward from a tagged snapshot instead of unreleased build output", () => {
    const root = fixture();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
    git("init", "-q");
    git("config", "user.name", "API Test");
    git("config", "user.email", "api@example.com");
    git("config", "commit.gpgsign", "false");
    git("config", "tag.gpgsign", "false");
    git("add", "api-surface.json");
    git("commit", "-qm", "test: release snapshot");
    git("tag", "v1.0.0");
    const released = readFileSync(join(root, "api-surface.json"), "utf8");
    change(root, "run(input: Input)", "run(input: number)");
    refreshCurrent(root);
    expect(check(root, "--baseline-from-tag", "v1.0.0").status).toBe(0);
    expect(readFileSync(join(root, "api-baseline.json"), "utf8")).toBe(released);
    expect(check(root).stderr).toContain("without a breaking-change section");
    git("tag", "v2.0.0");
    expect(check(root, "--baseline-from-tag", "v2.0.0").stderr).toContain("release tag version differs");
    expect(readFileSync(join(root, "api-baseline.json"), "utf8")).toBe(released);
  });

  it("refuses a release candidate as a baseline rollover", () => {
    const root = fixture();
    expect(check(root, "--baseline-from-tag", "v1.1.0-rc.1").stderr).toContain("baseline must come from a stable");
  });

  it("fails closed when a public baseline entry is missing", () => {
    const root = fixture();
    const path = join(root, "api-baseline.json");
    const baseline = JSON.parse(readFileSync(path, "utf8"));
    baseline.exports = baseline.exports.filter((entry: { export: string }) => entry.export !== "./testing");
    json(root, "api-baseline.json", baseline);
    expect(check(root).stderr).toContain("API baseline must contain exactly one ./testing entry");
  });
});
