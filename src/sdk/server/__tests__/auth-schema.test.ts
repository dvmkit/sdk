import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import schemaInvalid from "../../../../protocol-fixtures/auth-schema-invalid-v1.json";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const signedSchema = z.object({
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
  text: z.string(),
});
const payloadSchema = z.object({ text: z.string() });
const hosts: Awaited<ReturnType<typeof createDVMServer>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.shutdown()));
});

async function host(schema: z.ZodType) {
  const onJob = vi.fn();
  const onQuote = vi.fn(async () => ({
    upfront: { amount: 0, currency: "usd" as const }, description: "example quote",
  }));
  const auth = secp256k1Auth({ replayStore: null });
  const replay = vi.spyOn(auth, "recordReplay");
  const jobs = new MemoryJobStore();
  const save = vi.spyOn(jobs, "save");
  const server = await createDVMServer(configureDVM({
    name: "schema-test", auth,
    capabilities: { catalog: { input: schema, onJob, onQuote: { schema: payloadSchema, handler: onQuote } } },
  }), { env: {}, devMode: true, store: new MemoryKVStore(), jobStore: jobs });
  hosts.push(server);
  const info = await (await server.app.request("/v1/info")).json();
  const signer = createSignedRequestVerifier(signedSchema, { replayStore: null });
  const sign = (path: string) => signer.signRequest(new Uint8Array(32).fill(3), { text: "hello" }, {}, {
    audience: info.auth_audience, method: "POST", path, capability: "catalog",
  });
  const post = (path: string, data: unknown, legacy = false) => server.app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "catalog", ...(legacy ? { input: JSON.stringify(data) } : { data }) }),
  });
  return { sign, post, onJob, onQuote, replay, save };
}

describe("schemas that drop a signed envelope", () => {
  it.each([
    ["union", z.union([payloadSchema, z.object({ other: z.number() })])],
    ["pipe", z.looseObject({}).pipe(payloadSchema)],
    ["transform", signedSchema.transform(value => ({ text: value.text }))],
    ["intersection", z.intersection(payloadSchema, payloadSchema)],
    ["non-object output", signedSchema.transform(value => value.text)],
  ])("reports a builder error for a %s before side effects", async (_name, schema) => {
    const server = await host(schema);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const path of ["/v1/quote", "/v1/job"]) {
      for (const legacy of [false, true]) {
        const response = await server.post(path, server.sign(path), legacy);
        expect(response.status).toBe(schemaInvalid.status);
        expect(await response.json()).toEqual(schemaInvalid.body);
      }
    }
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: "capability_schema_drops_signed_envelope", level: "error",
      capability: "catalog", "error.code": "auth_error",
    }));
    expect(server.onQuote).not.toHaveBeenCalled();
    expect(server.onJob).not.toHaveBeenCalled();
    expect(server.replay).not.toHaveBeenCalled();
    expect(server.save).not.toHaveBeenCalled();
  });

  it("names only the fields removed by a transform", async () => {
    const server = await host(signedSchema.transform(({ nonce: _nonce, ...rest }) => rest));
    const response = await server.post("/v1/job", server.sign("/v1/job"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      sub_reason: "schema_invalid", display: 'Capability "catalog" input schema drops signed envelope fields: nonce',
    });
  });

  it.each([
    ["union", z.union([signedSchema, z.never()])],
    ["pipe", z.looseObject({}).pipe(signedSchema)],
    ["transform", signedSchema.transform(value => ({ ...value, text: value.text.toUpperCase() }))],
    ["intersection", z.intersection(signedSchema, payloadSchema)],
  ])("accepts a signed quote when a %s preserves the envelope", async (_name, schema) => {
    const server = await host(schema);
    const response = await server.post("/v1/quote", server.sign("/v1/quote"));
    expect(response.status).toBe(200);
    expect(server.onQuote).toHaveBeenCalledOnce();
  });

  it("keeps malformed caller envelopes and wrong signatures as caller errors", async () => {
    const server = await host(signedSchema.partial().transform(value => value));
    for (const path of ["/v1/quote", "/v1/job"]) {
      for (const data of [
        { text: "hello", pubkey: "bad" },
        { ...server.sign(path), signature: "00".repeat(64) },
      ]) {
        const response = await server.post(path, data);
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          error: "auth_error", sub_reason: "signature_invalid",
          display: "Request signature didn't match the supplied pubkey",
        });
      }
    }
    expect(server.onQuote).not.toHaveBeenCalled();
    expect(server.onJob).not.toHaveBeenCalled();
  });
});
