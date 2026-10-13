import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import type {
  CanonicalEnvelope,
  SignedRequestReplayStore,
  SignedRequestSignOpts,
  SignedRequestVerifier,
} from "../signed-request";
import { createSignedRequestVerifier, SignedRequestError } from "../signed-request";

const sampleSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);
const AUTH_AUDIENCE = {
  dvm_id: "dev:auth-test",
  builder_pubkey: createHash("sha256").update("dvmkit-dev:dev:auth-test").digest("hex"),
};

function signFor(
  signer: SignedRequestVerifier<z.infer<typeof sampleSchema>>,
  path: "/v1/job" | "/v1/quote",
  body: Record<string, unknown>,
  opts?: SignedRequestSignOpts
) {
  return signer.signRequest(PRIVKEY, body, opts, {
    audience: AUTH_AUDIENCE,
    method: "POST",
    path,
    capability: "do",
  });
}

describe("DVM-level secp256k1 auth slot", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  function buildHost(opts?: { now?: () => number }) {
    const signer = createSignedRequestVerifier(sampleSchema, { now: opts?.now });
    const dvm = configureDVM({
      name: "auth-test",
      capabilities: {
        do: {
          input: sampleSchema,
          onJob(ctx) {
            ctx.complete(`ok:${ctx.auth?.pubkey ?? "missing"}`);
          },
        },
      },
      auth: secp256k1Auth({ now: opts?.now }),
    });
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    host.mount(dvm);
    return { host, signer };
  }

  it("advertises v2 auth and its audience on /v1/info", async () => {
    const { host } = buildHost();
    server = await host.serve();

    const res = await fetch(`${server.url}/v1/info`);
    const info = (await res.json()) as { auth?: string[]; auth_audience?: unknown };
    expect(info.auth).toEqual(["secp256k1-schnorr-v2"]);
    expect(info.auth_audience).toEqual(AUTH_AUDIENCE);
  });

  it("rejects POST /v1/job with an unsigned envelope as 401 auth_error", async () => {
    const { host } = buildHost();
    server = await host.serve();

    const res = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "do",
        data: { action: "publish" },
      }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: "auth_error",
      sub_reason: "signature_invalid",
    });
  });

  it("rejects POST /v1/job with a tampered signature as 401 signature_invalid", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();

    const signed = signFor(signer, "/v1/job", { action: "publish" });
    const tampered = { ...signed, action: "delete" };
    const res = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: tampered }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; sub_reason: string };
    expect(body.error).toBe("auth_error");
    expect(body.sub_reason).toBe("signature_invalid");
  });

  it("rejects POST /v1/job with a stale timestamp as 401 timestamp_drift", async () => {
    const FIXED = 1_700_000_000;
    const { host, signer } = buildHost({ now: () => FIXED + 600 }); // 10 min past sign
    server = await host.serve();

    const signed = signFor(signer, "/v1/job", { action: "publish" }, { timestamp: FIXED });
    const res = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { sub_reason: string };
    expect(body.sub_reason).toBe("timestamp_drift");
  });

  it("rejects a replayed envelope (second POST /v1/job) as 401 replay_detected", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();

    const signed = signFor(signer, "/v1/job", { action: "publish" });
    const first = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(first.status).toBeLessThan(400);

    const second = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(second.status).toBe(401);
    const body = (await second.json()) as { sub_reason: string };
    expect(body.sub_reason).toBe("replay_detected");
  });

  it("accepts a valid signed POST /v1/job and exposes ctx.auth to the handler", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();

    const signed = signFor(signer, "/v1/job", { action: "publish" });
    const res = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: signed }),
    });
    expect(res.status).toBeLessThan(400);
    const body = (await res.json()) as {
      job_id: string;
      status?: string;
      summary?: string;
    };
    expect(body.status).toBe("completed");
    expect(body.summary).toBe(`ok:${signed.pubkey}`);
  });

  it("rejects POST /v1/quote with a tampered signature as 401", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();

    const signed = signFor(signer, "/v1/quote", { action: "publish" });
    const tampered = { ...signed, action: "delete" };
    const res = await fetch(`${server.url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: tampered }),
    });
    expect(res.status).toBe(401);
  });

  it("POST /v1/quote does NOT consume the nonce — caller can submit /v1/job afterward", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();

    const signing = { timestamp: Math.floor(Date.now() / 1000), nonce: "quote-job-same-nonce" };
    const quoteSigned = signFor(signer, "/v1/quote", { action: "publish" }, signing);
    const quote = await fetch(`${server.url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: quoteSigned }),
    });
    expect(quote.status).toBeLessThan(400);

    const jobSigned = signFor(signer, "/v1/job", { action: "publish" }, signing);
    const job = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: jobSigned }),
    });
    expect(job.status).toBeLessThan(400);
    const body = (await job.json()) as { status?: string };
    expect(body.status).toBe("completed");
  });

  it("rejects reusing a quote proof on the job route", async () => {
    const { host, signer } = buildHost();
    server = await host.serve();
    const quoteSigned = signFor(signer, "/v1/quote", { action: "publish" });
    const res = await fetch(`${server.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "do", data: quoteSigned }),
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ sub_reason: "signature_invalid" });
  });
});

describe("resolveReplayStore late-binding seam", () => {
  function makeRecordingStore(): {
    store: SignedRequestReplayStore;
    calls: { pubkey: string; timestamp: number; nonce: string }[];
  } {
    const calls: { pubkey: string; timestamp: number; nonce: string }[] = [];
    return {
      calls,
      store: {
        async checkAndRecord(pubkey, timestamp, nonce, _t) {
          calls.push({ pubkey, timestamp, nonce });
          return false;
        },
      },
    };
  }

  const envelope: CanonicalEnvelope = {
    pubkey: "a".repeat(64),
    signature: "0".repeat(128),
    timestamp: 1_700_000_000,
    nonce: "nonce-abc",
  };

  it("adopts a host-supplied Postgres store when the user passed no replayStore", async () => {
    const scheme = secp256k1Auth();
    const { store, calls } = makeRecordingStore();
    const backend = scheme.resolveReplayStore?.({ postgresStore: store });
    expect(backend).toBe("postgres");
    await scheme.recordReplay(envelope);
    expect(calls).toEqual([
      { pubkey: envelope.pubkey, timestamp: envelope.timestamp, nonce: envelope.nonce },
    ]);
  });

  it("reports 'memory' when no Postgres store is offered (host has no pool)", () => {
    const scheme = secp256k1Auth();
    const backend = scheme.resolveReplayStore?.({});
    expect(backend).toBe("memory");
  });

  it("respects an explicit user-supplied replayStore and reports 'user-supplied'", async () => {
    const userStore = makeRecordingStore();
    const scheme = secp256k1Auth({ replayStore: userStore.store });
    const sdkStore = makeRecordingStore();
    const backend = scheme.resolveReplayStore?.({ postgresStore: sdkStore.store });
    expect(backend).toBe("user-supplied");
    await scheme.recordReplay(envelope);
    expect(userStore.calls).toHaveLength(1);
    expect(sdkStore.calls).toHaveLength(0);
  });

  it("respects replayStore: null and reports 'disabled'", async () => {
    const scheme = secp256k1Auth({ replayStore: null });
    const sdkStore = makeRecordingStore();
    const backend = scheme.resolveReplayStore?.({ postgresStore: sdkStore.store });
    expect(backend).toBe("disabled");
    await scheme.recordReplay(envelope);
    expect(sdkStore.calls).toHaveLength(0);
  });

  it("propagates replay_detected from the adopted store on duplicate", async () => {
    const seen = new Set<string>();
    const trackingStore: SignedRequestReplayStore = {
      async checkAndRecord(pubkey, timestamp, nonce) {
        const key = `${pubkey}|${timestamp}|${nonce}`;
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      },
    };
    const scheme = secp256k1Auth();
    scheme.resolveReplayStore?.({ postgresStore: trackingStore });
    await scheme.recordReplay(envelope);
    await expect(scheme.recordReplay(envelope)).rejects.toBeInstanceOf(SignedRequestError);
  });
});
