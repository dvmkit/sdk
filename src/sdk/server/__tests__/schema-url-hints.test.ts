import { createHash } from "node:crypto";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { SignedRequestAudience } from "../../../lib/signed-request-statement";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const requestOrigin = "http://request.example.com";
const publicOrigin = "https://public.example.com";
const schema = z.object({
  text: z.string(),
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
});

describe.each([
  { prefix: "", path: "" },
  { prefix: "/feed", path: "/feed" },
  { prefix: "/feed/", path: "/feed" },
])("schema hints at mount '$prefix'", ({ prefix, path }) => {
  describe.each([false, true])("configured public origin: %s", (configured) => {
    let instance: Awaited<ReturnType<typeof createDVMServer>>;
    let app: Pick<Hono, "request">;
    let jobStore: MemoryJobStore;
    const expectedUrl = `${configured ? publicOrigin : requestOrigin}${path}/v1/info`;

    beforeEach(async () => {
      for (const level of ["log", "info", "warn"] as const) {
        vi.spyOn(console, level).mockImplementation(() => undefined);
      }
      jobStore = new MemoryJobStore();
      instance = await createDVMServer(configureDVM({
        name: "schema-hints",
        auth: secp256k1Auth({ replayStore: null }),
        capabilities: {
          run: {
            input: schema,
            onQuote: {
              schema: z.object({ text: z.literal("quote") }),
              async handler() {
                return { upfront: { amount: 0.01, currency: "usd" }, description: "Example quote" };
              },
            },
            onJob(ctx) { ctx.complete("done"); },
          },
        },
      }), {
        env: configured ? { DVMKIT_PUBLIC_URL: `${publicOrigin}/ignored/path/` } : {},
        store: new MemoryKVStore(),
        jobStore,
        devMode: true,
        mountPrefix: prefix,
      });
      app = prefix ? new Hono().route(prefix, instance.app) : instance.app;
    });

    afterEach(async () => {
      await instance?.shutdown();
      vi.restoreAllMocks();
    });

    function post(route: string, body: unknown, headers: Record<string, string> = {}) {
      return app.request(`${requestOrigin}${path}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    it.each(["/v1/job", "/v1/quote"])("points invalid JSON at the mounted schema on %s", async (route) => {
      const response = await post(route, "{");
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request", hint: expect.stringContaining(expectedUrl) });
    });

    it.each([
      { body: {}, error: "capability_required" },
      { body: { capability: "missing" }, error: "unknown_capability" },
      { body: { capability: "run", data: { text: 42 } }, error: "invalid_input" },
    ])("points $error at the mounted schema on job and quote", async ({ body, error }) => {
      for (const route of ["/v1/job", "/v1/quote"]) {
        const response = await post(route, body);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error, hint: expect.stringContaining(expectedUrl) });
      }
    });

    it("points quote-schema validation at the mounted schema", async () => {
      const info = await (await app.request(`${requestOrigin}${path}/v1/info`)).json() as { auth_audience: SignedRequestAudience };
      const data = createSignedRequestVerifier(schema, { replayStore: null }).signRequest(
        new Uint8Array(32).fill(7), { text: "not a quote" }, {},
        { audience: info.auth_audience, method: "POST", path: `${path}/v1/quote`, capability: "run" },
      );
      const response = await post("/v1/quote", { capability: "run", data });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_quote_data", hint: expect.stringContaining(expectedUrl) });
    });

    it("points a 401 input-schema auth failure at the mounted schema", async () => {
      // Recovery authenticates before parsing capability input, so input failures
      // reach the shared 401 classifier rather than job/quote's 400 input gate.
      const response = await post("/v1/request-result/example-request", { capability: "run", data: { text: 42 } });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: "auth_error", sub_reason: "schema_invalid", hint: expect.stringContaining(expectedUrl),
      });
    });

    it("points a 410 removed-capability response at the mounted schema", async () => {
      await jobStore.save({
        id: "removed-job", tags: [], capability: "removed", input: "{}", params: {},
        requesterId: "dev-anonymous",
        requesterTokenHash: createHash("sha256").update("example-job-token").digest("hex"),
        status: "processing", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
        stepCache: [], state: {}, createdAt: Date.now(), lastActivityAt: Date.now(),
      });
      const response = await post("/v1/job/removed-job/messages", {
        type: "response", content: { text: "continue" },
      }, { "X-Job-Token": "example-job-token" });
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ error: "unknown_capability", hint: expect.stringContaining(expectedUrl) });
    });

    it("keeps x402 capability errors pointing at the mounted schema", async () => {
      const response = await post("/v1/x402/missing", {});
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "unknown_capability", hint: expect.stringContaining(expectedUrl) });
    });
  });
});
