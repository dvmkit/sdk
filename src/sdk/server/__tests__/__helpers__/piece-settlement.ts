/*
 * Charging by the piece, driven through the HTTP routes against either job store. The upfront
 * payment draws on a pre-funded credit; each mid-job ask is paid with an x402 payment whose
 * facilitator call is mocked, so every payment funds the credit and grows the draw for real.
 * Assertions read the ledger, the job row's frozen settlement and the signed receipt.
 */
import { randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";

import fixture from "../../../../../protocol-fixtures/piece-settlement-v1.json";
import type { JobReceipt } from "../../../../lib/receipt";
import { verifyReceipt } from "../../../../lib/receipt";
import { encodePayment } from "../../../../lib/x402/spec";
import { configureDVM } from "../../../configure";
import type { SDKJobContext } from "../../../types";
import { MemoryKVStore } from "../../../store";
import { createDVMServer } from "../../app";
import { ASK_EXPIRY_GRACE_MS } from "../../ask-expiry";
import type { CreditLedgerLike } from "../../credit-ledger";
import type { JobManagerOpts } from "../../job-manager";
import { JobEndedError, type StreamableJobStore } from "../../job-store";
import type { ProcessedPaymentStore } from "../../processed-payment-store";
import type { JobTerminalReportPayload } from "../../revenue-reporter";
import { secp256k1Auth } from "../../secp256k1-auth";
import { createSignedRequestVerifier } from "../../signed-request";

/** What one runner hands the suite: fresh stores per test. */
export interface PieceBackend {
  jobStore: StreamableJobStore;
  ledger: CreditLedgerLike;
  processedPayments?: ProcessedPaymentStore;
  /** Drop a job row's piece list, as a job accepted before piece accounting holds none. */
  forgetPieces(jobId: string): Promise<void>;
  close?: () => Promise<void> | void;
}

type VerifyX402 = Mock<(...args: unknown[]) => Promise<unknown>>;

const PRIVKEY = new Uint8Array(32).fill(9);
const CALLER = Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");
const DVM_ID = "piece-settlement-dvm";
const RATE = 100_000;
const IDLE_SECONDS = 60;

// The worked example: $0.10 upfront, then an ask for $0.20, then one for $0.50.
const UPFRONT = 100_000;
const ASK_2 = 200_000;
const ASK_3 = 500_000;

const signedSchema = z.object({
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
  action: z.string(),
  request_id: z.string().optional(),
});
const signer = createSignedRequestVerifier(signedSchema);
const usd = (micro: number) => ({ amount: micro / 1e6, currency: "usd" as const });

/** Test-controlled points in a handler's run. */
class Control {
  private gates = new Map<string, { open: () => void; promise: Promise<void> }>();
  private arrivals = new Map<string, { arrive: () => void; promise: Promise<void> }>();
  events: string[] = [];
  runs = 0;

  private gateFor(name: string) {
    let entry = this.gates.get(name);
    if (!entry) {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => { open = resolve; });
      entry = { open, promise };
      this.gates.set(name, entry);
    }
    return entry;
  }

  private arrivalFor(name: string) {
    let entry = this.arrivals.get(name);
    if (!entry) {
      let arrive!: () => void;
      const promise = new Promise<void>((resolve) => { arrive = resolve; });
      entry = { arrive, promise };
      this.arrivals.set(name, entry);
    }
    return entry;
  }

  /**
   * The handler waits here until the test opens the gate, or until the job is aborted when it
   * is given the job's signal.
   */
  async wait(name: string, signal?: AbortSignal): Promise<void> {
    this.arrivalFor(name).arrive();
    await Promise.race([
      this.gateFor(name).promise,
      ...(signal
        ? [new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            signal.addEventListener("abort", () => resolve(), { once: true });
          })]
        : []),
    ]);
  }

  open(name: string): void {
    this.gateFor(name).open();
  }

  reached(name: string): Promise<void> {
    return this.arrivalFor(name).promise;
  }
}

type Script = (ctx: SDKJobContext<unknown, { action: string }>, control: Control) => Promise<void>;

const SCRIPTS: Record<string, Script> = {
  complete: async (ctx) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.requestPayment(usd(ASK_3), "piece 3");
    ctx.complete("done");
  },
  "fail-piece-2": async (ctx, control) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await control.wait("piece 2", ctx.signal);
    ctx.fail("the provider broke");
  },
  "ask-3": async (ctx, control) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.requestPayment(usd(ASK_3), "piece 3");
    await control.wait("piece 3", ctx.signal);
    ctx.complete("done");
  },
  "cancel-piece-2": async (ctx, control) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await control.wait("piece 2", ctx.signal);
    if (ctx.signal.aborted) control.events.push("aborted");
    // A handler that keeps going after the cancel changes nothing.
    await ctx.requestPayment(usd(ASK_3), "piece 3").catch(() => control.events.push("late ask refused"));
    ctx.complete("late");
  },
  lowered: async (ctx) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.requestPayment(usd(ASK_3), "piece 3", { finishedChargeMicro: 50_000 });
    ctx.complete("done");
  },
  "over-price": async (ctx) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.requestPayment(usd(ASK_3), "piece 3", { finishedChargeMicro: ASK_2 + 1 })
      .catch((error: unknown) => { if (error instanceof RangeError) RECORDED.push("ask over price"); });
    try {
      ctx.complete("too dear", { finishedChargeMicro: ASK_2 + 1 });
    } catch (error) {
      if (error instanceof RangeError) RECORDED.push("complete over price");
    }
    ctx.complete("done");
  },
  "prompt-piece-2": async (ctx) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.prompt("more", "Keep going?");
    ctx.complete("done");
  },
  "prompt-after-gate": async (ctx, control) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    await control.wait("piece 2");
    await ctx.prompt("more", "Keep going?");
    ctx.complete("done");
  },
  "race-ask-3": async (ctx, control) => {
    await ctx.requestPayment(usd(ASK_2), "piece 2");
    // Deaf to the cancel, like a handler on a machine that has not heard of it yet.
    await control.wait("piece 2");
    await ctx.requestPayment(usd(ASK_3), "piece 3").catch(() => control.events.push("late ask refused"));
    ctx.complete("late");
  },
  "double-ask": async (ctx) => {
    const first = ctx.requestPayment(usd(ASK_2), "piece 2");
    await ctx.requestPayment(usd(ASK_2), "piece 2 again").catch((error: { code?: string }) => {
      RECORDED.push(String(error.code));
    });
    await first;
    ctx.complete("done");
  },
  "complete-with-ask-open": async (ctx, control) => {
    void ctx.requestPayment(usd(ASK_2), "piece 2").catch(() => control.events.push("ask withdrawn"));
    await control.wait("asked", ctx.signal);
    ctx.complete("done early");
  },
  "small-ask": async (ctx) => {
    await ctx.requestPayment(usd(50_000), "a piece cheaper than the upfront");
    ctx.complete("done");
  },
  single: async (ctx, control) => {
    await control.wait("work", ctx.signal);
    ctx.complete("done");
  },
};

/** Labels the over-price and double-ask scripts record about the errors they saw. */
const RECORDED: string[] = [];

/** Register the suite against one backend. */
export function pieceSettlementSuite(
  name: string,
  verifyX402: VerifyX402,
  backend: () => Promise<PieceBackend>
): void {
  describe(name, () => {
    const closers: (() => Promise<void> | void)[] = [];
    afterEach(async () => {
      vi.useRealTimers();
      RECORDED.length = 0;
      for (const close of closers.splice(0).reverse()) await close();
    });

    async function host() {
      const { jobStore, ledger, processedPayments, close, forgetPieces } = await backend();
      if (close) closers.push(close);
      const control = new Control();
      const terminals: JobTerminalReportPayload[] = [];
      const revenue: Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0][] = [];
      const run: Script = async (ctx, c) => {
        c.runs++;
        await SCRIPTS[ctx.input.action](ctx, c);
      };
      const dvm = configureDVM({
        name: "piece-settlement",
        idleTimeout: IDLE_SECONDS,
        auth: secp256k1Auth(),
        capabilities: {
          pieces: { input: signedSchema, price: "$0.10", onJob: (ctx) => run(ctx as never, control) },
        },
      });
      const server = await createDVMServer(dvm, {
        env: {},
        store: new MemoryKVStore(),
        jobStore,
        creditLedger: ledger,
        ...(processedPayments && { processedPayments }),
        dvmId: DVM_ID,
        receiptKey: "11".repeat(32),
        fxFetcher: { fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
        x402: { facilitator: "https://example.com/facilitator", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" },
        onJobCompleted: (info) => {
          revenue.push(info);
        },
      });
      closers.push(() => server.jobManager.shutdown());
      const jm = server.jobManager;
      // `createDVMServer` routes terminal reports to its Postgres outbox; capture them here instead.
      (jm as unknown as { opts: JobManagerOpts }).opts.onJobTerminal = (payload) => {
        terminals.push(payload);
        return Promise.resolve();
      };

      const request = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
        server.app.request(path, {
          method: init.method ?? (init.body === undefined ? "GET" : "POST"),
          headers: { "Content-Type": "application/json", ...(init.token && { "X-Job-Token": init.token }) },
          ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        });

      interface Job { job_id: string; job_token: string; creditId: string; drawId: string }

      /** Fund a credit with exactly the upfront price and submit a job that draws it. */
      const submit = async (action: string, extra: Record<string, unknown> = {}): Promise<Job> => {
        const creditId = `credit-${randomUUID()}`;
        const drawId = `draw-${randomUUID()}`;
        await ledger.fund({
          creditId, callerPubkey: CALLER, currency: "usd", amountMicro: UPFRONT, expiryMs: Date.now() + 86_400_000,
          basis: { rail: "x402", paidMsats: UPFRONT, fundingRef: `funding-${randomUUID()}` },
        });
        const res = await request("/v1/job", {
          body: {
            capability: "pieces",
            data: signer.signRequest(PRIVKEY, { action, credit_id: creditId, draw_id: drawId, ...extra }),
          },
        });
        expect(res.status).toBeLessThan(300);
        const body = (await res.json()) as { job_id: string; job_token: string };
        return { ...body, creditId, drawId };
      };

      const messages = async (job: Job) => {
        const res = await request(`/v1/job/${job.job_id}/messages`, { token: job.job_token });
        return ((await res.json()) as { messages: { seq: number; type: string; from: string; content: Record<string, unknown> }[] }).messages;
      };

      const asks = async (job: Job) => (await messages(job)).filter((m) => m.type === "payment-request");

      const until = async (check: () => Promise<boolean> | boolean, what: string) => {
        for (let i = 0; i < 400; i++) {
          if (await check()) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`timed out waiting for ${what}`);
      };

      const awaitAsks = (job: Job, count: number) =>
        until(async () => (await asks(job)).length >= count, `${count} payment request(s)`);

      /** Pay the job's latest ask with an x402 authorization bound to its nonce. */
      const pay = async (job: Job, nonce?: string) => {
        const ask = (await asks(job)).at(-1)!;
        const x402 = ask.content.x402 as { nonce: string; required_usdc_micro: string };
        const usdc = Number(x402.required_usdc_micro);
        verifyX402.mockResolvedValueOnce({ verified: true, amountMsats: usdc, amountUsdcMicro: usdc, txHash: `0x${randomUUID().replaceAll("-", "")}` });
        return request(`/v1/job/${job.job_id}/messages`, {
          token: job.job_token,
          body: { type: "payment", content: { x402_payment: header(nonce ?? x402.nonce, usdc) } },
        });
      };

      const status = async (job: Job) => {
        const res = await request(`/v1/job/${job.job_id}`, { token: job.job_token });
        return (await res.json()) as { status: string; receipt?: JobReceipt; ended_by?: string };
      };

      /** Wait for the terminal receipt, then read every place the settlement shows. */
      const settled = async (job: Job) => {
        let read: Awaited<ReturnType<typeof status>> | undefined;
        await until(async () => {
          read = await status(job);
          return ["completed", "failed", "cancelled"].includes(read.status) && !!read.receipt;
        }, "a terminal receipt");
        const draw = (await ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))!;
        const held = draw.partialSettle?.heldMicro ?? draw.amountMicro;
        const charged = draw.status === "settled" ? draw.amountMicro : 0;
        const row = (await jobStore.get(job.job_id))!;
        return {
          status: read!.status,
          receipt: read!.receipt!,
          draw,
          ledger: { held, charged, released: held - charged },
          available: (await ledger.get(job.creditId))!.availableMicro,
          row,
        };
      };

      return { jm, jobStore, ledger, control, terminals, revenue, request, submit, messages, asks, awaitAsks, pay, status, settled, until, forgetPieces };
    }

    /** The table's ledger outcome, checked in the ledger, on the row and in the signed receipt. */
    function expectSettlement(outcome: Awaited<ReturnType<Awaited<ReturnType<typeof host>>["settled"]>>, charged: number, released: number) {
      expect(outcome.ledger).toEqual({ held: charged + released, charged, released });
      // The caller funded exactly what it paid, so its balance after the job is what was released.
      expect(outcome.available).toBe(released);
      expect(outcome.row.settlement?.chargedMicro).toBe(charged);
      expect(verifyReceipt(outcome.receipt)).toBe(true);
      expect(outcome.receipt.credit?.amount).toBe(charged);
      expect(outcome.receipt.settlement).toMatchObject({ held: charged + released, charged, released });
      expect(outcome.receipt.settlement!.pieces.reduce((sum, piece) => sum + piece.charged, 0)).toBe(charged);
    }

    it.each([
      { ending: "completes", action: "complete", charged: 800_000, released: 0, finished: 3 },
      { ending: "the provider fails during the $0.20 piece", action: "fail-piece-2", charged: 100_000, released: 200_000, finished: 1 },
      { ending: "the caller declines the $0.50 ask", action: "ask-3", charged: 300_000, released: 0, finished: 2 },
      { ending: "the caller cancels during the $0.20 piece", action: "cancel-piece-2", charged: 300_000, released: 0, finished: 1 },
      { ending: "the $0.20 piece finishes at $0.05, then the job completes", action: "lowered", charged: 650_000, released: 150_000, finished: 3 },
    ])("worked example: $ending", async ({ action, charged, released, finished }) => {
      const h = await host();
      const job = await h.submit(action);
      await h.awaitAsks(job, 1);
      expect((await h.pay(job)).status).toBe(201);
      if (action === "complete" || action === "lowered" || action === "ask-3") {
        await h.awaitAsks(job, 2);
        if (action === "ask-3") {
          const declined = await h.request(`/v1/job/${job.job_id}/messages`, {
            token: job.job_token, body: { type: "decline", content: { reason: "too dear" } },
          });
          expect(declined.status).toBe(201);
        } else {
          expect((await h.pay(job)).status).toBe(201);
        }
      } else if (action === "fail-piece-2") {
        await h.control.reached("piece 2");
        h.control.open("piece 2");
      } else {
        await h.control.reached("piece 2");
        expect((await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })).status).toBe(200);
      }
      expectSettlement(await h.settled(job), charged, released);
      expect(h.terminals.length).toBeGreaterThan(0);
      for (const report of h.terminals) {
        expect(report).toMatchObject({ heldMicro: charged + released, finishedPieceCount: finished });
      }
    });

    it("a provider failure during piece 2 charges piece 1, as ask 2 said declining would", async () => {
      const h = await host();
      const job = await h.submit("fail-piece-2");
      await h.awaitAsks(job, 1);
      const ask2 = (await h.asks(job))[0];
      expect(ask2.content.charged_if_declined_micro).toBe(UPFRONT);
      await h.pay(job);
      await h.control.reached("piece 2");
      h.control.open("piece 2");
      const outcome = await h.settled(job);
      expect(outcome.status).toBe("failed");
      expectSettlement(outcome, UPFRONT, ASK_2);
      expect(outcome.receipt.settlement!.charged).toBe(ask2.content.charged_if_declined_micro);
      expect(outcome.receipt.settlement!.pieces).toEqual([
        { amount: UPFRONT, charged: UPFRONT, paid_seq: 0, state: "finished" },
        { amount: ASK_2, charged: 0, paid_seq: expect.any(Number) as number, state: "released" },
      ]);
    });

    it("a decline of ask 2 charges piece 1 only", async () => {
      const h = await host();
      const job = await h.submit("complete");
      await h.awaitAsks(job, 1);
      const ask = (await h.asks(job))[0];
      expect(Object.keys(ask.content)).toEqual(expect.arrayContaining(Object.keys(fixture.payment_request.content)));
      const declined = await h.request(`/v1/job/${job.job_id}/messages`, { token: job.job_token, body: fixture.decline.request });
      expect(declined.status).toBe(fixture.decline.response.status);
      expect(await declined.json()).toMatchObject({ seq: expect.any(Number) as number });
      const outcome = await h.settled(job);
      expect(outcome).toMatchObject({ status: "cancelled", receipt: { ended_by: "caller" } });
      expectSettlement(outcome, UPFRONT, 0);
    });

    it("ask 2 expiring 30 seconds after its deadline charges piece 1 only", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = await host();
      const job = await h.submit("complete");
      await h.awaitAsks(job, 1);
      const expiresAt = (await h.asks(job))[0].content.expires_at_ms as number;
      const live = h.jm.activeJobs.get(job.job_id)!;
      vi.setSystemTime(expiresAt + ASK_EXPIRY_GRACE_MS - 1);
      await h.jm.cancelJobIdle(live);
      expect((await h.status(job)).status).toBe("awaiting-input");
      vi.setSystemTime(expiresAt + ASK_EXPIRY_GRACE_MS);
      await h.jm.cancelJobIdle(live);
      const outcome = await h.settled(job);
      expect(outcome.status).toBe("cancelled");
      expectSettlement(outcome, UPFRONT, 0);
    });

    it("a cancel during piece 2 aborts the handler, charges pieces 1 and 2, and a later ask or completion changes nothing", async () => {
      const h = await host();
      const job = await h.submit("cancel-piece-2");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.control.reached("piece 2");
      expect((await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })).status).toBe(200);
      const outcome = await h.settled(job);
      await h.until(() => h.control.events.includes("late ask refused"), "the handler's late ask");
      expect(h.control.events).toEqual(["aborted", "late ask refused"]);
      expect(outcome).toMatchObject({ status: "cancelled", receipt: { ended_by: "caller", outcome: "cancelled" } });
      expectSettlement(outcome, UPFRONT + ASK_2, 0);
      expect(Object.keys(outcome.receipt.settlement!).sort()).toEqual(Object.keys(fixture.receipt.settlement).sort());
      expect(outcome.receipt.settlement!.pieces.map((piece) => piece.state)).toEqual(["finished", "stopped"]);
      const after = await h.settled(job);
      expect(after.status).toBe("cancelled");
      expect(after.draw).toEqual(outcome.draw);
      expect(await h.asks(job)).toHaveLength(1);
      // Re-reads repeat the report; the reporter's outbox keeps the first. Each says the same.
      expect(h.terminals.length).toBeGreaterThan(0);
      for (const report of h.terminals) {
        expect(Object.keys(report).sort()).toEqual(Object.keys(fixture.terminal_report).sort());
        expect(report).toMatchObject({
          jobId: job.job_id, outcome: "cancelled", endedBy: "caller", chargedMicro: UPFRONT + ASK_2, heldMicro: 300_000, finishedPieceCount: 1, currency: "usd", stoppedPiece: true,
        });
      }
    });

    it("a cancel during a single-piece job charges it", async () => {
      const h = await host();
      const job = await h.submit("single");
      await h.control.reached("work");
      expect((await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })).status).toBe(200);
      expectSettlement(await h.settled(job), UPFRONT, 0);
      expect(h.terminals.length).toBeGreaterThan(0);
      for (const report of h.terminals) {
        expect(report).toMatchObject({ heldMicro: 100_000, finishedPieceCount: 0, stoppedPiece: true });
      }
    });

    it.each([
      { end: "cancel", charged: UPFRONT + ASK_2, released: 0 },
      { end: "decline", charged: UPFRONT, released: ASK_2 },
    ])("a $end at a prompt inside piece 2 settles by the piece", async ({ end, charged, released }) => {
      const h = await host();
      const job = await h.submit("prompt-piece-2");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.until(async () => (await h.messages(job)).some((m) => m.type === "prompt"), "the prompt");
      const res = end === "cancel"
        ? await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })
        : await h.request(`/v1/job/${job.job_id}/messages`, { token: job.job_token, body: { type: "decline", content: {} } });
      expect(res.status).toBeLessThan(300);
      const outcome = await h.settled(job);
      expect(outcome.status).toBe("cancelled");
      expectSettlement(outcome, charged, released);
    });

    it("a cancel at ask 3 charges pieces 1 and 2", async () => {
      const h = await host();
      const job = await h.submit("ask-3");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.awaitAsks(job, 2);
      expect((await h.asks(job))[1].content.charged_if_declined_micro).toBe(UPFRONT + ASK_2);
      expect((await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })).status).toBe(200);
      const outcome = await h.settled(job);
      expectSettlement(outcome, UPFRONT + ASK_2, 0);
      // Ask 3 finished piece 2, so nothing was running for the cancel to stop.
      expect(h.terminals.length).toBeGreaterThan(0);
      for (const report of h.terminals) expect(report).toMatchObject({ stoppedPiece: false, chargedMicro: UPFRONT + ASK_2 });
    });

    it("an ask written after a durable cancel is refused and changes no piece", async () => {
      const h = await host();
      const job = await h.submit("race-ask-3");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.control.reached("piece 2");
      // The cancel commits on the store, as it would from another machine.
      expect(await h.jobStore.cancelJob(job.job_id, "cancelled elsewhere")).toBe(true);
      const frozen = (await h.jobStore.get(job.job_id))!;
      expect(frozen.pieces?.map((piece) => piece.state)).toEqual(["finished", "stopped"]);
      await expect(h.jobStore.appendOutgoing(job.job_id, {
        from: "provider", type: "payment-request", timestamp: 0, content: { amount_msats: 1, reason: "late" },
      }, { pendingPaymentDelta: 1 })).rejects.toBeInstanceOf(JobEndedError);
      h.control.open("piece 2");
      const outcome = await h.settled(job);
      expect((await h.jobStore.get(job.job_id))!.pieces).toEqual(frozen.pieces);
      expect(outcome.row.settlement).toEqual(frozen.settlement);
      expectSettlement(outcome, UPFRONT + ASK_2, 0);
      expect((await h.asks(job)).length).toBe(1);
    });

    it("finishedChargeMicro above the piece's price is rejected and charges nothing less", async () => {
      const h = await host();
      const job = await h.submit("over-price");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      const outcome = await h.settled(job);
      expect(RECORDED).toEqual(["ask over price", "complete over price"]);
      expect(await h.asks(job)).toHaveLength(1);
      expectSettlement(outcome, UPFRONT + ASK_2, 0);
    });

    it("refuses a second open ask with ask_already_open", async () => {
      const h = await host();
      const job = await h.submit("double-ask");
      await h.awaitAsks(job, 1);
      await h.until(() => RECORDED.length > 0, "the refused second ask");
      expect(RECORDED).toEqual(["ask_already_open"]);
      expect(await h.asks(job)).toHaveLength(1);
      await h.pay(job);
      expectSettlement(await h.settled(job), UPFRONT + ASK_2, 0);
    });

    it("completing with an ask open withdraws it, and a payment arriving after lands as balance", async () => {
      const h = await host();
      const job = await h.submit("complete-with-ask-open");
      await h.awaitAsks(job, 1);
      await h.control.reached("asked");
      h.control.open("asked");
      const outcome = await h.settled(job);
      expect(outcome.status).toBe("completed");
      expect(h.control.events).toEqual(["ask withdrawn"]);
      expectSettlement(outcome, UPFRONT, 0);
      const late = await h.pay(job);
      expect(late.status).toBe(201);
      expect(await late.json()).toMatchObject({ credit: { credited_micro: ASK_2 } });
      // The job's draw is untouched; the payment is the caller's balance.
      expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId })).toMatchObject({
        status: outcome.draw.status, amountMicro: UPFRONT, ledgerSeq: outcome.draw.ledgerSeq,
      });
    });

    it("never covers an ask with the upfront payment", async () => {
      const h = await host();
      const job = await h.submit("small-ask");
      await h.awaitAsks(job, 1);
      expect((await h.status(job)).status).toBe("awaiting-input");
      expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId })).toMatchObject({ amountMicro: UPFRONT, status: "pending" });
      await h.pay(job);
      expectSettlement(await h.settled(job), UPFRONT + 50_000, 0);
    });

    it("the inline finaliser and the late reconciler settle the same frozen figure and book one revenue row", async () => {
      const h = await host();
      const job = await h.submit("fail-piece-2");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.control.reached("piece 2");
      // The terminal funnel's resolutions fail, leaving the hold for the reconciler.
      let ledgerDown = true;
      const real = h.ledger.resolveDraw.bind(h.ledger);
      const resolve = vi.spyOn(h.ledger, "resolveDraw").mockImplementation((args) =>
        ledgerDown ? Promise.reject(new Error("ledger unavailable")) : real(args));
      h.control.open("piece 2");
      await h.until(async () => (await h.jobStore.get(job.job_id))!.status === "failed" && resolve.mock.calls.length > 0, "the failed resolution");
      await new Promise((r) => setTimeout(r, 20));
      expect((await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))!.status).toBe("pending");
      expect((await h.jobStore.get(job.job_id))!.settlement?.chargedMicro).toBe(UPFRONT);

      ledgerDown = false;
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(await h.jm.sweepOrphanDraws()).toEqual({ released: 0, reconciled: 1 });
      vi.useRealTimers();
      const outcome = await h.settled(job);
      // Every resolution, failed inline or reconciled late, asked for the one frozen figure.
      expect(new Set(resolve.mock.calls.map(([args]) => args.settleMicro))).toEqual(new Set([UPFRONT]));
      expectSettlement(outcome, UPFRONT, ASK_2);
      expect(h.revenue).toHaveLength(1);
      expect(h.revenue[0]).toMatchObject({ jobId: job.job_id, drawAmountMicro: UPFRONT });
    });

    it("request-resume on an ended job returns its receipt and runs the handler no more", async () => {
      const h = await host();
      const requestId = `req-${randomUUID().replaceAll("-", "")}`;
      const job = await h.submit("small-ask", { request_id: requestId });
      await h.awaitAsks(job, 1);
      await h.pay(job);
      const outcome = await h.settled(job);
      expect(h.control.runs).toBe(1);
      const resumed = await h.request(`/v1/request-resume/${requestId}`, {
        body: { capability: "pieces", data: signer.signRequest(PRIVKEY, { action: "small-ask", credit_id: job.creditId, draw_id: job.drawId, request_id: requestId }) },
      });
      expect(resumed.status).toBeLessThan(300);
      const body = (await resumed.json()) as { status: string; receipt: JobReceipt };
      expect(body.status).toBe("completed");
      expect(body.receipt).toEqual(outcome.receipt);
      await new Promise((r) => setTimeout(r, 20));
      expect(h.control.runs).toBe(1);
      expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId })).toEqual(outcome.draw);
    });

    it("refuses an x402 payment bound to another nonce before the facilitator is called", async () => {
      const h = await host();
      const job = await h.submit("small-ask");
      await h.awaitAsks(job, 1);
      const calls = verifyX402.mock.calls.length;
      const stray = await h.pay(job, `0x${"ab".repeat(32)}`);
      expect(stray.status).toBe(402);
      expect(await stray.json()).toMatchObject({ error: "payment_invalid", message: "x402 payment not bound to this job" });
      // Nothing moved: no settlement was asked for, and the credit took no money.
      expect(verifyX402.mock.calls.length).toBe(calls);
      expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId })).toMatchObject({ amountMicro: UPFRONT, status: "pending" });
      expect((await h.ledger.get(job.creditId))!.balanceMicro).toBe(UPFRONT);
      expect((await h.pay(job)).status).toBe(201);
      expectSettlement(await h.settled(job), UPFRONT + 50_000, 0);
    });

    it("settles a job accepted before piece accounting as one piece", async () => {
      for (const [end, charged, released] of [["cancel", UPFRONT, 0], ["fail", 0, UPFRONT]] as const) {
        const h = await host();
        const job = await h.submit(end === "cancel" ? "single" : "fail-piece-2");
        if (end === "cancel") await h.control.reached("work");
        else {
          await h.awaitAsks(job, 1);
          await h.pay(job);
          await h.control.reached("piece 2");
        }
        await h.forgetPieces(job.job_id);
        h.jm.activeJobs.get(job.job_id)!.pieces = undefined;
        if (end === "cancel") {
          expect((await h.request(`/v1/job/${job.job_id}`, { method: "DELETE", token: job.job_token })).status).toBe(200);
        } else {
          h.control.open("piece 2");
        }
        const outcome = await h.settled(job);
        // The whole hold is the one piece: a cancel charges it, a failure releases it.
        const held = end === "cancel" ? UPFRONT : UPFRONT + ASK_2;
        expect(outcome.ledger).toEqual({ held, charged: end === "cancel" ? charged : 0, released: end === "cancel" ? released : held });
        expect(outcome.row.settlement).toEqual({ whole: end === "cancel" ? "settle" : "release", stoppedPiece: end === "cancel" });
        expect(outcome.receipt.settlement).toMatchObject({ pieces: [] });
        expect(h.terminals.length).toBeGreaterThan(0);
        for (const report of h.terminals) {
          expect(report).toMatchObject({ heldMicro: held });
          expect(report).not.toHaveProperty("finishedPieceCount");
        }
      }
    });

    it("a prompt expiring inside piece 2 releases that piece rather than charging it", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const h = await host();
      const job = await h.submit("prompt-piece-2");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.until(async () => (await h.messages(job)).some((m) => m.type === "prompt"), "the prompt");
      const prompt = (await h.messages(job)).find((m) => m.type === "prompt")!;
      const expiresAt = prompt.content.expires_at_ms as number;
      const live = h.jm.activeJobs.get(job.job_id)!;
      vi.setSystemTime(expiresAt + ASK_EXPIRY_GRACE_MS - 1);
      await h.jm.cancelJobIdle(live);
      expect((await h.status(job)).status).toBe("awaiting-input");
      vi.setSystemTime(expiresAt + ASK_EXPIRY_GRACE_MS);
      await h.jm.cancelJobIdle(live);
      const outcome = await h.settled(job);
      expect(outcome.status).toBe("cancelled");
      // A cancel would have stopped piece 2 and charged it; an expiry releases it.
      expectSettlement(outcome, UPFRONT, ASK_2);
      expect(outcome.receipt.settlement!.pieces.map((piece) => piece.state)).toEqual(["finished", "released"]);
      expect(outcome.row.settlement?.stoppedPiece).toBe(false);
    });

    it("ends a job at a decline sent to a machine not running its handler", async () => {
      const h = await host();
      const job = await h.submit("prompt-after-gate");
      await h.awaitAsks(job, 1);
      await h.pay(job);
      await h.control.reached("piece 2");
      // The handler keeps running, but this machine no longer holds the job: requests take the store path.
      h.jm.activeJobs.delete(job.job_id);
      h.jm.unwatchDurableStatus(job.job_id);
      h.jm.clearIdleTimer(job.job_id);
      const decline = () => h.request(`/v1/job/${job.job_id}/messages`, { token: job.job_token, body: fixture.decline.request });

      const early = await decline();
      expect(early.status).toBe(409);
      expect(await early.json()).toEqual(fixture.decline.no_open_ask.body);
      expect((await h.jobStore.get(job.job_id))!.status).not.toBe("cancelled");

      h.control.open("piece 2");
      await h.until(async () => (await h.jobStore.getMessages(job.job_id, 0)).some((m) => m.type === "prompt"), "the prompt");
      const declined = await decline();
      expect(declined.status).toBe(fixture.decline.response.status);
      expect(await declined.json()).toEqual({ seq: expect.any(Number) as number });
      const outcome = await h.settled(job);
      expect(outcome).toMatchObject({ status: "cancelled", receipt: { ended_by: "caller" } });
      expectSettlement(outcome, UPFRONT, ASK_2);
      expect(outcome.row.pieces?.map((piece) => piece.state)).toEqual(["finished", "released"]);

      const again = await decline();
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: "job_not_active" });
      expect(await h.ledger.getDraw({ creditId: job.creditId, drawId: job.drawId })).toEqual(outcome.draw);
    });

    it("refuses a decline when no ask or prompt is open", async () => {
      const h = await host();
      const job = await h.submit("single");
      await h.control.reached("work");
      const res = await h.request(`/v1/job/${job.job_id}/messages`, { token: job.job_token, body: fixture.decline.request });
      expect(res.status).toBe(fixture.decline.no_open_ask.status);
      expect(await res.json()).toEqual(fixture.decline.no_open_ask.body);
      h.control.open("work");
      expectSettlement(await h.settled(job), UPFRONT, 0);
    });
  });
}

/** An EIP-3009 payload carrying `nonce`; the facilitator's signature check is mocked. */
function header(nonce: string, usdcMicro: number): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: "0xfrom",
        to: "0x1111111111111111111111111111111111111111",
        value: String(usdcMicro),
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
      },
    },
  });
}

