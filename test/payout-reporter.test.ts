import { describe, expect, it, vi } from "vitest";

import {
  MemoryX402BatchStore,
  PayoutReporter,
  type PayoutPendingPayload,
  type PayoutTransport,
  type X402TrackedChannel,
  type X402TrackedManager,
} from "../src/sdk/server/payout-reporter";

const NATIVE = "1500000";

describe("x402 payout snapshots", () => {
  it.each([
    ["advancing", advancingClock],
    ["fixed", fixedClock],
  ])(
    "does not let a late pre-failure snapshot erase the failure with an %s clock",
    async (_clockName, makeClock) => {
      const harness = payoutHarness({
      now: makeClock(),
      blockListCall: 3,
      settlements: ["failure"]
    });

      await harness.tracked.claim();
      await harness.blockEntered;
      await expect(harness.tracked.settle()).rejects.toMatchObject({
        errorReason: "settle_transaction_failed",
      });

      // This explicit snapshot must be able to observe and deliver fresh
      // state while the claim-triggered pre-failure snapshot is still held.
      await harness.reporter.snapshotX402();
      expect(harness.transport.retained?.wedged).toEqual([
        expect.objectContaining({ kind: "settle", attempts: 1 }),
      ]);

      const oldDelivery = harness.transport.waitFor((payload) => payload.wedged.length === 0);
      harness.releaseBlocked();
      const old = await oldDelivery;

      expect(old.snapshotAt).toBeLessThan(harness.transport.retained?.snapshotAt ?? 0);
      expect(harness.transport.retained?.wedged).toEqual([
        expect.objectContaining({ kind: "settle", attempts: 1 }),
      ]);
    }
  );

  it.each([
    ["advancing", advancingClock],
    ["fixed", fixedClock],
  ])(
    "does not let a late failure snapshot restore a recovered failure with an %s clock",
    async (_clockName, makeClock) => {
      const harness = payoutHarness({
        now: makeClock(),
        blockListCall: 4,
        settlements: ["failure", "success"]
      });

      await harness.tracked.claim();
      await harness.transport.waitFor((payload) => payload.poolNative === Number(NATIVE));

      await expect(harness.tracked.settle()).rejects.toMatchObject({
        errorReason: "settle_transaction_failed",
      });
      await harness.blockEntered;

      await expect(harness.tracked.settle()).resolves.toEqual({ transaction: "0xsettled" });
      await harness.reporter.snapshotX402();
      expect(harness.transport.retained).toMatchObject({ poolNative: 0, wedged: [] });

      const failedDelivery = harness.transport.waitFor(
        (payload) => payload.wedged[0]?.kind === "settle"
      );
      harness.releaseBlocked();
      const failed = await failedDelivery;

      expect(failed.snapshotAt).toBeLessThan(harness.transport.retained?.snapshotAt ?? 0);
      expect(harness.transport.retained).toMatchObject({ poolNative: 0, wedged: [] });
    }
  );

  it("continues with a fresh snapshot after a delivery failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const channel: X402TrackedChannel = {
      channelId: "channel-1",
      chargedCumulativeAmount: "10",
      totalClaimed: "0"
    };
    const transport = new PlatformGuardTransport();
    transport.failuresRemaining = 1;
    const reporter = new PayoutReporter({
      dvmId: "dvm-test",
      transport,
      batchStore: new MemoryX402BatchStore(),
      now: fixedClock()
    });
    reporter.x402Observer().attach({
      scope: "eip155:8453|0xpayee|usdc",
      payTo: "0xpayee",
      network: "eip155:8453",
      storage: { list: () => Promise.resolve([{ ...channel }]) },
      earnedNative: () => Promise.resolve(Number(channel.chargedCumulativeAmount)),
      settleIntervalMs: 300_000
    });

    await reporter.snapshotX402();
    expect(transport.retained).toBeUndefined();

    channel.chargedCumulativeAmount = "20";
    await reporter.snapshotX402();

    expect(transport.retained).toMatchObject({ poolNative: 20, snapshotAt: 1001 });
    expect(transport.calls.map((payload) => payload.snapshotAt)).toEqual([1000, 1001]);
    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0][0]))).toEqual({
      event: "payout_pending_snapshot_failed",
      level: "warn",
      rail: "x402"
    });
    warning.mockRestore();
  });
});

function payoutHarness(opts: { now: () => number; blockListCall: number; settlements: ("failure" | "success")[] }): {
  reporter: PayoutReporter;
  tracked: X402TrackedManager;
  transport: PlatformGuardTransport;
  blockEntered: Promise<void>;
  releaseBlocked: () => void;
} {
  const channel: X402TrackedChannel = {
    channelId: "channel-1",
    chargedCumulativeAmount: NATIVE,
    totalClaimed: "0"
  };
  const blocked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let listCalls = 0;
  const transport = new PlatformGuardTransport();
  const reporter = new PayoutReporter({
    dvmId: "dvm-test",
    transport,
    batchStore: new MemoryX402BatchStore(),
    now: opts.now
  });
  const observer = reporter.x402Observer();
  observer.attach({
    scope: "eip155:8453|0xpayee|usdc",
    payTo: "0xpayee",
    network: "eip155:8453",
    storage: {
      async list() {
        listCalls += 1;
        if (listCalls === opts.blockListCall) {
          blocked.resolve();
          await released.promise;
        }
        return [{ ...channel }];
      }
    },
    earnedNative: () => Promise.resolve(Number(channel.chargedCumulativeAmount)),
    settleIntervalMs: 300_000
  });

  let settlement = 0;
  const manager: X402TrackedManager = {
    claim: async () => {
      channel.totalClaimed = channel.chargedCumulativeAmount;
      return [{ vouchers: 1, transaction: "0xclaimed" }];
    },
    settle: async () => {
      const outcome = opts.settlements[settlement++];
      if (outcome === "failure") {
        throw Object.assign(new Error("settlement failed"), {
          errorReason: "settle_transaction_failed"
        });
      }
      return { transaction: "0xsettled" };
    }
  };

  return {
    reporter,
    tracked: observer.trackManager(manager),
    transport,
    blockEntered: blocked.promise,
    releaseBlocked: () => released.resolve()
  };
}

class PlatformGuardTransport implements PayoutTransport {
  readonly calls: PayoutPendingPayload[] = [];
  retained: PayoutPendingPayload | undefined;
  failuresRemaining = 0;
  private readonly waiters: {
    predicate: (payload: PayoutPendingPayload) => boolean;
    resolve: (payload: PayoutPendingPayload) => void;
  }[] = [];

  enqueuePayout(): Promise<void> {
    return Promise.resolve();
  }

  reportPayout(): Promise<void> {
    return Promise.resolve();
  }

  reportPayoutPending(payload: PayoutPendingPayload): Promise<void> {
    const copy = structuredClone(payload);
    this.calls.push(copy);
    for (let index = this.waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.waiters[index];
      if (!waiter.predicate(copy)) continue;
      this.waiters.splice(index, 1);
      waiter.resolve(copy);
    }
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return Promise.reject(new Error("pending delivery failed"));
    }
    if (!this.retained || copy.snapshotAt >= this.retained.snapshotAt) {
      this.retained = copy;
    }
    return Promise.resolve();
  }

  waitFor(predicate: (payload: PayoutPendingPayload) => boolean): Promise<PayoutPendingPayload> {
    const existing = this.calls.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.push({ predicate, resolve }));
  }
}

function advancingClock(): () => number {
  let now = 1000;
  return () => now++;
}

function fixedClock(): () => number {
  return () => 1000;
}
