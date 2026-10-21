import { describe, expect, it } from "vitest";

import { verifyFundingReceipt } from "../../../lib/receipt";
import { drawFundingReceiptFor, fundingReceiptFor } from "../funding-receipt";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { ReceiptIssuer } from "../receipt-issuer";

describe("credit funding receipts", () => {
  it("persists the first signed artifact and returns it byte-for-byte on replay", async () => {
    const ledger = new MemoryCreditLedger();
    const issuer = new ReceiptIssuer({
      secret: "12".repeat(32),
      dvm: "funding-test",
      dvmId: "dvm-funding-test",
    });
    await ledger.recordFunding({
      creditId: "credit-1",
      fundId: "fund-1",
      amountMicro: 250_000,
      rail: "cashu",
      nowMs: 1_790_000_000_000,
    });
    const completed = await ledger.completeFunding({
      creditId: "credit-1",
      fundId: "fund-1",
      callerPubkey: "ab".repeat(32),
      balanceAfterMicro: 600_000,
      ledgerSeq: 7,
    });

    const first = await fundingReceiptFor(ledger, issuer, completed);
    const stored = await ledger.getFunding({ creditId: "credit-1", fundId: "fund-1" });
    if (!first || !stored) throw new Error("funding receipt was not persisted");
    const replayed = await fundingReceiptFor(ledger, issuer, stored);

    expect(verifyFundingReceipt(first)).toBe(true);
    expect(first).toMatchObject({
      kind: "credit_funding",
      credit_id: "credit-1",
      fund_id: "fund-1",
      funded_micro: 250_000,
      balance_after_micro: 600_000,
      ledger_seq: 7,
      issued_at: 1_790_000_000,
      caller_pubkey: "ab".repeat(32),
    });
    expect(JSON.stringify(replayed)).toBe(JSON.stringify(first));
  });

  // The receipt slot is write-once. A mid-job row reaches the opening-receipt
  // path through the fund replay routes, and signing it there would misstate
  // the draw's sequence and the post-growth balance while making the draw
  // funding artifact unissuable for that payment forever.
  it("never signs a draw-bound row as an opening receipt, leaving its slot free", async () => {
    const ledger = new MemoryCreditLedger();
    const issuer = new ReceiptIssuer({
      secret: "12".repeat(32),
      dvm: "funding-test",
      dvmId: "dvm-funding-test",
    });
    await ledger.recordFunding({
      creditId: "credit-1",
      fundId: "0xmidjob",
      amountMicro: 50_000,
      rail: "x402",
      jobId: "job-1",
      drawId: "draw-1",
      paymentSeq: 3,
      nowMs: 1_790_000_000_000,
    });
    const completed = await ledger.completeFunding({
      creditId: "credit-1",
      fundId: "0xmidjob",
      callerPubkey: "ab".repeat(32),
      balanceAfterMicro: 400_000,
      ledgerSeq: 6,
    });

    expect(await fundingReceiptFor(ledger, issuer, completed)).toBeUndefined();
    const untouched = await ledger.getFunding({ creditId: "credit-1", fundId: "0xmidjob" });
    expect(untouched?.receipt).toBeNull();

    const draw = await drawFundingReceiptFor(ledger, issuer, completed, "usd");
    expect(draw).toMatchObject({
      kind: "credit_draw_funding",
      job_id: "job-1",
      draw_id: "draw-1",
      fund_id: "0xmidjob",
      funded_micro: 50_000,
      ledger_seq: 6,
    });
    const stored = await ledger.getFunding({ creditId: "credit-1", fundId: "0xmidjob" });
    expect(JSON.stringify(stored?.receipt)).toBe(JSON.stringify(draw));
    // And the opening path still refuses once the draw artifact occupies the slot.
    expect(await fundingReceiptFor(ledger, issuer, stored!)).toBeUndefined();
  });
});
