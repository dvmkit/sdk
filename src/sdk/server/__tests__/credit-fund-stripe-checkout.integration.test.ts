import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CHECKOUT_LIFETIME_MS, createStripeCheckoutApi } from "../stripe-checkout";
import type { StripeCheckoutRecord } from "../stripe-checkout-store";

const KEY = process.env.STRIPE_TEST_SECRET_KEY;
if (KEY && !/^(sk|rk)_test_/.test(KEY)) throw new Error("STRIPE_TEST_SECRET_KEY must be a Stripe test-mode key");

describe.skipIf(!KEY)("hosted Checkout in Stripe test mode", () => {
  it("creates and reads a fixed USD card/link session without prefilling or creating a customer", async () => {
    const now = Date.now();
    const record: StripeCheckoutRecord = {
      dvmId: "checkout-test-dvm", storeNamespace: randomUUID(),
      fundId: `checkout-test-${randomUUID()}`, creditId: "checkout-test-credit", callerPubkey: "11".repeat(32),
      amountMicro: 5_000_000, createdAt: now, expiresAt: now + CHECKOUT_LIFETIME_MS,
      productName: "Example DVM prepaid credit", successUrl: "https://example.com/complete", state: "creating",
    };
    const api = createStripeCheckoutApi({ secretKey: KEY! });
    const created = await api.create(record);
    try {
      expect(created.id).toMatch(/^cs_test_/);
      expect(created.url).toMatch(/^https:\/\/checkout.stripe.com\//);
      expect((await api.create(record)).id).toBe(created.id);
      const read = await api.retrieve(created.id);
      expect(read).toMatchObject({ id: created.id, status: "open", payment_status: "unpaid",
        client_reference_id: record.fundId,
        metadata: { fund_id: record.fundId, credit_id: record.creditId, caller_pubkey: record.callerPubkey,
          dvmkit_dvm_id: record.dvmId, dvmkit_checkout_store: record.storeNamespace },
      });
      const response = await fetch(`https://api.stripe.com/v1/checkout/sessions/${created.id}?expand[]=line_items`, {
        headers: { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.ok).toBe(true);
      const session = await response.json();
      expect(session.payment_method_types).toEqual(["card", "link"]);
      expect(session.customer_creation).toBe("if_required");
      expect(session.customer_email).toBeNull();
      expect(session.customer).toBeNull();
      expect(session.customer_details).toBeNull();
      expect(session.expires_at).toBe(Math.floor(record.expiresAt / 1000));
      expect(session.line_items.data).toMatchObject([{ quantity: 1, amount_total: 500, currency: "usd", price: { unit_amount: 500 } }]);
      process.stdout.write(JSON.stringify({
        checkout_test_session: session.id, payment_method_types: session.payment_method_types,
        customer_creation: session.customer_creation, customer_email: session.customer_email,
        customer: session.customer, customer_details: session.customer_details,
        payment_method_collection: session.payment_method_collection,
      }) + "\n");
    } finally {
      const expired = await fetch(`https://api.stripe.com/v1/checkout/sessions/${created.id}/expire`, {
        method: "POST", headers: { Authorization: `Basic ${Buffer.from(`${KEY}:`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      });
      expect(expired.ok).toBe(true);
    }
  }, 60_000);
});
