import { describe, expect, it } from "vitest";

import { CreditLedgerError } from "../credit-ledger";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import type {
  X402RefundSettlementGate,
  X402SettlementStatus,
  X402UnresolvedRefund,
} from "../x402-channel-store";
import { fundCredit } from "./__helpers__/credit-fixtures";

const CALLER = "ab".repeat(32);
const CHANNEL_ID = `0x${"7c".repeat(32)}`;
const CREDIT_ID = "imp:x402:pay-1";
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

describe("an unresolved x402 refund gates its credit", () => {
  it("refuses a fresh draw settlement_pending, naming the settlement an operator repairs", async () => {
    const ledger = await wedged("settled");

    const err = await expectCode(
      ledger.draw({ creditId: CREDIT_ID, drawId: "respend-full", amountMicro: 400_000 }),
      "settlement_pending"
    );
    expect(err.details).toMatchObject({ settlementId: "s-1", settlementStatus: "settled" });
    // the drain id the hold is under travels with the refusal, off the
    // effect id by prefix. `imp:x402:pay-1` carries its own colons, so a split
    // would answer `x402` here.
    expect(err.details.blockingDrainId).toBe("earlier-drain");

    await expectCode(
      ledger.draw({ creditId: CREDIT_ID, drawId: "respend-partial", amountMicro: 1_000 }),
      "settlement_pending"
    );
  });

  it.each(["submitting", "settled", "written_off"] as const)("refuses fresh balance growth through a %s refund but permits accepted rail growth", async (status) => {
    const ledger = new MemoryCreditLedger();
    await seed(ledger);
    await ledger.draw({ creditId: CREDIT_ID, drawId: "existing", amountMicro: 10_000 });
    ledger.useX402SettlementGate(gate(status));
    await expectCode(ledger.growDraw({ creditId: CREDIT_ID, drawId: "existing", addAmountMicro: 1_000,
      spendExistingBalance: true }), "settlement_pending");
    expect((await ledger.getDraw({ creditId: CREDIT_ID, drawId: "existing" }))?.amountMicro).toBe(10_000);
    await ledger.growDraw({ creditId: CREDIT_ID, drawId: "existing", addAmountMicro: 1_000 });
    expect((await ledger.getDraw({ creditId: CREDIT_ID, drawId: "existing" }))?.amountMicro).toBe(11_000);
  });

  it("still replays a draw placed before the wedge", async () => {
    const ledger = new MemoryCreditLedger();
    await seed(ledger);
    const placed = await ledger.draw({
      creditId: CREDIT_ID,
      drawId: "d1",
      amountMicro: 10_000,
      jobId: "j1",
    });
    ledger.useX402SettlementGate(gate("settled"));

    const replay = await ledger.draw({
      creditId: CREDIT_ID,
      drawId: "d1",
      amountMicro: 10_000,
      jobId: "j1",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.ledgerSeq).toBe(placed.ledgerSeq);
  });

  it("gates a submitting refund as well as a settled one", async () => {
    const ledger = await wedged("submitting");
    await expectCode(
      ledger.draw({ creditId: CREDIT_ID, drawId: "d1", amountMicro: 1_000 }),
      "settlement_pending"
    );
  });

  it("blocks spending a written-off refund's balance but still lets the caller reclaim it", async () => {
    // Write-off does not establish whether the chain paid: block spending, but permit reclaim
    // under a fresh drain ID.
    const ledger = await wedged("written_off");

    const err = await expectCode(
      ledger.draw({ creditId: CREDIT_ID, drawId: "d1", amountMicro: 1_000 }),
      "settlement_pending"
    );
    // Withhold the old ID after write-off because it is retired; the fresh ID below is the
    // reclaim that can proceed.
    expect(err.details).toMatchObject({ settlementStatus: "written_off" });
    expect(err.details.blockingDrainId).toBeUndefined();
    const drained = await ledger.requestDrain({
      creditId: CREDIT_ID,
      drainId: "fresh-drain",
      callerPubkey: CALLER,
      method: "x402",
      payout: { channel_id: CHANNEL_ID },
    });
    expect(drained.drain.amountMicro).toBe(400_000);
  });

  it("refuses a fresh drain while a refund is between chain and ledger, naming the id that isn't", async () => {
    const ledger = await wedged("settled");
    const err = await expectCode(
      ledger.requestDrain({
        creditId: CREDIT_ID,
        drainId: "second-drain",
        callerPubkey: CALLER,
        method: "x402",
        payout: { channel_id: CHANNEL_ID },
      }),
      "settlement_pending"
    );
    expect(err.details.blockingDrainId).toBe("earlier-drain");
  });

  it("names no drain id for a settlement effect that belongs to another credit", async () => {
    const ledger = await wedged("settled", "imp:x402:other-credit:its-drain");
    const err = await expectCode(
      ledger.requestDrain({
        creditId: CREDIT_ID,
        drainId: "second-drain",
        callerPubkey: CALLER,
        method: "x402",
        payout: { channel_id: CHANNEL_ID },
      }),
      "settlement_pending"
    );
    expect(err.details.blockingDrainId).toBeUndefined();
  });

  it("admits the wedged drain's own re-entry, which is what makes it repairable", async () => {
    // A rolled-back cooperative close can lose its drain row. Its original effect ID must
    // still pass as a fresh request so retry and repair remain possible.
    const ledger = await wedged("settled", "imp:x402:pay-1:drain-1");
    const requested = await ledger.requestDrain({
      creditId: CREDIT_ID,
      drainId: "drain-1",
      callerPubkey: CALLER,
      method: "x402",
      payout: { channel_id: CHANNEL_ID },
    });
    expect(requested.drain.amountMicro).toBe(400_000);
  });

  it("refuses a channel deposit onto the wedged channel, before it books anything", async () => {
    const ledger = await wedged("settled");

    const err = await expectCode(
      fundCredit(ledger, {
        creditId: CREDIT_ID,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 10_000,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          fundingRef: "0xtopup",
          x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "500000" },
        },
      }),
      "settlement_pending"
    );
    expect(err.details).toMatchObject({ settlementId: "s-1", settlementStatus: "settled" });
    expect((await ledger.get(CREDIT_ID))?.balanceMicro).toBe(400_000);
  });

  it("leaves a top-up that names no channel to the binding rules", async () => {
    // A funding with no `x402Channel` basis cannot reach a channel-bound
    // credit's balance anyway — `fund`'s own binding guard refuses it — so the
    // settlement gate must not be the thing that answers, or it would speak for
    // a channel this payment never touches.
    const ledger = await wedged("settled");
    await expectCode(
      fundCredit(ledger, {
        creditId: CREDIT_ID,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      }),
      "rail_mismatch"
    );
  });

  it("leaves a credit with no bound channel alone", async () => {
    const ledger = new MemoryCreditLedger();
    await fundCredit(ledger, {
      creditId: "cashu-credit",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 400_000,
      expiryMs: FUTURE_MS,
    });
    ledger.useX402SettlementGate(gate("settled"));

    const drawn = await ledger.draw({
      creditId: "cashu-credit",
      drawId: "d1",
      amountMicro: 1_000,
    });
    expect(drawn.replayed).toBe(false);
  });
});

async function wedged(
  status: X402SettlementStatus,
  effectId = "imp:x402:pay-1:earlier-drain"
): Promise<MemoryCreditLedger> {
  const ledger = new MemoryCreditLedger();
  await seed(ledger);
  ledger.useX402SettlementGate(gate(status, effectId));
  return ledger;
}

async function seed(ledger: MemoryCreditLedger): Promise<void> {
  await fundCredit(ledger, {
    creditId: CREDIT_ID,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 400_000,
    expiryMs: FUTURE_MS,
    basis: {
      rail: "x402",
      paidMsats: 40_000,
      nativeAmount: 400_000,
      nativeAsset: "usdc",
      fundingRef: "0xfunding",
      x402Channel: { channelId: CHANNEL_ID, maxClaimableAmount: "400000" },
    },
  });
}

function gate(
  status: X402SettlementStatus,
  effectId = "imp:x402:pay-1:earlier-drain"
): X402RefundSettlementGate {
  return {
    pendingRefundSettlement: (
      channelId: string,
      statuses: X402SettlementStatus[]
    ): Promise<X402UnresolvedRefund | undefined> =>
      Promise.resolve(
        channelId === CHANNEL_ID && statuses.includes(status)
          ? { settlementId: "s-1", effectId, status }
          : undefined
      ),
  };
}

async function expectCode(
  p: Promise<unknown>,
  code: CreditLedgerError["code"]
): Promise<CreditLedgerError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CreditLedgerError);
    expect((err as CreditLedgerError).code).toBe(code);
    return err as CreditLedgerError;
  }
  throw new Error(`expected CreditLedgerError(${code})`);
}
