/**
 * NUT-20 quotes bind issuance to the wallet key. Persist the quote before
 * payment and its blinded outputs before issuance so a crash can resume or
 * restore the mint without losing funds.
 */

import type { MintPreview, MintQuoteBolt11Response, Wallet } from "@cashu/cashu-ts";

export interface PrepareP2PKMintExtras {
  /**
   * NUT-11 `locktime` tag value — an **absolute** unix-seconds timestamp
   * (not a duration). The mint compares its current time to this value to
   * decide whether the main-path or the refund-path witness is required.
   */
  locktimeUnixSec?: number;
  /** NUT-11 refund pubkeys (compressed secp256k1 hex). Usually a single entry. */
  refundKeys?: string[];
}

/**
 * Two-step P2PK mint preparation against a paid quote. The
 * returned {@link MintPreview} carries the blinded outputs that must be
 * persisted to disk before {@link Wallet.completeMint} is called, so a crash
 * between the two steps is recoverable via NUT-09 restore.
 *
 * Passing `extras.locktimeUnixSec` + `extras.refundKeys` attaches
 * NUT-11 locktime + refund tags to every output — the pre-fund-per-builder
 * shape used by `dvm wallet reserve`. Without them the outputs lock to
 * `lockPubkey` permanently (default fund flow).
 */
export async function prepareP2PKMint(
  cashuWallet: Wallet,
  sats: number,
  quote: MintQuoteBolt11Response,
  lockPrivkey: string,
  lockPubkey: string,
  denominations: number[],
  extras: PrepareP2PKMintExtras = {}
): Promise<MintPreview<MintQuoteBolt11Response>> {
  const options: { pubkey: string; locktime?: number; refundKeys?: string[] } = {
    pubkey: lockPubkey,
  };
  if (extras.locktimeUnixSec !== undefined) options.locktime = extras.locktimeUnixSec;
  if (extras.refundKeys && extras.refundKeys.length > 0) options.refundKeys = extras.refundKeys;
  return cashuWallet.prepareMint(
    "bolt11",
    sats,
    quote,
    { privkey: lockPrivkey },
    { type: "p2pk", options, denominations }
  );
}

/**
 * Read the largest power-of-2 denomination the wallet's active keyset signs.
 * Returns `undefined` when the wallet hasn't loaded any keysets — in that
 * case the caller falls back to an uncapped split, which matches legacy
 * behaviour for tests against synthetic mints.
 */
export function maxKeysetDenomination(cashuWallet: Wallet): number | undefined {
  const keysets = cashuWallet.keyChain.getKeysets();
  if (keysets.length === 0) return undefined;
  const active = keysets.find((k) => k.isActive) ?? keysets[0];
  if (!active.hasKeys) return undefined;
  const amounts = Object.keys(active.keys)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (amounts.length === 0) return undefined;
  return Math.max(...amounts);
}
