import { describe, expect, it } from "vitest";

import type { CreditDrawRefundArgs } from "../credit-draw-refund";
import { MemoryCreditLedger } from "../memory-credit-ledger";

const nowMs = 1_800_000_000_000;
const callerPubkey = "ab".repeat(32);
const outbox: CreditDrawRefundArgs["outbox"] = { dvmId: "example-dvm", enqueue: async () => {} };

async function fund(ledger: MemoryCreditLedger, amountMicro = 1_000, sats = 100) {
  await ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro,
    expiryMs: nowMs + 86_400_000, basis: { rail: "cashu", paidMsats: sats * 1_000 }, nowMs });
}

async function complete(ledger: MemoryCreditLedger, drawId = "d", amountMicro = 1_000) {
  await ledger.draw({ creditId: "c", drawId, amountMicro, jobId: `job-${drawId}`, nowMs });
  await ledger.settle({ creditId: "c", drawId, nowMs });
}

describe("development completed draw refund parity", () => {
  it("restores partial and remaining amounts once, and replays persisted facts after later spending", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger);
    const args = { jobId: "job-d", refundId: "r", amountMicro: 300, outbox, nowMs };
    const first = await ledger.refundDraw(args);
    await ledger.refundDraw({ creditId: "c", drawId: "d", refundId: "remainder", outbox, nowMs });
    await complete(ledger, "later", 900);
    expect(await ledger.refundDraw({ ...args, nowMs: nowMs + 86_400_001 })).toEqual({ ...first, replayed: true });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(100);
    await expect(ledger.refundDraw({ ...args, reason: "Changed" })).rejects.toMatchObject({ code: "refund_conflict" });
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "excess", outbox, nowMs })).rejects.toMatchObject({ code: "refund_exceeds_draw" });
  });

  it("refuses a drained credit and allows one topped up after an old drain and fully spent again", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger, "d", 500);
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "closed", outbox, nowMs })).rejects.toMatchObject({ code: "credit_not_open" });
    await fund(ledger, 500, 50); await complete(ledger, "new", 500);
    expect(await ledger.refundDraw({ jobId: "job-new", refundId: "open", outbox, nowMs })).toMatchObject({ amountMicro: 500, balanceAfterMicro: 500 });
  });

  it("does not reopen a fully drained credit when a zero-amount draw advances its sequence", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger, "d", 500);
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await ledger.draw({ creditId: "c", drawId: "free", jobId: "free-job", amountMicro: 0, nowMs });
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "closed", outbox, nowMs })).rejects.toMatchObject({ code: "credit_not_open" });
  });

  it("refunds a completed hold grown after a drain and same-time top-up", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger);
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "job-d", amountMicro: 500, nowMs });
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    await fund(ledger, 500, 50);
    await ledger.growDraw({ creditId: "c", drawId: "d", addAmountMicro: 500, nowMs });
    await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    expect(await ledger.refundDraw({ jobId: "job-d", refundId: "grown", outbox, nowMs })).toMatchObject({ amountMicro: 1_000, balanceAfterMicro: 1_000 });
  });

  it.each([true, false])("distinguishes a zero hold grown before and after a full drain (reopened=%s)", async reopened => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger, 500, 50);
    await ledger.draw({ creditId: "c", drawId: "d", jobId: "job-d", amountMicro: 0, nowMs });
    const grow = async () => {
      await ledger.growDraw({ creditId: "c", drawId: "d", addAmountMicro: 500, nowMs });
      await ledger.settle({ creditId: "c", drawId: "d", nowMs });
    };
    if (reopened) {
      await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
      await fund(ledger, 500, 50); await grow();
    } else {
      await grow(); await fund(ledger, 500, 50);
      await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    }
    const result = ledger.refundDraw({ jobId: "job-d", refundId: "ordered", outbox, nowMs });
    if (reopened) expect(await result).toMatchObject({ amountMicro: 500 });
    else await expect(result).rejects.toMatchObject({ code: "credit_not_open" });
  });

  it("retains known-zero original sats through refund, settlement, liability, and drain dust refusal", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger, 100, 1); await complete(ledger, "d", 100);
    await ledger.refundDraw({ jobId: "job-d", refundId: "tiny", amountMicro: 1, outbox, nowMs });
    expect(await ledger.bitcoinDepositLiability()).toMatchObject({ depositSats: 0, unbackedCredits: 0 });
    await expect(ledger.requestDrain({ creditId: "c", drainId: "dust", callerPubkey, method: "cashu", payout: {}, nowMs })).rejects.toMatchObject({ code: "drain_below_dust" });
    await complete(ledger, "zero", 1);
    expect(await ledger.refundDraw({ jobId: "job-zero", refundId: "zero-again", outbox, nowMs })).toMatchObject({ amountMicro: 1 });
    await ledger.refundDraw({ jobId: "job-d", refundId: "rest", outbox, nowMs });
    expect(await ledger.bitcoinDepositLiability()).toMatchObject({ depositSats: 1, unbackedCredits: 0 });
  });

  it("refuses original value from basisless lots rather than restoring a forecast", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger, 1_000, 0); await complete(ledger);
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "unknown", outbox, nowMs })).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
  });

  it.each([0, 1_000, 1_001])("refuses a marker-only historical basis (%s msats) before asset proration", async drawMsats => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger);
    // Model missing historical authority, including known-looking zero/integer markers
    // and a fractional value that must never reach BigInt proration.
    const stored = (ledger as unknown as { credits: Map<string, { draws: Map<string, {
      settledSats?: number | null; allocatedMsats?: number; drawMsats: number;
    }> }> }).credits.get("c")!.draws.get("d")!;
    stored.settledSats = undefined;
    stored.allocatedMsats = 0;
    stored.drawMsats = drawMsats;
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "marker-only", outbox, nowMs })).rejects.toMatchObject({ code: "credit_refund_basis_unavailable" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
  });

  it("refuses unavailable historical reopening state but preserves exact replay", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger, "d", 500);
    const args = { jobId: "job-d", refundId: "recorded", amountMicro: 100, outbox, nowMs };
    const first = await ledger.refundDraw(args);
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    // Only legacy fixtures lack the watermark; new memory writes always maintain it.
    const credit = (ledger as unknown as { credits: Map<string, { lastFundingLedgerSeq: number | null }> }).credits.get("c")!;
    credit.lastFundingLedgerSeq = null;
    await expect(ledger.refundDraw({ ...args, refundId: "unknown" })).rejects.toMatchObject({ code: "credit_refund_state_unavailable" });
    expect(await ledger.refundDraw(args)).toEqual({ ...first, replayed: true });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
  });

  it("admits historical reopening proved by retained funding sequence", async () => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger, "d", 500);
    await ledger.draw({ creditId: "c", drawId: "old-hold", jobId: "held-job", amountMicro: 0, nowMs });
    await ledger.requestDrain({ creditId: "c", drainId: "drain", callerPubkey, method: "cashu", payout: {}, nowMs });
    const snapshot = await ledger.fund({ creditId: "c", callerPubkey, currency: "usd", amountMicro: 500,
      expiryMs: nowMs + 86_400_000, basis: { rail: "cashu", paidMsats: 50_000 }, nowMs });
    await ledger.recordFunding({ creditId: "c", fundId: "top-up", amountMicro: 500, rail: "cashu", nowMs });
    await ledger.completeFunding({ creditId: "c", fundId: "top-up", callerPubkey,
      balanceAfterMicro: snapshot.balanceMicro, ledgerSeq: snapshot.lastLedgerSeq });
    await ledger.growDraw({ creditId: "c", drawId: "old-hold", addAmountMicro: 500, nowMs });
    await ledger.settle({ creditId: "c", drawId: "old-hold", nowMs });
    const credit = (ledger as unknown as { credits: Map<string, { lastFundingLedgerSeq: number | null }> }).credits.get("c")!;
    credit.lastFundingLedgerSeq = null;
    expect(await ledger.refundDraw({ jobId: "job-d", refundId: "funding-proof", outbox, nowMs })).toMatchObject({ amountMicro: 500, balanceAfterMicro: 500 });
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN])("refuses invalid amount %s before accounting", async amountMicro => {
    const ledger = new MemoryCreditLedger();
    await fund(ledger); await complete(ledger);
    await expect(ledger.refundDraw({ jobId: "job-d", refundId: "bad", amountMicro, outbox, nowMs })).rejects.toMatchObject({ code: "invalid_refund" });
    expect((await ledger.get("c", { nowMs }))?.balanceMicro).toBe(0);
  });
});
