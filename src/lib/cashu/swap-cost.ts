/** Selection needs a reserve before swapping. prepareSwapToSend has side effects
 * (blinded outputs and counter reservations), so price it through cashu-ts fee
 * primitives shared by caller and builder proof selection. */

import { Amount, splitAmount, type Wallet } from "@cashu/cashu-ts";

/**
 * Sats a `wallet.ops.send(amountSats, …).includeFees(true)` swap consumes on
 * top of `amountSats`, given the input proofs it would spend.
 *
 * Selection is done when `sum(inputs) >= amountSats + reserve(inputs)`.
 */
export type SwapSendReserve = (inputs: ProofRef[]) => number;

export interface ProofRef {
  id: string;
}

/**
 * Build the reserve function for one loaded mint and one send amount
 *
 * `cashu-ts@4`'s `Wallet.prepareSwapToSend` requires
 * `sum(inputs) >= amountSats + receiverFee + swapFee(inputs)`:
 *
 * - **`swapFee(inputs)`** — the mint's own NUT-02 per-input fee for this
 * swap, `getFeesForProofs`. Per proof, so a wallet holding proofs from
 * more than one keyset at the same mint is priced correctly.
 * - **`receiverFee`** — what `includeFees(true)` adds, and the term the old
 * model missed entirely. It means "the sender covers the fee the receiver
 * will pay to redeem these proofs": cashu-ts appends extra output
 * denominations so the DVM banks the full price. It depends only on
 * `amountSats` and the keyset, so it is computed once here.
 *
 * The `receiverFee` loop mirrors `Wallet.configureOutputs` exactly, including
 * its fixpoint: the fee-covering outputs are themselves proofs the receiver
 * must later spend, so adding them can push the receiver's own input count
 * over the next ppk boundary and cost another sat.
 *
 * Throws when the mint won't name a usable keyset — `getKeyset()` is the same
 * call, and the same failure, the caller already treats as `keys_unavailable`
 * and when that keyset's denominations make the fixpoint diverge (see the
 * bound below), which the caller treats the same way.
 */
export function swapSendReserve(cashuWallet: Wallet, amountSats: number): SwapSendReserve {
  const keyset = cashuWallet.getKeyset();
  const feeForCount = (n: number): number =>
    Amount.from(cashuWallet.getFeesForKeyset(n, keyset.id)).toNumber();

  const sendOutputs = splitAmount(Amount.from(amountSats), keyset.keys).length;
  let receiverFee = feeForCount(sendOutputs);
  // cashu-ts's loop is unbounded and converges because each pass buys a whole
  // sat of fee while the output count that sat has to cover grows only
  // logarithmically. A keyset can break that — one whose largest denomination
  // forces the fee to split into as many outputs as it has sats, at a ppk
  // where each output costs a sat, diverges — so stop at the fee a 64-output
  // split would cost. That is above the fixpoint for any keyset whose
  // denominations reach a uint64 amount in 64 outputs, i.e. every real one,
  // so this never truncates a reachable fixpoint the way a shorter bound
  // would; past it the keyset is one we cannot price, which the caller turns
  // into `keys_unavailable` and fails over on — never into an under-sized
  // swap.
  const maxReceiverFee = feeForCount(sendOutputs + 64);
  for (;;) {
    const feeOutputs = splitAmount(Amount.from(receiverFee), keyset.keys).length;
    if (feeForCount(sendOutputs + feeOutputs) <= receiverFee) break;
    receiverFee += 1;
    if (receiverFee > maxReceiverFee) {
      throw new Error(
        `Keyset ${keyset.id} splits its own fee outputs faster than the fee covers them; a ${amountSats}-sat send cannot be priced at this mint.`
      );
    }
  }

  return (inputs) => receiverFee + swapFeeForProofs(cashuWallet, inputs);
}

/**
 * The mint's per-input swap fee for exactly these proofs, in sats
 * (`ceil(Σ input_fee_ppk / 1000)`).
 *
 * Falls back to pricing the inputs at the wallet's bound keyset when a proof
 * carries a keyset the loaded `KeyChain` doesn't know — `getFeesForProofs`
 * throws there. That spend is doomed either way (cashu-ts's own swap reads the
 * same `KeyChain`), but this runs inside proof selection under the wallet
 * lock: throwing here would escape `prepareAgentSpend` as an unhandled error,
 * where falling back lets the swap fail on its own terms as a `swap_rejected`
 * attempt that fails over to the next mint.
 */
export function swapFeeForProofs(cashuWallet: Wallet, inputs: ProofRef[]): number {
  try {
    return Amount.from(cashuWallet.getFeesForProofs(inputs)).toNumber();
  } catch {
    return Amount.from(
      cashuWallet.getFeesForKeyset(inputs.length, cashuWallet.getKeyset().id)
    ).toNumber();
  }
}
