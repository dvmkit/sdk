import { randomBytes } from "node:crypto";

import { Mppx, tempo } from "mppx/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodePaymentRequiredHeader,
  encodePayment,
  type PaymentPayload,
  type PaymentPayloadV1,
  type PaymentPayloadV2,
  type PaymentRequiredV2,
  X402_V1_VERSION,
  X402_VERSION,
} from "../../lib/x402/spec";
import type { X402Config } from "../../lib/x402/types";
import { configureDVM } from "../../sdk/index";
import { type ServedApps, servedApps } from "../../test-support/served-app";
import type { FxFetcher } from "../pricing/index";
import { expectJobIdentity, expectNoJobIdentity } from "../server/__tests__/__helpers__/job-identity";
import { createDVMServer } from "../server/app";
import { createMppFromOpts, type MppxServer, wrapMppx } from "../server/mpp-setup";
import type { X402FacilitatorHealthLike } from "../server/x402-facilitator-support";
import { MemoryKVStore } from "../store";

/** Stub fx fetcher — $100k/BTC. Tests don't depend on live CoinGecko. */
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/**
 * x402 dual-serve. Server emits both `WWW-Authenticate: Payment`
 * (MPP) and the x402-spec `accepts` envelope on the 402 response, accepts
 * `X-PAYMENT` (base64 PaymentPayload) on retry, calls the facilitator's
 * `/verify` and `/settle`, and surfaces `X-PAYMENT-RESPONSE` on success.
 */

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const X402_PAY_TO = "0x1111111111111111111111111111111111111111";

interface FacilitatorState {
  verifyResponse: { isValid: boolean; invalidReason?: string };
  settleResponse: {
    success: boolean;
    transaction?: string;
    network?: string;
    errorReason?: string;
  };
  verifyCalls: { paymentPayload: PaymentPayload; paymentRequirements: unknown }[];
  settleCalls: { paymentPayload: PaymentPayload; paymentRequirements: unknown }[];
}

function facilitatorApp(state: FacilitatorState): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    if (req.method !== "POST") return new Response("not found", { status: 404 });
    const body = (await req.json()) as {
      paymentPayload: PaymentPayload;
      paymentRequirements: unknown;
    };
    if (url.pathname === "/verify") {
      state.verifyCalls.push(body);
      return Response.json(state.verifyResponse);
    }
    if (url.pathname === "/settle") {
      state.settleCalls.push(body);
      return Response.json(state.settleResponse);
    }
    return new Response("not found", { status: 404 });
  };
}

function makeTempoMpp(): MppxServer {
  const mpp = wrapMppx(
    Mppx.create({
      methods: [
        tempo.charge({
          recipient: TEMPO_RECIPIENT,
          currency: "0x20C000000000000000000000b9537d11c60E8b50",
          decimals: 6,
        }),
      ],
      secretKey: randomBytes(32).toString("hex"),
      realm: "test.example",
    })
  );
  return mpp;
}

function fakePaymentPayloadV1(amount: string, payTo: string): PaymentPayloadV1 {
  return {
    x402Version: X402_V1_VERSION,
    scheme: "exact",
    network: "base",
    payload: {
      signature: `0x${"a".repeat(130)}`,
      authorization: {
        from: "0xfffffffffffffffffffffffffffffffffffffffe",
        to: payTo,
        value: amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${"b".repeat(64)}`,
      },
    },
  };
}

function fakePaymentPayloadV2(required: PaymentRequiredV2): PaymentPayloadV2 {
  const accepted = required.accepts[0];
  return {
    x402Version: X402_VERSION,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${"a".repeat(130)}`,
      authorization: {
        from: "0xfffffffffffffffffffffffffffffffffffffffe",
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 600),
        nonce: `0x${"b".repeat(64)}`,
      },
    },
    extensions: required.extensions ?? {},
  };
}

async function startServer(
  servers: ServedApps,
  opts: {
    x402: X402Config;
    mpp?: MppxServer;
    x402FacilitatorHealth?: X402FacilitatorHealthLike;
    env?: Record<string, string>;
  }
): Promise<{ url: string }> {
  const dvm = configureDVM({
    name: "x402 dual-serve test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });
  const { app } = await createDVMServer(dvm, {
    env: { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex"), ...opts.env },
    store: new MemoryKVStore(),
    x402: opts.x402,
    x402FacilitatorHealth: opts.x402FacilitatorHealth,
    mpp: opts.mpp,
    fxFetcher: stubFx,
  });
  return { url: await servers.serve(app) };
}

describe("x402 dual-serve 402 emission", () => {
  const servers = servedApps();

  it("advertises the exact USDC amount on a mid-job payment request", async () => {
    const dvm = configureDVM({
      name: "x402 mid-job amount test",
      capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(2_000, "metered work");
        ctx.complete("done");
      },
    });
    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      paymentMethods: ["x402"],
      x402: { payTo: X402_PAY_TO, network: "eip155:8453" },
      fxFetcher: stubFx,
    });

    try {
      const response = await app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      expect(response.status).toBe(202);
      const { job_id: jobId } = (await response.json()) as { job_id: string };

      await vi.waitFor(() => {
        const job = jobManager.activeJobs.get(jobId);
        const request = job?.messages.find((message) => message.type === "payment-request");
        expect(request?.content).toMatchObject({
          amount_msats: 2_000,
          x402: {
            pay_to: X402_PAY_TO,
            required_usdc_micro: "2000",
            payment_required: {
              x402Version: 2,
              resource: {
                url: `/v1/job/${jobId}/messages`,
                description: "metered work",
              },
              accepts: [
                expect.objectContaining({
                  scheme: "exact",
                  network: "eip155:8453",
                  amount: "2000",
                  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                  payTo: X402_PAY_TO,
                }),
              ],
            },
          },
        });
        expect(job?.pendingX402AmountUsdcMicro).toBe("2000");
      });
    } finally {
      jobManager.shutdown();
    }
  });

  it("omits the v2 mid-job challenge for a v1-only facilitator", async () => {
    const dvm = configureDVM({
      name: "x402 v1 mid-job test",
      capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(2_000, "metered work");
        ctx.complete("done");
      },
    });
    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      paymentMethods: ["x402"],
      x402: { payTo: X402_PAY_TO, network: "eip155:8453" },
      x402FacilitatorHealth: exactHealth({ v1: true, v2: false }),
      fxFetcher: stubFx,
    });

    try {
      const response = await app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      const { job_id: jobId } = (await response.json()) as { job_id: string };

      await vi.waitFor(() => {
        const request = jobManager.activeJobs
          .get(jobId)
          ?.messages.find((message) => message.type === "payment-request");
        expect(request?.content).toMatchObject({
          x402: {
            pay_to: X402_PAY_TO,
            required_usdc_micro: "2000",
          },
        });
        expect(
          (request?.content.x402 as { payment_required?: unknown }).payment_required
        ).toBeUndefined();
      });
    } finally {
      jobManager.shutdown();
    }
  });

  it("keeps v2 for an explicit x402 override when host health is v1-only", async () => {
    const overridePayTo = "0x2222222222222222222222222222222222222222";
    const overrideFacilitator = "https://override.example";
    const dvm = configureDVM({
      name: "x402 explicit override test",
      capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(2_000, "metered work", {
          x402: {
            pay_to: overridePayTo,
            network: "eip155:84532",
            asset: "USDC",
            facilitator: overrideFacilitator,
          },
        });
        ctx.complete("done");
      },
    });
    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      paymentMethods: ["x402"],
      x402: { payTo: X402_PAY_TO, network: "eip155:8453" },
      x402FacilitatorHealth: exactHealth({ v1: true, v2: false }),
      fxFetcher: stubFx,
    });

    try {
      const response = await app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      const { job_id: jobId } = (await response.json()) as { job_id: string };

      await vi.waitFor(() => {
        const request = jobManager.activeJobs
          .get(jobId)
          ?.messages.find((message) => message.type === "payment-request");
        expect(request?.content).toMatchObject({
          x402: {
            pay_to: overridePayTo,
            network: "eip155:84532",
            facilitator: overrideFacilitator,
            payment_required: {
              x402Version: X402_VERSION,
              accepts: [
                expect.objectContaining({
                  network: "eip155:84532",
                  payTo: overridePayTo,
                }),
              ],
            },
          },
        });
      });
    } finally {
      jobManager.shutdown();
    }
  });

  it("emits v2 requirements in PAYMENT-REQUIRED and v1 requirements in the body", async () => {
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", asset: "USDC" },
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBe(X402_V1_VERSION);
    expect(Array.isArray(body.accepts)).toBe(true);
    const accepts = body.accepts as Record<string, unknown>[];
    expect(accepts).toHaveLength(1);
    expect(accepts[0]).toMatchObject({
      scheme: "exact",
      network: "base",
      asset: "USDC",
      payTo: X402_PAY_TO,
      maxTimeoutSeconds: 60,
    });
    expect(typeof accepts[0].maxAmountRequired).toBe("string");
    const requiredHeader = res.headers.get("PAYMENT-REQUIRED");
    expect(requiredHeader).toBeTruthy();
    const required = decodePaymentRequiredHeader(requiredHeader ?? "");
    expect(required).toMatchObject({
      x402Version: X402_VERSION,
      resource: { url: `${url}/v1/job`, mimeType: "application/json" },
      extensions: {},
    });
    expect(required.accepts[0]).toMatchObject({
      scheme: "exact",
      network: "eip155:8453",
      amount: accepts[0].maxAmountRequired,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: X402_PAY_TO,
      extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
    });
  });

  it("advertises the configured public URL to both x402 client generations", async () => {
    const publicOrigin = "https://dvmkit--paid.example.com";
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", asset: "USDC" },
      env: { DVMKIT_PUBLIC_URL: `${publicOrigin}/ignored/path/` },
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    const body = (await res.clone().json()) as { accepts: { resource: string }[] };
    const required = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED") ?? "");
    expect(body.accepts[0].resource).toBe(`${publicOrigin}/v1/job`);
    expect(required.resource.url).toBe(`${publicOrigin}/v1/job`);
  });

  it("emits only PAYMENT-REQUIRED when the facilitator supports exact v2 only", async () => {
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", asset: "USDC" },
      x402FacilitatorHealth: exactHealth({ v1: false, v2: true }),
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(402);
    expect(body.x402Version).toBeUndefined();
    expect(body.accepts).toBeUndefined();
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("emits only the v1 body when the facilitator supports exact v1 only", async () => {
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", asset: "USDC" },
      x402FacilitatorHealth: exactHealth({ v1: true, v2: false }),
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(402);
    expect(body.x402Version).toBe(X402_V1_VERSION);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("omits x402Version + accepts when dualServe is false", async () => {
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", dualServe: false },
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBeUndefined();
    expect(body.accepts).toBeUndefined();
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body.error).toBe("payment_required");
  });

  it("emits both accepts (x402) and WWW-Authenticate (MPP) when both rails are wired", async () => {
    const mpp = makeTempoMpp();
    const { url } = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453" },
      mpp,
    });
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.x402Version).toBe(X402_V1_VERSION);
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    // mppx serialises one challenge per registered method; tempo is the
    // only method here so exactly one WWW-Authenticate header is set.
    const wwwAuth = res.headers.get("WWW-Authenticate");
    expect(wwwAuth).toBeTruthy();
    expect(wwwAuth).toMatch(/^Payment /);
  });
});

describe("x402 retry path with mocked facilitator", () => {
  const publicOrigin = "https://dvmkit--paid.example.com";
  const servers = servedApps({ teardown: "all" });
  let facilitatorUrl: string;
  let serverUrl: string;
  const facilitatorState: FacilitatorState = {
    verifyResponse: { isValid: true },
    settleResponse: { success: true, transaction: "0xfacsettled", network: "base" },
    verifyCalls: [],
    settleCalls: [],
  };
  let settlementSequence = 0;

  beforeAll(async () => {
    facilitatorUrl = await servers.serve({ fetch: facilitatorApp(facilitatorState) });
    const started = await startServer(servers, {
      x402: { payTo: X402_PAY_TO, network: "eip155:8453", facilitator: facilitatorUrl },
      env: { DVMKIT_PUBLIC_URL: publicOrigin },
    });
    serverUrl = started.url;
  });

  beforeEach(() => {
    facilitatorState.verifyCalls.length = 0;
    facilitatorState.settleCalls.length = 0;
    facilitatorState.verifyResponse = { isValid: true };
    facilitatorState.settleResponse = {
      success: true,
      transaction: `0xfacsettled${String(settlementSequence++)}`,
      network: "base",
    };
  });

  it("pays through PAYMENT-SIGNATURE and emits both response headers", async () => {
    // First request to extract the advertised maxAmountRequired so the
    // payload's authorization.value matches what the server expects to verify.
    const challengeRes = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const required = decodePaymentRequiredHeader(
      challengeRes.headers.get("PAYMENT-REQUIRED") ?? ""
    );
    expect(required.resource.url).toBe(`${publicOrigin}/v1/job`);
    expect(challengeRes.status).toBe(402);
    expectNoJobIdentity(challengeRes);
    const payload = fakePaymentPayloadV2(required);
    const xPayment = encodePayment(payload);

    const retry = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": xPayment },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect([200, 202]).toContain(retry.status);
    expect(facilitatorState.verifyCalls).toHaveLength(1);
    expect(facilitatorState.settleCalls).toHaveLength(1);
    expect(facilitatorState.verifyCalls[0]).toMatchObject({
      paymentPayload: {
        x402Version: X402_VERSION,
        resource: { url: `${publicOrigin}/v1/job` },
        accepted: { network: "eip155:8453" },
      },
      paymentRequirements: { network: "eip155:8453", amount: required.accepts[0].amount },
    });
    const settleResHeader = retry.headers.get("X-PAYMENT-RESPONSE") ?? "";
    expect(settleResHeader).toBeTruthy();
    expect(retry.headers.get("PAYMENT-RESPONSE")).toBe(settleResHeader);
    const decoded = JSON.parse(Buffer.from(settleResHeader, "base64").toString("utf-8")) as {
      success: boolean;
      transaction?: string;
    };
    expect(decoded.success).toBe(true);
    expect(decoded.transaction).toBe(facilitatorState.settleResponse.transaction);
    // The settlement rewrap builds a new Response; the identity must survive it.
    expectJobIdentity(retry, (await retry.json()) as { job_id?: unknown });
  });

  it("pays the same route as a v1-only client through X-PAYMENT", async () => {
    const challengeRes = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const body = (await challengeRes.json()) as {
      accepts: { maxAmountRequired: string; resource: string }[];
    };
    expect(body.accepts[0].resource).toBe(`${publicOrigin}/v1/job`);
    const payload = fakePaymentPayloadV1(body.accepts[0].maxAmountRequired, X402_PAY_TO);
    const retry = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": encodePayment(payload) },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    expect([200, 202]).toContain(retry.status);
    expect(facilitatorState.verifyCalls[0]).toMatchObject({
      paymentPayload: { x402Version: X402_V1_VERSION, network: "base" },
      paymentRequirements: {
        network: "base",
        maxAmountRequired: body.accepts[0].maxAmountRequired,
        resource: `${publicOrigin}/v1/job`,
      },
    });
    expect(Object.fromEntries(retry.headers.entries())).toEqual(
      expect.objectContaining({ "payment-response": expect.any(String) })
    );
    expect(retry.headers.get("X-PAYMENT-RESPONSE")).toBe(retry.headers.get("PAYMENT-RESPONSE"));
  });

  it("prefers PAYMENT-SIGNATURE when both request headers are present", async () => {
    const challengeRes = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const body = (await challengeRes.clone().json()) as {
      accepts: { maxAmountRequired: string }[];
    };
    const required = decodePaymentRequiredHeader(
      challengeRes.headers.get("PAYMENT-REQUIRED") ?? ""
    );
    const retry = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": encodePayment(fakePaymentPayloadV2(required)),
        "X-PAYMENT": encodePayment(
          fakePaymentPayloadV1(body.accepts[0].maxAmountRequired, X402_PAY_TO)
        ),
      },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });

    expect([200, 202]).toContain(retry.status);
    expect(facilitatorState.verifyCalls).toHaveLength(1);
    expect(facilitatorState.verifyCalls[0].paymentPayload.x402Version).toBe(X402_VERSION);
  });

  it("PAYMENT-SIGNATURE retry where facilitator rejects → 402 with fresh accepts", async () => {
    facilitatorState.verifyResponse = { isValid: false, invalidReason: "amount_too_low" };
    const challenge = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    const required = decodePaymentRequiredHeader(challenge.headers.get("PAYMENT-REQUIRED") ?? "");
    const payload = fakePaymentPayloadV2(required);
    const retry = await fetch(`${serverUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "PAYMENT-SIGNATURE": encodePayment(payload) },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(retry.status).toBe(402);
    const body = (await retry.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_invalid");
    expect(Array.isArray(body.accepts)).toBe(true);
    expect(retry.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
    expect(facilitatorState.settleCalls).toHaveLength(0);
  });
});

describe("DVMKIT_TEMPO_METHODS allowlist", () => {
  it("gates registered methods against the allowlist", () => {
    const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") };
    const mpp = createMppFromOpts(
      { tempoRecipient: TEMPO_RECIPIENT, methodsAllowlist: ["bogus"] },
      env
    );
    expect(mpp).toBeUndefined();
  });

  it("registers tempo when listed in the allowlist", () => {
    const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") };
    const mpp = createMppFromOpts(
      { tempoRecipient: TEMPO_RECIPIENT, methodsAllowlist: ["tempo"] },
      env
    );
    expect(mpp).toBeDefined();
    expect(mpp?.methods).toHaveLength(1);
  });

  it("registers tempo when allowlist is empty (treats as 'allow everything')", () => {
    const env = { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") };
    const mpp = createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT, methodsAllowlist: [] }, env);
    expect(mpp).toBeDefined();
    expect(mpp?.methods).toHaveLength(1);
  });
});

function exactHealth(exact: { v1: boolean; v2: boolean }): X402FacilitatorHealthLike {
  return {
    refresh: () => Promise.resolve(),
    support: () => ({
      available: exact.v1 || exact.v2,
      exact,
      batchSettlement: false,
      facilitator: "https://facilitator.test",
      network: "eip155:8453",
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});
