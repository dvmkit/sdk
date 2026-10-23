/* HTTP drives upfront and mid-job payment to terminal; the signed receipt must attest the whole debit. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { JobReceipt } from "../../../lib/receipt";
import { verifyReceipt } from "../../../lib/receipt";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { JobManagerOpts } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];
type DepositReport = Parameters<NonNullable<JobManagerOpts["onCreditFunded"]>>[0];

const RATE = 100_000;
const RECEIPT_KEY = "11".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const PRICE_MICRO = 100_000;
const PRICE_MSATS = 100_000;
const TOPUP_MICRO = 500_000;
const TOPUP_MSATS = 500_000;
const TOPUP_TX = "0xmidjobsettlement";

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
  reports: RevenueReport[];
  deposits: DepositReport[];
}

async function startServer(): Promise<Harness> {
  const ledger = new MemoryCreditLedger();
  const reports: RevenueReport[] = [];
  const deposits: DepositReport[] = [];
  const dvm = configureDVM({
    name: "credit-midjob-test",
    capabilities: {
      metered: {
        input: signedSchema,
        price: "$0.10",
        async onJob(ctx) {
          // Exceeds the upfront pool, so it can't be auto-credited
          // and the handler genuinely suspends on a mid-job payment-request.
          await ctx.requestPayment(TOPUP_MSATS, "metered overage");
          ctx.complete("done");
        },
      },
    },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    dvmId: "dvm-1",
    creditLedger: ledger,
    receiptKey: RECEIPT_KEY,
    x402: X402,
    onJobCompleted: (info) => {
      reports.push(info);
    },
    onCreditFunded: (info) => {
      deposits.push(info);
    },
  });
  const url = await servers.serve(app);
  return { url, ledger, reports, deposits };
}

async function fundCredit(ledger: MemoryCreditLedger): Promise<void> {
  await ledger.fund({
    creditId: "c1",
    callerPubkey: CALLER_PUBKEY,
    currency: "usd",
    amountMicro: PRICE_MICRO,
    expiryMs: FUTURE_MS,
    basis: { rail: "x402", paidMsats: PRICE_MSATS, fundingRef: "0xupfront" },
  });
}

interface SubmitBody {
  job_id: string;
  job_token?: string;
  status: string;
}

async function submit(url: string): Promise<SubmitBody> {
  const res = await fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "metered",
      data: signer.signRequest(PRIVKEY, { action: "go", credit_id: "c1", draw_id: "d1" }),
    }),
  });

  expect(res.status).toBe(202);
  return (await res.json()) as SubmitBody;
}

// Bind the payment to the nonce in this job’s emitted payment-request; the facilitator signature is stubbed.
async function askedNonce(url: string, job: SubmitBody): Promise<string> {
  const res = await fetch(`${url}/v1/job/${job.job_id}/messages`, {
    headers: job.job_token ? { "X-Job-Token": job.job_token } : {},
  });
  const { messages } = (await res.json()) as {
    messages: { type: string; content: { x402?: { nonce?: string } } }[];
  };
  const nonce = messages.find((m) => m.type === "payment-request")?.content.x402?.nonce;
  if (!nonce) throw new Error("the mid-job ask carried no x402 nonce");
  return nonce;
}

async function payMidJob(url: string, job: SubmitBody): Promise<Response> {
  const nonce = await askedNonce(url, job);
  return fetch(`${url}/v1/job/${job.job_id}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(job.job_token && { "X-Job-Token": job.job_token }),
    },
    body: JSON.stringify({ type: "payment", content: { x402_payment: paymentHeader(nonce) } }),
  });
}

/** An EIP-3009 payload carrying `nonce`. Only the nonce is read — the
 * facilitator's signature check is mocked out above. */
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
        value: String(TOPUP_MICRO),
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
      },
    },
  });
}

async function awaitReceipt(url: string, job: SubmitBody): Promise<JobReceipt> {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${url}/v1/job/${job.job_id}`, {
      headers: job.job_token ? { "X-Job-Token": job.job_token } : {},
    });
    const body = (await res.json()) as { status: string; receipt?: JobReceipt };
    if (body.status === "completed" && body.receipt) return body.receipt;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job never produced a receipt");
}

beforeEach(() => {
  vi.mocked(verifyX402Payment).mockReset();
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: TOPUP_MSATS,
    amountUsdcMicro: TOPUP_MICRO,
    txHash: TOPUP_TX,
  } as Awaited<ReturnType<typeof verifyX402Payment>>);
});

describe("a mid-job top-up reaches the receipt and the books", () => {
  it("excludes a failed verification from GET history and accepts a later valid payment", async () => {
    const h = await startServer();
    await fundCredit(h.ledger);
    const job = await submit(h.url);
    const headers: Record<string, string> = job.job_token ? { "X-Job-Token": job.job_token } : {};
    async function history() {
      const response = await fetch(`${h.url}/v1/job/${job.job_id}/messages`, { headers });
      expect(response.status).toBe(200);
      return await response.json() as { messages: { from: string; type: string }[] };
    }
    vi.mocked(verifyX402Payment).mockResolvedValueOnce({ verified: false, amountMsats: 0 });
    const rejected = await payMidJob(h.url, job);
    expect(rejected.status).toBe(402);
    expect(await rejected.json()).toMatchObject({ error: "payment_invalid" });
    expect((await history()).messages.filter(message => message.type === "payment")).toEqual([]);
    expect(await h.ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({
      amountMicro: PRICE_MICRO, status: "pending",
    });

    expect((await payMidJob(h.url, job)).status).toBe(201);
    await awaitReceipt(h.url, job);
    expect((await history()).messages.filter(message => message.type === "payment"))
      .toEqual([expect.objectContaining({ from: "requester" })]);
    expect(await h.ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({
      amountMicro: PRICE_MICRO + TOPUP_MICRO, status: "settled",
    });
  });

  it("countersigns the full amount: upfront draw plus mid-job top-up", async () => {
    const h = await startServer();
    await fundCredit(h.ledger);
    const job = await submit(h.url);
    expect(job.status).toBe("awaiting-input");

    const paid = await payMidJob(h.url, job);
    expect(paid.status).toBe(201);

    const receipt = await awaitReceipt(h.url, job);
    expect(receipt.credit?.credit_id).toBe("c1");
    expect(receipt.credit?.draw_id).toBe("d1");
    expect(receipt.credit?.amount).toBe(PRICE_MICRO + TOPUP_MICRO);
    expect(receipt.credit?.balance_after).toBe(0);

    expect(receipt.credit?.ledger_seq).toBe(1);
    expect(verifyReceipt(receipt)).toBe(true);
    const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.status).toBe("settled");
    expect(draw?.amountMicro).toBe(PRICE_MICRO + TOPUP_MICRO);

    expect(draw?.railValue.drawMsats).toBe(PRICE_MSATS + TOPUP_MSATS);
    expect((await h.ledger.get("c1"))?.balanceMicro).toBe(0);
    await new Promise((r) => setTimeout(r, 25));

    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]).toMatchObject({
      jobId: job.job_id,
      rail: "x402",
      creditId: "c1",
      drawId: "d1",
      drawAmountMicro: PRICE_MICRO + TOPUP_MICRO,
      creditCurrency: "usd",
    });
    expect(h.reports[0].paidMsats).toBe(PRICE_MSATS + TOPUP_MSATS);
    expect(h.deposits).toHaveLength(1);
    expect(h.deposits[0]).toMatchObject({
      dvmId: "dvm-1",
      creditId: "c1",
      fundingId: TOPUP_TX,
      rail: "x402",
      amountMicro: TOPUP_MICRO,
      creditCurrency: "usd",
    });
  });

});
