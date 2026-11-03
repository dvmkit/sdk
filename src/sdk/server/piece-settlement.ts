import type { ReceiptCredit, ReceiptSettlement } from "../../lib/receipt";
import type { DrawResult } from "./credit-ledger";
import { deferredX402IntentId } from "./funding";
import type { JobRecord } from "./job-store";
import { endPieces, pieceCharge, terminalEnding } from "./pieces";

/** The hold a draw carried before its terminal resolution, mid-job growth included. */
export function drawHeldMicro(draw: Pick<DrawResult, "amountMicro" | "partialSettle">): number {
  return draw.partialSettle?.heldMicro ?? draw.amountMicro;
}

/**
 * What a terminal job's draw settles, in micro-units of the draw's currency: the figure its
 * terminal transition froze. The inline finaliser and the late reconciler both read it here, so
 * they can only ever pass the same figure to `resolveDraw`.
 *
 * A store that kept the job's pieces but froze no figure (a custom store saving snapshots as
 * given) is settled from those pieces and the snapshot's ending, the same rule the built-in
 * stores apply. Two shapes predate the frozen figure. A job that ended before piece accounting
 * (no pieces, no settlement) settles by its outcome, as it did then; one accepted before it but
 * ended after froze `whole`, a single piece the size of its hold. An unsigned x402 job is one
 * piece settled only on completion, so nothing else charges it. A figure above the hold, which
 * only an untracked growth could produce, is clamped to it.
 */
export function frozenSettleMicro(
  record: Pick<JobRecord, "status" | "settlement" | "creditId" | "pieces" | "pieceEnding">,
  heldMicro: number
): { settleMicro: number; clamped: boolean } {
  const settlement = record.settlement ??
    (record.pieces ? endPieces(record.pieces, terminalEnding(record)).settlement : undefined);
  let figure: number;
  if (deferredX402IntentId(record.creditId)) figure = record.status === "completed" ? heldMicro : 0;
  else if (settlement?.chargedMicro !== undefined) figure = settlement.chargedMicro;
  else if (settlement?.whole) figure = settlement.whole === "settle" ? heldMicro : 0;
  else figure = record.status === "completed" ? heldMicro : 0;
  return figure > heldMicro ? { settleMicro: heldMicro, clamped: true } : { settleMicro: figure, clamped: false };
}

/** The micro-units a resolved draw charged: its settled part, nothing when released. */
export function drawChargedMicro(draw: Pick<DrawResult, "amountMicro" | "status">): number {
  return draw.status === "settled" ? draw.amountMicro : 0;
}

/** The receipt's credit block for a resolved draw: `amount` is what it charged. */
export function receiptCreditFor(
  draw: Pick<DrawResult, "creditId" | "drawId" | "amountMicro" | "status" | "balanceAfterMicro" | "ledgerSeq">,
  balanceAfterMicro: number
): ReceiptCredit {
  return {
    credit_id: draw.creditId,
    draw_id: draw.drawId,
    amount: drawChargedMicro(draw),
    balance_after: balanceAfterMicro,
    ledger_seq: draw.ledgerSeq,
  };
}

/** The receipt's settlement block: the ledger's hold and charge, and the job's pieces. */
export function receiptSettlementFor(
  record: Pick<JobRecord, "pieces">,
  draw: Pick<DrawResult, "amountMicro" | "status" | "partialSettle">
): ReceiptSettlement {
  const held = drawHeldMicro(draw);
  const charged = drawChargedMicro(draw);
  return {
    held,
    charged,
    released: held - charged,
    pieces: (record.pieces ?? []).map((piece) => ({
      amount: piece.amountMicro,
      charged: pieceCharge(piece),
      paid_seq: piece.paidSeq,
      state: piece.state,
    })),
  };
}
