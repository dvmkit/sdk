import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";

import {
  buildAttestation,
  generateIdentity,
  signAttestation,
  verifyAttestation,
} from "../builder-identity";
import type { JsonValue } from "../cast-auth";
import { canonicaliseForSigning } from "../cast-auth";
import type { UnsignedJobReceipt } from "../receipt";
import { computeResultHash, isSignedJobReceipt, signReceipt, verifyReceipt } from "../receipt";
import {
  deriveReceiptKeypair,
  deriveReceiptSecret,
  generateEphemeralReceiptKey,
} from "../receipt-key";
import { BUILDER_SECRET, unsignedReceipt } from "./fixtures/receipt-fixture";

describe("receipt key derivation", () => {
  it("is deterministic per (builder secret, DVM ID)", () => {
    expect(deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount")).toBe(
      deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount")
    );
  });

  it("gives every DVM its own key — one compromised receipt key says nothing about siblings", () => {
    const a = deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount");
    const b = deriveReceiptSecret(BUILDER_SECRET, "dvm-scribe");
    expect(a).not.toBe(b);
  });

  it("gives every builder their own key for the same DVM ID", () => {
    const other = "22".repeat(32);
    expect(deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount")).not.toBe(
      deriveReceiptSecret(other, "dvm-wordcount")
    );
  });

  it("does not return the builder secret or a DVM-independent XOR of it", () => {
    const derived = deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount");
    expect(derived).not.toBe(BUILDER_SECRET);
    const derivedBytes = hexToBytes(derived);
    const builderBytes = hexToBytes(BUILDER_SECRET);
    const xored = bytesToHex(derivedBytes.map((b, i) => b ^ builderBytes[i]));
    const otherDerived = hexToBytes(deriveReceiptSecret(BUILDER_SECRET, "dvm-scribe"));
    const otherXored = bytesToHex(otherDerived.map((b, i) => b ^ builderBytes[i]));
    expect(xored).not.toBe(otherXored);
  });

  it("produces a usable BIP-340 keypair", () => {
    const { secret, pubkey } = deriveReceiptKeypair(BUILDER_SECRET, "dvm-wordcount");
    expect(pubkey).toMatch(/^[0-9a-f]{64}$/);
    const sig = schnorr.sign(new TextEncoder().encode("hello"), hexToBytes(secret));
    expect(schnorr.verify(sig, new TextEncoder().encode("hello"), hexToBytes(pubkey))).toBe(true);
  });

  it("mints distinct ephemeral keys for dev boots", () => {
    expect(generateEphemeralReceiptKey().secret).not.toBe(generateEphemeralReceiptKey().secret);
  });
});

describe("receipt signing", () => {
  const secret = deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount");

  it("round-trips sign → verify", () => {
    expect(verifyReceipt(signReceipt(unsignedReceipt(), secret))).toBe(true);
  });

  it("rejects a receipt whose payload was edited after signing", () => {
    const receipt = signReceipt(unsignedReceipt(), secret);
    expect(verifyReceipt({ ...receipt, paid: { ...receipt.paid, msats: 1 } })).toBe(false);
    expect(verifyReceipt({ ...receipt, outcome: "failed" })).toBe(false);
    expect(verifyReceipt({ ...receipt, seq: receipt.seq + 1 })).toBe(false);
  });

  it("rejects a receipt re-labelled with someone else's pubkey", () => {
    const receipt = signReceipt(unsignedReceipt(), secret);
    const impostor = deriveReceiptKeypair(BUILDER_SECRET, "dvm-scribe").pubkey;
    expect(verifyReceipt({ ...receipt, receipt_pubkey: impostor })).toBe(false);
  });

  it("returns false rather than throwing on malformed input", () => {
    const receipt = signReceipt(unsignedReceipt(), secret);
    expect(verifyReceipt({ ...receipt, signature: "not-hex" })).toBe(false);
    expect(verifyReceipt({ ...receipt, receipt_pubkey: "" })).toBe(false);
  });

  it("signs the same canonical bytes the caller-auth envelope convention uses", () => {
    const unsigned = unsignedReceipt();
    const receipt = signReceipt(unsigned, secret);
    const bytes = canonicaliseForSigning({ ...unsigned } as unknown as JsonValue);
    expect(
      schnorr.verify(hexToBytes(receipt.signature), bytes, hexToBytes(receipt.receipt_pubkey))
    ).toBe(true);
  });

  it("is key-order independent — the same fields cover the same bytes", () => {
    const reordered = Object.fromEntries(
      Object.entries(unsignedReceipt()).reverse()
    ) as unknown as UnsignedJobReceipt;
    expect(canonicaliseForSigning({ ...reordered } as unknown as JsonValue)).toEqual(
      canonicaliseForSigning({ ...unsignedReceipt() } as unknown as JsonValue)
    );
    expect(verifyReceipt(signReceipt(reordered, secret))).toBe(true);
  });

  it("signs afresh each call — which is why the store, not the signer, is the idempotency seam", () => {
    const a = signReceipt(unsignedReceipt(), secret);
    const b = signReceipt(unsignedReceipt(), secret);
    expect(a.signature).not.toBe(b.signature);
    expect(verifyReceipt(a) && verifyReceipt(b)).toBe(true);
  });
});

describe("receipt shape guard", () => {
  const receipt = signReceipt(
    unsignedReceipt(),
    deriveReceiptSecret(BUILDER_SECRET, "dvm-wordcount")
  );

  it("accepts a receipt off the wire", () => {
    expect(isSignedJobReceipt(receipt)).toBe(true);
  });

  it("still accepts a receipt whose signature doesn't hold", () => {
    // The load-bearing distinction: this guard says "is a receipt", never "is
    // sound". A tampered-but-well-formed receipt has to reach the verifier so
    // the caller is told it is `invalid` — dropping it here would silently
    // downgrade forgery to "no receipt issued".
    const tampered = { ...receipt, seq: receipt.seq + 1 };
    expect(verifyReceipt(tampered)).toBe(false);
    expect(isSignedJobReceipt(tampered)).toBe(true);
  });

  it("refuses a body missing a field its consumers dereference", () => {
    for (const field of [
      "v",
      "job_id",
      "dvm_id",
      "dvm",
      "capability",
      "outcome",
      "seq",
      "issued_at",
      "receipt_pubkey",
      "signature",
      "paid",
    ] as const) {
      const { [field]: _dropped, ...rest } = receipt;
      expect(isSignedJobReceipt(rest)).toBe(false);
    }
    expect(isSignedJobReceipt({ ...receipt, paid: { rail: "cashu" } })).toBe(false);
    expect(isSignedJobReceipt({ ...receipt, outcome: "pending" })).toBe(false);
    expect(isSignedJobReceipt({ ...receipt, v: 2 })).toBe(false);
  });

  it("refuses anything that isn't an object", () => {
    for (const bad of [undefined, null, "receipt", 1, [], [receipt]]) {
      expect(isSignedJobReceipt(bad)).toBe(false);
    }
  });
});

describe("result hash", () => {
  it("binds the summary", () => {
    expect(computeResultHash("six words here", [])).not.toBe(computeResultHash("other", []));
  });

  it("binds artifact content, in emission order", () => {
    const a = { name: "a.txt", data: "alpha" };
    const b = { name: "b.txt", data: "beta" };
    expect(computeResultHash("s", [a, b])).not.toBe(computeResultHash("s", [b, a]));
  });

  it("distinguishes no-artifacts from an empty artifact", () => {
    expect(computeResultHash("s", [])).not.toBe(computeResultHash("s", [{}]));
  });

  it("recomputes from the delivered payload alone", () => {
    const artifacts = [{ name: "out.json", mime_type: "application/json", data: '{"n":6}' }];
    expect(computeResultHash("6 words", artifacts)).toBe(
      computeResultHash("6 words", structuredClone(artifacts))
    );
  });
});

describe("attestation chain", () => {
  it("binds the receipt pubkey under the builder identity key", () => {
    const identity = generateIdentity();
    const receipt = deriveReceiptKeypair(identity.secret, "dvm-test");
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "wordcount",
      capabilities: ["count"],
      builderPubkey: identity.pubkey,
      receiptPubkey: receipt.pubkey,
      deployedAt: 1789300000,
    });
    expect(payload.receipt_pubkey).toBe(receipt.pubkey);

    const signature = signAttestation(payload, identity.secret);
    expect(verifyAttestation(payload, signature, identity.pubkey)).toBe(true);
    expect(
      verifyAttestation(
        { ...payload, receipt_pubkey: deriveReceiptKeypair(identity.secret, "dvm-scribe").pubkey },
        signature,
        identity.pubkey
      )
    ).toBe(false);
  });

  it("leaves pre-receipt attestations verifying unchanged", () => {
    // Canonical JSON omits absent keys, so widening the payload type must not
    // change the bytes an already-signed attestation covers.
    const identity = generateIdentity();
    const payload = buildAttestation({
      dvmId: "dvm-test",
      slug: "wordcount",
      capabilities: ["count"],
      builderPubkey: identity.pubkey,
      deployedAt: 1789300000,
    });
    expect(payload.receipt_pubkey).toBeUndefined();
    expect(
      verifyAttestation(payload, signAttestation(payload, identity.secret), identity.pubkey)
    ).toBe(true);
  });
});
