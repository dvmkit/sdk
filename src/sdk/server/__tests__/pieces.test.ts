import { describe, expect, it } from "vitest";

import { endPieces, type JobPiece } from "../pieces";
import { receiptSettlementFor } from "../piece-settlement";

const running = (paidSeq: number, amountMicro: number): JobPiece => ({ amountMicro, paidSeq, state: "running" });

describe("ending a job's pieces", () => {
  it("finishes only the piece the handler was working on when completing", () => {
    // A payment whose arrival beat the completion's terminal write paid an ask the completion
    // withdrew. Its piece was never worked on, so it goes back to the caller.
    const pieces: JobPiece[] = [{ amountMicro: 100_000, paidSeq: 0, state: "finished" }, running(2, 200_000), running(5, 500_000)];
    const ended = endPieces(pieces, { kind: "finish", paidSeq: 2, chargeMicro: 50_000 });
    expect(ended.pieces?.map((piece) => [piece.state, piece.chargeMicro])).toEqual([
      ["finished", undefined], ["finished", 50_000], ["released", undefined],
    ]);
    expect(ended.settlement).toEqual({ chargedMicro: 150_000, stoppedPiece: false });
  });

  it("settles a job with no piece list as one piece of unknown size", () => {
    expect(endPieces(undefined, { kind: "stop" }).settlement).toEqual({ whole: "settle", stoppedPiece: true });
    expect(endPieces(undefined, { kind: "finish" }).settlement).toEqual({ whole: "settle", stoppedPiece: false });
    expect(endPieces(undefined, { kind: "release" }).settlement).toEqual({ whole: "release", stoppedPiece: false });
  });
});

it("withholds a receipt breakdown that matches the charge but omits part of the hold", () => {
  const settlement = receiptSettlementFor({ pieces: [
    { amountMicro: 40_000, paidSeq: 0, state: "finished" },
    { amountMicro: 20_000, paidSeq: 2, state: "released" },
  ] }, {
    amountMicro: 40_000, status: "settled",
    partialSettle: { heldMicro: 100_000, releasedMicro: 60_000, releasedNative: null },
  });
  expect(settlement).toEqual({ held: 100_000, charged: 40_000, released: 60_000, pieces: [] });
});
