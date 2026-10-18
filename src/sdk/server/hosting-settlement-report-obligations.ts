import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import { Session as TempoSession } from "mppx/tempo";
import type { Pool, PoolClient } from "pg";
import { createPublicClient, decodeEventLog, decodeFunctionData, encodeFunctionData, http, parseAbiItem, toFunctionSelector } from "viem";

import { loggers } from "../../observability/loggers";
import { resolveRpcOverride } from "../../lib/payment-rails/rpc";
import { X402_BATCH_CHANNEL_ABI } from "../../lib/x402/batch-abi";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import { withSdkInitLock } from "./init-lock";
import { parseStoreValue } from "./store-json";
import type { PostgresX402ChannelStorage } from "./x402-channel-store";

type Query = Pick<Pool | PoolClient, "query">;
type Rail = "x402" | "tempo";
type Operation = "claim" | "refund" | "settle" | "close";
type State = "reserved" | "observed" | "report_queued" | "delivered" | "no_report" | "exhausted" | "unmatched";

export const HOSTED_SETTLEMENT_UNRESOLVED_SQL = `state NOT IN ('delivered','no_report')
  OR (rail='x402' AND operation IN ('claim','refund')
      AND COALESCE(original->>'authorizationCallData','') !~* '^0x([0-9a-f]{2})+$')`;

// Keep operator capability flags and their state transitions on the same SQL predicates.
const TEMPO_CLOSE_RETRYABLE_SQL = `target.rail='tempo' AND target.operation='close'
  AND target.state IN ('unmatched','no_report') AND target.tx_hash IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM sdk_hosted_settlement_report_obligations other
    WHERE other.dvm_id=target.dvm_id AND other.scope=target.scope
      AND other.rail='tempo' AND other.operation='close' AND other.channel_id=target.channel_id
      AND other.id<>target.id AND (other.state<>'no_report' OR other.tx_hash IS NOT NULL)
  )`;
const TEMPO_CLOSE_WRITE_OFF_ALLOWED_SQL = `target.rail='tempo' AND target.operation='close'
  AND target.state='unmatched' AND target.tx_hash IS NULL`;

interface ObligationRow {
  id: string;
  source_key: string;
  dvm_id: string;
  scope: string;
  instance_id: string;
  boot_epoch: string;
  rail: Rail;
  operation: Operation;
  network: string;
  contract: string;
  channel_id: string;
  original: Record<string, unknown>;
  state: State;
  tx_hash: string | null;
  block_number: string | null;
  block_hash: string | null;
  delta_native: string | null;
  payout_id: string | null;
  report_id: string | null;
  report_payload: Record<string, unknown> | null;
}

export interface HostedEffectReservation {
  id: string;
  replayed: boolean;
}

export interface HostedObservedEffect {
  id: string;
  txHash: string;
  blockNumber: string;
  blockHash: string;
  deltaNative: string;
}

export interface HostedRecoverableEffect {
  id: string;
  rail: Rail;
  operation: Operation;
  channelId: string;
  txHash: string;
  batchId?: string;
  reportId: string | null;
  blockHash: string | null;
  deltaNative: string | null;
}

interface X402Config { network: string; rpcUrl?: string; receiver: string; token: string }
interface TempoConfig { network: string; rpcUrl?: string; escrow: string; payee: string; token: string }

const X402_SETTLED_EVENT = parseAbiItem(
  "event Settled(address indexed receiver,address indexed token,address indexed sender,uint128 amount)"
);
const X402_REFUNDED_EVENT = parseAbiItem(
  "event Refunded(bytes32 indexed channelId,address indexed sender,uint128 amount)"
);
const X402_CLAIM_ABI = [{ type: "function", name: "claimWithSignature", stateMutability: "nonpayable",
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
const X402_REFUND_ABI = [{ type: "function", name: "refundWithSignature", stateMutability: "nonpayable",
  inputs: [
    { name: "config", type: "tuple", components: X402_CLAIM_ABI[0].inputs[0].components[0].components[0].components },
    { name: "amount", type: "uint128" }, { name: "nonce", type: "uint256" },
    { name: "receiverAuthorizerSignature", type: "bytes" },
  ], outputs: [],
}] as const;
const X402_MULTICALL_ABI = [{ type: "function", name: "multicall", stateMutability: "nonpayable",
  inputs: [{ name: "data", type: "bytes[]" }], outputs: [{ name: "results", type: "bytes[]" }],
}] as const;
const TEMPO_SETTLED_EVENT = TempoSession.Precompile.escrowAbi.find((item) =>
  item.type === "event" && item.name === "Settled"
);
const TEMPO_CLOSED_EVENT = TempoSession.Precompile.escrowAbi.find((item) =>
  item.type === "event" && item.name === "ChannelClosed"
);

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hex(value: unknown, bytes: number): value is `0x${string}` {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

function signedBytes(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) {
    throw new Error("Hosted x402 authorization signature is unavailable before settlement");
  }
  return value as `0x${string}`;
}

function uint(value: unknown): bigint {
  if ((typeof value !== "string" || !/^\d+$/.test(value)) &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) &&
    (typeof value !== "bigint" || value < 0n)) {
    throw new Error("Hosted x402 authorization has an invalid unsigned amount");
  }
  return BigInt(value);
}

function contractChannel(value: unknown) {
  const channel = value as Record<string, unknown> | null;
  if (!channel || !hex(channel.payer, 20) || !hex(channel.payerAuthorizer, 20) ||
    !hex(channel.receiver, 20) || !hex(channel.receiverAuthorizer, 20) ||
    !hex(channel.token, 20) || !hex(channel.salt, 32)) {
    throw new Error("Hosted x402 authorization has no original channel config");
  }
  const withdrawDelay = uint(channel.withdrawDelay);
  if (withdrawDelay > (1n << 40n) - 1n) {
    throw new Error("Hosted x402 authorization has an invalid withdrawal delay");
  }
  return { payer: channel.payer, payerAuthorizer: channel.payerAuthorizer,
    receiver: channel.receiver, receiverAuthorizer: channel.receiverAuthorizer,
    token: channel.token, withdrawDelay: Number(withdrawDelay), salt: channel.salt };
}

function authorizationCallData(operation: "claim" | "refund",
  payload: Record<string, unknown>): `0x${string}` {
  if (payload.type !== operation) throw new Error("Hosted x402 authorization operation changed");
  const rawClaims = payload.claims;
  if (!Array.isArray(rawClaims) || (operation === "claim" && !rawClaims.length) ||
    (operation === "refund" && rawClaims.length > 1)) {
    throw new Error("Hosted x402 authorization has no exact original claim set");
  }
  const claims = rawClaims.map((raw) => {
    const claim = raw as Record<string, unknown>;
    const voucher = claim?.voucher as Record<string, unknown> | undefined;
    if (!voucher) throw new Error("Hosted x402 authorization has no original voucher");
    return { voucher: { channel: contractChannel(voucher.channel),
      maxClaimableAmount: uint(voucher.maxClaimableAmount) },
      signature: signedBytes(claim.signature), totalClaimed: uint(claim.totalClaimed) };
  });
  const claimData = claims.length ? encodeFunctionData({ abi: X402_CLAIM_ABI,
    functionName: "claimWithSignature", args: [claims,
      signedBytes(payload.claimAuthorizerSignature)] }) : undefined;
  if (operation === "claim") return claimData!;
  const refundData = encodeFunctionData({ abi: X402_REFUND_ABI,
    functionName: "refundWithSignature",
    args: [contractChannel(payload.channelConfig), uint(payload.amount),
      uint(payload.refundNonce), signedBytes(payload.refundAuthorizerSignature)] });
  return claimData ? encodeFunctionData({ abi: X402_MULTICALL_ABI,
    functionName: "multicall", args: [[claimData, refundData]] }) : refundData;
}

function nativeAmount(value: unknown): string {
  if (typeof value !== "bigint" || value < 0n) {
    throw new Error("Hosted settlement source has no exact nonnegative amount");
  }
  return value.toString();
}

async function transaction<T>(pool: Pool, operation: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const result = await operation(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

/** Private, server-installed record of economic effects whose report may outlive the rail call. */
export class HostedSettlementReportObligations {
  private x402?: X402Config;
  private tempo?: TempoConfig;
  private x402SettlementStore?: PostgresX402ChannelStorage;

  constructor(
    private readonly pool: Pool,
    private readonly dvmId: string,
    private readonly scope: string
  ) {}

  configureX402(config: X402Config): void {
    if (!x402NetworkByCaip2(config.network) || !hex(config.receiver, 20) || !hex(config.token, 20)) {
      throw new Error("Hosted x402 settlement identity is unsupported");
    }
    if (this.x402 && hash(this.x402) !== hash(config)) throw new Error("Hosted x402 settlement identity changed");
    this.x402 = config;
  }

  attachX402SettlementStore(store: PostgresX402ChannelStorage): void {
    if (this.x402SettlementStore && this.x402SettlementStore !== store) {
      throw new Error("Hosted x402 settlement writer changed");
    }
    this.x402SettlementStore = store;
  }

  private x402Transaction<T>(operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    const store = this.x402SettlementStore;
    if (!store) throw new Error("Hosted x402 durable settlement writer is unavailable");
    return store.withSettlementTransaction(operation);
  }

  configureTempo(config: TempoConfig): void {
    if (!/^eip155:[0-9]+$/.test(config.network) || !hex(config.escrow, 20) ||
      !hex(config.payee, 20) || !hex(config.token, 20)) {
      throw new Error("Hosted Tempo settlement identity is unsupported");
    }
    if (this.tempo && hash(this.tempo) !== hash(config)) throw new Error("Hosted Tempo settlement identity changed");
    this.tempo = config;
  }

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, async () => {
      const earlier = await this.pool.query<{ x402: boolean; x402Settlement: boolean;
        x402Batch: boolean; tempo: boolean; tempoClose: boolean; reports: boolean;
        obligations: boolean }>(
        `SELECT to_regclass('x402_batch_channels') IS NOT NULL AS x402,
                to_regclass('x402_batch_settlements') IS NOT NULL AS "x402Settlement",
                to_regclass('payout_x402_batches') IS NOT NULL AS "x402Batch",
                to_regclass('mpp_tempo_channels') IS NOT NULL AS tempo,
                to_regclass('mpp_tempo_close_intents') IS NOT NULL AS "tempoClose",
                to_regclass('pending_dvm_reports') IS NOT NULL AS reports,
                to_regclass('sdk_hosted_settlement_report_obligations') IS NOT NULL AS obligations`
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS sdk_hosted_settlement_report_history (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton), complete BOOLEAN NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sdk_hosted_settlement_report_obligations (
          id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE,
          dvm_id TEXT NOT NULL, scope TEXT NOT NULL, instance_id TEXT NOT NULL,
          boot_epoch BIGINT NOT NULL, rail TEXT NOT NULL CHECK (rail IN ('x402','tempo')),
          operation TEXT NOT NULL CHECK (operation IN ('claim','refund','settle','close')),
          network TEXT NOT NULL, contract TEXT NOT NULL, channel_id TEXT NOT NULL,
          original JSONB NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('reserved','observed','report_queued','delivered','no_report','exhausted','unmatched')),
          close_search_before BIGINT, close_write_off_note TEXT, close_written_off_at_ms BIGINT,
          tx_hash TEXT, block_number BIGINT, block_hash TEXT, delta_native NUMERIC(78,0),
          payout_id TEXT, report_id TEXT, report_payload JSONB, delivered_at_ms BIGINT,
          created_at_ms BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
          updated_at_ms BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
        );
        CREATE INDEX IF NOT EXISTS sdk_hosted_settlement_report_pending
          ON sdk_hosted_settlement_report_obligations (dvm_id,scope,state)
          WHERE state NOT IN ('delivered','no_report');
        CREATE INDEX IF NOT EXISTS sdk_hosted_settlement_report_delivery
          ON sdk_hosted_settlement_report_obligations (report_id)
          WHERE report_id IS NOT NULL;
      `);
      const columns = await this.pool.query<{ attname: string }>(
        `SELECT attname FROM pg_attribute
         WHERE attrelid='sdk_hosted_settlement_report_obligations'::regclass AND NOT attisdropped`
      );
      for (const [name, type] of [["close_search_before", "BIGINT"], ["close_write_off_note", "TEXT"], ["close_written_off_at_ms", "BIGINT"]]) {
        if (!columns.rows.some((column) => column.attname === name)) {
          await this.pool.query(`ALTER TABLE sdk_hosted_settlement_report_obligations ADD COLUMN ${name} ${type}`);
        }
      }
      const constraint = await this.pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
         WHERE conrelid='sdk_hosted_settlement_report_obligations'::regclass
           AND conname='sdk_hosted_settlement_report_obligations_state_check'`
      );
      const states = ["reserved", "observed", "report_queued", "delivered", "no_report", "exhausted", "unmatched"];
      const expected = `CHECK ((state = ANY (ARRAY[${states.map((state) => `'${state}'::text`).join(", ")}])))`;
      if (constraint.rows[0]?.definition !== expected) {
        await this.pool.query(`ALTER TABLE sdk_hosted_settlement_report_obligations
          DROP CONSTRAINT IF EXISTS sdk_hosted_settlement_report_obligations_state_check;
          ALTER TABLE sdk_hosted_settlement_report_obligations
          ADD CONSTRAINT sdk_hosted_settlement_report_obligations_state_check
          CHECK (state IN ('reserved','observed','report_queued','delivered','no_report','exhausted','unmatched'))`);
      }
      await this.pool.query(
        `INSERT INTO sdk_hosted_settlement_report_history (singleton,complete)
         VALUES (TRUE,$1) ON CONFLICT (singleton) DO NOTHING`,
        [Object.values(earlier.rows[0]).every((exists) => !exists)]
      );
    });
  }

  async reserveX402(channelId: string, operation: "claim" | "refund", expected: {
    charged?: string; signature?: string; refundNonce?: string; refundAmount?: string;
    voucherSignature?: string; signedMax?: string;
    authorizationPayload: Record<string, unknown>;
    authorizationRequirements: { scheme: string; network: string; asset: string;
      payTo: string; amount: string };
  }): Promise<HostedEffectReservation | null> {
    const config = this.x402;
    if (!config || !hex(channelId, 32)) throw new Error("Hosted x402 settlement configuration is unavailable");
    const requirements = expected.authorizationRequirements;
    if (requirements.scheme !== "batch-settlement" || requirements.network !== config.network ||
      requirements.asset.toLowerCase() !== config.token.toLowerCase() ||
      requirements.payTo.toLowerCase() !== config.receiver.toLowerCase() ||
      requirements.amount !== "0") {
      throw new Error("Hosted x402 authorization has another selected rail or recipient");
    }
    const originalCallData = authorizationCallData(operation, expected.authorizationPayload);
    return this.x402Transaction(async (tx) => {
      type Source = {
        channel_config: Record<string, unknown>; charged_cumulative_amount: string;
        signed_max_claimable: string; signature: string; total_claimed: string; balance: string;
        refund_nonce: string;
      };
      let row: Source | undefined;
      let refundSettlementId: string | undefined;
      if (operation === "refund") {
        const result = await tx.query<{
          settlement_id: string; channel_at_submission: Record<string, unknown> | null;
          payment_payload: Record<string, unknown>; payment_requirements: Record<string, unknown>;
        }>(`SELECT settlement_id,channel_at_submission,payment_payload,payment_requirements
             FROM x402_batch_settlements
             WHERE channel_id=$1 AND operation='refund' AND status='submitting'
             ORDER BY created_at DESC LIMIT 2`, [channelId.toLowerCase()]);
        if (result.rows.length !== 1 || !result.rows[0].channel_at_submission) {
          throw new Error("Hosted x402 refund has no unique durable pre-submission source");
        }
        const original = result.rows[0];
        const snapshot = original.channel_at_submission!;
        const payment = original.payment_payload.payload as Record<string, unknown> | undefined;
        const voucher = payment?.voucher as Record<string, unknown> | undefined;
        const requirements = original.payment_requirements;
        if (payment?.type !== "refund" ||
          !payment.channelConfig ||
          computeChannelId(payment.channelConfig as Parameters<typeof computeChannelId>[0], config.network).toLowerCase() !== channelId.toLowerCase() ||
          String(voucher?.signature).toLowerCase() !== expected.voucherSignature?.toLowerCase() ||
          String(voucher?.channelId).toLowerCase() !== channelId.toLowerCase() ||
          String(voucher?.maxClaimableAmount) !== expected.signedMax ||
          String(snapshot.signature).toLowerCase() !== expected.voucherSignature?.toLowerCase() ||
          String(snapshot.signedMaxClaimable) !== expected.signedMax ||
          requirements.scheme !== "batch-settlement" ||
          requirements.network !== config.network ||
          String(requirements.payTo).toLowerCase() !== config.receiver.toLowerCase() ||
          String(requirements.asset).toLowerCase() !== config.token.toLowerCase()) {
          throw new Error("Hosted x402 refund differs from its original signed credit effect");
        }
        row = {
          channel_config: snapshot.channelConfig as Record<string, unknown>,
          charged_cumulative_amount: String(snapshot.chargedCumulativeAmount),
          signed_max_claimable: String(snapshot.signedMaxClaimable),
          signature: String(snapshot.signature), total_claimed: String(snapshot.totalClaimed),
          balance: String(snapshot.balance), refund_nonce: String(snapshot.refundNonce),
        };
        refundSettlementId = original.settlement_id;
      } else {
        const result = await tx.query<Source>(`SELECT channel_config,charged_cumulative_amount,signed_max_claimable,
              signature,total_claimed,balance,refund_nonce
             FROM x402_batch_channels WHERE channel_id=$1`, [channelId.toLowerCase()]);
        row = result.rows[0];
      }
      if (!row) return null;
      const identity = await this.lockIdentity(tx);
      if (operation === "claim" && BigInt(row.charged_cumulative_amount) <= BigInt(row.total_claimed)) return null;
      if (operation === "refund" && BigInt(row.balance) <= BigInt(row.total_claimed)) return null;
      if (String(row.channel_config.receiver).toLowerCase() !== config.receiver.toLowerCase() ||
        String(row.channel_config.token).toLowerCase() !== config.token.toLowerCase() ||
        computeChannelId(row.channel_config as Parameters<typeof computeChannelId>[0], config.network).toLowerCase() !== channelId.toLowerCase()) {
        throw new Error("Hosted x402 channel has another recipient or token");
      }
      if (operation === "claim" && (expected.charged !== row.charged_cumulative_amount ||
        expected.signature?.toLowerCase() !== row.signature.toLowerCase() ||
        expected.signedMax !== row.signed_max_claimable)) {
        throw new Error("Hosted x402 claim changed after selection");
      }
      if (operation === "refund" && (expected.refundNonce !== row.refund_nonce ||
        expected.refundAmount !== (BigInt(row.balance) - BigInt(row.charged_cumulative_amount)).toString())) {
        throw new Error("Hosted x402 refund changed after selection");
      }
      const batchId = operation === "claim" ||
        BigInt(row.charged_cumulative_amount) > BigInt(row.total_claimed)
        ? await this.ensureOpenX402Batch(tx, config) : undefined;
      const original = operation === "claim" ? {
        charged: row.charged_cumulative_amount, claimedBefore: row.total_claimed,
        signed: row.signed_max_claimable, signature: row.signature, batchId,
        authorizationRequirements: requirements,
        authorizationCallData: originalCallData,
      } : {
        charged: row.charged_cumulative_amount, claimedBefore: row.total_claimed,
        balance: row.balance, refundNonce: row.refund_nonce,
        refundAmount: (BigInt(row.balance) - BigInt(row.charged_cumulative_amount)).toString(),
        signed: row.signed_max_claimable, signature: row.signature,
        settlementId: refundSettlementId,
        authorizationRequirements: requirements,
        authorizationCallData: originalCallData,
        ...(batchId ? { batchId } : {}),
      };
      return this.insert(tx, identity, "x402", operation, config.network,
        BATCH_SETTLEMENT_ADDRESS, channelId.toLowerCase(), original,
        operation === "claim" ? [row.charged_cumulative_amount, row.signature.toLowerCase()] :
          [refundSettlementId, row.refund_nonce]);
    });
  }

  async reserveTempo(channelId: string, operation: "settle" | "close", drainId?: string): Promise<HostedEffectReservation> {
    return transaction(this.pool, (tx) => this.reserveTempoIn(tx, channelId, operation, drainId));
  }

  /**
   * Retire a close reservation that never recorded a transaction and reserve
   * the drain's next attempt in one transaction. At the retry cap the final
   * row becomes terminal `exhausted` and remains claimable by a late landing.
   * A close from the retired attempt that lands late is the same channel's close: `recordSubmitted` on the retired row
   * writes it onto the successor, and recovery attaches it there if that
   * attempt never got to write, so it is reported once.
   *
   * The caller has just read the channel open on chain. The age bound only
   * spares a reservation young enough to be inside its first receipt wait; an
   * attempt slowed past it by a degraded RPC can still be running.
   */
  async releaseStaleTempoClose(id: string, channelId: string, drainId: string, limits: {
    staleAfterMs: number; maxReleases: number; onExhausted?: (tx: PoolClient) => Promise<void>;
  }): Promise<
    | { outcome: "reserved"; id: string; releases: number }
    | { outcome: "in_flight" }
    | { outcome: "exhausted"; releases: number }
  > {
    return transaction(this.pool, async (tx) => {
      // Identity before the row: reserveTempo takes them in this order.
      await this.lockIdentity(tx);
      const row = await this.lockRow(tx, id);
      if (row.rail !== "tempo" || row.operation !== "close" ||
        row.channel_id !== channelId.toLowerCase() || row.original.drainId !== drainId ||
        row.state !== "reserved" || row.tx_hash) {
        return { outcome: "in_flight" };
      }
      const age = await tx.query<{ stale: boolean }>(
        `SELECT updated_at_ms <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint - $2 AS stale
         FROM sdk_hosted_settlement_report_obligations WHERE id=$1`, [id, limits.staleAfterMs]
      );
      if (!age.rows[0]?.stale) return { outcome: "in_flight" };
      const released = Number((await tx.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM sdk_hosted_settlement_report_obligations
         WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation='close' AND channel_id=$3
           AND original->>'drainId'=$4 AND state='no_report' AND tx_hash IS NULL`,
        [this.dvmId, this.scope, channelId.toLowerCase(), drainId]
      )).rows[0].n);
      if (released >= limits.maxReleases) {
        await tx.query(
          `UPDATE sdk_hosted_settlement_report_obligations SET state='exhausted',
             updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE id=$1`, [id]
        );
        await limits.onExhausted?.(tx);
        return { outcome: "exhausted", releases: released };
      }
      await tx.query(
        `UPDATE sdk_hosted_settlement_report_obligations SET state='no_report',
           updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE id=$1`, [id]
      );
      const next = await this.reserveTempoIn(tx, channelId, "close", drainId);
      return { outcome: "reserved", id: next.id, releases: released + 1 };
    });
  }

  /**
   * Resolve an unsubmitted close reservation whose channel the payer exited
   * on its own: no cooperative close of ours can land on a finalized channel.
   */
  async resolveTempoCloseExit(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations SET state='no_report',
         updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND rail='tempo' AND operation='close'
         AND state IN ('reserved','exhausted') AND tx_hash IS NULL`, [id, this.dvmId, this.scope]
    );
    return result.rowCount === 1;
  }

  async tempoCloseAmountAtStake(id: string): Promise<string> {
    const row = await this.lockRow(this.pool, id);
    if (row.rail !== "tempo" || row.operation !== "close") throw new Error("Not a Tempo close obligation");
    return (BigInt(String(row.original.highestVoucherAmount)) -
      BigInt(String(row.original.settledOnChain))).toString();
  }

  /** Stop automatic searches without declaring a possibly missing payout discharged. */
  async markTempoCloseUnmatched(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations SET state='unmatched',
         updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND rail='tempo' AND operation='close'
         AND state IN ('reserved','exhausted') AND tx_hash IS NULL`, [id, this.dvmId, this.scope]
    );
    return result.rowCount === 1;
  }

  async listTempoCloseReports(args: {
    limit: number; after?: { createdAtMs: number; obligationId: string }; all?: boolean;
  }): Promise<{
    id: string; channelId: string; amountNative: string; status: "unmatched" | "no_report";
    createdAtMs: number; updatedAtMs: number; deliveredAtMs: number | null;
    retryable: boolean; writeOffAllowed: boolean; writtenOff: boolean;
    writeOffNote: string | null; writtenOffAtMs: number | null;
  }[]> {
    const result = await this.pool.query<{
      id: string; channel_id: string; original: Record<string, unknown>; state: "unmatched" | "no_report";
      created_at_ms: string; updated_at_ms: string; delivered_at_ms: string | null;
      retryable: boolean; write_off_allowed: boolean; close_write_off_note: string | null;
      close_written_off_at_ms: string | null;
    }>(
      `WITH candidates AS (
         SELECT target.*, (${TEMPO_CLOSE_RETRYABLE_SQL}) AS retryable,
           (${TEMPO_CLOSE_WRITE_OFF_ALLOWED_SQL}) AS write_off_allowed
         FROM sdk_hosted_settlement_report_obligations target
         WHERE target.dvm_id=$1 AND target.scope=$2 AND target.rail='tempo' AND target.operation='close'
           AND target.state IN ('unmatched','no_report')
       )
       SELECT * FROM candidates
       WHERE ($6::boolean OR (state='unmatched' AND (retryable OR write_off_allowed)))
         AND ($4::bigint IS NULL OR (created_at_ms,id)>($4,$5))
       ORDER BY created_at_ms,id LIMIT $3`,
      [this.dvmId, this.scope, args.limit, args.after?.createdAtMs ?? null, args.after?.obligationId ?? null,
        args.all ?? false]
    );
    return result.rows.map(row => ({
      id: row.id, channelId: row.channel_id, amountNative: tempoCloseAmount(row.original), status: row.state,
      createdAtMs: Number(row.created_at_ms), updatedAtMs: Number(row.updated_at_ms),
      deliveredAtMs: row.delivered_at_ms === null ? null : Number(row.delivered_at_ms),
      retryable: row.retryable, writeOffAllowed: row.write_off_allowed,
      writtenOff: row.close_write_off_note !== null, writeOffNote: row.close_write_off_note,
      writtenOffAtMs: row.close_written_off_at_ms === null ? null : Number(row.close_written_off_at_ms),
    }));
  }

  async hasTempoCloseReport(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT id FROM sdk_hosted_settlement_report_obligations
       WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND rail='tempo' AND operation='close'`,
      [id, this.dvmId, this.scope]
    );
    return result.rowCount === 1;
  }

  async writeOffTempoClose(id: string, note: string): Promise<{ channelId: string; amount: string } | undefined> {
    const result = await this.pool.query<{ channel_id: string; original: Record<string, unknown> }>(
      `UPDATE sdk_hosted_settlement_report_obligations target
       SET state='no_report', close_write_off_note=$4,
         close_written_off_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
         updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND ${TEMPO_CLOSE_WRITE_OFF_ALLOWED_SQL}
       RETURNING channel_id,original`,
      [id, this.dvmId, this.scope, note]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const written = { channelId: row.channel_id, amount: tempoCloseAmount(row.original) };
    loggers.tempo.warn("tempo_session_close_report_written_off", {
      channel_id: written.channelId, obligation_id: id, amount_forgone_native: written.amount,
    });
    return written;
  }

  async reopenTempoClose(id: string): Promise<boolean> {
    const reopened = await transaction(this.pool, async (tx) => {
      const owned = await tx.query(
        "SELECT id FROM sdk_hosted_settlement_report_obligations WHERE id=$1 AND dvm_id=$2 AND scope=$3",
        [id, this.dvmId, this.scope]
      );
      if (!owned.rowCount) return undefined;
      // Match reservation lock order, then retain the prior state under the row lock for the audit event.
      await this.lockIdentity(tx);
      const prior = await tx.query<{
        channel_id: string; state: State; close_write_off_note: string | null; original: Record<string, unknown>;
      }>(
        `SELECT channel_id,state,close_write_off_note,original FROM sdk_hosted_settlement_report_obligations
         WHERE id=$1 AND dvm_id=$2 AND scope=$3 FOR UPDATE`, [id, this.dvmId, this.scope]
      );
      const row = prior.rows[0];
      if (!row) return undefined;
      const result = await tx.query(
        `UPDATE sdk_hosted_settlement_report_obligations target
         SET state='reserved', close_search_before=NULL,
           updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
         WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND ${TEMPO_CLOSE_RETRYABLE_SQL}`,
        [id, this.dvmId, this.scope]
      );
      return result.rowCount === 1 ? row : undefined;
    });
    if (!reopened) return false;
    loggers.tempo.info("tempo_session_close_report_reopened", {
      obligation_id: id, channel_id: reopened.channel_id, prior_status: reopened.state,
      written_off: reopened.close_write_off_note !== null, amount_native: tempoCloseAmount(reopened.original),
    });
    return true;
  }

  private async reserveTempoIn(
    tx: PoolClient, channelId: string, operation: "settle" | "close", drainId?: string
  ): Promise<HostedEffectReservation> {
    const config = this.tempo;
    if (!config || !hex(channelId, 32)) throw new Error("Hosted Tempo settlement configuration is unavailable");
    const state = await tx.query<{ state_json: string }>(
      "SELECT state_json FROM mpp_tempo_channels WHERE channel_key=$1", [channelId.toLowerCase()]
    );
    if (!state.rows[0]) throw new Error("Hosted Tempo channel is not durable");
    const identity = await this.lockIdentity(tx);
    const parsed = parseStoreValue(state.rows[0].state_json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Hosted Tempo state is invalid");
    const row = parsed as Record<string, unknown>;
    if (row.chainId !== Number(config.network.split(":")[1]) ||
      String(row.escrowContract).toLowerCase() !== config.escrow.toLowerCase() ||
      String(row.payee).toLowerCase() !== config.payee.toLowerCase() ||
      String(row.token).toLowerCase() !== config.token.toLowerCase()) {
      throw new Error("Hosted Tempo channel has another chain or recipient");
    }
    if (operation === "close") {
      if (!drainId) throw new Error("Hosted Tempo close requires the original drain");
      const close = await tx.query<{ drain_id: string }>(
        "SELECT drain_id FROM mpp_tempo_close_intents WHERE channel_id=$1", [channelId.toLowerCase()]
      );
      if (close.rows[0]?.drain_id !== drainId) throw new Error("Hosted Tempo close has no matching drain");
    }
    const highestVoucherAmount = nativeAmount(row.highestVoucherAmount);
    const settledOnChain = nativeAmount(row.settledOnChain);
    const spent = nativeAmount(row.spent);
    if (BigInt(settledOnChain) > BigInt(highestVoucherAmount) ||
      BigInt(spent) > BigInt(highestVoucherAmount)) {
      throw new Error("Hosted Tempo settlement source has inconsistent amounts");
    }
    const original = operation === "settle" ? {
      highestVoucherAmount, settledOnChain, spent,
    } : { drainId, highestVoucherAmount, settledOnChain, spent };
    return this.insert(tx, identity, "tempo", operation, config.network,
      config.escrow, channelId.toLowerCase(), original,
      operation === "close" ? [drainId] : [highestVoucherAmount]);
  }

  async findPendingTempo(channelId: string, operation: "settle" | "close"): Promise<ObligationRow | undefined> {
    const result = await this.pool.query<ObligationRow>(
      `SELECT * FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation=$3 AND channel_id=$4
         AND state NOT IN ('delivered','no_report') ORDER BY created_at_ms DESC LIMIT 1`,
      [this.dvmId, this.scope, operation, channelId.toLowerCase()]
    );
    return result.rows[0];
  }

  /** The original close obligation reserved for this drain, while its report is outstanding. */
  async pendingTempoClose(channelId: string, drainId: string): Promise<{
    id: string; state: State; txHash: string | null; reservedAtMs: number; searchBefore: bigint | null;
  } | undefined> {
    const result = await this.pool.query<{
      id: string; state: State; tx_hash: string | null; created_at_ms: string; close_search_before: string | null;
    }>(
      `SELECT id,state,tx_hash,created_at_ms,close_search_before FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation='close' AND channel_id=$3
         AND original->>'drainId'=$4 AND state NOT IN ('delivered','no_report')
       ORDER BY created_at_ms DESC LIMIT 1`,
      [this.dvmId, this.scope, channelId.toLowerCase(), drainId]
    );
    const row = result.rows[0];
    return row && { id: row.id, state: row.state, txHash: row.tx_hash, reservedAtMs: Number(row.created_at_ms),
      searchBefore: searchCursor(row.close_search_before) };
  }

  /** A recorded close transaction remains refund evidence after its report is delivered. */
  async tempoCloseTransaction(channelId: string, drainId: string): Promise<string | undefined> {
    const result = await this.pool.query<{ tx_hash: string }>(
      `SELECT tx_hash FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation='close' AND channel_id=$3
         AND original->>'drainId'=$4 AND tx_hash IS NOT NULL
       ORDER BY created_at_ms DESC LIMIT 1`,
      [this.dvmId, this.scope, channelId.toLowerCase(), drainId]
    );
    return result.rows[0]?.tx_hash;
  }

  /**
   * Where the next search for this close obligation's transaction resumes. It
   * lives on the obligation, not the drain's close intent, because releasing
   * the drain deletes the intent while the obligation still needs the search.
   */
  async recordTempoCloseSearch(id: string, resumeAt: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE sdk_hosted_settlement_report_obligations
          SET close_search_before = LEAST(COALESCE(close_search_before, $4), $4)
        WHERE id=$1 AND dvm_id=$2 AND scope=$3 AND rail='tempo' AND operation='close'`,
      [id, this.dvmId, this.scope, resumeAt.toString()]
    );
  }

  async submittedIds(rail: Rail, operation: Operation, txHash: string,
    batchId?: string): Promise<string[]> {
    if (!hex(txHash, 32)) throw new Error("Hosted effect has no exact transaction hash");
    const result = await this.pool.query<{ id: string; original: Record<string, unknown> }>(
      `SELECT id,original FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail=$3 AND operation=$4 AND tx_hash=$5
       ORDER BY source_key`,
      [this.dvmId, this.scope, rail, operation, txHash.toLowerCase()]
    );
    if (batchId && result.rows.some((row) => row.original.batchId !== batchId)) {
      throw new Error("Hosted x402 submitted claim belongs to another payout batch");
    }
    return result.rows.map((row) => row.id);
  }

  async refundClaimDelta(txHash: string, channelId: string): Promise<bigint> {
    const rows = await this.pool.query<{ original: Record<string, unknown> }>(
      `SELECT original FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail='x402' AND operation='refund'
         AND channel_id=$3 AND tx_hash=$4`,
      [this.dvmId, this.scope, channelId.toLowerCase(), txHash.toLowerCase()]
    );
    if (rows.rows.length !== 1) throw new Error("Hosted refund has no exact submitted source");
    const original = rows.rows[0].original;
    const delta = BigInt(String(original.charged)) - BigInt(String(original.claimedBefore));
    if (delta < 0n) throw new Error("Hosted refund original claim amount is invalid");
    return delta;
  }

  async assertReservedTempoClose(id: string, channelId: string): Promise<void> {
    const result = await this.pool.query<ObligationRow>(
      "SELECT * FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id]
    );
    const row = result.rows[0];
    if (!row || row.dvm_id !== this.dvmId || row.scope !== this.scope ||
      row.rail !== "tempo" || row.operation !== "close" ||
      row.channel_id !== channelId.toLowerCase() || row.state !== "reserved" || row.tx_hash) {
      throw new Error("Hosted Tempo close permit has no original reserved drain");
    }
  }

  async originalTempoCloseSettled(id: string, channelId: string, txHash: string): Promise<bigint> {
    const result = await this.pool.query<ObligationRow>(
      "SELECT * FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id]
    );
    const row = result.rows[0];
    if (!row || row.dvm_id !== this.dvmId || row.scope !== this.scope ||
      row.rail !== "tempo" || row.operation !== "close" ||
      row.channel_id !== channelId.toLowerCase() ||
      row.tx_hash?.toLowerCase() !== txHash.toLowerCase()) {
      throw new Error("Hosted Tempo repair has no matching original close");
    }
    const amount = row.original.settledOnChain;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) {
      throw new Error("Hosted Tempo repair has no original settled amount");
    }
    return BigInt(amount);
  }

  async settlementId(batchId: string, txHash: string): Promise<string> {
    const result = await this.pool.query<{ id: string; original: { batchId?: string } }>(
      `SELECT id,original FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail='x402' AND operation='settle' AND tx_hash=$3`,
      [this.dvmId, this.scope, txHash.toLowerCase()]
    );
    const matching = result.rows.filter((row) => row.original.batchId === batchId);
    if (matching.length !== 1) throw new Error("Hosted x402 settlement is not bound to the original batch");
    return matching[0].id;
  }

  async reserveOpenX402Settlement(): Promise<HostedEffectReservation> {
    const config = this.x402;
    if (!config) throw new Error("Hosted x402 payout batch is unavailable");
    return this.x402Transaction(async (tx) => {
      const expectedScope = `${config.network}|${config.receiver.toLowerCase()}|${config.token.toLowerCase()}`;
      const batch = await tx.query<{ batch_id: string; claimed_native: string }>(
        "SELECT batch_id,claimed_native FROM payout_x402_batches WHERE scope=$1", [expectedScope]
      );
      const row = batch.rows[0];
      if (!row || BigInt(row.claimed_native) <= 0n) {
        throw new Error("Hosted x402 settlement has no original claimed batch");
      }
      const identity = await this.lockIdentity(tx);
      return this.insert(tx, identity, "x402", "settle", config.network,
        BATCH_SETTLEMENT_ADDRESS, expectedScope,
        { batchId: row.batch_id, claimedNative: row.claimed_native }, [row.batch_id]);
    });
  }

  private async ensureOpenX402Batch(tx: Query, config: X402Config): Promise<string> {
    const scope = `${config.network}|${config.receiver.toLowerCase()}|${config.token.toLowerCase()}`;
    const result = await tx.query<{ batch_id: string }>(
      `INSERT INTO payout_x402_batches
         (scope,batch_id,claimed_native,voucher_count,claims,opened_at,updated_at)
       VALUES ($1,$2,0,0,0,
         FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
         FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
       ON CONFLICT (scope) DO UPDATE SET scope=EXCLUDED.scope
       RETURNING batch_id`,
      [scope, randomUUID()]
    );
    return result.rows[0].batch_id;
  }

  async recordSubmitted(id: string, txHash: string): Promise<void> {
    if (!hex(txHash, 32)) throw new Error("Hosted settlement has no transaction hash");
    const write = this.x402SettlementStore
      ? this.x402Transaction.bind(this) : <T>(operation: (tx: PoolClient) => Promise<T>) =>
        transaction(this.pool, operation);
    await write(async (tx) => {
      let row = await this.lockRow(tx, id);
      if (row.state === "no_report" && !row.tx_hash) {
        row = await this.successorOfRetiredClose(tx, row);
      }
      if (row.tx_hash && row.tx_hash.toLowerCase() !== txHash.toLowerCase()) {
        throw new Error("Hosted settlement transaction replay conflicts");
      }
      await tx.query(
        `UPDATE sdk_hosted_settlement_report_obligations SET tx_hash=COALESCE(tx_hash,$2),
           state=CASE WHEN state IN ('exhausted','unmatched') THEN 'reserved' ELSE state END,
           updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint WHERE id=$1`,
        [row.id, txHash.toLowerCase()]
      );
    });
  }

  /**
   * Close reservations that never recorded a transaction, oldest first. Each
   * one owes a payout report if its close lands. Exhausted attempts remain
   * observable for late landings; unmatched searches require an explicit retry.
   */
  async unsubmittedTempoCloses(limit = 100): Promise<Array<{
    id: string; channelId: string; drainId: string; reservedAtMs: number; searchBefore: bigint | null;
  }>> {
    const result = await this.pool.query<{
      id: string; channel_id: string; drain_id: string | null; created_at_ms: string;
      close_search_before: string | null;
    }>(
      `SELECT id,channel_id,original->>'drainId' AS drain_id,created_at_ms,close_search_before
         FROM sdk_hosted_settlement_report_obligations
        WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation='close'
          AND state IN ('reserved','exhausted') AND tx_hash IS NULL
        ORDER BY created_at_ms,id LIMIT $3`,
      [this.dvmId, this.scope, limit]
    );
    return result.rows.flatMap((row) => row.drain_id === null ? [] : [{
      id: row.id, channelId: row.channel_id, drainId: row.drain_id,
      reservedAtMs: Number(row.created_at_ms), searchBefore: searchCursor(row.close_search_before),
    }]);
  }

  /**
   * A retired close reservation's attempt can still be running when its
   * successor is reserved, and its close can land. The close is the same
   * channel's, so it belongs to the drain's outstanding obligation; writing it
   * onto the retired row would leave that obligation without a transaction and
   * the payout unreported.
   */
  private async successorOfRetiredClose(tx: Query, retired: ObligationRow): Promise<ObligationRow> {
    const drainId = retired.original.drainId;
    if (retired.rail !== "tempo" || retired.operation !== "close" || typeof drainId !== "string") {
      throw new Error("Hosted settlement obligation was resolved without a transaction");
    }
    const successor = await tx.query<{ id: string }>(
      `SELECT id FROM sdk_hosted_settlement_report_obligations
        WHERE dvm_id=$1 AND scope=$2 AND rail='tempo' AND operation='close' AND channel_id=$3
          AND original->>'drainId'=$4 AND state NOT IN ('delivered','no_report')
        ORDER BY created_at_ms DESC LIMIT 1`,
      [this.dvmId, this.scope, retired.channel_id, drainId]
    );
    if (!successor.rows[0]) {
      throw new Error("Hosted Tempo close was retired and the drain has no outstanding obligation");
    }
    const locked = await this.lockRow(tx, successor.rows[0].id);
    // The successor is chosen before its lock is held, so another stale
    // release can retire it while this waits; follow it to its own successor.
    return locked.state === "no_report" && !locked.tx_hash
      ? this.successorOfRetiredClose(tx, locked) : locked;
  }

  async recoveryCandidates(): Promise<HostedRecoverableEffect[]> {
    const result = await this.pool.query<ObligationRow>(
      `SELECT * FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND tx_hash IS NOT NULL
         AND state NOT IN ('delivered','no_report')
         AND (block_hash IS NULL OR report_id IS NULL)
       ORDER BY created_at_ms,id`, [this.dvmId, this.scope]
    );
    return result.rows.map((row) => ({
      id: row.id, rail: row.rail, operation: row.operation,
      channelId: row.channel_id, txHash: row.tx_hash!,
      ...(typeof row.original.batchId === "string" ? { batchId: row.original.batchId } : {}),
      reportId: row.report_id, blockHash: row.block_hash,
      deltaNative: row.delta_native,
    }));
  }

  async recoverOriginalX402Refunds(): Promise<Array<{ id: string; error: unknown }>> {
    // A host without the x402 batch rail never creates this table. Querying it
    // there would fail every hosted reconcile before any Tempo report retried.
    const table = await this.pool.query<{ present: boolean }>(
      "SELECT to_regclass('x402_batch_settlements') IS NOT NULL AS present"
    );
    if (!table.rows[0]?.present) return [];
    const rows = await this.pool.query<{ id: string; response: Record<string, unknown> }>(
      `SELECT obligation.id,settlement.settle_response AS response
       FROM sdk_hosted_settlement_report_obligations obligation
       JOIN x402_batch_settlements settlement
         ON settlement.settlement_id=obligation.original->>'settlementId'
       WHERE obligation.dvm_id=$1 AND obligation.scope=$2 AND obligation.rail='x402'
         AND obligation.operation='refund' AND obligation.tx_hash IS NULL
         AND settlement.operation='refund' AND settlement.channel_id=obligation.channel_id
         AND settlement.status IN ('settled','complete')
         AND settlement.settle_response->>'success'='true'`,
      [this.dvmId, this.scope]
    );
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const row of rows.rows) {
      if (!hex(row.response?.transaction, 32)) continue;
      try {
        await this.recordSubmitted(row.id, row.response.transaction);
      } catch (error) {
        failures.push({ id: row.id, error });
      }
    }
    return failures;
  }

  async reconcileX402Batches(): Promise<Array<{ id: string; error: unknown }>> {
    const batches = await this.pool.query<{ batch_id: string }>(
      `SELECT DISTINCT obligation.original->>'batchId' AS batch_id
       FROM sdk_hosted_settlement_report_obligations obligation
       JOIN payout_x402_batches batch ON batch.batch_id=obligation.original->>'batchId'
       WHERE obligation.dvm_id=$1 AND obligation.scope=$2 AND obligation.rail='x402'
         AND obligation.operation IN ('claim','refund') AND obligation.original ? 'batchId'
       ORDER BY batch_id`, [this.dvmId, this.scope]
    );
    const failures: Array<{ id: string; error: unknown }> = [];
    for (const batch of batches.rows) {
      try {
        await transaction(this.pool, async (tx) => {
        const open = await tx.query<{ scope: string }>(
          "SELECT scope FROM payout_x402_batches WHERE batch_id=$1 FOR UPDATE", [batch.batch_id]
        );
        if (!open.rows[0]) return;
        const sources = await tx.query<ObligationRow>(
          `SELECT * FROM sdk_hosted_settlement_report_obligations
           WHERE dvm_id=$1 AND scope=$2 AND rail='x402'
             AND operation IN ('claim','refund') AND original->>'batchId'=$3
           ORDER BY source_key FOR UPDATE`, [this.dvmId, this.scope, batch.batch_id]
        );
        if (!sources.rows.length || sources.rows.some((row) =>
          !row.tx_hash || !row.block_hash || row.delta_native === null)) return;
        const claimed = sources.rows.reduce((sum, row) => sum + BigInt(row.delta_native!), 0n);
        const hashes = new Set(sources.rows.map((row) => row.tx_hash));
        await tx.query(
          `UPDATE payout_x402_batches
             SET claimed_native=$2,voucher_count=$3,claims=$4,obligation_ids=$5,
                 updated_at=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
           WHERE batch_id=$1`,
          [batch.batch_id, claimed.toString(), sources.rows.length,
            hashes.size, JSON.stringify(sources.rows.map((row) => row.id))]
        );
        });
      } catch (error) {
        failures.push({ id: batch.batch_id, error });
      }
    }
    return failures;
  }

  async queueReport(ids: string[], payoutId: string, reportId: string,
    payload: Record<string, unknown>, tx: Query): Promise<void> {
    if (!ids.length || !payoutId || !reportId || new Set(ids).size !== ids.length) {
      throw new Error("Hosted payout report has no exact obligation set");
    }
    if (payoutId.startsWith("x402:batch:")) {
      const batchId = payoutId.slice("x402:batch:".length);
      const sources = await tx.query<{ id: string; tx_hash: string | null; operation: Operation }>(
        `SELECT id,tx_hash,operation FROM sdk_hosted_settlement_report_obligations
         WHERE dvm_id=$1 AND scope=$2 AND rail='x402'
           AND operation IN ('claim','refund','settle')
           AND original->>'batchId'=$3 FOR UPDATE`,
        [this.dvmId, this.scope, batchId]
      );
      if (sources.rows.filter((row) => row.operation === "settle").length !== 1 ||
        !sources.rows.some((row) => row.operation === "claim" || row.operation === "refund") ||
        sources.rows.some((row) => !row.tx_hash || !ids.includes(row.id)) ||
        sources.rows.length !== ids.length) {
        throw new Error("Hosted x402 payout excludes an original effect or its submission is unknown");
      }
    } else if (payoutId.startsWith("tempo:")) {
      if (ids.length !== 1) throw new Error("Hosted Tempo payout requires one original effect");
      const row = await this.lockRow(tx, ids[0]);
      if (row.rail !== "tempo" || !row.tx_hash || payoutId !== `tempo:${row.tx_hash}` ||
        (row.operation !== "settle" && row.operation !== "close")) {
        throw new Error("Hosted Tempo payout differs from its original effect");
      }
    } else {
      throw new Error("Hosted payout has an unsupported original rail identity");
    }
    for (const id of [...ids].sort()) {
      const row = await this.lockRow(tx, id);
      if (!row.tx_hash || (row.payout_id && row.payout_id !== payoutId) ||
        (row.report_id && row.report_id !== reportId) ||
        (row.report_payload && !isDeepStrictEqual(row.report_payload, payload))) {
        throw new Error("Hosted payout report has no original transaction or conflicts");
      }
      await tx.query(
        `UPDATE sdk_hosted_settlement_report_obligations
           SET payout_id=$2, report_id=$3, report_payload=$4,
             state=CASE WHEN state='delivered' THEN 'delivered'
                        WHEN block_hash IS NULL THEN 'report_queued' ELSE 'observed' END,
             updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
         WHERE id=$1`, [id, payoutId, reportId, JSON.stringify(payload)]
      );
    }
  }

  async hasOriginalReport(ids: string[], payoutId: string,
    payload: Record<string, unknown>, tx: Query): Promise<boolean> {
    if (!ids.length || new Set(ids).size !== ids.length) {
      throw new Error("Hosted payout replay has no exact original set");
    }
    const rows: ObligationRow[] = [];
    for (const id of [...ids].sort()) rows.push(await this.lockRow(tx, id));
    const recorded = rows.filter((row) => row.report_id !== null);
    if (!recorded.length) return false;
    const first = recorded[0];
    if (recorded.length !== ids.length || rows.some((row) =>
      row.payout_id !== payoutId || row.report_id !== first.report_id ||
      row.report_payload?.dvmId !== payload.dvmId ||
      row.report_payload?.rail !== payload.rail ||
      row.report_payload?.kind !== payload.kind ||
      row.report_payload?.nativeAmount !== payload.nativeAmount ||
      row.report_payload?.nativeAsset !== payload.nativeAsset ||
      row.report_payload?.recipient !== payload.recipient ||
      !isDeepStrictEqual(row.report_payload?.refs, payload.refs))) {
      throw new Error("Hosted payout replay conflicts with its original report");
    }
    return true;
  }

  async assertReportReady(reportId: string, payload: Record<string, unknown>,
    query: Query = this.pool): Promise<void> {
    const rows = await query.query<ObligationRow>(
      `SELECT * FROM sdk_hosted_settlement_report_obligations
       WHERE report_id=$1 ORDER BY source_key`, [reportId]
    );
    if (!rows.rows.length) {
      if (await this.hasCompleteHistory(query)) {
        throw new Error("Hosted payout has no original effect report");
      }
      return;
    }
    const amount = payload.nativeAmount;
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0 ||
      rows.rows.some((row) => row.dvm_id !== this.dvmId || row.scope !== this.scope ||
        row.report_id !== reportId || row.payout_id !== payload.payoutId ||
        !isDeepStrictEqual(row.report_payload, payload) ||
        (row.rail === "x402" && (row.operation === "claim" || row.operation === "refund") &&
          (typeof row.original.authorizationCallData !== "string" ||
            !/^0x(?:[0-9a-f]{2})+$/i.test(row.original.authorizationCallData))) ||
        !row.block_hash || row.delta_native === null || row.state === "no_report")) {
      throw new Error("Hosted payout has no finalized exact original effect set");
    }
    if (payload.rail === "tempo") {
      if (rows.rows.length !== 1 || rows.rows[0].rail !== "tempo" ||
        BigInt(rows.rows[0].delta_native!) !== BigInt(amount)) {
        throw new Error("Hosted Tempo payout amount differs from its original finalized effect");
      }
    } else if (payload.rail === "x402" &&
      typeof payload.payoutId === "string" && payload.payoutId.startsWith("x402:batch:")) {
      const batchId = payload.payoutId.slice("x402:batch:".length);
      const settle = rows.rows.filter((row) => row.operation === "settle" && row.rail === "x402");
      const claims = rows.rows.filter((row) => row.operation === "claim" || row.operation === "refund");
      if (settle.length !== 1 || !claims.length || claims.length + 1 !== rows.rows.length ||
        rows.rows.some((row) => row.original.batchId !== batchId) ||
        BigInt(settle[0].delta_native!) !== BigInt(amount) ||
        claims.reduce((sum, row) => sum + BigInt(row.delta_native!), 0n) !== BigInt(amount)) {
        throw new Error("Hosted x402 payout differs from its original finalized batch");
      }
    } else {
      throw new Error("Hosted payout has no supported original rail report");
    }
  }

  async acknowledgeDelivered(reportId: string, tx: Query, requireLinked = true): Promise<void> {
    const pending = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM pending_dvm_reports WHERE id=$1 AND kind='payout' FOR UPDATE",
      [reportId]
    );
    if (!pending.rows[0]) throw new Error("Hosted payout acknowledgement has no durable outbox row");
    if (pending.rows[0].payload.rail === "x402" || pending.rows[0].payload.rail === "tempo") {
      await this.assertReportReady(reportId, pending.rows[0].payload, tx);
    }
    const rows = await tx.query<{ id: string }>(
      `UPDATE sdk_hosted_settlement_report_obligations
         SET delivered_at_ms=COALESCE(delivered_at_ms,
               FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint),
             state=CASE WHEN block_hash IS NULL THEN 'report_queued' ELSE 'delivered' END,
             updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
       WHERE report_id=$1 AND state <> 'no_report' RETURNING id`, [reportId]
    );
    if (!rows.rows.length && requireLinked) throw new Error("Hosted payout report lacks its original obligation");
  }

  async observeCanonical(id: string): Promise<HostedObservedEffect> {
    const result = await this.pool.query<ObligationRow>(
      "SELECT * FROM sdk_hosted_settlement_report_obligations WHERE id=$1", [id]
    );
    const row = result.rows[0];
    if (!row || !row.tx_hash || !hex(row.tx_hash, 32)) throw new Error("Hosted effect has no durable transaction");
    if (row.rail === "x402" && (row.operation === "claim" || row.operation === "refund") &&
      (typeof row.original.authorizationCallData !== "string" ||
        !/^0x(?:[0-9a-f]{2})+$/i.test(row.original.authorizationCallData))) {
      throw new Error("Hosted x402 original signed authorization is unknown");
    }
    if (row.block_hash && row.block_number !== null && row.delta_native !== null) {
      return { id, txHash: row.tx_hash, blockNumber: row.block_number,
        blockHash: row.block_hash, deltaNative: row.delta_native };
    }
    const config = row.rail === "x402" ? this.x402 : this.tempo;
    const expectedContract = row.rail === "x402" ? BATCH_SETTLEMENT_ADDRESS : this.tempo?.escrow;
    if (!config || !expectedContract || row.network !== config.network ||
      row.contract !== expectedContract.toLowerCase()) {
      throw new Error("Hosted effect chain configuration changed");
    }
    const { tempo, tempoModerato } = await import("viem/chains");
    const spec = row.rail === "x402" ? x402NetworkByCaip2(config.network) : undefined;
    const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
    const chain = row.rail === "x402" ? spec && chains[spec.viemChain] as typeof tempo :
      Number(config.network.split(":")[1]) === tempoModerato.id ? tempoModerato : tempo;
    if (!chain) throw new Error("Hosted effect chain is unsupported");
    const rpcUrl = resolveRpcOverride(config.rpcUrl, chain.rpcUrls.default.http[0]).url;
    const client = createPublicClient({ chain, transport: http(rpcUrl) });
    const [chainId, finalBlock, receipt, transactionRecord] = await Promise.all([
      client.getChainId(), client.getBlock({ blockTag: "finalized" }),
      client.getTransactionReceipt({ hash: row.tx_hash as `0x${string}` }),
      client.getTransaction({ hash: row.tx_hash as `0x${string}` }),
    ]);
    if (chainId !== chain.id || finalBlock.number === null ||
      receipt.status !== "success" || receipt.blockNumber > finalBlock.number ||
      receipt.transactionHash.toLowerCase() !== row.tx_hash.toLowerCase() ||
      transactionRecord.to?.toLowerCase() !== row.contract || !hex(receipt.blockHash, 32)) {
      throw new Error("Hosted effect is not finalized on its original contract");
    }
    const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error("Hosted effect receipt is not canonical");
    }
    if (row.rail === "x402" && (row.operation === "claim" || row.operation === "refund")) {
      const committed = row.original.authorizationCallData;
      if (typeof committed !== "string" || !/^0x[0-9a-f]+$/i.test(committed) ||
        transactionRecord.input?.toLowerCase() !== committed.toLowerCase()) {
        throw new Error("Hosted x402 transaction differs from its pre-effect signed authorization");
      }
    }
    let delta: bigint | undefined;
    if (row.rail === "x402" && row.operation === "claim") {
      if (!transactionRecord.input) throw new Error("Hosted claim has no transaction input");
      const decoded = decodeFunctionData({ abi: X402_CLAIM_ABI, data: transactionRecord.input });
      if (decoded.functionName !== "claimWithSignature") throw new Error("Hosted claim transaction has another method");
      const claims = decoded.args[0];
      const submitted = await this.pool.query<ObligationRow>(
        `SELECT * FROM sdk_hosted_settlement_report_obligations
         WHERE tx_hash=$1 AND rail='x402' AND operation='claim'`, [row.tx_hash]
      );
      if (submitted.rows.length !== claims.length || submitted.rows.some((original) =>
        original.dvm_id !== this.dvmId || original.scope !== this.scope ||
        claims.filter((claim) =>
          computeChannelId(claim.voucher.channel, config.network).toLowerCase() === original.channel_id &&
          claim.voucher.maxClaimableAmount === BigInt(String(original.original.signed)) &&
          claim.signature.toLowerCase() === String(original.original.signature).toLowerCase() &&
          claim.totalClaimed === BigInt(String(original.original.charged))
        ).length !== 1)) {
        throw new Error("Hosted claim transaction contains an unbound voucher");
      }
      const source = claims.find((claim) =>
        computeChannelId(claim.voucher.channel, config.network).toLowerCase() === row.channel_id &&
        claim.voucher.maxClaimableAmount === BigInt(String(row.original.signed)) &&
        claim.signature.toLowerCase() === String(row.original.signature).toLowerCase() &&
        claim.totalClaimed === BigInt(String(row.original.charged))
      );
      if (!source) throw new Error("Hosted claim transaction did not consume the original voucher");
      const [balance, claimed] = await client.readContract({ address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI, functionName: "channels", args: [row.channel_id as `0x${string}`],
        blockNumber: receipt.blockNumber });
      if (claimed < source.totalClaimed || balance < claimed) throw new Error("Hosted claim was not applied");
      delta = source.totalClaimed - BigInt(String(row.original.claimedBefore));
    } else {
      if (row.rail === "x402" && row.operation === "refund") {
        if (!transactionRecord.input) throw new Error("Hosted refund has no transaction input");
        let refundData = transactionRecord.input;
        let claimData: `0x${string}` | undefined;
        if (refundData.slice(0, 10).toLowerCase() ===
          toFunctionSelector(X402_MULTICALL_ABI[0]).toLowerCase()) {
          const multicall = decodeFunctionData({ abi: X402_MULTICALL_ABI, data: refundData });
          if (multicall.functionName !== "multicall" || multicall.args[0].length !== 2) {
            throw new Error("Hosted refund has unexpected bundled calls");
          }
          [claimData, refundData] = multicall.args[0];
        }
        const refund = decodeFunctionData({ abi: X402_REFUND_ABI, data: refundData });
        if (refund.functionName !== "refundWithSignature" ||
          computeChannelId(refund.args[0] as Parameters<typeof computeChannelId>[0], config.network).toLowerCase() !== row.channel_id ||
          refund.args[1] !== BigInt(String(row.original.refundAmount)) ||
          refund.args[2] !== BigInt(String(row.original.refundNonce))) {
          throw new Error("Hosted refund transaction differs from its original request");
        }
        if (claimData) {
          const claim = decodeFunctionData({ abi: X402_CLAIM_ABI, data: claimData });
          if (claim.functionName !== "claimWithSignature" || claim.args[0].length !== 1 ||
            !claim.args[0].some((source) =>
              computeChannelId(source.voucher.channel, config.network).toLowerCase() === row.channel_id &&
              source.voucher.maxClaimableAmount === BigInt(String(row.original.signed)) &&
              source.signature.toLowerCase() === String(row.original.signature).toLowerCase() &&
              source.totalClaimed === BigInt(String(row.original.charged)))) {
            throw new Error("Hosted refund did not consume its original claim voucher");
          }
        } else if (BigInt(String(row.original.charged)) > BigInt(String(row.original.claimedBefore))) {
          throw new Error("Hosted refund did not include its original claim");
        }
      }
      const event = row.rail === "x402"
        ? row.operation === "refund" ? X402_REFUNDED_EVENT : X402_SETTLED_EVENT
        : row.operation === "close" ? TEMPO_CLOSED_EVENT : TEMPO_SETTLED_EVENT;
      if (!event) throw new Error("Hosted effect event is unsupported");
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== row.contract) continue;
        try {
          const decoded = decodeEventLog({ abi: [event], data: log.data, topics: log.topics });
          const args = decoded.args as Record<string, unknown>;
          if (row.rail === "x402" && row.operation === "settle" &&
            String(args.receiver).toLowerCase() === this.x402?.receiver.toLowerCase() &&
            String(args.token).toLowerCase() === this.x402?.token.toLowerCase()) {
            delta = BigInt(String(args.amount));
          } else if (row.rail === "x402" && row.operation === "refund" &&
            String(args.channelId).toLowerCase() === row.channel_id &&
            BigInt(String(args.amount)) === BigInt(String(row.original.refundAmount))) {
            delta = BigInt(String(row.original.charged)) - BigInt(String(row.original.claimedBefore));
          } else if (row.rail === "tempo" && String(args.channelId).toLowerCase() === row.channel_id &&
            String(args.payee).toLowerCase() === this.tempo?.payee.toLowerCase()) {
            delta = row.operation === "close" ? BigInt(String(args.settledToPayee)) -
              BigInt(String(row.original.settledOnChain)) : BigInt(String(args.deltaPaid));
          }
        } catch { /* A different event in the same receipt is not this obligation's proof. */ }
      }
    }
    if (delta === undefined || delta < 0n) throw new Error("Hosted effect has no matching positive or zero result");
    if (row.report_payload && (row.rail === "tempo" || row.operation === "settle")) {
      const reported = row.report_payload.nativeAmount;
      if (typeof reported !== "number" || !Number.isSafeInteger(reported) ||
        reported < 0 || BigInt(reported) !== delta) {
        throw new Error("Hosted payout amount differs from finalized original effect");
      }
    }
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    const currentFinal = await client.getBlock({ blockTag: "finalized" });
    if (canonical.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
      currentFinal.number === null || currentFinal.number < receipt.blockNumber) {
      throw new Error("Hosted effect finality changed");
    }
    await transaction(this.pool, async (tx) => {
      const current = await this.lockRow(tx, id);
      if (current.tx_hash?.toLowerCase() !== row.tx_hash!.toLowerCase() ||
        (current.block_hash && current.block_hash.toLowerCase() !== receipt.blockHash.toLowerCase()) ||
        (current.delta_native && BigInt(current.delta_native) !== delta)) {
        throw new Error("Hosted effect observation conflicts with durable original");
      }
      const noReport = delta === 0n && (row.operation === "refund" || row.operation === "close");
      await tx.query(
        `UPDATE sdk_hosted_settlement_report_obligations
            SET block_number=$2,block_hash=$3,delta_native=$4,
                state=CASE WHEN $5 THEN 'no_report'
                           WHEN delivered_at_ms IS NOT NULL THEN 'delivered' ELSE 'observed' END,
                updated_at_ms=FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint
          WHERE id=$1`, [id, receipt.blockNumber.toString(), receipt.blockHash.toLowerCase(),
          delta.toString(), noReport]
      );
    });
    return { id, txHash: row.tx_hash, blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash, deltaNative: delta.toString() };
  }

  private async lockRow(tx: Query, id: string): Promise<ObligationRow> {
    const result = await tx.query<ObligationRow>(
      "SELECT * FROM sdk_hosted_settlement_report_obligations WHERE id=$1 FOR UPDATE", [id]
    );
    const row = result.rows[0];
    if (!row || row.dvm_id !== this.dvmId || row.scope !== this.scope) {
      throw new Error("Hosted settlement obligation is not owned by this mount");
    }
    return row;
  }

  async unresolvedCount(query: Query = this.pool): Promise<number> {
    const result = await query.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sdk_hosted_settlement_report_obligations
       WHERE ${HOSTED_SETTLEMENT_UNRESOLVED_SQL}`
    );
    return Number(result.rows[0].n);
  }

  async hasCompleteHistory(query: Query = this.pool): Promise<boolean> {
    const result = await query.query<{ complete: boolean }>(
      "SELECT complete FROM sdk_hosted_settlement_report_history WHERE singleton=TRUE"
    );
    return result.rows[0]?.complete === true;
  }

  private async lockIdentity(tx: PoolClient): Promise<{ instanceId: string; bootEpoch: string }> {
    const result = await tx.query<{ instance_id: string | null; boot_epoch: string }>(
      "SELECT instance_id,boot_epoch FROM sdk_hosting_control WHERE dvm_id=$1 AND scope=$2 FOR UPDATE",
      [this.dvmId, this.scope]
    );
    if (!result.rows[0]?.instance_id || !BigInt(result.rows[0].boot_epoch)) {
      throw new Error("Hosted settlement identity is unavailable");
    }
    return { instanceId: result.rows[0].instance_id, bootEpoch: result.rows[0].boot_epoch };
  }

  private async insert(
    tx: PoolClient, identity: { instanceId: string; bootEpoch: string }, rail: Rail,
    operation: Operation, network: string, contract: string, channelId: string,
    original: Record<string, unknown>, operationIdentity: unknown[]
  ): Promise<HostedEffectReservation> {
    const priorNoEffect = await tx.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail=$3 AND operation=$4 AND channel_id=$5
         AND state='no_report'`,
      [this.dvmId, this.scope, rail, operation, channelId]
    );
    const sourceKey = hash([this.dvmId, this.scope, rail, operation, network, contract.toLowerCase(),
      channelId, operationIdentity, priorNoEffect.rows[0].n]);
    const competing = await tx.query<{ source_key: string }>(
      `SELECT source_key FROM sdk_hosted_settlement_report_obligations
       WHERE dvm_id=$1 AND scope=$2 AND rail=$3 AND operation=$4 AND channel_id=$5
         AND state NOT IN ('delivered','no_report') FOR UPDATE`,
      [this.dvmId, this.scope, rail, operation, channelId]
    );
    if (competing.rows.some((row) => row.source_key !== sourceKey)) {
      throw new Error("Hosted settlement has another unresolved original effect");
    }
    const id = randomUUID();
    const result = await tx.query<{ id: string }>(
      `INSERT INTO sdk_hosted_settlement_report_obligations
        (id,source_key,dvm_id,scope,instance_id,boot_epoch,rail,operation,network,
         contract,channel_id,original,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved')
       ON CONFLICT (source_key) DO NOTHING RETURNING id`,
      [id, sourceKey, this.dvmId, this.scope, identity.instanceId, identity.bootEpoch,
        rail, operation, network, contract.toLowerCase(), channelId, JSON.stringify(original)]
    );
    if (result.rows[0]) return { id, replayed: false };
    const prior = await tx.query<ObligationRow>(
      "SELECT * FROM sdk_hosted_settlement_report_obligations WHERE source_key=$1", [sourceKey]
    );
    const row = prior.rows[0];
    if (!row || row.dvm_id !== this.dvmId || row.scope !== this.scope ||
      row.instance_id !== identity.instanceId ||
      !isDeepStrictEqual(row.original, original)) throw new Error("Hosted settlement source replay conflicts");
    return { id: row.id, replayed: true };
  }
}

/** Restart a terminal close-report search after the operator repairs incomplete RPC history. */
export async function retryHostedTempoCloseReport(args: {
  db: Pool;
  dvmId: string;
  scope: string;
  obligationId: string;
}): Promise<boolean> {
  const obligations = new HostedSettlementReportObligations(args.db, args.dvmId, args.scope);
  return obligations.reopenTempoClose(args.obligationId);
}

export interface HostedTempoCloseReportWriteOff {
  channelId: string;
  /** Builder payout abandoned, as a decimal string in native token units. */
  amountForgoneNative: string;
}

interface WriteOffHostedTempoCloseReportArgs {
  db: Pool; dvmId: string; scope: string; obligationId: string; note: string;
}

/** Forgo an unmatched builder payout report; includeDetails returns the amount without another read. */
export function writeOffHostedTempoCloseReport(
  args: WriteOffHostedTempoCloseReportArgs & { includeDetails: true }
): Promise<HostedTempoCloseReportWriteOff | false>;
export function writeOffHostedTempoCloseReport(
  args: WriteOffHostedTempoCloseReportArgs & { includeDetails?: false }
): Promise<boolean>;
export async function writeOffHostedTempoCloseReport(
  args: WriteOffHostedTempoCloseReportArgs & { includeDetails?: boolean }
): Promise<boolean | HostedTempoCloseReportWriteOff> {
  const note = args.note.trim();
  if (!note || note.length > 2_000) throw new Error("A write-off requires a note of 1 to 2000 characters");
  const row = await new HostedSettlementReportObligations(args.db, args.dvmId, args.scope)
    .writeOffTempoClose(args.obligationId, note);
  if (!row) return false;
  return args.includeDetails ? { channelId: row.channelId, amountForgoneNative: row.amount } : true;
}

function tempoCloseAmount(original: Record<string, unknown>): string {
  return (BigInt(String(original.highestVoucherAmount)) - BigInt(String(original.settledOnChain))).toString();
}

function searchCursor(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}
