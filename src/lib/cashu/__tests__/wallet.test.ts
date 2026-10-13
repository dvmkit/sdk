import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSend = vi.fn();
const mockReceive = vi.fn();
const mockLoadMint = vi.fn();
const mockGetKeysets = vi.fn().mockReturnValue([]);
const mockGetKeyset = vi.fn().mockReturnValue({ id: "0112345678abcd" });

const COINOS_MIXED_KEYSETS = [
  {
    id: "01182e5f5e35aecd90da50a53c95667f745bc08ded556085c795c94adfa40b8591",
    isActive: true,
    unit: "sat",
  },
  { id: "004f7adf2a04356c", isActive: false, unit: "sat" },
  { id: "007311aa2fa58cc8", isActive: false, unit: "sat" },
];

const ALL_NUTS_FOR_MOCK = {
  ...Object.fromEntries(DEFAULT_REQUIRED_NUTS.map((n) => [String(n), { supported: true }])),
  "4": { methods: [{ method: "bolt11", unit: "sat" }] },
  "5": { methods: [{ method: "bolt11", unit: "sat" }] },
};
const mockGetMintInfo = vi.fn().mockReturnValue({ cache: { nuts: ALL_NUTS_FOR_MOCK } });

vi.mock("@cashu/cashu-ts", () => {
  const MockWallet = vi.fn(function (this: Record<string, unknown>) {
    this.send = mockSend;
    this.receive = mockReceive;
    this.loadMint = mockLoadMint;
    this.getMintInfo = mockGetMintInfo;
    this.keyChain = { getKeysets: mockGetKeysets };
    this.getKeyset = mockGetKeyset;
    this.unit = "sat";
  });
  return {
    Wallet: MockWallet,
    getTokenMetadata: vi.fn(),
    getEncodedToken: vi.fn(),
    Amount: { from: (x: unknown) => ({ toNumber: () => Number(x) }) },
  };
});
vi.mock("@scure/bip39", () => ({
  mnemonicToSeedSync: vi.fn((m: string) => new Uint8Array([1, 2, 3, m.length])),
}));
vi.mock("../../wallet-agent/agent-mnemonic-file", () => ({
  readAgentMnemonic: vi.fn().mockReturnValue(null),
}));
vi.mock("../../wallet-agent/store", () => ({
  loadAgentWallet: vi.fn().mockReturnValue(null),
}));
vi.mock("../../wallet-agent/mnemonic", () => ({
  mnemonicFingerprint: vi.fn((m: string) => `fp:${m}`),
}));
vi.mock("../../wallet-agent/nut13-counters", () => ({
  PersistentCounterSource: vi.fn(function (this: Record<string, unknown>, mintUrl: string) {
    this.mintUrl = mintUrl;
  }),
}));
vi.mock("../../errors", () => ({
  DvmError: class DvmError extends Error {
    code: string;
    hint?: string;
    constructor(code: string, message: string, hint?: string) {
      super(message);
      this.code = code;
      this.hint = hint;
      this.name = "DvmError";
    }
  },
}));

import { Wallet } from "@cashu/cashu-ts";

import { DvmError } from "../../errors";
import { readAgentMnemonic } from "../../wallet-agent/agent-mnemonic-file";
import { PersistentCounterSource } from "../../wallet-agent/nut13-counters";
import { loadAgentWallet } from "../../wallet-agent/store";
import { DEFAULT_REQUIRED_NUTS } from "../health";
import { getWallet } from "../wallet";

beforeEach(() => {
  vi.clearAllMocks();
  mockGetKeysets.mockReturnValue([]);
  mockGetKeyset.mockReturnValue({ id: "0112345678abcd" });
  mockGetMintInfo.mockReturnValue({ cache: { nuts: ALL_NUTS_FOR_MOCK } });
  vi.mocked(readAgentMnemonic).mockReturnValue(null);
  vi.mocked(loadAgentWallet).mockReturnValue(null);
});

describe("getWallet — degraded mode (no NUT-13)", () => {
  it("constructs Wallet with URL only when no agent wallet on disk", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue(null);

    await getWallet("https://nut13-degraded-no-wallet.example");

    expect(vi.mocked(Wallet)).toHaveBeenCalledWith("https://nut13-degraded-no-wallet.example");
  });

  it("constructs Wallet with URL only when the wallet has no mnemonic_fingerprint", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: null } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("dummy");

    await getWallet("https://nut13-degraded-no-fingerprint.example");

    expect(vi.mocked(Wallet)).toHaveBeenCalledWith("https://nut13-degraded-no-fingerprint.example");
  });

  it("constructs Wallet with URL only when the mnemonic sibling file is missing", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:something" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue(null);

    await getWallet("https://nut13-degraded-no-mnemonic-file.example");

    expect(vi.mocked(Wallet)).toHaveBeenCalledWith(
      "https://nut13-degraded-no-mnemonic-file.example"
    );
  });

  it("V1 keysets pass in degraded mode (legacy random-secret path still works)", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    mockGetKeysets.mockReturnValue([{ id: "0012345678abcd", isActive: true, unit: "sat" }]);

    await expect(getWallet("https://nut13-degraded-v1-ok.example")).resolves.toBeDefined();
  });
});

describe("getWallet — NUT-13 activation", () => {
  it("constructs Wallet with bip39seed + counterSource when wallet fingerprint matches the mnemonic file", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:match-me" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("match-me");

    await getWallet("https://nut13-active.example");

    expect(vi.mocked(Wallet)).toHaveBeenCalledWith(
      "https://nut13-active.example",
      expect.objectContaining({
        bip39seed: new Uint8Array([1, 2, 3, 8]),
        counterSource: expect.any(Object),
      })
    );
    expect(vi.mocked(PersistentCounterSource)).toHaveBeenCalledWith("https://nut13-active.example");
  });

  it("throws wallet_mnemonic_mismatch when fingerprints disagree", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:expected" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("a-different-mnemonic");

    await expect(getWallet("https://nut13-mismatch.example")).rejects.toMatchObject({
      code: "wallet_mnemonic_mismatch",
    });
  });

  it("degrades to random-secret mode when a NUT-13 wallet meets a V1 keyset (2026-01 disclosure)", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:v1-test" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("v1-test");
    mockGetKeysets.mockReturnValue([{ id: "0012345678abcd", isActive: true, unit: "sat" }]);
    mockGetKeyset.mockReturnValue({ id: "0012345678abcd" });

    await expect(getWallet("https://nut13-v1-degrade.example")).resolves.toBeDefined();

    // First construction is NUT-13-eligible (carries bip39seed); the V1
    // keyset forces a rebuild with the URL only — random-secret mode for
    // this mint alone.
    expect(vi.mocked(Wallet)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(Wallet)).toHaveBeenLastCalledWith("https://nut13-v1-degrade.example");
  });

  it("keeps NUT-13 active when Coinos serves V2 active and retired V1 keysets", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:v2-test" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("v2-test");
    mockGetKeysets.mockReturnValue(COINOS_MIXED_KEYSETS);

    await expect(getWallet("https://nut13-coinos-mixed-keysets.example")).resolves.toBeDefined();

    expect(vi.mocked(Wallet)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Wallet)).toHaveBeenCalledWith(
      "https://nut13-coinos-mixed-keysets.example",
      expect.objectContaining({
        bip39seed: new Uint8Array([1, 2, 3, 7]),
        counterSource: expect.any(Object),
      })
    );
  });

  it("keeps NUT-13 active when an unselected active V1 keyset accompanies the V2 output keyset", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({
      mnemonic_fingerprint: "fp:unselected-v1",
    } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("unselected-v1");
    mockGetKeysets.mockReturnValue([
      { id: "0100000001", isActive: true, unit: "sat" },
      { id: "0000000000000003", isActive: true, unit: "sat" },
    ]);
    mockGetKeyset.mockReturnValue({ id: "0100000001" });

    await expect(getWallet("https://nut13-unselected-v1.example")).resolves.toBeDefined();
    expect(vi.mocked(Wallet)).toHaveBeenCalledTimes(1);
  });
});

describe("NUT-support guard", () => {
  const REQUIRED = DEFAULT_REQUIRED_NUTS;
  const ALL_NUTS = Object.fromEntries(REQUIRED.map((n) => [String(n), { supported: true }]));

  it("accepts a mint that supports all required NUTs", async () => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue(null);

    await expect(getWallet("https://nut-support-all-ok.example")).resolves.toBeDefined();
  });

  it.each(REQUIRED)("refuses a mint missing NUT-%i with cashu_nut_support_missing", async (nut) => {
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    const { [String(nut)]: _removed, ...nutsWithout } = ALL_NUTS;
    mockGetMintInfo.mockReturnValue({ cache: { nuts: nutsWithout } });

    try {
      await getWallet(`https://nut-${nut}-missing.example`);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DvmError);
      expect((e as DvmError).code).toBe("cashu_nut_support_missing");
      expect((e as DvmError).message).toMatch(new RegExp(String(nut)));
    }
  });
});

describe("keyset-collision guard", () => {
  it("checks a retired V2 keyset because mnemonic restore still derives through it", async () => {
    // These IDs share a 31-bit residue. The retired V2 keyset must enter the
    // guard because `dvm wallet restore` calls batchRestore for every V2
    // keyset, not only the wallet's selected output keyset.
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:retired-v2" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("retired-v2");
    mockGetKeysets.mockReturnValue([
      { id: "0100000010", isActive: true, unit: "sat" },
      { id: "018000000f", isActive: false, unit: "sat" },
    ]);
    mockGetKeyset.mockReturnValue({ id: "0100000010" });

    await expect(getWallet("https://nut13-retired-v2-collision.example")).rejects.toMatchObject({
      code: "cashu_keyset_collision",
    });
  });

  it("excludes a retired V2 keyset from another unit", async () => {
    // These IDs share a 31-bit residue, but only the sat keyset can be
    // restored by this wallet. The USD keyset must not enter the guard.
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:usd-v2" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("usd-v2");
    mockGetKeysets.mockReturnValue([
      { id: "0100000020", isActive: true, unit: "sat" },
      { id: "018000001f", isActive: false, unit: "usd" },
    ]);
    mockGetKeyset.mockReturnValue({ id: "0100000020" });

    await expect(getWallet("https://nut13-usd-v2-collision.example")).resolves.toBeDefined();
  });

  it("throws cashu_keyset_collision when two NUT-13 mints share the same 31-bit residue", async () => {
    // V2 keysets "0100000001" and "0180000000" both reduce to residue 3
    // (mod 2^31-1) → identical NUT-13 BIP-32 derivation path. The guard
    // only runs when NUT-13 is active (it protects deterministic
    // derivation), so the colliding keysets must be V2 — a V1 keyset would
    // degrade the mint to random secrets and skip the check entirely.
    mockLoadMint.mockResolvedValue(undefined);
    vi.mocked(loadAgentWallet).mockReturnValue({ mnemonic_fingerprint: "fp:collision" } as never);
    vi.mocked(readAgentMnemonic).mockReturnValue("collision");

    mockGetKeysets.mockReturnValueOnce([{ id: "0100000001", isActive: true, unit: "sat" }]);
    await getWallet("https://collision-guard-a.example");

    mockGetKeysets.mockReturnValueOnce([{ id: "0180000000", isActive: true, unit: "sat" }]);
    await expect(getWallet("https://collision-guard-b.example")).rejects.toMatchObject({
      code: "cashu_keyset_collision",
    });
  });
});
