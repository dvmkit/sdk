import { describe, expect, it } from "vitest";

import {
  agentRefundSubkeyPath,
  deriveAgentRefundSubkey,
  deriveAgentRefundSubkeyPubkey,
} from "../agent-refund-subkey";

// BIP-39 reference vector. Held fixed so the golden table below is
// reproducible from any CLI / language with the same `@scure/bip32` semantics.
// Kept in lockstep with `builder-subkey.test.ts` so an agent and a builder
// running with the same mnemonic still derive distinct subkeys via the role
// index — useful to spot any future cross-role collision.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("agent-refund-subkey", () => {
  describe("agentRefundSubkeyPath", () => {
    it("renders the full BIP-32 path with hardened components and no rotation index", () => {
      // sha256("42")[0..4] & 0x7FFFFFFF = 1934056628 (same encoding as builder-subkey)
      expect(agentRefundSubkeyPath("42")).toBe("m/1789'/2'/1934056628'");
      expect(agentRefundSubkeyPath("a3d8b1c6-4f2e-4e9a-8b1d-6e0f5c2a7d10")).toBe(
        "m/1789'/2'/411357454'"
      );
    });

  });

  describe("golden vectors", () => {
    // Generated from `@scure/bip32` + `@scure/bip39` against the TEST_MNEMONIC
    // above. Any change here implies agents holding pre-fund proofs with
    // refund tags from prior derivations cannot reclaim them post-`t_expire`
    // treat as a breaking protocol change.
    const VECTORS: readonly {
      canonicalId: string;
      privkey: string;
      pubkey: string;
    }[] = [
      {
        canonicalId: "42",
        privkey: "0ee99cc873c4781d700a7867a9321a59562c9ab2cf707092a94082683e4f84c9",
        pubkey: "02a3e7f5e3a1ef088c5c0b8d23c0ccfeaa5efd0dd6031907bcae4bdce520d5b8b5",
      },
      {
        canonicalId: "43",
        privkey: "0a10f241a54d6cfad6c43b243b872bb0eb7dd2ea2ec063602a5ef629b28847a1",
        pubkey: "03c9a4e00ed0b1227b3bc9c771e118b99a3baf3eb4ed3f90a87c180f5fed1cbcf9",
      },
      {
        canonicalId: "a3d8b1c6-4f2e-4e9a-8b1d-6e0f5c2a7d10",
        privkey: "fc923216a85282ee9374b239eba63192cce4217cca964ba68e36ea10f58131ca",
        pubkey: "0309918f16e1cd8405d297eb4c7153abde9c5bfa7576f8c12cc3508f4ef315809e",
      },
    ];

    for (const v of VECTORS) {
      it(`canonicalId="${v.canonicalId}"`, () => {
        const kp = deriveAgentRefundSubkey(TEST_MNEMONIC, v.canonicalId);
        expect(kp.privkey).toBe(v.privkey);
        expect(kp.pubkey).toBe(v.pubkey);
      });
    }
  });

  describe("deriveAgentRefundSubkey", () => {
    it("produces a different pubkey when canonical_id changes — closes cross-DVM refund-tag correlation", () => {
      const a = deriveAgentRefundSubkeyPubkey(TEST_MNEMONIC, "42");
      const b = deriveAgentRefundSubkeyPubkey(TEST_MNEMONIC, "43");
      expect(a).not.toBe(b);
    });

    it("deriveAgentRefundSubkeyPubkey returns the same pubkey as the keypair function", () => {
      const kp = deriveAgentRefundSubkey(TEST_MNEMONIC, "42");
      const pub = deriveAgentRefundSubkeyPubkey(TEST_MNEMONIC, "42");
      expect(pub).toBe(kp.pubkey);
    });
  });
});
