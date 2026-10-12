import { describe, expect, it, vi } from "vitest";

vi.mock("fs");
vi.mock("../../defaults", () => ({
  BUILDER_CONFIG_DIR: "/mock/.dvmkit",
  BUILDER_FILE: "/mock/.dvmkit/builder.json",
  BUILDER_KEY_FILE: "/mock/.dvmkit/builder.key",
}));

import { schnorr } from "@noble/curves/secp256k1.js";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";

import {
  buildAttestation,
  generateIdentity,
  hashCapabilities,
  loadIdentitySecret,
  signAttestation,
  verifyAttestation,
  writeIdentity,
} from "../builder-identity";
import { canonicaliseForSigning } from "../cast-auth";

describe("generateIdentity", () => {

  it("derives the same pubkey schnorr.getPublicKey produces from the secret", () => {
    const { pubkey, secret } = generateIdentity();
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    const derived = schnorr.getPublicKey(hexToBytes(secret));
    expect(bytesToHex(derived)).toBe(pubkey);
  });

  it("never returns the same keypair twice in a row (sanity)", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.secret).not.toBe(b.secret);
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});

describe("hashCapabilities", () => {
  it("hashes canonical bytes to the independent SHA-256 vector", () => {
    const value = { a: 1, b: "two" };
    expect(hashCapabilities(value)).toBe("f15bfc93d70801047473922f67fed863ecc7f82f0677ebb7122923aee81e0f97");
  });

  it("is key-order-insensitive (canonicalisation reorders keys)", () => {
    expect(hashCapabilities({ a: 1, b: 2 })).toBe(hashCapabilities({ b: 2, a: 1 }));
  });

  });

describe("buildAttestation + signAttestation + verifyAttestation", () => {

  it("rejects a tampered payload", () => {
    const { pubkey, secret } = generateIdentity();
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "cast",
      capabilities: {},
      builderPubkey: pubkey,
      deployedAt: 1747512345,
    });
    const sig = signAttestation(payload, secret);
    const tampered = { ...payload, slug: "narrate" };
    expect(verifyAttestation(tampered, sig, pubkey)).toBe(false);
  });

  it("rejects a wrong-pubkey verification", () => {
    const { pubkey, secret } = generateIdentity();
    const other = generateIdentity();
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "cast",
      capabilities: {},
      builderPubkey: pubkey,
      deployedAt: 1747512345,
    });
    const sig = signAttestation(payload, secret);
    expect(verifyAttestation(payload, sig, other.pubkey)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    const { pubkey } = generateIdentity();
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "cast",
      capabilities: {},
      builderPubkey: pubkey,
      deployedAt: 1747512345,
    });
    expect(verifyAttestation(payload, "not-hex", pubkey)).toBe(false);
  });

  it("lets an independent verifier reconstruct canonical bytes and verify the signature", () => {
    // An independent consumer must be able to verify the attestation using
    // only the payload and public key advertised by `/v1/info`.
    const { pubkey, secret } = generateIdentity();
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "cast",
      capabilities: { greet: { input_schema: { type: "object" } } },
      builderPubkey: pubkey,
      deployedAt: 1747512345,
    });
    const signature = signAttestation(payload, secret);
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyAttestation(payload, signature, pubkey)).toBe(true);

    // Consumer side: takes only the JSON `/v1/info#builder` block, reproduces
    // the canonical bytes from the payload, and verifies the signature.
    const wireBlock: { pubkey: string; attestation: typeof payload; signature: string } = {
      pubkey,
      attestation: payload,
      signature,
    };
    const reproducedBytes = canonicaliseForSigning(wireBlock.attestation as never);
    const ok = schnorr.verify(
      hexToBytes(wireBlock.signature),
      reproducedBytes,
      hexToBytes(wireBlock.pubkey)
    );
    expect(ok).toBe(true);
  });
});

describe("writeIdentity + loadIdentitySecret", () => {
  it("writes the secret atomically (tmp + rename) with mode 0600", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("file absent");
    });
    const writeSpy = vi.mocked(writeFileSync);
    writeSpy.mockClear();
    const renameSpy = vi.mocked(renameSync);
    renameSpy.mockClear();
    const chmodSpy = vi.mocked(chmodSync);
    chmodSpy.mockClear();

    writeIdentity({ pubkey: "a".repeat(64), secret: "b".repeat(64) });

    expect(vi.mocked(mkdirSync)).toHaveBeenCalledWith("/mock/.dvmkit", {
      recursive: true,
      mode: 0o700,
    });
    // Atomic tmp + rename
    const tmpCall = writeSpy.mock.calls.find(
      ([path]) => typeof path === "string" && path.endsWith(".tmp")
    );
    expect(tmpCall).toBeDefined();
    expect(tmpCall?.[2]).toEqual({ mode: 0o600 });
    expect(renameSpy).toHaveBeenCalledWith(
      "/mock/.dvmkit/builder.key.tmp",
      "/mock/.dvmkit/builder.key"
    );
    // Re-chmod after rename, defensive against umask widening
    expect(chmodSpy).toHaveBeenCalledWith("/mock/.dvmkit/builder.key", 0o600);
  });

  it("refuses to overwrite when an identity already exists (no --force)", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, identity_pubkey: "old".repeat(22), dvms: {} })
    );
    expect(() => {
      writeIdentity({ pubkey: "a".repeat(64), secret: "b".repeat(64) });
    }).toThrow(/already exists/);
  });

  it("--force overwrites and surfaces no error", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, identity_pubkey: "old".repeat(22), dvms: {} })
    );
    vi.mocked(unlinkSync).mockClear();
    expect(() => {
      writeIdentity({ pubkey: "a".repeat(64), secret: "b".repeat(64) }, { force: true });
    }).not.toThrow();
  });

  it("loadIdentitySecret returns null when the file is absent", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(loadIdentitySecret()).toBeNull();
  });

  it("loadIdentitySecret returns trimmed hex when present", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("a".repeat(64) + "\n");
    expect(loadIdentitySecret()).toBe("a".repeat(64));
  });

  it("loadIdentitySecret throws on a malformed file", () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue("not-hex");
    expect(() => loadIdentitySecret()).toThrow(/not a 32-byte hex secret/);
  });
});

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
