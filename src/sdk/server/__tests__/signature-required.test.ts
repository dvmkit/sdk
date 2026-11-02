import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import signatureRequired from "../../../../protocol-fixtures/signature-required-v1.json";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";

const schema = z.object({
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
  text: z.string(),
});
const hosts: Awaited<ReturnType<typeof createDVMServer>>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.shutdown()));
});

async function host(opts: { cashu?: boolean; skipPayment?: boolean; plainSchema?: boolean } = {}) {
  const onJob = vi.fn();
  const auth = secp256k1Auth({ allowUnsignedPaid: true, replayStore: null });
  const server = await createDVMServer(configureDVM({
    name: "signature-required",
    auth,
    capabilities: {
      free: { input: schema, onJob },
      paid: { input: opts.plainSchema === false ? schema.transform(value => value) : schema, price: "$0.01", onJob },
      quoted: {
        input: schema,
        onQuote: { schema: z.object({ text: z.string() }), handler: async () => ({ upfront: { amount: 0, currency: "usd" as const }, description: "free quote" }) },
        onJob,
      },
    },
  }), {
    env: {}, devMode: true, store: new MemoryKVStore(), jobStore: new MemoryJobStore(),
    fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
    ...(opts.cashu ? {
      mints: ["https://mint.example.com"], cashuMode: "p2pk-accumulator" as const,
      lockPubkey: `02${"11".repeat(32)}`, disposableCashu: createDisposableCashuStore().accumulator,
    } : opts.skipPayment ? {} : { mints: [] }),
  });
  hosts.push(server);
  return { ...server, auth, onJob };
}

function post(app: Awaited<ReturnType<typeof host>>["app"], path: string, capability: string, legacy = false) {
  const data = { text: "hello" };
  return app.request(path, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability, ...(legacy ? { input: JSON.stringify(data) } : { data }) }),
  });
}

describe("signature requirements on a DVM allowing unsigned paid calls", () => {
  it("requires signing for a free call even when a custom auth checker accepts its body", async () => {
    const server = await host({ cashu: true });
    vi.spyOn(server.auth, "checkAuth").mockReturnValue({
      pubkey: "11".repeat(32),
      envelope: { pubkey: "11".repeat(32), signature: "22".repeat(64), timestamp: 0, nonce: "example-nonce" },
    });
    const response = await post(server.app, "/v1/job", "free");
    expect(response.status).toBe(signatureRequired.status);
    expect(await response.json()).toEqual(signatureRequired.body);
    expect(server.onJob).not.toHaveBeenCalled();
  });

  it.each([
    ["free", { cashu: true }],
    ["quoted", { cashu: true }],
    ["paid", { cashu: false }],
    ["paid", { skipPayment: true }],
    ["paid", { cashu: true, plainSchema: false }],
  ] as const)("refuses unsigned %s before execution (%#)", async (capability, options) => {
    const server = await host(options);
    for (const legacy of [false, true]) {
      const response = await post(server.app, "/v1/job", capability, legacy);
      expect(response.status).toBe(signatureRequired.status);
      expect(await response.json()).toEqual(signatureRequired.body);
    }
    expect(server.onJob).not.toHaveBeenCalled();
  });

  it("still offers an unsigned paid submit a 402 while quotes require signing", async () => {
    const server = await host({ cashu: true });
    const submit = await post(server.app, "/v1/job", "paid");
    expect(submit.status).toBe(402);
    expect(await submit.json()).toMatchObject({ error: "payment_required", required_msats: 10_000 });
    const quote = await post(server.app, "/v1/quote", "paid");
    expect(quote.status).toBe(signatureRequired.status);
    expect(await quote.json()).toEqual(signatureRequired.body);
    expect(server.onJob).not.toHaveBeenCalled();
  });
});
