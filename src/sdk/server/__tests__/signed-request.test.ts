import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type SignedRequestDomain,
  signedRequestStatementHeader,
} from "../../../lib/signed-request-statement";
import {
  createDefaultReplayStore,
  createSignedRequestVerifier as createVerifier,
  SignedRequestError,
} from "../signed-request";

// Sample request: a generic write operation gated by a secp256k1+BIP-340
// Schnorr signature over the canonical JSON form of the body (envelope
// fields + payload).
const sampleSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
  target: z.string()
});

// Stable secp256k1 private key for deterministic tests. 0x01..0x20 is a valid
// scalar (< n) — the BIP-340 signer accepts it as-is.
const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
  0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
]);

const FIXED_TIMESTAMP = 1_700_000_000;
const TEST_DOMAIN: SignedRequestDomain = {
  audience: { dvm_id: "dvm-a", builder_pubkey: "ab".repeat(32) },
  method: "POST",
  path: "/v1/job",
  capability: "publish"
};
const createSignedRequestVerifier: typeof createVerifier = (schema, opts = {}) =>
  createVerifier(schema, { domain: TEST_DOMAIN, ...opts });

const publicFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../../protocol-fixtures/signed-request-v2.json", import.meta.url)),
    "utf8"
  )
) as {
  domain: SignedRequestDomain;
  payload: { text: string };
  signing: { timestamp: number; nonce: string };
  expected: Record<string, unknown>;
  canonical_utf8: string;
};

describe("createSignedRequestVerifier", () => {
  it("matches the portable v2 signing fixture", () => {
    const schema = z.object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number().int(),
      nonce: z.string(),
      text: z.string()
    });
    const verifier = createVerifier(schema, {
      domain: publicFixture.domain,
      now: () => publicFixture.signing.timestamp,
      replayStore: null
    });
    const signed = verifier.signRequest(PRIVKEY, publicFixture.payload, publicFixture.signing);

    const { signature: _generatedSignature, ...generatedEnvelope } = signed;
    const { signature: _fixtureSignature, ...fixtureEnvelope } = publicFixture.expected;
    expect(generatedEnvelope).toEqual(fixtureEnvelope);
    expect(signed.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(new TextDecoder().decode(verifier.canonicalBytes(signed))).toBe(publicFixture.canonical_utf8);
    expect(verifier.checkAuth(signed)).toEqual(signed);
    expect(verifier.checkAuth(publicFixture.expected)).toEqual(publicFixture.expected);
  });

  it("derives canonical bytes deterministically from any input shape", () => {
    const v = createSignedRequestVerifier(sampleSchema, {
      now: () => FIXED_TIMESTAMP
    });
    const bytesA = v.canonicalBytes({
      auth_statement: signedRequestStatementHeader(TEST_DOMAIN),
      pubkey: "a".repeat(64),
      timestamp: FIXED_TIMESTAMP,
      nonce: "n",
      action: "x",
      target: "y"
    });
    const bytesB = v.canonicalBytes({
      auth_statement: signedRequestStatementHeader(TEST_DOMAIN),
      target: "y",
      pubkey: "a".repeat(64),
      action: "x",
      timestamp: FIXED_TIMESTAMP,
      nonce: "n"
    });
    expect(Buffer.from(bytesA).equals(Buffer.from(bytesB))).toBe(true);
  });

  it("rejects a tampered signature with sub_reason signature_invalid", () => {
    const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
    const signed = v.signRequest(
      PRIVKEY,
      { action: "publish", target: "post:42" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-abc" }
    );

    const tampered = { ...signed, target: "post:99" };
    try {
      v.checkAuth(tampered);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestError);
      expect((err as SignedRequestError).sub_reason).toBe("signature_invalid");
    }
  });

  it.each([
    ["DVM id", { audience: { ...TEST_DOMAIN.audience, dvm_id: "dvm-b" } }],
    ["builder pubkey", { audience: { ...TEST_DOMAIN.audience, builder_pubkey: "cd".repeat(32) } }],
    ["method", { method: "PUT" }],
    ["path", { path: "/v1/request-result/request-1" }],
    ["capability", { capability: "delete" }],
  ])("rejects a proof replayed under a different %s", (_label, override) => {
    const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
    const signed = v.signRequest(
      PRIVKEY,
      { action: "publish", target: "post:42" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-domain" }
    );
    expect(() =>
      v.checkAuth(signed, {
        ...TEST_DOMAIN,
        ...override,
      })
    ).toThrowError(expect.objectContaining({ sub_reason: "signature_invalid" }));
  });

  it("rejects the retired payload-only envelope", () => {
    const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
    const signed = v.signRequest(PRIVKEY, { action: "publish", target: "post:42" });
    const { auth_statement: _statement, ...legacyShape } = signed;
    expect(() => v.checkAuth(legacyShape)).toThrowError(
      expect.objectContaining({ sub_reason: "schema_invalid" })
    );
  });

  it("rejects a timestamp outside the drift window with sub_reason timestamp_drift", () => {
    const v = createSignedRequestVerifier(sampleSchema, {
      now: () => FIXED_TIMESTAMP + 600, // 10 minutes past
      driftSeconds: 300
    });
    const signed = v.signRequest(
      PRIVKEY,
      { action: "publish", target: "post:42" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-abc" }
    );

    try {
      v.checkAuth(signed);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestError);
      expect((err as SignedRequestError).sub_reason).toBe("timestamp_drift");
    }
  });

  it("rejects an input that doesn't satisfy the schema with sub_reason schema_invalid", () => {
    const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
    try {
      v.checkAuth({ pubkey: "nothex", signature: "x", timestamp: 0, nonce: "" });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestError);
      expect((err as SignedRequestError).sub_reason).toBe("schema_invalid");
    }
  });

  describe("schemaIgnoreFields", () => {
    const strictSchema = sampleSchema.strict();
    const withCredit = { action: "publish", target: "post:42", credit_id: "c1", draw_id: "d1" };

    it("lets a strict schema verify a body carrying protocol-reserved keys", () => {
      const v = createSignedRequestVerifier(strictSchema, {
        now: () => FIXED_TIMESTAMP,
        schemaIgnoreFields: ["credit_id", "draw_id", "fund"]
      });
      const signed = v.signRequest(PRIVKEY, withCredit, {
        timestamp: FIXED_TIMESTAMP,
        nonce: "nonce-ignore"
      });
      expect(() => v.checkAuth(signed)).not.toThrow();
      expect(() => v.verifySignature(signed)).not.toThrow();
    });

    it("without the option the same body fails as schema_invalid", () => {
      // The pre-fix behaviour, reported to the caller as a bad signature.
      const v = createSignedRequestVerifier(strictSchema, {
        now: () => FIXED_TIMESTAMP
      });
      const signed = v.signRequest(PRIVKEY, withCredit, {
        timestamp: FIXED_TIMESTAMP,
        nonce: "nonce-noignore"
      });
      try {
        v.checkAuth(signed);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SignedRequestError);
        expect((err as SignedRequestError).sub_reason).toBe("schema_invalid");
      }
    });

    it("does not change the canonical bytes — the ignored keys are still signed", () => {
      const plain = createSignedRequestVerifier(sampleSchema, {
        now: () => FIXED_TIMESTAMP
      });
      const ignoring = createSignedRequestVerifier(sampleSchema, {
        now: () => FIXED_TIMESTAMP,
        schemaIgnoreFields: ["credit_id", "draw_id", "fund"]
      });
      const signed = plain.signRequest(PRIVKEY, withCredit, {
        timestamp: FIXED_TIMESTAMP,
        nonce: "nonce-bytes"
      });
      expect(ignoring.canonicalBytes(signed)).toEqual(plain.canonicalBytes(signed));
      expect(() => ignoring.checkAuth(signed)).not.toThrow();
      // Tampering with an ignored key still breaks the signature: it is
      // unvalidated, not unsigned.
      expect(() => ignoring.checkAuth({ ...signed, credit_id: "c2" })).toThrow(SignedRequestError);
    });

    it("still rejects an unknown key that isn't listed", () => {
      const v = createSignedRequestVerifier(strictSchema, {
        now: () => FIXED_TIMESTAMP,
        schemaIgnoreFields: ["credit_id", "draw_id", "fund"]
      });
      const signed = v.signRequest(
        PRIVKEY,
        { ...withCredit, targett: "typo" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-typo" }
      );
      try {
        v.checkAuth(signed);
        throw new Error("expected throw");
      } catch (err) {
        expect((err as SignedRequestError).sub_reason).toBe("schema_invalid");
      }
    });
  });

  it("recordReplay commits the nonce; second recordReplay rejects with replay_detected", async () => {
    const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
    const signed = v.signRequest(
      PRIVKEY,
      { action: "publish", target: "post:42" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-replayed" }
    );

    // checkAuth never burns the nonce — call it before and between
    // recordReplay calls to confirm the split.
    expect(() => v.checkAuth(signed)).not.toThrow();
    await expect(v.recordReplay(signed)).resolves.toBeUndefined();
    expect(() => v.checkAuth(signed)).not.toThrow();
    try {
      await v.recordReplay(signed);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SignedRequestError);
      expect((err as SignedRequestError).sub_reason).toBe("replay_detected");
    }
  });

  it("recordReplay is a no-op when the verifier is built with replayStore: null", async () => {
    const v = createSignedRequestVerifier(sampleSchema, {
      now: () => FIXED_TIMESTAMP,
      replayStore: null
    });
    const signed = v.signRequest(
      PRIVKEY,
      { action: "publish", target: "post:42" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-disabled" }
    );
    await expect(v.recordReplay(signed)).resolves.toBeUndefined();
    await expect(v.recordReplay(signed)).resolves.toBeUndefined();
  });

  it("createDefaultReplayStore rejects fresh inserts at cap to avoid silent window widening", async () => {
    // The in-memory cap is 100k. Pre-hitting the cap silently evicted
    // the oldest in-window entry and accepted the new one — letting an attacker
    // who can drive cap pressure flush a target nonce back to "unseen" and
    // replay it. The fix: at cap, reject (return true) so the wire layer 401s,
    // and log a structured warning so operators see saturation.
    const store = createDefaultReplayStore();
    const t = FIXED_TIMESTAMP;
    const pubkey = "a".repeat(64);

    // Fill to cap. Each entry has a unique nonce; same pubkey + timestamp.
    for (let i = 0; i < 100_000; i++) {
      const replay = await store.checkAndRecord(pubkey, t, `nonce-${i}`, t);
      if (replay) throw new Error(`unexpected replay at i=${i}`);
    }

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 100,001st fresh insert: rejected, with structured warning.
      const result = await store.checkAndRecord(pubkey, t, "nonce-overflow", t);
      expect(result).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(warn.mock.calls[0]?.[0] as string);
      expect(payload.event).toBe("signed_request_replay_store_saturated");
      expect(payload.cap).toBeUndefined();

      // The original 100k entries are still committed — replaying any of them
      // is still detected as a replay (the cap-rejection didn't evict).
      const replay = await store.checkAndRecord(pubkey, t, "nonce-0", t);
      expect(replay).toBe(true);

      // Within the rate-limit window, repeated saturation hits don't re-log.
      await store.checkAndRecord(pubkey, t, "nonce-overflow-2", t);
      expect(warn).toHaveBeenCalledTimes(1);

      // Once the window elapses, the next saturation event re-logs.
      await store.checkAndRecord(pubkey, t, "nonce-overflow-3", t + 61);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  describe("verifySignature (— reactivation re-check, no drift, no replay)", () => {
    it("round-trips a fresh envelope and returns the same payload checkAuth would", () => {
      const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
      const signed = v.signRequest(
        PRIVKEY,
        { action: "publish", target: "post:42" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-rv-rt" }
      );
      const verified = v.verifySignature(signed);
      expect(verified.pubkey).toBe(signed.pubkey);
      expect(verified.signature).toBe(signed.signature);
      expect(verified.action).toBe("publish");
    });

    it("rejects a tampered payload with sub_reason signature_invalid", () => {
      const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
      const signed = v.signRequest(
        PRIVKEY,
        { action: "publish", target: "post:42" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-rv-tamper" }
      );
      const tampered = { ...signed, target: "post:99" };
      try {
        v.verifySignature(tampered);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SignedRequestError);
        expect((err as SignedRequestError).sub_reason).toBe("signature_invalid");
      }
    });

    it("rejects a swapped pubkey (DB tamper scenario) with sub_reason signature_invalid", () => {
      // The DB-tamper threat the reverify is designed to catch: an attacker
      // overwrites the persisted envelope's pubkey to forge `ctx.auth.pubkey`,
      // keeping the original signature so a payload-only diff isn't required.
      // The signature was over the original pubkey, so verification fails.
      const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
      const signed = v.signRequest(
        PRIVKEY,
        { action: "publish", target: "post:42" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-rv-pk" }
      );
      const attackerPubkey = "f".repeat(64);
      const tampered = { ...signed, pubkey: attackerPubkey };
      try {
        v.verifySignature(tampered);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(SignedRequestError);
        expect((err as SignedRequestError).sub_reason).toBe("signature_invalid");
      }
    });

    it("ignores drift — verifies an envelope signed days ago without timestamp_drift", () => {
      // The reactivation path's whole point: persisted timestamp is from the
      // original signing instant. checkAuth would 401 timestamp_drift here.
      const signer = createSignedRequestVerifier(sampleSchema, {
        now: () => FIXED_TIMESTAMP
      });
      const signed = signer.signRequest(
        PRIVKEY,
        { action: "publish", target: "post:42" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-rv-drift" }
      );
      // Reverifier clock is 3 days past the signing instant.
      const reverifier = createSignedRequestVerifier(sampleSchema, {
        now: () => FIXED_TIMESTAMP + 3 * 86_400
      });
      expect(() => reverifier.verifySignature(signed)).not.toThrow();
      // checkAuth on the same input still rejects — drift IS checked there.
      expect(() => reverifier.checkAuth(signed)).toThrow(SignedRequestError);
    });

    it("does not touch the replay store — re-verifying the same envelope N times never rejects as replay", async () => {
      // recordReplay is the only path that burns nonces. verifySignature
      // must not double-commit on reactivation (the nonce was committed at
      // submission, and any throw here would mistakenly look like tampering).
      const v = createSignedRequestVerifier(sampleSchema, { now: () => FIXED_TIMESTAMP });
      const signed = v.signRequest(
        PRIVKEY,
        { action: "publish", target: "post:42" },
        { timestamp: FIXED_TIMESTAMP, nonce: "nonce-rv-replay" }
      );
      await v.recordReplay(signed); // submission-time commit
      expect(() => v.verifySignature(signed)).not.toThrow();
      expect(() => v.verifySignature(signed)).not.toThrow();
      expect(() => v.verifySignature(signed)).not.toThrow();
    });
  });

  it("strips additional envelope fields when computing canonical bytes", () => {
    // Some protocols carry a `version` envelope field that shouldn't be part
    // of the signed bytes. envelopeFields lets callers strip those too.
    const schemaWithVersion = z.object({
      pubkey: z.string().regex(/^[0-9a-f]{64}$/),
      signature: z.string().regex(/^[0-9a-f]{128}$/),
      timestamp: z.number().int(),
      nonce: z.string().min(8),
      version: z.string(),
      payload: z.string()
    });
    const v = createSignedRequestVerifier(schemaWithVersion, {
      now: () => FIXED_TIMESTAMP,
      envelopeFields: ["version"]
    });
    const signed = v.signRequest(
      PRIVKEY,
      { version: "v1", payload: "hello" },
      { timestamp: FIXED_TIMESTAMP, nonce: "nonce-vsn" }
    );
    // Changing `version` after signing should still verify — it's stripped.
    const swapped = { ...signed, version: "v2" };
    expect(() => v.checkAuth(swapped)).not.toThrow();
  });
});
