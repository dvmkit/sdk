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

function authorization(
  validForSeconds: number,
  who: { from?: string; nonce?: string } = {}
): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: who.from ?? "0x2222222222222222222222222222222222222222",
        to: X402.payTo,
        value: String(PRICE_MICRO),
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + validForSeconds),
        nonce: who.nonce ?? `0x${"33".repeat(32)}`,
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
  let settleAnswer: () => Promise<Response>;
  let sawSettle: ReturnType<typeof gate>;

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
    settleAnswer = async () => Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    sawSettle = gate();
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      if (!url.startsWith(`${X402.facilitator}/`)) return fetch(request, init);
      facilitatorCalls.push(new URL(url).pathname);
      if (url === `${X402.facilitator}/verify`) return Response.json({ isValid: true });
      if (url === `${X402.facilitator}/settle`) {
        sawSettle.resolve();
        return settleAnswer();
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

  async function start(
    pool = poolA,
    opts: { fail?: boolean; unbounded?: boolean; artifact?: boolean } = {}
  ): Promise<string> {
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
            if (opts.artifact) ctx.artifact({ name: "report", data: "paid-for output" });
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

  function readMessages(url: string, job: AcceptedJob, sse = false): Promise<Response> {
    return fetch(`${url}/v1/job/${job.job_id}/messages`, {
      headers: { "X-Job-Token": job.job_token, ...(sse ? { Accept: "text/event-stream" } : {}) },
    });
  }

  /** Every route that can carry the job's output, as the raw text a caller would receive. */
  async function everythingReadable(url: string, job: AcceptedJob): Promise<string> {
    const responses = await Promise.all([read(url, job), readMessages(url, job), readMessages(url, job, true)]);
    return (await Promise.all(responses.map((response) => response.text()))).join("\n");
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
      // The draw settles in a separate transaction after the intent completes.
      expect(await ledger.getDraw(drawRef)).toMatchObject({ status: "settled", amountMicro: PRICE_MICRO });
    }, { timeout: 5000 });
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

  it("holds every read of the output until the settlement lands, then releases it", async () => {
    const url = await start(poolA, { artifact: true });
    let release!: () => void;
    const settleHeld = new Promise<void>((resolve) => { release = resolve; });
    settleAnswer = async () => {
      await settleHeld;
      return Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    };
    const accepted = await submit(url, authorization(RUNTIME_SECONDS + 60));
    const job = await accepted.json() as AcceptedJob;
    await vi.waitFor(() => expect(handled).toBe(1));
    // The artifact exists in the store but the job is still running.
    await vi.waitFor(async () => {
      const rows = await poolA.query("SELECT 1 FROM job_messages WHERE job_id = $1 AND data->>'type' = 'artifact'", [job.job_id]);
      expect(rows.rowCount).toBe(1);
    }, { timeout: 5000 });

    const midRun = await everythingReadable(url, job);
    expect(midRun).not.toContain("paid-for output");
    expect(await (await read(url, job)).json()).toMatchObject({ status: "processing", content_available: false });

    finish.resolve();
    await sawSettle.promise;
    await vi.waitFor(async () => expect((await jobs.get(job.job_id))?.status).toBe("completed"), { timeout: 5000 });

    // Handler done, authorization sent, facilitator has not answered.
    const settling = await everythingReadable(url, job);
    expect(settling).not.toContain("paid-for output");
    expect(settling).not.toContain("done");
    expect(await (await read(url, job)).json()).toMatchObject({
      status: "processing",
      content_available: false,
      content_withheld: "payment_pending",
    });

    release();
    const intentId = deferredX402IntentId(job.upfront_payment.credit_id)!;
    await vi.waitFor(async () => expect((await settlements.get(DVM_ID, intentId))?.status).toBe("complete"), { timeout: 5000 });
    const settled = await read(url, job);
    expect(await settled.json()).toMatchObject({ status: "completed", summary: "done", has_artifacts: true, artifact_count: 1 });
    expect(await (await readMessages(url, job)).text()).toContain("paid-for output");
    expect(await (await readMessages(url, job, true)).text()).toContain("paid-for output");
  });

  it("never exposes the output or claims payment when the settlement is refused", async () => {
    const url = await start(poolA, { artifact: true });
    settleAnswer = async () =>
      Response.json({ success: false, errorReason: "invalid_exact_evm_nonce_already_used", network: X402.network });
    const accepted = await submit(url, authorization(RUNTIME_SECONDS + 60));
    const job = await accepted.json() as AcceptedJob;
    const intentId = deferredX402IntentId(job.upfront_payment.credit_id)!;
    finish.resolve();
    await vi.waitFor(async () => expect((await settlements.get(DVM_ID, intentId))?.status).toBe("rejected"), { timeout: 5000 });

    const everything = await everythingReadable(url, job);

    expect(everything).not.toContain("paid-for output");
    expect(everything).not.toContain("done");
    const unpaid = await read(url, job);
    expect(await unpaid.json()).toMatchObject({ status: "failed", content_available: false, content_withheld: "payment_unsettled" });
    expect(unpaid.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect((await poolA.query("SELECT credit_id FROM credits")).rowCount).toBe(0);
  });

  it("keeps the output held while the settlement outcome is unknown, and settles on a later read", async () => {
    const url = await start(poolA, { artifact: true });
    settleAnswer = async () => Response.json({ success: false, errorReason: "facilitator_status_503", network: X402.network });
    const accepted = await submit(url, authorization(RUNTIME_SECONDS + 60));
    const job = await accepted.json() as AcceptedJob;
    const intentId = deferredX402IntentId(job.upfront_payment.credit_id)!;
    finish.resolve();
    await vi.waitFor(async () => expect((await settlements.get(DVM_ID, intentId))?.status).toBe("ambiguous"), { timeout: 5000 });

    expect(await everythingReadable(url, job)).not.toContain("paid-for output");

    settleAnswer = async () => Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    await vi.waitFor(async () => {
      expect(await (await read(url, job)).json()).toMatchObject({ status: "completed", summary: "done" });
    }, { timeout: 5000 });
    expect((await settlements.get(DVM_ID, intentId))?.status).toBe("complete");
    expect(await (await readMessages(url, job)).text()).toContain("paid-for output");
  });

  it("does not let a cancelled job hand its artifacts to a caller who never paid", async () => {
    const url = await start(poolA, { artifact: true });
    const accepted = await submit(url, authorization(RUNTIME_SECONDS + 60));
    const job = await accepted.json() as AcceptedJob;
    const intentId = deferredX402IntentId(job.upfront_payment.credit_id)!;
    await vi.waitFor(async () => {
      const rows = await poolA.query("SELECT 1 FROM job_messages WHERE job_id = $1 AND data->>'type' = 'artifact'", [job.job_id]);
      expect(rows.rowCount).toBe(1);
    }, { timeout: 5000 });

    const cancelled = await fetch(`${url}/v1/job/${job.job_id}`, { method: "DELETE", headers: { "X-Job-Token": job.job_token } });
    expect(cancelled.status).toBeLessThan(300);
    await vi.waitFor(async () => expect((await settlements.get(DVM_ID, intentId))?.status).toBe("released"), { timeout: 5000 });

    const everything = await everythingReadable(url, job);
    expect(everything).not.toContain("paid-for output");
    expect(facilitatorCalls).toEqual(["/verify"]);
  });

  it("refuses a second authorization from a payer whose first job is still running", async () => {
    const url = await start();
    const first = await submit(url, authorization(RUNTIME_SECONDS + 60, { nonce: `0x${"41".repeat(32)}` }));
    expect(first.status).toBe(202);

    const second = await submit(url, authorization(RUNTIME_SECONDS + 60, { nonce: `0x${"42".repeat(32)}` }));
    const otherPayer = await submit(url, authorization(RUNTIME_SECONDS + 60, {
      nonce: `0x${"43".repeat(32)}`,
      from: "0x5555555555555555555555555555555555555555",
    }));

    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: "x402_payer_busy" });
    expect(otherPayer.status).toBe(202);
    expect(handled).toBe(2);
    expect((await poolA.query("SELECT id FROM jobs")).rowCount).toBe(2);
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
