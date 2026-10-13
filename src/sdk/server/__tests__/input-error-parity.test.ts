/**
 * Quote and submit must classify the same schema violation identically.
 * Missing input is the exception: quote accepts a price probe, submit does not.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const PRIVKEY = new Uint8Array(32).fill(3);

const optionalEnvelopeSchema = z.object({
  pubkey: z.string().optional(),
  signature: z.string().optional(),
  timestamp: z.number().optional(),
  nonce: z.string().optional(),
  audio_url: z.string().min(1),
});

const requiredEnvelopeSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  audio_url: z.string().min(1),
});

async function startDVM(opts: { schema: z.ZodType; auth: boolean; free?: boolean }) {
  const dvm = configureDVM({
    name: "parity-test",
    capabilities: {
      transcribe: {
        input: opts.schema,
        ...(opts.free ? {} : { price: "$0.01" }),
        onJob(ctx) {
          ctx.complete("ok");
        },
      },
    },
    ...(opts.auth ? { auth: secp256k1Auth({ replayStore: null }) } : {}),
  });
  const { app } = await createDVMServer(dvm, {
    devMode: true,
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
  });
  return app;
}

type TestApp = Awaited<ReturnType<typeof startDVM>>;

function sign(schema: z.ZodType, body: Record<string, unknown>): Record<string, unknown> {
  const verifier = createSignedRequestVerifier(schema, { replayStore: null });
  return verifier.signRequest(PRIVKEY, body) as unknown as Record<string, unknown>;
}

interface Answer {
  status: number;
  body: Record<string, string>;
}

async function bothEndpoints(app: TestApp, data: unknown): Promise<[Answer, Answer]> {
  const post = async (path: string): Promise<Answer> => {
    const res = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "transcribe", data }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, string> };
  };
  return [await post("/v1/quote"), await post("/v1/job")];
}

describe("a schema-invalid input gets one answer from /v1/quote and /v1/job", () => {
  it("answers a correctly-signed, wrongly-named field identically on both", async () => {
    const app = await startDVM({ schema: optionalEnvelopeSchema, auth: true });
    const [quote, job] = await bothEndpoints(
      app,
      sign(optionalEnvelopeSchema, { url: "https://example.com/a.mp3" })
    );

    expect(quote.status).toBe(job.status);
    expect(quote.status).toBe(400);
    expect(quote.body.error).toBe(job.body.error);
    expect(quote.body.error).toBe("invalid_input");

    expect(quote.body.message).toContain("audio_url");
    expect(job.body.message).toContain("audio_url");
    expect(quote.body.message).toBe(job.body.message);
    expect(quote.body.hint).toBe(job.body.hint);

    expect(quote.body.display).toBe(job.body.display);
    expect(quote.body.display).toContain("audio_url");
  });

  it("closes the auth-less hole, where the quote used to answer 200 to a body the submit rejects", async () => {
    const app = await startDVM({ schema: optionalEnvelopeSchema, auth: false });
    const [quote, job] = await bothEndpoints(app, { url: "https://example.com/a.mp3" });

    expect(quote.status).toBe(job.status);
    expect(quote.status).toBe(400);
    expect(quote.body.error).toBe("invalid_input");
    expect(quote.body.message).toContain("audio_url");
  });

  it("leaves an unsigned request to the auth gate, on the schema shape that declares the envelope required", async () => {
    const app = await startDVM({ schema: requiredEnvelopeSchema, auth: true });
    // Valid input, no signing envelope. The input parse fails naming `pubkey` /
    // `signature`, but that is a signing failure — answering it as an input
    // problem is the mistake in reverse, so both routes defer.
    const [quote, job] = await bothEndpoints(app, { audio_url: "https://example.com/a.mp3" });

    expect(quote.status).toBe(job.status);
    expect(quote.status).toBe(401);
    expect(quote.body.error).toBe(job.body.error);
    expect(quote.body.error).toBe("auth_error");
    expect(quote.body.sub_reason).toBe("signature_invalid");
    expect(job.body.sub_reason).toBe("signature_invalid");
    expect(quote.body.display).toBe("Request signature didn't match the supplied pubkey");
    expect(job.body.display).toBe(quote.body.display);
    expect(quote.body.hint).toContain("Schnorr");
  });

  it("names the input when a body is both misshapen and unsigned — input wins on both", async () => {
    const app = await startDVM({ schema: requiredEnvelopeSchema, auth: true });
    const [quote, job] = await bothEndpoints(app, { url: "https://example.com/a.mp3" });

    expect(quote.status).toBe(job.status);
    expect(quote.status).toBe(400);
    expect(quote.body.message).toContain("audio_url");
    expect(job.body.message).toContain("audio_url");
    // The envelope half is the auth gate's answer and stays out of this one.
    expect(quote.body.message).not.toContain("pubkey");
    expect(job.body.message).not.toContain("pubkey");
  });

  it("still prices a body carrying no input at all — a quote is a price probe, a submit is not", async () => {
    const app = await startDVM({ schema: optionalEnvelopeSchema, auth: false });
    const [quote, job] = await bothEndpoints(app, undefined);

    expect(quote.status).toBe(200);
    expect(job.status).toBe(400);
    expect(job.body.error).toBe("invalid_input");
  });

  it("still accepts the corrected input on both, so the shared answer was the actionable one", async () => {
    const app = await startDVM({ schema: optionalEnvelopeSchema, auth: true, free: true });
    const [quote, job] = await bothEndpoints(
      app,
      sign(optionalEnvelopeSchema, { audio_url: "https://example.com/a.mp3" })
    );

    expect(quote.status).toBe(200);
    expect(job.status).toBe(200);
  });
});
