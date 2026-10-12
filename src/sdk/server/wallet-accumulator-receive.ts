import { isTestMintUrl } from "../../lib/mints";
import {
  Amount,
  CheckStateEnum,
  getP2PKExpectedWitnessPubkeys,
  getTagInt,
  type Proof,
  type Wallet,
  verifyDleqIfPresent,
} from "@cashu/cashu-ts";

import { type LockPubkey, toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { verifyCashuToken } from "../../lib/cashu/verify";
import type { CreditLedgerLike } from "./credit-ledger";
import type { DisposableCashuCommit } from "./disposable-cashu-store";
import { getWallet } from "../../lib/cashu/wallet";
import {
  type AccumulatorPool,
  type AccumulatorQuerier,
  AccumulatorReplayError,
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
  | "proof_not_unspent"
  | "proof_pending"
  | "replay_rejected"
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

  // Verify every proof has a NUT-11 P2PK authority matching one of the DVM's
  // active lock pubkeys. `getP2PKExpectedWitnessPubkeys` is
  // time-sensitive: a plain secret throws, while an unlocked or expired lock
  // without a refund path yields no expected witness; all three map to
  // `not_p2pk_locked`. An expired lock with a refund path still yields refund
  // witnesses and follows the same active-key check as a live lock; no
  // current or retired-in-grace DVM key maps to `wrong_lock_pubkey`. The same
  // loop extracts each NUT-11 `locktime` (ms since epoch) for oldest-first
  // ordering and the expiring-soon monitor.
  const tExpireMsByIndex: (number | null)[] = [];
  const matchedLockPubkeyByIndex: LockPubkey[] = [];
  for (const p of proofs) {
    let allowed: string[];
    try {
      allowed = getP2PKExpectedWitnessPubkeys(p.secret);
    } catch {
      return {
        kind: "rejected",
        code: "not_p2pk_locked",
        message: "Proof secret is not a NUT-11 P2PK secret.",
      };
    }
    if (allowed.length === 0) {
      return {
        kind: "rejected",
        code: "not_p2pk_locked",
        message: "Proof is unlocked or the P2PK lock has expired.",
      };
    }
    const allowedNormalised = allowed.map(toLockPubkey);
    if (opts.disposable && (allowedNormalised.length !== 1 || (getTagInt(p.secret, "n_sigs") ?? 1) !== 1)) {
      return { kind: "rejected", code: "not_p2pk_locked", message: "Disposable Cashu requires an exclusive single-signature P2PK lock." };
    }
    const match = accepted.find((pk) => allowedNormalised.includes(pk));
    if (!match) {
      return {
        kind: "rejected",
        code: "wrong_lock_pubkey",
        message: "Proof is not locked to one of this DVM's active lock pubkeys.",
      };
    }
    matchedLockPubkeyByIndex.push(match);
    tExpireMsByIndex.push(parseNut11LocktimeMs(p.secret));
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

  // Persist. UNIQUE(dvm_id, request_id, proof_secret) catches same-call replay;
  // UNIQUE(dvm_id, proof_secret_hash) catches same-proof under a fresh
  // request_id. Either collision surfaces as AccumulatorReplayError.
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
    } else if (opts.withCommitTx) {
      const withCommitTx = opts.withCommitTx;
      const client = await opts.db.connect();
      try {
        await client.query("BEGIN");
        await insertAccumulatorRows(opts.db, { ...insertArgs, tx: client });
        await withCommitTx(client, acceptedValue);
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
    } else {
      await insertAccumulatorRows(opts.db, insertArgs);
    }
  } catch (err) {
    if (err instanceof AccumulatorReplayError) {
      return {
        kind: "rejected",
        code: "replay_rejected",
        message: "Proofs or request id already accepted at this DVM.",
      };
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

// Locktime extraction follows NUT-11 validation; absent or unreadable tags return null.
function parseNut11LocktimeMs(secret: string): number | null {
  try {
    const secs = getTagInt(secret, "locktime");
    return typeof secs === "number" ? secs * 1000 : null;
  } catch {
    return null;
  }
}
