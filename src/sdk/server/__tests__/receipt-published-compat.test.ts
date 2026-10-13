import { describe, expect, it } from "vitest";
import { isSignedJobReceipt, verifyReceipt } from "sdk-receipt-compat/internal";
import fixture from "../../../../protocol-fixtures/job-terminal-evidence.json";
import { signReceipt } from "../../../lib/receipt";
import type { UnsignedJobReceipt } from "../../../lib/receipt";

describe("published receipt verifier compatibility", () => {
  it("accepts new signed fields through the pinned registry verifier", () => {
    const { signature: _signature, ...unsigned } = fixture.receipt;
    const receipt = signReceipt(unsigned as UnsignedJobReceipt, "11".repeat(32));
    expect(isSignedJobReceipt(receipt)).toBe(true);
    expect(verifyReceipt(receipt)).toBe(true);
    const changedTiming = { ...receipt, timing: { ...receipt.timing!, caller_wait_ms: 301 } };
    expect(verifyReceipt(changedTiming)).toBe(false);
    const changedAttribution = { ...receipt, ended_by: "caller" as const };
    expect(verifyReceipt(changedAttribution)).toBe(false);
  });
  it("verifies the portable new-shape fixture", () => {
    expect(isSignedJobReceipt(fixture.receipt)).toBe(true);
    expect(verifyReceipt(fixture.receipt as Parameters<typeof verifyReceipt>[0])).toBe(true);
  });
});
