/**
 * Charging mid-job work by the piece.
 *
 * Each payment buys the next piece of work: the upfront payment buys the first piece, and each
 * paid `ctx.requestPayment` ask buys the piece after it. A piece is finished when the DVM sends
 * its next ask or completes the job. However a job ends, the caller is charged for its finished
 * pieces and the piece in progress is released, with one exception: a caller's cancel stops the
 * running piece and charges it with the finished ones.
 *
 * Amounts are integer micro-units of the job draw's currency. Both job stores apply these rules
 * under their own row lock, so the arithmetic lives here once.
 */

/** Where a piece of work stands: `finished` and `stopped` pieces are charged, `released` ones are not. */
export type PieceState = "running" | "finished" | "stopped" | "released";

/** One piece of work a job's payment bought, as a job store keeps it on `JobRecord.pieces`. */
export interface JobPiece {
  /** Price, in micro-units of the draw's currency. */
  amountMicro: number;
  /** Sequence of the payment message that bought the piece; `0` for the upfront payment. */
  paidSeq: number;
  /** A lower charge the DVM gave when the piece finished; never above `amountMicro`. */
  chargeMicro?: number;
  state: PieceState;
}

/**
 * How a job's terminal transition ends its running piece. `finish` may name the piece the
 * handler was working on by its `paidSeq`; any other running piece was then bought by a
 * payment for an ask the job withdrew, so it is released. Without `paidSeq` it finishes
 * whichever piece is running.
 */
export type PieceEnding =
  | { kind: "finish"; paidSeq?: number; chargeMicro?: number }
  | { kind: "stop" }
  | { kind: "release" };

/** The settlement a job's terminal transition froze, read by every later draw resolution. */
export interface JobSettlement {
  /** Micro-units the draw settles: finished and stopped pieces at their charge. */
  chargedMicro?: number;
  /**
   * Set instead of {@link chargedMicro} on a job accepted before piece accounting: it is one
   * piece, so its whole hold settles or releases.
   */
  whole?: "settle" | "release";
  /** A cancel stopped a running piece and charged it. */
  stoppedPiece: boolean;
}

/** The piece the job is working on, if any. */
export function runningPiece(pieces: readonly JobPiece[] | undefined): JobPiece | undefined {
  return pieces?.findLast((piece) => piece.state === "running");
}

/** What one piece costs the caller: its charge once finished or stopped, nothing otherwise. */
export function pieceCharge(piece: JobPiece): number {
  if (piece.state !== "finished" && piece.state !== "stopped") return 0;
  return loweredCharge(piece, piece.chargeMicro) ?? piece.amountMicro;
}

/**
 * The charge a finishing piece is lowered to, when `chargeMicro` is a valid one: a non-negative
 * safe integer below the piece's price. Anything else leaves the piece at full price, so a store
 * called directly with a bad figure can never freeze a negative or fractional settlement.
 */
function loweredCharge(piece: JobPiece, chargeMicro: number | undefined): number | undefined {
  return chargeMicro !== undefined && Number.isSafeInteger(chargeMicro) && chargeMicro >= 0 &&
    chargeMicro < piece.amountMicro ? chargeMicro : undefined;
}

/** A payment that grew the job's draw bought a piece, which starts running. */
export function appendPiece(pieces: readonly JobPiece[], amountMicro: number, paidSeq: number): JobPiece[] {
  return [...pieces, { amountMicro, paidSeq, state: "running" }];
}

/**
 * Finish the running piece, at `chargeMicro` when that is a valid charge below its price. An
 * invalid charge is refused earlier, where the handler can see the error; here it is simply not
 * applied.
 */
export function finishRunningPiece(pieces: readonly JobPiece[], chargeMicro?: number): JobPiece[] {
  const running = runningPiece(pieces);
  return pieces.map((piece) => {
    if (piece !== running) return { ...piece };
    const lowered = loweredCharge(piece, chargeMicro);
    return { ...piece, state: "finished" as const, ...(lowered !== undefined && { chargeMicro: lowered }) };
  });
}

/**
 * What an ask tells the caller declining it would cost: the finished pieces at their charge, a
 * lowered one where the DVM gave it, exactly what a decline's release ending settles. At an open
 * ask no piece is running, so a cancel there charges the same.
 */
export function chargedIfDeclinedMicro(pieces: readonly JobPiece[] | undefined): number {
  return (pieces ?? []).reduce((sum, piece) => sum + pieceCharge(piece), 0);
}

/**
 * Apply a terminal ending and freeze the settlement figure. `undefined` pieces is a job accepted
 * before piece accounting, which is one piece of unknown size: the figure is resolved against the
 * draw's hold.
 */
export function endPieces(
  pieces: readonly JobPiece[] | undefined,
  ending: PieceEnding
): { pieces: JobPiece[] | undefined; settlement: JobSettlement } {
  if (pieces === undefined) {
    return {
      pieces: undefined,
      settlement: { whole: ending.kind === "release" ? "release" : "settle", stoppedPiece: ending.kind === "stop" },
    };
  }
  let stoppedPiece = false;
  const ended = pieces.map((piece): JobPiece => {
    if (piece.state !== "running") return { ...piece };
    if (ending.kind === "stop") {
      stoppedPiece = true;
      return { ...piece, state: "stopped" };
    }
    if (ending.kind === "finish" && (ending.paidSeq === undefined || ending.paidSeq === piece.paidSeq)) {
      const lowered = loweredCharge(piece, ending.chargeMicro);
      return { ...piece, state: "finished", ...(lowered !== undefined && { chargeMicro: lowered }) };
    }
    return { ...piece, state: "released" };
  });
  return {
    pieces: ended,
    settlement: { chargedMicro: ended.reduce((sum, piece) => sum + pieceCharge(piece), 0), stoppedPiece },
  };
}

/**
 * The ending a terminal write applies: the one the SDK put on the snapshot, or, for a terminal
 * written without one, finishing on completion and releasing otherwise.
 */
export function terminalEnding(record: { status: string; pieceEnding?: PieceEnding }): PieceEnding {
  return record.pieceEnding ?? (record.status === "completed" ? { kind: "finish" } : { kind: "release" });
}

/**
 * Check a `finishedChargeMicro` the handler passed to the call that finishes a piece. It is a
 * non-negative integer of the draw's currency micro-units, at most the running piece's price.
 * With no paid piece running there is nothing to lower and the value is only range-checked.
 */
export function checkFinishedCharge(running: JobPiece | undefined, chargeMicro: number | undefined): void {
  if (chargeMicro === undefined) return;
  if (!Number.isSafeInteger(chargeMicro) || chargeMicro < 0) {
    throw new RangeError(`finishedChargeMicro must be a non-negative integer of micro-units; got ${String(chargeMicro)}`);
  }
  if (running && chargeMicro > running.amountMicro) {
    throw new RangeError(
      `finishedChargeMicro ${chargeMicro} exceeds the running piece's price of ${running.amountMicro} micro-units`
    );
  }
}

/** Read a stored piece list defensively; anything that is not an array is the legacy absence. */
export function storedPieces(value: unknown): JobPiece[] | undefined {
  if (typeof value === "string") return storedPieces(JSON.parse(value));
  return Array.isArray(value) ? (value as JobPiece[]) : undefined;
}
