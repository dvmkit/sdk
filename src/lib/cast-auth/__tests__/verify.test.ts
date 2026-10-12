import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import { canonicalize, type JsonValue } from "../canonical-json";
import { verifyCanonicalSignedRequest } from "../verify";

interface Pair {
  pubkeyHex: string;
  privkey: Uint8Array;
}

function newPair(): Pair {
  const { secretKey, publicKey } = schnorr.keygen();
  return { pubkeyHex: bytesToHex(publicKey), privkey: secretKey };
}

function signCanonical(payload: JsonValue, privkey: Uint8Array): string {
  const data = new TextEncoder().encode(canonicalize(payload));
  return bytesToHex(schnorr.sign(data, privkey));
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const samplePayload: JsonValue = {
  pubkey: "00".repeat(32),
  timestamp: 1714294800,
  nonce: "abcd1234",
  feed_slug: "test",
  feed_title: "Test",
  episode: {
    title: "Ep 1",
    audio_url: "https://example.com/a.mp3",
    ttl_days: 30,
  },
};

describe("verifyCanonicalSignedRequest", () => {
  it("accepts a valid signature over the canonical payload", () => {
    const { pubkeyHex, privkey } = newPair();
    const payload = { ...samplePayload, pubkey: pubkeyHex };
    const sig = signCanonical(payload, privkey);
    expect(verifyCanonicalSignedRequest(payload, sig, pubkeyHex)).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const { pubkeyHex, privkey } = newPair();
    const payload = { ...samplePayload, pubkey: pubkeyHex };
    const sig = signCanonical(payload, privkey);
    const tampered = { ...payload, feed_slug: "different" };
    expect(verifyCanonicalSignedRequest(tampered, sig, pubkeyHex)).toBe(false);
  });

  it("rejects a signature from a different keypair", () => {
    const a = newPair();
    const b = newPair();
    const payload = { ...samplePayload, pubkey: a.pubkeyHex };
    const sig = signCanonical(payload, b.privkey);
    expect(verifyCanonicalSignedRequest(payload, sig, a.pubkeyHex)).toBe(false);
  });

  it("rejects malformed pubkey/signature hex", () => {
    const { pubkeyHex, privkey } = newPair();
    const signature = signCanonical(samplePayload, privkey);
    expect(verifyCanonicalSignedRequest(samplePayload, signature, "00")).toBe(false);
    expect(verifyCanonicalSignedRequest(samplePayload, "00", pubkeyHex)).toBe(false);
    expect(verifyCanonicalSignedRequest(samplePayload, "zz".repeat(64), pubkeyHex)).toBe(false);
  });
});
