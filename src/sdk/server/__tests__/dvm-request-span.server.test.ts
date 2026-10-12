import { randomBytes } from "node:crypto";

import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { initLoggers } from "../../../observability/loggers";
import { SpanWriter } from "../../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { servedApps } from "../../../test-support/served-app";
import { stubbedTempoCharge } from "../../__tests__/__helpers__/mppx-stub";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import type { QuoteConfig } from "../../types";
import { createDVMServer } from "../app";
import { createDVMHost } from "../host";
import { type MppxServer, wrapMppx } from "../mpp-setup";
import type { DVMAuthScheme } from "../secp256k1-auth";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const paymentSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string()
});

const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
  0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20
]);

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-18T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

function makeMppxWithStubbedVerify(failVerify = false): MppxServer {
  const mpp = wrapMppx(
    Mppx.create({
      methods: [stubbedTempoCharge(TEMPO_RECIPIENT).method],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example"
    })
  );
  if (failVerify) {
    mpp.broadcastCredential = async () => {
      throw new Error("insufficient payment");
    };
  }
  return mpp;
}

function buildCredentialFor(challenge: Challenge.Challenge, hashByte: string): string {
  const credential = Credential.from({
    challenge,
    payload: { type: "hash" as const, hash: `0x${hashByte.repeat(64)}` }
  });
  return Credential.serialize(credential);
}

const noopTransport: SpanTransport = { send: async () => {} };

describe("dvm.request span", () => {
  const servers = servedApps();
  let server: { url: string; close: () => Promise<void> } | undefined;
  const emitted: SpanRow[] = [];

  beforeEach(() => {
    emitted.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // Ensure loggers are initialized (host.serve() only does this when
    // a platform URL is configured; tests don't have one).
    const writer = new SpanWriter(noopTransport);
    initLoggers(writer, "test");
    setEmitter((row) => emitted.push(row));
  });

  afterEach(async () => {
    setEmitter(null);
    vi.restoreAllMocks();
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  async function startHost(
    opts: {
      inputSchema?: z.ZodType;
      auth?: DVMAuthScheme;
      onJob?: (ctx: any) => void;
      onQuote?: QuoteConfig;
    } = {}
  ): Promise<string> {
    const dvm = configureDVM({
      name: "span-test",
      capability: "echo",
      tag: "test",
      input: opts.inputSchema,
      auth: opts.auth,
      onJob:
        opts.onJob ??
        ((ctx) => {
          ctx.complete("ok");
        }),
      onQuote: opts.onQuote
    });
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    server = await host.serve();
    return server.url;
  }

  function postJson(url: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  function spansByName(name: string): SpanRow[] {
    return emitted.filter((s) => s.name === name);
  }

  async function serveApp(app: { fetch: (req: Request) => Response | Promise<Response> }) {
    const url = await servers.serve(app);
    server = { url, close: () => servers.closeAll() };
    return url;
  }

  // Priced DVM on an MPP rail with stubbed verification — used by the
  // payment-span cases. Uses `createDVMServer` directly (not the `startHost`
  // host path) because `host.serve()`'s devMode skips payment unless a Cashu
  // mint is configured (`skipPayment = devMode && !mints`), so the host path
  // can't exercise `dvm.payment.validate`. The global `setEmitter` wired in
  // `beforeEach` captures spans regardless of which server path emits them.
  async function startPaymentServer(opts: { failVerify?: boolean; dvmId?: string } = {}): Promise<{
    url: string;
    signer: ReturnType<typeof createSignedRequestVerifier<z.infer<typeof paymentSchema>>>;
  }> {
    const signer = createSignedRequestVerifier(paymentSchema);
    const dvm = configureDVM({
      name: "payment-span-test",
      capabilities: {
        do: {
          input: paymentSchema,
          price: "$0.10",
          onJob(ctx) {
            ctx.complete("ok");
          }
        }
      },
      auth: secp256k1Auth()
    });
    const mpp = makeMppxWithStubbedVerify(opts.failVerify);
    const { app } = await createDVMServer(dvm, {
      env: { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") },
      store: new MemoryKVStore(),
      mpp,
      fxFetcher: stubFx,
      dvmId: opts.dvmId,
      builder: { pubkey: "ab".repeat(32) }
    });
    return { url: await serveApp(app), signer };
  }

  it("emits dvm.request span with status ok on GET /v1/info", async () => {
    const url = await startHost();
    const res = await fetch(`${url}/v1/info`);
    expect(res.status).toBe(200);

    const spans = spansByName("dvm.request");
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.dataset).toBe("isolate");
    expect(span.status).toBe("ok");
    expect(span.attributes["http.method"]).toBe("GET");
    expect(span.attributes["http.route"]).toBe("/v1/info");
    expect(span.attributes["http.status_code"]).toBe(200);
    expect(span.error_message).toBeNull();
  });

  it("does not let a diagnostic emitter failure change the request outcome", async () => {
    setEmitter(() => {
      throw new Error("diagnostic emitter unavailable");
    });
    const url = await startHost();

    const res = await fetch(`${url}/v1/info`);

    expect(res.status).toBe(200);
  });

  it("records compatibility metadata as support attributes, not identity dimensions", async () => {
    const url = await startHost();
    const res = await fetch(`${url}/v1/info`, {
      headers: {
        "DVM-Client": "dvm/0.1.0",
        "DVM-Protocol-Version": "1",
        "DVM-Client-Capabilities": "credit-recovery,request-resume"
      }
    });
    expect(res.status).toBe(200);

    const span = spansByName("dvm.request")[0];
    expect(span.attributes).toMatchObject({
      "client.version": "0.1.0",
      "client.protocol_version": 1,
      "client.version_valid": true,
      "client.protocol_version_valid": true,
      "client.capabilities_valid": true,
    });
    expect(span.attributes).not.toHaveProperty("client.capabilities");
    expect(span.dimensions).not.toHaveProperty("client.version");
    expect(span.dimensions).not.toHaveProperty("client.protocol_version");
    expect(span.dimensions).not.toHaveProperty("client.capabilities");
  });

  it("pins configured app identity without mislabelling the builder pubkey", async () => {
    const dvmId = "123e4567-e89b-12d3-a456-426614174000";
    const { url } = await startPaymentServer({ dvmId });
    const res = await fetch(`${url}/v1/info`);
    expect(res.status).toBe(200);
    expect(spansByName("dvm.request")).toEqual([
      expect.objectContaining({
        dimensions: expect.objectContaining({
          dvm_id: dvmId,
          dvm_slug: "payment-span-test"
        })
      })
    ]);
    expect(spansByName("dvm.request")[0].dimensions).not.toHaveProperty("builder_id");
  });

  it("emits dvm.request span with status ok on successful job creation", async () => {
    const url = await startHost();
    const res = await postJson(`${url}/v1/job`, {
      capability: "echo",
      input: "hi"
    });
    expect([200, 202]).toContain(res.status);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("ok");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(res.status);
    expect(requestSpans[0].dimensions.capability).toBe("echo");
  });

  it("pins the capability selected from an explicit multi-capability descriptor", async () => {
    const dvm = configureDVM({
      name: "multi-span-test",
      capabilities: {
        alpha: {
          onJob(ctx) {
            ctx.complete("alpha");
          }
        },
        beta: {
          onJob(ctx) {
            ctx.complete("beta");
          }
        }
      }
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore()
    });
    const url = await serveApp(app);

    const res = await postJson(`${url}/v1/job`, {
      capability: "beta",
      input: "hi"
    });
    expect([200, 202]).toContain(res.status);
    expect(spansByName("dvm.request")).toEqual([
      expect.objectContaining({
        dimensions: expect.objectContaining({ capability: "beta" })
      })
    ]);
  });

  it("does not share trusted capability membership across app definitions", async () => {
    const alpha = configureDVM({
      name: "alpha-span-test",
      capability: "alpha",
      onJob(ctx) {
        ctx.complete("alpha");
      },
    });
    const beta = configureDVM({
      name: "beta-span-test",
      capability: "beta",
      onJob(ctx) {
        ctx.complete("beta");
      },
    });
    const [{ app: alphaApp }, { app: betaApp }] = await Promise.all([
      createDVMServer(alpha, { env: {}, store: new MemoryKVStore() }),
      createDVMServer(beta, { env: {}, store: new MemoryKVStore() }),
    ]);

    const alphaResponse = await alphaApp.request("http://alpha.test/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "alpha", input: "hi" }),
    });
    const rejectedByBeta = await betaApp.request("http://beta.test/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "alpha", input: "hi" }),
    });

    expect([200, 202]).toContain(alphaResponse.status);
    expect(rejectedByBeta.status).toBe(400);
    expect(spansByName("dvm.request")).toEqual([
      expect.objectContaining({
        dimensions: expect.objectContaining({ capability: "alpha" }),
      }),
      expect.objectContaining({ dimensions: expect.not.objectContaining({ capability: "alpha" }) }),
    ]);
  });

  it("pins the synthesized capability of a flat single-capability descriptor", async () => {
    const dvm = configureDVM({
      name: "Synthesized Span Test",
      onJob(ctx) {
        ctx.complete("ok");
      }
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore()
    });
    const url = await serveApp(app);

    const res = await postJson(`${url}/v1/job`, {
      capability: "synthesized-span-test",
      input: "hi"
    });
    expect([200, 202]).toContain(res.status);
    expect(spansByName("dvm.request")).toEqual([
      expect.objectContaining({
        dimensions: expect.objectContaining({
          capability: "synthesized-span-test"
        })
      })
    ]);
  });

  it("emits dvm.request + dvm.input.validate error spans on invalid input", async () => {
    const url = await startHost({
      inputSchema: z.object({ url: z.url() })
    });
    const res = await postJson(`${url}/v1/job`, {
      capability: "echo",
      data: { url: 42 }
    });
    expect(res.status).toBe(400);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("error");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(400);
    expect(requestSpans[0].attributes["error.code"]).toBe("invalid_input");
    expect(requestSpans[0].error_message).toBeDefined();

    const validateSpans = spansByName("dvm.input.validate");
    expect(validateSpans).toHaveLength(1);
    expect(validateSpans[0].status).toBe("error");
    expect(validateSpans[0].attributes["error.code"]).toBe("invalid_input");
    expect(validateSpans[0].parent_span_id).toBe(requestSpans[0].span_id);
  });

  it("emits error spans on quote input validation failure", async () => {
    const url = await startHost({
      onQuote: {
        schema: z.object({ topic: z.string() }),
        handler: async () => ({
          upfront: { amount: 100, currency: "usd" as const },
          description: "test"
        })
      }
    });
    const res = await postJson(`${url}/v1/quote`, {
      capability: "echo",
      data: { topic: 123 }
    });
    expect(res.status).toBe(400);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("error");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(400);

    // the quote path runs two validations, distinguished by `stage` —
    // the capability-input gate it now shares with `/v1/job` (which this input
    // satisfies), then the quote schema (which it doesn't).
    const validateSpans = spansByName("dvm.input.validate");
    expect(validateSpans).toHaveLength(2);
    const inputSpan = validateSpans.find((s) => s.attributes.stage === "input");
    const quoteSpan = validateSpans.find((s) => s.attributes.stage === "quote");
    expect(inputSpan?.status).toBe("ok");
    expect(quoteSpan?.status).toBe("error");
    expect(quoteSpan?.attributes["error.code"]).toBe("invalid_quote_data");
  });

  it("does not emit dvm.request span for /health", async () => {
    const url = await startHost();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);

    const spans = spansByName("dvm.request");
    expect(spans).toHaveLength(0);
  });

  it("emits dvm.request span at warn level for an unknown-route 404 probe", async () => {
    const url = await startHost();
    const res = await fetch(`${url}/robots.txt`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    const span = requestSpans[0];
    // Downgraded to warn so `--level error` sweeps skip it, but still an
    // error-status span, countable via `http.probe`.
    expect(span.level).toBe("warn");
    expect(span.status).toBe("error");
    expect(span.attributes["http.status_code"]).toBe(404);
    expect(span.attributes["http.probe"]).toBe(true);
    expect(span.attributes["error.code"]).toBe("not_found");
  });

  // The case above goes through `createDVMHost`, which registers its own
  // notFound — `app.route()` drops the sub-app's. This pins the SDK app's own
  // registration (the standalone `createDVMServer` path), which the host case
  // never reaches.
  it("emits the probe span at warn on the standalone createDVMServer path", async () => {
    const dvm = configureDVM({
      name: "span-test-standalone",
      capability: "echo",
      tag: "test",
      onJob: (ctx) => {
        ctx.complete("ok");
      }
    });
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore()
    });
    const url = await serveApp(app);

    const res = await fetch(`${url}/robots.txt`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    const span = requestSpans[0];
    expect(span.level).toBe("warn");
    expect(span.status).toBe("error");
    expect(span.attributes["http.probe"]).toBe(true);
  });

  it("keeps a registered /v1/job/:id 404 at error level (not a probe)", async () => {
    const url = await startHost();
    // A credential has to be presented to reach the 404 at all — a
    // credential-less read is refused with a 401 above the lookup.
    const res = await fetch(`${url}/v1/job/does-not-exist`, {
      headers: { "X-Job-Token": "0".repeat(64) }
    });
    expect(res.status).toBe(404);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    const span = requestSpans[0];
    expect(span.level).toBe("error");
    expect(span.status).toBe("error");
    expect(span.attributes["http.status_code"]).toBe(404);
    expect(span.attributes["http.probe"]).toBeUndefined();
  });

  it("emits dvm.request error span on 500 from handler throw", async () => {
    const url = await startHost({
      onQuote: {
        schema: z.object({}),
        handler: async () => {
          throw new Error("kaboom");
        }
      }
    });
    const res = await postJson(`${url}/v1/quote`, {
      capability: "echo"
    });
    expect(res.status).toBe(500);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("error");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(500);
  });

  it("nests dvm.input.validate under dvm.request on successful job", async () => {
    const url = await startHost({
      inputSchema: z.object({ msg: z.string() })
    });
    const res = await postJson(`${url}/v1/job`, {
      capability: "echo",
      data: { msg: "hello" }
    });
    expect([200, 202]).toContain(res.status);

    const requestSpans = spansByName("dvm.request");
    const validateSpans = spansByName("dvm.input.validate");
    expect(requestSpans).toHaveLength(1);
    expect(validateSpans).toHaveLength(1);
    expect(validateSpans[0].parent_span_id).toBe(requestSpans[0].span_id);
    expect(validateSpans[0].trace_id).toBe(requestSpans[0].trace_id);
  });

  it("emits dvm.request error span on missing capability", async () => {
    const url = await startHost();
    const res = await postJson(`${url}/v1/job`, { input: "hi" });
    expect(res.status).toBe(400);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("error");
    expect(requestSpans[0].attributes["error.code"]).toBe("capability_required");
    expect(requestSpans[0].dimensions).not.toHaveProperty("capability");
  });

  it("emits dvm.auth.verify error span on unsigned request", async () => {
    const authSchema = z.object({
      pubkey: z.string().regex(/^[0-9a-f]{64}$/),
      signature: z.string().regex(/^[0-9a-f]{128}$/),
      timestamp: z.number().int(),
      nonce: z.string().min(8),
      msg: z.string()
    });
    const url = await startHost({
      inputSchema: authSchema,
      auth: secp256k1Auth({ replayStore: null })
    });
    const res = await postJson(`${url}/v1/job`, {
      capability: "echo",
      data: {
        pubkey: "a".repeat(64),
        signature: "b".repeat(128),
        timestamp: Math.floor(Date.now() / 1000),
        nonce: "test-nonce-12345",
        msg: "hello"
      }
    });
    expect(res.status).toBe(401);

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(requestSpans[0].status).toBe("error");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(401);
    expect(requestSpans[0].attributes["error.code"]).toBe("auth_error");

    const authSpans = spansByName("dvm.auth.verify");
    expect(authSpans).toHaveLength(1);
    expect(authSpans[0].status).toBe("error");
    expect(authSpans[0].attributes["error.code"]).toBe("auth_error");
    expect(authSpans[0].parent_span_id).toBe(requestSpans[0].span_id);
  });

  it("emits dvm.payment.validate ok span on the paid job path", async () => {
    const { url, signer } = await startPaymentServer();
    const signed = signer.signRequest(PRIVKEY, { action: "publish" });

    const probe = await postJson(`${url}/v1/job`, {
      capability: "do",
      data: signed
    });
    expect(probe.status).toBe(402);
    const challenge = Challenge.fromHeadersList(probe.headers)[0];
    expect(challenge).toBeTruthy();

    // Drop the unpaid probe's spans; assert only the paid request's trace.
    emitted.length = 0;
    const paid = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildCredentialFor(challenge, "a")
      },
      body: JSON.stringify({ capability: "do", data: signed })
    });
    expect([200, 202]).toContain(paid.status);

    const paySpans = spansByName("dvm.payment.validate");
    expect(paySpans).toHaveLength(1);
    expect(paySpans[0].status).toBe("ok");
    expect(paySpans[0].attributes.capability).toBe("do");
    expect(paySpans[0].error_message).toBeNull();

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(paySpans[0].parent_span_id).toBe(requestSpans[0].span_id);
    expect(paySpans[0].trace_id).toBe(requestSpans[0].trace_id);
  });

  it("emits dvm.payment.validate error span when verification fails", async () => {
    const { url, signer } = await startPaymentServer({ failVerify: true });
    const signed = signer.signRequest(PRIVKEY, { action: "publish" });

    const probe = await postJson(`${url}/v1/job`, {
      capability: "do",
      data: signed
    });
    expect(probe.status).toBe(402);
    const challenge = Challenge.fromHeadersList(probe.headers)[0];
    expect(challenge).toBeTruthy();

    // Drop the unpaid probe's spans; assert only the failing paid request.
    emitted.length = 0;
    const paid = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: buildCredentialFor(challenge, "a")
      },
      body: JSON.stringify({ capability: "do", data: signed })
    });
    expect(paid.status).toBe(402);
    const body = (await paid.json()) as { error: string };
    expect(body.error).toBe("payment_invalid");

    const paySpans = spansByName("dvm.payment.validate");
    expect(paySpans).toHaveLength(1);
    expect(paySpans[0].status).toBe("error");
    expect(paySpans[0].error_message).toBeNull();
    // the failing money-step span carries its own structured
    // `error.code`, so a payment-failure query can filter the child span
    // directly without joining back to `dvm.request`.
    expect(paySpans[0].attributes["error.code"]).toBe("payment_invalid");

    const requestSpans = spansByName("dvm.request");
    expect(requestSpans).toHaveLength(1);
    expect(paySpans[0].parent_span_id).toBe(requestSpans[0].span_id);
    expect(requestSpans[0].attributes["error.code"]).toBe("payment_invalid");
    expect(requestSpans[0].attributes["http.status_code"]).toBe(402);
  });
});
