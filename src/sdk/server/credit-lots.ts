/**
 * Cashu and Lightning credits owe unused sats back at each deposit's funding
 * rate. Keep the sats/micro basis per funding lot: a pooled ratio loses the
 * basis of top-ups made at different rates. Settled draws and reclaims share
 * these lots so their total equals the sats funded.
 */

import type { FundingMethod } from "../types";

/**
 * The rails whose credits carry a Bitcoin deposit this ledger owes back in
 * kind — Cashu and Lightning funding, both of which leave sats in the
 * provider's own custody.
 *
 * Declared as its own list rather than derived by subtracting the stablecoin
 * rails: a channel-backed credit is in-kind *structurally* (the escrow retains
 * the unused value), so it needs no lots at all, and a rail added to
 * {@link FundingMethod} must be a decision here rather than a default.
 */
export const NON_CHANNEL_BITCOIN_RAILS = [
  "cashu",
  "lightning",
] as const satisfies readonly FundingMethod[];

export type NonChannelBitcoinRail = (typeof NON_CHANNEL_BITCOIN_RAILS)[number];

export function isNonChannelBitcoinRail(
  rail: string | null | undefined
): rail is NonChannelBitcoinRail {
  return (
    typeof rail === "string" && (NON_CHANNEL_BITCOIN_RAILS as readonly string[]).includes(rail)
  );
}

/**
 * One funding event's deposit: the sats that arrived and the credit micro they
 * bought, with however much of that micro is still unspent.
 *
 * `remainingMicro` is depleted FIFO by settled draws and by reclaims, so the
 * sum of a credit's lots tracks `credits.balance_micro` exactly — with one
 * deliberate exception: an expiry release zeroes the balance and
 * leaves the lots standing, because a revival restores that balance and its
 * in-kind basis has to still be there. A released credit is excluded from the
 * sweep floor by `BITCOIN_CREDIT_PREDICATE`'s own `balance_micro > 0`, so the
 * over-coverage is never counted as sats the builder owes back.
 */
export interface FundingLot {
  lotId: string;
  creditId: string;
  rail: NonChannelBitcoinRail;
  /** Sats this funding delivered. `0` on a credit funded before a rail basis was recorded. */
  satsFunded: number;
  /** Credit micro this funding bought — the lot's denominator, never depleted. */
  creditedMicro: number;
  remainingMicro: number;
  /** Rail settlement reference, provenance only. */
  fundingRef: string | null;
  createdAt: number;
}

export interface LotDebit {
  lotId: string;
  micro: number;
  /** Decrease in this lot's floored sats obligation after taking the micro debit. */
  sats: number;
}

export interface LotDepletion {
  debits: LotDebit[];
  satsOwed: number;
  /** Micro the lots could not cover. Non-zero means the credit's lots are short. */
  uncoveredMicro: number;
  /** Of the micro taken, how much came out of a lot carrying a real sats basis. */
  backedMicro: number;
}

/**
 * Deplete lots in FIFO order, supplied by fifoOrder. Price each debit as
 * lotSats(before) - lotSats(after), not the independently floored slice: small
 * draws then telescope to the full deposit instead of losing up to one sat
 * per draw. Fractional remaining sats stay with the provider.
 */
export function depleteLots(lots: FundingLot[], amountMicro: number): LotDepletion {
  const debits: LotDebit[] = [];
  let left = Math.max(0, amountMicro);
  let satsOwed = 0;
  let backedMicro = 0;
  for (const lot of lots) {
    if (left <= 0) break;
    const available = Math.max(0, lot.remainingMicro);
    if (available === 0) continue;
    const micro = Math.min(available, left);
    const sats = lotSats(lot, available) - lotSats(lot, available - micro);
    debits.push({ lotId: lot.lotId, micro, sats });
    satsOwed += sats;
    if (lot.satsFunded > 0) backedMicro += micro;
    left -= micro;
  }
  return { debits, satsOwed, uncoveredMicro: left, backedMicro };
}

/**
 * What a settling draw's fiat debit was worth in kind, in millisatoshis
 * `null` where the lots cannot price it.
 *
 * This is the single sats authority for a non-channel Bitcoin credit. The
 * settle already depletes the lots the draw consumed, so the figure costs no
 * extra read: it is `depletion.satsOwed` in the ledger's own msat unit, and
 * stamping it on `credit_draws.draw_msats` is what makes
 * `Σ settled draw sats + reclaim sats == Σ sats funded` close per credit.
 *
 * `null` follows {@link isInKindDepletion} exactly, so a settle and a reclaim
 * fall back together: lots short of the balance, or covering lots with no sats
 * basis, keep the pooled pro-rata figure rather than blending a lot rate with
 * a blended one. Mixed coverage counts as unpriceable for the same reason it
 * does on the reclaim.
 */
export function inKindDrawMsats(depletion: LotDepletion, amountMicro: number): number | null {
  return isInKindDepletion(depletion, amountMicro) ? depletion.satsOwed * 1000 : null;
}

/**
 * What these lots owe in kind if every remaining micro were reclaimed now —
 * the deposit-liability figure, and the floor the hub must never be swept
 * below.
 */
export function lotOwedSats(lots: FundingLot[]): number {
  return lots.reduce((sum, lot) => sum + lotSats(lot, lot.remainingMicro), 0);
}

/**
 * Refund delivery uses a fixed eight-sat reserve so owed_sats cannot shrink
 * after it is promised. Extra delivery cost is absorbed by the provider;
 * unused reserve stays with the provider, like fractional-sat dust.
 */
export const DRAIN_DELIVERY_RESERVE_SATS = 8;

/**
 * The figure a reclaim publishes: its in-kind gross less
 * {@link DRAIN_DELIVERY_RESERVE_SATS}, floored at zero.
 *
 * Zero is a refusal rather than a payout — a balance worth no more than what
 * it costs to send is `drain_below_dust`, since parking a zero-value token
 * would hold the servicer's queue open forever.
 */
export function netOwedSats(grossSats: number): number {
  return Math.max(0, grossSats - DRAIN_DELIVERY_RESERVE_SATS);
}

/**
 * The order lots deplete in: oldest first, `lotId` breaking a tie.
 *
 * A tiebreak is not decoration — lot ids are surrogates rather than a
 * per-credit sequence (`fund` takes no credit lock, so two concurrent
 * fundings cannot cooperate on a counter), and two fundings can land on the
 * same millisecond. Without it the FIFO order is whatever the planner
 * returned, and a reclaim's figure would depend on it.
 */
export function fifoOrder(left: FundingLot, right: FundingLot): number {
  return left.createdAt - right.createdAt || left.lotId.localeCompare(right.lotId);
}

/**
 * Missing lot coverage or a zero legacy sats basis requires pooled pricing.
 * Mixed backed/unbacked lots also fall back: combining lot and live rates
 * would claim a value neither basis supports.
 */
export function isInKindDepletion(depletion: LotDepletion, amountMicro: number): boolean {
  return depletion.uncoveredMicro === 0 && depletion.backedMicro === amountMicro && amountMicro > 0;
}

function lotSats(lot: FundingLot, micro: number): number {
  if (lot.satsFunded <= 0 || lot.creditedMicro <= 0 || micro <= 0) return 0;
  const taken = Math.min(micro, lot.creditedMicro);
  return Math.floor((lot.satsFunded * taken) / lot.creditedMicro);
}
