import assert from "node:assert/strict";
import { test } from "node:test";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Challenge, Credential } from "mppx";
import { MemoryJobStore } from "@dvmkit/sdk/testing";
import * as hostCopy from "./signed-request-copy.mjs";
import * as projectCopy from "./project/signed-request-copy.mjs";

const key = new Uint8Array(32).fill(1);
const otherKey = new Uint8Array(32).fill(2);
const now = Math.floor(Date.now() / 1000);

test("a host handles auth from two physical packed SDK installations", async (t) => {
  assert.notEqual(realpathSync(fileURLToPath(hostCopy.serverModule)), realpathSync(fileURLToPath(projectCopy.serverModule)));
  assert.notEqual(hostCopy.server.SignedRequestError, projectCopy.server.SignedRequestError);

  const controls = new Map<string, unknown>();
  for (const copy of [hostCopy, projectCopy]) {
    await t.test(copy === hostCopy ? "same-copy control" : "separate installation", async () => {
      const h = await start(copy);
      try {
        const lookup = "/v1/request-result/example-request";
        const invalidInput = h.sign(lookup, { text: "too long", request_id: "example-request" });
        const recovery = await h.post(lookup, invalidInput);
        assert.equal(recovery.status, 401, "schema rejection at recovery auth must remain a refusal");
        assert.equal(recovery.body.error, "auth_error");
        assert.equal(recovery.body.sub_reason, "schema_invalid");
        assert.match(recovery.body.display, /text: too long \(max 3 chars\)/);
        assert.match(recovery.body.hint, /Split into smaller chunks/);
        parity("recovery input rejection", recovery);
        assertNoJob(recovery.body);
        assert.deepEqual(h.effects(), { jobs: 0, nonces: 0, handlers: 0, quotes: 0, payments: 0 });

        for (const path of [lookup, "/v1/job", "/v1/quote"]) {
          for (const [data, reason] of [
            [{ text: "ok" }, "signature_required"],
            [{ ...h.sign(path), signature: "00".repeat(64) }, "signature_invalid"],
            [h.sign(path, {}, key, now - 301), "timestamp_drift"],
          ] as const) {
            const response = await h.post(path, data);
            assert.equal(response.status, 401, `${path}: ${reason}`);
            assert.equal(response.body.error, "auth_error");
            assert.equal(response.body.sub_reason, reason);
            assert.equal(typeof response.body.display, "string");
            parity(`${path}: ${reason}`, response);
            assertNoJob(response.body);
          }
        }
        // Job/quote input validation runs before auth; recovery intentionally authenticates first.
        for (const path of ["/v1/job", "/v1/quote"]) {
          const response = await h.post(path, { text: "too long" });
          assert.equal(response.status, 400);
          assert.equal(response.body.error, "invalid_input");
          assertNoJob(response.body);
          const priced = await h.post(path, { ...h.sign(path, {}, key, now, "priced"), signature: "00".repeat(64) }, "priced", true);
          assert.equal(priced.status, 401);
        }
        assert.deepEqual(h.effects(), { jobs: 0, nonces: 0, handlers: 0, quotes: 0, payments: 0 });

        const submitted = await h.post("/v1/job", h.sign("/v1/job", { request_id: "example-request" }));
        assert.equal(submitted.status, 200);
        assert.equal(typeof submitted.body.job_id, "string");
        assert.equal(h.effects().handlers, 1);
        assert.equal(h.effects().nonces, 1);
        const acceptedEffects = h.effects();
        const recovered = await h.post(lookup, h.sign(lookup, { request_id: "example-request" }));
        assert.equal(recovered.status, 200);
        assert.equal(recovered.body.job_id, submitted.body.job_id);
        assert.deepEqual(h.effects(), acceptedEffects, "recovery is read-only");

        for (const [data, capability] of [
          [h.sign(lookup, { request_id: "example-request" }, otherKey), "run"],
          [h.sign(lookup, { request_id: "different-request" }), "run"],
          [h.sign(lookup, { text: "new", request_id: "example-request" }), "run"],
          [h.sign(lookup, { request_id: "example-request" }, key, now, "other"), "other"],
        ] as const) {
          const response = await h.post(lookup, data, capability);
          assert.equal(response.status, 404);
          assert.equal(response.body.error, "request_not_found");
          assertNoJob(response.body);
        }
        const wrongDomain = await h.post(lookup, h.sign("/v1/job", { request_id: "example-request" }));
        assert.equal(wrongDomain.status, 401);
        assert.equal(wrongDomain.body.sub_reason, "signature_invalid");
        assert.deepEqual(h.effects(), acceptedEffects);

        const replayable = h.sign("/v1/job");
        assert.equal((await h.post("/v1/job", replayable)).status, 200);
        const beforeReplay = h.effects();
        const replay = await h.post("/v1/job", replayable);
        assert.equal(replay.status, 401);
        assert.equal(replay.body.sub_reason, "replay_detected");
        assertNoJob(replay.body);
        assert.deepEqual(h.effects(), beforeReplay);

        for (const path of [lookup, "/v1/job", "/v1/quote"]) {
          const misconfigured = await h.post(path, {}, "misconfigured");
          assert.equal(misconfigured.status, 500);
          assert.equal(misconfigured.body.sub_reason, "schema_invalid");
        }

        // A correctly authenticated paid request reaches the provider. The
        // same attached credential above must not get that far on auth refusal.
        const beforePayment = h.effects();
        const paid = await h.post("/v1/job", h.sign("/v1/job", {}, key, now, "priced"), "priced", true);
        assert.equal(paid.status, 402);
        assert.equal(h.effects().payments, 1);
        assert.equal(h.effects().nonces, beforePayment.nonces);
        assert.equal(h.effects().handlers, beforePayment.handlers);

        function parity(label: string, response: { status: number; body: unknown }) {
          const normalized = JSON.parse(JSON.stringify(response).replaceAll(h.url, "http://example.com"));
          if (copy === hostCopy) controls.set(label, normalized);
          else assert.deepEqual(normalized, controls.get(label), label);
        }
      } finally {
        await h.close();
      }
    });
  }

  await t.test("unrelated errors and malformed auth lookalikes stay private server errors", async () => {
    for (const error of [
      new Error("SECRET_AUTH_FAILURE"),
      Object.assign(new Error("SECRET_AUTH_FAILURE"), { code: "auth_error", sub_reason: "signature_invalid" }),
      Object.assign(new Error("SECRET_AUTH_FAILURE"), { name: "SignedRequestError", code: "auth_error", sub_reason: "unexpected" }),
      Object.assign(new Error("SECRET_AUTH_FAILURE"), { name: "SignedRequestError", code: "auth_error", sub_reason: "schema_invalid", issues: [{ path: null }] }),
    ]) {
      const h = await start(projectCopy, error);
      try {
        for (const path of ["/v1/request-result/example-request", "/v1/job", "/v1/quote"]) {
          const response = await h.post(path, h.sign(path));
          assert.equal(response.status, 500);
          assert.equal(JSON.stringify(response.body).includes("SECRET_AUTH_FAILURE"), false);
          assert.notEqual(response.body.error, "auth_error");
          assertNoJob(response.body);
        }
        assert.deepEqual(h.effects(), { jobs: 0, nonces: 0, handlers: 0, quotes: 0, payments: 0 });
      } finally {
        await h.close();
      }
    }
  });
});

function assertNoJob(body: Record<string, unknown>) {
  for (const field of ["job_id", "job_token", "receipt"]) assert.equal(field in body, false);
}

async function start(copy: typeof hostCopy, failure?: Error) {
  const { z } = copy;
  const schema = z.object({
    text: z.string().max(3),
    pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
  });
  let jobs = 0;
  let handlers = 0;
  let quotes = 0;
  let payments = 0;
  const nonces = new Set<string>();
  const auth = copy.server.secp256k1Auth({
    now: () => now,
    replayStore: {
      async checkAndRecord(pubkey: string, timestamp: number, nonce: string) {
        const id = `${pubkey}:${timestamp}:${nonce}`;
        if (nonces.has(id)) return true;
        nonces.add(id);
        return false;
      },
    },
  });
  if (failure) auth.checkAuth = () => { throw failure; };
  const store = new MemoryJobStore();
  const save = store.save.bind(store);
  store.save = (record) => { jobs++; return save(record); };
  const capability = {
    input: schema,
    onJob(ctx: { complete: (result: string) => void }) { handlers++; ctx.complete("done"); },
  };
  const descriptor = copy.sdk.configureDVM({
    name: "example",
    capabilities: {
      run: capability,
      other: capability,
      priced: {
        ...capability,
        onQuote: {
          schema: z.object({ text: z.string() }),
          async handler() { quotes++; return { upfront: { amount: 0.01, currency: "usd" }, description: "Example price" }; },
        },
      },
      misconfigured: { onJob: capability.onJob },
    },
    auth,
  });
  // The payment provider is external; authentication and all host ordering remain real.
  const mpp = {
    methods: [{ name: "tempo", intent: "charge" }],
    challenge: {},
    async broadcastCredential() { payments++; throw new Error("Unexpected payment acceptance"); },
    async issueChallenge(method: string, intent: string, opts: Record<string, unknown>) {
      return Challenge.from({
        id: "example-challenge", realm: "example.com", method, intent,
        request: { amount: opts.amount, currency: "0x" + "22".repeat(20) },
      });
    },
  };
  const host = hostCopy.server.createDVMHost({
    env: {}, devMode: true, jobStore: store, mpp,
    fx: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
  });
  host.mount(descriptor);
  const server = await host.serve({ port: 0 });
  try {
    const info = await (await fetch(`${server.url}/v1/info`)).json();
    const signer = copy.server.createSignedRequestVerifier(schema, { now: () => now, replayStore: null });
    let nonce = 0;
    return {
      url: server.url,
      close: server.close,
      effects: () => ({ jobs, nonces: nonces.size, handlers, quotes, payments }),
      sign(path: string, body = {}, secret = key, timestamp = now, capability = "run") {
        return signer.signRequest(secret, { text: "ok", ...body }, { timestamp, nonce: `example-nonce-${++nonce}` }, {
          audience: info.auth_audience, method: "POST", path, capability,
        });
      },
      async post(path: string, data: unknown, capability = "run", withPayment = false) {
        const authorization = Credential.serialize(Credential.from({
          challenge: Challenge.from({
            id: "example-payment", realm: "example.com", method: "tempo", intent: "charge",
            request: { amount: "0.01", currency: "0x" + "22".repeat(20) },
          }),
          payload: { type: "hash", hash: "0x" + "33".repeat(32) },
        }));
        const response = await fetch(`${server.url}${path}`, {
          method: "POST", headers: { "Content-Type": "application/json", ...(withPayment ? { Authorization: authorization } : {}) },
          body: JSON.stringify({ capability, data }),
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = { message: text }; }
        return { status: response.status, body };
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
