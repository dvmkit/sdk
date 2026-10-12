/**
 * `/v1/quote` and `/v1/job` verify the signature over the same bytes.
 *
 * They used to disagree — quote checked the raw `body.data`, submit checked
 * `JobManager.parseInput`'s Zod output — and agreed only where the parse
 * happened to be an identity on the caller's payload. `dvm quote` / `dvm
 * request` fill the published JSON Schema's **top-level** defaults before
 * signing, so every first-party schema stayed inside that window by luck. A
 * nested `.default()` or any undeclared key the caller sent fell outside it:
 * the quote passed and the paid submit 401'd `signature_invalid`, blaming the
 * caller's signature for a schema shape they never saw.
 *
 * The schema here is the one the CLI cannot compensate for — a nested default
 * inside an object the caller does send, plus an optional field and a stray
 * top-level key. The HTTP cases drive the real CLI signer (`signDvmRequestData`)
 * against a real host, which is the path `dvm request` walks.
 */
import { describe, expect, it } from "vitest";
import { toJSONSchema, z } from "zod";

import { signDvmRequestData } from "../../../lib/cli-sign-request";
import type {
  SignedRequestAudience,
  SignedRequestDomain,
} from "../../../lib/signed-request-statement";
import { applyJsonSchemaDefaults } from "../../../test-support/schema-defaults";
import { configureDVM } from "../../configure";
import type { QuoteContext } from "../../types";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import {
  createSignedRequestVerifier,
  SignedRequestError,
  signedRequestInput,
} from "../signed-request";

const PRIVKEY_HEX = "07".repeat(32);
const TEST_DOMAIN: SignedRequestDomain = {
  audience: { dvm_id: "signed-bytes-test", builder_pubkey: "11".repeat(32) },
  method: "POST",
  path: "/v1/job",
  capability: "fetch",
};

const inputSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  url: z.string(),
  // Top-level default — the CLI fills this one before signing.
  format: z.string().default("markdown"),
  // Nested default — `applyJsonSchemaDefaults` is top-level only, so this one
  // exists in the parsed input and never in the bytes the caller signed.
  options: z.object({
    label: z.string().optional(),
    depth: z.number().default(2),
  }),
  note: z.string().optional(),
});

/** The wire body `dvm request` would build: caller fields + top-level defaults, signed. */
function signLikeCli(
  data: Record<string, unknown>,
  domain: SignedRequestDomain,
  schemaJson?: Record<string, unknown>
): Record<string, unknown> {
  const json =
    schemaJson ?? (toJSONSchema(inputSchema, { io: "input" }) as Record<string, unknown>);
  return signDvmRequestData(PRIVKEY_HEX, applyJsonSchemaDefaults(json, data).data, domain);
}

describe("canonical bytes are the same on every auth path", () => {
  const verifier = createSignedRequestVerifier(inputSchema, {
    replayStore: null,
    domain: TEST_DOMAIN,
  });
  const auth = secp256k1Auth();

  const wire = signLikeCli({ url: "https://example.com", options: { label: "body" } }, TEST_DOMAIN);

  it("reads the same bytes off body.data and off the persisted input string", () => {
    // `app.ts` persists `JSON.stringify(body.data)`, which reactivation reads
    // back — the submit and the re-verify must agree byte-for-byte.
    expect(verifier.canonicalBytes(signedRequestInput({ input: JSON.stringify(wire) }))).toEqual(
      verifier.canonicalBytes(signedRequestInput({ data: wire }))
    );
  });

  it("verifies on the raw body while the Zod-parsed form does not", () => {
    expect(
      auth.checkAuth(inputSchema, signedRequestInput({ data: wire }), TEST_DOMAIN).pubkey
    ).toBe(wire.pubkey);
    // The regression this closes: the parsed input has `options.depth` filled,
    // so its canonical bytes are not the ones the caller signed.
    const parsed = inputSchema.parse(wire);
    expect(parsed.options.depth).toBe(2);
    expect(() => verifier.canonicalBytes(parsed)).toThrow(SignedRequestError);
    expect(() => auth.checkAuth(inputSchema, parsed, TEST_DOMAIN)).toThrow(SignedRequestError);
  });

  it("keeps an undeclared top-level key in the verified bytes", () => {
    const stray = signLikeCli(
      {
        url: "https://example.com",
        options: { label: "body" },
        not_in_the_schema: "kept",
      },
      TEST_DOMAIN
    );
    expect(
      auth.checkAuth(inputSchema, signedRequestInput({ data: stray }), TEST_DOMAIN).pubkey
    ).toBe(stray.pubkey);
    // Zod drops it, which is why verifying the parsed form named the caller's
    // signature for a field they simply mistyped.
    expect(() => auth.checkAuth(inputSchema, inputSchema.parse(stray), TEST_DOMAIN)).toThrow(
      SignedRequestError
    );
  });

  it("falls back to an empty object when the body carries no input", () => {
    expect(signedRequestInput({})).toEqual({});
    expect(signedRequestInput({ input: "" })).toEqual({});
    expect(signedRequestInput({ input: "not json" })).toEqual({});
    expect(signedRequestInput({ data: null })).toBeNull();
  });
});

describe("a CLI-signed request with a nested default quotes and submits", () => {
  interface InfoBody {
    capabilities?: Record<string, { input_schema?: Record<string, unknown> }>;
    auth_audience?: SignedRequestAudience;
  }

  async function withHost(
    fn: (
      url: string,
      schemaJson: Record<string, unknown>,
      audience: SignedRequestAudience
    ) => Promise<void>,
    priced = false
  ): Promise<void> {
    const dvm = configureDVM({
      name: "signed-bytes-parity",
      capability: "fetch",
      tag: "test",
      input: inputSchema,
      auth: secp256k1Auth(),
      // The priced variant exists to observe what the quote actually read: its
      // handler prices off `ctx.data`, so a quote served over `{}` fails the
      // schema instead of describing the caller's URL.
      ...(priced
        ? {
            onQuote: {
              schema: inputSchema,
              handler: (ctx: QuoteContext) =>
                Promise.resolve({
                  upfront: { amount: 0.01, currency: "usd" as const },
                  description: `fetch ${String(ctx.data.url)}`,
                }),
            },
          }
        : {}),
      onJob(ctx) {
        ctx.complete(`ok:${ctx.auth?.pubkey ?? "missing"}`);
      },
    });
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    const server = await host.serve();
    try {
      const info = (await (await fetch(`${server.url}/v1/info`)).json()) as InfoBody;
      const schemaJson = info.capabilities?.fetch.input_schema;
      if (!schemaJson) throw new Error("/v1/info carried no input schema for `fetch`");
      if (!info.auth_audience) throw new Error("/v1/info carried no signed-request audience");
      await fn(server.url, schemaJson, info.auth_audience);
    } finally {
      await server.close();
    }
  }

  async function post(url: string, path: string, data: Record<string, unknown>): Promise<Response> {
    return fetch(`${url}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "fetch", data }),
    });
  }

  it("accepts the same input with route-bound proofs on /v1/quote and /v1/job", async () => {
    await withHost(async (url, schemaJson, audience) => {
      const input = { url: "https://example.com", options: { label: "body" } };
      const quoteData = signLikeCli(input, requestDomain(audience, "/v1/quote"), schemaJson);
      const quote = await post(url, "/v1/quote", quoteData);
      expect(quote.status).toBe(200);
      // Before this was a 401 `auth_error` / `signature_invalid`:
      // Zod filled `options.depth` and the submit verified the filled form.
      const jobData = signLikeCli(input, requestDomain(audience, "/v1/job"), schemaJson);
      const job = await post(url, "/v1/job", jobData);
      expect(job.ok).toBe(true);
    });
  });

  it("accepts a signed body carrying an undeclared key on both endpoints", async () => {
    await withHost(async (url, schemaJson, audience) => {
      const input = {
        url: "https://example.com",
        options: { label: "body" },
        not_in_the_schema: "kept",
      };
      const quoteData = signLikeCli(input, requestDomain(audience, "/v1/quote"), schemaJson);
      expect((await post(url, "/v1/quote", quoteData)).status).toBe(200);
      const jobData = signLikeCli(input, requestDomain(audience, "/v1/job"), schemaJson);
      expect((await post(url, "/v1/job", jobData)).ok).toBe(true);
    });
  });

  it("prices the quote over the bytes it verified, in either body form", async () => {
    // The quote reads its structured input through the same
    // `signedRequestInput` its auth gate uses, so the JSON-string form — which
    // that gate has always accepted — is priced on the caller's real fields.
    // It used to be verified and then quoted over `{}`, which on a capability
    // whose quote schema requires anything was a 400 the caller could not act
    // on.
    await withHost(async (url, schemaJson, audience) => {
      const data = signLikeCli(
        { url: "https://example.com", options: { label: "body" } },
        requestDomain(audience, "/v1/quote"),
        schemaJson
      );
      for (const body of [{ data }, { input: JSON.stringify(data) }]) {
        const res = await fetch(`${url}/v1/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capability: "fetch", ...body }),
        });
        expect(res.status).toBe(200);
        const quote = (await res.json()) as { description: string };
        expect(quote.description).toBe("fetch https://example.com");
      }
    }, true);
  });

  it("still refuses a tampered body on both endpoints", async () => {
    await withHost(async (url, schemaJson, audience) => {
      for (const path of ["/v1/quote", "/v1/job"]) {
        const data = signLikeCli(
          { url: "https://example.com", options: { label: "body" } },
          requestDomain(audience, path),
          schemaJson
        );
        const tampered = { ...data, url: "https://evil.example" };
        const res = await post(url, path, tampered);
        expect(res.status).toBe(401);
        const body = (await res.json()) as { error: string; sub_reason: string };
        expect(body.error).toBe("auth_error");
        expect(body.sub_reason).toBe("signature_invalid");
      }
    });
  });
});

function requestDomain(audience: SignedRequestAudience, path: string): SignedRequestDomain {
  return { audience, method: "POST", path, capability: "fetch" };
}
