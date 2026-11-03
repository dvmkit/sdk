import { describe, expect, it } from "vitest";

import type { CreditFundingBasis, CreditLedgerLike } from "../../credit-ledger.js";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../../credit-lots.js";
import { TEST_FUNDING_BASIS } from "./credit-fixtures.js";

/**
 * Register the funding-expiry and collection-read contracts every shipping `CreditLedgerLike`
 * implementation must satisfy.
 *
 * Each case creates its state through the public interface. The factory may
 * return one fresh in-memory ledger per case or a Postgres ledger whose outer
 * suite clears the tables after each case.
 */
export function describeCreditLedgerConformance(
  makeLedger: () => CreditLedgerLike | Promise<CreditLedgerLike>
): void {
  describe("CreditLedgerLike funding-expiry conformance", () => {
    it("retains a persisted 30-day expiry until top-up and never shortens a longer expiry", async () => {
      const ledger = await makeLedger();
      const funding = {
        creditId: "contract-expiry",
        callerPubkey: CALLER_A,
        currency: "usd",
        amountMicro: 100_000,
        basis: TEST_FUNDING_BASIS,
      };
      await ledger.fund({ ...funding, expiryMs: 2_592_001_000, nowMs: 1_000 });

      expect(await ledger.get(funding.creditId, { nowMs: 2_678_401_000 })).toMatchObject({
        expiryMs: 2_592_001_000,
        expired: true,
      });
      await expect(ledger.draw({ creditId: funding.creditId, drawId: "expired-draw",
        amountMicro: 1, nowMs: 2_678_401_000 })).rejects.toMatchObject({ code: "credit_expired" });

      expect(await ledger.fund({ ...funding, expiryMs: 10_454_401_000, nowMs: 2_678_401_000 }))
        .toMatchObject({ expiryMs: 10_454_401_000, expired: false, balanceMicro: 200_000 });
      expect(await ledger.fund({ ...funding, expiryMs: 5_270_401_000, nowMs: 2_678_401_000 }))
        .toMatchObject({ expiryMs: 10_454_401_000, balanceMicro: 300_000 });
      expect((await ledger.get(funding.creditId, { nowMs: 2_678_401_000 }))?.expiryMs)
        .toBe(10_454_401_000);
    });
  });

  describe("CreditLedgerLike partial draw settlement conformance", () => {
    it("settles part of a hold from the oldest Cashu lot first and releases the rest to the credit", async () => {
      const ledger = await makeLedger();
      // 500 micro bought 500 sats, then 500 micro bought 1,000 sats.
      await fund(ledger, "contract-partial-lots", {
        amountMicro: 500,
        basis: { rail: "cashu", paidMsats: 500_000, fundingRef: "lot-cheap" },
        nowMs: 1_000,
      });
      await fund(ledger, "contract-partial-lots", {
        amountMicro: 500,
        basis: { rail: "cashu", paidMsats: 1_000_000, fundingRef: "lot-dear" },
        nowMs: 2_000,
      });
      await ledger.draw({ creditId: "contract-partial-lots", drawId: "job", amountMicro: 1_000, jobId: "job" });

      const settled = await resolveDraw(ledger)({ creditId: "contract-partial-lots", drawId: "job", settleMicro: 600 });

      // 500 micro from the cheap lot (500 sats) and 100 from the dear one (200 sats).
      expect(settled).toMatchObject({
        status: "settled",
        replayed: false,
        amountMicro: 600,
        availableMicro: 400,
        railValue: { drawMsats: 700_000, drawNative: null },
        partialSettle: { heldMicro: 1_000, releasedMicro: 400, releasedNative: null },
      });
      expect(await ledger.getDraw({ creditId: "contract-partial-lots", drawId: "job" })).toMatchObject({
        status: "settled",
        amountMicro: 600,
        allocatedMsats: 1_500_000,
        railValue: { drawMsats: 700_000 },
      });
      expect(await ledger.get("contract-partial-lots")).toMatchObject({ balanceMicro: 400, availableMicro: 400 });
      expect(
        (await ledger.listFundingLots("contract-partial-lots")).map((lot) => [lot.fundingRef, lot.remainingMicro])
      ).toEqual([["lot-dear", 400]]);
      // The released 400 is reclaimable at the rate of the lot still holding it.
      const reclaim = await ledger.requestDrain({
        creditId: "contract-partial-lots",
        drainId: "reclaim",
        callerPubkey: CALLER_A,
        method: "cashu",
        payout: {},
      });
      expect(reclaim.drain).toMatchObject({ amountMicro: 400, owedSats: 800 - DRAIN_DELIVERY_RESERVE_SATS });
    });

    it("replays the recorded figure, refuses any other, and replays the placement against the hold", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-partial-replay", { amountMicro: 10_000 });
      await ledger.draw({ creditId: "contract-partial-replay", drawId: "job", amountMicro: 1_000, jobId: "job" });
      const args = { creditId: "contract-partial-replay", drawId: "job" };
      const first = await resolveDraw(ledger)({ ...args, settleMicro: 600 });

      const replay = await resolveDraw(ledger)({ ...args, settleMicro: 600 });
      expect(replay).toEqual({ ...first, replayed: true });
      for (const refused of [
        () => resolveDraw(ledger)({ ...args, settleMicro: 700 }),
        () => resolveDraw(ledger)({ ...args, settleMicro: 0 }),
        () => ledger.settle(args),
        () => ledger.release(args),
      ]) {
        await expect(refused()).rejects.toMatchObject({
          code: "invalid_draw_state",
          details: { currentStatus: "settled", settledMicro: 600 },
        });
      }
      await expect(resolveDraw(ledger)({ ...args, settleMicro: 1_001 })).rejects.toMatchObject({
        code: "invalid_amount",
      });
      expect(await ledger.get("contract-partial-replay")).toMatchObject({
        balanceMicro: 9_400,
        availableMicro: 9_400,
      });

      await expect(
        ledger.draw({ ...args, amountMicro: 1_000, jobId: "job" })
      ).resolves.toMatchObject({ replayed: true, status: "settled", amountMicro: 600 });
      await expect(ledger.draw({ ...args, amountMicro: 600, jobId: "job" })).rejects.toMatchObject({
        code: "draw_conflict",
        details: { expectedAmountMicro: 1_000 },
      });
    });

    it("treats zero as a release and the whole hold as a settle", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-partial-ends", { amountMicro: 10_000 });
      await ledger.draw({ creditId: "contract-partial-ends", drawId: "nothing", amountMicro: 1_000 });
      await ledger.draw({ creditId: "contract-partial-ends", drawId: "all", amountMicro: 2_000 });

      const released = await resolveDraw(ledger)({ creditId: "contract-partial-ends", drawId: "nothing", settleMicro: 0 });
      expect(released).toMatchObject({ status: "released", amountMicro: 1_000 });
      expect(released).not.toHaveProperty("partialSettle");
      await expect(ledger.release({ creditId: "contract-partial-ends", drawId: "nothing" }))
        .resolves.toMatchObject({ replayed: true, status: "released" });

      const whole = await resolveDraw(ledger)({ creditId: "contract-partial-ends", drawId: "all", settleMicro: 2_000 });
      expect(whole).toMatchObject({ status: "settled", amountMicro: 2_000 });
      expect(whole).not.toHaveProperty("partialSettle");
      await expect(ledger.settle({ creditId: "contract-partial-ends", drawId: "all" }))
        .resolves.toMatchObject({ replayed: true, status: "settled" });
      expect(await ledger.get("contract-partial-ends")).toMatchObject({ balanceMicro: 8_000, availableMicro: 8_000 });
    });

    it("refuses a figure it cannot settle and leaves the hold pending", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-partial-invalid", { amountMicro: 10_000 });
      await ledger.draw({ creditId: "contract-partial-invalid", drawId: "job", amountMicro: 1_000 });
      for (const settleMicro of [-1, 0.5, Number.NaN, 1_001]) {
        await expect(
          resolveDraw(ledger)({ creditId: "contract-partial-invalid", drawId: "job", settleMicro })
        ).rejects.toMatchObject({ code: "invalid_amount" });
      }
      expect(await ledger.getDraw({ creditId: "contract-partial-invalid", drawId: "job" })).toMatchObject({
        status: "pending",
        amountMicro: 1_000,
      });
      expect(await ledger.get("contract-partial-invalid")).toMatchObject({ balanceMicro: 10_000, availableMicro: 9_000 });
    });

    it("keeps the released part of a card credit owed back to the card", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-partial-card", {
        amountMicro: 1_000_000,
        basis: { rail: "stripe", paidMsats: 0, nativeAsset: "usd-cents", nativeAmount: 100, fundingRef: "pi_partial" },
      });
      await ledger.draw({ creditId: "contract-partial-card", drawId: "job", amountMicro: 1_000_000 });
      await resolveDraw(ledger)({ creditId: "contract-partial-card", drawId: "job", settleMicro: 600_000 });

      const refund = await ledger.requestDrain({
        creditId: "contract-partial-card",
        drainId: "to-card",
        callerPubkey: CALLER_A,
        method: "stripe",
        payout: {},
      });
      expect(refund.drain).toMatchObject({ method: "stripe", amountMicro: 400_000 });
      expect(refund.credit).toMatchObject({ balanceMicro: 0, availableMicro: 0 });
      // The refund planner sizes each charge from the drain; the charge that funded it is still there.
      expect((await ledger.listFundingLots("contract-partial-card")).map((lot) => lot.fundingRef))
        .toEqual(["pi_partial"]);
    });

    it.each(["whole", "partial"] as const)("releases a %s settlement on a terminalized x402 credit", async (mode) => {
      const ledger = await makeLedger();
      const channel = channelId("d");
      const creditId = "contract-closed-x402";
      const draw = { creditId, drawId: "held" };
      await fund(ledger, creditId, {
        amountMicro: 2_000,
        basis: {
          rail: "x402",
          paidMsats: 0,
          nativeAmount: 2_000,
          nativeAsset: "usdc",
          x402Channel: { channelId: channel, maxClaimableAmount: "2000" },
        },
      });
      await ledger.draw({ ...draw, amountMicro: 1_000 });
      await ledger.terminalizeX402Credit({
        channelId: channel,
        channelBalanceNative: 0n,
        totalClaimedNative: 0n,
      });

      const settle = () => mode === "whole"
        ? ledger.settle(draw)
        : resolveDraw(ledger)({ ...draw, settleMicro: 600 });
      expect(await settle()).toMatchObject({ status: "released", amountMicro: 1_000, replayed: false });
      expect(await settle()).toMatchObject({ status: "released", amountMicro: 1_000, replayed: true });
      expect(await ledger.getDraw(draw)).toMatchObject({ status: "released", amountMicro: 1_000 });
      expect(await ledger.get(creditId)).toMatchObject({
        status: "unbacked",
        balanceMicro: 2_000,
        availableMicro: 0,
        nativeAvailable: 0,
      });
      expect(await ledger.earnedNativeForX402Channel(channel)).toBe(0);
    });

    it("replays a settled x402 draw after terminalization and refuses a different figure", async () => {
      const ledger = await makeLedger();
      const channel = channelId("e");
      const creditId = "contract-settled-closed-x402";
      const draw = { creditId, drawId: "settled" };
      await fund(ledger, creditId, {
        amountMicro: 2_000,
        basis: {
          rail: "x402",
          paidMsats: 0,
          nativeAmount: 2_000,
          nativeAsset: "usdc",
          x402Channel: { channelId: channel, maxClaimableAmount: "2000" },
        },
      });
      await ledger.draw({ ...draw, amountMicro: 1_000 });
      await ledger.settle(draw);
      await ledger.terminalizeX402Credit({
        channelId: channel,
        channelBalanceNative: 1_000n,
        totalClaimedNative: 1_000n,
      });

      await expect(ledger.settle(draw)).resolves.toMatchObject({ status: "settled", replayed: true });
      await expect(resolveDraw(ledger)({ ...draw, settleMicro: 1_000 }))
        .resolves.toMatchObject({ status: "settled", replayed: true, amountMicro: 1_000 });
      await expect(resolveDraw(ledger)({ ...draw, settleMicro: 600 }))
        .rejects.toMatchObject({ code: "invalid_draw_state" });
    });

    it("earns an x402 channel only the settled part of a draw", async () => {
      const ledger = await makeLedger();
      const channel = channelId("c");
      await fund(ledger, "contract-partial-x402", {
        amountMicro: 1_000,
        basis: {
          rail: "x402",
          paidMsats: 0,
          nativeAmount: 1_000,
          nativeAsset: "usdc",
          x402Channel: { channelId: channel, maxClaimableAmount: "1000" },
        },
      });
      await ledger.draw({ creditId: "contract-partial-x402", drawId: "job", amountMicro: 1_000 });
      const settled = await resolveDraw(ledger)({ creditId: "contract-partial-x402", drawId: "job", settleMicro: 600 });

      expect(settled).toMatchObject({
        railValue: { drawNative: 600 },
        partialSettle: { heldMicro: 1_000, releasedMicro: 400, releasedNative: 400 },
      });
      expect(await ledger.earnedNativeForX402Channel(channel)).toBe(600);
      expect(await ledger.get("contract-partial-x402")).toMatchObject({ availableMicro: 400, nativeAvailable: 400 });
    });
  });

  describe("CreditLedgerLike collection-read conformance", () => {
    it("filters pending invoices by caller, status, credit, and limit", async () => {
      const ledger = await makeLedger();
      await issueInvoice(ledger, {
        creditId: "contract-invoice-a",
        fundId: "fund-a",
        callerPubkey: CALLER_A,
        nowMs: 1_000,
      });
      await issueInvoice(ledger, {
        creditId: "contract-invoice-b",
        fundId: "fund-b",
        callerPubkey: CALLER_A,
        nowMs: 2_000,
      });
      await issueInvoice(ledger, {
        creditId: "contract-invoice-other",
        fundId: "fund-other",
        callerPubkey: CALLER_B,
        nowMs: 500,
      });
      await issueInvoice(ledger, {
        creditId: "contract-invoice-expired",
        fundId: "fund-expired",
        callerPubkey: CALLER_A,
        nowMs: 750,
      });
      await ledger.markInvoiceExpired({
        creditId: "contract-invoice-expired",
        fundId: "fund-expired",
      });

      await expect(
        ledger.listPendingInvoices({ callerPubkey: CALLER_A, limit: 10 })
      ).resolves.toMatchObject([{ fundId: "fund-a" }, { fundId: "fund-b" }]);
      await expect(
        ledger.listPendingInvoices({
          callerPubkey: CALLER_A,
          creditId: "contract-invoice-b",
          limit: 10,
        })
      ).resolves.toMatchObject([{ fundId: "fund-b" }]);
      await expect(
        ledger.listPendingInvoices({ callerPubkey: CALLER_A, limit: 1 })
      ).resolves.toMatchObject([{ fundId: "fund-a" }]);
    });

    it("filters and keyset-pages the blocked-invoice queue", async () => {
      const ledger = await makeLedger();
      for (const [creditId, fundId] of [
        ["contract-blocked-a", "fund-a"],
        ["contract-blocked-a", "fund-b"],
        ["contract-blocked-b", "fund-a"],
      ] as const) {
        await issueInvoice(ledger, {
          creditId,
          fundId,
          callerPubkey: CALLER_A,
          nowMs: 1_000,
        });
        await ledger.markInvoiceBlocked({
          creditId,
          fundId,
          reason: "operator_required",
        });
      }
      await issueInvoice(ledger, {
        creditId: "contract-blocked-pending",
        fundId: "fund-pending",
        callerPubkey: CALLER_A,
        nowMs: 500,
      });
      await ledger.writeOffBlockedInvoice({
        paymentHash: paymentHash("contract-blocked-a", "fund-b"),
        note: "resolved",
        nowMs: 2_000,
      });

      const live = await ledger.listBlockedInvoices({ limit: 10 });
      expect(live.map((invoice) => `${invoice.creditId}:${invoice.fundId}`)).toEqual([
        "contract-blocked-a:fund-a",
        "contract-blocked-b:fund-a",
      ]);

      const first = await ledger.listBlockedInvoices({ limit: 1, includeResolved: true });
      expect(first.map((invoice) => `${invoice.creditId}:${invoice.fundId}`)).toEqual([
        "contract-blocked-a:fund-a",
      ]);
      const second = await ledger.listBlockedInvoices({
        limit: 1,
        includeResolved: true,
        after: {
          createdAt: first[0].createdAt,
          creditId: first[0].creditId,
          fundId: first[0].fundId,
        },
      });
      expect(second.map((invoice) => `${invoice.creditId}:${invoice.fundId}`)).toEqual([
        "contract-blocked-a:fund-b",
      ]);
      const third = await ledger.listBlockedInvoices({
        limit: 1,
        includeResolved: true,
        after: {
          createdAt: second[0].createdAt,
          creditId: second[0].creditId,
          fundId: second[0].fundId,
        },
      });
      expect(third.map((invoice) => `${invoice.creditId}:${invoice.fundId}`)).toEqual([
        "contract-blocked-b:fund-a",
      ]);
    });

    it("lists one caller's credits oldest first", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-caller-a-later", {
        callerPubkey: CALLER_A,
        nowMs: 2_000,
      });
      await fund(ledger, "contract-caller-other", {
        callerPubkey: CALLER_B,
        nowMs: 500,
      });
      await fund(ledger, "contract-caller-a-first", {
        callerPubkey: CALLER_A,
        nowMs: 1_000,
      });

      const credits = await ledger.getForCaller(CALLER_A, { nowMs: 3_000 });
      expect(credits.map((credit) => credit.creditId)).toEqual([
        "contract-caller-a-first",
        "contract-caller-a-later",
      ]);
    });

    it("lists only one credit's pending draws in ledger order", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-pending-draws-a");
      await fund(ledger, "contract-pending-draws-b");
      await ledger.draw({
        creditId: "contract-pending-draws-a",
        drawId: "pending-first",
        amountMicro: 1_000,
        nowMs: 1_000,
      });
      await ledger.draw({
        creditId: "contract-pending-draws-a",
        drawId: "settled",
        amountMicro: 1_000,
        nowMs: 2_000,
      });
      await ledger.settle({ creditId: "contract-pending-draws-a", drawId: "settled" });
      await ledger.draw({
        creditId: "contract-pending-draws-a",
        drawId: "released",
        amountMicro: 1_000,
        nowMs: 3_000,
      });
      await ledger.release({ creditId: "contract-pending-draws-a", drawId: "released" });
      await ledger.draw({
        creditId: "contract-pending-draws-a",
        drawId: "pending-second",
        amountMicro: 1_000,
        nowMs: 4_000,
      });
      await ledger.draw({
        creditId: "contract-pending-draws-b",
        drawId: "other-credit",
        amountMicro: 1_000,
        nowMs: 500,
      });

      const pending = await ledger.listPendingDraws("contract-pending-draws-a");
      expect(pending.map((draw) => draw.drawId)).toEqual(["pending-first", "pending-second"]);
      expect(pending.map((draw) => draw.ledgerSeq)).toEqual([1, 4]);
    });

    it("filters and keyset-pages stale pending draws on their full order key", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-stale-a");
      await fund(ledger, "contract-stale-b");
      await ledger.draw({
        creditId: "contract-stale-a",
        drawId: "resolved",
        amountMicro: 1_000,
        nowMs: 500,
      });
      await ledger.settle({ creditId: "contract-stale-a", drawId: "resolved" });
      await ledger.draw({
        creditId: "contract-stale-a",
        drawId: "a-first",
        amountMicro: 1_000,
        jobId: "job-a-first",
        nowMs: 1_000,
      });
      await ledger.draw({
        creditId: "contract-stale-a",
        drawId: "a-second",
        amountMicro: 1_000,
        jobId: "job-a-second",
        nowMs: 1_000,
      });
      await ledger.draw({
        creditId: "contract-stale-b",
        drawId: "b-first",
        amountMicro: 1_000,
        nowMs: 1_000,
      });
      await ledger.draw({
        creditId: "contract-stale-b",
        drawId: "fresh",
        amountMicro: 1_000,
        jobId: "job-fresh",
        nowMs: 5_000,
      });

      const first = await ledger.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 2 });
      expect(first.map((draw) => draw.drawId)).toEqual(["a-first", "a-second"]);
      const rest = await ledger.listStalePendingDraws({
        createdBeforeMs: 5_000,
        limit: 10,
        after: first[1],
      });
      expect(rest.map((draw) => draw.drawId)).toEqual(["b-first"]);
      expect(rest[0].jobId).toBeNull();
      await expect(
        ledger.listStalePendingDraws({
          createdBeforeMs: 5_000,
          limit: 10,
          after: rest[0],
        })
      ).resolves.toEqual([]);
    });

    it("lists Tempo credit losses newest first and honours the limit", async () => {
      const ledger = await makeLedger();
      await fundTempoChannel(ledger, "contract-tempo-loss-old", channelId("1"), 10_000);
      await fundTempoChannel(ledger, "contract-tempo-loss-new", channelId("2"), 10_000);
      await terminalize(ledger, channelId("1"), 1_000);
      await terminalize(ledger, channelId("2"), 2_000);

      await expect(ledger.listTempoCreditLosses({ limit: 1 })).resolves.toMatchObject([
        { creditId: "contract-tempo-loss-new", observedAt: 2_000 },
      ]);
      const all = await ledger.listTempoCreditLosses({ limit: 10 });
      expect(all.map((loss) => loss.creditId)).toEqual([
        "contract-tempo-loss-new",
        "contract-tempo-loss-old",
      ]);
    });

    it("lists only one credit's undepleted funding lots oldest first", async () => {
      const ledger = await makeLedger();
      await fund(ledger, "contract-lots", {
        amountMicro: 1_000,
        basis: lightningBasis(1_000, "lot-first"),
        nowMs: 1_000,
      });
      await fund(ledger, "contract-lots", {
        amountMicro: 2_000,
        basis: lightningBasis(2_000, "lot-second"),
        nowMs: 2_000,
      });
      await fund(ledger, "contract-lots", {
        amountMicro: 3_000,
        basis: lightningBasis(3_000, "lot-third"),
        nowMs: 3_000,
      });
      await fund(ledger, "contract-lots-other", {
        amountMicro: 4_000,
        basis: lightningBasis(4_000, "lot-other"),
        nowMs: 500,
      });
      await ledger.draw({
        creditId: "contract-lots",
        drawId: "deplete-first",
        amountMicro: 1_000,
      });
      await ledger.settle({ creditId: "contract-lots", drawId: "deplete-first" });

      const lots = await ledger.listFundingLots("contract-lots");
      expect(lots.map((lot) => lot.fundingRef)).toEqual(["lot-second", "lot-third"]);
      expect(lots.map((lot) => lot.createdAt)).toEqual([2_000, 3_000]);
      expect(lots.every((lot) => lot.creditId === "contract-lots")).toBe(true);
      await expect(ledger.listFundingLots("contract-lots-missing")).resolves.toEqual([]);
    });

    it("lists only pending drains oldest first", async () => {
      const ledger = await makeLedger();
      for (const [creditId, drainId, nowMs] of [
        ["contract-pending-drain-later", "later", 2_000],
        ["contract-pending-drain-first", "first", 1_000],
        ["contract-pending-drain-sent", "sent", 500],
      ] as const) {
        await fund(ledger, creditId, { basis: tempoChargeBasis(10_000) });
        await ledger.requestDrain({
          creditId,
          drainId,
          callerPubkey: CALLER_A,
          method: "x402",
          payout: { address: ADDRESS },
          nowMs,
        });
      }
      await ledger.markDrainSent({
        creditId: "contract-pending-drain-sent",
        drainId: "sent",
        sentRef: { tx_hash: "0xsent" },
      });

      const pending = await ledger.listPendingDrains();
      expect(pending.map((drain) => drain.drainId)).toEqual(["first", "later"]);
      expect(pending.map((drain) => drain.callerPubkey)).toEqual([CALLER_A, CALLER_A]);
    });

    /**
     * Build every row through `requestDrain`: if the durable query regresses
     * to the retired `mpp` spelling, it cannot accidentally agree with a
     * hand-written fixture and the eligible rows below disappear.
     */
    it("filters and keyset-pages the stale Tempo channel-drain queue", async () => {
      const ledger = await makeLedger();
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-eligible-a",
        drainId: "eligible-a-1",
        channelId: channelId("3"),
        nowMs: 1_000,
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-eligible-a",
        drainId: "eligible-a-2",
        channelId: channelId("3"),
        nowMs: 1_000,
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-eligible-b",
        drainId: "a-before-cursor",
        channelId: channelId("4"),
        nowMs: 1_000,
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-wrong-method",
        drainId: "wrong-method",
        channelId: channelId("5"),
        method: "x402",
        nowMs: 500,
      });
      await fund(ledger, "contract-channel-no-binding", {
        basis: tempoChargeBasis(10_000),
      });
      await ledger.requestDrain({
        creditId: "contract-channel-no-binding",
        drainId: "no-binding",
        callerPubkey: CALLER_A,
        method: "tempo",
        payout: {},
        nowMs: 500,
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-fresh",
        drainId: "fresh",
        channelId: channelId("6"),
        nowMs: 6_000,
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-sent",
        drainId: "sent",
        channelId: channelId("7"),
        nowMs: 500,
      });
      await ledger.markDrainSent({
        creditId: "contract-channel-sent",
        drainId: "sent",
        sentRef: { tx_hash: "0xclose" },
      });
      await requestChannelDrain(ledger, {
        creditId: "contract-channel-written-off",
        drainId: "written-off",
        channelId: channelId("8"),
        nowMs: 750,
      });
      await ledger.writeOffDrain({
        creditId: "contract-channel-written-off",
        drainId: "written-off",
        note: "short refund",
        nowMs: 3_000,
      });

      const first = await ledger.listChannelDrains({
        limit: 1,
        createdBeforeMs: 5_000,
        rail: "tempo",
      });
      expect(first.map((drain) => drain.drainId)).toEqual(["eligible-a-1"]);
      const second = await ledger.listChannelDrains({
        limit: 1,
        createdBeforeMs: 5_000,
        rail: "tempo",
        after: first[0],
      });
      expect(second.map((drain) => drain.drainId)).toEqual(["eligible-a-2"]);
        const third = await ledger.listChannelDrains({
        limit: 1,
        createdBeforeMs: 5_000,
        rail: "tempo",
        after: second[0],
      });
      expect(third.map((drain) => drain.drainId)).toEqual(["a-before-cursor"]);

      const audit = await ledger.listChannelDrains({
        limit: 10,
        createdBeforeMs: 5_000,
        rail: "tempo",
        includeResolved: true,
      });
      expect(audit.map((drain) => drain.drainId).sort()).toEqual([
        "a-before-cursor",
        "eligible-a-1",
        "eligible-a-2",
        "written-off",
      ]);
    });
  });
}

function resolveDraw(ledger: CreditLedgerLike): CreditLedgerLike["resolveDraw"] {
  return ledger.resolveDraw.bind(ledger);
}

const CALLER_A = "11".repeat(32);
const CALLER_B = "22".repeat(32);
const ADDRESS = `0x${"ab".repeat(20)}`;
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1_000;

async function fund(
  ledger: CreditLedgerLike,
  creditId: string,
  overrides: {
    callerPubkey?: string;
    amountMicro?: number;
    basis?: CreditFundingBasis;
    nowMs?: number;
  } = {}
): Promise<void> {
  await ledger.fund({
    creditId,
    callerPubkey: overrides.callerPubkey ?? CALLER_A,
    currency: "usd",
    amountMicro: overrides.amountMicro ?? 10_000,
    expiryMs: FUTURE_MS,
    basis: overrides.basis ?? TEST_FUNDING_BASIS,
    nowMs: overrides.nowMs,
  });
}

async function issueInvoice(
  ledger: CreditLedgerLike,
  args: { creditId: string; fundId: string; callerPubkey: string; nowMs: number }
): Promise<void> {
  await ledger.recordInvoice({
    ...args,
    currency: "usd",
    amountMicro: 300_000,
    amountMsats: 300_000,
    paymentHash: paymentHash(args.creditId, args.fundId),
    bolt11: `lnbcrt-${args.creditId}-${args.fundId}`,
    expiresAt: FUTURE_MS,
  });
}

function paymentHash(creditId: string, fundId: string): string {
  return `hash:${creditId}:${fundId}`;
}

function lightningBasis(paidMsats: number, fundingRef: string): CreditFundingBasis {
  return { rail: "lightning", paidMsats, fundingRef };
}

function tempoChargeBasis(amountMicro: number): CreditFundingBasis {
  return {
    rail: "tempo",
    paidMsats: 0,
    nativeAmount: amountMicro,
    nativeAsset: "pathUSD",
  };
}

function tempoChannelBasis(channel: string, amountMicro: number): CreditFundingBasis {
  return {
    ...tempoChargeBasis(amountMicro),
    fundingRef: "0xopen",
    tempoSession: { channelId: channel, cumulativeAmount: String(amountMicro) },
  };
}

async function fundTempoChannel(
  ledger: CreditLedgerLike,
  creditId: string,
  channel: string,
  amountMicro: number
): Promise<void> {
  await fund(ledger, creditId, {
    amountMicro,
    basis: tempoChannelBasis(channel, amountMicro),
  });
}

async function terminalize(
  ledger: CreditLedgerLike,
  channel: string,
  observedAt: number
): Promise<void> {
  await ledger.terminalizeTempoCredits({
    channelId: channel,
    settledOnChainNative: 0n,
    highestVoucherNative: 1n,
    consumedNative: 0n,
    observedAt,
  });
}

async function requestChannelDrain(
  ledger: CreditLedgerLike,
  args: {
    creditId: string;
    drainId: string;
    channelId: string;
    method?: "tempo" | "x402";
    nowMs: number;
  }
): Promise<void> {
  await fundTempoChannel(ledger, args.creditId, args.channelId, 10_000);
  await ledger.requestDrain({
    creditId: args.creditId,
    drainId: args.drainId,
    callerPubkey: CALLER_A,
    method: args.method ?? "tempo",
    payout: args.method === "x402" ? { address: ADDRESS } : {},
    nowMs: args.nowMs,
  });
}

function channelId(nibble: string): string {
  return `0x${nibble.repeat(64)}`;
}
