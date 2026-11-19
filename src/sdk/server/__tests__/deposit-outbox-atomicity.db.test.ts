import pg from "pg";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Credential } from "mppx";
import { tempo as tempoClient } from "mppx/client";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import unsignedReports from "../../../../protocol-fixtures/unsigned-caller-reports-v1.json";
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
import { createMppFromOpts, readTempoChargePayer } from "../mpp-setup";
import {
  creditDepositPayload,
  verifyIncomingPayment,
  type VerifyIncomingSnapshot,
  verifyUpfrontPayment,
} from "../payment";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { X402ExactSettlementServer } from "../x402-exact-settlement";
import { PostgresX402ExactSettlementStore } from "../x402-exact-settlement-store";

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
const { payerAddress } = unsignedReports.x402_exact_deposit.body;
const tempoDeposit = unsignedReports.tempo_charge_deposit.body;
const TEMPO_PAYER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const TEMPO_SPONSOR = privateKeyToAccount(`0x${"22".repeat(32)}`);
const TEMPO_RECIPIENT = `0x${"33".repeat(20)}` as const;
const TEMPO_TOKEN = `0x${"44".repeat(20)}` as const;
const TEMPO_HASH = `0x${"aa".repeat(32)}` as const;

function paymentMemo(challenge: { id: string; realm: string }): Hex {
  return `0x${keccak256(toHex("mpp")).slice(2, 10)}01${keccak256(toHex(challenge.realm)).slice(2, 22)}${"00".repeat(10)}${keccak256(toHex(challenge.id)).slice(2, 16)}`;
}

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
function exactArtifact(nonce: string, from = `0x${"aB".repeat(20)}`): string {
  return encodePayment({
    x402Version: X402_V1_VERSION,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: `0x${"44".repeat(65)}`,
      authorization: {
        from,
        to: X402.payTo,
        value: String(PRICE_MICRO),
        validAfter: "0",
        validBefore: "99999999999",
        nonce: `0x${nonce.repeat(32)}`,
      },
    },
  });
}
const ARTIFACT = exactArtifact("55");

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
      authorizer: payerAddress,
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
      const deposits = await pendingDeposits();
      expect(deposits).toEqual([
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
      expect(deposits[0]?.payload).not.toHaveProperty("payerAddress");
      expect(
        await pool.query("SELECT 1 FROM pending_revenue_reports")
      ).toMatchObject({ rowCount: 0 });
    } finally {
      await built.shutdown();
    }
  });

  it.each(["durable", "fallback"] as const)("queues the verified authorizer with %s upfront funding", async (mode) => {
    const opts = upfrontOpts("0xupfront");
    const store = new PostgresX402ExactSettlementStore(pool);
    const facilitatorPayer = `0x${"cd".repeat(20)}`;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = String(input);
      if (url === `${X402.facilitator}/verify`) return Response.json({ isValid: true });
      if (url === `${X402.facilitator}/settle`) {
        return Response.json({ success: true, transaction: "0xupfront", payer: facilitatorPayer });
      }
      throw new Error("unexpected facilitator request");
    }));
    if (mode === "durable") {
      await store.init();
    } else {
      const actual = await vi.importActual<typeof import("../../../lib/x402")>("../../../lib/x402");
      vi.mocked(verifyX402Payment).mockImplementationOnce(actual.verifyX402Payment);
    }
    const result = await verifyUpfrontPayment({
      ...opts,
      x402Payment: exactArtifact("56"),
      ...(mode === "durable" && { x402ExactSettlement: new X402ExactSettlementServer({ store }) }),
    });

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
          instrument: "x402_exact",
          payerAddress,
        }),
      },
    ]);
    const settleResponse = JSON.parse(Buffer.from(result.x402SettleResponseHeader!, "base64").toString());
    expect(settleResponse).toMatchObject({ payer: facilitatorPayer });
    expect(JSON.stringify(settleResponse).toLowerCase()).not.toContain(payerAddress);
  });

  it.each([
    { creditId: "reusable-credit", existing: false },
    { creditId: `x402d:${"ad".repeat(32)}`, existing: true },
  ])("omits the authorizer from explicit reusable funding for $creditId", async ({ creditId, existing }) => {
    if (existing) {
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
          fundingRef: "0xearlier",
        },
      });
    }
    const result = await verifyUpfrontPayment({
      ...upfrontOpts("0xreusable"),
      creditEnvelope: {
        creditId,
        drawId: "first-draw",
        fund: { amountMicro: PRICE_MICRO, commitment: fundingCommitment(ARTIFACT) },
      },
    });
    expect(result.error).toBeUndefined();
    const deposits = await pendingDeposits();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.payload).toMatchObject({ creditId, callerPubkey: CALLER, instrument: "x402_exact" });
    expect(deposits[0]?.payload).not.toHaveProperty("payerAddress");
  });

  it("omits the authorizer from the callback payload when a short upfront payment creates no deposit", async () => {
    const opts = upfrontOpts("0xshort");
    settles("0xshort", PRICE_MSATS / 2);

    const result = await verifyUpfrontPayment(opts);

    expect(result.error).toBeUndefined();
    expect(await pendingDeposits()).toEqual([]);
    const payload = creditDepositPayload(DVM_ID, result.funding!);
    expect(payload).toMatchObject({
      fundingId: "0xshort",
      callerPubkey: CALLER,
      instrument: "x402_exact",
      amountMicro: PRICE_MICRO / 2,
    });
    expect(payload).not.toHaveProperty("payerAddress");
  });

  function tempoServer() {
    return createMppFromOpts({ tempoRecipient: TEMPO_RECIPIENT, realm: "payments.example.com" }, {
      DVMKIT_TEMPO_SECRET_KEY: "42".repeat(32),
      DVMKIT_TEMPO_CURRENCY: TEMPO_TOKEN,
    })!;
  }

  it.each([
    "push", "sponsored push", "pull", "sponsored pull", "top-up", "explicit fund-and-draw", "unverified",
    "reverted", "missing transfer evidence", "wrong transfer token", "wrong transfer recipient",
    "wrong memo on conflicting receipt", "missing receipt reference", "stalled receipt reread",
  ] as const)("reports only the settled one-request Tempo payer for %s", async (scenario) => {
    const mpp = tempoServer();
    const topUp = scenario === "top-up";
    const explicitFunding = scenario === "explicit fund-and-draw";
    const creditId = "tempo-reusable-credit";
    const drawId = "first-draw";
    const pull = scenario === "pull" || scenario === "sponsored pull" || scenario === "reverted";
    const sponsored = scenario.startsWith("sponsored");
    const conflictingTransfer = scenario === "missing transfer evidence" || scenario === "wrong memo on conflicting receipt" ||
      scenario === "wrong transfer token" || scenario === "wrong transfer recipient";
    const resourcePath = topUp ? "/v1/credit" : "/v1/job";
    const challenge = await mpp.issueChallenge("tempo", "charge", {
      amount: "0.10",
      meta: { path: resourcePath, nonce: "test-charge" },
    });
    const memo = paymentMemo(challenge);
    const signature = pull ? await TEMPO_PAYER.signTransaction({
      type: "tempo",
      chainId: 4217,
      nonce: 1,
      gas: 200_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1n,
      calls: [{
        to: TEMPO_TOKEN,
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: "transferWithMemo",
          args: [TEMPO_RECIPIENT, BigInt(PRICE_MICRO), memo],
        }),
      }],
      ...(sponsored && { feePayer: TEMPO_SPONSOR }),
    }, { serializer: Transaction.serialize }) : undefined;
    const source = sponsored && !pull ? TEMPO_PAYER.address : TEMPO_SPONSOR.address;
    const mppCredential = Credential.serialize(Credential.from({
      challenge: scenario === "unverified" ? { ...challenge, id: "invalid-challenge" } : challenge,
      payload: signature ? { type: "transaction", signature } : { type: "hash", hash: TEMPO_HASH },
      ...(pull || sponsored ? { source: `did:pkh:eip155:4217:${source}` } : {}),
    }));
    const transferLog = (
      from: Hex, amount: number, logIndex: Hex, address: Hex = TEMPO_TOKEN, to: Hex = TEMPO_RECIPIENT,
      transferMemo = memo
    ) => ({
      address,
      topics: encodeEventTopics({
        abi: Abis.tip20, eventName: "TransferWithMemo", args: { from, to, memo: transferMemo },
      }),
      data: encodeAbiParameters([{ type: "uint256" }], [BigInt(amount)]),
      logIndex,
    });
    const responseHash = signature ? keccak256(signature) : TEMPO_HASH;
    let receiptReads = 0;
    const stalledBody = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const deliveries: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://platform.invalid/_internal/credit-deposit") {
        deliveries.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: deliveries.length === 1 ? 503 : 200 });
      }
      const rpc = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
      let result: unknown;
      if (rpc.method === "eth_call") {
        result = "0x";
      } else if (rpc.method === "eth_getTransactionReceipt" || rpc.method === "eth_sendRawTransactionSync") {
        if (rpc.method === "eth_getTransactionReceipt") {
          expect(rpc.params).toEqual([TEMPO_HASH]);
          receiptReads++;
          if (scenario === "stalled receipt reread" && receiptReads > 2) {
            return new Response(new ReadableStream<Uint8Array>({
              start(controller) { stalledBody.resolve(controller); },
            }), { headers: { "Content-Type": "application/json" } });
          }
        }
        // A contradictory RPC result can still contain a valid payment from
        // its stated sender. It must not attribute a decoy to the preflight sender.
        const conflictingReceipt = conflictingTransfer && receiptReads === 2;
        result = {
          status: scenario === "reverted" ? "0x0" : "0x1",
          ...(scenario !== "missing receipt reference" || receiptReads !== 2
            ? { transactionHash: responseHash } : {}),
          from: (sponsored && !pull) || conflictingReceipt ? TEMPO_SPONSOR.address : TEMPO_PAYER.address,
          to: TEMPO_TOKEN,
          logs: [
            transferLog(TEMPO_SPONSOR.address, sponsored || conflictingReceipt ? PRICE_MICRO : PRICE_MICRO - 1, "0x0"),
            transferLog(
              TEMPO_PAYER.address,
              scenario === "missing transfer evidence" && receiptReads >= 2 ? PRICE_MICRO - 1 : PRICE_MICRO,
              "0x1",
              conflictingReceipt && scenario === "wrong transfer token" ? TEMPO_RECIPIENT : TEMPO_TOKEN,
              conflictingReceipt && scenario === "wrong transfer recipient" ? TEMPO_TOKEN : TEMPO_RECIPIENT,
              conflictingReceipt && scenario === "wrong memo on conflicting receipt"
                ? paymentMemo({ ...challenge, id: "different-challenge" }) : memo
            ),
          ],
        };
      } else {
        throw new Error(`Unexpected test RPC method: ${rpc.method}`);
      }
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }));
    const { x402Payment: _, x402Config: __, ...opts } = upfrontOpts("tempo-charge");
    const booking = verifyUpfrontPayment({
      ...opts,
      mpp,
      mppCredential,
      resourcePath,
      fxFetcher: stubFx,
      ...(explicitFunding && { creditEnvelope: {
        creditId,
        drawId,
        fund: { amountMicro: PRICE_MICRO, commitment: fundingCommitment(mppCredential) },
      } }),
      ...(topUp && { fundOnly: {
        creditId: "tempo-top-up",
        fundId: "first-funding",
        commitment: fundingCommitment(mppCredential),
        allowOneShotStablecoin: true,
      } }),
    });
    if (scenario === "stalled receipt reread") {
      const body = await Promise.race([booking.then(() => undefined), stalledBody.promise]);
      if (body) {
        let bookedWhileStalled: boolean;
        try {
          bookedWhileStalled = await Promise.race([
            booking.then(() => true),
            new Promise<false>((resolve) => setTimeout(resolve, 1_350, false)),
          ]);
        } finally {
          body.error(new Error("Test released the stalled receipt body"));
          await booking;
        }
        expect(bookedWhileStalled, "A stalled optional receipt read held up deposit booking").toBe(true);
      }
      expect(receiptReads).toBe(2);
    }
    const result = await booking;

    if (scenario === "unverified" || scenario === "reverted") {
      expect(result.error?.status).toBe(402);
      expect(await pendingDeposits()).toEqual([]);
      return;
    }
    expect(result.error).toBeUndefined();
    const deposits = await pendingDeposits();
    expect(deposits).toEqual([{ payload: expect.objectContaining({
      rail: tempoDeposit.rail,
      instrument: tempoDeposit.instrument,
      callerPubkey: CALLER,
      amountMicro: PRICE_MICRO,
    }) }]);
    if (explicitFunding) {
      expect(deposits[0]?.payload).toHaveProperty("creditId", creditId);
      expect(await ledger.getDraw({ creditId, drawId })).toMatchObject({ amountMicro: PRICE_MICRO });
      expect(creditDepositPayload(DVM_ID, result.funding!)).not.toHaveProperty("payerAddress");
    }
    if (topUp || explicitFunding || conflictingTransfer || scenario === "missing receipt reference") {
      if (conflictingTransfer) expect(receiptReads).toBe(2);
      expect(deposits[0]?.payload).not.toHaveProperty("payerAddress");
      return;
    }
    expect(deposits[0]?.payload).toHaveProperty("payerAddress", tempoDeposit.payerAddress);
    if (scenario === "sponsored push") {
      await reporter.drainPending();
      await pool.query("UPDATE pending_dvm_reports SET next_retry_at = 0");
      await reporter.drainPending();
      expect(deliveries).toEqual([deposits[0]?.payload, deposits[0]?.payload]);
      expect(await pendingDeposits()).toEqual([]);
    }
  });

  it("does not attribute a verified zero-amount Tempo proof to a transfer payer", async () => {
    const mpp = tempoServer();
    const challenge = await mpp.challenge.tempo.charge({ amount: "0" });
    const client = tempoClient.charge({ account: TEMPO_PAYER });
    const credential = await client.createCredential({ challenge, context: { account: TEMPO_PAYER } });
    const receipt = await mpp.broadcastCredential(credential);
    expect(receipt.status).toBe("success");
    expect(readTempoChargePayer(receipt)).toBeUndefined();
    const { x402Payment: _, x402Config: __, ...opts } = upfrontOpts("tempo-proof");
    await verifyUpfrontPayment({
      ...opts, requiredMsats: 0, priceFiat: { currency: "usd", amountMicro: 0 },
      mpp, mppCredential: credential,
    });
    expect(await pendingDeposits()).toEqual([]);
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
    const deposits = await pendingDeposits();
    expect(deposits).toHaveLength(1);
    expect(deposits[0]?.payload).not.toHaveProperty("payerAddress");
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
