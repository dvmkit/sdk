/* The facilitator is mocked; real ledger top-ups are checked separately from HTTP receipt/revenue wiring. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { X402Config } from "../../../lib/x402/types";
import { initLoggers } from "../../../observability/loggers";
import { SpanWriter } from "../../../observability/span-writer";
import type { SpanRow } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { isDrawFundingReceipt, verifyDrawFundingReceipt } from "../../../lib/receipt";
import { receiptPubkeyFromSecret } from "../../../lib/receipt-key";
import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { createFxFetcher, FxRateUnavailableError } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import type { CreditFundingBasis } from "../credit-ledger";
import { drawSettlementRef } from "../funding";
import type { ServerJob } from "../job";
import { JobManager } from "../job-manager";
import { UNCAPPABLE_ASK_TOTAL } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import type { VerifyIncomingSnapshot } from "../payment";
import { verifyIncomingPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import { ReceiptIssuer } from "../receipt-issuer";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");
const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");

const RATE = 100_000;
const DVM_ID = "dvm-1";
const CALLER = "aa".repeat(32);
const JOB_ID = "job-1";
// SHA-256 UTF-8 vector computed independently of the server logging implementation.
const JOB_ID_HASH = "026ab639c21df8aa80e5789370a9db1b8b524b776fd8a0c2ba71efb377ecc7d9";
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const UPFRONT_MICRO = 100_000;
const UPFRONT_MSATS = 100_000;
const TOPUP_MICRO = 50_000;
const TOPUP_MSATS = 50_000;
const TOPUP_USDC = 50_000;
const TOPUP_TX = "0xmidjobsettlement";

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111"
};

function warmFetcher(): FxFetcher {
  return {
    fetch: vi.fn(() =>
      Promise.resolve({
        rates: { usd: RATE, eur: RATE * 0.9 } as FxRateSnapshot["rates"],
        as_of: new Date(0).toISOString()
      })
    ),
    supportedCurrencies: () => ["usd", "eur"],
    lastKnown: vi.fn(() => null)
  };
}

interface Harness {
  ledger: MemoryCreditLedger;
  processedPayments: MemoryProcessedPaymentStore;
}

function harness(): Harness {
  return {
    ledger: new MemoryCreditLedger(),
    processedPayments: new MemoryProcessedPaymentStore()
  };
}

/**
 * The state an upfront fund-and-draw leaves behind: one credit funded to the
 * job's price, one pending draw consuming it.
 */
async function upfrontDraw(
  h: Harness,
  opts: {
    creditId?: string;
    drawId?: string;
    rail?: CreditFundingBasis["rail"];
    currency?: string;
    x402Channel?: CreditFundingBasis["x402Channel"];
    tempoSession?: CreditFundingBasis["tempoSession"];
  } = {}
): Promise<void> {
  const creditId = opts.creditId ?? "c1";
  await h.ledger.fund({
    creditId,
    callerPubkey: CALLER,
    currency: opts.currency ?? "usd",
    amountMicro: UPFRONT_MICRO,
    expiryMs: FUTURE_MS,
    basis: {
      rail: opts.rail ?? "x402",
      paidMsats: UPFRONT_MSATS,
      fundingRef: "0xupfront",
      ...(opts.x402Channel ? { x402Channel: opts.x402Channel } : {}),
      ...(opts.tempoSession ? { tempoSession: opts.tempoSession } : {})
    }
  });
  await h.ledger.draw({
    creditId,
    drawId: opts.drawId ?? "d1",
    amountMicro: UPFRONT_MICRO,
    jobId: JOB_ID
  });
}

function payMidJob(h: Harness, snapshot: VerifyIncomingSnapshot, fx?: FxFetcher) {
  return verifyIncomingPayment(
    { type: "payment", content: { x402_payment: "base64_header" } },
    {
      x402Config: X402,
      dvmId: DVM_ID,
      jobId: JOB_ID,
      fxFetcher: fx ?? warmFetcher(),
      creditLedger: h.ledger,
      processedPayments: h.processedPayments
    },
    snapshot
  );
}

function explicitJob(overrides: Partial<VerifyIncomingSnapshot> = {}): VerifyIncomingSnapshot {
  return {
    pendingPaymentMsats: TOPUP_MSATS,
    pendingPaymentFiatMicro: TOPUP_MICRO,
    pendingPaymentFiatCurrency: "usd",
    paymentRail: "x402",
    creditId: "c1",
    drawId: "d1",
    paymentTxHash: drawSettlementRef(DVM_ID, "c1", "d1"),
    requesterPubkey: CALLER,
    ...overrides
  };
}

beforeEach(() => {
  vi.mocked(verifyX402Payment).mockReset();
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: TOPUP_MSATS,
    amountUsdcMicro: TOPUP_USDC,
    txHash: TOPUP_TX,
  } as Awaited<ReturnType<typeof verifyX402Payment>>);
});

describe("mid-job requestPayment funds the credit and grows the draw", () => {
  it("grows the job's existing draw instead of opening a second one", async () => {
    const h = harness();
    await upfrontDraw(h);

    const { verified, error } = await payMidJob(h, explicitJob());
    expect(error).toBeUndefined();
    expect(verified).toBeDefined();

    const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    expect(draw?.ledgerSeq).toBe(1);

    expect(await h.ledger.listPendingDraws("c1")).toHaveLength(1);
    expect(verified?.paidMsats).toBe(TOPUP_MSATS);
    expect(verified?.nativeAmount).toBe(TOPUP_USDC);
    expect(verified?.paymentTxHash).toBe(drawSettlementRef(DVM_ID, "c1", "d1"));
    expect(verified?.funding).toMatchObject({
      creditId: "c1",
      fundingId: TOPUP_TX,
      rail: "x402",
      paidMsats: TOPUP_MSATS,
      amountMicro: TOPUP_MICRO,
      currency: "usd"
    });
    expect(verified?.creditId).toBeUndefined();
    expect(verified?.drawId).toBeUndefined();
  });

  it("credits the full ask on a credit whose micro:msat ratio has drifted", async () => {
    const h = harness();
    // Pooled allocation can differ from the paid increment; substituting it leaves a fully paid handler suspended.
    await h.ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 900_000,
        nativeAmount: 950_000,
        nativeAsset: "usdc",
        fundingRef: "0xupfront"
      }
    });
    await h.ledger.draw({
      creditId: "c1",
      drawId: "sib",
      amountMicro: 500_000,
      jobId: "job-sib"
    });
    await h.ledger.draw({
      creditId: "c1",
      drawId: "d1",
      amountMicro: 100_000,
      jobId: JOB_ID
    });

    const { verified, error } = await payMidJob(h, explicitJob());
    expect(error).toBeUndefined();
    expect(verified?.paidMsats).toBe(TOPUP_MSATS);
    expect(verified?.nativeAmount).toBe(TOPUP_USDC);
  });

  it("leaves an implicit N=1 job's rail values verbatim", async () => {
    const h = harness();
    // Implicit N=1: the upfront leg stamped the rail's own reference, not a
    // `draw:` one, so the top-up must not switch the job onto draw semantics.
    await upfrontDraw(h, {
      creditId: "imp:x402:0xupfront",
      drawId: "0xupfront"
    });

    const { verified } = await payMidJob(
      h,
      explicitJob({
        creditId: "imp:x402:0xupfront",
        drawId: "0xupfront",
        paymentTxHash: "0xupfront"
      })
    );
    expect(verified?.paidMsats).toBe(TOPUP_MSATS);
    expect(verified?.paymentTxHash).toBe(TOPUP_TX);
    expect(verified?.nativeAmount).toBe(TOPUP_USDC);

    const draw = await h.ledger.getDraw({
      creditId: "imp:x402:0xupfront",
      drawId: "0xupfront"
    });
    expect(draw?.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("mints a fresh implicit credit for a free-then-paid job and binds it", async () => {
    const h = harness();

    const { verified, error } = await payMidJob(h, {
      pendingPaymentMsats: TOPUP_MSATS,
      pendingPaymentFiatMicro: TOPUP_MICRO,
      pendingPaymentFiatCurrency: "usd",
      requesterPubkey: CALLER
    });
    expect(error).toBeUndefined();
    expect(verified?.creditId).toBe(`imp:x402:${TOPUP_TX}`);
    expect(verified?.drawId).toBe(TOPUP_TX);

    const draw = await h.ledger.getDraw({
      creditId: `imp:x402:${TOPUP_TX}`,
      drawId: TOPUP_TX
    });
    expect(draw?.amountMicro).toBe(TOPUP_MICRO);
    expect(draw?.jobId).toBe(JOB_ID);
    expect(draw?.status).toBe("pending");
  });

  it("commits the marker with the fund and the growth — a replay funds nothing", async () => {
    const h = harness();
    await upfrontDraw(h);
    await payMidJob(h, explicitJob());

    const replay = await payMidJob(h, explicitJob());
    expect(replay.error?.status).toBe(409);
    expect(replay.error?.body.error).toBe("replay_rejected");

    const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    expect((await h.ledger.get("c1"))?.balanceMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  describe("the draw funding row fixed with the ledger leg", () => {
    it("records the provider's credited amount, not a figure derived from the caller's rate", async () => {
      const h = harness();
      await upfrontDraw(h);
      // The caller's wallet and this DVM disagree about BTC/USD; the pinned
      // ask denomination is what the ledger credits, so that is what the
      // artifact must state.
      const callerRate: FxFetcher = {
        ...warmFetcher(),
        fetch: () => Promise.resolve({ rates: { usd: RATE * 2 } as FxRateSnapshot["rates"], as_of: new Date(0).toISOString() }),
      };

      const { verified, error } = await payMidJob(h, explicitJob(), callerRate);
      expect(error).toBeUndefined();
      expect(verified?.drawFunding).toMatchObject({
        creditId: "c1",
        fundId: TOPUP_TX,
        jobId: JOB_ID,
        drawId: "d1",
        amountMicro: TOPUP_MICRO,
        rail: "x402",
        callerPubkey: CALLER,
        // 100k funded + 50k funded, 150k held by the grown draw.
        balanceAfterMicro: 0,
        ledgerSeq: 1,
        receipt: null,
      });
      expect(await h.ledger.listDrawFundings({ creditId: "c1", drawId: "d1" })).toHaveLength(1);
    });

    it("binds the draw's own sequence even when a later draw raised the credit high-water mark", async () => {
      const h = harness();
      await h.ledger.fund({
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: UPFRONT_MICRO * 3,
        expiryMs: FUTURE_MS,
        basis: { rail: "x402", paidMsats: UPFRONT_MSATS * 3, fundingRef: "0xupfront" }
      });
      await h.ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: UPFRONT_MICRO, jobId: JOB_ID });
      await h.ledger.draw({ creditId: "c1", drawId: "sib", amountMicro: UPFRONT_MICRO, jobId: "job-sib" });
      expect((await h.ledger.get("c1"))?.lastLedgerSeq).toBe(2);

      const { verified } = await payMidJob(h, explicitJob());
      expect(verified?.drawFunding?.ledgerSeq).toBe(1);
      expect(verified?.drawFunding?.balanceAfterMicro).toBe(UPFRONT_MICRO);
    });

    it("fixes a row for a payment that grew nothing, because the balance still moved", async () => {
      const h = harness();
      await upfrontDraw(h);

      const { verified, error } = await payMidJob(h, explicitJob({ pendingPaymentMsats: 0, pendingPaymentFiatMicro: undefined }));
      expect(error).toBeUndefined();
      expect(verified?.unappliedMicro).toBe(TOPUP_MICRO);
      expect(verified?.drawFunding).toMatchObject({
        fundId: TOPUP_TX,
        drawId: "d1",
        amountMicro: TOPUP_MICRO,
        balanceAfterMicro: TOPUP_MICRO,
        ledgerSeq: 1,
      });
    });

    it("leaves exactly one row behind a replayed payment and names the payment it collided on", async () => {
      const h = harness();
      await upfrontDraw(h);
      const first = await payMidJob(h, explicitJob());

      const replay = await payMidJob(h, explicitJob());
      expect(replay.error?.status).toBe(409);
      expect(replay.error?.replayPaymentId).toBe(TOPUP_TX);
      const rows = await h.ledger.listDrawFundings({ creditId: "c1", drawId: "d1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(first.verified?.drawFunding);
    });

    describe("through JobManager.processPayment", () => {
      const RECEIPT_SECRET = "13".repeat(32);

      function manager(h: Harness) {
        const descriptor = configureDVM({
          name: "midjob-evidence-test",
          capability: "test",
          tag: "test",
          onJob: () => undefined
        });
        return new JobManager(descriptor, {
          env: {},
          store: new MemoryKVStore(),
          jobStore: new MemoryJobStore(),
          fxFetcher: warmFetcher(),
          dvmId: DVM_ID,
          x402: X402,
          creditLedger: h.ledger,
          processedPayments: h.processedPayments,
          receiptIssuer: new ReceiptIssuer({ secret: RECEIPT_SECRET, dvm: "evidence", dvmId: DVM_ID })
        });
      }

      function boundJob(): ServerJob {
        return {
          id: JOB_ID,
          requesterId: "requester-1",
          requesterPubkey: CALLER,
          status: "awaiting-input",
          messages: [],
          pendingPrompts: new Map(),
          paidMsats: UPFRONT_MSATS,
          pendingPaymentMsats: TOPUP_MSATS,
          pendingPaymentFiatMicro: TOPUP_MICRO,
          pendingPaymentFiatCurrency: "usd",
          paymentRail: "x402",
          creditId: "c1",
          drawId: "d1",
          paymentTxHash: drawSettlementRef(DVM_ID, "c1", "d1")
        } as unknown as ServerJob;
      }

      it("signs the fact once and hands the same bytes back on a replay", async () => {
        const h = harness();
        await upfrontDraw(h);
        const jm = manager(h);
        try {
          const body = { type: "payment" as const, content: { x402_payment: "base64_header" } };
          const first = await jm.processPayment(boundJob(), body, null);
          expect(first.error).toBeUndefined();
          const receipt = first.drawFundingReceipt;
          if (!receipt) throw new Error("no draw funding receipt on the accepted payment");
          expect(verifyDrawFundingReceipt(receipt)).toBe(true);
          expect(receipt).toMatchObject({
            kind: "credit_draw_funding",
            credit_id: "c1",
            job_id: JOB_ID,
            draw_id: "d1",
            fund_id: TOPUP_TX,
            currency: "usd",
            funded_micro: TOPUP_MICRO,
            balance_after_micro: 0,
            ledger_seq: 1,
            caller_pubkey: CALLER,
            dvm_id: DVM_ID,
            receipt_pubkey: receiptPubkeyFromSecret(RECEIPT_SECRET)
          });
          expect(receipt.payment_seq).toBeUndefined();

          const replay = await jm.processPayment(boundJob(), body, null);
          expect(replay.error?.status).toBe(409);
          expect(replay.error?.body.error).toBe("replay_rejected");
          expect(JSON.stringify(replay.error?.body.draw_funding_receipt)).toBe(JSON.stringify(receipt));

          const stored = await h.ledger.getFunding({ creditId: "c1", fundId: TOPUP_TX });
          expect(isDrawFundingReceipt(stored?.receipt)).toBe(true);
          const recovered = await jm.drawFundingReceipts({ id: JOB_ID, creditId: "c1", drawId: "d1" });
          expect(JSON.stringify(recovered)).toBe(JSON.stringify([receipt]));
        } finally {
          jm.shutdown();
        }
      });

      it("issues nothing without a receipt key and lists nothing for a job that holds no draw", async () => {
        const h = harness();
        await upfrontDraw(h);
        const jm = manager(h);
        try {
          expect(await jm.drawFundingReceipts({ id: JOB_ID })).toEqual([]);
        } finally {
          jm.shutdown();
        }
      });
    });
  });

  describe("a short mid-job pay", () => {
    const SHORT_MSATS = 30_000;
    const MINT = "https://mint.example";

    function shortAccumulatorPay(h: Harness, snapshot?: VerifyIncomingSnapshot) {
      vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
        const accepted = {
          grossMsats: SHORT_MSATS + 1_000,
          inputFeeMsats: 1_000,
          mintUrl: MINT,
          netMsats: SHORT_MSATS,
          paidMsats: SHORT_MSATS,
          requestId: opts.requestId ?? "",
        };
        await opts.withCommitTx?.({} as never, accepted);
        return { kind: "accumulated" as const, ...accepted };
      });
      return verifyIncomingPayment(
        {
          type: "payment",
          content: { cashu_token: "cashuTok", cashu_request_id: "req-short" }
        },
        {
          cashuMode: "p2pk-accumulator",
          accumulatorDb: {} as never,
          lockPubkeys: ["02" + "ab".repeat(32)] as never,
          mints: [MINT],
          dvmId: DVM_ID,
          jobId: JOB_ID,
          fxFetcher: warmFetcher(),
          creditLedger: h.ledger,
          processedPayments: h.processedPayments
        },
        snapshot ?? explicitJob({ paymentRail: "cashu" })
      );
    }

    function freeThenPaidJob(): VerifyIncomingSnapshot {
      return {
        pendingPaymentMsats: TOPUP_MSATS,
        pendingPaymentFiatMicro: TOPUP_MICRO,
        pendingPaymentFiatCurrency: "usd",
        requesterPubkey: CALLER
      };
    }

    it("funds the credit without growing the live job's draw", async () => {
      const h = harness();
      await upfrontDraw(h, { rail: "cashu" });

      const { error } = await shortAccumulatorPay(h);
      expect(error?.status).toBe(402);
      expect(error?.body.error).toBe("payment_insufficient");

      // A short mid-job deposit is balance, not partial progress against the outstanding ask.
      const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
      expect(draw?.amountMicro).toBe(UPFRONT_MICRO);
      expect(draw?.status).toBe("pending");

      expect((await h.ledger.get("c1"))?.balanceMicro).toBe(UPFRONT_MICRO + SHORT_MSATS);
      expect(error?.funding).toMatchObject({
        creditId: "c1",
        fundingId: "req-short",
        rail: "cashu",
        paidMsats: SHORT_MSATS,
        grossPaidMsats: SHORT_MSATS + 1_000,
        cashuInputFeeMsats: 1_000,
        amountMicro: SHORT_MSATS,
        currency: "usd"
      });
      expect(error?.body.credit_id).toBe("c1");
      expect(error?.body.credited_micro).toBe(SHORT_MSATS);
      expect(error?.body.hint as string).toContain("required_msats");
      expect(error?.body.hint as string).not.toContain("difference");
      expect(error?.body.display as string).not.toContain("remaining balance");
    });

    it("places no draw on a free-then-paid job — the money is not a forfeit", async () => {
      const h = harness();

      const { verified, error } = await shortAccumulatorPay(h, freeThenPaidJob());
      expect(verified).toBeUndefined();
      expect(error?.status).toBe(402);
      expect(error?.body.error).toBe("payment_insufficient");

      // A live job’s short payment must not use the upfront no-job forfeit branch.
      const creditId = "imp:cashu:req-short";
      expect(await h.ledger.getDraw({ creditId, drawId: "req-short" })).toBeUndefined();
      const credit = await h.ledger.get(creditId);
      expect(credit?.balanceMicro).toBe(SHORT_MSATS);

      expect(credit?.availableMicro).toBe(SHORT_MSATS);
      expect(credit?.callerPubkey).toBe(CALLER);
      expect(error?.funding).toMatchObject({
        creditId: "imp:cashu:req-short",
        fundingId: "req-short",
        rail: "cashu",
        paidMsats: SHORT_MSATS,
        amountMicro: SHORT_MSATS,
        currency: "usd"
      });
      expect(error?.body.credit_id).toBe("imp:cashu:req-short");
      expect(error?.body.credited_micro).toBe(SHORT_MSATS);
      expect(error?.body.credit_currency).toBe("usd");
      const hint = error?.body.hint as string;
      expect(hint).toContain("imp:cashu:req-short");
      expect(hint).toContain("drain");
    });

    // JobManager consumes the mid-job refusal: it reports the deposit without booking revenue.
    describe("through JobManager.processPayment", () => {
      function manager(h: Harness, sinks: { deposits: unknown[]; revenue: unknown[] }) {
        const descriptor = configureDVM({
          name: "midjob-shortpay-test",
          capability: "test",
          tag: "test",
          onJob: () => undefined
        });
        return new JobManager(descriptor, {
          env: {},
          store: new MemoryKVStore(),
          jobStore: new MemoryJobStore(),
          fxFetcher: warmFetcher(),
          dvmId: DVM_ID,
          mints: [MINT],
          cashuMode: "p2pk-accumulator",
          db: {} as never,
          creditLedger: h.ledger,
          processedPayments: h.processedPayments,
          onCreditFunded: (info) => {
            sinks.deposits.push(info);
          },
          onJobCompleted: (info) => {
            sinks.revenue.push(info);
          }
        });
      }

      function awaitingJob(): ServerJob {
        return {
          id: JOB_ID,
          requesterId: "requester-1",
          requesterPubkey: CALLER,
          pendingPaymentMsats: TOPUP_MSATS,
          pendingPaymentFiatMicro: TOPUP_MICRO,
          pendingPaymentFiatCurrency: "usd"
        } as ServerJob;
      }

      it("books the deposit and no revenue", async () => {
        const h = harness();
        const sinks = { deposits: [] as unknown[], revenue: [] as unknown[] };
        const jm = manager(h, sinks);
        vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
          const accepted = {
            grossMsats: SHORT_MSATS + 1_000,
            inputFeeMsats: 1_000,
            mintUrl: MINT,
            netMsats: SHORT_MSATS,
            paidMsats: SHORT_MSATS,
            requestId: opts.requestId ?? "",
          };
          await opts.withCommitTx?.({} as never, accepted);
          return { kind: "accumulated" as const, ...accepted };
        });

        try {
          const res = await jm.processPayment(
            awaitingJob(),
            {
              type: "payment",
              content: {
                cashu_token: "cashuTok",
                cashu_request_id: "req-short"
              }
            },
            null,
            { lockPubkeys: ["02" + "ab".repeat(32)] as never }
          );
          expect(res.error?.status).toBe(402);
          await new Promise((r) => setTimeout(r, 0));
        } finally {
          jm.shutdown();
        }

        expect(sinks.deposits).toHaveLength(1);
        expect(sinks.deposits[0]).toMatchObject({
          dvmId: DVM_ID,
          creditId: "imp:cashu:req-short",
          fundingId: "req-short",
          rail: "cashu",
          paidMsats: SHORT_MSATS,
          grossPaidMsats: SHORT_MSATS + 1_000,
          cashuInputFeeMsats: 1_000,
          amountMicro: SHORT_MSATS,
          creditCurrency: "usd"
        });
        expect(sinks.deposits[0]).not.toHaveProperty("instrument");

        expect(sinks.revenue).toHaveLength(0);
      });
    });
  });

  describe("degrades rather than refusing money", () => {
    it("accepts a cross-rail top-up without a ledger row", async () => {
      const h = harness();
      // The credit was funded on cashu; sats and USDC microunits aren't
      // summable, so `fund` would refuse — inside the rail transaction, where a
      // refusal takes the caller's already-settled payment with it.
      await upfrontDraw(h, { rail: "cashu" });

      const { verified, error } = await payMidJob(h, explicitJob());
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.paymentTxHash).toBe(TOPUP_TX);

      const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
      expect(draw?.amountMicro).toBe(UPFRONT_MICRO);
    });

    it("accepts an exact top-up on a channel-bound credit without a ledger row", async () => {
      const h = harness();
      // Same rail, different instrument: reject before exact settlement encounters a channel-bound ledger.
      await upfrontDraw(h, {
        x402Channel: { channelId: "0xchannel", maxClaimableAmount: "1000000" }
      });
      const fund = vi.spyOn(h.ledger, "fund");

      const { verified, error } = await payMidJob(h, explicitJob());
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.paymentTxHash).toBe(TOPUP_TX);
      expect(fund).not.toHaveBeenCalled();

      const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
      expect(draw?.amountMicro).toBe(UPFRONT_MICRO);
      const credit = await h.ledger.get("c1");
      expect(credit?.balanceMicro).toBe(UPFRONT_MICRO);
    });

    it("accepts a top-up on a job whose draw already resolved", async () => {
      const h = harness();
      await upfrontDraw(h);
      await h.ledger.settle({ creditId: "c1", drawId: "d1" });

      const { verified, error } = await payMidJob(h, explicitJob());
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);

      const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
      expect(draw?.amountMicro).toBe(UPFRONT_MICRO);
      expect(draw?.status).toBe("settled");
    });

    it("accepts a payment on a DVM with no ledger wired", async () => {
      const { verified, error } = await verifyIncomingPayment(
        { type: "payment", content: { x402_payment: "base64_header" } },
        { x402Config: X402, dvmId: DVM_ID, jobId: JOB_ID, fxFetcher: warmFetcher() },
        explicitJob()
      );
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.paymentTxHash).toBe(TOPUP_TX);
    });

    it("re-denominates when the pinned ask and the credit disagree on currency", async () => {
      const h = harness();
      await upfrontDraw(h, { currency: "eur" });

      const { verified, error } = await payMidJob(
        h,
        explicitJob({ pendingPaymentFiatCurrency: "usd" })
      );
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);

      const draw = await h.ledger.getDraw({ creditId: "c1", drawId: "d1" });
      expect(draw?.amountMicro).toBe(145_000);
      expect(draw?.railValue.creditCurrency).toBe("eur");
    });
  });

  /* Unpinned Cashu asks reach verify-time FX without requiring a rate for rail valuation.
 * Live, cached, refused and partial snapshots therefore exercise different denomination fallbacks. */
  describe("an unpinned bare-msats ask denominates at verify time", () => {
    const MINT = "https://mint.example";
    const REQUEST_ID = "req-bare";

    function unpinnedJob(overrides: Partial<VerifyIncomingSnapshot> = {}): VerifyIncomingSnapshot {
      return {
        pendingPaymentMsats: TOPUP_MSATS,
        requesterPubkey: CALLER,
        ...overrides
      };
    }

    function payCashu(h: Harness, snapshot: VerifyIncomingSnapshot, fx: FxFetcher) {
      vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
        const accepted = {
          grossMsats: TOPUP_MSATS,
          inputFeeMsats: 0,
          mintUrl: MINT,
          netMsats: TOPUP_MSATS,
          paidMsats: TOPUP_MSATS,
          requestId: opts.requestId ?? "",
        };
        await opts.withCommitTx?.({} as never, accepted);
        return { kind: "accumulated" as const, ...accepted };
      });
      return verifyIncomingPayment(
        {
          type: "payment",
          content: { cashu_token: "cashuTok", cashu_request_id: REQUEST_ID }
        },
        {
          cashuMode: "p2pk-accumulator",
          accumulatorDb: {} as never,
          lockPubkeys: ["02" + "ab".repeat(32)] as never,
          mints: [MINT],
          dvmId: DVM_ID,
          jobId: JOB_ID,
          fxFetcher: fx,
          creditLedger: h.ledger,
          processedPayments: h.processedPayments
        },
        snapshot
      );
    }

    function coldFetcher(opts: { lastKnown?: FxRateSnapshot; err?: Error } = {}): FxFetcher {
      return {
        fetch: vi.fn(() => Promise.reject(opts.err ?? new Error("coingecko 429"))),
        supportedCurrencies: () => ["usd", "eur"],
        lastKnown: vi.fn(() => (opts.lastKnown ? { snapshot: opts.lastKnown, cachedAt: CACHED_AT } : null))
      };
    }

    const CACHED_AT = 1_700_000_000_000;
    const SNAPSHOT: FxRateSnapshot = {
      rates: { usd: RATE } as FxRateSnapshot["rates"],
      as_of: new Date(0).toISOString()
    };

    /**
     * Pay, and hand back the structured top-up lines it emitted. The capture has
     * to happen before `mockRestore`, which clears `mock.calls`.
     */
    async function payAndCapture(
      h: Harness,
      snapshot: VerifyIncomingSnapshot,
      fx: FxFetcher
    ): Promise<
      Awaited<ReturnType<typeof payCashu>> & {
        skips: Record<string, unknown>[];
      }
    > {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const result = await payCashu(h, snapshot, fx);
        const skips = warn.mock.calls
          .map((call) => {
            try {
              return JSON.parse(String(call[0])) as Record<string, unknown>;
            } catch {
              return {};
            }
          })
          .filter(
            (row) =>
              row.event === "credit_topup_skipped" || row.event === "credit_topup_stale_rate"
          );
        return { ...result, skips };
      } finally {
        warn.mockRestore();
      }
    }

    it("converts the ask through a live rate and opens the credit", async () => {
      const h = harness();

      const { verified, error } = await payCashu(h, unpinnedJob(), warmFetcher());
      expect(error).toBeUndefined();
      expect(verified?.creditId).toBe(`imp:cashu:${REQUEST_ID}`);
      expect(verified?.drawId).toBe(REQUEST_ID);
      expect(verified?.funding?.amountMicro).toBe(TOPUP_MICRO);

      const draw = await h.ledger.getDraw({
        creditId: `imp:cashu:${REQUEST_ID}`,
        drawId: REQUEST_ID
      });
      expect(draw?.amountMicro).toBe(TOPUP_MICRO);
      expect(draw?.status).toBe("pending");
    });

    it("degrades onto the last-known snapshot when the live fetch fails", async () => {
      const h = harness();

      const { verified, error, skips } = await payAndCapture(h, unpinnedJob(), coldFetcher({ lastKnown: SNAPSHOT }));

      expect(error).toBeUndefined();
      expect(verified?.creditId).toBe(`imp:cashu:${REQUEST_ID}`);
      expect(verified?.funding?.amountMicro).toBe(TOPUP_MICRO);

      expect(skips).toHaveLength(1);
      expect(skips[0].rate_cached_at).toBeUndefined();
    });

    it("refuses to degrade onto a snapshot the platform declared known-stale", async () => {
      const h = harness();

      const { verified, error, skips } = await payAndCapture(
        h,
        unpinnedJob(),
        coldFetcher({
          lastKnown: SNAPSHOT,
          err: new FxRateUnavailableError("refused", undefined, {
            staleDays: 6,
            staleSource: "coingecko",
            thresholdDays: 5
          })
        })
      );

      // Do not serve a cached snapshot after the rate provider definitively refuses its validity.
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.creditId).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toEqual({
        event: "credit_topup_skipped",
        job_id_hash: JOB_ID_HASH,
        level: "warn",
        rail: "cashu",
        reason: "denomination_unavailable",
        cause: "rate_stale_refused",
        currency: "usd"
      });
    });

    it("names the cause when there is no rate anywhere, and still takes the money", async () => {
      const h = harness();

      const { verified, error, skips } = await payAndCapture(h, unpinnedJob(), coldFetcher());

      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.creditId).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ reason: "denomination_unavailable", cause: "rate_unavailable" });
      expect(skips[0].source_failure).toBe("unknown");
      expect(skips[0].source_status).toBeUndefined();
      expect(JSON.stringify(skips[0])).not.toContain("coingecko 429");
    });

    it("accepts payment without cached denomination after an injected typed stale refusal", async () => {
      const h = harness();
      const refusal = new FxRateUnavailableError("stale", undefined, { staleDays: 6 });
      const fetchFn = vi.fn().mockResolvedValueOnce(Response.json({ bitcoin: { usd: RATE } }))
        .mockRejectedValue(refusal) as unknown as typeof fetch;
      let now = 0;
      const fx = createFxFetcher({ currencies: ["usd"], now: () => now, cacheTtlMs: 1, fetchFn, retries: 1, retryDelayMs: 0 });
      await fx.fetch();
      now = 2;
      const { verified, error, skips } = await payAndCapture(h, unpinnedJob(), fx);
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.creditId).toBeUndefined();
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ cause: "rate_stale_refused" });
    });

    it.each(["field accessor", "category accessor", "descriptor failure"] as const)("diagnostic %s cannot change accepted-payment behavior", async (shape) => {
      const h = harness();
      const getter = vi.fn(() => { throw new Error("METADATA_SECRET"); });
      const failure = new FxRateUnavailableError("provider text");
      if (shape === "field accessor") {
        Object.defineProperty(failure, "sourceFailure", { get: getter });
      } else {
        const metadata = shape === "category accessor"
          ? Object.defineProperty({}, "category", { get: getter })
          : new Proxy({}, { getOwnPropertyDescriptor: getter });
        Object.defineProperty(failure, "sourceFailure", { value: metadata });
      }
      const { verified, error, skips } = await payAndCapture(h, unpinnedJob(), coldFetcher({ err: failure }));
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.creditId).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toMatchObject({ cause: "rate_unavailable", source_failure: "unknown" });
      expect(JSON.stringify(skips)).not.toContain("METADATA_SECRET");
      if (shape !== "descriptor failure") expect(getter).not.toHaveBeenCalled();
    });

    it.each(["direct", "platform"] as const)("binds the %s HTTP source warning to its job without raw identities", async (kind) => {
      const h = harness();
      const creditId = "credit-private-binding-sentinel";
      const drawId = "draw-private-binding-sentinel";
      await upfrontDraw(h, { creditId, drawId, rail: "cashu" });
      const source = kind === "direct" ? "https://example.com/fx?token=URL_SECRET"
        : { kind: "platform" as const, url: "https://example.com/fx?token=URL_SECRET", token: "BEARER_SECRET" };
      const fetchFn = vi.fn(async () => new Response("BODY_SECRET", { status: 429 })) as unknown as typeof fetch;
      const { verified, error, skips } = await payAndCapture(h, unpinnedJob({ creditId, drawId }), createFxFetcher({ source, fetchFn, retries: 1, retryDelayMs: 0 }));
      expect(error).toBeUndefined();
      expect(verified?.paidMsats).toBe(TOPUP_MSATS);
      expect(verified?.creditId).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toEqual({
        event: "credit_topup_skipped", level: "warn", rail: "cashu",
        reason: "denomination_unavailable", currency: "usd", cause: "rate_unavailable",
        job_id_hash: JOB_ID_HASH, source_failure: "http_error", source_status: 429,
      });
      const serialized = JSON.stringify(skips);
      for (const secret of [JOB_ID, creditId, drawId, "example.com", "URL_SECRET", "BEARER_SECRET", "BODY_SECRET"]) expect(serialized).not.toContain(secret);
    });

    it("says so when the snapshot carries no rate for the credit's currency", async () => {
      const h = harness();

      const { error, skips } = await payAndCapture(h, unpinnedJob({ pendingPaymentFiatCurrency: "gbp" }), {
        fetch: vi.fn(() => Promise.resolve(SNAPSHOT)),
        supportedCurrencies: () => ["usd", "gbp"],
        lastKnown: vi.fn(() => null)
      });

      expect(error).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toEqual({
        event: "credit_topup_skipped",
        job_id_hash: JOB_ID_HASH,
        level: "warn",
        rail: "cashu",
        reason: "denomination_unavailable",
        cause: "unsupported_currency",
        currency: "gbp"
      });
    });

    it("reads a currency the source dropped as a rate outage, not a bad currency", async () => {
      const h = harness();

      // Missing an advertised currency means source narrowing; an unsupported currency needs a different repair.
      const { error, skips } = await payAndCapture(h, unpinnedJob({ pendingPaymentFiatCurrency: "gbp" }), {
        fetch: vi.fn(() => Promise.resolve({ ...SNAPSHOT, unavailable: ["gbp"] })),
        supportedCurrencies: () => ["usd", "gbp"],
        lastKnown: vi.fn(() => null)
      });

      expect(error).toBeUndefined();
      expect(skips).toHaveLength(1);
      expect(skips[0]).toEqual({
        event: "credit_topup_skipped",
        job_id_hash: JOB_ID_HASH,
        level: "warn",
        rail: "cashu",
        reason: "denomination_unavailable",
        cause: "rate_unavailable",
        source_failure: "missing_currency",
        currency: "gbp"
      });
    });

    it("still denominates off a currency the source dropped but the fetcher carried", async () => {
      const h = harness();

      // A carried-forward rate remains usable but must be reported as older than the rest of the snapshot.
      const { verified, error, skips } = await payAndCapture(h, unpinnedJob({ pendingPaymentFiatCurrency: "gbp" }), {
        fetch: vi.fn(() =>
          Promise.resolve({
            rates: { usd: RATE, gbp: RATE } as FxRateSnapshot["rates"],
            as_of: new Date(0).toISOString(),
            carried_forward: ["gbp"]
          })
        ),
        supportedCurrencies: () => ["usd", "gbp"],
        lastKnown: vi.fn(() => null)
      });

      expect(error).toBeUndefined();
      expect(verified?.creditId).toBe(`imp:cashu:${REQUEST_ID}`);
      expect(verified?.funding?.amountMicro).toBe(TOPUP_MICRO);
      expect(skips).toHaveLength(1);
      expect(skips[0].rate_carried_forward).toBe(true);
      expect(skips[0].rate_cached_at).toBeUndefined();
    });
  });

  describe("the uncapped-top-up signal", () => {
    // Legacy jobs with no ask-total column are not newly uncapped jobs and must not keep the warning permanently active.
    const emitted: SpanRow[] = [];

    beforeEach(() => {
      emitted.length = 0;
      initLoggers(new SpanWriter({ send: async () => {} }), "test");
      setEmitter((row) => emitted.push(row));
    });

    afterEach(() => {
      setEmitter(null);
    });

    async function spansFor(snapshot: VerifyIncomingSnapshot): Promise<SpanRow[]> {
      const h = harness();
      await upfrontDraw(h);
      await payMidJob(h, snapshot);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return emitted.filter((row) => row.name.startsWith("dvm.topup_cap"));
    }

    it("counts a ceiling this build lost", async () => {
      const rows = await spansFor(
        explicitJob({
          askedTopUpMicro: UNCAPPABLE_ASK_TOTAL,
          topUpCapUnenforcedReason: "ask_unpriceable"
        })
      );

      expect(rows.map((row) => row.name)).toEqual(["dvm.topup_cap_unenforceable"]);
      expect(rows[0].level).toBe("warn");
      expect(rows[0].attributes.reason).toBeUndefined();
    });

    it("leaves a row that never had an ask total out of the count", async () => {
      const rows = await spansFor(explicitJob({ askedTopUpMicro: undefined }));

      expect(rows.map((row) => row.name)).toEqual(["dvm.topup_cap_absent"]);
      expect(rows[0].level).toBe("info");
    });
  });
});
