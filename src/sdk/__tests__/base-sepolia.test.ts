import { describe, expect, it } from "vitest";

import { decodePayment, encodePayment } from "../../lib/x402";
import {
  isCanonicalBaseSepoliaExactSignature,
} from "./__helpers__/base-sepolia";
import { canonicalBaseSepoliaPaymentHeader } from "./__helpers__/canonical-x402-payment";

const PAYER_KEY = "0x0000000000000000000000000000000000000000000000000000000000000001";
const RECIPIENT = "0x0000000000000000000000000000000000000002";

async function signedHeader(): Promise<string> {
  return canonicalBaseSepoliaPaymentHeader(PAYER_KEY, RECIPIENT, 1000n, "https://example.com/job");
}

describe("isCanonicalBaseSepoliaExactSignature", () => {
  it("accepts a signature over Base Sepolia's canonical USDC domain", async () => {
    await expect(isCanonicalBaseSepoliaExactSignature(await signedHeader())).resolves.toBe(true);
  });

  it("rejects an authorization changed after signing", async () => {
    const payment = decodePayment(await signedHeader());
    payment.payload.authorization.to = "0x0000000000000000000000000000000000000003";

    await expect(isCanonicalBaseSepoliaExactSignature(encodePayment(payment))).resolves.toBe(false);
  });

  it("rejects a malformed header instead of turning it into outage evidence", async () => {
    await expect(isCanonicalBaseSepoliaExactSignature("not a payment header")).resolves.toBe(false);
  });
});
