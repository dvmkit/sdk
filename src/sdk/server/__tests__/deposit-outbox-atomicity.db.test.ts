import pg from "pg";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { msatsToUsdc } from "../../../lib/currency";
import type { LightningBackend } from "../../../lib/lightning-backend";
import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { drawSettlementRef, fundingCommitment } from "../funding";
import { LightningReceive } from "../lightning-receive";
import {
  verifyIncomingPayment,
  type VerifyIncomingSnapshot,
  verifyUpfrontPayment,
} from "../payment";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const DVM_ID = "dvm-deposit-outbox";
const CALLER = "ab".repeat(32);
const RATE = 100_000;
const PRICE_MICRO = 100_000;
const PRICE_MSATS = 100_000;
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;
const DVM_SCHEMA = `dvm_deposit_outbox_${process.pid}`;
const AUTOWIRE_PRIVKEY = new Uint8Array(32).fill(13);
const AUTOWIRE_CALLER = Buffer.from(schnorr.getPublicKey(AUTOWIRE_PRIVKEY)).toString("hex");

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
const ARTIFACT = encodePayment({
  x402Version: X402_V1_VERSION,
  scheme: "exact",
  network: X402.network,
  payload: {
    signature: `0x${"44".repeat(65)}`,
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: X402.payTo,
      value: String(PRICE_MICRO),
      validAfter: "0",
      validBefore: "99999999999",
      nonce: `0x${"55".repeat(32)}`,
    },
  },
});

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: "2026-07-30T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

interface PendingDepositRow {
  payload: {
    dvmId: string;
    creditId: string;
    callerPubkey: string;
    fundingId: string;
    rail: string;
    amountMicro: number;
  };
}

describe.skipIf(!RUN)("— transactional deposit outbox", () => {
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let processed: PostgresProcessedPaymentStore;
  let reporter: RevenueReporter;

  beforeAll(async () => {
    await recreateSchema(DVM_SCHEMA);
    pool = await pinnedPool(DVM_SCHEMA);
    // Create a colliding platform table shape; reporter initialization must still choose its
    // SDK-owned queue.
    await pool.query(`
      CREATE TABLE pending_revenue_reports (
        id            TEXT PRIMARY KEY,
        payload       JSONB NOT NULL,
        source        TEXT NOT NULL,
        retry_count   INTEGER NOT NULL DEFAULT 0,
        next_retry_at BIGINT NOT NULL DEFAULT 0,
        last_error    TEXT,
        created_at    BIGINT NOT NULL
      )
    `);
    ledger = new CreditLedger(pool);
    processed = new PostgresProcessedPaymentStore(pool);
    reporter = new RevenueReporter(pool, "https://platform.invalid", "token");
    await Promise.all([ledger.init(), processed.init(), reporter.init()]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await pool.query("DELETE FROM pending_dvm_reports");
    await pool.query("DELETE FROM processed_payments WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM credit_invoices");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
  });

  afterAll(async () => {
    await pool.end();
    await dropSchemas(DVM_SCHEMA);
  });

  function settles(txHash: string, paidMsats = PRICE_MSATS): void {
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: paidMsats,
      amountUsdcMicro: msatsToUsdc(paidMsats, RATE),
      txHash,
      settleResponseHeader: "header",
    });
  }

  function upfrontOpts(txHash: string, dvmId = DVM_ID) {
    settles(txHash);
    return {
      requiredMsats: PRICE_MSATS,
      priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
      x402Payment: ARTIFACT,
      x402Config: X402,
      x402Resource: "https://dvm.test/v1/job",
      dvmId,
      jobId: `job-${txHash}`,
      callerPubkey: CALLER,
      creditLedger: ledger,
      processedPayments: processed,
      enqueueCreditDeposit: reporter.enqueueDeposit.bind(reporter),
    } as const;
  }

  async function pendingDeposits(): Promise<PendingDepositRow[]> {
    const { rows } = await pool.query<PendingDepositRow>(
      `SELECT payload FROM pending_dvm_reports
       WHERE kind = 'deposit' ORDER BY created_at`
    );
    return rows;
  }

  it("funds through the auto-wired reporter alongside the platform revenue table", async () => {
    const descriptor = configureDVM({
      name: "dvm-deposit-autowire",
      capability: "test",
      input: signedSchema,
      price: "$0.10",
      credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true },
      auth: secp256k1Auth(),
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    settles("0xautowire");
    const built = await createDVMServer(descriptor, {
      env: {
        DVMKIT_PLATFORM_TOKEN: "token",
        DVMKIT_PLATFORM_URL: "https://platform.invalid",
      },
      store: new MemoryKVStore(),
      db: pool,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: ledger,
      processedPayments: processed,
      x402: X402,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = String(input);
        if (url.endsWith("/verify")) {
          return new Response(JSON.stringify({ isValid: true }), { status: 200 });
        }
        if (url.endsWith("/settle")) {
          return new Response(JSON.stringify({ success: true, transaction: "0xautowire" }), {
            status: 200,
          });
        }
        throw new Error(`unexpected exact-settlement fetch ${url}`);
      })
    );

    try {
      expect(built.revenueReporterActive).toBe(true);
      const response = await built.app.request("/v1/credit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": ARTIFACT },
        body: JSON.stringify(
          creditSigner.signRequest(AUTOWIRE_PRIVKEY, {
            op: "fund",
            fund: {
              amount_micro: PRICE_MICRO,
              fund_id: "fund-autowire",
              commitment: fundingCommitment(ARTIFACT),
            },
          })
        ),
      });

      expect(response.status).toBe(200);
      expect(await pendingDeposits()).toEqual([
        {
          payload: expect.objectContaining({
            dvmId: DVM_ID,
            callerPubkey: AUTOWIRE_CALLER,
            fundingId: "0xautowire",
            rail: "x402",
            amountMicro: PRICE_MICRO,
          }),
        },
      ]);
      expect(
        await pool.query("SELECT 1 FROM pending_revenue_reports")
      ).toMatchObject({ rowCount: 0 });
    } finally {
      await built.shutdown();
    }
  });

  it("queues an upfront fund-and-draw before its rail transaction commits", async () => {
    const result = await verifyUpfrontPayment(upfrontOpts("0xupfront"));

    expect(result.error).toBeUndefined();
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          dvmId: DVM_ID,
          creditId: "imp:x402:0xupfront",
          callerPubkey: CALLER,
          fundingId: "0xupfront",
          rail: "x402",
          amountMicro: PRICE_MICRO,
        }),
      },
    ]);
  });

  it("queues a fund-only top-up once across a retry", async () => {
    const creditId = "credit-fund-only";
    const fundId = "fund-only-1";
    const opts = {
      ...upfrontOpts("0xfundonly"),
      fundOnly: {
        creditId,
        fundId,
        commitment: fundingCommitment(ARTIFACT),
        allowOneShotStablecoin: true,
      },
    } as const;
    const result = await verifyUpfrontPayment(opts);

    expect(result.error).toBeUndefined();
    expect(await ledger.getFunding({ creditId, fundId })).toBeDefined();
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          dvmId: DVM_ID,
          creditId,
          callerPubkey: CALLER,
          fundingId: "0xfundonly",
          amountMicro: PRICE_MICRO,
        }),
      },
    ]);

    const replay = await verifyUpfrontPayment(opts);
    expect(replay.error?.body.error).toBe("replay_rejected");
    expect(await pendingDeposits()).toHaveLength(1);
  });

  it("queues a mid-job top-up in the marker/fund/grow transaction", async () => {
    const creditId = "credit-mid-job";
    const drawId = "draw-mid-job";
    const jobId = "job-mid-job";
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: PRICE_MICRO,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: PRICE_MSATS,
        nativeAmount: PRICE_MICRO,
        nativeAsset: "usdc",
        fundingRef: "0xoriginal",
      },
    });
    await ledger.draw({ creditId, drawId, amountMicro: PRICE_MICRO, jobId });
    settles("0xmidjob", 50_000);
    const snapshot: VerifyIncomingSnapshot = {
      pendingPaymentMsats: 50_000,
      pendingPaymentFiatMicro: 50_000,
      pendingPaymentFiatCurrency: "usd",
      paymentRail: "x402",
      creditId,
      drawId,
      paymentTxHash: drawSettlementRef(DVM_ID, creditId, drawId),
      requesterPubkey: CALLER,
    };

    const result = await verifyIncomingPayment(
      { type: "payment", content: { x402_payment: ARTIFACT } },
      {
        x402Config: X402,
        resourcePath: `https://dvm.test/v1/job/${jobId}/messages`,
        dvmId: DVM_ID,
        jobId,
        creditLedger: ledger,
        processedPayments: processed,
        enqueueCreditDeposit: reporter.enqueueDeposit.bind(reporter),
      },
      snapshot
    );

    expect(result.error).toBeUndefined();
    expect((await ledger.getDraw({ creditId, drawId }))?.amountMicro).toBe(150_000);
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          dvmId: DVM_ID,
          creditId,
          callerPubkey: CALLER,
          fundingId: "0xmidjob",
          amountMicro: 50_000,
        }),
      },
    ]);
  });

  it("queues a Lightning settlement before the invoice transaction commits", async () => {
    const creditId = "credit-lightning";
    const fundId = "fund-lightning";
    const paymentHash = "hash-lightning";
    const settledAt = Date.now();
    await ledger.recordInvoice({
      creditId,
      fundId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: PRICE_MICRO,
      amountMsats: PRICE_MSATS,
      paymentHash,
      bolt11: "lnbcrt1depositfixture",
      expiresAt: FUTURE_MS,
    });
    const receive = await LightningReceive.create({
      backend: {
        lookupInvoice: () => Promise.resolve({ settled: true, settledAt }),
      } as unknown as LightningBackend,
    });

    const results = await receive?.settlePending(ledger, {
      callerPubkey: CALLER,
      creditId,
      creditTtlMs: FUTURE_MS - Date.now(),
      dvmId: DVM_ID,
      enqueueCreditDeposit: reporter.enqueueDeposit.bind(reporter),
    });

    expect(results?.[0]?.replayed).toBe(false);
    expect(await pendingDeposits()).toEqual([
      {
        payload: expect.objectContaining({
          dvmId: DVM_ID,
          creditId,
          callerPubkey: CALLER,
          fundingId: paymentHash,
          rail: "lightning",
          amountMicro: PRICE_MICRO,
        }),
      },
    ]);
  });

  it("rolls the rail marker, balance, and queue back when enqueue fails", async () => {
    const opts = upfrontOpts("0xrollback");
    const result = await verifyUpfrontPayment({
      ...opts,
      enqueueCreditDeposit: async (tx, payload) => {
        await reporter.enqueueDeposit(tx, payload);
        throw new Error("injected outbox failure");
      },
    });

    expect(result.error?.body.error).toBe("payment_invalid");
    expect(await ledger.get("imp:x402:0xrollback")).toBeUndefined();
    expect(
      await processed.get({ dvmId: DVM_ID, rail: "x402", paymentId: "0xrollback" })
    ).toBeUndefined();
    expect(await pendingDeposits()).toEqual([]);
  });

});
