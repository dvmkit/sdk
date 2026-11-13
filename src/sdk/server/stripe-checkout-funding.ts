import { randomUUID } from "node:crypto";

import type { CreditFundingReport } from "./payment";
import { bookCheckoutFunding, type UpfrontPaymentOpts } from "./payment";
import { CHECKOUT_LIFETIME_MS, checkoutMatches, paidCheckoutMatches, StripeCheckoutError, type StripeCheckoutSession } from "./stripe-checkout";
import { withCheckoutInternalLock } from "./stripe-checkout-internal-lock";
import type { StripeCheckoutRecord } from "./stripe-checkout-store";
import type { StripeCreditRail } from "./stripe-credit";

export type CheckoutRail = NonNullable<StripeCreditRail["checkout"]>;
export type CheckoutResult =
  | { funded: true; replayed: boolean; deposit?: CreditFundingReport }
  | { funded: false; response: Response };

// Stripe requires expires_at to remain at least 30 minutes ahead of a new create.
export const CHECKOUT_CREATE_WINDOW_MS = 30 * 60 * 1000;
export const CHECKOUT_LEASE_MS = 30_000;

export function checkoutExpired(refunded = false, disputeLost = false): Response {
  return Response.json({
    error: "checkout_expired",
    message: "This Checkout top-up has expired; no credit can be booked.",
    hint: disputeLost
      ? "The card dispute was lost; no additional refund is due. Start a new top-up with a new fund_id."
      : refunded
      ? "What was still owed on the charge was refunded to the card. Start a new top-up with a new fund_id."
      : "Start a new top-up with a new fund_id. Any abandoned payment is automatically refunded to the card.",
    retryable: false,
  }, { status: 409 });
}

function mismatch(): Response {
  return Response.json({
    error: "payment_invalid", message: "The Checkout session does not match this signed top-up. No credit was booked.",
    retryable: false,
  }, { status: 409 });
}

function unavailable(error?: unknown): CheckoutResult {
  const stripe = error instanceof StripeCheckoutError ? error : undefined;
  const retryable = stripe?.retryable ?? true;
  return { funded: false, response: Response.json({
    error: "checkout_unavailable",
    message: stripe?.causeCode === "permission_denied"
      ? "Stripe denied Checkout access. The operator must grant the key Checkout Sessions permission."
      : "The service could not confirm this Checkout top-up's state.",
    hint: retryable ? "Retry the same fund_id and signed amount; do not start another payment."
      : "Ask the operator to resolve the Stripe request failure before starting another top-up.",
    retryable,
    ...(stripe && { cause: stripe.causeCode, stripe_status: stripe.status }),
  }, { status: retryable ? 503 : 502 }) };
}

function terminal(record: StripeCheckoutRecord): CheckoutResult | undefined {
  if (record.state === "booked") return { funded: true, replayed: true };
  if (["expired", "refunding", "refunded"].includes(record.state)) {
    return { funded: false, response: checkoutExpired(record.state === "refunded", record.terminalReason === "dispute_lost") };
  }
}

/** No saved id means no URL was exposed. Expiry must never adopt or refund another session. */
export async function expireUnshownCheckout(rail: CheckoutRail, fundId: string, nowMs: number): Promise<void> {
  await withCheckoutInternalLock(rail.store, fundId, async (locked) => {
    const record = locked.record;
    if (record.state === "creating" && !record.sessionId && (record.leaseUntil ?? 0) <= nowMs) {
      await locked.transition("creating", "expired", undefined, { leaseToken: undefined, leaseUntil: undefined });
    }
  });
}

async function createSession(rail: CheckoutRail, snapshot: StripeCheckoutRecord, nowMs: number): Promise<CheckoutResult> {
  if (nowMs >= snapshot.createdAt + CHECKOUT_CREATE_WINDOW_MS) {
    await expireUnshownCheckout(rail, snapshot.fundId, nowMs);
    const current = await rail.store.get(snapshot.fundId);
    return current ? terminal(current) ?? unavailable() : unavailable();
  }
  const token = randomUUID();
  const claimed = await withCheckoutInternalLock(rail.store, snapshot.fundId, async (locked) => {
    if (locked.record.state !== "creating" || (locked.record.leaseUntil ?? 0) > nowMs) return false;
    await locked.transition("creating", "creating", undefined, { leaseToken: token, leaseUntil: nowMs + CHECKOUT_LEASE_MS });
    return true;
  });
  if (!claimed) return unavailable();
  let session: StripeCheckoutSession;
  try {
    session = await rail.api.create(snapshot);
    if (!session.id || !checkoutMatches(session, snapshot)) throw new Error("Checkout create binding mismatch");
  } catch (error) {
    await withCheckoutInternalLock(rail.store, snapshot.fundId, async (locked) => {
      if (locked.record.state !== "creating" || locked.record.leaseToken !== token) return;
      await locked.transition("creating", error instanceof StripeCheckoutError && !error.retryable ? "expired" : "creating",
        undefined, { leaseToken: undefined, leaseUntil: undefined });
    });
    return unavailable(error);
  }
  try {
    return await withCheckoutInternalLock(rail.store, snapshot.fundId, async (locked) => {
      if (locked.record.state !== "creating" || locked.record.leaseToken !== token) return unavailable();
      await locked.transition("creating", "open", session.id, { leaseToken: undefined, leaseUntil: undefined });
      return pending(session, locked.record);
    });
  } catch (error) {
    await withCheckoutInternalLock(rail.store, snapshot.fundId, async (locked) => {
      if (locked.record.state === "creating" && locked.record.leaseToken === token) {
        await locked.transition("creating", "creating", undefined, { leaseToken: undefined, leaseUntil: undefined });
      }
    });
    throw error;
  }
}

function pending(session: StripeCheckoutSession, record: StripeCheckoutRecord): CheckoutResult {
  if (session.status !== "open" || !session.url || !Number.isSafeInteger(session.expires_at)) return unavailable();
  return { funded: false, response: Response.json({
    status: "pending", fund_id: record.fundId, credit_id: record.creditId,
    checkout: { url: session.url, expires_at: session.expires_at },
  }, { status: 202 }) };
}

export async function fundStripeCheckout(args: {
  rail: CheckoutRail; opts: UpfrontPaymentOpts; creditId: string; fundId: string;
  callerPubkey: string; amountMicro: number; productName: string;
  preflight: () => Promise<Response | undefined>; nowMs?: number;
}): Promise<CheckoutResult> {
  const { rail } = args;
  const nowMs = args.nowMs ?? Date.now();
  const dvmId = args.opts.canonicalDvmId ?? args.opts.dvmId ?? rail.store.namespace;
  if (args.fundId.length > 200 || !Number.isSafeInteger(args.amountMicro) || args.amountMicro <= 0 || args.amountMicro % 10_000 !== 0) {
    return { funded: false, response: Response.json({
      error: "invalid_request", message: "Checkout requires fund_id of at most 200 characters and a positive whole number of USD cents.", retryable: false,
    }, { status: 400 }) };
  }
  try {
    let snapshot = await rail.store.get(args.fundId);
    if (!snapshot || snapshot.state === "creating") {
      const refused = await args.preflight();
      if (refused) return { funded: false, response: refused };
      if (await args.opts.creditLedger?.getFunding({ creditId: args.creditId, fundId: args.fundId })) return { funded: false, response: mismatch() };
      if (!snapshot) {
        await rail.store.create({
          storeNamespace: rail.store.namespace, dvmId,
          fundId: args.fundId, creditId: args.creditId, callerPubkey: args.callerPubkey,
          amountMicro: args.amountMicro, createdAt: nowMs, expiresAt: nowMs + CHECKOUT_LIFETIME_MS,
          successUrl: rail.successUrl, productName: args.productName, state: "creating",
        });
        snapshot = await rail.store.get(args.fundId);
      }
    }
    if (!snapshot) return unavailable();
    if (snapshot.fundId !== args.fundId || snapshot.creditId !== args.creditId || snapshot.callerPubkey !== args.callerPubkey ||
      snapshot.amountMicro !== args.amountMicro || snapshot.storeNamespace !== rail.store.namespace || snapshot.dvmId !== dvmId) {
      return { funded: false, response: mismatch() };
    }
    const resolved = terminal(snapshot);
    if (resolved) return resolved;
    if (snapshot.state === "creating") return await createSession(rail, snapshot, nowMs);
    if (!snapshot.sessionId) return unavailable();
    // Stripe never runs under a database connection or row lock. A short NOWAIT transaction
    // rechecks the state after this read, so a sweep may win without permitting double booking.
    const session = await rail.api.retrieve(snapshot.sessionId);
    if (session.id !== snapshot.sessionId || !checkoutMatches(session, snapshot)) return { funded: false, response: mismatch() };
    return await rail.store.withRecord(args.fundId, async (locked): Promise<CheckoutResult> => {
      const record = locked.record;
      const finished = terminal(record);
      if (finished) return finished;
      if (record.state !== "open" || record.sessionId !== session.id) return unavailable();
      if (session.payment_status === "paid") {
        if (!paidCheckoutMatches(session, record)) return { funded: false, response: mismatch() };
        const deposit = await bookCheckoutFunding({ ...args.opts, creditId: record.creditId, fundId: record.fundId,
          callerPubkey: record.callerPubkey, amountMicro: record.amountMicro, paymentIntentId: session.payment_intent!.id,
        }, locked.tx);
        await locked.transition("open", "booked");
        return { funded: true, replayed: false, deposit };
      }
      if (session.status === "expired") {
        await locked.transition("open", "expired");
        return { funded: false, response: checkoutExpired() };
      }
      return pending(session, record);
    });
  } catch (error) {
    return unavailable(error);
  }
}
