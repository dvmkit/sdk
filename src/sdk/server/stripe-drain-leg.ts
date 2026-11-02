import { createHash } from "node:crypto";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import { commitTerminalDrain, type DrainReportWiring } from "./credit-drain-report";
import type {
  CardRefundEntry,
  CardRefundPlan,
  CreditDrainRecord,
  CreditLedgerLike,
} from "./credit-ledger";
import { isCardFundedRail } from "./credit-lots";
import type { ReceiptIssuer } from "./receipt-issuer";
import { StripeApiError, type StripeChargeFacts, type StripeRefundApi } from "./stripe-refund-api";

/** Everything a refund of card credit writes and calls through. */
export interface StripeDrainLegDeps {
  ledger: CreditLedgerLike;
  drainReport: DrainReportWiring;
  stripe: StripeRefundApi;
  /** Countersigns the `sent` reclaim event when this call is the one that books it. */
  receiptIssuer?: ReceiptIssuer;
}

export interface StripeDrainResult {
  /** The drain after this call: still `pending` while any refund is unfinished. */
  drain: CreditDrainRecord;
  /** This call booked the drain `sent`. */
  completed: boolean;
}

/** Credit micro-USD per US cent. Card refunds move whole cents. */
const MICRO_PER_CENT = 10_000;

/**
 * Refund a pending `stripe` drain to the card(s) that funded its credit, and book it `sent`
 * once every refund has succeeded.
 *
 * Safe to call again at any time: the caller's poll, the sweep and the operator's retry all
 * come through here. The plan (which PaymentIntent returns how much) is fixed on the drain
 * before the first refund, so every retry sends the same amounts. Each refund carries the
 * drain and lot in its Stripe metadata and an idempotency key per drain, lot and attempt.
 * Before creating a refund this reads the PaymentIntent's refunds and adopts one this drain
 * already made, which is what keeps a retry from refunding twice after a lost answer, even
 * once Stripe's 24-hour idempotency window has passed.
 *
 * Any Stripe failure leaves the drain `pending` with the failure recorded on the plan;
 * the balance stays debited and owed to the card.
 */
export async function runStripeDrain(
  deps: StripeDrainLegDeps,
  drain: CreditDrainRecord
): Promise<StripeDrainResult> {
  if (drain.method !== "stripe" || drain.status !== "pending") {
    return { drain, completed: false };
  }
  const save = deps.ledger.saveCardRefund?.bind(deps.ledger);
  if (!save) throw new Error("this credit ledger cannot record card refunds");

  let plan = drain.cardRefund ?? null;
  if (!plan) {
    try {
      const fresh = await planCardRefund(deps, drain);
      plan = await save({
        creditId: drain.creditId,
        drainId: drain.drainId,
        plan: fresh,
        onlyIfUnset: true,
      });
    } catch (err) {
      logPending(drain, { stage: "plan", error_code: failureCode(err) });
      return { drain, completed: false };
    }
    if (!plan) return { drain: await reread(deps, drain), completed: false };
  }

  plan = structuredClone(plan);
  for (const entry of plan.entries) {
    if (entry.amountCents <= 0 || entry.status === "succeeded") continue;
    const status = await advanceRefund(deps.stripe, drain, entry);
    if (status !== "succeeded") {
      logPending(drain, {
        stage: "refund",
        payment_intent: entry.paymentIntentId,
        refund_status: entry.status,
        error_code: entry.lastError ?? undefined,
      });
    }
  }
  const stored = await save({ creditId: drain.creditId, drainId: drain.drainId, plan });
  if (stored) plan = stored;

  if (!refundsFinished(plan)) {
    return { drain: { ...(await reread(deps, drain)), cardRefund: plan }, completed: false };
  }
  const result = await commitTerminalDrain(deps.drainReport, (tx) =>
    deps.ledger.markDrainSent({
      creditId: drain.creditId,
      drainId: drain.drainId,
      sentRef: cardRefundSentRef(plan),
      tx,
    })
  );
  let record = result.drain;
  if (!result.replayed && deps.receiptIssuer) {
    const receipt = deps.receiptIssuer.issueDrain({
      creditId: record.creditId,
      drainId: record.drainId,
      event: "sent",
      method: record.method,
      amountMicro: record.amountMicro,
      balanceAfterMicro: record.balanceAfterMicro,
      ledgerSeq: record.ledgerSeq,
      callerPubkey: record.callerPubkey,
    }) as unknown as Record<string, unknown>;
    await deps.ledger.appendDrainReceipt({
      creditId: record.creditId,
      drainId: record.drainId,
      receipt,
    });
    record = { ...record, receipts: [...record.receipts, receipt] };
  }
  return { drain: record, completed: !result.replayed };
}

/**
 * The caller's share of Stripe's processing fee on a refund of `grossCents` from one charge:
 * `round(fee × grossCents ÷ charged)`, rounding half up, never more than the refund.
 *
 * `fee` and `settledAmount` both come from the charge's balance transaction, in the
 * settlement currency. When that is the charge currency, `settledAmount` is the amount
 * charged and this is exactly the rule above; when Stripe converted the charge, the ratio
 * of the two is still the fee's share of the charge, so no exchange rate is applied.
 */
export function proportionalFeeShare(
  grossCents: number,
  fee: { fee: number; settledAmount: number }
): number {
  const share = Math.floor(
    (2 * grossCents * fee.fee + fee.settledAmount) / (2 * fee.settledAmount)
  );
  return Math.min(grossCents, Math.max(0, share));
}

/** Dollar figures a caller, an agent and an operator read off a card refund. */
export interface CardRefundSummary {
  /** Whole cents of credit the refund covers before fee shares. */
  grossCents: number;
  /** What goes (or went) back to the card. */
  refundedCents: number;
  /** Kept to cover the refund's share of Stripe's processing fee. */
  feeShareCents: number;
  /** Credit below one cent, which no card refund can carry. */
  subCentMicro: number;
  refundIds: string[];
}

export function cardRefundSummary(plan: CardRefundPlan): CardRefundSummary {
  return {
    grossCents: plan.grossCents,
    refundedCents: sum(plan.entries.map((entry) => entry.amountCents)),
    feeShareCents: sum(plan.entries.map((entry) => entry.feeShareCents)),
    subCentMicro: plan.subCentMicro,
    refundIds: plan.entries.flatMap((entry) => (entry.refundId ? [entry.refundId] : [])),
  };
}

/** `$1.39` from 139 cents. */
export function usdFromCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Size each refund against the funding PaymentIntents, oldest lot first. The drained credit
 * decides the total, not the lots: draws never deplete a card lot. A charge can give back at
 * most what it charged less what Stripe says it already refunded.
 */
async function planCardRefund(
  deps: StripeDrainLegDeps,
  drain: CreditDrainRecord
): Promise<CardRefundPlan> {
  // Oldest first, as the ledger lists them: Stripe refunds a charge only for a limited time
  // after it was made, so the charges nearest that limit go back first.
  const lots = (await deps.ledger.listFundingLots(drain.creditId)).filter(
    (lot) => isCardFundedRail(lot.rail) && lot.fundingRef?.startsWith("pi_")
  );
  const grossCents = Math.floor(drain.amountMicro / MICRO_PER_CENT);
  const entries: CardRefundEntry[] = [];
  let left = grossCents;
  for (const lot of lots) {
    if (left === 0) break;
    const charge = await deps.stripe.retrieveCharge(lot.fundingRef as string);
    assertRefundable(charge);
    const gross = Math.min(left, charge.amount - charge.amountRefunded);
    if (gross <= 0) continue;
    const feeShare = proportionalFeeShare(gross, charge.fee as NonNullable<typeof charge.fee>);
    entries.push({
      lotId: lot.lotId,
      paymentIntentId: charge.paymentIntentId,
      grossCents: gross,
      feeShareCents: feeShare,
      amountCents: gross - feeShare,
      attempt: 1,
      refundId: null,
      status: "planned",
      lastError: null,
    });
    left -= gross;
  }
  if (left > 0) throw new CardRefundPlanError("charges_exhausted");
  return { grossCents, subCentMicro: drain.amountMicro - grossCents * MICRO_PER_CENT, entries };
}

class CardRefundPlanError extends Error {
  constructor(readonly code: string) {
    super(`card refund cannot be planned: ${code}`);
    this.name = "CardRefundPlanError";
  }
}

function assertRefundable(charge: StripeChargeFacts): void {
  if (charge.status !== "succeeded" || charge.currency !== "usd") {
    throw new CardRefundPlanError("charge_not_refundable");
  }
  if (!charge.fee) throw new CardRefundPlanError("fee_not_settled");
}

async function advanceRefund(
  stripe: StripeRefundApi,
  drain: CreditDrainRecord,
  entry: CardRefundEntry
): Promise<CardRefundEntry["status"]> {
  await advanceRefundOnce(stripe, drain, entry);
  return entry.status;
}

async function advanceRefundOnce(
  stripe: StripeRefundApi,
  drain: CreditDrainRecord,
  entry: CardRefundEntry
): Promise<void> {
  const tag = refundDrainTag(drain);
  try {
    if (entry.refundId && isOpenStatus(entry.status)) {
      const refund = await stripe.retrieveRefund(entry.refundId);
      setStatus(entry, refund.status);
      return;
    }
    const existing = (await stripe.listRefunds(entry.paymentIntentId)).find(
      (refund) =>
        refund.metadata.dvmkit_drain === tag &&
        refund.metadata.dvmkit_lot === entry.lotId &&
        refund.status !== "failed" &&
        refund.status !== "canceled"
    );
    if (existing) {
      entry.refundId = existing.id;
      setStatus(entry, existing.status);
      return;
    }
    // Stripe replays a key's first answer, so a definite refusal or failure needs a new key.
    if (entry.status === "rejected" || entry.status === "failed" || entry.status === "canceled") {
      entry.attempt += 1;
    }
    const refund = await stripe.createRefund({
      paymentIntentId: entry.paymentIntentId,
      amount: entry.amountCents,
      idempotencyKey: refundIdempotencyKey(drain, entry),
      metadata: { dvmkit_drain: tag, dvmkit_lot: entry.lotId, dvmkit_attempt: String(entry.attempt) },
    });
    entry.refundId = refund.id;
    setStatus(entry, refund.status);
  } catch (err) {
    if (err instanceof StripeApiError && err.rejected) entry.status = "rejected";
    entry.lastError = failureCode(err);
  }
}

function setStatus(entry: CardRefundEntry, status: string): void {
  switch (status) {
    case "succeeded":
    case "pending":
    case "requires_action":
    case "failed":
    case "canceled":
      entry.status = status;
      entry.lastError = status === "failed" || status === "canceled" ? status : null;
      return;
    default:
      entry.status = "pending";
  }
}

function isOpenStatus(status: CardRefundEntry["status"]): boolean {
  return status === "pending" || status === "requires_action" || status === "planned";
}

function refundsFinished(plan: CardRefundPlan): boolean {
  return plan.entries.every((entry) => entry.amountCents <= 0 || entry.status === "succeeded");
}

function refundIdempotencyKey(drain: CreditDrainRecord, entry: CardRefundEntry): string {
  const digest = createHash("sha256")
    .update([drain.creditId, drain.drainId, entry.lotId, String(entry.attempt)].join("\0"))
    .digest("hex");
  return `dvmkit-card-refund-${digest}`;
}

function cardRefundSentRef(plan: CardRefundPlan): Record<string, unknown> {
  const summary = cardRefundSummary(plan);
  return {
    refund_ids: summary.refundIds,
    refunded_cents: summary.refundedCents,
    fee_share_cents: summary.feeShareCents,
    sub_cent_micro: summary.subCentMicro,
    refunds: plan.entries.map((entry) => ({
      payment_intent: entry.paymentIntentId,
      refund_id: entry.refundId,
      gross_cents: entry.grossCents,
      fee_share_cents: entry.feeShareCents,
      amount_cents: entry.amountCents,
    })),
  };
}

async function reread(deps: StripeDrainLegDeps, drain: CreditDrainRecord): Promise<CreditDrainRecord> {
  return (await deps.ledger.getDrain({ creditId: drain.creditId, drainId: drain.drainId })) ?? drain;
}

function failureCode(err: unknown): string {
  if (err instanceof CardRefundPlanError) return err.code;
  if (err instanceof StripeApiError) {
    return err.code ?? err.type ?? (err.status === 0 ? "stripe_unreachable" : `http_${err.status}`);
  }
  return "internal_error";
}

/**
 * The drain a refund belongs to, in its Stripe metadata. Stripe caps a metadata value at 500
 * characters; a credit id and drain id that would not fit are carried as their digest.
 */
function refundDrainTag(drain: CreditDrainRecord): string {
  const tag = `${drain.creditId}:${drain.drainId}`;
  if (tag.length <= 200) return tag;
  return `sha256:${createHash("sha256").update(tag).digest("hex")}`;
}

function logPending(drain: CreditDrainRecord, fields: Record<string, unknown>): void {
  diagnosticConsole.warn({
    event: "card_refund_pending",
    credit_id: drain.creditId,
    drain_id: drain.drainId,
    ...fields,
  });
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
