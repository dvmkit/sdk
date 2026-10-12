/** Mocked exact credentials must not enter observability spans. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initLoggers } from "../../../observability/loggers";
import { SpanWriter } from "../../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";

const BEARER_SIGNATURE = "0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678";
const BEARER_NONCE = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const BEARER_PRIVATE_KEY = "0xprivatekey9999abcdef1234567890abcdef1234567890abcdef1234567890ab";

const BEARER_PATTERNS = [BEARER_SIGNATURE, BEARER_NONCE, BEARER_PRIVATE_KEY];

// Mock the pure payment-envelope helpers.
vi.mock("../spec", async () => {
  const actual = await vi.importActual("../spec");
  return {
    ...actual,
    decodePayment: vi.fn().mockReturnValue({
      payload: {
        authorization: {
          from: "0xfrom",
          to: "0xto",
          value: "1000000",
          validAfter: "0",
          validBefore: "999999999",
          nonce: BEARER_NONCE,
          signature: BEARER_SIGNATURE,
        },
      },
    }),
    buildPaymentRequirements: vi.fn().mockReturnValue({}),
    encodeSettleResponseHeader: vi.fn().mockReturnValue("header_value"),
  };
});

vi.mock("../facilitator-request", () => ({
  verifyWithFacilitator: vi.fn().mockResolvedValue({ isValid: true }),
  settleWithFacilitator: vi.fn().mockResolvedValue({ success: true, transaction: "0xtxhash123" }),
}));

vi.mock("../../currency", () => ({
  usdcToMsats: vi.fn().mockReturnValue(1000),
}));

describe("x402 bearer-data audit", () => {
  let captured: SpanRow[];

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captured = [];
    const transport: SpanTransport = { async send() {} };
    const writer = new SpanWriter(transport, 60_000);
    initLoggers(writer, "test-svc");
    setEmitter((row) => captured.push(row));
  });

  afterEach(() => {
    setEmitter(null);
    vi.restoreAllMocks();
  });

  it("verifyX402Payment does not leak signatures or nonces into spans", async () => {
    const { verifyX402Payment } = await import("../verify");
    const result = await verifyX402Payment(
      "base64_payment_header",
      {
        facilitator: "https://x402.test/facilitator",
        network: "eip155:84532",
        payTo: "0xreceiver",
      },
      BigInt(1000000),
      "/v1/job",
      60_000
    );
    expect(result.verified).toBe(true);
    await tick();

    assertNoBearerLeak(captured);
  });
});

function assertNoBearerLeak(spans: SpanRow[]): void {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    const json = JSON.stringify(span.attributes) + JSON.stringify(span.dimensions);
    for (const pattern of BEARER_PATTERNS) {
      expect(json).not.toContain(pattern);
    }
  }
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}
