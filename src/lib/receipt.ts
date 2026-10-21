import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

import { canonicaliseForSigning, type JsonValue } from "./cast-auth";

export type ReceiptOutcome = "completed" | "failed" | "cancelled";

export interface ReceiptPayment {
  /** Total credited millisats. `0` on free jobs — they still get receipts. */
  msats: number;
  /**
   * Rail of the most recent successful credit; `null` when nothing was paid.
   * `lightning` appears on a draw against a credit the caller funded by
   * invoice — it is a funding rail, never an attached-proof one.
   */
  rail: "cashu" | "x402" | "tempo" | "lightning" | null;
  /** Rail-native upfront amount (sats / USDC microunits), `null` when absent. */
  native_amount: number | null;
  native_asset: string | null;
  /** Settlement reference: EVM tx hash (x402), mppx challenge id, or the Cashu request id. */
  tx_hash: string | null;
  /** Cashu mint the proofs were drawn on, `null` off the Cashu rail. */
  mint: string | null;
}

/**
 * Credit-draw countersignature block. Present on every job whose payment funded
 * or drew the credit
 * ledger — including implicit N=1 per-job payments, which fund and draw a
 * single-use credit in the same request. A caller holding a DVM-signed
 * balance trajectory plus its own caller-signed draw intents can prove
 * misbehaviour from artifacts both sides already possess; that only works
 * because the countersignature rides the receipt.
 *
 * Absence is signature-compatible: `canonicalize` omits absent keys, so a
 * ledger-less (or free) job's receipt signs identically to a legacy
 * receipt.
 */
export interface ReceiptCredit {
  credit_id: string;
  /** This draw's identifier — matches the caller-signed draw intent. */
  draw_id: string;
  /** Amount drawn, in the credit's denomination. */
  amount: number;
  balance_after: number;
  /** Per-credit monotonic draw counter. */
  ledger_seq: number;
}

/**
 * A DVM-signed proof of what a job did and what it cost.
 *
 * Signed once at the terminal transition by the per-DVM receipt key, whose
 * authority chains to the builder identity key through the deploy-time
 * attestation (`/v1/info#builder`, `attestation.receipt_pubkey`). Served
 * identically on the synchronous `POST /v1/job` 200, on `GET /v1/job/:id`,
 * and on every later re-read — the bytes are persisted, not recomputed.
 */
export interface JobReceipt {
  v: 1;
  job_id: string;
  /** Immutable DVM identity bound into the builder attestation. */
  dvm_id: string;
  /** DVM slug, as bound in the builder attestation. */
  dvm: string;
  capability: string;
  outcome: ReceiptOutcome;
  /** Signed Unix millisecond lifecycle times; absent on legacy receipts. */
  timing?: { accepted_at_ms: number; terminal_at_ms: number; caller_wait_ms: number };
  /** SDK-derived attribution on failure/cancellation; absent on completion and legacy receipts. */
  ended_by?: "caller" | "provider";
  /** Terminal reason on `failed`/`cancelled` (e.g. `worker_died_mid_job`); `null` on success. */
  reason: string | null;
  /** Per-DVM monotonic terminal counter. Gaps expose receipt suppression. */
  seq: number;
  /** Unix seconds at which the receipt was signed. */
  issued_at: number;
  /** Caller's x-only pubkey when signed-request auth was used; `null` otherwise. */
  requester_pubkey: string | null;
  paid: ReceiptPayment;
  /**
   * {@link computeResultHash} over the delivered result; `null` when nothing
   * was delivered. The summary is part of the hash only on `completed` — see
   * {@link computeResultHash}.
   */
  result_hash: string | null;
  /** x-only secp256k1 pubkey that signed this receipt (64 hex chars). */
  receipt_pubkey: string;
  /** BIP-340 Schnorr signature over the canonical receipt minus `signature` (128 hex chars). */
  signature: string;
  /**
   * Credit-draw countersignature — present when the job's payment
   * funded/drew the credit ledger. See {@link ReceiptCredit}. `balance_after`
   * reflects the terminal resolution: the recorded draw trajectory on a
   * settled (completed) job, the restored available balance on a released
   * (failed/cancelled) one.
   */
  credit?: ReceiptCredit;
}

export type UnsignedJobReceipt = Omit<JobReceipt, "signature">;

export type DrainReceiptEvent = "requested" | "parked" | "picked_up" | "sent" | "released";

/**
 * A DVM-signed proof of one reclaim event. One receipt per
 * lifecycle transition — `requested` (the balance debited into the drain
 * liability), `parked` (Cashu notes locked to the caller's refund key,
 * parked for pickup), `picked_up` (the caller collected them), `sent` (a
 * Lightning/x402/mpp send-back settled).
 *
 * The evidence pairing: the caller holds the drain *request* it signed (the
 * `/v1/credit` envelope), the DVM countersigns each state the drain reaches.
 * A `requested` receipt with no later `parked`/`sent` is a signed IOU whose
 * refusal is provable from artifacts both sides already hold — reclaim is
 * enforced by reputation with cryptographic evidence, not new crypto.
 *
 * Signed by the same per-DVM receipt key as {@link JobReceipt}, over the
 * same canonicalisation, so one attestation chain covers both.
 */
export interface DrainReceipt {
  v: 1;
  /** Discriminator separating this from a `JobReceipt` in mixed stores. */
  kind: "credit_drain";
  credit_id: string;
  /** This drain's identifier — matches the caller-signed drain request. */
  drain_id: string;
  event: DrainReceiptEvent;
  /** Payout rail: `cashu` | `x402` | `tempo`. */
  method: string;
  /** Amount reclaimed, micro-units of the credit's currency. */
  amount_micro: number;
  /**
   * Credit balance left after the drain debit, in micro-units. It includes
   * pending job holds at request time and is fixed across this drain's event receipts.
   */
  balance_after_micro: number;
  /** Per-credit monotonic sequence the drain consumed, shared with draws. */
  ledger_seq: number;
  /** Unix seconds at which this receipt was signed. */
  issued_at: number;
  /** The credit owner's x-only pubkey — who the money is owed to. */
  caller_pubkey: string;
  /** Immutable DVM identity bound into the builder attestation. */
  dvm_id: string;
  /** DVM slug, as bound in the builder attestation. */
  dvm: string;
  /** x-only secp256k1 pubkey that signed this receipt (64 hex chars). */
  receipt_pubkey: string;
  /** BIP-340 Schnorr signature over the canonical receipt minus `signature`. */
  signature: string;
}

export type UnsignedDrainReceipt = Omit<DrainReceipt, "signature">;

/**
 * A DVM-signed proof that one payment funded a prepaid credit.
 * The balance and sequence are the values fixed when the funding committed;
 * retries return this original artifact even when the credit moved later.
 */
export interface FundingReceipt {
  v: 1;
  /** Discriminator separating funding evidence from job and drain receipts. */
  kind: "credit_funding";
  credit_id: string;
  /** Caller fund id, or the attached rail payment id for fund-and-draw. */
  fund_id: string;
  /** Amount credited, in micro-units of the credit currency. */
  funded_micro: number;
  /** Available balance immediately after this funding operation committed. */
  balance_after_micro: number;
  /** Per-credit high-water sequence at that same point. */
  ledger_seq: number;
  /** Unix seconds at which the funding artifact was first issued. */
  issued_at: number;
  /** The credit owner's x-only request-signing pubkey. */
  caller_pubkey: string;
  /** Immutable DVM identity bound into the builder attestation. */
  dvm_id: string;
  /** DVM slug, as bound in the builder attestation. */
  dvm: string;
  receipt_pubkey: string;
  /** BIP-340 Schnorr signature over the canonical receipt minus `signature`. */
  signature: string;
}

export type UnsignedFundingReceipt = Omit<FundingReceipt, "signature">;

/**
 * A DVM-signed proof that one rail payment accepted **during a running job**
 * funded the job's credit while its draw was still pending. Distinct from
 * {@link FundingReceipt}: that artifact describes an opening or top-up funding
 * at a committed ledger position, whereas this one binds the funding to the
 * job, the draw it grew and the payment that carried it, so a caller can prove
 * which accepted mid-job money belongs to a completed draw and reconcile the
 * terminal `balance_after` without guessing.
 *
 * `funded_micro` is the provider's native credited amount after its own FX
 * and fee logic — never the caller's request figure. `ledger_seq` is the
 * **draw's** sequence (growth allocates none), which is what the terminal
 * `ReceiptCredit.ledger_seq` names, so a consumer can line the two up exactly.
 * The tuple is fixed inside the rail's commit transaction; retries and later
 * job reads return the same artifact.
 */
export interface DrawFundingReceipt {
  v: 1;
  /** Discriminator separating mid-job draw funding from opening funding evidence. */
  kind: "credit_draw_funding";
  credit_id: string;
  /** The job whose pending draw this funding belongs to. */
  job_id: string;
  /** The draw the funding was accepted against. */
  draw_id: string;
  /** The rail payment id the funding committed under (tx hash, challenge id, request id). */
  fund_id: string;
  /** Sequence of the accepted `payment` message, when the job store numbers inbound messages. */
  payment_seq?: number;
  /** Currency the credit is denominated in; `funded_micro` is 1e-6 of it. */
  currency: string;
  /** Amount credited to the credit by this payment, in micro-units of `currency`. */
  funded_micro: number;
  /** Available balance immediately after this funding and any draw growth committed. */
  balance_after_micro: number;
  /** The draw's per-credit ledger sequence; growth keeps the placement value. */
  ledger_seq: number;
  /** Unix seconds at which the artifact was first issued. */
  issued_at: number;
  /** The credit owner's x-only request-signing pubkey. */
  caller_pubkey: string;
  /** Immutable DVM identity bound into the builder attestation. */
  dvm_id: string;
  /** DVM slug, as bound in the builder attestation. */
  dvm: string;
  receipt_pubkey: string;
  /** BIP-340 Schnorr signature over the canonical receipt minus `signature`. */
  signature: string;
}

export type UnsignedDrawFundingReceipt = Omit<DrawFundingReceipt, "signature">;

/**
 * Hash the delivered result so a receipt binds to *what* was returned, not
 * just that something was.
 *
 * `sha256(canonicalize({ summary, artifact_hashes }))`, where each artifact
 * hash is `sha256(canonicalize(artifactContent))` in emission order (`[]`
 * when the job emitted none). Hashing the artifact *content object* rather
 * than trusting `content.sha256` — which is optional and which `ctx.artifact`
 * never fills in — keeps the hash recomputable by any consumer from exactly
 * the messages it received.
 *
 * **Pass `summary` only for a `completed` job.** On `failed`/`cancelled` the
 * SDK's durable terminal writes the terminal *reason* into the job's summary
 * column, so a verifier recomputing a non-completed receipt must pass
 * `undefined` here and read the reason off `receipt.reason` instead. The
 * issuer does the same (`resultHashFor` in `sdk/server/receipt-issuer.ts`).
 */
export function computeResultHash(
  summary: string | undefined,
  artifactContents: JsonValue[]
): string {
  const artifactHashes = artifactContents.map((content) =>
    bytesToHex(sha256(canonicaliseForSigning(content)))
  );
  return bytesToHex(
    sha256(
      canonicaliseForSigning({
        summary: summary ?? null,
        artifact_hashes: artifactHashes,
      })
    )
  );
}

export function signReceipt(unsigned: UnsignedJobReceipt, secretHex: string): JobReceipt {
  const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
  const signature = bytesToHex(schnorr.sign(bytes, hexToBytes(secretHex)));
  return { ...unsigned, signature };
}

/**
 * Verify a receipt's self-consistency: the BIP-340 signature over the
 * canonical payload (minus `signature`) under the receipt's own
 * `receipt_pubkey`. Returns `false` rather than throwing on malformed input.
 *
 * This is only the inner link. A consumer that wants provenance must also
 * check `receipt_pubkey` against `/v1/info#builder`'s attested
 * `receipt_pubkey` and verify that attestation under the builder pubkey
 * (`verifyAttestation` in `builder-identity.ts`).
 */
export function verifyReceipt(receipt: JobReceipt): boolean {
  try {
    const { signature, ...unsigned } = receipt;
    const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
    return schnorr.verify(hexToBytes(signature), bytes, hexToBytes(receipt.receipt_pubkey));
  } catch {
    return false;
  }
}

/**
 * Structural guard on a receipt that arrived from outside this process — off a
 * `/v1/job` response, or back out of the hand-editable `~/.dvm/receipts.jsonl`.
 *
 * Checks only that the load-bearing fields are the right *kind* of thing; it
 * deliberately does not judge the receipt. A well-formed receipt whose
 * signature doesn't hold is `invalid` and the caller must see it said so. A
 * body missing one of these fields is a different animal: consumers dereference
 * them unconditionally (`receiptDisplay`'s `paid.msats`, the attestation link's
 * `receipt_pubkey`), so an unguarded one throws `TypeError` and surfaces as an
 * `internal` exit — and it could never have verified anyway, since the
 * signature covers the whole canonical body. Refusing it costs no proof.
 *
 * One guard for both directions on purpose: what can't come in over the wire
 * must not be able to come back out of the file.
 *
 * Release coupling: adding or requiring a field here changes both the SDK's
 * emitted wire shape and the caller CLI's accepted shape. Name the first-party
 * fleet redeploy as a prerequisite in the release note before publishing the
 * stricter caller; see `public compatibility guide`.
 */
export function isSignedJobReceipt(value: unknown): value is JobReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const paid = r.paid;
  return (
    r.v === 1 &&
    typeof r.job_id === "string" &&
    typeof r.dvm_id === "string" &&
    typeof r.dvm === "string" &&
    typeof r.capability === "string" &&
    (r.outcome === "completed" || r.outcome === "failed" || r.outcome === "cancelled") &&
    typeof r.seq === "number" &&
    typeof r.issued_at === "number" &&
    typeof r.receipt_pubkey === "string" &&
    typeof r.signature === "string" &&
    !!paid &&
    typeof paid === "object" &&
    !Array.isArray(paid) &&
    typeof (paid as Record<string, unknown>).msats === "number"
  );
}

/** Sign an unsigned drain receipt — same canonicalisation as {@link signReceipt}. */
export function signDrainReceipt(unsigned: UnsignedDrainReceipt, secretHex: string): DrainReceipt {
  const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
  const signature = bytesToHex(schnorr.sign(bytes, hexToBytes(secretHex)));
  return { ...unsigned, signature };
}

/** Sign an unsigned funding receipt using the common receipt canonicalisation. */
export function signFundingReceipt(
  unsigned: UnsignedFundingReceipt,
  secretHex: string
): FundingReceipt {
  const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
  const signature = bytesToHex(schnorr.sign(bytes, hexToBytes(secretHex)));
  return { ...unsigned, signature };
}

export function isFundingReceipt(value: unknown): value is FundingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    r.kind === "credit_funding" &&
    typeof r.credit_id === "string" &&
    typeof r.fund_id === "string" &&
    typeof r.funded_micro === "number" &&
    typeof r.balance_after_micro === "number" &&
    typeof r.ledger_seq === "number" &&
    typeof r.issued_at === "number" &&
    typeof r.caller_pubkey === "string" &&
    typeof r.dvm_id === "string" &&
    typeof r.dvm === "string" &&
    typeof r.receipt_pubkey === "string" &&
    typeof r.signature === "string"
  );
}

export function verifyFundingReceipt(receipt: FundingReceipt): boolean {
  try {
    const { signature, ...unsigned } = receipt;
    const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
    return schnorr.verify(hexToBytes(signature), bytes, hexToBytes(receipt.receipt_pubkey));
  } catch {
    return false;
  }
}

/** Sign an unsigned draw funding receipt using the common receipt canonicalisation. */
export function signDrawFundingReceipt(
  unsigned: UnsignedDrawFundingReceipt,
  secretHex: string
): DrawFundingReceipt {
  const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
  const signature = bytesToHex(schnorr.sign(bytes, hexToBytes(secretHex)));
  return { ...unsigned, signature };
}

/**
 * Structural guard on a draw funding receipt from outside this process — off a
 * mid-job payment response, a job read, or back out of `~/.dvm/credits.json`.
 * Same contract as {@link isFundingReceipt}: the signature covers the whole
 * canonical body, so refusing a body missing a load-bearing field costs no proof.
 */
export function isDrawFundingReceipt(value: unknown): value is DrawFundingReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    r.kind === "credit_draw_funding" &&
    typeof r.credit_id === "string" &&
    typeof r.job_id === "string" &&
    typeof r.draw_id === "string" &&
    typeof r.fund_id === "string" &&
    (r.payment_seq === undefined || typeof r.payment_seq === "number") &&
    typeof r.currency === "string" &&
    typeof r.funded_micro === "number" &&
    typeof r.balance_after_micro === "number" &&
    typeof r.ledger_seq === "number" &&
    typeof r.issued_at === "number" &&
    typeof r.caller_pubkey === "string" &&
    typeof r.dvm_id === "string" &&
    typeof r.dvm === "string" &&
    typeof r.receipt_pubkey === "string" &&
    typeof r.signature === "string"
  );
}

export function verifyDrawFundingReceipt(receipt: DrawFundingReceipt): boolean {
  try {
    const { signature, ...unsigned } = receipt;
    const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
    return schnorr.verify(hexToBytes(signature), bytes, hexToBytes(receipt.receipt_pubkey));
  } catch {
    return false;
  }
}

/**
 * Structural guard on a drain receipt from outside this process — off a
 * `/v1/credit` drain response, or back out of `~/.dvm/credits.json`.
 *
 * Same contract and same reasoning as {@link isSignedJobReceipt}: both homes
 * type these `unknown[]` because neither the wire nor a hand-editable file is
 * evidence of shape, and the chain walk dereferences `receipt_pubkey`
 * unconditionally. A body missing one of these fields could never have carried
 * a valid signature anyway, so refusing it costs no proof.
 * Required-field changes follow the fleet-before-caller release note linked
 * from {@link isSignedJobReceipt}.
 */
export function isDrainReceipt(value: unknown): value is DrainReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    r.kind === "credit_drain" &&
    typeof r.credit_id === "string" &&
    typeof r.drain_id === "string" &&
    (r.event === "requested" ||
      r.event === "parked" ||
      r.event === "picked_up" ||
      r.event === "sent" ||
      r.event === "released") &&
    typeof r.method === "string" &&
    typeof r.amount_micro === "number" &&
    typeof r.issued_at === "number" &&
    typeof r.caller_pubkey === "string" &&
    typeof r.dvm_id === "string" &&
    typeof r.dvm === "string" &&
    typeof r.receipt_pubkey === "string" &&
    typeof r.signature === "string"
  );
}

/**
 * Verify a drain receipt's self-consistency, mirroring {@link verifyReceipt}
 * the same provenance caveat applies: check `receipt_pubkey` against the
 * DVM's attested `receipt_pubkey` for the outer link.
 */
export function verifyDrainReceipt(receipt: DrainReceipt): boolean {
  try {
    const { signature, ...unsigned } = receipt;
    const bytes = canonicaliseForSigning(unsigned as unknown as JsonValue);
    return schnorr.verify(hexToBytes(signature), bytes, hexToBytes(receipt.receipt_pubkey));
  } catch {
    return false;
  }
}
