/**
 * Receipt provenance requires a valid signature, an immutable DVM ID matching
 * the builder attestation, a signing key named by that attestation, and a
 * valid builder signature. Job, drain and funding receipts share this chain.
 * A valid receipt with no attested key is verified_unattested, not invalid.
 */

import { type AttestationPayload, verifyAttestation } from "./builder-identity";
import type { JsonValue } from "./cast-auth";
import {
  computeResultHash,
  type DrawFundingReceipt,
  type FundingReceipt,
  isDrainReceipt,
  isDrawFundingReceipt,
  isFundingReceipt,
  type JobReceipt as SignedJobReceipt,
  verifyDrainReceipt,
  verifyDrawFundingReceipt,
  verifyFundingReceipt,
  verifyReceipt,
} from "./receipt";
import type { ReceiptTrustAnchor } from "./receipt-contracts";

/**
 * How much a receipt proves.
 *
 * - `verified` — all four links hold; the DVM's builder identity stands
 * behind this receipt.
 * - `verified_unattested` — the signature is sound but nothing vouches for the
 * signer (dev-mode DVM, or a deploy that couldn't provision a receipt key).
 * - `invalid` — a link that was checkable failed. Never a reason to fail a job
 * the caller already paid for; it is a warning about the *proof*.
 * - `absent` — no receipt was issued (a DVM that predates or the
 * isolate tier, which omits the `/v1/info` `receipts` flag).
 */
export type ReceiptVerification = "verified" | "verified_unattested" | "invalid" | "absent";

export type ReceiptInvalidReason =
  | "job_id_mismatch"
  | "drain_id_mismatch"
  | "draw_id_mismatch"
  | "credit_id_mismatch"
  | "fund_id_mismatch"
  | "funding_amount_mismatch"
  | "funding_balance_mismatch"
  | "funding_ledger_seq_mismatch"
  | "funding_currency_mismatch"
  | "caller_pubkey_mismatch"
  | "signature_invalid"
  | "attestation_invalid"
  | "dvm_identity_mismatch"
  | "receipt_key_mismatch"
  | "result_hash_mismatch";

export type { ReceiptTrustAnchor } from "./receipt-contracts";

/**
 * The pair two hostnames must present identically before caller state may be
 * pooled across them.
 *
 * `dvm_id` alone is not an identity: the attestation carrying it is *self*
 * signed, so anyone can mint a builder key and attest any id. The builder
 * pubkey is what makes the claim cost something — an attacker cannot produce
 * receipts that chain to a key they do not hold.
 */
export interface AttestedDvmIdentity {
  /** Immutable DVM id, as bound into the builder attestation. */
  dvmId: string;
  /** Builder x-only pubkey the attestation verifies under, lowercased. */
  builderPubkey: string;
}

/**
 * For caller-state keying, use only the DVM ID inside an authenticated builder
 * attestation. Absent, unauthenticated or missing-ID blocks establish no identity.
 */
export function attestedDvmIdentity(builder: unknown): AttestedDvmIdentity | undefined {
  const builderPubkey = authenticatedBuilderPubkey(builder);
  if (!builderPubkey) return undefined;
  const dvmId = (builder as ReceiptTrustAnchor).attestation.dvm_id;
  if (typeof dvmId !== "string" || dvmId.length === 0) return undefined;
  return { dvmId, builderPubkey };
}

/**
 * Return the authenticated builder identity from a `/v1/info#builder` block.
 * Undefined means the block is absent, malformed, internally inconsistent, or
 * does not verify under the advertised key.
 */
export function authenticatedBuilderPubkey(builder: unknown): string | undefined {
  if (!isTrustAnchor(builder)) return undefined;
  const pubkey = builder.pubkey.trim().toLowerCase();
  const attestedPubkey = builder.attestation.builder_pubkey;
  if (
    !/^[0-9a-f]{64}$/.test(pubkey) ||
    typeof attestedPubkey !== "string" ||
    attestedPubkey.trim().toLowerCase() !== pubkey
  ) {
    return undefined;
  }
  const payload = builder.attestation as unknown as AttestationPayload;
  return verifyAttestation(payload, builder.signature, pubkey) ? pubkey : undefined;
}

/**
 * What the caller actually received, for the `result_hash` recompute.
 *
 * Only build one when the delivered set is provably complete — a partial
 * message log hashes to something else and would report a sound receipt as
 * `invalid`. See {@link verifyJobReceipt}'s `delivered` contract.
 */
export interface DeliveredResult {
  /** The completed job's summary. Omit on `failed`/`cancelled` (see {@link computeResultHash}). */
  summary?: string;
  /** Each artifact message's `content`, in emission order. */
  artifactContents: JsonValue[];
}

export interface ReceiptChecks {
  /**
   * Does the receipt name the job it was collected for? `unchecked` when the
   * caller didn't say which job it asked about.
   */
  job_id: "ok" | "mismatch" | "unchecked";
  /** BIP-340 signature under the receipt's own `receipt_pubkey`. */
  signature: boolean;
  /** The attestation chain: `absent` when the DVM serves no builder block. */
  attestation: "ok" | "absent" | "invalid" | "identity_mismatch" | "key_mismatch";
  /** `unchecked` when the caller couldn't prove it held the whole delivered result. */
  result_hash: "ok" | "mismatch" | "unchecked";
}

export interface ReceiptVerifyResult {
  status: ReceiptVerification;
  checks: ReceiptChecks;
  /** Machine-readable cause, present only when `status === "invalid"`. */
  reason?: ReceiptInvalidReason;
}

/**
 * Per-link outcome for a drain receipt — the four links it has.
 *
 * A `DrainReceipt` binds no job and hashes no result, so {@link ReceiptChecks}'
 * `job_id` and `result_hash` would be permanently `unchecked` here. Reporting
 * only what a reclaim receipt can actually be checked on keeps "unchecked"
 * meaning "we couldn't check this one" rather than "this kind never checks".
 * In their place it binds the two ids a reclaim is *about* — the drain and the
 * credit it reclaimed — which are what {@link ReceiptChecks.job_id} is to a job
 * receipt.
 */
export interface DrainReceiptChecks {
  /**
   * Does the receipt name the drain it was filed under? `unchecked` when the
   * caller didn't say which drain it asked about.
   */
  drain_id: "ok" | "mismatch" | "unchecked";
  /**
   * Does the receipt name the credit that drain reclaimed? `unchecked` when the
   * caller didn't say which credit it asked about.
   */
  credit_id: "ok" | "mismatch" | "unchecked";
  /** BIP-340 signature under the receipt's own `receipt_pubkey`. */
  signature: boolean;
  /** The attestation chain: `absent` when the DVM serves no builder block. */
  attestation: ReceiptChecks["attestation"];
}

export interface DrainReceiptVerifyResult {
  status: ReceiptVerification;
  checks: DrainReceiptChecks;
  /** Machine-readable cause, present only when `status === "invalid"`. */
  reason?: ReceiptInvalidReason;
}

export interface FundingReceiptChecks {
  credit_id: "ok" | "mismatch" | "unchecked";
  fund_id: "ok" | "mismatch" | "unchecked";
  funded_micro: "ok" | "mismatch" | "unchecked";
  balance_after_micro: "ok" | "mismatch" | "unchecked";
  ledger_seq: "ok" | "mismatch" | "unchecked";
  caller_pubkey: "ok" | "mismatch" | "unchecked";
  signature: boolean;
  attestation: ReceiptChecks["attestation"];
}

export interface FundingReceiptVerifyResult {
  status: ReceiptVerification;
  checks: FundingReceiptChecks;
  reason?: ReceiptInvalidReason;
  receipt?: FundingReceipt;
}

export interface DrawFundingReceiptChecks {
  credit_id: "ok" | "mismatch" | "unchecked";
  job_id: "ok" | "mismatch" | "unchecked";
  draw_id: "ok" | "mismatch" | "unchecked";
  fund_id: "ok" | "mismatch" | "unchecked";
  currency: "ok" | "mismatch" | "unchecked";
  funded_micro: "ok" | "mismatch" | "unchecked";
  ledger_seq: "ok" | "mismatch" | "unchecked";
  caller_pubkey: "ok" | "mismatch" | "unchecked";
  signature: boolean;
  attestation: ReceiptChecks["attestation"];
}

export interface DrawFundingReceiptVerifyResult {
  status: ReceiptVerification;
  checks: DrawFundingReceiptChecks;
  reason?: ReceiptInvalidReason;
  receipt?: DrawFundingReceipt;
}

export interface VerifyJobReceiptArgs {
  receipt: SignedJobReceipt;
  /** `/v1/info#builder` for the endpoint that issued it, when known. */
  builder?: ReceiptTrustAnchor;
  /**
   * The job this receipt is supposed to be proof of. Pass it whenever you know
   * it: a perfectly-signed receipt for a *different* job proves nothing about
   * yours, and binding the two is the whole point of the primitive.
   */
  expectedJobId?: string;
  /**
   * The delivered result, when the caller can prove it holds all of it.
   * Omitting this yields `result_hash: "unchecked"` — the honest answer.
   * Passing a partial set would manufacture a false `result_hash_mismatch`.
   */
  delivered?: DeliveredResult;
}

/** Optional job and delivered-result bindings supplement the signature and builder chain. */
export function verifyJobReceipt(args: VerifyJobReceiptArgs): ReceiptVerifyResult {
  const { receipt, builder, expectedJobId, delivered } = args;

  const checks: ReceiptChecks = {
    job_id: checkJobId(receipt, expectedJobId),
    signature: verifyReceipt(receipt),
    attestation: "absent",
    result_hash: "unchecked",
  };
  // Checked before the signature deliberately: the interesting failure here is
  // a *validly signed* receipt for someone else's job, which every other link
  // would happily wave through.
  if (checks.job_id === "mismatch") {
    return { status: "invalid", checks, reason: "job_id_mismatch" };
  }
  if (!checks.signature) {
    return { status: "invalid", checks, reason: "signature_invalid" };
  }

  checks.attestation = checkReceiptAttestation(receipt, builder);
  if (checks.attestation === "invalid") {
    return { status: "invalid", checks, reason: "attestation_invalid" };
  }
  if (checks.attestation === "identity_mismatch") {
    return { status: "invalid", checks, reason: "dvm_identity_mismatch" };
  }
  if (checks.attestation === "key_mismatch") {
    return { status: "invalid", checks, reason: "receipt_key_mismatch" };
  }

  checks.result_hash = checkResultHash(receipt, delivered);
  if (checks.result_hash === "mismatch") {
    return { status: "invalid", checks, reason: "result_hash_mismatch" };
  }

  return {
    status: checks.attestation === "ok" ? "verified" : "verified_unattested",
    checks,
  };
}

/**
 * Links 2–4 on their own: does the immutable DVM ID and signing key match the
 * builder attestation, and does that attestation hold?
 *
 * Takes the pubkey rather than a receipt so it serves both kinds — a
 * {@link SignedJobReceipt} and a `DrainReceipt` are signed by the same
 * `ReceiptIssuer` under the same key, so one attestation chain covers both.
 * {@link verifyJobReceipt} is the full walk for job receipts; reach for this
 * directly only when link 1 is checked separately.
 *
 * `absent` covers both shapes of "nothing to chain to": no builder block at all
 * (a dev boot's ephemeral key, or a hand-set `DVMKIT_RECEIPT_KEY`), and an
 * attested deploy whose path couldn't provision a receipt key, so it honestly
 * left `receipt_pubkey` off the payload. Neither is a failure — attesting a key
 * the running process doesn't hold would be strictly worse.
 */
export function checkReceiptAttestation(
  receipt: { dvm_id: string; receipt_pubkey: string },
  builder: ReceiptTrustAnchor | undefined
): ReceiptChecks["attestation"] {
  if (!isTrustAnchor(builder)) return "absent";

  const payload = builder.attestation as unknown as AttestationPayload;
  if (!authenticatedBuilderPubkey(builder)) return "invalid";
  if (typeof payload.dvm_id !== "string" || payload.dvm_id !== receipt.dvm_id) {
    return "identity_mismatch";
  }

  const attested = builder.attestation.receipt_pubkey;
  if (typeof attested !== "string" || attested.length === 0) return "absent";
  return attested.toLowerCase() === receipt.receipt_pubkey.toLowerCase() ? "ok" : "key_mismatch";
}

/**
 * Walk the trust chain for one **drain** receipt — `dvm credit drain`'s
 * counterpart to {@link verifyJobReceipt}, in the same verdict vocabulary.
 *
 * Takes `unknown` because both of this receipt's homes are typed `unknown[]`:
 * the wire's `DrainWire.receipts` and the local credit store. A body that isn't
 * structurally a drain receipt is `invalid` rather than thrown — the DVM put it
 * in the receipts array, so the caller is owed a verdict about it.
 *
 * A drain receipt is the caller's evidence of a refund the DVM has **not yet
 * paid**, which is exactly where link 1 alone is not enough: a DVM that can
 * disown the signing key can disown the IOU. `verified_unattested` is still not
 * a failure — the money is owed either way.
 */
export function verifyDrainReceiptChain(args: {
  receipt: unknown;
  /** `/v1/info#builder` for the endpoint that issued it, when known. */
  builder?: ReceiptTrustAnchor;
  /**
   * The drain this receipt is supposed to be evidence of. Pass it whenever you
   * know it: a perfectly-signed receipt for a *different* reclaim proves
   * nothing about this one, and it is the store's unsigned `drainId` label —
   * hand-editable — that says which reclaim a stored bundle belongs to.
   */
  expectedDrainId?: string;
  /** The credit that drain reclaimed, on the same terms as `expectedDrainId`. */
  expectedCreditId?: string;
}): DrainReceiptVerifyResult {
  const { receipt, builder, expectedDrainId, expectedCreditId } = args;
  const named = isDrainReceipt(receipt) ? receipt : undefined;
  const checks: DrainReceiptChecks = {
    drain_id: checkDrainField(named?.drain_id, expectedDrainId),
    credit_id: checkDrainField(named?.credit_id, expectedCreditId),
    signature: named !== undefined && verifyDrainReceipt(named),
    attestation: "absent",
  };
  // Checked before the signature, as {@link verifyJobReceipt} checks `job_id`
  // and for the same reason: the interesting failure is a *validly signed*
  // receipt filed under someone else's drain or credit, which every remaining
  // link would happily wave through.
  if (checks.drain_id === "mismatch") {
    return { status: "invalid", checks, reason: "drain_id_mismatch" };
  }
  if (checks.credit_id === "mismatch") {
    return { status: "invalid", checks, reason: "credit_id_mismatch" };
  }
  if (named === undefined || !checks.signature) {
    return { status: "invalid", checks, reason: "signature_invalid" };
  }

  checks.attestation = checkReceiptAttestation(named, builder);
  if (checks.attestation === "invalid") {
    return { status: "invalid", checks, reason: "attestation_invalid" };
  }
  if (checks.attestation === "identity_mismatch") {
    return { status: "invalid", checks, reason: "dvm_identity_mismatch" };
  }
  if (checks.attestation === "key_mismatch") {
    return { status: "invalid", checks, reason: "receipt_key_mismatch" };
  }

  return {
    status: checks.attestation === "ok" ? "verified" : "verified_unattested",
    checks,
  };
}

export function verifyFundingReceiptChain(args: {
  receipt: unknown;
  builder?: ReceiptTrustAnchor;
  expectedCreditId?: string;
  expectedFundId?: string;
  expectedFundedMicro?: number;
  expectedBalanceAfterMicro?: number;
  expectedLedgerSeq?: number;
  expectedCallerPubkey?: string;
}): FundingReceiptVerifyResult {
  const named = isFundingReceipt(args.receipt) ? args.receipt : undefined;
  const check = <T>(actual: T | undefined, expected: T | undefined) =>
    expected === undefined ? "unchecked" : actual === expected ? "ok" : "mismatch";
  const checks: FundingReceiptChecks = {
    credit_id: check(named?.credit_id, args.expectedCreditId),
    fund_id: check(named?.fund_id, args.expectedFundId),
    funded_micro: check(named?.funded_micro, args.expectedFundedMicro),
    balance_after_micro: check(named?.balance_after_micro, args.expectedBalanceAfterMicro),
    ledger_seq: check(named?.ledger_seq, args.expectedLedgerSeq),
    caller_pubkey: check(named?.caller_pubkey, args.expectedCallerPubkey),
    signature: named !== undefined && verifyFundingReceipt(named),
    attestation: "absent",
  };
  const mismatch: [keyof FundingReceiptChecks, ReceiptInvalidReason][] = [
    ["credit_id", "credit_id_mismatch"],
    ["fund_id", "fund_id_mismatch"],
    ["funded_micro", "funding_amount_mismatch"],
    ["balance_after_micro", "funding_balance_mismatch"],
    ["ledger_seq", "funding_ledger_seq_mismatch"],
    ["caller_pubkey", "caller_pubkey_mismatch"],
  ];
  for (const [field, reason] of mismatch) {
    if (checks[field] === "mismatch") return { status: "invalid", checks, reason, receipt: named };
  }
  if (!named || !checks.signature) {
    return { status: "invalid", checks, reason: "signature_invalid", receipt: named };
  }
  checks.attestation = checkReceiptAttestation(named, args.builder);
  if (checks.attestation === "invalid") {
    return { status: "invalid", checks, reason: "attestation_invalid", receipt: named };
  }
  if (checks.attestation === "identity_mismatch") {
    return { status: "invalid", checks, reason: "dvm_identity_mismatch", receipt: named };
  }
  if (checks.attestation === "key_mismatch") {
    return { status: "invalid", checks, reason: "receipt_key_mismatch", receipt: named };
  }
  return {
    status: checks.attestation === "ok" ? "verified" : "verified_unattested",
    checks,
    receipt: named,
  };
}

/**
 * Walk the trust chain for one mid-job **draw funding** receipt, in the same
 * verdict vocabulary as {@link verifyFundingReceiptChain}. Bindings are checked
 * before the signature for the reason the drain walk gives: the dangerous
 * artifact is a validly signed one filed against someone else's credit, job,
 * draw or payment, which every later link would wave through. A funding fact
 * that cannot be bound exactly must never raise an expected balance.
 */
export function verifyDrawFundingReceiptChain(args: {
  receipt: unknown;
  builder?: ReceiptTrustAnchor;
  expectedCreditId?: string;
  expectedJobId?: string;
  expectedDrawId?: string;
  expectedFundId?: string;
  expectedCurrency?: string;
  expectedFundedMicro?: number;
  expectedLedgerSeq?: number;
  expectedCallerPubkey?: string;
}): DrawFundingReceiptVerifyResult {
  const named = isDrawFundingReceipt(args.receipt) ? args.receipt : undefined;
  const check = <T>(actual: T | undefined, expected: T | undefined) =>
    expected === undefined ? "unchecked" : actual === expected ? "ok" : "mismatch";
  const checks: DrawFundingReceiptChecks = {
    credit_id: check(named?.credit_id, args.expectedCreditId),
    job_id: check(named?.job_id, args.expectedJobId),
    draw_id: check(named?.draw_id, args.expectedDrawId),
    fund_id: check(named?.fund_id, args.expectedFundId),
    currency: check(named?.currency, args.expectedCurrency),
    funded_micro: check(named?.funded_micro, args.expectedFundedMicro),
    ledger_seq: check(named?.ledger_seq, args.expectedLedgerSeq),
    caller_pubkey: check(named?.caller_pubkey, args.expectedCallerPubkey),
    signature: named !== undefined && verifyDrawFundingReceipt(named),
    attestation: "absent",
  };
  const mismatch: [keyof DrawFundingReceiptChecks, ReceiptInvalidReason][] = [
    ["credit_id", "credit_id_mismatch"],
    ["job_id", "job_id_mismatch"],
    ["draw_id", "draw_id_mismatch"],
    ["fund_id", "fund_id_mismatch"],
    ["currency", "funding_currency_mismatch"],
    ["funded_micro", "funding_amount_mismatch"],
    ["ledger_seq", "funding_ledger_seq_mismatch"],
    ["caller_pubkey", "caller_pubkey_mismatch"],
  ];
  for (const [field, reason] of mismatch) {
    if (checks[field] === "mismatch") return { status: "invalid", checks, reason, receipt: named };
  }
  if (!named || !checks.signature) {
    return { status: "invalid", checks, reason: "signature_invalid", receipt: named };
  }
  checks.attestation = checkReceiptAttestation(named, args.builder);
  if (checks.attestation === "invalid") {
    return { status: "invalid", checks, reason: "attestation_invalid", receipt: named };
  }
  if (checks.attestation === "identity_mismatch") {
    return { status: "invalid", checks, reason: "dvm_identity_mismatch", receipt: named };
  }
  if (checks.attestation === "key_mismatch") {
    return { status: "invalid", checks, reason: "receipt_key_mismatch", receipt: named };
  }
  return {
    status: checks.attestation === "ok" ? "verified" : "verified_unattested",
    checks,
    receipt: named,
  };
}

/**
 * Fold a set of verdicts into the one verdict the set collectively earns —
 * what a bundle of receipts, taken together, proves.
 *
 * The weakest link wins, because a caller relying on the bundle relies on all
 * of it. An empty set is `absent`: nothing was issued, which is not the same as
 * something that failed.
 */
export function weakestReceiptVerdict(statuses: ReceiptVerification[]): ReceiptVerification {
  if (statuses.length === 0) return "absent";
  if (statuses.includes("invalid")) return "invalid";
  if (statuses.includes("absent")) return "absent";
  if (statuses.includes("verified_unattested")) return "verified_unattested";
  return "verified";
}

function checkJobId(
  receipt: SignedJobReceipt,
  expectedJobId: string | undefined
): ReceiptChecks["job_id"] {
  if (expectedJobId === undefined) return "unchecked";
  return receipt.job_id === expectedJobId ? "ok" : "mismatch";
}

/**
 * Link 0 for a drain receipt — does it name the drain (or credit) it is filed
 * under? `actual` is undefined for a body that isn't structurally a receipt at
 * all, which is `unchecked` rather than `mismatch`: the signature link below is
 * the honest verdict on junk.
 */
function checkDrainField(
  actual: string | undefined,
  expected: string | undefined
): DrainReceiptChecks["drain_id"] {
  if (expected === undefined || actual === undefined) return "unchecked";
  return actual === expected ? "ok" : "mismatch";
}

/**
 * Does the receipt attest the result the caller actually got? Only answerable
 * when the caller supplied a delivered set it could prove complete; anything
 * else stays `unchecked`.
 */
function checkResultHash(
  receipt: SignedJobReceipt,
  delivered: DeliveredResult | undefined
): ReceiptChecks["result_hash"] {
  if (!delivered) return "unchecked";
  // A `null` result_hash means the DVM delivered nothing to bind. There is no
  // hash to compare against, so there is nothing to check either way.
  if (receipt.result_hash === null) return "unchecked";
  // The summary counts only on `completed` — on a failed/cancelled job the SDK
  // writes the terminal *reason* into the summary column, which the caller
  // never received. `computeResultHash` documents the same rule.
  const summary = receipt.outcome === "completed" ? delivered.summary : undefined;
  let recomputed: string;
  try {
    recomputed = computeResultHash(summary, delivered.artifactContents);
  } catch {
    // Non-canonicalisable artifact content (non-finite numbers, undefined) —
    // we can't reproduce the DVM's input, so we can't call it a mismatch.
    return "unchecked";
  }
  return recomputed === receipt.result_hash ? "ok" : "mismatch";
}

/**
 * Structural guard on a trust anchor. Typed `unknown` on purpose: an anchor
 * reaches here either off the wire or out of a hand-editable JSONL file, so
 * "the type says it's a string" is not evidence that it is one.
 */
function isTrustAnchor(value: unknown): value is ReceiptTrustAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const anchor = value as Record<string, unknown>;
  return (
    typeof anchor.pubkey === "string" &&
    typeof anchor.signature === "string" &&
    !!anchor.attestation &&
    typeof anchor.attestation === "object" &&
    !Array.isArray(anchor.attestation)
  );
}
