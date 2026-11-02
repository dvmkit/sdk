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
 * 1. Disputes: an open or lost dispute on a funding PaymentIntent freezes the credit it
 *    funded; once every dispute on its PaymentIntents is won (or a warning closed), the
 *    credit is unfrozen and refundable again.
 * 2. Expiry: an expired card credit's balance becomes a refund to the card and the credit
 *    closes. It is never released to the builder.
 * 3. Retry: every pending card refund is advanced (Stripe still processing, rejected,
 *    unreachable).
 * 4. Stranded charges: a charge this DVM attempted, that Stripe completed, but that no credit
 *    booked, is refunded in full.
 *
 * Every step is idempotent and Postgres-only, like the expiry sweep: a ledger without the
 * optional card methods skips the steps that need them. A step, or one credit within a step,
 * that fails is logged and skipped, so one bad credit or a missing key permission cannot stop
 * the rest of the pass.
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
  unfrozen: string[];
  expiryRefunds: string[];
  completed: string[];
  pending: string[];
  strandedRefunds: string[];
  /** Steps that threw, by name; the rest of the pass still ran. */
  failedSteps: string[];
}

export interface CardRefundSweepOpts {
  nowMs?: number;
  limit?: number;
}

/** How far back each pass looks for disputes. Card networks allow about 120 days. */
const DISPUTE_LOOKBACK_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_DISPUTE_PAGES = 10;
/** Dispute statuses that leave the caller's money with the merchant: no freeze. */
const DISPUTE_SETTLED_FOR_MERCHANT = new Set(["won", "warning_closed"]);
/**
 * How old an attempt must be before an unbooked charge counts as stranded: well past the
 * five-minute challenge, after which a resend can no longer book it, and past the delay
 * before Stripe's search index shows a new PaymentIntent.
 */
const STRANDED_AFTER_MS = 30 * 60 * 1000;
/**
 * How long an attempt with no PaymentIntent in Stripe's search keeps being searched. Most
 * such attempts never reached Stripe; the window covers a search index that lags for hours.
 */
const STRANDED_SEARCH_WINDOW_MS = 24 * 60 * 60 * 1000;
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
    unfrozen: [],
    expiryRefunds: [],
    completed: [],
    pending: [],
    strandedRefunds: [],
    failedSteps: [],
  };
  const legDeps = {
    ledger: deps.ledger,
    stripe: deps.stripe,
    drainReport: deps.drainReport,
    ...(deps.receiptIssuer && { receiptIssuer: deps.receiptIssuer }),
  };
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch {
      result.failedSteps.push(name);
      diagnosticConsole.error({ event: "card_refund_sweep_step_failed", stage: name });
    }
  };

  await step("disputes", () => applyDisputes(deps, nowMs, result));

  const { listExpiredCardCredits, openCardExpiryRefund } = deps.ledger;
  if (listExpiredCardCredits && openCardExpiryRefund) {
    await step("expiry", async () => {
      for (const creditId of await listExpiredCardCredits.call(deps.ledger, { nowMs, limit })) {
        try {
          const drain = await openCardExpiryRefund.call(deps.ledger, { creditId, nowMs });
          if (drain) result.expiryRefunds.push(creditId);
        } catch {
          diagnosticConsole.error({ event: "card_refund_expiry_failed", credit_id: creditId });
        }
      }
    });
  }

  await step("retry", async () => {
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
  });

  const journal = deps.journal;
  if (journal && deps.ledger.cardFundingBooked) {
    await step("stranded", async () => {
      result.strandedRefunds = await refundStranded(deps, journal, nowMs, limit);
    });
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
          summary.unfrozen.length +
          summary.expiryRefunds.length +
          summary.completed.length +
          summary.pending.length +
          summary.strandedRefunds.length;
        if (moved === 0) return;
        diagnosticConsole.log({
          event: "card_refund_sweep",
          frozen: summary.frozen.length,
          unfrozen: summary.unfrozen.length,
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

/**
 * Freeze credits whose funding payment has an open or lost dispute, and unfreeze those
 * whose disputes all ended in the merchant's favour. The recent listing only nominates
 * candidates: a credit is unfrozen after every PaymentIntent that funded it is checked
 * with Stripe one by one, with no date bound, so a lost dispute keeps it frozen however
 * old it is.
 */
async function applyDisputes(
  deps: CardRefundSweepDeps,
  nowMs: number,
  result: CardRefundSweepResult
): Promise<void> {
  const freeze = deps.ledger.freezeCardCreditsForPaymentIntent?.bind(deps.ledger);
  if (!freeze) return;
  const statusesByIntent = new Map<string, string[]>();
  const createdGte = Math.floor((nowMs - DISPUTE_LOOKBACK_MS) / 1000);
  let startingAfter: string | undefined;
  try {
    for (let page = 0; page < MAX_DISPUTE_PAGES; page++) {
      const { disputes, hasMore } = await deps.stripe.listDisputes({
        createdGte,
        ...(startingAfter && { startingAfter }),
      });
      for (const dispute of disputes) {
        if (!dispute.paymentIntentId) continue;
        const statuses = statusesByIntent.get(dispute.paymentIntentId) ?? [];
        statuses.push(dispute.status);
        statusesByIntent.set(dispute.paymentIntentId, statuses);
      }
      if (!hasMore || disputes.length === 0) break;
      startingAfter = disputes[disputes.length - 1].id;
    }
  } finally {
    // Freeze on whatever was seen, even from a listing that failed part way.
    const blocking = new Set(
      [...statusesByIntent]
        .filter(([, statuses]) => !allSettledForMerchant(statuses))
        .map(([paymentIntentId]) => paymentIntentId)
    );
    for (const paymentIntentId of blocking) {
      result.frozen.push(...(await freeze(paymentIntentId)));
    }
    for (const paymentIntentId of statusesByIntent.keys()) {
      if (!blocking.has(paymentIntentId)) result.unfrozen.push(...(await unfreezeSettled(deps, paymentIntentId)));
    }
  }
}

async function unfreezeSettled(deps: CardRefundSweepDeps, paymentIntentId: string): Promise<string[]> {
  const candidates = deps.ledger.disputedCardCreditsFundedBy?.bind(deps.ledger);
  const unfreeze = deps.ledger.unfreezeCardCredit?.bind(deps.ledger);
  if (!candidates || !unfreeze) return [];
  const unfrozen: string[] = [];
  for (const credit of await candidates(paymentIntentId)) {
    let settled = true;
    for (const fundingIntent of credit.paymentIntentIds) {
      const { disputes, hasMore } = await deps.stripe.listDisputesForPaymentIntent(fundingIntent);
      if (hasMore || !allSettledForMerchant(disputes.map((dispute) => dispute.status))) {
        settled = false;
        break;
      }
    }
    if (settled && (await unfreeze(credit.creditId))) unfrozen.push(credit.creditId);
  }
  return unfrozen;
}

function allSettledForMerchant(statuses: readonly string[]): boolean {
  return statuses.every((status) => DISPUTE_SETTLED_FOR_MERCHANT.has(status));
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
      if (intents.length === 0) {
        // Nothing found yet: most likely the charge never reached Stripe, but a lagging
        // search index looks the same. Search again on later passes, within a window.
        if (nowMs - attempt.createdAt > STRANDED_SEARCH_WINDOW_MS) {
          await journal.resolve(attempt.challengeId, "not_found");
        }
        continue;
      }
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
