import { createHash } from "node:crypto";

import { PaymentRequest } from "@cashu/cashu-ts";

import type { FxFetcher, FxRateSnapshot } from "../pricing/fx";

/**
 * The NUT-18 payment request a `payment_required` 402 carries in its `X-Cashu`
 * header (NUT-24). It names the lock the receive path already requires, so a
 * wallet that honours `nut10` produces proofs the DVM banks without a swap.
 * Never adds a `locktime` tag: with no refund key the DVM could name, a lock
 * that expires becomes spendable by anyone. No transport, so payment is in-band.
 */
export function cashuPaymentRequest(args: {
  requiredMsats: number;
  mints: string[];
  lockPubkey: string;
}): string {
  return new PaymentRequest(
    undefined,
    undefined,
    Math.ceil(args.requiredMsats / 1000),
    "sat",
    args.mints,
    undefined,
    false,
    { kind: "P2PK", data: args.lockPubkey, tags: [] }
  ).toEncodedCreqA();
}

/**
 * The request id a Cashu payment sent without `X-Cashu-Request-Id` is bound to.
 * It depends only on the set of proof secrets, so a retried token lands on the
 * same id (and recovers its job) while any other proof set gets another one.
 */
export function proofSetRequestId(secrets: readonly string[]): string {
  const canonical = JSON.stringify([...secrets].sort());
  return `${DERIVED_REQUEST_ID_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

/** The prefix of every derived request id; a caller may not send an id that carries it. */
export const DERIVED_REQUEST_ID_PREFIX = "nut24-";

/** An {@link FxFetcher} that also remembers the rates each snapshot replaced. */
export interface FxFetcherWithHistory extends FxFetcher {
  /**
   * The snapshot that `pricedAt` replaced, while the last price computed from
   * it is younger than the hold window; otherwise `undefined`. Timed from the
   * last price rather than from the refresh, so a DVM that sat idle through a
   * rate change does not honour an hours-old quote when it wakes. Keyed by the snapshot that
   * priced the request rather than by whatever is current now, so a refresh
   * landing between pricing and payment verification cannot move the hold.
   */
  previousFor(pricedAt: FxRateSnapshot): FxRateSnapshot | undefined;
}

/**
 * Wrap a fetcher so every price path sharing it records rate refreshes. A
 * snapshot replaces the current one only when its rates differ: fetchers may
 * hand back a fresh object for unchanged rates, and that must not push the
 * genuinely previous rates out of reach.
 */
export function withFxHistory(
  inner: FxFetcher,
  opts: { holdWindowMs?: number; now?: () => number } = {}
): FxFetcherWithHistory {
  const holdWindowMs = opts.holdWindowMs ?? FX_HOLD_WINDOW_MS;
  const now = opts.now ?? Date.now;
  // Oldest first. Four entries keep a request's hold unless three refreshes
  // land while it is being verified. `lastPricedAt` is the last time a fetch
  // returned these rates, which every quote and 402 does.
  const history: { snapshot: FxRateSnapshot; lastPricedAt: number }[] = [];
  return {
    async fetch(): Promise<FxRateSnapshot> {
      const snapshot = await inner.fetch();
      const latest = history.at(-1);
      if (latest && sameRates(latest.snapshot, snapshot)) {
        latest.lastPricedAt = now();
      } else {
        history.push({ snapshot, lastPricedAt: now() });
        if (history.length > 4) history.shift();
      }
      return snapshot;
    },
    supportedCurrencies: () => inner.supportedCurrencies(),
    ...(inner.lastKnown && { lastKnown: inner.lastKnown.bind(inner) }),
    previousFor(pricedAt) {
      for (let i = history.length - 1; i > 0; i--) {
        if (!sameRates(history[i]!.snapshot, pricedAt)) continue;
        const replaced = history[i - 1]!;
        return now() - replaced.lastPricedAt <= holdWindowMs ? replaced.snapshot : undefined;
      }
      return undefined;
    },
  };
}

function sameRates(a: FxRateSnapshot, b: FxRateSnapshot): boolean {
  const keys = new Set([...Object.keys(a.rates), ...Object.keys(b.rates)]);
  for (const key of keys) {
    if (a.rates[key as keyof typeof a.rates] !== b.rates[key as keyof typeof b.rates]) return false;
  }
  return true;
}

/**
 * How long after they last priced a request the replaced rates still price an
 * honest payment. A NUT-24 wallet reads the 402, selects or swaps proofs at its mint
 * and resends: seconds normally, a minute or two over a slow mint. Ten minutes
 * covers that round trip with room for a wallet that asks its user to confirm,
 * while keeping a stale quote from being redeemable for the life of the next one.
 */
const FX_HOLD_WINDOW_MS = 10 * 60_000;
