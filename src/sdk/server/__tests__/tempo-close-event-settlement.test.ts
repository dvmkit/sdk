/**
 * The platform's close observer acknowledges its durable event on a terminal
 * outcome and retries otherwise, so these outcomes are a delivery contract.
 * The companion suite `tempo-session-watch.test.ts` pins the routine sweep;
 * both go through one settlement predicate, and a change that makes them
 * disagree is a money bug.
 */
import { Store } from "mppx";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import {
  _testing,
  TEMPO_SETTLEMENT_IN_FLIGHT,
  TEMPO_SETTLEMENT_LEASE_FIELD,
  TEMPO_SETTLEMENT_LEASE_MS,
} from "../mpp-setup";

const CHANNEL_ID = `0x${"11".repeat(32)}` as `0x${string}`;
const ESCROW = `0x${"22".repeat(20)}` as `0x${string}`;
const TOKEN = `0x${"44".repeat(20)}` as `0x${string}`;

interface ChainState {
  settled: bigint;
  deposit: bigint;
  closeRequestedAt: number;
}

function channelState(overrides: Record<string, unknown> = {}) {
  return {
    channelId: CHANNEL_ID,
    chainId: 42431,
    escrowContract: ESCROW,
    token: TOKEN,
    closeRequestedAt: 0n,
    deposit: 100n,
    finalized: false,
    highestVoucherAmount: 60n,
    spent: 40n,
    settledOnChain: 20n,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function runtime(args: {
  state?: Record<string, unknown> | null;
  chainState?: ChainState;
  getChannelStatesBatch?: () => Promise<ChainState[]>;
  settle?: () => Promise<`0x${string}`>;
  /** Share one store between two runtimes to stand in for two Fly machines. */
  store?: Store.AtomicStore;
  leaseMs?: number;
}) {
  const memory = args.store ?? Store.memory();
  if (args.state !== null && !args.store)
    await memory.put(CHANNEL_ID, args.state ?? channelState());
  const settle = vi.fn(args.settle ?? (() => Promise.resolve(`0x${"33".repeat(32)}` as const)));
  const getChannelStatesBatch = vi.fn(
    args.getChannelStatesBatch ??
      (() =>
        Promise.resolve([
          args.chainState ?? { settled: 20n, deposit: 100n, closeRequestedAt: 123 },
        ]))
  );
  const account = privateKeyToAccount(generatePrivateKey());
  const mpp = _testing.attachTempoSessionRuntime(
    {} as never,
    {
      store: memory,
      account,
      getClient: () => Promise.resolve({} as never),
      settlementSchedule: {
        intervalMs: 24 * 60 * 60 * 1_000,
        ...(args.leaseMs !== undefined && { leaseMs: args.leaseMs }),
      },
    },
    { getChannelStatesBatch, settle }
  );
  return { memory, mpp, settle, getChannelStatesBatch };
}

/** A settle that parks until the test releases it, standing in for a receipt wait. */
function blockingSettle() {
  let release!: () => void;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    started,
    release,
    settle: async () => {
      entered();
      await parked;
      return `0x${"33".repeat(32)}` as `0x${string}`;
    },
  };
}

describe("settleTempoSessionChannel", () => {
  it("settles a channel the chain confirms is closing, above terminal consumption", async () => {
    // spent (40) < highestVoucherAmount (60): the routine cadence would refuse
    // this, but a forced close has no cooperative path left to protect.
    const { mpp, settle, memory } = await runtime({});

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "settled",
      channelId: CHANNEL_ID,
      settledAmount: 60n,
    });
    await expect(memory.get(CHANNEL_ID)).resolves.toMatchObject({ closeRequestedAt: 123n });
    expect(mpp.sweepTempoSessions).toBeUndefined();
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      CHANNEL_ID,
      expect.objectContaining({ feeToken: TOKEN })
    );
  });

  it("refuses a channel this DVM does not hold, without touching the chain", async () => {
    const { mpp, settle, getChannelStatesBatch } = await runtime({ state: null });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "unknown_channel",
      channelId: CHANNEL_ID,
    });
    expect(getChannelStatesBatch).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
  });

  it("reports a money incident when the channel finalized still owing us value", async () => {
    const { mpp, settle } = await runtime({
      chainState: { settled: 20n, deposit: 0n, closeRequestedAt: 0 },
    });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "finalized_before_protection",
      channelId: CHANNEL_ID,
      owed: 40n,
      settledOnChain: 20n,
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("treats a finalized channel that was fully settled as safe, not an incident", async () => {
    const { mpp } = await runtime({
      chainState: { settled: 60n, deposit: 0n, closeRequestedAt: 0 },
    });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "already_safe",
    });
  });

  it("retries rather than settling when chain state has not caught up with the event", async () => {
    // A verified CloseRequested log whose chain read still shows no close.
    // Settling here would breach the terminal-consumption rule on a channel
    // that may still have a cooperative path.
    const { mpp, settle } = await runtime({
      chainState: { settled: 20n, deposit: 100n, closeRequestedAt: 0 },
    });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "retryable_failure",
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("reports a failed chain read as retryable rather than throwing", async () => {
    const { mpp } = await runtime({
      getChannelStatesBatch: () => Promise.reject(new Error("rpc down")),
    });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "retryable_failure",
      channelId: CHANNEL_ID,
      error: "rpc down",
    });
  });
});

/**
 * the in-flight guard.
 *
 * The replay case above only covers a *post-confirmation* delivery, where the
 * chain read already shows the settled watermark. The window that actually
 * costs gas is the one before that: mppx's `settle` awaits its receipt for
 * longer than the platform's 30-second wake timeout, so the observer's retry
 * lands mid-confirmation, reads the same pre-settlement watermark, and — with
 * no guard — broadcasts a second transaction.
 */
describe("settlement in-flight guard", () => {
  it("holds its lease longer than the receipt wait it has to cover", () => {
    // mppx's `settle` awaits `waitForSuccessfulReceipt`, which passes no
    // `timeout` to viem's `waitForTransactionReceipt` and so inherits its
    // 180-second default. A lease under that lapses mid-broadcast and lets a
    // sibling machine — which the process-local marker cannot reach — send the
    // duplicate this guard exists to prevent.
    expect(TEMPO_SETTLEMENT_LEASE_MS).toBeGreaterThan(180_000);
  });

  it("declines a retry that arrives while the first settlement is confirming", async () => {
    const blocked = blockingSettle();
    const { mpp, settle } = await runtime({ settle: blocked.settle });

    const first = mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    await blocked.started;

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "retryable_failure",
      channelId: CHANNEL_ID,
      error: TEMPO_SETTLEMENT_IN_FLIGHT,
    });

    blocked.release();
    await expect(first).resolves.toMatchObject({ outcome: "settled" });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("declines a sibling machine's retry, off the channel row rather than process state", async () => {
    // Two runtimes over one store: no shared in-process state, exactly the way
    // two Fly machines behind the proxy see each other.
    const shared = Store.memory();
    await shared.put(CHANNEL_ID, channelState());
    const blocked = blockingSettle();
    const machineA = await runtime({ store: shared, settle: blocked.settle });
    const machineB = await runtime({ store: shared });

    const first = machineA.mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    await blocked.started;

    await expect(machineB.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "retryable_failure",
      channelId: CHANNEL_ID,
      error: TEMPO_SETTLEMENT_IN_FLIGHT,
    });

    blocked.release();
    await first;
    expect(machineA.settle).toHaveBeenCalledTimes(1);
    expect(machineB.settle).not.toHaveBeenCalled();
  });

  it("clears the lease on success, so the next delivery answers already_safe", async () => {
    // Leaving it to expire would answer 503 for the rest of the lease and keep
    // the observer retrying a close it has already protected.
    const shared = Store.memory();
    await shared.put(CHANNEL_ID, channelState());
    const first = await runtime({ store: shared });
    await expect(first.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "settled",
    });
    await expect(shared.get(CHANNEL_ID)).resolves.not.toHaveProperty(TEMPO_SETTLEMENT_LEASE_FIELD);

    // The watermark has caught up, as it has by the time the retry lands.
    const next = await runtime({
      store: shared,
      chainState: { settled: 60n, deposit: 100n, closeRequestedAt: 123 },
    });
    await expect(next.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "already_safe", channelId: CHANNEL_ID, settledOnChain: 60n,
    });
    expect(first.settle).toHaveBeenCalledTimes(1);
    expect(next.settle).not.toHaveBeenCalled();
  });

  it("holds the lease after a failed settlement rather than re-broadcasting at once", async () => {
    // A rejected gas estimate and a receipt timeout on a live transaction are
    // indistinguishable from here, so a failure leaves its lease to expire.
    const shared = Store.memory();
    await shared.put(CHANNEL_ID, channelState());
    const failing = await runtime({
      store: shared,
      settle: () => Promise.reject(new Error("nonce too low")),
    });
    await expect(failing.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "retryable_failure",
      error: "nonce too low",
    });

    const retry = await runtime({ store: shared });
    await expect(retry.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "retryable_failure",
      channelId: CHANNEL_ID,
      error: TEMPO_SETTLEMENT_IN_FLIGHT,
    });
    expect(retry.settle).not.toHaveBeenCalled();
  });

  it("lets a later attempt broadcast once the lease expires", async () => {
    // The lease is a bound on how long one dead machine can withhold
    // protection, not a permanent claim.
    const shared = Store.memory();
    await shared.put(CHANNEL_ID, channelState());
    const stalled = await runtime({
      store: shared,
      leaseMs: 0,
      settle: () => Promise.reject(new Error("machine died")),
    });
    await stalled.mpp.settleTempoSessionChannel?.(CHANNEL_ID);

    const later = await runtime({ store: shared, leaseMs: 0 });
    await expect(later.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "settled",
    });
    expect(later.settle).toHaveBeenCalledTimes(1);
  });

  it("does not wedge the settling process itself when a broadcast fails", async () => {
    // The durable lease outlives a failure on purpose; the process-local
    // marker has no expiry, so it must not — or this machine would refuse the
    // channel for the life of the process, long after every other machine's
    // answer has lapsed.
    let attempts = 0;
    const { mpp, settle } = await runtime({
      leaseMs: 0,
      settle: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("gas estimation reverted"))
          : Promise.resolve(`0x${"33".repeat(32)}` as const);
      },
    });

    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "retryable_failure",
      error: "gas estimation reverted",
    });
    await expect(mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "settled",
    });
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("keeps the sweep and the close-event path off one channel at once", async () => {
    const shared = Store.memory();
    const state = channelState({ spent: 60n });
    await shared.put(CHANNEL_ID, state);
    const blocked = blockingSettle();
    const sweeping = Object.assign(shared, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const closePath = await runtime({ store: sweeping, settle: blocked.settle });
    const sweepPath = await runtime({ store: sweeping });

    const first = closePath.mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    await blocked.started;

    await expect(sweepPath.mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 1,
      closeRequested: 1,
      settled: 0,
      inFlight: 1,
    });

    blocked.release();
    await first;
    expect(closePath.settle).toHaveBeenCalledTimes(1);
    expect(sweepPath.settle).not.toHaveBeenCalled();
  });
});
