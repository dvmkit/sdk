import { CreditLedgerError, type DrawStatus } from "./credit-ledger";

/**
 * How much of a pending hold a terminal resolution charges, in the draw's currency micro-units.
 * `"hold"` is the whole hold, including a zero hold, which is what `settle` asks for. A number is
 * a `resolveDraw` figure: zero releases the draw, any other figure settles that part and releases
 * the rest.
 */
export type DrawSettleRequest = number | "hold";

/** The terminal state a resolution writes, or finds already written. */
export interface DrawResolutionPlan {
  status: "settled" | "released";
  /** Micro the resolution charges. The rest of the hold returns to the credit. */
  settleMicro: number;
  /** The draw already carries this resolution, so nothing is written. */
  replay: boolean;
  /** Settles less than a positive hold, so the row is rewritten down to the settled part. */
  partial: boolean;
}

/** Refuse a figure the ledger cannot settle: fractional, negative or past the safe range. */
export function assertSettleMicro(settleMicro: number): void {
  if (!Number.isSafeInteger(settleMicro) || settleMicro < 0) {
    throw new CreditLedgerError(
      "invalid_amount",
      `settleMicro must be a safe integer ≥ 0 (got ${settleMicro})`
    );
  }
}

/**
 * Decide what resolving `draw` with `request` does. Both ledgers call this under their credit
 * lock, so the replay rule cannot drift between them.
 *
 * A pending draw resolves once. A resolved draw replays only the resolution it recorded, the
 * same status and the same settled figure; anything else is `invalid_draw_state`, which keeps
 * settle-after-release and release-after-settle refused and also refuses a second, different
 * figure. One consequence: a zero hold settled by `settle` refuses `resolveDraw` with zero,
 * which asks for a release.
 *
 * The figure is checked against the hold the draw was placed and grown to, so a partly settled
 * draw still measures a later request against its original hold.
 */
export function planDrawResolution(
  draw: { drawId: string; status: DrawStatus; amountMicro: number; heldMicro: number | null },
  request: DrawSettleRequest
): DrawResolutionPlan {
  const holdMicro = draw.heldMicro ?? draw.amountMicro;
  const settleMicro = request === "hold" ? holdMicro : request;
  if (settleMicro > holdMicro) {
    throw new CreditLedgerError(
      "invalid_amount",
      `cannot settle ${settleMicro} of draw ${draw.drawId}: its hold is ${holdMicro}`
    );
  }
  const status = request === "hold" || settleMicro > 0 ? "settled" : "released";
  if (draw.status === "pending") {
    return { status, settleMicro, replay: false, partial: status === "settled" && settleMicro < holdMicro };
  }
  const recordedMicro = draw.status === "settled" ? draw.amountMicro : 0;
  if (draw.status === status && recordedMicro === settleMicro) {
    return { status, settleMicro, replay: true, partial: draw.heldMicro !== null };
  }
  throw new CreditLedgerError(
    "invalid_draw_state",
    draw.status === status
      ? `cannot settle ${settleMicro} of draw ${draw.drawId}: it already settled ${recordedMicro}`
      : `cannot ${status === "settled" ? "settle" : "release"} draw ${draw.drawId}: status is ${draw.status}`,
    { currentStatus: draw.status, settledMicro: recordedMicro }
  );
}

/**
 * The share of a hold's rail value (msats or native units) that a settle of `settleMicro`
 * charges, floored so any rounding unit stays with the released remainder and the caller is
 * never charged past the settled fraction. A whole settle keeps the value exactly.
 */
export function settledShare(value: number, settleMicro: number, holdMicro: number): number {
  if (settleMicro >= holdMicro) return value;
  return Number((BigInt(value) * BigInt(settleMicro)) / BigInt(holdMicro));
}
