import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { msatsToUsdc } from "../../../lib/currency";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { creditDepositPayload, verifyUpfrontPayment } from "../payment";
import { MemoryProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter, type RevenueReporterQuerier } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

/**
 * An x402 settle that returns no transaction hash still moved money, so the
 * ledger leg keys its marker and funding on the EIP-3009 authorization, which
 * is single-use on chain. Neither an implicit N=1 payment nor an explicitly
 * signed `fund` block is accepted without a ledger row.
 */

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const REQUIRED_MSATS = 10_000;
const PRICE_FIAT = { currency: "usd", amountMicro: 10_000 };
const NONCE = `0x${"cd".repeat(32)}`;
const FROM = `0x${"ab".repeat(20)}`;
const CALLER = "aa".repeat(32);
const DVM_ID = "dvm-1";
const LEGACY_ID = `eip3009:${FROM}:${NONCE}`;
// Digest of the normalized legacy identity, computed independently.
const AUTHORIZATION_ID = "eip3009:sha256:4c71c1dccd5fff3d021b506b75057c7e9b68838c55a71b70716be79f93faf7d4";
const LEGACY_REPORT_DRAW_ID = `x402-report-draw:${AUTHORIZATION_ID}`;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

function paymentHeader(from = FROM, nonce = NONCE): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: "0xdeadbeef",
      authorization: { from, to: X402.payTo, value: "10000",
        validAfter: "0", validBefore: "9999999999", nonce },
    },
  });
}

function snapshot(usd: number): FxRateSnapshot {
  return { rates: { usd } as FxRateSnapshot["rates"], as_of: new Date(0).toISOString() };
}

function warmFetcher(): FxFetcher {
  return {
    fetch: vi.fn(() => Promise.resolve(snapshot(RATE))),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

describe("x402 settle without a transaction reference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: REQUIRED_MSATS,
      amountUsdcMicro: msatsToUsdc(REQUIRED_MSATS, RATE),
      txHash: undefined,
      settleResponseHeader: "hdr",
    });
  });

  it("records an explicitly signed fund block under the authorization", async () => {
    const ledger = new MemoryCreditLedger();
    const processedPayments = new MemoryProcessedPaymentStore();
    const pay = (header: string, drawId = "d1") => verifyUpfrontPayment({
      x402Payment: header,
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments,
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
      creditEnvelope: {
        creditId: "c1",
        drawId,
        fund: {
          amountMicro: PRICE_FIAT.amountMicro,
          commitment: fundingCommitment(header),
        },
      },
    });

    const result = await pay(paymentHeader(`0x${"Ab".repeat(20)}`, `0x${"Cd".repeat(32)}`));
    expect(result.error).toBeUndefined();
    expect(result.funding?.fundingId).toBe(AUTHORIZATION_ID);
    expect(await ledger.getFunding({ creditId: "c1", fundId: AUTHORIZATION_ID }))
      .toMatchObject({ amountMicro: PRICE_FIAT.amountMicro });
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toMatchObject({ status: "pending" });
    // A differently cased presentation of the authorization still collides.
    expect((await pay(paymentHeader(), "d2")).error).toMatchObject({
      status: 409, replayPaymentId: AUTHORIZATION_ID,
    });
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d2" })).toBeUndefined();
    expect((await ledger.get("c1"))?.balanceMicro).toBe(PRICE_FIAT.amountMicro);
  });

  it("keys an implicit N=1 funding on the authorization", async () => {
    const ledger = new MemoryCreditLedger();
    const result = await verifyUpfrontPayment({
      x402Payment: paymentHeader(),
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments: new MemoryProcessedPaymentStore(),
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(REQUIRED_MSATS);
    expect(result.creditId).toBe(`imp:x402:${AUTHORIZATION_ID}`);
    expect(result.upfrontPayment?.draw_id).toBe(AUTHORIZATION_ID);
    expect(creditDepositPayload(DVM_ID, result.funding!)).toMatchObject({
      fundingId: AUTHORIZATION_ID,
      creditId: `imp:x402:${AUTHORIZATION_ID}`,
    });
    expect(await ledger.getDraw({ creditId: `imp:x402:${AUTHORIZATION_ID}`, drawId: AUTHORIZATION_ID }))
      .toMatchObject({ status: "pending", amountMicro: PRICE_FIAT.amountMicro });
  });

  it.each([true, false])("refuses a legacy funding replay before opening a second credit or draw (marker store: %s)", async (withMarkers) => {
    const ledger = new MemoryCreditLedger();
    const processedPayments = withMarkers ? new MemoryProcessedPaymentStore() : undefined;
    const creditId = `imp:x402:${LEGACY_ID}`;
    await ledger.fund({
      creditId, callerPubkey: CALLER, currency: "usd", amountMicro: PRICE_FIAT.amountMicro,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "x402", paidMsats: REQUIRED_MSATS, fundingRef: LEGACY_ID },
    });
    await ledger.draw({ creditId, drawId: LEGACY_ID, amountMicro: PRICE_FIAT.amountMicro });
    await processedPayments?.record({ dvmId: DVM_ID, rail: "x402", paymentId: LEGACY_ID, creditId, drawId: LEGACY_ID });

    const replay = await verifyUpfrontPayment({
      x402Payment: paymentHeader(),
      x402Config: X402,
      requiredMsats: REQUIRED_MSATS,
      fxFetcher: warmFetcher(),
      creditLedger: ledger,
      processedPayments,
      priceFiat: PRICE_FIAT,
      callerPubkey: CALLER,
      dvmId: DVM_ID,
    });

    expect(replay.error).toMatchObject({ status: 409, replayPaymentId: AUTHORIZATION_ID });
    expect(JSON.stringify(replay.error)).not.toContain(FROM);
    expect(replay.funding).toBeUndefined();
    expect(await processedPayments?.get({ dvmId: DVM_ID, rail: "x402", paymentId: AUTHORIZATION_ID })).toBeUndefined();
    expect(await ledger.get(`imp:x402:${AUTHORIZATION_ID}`)).toBeUndefined();
    expect(await ledger.listPendingDraws(creditId)).toHaveLength(1);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(PRICE_FIAT.amountMicro);
  });

  it.each([false, true])("recovers the original hashless job (legacy IDs: %s)", async (legacy) => {
    const onJob = vi.fn((ctx: { complete(message: string): void }) => ctx.complete("done"));
    const onJobCompleted = vi.fn();
    const ledger = new MemoryCreditLedger();
    const jobStore = new MemoryJobStore();
    const server = await createDVMServer(configureDVM({
      name: "x402-funding-replay",
      capabilities: { run: { input: z.object({ input: z.string() }), price: "$0.01", onJob } },
    }), {
      env: {}, devMode: true, store: new MemoryKVStore(), jobStore,
      dvmId: DVM_ID, x402: X402, fxFetcher: warmFetcher(), creditLedger: ledger, onJobCompleted,
    });
    const submit = (input: string) => server.app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader() },
      body: JSON.stringify({ capability: "run", data: { input } }),
    });
    try {
      if (legacy) {
        // Seed the historical marker and credit keys through the acceptance path.
        vi.mocked(verifyX402Payment).mockResolvedValueOnce({
          verified: true, amountMsats: REQUIRED_MSATS, amountUsdcMicro: PRICE_FIAT.amountMicro,
          txHash: LEGACY_ID, settleResponseHeader: "hdr",
        });
      }
      const original = await submit("original");
      const identity = await original.json() as { job_id: string };
      expect(original.status).toBe(200);
      const job = await jobStore.get(identity.job_id);
      if (!job) throw new Error("expected an accepted job");
      if (legacy) {
        await jobStore.save({ ...job, paymentTxHash: undefined, paymentTransactionHash: undefined });
      }
      expect((await jobStore.get(identity.job_id))?.paymentTxHash).toBeUndefined();
      expect(job.creditId).toBe(`imp:x402:${legacy ? LEGACY_ID : AUTHORIZATION_ID}`);

      const replay = await submit("original");
      expect(replay.status).toBe(200);
      expect(await replay.json()).toMatchObject({ job_id: identity.job_id });
      const mismatch = await submit("different");
      expect(mismatch.status).toBe(409);
      expect(await mismatch.text()).not.toContain(FROM);
      expect(onJob).toHaveBeenCalledTimes(1);
      expect(await ledger.getDraw({ creditId: job.creditId!, drawId: job.drawId! })).toMatchObject({
        status: "settled", amountMicro: PRICE_FIAT.amountMicro,
      });
      await vi.waitFor(() => expect(onJobCompleted).toHaveBeenCalledTimes(1));
      expect(onJobCompleted.mock.calls[0]?.[0]).toMatchObject({
        jobId: job.id, paymentTxHash: AUTHORIZATION_ID, fundingRef: AUTHORIZATION_ID,
      });
      if (legacy) expect(await ledger.get(`imp:x402:${AUTHORIZATION_ID}`)).toBeUndefined();
    } finally {
      await server.shutdown();
    }
  });

  it("reports a recovered historical draw separately from a caller draw on the same credit", async () => {
    const schema = z.object({
      input: z.string(), pubkey: z.string(), signature: z.string(),
      timestamp: z.number(), nonce: z.string(),
    });
    const signer = createSignedRequestVerifier(schema);
    const secret = new Uint8Array(32).fill(17);
    const jobStore = new MemoryJobStore();
    const save = jobStore.save.bind(jobStore);
    vi.spyOn(jobStore, "save").mockRejectedValueOnce(new Error("initial job save failed")).mockImplementation(save);
    const ledger = new MemoryCreditLedger();
    const onCreditFunded = vi.fn();
    const onJobCompleted = vi.fn();
    const onJob = vi.fn((ctx: { complete(message: string): void }) => ctx.complete("done"));
    const server = await createDVMServer(configureDVM({
      name: "x402-funding-resume",
      capabilities: { run: { input: schema, price: "$0.01", onJob } },
      auth: secp256k1Auth(),
    }), {
      env: {}, devMode: true, store: new MemoryKVStore(), jobStore,
      dvmId: DVM_ID, x402: X402, fxFetcher: warmFetcher(), creditLedger: ledger,
      onCreditFunded, onJobCompleted,
    });
    const submit = (
      path: string,
      payment?: string,
      envelope: Record<string, unknown> = { request_id: "resume-payment" }
    ) => server.app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(payment && { "X-PAYMENT": payment }) },
      body: JSON.stringify({
        capability: "run",
        data: signer.signRequest(secret, { input: "original", ...envelope }),
      }),
    });
    try {
      vi.mocked(verifyX402Payment).mockResolvedValueOnce({
        verified: true, amountMsats: REQUIRED_MSATS, amountUsdcMicro: PRICE_FIAT.amountMicro,
        txHash: LEGACY_ID, settleResponseHeader: "hdr",
      });
      const first = await submit("/v1/job", paymentHeader());
      expect(first.status, await first.clone().text()).toBe(500);
      expect(onJob).not.toHaveBeenCalled();
      const ledgerKeys = { creditId: `imp:x402:${LEGACY_ID}`, drawId: LEGACY_ID };
      const original = await ledger.getDraw(ledgerKeys);
      expect(original).toMatchObject({ status: "pending" });

      const resumed = await submit("/v1/request-resume/resume-payment");
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      expect(await resumed.json()).toMatchObject({ job_id: original?.jobId });
      expect(verifyX402Payment).toHaveBeenCalledTimes(1);
      expect(onJob).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(onJobCompleted).toHaveBeenCalledTimes(1));
      expect(onCreditFunded).toHaveBeenCalledTimes(1);
      const deposit = onCreditFunded.mock.calls[0]?.[0];
      expect(deposit).toMatchObject({ fundingId: AUTHORIZATION_ID, creditId: `imp:x402:${AUTHORIZATION_ID}` });
      expect(onJobCompleted.mock.calls[0]?.[0]).toMatchObject({
        jobId: original?.jobId,
        paymentTxHash: AUTHORIZATION_ID,
        fundingRef: deposit.fundingId,
        creditId: deposit.creditId,
        drawAmountMicro: PRICE_FIAT.amountMicro,
      });
      expect(await ledger.getDraw(ledgerKeys)).toMatchObject({ status: "settled" });
      expect(await ledger.get(deposit.creditId)).toBeUndefined();
      expect(await jobStore.get(original!.jobId!)).toMatchObject({
        ...ledgerKeys, paymentTxHash: AUTHORIZATION_ID,
      });

      await ledger.fund({
        creditId: ledgerKeys.creditId,
        callerPubkey: signer.signRequest(secret, { input: "original" }).pubkey,
        currency: "usd",
        amountMicro: PRICE_FIAT.amountMicro,
        expiryMs: Date.now() + 60_000,
        basis: { rail: "x402", paidMsats: REQUIRED_MSATS, nativeAmount: PRICE_FIAT.amountMicro, nativeAsset: "usdc" },
      });
      const namedDraw = await submit("/v1/job", undefined, { credit_id: ledgerKeys.creditId, draw_id: AUTHORIZATION_ID });
      expect(namedDraw.status, await namedDraw.clone().text()).toBe(200);
      await vi.waitFor(() => expect(onJobCompleted).toHaveBeenCalledTimes(2));
      expect(onJobCompleted.mock.calls.map(([report]) => [report.creditId, report.drawId])).toEqual([
        [deposit.creditId, LEGACY_REPORT_DRAW_ID],
        [deposit.creditId, AUTHORIZATION_ID],
      ]);

      const reserved = await submit("/v1/job", paymentHeader(), {
        credit_id: ledgerKeys.creditId,
        draw_id: LEGACY_REPORT_DRAW_ID,
        fund: { amount_micro: PRICE_FIAT.amountMicro, commitment: fundingCommitment(paymentHeader()) },
      });
      expect(reserved.status).toBe(409);
      expect(await reserved.json()).toMatchObject({ error: "draw_conflict" });
      expect(verifyX402Payment).toHaveBeenCalledTimes(1);
      expect(await ledger.getDraw({ creditId: ledgerKeys.creditId, drawId: LEGACY_REPORT_DRAW_ID })).toBeUndefined();
    } finally {
      await server.shutdown();
    }
  });

  it("joins a Cashu drain on a historical x402 credit to the opaque deposit key", async () => {
    const queued: object[] = [];
    const db = {
      query: async (_sql: string, values: string[]) => {
        queued.push(JSON.parse(values[1]));
        return { rows: [], rowCount: 1 };
      },
    } as unknown as RevenueReporterQuerier & ConstructorParameters<typeof RevenueReporter>[0];
    const reporter = new RevenueReporter(db, "https://example.com", "test-token");
    const creditId = `imp:x402:${LEGACY_ID}`;
    const deposit = creditDepositPayload(DVM_ID, {
      creditId, callerPubkey: CALLER, fundingId: LEGACY_ID,
      rail: "x402", paidMsats: 10_000, amountMicro: 10_000, currency: "usd", fundedAt: 100, expiryMs: 1000,
    });
    await reporter.enqueueDeposit(db, deposit);
    await reporter.enqueueCreditDrain(db, {
      dvmId: DVM_ID, creditId, callerPubkey: CALLER, drainId: "cashu-drain",
      method: "cashu", status: "picked_up", creditCurrency: "usd", amountMicro: 10_000, drainedAt: 200,
    });
    expect(queued).toMatchObject([
      { creditId: `imp:x402:${AUTHORIZATION_ID}`, fundingId: AUTHORIZATION_ID },
      { creditId: `imp:x402:${AUTHORIZATION_ID}`, drainId: "cashu-drain", method: "cashu" },
    ]);
  });

  it("refuses a reserved standing-mandate draw before a zero-upfront handler runs", async () => {
    const schema = z.object({
      input: z.string(), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
    });
    const signer = createSignedRequestVerifier(schema);
    const secret = new Uint8Array(32).fill(17);
    const creditId = `imp:x402:${LEGACY_ID}`;
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId,
      callerPubkey: signer.signRequest(secret, { input: "original" }).pubkey,
      currency: "usd",
      amountMicro: PRICE_FIAT.amountMicro,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "x402", paidMsats: REQUIRED_MSATS, fundingRef: LEGACY_ID },
    });
    const onJob = vi.fn((ctx: { complete(message: string): void }) => ctx.complete("done"));
    const auth = secp256k1Auth();
    const recordReplay = vi.spyOn(auth, "recordReplay");
    const server = await createDVMServer(configureDVM({
      name: "x402-standing-mandate",
      capabilities: { run: { input: schema, onJob } },
      auth,
    }), {
      env: {}, devMode: true, store: new MemoryKVStore(), jobStore: new MemoryJobStore(),
      dvmId: DVM_ID, x402: X402, fxFetcher: warmFetcher(), creditLedger: ledger,
    });
    const submit = (drawId: string) => server.app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "run",
        data: signer.signRequest(secret, {
          input: "original",
          credit_id: creditId,
          draw_id: drawId,
          mandate: { max_total_micro: 10_000, max_ask_micro: 10_000, expires_at_ms: Date.now() + 60_000 },
        }),
      }),
    });
    try {
      const refused = await submit(`${LEGACY_REPORT_DRAW_ID}:1`);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ error: "invalid_mandate", message: expect.stringContaining("draw ID") });
      expect(onJob).not.toHaveBeenCalled();
      expect(recordReplay).not.toHaveBeenCalled();

      // The digest is still a valid caller choice on the same historical credit.
      const corrected = await submit(AUTHORIZATION_ID);
      expect(corrected.status).toBe(200);
      expect(onJob).toHaveBeenCalledTimes(1);
      expect(recordReplay).toHaveBeenCalledTimes(1);
    } finally {
      await server.shutdown();
    }
  });

  it("keeps distinct caller-chosen draw and Cashu revenue keys in the report outbox", async () => {
    const queued: { kind: string; payload: Record<string, unknown> }[] = [];
    const query = async (sql: string, values: string[]) => {
      if (sql.includes("INSERT INTO pending_dvm_reports")) {
        queued.push({ kind: values[3], payload: JSON.parse(values[1]) });
      }
      return { rows: [], rowCount: 1 };
    };
    const db = { query } as unknown as RevenueReporterQuerier & ConstructorParameters<typeof RevenueReporter>[0];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const reporter = new RevenueReporter(db, "https://example.com", "test-token");
    for (const [i, id] of [LEGACY_ID, AUTHORIZATION_ID].entries()) {
      await reporter.enqueueCreditDrawRelease(db, {
        dvmId: DVM_ID,
        creditId: "named-credit",
        drawId: id,
        amountMicro: 10_000,
        creditCurrency: "usd",
        ledgerSeq: i + 1,
        releasedAt: 1_000,
      });
      await reporter.report({
        dvmId: DVM_ID,
        jobId: `cashu-job-${i}`,
        paidMsats: 10_000,
        rail: "cashu",
        paymentTxHash: id,
      });
    }

    expect(queued.filter(({ kind }) => kind === "release").map(({ payload }) => payload.drawId))
      .toEqual([LEGACY_ID, AUTHORIZATION_ID]);
    expect(queued.filter(({ kind }) => kind === "revenue").map(({ payload }) => payload.paymentTxHash))
      .toEqual([LEGACY_ID, AUTHORIZATION_ID]);
  });

  it("preserves two caller-chosen draws on the same x402 credit in revenue reports", async () => {
    const schema = z.object({
      input: z.string(), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(),
    });
    const signer = createSignedRequestVerifier(schema);
    const secret = new Uint8Array(32).fill(17);
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: LEGACY_ID,
      callerPubkey: signer.signRequest(secret, { input: "original" }).pubkey,
      currency: "usd",
      amountMicro: 2 * PRICE_FIAT.amountMicro,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "x402", paidMsats: 2 * REQUIRED_MSATS, nativeAsset: "usdc",
        nativeAmount: 2 * PRICE_FIAT.amountMicro, fundingRef: `0x${"56".repeat(32)}` },
    });
    const onJobCompleted = vi.fn();
    const server = await createDVMServer(configureDVM({
      name: "x402-explicit-draw",
      capabilities: { run: { input: schema, price: "$0.01", onJob: (ctx) => { ctx.complete("done"); } } },
      auth: secp256k1Auth(),
    }), {
      env: {}, devMode: true, store: new MemoryKVStore(), jobStore: new MemoryJobStore(),
      dvmId: DVM_ID, x402: X402, fxFetcher: warmFetcher(), creditLedger: ledger, onJobCompleted,
    });
    try {
      for (const [idx, drawId] of [LEGACY_ID, AUTHORIZATION_ID].entries()) {
        const response = await server.app.request("/v1/job", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            capability: "run",
            data: signer.signRequest(secret, { input: "original", credit_id: LEGACY_ID, draw_id: drawId }),
          }),
        });
        expect(response.status, await response.text()).toBe(200);
        await vi.waitFor(() => expect(onJobCompleted).toHaveBeenCalledTimes(idx + 1));
      }
      expect(onJobCompleted.mock.calls.map(([report]) => ({ creditId: report.creditId, drawId: report.drawId })))
        .toEqual([
          { creditId: LEGACY_ID, drawId: LEGACY_ID },
          { creditId: LEGACY_ID, drawId: AUTHORIZATION_ID },
        ]);
      expect((await ledger.get(LEGACY_ID))?.balanceMicro).toBe(0);
    } finally {
      await server.shutdown();
    }
  });
});
