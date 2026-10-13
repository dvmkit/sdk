import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { type DrainReceipt, verifyDrainReceipt } from "../../../lib/receipt";
import { decodePaymentRequiredHeader, type PaymentRequirementsV2 } from "../../../lib/x402/spec";
import type { FxFetcher } from "../../pricing/fx";
import type { AppEnv } from "../app";
import { CreditLedgerError, type CreditLedgerLike, x402SettlementPending } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA, handleCreditRequest } from "../credit-routes";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { buildPaymentErrorResponse, verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import {
  type X402BatchSettlementServer,
  X402SettlementSubmissionError,
} from "../x402-batch-settlement";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const HEADER = Buffer.from(
  JSON.stringify({ x402Version: 2, accepted: { scheme: "batch-settlement" }, payload: {} })
).toString("base64");
const CHANNEL_ID = `0x${"ab".repeat(32)}`;
const CHANNEL_HEADER = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    accepted: { scheme: "batch-settlement" },
    payload: { voucher: { channelId: CHANNEL_ID, maxClaimableAmount: "250000" } },
  })
).toString("base64");
const CREDIT_PRIVKEY = new Uint8Array(32).fill(7);
const CREDIT_CALLER = Buffer.from(schnorr.getPublicKey(CREDIT_PRIVKEY)).toString("hex");
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
const RECEIPT_ISSUER = new ReceiptIssuer({
  secret: "77".repeat(32),
  dvm: "x402-drain-test",
  dvmId: "dvm-x402-drain-test",
});
const REQUIREMENT: PaymentRequirementsV2 = {
  scheme: "batch-settlement",
  network: "eip155:84532",
  amount: "250000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: {
    name: "USDC",
    version: "2",
    assetTransferMethod: "eip3009",
    receiverAuthorizer: "0x2222222222222222222222222222222222222222",
    withdrawDelay: 86_400,
  },
};

function fx(): FxFetcher {
  return {
    fetch: vi.fn(async () => ({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() })),
    lastKnown: vi.fn(() => null),
    supportedCurrencies: () => ["usd"],
  };
}

function downFx(): FxFetcher {
  return {
    fetch: vi.fn(() => Promise.reject(new Error("fx source returned HTTP 429"))),
    lastKnown: vi.fn(() => null),
    supportedCurrencies: () => ["usd"],
  };
}

function batchServer(
  refusalReason?:
    | "refund_bound_unavailable"
    | "refund_exceeds_channel_escrow"
    | "settlement_written_off"
    | "wrong_channel",
  // What the chain paid, when a test needs it to disagree with the debit. The
  // settlement is recorded outside the ledger transaction, so a short one is the
  // payout-floor wedge: money on chain, nothing booked here.
  settledAmount = "250000"
): X402BatchSettlementServer {
  return {
    buildRequirements: vi.fn(async () => [REQUIREMENT]),
    accept: vi.fn(async (args) => {
      if (refusalReason) {
        return {
          ok: false as const,
          reason: refusalReason,
          requirements: [REQUIREMENT],
          corrective: false as const,
        };
      }
      const funding = {
        channelId: CHANNEL_ID,
        maxClaimableAmount: "250000",
        paymentId: `${CHANNEL_ID}:250000`,
        amount: "250000",
      };
      let committed = await args.commit(funding);
      const settlement = {
        success: true,
        transaction: "0xrefund",
        network: "eip155:84532" as const,
        amount: settledAmount,
      };
      if (args.complete) committed = await args.complete(settlement, committed);
      return {
        ok: true as const,
        value: {
          funding,
          committed,
          settlement,
        },
      };
    }),
    getChannel: vi.fn(),
    observeChannel: vi.fn(),
    claimAndSettle: vi.fn(),
    stop: vi.fn(),
  };
}

function creditRoute(
  batch: X402BatchSettlementServer,
  ledger: CreditLedgerLike,
  receiptIssuer?: ReceiptIssuer
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = secp256k1Auth();
  app.post("/v1/credit", (c) =>
    handleCreditRequest(c, {
      menu: () =>
        Promise.resolve({
          min_micro: 100_000,
          max_micro: 5_000_000,
          ttl_ms: 86_400_000,
          currency: "usd",
          funding: ["x402"],
        }),
      creditConfig: {
        min: "$0.10",
        max: "$5.00",
        ttlSeconds: 86_400,
        allowOneShotStablecoin: false,
      },
      auth,
      ledger,
      fxFetcher: fx(),
      railOpts: (c) =>
        Promise.resolve({
          x402Payment: c.req.header("PAYMENT-SIGNATURE"),
          x402BatchSettlement: batch,
        }),
      onDeposit: vi.fn(),
      drainReport: {},
      receiptIssuer,
      lightning: undefined,
      settleLightning: () => Promise.resolve(),
    })
  );
  return app;
}

async function x402Credit(
  batch: X402BatchSettlementServer,
  nativeAmount: number,
  receiptIssuer?: ReceiptIssuer
): Promise<{ app: Hono<AppEnv>; ledger: CreditLedgerLike }> {
  const ledger = durableLedger();
  await fundCredit(ledger, {
    creditId: "credit-1",
    callerPubkey: CREDIT_CALLER,
    currency: "usd",
    amountMicro: 250_000,
    expiryMs: Date.now() + 86_400_000,
    basis: {
      rail: "x402",
      paidMsats: 25_000,
      nativeAmount,
      nativeAsset: "usdc",
      fundingRef: "0xfunding",
      x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "250000" },
    },
  });
  return { app: creditRoute(batch, ledger, receiptIssuer), ledger };
}

/** `op: "fund"` on the channel-bound credit; omit `header` for the discovery hop. */
function fundRequest(app: Hono<AppEnv>, header?: string): Response | Promise<Response> {
  return app.request("/v1/credit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(header ? { "PAYMENT-SIGNATURE": header } : {}),
    },
    body: JSON.stringify(
      creditSigner.signRequest(CREDIT_PRIVKEY, {
        op: "fund",
        credit_id: "credit-1",
        fund: {
          fund_id: "top-up-1",
          amount_micro: 250_000,
          commitment: fundingCommitment(CHANNEL_HEADER),
        },
      })
    ),
  });
}

function drainRequest(app: Hono<AppEnv>, drainId = "drain-1"): Response | Promise<Response> {
  return app.request("/v1/credit", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": HEADER,
    },
    body: JSON.stringify(
      creditSigner.signRequest(CREDIT_PRIVKEY, {
        op: "drain",
        credit_id: "credit-1",
        drain: { drain_id: drainId, method: "x402" },
      })
    ),
  });
}

function balanceRequest(app: Hono<AppEnv>): Response | Promise<Response> {
  return app.request("/v1/credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      creditSigner.signRequest(CREDIT_PRIVKEY, {
        op: "balance",
        credit_id: "credit-1",
      })
    ),
  });
}

describe("x402 batch-settlement credit funding", () => {
  it("refreshes a channel-backed credit before returning its signed balance", async () => {
    const batch = batchServer();
    const { app } = await x402Credit(batch, 250_000);

    const response = await balanceRequest(app);

    expect(response.status).toBe(200);
    expect(batch.observeChannel).toHaveBeenCalledWith(CHANNEL_ID);
  });

  it("serializes a batch-only corrective requirement without an exact fallback", () => {
    const response = buildPaymentErrorResponse(
      { message: "Sign the cooperative refund voucher." },
      undefined,
      undefined,
      402,
      [REQUIREMENT]
    );

    const header = response.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new Error("expected PAYMENT-REQUIRED header");
    expect(decodePaymentRequiredHeader(header)).toMatchObject({
      resource: { url: "/v1/credit" },
      accepts: [REQUIREMENT],
      error: "Sign the cooperative refund voucher.",
    });
  });

  it("carries a scheme error code into the envelope without the prose around it", () => {
    const reason = "invalid_batch_settlement_evm_cumulative_amount_mismatch";
    const response = buildPaymentErrorResponse(
      { error: "payment_invalid", message: `x402 cooperative refund refused: ${reason}` },
      undefined,
      undefined,
      402,
      [REQUIREMENT],
      undefined,
      undefined,
      reason
    );

    const header = response.headers.get("PAYMENT-REQUIRED");
    if (!header) throw new Error("expected PAYMENT-REQUIRED header");
    // A scheme client string-compares this field against its own error
    // constants to decide whether the 402 is correctable, so the sentence the
    // human reads has to stay on the body. Wrapping the code here
    // silently disables the cooperative-drain handshake.
    expect(decodePaymentRequiredHeader(header).error).toBe(reason);
  });

  it("advertises the v2 channel requirement only on a fund-only request", async () => {
    const batch = batchServer();
    const rate = downFx();
    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: rate,
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      fundOnly: { creditId: "credit-1", fundId: "fund-1", commitment: "0".repeat(64) },
    });

    expect(result.error?.x402V2Requirements).toEqual([REQUIREMENT]);
    expect(batch.buildRequirements).toHaveBeenCalledWith("250000");
    expect(rate.fetch).not.toHaveBeenCalled();
    expect(rate.lastKnown).not.toHaveBeenCalled();
  });

  it("uses channelId:maxClaimableAmount as the funding id and binds the credit", async () => {
    const batch = batchServer();
    const ledger = new MemoryCreditLedger();
    const rate = downFx();
    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: rate,
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      callerPubkey: "aa".repeat(32),
      dvmId: "dvm-batch-funding",
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      fundOnly: {
        creditId: "credit-1",
        fundId: "fund-1",
        commitment: fundingCommitment(HEADER),
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.paymentTxHash).toBe(`${CHANNEL_ID}:250000`);
    expect(result.funding?.instrument).toBe("x402_channel");
    expect((await ledger.get("credit-1"))?.x402ChannelId).toBe(CHANNEL_ID);
    expect(await ledger.getFunding({ creditId: "credit-1", fundId: "fund-1" })).toMatchObject({
      amountMicro: 250_000,
      rail: "x402",
    });
    expect(rate.fetch).not.toHaveBeenCalled();
    expect(rate.lastKnown).not.toHaveBeenCalled();
  });

  // A chain submission that could not go through is a service
  // availability fault: the voucher verified and the ledger leg rolled back with
  // it. Answering the caller's `payment_invalid` default ("request a fresh quote
  // the previous payment can't be reused") tells an agent to discard a
  // credential that is still perfectly good.
  it("answers a failed chain submission as retryable and service-side, not a bad payment", async () => {
    const batch = batchServer();
    batch.accept = vi.fn(() => {
      throw new X402SettlementSubmissionError(
        "settle_transaction_failed",
        "x402 self-relay submission lock 'x402-self-relay:eip155:8453:0xabc' still held after 30000ms (held by pid 4242)"
      );
    });
    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: fx(),
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      callerPubkey: "aa".repeat(32),
      dvmId: "dvm-batch-funding",
      creditLedger: new MemoryCreditLedger(),
      processedPayments: new MemoryProcessedPaymentStore(),
      fundOnly: {
        creditId: "credit-1",
        fundId: "fund-1",
        commitment: fundingCommitment(HEADER),
      },
    });

    expect(result.error?.status).toBe(503);
    expect(result.error?.body).toMatchObject({
      error: "x402_settlement_submission_failed",
      retryable: true,
      settlement_error: "settle_transaction_failed",
    });
    // No challenge envelope: there is nothing new to sign, and an agent reads a
    // corrective 402 as "re-sign and resubmit".
    expect(result.error?.x402Requirements).toBeUndefined();
    expect(result.error?.body.hint).toContain("Retry the same request");
    // The reason enum is the whole of what upstream's failure contributes. Its
    // `errorMessage` names a fleet machine's backend pid — and on the sibling
    // reasons, an RPC URL viem does not redact — so no field may carry it.
    const wire = JSON.stringify(result.error?.body);
    expect(wire).not.toContain("4242");
    expect(wire).not.toContain("x402-self-relay:");
  });

  it("terminally refuses a channel already bound to another credit before acceptance", async () => {
    const batch = batchServer();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "bound-credit",
      callerPubkey: "aa".repeat(32),
      currency: "usd",
      amountMicro: 250_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "x402",
        paidMsats: 25_000,
        nativeAmount: 250_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "250000" },
      },
    });

    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: CHANNEL_HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: fx(),
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      callerPubkey: "aa".repeat(32),
      dvmId: "dvm-channel-rebind",
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      fundOnly: {
        creditId: "fresh-credit",
        fundId: "fund-1",
        commitment: fundingCommitment(CHANNEL_HEADER),
      },
    });

    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "x402",
        credit_instrument: "x402_channel",
        credit_channel_id: CHANNEL_ID,
        bound_credit_id: "bound-credit",
        retryable: false,
      },
    });
    expect(result.error?.x402V2Requirements).toBeUndefined();
    expect(batch.accept).not.toHaveBeenCalled();
  });

  // the mirror of the exact-against-a-channel-credit refusal. The
  // ledger is the authority and now refuses this symmetrically, but it does so
  // from inside the rail transaction — the preflight is what keeps the
  // facilitator from settling USDC that then rolls back.
  it("terminally refuses a channel deposit onto an exact-funded credit before acceptance", async () => {
    const batch = batchServer();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "exact-credit",
      callerPubkey: "aa".repeat(32),
      currency: "usd",
      amountMicro: 250_000,
      expiryMs: Date.now() + 86_400_000,
      // No `x402Channel`: a one-shot exact authorization leaves the binding
      // NULL, which is exactly the state a channel deposit used to adopt.
      basis: { rail: "x402", paidMsats: 25_000, nativeAmount: 250_000, nativeAsset: "usdc" },
    });

    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: CHANNEL_HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: fx(),
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      callerPubkey: "aa".repeat(32),
      dvmId: "dvm-fund-preflight",
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      fundOnly: {
        creditId: "exact-credit",
        fundId: "fund-1",
        commitment: fundingCommitment(CHANNEL_HEADER),
      },
    });

    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "x402",
        credit_instrument: "x402_exact",
        retryable: false,
      },
    });
    expect(batch.accept).not.toHaveBeenCalled();
    expect((await ledger.get("exact-credit"))?.x402ChannelId).toBeNull();
  });

  // A credit opened before rail basis was recorded is bound just as
  // tightly by the ledger's channel columns, so the preflight has to reach it
  // too — otherwise the facilitator settles USDC the `fund` leg rolls back.
  it("terminally refuses a channel deposit onto a legacy rail-less credit before acceptance", async () => {
    const batch = batchServer();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "legacy-credit",
      callerPubkey: "aa".repeat(32),
      currency: "usd",
      amountMicro: 250_000,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "x402", paidMsats: 25_000, nativeAmount: 250_000, nativeAsset: "usdc" },
    });
    // Only Postgres holds rows this old; the memory ledger always records a
    // rail, so the shape is staged on the read the preflight actually makes.
    const legacy = await ledger.get("legacy-credit");
    if (!legacy) throw new Error("fixture credit missing");
    vi.spyOn(ledger, "get").mockResolvedValue({ ...legacy, rail: null });

    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: CHANNEL_HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: fx(),
      priceFiat: { currency: "usd", amountMicro: 250_000 },
      callerPubkey: "aa".repeat(32),
      dvmId: "dvm-fund-preflight",
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      fundOnly: {
        creditId: "legacy-credit",
        fundId: "fund-1",
        commitment: fundingCommitment(CHANNEL_HEADER),
      },
    });

    expect(result.error?.status).toBe(409);
    expect(result.error?.body).toMatchObject({ error: "payment_invalid", retryable: false });
    // The row's rail and instrument are unreadable, so the refusal names
    // neither rather than guessing one for the agent to relay.
    expect(result.error?.body).not.toHaveProperty("credit_rail");
    expect(result.error?.body).not.toHaveProperty("credit_instrument");
    expect(batch.accept).not.toHaveBeenCalled();
  });

  it("refuses a channel payload on the job route without invoking settlement", async () => {
    const batch = batchServer();
    const result = await verifyUpfrontPayment({
      requiredMsats: 25_000,
      x402Payment: HEADER,
      x402Config: {
        network: "eip155:84532",
        payTo: REQUIREMENT.payTo,
        batchSettlement: {},
      },
      x402BatchSettlement: batch,
      fxFetcher: fx(),
      priceFiat: { currency: "usd", amountMicro: 250_000 },
    });

    expect(result.error?.body.message).toContain("only by POST /v1/credit");
    expect(batch.accept).not.toHaveBeenCalled();
  });
});

describe("x402 batch-settlement credit drain refusals", () => {
  it("returns a complete signed receipt chain and does not countersign a replay", async () => {
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000, RECEIPT_ISSUER);

    const response = await drainRequest(app);
    const body = (await response.json()) as { drain: { receipts: DrainReceipt[] } };
    expect(response.status).toBe(200);
    expect(body.drain.receipts.map((receipt) => receipt.event)).toEqual(["requested", "sent"]);
    expect(body.drain.receipts.every((receipt) => verifyDrainReceipt(receipt))).toBe(true);

    const replay = await drainRequest(app);
    const replayBody = (await replay.json()) as { drain: { receipts: DrainReceipt[] } };
    expect(replay.status).toBe(200);
    expect(replayBody.drain.receipts.map((receipt) => receipt.event)).toEqual([
      "requested",
      "sent",
    ]);
    expect(
      (await ledger.getDrain({ creditId: "credit-1", drainId: "drain-1" }))?.receipts.filter(
        (receipt) => receipt.event === "sent"
      )
    ).toHaveLength(1);
  });

  it("answers a settlement gate race from the ledger as a terminal 409", async () => {
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    // Through the ledger's own builder, so the drain id this refusal names is
    // derived from the effect id here exactly as it is on the live path.
    vi.spyOn(ledger, "requestDrain").mockRejectedValueOnce(
      x402SettlementPending("credit-1", {
        settlementId: "s-raced",
        effectId: "credit-1:earlier-drain",
        status: "settled",
      })
    );

    const response = await drainRequest(app);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "settlement_pending",
      retryable: false,
      settlement_id: "s-raced",
      settlement_status: "settled",
      settlement_drain_id: "earlier-drain",
      // `false` here told `credit.ts` this id was a ghost, so it
      // dropped the drain the run minted and the next run posted a fresh one
      // into the same gate. Both doors give one answer, and it keeps ids.
      drain_registered: true,
      hint: expect.stringContaining("earlier-drain"),
    });
  });

  it("says a running job blocked the refund rather than describing a duplicate payout", async () => {
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    await ledger.draw({
      creditId: "credit-1",
      drawId: "running",
      amountMicro: 50_000,
      jobId: "j1",
    });

    const response = await drainRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: "drain_conflict",
      display: expect.stringContaining("A job is still running against this prepaid balance"),
      hint: expect.stringContaining("Wait for every running job on this credit to finish"),
      // It clears when the job does, which is the opposite of the terminal
      // duplicate-payout conflict this code's default copy carries.
      retryable: true,
      drain_registered: false,
    });
    expect(body.display).not.toContain("already exists");
    expect(body.message).toContain("pending credit draws");
  });

  it("says the balance moved mid-settlement rather than describing a duplicate payout", async () => {
    // The refund bound is read above the channel lock, so a draw
    // settling in between makes the payout the channel is about to make
    // disagree with what the ledger owes — the whole thing rolls back rather
    // than overpay. Staged on the ledger because winning that race for real
    // needs a second machine.
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    const requestDrain = ledger.requestDrain.bind(ledger);
    vi.spyOn(ledger, "requestDrain").mockImplementationOnce(async (args) => {
      const result = await requestDrain(args);
      return { ...result, drain: { ...result.drain, drainedNative: 249_999 } };
    });

    const response = await drainRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: "drain_conflict",
      display: expect.stringContaining("finished while the refund was being paid out"),
      hint: expect.stringContaining("the next attempt reads the balance again"),
      retryable: true,
      drain_registered: false,
    });
    expect(body.display).not.toContain("already exists");
    expect(body.message).toContain("changed balance while the drain was being settled");
  });

  it("says the chain paid short rather than describing a duplicate payout", async () => {
    // The `complete` leg's conflict, and the opposite of the two
    // above: `refundFloorEvidence` throws only once the settlement has moved
    // USDC, so the caller's money is on chain while the ledger leg rolls back
    // around it. It reached `drainLedgerErrorResponse` unclassified
    // and wore the duplicate-payout copy — "poll to collect the existing
    // refund", of a refund that does not exist and never will without the
    // operator.
    const batch = batchServer(undefined, "249000");
    const { app } = await x402Credit(batch, 250_000);

    const response = await drainRequest(app, "drain-short");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({
      error: "drain_conflict",
      display: expect.stringContaining("paid less than the balance this service had recorded"),
      // The repair is the operator's, and it is reported by drain and credit.
      hint: expect.stringContaining("Report drain drain-short on credit credit-1"),
      // Terminal, where the two commit-leg conflicts clear on their own: no
      // retry changes what the chain already paid.
      retryable: false,
      // And the id survives, which is what stops `dvm credit drain` minting a
      // fresh one into the same wall. The `credit_drains` row rolled back, but
      // the wedged settlement holds this drain id as its `effect_id` and the
      // operator's reconcile books the drain under exactly it.
      drain_registered: true,
    });
    expect(body.display).not.toContain("already exists");
    expect(body.hint).not.toContain("Poll with the original method");
    expect(body.drain_id_retired).toBeUndefined();
    // The floor's own arithmetic still travels on `message`, for the operator
    // the caller is being told to report to.
    expect(body.message).toContain("x402 refund settled 249000 for a drain requiring at least");
  });

  it("keeps a raced caller mismatch probe-blind", async () => {
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    vi.spyOn(ledger, "requestDrain").mockRejectedValueOnce(
      new CreditLedgerError("caller_mismatch", "credit belongs to another caller")
    );

    const response = await drainRequest(app);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "credit_not_found",
      message: "No credit credit-1 for this caller.",
    });
  });

  it.each(["refund_bound_unavailable", "refund_exceeds_channel_escrow"] as const)(
    "answers %s as a terminal timed-withdrawal fallback",
    async (reason) => {
      const batch = batchServer(reason);
      const { app } = await x402Credit(batch, 250_000);

      const response = await drainRequest(app);
      const body = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(409);
      expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
      expect(body).toMatchObject({
        error: "drain_conflict",
        retryable: false,
        display: expect.stringContaining("timed on-chain exit"),
        hint: expect.stringContaining("dvm wallet x402-withdraw-initiate <dvm>"),
      });
      expect(batch.accept).toHaveBeenCalledOnce();
    }
  );

  it("short-circuits an empty bound as nothing_to_drain before settlement", async () => {
    const batch = batchServer();
    const { app } = await x402Credit(batch, 0);

    const response = await drainRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({ error: "nothing_to_drain" });
    expect(batch.accept).not.toHaveBeenCalled();
  });

  it("turns a written-off drain replay into an actionable 409", async () => {
    const batch = batchServer("settlement_written_off");
    const { app } = await x402Credit(batch, 250_000);

    const response = await drainRequest(app, "drain-written-off");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({
      error: "drain_conflict",
      display: expect.stringContaining("fresh refund request"),
      hint: expect.stringContaining("new drain_id"),
      // the one thing that changes the outcome, in a field rather
      // than in prose, so the caller can drop this id off its own record
      // without parsing copy. `drain_registered` cannot carry it — refusals
      // that set it want the same id back.
      drain_id_retired: true,
    });
    expect(body.drain_registered).toBeUndefined();
    expect(body.message).toContain("drain-written-off");
  });

  it("refuses a fresh drain on a wedged channel before asking the caller to sign one", async () => {
    // the ledger leg would refuse this anyway. Issuing the challenge
    // first would have the caller sign a refund voucher the DVM already knows
    // it cannot accept — and an agent that signs, gets refused, and retries is
    // a loop.
    const batch = batchServer();
    batch.settlementGate = {
      pendingRefundSettlement: vi.fn(() =>
        Promise.resolve({
          settlementId: "s-1",
          effectId: "credit-1:earlier-drain",
          status: "settled" as const,
        })
      ),
    };
    const { app } = await x402Credit(batch, 250_000);

    const response = await drainRequest(app, "drain-second");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({
      error: "settlement_pending",
      retryable: false,
      settlement_id: "s-1",
      settlement_status: "settled",
      // The exemption a line above this gate, named rather than alluded to
      // a caller who no longer holds it has no other way back to it.
      settlement_drain_id: "earlier-drain",
      drain_registered: true,
      display: expect.stringContaining("this reclaim was not started"),
      hint: expect.stringContaining("earlier-drain"),
    });
    expect(batch.accept).not.toHaveBeenCalled();
  });

  it("refuses a refund voucher signed for another channel, leaving the drain id good", async () => {
    // the settlement layer is what compares the voucher's channel
    // against the credit's, since that is where the value that pays is read.
    // What this pins is the route's half — the credit's bound channel reaches
    // it, and the refusal comes back terminal rather than as a 402 the caller's
    // agent would re-sign into.
    const batch = batchServer("wrong_channel");
    const { app, ledger } = await x402Credit(batch, 250_000);

    const response = await drainRequest(app, "drain-wrong-channel");
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({
      error: "drain_conflict",
      retryable: false,
      drain_registered: false,
      credit_channel_id: CHANNEL_ID,
      display: expect.stringContaining("different payment channel"),
      // The opposite of the written-off answer: nothing was registered, so this
      // drain id is still free.
      hint: expect.stringContaining("same drain_id still works"),
    });
    // And the field that says so, absent here — a caller that retired this id
    // would re-sign a fresh voucher for a drain it no longer has on record.
    expect(body.drain_id_retired).toBeUndefined();
    expect(batch.accept).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "refund", expectedChannelId: CHANNEL_ID })
    );
    // No settlement was reached and no ledger debit happened.
    expect(await ledger.get("credit-1")).toMatchObject({ balanceMicro: 250_000 });
    expect(
      await ledger.getDrain({ creditId: "credit-1", drainId: "drain-wrong-channel" })
    ).toBeUndefined();
  });

  it("refuses a top-up onto a wedged channel before any payment is accepted", async () => {
    // `fund` refuses this too, but from inside the rail transaction —
    // by then the caller's USDC is in escrow on a channel whose refund may
    // already have emptied it, and the rollback hands them nothing back. The
    // refusal has to land on the discovery hop, before a challenge is issued.
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    ledger.useX402SettlementGate?.({
      pendingRefundSettlement: vi.fn(() =>
        Promise.resolve({
          settlementId: "s-1",
          effectId: "credit-1:earlier-drain",
          status: "settled" as const,
        })
      ),
    });

    const response = await fundRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(response.headers.get("PAYMENT-REQUIRED")).toBeNull();
    expect(body).toMatchObject({
      error: "settlement_pending",
      retryable: false,
      settlement_id: "s-1",
      settlement_status: "settled",
      // the third door of one hold, answering from the same taxonomy
      // as the two drain doors. What the funder most likely wants next is the
      // balance already sitting there, and the id that reclaim goes through is
      // knowable at this line.
      settlement_drain_id: "earlier-drain",
      display: expect.stringContaining("No money was added"),
      hint: expect.stringContaining("earlier-drain"),
    });
    // The registry's spend copy is written for a caller mid-job; a funder is not
    // one, and this door used to relay it verbatim.
    expect(body.hint).not.toContain("while this one settles");
    // A top-up posts no drain id, so there is none to keep or retire — the field
    // that says whether the caller keeps one has nothing to answer about.
    expect(body.drain_registered).toBeUndefined();
    expect(body.drain_id_retired).toBeUndefined();
    expect(batch.buildRequirements).not.toHaveBeenCalled();
    expect(batch.accept).not.toHaveBeenCalled();
    expect((await ledger.get("credit-1"))?.balanceMicro).toBe(250_000);
  });

  it("names no drain id on a top-up when the settlement's effect belongs to another credit", async () => {
    // A guess is worse than silence: the effect id is the only place the pairing
    // lives, and a prefix that doesn't match this credit is not this credit's
    // drain. The funder still gets a funder's answer — the deposit was refused,
    // nothing was charged — with the reclaim sentence falling back to the
    // exemption rather than naming an id nobody holds.
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    ledger.useX402SettlementGate?.({
      pendingRefundSettlement: vi.fn(() =>
        Promise.resolve({
          settlementId: "s-1",
          effectId: "credit-9:its-own-drain",
          status: "settled" as const,
        })
      ),
    });

    const response = await fundRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: "settlement_pending",
      settlement_id: "s-1",
      settlement_status: "settled",
      display: expect.stringContaining("No money was added"),
      hint: expect.stringContaining("already in flight"),
    });
    expect(body.settlement_drain_id).toBeUndefined();
    expect(body.drain_registered).toBeUndefined();
  });

  it("names no drain id on a top-up refused by a written-off settlement, and sends the funder to a fresh one", async () => {
    // this door gates on X402_SPEND_BLOCKING_SETTLEMENT_STATUSES,
    // which is the wedged pair *plus* `written_off` — a state the two drain
    // doors cannot reach. There the effect's drain id is the one `accept`
    // refuses as `drain_id_retired` and a fresh id is what reclaims
    // the balance, so relaying the wedged door's "the only one admitted" would
    // aim a funder at the single id that can never work.
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    ledger.useX402SettlementGate?.({
      pendingRefundSettlement: vi.fn(() =>
        Promise.resolve({
          settlementId: "s-1",
          effectId: "credit-1:earlier-drain",
          status: "written_off" as const,
        })
      ),
    });

    const response = await fundRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      error: "settlement_pending",
      retryable: false,
      settlement_id: "s-1",
      // The status is what tells an agent which of the two states it is in, so
      // it rides even where the id does not.
      settlement_status: "written_off",
      display: expect.stringContaining("closed out without being paid"),
      hint: expect.stringContaining("fresh drain_id"),
    });
    expect(body.settlement_drain_id).toBeUndefined();
    expect(body.hint).not.toContain("earlier-drain");
    // The operator has already closed this out, so the wedged copy's "wait for
    // the service operator" is advice for a state that has passed.
    expect(body.hint).not.toContain("until the service operator closes the refund out");
    expect(body.drain_registered).toBeUndefined();
    expect(body.drain_id_retired).toBeUndefined();
    expect(batch.buildRequirements).not.toHaveBeenCalled();
    expect((await ledger.get("credit-1"))?.balanceMicro).toBe(250_000);
  });

  it("still issues the ordinary funding challenge when nothing is wedged", async () => {
    const batch = batchServer();
    const { app, ledger } = await x402Credit(batch, 250_000);
    ledger.useX402SettlementGate?.({
      pendingRefundSettlement: vi.fn(() => Promise.resolve(undefined)),
    });

    const response = await fundRequest(app);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(402);
    expect(body).toMatchObject({ error: "payment_required", required_msats: 250_000 });
  });

  it("lets the wedged drain's own id back through, which is how the reclaim finishes", async () => {
    const batch = batchServer();
    batch.settlementGate = {
      pendingRefundSettlement: vi.fn(() =>
        Promise.resolve({
          settlementId: "s-1",
          effectId: "credit-1:drain-1",
          status: "settled" as const,
        })
      ),
    };
    const { app } = await x402Credit(batch, 250_000);

    const response = await drainRequest(app, "drain-1");
    expect(response.status).toBe(200);
    expect(batch.accept).toHaveBeenCalledOnce();
    expect(batch.accept).toHaveBeenCalledWith(
      expect.objectContaining({ expectedChannelId: CHANNEL_ID })
    );
  });
});
