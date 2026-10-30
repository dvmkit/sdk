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
import { deferredX402IntentId } from "../funding";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { PostgresX402ExactSettlementStore } from "../x402-exact-settlement-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "unsigned_x402_submit_test";
const DVM_ID = "unsigned-x402-submit-test";
const PRICE_MICRO = 16_000;
// Exceeds the ordinary 60-second window so a missing deferred-window override fails.
const RUNTIME_SECONDS = 90;
const TRANSACTION = `0x${"77".repeat(32)}`;
const X402: X402Config = {
  facilitator: "https://facilitator.example.com",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
const input = z.object({
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
  text: z.string(),
});

function authorization(validForSeconds: number): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: X402.payTo,
        value: String(PRICE_MICRO),
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds),
        nonce: `0x${"33".repeat(32)}`,
      },
    },
  });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((open) => { resolve = open; });
  return { promise, resolve };
}

interface AcceptedJob {
  job_id: string;
  job_token: string;
  upfront_payment: { credit_id: string; draw_id: string };
}

describe.skipIf(!RUN)("unsigned x402 submit route (Postgres)", () => {
  const servers = servedApps();
  const shutdowns: Array<() => Promise<void>> = [];
  let poolA: Pool;
  let poolB: Pool;
  let jobs: PostgresJobStore;
  let ledger: CreditLedger;
  let payments: PostgresProcessedPaymentStore;
  let settlements: PostgresX402ExactSettlementStore;
  let finish: ReturnType<typeof gate>;
  let handled: number;
  let facilitatorCalls: string[];

  beforeEach(async () => {
    await recreateSchema(SCHEMA);
    poolA = await pinnedPool(SCHEMA);
    poolB = await pinnedPool(SCHEMA);
    jobs = new PostgresJobStore(poolA);
    ledger = new CreditLedger(poolA);
    payments = new PostgresProcessedPaymentStore(poolA);
    settlements = new PostgresX402ExactSettlementStore(poolA);
    await Promise.all([jobs.init(), ledger.init(), payments.init()]);
    finish = gate();
    handled = 0;
    facilitatorCalls = [];
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (!url.startsWith(`${X402.facilitator}/`)) return fetch(request, init);
      facilitatorCalls.push(new URL(url).pathname);
      if (url === `${X402.facilitator}/verify`) return Response.json({ isValid: true });
      if (url === `${X402.facilitator}/settle`) {
        return Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
      }
      throw new Error(`Unexpected facilitator request: ${url}`);
    });
  });

  afterEach(async () => {
    finish?.resolve();
    await servers.closeAll();
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await Promise.all([poolA?.end(), poolB?.end()]);
    await dropSchemas(SCHEMA);
  });

  async function start(pool = poolA, opts: { fail?: boolean; unbounded?: boolean } = {}): Promise<string> {
    const descriptor = configureDVM({
      name: "unsigned-x402-test",
      auth: secp256k1Auth({ allowUnsignedPaid: true }),
      capabilities: {
        run: {
          input,
          price: "$0.016",
          ...(opts.unbounded ? {} : { maxRuntimeSeconds: RUNTIME_SECONDS }),
          async onJob(ctx) {
            handled++;
            await finish.promise;
            if (opts.fail) ctx.fail("blocked");
            else ctx.complete("done");
          },
        },
      },
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      db: pool,
      dvmId: DVM_ID,
      store: new MemoryKVStore(),
      jobStore: pool === poolA ? jobs : new PostgresJobStore(pool),
      creditLedger: pool === poolA ? ledger : new CreditLedger(pool),
      processedPayments: pool === poolA ? payments : new PostgresProcessedPaymentStore(pool),
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

  function read(url: string, job: AcceptedJob): Promise<Response> {
    return fetch(`${url}/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token } });
  }

  it("advertises the longer window, settles only after success, and rejects replay across servers", async () => {
    const first = await start();
    const second = await start(poolB);
    const discovery = await submit(first);
    expect(discovery.status).toBe(402);
    const body = await discovery.json() as {
      accepts: { scheme: string; maxAmountRequired: string; maxTimeoutSeconds: number }[];
    };
    expect(body.accepts).toContainEqual(expect.objectContaining({ scheme: "exact", maxAmountRequired: "16000" }));
    const timeout = body.accepts[0]!.maxTimeoutSeconds;
    expect(timeout).toBeGreaterThan(RUNTIME_SECONDS);
    const v2 = decodePaymentRequiredHeader(discovery.headers.get("PAYMENT-REQUIRED")!);
    expect(v2.accepts[0]?.maxTimeoutSeconds).toBe(timeout);
    expect(facilitatorCalls).toEqual([]);
    expect(handled).toBe(0);

    const payment = authorization(timeout);
    const accepted = await submit(first, payment);
    expect(accepted.status).toBe(202);
    const job = await accepted.json() as AcceptedJob;
    expect(job.job_token).toEqual(expect.any(String));
    expect(handled).toBe(1);
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(accepted.headers.get("PAYMENT-RESPONSE")).toBeNull();
    const drawRef = { creditId: job.upfront_payment.credit_id, drawId: job.upfront_payment.draw_id };
    expect(await ledger.get(drawRef.creditId)).toBeUndefined();
    expect(await ledger.getDraw(drawRef)).toBeUndefined();
    const intentId = deferredX402IntentId(drawRef.creditId)!;
    expect(await settlements.get(DVM_ID, intentId)).toMatchObject({ status: "prepared", effect: { jobId: job.job_id } });

    const replayWhileRunning = await submit(second, payment);
    expect(replayWhileRunning.status).toBe(409);
    expect(await replayWhileRunning.json()).toMatchObject({ error: "replay_rejected" });
    expect(handled).toBe(1);
    expect(facilitatorCalls).toEqual(["/verify"]);

    finish.resolve();
    await vi.waitFor(async () => {
      expect((await jobs.get(job.job_id))?.status).toBe("completed");
      expect((await settlements.get(DVM_ID, intentId))?.status).toBe("complete");
    }, { timeout: 5000 });
    expect(await ledger.getDraw(drawRef)).toMatchObject({ status: "settled", amountMicro: PRICE_MICRO });
    expect(await payments.get({ dvmId: DVM_ID, rail: "x402", paymentId: TRANSACTION }))
      .toMatchObject({ jobId: job.job_id, ...drawRef });

    // Repeated reads on another server must carry durable evidence without settling again.
    for (let attempt = 0; attempt < 2; attempt++) {
      const finished = await read(second, job);
      expect(finished.status).toBe(200);
      expect(await finished.json()).toMatchObject({ status: "completed", summary: "done" });
      const header = finished.headers.get("PAYMENT-RESPONSE");
      expect(header).toEqual(expect.any(String));
      expect(JSON.parse(Buffer.from(header!, "base64").toString("utf8")))
        .toMatchObject({ success: true, transaction: TRANSACTION });
      expect(finished.headers.get("X-PAYMENT-RESPONSE")).toBe(header);
    }
    const replayAfterSuccess = await submit(second, payment);
    expect(replayAfterSuccess.status).toBe(409);
    expect(await replayAfterSuccess.json()).toMatchObject({ error: "replay_rejected" });
    expect(handled).toBe(1);
    expect(facilitatorCalls).toEqual(["/verify", "/settle"]);
    expect((await poolA.query("SELECT id FROM jobs")).rowCount).toBe(1);
  });

  it("releases a failed job's authorization without settling or creating credit", async () => {
    const url = await start(poolA, { fail: true });
    const accepted = await submit(url, authorization(RUNTIME_SECONDS + 60));
    expect(accepted.status).toBe(202);
    const job = await accepted.json() as AcceptedJob;
    finish.resolve();
    const intentId = deferredX402IntentId(job.upfront_payment.credit_id)!;
    await vi.waitFor(async () => {
      expect((await jobs.get(job.job_id))?.status).toBe("failed");
      expect((await settlements.get(DVM_ID, intentId))?.status).toBe("released");
    }, { timeout: 5000 });
    const failed = await read(url, job);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: "failed" });
    expect(failed.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(handled).toBe(1);
    expect((await poolA.query("SELECT credit_id FROM credits")).rowCount).toBe(0);
    expect((await poolA.query("SELECT credit_id FROM credit_draws")).rowCount).toBe(0);
    expect((await poolA.query("SELECT payment_id FROM processed_payments")).rowCount).toBe(0);
  });

  it("refuses unsigned discovery and payment on a capability without a runtime bound", async () => {
    const url = await start(poolA, { unbounded: true });
    for (const payment of [undefined, authorization(RUNTIME_SECONDS + 60)]) {
      const refused = await submit(url, payment);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toMatchObject({ error: "auth_error" });
      expect(refused.headers.get("PAYMENT-REQUIRED")).toBeNull();
    }
    expect(facilitatorCalls).toEqual([]);
    expect(handled).toBe(0);
    expect((await poolA.query("SELECT id FROM jobs")).rowCount).toBe(0);
    expect((await poolA.query("SELECT intent_id FROM x402_exact_settlement_intents")).rowCount).toBe(0);
  });
});
