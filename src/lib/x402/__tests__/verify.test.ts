import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as facilitatorRequestModule from "../facilitator-request";
import type {
  PaymentPayload,
  PaymentPayloadV2,
  PaymentRequirementsV2,
  SettleResponse,
  VerifyResponse,
} from "../spec";
import { buildPaymentRequiredV2, encodePayment } from "../spec";
import type { X402Config } from "../types";
import { verifyX402Payment } from "../verify";

const RATE = 60_000;

vi.mock("../facilitator-request", async () => {
  const actual = await vi.importActual<typeof facilitatorRequestModule>("../facilitator-request");
  return {
    ...actual,
    verifyWithFacilitator: vi.fn<typeof actual.verifyWithFacilitator>(),
    settleWithFacilitator: vi.fn<typeof actual.settleWithFacilitator>(),
  };
});

const { verifyWithFacilitator, settleWithFacilitator } = await import("../facilitator-request");

const CONFIG: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:84532",
  payTo: "0xreceiver",
};

const RESOURCE = "/v1/job";

/** Build a real base64 `X-PAYMENT` header carrying the given authorization `value`. */
function paymentHeader(value: string): string {
  const payload: PaymentPayload = {
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0xfrom",
        to: "0xto",
        value,
        validAfter: "0",
        validBefore: "999999999",
        nonce: "0xnonce",
      },
    },
  };
  return encodePayment(payload);
}

/**
 * Build a v2 PAYMENT-SIGNATURE value from the requirement the server would
 * advertise, or from `accepted` when a test echoes a different conformant shape.
 */
function paymentHeaderV2(value: string, accepted?: PaymentRequirementsV2): string {
  const required = buildPaymentRequiredV2({
    x402Config: CONFIG,
    requiredUsdcMicro: BigInt(value),
    resource: RESOURCE,
  });
  const payload: PaymentPayloadV2 = {
    x402Version: 2,
    resource: required.resource,
    accepted: accepted ?? required.accepts[0],
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0xfrom",
        to: CONFIG.payTo,
        value,
        validAfter: "0",
        validBefore: "999999999",
        nonce: "0xnonce",
      },
    },
    extensions: {},
  };
  return encodePayment(payload);
}

function ok(extra: Partial<VerifyResponse> = {}): VerifyResponse {
  return { isValid: true, ...extra };
}

function settled(extra: Partial<SettleResponse> = {}): SettleResponse {
  return { success: true, transaction: "0xtxhash123", ...extra };
}

describe("verifyX402Payment", () => {
  beforeEach(() => {
    // Default happy-path facilitator responses; per-test cases override.
    vi.mocked(verifyWithFacilitator).mockResolvedValue(ok());
    vi.mocked(settleWithFacilitator).mockResolvedValue(settled());
  });

  it("returns decode_failed when the X-PAYMENT header is malformed", async () => {
    const result = await verifyX402Payment(
      "@@not-base64-json@@",
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result).toEqual({ verified: false, amountMsats: 0, invalidReason: "decode_failed" });
    expect(verifyWithFacilitator).not.toHaveBeenCalled();
    expect(settleWithFacilitator).not.toHaveBeenCalled();
  });

  it.each([
    ["v1", paymentHeader("1000000"), { v1: false, v2: true }],
    ["v2", paymentHeaderV2("1000000"), { v1: true, v2: false }],
  ])(
    "rejects %s before the facilitator when that exact generation is disabled",
    async (_, header, exact) => {
      const result = await verifyX402Payment(header, CONFIG, 1_000_000n, RESOURCE, RATE, exact);

      expect(result).toEqual({
        verified: false,
        amountMsats: 0,
        invalidReason: "unsupported_version",
      });
      expect(verifyWithFacilitator).not.toHaveBeenCalled();
      expect(settleWithFacilitator).not.toHaveBeenCalled();
    }
  );

  it("returns verify_failed (default) when the facilitator rejects without a reason", async () => {
    vi.mocked(verifyWithFacilitator).mockResolvedValue({ isValid: false });
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result).toEqual({ verified: false, amountMsats: 0, invalidReason: "verify_failed" });
    expect(settleWithFacilitator).not.toHaveBeenCalled();
  });

  it("propagates the facilitator's invalidReason on verify failure", async () => {
    vi.mocked(verifyWithFacilitator).mockResolvedValue({
      isValid: false,
      invalidReason: "insufficient_funds",
    });
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result.verified).toBe(false);
    expect(result.invalidReason).toBe("insufficient_funds");
    expect(settleWithFacilitator).not.toHaveBeenCalled();
  });

  it("returns settle_failed (default) when settlement fails without a reason — the took-the-money line", async () => {
    vi.mocked(settleWithFacilitator).mockResolvedValue({ success: false });
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result).toEqual({ verified: false, amountMsats: 0, invalidReason: "settle_failed" });
  });

  it("propagates the facilitator's errorReason on settle failure", async () => {
    vi.mocked(settleWithFacilitator).mockResolvedValue({
      success: false,
      errorReason: "broadcast_reverted",
    });
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result.verified).toBe(false);
    expect(result.invalidReason).toBe("broadcast_reverted");
  });

  it("derives the exact amountMsats from the authorization value and BTC rate", async () => {
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );
    expect(result.verified).toBe(true);
    expect(result.amountUsdcMicro).toBe(1_000_000);
    // 1 USDC at $60k/BTC → round((1/60000) * 1e11) msats.
    expect(result.amountMsats).toBe(1_666_667);
    expect(result.txHash).toBe("0xtxhash123");
    expect(result.settleResponseHeader).toBeTruthy();
  });

  it("keeps the native amount when no BTC rate was needed", async () => {
    const result = await verifyX402Payment(
      paymentHeader("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      0
    );

    expect(result).toMatchObject({
      verified: true,
      amountMsats: 0,
      amountUsdcMicro: 1_000_000,
      txHash: "0xtxhash123",
    });
    expect(settleWithFacilitator).toHaveBeenCalledOnce();
  });

  it("verifies and settles v2 using the nested accepted requirement", async () => {
    const result = await verifyX402Payment(
      paymentHeaderV2("1000000"),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );

    expect(result.verified).toBe(true);
    expect(verifyWithFacilitator).toHaveBeenCalledWith(
      expect.objectContaining({ x402Version: 2 }),
      expect.objectContaining({
        network: "eip155:84532",
        amount: "1000000",
        extra: expect.objectContaining({ assetTransferMethod: "eip3009" }),
      }),
      CONFIG,
      undefined
    );
    expect(settleWithFacilitator).toHaveBeenCalledWith(
      expect.objectContaining({ x402Version: 2 }),
      expect.objectContaining({ amount: "1000000" }),
      CONFIG,
      undefined
    );
  });

  // A conformant payer may echo a requirement with no `extra` — the field is
  // optional and nullable in the v2 schema. Rejecting it as `decode_failed`
  // made the DVM unpayable by spec-following clients.
  it.each([
    { label: "omits", extra: undefined },
    { label: "nulls", extra: null },
  ])("verifies a v2 payment whose accepted requirement $label extra", async ({ extra }) => {
    const accepted: PaymentRequirementsV2 = {
      scheme: "exact",
      network: "eip155:84532",
      amount: "1000000",
      asset: "0xusdc",
      payTo: CONFIG.payTo,
      maxTimeoutSeconds: 60,
      extra,
    };

    const result = await verifyX402Payment(
      paymentHeaderV2("1000000", accepted),
      CONFIG,
      1_000_000n,
      RESOURCE,
      RATE
    );

    expect(result.verified).toBe(true);
    expect(verifyWithFacilitator).toHaveBeenCalledWith(
      expect.objectContaining({ x402Version: 2, accepted }),
      expect.objectContaining({ amount: "1000000" }),
      CONFIG,
      undefined
    );
  });

  it("converts a large micro-unit amount to finite proportional millisatoshis", async () => {
    // A large on-chain value must still produce a finite, proportional credit —
    // a silent NaN/truncation here would under- or over-credit real USDC.
    const value = "1000000000000000000000000"; // 1e24 micro-USDC
    const result = await verifyX402Payment(paymentHeader(value), CONFIG, 1n, RESOURCE, RATE);
    expect(result.verified).toBe(true);
    expect(Number.isFinite(result.amountMsats)).toBe(true);
    expect(result.amountMsats).toBeGreaterThan(0);
    expect(result.amountMsats).toBe(1.6666666666666666e24);
  });
});
