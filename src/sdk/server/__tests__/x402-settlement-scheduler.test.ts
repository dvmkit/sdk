/**
 * The Postgres branch of the batch-settlement server runs this scheduler in
 * place of upstream's `manager.start()`. Two properties it must keep: an idle
 * receiver never submits a settlement (gas, and a facilitator error every
 * interval), and every field of the builder's `autoSettlement` config means the
 * same thing here as it does on the in-memory branch.
 */
import type { Channel, ChannelStorage } from "@x402/evm/batch-settlement/server";
import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createX402FleetSettlementScheduler,
  type X402ChannelManagerLike,
  type X402SettlePendingMarker,
} from "../x402-settlement-scheduler";

class FakeManager implements X402ChannelManagerLike {
  claimable = 0;
  settleError: Error | undefined;

  readonly claim = vi.fn(async () =>
    this.claimable > 0 ? [{ vouchers: this.claimable, transaction: "0xclaim" }] : []
  );

  readonly settle = vi.fn(async () => {
    if (this.settleError) throw this.settleError;
    return { transaction: "0xsettle" };
  });

  readonly refund = vi.fn(async (channelIds?: string[]) =>
    (channelIds ?? []).map((channel) => ({ channel, transaction: "0xrefund" }))
  );
}

function memoryMarker(initial = false): X402SettlePendingMarker & { pending: boolean } {
  return {
    pending: initial,
    async read() {
      return this.pending;
    },
    async write(pending: boolean) {
      this.pending = pending;
    },
  };
}

function channel(channelId: string, overrides: Partial<Channel> = {}): Channel {
  return {
    channelId,
    channelConfig: {
      payer: `0x${"11".repeat(20)}`,
      payerAuthorizer: `0x${"11".repeat(20)}`,
      receiver: `0x${"22".repeat(20)}`,
      receiverAuthorizer: `0x${"22".repeat(20)}`,
      token: `0x${"33".repeat(20)}`,
      withdrawDelay: 86_400,
      salt: `0x${"44".repeat(32)}`,
    },
    chargedCumulativeAmount: "100",
    signedMaxClaimable: "100",
    signature: "0xsig",
    balance: "1000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
    ...overrides,
  };
}

async function storageWith(channels: Channel[]): Promise<ChannelStorage> {
  const storage = new InMemoryChannelStorage();
  for (const entry of channels) await storage.updateChannel(entry.channelId, () => entry);
  return storage;
}

/** Fire every timer and let the queued jobs drain. */
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => Promise.resolve());
  }
}

describe("x402 fleet settlement scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never settles for an idle receiver, and settles once a claim lands", async () => {
    const manager = new FakeManager();
    const marker = memoryMarker();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: new InMemoryChannelStorage(),
      config: { claimIntervalSecs: 1, settleIntervalSecs: 1 },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker,
    });

    await tick(3);
    expect(manager.claim).toHaveBeenCalledTimes(3);
    expect(manager.settle).not.toHaveBeenCalled();

    manager.claimable = 2;
    await tick(1);
    expect(marker.pending).toBe(false);
    expect(manager.settle).toHaveBeenCalledTimes(1);

    manager.claimable = 0;
    await tick(2);
    expect(manager.settle).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("settles a marker another machine left behind, and keeps it after a failed settle", async () => {
    const manager = new FakeManager();
    manager.settleError = new Error("facilitator down");
    const marker = memoryMarker(true);
    const onError = vi.fn();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: new InMemoryChannelStorage(),
      config: { settleIntervalSecs: 1, onError },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker,
    });

    await tick(1);
    expect(manager.claim).not.toHaveBeenCalled();
    expect(manager.settle).toHaveBeenCalledTimes(1);
    expect(marker.pending).toBe(true);
    expect(onError).toHaveBeenCalledWith(manager.settleError);

    manager.settleError = undefined;
    await tick(1);
    expect(marker.pending).toBe(false);
    scheduler.stop();
  });

  it("honours selectClaimChannels, shouldSettle, and the claim and settle hooks", async () => {
    const manager = new FakeManager();
    manager.claimable = 1;
    const marker = memoryMarker();
    const selectClaimChannels = vi.fn((channels: Channel[]) => channels);
    const shouldSettle = vi.fn(() => false);
    const onClaim = vi.fn();
    const onSettle = vi.fn();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: new InMemoryChannelStorage(),
      config: {
        claimIntervalSecs: 1,
        settleIntervalSecs: 1,
        maxClaimsPerBatch: 7,
        selectClaimChannels,
        shouldSettle,
        onClaim,
        onSettle,
      },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker,
    });

    await tick(1);
    expect(manager.claim).toHaveBeenCalledWith({
      maxClaimsPerBatch: 7,
      selectClaimChannels,
    });
    expect(onClaim).toHaveBeenCalledWith({ vouchers: 1, transaction: "0xclaim" });
    expect(shouldSettle).toHaveBeenCalledWith(expect.objectContaining({ pendingSettle: true }));
    expect(manager.settle).not.toHaveBeenCalled();
    expect(onSettle).not.toHaveBeenCalled();
    expect(marker.pending).toBe(true);
    scheduler.stop();
  });

  it("runs the refund job only when the builder selects channels for it", async () => {
    const manager = new FakeManager();
    const storage = await storageWith([
      channel(`0x${"ab".repeat(32)}`),
      channel(`0x${"cd".repeat(32)}`),
    ]);
    const onRefund = vi.fn();
    const bare = createX402FleetSettlementScheduler({
      manager,
      storage,
      config: { refundIntervalSecs: 1 },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker: memoryMarker(),
    });
    await tick(1);
    expect(manager.refund).not.toHaveBeenCalled();
    bare.stop();

    const marker = memoryMarker();
    const configured = createX402FleetSettlementScheduler({
      manager,
      storage,
      config: {
        refundIntervalSecs: 1,
        selectRefundChannels: (channels) => channels.slice(0, 1),
        onRefund,
      },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker,
    });
    await tick(1);
    expect(manager.refund).toHaveBeenCalledWith([`0x${"ab".repeat(32)}`]);
    expect(onRefund).toHaveBeenCalledWith({
      channel: `0x${"ab".repeat(32)}`,
      transaction: "0xrefund",
    });
    // That channel still owed a voucher, so the refund claimed it on-chain and
    // deleted the row — nothing else will ever raise the marker for it.
    expect(marker.pending).toBe(true);
    configured.stop();
  });

  it("raises the marker only for refunds that carried an on-chain claim", async () => {
    const manager = new FakeManager();
    const settled = channel(`0x${"ef".repeat(32)}`, {
      chargedCumulativeAmount: "100",
      totalClaimed: "100",
    });
    const owing = channel(`0x${"ab".repeat(32)}`);
    const marker = memoryMarker();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: await storageWith([settled, owing]),
      config: {
        refundIntervalSecs: 1,
        selectRefundChannels: (channels) =>
          channels.filter((entry) => entry.channelId === settled.channelId),
      },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker,
    });

    await tick(1);
    expect(manager.refund).toHaveBeenCalledWith([settled.channelId]);
    // Nothing was claimed, so a marker here would schedule a settle with no
    // funds to move — the every-interval revert this scheduler exists to end.
    expect(marker.pending).toBe(false);
    scheduler.stop();
  });

  it("skips a tick another machine holds the fleet lock for", async () => {
    const manager = new FakeManager();
    manager.claimable = 1;
    const marker = memoryMarker();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: new InMemoryChannelStorage(),
      config: { claimIntervalSecs: 1, settleIntervalSecs: 1 },
      withLock: async () => false,
      marker,
    });

    await tick(2);
    expect(manager.claim).not.toHaveBeenCalled();
    expect(manager.settle).not.toHaveBeenCalled();
    expect(marker.pending).toBe(false);
    scheduler.stop();
  });

  it("stops scheduling once stopped", async () => {
    const manager = new FakeManager();
    const scheduler = createX402FleetSettlementScheduler({
      manager,
      storage: new InMemoryChannelStorage(),
      config: { claimIntervalSecs: 1 },
      withLock: async (operation) => {
        await operation();
        return true;
      },
      marker: memoryMarker(),
    });
    await tick(1);
    expect(manager.claim).toHaveBeenCalledTimes(1);
    scheduler.stop();
    await tick(3);
    expect(manager.claim).toHaveBeenCalledTimes(1);
  });
});
