import { describe, expect, it } from "vitest";

import { hashLockKey } from "../wallet-accumulator-store";

describe("hashLockKey", () => {
  it("returns a deterministic int8-range value", () => {
    const key = hashLockKey("wallet_accumulator:dvm-1");
    expect(typeof key).toBe("bigint");
    expect(key).toBeGreaterThanOrEqual(-(1n << 63n));
    expect(key).toBeLessThan(1n << 63n);
    expect(hashLockKey("wallet_accumulator:dvm-1")).toBe(key);
  });

  it("differs for distinct DVM ids (collision-tolerant best-effort)", () => {
    const a = hashLockKey("wallet_accumulator:dvm-A");
    const b = hashLockKey("wallet_accumulator:dvm-B");
    expect(a).not.toBe(b);
  });
});
