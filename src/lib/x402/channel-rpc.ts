/**
 * Which endpoint one x402 channel is read and written through.
 *
 * Its own module rather than a helper inside either caller, because the two
 * surfaces that span chains — the key-rotation preflight in `lifecycle.ts` and
 * the timed exit in `wallet-x402.ts` — have to make the same call, and the one
 * that didn't reported a funded channel as claimed.
 */

import { resolveRpcOverride, type RpcSource } from "../payment-rails/rpc";

/** The endpoint one channel is reached at, and why it is that one. */
export interface X402ChannelRpc {
  /** Resolved endpoint; undefined when viem bundles none for this chain. */
  url: string | undefined;
  /** Whose endpoint this is — the caller's override, or viem's bundled one. */
  source: RpcSource;
  /** An override is set, but this channel is on another chain, so it did not apply. */
  overrideOutOfScope: boolean;
}

/**
 * Pick the endpoint one channel is reached at.
 *
 * `DVM_X402_RPC_URL` is a single global URL and every single-chain reader
 * applies it to the one chain the wallet is pinned to. The readers that span
 * chains — a caller can hold channels on several — meet the fact that the batch
 * settlement contract lives at the *same* address on all of them, so pointing a
 * Base channel's read at a Sepolia endpoint doesn't error: it finds the real
 * contract, misses the channel id, and answers `(0, 0)`. In the preflight that
 * would have silently cleared a funded channel and rotated away the only key
 * that could withdraw it; in the timed exit it refuses the emergency exit with
 * "the DVM has already claimed the channel balance" over money that is still
 * there.
 *
 * So the override keeps exactly its pre-existing scope — the configured chain —
 * and every other chain is reached through its bundled endpoint. An override the
 * caller set because the bundled endpoint is unusable therefore surfaces as an
 * `x402_rpc_error` on those channels, which is the safe direction to be wrong.
 */
export function resolveX402ChannelRpc(
  channelNetwork: string,
  configuredNetwork: string,
  bundled: string | undefined
): X402ChannelRpc {
  const override = resolveRpcOverride(process.env.DVM_X402_RPC_URL);
  if (override.source === "override" && channelNetwork === configuredNetwork) {
    return { url: override.url, source: "override", overrideOutOfScope: false };
  }
  return {
    url: bundled,
    source: "bundled",
    overrideOutOfScope: override.source === "override",
  };
}
