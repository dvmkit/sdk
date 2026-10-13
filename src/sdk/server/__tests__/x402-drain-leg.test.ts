import { describe, expect, it, vi } from "vitest";

import { commitTerminalDrain } from "../credit-drain-report";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { completeX402ChannelDrain } from "../x402-drain-leg";
import { fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "ab".repeat(32);
const CHANNEL_ID = `0x${"cd".repeat(32)}`;
const DEBITED_NATIVE = 400_000;

describe("completeX402ChannelDrain", () => {
  it("marks a surplus refund sent and records the surplus as settlement evidence", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    const { drain } = await completeX402ChannelDrain({
      deps: { ledger, drainReport: {} },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      settledAmount: "500000",
      debitedNative: DEBITED_NATIVE,
      transaction: "0xrefund",
    });

    expect(drain).toMatchObject({
      status: "sent",
      sentRef: {
        channel_id: CHANNEL_ID,
        transaction: "0xrefund",
        settled_amount: "500000",
        surplus_native: "100000",
      },
    });
  });

  it("reports the repair kind with the ledger amount, not the larger chain settlement", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();
    const enqueueCreditDrain = vi.fn(async () => undefined);

    await completeX402ChannelDrain({
      deps: { ledger, drainReport: { dvmId: "dvm-1", enqueueCreditDrain } },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      settledAmount: "500000",
      debitedNative: DEBITED_NATIVE,
      transaction: "0xrefund",
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
        repairKind: "x402_settlement_reconciled",
      })
    );
  });

  it("refuses unrecognised repair evidence before enqueueing a permanent client error", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();
    const completed = await completeX402ChannelDrain({
      deps: { ledger, drainReport: {} },
      creditId,
      drainId,
      channelId: CHANNEL_ID,
      settledAmount: String(DEBITED_NATIVE),
      debitedNative: DEBITED_NATIVE,
      transaction: "0xrefund",
    });
    completed.drain.sentRef = { repaired: true, repair_kind: "unknown_repair" };
    const enqueueCreditDrain = vi.fn(async () => undefined);

    await expect(
      commitTerminalDrain(
        { dvmId: "dvm-1", enqueueCreditDrain },
        async () => ({ ...completed, replayed: false }),
        {} as never
      )
    ).rejects.toThrow(`invalid credit-drain repair metadata on ${creditId}/${drainId}`);
    expect(enqueueCreditDrain).not.toHaveBeenCalled();
  });

  it("refuses a settlement short of the ledger debit", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();

    await expect(
      completeX402ChannelDrain({
        deps: { ledger, drainReport: {} },
        creditId,
        drainId,
        channelId: CHANNEL_ID,
        settledAmount: "399999",
        debitedNative: DEBITED_NATIVE,
        transaction: "0xshort",
      })
    ).rejects.toMatchObject({ code: "drain_conflict" });
    expect(await ledger.getDrain({ creditId, drainId })).toMatchObject({ status: "pending" });
  });

  it("reports a replay when another caller already booked the terminal transition", async () => {
    const { ledger, creditId, drainId } = await pendingDrain();
    const book = () =>
      completeX402ChannelDrain({
        deps: { ledger, drainReport: {} },
        creditId,
        drainId,
        channelId: CHANNEL_ID,
        settledAmount: String(DEBITED_NATIVE),
        debitedNative: DEBITED_NATIVE,
        transaction: "0xrefund",
      });

    expect((await book()).replayed).toBe(false);
    expect((await book()).replayed).toBe(true);
  });
});

async function pendingDrain(): Promise<{
  ledger: MemoryCreditLedger;
  creditId: string;
  drainId: string;
}> {
  const ledger = new MemoryCreditLedger();
  const creditId = "credit-x402-surplus";
  const drainId = "drain-x402-surplus";
  await fundCredit(ledger, {
    creditId,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: DEBITED_NATIVE,
    expiryMs: Date.now() + 60_000,
    basis: {
      rail: "x402",
      paidMsats: 40_000,
      nativeAmount: DEBITED_NATIVE,
      nativeAsset: "usdc",
      fundingRef: "0xfunding",
      x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: String(DEBITED_NATIVE) },
    },
  });
  await ledger.requestDrain({
    creditId,
    drainId,
    callerPubkey: CALLER,
    method: "x402",
    payout: { channel_id: CHANNEL_ID },
  });
  return { ledger, creditId, drainId };
}
