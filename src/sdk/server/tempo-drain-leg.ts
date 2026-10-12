import { refundFloorEvidence } from "./credit-drain-floor";
import { commitTerminalDrain, type DrainReportWiring } from "./credit-drain-report";
import type { CreditLedgerLike, CreditLedgerQuerier, DrainTransitionResult } from "./credit-ledger";
import type { MppxServer } from "./mpp-setup";

/** Everything the ledger half of a Tempo cooperative close writes through. */
export interface TempoDrainLegDeps {
  ledger: CreditLedgerLike;
  drainReport: DrainReportWiring;
}

/**
 * What the chain says a cooperative close paid the payer.
 *
 * Four answers, not two, for the reason `X402SettlementEvidenceOutcome` has
 * four: the read collapses "the chain says nothing happened" into "the chain
 * could not be asked" unless something keeps them apart, and only one of those
 * is actionable. `unreported` is neither — it is a close nobody here broadcast,
 * which has no receipt to be short against and takes the floor's tolerated arm.
 */
export type TempoCloseEvidence =
  /** The close receipt carries this refund, in the channel token's atomic units. */
  | { chain: "found"; transaction: string; refundedToPayer: string; settledToPayee: string }
  /** The reference names no receipt — a channel finalized some other way. */
  | { chain: "unreported"; reference: string }
  /** The RPC could not be read. Says nothing about what the close paid. */
  | { chain: "unreachable"; error: string }
  /** No confirmed close on this drain, so there is no receipt to read. */
  | { chain: "unconfirmed" };

/** The Tempo runtime a cooperative drain reads chain state through. */
export type TempoDrainRail = Pick<
  MppxServer,
  "getTempoSessionCloseAmounts" | "getTempoSessionCloseIntent"
>;

/**
 * Extinguish the ledger liability behind one landed Tempo cooperative close.
 *
 * The single place that decides what "this close is booked" means, shared by
 * the caller's own drain (`/v1/credit` op `drain`) and the operator repair
 * (`/admin/credit/reconcile-tempo-drain`) — the same arrangement
 * {@link completeX402ChannelDrain} holds for its rail, and for the same reason:
 * two doors with two answers about one payment is the drift this prevents.
 *
 * The guard is {@link refundFloorEvidence}, shared with the x402 leg
 * so neither rail nor door can drift into a second opinion about
 * one refund. A refund short of `debitedNative` throws `DrainRefundFloorError`
 * and books nothing; an equal-or-larger one records the payer's uncredited
 * channel surplus on the drain's `sent_ref`.
 *
 * Any operator write-off on the drain is cleared **inside this transaction**,
 * so a ledger leg that rolls back leaves the recorded decision exactly as it
 * found it — a booked drain never carries a stale note, and a refused reconcile
 * never quietly returns a written-off row to the live queue.
 */
export async function completeTempoChannelDrain(args: {
  deps: TempoDrainLegDeps;
  creditId: string;
  drainId: string;
  channelId: string;
  /** What the close paid the payer, in the channel token's atomic units. */
  refundedNative: string | bigint | undefined;
  /** What the ledger is about to extinguish — the drain's rail-native debit. */
  debitedNative: number | null;
  /** The close reference: a transaction hash, or the synthetic `channel:<id>`. */
  reference: string;
  /** Marks a drain an operator finished by hand rather than the caller's own poll. */
  repaired?: boolean;
  tx?: CreditLedgerQuerier;
}): Promise<DrainTransitionResult> {
  const settlementEvidence = refundFloorEvidence({
    rail: "tempo",
    refundedNative: args.refundedNative,
    debitedNative: args.debitedNative,
    creditId: args.creditId,
    drainId: args.drainId,
  });
  // `replayed` is returned rather than dropped: it is what stops the operator
  // repair countersigning a second `sent` receipt when a concurrent poll won
  // the CAS between its status read and this transition.
  return commitTerminalDrain(
    args.deps.drainReport,
    async (innerTx) => {
      await args.deps.ledger.clearDrainWriteOff({
        creditId: args.creditId,
        drainId: args.drainId,
        tx: innerTx,
      });
      return args.deps.ledger.markDrainSent({
        creditId: args.creditId,
        drainId: args.drainId,
        sentRef: {
          tx_hash: args.reference,
          channel_id: args.channelId,
          ...settlementEvidence,
          ...(args.repaired
            ? { repaired: true, repair_kind: "tempo_close_reconciled" }
            : {}),
        },
        tx: innerTx,
      });
    },
    args.tx
  );
}

/**
 * What a landed close paid the payer, when the reference names a receipt.
 *
 * A close reference is either the transaction hash of a close this DVM
 * broadcast, or the synthetic `channel:<id>` `recoverTempoSessionClose` records
 * for a channel that finalized some other way. Only the first names a receipt
 * to read; the second returns `undefined`, which the floor tolerates with a
 * warning, since a close nobody here submitted has no evidence to be short
 * against.
 */
export async function tempoCloseRefund(
  mpp: TempoDrainRail,
  channelId: string,
  reference: string
): Promise<bigint | undefined> {
  if (!mpp.getTempoSessionCloseAmounts || !isTempoTransactionHash(reference)) return undefined;
  const closed = await mpp.getTempoSessionCloseAmounts({
    channelId,
    txHash: reference as `0x${string}`,
  });
  return closed?.refundedToPayer;
}

/**
 * Classify what the chain can say about one wedged drain, without throwing.
 *
 * The repair queue reads this per row, so an RPC that cannot answer marks that
 * row `unreachable` rather than failing the operator's whole page — and the
 * reconcile reads it too, because "the chain says nothing happened" (a
 * definitive 422) and "the chain could not be asked" (a 502 a retry may fix)
 * must never collapse into one answer.
 */
export async function classifyTempoCloseEvidence(
  mpp: TempoDrainRail,
  channelId: string
): Promise<TempoCloseEvidence> {
  let reference: string | undefined;
  try {
    const intent = await mpp.getTempoSessionCloseIntent?.(channelId);
    reference = intent?.reference ?? undefined;
  } catch (error) {
    return { chain: "unreachable", error: errorMessage(error) };
  }
  if (!reference) return { chain: "unconfirmed" };
  if (!isTempoTransactionHash(reference)) return { chain: "unreported", reference };
  try {
    const closed = await mpp.getTempoSessionCloseAmounts?.({
      channelId,
      txHash: reference as `0x${string}`,
    });
    // A DVM that does not hold this channel answers `null`. There is no receipt
    // to read and no shortfall to allege, so it reads as the same silence a
    // synthetic reference does rather than as a chain that disagreed.
    if (!closed) return { chain: "unreported", reference };
    return {
      chain: "found",
      transaction: reference,
      refundedToPayer: closed.refundedToPayer.toString(),
      settledToPayee: closed.settledToPayee.toString(),
    };
  } catch (error) {
    return { chain: "unreachable", error: errorMessage(error) };
  }
}

function isTempoTransactionHash(reference: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(reference);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
