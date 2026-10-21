/* Real Postgres: a mid-job rail payment must fix its funding row — with the job, draw and
 * payment bindings the signed evidence is issued from — inside the same transaction as the
 * processed-payment marker, the fund and the draw growth, and never twice. */
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { isDrawFundingReceipt, verifyDrawFundingReceipt } from "../../../lib/receipt";
import type { X402Config } from "../../../lib/x402/types";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { CreditLedger } from "../credit-ledger";
import { drawSettlementRef } from "../funding";
import { drawFundingReceiptFor } from "../funding-receipt";
import type { VerifyIncomingSnapshot } from "../payment";
import { verifyIncomingPayment } from "../payment";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { ReceiptIssuer } from "../receipt-issuer";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const RATE = 100_000;
const DVM_ID = "dvm-draw-funding-evidence";
const CALLER = "aa".repeat(32);
const JOB_ID = "dfe-job-1";
const CREDIT_ID = "dfe-credit-1";
const DRAW_ID = "dfe-draw-1";
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const UPFRONT_MICRO = 100_000;
const UPFRONT_MSATS = 100_000;
const TOPUP_MICRO = 50_000;
const TOPUP_MSATS = 50_000;
const TOPUP_TX = "0xdfe-midjob";

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const fetcher: FxFetcher = {
  fetch: () =>
    Promise.resolve({
      rates: { usd: RATE } as FxRateSnapshot["rates"],
      as_of: new Date(0).toISOString(),
    }),
  supportedCurrencies: () => ["usd"],
  lastKnown: () => null,
};

describe.skipIf(!RUN)("mid-job draw funding rows", () => {
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let payments: PostgresProcessedPaymentStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(pool);
    await ledger.init();
    payments = new PostgresProcessedPaymentStore(pool);
    await payments.init();
  });

  beforeEach(async () => {
    vi.mocked(verifyX402Payment).mockReset();
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: TOPUP_MSATS,
      amountUsdcMicro: TOPUP_MICRO,
      txHash: TOPUP_TX,
    } as Awaited<ReturnType<typeof verifyX402Payment>>);
    await ledger.fund({
      creditId: CREDIT_ID,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: UPFRONT_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: UPFRONT_MSATS, nativeAmount: 100_000, nativeAsset: "usdc", fundingRef: "0xdfe-upfront" },
    });
    await ledger.draw({ creditId: CREDIT_ID, drawId: DRAW_ID, amountMicro: UPFRONT_MICRO, jobId: JOB_ID });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM processed_payments WHERE dvm_id = $1", [DVM_ID]);
    for (const table of ["credit_fundings", "credit_draws", "credits"]) {
      await pool.query(`DELETE FROM ${table} WHERE credit_id = $1`, [CREDIT_ID]);
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  function snapshot(): VerifyIncomingSnapshot {
    return {
      pendingPaymentMsats: TOPUP_MSATS,
      pendingPaymentFiatMicro: TOPUP_MICRO,
      pendingPaymentFiatCurrency: "usd",
      paymentRail: "x402",
      creditId: CREDIT_ID,
      drawId: DRAW_ID,
      paymentTxHash: drawSettlementRef(DVM_ID, CREDIT_ID, DRAW_ID),
      requesterPubkey: CALLER,
    };
  }

  function pay(paymentSeq: number) {
    return verifyIncomingPayment(
      { type: "payment", content: { x402_payment: "base64_header" } },
      {
        x402Config: X402,
        dvmId: DVM_ID,
        jobId: JOB_ID,
        hostingPaymentSeq: paymentSeq,
        fxFetcher: fetcher,
        creditLedger: ledger,
        processedPayments: payments,
      },
      snapshot()
    );
  }

  it("fixes the funding tuple and bindings with the marker, the fund and the growth", async () => {
    const { verified, error } = await pay(4);
    expect(error).toBeUndefined();
    const rows = await ledger.listDrawFundings({ creditId: CREDIT_ID, drawId: DRAW_ID });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      creditId: CREDIT_ID,
      fundId: TOPUP_TX,
      amountMicro: TOPUP_MICRO,
      rail: "x402",
      callerPubkey: CALLER,
      balanceAfterMicro: 0,
      ledgerSeq: 1,
      jobId: JOB_ID,
      drawId: DRAW_ID,
      paymentSeq: 4,
      receipt: null,
    });
    expect(verified?.drawFunding).toEqual(rows[0]);
    const draw = await ledger.getDraw({ creditId: CREDIT_ID, drawId: DRAW_ID });
    expect(draw?.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("refuses a replayed payment without a second row and names the payment it collided on", async () => {
    await pay(4);
    const replay = await pay(5);
    expect(replay.error?.status).toBe(409);
    expect(replay.error?.body.error).toBe("replay_rejected");
    expect(replay.error?.replayPaymentId).toBe(TOPUP_TX);
    expect(await ledger.listDrawFundings({ creditId: CREDIT_ID, drawId: DRAW_ID })).toHaveLength(1);
    expect((await ledger.get(CREDIT_ID))?.balanceMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("rolls the funding row back with the transaction that recorded it", async () => {
    await expect(
      payments.withTx(async (tx) => {
        await ledger.recordFunding({
          creditId: CREDIT_ID,
          fundId: "0xdfe-rolled-back",
          amountMicro: TOPUP_MICRO,
          rail: "x402",
          jobId: JOB_ID,
          drawId: DRAW_ID,
          paymentSeq: 9,
          tx,
        });
        throw new Error("rail commit failed after the ledger leg");
      })
    ).rejects.toThrow("rail commit failed");
    expect(await ledger.getFunding({ creditId: CREDIT_ID, fundId: "0xdfe-rolled-back" })).toBeUndefined();
    expect(await ledger.listDrawFundings({ creditId: CREDIT_ID, drawId: DRAW_ID })).toHaveLength(0);
  });

  it("signs the evidence once from the committed row and returns the same bytes afterwards", async () => {
    const issuer = new ReceiptIssuer({ secret: "14".repeat(32), dvm: "evidence", dvmId: DVM_ID });
    const { verified } = await pay(4);
    if (!verified?.drawFunding) throw new Error("no funding row");

    const first = await drawFundingReceiptFor(ledger, issuer, verified.drawFunding, "usd");
    if (!first) throw new Error("no receipt issued");
    expect(verifyDrawFundingReceipt(first)).toBe(true);
    expect(first).toMatchObject({
      credit_id: CREDIT_ID,
      job_id: JOB_ID,
      draw_id: DRAW_ID,
      fund_id: TOPUP_TX,
      payment_seq: 4,
      currency: "usd",
      funded_micro: TOPUP_MICRO,
      balance_after_micro: 0,
      ledger_seq: 1,
      caller_pubkey: CALLER,
    });

    const later = new ReceiptIssuer({ secret: "15".repeat(32), dvm: "evidence", dvmId: DVM_ID });
    const stored = await ledger.getFunding({ creditId: CREDIT_ID, fundId: TOPUP_TX });
    if (!stored) throw new Error("funding row vanished");
    expect(isDrawFundingReceipt(stored.receipt)).toBe(true);
    const replayed = await drawFundingReceiptFor(ledger, later, stored, "usd");
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first));
  });
});
