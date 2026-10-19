import { randomUUID } from "node:crypto";

import { refundAssetDelta, refundRequest, type CreditDrawRefundArgs, type CreditDrawRefundResult } from "./credit-draw-refund";
import type { FundingReceipt } from "../../lib/receipt";
import type {
  BitcoinDepositLiability,
  BlockedInvoiceCursor,
  ChannelDrainCursor,
  CreditDrainRecord,
  CreditFundingBasis,
  CreditInvoiceRecord,
  CreditInvoiceStatus,
  CreditLedgerLike,
  CreditLedgerQuerier,
  CreditSnapshot,
  CreditStatus,
  DrainFulfilment,
  DrainMethod,
  DrainReleaseResult,
  DrainRequestResult,
  DrainStatus,
  DrainTransitionResult,
  DrainWriteOff,
  DrawRailValue,
  DrawRecord,
  DrawResolution,
  DrawResult,
  DrawStatus,
  FundingRecord,
  GrownDrawResult,
  InvoiceReconciliation,
  InvoiceSettlement,
  InvoiceWriteOff,
  StalePendingDrawCursor,
  TempoCreditLoss,
  TempoCreditLossEvidence,
  X402CreditLoss,
  X402CreditLossEvidence,
} from "./credit-ledger";
import {
  allocateDrawValue,
  assertFundingBasis,
  clipEarmark,
  CreditLedgerError,
  growthRailValue,
  isFundingRail,
  x402SettlementPending,
} from "./credit-ledger";
import {
  depleteLots,
  DRAIN_DELIVERY_RESERVE_SATS,
  fifoOrder,
  type FundingLot,
  inKindDrawMsats,
  isInKindDepletion,
  isNonChannelBitcoinRail,
  type LotDebit,
  lotOwedSats,
  netOwedSats,
  type NonChannelBitcoinRail,
} from "./credit-lots";
import {
  X402_SPEND_BLOCKING_SETTLEMENT_STATUSES,
  X402_WEDGED_SETTLEMENT_STATUSES,
  type X402RefundSettlementGate,
  type X402SettlementStatus,
  type X402UnresolvedRefund,
} from "./x402-channel-store";

/**
 * Per-process development/test ledger without durability or cross-machine safety. Mutations
 * run synchronously between awaits; accepted tx handles are ignored. Production funding
 * requires a durable ledger.
 */
export class MemoryCreditLedger implements CreditLedgerLike {
  /**
   * Per-process and lost on restart, so a DVM backed by this ledger never
   * advertises the funding menu outside devMode — funding on one
   * machine and drawing on another would `credit_not_found`.
   */
  readonly durable = false;

  private readonly credits = new Map<string, MemoryCredit>();
  private readonly refunds = new Map<string, { request: string; result: CreditDrawRefundResult }>();
  private readonly fundings = new Map<string, FundingRecord>();
  private readonly invoices = new Map<string, CreditInvoiceRecord>();
  private readonly tempoLosses = new Map<string, TempoCreditLoss>();
  private readonly x402Losses = new Map<string, X402CreditLoss>();
  private x402Settlements?: X402RefundSettlementGate;

  /** Internal disposable transaction snapshot. The caller must serialize every ledger access. */
  forkForTransaction(): MemoryCreditLedger {
    const fork = new MemoryCreditLedger();
    for (const name of ["credits", "fundings", "invoices", "tempoLosses", "x402Losses", "refunds"] as const) {
      const target = fork[name] as Map<string, unknown>;
      for (const [key, value] of this[name]) target.set(key, structuredClone(value));
    }
    fork.x402Settlements = this.x402Settlements;
    return fork;
  }

  useX402SettlementGate(gate: X402RefundSettlementGate): void {
    this.x402Settlements = gate;
  }

  async fund(args: Parameters<CreditLedgerLike["fund"]>[0]): Promise<CreditSnapshot> {
    // Check the incoming channel before synchronous funding, but leave basis validation in
    // fundSync so invalid_amount still precedes invalid_basis. Optional access must survive a
    // missing basis from JavaScript callers.
    const basis = args.basis as CreditFundingBasis | undefined;
    const wedged = await this.blockingX402Refund(
      basis?.x402Channel?.channelId,
      X402_SPEND_BLOCKING_SETTLEMENT_STATUSES
    );
    if (wedged) throw x402SettlementPending(args.creditId ?? randomUUID(), wedged);
    return run(() => this.fundSync(args));
  }

  /** Development accounting parity; this non-durable store cannot mount admin refunds. */
  refundDraw(args: CreditDrawRefundArgs): Promise<CreditDrawRefundResult> {
    return run(() => {
      const request = refundRequest(args);
      const prior = this.refunds.get(args.refundId);
      if (prior) {
        if (prior.request !== request) throw new CreditLedgerError("refund_conflict", "This refundId was recorded with different arguments.");
        return { ...prior.result, replayed: true };
      }
      const matches = [...this.credits.values()].flatMap(credit =>
        [...credit.draws.values()].filter(draw => args.jobId !== undefined ?
          draw.jobId === args.jobId : credit.creditId === args.creditId && draw.drawId === args.drawId)
          .map(draw => ({ credit, draw })));
      if (matches.length !== 1 || !matches[0].draw.jobId) {
        throw new CreditLedgerError("draw_not_found", "No unique job-bound draw matches this selector.");
      }
      const { credit, draw } = matches[0];
      if (draw.status !== "settled") throw new CreditLedgerError("draw_not_completed", "Only a settled completed draw can be refunded.");
      const nowMs = args.nowMs ?? Date.now();
      const lastDrain = [...credit.drains.values()].filter(drain => drain.status !== "released")
        .sort((a, b) => b.ledgerSeq - a.ledgerSeq)[0];
      const drained = lastDrain && lastDrain.balanceAfterMicro === 0 &&
        (credit.lastFundingLedgerSeq === null || credit.lastFundingLedgerSeq < lastDrain.ledgerSeq) &&
        ![...credit.draws.values()].some(later => later.ledgerSeq > lastDrain.ledgerSeq && later.amountMicro > 0) &&
        ![...this.fundings.values()].some(funding => funding.creditId === credit.creditId &&
          funding.ledgerSeq !== null && funding.ledgerSeq >= lastDrain.ledgerSeq && funding.amountMicro > 0);
      if (credit.status !== "active" || credit.expiryMs <= nowMs) {
        throw new CreditLedgerError("credit_not_open", "The original credit is no longer open for refunds.");
      }
      if (credit.tempoChannelId || credit.x402ChannelId) {
        throw new CreditLedgerError("credit_refund_channel_unsupported", "Channel collateral cannot back a refund of settled spending.");
      }
      if (credit.balanceMicro === 0 && drained) {
        if (credit.lastFundingLedgerSeq === null) {
          throw new CreditLedgerError("credit_refund_state_unavailable", "The original credit's historical funding and drain order cannot be established.");
        }
        throw new CreditLedgerError("credit_not_open", "The original credit is no longer open for refunds.");
      }
      const before = [...this.refunds.values()].reduce((sum, refund) => sum +
        (refund.result.creditId === credit.creditId && refund.result.drawId === draw.drawId ? refund.result.amountMicro : 0), 0);
      const amountMicro = args.amountMicro ?? draw.amountMicro - before;
      if (amountMicro <= 0 || amountMicro > draw.amountMicro - before) {
        throw new CreditLedgerError("refund_exceeds_draw", "The refund exceeds the draw's remaining unrefunded charge.");
      }
      if (!isFundingRail(credit.rail)) throw new CreditLedgerError("credit_refund_basis_unavailable", "The original funding rail is not recorded on this older credit.");
      const bitcoin = isNonChannelBitcoinRail(credit.rail);
      const originalSats = draw.settledSats ?? null;
      if (bitcoin && originalSats === null) throw new CreditLedgerError("credit_refund_basis_unavailable", "The original Bitcoin value is not provable from this older draw.");
      const after = before + amountMicro;
      const restoredSats = bitcoin ? refundAssetDelta(originalSats!, draw.amountMicro, before, after) : null;
      const restoredMsats = restoredSats === null ? refundAssetDelta(draw.drawMsats, draw.amountMicro, before, after) : restoredSats * 1000;
      const restoredNative = draw.drawNative === null ? null : refundAssetDelta(draw.drawNative, draw.amountMicro, before, after);
      const balanceAfterMicro = credit.balanceMicro + amountMicro;
      const ledgerSeq = credit.lastLedgerSeq + 1;
      if (![balanceAfterMicro, ledgerSeq, credit.msatsRemaining + restoredMsats,
        (credit.nativeRemaining ?? 0) + (restoredNative ?? 0)].every(Number.isSafeInteger)) {
        throw new Error("credit ledger: refund exceeds safe integer range");
      }
      credit.balanceMicro = balanceAfterMicro;
      credit.lastLedgerSeq = ledgerSeq;
      credit.msatsRemaining += restoredMsats;
      if (credit.nativeRemaining !== null) credit.nativeRemaining += restoredNative ?? 0;
      if (bitcoin) credit.lots.push({
        lotId: `lot:refund:${randomUUID()}`, creditId: credit.creditId, rail: credit.rail as NonChannelBitcoinRail,
        satsFunded: restoredSats!, satsBasisKnown: true, creditedMicro: amountMicro, remainingMicro: amountMicro,
        fundingRef: args.refundId, createdAt: nowMs,
      });
      const result: CreditDrawRefundResult = {
        refundId: args.refundId, creditId: credit.creditId, drawId: draw.drawId, jobId: draw.jobId!,
        amountMicro, currency: credit.currency, ledgerSeq, refundedAt: nowMs, balanceAfterMicro, replayed: false,
      };
      this.refunds.set(args.refundId, { request, result });
      return { ...result };
    });
  }

  async draw(args: Parameters<CreditLedgerLike["draw"]>[0]): Promise<DrawResult> {
    // Awaited here because `drawSync` is synchronous — there is no credit
    // lock in this store to read it under, and nothing runs between the two.
    // What mirrors the Postgres ledger is the *ordering*: `drawSync` applies
    // the refusal after the replay branch, so a placed draw stays recoverable
    // through a wedge.
    const blocking = await this.blockingRefundForCredit(
      args.creditId,
      X402_SPEND_BLOCKING_SETTLEMENT_STATUSES
    );
    return run(() => this.drawSync(args, blocking));
  }

  async blockingX402Refund(
    channelId: string | null | undefined,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined> {
    if (!channelId || !this.x402Settlements) return undefined;
    return this.x402Settlements.pendingRefundSettlement(channelId, statuses);
  }

  private blockingRefundForCredit(
    creditId: string,
    statuses: X402SettlementStatus[]
  ): Promise<X402UnresolvedRefund | undefined> {
    return this.blockingX402Refund(this.credits.get(creditId)?.x402ChannelId, statuses);
  }

  growDraw(args: Parameters<CreditLedgerLike["growDraw"]>[0]): Promise<GrownDrawResult> {
    return run(() => this.growDrawSync(args));
  }

  settle(args: Parameters<CreditLedgerLike["settle"]>[0]): Promise<DrawResolution> {
    return run(() => {
      const credit = this.requireCredit(args.creditId);
      const draw = credit.draws.get(args.drawId);
      const to =
        draw?.status === "settled"
          ? "settled"
          : credit.status === "unbacked"
            ? "released"
            : "settled";
      return this.resolve({ ...args, to });
    });
  }

  release(args: Parameters<CreditLedgerLike["release"]>[0]): Promise<DrawResolution> {
    return run(() => this.resolve({ ...args, to: "released" }));
  }

  recordFunding(args: Parameters<CreditLedgerLike["recordFunding"]>[0]): Promise<FundingRecord> {
    return run(() => {
      assertAmount(args.amountMicro, { min: 1 });
      const key = fundingKey(args.creditId, args.fundId);
      if (this.fundings.has(key)) {
        throw new CreditLedgerError(
          "funding_replayed",
          `funding ${args.fundId} on credit ${args.creditId} was already recorded`
        );
      }
      const record: FundingRecord = {
        creditId: args.creditId,
        fundId: args.fundId,
        amountMicro: args.amountMicro,
        rail: args.rail ?? null,
        createdAt: args.nowMs ?? Date.now(),
        callerPubkey: null,
        balanceAfterMicro: null,
        ledgerSeq: null,
        receipt: null,
      };
      this.fundings.set(key, record);
      return record;
    });
  }

  getFunding(args: { creditId: string; fundId: string }): Promise<FundingRecord | undefined> {
    return run(() => this.fundings.get(fundingKey(args.creditId, args.fundId)));
  }

  completeFunding(
    args: Parameters<CreditLedgerLike["completeFunding"]>[0]
  ): Promise<FundingRecord> {
    return run(() => {
      const key = fundingKey(args.creditId, args.fundId);
      const record = this.fundings.get(key);
      if (!record) {
        throw new CreditLedgerError(
          "credit_not_found",
          `funding ${args.fundId} on credit ${args.creditId} was not recorded`
        );
      }
      record.callerPubkey ??= args.callerPubkey;
      record.balanceAfterMicro ??= args.balanceAfterMicro;
      record.ledgerSeq ??= args.ledgerSeq;
      return record;
    });
  }

  saveFundingReceipt(
    args: Parameters<CreditLedgerLike["saveFundingReceipt"]>[0]
  ): Promise<FundingReceipt> {
    return run(() => {
      const record = this.fundings.get(fundingKey(args.creditId, args.fundId));
      if (!record) {
        throw new CreditLedgerError(
          "credit_not_found",
          `funding ${args.fundId} on credit ${args.creditId} was not recorded`
        );
      }
      record.receipt ??= args.receipt;
      return record.receipt;
    });
  }

  recordInvoice(
    args: Parameters<CreditLedgerLike["recordInvoice"]>[0]
  ): Promise<CreditInvoiceRecord> {
    return run(() => {
      assertAmount(args.amountMicro, { min: 1 });
      const key = fundingKey(args.creditId, args.fundId);
      const existing = this.invoices.get(key);
      // Same rule as the Postgres ledger: a re-poll gets the invoice it was
      // already handed, never a fresh bolt11.
      if (existing) return existing;
      for (const invoice of this.invoices.values()) {
        if (invoice.paymentHash === args.paymentHash) {
          throw new CreditLedgerError(
            "invoice_conflict",
            `payment hash ${args.paymentHash} is already bound to another funding`
          );
        }
      }
      const record: CreditInvoiceRecord = {
        creditId: args.creditId,
        fundId: args.fundId,
        callerPubkey: args.callerPubkey,
        currency: args.currency,
        amountMicro: args.amountMicro,
        amountMsats: args.amountMsats,
        paymentHash: args.paymentHash,
        bolt11: args.bolt11,
        status: "pending",
        blockedReason: null,
        reconciledCreditId: null,
        reconciledFundId: null,
        resolvedAt: null,
        writeOffNote: null,
        expiresAt: args.expiresAt,
        createdAt: args.nowMs ?? Date.now(),
        settledAt: null,
      };
      this.invoices.set(key, record);
      return record;
    });
  }

  getInvoice(args: { creditId: string; fundId: string }): Promise<CreditInvoiceRecord | undefined> {
    return run(() => this.invoices.get(fundingKey(args.creditId, args.fundId)));
  }

  listPendingInvoices(args: {
    callerPubkey: string;
    creditId?: string;
    limit: number;
  }): Promise<CreditInvoiceRecord[]> {
    return run(() =>
      [...this.invoices.values()]
        .filter(
          (invoice) =>
            invoice.status === "pending" &&
            invoice.callerPubkey === args.callerPubkey &&
            (args.creditId === undefined || invoice.creditId === args.creditId)
        )
        .sort((a, b) => a.createdAt - b.createdAt || (a.fundId < b.fundId ? -1 : 1))
        .slice(0, args.limit)
    );
  }

  settleInvoice(
    args: Parameters<CreditLedgerLike["settleInvoice"]>[0]
  ): Promise<InvoiceSettlement> {
    return run(() => {
      assertFundingBasis(args.basis);
      const key = fundingKey(args.creditId, args.fundId);
      const invoice = this.invoices.get(key);
      if (!invoice) {
        throw new CreditLedgerError(
          "invoice_not_found",
          `no invoice for funding ${args.fundId} on credit ${args.creditId}`
        );
      }
      const nowMs = args.nowMs ?? Date.now();
      if (invoice.status === "settled") {
        const existing = this.credits.get(args.creditId);
        return {
          invoice,
          funding: this.fundings.get(key),
          credit: existing ? this.snapshot(existing, nowMs) : undefined,
          replayed: true,
        };
      }
      // Synchronous between awaits, so the funding record, the balance, and
      // the status flip are as atomic here as the Postgres transaction is.
      if (this.fundings.has(key)) {
        throw new CreditLedgerError(
          "funding_replayed",
          `funding ${args.fundId} on credit ${args.creditId} was already recorded`
        );
      }
      const funding: FundingRecord = {
        creditId: invoice.creditId,
        fundId: invoice.fundId,
        amountMicro: invoice.amountMicro,
        rail: "lightning",
        createdAt: nowMs,
        callerPubkey: null,
        balanceAfterMicro: null,
        ledgerSeq: null,
        receipt: null,
      };
      this.fundings.set(key, funding);
      const credit = this.fundSync({
        creditId: invoice.creditId,
        callerPubkey: invoice.callerPubkey,
        currency: invoice.currency,
        amountMicro: invoice.amountMicro,
        expiryMs: args.expiryMs,
        basis: args.basis,
        nowMs,
      });
      funding.callerPubkey = invoice.callerPubkey;
      funding.balanceAfterMicro = credit.availableMicro;
      funding.ledgerSeq = credit.lastLedgerSeq;
      const settled: CreditInvoiceRecord = {
        ...invoice,
        status: "settled",
        settledAt: args.settledAtMs ?? nowMs,
      };
      this.invoices.set(key, settled);
      return { invoice: settled, funding, credit, replayed: false };
    });
  }

  markInvoiceExpired(args: {
    creditId: string;
    fundId: string;
  }): Promise<CreditInvoiceRecord | undefined> {
    return run(() => {
      const key = fundingKey(args.creditId, args.fundId);
      const invoice = this.invoices.get(key);
      if (invoice?.status !== "pending") return invoice;
      const expired: CreditInvoiceRecord = { ...invoice, status: "expired" };
      this.invoices.set(key, expired);
      return expired;
    });
  }

  markInvoiceBlocked(args: {
    creditId: string;
    fundId: string;
    reason: string;
  }): Promise<CreditInvoiceRecord | undefined> {
    return run(() => {
      const key = fundingKey(args.creditId, args.fundId);
      const invoice = this.invoices.get(key);
      if (invoice?.status !== "pending") return invoice;
      const blocked: CreditInvoiceRecord = {
        ...invoice,
        status: "blocked",
        blockedReason: args.reason,
      };
      this.invoices.set(key, blocked);
      return blocked;
    });
  }

  getInvoiceByPaymentHash(paymentHash: string): Promise<CreditInvoiceRecord | undefined> {
    return run(() => this.findByPaymentHash(paymentHash)?.invoice);
  }

  listBlockedInvoices(args: {
    limit: number;
    after?: BlockedInvoiceCursor;
    includeResolved?: boolean;
  }): Promise<CreditInvoiceRecord[]> {
    const statuses: CreditInvoiceStatus[] = args.includeResolved
      ? ["blocked", "reconciled", "written_off"]
      : ["blocked"];
    return run(() =>
      [...this.invoices.values()]
        .filter((invoice) => statuses.includes(invoice.status))
        .sort(compareInvoiceKeyset)
        .filter((invoice) => args.after === undefined || compareToCursor(invoice, args.after) > 0)
        .slice(0, args.limit)
    );
  }

  reconcileBlockedInvoice(
    args: Parameters<CreditLedgerLike["reconcileBlockedInvoice"]>[0]
  ): Promise<InvoiceReconciliation> {
    return run(() => {
      assertFundingBasis(args.basis);
      const found = this.findByPaymentHash(args.paymentHash);
      if (!found) {
        throw new CreditLedgerError(
          "invoice_not_found",
          `no invoice for payment hash ${args.paymentHash}`
        );
      }
      const { key, invoice } = found;
      const nowMs = args.nowMs ?? Date.now();
      if (invoice.status === "reconciled") {
        const targetKey =
          invoice.reconciledCreditId && invoice.reconciledFundId
            ? fundingKey(invoice.reconciledCreditId, invoice.reconciledFundId)
            : undefined;
        const existing = invoice.reconciledCreditId
          ? this.credits.get(invoice.reconciledCreditId)
          : undefined;
        return {
          invoice,
          funding: targetKey ? this.fundings.get(targetKey) : undefined,
          credit: existing ? this.snapshot(existing, nowMs) : undefined,
          replayed: true,
        };
      }
      if (invoice.status !== "blocked" && invoice.status !== "written_off") {
        throw new CreditLedgerError(
          "invoice_not_blocked",
          `invoice ${args.paymentHash} is ${invoice.status}; only a blocked or written-off invoice can be reconciled`
        );
      }
      // Synchronous between awaits, so the funding record, the balance and the
      // status flip are as atomic here as the Postgres transaction is.
      const targetKey = fundingKey(args.targetCreditId, invoice.paymentHash);
      if (this.fundings.has(targetKey)) {
        throw new CreditLedgerError(
          "funding_replayed",
          `funding ${invoice.paymentHash} on credit ${args.targetCreditId} was already recorded`
        );
      }
      const funding: FundingRecord = {
        creditId: args.targetCreditId,
        fundId: invoice.paymentHash,
        amountMicro: invoice.amountMicro,
        rail: "lightning",
        createdAt: nowMs,
        callerPubkey: null,
        balanceAfterMicro: null,
        ledgerSeq: null,
        receipt: null,
      };
      this.fundings.set(targetKey, funding);
      const credit = this.fundSync({
        creditId: args.targetCreditId,
        callerPubkey: invoice.callerPubkey,
        currency: invoice.currency,
        amountMicro: invoice.amountMicro,
        expiryMs: args.expiryMs,
        basis: args.basis,
        nowMs,
      });
      funding.callerPubkey = invoice.callerPubkey;
      funding.balanceAfterMicro = credit.availableMicro;
      funding.ledgerSeq = credit.lastLedgerSeq;
      const reconciled: CreditInvoiceRecord = {
        ...invoice,
        status: "reconciled",
        reconciledCreditId: args.targetCreditId,
        reconciledFundId: invoice.paymentHash,
        resolvedAt: nowMs,
        settledAt: args.settledAtMs ?? invoice.settledAt,
      };
      this.invoices.set(key, reconciled);
      return { invoice: reconciled, funding, credit, replayed: false };
    });
  }

  writeOffBlockedInvoice(args: {
    paymentHash: string;
    note?: string;
    nowMs?: number;
  }): Promise<InvoiceWriteOff | undefined> {
    return run(() => {
      const found = this.findByPaymentHash(args.paymentHash);
      if (!found) return undefined;
      if (found.invoice.status !== "blocked") return { invoice: found.invoice, written: false };
      const written: CreditInvoiceRecord = {
        ...found.invoice,
        status: "written_off",
        writeOffNote: args.note ?? null,
        resolvedAt: args.nowMs ?? Date.now(),
      };
      this.invoices.set(found.key, written);
      return { invoice: written, written: true };
    });
  }

  private findByPaymentHash(
    paymentHash: string
  ): { key: string; invoice: CreditInvoiceRecord } | undefined {
    for (const [key, invoice] of this.invoices) {
      if (invoice.paymentHash === paymentHash) return { key, invoice };
    }
    return undefined;
  }

  private fundSync(args: {
    creditId?: string;
    callerPubkey: string;
    currency: string;
    amountMicro: number;
    expiryMs: number;
    basis: CreditFundingBasis;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): CreditSnapshot {
    assertAmount(args.amountMicro, { min: 1 });
    if (!Number.isSafeInteger(args.expiryMs) || args.expiryMs <= 0) {
      throw new CreditLedgerError(
        "invalid_expiry",
        `expiryMs must be a positive safe integer (got ${args.expiryMs})`
      );
    }
    const b = assertFundingBasis(args.basis);
    const nowMs = args.nowMs ?? Date.now();
    const creditId = args.creditId ?? randomUUID();
    const existing = this.credits.get(creditId);
    if (existing) {
      if (existing.callerPubkey !== args.callerPubkey) {
        throw new CreditLedgerError(
          "caller_mismatch",
          `credit ${creditId} belongs to a different caller pubkey`
        );
      }
      if (existing.currency !== args.currency) {
        throw new CreditLedgerError(
          "currency_mismatch",
          `credit ${creditId} is denominated in ${existing.currency}, not ${args.currency}`
        );
      }
      if (existing.status !== "active") throw terminalCreditError(creditId);
      // A legacy `rail === null` row still adopts whatever rail tops it up —
      // mirrors the Postgres upsert's `COALESCE(credits.rail, EXCLUDED.rail)`.
      if (existing.rail !== null && existing.rail !== b.rail) {
        throw new CreditLedgerError(
          "rail_mismatch",
          `credit ${creditId} was funded on the ${existing.rail} rail, not ${b.rail}`,
          { expectedRail: existing.rail }
        );
      }
      // Both instrument rungs name only what the credit proves, exactly as the
      // Postgres ladder does: a `rail === null` credit has no readable
      // instrument, so neither the message nor `expectedInstrument` claims one.
      const incomingTempoChannel = b.tempoSession?.channelId.toLowerCase() ?? null;
      if (existing.tempoChannelId !== incomingTempoChannel) {
        throw new CreditLedgerError(
          "rail_mismatch",
          existing.tempoChannelId
            ? `credit ${creditId} belongs to Tempo session channel ${existing.tempoChannelId}`
            : existing.rail === "tempo"
              ? `credit ${creditId} was funded by a one-shot Tempo charge and cannot accept a Tempo session voucher`
              : `credit ${creditId} is not bound to a Tempo session channel and cannot adopt one`,
          {
            expectedRail: existing.rail,
            ...(existing.tempoChannelId || existing.rail === "tempo"
              ? { expectedInstrument: existing.tempoChannelId ? "tempo_session" : "tempo_charge" }
              : {}),
            expectedChannelId: existing.tempoChannelId,
          }
        );
      }
      // Symmetric like the Tempo rung above: a channel may only top
      // up the credit it opened, and a credit opened by a one-shot x402 exact
      // authorization may never adopt one.
      if (existing.x402ChannelId !== (b.x402Channel?.channelId ?? null)) {
        throw new CreditLedgerError(
          "rail_mismatch",
          existing.x402ChannelId
            ? `credit ${creditId} is bound to x402 settlement channel ${existing.x402ChannelId}`
            : existing.rail === "x402"
              ? `credit ${creditId} was funded by a one-shot x402 exact payment and cannot accept an x402 batch-settlement channel deposit`
              : `credit ${creditId} is not bound to an x402 batch-settlement channel and cannot adopt one`,
          {
            expectedRail: existing.rail,
            ...(existing.x402ChannelId || existing.rail === "x402"
              ? { expectedInstrument: existing.x402ChannelId ? "x402_channel" : "x402_exact" }
              : {}),
            expectedChannelId: existing.x402ChannelId,
          }
        );
      }
      // The channel this credit already owns is the one arriving, so no other
      // credit can hold it — the cross-credit scan below is reachable only for
      // a credit id this ledger has never seen, which is exactly when the
      // Postgres upsert reaches its channel unique index.
      existing.lastFundingLedgerSeq = existing.lastLedgerSeq;
      existing.balanceMicro += args.amountMicro;
      existing.expiryMs = args.expiryMs;
      applyBasis(existing, b);
      recordLot(existing, args.amountMicro, b, nowMs);
      return this.snapshot(existing, nowMs);
    }
    // Mirrors `credits_x402_channel_uidx`, which the Postgres upsert reaches
    // only once its `ON CONFLICT … WHERE` has admitted the write — so this
    // scan sits below the rungs above, not before them.
    if (b.x402Channel) {
      for (const candidate of this.credits.values()) {
        if (candidate.x402ChannelId === b.x402Channel.channelId) {
          throw new CreditLedgerError(
            "rail_mismatch",
            `x402 channel ${b.x402Channel.channelId} is already bound to credit ${candidate.creditId}`,
            {
              expectedRail: candidate.rail,
              expectedInstrument: "x402_channel",
              expectedChannelId: b.x402Channel.channelId,
              boundCreditId: candidate.creditId,
            }
          );
        }
      }
    }
    const credit: MemoryCredit = {
      creditId,
      callerPubkey: args.callerPubkey,
      currency: args.currency,
      balanceMicro: args.amountMicro,
      expiryMs: args.expiryMs,
      status: "active",
      lastLedgerSeq: 0,
      lastFundingLedgerSeq: 0,
      createdAt: nowMs,
      draws: new Map(),
      rail: null,
      nativeAsset: null,
      mint: null,
      fundingRef: null,
      tempoChannelId: null,
      msatsRemaining: 0,
      nativeRemaining: null,
      x402ChannelId: null,
      drains: new Map(),
      lots: [],
    };
    applyBasis(credit, b);
    recordLot(credit, args.amountMicro, b, nowMs);
    this.credits.set(creditId, credit);
    return this.snapshot(credit, nowMs);
  }

  private drawSync(
    args: {
      creditId: string;
      drawId: string;
      amountMicro: number;
      jobId?: string;
      tx?: CreditLedgerQuerier;
      nowMs?: number;
    },
    x402Refund?: X402UnresolvedRefund
  ): DrawResult {
    assertAmount(args.amountMicro, { min: 0 });
    const nowMs = args.nowMs ?? Date.now();
    const jobId = args.jobId ?? null;
    const credit = this.requireCredit(args.creditId);
    const existing = credit.draws.get(args.drawId);
    if (existing) {
      if (existing.amountMicro !== args.amountMicro || existing.jobId !== jobId) {
        throw new CreditLedgerError(
          "draw_conflict",
          `draw ${args.drawId} on credit ${args.creditId} was recorded with different parameters`,
          { expectedAmountMicro: existing.amountMicro, expectedJobId: existing.jobId }
        );
      }
      return { ...drawResult(existing, credit), replayed: true };
    }
    if (credit.status !== "active") throw terminalCreditError(args.creditId);
    if (x402Refund) throw x402SettlementPending(args.creditId, x402Refund);
    if (credit.expiryMs <= nowMs) {
      throw new CreditLedgerError("credit_expired", `credit ${args.creditId} expired`, {
        expiryMs: credit.expiryMs,
        balanceMicro: credit.balanceMicro,
      });
    }
    const pending = pendingSums(credit);
    const available = credit.balanceMicro - pending.micro;
    if (args.amountMicro > available) {
      throw new CreditLedgerError(
        "insufficient_credit",
        `draw of ${args.amountMicro} exceeds available balance ${available}`,
        {
          availableMicro: available,
          balanceMicro: credit.balanceMicro,
          requestedMicro: args.amountMicro,
        }
      );
    }
    const alloc = allocateDrawValue({
      amountMicro: args.amountMicro,
      availableMicro: available,
      availableMsats: Math.max(0, credit.msatsRemaining - pending.msats),
      availableNative:
        credit.nativeRemaining === null
          ? null
          : Math.max(0, credit.nativeRemaining - pending.native),
    });
    const ledgerSeq = credit.lastLedgerSeq + 1;
    credit.lastLedgerSeq = ledgerSeq;
    const draw: MemoryDraw = {
      creditId: args.creditId,
      drawId: args.drawId,
      amountMicro: args.amountMicro,
      jobId,
      ledgerSeq,
      status: "pending",
      balanceAfterMicro: available - args.amountMicro,
      createdAt: nowMs,
      resolvedAt: null,
      drawMsats: alloc.drawMsats,
      drawNative: alloc.drawNative,
      grownMicro: 0,
    };
    credit.draws.set(args.drawId, draw);
    return { ...drawResult(draw, credit), replayed: false };
  }

  private growDrawSync(args: Parameters<CreditLedgerLike["growDraw"]>[0]): GrownDrawResult {
    assertAmount(args.addAmountMicro, { min: 1 });
    const credit = this.requireCredit(args.creditId);
    const draw = credit.draws.get(args.drawId);
    if (!draw) {
      throw new CreditLedgerError(
        "draw_not_found",
        `draw ${args.drawId} not found on credit ${args.creditId}`
      );
    }
    if (draw.status !== "pending") {
      throw new CreditLedgerError(
        "invalid_draw_state",
        `cannot grow draw ${args.drawId}: status is ${draw.status}`,
        { currentStatus: draw.status }
      );
    }
    if (credit.status !== "active") throw terminalCreditError(args.creditId);
    if (args.jobId !== undefined && draw.jobId !== args.jobId) {
      throw new CreditLedgerError(
        "draw_conflict",
        `draw ${args.drawId} on credit ${args.creditId} belongs to a different job`,
        { expectedJobId: draw.jobId }
      );
    }
    const pending = pendingSums(credit);
    const available = credit.balanceMicro - pending.micro;
    // cumulative growth is bounded by what the job cumulatively
    // asked; the excess is refused rather than thrown, so the funding that came
    // with it stays available balance. See `CreditLedger.growDraw`.
    const headroom =
      args.capMicro === undefined
        ? args.addAmountMicro
        : Math.max(0, args.capMicro - draw.grownMicro);
    const grantMicro = Math.min(args.addAmountMicro, headroom);
    if (grantMicro <= 0) {
      return {
        ...drawResult(draw, credit),
        replayed: false,
        addedRailValue: { drawMsats: 0, drawNative: null },
        addedAmountMicro: 0,
        cappedMicro: args.addAmountMicro,
      };
    }
    if (grantMicro > available) {
      throw new CreditLedgerError(
        "insufficient_credit",
        `top-up draw of ${grantMicro} exceeds available balance ${available}`,
        {
          availableMicro: available,
          balanceMicro: credit.balanceMicro,
          requestedMicro: grantMicro,
        }
      );
    }
    const added = growthRailValue({
      earmark: clipEarmark(args.addRailValue, grantMicro, args.addAmountMicro),
      amountMicro: grantMicro,
      availableMicro: available,
      availableMsats: Math.max(0, credit.msatsRemaining - pending.msats),
      availableNative:
        credit.nativeRemaining === null
          ? null
          : Math.max(0, credit.nativeRemaining - pending.native),
    });
    draw.amountMicro += grantMicro;
    draw.grownMicro += grantMicro;
    draw.balanceAfterMicro = available - grantMicro;
    draw.drawMsats += added.drawMsats;
    if (added.drawNative !== null) draw.drawNative = (draw.drawNative ?? 0) + added.drawNative;
    return {
      ...drawResult(draw, credit),
      replayed: false,
      addedRailValue: added,
      addedAmountMicro: grantMicro,
      cappedMicro: args.addAmountMicro - grantMicro,
    };
  }

  get(creditId: string, opts?: { nowMs?: number }): Promise<CreditSnapshot | undefined> {
    const credit = this.credits.get(creditId);
    return Promise.resolve(credit ? this.snapshot(credit, opts?.nowMs ?? Date.now()) : undefined);
  }

  getForCaller(callerPubkey: string, opts?: { nowMs?: number }): Promise<CreditSnapshot[]> {
    const nowMs = opts?.nowMs ?? Date.now();
    return Promise.resolve(
      [...this.credits.values()]
        .filter((c) => c.callerPubkey === callerPubkey)
        .sort((a, b) => a.createdAt - b.createdAt || a.creditId.localeCompare(b.creditId))
        .map((c) => this.snapshot(c, nowMs))
    );
  }

  getDraw(args: { creditId: string; drawId: string }): Promise<DrawRecord | undefined> {
    const credit = this.credits.get(args.creditId);
    const draw = credit?.draws.get(args.drawId);
    return Promise.resolve(draw && credit ? drawRecord(draw, credit) : undefined);
  }

  getDrawByJobId(jobId: string): Promise<DrawRecord | undefined> {
    const matches: DrawRecord[] = [];
    for (const credit of this.credits.values()) {
      for (const draw of credit.draws.values()) {
        if (draw.jobId === jobId) matches.push(drawRecord(draw, credit));
      }
    }
    return Promise.resolve(matches.length === 1 ? matches[0] : undefined);
  }

  listDrawsByJobId(jobId: string): Promise<DrawRecord[]> {
    const matches: DrawRecord[] = [];
    for (const credit of this.credits.values()) {
      for (const draw of credit.draws.values()) {
        if (draw.jobId === jobId) matches.push(drawRecord(draw, credit));
      }
    }
    matches.sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        a.creditId.localeCompare(b.creditId) ||
        a.ledgerSeq - b.ledgerSeq
    );
    return Promise.resolve(matches);
  }

  listPendingDraws(creditId: string): Promise<DrawRecord[]> {
    const credit = this.credits.get(creditId);
    if (!credit) return Promise.resolve([]);
    return Promise.resolve(
      [...credit.draws.values()]
        .filter((d) => d.status === "pending")
        .sort((a, b) => a.ledgerSeq - b.ledgerSeq)
        .map((d) => drawRecord(d, credit))
    );
  }

  listStalePendingDraws(args: {
    createdBeforeMs: number;
    limit: number;
    after?: StalePendingDrawCursor;
  }): Promise<DrawRecord[]> {
    const out: DrawRecord[] = [];
    for (const credit of this.credits.values()) {
      for (const draw of credit.draws.values()) {
        if (draw.status !== "pending") continue;
        if (draw.createdAt >= args.createdBeforeMs) continue;
        out.push(drawRecord(draw, credit));
      }
    }
    out.sort(compareStaleDrawKey);
    const after = args.after;
    const page = after ? out.filter((d) => compareStaleDrawKey(d, after) > 0) : out;
    return Promise.resolve(page.slice(0, args.limit));
  }

  earnedNativeForX402Channel(channelId: string): Promise<number | undefined> {
    for (const credit of this.credits.values()) {
      if (credit.x402ChannelId !== channelId) continue;
      let earned = 0;
      for (const draw of credit.draws.values()) {
        if (draw.status !== "settled" || draw.drawNative === null) continue;
        earned += draw.drawNative;
      }
      return Promise.resolve(earned);
    }
    return Promise.resolve(undefined);
  }

  getCreditByX402Channel(channelId: string): Promise<CreditSnapshot | undefined> {
    for (const credit of this.credits.values()) {
      if (credit.x402ChannelId === channelId) {
        return Promise.resolve(this.snapshot(credit, Date.now()));
      }
    }
    return Promise.resolve(undefined);
  }

  terminalizeTempoCredits(
    evidence: TempoCreditLossEvidence,
    _tx?: CreditLedgerQuerier
  ): Promise<TempoCreditLoss[]> {
    return run(() => {
      const channelId = evidence.channelId.toLowerCase();
      const observedAt = evidence.observedAt ?? Date.now();
      for (const credit of this.credits.values()) {
        if (credit.tempoChannelId !== channelId) continue;
        if (credit.status === "unbacked") continue;
        const consumedServiceMicro = [...credit.draws.values()]
          .filter((draw) => draw.status === "settled")
          .reduce((sum, draw) => sum + draw.amountMicro, 0);
        this.tempoLosses.set(credit.creditId, {
          creditId: credit.creditId,
          channelId,
          callerPubkey: credit.callerPubkey,
          currency: credit.currency,
          formerBalanceMicro: credit.balanceMicro,
          settledOnChainNative: evidence.settledOnChainNative,
          highestVoucherNative: evidence.highestVoucherNative,
          consumedServiceMicro,
          consumedNative: evidence.consumedNative,
          observedAt,
        });
        credit.status = "unbacked";
      }
      return [...this.tempoLosses.values()].filter((loss) => loss.channelId === channelId);
    });
  }

  listTempoCreditLosses(args?: { limit?: number }): Promise<TempoCreditLoss[]> {
    return Promise.resolve(
      [...this.tempoLosses.values()]
        .sort((a, b) => b.observedAt - a.observedAt || a.creditId.localeCompare(b.creditId))
        .slice(0, args?.limit ?? 50)
    );
  }

  terminalizeX402Credit(
    evidence: X402CreditLossEvidence,
    _tx?: CreditLedgerQuerier
  ): Promise<X402CreditLoss[]> {
    return run(() => {
      const channelId = evidence.channelId.toLowerCase();
      const observedAt = evidence.observedAt ?? Date.now();
      for (const credit of this.credits.values()) {
        if (credit.x402ChannelId !== channelId) continue;
        const hasLiability =
          credit.balanceMicro > 0 ||
          [...credit.drains.values()].some(
            (drain) => drain.status === "pending" || drain.status === "parked"
          );
        if (!hasLiability) {
          if (credit.status === "unbacked") {
            credit.status = "active";
            this.x402Losses.delete(credit.creditId);
          }
          continue;
        }
        if (credit.status === "unbacked") continue;
        const consumedServiceMicro = [...credit.draws.values()]
          .filter((draw) => draw.status === "settled")
          .reduce((sum, draw) => sum + draw.amountMicro, 0);
        this.x402Losses.set(credit.creditId, {
          creditId: credit.creditId,
          channelId,
          callerPubkey: credit.callerPubkey,
          currency: credit.currency,
          formerBalanceMicro: credit.balanceMicro,
          channelBalanceNative: evidence.channelBalanceNative,
          totalClaimedNative: evidence.totalClaimedNative,
          consumedServiceMicro,
          observedAt,
        });
        credit.status = "unbacked";
      }
      return [...this.x402Losses.values()].filter((loss) => loss.channelId === channelId);
    });
  }

  listX402CreditLosses(args?: { limit?: number }): Promise<X402CreditLoss[]> {
    return Promise.resolve(
      [...this.x402Losses.values()]
        .sort((a, b) => b.observedAt - a.observedAt || a.creditId.localeCompare(b.creditId))
        .slice(0, args?.limit ?? 50)
    );
  }

  async requestDrain(args: {
    creditId: string;
    drainId: string;
    callerPubkey: string;
    method: DrainMethod;
    payout: Record<string, string>;
    requireNoPending?: boolean;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainRequestResult> {
    // A drain wedged on its own settlement must stay re-enterable, or the
    // caller retry and the operator repair are both refused by the settlement
    // they exist to resolve.
    const wedged = await this.blockingRefundForCredit(
      args.creditId,
      X402_WEDGED_SETTLEMENT_STATUSES
    );
    const x402Refund = wedged?.effectId === `${args.creditId}:${args.drainId}` ? undefined : wedged;
    return run(() => {
      const nowMs = args.nowMs ?? Date.now();
      const credit = this.requireCredit(args.creditId);
      if (credit.callerPubkey !== args.callerPubkey) {
        throw new CreditLedgerError(
          "caller_mismatch",
          `credit ${args.creditId} belongs to a different caller pubkey`
        );
      }
      const existing = credit.drains.get(args.drainId);
      if (existing) {
        if (
          existing.method !== args.method ||
          JSON.stringify(existing.payout) !== JSON.stringify(args.payout)
        ) {
          throw new CreditLedgerError(
            "drain_conflict",
            `drain ${args.drainId} on credit ${args.creditId} was recorded with a different method or payout`
          );
        }
        return {
          drain: drainRecord(existing, credit),
          credit: this.snapshot(credit, nowMs),
          replayed: true,
        };
      }
      if (credit.status !== "active") throw terminalCreditError(args.creditId);
      if (x402Refund) throw x402SettlementPending(args.creditId, x402Refund);
      const pending = pendingSums(credit);
      const availableMicro = credit.balanceMicro - pending.micro;
      if (args.requireNoPending && pending.micro > 0) {
        throw new CreditLedgerError(
          "drain_conflict",
          `credit ${args.creditId} has pending draws that must finish before it can drain`,
          { drainConflict: "pending_draws" }
        );
      }
      if (availableMicro <= 0) {
        throw new CreditLedgerError(
          "nothing_to_drain",
          `credit ${args.creditId} has no available balance to drain`,
          { availableMicro, balanceMicro: credit.balanceMicro }
        );
      }
      const depletion = isNonChannelBitcoinRail(credit.rail)
        ? depleteLots(openLots(credit), availableMicro)
        : undefined;
      const inKind = depletion !== undefined && isInKindDepletion(depletion, availableMicro);
      const grossSats = inKind ? depletion.satsOwed : null;
      const owedSats = grossSats === null ? null : netOwedSats(grossSats);
      if (owedSats === 0) {
        // Its own code — see `CreditLedger.requestDrain` for why dust must not
        // borrow `nothing_to_drain`'s retryable wait-and-retry copy.
        throw new CreditLedgerError(
          "drain_below_dust",
          `credit ${args.creditId} holds ${availableMicro} micro, worth ${grossSats ?? 0} sats at the rate it was funded — no more than the ${DRAIN_DELIVERY_RESERVE_SATS} sats it costs to hand back`,
          { availableMicro, balanceMicro: credit.balanceMicro }
        );
      }
      const ledgerSeq = credit.lastLedgerSeq + 1;
      const drainedMsats = Math.max(0, credit.msatsRemaining - pending.msats);
      const drainedNative =
        credit.nativeRemaining === null
          ? null
          : Math.max(0, credit.nativeRemaining - pending.native);
      credit.lastLedgerSeq = ledgerSeq;
      credit.balanceMicro -= availableMicro;
      credit.msatsRemaining = Math.min(credit.msatsRemaining, pending.msats);
      if (credit.nativeRemaining !== null) {
        credit.nativeRemaining = Math.min(credit.nativeRemaining, pending.native);
      }
      const drain: MemoryDrain = {
        drainId: args.drainId,
        method: args.method,
        payout: { ...args.payout },
        amountMicro: availableMicro,
        balanceAfterMicro: credit.balanceMicro,
        drainedMsats,
        drainedNative,
        owedSats,
        lotDebits: depletion?.debits ?? [],
        ledgerSeq,
        status: "pending",
        token: null,
        sentRef: null,
        fulfilment: null,
        receipts: [],
        createdAt: nowMs,
        parkedAt: null,
        pickedUpAt: null,
        sentAt: null,
        releasedAt: null,
        writeOffNote: null,
        writtenOffAt: null,
      };
      applyLotDebits(credit, drain.lotDebits, -1);
      credit.drains.set(args.drainId, drain);
      return {
        drain: drainRecord(drain, credit),
        credit: this.snapshot(credit, nowMs),
        replayed: false,
      };
    });
  }

  bitcoinDepositLiability(): Promise<BitcoinDepositLiability> {
    const byRail = new Map<
      string,
      { rail: NonChannelBitcoinRail; sats: number; credits: number }
    >();
    const byCurrency = new Map<string, { currency: string; micro: number; credits: number }>();
    const uncoveredByCurrency = new Map<
      string,
      { currency: string; micro: number; credits: number }
    >();
    const unbackedByCurrency = new Map<
      string,
      { currency: string; micro: number; credits: number }
    >();
    const liability: BitcoinDepositLiability = {
      depositSats: 0,
      credits: 0,
      byRail: [],
      byCurrency: [],
      uncoveredCredits: 0,
      uncoveredByCurrency: [],
      unbackedCredits: 0,
      unbackedByCurrency: [],
    };
    for (const credit of this.credits.values()) {
      if (!isNonChannelBitcoinRail(credit.rail)) continue;
      if (credit.tempoChannelId !== null || credit.x402ChannelId !== null) continue;
      if (credit.balanceMicro <= 0) continue;
      const lots = openLots(credit);
      const covered = lots.reduce((sum, lot) => sum + lot.remainingMicro, 0);
      const basisless = lots.reduce(
        (sum, lot) => sum + (lot.satsFunded === 0 && !lot.satsBasisKnown ? lot.remainingMicro : 0),
        0
      );
      // Mirrors `IN_KIND_PREDICATE` — a credit the reclaim would price off a
      // live rate contributes no in-kind sats and is reported whole as a gap.
      const inKind = covered >= credit.balanceMicro && basisless === 0;
      const owed = inKind ? lotOwedSats(lots) : 0;
      liability.depositSats += owed;
      liability.credits++;
      if (covered < credit.balanceMicro) {
        liability.uncoveredCredits++;
        const currency = uncoveredByCurrency.get(credit.currency) ?? {
          currency: credit.currency,
          micro: 0,
          credits: 0,
        };
        currency.micro += credit.balanceMicro;
        currency.credits++;
        uncoveredByCurrency.set(credit.currency, currency);
      } else if (basisless > 0) {
        liability.unbackedCredits++;
        const currency = unbackedByCurrency.get(credit.currency) ?? {
          currency: credit.currency,
          micro: 0,
          credits: 0,
        };
        currency.micro += credit.balanceMicro;
        currency.credits++;
        unbackedByCurrency.set(credit.currency, currency);
      }
      const rail = byRail.get(credit.rail) ?? { rail: credit.rail, sats: 0, credits: 0 };
      rail.sats += owed;
      rail.credits++;
      byRail.set(credit.rail, rail);
      const currency = byCurrency.get(credit.currency) ?? {
        currency: credit.currency,
        micro: 0,
        credits: 0,
      };
      currency.micro += credit.balanceMicro;
      currency.credits++;
      byCurrency.set(credit.currency, currency);
    }
    liability.byRail = [...byRail.values()];
    liability.byCurrency = [...byCurrency.values()];
    liability.uncoveredByCurrency = [...uncoveredByCurrency.values()];
    liability.unbackedByCurrency = [...unbackedByCurrency.values()];
    return Promise.resolve(liability);
  }

  listFundingLots(creditId: string): Promise<FundingLot[]> {
    const credit = this.credits.get(creditId);
    return Promise.resolve(credit ? openLots(credit).map((lot) => ({ ...lot })) : []);
  }

  getDrain(args: { creditId: string; drainId: string }): Promise<CreditDrainRecord | undefined> {
    const credit = this.credits.get(args.creditId);
    const drain = credit?.drains.get(args.drainId);
    return Promise.resolve(drain && credit ? drainRecord(drain, credit) : undefined);
  }

  listPendingDrains(): Promise<CreditDrainRecord[]> {
    const out: CreditDrainRecord[] = [];
    for (const credit of this.credits.values()) {
      for (const drain of credit.drains.values()) {
        if (drain.status === "pending" || drain.status === "exit_required") out.push(drainRecord(drain, credit));
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.creditId.localeCompare(b.creditId));
    return Promise.resolve(out);
  }

  listChannelDrains(args: {
    limit: number;
    after?: ChannelDrainCursor;
    createdBeforeMs: number;
    rail: "tempo";
    includeResolved?: boolean;
  }): Promise<CreditDrainRecord[]> {
    const out: CreditDrainRecord[] = [];
    for (const credit of this.credits.values()) {
      if (credit.tempoChannelId === null) continue;
      for (const drain of credit.drains.values()) {
        if ((drain.status !== "pending" && drain.status !== "exit_required") || drain.method !== "tempo") continue;
        if (drain.createdAt > args.createdBeforeMs) continue;
        if (!args.includeResolved && drain.writtenOffAt !== null) continue;
        out.push(drainRecord(drain, credit));
      }
    }
    out.sort(
      (a, b) =>
        a.createdAt - b.createdAt ||
        a.creditId.localeCompare(b.creditId) ||
        a.drainId.localeCompare(b.drainId)
    );
    const after = args.after;
    const page = after
      ? out.filter(
          (row) =>
            row.createdAt > after.createdAt ||
            (row.createdAt === after.createdAt &&
              (row.creditId > after.creditId ||
                (row.creditId === after.creditId && row.drainId > after.drainId)))
        )
      : out;
    return Promise.resolve(page.slice(0, args.limit));
  }

  writeOffDrain(args: {
    creditId: string;
    drainId: string;
    note?: string;
    nowMs?: number;
  }): Promise<DrainWriteOff | undefined> {
    const credit = this.credits.get(args.creditId);
    const drain = credit?.drains.get(args.drainId);
    if (!credit || !drain) return Promise.resolve(undefined);
    if (drain.status !== "pending" || drain.writtenOffAt !== null) {
      return Promise.resolve({ drain: drainRecord(drain, credit), written: false });
    }
    drain.writeOffNote = args.note ?? null;
    drain.writtenOffAt = args.nowMs ?? Date.now();
    return Promise.resolve({ drain: drainRecord(drain, credit), written: true });
  }

  clearDrainWriteOff(args: { creditId: string; drainId: string }): Promise<void> {
    const drain = this.credits.get(args.creditId)?.drains.get(args.drainId);
    if (drain) {
      drain.writeOffNote = null;
      drain.writtenOffAt = null;
    }
    return Promise.resolve();
  }

  requireTempoDrainExit(args: { creditId: string; drainId: string }): Promise<DrainTransitionResult> {
    return run(() => {
      const { credit, drain } = this.requireDrain(args.creditId, args.drainId);
      if (drain.status === "exit_required" || drain.status === "sent") {
        return { drain: drainRecord(drain, credit), replayed: true };
      }
      if (drain.status !== "pending" || drain.method !== "tempo" || !credit.tempoChannelId) {
        throw this.transitionRefusal(drain, "require timed exit");
      }
      drain.status = "exit_required";
      return { drain: drainRecord(drain, credit), replayed: false };
    });
  }

  releaseDrain(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainReleaseResult> {
    return run(() => {
      const { credit, drain } = this.requireDrain(args.creditId, args.drainId);
      if (drain.status === "released") {
        return {
          drain: drainRecord(drain, credit),
          credit: this.snapshot(credit, args.nowMs ?? Date.now()),
          replayed: true,
        };
      }
      if (drain.status !== "pending") {
        throw new CreditLedgerError(
          "invalid_drain_state",
          `cannot release ${drain.method} drain ${args.drainId} from status ${drain.status}`
        );
      }
      drain.status = "released";
      drain.releasedAt = args.nowMs ?? Date.now();
      credit.balanceMicro += drain.amountMicro;
      credit.msatsRemaining += drain.drainedMsats;
      if (credit.nativeRemaining !== null && drain.drainedNative !== null) {
        credit.nativeRemaining += drain.drainedNative;
      }
      applyLotDebits(credit, drain.lotDebits, 1);
      return {
        drain: drainRecord(drain, credit),
        credit: this.snapshot(credit, args.nowMs ?? Date.now()),
        replayed: false,
      };
    });
  }

  parkDrain(args: {
    creditId: string;
    drainId: string;
    token: string;
    fulfilment?: DrainFulfilment;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<CreditDrainRecord> {
    return run(() => {
      const { credit, drain } = this.requireDrain(args.creditId, args.drainId);
      if (drain.status === "pending" && drain.method === "cashu") {
        drain.status = "parked";
        drain.token = args.token;
        if (args.fulfilment) drain.fulfilment = args.fulfilment;
        drain.parkedAt = args.nowMs ?? Date.now();
        return drainRecord(drain, credit);
      }
      if (
        (drain.status === "parked" || drain.status === "picked_up") &&
        drain.token === args.token
      ) {
        return drainRecord(drain, credit);
      }
      throw this.transitionRefusal(drain, "park");
    });
  }

  markDrainPickedUp(args: {
    creditId: string;
    drainId: string;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult> {
    return run(() => {
      const { credit, drain } = this.requireDrain(args.creditId, args.drainId);
      if (drain.status === "parked") {
        drain.status = "picked_up";
        drain.pickedUpAt = args.nowMs ?? Date.now();
        return { drain: drainRecord(drain, credit), replayed: false };
      }
      if (drain.status === "picked_up")
        return { drain: drainRecord(drain, credit), replayed: true };
      throw this.transitionRefusal(drain, "mark picked up");
    });
  }

  markDrainSent(args: {
    creditId: string;
    drainId: string;
    sentRef: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
    nowMs?: number;
  }): Promise<DrainTransitionResult> {
    return run(() => {
      const { credit, drain } = this.requireDrain(args.creditId, args.drainId);
      if ((drain.status === "pending" || drain.status === "exit_required") && drain.method !== "cashu") {
        drain.status = "sent";
        drain.sentRef = { ...args.sentRef };
        drain.sentAt = args.nowMs ?? Date.now();
        return { drain: drainRecord(drain, credit), replayed: false };
      }
      if (drain.status === "sent") return { drain: drainRecord(drain, credit), replayed: true };
      throw this.transitionRefusal(drain, "mark sent");
    });
  }

  appendDrainReceipt(args: {
    creditId: string;
    drainId: string;
    receipt: Record<string, unknown>;
    tx?: CreditLedgerQuerier;
  }): Promise<void> {
    return run(() => {
      const drain = this.credits.get(args.creditId)?.drains.get(args.drainId);
      if (drain) drain.receipts.push(args.receipt);
    });
  }

  private requireDrain(
    creditId: string,
    drainId: string
  ): { credit: MemoryCredit; drain: MemoryDrain } {
    const credit = this.credits.get(creditId);
    const drain = credit?.drains.get(drainId);
    if (!credit || !drain) {
      throw new CreditLedgerError(
        "drain_not_found",
        `drain ${drainId} not found on credit ${creditId}`
      );
    }
    return { credit, drain };
  }

  private transitionRefusal(drain: MemoryDrain, verb: string): CreditLedgerError {
    return new CreditLedgerError(
      drain.status === "parked" || drain.status === "picked_up" || drain.status === "sent"
        ? "drain_conflict"
        : "invalid_drain_state",
      `cannot ${verb} drain ${drain.drainId}: status is ${drain.status} (method ${drain.method})`
    );
  }

  private resolve(args: {
    creditId: string;
    drawId: string;
    to: "settled" | "released";
    nowMs?: number;
  }): DrawResolution {
    const nowMs = args.nowMs ?? Date.now();
    const credit = this.requireCredit(args.creditId);
    const draw = credit.draws.get(args.drawId);
    if (!draw) {
      throw new CreditLedgerError(
        "draw_not_found",
        `draw ${args.drawId} not found on credit ${args.creditId}`
      );
    }
    let replayed = false;
    if (draw.status === args.to) {
      replayed = true;
    } else if (draw.status !== "pending") {
      throw new CreditLedgerError(
        "invalid_draw_state",
        `cannot ${args.to === "settled" ? "settle" : "release"} draw ${args.drawId}: status is ${draw.status}`,
        { currentStatus: draw.status }
      );
    } else {
      draw.status = args.to;
      draw.resolvedAt = nowMs;
      if (args.to === "settled") {
        credit.balanceMicro -= draw.amountMicro;
        // FIFO depletion replaces the pooled hold forecast at settlement. Use the shared
        // inKindDrawMsats arithmetic so memory and SQL book the same sats value.
        if (isNonChannelBitcoinRail(credit.rail)) {
          const depletion = depleteLots(openLots(credit), draw.amountMicro);
          const settledMsats = inKindDrawMsats(depletion, draw.amountMicro);
          draw.settledSats = settledMsats === null ? null : settledMsats / 1000;
          if (settledMsats !== null && settledMsats !== draw.drawMsats) {
            // Keep the superseded forecast: the job's `paidMsats` counter was
            // built from it, so booking revenue swaps this draw's component
            // out rather than replacing the whole total.
            draw.allocatedMsats = draw.drawMsats;
            draw.drawMsats = settledMsats;
          }
          applyLotDebits(credit, depletion.debits, -1);
        }
        credit.msatsRemaining = Math.max(0, credit.msatsRemaining - draw.drawMsats);
        if (credit.nativeRemaining !== null) {
          credit.nativeRemaining = Math.max(0, credit.nativeRemaining - (draw.drawNative ?? 0));
        }
      }
    }
    return {
      ...drawResult(draw, credit),
      status: args.to,
      replayed,
      availableMicro:
        credit.status === "unbacked" ? 0 : credit.balanceMicro - pendingSums(credit).micro,
      resolvedAt: draw.resolvedAt ?? nowMs,
    };
  }

  private requireCredit(creditId: string): MemoryCredit {
    const credit = this.credits.get(creditId);
    if (!credit) {
      throw new CreditLedgerError("credit_not_found", `credit ${creditId} not found`);
    }
    return credit;
  }

  private snapshot(credit: MemoryCredit, nowMs: number): CreditSnapshot {
    const pending = pendingSums(credit);
    const live = credit.status === "active";
    return {
      creditId: credit.creditId,
      callerPubkey: credit.callerPubkey,
      currency: credit.currency,
      balanceMicro: credit.balanceMicro,
      availableMicro: live ? credit.balanceMicro - pending.micro : 0,
      nativeAvailable:
        credit.nativeRemaining === null
          ? null
          : live
            ? Math.max(0, credit.nativeRemaining - pending.native)
            : 0,
      expiryMs: credit.expiryMs,
      expired: credit.expiryMs <= nowMs,
      status: credit.status,
      lastLedgerSeq: credit.lastLedgerSeq,
      createdAt: credit.createdAt,
      rail: credit.rail,
      tempoChannelId: credit.tempoChannelId,
      x402ChannelId: credit.x402ChannelId,
    };
  }
}

interface MemoryCredit {
  creditId: string;
  callerPubkey: string;
  currency: string;
  balanceMicro: number;
  expiryMs: number;
  status: CreditStatus;
  lastLedgerSeq: number;
  lastFundingLedgerSeq: number | null;
  createdAt: number;
  draws: Map<string, MemoryDraw>;
  rail: string | null;
  nativeAsset: string | null;
  mint: string | null;
  fundingRef: string | null;
  tempoChannelId: string | null;
  msatsRemaining: number;
  /** `null` marks a rail that reports no native amount — distinct from fully drawn at 0. */
  nativeRemaining: number | null;
  x402ChannelId: string | null;
  drains: Map<string, MemoryDrain>;
  lots: FundingLot[];
}

function terminalCreditError(creditId: string): CreditLedgerError {
  return new CreditLedgerError(
    "credit_unbacked",
    `credit ${creditId} is terminal; its Tempo backing finalized before the DVM was protected`
  );
}

interface MemoryDrain {
  drainId: string;
  method: DrainMethod;
  payout: Record<string, string>;
  amountMicro: number;
  balanceAfterMicro: number;
  drainedMsats: number;
  drainedNative: number | null;
  owedSats: number | null;
  lotDebits: LotDebit[];
  ledgerSeq: number;
  status: DrainStatus;
  token: string | null;
  sentRef: Record<string, unknown> | null;
  fulfilment: DrainFulfilment | null;
  receipts: Record<string, unknown>[];
  createdAt: number;
  parkedAt: number | null;
  pickedUpAt: number | null;
  sentAt: number | null;
  releasedAt: number | null;
  writeOffNote: string | null;
  writtenOffAt: number | null;
}

interface MemoryDraw {
  creditId: string;
  drawId: string;
  amountMicro: number;
  jobId: string | null;
  ledgerSeq: number;
  status: DrawStatus;
  balanceAfterMicro: number;
  createdAt: number;
  resolvedAt: number | null;
  drawMsats: number;
  drawNative: number | null;
  /** Cumulative mid-job growth, used as the draw-growth cap's left-hand side. */
  grownMicro: number;
  /**
   * The pooled allocation `drawMsats` held before the settle re-priced it off
   * the funding lots — absent on every draw that was never
   * re-priced, where `drawMsats` is still the allocation.
   */
  allocatedMsats?: number;
  settledSats?: number | null;
}

function applyBasis(credit: MemoryCredit, basis: CreditFundingBasis): void {
  credit.rail ??= basis.rail;
  if (basis.nativeAsset !== undefined) credit.nativeAsset = basis.nativeAsset;
  if (basis.mint !== undefined) credit.mint = basis.mint;
  if (basis.fundingRef !== undefined) credit.fundingRef = basis.fundingRef;
  if (basis.tempoSession) credit.tempoChannelId ??= basis.tempoSession.channelId.toLowerCase();
  credit.x402ChannelId ??= basis.x402Channel?.channelId ?? null;
  credit.msatsRemaining += basis.paidMsats;
  if (basis.nativeAmount !== undefined) {
    credit.nativeRemaining = (credit.nativeRemaining ?? 0) + basis.nativeAmount;
  }
}

function recordLot(
  credit: MemoryCredit,
  amountMicro: number,
  basis: CreditFundingBasis,
  nowMs: number
): void {
  if (!isNonChannelBitcoinRail(basis.rail)) return;
  if (basis.tempoSession || basis.x402Channel) return;
  credit.lots.push({
    lotId: `lot:${randomUUID()}`,
    creditId: credit.creditId,
    rail: basis.rail,
    satsFunded: Math.floor(basis.paidMsats / 1000),
    creditedMicro: amountMicro,
    remainingMicro: amountMicro,
    fundingRef: basis.fundingRef ?? null,
    createdAt: nowMs,
  });
}

function applyLotDebits(credit: MemoryCredit, debits: LotDebit[], sign: 1 | -1): void {
  for (const debit of debits) {
    const lot = credit.lots.find((candidate) => candidate.lotId === debit.lotId);
    if (!lot) continue;
    lot.remainingMicro = Math.max(
      0,
      Math.min(lot.remainingMicro + sign * debit.micro, lot.creditedMicro)
    );
  }
}

/**
 * Use the shared FIFO order, including lot_id for same-millisecond ties. Push order alone can
 * differ from Postgres and price the same deposits differently.
 */
function openLots(credit: MemoryCredit): FundingLot[] {
  return credit.lots.filter((lot) => lot.remainingMicro > 0).sort(fifoOrder);
}

/** Turn a synchronous ledger operation into the promise contract callers expect —
 * a refusal REJECTS (matching the Postgres ledger) instead of throwing sync. */
function run<T>(fn: () => T): Promise<T> {
  try {
    return Promise.resolve(fn());
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Collision-free composite key — both halves are caller-supplied strings. */
function fundingKey(creditId: string, fundId: string): string {
  return JSON.stringify([creditId, fundId]);
}

function pendingSums(credit: MemoryCredit): { micro: number; msats: number; native: number } {
  const sums = { micro: 0, msats: 0, native: 0 };
  for (const d of credit.draws.values()) {
    if (d.status !== "pending") continue;
    sums.micro += d.amountMicro;
    sums.msats += d.drawMsats;
    sums.native += d.drawNative ?? 0;
  }
  return sums;
}

function railValue(draw: MemoryDraw, credit: MemoryCredit): DrawRailValue {
  return {
    drawMsats: draw.drawMsats,
    drawNative: draw.drawNative,
    rail: credit.rail,
    nativeAsset: credit.nativeAsset,
    mint: credit.mint,
    fundingRef: credit.fundingRef,
    creditCurrency: credit.currency,
  };
}

function drawResult(
  draw: MemoryDraw,
  credit: MemoryCredit
): Omit<DrawResult, "replayed"> & { replayed: false } {
  return {
    creditId: draw.creditId,
    drawId: draw.drawId,
    amountMicro: draw.amountMicro,
    balanceAfterMicro: draw.balanceAfterMicro,
    ledgerSeq: draw.ledgerSeq,
    status: draw.status,
    replayed: false,
    railValue: railValue(draw, credit),
    resolvedAt: draw.resolvedAt,
  };
}

function drawRecord(draw: MemoryDraw, credit: MemoryCredit): DrawRecord {
  const { replayed: _replayed, ...rest } = drawResult(draw, credit);
  return {
    ...rest,
    jobId: draw.jobId,
    createdAt: draw.createdAt,
    allocatedMsats: draw.allocatedMsats ?? draw.drawMsats,
  };
}

/**
 * `ORDER BY d.created_at, d.credit_id, d.ledger_seq` — the Postgres ledger's
 * stale-draw sort key, so keyset paging lands on the same rows here.
 */
function compareStaleDrawKey(a: StalePendingDrawCursor, b: StalePendingDrawCursor): number {
  return (
    a.createdAt - b.createdAt || a.creditId.localeCompare(b.creditId) || a.ledgerSeq - b.ledgerSeq
  );
}

function compareInvoiceKeyset(a: CreditInvoiceRecord, b: CreditInvoiceRecord): number {
  return (
    a.createdAt - b.createdAt ||
    a.creditId.localeCompare(b.creditId) ||
    a.fundId.localeCompare(b.fundId)
  );
}

function compareToCursor(invoice: CreditInvoiceRecord, cursor: BlockedInvoiceCursor): number {
  return (
    invoice.createdAt - cursor.createdAt ||
    invoice.creditId.localeCompare(cursor.creditId) ||
    invoice.fundId.localeCompare(cursor.fundId)
  );
}

/**
 * Project a drain with shallow copies of its receipt array, sentRef and fulfilment. Nested
 * observations are not cloned or authenticated.
 */
function drainRecord(drain: MemoryDrain, credit: MemoryCredit): CreditDrainRecord {
  return {
    creditId: credit.creditId,
    drainId: drain.drainId,
    callerPubkey: credit.callerPubkey,
    currency: credit.currency,
    method: drain.method,
    channelId: credit.tempoChannelId ?? credit.x402ChannelId,
    payout: { ...drain.payout },
    amountMicro: drain.amountMicro,
    drainedNative: drain.drainedNative,
    owedSats: drain.owedSats,
    balanceAfterMicro: drain.balanceAfterMicro,
    ledgerSeq: drain.ledgerSeq,
    status: drain.status,
    token: drain.token,
    sentRef: drain.sentRef ? { ...drain.sentRef } : null,
    fulfilment: drain.fulfilment ? { ...drain.fulfilment } : null,
    receipts: [...drain.receipts],
    createdAt: drain.createdAt,
    parkedAt: drain.parkedAt,
    pickedUpAt: drain.pickedUpAt,
    sentAt: drain.sentAt,
    releasedAt: drain.releasedAt,
    writeOffNote: drain.writeOffNote,
    writtenOffAt: drain.writtenOffAt,
  };
}

function assertAmount(amountMicro: number, opts: { min: number }): void {
  if (!Number.isSafeInteger(amountMicro) || amountMicro < opts.min) {
    throw new CreditLedgerError(
      "invalid_amount",
      `amountMicro must be a safe integer ≥ ${opts.min} (got ${amountMicro})`
    );
  }
}
