import { randomBytes } from "node:crypto";

import { Store } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import type { FxFetcher } from "../pricing/index";
import { durableLedger } from "../server/__tests__/__helpers__/credit-fixtures";
import { createDVMServer } from "../server/app";
import { MemoryJobStore } from "../server/memory-job-store";
import {
  advertisedMethods,
  createMppFromOpts,
  resolveTempoNetwork,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_MODERATO_CHAIN_ID,
  TEMPO_PATH_USD_MODERATO,
  TEMPO_USDC_MAINNET,
} from "../server/mpp-setup";
import { secp256k1Auth } from "../server/secp256k1-auth";
import { MemoryKVStore } from "../store";

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";

/** A pinned rate, so the mid-job challenge's amount never reaches the network. */
const STUB_FX: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const STUB_MULTI_FX: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000, eur: 90_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd", "eur"],
};

function mppEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex"), ...extra };
}

describe("payment methods advertisement", () => {
  const servers = servedApps({ teardown: "all" });
  let url: string;

  const dvm = configureDVM({
    name: "Payment Methods Test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });

  beforeAll(async () => {
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
    });

    url = await servers.serve(app);
  });

  it("advertises an empty list when no rails are wired", async () => {
    const res = await fetch(`${url}/v1/info`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect((data.payment as { methods?: string[] } | undefined)?.methods).toEqual([]);
    expect(data.x402).toBeUndefined();
    expect(data.tempo).toBeUndefined();
  });
});

describe("payment methods derived from configured rails", () => {
  const servers = servedApps();
  const dvm = configureDVM({
    name: "Derivation Test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });

  async function startServer(opts: Parameters<typeof createDVMServer>[1]): Promise<string> {
    const { app } = await createDVMServer(dvm, opts);
    return servers.serve(app);
  }

  it("combines all wired rails", async () => {
    const url = await startServer({
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      mints: ["https://mint.example.com"],
      cashuMode: "p2pk-accumulator",
      lockPubkey: "02" + "ab".repeat(32),
      db: {} as never,
      x402: { payTo: "0xabc", network: "eip155:8453" },
      mpp: createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT }, mppEnv()),
    });
    const res = await fetch(`${url}/v1/info`);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.mints).toEqual(["https://mint.example.com"]);
    expect((data.payment as { methods?: string[] } | undefined)?.methods).toEqual([
      "cashu",
      "x402",
      "tempo",
    ]);
  });

  it("respects an explicit paymentMethods override", async () => {
    const url = await startServer({
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      paymentMethods: ["x402"],
      mints: ["https://mint.example.com"],
    });
    const res = await fetch(`${url}/v1/info`);
    const data = (await res.json()) as Record<string, unknown>;
    expect((data.payment as { methods?: string[] } | undefined)?.methods).toEqual(["x402"]);
  });

  // Mid-job challenges must use the derived rails, even without an explicit methods option.
  it("offers the derived rails on a mid-job ask, not just on /v1/info", async () => {
    const metered = configureDVM({
      name: "Mid-job Derivation Test",
      capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(2_000, "metered work");
        ctx.complete("done");
      },
    });
    const { app, jobManager } = await createDVMServer(metered, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      // Deliberately no `paymentMethods` — both rails are wired and nothing
      // names them, which is exactly how a real DVM is configured.
      x402: { payTo: "0xabc", network: "eip155:8453" },
      mpp: createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT }, mppEnv()),
      fxFetcher: STUB_FX,
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
        const content = request?.content as
          | { x402?: { pay_to?: string }; tempo?: { challenges?: { method?: string }[] } }
          | undefined;
        expect(content?.x402?.pay_to).toBe("0xabc");
        expect(content?.tempo?.challenges?.map((c) => c.method)).toEqual(["tempo"]);
        expect(job?.pendingMppChallengeIds).toHaveLength(1);
      });
    } finally {
      jobManager.shutdown();
    }
  });
});

describe("x402 payment method advertisement", () => {
  const servers = servedApps({ teardown: "all" });
  let url: string;

  const dvm = configureDVM({
    name: "x402 Test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done");
    },
  });

  beforeAll(async () => {
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      paymentMethods: ["cashu", "x402"],
      x402: { payTo: "0x1234", network: "eip155:8453", asset: "USDC" },
    });

    url = await servers.serve(app);
  });

  it("advertises x402 config in /v1/info", async () => {
    const res = await fetch(`${url}/v1/info`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect((data.payment as { methods?: string[] } | undefined)?.methods).toEqual([
      "cashu",
      "x402",
    ]);
    expect(data.x402).toEqual({
      pay_to: "0x1234",
      network: "eip155:8453",
      asset: "USDC",
      dual_serve: true,
    });
  });
});

describe("x402 on a non-USD DVM", () => {
  const servers = servedApps();

  function eurDvm(onJob: Parameters<typeof configureDVM>[0]["onJob"]) {
    return configureDVM({
      name: "EUR x402 Test",
      capability: "test",
      currency: "eur",
      input: z.object({ value: z.string() }),
      onQuote: {
        schema: z.object({ value: z.string() }),
        async handler() {
          return { upfront: { amount: 0.1, currency: "eur" }, description: "test" };
        },
      },
      onJob,
    });
  }

  it("omits x402 from discovery, quotes, and the upfront 402", async () => {
    const { app } = await createDVMServer(
      eurDvm(async (ctx) => {
        ctx.complete("done");
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        x402: { payTo: "0x1234", network: "eip155:8453", asset: "USDC" },
        fxFetcher: STUB_MULTI_FX,
      }
    );
    const url = await servers.serve(app);

    const info = (await (await fetch(`${url}/v1/info`)).json()) as {
      payment?: { methods?: string[] };
      x402?: unknown;
    };
    expect(info.payment?.methods).not.toContain("x402");
    expect(info.x402).toBeUndefined();

    const quote = await fetch(`${url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", data: { value: "hello" } }),
    });
    const quoted = (await quote.json()) as { payment?: { methods?: string[] } };
    expect(quoted.payment?.methods).not.toContain("x402");

    const response = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: JSON.stringify({ value: "hello" }) }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(402);
    expect(body.accepts).toBeUndefined();
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();

    const presented = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-PAYMENT": "stale-x402-credential",
      },
      body: JSON.stringify({ capability: "test", input: JSON.stringify({ value: "hello" }) }),
    });
    const refusal = (await presented.json()) as { error?: string; retryable?: boolean };
    expect(presented.status).toBe(402);
    expect(refusal).toMatchObject({ error: "x402_not_offered", retryable: false });
    expect(presented.headers.get("PAYMENT-REQUIRED")).toBeNull();
  });

  it("omits x402 from a mid-job request even when the handler explicitly supplies it", async () => {
    const dvm = configureDVM({
      name: "EUR mid-job x402 Test",
      capability: "test",
      currency: "eur",
      async onJob(ctx) {
        await ctx.requestPayment(2_000, "metered work", {
          x402: { pay_to: "0x1234", network: "eip155:8453", asset: "USDC" },
        });
        ctx.complete("done");
      },
    });
    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      paymentMethods: ["x402"],
      x402: { payTo: "0x1234", network: "eip155:8453", asset: "USDC" },
      fxFetcher: STUB_MULTI_FX,
    });

    try {
      const response = await app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      const { job_id: jobId } = (await response.json()) as { job_id: string };

      await vi.waitFor(() => {
        const job = jobManager.activeJobs.get(jobId);
        const request = job?.messages.find((message) => message.type === "payment-request");
        expect(request?.content.x402).toBeUndefined();
        expect(job?.pendingX402Nonce).toBeUndefined();
        expect(job?.pendingX402AmountUsdcMicro).toBeUndefined();
      });
    } finally {
      jobManager.shutdown();
    }
  });
});

describe("MPP payment method advertisement", () => {
  const servers = servedApps();

  it("registers charge and reusable session intents when durable session wiring is present", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mpp = createMppFromOpts(
      {
        tempoRecipient: TEMPO_RECIPIENT,
        tempoSession: { store: Store.memory(), account },
      },
      mppEnv()
    );
    expect(mpp && advertisedMethods(mpp)).toEqual([
      { method: "tempo", intent: "charge" },
      { method: "tempo", intent: "session" },
    ]);
  });

  it("advertises method/intent pairs and the realm in /v1/info", async () => {
    const dvm = configureDVM({
      name: "MPP Test",
      capability: "test",
      price: "$0.10",
      async onJob(ctx) {
        ctx.complete("done");
      },
    });

    const realm = "test.dvmkit.example";
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      paymentMethods: ["cashu", "tempo"],
      mpp: createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT, realm }, mppEnv()),
    });

    const serverUrl = await servers.serve(app);
    const res = await fetch(`${serverUrl}/v1/info`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect((data.payment as { methods?: string[] } | undefined)?.methods).toEqual([
      "cashu",
      "tempo",
    ]);
    expect(data.tempo).toEqual({
      methods: [{ method: "tempo", intent: "charge" }],
      realm,
      recipient: TEMPO_RECIPIENT,
      payment_token: TEMPO_USDC_MAINNET,
      chain_id: TEMPO_MAINNET_CHAIN_ID,
    });
  });

  it("keeps charge-only Tempo per-call while omitting it from prepaid credit", async () => {
    const signedInput = z.object({
      pubkey: z.string(),
      signature: z.string(),
      timestamp: z.number(),
      nonce: z.string(),
    });
    const dvm = configureDVM({
      name: "MPP Credit Test",
      capability: "test",
      input: signedInput,
      price: "$0.10",
      auth: secp256k1Auth(),
      credit: { min: "$0.10", max: "$5.00" },
      async onJob(ctx) {
        ctx.complete("done");
      },
    });
    const realm = "credit.dvmkit.example";
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      devMode: true,
      creditLedger: durableLedger(),
      mpp: createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT, realm }, mppEnv()),
    });
    const url = await servers.serve(app);
    const data = (await (await fetch(`${url}/v1/info`)).json()) as {
      payment?: { methods?: string[] };
      credit?: { funding?: string[]; tempo?: { methods?: unknown[] } };
    };
    expect(data.payment?.methods).toContain("tempo");
    expect(data.credit?.funding).not.toContain("tempo");
    expect(data.credit?.tempo).toBeUndefined();
  });

  it("advertises the exact public session participants and assets resolved by the server", async () => {
    const dvm = configureDVM({
      name: "MPP Session Binding Test",
      capability: "test",
      price: "$0.10",
      async onJob(ctx) {
        ctx.complete("done");
      },
    });
    const account = privateKeyToAccount(generatePrivateKey());
    const paymentToken = "0x1111111111111111111111111111111111111111";
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      mpp: createMppFromOpts(
        {
          tempoRecipient: TEMPO_RECIPIENT,
          tempoSession: { store: Store.memory(), account },
        },
        mppEnv({ DVMKIT_TEMPO_CURRENCY: paymentToken })
      ),
    });

    const response = await app.request("/v1/info");
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      tempo?: Record<string, unknown>;
    };
    expect(data.tempo).toMatchObject({
      recipient: TEMPO_RECIPIENT,
      payment_token: paymentToken,
      operator: account.address,
      fee_token: paymentToken,
      chain_id: TEMPO_MAINNET_CHAIN_ID,
    });
  });
});

describe("Tempo network selection", () => {
  it.each([
    [{}, TEMPO_MAINNET_CHAIN_ID, TEMPO_USDC_MAINNET, false],
    [
      { DVMKIT_TEMPO_TESTNET: "true" },
      TEMPO_MODERATO_CHAIN_ID,
      TEMPO_PATH_USD_MODERATO,
      true,
    ],
    [
      { DVMKIT_TEMPO_TESTNET: "1", DVMKIT_TEMPO_CHAIN_ID: "4217" },
      TEMPO_MAINNET_CHAIN_ID,
      TEMPO_USDC_MAINNET,
      true,
    ],
    [
      {
        DVMKIT_TEMPO_CHAIN_ID: String(TEMPO_MODERATO_CHAIN_ID),
        DVMKIT_TEMPO_CURRENCY: "0x1111111111111111111111111111111111111111",
      },
      TEMPO_MODERATO_CHAIN_ID,
      "0x1111111111111111111111111111111111111111",
      false,
    ],
    [
      {
        DVMKIT_TEMPO_TESTNET: "true",
        DVMKIT_TEMPO_CHAIN_ID: String(TEMPO_MAINNET_CHAIN_ID),
        DVMKIT_TEMPO_CURRENCY: "0x2222222222222222222222222222222222222222",
      },
      TEMPO_MAINNET_CHAIN_ID,
      "0x2222222222222222222222222222222222222222",
      true,
    ],
  ])("resolves env %#", (env, chainId, currency, testnet) => {
    expect(resolveTempoNetwork(env)).toEqual({ chainId, currency, testnet });
  });

  it.each(["0", "-1", "1.5", "not-a-chain"])("rejects invalid chain id %s", (chainId) => {
    expect(() => resolveTempoNetwork({ DVMKIT_TEMPO_CHAIN_ID: chainId })).toThrow(
      `DVMKIT_TEMPO_CHAIN_ID must be a positive safe integer; got '${chainId}'.`
    );
  });

  it("rejects unsupported Tempo chains", () => {
    expect(() => resolveTempoNetwork({ DVMKIT_TEMPO_CHAIN_ID: "999" })).toThrow(
      `DVMKIT_TEMPO_CHAIN_ID must be ${TEMPO_MAINNET_CHAIN_ID} (mainnet) or ${TEMPO_MODERATO_CHAIN_ID} (Moderato); got '999'.`
    );
  });

  it.each([[TEMPO_MODERATO_CHAIN_ID, TEMPO_USDC_MAINNET]])(
    "rejects the known incompatible chain %s and asset %s",
    (chainId, currency) => {
    expect(() =>
      resolveTempoNetwork({
        DVMKIT_TEMPO_CHAIN_ID: String(chainId),
        DVMKIT_TEMPO_CURRENCY: currency,
      })
    ).toThrow(`DVMKIT_TEMPO_CURRENCY ${currency} is incompatible with DVMKIT_TEMPO_CHAIN_ID ${chainId}.`);
    }
  );

  it("pins charge and session to the same Moderato chain", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const mpp = createMppFromOpts(
      {
        tempoRecipient: TEMPO_RECIPIENT,
        tempoSession: {
          store: Store.memory(),
          account,
        },
      },
      mppEnv({ DVMKIT_TEMPO_TESTNET: "true" })
    );
    expect(mpp?.tempoConfiguration).toMatchObject({
      chainId: TEMPO_MODERATO_CHAIN_ID,
      paymentToken: TEMPO_PATH_USD_MODERATO,
    });
    const challenge = await mpp?.issueChallenge("tempo", "charge", { amount: "1" });
    expect((challenge?.request.methodDetails as { chainId?: number }).chainId).toBe(
      TEMPO_MODERATO_CHAIN_ID
    );
    expect(challenge?.request.currency).toBe(TEMPO_PATH_USD_MODERATO);
    const sessionChallenge = await mpp?.issueChallenge("tempo", "session", { amount: "1" });
    expect((sessionChallenge?.request.methodDetails as { chainId?: number }).chainId).toBe(
      TEMPO_MODERATO_CHAIN_ID
    );
    expect(sessionChallenge?.request.currency).toBe(TEMPO_PATH_USD_MODERATO);
  });

  it("rejects a session chain that disagrees with the configured charge chain", () => {
    const account = privateKeyToAccount(generatePrivateKey());
    expect(() =>
      createMppFromOpts(
        {
          tempoRecipient: TEMPO_RECIPIENT,
          tempoSession: {
            store: Store.memory(),
            account,
            chainId: TEMPO_MAINNET_CHAIN_ID,
          },
        },
        mppEnv({ DVMKIT_TEMPO_TESTNET: "true" })
      )
    ).toThrow(
      `Tempo session chain ${TEMPO_MAINNET_CHAIN_ID} does not match the configured Tempo chain ${TEMPO_MODERATO_CHAIN_ID}.`
    );
  });
});

describe("payment message validation", () => {
  const servers = servedApps({ teardown: "all" });
  let url: string;
  let jobId: string;
  let jobToken: string | undefined;

  const dvm = configureDVM({
    name: "Validation Test",
    capability: "test",
    async onJob(ctx) {
      await ctx.requestPayment(1000, "test payment");
      ctx.complete("paid");
    },
  });

  beforeAll(async () => {
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
    });

    url = await servers.serve(app);

    const jobRes = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "test" }),
    });
    const jobData = (await jobRes.json()) as { job_id: string; job_token?: string };
    jobId = jobData.job_id;
    jobToken = jobData.job_token;
    await new Promise((r) => setTimeout(r, 50));
  });

  it("rejects payment messages without any payment proof", async () => {
    const res = await fetch(`${url}/v1/job/${jobId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jobToken ? { "X-Job-Token": jobToken } : {}),
      },
      body: JSON.stringify({ type: "payment", content: { amount_msats: 1000 } }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string; message: string };
    expect(data.error).toBe("invalid_message");
    expect(data.message).toContain("x402_payment");
    expect(data.message).toContain("tempo_credential");
  });
});
