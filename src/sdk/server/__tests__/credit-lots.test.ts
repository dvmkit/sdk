import { describe, expect, it } from "vitest";

import {
  DRAIN_DELIVERY_RESERVE_SATS,
  depleteLots,
  fifoOrder,
  type FundingLot,
  inKindDrawMsats,
  isInKindDepletion,
  isNonChannelBitcoinRail,
  lotOwedSats,
  netOwedSats,
} from "../credit-lots";

function lot(overrides: Partial<FundingLot> = {}): FundingLot {
  return {
    lotId: "lot:a",
    creditId: "c1",
    rail: "lightning",
    satsFunded: 1_151,
    creditedMicro: 1_151_000,
    remainingMicro: 1_151_000,
    fundingRef: null,
    createdAt: 1_000,
    ...overrides,
  };
}

describe("funding lots", () => {
  describe("drain delivery reserve", () => {
    it("holds back eight sats and never publishes a negative payout", () => {
      expect(DRAIN_DELIVERY_RESERVE_SATS).toBe(8);
      expect(netOwedSats(20)).toBe(12);
      expect(netOwedSats(8)).toBe(0);
      expect(netOwedSats(7)).toBe(0);
    });
  });

  describe("rail classification", () => {
    it("names the two rails whose unused credit is a sats deposit", () => {
      expect(isNonChannelBitcoinRail("cashu")).toBe(true);
      expect(isNonChannelBitcoinRail("lightning")).toBe(true);
      expect(isNonChannelBitcoinRail("x402")).toBe(false);
      expect(isNonChannelBitcoinRail("tempo")).toBe(false);
      expect(isNonChannelBitcoinRail(null)).toBe(false);
      expect(isNonChannelBitcoinRail(undefined)).toBe(false);
    });
  });

  describe("single-lot depletion", () => {
    it("owes the untouched share of the sats deposited, not the balance re-priced", () => {
      const drawn = depleteLots([lot()], 9_000);
      expect(drawn.satsOwed).toBe(9);
      expect(drawn.uncoveredMicro).toBe(0);

      const after = [lot({ remainingMicro: 1_151_000 - 9_000 })];
      expect(lotOwedSats(after)).toBe(1_142);
    });



    it("floors to the satoshi and leaves the dust with the provider", () => {
      expect(lotOwedSats([lot({ remainingMicro: 500 })])).toBe(0);
    });

    it("charges a slice what the obligation actually lost, not what the slice floors to", () => {
      // The same 500 micro taken off the *top* of a full lot. Flooring the
      // slice on its own answers 0 — but the remaining 1,150,500 micro then
      // owes 1,150, one satoshi less than the lot took in, and nothing has
      // recorded where that satoshi went. Pricing the slice as the
      // decrement in the obligation puts it on the slice, where it belongs.
      expect(depleteLots([lot()], 500).satsOwed).toBe(1);
      expect(lotOwedSats([lot({ remainingMicro: 1_151_000 - 500 })])).toBe(1_150);
    });

    it("pays out exactly what it took in, however finely it is sliced", () => {
      // The property the whole re-price rests on: a lot drawn down over many
      // jobs and then reclaimed hands back every satoshi it received. An
      // independently floored slice loses up to one per slice, forever.
      const lots = [lot()];
      let paid = 0;
      for (let taken = 0; taken < 1_151_000; taken += 7_777) {
        const slice = Math.min(7_777, 1_151_000 - taken);
        const depletion = depleteLots(lots, slice);
        paid += depletion.satsOwed;
        lots[0] = lot({ remainingMicro: lots[0].remainingMicro - slice });
      }
      expect(paid).toBe(1_151);
      expect(lotOwedSats(lots)).toBe(0);
    });
  });

  describe("multi-lot FIFO", () => {
    /**
     * Two top-ups at very different rates. FIFO matters here and pro rata
     * would not: a draw that empties the first deposit must leave the second
     * one's sats fully owed, at the second one's own rate.
     */
    const cheap = lot({
      lotId: "lot:a",
      satsFunded: 1_000,
      creditedMicro: 1_000_000,
      remainingMicro: 1_000_000,
      createdAt: 1,
    });
    const dear = lot({
      lotId: "lot:b",
      satsFunded: 500,
      creditedMicro: 1_000_000,
      remainingMicro: 1_000_000,
      createdAt: 2,
    });

    it("consumes the oldest lot first", () => {
      const drawn = depleteLots([cheap, dear], 1_000_000);
      expect(drawn.debits).toEqual([{ lotId: "lot:a", micro: 1_000_000, sats: 1_000 }]);
      expect(drawn.satsOwed).toBe(1_000);
    });

    it("spills into the next lot at that lot's own rate", () => {
      const drawn = depleteLots([cheap, dear], 1_500_000);
      expect(drawn.debits).toEqual([
        { lotId: "lot:a", micro: 1_000_000, sats: 1_000 },
        { lotId: "lot:b", micro: 500_000, sats: 250 },
      ]);
      expect(drawn.satsOwed).toBe(1_250);
    });

    it("reports what the lots could not cover rather than inventing a rate for it", () => {
      const drawn = depleteLots([cheap], 1_500_000);
      expect(drawn.satsOwed).toBe(1_000);
      expect(drawn.uncoveredMicro).toBe(500_000);
      expect(isInKindDepletion(drawn, 1_500_000)).toBe(false);
    });

    it("orders by age, breaking a same-millisecond tie on the id", () => {
      const first = lot({ lotId: "lot:a", createdAt: 5 });
      const second = lot({ lotId: "lot:b", createdAt: 5 });
      expect(fifoOrder(first, second)).toBeLessThan(0);
      expect(fifoOrder(second, first)).toBeGreaterThan(0);
      expect(fifoOrder(lot({ createdAt: 9 }), lot({ createdAt: 5 }))).toBeGreaterThan(0);
    });

    it("skips a depleted lot without disturbing the order", () => {
      const spent = lot({ lotId: "lot:a", remainingMicro: 0, createdAt: 1 });
      const drawn = depleteLots([spent, dear], 400_000);
      expect(drawn.debits).toEqual([{ lotId: "lot:b", micro: 400_000, sats: 200 }]);
    });
  });

  describe("what may be settled in kind", () => {
    it("admits a fully covered, fully backed depletion", () => {
      expect(isInKindDepletion(depleteLots([lot()], 9_000), 9_000)).toBe(true);
    });

    it("refuses a lot carrying no sats basis", () => {
      const unbacked = lot({ satsFunded: 0 });
      const drawn = depleteLots([unbacked], 9_000);
      expect(drawn.satsOwed).toBe(0);
      expect(drawn.backedMicro).toBe(0);
      expect(isInKindDepletion(drawn, 9_000)).toBe(false);
    });

    it("refuses a mixture rather than blending one lot's rate with a live one", () => {
      const unbacked = lot({ lotId: "lot:a", satsFunded: 0, creditedMicro: 5_000, createdAt: 1 });
      const backed = lot({
        lotId: "lot:b",
        satsFunded: 100,
        creditedMicro: 100_000,
        remainingMicro: 100_000,
        createdAt: 2,
      });
      const drawn = depleteLots([lot({ ...unbacked, remainingMicro: 5_000 }), backed], 15_000);
      expect(drawn.uncoveredMicro).toBe(0);
      expect(drawn.backedMicro).toBe(10_000);
      expect(isInKindDepletion(drawn, 15_000)).toBe(false);
    });

    it("refuses a zero-value depletion, which owes nothing to nobody", () => {
      expect(isInKindDepletion(depleteLots([lot()], 0), 0)).toBe(false);
    });
  });

  describe("what a settling draw books", () => {
    it("prices the draw at the deposit it consumed, in the ledger's msat unit", () => {
      expect(inKindDrawMsats(depleteLots([lot()], 9_000), 9_000)).toBe(9_000);
    });

    it("prices a draw that spills into a second deposit at both deposits' own rates", () => {
      const cheap = lot({ lotId: "lot:a", satsFunded: 1_000, createdAt: 1 });
      const dear = lot({
        lotId: "lot:b",
        satsFunded: 500,
        creditedMicro: 1_000_000,
        remainingMicro: 1_000_000,
        createdAt: 2,
      });
      expect(
        inKindDrawMsats(
          depleteLots(
            [{ ...cheap, creditedMicro: 1_000_000, remainingMicro: 1_000_000 }, dear],
            1_500_000
          ),
          1_500_000
        )
      ).toBe(1_250_000);
    });

    it("declines wherever the reclaim would, so the two never disagree about the basis", () => {
      expect(inKindDrawMsats(depleteLots([lot()], 2_000_000), 2_000_000)).toBeNull();
      expect(inKindDrawMsats(depleteLots([lot({ satsFunded: 0 })], 9_000), 9_000)).toBeNull();
      expect(inKindDrawMsats(depleteLots([], 9_000), 9_000)).toBeNull();
    });
  });
});
