import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { describe, expect, it, vi } from "vitest";

import { MemoryX402BatchStore } from "../payout-reporter";
import { claimRecoveryFixture, SCOPE } from "./__helpers__/x402-claim-recovery";

describe("explicit multi-batch claim recovery", () => {
  it.each(["rejected", "timeout"])("keeps the first batch's payout after a later %s", async (failure) => {
    const storage = new InMemoryChannelStorage();
    const batches = new MemoryX402BatchStore();
    const f = await claimRecoveryFixture(storage, batches, 101);
    const server = await f.createServer();
    if (failure === "timeout") f.timeOutClaims();
    try {
      await expect(server.claimAndSettle()).rejects.toThrow(failure);
      expect((await storage.list()).filter((channel) => channel.totalClaimed === "40")).toHaveLength(100);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 3000n, voucherCount: 100, claims: 1 });

      // Retrying the failed batch must not book the confirmed batch again.
      await expect(server.claimAndSettle()).rejects.toThrow(failure);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 3000n, voucherCount: 100, claims: 1 });
      f.allowClaims();
      await server.claimAndSettle();
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
      expect(f.transport.enqueuePayout).toHaveBeenCalledWith(expect.objectContaining({
        nativeAmount: 3030, refs: expect.objectContaining({ voucherCount: 101, claims: 2 }),
      }), undefined);
      await server.claimAndSettle();
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
    } finally {
      f.earned.clear();
      await server.stop();
    }
  });
});

describe("scheduled multi-batch claims with custom storage", () => {
  it.each(["rejected", "timeout"])("transfers the confirmed batch after a later %s without another successful claim", async (failure) => {
    const storage = new InMemoryChannelStorage();
    const batches = new MemoryX402BatchStore();
    const f = await claimRecoveryFixture(storage, batches, 3);
    const deferredChannel = f.channels[2].channelId;
    f.earned.delete(deferredChannel);
    const onError = vi.fn();
    const onSettle = vi.fn();
    const shouldSettle = vi.fn(() => true);
    vi.useFakeTimers();
    const server = await f.createServer(storage, {
      maxClaimsPerBatch: 1, claimIntervalSecs: 1, settleIntervalSecs: 10,
      onError, onSettle, shouldSettle,
    });
    if (failure === "timeout") f.timeOutClaims();
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining(failure) }));
      expect((await storage.list()).filter((channel) => channel.totalClaimed === "40")).toHaveLength(1);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 30n, voucherCount: 1, claims: 1 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 30n, voucherCount: 1, claims: 1 });

      await vi.advanceTimersByTimeAsync(8000);
      expect(f.transport.enqueuePayout).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        nativeAmount: 30, refs: expect.objectContaining({ voucherCount: 1, claims: 1 }),
      }), undefined);
      expect(await batches.get(SCOPE)).toBeUndefined();
      expect(onSettle).toHaveBeenCalledTimes(1);
      expect(shouldSettle).toHaveBeenCalledWith(expect.objectContaining({ pendingSettle: true }));
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
      expect(onSettle).toHaveBeenCalledTimes(1);

      f.allowClaims();
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(2);
      expect(f.transport.enqueuePayout).toHaveBeenLastCalledWith(expect.objectContaining({
        nativeAmount: 30, refs: expect.objectContaining({ voucherCount: 1, claims: 1 }),
      }), undefined);
      expect(onSettle).toHaveBeenCalledTimes(2);
      await server.stop();
      const submissions = vi.mocked(f.facilitator.settle).mock.calls.length;
      f.earned.add(deferredChannel);
      await vi.advanceTimersByTimeAsync(10000);
      expect(f.facilitator.settle).toHaveBeenCalledTimes(submissions);
    } finally {
      f.earned.clear();
      await server.stop();
      vi.useRealTimers();
    }
  });
});
