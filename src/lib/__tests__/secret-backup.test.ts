import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { backupSecretFile } from "../secret-backup";

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dvmkit-secret-backup-"));
  file = join(dir, "recovery.mnemonic");
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe("backupSecretFile", () => {
  it("returns null when there is no file to preserve", () => {
    expect(backupSecretFile(file, "new words")).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns null when the incoming content matches (modulo trailing newline)", () => {
    writeFileSync(file, "same words\n", { mode: 0o600 });
    expect(backupSecretFile(file, "same words")).toBeNull();
    expect(readdirSync(dir)).toEqual(["recovery.mnemonic"]);
  });

  it("copies the prior content aside at mode 0600", () => {
    writeFileSync(file, "old words\n", { mode: 0o600 });

    const backup = backupSecretFile(file, "new words");

    expect(backup).not.toBeNull();
    expect(readFileSync(String(backup), "utf-8")).toBe("old words\n");
    expect(statSync(String(backup)).mode & 0o777).toBe(0o600);
    // The original is untouched — the caller replaces it afterwards.
    expect(readFileSync(file, "utf-8")).toBe("old words\n");
  });

  it("tightens a world-readable original to 0600 in the copy", () => {
    writeFileSync(file, "old words\n", { mode: 0o644 });

    const backup = backupSecretFile(file, "new words");

    expect(statSync(String(backup)).mode & 0o777).toBe(0o600);
  });

  it("backs up unconditionally when no replacement content is given (delete path)", () => {
    writeFileSync(file, "old words\n", { mode: 0o600 });

    const backup = backupSecretFile(file);

    expect(readFileSync(String(backup), "utf-8")).toBe("old words\n");
  });

  it("does not clobber an earlier rescue copy taken in the same millisecond", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-26T00:00:00.000Z"));
    writeFileSync(file, "first\n", { mode: 0o600 });
    const a = backupSecretFile(file, "second");
    writeFileSync(file, "second\n", { mode: 0o600 });
    const b = backupSecretFile(file, "third");

    expect(a).not.toBe(b);
    expect(readFileSync(String(a), "utf-8")).toBe("first\n");
    expect(readFileSync(String(b), "utf-8")).toBe("second\n");
  });
});
