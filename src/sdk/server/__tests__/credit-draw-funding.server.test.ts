/* HTTP drives a funded mid-job draw to terminal twice; the signed funding evidence must let the
 * real caller credit store reconcile both terminal receipts without a false warning. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const CONFIG_DIR = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dvm-draw-funding-")) as string;
  process.env.DVM_CONFIG_DIR = dir;
  return dir;
  /* eslint-enable @typescript-eslint/no-require-imports */
});

import { applyReceiptCredit, loadCredit, recordDrawFunding, recordFundResponse } from "../../../lib/credit-store";
import type { DrawFundingReceipt, JobReceipt } from "../../../lib/receipt";
import { verifyDrawFundingReceipt, verifyReceipt } from "../../../lib/receipt";
import { receiptPubkeyFromSecret } from "../../../lib/receipt-key";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const RECEIPT_KEY = "11".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const CREDIT_MICRO = 500_000;
const PRICE_MICRO = 100_000;
/** Above the upfront pool, so the handler genuinely suspends on a mid-job ask. */
const ASK_MSATS = 150_000;
const ASK_MICRO = 150_000;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const signer = createSignedRequestVerifier(signedSchema);
const PRIVKEY = new Uint8Array(32).fill(9);
const CALLER_PUBKEY = hex(schnorr.getPublicKey(PRIVKEY));

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const servers = servedApps();

interface Harness {
  url: string;
  ledger: MemoryCreditLedger;
  jobStore: MemoryJobStore;
}

async function startServer(shared?: Pick<Harness, "ledger" | "jobStore">): Promise<Harness> {
  const ledger = shared?.ledger ?? new MemoryCreditLedger();
  const jobStore = shared?.jobStore ?? new MemoryJobStore();
  const dvm = configureDVM({
    name: "draw-funding-test",
    capabilities: {
      metered: {
        input: signedSchema,
        price: "$0.10",
        async onJob(ctx) {
          await ctx.requestPayment(ASK_MSATS, "metered overage");
          ctx.complete("done");
        },
      },
    },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    fxFetcher: stubFx,
    dvmId: "dvm-1",
    creditLedger: ledger,
    receiptKey: RECEIPT_KEY,
    x402: X402,
  });
  const url = await servers.serve(app);
  return { url, ledger, jobStore };
}

interface SubmitBody {
  job_id: string;
  job_token?: string;
  status: string;
}

async function submit(url: string, drawId: string): Promise<SubmitBody> {
  const res = await fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "metered",
      data: signer.signRequest(PRIVKEY, { action: "go", credit_id: "c1", draw_id: drawId }),
    }),
  });
  expect(res.status).toBe(202);
  const job = (await res.json()) as SubmitBody;
  expect(job.status).toBe("awaiting-input");
  return job;
}

function authHeaders(job: SubmitBody): Record<string, string> {
  return job.job_token ? { "X-Job-Token": job.job_token } : {};
}

async function askedNonce(url: string, job: SubmitBody): Promise<string> {
  const res = await fetch(`${url}/v1/job/${job.job_id}/messages`, { headers: authHeaders(job) });
  const { messages } = (await res.json()) as {
    messages: { type: string; content: { x402?: { nonce?: string } } }[];
  };
  const nonce = messages.find((m) => m.type === "payment-request")?.content.x402?.nonce;
  if (!nonce) throw new Error("the mid-job ask carried no x402 nonce");
  return nonce;
}

async function payMidJob(url: string, job: SubmitBody, txHash: string): Promise<Response> {
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: ASK_MSATS,
    amountUsdcMicro: ASK_MICRO,
    txHash,
  } as Awaited<ReturnType<typeof verifyX402Payment>>);
  const nonce = await askedNonce(url, job);
  return fetch(`${url}/v1/job/${job.job_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(job) },
    body: JSON.stringify({ type: "payment", content: { x402_payment: paymentHeader(nonce) } }),
  });
}

function paymentHeader(nonce: string): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: "0xfrom",
        to: X402.payTo,
        value: String(ASK_MICRO),
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
      },
    },
  });
}

interface JobRead {
  status: string;
  receipt?: JobReceipt;
  draw_funding_receipts?: DrawFundingReceipt[];
}

async function readJob(url: string, job: SubmitBody): Promise<JobRead> {
  const res = await fetch(`${url}/v1/job/${job.job_id}`, { headers: authHeaders(job) });
  expect(res.status).toBe(200);
  return (await res.json()) as JobRead;
}

async function awaitTerminal(url: string, job: SubmitBody): Promise<JobRead> {
  for (let i = 0; i < 80; i++) {
    const body = await readJob(url, job);
    if (body.status === "completed" && body.receipt) return body;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job never produced a receipt");
}

/** One funded job: submit, pay the ask, run to terminal. Returns the 201 artifact and the terminal read. */
async function fundedJob(h: Harness, drawId: string, txHash: string) {
  const job = await submit(h.url, drawId);
  const paid = await payMidJob(h.url, job, txHash);
  expect(paid.status).toBe(201);
  const ack = (await paid.json()) as { seq: number; draw_funding_receipt?: DrawFundingReceipt };
  const terminal = await awaitTerminal(h.url, job);
  return { job, ack, terminal };
}

beforeEach(() => {
  vi.mocked(verifyX402Payment).mockReset();
  rmSync(join(CONFIG_DIR, "credits.json"), { force: true });
});

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

describe("mid-job funding evidence end to end", () => {
  it("acknowledges the funding with a signed fact the job read can recover after a restart", async () => {
    const h = await startServer();
    await h.ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: CREDIT_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 500_000, fundingRef: "0xupfront" },
    });

    const { job, ack, terminal } = await fundedJob(h, "d1", "0xfund-1");
    const receipt = ack.draw_funding_receipt;
    if (!receipt) throw new Error("the 201 carried no draw funding receipt");
    expect(verifyDrawFundingReceipt(receipt)).toBe(true);
    expect(receipt).toMatchObject({
      kind: "credit_draw_funding",
      credit_id: "c1",
      job_id: job.job_id,
      draw_id: "d1",
      fund_id: "0xfund-1",
      payment_seq: expect.any(Number),
      currency: "usd",
      funded_micro: ASK_MICRO,
      // 500k funded + 150k funded, 250k held by the grown draw.
      balance_after_micro: CREDIT_MICRO + ASK_MICRO - PRICE_MICRO - ASK_MICRO,
      ledger_seq: 1,
      caller_pubkey: CALLER_PUBKEY,
      dvm_id: "dvm-1",
      receipt_pubkey: receiptPubkeyFromSecret(RECEIPT_KEY),
    });
    expect(terminal.receipt?.credit).toMatchObject({
      draw_id: "d1",
      amount: PRICE_MICRO + ASK_MICRO,
      balance_after: CREDIT_MICRO + ASK_MICRO - PRICE_MICRO - ASK_MICRO,
      ledger_seq: 1,
    });
    expect(JSON.stringify(terminal.draw_funding_receipts)).toBe(JSON.stringify([receipt]));

    // A fresh process over the same durable stores: the acknowledgement is
    // gone, the row is not.
    const restarted = await startServer(h);
    const recovered = await readJob(restarted.url, job);
    expect(JSON.stringify(recovered.draw_funding_receipts)).toBe(JSON.stringify([receipt]));
  });

  it("lets the caller's shared store reconcile two funded draws without a false warning", async () => {
    const h = await startServer();
    await h.ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: CREDIT_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 500_000, fundingRef: "0xupfront" },
    });
    const seedStore = () =>
      recordFundResponse({
        endpoint: h.url,
        callerPubkey: CALLER_PUBKEY,
        credit: {
          credit_id: "c1",
          currency: "usd",
          balance_micro: CREDIT_MICRO,
          remaining_micro: CREDIT_MICRO,
          expiry_ms: FUTURE_MS,
          expired: false,
          drainable: true,
          ledger_seq: 0,
        },
        targetMicro: CREDIT_MICRO,
      });
    seedStore();

    const expectedAfter = [CREDIT_MICRO + ASK_MICRO - PRICE_MICRO - ASK_MICRO];
    expectedAfter.push(expectedAfter[0] + ASK_MICRO - PRICE_MICRO - ASK_MICRO);
    const runs: { ack: DrawFundingReceipt; terminal: JobRead; jobId: string }[] = [];
    for (const [index, drawId] of ["d1", "d2"].entries()) {
      const { job, ack, terminal } = await fundedJob(h, drawId, `0xfund-${drawId}`);
      if (!ack.draw_funding_receipt || !terminal.receipt?.credit) throw new Error("missing evidence");
      expect(verifyReceipt(terminal.receipt)).toBe(true);
      runs.push({ ack: ack.draw_funding_receipt, terminal, jobId: job.job_id });

      expect(
        recordDrawFunding({ endpoint: h.url, callerPubkey: CALLER_PUBKEY, receipt: ack.draw_funding_receipt })
      ).toMatchObject({ recorded: true });
      const applied = applyReceiptCredit({
        endpoint: h.url,
        callerPubkey: CALLER_PUBKEY,
        jobId: job.job_id,
        outcome: "completed",
        credit: terminal.receipt.credit,
      });
      expect(applied.mismatch).toBeUndefined();
      expect(applied.fundedMicro).toBe(ASK_MICRO);
      expect(loadCredit(h.url, CALLER_PUBKEY)).toMatchObject({
        remainingMicro: expectedAfter[index],
        ledgerSeq: index + 1,
      });
    }
    expect(loadCredit(h.url, CALLER_PUBKEY)?.discrepancy).toBeUndefined();

    // Control: the same signed trajectory with the evidence withheld is the
    // pre-fix path, and it still warns — the fix adds proof, not leniency.
    rmSync(join(CONFIG_DIR, "credits.json"), { force: true });
    seedStore();
    const unproven = applyReceiptCredit({
      endpoint: h.url,
      callerPubkey: CALLER_PUBKEY,
      jobId: runs[0].jobId,
      outcome: "completed",
      credit: runs[0].terminal.receipt!.credit!,
    });
    expect(unproven.mismatch).toMatchObject({
      expectedMicro: CREDIT_MICRO - PRICE_MICRO - ASK_MICRO,
      reportedMicro: expectedAfter[0],
    });
  });
});
