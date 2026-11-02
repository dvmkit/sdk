import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { CardChargeJournal } from "./card-charge-journal";
import type { CreditLedgerLike } from "./credit-ledger";
import type { DrainReportWiring } from "./credit-drain-report";
import type { ReceiptIssuer } from "./receipt-issuer";
import { runStripeDrain } from "./stripe-drain-leg";
import type { StripeRefundApi } from "./stripe-refund-api";

/**
 * The periodic half of card refunds, run on the credit-expiry cadence. Stripe is polled,
 * never heard from: there is no webhook route. Each pass, in this order:
 *
 * 1. Disputes: a dispute on a funding PaymentIntent freezes the credit it funded.
 * 2. Expiry: an expired card credit's balance becomes a refund to the card and the credit
 *    closes. It is never released to the builder.
 * 3. Retry: every pending card refund is advanced (Stripe still processing, rejected,
 *    unreachable).
 * 4. Stranded charges: a charge this DVM attempted, that Stripe completed, but that no credit
 *    booked, is refunded in full.
 *
 * Every step is idempotent and Postgres-only, like the expiry sweep: a ledger without the
 * optional card methods skips the steps that need them.
 */
export interface CardRefundSweepDeps {
  ledger: CreditLedgerLike;
  stripe: StripeRefundApi;
  drainReport: DrainReportWiring;
  receiptIssuer?: ReceiptIssuer;
  journal?: CardChargeJournal;
}

export interface CardRefundSweepResult {
  frozen: string[];
  expiryRefunds: string[];
  completed: string[];
  pending: string[];
  strandedRefunds: string[];
}

export interface CardRefundSweepOpts {
  nowMs?: number;
  limit?: number;
}

/** How far back each pass looks for disputes. Card networks allow about 120 days. */
const DISPUTE_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_DISPUTE_PAGES = 10;
/**
 * How old an attempt must be before an unbooked charge counts as stranded: well past the
 * five-minute challenge, after which a resend can no longer book it, and past the delay
 * before Stripe's search index shows a new PaymentIntent.
 */
const STRANDED_AFTER_MS = 30 * 60 * 1000;
/** Give up on an attempt whose PaymentIntent never settles; it is logged for an operator. */
const STRANDED_ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export async function runCardRefundSweep(
  deps: CardRefundSweepDeps,
  opts: CardRefundSweepOpts = {}
): Promise<CardRefundSweepResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const limit = opts.limit ?? 200;
  const result: CardRefundSweepResult = {
    frozen: [],
    expiryRefunds: [],
    completed: [],
    pending: [],
    strandedRefunds: [],
  };
  const legDeps = {
    ledger: deps.ledger,
    stripe: deps.stripe,
    drainReport: deps.drainReport,
    ...(deps.receiptIssuer && { receiptIssuer: deps.receiptIssuer }),
  };

  if (deps.ledger.freezeCardCreditsForPaymentIntent) {
    result.frozen = await freezeDisputed(deps, nowMs);
  }

  if (deps.ledger.listExpiredCardCredits && deps.ledger.openCardExpiryRefund) {
    for (const creditId of await deps.ledger.listExpiredCardCredits({ nowMs, limit })) {
      const drain = await deps.ledger.openCardExpiryRefund({ creditId, nowMs });
      if (drain) result.expiryRefunds.push(creditId);
    }
  }

  const pending = (await deps.ledger.listPendingDrains()).filter(
    (drain) => drain.method === "stripe" && drain.status === "pending"
  );
  for (const drain of pending.slice(0, limit)) {
    try {
      const { drain: after } = await runStripeDrain(legDeps, drain);
      (after.status === "sent" ? result.completed : result.pending).push(
        `${drain.creditId}:${drain.drainId}`
      );
    } catch {
      result.pending.push(`${drain.creditId}:${drain.drainId}`);
    }
  }

  if (deps.journal && deps.ledger.cardFundingBooked) {
    result.strandedRefunds = await refundStranded(deps, deps.journal, nowMs, limit);
  }
  return result;
}

/**
 * Start the sweep on the expiry sweep's cadence. Returns undefined when the ledger cannot
 * hold card refunds. Timers are unref'ed; a failed pass is logged and the next one retries.
 */
export function startCardRefundSweep(
  deps: CardRefundSweepDeps,
  opts: { intervalMs?: number; bootDelayMs?: number; limit?: number } = {}
): { stop(): void; runOnce(): Promise<CardRefundSweepResult> } | undefined {
  if (!deps.ledger.saveCardRefund) return undefined;
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const bootDelayMs = opts.bootDelayMs ?? 30_000;
  let stopped = false;
  const runOnce = () => runCardRefundSweep(deps, { limit: opts.limit });
  const pass = (): void => {
    if (stopped) return;
    void runOnce()
      .then((summary) => {
        const moved =
          summary.frozen.length +
          summary.expiryRefunds.length +
          summary.completed.length +
          summary.pending.length +
          summary.strandedRefunds.length;
        if (moved === 0) return;
        diagnosticConsole.log({
          event: "card_refund_sweep",
          frozen: summary.frozen.length,
          expiry_refunds: summary.expiryRefunds.length,
          completed: summary.completed.length,
          pending: summary.pending.length,
          stranded_refunds: summary.strandedRefunds.length,
        });
      })
      .catch(() => {
        diagnosticConsole.error({ event: "card_refund_sweep_failed" });
      });
  };
  const bootTimer = bootDelayMs > 0 ? setTimeout(pass, bootDelayMs) : undefined;
  bootTimer?.unref();
  const intervalTimer = intervalMs > 0 ? setInterval(pass, intervalMs) : undefined;
  intervalTimer?.unref();
  return {
    stop() {
      stopped = true;
      if (bootTimer) clearTimeout(bootTimer);
      if (intervalTimer) clearInterval(intervalTimer);
    },
    runOnce,
  };
}

async function freezeDisputed(deps: CardRefundSweepDeps, nowMs: number): Promise<string[]> {
  const freeze = deps.ledger.freezeCardCreditsForPaymentIntent?.bind(deps.ledger);
  if (!freeze) return [];
  const frozen: string[] = [];
  const createdGte = Math.floor((nowMs - DISPUTE_LOOKBACK_MS) / 1000);
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_DISPUTE_PAGES; page++) {
    const { disputes, hasMore } = await deps.stripe.listDisputes({
      createdGte,
      ...(startingAfter && { startingAfter }),
    });
    for (const dispute of disputes) {
      if (dispute.paymentIntentId) frozen.push(...(await freeze(dispute.paymentIntentId)));
    }
    if (!hasMore || disputes.length === 0) break;
    startingAfter = disputes[disputes.length - 1].id;
  }
  return frozen;
}

async function refundStranded(
  deps: CardRefundSweepDeps,
  journal: CardChargeJournal,
  nowMs: number,
  limit: number
): Promise<string[]> {
  const booked = deps.ledger.cardFundingBooked?.bind(deps.ledger);
  if (!booked) return [];
  const refunded: string[] = [];
  const attempts = await journal.listUnresolved({ olderThanMs: nowMs - STRANDED_AFTER_MS, limit });
  for (const attempt of attempts) {
    try {
      const intents = await deps.stripe.searchPaymentIntentsByMetadata(
        "mpp_challenge_id",
        attempt.challengeId
      );
      let unsettled = false;
      let refundedHere = 0;
      for (const intent of intents) {
        if (intent.status !== "succeeded") {
          if (intent.status !== "canceled" && intent.status !== "requires_payment_method") {
            unsettled = true;
          }
          continue;
        }
        if (await booked(intent.id)) continue;
        const charge = await deps.stripe.retrieveCharge(intent.id);
        const owed = charge.amount - charge.amountRefunded;
        if (owed > 0 && !charge.disputed) {
          await deps.stripe.createRefund({
            paymentIntentId: intent.id,
            amount: owed,
            idempotencyKey: `dvmkit-stranded-${intent.id}`,
            metadata: { dvmkit_stranded: "true" },
          });
          refunded.push(intent.id);
          refundedHere += 1;
          diagnosticConsole.warn({ event: "card_charge_stranded_refunded", payment_intent: intent.id });
        }
      }
      if (!unsettled) {
        await journal.resolve(attempt.challengeId, refundedHere > 0 ? "refunded" : "settled");
      } else if (nowMs - attempt.createdAt > STRANDED_ABANDON_AFTER_MS) {
        diagnosticConsole.error({ event: "card_charge_unsettled", challenge_id: attempt.challengeId });
        await journal.resolve(attempt.challengeId, "unsettled");
      }
    } catch {
      // Left unresolved; the next pass asks Stripe again.
    }
  }
  return refunded;
}
