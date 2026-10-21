/**
 * Per-DVM prepaid-credit working record (`~/.dvm/credits.json`).
 *
 * This file is the caller's *expectation*: what it believes each credit's
 * spendable balance to be, projected from the DVM-signed artifacts it has
 * already collected (fund responses, job receipts, drain records). It is
 * bookkeeping, not evidence — the signed balance trajectory lives in
 * `~/.dvm/receipts.jsonl`, and a mismatch between this file's projection and
 * a freshly countersigned `balance_after` is exactly what
 * {@link applyReceiptCredit} exists to surface.
 *
 * Mutable working set in the `budget.json` mold: one JSON object, temp-file +
 * rename writes, malformed *entries* tolerated on read. A malformed **file**
 * is not: damaged bytes are moved aside and named in the error rather than
 * replaced with an empty store, a file we merely failed to *open* is left
 * exactly where it is, and every cycle that touches the store runs under
 * {@link withCreditLock}.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import lockfile from "proper-lockfile";

import { CREDITS_FILE } from "../defaults";
import { ensureConfigDir } from "./config-dir";
import { IMPLICIT_CREDIT_TTL_MS } from "./credit-implicit";
import { DvmError } from "./errors";
import {
  archiveCompletedCreditRecords, completedRefund, completedLoss, readCreditHistoryPage,
  type CompletedCreditHistoryQuery, type CompletedCreditHistoryPage,
} from "./credit-history";
import { type DrawFundingReceipt, isDrawFundingReceipt, type ReceiptCredit } from "./receipt";
import type { TrustAnchorRead } from "./receipt-contracts";
import {
  type AttestedDvmIdentity,
  type ReceiptInvalidReason,
  type ReceiptTrustAnchor,
  verifyDrawFundingReceiptChain,
} from "./receipt-verify";
import { type CreditMenu, type CreditWire, parseCreditMenu } from "./transport/types";
// Type-only: the instrument vocabulary is the server's, and importing the
// declaration keeps this store free of x402's runtime stack.
import type { X402CreditInstrument } from "./x402/menu";

export type StoredCreditStatus = "active" | "expired" | "gone" | "drained" | "unbacked";

/** A drain in flight — persisted so a re-invoked `dvm credit drain` polls the same id. */
export interface PendingDrain {
  /** Caller-minted drain id; doubles as the poll/pickup key server-side. */
  drainId: string;
  /**
   * The server keys drains by (credit_id, drain_id). Only an exact pairing may be auto-reused.
   * Legacy unstamped entries remain visible but require an explicitly supplied pairing; they
   * cannot suppress later top-ups.
   */
  creditId?: string;

  method: string;
  /** Payout destination as signed into the drain request — immutable server-side. */
  payout: Record<string, string>;
  /** Epoch ms the drain was first requested. */
  requestedAt: number;
  /** Verbatim cooperative-close Authorization value, saved before transmission. */
  mppCredential?: string;
}

/**
 * A durable credit funding in flight.
 *
 * Kept outside {@link StoredCredit}: an opening funding must be durable before
 * its invoice request, when no server-confirmed credit exists yet.
 */
export interface PendingFunding {
  /** Normalised endpoint origin the funding was requested from. */
  endpoint: string;
  /** x-only pubkey of the signing identity that owns the funding. */
  callerPubkey: string;
  /** Caller-minted credit id the invoice is bound to. */
  creditId: string;
  /** Caller-minted idempotency key the invoice is bound to. */
  fundId: string;
  /** Requested funding amount, in the credit currency's micro-units. */
  amountMicro: number;
  /** Funding rail whose money-moving credential must be replayed verbatim. */
  rail: "lightning" | "tempo";
  /** Refill target to retain when the funding becomes a stored credit. */
  targetMicro: number;
  /** Additional deposit authorization allowed for this durable MPP funding. */
  maxDepositMicro?: number;
  /** Funding-menu snapshot to retain when the funding becomes a stored credit. */
  menu?: CreditMenu;
  /** Epoch ms the funding intent was first persisted. */
  requestedAt: number;
  /** Bolt11 returned by the DVM, once one has been issued. */
  bolt11?: string;
  /** Payment hash returned alongside {@link PendingFunding.bolt11}. */
  paymentHash?: string;
  /** Invoice amount, in millisatoshis. */
  amountMsats?: number;
  /** Absolute invoice expiry, epoch ms. */
  expiresAtMs?: number;
  /** Paid invoice principal, in millisatoshis. Present only after money moved. */
  principalMsats?: number;
  /** Wallet-reported routing fee. Null means the wallet omitted it. */
  routingFeeMsats?: number | null;
  /** Total wallet fee from an exact debit. Null means the total is unprovable. */
  totalWalletFeeMsats?: number | null;
  /** Wallet fee not itemized as routing. Null means the split is unprovable. */
  unitemizedWalletFeeMsats?: number | null;
  /** Exact wallet debit. Null means wallet evidence could not prove it. */
  walletDebitMsats?: number | null;
  /** How the caller wallet reached settlement. */
  paymentOutcome?: "paid" | "reconciled" | "republished";
  /** Serialized MPP Authorization credential, persisted before its network send. */
  mppCredential?: string;
  /**
   * What this funding's Tempo session voucher actually authorizes the DVM to
   * capture, in micro-units — the cumulative it signed, net of whatever the
   * channel had already authorized when the funding began. Journalled beside
   * {@link PendingFunding.mppCredential} so a resume books the authorization
   * rather than the ask.
   */
  authorizedMicro?: number;
  /**
   * Budget-ledger valuation fixed before an MPP channel credential is created.
   * The debit itself is not journalled: it is this rate applied to
   * {@link PendingFunding.authorizedMicro}, so a resume books the figure the
   * credential authorized rather than one fixed before it existed.
   */
  budgetBtcRate?: number;
}

/**
 * One drain's DVM-signed reclaim evidence, with the trust anchor it chains to.
 *
 * Held per drain rather than per credit: a credit can be re-funded and drained
 * again, and each drain's receipts must be judged against the identity the DVM
 * published at *that* reclaim — one anchor cannot honestly grade two drains
 * that straddle a key rotation.
 */
export interface StoredDrainEvidence {

  drainId: string;
  /**
   * Pinned independently of StoredCredit.creditId: reclaim evidence survives adoption of a
   * replacement credit.
   */
  creditId: string;
  /**
   * Untrusted verbatim receipt observations. Consumers must shape-check and authenticate
   * entries before use; store reads retain them without receipt-level verification.
   */
  receipts: unknown[];
  /**
   * Builder advertisement collected with these receipts, retained for offline verification
   * against the identity published at reclaim time.
   */
  anchor?: ReceiptTrustAnchor;
  /** Epoch ms of the poll that last refreshed this bundle. */
  collectedAt: number;
  /**
   * Epoch ms when the refund arrived. Only settled bundles may be evicted. This retention marker
   * does not authenticate the receipts.
   */
  settledAt?: number;
  /** Unsigned settlement facts; null means the caller could not establish the value. */
  settlement?: {
    rail: string | null;
    currency: string | null;
    amountMicro: number | null;
    feeMicro: number | null;
  };
}

/**
 * One verified mid-job funding fact, held until the draw it grew settles.
 *
 * The caller's projection never sees money accepted while a job runs: the
 * DVM funds the credit and grows the pending draw in one ledger step that
 * allocates no sequence, so the terminal receipt's `balance_after` includes it
 * while `remainingMicro − amount` does not. A fact is admitted only after
 * {@link verifyDrawFundingReceiptChain} binds it to this caller, credit and
 * provider, and it is spent exactly once, by the terminal receipt whose
 * `draw_id` and `ledger_seq` it names.
 */
export interface StoredDrawFunding {
  /** Rail payment id the funding committed under; the at-most-once key. */
  fundId: string;
  jobId: string;
  drawId: string;
  /** Provider-credited micro-units of the credit currency. */
  fundedMicro: number;
  /** The draw's ledger sequence — what the terminal receipt's credit block names. */
  ledgerSeq: number;
  /** Available balance the DVM signed immediately after the funding committed. */
  balanceAfterMicro: number;
  /** Epoch ms the fact was admitted locally. */
  recordedAt: number;
  /** The verbatim signed artifact, retained as evidence. */
  receipt: DrawFundingReceipt;
}

/** Why {@link recordDrawFunding} refused an artifact. */
export type DrawFundingRejection =
  /** Not a structurally valid, correctly signed draw funding receipt (see `verifyReason`). */
  | "invalid"
  /** No tracked credit for this caller matches the receipt's credit at this provider. */
  | "unknown_credit"
  /** The receipt names a different caller pubkey. */
  | "caller_mismatch"
  /** The receipt's DVM identity or signing key does not chain to the provider this record is bound to. */
  | "provider_mismatch"
  /** The receipt is denominated in a different currency than the tracked credit. */
  | "currency_mismatch"
  /** A fact with this fund id is already held. */
  | "duplicate"
  /** The projection is already anchored at or beyond the funding's draw sequence. */
  | "already_reflected";

export interface RecordDrawFundingResult {
  /** The record the fact was judged against, when one exists. */
  credit?: StoredCredit;
  /** True when the fact is now held and eligible for reconciliation. */
  recorded: boolean;
  reason?: DrawFundingRejection;
  /** The chain verdict's reason when `reason` is `invalid` or `provider_mismatch`. */
  verifyReason?: ReceiptInvalidReason;
}

/** A detected disagreement between the local projection and a signed receipt. */
export interface CreditDiscrepancy {
  /** Epoch ms the mismatch was detected. */
  atMs: number;
  /** What the local projection said the balance should be after the draw. */
  expectedMicro: number;
  /** Verified mid-job funding the expectation credited before subtracting the draw. */
  fundedMicro?: number;
  /** What the DVM's countersigned receipt reported. */
  reportedMicro: number;
  /** The draw whose receipt disagreed. */
  drawId: string;
  /** Ledger sequence of the disagreeing receipt. */
  ledgerSeq: number;
  /** Job whose signed receipt anchored the prior expectation, when known. */
  priorJobId?: string;
  /** Job whose signed receipt contradicts it. */
  jobId: string;
}

/** One other credit reported by the DVM's latest signed balance read. */
export interface StoredSiblingCredit {
  /** Server lifecycle; absent on legacy records. */
  status?: "active" | "unbacked";
  /** Credit identifier, needed to reclaim this balance explicitly. */
  creditId: string;
  /** Currency the credit is denominated in. */
  currency: string;
  /** Funded balance, micro-units. */
  balanceMicro: number;
  /** Spendable balance with holds subtracted, micro-units. */
  remainingMicro: number;
  /** Highest ledger sequence the DVM reported for this credit. */
  ledgerSeq: number;
  /** Absolute expiry, epoch ms. */
  expiryMs: number;
  /** Whether expiry has ended new draws on this credit. */
  expired: boolean;
  /** Whether the DVM says a drain can reclaim value from this credit. */
  drainable: boolean;
  /** The last signed read could not confirm the Tempo channel's backing. */
  reconciliationPending?: boolean;
  /** Epoch ms of the signed balance read that reported this row. */
  observedAt: number;
}

/** A released per-call balance that only its owning signed caller can draw again. */
export interface StoredImplicitCredit extends DvmLocated {
  /** x-only pubkey of the signed caller that owns this one-use credit. */
  callerPubkey: string;
  /** Server-derived `imp:<rail>:<paymentId>` identifier. */
  creditId: string;
  /** Denomination advertised for this DVM's job pricing. */
  currency: string;
  /** Last DVM-countersigned spendable balance, in currency micro-units. */
  remainingMicro: number;
  /** Highest countersigned per-credit ledger sequence observed. */
  ledgerSeq: number;
  /** Latest possible expiry derived from the terminal receipt; the server may retire it earlier. */
  expiryMs: number;
  /** `lost` means the credit expired without a drain path. */
  status: "active" | "lost";
  /** Why an otherwise-live row became unusable before a signed zero arrived. */
  lossReason?: "expired" | "not_found";
  /** Terminal job whose receipt first exposed this released balance. */
  releasedByJobId: string;
  /** Epoch ms when the release receipt was issued. */
  releasedAt: number;
  /** Epoch ms of the last receipt or expiry transition applied locally. */
  updatedAt: number;
  /** Most recent sequential mismatch, retained until a later clean receipt. */
  discrepancy?: CreditDiscrepancy;
  /** Job id of the last receipt folded into this balance. */
  lastReceiptJobId?: string;
}

/** The caller's working record of one credit at one DVM. */
export interface StoredCredit extends DvmLocated {
  /** x-only pubkey of the signing identity that owns the credit. */
  callerPubkey: string;
  creditId: string;
  /** True when the caller explicitly cleared this DVM's draw selection. */
  selectionCleared?: true;
  /** Currency the credit is denominated in. */
  currency: string;
  /** Funded balance per the server's last word, micro-units. */
  balanceMicro: number;
  /** Expected spendable balance, micro-units — the figure draws are planned against. */
  remainingMicro: number;
  /** Highest ledger sequence observed for this credit. */
  ledgerSeq: number;
  /** Absolute expiry, epoch ms. */
  expiryMs: number;
  /** Refill target, micro-units, recorded at last sizing. */
  targetMicro: number;
  /** Last drawn amount, micro-units — the draw-first consent gate's price proxy. */
  lastPriceMicro?: number;
  /** Funding-menu snapshot from the last quote/402 that carried one. */
  menu?: CreditMenu;
  /**
   * Server-bound funding rail, preserved across same-credit balance reads. Unknown on balance-
   * adopted records until a funding or binding refusal supplies it.
   */
  rail?: string;
  /**
   * Server-bound x402 instrument. An absent value is unknown, never an exact-payment default;
   * same-credit menu changes do not replace a known binding.
   */
  x402Instrument?: X402CreditInstrument;
  /**
   * CAIP-2 chain of the accepted x402 settlement channel, never the wallet's current pin. Exact
   * credits have no channel-chain binding. Unknown channels require conditional remedies rather
   * than an assumed chain.
   */
  x402ChannelNetwork?: string;
  /**
   * The bound rail whose current outage has already been surfaced to this
   * caller. Persisted across CLI commands so one outage produces one notice;
   * cleared when that rail becomes eligible again or the credit is retired.
   */
  refillUnavailableRail?: string;
  /**
   * The pending drain id whose refill hold has already been surfaced to this
   * caller. Persisted across CLI commands for the same reason as
   * {@link refillUnavailableRail}: the condition is static until the caller
   * acts on it, so one hold is worth one notice rather than one per job.
   *
   * Keyed on the id, and that is what stands in for a `clear` twin: a
   * *different* drain adopted onto this credit re-announces by itself, and the
   * only way to re-record this same id is the same hold the caller has already
   * been told about. See {@link markRefillDrainNoticed}.
   */
  refillDrainNoticed?: string;
  /**
   * Builder identity pubkey last seen on this DVM's `/v1/info`.
   * Recorded so the offline surfaces can match a `trustOverrides` pre-grant
   * without a round trip; absent for DVMs that serve no builder attestation.
   */
  builderPubkey?: string;
  /** Lifecycle status. `expired`/`drained` records stay visible for reclaim. */
  status: StoredCreditStatus;
  /** The last signed read could not confirm the Tempo channel's backing. */
  reconciliationPending?: boolean;
  /**
   * True while the projection is known-stale: a fund leg was accepted whose
   * exact credited amount only the server knows (pro-rata of the artifact's
   * value at its fx). The next signed receipt or fund/balance response is
   * adopted without a mismatch check and clears the flag — comparing against
   * a guessed figure would turn every fx drift into a false alarm.
   */
  provisional?: boolean;
  /**
   * True while {@link StoredCredit.remainingMicro} came from a statement that
   * carries no ledger position — today, the balance an `insufficient_credit`
   * refusal stated. That figure is spendable *net of pending holds*
   * at a moment {@link StoredCredit.ledgerSeq} does not name, so the next
   * sequential receipt is comparing two different instants and its mismatch
   * check is skipped. The first sequenced figure to re-anchor the projection
   * clears the flag.
   */
  unsequencedBalance?: boolean;
  /** Epoch ms the credit was first recorded locally. */
  openedAt: number;
  /** Epoch ms of the last update. */
  updatedAt: number;
  /** Job id of the last receipt applied — the prior artifact a mismatch cites. */
  lastReceiptJobId?: string;
  /**
   * Other credits this caller held here on the latest signed balance read.
   *
   * They remain discovery-only: the draw planner still targets
   * {@link StoredCredit.creditId}. Each row carries enough server-stated data
   * to explain the gap and construct the existing explicit drain command.
   */
  siblingCredits?: StoredSiblingCredit[];
  /**
   * Unresolved drains requested from this endpoint. Retained without a count or age limit;
   * only explicit retirement removes their recovery descriptors and credentials.
   *
   * Plural because drains are credit-scoped while the record is DVM-scoped
   * and re-points at whichever credit the DVM last named ({@link adoptCreditId}):
   * a drain requested on the credit tracked yesterday can still be owed money
   * today, and dropping that pointer is the dangerous direction. Entries whose
   * {@link PendingDrain.creditId} is not {@link StoredCredit.creditId} are
   * stranded — surfaced by `dvm credit list`, reclaimed with
   * `dvm credit drain <dvm> --credit-id <that id>`.
   */
  pendingDrains?: PendingDrain[];
  /**
   * The caller's portable evidence of every reclaim at this DVM, one bundle
   * per drain. Kept after a drain completes: a
   * `requested` with no later `parked`/`sent` is a signed IOU, and this is
   * where it lives. Read back with `dvm credit receipts <dvm>`.
   *
   * Completed bundles form a working projection trimmed to
   * {@link MAX_SETTLED_DRAIN_EVIDENCE} only after durable journaling. The journal
   * retains completed history; an unsettled bundle is never a trim candidate.
   */
  drainEvidence?: StoredDrainEvidence[];
  /** Most recent balance mismatch, kept until the next clean receipt. */
  discrepancy?: CreditDiscrepancy;
  /**
   * Verified mid-job funding facts awaiting the terminal receipt of the draw
   * they grew. Pruned once that draw settles or releases, or once the
   * projection re-anchors at or beyond their sequence.
   */
  drawFundings?: StoredDrawFunding[];
}

/**
 * A DVM-level funding-menu snapshot, independent of any balance the caller
 * holds. It is local guidance from a past signed balance read, never evidence
 * of value and never an input that authorizes a funding.
 */
export interface StoredFundingMenuSnapshot extends DvmLocated {
  /** x-only pubkey of the signing identity that received the menu. */
  callerPubkey: string;
  /** The DVM's validated funding menu. */
  menu: CreditMenu;
  /** Epoch ms when the caller observed this menu. */
  observedAt: number;
  /** Builder identity known during the observation, if the caller had one. */
  builderPubkey?: string;
}

/** Result of applying one receipt's credit block to the local projection. */
export interface ApplyReceiptResult {
  /** The updated record, or undefined when the receipt matched no known credit. */
  credit?: StoredCredit;
  /** Present when the signed `balance_after` contradicted the local projection. */
  mismatch?: CreditDiscrepancy;
  /** Verified mid-job funding the comparison credited to this draw, when any applied. */
  fundedMicro?: number;
}

/** Result of folding an implicit credit receipt into its separate local namespace. */
export interface ApplyImplicitReceiptResult {
  /** Updated balance, absent when no record was needed or a signed zero pruned it. */
  credit?: StoredImplicitCredit;
  /** Present when a sequential signed draw contradicted the prior signed balance. */
  mismatch?: CreditDiscrepancy;
  /** True when this receipt settled the tracked balance to zero and removed it. */
  pruned?: true;
}

/** Tuning for {@link withCreditLock}. Mirrors `WithWalletLockOptions` so the money stores have parity. */
export interface WithCreditLockOptions {
  /** Stale-lock threshold in ms. A lock whose mtime is older than this is reclaimed. Default 10_000. */
  stale?: number;
  /** Number of acquisition retries before failing. Default 600. */
  retries?: number;
  /** Milliseconds between retries. Default 25. */
  retryIntervalMs?: number;
}

/**
 * Serializes the entire synchronous read-modify-write cycle, including filesystem I/O. The
 * callback must not await or return a thenable; misuse throws credit_store_lock_misuse.
 *
 * This is the innermost lock: acquire any rail or wallet lock before entering it. Reentrant
 * calls share the outer lock so multi-step store mutations remain atomic. Acquisition beyond the
 * retry budget throws credit_store_locked.
 */
export function withCreditLock<T>(fn: () => T, opts: WithCreditLockOptions = {}): T {
  if (lockDepth > 0) {
    lockDepth += 1;
    try {
      return rejectAsyncBody(fn());
    } finally {
      lockDepth -= 1;
    }
  }
  const release = acquireCreditLock(opts);
  lockDepth = 1;
  try {
    return rejectAsyncBody(fn());
  } finally {
    lockDepth = 0;
    try {
      release();
    } catch {
      // best-effort: the lock may have been auto-reclaimed as stale, or already released
    }
  }
}

/** Normalise an endpoint to its origin so store keys survive path/slash drift. */
export function normalizeCreditEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}

/**
 * DVM location keyed by the caller-verified (builder pubkey, dvmId) pair, with
 * origin aliases for reaching that same identity. A self-asserted dvmId alone
 * cannot pool hosts.
 */
export interface DvmLocated {
  /** Representative normalised origin the record was opened at. */
  endpoint: string;
  /** Other origins known to serve this same DVM. */
  endpointAliases?: string[];
  /** Immutable DVM identity from `/v1/info`, when the DVM publishes one. */
  dvmId?: string;
  /**
   * Lowercased builder pubkey from a caller-verified DVM attestation. Disk reads check shape
   * only; this field is separate from the unverified builderPubkey advertisement copy.
   */
  attestedBuilderPubkey?: string;
}

/**
 * Returns a shape-valid stored identity pair, or undefined. This does not cryptographically
 * verify hand-edited disk contents.
 */
export function dvmLocationIdentity(record: DvmLocated): AttestedDvmIdentity | undefined {
  if (typeof record.dvmId !== "string" || record.dvmId.length === 0) return undefined;
  const pubkey =
    typeof record.attestedBuilderPubkey === "string"
      ? record.attestedBuilderPubkey.trim().toLowerCase()
      : "";
  if (!/^[0-9a-f]{64}$/.test(pubkey)) return undefined;
  return { dvmId: record.dvmId, builderPubkey: pubkey };
}

/**
 * The row one DVM's caller state lives in: attested identity first, the origin
 * set only when no attested match exists.
 *
 * Two passes rather than one predicate, and that is the point. A single pass
 * could reach a legacy row through a shared origin while an *attested* row for
 * the same DVM sits further down the list — and then heal the legacy one with
 * a pair already owned by its neighbour and splitting one identity across rows.
 *
 * `where` carries whatever else the caller narrows on (`callerPubkey`, a
 * `creditId`), so it applies inside both passes rather than after them.
 */
export function findDvmLocated<T extends DvmLocated>(
  records: readonly T[],
  args: {
    /** Origin the caller is naming, already normalised. */
    endpoint: string;
    /** What the DVM proved about itself on this round trip, when anything. */
    identity?: AttestedDvmIdentity;
    where?: (record: T) => boolean;
  }
): T | undefined {
  const where = args.where ?? (() => true);
  const identity = args.identity;
  if (identity) {
    const attested = records.find(
      (record) => where(record) && matchesDvmIdentity(record, identity)
    );
    if (attested) return attested;
  }
  return records.find(
    (record) => where(record) && matchesDvmOrigin(record, args.endpoint, identity)
  );
}

/**
 * Attach a newly observed hostname, and the identity the DVM just proved.
 * Returns whether bytes changed.
 *
 * The pair is written together: half of it is not an identity, and a row that
 * carries a *conflicting* attested pair never reaches here — {@link
 * findDvmLocated} has already refused it — so stamping is a heal rather than a
 * takeover.
 */
export function attachDvmLocation(
  record: DvmLocated,
  endpoint: string,
  identity?: AttestedDvmIdentity
): boolean {
  let changed = false;
  if (identity) {
    if (record.dvmId !== identity.dvmId) {
      record.dvmId = identity.dvmId;
      changed = true;
    }
    if (record.attestedBuilderPubkey !== identity.builderPubkey) {
      record.attestedBuilderPubkey = identity.builderPubkey;
      changed = true;
    }
  }
  if (endpoint !== record.endpoint && !dvmLocationOrigins(record).includes(endpoint)) {
    record.endpointAliases = [...(record.endpointAliases ?? []), endpoint];
    changed = true;
  }
  return changed;
}

export function dvmLocationOrigins(record: DvmLocated): string[] {
  const aliases = Array.isArray(record.endpointAliases)
    ? record.endpointAliases.filter((endpoint): endpoint is string => typeof endpoint === "string")
    : [];
  const primary = typeof record.endpoint === "string" ? [record.endpoint] : [];
  return [...primary, ...aliases].map(normalizeCreditEndpoint);
}

/**
 * Whether one funding intent belongs to the DVM the caller is naming.
 *
 * Exact origin first, then the alias set of the caller's own credit record for
 * this `creditId` — `creditId` is caller-minted, so that record is the
 * caller's own statement that these two hostnames are one DVM, and it is the
 * same alias set {@link findDvmLocated} resolves credits through. Nothing
 * here trusts a hostname's self-asserted identity: with no record linking the
 * two spellings, the intent stays where it was raised.
 */
export function fundingReachableAt(
  funding: Pick<PendingFunding, "endpoint" | "callerPubkey" | "creditId">,
  endpoint: string,
  credits: readonly StoredCredit[]
): boolean {
  const at = normalizeCreditEndpoint(funding.endpoint);
  const named = normalizeCreditEndpoint(endpoint);
  if (at === named) return true;
  return credits.some((record) => {
    if (record.callerPubkey !== funding.callerPubkey || record.creditId !== funding.creditId) {
      return false;
    }
    const origins = dvmLocationOrigins(record);
    return origins.includes(at) && origins.includes(named);
  });
}

/**
 * The unretired drain requested against one specific credit, if any.
 *
 * Strict on the stamp: an entry belonging to another credit — or to no credit
 * we can name (written before the stamp existed) — is not this credit's drain,
 * and re-posting its id here would open a fresh drain server-side rather than
 * poll the one that is owed.
 */
export function pendingDrainFor(
  record: StoredCredit | undefined,
  creditId: string
): PendingDrain | undefined {
  return record?.pendingDrains?.find((d) => d.creditId === creditId);
}

/**
 * The unretired drain with one specific id, whichever credit it names.
 *
 * The escape hatch behind `--drain-id`: a caller who knows the pairing can
 * re-post an entry this store cannot attribute on its own.
 */
export function pendingDrainById(
  record: StoredCredit | undefined,
  drainId: string
): PendingDrain | undefined {
  return record?.pendingDrains?.find((d) => d.drainId === drainId);
}

/**
 * Load the record for one credit, or undefined when none is tracked.
 *
 * Locked despite reading like a lookup: learning a new `dvmId` or hostname
 * alias rewrites the file, and so does the legacy-duplicate
 * collapse inside {@link loadStore}.
 */
export function loadCredit(
  endpoint: string,
  callerPubkey: string,
  identity?: AttestedDvmIdentity
): StoredCredit | undefined {
  return withCreditLock(() => {
    const key = normalizeCreditEndpoint(endpoint);
    const store = loadStore();
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(identity ? { identity } : {}),
      where: (c) => c.callerPubkey === callerPubkey,
    });
    if (record && attachDvmLocation(record, key, identity)) saveStore(store);
    return record;
  });
}

/** Clear one exact DVM credit from automatic draw selection without deleting its evidence. */
export function clearCreditSelection(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  identity?: AttestedDvmIdentity
): StoredCredit {
  return withCreditLock(() => {
    const key = normalizeCreditEndpoint(endpoint);
    const store = loadStore();
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(identity ? { identity } : {}),
      where: (candidate) =>
        candidate.callerPubkey === callerPubkey && candidate.creditId === creditId,
    });
    if (!record) {
      throw new DvmError(
        "credit_not_found",
        `Credit ${creditId} is not the selected local credit at ${key}.`
      );
    }
    attachDvmLocation(record, key, identity);
    record.selectionCleared = true;
    record.updatedAt = Date.now();
    saveStore(store);
    return structuredClone(record);
  });
}

/** Bounded chronological history with snapshot cursors; seeds surviving legacy evidence. */
export function readCompletedCreditHistory(
  query: CompletedCreditHistoryQuery = {},
): CompletedCreditHistoryPage {
  return withCreditLock(() => {
    loadStore(true);
    return readCreditHistoryPage(query);
  });
}

/** Every tracked credit, most recently updated first. */
export function listCredits(): StoredCredit[] {
  return withCreditLock(() => [...loadStore().credits].sort((a, b) => b.updatedAt - a.updatedAt));
}

/** Released per-call balances, earliest expiry first; expired rows are bounded loss history. */
export function listImplicitCredits(now = Date.now()): StoredImplicitCredit[] {
  return withCreditLock(() => {
    const store = loadStore();
    const aged = ageImplicitCredits(store.implicitCredits, now);
    const capped = capLostImplicitCredits(store.implicitCredits);
    if (aged || capped.changed) {
      store.implicitCredits = capped.credits;
      saveStore(store);
    }
    return [...store.implicitCredits].sort(compareImplicitCredits);
  });
}

/** Released per-call balances owned by one caller at one DVM, earliest expiry first. */
export function loadImplicitCredits(
  endpoint: string,
  callerPubkey: string,
  identity?: AttestedDvmIdentity,
  now = Date.now()
): StoredImplicitCredit[] {
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(endpoint);
    let changed = ageImplicitCredits(store.implicitCredits, now);
    const matches = store.implicitCredits.filter((record) =>
      Boolean(
        findDvmLocated([record], {
          endpoint: key,
          ...(identity ? { identity } : {}),
          where: (candidate) => candidate.callerPubkey === callerPubkey,
        })
      )
    );
    for (const record of matches) {
      changed = attachDvmLocation(record, key, identity) || changed;
    }
    const capped = capLostImplicitCredits(store.implicitCredits);
    if (changed || capped.changed) {
      store.implicitCredits = capped.credits;
      saveStore(store);
    }
    return matches
      .filter((record) => store.implicitCredits.includes(record))
      .sort(compareImplicitCredits);
  });
}

/** Retire a refused implicit draw without pretending the value can be drained. */
export function markImplicitCreditLost(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  creditId: string;
  reason: "expired" | "not_found";
  now?: number;
}): StoredImplicitCredit | undefined {
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    const record = findDvmLocated(store.implicitCredits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (candidate) =>
        candidate.callerPubkey === args.callerPubkey && candidate.creditId === args.creditId,
    });
    if (!record) return undefined;
    const locationChanged = attachDvmLocation(record, key, args.identity);
    if (record.status === "lost" && !archiveOrKeep(
      () => archiveCompletedCreditRecords([completedLoss(record)])
    )) {
      if (locationChanged) saveStore(store);
      return record;
    }
    record.status = "lost";
    record.lossReason = args.reason;
    record.updatedAt = args.now ?? Date.now();
    const capped = capLostImplicitCredits(store.implicitCredits);
    store.implicitCredits = capped.credits;
    saveStore(store);
    return store.implicitCredits.includes(record) ? record : undefined;
  });
}

/** Every remembered DVM funding menu, most recently observed first. */
export function listFundingMenuSnapshots(): StoredFundingMenuSnapshot[] {
  return withCreditLock(() =>
    [...loadStore().fundingMenuSnapshots].sort((a, b) => b.observedAt - a.observedAt)
  );
}

/**
 * Persist a DVM funding menu independently of a credit row.
 *
 * The menu is re-checked through the transport's shared gate before writing so
 * a mocked or hand-constructed result cannot seed the local guidance cache.
 */
export function recordFundingMenuSnapshot(args: {
  endpoint: string;
  /** Identity the DVM attested on this round trip, when it attested one. */
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  menu: CreditMenu;
  builderPubkey?: string;
  now?: number;
}): void {
  const menu = parseCreditMenu(args.menu);
  if (!menu) return;

  withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    const previous = findDvmLocated(store.fundingMenuSnapshots, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (entry) => entry.callerPubkey === args.callerPubkey,
    });
    const index = previous ? store.fundingMenuSnapshots.indexOf(previous) : -1;
    const builderPubkey = args.builderPubkey ?? previous?.builderPubkey;
    const snapshot: StoredFundingMenuSnapshot = {
      // The row keeps the origin it was opened at and learns the new spelling
      // as an alias, so a caller who alternates hostnames still reads one menu.
      endpoint: previous?.endpoint ?? key,
      ...(previous?.endpointAliases ? { endpointAliases: [...previous.endpointAliases] } : {}),
      ...(previous?.dvmId ? { dvmId: previous.dvmId } : {}),
      ...(previous?.attestedBuilderPubkey
        ? { attestedBuilderPubkey: previous.attestedBuilderPubkey }
        : {}),
      callerPubkey: args.callerPubkey,
      menu,
      observedAt: args.now ?? Date.now(),
      ...(builderPubkey ? { builderPubkey } : {}),
    };
    attachDvmLocation(snapshot, key, args.identity);
    if (index === -1) store.fundingMenuSnapshots.push(snapshot);
    else store.fundingMenuSnapshots[index] = snapshot;
    saveStore(store);
  });
}

/**
 * Pending Lightning fundings, oldest first.
 *
 * Optional selectors keep callers from accidentally resuming another
 * identity's or another credit's intent.
 *
 * The `endpoint` selector matches the hostname the intent was recorded at
 * *and* every other hostname the caller's own credit record proves serves the
 * same DVM, so an invoice raised through one spelling is still
 * resumable through the other. The link comes from that record rather than
 * from a `dvmId` stamped here on purpose: this row carries `bolt11`,
 * `paymentHash` and `mppCredential`, and a self-asserted identity has no
 * business selecting a money credential.
 */
export function listPendingFundings(
  args: {
    endpoint?: string;
    callerPubkey?: string;
    creditId?: string;
  } = {}
): PendingFunding[] {
  const endpoint = args.endpoint ? normalizeCreditEndpoint(args.endpoint) : undefined;
  return withCreditLock(() => {
    const store = loadStore();
    return store.pendingFundings
      .filter(
        (funding) =>
          (!endpoint || fundingReachableAt(funding, endpoint, store.credits)) &&
          (!args.callerPubkey || funding.callerPubkey === args.callerPubkey) &&
          (!args.creditId || funding.creditId === args.creditId)
      )
      .sort((a, b) => a.requestedAt - b.requestedAt);
  });
}

/** Load the oldest pending funding matching an endpoint, identity, and optional credit. */
export function loadPendingFunding(
  endpoint: string,
  callerPubkey: string,
  creditId?: string
): PendingFunding | undefined {
  return listPendingFundings({ endpoint, callerPubkey, ...(creditId ? { creditId } : {}) })[0];
}

/**
 * Persist a funding intent or enrich the same intent with its issued invoice.
 *
 * The upsert key is `(callerPubkey, creditId, fundId)` — `fundId` is
 * caller-minted per intent — matched against any row reachable from this
 * endpoint. A row keeps the origin it was raised at even when the enrichment
 * arrives through a sibling hostname: the invoice belongs to the host process
 * that issued it, and rewriting that would point a resume at a host which
 * never saw the intent.
 */
export function recordPendingFunding(funding: PendingFunding): void {
  withCreditLock(() => {
    const store = loadStore();
    const normalized = { ...funding, endpoint: normalizeCreditEndpoint(funding.endpoint) };
    const index = store.pendingFundings.findIndex(
      (entry) =>
        entry.callerPubkey === normalized.callerPubkey &&
        entry.creditId === normalized.creditId &&
        entry.fundId === normalized.fundId &&
        fundingReachableAt(entry, normalized.endpoint, store.credits)
    );
    if (index === -1) store.pendingFundings.push(normalized);
    else
      store.pendingFundings[index] = {
        ...normalized,
        endpoint: store.pendingFundings[index].endpoint,
      };
    saveStore(store);
  });
}

/** Clear one resolved or expired pending funding. */
export function clearPendingFunding(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  fundId: string
): void {
  withCreditLock(() => {
    const store = loadStore();
    const normalized = normalizeCreditEndpoint(endpoint);
    const remaining = store.pendingFundings.filter(
      (entry) =>
        !(
          entry.callerPubkey === callerPubkey &&
          entry.creditId === creditId &&
          entry.fundId === fundId &&
          fundingReachableAt(entry, normalized, store.credits)
        )
    );
    if (remaining.length === store.pendingFundings.length) return;
    saveStore({ ...store, pendingFundings: remaining });
  });
}

/**
 * Record the server's answer to a fund op (or the fund leg of a
 * fund-and-draw). Always the **server's** figures — `funded_micro` can differ
 * from the requested amount (pro-rata crediting of the artifact's actual
 * value), and echoing the request would seed the projection with a number the
 * ledger never held.
 */
export function recordFundResponse(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  credit: CreditWire;
  targetMicro: number;
  menu?: CreditMenu;
  /** Rail the funding rode, when this response came from a funding we drove. */
  rail?: string;
  /** x402 instrument that funding used, when it rode x402. */
  x402Instrument?: X402CreditInstrument;
  /** Chain the settlement channel that funding rode lives on. */
  x402ChannelNetwork?: string;
  /** Builder pubkey off `/v1/info`, when the caller had it in hand. */
  builderPubkey?: string;
  /** Select this exact credit for later draws. */
  select?: boolean;
  /** False when the response is live state beside an older receipt, not that receipt's tuple. */
  sequenced?: boolean;
  now?: number;
}): StoredCredit {
  const now = args.now ?? Date.now();
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    let record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (c) => c.callerPubkey === args.callerPubkey,
    });
    if (!record) {
      record = {
        endpoint: key,
        ...identityFields(args.identity),
        callerPubkey: args.callerPubkey,
        creditId: args.credit.credit_id,
        currency: args.credit.currency,
        balanceMicro: 0,
        remainingMicro: 0,
        ledgerSeq: 0,
        expiryMs: 0,
        targetMicro: args.targetMicro,
        status: "active",
        openedAt: now,
        updatedAt: now,
      };
      store.credits.push(record);
    }
    attachDvmLocation(record, key, args.identity);
    adoptCreditId(record, args.credit.credit_id);
    record.currency = args.credit.currency;
    record.balanceMicro = args.credit.balance_micro;
    record.remainingMicro = args.credit.remaining_micro;
    // Same credit: a stale response arriving after a newer one must not roll the
    // sequence backwards. Different credit: `adoptCreditId` has already zeroed
    // the mark, so the incoming per-credit sequence is taken verbatim.
    record.ledgerSeq = Math.max(record.ledgerSeq, args.credit.ledger_seq);
    // A balance stated at or beyond a funding's draw sequence already nets it.
    pruneDrawFundings(record, record.ledgerSeq);
    record.expiryMs = args.credit.expiry_ms;
    record.targetMicro = args.targetMicro;
    record.status =
      args.credit.status === "unbacked" ? "unbacked" : args.credit.expired ? "expired" : "active";
    record.reconciliationPending = args.credit.reconciliation_pending;
    record.updatedAt = now;
    delete record.provisional;
    // A fresh response and its funding receipt name the same ledger position.
    // A replay returns the original receipt beside mutable live state, so that
    // projection is useful but cannot arm sequential receipt comparisons.
    if (args.sequenced === false) record.unsequencedBalance = true;
    else delete record.unsequencedBalance;
    if (args.menu) record.menu = args.menu;
    if (args.rail) {
      record.rail = args.rail;
      delete record.refillUnavailableRail;
    }
    // Same discipline one level down: recorded only from a funding we drove, so
    // a balance read never invents a binding the server didn't state. The chain
    // rides with the instrument — it only reaches here from a channel
    // funding whose deposit the DVM accepted, which is what makes it the
    // credit's chain rather than the wallet's current pin.
    if (args.x402Instrument) record.x402Instrument = args.x402Instrument;
    if (args.x402ChannelNetwork) record.x402ChannelNetwork = args.x402ChannelNetwork;
    if (args.builderPubkey) record.builderPubkey = args.builderPubkey;
    if (args.select) delete record.selectionCleared;
    // A fresh funding supersedes any recorded disagreement — the server's own
    // figure is now the projection's base, so there is nothing left to dispute.
    delete record.discrepancy;
    saveStore(store);
    return record;
  });
}

/**
 * Reconcile every prepaid credit from one signed balance read into the DVM-scoped row.
 *
 * The server-selected primary remains the only credit the draw planner uses.
 * The rest are a replace-in-full discovery snapshot: retaining a row the DVM
 * omitted would turn an old server statement into a balance that appears live.
 * Derived `imp:` rows are excluded even when a caller passes the full server
 * response: their lifecycle belongs to the separate receipt-backed namespace.
 *
 * The whole sequence runs under one {@link withCreditLock}: it is four
 * read-modify-write cycles expressing a single reconciliation, and a sibling
 * process landing between them would reconcile against a half-applied read.
 */
export function recordBalanceResponse(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  credits: CreditWire[];
  primary?: CreditWire;
  targetMicro?: number;
  menu?: CreditMenu;
  builderPubkey?: string;
  /** Select the returned primary credit for later draws. */
  selectPrimary?: boolean;
  /** False when this read cannot establish a receipt-comparable ledger position. */
  sequenced?: boolean;
  now?: number;
}): StoredCredit | undefined {
  const now = args.now ?? Date.now();
  return withCreditLock(() => {
    const existing = loadCredit(args.endpoint, args.callerPubkey, args.identity);
    const prepaidCredits = args.credits.filter((credit) => !credit.credit_id.startsWith("imp:"));
    const selectedPrimary =
      args.primary && !args.primary.credit_id.startsWith("imp:") ? args.primary : undefined;
    // No arbitrary `credits[0]` fallback: the server deliberately omits its
    // primary when every implicit per-call credit is empty. Adopting one there
    // would turn "nothing open" into an exhausted tracked credit and make the
    // next automatic open look like a cross-rail top-up. An existing tracked id
    // remains reconcilable for older servers that omit only the primary echo.
    const primary =
      selectedPrimary ?? prepaidCredits.find((credit) => credit.credit_id === existing?.creditId);

    if (!primary) {
      if (existing) {
        mutateCredit(
          {
            endpoint: args.endpoint,
            callerPubkey: args.callerPubkey,
            ...(args.identity ? { identity: args.identity } : {}),
          },
          (record) => {
            record.siblingCredits = [];
            return undefined;
          }
        );
      }
      return existing;
    }

    const record = recordFundResponse({
      endpoint: args.endpoint,
      ...(args.identity ? { identity: args.identity } : {}),
      callerPubkey: args.callerPubkey,
      credit: primary,
      targetMicro: args.targetMicro ?? existing?.targetMicro ?? primary.remaining_micro,
      ...(args.menu ? { menu: args.menu } : {}),
      ...(args.builderPubkey ? { builderPubkey: args.builderPubkey } : {}),
      ...(args.selectPrimary ? { select: true } : {}),
      ...(args.sequenced === false ? { sequenced: false } : {}),
      now,
    });
    mutateCredit(
      {
        endpoint: args.endpoint,
        callerPubkey: args.callerPubkey,
        ...(args.identity ? { identity: args.identity } : {}),
      },
      (current) => {
        current.siblingCredits = prepaidCredits
          .filter((credit) => credit.credit_id !== current.creditId)
          .map((credit) => siblingFromWire(credit, now));
        return undefined;
      }
    );
    return loadCredit(args.endpoint, args.callerPubkey, args.identity) ?? record;
  });
}

/**
 * Fold one job receipt's countersigned credit block into the projection.
 *
 * The mismatch check runs only on the gap-free next draw of a settled
 * (`completed`) job: `expected = remaining − amount`. A sequence gap means
 * receipts were missed (another machine, a crash) and the projection has
 * nothing sound to compare against; so does an
 * {@link StoredCredit.unsequencedBalance} figure, which is gap-free by accident
 * rather than by anchoring; a released draw (`failed`/`cancelled`)
 * reports the restored available balance, which legitimately reflects holds
 * this side never modelled. Either way the signed figure is adopted — the
 * DVM's countersignature is the better source — but only the clean
 * contradiction is *reported*, citing both signed artifacts.
 */
export function applyReceiptCredit(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  jobId: string;
  outcome: "completed" | "failed" | "cancelled";
  credit: ReceiptCredit;
  /**
   * Mid-job funding evidence in hand at reconciliation time, admitted under the
   * same lock before the comparison so no sibling process can settle the draw
   * between the two. Each entry is judged exactly as {@link recordDrawFunding}
   * judges it; a refused entry is simply not credited.
   */
  drawFundings?: { receipt: unknown; builder?: ReceiptTrustAnchor }[];
  now?: number;
}): ApplyReceiptResult {
  const now = args.now ?? Date.now();
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (c) => c.callerPubkey === args.callerPubkey && c.creditId === args.credit.credit_id,
    });
    if (!record) return {};
    let admitted = false;
    for (const evidence of args.drawFundings ?? []) {
      const verdict = admitDrawFunding(record, {
        callerPubkey: args.callerPubkey,
        identity: args.identity,
        receipt: evidence.receipt,
        builder: evidence.builder,
        now,
      });
      admitted ||= verdict.recorded;
    }
    // Checked here, under the lock that also applies the receipt: a caller's
    // earlier read proves nothing once another process may have settled a newer
    // draw. Replayed evidence must not touch any field of the newer projection.
    if (args.credit.ledger_seq < record.ledgerSeq) {
      if (admitted) {
        // Exactly what recordDrawFunding would have persisted for the same facts.
        attachDvmLocation(record, key, args.identity);
        record.updatedAt = now;
        saveStore(store);
      }
      return { credit: record };
    }
    attachDvmLocation(record, key, args.identity);

    let mismatch: CreditDiscrepancy | undefined;
    let fundedMicro: number | undefined;
    const sequential = args.credit.ledger_seq === record.ledgerSeq + 1;
    if (
      sequential &&
      args.outcome === "completed" &&
      record.status === "active" &&
      !record.provisional &&
      !record.unsequencedBalance
    ) {
      // Only facts bound to this exact draw at this exact sequence count. A
      // sequential receipt proves the projection predates the draw's placement,
      // and therefore every funding accepted against it; the signed facts are
      // what the projection was missing, not a reason to skip the comparison.
      const eligible = (record.drawFundings ?? []).filter(
        (fact) =>
          fact.drawId === args.credit.draw_id && fact.ledgerSeq === args.credit.ledger_seq
      );
      if (eligible.length > 0) {
        fundedMicro = eligible.reduce((sum, fact) => sum + fact.fundedMicro, 0);
      }
      const expected = record.remainingMicro + (fundedMicro ?? 0) - args.credit.amount;
      if (args.credit.balance_after !== expected) {
        mismatch = {
          atMs: now,
          expectedMicro: expected,
          ...(fundedMicro !== undefined ? { fundedMicro } : {}),
          reportedMicro: args.credit.balance_after,
          drawId: args.credit.draw_id,
          ledgerSeq: args.credit.ledger_seq,
          ...(record.lastReceiptJobId ? { priorJobId: record.lastReceiptJobId } : {}),
          jobId: args.jobId,
        };
        record.discrepancy = mismatch;
      }
    }

    record.remainingMicro = args.credit.balance_after;
    record.ledgerSeq = args.credit.ledger_seq;
    // This draw's facts are spent whatever the outcome: a released draw
    // restores the balance the receipt states, and a repeated terminal
    // reconciliation at an equal sequence must not credit them again.
    pruneDrawFundings(record, record.ledgerSeq, args.credit.draw_id);
    // Anchored again: this figure and the mark it sits at came from the same
    // countersigned block.
    delete record.unsequencedBalance;
    // The countersigned figure re-anchors the projection either way.
    delete record.provisional;
    if (args.outcome === "completed") record.lastPriceMicro = args.credit.amount;
    if (!mismatch && record.discrepancy && args.credit.ledger_seq > record.discrepancy.ledgerSeq) {
      // A later clean receipt retires the recorded disagreement.
      delete record.discrepancy;
    }
    record.lastReceiptJobId = args.jobId;
    record.updatedAt = now;
    saveStore(store);
    return {
      credit: record,
      ...(mismatch ? { mismatch } : {}),
      ...(fundedMicro !== undefined ? { fundedMicro } : {}),
    };
  });
}

/**
 * Admit one signed mid-job funding fact for later reconciliation.
 *
 * Verification happens here, not at the call site: an artifact that raises an
 * expected balance can hide a real shortfall, so nothing reaches
 * {@link StoredCredit.drawFundings} unless its signature holds, it names this
 * caller and credit, and it chains to the provider the record is bound to. An
 * attested record requires a `verified` chain under its own attested builder;
 * an unattested record accepts `verified_unattested`, the same standard its job
 * receipts meet. A fact the projection has already passed is refused as
 * `already_reflected` rather than held for a comparison that can never arm.
 */
export function recordDrawFunding(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  receipt: unknown;
  /** `/v1/info#builder` of the issuing endpoint, when the caller has it. */
  builder?: ReceiptTrustAnchor;
  now?: number;
}): RecordDrawFundingResult {
  const now = args.now ?? Date.now();
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    if (!isDrawFundingReceipt(args.receipt)) {
      return { recorded: false, reason: "invalid", verifyReason: "signature_invalid" };
    }
    const named = args.receipt;
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (c) => c.callerPubkey === args.callerPubkey && c.creditId === named.credit_id,
    });
    if (!record) return { recorded: false, reason: "unknown_credit" };
    const verdict = admitDrawFunding(record, {
      callerPubkey: args.callerPubkey,
      identity: args.identity,
      receipt: named,
      builder: args.builder,
      now,
    });
    if (verdict.recorded) {
      attachDvmLocation(record, key, args.identity);
      record.updatedAt = now;
      saveStore(store);
    }
    return { credit: record, ...verdict };
  });
}

/** The shared admission judgement behind {@link recordDrawFunding} and {@link applyReceiptCredit}. */
function admitDrawFunding(
  record: StoredCredit,
  args: {
    callerPubkey: string;
    identity?: AttestedDvmIdentity;
    receipt: unknown;
    builder?: ReceiptTrustAnchor;
    now: number;
  }
): Omit<RecordDrawFundingResult, "credit"> {
  const verdict = verifyDrawFundingReceiptChain({
    receipt: args.receipt,
    builder: args.builder,
    expectedCallerPubkey: args.callerPubkey,
    expectedCreditId: record.creditId,
  });
  const named = verdict.receipt;
  if (!named) return { recorded: false, reason: "invalid", verifyReason: "signature_invalid" };
  if (verdict.reason === "caller_pubkey_mismatch") return { recorded: false, reason: "caller_mismatch" };
  if (verdict.reason === "credit_id_mismatch") return { recorded: false, reason: "unknown_credit" };
  if (verdict.status === "invalid") {
    const provider =
      verdict.reason === "dvm_identity_mismatch" ||
      verdict.reason === "receipt_key_mismatch" ||
      verdict.reason === "attestation_invalid";
    return {
      recorded: false,
      reason: provider ? "provider_mismatch" : "invalid",
      ...(verdict.reason ? { verifyReason: verdict.reason } : {}),
    };
  }
  if (args.identity && named.dvm_id !== args.identity.dvmId) {
    return { recorded: false, reason: "provider_mismatch", verifyReason: "dvm_identity_mismatch" };
  }
  if (record.dvmId !== undefined && named.dvm_id !== record.dvmId) {
    return { recorded: false, reason: "provider_mismatch", verifyReason: "dvm_identity_mismatch" };
  }
  const attested = dvmLocationIdentity(record);
  if (attested) {
    // The record knows which builder stands behind this DVM. Evidence must
    // chain to that builder — a self-consistent anchor under some other key
    // proves only that someone owns a key.
    const anchorPubkey = args.builder?.pubkey?.trim().toLowerCase();
    if (verdict.status !== "verified" || anchorPubkey !== attested.builderPubkey) {
      return { recorded: false, reason: "provider_mismatch", verifyReason: "receipt_key_mismatch" };
    }
  }
  if (named.currency !== record.currency) return { recorded: false, reason: "currency_mismatch" };
  if (named.ledger_seq <= record.ledgerSeq) return { recorded: false, reason: "already_reflected" };
  const held = record.drawFundings ?? [];
  if (held.some((fact) => fact.fundId === named.fund_id)) {
    return { recorded: false, reason: "duplicate" };
  }
  held.push({
    fundId: named.fund_id,
    jobId: named.job_id,
    drawId: named.draw_id,
    fundedMicro: named.funded_micro,
    ledgerSeq: named.ledger_seq,
    balanceAfterMicro: named.balance_after_micro,
    recordedAt: args.now,
    receipt: named,
  });
  held.sort((a, b) => a.ledgerSeq - b.ledgerSeq || a.recordedAt - b.recordedAt);
  record.drawFundings = held;
  return { recorded: true };
}

/**
 * Drop facts the projection can no longer use: those of the named draw, and
 * every fact whose draw sequence the projection has reached. A sequential
 * comparison can only arm beyond `ledgerSeq`, so what remains is exactly what
 * a future terminal receipt could still need.
 */
function pruneDrawFundings(record: StoredCredit, ledgerSeq: number, drawId?: string): void {
  if (!record.drawFundings) return;
  const kept = record.drawFundings.filter(
    (fact) => fact.ledgerSeq > ledgerSeq && (drawId === undefined || fact.drawId !== drawId)
  );
  if (kept.length === 0) delete record.drawFundings;
  else record.drawFundings = kept;
}

/**
 * Fold one countersigned `imp:` balance into the released-value namespace.
 *
 * Successful one-shot payments settle to zero and never create a row. A
 * failed/cancelled job exposes the restored value; a later explicit draw on
 * that id either updates it from the DVM's signed figure or removes it once
 * the signed balance reaches zero. The receipt timestamp is the only expiry
 * anchor the caller has on a DVM with no credit endpoint, so it supplies a
 * latest-possible local deadline rather than a server-stated expiry.
 */
export function applyImplicitReceiptCredit(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  jobId: string;
  outcome: "completed" | "failed" | "cancelled";
  credit: ReceiptCredit;
  currency: string;
  issuedAtMs: number;
  now?: number;
}): ApplyImplicitReceiptResult {
  if (!args.credit.credit_id.startsWith("imp:")) return {};
  const now = args.now ?? Date.now();
  return withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    let record = findDvmLocated(store.implicitCredits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (candidate) =>
        candidate.callerPubkey === args.callerPubkey &&
        candidate.creditId === args.credit.credit_id,
    });

    // Completed or zero balances do not create history rows; an existing row still receives the
    // reconciliation below.
    if (!record && (args.outcome === "completed" || args.credit.balance_after <= 0)) return {};

    if (!record) {
      record = {
        endpoint: key,
        ...identityFields(args.identity),
        callerPubkey: args.callerPubkey,
        creditId: args.credit.credit_id,
        currency: args.currency,
        remainingMicro: args.credit.balance_after,
        ledgerSeq: args.credit.ledger_seq,
        expiryMs: args.issuedAtMs + IMPLICIT_CREDIT_TTL_MS,
        status: args.issuedAtMs + IMPLICIT_CREDIT_TTL_MS <= now ? "lost" : "active",
        releasedByJobId: args.jobId,
        releasedAt: args.issuedAtMs,
        updatedAt: now,
        lastReceiptJobId: args.jobId,
      };
      store.implicitCredits.push(record);
      const capped = capLostImplicitCredits(store.implicitCredits);
      store.implicitCredits = capped.credits;
      saveStore(store);
      return store.implicitCredits.includes(record) ? { credit: record } : {};
    }

    const locationChanged = attachDvmLocation(record, key, args.identity);
    if (record.status === "lost" && !archiveOrKeep(
      () => archiveCompletedCreditRecords([completedLoss(record)])
    )) {
      if (locationChanged) saveStore(store);
      return { credit: record };
    }
    let mismatch: CreditDiscrepancy | undefined;
    const sequential = args.credit.ledger_seq === record.ledgerSeq + 1;
    if (sequential && args.outcome === "completed" && record.status === "active") {
      const expected = record.remainingMicro - args.credit.amount;
      if (args.credit.balance_after !== expected) {
        mismatch = {
          atMs: now,
          expectedMicro: expected,
          reportedMicro: args.credit.balance_after,
          drawId: args.credit.draw_id,
          ledgerSeq: args.credit.ledger_seq,
          ...(record.lastReceiptJobId ? { priorJobId: record.lastReceiptJobId } : {}),
          jobId: args.jobId,
        };
        record.discrepancy = mismatch;
      }
    }

    if (args.credit.ledger_seq >= record.ledgerSeq) {
      record.remainingMicro = args.credit.balance_after;
      record.ledgerSeq = args.credit.ledger_seq;
    }
    if (!mismatch && record.discrepancy && args.credit.ledger_seq > record.discrepancy.ledgerSeq) {
      delete record.discrepancy;
    }
    record.currency = args.currency;
    record.lastReceiptJobId = args.jobId;
    record.updatedAt = now;

    if (record.remainingMicro <= 0) {
      store.implicitCredits = store.implicitCredits.filter((candidate) => candidate !== record);
      saveStore(store);
      return { ...(mismatch ? { mismatch } : {}), pruned: true };
    }

    if (record.expiryMs <= now) record.status = "lost";
    const capped = capLostImplicitCredits(store.implicitCredits);
    store.implicitCredits = capped.credits;
    saveStore(store);
    return {
      ...(store.implicitCredits.includes(record) ? { credit: record } : {}),
      ...(mismatch ? { mismatch } : {}),
    };
  });
}

/**
 * Ensure a record exists for a credit whose fund leg was just accepted on
 * `/v1/job` (fund-and-draw). The exact credited amount is the
 * server's call (pro-rata at its fx), so the record is marked
 * {@link StoredCredit.provisional} until the countersigned receipt or a
 * fund/balance response adopts the real figures.
 */
export function ensureProvisionalCredit(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  creditId: string;
  currency: string;
  targetMicro: number;
  menu?: CreditMenu;
  now?: number;
}): void {
  const now = args.now ?? Date.now();
  withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(args.endpoint);
    let record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(args.identity ? { identity: args.identity } : {}),
      where: (c) => c.callerPubkey === args.callerPubkey,
    });
    if (!record) {
      record = {
        endpoint: key,
        ...identityFields(args.identity),
        callerPubkey: args.callerPubkey,
        creditId: args.creditId,
        currency: args.currency,
        balanceMicro: 0,
        remainingMicro: 0,
        ledgerSeq: 0,
        expiryMs: 0,
        targetMicro: args.targetMicro,
        status: "active",
        openedAt: now,
        updatedAt: now,
      };
      store.credits.push(record);
    }
    attachDvmLocation(record, key, args.identity);
    adoptCreditId(record, args.creditId);
    record.currency = args.currency;
    record.targetMicro = args.targetMicro;
    record.status = "active";
    record.provisional = true;
    record.updatedAt = now;
    if (args.menu) record.menu = args.menu;
    saveStore(store);
  });
}

/**
 * Mark a credit's lifecycle status (server said gone/expired; drain completed).
 *
 * `ifCreditId` pins the write to the credit the caller meant: the record can
 * re-point mid-command (a drain response echoing a different `credit_id`
 * reconciles through `recordFundResponse` before the status write lands), and
 * zeroing the wrong credit's projection is not a recoverable mistake.
 *
 * Retiring the drain itself is deliberately *not* part of this — a drain is
 * keyed by credit id and cleared with {@link clearPendingDrain}, which the
 * status of whatever credit the record points at now has no bearing on.
 */
export function markCredit(
  endpoint: string,
  callerPubkey: string,
  status: StoredCreditStatus,
  opts: { ifCreditId?: string; identity?: AttestedDvmIdentity } = {}
): void {
  mutateCredit(
    { endpoint, callerPubkey, ...(opts.identity ? { identity: opts.identity } : {}) },
    (record) => {
      if (opts.ifCreditId !== undefined && record.creditId !== opts.ifCreditId) return "skip";
      record.status = status;
      if (status !== "active") {
        delete record.refillUnavailableRail;
        delete record.refillDrainNoticed;
      }
      if (status === "drained") record.remainingMicro = 0;
      return undefined;
    }
  );
}

/** What the caller last heard about a credit's place within the x402 rail. */
export interface StoredCreditX402Binding {
  /** The instrument every later top-up has to arrive on. */
  instrument?: X402CreditInstrument;
  /** The chain its settlement channel lives on, channel-bound only. */
  channelNetwork?: string;
}

/**
 * The x402 binding this DVM's tracked credit carries, when the record names
 * that same credit.
 *
 * Credit-scoped rather than record-scoped: the store holds one record per DVM
 * identity, so a `--credit-id` naming something else is a different credit with
 * its own binding and the pin does not carry across — the rule `pinnedRail`
 * applies to the rail, in the caller CLI, which lives in its own repository.
 * `gone` and `drained` records are excluded for the same reason they can't be
 * refilled at all.
 *
 * Both halves come back together because both answer one question — how to
 * route this credit's next top-up, and what to say when it can't be routed at
 * all — and reading them apart would take two loads of the same record.
 */
export function loadCreditX402Binding(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  identity?: AttestedDvmIdentity
): StoredCreditX402Binding {
  const record = loadCredit(endpoint, callerPubkey, identity);
  if (record?.creditId !== creditId) return {};
  if (record.status !== "active" && record.status !== "expired") return {};
  return {
    ...(record.x402Instrument ? { instrument: record.x402Instrument } : {}),
    ...(record.x402ChannelNetwork ? { channelNetwork: record.x402ChannelNetwork } : {}),
  };
}

/**
 * Adopt the x402 binding a refusal named onto the tracked credit.
 *
 * The heal half of the pin: the local record is a copy of a server-side fact,
 * so the server's own word replaces it rather than the other way round, and one
 * refusal is enough — the next refill routes over the named instrument instead
 * of signing into the same answer again.
 *
 * A heal that actually moves the instrument drops the recorded chain with it
 * unless the caller also supplies the chain resolved from the
 * refusal's channel id. Supplying that resolved chain also fills or corrects a
 * channel instrument that was already recorded — the instrument being equal
 * must not make the newly learned half of its binding a no-op.
 */
export function recordCreditX402Instrument(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  instrument: X402CreditInstrument,
  identity?: AttestedDvmIdentity,
  /** Channel chain learned from the channel store, when the refusal names one. */
  channelNetwork?: string
): void {
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    if (record.creditId !== creditId) return "skip";
    const instrumentChanged = record.x402Instrument !== instrument;
    const channelNetworkChanged =
      instrument === "x402_channel" &&
      channelNetwork !== undefined &&
      record.x402ChannelNetwork !== channelNetwork;
    if (!instrumentChanged && !channelNetworkChanged) return "skip";
    if (instrumentChanged) {
      record.x402Instrument = instrument;
      delete record.x402ChannelNetwork;
    }
    if (instrument === "x402_channel" && channelNetwork !== undefined) {
      record.x402ChannelNetwork = channelNetwork;
    }
    return undefined;
  });
}

/**
 * Adopts safe non-negative integer balances from an insufficient_credit refusal about the
 * tracked credit. Invalid remainingMicro makes the call a no-op; invalid or absent balanceMicro
 * leaves that field unchanged.
 *
 * The refusal has no ledger sequence or expiry. Preserve those marks and suppress one receipt
 * comparison against this unsequenced figure, then re-anchor normally. Server confirmation
 * clears provisional.
 */
export function recordRefusedDrawBalance(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  /** Credit the refused draw named, off the local plan rather than the wire. */
  creditId: string;
  /** `remaining_micro`: spendable, net of pending holds. */
  remainingMicro: unknown;
  /** `balance_micro`: funded balance, with pending holds still counted. */
  balanceMicro?: unknown;
}): void {
  const remaining = safeMicro(args.remainingMicro);
  if (remaining === undefined) return;
  const balance = safeMicro(args.balanceMicro);
  mutateCredit(mutationAt(args.endpoint, args.callerPubkey, args.identity), (record) => {
    // The record is DVM-scoped and re-points at whatever credit the DVM last
    // named; a refusal about the credit it used to track is not a statement
    // about the one it tracks now.
    if (record.creditId !== args.creditId) return "skip";
    const unchanged =
      record.remainingMicro === remaining &&
      (balance === undefined || record.balanceMicro === balance) &&
      record.unsequencedBalance === true &&
      !record.provisional;
    if (unchanged) return "skip";
    record.remainingMicro = remaining;
    if (balance !== undefined) record.balanceMicro = balance;
    record.unsequencedBalance = true;
    delete record.provisional;
    return undefined;
  });
}

/**
 * Record that one bound rail outage has been surfaced.
 *
 * Returns true only for the first observation in an occurrence. Repeated
 * commands seeing the same unavailable rail return false and stay quiet until
 * {@link clearRefillRailUnavailable} observes recovery.
 */
export function markRefillRailUnavailable(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  rail: string,
  identity?: AttestedDvmIdentity
): boolean {
  let firstObservation = false;
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    if (record.creditId !== creditId) return "skip";
    if (record.refillUnavailableRail === rail) return "skip";
    record.refillUnavailableRail = rail;
    firstObservation = true;
    return undefined;
  });
  return firstObservation;
}

/**
 * Record that this credit's refill hold — a drain of its own on record — has
 * been surfaced.
 *
 * Returns true only for the first observation of one hold. Later jobs meeting
 * the same recorded drain return false and stay quiet, because the condition
 * does not change until the caller posts the reclaim.
 *
 * There is deliberately no `clear` twin, unlike {@link markRefillRailUnavailable}.
 * A rail outage recovers on its own and has to be re-announced when it recurs;
 * a drain does not — it leaves only by being posted, which retires the entry
 * this is keyed on. So a *different* adopted drain re-announces here by itself,
 * and the mark left behind on a retired one names an id nothing can match.
 */
export function markRefillDrainNoticed(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  drainId: string,
  identity?: AttestedDvmIdentity
): boolean {
  let firstObservation = false;
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    if (record.creditId !== creditId) return "skip";
    if (record.refillDrainNoticed === drainId) return "skip";
    record.refillDrainNoticed = drainId;
    firstObservation = true;
    return undefined;
  });
  return firstObservation;
}

/** Clear a surfaced bound-rail outage once the rail is eligible again. */
export function clearRefillRailUnavailable(
  endpoint: string,
  callerPubkey: string,
  creditId: string,
  identity?: AttestedDvmIdentity
): void {
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    if (record.creditId !== creditId) return "skip";
    if (record.refillUnavailableRail === undefined) return "skip";
    delete record.refillUnavailableRail;
    return undefined;
  });
}

/**
 * Remove a tracked credit outright. For unwinding a record created
 * speculatively (pre-op drain persistence) once the server definitively says
 * the credit never existed — a status flip would leave permanent list noise
 * for what was a typo.
 */
export function forgetCredit(
  endpoint: string,
  callerPubkey: string,
  identity?: AttestedDvmIdentity
): void {
  withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(endpoint);
    // Removed by reference rather than by re-running the predicate: the row
    // this drops has to be the exact one every other verb resolves, and only
    // `findDvmLocated`'s two passes decide that.
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(identity ? { identity } : {}),
      where: (c) => c.callerPubkey === callerPubkey,
    });
    if (!record) return;
    archiveCompletedCreditRecords(
      (record.drainEvidence ?? [])
        .filter((bundle) => bundle.settledAt !== undefined)
        .map((bundle) => completedRefund(record, bundle))
    );
    saveStore({ ...store, credits: store.credits.filter((c) => c !== record) });
  });
}

/**
 * Upserts the whole (drainId, creditId) identity without replacing another drain on that credit.
 * Readers select the first matching stored array entry; callers must prevent ambiguous
 * simultaneous drain requests.
 */
export function recordPendingDrain(
  endpoint: string,
  callerPubkey: string,
  drain: PendingDrain,
  identity?: AttestedDvmIdentity
): void {
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    const drains = record.pendingDrains ?? [];
    const index = drains.findIndex(
      (d) => d.drainId === drain.drainId && d.creditId === drain.creditId
    );
    if (index === -1) drains.push(drain);
    else drains[index] = drain;
    record.pendingDrains = drains;
    return undefined;
  });
}

/**
 * Retires only the named (drainId, creditId) pair, including a legacy unstamped entry. The
 * record may now track another credit whose drain and projection must survive.
 */
export function clearPendingDrain(
  endpoint: string,
  callerPubkey: string,
  drain: Pick<PendingDrain, "drainId" | "creditId">,
  identity?: AttestedDvmIdentity
): void {
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    const before = record.pendingDrains ?? [];
    const remaining = before.filter(
      (d) => !(d.drainId === drain.drainId && d.creditId === drain.creditId)
    );
    if (remaining.length === before.length) return "skip";
    if (remaining.length === 0) delete record.pendingDrains;
    else record.pendingDrains = remaining;
    return undefined;
  });
}

/**
 * Replaces one drain's complete receipt bundle while preserving other drains and the identity
 * advertisement collected with it. An unreachable /v1/info must not erase an existing anchor; a
 * successful response explicitly lacking an anchor may.
 */
export function recordDrainReceipts(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  /** The drain being polled — the bundle's key. */
  drainId: string;
  /** The credit it reclaims, pinned beside the receipts (see {@link StoredDrainEvidence.creditId}). */
  creditId: string;
  receipts: unknown[];
  read: TrustAnchorRead;
  now?: number;
}): void {
  const {
    endpoint,
    identity,
    callerPubkey,
    drainId,
    creditId,
    receipts,
    read,
    now = Date.now(),
  } = args;
  if (receipts.length === 0) return;
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    const evidence = (record.drainEvidence ??= []);
    let bundle = evidence.find((e) => e.drainId === drainId);
    if (bundle?.settledAt !== undefined && !archiveOrKeep(
      () => archiveCompletedCreditRecords([completedRefund(record, bundle!)])
    )) {
      return "skip";
    }
    if (!bundle) {
      bundle = { drainId, creditId, receipts: [], collectedAt: now };
      evidence.push(bundle);
    }
    bundle.creditId = creditId;
    bundle.receipts = receipts;
    bundle.collectedAt = now;
    bundle.settlement ??= {
      rail: null,
      currency: record.creditId === creditId ? record.currency : null,
      amountMicro: null,
      feeMicro: null,
    };
    if (read.anchor) bundle.anchor = read.anchor;
    else if (read.reachable) delete bundle.anchor;
    record.drainEvidence = evidence;
    return undefined;
  });
}

/**
 * Marks an arrived refund as settled, making its archived bundle eligible for capped retention.
 * Clearing a pending drain alone does not establish settlement. Keyed by drainId even after the
 * tracked credit changes.
 */
export function settleDrainEvidence(args: {
  endpoint: string;
  identity?: AttestedDvmIdentity;
  callerPubkey: string;
  drainId: string;
  settlement?: StoredDrainEvidence["settlement"];
  now?: number;
}): void {
  const { endpoint, identity, callerPubkey, drainId, now = Date.now() } = args;
  mutateCredit(mutationAt(endpoint, callerPubkey, identity), (record) => {
    const evidence = record.drainEvidence ?? [];
    const bundle = evidence.find((e) => e.drainId === drainId);
    // No bundle means the DVM served no receipts for this drain — nothing to
    // settle, and nothing worth an `updatedAt` bump.
    if (!bundle || bundle.settledAt !== undefined) return "skip";
    bundle.settledAt = now;
    if (args.settlement) bundle.settlement = args.settlement;
    record.drainEvidence = evidence;
    return undefined;
  });
}

function identityFields(
  identity: AttestedDvmIdentity | undefined
): Pick<DvmLocated, "dvmId" | "attestedBuilderPubkey"> {
  if (!identity) return {};
  return { dvmId: identity.dvmId, attestedBuilderPubkey: identity.builderPubkey };
}

function mutationAt(
  endpoint: string,
  callerPubkey: string,
  identity: AttestedDvmIdentity | undefined
): CreditMutationLocation {
  return { endpoint, callerPubkey, ...(identity ? { identity } : {}) };
}

/** The exact attested pair, which is the only thing that pools two hostnames. */
function matchesDvmIdentity(record: DvmLocated, identity: AttestedDvmIdentity): boolean {
  const stored = dvmLocationIdentity(record);
  return stored?.dvmId === identity.dvmId && stored.builderPubkey === identity.builderPubkey;
}

/**
 * Origin fallback excludes rows carrying another attested identity or a different dvmId, so
 * sharing a hostname cannot bypass the identity pass.
 */
function matchesDvmOrigin(
  record: DvmLocated,
  endpoint: string,
  identity: AttestedDvmIdentity | undefined
): boolean {
  if (identity) {
    if (dvmLocationIdentity(record) !== undefined) return false;
    if (record.dvmId !== undefined && record.dvmId !== identity.dvmId) return false;
  }
  return dvmLocationOrigins(record).includes(endpoint);
}

/**
 * Adoption resets per-credit sequence, projection flags and funding bindings; carrying the old
 * high-water mark would suppress the new credit's receipts. Endpoint-level menus, sizing and
 * identity survive. Drains and evidence survive under their own stamped credit/drain identities.
 */
function adoptCreditId(record: StoredCredit, creditId: string): void {
  if (record.creditId === creditId) return;
  if (record.status === "active" || record.status === "expired" || record.status === "unbacked") {
    const prior: StoredSiblingCredit = {
      creditId: record.creditId,
      status: record.status === "unbacked" ? "unbacked" : "active",
      currency: record.currency,
      balanceMicro: record.balanceMicro,
      remainingMicro: record.remainingMicro,
      ledgerSeq: record.ledgerSeq,
      expiryMs: record.expiryMs,
      expired: record.status === "expired",
      drainable: record.status !== "unbacked" && record.balanceMicro > 0,
      ...(record.reconciliationPending ? { reconciliationPending: true } : {}),
      observedAt: record.updatedAt,
    };
    record.siblingCredits = [
      ...(record.siblingCredits ?? []).filter(
        (sibling) => sibling.creditId !== prior.creditId && sibling.creditId !== creditId
      ),
      prior,
    ];
  } else if (record.siblingCredits) {
    record.siblingCredits = record.siblingCredits.filter(
      (sibling) => sibling.creditId !== creditId
    );
  }
  record.creditId = creditId;
  record.ledgerSeq = 0;
  record.balanceMicro = 0;
  record.remainingMicro = 0;
  record.expiryMs = 0;
  delete record.unsequencedBalance;
  delete record.rail;
  delete record.x402Instrument;
  delete record.x402ChannelNetwork;
  delete record.refillUnavailableRail;
  delete record.refillDrainNoticed;
  delete record.discrepancy;
  delete record.lastReceiptJobId;
  delete record.drawFundings;
}

/**
 * Settled reclaim working-projection cap. Unpaid bundles do not count toward this limit and remain pinned.
 */
const MAX_SETTLED_DRAIN_EVIDENCE = 8;

interface CreditStoreFile {
  credits: StoredCredit[];
  implicitCredits: StoredImplicitCredit[];
  pendingFundings: PendingFunding[];
  fundingMenuSnapshots: StoredFundingMenuSnapshot[];
}

/** Completed losses retained in the bounded working projection after durable archival. */
const MAX_LOST_IMPLICIT_CREDITS = 8;

/** Largest epoch-ms magnitude JavaScript can render as an ISO date. */
const MAX_DATE_MS = 8_640_000_000_000_000;

/** The legacy record shape, as it may still sit on disk. */
type LegacyStoredCredit = StoredCredit & { pendingDrain?: unknown };

function loadStore(requireArchive = false): CreditStoreFile {
  if (!existsSync(CREDITS_FILE)) {
    return { credits: [], implicitCredits: [], pendingFundings: [], fundingMenuSnapshots: [] };
  }
  let raw: string;
  try {
    raw = readFileSync(CREDITS_FILE, "utf-8");
  } catch (cause) {
    // A failed open does not establish corrupt bytes. Leave the file at its original path and
    // refuse the mutation.
    throw unreadableStore(cause);
  }
  let data: Partial<CreditStoreFile>;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Malformed entries are filtered, but a non-object root is a damaged file rather than an
    // empty store.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the file parsed as JSON but is not a credit-store object");
    }
    data = parsed as Partial<CreditStoreFile>;
  } catch (cause) {
    throw quarantineCorruptStore(cause);
  }
  const merged = mergeDuplicateCredits(
    Array.isArray(data.credits)
      ? data.credits
          .filter((record): record is StoredCredit => isObjectRecord(record))
          .map((record) =>
            normalizeRailKey(normalizeEvidence(normalizeDrains(normalizeSiblingCredits(record))))
          )
      : []
  );
  const snapshots = mergeDuplicateSnapshots(
    Array.isArray(data.fundingMenuSnapshots)
      ? data.fundingMenuSnapshots.filter(isFundingMenuSnapshot)
      : [],
    merged.credits
  );
  const fundings = dedupePendingFundings(
    Array.isArray(data.pendingFundings)
      ? data.pendingFundings
          .filter((funding): funding is PendingFunding => isObjectRecord(funding))
          .map(normalizeRailKey)
      : [],
    merged.credits
  );
  const implicit = dedupeImplicitCredits(
    Array.isArray(data.implicitCredits) ? data.implicitCredits.filter(isStoredImplicitCredit) : [],
    requireArchive
  );
  const store = {
    credits: merged.credits,
    implicitCredits: implicit.credits,
    pendingFundings: fundings.fundings,
    fundingMenuSnapshots: snapshots.snapshots,
  };
  // Persist all legacy duplicate collapses in one atomic rename so no intermediate collection
  // state reaches disk.
  if (requireArchive) archiveStore(store);
  if (merged.changed || snapshots.changed || fundings.changed || implicit.changed) saveStore(store);
  else if (!requireArchive) archiveOrKeep(() => archiveStore(store));
  return store;
}

/** Hand-edited store guard for the compact implicit-credit shape. */
function isStoredImplicitCredit(value: unknown): value is StoredImplicitCredit {
  if (!isObjectRecord(value)) return false;
  return (
    typeof value.endpoint === "string" &&
    typeof value.callerPubkey === "string" &&
    typeof value.creditId === "string" &&
    value.creditId.startsWith("imp:") &&
    typeof value.currency === "string" &&
    typeof value.remainingMicro === "number" &&
    Number.isFinite(value.remainingMicro) &&
    typeof value.ledgerSeq === "number" &&
    Number.isInteger(value.ledgerSeq) &&
    typeof value.expiryMs === "number" &&
    Number.isFinite(value.expiryMs) &&
    (value.status === "active" || value.status === "lost") &&
    typeof value.releasedByJobId === "string" &&
    typeof value.releasedAt === "number" &&
    Number.isFinite(value.releasedAt) &&
    typeof value.updatedAt === "number" &&
    Number.isFinite(value.updatedAt)
  );
}

/** Collapse duplicate aliases of the same signed caller's same implicit credit. */
function dedupeImplicitCredits(
  credits: StoredImplicitCredit[],
  requireArchive = false
): {
  credits: StoredImplicitCredit[];
  changed: boolean;
} {
  const merged: StoredImplicitCredit[] = [];
  let changed = false;
  for (const candidate of credits) {
    candidate.endpoint = normalizeCreditEndpoint(candidate.endpoint);
    const identity = dvmLocationIdentity(candidate);
    const existing = findDvmLocated(merged, {
      endpoint: candidate.endpoint,
      ...(identity ? { identity } : {}),
      where: (record) =>
        record.callerPubkey === candidate.callerPubkey && record.creditId === candidate.creditId,
    });
    if (!existing) {
      merged.push(candidate);
      continue;
    }
    if (!archiveOrKeep(() => archiveCompletedCreditRecords(
      [existing, candidate].filter((record) => record.status === "lost").map(completedLoss)
    ), requireArchive)) return { credits, changed: false };
    changed = true;
    for (const origin of dvmLocationOrigins(candidate)) {
      attachDvmLocation(existing, origin, identity);
    }
    if (
      candidate.ledgerSeq > existing.ledgerSeq ||
      (candidate.ledgerSeq === existing.ledgerSeq && candidate.updatedAt > existing.updatedAt)
    ) {
      existing.currency = candidate.currency;
      existing.remainingMicro = candidate.remainingMicro;
      existing.ledgerSeq = candidate.ledgerSeq;
      existing.status = candidate.status;
      if (candidate.lossReason) existing.lossReason = candidate.lossReason;
      else delete existing.lossReason;
      existing.updatedAt = candidate.updatedAt;
      existing.lastReceiptJobId = candidate.lastReceiptJobId;
      existing.discrepancy = candidate.discrepancy;
    }
    existing.expiryMs = Math.min(existing.expiryMs, candidate.expiryMs);
    if (candidate.releasedAt < existing.releasedAt) {
      existing.releasedAt = candidate.releasedAt;
      existing.releasedByJobId = candidate.releasedByJobId;
    }
  }
  const capped = capLostImplicitCredits(merged, requireArchive);
  return { credits: capped.credits, changed: changed || capped.changed };
}

/** Mark balances past the caller's conservative local deadline as irrecoverably lost. */
function ageImplicitCredits(credits: StoredImplicitCredit[], now: number): boolean {
  let changed = false;
  for (const credit of credits) {
    if (credit.status === "active" && credit.expiryMs <= now) {
      credit.status = "lost";
      credit.lossReason = "expired";
      credit.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

/** Keep all spendable value, but only the newest bounded loss history per caller/DVM. */
function capLostImplicitCredits(
  credits: StoredImplicitCredit[],
  requireArchive = false
): {
  credits: StoredImplicitCredit[];
  changed: boolean;
} {
  const archived = archiveOrKeep(
    () => archiveCompletedCreditRecords(
      credits.filter((credit) => credit.status === "lost").map(completedLoss)
    ),
    requireArchive
  );
  if (!archived) return { credits, changed: false };
  const lostByOwner = new Map<string, StoredImplicitCredit[]>();
  for (const credit of credits) {
    if (credit.status !== "lost") continue;
    const identity = dvmLocationIdentity(credit);
    const dvmKey = identity
      ? `${identity.dvmId}\u0000${identity.builderPubkey}`
      : normalizeCreditEndpoint(credit.endpoint);
    const key = `${credit.callerPubkey}\u0000${dvmKey}`;
    const group = lostByOwner.get(key) ?? [];
    group.push(credit);
    lostByOwner.set(key, group);
  }
  const dropped = new Set<StoredImplicitCredit>();
  for (const group of lostByOwner.values()) {
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const credit of group.slice(MAX_LOST_IMPLICIT_CREDITS)) dropped.add(credit);
  }
  return dropped.size === 0
    ? { credits, changed: false }
    : { credits: credits.filter((credit) => !dropped.has(credit)), changed: true };
}

/** Spendable first and soonest-expiring first; loss history remains newest-first after it. */
function compareImplicitCredits(a: StoredImplicitCredit, b: StoredImplicitCredit): number {
  if (a.status !== b.status) return a.status === "active" ? -1 : 1;
  return a.status === "active" ? a.expiryMs - b.expiryMs : b.updatedAt - a.updatedAt;
}

/**
 * Legacy menu identities are inferred only from unambiguous caller-owned credit records at the
 * same origin. A multi-tenant origin naming several identities remains separate.
 */
function mergeDuplicateSnapshots(
  snapshots: StoredFundingMenuSnapshot[],
  credits: StoredCredit[]
): { snapshots: StoredFundingMenuSnapshot[]; changed: boolean } {
  const identities = originIdentityMap(credits);
  const merged: StoredFundingMenuSnapshot[] = [];
  const byIdentity = new Map<string, number>();
  let changed = false;
  for (const snapshot of snapshots) {
    const stamped = identities.get(`${snapshot.callerPubkey}\u0000${snapshot.endpoint}`);
    if (stamped !== undefined && snapshot.dvmId === undefined) {
      snapshot.dvmId = stamped.dvmId;
      if (stamped.attestedBuilderPubkey !== undefined) {
        snapshot.attestedBuilderPubkey = stamped.attestedBuilderPubkey;
      }
      changed = true;
    }
    if (snapshot.dvmId === undefined) {
      merged.push(snapshot);
      continue;
    }
    // Attested and unattested identities group separately; a claimed dvmId cannot inherit a
    // proved identity's menu.
    const key = `${snapshot.callerPubkey}\u0000${snapshot.dvmId}\u0000${snapshot.attestedBuilderPubkey ?? ""}`;
    const index = byIdentity.get(key);
    if (index === undefined) {
      byIdentity.set(key, merged.length);
      merged.push(snapshot);
      continue;
    }
    merged[index] = mergeSnapshots(merged[index], snapshot);
    changed = true;
  }
  return { snapshots: merged, changed };
}

/** Keep the freshest menu while remembering every hostname it was seen at. */
function mergeSnapshots(
  left: StoredFundingMenuSnapshot,
  right: StoredFundingMenuSnapshot
): StoredFundingMenuSnapshot {
  const leftSeen = Number.isFinite(left.observedAt) ? left.observedAt : 0;
  const rightSeen = Number.isFinite(right.observedAt) ? right.observedAt : 0;
  const [newer, older] = rightSeen >= leftSeen ? [right, left] : [left, right];
  const snapshot: StoredFundingMenuSnapshot = { ...newer };
  // The builder key is a property of the machine, not of the observation, so
  // the older row's copy is worth keeping when the newer row never learned one.
  if (snapshot.builderPubkey === undefined && older.builderPubkey !== undefined) {
    snapshot.builderPubkey = older.builderPubkey;
  }
  // No identity back-fill here, unlike `mergeCreditRecords`: the only caller
  // groups on `(callerPubkey, dvmId, attestedBuilderPubkey)`, so two snapshots
  // reaching this function already agree on both halves.
  const origins = dvmLocationOrigins(newer).concat(dvmLocationOrigins(older));
  const aliases = [...new Set(origins)].filter((origin) => origin !== snapshot.endpoint);
  if (aliases.length > 0) snapshot.endpointAliases = aliases;
  else delete snapshot.endpointAliases;
  return snapshot;
}

/** The identity halves one credit record proves for one origin. */
type OriginIdentity = Pick<DvmLocated, "dvmId" | "attestedBuilderPubkey"> & { dvmId: string };

/**
 * Maps caller/origin to the identity its credit records establish, omitting origins with
 * competing dvmIds or attested builder keys.
 */
function originIdentityMap(credits: StoredCredit[]): Map<string, OriginIdentity> {
  const identities = new Map<string, OriginIdentity>();
  const ambiguous = new Set<string>();
  for (const record of credits) {
    if (typeof record.dvmId !== "string" || typeof record.callerPubkey !== "string") continue;
    const identity: OriginIdentity = {
      dvmId: record.dvmId,
      ...(record.attestedBuilderPubkey !== undefined
        ? { attestedBuilderPubkey: record.attestedBuilderPubkey }
        : {}),
    };
    for (const origin of dvmLocationOrigins(record)) {
      const key = `${record.callerPubkey}\u0000${origin}`;
      const seen = identities.get(key);
      if (
        seen !== undefined &&
        (seen.dvmId !== identity.dvmId ||
          seen.attestedBuilderPubkey !== identity.attestedBuilderPubkey)
      ) {
        ambiguous.add(key);
        continue;
      }
      identities.set(key, identity);
    }
  }
  for (const key of ambiguous) identities.delete(key);
  return identities;
}

/**
 * Deduplicates (callerPubkey, creditId, fundId) only within linked origins. Keep the earliest
 * origin for recovery and the newest whole observation; never union invoice hashes or credentials.
 */
function dedupePendingFundings(fundings: PendingFunding[], credits: readonly StoredCredit[]): {
  fundings: PendingFunding[];
  changed: boolean;
} {
  const kept: { funding: PendingFunding; originAt: number }[] = [];
  const byIntent = new Map<string, typeof kept>();
  let changed = false;
  for (const funding of fundings) {
    const at = Number.isFinite(funding.requestedAt) ? funding.requestedAt : 0;
    if (
      typeof funding.endpoint !== "string" ||
      typeof funding.callerPubkey !== "string" ||
      typeof funding.creditId !== "string" ||
      typeof funding.fundId !== "string"
    ) {
      kept.push({ funding, originAt: at });
      continue;
    }
    const key = `${funding.callerPubkey}\u0000${funding.creditId}\u0000${funding.fundId}`;
    const group = byIntent.get(key) ?? [];
    const seen = group.find((candidate) => fundingReachableAt(candidate.funding, funding.endpoint, credits));
    if (seen === undefined) {
      const entry = { funding, originAt: at };
      group.push(entry);
      byIntent.set(key, group);
      kept.push(entry);
      continue;
    }
    const seenAt = Number.isFinite(seen.funding.requestedAt) ? seen.funding.requestedAt : 0;
    const endpoint = at < seen.originAt ? funding.endpoint : seen.funding.endpoint;
    seen.funding = { ...(at > seenAt ? funding : seen.funding), endpoint };
    seen.originAt = Math.min(at, seen.originAt);
    changed = true;
  }
  return { fundings: kept.map((entry) => entry.funding), changed };
}

/** Keep only collection entries that can carry a hand-edited record. */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Collapse legacy hostname-keyed copies of one caller-owned credit. */
function mergeDuplicateCredits(credits: StoredCredit[]): {
  credits: StoredCredit[];
  changed: boolean;
} {
  const groups: StoredCredit[][] = [];
  const byCredit = new Map<string, StoredCredit[]>();
  let changed = false;
  for (const record of credits) {
    if (typeof record.creditId !== "string" || typeof record.callerPubkey !== "string") {
      groups.push([record]);
      continue;
    }
    const key = `${record.callerPubkey}\u0000${record.creditId}`;
    let group = byCredit.get(key);
    if (group === undefined) {
      group = [];
      byCredit.set(key, group);
      groups.push(group);
    }
    let combined = record;
    let index = group.findIndex((candidate) => compatibleCreditLocations(candidate, combined));
    while (index !== -1) {
      combined = mergeCreditRecords(group[index], combined);
      group.splice(index, 1);
      changed = true;
      // A same-origin upgrade can now join an authenticated alias seen earlier in this load.
      index = group.findIndex((candidate) => compatibleCreditLocations(candidate, combined));
    }
    group.push(combined);
  }
  return { credits: groups.flat(), changed };
}

/** Credit IDs are provider-scoped; only a complete attested pair can join unrelated origins. */
function compatibleCreditLocations(left: DvmLocated, right: DvmLocated): boolean {
  const leftIdentity = dvmLocationIdentity(left);
  const rightIdentity = dvmLocationIdentity(right);
  if (leftIdentity && rightIdentity) {
    return matchesDvmIdentity(left, rightIdentity);
  }
  if (leftIdentity) {
    return dvmLocationOrigins(left).some((origin) => matchesDvmOrigin(right, origin, leftIdentity));
  }
  if (rightIdentity) {
    return dvmLocationOrigins(right).some((origin) => matchesDvmOrigin(left, origin, rightIdentity));
  }
  return dvmLocationOrigins(left).some((origin) => matchesDvmOrigin(right, origin, undefined));
}

/** Keep the freshest projection while retaining every money-recovery pointer. */
function mergeCreditRecords(left: StoredCredit, right: StoredCredit): StoredCredit {
  const leftUpdated = Number.isFinite(left.updatedAt) ? left.updatedAt : 0;
  const rightUpdated = Number.isFinite(right.updatedAt) ? right.updatedAt : 0;
  const [newer, older] = rightUpdated >= leftUpdated ? [right, left] : [left, right];
  const record: StoredCredit = { ...newer };

  const identity = dvmLocationIdentity(newer) ?? dvmLocationIdentity(older);
  if (identity) {
    record.dvmId = identity.dvmId;
    record.attestedBuilderPubkey = identity.builderPubkey;
  } else if (record.dvmId === undefined && record.attestedBuilderPubkey === undefined) {
    // Unverified halves stay with their source; combining them could manufacture an attested pair.
    record.dvmId = older.dvmId;
    record.attestedBuilderPubkey = older.attestedBuilderPubkey;
  }
  if (record.rail === undefined && older.rail !== undefined) record.rail = older.rail;
  if (record.x402Instrument === undefined && older.x402Instrument !== undefined) {
    record.x402Instrument = older.x402Instrument;
  }
  if (record.x402ChannelNetwork === undefined && older.x402ChannelNetwork !== undefined) {
    record.x402ChannelNetwork = older.x402ChannelNetwork;
  }
  if (record.menu === undefined && older.menu !== undefined) record.menu = older.menu;
  if (record.builderPubkey === undefined && older.builderPubkey !== undefined) {
    record.builderPubkey = older.builderPubkey;
  }

  const endpoints = dvmLocationOrigins(newer).concat(dvmLocationOrigins(older));
  const aliases = [...new Set(endpoints)].filter((endpoint) => endpoint !== record.endpoint);
  if (aliases.length > 0) record.endpointAliases = aliases;
  else delete record.endpointAliases;

  const pendingDrains = unionPendingDrains(newer.pendingDrains, older.pendingDrains);
  if (pendingDrains.length > 0) record.pendingDrains = pendingDrains;
  else delete record.pendingDrains;

  const drainEvidence = unionDrainEvidence(newer.drainEvidence, older.drainEvidence);
  if (drainEvidence.length > 0) record.drainEvidence = drainEvidence;
  else delete record.drainEvidence;

  const siblings = Array.isArray(newer.siblingCredits)
    ? newer.siblingCredits
    : older.siblingCredits;
  if (siblings) {
    record.siblingCredits = siblings.filter((sibling) => sibling.creditId !== record.creditId);
  } else {
    delete record.siblingCredits;
  }
  return record;
}

function unionPendingDrains(
  preferred: PendingDrain[] | undefined,
  fallback: PendingDrain[] | undefined
): PendingDrain[] {
  const byDrain = new Map<string, PendingDrain>();
  for (const drain of [...(fallback ?? []), ...(preferred ?? [])]) {
    const key = `${drain.drainId}\u0000${drain.creditId ?? ""}`;
    byDrain.set(key, { ...(byDrain.get(key) ?? {}), ...drain } as PendingDrain);
  }
  return [...byDrain.values()];
}

function unionDrainEvidence(
  preferred: StoredDrainEvidence[] | undefined,
  fallback: StoredDrainEvidence[] | undefined
): StoredDrainEvidence[] {
  const byDrain = new Map<string, StoredDrainEvidence>();
  for (const evidence of [...(fallback ?? []), ...(preferred ?? [])]) {
    const key = `${evidence.drainId}\u0000${evidence.creditId}`;
    const existing = byDrain.get(key);
    if (!existing) {
      byDrain.set(key, evidence);
      continue;
    }
    const [newer, older] =
      evidence.collectedAt >= existing.collectedAt ? [evidence, existing] : [existing, evidence];
    const receipts = unionUnknown(newer.receipts, older.receipts);
    byDrain.set(key, {
      ...older,
      ...newer,
      receipts,
      collectedAt: Math.max(existing.collectedAt, evidence.collectedAt),
      ...(existing.settledAt !== undefined || evidence.settledAt !== undefined
        ? { settledAt: Math.max(existing.settledAt ?? 0, evidence.settledAt ?? 0) }
        : {}),
    });
  }
  return [...byDrain.values()];
}

function unionUnknown(preferred: unknown[], fallback: unknown[]): unknown[] {
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const value of [...preferred, ...fallback]) {
    let key: string;
    try {
      const serialized: unknown = JSON.stringify(value);
      key = typeof serialized === "string" ? serialized : String(value);
    } catch {
      key = String(value);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(value);
  }
  return values;
}

/** Validate a hand-edited funding-menu snapshot without weakening credit reads. */
function isFundingMenuSnapshot(value: unknown): value is StoredFundingMenuSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Partial<StoredFundingMenuSnapshot>;
  return (
    typeof snapshot.endpoint === "string" &&
    typeof snapshot.callerPubkey === "string" &&
    typeof snapshot.observedAt === "number" &&
    Number.isFinite(snapshot.observedAt) &&
    Math.abs(snapshot.observedAt) <= MAX_DATE_MS &&
    parseCreditMenu(snapshot.menu) !== undefined &&
    (snapshot.builderPubkey === undefined || typeof snapshot.builderPubkey === "string")
  );
}

function siblingFromWire(credit: CreditWire, observedAt: number): StoredSiblingCredit {
  return {
    creditId: credit.credit_id,
    status: credit.status ?? "active",
    currency: credit.currency,
    balanceMicro: credit.balance_micro,
    remainingMicro: credit.remaining_micro,
    ledgerSeq: credit.ledger_seq,
    expiryMs: credit.expiry_ms,
    expired: credit.expired,
    drainable: credit.drainable,
    ...(credit.reconciliation_pending ? { reconciliationPending: true } : {}),
    observedAt,
  };
}

/**
 * Migrates the legacy mpp rail key to tempo in memory; the next ordinary write persists it. No
 * downstream reader accepts the old key.
 */
function normalizeRailKey<T>(record: T): T {
  const loose = record as {
    rail?: string;
    refillUnavailableRail?: string;
    pendingDrains?: ({ method?: string } | undefined)[];
  };
  if (loose.rail === LEGACY_TEMPO_RAIL_KEY) loose.rail = "tempo";
  if (loose.refillUnavailableRail === LEGACY_TEMPO_RAIL_KEY) loose.refillUnavailableRail = "tempo";
  if (Array.isArray(loose.pendingDrains)) {
    for (const drain of loose.pendingDrains) {
      if (drain?.method === LEGACY_TEMPO_RAIL_KEY) drain.method = "tempo";
    }
  }
  return record;
}

const LEGACY_TEMPO_RAIL_KEY = "mpp";

/** Keep malformed sibling snapshots from taking down every credit command. */
function normalizeSiblingCredits(record: StoredCredit): StoredCredit {
  if (!Array.isArray(record.siblingCredits)) {
    delete record.siblingCredits;
    return record;
  }
  record.siblingCredits = record.siblingCredits.filter(
    (sibling) => isSiblingCredit(sibling) && sibling.creditId !== record.creditId
  );
  return record;
}

function isSiblingCredit(value: unknown): value is StoredSiblingCredit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sibling = value as StoredSiblingCredit;
  const status = (value as { status?: unknown }).status;
  return (
    typeof sibling.creditId === "string" &&
    typeof sibling.currency === "string" &&
    Number.isSafeInteger(sibling.balanceMicro) &&
    Number.isSafeInteger(sibling.remainingMicro) &&
    Number.isSafeInteger(sibling.ledgerSeq) &&
    Number.isFinite(sibling.expiryMs) &&
    Math.abs(sibling.expiryMs) <= MAX_DATE_MS &&
    typeof sibling.expired === "boolean" &&
    typeof sibling.drainable === "boolean" &&
    (status === undefined || status === "active" || status === "unbacked") &&
    (sibling.reconciliationPending === undefined ||
      typeof sibling.reconciliationPending === "boolean") &&
    Number.isFinite(sibling.observedAt) &&
    Math.abs(sibling.observedAt) <= MAX_DATE_MS
  );
}

/**
 * Migrates singular pendingDrain to an unstamped array entry: its original credit was never
 * recorded and must not be guessed. Filters malformed array entries; the next ordinary write
 * persists normalization.
 */
function normalizeDrains(record: StoredCredit): StoredCredit {
  const legacy = record as LegacyStoredCredit;
  const drains = (Array.isArray(record.pendingDrains) ? record.pendingDrains : []).filter(
    isDrainish
  );
  if (isDrainish(legacy.pendingDrain)) drains.unshift(legacy.pendingDrain);
  delete legacy.pendingDrain;
  if (drains.length === 0) delete record.pendingDrains;
  else record.pendingDrains = drains;
  return record;
}

/**
 * Checks bundle drain ids and receipt-array shape; receipt entries remain opaque. Legacy
 * unkeyed receipts remain on disk for possible recovery; malformed named bundles are filtered
 * and unknown credit ids remain unattributed. Consumers own receipt and anchor authentication.
 */
function normalizeEvidence(record: StoredCredit): StoredCredit {
  if (!Array.isArray(record.drainEvidence)) {
    delete record.drainEvidence;
    return record;
  }
  const evidence = record.drainEvidence.filter(isEvidenceish).map((e) => {
    const bundle: StoredDrainEvidence = {
      ...e,
      creditId: typeof e.creditId === "string" ? e.creditId : "",
      collectedAt: Number.isFinite(e.collectedAt) ? e.collectedAt : 0,
    };
    if (!Number.isFinite(bundle.settledAt)) delete bundle.settledAt;
    return bundle;
  });
  if (evidence.length === 0) delete record.drainEvidence;
  else record.drainEvidence = evidence;
  return record;
}

function isEvidenceish(value: unknown): value is StoredDrainEvidence {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as StoredDrainEvidence).drainId === "string" &&
    Array.isArray((value as StoredDrainEvidence).receipts)
  );
}

function isDrainish(value: unknown): value is PendingDrain {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PendingDrain).drainId === "string"
  );
}

/** Archive errors retain completed evidence without blocking unrelated active recovery. */
function archiveOrKeep(action: () => void, requireArchive = false): boolean {
  try {
    action();
    return true;
  } catch (error) {
    if (requireArchive || !(error instanceof DvmError) || error.code !== "credit_history_unavailable") {
      throw error;
    }
    return false;
  }
}

/** Archive all terminal facts before publishing a trimmed working projection. */
function archiveStore(store: CreditStoreFile): void {
  archiveCompletedCreditRecords([
    ...store.credits.flatMap((credit) =>
      (credit.drainEvidence ?? [])
        .filter((bundle) => bundle.settledAt !== undefined)
        .map((bundle) => completedRefund(credit, bundle)),
    ),
    ...store.implicitCredits
      .filter((credit) => credit.status === "lost")
      .map(completedLoss),
  ]);
}
function capDrainEvidence(
  evidence: StoredDrainEvidence[],
): StoredDrainEvidence[] {
  const settled = evidence
    .filter((e) => e.settledAt !== undefined)
    .sort((a, b) => a.settledAt! - b.settledAt!);
  const dropped = new Set(
    settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_DRAIN_EVIDENCE)),
  );
  return evidence.filter((e) => !dropped.has(e));
}

function saveStore(store: CreditStoreFile): void {
  ensureConfigDir();
  if (archiveOrKeep(() => archiveStore(store))) {
    for (const credit of store.credits) {
      if (credit.drainEvidence) credit.drainEvidence = capDrainEvidence(credit.drainEvidence);
    }
  }
  // Per-process temp name. The lock already serialises this CLI's own writers,
  // but a fixed sibling path is also what an *older* dvm binary — or any
  // process that never took the lock — would interleave into, publishing a
  // torn file under the real name.
  const tmp = `${CREDITS_FILE}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try {
    renameSync(tmp, CREDITS_FILE);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup; a leftover .tmp is harmless next run
    }
    throw err;
  }
}

/**
 * The store exists and we could not open it. Nothing is moved and nothing is
 * written — the file is presumed intact, and the fault is in the environment
 * (permissions, descriptor exhaustion, a path that is now a directory).
 */
function unreadableStore(cause: unknown): DvmError {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new DvmError(
    "credit_store_unreadable",
    `The prepaid-credit record at ${CREDITS_FILE} exists but could not be opened: ${detail}`,
    `The file was left untouched. Check that you own it and can read it ('ls -l ${CREDITS_FILE}'), then retry — 'chmod 600 ${CREDITS_FILE}' fixes the common case. Do not delete it: it may hold DVM-signed drain receipts for a refund that is still owed.`,
    { credits_file: CREDITS_FILE, cause: detail },
    `Your local record of prepaid credits could not be opened — this looks like a file-permissions problem on this machine, not damage to the record. Nothing was changed or deleted, so any signed proof of a refund you are owed is still there.`
  );
}

/**
 * Preserves damaged JSON or a non-object root under a timestamped sibling and names that path in
 * the error. An open failure goes to unreadableStore without moving bytes; a failed quarantine
 * must not permit overwrite.
 */
function quarantineCorruptStore(cause: unknown): DvmError {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantined = `${CREDITS_FILE}.corrupt-${stamp}-${String(process.pid)}`;
  let moved = false;
  try {
    renameSync(CREDITS_FILE, quarantined);
    moved = true;
  } catch {
    // An unreadable file we cannot move aside is still one we must not
    // overwrite — leave it exactly where it is and name it instead.
  }
  const kept = moved ? quarantined : CREDITS_FILE;
  return new DvmError(
    "credit_store_corrupt",
    moved
      ? `The prepaid-credit record at ${CREDITS_FILE} is damaged and could not be parsed; it was moved aside to ${quarantined}.`
      : `The prepaid-credit record at ${CREDITS_FILE} is damaged and could not be parsed, and could not be moved aside.`,
    `Do not delete ${kept} — it may hold DVM-signed drain receipts for a refund that is still owed. Balances themselves live on the DVM, so 'dvm credit balance <dvm>' re-reads them.`,
    {
      credits_file: CREDITS_FILE,
      ...(moved ? { quarantined_path: quarantined } : {}),
      cause: cause instanceof Error ? cause.message : String(cause),
    },
    `The local record of your prepaid credits is damaged. It was set aside at ${kept} rather than overwritten, so any signed proof of a refund you are owed is still in that file. Your credits are held by each DVM, not by this file, so re-reading a balance will restore what the CLI shows.`
  );
}

interface CreditMutationLocation {
  endpoint: string;
  callerPubkey: string;
  identity?: AttestedDvmIdentity;
}

function safeMicro(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * The lock spans the complete read-modify-write. A skip preserves updatedAt, but a newly learned
 * location alias is still persisted.
 */
function mutateCredit(
  location: CreditMutationLocation,
  mutate: (record: StoredCredit) => "skip" | undefined
): void {
  withCreditLock(() => {
    const store = loadStore();
    const key = normalizeCreditEndpoint(location.endpoint);
    const record = findDvmLocated(store.credits, {
      endpoint: key,
      ...(location.identity ? { identity: location.identity } : {}),
      where: (c) => c.callerPubkey === location.callerPubkey,
    });
    if (!record) return;
    const locationChanged = attachDvmLocation(record, key, location.identity);
    if (mutate(record) === "skip") {
      if (locationChanged) saveStore(store);
      return;
    }
    record.updatedAt = Date.now();
    saveStore(store);
  });
}

const DEFAULT_LOCK_STALE_MS = 10_000;
const DEFAULT_LOCK_RETRIES = 600;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 25;

/** Reentrancy depth for {@link withCreditLock}; `lockSync` is not itself reentrant. */
let lockDepth = 0;

/**
 * `proper-lockfile`'s sync API rejects its own `retries` option outright
 * (`Cannot use retries with the sync api`, `lib/adapter.js`), so the retry
 * loop is hand-rolled around `lockSync`. The default budget deliberately
 * outlasts `stale`, so a lock left behind by a killed `dvm` is reclaimed
 * rather than waited out to the end.
 *
 * `realpath: false` means the lock does not require `credits.json` to exist,
 * which matters on the very first credit a caller opens — the same reason
 * `withWalletLock` sets it.
 */
function acquireCreditLock(opts: WithCreditLockOptions): () => void {
  ensureConfigDir();
  // Derived here rather than at module scope: `CREDITS_FILE` is a mocked
  // constant in several suites, and reading it on import binds the wrong path.
  const lockPath = `${CREDITS_FILE}.lock`;
  const stale = opts.stale ?? DEFAULT_LOCK_STALE_MS;
  const retries = opts.retries ?? DEFAULT_LOCK_RETRIES;
  const interval = opts.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return lockfile.lockSync(CREDITS_FILE, {
        lockfilePath: lockPath,
        stale,
        realpath: false,
      });
    } catch (err) {
      lastError = err;
      // Retry contention only; permission or configuration failures cannot improve by waiting
      // and must not suggest deleting a nonexistent lock.
      if ((err as NodeJS.ErrnoException).code !== "ELOCKED") {
        const detail = err instanceof Error ? err.message : String(err);
        const configDir = dirname(lockPath);
        throw new DvmError(
          "credit_store_lock_failed",
          `Could not create the prepaid-credit lock at ${lockPath}: ${detail}`,
          `This is not contention — nothing is holding the lock. Check that ${configDir} exists and is writable by you ('ls -ld ${configDir}'), then retry.`,
          {
            lock_file: lockPath,
            config_dir: configDir,
            underlying: detail,
            errno_code: (err as NodeJS.ErrnoException).code,
          },
          `The dvm CLI could not create the small lock file it uses to keep two commands from writing your credit record at once. Its folder looks unwritable — nothing about your credits is wrong, and nothing was changed.`
        );
      }
      if (attempt === retries) break;
      sleepSync(interval);
    }
  }
  throw new DvmError(
    "credit_store_locked",
    `Could not acquire the prepaid-credit lock at ${lockPath} within the retry budget.`,
    `Another dvm CLI may be writing to ${CREDITS_FILE}. Wait a moment and retry. If no other dvm CLI is running, remove ${lockPath} and try again.`,
    {
      lock_file: lockPath,
      underlying: lastError instanceof Error ? lastError.message : String(lastError),
    }
  );
}

/**
 * Enforce {@link withCreditLock}'s synchronous contract, which its generic
 * signature cannot: a body returning a promise would leave the lock released
 * while the writes it schedules were still to come.
 */
function rejectAsyncBody<T>(result: T): T {
  if (typeof (result as { then?: unknown } | null | undefined)?.then !== "function") {
    return result;
  }
  throw new DvmError(
    "credit_store_lock_misuse",
    "withCreditLock was called with an asynchronous body. The lock is released when the body returns, so a promise's writes would run unprotected.",
    "Make the locked body synchronous — the credit store's whole surface is sync — and do any awaiting outside the lock."
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
