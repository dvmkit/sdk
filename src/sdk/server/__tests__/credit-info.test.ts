import { readFileSync } from "node:fs";

import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { Store } from "mppx";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer, type SDKServerOpts } from "../app";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import { LightningReceive } from "../lightning-receive";
import { MemoryJobStore } from "../memory-job-store";
import { MintHealthTracker } from "../mint-health-tracker";
import { createMppFromOpts } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "aa".repeat(32);
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-23T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

async function info(credit: boolean): Promise<Record<string, unknown>> {
  const ledger = durableLedger();
  await fundCredit(ledger, {
    creditId: "private-credit",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 2_000_000,
    expiryMs: Date.now() + 86_400_000,
  });
  const dvm = configureDVM({
    name: "credit-info",
    capability: "run",
    auth: secp256k1Auth(),
    ...(credit && { credit: { min: "$0.10", max: "$5.00" } }),
    onJob(ctx) {
      ctx.complete("done");
    },
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    creditLedger: ledger,
    mints: ["https://mint.example.com"],
    paymentMethods: ["cashu"],
    fxFetcher: stubFx,
  });
  return (await (await app.request("/v1/info")).json()) as Record<string, unknown>;
}

describe("prepaid credit on /v1/info", () => {
  it("advertises public terms for an opted-in container DVM", async () => {
    const body = await info(true);
    expect(body.credit).toMatchObject({
      min_micro: 100_000,
      max_micro: 5_000_000,
      ttl_ms: 7_776_000_000,
      currency: "usd",
      funding: ["cashu"],
    });
    const credit = body.credit as Record<string, unknown>;
    expect(credit).not.toHaveProperty("credit_id");
    expect(credit).not.toHaveProperty("balance_micro");
    expect(credit).not.toHaveProperty("remaining_micro");
    expect(credit).not.toHaveProperty("expiry_ms");
  });

  it("omits the block when the DVM did not opt in", async () => {
    expect(await info(false)).not.toHaveProperty("credit");
  });
});

const discoveryFixture = JSON.parse(readFileSync(
  new URL("../../../../protocol-fixtures/payment-method-discovery-v1.json", import.meta.url), "utf8"
)) as { cashu_only: { payment: { methods: string[] }; credit: { funding: string[] }; absent: string[] } };
const schema = z.object({
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
});
const signer = createSignedRequestVerifier(schema);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function discoveryServer(overrides: Partial<SDKServerOpts> = {}) {
  const mints = ["https://mint.example.com"];
  const server = await createDVMServer(configureDVM({
    name: "payment-discovery",
    capability: "run",
    input: schema,
    auth: secp256k1Auth(),
    price: "$0.10",
    credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true },
    onJob(ctx) { ctx.complete("done"); },
  }), {
    env: {}, store: new MemoryKVStore(), jobStore: new MemoryJobStore(),
    creditLedger: durableLedger(), fxFetcher: stubFx,
    mints, mintHealthTracker: new MintHealthTracker({ mints, env: {} }),
    cashuMode: "p2pk-accumulator", lockPubkey: `02${"11".repeat(32)}`,
    disposableCashu: createDisposableCashuStore().accumulator,
    x402: {
      payTo: "0x1111111111111111111111111111111111111111", network: "eip155:84532",
      batchSettlement: {
        storage: new InMemoryChannelStorage(), autoSettlement: false,
        facilitatorClient: {
          verify: vi.fn(), settle: vi.fn(),
          getSupported: async () => ({
            kinds: [{ x402Version: 2, scheme: "batch-settlement", network: "eip155:84532",
              extra: { receiverAuthorizer: "0x2222222222222222222222222222222222222222" } }],
            extensions: [], signers: {},
          }),
        },
      },
    },
    mpp: createMppFromOpts({ tempoRecipient: "0x1111111111111111111111111111111111111111" },
      { DVMKIT_TEMPO_SECRET_KEY: "33".repeat(32) }),
    ...overrides,
  });
  closers.push(server.shutdown);
  return server.app;
}

describe("explicit payment methods across discovery surfaces", () => {
  it("keeps a Cashu-only DVM's info, quote, and unpaid job menu within its declared rails", async () => {
    const app = await discoveryServer({ paymentMethods: ["cashu"] });
    const responses = [await app.request("/v1/info")];
    for (const path of ["/v1/quote", "/v1/job"]) {
      const response = await app.request(path, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "run", data: signer.signRequest(new Uint8Array(32).fill(7), {}) }),
      });
      expect(response.status).toBe(path === "/v1/job" ? 402 : 200);
      responses.push(response);
    }
    for (const response of responses) {
      const body = await response.json();
      expect.soft(body.credit).toMatchObject(discoveryFixture.cashu_only.credit);
      for (const key of discoveryFixture.cashu_only.absent) {
        expect.soft(body).not.toHaveProperty(key);
        expect.soft(body.credit).not.toHaveProperty(key);
      }
      if (response.status === 200) {
        expect(body.payment).toMatchObject(discoveryFixture.cashu_only.payment);
      }
    }
  });

  it("treats an empty override as excluding all per-call rails and their credit terms", async () => {
    const app = await discoveryServer({ paymentMethods: [] });
    const body = await (await app.request("/v1/info")).json();
    expect(body.payment.methods).toEqual([]);
    expect(body.credit.funding).toEqual([]);
    for (const key of ["x402", "tempo"]) {
      expect(body).not.toHaveProperty(key);
      expect(body.credit).not.toHaveProperty(key);
    }
  });

  it("preserves derived defaults and batch credit funding when the override is omitted", async () => {
    const app = await discoveryServer();
    const body = await (await app.request("/v1/info")).json();
    expect(body.payment.methods).toEqual(["cashu", "x402", "tempo"]);
    expect(body.credit.funding).toEqual(["cashu", "x402", "tempo"]);
    expect(body.x402).toMatchObject({ network: "eip155:84532", dual_serve: true });
    expect(body.credit.x402.schemes).toEqual([
      { scheme: "exact", network: "eip155:84532" },
      { scheme: "batch-settlement", network: "eip155:84532" },
    ]);
    expect(body.tempo.methods).toEqual([{ method: "tempo", intent: "charge" }]);
    expect(body.credit.tempo.methods).toEqual([{ method: "tempo", intent: "charge" }]);
  });

  it.each([
    [undefined, true], [["x402"], true], [["cashu"], false],
  ] satisfies [SDKServerOpts["paymentMethods"], boolean][])(
    "keeps batch funding independent of hosted exact health while respecting override %j", async (methods, batchAllowed) => {
      const app = await discoveryServer({
        ...(methods !== undefined && { paymentMethods: [...methods] }),
        x402FacilitatorHealth: {
          refresh: async () => undefined,
          support: () => ({
            available: false, exact: { v1: false, v2: false }, batchSettlement: true,
            facilitator: "https://facilitator.example.com", network: "eip155:84532",
          }),
        },
      });
      const body = await (await app.request("/v1/info")).json();
      expect(body.payment.methods).not.toContain("x402");
      expect(body).not.toHaveProperty("x402");
      if (!batchAllowed) {
        expect(body.credit.funding).toEqual(["cashu"]);
        expect(body.credit).not.toHaveProperty("x402");
      } else {
        expect(body.credit.funding).toContain("x402");
        expect(body.credit.x402.schemes).toEqual([{ scheme: "batch-settlement", network: "eip155:84532" }]);
      }
    }
  );

  it.each([false, true])("publishes withheld Tempo session terms only when Tempo is allowed (%s)", async (tempoAllowed) => {
    const app = await discoveryServer({
      paymentMethods: tempoAllowed ? ["cashu", "tempo"] : ["cashu"],
      mpp: createMppFromOpts({
        tempoRecipient: "0x1111111111111111111111111111111111111111",
        tempoSession: { store: Store.memory(), account: privateKeyToAccount(`0x${"44".repeat(32)}`) },
      }, { DVMKIT_TEMPO_SECRET_KEY: "33".repeat(32) }),
      tempoObserverHealth: { available: () => false },
    });
    const body = await (await app.request("/v1/info")).json();
    if (tempoAllowed) {
      const withheld = [{ method: "tempo", intent: "session", reason: "observer_unhealthy" }];
      expect(body.tempo.withheld).toEqual(withheld);
      expect(body.credit.tempo.withheld).toEqual(withheld);
    } else {
      expect.soft(body).not.toHaveProperty("tempo");
      expect.soft(body.credit).not.toHaveProperty("tempo");
    }
  });

  it("keeps receive-only Lightning funding independent of an empty override", async () => {
    const unused = vi.fn().mockRejectedValue(new Error("unexpected wallet operation"));
    const lightningReceive = await LightningReceive.create({
      backend: { getInfo: unused, getBalance: unused, createInvoice: unused,
        lookupInvoice: unused, payInvoice: unused },
    });
    const app = await discoveryServer({ paymentMethods: [], lightningReceive });
    const body = await (await app.request("/v1/info")).json();
    expect(body.payment.methods).toEqual([]);
    expect(body.credit.funding).toEqual(["lightning"]);
    expect(body.credit.lightning_min_micro).toBeGreaterThan(0);
  });
});
