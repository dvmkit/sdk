/*
 * An upfront exact x402 payment on /v1/job is verified and settled before the
 * job runs. What the server sends the facilitator must name the server's own
 * resource, whatever the caller put in its payment: a catalog lists the
 * resource from the payload the facilitator receives.
 */
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { decodePaymentRequiredHeader, encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "x402_upfront_exact_payload_test";
const TRANSACTION = `0x${"77".repeat(32)}`;
const X402: X402Config = {
  facilitator: "https://facilitator.example.com",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

/** A chain RPC that is at block 100 and answers nothing else. */
function chainRpcAnswer(body: unknown): Response {
  const parsed = JSON.parse(typeof body === "string" ? body : "{}") as { id?: number };
  return Response.json({ jsonrpc: "2.0", id: parsed.id, result: "0x64" });
}

describe.skipIf(!RUN)("upfront exact x402 facilitator payload (Postgres)", () => {
  const servers = servedApps();
  const shutdowns: Array<() => Promise<void>> = [];
  let pool: Pool;
  let sent: { path: string; paymentPayload: Record<string, unknown> }[];

  beforeEach(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
    sent = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (url.startsWith(`${X402.facilitator}/`)) {
        const body = JSON.parse(String(init?.body)) as { paymentPayload: Record<string, unknown> };
        sent.push({ path: new URL(url).pathname, paymentPayload: body.paymentPayload });
        return url.endsWith("/verify")
          ? Response.json({ isValid: true })
          : Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
      }
      if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) return chainRpcAnswer(init?.body);
      return realFetch(request, init);
    });
  });

  afterEach(async () => {
    await servers.closeAll();
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await pool?.end();
    await dropSchemas(SCHEMA);
    vi.restoreAllMocks();
  });

  async function start(): Promise<string> {
    const jobs = new PostgresJobStore(pool);
    const ledger = new CreditLedger(pool);
    const payments = new PostgresProcessedPaymentStore(pool);
    await Promise.all([jobs.init(), ledger.init(), payments.init()]);
    const descriptor = configureDVM({
      name: "upfront-exact-test",
      capabilities: {
        run: { input: z.object({ text: z.string() }), price: "$0.016", onJob(ctx) { ctx.complete("done"); } },
      },
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      db: pool,
      dvmId: "upfront-exact-test",
      store: new MemoryKVStore(),
      jobStore: jobs,
      creditLedger: ledger,
      processedPayments: payments,
      x402: X402,
      fxFetcher: {
        fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
        supportedCurrencies: () => ["usd"],
      },
    });
    shutdowns.push(async () => {
      await Promise.all([...instance.jobManager.activeJobs.values()].map((job) => job.terminalWork));
      await instance.shutdown();
    });
    return servers.serve(instance.app);
  }

  function submit(url: string, payment?: string): Promise<Response> {
    return fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(payment ? { "X-PAYMENT": payment } : {}) },
      body: JSON.stringify({ capability: "run", data: { text: "hello" } }),
    });
  }

  it("sends the 402's own resource and no extensions, never the caller's, on verify and settle", async () => {
    const url = await start();
    const required = decodePaymentRequiredHeader((await submit(url)).headers.get("PAYMENT-REQUIRED")!);
    const accepted = required.accepts[0]!;
    const forged = encodePayment({
      x402Version: 2,
      resource: { url: "https://attacker.example/listing", description: "Planted text." },
      accepted,
      payload: {
        signature: `0x${"ab".repeat(65)}`,
        authorization: {
          from: "0x2222222222222222222222222222222222222222",
          to: X402.payTo,
          value: accepted.amount,
          validAfter: "0",
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          nonce: `0x${"33".repeat(32)}`,
        },
      },
      extensions: { bazaar: { info: {}, schema: {} } },
    });
    const paid = await submit(url, forged);
    expect(paid.status).toBeLessThan(300);
    expect(sent.map((call) => call.path)).toEqual(["/verify", "/settle"]);
    for (const { paymentPayload } of sent) {
      expect(paymentPayload.resource).toEqual(required.resource);
      expect(paymentPayload).not.toHaveProperty("extensions");
    }
  });
});
