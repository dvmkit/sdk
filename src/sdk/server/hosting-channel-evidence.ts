import { createHash } from "node:crypto";

import { Session as TempoSession } from "mppx/tempo";
import type { Pool, PoolClient } from "pg";
import { createPublicClient, http } from "viem";

import { resolveRpcOverride } from "../../lib/payment-rails/rpc";
import { X402_BATCH_CHANNEL_ABI } from "../../lib/x402/batch-abi";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import { parseStoreValue } from "./store-json";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import { resolveTempoNetwork, TEMPO_MODERATO_CHAIN_ID, TEMPO_MODERATO_RPC } from "./mpp-setup";

type Query = Pick<Pool | PoolClient, "query">;
type Row = Record<string, unknown>;

export interface HostedChannelSnapshot {
  digest: string;
  present: string[];
  x402HistoryComplete: boolean | null;
  tempoHistoryComplete: boolean | null;
  x402: Row[];
  x402Tombstones: Row[];
  x402Settlements: Row[];
  tempo: Row[];
  tempoTombstones: Row[];
  tempoCloses: Row[];
  effects: Row[];
}

export interface HostedChannelObservation {
  digest: string;
  x402: { chainId: number; blockNumber: string; blockHash: string; channels: string[] } | null;
  tempo: { chainId: number; blockNumber: string; blockHash: string; channels: string[] } | null;
  reasons: string[];
}

function unsigned(value: unknown): bigint | undefined {
  if (typeof value !== "string" && typeof value !== "bigint") return undefined;
  try {
    const number = BigInt(value);
    return number >= 0n ? number : undefined;
  } catch {
    return undefined;
  }
}

function hex(value: unknown, bytes: number): value is `0x${string}` {
  return typeof value === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);
}

async function rows(query: Query, table: string, order: string): Promise<Row[]> {
  const result = await query.query<Row>(`SELECT * FROM ${table} ORDER BY ${order}`);
  return result.rows;
}

/** Exact local rows are compared again under the closure lock after every RPC read. */
export async function readHostedChannelSnapshot(query: Query): Promise<HostedChannelSnapshot> {
  const names = ["x402_batch_channels", "x402_batch_settlements", "mpp_tempo_channels",
    "mpp_tempo_close_intents", "x402_batch_channel_tombstones", "mpp_tempo_channel_tombstones",
    "x402_batch_channel_history", "mpp_tempo_channel_history",
    "sdk_hosted_settlement_report_obligations"];
  const present = await query.query<{ name: string; exists: boolean }>(
    "SELECT name, to_regclass(name) IS NOT NULL AS exists FROM unnest($1::text[]) AS name", [names]
  );
  const exists = new Set(present.rows.filter((row) => row.exists).map((row) => row.name));
  const x402 = exists.has(names[0]) ? await rows(query, names[0], "channel_id") : [];
  const x402Settlements = exists.has(names[1]) ? await rows(query, names[1], "settlement_id") : [];
  const tempo = exists.has(names[2]) ? await rows(query, names[2], "channel_key") : [];
  const tempoCloses = exists.has(names[3]) ? await rows(query, names[3], "channel_id") : [];
  const x402Tombstones = exists.has(names[4]) ? await rows(query, names[4], "channel_id") : [];
  const tempoTombstones = exists.has(names[5]) ? await rows(query, names[5], "channel_key") : [];
  const effects = exists.has(names[8]) ? await rows(query, names[8], "source_key") : [];
  const history = async (table: string): Promise<boolean | null> => {
    if (!exists.has(table)) return null;
    const result = await query.query<{ complete: boolean }>(`SELECT complete FROM ${table} WHERE singleton=TRUE`);
    return result.rows.length === 1 ? result.rows[0].complete === true : false;
  };
  const x402HistoryComplete = await history(names[6]);
  const tempoHistoryComplete = await history(names[7]);
  const digest = createHash("sha256").update(JSON.stringify({ present: [...exists].sort(), x402, x402Tombstones,
    x402Settlements, tempo, tempoTombstones, tempoCloses, effects,
    x402HistoryComplete, tempoHistoryComplete })).digest("hex");
  return { digest, present: [...exists], x402, x402Tombstones, x402Settlements,
    tempo, tempoTombstones, tempoCloses, effects, x402HistoryComplete, tempoHistoryComplete };
}

type Client = ReturnType<typeof createPublicClient>;

async function finalized(client: Client, expectedChainId: number) {
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) throw new Error("configured RPC chain mismatch");
  const block = await client.getBlock({ blockTag: "finalized" });
  if (block.number === null || !hex(block.hash, 32)) throw new Error("finalized block unavailable");
  return { chainId, number: block.number, hash: block.hash };
}

async function stillFinalized(client: Client, selected: { number: bigint; hash: string }) {
  const [canonical, current] = await Promise.all([
    client.getBlock({ blockNumber: selected.number }),
    client.getBlock({ blockTag: "finalized" }),
  ]);
  if (canonical.hash.toLowerCase() !== selected.hash.toLowerCase() ||
    current.number === null || current.number < selected.number) {
    throw new Error("finalized block changed");
  }
}

async function verifyOriginalEffect(client: Client, effect: Row, selected: bigint,
  contract: string, requireSignedCall: boolean): Promise<bigint> {
  const number = unsigned(effect.block_number);
  const delta = unsigned(effect.delta_native);
  if (!hex(effect.tx_hash, 32) || !hex(effect.block_hash, 32) || number === undefined ||
    number > selected || delta === undefined || effect.contract !== contract ||
    (effect.state !== "delivered" && effect.state !== "no_report") ||
    (effect.state === "no_report" && (delta !== 0n ||
      (effect.operation !== "refund" && effect.operation !== "close")))) {
    throw new Error("original settlement or report remains unresolved");
  }
  const [receipt, canonical] = await Promise.all([
    client.getTransactionReceipt({ hash: effect.tx_hash }),
    client.getBlock({ blockNumber: number }),
  ]);
  if (receipt.status !== "success" || receipt.blockNumber !== number ||
    receipt.transactionHash.toLowerCase() !== effect.tx_hash.toLowerCase() ||
    receipt.blockHash.toLowerCase() !== effect.block_hash.toLowerCase() ||
    canonical.hash.toLowerCase() !== effect.block_hash.toLowerCase()) {
    throw new Error("original effect receipt is not canonical at the selected block");
  }
  if (requireSignedCall) {
    const original = effect.original as Record<string, unknown> | undefined;
    const call = original?.authorizationCallData;
    if (typeof call !== "string" || !/^0x(?:[0-9a-f]{2})+$/i.test(call)) {
      throw new Error("original signed call is unknown");
    }
    const transaction = await client.getTransaction({ hash: effect.tx_hash });
    if (transaction.to?.toLowerCase() !== contract ||
      transaction.input.toLowerCase() !== call.toLowerCase()) {
      throw new Error("original signed call differs from the finalized transaction");
    }
  }
  return delta;
}

/** Private SDK-owned reader; the authenticated HTTP request supplies no RPC or proof material. */
export class HostedChannelEvidenceReader {
  private constructor(
    private readonly pool: Pool,
    private readonly x402?: { client: Client; chainId: number },
    private readonly tempo?: { client: Client; chainId: number; currency: string }
  ) {}

  static async fromServerConfig(pool: Pool, config: {
    x402?: { network: string; rpcUrl?: string };
    tempoEnv?: Record<string, string>;
  }): Promise<HostedChannelEvidenceReader> {
    let x402: { client: Client; chainId: number } | undefined;
    if (config.x402) {
      const spec = x402NetworkByCaip2(config.x402.network);
      if (spec) {
        const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
        const chain = chains[spec.viemChain] as Parameters<typeof createPublicClient>[0]["chain"];
        if (chain) {
          const rpcUrl = resolveRpcOverride(config.x402.rpcUrl, chain.rpcUrls.default.http[0]).url;
          x402 = { client: createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as Client,
            chainId: chain.id };
        }
      }
    }
    let tempo: { client: Client; chainId: number; currency: string } | undefined;
    if (config.tempoEnv) {
      const network = resolveTempoNetwork(config.tempoEnv);
      const { tempo: mainnet, tempoModerato: moderato } = await import("viem/chains");
      const chain = network.chainId === TEMPO_MODERATO_CHAIN_ID ? moderato : mainnet;
      const rpcUrl = resolveRpcOverride(config.tempoEnv.DVMKIT_TEMPO_RPC_URL,
        network.chainId === TEMPO_MODERATO_CHAIN_ID ? TEMPO_MODERATO_RPC : chain.rpcUrls.default.http[0]).url;
      tempo = { client: createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as Client,
        chainId: network.chainId, currency: network.currency.toLowerCase() };
    }
    return new HostedChannelEvidenceReader(pool, x402, tempo);
  }

  async observe(identity?: { dvmId: string; scope: string; instanceId: string }): Promise<HostedChannelObservation> {
    const snapshot = await readHostedChannelSnapshot(this.pool);
    const observation: HostedChannelObservation = { digest: snapshot.digest, x402: null, tempo: null, reasons: [] };
    if ((snapshot.present.includes("x402_batch_channels") ||
      snapshot.present.includes("x402_batch_channel_tombstones")) &&
      snapshot.x402HistoryComplete !== true) {
      observation.reasons.push("x402_channel_history_incomplete");
    }
    if ((snapshot.present.includes("mpp_tempo_channels") ||
      snapshot.present.includes("mpp_tempo_channel_tombstones")) &&
      snapshot.tempoHistoryComplete !== true) {
      observation.reasons.push("tempo_channel_history_incomplete");
    }
    if (this.x402 && !snapshot.present.includes("x402_batch_channel_tombstones")) {
      observation.reasons.push("x402_channel_history_missing");
    }
    if (this.tempo && (!snapshot.present.includes("mpp_tempo_channels") ||
      !snapshot.present.includes("mpp_tempo_close_intents") ||
      !snapshot.present.includes("mpp_tempo_channel_tombstones"))) {
      observation.reasons.push("tempo_channel_history_missing");
    }
    if (snapshot.x402.length || snapshot.x402Tombstones.length ||
      snapshot.effects.some((effect) => effect.rail === "x402")) {
      try {
        observation.x402 = await this.observeX402(snapshot, identity);
      } catch {
        observation.reasons.push("x402_channel_evidence_unresolved");
      }
    }
    if (snapshot.tempo.length || snapshot.tempoTombstones.length || snapshot.tempoCloses.length ||
      snapshot.effects.some((effect) => effect.rail === "tempo")) {
      try {
        observation.tempo = await this.observeTempo(snapshot, identity);
      } catch {
        observation.reasons.push("tempo_channel_evidence_unresolved");
      }
    }
    return observation;
  }

  private async observeX402(snapshot: HostedChannelSnapshot,
    identity?: { dvmId: string; scope: string; instanceId: string }
  ): Promise<NonNullable<HostedChannelObservation["x402"]>> {
    if (!this.x402 || !identity || snapshot.x402Settlements.some((row) => row.status !== "complete")) {
      throw new Error("x402 settlement unresolved");
    }
    const { client, chainId } = this.x402;
    const block = await finalized(client, chainId);
    const channels: string[] = [];
    const channelIds = new Set([...snapshot.x402, ...snapshot.x402Tombstones].map((row) => row.channel_id));
    if (snapshot.effects.some((effect) => effect.rail === "x402" &&
      (effect.operation === "claim" || effect.operation === "refund") &&
      !channelIds.has(effect.channel_id))) throw new Error("original x402 channel disappeared");
    for (const row of [...snapshot.x402, ...snapshot.x402Tombstones]) {
      if (!hex(row.channel_id, 32)) throw new Error("invalid channel");
      if (row.pending_request !== null) {
        const pending = row.pending_request;
        const pendingId = pending && typeof pending === "object" && !Array.isArray(pending)
          ? (pending as Record<string, unknown>).pendingId : undefined;
        if (!snapshot.x402Tombstones.includes(row) || typeof pendingId !== "string" ||
          !snapshot.x402Settlements.some((settlement) =>
            settlement.channel_id === row.channel_id && settlement.pending_id === pendingId &&
            settlement.status === "complete")) throw new Error("x402 request remains pending");
      }
      const binding = row.hosting_binding;
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
        throw new Error("historical x402 channel has no original network");
      }
      const original = binding as Record<string, unknown>;
      if (original.network !== `eip155:${chainId}` || original.chainId !== chainId ||
        original.contract !== BATCH_SETTLEMENT_ADDRESS.toLowerCase() ||
        original.version !== "x402-batch-settlement-v1" || original.channelId !== row.channel_id) {
        throw new Error("x402 channel original contract differs from configured chain");
      }
      const charged = unsigned(row.charged_cumulative_amount);
      const signed = unsigned(row.signed_max_claimable);
      const localNonce = unsigned(row.refund_nonce);
      if (charged === undefined || signed === undefined || localNonce === undefined) throw new Error("unpriced channel");
      const originalEffects = snapshot.effects.filter((effect) => effect.rail === "x402" &&
        (effect.operation === "claim" || effect.operation === "refund") &&
        effect.channel_id === row.channel_id);
      const intervals: Array<{ start: bigint; end: bigint }> = [];
      const refundNonces: bigint[] = [];
      for (const effect of originalEffects) {
        if (effect.dvm_id !== identity.dvmId || effect.scope !== identity.scope ||
          effect.instance_id !== identity.instanceId || effect.network !== original.network) {
          throw new Error("original x402 effect has another owner or chain");
        }
        const delta = await verifyOriginalEffect(client, effect, block.number,
          BATCH_SETTLEMENT_ADDRESS.toLowerCase(), true);
        const source = effect.original as Record<string, unknown> | undefined;
        const start = unsigned(source?.claimedBefore);
        const end = unsigned(source?.charged);
        if (start === undefined || end === undefined || end < start || end - start !== delta) {
          throw new Error("original x402 claim interval is incomplete");
        }
        if (end > start) intervals.push({ start, end });
        if (effect.operation === "refund") {
          const preRefundNonce = unsigned(source?.refundNonce);
          if (preRefundNonce === undefined) throw new Error("original x402 refund nonce is unknown");
          refundNonces.push(preRefundNonce);
        }
      }
      intervals.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : 0);
      let covered = 0n;
      for (const interval of intervals) {
        if (interval.start !== covered) throw new Error("original x402 claims have a gap or duplicate");
        covered = interval.end;
      }
      if (covered < charged || covered < signed) {
        throw new Error("original x402 effects do not cover accepted voucher authority");
      }
      refundNonces.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      for (let index = 0; index < refundNonces.length; index++) {
        if (refundNonces[index] !== BigInt(index)) {
          throw new Error("original x402 refunds have a gap or duplicate nonce");
        }
      }
      const [state, withdrawal, nonce] = await Promise.all([
        client.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: X402_BATCH_CHANNEL_ABI,
          functionName: "channels", args: [row.channel_id], blockNumber: block.number }),
        client.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: X402_BATCH_CHANNEL_ABI,
          functionName: "pendingWithdrawals", args: [row.channel_id], blockNumber: block.number }),
        client.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi: X402_BATCH_CHANNEL_ABI,
          functionName: "refundNonce", args: [row.channel_id], blockNumber: block.number }),
      ]);
      const [balance, claimed] = state as readonly [bigint, bigint];
      const [pending, initiatedAt] = withdrawal as readonly [bigint, number];
      if (balance !== claimed || BigInt(pending) !== 0n || initiatedAt !== 0 ||
        claimed !== covered || localNonce > BigInt(refundNonces.length) ||
        (nonce as bigint) !== BigInt(refundNonces.length)) {
        throw new Error("x402 balance, original claims, or refunds remain unresolved");
      }
      channels.push(row.channel_id);
    }
    for (const effect of snapshot.effects.filter((row) => row.rail === "x402" && row.operation === "settle")) {
      if (effect.dvm_id !== identity.dvmId || effect.scope !== identity.scope ||
        effect.instance_id !== identity.instanceId || effect.network !== `eip155:${chainId}`) {
        throw new Error("original x402 payout has another owner or chain");
      }
      await verifyOriginalEffect(client, effect, block.number,
        BATCH_SETTLEMENT_ADDRESS.toLowerCase(), false);
    }
    await stillFinalized(client, block);
    return { chainId, blockNumber: block.number.toString(), blockHash: block.hash, channels };
  }

  private async observeTempo(snapshot: HostedChannelSnapshot,
    identity?: { dvmId: string; scope: string; instanceId: string }
  ): Promise<NonNullable<HostedChannelObservation["tempo"]>> {
    const tempoRows = [...snapshot.tempo, ...snapshot.tempoTombstones.filter((row) =>
      !snapshot.tempo.some((live) => live.channel_key === row.channel_key))];
    if (!this.tempo || !identity || snapshot.tempoCloses.length !== tempoRows.length ||
      snapshot.tempoCloses.some((close) => !tempoRows.some((row) => row.channel_key === close.channel_id))) {
      throw new Error("Tempo close facts incomplete");
    }
    const { client, chainId, currency } = this.tempo;
    const block = await finalized(client, chainId);
    const channels: string[] = [];
    if (snapshot.effects.some((effect) => effect.rail === "tempo" &&
      !tempoRows.some((row) => row.channel_key === effect.channel_id))) {
      throw new Error("original Tempo channel disappeared");
    }
    for (const row of tempoRows) {
      const state = typeof row.state_json === "string" ? parseStoreValue(row.state_json) : undefined;
      if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Tempo state invalid");
      const local = state as Record<string, unknown>;
      const channelId = local.channelId;
      const escrow = local.escrowContract;
      const payer = local.payer;
      const payee = local.payee;
      const close = snapshot.tempoCloses.find((item) => item.channel_id === channelId);
      const spent = unsigned(local.spent);
      const highest = unsigned(local.highestVoucherAmount);
      const settled = unsigned(local.settledOnChain);
      const deposit = unsigned(local.deposit);
      const requested = unsigned(local.closeRequestedAt);
      if (!hex(channelId, 32) || row.channel_key !== channelId.toLowerCase() ||
        !hex(escrow, 20) || escrow.toLowerCase() !== TempoSession.Precompile.Constants.tip20ChannelEscrow.toLowerCase() ||
        !hex(payer, 20) || !hex(payee, 20) ||
        local.chainId !== chainId || String(local.token).toLowerCase() !== currency ||
        local.finalized !== true || spent === undefined || highest === undefined ||
        settled === undefined || deposit === undefined || requested === undefined ||
        !close || close.forecast_pending !== false || !hex(close.reference, 32)) {
        throw new Error("Tempo local close evidence incomplete");
      }
      const [chain, receipt] = await Promise.all([
        TempoSession.Precompile.Chain.getChannelState(client, channelId, escrow, block.number),
        client.getTransactionReceipt({ hash: close.reference }),
      ]);
      if (chain.deposit !== 0n || chain.settled < spent ||
        chain.settled < settled || receipt.status !== "success" || receipt.blockNumber > block.number ||
        receipt.transactionHash.toLowerCase() !== close.reference.toLowerCase() ||
        !hex(receipt.blockHash, 32)) throw new Error("Tempo chain close not complete");
      const receiptBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receiptBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
        throw new Error("Tempo close receipt is not canonical");
      }
      const event = TempoSession.Precompile.Chain.getChannelEvent({ ...receipt,
        logs: receipt.logs.filter((log) => log.address.toLowerCase() === escrow.toLowerCase()) },
      "ChannelClosed", channelId);
      const amounts = TempoSession.Precompile.Chain.readChannelClosedReceiptFields(event);
      if (chain.settled + amounts.refundedToPayer < highest) {
        throw new Error("Tempo close did not cover the accepted voucher");
      }
      const effects = snapshot.effects.filter((effect) => effect.rail === "tempo" &&
        effect.channel_id === channelId);
      const closes = effects.filter((effect) => effect.operation === "close" &&
        effect.tx_hash === close.reference);
      if (closes.length !== 1) throw new Error("Tempo close has no original effect");
      for (const effect of effects) {
        if (effect.dvm_id !== identity.dvmId || effect.scope !== identity.scope ||
          effect.instance_id !== identity.instanceId || effect.network !== `eip155:${chainId}`) {
          throw new Error("original Tempo effect has another owner or chain");
        }
        const delta = await verifyOriginalEffect(client, effect, block.number,
          escrow.toLowerCase(), false);
        if (effect.operation === "close") {
          const original = effect.original as Record<string, unknown> | undefined;
          const before = unsigned(original?.settledOnChain);
          const accepted = unsigned(original?.highestVoucherAmount);
          if (before === undefined || accepted === undefined ||
            before + delta !== chain.settled || accepted < highest ||
            effect.block_hash !== receipt.blockHash.toLowerCase()) {
            throw new Error("Tempo original close does not discharge the accepted spend");
          }
        }
      }
      channels.push(channelId);
    }
    await stillFinalized(client, block);
    return { chainId, blockNumber: block.number.toString(), blockHash: block.hash, channels };
  }
}
