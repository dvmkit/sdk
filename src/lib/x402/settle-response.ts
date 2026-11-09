import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { SettleResponse, SettleResponseChannelState } from "./spec";

/**
 * The part of a facilitator's settle answer a caller may see in
 * `PAYMENT-RESPONSE`: `success`, `transaction`, `network`, `payer`, a bounded
 * `errorReason` and, when `channelId` names the batch-settlement channel the
 * payment was for, that channel's validated `extra.channelState`. Anything
 * else the facilitator sent, such as an `errorMessage` or `extensions`, stays
 * server-side, and an overlong value is dropped, so a facilitator answer
 * cannot grow the response header.
 */
export function callerSettleResponse(answer: unknown, options: { channelId?: string } = {}): SettleResponse {
  const body = isRecord(answer) ? answer : {};
  const payer = boundedToken(body.payer);
  const network = boundedToken(body.network);
  const errorReason =
    typeof body.errorReason === "string"
      ? body.errorReason.replace(/[^\x20-\x7e]+/g, " ").trim().slice(0, SETTLE_ERROR_REASON_MAX)
      : "";
  const channelState = options.channelId === undefined ? undefined : loggedChannelState(body.extra, options.channelId);
  return {
    success: body.success === true,
    transaction: boundedToken(body.transaction) ?? "",
    ...(network !== undefined && { network }),
    ...(payer !== undefined && { payer }),
    ...(errorReason !== "" && { errorReason }),
    ...(channelState !== undefined && { extra: { channelState } }),
  };
}

/**
 * The channel state a batch-settlement client may persist from a settle
 * answer's `extra`: absent, or kept with only the fields a client reads, or
 * dropped because it names another channel than `channelId` (compared
 * case-insensitively) or carries a value that is not a uint256. A client keys
 * its channel records by the answer's `channelId`, so a foreign id would
 * overwrite another channel's record.
 */
export function settleChannelState(
  extra: unknown,
  channelId: string
): { kind: "absent" } | { kind: "kept"; state: SettleResponseChannelState } | { kind: "dropped" } {
  if (!isRecord(extra) || extra.channelState === undefined) return { kind: "absent" };
  const state = extra.channelState;
  if (
    !isRecord(state) ||
    typeof state.channelId !== "string" ||
    !CHANNEL_ID.test(state.channelId) ||
    state.channelId.toLowerCase() !== channelId.toLowerCase()
  ) {
    return { kind: "dropped" };
  }
  const kept: SettleResponseChannelState = { channelId: state.channelId };
  for (const field of CHANNEL_AMOUNT_FIELDS) {
    const value = state[field];
    if (value === undefined) continue;
    const decimal = typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
    if (typeof decimal !== "string" || !UINT256_DECIMAL.test(decimal) || BigInt(decimal) > UINT256_MAX) {
      return { kind: "dropped" };
    }
    kept[field] = decimal;
  }
  return { kind: "kept", state: kept };
}

// A transaction hash, CAIP-2 network or payer address is far shorter; a longer
// value is not one of them.
const SETTLE_TOKEN_MAX = 128;
// Long enough for any error code a facilitator or the SDK names.
const SETTLE_ERROR_REASON_MAX = 128;
// A uint256 has at most 78 decimal digits; the length check keeps BigInt cheap.
const UINT256_DECIMAL = /^\d{1,78}$/;
const UINT256_MAX = 2n ** 256n - 1n;
const CHANNEL_ID = /^0x[0-9a-fA-F]{64}$/;
// The channel fields a batch-settlement client reads back from PAYMENT-RESPONSE
// to advance its local channel record. Nothing else in `extra` is read.
const CHANNEL_AMOUNT_FIELDS = ["balance", "totalClaimed", "chargedCumulativeAmount"] as const;

function loggedChannelState(extra: unknown, channelId: string): SettleResponseChannelState | undefined {
  const bound = settleChannelState(extra, channelId);
  if (bound.kind === "dropped") {
    diagnosticConsole.warn({ event: "x402_settle_channel_state_dropped", rail: "x402" });
  }
  return bound.kind === "kept" ? bound.state : undefined;
}

function boundedToken(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= SETTLE_TOKEN_MAX && /^[\x21-\x7e]*$/.test(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
