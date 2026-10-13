/**
 * Durable caller-side TIP-1034 channel state.
 *
 * mppx owns the serialized channel entry. This wrapper only supplies its JSON
 * KV and records which caller identity + DVM credit the entry belongs to. The
 * caller pubkey is part of the KV namespace: one Tempo wallet can serve more
 * than one dvm signing identity, but those identities must never silently
 * reuse each other's server-bound credit channel.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { Session as TempoSession } from "mppx/tempo";
import lockfile from "proper-lockfile";
import { isAddress, zeroAddress } from "viem";

import { TEMPO_CHANNELS_FILE } from "../../defaults";
import { ensureConfigDir } from "../config-dir";
import {
  fundingReachableAt,
  listCredits,
  normalizeCreditEndpoint,
  type StoredCredit,
} from "../credit-store";
import { DvmError } from "../errors";

type ChannelStore = ReturnType<typeof TempoSession.Client.createJsonChannelStore>;
type ChannelEntry = NonNullable<Awaited<ReturnType<ChannelStore["get"]>>>;

export type TempoChannelDescriptor = ChannelEntry["descriptor"];

/** A durable link from a local Tempo channel to one DVM prepaid credit. */
export interface TempoChannelAssociation {
  /** Normalised DVM origin. */
  endpoint: string;
  /** Caller signing identity bound to the DVM credit. */
  callerPubkey: string;
  /** Server credit identifier funded by this channel. */
  creditId: string;
  /** mppx payment-scope key used to reload the entry. */
  channelKey: string;
  /** Payee-side operator that owns this reusable channel scope. */
  operator: string;
  /** TIP-1034 channel identifier. */
  channelId: `0x${string}`;
  /** Latest locally-authorized cumulative amount, raw token units. */
  cumulativeAmount: string;
  /** Latest known channel deposit, raw token units. */
  deposit: string;
  /** Tempo chain id. */
  chainId: number;
  /** Whether mppx considers the channel reusable. */
  opened: boolean;
  /** Epoch ms of the latest channel-store update. */
  updatedAt: number;
}

export interface TempoChannelStoreContext {
  callerPubkey: string;
  endpoint?: string;
  creditId?: string;
  operator?: string;
}

/**
 * A one-shot Tempo `charge` retained until its funding response is
 * acknowledged.
 *
 * It shares this file, this lock and this atomic write with the channel
 * associations above, and nothing else: a charge opens no channel, so folding
 * it into {@link TempoChannelAssociation} would put a `channelId` on a record
 * that has none. What it borrows is the one property that matters — the
 * verbatim credential and its fund id reach disk before the paid POST, so a
 * retry re-presents them rather than signing a second charge.
 *
 * **The entry deliberately outlives the credential it carries.** Its x402 twin
 * ({@link import("../x402/channel-store").PendingX402ExactFunding}) can tie
 * resumability to the authorization's own ten-minute deadline, because a retry
 * inside that window is the ordinary case. An mppx charge credential is
 * settleable for roughly twenty-five seconds, which almost never outlasts the
 * timeout that told the caller the response was lost — so an entry that died
 * with its credential would leave the retry minting a fresh fund id and paying
 * twice, which is the bug. The durable idempotency key here is the *fund id*,
 * held until the DVM answers for it or {@link TEMPO_CHARGE_PENDING_STALE_MS}
 * passes; re-presenting the credential is the bonus that a fast retry gets.
 */
export interface PendingTempoChargeFunding {
  /** Normalised endpoint origin the funding was requested from. */
  endpoint: string;
  /** x-only pubkey of the signing identity that owns the funding. */
  callerPubkey: string;
  /** Credit the charge tops up. */
  creditId: string;
  /** The `(credit_id, fund_id)` key the DVM answers a replay under. */
  fundId: string;
  /** What this funding asked for, in USD micro-units. */
  amountMicro: number;
  /**
   * The refill target this funding was working towards, journalled beside the
   * amount because `recordFundResponse` writes it unconditionally: a resume
   * that dropped it would answer the DVM's reported balance back into the
   * credit's target and quietly retune every later auto-refill.
   */
  targetMicro: number;
  /** `Credential.serialize(...)` verbatim — the exact `Payment …` value sent. */
  credential: string;
  /**
   * What the credential authorizes, which the signing tolerance allows to sit a
   * little over {@link PendingTempoChargeFunding.amountMicro}. Journalled so a
   * resume reports the money that actually moves, not the ask.
   */
  signedMicro: number;
  /**
   * What the signature is worth locally, captured at signing time. The budget
   * ledger books the *signed* figure, and a resume must be able to book it
   * without a fresh rate lookup — an fx outage may not stand between a
   * presented charge and its record.
   */
  amountMsats: number;
  btcRate: number;
  /** Epoch ms the credential was signed and this entry written. */
  requestedAt: number;
  /**
   * Unix seconds after which the signed transaction can no longer be included.
   * Absent when the challenge carried an unreadable `expires`, in which case
   * every read treats the credential as spent rather than inventing a window.
   */
  credentialValidBefore?: number;
}

/**
 * How long an unanswered charge holds its credit before the journal gives up on
 * it. A backstop rather than the usual exit: every definite answer from the DVM
 * funded, refused, bound elsewhere — clears the entry outright, so the only
 * way to reach this line is a DVM that stayed unreachable for a day, during
 * which no rail could have funded that credit anyway.
 */
export const TEMPO_CHARGE_PENDING_STALE_MS = 24 * 60 * 60 * 1000;

interface TempoChannelFile {
  version: 2;
  values: Record<string, string>;
  associations: TempoChannelAssociation[];
  charges: PendingTempoChargeFunding[];
}

interface LegacyTempoChannelFile {
  version: 1;
  values: Record<string, string>;
  associations: LegacyTempoChannelAssociation[];
  charges?: PendingTempoChargeFunding[];
}

type LegacyTempoChannelAssociation = Omit<TempoChannelAssociation, "operator">;
const tempoLockOwner = new AsyncLocalStorage<{ active: boolean }>();

/**
 * Serialize channel voucher and lifecycle transitions across CLI processes.
 * TIP-1034 credentials advance cumulative authority from durable state, so
 * the lock belongs around the complete read-sign-write operation rather than
 * around individual storage calls.
 */
export async function withTempoChannelLock<T>(operation: () => Promise<T>): Promise<T> {
  if (tempoLockOwner.getStore()?.active) return operation();
  ensureTempoChannelFile();
  const release = await lockfile.lock(TEMPO_CHANNELS_FILE, {
    realpath: false,
    retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
  });
  const owner = { active: true };
  try {
    return await tempoLockOwner.run(owner, operation);
  } finally {
    owner.active = false;
    await release();
  }
}

/** Create mppx's JSON channel store over the caller's durable state file. */
export function createTempoChannelStore(context: TempoChannelStoreContext): ChannelStore {
  let operator =
    context.operator === undefined ? undefined : normalizeTempoChannelOperator(context.operator);
  return TempoSession.Client.createJsonChannelStore({
    get(key) {
      if (operator === undefined) return undefined;
      return loadFile().values[channelStorageKey(context.callerPubkey, operator, key)];
    },
    set(key, value) {
      const file = loadFile();
      const entry = JSON.parse(value) as {
        channelId: `0x${string}`;
        cumulativeAmount: string;
        deposit: string;
        descriptor?: { operator?: unknown };
        chainId: number;
        opened: boolean;
      };
      const entryOperator = normalizeTempoChannelOperator(entry.descriptor?.operator);
      if (operator !== undefined && operator !== entryOperator) {
        throw new DvmError(
          "payment_invalid",
          "The Tempo channel operator does not match the session challenge."
        );
      }
      operator = entryOperator;
      const storedKey = channelStorageKey(context.callerPubkey, operator, key);
      if (Object.hasOwn(file.values, storedKey)) {
        const occupiedValue = file.values[storedKey];
        const occupied = JSON.parse(occupiedValue) as { channelId?: unknown };
        if (
          typeof occupied.channelId !== "string" ||
          occupied.channelId.toLowerCase() !== entry.channelId.toLowerCase()
        ) {
          throw new DvmError(
            "tempo_channel_scope_occupied",
            "A different Tempo channel already occupies this payment scope.",
            "Exit the existing Tempo channel before retrying this funding. Its local recovery descriptor was preserved.",
            {
              occupied_channel_id:
                typeof occupied.channelId === "string" ? occupied.channelId : undefined,
              refused_channel_id: entry.channelId,
            },
            "Funding stopped before broadcast because this Tempo payment scope still holds another recoverable channel."
          );
        }
      }
      file.values[storedKey] = value;
      if (context.endpoint && context.creditId) {
        const updatedAt = Date.now();
        const association: TempoChannelAssociation = {
          endpoint: normalizeCreditEndpoint(context.endpoint),
          callerPubkey: context.callerPubkey,
          creditId: context.creditId,
          channelKey: key.startsWith("chan:") ? key.slice(5) : key,
          operator,
          channelId: entry.channelId,
          cumulativeAmount: entry.cumulativeAmount,
          deposit: entry.deposit,
          chainId: entry.chainId,
          opened: entry.opened,
          updatedAt,
        };
        // One mppx payment scope can fund more than one DVM credit. Its JSON
        // value is shared already; keep every per-credit projection in step as
        // well, or funding through one sibling leaves the next sibling sizing
        // its cap from stale cumulative and deposit figures.
        file.associations = file.associations.map((candidate) =>
          candidate.callerPubkey === association.callerPubkey &&
          candidate.operator === association.operator &&
          candidate.channelKey === association.channelKey &&
          candidate.channelId.toLowerCase() === association.channelId.toLowerCase()
            ? {
                ...candidate,
                cumulativeAmount: association.cumulativeAmount,
                deposit: association.deposit,
                chainId: association.chainId,
                opened: association.opened,
                updatedAt,
              }
            : candidate
        );
        const index = file.associations.findIndex((candidate) =>
          sameCredit(
            candidate,
            association.endpoint,
            association.callerPubkey,
            association.creditId
          )
        );
        if (index === -1) file.associations.push(association);
        else file.associations[index] = association;
      }
      saveFile(file);
    },
    delete(key) {
      if (operator === undefined) return;
      const file = loadFile();
      const removedKey = channelStorageKey(context.callerPubkey, operator, key);
      const channelKey = key.startsWith("chan:") ? key.slice(5) : key;
      const endpoint = context.endpoint ? normalizeCreditEndpoint(context.endpoint) : undefined;
      file.associations = file.associations.filter((association) => {
        if (
          association.callerPubkey !== context.callerPubkey ||
          association.operator !== operator ||
          association.channelKey !== channelKey
        ) {
          return true;
        }
        if (endpoint && context.creditId) {
          return !sameCredit(association, endpoint, context.callerPubkey, context.creditId);
        }
        return false;
      });
      const shared = file.associations.some(
        (association) =>
          association.callerPubkey === context.callerPubkey &&
          association.operator === operator &&
          association.channelKey === channelKey
      );
      if (!shared) {
        file.values = Object.fromEntries(
          Object.entries(file.values).filter(([storedKey]) => storedKey !== removedKey)
        );
      }
      saveFile(file);
    },
  });
}

export function listTempoChannelAssociations(): TempoChannelAssociation[] {
  return [...loadFile().associations].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function loadTempoChannelAssociation(
  endpoint: string,
  callerPubkey: string,
  creditId: string
): TempoChannelAssociation | undefined {
  const normalized = normalizeCreditEndpoint(endpoint);
  return loadFile().associations.find((candidate) =>
    sameCredit(candidate, normalized, callerPubkey, creditId)
  );
}

export function loadTempoChannelAssociationByKey(
  callerPubkey: string,
  operator: string,
  channelKey: string
): TempoChannelAssociation | undefined {
  const normalizedOperator = normalizeTempoChannelOperator(operator);
  return loadFile().associations.find(
    (candidate) =>
      candidate.callerPubkey === callerPubkey &&
      candidate.operator === normalizedOperator &&
      candidate.channelKey === channelKey
  );
}

export async function loadTempoChannelEntry(
  association: TempoChannelAssociation
): Promise<ChannelEntry | undefined> {
  return createTempoChannelStore({
    callerPubkey: association.callerPubkey,
    endpoint: association.endpoint,
    creditId: association.creditId,
    operator: association.operator,
  }).get(association.channelKey);
}

/**
 * The wallets a recorded channel's descriptor authorizes over its collateral.
 *
 * Not on {@link TempoChannelAssociation}, because the store never projected it:
 * `set()` lifts only `descriptor.operator` off the mppx entry, so the payer sits
 * one level down in the serialized entry and has to be read back out of it.
 */
export interface TempoChannelController {
  /** Wallet that funded the channel and receives its refund. */
  payer: string;
  /** Wallet authorized to sign this channel's vouchers, resolved through the descriptor's delegation. */
  authorizedSigner: string;
}

/**
 * Who controls one recorded channel, or `undefined` when its descriptor is gone.
 *
 * The delegation rule is mppx's own — a zero `authorizedSigner` means the payer
 * signs — so it is read through `resolveAuthorizedSigner` rather than
 * reimplemented here, where a drift in that convention would silently widen
 * what {@link tempoChannelControlledBy} calls a stranger's channel.
 */
export async function loadTempoChannelController(
  association: TempoChannelAssociation
): Promise<TempoChannelController | undefined> {
  const entry = await loadTempoChannelEntry(association);
  return entry && tempoDescriptorController(entry.descriptor);
}

/**
 * Who a channel descriptor names, in the form {@link tempoChannelControlledBy}
 * compares, or `undefined` when it names no payer at all.
 *
 * A descriptor without a payer is as unattributable as a missing one, and gets
 * the same answer: nothing is claimed about whose channel it is. The signer is
 * normalised the way `operator` is on the way in — an absent one is unset — and
 * the delegation itself is mppx's own rule, so a change to what "unset" means
 * cannot quietly widen what counts as a stranger's channel.
 */
export function tempoDescriptorController(
  descriptor: TempoChannelDescriptor
): TempoChannelController | undefined {
  const payer: unknown = descriptor.payer;
  if (typeof payer !== "string" || !isAddress(payer, { strict: false })) return undefined;
  const signer: unknown = descriptor.authorizedSigner;
  const authorizedSigner = TempoSession.Precompile.Channel.resolveAuthorizedSigner({
    ...descriptor,
    payer,
    authorizedSigner:
      typeof signer === "string" && isAddress(signer, { strict: false }) ? signer : zeroAddress,
  });
  return { payer: payer.toLowerCase(), authorizedSigner: authorizedSigner.toLowerCase() };
}

/**
 * Either payer or delegated signer controls the channel. Unknown ownership is
 * treated as controlled; with a known controller, an absent address does not match.
 */
export function tempoChannelControlledBy(
  controller: TempoChannelController | undefined,
  address: string | undefined
): boolean {
  if (!controller) return true;
  if (address === undefined) return false;
  // Both sides folded rather than trusting the constructor: the store holds
  // checksummed descriptors and lowercase association fields, and a comparison
  // that is only half case-insensitive reads a wallet as a stranger to itself.
  const candidate = address.toLowerCase();
  return (
    controller.payer.toLowerCase() === candidate ||
    controller.authorizedSigner.toLowerCase() === candidate
  );
}

/** Forget a settled/closed channel and its credit association. */
export async function retireTempoChannel(association: TempoChannelAssociation): Promise<void> {
  await createTempoChannelStore({
    callerPubkey: association.callerPubkey,
    endpoint: association.endpoint,
    creditId: association.creditId,
    operator: association.operator,
  }).delete(association.channelKey);
}

/** Forget a terminal channel, every credit associated with it, and its shared entry. */
export async function retireTempoChannelScope(association: TempoChannelAssociation): Promise<void> {
  await createTempoChannelStore({
    callerPubkey: association.callerPubkey,
    operator: association.operator,
  }).delete(association.channelKey);
}

/**
 * Whether a journalled charge has passed the point where re-running it is worth
 * anything. See {@link TEMPO_CHARGE_PENDING_STALE_MS} for why this line is a
 * backstop rather than the ordinary exit.
 */
export function tempoChargeFundingStale(
  pending: PendingTempoChargeFunding,
  now = Date.now()
): boolean {
  return now - pending.requestedAt >= TEMPO_CHARGE_PENDING_STALE_MS;
}

/**
 * Whether the journalled credential can still settle, which decides only
 * whether a resume re-presents it or signs a fresh one under the same fund id.
 * Never a safety gate: a stale credential presented anyway is refused by the
 * rail, and an entry whose deadline could not be read is treated as spent.
 */
export function tempoChargeCredentialSettleable(
  pending: PendingTempoChargeFunding,
  now = Date.now()
): boolean {
  return pending.credentialValidBefore !== undefined && now < pending.credentialValidBefore * 1000;
}

/** Persist a verbatim charge credential before it is submitted, replacing this credit's last. */
export function recordPendingTempoChargeFunding(pending: PendingTempoChargeFunding): void {
  const { file, credits } = loadChargeFile();
  const entry = { ...pending, endpoint: normalizeCreditEndpoint(pending.endpoint) };
  file.charges = [
    ...file.charges.filter((candidate) => !sameChargeCredit(candidate, entry, credits)),
    entry,
  ];
  saveFile(file);
}

/** The charge funding this credit can still resume, if any. */
export function loadResumableTempoChargeFunding(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  now?: number;
}): PendingTempoChargeFunding | undefined {
  const key = {
    endpoint: normalizeCreditEndpoint(args.endpoint),
    callerPubkey: args.callerPubkey,
    creditId: args.creditId,
  };
  const { file, credits } = loadChargeFile();
  return file.charges.find(
    (entry) => sameChargeCredit(entry, key, credits) && !tempoChargeFundingStale(entry, args.now)
  );
}

/** Every charge funding a sweep could still resume, optionally scoped to one DVM identity. */
export function listResumableTempoChargeFundings(
  filter: { endpoint?: string; callerPubkey?: string; now?: number } = {}
): PendingTempoChargeFunding[] {
  const endpoint = filter.endpoint ? normalizeCreditEndpoint(filter.endpoint) : undefined;
  const { file, credits } = loadChargeFile();
  return file.charges
    .filter(
      (entry) =>
        (!endpoint || fundingReachableAt(entry, endpoint, credits)) &&
        (!filter.callerPubkey || entry.callerPubkey === filter.callerPubkey) &&
        !tempoChargeFundingStale(entry, filter.now)
    )
    .sort((a, b) => a.requestedAt - b.requestedAt);
}

/**
 * Forget one charge funding, because the DVM answered for it or it went stale.
 * Matched on the fund id as well as the credit key, so a sweep clearing a
 * lapsed entry cannot drop a fresher one a sibling process journalled in the
 * meantime.
 */
export function clearPendingTempoChargeFunding(pending: PendingTempoChargeFunding): void {
  const { file, credits } = loadChargeFile();
  const key = { ...pending, endpoint: normalizeCreditEndpoint(pending.endpoint) };
  const remaining = file.charges.filter(
    (entry) => !sameChargeCredit(entry, key, credits) || entry.fundId !== pending.fundId
  );
  if (remaining.length === file.charges.length) return;
  file.charges = remaining;
  saveFile(file);
}

function sameCredit(
  association: TempoChannelAssociation,
  endpoint: string,
  callerPubkey: string,
  creditId: string
): boolean {
  return (
    association.endpoint === endpoint &&
    association.callerPubkey === callerPubkey &&
    association.creditId === creditId
  );
}

function sameChargeCredit(
  entry: PendingTempoChargeFunding,
  key: { endpoint: string; callerPubkey: string; creditId: string },
  credits: readonly StoredCredit[]
): boolean {
  return (
    entry.callerPubkey === key.callerPubkey &&
    entry.creditId === key.creditId &&
    fundingReachableAt(entry, normalizeCreditEndpoint(key.endpoint), credits)
  );
}

/** Load the charge journal and collapse rows split across known aliases. */
function loadChargeFile(): { file: TempoChannelFile; credits: StoredCredit[] } {
  const snapshot = collapseChargeFile();
  if (!snapshot.changed) return snapshot;

  const persisted = tryWithTempoChannelLockSync(() => {
    const current = collapseChargeFile();
    if (current.changed) saveFile(current.file);
    return current;
  });
  return persisted ?? snapshot;
}

/** Re-read and collapse one atomic charge-journal snapshot without taking its writer lock. */
function collapseChargeFile(): {
  file: TempoChannelFile;
  credits: StoredCredit[];
  changed: boolean;
} {
  const file = loadFile();
  const credits = listCredits();
  const charges: PendingTempoChargeFunding[] = [];
  let changed = false;
  for (const entry of file.charges) {
    const index = charges.findIndex((candidate) => sameChargeCredit(candidate, entry, credits));
    if (index === -1) {
      charges.push(entry);
      continue;
    }
    const seenAt = Number.isFinite(charges[index].requestedAt) ? charges[index].requestedAt : 0;
    const entryAt = Number.isFinite(entry.requestedAt) ? entry.requestedAt : 0;
    if (entryAt > seenAt) charges[index] = entry;
    changed = true;
  }
  if (changed) file.charges = charges;
  return { file, credits, changed };
}

/** Persist a migration when the lock is free without blocking its async owner. */
function tryWithTempoChannelLockSync<T>(operation: () => T): T | undefined {
  if (tempoLockOwner.getStore()?.active) return operation();
  ensureTempoChannelFile();
  let release: () => void;
  try {
    release = lockfile.lockSync(TEMPO_CHANNELS_FILE, { realpath: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") return undefined;
    throw error;
  }
  const owner = { active: true };
  try {
    return tempoLockOwner.run(owner, operation);
  } finally {
    owner.active = false;
    release();
  }
}

function ensureTempoChannelFile(): void {
  ensureConfigDir();
  if (existsSync(TEMPO_CHANNELS_FILE)) return;
  try {
    writeFileSync(TEMPO_CHANNELS_FILE, `${JSON.stringify(emptyFile(), null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
  } catch {
    // A sibling created it between the existence check and the exclusive write.
  }
}

function loadFile(): TempoChannelFile {
  if (!existsSync(TEMPO_CHANNELS_FILE)) return emptyFile();
  try {
    const parsed = JSON.parse(readFileSync(TEMPO_CHANNELS_FILE, "utf8")) as Partial<
      TempoChannelFile | LegacyTempoChannelFile
    >;
    if (parsed.version === 1) return migrateLegacyFile(parsed);
    if (
      parsed.version !== 2 ||
      !isStringRecord(parsed.values) ||
      !Array.isArray(parsed.associations) ||
      !parsed.associations.every(isTempoChannelAssociation)
    ) {
      throw new Error("unsupported Tempo channel store shape");
    }
    return {
      version: 2,
      values: parsed.values,
      associations: parsed.associations,
      // Tolerated rather than required, unlike its two siblings: every file
      // written before lacks the key, and failing closed on it would
      // read as a corrupt journal on a store that is perfectly intact.
      charges: Array.isArray(parsed.charges) ? parsed.charges.filter(isPendingTempoCharge) : [],
    };
  } catch (cause) {
    throw new DvmError(
      "tempo_channel_store_invalid",
      "The saved Tempo channel journal cannot be read safely.",
      `Do not delete ${TEMPO_CHANNELS_FILE}; restore or repair it before signing another channel credential.`,
      { cause: cause instanceof Error ? cause.message : String(cause) }
    );
  }
}

function saveFile(file: TempoChannelFile): void {
  ensureConfigDir();
  const tmp = `${TEMPO_CHANNELS_FILE}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, TEMPO_CHANNELS_FILE);
}

function emptyFile(): TempoChannelFile {
  return { version: 2, values: {}, associations: [], charges: [] };
}

/** Upgrade caller-only channel keys to caller + operator keys without losing exits. */
function migrateLegacyFile(parsed: Partial<LegacyTempoChannelFile>): TempoChannelFile {
  if (
    !isStringRecord(parsed.values) ||
    !Array.isArray(parsed.associations) ||
    !parsed.associations.every(isLegacyTempoChannelAssociation)
  ) {
    throw new Error("unsupported Tempo channel store shape");
  }
  const values = { ...parsed.values };
  const consumed = new Set<string>();
  const associations = parsed.associations.map((association) => {
    const legacyKey = `${association.callerPubkey}:chan:${association.channelKey}`;
    const serialized = parsed.values?.[legacyKey];
    if (serialized === undefined) {
      throw new Error(`Tempo channel ${association.channelId} has no stored descriptor`);
    }
    const operator = serializedChannelOperator(serialized);
    values[
      channelStorageKey(association.callerPubkey, operator, `chan:${association.channelKey}`)
    ] = serialized;
    consumed.add(legacyKey);
    return { ...association, operator };
  });
  return {
    version: 2,
    values: Object.fromEntries(Object.entries(values).filter(([key]) => !consumed.has(key))),
    associations,
    charges: Array.isArray(parsed.charges) ? parsed.charges.filter(isPendingTempoCharge) : [],
  };
}

function channelStorageKey(callerPubkey: string, operator: string, key: string): string {
  return `${callerPubkey}:${operator}:${key}`;
}

function serializedChannelOperator(value: string): string {
  const parsed = JSON.parse(value) as { descriptor?: { operator?: unknown } };
  return normalizeTempoChannelOperator(parsed.descriptor?.operator);
}

function normalizeTempoChannelOperator(value: unknown): string {
  if (value === undefined) return zeroAddress;
  if (typeof value !== "string" || !isAddress(value, { strict: false })) {
    throw new Error("invalid Tempo channel operator");
  }
  return value.toLowerCase();
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

/**
 * Whether a stored entry still carries every field a resume reads. Filtered
 * rather than refused, for the same reason the key itself is tolerated: a
 * hand-edited or half-written charge is a lost retry, not a corrupt journal —
 * and a hard failure here would lock the caller out of channel state that is
 * perfectly readable.
 */
function isPendingTempoCharge(value: unknown): value is PendingTempoChargeFunding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<PendingTempoChargeFunding>;
  return (
    typeof entry.endpoint === "string" &&
    typeof entry.callerPubkey === "string" &&
    typeof entry.creditId === "string" &&
    typeof entry.fundId === "string" &&
    typeof entry.amountMicro === "number" &&
    typeof entry.targetMicro === "number" &&
    typeof entry.credential === "string" &&
    typeof entry.signedMicro === "number" &&
    typeof entry.amountMsats === "number" &&
    typeof entry.btcRate === "number" &&
    typeof entry.requestedAt === "number" &&
    (entry.credentialValidBefore === undefined || typeof entry.credentialValidBefore === "number")
  );
}

function isTempoChannelAssociation(value: unknown): value is TempoChannelAssociation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const association = value as Partial<TempoChannelAssociation>;
  return (
    typeof association.endpoint === "string" &&
    typeof association.callerPubkey === "string" &&
    typeof association.creditId === "string" &&
    typeof association.channelKey === "string" &&
    typeof association.operator === "string" &&
    isAddress(association.operator, { strict: false }) &&
    typeof association.channelId === "string" &&
    typeof association.cumulativeAmount === "string" &&
    typeof association.deposit === "string" &&
    typeof association.chainId === "number" &&
    typeof association.opened === "boolean" &&
    typeof association.updatedAt === "number"
  );
}

function isLegacyTempoChannelAssociation(value: unknown): value is LegacyTempoChannelAssociation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const association = value as Partial<LegacyTempoChannelAssociation>;
  return (
    typeof association.endpoint === "string" &&
    typeof association.callerPubkey === "string" &&
    typeof association.creditId === "string" &&
    typeof association.channelKey === "string" &&
    typeof association.channelId === "string" &&
    typeof association.cumulativeAmount === "string" &&
    typeof association.deposit === "string" &&
    typeof association.chainId === "number" &&
    typeof association.opened === "boolean" &&
    typeof association.updatedAt === "number"
  );
}
