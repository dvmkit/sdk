import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ConfigDirModule from "../config-dir";

const roots: string[] = [];

async function loadConfigDir(): Promise<{
  dir: string;
  mod: typeof ConfigDirModule;
}> {
  const root = mkdtempSync(join(tmpdir(), "dvmkit-config-dir-"));
  roots.push(root);
  const dir = join(root, ".dvm");
  vi.stubEnv("DVM_CONFIG_DIR", dir);
  vi.resetModules();
  return { dir, mod: await import("../config-dir") };
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// POSIX modes are meaningless on Windows and `chmodSync` there is a near no-op.
describe.skipIf(process.platform === "win32")("config dir mode", () => {
  // Avoid process-global umask changes shared with other test files.

  it("creates the config dir owner-only", async () => {
    const { dir, mod } = await loadConfigDir();
    mod.ensureConfigDir();

    expect(mode(dir)).toBe(0o700);
  });

  it("repairs an existing group/other-readable dir", async () => {
    const { dir, mod } = await loadConfigDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);

    const result = mod.repairConfigDirMode();

    expect(result).toMatchObject({
      path: dir,
      exists: true,
      modeOctal: "0700",
      previousModeOctal: "0755",
      repaired: true,
      skippedNonPosix: false,
    });
    expect(mode(dir)).toBe(0o700);
  });

  it("leaves an already-0700 dir alone", async () => {
    const { dir, mod } = await loadConfigDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const result = mod.repairConfigDirMode();

    expect(result).toMatchObject({ exists: true, modeOctal: "0700", repaired: false });
    expect(result.previousModeOctal).toBeUndefined();
    expect(mode(dir)).toBe(0o700);
  });

  it("leaves a deliberately stricter dir alone", async () => {
    // An operator who tightened past 0700 for a shared-service setup should not
    // be fought with — only loosening is corrected.
    const { dir, mod } = await loadConfigDir();
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);

    const result = mod.repairConfigDirMode();

    expect(result).toMatchObject({ exists: true, modeOctal: "0500", repaired: false });
    expect(mode(dir)).toBe(0o500);
  });

  it("reports an absent dir without creating it", async () => {
    const { dir, mod } = await loadConfigDir();

    const result = mod.repairConfigDirMode();

    expect(result).toMatchObject({
      path: dir,
      exists: false,
      modeOctal: null,
      repaired: false,
    });
    expect(result.error).toBeUndefined();
    expect(existsSync(dir)).toBe(false);
  });
});

const root = join(__dirname, "..", "..", "..");

/** Matches a `mkdir` / `mkdirSync` / `mkdirp` call and captures its arguments. */
const MKDIR_CALL = /\bmkdirp?(?:Sync)?\s*\(([^)]*)/;

/** Matches a `const X = Y;` local alias (optionally exported). */
const ALIAS_DECL = /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(\w+)\s*;/;

describe("config dir creation is centralised", () => {
  const derived = configDirDerivedNames();

  it("derives the CONFIG_DIR-rooted constants from defaults.ts", () => {
    // Guard the guard, both directions: the direct children, the transitive one
    // (PROXY_STATE_FILE sits under ADMIN_DIR), and a builder-tree constant that
    // must *not* be swept in — `~/.dvmkit` is a separate tree with its own mode.
    expect([...derived]).toEqual(
      expect.arrayContaining([
        "CONFIG_DIR",
        "MESSAGES_DIR",
        "PAIRINGS_DIR",
        "ADMIN_DIR",
        "BTC_RATE_FILE",
        "PROXY_STATE_FILE",
      ])
    );
    expect(derived.has("BUILDER_CONFIG_DIR")).toBe(false);
  });

  it("detects a call site the scan is meant to catch", () => {

    expect(offendingArgs("  mkdirSync(MESSAGES_DIR, { recursive: true });", derived)).toBe(true);
    expect(
      offendingArgs("  mkdirSync(dirname(BTC_RATE_FILE), { recursive: true });", derived)
    ).toBe(true);
    expect(offendingArgs("  mkdirSync(BUILDER_CONFIG_DIR, { recursive: true });", derived)).toBe(
      false
    );
  });

  it("follows a single-hop alias to a CONFIG_DIR constant", () => {

    const offendingLine = "  mkdirSync(dirname(CACHE_FILE), { recursive: true });";
    const currencyLines = readFileSync(join(root, "src", "lib", "currency.ts"), "utf8").split("\n");

    expect(
      offendingArgs(offendingLine, withFileAliases([...currencyLines, offendingLine], derived))
    ).toBe(true);

    // Negative control: same call, no alias tying CACHE_FILE to a CONFIG_DIR
    // constant — the guard follows the alias, not just the identifier's name.
    expect(offendingArgs(offendingLine, withFileAliases([offendingLine], derived))).toBe(false);
  });

  it("no source file mkdirs a CONFIG_DIR path outside config-dir.ts", { timeout: 20_000 }, () => {
    const files = trackedSources();

    // Guard the guard: a walk that stopped matching would pass silently.
    expect(files.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const rel of files) {
      const lines = readFileSync(join(root, rel), "utf8").split("\n");
      const namesForFile = withFileAliases(lines, derived);
      lines.forEach((line, i) => {
        if (offendingArgs(line, namesForFile)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});

/**
 * Every `defaults.ts` export that resolves inside `CONFIG_DIR`, to a fixpoint so
 * a constant derived from another derived one is included.
 */
function configDirDerivedNames(): Set<string> {
  const source = readFileSync(join(root, "src", "defaults.ts"), "utf8");
  const names = new Set(["CONFIG_DIR"]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [, name, parent] of source.matchAll(/export const (\w+) = join\((\w+),/g)) {
      if (names.has(parent) && !names.has(name)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/**
 * `names` extended with this file's single-hop local aliases: a `const X = Y;`
 * where `Y` is already in `names` pulls `X` in too, so a `mkdir` that reaches a
 * CONFIG_DIR path through an alias — `const CACHE_FILE = BTC_RATE_FILE;` in
 * `src/lib/currency.ts` — is still caught. Checked against the
 * original `names`, not the growing `extended` set, so a chain (`B` aliasing a
 * local alias of `A`) isn't followed — single-hop only, per scope.
 */
function withFileAliases(lines: string[], names: Set<string>): Set<string> {
  const extended = new Set(names);
  for (const line of lines) {
    const match = ALIAS_DECL.exec(line);
    if (match && names.has(match[2])) extended.add(match[1]);
  }
  return extended;
}

/**
 * True when `line` mkdirs a path built from one of `names`. Line-oriented: every
 * mkdir in the tree fits on one line, and a wrapped one would only under-report.
 */
function offendingArgs(line: string, names: Set<string>): boolean {
  const args = MKDIR_CALL.exec(line)?.[1];
  if (args === undefined) return false;
  return [...names].some((name) => new RegExp(`\\b${name}\\b`).test(args));
}

function trackedSources(): string[] {
  return walkFiles(join(root, "src"))
    .map((file) => relative(root, file))
    .filter(
      (file) =>
        file.endsWith(".ts") &&
        file !== "src/lib/config-dir.ts" &&
        file !== "src/shared/config-dir.ts" &&
        !file.includes("__tests__/")
    );
}

function walkFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : entry.isFile() ? [path] : [];
  });
}
