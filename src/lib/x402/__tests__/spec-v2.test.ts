import { describe, expect, it } from "vitest";

import {
  buildPaymentRequiredV2,
  decodePayment,
  decodePaymentRequiredHeader,
  encodePayment,
  encodePaymentRequiredHeader,
  type PaymentPayloadV1,
  type PaymentPayloadV2,
  type PaymentRequiredV2,
  type PaymentRequirementsV2,
} from "../spec";

const PAY_TO = "0x1111111111111111111111111111111111111111";

describe("x402 v2 codec", () => {
  it("emits and round-trips the canonical PAYMENT-REQUIRED shape", () => {
    const required = buildPaymentRequiredV2({
      x402Config: { payTo: PAY_TO, network: "eip155:8453" },
      requiredUsdcMicro: 12_345n,
      resource: "https://example.test/v1/job",
      description: "Count words",
    });

    expect(required).toEqual({
      x402Version: 2,
      resource: {
        url: "https://example.test/v1/job",
        description: "Count words",
        mimeType: "application/json",
      },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "12345",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
        },
      ],
      extensions: {},
    });
    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))).toEqual(required);
  });

  it.each([
    {
      label: "v1",
      payload: {
        x402Version: 1,
        scheme: "exact",
        network: "base",
        payload: exactPayload(),
      } satisfies PaymentPayloadV1,
    },
    {
      label: "v2",
      payload: {
        x402Version: 2,
        resource: { url: "https://example.test/v1/job" },
        accepted: {
          scheme: "exact",
          network: "eip155:8453",
          amount: "12345",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
        },
        payload: exactPayload(),
        extensions: {},
      } satisfies PaymentPayloadV2,
    },
  ])("round-trips an exact $label payment through version dispatch", ({ payload }) => {
    expect(decodePayment(encodePayment(payload))).toEqual(payload);
  });

  // The v2 schema declares `extra` optional *and* nullable, and live
  // x402.org kinds ship requirements without one. Rejecting those broke
  // payability both ways: the client fell back to a v1 body a v2-only server
  // never sends, and the server rejected a conformant payer's echoed
  // `accepted` as `decode_failed`.
  it.each([
    { label: "an absent extra", extra: {} },
    { label: "an explicitly null extra", extra: { extra: null } },
  ])("accepts a v2 requirement with $label", ({ extra }) => {
    const requirement = { ...exactRequirement(), ...extra };
    const required = {
      x402Version: 2 as const,
      resource: { url: "https://example.test/v1/job" },
      accepts: [requirement],
      extensions: {},
    };

    expect(decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))).toEqual(required);

    const payload = {
      x402Version: 2,
      resource: required.resource,
      accepted: requirement,
      payload: exactPayload(),
      extensions: {},
    } as PaymentPayloadV2;
    expect(decodePayment(encodePayment(payload))).toEqual(payload);
  });

  it("still rejects a v2 requirement whose extra is present but not an object", () => {
    const required = {
      x402Version: 2 as const,
      resource: { url: "https://example.test/v1/job" },
      accepts: [{ ...exactRequirement(), extra: "eip3009" }],
      extensions: {},
    } as unknown as PaymentRequiredV2;

    expect(() => decodePaymentRequiredHeader(encodePaymentRequiredHeader(required))).toThrow(
      "Invalid x402 v2 payment requirements"
    );
  });

  it("rejects unsupported schemes after extracting the version-specific scheme", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { scheme: "upto" },
        payload: exactPayload(),
      })
    ).toString("base64");

    expect(() => decodePayment(encoded)).toThrow("Unsupported x402 payment scheme: upto");
  });
});

function exactRequirement(): PaymentRequirementsV2 {
  return {
    scheme: "exact",
    network: "eip155:8453",
    amount: "12345",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
  };
}

function exactPayload() {
  return {
    signature: "0xsig",
    authorization: {
      from: "0xfrom",
      to: PAY_TO,
      value: "12345",
      validAfter: "0",
      validBefore: "9999999999",
      nonce: "0xnonce",
    },
  };
}
