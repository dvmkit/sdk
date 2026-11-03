/*
 * An ask on a job whose credit holds Cashu offers no x402, but the job stays bound to an x402
 * nonce nobody was shown. A stray x402 payment is refused before the facilitator is asked to
 * settle it; with no binding it would settle and land as balance on a fresh credit.
 */
import { describe, expect, it, vi } from "vitest";

import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

const X402: X402Config = { facilitator: "https://example.com/facilitator", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" };
const CALLER = "aa".repeat(32);

describe("an ask that withholds x402 from a job bound to a Cashu credit", () => {
  it("binds the job to an unadvertised nonce, so a stray x402 payment is refused before it settles", async () => {
    const ledger = new MemoryCreditLedger();
    const jobStore = new MemoryJobStore();
    let ask!: Promise<unknown>;
    const jm = new JobManager(configureDVM({
      name: "withheld-x402",
      capability: "work",
      onJob: (ctx) => { ask = ctx.requestPayment({ amount: 0.2, currency: "usd" }, "next piece"); return ask.then(() => undefined); },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore, creditLedger: ledger, dvmId: "dvm-1",
      mints: ["https://mint.example.com"], paymentMethods: ["cashu", "x402"], x402: X402,
      fxFetcher: { fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
    });
    try {
      await ledger.fund({ creditId: "c1", callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
        expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: 100_000 } });
      const job = jm.createJob({ input: "go" }, "test", {
        paidMsats: 100_000, receivedProofs: [], paymentRail: "cashu", creditId: "c1", drawId: "d1", drawAmountMicro: 100_000,
      }, undefined, "work");
      await ledger.draw({ creditId: "c1", drawId: "d1", jobId: job.id, amountMicro: 100_000 });
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, "go"));
      for (let i = 0; i < 50 && !job.messages.some((m) => m.type === "payment-request"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      await job.messageAppenderTail;
      const content = job.messages.find((m) => m.type === "payment-request")!.content as unknown as Record<string, unknown>;
      expect(content.x402).toBeUndefined();
      // The unadvertised nonce is what the job row holds, so it survives any machine's read.
      const stored = (await jobStore.get(job.id))!.pendingX402Nonce;
      expect(stored).toMatch(/^0x[0-9a-f]{64}$/);
      expect(stored).toBe(job.pendingX402Nonce);
      expect(JSON.stringify(content)).not.toContain(stored!.slice(2));

      const payment = { type: "payment" as const, content: { x402_payment: header(`0x${"cd".repeat(32)}`) } };
      const seq = await jm.recordInboundPending(job, payment.type, payment.content);
      const outcome = await jm.processPayment(job, payment, seq);
      expect(outcome.error).toMatchObject({ status: 402, body: { error: "payment_invalid", message: "x402 payment not bound to this job" } });
      expect(verifyX402Payment).not.toHaveBeenCalled();
      expect((await ledger.get("c1"))!.balanceMicro).toBe(100_000);
      expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({ amountMicro: 100_000, status: "pending" });
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
