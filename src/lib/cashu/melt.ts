import { Amount, type MeltQuoteBolt11Response, type Proof } from "@cashu/cashu-ts";

import { DvmError } from "../errors";
import { getWallet } from "./wallet";

/**
 * Mint-issued melt quote, with the bolt11 amount + fee_reserve broken out as
 * sats integers for the caller. NUT-05 requires `inputs >= amount +
 * fee_reserve`; callers that build the bolt11 themselves (agent wallet
 * accumulator) need `feeReserveSats` to size the invoice accordingly.
 */
export interface MeltQuoteInfo {
  /** Bolt11 amount as decoded by the mint (sats). */
  amountSats: number;
  /** Mint-reserved fee buffer (sats). */
  feeReserveSats: number;
  /** Underlying mint quote. Pass to the mint's `meltProofsBolt11` call. */
  rawQuote: MeltQuoteBolt11Response;
}

/**
 * Look up the current state of a previously-issued melt quote at the mint
 * (NUT-05 melt-quote-state lookup). Used by agent-wallet stuck-recovery on
 * scheduler boot to decide whether a `melt_status = 'melting'` row was paid
 * before the crash (`PAID`), never paid (`UNPAID`), or is still in flight
 * (`PENDING`).
 */
export async function checkMeltQuoteState(
  mintUrl: string,
  quoteId: string
): Promise<MeltQuoteBolt11Response> {
  const wallet = await getWallet(mintUrl);
  return wallet.checkMeltQuoteBolt11(quoteId).catch((err: unknown) => {
    throw new DvmError(
      "cashu_melt_quote_state_failed",
      `Failed to check melt quote ${quoteId} at ${mintUrl}: ${err instanceof Error ? err.message : String(err)}`,
      "The mint may be down."
    );
  });
}

/**
 * Compute the per-input swap fee the mint will charge to melt the given
 * proofs. NUT-12 mints advertise `input_fee_ppk` per keyset; cashu-ts's
 * `getFeesForProofs` sums this across all proofs. The mint requires
 * `inputs >= amount + fee_reserve + input_fees`, but the input fee is NOT
 * surfaced in `MeltQuoteBolt11Response` — callers must compute it
 * separately or the melt rejects with "not enough inputs provided".
 */
export async function getInputFeesForProofs(
  mintUrl: string,
  proofs: Pick<Proof, "id">[]
): Promise<number> {
  const wallet = await getWallet(mintUrl);
  return Amount.from(wallet.getFeesForProofs(proofs)).toNumber();
}

/**
 * Fetch a melt quote for the given bolt11 invoice. The mint returns the
 * `amount` + `fee_reserve` it expects to be backed by inputs; callers can use
 * `feeReserveSats` to decide whether the available inputs cover the melt or
 * if a smaller invoice needs to be requested.
 */
export async function fetchMeltQuote(mintUrl: string, bolt11: string): Promise<MeltQuoteInfo> {
  const wallet = await getWallet(mintUrl);
  const quote = await wallet.createMeltQuoteBolt11(bolt11).catch((err: unknown) => {
    throw new DvmError(
      "cashu_melt_quote_failed",
      `Failed to create melt quote at ${mintUrl}: ${err instanceof Error ? err.message : String(err)}`,
      "The mint may be down or the invoice is invalid."
    );
  });
  return {
    amountSats: Amount.from(quote.amount).toNumber(),
    feeReserveSats: Amount.from(quote.fee_reserve).toNumber(),
    rawQuote: quote,
  };
}
