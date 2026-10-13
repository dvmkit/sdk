import type { TempoChannelBinding, TempoChannelSettlementOutcome } from "./mpp-setup";

/**
 * TIP-1034's unilateral-close event, as declared by both the precompile and
 * legacy escrow ABIs mppx ships.
 *
 * `channelId`, `payer` and `payee` are indexed, so a verified log carries the
 * channel id in `topics[1]` without needing the data payload decoded.
 */
export const TEMPO_CLOSE_REQUESTED_SIGNATURE =
  "CloseRequested(bytes32,address,address,uint256)" as const;

/**
 * `topics[0]` of a `CloseRequested` log.
 *
 * Hard-coded rather than derived, because this module is imported by every
 * DVM server while `viem` is an *optional* peer dependency — computing the
 * selector at import time would make an EVM library mandatory for a DVM that
 * takes no on-chain payments at all. `tempo-close-event.test.ts` pins the
 * constant against viem's own `toEventSelector`, so it cannot drift.
 */
export const TEMPO_CLOSE_REQUESTED_TOPIC =
  "0xf5a36fc00a96cbb9cf1f8f59299165e1d8ffffe94396d82904b4da524d16bbce";

/**
 * Maximum wall-clock budget for replacing stale Postgres sockets during one
 * close delivery. The platform wake request allows 30 seconds; retaining a
 * fifteen-second margin leaves receipt verification and the settlement submission
 * room to finish instead of letting database recovery consume the whole wake.
 */
export const TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS = 15_000;

/**
 * Where a close event lives on chain — the entire delivery payload.
 *
 * Deliberately carries no credential and no claim about the channel: the
 * platform is telling the DVM *where to look*, not what it will find. Every
 * fact the DVM acts on is read back from its own configured Tempo RPC, which
 * is why this wake path needs no platform signing key and no recoverable copy
 * of the DVM's bearer token.
 */
export interface TempoCloseEventLocator {
  chainId: number;
  txHash: `0x${string}`;
  logIndex: number;
}

export interface TempoReceiptLog {
  address: string;
  topics: readonly string[];
  logIndex: number;
}

/** Fetches the receipt a locator names, from the DVM's own Tempo RPC. */
export type TempoReceiptFetcher = (
  locator: TempoCloseEventLocator
) => Promise<{ logs: readonly TempoReceiptLog[] } | null>;

export type TempoCloseEventRefusal =
  | "malformed_locator"
  | "receipt_unavailable"
  | "log_not_found"
  | "not_close_requested"
  | "malformed_log"
  | "unknown_channel"
  | "chain_mismatch"
  | "escrow_mismatch";

/** What a delivered close event did. Mirrors the HTTP contract below. */
export type TempoCloseEventResult =
  | { status: "ok"; outcome: TempoChannelSettlementOutcome }
  | { status: "refused"; reason: TempoCloseEventRefusal; channelId?: string }
  | { status: "retry"; reason: TempoCloseEventRefusal };

export interface TempoCloseEventDeps {
  fetchReceipt: TempoReceiptFetcher;
  getBinding: (channelId: string) => Promise<TempoChannelBinding | null>;
  settle: (channelId: string) => Promise<TempoChannelSettlementOutcome>;
}

/**
 * Validate an untrusted close-event delivery body into a locator.
 *
 * Rejects anything it cannot use rather than coercing: a bad `logIndex` would
 * otherwise silently address the wrong log in the same transaction.
 */
export function parseTempoCloseEventLocator(body: unknown): TempoCloseEventLocator | null {
  if (!body || typeof body !== "object") return null;
  const raw = body as Record<string, unknown>;
  const chainId = raw.chain_id ?? raw.chainId;
  const txHash = raw.tx_hash ?? raw.txHash;
  const logIndex = raw.log_index ?? raw.logIndex;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return null;
  if (typeof logIndex !== "number" || !Number.isSafeInteger(logIndex) || logIndex < 0) return null;
  return { chainId, txHash: txHash.toLowerCase() as `0x${string}`, logIndex };
}

/**
 * Verify a close event against chain and act on it.
 *
 * The on-chain event is the whole authority, so every check here is a
 * precondition for touching money and none of them may be skipped:
 *
 * 1. The receipt is fetched from the DVM's **own** RPC for the named chain.
 * 2. The named log exists and is a `CloseRequested` log.
 * 3. Its channel id resolves to a channel in this DVM's durable store —
 * a DVM never settles a channel it does not own.
 * 4. The log's emitting contract and chain match the binding that channel was
 * opened against. This is what stops a look-alike escrow: an attacker can
 * deploy a contract that emits `CloseRequested` for any channel id, but not
 * one whose address matches a channel we already hold.
 *
 * Only then does the targeted settlement run. Anything else returns without
 * mutation.
 */
export async function handleTempoCloseEvent(
  locator: TempoCloseEventLocator,
  deps: TempoCloseEventDeps
): Promise<TempoCloseEventResult> {
  let receipt: Awaited<ReturnType<TempoReceiptFetcher>>;
  try {
    receipt = await deps.fetchReceipt(locator);
  } catch {
    // An RPC that cannot answer is not evidence of absence — retry inside the
    // grace period rather than dropping a close we were told about.
    return { status: "retry", reason: "receipt_unavailable" };
  }
  if (!receipt) return { status: "retry", reason: "receipt_unavailable" };

  const log = receipt.logs.find((entry) => entry.logIndex === locator.logIndex);
  if (!log) return { status: "refused", reason: "log_not_found" };
  if (log.topics[0]?.toLowerCase() !== TEMPO_CLOSE_REQUESTED_TOPIC.toLowerCase()) {
    return { status: "refused", reason: "not_close_requested" };
  }

  const channelId = log.topics[1]?.toLowerCase();
  if (!channelId || !/^0x[0-9a-fA-F]{64}$/.test(channelId)) {
    return { status: "refused", reason: "malformed_log" };
  }

  const binding = await deps.getBinding(channelId);
  if (!binding) return { status: "refused", reason: "unknown_channel", channelId };
  if (binding.chainId !== locator.chainId) {
    return { status: "refused", reason: "chain_mismatch", channelId };
  }
  if (binding.escrowContract.toLowerCase() !== log.address.toLowerCase()) {
    return { status: "refused", reason: "escrow_mismatch", channelId };
  }

  return { status: "ok", outcome: await deps.settle(channelId) };
}

/**
 * Render a settlement outcome as JSON. Channel amounts are `bigint`, which
 * `JSON.stringify` throws on rather than coercing — so the wire form states
 * them as decimal strings.
 */
export function serializeTempoSettlementOutcome(
  outcome: TempoChannelSettlementOutcome
): Record<string, unknown> {
  switch (outcome.outcome) {
    case "settled":
      return {
        outcome: outcome.outcome,
        channel_id: outcome.channelId,
        settled_amount: outcome.settledAmount.toString(),
      };
    case "already_safe":
      return {
        outcome: outcome.outcome,
        channel_id: outcome.channelId,
        settled_on_chain: outcome.settledOnChain.toString(),
      };
    case "finalized_before_protection":
      return {
        outcome: outcome.outcome,
        channel_id: outcome.channelId,
        owed: outcome.owed.toString(),
        settled_on_chain: outcome.settledOnChain.toString(),
      };
    case "retryable_failure":
      return { outcome: outcome.outcome, channel_id: outcome.channelId, error: outcome.error };
    case "unknown_channel":
      return { outcome: outcome.outcome, channel_id: outcome.channelId };
  }
}

/**
 * HTTP status for a close-event result — the platform observer's delivery
 * contract.
 *
 * `200` acknowledges the durable event. `409` is terminal but unacknowledged:
 * the observer records the outcome and stops retrying, and pages on the ones
 * that mean money (`finalized_before_protection`) or misrouting
 * (`unknown_channel`). `503` keeps the event pending for another attempt.
 */
export function tempoCloseEventStatus(result: TempoCloseEventResult): 200 | 409 | 503 {
  if (result.status === "retry") return 503;
  if (result.status === "refused") return 409;
  switch (result.outcome.outcome) {
    case "settled":
    case "already_safe":
      return 200;
    case "retryable_failure":
      return 503;
    // A channel that finalized still owing us value is a money incident, not
    // a successful protection — it must never read as an acknowledgement.
    case "finalized_before_protection":
    case "unknown_channel":
      return 409;
  }
}
