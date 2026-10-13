import { describe, expect, it } from "vitest";

import { CreditLedgerError } from "../credit-ledger";
import { MemoryCreditLedger } from "../memory-credit-ledger";

const CALLER = "aa".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

/** $0.10 upfront, a $0.05 mid-job top-up, at 1000 msats per cent. */
const UPFRONT_MICRO = 100_000;
const TOPUP_MICRO = 50_000;
const UPFRONT_MSATS = 100_000;
const TOPUP_MSATS = 50_000;

async function fundedLedger(): Promise<MemoryCreditLedger> {
  const ledger = new MemoryCreditLedger();
  await ledger.fund({
    creditId: "c1",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: UPFRONT_MICRO,
    expiryMs: FUTURE_MS,
    basis: { rail: "cashu", paidMsats: UPFRONT_MSATS, fundingRef: "req-upfront" },
  });
  await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: UPFRONT_MICRO, jobId: "job-1" });
  return ledger;
}

async function topUp(
  ledger: MemoryCreditLedger,
  amountMicro = TOPUP_MICRO,
  paidMsats = TOPUP_MSATS
) {
  await ledger.fund({
    creditId: "c1",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro,
    expiryMs: FUTURE_MS,
    basis: { rail: "cashu", paidMsats, fundingRef: "req-topup" },
  });
  return ledger.growDraw({
    creditId: "c1",
    drawId: "d1",
    addAmountMicro: amountMicro,
    jobId: "job-1",
  });
}

async function expectLedgerError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(CreditLedgerError);
  await promise.catch((err: unknown) => {
    expect((err as CreditLedgerError).code).toBe(code);
  });
}

describe("growDraw", () => {
  it("adds the top-up to the job's existing draw and keeps its ledger_seq", async () => {
    const ledger = await fundedLedger();
    const before = await ledger.getDraw({ creditId: "c1", drawId: "d1" });

    const grown = await topUp(ledger);

    expect(grown.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    expect(grown.addedAmountMicro).toBe(TOPUP_MICRO);
    expect(grown.ledgerSeq).toBe(before?.ledgerSeq);
    expect(grown.balanceAfterMicro).toBe(0);
    expect(grown.status).toBe("pending");

    const after = await ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(after?.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    expect(after?.jobId).toBe("job-1");
  });

  it("allocates the increment's rail value so the draw totals what both legs paid", async () => {
    const ledger = await fundedLedger();
    const grown = await topUp(ledger);

    expect(grown.addedRailValue.drawMsats).toBe(TOPUP_MSATS);
    expect(grown.railValue.drawMsats).toBe(UPFRONT_MSATS + TOPUP_MSATS);

    const settled = await ledger.settle({ creditId: "c1", drawId: "d1" });
    expect(settled).toMatchObject({
      amountMicro: UPFRONT_MICRO + TOPUP_MICRO, status: "settled", balanceAfterMicro: 0,
    });
    const credit = await ledger.get("c1");
    expect(credit?.balanceMicro).toBe(0);
  });

  it("releases the grown total on failure — no debit, including the top-up", async () => {
    const ledger = await fundedLedger();
    await topUp(ledger);

    const released = await ledger.release({ creditId: "c1", drawId: "d1" });
    expect(released.status).toBe("released");
    expect(released.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    expect(released.availableMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("refuses to grow a resolved draw — the receipt already attested it", async () => {
    const ledger = await fundedLedger();
    await ledger.settle({ creditId: "c1", drawId: "d1" });
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS },
    });

    await expectLedgerError(
      ledger.growDraw({ creditId: "c1", drawId: "d1", addAmountMicro: TOPUP_MICRO }),
      "invalid_draw_state"
    );
  });

  it("refuses to grow beyond the balance the top-up actually funded", async () => {
    const ledger = await fundedLedger();
    await expectLedgerError(
      ledger.growDraw({ creditId: "c1", drawId: "d1", addAmountMicro: TOPUP_MICRO }),
      "insufficient_credit"
    );
  });

  it("refuses to grow another job's draw", async () => {
    const ledger = await fundedLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS },
    });

    await expectLedgerError(
      ledger.growDraw({
        creditId: "c1",
        drawId: "d1",
        addAmountMicro: TOPUP_MICRO,
        jobId: "job-other",
      }),
      "draw_conflict"
    );
  });

  it("refuses an unknown draw", async () => {
    const ledger = await fundedLedger();
    await expectLedgerError(
      ledger.growDraw({ creditId: "c1", drawId: "nope", addAmountMicro: 1 }),
      "draw_not_found"
    );
  });

  it("grows a draw on an expired credit — the job was accepted pre-expiry", async () => {
    const ledger = new MemoryCreditLedger();
    const soon = Date.now() + 50;
    await ledger.fund({
      creditId: "c2",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: UPFRONT_MICRO,
      expiryMs: soon,
      basis: { rail: "cashu", paidMsats: UPFRONT_MSATS },
    });
    await ledger.draw({ creditId: "c2", drawId: "d1", amountMicro: UPFRONT_MICRO, jobId: "job-2" });
    // Pass a post-expiry nowMs to growth; the hold was accepted before expiry.
    await ledger.fund({
      creditId: "c2",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: soon,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS },
    });

    const grown = await ledger.growDraw({
      creditId: "c2",
      drawId: "d1",
      addAmountMicro: TOPUP_MICRO,
      nowMs: soon + 10_000,
    });
    expect(grown.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("leaves a sibling job's pending hold untouched", async () => {
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c3",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 3 * UPFRONT_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 3 * UPFRONT_MSATS },
    });
    await ledger.draw({ creditId: "c3", drawId: "d1", amountMicro: UPFRONT_MICRO, jobId: "job-a" });
    await ledger.draw({ creditId: "c3", drawId: "d2", amountMicro: UPFRONT_MICRO, jobId: "job-b" });

    const grown = await ledger.growDraw({
      creditId: "c3",
      drawId: "d1",
      addAmountMicro: UPFRONT_MICRO,
    });

    expect(grown.amountMicro).toBe(2 * UPFRONT_MICRO);
    expect(grown.balanceAfterMicro).toBe(0);
    const sibling = await ledger.getDraw({ creditId: "c3", drawId: "d2" });
    expect(sibling?.amountMicro).toBe(UPFRONT_MICRO);
    expect(sibling?.railValue.drawMsats).toBe(UPFRONT_MSATS);
  });
});

/*
 * A blended pool differs from the incoming top-up’s earmark after an FX change; the job’s
 * paid delta must use what that top-up paid.
 */
async function driftedCredit(): Promise<MemoryCreditLedger> {
  const ledger = new MemoryCreditLedger();
  await ledger.fund({
    creditId: "c5",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 1_000_000,
    expiryMs: FUTURE_MS,
    basis: { rail: "cashu", paidMsats: 900_000, fundingRef: "req-first" },
  });
  await ledger.draw({ creditId: "c5", drawId: "sib", amountMicro: 500_000, jobId: "job-sib" });
  await ledger.draw({ creditId: "c5", drawId: "d1", amountMicro: 100_000, jobId: "job-1" });
  return ledger;
}

describe("growth earmarks the rail value that funded it", () => {
  it("credits the full ask on a credit whose micro:msat ratio has drifted", async () => {
    const ledger = await driftedCredit();
    await ledger.fund({
      creditId: "c5",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 55_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 50_000, fundingRef: "req-topup" },
    });

    const grown = await ledger.growDraw({
      creditId: "c5",
      drawId: "d1",
      addAmountMicro: 55_000,
      addRailValue: { drawMsats: 50_000, drawNative: null },
      jobId: "job-1",
    });

    // Exactly what the caller paid. Pro-rata over the blended pool would give
    // 49_560 — a 440 msat shortfall on money that fully satisfied the ask.
    expect(grown.addedRailValue.drawMsats).toBe(50_000);
  });

  it("falls back to pro-rata when the growth spends balance already on the credit", async () => {
    const ledger = await driftedCredit();
    const grown = await ledger.growDraw({
      creditId: "c5",
      drawId: "d1",
      addAmountMicro: 55_000,
      jobId: "job-1",
    });

    expect(grown.addedRailValue.drawMsats).toBe(49_500);
  });

  it("earmarks the rail-native amount too, so an x402 top-up books its own USDC", async () => {
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "c6",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 900_000, nativeAmount: 950_000, nativeAsset: "usdc" },
    });
    await ledger.draw({ creditId: "c6", drawId: "d1", amountMicro: 100_000, jobId: "job-1" });
    await ledger.fund({
      creditId: "c6",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 55_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "x402", paidMsats: 50_000, nativeAmount: 55_000, nativeAsset: "usdc" },
    });

    const grown = await ledger.growDraw({
      creditId: "c6",
      drawId: "d1",
      addAmountMicro: 55_000,
      addRailValue: { drawMsats: 50_000, drawNative: 55_000 },
      jobId: "job-1",
    });

    expect(grown.addedRailValue).toEqual({ drawMsats: 50_000, drawNative: 55_000 });
  });

  it("clamps an earmark to the rail value the credit actually holds", async () => {
    const ledger = await fundedLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS },
    });

    const grown = await ledger.growDraw({
      creditId: "c1",
      drawId: "d1",
      addAmountMicro: TOPUP_MICRO,
      addRailValue: { drawMsats: 10 * TOPUP_MSATS, drawNative: null },
      jobId: "job-1",
    });

    expect(grown.addedRailValue.drawMsats).toBe(TOPUP_MSATS);
    expect(grown.railValue.drawMsats).toBe(UPFRONT_MSATS + TOPUP_MSATS);
  });
});

/*
 * Funding raises balance before growth, so balance alone cannot detect a second payment for
 * the same ask. capMicro must bound cumulative growth; excess remains reclaimable.
 */
describe("growDraw's cumulative ask ceiling", () => {
  async function topUpCapped(ledger: MemoryCreditLedger, capMicro: number, fundingRef: string) {
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS, fundingRef },
    });
    return ledger.growDraw({
      creditId: "c1",
      drawId: "d1",
      addAmountMicro: TOPUP_MICRO,
      addRailValue: { drawMsats: TOPUP_MSATS, drawNative: null },
      capMicro,
      jobId: "job-1",
    });
  }

  it("grants the whole growth when the ask leaves room for it", async () => {
    const ledger = await fundedLedger();
    const grown = await topUpCapped(ledger, TOPUP_MICRO, "req-1");

    expect(grown.addedAmountMicro).toBe(TOPUP_MICRO);
    expect(grown.cappedMicro).toBe(0);
    expect(grown.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
  });

  it("refuses a duplicate payment for an ask the first already bought", async () => {
    const ledger = await fundedLedger();
    await topUpCapped(ledger, TOPUP_MICRO, "req-1");
    const duplicate = await topUpCapped(ledger, TOPUP_MICRO, "req-2");

    expect(duplicate.addedAmountMicro).toBe(0);
    expect(duplicate.cappedMicro).toBe(TOPUP_MICRO);
    expect(duplicate.amountMicro).toBe(UPFRONT_MICRO + TOPUP_MICRO);
    const credit = await ledger.get("c1");
    expect(credit?.balanceMicro).toBe(UPFRONT_MICRO + 2 * TOPUP_MICRO);
  });

  it("clips a partial overshoot and scales the earmark up with it", async () => {
    const ledger = await fundedLedger();
    const grown = await topUpCapped(ledger, TOPUP_MICRO / 2, "req-1");

    expect(grown.addedAmountMicro).toBe(TOPUP_MICRO / 2);
    expect(grown.cappedMicro).toBe(TOPUP_MICRO / 2);
    expect(grown.addedRailValue.drawMsats).toBe(TOPUP_MSATS / 2);
  });

  it("rounds a clipped earmark up, not down", async () => {
    // Use a fractional earmark ratio to distinguish ceil from floor. The one-msat deficit can
    // keep a fully paid ask below its resume threshold.
    const ledger = await fundedLedger();
    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 30_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 20_000, fundingRef: "req-skewed" },
    });
    const grown = await ledger.growDraw({
      creditId: "c1",
      drawId: "d1",
      addAmountMicro: 30_000,
      addRailValue: { drawMsats: 20_000, drawNative: null },
      capMicro: 10_000,
      jobId: "job-1",
    });

    expect(grown.addedAmountMicro).toBe(10_000);
    expect(grown.cappedMicro).toBe(20_000);
    // ceil(20 000 × 10 000 / 30 000) = 6667; flooring would hand back 6666.
    expect(grown.addedRailValue.drawMsats).toBe(6667);
  });

  it("grows unbounded when no ceiling is passed", async () => {
    // The residual `-1` shape: an ask the rate provider was down for leaves the
    // job's total unable to express a ceiling, and not capping is the safe
    // failure — a guessed one would clip a payment the caller legitimately owes.
    const ledger = await fundedLedger();
    await topUpCapped(ledger, TOPUP_MICRO, "req-1");

    await ledger.fund({
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS, fundingRef: "req-2" },
    });
    const grown = await ledger.growDraw({
      creditId: "c1",
      drawId: "d1",
      addAmountMicro: TOPUP_MICRO,
      jobId: "job-1",
    });

    expect(grown.addedAmountMicro).toBe(TOPUP_MICRO);
    expect(grown.amountMicro).toBe(UPFRONT_MICRO + 2 * TOPUP_MICRO);
  });
});
