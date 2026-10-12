import { describe, expect, it } from "vitest";

import {
  agentMasterKeypairPath,
  deriveAgentMasterKeypair,
  generateAgentMnemonic,
  looksLikeMnemonic,
  mnemonicFingerprint,
  validateAgentMnemonic,
} from "../mnemonic";

// BIP-39 reference vector. Uses `about` as the 12th word so the mnemonic also
// passes the BIP-39 checksum (validateAgentMnemonic exercises it directly).
// The agent-refund / builder-subkey test files use `art` as the 12th word —
// fine for `mnemonicToSeedSync` which skips the checksum, but not for us.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("wallet-agent mnemonic", () => {
  describe("agentMasterKeypairPath", () => {
    it("renders the BIP-32 path with role index 1 and no canonical_id component", () => {
      expect(agentMasterKeypairPath()).toBe("m/1789'/1'");
    });

  });

  describe("generateAgentMnemonic", () => {
    it("produces 12 BIP-39 words from the English wordlist", () => {
      const m = generateAgentMnemonic();
      const words = m.split(" ");
      expect(words).toHaveLength(12);
      expect(validateAgentMnemonic(m)).toEqual({ ok: true });
    });

    it("draws a different mnemonic each call (CSPRNG-backed)", () => {
      expect(generateAgentMnemonic()).not.toBe(generateAgentMnemonic());
    });
  });

  describe("deriveAgentMasterKeypair (golden vector)", () => {
    // Computed once against `@scure/bip32` + `@scure/bip39` at the
    // TEST_MNEMONIC. Any change here implies wallets initialised with this
    // mnemonic would derive a different lock_pubkey — treat as a breaking
    // protocol change.
    const EXPECTED_PRIVKEY = "29bbd02f772ac6837dfa0e27c88db445e26a387c1847f1d0b6656754ca3cb593";
    const EXPECTED_PUBKEY = "02c468e8dc475b2da905a4b60f75fab4c2284c2f9ca8c90f034df40a6c81fd16cf";

    it("matches the golden derivation at m/1789'/1'", () => {
      const kp = deriveAgentMasterKeypair(TEST_MNEMONIC);
      expect(kp.privkey).toBe(EXPECTED_PRIVKEY);
      expect(kp.pubkey).toBe(EXPECTED_PUBKEY);
    });

    it("differs from the agent refund derivation under the same mnemonic", async () => {
      // Closes the cross-role correlation check: master ≠ refund even with
      // identical mnemonic + canonical_id, because the role index differs.
      const { deriveAgentRefundSubkey } = await import("../../cashu/agent-refund-subkey");
      const master = deriveAgentMasterKeypair(TEST_MNEMONIC);
      const refund = deriveAgentRefundSubkey(TEST_MNEMONIC, "42");
      expect(master.privkey).not.toBe(refund.privkey);
      expect(master.pubkey).not.toBe(refund.pubkey);
    });
  });

  describe("validateAgentMnemonic", () => {
    it("accepts a valid 12-word mnemonic", () => {
      expect(validateAgentMnemonic(TEST_MNEMONIC)).toEqual({ ok: true });
    });

    it("normalises whitespace and case", () => {
      const noisy = `  ABANDON   abandon\tabandon\nabandon abandon abandon abandon abandon abandon abandon abandon ABOUT  `;
      expect(validateAgentMnemonic(noisy)).toEqual({ ok: true });
    });

    it("flags the first unknown word with its 1-based slot index", () => {
      // Word 6 swapped for a non-wordlist token.
      const bad =
        "abandon abandon abandon abandon abandon foobar abandon abandon abandon abandon abandon art";
      expect(validateAgentMnemonic(bad)).toEqual({
        ok: false,
        reason: "unknown_word",
        badWordIndex: 6,
        badWord: "foobar",
      });
    });

    it("reports wrong length when not 12 words", () => {
      expect(validateAgentMnemonic("abandon abandon abandon")).toEqual({
        ok: false,
        reason: "wrong_length",
        wordCount: 3,
      });
    });

    it("reports checksum failure when every word is valid but the checksum doesn't match", () => {
      // All words remain in the BIP-39 wordlist, but the resulting checksum is invalid.
      const bad =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon able";
      expect(validateAgentMnemonic(bad)).toEqual({ ok: false, reason: "checksum" });
    });
  });

  describe("mnemonicFingerprint", () => {
    // `mnemonicToEntropy` of the all-`abandon` + `about` mnemonic yields 16 zero bytes;
    // sha256 of 16 zero bytes is this well-known constant.
    const EXPECTED_FINGERPRINT = "374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb";

    it("matches the golden fingerprint at the canonical mnemonic", () => {
      expect(mnemonicFingerprint(TEST_MNEMONIC)).toBe(EXPECTED_FINGERPRINT);
    });

    it("is invariant under whitespace + case normalisation", () => {
      const noisy = `  ABANDON   abandon\tabandon\nabandon abandon abandon abandon abandon abandon abandon abandon ABOUT  `;
      expect(mnemonicFingerprint(noisy)).toBe(EXPECTED_FINGERPRINT);
    });

    it("differs when the mnemonic differs (sanity)", () => {
      const a = mnemonicFingerprint(TEST_MNEMONIC);
      const b = mnemonicFingerprint(generateAgentMnemonic());
      expect(a).not.toBe(b);
    });
  });

  describe("looksLikeMnemonic", () => {
    it("returns true for any input containing internal whitespace", () => {
      expect(looksLikeMnemonic(TEST_MNEMONIC)).toBe(true);
      expect(looksLikeMnemonic("abandon abandon")).toBe(true);
    });

    it("returns false for a 64-hex privkey (no whitespace)", () => {
      expect(looksLikeMnemonic("a".repeat(64))).toBe(false);
    });

    it("strips outer whitespace before checking", () => {
      // A user pasting a hex with surrounding spaces shouldn't be misrouted
      // into the mnemonic path.
      expect(looksLikeMnemonic("   " + "a".repeat(64) + "   ")).toBe(false);
    });
  });
});
