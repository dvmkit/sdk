import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import lockfile from "proper-lockfile";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  const tmpRoot = process.env.TMPDIR ?? process.env.TMP ?? "/tmp";
  const dir = `${tmpRoot.replace(/\/$/, "")}/dvm-wallet-lock-${process.pid}-${Date.now()}`;
  const walletFile = `${dir}/wallet.json`;
  return { configDir: dir, walletFile, lockFile: `${walletFile}.lock` };
});

vi.mock("../../../defaults", () => ({
  CONFIG_DIR: tmp.configDir,
  WALLET_FILE: tmp.walletFile,
}));

import { DvmError } from "../../errors";
import { type AgentWallet, loadAgentWallet, saveAgentWallet, withWalletLock } from "../store";

const validWallet: AgentWallet = {
  version: 9,
  lock_privkey: "ab".repeat(32),
  lock_pubkey: "02" + "cd".repeat(32),
  mnemonic_fingerprint: null,
  mints: [],
  proofs: [],
  nut13_counters: {},
  pending_mints: [],
  pending_melts: [],
  pending_submissions: [],
  recent_spends: [],
  created_at: "2026-05-09T00:00:00.000Z",
};

function ensureCleanState(): void {
  if (existsSync(tmp.lockFile)) {
    rmSync(tmp.lockFile, { recursive: true, force: true });
  }
  if (existsSync(tmp.walletFile)) {
    rmSync(tmp.walletFile, { force: true });
  }
}

beforeAll(() => {
  mkdirSync(tmp.configDir, { recursive: true });
});

beforeEach(() => {
  ensureCleanState();
  writeFileSync(tmp.walletFile, JSON.stringify(validWallet), { mode: 0o600 });
});

afterEach(() => {
  ensureCleanState();
});

afterAll(() => {
  rmSync(tmp.configDir, { recursive: true, force: true });
});

describe("withWalletLock", () => {
  it("acquires the lock, runs the body, and releases", async () => {
    const result = await withWalletLock(() => "ok");
    expect(result).toBe("ok");
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("serialises concurrent invocations within a single process", async () => {
    // proper-lockfile guarantees mutual exclusion, not FIFO ordering across
    // pending acquisitions — assert non-overlap rather than a fixed sequence.
    const order: string[] = [];

    const a = withWalletLock(async () => {
      order.push("a-start");
      await new Promise((resolve) => setTimeout(resolve, 80));
      order.push("a-end");
    });

    const b = withWalletLock(() => {
      order.push("b-start");
      order.push("b-end");
    });

    await Promise.all([a, b]);

    const aStart = order.indexOf("a-start");
    const aEnd = order.indexOf("a-end");
    const bStart = order.indexOf("b-start");
    const bEnd = order.indexOf("b-end");

    expect(aStart).toBeGreaterThanOrEqual(0);
    expect(aEnd).toBeGreaterThan(aStart);
    expect(bStart).toBeGreaterThanOrEqual(0);
    expect(bEnd).toBeGreaterThan(bStart);

    expect(aEnd < bStart || bEnd < aStart).toBe(true);
  });

  it("prevents lost updates: two concurrent read-modify-write cycles both persist", async () => {
    const writeProof = (id: string): Promise<void> =>
      withWalletLock(async () => {
        const fresh = loadAgentWallet();
        if (!fresh) throw new Error("wallet vanished");
        await new Promise<void>((resolve) => setImmediate(resolve));
        saveAgentWallet({
          ...fresh,
          proofs: [
            ...fresh.proofs,
            {
              mint: "https://mint.example",
              secret: id,
              C: "02" + id.padEnd(64, "0"),
              amount: 1,
              id,
              locked_to_pubkey: validWallet.lock_pubkey,
              status: "valid",
            },
          ],
        });
      });

    await Promise.all([writeProof("a"), writeProof("b")]);

    const final = loadAgentWallet();
    expect(final?.proofs.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("reclaims a stale lock left behind by a crashed process", async () => {
    // proper-lockfile's lock primitive is mkdir(lockfile). Simulate a dead
    // holder by creating the dir with an mtime well past the stale window.
    mkdirSync(tmp.lockFile);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(tmp.lockFile, longAgo, longAgo);

    const result = await withWalletLock(() => "reclaimed", {
      stale: 2_000,
      retries: 5,
      retryIntervalMs: 100,
    });

    expect(result).toBe("reclaimed");
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("surfaces wallet_locked when the retry budget is exhausted", async () => {
    // Hold the lock from outside via proper-lockfile directly. Use a long
    // stale window + active refresh so the wrapper can't reclaim it.
    const release = await lockfile.lock(tmp.walletFile, {
      lockfilePath: tmp.lockFile,
      stale: 60_000,
      realpath: false,
    });

    try {
      const err = await withWalletLock(() => "should-not-run", {
        stale: 60_000,
        retries: 2,
        retryIntervalMs: 50,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(DvmError);
      expect((err as DvmError).code).toBe("wallet_locked");
      expect((err as DvmError).hint).toMatch(/Wait a moment and retry/);
      expect((err as DvmError).data?.lock_file).toBe(tmp.lockFile);
    } finally {
      await release();
    }
  });

  it("releases the lock even when the body throws", async () => {
    await expect(
      withWalletLock(() => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(existsSync(tmp.lockFile)).toBe(false);

    const result = await withWalletLock(() => "next");
    expect(result).toBe("next");
  });
});
