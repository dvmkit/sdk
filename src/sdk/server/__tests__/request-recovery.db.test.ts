/**
 * Public request-id acceptance against real Postgres. The request route must
 * atomically reserve an id before either of two DVM machines can enter payment
 * verification; an in-memory precheck cannot prove that money invariant.
 */
import { createHash, randomBytes } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { stubbedTempoCharge } from "../../__tests__/__helpers__/mppx-stub";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { type ConsumedCredentialStore, MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { CreditLedger } from "../credit-ledger";
import type { JobRecord, RequestIdClaim } from "../job-store";
import { MintHealthTracker } from "../mint-health-tracker";
import { type MppxServer, wrapMppx } from "../mpp-setup";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { expectJobIdentity } from "./__helpers__/job-identity";
import { acceptAccumulatorPayment } from "../wallet-accumulator-receive";
import { initWalletAccumulatorTable } from "../wallet-accumulator-store";
import { PostgresX402ExactSettlementStore } from "../x402-exact-settlement-store";
import { type RecoveryIntent, resumeAcceptedRequest } from "./request-recovery-driver";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");
const mockAcceptCashu = vi.mocked(acceptAccumulatorPayment);
let currentIntent: RecoveryIntent | null = null;

async function requestResume(requestId: string): Promise<Record<string, unknown>> {
  if (!currentIntent || currentIntent.requestId !== requestId) {
    throw Object.assign(new Error("request not accepted"), { code: "request_not_accepted" });
  }
  return resumeAcceptedRequest(currentIntent, hex(PRIVKEY));
}

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const schema = z
  .object({
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[0-9a-f]{128}$/),
    timestamp: z.number().int(),
    nonce: z.string().min(8),
    action: z.string(),
  })
  .strict();
const signer = createSignedRequestVerifier(schema);
const PRIVKEY = new Uint8Array(32).fill(17);
const CALLER_PUBKEY = hex(schnorr.getPublicKey(PRIVKEY));
const PRICE_MSATS = 100_000;
const PRICE_MICRO = 100_000;
const TX_HASH = `0x${"ab".repeat(32)}`;
const DVM_ID = "request-recovery-db-test";
const AUTH_AUDIENCE = {
  dvm_id: DVM_ID,
  builder_pubkey: createHash("sha256").update(`dvmkit-dev:${DVM_ID}`).digest("hex"),
};
const CASHU_MINT = "https://mint.request-recovery.test";
const CASHU_LOCK_PUBKEY = `02${"ab".repeat(32)}`;
const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const TEMPO_TX_HASH = `0x${"76".repeat(32)}`;
const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
const X402_HEADER = encodePayment({
  x402Version: X402_V1_VERSION,
  scheme: "exact",
  network: X402.network,
  payload: {
    signature: `0x${"cd".repeat(32)}`,
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: X402.payTo,
      value: String(PRICE_MICRO),
      validAfter: "0",
      validBefore: "99999999999",
      nonce: `0x${"ef".repeat(32)}`,
    },
  },
});
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }),
  supportedCurrencies: () => ["usd"],
};

describe.skipIf(!RUN)("public request-id reservation (Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresJobStore;
  let storeB: PostgresJobStore;
  let ledgerA: CreditLedger;
  let ledgerB: CreditLedger;
  let paymentsA: PostgresProcessedPaymentStore;
  let paymentsB: PostgresProcessedPaymentStore;
  const shutdowns: Array<() => Promise<void>> = [];
  const servers = servedApps();

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new PostgresJobStore(poolA);
    storeB = new PostgresJobStore(poolB);
    ledgerA = new CreditLedger(poolA);
    ledgerB = new CreditLedger(poolB);
    paymentsA = new PostgresProcessedPaymentStore(poolA);
    paymentsB = new PostgresProcessedPaymentStore(poolB);
    const exactSettlements = new PostgresX402ExactSettlementStore(poolA);
    await Promise.all([
      storeA.init(),
      ledgerA.init(),
      paymentsA.init(),
      exactSettlements.init(),
      initWalletAccumulatorTable(poolA),
    ]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentIntent = null;
    mockAcceptCashu.mockResolvedValue({
      kind: "rejected",
      code: "invalid_token",
      message: "cashu not configured for this test",
    });
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: PRICE_MSATS,
      amountUsdcMicro: PRICE_MICRO,
      txHash: TX_HASH,
      settleResponseHeader: "settled",
    });
  });

  afterEach(async () => {
    await servers.closeAll();
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await poolA.query("DELETE FROM processed_payments");
    await poolA.query("DELETE FROM x402_exact_settlement_attempts WHERE dvm_id = $1", [DVM_ID]);
    await poolA.query("DELETE FROM x402_exact_job_auth_bindings WHERE dvm_id = $1", [DVM_ID]);
    await poolA.query("DELETE FROM x402_exact_settlement_intents WHERE dvm_id = $1", [DVM_ID]);
    await poolA.query("DELETE FROM wallet_accumulator");
    await poolA.query("DELETE FROM credit_draws");
    await poolA.query("DELETE FROM credit_fundings");
    await poolA.query("DELETE FROM credits");
    await poolA.query("DELETE FROM request_id_claims");
    await poolA.query("DELETE FROM job_messages");
    await poolA.query("DELETE FROM jobs");
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await Promise.all([poolA.end(), poolB.end()]);
  });

  it("allows exactly one concurrent POST to reach payment verification and the handler", async () => {
    const handled = { count: 0 };
    const firstMachine = await server(storeA, handled);
    const secondMachine = await server(storeB, handled);
    const requestId = "concurrent-paid-request";
    let entered!: () => void;
    let release!: () => void;
    const verifierEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const verifierGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(verifyX402Payment).mockImplementation(async () => {
      entered();
      await verifierGate;
      return {
        verified: true,
        amountMsats: PRICE_MSATS,
        amountUsdcMicro: PRICE_MICRO,
        txHash: TX_HASH,
        settleResponseHeader: "settled",
      };
    });

    const first = submit(firstMachine.app, requestBody(requestId), X402_HEADER);
    await verifierEntered;
    const second = await submit(secondMachine.app, requestBody(requestId), X402_HEADER);

    try {
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        error: "request_id_exists",
        request_id: requestId,
      });
      expect(verifyX402Payment).toHaveBeenCalledTimes(1);
      expect(handled.count).toBe(0);
    } finally {
      release();
    }
    const accepted = await first;
    expect(accepted.status).toBe(200);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);
    const jobs = await poolA.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM jobs WHERE requester_pubkey = $1 AND request_id = $2",
      [CALLER_PUBKEY, requestId]
    );
    expect(jobs.rows[0].count).toBe("1");
  });

  it("keeps a never-received submit inert, then reads the completed exact job without mutation", async () => {
    const handled = { count: 0 };
    const machine = await server(storeA, handled);
    const requestId = "initial-submit-never-received";
    const endpoint = await expose(machine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);

    await expect(requestResume(requestId)).rejects.toMatchObject({
      code: "request_not_accepted",
      data: expect.objectContaining({
        request_id: requestId,
        server_acceptance: "absent",
        payment_state: "unknown",
      }),
    });
    expect(await claimRow(poolA, requestId)).toBeUndefined();
    expect(verifyX402Payment).not.toHaveBeenCalled();
    expect(handled.count).toBe(0);
    expect((await poolA.query("SELECT 1 FROM credit_draws")).rowCount).toBe(0);
    expect((await poolA.query("SELECT 1 FROM jobs")).rowCount).toBe(0);

    const accepted = await submit(machine.app, requestBody(requestId), X402_HEADER);
    expect(accepted.status).toBe(200);
    const originalJobId = (await accepted.json()).job_id as string;
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);

    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: originalJobId, status: "completed" });
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM credit_draws")).rows[0].count
    ).toBe(1);
  });

  it("lets an unpaid discovery resume fail closed before the exact paid submit proceeds once", async () => {
    const handled = { count: 0 };
    const machine = await server(storeA, handled);
    const requestId = "unpaid-then-paid";

    const unpaid = await submit(machine.app, requestBody(requestId));
    expect(unpaid.status).toBe(402);
    expect(verifyX402Payment).not.toHaveBeenCalled();
    const boundJobId = (await claimRow(poolA, requestId))?.job_id;
    expect(boundJobId).toMatch(/^job-/);

    const endpoint = await expose(machine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    await expect(requestResume(requestId)).rejects.toMatchObject({
      code: "request_not_accepted",
    });
    expect(verifyX402Payment).not.toHaveBeenCalled();
    expect(handled.count).toBe(0);
    expect((await poolA.query("SELECT 1 FROM credit_draws")).rowCount).toBe(0);

    const paid = await submit(machine.app, requestBody(requestId), X402_HEADER);
    expect(paid.status).toBe(200);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);
    expect((await paid.json()).job_id).toBe(boundJobId);
    expect((await claimRow(poolA, requestId))?.job_id).toBe(boundJobId);
  });

  it("refuses resume without a committed acceptance even after the capability becomes free", async () => {
    const handled = { count: 0 };
    const paidMachine = await server(storeA, handled);
    const requestId = "unaccepted-before-price-drift";
    const body = requestBody(requestId);

    const unpaid = await submit(paidMachine.app, body);
    expect(unpaid.status).toBe(402);
    expect(await claimRow(poolA, requestId)).toBeDefined();
    expect((await poolA.query("SELECT 1 FROM credit_draws")).rowCount).toBe(0);

    const freeMachine = await freeServer(storeB, handled);
    const endpoint = await expose(freeMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    await expect(requestResume(requestId)).rejects.toMatchObject({
      code: "request_not_accepted",
    });
    expect(verifyX402Payment).not.toHaveBeenCalled();
    expect(handled.count).toBe(0);
    expect((await poolA.query("SELECT 1 FROM jobs")).rowCount).toBe(0);
    expect((await poolA.query("SELECT 1 FROM credit_draws")).rowCount).toBe(0);
  });

  it("keeps an active claim fail-closed, then lets the exact retry continue after release", async () => {
    const handled = { count: 0 };
    const machine = await server(storeA, handled);
    const requestId = "crashed-before-payment";
    const body = requestBody(requestId);
    const unpaid = await submit(machine.app, body);
    expect(unpaid.status).toBe(402);
    const row = await claimRow(poolA, requestId);
    if (!row) throw new Error("expected the unpaid request-id claim to persist");
    const crashedClaim: RequestIdClaim = {
      requestId,
      requesterPubkey: row.requester_pubkey,
      requesterId: row.requester_id,
      requestFingerprint: row.request_fingerprint,
      jobId: `ignored-${requestId}`,
      claimToken: "dead-process-token",
    };
    expect(await storeA.claimRequestId(crashedClaim)).toEqual({
      jobId: row.job_id,
      replayed: true,
    });

    const refused = await submit(machine.app, requestBody(requestId), X402_HEADER);
    expect(refused.status).toBe(409);
    expect(verifyX402Payment).not.toHaveBeenCalled();
    expect(handled.count).toBe(0);

    const recovered = await machine.app.request(
      `http://dvm.test/v1/request-result/${requestId}`,
      jsonPost(requestBody(requestId))
    );
    expect(recovered.status).toBe(404);
    expect(await recovered.json()).toMatchObject({
      error: "request_not_found",
      status: "unknown",
      request_id: requestId,
    });
    expect(
      (await poolA.query("SELECT 1 FROM jobs WHERE request_id = $1", [requestId])).rowCount
    ).toBe(0);

    await storeA.releaseRequestIdClaim(crashedClaim);
    const retried = await submit(machine.app, requestBody(requestId), X402_HEADER);
    expect(retried.status).toBe(200);
    expect((await retried.json()).job_id).toBe(row.job_id);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);
  });

  it("recovers the original job after x402 payment and draw commit but the first job save faults", async () => {
    const handled = { count: 0 };
    const failingStore = new FailFirstSaveJobStore(poolA);
    const firstMachine = await server(failingStore, handled);
    const requestId = "accepted-before-job-save";
    const remotelySettled = new Set<string>();
    let paymentMutations = 0;
    vi.mocked(verifyX402Payment).mockImplementation(async () => {
      if (!remotelySettled.has(TX_HASH)) {
        remotelySettled.add(TX_HASH);
        paymentMutations += 1;
      }
      return {
        verified: true,
        amountMsats: PRICE_MSATS,
        amountUsdcMicro: PRICE_MICRO,
        txHash: TX_HASH,
        settleResponseHeader: "settled",
      };
    });

    const lost = await submit(firstMachine.app, requestBody(requestId), X402_HEADER);
    expect(lost.status).toBe(500);
    expect(handled.count).toBe(0);
    expect(paymentMutations).toBe(1);
    const marker = await poolA.query<{
      job_id: string;
      credit_id: string;
      draw_id: string;
    }>(
      `SELECT job_id, credit_id, draw_id
         FROM processed_payments
        WHERE dvm_id = $1 AND rail = 'x402' AND payment_id = $2`,
      [DVM_ID, TX_HASH]
    );
    expect(marker.rows).toHaveLength(1);
    const originalJobId = marker.rows[0].job_id;
    expect(originalJobId).toBe((await claimRow(poolA, requestId))?.job_id);
    expect(
      (
        await poolA.query(
          "SELECT 1 FROM credit_draws WHERE credit_id = $1 AND draw_id = $2 AND job_id = $3",
          [marker.rows[0].credit_id, marker.rows[0].draw_id, originalJobId]
        )
      ).rowCount
    ).toBe(1);
    expect((await poolA.query("SELECT 1 FROM jobs WHERE id = $1", [originalJobId])).rowCount).toBe(
      0
    );

    const unknown = await firstMachine.app.request(
      `http://dvm.test/v1/request-result/${requestId}`,
      jsonPost(requestBody(requestId))
    );
    expect(unknown.status).toBe(404);

    const recoveryMachine = await server(storeB, handled);
    const endpoint = await expose(recoveryMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: originalJobId, status: "completed" });
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(paymentMutations).toBe(1);
    expect(handled.count).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM processed_payments")).rows[0].count
    ).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM credit_draws")).rows[0].count
    ).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);

    const lookup = await recoveryMachine.app.request(
      `http://dvm.test/v1/request-result/${requestId}`,
      jsonPost(requestBody(requestId))
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      request_id: requestId,
      job_id: originalJobId,
      status: "completed",
      transaction_hash: TX_HASH,
    });
  });

  it("admits a repaired exact-x402 job without requiring a public request id", async () => {
    const handled = { count: 0 };
    let authNow = 1_800_000_000;
    const failingStore = new FailFirstSaveJobStore(poolA);
    const descriptor = configureDVM({
      name: "exact-admission-recovery-db-test",
      capabilities: {
        run: {
          input: schema,
          price: "$0.10",
          onJob(ctx) {
            handled.count += 1;
            ctx.complete("done");
          },
        },
      },
      auth: secp256k1Auth({ now: () => authNow }),
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: failingStore,
      db: poolA,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: ledgerA,
      processedPayments: paymentsA,
      x402: X402,
    });
    shutdowns.push(instance.shutdown);
    const body = requestBodyWithoutId({ timestamp: authNow, nonce: "original-exact-envelope" });
    const facilitator = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/verify")) {
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }
      if (url.endsWith("/settle")) {
        return new Response(JSON.stringify({ success: true, transaction: TX_HASH }), {
          status: 200,
        });
      }
      throw new Error(`unexpected exact-recovery fetch ${url}`);
    });

    const lost = await submit(instance.app, body, X402_HEADER);
    expect(lost.status).toBe(500);
    expect(handled.count).toBe(0);
    const pending = await poolA.query<{
      intent_id: string;
      status: string;
      effect: { jobId: string };
    }>(
      `SELECT intent_id, status, effect
         FROM x402_exact_settlement_intents
        WHERE dvm_id = $1`,
      [DVM_ID]
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0].status).toBe("local_committed");

    authNow += 301;
    const stale = await submit(instance.app, body, X402_HEADER);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({
      error: "auth_error",
      sub_reason: "timestamp_drift",
    });
    const freshBody = requestBodyWithoutId({
      timestamp: authNow,
      nonce: "fresh-exact-envelope",
    });
    const recovered = await submit(instance.app, freshBody, X402_HEADER);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ job_id: pending.rows[0].effect.jobId });
    expect(handled.count).toBe(1);
    expect(
      facilitator.mock.calls.filter(([input]) => String(input).endsWith("/settle"))
    ).toHaveLength(1);
    expect(
      (
        await poolA.query("SELECT status FROM x402_exact_settlement_intents WHERE dvm_id = $1", [
          DVM_ID,
        ])
      ).rows[0].status
    ).toBe("complete");
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
  });

  it("replays an exact-x402 admission whose job landed before the response was lost, with its job identity", async () => {
    const authNow = 1_800_000_000;
    const store = new FailAfterFirstSaveJobStore(poolA);
    const descriptor = configureDVM({
      name: "exact-admission-replay-db-test",
      capabilities: {
        run: { input: schema, price: "$0.10", onJob(ctx) { ctx.complete("done"); } },
      },
      auth: secp256k1Auth({ now: () => authNow }),
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      db: poolA,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: ledgerA,
      processedPayments: paymentsA,
      x402: X402,
    });
    shutdowns.push(instance.shutdown);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/verify")) {
        return new Response(JSON.stringify({ isValid: true }), { status: 200 });
      }
      if (url.endsWith("/settle")) {
        return new Response(JSON.stringify({ success: true, transaction: TX_HASH }), { status: 200 });
      }
      throw new Error(`unexpected exact-replay fetch ${url}`);
    });

    const lost = await submit(
      instance.app,
      requestBodyWithoutId({ timestamp: authNow, nonce: "lost-exact-envelope" }),
      X402_HEADER
    );
    expect(lost.status).toBe(500);
    const intent = await poolA.query<{ status: string; effect: { jobId: string } }>(
      "SELECT status, effect FROM x402_exact_settlement_intents WHERE dvm_id = $1",
      [DVM_ID]
    );
    expect(intent.rows[0].status).toBe("local_committed");
    expect(await store.get(intent.rows[0].effect.jobId)).toBeDefined();

    const replayed = await submit(
      instance.app,
      requestBodyWithoutId({ timestamp: authNow, nonce: "retried-exact-envelope" }),
      X402_HEADER
    );
    const body = (await replayed.json()) as { job_id?: string };
    expect([200, 202]).toContain(replayed.status);
    expect(body.job_id).toBe(intent.rows[0].effect.jobId);
    expectJobIdentity(replayed, body);
  });

  it("recovers one prepaid draw after the first job save faults without drawing twice", async () => {
    const handled = { count: 0 };
    const failingStore = new FailFirstSaveJobStore(poolA);
    const firstMachine = await server(failingStore, handled);
    const requestId = "draw-accepted-before-job-save";
    const creditId = "credit-for-save-fault";
    const drawId = "draw-for-save-fault";
    await ledgerA.fund({
      creditId,
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: PRICE_MICRO,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "x402",
        paidMsats: PRICE_MSATS,
        nativeAmount: PRICE_MICRO,
        nativeAsset: "usdc",
        fundingRef: "seed-prepaid-draw",
      },
    });
    const body = () => requestBody(requestId, { credit_id: creditId, draw_id: drawId });

    const lost = await submit(firstMachine.app, body());
    expect(lost.status).toBe(500);
    expect(verifyX402Payment).not.toHaveBeenCalled();
    const originalJobId = (await claimRow(poolA, requestId))?.job_id;
    expect(originalJobId).toBeDefined();
    expect((await ledgerA.getDraw({ creditId, drawId }))?.jobId).toBe(originalJobId);

    const recoveryMachine = await server(storeB, handled);
    const endpoint = await expose(recoveryMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint, { credit_id: creditId, draw_id: drawId });
    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: originalJobId, status: "completed" });
    expect(verifyX402Payment).not.toHaveBeenCalled();
    expect(handled.count).toBe(1);
    expect(
      (
        await poolA.query(
          "SELECT COUNT(*)::int AS count FROM credit_draws WHERE credit_id = $1 AND draw_id = $2",
          [creditId, drawId]
        )
      ).rows[0].count
    ).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
  });

  it("recovers a Tempo charge with a failed replay mark on another server without charging again", async () => {
    const handled = { count: 0 };
    const broadcast = vi.fn(async () => ({
      method: "tempo", status: "success" as const,
      timestamp: new Date().toISOString(), reference: TEMPO_TX_HASH,
    }));
    const charge = stubbedTempoCharge(TEMPO_RECIPIENT, broadcast);
    const mpp = wrapMppx(Mppx.create({
      methods: [charge.method], secretKey: randomBytes(32).toString("hex"),
      realm: "request-recovery-tempo.test",
    }));
    const consumedCredentialStore = new MemoryConsumedCredentialStore();
    vi.spyOn(consumedCredentialStore, "mark").mockRejectedValue(new Error("replay store unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstMachine = await tempoServer(storeA, handled, mpp, consumedCredentialStore);
    const requestId = "tempo-replay-mark-failed";
    const body = requestBody(requestId);
    const challengeResponse = await submit(firstMachine.app, body);
    expect(challengeResponse.status).toBe(402);
    const challenge = Challenge.fromHeadersList(challengeResponse.headers)[0];
    const authorization = Credential.serialize(Credential.from({
      challenge, payload: { type: "hash" as const, hash: TEMPO_TX_HASH },
    }));

    const accepted = await submitTempo(firstMachine.app, body, authorization);
    expect([200, 202]).toContain(accepted.status);
    const original = await accepted.json() as { job_id: string };
    expect(original.job_id).toBeTruthy();
    expect(error.mock.calls.map(([line]) => JSON.parse(String(line)))).toContainEqual(
      expect.objectContaining({
        event: "tempo_replay_mark_failed", level: "error", transaction_hash: TEMPO_TX_HASH,
      })
    );

    const secondMachine = await tempoServer(storeB, handled, mpp);
    const retried = await submitTempo(secondMachine.app, body, authorization);
    expect(retried.status).toBe(409);
    expect(await retried.json()).toMatchObject({ error: "request_id_exists" });
    expect(broadcast).toHaveBeenCalledOnce();

    const endpoint = await expose(secondMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: original.job_id });
    expect(broadcast).toHaveBeenCalledOnce();
    expect(handled.count).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM processed_payments")).rows[0].count).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM credits")).rows[0].count).toBe(1);
    const accounting = await poolB.query<{
      credit_id: string; balance_micro: string; amount_micro: string; status: string;
    }>(
      `SELECT c.credit_id, c.balance_micro, d.amount_micro, d.status
         FROM credits c JOIN credit_draws d ON d.credit_id = c.credit_id
        WHERE d.job_id = $1`,
      [original.job_id]
    );
    expect(accounting.rows).toHaveLength(1);
    const recorded = accounting.rows[0];
    expect(recorded.credit_id).toBe(`imp:tempo:${challenge.id}`);
    expect(recorded.amount_micro).toBe(String(PRICE_MICRO));
    expect(["pending", "settled"]).toContain(recorded.status);
    // Completion may settle during recovery. One database snapshot must
    // account for the quote exactly, as either held balance or spent credit.
    expect(Number(recorded.balance_micro) +
      (recorded.status === "settled" ? Number(recorded.amount_micro) : 0)).toBe(PRICE_MICRO);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM credit_draws")).rows[0].count).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
  });

  it("recovers direct Tempo charge acceptance through request-resume without a second credential", async () => {
    const handled = { count: 0 };
    const failingStore = new FailFirstSaveJobStore(poolA);
    let chargeMutations = 0;
    const charge = stubbedTempoCharge(TEMPO_RECIPIENT, () => {
      chargeMutations += 1;
      return Promise.resolve({
        method: "tempo",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: TEMPO_TX_HASH,
      });
    });
    const mpp = wrapMppx(
      Mppx.create({
        methods: [charge.method],
        secretKey: randomBytes(32).toString("hex"),
        realm: "request-recovery-tempo.test",
      })
    );
    const firstMachine = await tempoServer(failingStore, handled, mpp);
    const requestId = "tempo-accepted-before-job-save";

    const challengeResponse = await submit(firstMachine.app, requestBody(requestId));
    expect(challengeResponse.status).toBe(402);
    const challenge = Challenge.fromHeadersList(challengeResponse.headers)[0];
    expect(challenge?.intent).toBe("charge");
    const credential = Credential.from({
      challenge,
      payload: { type: "hash" as const, hash: `0x${"71".repeat(32)}` },
    });

    // The exact charge is signed but its paid POST has not reached the server.
    // Public resume sends no credential and cannot turn this into fresh work;
    // the still-live original credential remains admissible exactly once.
    const preSubmitEndpoint = await expose(firstMachine.app.fetch);
    currentIntent = requestIntent(requestId, preSubmitEndpoint);
    await expect(requestResume(requestId)).rejects.toMatchObject({
      code: "request_not_accepted",
    });
    expect(chargeMutations).toBe(0);
    expect(handled.count).toBe(0);

    const lost = await submitTempo(
      firstMachine.app,
      requestBody(requestId),
      Credential.serialize(credential)
    );
    expect(lost.status).toBe(500);
    expect(chargeMutations).toBe(1);
    expect(handled.count).toBe(0);
    const marker = await paymentsA.get({
      dvmId: DVM_ID,
      rail: "tempo",
      paymentId: challenge.id,
    });
    const originalJobId = marker?.jobId;
    expect(originalJobId).toBe((await claimRow(poolA, requestId))?.job_id);
    if (!originalJobId) throw new Error("expected the Tempo acceptance marker to name a job");
    expect((await ledgerA.getDrawByJobId(originalJobId))?.railValue.rail).toBe("tempo");

    const recoveryMachine = await tempoServer(storeB, handled, mpp);
    const endpoint = await expose(recoveryMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: originalJobId, status: "completed" });
    expect(chargeMutations).toBe(1);
    expect(handled.count).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM processed_payments")).rows[0].count
    ).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM credit_draws")).rows[0].count
    ).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
  });

  it("recovers direct Cashu acceptance from its atomic accumulator draw without replaying proofs", async () => {
    const handled = { count: 0 };
    const failingStore = new FailFirstSaveJobStore(poolA);
    const firstMachine = await cashuServer(failingStore, handled);
    const requestId = "cashu-accepted-before-job-save";
    const cashuRequestId = "21950000-0000-4000-8000-000000000001";
    let accumulatorMutations = 0;
    mockAcceptCashu.mockImplementation(async (opts) => {
      const client = await poolA.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO wallet_accumulator (
             id, dvm_id, lock_pubkey, mint_url, proof_keyset_id, proof_secret,
             proof_secret_hash, proof_c, proof_amount, locked_to_pubkey,
             request_id, received_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$3,$10,$11)`,
          [
            "cashu-request-recovery-proof",
            DVM_ID,
            CASHU_LOCK_PUBKEY,
            CASHU_MINT,
            "keyset",
            "cashu-proof-secret-never-enters-request-claim",
            "99".repeat(32),
            "02" + "44".repeat(32),
            100,
            cashuRequestId,
            Date.now(),
          ]
        );
        await opts.withCommitTx?.(client, {
          paidMsats: PRICE_MSATS,
          grossMsats: PRICE_MSATS,
          inputFeeMsats: 0,
          netMsats: PRICE_MSATS,
          mintUrl: CASHU_MINT,
        });
        await client.query("COMMIT");
        accumulatorMutations += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      return {
        kind: "accumulated",
        paidMsats: PRICE_MSATS,
        grossMsats: PRICE_MSATS,
        inputFeeMsats: 0,
        netMsats: PRICE_MSATS,
        mintUrl: CASHU_MINT,
      };
    });

    // Cashu keeps the proof-bearing recovery evidence in its existing wallet
    // journal. Generic request-resume never presents those proofs itself and
    // therefore cannot create a fresh server binding before that path ships.
    const preSubmitEndpoint = await expose(firstMachine.app.fetch);
    currentIntent = requestIntent(requestId, preSubmitEndpoint);
    await expect(requestResume(requestId)).rejects.toMatchObject({
      code: "request_not_accepted",
    });
    expect(mockAcceptCashu).not.toHaveBeenCalled();
    expect(handled.count).toBe(0);

    const submittedBody = requestBody(requestId);
    const lost = await submitCashu(firstMachine.app, submittedBody, cashuRequestId);
    expect(lost.status).toBe(500);
    expect(accumulatorMutations).toBe(1);
    expect(mockAcceptCashu).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(0);
    const originalJobId = (await claimRow(poolA, requestId))?.job_id;
    if (!originalJobId) throw new Error("expected the Cashu acceptance claim to name a job");
    expect((await ledgerA.getDrawByJobId(originalJobId))?.railValue.rail).toBe("cashu");

    const recoveryMachine = await cashuServer(storeB, handled);
    const endpoint = await expose(recoveryMachine.app.fetch);
    currentIntent = requestIntent(requestId, endpoint);
    const resumed = await requestResume(requestId);
    expect(resumed).toMatchObject({ job_id: originalJobId, status: "completed" });
    expect(accumulatorMutations).toBe(1);
    expect(mockAcceptCashu).toHaveBeenCalledTimes(1);
    expect(handled.count).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM wallet_accumulator")).rows[0].count
    ).toBe(1);
    expect(
      (await poolA.query("SELECT COUNT(*)::int AS count FROM credit_draws")).rows[0].count
    ).toBe(1);
    expect((await poolA.query("SELECT COUNT(*)::int AS count FROM jobs")).rows[0].count).toBe(1);
    const persistedJob = await poolA.query<{
      received_proofs: unknown;
      request_fingerprint: string;
      requester_pubkey: string;
      request_id: string;
    }>(
      `SELECT received_proofs, request_fingerprint, requester_pubkey, request_id
         FROM jobs
        WHERE id = $1`,
      [originalJobId]
    );
    expect(persistedJob.rows[0]).toMatchObject({
      received_proofs: [],
      requester_pubkey: CALLER_PUBKEY,
      request_id: requestId,
    });
    const recoveryState = JSON.stringify({
      claim: await claimRow(poolA, requestId),
      job: persistedJob.rows[0],
    });
    expect(recoveryState).not.toContain("cashu-proof-secret-never-enters-request-claim");
    expect(recoveryState).not.toContain("cashuB-test-token-never-persisted");
    expect(recoveryState).not.toContain(String(submittedBody.data.signature));
  });

  async function server(store: PostgresJobStore, handled: { count: number }) {
    const descriptor = configureDVM({
      name: "request-recovery-db-test",
      capabilities: {
        run: {
          input: schema,
          price: "$0.10",
          onJob(ctx) {
            handled.count += 1;
            ctx.complete("done");
          },
        },
      },
      auth: secp256k1Auth(),
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: store === storeB ? ledgerB : ledgerA,
      processedPayments: store === storeB ? paymentsB : paymentsA,
      x402: X402,
    });
    shutdowns.push(instance.shutdown);
    return instance;
  }

  async function cashuServer(store: PostgresJobStore, handled: { count: number }) {
    const descriptor = configureDVM({
      name: "request-recovery-cashu-db-test",
      capabilities: {
        run: {
          input: schema,
          price: "$0.10",
          onJob(ctx) {
            handled.count += 1;
            ctx.complete("done");
          },
        },
      },
      auth: secp256k1Auth(),
    });
    const mintHealthTracker = new MintHealthTracker({
      mints: [CASHU_MINT],
      fetchImpl: () => Promise.resolve(new Response("{}", { status: 200 })),
    });
    await mintHealthTracker.runOnce();
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      db: store === storeB ? poolB : poolA,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: store === storeB ? ledgerB : ledgerA,
      processedPayments: store === storeB ? paymentsB : paymentsA,
      mints: [CASHU_MINT],
      cashuMode: "p2pk-accumulator",
      lockPubkey: CASHU_LOCK_PUBKEY,
      mintHealthTracker,
    });
    shutdowns.push(instance.shutdown);
    return instance;
  }

  async function tempoServer(
    store: PostgresJobStore, handled: { count: number }, mpp: MppxServer,
    consumedCredentialStore?: ConsumedCredentialStore
  ) {
    const descriptor = configureDVM({
      name: "request-recovery-tempo-db-test",
      capabilities: {
        run: {
          input: schema,
          price: "$0.10",
          onJob(ctx) {
            handled.count += 1;
            ctx.complete("tempo-done");
          },
        },
      },
      auth: secp256k1Auth(),
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: store === storeB ? ledgerB : ledgerA,
      processedPayments: store === storeB ? paymentsB : paymentsA,
      mpp,
      consumedCredentialStore,
    });
    shutdowns.push(instance.shutdown);
    return instance;
  }

  async function freeServer(store: PostgresJobStore, handled: { count: number }) {
    const descriptor = configureDVM({
      name: "request-recovery-free-db-test",
      capabilities: {
        run: {
          input: schema,
          onJob(ctx) {
            handled.count += 1;
            ctx.complete("free-done");
          },
        },
      },
      auth: secp256k1Auth(),
    });
    const instance = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: store,
      dvmId: DVM_ID,
      fxFetcher: stubFx,
      creditLedger: store === storeB ? ledgerB : ledgerA,
      processedPayments: store === storeB ? paymentsB : paymentsA,
      x402: X402,
    });
    shutdowns.push(instance.shutdown);
    return instance;
  }

  async function expose(
    fetch: (request: Request) => Response | Promise<Response>
  ): Promise<string> {
    return servers.serve({ fetch: fetch as never });
  }
});

/** Persists the first job, then loses the response as a crash after the write would. */
class FailAfterFirstSaveJobStore extends PostgresJobStore {
  private failNextSave = true;

  override async save(record: JobRecord): Promise<void> {
    await super.save(record);
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("injected fault after the job row landed");
    }
  }
}

class FailFirstSaveJobStore extends PostgresJobStore {
  private failNextSave = true;

  override save(record: JobRecord): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      return Promise.reject(new Error("injected fault after paid acceptance before job save"));
    }
    return super.save(record);
  }
}

function requestBody(
  requestId: string,
  extra: Record<string, unknown> = {}
): { capability: string; input: string; data: Record<string, unknown> } {
  return {
    capability: "run",
    input: "",
    data: signer.signRequest(PRIVKEY, {
      action: "go",
      request_id: requestId,
      ...extra,
    }) as unknown as Record<string, unknown>,
  };
}

function requestBodyWithoutId(opts?: { timestamp?: number; nonce?: string }): {
  capability: string;
  input: string;
  data: Record<string, unknown>;
} {
  return {
    capability: "run",
    input: "",
    data: signer.signRequest(PRIVKEY, { action: "go" }, opts) as unknown as Record<string, unknown>,
  };
}

function requestIntent(
  requestId: string,
  endpoint: string,
  extra: Record<string, unknown> = {}
): RecoveryIntent {
  return {
    requestId,
    endpoint,
    authAudience: AUTH_AUDIENCE,
    capability: "run",
    body: {
      capability: "run",
      input: "",
      data: { action: "go", request_id: requestId, ...extra },
    },
    callerPubkey: CALLER_PUBKEY,
    policy: {
      maxTotalMsats: PRICE_MSATS,
      autoPayBelowMsats: PRICE_MSATS,
      maxIncrementMsats: PRICE_MSATS,
      maxPayments: 1,
    },
    createdAt: Date.now(),
  };
}

interface TestApp {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

function submit(app: TestApp, body: unknown, payment?: string): Promise<Response> {
  return Promise.resolve(app.request("http://dvm.test/v1/job", jsonPost(body, payment)));
}

function submitCashu(app: TestApp, body: unknown, cashuRequestId: string): Promise<Response> {
  return Promise.resolve(
    app.request("http://dvm.test/v1/job", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cashu": "cashuB-test-token-never-persisted",
        "X-Cashu-Request-Id": cashuRequestId,
      },
      body: JSON.stringify(body),
    })
  );
}

function submitTempo(app: TestApp, body: unknown, authorization: string): Promise<Response> {
  return Promise.resolve(
    app.request("http://dvm.test/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authorization },
      body: JSON.stringify(body),
    })
  );
}

function jsonPost(body: unknown, payment?: string): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(payment ? { "X-PAYMENT": payment } : {}) },
    body: JSON.stringify(body),
  };
}

interface RequestClaimRow {
  requester_pubkey: string;
  requester_id: string;
  request_fingerprint: string;
  job_id: string;
}

async function claimRow(pool: pg.Pool, requestId: string): Promise<RequestClaimRow | undefined> {
  const { rows } = await pool.query<RequestClaimRow>(
    `SELECT requester_pubkey, requester_id, request_fingerprint, job_id
       FROM request_id_claims
      WHERE request_id = $1`,
    [requestId]
  );
  return rows[0];
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
