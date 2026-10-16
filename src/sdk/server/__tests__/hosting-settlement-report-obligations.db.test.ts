import { randomUUID } from "node:crypto";

import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import pg from "pg";
import { Session as TempoSession } from "mppx/tempo";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, parseAbiItem } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

const chainClient = vi.hoisted(() => ({
  getChainId: vi.fn(), getBlock: vi.fn(), getTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(), readContract: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: vi.fn(() => chainClient),
}));

import { writeOffHostedTempoCloseReport } from "../index";
import { loggers } from "../../../observability/loggers";
import { HostingControl } from "../hosting-control";
import { HostedChannelEvidenceReader } from "../hosting-channel-evidence";
import { CreditLedger } from "../credit-ledger";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { PayoutReporter, PostgresX402BatchStore } from "../payout-reporter";
import { RevenueReporter } from "../revenue-reporter";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import { PostgresTempoChargeStore } from "../tempo-charge-store";
import { PostgresX402ChannelStorage } from "../x402-channel-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const NETWORK = "eip155:84532";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const CONFIG = {
  payer: "0x1111111111111111111111111111111111111111",
  payerAuthorizer: "0x1111111111111111111111111111111111111111",
  receiver: RECEIVER,
  receiverAuthorizer: RECEIVER,
  token: TOKEN,
  withdrawDelay: 86_400,
  salt: `0x${"44".repeat(32)}`,
} as const;
const CHANNEL = computeChannelId(CONFIG, NETWORK);
const SIGNATURE = `0x${"55".repeat(65)}`;
const REFUND_SIGNATURE = `0x${"66".repeat(65)}`;
const TX = `0x${"ab".repeat(32)}`;
const BLOCK = `0x${"bb".repeat(32)}`;
const CLAIM_AUTHORIZER = `0x${"88".repeat(65)}`;
const REFUND_AUTHORIZER = `0x${"77".repeat(65)}`;
const AUTH_REQUIREMENTS = { scheme: "batch-settlement", network: NETWORK,
  asset: TOKEN, payTo: RECEIVER, amount: "0" };

function claimAuthorization(config: Parameters<typeof computeChannelId>[0] = CONFIG) {
  return { type: "claim", claims: [{ voucher: { channel: config, maxClaimableAmount: "100" },
    signature: SIGNATURE, totalClaimed: "100" }],
    claimAuthorizerSignature: CLAIM_AUTHORIZER };
}

function refundAuthorization(config: Parameters<typeof computeChannelId>[0] = CONFIG) {
  return { type: "refund", channelConfig: config, amount: "240", refundNonce: "0",
    claims: [{ voucher: { channel: config, maxClaimableAmount: "60" },
      signature: REFUND_SIGNATURE, totalClaimed: "60" }],
    claimAuthorizerSignature: CLAIM_AUTHORIZER,
    refundAuthorizerSignature: REFUND_AUTHORIZER };
}
const CLAIM_ABI = [{ type: "function", name: "claimWithSignature", stateMutability: "nonpayable",
  inputs: [{ name: "voucherClaims", type: "tuple[]", components: [
    { name: "voucher", type: "tuple", components: [
      { name: "channel", type: "tuple", components: [
        { name: "payer", type: "address" }, { name: "payerAuthorizer", type: "address" },
        { name: "receiver", type: "address" }, { name: "receiverAuthorizer", type: "address" },
        { name: "token", type: "address" }, { name: "withdrawDelay", type: "uint40" },
        { name: "salt", type: "bytes32" },
      ] }, { name: "maxClaimableAmount", type: "uint128" },
    ] }, { name: "signature", type: "bytes" }, { name: "totalClaimed", type: "uint128" },
  ] }, { name: "authorizerSignature", type: "bytes" }], outputs: [],
}] as const;
const REFUND_ABI = [{ type: "function", name: "refundWithSignature", stateMutability: "nonpayable",
  inputs: [{ name: "config", type: "tuple", components: CLAIM_ABI[0].inputs[0].components[0].components[0].components },
    { name: "amount", type: "uint128" }, { name: "nonce", type: "uint256" },
    { name: "receiverAuthorizerSignature", type: "bytes" }], outputs: [],
}] as const;
const MULTICALL_ABI = [{ type: "function", name: "multicall", stateMutability: "nonpayable",
  inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }],
}] as const;

interface Fixture {
  pool: pg.Pool;
  dvmId: string;
  scope: string;
  control: HostingControl;
  obligations: HostedSettlementReportObligations;
  channelStore: PostgresX402ChannelStorage;
  cleanup(): Promise<void>;
}

async function bookmarkRefund(pool: pg.Pool,
  config: Parameters<typeof computeChannelId>[0] = CONFIG,
  channelId = computeChannelId(config, NETWORK), claimedBefore = "0", noClaim = false): Promise<void> {
  const snapshot = { channelId, channelConfig: config,
    chargedCumulativeAmount: noClaim ? "0" : "60", signedMaxClaimable: noClaim ? "0" : "60",
    signature: noClaim ? "0x" : REFUND_SIGNATURE,
    balance: "300", totalClaimed: claimedBefore, refundNonce: 0 };
  await pool.query(
    `INSERT INTO x402_batch_settlements
      (settlement_id,channel_id,operation,effect_id,payment_id,payment_payload,
       payment_requirements,channel_before,status,submission_block,channel_at_submission)
     VALUES ($1,$2,'refund',$3,$4,$5,$6,$7,'submitting',100,$8)`,
    [randomUUID(), channelId, `credit:drain:${channelId}`, `signed-refund:${channelId}`, JSON.stringify({
      x402Version: 2, payload: { type: "refund", channelConfig: config,
        voucher: { channelId, signature: snapshot.signature, maxClaimableAmount: snapshot.signedMaxClaimable } },
    }), JSON.stringify({ scheme: "batch-settlement", network: NETWORK,
      payTo: RECEIVER, asset: TOKEN, amount: "0" }), JSON.stringify(snapshot),
    JSON.stringify(snapshot)]
  );
}

async function fixture(preexistingChannelTable = false, certificateReady = false): Promise<Fixture> {
  const schema = `hosted_effect_${randomUUID().slice(0, 8)}`;
  const admin = new pg.Pool({ connectionString: DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
  const channelStore = new PostgresX402ChannelStorage(pool,
    certificateReady ? { hostedNetwork: NETWORK } : undefined);
  try {
    if (preexistingChannelTable) await channelStore.init();
    const dvmId = `effect-${randomUUID()}`;
    const scope = `deployment-${randomUUID()}`;
    const channelReader = certificateReady
      ? await HostedChannelEvidenceReader.fromServerConfig(pool, { x402: { network: NETWORK } })
      : undefined;
    const control = new HostingControl(pool, dvmId,
      { secret: "test-only-hosting-effect-secret-32-bytes", scope }, channelReader);
    await control.init();
    const obligations = new HostedSettlementReportObligations(pool, dvmId, scope);
    obligations.configureX402({ network: NETWORK, receiver: RECEIVER, token: TOKEN });
    await obligations.init();
    if (certificateReady) {
      await new PostgresJobStore(pool).init();
      await new CreditLedger(pool).init();
      await new PostgresProcessedPaymentStore(pool).init();
      await new RevenueReporter(pool, "https://example.com", "test-token").init();
      await new PostgresTempoChargeStore(pool, { gcSampleRate: 0 }).init();
      await new PostgresTempoSessionStore(pool).init();
    }
    if (!preexistingChannelTable) await channelStore.init();
    obligations.attachX402SettlementStore(channelStore);
    await new PostgresX402BatchStore(pool).init();
    expect(await control.transition({ action: "resume", version: 2, dvmId, scope,
      generation: 1, leaseExpiresAtMs: Date.now() + 60_000,
      deadlineMs: Date.now() + 90_000, timestampMs: Date.now(),
      nonce: `nonce_${randomUUID().replaceAll("-", "")}` })).toBe("ok");
    await channelStore.updateChannel(CHANNEL, () => ({
      channelId: CHANNEL, channelConfig: CONFIG,
      chargedCumulativeAmount: certificateReady ? "0" : "100",
      signedMaxClaimable: certificateReady ? "0" : "100",
      signature: certificateReady ? "0x" : SIGNATURE,
      balance: "300", totalClaimed: "0",
      withdrawRequestedAt: 0, refundNonce: 0, onchainSyncedAt: Date.now(),
      lastRequestTimestamp: Date.now(),
    }));
    return { pool, dvmId, scope, control, obligations, channelStore, cleanup: async () => {
      await channelStore.close();
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    } };
  } catch (error) {
    await channelStore.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
    throw error;
  }
}

(RUN ? describe : describe.skip)("hosted settlement-report obligations (Postgres)", () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    for (const current of fixtures.splice(0)) await current.cleanup();
  });

  it("reserves one exact original voucher before an effect and refuses changed or replayed submissions", async () => {
    const current = await fixture(); fixtures.push(current);
    expect(await current.obligations.hasCompleteHistory()).toBe(true);
    const first = await current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    });
    expect(first).toMatchObject({ replayed: false });
    expect(await current.obligations.unresolvedCount()).toBe(1);
    await expect(current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "101", signature: SIGNATURE, signedMax: "100",
    })).rejects.toThrow("claim changed");
    await expect(current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: `0x${"66".repeat(65)}`, signedMax: "100",
    })).rejects.toThrow("claim changed");
    expect(await current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    })).toEqual({ id: first?.id, replayed: true });
    await expect(current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: { ...claimAuthorization(),
        claimAuthorizerSignature: `0x${"99".repeat(65)}` },
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    })).rejects.toThrow("replay conflicts");
    await expect(current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: { ...AUTH_REQUIREMENTS, network: "eip155:1" },
      charged: "100", signature: SIGNATURE, signedMax: "100",
    })).rejects.toThrow("another selected rail or recipient");
    await current.obligations.recordSubmitted(first!.id, TX);
    await expect(current.obligations.recordSubmitted(first!.id, `0x${"cd".repeat(32)}`))
      .rejects.toThrow("replay conflicts");
    expect(await current.obligations.unresolvedCount()).toBe(1);
    await current.pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations
       SET original=original-'authorizationCallData',state='delivered' WHERE id=$1`, [first!.id]
    );
    expect(await current.obligations.unresolvedCount()).toBe(1);
    await expect(current.obligations.observeCanonical(first!.id))
      .rejects.toThrow("original signed authorization is unknown");
  });

  it("refuses a public terminal certificate when a discharged row loses its original signed call", async () => {
    const current = await fixture(false, true); fixtures.push(current);
    await bookmarkRefund(current.pool, CONFIG, CHANNEL, "0", true);
    const reserved = await current.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: { type: "refund", channelConfig: CONFIG, amount: "300",
        refundNonce: "0", claims: [], refundAuthorizerSignature: REFUND_AUTHORIZER },
      authorizationRequirements: AUTH_REQUIREMENTS,
      refundNonce: "0", refundAmount: "300", voucherSignature: "0x",
      signedMax: "0",
    });
    await current.obligations.recordSubmitted(reserved!.id, TX);
    chainClient.getChainId.mockResolvedValue(84532);
    chainClient.getBlock.mockImplementation(async (args: { blockTag?: string; blockNumber?: bigint }) =>
      args.blockTag === "finalized" || args.blockNumber === 11n
        ? { number: 11n, hash: `0x${"cc".repeat(32)}` }
        : { number: 10n, hash: BLOCK });
    chainClient.readContract.mockImplementation(async (args: { functionName: string }) =>
      args.functionName === "channels" ? [0n, 0n] :
        args.functionName === "pendingWithdrawals" ? [0n, 0] : 1n);
    chainClient.getTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: TX,
      logs: [{ address: BATCH_SETTLEMENT_ADDRESS,
        topics: encodeEventTopics({ abi: [parseAbiItem(
          "event Refunded(bytes32 indexed channelId,address indexed sender,uint128 amount)"
        )], eventName: "Refunded", args: { channelId: CHANNEL, sender: CONFIG.payer } }),
        data: encodeAbiParameters([{ type: "uint128" }], [300n]) }],
    });
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: encodeFunctionData({ abi: REFUND_ABI, functionName: "refundWithSignature",
        args: [CONFIG, 300n, 0n, REFUND_AUTHORIZER as `0x${string}`] }) });
    expect(await current.obligations.observeCanonical(reserved!.id))
      .toMatchObject({ blockHash: BLOCK, deltaNative: "0" });
    await current.pool.query(
      "UPDATE x402_batch_settlements SET status='complete' WHERE channel_id=$1 AND operation='refund'",
      [CHANNEL]
    );
    await current.channelStore.updateChannel(CHANNEL, () => undefined);
    const support = { singleMount: true, durableLedger: true, durableJobStore: true,
      durableReporter: true, durablePaymentReplay: true, knownRailStores: true };
    const command = { version: 3 as const, action: "close" as const,
      dvmId: current.dvmId, scope: current.scope, generation: 2,
      operationId: `operation_${randomUUID().replaceAll("-", "")}`,
      timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}` };
    expect(await current.control.close(command, support)).toBe("ok");
    const certificate = () => current.control.certificate(
      { ...command, action: "certificate" }, support
    );
    expect(await certificate()).toMatchObject({ complete: true, eligible: true,
      dvmId: current.dvmId, scope: current.scope, operationId: command.operationId });
    const original = (await current.pool.query<{ original: Record<string, unknown> }>(
      "SELECT original FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved!.id]
    )).rows[0].original;
    for (const state of ["no_report", "delivered"] as const) {
      await current.pool.query(
        "UPDATE sdk_hosted_settlement_report_obligations SET state=$2,original=original-'authorizationCallData' WHERE id=$1",
        [reserved!.id, state]
      );
      expect(await certificate()).toMatchObject({ complete: false, eligible: false,
        reasons: expect.arrayContaining(["settlement_reports_unresolved"]) });
    }
    await current.pool.query(
      "UPDATE sdk_hosted_settlement_report_obligations SET state='no_report',original=$2 WHERE id=$1",
      [reserved!.id, JSON.stringify(original)]
    );
    expect(await certificate()).toMatchObject({ complete: true, eligible: true });
  });

  it("does not deliver or acknowledge a report from submitted hashes without canonical proof", async () => {
    const current = await fixture(); fixtures.push(current);
    const reserved = await current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    });
    await current.obligations.recordSubmitted(reserved!.id, TX);
    const batchId = (await current.pool.query<{ original: { batchId: string } }>(
      "SELECT original FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved!.id]
    )).rows[0].original.batchId;
    const payoutId = `x402:batch:${batchId}`;
    await new PostgresX402BatchStore(current.pool).put({
      scope: `${NETWORK}|${RECEIVER}|${TOKEN.toLowerCase()}`, batchId,
      claimedNative: 100n, voucherCount: 1, claims: 1, openedAt: Date.now(),
      attempts: 0, firstFailedAt: null, lastError: null, nextRetryAt: null,
      obligationIds: [reserved!.id],
    });
    const settle = await current.obligations.reserveOpenX402Settlement();
    await current.obligations.recordSubmitted(settle.id, `0x${"cd".repeat(32)}`);
    const sourceIds = [reserved!.id, settle.id];
    const payload = { dvmId: current.dvmId, payoutId, rail: "x402" as const,
      kind: "batch" as const, nativeAmount: 100, nativeAsset: "usdc" as const,
      recipient: RECEIVER, refs: { batchId }, landedAt: 1_000 };
    const client = await current.pool.connect();
    try {
      await client.query("BEGIN");
      await current.obligations.queueReport(sourceIds, payoutId, randomUUID(), payload, client);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect((await current.pool.query<{ report_id: string | null }>(
      "SELECT report_id FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved!.id]
    )).rows[0].report_id).toBeNull();
    const reporter = new RevenueReporter(current.pool, "https://platform.invalid", "local-token",
      current.obligations);
    await reporter.init();
    await reporter.enqueueHostedPayout(payload, sourceIds);
    const reportId = (await current.pool.query<{ id: string }>(
      "SELECT id FROM pending_dvm_reports WHERE kind='payout'"
    )).rows[0].id;
    const fetchAttempt = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchAttempt);
    try {
      await reporter.drainPending();
      expect(fetchAttempt).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
    const ack = await current.pool.connect();
    try {
      await ack.query("BEGIN");
      await expect(current.obligations.acknowledgeDelivered(reportId, ack))
        .rejects.toThrow("finalized exact original effect");
      await ack.query("ROLLBACK");
    } finally { ack.release(); }
    expect((await current.pool.query<{ state: string }>(
      "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved!.id]
    )).rows[0].state).toBe("report_queued");
    expect(await current.obligations.unresolvedCount()).toBe(2);
  });

  it("keeps the report and acknowledgement atomic across a failed outbox delete and exact replay", async () => {
    const current = await fixture(); fixtures.push(current);
    const claim = await current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    });
    await current.obligations.recordSubmitted(claim!.id, TX);
    const batchId = (await current.pool.query<{ original: { batchId: string } }>(
      "SELECT original FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [claim!.id]
    )).rows[0].original.batchId;
    const payoutId = `x402:batch:${batchId}`;
    await new PostgresX402BatchStore(current.pool).put({
      scope: `${NETWORK}|${RECEIVER}|${TOKEN.toLowerCase()}`, batchId,
      claimedNative: 100n, voucherCount: 1, claims: 1, openedAt: Date.now(),
      attempts: 0, firstFailedAt: null, lastError: null, nextRetryAt: null,
      obligationIds: [claim!.id],
    });
    const settle = await current.obligations.reserveOpenX402Settlement();
    await current.obligations.recordSubmitted(settle.id, `0x${"cd".repeat(32)}`);
    const reporter = new RevenueReporter(current.pool, "https://platform.invalid", "local-token",
      current.obligations);
    await reporter.init();
    const payload = { dvmId: current.dvmId, payoutId, rail: "x402" as const,
      kind: "batch" as const, nativeAmount: 100, nativeAsset: "usdc" as const,
      recipient: RECEIVER, refs: { batchId }, landedAt: 1_000 };
    await reporter.enqueueHostedPayout(payload, [claim!.id, settle.id]);
    await reporter.enqueueHostedPayout({ ...payload, landedAt: 2_000 }, [claim!.id, settle.id]);
    await expect(reporter.enqueueHostedPayout({ ...payload, refs: { batchId: "another" } },
      [claim!.id, settle.id])).rejects.toThrow("replay conflicts");
    expect((await current.pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM pending_dvm_reports"
    )).rows[0].n).toBe("1");
    await current.pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations
       SET block_hash=$1,block_number=10,delta_native=100,state='observed'
       WHERE id=ANY($2::text[])`, [BLOCK, [claim!.id, settle.id]]
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    try {
      await current.pool.query(`CREATE FUNCTION refuse_outbox_delete() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'outbox delete unavailable'; END; $$ LANGUAGE plpgsql`);
      await current.pool.query(`CREATE TRIGGER refuse_outbox_delete BEFORE DELETE ON pending_dvm_reports
        FOR EACH ROW EXECUTE FUNCTION refuse_outbox_delete()`);
      await reporter.drainPending();
      expect((await current.pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pending_dvm_reports"
      )).rows[0].n).toBe("1");
      expect((await current.pool.query<{ delivered_at_ms: string | null }>(
        "SELECT delivered_at_ms FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [claim!.id]
      )).rows[0].delivered_at_ms).toBeNull();
      await current.pool.query("DROP TRIGGER refuse_outbox_delete ON pending_dvm_reports");
      await current.pool.query("UPDATE pending_dvm_reports SET next_retry_at=0");
      await reporter.drainPending();
      expect((await current.pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pending_dvm_reports"
      )).rows[0].n).toBe("0");
      expect((await current.pool.query<{ state: string; delivered_at_ms: string | null }>(
        "SELECT state,delivered_at_ms FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [claim!.id]
      )).rows[0]).toMatchObject({ state: "delivered",
        delivered_at_ms: expect.any(String) });
      expect(await current.obligations.unresolvedCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps pre-instrumentation channel history unknown even when the table has no rows", async () => {
    const current = await fixture(true); fixtures.push(current);
    expect(await current.obligations.hasCompleteHistory()).toBe(false);
    expect(await current.obligations.unresolvedCount()).toBe(0);
  });

  it("refuses a finalized claim with an extra voucher absent from the original reservations", async () => {
    const current = await fixture(); fixtures.push(current);
    const reserved = await current.obligations.reserveX402(CHANNEL, "claim", {
      authorizationPayload: claimAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      charged: "100", signature: SIGNATURE, signedMax: "100",
    });
    await current.obligations.recordSubmitted(reserved!.id, TX);
    chainClient.getChainId.mockResolvedValue(84532);
    chainClient.getBlock.mockImplementation(async (args: { blockTag?: string }) =>
      args.blockTag === "finalized" ? { number: 11n, hash: `0x${"cc".repeat(32)}` } :
        { number: 10n, hash: BLOCK });
    chainClient.getTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: TX, logs: [],
    });
    chainClient.readContract.mockResolvedValue([300n, 100n]);
    const claim = (extra: boolean, authorizer = CLAIM_AUTHORIZER) => encodeFunctionData({
      abi: CLAIM_ABI, functionName: "claimWithSignature",
      args: [[{ voucher: { channel: CONFIG, maxClaimableAmount: 100n },
        signature: SIGNATURE as `0x${string}`, totalClaimed: 100n },
      ...(extra ? [{ voucher: { channel: CONFIG, maxClaimableAmount: 101n },
        signature: REFUND_SIGNATURE as `0x${string}`, totalClaimed: 101n }] : [])],
      authorizer as `0x${string}`],
    });
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: claim(false, `0x${"99".repeat(65)}`) });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS, input: claim(true) });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: `${claim(false)}00` });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS, input: claim(false) });
    chainClient.readContract.mockResolvedValue([300n, 100n]);
    await expect(current.obligations.observeCanonical(reserved!.id))
      .resolves.toMatchObject({ deltaNative: "100", blockHash: BLOCK });
  });

  it("requires the finalized bundled refund claim to consume the exact reserved voucher", async () => {
    const current = await fixture(); fixtures.push(current);
    await bookmarkRefund(current.pool);
    const reserved = await current.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: refundAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      refundNonce: "0", refundAmount: "240", voucherSignature: REFUND_SIGNATURE,
      signedMax: "60",
    });
    await expect(current.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: { ...refundAuthorization(),
        refundAuthorizerSignature: `0x${"99".repeat(65)}` },
      authorizationRequirements: AUTH_REQUIREMENTS,
      refundNonce: "0", refundAmount: "240", voucherSignature: REFUND_SIGNATURE,
      signedMax: "60",
    })).rejects.toThrow("replay conflicts");
    await current.obligations.recordSubmitted(reserved!.id, TX);
    const refund = (authorizer = REFUND_AUTHORIZER) => encodeFunctionData({ abi: REFUND_ABI,
      functionName: "refundWithSignature",
      args: [CONFIG, 240n, 0n, authorizer as `0x${string}`] });
    const event = parseAbiItem(
      "event Refunded(bytes32 indexed channelId,address indexed sender,uint128 amount)"
    );
    chainClient.getChainId.mockResolvedValue(84532);
    chainClient.getBlock.mockImplementation(async (args: { blockTag?: string }) =>
      args.blockTag === "finalized" ? { number: 11n, hash: `0x${"cc".repeat(32)}` } :
        { number: 10n, hash: BLOCK });
    chainClient.getTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: TX,
      logs: [{ address: BATCH_SETTLEMENT_ADDRESS,
        topics: encodeEventTopics({ abi: [event], eventName: "Refunded",
          args: { channelId: CHANNEL, sender: CONFIG.payer } }),
        data: encodeAbiParameters([{ type: "uint128" }], [240n]) }],
    });
    const bundled = (signature: string, extraClaim = false,
      claimAuthorizer = CLAIM_AUTHORIZER, refundAuthorizer = REFUND_AUTHORIZER) => encodeFunctionData({
      abi: MULTICALL_ABI, functionName: "multicall", args: [[
        encodeFunctionData({ abi: CLAIM_ABI, functionName: "claimWithSignature",
          args: [[{ voucher: { channel: CONFIG, maxClaimableAmount: 60n },
            signature: signature as `0x${string}`, totalClaimed: 60n },
          ...(extraClaim ? [{ voucher: { channel: CONFIG, maxClaimableAmount: 61n },
            signature: SIGNATURE as `0x${string}`, totalClaimed: 61n }] : [])],
          claimAuthorizer as `0x${string}`] }), refund(refundAuthorizer),
      ]],
    });
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: bundled(REFUND_SIGNATURE, false, `0x${"99".repeat(65)}`) });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: bundled(REFUND_SIGNATURE, false, CLAIM_AUTHORIZER, `0x${"99".repeat(65)}`) });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({
      to: BATCH_SETTLEMENT_ADDRESS, input: bundled(SIGNATURE),
    });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    expect(await current.obligations.unresolvedCount()).toBe(1);
    chainClient.getTransaction.mockResolvedValue({
      to: BATCH_SETTLEMENT_ADDRESS, input: bundled(REFUND_SIGNATURE, true),
    });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    expect(await current.obligations.unresolvedCount()).toBe(1);
    chainClient.getTransaction.mockResolvedValue({ to: BATCH_SETTLEMENT_ADDRESS,
      input: `${bundled(REFUND_SIGNATURE)}00` });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .rejects.toThrow("pre-effect signed authorization");
    chainClient.getTransaction.mockResolvedValue({
      to: BATCH_SETTLEMENT_ADDRESS, input: bundled(REFUND_SIGNATURE),
    });
    await expect(current.obligations.observeCanonical(reserved!.id))
      .resolves.toMatchObject({ deltaNative: "60", blockHash: BLOCK });
    expect(await current.obligations.unresolvedCount()).toBe(1);

    const fullyClaimed = await fixture(); fixtures.push(fullyClaimed);
    await bookmarkRefund(fullyClaimed.pool, CONFIG, CHANNEL, "60");
    const zeroDelta = await fullyClaimed.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: refundAuthorization(), refundNonce: "0", refundAmount: "240",
      authorizationRequirements: AUTH_REQUIREMENTS,
      voucherSignature: REFUND_SIGNATURE, signedMax: "60",
    });
    const laterTx = `0x${"cd".repeat(32)}`;
    await fullyClaimed.obligations.recordSubmitted(zeroDelta!.id, laterTx);
    chainClient.getTransactionReceipt.mockResolvedValue({
      status: "success", blockNumber: 10n, blockHash: BLOCK, transactionHash: laterTx,
      logs: [{ address: BATCH_SETTLEMENT_ADDRESS,
        topics: encodeEventTopics({ abi: [event], eventName: "Refunded",
          args: { channelId: CHANNEL, sender: CONFIG.payer } }),
        data: encodeAbiParameters([{ type: "uint128" }], [240n]) }],
    });
    await expect(fullyClaimed.obligations.observeCanonical(zeroDelta!.id))
      .resolves.toMatchObject({ deltaNative: "0", blockHash: BLOCK });
    expect(await fullyClaimed.obligations.unresolvedCount()).toBe(0);
  });

  it("recovers the same refund effect from its durable settled credit intent after local tx recording fails", async () => {
    const current = await fixture(); fixtures.push(current);
    await bookmarkRefund(current.pool);
    const reserved = await current.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: refundAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      refundNonce: "0", refundAmount: "240", voucherSignature: REFUND_SIGNATURE,
      signedMax: "60",
    });
    expect(reserved?.replayed).toBe(false);
    await current.pool.query(
      `UPDATE x402_batch_settlements SET status='settled',settle_response=$1
       WHERE operation='refund' AND channel_id=$2`,
      [JSON.stringify({ success: true, transaction: TX, network: NETWORK }), CHANNEL]
    );
    await current.obligations.recoverOriginalX402Refunds();
    expect(await current.obligations.submittedIds("x402", "refund", TX)).toEqual([reserved!.id]);
    await current.obligations.recoverOriginalX402Refunds();
    expect(await current.obligations.unresolvedCount()).toBe(1);
    await expect(current.obligations.reserveX402(CHANNEL, "refund", {
      authorizationPayload: refundAuthorization(),
      authorizationRequirements: AUTH_REQUIREMENTS,
      refundNonce: "0", refundAmount: "240", voucherSignature: REFUND_SIGNATURE,
      signedMax: "60",
    })).rejects.toThrow("pre-submission source");
  });

  it("continues original refund hash recovery after one persisted source write fails", async () => {
    const current = await fixture(); fixtures.push(current);
    const otherConfig = { ...CONFIG, salt: `0x${"45".repeat(32)}` as `0x${string}` };
    const otherChannel = computeChannelId(otherConfig, NETWORK);
    const sources: Array<{ id: string; channelId: string; txHash: string }> = [];
    for (const [index, channelId] of [CHANNEL, otherChannel].entries()) {
      await bookmarkRefund(current.pool, index === 0 ? CONFIG : otherConfig, channelId);
      const source = await current.obligations.reserveX402(channelId, "refund", {
        authorizationPayload: refundAuthorization(index === 0 ? CONFIG : otherConfig),
        authorizationRequirements: AUTH_REQUIREMENTS,
        refundNonce: "0", refundAmount: "240", voucherSignature: REFUND_SIGNATURE,
        signedMax: "60",
      });
      const txHash = `0x${(index === 0 ? "aa" : "bb").repeat(32)}`;
      await current.pool.query(
        `UPDATE x402_batch_settlements SET status='settled',settle_response=$2
         WHERE settlement_id=(SELECT original->>'settlementId'
                              FROM sdk_hosted_settlement_report_obligations WHERE id=$1)`,
        [source!.id, JSON.stringify({ success: true, transaction: txHash, network: NETWORK })]
      );
      sources.push({ id: source!.id, channelId, txHash });
    }
    await current.pool.query(`CREATE FUNCTION refuse_first_refund_hash() RETURNS trigger AS $$
      BEGIN IF NEW.id = '${sources[0].id}' THEN
        RAISE EXCEPTION 'first original hash write unavailable'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await current.pool.query(`CREATE TRIGGER refuse_first_refund_hash
      BEFORE UPDATE ON sdk_hosted_settlement_report_obligations
      FOR EACH ROW EXECUTE FUNCTION refuse_first_refund_hash()`);
    const failed = await current.obligations.recoverOriginalX402Refunds();
    expect(failed.map((item) => item.id)).toEqual([sources[0].id]);
    expect(await current.obligations.submittedIds("x402", "refund", sources[0].txHash)).toEqual([]);
    expect(await current.obligations.submittedIds("x402", "refund", sources[1].txHash))
      .toEqual([sources[1].id]);
    expect(await current.obligations.unresolvedCount()).toBe(2);
    await current.pool.query("DROP TRIGGER refuse_first_refund_hash ON sdk_hosted_settlement_report_obligations");
    expect(await current.obligations.recoverOriginalX402Refunds()).toEqual([]);
    expect(await current.obligations.submittedIds("x402", "refund", sources[0].txHash))
      .toEqual([sources[0].id]);
  });

  it("continues batch reconstruction after one historical open batch write fails", async () => {
    const current = await fixture(); fixtures.push(current);
    const otherConfig = { ...CONFIG, salt: `0x${"46".repeat(32)}` as `0x${string}` };
    const otherChannel = computeChannelId(otherConfig, NETWORK);
    const batches: string[] = [];
    for (const [index, channelId] of [CHANNEL, otherChannel].entries()) {
      if (index === 1) {
        await current.channelStore.updateChannel(otherChannel, () => ({
          channelId: otherChannel, channelConfig: otherConfig,
          chargedCumulativeAmount: "100", signedMaxClaimable: "100",
          signature: SIGNATURE, balance: "300", totalClaimed: "0",
          withdrawRequestedAt: 0, refundNonce: 0, onchainSyncedAt: Date.now(),
          lastRequestTimestamp: Date.now(),
        }));
      }
      const source = await current.obligations.reserveX402(channelId, "claim", {
        authorizationPayload: claimAuthorization(index === 0 ? CONFIG : otherConfig),
        authorizationRequirements: AUTH_REQUIREMENTS,
        charged: "100", signature: SIGNATURE, signedMax: "100",
      });
      const original = await current.pool.query<{ original: { batchId: string } }>(
        "SELECT original FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [source!.id]
      );
      const batchId = original.rows[0].original.batchId;
      batches.push(batchId);
      await current.pool.query(
        `UPDATE sdk_hosted_settlement_report_obligations
         SET tx_hash=$2,block_hash=$3,block_number=10,delta_native=100,state='observed'
         WHERE id=$1`, [source!.id, `0x${(index === 0 ? "aa" : "bb").repeat(32)}`, BLOCK]
      );
      if (index === 0) {
        await current.pool.query("UPDATE payout_x402_batches SET scope='prior-open-batch' WHERE batch_id=$1",
          [batchId]);
      }
    }
    await current.pool.query(`CREATE FUNCTION refuse_first_batch() RETURNS trigger AS $$
      BEGIN IF NEW.batch_id = '${batches[0]}' THEN
        RAISE EXCEPTION 'first batch write unavailable'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await current.pool.query(`CREATE TRIGGER refuse_first_batch BEFORE UPDATE ON payout_x402_batches
      FOR EACH ROW EXECUTE FUNCTION refuse_first_batch()`);
    const failed = await current.obligations.reconcileX402Batches();
    expect(failed.map((item) => item.id)).toEqual([batches[0]]);
    const amounts = await current.pool.query<{ batch_id: string; claimed_native: string }>(
      "SELECT batch_id,claimed_native FROM payout_x402_batches"
    );
    expect(new Map(amounts.rows.map((row) => [row.batch_id, row.claimed_native])))
      .toEqual(new Map([[batches[0], "0"], [batches[1], "100"]]));
    await current.pool.query("DROP TRIGGER refuse_first_batch ON payout_x402_batches");
    expect(await current.obligations.reconcileX402Batches()).toEqual([]);
    const recovered = await current.pool.query<{ claimed_native: string }>(
      "SELECT claimed_native FROM payout_x402_batches WHERE batch_id=$1", [batches[0]]
    );
    expect(recovered.rows[0].claimed_native).toBe("100");
  });

  it.each(["reserved", "observed", "report_queued", "delivered", "no_report", "exhausted",
    "submitted", "foreign_owner", "foreign_scope", "unmatched"])("only writes off an owned unsubmitted unmatched report: %s", async (scenario) => {
    const current = await fixture(); fixtures.push(current);
    const channelId = `0x${"91".repeat(32)}`;
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    current.obligations.configureTempo({ network: "eip155:42431", escrow, payee: RECEIVER, token: TOKEN });
    const sessions = new PostgresTempoSessionStore(current.pool);
    await sessions.init();
    await sessions.put(channelId, { channelId, chainId: 42431, escrowContract: escrow, payee: RECEIVER,
      payer: CONFIG.payer, token: TOKEN, highestVoucherAmount: 20n, settledOnChain: 10n, spent: 20n });
    await current.pool.query("INSERT INTO mpp_tempo_close_intents(channel_id,drain_id,updated_at) VALUES($1,$2,$3)",
      [channelId, "original-drain", Date.now()]);
    const reserved = await current.obligations.reserveTempo(channelId, "close", "original-drain");
    const state = ["foreign_owner", "foreign_scope", "submitted"].includes(scenario) ? "unmatched" : scenario;
    await current.pool.query("UPDATE sdk_hosted_settlement_report_obligations SET state=$2,tx_hash=$3 WHERE id=$1",
      [reserved.id, state, scenario === "submitted" ? TX : null]);
    const warn = vi.spyOn(loggers.tempo, "warn");
    const args = { db: current.pool, dvmId: scenario === "foreign_owner" ? "other" : current.dvmId,
      scope: scenario === "foreign_scope" ? "other" : current.scope, obligationId: reserved.id,
      note: "Escrow log history is irrecoverable" };
    expect(await writeOffHostedTempoCloseReport(args)).toBe(scenario === "unmatched");
    if (scenario === "unmatched") {
      expect((await current.pool.query(
        "SELECT state,close_write_off_note FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved.id])).rows)
        .toEqual([{ state: "no_report", close_write_off_note: args.note }]);
      expect(warn).toHaveBeenCalledWith("tempo_session_close_report_written_off",
        expect.objectContaining({ channel_id: channelId, amount_forgone_native: "10" }));
      expect(await current.obligations.unresolvedCount()).toBe(0);
      expect(await writeOffHostedTempoCloseReport(args)).toBe(false);
      expect(warn.mock.calls.filter(([name]) => name === "tempo_session_close_report_written_off")).toHaveLength(1);
    } else {
      expect((await current.pool.query("SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved.id])).rows)
        .toEqual([{ state }]);
      expect(warn).not.toHaveBeenCalledWith("tempo_session_close_report_written_off", expect.anything());
    }
  });

  it("keeps the existing state constraint on a second initialization", async () => {
    const current = await fixture(); fixtures.push(current);
    const constraint = async () => (await current.pool.query(
      `SELECT oid,convalidated FROM pg_constraint
       WHERE conrelid='sdk_hosted_settlement_report_obligations'::regclass
         AND conname='sdk_hosted_settlement_report_obligations_state_check'`)).rows;
    const before = await constraint();
    await current.obligations.init();
    expect(await constraint()).toEqual(before);
  });

  it("upgrades an existing close reservation and preserves its terminal late-receipt claim", async () => {
    const current = await fixture(); fixtures.push(current);
    const channelId = `0x${"91".repeat(32)}`;
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    current.obligations.configureTempo({ network: "eip155:42431", escrow,
      payee: RECEIVER, token: TOKEN });
    const sessions = new PostgresTempoSessionStore(current.pool);
    await sessions.init();
    await sessions.put(channelId, { channelId, chainId: 42431, escrowContract: escrow,
      payee: RECEIVER, payer: CONFIG.payer, token: TOKEN,
      highestVoucherAmount: 20n, settledOnChain: 10n, spent: 20n });
    await current.pool.query(
      "INSERT INTO mpp_tempo_close_intents(channel_id,drain_id,updated_at) VALUES($1,$2,$3)",
      [channelId, "original-drain", Date.now()]
    );
    await current.pool.query(`ALTER TABLE sdk_hosted_settlement_report_obligations
      DROP CONSTRAINT sdk_hosted_settlement_report_obligations_state_check;
      ALTER TABLE sdk_hosted_settlement_report_obligations ADD CONSTRAINT
      sdk_hosted_settlement_report_obligations_state_check CHECK
      (state IN ('reserved','observed','report_queued','delivered','no_report'))`);
    const reserved = await current.obligations.reserveTempo(channelId, "close", "original-drain");
    await current.obligations.init();
    await current.obligations.releaseStaleTempoClose(reserved.id, channelId, "original-drain",
      { staleAfterMs: 0, maxReleases: 0 });
    expect((await current.pool.query("SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved.id])).rows)
      .toEqual([{ state: "exhausted" }]);
    await current.obligations.recordSubmitted(reserved.id, TX);
    expect((await current.pool.query(
      "SELECT state,tx_hash,original FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [reserved.id])).rows)
      .toEqual([{ state: "reserved", tx_hash: TX, original: { drainId: "original-drain",
        highestVoucherAmount: "20", settledOnChain: "10", spent: "20" } }]);
  });

  it("repairs an original Tempo close by reporting only its newly settled payee amount", async () => {
    const current = await fixture(); fixtures.push(current);
    const channelId = `0x${"91".repeat(32)}`;
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    current.obligations.configureTempo({ network: "eip155:42431", escrow,
      payee: RECEIVER, token: TOKEN });
    const sessions = new PostgresTempoSessionStore(current.pool);
    await sessions.init();
    await sessions.put(channelId, { channelId, chainId: 42431, escrowContract: escrow,
      payee: RECEIVER, payer: CONFIG.payer, token: TOKEN,
      highestVoucherAmount: 20n, settledOnChain: 10n, spent: 20n });
    await current.pool.query(
      "INSERT INTO mpp_tempo_close_intents(channel_id,drain_id,updated_at) VALUES($1,$2,$3)",
      [channelId, "original-drain", Date.now()]
    );
    const reserved = await current.obligations.reserveTempo(channelId, "close", "original-drain");
    await current.obligations.recordSubmitted(reserved.id, TX);
    const enqueueHostedPayout = vi.fn().mockResolvedValue(undefined);
    const reporter = new PayoutReporter({ dvmId: "owned", hostedObligations: current.obligations,
      transport: { enqueueHostedPayout, enqueuePayout: vi.fn(), reportPayout: vi.fn(),
        reportPayoutPending: vi.fn() } });
    await reporter.tempoCloseReconciled({ channelId, txHash: TX, settledToPayee: "20" });
    expect(enqueueHostedPayout).toHaveBeenCalledOnce();
    expect(enqueueHostedPayout.mock.calls[0][0]).toMatchObject({
      payoutId: `tempo:${TX}`, nativeAmount: 10, kind: "close", repaired: true,
    });
    expect(enqueueHostedPayout.mock.calls[0][1]).toEqual([reserved.id]);
    await expect(reporter.tempoCloseReconciled({ channelId, txHash: `0x${"cd".repeat(32)}`,
      settledToPayee: "20" })).rejects.toThrow("original close obligation");
  });

  it("periodic recovery delivers a later finalized payout when the first report cannot be queued", async () => {
    const current = await fixture(); fixtures.push(current);
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    current.obligations.configureTempo({ network: "eip155:42431", escrow,
      payee: RECEIVER, token: TOKEN });
    const sessions = new PostgresTempoSessionStore(current.pool);
    await sessions.init();
    const sources: Array<{ id: string; txHash: string }> = [];
    for (const [index, byte] of ["92", "93"].entries()) {
      const channelId = `0x${byte.repeat(32)}`;
      const txHash = `0x${(index === 0 ? "aa" : "bb").repeat(32)}`;
      await sessions.put(channelId, { channelId, chainId: 42431, escrowContract: escrow,
        payee: RECEIVER, payer: CONFIG.payer, token: TOKEN,
        highestVoucherAmount: 20n, settledOnChain: 10n, spent: 20n });
      const source = await current.obligations.reserveTempo(channelId, "settle");
      await current.obligations.recordSubmitted(source.id, txHash);
      await current.pool.query(
        `UPDATE sdk_hosted_settlement_report_obligations
         SET block_hash=$2,block_number=10,delta_native=10,state='observed',created_at_ms=$3
         WHERE id=$1`, [source.id, BLOCK, index + 1]
      );
      sources.push({ id: source.id, txHash });
    }
    const transport = new RevenueReporter(current.pool, "https://platform.invalid", "local-token",
      current.obligations);
    await transport.init();
    await current.pool.query(`CREATE FUNCTION refuse_first_payout() RETURNS trigger AS $$
      BEGIN IF NEW.payload->>'payoutId' = 'tempo:${sources[0].txHash}' THEN
        RAISE EXCEPTION 'first payout queue unavailable'; END IF; RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await current.pool.query(`CREATE TRIGGER refuse_first_payout BEFORE INSERT ON pending_dvm_reports
      FOR EACH ROW EXECUTE FUNCTION refuse_first_payout()`);
    const reporter = new PayoutReporter({ dvmId: current.dvmId, hostedObligations: current.obligations,
      transport, snapshotIntervalMs: 50 });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    try {
      reporter.start();
      await vi.waitFor(async () => {
        const result = await current.pool.query<{ state: string }>(
          "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
          [sources[1].id]
        );
        expect(result.rows[0].state).toBe("delivered");
      }, { timeout: 4_000 });
      const first = await current.pool.query<{ state: string; report_id: string | null }>(
        "SELECT state,report_id FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [sources[0].id]
      );
      expect(first.rows[0]).toMatchObject({ state: "observed", report_id: null });
      expect(await current.obligations.unresolvedCount()).toBe(1);
    } finally {
      reporter.stop();
      vi.unstubAllGlobals();
    }
  });
});
