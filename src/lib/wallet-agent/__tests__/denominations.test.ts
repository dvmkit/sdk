import { describe, expect, it } from "vitest";

import { computeSmartDenominations } from "../denominations";

describe("computeSmartDenominations", () => {
  it("returns an empty array for non-positive amounts", () => {
    expect(computeSmartDenominations(0)).toEqual([]);
    expect(computeSmartDenominations(-1)).toEqual([]);
    expect(computeSmartDenominations(NaN)).toEqual([]);
  });

  it("falls back to a pure power-of-2 split below the long-tail threshold", () => {
    const denoms = computeSmartDenominations(5);
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(5);
    expect(denoms.every((n) => isPowerOfTwo(n))).toBe(true);
    expect(denoms).toEqual([1, 4]);
  });

  it("includes a long tail of small denominations above the threshold", () => {
    const denoms = computeSmartDenominations(5_000);
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(5_000);
    const counts = countByValue(denoms);
    // 5/10/20 % long tail at 1/2/4 sat. The greedy split of the remainder
    // may add a few extra small coins on top — we assert "≥" the targeted
    // counts so the check stays robust to remainder bit decomposition.
    expect(counts.get(1) ?? 0).toBeGreaterThanOrEqual(250);
    expect(counts.get(2) ?? 0).toBeGreaterThanOrEqual(250);
    expect(counts.get(4) ?? 0).toBeGreaterThanOrEqual(250);
    expect(denoms.every((n) => isPowerOfTwo(n))).toBe(true);
    expect(denoms.some((n) => n >= 1024)).toBe(true);
  });

  it("handles tiny values (1 sat) without crashing", () => {
    expect(computeSmartDenominations(1)).toEqual([1]);
  });

  it("respects maxDenomination by replacing oversized bits with multiples of the cap", () => {
    const denoms = computeSmartDenominations(500_000, { maxDenomination: 1 << 15 });
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(500_000);
    expect(Math.max(...denoms)).toBeLessThanOrEqual(1 << 15);
    expect(denoms.every((n) => isPowerOfTwo(n))).toBe(true);
  });

  it("rounds non-power-of-2 caps down to the nearest power of 2", () => {
    const denoms = computeSmartDenominations(50_000, { maxDenomination: 30_000 });
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(50_000);
    expect(Math.max(...denoms)).toBeLessThanOrEqual(16_384);
    expect(denoms.every((n) => isPowerOfTwo(n))).toBe(true);
  });

  it("ignores caps that are zero or non-finite (treats as uncapped)", () => {
    const denoms = computeSmartDenominations(500_000, { maxDenomination: 0 });
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(500_000);
    expect(denoms.some((n) => n >= 1 << 16)).toBe(true);
  });

  it("returns a pure greedy power-of-2 split when includeTinyTail is false", () => {
    // fund.ts / recovery.ts opt out — proofs go through the swap path so
    // the tail would only inflate wallet.proofs[].
    const denoms = computeSmartDenominations(5_000, { includeTinyTail: false });
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(5_000);
    expect(denoms.every((n) => isPowerOfTwo(n))).toBe(true);
    const counts = countByValue(denoms);
    // Greedy split of 5000 (= 0b1001110001000) emits at most one coin per
    // bit position — never ≥250 of the tiny denominations.
    expect(counts.get(1) ?? 0).toBeLessThanOrEqual(1);
    expect(counts.get(2) ?? 0).toBeLessThanOrEqual(1);
    expect(counts.get(4) ?? 0).toBeLessThanOrEqual(1);
  });

  it("still emits the long tail when includeTinyTail is true (explicit opt-in)", () => {
    const denoms = computeSmartDenominations(5_000, { includeTinyTail: true });
    expect(denoms.reduce((s, n) => s + n, 0)).toBe(5_000);
    const counts = countByValue(denoms);
    expect(counts.get(1) ?? 0).toBeGreaterThanOrEqual(250);
    expect(counts.get(2) ?? 0).toBeGreaterThanOrEqual(250);
    expect(counts.get(4) ?? 0).toBeGreaterThanOrEqual(250);
  });
});

function countByValue(denoms: number[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const d of denoms) out.set(d, (out.get(d) ?? 0) + 1);
  return out;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}
