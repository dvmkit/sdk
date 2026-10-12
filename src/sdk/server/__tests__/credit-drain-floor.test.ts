import { describe, expect, it } from "vitest";

import { DrainRefundFloorError, refundFloorEvidence } from "../credit-drain-floor";
import { CreditLedgerError } from "../credit-ledger";

const ARGS = { creditId: "c1", drainId: "d1" } as const;

describe("refundFloorEvidence", () => {
  it("records the surplus a refund above the debit leaves with the payer", () => {
    expect(
      refundFloorEvidence({
        rail: "tempo",
        refundedNative: 500_000n,
        debitedNative: 400_000,
        ...ARGS,
      })
    ).toEqual({ settled_amount: "500000", surplus_native: "100000" });
  });

  it("takes both rails' figures in their own wire form", () => {
    expect(
      refundFloorEvidence({
        rail: "x402",
        refundedNative: "400000",
        debitedNative: 400_000,
        ...ARGS,
      })
    ).toEqual({ settled_amount: "400000", surplus_native: "0" });
  });

  it("refuses a refund short of the debit, naming both figures per rail", () => {
    expect(() =>
      refundFloorEvidence({
        rail: "tempo",
        refundedNative: 399_999n,
        debitedNative: 400_000,
        ...ARGS,
      })
    ).toThrow(/Tempo close refunded 399999 for a drain requiring at least 400000/);
    let thrown: unknown;
    try {
      refundFloorEvidence({
        rail: "x402", refundedNative: "399999", debitedNative: 400_000, ...ARGS,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DrainRefundFloorError);
    expect(thrown).toBeInstanceOf(CreditLedgerError);
    expect((thrown as Error).message).toMatch(
      /x402 refund settled 399999 for a drain requiring at least 400000/
    );
    expect((thrown as CreditLedgerError).code).toBe("drain_conflict");
    expect((thrown as CreditLedgerError).details.drainConflict).toBe("refund_floor");
  });

  it("refuses a drain with no rail-native basis to size the floor against", () => {
    expect(() =>
      refundFloorEvidence({ rail: "tempo", refundedNative: 400_000n, debitedNative: null, ...ARGS })
    ).toThrow(/drain requiring at least null/);
  });

  it("tolerates an unreported figure rather than wedging every drain on the rail", () => {
    expect(
      refundFloorEvidence({
        rail: "tempo",
        refundedNative: undefined,
        debitedNative: 400_000,
        ...ARGS,
      })
    ).toEqual({});
  });
});
