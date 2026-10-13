import { describe, expect, it } from "vitest";

import {
  assertNoRivalX402Voucher,
  type PendingX402Funding,
  x402VoucherPendingState,
} from "../voucher-pending";

const channelId = `0x${"12".repeat(32)}` as const;
function pending(overrides: Partial<PendingX402Funding> = {}): PendingX402Funding {
  return {
    endpoint: "https://example.com",
    callerPubkey: "ab".repeat(32),
    creditId: "credit-rival",
    fundId: "fund-rival",
    channelId,
    amountMicro: 100_000,
    targetMicro: 200_000,
    paymentHeader: "signed-credential",
    requestedAt: 1_000,
    ...overrides,
  };
}

describe("pending voucher facts", () => {
  for (const [label, overrides, retired, blockedUntil, depositExpiresAt] of [
    ["live voucher", {}, false, 86_401_000, undefined],
    ["refused deposit", { refusedAt: 0, authorizationValidBefore: "2000" }, true, 2_000_000, 2_000_000],
    ["superseded deposit", { supersededAt: 0, authorizationValidBefore: "2000" }, true, 2_000_000, 2_000_000],
    ["legacy refusal", { refusedAt: 0 }, true, 86_401_000, undefined],
    ["unreadable expiry", { refusedAt: 0, authorizationValidBefore: "not-a-deadline" }, true, 86_401_000, undefined],
  ] as const) {
    it(`projects ${label} without advice or signed credentials`, () => {
      expect(x402VoucherPendingState(pending(overrides))).toEqual({
        code: "x402_voucher_pending",
        creditId: "credit-rival",
        fundId: "fund-rival",
        channelId,
        endpoint: "https://example.com",
        retired,
        blockedUntil,
        ...(depositExpiresAt === undefined ? {} : { depositExpiresAt }),
      });
    });
  }


});

describe("shared rival voucher gate", () => {
  it("prefers a live rival across endpoint scopes over retired same-credit authority", () => {
    const entries = [
      pending({ creditId: "credit-current", refusedAt: 1, authorizationValidBefore: "2000" }),
      pending({ endpoint: "https://other.example.com", fundId: "live-fund" }),
    ];
    expect(() => assertNoRivalX402Voucher(channelId, "credit-current", entries, 1_000)).toThrowError(expect.objectContaining({
      code: "x402_voucher_pending", creditId: "credit-rival", fundId: "live-fund", endpoint: "https://other.example.com", retired: false,
    }));
  });

  it("allows same-credit replay even when an active signature is old", () => {
    expect(() => assertNoRivalX402Voucher(channelId, "credit-rival", [pending()], 100_000_000)).not.toThrow();
    expect(() => assertNoRivalX402Voucher(channelId, "other-credit", [pending()], 100_000_000)).toThrowError(expect.objectContaining({ retired: false }));
  });

  for (const retirement of [{ refusedAt: 0 }, { supersededAt: 0 }]) {
    it(`blocks same-credit ${"refusedAt" in retirement ? "refused" : "superseded"} authority through its exact signed deadline`, () => {
      const entry = pending({ creditId: "credit-current", authorizationValidBefore: "2", ...retirement });
      expect(() => assertNoRivalX402Voucher(channelId, "credit-current", [entry], 2_000)).toThrowError(expect.objectContaining({
        retired: true, blockedUntil: 2_000, depositExpiresAt: 2_000,
      }));
      expect(() => assertNoRivalX402Voucher(channelId, "credit-current", [entry], 2_001)).not.toThrow();
    });
  }

  it("keeps fallback authority until the conservative cutoff and uses canonical channel identity", () => {
    const canonical = `0x${"AB".repeat(32)}` as const;
    const entry = pending({ refusedAt: 1, channelId: `0x${"ab".repeat(32)}` });
    expect(() => assertNoRivalX402Voucher(canonical, "credit-current", [entry], 86_401_000)).toThrowError(expect.objectContaining({ channelId: canonical, blockedUntil: 86_401_000 }));
    expect(() => assertNoRivalX402Voucher(canonical, "credit-current", [entry], 86_401_001)).not.toThrow();
  });
});
