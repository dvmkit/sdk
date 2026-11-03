import { createHash } from "node:crypto";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import { commitTerminalDrain, type DrainReportWiring } from "./credit-drain-report";
import type {
  CardDrainRecovery,
  CardDrainDecision,
  CreditLedgerQuerier,
  CardRefundEntry,
  CardRefundPlan,
  CreditDrainRecord,
  CreditLedgerLike,
} from "./credit-ledger";
import { CreditLedgerError } from "./credit-ledger";
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
  /** Connection owning the card-refund session lock; statements outside booking autocommit. */
  query?: CreditLedgerQuerier;
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
 * Transient failures stay pending. Permanent refusals retain the debit in `refund_blocked`
 * until an operator explicitly replans or writes off the unpaid remainder.
 */
export async function runStripeDrain(
  deps: StripeDrainLegDeps,
  drain: CreditDrainRecord
): Promise<StripeDrainResult> {
  if (drain.method !== "stripe" || drain.status !== "pending") {
    return { drain, completed: false };
  }
  requireRecovery(deps);
  return deps.ledger.withCardRefundLock!(drain.creditId, async (query) => {
    const session = { ...deps, query };
    return runLocked(session, await reread(session, drain));
  });
}

async function runLocked(deps: StripeDrainLegDeps, drain: CreditDrainRecord): Promise<StripeDrainResult> {
  if (drain.status !== "pending") return { drain, completed: false };
  const save = (args: Parameters<NonNullable<CreditLedgerLike["saveCardRefund"]>>[0]) =>
    deps.ledger.saveCardRefund!({ ...args, tx: deps.query, revision: drain.cardRecovery?.revision ?? 0 });
  let plan = drain.cardRefund ?? null;
  if (!plan || sum(plan.entries.map((entry) => entry.grossCents)) !== plan.grossCents) {
    try {
      const fresh = await planCardRefund(deps, drain);
      plan = await save({
        creditId: drain.creditId,
        drainId: drain.drainId,
        plan: fresh,
        onlyIfUnset: !plan,
      });
    } catch (err) {
      const code = failureCode(err);
      logPending(drain, { stage: "plan", error_code: code });
      return { drain: isTerminalFailure(code) ? await blockDrain(deps, drain, code) : drain, completed: false };
    }
    if (!plan) return { drain: await reread(deps, drain), completed: false };
  }

  plan = structuredClone(plan);
  for (const entry of plan.entries) {
    if (entry.amountCents <= 0 || entry.status === "succeeded") continue;
    const status = await advanceRefund(deps.stripe, drain, entry, async () => {
      await save({ creditId: drain.creditId, drainId: drain.drainId, plan: plan! });
    });
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
    const fresh = await reread(deps, drain);
    const terminal = plan.entries.find((entry) => entry.lastError && isTerminalFailure(entry.lastError));
    return { drain: terminal ? await blockDrain(deps, fresh, terminal.lastError!) : fresh, completed: false };
  }
  const transition = (tx?: CreditLedgerQuerier) =>
    deps.ledger.markDrainSent({
      creditId: drain.creditId,
      drainId: drain.drainId,
      sentRef: cardRefundSentRef(plan),
      tx,
    });
  // The plan/progress above is already durable even if booking or its outbox rolls back.
  let result;
  if (deps.query) {
    await deps.query.query("BEGIN");
    try {
      result = await commitTerminalDrain(deps.drainReport, transition, deps.query);
      await deps.query.query("COMMIT");
    } catch (error) {
      await deps.query.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } else {
    result = await commitTerminalDrain(deps.drainReport, transition);
  }
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
      tx: deps.query,
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

export function cardRefundSummary(plan: CardRefundPlan, completedOnly = false): CardRefundSummary {
  const entries = completedOnly ? plan.entries.filter((entry) => entry.status === "succeeded" || entry.amountCents === 0) : plan.entries;
  return {
    grossCents: plan.grossCents,
    refundedCents: sum(entries.map((entry) => entry.amountCents)),
    feeShareCents: sum(entries.map((entry) => entry.feeShareCents)),
    subCentMicro: plan.subCentMicro,
    refundIds: entries.flatMap((entry) => (entry.refundId ? [entry.refundId] : [])),
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
  const lots = (await deps.ledger.listFundingLots(drain.creditId, deps.query)).filter(
    (lot) => isCardFundedRail(lot.rail) && lot.fundingRef?.startsWith("pi_")
  );
  const grossCents = Math.floor(drain.amountMicro / MICRO_PER_CENT);
  const entries: CardRefundEntry[] = structuredClone(drain.cardRefund?.entries.filter(
    (entry) => entry.status === "succeeded" || entry.amountCents === 0) ?? []);
  let left = grossCents - sum(entries.map((entry) => entry.grossCents));
  let refusal = "charges_exhausted";
  for (const lot of lots) {
    if (left === 0) break;
    const charge = await deps.stripe.retrieveCharge(lot.fundingRef as string);
    try {
      assertRefundable(charge);
      await assertDisputeRefundable(deps.stripe, charge);
    } catch (error) {
      if (!(error instanceof CardRefundPlanError) || !isTerminalFailure(error.code)) throw error;
      refusal = error.code;
      continue;
    }
    const retainedFees = sum(entries.filter((entry) => entry.paymentIntentId === charge.paymentIntentId && entry.status === "succeeded")
      .map((entry) => entry.feeShareCents));
    const gross = Math.min(left, charge.amount - charge.amountRefunded - retainedFees);
    if (gross <= 0) continue;
    const feeShare = proportionalFeeShare(gross, charge.fee as NonNullable<typeof charge.fee>);
    entries.push({
      lotId: lot.lotId,
      paymentIntentId: charge.paymentIntentId,
      grossCents: gross,
      feeShareCents: feeShare,
      amountCents: gross - feeShare,
      attempt: 1,
      revision: drain.cardRecovery?.revision ?? 0,
      refundId: null,
      status: "planned",
      lastError: null,
    });
    left -= gross;
  }
  if (left > 0) throw new CardRefundPlanError(refusal);
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
  entry: CardRefundEntry,
  beforeCreate: () => Promise<void>
): Promise<CardRefundEntry["status"]> {
  await advanceRefundOnce(stripe, drain, entry, beforeCreate);
  return entry.status;
}

async function advanceRefundOnce(
  stripe: StripeRefundApi,
  drain: CreditDrainRecord,
  entry: CardRefundEntry,
  beforeCreate: () => Promise<void>
): Promise<void> {
  const tag = refundDrainTag(drain);
  try {
    if (entry.refundId && isOpenStatus(entry.status)) {
      const refund = await stripe.retrieveRefund(entry.refundId);
      setStatus(entry, refund.status);
      if (entry.status !== "succeeded") await assertDisputeRefundable(stripe, await stripe.retrieveCharge(entry.paymentIntentId));
      return;
    }
    const existing = (await stripe.listRefunds(entry.paymentIntentId)).find(
      (refund) =>
        refund.metadata.dvmkit_drain === tag &&
        refund.metadata.dvmkit_lot === entry.lotId &&
        Number(refund.metadata.dvmkit_revision ?? 0) === (entry.revision ?? 0) &&
        refund.status !== "failed" &&
        refund.status !== "canceled"
    );
    if (existing) {
      entry.refundId = existing.id;
      setStatus(entry, existing.status);
      if (entry.status !== "succeeded") await assertDisputeRefundable(stripe, await stripe.retrieveCharge(entry.paymentIntentId));
      return;
    }
    const charge = await stripe.retrieveCharge(entry.paymentIntentId);
    assertRefundable(charge);
    await assertDisputeRefundable(stripe, charge);
    // Stripe replays a key's first answer, so a definite refusal or failure needs a new key.
    if (entry.status === "rejected" || entry.status === "failed" || entry.status === "canceled") {
      entry.attempt += 1;
    }
    // A crash or lost response must leave an uncertain submission, even when this entry
    // used to be a definite rejection. Store its attempt before making the external call.
    entry.status = "planned";
    entry.refundId = null;
    entry.lastError = null;
    await beforeCreate();
    const refund = await stripe.createRefund({
      paymentIntentId: entry.paymentIntentId,
      amount: entry.amountCents,
      idempotencyKey: refundIdempotencyKey(drain, entry),
      metadata: { dvmkit_drain: tag, dvmkit_lot: entry.lotId, dvmkit_attempt: String(entry.attempt), dvmkit_revision: String(entry.revision ?? 0) },
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
  const fields = [drain.creditId, drain.drainId, entry.lotId, String(entry.attempt)];
  if (entry.revision) fields.push(String(entry.revision));
  const digest = createHash("sha256")
    .update(fields.join("\0"))
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
  return (await deps.ledger.getDrain({ creditId: drain.creditId, drainId: drain.drainId, tx: deps.query })) ?? drain;
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

function requireRecovery(deps: StripeDrainLegDeps): void {
  if (!deps.ledger.withCardRefundLock || !deps.ledger.saveCardDrainState || !deps.ledger.saveCardRefund) {
    throw new CreditLedgerError("card_refund_unavailable", "The credit store must support serialized card refund recovery before making refunds.");
  }
}

function isTerminalFailure(code: string): boolean {
  return ["charges_exhausted", "charge_not_refundable", "amount_too_large", "charge_already_refunded", "charge_dispute_lost"].includes(code);
}

async function assertDisputeRefundable(stripe: StripeRefundApi, charge: StripeChargeFacts): Promise<void> {
  if (!charge.disputed) return;
  const { disputes, hasMore } = await stripe.listDisputesForPaymentIntent(charge.paymentIntentId);
  if (disputes.some((dispute) => dispute.status === "lost")) throw new CardRefundPlanError("charge_dispute_lost");
  if (hasMore || !disputes.length || disputes.some((dispute) => !["won", "warning_closed"].includes(dispute.status))) {
    throw new CardRefundPlanError("charge_disputed");
  }
}

function recoveryState(drain: CreditDrainRecord): CardDrainRecovery {
  return structuredClone(drain.cardRecovery ?? { revision: 0, blockedReason: null, blockedAt: null, decisions: [] });
}

async function blockDrain(deps: StripeDrainLegDeps, drain: CreditDrainRecord, reason: string): Promise<CreditDrainRecord> {
  const recovery = recoveryState(drain);
  recovery.blockedReason = reason;
  recovery.blockedAt = Date.now();
  return deps.ledger.saveCardDrainState!({ creditId: drain.creditId, drainId: drain.drainId,
    expectedStatus: "pending", expectedRevision: recovery.revision, status: "refund_blocked", recovery, tx: deps.query });
}

/** An explicit decision is replayed by its id, including after the replan completes. */
export async function recoverCardDrain(
  deps: StripeDrainLegDeps,
  args: { creditId: string; drainId: string; decisionId: string; action: "close" | "replan"; reason: string }
): Promise<{ drain: CreditDrainRecord; replayed: boolean }> {
  requireRecovery(deps);
  if (!args.decisionId || args.decisionId.length > 128 || !args.reason.trim() || args.reason.trim().length > 2000) {
    throw new CreditLedgerError("invalid_drain_decision", "A decision requires decision_id of 1–128 characters and reason of 1–2000 characters.");
  }
  return deps.ledger.withCardRefundLock!(args.creditId, async (query) => {
    const session = { ...deps, query };
    let drain = await deps.ledger.getDrain({ ...args, tx: query });
    if (!drain) throw new CreditLedgerError("drain_not_found", "The card drain was not found.");
    if (drain.method !== "stripe") throw new CreditLedgerError("drain_not_repairable", "Only card drains accept this decision.");
    const recovery = recoveryState(drain);
    const reason = args.reason.trim();
    const prior = recovery.decisions.find((decision) => decision.decisionId === args.decisionId);
    if (prior) {
      if (prior.action !== args.action || prior.reason !== reason) {
        throw new CreditLedgerError("drain_decision_conflict", "This decision_id already records another decision.");
      }
      return { drain, replayed: true };
    }
    if (drain.status !== "refund_blocked") throw new CreditLedgerError("invalid_drain_state", "Only a blocked card refund can be recovered.");
    const plan = await reconcileForDecision(session, drain);
    const decision: CardDrainDecision = { decisionId: args.decisionId, action: args.action, reason, decidedAt: Date.now() };
    recovery.decisions.push(decision);
    if (args.action === "close") {
      const refundedGrossMicro = sum((plan?.entries ?? []).filter((entry) => entry.status === "succeeded" || entry.amountCents === 0)
        .map((entry) => entry.grossCents)) * MICRO_PER_CENT;
      recovery.refundedGrossMicro = refundedGrossMicro;
      recovery.writtenOffMicro = drain.amountMicro - refundedGrossMicro;
      const finished = plan !== null && sum(plan.entries.map((entry) => entry.grossCents)) === plan.grossCents && refundsFinished(plan);
      if (finished) recovery.writtenOffMicro = 0;
      drain = await deps.ledger.saveCardDrainState!({ ...args, expectedStatus: "refund_blocked",
        expectedRevision: recovery.revision, status: finished ? "pending" : "written_off", recovery, plan, tx: query });
      if (finished) drain = (await runLocked(session, drain)).drain;
    } else {
      const previousRevision = recovery.revision;
      recovery.revision += 1;
      recovery.blockedReason = null;
      recovery.blockedAt = null;
      // Keep successful entries as immutable allocation evidence; planCardRefund sizes only
      // what remains and assigns the new revision to replacements, even on the same lot.
      const retained = plan ? { ...plan, entries: plan.entries.filter((entry) => entry.status === "succeeded" || entry.amountCents === 0) } : null;
      drain = await deps.ledger.saveCardDrainState!({ ...args, expectedStatus: "refund_blocked",
        expectedRevision: previousRevision, status: "pending", recovery, plan: retained, tx: query });
      drain = (await runLocked(session, drain)).drain;
    }
    return { drain, replayed: false };
  });
}

async function reconcileForDecision(deps: StripeDrainLegDeps, drain: CreditDrainRecord): Promise<CardRefundPlan | null> {
  const plan = drain.cardRefund ? structuredClone(drain.cardRefund) : null;
  if (!plan) return null;
  for (const entry of plan.entries) {
    if (entry.status === "succeeded" || entry.amountCents <= 0) continue;
    // Adoption before any decision recovers a lost create response and checks an outstanding
    // refund by id. A network failure or still-open refund cannot be called unpaid.
    const refunds = await deps.stripe.listRefunds(entry.paymentIntentId);
    const matched = refunds.filter((refund) => refund.metadata.dvmkit_drain === refundDrainTag(drain) &&
      refund.metadata.dvmkit_lot === entry.lotId && Number(refund.metadata.dvmkit_revision ?? 0) === (entry.revision ?? 0));
    if (entry.refundId && !matched.some((refund) => refund.id === entry.refundId)) matched.push(await deps.stripe.retrieveRefund(entry.refundId));
    const succeeded = matched.filter((refund) => refund.status === "succeeded");
    if (succeeded.length > 1 || succeeded.some((refund) => refund.amount !== entry.amountCents) ||
      matched.some((refund) => !["succeeded", "failed", "canceled"].includes(refund.status))) {
      throw new CreditLedgerError("card_refund_uncertain", "A refund may still pay, or its amount cannot be reconciled. Resolve it before closing or replanning.");
    }
    if (succeeded[0]) { entry.refundId = succeeded[0].id; setStatus(entry, "succeeded"); }
    else {
      const currentRefund = matched.find((refund) => entry.refundId ? refund.id === entry.refundId :
        refund.metadata.dvmkit_attempt === String(entry.attempt));
      const definitivelyUnpaid = currentRefund?.status === "failed" || currentRefund?.status === "canceled";
      // A previous attempt's failure cannot resolve a newer submission with a lost answer.
      if (!definitivelyUnpaid && (entry.status === "pending" || entry.status === "requires_action" ||
        entry.status === "planned" && !["charge_not_refundable", "charge_dispute_lost", "charge_disputed"].includes(entry.lastError ?? ""))) {
        throw new CreditLedgerError("card_refund_uncertain", "A refund submission has no definitive outcome. Recover its Stripe evidence before deciding.");
      }
      entry.refundId = null; entry.status = "rejected";
    }
  }
  return plan;
}
