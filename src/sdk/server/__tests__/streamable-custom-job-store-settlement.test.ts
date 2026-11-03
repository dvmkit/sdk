/*
 * A custom `StreamableJobStore` that keeps no piece accounting of its own (it reports no pieces
 * from `verifyAndCredit`) still settles by the piece: the SDK adds the piece to its own view of
 * the job and freezes the settlement on the terminal snapshot. Without that fallback the job
 * settled on the upfront draw alone and the builder was underpaid.
 */
import { describe, expect, it, vi } from "vitest";

import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import type { JobRecord, PaymentCreditDelta, VerifyAndCreditOptions, VerifyAndCreditResult } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

const X402: X402Config = { facilitator: "https://example.com/facilitator", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" };

/**
 * A streamable store whose transactions carry no piece accounting: `verifyAndCredit` reports no
 * pieces, and the snapshot's `pieces` and `settlement` are kept exactly as the SDK saved them.
 */
class PiecelessStreamableStore extends MemoryJobStore {
  rows = new Map<string, JobRecord>();
  override async save(record: JobRecord) {
    await super.save(record);
    this.rows.set(record.id, structuredClone(record));
  }
  override async get(id: string) {
    const record = await super.get(id);
    const row = this.rows.get(id);
    return record && row ? { ...record, pieces: row.pieces, settlement: row.settlement } : record;
  }
  /** No push channel: the paying request resumes the handler itself, in this process. */
  override subscribeNotifications() { return Promise.resolve(() => undefined); }
  override async verifyAndCredit(jobId: string, seq: number, credit: PaymentCreditDelta | null, opts?: VerifyAndCreditOptions): Promise<VerifyAndCreditResult> {
    const result = await super.verifyAndCredit(jobId, seq, credit && { ...credit, piece: undefined }, opts);
    const counters = { ...result.counters, pieces: undefined };
    return { ...result, counters };
  }
}

describe("a streamable custom job store that keeps no pieces of its own", () => {
  it("settles $0.10 upfront and a $0.20 piece finished at $0.05 as $0.15", async () => {
    const ledger = new MemoryCreditLedger();
    const jobStore = new PiecelessStreamableStore();
    let finish!: () => void;
    const working = new Promise<void>((resolve) => { finish = resolve; });
    const jm = new JobManager(configureDVM({
      name: "streamable-custom-store",
      capability: "work",
      onJob: async (ctx) => {
        await ctx.requestPayment({ amount: 0.2, currency: "usd" }, "piece 2");
        await working;
        ctx.complete("done", { finishedChargeMicro: 50_000 });
      },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore, creditLedger: ledger, dvmId: "dvm-1",
      processedPayments: new MemoryProcessedPaymentStore(), paymentMethods: ["x402"], x402: X402,
      fxFetcher: { fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
    });
    try {
      await ledger.fund({ creditId: "c1", callerPubkey: "aa".repeat(32), currency: "usd", amountMicro: 100_000,
        expiryMs: Date.now() + 86_400_000, basis: { rail: "x402", paidMsats: 100_000, fundingRef: "upfront" } });
      const job = jm.createJob({ input: "go" }, "test", {
        paidMsats: 100_000, receivedProofs: [], paymentRail: "x402", creditId: "c1", drawId: "d1", drawAmountMicro: 100_000,
      }, undefined, "work");
      await ledger.draw({ creditId: "c1", drawId: "d1", jobId: job.id, amountMicro: 100_000 });
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, "go"));
      await vi.waitFor(() => expect(job.pendingX402Nonce).toBeDefined());

      vi.mocked(verifyX402Payment).mockResolvedValueOnce({ verified: true, amountMsats: 200_000, amountUsdcMicro: 200_000, txHash: "0xpiece2" } as never);
      const payment = { type: "payment" as const, content: { x402_payment: header(job.pendingX402Nonce!) } };
      const seq = await jm.recordInboundPending(job, payment.type, payment.content);
      expect((await jm.processPayment(job, payment, seq)).error).toBeUndefined();
      await jm.dispatchMessage(job, payment.type, payment.content);
      finish();
      await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
      await job.terminalWork;

      expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({
        status: "settled", amountMicro: 150_000, partialSettle: { heldMicro: 300_000, releasedMicro: 150_000 },
      });
      expect(jobStore.rows.get(job.id)?.settlement).toEqual({ chargedMicro: 150_000, stoppedPiece: false });
      expect((await ledger.get("c1"))?.availableMicro).toBe(150_000);
    } finally {
      jm.shutdown();
    }
  });
});

function header(nonce: string): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: { from: "0xfrom", to: X402.payTo, value: "200000", validAfter: "0", validBefore: "9999999999", nonce },
    },
  });
}
