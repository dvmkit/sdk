/**
 * The floor itself is asserted in `credit-drain-floor.test.ts` and the route
 * contract in `admin-credit.test.ts`; what only this suite covers is the leg
 * both doors run — that a booking clears an operator's write-off inside its own
 * transaction, and that the classifier keeps "the chain says nothing" apart
 * from "the chain could not be asked".
 */
import { describe, expect, it, vi } from "vitest";

import { MemoryCreditLedger } from "../memory-credit-ledger";
import type { TempoDrainRail } from "../tempo-drain-leg";
import { classifyTempoCloseEvidence, completeTempoChannelDrain } from "../tempo-drain-leg";
import { fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "ab".repeat(32);
const CHANNEL_ID = `0x${"cd".repeat(32)}`;
const TX_HASH = `0x${"ef".repeat(32)}`;
const DEBITED_NATIVE = 400_000;

describe("completeTempoChannelDrain", () => {
  it("marks a covering close sent and records the payer's channel surplus", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    const { drain } = await completeTempoChannelDrain({
      deps: { ledger, drainReport: {} },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      refundedNative: "500000",
      debitedNative: DEBITED_NATIVE,
      reference: TX_HASH,
    });

    expect(drain).toMatchObject({
      status: "sent",
      sentRef: {
        channel_id: CHANNEL_ID,
        tx_hash: TX_HASH,
        settled_amount: "500000",
        surplus_native: "100000",
      },
    });
    expect(drain.sentRef).not.toHaveProperty("repaired");
  });

  it("refuses a close that refunded less than the ledger debited, booking nothing", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    await expect(
      completeTempoChannelDrain({
        deps: { ledger, drainReport: {} },
        creditId,
        drainId,
        channelId: CHANNEL_ID,
        refundedNative: "399999",
        debitedNative: DEBITED_NATIVE,
        reference: TX_HASH,
      })
    ).rejects.toMatchObject({ code: "drain_conflict" });
    expect(await ledger.getDrain({ creditId, drainId })).toMatchObject({
      status: "pending",
      sentRef: null,
    });
  });

  it("stamps a repair so the drain says an operator finished it by hand", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    const { drain } = await completeTempoChannelDrain({
      deps: { ledger, drainReport: {} },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      refundedNative: String(DEBITED_NATIVE),
      debitedNative: DEBITED_NATIVE,
      reference: TX_HASH,
      repaired: true,
    });

    expect(drain.sentRef).toMatchObject({
      repaired: true,
      repair_kind: "tempo_close_reconciled",
      surplus_native: "0",
    });
  });

  it("reports the repair kind without changing the drain's ledger amount", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();
    const enqueueCreditDrain = vi.fn(async () => undefined);

    await completeTempoChannelDrain({
      deps: { ledger, drainReport: { dvmId: "dvm-1", enqueueCreditDrain } },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      refundedNative: "500000",
      debitedNative: DEBITED_NATIVE,
      reference: TX_HASH,
      repaired: true,
      tx: {} as never,
    });

    expect(enqueueCreditDrain).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        creditId,
        callerPubkey: CALLER,
        drainId,
        amountMicro: DEBITED_NATIVE,
        repaired: true,
        repairKind: "tempo_close_reconciled",
      })
    );
  });

  it("clears a recorded write-off when it books, and leaves it when it refuses", async () => {
    const booked = await pendingDrain();
    await booked.ledger.writeOffDrain({
      creditId: booked.creditId,
      drainId: booked.drainId,
      note: "chain paid short",
    });

    const { drain } = await completeTempoChannelDrain({
      deps: { ledger: booked.ledger, drainReport: {} },
      creditId: booked.creditId,
      drainId: booked.drainId,
      channelId: CHANNEL_ID,
      refundedNative: String(DEBITED_NATIVE),
      debitedNative: DEBITED_NATIVE,
      reference: TX_HASH,
      repaired: true,
    });
    expect(drain).toMatchObject({ status: "sent", writeOffNote: null, writtenOffAt: null });

    // The other half: a refused reconcile must not quietly return a
    // written-off row to the live queue advertising a decision nobody took.
    const refused = await pendingDrain();
    await refused.ledger.writeOffDrain({
      creditId: refused.creditId,
      drainId: refused.drainId,
      note: "reviewed",
    });
    await expect(
      completeTempoChannelDrain({
        deps: { ledger: refused.ledger, drainReport: {} },
        creditId: refused.creditId,
        drainId: refused.drainId,
        channelId: CHANNEL_ID,
        refundedNative: "1",
        debitedNative: DEBITED_NATIVE,
        reference: TX_HASH,
      })
    ).rejects.toMatchObject({ code: "drain_conflict" });
    expect(
      await refused.ledger.getDrain({ creditId: refused.creditId, drainId: refused.drainId })
    ).toMatchObject({ status: "pending", writeOffNote: "reviewed" });
  });

  it("reports the replay when a poll booked the drain first, so nothing countersigns twice", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();
    const book = () =>
      completeTempoChannelDrain({
        deps: { ledger, drainReport: {} },
        creditId,
        drainId,
        channelId: CHANNEL_ID,
        refundedNative: String(DEBITED_NATIVE),
        debitedNative: DEBITED_NATIVE,
        reference: TX_HASH,
      });

    expect((await book()).replayed).toBe(false);
    expect((await book()).replayed).toBe(true);
  });

  it("tolerates a close that reports no figure rather than refusing every drain on it", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    const { drain } = await completeTempoChannelDrain({
      deps: { ledger, drainReport: {} },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      refundedNative: undefined,
      debitedNative: DEBITED_NATIVE,
      reference: `channel:${CHANNEL_ID}`,
    });

    expect(drain.status).toBe("sent");
    expect(drain.sentRef).not.toHaveProperty("settled_amount");
  });
});

describe("classifyTempoCloseEvidence", () => {
  it("reads the close receipt a confirmed intent points at", async () => {
    const rail = stubRail({
      intent: { channelId: CHANNEL_ID, drainId: "drain-1", reference: TX_HASH },
      amounts: { refundedToPayer: 380_000n, settledToPayee: 20_000n },
    });

    await expect(classifyTempoCloseEvidence(rail, CHANNEL_ID)).resolves.toEqual({
      chain: "found",
      transaction: TX_HASH,
      refundedToPayer: "380000",
      settledToPayee: "20000",
    });
  });

  it("keeps a close nobody confirmed apart from one whose reference names no receipt", async () => {
    const unconfirmed = stubRail({
      intent: { channelId: CHANNEL_ID, drainId: "drain-1", reference: null },
    });
    await expect(classifyTempoCloseEvidence(unconfirmed, CHANNEL_ID)).resolves.toEqual({
      chain: "unconfirmed",
    });

    const synthetic = stubRail({
      intent: { channelId: CHANNEL_ID, drainId: "drain-1", reference: `channel:${CHANNEL_ID}` },
    });
    await expect(classifyTempoCloseEvidence(synthetic, CHANNEL_ID)).resolves.toEqual({
      chain: "unreported",
      reference: `channel:${CHANNEL_ID}`,
    });
  });

  it("classifies an unreadable RPC rather than throwing, so one bad row cannot fail a page", async () => {
    const rail = stubRail({
      intent: { channelId: CHANNEL_ID, drainId: "drain-1", reference: TX_HASH },
      amountsError: new Error("rpc timeout"),
    });

    await expect(classifyTempoCloseEvidence(rail, CHANNEL_ID)).resolves.toEqual({
      chain: "unreachable",
      error: "rpc timeout",
    });
  });

  it("reads a channel this DVM does not hold as silence, not as a chain that disagreed", async () => {
    const rail = stubRail({
      intent: { channelId: CHANNEL_ID, drainId: "drain-1", reference: TX_HASH },
      amounts: null,
    });

    await expect(classifyTempoCloseEvidence(rail, CHANNEL_ID)).resolves.toEqual({
      chain: "unreported",
      reference: TX_HASH,
    });
  });
});

function stubRail(args: {
  intent: { channelId: string; drainId: string; reference: string | null } | null;
  amounts?: { refundedToPayer: bigint; settledToPayee: bigint } | null;
  amountsError?: Error;
}): TempoDrainRail {
  return {
    getTempoSessionCloseIntent: vi.fn().mockResolvedValue(args.intent),
    getTempoSessionCloseAmounts: vi
      .fn()
      .mockImplementation(() =>
        args.amountsError
          ? Promise.reject(args.amountsError)
          : Promise.resolve(args.amounts ?? null)
      ),
  };
}

async function pendingDrain(): Promise<{
  ledger: MemoryCreditLedger;
  creditId: string;
  drainId: string;
}> {
  const ledger = new MemoryCreditLedger();
  const creditId = "credit-tempo-wedged";
  const drainId = "drain-tempo-wedged";
  await fundCredit(ledger, {
    creditId,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: DEBITED_NATIVE,
    expiryMs: Date.now() + 60_000,
    basis: {
      rail: "tempo",
      paidMsats: 40_000,
      nativeAmount: DEBITED_NATIVE,
      nativeAsset: "usdc",
      fundingRef: "challenge-1",
      tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: String(DEBITED_NATIVE) },
    },
  });
  await ledger.requestDrain({
    creditId,
    drainId,
    callerPubkey: CALLER,
    method: "tempo",
    payout: { channel_id: CHANNEL_ID },
  });
  return { ledger, creditId, drainId };
}
