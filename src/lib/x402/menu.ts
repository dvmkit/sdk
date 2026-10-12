/**
 * Caller-side reading of the credit menu's x402 flavour sub-block.
 *
 * Kept in its own module — and deliberately free of viem / `@x402` imports — so
 * the pure `credit-policy.ts` planner can ask the same question the funding
 * loop asks without pulling the signing stack in behind it.
 */

import type { CreditMenu } from "../transport/types";
import { X402_BATCH_SETTLEMENT_SCHEME, X402_EXACT_SCHEME } from "./spec";

import type { X402CreditFlavour } from "../credit-funding-contracts";
export type { X402CreditFlavour } from "../credit-funding-contracts";

/**
 * The same two flavours in the server's words.
 *
 * `/v1/credit` binds a credit to the instrument that funded it and names that
 * binding as `credit_instrument` on a refusal, so the caller's local pin is
 * kept in this vocabulary rather than the scheme's: healing a stale pin from a
 * refusal is then an assignment, with no table to keep in step.
 */
export type X402CreditInstrument = "x402_exact" | "x402_channel";

/**
 * True when a menu offers an x402 top-up this caller could actually build —
 * either flavour, on the wallet's own chain.
 *
 * `funding: ["x402"]` alone is not evidence, because it says nothing about the
 * chain: an entry on a network this wallet isn't pinned to is not fundable, and
 * both `selectBatchRequirement` and the exact selector match on **scheme and
 * network**. Reading the scheme list turns a chain mismatch — or a DVM whose
 * menu names no x402 scheme at all — into "not this rail" before any money or
 * round trip is spent, so the loop falls through to the next eligible one.
 *
 * `network` is optional because not every reader knows the wallet's chain — the
 * planner's gate can stay scheme-level, the funding loop's is network-exact.
 */
export function offersX402CreditFunding(menu: CreditMenu | undefined, network?: string): boolean {
  return matchesNetwork(x402CreditFundingNetworks(menu), network);
}

/**
 * True when a menu offers a reusable x402 channel this caller could actually
 * open — the x402 twin of `offersTempoCreditSession`.
 *
 * Narrower than {@link offersX402CreditFunding} on purpose: an exact-only DVM
 * is fundable but opens nothing to amortize across top-ups, and only the
 * channel question can distinguish "reconnect on their chain" from "this DVM
 * opens no channel at all" in the forced-rail hint.
 */
export function offersX402CreditChannel(menu: CreditMenu | undefined, network?: string): boolean {
  return matchesNetwork(x402CreditChannelNetworks(menu), network);
}

/**
 * Which flavour to attempt on this wallet's chain, or `undefined` when neither
 * is offered there. The channel wins wherever both are advertised: a deposit
 * amortizes across every later top-up, where an exact authorization costs a
 * round trip and a signature each time.
 */
export function x402CreditFlavour(
  menu: CreditMenu | undefined,
  network: string
): X402CreditFlavour | undefined {
  if (offersX402CreditChannel(menu, network)) return X402_BATCH_SETTLEMENT_SCHEME;
  if (matchesNetwork(x402CreditExactNetworks(menu), network)) return X402_EXACT_SCHEME;
  return undefined;
}

/**
 * True when a menu offers one *named* flavour on this wallet's chain — the
 * question a credit already bound to that flavour has to ask, where
 * {@link x402CreditFlavour}'s preference is beside the point.
 */
export function offersX402CreditFlavour(
  menu: CreditMenu | undefined,
  network: string,
  flavour: X402CreditFlavour
): boolean {
  return matchesNetwork(
    flavour === X402_BATCH_SETTLEMENT_SCHEME
      ? x402CreditChannelNetworks(menu)
      : x402CreditExactNetworks(menu),
    network
  );
}

/** The binding a funding over this flavour leaves on the credit. */
export function x402InstrumentForFlavour(flavour: X402CreditFlavour): X402CreditInstrument {
  return flavour === X402_BATCH_SETTLEMENT_SCHEME ? "x402_channel" : "x402_exact";
}

/**
 * The flavour a recorded binding pins, or `undefined` for anything that isn't
 * one of x402's two. A cross-rail refusal names its own instrument
 * (`tempo_session`, `tempo_charge`), so this is what keeps one from seeding an
 * x402 pin.
 */
export function x402FlavourForInstrument(
  instrument: string | undefined
): X402CreditFlavour | undefined {
  if (instrument === "x402_channel") return X402_BATCH_SETTLEMENT_SCHEME;
  if (instrument === "x402_exact") return X402_EXACT_SCHEME;
  return undefined;
}

/**
 * Chains this menu will open an x402 channel on. Empty for an exact-only DVM,
 * which is what separates "reconnect your wallet on their chain" from "this DVM
 * opens no channel at all" in the forced-rail hint.
 */
export function x402CreditChannelNetworks(menu: CreditMenu | undefined): string[] {
  return schemeNetworks(menu, X402_BATCH_SETTLEMENT_SCHEME);
}

/** Chains this menu takes a per-call `exact` credit top-up on. */
export function x402CreditExactNetworks(menu: CreditMenu | undefined): string[] {
  return schemeNetworks(menu, X402_EXACT_SCHEME);
}

/**
 * Every chain this menu takes an x402 top-up on, either flavour, deduplicated.
 * The set a "your wallet is on the wrong chain" hint has to name — pinning to
 * the channel networks alone would tell an exact-only DVM's caller to reconnect
 * to nowhere.
 */
export function x402CreditFundingNetworks(menu: CreditMenu | undefined): string[] {
  return [...new Set([...x402CreditChannelNetworks(menu), ...x402CreditExactNetworks(menu)])];
}

function schemeNetworks(menu: CreditMenu | undefined, scheme: string): string[] {
  return (menu?.x402?.schemes ?? [])
    .filter((entry) => entry.scheme === scheme)
    .map((entry) => entry.network);
}

function matchesNetwork(networks: readonly string[], network: string | undefined): boolean {
  return networks.some((candidate) => network === undefined || candidate === network);
}
