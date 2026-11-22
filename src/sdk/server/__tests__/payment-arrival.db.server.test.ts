/*
 * A payment that arrives as a job ends either pays the open ask or lands on
 * credit as balance, with a ledger row either way. Real local mint, real
 * P2PK-locked proofs, both job stores, the HTTP routes; time is faked through
 * `Date` alone so the mint and Postgres keep running underneath.
 */
import { randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import type { Message } from "../../../lib/messages/types";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { ASK_EXPIRY_GRACE_MS } from "../ask-expiry";
import { PAYMENT_INTENT_LEASE_MS } from "../payment-arrival";
import { CreditLedger, type CreditLedgerLike } from "../credit-ledger";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import type { JobStore } from "../job-store";
import { initLockPubkeyTable, seedLockPubkeyState } from "../lock-pubkey-store";
import { findLegacyRailAskPayment } from "../mandate-payment";
import { MemoryJobStore } from "../memory-job-store";
import { MintHealthTracker } from "../mint-health-tracker";
import { PostgresJobStore } from "../postgres-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { initWalletAccumulatorTable } from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN_DB = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const live = await localMintAvailable();

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};
const LOCK = Buffer.from(secp256k1.getPublicKey(Buffer.from("55".repeat(32), "hex"), true)).toString("hex");
const CALLER_KEY = Buffer.from("12".repeat(32), "hex");
const CALLER = Buffer.from(schnorr.getPublicKey(CALLER_KEY)).toString("hex");
// $0.016 at 100 000 USD/BTC is 16 sats: the upfront price and each ask.
const STEP_MICRO = 16_000;
const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

/** Delays a payment between its recorded arrival and its verification, on either store. */
interface Gate { hold?: Promise<void>; arrived?: () => void }
function gated<T extends { recordPaymentArrival: MemoryJobStore["recordPaymentArrival"] }>(store: T, gate: Gate): T {
  const record = store.recordPaymentArrival.bind(store);
  store.recordPaymentArrival = async (...args) => {
    const arrival = await record(...args);
    gate.arrived?.();
    await gate.hold;
    return arrival;
  };
  return store;
}

type Kind = "memory" | "postgres";

describe.skipIf(!live)("payments that arrive as a job ends", () => {
  const schema = `payment_arrival_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool | undefined;
  let pool: pg.Pool | undefined;
  const shutdowns: (() => void)[] = [];

  beforeAll(async () => {
    if (!RUN_DB) return;
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
    await new CreditLedger(pool).init();
    await new PostgresJobStore(pool).init();
    await initWalletAccumulatorTable(pool);
    await initLockPubkeyTable(pool);
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const shutdown of shutdowns.splice(0)) shutdown();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  async function host(kind: Kind, gate: Gate = {}, dvmId = `payment-arrival-${randomUUID()}`, omitMetered = false) {
    const dvm = configureDVM({
      name: "payment-arrival",
      idleTimeout: 60,
      capabilities: {
        ...(!omitMetered && { metered: {
          input: signedSchema,
          price: "$0.016",
          async onJob(ctx) {
            // The upfront payment is the pool this first step draws on.
            await ctx.requestPayment({ amount: 0.016, currency: "usd" }, "first step");
            await ctx.requestPayment({ amount: 0.016, currency: "usd" }, "second step");
            // Keeps the job live after the paid step, so a cancel still has a job to end.
            await ctx.prompt("continue", "Continue?");
            ctx.complete("done");
          },
        } }),
        sleeping: {
          input: signedSchema,
          price: "$0.016",
          async onJob(ctx) {
            await ctx.sleep("wait", 60_000);
            ctx.complete("done");
          },
        },
        // Free to start: the first mid-job payment opens the job's credit.
        "pay-later": {
          input: signedSchema,
          async onJob(ctx) {
            await ctx.requestPayment({ amount: 0.016, currency: "usd" }, "first step");
            ctx.complete("done");
          },
        },
      },
      auth: secp256k1Auth({ allowUnsignedPaid: true }),
    });
    let ledger: CreditLedgerLike;
    let jobStore: JobStore;
    let storage: Record<string, unknown>;
    if (kind === "postgres") {
      await seedLockPubkeyState(pool!, dvmId, LOCK);
      ledger = new CreditLedger(pool!);
      const store = gated(new PostgresJobStore(pool!), gate);
      await store.initStreaming();
      shutdowns.push(() => void store.shutdownStreaming());
      jobStore = store;
      storage = { db: pool };
    } else {
      const disposable = createDisposableCashuStore();
      ledger = disposable.ledger;
      jobStore = gated(new MemoryJobStore(), gate);
      storage = { disposableCashu: disposable.accumulator };
    }
    const mintHealthTracker = new MintHealthTracker({ mints: [LOCAL_MINT_URL] });
    await mintHealthTracker.runOnce();
    const { app, jobManager } = await createDVMServer(dvm, {
      env: {}, store: new MemoryKVStore(), jobStore, fxFetcher: fx, creditLedger: ledger,
      cashuMode: "p2pk-accumulator", dvmId, lockPubkey: LOCK, mints: [LOCAL_MINT_URL], mintHealthTracker, ...storage,
    });
    shutdowns.push(() => jobManager.shutdown());
    const request = async (path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> =>
      app.request(path, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "Content-Type": "application/json", ...init.headers },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
      });
    /** Bind the job to another credit, as the job's row and its live handler both see it. */
    const rebind = async (jobId: string, binding: { creditId: string; drawId: string; paymentRail: "x402" }) => {
      const live = jobManager.activeJobs.get(jobId)!;
      Object.assign(live, binding);
      if (kind === "postgres") {
        await pool!.query("UPDATE jobs SET credit_id=$2, draw_id=$3, payment_rail=$4 WHERE id=$1",
          [jobId, binding.creditId, binding.drawId, binding.paymentRail]);
      } else {
        await jobStore.save({ ...(await jobStore.get(jobId))!, ...binding });
      }
    };
    return { request, ledger, jobStore, rebind, jobManager, dvmId };
  }

  async function lockedProofs(count: number): Promise<Proof[][]> {
    const wallet = new Wallet(LOCAL_MINT_URL);
    await wallet.loadMint();
    const quote = await wallet.createMintQuoteBolt11(32 * count);
    let paid = await wallet.checkMintQuoteBolt11(quote.quote);
    for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      paid = await wallet.checkMintQuoteBolt11(quote.quote);
    }
    let proofs: Proof[] = await wallet.mintProofsBolt11(32 * count, paid);
    const sets: Proof[][] = [];
    for (let n = 0; n < count; n++) {
      const preview = await wallet.ops.send(16, proofs).asP2PK({ pubkey: LOCK }).includeFees(true).prepare();
      const swapped = await wallet.completeSwap(preview);
      sets.push(swapped.send);
      proofs = swapped.keep;
    }
    return sets;
  }

  const token = (proofs: Proof[]) => getEncodedToken({ mint: LOCAL_MINT_URL, proofs });

  /** Submit (paying upfront when given proofs), then wait for the job's first mid-job ask. */
  async function awaitingAsk(h: Awaited<ReturnType<typeof host>>, proofs: Proof[] | undefined, signed: boolean) {
    const data = signed
      ? createSignedRequestVerifier(signedSchema).signRequest(CALLER_KEY, { text: "go" })
      : { text: "go" };
    const res = await h.request("/v1/job", {
      body: { capability: proofs ? "metered" : "pay-later", data },
      ...(proofs && { headers: { "X-Cashu": token(proofs), "X-Cashu-Request-Id": randomUUID() } }),
    });
    expect(res.status).toBeLessThan(300);
    const { job_id, job_token } = (await res.json()) as { job_id: string; job_token: string };
    const headers = { "X-Job-Token": job_token };
    const ask = await vi.waitFor(async () => {
      const read = await h.request(`/v1/job/${job_id}/messages`, { headers });
      const asks = ((await read.json()) as { messages: Message[] }).messages
        .filter((message) => message.type === "payment-request");
      expect(asks).toHaveLength(1);
      return asks[0] as Message & { content: { expires_at_ms: number } };
    }, { timeout: 10_000 });
    const record = (await h.jobStore.get(job_id))!;
    return { jobId: job_id, headers, ask, creditId: record.creditId as string, drawId: record.drawId as string };
  }

  function pay(h: Awaited<ReturnType<typeof host>>, job: { jobId: string; headers: Record<string, string> }, proofs: Proof[], requestId: string) {
    return h.request(`/v1/job/${job.jobId}/messages`, {
      body: { type: "payment", content: { cashu_token: token(proofs), cashu_request_id: requestId } },
      headers: job.headers,
    });
  }

  async function seedMandate(job: Awaited<ReturnType<typeof awaitingAsk>>) {
    await pool!.query("UPDATE jobs SET mandate=$2 WHERE id=$1", [job.jobId, {
      credit_id: job.creditId,
      draw_id: job.drawId,
      max_total_micro: STEP_MICRO * 4,
      max_ask_micro: STEP_MICRO - 1,
      expires_at_ms: Date.now() + 60_000,
    }]);
  }

  const kinds: Kind[] = RUN_DB ? ["memory", "postgres"] : ["memory"];

  for (const kind of kinds) {
    describe(`${kind} job store`, () => {
      it("pays the ask with a signed Cashu payment 29 seconds past its deadline", async () => {
        const h = await host(kind);
        const [upfront, topUp] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, true);
        vi.useFakeTimers({ toFake: ["Date"], now: job.ask.content.expires_at_ms + ASK_EXPIRY_GRACE_MS - 1_000 });

        const paid = await pay(h, job, topUp!, randomUUID());
        expect(paid.status).toBe(201);
        expect(await paid.json()).not.toHaveProperty("credit");

        expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
          .toMatchObject({ status: "pending", amountMicro: 2 * STEP_MICRO });
        expect((await h.ledger.get(job.creditId))?.availableMicro).toBe(0);
        // The payment bought this step: the handler resumed into its prompt.
        await vi.waitFor(async () => expect(await h.jobStore.get(job.jobId))
          .toMatchObject({ paidMsats: 2 * STEP_MICRO, status: "awaiting-input" }));
      }, 30_000);

      it("lands a signed Cashu payment 31 seconds past the deadline as drainable balance on the job's credit", async () => {
        const h = await host(kind);
        const [upfront, late] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, true);
        vi.useFakeTimers({ toFake: ["Date"], now: job.ask.content.expires_at_ms + ASK_EXPIRY_GRACE_MS + 1_000 });
        const requestId = randomUUID();

        const paid = await pay(h, job, late!, requestId);
        expect(paid.status).toBe(201);
        expect(await paid.json()).toMatchObject({
          credit: { credit_id: job.creditId, credited_micro: STEP_MICRO, credit_currency: "usd" },
        });

        // Owned by the signer and held by no draw: the caller can drain it.
        expect(await h.ledger.get(job.creditId)).toMatchObject({ callerPubkey: CALLER, availableMicro: STEP_MICRO });
        expect(await h.ledger.getFunding({ creditId: job.creditId, fundId: requestId }))
          .toMatchObject({ amountMicro: STEP_MICRO });
        expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
          .toMatchObject({ status: "pending", amountMicro: STEP_MICRO });
        expect(await h.jobStore.get(job.jobId)).toMatchObject({
          status: "awaiting-input", paidMsats: STEP_MICRO, pendingPaymentMsats: STEP_MICRO,
        });
      }, 30_000);

      it("lands an unsigned late payment on its own credit, which no caller key owns", async () => {
        const h = await host(kind);
        const [upfront, late] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, false);
        vi.useFakeTimers({ toFake: ["Date"], now: job.ask.content.expires_at_ms + ASK_EXPIRY_GRACE_MS + 1_000 });
        const requestId = randomUUID();

        const paid = await pay(h, job, late!, requestId);
        expect(paid.status).toBe(201);
        const own = `imp:cashu:${requestId}`;
        expect(await paid.json()).toMatchObject({ credit: { credit_id: own, credited_micro: STEP_MICRO } });
        const credit = await h.ledger.get(own);
        expect(credit?.availableMicro).toBe(STEP_MICRO);
        expect(credit?.callerPubkey).toBeNull();
        expect((await h.ledger.get(job.creditId))?.availableMicro).toBe(0);
      }, 30_000);

      it("lands a Cashu payment for a job whose credit holds x402 as balance, leaving the ask open", async () => {
        const h = await host(kind);
        const [upfront, cashu] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, true);
        const creditId = `x402-credit-${randomUUID()}`;
        await h.ledger.fund({ creditId, callerPubkey: CALLER, currency: "usd", amountMicro: STEP_MICRO,
          expiryMs: Date.now() + 86_400_000, basis: { rail: "x402", paidMsats: STEP_MICRO, fundingRef: "0xupfront" } });
        await h.ledger.draw({ creditId, drawId: "x402-draw", amountMicro: STEP_MICRO, jobId: job.jobId });
        await h.rebind(job.jobId, { creditId, drawId: "x402-draw", paymentRail: "x402" });
        const requestId = randomUUID();

        const paid = await pay(h, job, cashu!, requestId);
        expect(paid.status).toBe(201);
        const own = `imp:cashu:${requestId}`;
        const body = (await paid.json()) as { credit: { credit_id: string; credited_micro: number; hint: string } };
        expect(body.credit).toMatchObject({ credit_id: own, credited_micro: STEP_MICRO });
        expect(body.credit.hint).toContain("x402");
        // On a credit the signer owns and nothing holds: drainable.
        expect(await h.ledger.get(own)).toMatchObject({ callerPubkey: CALLER, availableMicro: STEP_MICRO });
        expect(await h.ledger.listPendingDraws(own)).toEqual([]);
        expect(await h.ledger.getDraw({ creditId, drawId: "x402-draw" })).toMatchObject({ status: "pending", amountMicro: STEP_MICRO });
        // The ask is still owed and the handler did not resume past it.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(await h.jobStore.get(job.jobId)).toMatchObject({ status: "awaiting-input", pendingPaymentMsats: STEP_MICRO });
        const history = ((await (await h.request(`/v1/job/${job.jobId}/messages`, { headers: job.headers })).json()) as
          { messages: Message[] }).messages;
        expect(history.some((message) => message.type === "prompt")).toBe(false);

        // A replay on another machine must not count the landed payment as paying the ask.
        h.jobManager.activeJobs.delete(job.jobId);
        const resumed = await h.request(`/v1/job/${job.jobId}/messages`, {
          body: { type: "text", content: { text: "still there?" } }, headers: job.headers,
        });
        expect(resumed.status).toBe(201);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(await h.jobStore.get(job.jobId)).toMatchObject({ status: "awaiting-input", pendingPaymentMsats: STEP_MICRO });
        const replayed = ((await (await h.request(`/v1/job/${job.jobId}/messages`, { headers: job.headers })).json()) as
          { messages: Message[] }).messages;
        expect(replayed.some((message) => message.type === "prompt")).toBe(false);
      }, 30_000);

      it("pays the ask when the payment arrived before a racing cancel, which commits after it", async () => {
        const gate: Gate = {};
        let release!: () => void;
        gate.hold = new Promise((resolve) => { release = resolve; });
        const arrived = new Promise<void>((resolve) => { gate.arrived = resolve; });
        const h = await host(kind, gate);
        const [upfront, topUp] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, true);

        const paid = pay(h, job, topUp!, randomUUID());
        await arrived;
        let cancelled = false;
        const cancel = h.request(`/v1/job/${job.jobId}`, { method: "DELETE", headers: job.headers })
          .then((res) => { cancelled = true; return res; });
        await new Promise((resolve) => setTimeout(resolve, 400));
        // The open intent holds the cancel while the payment verifies.
        expect(cancelled).toBe(false);
        expect((await h.jobStore.get(job.jobId))?.status).toBe("awaiting-input");

        release();
        expect((await paid).status).toBe(201);
        expect((await cancel).status).toBe(200);
        await vi.waitFor(async () => expect((await h.jobStore.get(job.jobId))?.status).toBe("cancelled"));
        // Grown by the payment, which bought the piece the cancel then stopped: a cancel charges
        // every paid piece, so nothing goes back to balance.
        await vi.waitFor(async () => expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
          .toMatchObject({ status: "settled", amountMicro: 2 * STEP_MICRO }));
        expect((await h.ledger.get(job.creditId))?.availableMicro).toBe(0);
      }, 30_000);

      it("releases the draw a payment placed after its lease ran out and the job ended", async () => {
        const gate: Gate = {};
        let release!: () => void;
        gate.hold = new Promise((resolve) => { release = resolve; });
        const arrived = new Promise<void>((resolve) => { gate.arrived = resolve; });
        const h = await host(kind, gate);
        const [late] = await lockedProofs(1);
        const job = await awaitingAsk(h, undefined, true);
        const requestId = randomUUID();

        const paid = pay(h, job, late!, requestId);
        await arrived;
        // The verifier stalls past the arrival's lease, so the cancel no longer waits for it.
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + PAYMENT_INTENT_LEASE_MS });
        expect((await h.request(`/v1/job/${job.jobId}`, { method: "DELETE", headers: job.headers })).status).toBe(200);
        await vi.waitFor(async () => expect((await h.jobStore.get(job.jobId))?.status).toBe("cancelled"));
        release();

        const res = await paid;
        expect(res.status).toBe(201);
        const own = `imp:cashu:${requestId}`;
        expect(await res.json()).toMatchObject({ credit: { credit_id: own, credited_micro: STEP_MICRO } });
        // The ended job takes no binding and no payment; the draw placed for it is released at once.
        const ended = await h.jobStore.get(job.jobId);
        expect([ended?.status, ended?.paidMsats, ended?.creditId]).toEqual(["cancelled", 0, undefined]);
        expect(await h.ledger.getDraw({ creditId: own, drawId: requestId })).toMatchObject({ status: "released" });
        expect(await h.ledger.get(own)).toMatchObject({ callerPubkey: CALLER, availableMicro: STEP_MICRO });
      }, 30_000);

      it("lands a rail payment on a stored sleeper as balance without leaving a scaffold", async () => {
        const h = await host(kind);
        const [upfront, extra] = await lockedProofs(2);
        const data = createSignedRequestVerifier(signedSchema).signRequest(CALLER_KEY, { text: "go" });
        const response = await h.request("/v1/job", {
          body: { capability: "sleeping", data },
          headers: { "X-Cashu": token(upfront!), "X-Cashu-Request-Id": randomUUID() },
        });
        expect(response.status).toBe(202);
        const { job_id: jobId, job_token: tokenValue } = await response.json() as { job_id: string; job_token: string };
        const headers = { "X-Job-Token": tokenValue };
        await expect.poll(() => h.jobStore.get(jobId)).toMatchObject({ sleepId: "sleep:wait", status: "working" });
        const record = (await h.jobStore.get(jobId))!;
        const active = h.jobManager.activeJobs.get(jobId)!;
        h.jobManager.activeJobs.delete(jobId);
        try {
          const requestId = randomUUID();
          const paid = await pay(h, { jobId, headers }, extra!, requestId);
          expect(paid.status, await paid.clone().text()).toBe(201);
          expect(await paid.json()).toMatchObject({ credit: { credit_id: record.creditId, credited_micro: STEP_MICRO } });
          expect(h.jobManager.activeJobs.has(jobId)).toBe(false);
          expect(await h.ledger.getFunding({ creditId: record.creditId!, fundId: requestId }))
            .toMatchObject({ amountMicro: STEP_MICRO });
          expect(await h.jobStore.get(jobId)).toMatchObject({ sleepId: "sleep:wait", status: "working", paidMsats: STEP_MICRO });
        } finally {
          h.jobManager.activeJobs.set(jobId, active);
        }
      }, 30_000);

      it.skipIf(kind !== "postgres")("records a valid rail payment even on a worker without that capability", async () => {
        const first = await host(kind);
        const [upfront, extra] = await lockedProofs(2);
        const job = await awaitingAsk(first, upfront!, true);
        const other = await host(kind, {}, first.dvmId, true);
        const result = await pay(other, job, extra!, randomUUID());
        expect(result.status, await result.clone().text()).toBe(201);
        expect(await first.jobStore.get(job.jobId)).toMatchObject({ paidMsats: STEP_MICRO * 2 });
      }, 30_000);

      it.skipIf(kind !== "postgres").each([
        { intent: "exact", legacy: false },
        { intent: "legacy mandate", legacy: true },
      ])("recovers rail payment routed across deployments after the owner stopped ($intent)", async ({ legacy }) => {
        const owner = await host(kind);
        const [upfront, extra] = await lockedProofs(2);
        const job = await awaitingAsk(owner, upfront!, true);
        owner.jobManager.shutdown();
        await (owner.jobStore as PostgresJobStore).shutdownStreaming();
        const wrongHost = await host(kind, {}, owner.dvmId, true);
        const result = await pay(wrongHost, job, extra!, randomUUID());
        expect(result.status, await result.clone().text()).toBe(201);
        const { seq } = await result.json() as { seq: number };
        expect(await owner.jobStore.get(job.jobId)).toMatchObject({ paidMsats: STEP_MICRO * 2, status: "awaiting-input" });
        const accepted = await pool!.query("SELECT request_seq, outcome FROM job_payment_intents WHERE job_id=$1 AND seq=$2", [job.jobId, seq]);
        expect(accepted.rows).toEqual([{ request_seq: job.ask.seq, outcome: "ask_paid" }]);
        if (legacy) {
          // Before the migration, rail verification stored the payment without the ask sequence.
          await pool!.query("UPDATE job_payment_intents SET request_seq=NULL, outcome='verified' WHERE job_id=$1 AND seq=$2", [job.jobId, seq]);
          await seedMandate(job);
        }
        const recovered = await host(kind, {}, owner.dvmId);
        await recovered.jobManager.sweepMandateAsks(Date.now() + 60_000);
        await expect.poll(() => recovered.jobStore.get(job.jobId)).toMatchObject({
          status: "awaiting-input", pendingPaymentMsats: STEP_MICRO,
        });
        const response = await recovered.request(`/v1/job/${job.jobId}/messages`, { headers: job.headers });
        const { messages } = await response.json() as { messages: Message[] };
        expect(messages.filter(message => message.type === "payment-request")).toHaveLength(2);
        expect(messages.filter(message => message.from === "requester" && message.type === "payment").map(message => message.seq)).toEqual([seq]);
      }, 30_000);

      it.skipIf(kind !== "postgres")("replays the legacy rail payment that bought the piece when a later payment only funded balance", async () => {
        const owner = await host(kind);
        const [upfront, appliedProofs, depositProofs] = await lockedProofs(3);
        const job = await awaitingAsk(owner, upfront!, true);
        owner.jobManager.shutdown();
        await (owner.jobStore as PostgresJobStore).shutdownStreaming();

        const firstArrival = Promise.withResolvers<void>();
        const secondArrival = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        const releaseSecond = Promise.withResolvers<void>();
        const first = await host(kind, { arrived: firstArrival.resolve, hold: releaseFirst.promise }, owner.dvmId, true);
        const second = await host(kind, { arrived: secondArrival.resolve, hold: releaseSecond.promise }, owner.dvmId, true);
        const firstRequest = pay(first, job, appliedProofs!, randomUUID());
        let secondRequest: Promise<Response> | undefined;
        const depositId = randomUUID();
        try {
          await Promise.race([firstArrival.promise, firstRequest]);
          secondRequest = pay(second, job, depositProofs!, depositId);
          await Promise.race([secondArrival.promise, secondRequest]);
          // Both payments arrived during the ask. Only the first to grow the draw bought the piece.
          releaseFirst.resolve();
          const applied = await firstRequest;
          expect(applied.status, await applied.clone().text()).toBe(201);
          const { seq: paidSeq } = await applied.json() as { seq: number };
          releaseSecond.resolve();
          const deposit = await secondRequest;
          expect(deposit.status, await deposit.clone().text()).toBe(201);
          const { seq: depositSeq, credit } = await deposit.json() as { seq: number; credit: { credited_micro: number } };
          expect(depositSeq).toBeGreaterThan(paidSeq);
          expect(credit.credited_micro).toBe(STEP_MICRO);
          expect(await owner.jobStore.get(job.jobId)).toMatchObject({
            status: "awaiting-input", paidMsats: 2 * STEP_MICRO,
            pieces: [{ paidSeq: 0 }, { paidSeq }],
          });
          const legacy = await pool!.query(`UPDATE job_payment_intents SET request_seq=NULL, outcome='verified'
            WHERE job_id=$1 RETURNING seq, disposition`, [job.jobId]);
          expect(legacy.rows).toEqual(expect.arrayContaining([
            { seq: paidSeq, disposition: "ask" }, { seq: depositSeq, disposition: "ask" },
          ]));
          await seedMandate(job);

          expect(await findLegacyRailAskPayment(pool!, job.jobId, job.ask.seq)).toBe(paidSeq);
          expect(await findLegacyRailAskPayment(pool!, job.jobId, paidSeq)).toBeUndefined();
          const recovered = await host(kind, {}, owner.dvmId);
          await recovered.jobManager.sweepMandateAsks(Date.now() + 60_000);
          await expect.poll(() => recovered.jobStore.get(job.jobId)).toMatchObject({
            status: "awaiting-input", pendingPaymentMsats: STEP_MICRO, paidMsats: 2 * STEP_MICRO,
          });
          const { messages } = await (await recovered.request(`/v1/job/${job.jobId}/messages`, { headers: job.headers })).json() as { messages: Message[] };
          expect(messages.filter(message => message.type === "payment-request")).toHaveLength(2);
          expect(messages.filter(message => message.from === "requester" && message.type === "payment").map(message => message.seq))
            .toEqual([paidSeq, depositSeq]);
          expect(await recovered.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
            .toMatchObject({ status: "pending", amountMicro: 2 * STEP_MICRO });
        } finally {
          releaseFirst.resolve();
          releaseSecond.resolve();
          await Promise.allSettled([firstRequest, secondRequest]);
        }
      }, 30_000);

      it.skipIf(kind !== "postgres")("keeps the adopted handler when a rail payment already read the stored sleeper", async () => {
        const original = await host(kind);
        const [upfront, extra] = await lockedProofs(2);
        const data = createSignedRequestVerifier(signedSchema).signRequest(CALLER_KEY, { text: "go" });
        const response = await original.request("/v1/job", {
          body: { capability: "sleeping", data },
          headers: { "X-Cashu": token(upfront!), "X-Cashu-Request-Id": randomUUID() },
        });
        expect(response.status).toBe(202);
        const { job_id: jobId, job_token: jobToken } = await response.json() as { job_id: string; job_token: string };
        await expect.poll(() => original.jobStore.get(jobId)).toMatchObject({ sleepId: "sleep:wait" });
        original.jobManager.shutdown();
        const peer = await host(kind, {}, original.dvmId);
        const get = peer.jobStore.get.bind(peer.jobStore);
        const read = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const pause = vi.spyOn(peer.jobStore, "get").mockImplementationOnce(async (id) => {
          const record = await get(id);
          read.resolve();
          await release.promise;
          return record;
        });
        try {
          const payment = pay(peer, { jobId, headers: { "X-Job-Token": jobToken } }, extra!, randomUUID());
          await read.promise;
          await pool!.query("UPDATE jobs SET last_activity_at=$2 WHERE id=$1", [jobId, Date.now() - 301_000]);
          await peer.jobManager.sweepStaleJobs();
          const adopted = peer.jobManager.activeJobs.get(jobId);
          expect(adopted?.sleepGeneration).toBe(1);
          release.resolve();
          const paid = await payment;
          expect(paid.status, await paid.clone().text()).toBe(201);
          expect(await paid.json()).toMatchObject({ credit: { credited_micro: STEP_MICRO } });
          expect(peer.jobManager.activeJobs.get(jobId)).toBe(adopted);
        } finally {
          pause.mockRestore();
          release.resolve();
        }
      }, 30_000);

      it("lands a payment that arrives after a cancel commits as balance", async () => {
        const h = await host(kind);
        const [upfront, late] = await lockedProofs(2);
        const job = await awaitingAsk(h, upfront!, true);
        expect((await h.request(`/v1/job/${job.jobId}`, { method: "DELETE", headers: job.headers })).status).toBe(200);
        // The cancel at the open ask charges the upfront piece that ask finished.
        await vi.waitFor(async () => expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
          .toMatchObject({ status: "settled" }));
        const requestId = randomUUID();

        const paid = await pay(h, job, late!, requestId);
        expect(paid.status).toBe(201);
        expect(await paid.json()).toMatchObject({ credit: { credit_id: job.creditId, credited_micro: STEP_MICRO } });
        expect(await h.ledger.getFunding({ creditId: job.creditId, fundId: requestId }))
          .toMatchObject({ amountMicro: STEP_MICRO });
        expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
          .toMatchObject({ status: "settled", amountMicro: STEP_MICRO });
        expect((await h.ledger.get(job.creditId))?.availableMicro).toBe(STEP_MICRO);
        expect((await h.jobStore.get(job.jobId))?.status).toBe("cancelled");
      }, 30_000);
    });
  }
});
