/* Real Postgres and two pools exercise cumulative ask ceilings and concurrent payments.
 * Existing-draw growth is capped; refused excess remains immediately drainable balance. */
import { schnorr } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { DrawPool } from "../context";
import { buildContext } from "../context";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { implicitCreditId } from "../funding";
import type { ServerJob } from "../job";
import { fromJobRecord } from "../job";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const RATE = 100_000;
/** €80k/BTC against $100k: 50 sats is $0.05 and €0.04. */
const EUR_RATE = 80_000;
const DVM_ID = "dvm-credit-cap-cap";
const PRIVKEY = new Uint8Array(32).fill(9);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const REFUND_PUBKEY = "02" + "ef".repeat(32);

const UPFRONT_MICRO = 100_000;
const UPFRONT_MSATS = 100_000;

const ASK_MICRO = 50_000;
const ASK_MSATS = 50_000;
const ASK_USDC = 50_000;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function warmFetcher(): FxFetcher {
  return mutableFetcher().fetcher;
}

// Change FX after the ask; the cap must keep the ask-time pinned integer.
function mutableFetcher(): { fetcher: FxFetcher; setUsdRate: (rate: number) => void } {
  const state = { usd: RATE };
  return {
    setUsdRate: (rate: number) => {
      state.usd = rate;
    },
    fetcher: {
      fetch: () =>
        Promise.resolve({
          rates: { usd: state.usd, eur: EUR_RATE } as FxRateSnapshot["rates"],
          as_of: new Date(0).toISOString(),
        }),
      supportedCurrencies: () => ["usd", "eur"],
      lastKnown: () => null,
    },
  };
}

const downFetcher: FxFetcher = {
  fetch: () => Promise.reject(new Error("fx down")),
  supportedCurrencies: () => ["usd", "eur"],
  lastKnown: () => null,
};

describe.skipIf(!RUN)("the mid-job draw growth cap", () => {
  // Two pools: the credit row's `FOR UPDATE` only proves anything across
  // independent connections, and the ledger leg runs on whichever pool the
  // processed-payment marker's transaction was opened on.
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let ledgerA: CreditLedger;
  let ledgerB: CreditLedger;
  let paymentsA: PostgresProcessedPaymentStore;
  let paymentsB: PostgresProcessedPaymentStore;
  let jobStore: PostgresJobStore;
  const servers = servedApps();

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    ledgerA = new CreditLedger(poolA);
    ledgerB = new CreditLedger(poolB);
    await ledgerA.init();
    paymentsA = new PostgresProcessedPaymentStore(poolA);
    paymentsB = new PostgresProcessedPaymentStore(poolB);
    await paymentsA.init();
    jobStore = new PostgresJobStore(poolA);
    await jobStore.init();
  });

  beforeEach(() => {
    vi.mocked(verifyX402Payment).mockReset();
  });

  afterEach(async () => {
    await servers.closeAll();
    await poolA.query("DELETE FROM job_messages");
    await poolA.query("DELETE FROM jobs WHERE id LIKE 'cap-%'");
    await poolA.query("DELETE FROM processed_payments WHERE dvm_id = $1", [DVM_ID]);
    for (const table of ["credit_drains", "credit_draws", "credits"]) {
      await poolA.query(
        `DELETE FROM ${table} WHERE credit_id LIKE 'cap-credit-%' OR credit_id LIKE 'imp:%:cap-%'`
      );
    }
  });

  afterAll(async () => {
    await poolA.end();
    await poolB.end();
  });

  function facilitatorSettlesPerHeader(
    settlements: Record<string, { txHash: string; msats: number }>
  ): void {
    vi.mocked(verifyX402Payment).mockImplementation(((payload: string) => {
      const s = settlements[payload] as { txHash: string; msats: number } | undefined;
      if (s === undefined) throw new Error(`no settlement configured for ${payload}`);
      return Promise.resolve({
        verified: true,
        amountMsats: s.msats,
        amountUsdcMicro: Math.round((s.msats / ASK_MSATS) * ASK_USDC),
        txHash: s.txHash,
      });
    }) as unknown as typeof verifyX402Payment);
  }

  function manager(
    ledger: CreditLedger,
    processedPayments: PostgresProcessedPaymentStore,
    opts: { fxFetcher?: FxFetcher; pricingCurrency?: string } = {}
  ): JobManager<unknown, undefined> {
    const descriptor = configureDVM({
      name: "midjob-cap-test",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob: () => undefined,
    });
    return new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      fxFetcher: opts.fxFetcher ?? warmFetcher(),
      pricingCurrency: opts.pricingCurrency,
      dvmId: DVM_ID,
      x402: X402,
      creditLedger: ledger,
      processedPayments,
      orphanDrawSweepIntervalMs: 0,
      staleJobTimeoutMs: 0,
      processingWatchdogMs: 0,
      heartbeatIntervalMs: 0,
    });
  }

  // Rebuild from persisted state to exercise the asked-topup total round-trip.
  async function seedBoundJob(
    jobId: string,
    opts: {
      askedMicro?: number;
      outstandingMicro?: number;
      fundedMicro?: number;

      currency?: string;
      /**
       * Open the credit at the derived `imp:<rail>:<drawId>` id, so the job
       * reads as implicit N=1 — the ordinary per-job payment, and the shape
       * whose `DrawPool` carries no spendable fiat pool.
       */
      implicit?: boolean;

      askless?: boolean;
    } = {}
  ): Promise<{ job: ServerJob; creditId: string; drawId: string }> {
    const askedMicro = opts.askedMicro ?? ASK_MICRO;
    const outstandingMicro = opts.outstandingMicro ?? askedMicro;
    const currency = opts.currency ?? "usd";
    const drawId = `cap-draw-${jobId}`;
    const creditId = opts.implicit ? implicitCreditId("x402", drawId) : `cap-credit-${jobId}`;
    await ledgerA.fund({
      creditId,
      callerPubkey: CALLER,
      currency,
      amountMicro: opts.fundedMicro ?? UPFRONT_MICRO,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "x402", paidMsats: UPFRONT_MSATS, nativeAmount: 100_000, nativeAsset: "usdc" },
    });
    await ledgerA.draw({ creditId, drawId, amountMicro: UPFRONT_MICRO, jobId });

    const record: JobRecord = {
      id: jobId,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "requester-1",
      requesterPubkey: CALLER,
      status: "awaiting-input",
      messages: [],
      seq: 0,
      // An askless seed is a job whose upfront pool earlier stages already
      // consumed — otherwise the auto-credit short-circuit covers the
      // ask from `paidMsats`, no payment-request is emitted, and Tx A never runs.
      paidMsats: opts.askless ? 0 : UPFRONT_MSATS,
      ...(opts.askless
        ? {}
        : {
            pendingPaymentMsats: (outstandingMicro / ASK_MICRO) * ASK_MSATS,
            pendingPaymentFiatMicro: outstandingMicro,
            pendingPaymentFiatCurrency: currency,
          }),
      creditId,
      drawId,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await jobStore.save(record);
    // Tx A's write. `save` deliberately never touches these columns — the
    // transactional append path owns them — so the seed does it the same way.
    if (!opts.askless) {
      await poolA.query(
        "UPDATE jobs SET asked_topup_micro = $2, asked_topup_currency = $3 WHERE id = $1",
        [jobId, askedMicro, currency]
      );
    }

    const stored = await jobStore.get(jobId);
    if (!stored) throw new Error("seed job vanished");
    return { job: fromJobRecord(stored), creditId, drawId };
  }

  // Emit the ask through ctx.requestPayment so pinning, accumulation and persistence execute together.
  async function askThroughContext(
    seed: ServerJob,
    amount: number | { amount: number; currency: "usd" | "eur" },
    opts: { pool?: DrawPool; pricingCurrency?: string; fxFetcher?: FxFetcher } = {}
  ): Promise<ServerJob> {
    // Always from the committed row: a payment between two asks mutates the
    // in-memory job, and the durable denomination is what a reactivated handler
    // on another machine would read.
    const job = await reload(seed);
    job.messageAppender = (msg, appendOpts) => {
      const prev = job.messageAppenderTail ?? Promise.resolve();
      job.messageAppenderTail = prev.then(async () => {
        await jobStore.appendOutgoing(
          job.id,
          { from: msg.from, type: msg.type, timestamp: msg.timestamp, content: msg.content },
          appendOpts
        );
      });
    };
    const pool = opts.pool;
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: opts.fxFetcher ?? warmFetcher(),
      pricingCurrency: opts.pricingCurrency,
      ...(pool && { drawPool: () => Promise.resolve(pool) }),
    });
    void ctx.requestPayment(amount as number, "stage");

    await new Promise((r) => setTimeout(r, 0));
    await job.messageAppenderTail;
    if (!job.messages.some((m) => m.type === "payment-request")) {
      throw new Error("no payment-request emitted — the ask was auto-credited");
    }
    return reload(job);
  }

  async function reload(job: ServerJob): Promise<ServerJob> {
    const stored = await jobStore.get(job.id);
    if (!stored) throw new Error(`job ${job.id} row vanished`);
    const rebuilt = fromJobRecord(stored);
    rebuilt.creditId = job.creditId;
    rebuilt.drawId = job.drawId;
    return rebuilt;
  }

  async function capRow(
    jobId: string
  ): Promise<{ micro: number | null; currency: string | null; reason: string | null }> {
    const { rows } = await poolA.query<{
      asked_topup_micro: string | null;
      asked_topup_currency: string | null;
      topup_cap_unenforced_reason: string | null;
    }>(
      "SELECT asked_topup_micro, asked_topup_currency, topup_cap_unenforced_reason FROM jobs WHERE id = $1",
      [jobId]
    );
    if (!rows[0]) throw new Error(`job ${jobId} not found`);
    return {
      micro: rows[0].asked_topup_micro === null ? null : Number(rows[0].asked_topup_micro),
      currency: rows[0].asked_topup_currency,
      reason: rows[0].topup_cap_unenforced_reason,
    };
  }

  async function pay(
    jm: JobManager<unknown, undefined>,
    job: ServerJob,
    header: string
  ): Promise<Awaited<ReturnType<JobManager<unknown, undefined>["processPayment"]>>> {
    const body = { type: "payment" as const, content: { x402_payment: header } };
    const seq = await jm.recordInboundPending(job, body.type, body.content);
    return jm.processPayment(job, body, seq);
  }

  async function drawRow(
    creditId: string,
    drawId: string
  ): Promise<{ amount_micro: string; grown_micro: string; draw_msats: string }> {
    const { rows } = await poolA.query<{
      amount_micro: string;
      grown_micro: string;
      draw_msats: string;
    }>("SELECT amount_micro, grown_micro, draw_msats FROM credit_draws WHERE draw_id = $1", [
      drawId,
    ]);
    if (!rows[0]) throw new Error(`draw ${creditId}/${drawId} not found`);
    return rows[0];
  }

  it("grows the draw once when two payments for one ask race on two pools", async () => {
    const jobId = "cap-race-1";
    const { job, creditId, drawId } = await seedBoundJob(jobId);
    facilitatorSettlesPerHeader({
      "header-a": { txHash: "captx-race-a", msats: ASK_MSATS },
      "header-b": { txHash: "captx-race-b", msats: ASK_MSATS },
    });
    const jmA = manager(ledgerA, paymentsA);
    const jmB = manager(ledgerB, paymentsB);

    const jobB = { ...job, messages: [] } as ServerJob;

    let outcomes;
    try {
      outcomes = await Promise.all([pay(jmA, job, "header-a"), pay(jmB, jobB, "header-b")]);
    } finally {
      jmA.shutdown();
      jmB.shutdown();
    }

    expect(outcomes[0].error).toBeUndefined();
    expect(outcomes[1].error).toBeUndefined();

    const draw = await drawRow(creditId, drawId);
    expect(Number(draw.amount_micro)).toBe(UPFRONT_MICRO + ASK_MICRO);
    expect(Number(draw.grown_micro)).toBe(ASK_MICRO);

    const credit = await ledgerA.get(creditId);
    expect(credit?.balanceMicro).toBe(UPFRONT_MICRO + 2 * ASK_MICRO);
    expect(credit?.availableMicro).toBe(ASK_MICRO);

    const row = await jobStore.get(jobId);
    expect(row?.paidMsats).toBe(UPFRONT_MSATS + ASK_MSATS);
    expect(row?.pendingPaymentMsats).toBe(0);

    const named = outcomes.filter((o) => o.unappliedCredit);
    expect(named).toHaveLength(1);
    expect(named[0].unappliedCredit).toMatchObject({
      credit_id: creditId,
      credited_micro: ASK_MICRO,
      credit_currency: "usd",
    });
    expect(named[0].unappliedCredit?.hint).toContain('reclaim it now with op "drain"');
    expect(named[0].unappliedCredit?.hint).not.toContain("terminal status");
  });

  it("refuses a duplicate payment from a stale pre-payment job snapshot", async () => {
    // The duplicate uses a snapshot captured before the first payment; durable Tx C has already completed.
    const jobId = "cap-seq-open-1";
    const { job, creditId, drawId } = await seedBoundJob(jobId);
    facilitatorSettlesPerHeader({
      "header-a": { txHash: "captx-seqopen-a", msats: ASK_MSATS },
      "header-b": { txHash: "captx-seqopen-b", msats: ASK_MSATS },
    });
    const jm = manager(ledgerA, paymentsA);
    // A view of the job frozen before the first payment — the retry's snapshot
    // on a machine that never saw Tx C.
    const stale = { ...job, messages: [] } as ServerJob;

    let second;
    try {
      await pay(jm, job, "header-a");
      second = await pay(jm, stale, "header-b");
    } finally {
      jm.shutdown();
    }

    expect(second.error).toBeUndefined();
    const draw = await drawRow(creditId, drawId);
    expect(Number(draw.amount_micro)).toBe(UPFRONT_MICRO + ASK_MICRO);
    expect(Number(draw.grown_micro)).toBe(ASK_MICRO);
    expect(second.unappliedCredit).toMatchObject({
      credit_id: creditId,
      credited_micro: ASK_MICRO,
    });

    const row = await jobStore.get(jobId);
    expect(row?.paidMsats).toBe(UPFRONT_MSATS + ASK_MSATS);
  });

  it("keeps a retry that arrives after the ask cleared as reclaimable balance", async () => {
    // The other half of "sequential": the winner's Tx C landed and the ask is
    // gone, so there is nothing left to cap. The money is still the caller's —
    // it funds their credit rather than being kept with no ledger record.
    const jobId = "cap-seq-closed-1";
    const { job, creditId, drawId } = await seedBoundJob(jobId);
    facilitatorSettlesPerHeader({
      "header-a": { txHash: "captx-seqclosed-a", msats: ASK_MSATS },
      "header-b": { txHash: "captx-seqclosed-b", msats: ASK_MSATS },
    });
    const jm = manager(ledgerA, paymentsA);

    let second;
    try {
      await pay(jm, job, "header-a");
      expect(job.pendingPaymentMsats).toBe(0);

      second = await pay(jm, job, "header-b");
    } finally {
      jm.shutdown();
    }

    expect(second.error).toBeUndefined();
    const draw = await drawRow(creditId, drawId);
    expect(Number(draw.amount_micro)).toBe(UPFRONT_MICRO + ASK_MICRO);
    const credit = await ledgerA.get(creditId);
    expect(credit?.balanceMicro).toBe(UPFRONT_MICRO + 2 * ASK_MICRO);
    expect(credit?.availableMicro).toBe(ASK_MICRO);
    expect(second.unappliedCredit).toMatchObject({
      credit_id: creditId,
      credited_micro: ASK_MICRO,
    });
  });

  it("funds a settlement larger than the ask at the ask, so nothing needs clipping", async () => {
    // x402 funds the pinned ask even if the facilitator overreports; Cashu clipping is covered in credit-ledger.db.test.ts.
    const jobId = "cap-over-1";
    const { job, creditId, drawId } = await seedBoundJob(jobId);
    facilitatorSettlesPerHeader({
      "header-a": { txHash: "captx-over-a", msats: 3 * ASK_MSATS },
    });
    const jm = manager(ledgerA, paymentsA);

    let outcome;
    try {
      outcome = await pay(jm, job, "header-a");
    } finally {
      jm.shutdown();
    }

    expect(outcome.error).toBeUndefined();
    expect(outcome.unappliedCredit).toBeUndefined();
    const draw = await drawRow(creditId, drawId);
    expect(Number(draw.amount_micro)).toBe(UPFRONT_MICRO + ASK_MICRO);
    expect(Number(draw.grown_micro)).toBe(ASK_MICRO);

    const row = await jobStore.get(jobId);
    expect(row?.paidMsats).toBe(UPFRONT_MSATS + ASK_MSATS);
    expect(row?.pendingPaymentMsats).toBe(0);
    const credit = await ledgerA.get(creditId);
    expect(credit?.availableMicro).toBe(0);
  });

  describe("the ceiling holds in every denomination", () => {

    async function twoPaymentsForOneAsk(
      job: ServerJob,
      prefix: string,
      opts: { fxFetcher?: FxFetcher } = {}
    ) {
      facilitatorSettlesPerHeader({
        "header-a": { txHash: `captx-${prefix}-a`, msats: ASK_MSATS },
        "header-b": { txHash: `captx-${prefix}-b`, msats: ASK_MSATS },
      });
      const jm = manager(ledgerA, paymentsA, opts);
      // Frozen before the first payment moves anything — the retry's snapshot on
      // a machine that never saw Tx C, which is the window the cap
      // exists for. Taking it afterwards would test the satisfied-ask path.
      const stale = { ...job, messages: [] } as ServerJob;
      try {
        const first = await pay(jm, job, "header-a");
        const duplicate = await pay(jm, stale, "header-b");
        return { first, duplicate };
      } finally {
        jm.shutdown();
      }
    }

    it("bounds an implicit N=1 job whose credit is not denominated in USD", async () => {
      // Implicit N=1 has a rail pool, but its cap must still use the EUR credit denomination.
      const jobId = "cap-eur-implicit";
      const seeded = await seedBoundJob(jobId, {
        currency: "eur",
        implicit: true,
        askless: true,
      });
      const job = await askThroughContext(seeded.job, ASK_MSATS, {
        pool: { basis: "rail", creditCurrency: "eur" },
      });

      expect(await capRow(jobId)).toEqual({ micro: 40_000, currency: "eur", reason: null });

      const { first, duplicate } = await twoPaymentsForOneAsk(job, "eur-implicit");

      expect(first.unappliedCredit).toBeUndefined();
      expect(duplicate.unappliedCredit).toMatchObject({
        credit_id: seeded.creditId,
        credited_micro: 40_000,
        credit_currency: "eur",
      });

      expect(duplicate.unappliedCredit?.hint).toContain('reclaim it now with op "drain"');
      const draw = await drawRow(seeded.creditId, seeded.drawId);
      expect(Number(draw.grown_micro)).toBe(40_000);
      expect(Number(draw.amount_micro)).toBe(UPFRONT_MICRO + 40_000);
    });

    it("bounds a job whose asks name a currency its credit doesn't use", async () => {
      // The builder charges in dollars on a euro-denominated DVM. The wire ask
      // keeps their currency; only the ledger pin converts, on the same fx
      // snapshot that sized the ask's msats.
      const jobId = "cap-usd-ask-eur-credit";
      const seeded = await seedBoundJob(jobId, {
        currency: "eur",
        implicit: true,
        askless: true,
      });
      const job = await askThroughContext(
        seeded.job,
        { amount: 0.05, currency: "usd" },
        { pool: { basis: "rail", creditCurrency: "eur" } }
      );

      expect(await capRow(jobId)).toEqual({ micro: 40_000, currency: "eur", reason: null });

      const { duplicate } = await twoPaymentsForOneAsk(job, "usd-ask");
      expect(duplicate.unappliedCredit).toMatchObject({ credited_micro: 40_000 });
      expect(Number((await drawRow(seeded.creditId, seeded.drawId)).grown_micro)).toBe(40_000);
    });

    it("bounds a job that switches ask currency mid-flight", async () => {
      // Switching ask currency must convert into the credit denomination rather than poison the cumulative cap.
      const jobId = "cap-switch";
      const seeded = await seedBoundJob(jobId, { askless: true });
      facilitatorSettlesPerHeader({
        "header-a": { txHash: "captx-switch-a", msats: ASK_MSATS },
        "header-b": { txHash: "captx-switch-b", msats: ASK_MSATS },
        "header-c": { txHash: "captx-switch-c", msats: ASK_MSATS },
      });
      const jm = manager(ledgerA, paymentsA);

      try {
        const pool: DrawPool = { basis: "unpriced" };
        let job = await askThroughContext(seeded.job, { amount: 0.05, currency: "usd" }, { pool });
        expect(await capRow(jobId)).toEqual({ micro: ASK_MICRO, currency: "usd", reason: null });
        expect((await pay(jm, job, "header-a")).unappliedCredit).toBeUndefined();

        job = await askThroughContext(job, { amount: 0.04, currency: "eur" }, { pool });
        expect(await capRow(jobId)).toEqual({
          micro: 2 * ASK_MICRO,
          currency: "usd",
          reason: null,
        });

        const stale = { ...job, messages: [] } as ServerJob;
        expect((await pay(jm, job, "header-b")).unappliedCredit).toBeUndefined();
        const paidStages = await drawRow(seeded.creditId, seeded.drawId);
        expect(Number(paidStages.amount_micro)).toBe(UPFRONT_MICRO + 2 * ASK_MICRO);
        expect(Number(paidStages.grown_micro)).toBe(2 * ASK_MICRO);
        expect((await ledgerA.get(seeded.creditId))?.availableMicro).toBe(0);
        const duplicate = await pay(jm, stale, "header-c");
        expect(duplicate.unappliedCredit).toMatchObject({ credited_micro: ASK_MICRO });
      } finally {
        jm.shutdown();
      }

      expect(Number((await drawRow(seeded.creditId, seeded.drawId)).grown_micro)).toBe(
        2 * ASK_MICRO
      );
    });

    it.each([
      { name: "doubles", rate: 2 * RATE },
      { name: "halves", rate: RATE / 2 },
    ])("never clips a legitimate payment when the rate $name mid-ask", async ({ rate }) => {
      // Payment-time FX changes must not shrink the pinned ceiling and leave a paid handler suspended.
      const jobId = `cap-rate-${rate}`;
      const { fetcher, setUsdRate } = mutableFetcher();
      const seeded = await seedBoundJob(jobId, { askless: true });
      const job = await askThroughContext(
        seeded.job,
        { amount: 0.05, currency: "usd" },
        { fxFetcher: fetcher }
      );
      expect(await capRow(jobId)).toEqual({ micro: ASK_MICRO, currency: "usd", reason: null });

      setUsdRate(rate);
      facilitatorSettlesPerHeader({
        "header-a": { txHash: `captx-rate-${rate}`, msats: ASK_MSATS },
      });
      const jm = manager(ledgerA, paymentsA, { fxFetcher: fetcher });
      let outcome;
      try {
        outcome = await pay(jm, job, "header-a");
      } finally {
        jm.shutdown();
      }

      expect(outcome.error).toBeUndefined();
      expect(outcome.unappliedCredit).toBeUndefined();
      const draw = await drawRow(seeded.creditId, seeded.drawId);
      expect(Number(draw.grown_micro)).toBe(ASK_MICRO);

      expect((await jobStore.get(jobId))?.pendingPaymentMsats).toBe(0);
    });

    it("refuses x402 before opening a free-then-paid credit on a non-USD DVM", async () => {
      // EUR cap pinning does not make exact USDC funding valid; refusal must precede settlement.
      const jobId = "cap-free-then-paid";
      const record: JobRecord = {
        id: jobId,
        tags: [],
        capability: "test",
        input: "",
        params: {},
        requesterId: "requester-1",
        requesterPubkey: CALLER,
        status: "awaiting-input",
        messages: [],
        seq: 0,
        paidMsats: 0,
        receivedProofs: [],
        stepCache: [],
        state: {},
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
      await jobStore.save(record);
      const stored = await jobStore.get(jobId);
      if (!stored) throw new Error("seed job vanished");
      const job = await askThroughContext(fromJobRecord(stored), ASK_MSATS, {
        pricingCurrency: "eur",
        pool: { basis: "rail" },
      });

      expect(await capRow(jobId)).toEqual({ micro: 40_000, currency: "eur", reason: null });

      facilitatorSettlesPerHeader({
        "header-a": { txHash: "cap-free-a", msats: ASK_MSATS },
      });
      const jm = manager(ledgerA, paymentsA, { pricingCurrency: "eur" });
      let outcome;
      try {
        outcome = await pay(jm, job, "header-a");
      } finally {
        jm.shutdown();
      }

      expect(outcome.error).toMatchObject({
        status: 402,
        body: { error: "x402_not_offered", retryable: false },
      });
      expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
      const opened = await jobStore.get(jobId);
      expect(opened?.creditId).toBeUndefined();
      expect(opened?.pendingPaymentMsats).toBe(ASK_MSATS);
    });

    it("records on the job row why a job the rate provider failed is uncapped", async () => {
      const jobId = "cap-unpriceable";
      const seeded = await seedBoundJob(jobId, { askless: true });
      const job = await askThroughContext(seeded.job, ASK_MSATS, { fxFetcher: downFetcher });

      expect(await capRow(jobId)).toEqual({
        micro: -1,
        currency: null,
        reason: "ask_unpriceable",
      });

      const { first, duplicate } = await twoPaymentsForOneAsk(job, "unpriceable");

      // Failed pinning deliberately disables the cap; guessing could clip a legitimate payment.
      expect(first.unappliedCredit).toBeUndefined();
      expect(duplicate.unappliedCredit).toBeUndefined();
      expect((await jobStore.get(jobId))?.topUpCapUnenforcedReason).toBe("ask_unpriceable");
      expect(Number((await drawRow(seeded.creditId, seeded.drawId)).grown_micro)).toBe(
        2 * ASK_MICRO
      );
      expect(Number((await drawRow(seeded.creditId, seeded.drawId)).amount_micro)).toBe(
        UPFRONT_MICRO + 2 * ASK_MICRO
      );
    });
  });

  describe("the cumulative ask total Tx A writes", () => {

    async function ask(
      store: PostgresJobStore | MemoryJobStore,
      jobId: string,
      fiat?: { micro: number; currency: string }
    ): Promise<{ micro?: number; currency?: string; reason?: string }> {
      await store.appendOutgoing(
        jobId,
        {
          type: "payment-request",
          from: "provider",
          timestamp: 0,
          content: { amount_msats: ASK_MSATS },
        },
        {
          pendingPaymentDelta: ASK_MSATS,
          pendingPaymentFiatMicro: fiat?.micro,
          pendingPaymentFiatCurrency: fiat?.currency,
        }
      );
      const row = await store.get(jobId);
      return {
        micro: row?.askedTopUpMicro,
        currency: row?.askedTopUpCurrency,
        reason: row?.topUpCapUnenforcedReason,
      };
    }

    function blankRecord(jobId: string): JobRecord {
      return {
        id: jobId,
        tags: [],
        capability: "test",
        input: "",
        params: {},
        requesterId: "requester-1",
        status: "awaiting-input",
        messages: [],
        seq: 0,
        paidMsats: 0,
        receivedProofs: [],
        stepCache: [],
        state: {},
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      };
    }

    // Assert independent literal totals for both stores; agreement alone would miss a shared defect.
    it.each([
      {
        name: "sums same-currency asks",
        asks: [
          { micro: ASK_MICRO, currency: "usd" },
          { micro: ASK_MICRO, currency: "usd" },
        ],
        expected: 2 * ASK_MICRO,
        reason: undefined,
      },
      {
        name: "poisons on an ask that couldn't be priced in fiat",
        asks: [{ micro: ASK_MICRO, currency: "usd" }, undefined],
        expected: -1,
        reason: "ask_unpriceable",
      },
      {
        // Mixed-unit totals from older rows must fail closed instead of adding unlike denominations.
        name: "poisons on a currency switch reaching the store directly",
        asks: [
          { micro: ASK_MICRO, currency: "usd" },
          { micro: ASK_MICRO, currency: "eur" },
        ],
        expected: -1,
        reason: "ask_currency_switch",
      },
      {
        name: "keeps the poison sticky — a later priced ask can't revive it",
        asks: [
          { micro: ASK_MICRO, currency: "usd" },
          undefined,
          { micro: ASK_MICRO, currency: "usd" },
        ],
        expected: -1,
        reason: "ask_unpriceable",
      },
    ])("$name, identically in both stores", async ({ asks, expected, reason }) => {
      const jobId = `cap-asked-${expected}-${asks.length}`;
      const memory = new MemoryJobStore();
      await jobStore.save(blankRecord(jobId));
      await memory.save(blankRecord(jobId));

      let pg: { micro?: number; reason?: string } = {};
      let mem: { micro?: number; reason?: string } = {};
      for (const fiat of asks) {
        pg = await ask(jobStore, jobId, fiat);
        mem = await ask(memory, jobId, fiat);
      }
      expect(pg.micro).toBe(expected);
      expect(mem.micro).toBe(expected);

      expect(pg.reason).toBe(reason);
      expect(mem.reason).toBe(reason);
    });
  });

  describe("the refused money is reachable from durable state", () => {
    async function creditEndpoint(): Promise<string> {
      const dvm = configureDVM({
        name: "midjob-cap-credit",
        capability: "do",
        input: z.object({ q: z.string() }),
        price: "$0.10" as const,
        credit: { min: "$0.01", max: "$5.00" },
        auth: secp256k1Auth(),
        onJob: (ctx) => {
          ctx.complete("done");
        },
      });
      const { app } = await createDVMServer(dvm, {
        env: {},
        store: new MemoryKVStore(),
        jobStore,
        fxFetcher: warmFetcher(),
        creditLedger: ledgerA,
      });
      return servers.serve(app);
    }

    function creditCall(url: string, fields: Record<string, unknown>): Promise<Response> {
      return fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditSigner.signRequest(PRIVKEY, fields)),
      });
    }

    it("lists the over-ask balance under the caller's key and drains it immediately", async () => {
      const jobId = "cap-durable-1";
      const { job, creditId } = await seedBoundJob(jobId);
      facilitatorSettlesPerHeader({
        "header-a": { txHash: "captx-durable-a", msats: ASK_MSATS },
        "header-b": { txHash: "captx-durable-b", msats: ASK_MSATS },
      });
      const jm = manager(ledgerA, paymentsA);
      const second = { ...job, messages: [] } as ServerJob;
      try {
        await pay(jm, job, "header-a");

        await pay(jm, second, "header-b");

        const url = await creditEndpoint();
        const held = (await (await creditCall(url, { op: "balance" })).json()) as {
          credits: { credit_id: string; balance_micro: number; remaining_micro: number }[];
        };

        expect(held.credits.find((c) => c.credit_id === creditId)).toMatchObject({
          balance_micro: UPFRONT_MICRO + 2 * ASK_MICRO,
          remaining_micro: ASK_MICRO,
        });

        const res = await creditCall(url, {
          op: "drain",
          credit_id: creditId,
          drain: { drain_id: "d1", method: "cashu", payout: { refund_pubkey: REFUND_PUBKEY } },
        });
        const drained = (await res.json()) as { drain: Record<string, unknown> };
        expect(res.status).toBe(200);
        expect(drained.drain).toMatchObject({
          credit_id: creditId,
          amount_micro: ASK_MICRO,
          currency: "usd",
          status: "pending",
        });
      } finally {
        jm.shutdown();
      }
    });
  });
});
