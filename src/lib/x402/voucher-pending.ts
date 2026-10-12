/** Exact signed request retained until a funding response is acknowledged. */
export interface PendingX402Funding {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  fundId: string;
  amountMicro: number;
  targetMicro: number;
  paymentHeader: string;
  channelId: `0x${string}`;
  requestedAt: number;
  /**
   * What the signature itself authorizes, not what the funding intended. The
   * timed exit's guaranteed figure has to account for the cumulative cap the
   * payer put its name to, and a deposit's authorized value can exceed the funded amount
   * so both are journalled from the payload at signing time
   * rather than recomputed from the request. Optional because entries written
   * before this field existed are still on disk; reservation consumers must
   * handle missing or unreadable authority conservatively.
   */
  maxClaimableMicro?: string;
  /** ERC-3009 value on a deposit payload; absent on a voucher-only payload. */
  depositMicro?: string;
  /** Unix seconds after which a deposit authorization can no longer be submitted. */
  authorizationValidBefore?: string;
  /**
   * A recorded terminal refusal, excluded from verbatim resumption. Marked
   * rather than deleted, because the entry carries two signed things with
   * different lifetimes and only one of them dies on a clock: the
   * ERC-3009 deposit authorization, dead at `authorizationValidBefore`, and the
   * cumulative claim voucher, which `claim()` accepts with no expiry field and
   * no dependency on the deposit having landed. So a refusal releases the
   * deposit-shaped gates on that timestamp, but never releases the claim
   * voucher reservation. Explicit journal deletion is a separate operation.
   */
  refusedAt?: number;
  /**
   * When a newer live row for this credit was found at another known origin.
   * The older authority remains journalled for channel exposure, but is never
   * replayed: two alias-split fund ids are two payments for one top-up.
   */
  supersededAt?: number;
}

/**
 * Age at which an active unacknowledged voucher is reported as abandoned and
 * may be retired without force. Age alone does not revoke its signed authority.
 * Retired deposits have a separate authorization-expiry gate.
 */
export const X402_PENDING_STALE_MS = 24 * 60 * 60 * 1000;

/** Whether an entry has gone long enough unacknowledged to read as abandoned. */
export function x402PendingStale(pending: PendingX402Funding, now = Date.now()): boolean {
  return now - pending.requestedAt >= X402_PENDING_STALE_MS;
}

/** Whether this funding has a final answer or a newer alias-split replacement. */
export function x402PendingRetired(pending: PendingX402Funding): boolean {
  return pending.refusedAt !== undefined || pending.supersededAt !== undefined;
}

/**
 * When a refused entry's deposit authorization stops being submittable, and
 * with it every gate that exists to stop a second deposit being minted.
 *
 * Entries with no readable `authorizationValidBefore` — written before the
 * field existed, or carrying a voucher-only payload — get the conservative
 * answer rather than an immediate release: the stale threshold, the same
 * "long enough to read as abandoned" line the CLI already draws.
 */
export function x402PendingBlockExpiresAt(pending: PendingX402Funding): number {
  return x402PendingDepositExpiresAt(pending) ?? pending.requestedAt + X402_PENDING_STALE_MS;
}

/** Signed deposit deadline in epoch milliseconds; absent for unreadable/legacy authority. */
export function x402PendingDepositExpiresAt(pending: PendingX402Funding): number | undefined {
  const seconds = pending.authorizationValidBefore ? Number(pending.authorizationValidBefore) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/**
 * Whether an entry still carries the deposit-shaped hazard: a signed ERC-3009
 * authorization that could yet be submitted, which is what the rival-voucher
 * gate and the key-loss refusals exist to protect against. True for anything
 * still awaiting acknowledgement — nothing releases on age — and for
 * a refused entry only until its authorization dies.
 *
 * Never the predicate for the timed exit's guaranteed figure, which accounts
 * for the claim voucher and has no timestamp to release on.
 */
export function x402PendingUnsettled(pending: PendingX402Funding, now = Date.now()): boolean {
  return !x402PendingRetired(pending) || now <= x402PendingBlockExpiresAt(pending);
}

/** Refusal facts in epoch milliseconds, without caller recovery guidance. */
export interface X402VoucherPendingState {
  code: "x402_voucher_pending";
  creditId: string;
  fundId: string;
  channelId: string;
  endpoint: string;
  retired: boolean;
  blockedUntil: number;
  depositExpiresAt?: number;
}

export function x402VoucherPendingState(blocking: PendingX402Funding): X402VoucherPendingState {
  const depositExpiresAt = x402PendingDepositExpiresAt(blocking);
  return {
    code: "x402_voucher_pending",
    creditId: blocking.creditId,
    fundId: blocking.fundId,
    channelId: blocking.channelId,
    endpoint: blocking.endpoint,
    retired: x402PendingRetired(blocking),
    blockedUntil: x402PendingBlockExpiresAt(blocking),
    ...(depositExpiresAt === undefined ? {} : { depositExpiresAt }),
  };
}

/**
 * Reject a second independently spendable deposit across credit/endpoint scopes.
 * Same-credit live entries permit verbatim replay; retirement alone never revokes
 * an authorization. Supply the existing channel-scoped journal. The thrown
 * value is facts, for caller adapters to render.
 */
export function assertNoRivalX402Voucher(
  channelId: `0x${string}`,
  creditId: string,
  pending: PendingX402Funding[],
  now?: number
): void {
  const blocking = pending.filter((entry) => x402PendingUnsettled(entry, now));
  const rival =
    blocking.find((entry) => entry.creditId !== creditId && !x402PendingRetired(entry)) ??
    blocking.find((entry) => entry.creditId !== creditId || x402PendingRetired(entry));
  if (rival) throw { ...x402VoucherPendingState(rival), channelId };
}
