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
import { ReceiptIssuer } from "../receipt-issuer";
import {
  type PaymentInfo,
  repairX402ExactSettlementEffect,
  verifyUpfrontPayment,
} from "../payment";
import { deferredX402IntentId } from "../funding";
import {
  InProcessDeferredX402Settler,
  X402ExactSettlementServer,
  type X402ExactSettlementEvidenceReader,
} from "../x402-exact-settlement";
import { MemoryX402ExactSettlementStore } from "../x402-exact-settlement-store";

const DVM_ID = "dvm-deferred";
const TX = `0x${"77".repeat(32)}`;
const PRICE_MICRO = 16_000;
const PRICE_MSATS = 16_000;
const RUNTIME_SECONDS = 10;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  facilitatorTimeoutMs: 50,
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

let nonceSeed = 0;

/** A v1 exact authorization for the full price that stays valid for `validForSeconds`. */
function authorization(
  validForSeconds: number,
  nonce = `0x${(++nonceSeed).toString(16).padStart(64, "0")}`,
  from = "0x2222222222222222222222222222222222222222"
) {
  return encodePayment({
    x402Version: X402_V1_VERSION,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from,
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
  /** What the facilitator's /settle answers, changed in place with `answerSettle`. */
  settleBody: Record<string, unknown>;
  /** One-shot /settle answers, consumed in order before `settleBody` applies. */
  settleQueue: (() => Response | Promise<Response>)[];
  /** Replaces every /settle answer once the queue is empty, when set. */
  settleAnswer?: () => Response | Promise<Response>;
  /** Replaces the /verify answer when set. */
  verifyAnswer?: () => Response | Promise<Response>;
}

/** A /settle that never answers, like a facilitator that hung. */
const hang = () => new Promise<Response>(() => undefined);

function rig(verifyGate?: Promise<void>, evidence?: X402ExactSettlementEvidenceReader): Rig {
  const settleBody: Record<string, unknown> = { success: true, transaction: TX, network: X402.network };
  const ledger = new MemoryCreditLedger();
  const processedPayments = new MemoryProcessedPaymentStore();
  const store = new MemoryX402ExactSettlementStore();
  const settlement = new X402ExactSettlementServer({ store, evidence });
  const settleQueue: Rig["settleQueue"] = [];
  const state: { verifyAnswer?: Rig["verifyAnswer"]; settleAnswer?: Rig["settleAnswer"] } = {};
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/verify")) await verifyGate;
    if (url.endsWith("/verify") && state.verifyAnswer) return state.verifyAnswer();
    if (url.endsWith("/settle") && settleQueue.length > 0) return settleQueue.shift()!();
    if (url.endsWith("/settle") && state.settleAnswer) return state.settleAnswer();
    const body = url.endsWith("/verify")
      ? { isValid: true }
      : url.endsWith("/settle")
        ? settleBody
        : undefined;
    if (!body) throw new Error(`unexpected request to ${url}`);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
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
    settleBody,
    settleQueue,
    get settleAnswer() {
      return state.settleAnswer;
    },
    set settleAnswer(answer) {
      state.settleAnswer = answer;
    },
    get verifyAnswer() {
      return state.verifyAnswer;
    },
    set verifyAnswer(answer) {
      state.verifyAnswer = answer;
    },
    facilitatorCalls: (suffix) =>
      fetch.mock.calls.filter(([input]) => String(input).endsWith(suffix)).length,
  };
}

function answerSettle(r: Rig, body: Record<string, unknown>): void {
  for (const key of Object.keys(r.settleBody)) delete r.settleBody[key];
  Object.assign(r.settleBody, { network: X402.network }, body);
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

function manager(
  r: Rig,
  onJob: Parameters<typeof configureDVM>[0]["onJob"],
  maxRuntimeSeconds = RUNTIME_SECONDS,
  settler: InProcessDeferredX402Settler = r.settler,
  extra: Partial<ConstructorParameters<typeof JobManager>[1]> = {}
) {
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
    deferredX402: settler,
    onJobCompleted: completed,
    orphanDrawSweepIntervalMs: 0,
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
    ...extra,
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
    const terminal = vi.fn(async (_info: unknown) => undefined);
    const { jobs, completed } = manager(r, (ctx) => ctx.complete("done"), RUNTIME_SECONDS, r.settler, { onJobTerminal: terminal });
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
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ heldMicro: PRICE_MICRO, finishedPieceCount: 1 }));

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

  it("never settles when the caller cancels: a cancel charges an unsigned x402 job nothing", async () => {
    const r = rig();
    let started!: () => void;
    const running = new Promise<void>((resolve) => { started = resolve; });
    const terminal = vi.fn(async (_info: unknown) => undefined);
    const { jobs, completed } = manager(r, async (ctx) => {
      started();
      await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve, { once: true }));
    }, RUNTIME_SECONDS, r.settler, { onJobTerminal: terminal });
    const fund = vi.spyOn(r.ledger, "fund");

    const payment = await admit(r, authorization(60), "job-cancelled");
    const job = jobs.createJob({ input: "https://example.com" }, "anonymous", payment, PRICE_MSATS, "scrape", undefined, { jobId: "job-cancelled" });
    await jobs.persistJob(job);
    jobs.runHandler(job, jobs.buildAndAttachContext(job, undefined));
    await running;
    // Unlike a ledger-backed job, the stopped piece is not charged: the authorization settles only on completion.
    await jobs.dispatchMessage(job, "cancel", { reason: "changed my mind" });

    expect(job.status).toBe("cancelled");
    expect(r.facilitatorCalls("/settle")).toBe(0);
    expect(fund).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
    const intent = await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!);
    expect(intent?.status).toBe("released");
    expect((await jobs.store.get("job-cancelled"))?.settlement).toEqual({ chargedMicro: 0, stoppedPiece: false });
    // The platform hears of the cancelled job, with nothing paid and nothing charged.
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledTimes(1));
    expect(terminal.mock.calls[0]?.[0]).toMatchObject({
      jobId: "job-cancelled", outcome: "cancelled", endedBy: "caller", paid: false, chargedMicro: 0, heldMicro: 0, finishedPieceCount: 0, currency: null, stoppedPiece: false,
    });
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

  it("leaves a completed job unresolved, not unpaid, while another machine may still hold the authorization", async () => {
    const r = rig();
    const payment = await admit(r, authorization(60), "job-restart");
    // A restarted process has the durable intent but not the bearer signature.
    const restarted = new InProcessDeferredX402Settler({
      settlement: r.settlement,
      dvmId: DVM_ID,
      commit: () => Promise.reject(new Error("must not commit")),
    });
    const { jobs } = manager(r, (ctx) => ctx.complete("done"), RUNTIME_SECONDS, restarted);

    const job = await run(jobs, payment, "job-restart");

    expect(job.status).toBe("completed");
    expect(r.facilitatorCalls("/settle")).toBe(0);
    // Releasing it here would stop the machine that holds the signature from collecting.
    expect((await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!))?.status).toBe("prepared");
    expect((await jobs.store.get("job-restart"))?.receipt).toBeUndefined();
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

  it("admits only one of several presentations that overlap during facilitator verification", async () => {
    let openVerify!: () => void;
    const r = rig(new Promise<void>((resolve) => (openVerify = resolve)));
    const header = authorization(60);

    const attempts = ["a", "b", "c"].map((id) => admit(r, header, `job-race-${id}`));
    // Every presentation is parked inside /verify before any can record its claim.
    await vi.waitFor(() => expect(r.facilitatorCalls("/verify")).toBe(3));
    openVerify();
    const results = await Promise.all(attempts);

    expect(results.filter((p) => p.error === undefined)).toHaveLength(1);
    expect(results.filter((p) => p.error?.status === 409)).toHaveLength(2);
    const { jobs } = manager(r, (ctx) => ctx.complete("done"));
    const winner = results.findIndex((p) => p.error === undefined);
    await run(jobs, results[winner]!, `job-race-${["a", "b", "c"][winner]}`);
    expect(r.facilitatorCalls("/settle")).toBe(1);
    jobs.shutdown();
  });
  describe("a completed job whose payment is not collected", () => {
    const receiptIssuer = () => new ReceiptIssuer({ secret: "77".repeat(32), dvm: "test", dvmId: DVM_ID });

    it("signs no payment claim and reports the job as unpaid, once", async () => {
      const r = rig();
      // The reference facilitator answers a cancelled or spent authorization like this.
      answerSettle(r, { success: false, errorReason: "invalid_exact_evm_nonce_already_used" });
      const terminal = vi.fn(async (_info: unknown) => undefined);
      const { jobs, completed } = manager(r, (ctx) => ctx.complete("done"), RUNTIME_SECONDS, r.settler, {
        receiptIssuer: receiptIssuer(),
        onJobTerminal: terminal,
      });
      const payment = await admit(r, authorization(60), "job-unpaid");

      await run(jobs, payment, "job-unpaid");

      const intentId = deferredX402IntentId(payment.creditId)!;
      expect(r.facilitatorCalls("/settle")).toBe(1);
      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("rejected");
      const stored = await jobs.store.get("job-unpaid");
      expect(stored?.receipt).toMatchObject({
        outcome: "completed",
        paid: { msats: 0, rail: null, native_amount: null, native_asset: null, tx_hash: null },
      });
      expect(stored?.receipt).not.toHaveProperty("credit");
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ jobId: "job-unpaid", outcome: "completed", paid: false, heldMicro: 0, finishedPieceCount: 0 });
      expect(completed).not.toHaveBeenCalled();
      jobs.shutdown();
    });

    it("keeps reporting nothing while the outcome is unknown, then settles on the read-path retry", async () => {
      const r = rig();
      answerSettle(r, { success: false, errorReason: "facilitator_status_503" });
      const terminal = vi.fn(async (_info: unknown) => undefined);
      const { jobs } = manager(r, (ctx) => ctx.complete("done"), RUNTIME_SECONDS, r.settler, {
        receiptIssuer: receiptIssuer(),
        onJobTerminal: terminal,
      });
      const payment = await admit(r, authorization(60), "job-unknown");

      await run(jobs, payment, "job-unknown");

      const intentId = deferredX402IntentId(payment.creditId)!;
      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("ambiguous");
      expect((await jobs.store.get("job-unknown"))?.receipt).toBeUndefined();
      expect(terminal).not.toHaveBeenCalled();

      answerSettle(r, { success: true, transaction: TX });
      await jobs.ensureReceipt((await jobs.store.get("job-unknown"))!);

      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("complete");
      expect((await jobs.store.get("job-unknown"))?.receipt).toMatchObject({ paid: { rail: "x402" } });
      expect(terminal).toHaveBeenCalledTimes(1);
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: true });
      jobs.shutdown();
    });
  });

  describe("one payer's outstanding authorizations", () => {
    const PAYER_A = "0x3333333333333333333333333333333333333333";
    const PAYER_B = "0x4444444444444444444444444444444444444444";

    it("admits one at a time per payer, whatever its balance, and never starts the refused job", async () => {
      const r = rig();
      const first = await admit(r, authorization(60, undefined, PAYER_A), "job-p1");
      expect(first.error).toBeUndefined();

      const second = await admit(r, authorization(60, undefined, PAYER_A), "job-p2");
      const other = await admit(r, authorization(60, undefined, PAYER_B), "job-p3");

      expect(second.error).toMatchObject({ status: 429, body: { error: "x402_payer_busy" } });
      expect(second.creditId).toBeUndefined();
      expect(other.error).toBeUndefined();
      const intents = await r.store.list({ dvmId: DVM_ID, limit: 10, includeResolved: true });
      expect(intents.filter((intent) => intent.from === PAYER_A)).toHaveLength(1);
    });

    it("admits the payer again once the earlier job has ended", async () => {
      const r = rig();
      const { jobs } = manager(r, (ctx) => ctx.complete("done"));
      const first = await admit(r, authorization(60, undefined, PAYER_A), "job-q1");
      await run(jobs, first, "job-q1");

      const next = await admit(r, authorization(60, undefined, PAYER_A), "job-q2");

      expect(next.error).toBeUndefined();
      jobs.shutdown();
    });

    it("does not let an authorization that can no longer settle lock the payer out", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const r = rig();
        const stranded = await admit(r, authorization(30, undefined, PAYER_A), "job-s1");
        expect(stranded.error).toBeUndefined();
        vi.setSystemTime(Date.now() + 31_000);

        const next = await admit(r, authorization(60, undefined, PAYER_A), "job-s2");

        expect(next.error).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("unsigned x402 whose settlement outcome is not known", () => {
  const PAYER = "0x5555555555555555555555555555555555555555";
  const receiptIssuer = () => new ReceiptIssuer({ secret: "77".repeat(32), dvm: "test", dvmId: DVM_ID });
  const json = (body: Record<string, unknown>, status = 200) => () =>
    new Response(JSON.stringify({ network: X402.network, ...body }), { status });
  const pending = json({ success: false, errorReason: "settlement_pending", transaction: TX }, 500);

  /** A restarted process: it has the durable intent but not the bearer signature. */
  const restarted = (r: Rig) =>
    new InProcessDeferredX402Settler({
      settlement: r.settlement,
      dvmId: DVM_ID,
      commit: (receipt, tx, effect) =>
        repairX402ExactSettlementEffect({
          effect,
          paymentId: receipt.txHash ?? "",
          ledger: r.ledger,
          processedPayments: new MemoryProcessedPaymentStore(),
          tx,
        }),
    });

  /** Leave the intent the way a crashed or timed-out submission does. */
  async function strand(r: Rig, payment: PaymentInfo, status: "ambiguous" | "settled") {
    const intentId = deferredX402IntentId(payment.creditId)!;
    await r.store.markSubmitting({ dvmId: DVM_ID, intentId, submissionBlock: "100" });
    await r.store.recordOutcome(
      status === "settled"
        ? { dvmId: DVM_ID, intentId, status, outcome: "success", transaction: TX }
        : { dvmId: DVM_ID, intentId, status, outcome: "timeout" }
    );
    return intentId;
  }

  function withTerminal(r: Rig, settler: InProcessDeferredX402Settler) {
    const terminal = vi.fn(async (_info: unknown) => undefined);
    const made = manager(r, (ctx) => ctx.complete("done"), RUNTIME_SECONDS, settler, {
      receiptIssuer: receiptIssuer(),
      onJobTerminal: terminal,
    });
    return { ...made, terminal };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("facilitator timeouts", () => {
    it("refuses admission when /verify hangs, and runs no work", async () => {
      const r = rig();
      r.verifyAnswer = hang;

      const payment = await admit(r, authorization(60), "job-hung-verify");

      expect(payment.error).toMatchObject({ status: 402 });
      expect(payment.creditId).toBeUndefined();
      expect(r.facilitatorCalls("/settle")).toBe(0);
      expect(await r.store.list({ dvmId: DVM_ID, limit: 10, includeResolved: true })).toHaveLength(0);
    });

    it("ends ambiguous, not rejected, when /settle hangs, and still lets the job's terminal work finish", async () => {
      const r = rig();
      r.settleAnswer = hang;
      const { jobs, terminal } = withTerminal(r, r.settler);
      const payment = await admit(r, authorization(60), "job-hung-settle");

      // `run` returns only because the job's terminal work resolved despite the hang.
      await run(jobs, payment, "job-hung-settle");

      const intent = await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!);
      expect(intent?.status).toBe("ambiguous");
      expect(intent?.lastOutcome).toBe("timeout");
      expect((await jobs.store.get("job-hung-settle"))?.receipt).toBeUndefined();
      expect(terminal).not.toHaveBeenCalled();
      jobs.shutdown();
    });
  });

  describe("a settlement the facilitator reports as pending", () => {
    it("keeps the hash, resends the identical payload once, and settles when the resend does", async () => {
      const r = rig();
      r.settleQueue.push(pending);
      const { jobs, terminal } = withTerminal(r, r.settler);
      const payment = await admit(r, authorization(60), "job-pending-ok");

      await run(jobs, payment, "job-pending-ok");

      const intentId = deferredX402IntentId(payment.creditId)!;
      expect(r.facilitatorCalls("/settle")).toBe(2);
      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("complete");
      const attempts = await r.store.attempts(DVM_ID, intentId);
      expect(attempts.find((attempt) => attempt.outcome === "pending")?.transaction).toBe(TX);
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: true });
      jobs.shutdown();
    });

    it("stays ambiguous, never rejected, when the resend is still pending", async () => {
      const r = rig();
      r.settleQueue.push(pending, pending);
      const payment = await admit(r, authorization(60), "job-pending-twice");
      const intentId = deferredX402IntentId(payment.creditId)!;

      await expect(r.settler.settle(intentId)).rejects.toThrow(/outcome unknown/);

      const intent = await r.store.get(DVM_ID, intentId);
      expect(r.facilitatorCalls("/settle")).toBe(2);
      expect(intent?.status).toBe("ambiguous");
      expect(intent?.transaction).toBe(TX);
    });

    it("settles when the resend is told the nonce is used and the chain shows our transfer", async () => {
      const r = rig(undefined, {
        getBlockNumber: async () => 100n,
        findExactPayment: async () => ({ transaction: TX, amount: String(PRICE_MICRO) }),
      });
      r.settleQueue.push(
        pending,
        json({ success: false, errorReason: "invalid_exact_evm_nonce_already_used" })
      );
      const { jobs, terminal } = withTerminal(r, r.settler);
      const payment = await admit(r, authorization(60), "job-pending-nonce");

      await run(jobs, payment, "job-pending-nonce");

      expect((await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!))?.status).toBe("complete");
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: true });
      jobs.shutdown();
    });

    it("does not call the payment unpaid when the resend is told the nonce is used and the chain is silent", async () => {
      const r = rig(undefined, { getBlockNumber: async () => 100n, findExactPayment: async () => undefined });
      r.settleQueue.push(
        pending,
        json({ success: false, errorReason: "invalid_exact_evm_nonce_already_used" })
      );
      const payment = await admit(r, authorization(60), "job-pending-nonce-silent");
      const intentId = deferredX402IntentId(payment.creditId)!;

      await expect(r.settler.settle(intentId)).rejects.toThrow(/outcome unknown/);

      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("ambiguous");
    });
  });

  describe("a completed job whose process holds no signature", () => {
    it("reports nothing for an ambiguous intent the chain cannot resolve", async () => {
      const r = rig(undefined, { getBlockNumber: async () => 100n, findExactPayment: async () => undefined });
      const payment = await admit(r, authorization(60), "job-lost-ambiguous");
      const intentId = await strand(r, payment, "ambiguous");
      const { jobs, terminal } = withTerminal(r, restarted(r));

      await run(jobs, payment, "job-lost-ambiguous");

      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("ambiguous");
      expect((await jobs.store.get("job-lost-ambiguous"))?.receipt).toBeUndefined();
      expect(terminal).not.toHaveBeenCalled();
      expect(r.facilitatorCalls("/settle")).toBe(0);
      jobs.shutdown();
    });

    it("releases a prepared intent once its authorization has expired", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const r = rig();
      const payment = await admit(r, authorization(30), "job-lost-expired");
      const { jobs, terminal } = withTerminal(r, restarted(r));
      vi.setSystemTime(Date.now() + 30_000);

      await run(jobs, payment, "job-lost-expired");

      expect((await r.store.get(DVM_ID, deferredX402IntentId(payment.creditId)!))?.status).toBe("released");
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: false });
      jobs.shutdown();
    });

    it("settles an ambiguous intent on a later read once the chain shows the transfer", async () => {
      let found: { transaction: string; amount: string } | undefined;
      const r = rig(undefined, { getBlockNumber: async () => 100n, findExactPayment: async () => found });
      const payment = await admit(r, authorization(60), "job-lost-used");
      const intentId = await strand(r, payment, "ambiguous");
      const { jobs, terminal } = withTerminal(r, restarted(r));
      await run(jobs, payment, "job-lost-used");
      expect(terminal).not.toHaveBeenCalled();

      found = { transaction: TX, amount: String(PRICE_MICRO) };
      await jobs.ensureReceipt((await jobs.store.get("job-lost-used"))!);

      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("complete");
      expect((await jobs.store.get("job-lost-used"))?.receipt).toMatchObject({ paid: { rail: "x402" } });
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: true });
      jobs.shutdown();
    });

    it("finishes an intent that settled before the signature was lost instead of calling it unpaid", async () => {
      const r = rig();
      const payment = await admit(r, authorization(60), "job-lost-settled");
      const intentId = await strand(r, payment, "settled");
      const { jobs, terminal } = withTerminal(r, restarted(r));

      await run(jobs, payment, "job-lost-settled");

      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("complete");
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: true });
      jobs.shutdown();
    });

    it("calls an expired ambiguous intent unpaid only when the chain proves the authorization unused", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      let unused: () => Promise<boolean> = () => Promise.reject(new Error("rpc down"));
      const r = rig(undefined, {
        getBlockNumber: async () => 100n,
        findExactPayment: async () => undefined,
        isExactAuthorizationUnused: () => unused(),
      });
      const payment = await admit(r, authorization(30), "job-lost-unused");
      const intentId = await strand(r, payment, "ambiguous");
      const { jobs, terminal } = withTerminal(r, restarted(r));
      vi.setSystemTime(Date.now() + 31_000);

      await run(jobs, payment, "job-lost-unused");
      // A failed chain read is not proof of anything.
      expect((await r.store.get(DVM_ID, intentId))?.status).toBe("ambiguous");
      expect(terminal).not.toHaveBeenCalled();

      unused = async () => true;
      await jobs.ensureReceipt((await jobs.store.get("job-lost-unused"))!);

      const intent = await r.store.get(DVM_ID, intentId);
      expect(intent?.status).toBe("rejected");
      expect(intent?.lastOutcome).toBe("authorization_expired_unused");
      expect((await jobs.store.get("job-lost-unused"))?.receipt).toMatchObject({
        paid: { msats: 0, rail: null },
      });
      expect(terminal.mock.calls[0]?.[0]).toMatchObject({ paid: false });
      jobs.shutdown();
    });
  });

  describe("a payer whose earlier authorization is unresolved", () => {
    it("is refused until that authorization's expiry, and admitted again after", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const r = rig();
      const first = await admit(r, authorization(30, undefined, PAYER), "job-busy-1");
      await strand(r, first, "ambiguous");

      const before = await admit(r, authorization(60, undefined, PAYER), "job-busy-2");
      vi.setSystemTime(Date.now() + 31_000);
      const after = await admit(r, authorization(60, undefined, PAYER), "job-busy-3");

      expect(before.error).toMatchObject({ status: 429, body: { error: "x402_payer_busy" } });
      expect(after.error).toBeUndefined();
    });
  });
});
