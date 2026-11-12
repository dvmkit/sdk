import { createHash } from "node:crypto";

import type { StripeCheckoutRecord } from "./stripe-checkout-store";

export const CHECKOUT_LIFETIME_MS = 60 * 60 * 1000;

export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  expires_at: number;
  status: string;
  payment_status: string;
  client_reference_id: string | null;
  metadata: Record<string, string>;
  payment_intent: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    metadata: Record<string, string>;
  } | null;
}

export interface StripeCheckoutApi {
  create(record: StripeCheckoutRecord): Promise<StripeCheckoutSession>;
  retrieve(id: string): Promise<StripeCheckoutSession>;
}

export function checkoutSuccessUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Report the configuration variable, never its value. */ }
  throw new Error("DVMKIT_STRIPE_CHECKOUT_SUCCESS_URL must be a valid https URL.");
}

export function checkoutMetadata(record: StripeCheckoutRecord): Record<string, string> {
  return { fund_id: record.fundId, credit_id: record.creditId, caller_pubkey: record.callerPubkey,
    dvmkit_dvm_id: record.dvmId, dvmkit_checkout_store: record.storeNamespace,
  };
}

export function checkoutMatches(session: StripeCheckoutSession, record: StripeCheckoutRecord): boolean {
  const metadata = checkoutMetadata(record);
  return session.client_reference_id === record.fundId &&
    Object.entries(metadata).every(([key, value]) => session.metadata?.[key] === value);
}

export function paidCheckoutMatches(session: StripeCheckoutSession, record: StripeCheckoutRecord): boolean {
  const pi = session.payment_intent;
  return checkoutMatches(session, record) && session.payment_status === "paid" &&
    session.status === "complete" && !!pi?.id && pi.status === "succeeded" &&
    pi.amount === record.amountMicro / 10_000 && pi.currency === "usd" &&
    Object.entries(checkoutMetadata(record)).every(([key, value]) => pi.metadata?.[key] === value);
}

export function createStripeCheckoutApi(opts: {
  secretKey: string;
  apiBase?: string;
  fetch?: typeof fetch;
}): StripeCheckoutApi {
  const fetchImpl = opts.fetch ?? fetch;
  const call = async (path: string, form?: URLSearchParams, key?: string) => {
    const response = await fetchImpl(`${opts.apiBase ?? "https://api.stripe.com"}${path}`, {
      method: form ? "POST" : "GET",
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.secretKey}:`).toString("base64")}`,
        ...(form && { "Content-Type": "application/x-www-form-urlencoded" }),
        ...(key && { "Idempotency-Key": key }),
      },
      ...(form && { body: form }),
      signal: AbortSignal.timeout(15_000),
    });
    // Upstream error text may contain customer data. Only a fixed error leaves this module.
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: { code?: string } };
      throw new StripeCheckoutError(response.status, body.error?.code);
    }
    return response.json();
  };
  return {
    async create(record) {
      if (!Number.isSafeInteger(record.amountMicro) || record.amountMicro <= 0 || record.amountMicro % 10_000 !== 0) {
        throw new Error("Checkout amount must be whole USD cents");
      }
      const form = new URLSearchParams({
        mode: "payment",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(record.amountMicro / 10_000),
        "line_items[0][price_data][product_data][name]": record.productName,
        "line_items[0][quantity]": "1",
        "payment_method_types[0]": "card",
        "payment_method_types[1]": "link",
        expires_at: String(Math.floor(record.expiresAt / 1000)),
        success_url: record.successUrl,
        client_reference_id: record.fundId,
        submit_type: "pay",
        "adaptive_pricing[enabled]": "false",
        "expand[0]": "payment_intent",
      });
      for (const [key, value] of Object.entries(checkoutMetadata(record))) {
        form.set(`metadata[${key}]`, value);
        form.set(`payment_intent_data[metadata][${key}]`, value);
      }
      const key = `dvmkit-checkout-${createHash("sha256").update(JSON.stringify([record.dvmId, record.storeNamespace, record.fundId])).digest("hex")}`;
      return await call("/v1/checkout/sessions", form, key) as StripeCheckoutSession;
    },
    async retrieve(id) {
      return await call(`/v1/checkout/sessions/${encodeURIComponent(id)}?expand[]=payment_intent`) as StripeCheckoutSession;
    },
  };
}

export class StripeCheckoutError extends Error {
  readonly retryable: boolean;
  readonly causeCode: string;
  constructor(readonly status: number, code?: string) {
    super("Stripe Checkout request failed");
    this.retryable = status >= 500 || status === 409 || status === 429;
    this.causeCode = status === 403 ? "permission_denied" :
      (code && /^[a-z0-9_]{1,80}$/.test(code) ? code : "stripe_request_failed");
  }
}
