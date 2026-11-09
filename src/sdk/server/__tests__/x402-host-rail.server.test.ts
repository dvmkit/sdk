import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { decodePaymentRequiredHeader } from "../../../lib/x402/spec";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "x402_host_rail_test";
const PAY_TO = "0x1111111111111111111111111111111111111111";
const FACILITATOR = "https://facilitator.example.com";

afterEach(() => { vi.restoreAllMocks(); });

describe.skipIf(!RUN)("host environment x402 rail", () => {
  it("offers the environment's payTo on an unpaid x402 channel request without a descriptor rail", async () => {
    const descriptor = configureDVM({
      name: "host-rail",
      capabilities: {
        fetch: {
          input: z.object({ url: z.string().url() }),
          channels: { job: false, x402: {} },
          price: "$0.01",
          maxRuntimeSeconds: 5,
          onJob(ctx) { ctx.complete("done"); },
        },
      },
    });
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `${FACILITATOR}/supported`) {
        return Promise.resolve(Response.json({
          kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }],
          extensions: [],
          signers: {},
        }));
      }
      return originalFetch(input, init);
    });
    await recreateSchema(SCHEMA);
    const pool = await pinnedPool(SCHEMA);
    let server: { url: string; close(): Promise<void> } | undefined;
    try {
      const host = createDVMHost({
        port: 0,
        pool,
        env: {
          DVMKIT_PUBLIC_URL: "https://dvm.example.com",
          DVMKIT_X402_PAY_TO: PAY_TO,
          DVMKIT_X402_NETWORK: "eip155:8453",
          DVMKIT_X402_FACILITATOR: FACILITATOR,
        },
      });
      host.mount(descriptor);
      server = await host.serve();
      const response = await fetch(`${server.url}/v1/x402/fetch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(response.status).toBe(402);
      const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED")!);
      expect(required.accepts).toMatchObject([{ payTo: PAY_TO, network: "eip155:8453", amount: "10000" }]);
    } finally {
      await server?.close();
      await pool.end();
      await dropSchemas(SCHEMA);
    }
  });
});
