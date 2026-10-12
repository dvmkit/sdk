import { loggers } from "../../observability/loggers";
import { CreditLedgerError } from "./credit-ledger";

export type DrainRefundRail = "x402" | "tempo";

/**
 * A refund_floor drain_conflict identifies a short payout separately from duplicate payout.
 * Routes can use its class or structured detail to choose operator-repair instructions.
 */
export class DrainRefundFloorError extends CreditLedgerError {
  constructor(message: string) {
    super("drain_conflict", message, { drainConflict: "refund_floor" });
    this.name = "DrainRefundFloorError";
  }
}

/**
 * Compare a reported cooperative refund with the drain’s native debit. A short or malformed
 * amount refuses with refund_floor; an excess is recorded as caller surplus.
 *
 * An unreported amount instead warns and returns no evidence: absence is not proof of a
 * shortfall or of adequate payment. Keep that compatibility behavior distinct from the
 * measured floor.
 */
export function refundFloorEvidence(args: {
  rail: DrainRefundRail;
  /** What the settlement paid the payer, in the channel token's atomic units. */
  refundedNative: string | bigint | undefined;
  /** What the ledger is about to extinguish — the drain's rail-native debit. */
  debitedNative: number | null;
  creditId: string;
  drainId: string;
}): Record<string, string> {
  const { refundedNative } = args;
  if (refundedNative === undefined) {
    loggers[REFUND_FLOOR_DATASET[args.rail]].warn(`${args.rail}_refund_amount_unreported`, {
      "credit.id": args.creditId,
      "drain.id": args.drainId,
      "drain.native": args.debitedNative,
    });
    return {};
  }
  const refunded = parseAtomicAmount(refundedNative);
  if (
    refunded === undefined ||
    args.debitedNative === null ||
    refunded < BigInt(args.debitedNative)
  ) {
    throw new DrainRefundFloorError(refusalMessage({ ...args, refundedNative }));
  }
  return {
    settled_amount: refunded.toString(),
    surplus_native: (refunded - BigInt(args.debitedNative)).toString(),
  };
}

const REFUND_FLOOR_DATASET: Record<DrainRefundRail, "tempo" | "x402"> = {
  tempo: "tempo",
  x402: "x402",
};

function refusalMessage(args: {
  rail: DrainRefundRail;
  refundedNative: string | bigint;
  debitedNative: number | null;
}): string {
  const required = `for a drain requiring at least ${String(args.debitedNative)}`;
  return args.rail === "x402"
    ? `x402 refund settled ${String(args.refundedNative)} ${required}`
    : `Tempo close refunded ${String(args.refundedNative)} ${required}`;
}

function parseAtomicAmount(value: string | bigint): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  return /^\d+$/.test(value) ? BigInt(value) : undefined;
}
