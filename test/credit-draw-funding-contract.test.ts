import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicaliseForSigning } from "../src/lib/cast-auth";
import { isDrawFundingReceipt, verifyDrawFundingReceipt, type DrawFundingReceipt } from "../src/lib/receipt";
import { deriveReceiptSecret, receiptPubkeyFromSecret } from "../src/lib/receipt-key";
import { verifyDrawFundingReceiptChain } from "../src/lib/receipt-verify";

const fixture = JSON.parse(
  readFileSync(new URL("../protocol-fixtures/credit-draw-funding-v1.json", import.meta.url), "utf8")
) as {
  signing: { builder_secret: string; canonical_utf8: string };
  receipt: DrawFundingReceipt;
  payment_acknowledgement: { body: { seq: number; draw_funding_receipt: DrawFundingReceipt } };
  replayed_payment: { body: { error: string; draw_funding_receipt: DrawFundingReceipt } };
  job_read: { body: { draw_funding_receipts: DrawFundingReceipt[] } };
};

describe("portable draw funding evidence contract", () => {
  it("retains the signed canonical bytes an independent verifier recomputes", () => {
    const { signature, ...unsigned } = fixture.receipt;
    expect(new TextDecoder().decode(canonicaliseForSigning(unsigned as never))).toBe(
      fixture.signing.canonical_utf8
    );
    expect(isDrawFundingReceipt(fixture.receipt)).toBe(true);
    expect(verifyDrawFundingReceipt(fixture.receipt)).toBe(true);
    expect(fixture.receipt.receipt_pubkey).toBe(
      receiptPubkeyFromSecret(deriveReceiptSecret(fixture.signing.builder_secret, fixture.receipt.dvm_id))
    );
    expect(typeof signature).toBe("string");
  });

  it("binds the money, the draw and the caller into the signature", () => {
    for (const tampered of [
      { ...fixture.receipt, funded_micro: fixture.receipt.funded_micro + 1 },
      { ...fixture.receipt, draw_id: "other-draw" },
      { ...fixture.receipt, ledger_seq: fixture.receipt.ledger_seq + 1 },
      { ...fixture.receipt, caller_pubkey: "cc".repeat(32) },
      { ...fixture.receipt, kind: "credit_funding" },
    ]) {
      expect(verifyDrawFundingReceiptChain({ receipt: tampered }).status).toBe("invalid");
    }
  });

  it("returns the identical artifact on the acknowledgement, the replay and the job read", () => {
    const bytes = JSON.stringify(fixture.receipt);
    expect(JSON.stringify(fixture.payment_acknowledgement.body.draw_funding_receipt)).toBe(bytes);
    expect(fixture.replayed_payment.body.error).toBe("replay_rejected");
    expect(JSON.stringify(fixture.replayed_payment.body.draw_funding_receipt)).toBe(bytes);
    expect(JSON.stringify(fixture.job_read.body.draw_funding_receipts)).toBe(JSON.stringify([fixture.receipt]));
  });
});
