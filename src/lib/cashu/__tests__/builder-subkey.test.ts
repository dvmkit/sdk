import { describe, expect, it } from "vitest";

import {
  builderLockPath,
  deriveBuilderLockKeypair,
  deriveBuilderLockPubkey,
  hashedCanonicalDvmId,
} from "../builder-subkey";

// BIP-39 reference vector. Held fixed so the golden table below is
// reproducible from any CLI / language with the same `@scure/bip32` semantics.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

describe("builder-subkey", () => {
  describe("hashedCanonicalDvmId", () => {
    it("maps different canonical_ids to different indices (overwhelmingly)", () => {
      expect(hashedCanonicalDvmId("42")).not.toBe(hashedCanonicalDvmId("43"));
    });

    it("matches the spec encoding for known canonical_ids", () => {
      // sha256("42")[0..4] = 0xf3441e74, & 0x7FFFFFFF = 0x73441e74 = 1934056628
      expect(hashedCanonicalDvmId("42")).toBe(1934056628);
      // sha256("a3d8b1c6-4f2e-4e9a-8b1d-6e0f5c2a7d10")[0..4] & 0x7FFFFFFF
      expect(hashedCanonicalDvmId("a3d8b1c6-4f2e-4e9a-8b1d-6e0f5c2a7d10")).toBe(411357454);
    });
  });

  describe("builderLockPath", () => {
    it("renders the full BIP-32 path with hardened components", () => {
      expect(builderLockPath("42", 0)).toBe("m/1789'/0'/1934056628'/0'");
      expect(builderLockPath("42", 1)).toBe("m/1789'/0'/1934056628'/1'");
    });

    it("rejects negative rotation indices", () => {
      expect(() => builderLockPath("42", -1)).toThrow(/rotation_index/);
    });

    it("rejects rotation indices beyond 31 bits", () => {
      expect(() => builderLockPath("42", 0x80000000)).toThrow(/rotation_index/);
    });

    it("rejects non-integer rotation indices", () => {
      expect(() => builderLockPath("42", 1.5)).toThrow(/rotation_index/);
    });
  });

  describe("golden vectors", () => {
    // Generated from `@scure/bip32` + `@scure/bip39`. Any change here implies
    // builders with proofs locked under prior derivations cannot melt them —
    // treat as a breaking protocol change.
    const VECTORS: readonly {
      canonicalId: string;
      rotationIndex: number;
      privkey: string;
      pubkey: string;
    }[] = [
      {
        canonicalId: "42",
        rotationIndex: 0,
        privkey: "b1fe06b25470fbc34a1c5715f7d10087c7ba41c3e1237b7e6d687d68e89990d8",
        pubkey: "02d70a66a0713139896c670ab77bd10950f415645a9498f6fdef3fc0a87ad5a5a8",
      },
      {
        canonicalId: "42",
        rotationIndex: 1,
        privkey: "c9880bf023e3fc61dc9ebe00d1ba9f2d35437621e05061bb1a6bf9dc0da19ce6",
        pubkey: "0323306a4a89cd8e2ec1e9f877e302f2a7af2b85cdcf13d50541d3d00e9b48c0b8",
      },
      {
        canonicalId: "42",
        rotationIndex: 7,
        privkey: "0ca48b1ef809fa2c042154229503ac963956334934928be02d715db33a5d5e12",
        pubkey: "03fd45eac41650e4fb0295ff29673f98891c9bae400c2ee6454132702fca2652b2",
      },
      {
        canonicalId: "a3d8b1c6-4f2e-4e9a-8b1d-6e0f5c2a7d10",
        rotationIndex: 0,
        privkey: "42ad36879451a56f32161c1cf42e85589f0b1461df4e3eb692f6b8691837e42f",
        pubkey: "035cd211fd1260b81e17ea54798cc3a183c43e8ffda907b17395583cb0a6dd41be",
      },
    ];

    for (const v of VECTORS) {
      it(`canonicalId="${v.canonicalId}" rotation_index=${v.rotationIndex}`, () => {
        const kp = deriveBuilderLockKeypair(TEST_MNEMONIC, v.canonicalId, v.rotationIndex);
        expect(kp.privkey).toBe(v.privkey);
        expect(kp.pubkey).toBe(v.pubkey);
      });
    }
  });

  describe("deriveBuilderLockKeypair", () => {
    it("produces a different pubkey when canonical_id changes — closes same-builder cross-DVM atomicity", () => {
      const a = deriveBuilderLockPubkey(TEST_MNEMONIC, "42", 0);
      const b = deriveBuilderLockPubkey(TEST_MNEMONIC, "43", 0);
      expect(a).toBe("02d70a66a0713139896c670ab77bd10950f415645a9498f6fdef3fc0a87ad5a5a8");
      expect(b).toBe(deriveBuilderLockKeypair(TEST_MNEMONIC, "43", 0).pubkey);
      expect(a).not.toBe(b);
    });

    it("produces a different pubkey when rotation_index changes — enables hot rotation without dead capital", () => {
      const a = deriveBuilderLockPubkey(TEST_MNEMONIC, "42", 0);
      const b = deriveBuilderLockPubkey(TEST_MNEMONIC, "42", 1);
      expect(a).toBe("02d70a66a0713139896c670ab77bd10950f415645a9498f6fdef3fc0a87ad5a5a8");
      expect(b).toBe("0323306a4a89cd8e2ec1e9f877e302f2a7af2b85cdcf13d50541d3d00e9b48c0b8");
      expect(a).not.toBe(b);
    });
  });
});
