import type { RailAsset } from "../payment-rails/asset";
import { x402NetworkByCaip2 } from "./networks";
import { X402_DEFAULT_NETWORK } from "./spec";

/** The USDC the x402 rail reads on one configured network. */
export interface X402Asset extends RailAsset {
  /** Human network name for copy ("Base"); the CAIP-2 id when we can't name it. */
  networkLabel: string;
  /**
   * Ticker of the dollar most often confused for this one on this network, or
   * null where there isn't a well-known one. Named so the copy can warn a
   * caller off it — never probed, which would recreate the multi-asset
   * failure class this rail exists to avoid.
   */
  confusable: string | null;
}

/** Returns null for unsupported networks so read-only naming can omit the asset. */
export function resolveX402Asset(network: string = X402_DEFAULT_NETWORK): X402Asset | null {
  const spec = x402NetworkByCaip2(network);
  if (!spec) return null;
  return {
    address: spec.usdc,
    symbol: "USDC",
    // "native" is the load-bearing word: every contract in the table is
    // Circle's own USDC, and the dollars that read as zero here are the
    // bridged ones.
    label: "native USDC",
    unit: "USDC",
    networkLabel: spec.label,
    confusable: spec.confusable,
  };
}
