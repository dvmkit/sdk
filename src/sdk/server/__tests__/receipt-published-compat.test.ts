import { describe, expect, it } from "vitest";
import { isSignedJobReceipt, verifyReceipt } from "sdk-receipt-compat/internal";
import fixture from "../../../../protocol-fixtures/job-terminal-evidence.json";
import { signReceipt } from "../../../lib/receipt";
import type { UnsignedJobReceipt } from "../../../lib/receipt";

// The pinned verifier's type predates the `stripe` funding rail; its runtime
// check never inspects `paid.rail`.
type PublishedReceipt = Parameters<typeof verifyReceipt>[0];

describe("published receipt verifier compatibility", () => {
  it("accepts new signed fields through the pinned registry verifier", () => {
    const { signature: _signature, ...unsigned } = fixture.receipt;
    const receipt = signReceipt(unsigned as UnsignedJobReceipt, "11".repeat(32));
    expect(isSignedJobReceipt(receipt)).toBe(true);
    expect(verifyReceipt(receipt as PublishedReceipt)).toBe(true);
    const changedTiming = { ...receipt, timing: { ...receipt.timing!, caller_wait_ms: 301 } };
    expect(verifyReceipt(changedTiming as PublishedReceipt)).toBe(false);
    const changedAttribution = { ...receipt, ended_by: "caller" as const };
    expect(verifyReceipt(changedAttribution as PublishedReceipt)).toBe(false);
  });
  it("verifies the portable new-shape fixture", () => {
    expect(isSignedJobReceipt(fixture.receipt)).toBe(true);
    expect(verifyReceipt(fixture.receipt as Parameters<typeof verifyReceipt>[0])).toBe(true);
  });
});
