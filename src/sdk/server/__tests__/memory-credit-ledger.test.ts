import { describe, expect, it } from "vitest";

import { type CreditFundingBasis, CreditLedgerError } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { fundCredit, removeFundingLots } from "./__helpers__/credit-fixtures";
import { describeCreditLedgerConformance } from "./__helpers__/credit-ledger-conformance";

const CALLER = "ab".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

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

function make(): MemoryCreditLedger {
  return new MemoryCreditLedger();
}

async function fund(ledger: MemoryCreditLedger, amountMicro: number, expiryMs = FUTURE_MS) {
  return fundCredit(ledger, { callerPubkey: CALLER, currency: "usd", amountMicro, expiryMs });
}

describe("MemoryCreditLedger", () => {
  describeCreditLedgerConformance(make);

  it("refuses fresh balance growth after expiry while preserving accepted rail growth", async () => {
    const ledger = make();
    const credit = await fund(ledger, 10_000, 2_000);
    await ledger.draw({ creditId: credit.creditId, drawId: "draw", amountMicro: 2_000, nowMs: 1_000 });
    await expectCode(ledger.growDraw({ creditId: credit.creditId, drawId: "draw", addAmountMicro: 1_000,
      spendExistingBalance: true, nowMs: 3_000 }), "credit_expired");
    expect((await ledger.getDraw({ creditId: credit.creditId, drawId: "draw" }))?.amountMicro).toBe(2_000);
    await ledger.growDraw({ creditId: credit.creditId, drawId: "draw", addAmountMicro: 1_000, nowMs: 3_000 });
    expect((await ledger.getDraw({ creditId: credit.creditId, drawId: "draw" }))?.amountMicro).toBe(3_000);
  });

  it("requires a durable Tempo lifecycle for fresh balance growth without blocking accepted rail growth", async () => {
    const ledger = make();
    const credit = await ledger.fund({ callerPubkey: CALLER, currency: "usd", amountMicro: 10_000,
      expiryMs: FUTURE_MS, basis: { rail: "tempo", paidMsats: 1, nativeAmount: 10_000,
        nativeAsset: "pathUSD", tempoSession: { channelId: `0x${"92".repeat(32)}`, cumulativeAmount: "10000" } } });
    await ledger.draw({ creditId: credit.creditId, drawId: "draw", amountMicro: 2_000 });
    await expectCode(ledger.growDraw({ creditId: credit.creditId, drawId: "draw", addAmountMicro: 1_000,
      spendExistingBalance: true }), "tempo_channel_closing");
    expect((await ledger.getDraw({ creditId: credit.creditId, drawId: "draw" }))?.amountMicro).toBe(2_000);
    await ledger.growDraw({ creditId: credit.creditId, drawId: "draw", addAmountMicro: 1_000 });
    expect((await ledger.getDraw({ creditId: credit.creditId, drawId: "draw" }))?.amountMicro).toBe(3_000);
  });

  it("terminalizes every credit whose Tempo backing finalized below its accepted voucher", async () => {
    const ledger = make();
    const channelId = `0x${"91".repeat(32)}`;
    const credit = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "100000" },
      },
    });
    await ledger.draw({ creditId: credit.creditId, drawId: "served", amountMicro: 3_000 });
    await ledger.settle({ creditId: credit.creditId, drawId: "served" });
    await ledger.draw({ creditId: credit.creditId, drawId: "in-flight", amountMicro: 2_000 });

    const first = await ledger.terminalizeTempoCredits({
      channelId,
      settledOnChainNative: 0n,
      highestVoucherNative: 3_000n,
      consumedNative: 3_000n,
      observedAt: 123,
    });
    expect(first).toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        formerBalanceMicro: 97_000,
        consumedServiceMicro: 3_000,
        settledOnChainNative: 0n,
        highestVoucherNative: 3_000n,
        refundedToPayerNative: null,
        lossNative: 3_000n,
        lossBasis: "caller_asserted",
        observedAt: 123,
      }),
    ]);
    expect(await ledger.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 97_000,
      availableMicro: 0,
      nativeAvailable: 0,
    });

    const released = await ledger.settle({ creditId: credit.creditId, drawId: "in-flight" });
    expect(released).toMatchObject({ status: "released", availableMicro: 0 });
    await expect(
      ledger.settle({ creditId: credit.creditId, drawId: "served" })
    ).resolves.toMatchObject({ status: "settled", replayed: true, availableMicro: 0 });
    await expectCode(
      ledger.draw({ creditId: credit.creditId, drawId: "later", amountMicro: 1 }),
      "credit_unbacked"
    );
    await expectCode(
      ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "no-refund",
        callerPubkey: CALLER,
        method: "tempo",
        payout: { address: `0x${"11".repeat(20)}` },
      }),
      "credit_unbacked"
    );
    await expect(
      ledger.terminalizeTempoCredits({
        channelId,
        settledOnChainNative: 0n,
        highestVoucherNative: 3_000n,
        consumedNative: 3_000n,
      })
    ).resolves.toEqual(first);
  });

  it("subtracts only verified cooperative refunds from permanent Tempo loss", async () => {
    const ledger = make();
    const channelId = `0x${"93".repeat(32)}`;
    const credit = await ledger.fund({ callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
      expiryMs: FUTURE_MS, basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000,
        tempoSession: { channelId, cumulativeAmount: "100000" } } });
    const evidence = { channelId, highestVoucherNative: 100_000n, settledOnChainNative: 30_000n, consumedNative: 30_000n };
    expect(await ledger.terminalizeTempoCredits({ ...evidence, refundedToPayerNative: 70_000n })).toEqual([]);
    expect(await ledger.get(credit.creditId)).toMatchObject({ status: "active" });
    const losses = await ledger.terminalizeTempoCredits({ ...evidence, refundedToPayerNative: 20_000n });
    expect(losses).toEqual([expect.objectContaining({ settledOnChainNative: 30_000n, refundedToPayerNative: 20_000n, lossNative: 50_000n })]);
    expect(await ledger.get(credit.creditId)).toMatchObject({ status: "unbacked" });
    expect(await ledger.terminalizeTempoCredits({ ...evidence, refundedToPayerNative: 70_000n })).toEqual(losses);
  });

  it("limits payer-exit loss to consumed service and keeps the refund amount unknown", async () => {
    const ledger = make();
    const channelId = `0x${"94".repeat(32)}`;
    const credit = await ledger.fund({ callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
      expiryMs: FUTURE_MS, basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000,
        tempoSession: { channelId, cumulativeAmount: "100000" } } });
    const evidence = { channelId, highestVoucherNative: 100_000n, settledOnChainNative: 30_000n,
      consumedNative: 30_000n, closeKind: "payer_exit" as const };
    expect(await ledger.terminalizeTempoCredits(evidence)).toEqual([]);
    expect(await ledger.get(credit.creditId)).toMatchObject({ status: "active" });
    expect(await ledger.terminalizeTempoCredits({ ...evidence, consumedNative: 50_000n })).toEqual([
      expect.objectContaining({ lossNative: 20_000n, lossBasis: "payer_exit", refundedToPayerNative: null }),
    ]);
  });

  it("terminalizes an x402 credit after its channel backing exits", async () => {
    const ledger = make();
    const channelId = `0x${"92".repeat(32)}`;
    const credit = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "100000" },
      },
    });
    await ledger.draw({ creditId: credit.creditId, drawId: "served", amountMicro: 3_000 });
    await ledger.settle({ creditId: credit.creditId, drawId: "served" });

    const first = await ledger.terminalizeX402Credit({
      channelId,
      channelBalanceNative: 3_000n,
      totalClaimedNative: 3_000n,
      observedAt: 123,
    });
    expect(first).toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        formerBalanceMicro: 97_000,
        consumedServiceMicro: 3_000,
        observedAt: 123,
      }),
    ]);
    expect(await ledger.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 97_000,
      availableMicro: 0,
      nativeAvailable: 0,
    });
    await expect(
      ledger.terminalizeX402Credit({
        channelId,
        channelBalanceNative: 4_000n,
        totalClaimedNative: 4_000n,
      })
    ).resolves.toEqual(first);
  });

  it("funds, draws with gap-free seq, and computes available under pending holds", async () => {
    const ledger = make();
    const { creditId } = await fund(ledger, 100_000);
    const d1 = await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });
    const d2 = await ledger.draw({ creditId, drawId: "d2", amountMicro: 30_000 });
    expect([d1.ledgerSeq, d2.ledgerSeq]).toEqual([1, 2]);
    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(100_000);
    expect(snap?.availableMicro).toBe(40_000);
    await expectCode(
      ledger.draw({ creditId, drawId: "d3", amountMicro: 50_000 }),
      "insufficient_credit"
    );
  });

  it("replays a draw idempotently; a mismatched replay is draw_conflict", async () => {
    const ledger = make();
    const { creditId } = await fund(ledger, 100_000);
    const first = await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });
    const replay = await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });
    expect(replay.replayed).toBe(true);
    expect(replay.ledgerSeq).toBe(first.ledgerSeq);
    await expectCode(
      ledger.draw({ creditId, drawId: "d1", amountMicro: 20_000, jobId: "j1" }),
      "draw_conflict"
    );
    await expectCode(
      ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j2" }),
      "draw_conflict"
    );
  });

  it("replay survives expiry; fresh draws on an expired credit are refused", async () => {
    const ledger = make();
    const { creditId } = await fund(ledger, 100_000, Date.now() + 50);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000 });
    const replay = await ledger.draw({
      creditId,
      drawId: "d1",
      amountMicro: 10_000,
      nowMs: Date.now() + 1_000_000,
    });
    expect(replay.replayed).toBe(true);
    await expectCode(
      ledger.draw({ creditId, drawId: "d2", amountMicro: 1, nowMs: Date.now() + 1_000_000 }),
      "credit_expired"
    );
  });

  it("settle debits; release restores; both idempotent; cross-state refused", async () => {
    const ledger = make();
    const { creditId } = await fund(ledger, 100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });
    await ledger.draw({ creditId, drawId: "d2", amountMicro: 20_000 });

    const settled = await ledger.settle({ creditId, drawId: "d1" });
    expect(settled.status).toBe("settled");
    expect(settled.availableMicro).toBe(50_000);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(70_000);
    const again = await ledger.settle({ creditId, drawId: "d1" });
    expect(again.replayed).toBe(true);
    await expectCode(ledger.release({ creditId, drawId: "d1" }), "invalid_draw_state");

    const released = await ledger.release({ creditId, drawId: "d2" });
    expect(released.status).toBe("released");
    expect(released.availableMicro).toBe(70_000);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(70_000);
    await expectCode(ledger.settle({ creditId, drawId: "d2" }), "invalid_draw_state");
  });

  it("top-up adds balance and revives an expired credit; identity mismatches refused", async () => {
    const ledger = make();
    const snap = await fund(ledger, 10_000, Date.now() + 10);
    const revived = await fundCredit(ledger, {
      creditId: snap.creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 5_000,
      expiryMs: FUTURE_MS,
      nowMs: Date.now() + 1_000,
    });
    expect(revived.balanceMicro).toBe(15_000);
    expect(revived.expired).toBe(false);
    await expectCode(
      fundCredit(ledger, {
        creditId: snap.creditId,
        callerPubkey: "cd".repeat(32),
        currency: "usd",
        amountMicro: 1,
        expiryMs: FUTURE_MS,
      }),
      "caller_mismatch"
    );
    await expectCode(
      fundCredit(ledger, {
        creditId: snap.creditId,
        callerPubkey: CALLER,
        currency: "eur",
        amountMicro: 1,
        expiryMs: FUTURE_MS,
      }),
      "currency_mismatch"
    );
  });

  it("keeps one-shot MPP charges and Tempo session funding on distinct credits", async () => {
    const ledger = make();
    const base = {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    };
    const charge = await ledger.fund({
      ...base,
      basis: { rail: "tempo", paidMsats: 1, nativeAmount: 10_000, nativeAsset: "pathUSD" },
    });
    await expectCode(
      ledger.fund({
        ...base,
        creditId: charge.creditId,
        basis: {
          rail: "tempo",
          paidMsats: 1,
          nativeAmount: 10_000,
          nativeAsset: "pathUSD",
          tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "10000" },
        },
      }),
      "rail_mismatch"
    );

    const session = await ledger.fund({
      ...base,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 10_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: `0x${"22".repeat(32)}`, cumulativeAmount: "10000" },
      },
    });
    await expectCode(
      ledger.fund({
        ...base,
        creditId: session.creditId,
        basis: { rail: "tempo", paidMsats: 1, nativeAmount: 10_000, nativeAsset: "pathUSD" },
      }),
      "rail_mismatch"
    );
  });

  it("names the credit that already owns an x402 channel", async () => {
    const ledger = make();
    const channelId = `0x${"77".repeat(32)}`;
    await ledger.fund({
      creditId: "bound-credit",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 10_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "10000" },
      },
    });

    await expect(
      ledger.fund({
        creditId: "fresh-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 10_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 10_000,
          nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "20000" },
        },
      })
    ).rejects.toMatchObject({
      code: "rail_mismatch",
      details: {
        expectedRail: "x402",
        expectedInstrument: "x402_channel",
        expectedChannelId: channelId,
        boundCreditId: "bound-credit",
      },
    });
  });

  it("keeps one-shot x402 exact and batch-settlement channel funding on distinct credits", async () => {
    const ledger = make();
    const channelId = `0x${"88".repeat(32)}`;
    const base = {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    };
    const exactBasis: CreditFundingBasis = {
      rail: "x402",
      paidMsats: 1,
      nativeAmount: 10_000,
      nativeAsset: "usdc",
    };

    const exact = await ledger.fund({ ...base, basis: exactBasis });
    await expect(
      ledger.fund({
        ...base,
        creditId: exact.creditId,
        basis: { ...exactBasis, x402Channel: { channelId, maxClaimableAmount: "10000" } },
      })
    ).rejects.toMatchObject({
      code: "rail_mismatch",
      details: {
        expectedRail: "x402",
        expectedInstrument: "x402_exact",
        expectedChannelId: null,
      },
    });
    const afterRefusal = await ledger.get(exact.creditId);
    expect(afterRefusal?.balanceMicro).toBe(10_000);
    expect(afterRefusal?.x402ChannelId).toBeNull();

    const channel = await ledger.fund({
      ...base,
      basis: { ...exactBasis, x402Channel: { channelId, maxClaimableAmount: "10000" } },
    });
    await expect(
      ledger.fund({ ...base, creditId: channel.creditId, basis: exactBasis })
    ).rejects.toMatchObject({
      code: "rail_mismatch",
      details: {
        expectedRail: "x402",
        expectedInstrument: "x402_channel",
        expectedChannelId: channelId,
      },
    });
    expect((await ledger.get(channel.creditId))?.balanceMicro).toBe(10_000);
  });

  // The Postgres upsert's `ON CONFLICT … WHERE` refuses before the write can
  // reach `credits_x402_channel_uidx`, so the target credit's own binding is
  // what answers — the channel's other owner never comes up. This ledger
  // orders its two checks the same way.
  it("diagnoses the target credit's own binding before the channel's other owner", async () => {
    const ledger = make();
    const channelId = `0x${"77".repeat(32)}`;
    const base = {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    };
    const exactBasis: CreditFundingBasis = {
      rail: "x402",
      paidMsats: 1,
      nativeAmount: 10_000,
      nativeAsset: "usdc",
    };
    const channelBasis: CreditFundingBasis = {
      ...exactBasis,
      x402Channel: { channelId, maxClaimableAmount: "10000" },
    };

    await ledger.fund({ ...base, creditId: "channel-credit", basis: channelBasis });
    await ledger.fund({ ...base, creditId: "exact-credit", basis: exactBasis });

    const err = await expectCode(
      ledger.fund({ ...base, creditId: "exact-credit", basis: channelBasis }),
      "rail_mismatch"
    );
    expect(err.details).toMatchObject({ expectedInstrument: "x402_exact" });
    expect(err.details).not.toHaveProperty("boundCreditId");

    await expect(
      ledger.fund({ ...base, creditId: "fresh-credit", basis: channelBasis })
    ).rejects.toMatchObject({ details: { boundCreditId: "channel-credit" } });
  });

  it("keeps a channel's claim ceiling free of draws it never funded", async () => {
    const ledger = make();
    const channelId = `0x${"99".repeat(32)}`;
    const exact = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 5_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 1, nativeAmount: 5_000, nativeAsset: "usdc" },
    });
    await ledger.draw({ creditId: exact.creditId, drawId: "d1", amountMicro: 5_000 });
    await ledger.settle({ creditId: exact.creditId, drawId: "d1" });

    await expectCode(
      ledger.fund({
        creditId: exact.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 3_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 3_000,
          nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "3000" },
        },
      }),
      "rail_mismatch"
    );

    expect(await ledger.earnedNativeForX402Channel(channelId)).toBeUndefined();
  });

  it("settle/release never check expiry — a pre-expiry hold can always resolve", async () => {
    const ledger = make();
    const { creditId } = await fund(ledger, 100_000, Date.now() + 50);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000 });
    const res = await ledger.settle({ creditId, drawId: "d1", nowMs: Date.now() + 1_000_000 });
    expect(res.status).toBe("settled");
  });

  it("validates amounts and expiry like the Postgres ledger", async () => {
    const ledger = make();
    await expectCode(
      fundCredit(ledger, {
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 0,
        expiryMs: FUTURE_MS,
      }),
      "invalid_amount"
    );
    await expectCode(
      fundCredit(ledger, { callerPubkey: CALLER, currency: "usd", amountMicro: 10, expiryMs: 0 }),
      "invalid_expiry"
    );
    const { creditId } = await fund(ledger, 10_000);
    await expectCode(ledger.draw({ creditId, drawId: "d", amountMicro: -1 }), "invalid_amount");
    // Zero-amount draws are legal (a free job under a credit still gets a seq'd entry).
    const zero = await ledger.draw({ creditId, drawId: "d0", amountMicro: 0 });
    expect(zero.ledgerSeq).toBe(1);
    await expectCode(
      ledger.draw({ creditId: "missing", drawId: "d", amountMicro: 1 }),
      "credit_not_found"
    );
    await expectCode(ledger.settle({ creditId, drawId: "nope" }), "draw_not_found");
  });

  it("refuses a missing or unknown-rail basis with invalid_basis, not a TypeError", async () => {
    // These invalid basis shapes are reachable from JavaScript despite the TypeScript
    // signature; the typed refusal must replace a TypeError or silent write.
    const ledger = make();
    const base = { callerPubkey: CALLER, currency: "usd", amountMicro: 10, expiryMs: FUTURE_MS };
    const noBasis = base as Parameters<MemoryCreditLedger["fund"]>[0];
    await expectCode(ledger.fund(noBasis), "invalid_basis");
    await expectCode(
      ledger.fund({
        ...base,
        basis: { rail: "solana", paidMsats: 100 } as unknown as CreditFundingBasis,
      }),
      "invalid_basis"
    );
    await expectCode(
      ledger.fund({ ...base, basis: { rail: "cashu", paidMsats: -1 } }),
      "invalid_basis"
    );
  });

  describe("drains", () => {
    const PAYOUT = { refund_pubkey: "02" + "cd".repeat(32) };

    it("retains the debit through a terminal Tempo refusal and permits one confirmed refund", async () => {
      const ledger = make();
      const channelId = `0x${"91".repeat(32)}`;
      const credit = await ledger.fund({ callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
        expiryMs: FUTURE_MS, basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000,
          tempoSession: { channelId, cumulativeAmount: "100000" } } });
      await ledger.requestDrain({ creditId: credit.creditId, drainId: "d1", callerPubkey: CALLER,
        method: "tempo", payout: {} });
      expect((await ledger.requireTempoDrainExit({ creditId: credit.creditId, drainId: "d1" })).replayed).toBe(false);
      expect((await ledger.requireTempoDrainExit({ creditId: credit.creditId, drainId: "d1" })).replayed).toBe(true);
      expect(await ledger.get(credit.creditId)).toMatchObject({ balanceMicro: 0, nativeAvailable: 0 });
      expect(await ledger.listPendingDrains()).toEqual([expect.objectContaining({ status: "exit_required" })]);
      expect(await ledger.listChannelDrains({ limit: 10, createdBeforeMs: Date.now(), rail: "tempo" }))
        .toEqual([expect.objectContaining({ status: "exit_required" })]);
      const sent = await ledger.markDrainSent({ creditId: credit.creditId, drainId: "d1", sentRef: { tx_hash: "test-refund" } });
      expect(sent).toMatchObject({ replayed: false, drain: { status: "sent" } });
      expect((await ledger.markDrainSent({ creditId: credit.creditId, drainId: "d1", sentRef: {} })).replayed).toBe(true);
      expect(await ledger.get(credit.creditId)).toMatchObject({ balanceMicro: 0 });
    });

    it("retains exact and some-payment Tempo drain evidence monotonically without accounting changes", async () => {
      const ledger = make();
      const channelId = `0x${"93".repeat(32)}`;
      const credit = await ledger.fund({ callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
        expiryMs: FUTURE_MS, basis: { rail: "tempo", paidMsats: 0, nativeAmount: 100_000,
          tempoSession: { channelId, cumulativeAmount: "100000" } } });
      const args = { creditId: credit.creditId, drainId: "d1" };
      await ledger.requestDrain({ ...args, callerPubkey: CALLER, method: "tempo", payout: {} });
      const balance = await ledger.get(credit.creditId);
      expect(await ledger.getDrain(args)).toMatchObject({ provenRefundNative: null, refundPaymentProven: false });
      await ledger.recordTempoDrainRefund({ ...args, refundedNative: 0n });
      expect(await ledger.getDrain(args)).toMatchObject({ status: "pending", provenRefundNative: "0", refundPaymentProven: false });
      await ledger.recordTempoDrainPayment(args);
      expect(await ledger.getDrain(args)).toMatchObject({ provenRefundNative: "0", refundPaymentProven: true });
      await ledger.recordTempoDrainRefund({ ...args, refundedNative: 9_007_199_254_740_993n });
      await ledger.recordTempoDrainRefund({ ...args, refundedNative: "0" });
      await ledger.recordTempoDrainPayment(args);
      expect(await ledger.getDrain(args)).toMatchObject({ status: "pending", provenRefundNative: "9007199254740993", refundPaymentProven: true });
      expect(await ledger.get(credit.creditId)).toEqual(balance);
      await expectCode(ledger.recordTempoDrainRefund({ ...args, refundedNative: -1n }), "invalid_basis");
      await ledger.markDrainSent({ ...args, sentRef: { tx_hash: "test-refund" } });
      await ledger.recordTempoDrainRefund({ ...args, refundedNative: "9007199254740994" });
      expect(await ledger.getDrain(args)).toMatchObject({ status: "sent", provenRefundNative: "9007199254740993", refundPaymentProven: true });
    });

    it("drains available balance exactly once, takes a seq, replays idempotently", async () => {
      const ledger = make();
      const { creditId } = await fund(ledger, 100_000);
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 30_000 });

      const first = await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      expect(first.replayed).toBe(false);
      expect(first.drain).toMatchObject({
        amountMicro: 70_000,
        balanceAfterMicro: 30_000,
        status: "pending",
        ledgerSeq: 2,
        currency: "usd",
      });
      expect(first.credit.balanceMicro).toBe(30_000);
      expect(first.credit.availableMicro).toBe(0);

      const replay = await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.drain.amountMicro).toBe(70_000);
      expect(replay.drain.balanceAfterMicro).toBe(30_000);
      expect((await ledger.get(creditId))?.balanceMicro).toBe(30_000);

      await expectCode(
        ledger.requestDrain({
          creditId,
          drainId: "d1",
          callerPubkey: CALLER,
          method: "cashu",
          payout: { refund_pubkey: "03" + "ee".repeat(32) },
        }),
        "drain_conflict"
      );
      await expectCode(
        ledger.requestDrain({
          creditId,
          drainId: "d2",
          callerPubkey: CALLER,
          method: "cashu",
          payout: PAYOUT,
        }),
        "nothing_to_drain"
      );
      await expectCode(
        ledger.requestDrain({
          creditId,
          drainId: "d3",
          callerPubkey: "ff".repeat(32),
          method: "cashu",
          payout: PAYOUT,
        }),
        "caller_mismatch"
      );
    });

    it("drains an expired credit — expiry never gates reclaim", async () => {
      const ledger = make();
      const { creditId } = await fund(ledger, 40_000, Date.now() - 1);
      const result = await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "x402",
        payout: { address: `0x${"ab".repeat(20)}` },
      });
      expect(result.drain.amountMicro).toBe(40_000);
      expect(result.credit.balanceMicro).toBe(0);
    });

    it("takes the rail-value remainder with the fiat — later draws can't over-allocate", async () => {
      const ledger = make();
      const snap = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 500_000_000 },
      });
      const creditId = snap.creditId;
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 100_000 });
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      await ledger.release({ creditId, drawId: "w1" });
      const w2 = await ledger.draw({ creditId, drawId: "w2", amountMicro: 100_000 });
      expect(w2.railValue.drawMsats).toBe(100_000_000);
    });

    it("atomically refuses a channel drain while a draw is pending", async () => {
      const ledger = make();
      const { creditId } = await fund(ledger, 100_000);
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 10_000 });
      await expectCode(
        ledger.requestDrain({
          creditId,
          drainId: "d1",
          callerPubkey: CALLER,
          method: "tempo",
          payout: {},
          requireNoPending: true,
        }),
        "drain_conflict"
      );
      expect(await ledger.getDrain({ creditId, drainId: "d1" })).toBeUndefined();
      expect((await ledger.get(creditId))?.balanceMicro).toBe(100_000);
    });

    it("releases an unpaid channel drain with its exact rail basis, once", async () => {
      const ledger = make();
      const funded = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 7_000,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const requested = await ledger.requestDrain({
        creditId: funded.creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "tempo",
        payout: {},
        requireNoPending: true,
      });
      expect(requested.credit.balanceMicro).toBe(0);

      const released = await ledger.releaseDrain({ creditId: funded.creditId, drainId: "d1" });
      expect(released.replayed).toBe(false);
      expect(released.drain).toMatchObject({ status: "released", releasedAt: expect.any(Number) });
      expect(released.credit).toMatchObject({ balanceMicro: 100_000, availableMicro: 100_000 });

      const replay = await ledger.releaseDrain({ creditId: funded.creditId, drainId: "d1" });
      expect(replay.replayed).toBe(true);
      const draw = await ledger.draw({
        creditId: funded.creditId,
        drawId: "after-release",
        amountMicro: 100_000,
      });
      expect(draw.railValue).toMatchObject({ drawMsats: 7_000, drawNative: 100_000 });
    });

    it("walks park → picked_up with token-keyed idempotency", async () => {
      const ledger = make();
      const { creditId } = await fund(ledger, 40_000);
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      await expectCode(
        ledger.markDrainPickedUp({ creditId, drainId: "d1" }),
        "invalid_drain_state"
      );
      const parked = await ledger.parkDrain({ creditId, drainId: "d1", token: "cashuB1" });
      expect(parked.status).toBe("parked");
      expect((await ledger.parkDrain({ creditId, drainId: "d1", token: "cashuB1" })).status).toBe(
        "parked"
      );
      await expectCode(
        ledger.parkDrain({ creditId, drainId: "d1", token: "cashuB2" }),
        "drain_conflict"
      );
      const picked = await ledger.markDrainPickedUp({ creditId, drainId: "d1" });
      expect(picked.drain.status).toBe("picked_up");
      expect(picked.replayed).toBe(false);
      const rePicked = await ledger.markDrainPickedUp({ creditId, drainId: "d1" });
      expect(rePicked.drain.status).toBe("picked_up");
      expect(rePicked.replayed).toBe(true);
      await expectCode(
        ledger.markDrainSent({ creditId, drainId: "d1", sentRef: {} }),
        "drain_conflict"
      );
      await expectCode(
        ledger.parkDrain({ creditId: "ghost", drainId: "d9", token: "t" }),
        "drain_not_found"
      );
    });

    it("marks non-cashu drains sent and refuses the cashu park verbs on them", async () => {
      const ledger = make();
      const { creditId } = await fund(ledger, 40_000);
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "x402",
        payout: { address: `0x${"ab".repeat(20)}` },
      });
      await expectCode(
        ledger.parkDrain({ creditId, drainId: "d1", token: "t" }),
        "invalid_drain_state"
      );
      const sent = await ledger.markDrainSent({
        creditId,
        drainId: "d1",
        sentRef: { preimage: "aa" },
      });
      expect(sent.drain.status).toBe("sent");
      expect(sent.drain.sentRef).toEqual({ preimage: "aa" });
      expect(sent.replayed).toBe(false);
      const reSent = await ledger.markDrainSent({ creditId, drainId: "d1", sentRef: {} });
      expect(reSent.drain.status).toBe("sent");
      expect(reSent.replayed).toBe(true);
    });

    it("appends drain receipts", async () => {
      const ledger = make();
      const credit = await fund(ledger, 20_000);
      await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "d2",
        callerPubkey: CALLER,
        method: "x402",
        payout: { address: `0x${"ab".repeat(20)}` },
      });
      await ledger.appendDrainReceipt({
        creditId: credit.creditId,
        drainId: "d2",
        receipt: { event: "requested" },
      });
      const drain = await ledger.getDrain({ creditId: credit.creditId, drainId: "d2" });
      expect(drain?.receipts).toEqual([{ event: "requested" }]);
    });
  });
  describe("funding lots and the in-kind reclaim", () => {
    const BTC: CreditFundingBasis = { rail: "lightning", paidMsats: 1_151_000 };

    async function btcCredit(
      ledger: MemoryCreditLedger,
      basis: CreditFundingBasis = BTC,
      amountMicro = 1_151_000
    ) {
      return ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro,
        expiryMs: FUTURE_MS,
        basis,
      });
    }

    /*
     * The implicit draw initially holds its funding. Failure releases that hold, so the
     * funding lot must still cover its reclaimable balance.
     */
    it("lots the per-call regime too, because a failed job releases its hold", async () => {
      const ledger = make();
      const credit = await ledger.fund({
        creditId: "imp:cashu:req-1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 3_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 3_000 },
      });
      await ledger.draw({ creditId: credit.creditId, drawId: "req-1", amountMicro: 3_000 });
      await ledger.release({ creditId: credit.creditId, drawId: "req-1" });

      expect(await ledger.listFundingLots(credit.creditId)).toMatchObject([
        { satsFunded: 3, creditedMicro: 3_000, remainingMicro: 3_000 },
      ]);
      const liability = await ledger.bitcoinDepositLiability();
      expect(liability).toMatchObject({ depositSats: 3, uncoveredCredits: 0 });

      await expect(
        ledger.requestDrain({
          creditId: credit.creditId,
          drainId: "r1",
          callerPubkey: CALLER,
          method: "cashu",
          payout: { refund_pubkey: `02${"cd".repeat(32)}` },
        })
      ).rejects.toMatchObject({ code: "drain_below_dust" });

      await ledger.fund({
        creditId: credit.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 100_000 },
      });
      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "r2",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      expect(drain.owedSats).toBe(103 - DRAIN_DELIVERY_RESERVE_SATS);
    });

    it("writes no lot for a channel-backed credit, which is in kind through its escrow", async () => {
      const ledger = make();
      const credit = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          x402Channel: { channelId: `0x${"7c".repeat(32)}`, maxClaimableAmount: "100000" },
        },
      });
      expect(await ledger.listFundingLots(credit.creditId)).toEqual([]);
      expect((await ledger.bitcoinDepositLiability()).depositSats).toBe(0);
    });

    it("depletes lots as draws settle, and not while they are only held", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger);
      await ledger.draw({ creditId: credit.creditId, drawId: "d1", amountMicro: 3_000 });
      expect(await ledger.listFundingLots(credit.creditId)).toMatchObject([
        { satsFunded: 1_151, creditedMicro: 1_151_000, remainingMicro: 1_151_000, rail: "lightning" },
      ]);

      await ledger.settle({ creditId: credit.creditId, drawId: "d1" });
      expect((await ledger.listFundingLots(credit.creditId))[0].remainingMicro).toBe(1_148_000);

      await ledger.draw({ creditId: credit.creditId, drawId: "d2", amountMicro: 5_000 });
      await ledger.release({ creditId: credit.creditId, drawId: "d2" });
      expect((await ledger.listFundingLots(credit.creditId))[0].remainingMicro).toBe(1_148_000);
    });

    it("owes the deposited sats pro rata, at the rate the funding landed at", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger);
      for (const drawId of ["j1", "j2", "j3"]) {
        await ledger.draw({ creditId: credit.creditId, drawId, amountMicro: 3_000 });
        await ledger.settle({ creditId: credit.creditId, drawId });
      }
      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      // 1,142,000 of 1,151,000 micro, so 1,142 of the 1,151 sats deposited,
      // less the 8-sat delivery reserve the caller carries.
      expect(drain.owedSats).toBe(1_142 - DRAIN_DELIVERY_RESERVE_SATS);
      expect(drain.amountMicro).toBe(1_142_000);
      expect(await ledger.listFundingLots(credit.creditId)).toEqual([]);
    });

    it("prices a top-up at its own rate rather than blending it into the pool", async () => {
      const ledger = make();
      // Separate funding timestamps to make FIFO order independent of random lot_id ties.
      const openedAt = Date.now();
      const credit = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 1_000_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "lightning", paidMsats: 1_000_000 },
        nowMs: openedAt,
      });
      await ledger.fund({
        creditId: credit.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 1_000_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "lightning", paidMsats: 500_000 },
        nowMs: openedAt + 1_000,
      });
      await ledger.draw({ creditId: credit.creditId, drawId: "j1", amountMicro: 1_000_000 });
      await ledger.settle({ creditId: credit.creditId, drawId: "j1" });

      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      expect(drain.owedSats).toBe(500 - DRAIN_DELIVERY_RESERVE_SATS);
    });

    it("refuses a reclaim worth less than one satoshi rather than opening a dead drain", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger);
      await ledger.draw({ creditId: credit.creditId, drawId: "j1", amountMicro: 1_150_500 });
      await ledger.settle({ creditId: credit.creditId, drawId: "j1" });
      await expectCode(
        ledger.requestDrain({
          creditId: credit.creditId,
          drainId: "r1",
          callerPubkey: CALLER,
          method: "cashu",
          payout: { refund_pubkey: `02${"cd".repeat(32)}` },
        }),
        "drain_below_dust"
      );
    });

    it("leaves a credit with no sats basis unpriced, for the live-rate fallback", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger, { rail: "cashu", paidMsats: 0 });
      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      expect(drain.owedSats).toBeNull();
      const liability = await ledger.bitcoinDepositLiability();
      expect(liability.depositSats).toBe(0);
      expect(liability.unbackedCredits).toBe(0);
    });

    /*
     * A basisless legacy lot mixed with a backed top-up makes the entire reclaim use the
     * live-rate fallback, rather than pricing only part of the balance.
     */
    it("keeps a mixed-basis credit out of the in-kind total and flags it whole", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger, { rail: "cashu", paidMsats: 0 }, 40_000);
      await ledger.fund({
        creditId: credit.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 100_000 },
      });

      const liability = await ledger.bitcoinDepositLiability();
      expect(liability).toMatchObject({
        depositSats: 0,
        credits: 1,
        uncoveredCredits: 0,
        unbackedCredits: 1,
        unbackedByCurrency: [{ currency: "usd", micro: 140_000, credits: 1 }],
      });
      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      expect(drain.owedSats).toBeNull();
    });

    it("reports the deposit floor, and drops it as the credit is drawn down", async () => {
      const ledger = make();
      const credit = await btcCredit(ledger);
      expect(await ledger.bitcoinDepositLiability()).toMatchObject({
        depositSats: 1_151,
        credits: 1,
        uncoveredCredits: 0,
        unbackedCredits: 0,
        byRail: [{ rail: "lightning", sats: 1_151, credits: 1 }],
        byCurrency: [{ currency: "usd", micro: 1_151_000, credits: 1 }],
      });

      await ledger.draw({ creditId: credit.creditId, drawId: "j1", amountMicro: 151_000 });
      await ledger.settle({ creditId: credit.creditId, drawId: "j1" });
      expect((await ledger.bitcoinDepositLiability()).depositSats).toBe(1_000);
    });

    it("names a credit whose lots carry no sats basis instead of counting it as nothing", async () => {
      const ledger = make();
      await btcCredit(ledger, { rail: "cashu", paidMsats: 0 });
      expect(await ledger.bitcoinDepositLiability()).toMatchObject({
        depositSats: 0,
        unbackedCredits: 1,
        unbackedByCurrency: [{ currency: "usd", micro: 1_151_000, credits: 1 }],
      });
    });

    it("keeps uncovered and basisless balances in their ledger currencies", async () => {
      const ledger = make();
      for (const [currency, uncovered, basisless] of [
        ["usd", 1_000_000, 200_000],
        ["jpy", 100_000_000, 20_000_000],
      ] as const) {
        const credit = await ledger.fund({
          callerPubkey: CALLER,
          currency,
          amountMicro: uncovered,
          expiryMs: FUTURE_MS,
          basis: { rail: "cashu", paidMsats: 1_000_000 },
        });
        removeFundingLots(ledger, credit.creditId);
        await ledger.fund({
          callerPubkey: CALLER,
          currency,
          amountMicro: basisless,
          expiryMs: FUTURE_MS,
          basis: { rail: "cashu", paidMsats: 0 },
        });
      }

      const liability = await ledger.bitcoinDepositLiability();
      expect(liability).toMatchObject({
        depositSats: 0,
        credits: 4,
        uncoveredCredits: 2,
        unbackedCredits: 2,
        uncoveredByCurrency: [
          { currency: "usd", micro: 1_000_000, credits: 1 },
          { currency: "jpy", micro: 100_000_000, credits: 1 },
        ],
        unbackedByCurrency: [
          { currency: "usd", micro: 200_000, credits: 1 },
          { currency: "jpy", micro: 20_000_000, credits: 1 },
        ],
      });
      expect(liability).not.toHaveProperty("uncoveredMicro");
      expect(liability).not.toHaveProperty("unbackedMicro");
    });
  });
});
