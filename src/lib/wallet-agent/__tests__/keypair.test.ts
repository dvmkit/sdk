import { describe, expect, it } from "vitest";

import { DvmError } from "../../errors";
import { derivePubkeyFromPrivkey, generateAgentKeypair, PRIVKEY_HEX_RE } from "../keypair";

describe("agent wallet keypair", () => {
  describe("generateAgentKeypair", () => {
    it("returns a 64-char hex privkey and 66-char hex compressed pubkey", () => {
      const { privkey, pubkey } = generateAgentKeypair();
      expect(privkey).toMatch(/^[0-9a-f]{64}$/);
      expect(pubkey).toMatch(/^0[23][0-9a-f]{64}$/);
    });

    it("produces a different keypair every call", () => {
      const a = generateAgentKeypair();
      const b = generateAgentKeypair();
      expect(a.privkey).not.toBe(b.privkey);
      expect(a.pubkey).not.toBe(b.pubkey);
    });

    it("the generated pubkey matches what derivePubkeyFromPrivkey computes", () => {
      const { privkey, pubkey } = generateAgentKeypair();
      expect(derivePubkeyFromPrivkey(privkey)).toBe(pubkey);
    });
  });

  describe("derivePubkeyFromPrivkey", () => {

    it("derives a known test-vector pubkey", () => {
      // Test vector: privkey = 1, pubkey = secp256k1 generator G (compressed).
      const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
      const one = "0".repeat(63) + "1";
      expect(derivePubkeyFromPrivkey(one)).toBe(G);
    });

      });

  it("rejects malformed hex and out-of-range scalars", () => {
    for (const invalid of ["deadbeef", "zz".repeat(32), "0".repeat(64)]) {
      expect(() => derivePubkeyFromPrivkey(invalid)).toThrow(DvmError);
      expect(() => derivePubkeyFromPrivkey(invalid)).toThrow(expect.objectContaining({ code: "invalid_privkey" }));
    }
  });

  describe("PRIVKEY_HEX_RE", () => {
    it("accepts valid 64-char hex (case-insensitive)", () => {
      expect(PRIVKEY_HEX_RE.test("ab".repeat(32))).toBe(true);
      expect(PRIVKEY_HEX_RE.test("AB".repeat(32))).toBe(true);
    });

    it("rejects wrong-length or non-hex strings", () => {
      expect(PRIVKEY_HEX_RE.test("ab".repeat(31))).toBe(false);
      expect(PRIVKEY_HEX_RE.test("ab".repeat(33))).toBe(false);
      expect(PRIVKEY_HEX_RE.test("zz".repeat(32))).toBe(false);
      expect(PRIVKEY_HEX_RE.test("")).toBe(false);
    });
  });
});
