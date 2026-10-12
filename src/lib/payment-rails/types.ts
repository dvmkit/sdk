/**
 * Multi-rail abstraction for the agent wallet. Each `Rail` is a
 * concrete payment path the CLI knows how to execute end-to-end against a
 * DVM. The shape is intentionally small — rail-specific config lives next to
 * each rail's primitives (Cashu in `wallet-agent/`, Tempo in `tempo-wallet.ts`,
 * x402 in `lib/x402/`).
 */

/**
 * Canonical rail identifier. Mirrors the wire-level `PaymentMethod` enum
 * (`cashu | x402 | mpp`) on the SDK side; Lightning is not a per-call DVM
 * rail (see public SDK documentation).
 * Ordered roughly by the default resolver preference — Cashu P2PK at the
 * target builder, then Tempo upfront, then x402 — but the caller CLI's own rail
 * resolver, in its own repository, owns the actual ordering.
 */
export type Rail = "cashu_p2pk" | "tempo" | "x402";

export const RAILS: readonly Rail[] = ["cashu_p2pk", "tempo", "x402"] as const;

/**
 * User-facing rail names accepted by `--rail` and `dvm wallet set-default-rail`.
 * `cashu` maps to the P2PK agent-wallet rail.
 */
export type RailFlag = "cashu" | "tempo" | "x402";

export const RAIL_FLAGS: readonly RailFlag[] = ["cashu", "tempo", "x402"] as const;

/**
 * How far above the caller's own conversion a DVM's advertised stablecoin
 * charge may sit before the caller refuses to sign it, in basis points.
 *
 * Both stablecoin rails price in dollars while the caller reasons in msats, so
 * the two sides convert at their own BTC/USD rates and legitimately disagree by
 * a little. This is the width of that legitimate disagreement — past it the
 * advertisement is a different price, not a different rate, and nothing gets
 * signed. Shared so x402 and Tempo cite one number rather than two inline
 * ratios that can drift apart.
 */
export const ADVERTISED_AMOUNT_TOLERANCE_BPS = 1_000n;

/** The largest advertised figure {@link withinAdvertisedTolerance} accepts against `localMicro`. */
export function maxAdvertisedMicro(localMicro: bigint): bigint {
  return (localMicro * (10_000n + ADVERTISED_AMOUNT_TOLERANCE_BPS)) / 10_000n;
}

/** True when the DVM's advertised amount is close enough to the caller's own to sign. */
export function withinAdvertisedTolerance(advertisedMicro: bigint, localMicro: bigint): boolean {
  return advertisedMicro * 10_000n <= localMicro * (10_000n + ADVERTISED_AMOUNT_TOLERANCE_BPS);
}
