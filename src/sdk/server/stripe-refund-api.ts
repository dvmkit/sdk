/**
 * The handful of Stripe reads and writes card refunds need, over raw `fetch`
 * (the SDK takes no `stripe` dependency).
 *
 * Every failure is reported by HTTP status and Stripe's own enum codes only.
 * Stripe's free-text messages are never kept: on this account they can quote
 * payment details the caller's agent should not see echoed back.
 */

export interface StripeRefundApiOpts {
  secretKey: string;
  /** Stripe API origin. Tests point it at a local fake. */
  apiBase?: string;
  fetch?: typeof fetch;
}

/** What a refund needs to know about the charge behind one funding PaymentIntent. */
export interface StripeChargeFacts {
  paymentIntentId: string;
  status: string;
  /** What the PaymentIntent charged, in the charge currency's minor unit (cents). */
  amount: number;
  currency: string;
  /** Already refunded against the charge, in the charge currency's minor unit. */
  amountRefunded: number;
  disputed: boolean;
  /**
   * Stripe's processing fee as a share of the charge: `fee` over `amount` from the charge's
   * balance transaction, both in the settlement currency. Null while Stripe has not
   * written the balance transaction yet.
   */
  fee: { fee: number; settledAmount: number } | null;
}

export interface StripeRefund {
  id: string;
  status: string;
  amount: number;
  paymentIntentId: string | null;
  metadata: Record<string, string>;
}

export interface StripeDispute {
  id: string;
  paymentIntentId: string | null;
  status: string;
  created: number;
}

export interface StripePaymentIntentSummary {
  id: string;
  status: string;
  amount: number;
  currency: string;
  created: number;
}

/** A Stripe call that did not succeed. `status` is 0 when no HTTP answer arrived. */
export class StripeApiError extends Error {
  readonly status: number;
  readonly type?: string;
  readonly code?: string;
  constructor(status: number, codes: { type?: string; code?: string }) {
    super(status === 0 ? "Stripe could not be reached" : `Stripe answered HTTP ${status}`);
    this.name = "StripeApiError";
    this.status = status;
    if (codes.type) this.type = codes.type;
    if (codes.code) this.code = codes.code;
  }

  /** Stripe looked at the request and refused it; repeating it unchanged will not help. */
  get rejected(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 409 && this.status !== 429;
  }
}

export interface StripeRefundApi {
  retrieveCharge(paymentIntentId: string): Promise<StripeChargeFacts>;
  listRefunds(paymentIntentId: string): Promise<StripeRefund[]>;
  createRefund(args: {
    paymentIntentId: string;
    amount: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
  }): Promise<StripeRefund>;
  retrieveRefund(refundId: string): Promise<StripeRefund>;
  /** One page of disputes created at or after `createdGte` (unix seconds), newest first. */
  listDisputes(args: {
    createdGte: number;
    startingAfter?: string;
  }): Promise<{ disputes: StripeDispute[]; hasMore: boolean }>;
  /** Every dispute on one PaymentIntent, however old (first page of 100; a charge has one). */
  listDisputesForPaymentIntent(
    paymentIntentId: string
  ): Promise<{ disputes: StripeDispute[]; hasMore: boolean }>;
  /** PaymentIntents whose `metadata[key]` equals `value`, via Stripe's search API. */
  searchPaymentIntentsByMetadata(key: string, value: string): Promise<StripePaymentIntentSummary[]>;
}

export function createStripeRefundApi(opts: StripeRefundApiOpts): StripeRefundApi {
  const apiBase = opts.apiBase ?? "https://api.stripe.com";
  const fetchImpl = opts.fetch ?? fetch;
  const auth = `Basic ${Buffer.from(`${opts.secretKey}:`).toString("base64")}`;

  const call = async (
    method: "GET" | "POST",
    path: string,
    args: { query?: URLSearchParams; form?: URLSearchParams; idempotencyKey?: string } = {}
  ): Promise<Record<string, unknown>> => {
    const url = `${apiBase}${path}${args.query ? `?${args.query.toString()}` : ""}`;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: auth,
          ...(args.form && { "Content-Type": "application/x-www-form-urlencoded" }),
          ...(args.idempotencyKey && { "Idempotency-Key": args.idempotencyKey }),
        },
        ...(args.form && { body: args.form }),
      });
    } catch {
      throw new StripeApiError(0, {});
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error = (body.error ?? {}) as Record<string, unknown>;
      throw new StripeApiError(response.status, {
        type: enumField(error.type),
        code: enumField(error.code),
      });
    }
    return body;
  };

  return {
    async retrieveCharge(paymentIntentId) {
      const query = new URLSearchParams([["expand[]", "latest_charge.balance_transaction"]]);
      const pi = await call("GET", `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, {
        query,
      });
      const charge = isRecord(pi.latest_charge) ? pi.latest_charge : undefined;
      const txn = charge && isRecord(charge.balance_transaction) ? charge.balance_transaction : undefined;
      return {
        paymentIntentId,
        status: stringOr(pi.status, "unknown"),
        amount: integerOr(pi.amount, 0),
        currency: stringOr(pi.currency, ""),
        amountRefunded: integerOr(charge?.amount_refunded, 0),
        disputed: charge?.disputed === true,
        fee:
          txn && Number.isSafeInteger(txn.fee) && Number.isSafeInteger(txn.amount) && (txn.amount as number) > 0
            ? { fee: txn.fee as number, settledAmount: txn.amount as number }
            : null,
      };
    },

    async listRefunds(paymentIntentId) {
      const query = new URLSearchParams({ payment_intent: paymentIntentId, limit: "100" });
      const page = await call("GET", "/v1/refunds", { query });
      return arrayOf(page.data).map(refundFrom);
    },

    async createRefund(args) {
      const form = new URLSearchParams({
        payment_intent: args.paymentIntentId,
        amount: String(args.amount),
      });
      for (const [key, value] of Object.entries(args.metadata)) form.set(`metadata[${key}]`, value);
      return refundFrom(
        await call("POST", "/v1/refunds", { form, idempotencyKey: args.idempotencyKey })
      );
    },

    async retrieveRefund(refundId) {
      return refundFrom(await call("GET", `/v1/refunds/${encodeURIComponent(refundId)}`));
    },

    async listDisputes(args) {
      const query = new URLSearchParams({ "created[gte]": String(args.createdGte), limit: "100" });
      if (args.startingAfter) query.set("starting_after", args.startingAfter);
      const page = await call("GET", "/v1/disputes", { query });
      return {
        disputes: arrayOf(page.data).map((d) => ({
          id: stringOr(d.id, ""),
          paymentIntentId: typeof d.payment_intent === "string" ? d.payment_intent : null,
          status: stringOr(d.status, "unknown"),
          created: integerOr(d.created, 0),
        })),
        hasMore: page.has_more === true,
      };
    },

    async listDisputesForPaymentIntent(paymentIntentId) {
      const query = new URLSearchParams({ payment_intent: paymentIntentId, limit: "100" });
      const page = await call("GET", "/v1/disputes", { query });
      return {
        disputes: arrayOf(page.data).map((d) => ({
          id: stringOr(d.id, ""),
          paymentIntentId: typeof d.payment_intent === "string" ? d.payment_intent : null,
          status: stringOr(d.status, "unknown"),
          created: integerOr(d.created, 0),
        })),
        hasMore: page.has_more === true,
      };
    },

    async searchPaymentIntentsByMetadata(key, value) {
      // Stripe's query language quotes values with single quotes; ids never contain one.
      if (!/^[A-Za-z0-9_-]+$/.test(key) || !/^[A-Za-z0-9_-]+$/.test(value)) return [];
      const query = new URLSearchParams({ query: `metadata['${key}']:'${value}'`, limit: "20" });
      const page = await call("GET", "/v1/payment_intents/search", { query });
      return arrayOf(page.data).map((pi) => ({
        id: stringOr(pi.id, ""),
        status: stringOr(pi.status, "unknown"),
        amount: integerOr(pi.amount, 0),
        currency: stringOr(pi.currency, ""),
        created: integerOr(pi.created, 0),
      }));
    },
  };
}

function refundFrom(body: Record<string, unknown>): StripeRefund {
  const metadata: Record<string, string> = {};
  if (isRecord(body.metadata)) {
    for (const [key, value] of Object.entries(body.metadata)) {
      if (typeof value === "string") metadata[key] = value;
    }
  }
  return {
    id: stringOr(body.id, ""),
    status: stringOr(body.status, "unknown"),
    amount: integerOr(body.amount, 0),
    paymentIntentId: typeof body.payment_intent === "string" ? body.payment_intent : null,
    metadata,
  };
}

function enumField(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function integerOr(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) ? (value as number) : fallback;
}
