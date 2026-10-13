import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { Credential } from "mppx";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { Session as TempoSession } from "mppx/tempo";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  encodeFunctionResult, keccak256, parseAbiItem } from "viem";
import type { Channel } from "@x402/evm/batch-settlement/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { HostingControl, type HostingClosureCommand } from "../hosting-control";
import { HostedChannelEvidenceReader } from "../hosting-channel-evidence";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { X402_BATCH_CHANNEL_ABI } from "../../../lib/x402/batch-abi";
import { resolveTempoNetwork } from "../mpp-setup";
import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { PostgresTempoChargeStore } from "../tempo-charge-store";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import type { JobRecord } from "../job-store";
import { PayoutReporter, PostgresX402BatchStore } from "../payout-reporter";
import { PostgresX402ChannelStorage } from "../x402-channel-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const secret = "test-only-hosting-cleanup-secret-32-bytes";
const support = {
  singleMount: true, durableLedger: true, durableJobStore: true,
  durableReporter: true, durablePaymentReplay: true, knownRailStores: true,
};

describe.skipIf(!RUN)("hosted obligation fence (real Postgres)", () => {
  const schema = `hosting_cleanup_${randomUUID().slice(0, 8)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let jobStore: PostgresJobStore;
  let x402Storage: PostgresX402ChannelStorage;
  let tempoSessions: PostgresTempoSessionStore;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    await new HostedSettlementReportObligations(pool, "fresh-history", "fresh-history").init();
    jobStore = new PostgresJobStore(pool);
    await jobStore.init();
    await jobStore.initStreaming();
    await new CreditLedger(pool).init();
    await new PostgresProcessedPaymentStore(pool).init();
    await new RevenueReporter(pool, "https://example.com", "test-token").init();
    await new PostgresX402BatchStore(pool).init();
    x402Storage = new PostgresX402ChannelStorage(pool);
    await x402Storage.init();
    await new PostgresTempoChargeStore(pool, { gcSampleRate: 0 }).init();
    tempoSessions = new PostgresTempoSessionStore(pool);
    await tempoSessions.init();
  });

  afterAll(async () => {
    await jobStore.shutdownStreaming();
    await x402Storage.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });

  async function scope(channelReader?: HostedChannelEvidenceReader) {
    const dvmId = `cleanup-${randomUUID()}`;
    const deployment = `deployment-${randomUUID()}`;
    const control = new HostingControl(pool, dvmId, { secret, scope: deployment }, channelReader);
    await control.init();
    jobStore.useHostingCleanupFence(control.cleanupFence);
    expect(await control.transition({
      action: "resume", version: 2, dvmId, scope: deployment, generation: 1,
      leaseExpiresAtMs: Date.now() + 60_000, deadlineMs: Date.now() + 90_000,
      timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
    })).toBe("ok");
    const close = async () => {
      const command: HostingClosureCommand = {
        version: 3, action: "close", dvmId, scope: deployment, generation: 2,
        operationId: `operation_${randomUUID().replaceAll("-", "")}`,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
      };
      expect(await control.close(command, support)).toBe("ok");
      return command;
    };
    const cleanup = async () => {
      await pool.query("DELETE FROM sdk_hosted_tempo_charge_intents WHERE admission_id IN (SELECT id FROM sdk_hosting_admissions WHERE dvm_id=$1)", [dvmId]);
      await pool.query("DELETE FROM processed_payments WHERE dvm_id=$1", [dvmId]);
      await pool.query("DELETE FROM job_messages WHERE job_id IN (SELECT job_id FROM sdk_hosting_admissions WHERE dvm_id=$1)", [dvmId]);
      await pool.query("DELETE FROM jobs WHERE dvm_id=$1", [dvmId]);
      await pool.query("DELETE FROM sdk_hosting_admissions WHERE dvm_id=$1", [dvmId]);
      await pool.query("DELETE FROM sdk_hosting_nonces WHERE dvm_id=$1", [dvmId]);
      await pool.query("DELETE FROM sdk_hosting_control WHERE dvm_id=$1", [dvmId]);
    };
    return { dvmId, deployment, control, close, cleanup };
  }

  it("keeps empty pre-instrumentation channel tables historically unknown", async () => {
    const oldSchema = `hosting_old_${randomUUID().slice(0, 8)}`;
    await adminPool.query(`CREATE SCHEMA ${oldSchema}`);
    const oldPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${oldSchema}` });
    const oldX402 = new PostgresX402ChannelStorage(oldPool, { hostedNetwork: "eip155:84532" });
    const oldTempo = new PostgresTempoSessionStore(oldPool);
    try {
      await adminPool.query(`CREATE TABLE ${oldSchema}.x402_batch_channels
        (LIKE ${schema}.x402_batch_channels)`);
      await adminPool.query(`CREATE TABLE ${oldSchema}.mpp_tempo_channels
        (channel_key TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at BIGINT NOT NULL)`);
      await Promise.all([oldX402.init(), oldTempo.init()]);
      const reader = await HostedChannelEvidenceReader.fromServerConfig(oldPool, {});
      expect((await reader.observe()).reasons).toEqual(expect.arrayContaining([
        "x402_channel_history_incomplete", "tempo_channel_history_incomplete",
      ]));
      await Promise.all([oldX402.init(), oldTempo.init()]);
      const markers = await oldPool.query<{ x402: boolean; tempo: boolean }>(
        `SELECT (SELECT complete FROM x402_batch_channel_history WHERE singleton) AS x402,
                (SELECT complete FROM mpp_tempo_channel_history WHERE singleton) AS tempo`
      );
      expect(markers.rows[0]).toEqual({ x402: false, tempo: false });
    } finally {
      await oldX402.close();
      await oldPool.end();
      await adminPool.query(`DROP SCHEMA ${oldSchema} CASCADE`);
    }
  });

  it("serializes fresh channel history initialization ahead of concurrent writes and deletions", async () => {
    const freshSchema = `hosting_fresh_${randomUUID().slice(0, 8)}`;
    const channelId = `0x${"ea".repeat(32)}`;
    await adminPool.query(`CREATE SCHEMA ${freshSchema}`);
    const freshPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${freshSchema}` });
    const first = new PostgresTempoSessionStore(freshPool);
    const second = new PostgresTempoSessionStore(freshPool);
    try {
      await Promise.all([first.init(), second.init().then(async () => {
        await second.put(channelId, { channelId, highestVoucherAmount: 1n, spent: 0n,
          settledOnChain: 0n, deposit: 1n, closeRequestedAt: 0n, finalized: false });
        await second.delete(channelId);
      })]);
      const result = await freshPool.query<{ complete: boolean; tombstones: string }>(
        `SELECT (SELECT complete FROM mpp_tempo_channel_history WHERE singleton) AS complete,
                (SELECT COUNT(*)::text FROM mpp_tempo_channel_tombstones) AS tombstones`
      );
      expect(result.rows[0]).toEqual({ complete: true, tombstones: "1" });
      await first.init();
      const retained = await freshPool.query<{ complete: boolean; state_json: string }>(
        `SELECT h.complete,t.state_json FROM mpp_tempo_channel_history h
         JOIN mpp_tempo_channel_tombstones t ON t.channel_key=$1`, [channelId]
      );
      expect(retained.rows[0].complete).toBe(true);
      expect(retained.rows[0].state_json).toContain(channelId);
    } finally {
      await freshPool.end();
      await adminPool.query(`DROP SCHEMA ${freshSchema} CASCADE`);
    }
  });

  it("keeps an original late funding operation ineligible until its terminal booking is durable", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const late = await pool.connect();
    try {
      expect(await fixture.control.admit(admissionId, `credit-fund:${creditId}:${fundId}`, {
        creditId, fundId, callerPubkey: "caller", fundingCommitment: "original",
        paymentArtifactHash: "a".repeat(64),
      })).toBe(true);
      const command = await fixture.close();
      await late.query("BEGIN");
      await fixture.control.cleanupFence.assertNewIntent(late, { admissionId, creditId, fundId,
        callerPubkey: "caller", fundingCommitment: "original", paymentArtifactHash: "a".repeat(64) });
      expect(await fixture.control.certificate({ ...command, action: "certificate" }, support))
        .toMatchObject({ eligible: false, reasons: expect.arrayContaining(["admissions_unresolved"]) });
      await late.query("ROLLBACK");
      await fixture.control.finishAdmission(admissionId, "accepted");
      expect(await fixture.control.certificate({ ...command, action: "certificate" }, support))
        .toMatchObject({ eligible: false, reasons: expect.arrayContaining(["funding_intents_unbooked"]) });
    } finally {
      await late.query("ROLLBACK").catch(() => undefined);
      late.release();
      await fixture.cleanup();
    }
  });

  it("certifies a clean terminal scope and invalidates the old boot epoch", async () => {
    const fixture = await scope();
    try {
      const command = await fixture.close();
      const first = await fixture.control.certificate({ ...command, action: "certificate" }, support);
      expect(first).toMatchObject({ complete: true, eligible: true,
        dvmId: fixture.dvmId, scope: fixture.deployment, generation: 2,
        operationId: command.operationId, liabilities: [] });
      const batches = new PostgresX402BatchStore(pool);
      await batches.put({ scope: fixture.dvmId, batchId: randomUUID(), claimedNative: 1n,
        voucherCount: 1, claims: 1, openedAt: Date.now(), attempts: 0,
        firstFailedAt: null, lastError: null, nextRetryAt: null });
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("x402_payout_batches_pending");
      await batches.delete(fixture.dvmId);
      const restarted = new HostingControl(pool, fixture.dvmId, { secret, scope: fixture.deployment });
      await restarted.init();
      expect(await fixture.control.certificate({ ...command, action: "certificate" }, support)).toBeUndefined();
      const second = await restarted.certificate({ ...command, action: "certificate" }, support);
      expect(second?.eligible).toBe(true);
      expect(second?.bootEpoch).toBe((first?.bootEpoch ?? 0) + 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("certifies only a finalized x402 view covering the accepted voucher and unchanged local rows", async () => {
    const config = { payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"11".repeat(20)}`,
      receiver: `0x${"22".repeat(20)}`, receiverAuthorizer: `0x${"22".repeat(20)}`,
      token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", withdrawDelay: 86_400,
      salt: `0x${"ad".repeat(32)}` } as const;
    const channelId = computeChannelId(config, "eip155:84532");
    const signature = `0x${"55".repeat(65)}`;
    const claimAuthorizer = `0x${"88".repeat(65)}`;
    const claimTx = `0x${"aa".repeat(32)}`;
    const settleTx = `0x${"bb".repeat(32)}`;
    const claimAbi = [{ type: "function", name: "claimWithSignature", stateMutability: "nonpayable",
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
    const claimCall = encodeFunctionData({ abi: claimAbi, functionName: "claimWithSignature",
      args: [[{ voucher: { channel: config, maxClaimableAmount: 1n },
        signature: signature as `0x${string}`, totalClaimed: 1n }],
        claimAuthorizer as `0x${string}`] });
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const payoutScope = `eip155:84532|${config.receiver.toLowerCase()}|${config.token.toLowerCase()}`;
    const blockHash = `0x${"12".repeat(32)}`;
    let chainBalance = 1n;
    let claimed = 0n;
    let chainRefundNonce = 0n;
    let mutateOnCanonical = false;
    let rpcChainId = 84532;
    const hostedStorage = new PostgresX402ChannelStorage(pool, { hostedNetwork: "eip155:84532" });
    const requests: string[] = [];
    const rpc = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (!String(_input).includes("rpc.test.invalid")) return new Response(null, { status: 200 });
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      requests.push(request.method);
      let result: unknown;
      if (request.method === "eth_chainId") result = `0x${rpcChainId.toString(16)}`;
      else if (request.method === "eth_getBlockByNumber") {
        if (request.params[0] === "0x64" && mutateOnCanonical) {
          mutateOnCanonical = false;
          await pool.query("UPDATE x402_batch_channel_tombstones SET signed_max_claimable=2 WHERE channel_id=$1", [channelId]);
        }
        result = { hash: blockHash, number: "0x64", timestamp: "0x1", transactions: [] };
      } else if (request.method === "eth_call") {
        const call = request.params[0] as { data: `0x${string}` };
        const { functionName } = decodeFunctionData({ abi: X402_BATCH_CHANNEL_ABI, data: call.data });
        if (functionName === "channels") result = encodeFunctionResult({
          abi: X402_BATCH_CHANNEL_ABI, functionName, result: [chainBalance, claimed],
        });
        else if (functionName === "pendingWithdrawals") result = encodeFunctionResult({
          abi: X402_BATCH_CHANNEL_ABI, functionName, result: [0n, 0],
        });
        else if (functionName === "refundNonce") result = encodeFunctionResult({
          abi: X402_BATCH_CHANNEL_ABI, functionName, result: chainRefundNonce,
        });
      } else if (request.method === "eth_getTransactionReceipt") {
        const txHash = String(request.params[0]).toLowerCase();
        const settled = parseAbiItem(
          "event Settled(address indexed receiver,address indexed token,address indexed sender,uint128 amount)"
        );
        result = { transactionHash: txHash, transactionIndex: "0x0", blockHash,
          blockNumber: "0x64", from: config.payer, to: BATCH_SETTLEMENT_ADDRESS,
          cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1",
          status: "0x1", type: "0x2", logsBloom: `0x${"00".repeat(256)}`,
          logs: txHash === settleTx ? [{ address: BATCH_SETTLEMENT_ADDRESS, blockHash,
            blockNumber: "0x64", transactionHash: txHash, transactionIndex: "0x0",
            logIndex: "0x0", removed: false,
            topics: encodeEventTopics({ abi: [settled], eventName: "Settled",
              args: { receiver: config.receiver, token: config.token, sender: config.payer } }),
            data: encodeAbiParameters([{ type: "uint128" }], [1n]) }] : [] };
      } else if (request.method === "eth_getTransactionByHash") {
        const txHash = String(request.params[0]).toLowerCase();
        result = { hash: txHash, blockHash, blockNumber: "0x64", transactionIndex: "0x0",
          from: config.payer, to: BATCH_SETTLEMENT_ADDRESS,
          input: txHash === claimTx ? claimCall : "0x", value: "0x0", gas: "0x1",
          gasPrice: "0x1", nonce: "0x0", type: "0x2", chainId: "0x14a34" };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    let fixture: Awaited<ReturnType<typeof scope>> | undefined;
    try {
      const reader = await HostedChannelEvidenceReader.fromServerConfig(pool, {
        x402: { network: "eip155:84532", rpcUrl: "https://rpc.test.invalid" },
      });
      fixture = await scope(reader);
      await hostedStorage.init();
      await hostedStorage.updateChannel(channelId, () => ({ channelId, channelConfig: config,
        chargedCumulativeAmount: "1", signedMaxClaimable: "1", signature,
        balance: "1", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0,
        lastRequestTimestamp: Date.now() }));
      const obligations = new HostedSettlementReportObligations(pool, fixture.dvmId, fixture.deployment);
      obligations.configureX402({ network: "eip155:84532", rpcUrl: "https://rpc.test.invalid",
        receiver: config.receiver, token: config.token });
      obligations.attachX402SettlementStore(hostedStorage);
      const originalClaim = await obligations.reserveX402(channelId, "claim", {
        authorizationPayload: { type: "claim", claims: [{ voucher: {
          channel: config, maxClaimableAmount: "1" }, signature, totalClaimed: "1" }],
          claimAuthorizerSignature: claimAuthorizer },
        authorizationRequirements: { scheme: "batch-settlement", network: "eip155:84532",
          asset: config.token, payTo: config.receiver, amount: "0" },
        charged: "1", signature, signedMax: "1",
      });
      expect(originalClaim?.replayed).toBe(false);
      await obligations.recordSubmitted(originalClaim!.id, claimTx);
      const ledger = new CreditLedger(pool);
      const credit = await ledger.fund({ creditId, callerPubkey: "caller", currency: "usd",
        amountMicro: 100, expiryMs: Date.now() + 60_000,
        basis: { rail: "x402", paidMsats: 1, nativeAmount: 1, nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "1" } } });
      await ledger.recordFunding({ creditId, fundId, amountMicro: 100, rail: "x402" });
      await ledger.completeFunding({ creditId, fundId, callerPubkey: "caller",
        balanceAfterMicro: credit.balanceMicro, ledgerSeq: credit.lastLedgerSeq });
      const command = await fixture.close();
      const certificate = () => fixture!.control.certificate({ ...command, action: "certificate" }, support);
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["x402_channel_evidence_unresolved"]) });
      claimed = 1n;
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["caller_liability_positive", "settlement_reports_unresolved"]) });
      expect(await obligations.observeCanonical(originalClaim!.id))
        .toMatchObject({ deltaNative: "1", blockHash });
      expect(await obligations.reconcileX402Batches()).toEqual([]);
      const originalSettle = await obligations.reserveOpenX402Settlement();
      await obligations.recordSubmitted(originalSettle.id, settleTx);
      expect(await obligations.observeCanonical(originalSettle.id))
        .toMatchObject({ deltaNative: "1", blockHash });
      const transport = new RevenueReporter(pool, "https://platform.invalid", "local-token", obligations);
      const payout = new PayoutReporter({ dvmId: fixture.dvmId, db: pool,
        hostedObligations: obligations, transport });
      const observer = payout.x402Observer();
      observer.attach({ scope: payoutScope, payTo: config.receiver, network: "eip155:84532",
        storage: hostedStorage, settleIntervalMs: 1_000,
        earnedNative: (id) => ledger.earnedNativeForX402Channel(id) });
      await observer.recordSettle(settleTx);
      expect((await pool.query<{ report_id: string | null }>(
        "SELECT report_id FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [originalSettle.id]
      )).rows[0].report_id).not.toBeNull();
      await transport.drainPending();
      expect((await pool.query<{ state: string }>(
        "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [originalSettle.id]
      )).rows[0].state).toBe("delivered");
      expect(await obligations.unresolvedCount()).toBe(0);
      expect((await pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM pending_dvm_reports"
      )).rows[0].n).toBe("0");
      await ledger.draw({ creditId, drawId: "served", amountMicro: 100 });
      await ledger.settle({ creditId, drawId: "served" });
      await hostedStorage.setSettlePending(payoutScope, true);
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["x402_payout_transfer_pending"]) });
      await hostedStorage.setSettlePending(payoutScope, false);
      await pool.query(`UPDATE sdk_hosted_settlement_report_obligations
        SET original=jsonb_set(original,'{claimedBefore}','"1"'::jsonb)
        WHERE id=$1`, [originalClaim!.id]);
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["x402_channel_evidence_unresolved"]) });
      await pool.query(`UPDATE sdk_hosted_settlement_report_obligations
        SET original=jsonb_set(original,'{claimedBefore}','"0"'::jsonb)
        WHERE id=$1`, [originalClaim!.id]);
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      await pool.query(`UPDATE sdk_hosted_settlement_report_obligations
        SET original=original-'authorizationCallData' WHERE id=$1`, [originalClaim!.id]);
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["settlement_reports_unresolved"]) });
      await pool.query(`UPDATE sdk_hosted_settlement_report_obligations
        SET original=jsonb_set(original,'{authorizationCallData}',to_jsonb($2::text))
        WHERE id=$1`, [originalClaim!.id, claimCall]);
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      chainBalance = 2n;
      claimed = 2n;
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["x402_channel_evidence_unresolved"]) });
      chainBalance = 1n;
      claimed = 1n;
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      chainRefundNonce = 1n;
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["x402_channel_evidence_unresolved"]) });
      chainRefundNonce = 0n;
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      expect(requests).toContain("eth_getBlockByNumber");
      const persisted = await pool.query<{ channel_evidence: { x402: { blockHash: string } } }>(
        "SELECT channel_evidence FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2",
        [fixture.dvmId, fixture.deployment]
      );
      expect(persisted.rows[0].channel_evidence.x402.blockHash).toBe(blockHash);
      rpcChainId = 8453;
      const movedConfig = await HostedChannelEvidenceReader.fromServerConfig(pool, {
        x402: { network: "eip155:8453", rpcUrl: "https://rpc.test.invalid" },
      });
      expect((await movedConfig.observe()).reasons).toContain("x402_channel_evidence_unresolved");
      rpcChainId = 84532;
      expect((await hostedStorage.updateChannel(channelId, () => undefined)).status).toBe("deleted");
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      mutateOnCanonical = true;
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["channel_evidence_stale"]) });
    } finally {
      rpc.mockRestore();
      await hostedStorage.close();
      await pool.query("DELETE FROM credit_draws WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM x402_batch_settlement_state WHERE scope=$1", [payoutScope]);
      await pool.query("DELETE FROM x402_batch_channel_tombstones WHERE channel_id=$1", [channelId]);
      await pool.query("DELETE FROM x402_batch_channels WHERE channel_id=$1", [channelId]);
      await pool.query("DELETE FROM sdk_hosted_settlement_report_obligations WHERE dvm_id=$1",
        [fixture?.dvmId ?? ""]);
      await new PostgresX402BatchStore(pool).delete(payoutScope);
      await fixture?.cleanup();
    }
  });

  it("requires a canonical finalized Tempo close receipt and full accepted spending cover", async () => {
    const channelId = `0x${"bc".repeat(32)}` as `0x${string}`;
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const receiptHash = `0x${"de".repeat(32)}`;
    const blockHash = `0x${"34".repeat(32)}`;
    const escrow = TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const payer = `0x${"11".repeat(20)}` as const;
    const payee = `0x${"22".repeat(20)}` as const;
    const network = resolveTempoNetwork({ DVMKIT_TEMPO_TESTNET: "1" });
    const drainId = `drain-${randomUUID()}`;
    let onchainSettled = 0n;
    let receiptCanonical = true;
    const rpc = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (!String(_input).includes("rpc.test.invalid")) return new Response(null, { status: 200 });
      const request = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      let result: unknown;
      if (request.method === "eth_chainId") result = "0xa5bf";
      else if (request.method === "eth_getBlockByNumber") {
        const number = request.params[0];
        result = { hash: number === "0x50" && !receiptCanonical ? `0x${"ff".repeat(32)}` : blockHash,
          number: number === "0x50" ? "0x50" : "0x64", timestamp: "0x1", transactions: [] };
      } else if (request.method === "eth_call") {
        const call = request.params[0] as { data: `0x${string}` };
        const { functionName } = decodeFunctionData({
          abi: TempoSession.Precompile.escrowAbi, data: call.data,
        });
        if (functionName === "getChannelState") result = encodeFunctionResult({
          abi: TempoSession.Precompile.escrowAbi, functionName,
          result: { settled: onchainSettled, deposit: 0n, closeRequestedAt: 0 },
        });
      } else if (request.method === "eth_getTransactionByHash") {
        result = { hash: receiptHash, blockHash, blockNumber: "0x50", transactionIndex: "0x0",
          from: payer, to: escrow, input: "0x", value: "0x0", gas: "0x1",
          gasPrice: "0x1", nonce: "0x0", type: "0x2", chainId: "0xa5bf" };
      } else if (request.method === "eth_getTransactionReceipt") {
        result = { transactionHash: receiptHash, transactionIndex: "0x0", blockHash,
          blockNumber: "0x50", from: payer, to: escrow, cumulativeGasUsed: "0x1",
          gasUsed: "0x1", effectiveGasPrice: "0x1", status: "0x1", type: "0x2",
          logsBloom: `0x${"00".repeat(256)}`,
          logs: [{ address: escrow, blockHash, blockNumber: "0x50", transactionHash: receiptHash,
            transactionIndex: "0x0", logIndex: "0x0", removed: false,
            topics: encodeEventTopics({ abi: TempoSession.Precompile.escrowAbi,
              eventName: "ChannelClosed", args: { channelId, payer, payee } }),
            data: encodeAbiParameters([{ type: "uint96" }, { type: "uint96" }], [5n, 0n]) }],
        };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    let fixture: Awaited<ReturnType<typeof scope>> | undefined;
    try {
      const reader = await HostedChannelEvidenceReader.fromServerConfig(pool, {
        tempoEnv: { DVMKIT_TEMPO_TESTNET: "1", DVMKIT_TEMPO_RPC_URL: "https://rpc.test.invalid" },
      });
      fixture = await scope(reader);
      const initialState = { channelId, chainId: network.chainId,
          escrowContract: escrow, payer, payee, token: network.currency,
          highestVoucherAmount: 5n, settledOnChain: 0n, spent: 0n, deposit: 5n,
          closeRequestedAt: 0n, finalized: false };
      await tempoSessions.put(channelId, initialState);
      const ledger = new CreditLedger(pool, tempoSessions);
      const credit = await ledger.fund({ creditId, callerPubkey: "caller", currency: "usd",
        amountMicro: 5, expiryMs: Date.now() + 60_000,
        basis: { rail: "tempo", paidMsats: 1, nativeAmount: 5, nativeAsset: "pathUSD",
          tempoSession: { channelId, cumulativeAmount: "5" } } });
      await ledger.recordFunding({ creditId, fundId, amountMicro: 5, rail: "tempo" });
      await ledger.completeFunding({ creditId, fundId, callerPubkey: "caller",
        balanceAfterMicro: credit.balanceMicro, ledgerSeq: credit.lastLedgerSeq });
      await ledger.draw({ creditId, drawId: "served", amountMicro: 5 });
      await ledger.settle({ creditId, drawId: "served" });
      expect(await tempoSessions.get(channelId)).toMatchObject({ spent: 5n });
      await tempoSessions.withCloseIntent(channelId, drainId, async () => undefined);
      await tempoSessions.resolveCloseForecast(channelId, drainId, "proceed");
      const obligations = new HostedSettlementReportObligations(pool, fixture.dvmId, fixture.deployment);
      obligations.configureTempo({ network: `eip155:${network.chainId}`,
        rpcUrl: "https://rpc.test.invalid", escrow, payee, token: network.currency });
      const originalClose = await obligations.reserveTempo(channelId, "close", drainId);
      expect(originalClose.replayed).toBe(false);
      await obligations.recordSubmitted(originalClose.id, receiptHash);
      await tempoSessions.confirmClose(channelId, drainId, receiptHash);
      await tempoSessions.put(channelId, { ...initialState, spent: 5n,
        settledOnChain: 5n, deposit: 0n, finalized: true });
      const command = await fixture.close();
      const certificate = () => fixture!.control.certificate({ ...command, action: "certificate" }, support);
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["tempo_channel_evidence_unresolved"]) });
      onchainSettled = 5n;
      expect(await obligations.observeCanonical(originalClose.id))
        .toMatchObject({ deltaNative: "5", blockHash });
      const transport = new RevenueReporter(pool, "https://platform.invalid", "local-token", obligations);
      const payout = new PayoutReporter({ dvmId: fixture.dvmId, db: pool,
        hostedObligations: obligations, transport });
      await payout.tempoCloseReconciled({ channelId, txHash: receiptHash, settledToPayee: "5" });
      expect((await pool.query<{ report_id: string | null }>(
        "SELECT report_id FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [originalClose.id]
      )).rows[0].report_id).not.toBeNull();
      await transport.drainPending();
      expect((await pool.query<{ state: string }>(
        "SELECT state FROM sdk_hosted_settlement_report_obligations WHERE id=$1",
        [originalClose.id]
      )).rows[0].state).toBe("delivered");
      expect(await obligations.unresolvedCount()).toBe(0);
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      const hostedSession = new PostgresTempoSessionStore(pool);
      hostedSession.useHostingCleanupFence(fixture.control.cleanupFence);
      await hostedSession.delete(channelId);
      expect(await certificate()).toMatchObject({ eligible: true, reasons: [] });
      receiptCanonical = false;
      expect(await certificate()).toMatchObject({ eligible: false,
        reasons: expect.arrayContaining(["tempo_channel_evidence_unresolved"]) });
    } finally {
      rpc.mockRestore();
      await pool.query("DELETE FROM credit_draws WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM mpp_tempo_close_intents WHERE channel_id=$1", [channelId]);
      await pool.query("DELETE FROM mpp_tempo_channel_tombstones WHERE channel_key=$1", [channelId]);
      await pool.query("DELETE FROM mpp_tempo_channels WHERE channel_key=$1", [channelId]);
      await pool.query("DELETE FROM sdk_hosted_settlement_report_obligations WHERE dvm_id=$1",
        [fixture?.dvmId ?? ""]);
      await fixture?.cleanup();
    }
  });

  it("retains the first hosted x402 chain binding across concurrent first writes and later updates", async () => {
    const channelId = `0x${"ce".repeat(32)}`;
    const sepolia = new PostgresX402ChannelStorage(pool, { hostedNetwork: "eip155:84532" });
    const mainnet = new PostgresX402ChannelStorage(pool, { hostedNetwork: "eip155:8453" });
    const state: Channel = {
      channelId,
      channelConfig: { payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"11".repeat(20)}`,
        receiver: `0x${"22".repeat(20)}`, receiverAuthorizer: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`, withdrawDelay: 86_400,
        salt: `0x${"44".repeat(32)}` },
      chargedCumulativeAmount: "0", signedMaxClaimable: "0", signature: "0x",
      balance: "0", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0,
      lastRequestTimestamp: 1,
    };
    try {
      await Promise.all([sepolia.init(), mainnet.init()]);
      await Promise.all([sepolia.updateChannel(channelId, () => state),
        mainnet.updateChannel(channelId, () => state)]);
      const binding = await pool.query<{ hosting_binding: { network: string; chainId: number;
        channelId: string; contract: string; version: string } }>(
        "SELECT hosting_binding FROM x402_batch_channels WHERE channel_id=$1", [channelId]
      );
      const original = binding.rows[0].hosting_binding;
      expect(["eip155:84532", "eip155:8453"]).toContain(original.network);
      expect(original).toMatchObject({ channelId, contract: BATCH_SETTLEMENT_ADDRESS.toLowerCase(),
        version: "x402-batch-settlement-v1", chainId: Number(original.network.split(":")[1]) });
      const other = original.network === "eip155:84532" ? mainnet : sepolia;
      expect((await other.updateChannel(channelId, (current) => ({ ...current!, lastRequestTimestamp: 2 }))).status)
        .toBe("updated");
      const after = await pool.query<{ hosting_binding: typeof original }>(
        "SELECT hosting_binding FROM x402_batch_channels WHERE channel_id=$1", [channelId]
      );
      expect(after.rows[0].hosting_binding).toEqual(original);
    } finally {
      await pool.query("DELETE FROM x402_batch_channels WHERE channel_id=$1", [channelId]);
      await Promise.all([sepolia.close(), mainnet.close()]);
    }
  });

  it("keeps a sole host ineligible while any DVM report remains durable", async () => {
    const fixture = await scope();
    const reporter = new RevenueReporter(pool, "https://example.com", "test-token");
    try {
      const command = await fixture.close();
      const certificate = () => fixture.control.certificate({ ...command, action: "certificate" }, support);
      expect(await certificate()).toMatchObject({ complete: true, eligible: true });

      const payoutId = `payout-${randomUUID()}`;
      await reporter.enqueuePayout({
        dvmId: `foreign-${randomUUID()}`, payoutId, rail: "x402", kind: "batch",
        nativeAmount: 1, nativeAsset: "usdc", recipient: "0xpayto", refs: {},
        landedAt: Date.now(),
      });
      expect(await certificate()).toMatchObject({ complete: false, eligible: false,
        reasons: expect.arrayContaining(["reports_pending_or_unowned"]) });

      const deliver = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
      try {
        await reporter.drainPending();
        expect(deliver).toHaveBeenCalledTimes(1);
      } finally {
        deliver.mockRestore();
      }
      const delivered = await pool.query<{ n: string }>(
        "SELECT COUNT(*)::text AS n FROM pending_dvm_reports WHERE payload->>'payoutId'=$1",
        [payoutId]
      );
      expect(delivered.rows[0].n).toBe("0");
      expect(await certificate()).toMatchObject({ complete: true, eligible: true });
    } finally {
      await fixture.cleanup();
    }
  });

  it.each(["current", "malformed"] as const)("blocks a %s durable report", async (kind) => {
    const fixture = await scope();
    const reportId = randomUUID();
    try {
      const command = await fixture.close();
      await pool.query(
        "INSERT INTO pending_dvm_reports (id,payload,created_at,kind) VALUES ($1,$2,$3,'revenue')",
        [reportId, JSON.stringify({ dvmId: kind === "current" ? fixture.dvmId : false }), Date.now()]
      );
      expect(await fixture.control.certificate({ ...command, action: "certificate" }, support))
        .toMatchObject({ complete: false, eligible: false,
          reasons: expect.arrayContaining(["reports_pending_or_unowned"]) });
    } finally {
      await pool.query("DELETE FROM pending_dvm_reports WHERE id=$1", [reportId]);
      await fixture.cleanup();
    }
  });

  it("accepts only the original top-up artifact after closure and refuses a fresh intent", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const artifact = "a".repeat(64);
    try {
      expect(await fixture.control.admit(admissionId, `credit-fund:${creditId}:${fundId}`, {
        creditId, fundId, callerPubkey: "caller", fundingCommitment: "commitment",
        paymentArtifactHash: artifact,
      })).toBe(true);
      const command = await fixture.close();
      await expect(fixture.control.cleanupFence.withNewIntent({
        admissionId, creditId, fundId, callerPubkey: "caller",
        fundingCommitment: "commitment", paymentArtifactHash: artifact,
      }, async () => "continued")).resolves.toBe("continued");
      await expect(fixture.control.cleanupFence.withNewIntent({
        admissionId, creditId, fundId, callerPubkey: "caller",
        fundingCommitment: "commitment", paymentArtifactHash: "b".repeat(64),
      }, async () => "wrong")).rejects.toThrow("no pre-closure admission");
      await expect(fixture.control.cleanupFence.withNewIntent(undefined,
        async () => "new")).rejects.toThrow("closed to new intents");
      expect(await fixture.control.transition({
        action: "resume", version: 2, dvmId: fixture.dvmId, scope: fixture.deployment,
        generation: 3, leaseExpiresAtMs: Date.now() + 60_000,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
      })).toBe("conflict");
      const evidence = await fixture.control.certificate({ ...command, action: "certificate" }, support);
      expect(evidence?.eligible).toBe(false);
      expect(evidence?.reasons).toContain("admissions_unresolved");
      await fixture.control.finishAdmission(admissionId, "accepted");
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.eligible)
        .toBe(false);
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("funding_intents_unbooked");
      await expect(fixture.control.cleanupFence.withNewIntent({
        admissionId, creditId, fundId, callerPubkey: "caller",
        fundingCommitment: "commitment", paymentArtifactHash: artifact,
      }, async () => "late duplicate")).rejects.toThrow("no pre-closure admission");
    } finally {
      await fixture.cleanup();
    }
  });

  it("binds late mid-job settlement to its pending message and exact challenge", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const jobId = `job-${randomUUID()}`;
    const challengeId = `challenge-${randomUUID()}`;
    const jobTime = Date.now();
    try {
      expect(await fixture.control.admit(admissionId, jobId)).toBe(true);
      await pool.query(
        `INSERT INTO jobs (id,input,requester_id,created_at,last_activity_at,dvm_id)
         VALUES ($1,'','caller',$2,$2,$3)`, [jobId, jobTime, fixture.dvmId]
      );
      await pool.query(
        `INSERT INTO job_messages (job_id,seq,data,status,created_at_ms)
         VALUES ($1,1,$2,'pending-verification',
           FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)`,
        [jobId, JSON.stringify({ type: "payment", content: { tempo_credential: {
          challenge: { id: challengeId },
        } } })]
      );
      await fixture.close();
      await expect(fixture.control.cleanupFence.withNewIntent({
        jobId, paymentSeq: 1, challengeId,
      }, async () => "accepted")).resolves.toBe("accepted");
      await expect(fixture.control.cleanupFence.withNewIntent({
        jobId, paymentSeq: 1, challengeId: "different",
      }, async () => "wrong")).rejects.toThrow("no pre-closure inbound intent");
      await pool.query("UPDATE jobs SET status='cancelled' WHERE id=$1", [jobId]);
      expect(await jobStore.redactJob({
        jobId, expectedLastActivityAt: jobTime, redactedAt: jobTime + 1000,
      })).toBe(false);
      await pool.query("UPDATE job_messages SET status='verified' WHERE job_id=$1", [jobId]);
      await expect(fixture.control.cleanupFence.withNewIntent({
        jobId, paymentSeq: 1, challengeId,
      }, async () => "late")).rejects.toThrow("no pre-closure inbound intent");
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists admitted jobs and terminal recovery after closure without admitting a fresh job", async () => {
    const fixture = await scope();
    const now = Date.now();
    const job = (id: string): JobRecord => ({
      id, tags: [], capability: "test", input: "", params: {}, requesterId: "caller",
      status: "processing", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
      stepCache: [], state: {}, createdAt: now, lastActivityAt: now,
    });
    const existing = job(`existing-${randomUUID()}`);
    const late = job(`late-${randomUUID()}`);
    try {
      expect(await fixture.control.admit(randomUUID(), existing.id)).toBe(true);
      expect(await fixture.control.admit(randomUUID(), late.id)).toBe(true);
      await jobStore.saveForDvm(existing, fixture.dvmId);
      await fixture.close();
      await jobStore.saveForDvm({ ...existing, status: "cancelled", summary: "closed" }, fixture.dvmId);
      expect((await jobStore.get(existing.id))?.status).toBe("cancelled");
      await jobStore.saveForDvm(late, fixture.dvmId);
      expect((await jobStore.get(late.id))?.status).toBe("processing");
      await expect(jobStore.saveForDvm(job(`fresh-${randomUUID()}`), fixture.dvmId))
        .rejects.toThrow("no pre-closure admission");
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps an opaque Tempo charge unresolved until the matching ledger marker commits", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const challengeId = `charge-${randomUUID()}`;
    const jobId = `job-${randomUUID()}`;
    const credential = Credential.serialize({
      challenge: { id: challengeId, method: "tempo", intent: "charge",
        realm: "test.example", request: { amount: "0" } },
      payload: { type: "proof", signature: "0x" },
    });
    const artifactHash = createHash("sha256").update(credential).digest("hex");
    const replayKey = `mppx:charge:proof:${challengeId}`;
    const wrongKey = `mppx:charge:proof:unrelated-${randomUUID()}`;
    const wrongSponsorKey = `mppx:charge:sponsor-budget:42431:0x${"ab".repeat(20)}`;
    const priorKey = `mppx:charge:proof:prior-${randomUUID()}`;
    const chargeStore = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    chargeStore.useHostingCleanupFence(fixture.control.cleanupFence);
    try {
      expect(await fixture.control.admit(admissionId, jobId, {
        paymentArtifactHash: artifactHash,
      })).toBe(true);
      await chargeStore.put(priorKey, 1);
      await fixture.close();
      await expect(chargeStore.put(replayKey, 1)).rejects.toThrow("closed to new intents");
      await chargeStore.reserveHostedCharge(credential, {
        admissionId, jobId, paymentArtifactHash: artifactHash,
      });
      await expect(chargeStore.put(wrongKey, 1)).rejects.toThrow("closed to new intents");
      await expect(chargeStore.put(wrongSponsorKey, { version: 1, reservations: {} }))
        .rejects.toThrow("closed to new intents");
      await expect(chargeStore.put(priorKey, 2)).rejects.toThrow("closed to new intents");
      await expect(chargeStore.put(replayKey, 1)).resolves.toBeUndefined();
      await chargeStore.completeHostedCharge(challengeId);
      const pending = await pool.query<{ status: string }>(
        "SELECT status FROM sdk_hosted_tempo_charge_intents WHERE challenge_id=$1", [challengeId]
      );
      expect(pending.rows[0].status).toBe("pending");
      await pool.query(
        `INSERT INTO processed_payments (dvm_id,rail,payment_id,credit_id,draw_id,job_id,created_at)
         VALUES ($1,'tempo',$2,$3,$4,$5,$6)`,
        [fixture.dvmId,challengeId,"credit","draw",jobId,Date.now()]
      );
      await chargeStore.completeHostedCharge(challengeId);
      const complete = await pool.query<{ status: string }>(
        "SELECT status FROM sdk_hosted_tempo_charge_intents WHERE challenge_id=$1", [challengeId]
      );
      expect(complete.rows[0].status).toBe("complete");
    } finally {
      await pool.query("DELETE FROM mpp_tempo_charge_replays WHERE store_key=ANY($1::text[])",
        [[replayKey, priorKey]]);
      await fixture.cleanup();
    }
  });

  it("binds hash and transaction replay keys to their original credentials", async () => {
    const fixture = await scope();
    const chargeStore = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    chargeStore.useHostingCleanupFence(fixture.control.cleanupFence);
    const cases = [
      { payload: { type: "hash", hash: `0x${"AB".repeat(32)}` },
        key: `mppx:charge:0x${"ab".repeat(32)}` },
      { payload: { type: "transaction", signature: "0x76aabb" },
        key: `mppx:charge:${keccak256("0x76aabb")}` },
    ];
    const keys: string[] = [];
    try {
      const reservations = cases.map(({ payload, key }) => {
        const admissionId = randomUUID();
        const jobId = `job-${randomUUID()}`;
        const credential = Credential.serialize({
          challenge: { id: `charge-${randomUUID()}`, method: "tempo", intent: "charge",
            realm: "test.example", request: { amount: "1" } }, payload,
        });
        const artifactHash = createHash("sha256").update(credential).digest("hex");
        keys.push(key);
        return { admissionId, jobId, credential, artifactHash, key };
      });
      for (const reservation of reservations) {
        expect(await fixture.control.admit(reservation.admissionId, reservation.jobId, {
          paymentArtifactHash: reservation.artifactHash,
        })).toBe(true);
      }
      await fixture.close();
      for (const reservation of reservations) {
        await chargeStore.reserveHostedCharge(reservation.credential, {
          admissionId: reservation.admissionId, jobId: reservation.jobId,
        });
        await expect(chargeStore.put(reservation.key, 1)).resolves.toBeUndefined();
      }
      await expect(chargeStore.put(`mppx:charge:0x${"cd".repeat(32)}`, 1))
        .rejects.toThrow("closed to new intents");
    } finally {
      await pool.query("DELETE FROM mpp_tempo_charge_replays WHERE store_key=ANY($1::text[])", [keys]);
      await fixture.cleanup();
    }
  });

  it("refuses a changed mid-job proof with the recorded challenge and replay key", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const jobId = `job-${randomUUID()}`;
    const challengeId = `charge-${randomUUID()}`;
    const original = {
      challenge: { id: challengeId, method: "tempo", intent: "charge",
        realm: "test.example", request: { amount: "0" } },
      payload: { type: "proof", signature: "0x11" },
      source: "did:pkh:eip155:42431:0x1111111111111111111111111111111111111111",
    };
    const originalSerialized = Credential.serialize(original);
    const replayKey = `mppx:charge:proof:${challengeId}`;
    const chargeStore = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    chargeStore.useHostingCleanupFence(fixture.control.cleanupFence);
    try {
      expect(await fixture.control.admit(admissionId, jobId)).toBe(true);
      const now = Date.now();
      await jobStore.saveForDvm({
        id: jobId, tags: [], capability: "test", input: "", params: {}, requesterId: "caller",
        status: "awaiting-input", messages: [], seq: 0, paidMsats: 0, receivedProofs: [],
        stepCache: [], state: {}, createdAt: now, lastActivityAt: now,
      }, fixture.dvmId);
      const paymentSeq = await jobStore.recordInbound(jobId, {
        from: "requester", type: "payment", timestamp: Math.floor(now / 1000),
        content: { tempo_credential: original },
      });
      await fixture.close();
      for (const changed of [
        { ...original, source: "did:pkh:eip155:42431:0x2222222222222222222222222222222222222222" },
        { ...original, payload: { ...original.payload, signature: "0x22" } },
      ]) {
        await expect(chargeStore.reserveHostedCharge(Credential.serialize(changed), {
          jobId, paymentSeq,
        })).rejects.toThrow("differs from the original inbound payment");
      }
      await chargeStore.reserveHostedCharge(originalSerialized, { jobId, paymentSeq });
      await chargeStore.reserveHostedCharge(originalSerialized, { jobId, paymentSeq });
      await expect(chargeStore.put(replayKey, 1)).resolves.toBeUndefined();
    } finally {
      await pool.query("DELETE FROM mpp_tempo_charge_replays WHERE store_key=$1", [replayKey]);
      await fixture.cleanup();
    }
  });

  it("initializes while closure holds control before updating admission deadlines", async () => {
    const fixture = await scope();
    const admissionId = randomUUID();
    const jobId = `job-${randomUUID()}`;
    const appName = `sdk_close_race_${randomUUID().slice(0, 8)}`;
    const closePool = new pg.Pool({ connectionString: DATABASE_URL,
      options: `-c search_path=${schema}` });
    const initPool = new pg.Pool({ connectionString: DATABASE_URL,
      options: `-c search_path=${schema} -c application_name=${appName}` });
    let releaseClose!: () => void;
    const closeMayContinue = new Promise<void>((resolve) => { releaseClose = resolve; });
    let reportLocked!: (pid: number) => void;
    const controlLocked = new Promise<number>((resolve) => { reportLocked = resolve; });
    const connect = closePool.connect.bind(closePool);
    closePool.connect = (async () => {
      const client = await connect();
      const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const query = client.query.bind(client) as (sql: string, values?: unknown[]) => Promise<unknown>;
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, values?: unknown[]) => {
          const result = await query(sql, values);
          if (sql.includes("FROM sdk_hosting_control") && sql.includes("FOR UPDATE")) {
            reportLocked(pid.rows[0].pid);
            await closeMayContinue;
          }
          return result;
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
    }) as typeof closePool.connect;
    let close: Promise<"ok" | "conflict"> | undefined;
    let init: Promise<void> | undefined;
    try {
      expect(await fixture.control.admit(admissionId, jobId)).toBe(true);
      const command: HostingClosureCommand = {
        version: 3, action: "close", dvmId: fixture.dvmId, scope: fixture.deployment,
        generation: 2, operationId: `operation_${randomUUID().replaceAll("-", "")}`,
        timestampMs: Date.now(), nonce: `nonce_${randomUUID().replaceAll("-", "")}`,
      };
      close = new HostingControl(closePool, fixture.dvmId, {
        secret, scope: fixture.deployment,
      }).close(command, support);
      const closePid = await controlLocked;
      init = new HostingControl(initPool, fixture.dvmId, {
        secret, scope: fixture.deployment,
      }).init();
      let observed: { admissions_locked: boolean } | undefined;
      const until = Date.now() + 5_000;
      while (Date.now() < until) {
        const blocked = await adminPool.query<{ admissions_locked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
             JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE l.pid=a.pid AND l.granted AND l.mode='AccessExclusiveLock'
               AND n.nspname=$3 AND c.relname='sdk_hosting_admissions') AS admissions_locked
           FROM pg_stat_activity a WHERE a.datname=current_database()
             AND a.application_name=$1 AND a.wait_event_type='Lock'
             AND $2=ANY(pg_blocking_pids(a.pid))
             AND a.query LIKE '%CREATE TABLE IF NOT EXISTS sdk_hosting_control%'`,
          [appName, closePid, schema]
        );
        if (blocked.rows[0]) { observed = blocked.rows[0]; break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observed, "init DDL blocked by the closure's control lock").toBeDefined();
      expect(observed?.admissions_locked, "init must not hold admissions before control")
        .toBe(false);
      releaseClose();
      expect(await close).toBe("ok");
      await init;
      const terminal = await pool.query<{ state: string; generation: string;
        deadline_ms: string; drain_deadline_ms: string }>(
        `SELECT c.state,c.generation,c.deadline_ms,a.drain_deadline_ms
         FROM sdk_hosting_control c JOIN sdk_hosting_admissions a
           ON a.dvm_id=c.dvm_id AND a.scope=c.scope
         WHERE a.id=$1`, [admissionId]
      );
      expect(terminal.rows[0]).toMatchObject({ state: "closed", generation: "2" });
      expect(terminal.rows[0].drain_deadline_ms).toBe(terminal.rows[0].deadline_ms);
    } finally {
      releaseClose();
      await Promise.allSettled([close, init].filter(Boolean) as Promise<unknown>[]);
      await Promise.all([closePool.end(), initPool.end()]);
      await fixture.cleanup();
    }
  }, 15_000);

  it("rejects a direct post-closure x402 channel write but allows the exact preclosure funding", async () => {
    const fixture = await scope();
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const admissionId = randomUUID();
    const channelId = `0x${"ab".repeat(32)}`;
    const artifact = "b".repeat(64);
    const settlementId = `settlement-${randomUUID()}`;
    const state: Channel = {
      channelId,
      channelConfig: {
        payer: "0x1111111111111111111111111111111111111111",
        payerAuthorizer: "0x1111111111111111111111111111111111111111",
        receiver: "0x2222222222222222222222222222222222222222",
        receiverAuthorizer: "0x2222222222222222222222222222222222222222",
        token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        withdrawDelay: 86_400, salt: `0x${"44".repeat(32)}`,
      },
      chargedCumulativeAmount: "1", signedMaxClaimable: "1",
      signature: `0x${"55".repeat(65)}`, balance: "1", totalClaimed: "0",
      withdrawRequestedAt: 0, refundNonce: 0, onchainSyncedAt: Date.now(),
      lastRequestTimestamp: Date.now(),
    };
    const reservation = { admissionId, creditId, fundId, callerPubkey: "caller",
      commitment: "commitment", paymentArtifactHash: artifact };
    try {
      expect(await fixture.control.admit(admissionId, `credit-fund:${creditId}:${fundId}`, {
        creditId, fundId, callerPubkey: "caller", fundingCommitment: "commitment",
        paymentArtifactHash: artifact,
      })).toBe(true);
      x402Storage.useHostingCleanupFence(fixture.control.cleanupFence);
      const command = await fixture.close();
      await expect(x402Storage.updateChannel(channelId, () => state))
        .rejects.toThrow("closed to new intents");
      await expect(x402Storage.withChannelTransaction(channelId,
        () => x402Storage.updateChannel(channelId, () => state),
        { ...reservation, paymentArtifactHash: "c".repeat(64) }))
        .rejects.toThrow("no pre-closure admission");
      await x402Storage.withChannelTransaction(channelId,
        () => x402Storage.updateChannel(channelId, () => state), reservation);
      expect((await x402Storage.get(channelId))?.chargedCumulativeAmount).toBe("1");
      const requirements: PaymentRequirements = {
        scheme: "batch-settlement", network: "eip155:84532", asset: state.channelConfig.token,
        amount: "1", payTo: state.channelConfig.receiver, maxTimeoutSeconds: 60, extra: {},
      };
      const payload = { x402Version: 2, accepted: requirements,
        payload: { type: "deposit", channelConfig: state.channelConfig,
          voucher: { channelId, maxClaimableAmount: "1", signature: state.signature } },
      } as PaymentPayload;
      expect((await x402Storage.prepareSettlement({ settlementId, channelId, operation: "fund",
        effectId: `${creditId}:${fundId}`, paymentId: `payment-${randomUUID()}`,
        payload, requirements, channelBefore: state }, reservation)).status).toBe("prepared");
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("x402_channel_evidence_unresolved");
    } finally {
      await pool.query("DELETE FROM x402_batch_settlements WHERE settlement_id=$1", [settlementId]);
      x402Storage.useHostingCleanupFence(fixture.control.cleanupFence);
      await x402Storage.updateChannel(channelId, () => undefined);
      await pool.query("DELETE FROM x402_batch_channel_tombstones WHERE channel_id=$1", [channelId]);
      await fixture.cleanup();
    }
  });

  it("refuses a new Tempo session after closure while retaining an existing session for recovery", async () => {
    const fixture = await scope();
    const existing = `0x${"12".repeat(32)}`;
    const fresh = `0x${"13".repeat(32)}`;
    const state = (channelId: string) => ({ channelId, highestVoucherAmount: 0n,
      settledOnChain: 0n, spent: 0n, deposit: 1n, finalized: false });
    try {
      tempoSessions.useHostingCleanupFence(fixture.control.cleanupFence);
      await tempoSessions.put(existing, state(existing));
      const command = await fixture.close();
      await expect(tempoSessions.put(fresh, state(fresh)))
        .rejects.toThrow("closed to new intents");
      await tempoSessions.put(existing, { ...state(existing), spent: 1n });
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("tempo_channel_evidence_unresolved");
    } finally {
      await pool.query("DELETE FROM mpp_tempo_channels WHERE channel_key=$1", [existing]);
      await fixture.cleanup();
    }
  });

  it("credits a paid original Lightning invoice after closure and refuses an unbound extra funding", async () => {
    const fixture = await scope();
    const ledger = new CreditLedger(pool);
    ledger.useHostingCleanupFence(fixture.control.cleanupFence);
    const creditId = `credit-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const paymentHash = `hash-${randomUUID()}`;
    const admissionId = randomUUID();
    try {
      expect(await fixture.control.admit(admissionId, `credit-fund:${creditId}:${fundId}`, {
        creditId, fundId, callerPubkey: "caller",
      })).toBe(true);
      await ledger.recordInvoice({ creditId, fundId, callerPubkey: "caller", currency: "usd",
        amountMicro: 100_000, amountMsats: 10_000, paymentHash, bolt11: "test-invoice",
        expiresAt: Date.now() + 60_000 });
      await fixture.control.finishAdmission(admissionId, "accepted");
      const command = await fixture.close();
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("invoices_unresolved");
      await expect(ledger.recordFunding({ creditId, fundId, amountMicro: 200_000,
        rail: "lightning", hostingInvoicePaymentHash: paymentHash,
        hostingCallerPubkey: "caller" })).rejects.toThrow("original locked transaction");
      const settled = await ledger.settleInvoice({ creditId, fundId,
        expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning", paidMsats: 10_000, fundingRef: paymentHash } });
      expect(settled.replayed).toBe(false);
      expect(settled.credit?.availableMicro).toBe(100_000);
      expect((await ledger.settleInvoice({ creditId, fundId, expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning", paidMsats: 10_000, fundingRef: paymentHash } })).replayed)
        .toBe(true);
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.liabilities)
        .toEqual([{ currency: "usd", amountMicro: "100000" }]);
    } finally {
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credit_invoices WHERE credit_id=$1", [creditId]);
      await fixture.cleanup();
    }
  });

  it("recovers a paid historical invoice while keeping its cleanup ownership unknown", async () => {
    const fixture = await scope();
    const ledger = new CreditLedger(pool);
    ledger.useHostingCleanupFence(fixture.control.cleanupFence);
    const creditId = `legacy-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const paymentHash = `hash-${randomUUID()}`;
    const lateCreditId = `late-${randomUUID()}`;
    const lateFundId = `fund-${randomUUID()}`;
    const lateHash = `hash-${randomUUID()}`;
    try {
      await pool.query(
        `INSERT INTO credit_invoices
         (credit_id,fund_id,caller_pubkey,currency,amount_micro,amount_msats,
          payment_hash,bolt11,status,expires_at,created_at)
         VALUES ($1,$2,'caller','usd',100000,10000,$3,'test-invoice','pending',$4,$5)`,
        [creditId, fundId, paymentHash, Date.now() + 60_000, Date.now()]
      );
      const command = await fixture.close();
      await pool.query(
        `INSERT INTO credit_invoices
         (credit_id,fund_id,caller_pubkey,currency,amount_micro,amount_msats,
          payment_hash,bolt11,status,expires_at,created_at)
         VALUES ($1,$2,'caller','usd',100000,10000,$3,'late-invoice','pending',$4,$5)`,
        [lateCreditId, lateFundId, lateHash, Date.now() + 60_000, Date.now()]
      );
      await expect(ledger.settleInvoice({ creditId: lateCreditId, fundId: lateFundId,
        expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning", paidMsats: 10_000, fundingRef: lateHash } }))
        .rejects.toThrow("no original payable admission");
      const recovered = await ledger.settleInvoice({ creditId, fundId,
        expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning", paidMsats: 10_000, fundingRef: paymentHash } });
      expect(recovered.credit?.availableMicro).toBe(100_000);
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("historical_invoice_owner_unknown");
    } finally {
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credit_invoices WHERE credit_id=$1", [creditId]);
      await pool.query("DELETE FROM credit_invoices WHERE credit_id=$1", [lateCreditId]);
      await fixture.cleanup();
    }
  });

  it("preserves blocked-invoice repair after closure without opening a new funding key", async () => {
    const fixture = await scope();
    const ledger = new CreditLedger(pool);
    ledger.useHostingCleanupFence(fixture.control.cleanupFence);
    const originalCreditId = `invoice-${randomUUID()}`;
    const targetCreditId = `repair-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const paymentHash = `hash-${randomUUID()}`;
    const admissionId = randomUUID();
    try {
      expect(await fixture.control.admit(admissionId,
        `credit-fund:${originalCreditId}:${fundId}`, {
          creditId: originalCreditId, fundId, callerPubkey: "caller",
        })).toBe(true);
      await ledger.recordInvoice({ creditId: originalCreditId, fundId,
        callerPubkey: "caller", currency: "usd", amountMicro: 100_000,
        amountMsats: 10_000, paymentHash, bolt11: "test-invoice",
        expiresAt: Date.now() + 60_000 });
      await ledger.markInvoiceBlocked({ creditId: originalCreditId, fundId,
        reason: "verified payment needs operator repair" });
      await fixture.control.finishAdmission(admissionId, "accepted");
      const command = await fixture.close();
      const args = { paymentHash, targetCreditId, expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning" as const, paidMsats: 10_000, fundingRef: paymentHash } };
      const repaired = await ledger.reconcileBlockedInvoice(args);
      expect(repaired.replayed).toBe(false);
      expect(repaired.credit?.availableMicro).toBe(100_000);
      expect((await ledger.reconcileBlockedInvoice(args)).replayed).toBe(true);
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.liabilities)
        .toEqual([{ currency: "usd", amountMicro: "100000" }]);
    } finally {
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [targetCreditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [targetCreditId]);
      await pool.query("DELETE FROM credit_invoices WHERE credit_id=$1", [originalCreditId]);
      await fixture.cleanup();
    }
  });

  it("repairs a blocked historical invoice but never certifies its missing owner", async () => {
    const fixture = await scope();
    const ledger = new CreditLedger(pool);
    ledger.useHostingCleanupFence(fixture.control.cleanupFence);
    const originalCreditId = `old-${randomUUID()}`;
    const targetCreditId = `repair-${randomUUID()}`;
    const fundId = `fund-${randomUUID()}`;
    const paymentHash = `hash-${randomUUID()}`;
    try {
      await pool.query(
        `INSERT INTO credit_invoices
         (credit_id,fund_id,caller_pubkey,currency,amount_micro,amount_msats,
          payment_hash,bolt11,status,expires_at,created_at)
         VALUES ($1,$2,'caller','usd',100000,10000,$3,'old-invoice','blocked',$4,$5)`,
        [originalCreditId, fundId, paymentHash, Date.now() + 60_000, Date.now()]
      );
      const command = await fixture.close();
      const repaired = await ledger.reconcileBlockedInvoice({ paymentHash, targetCreditId,
        expiryMs: Date.now() + 86_400_000,
        basis: { rail: "lightning", paidMsats: 10_000, fundingRef: paymentHash } });
      expect(repaired.credit?.availableMicro).toBe(100_000);
      expect((await fixture.control.certificate({ ...command, action: "certificate" }, support))?.reasons)
        .toContain("historical_invoice_owner_unknown");
    } finally {
      await pool.query("DELETE FROM credit_fundings WHERE credit_id=$1", [targetCreditId]);
      await pool.query("DELETE FROM credits WHERE credit_id=$1", [targetCreditId]);
      await pool.query("DELETE FROM credit_invoices WHERE credit_id=$1", [originalCreditId]);
      await fixture.cleanup();
    }
  });
});
