import { describe, expect, it } from "vitest";

import { isValidEvmPrivateKey } from "../evm-private-key";

const SECP256K1_ORDER = "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141";

describe("isValidEvmPrivateKey", () => {
  it.each([
    ["the scalar one", `0x${"0".repeat(63)}1`, true],
    [
      "the largest valid scalar",
      "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140",
      true,
    ],
    ["zero", `0x${"0".repeat(64)}`, false],
    ["the curve order", `0x${SECP256K1_ORDER}`, false],
    ["a scalar above the curve order", `0x${"f".repeat(64)}`, false],
    ["non-hex input", `0x${"g".repeat(64)}`, false],
    ["an unprefixed value", "1".repeat(64), false],
  ])("classifies %s", (_label, value, expected) => {
    expect(isValidEvmPrivateKey(value)).toBe(expected);
  });
});
