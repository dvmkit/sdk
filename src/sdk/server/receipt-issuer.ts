import type { JsonValue } from "../../lib/cast-auth";
import type {
  DrainReceipt,
  DrainReceiptEvent,
  DrawFundingReceipt,
  FundingReceipt,
  JobReceipt,
  ReceiptCredit,
  ReceiptOutcome,
  UnsignedJobReceipt,
} from "../../lib/receipt";
import {
  computeResultHash,
  signDrainReceipt,
  signDrawFundingReceipt,
  signFundingReceipt,
  signReceipt,
} from "../../lib/receipt";
import { receiptPubkeyFromSecret } from "../../lib/receipt-key";
import type { JobRecord, JobStatus } from "./job-store";

export interface ReceiptIssuerOpts {
  /** 32-byte hex receipt secret — `DVMKIT_RECEIPT_KEY`, or an ephemeral dev key. */
  secret: string;
  /** DVM slug written into every receipt's `dvm` field. */
  dvm: string;
  /** Immutable DVM identity written into every signed receipt. */
  dvmId: string;
}

/**
 * An issuer indicates receipt support. Sequence allocation and write-once
 * persistence belong to the store; signing alone does not provide idempotency.
 */
export class ReceiptIssuer {
  /** x-only pubkey this issuer signs under; the attested `receipt_pubkey`. */
  readonly pubkey: string;

  private readonly secret: string;
  private readonly dvm: string;
  private readonly dvmId: string;

  constructor(opts: ReceiptIssuerOpts) {
    this.secret = opts.secret;
    this.dvm = opts.dvm;
    this.dvmId = opts.dvmId;
    this.pubkey = receiptPubkeyFromSecret(opts.secret);
  }

  /**
   * seq is store-allocated; issuedAt is epoch seconds. Free jobs also consume a
   * sequence and attest their outcome. Timing/attribution comes from the committed
   * terminal row; legacy rows omit unknown historical fields. credit is present
   * only for a resolved ledger draw.
   */
  issue(record: JobRecord, seq: number, issuedAt?: number, credit?: ReceiptCredit): JobReceipt {
    const unsigned: UnsignedJobReceipt = {
      v: 1,
      job_id: record.id,
      dvm_id: this.dvmId,
      dvm: this.dvm,
      capability: record.capability,
      outcome: outcomeFor(record.status),
      reason: terminalReason(record),
      ...(record.timingKnown !== false && record.terminalAtMs !== undefined && {
        timing: {
          accepted_at_ms: record.createdAt,
          terminal_at_ms: record.terminalAtMs,
          caller_wait_ms: record.callerWaitMs ?? 0,
        },
      }),
      ...(record.timingKnown !== false && record.status !== "completed" && record.endedBy && { ended_by: record.endedBy }),
      seq,
      issued_at: issuedAt ?? Math.floor(Date.now() / 1000),
      requester_pubkey: record.requesterPubkey ?? null,
      paid: {
        msats: record.paidMsats,
        rail: record.paymentRail ?? null,
        native_amount: record.nativeAmount ?? null,
        native_asset: record.nativeAsset ?? null,
        tx_hash: record.paymentTxHash ?? null,
        mint: record.paymentMint ?? null,
      },
      result_hash: resultHashFor(record),
      receipt_pubkey: this.pubkey,
      ...(credit && { credit }),
    };
    return signReceipt(unsigned, this.secret);
  }

  /**
   * Countersign one reclaim event. Unlike job receipts there is
   * no store-allocated sequence — the drain's own `ledger_seq` (taken under
   * the credit row lock, shared with draws) already orders it in the
   * per-credit evidence chain.
   */
  issueDrain(args: {
    creditId: string;
    drainId: string;
    event: DrainReceiptEvent;
    method: string;
    amountMicro: number;
    balanceAfterMicro: number;
    ledgerSeq: number;
    callerPubkey: string;
    issuedAt?: number;
  }): DrainReceipt {
    return signDrainReceipt(
      {
        v: 1,
        kind: "credit_drain",
        credit_id: args.creditId,
        drain_id: args.drainId,
        event: args.event,
        method: args.method,
        amount_micro: args.amountMicro,
        balance_after_micro: args.balanceAfterMicro,
        ledger_seq: args.ledgerSeq,
        issued_at: args.issuedAt ?? Math.floor(Date.now() / 1000),
        caller_pubkey: args.callerPubkey,
        dvm_id: this.dvmId,
        dvm: this.dvm,
        receipt_pubkey: this.pubkey,
      },
      this.secret
    );
  }

  /** Countersign the immutable tuple captured when a credit funding committed. */
  issueFunding(args: {
    creditId: string;
    fundId: string;
    fundedMicro: number;
    balanceAfterMicro: number;
    ledgerSeq: number;
    callerPubkey: string;
    issuedAt?: number;
  }): FundingReceipt {
    return signFundingReceipt(
      {
        v: 1,
        kind: "credit_funding",
        credit_id: args.creditId,
        fund_id: args.fundId,
        funded_micro: args.fundedMicro,
        balance_after_micro: args.balanceAfterMicro,
        ledger_seq: args.ledgerSeq,
        issued_at: args.issuedAt ?? Math.floor(Date.now() / 1000),
        caller_pubkey: args.callerPubkey,
        dvm_id: this.dvmId,
        dvm: this.dvm,
        receipt_pubkey: this.pubkey,
      },
      this.secret
    );
  }

  /**
   * Countersign the immutable tuple captured when a mid-job payment funded a
   * job's credit against its pending draw. `ledgerSeq` is the draw's own
   * sequence so the artifact lines up with the terminal receipt's credit block.
   */
  issueDrawFunding(args: {
    creditId: string;
    jobId: string;
    drawId: string;
    fundId: string;
    paymentSeq?: number;
    currency: string;
    fundedMicro: number;
    balanceAfterMicro: number;
    ledgerSeq: number;
    callerPubkey: string;
    issuedAt?: number;
  }): DrawFundingReceipt {
    return signDrawFundingReceipt(
      {
        v: 1,
        kind: "credit_draw_funding",
        credit_id: args.creditId,
        job_id: args.jobId,
        draw_id: args.drawId,
        fund_id: args.fundId,
        ...(args.paymentSeq !== undefined && { payment_seq: args.paymentSeq }),
        currency: args.currency,
        funded_micro: args.fundedMicro,
        balance_after_micro: args.balanceAfterMicro,
        ledger_seq: args.ledgerSeq,
        issued_at: args.issuedAt ?? Math.floor(Date.now() / 1000),
        caller_pubkey: args.callerPubkey,
        dvm_id: this.dvmId,
        dvm: this.dvm,
        receipt_pubkey: this.pubkey,
      },
      this.secret
    );
  }
}

export function isReceiptableStatus(status: JobStatus): status is ReceiptOutcome {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function outcomeFor(status: JobStatus): ReceiptOutcome {
  if (!isReceiptableStatus(status)) {
    throw new Error(`ReceiptIssuer: refusing to sign a receipt for non-terminal status ${status}`);
  }
  return status;
}

/**
 * The reason a job ended badly. Every non-success terminal path emits a
 * `cancel` message carrying its reason — `ctx.fail(error)`, the DELETE route,
 * the stale sweeper's `worker_died_mid_job` — so the trailing one is the
 * authoritative string. Falls back to the durable `summary`, which
 * `terminateJob` writes in the same transaction as the status (and which is
 * all a machine adopting another machine's terminal has to go on).
 */
function terminalReason(record: JobRecord): string | null {
  if (record.status === "completed") return null;
  for (let i = record.messages.length - 1; i >= 0; i--) {
    const msg = record.messages[i];
    if (msg.type !== "cancel") continue;
    const reason = (msg.content as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) return reason;
  }
  return record.summary ?? null;
}

/**
 * Hash what was delivered. `null` on a terminal that produced nothing —
 * neither a summary nor an artifact — so a caller can distinguish "failed
 * empty-handed" from "failed after delivering partial output", which is
 * exactly the distinction a refund claim turns on.
 *
 * The summary counts as delivered output **only on `completed`**. Every
 * durable terminal writes `summary = COALESCE(summary, reason)` in the same
 * transaction as the status (`terminateJob` in both stores), so on a reaped or
 * cross-machine-cancelled row `record.summary` is the terminal reason string,
 * not delivered output. Hashing it would make failed empty-handed jobs look
 * like partial delivery; it is already attested in the receipt's `reason`.
 */
function resultHashFor(record: JobRecord): string | null {
  const artifacts = record.messages
    .filter((m) => m.type === "artifact")
    .map((m) => m.content as unknown as JsonValue);
  const summary = record.status === "completed" ? record.summary : undefined;
  if (summary === undefined && artifacts.length === 0) return null;
  return computeResultHash(summary, artifacts);
}
