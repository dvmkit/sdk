/**
 * The skip-vs-fail boundary for the live x402 Base Sepolia settlement tiers
 * and the copy each verdict announces.
 *
 * reachability probes gate on the RPC and the facilitator
 * *answering*. Both can answer and the settlement still fail — a transient
 * facilitator rejection, or the single shared payer key running dry — which
 * can fail an unrelated change with `expected false to be true` and no reason
 * attached. This module is the second gate: given the reason a live
 * settlement actually failed for, it decides whether that reason is ours to fix
 * or the counterparty's, and it names the reason either way.
 *
 * **The default is to fail.** Skipping is an explicit allowlist, so a reason
 * nobody has classified yet reddens CI *with its reason printed* rather than
 * disappearing into a silent green. Widening the allowlist is a deliberate edit.
 *
 * Deliberately pure — no env reads, no network, no vitest globals beyond the
 * `expect.fail` on the fail path — so `x402-live-tier.test.ts` can drive every
 * branch without the testnet secret. The probes and balance reads that do touch
 * the network live in `base-sepolia.ts`.
 */

import { expect } from "vitest";

import {
  BASE_SEPOLIA_RPC_DEFAULT,
  isNetworkGuardBlocked,
  X402_FACILITATOR_DEFAULT,
} from "../../../test-support/network-guard-policy";
import type { X402FacilitatorAuth } from "../../../lib/x402/types";
import { announceTier } from "../../../test-support/tier-announce";

/**
 * What a failed live settlement blames. `envelope` is ours — the tier must go
 * red so someone reads it. `facilitator` and `funding` are counterparty and
 * shared-wallet conditions the tier skips on, the way designed the
 * outage skip.
 */
export type X402FailureCategory = "envelope" | "facilitator" | "funding";

/**
 * A redacted label for the Base Sepolia RPC used by the live x402 tier.
 *
 * Authenticated RPC URLs are infrastructure credentials, so announcements name
 * only whether the configured URL resolves to Base's public fallback or a
 * dedicated endpoint. An invalid value stays redacted too; the reachability
 * probe will report it as unavailable without echoing the value.
 */
export function x402RpcEndpointClass(
  rpcUrl: string
): "public fallback RPC" | "dedicated RPC" | "configured RPC" {
  try {
    const configured = new URL(rpcUrl);
    const publicFallback = new URL(BASE_SEPOLIA_RPC_DEFAULT);
    return configured.origin === publicFallback.origin ? "public fallback RPC" : "dedicated RPC";
  } catch {
    return "configured RPC";
  }
}

/** Authenticated-facilitator settings resolved without ever returning credential-bearing copy. */
export interface X402TestnetFacilitatorConfig {
  /** Facilitator endpoint, falling back to x402.org for explicitly local runs. */
  facilitator: string;
  /** Complete auth pair, or undefined when the public fallback is intentionally in use. */
  facilitatorAuth?: X402FacilitatorAuth;
}

/**
 * Resolve the live tier's facilitator and enforce its credential boundary.
 *
 * A half-pair is always an operator error. CI additionally sets
 * `X402_TESTNET_REQUIRE_AUTH=true`, making a missing endpoint or pair fail the
 * run instead of silently spending through the public fallback.
 */
export function loadX402TestnetFacilitatorConfig(
  env: Record<string, string | undefined> = process.env
): X402TestnetFacilitatorConfig {
  const facilitator = env.X402_TESTNET_FACILITATOR?.trim();
  const keyId = env.X402_TESTNET_FACILITATOR_KEY_ID?.trim();
  const keySecret = env.X402_TESTNET_FACILITATOR_KEY_SECRET?.trim();
  const hasKeyId = Boolean(keyId);
  const hasKeySecret = Boolean(keySecret);

  if (hasKeyId !== hasKeySecret) {
    throw new Error(
      "X402_TESTNET_FACILITATOR_KEY_ID and X402_TESTNET_FACILITATOR_KEY_SECRET must be configured together"
    );
  }
  if (env.X402_TESTNET_REQUIRE_AUTH === "true" && (!facilitator || !hasKeyId)) {
    throw new Error(
      "Authenticated x402 testnet facilitator required: configure X402_TESTNET_FACILITATOR and its complete key pair"
    );
  }

  return {
    facilitator: facilitator || X402_FACILITATOR_DEFAULT,
    ...(keyId && keySecret ? { facilitatorAuth: { keyId, keySecret } } : {}),
  };
}

/** Redacted facilitator class for CI announcements; never returns its URL. */
export function x402FacilitatorEndpointClass(
  facilitatorUrl: string
): "public fallback facilitator" | "dedicated facilitator" | "configured facilitator" {
  try {
    const configured = new URL(facilitatorUrl);
    const publicFallback = new URL(X402_FACILITATOR_DEFAULT);
    return configured.origin === publicFallback.origin &&
      configured.pathname.replace(/\/+$/, "") === publicFallback.pathname.replace(/\/+$/, "")
      ? "public fallback facilitator"
      : "dedicated facilitator";
  } catch {
    return "configured facilitator";
  }
}

/** The minimum of vitest's `TestContext` a skip needs. */
export interface SkippableTestContext {
  readonly skip: {
    (note?: string): never;
    (condition: boolean, note?: string): void;
  };
}

/** Inputs for the payer-funding line the tier announces. */
export interface PayerFundingDetailOpts {
  /** The shared payer address, named so a top-up needs no key lookup. */
  address: string;
  /** Its USDC balance in 6-decimal micro-units, or null when the read failed. */
  balanceMicro: bigint | null;
  /** What one run of the tier spends. */
  minMicro: bigint;
  /** Why the balance read failed, when it did. */
  error?: string;
}

/** Whether the unfunded-payer tier can prove a facilitator balance rejection. */
export function canRunUnfundedX402Rejection(
  reachable: boolean,
  balanceMicro: bigint | null | undefined
): boolean {
  return reachable && balanceMicro !== null && balanceMicro !== undefined;
}

/** Local evidence that a facilitator rejected the deliberately unfunded payer. */
export interface UnfundedRejectionEvidence {
  /** Whether the payment signature independently recovers to its stated payer. */
  canonicalSignature: boolean;
  /** Payer's independently read USDC balance. */
  balanceMicro: bigint;
}

/**
 * Whether local evidence proves the deliberately unfunded rejection premise.
 *
 * The facilitator's reason carries no information here: the generated payer
 * cannot fund the payment, so every conformant facilitator must reject whether
 * or not it describes the balance failure. The facts outside its control are
 * that the signature recovers locally and the payer has exactly zero USDC.
 */
export function isLocallyProvenUnfundedRejection(evidence: UnfundedRejectionEvidence): boolean {
  return evidence.canonicalSignature && evidence.balanceMicro === 0n;
}

/**
 * Whether a facilitator response proves that it could validate a signed exact
 * EVM payload. The live preflight uses an independent reference-client
 * signature with an unfunded key. x402.org names insufficient balance; CDP's
 * dedicated endpoint currently returns the opaque `invalid_payload`. Either
 * proves the verifier was reached, while a signature rejection means the
 * verifier itself is unavailable or out of sync.
 */
export function isExactEvmVerificationHealthy(response: unknown): boolean {
  if (!response || typeof response !== "object" || Array.isArray(response)) return false;
  const result = response as { isValid?: unknown; invalidReason?: unknown };
  if (result.isValid === true) return true;
  if (result.isValid !== false || typeof result.invalidReason !== "string") return false;
  const reason = result.invalidReason.toLowerCase();
  return !(reason.startsWith("invalid_") && reason.includes("signature"));
}

/**
 * Classify the reason a live x402 settlement failed.
 *
 * `facilitator` covers the counterparty saying it broke: a 5xx, a rate-limit or
 * timeout status, its own `unexpected_*_error` reasons, any transport failure
 * {@link x402FailureReason} mapped, and a {@link BROADCAST_CONDITIONS} race in
 * its own mempool. `funding` covers the shared payer running dry. Everything
 * else — every `invalid_*` from the facilitator, a 4xx that isn't 429/408, and
 * `verify.ts`'s own `decode_failed` / `unsupported_version` / `verify_failed` /
 * `settle_failed` fallbacks — is `envelope` and stays a hard failure. A nameless
 * rejection lands here on purpose: an unexplained red is exactly what
 * exists to surface, so it must not be skipped away.
 */
export function classifyX402Failure(reason: string): X402FailureCategory {
  if (reason.startsWith("transport_")) return "facilitator";
  if (reason === "unexpected_verify_error" || reason === "unexpected_settle_error") {
    return "facilitator";
  }
  // Substring, and above everything that reads an `invalid_*` prefix as ours:
  // x402.org answers a drained payer `invalid_exact_evm_insufficient_balance`,
  // which is a funding condition wearing an envelope-shaped name.
  if (reason.includes("insufficient_funds") || reason.includes("insufficient_balance")) {
    return "funding";
  }
  // Below funding, above the fall-through: the facilitator answered 200 with
  // `success: false` and its own broadcast error, which `verify.ts` passes
  // through verbatim. Prose, so substring and case-insensitive.
  const lower = reason.toLowerCase();
  if (BROADCAST_CONDITIONS.some((condition) => lower.includes(condition))) {
    return "facilitator";
  }
  const status = /^facilitator_status_(\d{3})$/.exec(reason);
  if (status) {
    const code = Number(status[1]);
    // 5xx is the facilitator failing; 429 and 408 are it declining to answer
    // right now. Every other 4xx means it read our envelope and refused it.
    if (code >= 500 || code === 429 || code === 408) return "facilitator";
  }
  return "envelope";
}

/**
 * Turn a throw out of verify/settle into a classifiable reason string.
 *
 * `verifyWithFacilitator` / `settleWithFacilitator` (`src/lib/x402/facilitator-request.ts`)
 * turn a non-2xx into an `invalidReason` but pass a transport failure straight
 * through as an exception, so a connection reset or a hung socket reaches the
 * tier as a throw rather than a receipt.
 *
 * A vitest network-guard block is the one error this does **not** convert: that
 * means the tier is enabled but its host was never allowlisted, which must fail
 * the run rather than read as an outage.
 */
export function x402FailureReason(err: unknown): string {
  if (isNetworkGuardBlocked(err)) throw err;
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  const kind = name === "AbortError" || name === "TimeoutError" ? "timeout" : "error";
  return `transport_${kind}: ${message}`;
}

/**
 * Announce a counterparty condition and skip the test. The announcement goes to
 * stderr where vitest's default reporter can't swallow it and the
 * note rides the skipped test in the reporter, so the CI log names the cause
 * twice over. `ctx.skip()` throws, so nothing after this call runs.
 */
export function skipLiveX402(
  ctx: SkippableTestContext,
  tier: string,
  reason: string,
  where: string
): never {
  const detail = `live settlement declined at ${where}: ${reason} — counterparty/funding condition, not our envelope`;
  announceTier(tier, "skipped", detail);
  return ctx.skip(detail);
}

/**
 * Resolve a live-settlement failure: skip a counterparty or funding condition,
 * fail on anything that implicates our own envelope. Either way the reason is in
 * the output — the `expected false to be true` this replaces named nothing.
 */
export function skipOrFailLiveX402(
  ctx: SkippableTestContext,
  tier: string,
  reason: string,
  where: string
): never {
  const category = classifyX402Failure(reason);
  if (category !== "envelope") return skipLiveX402(ctx, tier, reason, where);
  return expect.fail(
    `x402 live settlement failed at ${where}: ${reason} — classified "envelope", so this is our x402 payload, not the counterparty. See docs/operations/x402-test-wallet.md.`
  );
}

/**
 * The payer-funding line for {@link announceTier}. Names the address and the
 * balance on every verdict — the shared wallet is topped up by hand, so a
 * running tier printing its balance is the only advance warning anyone gets
 * before it drains and the tier starts skipping.
 */
export function payerFundingDetail({
  address,
  balanceMicro,
  minMicro,
  error,
}: PayerFundingDetailOpts): string {
  if (balanceMicro === null) {
    return `payer ${address} balance unreadable${error ? ` (${error})` : ""}`;
  }
  const held = `payer ${address} holds ${formatUsdc(balanceMicro)} USDC`;
  if (balanceMicro < minMicro) {
    return `${held}, below the ${formatUsdc(minMicro)} one run spends — top up per docs/operations/x402-test-wallet.md`;
  }
  if (balanceMicro < minMicro * LOW_WATER_RUNS) {
    return `${held} (under ${LOW_WATER_RUNS} runs left — top up soon per docs/operations/x402-test-wallet.md)`;
  }
  return held;
}

/**
 * Mempool conditions on the facilitator's **own** broadcast, lowercased for a
 * case-insensitive substring test.
 *
 * The facilitator settles by signing and broadcasting `transferWithAuthorization`
 * from its own EOA. When that broadcast collides in its mempool it answers 200
 * with `success: false` and a viem dump as `errorReason`, which reaches the
 * classifier as free-form prose matching none of the structured arms above — so
 * it took the `envelope` fall-through and froze the default branch twice in one
 * evening.
 *
 * Every entry is a property of the *relayer's* transaction — its gas price and
 * its account nonce — which our EIP-3009 authorization cannot influence. That is
 * the whole discriminator, and it is deliberately narrower than "the reason
 * looks like an RPC dump": a genuine envelope regression (a bad signature, a
 * spent authorization) arrives in an identical-looking dump whose `Details:` is
 * a *revert*, and must stay red.
 */
const BROADCAST_CONDITIONS = [
  // Subsumes geth's "replacement transaction underpriced" — the one observed.
  "transaction underpriced",
  "replacement fee too low",
  "nonce too low",
  "nonce too high",
  "already known",
];

/**
 * Runs' worth of spend below which the announcement nags. Well short of the
 * ~1000 runs a $1 top-up buys, so the nag is lead time rather than noise.
 */
const LOW_WATER_RUNS = 100n;

function formatUsdc(micro: bigint): string {
  return (Number(micro) / 1e6).toFixed(6);
}
