/**
 * Bearer-data audit: asserts that MPP HMAC secrets and credential opaque
 * fields never leak into observability spans.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initLoggers } from "../../../observability/loggers";
import { SpanWriter } from "../../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { issueUpfrontChallenges } from "../payment";

const BEARER_HMAC_SECRET = "hmac_secret_32bytes_deadbeefcafe";
// mppx 0.8.x carries the parsed correlation record on `meta`; `opaque` is its
// base64url wire form. A real 0.8 challenge carries both, so the fake does too —
// `opaque` is the shape of a leak that a plaintext nonce match walks straight
// past, which is precisely what this guard caught while 0.6 carried the record
// on `opaque` alone.
const BEARER_CHALLENGE_META = { path: "/v1/job", nonce: "opaque_nonce_secret_value" };
// `PaymentRequest.serialize` is base64url(canonical JSON) — keys sorted, unpadded
// (mppx 0.8.15 `src/PaymentRequest.ts:105`). Derived here rather than imported
// because this file mocks the whole `mppx` module; verified byte-identical to the
// real serializer's output for this record.
const BEARER_CHALLENGE_OPAQUE = Buffer.from(
  JSON.stringify({ nonce: BEARER_CHALLENGE_META.nonce, path: BEARER_CHALLENGE_META.path })
).toString("base64url");

const BEARER_PATTERNS = [BEARER_HMAC_SECRET, "opaque_nonce_secret_value", BEARER_CHALLENGE_OPAQUE];

vi.mock("mppx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("mppx")>()),
  Challenge: { Challenge: vi.fn() },
}));
vi.mock("../../../lib/currency", () => ({
  msatsToUsdc: vi.fn().mockReturnValue(0.01),
}));
vi.mock("../../../lib/cashu/verify", () => ({
  verifyCashuToken: vi.fn(),
}));
vi.mock("../../../lib/x402/spec", () => ({
  buildPaymentRequirements: vi.fn(),
}));
vi.mock("../mpp-units", () => ({
  msatsToMethodAmount: vi.fn().mockReturnValue("1.00"),
  methodNativeAmountFromDecimal: vi.fn().mockReturnValue(100),
  methodNativeAsset: vi.fn().mockReturnValue("usd"),
}));
vi.mock("../wallet-accumulator-receive", () => ({
  acceptAccumulatorPayment: vi.fn(),
}));

describe("mpp bearer-data audit", () => {
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

  it("issueUpfrontChallenges does not leak HMAC secrets into spans", async () => {

    const mockMpp = {
      methods: [{ name: "tempo", intent: "payment" }],
      realm: "test-realm",
      issueChallenge: vi.fn().mockResolvedValue({
        id: "challenge_id_safe",
        method: "tempo",
        intent: "payment",
        amount: "1.00",
        expires: "2099-01-01T00:00:00Z",
        meta: BEARER_CHALLENGE_META,
        opaque: BEARER_CHALLENGE_OPAQUE,
      }),
      broadcastCredential: vi.fn(),
      // Simulate internal access to secret
      _secretKey: BEARER_HMAC_SECRET,
    };

    const challenges = await issueUpfrontChallenges(mockMpp as never, 1000, "/v1/job", 60_000);
    expect(challenges).toHaveLength(1);
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
