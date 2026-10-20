import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCreditTerms } from "../src/lib/transport/types";
import { BALANCE_PAYMENT_SCHEMA } from "../src/sdk/server/balance-payment";
import { createSignedRequestVerifier } from "../src/sdk/server/signed-request";

const fixture = JSON.parse(readFileSync(new URL("../protocol-fixtures/balance-payment-v1.json", import.meta.url), "utf8"));
const verifier = createSignedRequestVerifier(BALANCE_PAYMENT_SCHEMA, { replayStore: null });

describe("portable balance payment contract", () => {
  it("retains the signed canonical bytes consumed by independent clients", () => {
    const credit = fixture.payment.content.credit;
    expect(new TextDecoder().decode(verifier.canonicalBytes(credit, fixture.domain))).toBe(fixture.canonical_utf8);
    expect(() => verifier.verifySignature(credit, fixture.domain)).not.toThrow();
    expect(() => verifier.verifySignature({ ...credit, request_seq: 5 }, fixture.domain)).toThrow();
    expect(() => verifier.verifySignature(credit, { ...fixture.domain, path: "/v1/job/other/messages" })).toThrow();
  });

  it("preserves only explicit support through the public terms parser", () => {
    const terms = { min_micro: 100, max_micro: 5_000_000, ttl_ms: 86_400_000,
      currency: "usd", funding: ["cashu"], balance_payment: true, credit_id: "private-balance" };
    expect(parseCreditTerms(terms)).toEqual({ min_micro: 100, max_micro: 5_000_000,
      ttl_ms: 86_400_000, currency: "usd", funding: ["cashu"], balance_payment: true });
    expect(parseCreditTerms({ ...terms, balance_payment: "true" })?.balance_payment).toBeUndefined();
    expect(parseCreditTerms({ ...terms, balance_payment: false })?.balance_payment).toBeUndefined();
  });
});
