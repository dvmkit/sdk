/**
 * Smart denomination distribution for agent-wallet mint requests.
 *
 * Cashu mints sign whatever blinded-message amounts the client supplies, so
 * we control the proof denomination spread at mint time via cashu-ts's
 * `OutputType.denominations` field. Picking a long tail of small
 * denominations up front means later spends rarely have to swap proofs for
 * change — every swap on Coinos burns one input fee per consumed proof
 * (`input_fee_ppk: 100`), so a wallet that mints all-power-of-2 pays that
 * fee once on every awkwardly-sized payment.
 *
 * Strategy: a fixed long tail of 1/2/4-sat coins (≈5/10/20 % of the
 * principal), then bit-decompose the remainder into the largest power-of-2
 * denominations the keyset supports. The caller passes a `maxDenomination`
 * cap (the largest power-of-2 the loaded mint's active keyset signs) so
 * we never request a denomination the mint can't issue — Coinos tops out at
 * `2^15`, so a 500_000-sat fund decomposes into multiples of `2^15` plus the
 * sub-`2^15` bits.
 */

const TINY_AMOUNT_THRESHOLD_SATS = 8;

export interface SmartDenominationOptions {
  /**
   * Largest power-of-2 denomination the mint's active keyset can sign. When
   * the bit-decomposition would emit a coin above the cap, we replace it with
   * multiples of `maxDenomination` so the final list is always representable.
   * Pass `undefined` to skip the cap — useful for tests against a synthetic
   * mint, but every real-mint code path should provide it.
   */
  maxDenomination?: number;
  /**
   * When `true` (default), prepend a long tail of 1/2/4-sat coins before the
   * greedy power-of-2 remainder. Useful for `reserve.ts` proofs that are
   * shipped directly to the DVM — the tail lets the reserve cover odd-cent
   * prices without a swap.
   *
   * Set to `false` for `fund.ts` and `recovery.ts`: those proofs go through
   * the per-call swap path (largest-first selection), so the tail
   * sits unused at the bottom of the sort and only inflates `wallet.proofs[]`.
   */
  includeTinyTail?: boolean;
}

/**
 * Return a list of power-of-2 denominations summing exactly to `amountSats`.
 * The first portion of the result is a long tail of 1/2/4-sat coins so the
 * wallet can make awkward-sized spends without a swap-for-change. The
 * remainder is the standard greedy power-of-2 split. For trivial amounts
 * (< 8 sats) the long tail is dropped — there is no `4`-sat coin to dish
 * out, so we fall back to a pure greedy split. When `opts.maxDenomination`
 * is set, no emitted coin exceeds that cap.
 */
export function computeSmartDenominations(
  amountSats: number,
  opts: SmartDenominationOptions = {}
): number[] {
  if (!Number.isFinite(amountSats) || amountSats <= 0) return [];

  const cap = normalizeCap(opts.maxDenomination);
  const withTail = opts.includeTinyTail !== false;

  if (!withTail || amountSats < TINY_AMOUNT_THRESHOLD_SATS) {
    return greedyPowerOfTwo(Math.floor(amountSats), cap);
  }

  const total = Math.floor(amountSats);
  const small1 = Math.floor(total * 0.05);
  const small2 = Math.floor((total * 0.1) / 2) * 2;
  const small4 = Math.floor((total * 0.2) / 4) * 4;
  const remainder = total - small1 - small2 - small4;

  const out: number[] = [];
  for (let i = 0; i < small1; i++) out.push(1);
  for (let i = 0; i < small2 / 2; i++) out.push(2);
  for (let i = 0; i < small4 / 4; i++) out.push(4);
  out.push(...greedyPowerOfTwo(remainder, cap));
  return out;
}

function greedyPowerOfTwo(n: number, cap: number | undefined): number[] {
  const out: number[] = [];
  let r = n;

  // Strip whole multiples of the cap first so we never emit > cap below.
  if (cap !== undefined && r >= cap) {
    const capCount = Math.floor(r / cap);
    for (let i = 0; i < capCount; i++) out.push(cap);
    r -= capCount * cap;
  }

  let bit = 1;
  while (r > 0) {
    if (r & 1) out.push(bit);
    r = Math.floor(r / 2);
    bit *= 2;
  }
  return out;
}

function normalizeCap(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  // Force the cap onto a power-of-2 boundary so the bit decomposition stays
  // valid. Round down so we never exceed what the mint advertised.
  const floored = Math.floor(raw);
  let pow = 1;
  while (pow * 2 <= floored) pow *= 2;
  return pow;
}
