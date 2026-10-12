import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { verifyChallenge } from "../../wallet-agent/sign";
import { buildAdminAuthHeader, buildAdminChallenge } from "../admin-auth";

const PRIVKEY = "11".repeat(32);
const PUBKEY = Buffer.from(schnorr.getPublicKey(hexToBytes(PRIVKEY))).toString("hex");

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

describe("buildAdminChallenge", () => {
  it("rejects spoof: changing method changes the digest", () => {
    const get = buildAdminChallenge({
      method: "GET",
      path: "/x",
      dvmId: "dvm",
      nonceHex: "ab".repeat(16),
      unixSeconds: 1,
    });
    const post = buildAdminChallenge({
      method: "POST",
      path: "/x",
      dvmId: "dvm",
      nonceHex: "ab".repeat(16),
      unixSeconds: 1,
    });
    expect(Buffer.from(get).toString("hex")).not.toBe(Buffer.from(post).toString("hex"));
  });

  it("rejects spoof: changing dvmId changes the digest", () => {
    const a = buildAdminChallenge({
      method: "GET",
      path: "/x",
      dvmId: "dvm-a",
      nonceHex: "ab".repeat(16),
      unixSeconds: 1,
    });
    const b = buildAdminChallenge({
      method: "GET",
      path: "/x",
      dvmId: "dvm-b",
      nonceHex: "ab".repeat(16),
      unixSeconds: 1,
    });
    expect(Buffer.from(a).toString("hex")).not.toBe(Buffer.from(b).toString("hex"));
  });
});

describe("buildAdminAuthHeader", () => {
  it("produces a P2PK header verifiable by the matching pubkey", () => {
    const { header, nonceHex, unixSeconds } = buildAdminAuthHeader({
      method: "GET",
      path: "/admin/cashu/pending-batches",
      dvmId: "dvm-x",
      privkeyHex: PRIVKEY,
      now: () => 1_700_000_000_000,
      randomNonce: () => hexToBytes("ab".repeat(16)),
    });
    expect(header.startsWith("P2PK ")).toBe(true);
    expect(nonceHex).toBe("ab".repeat(16));
    expect(unixSeconds).toBe(1_700_000_000);

    const parts = header.slice(5).split(".");
    expect(parts).toHaveLength(3);
    const [n, ts, sig] = parts;
    const digest = buildAdminChallenge({
      method: "GET",
      path: "/admin/cashu/pending-batches",
      dvmId: "dvm-x",
      nonceHex: n,
      unixSeconds: ts,
    });
    expect(digest).toHaveLength(32);
    expect(verifyChallenge(PUBKEY, digest, sig)).toBe(true);
  });

  it("uses a fresh nonce + timestamp on each call when seams aren't supplied", () => {
    const a = buildAdminAuthHeader({
      method: "GET",
      path: "/x",
      dvmId: "d",
      privkeyHex: PRIVKEY,
    });
    const b = buildAdminAuthHeader({
      method: "GET",
      path: "/x",
      dvmId: "d",
      privkeyHex: PRIVKEY,
    });
    expect(a.nonceHex).not.toBe(b.nonceHex);
  });
});
