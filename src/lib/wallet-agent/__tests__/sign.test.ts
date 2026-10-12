import { describe, expect, it } from "vitest";

import { generateAgentKeypair } from "../keypair";
import { signChallenge, verifyChallenge } from "../sign";

describe("signChallenge / verifyChallenge", () => {
  it("round-trips: a signed 32-byte challenge verifies under the matching pubkey", () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const challenge = new Uint8Array(32).fill(0xab);
    const sig = signChallenge(privkey, challenge);
    expect(sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyChallenge(pubkey, challenge, sig)).toBe(true);
  });

  it("verify accepts an x-only (32-byte) pubkey too", () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const xonly = pubkey.slice(2);
    const challenge = new Uint8Array(32).fill(0x42);
    const sig = signChallenge(privkey, challenge);
    expect(verifyChallenge(xonly, challenge, sig)).toBe(true);
  });

  it("verify rejects a signature under a different keypair", () => {
    const a = generateAgentKeypair();
    const b = generateAgentKeypair();
    const challenge = new Uint8Array(32).fill(0x11);
    const sig = signChallenge(a.privkey, challenge);
    expect(verifyChallenge(b.pubkey, challenge, sig)).toBe(false);
  });

  it("verify rejects when the challenge differs", () => {
    const { privkey, pubkey } = generateAgentKeypair();
    const challenge = new Uint8Array(32).fill(0x33);
    const sig = signChallenge(privkey, challenge);
    const tampered = new Uint8Array(32).fill(0x44);
    expect(verifyChallenge(pubkey, tampered, sig)).toBe(false);
  });

  it("rejects an invalid privkey hex shape", () => {
    expect(() => signChallenge("not-hex", new Uint8Array(32))).toThrow(/Privkey must be 64 hex/);
  });

  it("rejects a non-32-byte challenge", () => {
    const { privkey } = generateAgentKeypair();
    expect(() => signChallenge(privkey, new Uint8Array(31))).toThrow(/exactly 32 bytes/);
  });

  it("verify returns false on malformed inputs (does not throw)", () => {
    expect(verifyChallenge("zz", new Uint8Array(32), "0".repeat(128))).toBe(false);
    expect(verifyChallenge("02" + "ab".repeat(32), new Uint8Array(32), "not-hex")).toBe(false);
    expect(verifyChallenge("02" + "ab".repeat(32), new Uint8Array(31), "00".repeat(64))).toBe(
      false
    );
  });
});
