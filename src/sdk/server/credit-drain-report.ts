import type { Pool } from "pg";

import type {
  CreditDrainRecord,
  CreditLedgerQuerier,
  DrainTransitionResult,
} from "./credit-ledger";
import type {
  CreditDrainEnqueue,
  CreditDrainPayload,
  CreditDrainRepairKind,
} from "./revenue-reporter";

const CREDIT_DRAIN_REPAIR_KINDS = new Set<CreditDrainRepairKind>([
  "x402_settlement_reconciled",
  "tempo_close_reconciled",
]);

/**
 * Reporting is optional; an unwired host still runs the money transition.
 */
export interface DrainReportWiring {
  /** The SDK's own Postgres, which holds both the ledger and the reporter's outbox. */
  db?: Pool;
  /** Platform DVM record ID, bound into every report. */
  dvmId?: string;
  /** Reporter-owned outbox write, run inside the transition's transaction. */
  enqueueCreditDrain?: CreditDrainEnqueue;
}

/**
 * When reporting is wired, commit the terminal transition and its outbox row on the same
 * transaction. Only the transition’s non-replayed CAS winner enqueues a report. An enqueue
 * failure must roll back the ledger transition.
 *
 * With outerTx, join that handle and leave commit/rollback to its caller. Without reporting
 * wiring, run the transition directly. Return replayed so callers can gate receipts and
 * explain whether this call changed the drain.
 */
export async function commitTerminalDrain(
  wiring: DrainReportWiring,
  transition: (tx?: CreditLedgerQuerier) => Promise<DrainTransitionResult>,
  outerTx?: CreditLedgerQuerier
): Promise<DrainTransitionResult> {
  const { db, dvmId, enqueueCreditDrain } = wiring;
  if (outerTx) {
    const result = await transition(outerTx);
    if (!result.replayed && dvmId && enqueueCreditDrain) {
      await enqueueCreditDrain(outerTx, drainReport(dvmId, result.drain));
    }
    return result;
  }
  if (!db || !dvmId || !enqueueCreditDrain) return transition();

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await transition(client);
    if (!result.replayed) {
      await enqueueCreditDrain(client, drainReport(dvmId, result.drain));
    }
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // The transaction is already unusable; the original error is what matters.
    });
    throw err;
  } finally {
    client.release();
  }
}

function drainReport(dvmId: string, drain: CreditDrainRecord): CreditDrainPayload {
  return {
    dvmId,
    creditId: drain.creditId,
    callerPubkey: drain.callerPubkey,
    drainId: drain.drainId,
    method: drain.method,
    amountMicro: drain.amountMicro,
    creditCurrency: drain.currency,
    status: drain.status,
    drainedAt: drainedAt(drain),
    ledgerSeq: drain.ledgerSeq,
    ...repairMetadata(drain),
  };
}

/**
 * Promote the ledger's repair evidence onto the platform wire shape.
 *
 * `sent_ref` is JSON evidence and therefore untyped at rest. Validate the pair
 * here, inside the terminal transaction, so a malformed repair can never be
 * committed while its report is guaranteed to become a permanent platform
 * 400. Ordinary drains carry neither field.
 */
function repairMetadata(
  drain: CreditDrainRecord
): Pick<CreditDrainPayload, "repaired" | "repairKind"> {
  const repaired = drain.sentRef?.repaired;
  const repairKind = drain.sentRef?.repair_kind;
  if (repaired !== true && repairKind === undefined) return {};
  if (repaired !== true || !isCreditDrainRepairKind(repairKind)) {
    throw new Error(`invalid credit-drain repair metadata on ${drain.creditId}/${drain.drainId}`);
  }
  return { repaired: true, repairKind };
}

function isCreditDrainRepairKind(value: unknown): value is CreditDrainRepairKind {
  return typeof value === "string" && CREDIT_DRAIN_REPAIR_KINDS.has(value as CreditDrainRepairKind);
}

/**
 * Use the recorded pickup/sent instant, falling back to ledger creation rather than the
 * current report time. A fallback can be older than the platform’s accepted reporting window.
 */
function drainedAt(drain: CreditDrainRecord): number {
  return drain.pickedUpAt ?? drain.sentAt ?? drain.createdAt;
}
