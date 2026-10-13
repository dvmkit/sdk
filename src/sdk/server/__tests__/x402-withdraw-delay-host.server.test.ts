import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const PAY_TO = `0x${"11".repeat(20)}`;
const AUTHORIZER_KEY = `0x${"22".repeat(32)}`;
const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function startHost(network: string, delay?: string) {
  const host = createDVMHost({
    devMode: true, port: 0,
    fx: {
      fetch: async () => ({ rates: { usd: 100_000 }, as_of: "2026-09-01T00:00:00Z" }),
      supportedCurrencies: () => ["usd"],
    },
    env: {
      DVMKIT_X402_PAY_TO: PAY_TO,
      DVMKIT_X402_NETWORK: network,
      DVMKIT_X402_BATCH_SETTLEMENT: "true",
      DVMKIT_X402_RECEIVER_AUTHORIZER_KEY: AUTHORIZER_KEY,
      ...(delay === undefined ? {} : { DVMKIT_X402_WITHDRAW_DELAY_SECONDS: delay }),
      ...(network === "eip155:8453" ? {
        DVMKIT_X402_SELF_RELAY_KEY: `0x${"33".repeat(32)}`,
        DVMKIT_X402_RPC_URL: "https://rpc.example.invalid",
      } : {}),
    },
  });
  host.mount(configureDVM({
    name: "withdraw-delay", capability: "test", price: "$0.10",
    credit: { min: "$0.10", max: "$5.00" }, auth: secp256k1Auth(),
    onJob(ctx) { ctx.complete("ok"); },
  }));
  return host;
}

function stubExternalCalls(network: string) {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:")) {
      return originalFetch(input, init);
    }
    if (url.endsWith("/supported")) {
      return Response.json({ kinds: [
        { x402Version: 2, scheme: "exact", network },
        { x402Version: 2, scheme: "batch-settlement", network },
      ], extensions: [], signers: {} });
    }
    if (url.startsWith("https://rpc.example.invalid")) {
      const request = JSON.parse(init?.body as string) as { id: number };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: "0x38d7ea4c68000" });
    }
    return Response.json({}, { status: 503 });
  });
}

describe("host environment withdrawal delay", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

  it.each([
    ["eip155:84532", "900", 900],
    ["eip155:84532", undefined, 86_400],
    ["eip155:8453", undefined, 86_400],
  ])("advertises %s delay %s on the actual unpaid credit response", async (network, delay, expected) => {
    // An explicit host environment must not inherit a shorter ambient setting.
    vi.stubEnv("DVMKIT_X402_WITHDRAW_DELAY_SECONDS", "900");
    stubExternalCalls(network);
    const server = await startHost(network, delay).serve();
    try {
      const response = await fetch(`${server.url}/v1/credit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signer.signRequest(new Uint8Array(32).fill(9), {
          op: "fund",
          fund: { amount_micro: 100_000, fund_id: "delay-fund", commitment: "ab".repeat(32) },
        })),
      });
      expect(response.status).toBe(402);
      const required = response.headers.get("PAYMENT-REQUIRED");
      expect(required).not.toBeNull();
      const body = JSON.parse(Buffer.from(required!, "base64").toString()) as { accepts: unknown[] };
      expect(body.accepts).toContainEqual(expect.objectContaining({
        scheme: "batch-settlement", network,
        extra: expect.objectContaining({ withdrawDelay: expected }),
      }));
    } finally { await server.close(); }
  });

  it.each([
    ["eip155:84532", "899", "at least 900 seconds"],
    ["eip155:84532", "900.5", "must be a non-negative integer"],
    ["eip155:84532", "NaN", "must be a non-negative integer"],
    ["eip155:84532", "Infinity", "must be a non-negative integer"],
    ["eip155:8453", "900", "at least 86400 seconds"],
    ["eip155:8453", "86399", "at least 86400 seconds"],
  ])("refuses %s environment delay %s even in development mode", async (network, delay, message) => {
    stubExternalCalls(network);
    await expect(startHost(network, delay).serve()).rejects.toThrow(message);
  });
});
