import { isTestMintUrl } from "../../lib/mints";
import {
  Amount,
  CheckStateEnum,
  getP2PKExpectedWitnessPubkeys,
  getSecretData,
  getSecretKind,
  getTagInt,
  getTags,
  parseP2PKSecret,
  type Proof,
  type Wallet,
  verifyDleqIfPresent,
} from "@cashu/cashu-ts";

import type { LockPubkey } from "../../lib/cashu/lock-pubkey";
import { verifyCashuToken } from "../../lib/cashu/verify";
import type { CreditLedgerLike } from "./credit-ledger";
import type { DisposableCashuCommit } from "./disposable-cashu-store";
import { getWallet } from "../../lib/cashu/wallet";
import {
  type AccumulatorPool,
  type AccumulatorQuerier,
  AccumulatorReplayError,
  acceptedRequestIds,
  claimAccumulatorRequestId,
  insertAccumulatorRows,
} from "./wallet-accumulator-store";

/**
 * Machine codes an accumulator-path receive can reject with. Named and exported
 * so the payment-error builder in `payment.ts` folds them into `PaymentErrorCode`
 * and keeps display/hint/retryable copy in lockstep with this union.
 */
export type AccumulatorRejectionCode =
  | "missing_request_id"
  | "missing_lock_pubkey"
  | "not_p2pk_locked"
  | "wrong_lock_pubkey"
  | "lock_not_exclusive"
  | "proof_not_unspent"
  | "proof_pending"
  | "replay_rejected"
  | "request_id_reused"
  | "mint_unreachable"
  | "invalid_token";

/** Gross proof face, receiver input fee, and net fundable Cashu value. */
export interface CashuFundingValuation {
  /** Full face value of the received proof set. */
  grossMsats: number;
  /** Standalone NUT-02 input fee for spending this exact proof set. */
  inputFeeMsats: number;
  /** Caller principal: {@link grossMsats} minus {@link inputFeeMsats}. */
  netMsats: number;
}

/** Cashu value accepted by the accumulator and passed to its commit hooks. */
export interface AcceptedAccumulatorValue extends CashuFundingValuation {
  mintUrl: string;
  /** Net fundable value; retained as the common payment-rail field. */
  paidMsats: number;
}

/** Outcome of an accumulator-path receive. */
export type AccumulatorReceiveResult =
  | {
      kind: "accumulated";
      /** Net fundable msats after the received proofs' NUT-02 input fee. */
      paidMsats: number;
      /** Full face value physically accepted into the accumulator. */
      grossMsats: number;
      /** Standalone NUT-02 input fee reserved by the received proof set. */
      inputFeeMsats: number;
      /** Caller principal after subtracting the receiver input fee. */
      netMsats: number;
      mintUrl: string;
    }
  | {
      kind: "rejected";
      code: AccumulatorRejectionCode;
      message: string;
      /**
       * On `replay_rejected`: the one request id every presented proof was
       * already accepted under. Absent when only some proofs were accepted or
       * they were accepted under different request ids.
       */
      acceptedRequestId?: string;
    };

export interface AccumulatorReceiveOpts {
  /** Encoded Cashu token from the `X-Cashu` header. */
  cashuToken: string;
  /** UUIDv4 from `X-Cashu-Request-Id` — required for replay protection. */
  requestId?: string;
  mints: string[];
  db?: AccumulatorPool;
  /** Explicit test-only in-memory commit backend. */
  disposable?: DisposableCashuCommit;
  withDisposableLedger?: (ledger: CreditLedgerLike, accepted: AcceptedAccumulatorValue) => Promise<void>;
  /** DVM identifier (`DVMKIT_DVM_ID`) — scopes replay and accumulator rows. */
  dvmId: string;
  /**
   * Active NUT-11 P2PK lock pubkeys — proofs must be locked to one of these.
   * The first entry is the current pubkey; any further entries are retired
   * pubkeys still within the rotation grace window. Accepting any
   * entry keeps in-flight agents with a stale `/v1/info` cache from suffering
   * dead capital across a rotation. The `LockPubkey` brand guarantees each
   * entry is already lowercase, so the receive loop can compare structurally.
   */
  lockPubkeys: LockPubkey[];
  /** Test seam — defaults to the cashu-ts wallet wrapper. */
  walletProvider?: typeof getWallet;
  /**
   * Validates the computed funding value after all rail checks and before any
   * accumulator insert. A throw rejects the request without persisting proofs.
   */
  beforeCommit?: (accepted: AcceptedAccumulatorValue) => void | Promise<void>;
  /**
   * Runs inside the same transaction as the accumulator insert, which keeps the
   * accepted proofs and their funding commitment atomic. The verifier passes the `CreditLedger.fund` +
   * `draw` here so the rail commit and the ledger credit land atomically. A
   * throw rolls the whole transaction back: the proofs are NOT accepted and
   * no money-without-credit state can exist. Only invoked after every rail
   * check (decode, P2PK lock, NUT-7 checkstate) has passed, so the
   * transaction never spans a mint round-trip.
   */
  withCommitTx?: (tx: AccumulatorQuerier, accepted: AcceptedAccumulatorValue) => Promise<void>;
}

/**
 * Value an exact decoded Cashu proof set using the loaded wallet's keyset fees.
 *
 * The cashu-ts primitive resolves every proof's actual keyset, including
 * mixed and inactive keysets, and throws when any fee schedule is unavailable.
 */
export function valueCashuFunding(
  wallet: Pick<Wallet, "getFeesForProofs">,
  proofs: Proof[]
): CashuFundingValuation {
  let grossSats = Amount.zero();
  for (const proof of proofs) grossSats = grossSats.add(proof.amount);
  const inputFeeSats = wallet.getFeesForProofs(proofs);
  if (inputFeeSats.toBigInt() >= grossSats.toBigInt()) {
    throw new Error("Cashu input fee must be lower than the received proof face value.");
  }
  const netSats = grossSats.subtract(inputFeeSats);
  return {
    grossMsats: grossSats.multiplyBy(1000).toNumber(),
    inputFeeMsats: inputFeeSats.multiplyBy(1000).toNumber(),
    netMsats: netSats.multiplyBy(1000).toNumber(),
  };
}

/**
 * Shortest NUT-11 refund `locktime`, in seconds from now, that `/v1/info`
 * advertises as `cashu.min_locktime`. Banked proofs wait for the batch melt,
 * so a refund path must stay closed for at least this long.
 */
export const CASHU_MIN_LOCKTIME_SECONDS = 604_800;

/**
 * Slack subtracted from {@link CASHU_MIN_LOCKTIME_SECONDS} when enforcing it.
 * The reference caller locks to `now + max(48h, min_locktime)` and re-sends an
 * unacknowledged payment for at most 24 hours, so an honest resume still clears
 * the enforced floor.
 */
export const CASHU_LOCKTIME_RESUME_MARGIN_SECONDS = 86_400;

/** The NUT-11 tags a banked proof may carry; any other tag is refused. */
const P2PK_TAG_KEYS = new Set(["locktime", "refund", "pubkeys", "n_sigs", "sigflag", "n_sigs_refund"]);
const SINGLE_VALUE_TAG_KEYS = new Set(["locktime", "n_sigs", "sigflag", "n_sigs_refund"]);

/** Outcome of judging one proof secret's NUT-11 spending conditions. */
export type CashuLockAssessment =
  | {
      kind: "exclusive";
      /** The DVM lock key named by the secret's `data` field. */
      lockPubkey: LockPubkey;
    }
  | {
      kind: "rejected";
      code: "not_p2pk_locked" | "wrong_lock_pubkey" | "lock_not_exclusive";
      message: string;
      /**
       * True when the only defect is a refund `locktime` below the floor. That
       * verdict depends on the clock, so a proof accepted earlier can reach it
       * on a later retry.
       */
      locktimeBelowFloor?: boolean;
    };

/**
 * Judge from the secret's structure, independent of the current lock state,
 * whether only one of `lockPubkeys` can spend the proof until at least
 * `CASHU_MIN_LOCKTIME_SECONDS - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS` after
 * `nowSec`, and whether the DVM's melter can sign it and the mint redeem it.
 * Every key must be a 33-byte compressed hex key: the mint cannot parse an
 * x-only key and the cashu-ts signer refuses padded or duplicate ones. `data`
 * matches a DVM key by x coordinate, which is what a BIP-340 signature binds,
 * so either 02/03 prefix of a DVM key is accepted.
 */
export function assessCashuLock(
  secret: string,
  lockPubkeys: readonly LockPubkey[],
  nowSec: number
): CashuLockAssessment {
  try {
    parseP2PKSecret(secret);
    if (getSecretKind(secret) !== "P2PK") throw new Error("not P2PK");
  } catch {
    return { kind: "rejected", code: "not_p2pk_locked", message: "Proof secret is not a NUT-11 P2PK secret." };
  }

  const dvmKeyFor = (x: string | undefined): LockPubkey | undefined =>
    x === undefined ? undefined : lockPubkeys.find((pk) => compressedX(pk) === x);
  const data = getSecretData(secret).data;
  const dataX = typeof data === "string" ? compressedX(data) : undefined;
  const lockPubkey = dvmKeyFor(dataX);
  if (!dataX || !lockPubkey) {
    return {
      kind: "rejected",
      code: "wrong_lock_pubkey",
      message: "Proof is not locked to one of this DVM's active lock pubkeys, spelled as a 33-byte compressed hex key.",
    };
  }

  const notExclusive = (message: string, locktimeBelowFloor?: true): CashuLockAssessment => ({
    kind: "rejected",
    code: "lock_not_exclusive",
    message,
    ...(locktimeBelowFloor && { locktimeBelowFloor }),
  });
  try {
    // The melter signs through cashu-ts, which parses every key list (refund
    // keys included) before signing; a secret it cannot parse is unmeltable.
    // Only its throw is used here: its key list depends on the clock.
    getP2PKExpectedWitnessPubkeys(secret);
  } catch (err) {
    return notExclusive(`Proof carries an unreadable spending condition: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Tags are checked against the canonical shape rather than read leniently:
  // cashu-ts reads a valueless or malformed tag as absent while the mint can
  // fail on it, so anything outside this allowlist is refused.
  const tags = new Map<string, string[]>();
  for (const tag of getTags(secret) as unknown[]) {
    if (!Array.isArray(tag) || !tag.every((item) => typeof item === "string")) {
      return notExclusive("Proof carries a malformed tag.");
    }
    const [key, ...values] = tag as string[];
    if (key === undefined || !P2PK_TAG_KEYS.has(key)) return notExclusive(`Proof carries the unsupported tag ${JSON.stringify(key)}.`);
    if (tags.has(key)) return notExclusive(`Proof repeats the ${key} tag.`);
    if (values.length === 0) return notExclusive(`Proof carries a ${key} tag without a value.`);
    if (SINGLE_VALUE_TAG_KEYS.has(key) && values.length !== 1) return notExclusive(`Proof's ${key} tag must carry exactly one value.`);
    tags.set(key, values);
  }

  const sigflag = tags.get("sigflag")?.[0];
  if (sigflag !== undefined && sigflag !== "SIG_INPUTS") {
    return notExclusive(`Proof requires sigflag ${sigflag}; this DVM accepts SIG_INPUTS only.`);
  }
  const nSigs = tags.get("n_sigs")?.[0];
  if (nSigs !== undefined && nSigs !== "1") {
    return notExclusive(`Proof requires n_sigs=${nSigs}; this DVM accepts a single-signature lock only.`);
  }
  const mainX = [dataX];
  for (const key of tags.get("pubkeys") ?? []) {
    const x = compressedX(key);
    if (!x || !dvmKeyFor(x)) return notExclusive("Proof's pubkeys tag names a key other than this DVM's lock pubkeys.");
    if (mainX.includes(x)) return notExclusive("Proof repeats a key across data and pubkeys.");
    mainX.push(x);
  }
  const refundX: string[] = [];
  for (const key of tags.get("refund") ?? []) {
    const x = compressedX(key);
    if (!x) return notExclusive("Proof's refund tag names a key that is not a 33-byte compressed hex key.");
    if (refundX.includes(x)) return notExclusive("Proof repeats a key in its refund tag.");
    refundX.push(x);
  }
  const nSigsRefund = tags.get("n_sigs_refund")?.[0];
  if (nSigsRefund !== undefined && !(/^[1-9][0-9]*$/.test(nSigsRefund) && Number(nSigsRefund) <= refundX.length)) {
    return notExclusive(`Proof's n_sigs_refund ${nSigsRefund} is not a count between 1 and its number of refund keys.`);
  }
  const locktimeValue = tags.get("locktime")?.[0];
  if (locktimeValue !== undefined) {
    const locktime = /^(0|[1-9][0-9]*)$/.test(locktimeValue) ? Number(locktimeValue) : NaN;
    if (!Number.isSafeInteger(locktime)) return notExclusive(`Proof's locktime ${locktimeValue} is not a unix-seconds integer.`);
    const floor = nowSec + CASHU_MIN_LOCKTIME_SECONDS - CASHU_LOCKTIME_RESUME_MARGIN_SECONDS;
    if (locktime < floor) {
      return notExclusive(
        `Proof locktime ${locktime} is earlier than the accepted floor ${floor} (unix seconds).`,
        true
      );
    }
  }
  return { kind: "exclusive", lockPubkey };
}

export async function acceptAccumulatorPayment(
  opts: AccumulatorReceiveOpts
): Promise<AccumulatorReceiveResult> {
  if (opts.disposable && !opts.mints.every(isTestMintUrl)) {
    throw new Error("Disposable Cashu accepts only known test or loopback mints.");
  }
  if (!opts.requestId) {
    return {
      kind: "rejected",
      code: "missing_request_id",
      message: "X-Cashu-Request-Id header required for the agent-wallet path.",
    };
  }
  if (opts.lockPubkeys.length === 0) {
    return {
      kind: "rejected",
      code: "missing_lock_pubkey",
      message: "DVM is not configured with DVMKIT_CASHU_LOCK_PUBKEY.",
    };
  }
  const accepted = opts.lockPubkeys;

  let mintUrl: string;
  let proofs: Proof[];
  let valuation: CashuFundingValuation;
  try {
    const meta = verifyCashuToken(opts.cashuToken, opts.mints);
    mintUrl = meta.mint;
    const walletProvider = opts.walletProvider ?? getWallet;
    const wallet = await walletProvider(mintUrl);
    proofs = wallet.decodeToken(opts.cashuToken).proofs;
    if (meta.unit !== "sat" || proofs.length === 0) {
      throw new Error("Cashu payment requires nonempty sat proofs.");
    }
    if (new Set(proofs.map((proof) => proof.secret)).size !== proofs.length) {
      throw new Error("Cashu payment carries the same proof more than once.");
    }
    for (const proof of proofs) {
      if (!proof.dleq || !verifyDleqIfPresent(proof, wallet.getKeyset(proof.id))) {
        throw new Error(
          "Cashu payment requires valid mint-provided NUT-12 DLEQ evidence for every proof. Request a fresh token from a compatible mint."
        );
      }
    }
    valuation = valueCashuFunding(wallet, proofs);
  } catch (err) {
    return {
      kind: "rejected",
      code: "invalid_token",
      message: err instanceof Error ? err.message : "Cashu token decode failed",
    };
  }

  const acceptedValue: AcceptedAccumulatorValue = {
    ...valuation,
    mintUrl,
    paidMsats: valuation.netMsats,
  };

  // Judge every proof's lock from its secret's structure before any mint
  // round-trip or write. The same loop extracts each NUT-11 `locktime` (ms
  // since epoch) for oldest-first ordering and the expiring-soon monitor.
  const nowSec = Math.floor(Date.now() / 1000);
  const tExpireMsByIndex: (number | null)[] = [];
  const matchedLockPubkeyByIndex: LockPubkey[] = [];
  let belowFloorMessage: string | undefined;
  for (const p of proofs) {
    const lock = assessCashuLock(p.secret, accepted, nowSec);
    if (lock.kind === "rejected") {
      if (!lock.locktimeBelowFloor) return { kind: "rejected", code: lock.code, message: lock.message };
      belowFloorMessage ??= lock.message;
      continue;
    }
    matchedLockPubkeyByIndex.push(lock.lockPubkey);
    tExpireMsByIndex.push(parseNut11LocktimeMs(p.secret));
  }
  if (belowFloorMessage) {
    // The floor moves with the clock, so a retry of a payment banked earlier
    // can fall below it. Answer that retry as the replay it is, letting the
    // route recover the original job, instead of as a fresh refusal.
    const banked = await acceptedUnder(opts, proofs);
    if (banked.some((id) => id !== undefined)) return replayRejected(banked);
    return { kind: "rejected", code: "lock_not_exclusive", message: belowFloorMessage };
  }

  // NUT-7 checkstate as unconditional observability + PENDING-aware fast-fail.
  // Surfacing PENDING separately from SPENT lets the agent CLI retry on
  // transient mint state rather than treat it as a permanent rejection.
  try {
    const walletProvider = opts.walletProvider ?? getWallet;
    const wallet = await walletProvider(mintUrl);
    const states = await wallet.checkProofsStates(proofs);
    // NUT-7 parallel-array invariant: the mint must return exactly one state
    // per submitted proof, in order. A short response would silently skip
    // checks on the trailing proofs — a SPENT proof at index N+ could pass
    // here and persist into the accumulator. Treat as transient (`mint_unreachable`)
    // so the agent retries instead of marking the token permanently rejected.
    if (states.length !== proofs.length) {
      return {
        kind: "rejected",
        code: "mint_unreachable",
        message: `Mint returned ${states.length} proof states for ${proofs.length} proofs (NUT-7 contract violated).`,
      };
    }
    if (states.some((s) => s.state === CheckStateEnum.SPENT)) {
      return {
        kind: "rejected",
        code: "proof_not_unspent",
        message: "One or more proofs are already spent at the mint.",
      };
    }
    if (states.some((s) => s.state === CheckStateEnum.PENDING)) {
      return {
        kind: "rejected",
        code: "proof_pending",
        message: "One or more proofs are pending at the mint — retry shortly.",
      };
    }
    if (states.some((state) => state.state !== CheckStateEnum.UNSPENT)) {
      return { kind: "rejected", code: "mint_unreachable", message: "Mint returned an unknown proof state." };
    }
  } catch (err) {
    return {
      kind: "rejected",
      code: "mint_unreachable",
      message: err instanceof Error ? err.message : "Mint checkstate failed",
    };
  }

  await opts.beforeCommit?.(acceptedValue);

  // Persist. A request id belongs to the first proof set banked under it, so
  // any other proofs under a used request id are refused before the insert;
  // UNIQUE(dvm_id, proof_secret_hash) catches same-proof under a fresh
  // request_id. Each surfaces as AccumulatorReplayError, and nothing is kept.
  //
  // With `withCommitTx`, the insert and the callback share one
  // caller-visible transaction: proofs commit iff the ledger credit commits.
  const insertArgs = {
    dvmId: opts.dvmId,
    lockPubkeyByIndex: matchedLockPubkeyByIndex,
    mintUrl,
    proofs,
    requestId: opts.requestId,
    tExpireMsByIndex,
  };
  try {
    if (opts.disposable) {
      const account = opts.withDisposableLedger;
      if (!account) throw new Error("Disposable Cashu requires atomic credit accounting.");
      await opts.disposable.commit(opts.requestId, proofs, (ledger) => account(ledger, acceptedValue));
    } else if (!opts.db) {
      throw new Error("Cashu accumulator requires a storage backend.");
    } else {
      const client = await opts.db.connect();
      try {
        await client.query("BEGIN");
        // Under a REPEATABLE READ pool default the claim's read would miss a concurrent claim's commit.
        await client.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
        await claimAccumulatorRequestId(client, opts.dvmId, opts.requestId);
        await insertAccumulatorRows(opts.db, { ...insertArgs, tx: client });
        await opts.withCommitTx?.(client, acceptedValue);
        await client.query("COMMIT");
      } catch (err) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // already rolled back or connection dead
        }
        throw err;
      } finally {
        client.release();
      }
    }
  } catch (err) {
    if (err instanceof AccumulatorReplayError) {
      const banked = await acceptedUnder(opts, proofs);
      // None of these proofs is banked, so the collision is the request id
      // alone: another proof set already holds it and nothing was kept.
      if (banked.every((id) => id === undefined)) return requestIdReused();
      return replayRejected(banked);
    }
    throw err;
  }

  return {
    kind: "accumulated",
    paidMsats: valuation.netMsats,
    grossMsats: valuation.grossMsats,
    inputFeeMsats: valuation.inputFeeMsats,
    netMsats: valuation.netMsats,
    mintUrl,
  };
}

async function acceptedUnder(
  opts: AccumulatorReceiveOpts,
  proofs: Proof[]
): Promise<(string | undefined)[]> {
  const secrets = proofs.map((p) => p.secret);
  if (opts.disposable) return await opts.disposable.acceptedRequestIds(secrets);
  if (opts.db) return await acceptedRequestIds(opts.db, opts.dvmId, secrets);
  return secrets.map(() => undefined);
}

function requestIdReused(): AccumulatorReceiveResult {
  return {
    kind: "rejected",
    code: "request_id_reused",
    message: "This request id already carries a different payment at this DVM; these proofs were not accepted.",
  };
}

function replayRejected(accepted: (string | undefined)[]): AccumulatorReceiveResult {
  const [first] = accepted;
  const bound = first !== undefined && accepted.every((id) => id === first);
  return {
    kind: "rejected",
    code: "replay_rejected",
    message: "Proofs or request id already accepted at this DVM.",
    ...(bound && { acceptedRequestId: first }),
  };
}

// Locktime extraction follows NUT-11 validation; absent or unreadable tags return null.
function parseNut11LocktimeMs(secret: string): number | null {
  try {
    const secs = getTagInt(secret, "locktime");
    return typeof secs === "number" ? secs * 1000 : null;
  } catch {
    return null;
  }
}

// The x coordinate of an exactly 66-hex compressed (02/03-prefixed) key;
// undefined for any other spelling, including x-only and padded keys.
function compressedX(raw: string): string | undefined {
  return /^0[23][0-9a-fA-F]{64}$/.test(raw) ? raw.slice(2).toLowerCase() : undefined;
}
