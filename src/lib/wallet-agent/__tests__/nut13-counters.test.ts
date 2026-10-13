import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../store", () => ({
  loadAgentWallet: vi.fn(),
  saveAgentWallet: vi.fn(),
  withWalletLock: vi.fn(async <T>(fn: () => Promise<T> | T) => fn()),
}));

import { DvmError } from "../../errors";

import { PersistentCounterSource } from "../nut13-counters";
import { loadAgentWallet, saveAgentWallet } from "../store";

function walletFixture(counters: Record<string, Record<string, number>> = {}) {
  return {
    version: 9 as const,
    lock_privkey: "ab".repeat(32),
    lock_pubkey: "02" + "cd".repeat(32),
    mnemonic_fingerprint: null,
    mints: [],
    proofs: [],
    nut13_counters: counters,
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: "2026-05-09T00:00:00.000Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PersistentCounterSource", () => {
  it("reserve(n): reads the current next for the keyset, returns { start, count: n }, persists start + n", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture({ "https://mint.a": { k1: 5 } }));
    const src = new PersistentCounterSource("https://mint.a");

    const range = await src.reserve("k1", 3);

    expect(range).toEqual({ start: 5, count: 3 });
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.nut13_counters).toEqual({ "https://mint.a": { k1: 8 } });
  });

  it("reserve(n) starts from 0 for an uninitialised (mint, keyset) pair", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture());
    const src = new PersistentCounterSource("https://mint.a");

    const range = await src.reserve("brand-new-keyset", 2);

    expect(range).toEqual({ start: 0, count: 2 });
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.nut13_counters["https://mint.a"]?.["brand-new-keyset"]).toBe(2);
  });

  it("reserve(0): pure peek, no state mutation, no lock acquisition", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture({ "https://mint.a": { k1: 12 } }));
    const src = new PersistentCounterSource("https://mint.a");

    const range = await src.reserve("k1", 0);

    expect(range).toEqual({ start: 12, count: 0 });
    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("advanceToAtLeast: monotonic bump only", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture({ "https://mint.a": { k1: 10 } }));
    const src = new PersistentCounterSource("https://mint.a");

    await src.advanceToAtLeast("k1", 15);

    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.nut13_counters["https://mint.a"]?.k1).toBe(15);
  });

  it("advanceToAtLeast: no-op when wallet is already ahead", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture({ "https://mint.a": { k1: 50 } }));
    const src = new PersistentCounterSource("https://mint.a");

    await src.advanceToAtLeast("k1", 10);

    expect(saveAgentWallet).not.toHaveBeenCalled();
  });

  it("setNext: hard-sets the cursor (used by restore)", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(walletFixture({ "https://mint.a": { k1: 0 } }));
    const src = new PersistentCounterSource("https://mint.a");

    await src.setNext("k1", 42);

    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.nut13_counters["https://mint.a"]?.k1).toBe(42);
  });

  it("snapshot returns the per-keyset map for the configured mint only", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      walletFixture({
        "https://mint.a": { k1: 7, k2: 3 },
        "https://mint.b": { kx: 11 },
      })
    );
    const src = new PersistentCounterSource("https://mint.a");

    await expect(src.snapshot()).resolves.toEqual({ k1: 7, k2: 3 });
  });

  it("multiple mints share the wallet file without overlapping under the same keyset id", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      walletFixture({
        "https://mint.a": { k1: 1 },
        "https://mint.b": { k1: 99 },
      })
    );
    const srcA = new PersistentCounterSource("https://mint.a");
    const rangeA = await srcA.reserve("k1", 1);
    expect(rangeA).toEqual({ start: 1, count: 1 });

    // The save preserves the other mint's untouched counter.
    const saved = vi.mocked(saveAgentWallet).mock.calls[0][0];
    expect(saved.nut13_counters["https://mint.a"]?.k1).toBe(2);
    expect(saved.nut13_counters["https://mint.b"]?.k1).toBe(99);
  });

  it("throws wallet_missing when the agent wallet is absent and a mutation is attempted", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const src = new PersistentCounterSource("https://mint.a");

    const error = await src.reserve("k1", 1).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(DvmError);
    expect(error).toMatchObject({ code: "wallet_missing" });
  });

  it("reserve(0) on a missing wallet returns { start: 0, count: 0 } without throwing (peek must never mutate)", async () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const src = new PersistentCounterSource("https://mint.a");

    await expect(src.reserve("k1", 0)).resolves.toEqual({ start: 0, count: 0 });
  });

  });
