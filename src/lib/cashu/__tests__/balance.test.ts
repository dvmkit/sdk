import { beforeEach, describe, expect, it, vi } from "vitest";

import { getBalance, getBalanceByMint } from "../balance";

vi.mock("../../wallet-agent/store", () => ({
  loadAgentWallet: vi.fn(),
}));

import { loadAgentWallet } from "../../wallet-agent/store";

function makeWallet(proofs: { mint: string; amount: number; status?: "valid" | "in_flight" }[]) {
  return {
    version: 9 as const,
    lock_privkey: "aabbcc",
    lock_pubkey: "ddeeff",
    mnemonic_fingerprint: null,
    mints: [],
    nut13_counters: {},
    pending_mints: [],
    pending_melts: [],
    pending_submissions: [],
    recent_spends: [],
    created_at: new Date().toISOString(),
    proofs: proofs.map((p) => ({
      mint: p.mint,
      amount: p.amount,
      status: p.status ?? "valid",
      secret: `s-${p.amount}`,
      C: "02abc",
      id: "k1",
      locked_to_pubkey: null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getBalance", () => {
  it("totals valid proofs in msats with an optional mint filter", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      makeWallet([
        { mint: "https://mint.a", amount: 4 },
        { mint: "https://mint.a", amount: 8 },
        { mint: "https://mint.b", amount: 2 },
        { mint: "https://mint.a", amount: 5, status: "in_flight" },
        { mint: "https://mint.b", amount: 3, status: "in_flight" },
      ])
    );
    expect(getBalance()).toBe(14_000);
    expect(getBalance("https://mint.a")).toBe(12_000);
  });

  it("returns 0 when no proofs", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(makeWallet([]));
    expect(getBalance()).toBe(0);
  });

  it("returns 0 when wallet does not exist", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    expect(getBalance()).toBe(0);
  });

});

describe("getBalanceByMint", () => {
  it("returns balance per mint in msats", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(
      makeWallet([
        { mint: "https://mint.a", amount: 4 },
        { mint: "https://mint.a", amount: 2 },
        { mint: "https://mint.b", amount: 8 },
        { mint: "https://mint.a", amount: 3, status: "in_flight" },
        { mint: "https://mint.c", amount: 5, status: "in_flight" },
      ])
    );

    const map = getBalanceByMint();
    expect(map.get("https://mint.a")).toBe(6_000);
    expect(map.get("https://mint.b")).toBe(8_000);
    expect(map.size).toBe(2);
    expect(map.has("https://mint.c")).toBe(false);
  });

  it("returns empty map when no proofs", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(makeWallet([]));
    expect(getBalanceByMint().size).toBe(0);
  });

  it("returns empty map when wallet does not exist", () => {
    vi.mocked(loadAgentWallet).mockReturnValue(null);
    expect(getBalanceByMint().size).toBe(0);
  });

});
