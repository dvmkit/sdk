

import { spawn } from "node:child_process";

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "fs";
import path from "path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tmp = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs");
  const os = require("os");
  const nodePath = require("path");
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "dvm-credit-lock-")) as string;
  /* eslint-enable @typescript-eslint/no-require-imports */
  return {
    configDir: dir,
    creditsFile: `${dir}/credits.json`,
    lockFile: `${dir}/credits.json.lock`,
  };
});

vi.mock("../../defaults", () => ({
  CONFIG_DIR: tmp.configDir,
  CREDITS_FILE: tmp.creditsFile,
}));
vi.mock("../output", () => ({ info: vi.fn() }));

import {
  applyReceiptCredit,
  listCredits,
  loadCredit,
  recordFundResponse,
  withCreditLock,
} from "../credit-store";
import { DvmError } from "../errors";
import type { CreditWire } from "../transport/types";

const ENDPOINT = "https://wordcount.example";
const PUBKEY = "bb".repeat(32);
const CREDIT_ID = "credit-1";
const DRAIN_IDS = Array.from({ length: 8 }, (_, i) => `drain-${String(i)}`);

const WIRE: CreditWire = {
  credit_id: CREDIT_ID,
  currency: "usd",
  balance_micro: 1_000_000,
  remaining_micro: 1_000_000,
  expiry_ms: 0,
  expired: false,
  drainable: true,
  ledger_seq: 0,
};

function corruptFiles(): string[] {
  return readdirSync(tmp.configDir)
    .filter((name) => name.startsWith("credits.json.corrupt-"))
    .map((name) => path.join(tmp.configDir, name));
}

beforeEach(() => {
  mkdirSync(tmp.configDir, { recursive: true });
  rmSync(tmp.lockFile, { recursive: true, force: true });
  rmSync(tmp.creditsFile, { force: true });
  for (const file of corruptFiles()) rmSync(file, { force: true });
  // The fixture's rendezvous markers, too: a stale `drains.done` from an
  // earlier run in this dir would let the churner exit after one iteration and
  // the concurrency test would pass having never overlapped.
  for (const marker of ["churn.ready", "drains.ready", "drains.done", "stale.ready", "stale.go"]) {
    rmSync(path.join(tmp.configDir, marker), { force: true });
  }
});

afterEach(() => {
  rmSync(tmp.lockFile, { recursive: true, force: true });
});

describe("withCreditLock", () => {

  it("releases the lock when the body throws", () => {
    expect(() =>
      withCreditLock(() => {
        throw new Error("boom");
      })
    ).toThrow("boom");
    expect(existsSync(tmp.lockFile)).toBe(false);
    expect(withCreditLock(() => "next")).toBe("next");
  });

  it("is reentrant, so a store call nested in a held lock does not deadlock", () => {
    const record = withCreditLock(() => {
      recordFundResponse({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        credit: WIRE,
        targetMicro: 1,
      });
      return loadCredit(ENDPOINT, PUBKEY);
    });
    expect(record?.creditId).toBe(CREDIT_ID);
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("reclaims a stale lock left behind by a killed process", () => {
    // proper-lockfile's primitive is mkdir(lockfile). Simulate a dead holder
    // by backdating the directory well past the stale window.
    mkdirSync(tmp.lockFile);
    const longAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(tmp.lockFile, longAgo, longAgo);

    const result = withCreditLock(() => "reclaimed", {
      stale: 2_000,
      retries: 2,
      retryIntervalMs: 10,
    });
    expect(result).toBe("reclaimed");
    expect(existsSync(tmp.lockFile)).toBe(false);
  });

  it("surfaces credit_store_locked when the retry budget is exhausted", async () => {

    const release = await lockfile.lock(tmp.creditsFile, {
      lockfilePath: tmp.lockFile,
      stale: 60_000,
      realpath: false,
    });
    try {
      let caught: unknown;
      try {
        withCreditLock(() => "should-not-run", { stale: 60_000, retries: 2, retryIntervalMs: 10 });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DvmError);
      expect((caught as DvmError).code).toBe("credit_store_locked");
      expect((caught as DvmError).data?.lock_file).toBe(tmp.lockFile);
      expect((caught as DvmError).hint).toMatch(/Wait a moment and retry/);
    } finally {
      await release();
    }
  });

  // A lock that cannot be *created* is a different fault from one that is
  // held, and the caller must not be told to delete a lock file that does not
  // exist. chmod is meaningless on Windows and root ignores it entirely.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "distinguishes an uncreatable lock from a contended one",
    () => {
      chmodSync(tmp.configDir, 0o500);
      try {
        let caught: unknown;
        try {
          withCreditLock(() => "should-not-run", { retries: 2, retryIntervalMs: 10 });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(DvmError);
        const err = caught as DvmError;
        expect(err.code).toBe("credit_store_lock_failed");
        expect(err.data?.config_dir).toBe(tmp.configDir);

        expect(err.hint).toMatch(/not contention/);
        expect(err.hint).not.toMatch(/remove/i);
      } finally {
        chmodSync(tmp.configDir, 0o700);
      }
    }
  );

  it("refuses an async body rather than releasing the lock under it", () => {
    let caught: unknown;
    try {
      withCreditLock(() => Promise.resolve("too late"));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DvmError);
    expect((caught as DvmError).code).toBe("credit_store_lock_misuse");

    expect(existsSync(tmp.lockFile)).toBe(false);
    expect(withCreditLock(() => "next")).toBe("next");
  });
});

describe("a corrupt store", () => {
  it("quarantines the file, names it, and never rewrites it empty", () => {
    const original = '{"credits": [{"creditId": "credit-1", "pendingDr';
    writeFileSync(tmp.creditsFile, original);

    let caught: unknown;
    try {
      listCredits();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(DvmError);
    const err = caught as DvmError;
    expect(err.code).toBe("credit_store_corrupt");
    const quarantined = err.data?.quarantined_path as string;
    expect(quarantined).toBeTruthy();
    expect(err.message).toContain(quarantined);
    expect(err.hint).toContain("Do not delete");
    expect(err.display).toContain(quarantined);

    expect(readFileSync(quarantined, "utf-8")).toBe(original);
    expect(existsSync(tmp.creditsFile)).toBe(false);
  });

  it("treats a valid-JSON non-object root as corrupt too", () => {
    writeFileSync(tmp.creditsFile, "[]\n");
    expect(() => listCredits()).toThrow(DvmError);
    expect(corruptFiles()).toHaveLength(1);
  });

  it("still tolerates malformed entries inside a well-formed store", () => {

    writeFileSync(
      tmp.creditsFile,
      JSON.stringify({
        credits: [{ endpoint: ENDPOINT, siblingCredits: [null, 7], pendingDrains: "nope" }],
        pendingFundings: "nope",
        fundingMenuSnapshots: [null, { endpoint: ENDPOINT }],
      })
    );
    expect(() => listCredits()).not.toThrow();
    expect(corruptFiles()).toHaveLength(0);
  });
});

describe("a store that cannot be opened", () => {
  // A failed read says nothing about the bytes, so the file keeps both its
  // name and its contents. A directory at the path is the platform-neutral
  // way to force one — chmod 0000 is a no-op under root.
  it("reports the read failure without moving or rewriting anything", () => {
    mkdirSync(tmp.creditsFile);
    try {
      let caught: unknown;
      try {
        listCredits();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DvmError);
      const err = caught as DvmError;
      expect(err.code).toBe("credit_store_unreadable");
      expect(err.hint).toContain("Do not delete");
      expect(err.data?.quarantined_path).toBeUndefined();

      expect(existsSync(tmp.creditsFile)).toBe(true);
      expect(corruptFiles()).toHaveLength(0);
    } finally {
      rmSync(tmp.creditsFile, { recursive: true, force: true });
    }
  });
});

describe("the store's file mode", () => {
  it.skipIf(process.platform === "win32")("is owner-only, since it carries drain receipts", () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: WIRE,
      targetMicro: 1,
    });
    expect(statSync(tmp.creditsFile).mode & 0o777).toBe(0o600);
  });
});

// Two real processes, because that is the shape of the bug: each rewrites the
// whole file from its own snapshot, so without the lock the churner's writes
// erase the drains the other process files between them. The fixture makes the
// two windows overlap rather than merely launching together.
describe("concurrent dvm processes", { timeout: 60_000 }, () => {
  it("keeps every pendingDrains entry and drainEvidence bundle", async () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: WIRE,
      targetMicro: 1_000_000,
    });

    await Promise.all([runWriter("churn", 5_000), runWriter("drains", DRAIN_IDS.length)]);

    const record = loadCredit(ENDPOINT, PUBKEY);
    expect(record?.pendingDrains?.map((d) => d.drainId).sort()).toEqual(DRAIN_IDS);
    expect(record?.drainEvidence?.map((e) => e.drainId).sort()).toEqual(DRAIN_IDS);

    expect(listCredits()).toHaveLength(1);
    // More churn writes than there were drains: proof the two windows really
    // overlapped, rather than the churner exiting on a stale `drains.done`.
    expect(record?.ledgerSeq).toBeGreaterThan(DRAIN_IDS.length);
  });
});

// The consumer's pre-check releases its lookup lock before the receipt is
// applied, so a newer draw can settle in between. The older recovery must then
// leave every field of the newer projection alone.
describe("older receipt recovery racing a newer settlement", { timeout: 60_000 }, () => {
  it("keeps the newer balance, price, attribution and update time", async () => {
    recordFundResponse({
      endpoint: ENDPOINT,
      callerPubkey: PUBKEY,
      credit: { ...WIRE, balance_micro: 500_000, remaining_micro: 500_000, ledger_seq: 1 },
      targetMicro: 500_000,
    });

    const stale = runWriter("stale", 1);
    const deadline = Date.now() + 20_000;
    while (!existsSync(path.join(tmp.configDir, "stale.ready"))) {
      if (Date.now() > deadline) throw new Error("older recovery never reached its pause");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    for (const [seq, amount, balanceAfter] of [
      [2, 150_000, 350_000],
      [3, 200_000, 150_000],
    ] as const) {
      applyReceiptCredit({
        endpoint: ENDPOINT,
        callerPubkey: PUBKEY,
        jobId: `job-${String(seq)}`,
        outcome: "completed",
        credit: {
          credit_id: CREDIT_ID,
          draw_id: `draw-${String(seq)}`,
          amount,
          balance_after: balanceAfter,
          ledger_seq: seq,
        },
        now: 1_000 * seq,
      });
    }
    const settled = loadCredit(ENDPOINT, PUBKEY);

    writeFileSync(path.join(tmp.configDir, "stale.go"), "");
    await stale;

    expect(settled).toMatchObject({ lastPriceMicro: 200_000, lastReceiptJobId: "job-3" });
    expect(loadCredit(ENDPOINT, PUBKEY)).toEqual(settled);
  });
});

function runWriter(role: string, iterations: number): Promise<void> {
  const fixture = path.resolve(__dirname, "fixtures/credit-store-writer.ts");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", fixture, role, ENDPOINT, PUBKEY, CREDIT_ID, String(iterations)],
      { env: { ...process.env, DVM_CONFIG_DIR: tmp.configDir }, stdio: "pipe" }
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${role} writer exited ${String(code)}: ${stderr}`));
    });
  });
}
