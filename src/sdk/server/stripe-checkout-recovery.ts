import { randomUUID } from "node:crypto";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import { CHECKOUT_CREATE_WINDOW_MS, CHECKOUT_LEASE_MS, expireUnshownCheckout, type CheckoutRail } from "./stripe-checkout-funding";
import { checkoutMatches, paidCheckoutMatches, StripeCheckoutError } from "./stripe-checkout";
import { withCheckoutInternalLock } from "./stripe-checkout-internal-lock";
import type { StripeRefundApi } from "./stripe-refund-api";

// Give the caller CLI a day to resume a top-up from its own journal after a restart.
export const CHECKOUT_ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;
// Disputes, unavailable evidence and pending refunds must leave room for newer sessions.
export const CHECKOUT_RECOVERY_BACKOFF_MS = 60 * 60 * 1000;

export async function refundAbandonedCheckouts(
  rail: CheckoutRail, stripe: StripeRefundApi, nowMs: number, limit: number
): Promise<string[]> {
  const refunded: string[] = [];
  for (const fundId of await rail.store.listRecoverable(nowMs, limit)) {
    let token: string | undefined;
    let sessionId: string | undefined;
    try {
      const snapshot = await rail.store.get(fundId);
      if (!snapshot || ["booked", "expired", "refunded"].includes(snapshot.state)) continue;
      if (snapshot.state === "creating" && !snapshot.sessionId) {
        if (nowMs >= snapshot.createdAt + CHECKOUT_CREATE_WINDOW_MS) await expireUnshownCheckout(rail, fundId, nowMs);
        continue;
      }
      if (!snapshot.sessionId) throw new Error("Checkout session id missing");
      sessionId = snapshot.sessionId;
      const session = await rail.api.retrieve(sessionId);
      if (session.id !== snapshot.sessionId || !checkoutMatches(session, snapshot)) throw new Error("Checkout recovery binding mismatch");
      const claimToken = randomUUID();
      const claim = await withCheckoutInternalLock(rail.store, fundId, async (locked) => {
        const record = locked.record;
        if (!["open", "refunding"].includes(record.state) || (record.leaseUntil ?? 0) > nowMs) return;
        if (record.sessionId !== session.id) throw new Error("Checkout recovery session mismatch");
        const nextRecoveryAt = Math.max(nowMs + CHECKOUT_RECOVERY_BACKOFF_MS, record.createdAt + CHECKOUT_ABANDONED_AFTER_MS);
        if (session.payment_status !== "paid") {
          await locked.transition(record.state, session.status === "expired" && record.state === "open" ? "expired" : record.state,
            undefined, { nextRecoveryAt: nowMs + CHECKOUT_RECOVERY_BACKOFF_MS });
          return;
        }
        if (!paidCheckoutMatches(session, record)) throw new Error("Checkout recovery payment mismatch");
        if (nowMs < record.createdAt + CHECKOUT_ABANDONED_AFTER_MS) {
          await locked.transition(record.state, record.state, undefined, { nextRecoveryAt });
          return;
        }
        await locked.transition(record.state, "refunding", undefined, {
          leaseToken: claimToken, leaseUntil: nowMs + CHECKOUT_LEASE_MS, nextRecoveryAt,
        });
        return { id: session.payment_intent!.id, amount: record.amountMicro / 10_000 };
      });
      if (!claim) continue;
      token = claimToken;
      // The refund claim is durable before any external effect. No Stripe request owns a DB
      // connection; a crashed worker's lease expires, and evidence/idempotency reconcile it.
      const charge = await stripe.retrieveCharge(claim.id);
      if (charge.amount !== claim.amount || charge.currency !== "usd" || charge.status !== "succeeded") {
        throw new Error("Checkout refund charge mismatch");
      }
      let lostDisputeAmount = 0;
      if (charge.disputed) {
        // Charge.disputed records history; only the dispute's outcome decides whether
        // Stripe still owes the cardholder a refund.
        const page = await stripe.listDisputesForPaymentIntent(claim.id);
        if (page.hasMore || !page.disputes.length || page.disputes.some((d) => d.paymentIntentId !== claim.id)) {
          throw new Error("Checkout dispute evidence incomplete");
        }
        if (!page.disputes.every((d) => d.status === "lost" || ["won", "warning_closed", "prevented"].includes(d.status))) {
          throw new Error("Checkout dispute remains open");
        }
        for (const dispute of page.disputes.filter((d) => d.status === "lost")) {
          if (dispute.amount === undefined || !Number.isSafeInteger(dispute.amount) || dispute.amount < 0) {
            throw new Error("Checkout lost dispute amount missing");
          }
          lostDisputeAmount += dispute.amount;
        }
        if (!Number.isSafeInteger(lostDisputeAmount)) throw new Error("Checkout lost dispute amount overflow");
      }
      const owed = claim.amount - charge.amountRefunded - lostDisputeAmount;
      if (lostDisputeAmount >= claim.amount) {
        if (await finishRecovery(rail, fundId, token, "dispute_lost")) {
          diagnosticConsole.warn({ event: "card_checkout_dispute_lost", session_id: sessionId, payment_intent: claim.id });
        }
        continue;
      }
      if (owed > 0) {
        const refunds = (await stripe.listRefunds(claim.id)).filter((r) => r.metadata.dvmkit_checkout_fund_id === fundId);
        if (refunds.some((r) => r.status !== "succeeded" && r.status !== "failed" && r.status !== "canceled")) continue;
        const refund = await stripe.createRefund({ paymentIntentId: claim.id, amount: owed,
          idempotencyKey: `dvmkit-checkout-refund-${claim.id}`, metadata: { dvmkit_checkout_fund_id: fundId },
        });
        if (refund.status !== "succeeded" || refund.amount !== owed || refund.paymentIntentId !== claim.id) continue;
      }
      const completed = await finishRecovery(rail, fundId, token, "refunded");
      if (completed) refunded.push(claim.id);
    } catch (error) {
      // A busy row belongs to another short transaction; do not overwrite its scheduling.
      if ((error as { code?: string })?.code !== "55P03") {
        await withCheckoutInternalLock(rail.store, fundId, async (locked) => {
          if (!["open", "refunding"].includes(locked.record.state)) return;
          if (locked.record.leaseToken && locked.record.leaseToken !== token) return;
          await locked.transition(locked.record.state, locked.record.state, undefined, { nextRecoveryAt: nowMs + CHECKOUT_RECOVERY_BACKOFF_MS });
        }).catch(() => {});
        const event = error instanceof StripeCheckoutError && error.status === 403 ? "card_checkout_session_permission_denied"
          : error instanceof StripeCheckoutError && error.status === 404 ? "card_checkout_session_missing"
            : "card_checkout_recovery_deferred";
        diagnosticConsole.warn({ event, session_id: sessionId, retry_after_ms: CHECKOUT_RECOVERY_BACKOFF_MS });
      }
    } finally {
      if (token) await withCheckoutInternalLock(rail.store, fundId, async (locked) => {
        if (locked.record.state === "refunding" && locked.record.leaseToken === token) {
          await locked.transition("refunding", "refunding", undefined, { leaseToken: undefined, leaseUntil: undefined });
        }
      }).catch(() => {});
    }
  }
  return refunded;
}

async function finishRecovery(rail: CheckoutRail, fundId: string, token: string, outcome: "refunded" | "dispute_lost"): Promise<boolean> {
  return withCheckoutInternalLock(rail.store, fundId, async (locked) => {
    if (locked.record.state !== "refunding" || locked.record.leaseToken !== token) return false;
    await locked.transition("refunding", outcome === "dispute_lost" ? "expired" : "refunded", undefined, {
      leaseToken: undefined, leaseUntil: undefined, terminalReason: outcome === "dispute_lost" ? "dispute_lost" : undefined,
    });
    return true;
  });
}
