import { afterEach, describe, expect, it } from "vitest";

import { configureDVM } from "../src/sdk/configure";
import { createDVMServer } from "../src/sdk/server/app";
import { createDisposableCashuStore } from "../src/sdk/server/disposable-cashu-store";
import { MemoryJobStore } from "../src/sdk/server/memory-job-store";
import { MintHealthTracker } from "../src/sdk/server/mint-health-tracker";
import { MemoryKVStore } from "../src/sdk/store";

const origin = "https://wallet.example.com";
const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("public route CORS", () => {
  it.each([
    ["GET", "/v1/info"],
    ["POST", "/v1/quote"],
    ["POST", "/v1/job"],
    ["GET", "/v1/job/example"],
    ["GET", "/v1/job/example/messages"],
    ["POST", "/v1/job/example/messages"],
    ["DELETE", "/v1/job/example"],
    ["POST", "/v1/credit"],
    ["POST", "/v1/request-resume/example"],
    ["POST", "/v1/request-result/example"],
  ])("allows a production browser preflight for %s %s", async (method, path) => {
    const app = await productionApp();
    const requestedHeaders = "content-type,x-cashu,x-cashu-request-id,x-job-token,authorization";
    const response = await app.request(path, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": method,
        "Access-Control-Request-Headers": requestedHeaders,
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Methods")?.split(",")).toContain(method);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(requestedHeaders);
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Cashu");
    expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
  });

  it("exposes the production unpaid Cashu challenge and public route errors", async () => {
    const app = await productionApp();
    const unpaid = await app.request("/v1/job", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "echo", data: {} }),
    });
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("X-Cashu")).toMatch(/^creqA/);

    const info = await app.request("/v1/info", { headers: { Origin: origin } });
    expect(info.status).toBe(200);
    const missing = await app.request("/v1/job/missing", { headers: { Origin: origin } });
    expect(missing.status).toBe(401);
    for (const response of [unpaid, info, missing]) {
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Cashu");
      expect(response.headers.has("Access-Control-Allow-Credentials")).toBe(false);
    }
  });

  it.each([false, true])("keeps admin, internal, and health routes private with devMode=%s", async (devMode) => {
    const app = await productionApp(devMode);
    for (const path of ["/admin/credit/pending-drains", "/_internal/tempo-close-event", "/_hosting/control", "/health", "/healthz"]) {
      for (const method of ["OPTIONS", "GET", "POST"]) {
        const response = await app.request(path, {
          method,
          headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
        });
        expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual([]);
      }
    }
  });
});

async function productionApp(devMode = false) {
  const mints = ["https://mint.example.com"];
  const server = await createDVMServer(configureDVM({
    name: "public-cors",
    capability: "echo",
    price: "$0.016",
    onJob(ctx) { ctx.complete("done"); },
  }), {
    env: {},
    dvmId: "cors-test-dvm",
    devMode,
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    paymentMethods: ["cashu"],
    cashuMode: "p2pk-accumulator",
    lockPubkey: "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    disposableCashu: createDisposableCashuStore().accumulator,
    mints,
    mintHealthTracker: new MintHealthTracker({ mints, env: {} }),
    fxFetcher: {
      fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
      supportedCurrencies: () => ["usd"],
    },
  });
  closers.push(server.shutdown);
  return server.app;
}
