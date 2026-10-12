/**
 * Append-only receipt collection, separate from the rewrite-in-place job working
 * set. Each exported line carries its collection-time endpoint and trust anchor
 * so it can be checked offline after the job record is gone.
 * Malformed lines are skipped on reads. Writes may throw; capture callers log
 * storage failures without failing the paid job.
 */

import { appendFileSync, existsSync, readFileSync } from "fs";

import { RECEIPTS_FILE } from "../defaults";
import { ensureConfigDir } from "./config-dir";
import {
  type FundingReceipt,
  isFundingReceipt,
  isSignedJobReceipt,
  type JobReceipt as SignedJobReceipt,
} from "./receipt";
import type { ReceiptTrustAnchor, ReceiptVerification } from "./receipt-verify";

/**
 * One collected receipt, with everything needed to re-verify it offline.
 * Snake_case: these lines are the export format, not an internal shape.
 */
export interface StoredReceipt {
  /** The DVM-signed receipt, verbatim — never re-serialised from parts. */
  receipt: SignedJobReceipt;
  endpoint: string;
  /**
   * `/v1/info#builder` as that endpoint served it at collection time. Stored
   * per-receipt rather than per-DVM on purpose: it is what makes the exported
   * bundle self-verifying, and it pins the anchor that was live when the
   * receipt was issued rather than whatever the DVM advertises today.
   */
  builder?: ReceiptTrustAnchor;
  /** Verdict at collection time. Re-derived, not trusted, on every later read. */
  verification: ReceiptVerification;
  /** Epoch ms at which this receipt was collected and first verified. */
  verified_at: number;
}

export interface StoredFundingReceipt {
  receipt: FundingReceipt;
  endpoint: string;
  builder?: ReceiptTrustAnchor;
  verification: ReceiptVerification;
  verified_at: number;
}

/**
 * Append a receipt to the collection. No-op when a receipt for the same
 * `job_id` is already stored — a job's receipt is issued once and its bytes
 * are stable, so the second sighting (a `dvm status` re-read, a replayed
 * submit) carries nothing new.
 *
 * Deduped on `job_id`, never on the signature: BIP-340 mixes auxiliary
 * randomness, so signing the same payload twice yields different bytes. What
 * makes a receipt's bytes stable is the SDK persisting them write-once, not
 * the signer being deterministic.
 */
export function appendReceipt(entry: StoredReceipt): void {
  if (loadReceipt(entry.receipt.job_id)) return;
  ensureConfigDir();
  appendFileSync(RECEIPTS_FILE, JSON.stringify(entry) + "\n");
}

/** Append one funding artifact, deduped by its `(credit_id, fund_id)` identity. */
export function appendFundingReceipt(entry: StoredFundingReceipt): void {
  if (
    loadFundingReceipts().some(
      (held) =>
        held.receipt.credit_id === entry.receipt.credit_id &&
        held.receipt.fund_id === entry.receipt.fund_id
    )
  ) {
    return;
  }
  ensureConfigDir();
  appendFileSync(RECEIPTS_FILE, JSON.stringify(entry) + "\n");
}

/** Load every stored funding artifact, oldest first. */
export function loadFundingReceipts(): StoredFundingReceipt[] {
  if (!existsSync(RECEIPTS_FILE)) return [];
  try {
    return readFileSync(RECEIPTS_FILE, "utf-8")
      .split("\n")
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const parsed: unknown = JSON.parse(line);
          return isStoredFundingReceipt(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Load every stored receipt, oldest first. Returns [] when the file is absent. */
export function loadReceipts(): StoredReceipt[] {
  if (!existsSync(RECEIPTS_FILE)) return [];

  let content: string;
  try {
    content = readFileSync(RECEIPTS_FILE, "utf-8").trim();
  } catch {
    return [];
  }
  if (!content) return [];

  const entries: StoredReceipt[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isStoredReceipt(parsed)) entries.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

/**
 * A line survives the read only when it carries a structurally intact signed
 * body — the same guard the transport applies on the way in, so what can't
 * arrive over the wire can't come back out of the file either. This file is
 * hand-editable; a stored shape is never assumed, only checked.
 *
 * Scoped to the signed body deliberately. Every read path dereferences those
 * fields unconditionally (`receiptDisplay`'s `paid.msats`, the attestation
 * link's `receipt_pubkey`, `list`'s `dvm_id` filter), so a body missing one
 * throws where the row would otherwise have rendered as the `invalid` receipt
 * it is — and dropping it costs no proof, because a body the signature doesn't
 * cover could never have verified. The envelope around it — `endpoint`,
 * `verified_at`, `builder` — is our own bookkeeping, unsigned, and is guarded
 * where it renders instead: a mangled one must not cost the caller a receipt
 * that is otherwise sound.
 */
function isStoredReceipt(value: unknown): value is StoredReceipt {
  if (!value || typeof value !== "object") return false;
  return isSignedJobReceipt((value as Record<string, unknown>).receipt);
}

function isStoredFundingReceipt(value: unknown): value is StoredFundingReceipt {
  if (!value || typeof value !== "object") return false;
  return isFundingReceipt((value as Record<string, unknown>).receipt);
}

export function loadReceipt(jobId: string): StoredReceipt | null {
  return loadReceipts().find((e) => e.receipt.job_id === jobId) ?? null;
}
