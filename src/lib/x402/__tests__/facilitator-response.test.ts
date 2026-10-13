import { afterEach, describe, expect, it, vi } from "vitest";

import { settleWithFacilitator, verifyWithFacilitator } from "../facilitator-request";
import type { PaymentPayloadV2, PaymentRequirementsV2 } from "../spec";

const REQUIREMENTS: PaymentRequirementsV2 = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "1000",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
};
const PAYLOAD: PaymentPayloadV2 = {
  x402Version: 2,
  accepted: REQUIREMENTS,
  payload: {
    signature: "0xsig",
    authorization: {
      from: "0x3333333333333333333333333333333333333333",
      to: REQUIREMENTS.payTo,
      value: REQUIREMENTS.amount,
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xnonce",
    },
  },
};
const CONFIG = { facilitator: "https://facilitator.example" };

afterEach(() => vi.unstubAllGlobals());

describe("x402 facilitator rejection responses", () => {
  it("preserves a structured verify rejection carried by HTTP 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }), {
            status: 400,
          })
      )
    );

    await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
      isValid: false,
      invalidReason: "insufficient_funds",
    });
  });

  it("preserves a structured settle rejection carried by HTTP 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), {
            status: 400,
          })
      )
    );

    await expect(settleWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
      success: false,
      errorReason: "insufficient_funds",
    });
  });

  it.each([
    { status: 400, body: "not json", expected: "facilitator_status_400" },
    {
      status: 401,
      body: JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }),
      expected: "facilitator_status_401",
    },
  ])(
    "retains HTTP $status when no trustworthy rejection exists",
    async ({ status, body, expected }) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status }))
      );

      await expect(verifyWithFacilitator(PAYLOAD, REQUIREMENTS, CONFIG)).resolves.toEqual({
        isValid: false,
        invalidReason: expected,
      });
    }
  );
});
