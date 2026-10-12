/**
 * The delivery payload carries no credential, so every one of these refusals
 * is load-bearing: they are the whole reason an unauthenticated wake is safe.
 */
import { parseAbiItem, toEventSelector } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { TempoChannelSettlementOutcome } from "../mpp-setup";
import {
  handleTempoCloseEvent,
  parseTempoCloseEventLocator,
  serializeTempoSettlementOutcome,
  TEMPO_CLOSE_REQUESTED_SIGNATURE,
  TEMPO_CLOSE_REQUESTED_TOPIC,
  tempoCloseEventStatus,
} from "../tempo-close-event";

const CHANNEL_ID = `0x${"11".repeat(32)}`;
const ESCROW = `0x${"22".repeat(20)}`;
const OTHER_ESCROW = `0x${"99".repeat(20)}`;
const TX_HASH = `0x${"33".repeat(32)}` as `0x${string}`;
const PAYER = `0x${"44".repeat(20)}`;
const PAYEE = `0x${"55".repeat(20)}`;
const CHAIN_ID = 42431;

const LOCATOR = { chainId: CHAIN_ID, txHash: TX_HASH, logIndex: 2 };

function closeLog(
  overrides: Partial<{ address: string; topics: string[]; logIndex: number }> = {}
) {
  return {
    address: ESCROW,
    topics: [TEMPO_CLOSE_REQUESTED_TOPIC, CHANNEL_ID, PAYER, PAYEE],
    logIndex: 2,
    ...overrides,
  };
}

function deps(
  overrides: {
    logs?: ReturnType<typeof closeLog>[] | null;
    fetchReceipt?: () => Promise<{ logs: ReturnType<typeof closeLog>[] } | null>;
    binding?: { chainId: number; escrowContract: string } | null;
    outcome?: TempoChannelSettlementOutcome;
  } = {}
) {
  const settle = vi.fn(() =>
    Promise.resolve(
      overrides.outcome ?? {
        outcome: "settled" as const,
        channelId: CHANNEL_ID,
        settledAmount: 60n,
      }
    )
  );
  const getBinding = vi.fn(() =>
    Promise.resolve(
      overrides.binding === undefined
        ? { chainId: CHAIN_ID, escrowContract: ESCROW }
        : overrides.binding
    )
  );
  const fetchReceipt = vi.fn(
    overrides.fetchReceipt ??
      (() =>
        Promise.resolve(overrides.logs === null ? null : { logs: overrides.logs ?? [closeLog()] }))
  );
  return { fetchReceipt, getBinding, settle };
}

describe("TEMPO_CLOSE_REQUESTED_TOPIC", () => {
  it("matches the selector viem derives from the TIP-1034 event", () => {
    // The constant is hard-coded so this module never imports viem at runtime
    // (it is an optional peer dependency). This is what stops it drifting.
    const event = parseAbiItem(
      "event CloseRequested(bytes32 indexed channelId, address indexed payer, address indexed payee, uint256 closeGraceEnd)"
    );
    expect(TEMPO_CLOSE_REQUESTED_TOPIC).toBe(toEventSelector(event));
    expect(TEMPO_CLOSE_REQUESTED_TOPIC).toBe(toEventSelector(TEMPO_CLOSE_REQUESTED_SIGNATURE));
  });
});

describe("parseTempoCloseEventLocator", () => {
  it("accepts snake_case and camelCase locators", () => {
    expect(
      parseTempoCloseEventLocator({ chain_id: CHAIN_ID, tx_hash: TX_HASH, log_index: 2 })
    ).toEqual(LOCATOR);
    expect(
      parseTempoCloseEventLocator({ chainId: CHAIN_ID, txHash: TX_HASH, logIndex: 2 })
    ).toEqual(LOCATOR);
  });

  it("lowercases the transaction hash", () => {
    const parsed = parseTempoCloseEventLocator({
      chain_id: CHAIN_ID,
      tx_hash: `0x${"AB".repeat(32)}`,
      log_index: 0,
    });
    expect(parsed?.txHash).toBe(`0x${"ab".repeat(32)}`);
  });

  it.each([
    ["a non-object body", null],
    ["a missing chain", { tx_hash: TX_HASH, log_index: 0 }],
    ["a malformed hash", { chain_id: CHAIN_ID, tx_hash: "0xnope", log_index: 0 }],
    ["a negative log index", { chain_id: CHAIN_ID, tx_hash: TX_HASH, log_index: -1 }],
    ["a fractional log index", { chain_id: CHAIN_ID, tx_hash: TX_HASH, log_index: 1.5 }],
    ["a string log index", { chain_id: CHAIN_ID, tx_hash: TX_HASH, log_index: "2" }],
  ])("rejects %s rather than coercing it", (_label, body) => {
    expect(parseTempoCloseEventLocator(body)).toBeNull();
  });
});

describe("handleTempoCloseEvent", () => {

  it("refuses a log emitted by a look-alike escrow", async () => {
    // An attacker can deploy a contract that emits CloseRequested for any
    // channel id. It cannot make its address match the escrow the channel was
    // opened against, which is the check that matters.
    const d = deps({ logs: [closeLog({ address: OTHER_ESCROW })] });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "escrow_mismatch",
    });
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("refuses a wrong-chain locator", async () => {
    const d = deps({ binding: { chainId: 999, escrowContract: ESCROW } });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "chain_mismatch",
    });
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("refuses a channel this DVM does not hold", async () => {
    const d = deps({ binding: null });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "unknown_channel",
      channelId: CHANNEL_ID,
    });
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("refuses a log that is not CloseRequested", async () => {
    const d = deps({ logs: [closeLog({ topics: [`0x${"ee".repeat(32)}`, CHANNEL_ID] })] });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "not_close_requested",
    });
    expect(d.settle).not.toHaveBeenCalled();
  });

  it("refuses when the named log index is absent from the receipt", async () => {
    const d = deps({ logs: [closeLog({ logIndex: 7 })] });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "log_not_found",
    });
  });

  it("addresses exactly the named log, not merely some close in the transaction", async () => {
    // One transaction can close several channels. Acting on the wrong one
    // would settle a channel no event authorised.
    const other = `0x${"77".repeat(32)}`;
    const d = deps({
      logs: [
        closeLog({ logIndex: 2, topics: [TEMPO_CLOSE_REQUESTED_TOPIC, other, PAYER, PAYEE] }),
        closeLog({ logIndex: 3 }),
      ],
    });

    await handleTempoCloseEvent(LOCATOR, d);

    expect(d.settle).toHaveBeenCalledWith(other);
  });

  it("refuses a malformed channel id in the log topics", async () => {
    const d = deps({ logs: [closeLog({ topics: [TEMPO_CLOSE_REQUESTED_TOPIC, "0xshort"] })] });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({
      status: "refused",
      reason: "malformed_log",
    });
  });

  it("retries rather than refusing when the RPC cannot answer", async () => {
    // Absence of evidence is not evidence of absence: dropping the close here
    // would forfeit the money the grace period is protecting.
    const d = deps({ fetchReceipt: () => Promise.reject(new Error("rpc down")) });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toEqual({
      status: "retry",
      reason: "receipt_unavailable",
    });
  });

  it("retries on a receipt the chain does not have yet", async () => {
    const d = deps({ logs: null });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toEqual({
      status: "retry",
      reason: "receipt_unavailable",
    });
  });

  it("matches the topic case-insensitively", async () => {
    const d = deps({
      logs: [
        closeLog({
          topics: [
            TEMPO_CLOSE_REQUESTED_TOPIC.toUpperCase(),
            CHANNEL_ID.toUpperCase(),
            PAYER,
            PAYEE,
          ],
          address: ESCROW.toUpperCase(),
        }),
      ],
    });

    await expect(handleTempoCloseEvent(LOCATOR, d)).resolves.toMatchObject({ status: "ok" });
  });
});

describe("tempoCloseEventStatus", () => {
  it("acknowledges only a settlement or an already-safe channel", () => {
    expect(
      tempoCloseEventStatus({
        status: "ok",
        outcome: { outcome: "settled", channelId: CHANNEL_ID, settledAmount: 1n },
      })
    ).toBe(200);
    expect(
      tempoCloseEventStatus({
        status: "ok",
        outcome: { outcome: "already_safe", channelId: CHANNEL_ID, settledOnChain: 1n },
      })
    ).toBe(200);
  });

  it("never acknowledges a channel finalized before protection", () => {
    // This is a money incident. A 200 would let the platform close the event
    // as successfully handled and stop paging.
    expect(
      tempoCloseEventStatus({
        status: "ok",
        outcome: {
          outcome: "finalized_before_protection",
          channelId: CHANNEL_ID,
          owed: 40n,
          settledOnChain: 20n,
        },
      })
    ).toBe(409);
  });

  it("keeps a retryable failure pending", () => {
    expect(
      tempoCloseEventStatus({
        status: "ok",
        outcome: { outcome: "retryable_failure", channelId: CHANNEL_ID, error: "x" },
      })
    ).toBe(503);
    expect(tempoCloseEventStatus({ status: "retry", reason: "receipt_unavailable" })).toBe(503);
  });

  it("terminates a refusal without retrying", () => {
    expect(tempoCloseEventStatus({ status: "refused", reason: "escrow_mismatch" })).toBe(409);
  });
});

describe("serializeTempoSettlementOutcome", () => {

  it("carries the owed figure a money incident has to be investigated with", () => {
    expect(
      serializeTempoSettlementOutcome({
        outcome: "finalized_before_protection",
        channelId: CHANNEL_ID,
        owed: 40n,
        settledOnChain: 20n,
      })
    ).toEqual({
      outcome: "finalized_before_protection",
      channel_id: CHANNEL_ID,
      owed: "40",
      settled_on_chain: "20",
    });
  });
});
