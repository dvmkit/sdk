import { randomUUID } from "node:crypto";
import type { CreditLedgerQuerier } from "../../credit-ledger";
import type { StripeCheckoutSession } from "../../stripe-checkout";
import type { StripeCheckoutRecord, StripeCheckoutStore } from "../../stripe-checkout-store";

/** In-process coordination only; database tests separately prove transactional money writes. */
export function checkoutTestStore(): StripeCheckoutStore {
  const records = new Map<string, StripeCheckoutRecord>();
  let tail = Promise.resolve();
  return {
    durable: true, namespace: randomUUID(),
    async create(record) { if (!records.has(record.fundId)) records.set(record.fundId, structuredClone(record)); },
    async get(fundId) { return records.has(fundId) ? structuredClone(records.get(fundId)!) : undefined; },
    async withRecord(fundId, run) {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        const record = structuredClone(records.get(fundId)!);
        const result = await run({ record,
          tx: { query() { throw new Error("Memory ledger must not query Postgres"); } } as CreditLedgerQuerier,
          async transition(from, to, sessionId, patch) {
            if (record.state !== from) throw new Error("Lost claim");
            Object.assign(record, patch);
            record.state = to;
            if (sessionId) record.sessionId = sessionId;
          },
        });
        records.set(fundId, record);
        return result;
      } finally { release(); }
    },
    async listRecoverable(nowMs, limit) {
      return [...records.values()].filter((r) => ["creating", "open", "refunding"].includes(r.state) && (r.expiresAt <= nowMs || (r.state === "creating" && r.createdAt + 1800_000 <= nowMs)) && (r.nextRecoveryAt ?? 0) <= nowMs)
        .slice(0, limit).map((r) => r.fundId);
    },
  };
}

export function fakeCheckoutAccount() {
  const sessions = new Map<string, StripeCheckoutSession>();
  const forms: URLSearchParams[] = [];
  const headers: Headers[] = [];
  const keys = new Map<string, { session: StripeCheckoutSession; form: string }>();
  const refunds: { id: string; amount: number; payment_intent: string; status: string; metadata: Record<string, string> }[] = [];
  let failCreateReply = false;
  let createStatus = 0;
  let readStatus = 0;
  const disputes = new Map<string, { id: string; payment_intent: string; status: string; amount: number; created: number }>();
  let failRead = false;
  let beforeCreate: (() => Promise<void>) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  let beforeRefund: (() => Promise<void>) | undefined;
  let failRefundReply = false;
  let searches = 0;
  const refunded = (id: string) => refunds.filter((r) => r.payment_intent === id).reduce((sum, r) => sum + r.amount, 0);
  const fetchImpl = (async (input, init) => {
    const url = new URL(String(input));
    const form = new URLSearchParams(init?.body as URLSearchParams);
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      forms.push(form);
      headers.push(new Headers(init.headers));
      const key = new Headers(init.headers).get("Idempotency-Key")!;
      if (createStatus) return Response.json({ error: { code: createStatus === 403 ? "permission_missing" : "invalid_request" } }, { status: createStatus });
      const cached = keys.get(key);
      if (cached && cached.form !== form.toString()) return Response.json({}, { status: 400 });
      let session = cached?.session;
      if (!session) {
        const id = `cs_test_${keys.size + 1}`;
        session = { id, url: `https://checkout.stripe.com/c/pay/${id}`,
          expires_at: Number(form.get("expires_at")), status: "open", payment_status: "unpaid",
          client_reference_id: form.get("client_reference_id"),
          metadata: Object.fromEntries(["fund_id", "credit_id", "caller_pubkey", "dvmkit_dvm_id", "dvmkit_checkout_store"].map((key) => [key, form.get(`metadata[${key}]`)!])),
          payment_intent: null };
        sessions.set(id, session);
        keys.set(key, { session, form: form.toString() });
      }
      await beforeCreate?.();
      if (failCreateReply) { failCreateReply = false; throw new Error("Lost create reply"); }
      return Response.json(session);
    }
    if (url.pathname.startsWith("/v1/checkout/sessions")) {
      await beforeRead?.();
      if (readStatus) return Response.json({ error: { code: "resource_missing" } }, { status: readStatus });
      if (failRead) throw new Error("Stripe read timed out");
      if (url.pathname === "/v1/checkout/sessions") { searches++; return Response.json({ data: [...sessions.values()], has_more: false }); }
      return Response.json(sessions.get(url.pathname.split("/").at(-1)!));
    }
    if (url.pathname === "/v1/payment_intents/search") {
      searches++;
      return Response.json({ data: [], has_more: false });
    }
    if (url.pathname.startsWith("/v1/payment_intents/")) {
      const id = url.pathname.split("/").at(-1)!;
      const pi = [...sessions.values()].find((s) => s.payment_intent?.id === id)!.payment_intent!;
      return Response.json({ ...pi, latest_charge: {
        amount_refunded: refunded(id), disputed: disputes.has(id), balance_transaction: { fee: 45, amount: 500 },
      } });
    }
    if (url.pathname === "/v1/refunds") {
      if (init?.method !== "POST") return Response.json({ data: refunds, has_more: false });
      await beforeRefund?.();
      const id = form.get("payment_intent")!;
      const refund = { id: `re_${refunds.length + 1}`, payment_intent: id, amount: Number(form.get("amount")), status: "succeeded",
        metadata: { dvmkit_checkout_fund_id: form.get("metadata[dvmkit_checkout_fund_id]")! } };
      refunds.push(refund);
      if (failRefundReply) { failRefundReply = false; throw new Error("Lost refund reply"); }
      return Response.json(refund);
    }
    if (url.pathname === "/v1/disputes") {
      const pi = url.searchParams.get("payment_intent");
      return Response.json({ data: [...disputes.values()].filter((d) => !pi || d.payment_intent === pi), has_more: false });
    }
    throw new Error(`Unexpected fake Stripe endpoint ${url.pathname}`);
  }) as typeof fetch;
  return {
    fetchImpl, sessions, forms, headers, refunds,
    get searches() { return searches; },
    loseCreateReply() { failCreateReply = true; },
    loseRefundReply() { failRefundReply = true; },
    rejectCreates(status: number) { createStatus = status; },
    rejectReads(status: number) { readStatus = status; },
    dispute(paymentIntentId: string, status: string, amount = 500) {
      disputes.set(paymentIntentId, { id: "dp_test", payment_intent: paymentIntentId, status, amount, created: Math.floor(Date.now() / 1000) });
    },
    failReads(value = true) { failRead = value; },
    onCreate(callback?: () => Promise<void>) { beforeCreate = callback; },
    onRead(callback?: () => Promise<void>) { beforeRead = callback; },
    onRefund(callback?: () => Promise<void>) { beforeRefund = callback; },
    paid(fundId: string) {
      const session = [...sessions.values()].find((s) => s.metadata.fund_id === fundId)!;
      const form = forms.find((f) => f.get("client_reference_id") === fundId)!;
      session.status = "complete";
      session.payment_status = "paid";
      session.payment_intent = { id: `pi_${session.id}`, amount: Number(form.get("line_items[0][price_data][unit_amount]")),
        currency: "usd", status: "succeeded", metadata: { ...session.metadata } };
      return session;
    },
  };
}

import { cardServer, HMAC, PRIVKEY, type App } from "./card-credit";
import { CREDIT_REQUEST_SCHEMA } from "../../credit-routes";
import { createSignedRequestVerifier } from "../../signed-request";
import { createStripeCreditRail } from "../../stripe-credit";

const signer = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
export async function checkoutServer(opts: Parameters<typeof cardServer>[0] & {
  checkoutStore?: StripeCheckoutStore;
  account?: ReturnType<typeof fakeCheckoutAccount>;
} = {}) {
  const account = opts.account ?? fakeCheckoutAccount();
  const store = opts.checkoutStore ?? checkoutTestStore();
  const rail = createStripeCreditRail({
    secretKey: "sk_test_fake", networkId: "profile_test", hmacSecret: HMAC,
    minUsd: "0.50", apiBase: "https://stripe.invalid", fetch: account.fetchImpl,
    checkoutSuccessUrl: "https://example.com/complete", checkoutStore: store,
  });
  const server = await cardServer({ ...opts, stripe: null, serverOpts: { stripeCredit: rail, ...opts.serverOpts } });
  return { ...server, account, rail, store };
}

export async function checkoutFund(app: App, fundId = "checkout", extra: Record<string, unknown> = {}, creditId?: string): Promise<Response> {
  return app.request("/v1/credit", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signer.signRequest(PRIVKEY, {
      op: "fund", ...(creditId && { credit_id: creditId }),
      fund: { method: "stripe", via: "checkout", fund_id: fundId, amount_micro: 5_000_000, ...extra },
    })),
  });
}
