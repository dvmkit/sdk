import { describe, expect, it } from "vitest";

import type { CreditFundingBasis, CreditLedgerLike } from "../../credit-ledger.js";
import { TEST_FUNDING_BASIS } from "./credit-fixtures.js";

/**
 * Register the collection-read contract every shipping `CreditLedgerLike`
 * implementation must satisfy.
 *
 * Each case creates its state through the public interface. The factory may
 * return one fresh in-memory ledger per case or a Postgres ledger whose outer
 * suite clears the tables after each case.
 */
export function describeCreditLedgerConformance(
  makeLedger: () => CreditLedgerLike | Promise<CreditLedgerLike>
): void {
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
