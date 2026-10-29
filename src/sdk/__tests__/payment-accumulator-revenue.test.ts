import { describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { acceptAccumulatorPayment } from "../server/wallet-accumulator-receive";

vi.mock("../server/wallet-accumulator-receive", () => ({
  acceptAccumulatorPayment: vi.fn(),
}));

const { verifyUpfrontPayment } = await import("../server/payment");
const mockAccept = vi.mocked(acceptAccumulatorPayment);

const MINT = "https://mint.example.com";
const LOCK_PUBKEY = toLockPubkey("02" + "ab".repeat(32));

// the accumulator-path wrapper in payment.ts (`verifyAccumulatorReceipt`)
// must thread the X-Cashu-Request-Id UUID into `paymentTxHash` and tag
// `cashuFlow: "p2pk_accumulator"` so the platform's revenue callback writes a
// distinctly-shaped `revenue_events` row. Mocking `acceptAccumulatorPayment`
// keeps the test focused on the wiring rather than the swap/accumulate logic
// (covered separately in wallet-accumulator-receive.test.ts).
describe("verifyUpfrontPayment — accumulator path threads revenue fields", () => {
  it("returns paymentTxHash + cashuFlow on the accumulated outcome", async () => {
    mockAccept.mockResolvedValueOnce({
      kind: "accumulated",
      paidMsats: 1_000_000,
      grossMsats: 1_000_000,
      inputFeeMsats: 0,
      netMsats: 1_000_000,
      mintUrl: MINT,
      requestId: "req-accum-uuid",
    });

    const result = await verifyUpfrontPayment({
      cashuToken: "cashuB...",
      requestId: "req-accum-uuid",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [LOCK_PUBKEY],
      mints: [MINT],
    });

    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(1_000_000);
    expect(result.paymentRail).toBe("cashu");
    expect(result.paymentMint).toBe(MINT);
    expect(result.paymentTxHash).toBe("req-accum-uuid");
    expect(result.cashuFlow).toBe("p2pk_accumulator");
    expect(result.receivedProofs).toEqual([]);
  });

  it("does not populate paymentTxHash on rejection", async () => {
    mockAccept.mockResolvedValueOnce({
      kind: "rejected",
      code: "wrong_lock_pubkey",
      message: "not locked to DVM pubkey",
    });

    const result = await verifyUpfrontPayment({
      cashuToken: "cashuB...",
      requestId: "req-reject-uuid",
      cashuMode: "p2pk-accumulator",
      accumulatorDb: {} as never,
      dvmId: "dvm-1",
      lockPubkeys: [LOCK_PUBKEY],
      mints: [MINT],
    });

    expect(result.error?.body.error).toBe("wrong_lock_pubkey");
    // the accumulator-rejection body carries the four agent-facing
    // fields, with the mint list preserved as an extra.
    expect(typeof result.error?.body.display).toBe("string");
    expect(typeof result.error?.body.hint).toBe("string");
    expect(result.error?.body.retryable).toBe(false);
    expect(result.error?.body.mints).toEqual([MINT]);
    expect(result.paidMsats).toBe(0);
    expect(result.paymentTxHash).toBeUndefined();
    expect(result.cashuFlow).toBeUndefined();
  });
});
