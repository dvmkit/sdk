/** What a signed x402 batch payload authorizes, and what it reserves. */

import { decodePaymentSignatureHeader } from "@x402/core/http";

import { type PendingX402Funding, x402PendingRetired } from "./channel-store";

/** What a signed batch payload authorizes, independent of what it was for. */
export interface X402VoucherFacts {
  /** Cumulative cap the voucher signature commits the payer to. */
  maxClaimableMicro: string;
  /** ERC-3009 value, on a deposit payload only. */
  depositMicro?: string;
  /** Unix seconds past which a deposit authorization is dead, deposits only. */
  authorizationValidBefore?: string;
}

/** The authorized figures carried by a deposit or voucher-only payload. */
export function x402VoucherFactsFromPayload(raw: unknown): X402VoucherFacts | undefined {
  const payload = raw as {
    type?: string;
    voucher?: { maxClaimableAmount?: string };
    deposit?: {
      amount?: string;
      authorization?: { erc3009Authorization?: { validBefore?: string } };
    };
  };
  const maxClaimableMicro = payload.voucher?.maxClaimableAmount;
  if (maxClaimableMicro === undefined) return undefined;
  if (payload.type !== "deposit") return { maxClaimableMicro };
  const validBefore = payload.deposit?.authorization?.erc3009Authorization?.validBefore;
  return {
    maxClaimableMicro,
    ...(payload.deposit?.amount !== undefined ? { depositMicro: payload.deposit.amount } : {}),
    ...(validBefore !== undefined ? { authorizationValidBefore: validBefore } : {}),
  };
}

/**
 * The cumulative cap a channel's journalled vouchers still commit the payer to,
 * floored at what the chain has already claimed.
 *
 * A **max**, never a sum: `claim()` takes a cumulative cap against the channel,
 * so two outstanding vouchers do not add up — the larger one subsumes the
 * smaller. Summing would both over-reserve and never auto-retire; as a max, a
 * voucher stops reserving anything on its own as soon as a later cap or the
 * chain's own `totalClaimed` overtakes it, with no timer and no manual step.
 */
export function x402ChannelReservation(
  journalled: PendingX402Funding[],
  totalClaimed: bigint
): bigint {
  return journalled.reduce(
    (held, entry) => (x402VoucherCap(entry) > held ? x402VoucherCap(entry) : held),
    totalClaimed
  );
}

/**
 * The journalled entry to name when telling a caller how to release a
 * reservation, and whether retrying it is still on the table. Callers hold a
 * non-empty journal — with no entries there is no reservation to release.
 *
 * Shared so the refusal and the partial-drain success copy always point at the
 * same funding: a caller who is told "retry credit-1" on one run and handed a
 * different id on the next has no way to tell which one is actually holding
 * their money. A retriable entry wins because completing the funding is the
 * cheap release; the refused ones only clear through `--force`.
 */
export function x402ReservationRelease(journalled: PendingX402Funding[]): {
  entry: PendingX402Funding;
  retriable: boolean;
} {
  const retriable = journalled.filter((entry) => !x402PendingRetired(entry));
  return retriable.length > 0
    ? { entry: retriable[0], retriable: true }
    : { entry: journalled[0], retriable: false };
}

/**
 * What one journalled voucher could still be claimed for. An entry whose figure
 * can't be read fails closed at the whole channel balance rather than zero: an
 * unreadable authorization is the one case where guessing low writes an exit
 * against money someone else may take.
 */
function x402VoucherCap(pending: PendingX402Funding): bigint {
  const recorded =
    pending.maxClaimableMicro ?? x402VoucherFacts(pending.paymentHeader)?.maxClaimableMicro;
  if (recorded === undefined) return X402_MAX_UINT128;
  try {
    return BigInt(recorded);
  } catch {
    return X402_MAX_UINT128;
  }
}

/**
 * Read what a journalled header authorizes, for entries written before the
 * figures were recorded alongside them. Returns `undefined` on anything it
 * cannot read; every caller treats that as "assume the worst", never as zero.
 */
function x402VoucherFacts(paymentHeader: string): X402VoucherFacts | undefined {
  try {
    return x402VoucherFactsFromPayload(decodePaymentSignatureHeader(paymentHeader).payload);
  } catch {
    return undefined;
  }
}

/** The channel-balance type's ceiling, used as the fail-closed reservation. */
const X402_MAX_UINT128 = (1n << 128n) - 1n;
