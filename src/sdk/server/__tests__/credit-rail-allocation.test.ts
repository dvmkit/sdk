import { describe, expect, it } from "vitest";

import { allocateDrawValue, type CreditFundingBasis } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { clampPooledRailValueToZero } from "./__helpers__/credit-fixtures";

const CALLER = "a".repeat(64);
const FUTURE_MS = Date.now() + 86_400_000;

function ledgerWithFunding(args: {
  amountMicro: number;
  paidMsats: number;
  nativeAmount?: number;
}): Promise<{ ledger: MemoryCreditLedger }> {
  const ledger = new MemoryCreditLedger();
  return ledger
    .fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: args.amountMicro,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "cashu",
        paidMsats: args.paidMsats,
        nativeAmount: args.nativeAmount,
        nativeAsset: args.nativeAmount === undefined ? undefined : "usdc",
        mint: "https://mint.example",
        fundingRef: "req-1",
      },
    })
    .then(() => ({ ledger }));
}

describe("allocateDrawValue", () => {
  it("gives the draw its pro-rata share", () => {
    expect(
      allocateDrawValue({
        amountMicro: 100_000,
        availableMicro: 1_000_000,
        availableMsats: 1_000_000,
        availableNative: 10_000,
      })
    ).toEqual({ drawMsats: 100_000, drawNative: 1_000 });
  });

  it("gives the draw that consumes the last micro the exact remainder", () => {
    expect(
      allocateDrawValue({
        amountMicro: 333,
        availableMicro: 333,
        availableMsats: 977,
        availableNative: 41,
      })
    ).toEqual({ drawMsats: 977, drawNative: 41 });
  });

  it("keeps null native null — a rail that reports no native amount has none to split", () => {
    const out = allocateDrawValue({
      amountMicro: 1,
      availableMicro: 2,
      availableMsats: 10,
      availableNative: null,
    });
    expect(out.drawNative).toBeNull();
  });

  it("never allocates from an exhausted or zero-value credit", () => {
    expect(
      allocateDrawValue({
        amountMicro: 0,
        availableMicro: 1_000,
        availableMsats: 500,
        availableNative: 7,
      })
    ).toEqual({ drawMsats: 0, drawNative: 0 });
    expect(
      allocateDrawValue({
        amountMicro: 10,
        availableMicro: 0,
        availableMsats: 500,
        availableNative: 7,
      })
    ).toEqual({ drawMsats: 0, drawNative: 0 });
  });
});

describe("rail value across a credit's draws", () => {
  it("conserves the funded rail value across 20 settled draws", async () => {
    const FUNDED_MICRO = 2_000_000; // $2.00
    const FUNDED_MSATS = 2_000_000;
    const DRAW_MICRO = 100_000; // $0.10 → 20 jobs
    const { ledger } = await ledgerWithFunding({
      amountMicro: FUNDED_MICRO,
      paidMsats: FUNDED_MSATS,
    });

    let total = 0;
    for (let i = 0; i < 20; i++) {
      const draw = await ledger.draw({
        creditId: "c1",
        drawId: `d${i}`,
        amountMicro: DRAW_MICRO,
        jobId: `job-${i}`,
      });
      await ledger.settle({ creditId: "c1", drawId: `d${i}` });
      total += draw.railValue.drawMsats;
    }

    expect(total).toBe(FUNDED_MSATS);
    const snap = await ledger.get("c1");
    expect(snap?.balanceMicro).toBe(0);
  });

  it("conserves rail value when the fiat split does not divide evenly", async () => {
    // 7 draws of 143 micro against 1001 micro / 999 msats — every allocation
    // rounds, and the last draw still lands the exact remainder.
    const { ledger } = await ledgerWithFunding({
      amountMicro: 1_001,
      paidMsats: 999,
      nativeAmount: 37,
    });

    let msats = 0;
    let native = 0;
    for (let i = 0; i < 7; i++) {
      const draw = await ledger.draw({ creditId: "c1", drawId: `d${i}`, amountMicro: 143 });
      await ledger.settle({ creditId: "c1", drawId: `d${i}` });
      msats += draw.railValue.drawMsats;
      native += draw.railValue.drawNative ?? 0;
    }

    expect(msats).toBe(999);
    expect(native).toBe(37);
  });

  it("returns a released draw's allocation to the pool", async () => {
    const { ledger } = await ledgerWithFunding({ amountMicro: 1_000, paidMsats: 1_000 });

    const failed = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 500 });
    expect(failed.railValue.drawMsats).toBe(500);
    await ledger.release({ creditId: "c1", drawId: "d1" });

    const next = await ledger.draw({ creditId: "c1", drawId: "d2", amountMicro: 1_000 });
    expect(next.railValue.drawMsats).toBe(1_000);
  });

  it("carries the credit's rail identity onto every draw", async () => {
    const { ledger } = await ledgerWithFunding({
      amountMicro: 1_000,
      paidMsats: 1_000,
      nativeAmount: 500,
    });
    const draw = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400 });
    expect(draw.railValue).toMatchObject({
      rail: "cashu",
      nativeAsset: "usdc",
      mint: "https://mint.example",
      fundingRef: "req-1",
      creditCurrency: "usd",
    });
  });

  it("records the settlement instant, and reports it identically on a replay", async () => {
    const { ledger } = await ledgerWithFunding({ amountMicro: 1_000, paidMsats: 1_000 });
    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400 });

    const settled = await ledger.settle({ creditId: "c1", drawId: "d1", nowMs: 1_700_000_000_000 });
    expect(settled.resolvedAt).toBe(1_700_000_000_000);

    const replay = await ledger.settle({ creditId: "c1", drawId: "d1", nowMs: 1_800_000_000_000 });
    expect(replay.replayed).toBe(true);
    expect(replay.resolvedAt).toBe(1_700_000_000_000);
  });

  it("refuses a top-up on a different rail than the credit was funded on", async () => {
    const { ledger } = await ledgerWithFunding({ amountMicro: 1_000, paidMsats: 1_000 });

    await expect(
      ledger.fund({
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500,
        expiryMs: FUTURE_MS,
        basis: { rail: "x402", paidMsats: 500, nativeAmount: 5, nativeAsset: "usdc" },
      })
    ).rejects.toMatchObject({ code: "rail_mismatch" });

    const snap = await ledger.get("c1");
    expect(snap?.balanceMicro).toBe(1_000);
  });

  it("accepts a same-rail top-up and pools its rail value", async () => {
    const { ledger } = await ledgerWithFunding({ amountMicro: 1_000, paidMsats: 1_000 });
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 3_000, fundingRef: "req-2" },
    });

    const draw = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 2_000 });
    expect(draw.railValue.drawMsats).toBe(4_000);
    expect(draw.railValue.fundingRef).toBe("req-2");
  });

});

/*
 * FIFO deposit pricing replaces the pooled hold forecast at settlement. Revenue correction
 * and reclaim must account for the same funded sats.
 */
describe("one sats authority on a multi-rate Bitcoin credit", () => {
  /** 1,000 sats buys $1.00, then the rate halves and 500 sats buys the next $1.00. */
  const CHEAP_MICRO = 1_000_000;
  const CHEAP_SATS = 1_000;
  const DEAR_MICRO = 1_000_000;
  const DEAR_SATS = 500;
  const FUNDED_SATS = CHEAP_SATS + DEAR_SATS;

  async function twoRateCredit(): Promise<MemoryCreditLedger> {
    const ledger = new MemoryCreditLedger();
    const basis = (paidMsats: number, ref: string): CreditFundingBasis => ({
      rail: "cashu",
      paidMsats,
      mint: "https://mint.example",
      fundingRef: ref,
    });
    // Separate funding instants so random lot_id tie order cannot change which rate depletes
    // first.
    const openedAt = Date.now();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: CHEAP_MICRO,
      expiryMs: FUTURE_MS,
      basis: basis(CHEAP_SATS * 1_000, "req-1"),
      nowMs: openedAt,
    });
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: DEAR_MICRO,
      expiryMs: FUTURE_MS,
      basis: basis(DEAR_SATS * 1_000, "req-2"),
      nowMs: openedAt + 1_000,
    });
    return ledger;
  }

  it("books each settled draw at the deposit it consumed, not at the blend", async () => {
    const ledger = await twoRateCredit();

    const first = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 600_000 });
    // The hold is still a forecast off the pooled remainder: 1,500 sats over
    // $2.00 of balance, so 600,000 micro looks like 450 sats.
    expect(first.railValue.drawMsats).toBe(450_000);
    const firstSettled = await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(firstSettled.railValue.drawMsats).toBe(600_000);

    // The second draw straddles both deposits: 400,000 micro left of the first
    // at 1,000 sats/$1.00, then 300,000 of the second at 500 sats/$1.00.
    await ledger.draw({ creditId: "c1", drawId: "d2", amountMicro: 700_000 });
    const secondSettled = await ledger.settle({ creditId: "c1", drawId: "d2" });
    expect(secondSettled.railValue.drawMsats).toBe(400_000 + 150_000);

    const reread = await ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(reread?.railValue.drawMsats).toBe(600_000);
    // The superseded forecast rides beside it: `bookRevenue` corrects the
    // job's counter by `paidMsats − allocatedMsats + drawMsats`, so it needs
    // to know what it is replacing rather than replacing the whole figure.
    expect(reread?.allocatedMsats).toBe(450_000);
  });

  it("closes: settled draw sats plus reclaimed sats equal the sats funded", async () => {
    const ledger = await twoRateCredit();

    let bookedSats = 0;
    for (const [drawId, amountMicro] of [
      ["d1", 600_000],
      ["d2", 700_000],
    ] as const) {
      await ledger.draw({ creditId: "c1", drawId, amountMicro });
      const settled = await ledger.settle({ creditId: "c1", drawId });
      bookedSats += settled.railValue.drawMsats / 1_000;
    }

    const { drain } = await ledger.requestDrain({
      creditId: "c1",
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: `02${"cd".repeat(32)}` },
    });

    expect(drain.amountMicro).toBe(700_000);
    // 350 sats of lot obligation shed, published net of the flat delivery
    // reserve the caller pays to have it handed back.
    expect(drain.owedSats).toBe(350 - DRAIN_DELIVERY_RESERVE_SATS);
    expect(bookedSats + (drain.owedSats ?? 0) + DRAIN_DELIVERY_RESERVE_SATS).toBe(FUNDED_SATS);
  });

  it("keeps the pooled figure where the lots cannot price the draw", async () => {
    // A credit funded before a rail basis was recorded has a lot that honestly
    // says zero sats. The reclaim falls back to a live rate there, and the
    // settle has to fall back with it rather than booking nothing.
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 900, fundingRef: "req-1" },
    });

    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400_000 });
    const settled = await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(settled.railValue.drawMsats).toBe(360);
    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.allocatedMsats).toBe(360);
  });

  it("re-prices a draw whose pooled forecast has already clamped to zero", async () => {
    // The shape a legacy multi-rate credit arrives in on an upgraded host —
    // the fixture's JSDoc carries why it can no longer be reached forwards.
    const ledger = await twoRateCredit();
    clampPooledRailValueToZero(ledger, "c1");

    const held = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 600_000 });
    expect(held.railValue.drawMsats).toBe(0);

    const settled = await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(settled.railValue.drawMsats).toBe(600_000);
    // Zero is a real superseded figure, not an absent one, and it is what
    // tells `bookRevenue` there is nothing in the job's counter to subtract.
    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.allocatedMsats).toBe(0);
  });

  it("leaves a rail with no lots on the pooled allocation", async () => {
    // x402 is in kind structurally — the escrow keeps the unused value — so it
    // writes no lots and nothing re-prices its draws.
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 1_000_000, nativeAmount: 1_000, nativeAsset: "usdc" },
    });

    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400_000 });
    const settled = await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(settled.railValue.drawMsats).toBe(400_000);
    expect(settled.railValue.drawNative).toBe(400);
  });
});

describe("earned native by x402 channel", () => {
  const CHANNEL = `0x${"7c".repeat(32)}`;

  async function channelCredit(): Promise<MemoryCreditLedger> {
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1_100,
        nativeAmount: 1_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: CHANNEL, maxClaimableAmount: "1000" },
      },
    });
    return ledger;
  }

  it("counts settled draws and nothing else", async () => {
    const ledger = await channelCredit();
    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(0);

    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400 });
    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(0);

    await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(400);

    await ledger.draw({ creditId: "c1", drawId: "d2", amountMicro: 100 });
    await ledger.release({ creditId: "c1", drawId: "d2" });
    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(400);
  });

  it("is unaffected by a drain, which earns nothing", async () => {
    const ledger = await channelCredit();
    await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: 400 });
    await ledger.settle({ creditId: "c1", drawId: "d1" });
    await ledger.requestDrain({
      creditId: "c1",
      drainId: "drain-1",
      callerPubkey: CALLER,
      method: "x402",
      payout: { channel_id: CHANNEL },
    });

    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(400);
  });

  it("separates an unbound channel from one that has earned zero", async () => {
    const ledger = await channelCredit();
    expect(await ledger.earnedNativeForX402Channel(CHANNEL)).toBe(0);
    expect(await ledger.earnedNativeForX402Channel(`0x${"7d".repeat(32)}`)).toBeUndefined();
  });
});
