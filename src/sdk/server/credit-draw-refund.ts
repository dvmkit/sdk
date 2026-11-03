import { CreditLedgerError } from "./credit-ledger";
import type { CreditDrawRefundEnqueue } from "./revenue-reporter";

export type CreditDrawRefundArgs = {
  refundId: string;
  amountMicro?: number;
  reason?: string;
  outbox: { dvmId: string; enqueue: CreditDrawRefundEnqueue };
  /** DVM receipt key from trusted server configuration, never from job content or the request. */
  trustedReceiptPubkey?: string;
  nowMs?: number;
} & ({ jobId: string; creditId?: never; drawId?: never } |
  { creditId: string; drawId: string; jobId?: never });

export interface CreditDrawRefundResult {
  refundId: string;
  creditId: string;
  drawId: string;
  jobId: string;
  amountMicro: number;
  currency: string;
  ledgerSeq: number;
  refundedAt: number;
  /** Persisted balance immediately after this refund, not a current balance read. */
  balanceAfterMicro: number;
  replayed: boolean;
}

/**
 * A refund returns settled spending only. A partial settle rewrites its draw down to the settled
 * part, so that part is what both refusals measure; the released rest is already on the credit.
 */
export const DRAW_NOT_SETTLED_REFUSAL =
  "Only a settled draw, or the settled part of a partly settled draw, can be refunded.";
export const REFUND_EXCEEDS_SETTLED_REFUSAL =
  "The refund exceeds the draw's remaining unrefunded settled charge.";

/** Omission is a stable remainder intent, distinct from an explicit equal amount. */
export function refundRequest(args: CreditDrawRefundArgs): string {
  const id = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  if (!id(args.refundId) ||
    !(id(args.jobId) && args.creditId === undefined && args.drawId === undefined ||
      args.jobId === undefined && id(args.creditId) && id(args.drawId)) ||
    args.amountMicro !== undefined && (!Number.isSafeInteger(args.amountMicro) || args.amountMicro <= 0) ||
    args.reason !== undefined && (typeof args.reason !== "string" || args.reason.length > 280)) {
    throw new CreditLedgerError("invalid_refund", "Provide one draw selector, a refundId, a positive integer amountMicro if specified, and a reason of at most 280 characters.");
  }
  return JSON.stringify({
    dvmId: args.outbox.dvmId,
    jobId: args.jobId ?? null,
    creditId: args.creditId ?? null,
    drawId: args.drawId ?? null,
    amountMicro: args.amountMicro ?? null,
    reason: args.reason ?? null,
  });
}

/** Integer cumulative allocation makes the final slice return every original asset unit. */
export function refundAssetDelta(original: number, amountMicro: number, before: number, after: number): number {
  const value = BigInt(original);
  const denominator = BigInt(amountMicro);
  return Number(value * BigInt(after) / denominator - value * BigInt(before) / denominator);
}
