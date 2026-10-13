import { getWallet } from "./wallet";

/**
 * NUT-02 `final_expiry` (unix seconds) for a specific keyset at a mint, or
 * `undefined` if the mint doesn't advertise one or the keyset is unknown.
 *
 * Used by the accumulator reaper: once `now > final_expiry`, the
 * mint has likely garbage-collected its spent-set, so accumulator rows
 * keyed by `(dvm_id, proof_secret_hash)` lose their enforcement meaning
 * and can be dropped.
 *
 * Network failures return `undefined` — the reaper treats unknown expiries
 * as "keep the row." A transient mint outage shouldn't drop rows.
 */
export async function getKeysetFinalExpiry(
  mintUrl: string,
  keysetId: string
): Promise<number | undefined> {
  try {
    const wallet = await getWallet(mintUrl);
    return wallet.keyChain.getKeyset(keysetId).expiry;
  } catch {
    return undefined;
  }
}
