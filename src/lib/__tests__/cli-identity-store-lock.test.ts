import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const tmpRoot = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
  const dir = `${tmpRoot.replace(/\/$/, "")}/dvm-identity-identities-lock-${process.pid}-${Date.now()}`;
  const identitiesFile = `${dir}/identities.json`;
  return { configDir: dir, identitiesFile, lockFile: `${identitiesFile}.lock` };
});

vi.mock("../../defaults", () => ({
  CONFIG_DIR: tmp.configDir,
  IDENTITIES_FILE: tmp.identitiesFile,
}));

import {
  IDENTITIES_VERSION,
  loadIdentities,
  saveIdentities,
  withIdentitiesLock,
} from "../cli-identity-store";
import { DvmError } from "../errors";

function ensureCleanState(): void {
  if (existsSync(tmp.lockFile)) {
    rmSync(tmp.lockFile, { recursive: true, force: true });
  }
  if (existsSync(tmp.identitiesFile)) {
    rmSync(tmp.identitiesFile, { force: true });
  }
}

beforeAll(() => {
  mkdirSync(tmp.configDir, { recursive: true });
});

beforeEach(() => {
  ensureCleanState();
  writeFileSync(
    tmp.identitiesFile,
    JSON.stringify({ version: IDENTITIES_VERSION, identities: {} }),
    { mode: 0o600 }
  );
});

afterEach(() => {
  ensureCleanState();
});

afterAll(() => {
  rmSync(tmp.configDir, { recursive: true, force: true });
});

describe("withIdentitiesLock", () => {
  it("acquires the lock, runs the body, and releases", async () => {
    const result = await withIdentitiesLock(() => "ok");
    expect(result).toBe("ok");
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("serialises concurrent read-modify-write cycles", async () => {
    const writeEntry = (name: string): Promise<void> =>
      withIdentitiesLock(async () => {
        const fresh = loadIdentities() ?? { version: IDENTITIES_VERSION, identities: {} };
        await Promise.resolve();
        saveIdentities({
          ...fresh,
          identities: {
            ...fresh.identities,
            [name]: {
              privkey: name.padEnd(64, "0"),
              pubkey: name.padEnd(64, "0"),
              createdAt: 1,
            },
          },
        });
      });

    await Promise.all([writeEntry("a"), writeEntry("b")]);

    const final = loadIdentities();
    expect(Object.keys(final?.identities ?? {}).sort()).toEqual(["a", "b"]);
  });

  it("surfaces identities_locked when the retry budget is exhausted", async () => {
    const release = await lockfile.lock(tmp.identitiesFile, {
      lockfilePath: tmp.lockFile,
      stale: 60_000,
      realpath: false,
    });

    try {
      const err = await withIdentitiesLock(() => "should-not-run", {
        stale: 60_000,
        retries: 2,
        retryIntervalMs: 50,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DvmError);
      expect((err as DvmError).code).toBe("identities_locked");
      expect((err as DvmError).hint).toMatch(/Wait a moment and retry/);
      expect((err as DvmError).data?.lock_file).toBe(tmp.lockFile);
    } finally {
      await release();
    }
  });

  it("reclaims a stale lock left by a crashed process", async () => {
    mkdirSync(tmp.lockFile);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(tmp.lockFile, longAgo, longAgo);

    const result = await withIdentitiesLock(() => "reclaimed", {
      stale: 2_000,
      retries: 5,
      retryIntervalMs: 100,
    });

    expect(result).toBe("reclaimed");
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("releases the lock even when the body throws", async () => {
    await expect(
      withIdentitiesLock(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(existsSync(tmp.lockFile)).toBe(false);

    const result = await withIdentitiesLock(() => "next");
    expect(result).toBe("next");
  });
});
