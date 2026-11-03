import { describe, expect, it } from "vitest";

import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { buildContext, type CreditRail } from "../context";
import type { ServerJob } from "../job";

const X402: X402Config = { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:8453" };
const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-30T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

function blankJob(): ServerJob {
  return {
    id: "job-1", tags: [], capability: "test", input: "", params: {}, requesterId: "test", status: "processing",
    messages: [], seq: 0, paidMsats: 0, receivedProofs: [], listeners: new Set(), abort: new AbortController(),
    stepCache: new StepCache(), state: {}, pendingPrompts: new Map(), pendingPayment: null, replayHighSeq: null,
    replayProviderSkip: 0, replayPaymentIndex: 0, createdAt: 0, lastActivityAt: 0,
  };
}

/** Emit one ask and return what it offered, with the bindings the job kept for it. */
async function ask(creditRail: CreditRail | undefined) {
  const job = blankJob();
  const ctx = buildContext(job, {
    store: new MemoryKVStore(), env: {}, fxFetcher: fx, mints: ["https://mint.example.com"],
    paymentMethods: ["cashu", "x402"], x402: X402,
    creditRail: () => Promise.resolve(creditRail),
  });
  void ctx.requestPayment(1_000, "next step").catch(() => undefined);
  for (let n = 0; n < 50 && !job.messages.length; n++) await new Promise((resolve) => setTimeout(resolve, 1));
  const content = job.messages.find((message) => message.type === "payment-request")?.content as unknown as Record<string, unknown>;
  return { offers: { cashu: "mints" in content, x402: "x402" in content }, nonce: job.pendingX402Nonce, content };
}

describe("a mid-job ask on a job bound to a credit", () => {
  it("offers only Cashu when the job's credit holds Cashu, and binds x402 to a nonce it never shows", async () => {
    const { offers, nonce, content } = await ask("cashu");
    expect(offers).toEqual({ cashu: true, x402: false });
    // A cleared binding switched the job check off, so a stray x402 payment settled; an
    // unadvertised nonce makes the verifier refuse it before it reaches the facilitator.
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(JSON.stringify(content)).not.toContain(nonce!.slice(2));
  });

  it("offers only x402 when the job's credit holds x402", async () => {
    const { offers, nonce } = await ask("x402");
    expect(offers).toEqual({ cashu: false, x402: true });
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("offers every rail when the job holds no credit", async () => {
    expect((await ask(undefined)).offers).toEqual({ cashu: true, x402: true });
  });

  it("keeps every rail when the credit's rail is not one the ask can offer", async () => {
    // Withholding everything would strand the job; a mismatched payment still lands as balance.
    expect((await ask("tempo")).offers).toEqual({ cashu: true, x402: true });
  });
});
