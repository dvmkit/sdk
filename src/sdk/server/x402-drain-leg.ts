import { refundFloorEvidence } from "./credit-drain-floor";
import { commitTerminalDrain, type DrainReportWiring } from "./credit-drain-report";
import type { CreditLedgerLike, CreditLedgerQuerier, DrainTransitionResult } from "./credit-ledger";

/** Everything the ledger half of an x402 cooperative drain writes through. */
export interface X402DrainLegDeps {
  ledger: CreditLedgerLike;
  drainReport: DrainReportWiring;
}

/**
 * Extinguish the ledger liability behind one settled x402 cooperative refund.
 *
 * The single place that decides what "this refund is booked" means, shared by
 * the caller's own drain (`/v1/credit` op `drain`) and the operator repair
 * (`/admin/credit/reconcile-x402-settlement`). They differ in exactly
 * one input — which figure the settled amount is read from, the facilitator's
 * response on the live path and the chain's own logs on the repair — and
 * keeping the guard and the terminal transition in one function is what stops
 * those two doors from drifting into two answers about one payment.
 *
 * The guard itself is {@link refundFloorEvidence}, shared with the Tempo
 * cooperative close so the two rails cannot drift into two answers
 * about one refund. It is terminal by design: a shortfall is a
 * `drain_conflict`, which the caller path answers 409 and the repair path turns
 * into a named refusal with both figures on it.
 *
 * The repair path never passes `undefined`: chain evidence always carries a
 * figure.
 */
export async function completeX402ChannelDrain(args: {
  deps: X402DrainLegDeps;
  creditId: string;
  drainId: string;
  channelId: string;
  /** What the settlement paid, in the channel token's atomic units. */
  settledAmount: string | undefined;
  /** What the ledger is about to extinguish — the drain's rail-native debit. */
  debitedNative: number | null;
  /** Settlement transaction hash, recorded on the drain as its payout evidence. */
  transaction: string | undefined;
  /** Marks a drain an operator finished by hand rather than the caller's own request. */
  repaired?: boolean;
  tx?: CreditLedgerQuerier;
}): Promise<DrainTransitionResult> {
  const settlementEvidence = refundFloorEvidence({
    rail: "x402",
    refundedNative: args.settledAmount,
    debitedNative: args.debitedNative,
    creditId: args.creditId,
    drainId: args.drainId,
  });
  // The replay bit belongs to the terminal CAS, not the request transition.
  // Callers use it to countersign `sent` exactly once when a concurrent poll
  // or repair reaches this shared leg first.
  return commitTerminalDrain(
    args.deps.drainReport,
    (innerTx) =>
      args.deps.ledger.markDrainSent({
        creditId: args.creditId,
        drainId: args.drainId,
        sentRef: {
          channel_id: args.channelId,
          ...settlementEvidence,
          ...(args.transaction !== undefined ? { transaction: args.transaction } : {}),
          ...(args.repaired
            ? { repaired: true, repair_kind: "x402_settlement_reconciled" }
            : {}),
        },
        tx: innerTx,
      }),
    args.tx
  );
}
