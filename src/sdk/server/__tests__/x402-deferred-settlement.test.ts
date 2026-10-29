/* An unsigned x402 payment is verified before the job and settled only after the job succeeds. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import {
  type PaymentInfo,
  repairX402ExactSettlementEffect,
  verifyUpfrontPayment,
} from "../payment";
import { deferredX402IntentId } from "../funding";
import { InProcessDeferredX402Settler, X402ExactSettlementServer } from "../x402-exact-settlement";
import { MemoryX402ExactSettlementStore } from "../x402-exact-settlement-store";

const DVM_ID = "dvm-deferred";
const TX = `0x${"77".repeat(32)}`;
const PRICE_MICRO = 16_000;
const PRICE_MSATS = 16_000;
const RUNTIME_SECONDS = 10;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

let nonceSeed = 0;

/** A v1 exact authorization for the full price that stays valid for `validForSeconds`. */
function authorization(validForSeconds: number, nonce = `0x${(++nonceSeed).toString(16).padStart(64, "0")}`) {
  return encodePayment({
    x402Version: X402_V1_VERSION,
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
        nonce,
      },
    },
  });
}

interface Rig {
  ledger: MemoryCreditLedger;
  store: MemoryX402ExactSettlementStore;
  settlement: X402ExactSettlementServer;
  settler: InProcessDeferredX402Settler;
  facilitatorCalls: (suffix: "/verify" | "/settle") => number;
}

function rig(): Rig {
  const ledger = new MemoryCreditLedger();
  const processedPayments = new MemoryProcessedPaymentStore();
  const store = new MemoryX402ExactSettlementStore();
  const settlement = new X402ExactSettlementServer({ store });
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    const body = url.endsWith("/verify")
      ? { isValid: true }
      : url.endsWith("/settle")
        ? { success: true, transaction: TX, network: X402.network }
        : undefined;
    if (!body) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
    );
  });
  const settler = new InProcessDeferredX402Settler({
    settlement,
    dvmId: DVM_ID,
    commit: (receipt, tx, effect) =>
      repairX402ExactSettlementEffect({
        effect,
        paymentId: receipt.txHash ?? "",
        ledger,
        processedPayments,
        tx,
      }),
  });
  return {
    ledger,
    store,
    settlement,
    settler,
    facilitatorCalls: (suffix) =>
      fetch.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length,
  };
}

function admit(r: Rig, header: string | undefined, jobId: string): Promise<PaymentInfo & { error?: { status: number; body: Record<string, unknown>; x402Requirements?: { maxTimeoutSeconds: number }[] } }> {
  return verifyUpfrontPayment({
    x402Payment: header,
    x402Config: X402,
    x402ExactSettlement: r.settlement,
    x402Deferred: { maxRuntimeSeconds: RUNTIME_SECONDS, settler: r.settler },
    requiredMsats: PRICE_MSATS,
    priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
    creditLedger: r.ledger,
    processedPayments: new MemoryProcessedPaymentStore(),
    fxFetcher: createFxFetcher(),
    dvmId: DVM_ID,
    jobId,
  }) as never;
}

function manager(r: Rig, onJob: Parameters<typeof configureDVM>[0]["onJob"], maxRuntimeSeconds = RUNTIME_SECONDS) {
  const completed = vi.fn();
  const descriptor = configureDVM({
    name: "deferred-test",
    capability: "scrape",
    tag: "test",
    maxRuntimeSeconds,
    onJob,
  });
  const jobs = new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    creditLedger: r.ledger,
    devMode: true,
    dvmId: DVM_ID,
    fxFetcher: createFxFetcher(),
    deferredX402: r.settler,
    onJobCompleted: completed,
    orphanDrawSweepIntervalMs: 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
  });
  return { jobs, completed };
}

/** Run the job the way the submit route does and wait for its terminal work. */
async function run(jobs: JobManager<unknown, undefined>, payment: PaymentInfo, jobId: string) {
  const job = jobs.createJob(
    { input: "https://example.com" },
    "anonymous",
    payment,
    PRICE_MSATS,
    "scrape",
    undefined,
    { jobId }
  );
  await jobs.persistJob(job);
  jobs.runHandler(job, jobs.buildAndAttachContext(job, undefined));
  await vi.waitFor(() => expect(job.terminalWork).toBeDefined(), { timeout: 5000 });
  await job.terminalWork;
  return job;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("unsigned x402 settled after the job", () => {
  it("verifies before the job, settles once when it succeeds, and funds the draw only then", async () => {
    const r = rig();
    const { jobs, completed } = manager(r, (ctx) => ctx.complete("done"));
    const header = authorization(60);

    const payment = await admit(r, header, "job-ok");

    expect(payment.error).toBeUndefined();
    expect(r.facilitatorCalls("/verify")).toBe(1);
    expect(r.facilitatorCalls("/settle")).toBe(0);
    const intentId = deferredX402IntentId(payment.creditId);
    expect(intentId).toBeDefined();
    expect(await r.ledger.getDraw({ creditId: payment.creditId!, drawId: payment.drawId! })).toBeUndefined();

    await run(jobs, payment, "job-ok");

    expect(r.facilitatorCalls("/settle")).toBe(1);
    const draw = await r.ledger.getDraw({ creditId: payment.creditId!, drawId: payment.drawId! });
    expect(draw).toMatchObject({ status: "settled", amountMicro: PRICE_MICRO });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(completed.mock.calls[0]?.[0]).toMatchObject({ jobId: "job-ok", paidMsats: PRICE_MSATS });
    expect((await r.store.get(DVM_ID, intentId!))?.status).toBe("complete");

    // A retried terminal (lost receipt, cross-machine re-read) must not pay twice.
    expect(await r.settler.settle(intentId!)).toBe("settled");
    expect(r.facilitatorCalls("/settle")).toBe(1);
    jobs.shutdown();
  });

  it("never settles when the handler fails, and holds no credit for the payer", async () => {
    const r = rig();
    const { jobs, completed } = manager(r, (ctx) => ctx.fail("scrape blocked"));
    const fund = vi.spyOn(r.ledger, "fund");

    const payment = await admit(r, authorization(60), "job-failed");
    const job = await run(jobs, payment, "job-failed");

    expect(job.status).toBe("failed");
    expect(r.facilitatorCalls("/settle")).toBe(0);
    expect(fund).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    const intent = await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!);
    expect(intent?.status).toBe("released");
    jobs.shutdown();
  });

  it("never settles a job that outlives its runtime bound", async () => {
    const r = rig();
    let aborted = false;
    const { jobs, completed } = manager(
      r,
      (ctx) =>
        new Promise<void>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        }),
      1
    );
    const payment = await admit(r, authorization(60), "job-slow");

    const job = await run(jobs, payment, "job-slow");

    expect(job.status).toBe("failed");
    expect(aborted).toBe(true);
    expect(r.facilitatorCalls("/settle")).toBe(0);
    expect(completed).not.toHaveBeenCalled();
    expect((await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!))?.status).toBe("released");
    jobs.shutdown();
  });

  it("leaves a completed job unpaid, not settled, when this process lost the authorization", async () => {
    const r = rig();
    const payment = await admit(r, authorization(60), "job-restart");
    // A restarted process has the durable intent but not the bearer signature.
    const restarted = new InProcessDeferredX402Settler({
      settlement: r.settlement,
      dvmId: DVM_ID,
      commit: () => Promise.reject(new Error("must not commit")),
    });
    const { jobs } = manager(r, (ctx) => ctx.complete("done"));
    (jobs as unknown as { opts: { deferredX402: unknown } }).opts.deferredX402 = restarted;

    const job = await run(jobs, payment, "job-restart");

    expect(job.status).toBe("completed");
    expect(r.facilitatorCalls("/settle")).toBe(0);
    expect((await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!))?.status).toBe("released");
    jobs.shutdown();
  });

  it("refuses an authorization that expires before the job could finish, without calling the facilitator", async () => {
    const r = rig();

    const result = await admit(r, authorization(RUNTIME_SECONDS), "job-short");

    expect(result.error).toMatchObject({
      status: 402,
      body: { error: "payment_authorization_too_short" },
    });
    expect(r.facilitatorCalls("/verify")).toBe(0);
    expect(r.facilitatorCalls("/settle")).toBe(0);
    expect(await r.store.list({ dvmId: DVM_ID, limit: 10, includeResolved: true })).toEqual([]);
  });

  it("advertises a validity window that a client signing exactly that window is accepted with", async () => {
    const r = rig();
    const challenge = await admit(r, undefined, "job-challenge");
    const advertised = challenge.error?.x402Requirements?.[0]?.maxTimeoutSeconds;
    expect(advertised).toBeGreaterThan(RUNTIME_SECONDS);

    const payment = await admit(r, authorization(advertised!), "job-window");

    expect(payment.error).toBeUndefined();
    expect(payment.creditId).toBeDefined();
  });

  it("admits one job per authorization", async () => {
    const r = rig();
    const header = authorization(60);
    const first = await admit(r, header, "job-first");
    expect(first.error).toBeUndefined();

    // Presented again while the first job is still running, then after it ends.
    const whileRunning = await admit(r, header, "job-second");
    const { jobs } = manager(r, (ctx) => ctx.complete("done"));
    await run(jobs, first, "job-first");
    const afterSettled = await admit(r, header, "job-third");

    expect(whileRunning.error?.status).toBe(409);
    expect(afterSettled.error?.status).toBe(409);
    expect(r.facilitatorCalls("/verify")).toBe(1);
    expect(r.facilitatorCalls("/settle")).toBe(1);
    jobs.shutdown();
  });
});
