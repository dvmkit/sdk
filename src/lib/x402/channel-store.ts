import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type {
  BatchSettlementClientContext,
  ClientChannelStorage,
} from "@x402/evm/batch-settlement/client";
import lockfile from "proper-lockfile";

import { X402_CHANNELS_FILE } from "../../defaults";
import { ensureConfigDir } from "../config-dir";
import { fundingReachableAt, listCredits, type StoredCredit } from "../credit-store";
import { DvmError } from "../errors";
import { X402_EXACT_AUTHORIZATION_TTL_SECONDS } from "../payment-authorization-bounds";
import type { X402Version } from "./spec";
import {
  type PendingX402Funding,
  x402PendingBlockExpiresAt,
  x402PendingRetired,
  x402PendingStale,
} from "./voucher-pending";
export {
  type PendingX402Funding,
  X402_PENDING_STALE_MS,
  x402PendingBlockExpiresAt,
  x402PendingDepositExpiresAt,
  x402PendingRetired,
  x402PendingStale,
  x402PendingUnsettled,
} from "./voucher-pending";


/** Immutable channel configuration needed by the unilateral withdrawal verbs. */
export interface StoredX402ChannelConfig {
  payer: `0x${string}`;
  payerAuthorizer: `0x${string}`;
  receiver: `0x${string}`;
  receiverAuthorizer: `0x${string}`;
  token: `0x${string}`;
  withdrawDelay: number;
  salt: `0x${string}`;
}

/** Caller metadata that connects an upstream channel record to one DVM credit. */
export interface StoredX402ChannelMetadata {
  channelId: `0x${string}`;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  network: string;
  config: StoredX402ChannelConfig;
  updatedAt: number;
}

/** Provenance for an upstream balance write that did not read the contract. */
export type X402UnobservedBalanceProvenance = "unreconciled" | "unchanged";

/**
 * An `exact`-scheme authorization retained until its funding response is
 * acknowledged.
 *
 * Kept apart from {@link PendingX402Funding} rather than folded into it: that
 * record's `channelId` is load-bearing for every reusable-channel consumer —
 * the exposure and withdrawal gates, the rival-voucher check, the timed exit's
 * guaranteed figure — and an exact authorization belongs to no channel. What
 * both records share is the one property that matters here: the verbatim header
 * is journalled before it is submitted, so a retry re-presents it rather than
 * signing a second one.
 */
export interface PendingX402ExactFunding {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  fundId: string;
  amountMicro: number;
  /**
   * The refill target this funding was working towards, journalled beside the
   * amount because `recordFundResponse` writes it unconditionally: a resume
   * that dropped it would answer the DVM's reported balance back into the
   * credit's target and quietly retune every later auto-refill.
   */
  targetMicro: number;
  paymentHeader: string;
  /** Generation the header was built for — the resubmit must declare the same one. */
  x402Version: X402Version;
  /**
   * What the signature is worth locally, captured at signing time. The budget
   * ledger books the *signed* figure rather than the caller's ask, and a resume
   * must be able to book it without a fresh rate lookup — an fx outage may not
   * stand between a presented authorization and its record.
   */
  amountMsats: number;
  btcRate: number;
  requestedAt: number;
  /**
   * Unix seconds after which the ERC-3009 authorization can no longer settle.
   * Absent when the header would not decode; every read falls back to
   * {@link X402_EXACT_AUTHORIZATION_TTL_SECONDS} past `requestedAt` instead of
   * inventing a timestamp of its own.
   */
  authorizationValidBefore?: string;
}

/**
 * Whether an exact authorization has passed the point where it can settle.
 *
 * A dead header is worth nothing to a retry — re-presenting it earns a
 * facilitator refusal — so it stops being resumable and the next funding of
 * that credit signs afresh. This is what makes the exact journal self-clearing,
 * and why it needs no `x402-clear-pending` escape hatch of its own: unlike a
 * cumulative voucher, which `claim()` accepts with no expiry at all, this entry
 * cannot wedge a credit past its own deadline.
 *
 * That holds for an unreadable header too, which is why the fallback is the
 * signer's own TTL rather than the channel side's 24-hour staleness line: every
 * entry here was written from a header this build had just signed, so the
 * authorization it names cannot outlive `requestedAt` by more than that window
 * whether or not the bytes decode on the way back in. A credit blocked on one
 * clears itself minutes later, not a day later.
 */
export function x402ExactFundingDead(pending: PendingX402ExactFunding, now = Date.now()): boolean {
  const seconds = pending.authorizationValidBefore ? Number(pending.authorizationValidBefore) : NaN;
  return Number.isFinite(seconds)
    ? now >= seconds * 1000
    : now >= pending.requestedAt + X402_EXACT_AUTHORIZATION_TTL_SECONDS * 1000;
}

/** Persist a verbatim exact header before it is submitted, replacing this credit's last. */
export function recordPendingX402ExactFunding(pending: PendingX402ExactFunding): void {
  const { file, credits } = loadFundingFile();
  file.exact = [
    ...file.exact.filter((entry) => !sameFundingCredit(entry, pending, credits)),
    pending,
  ];
  saveFile(file);
}

/** The exact authorization this credit can still re-present, if any. */
export function loadResumableX402ExactFunding(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  now?: number;
}): PendingX402ExactFunding | undefined {
  const { file, credits } = loadFundingFile();
  return file.exact.find(
    (entry) => sameFundingCredit(entry, args, credits) && !x402ExactFundingDead(entry, args.now)
  );
}

/** Every exact authorization a sweep could still re-present, optionally scoped to one DVM identity. */
export function listResumableX402ExactFundings(
  filter: {
    endpoint?: string;
    callerPubkey?: string;
    now?: number;
  } = {}
): PendingX402ExactFunding[] {
  const endpoint = filter.endpoint ? normalizeEndpoint(filter.endpoint) : undefined;
  const { file, credits } = loadFundingFile();
  return file.exact.filter(
    (entry) =>
      (!endpoint || fundingReachableAt(entry, endpoint, credits)) &&
      (!filter.callerPubkey || entry.callerPubkey === filter.callerPubkey) &&
      !x402ExactFundingDead(entry, filter.now)
  );
}

/**
 * Forget one exact authorization, because it was acknowledged, definitively
 * refused, or has passed its own deadline. Matched on the fund id as well as
 * the credit key, so a sweep clearing a lapsed entry cannot drop a fresher one
 * a sibling process journalled in the meantime.
 */
export function clearPendingX402ExactFunding(pending: PendingX402ExactFunding): void {
  const { file } = loadFundingFile();
  const key = pendingKey(pending);
  file.exact = file.exact.filter(
    (entry) => pendingKey(entry) !== key || entry.fundId !== pending.fundId
  );
  saveFile(file);
}

/**
 * One journal entry in the shape every CLI surface puts on the wire. Shared, so
 * an agent reading a drain, a timed exit and `x402-clear-pending` sees the same
 * fields for the same entry rather than three dialects of it.
 */
export function x402PendingFundingJson(entry: PendingX402Funding): Record<string, unknown> {
  return {
    credit_id: entry.creditId,
    fund_id: entry.fundId,
    endpoint: entry.endpoint,
    channel_id: entry.channelId,
    amount_micro: entry.amountMicro,
    // What the ERC-3009 authorization can still pull, which is the figure a
    // `--force` retirement is really deciding about: a deposit's authorized
    // value can exceed the amount funded, so `amount_micro` alone
    // understates it. Null on a voucher-only payload, which authorizes no
    // deposit at all.
    deposit_micro: entry.depositMicro ?? null,
    signed_max_claimable_micro: entry.maxClaimableMicro ?? null,
    requested_at: new Date(entry.requestedAt).toISOString(),
    stale: x402PendingStale(entry),
    ...(entry.authorizationValidBefore
      ? {
          authorization_valid_before: new Date(
            Number(entry.authorizationValidBefore) * 1000
          ).toISOString(),
        }
      : {}),
    ...(entry.refusedAt !== undefined
      ? {
          refused_at: new Date(entry.refusedAt).toISOString(),
          funding_blocked_until: new Date(x402PendingBlockExpiresAt(entry)).toISOString(),
        }
      : {}),
    ...(entry.supersededAt !== undefined
      ? {
          superseded_at: new Date(entry.supersededAt).toISOString(),
          funding_blocked_until: new Date(x402PendingBlockExpiresAt(entry)).toISOString(),
        }
      : {}),
  };
}

interface ChannelRecord {
  acknowledgedCumulativeAmount?: string;
  /**
   * When `context.balance` last took a figure that the chain has not confirmed
   * since.
   *
   * Both a replay acknowledgement and a DVM's settlement response can disagree
   * with the contract: the first applies a journalled deposit locally, and the
   * second reports what the DVM believes settled. A `channels()` read is the
   * one write that settles either question, so both weaker sources carry this
   * same stamp until one lands.
   */
  unreconciledBalanceAt?: number;
  context?: BatchSettlementClientContext;
  metadata?: StoredX402ChannelMetadata;
}

interface X402ChannelFile {
  version: 1;
  channels: Partial<Record<string, ChannelRecord>>;
  pending: PendingX402Funding[];
  exact: PendingX402ExactFunding[];
}

const EMPTY: X402ChannelFile = { version: 1, channels: {}, pending: [], exact: [] };
const x402LockOwner = new AsyncLocalStorage<{ active: boolean }>();

/**
 * Serialize voucher creation and acknowledgement across CLI processes. A
 * cumulative voucher is a read-modify-sign operation; locking only individual
 * storage calls would let two agents sign from the same base concurrently.
 */
export async function withX402ChannelLock<T>(operation: () => Promise<T>): Promise<T> {
  if (x402LockOwner.getStore()?.active) return operation();
  ensureX402ChannelFile();
  const release = await lockfile.lock(X402_CHANNELS_FILE, {
    realpath: false,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
  });
  const owner = { active: true };
  try {
    return await x402LockOwner.run(owner, operation);
  } finally {
    owner.active = false;
    await release();
  }
}

/** File-backed implementation of upstream's `ClientChannelStorage` contract. */
export class DvmX402ChannelStorage implements ClientChannelStorage {
  private nextBalanceProvenance: { provenance: X402UnobservedBalanceProvenance } | undefined;

  get(key: string): Promise<BatchSettlementClientContext | undefined> {
    return fromSynchronousStore(() => loadFile().channels[canonicalChannelId(key)]?.context);
  }

  /** Read the highest cumulative amount a DVM has acknowledged for this channel. */
  getAcknowledgedCumulativeAmount(key: string): Promise<string | undefined> {
    return fromSynchronousStore(() =>
      readAcknowledgedCumulativeAmount(loadFile().channels[canonicalChannelId(key)])
    );
  }

  /**
   * Upstream's ordinary write. Its chain-recovery paths are authoritative and
   * clear the unreconciled stamp. DVM-response paths scope this same write to
   * persist their weaker provenance atomically with the balance.
   */
  set(key: string, context: BatchSettlementClientContext): Promise<void> {
    return fromSynchronousStore(() => {
      const provenance = this.nextBalanceProvenance?.provenance ?? "observed";
      this.nextBalanceProvenance = undefined;
      writeContext(key, context, provenance, "advance");
    });
  }

  /**
   * Apply non-chain provenance to the next upstream `set` on this instance.
   * Returns a cleanup for paths where upstream rejects or deletes instead, so a
   * later chain recovery cannot inherit a stale provenance decision.
   */
  stageNextUnobservedBalanceProvenance(provenance: X402UnobservedBalanceProvenance): () => void {
    const staged = { provenance };
    this.nextBalanceProvenance = staged;
    return () => {
      if (this.nextBalanceProvenance === staged) this.nextBalanceProvenance = undefined;
    };
  }

  /**
   * Write a context whose `balance` carries a deposit this machine added on its
   * own authority, and stamp the record as unreconciled.
   *
   * Separate from {@link set} because the two differ in exactly one thing that
   * matters later: where the figure came from. Nothing else about the write
   * differs.
   */
  setLocallyAppliedDeposit(key: string, context: BatchSettlementClientContext): Promise<void> {
    return fromSynchronousStore(() => {
      writeContext(key, context, "unreconciled", "advance");
    });
  }

  /**
   * Write a context whose `balance` is byte-for-byte the one already stored,
   * leaving the unreconciled stamp exactly as it found it.
   *
   * The replay acknowledgement's idempotent second pass is what needs this: it
   * restates a cumulative base without adding to the balance, so it observes
   * nothing and must not certify the local sum it left alone. The caller owes
   * the precondition in the name — a write that does move `balance` belongs on
   * one of the other two.
   */
  setUnchangedBalance(key: string, context: BatchSettlementClientContext): Promise<void> {
    return fromSynchronousStore(() => {
      writeContext(key, context, "unchanged", "advance");
    });
  }

  /**
   * Seed upstream's cooperative-refund probe without changing the acknowledged
   * base. Records written before have only the upstream context, so
   * `hold` adopts its acknowledged value rather than losing that base to the
   * chain floor this seeds. The seed itself is a `channels()` read, so it is
   * `observed` and settles the unreconciled question like any other.
   */
  setRefundProbe(key: string, context: BatchSettlementClientContext): Promise<void> {
    return fromSynchronousStore(() => {
      writeContext(key, context, "observed", "hold");
    });
  }

  /**
   * Replace the stored projection with a successful `channels()` read.
   *
   * Only `balance` and `totalClaimed` move. The highest DVM-acknowledged
   * cumulative base stays fail-closed, and the chain observation clears the
   * unreconciled stamp.
   */
  reconcileChainState(
    key: string,
    state: { balance: string; totalClaimed: string }
  ): Promise<void> {
    return fromSynchronousStore(() => {
      const file = loadFile();
      const id = canonicalChannelId(key);
      const record: ChannelRecord = file.channels[id] ?? {};
      file.channels[id] = channelRecordWithContext(
        record,
        { ...(record.context ?? {}), ...state },
        "observed",
        "hold"
      );
      saveFile(file);
    });
  }

  delete(key: string): Promise<void> {
    return fromSynchronousStore(() => {
      const file = loadFile();
      const id = canonicalChannelId(key);
      const record = file.channels[id];
      if (!record) return;
      if (record.metadata) file.channels[id] = { metadata: record.metadata };
      else {
        const { [id]: _removed, ...channels } = file.channels;
        file.channels = channels;
      }
      saveFile(file);
    });
  }
}

/**
 * Stage the immutable channel tuple before a signed payment leaves.
 *
 * A new channel has no earlier owner to preserve, so its attempted credit is
 * retained for crash recovery and the timed exit. Once a channel has an owner,
 * however, merely signing from another endpoint, caller, or credit is not
 * evidence that the DVM accepted that binding. Preserve that acknowledged
 * association as a unit until {@link acknowledgeX402ChannelOwner} advances it.
 */
export function recordX402ChannelMetadata(metadata: StoredX402ChannelMetadata): void {
  const file = loadFile();
  const id = canonicalChannelId(metadata.channelId);
  const acknowledged = file.channels[id]?.metadata;
  const sameOwner =
    acknowledged?.endpoint === metadata.endpoint &&
    acknowledged.callerPubkey === metadata.callerPubkey &&
    acknowledged.creditId === metadata.creditId;
  file.channels[id] = {
    ...file.channels[id],
    metadata:
      !acknowledged || sameOwner
        ? { ...metadata, channelId: id }
        : { ...acknowledged, channelId: id },
  };
  saveFile(file);
}

/**
 * Adopt the endpoint, caller, and credit after the DVM acknowledges funding.
 *
 * The network and contract config are channel-id material, so the durable row
 * already carries them. The association is the mutable part that must move as
 * one unit rather than producing a row that belongs to two funding scopes.
 */
export function acknowledgeX402ChannelOwner(
  owner: Pick<StoredX402ChannelMetadata, "channelId" | "endpoint" | "callerPubkey" | "creditId">
): void {
  const file = loadFile();
  const id = canonicalChannelId(owner.channelId);
  const record = file.channels[id];
  if (!record?.metadata) {
    throw new Error(
      `Cannot acknowledge credit ${owner.creditId}: x402 channel ${id} has no metadata`
    );
  }
  file.channels[id] = {
    ...record,
    metadata: {
      ...record.metadata,
      endpoint: owner.endpoint,
      callerPubkey: owner.callerPubkey,
      creditId: owner.creditId,
      updatedAt: Date.now(),
    },
  };
  saveFile(file);
}

/**
 * Every channel this store has metadata for, newest first, optionally narrowed
 * to the channels one payer opened.
 *
 * The wallet-lifecycle preflight needs the whole set rather than
 * `findX402Channel`'s single best match: replacing or removing the caller's key
 * has to be refused while *any* channel that key controls still holds value.
 * The payer filter is what keeps a channel opened by an earlier, long-rotated
 * key from vouching for — or blocking — the wallet configured today.
 */
export function listX402Channels(filter: { payer?: string } = {}): StoredX402ChannelMetadata[] {
  const payer = filter.payer?.toLowerCase();
  return allChannelMetadata()
    .filter((entry) => !payer || entry.config.payer.toLowerCase() === payer)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function findX402Channel(args: {
  channelId?: string;
  endpoint?: string;
  callerPubkey?: string;
  creditId?: string;
}): StoredX402ChannelMetadata | undefined {
  const channels = allChannelMetadata();
  if (args.channelId) {
    const channelId = canonicalChannelId(args.channelId);
    return channels.find((entry) => entry.channelId === channelId);
  }
  const endpoint = args.endpoint ? normalizeEndpoint(args.endpoint) : undefined;
  return channels
    .filter(
      (entry) =>
        (!endpoint || entry.endpoint === endpoint) &&
        (!args.callerPubkey || entry.callerPubkey === args.callerPubkey) &&
        (!args.creditId || entry.creditId === args.creditId)
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/**
 * When this channel's stored `balance` last took a local or DVM-reported figure
 * that the chain has not confirmed since, or `undefined` after a chain read.
 *
 * The honest answer to "does this projection match chain?" for anything that
 * reports the stored figure rather than reading `channels()` itself. A record
 * with a stamp is not necessarily wrong. It is unverified, which is a different
 * claim and the one a caller relaying the number to a human needs to hear
 */
export function x402ChannelBalanceUnreconciledAt(channelId: string): number | undefined {
  return loadFile().channels[canonicalChannelId(channelId)]?.unreconciledBalanceAt;
}

/**
 * Persist a verbatim payment header before it is submitted. Replaces the live
 * entry for the same credit — the re-signed header supersedes it — but leaves
 * any retired one standing, since that is a different signature the channel is
 * still on the hook for and the key alone cannot tell them apart.
 */
export function recordPendingX402Funding(pending: PendingX402Funding): void {
  const { file, credits } = loadFundingFile();
  const pendingOrigin = normalizeEndpoint(pending.endpoint);
  file.pending = [
    ...file.pending.flatMap((entry) => {
      if (!sameFundingCredit(entry, pending, credits) || x402PendingRetired(entry)) return [entry];
      if (normalizeEndpoint(entry.endpoint) === pendingOrigin) return [];
      return [{ ...entry, supersededAt: pending.requestedAt }];
    }),
    pending,
  ];
  saveFile(file);
}

/**
 * Read the one in-flight funding a DVM credit can still replay, if any.
 *
 * Retired entries are deliberately invisible here: a permanent refusal is the
 * DVM's final answer, so replaying its header would only earn the same refusal
 * and wedge the credit. They stay on disk for the gates that count
 * what the caller signed — never for the ones that decide what to send again.
 */
export function loadResumableX402Funding(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
}): PendingX402Funding | undefined {
  const { file, credits } = loadFundingFile();
  return file.pending.find(
    (entry) => sameFundingCredit(entry, args, credits) && !x402PendingRetired(entry)
  );
}

/** Every journalled signed header, optionally scoped to one DVM identity. */
export function listPendingX402Fundings(
  filter: {
    endpoint?: string;
    callerPubkey?: string;
  } = {}
): PendingX402Funding[] {
  const endpoint = filter.endpoint ? normalizeEndpoint(filter.endpoint) : undefined;
  const { file, credits } = loadFundingFile();
  return file.pending.filter(
    (entry) =>
      (!endpoint || fundingReachableAt(entry, endpoint, credits)) &&
      (!filter.callerPubkey || entry.callerPubkey === filter.callerPubkey)
  );
}

/** The subset of {@link listPendingX402Fundings} a retry could still answer. */
export function listResumableX402Fundings(
  filter: {
    endpoint?: string;
    callerPubkey?: string;
  } = {}
): PendingX402Funding[] {
  return listPendingX402Fundings(filter).filter((entry) => !x402PendingRetired(entry));
}

/**
 * Every unacknowledged signed voucher on one channel. Deliberately unscoped by
 * endpoint and caller pubkey: the channel tuple names neither, so one channel
 * is shared by every credit at a DVM, by two DVMs that share a payout address,
 * and by two caller identities on one EVM key. Anything reasoning about what a
 * channel still owes has to see all of them.
 */
export function listPendingX402FundingsForChannel(channelId: string): PendingX402Funding[] {
  const canonical = canonicalChannelId(channelId);
  return loadFundingFile().file.pending.filter(
    (entry) => canonicalChannelId(entry.channelId) === canonical
  );
}

/**
 * Mark one funding as permanently refused without forgetting what it signed.
 *
 * The deleting counterpart, {@link clearPendingX402Funding}, is for entries
 * whose authority is spent or provably dead. A refusal is neither: the DVM said
 * no, but the caller's signatures are still out there, so the entry stops being
 * replayable and keeps being counted.
 */
export function retirePendingX402Funding(pending: PendingX402Funding): void {
  const { file } = loadFundingFile();
  const key = pendingKey(pending);
  const target = file.pending.find(
    (entry) => pendingKey(entry) === key && !x402PendingRetired(entry)
  );
  if (!target) return;
  const refusedAt = Date.now();
  file.pending = file.pending.map((entry) => (entry === target ? { ...entry, refusedAt } : entry));
  saveFile(file);
}

/**
 * Forget exactly one signed funding — because it was acknowledged, proven dead,
 * or discarded on purpose. Matched on the fund id and retirement state as well
 * as the credit key, since a credit can hold both a live entry and a retired
 * one and forgetting the wrong one drops a reservation nobody would notice.
 */
export function clearPendingX402Funding(pending: PendingX402Funding): void {
  const { file } = loadFundingFile();
  const next = file.pending.filter((entry) => !sameJournalEntry(entry, pending));
  if (next.length === file.pending.length) return;
  file.pending = next;
  saveFile(file);
}

/**
 * What a context write says about where its `balance` came from, and therefore
 * what it does to the record's unreconciled stamp.
 *
 * Three values rather than a boolean because there are three answers, and the
 * missing one is the dangerous one: a write that settles nothing must leave the
 * stamp exactly as it found it. Collapsing "unchanged" into "observed" marks a
 * record verified on the strength of a write that observed nothing, which turns
 * a missing signal into a wrong one on a money figure.
 *
 * - `observed` — a `channels()` read (including upstream recovery), which
 * answers the question and clears the stamp.
 * - `unreconciled` — the local accumulator or a DVM response writing a figure
 * the contract has not confirmed, which raises it.
 * - `unchanged` — a write that moves `balance` not at all, so it neither
 * answers nor re-opens the question and the stamp stands as it was.
 */
type X402BalanceProvenance = "observed" | X402UnobservedBalanceProvenance;

/**
 * Highest DVM-acknowledged cumulative base. Probe and chain-reconciliation
 * writes may preserve it beside a lower context cursor; normal writes advance it.
 */
type X402AcknowledgedBase = "advance" | "hold";

function writeContext(
  key: string,
  context: BatchSettlementClientContext,
  provenance: X402BalanceProvenance,
  base: X402AcknowledgedBase
): void {
  const file = loadFile();
  const id = canonicalChannelId(key);
  const record: ChannelRecord = file.channels[id] ?? {};
  file.channels[id] = channelRecordWithContext(record, context, provenance, base);
  saveFile(file);
}

function channelRecordWithContext(
  record: ChannelRecord,
  context: BatchSettlementClientContext,
  provenance: X402BalanceProvenance,
  base: X402AcknowledgedBase
): ChannelRecord {
  const { unreconciledBalanceAt: previousStamp, ...kept } = record;
  const stamp =
    provenance === "unreconciled"
      ? Date.now()
      : provenance === "unchanged"
        ? previousStamp
        : undefined;
  const stored = readAcknowledgedCumulativeAmount(record);
  const acknowledgedCumulativeAmount =
    base === "advance" ? highestCumulativeAmount(stored, context.chargedCumulativeAmount) : stored;
  return {
    ...kept,
    context,
    ...(acknowledgedCumulativeAmount !== undefined ? { acknowledgedCumulativeAmount } : {}),
    ...(stamp !== undefined ? { unreconciledBalanceAt: stamp } : {}),
  };
}

function allChannelMetadata(): StoredX402ChannelMetadata[] {
  return Object.values(loadFile().channels)
    .filter((record): record is ChannelRecord => record !== undefined)
    .map((record) => record.metadata)
    .filter((entry): entry is StoredX402ChannelMetadata => entry !== undefined);
}

function pendingKey(entry: { endpoint: string; callerPubkey: string; creditId: string }): string {
  return `${normalizeEndpoint(entry.endpoint)}\u0000${entry.callerPubkey}\u0000${entry.creditId}`;
}

function sameFundingCredit(
  entry: { endpoint: string; callerPubkey: string; creditId: string },
  target: { endpoint: string; callerPubkey: string; creditId: string },
  credits: readonly StoredCredit[]
): boolean {
  return (
    entry.callerPubkey === target.callerPubkey &&
    entry.creditId === target.creditId &&
    fundingReachableAt(entry, normalizeEndpoint(target.endpoint), credits)
  );
}

/** Load the funding journals and collapse live rows split across known aliases. */
function loadFundingFile(): { file: X402ChannelFile; credits: StoredCredit[] } {
  const snapshot = collapseFundingFile();
  if (!snapshot.changed) return snapshot;

  const persisted = tryWithX402ChannelLockSync(() => {
    const current = collapseFundingFile();
    if (current.changed) saveFile(current.file);
    return current;
  });
  return persisted ?? snapshot;
}

/** Re-read and collapse one atomic journal snapshot without taking its writer lock. */
function collapseFundingFile(): {
  file: X402ChannelFile;
  credits: StoredCredit[];
  changed: boolean;
} {
  const file = loadFile();
  const credits = listCredits();
  const pending = dedupeX402FundingCredits(file.pending, credits);
  const exact = dedupeFundingCredits(file.exact, credits);
  if (pending.changed) file.pending = pending.entries;
  if (exact.changed) file.exact = exact.entries;
  return { file, credits, changed: pending.changed || exact.changed };
}

/** Keep one replayable voucher while retaining every distinct signed authority. */
function dedupeX402FundingCredits(
  entries: PendingX402Funding[],
  credits: readonly StoredCredit[]
): { entries: PendingX402Funding[]; changed: boolean } {
  const kept: PendingX402Funding[] = [];
  let changed = false;
  for (const entry of entries) {
    if (x402PendingRetired(entry)) {
      kept.push(entry);
      continue;
    }
    const index = kept.findIndex(
      (candidate) => !x402PendingRetired(candidate) && sameFundingCredit(candidate, entry, credits)
    );
    if (index === -1) {
      kept.push(entry);
      continue;
    }
    const seen = kept[index];
    const seenAt = Number.isFinite(seen.requestedAt) ? seen.requestedAt : 0;
    const entryAt = Number.isFinite(entry.requestedAt) ? entry.requestedAt : 0;
    const sameOrigin = normalizeEndpoint(seen.endpoint) === normalizeEndpoint(entry.endpoint);
    if (entryAt > seenAt) {
      kept[index] = entry;
      if (!sameOrigin) kept.push({ ...seen, supersededAt: entry.requestedAt });
    } else if (!sameOrigin) {
      kept.push({ ...entry, supersededAt: seen.requestedAt });
    }
    changed = true;
  }
  return { entries: kept, changed };
}

/** Keep the newest whole row for one credit without splicing signed fields. */
function dedupeFundingCredits<
  T extends {
    endpoint: string;
    callerPubkey: string;
    creditId: string;
    requestedAt: number;
  },
>(entries: T[], credits: readonly StoredCredit[]): { entries: T[]; changed: boolean } {
  const kept: T[] = [];
  let changed = false;
  for (const entry of entries) {
    const index = kept.findIndex((candidate) => sameFundingCredit(candidate, entry, credits));
    if (index === -1) {
      kept.push(entry);
      continue;
    }
    const seenAt = Number.isFinite(kept[index].requestedAt) ? kept[index].requestedAt : 0;
    const entryAt = Number.isFinite(entry.requestedAt) ? entry.requestedAt : 0;
    if (entryAt > seenAt) kept[index] = entry;
    changed = true;
  }
  return { entries: kept, changed };
}

function sameJournalEntry(entry: PendingX402Funding, target: PendingX402Funding): boolean {
  return (
    pendingKey(entry) === pendingKey(target) &&
    entry.fundId === target.fundId &&
    x402PendingRetired(entry) === x402PendingRetired(target)
  );
}

function fromSynchronousStore<T>(operation: () => T): Promise<T> {
  try {
    return Promise.resolve(operation());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function highestCumulativeAmount(
  previous: string | undefined,
  next: string | undefined
): string | undefined {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  return BigInt(next) > BigInt(previous) ? next : previous;
}

function readAcknowledgedCumulativeAmount(record: ChannelRecord | undefined): string | undefined {
  // Until its next write migrates it, a legacy record carries this fact
  // only in the upstream context. Once the sibling exists it is authoritative:
  // the refund probe may deliberately hold a lower context value beside it.
  return record?.acknowledgedCumulativeAmount ?? record?.context?.chargedCumulativeAmount;
}

function canonicalChannelId(value: string): `0x${string}` {
  return value.toLowerCase() as `0x${string}`;
}

function normalizeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

/** Persist a migration when the lock is free without blocking its async owner. */
function tryWithX402ChannelLockSync<T>(operation: () => T): T | undefined {
  if (x402LockOwner.getStore()?.active) return operation();
  ensureX402ChannelFile();
  let release: () => void;
  try {
    release = lockfile.lockSync(X402_CHANNELS_FILE, { realpath: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
    throw error;
  }
  const owner = { active: true };
  try {
    return x402LockOwner.run(owner, operation);
  } finally {
    owner.active = false;
    release();
  }
}

function ensureX402ChannelFile(): void {
  ensureConfigDir();
  if (existsSync(X402_CHANNELS_FILE)) return;
  try {
    writeFileSync(X402_CHANNELS_FILE, `${JSON.stringify(EMPTY, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // A sibling created it between the existence check and the exclusive write.
  }
}

function loadFile(): X402ChannelFile {
  if (!existsSync(X402_CHANNELS_FILE)) return { ...EMPTY, channels: {}, pending: [], exact: [] };
  try {
    const raw = JSON.parse(readFileSync(X402_CHANNELS_FILE, "utf8")) as Partial<X402ChannelFile>;
    if (
      raw.version !== 1 ||
      !raw.channels ||
      typeof raw.channels !== "object" ||
      Array.isArray(raw.channels) ||
      !Array.isArray(raw.pending)
    ) {
      throw new Error("unsupported x402 channel store shape");
    }
    return {
      version: 1,
      channels: raw.channels,
      pending: raw.pending,
      // Tolerated rather than required, unlike its two siblings: every file
      // written before lacks the key, and failing closed on it would
      // read as a corrupt journal on a store that is perfectly intact.
      exact: Array.isArray(raw.exact) ? raw.exact : [],
    };
  } catch (cause) {
    throw new DvmError(
      "x402_channel_store_invalid",
      "The saved x402 channel journal cannot be read safely.",
      `Do not delete ${X402_CHANNELS_FILE}; restore or repair it before signing another channel voucher.`,
      { cause: cause instanceof Error ? cause.message : String(cause) }
    );
  }
}

function saveFile(file: X402ChannelFile): void {
  ensureConfigDir();
  const tmp = `${X402_CHANNELS_FILE}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, X402_CHANNELS_FILE);
}
