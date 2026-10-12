import { describe, expect, it } from "vitest";

import { paymentFailureStage, withPaymentDiagnostics, withPaymentStage } from "../payment-diagnostics";

describe("payment failure stages", () => {
  it.each([new Error("private provider detail"), "private provider detail", undefined])("preserves the original exception and the nested accounting stage (%s)", async (failure) => {
    await withPaymentDiagnostics(async () => {
      await expect(withPaymentStage("replay_store", () =>
        withPaymentStage("funding_ledger", async () => { throw failure; })
      )).rejects.toBe(failure);
      expect(paymentFailureStage(failure)).toBe("funding_ledger");
    });
    expect(paymentFailureStage(failure)).toBe("unknown");
  });

  it("isolates concurrent payments even when a dependency reuses its exception", async () => {
    const failure = new Error("shared external exception");
    let release!: () => void;
    const bothFailed = new Promise<void>((resolve) => { release = resolve; });
    let failures = 0;
    const results = await Promise.all((["verifier", "replay_store"] as const).map((stage) =>
      withPaymentDiagnostics(async () => {
        try {
          await withPaymentStage(stage, async () => { throw failure; });
        } catch (error) {
          expect(error).toBe(failure);
          if (++failures === 2) release();
          await bothFailed;
          return paymentFailureStage(error);
        }
        throw new Error("expected external failure");
      })
    ));
    expect(results).toEqual(["verifier", "replay_store"]);
  });
});
