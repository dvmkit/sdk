/* A fake Stripe account for card refunds: PaymentIntent create (idempotent on the key) and
 * retrieve with the charge's balance transaction, refunds, disputes and PaymentIntent search.
 * The fee is Stripe's US card price, 2.9% + 30 cents, so expected figures can be worked by
 * hand from the pricing page rather than from the code under test. */

export interface FakeIntent {
  id: string;
  amount: number;
  currency: string;
  status: string;
  refunded: number;
  disputed: boolean;
  created: number;
  metadata: Record<string, string>;
}

export interface FakeRefund {
  id: string;
  payment_intent: string;
  amount: number;
  status: string;
  metadata: Record<string, string>;
}

export interface FakeCall {
  method: string;
  path: string;
  idempotencyKey: string | null;
  body: URLSearchParams;
}

/** Stripe's US card fee on a charge of `amount` cents. */
export function cardFee(amount: number): number {
  return Math.round(amount * 0.029) + 30;
}

export function fakeStripeAccount() {
  const calls: FakeCall[] = [];
  const intents = new Map<string, FakeIntent>();
  const intentByKey = new Map<string, string>();
  const refunds = new Map<string, FakeRefund>();
  const refundByKey = new Map<string, string>();
  const disputes: { id: string; payment_intent: string; created: number; status: string }[] = [];
  const control = {
    /** Refuse the next N refund creates with a 400, as Stripe does for a refused refund. */
    rejectRefunds: 0,
    /** Drop the connection on the next N refund creates before Stripe records anything. */
    unreachableRefunds: 0,
    /** Create the next N refunds, then drop the connection before the answer arrives. */
    loseRefundResponses: 0,
    /** Status new refunds take. */
    refundStatus: "succeeded",
  };

  function seedIntent(intent: Partial<FakeIntent> & { id: string; amount: number }): FakeIntent {
    const full: FakeIntent = {
      currency: "usd",
      status: "succeeded",
      refunded: 0,
      disputed: false,
      created: Math.floor(Date.now() / 1000),
      metadata: {},
      ...intent,
    };
    intents.set(full.id, full);
    return full;
  }

  /** Open a dispute. Stripe keeps `charge.disputed` true for good, whatever the outcome. */
  function dispute(paymentIntentId: string, status = "needs_response"): void {
    const intent = intents.get(paymentIntentId);
    if (intent) intent.disputed = true;
    disputes.unshift({
      id: `dp_${disputes.length + 1}`,
      payment_intent: paymentIntentId,
      created: Math.floor(Date.now() / 1000),
      status,
    });
  }

  /** Close every dispute on a PaymentIntent with `status` (won, lost). */
  function settleDisputes(paymentIntentId: string, status: string): void {
    for (const entry of disputes) if (entry.payment_intent === paymentIntentId) entry.status = status;
  }

  /** Stripe refuses a refund while a dispute is open, and after it is lost. */
  function refundBlocked(paymentIntentId: string): boolean {
    return disputes.some(
      (entry) =>
        entry.payment_intent === paymentIntentId &&
        entry.status !== "won" &&
        entry.status !== "warning_closed"
    );
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const idempotencyKey = headers.get("Idempotency-Key");
    const body = new URLSearchParams(init?.body as URLSearchParams);
    calls.push({ method, path: url.pathname, idempotencyKey, body });
    const path = url.pathname;

    if (method === "POST" && path === "/v1/payment_intents") {
      const key = idempotencyKey ?? `anon-${calls.length}`;
      const replayed = intentByKey.has(key);
      if (!replayed) {
        const metadata: Record<string, string> = {};
        for (const [name, value] of body) {
          const match = /^metadata\[(.+)\]$/.exec(name);
          if (match) metadata[match[1]] = value;
        }
        const id = `pi_test_${intents.size + 1}`;
        seedIntent({ id, amount: Number(body.get("amount")), metadata });
        intentByKey.set(key, id);
      }
      const intent = intents.get(intentByKey.get(key) as string) as FakeIntent;
      return Response.json(
        { id: intent.id, status: intent.status, amount: intent.amount, currency: intent.currency },
        { headers: replayed ? { "idempotent-replayed": "true" } : {} }
      );
    }
    if (method === "GET" && path === "/v1/payment_intents/search") {
      const match = /^metadata\['(.+)'\]:'(.+)'$/.exec(url.searchParams.get("query") ?? "");
      const data = match
        ? [...intents.values()].filter((intent) => intent.metadata[match[1]] === match[2])
        : [];
      return Response.json({ data: data.map(intentBody) });
    }
    const intentMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (method === "GET" && intentMatch) {
      const intent = intents.get(intentMatch[1]);
      if (!intent) return missing();
      return Response.json({
        ...intentBody(intent),
        latest_charge: {
          amount_refunded: intent.refunded,
          disputed: intent.disputed,
          balance_transaction: { amount: intent.amount, fee: cardFee(intent.amount), currency: "usd" },
        },
      });
    }
    if (method === "POST" && path === "/v1/refunds") {
      if (control.unreachableRefunds > 0) {
        control.unreachableRefunds -= 1;
        throw new TypeError("fetch failed: connect ETIMEDOUT");
      }
      const key = idempotencyKey ?? `anon-${calls.length}`;
      const known = refundByKey.get(key);
      if (known) return Response.json(refundBody(refunds.get(known) as FakeRefund));
      const intent = intents.get(body.get("payment_intent") ?? "");
      if (!intent) return missing();
      const amount = Number(body.get("amount"));
      if (control.rejectRefunds > 0) {
        control.rejectRefunds -= 1;
        return Response.json(
          { error: { type: "invalid_request_error", code: "charge_disputed", message: "free text" } },
          { status: 400 }
        );
      }
      if (refundBlocked(intent.id)) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "charge_disputed" } },
          { status: 400 }
        );
      }
      if (amount > intent.amount - intent.refunded) {
        return Response.json(
          { error: { type: "invalid_request_error", code: "amount_too_large" } },
          { status: 400 }
        );
      }
      const metadata: Record<string, string> = {};
      for (const [name, value] of body) {
        const match = /^metadata\[(.+)\]$/.exec(name);
        if (match) metadata[match[1]] = value;
      }
      const refund: FakeRefund = {
        id: `re_test_${refunds.size + 1}`,
        payment_intent: intent.id,
        amount,
        status: control.refundStatus,
        metadata,
      };
      refunds.set(refund.id, refund);
      refundByKey.set(key, refund.id);
      intent.refunded += amount;
      if (control.loseRefundResponses > 0) {
        control.loseRefundResponses -= 1;
        throw new TypeError("fetch failed: socket hang up");
      }
      return Response.json(refundBody(refund));
    }
    if (method === "GET" && path === "/v1/refunds") {
      const pi = url.searchParams.get("payment_intent");
      const data = [...refunds.values()].filter((refund) => refund.payment_intent === pi);
      return Response.json({ data: data.map(refundBody), has_more: false });
    }
    const refundMatch = /^\/v1\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && refundMatch) {
      const refund = refunds.get(refundMatch[1]);
      return refund ? Response.json(refundBody(refund)) : missing();
    }
    if (method === "GET" && path === "/v1/disputes") {
      return Response.json({ data: disputes, has_more: false });
    }
    return missing();
  }) as typeof fetch;

  /** Stripe keeps idempotency keys for 24 hours; after that a key creates afresh. */
  function forgetIdempotencyKeys(): void {
    refundByKey.clear();
  }

  return {
    calls,
    intents,
    refunds,
    control,
    fetchImpl,
    seedIntent,
    dispute,
    settleDisputes,
    forgetIdempotencyKeys,
  };
}

export type FakeStripeAccount = ReturnType<typeof fakeStripeAccount>;

function intentBody(intent: FakeIntent): Record<string, unknown> {
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    created: intent.created,
    metadata: intent.metadata,
  };
}

function refundBody(refund: FakeRefund): Record<string, unknown> {
  return { object: "refund", ...refund };
}

function missing(): Response {
  return Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 });
}
