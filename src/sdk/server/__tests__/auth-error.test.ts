/**
 * the 401 tells a caller whose *input* is wrong that their input is
 * wrong, and a caller whose *signing* is wrong that their signing is wrong.
 *
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { authErrorBody, infoSchemaUrl } from "../auth-error";
import { resolvePublicOrigin } from "../caller-facing-url";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import type { SignedRequestFailure } from "../signed-request";
import { createSignedRequestVerifier, SignedRequestError } from "../signed-request";

const PRIVKEY = new Uint8Array(32).fill(7);

/** The shape of the capability that produced the live failure: `audio_url`, not `url`. */
const transcribeSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  audio_url: z.string().min(1),
  language: z.enum(["en", "fr"]).optional(),
});

/** narrate's shape: envelope fields declared but optional, so an unsigned body still parses. */
const optionalEnvelopeSchema = z.object({
  pubkey: z.string().optional(),
  signature: z.string().optional(),
  timestamp: z.number().optional(),
  nonce: z.string().optional(),
  audio_url: z.string().min(1),
});

const REGENERATE_HINT =
  "Regenerate the request with the current timestamp + a fresh nonce; sign with secp256k1+BIP-340 Schnorr over the canonical JSON form of the input.";

/** Run `checkAuth` against `input` and hand back the `SignedRequestError` it threw. */
function rejection(schema: z.ZodType, input: unknown): SignedRequestError {
  const verifier = createSignedRequestVerifier(schema, { replayStore: null });
  try {
    verifier.checkAuth(input);
  } catch (err) {
    if (err instanceof SignedRequestError) return err;
    throw err;
  }
  throw new Error("expected checkAuth to reject");
}

function signed(body: Record<string, unknown>): Record<string, unknown> {
  const verifier = createSignedRequestVerifier(transcribeSchema, { replayStore: null });
  return verifier.signRequest(PRIVKEY, body) as unknown as Record<string, unknown>;
}

describe("authErrorBody — input violations are disclosed, signing failures are not", () => {
  it("names the offending input field and steers away from re-signing", () => {
    const err = rejection(transcribeSchema, signed({ url: "https://example.com/a.mp3" }));
    const body = authErrorBody(err, { schemaUrl: "https://dvm.example/v1/info" });

    expect(body.error).toBe("auth_error");
    expect(body.sub_reason).toBe("schema_invalid");
    expect(body.display).toContain("audio_url");
    expect(body.hint).toContain("https://dvm.example/v1/info");
    // The whole point: the caller must not be sent back to the signer.
    expect(body.hint).not.toContain("Schnorr");
    expect(body.hint).toContain("not a signature one");
  });

  it("uses the configured public origin in a schema_invalid auth hint", () => {
    const err = rejection(transcribeSchema, signed({ url: "https://example.com/a.mp3" }));
    const publicOrigin = resolvePublicOrigin(
      "https://dvmkit--transcribe.example.com/deployment/path/"
    );
    const body = authErrorBody(err, {
      schemaUrl: infoSchemaUrl("http://request.example/v1/job", publicOrigin),
    });

    expect(body.error).toBe("auth_error");
    expect(body.sub_reason).toBe("schema_invalid");
    expect(body.hint).toContain("https://dvmkit--transcribe.example.com/v1/info");
    expect(body.hint).not.toContain("request.example");
  });

  it("reports a strict schema's unrecognized top-level key, which carries no path", () => {
    const strict = transcribeSchema.strict();
    const err = rejection(
      strict,
      signed({ audio_url: "https://example.com/a.mp3", langauge: "en" })
    );
    const body = authErrorBody(err);

    expect(body.sub_reason).toBe("schema_invalid");
    expect(body.display).toContain("langauge");
  });

  it("caps the reported clauses so a wholly-wrong shape doesn't become a wall of text", () => {
    const wide = z.object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number(),
      nonce: z.string(),
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
    });
    const err = rejection(wide, signed({}));
    const body = authErrorBody(err);

    expect(body.sub_reason).toBe("schema_invalid");
    expect(String(body.display).split(";")).toHaveLength(3);
    // Counted, not silently dropped — a caller who fixes three fields and gets
    // the same error back has to know there were more.
    expect(body.display).toContain("(+2 more)");
  });

  it("keeps the chunking hint for an oversized field that sorts past the clause cap", () => {
    const wide = z.object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number(),
      nonce: z.string(),
      a: z.string(),
      b: z.string(),
      c: z.string(),
      transcript: z.string().max(10),
    });
    const err = rejection(wide, signed({ transcript: "x".repeat(11) }));
    const body = authErrorBody(err);

    // `transcript` is the fourth issue, so it never reaches `display` — but it
    // is the only issue carrying an actionable remedy, so the hint must.
    expect(body.display).not.toContain("transcript");
    expect(body.hint).toContain("`transcript`");
    expect(body.hint).toMatch(/split into smaller chunks/i);
  });

  it("keeps an envelope-only schema failure inside signature_invalid, with today's copy", () => {
    // A well-formed input, sent unsigned: every failing path is an envelope
    // field, so there is nothing to disclose that isn't about the signing.
    const err = rejection(transcribeSchema, { audio_url: "https://example.com/a.mp3" });
    const body = authErrorBody(err);

    expect(err.sub_reason).toBe("schema_invalid");
    expect(body.sub_reason).toBe("signature_invalid");
    expect(body.display).toBe("Request signature didn't match the supplied pubkey");
    expect(body.hint).toBe(REGENERATE_HINT);
  });

  it("keeps a mistyped-envelope rejection carrying no issues inside signature_invalid", () => {
    // Optional envelope fields parse clean, so this lands on the post-parse
    // shape check — a `schema_invalid` with no Zod issues behind it at all.
    const err = rejection(optionalEnvelopeSchema, { audio_url: "https://example.com/a.mp3" });
    const body = authErrorBody(err);

    expect(err.sub_reason).toBe("schema_invalid");
    expect(err.issues).toBeUndefined();
    expect(body.sub_reason).toBe("signature_invalid");
    expect(body.hint).toBe(REGENERATE_HINT);
  });

  it("does not split a nested field that happens to be named like an envelope field", () => {
    const nested = z.object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number(),
      nonce: z.string(),
      payload: z.object({ signature: z.string() }),
    });
    const err = rejection(nested, signed({ payload: {} }));
    const body = authErrorBody(err);

    expect(body.sub_reason).toBe("schema_invalid");
    expect(body.display).toContain("payload.signature");
  });

  it("leaves every non-schema sub_reason byte-identical", () => {
    const cases: Record<string, string> = {
      signature_invalid: "Request signature didn't match the supplied pubkey",
      timestamp_drift: "Request timestamp is outside the 5-minute drift window",
      replay_detected: "Replay detected — same signed envelope already submitted",
    };
    for (const [subReason, display] of Object.entries(cases)) {
      const body = authErrorBody(new SignedRequestError("nope", subReason as SignedRequestFailure));
      expect(body.sub_reason).toBe(subReason);
      expect(body.display).toBe(display);
      expect(body.hint).toBe(REGENERATE_HINT);
    }
  });

  it("still yields a non-empty display for a sub_reason this build doesn't know", () => {
    const body = authErrorBody(
      new SignedRequestError("nope", "something_new" as SignedRequestFailure)
    );
    expect(body.sub_reason).toBe("something_new");
    expect(body.display).toBe("Authentication failed");
  });
});

describe("over the wire — /v1/quote is the surface that rejected the fleet", () => {
  // The bodies below moved from 401 `schema_invalid` to 400 `invalid_input`
  // when converged the two endpoints; what bought — the
  // offending field named, the hint pointing at the schema rather than at the
  // signer — rides along unchanged, which is what these still pin.
  async function startDVM() {
    const dvm = configureDVM({
      name: "auth-error-test",
      capabilities: {
        transcribe: {
          input: transcribeSchema,
          price: "$0.01",
          onJob(ctx) {
            ctx.complete("ok");
          },
        },
      },
      auth: secp256k1Auth({ replayStore: null }),
    });
    return createDVMServer(dvm, {
      devMode: true,
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
    });
  }

  type TestApp = Awaited<ReturnType<typeof startDVM>>["app"];

  async function quote(app: TestApp, data: unknown): Promise<Response> {
    return await app.request("/v1/quote", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "transcribe", data }),
    });
  }

  it("does not conflate a bad input with a bad signature", async () => {
    const { app } = await startDVM();

    // The live case: correctly signed, wrong field name.
    const badInput = await quote(app, signed({ url: "https://example.com/a.mp3" }));
    // A schema-valid body whose signature covers different bytes.
    const goodInput = signed({ audio_url: "https://example.com/a.mp3" });
    const badSignature = await quote(app, {
      ...goodInput,
      audio_url: "https://evil.example/b.mp3",
    });

    // the input half is answered by the capability-input gate above
    // the auth gate now, in the shape `/v1/job` has always used — see
    // `input-error-parity.test.ts`. The property this pins is unchanged: the
    // two mistakes get two answers, and neither carries the other's remedy.
    expect(badInput.status).toBe(400);
    expect(badSignature.status).toBe(401);
    const schemaBody = (await badInput.json()) as Record<string, string>;
    const sigBody = (await badSignature.json()) as Record<string, string>;

    expect(schemaBody.error).toBe("invalid_input");
    expect(sigBody.error).toBe("auth_error");
    expect(sigBody.sub_reason).toBe("signature_invalid");

    // Neither body carries the other's remedy.
    expect(schemaBody.display).toContain("audio_url");
    expect(schemaBody.message).toContain("audio_url");
    expect(schemaBody.hint).toContain("/v1/info");
    expect(schemaBody.hint).not.toContain("Schnorr");
    expect(sigBody.display).toBe("Request signature didn't match the supplied pubkey");
    expect(sigBody.hint).toBe(REGENERATE_HINT);
  });

  it("points the schema hint at this DVM's own /v1/info", async () => {
    const { app } = await startDVM();
    const res = await quote(app, signed({ url: "https://example.com/a.mp3" }));
    const body = (await res.json()) as Record<string, string>;
    expect(body.hint).toContain("http://localhost/v1/info");
  });

  it("accepts the corrected input, so the schema answer was the actionable one", async () => {
    const { app } = await startDVM();
    const res = await quote(app, signed({ audio_url: "https://example.com/a.mp3" }));
    expect(res.status).toBe(200);
  });
});
