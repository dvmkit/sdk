/* The EUR arc checks the advertised, stored, drawn and reported denomination independently. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { msatsToUsdc } from "../../../lib/currency";
import type { JobReceipt } from "../../../lib/receipt";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { CreditLedgerLike } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId, fundingCommitment } from "../funding";
import type { JobManagerOpts } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import type { CreditDepositPayload } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const USD_RATE = 100_000;
const EUR_RATE = 90_000;
const stubFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({
      rates: { usd: USD_RATE, eur: EUR_RATE },
      as_of: "2026-07-28T00:00:00Z",
    }),
  supportedCurrencies: () => ["usd", "eur"],
};

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array(32).fill(13);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const ARTIFACT = "eyJ4NDAyIjoiZXVyIn0";
const COMMITMENT = fundingCommitment(ARTIFACT);
const RECEIPT_KEY = "22".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const JOB_MICRO = 200_000;

const TOPUP_MICRO = 1_000_000;
const TOPUP_MSATS = Math.ceil((1 * 1e8) / EUR_RATE) * 1000;

const jobSigner = createSignedRequestVerifier(signedSchema);
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const servers = servedApps();

interface Harness {
  url: string;
  ledger: CreditLedgerLike;
  deposits: CreditDepositPayload[];
  reports: RevenueReport[];
}

/**
 * A DVM that prices in `currency` via `onQuote`. Non-USD DVMs have no other
 * option — a static price is a USD literal, and `configureDVM` refuses one
 * alongside a non-USD declaration.
 */
async function startServer(currency: string): Promise<Harness> {
  const ledger = durableLedger();
  const deposits: CreditDepositPayload[] = [];
  const reports: RevenueReport[] = [];
  const dvm = configureDVM({
    name: "credit-currency-test",
    capability: "do",
    currency,
    input: signedSchema,
    onQuote: {
      schema: signedSchema,
      handler: () =>
        Promise.resolve({
          upfront: { amount: JOB_MICRO / 1_000_000, currency },
          description: "one unit",
        }),
    },
    onJob(ctx) {
      ctx.complete("done");
    },
    // This suite exercises exact x402 funding, so it opts into the manual
    // refund instrument explicitly; denomination behavior is its subject.
    credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: ledger,
    receiptKey: RECEIPT_KEY,
    x402: X402,
    dvmId: "dvm-credit-currency",
    onCreditFunded: (info) => {
      deposits.push(info);
    },
    onJobCompleted: (info) => {
      reports.push(info);
    },
  });
  const url = await servers.serve(app);
  return { url, ledger, deposits, reports };
}

function quote(url: string): Promise<Response> {
  return fetch(`${url}/v1/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "do",
      data: jobSigner.signRequest(PRIVKEY, { action: "go" }),
    }),
  });
}

function fundCall(url: string, fundId: string, creditId?: string): Promise<Response> {
  return fetch(`${url}/v1/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": ARTIFACT },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        ...(creditId ? { credit_id: creditId } : {}),
        fund: { amount_micro: TOPUP_MICRO, fund_id: fundId, commitment: COMMITMENT },
      })
    ),
  });
}

function drawJob(url: string, creditId: string, drawId: string): Promise<Response> {
  return fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "do",
      data: jobSigner.signRequest(PRIVKEY, {
        action: "go",
        credit_id: creditId,
        draw_id: drawId,
      }),
    }),
  });
}

function settles(paidMsats: number, txHash = "0xeur"): void {
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: paidMsats,
    amountUsdcMicro: msatsToUsdc(paidMsats, USD_RATE),
    txHash,
    settleResponseHeader: "hdr",
  });
}

/** The revenue and deposit callbacks fire fire-and-forget off their paths. */
function settleReports(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

interface FundBody {
  funded_micro: number;
  replayed: boolean;
  error?: string;
  message?: string;
  credit?: { credit_id: string; currency: string; balance_micro: number; remaining_micro: number };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a non-USD DVM funds and draws in its own denomination", () => {
  it("omits x402 and draws an EUR credit without changing denomination", async () => {
    const { url, ledger, reports } = await startServer("eur");

    const quoted = (await (await quote(url)).json()) as {
      upfront: { amount: number; currency: string };
      credit?: { currency: string; min_micro: number; max_micro: number };
    };
    expect(quoted.upfront).toEqual({ amount: 0.2, amount_micro: 200_000, currency: "eur" });
    expect(quoted.credit).toMatchObject({
      currency: "eur",
      min_micro: 90_000,
      max_micro: 4_500_000,
    });

    // 2. A stale client cannot fund the EUR credit through x402. The refusal
    // happens before settlement, then the fixture seeds the same ledger row
    // so the denomination arc through the draw remains covered.
    settles(TOPUP_MSATS);
    const refused = await fundCall(url, "f1");
    const refusal = (await refused.json()) as FundBody;
    expect(refused.status).toBe(402);
    expect(refusal.error).toBe("x402_not_offered");
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
    const creditId = derivedFundCreditId(CALLER, "f1");
    expect(await ledger.get(creditId)).toBeUndefined();
    await fundCredit(ledger, {
      creditId,
      callerPubkey: CALLER,
      currency: "eur",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
    });

    const minted = await ledger.get(creditId);
    expect(minted?.currency).toBe("eur");
    expect(minted?.balanceMicro).toBe(TOPUP_MICRO);

    const res = await drawJob(url, creditId, "d1");
    const body = (await res.json()) as { status?: string; receipt?: JobReceipt };
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.receipt?.credit).toMatchObject({
      credit_id: creditId,
      draw_id: "d1",
      amount: JOB_MICRO,
      balance_after: TOPUP_MICRO - JOB_MICRO,
    });

    const drawn = await ledger.get(creditId);
    expect(drawn?.currency).toBe("eur");
    expect(drawn?.balanceMicro).toBe(TOPUP_MICRO - JOB_MICRO);
    expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.status).toBe("settled");

    await settleReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ creditCurrency: "eur", drawAmountMicro: JOB_MICRO });
  });

  it("keeps the USD denomination behavior byte-identical", async () => {
    const { url, ledger } = await startServer("usd");

    const quoted = (await (await quote(url)).json()) as {
      upfront: { amount: number; currency: string };
      credit?: { currency: string; min_micro: number; max_micro: number };
    };
    expect(quoted.upfront).toEqual({ amount: 0.2, amount_micro: 200_000, currency: "usd" });

    expect(quoted.credit).toMatchObject({
      currency: "usd",
      min_micro: 100_000,
      max_micro: 5_000_000,
    });

    settles(Math.ceil((1 * 1e8) / USD_RATE) * 1000);
    const funded = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(funded.funded_micro).toBe(TOPUP_MICRO);
    expect((await ledger.get(derivedFundCreditId(CALLER, "f1")))?.currency).toBe("usd");
  });

  it("refuses to merge a top-up into a credit of another denomination, before the rail", async () => {
    const { url, ledger } = await startServer("eur");
    // A credit the caller legitimately holds — minted back when this DVM priced
    // in USD, say. Its value is still theirs (the drain is the exit),
    // but a EUR top-up must not be stacked onto it: the two amounts aren't
    // summable, and the balance would silently become fiction.
    await fundCredit(ledger, {
      creditId: "legacy-usd",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 400_000,
      expiryMs: FUTURE_MS,
    });
    settles(TOPUP_MSATS);

    const res = await fundCall(url, "f1", "legacy-usd");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(400);
    expect(body.error).toBe("payment_invalid");
    expect(body.message).toMatch(/denominated in usd, not eur/);

    expect(vi.mocked(verifyX402Payment).mock.calls.length).toBe(0);
    expect((await ledger.get("legacy-usd"))?.balanceMicro).toBe(400_000);
  });
});
