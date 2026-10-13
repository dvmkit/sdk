import { describe, expect, it } from "vitest";

import { type JsonValue, verifyCanonicalSignedRequest } from "../cast-auth";
import { generateIdentity } from "../cli-identity-store";
import { signRequestData, unsignRequestData } from "../cli-sign-request";

describe("signRequestData", () => {
  it("produces an envelope a fresh verifier accepts", () => {
    const { privkey, pubkey } = generateIdentity();
    const body = { feed_slug: "show", episode: { title: "ep1" } };

    const signed = signRequestData(privkey, body, { timestamp: 1700000000, nonce: "fixed" });

    expect(signed.pubkey).toBe(pubkey);
    expect(signed.timestamp).toBe(1700000000);
    expect(signed.nonce).toBe("fixed");
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(signed.feed_slug).toBe("show");
    expect(signed.episode).toEqual({ title: "ep1" });

    const { signature, ...payload } = signed;
    expect(verifyCanonicalSignedRequest(payload as unknown as JsonValue, signature, pubkey)).toBe(
      true
    );
  });

  it("rejects a tampered payload", () => {
    const { privkey, pubkey } = generateIdentity();
    const signed = signRequestData(privkey, { x: 1 }, { timestamp: 1, nonce: "n" });
    const { signature, ...payload } = signed;
    const tampered = { ...payload, x: 2 };
    expect(verifyCanonicalSignedRequest(tampered as unknown as JsonValue, signature, pubkey)).toBe(
      false
    );
  });

  it("defaults timestamp + nonce", () => {
    const { privkey } = generateIdentity();
    const a = signRequestData(privkey, { k: "v" });
    const b = signRequestData(privkey, { k: "v" });
    expect(a.timestamp).toBeGreaterThan(0);
    // Random nonce — should differ.
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe("unsignRequestData", () => {
  it("recovers the body and the signer pubkey from a signed envelope", () => {
    const { privkey, pubkey } = generateIdentity();
    const body = { feed_slug: "show", episode: { title: "ep1" } };

    const recovered = unsignRequestData(signRequestData(privkey, body));

    expect(recovered).toEqual({ body, pubkey });
  });

  it("returns null for a body that isn't a signed envelope", () => {
    expect(unsignRequestData({ feed_slug: "show" })).toBeNull();
    expect(unsignRequestData(undefined)).toBeNull();
    // Envelope-shaped but incomplete — a caller's own `--data` can look like this.
    expect(unsignRequestData({ pubkey: "ab", timestamp: 1, nonce: "n" })).toBeNull();
  });
});
