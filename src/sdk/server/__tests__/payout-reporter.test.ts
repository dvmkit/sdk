/* Stubbed transport and memory stores check landed movement reporting. SQL queue atomicity is separate. */
import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MemoryX402BatchStore,
  type PayoutPendingPayload,
  PayoutReporter,
  type PayoutReportPayload,
  type PayoutTransport,
  type X402TrackedChannel,
} from "../payout-reporter";

const DVM_ID = "dvm-payout-test";
const NOW = 1_756_800_000_000;

function stubTransport(): PayoutTransport & {
  payouts: PayoutReportPayload[];
  pending: PayoutPendingPayload[];
} {
  const payouts: PayoutReportPayload[] = [];
  const pending: PayoutPendingPayload[] = [];
  return {
    payouts,
    pending,
    enqueuePayout: vi.fn(async (p: PayoutReportPayload) => {
      payouts.push(p);
    }),
    reportPayout: vi.fn(async (p: PayoutReportPayload) => {
      payouts.push(p);
    }),
    reportPayoutPending: vi.fn(async (p: PayoutPendingPayload) => {
      pending.push(p);
    }),
    drainPending: vi.fn(async () => undefined),
  };
}

function reporter(transport = stubTransport(), now = () => NOW) {
  const r = new PayoutReporter({
    dvmId: DVM_ID,
    transport,
    batchStore: new MemoryX402BatchStore(),
    now,
  });
  return { r, transport };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("cashu melts", () => {
  it("reports one melt per mint with the face value melted and the preimage hash", async () => {
    const { r, transport } = reporter();
    await r.cashuMelted({
      rows: [
        { id: "r1", mintUrl: "https://mint.example", proofAmount: 1024 },
        { id: "r2", mintUrl: "https://mint.example", proofAmount: 1190 },
      ],
      meltQuoteId: "q_abc",
      paymentPreimage: "deadbeef",
    });
    await flush();
    expect(transport.pending).toEqual([]);
    expect(transport.payouts).toEqual([
      {
        dvmId: DVM_ID,
        payoutId: "cashu:melt:q_abc",
        rail: "cashu",
        kind: "melt",
        nativeAmount: 2214,
        nativeAsset: "sats",
        recipient: null,
        refs: {
          mint: "https://mint.example",
          meltQuoteId: "q_abc",
          preimageHash: createHash("sha256").update("deadbeef").digest("hex"),
          proofCount: 2,
        },
        landedAt: NOW,
      },
    ]);
  });

  it("splits a call that bundled two mints into two payouts with distinct ids", async () => {
    const { r, transport } = reporter();
    await r.cashuMelted({
      rows: [
        { id: "r1", mintUrl: "https://mint.example", proofAmount: 100 },
        { id: "r2", mintUrl: "https://mint2.example", proofAmount: 50 },
      ],
      meltQuoteId: "q_two",
      paymentPreimage: "00",
    });
    expect(transport.payouts.map((p) => [p.payoutId, p.nativeAmount, p.refs.mint])).toEqual([
      ["cashu:melt:q_two:0", 100, "https://mint.example"],
      ["cashu:melt:q_two:1", 50, "https://mint2.example"],
    ]);
  });

  it("queues the melt through the caller's transaction, so a failed outbox insert rolls the mark back with it", async () => {
    const { r, transport } = reporter();
    const tx = { query: vi.fn() };
    await r.cashuMelted(
      {
        rows: [{ id: "r1", mintUrl: "https://mint.example", proofAmount: 5 }],
        meltQuoteId: "q",
        paymentPreimage: "00",
      },
      tx
    );
    expect(transport.enqueuePayout).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: "cashu:melt:q", nativeAmount: 5 }),
      tx
    );
    // Inside a transaction nothing is delivered or snapshotted yet — that is
    // the hook's `committed` half.
    expect(transport.drainPending).not.toHaveBeenCalled();

    transport.enqueuePayout = vi.fn(async () => {
      throw new Error("outbox down");
    });
    await expect(
      r.cashuMelted(
        {
          rows: [{ id: "r1", mintUrl: "https://mint.example", proofAmount: 1 }],
          meltQuoteId: "q2",
          paymentPreimage: "00",
        },
        tx
      )
    ).rejects.toThrow("outbox down");
  });

  it("delivers the queued melt once the mark has committed", async () => {
    const { r, transport } = reporter();
    const hook = r.meltHook();
    await hook.enqueue(
      {
        rows: [{ id: "r1", mintUrl: "https://mint.example", proofAmount: 7 }],
        meltQuoteId: "q",
        paymentPreimage: "00",
      },
      { query: vi.fn() }
    );
    hook.committed();
    await flush();
    expect(transport.drainPending).toHaveBeenCalledTimes(1);
  });
});

describe("tempo settlements", () => {
  it("reports a cooperative close as `close` and a scheduled settlement as `settle`, keyed on the tx", async () => {
    const { r, transport } = reporter();
    r.attachTempo({ recipient: "0xrecipient", network: "eip155:4217" });
    await r.tempoSettled({
      txHash: "0xclose",
      channelId: "0xchan",
      trigger: "close",
      amount: 1_240_000n,
      delta: 1_240_000n,
    });
    await r.tempoSettled({
      txHash: "0xsettle",
      channelId: "0xchan2",
      trigger: "scheduled",
      amount: 3_000_000n,
      delta: 500_000n,
    });
    expect(transport.payouts).toEqual([
      expect.objectContaining({
        payoutId: "tempo:0xclose",
        rail: "tempo",
        kind: "close",
        nativeAmount: 1_240_000,
        nativeAsset: "usdc",
        recipient: "0xrecipient",
        refs: { channelId: "0xchan", txHash: "0xclose", trigger: "close", network: "eip155:4217" },
      }),
      expect.objectContaining({
        payoutId: "tempo:0xsettle",
        kind: "settle",
        nativeAmount: 500_000,
      }),
    ]);
    expect(transport.payouts[0]).not.toHaveProperty("repaired");
  });

  it("reports nothing for a transaction that paid the recipient nothing new — a channel exit or an already-settled close", async () => {
    const { r, transport } = reporter();
    await r.tempoSettled({
      txHash: "0xexit",
      channelId: "0xchan",
      trigger: "close",
      amount: 800_000n,
      delta: 0n,
    });
    expect(transport.payouts).toEqual([]);
  });

  it("reports a repaired close under the same id as the live close, flagged repaired", async () => {
    const { r, transport } = reporter();
    r.attachTempo({ recipient: "0xrecipient" });
    await r.tempoCloseReconciled({
      channelId: "0xchan",
      txHash: "0xclose",
      settledToPayee: "710000",
    });
    expect(transport.payouts).toEqual([
      expect.objectContaining({
        payoutId: "tempo:0xclose",
        kind: "close",
        nativeAmount: 710_000,
        repaired: true,
        repairKind: "tempo_close_reconciled",
      }),
    ]);
  });

  it("queues the repaired close through the booking's transaction and delivers on commit", async () => {
    const { r, transport } = reporter();
    const hook = r.tempoRepairHook();
    const tx = { query: vi.fn() };
    await hook.enqueue({ channelId: "0xchan", txHash: "0xclose", settledToPayee: "5" }, tx);
    expect(transport.enqueuePayout).toHaveBeenCalledWith(
      expect.objectContaining({ payoutId: "tempo:0xclose", repaired: true }),
      tx
    );
    hook.committed();
    await flush();
    expect(transport.drainPending).toHaveBeenCalledTimes(1);
  });

  it("snapshots earned-but-unsettled channel balances and the wedged closes past the age floor", async () => {
    const { r, transport } = reporter();
    r.attachTempo({
      recipient: "0xrecipient",
      listActive: async () => [
        {
          key: "c1",
          updatedAt: 1,
          state: { channelId: "0xc1", spent: "900000", settledOnChain: "400000" },
        },
        {
          key: "c2",
          updatedAt: 2,
          state: { channelId: "0xc2", spent: "100", settledOnChain: "100" },
        },
        {
          key: "c3",
          updatedAt: 3,
          state: { channelId: "0xc3", spent: "5", settledOnChain: "0", finalized: true },
        },
      ],
      listChannelDrains: async (args) => {
        expect(args).toEqual({ limit: 50, createdBeforeMs: NOW - 5 * 60_000, rail: "tempo" });
        return [
          {
            creditId: "c_tempo",
            drainId: "d_1",
            createdAt: NOW - 3_600_000,
            drainedNative: 250_000,
          } as never,
        ];
      },
    });
    await r.snapshotTempo();
    expect(transport.pending).toEqual([
      {
        dvmId: DVM_ID,
        rail: "tempo",
        poolNative: 500_000,
        nativeAsset: "usdc",
        items: 1,
        pools: [{ id: "0xc1", native: 500_000, label: "earned, awaiting settlement" }],
        wedged: [
          {
            id: "c_tempo:d_1",
            kind: "close",
            since: NOW - 3_600_000,
            attempts: null,
            nextRetry: null,
            lastError: null,
            native: 250_000,
          },
        ],
        snapshotAt: NOW,
      },
    ]);
  });
});

function channelStore(initial: X402TrackedChannel[]) {
  const channels = new Map(initial.map((c) => [c.channelId, { ...c }]));
  return {
    channels,
    list: async () => [...channels.values()].map((c) => ({ ...c })),

    claimAll(channelId: string) {
      const c = channels.get(channelId);
      if (c) c.totalClaimed = c.chargedCumulativeAmount;
    },
  };
}

function fakeManager(store: ReturnType<typeof channelStore>) {
  let settleError: Error | undefined;
  const manager = {
    claimed: [] as string[],
    /** Runs inside the claim, after the channels move — a concurrent refund's row delete. */
    onClaim: undefined as (() => void) | undefined,
    claim: vi.fn(async () => {
      const results: { vouchers: number; transaction: string }[] = [];
      for (const id of manager.claimed.splice(0)) {
        store.claimAll(id);
        results.push({ vouchers: 3, transaction: `0xclaim-${id}` });
      }
      manager.onClaim?.();
      return results;
    }),
    settle: vi.fn(async () => {
      if (settleError) throw settleError;
      return { transaction: "0xsettle" };
    }),
    refund: vi.fn(async () => [] as { channel: string; transaction: string }[]),
    stop: vi.fn(async () => undefined),
    failNextSettle(err: Error | undefined) {
      settleError = err;
    },
  };
  return manager;
}

describe("x402 batches", () => {
  // Every charge earned unless a test says otherwise, so the batch tests keep
  // their charged − claimed figures; the earned-ceiling tests pass their own.
  const fullyEarned = (store: ReturnType<typeof channelStore>) => async (id: string) => {
    const channel = [...store.channels.values()].find((c) => c.channelId.toLowerCase() === id);
    return channel ? Number(channel.chargedCumulativeAmount) : undefined;
  };
  const ctx = (
    store: ReturnType<typeof channelStore>,
    earnedNative: (channelId: string) => Promise<number | undefined> = fullyEarned(store)
  ) => ({
    scope: "eip155:84532|0xpayto|0xusdc",
    payTo: "0xpayto",
    network: "eip155:84532",
    storage: store,
    earnedNative,
    settleIntervalMs: 300_000,
  });

  it("reports a channel's earned, unclaimed value as pending — never its unspent deposit", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xC1aB", chargedCumulativeAmount: "1000000", totalClaimed: "250000" },
    ]);
    // Keyed by the lowercased id, the form the ledger bound the credit under.
    const earned = new Map([["0xc1ab", 600_000]]);
    r.x402Observer().attach(ctx(store, async (id) => earned.get(id)));
    await r.snapshotX402();
    expect(transport.pending.at(-1)).toMatchObject({
      rail: "x402",
      poolNative: 350_000,
      items: 1,
      pools: [{ id: "0xC1aB", native: 350_000, label: "earned, awaiting claim" }],
    });
  });

  it("reports nothing pending for a channel claimed up to everything it earned", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xd1", chargedCumulativeAmount: "109000", totalClaimed: "12000" },
    ]);
    r.x402Observer().attach(ctx(store, async () => 12_000));
    await r.snapshotX402();
    expect(transport.pending.at(-1)).toMatchObject({ poolNative: 0, items: 0, pools: [] });
  });

  it("never reports more than the payer authorized when the ledger says more was earned", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xe1", chargedCumulativeAmount: "100000", totalClaimed: "20000" },
    ]);
    r.x402Observer().attach(ctx(store, async () => 150_000));
    await r.snapshotX402();
    expect(transport.pending.at(-1)).toMatchObject({
      poolNative: 80_000,
      pools: [{ id: "0xe1", native: 80_000, label: "earned, awaiting claim" }],
    });
  });

  it("leaves out a channel with no bound credit or a failed ledger read and reports the rest", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { r, transport } = reporter();
      const store = channelStore([
        { channelId: "0xunbound", chargedCumulativeAmount: "900000", totalClaimed: "0" },
        { channelId: "0xbroken", chargedCumulativeAmount: "800000", totalClaimed: "0" },
        { channelId: "0xok", chargedCumulativeAmount: "700000", totalClaimed: "100000" },
      ]);
      r.x402Observer().attach(
        ctx(store, async (id) => {
          if (id === "0xbroken") throw new Error("ledger unavailable");
          return id === "0xok" ? 500_000 : undefined;
        })
      );
      await r.snapshotX402();
      expect(transport.pending.at(-1)).toMatchObject({
        poolNative: 400_000,
        pools: [{ id: "0xok", native: 400_000, label: "earned, awaiting claim" }],
      });
      expect(warning).toHaveBeenCalledOnce();
      expect(JSON.parse(String(warning.mock.calls[0][0]))).toMatchObject({
        event: "payout_pending_snapshot_failed",
        rail: "x402",
      });
    } finally {
      warning.mockRestore();
    }
  });

  it("gathers what each claim moved into one batch and reports it when the settle lands", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "1500000", totalClaimed: "0" },
      { channelId: "0xb", chargedCumulativeAmount: "2600000", totalClaimed: "1000000" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);

    manager.claimed.push("0xa");
    await tracked.claim();
    manager.claimed.push("0xb");
    await tracked.claim();
    expect(transport.payouts).toEqual([]);

    await tracked.settle();
    expect(transport.payouts).toHaveLength(1);
    const batch = transport.payouts[0];
    expect(batch).toEqual(
      expect.objectContaining({
        dvmId: DVM_ID,
        rail: "x402",
        kind: "batch",
        nativeAmount: 1_500_000 + 1_600_000,
        nativeAsset: "usdc",
        recipient: "0xpayto",
        landedAt: NOW,
      })
    );
    expect(batch.payoutId).toMatch(/^x402:batch:[0-9a-f-]{36}$/);
    expect(batch.refs).toEqual({
      batchId: batch.payoutId.slice("x402:batch:".length),
      txHash: "0xsettle",
      voucherCount: 6,
      claims: 2,
      network: "eip155:84532",
    });

    await tracked.settle();
    expect(transport.payouts).toHaveLength(1);
  });

  it("keeps the batch when the outbox insert fails, and reports it whole on the next settle", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "700000", totalClaimed: "0" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xa");
    await tracked.claim();

    transport.enqueuePayout = vi.fn(async () => {
      throw new Error("outbox down");
    });
    // Reporting failure must leave the landed settlement successful and its batch retryable.
    await expect(tracked.settle()).resolves.toEqual({ transaction: "0xsettle" });
    expect(transport.payouts).toEqual([]);
    expect(transport.drainPending).not.toHaveBeenCalled();

    transport.enqueuePayout = vi.fn(async (p: PayoutReportPayload) => {
      transport.payouts.push(p);
    });
    await tracked.settle();
    expect(transport.payouts).toHaveLength(1);
    expect(transport.payouts[0].nativeAmount).toBe(700_000);
    await flush();
    expect(transport.drainPending).toHaveBeenCalledTimes(1);
  });

  it("counts what a channel the claim removed still owed, at its pre-claim figure", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "1000000", totalClaimed: "0" },
      { channelId: "0xgone", chargedCumulativeAmount: "300000", totalClaimed: "100000" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xa");
    manager.onClaim = () => store.channels.delete("0xgone");
    await tracked.claim();
    await tracked.settle();
    expect(transport.payouts[0].nativeAmount).toBe(1_000_000 + 200_000);
  });

  it("records a settle made outside the tracked manager once per attempt", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "50", totalClaimed: "0" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xa");
    await tracked.claim();
    await observer.recordSettleFailure(new Error("nothing to settle yet"));
    await flush();
    expect(transport.pending.at(-1)?.wedged[0]).toMatchObject({ kind: "settle", attempts: 1 });
    await observer.recordSettle("0xmanual");
    expect(transport.payouts).toEqual([
      expect.objectContaining({
        nativeAmount: 50,
        refs: expect.objectContaining({ txHash: "0xmanual" }),
      }),
    ]);
  });

  it("never lets a snapshot exceed the pool cap, open batch included", async () => {
    const { r, transport } = reporter();
    const many = Array.from({ length: 60 }, (_, i) => ({
      channelId: `0xc${i}`,
      chargedCumulativeAmount: String(1_000 + i),
      totalClaimed: "0",
    }));
    const store = channelStore([
      { channelId: "0xopen", chargedCumulativeAmount: "5000", totalClaimed: "0" },
      ...many,
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xopen");
    await tracked.claim();
    await r.snapshotX402();
    const snapshot = transport.pending.at(-1);
    expect(snapshot?.items).toBe(50);
    expect(snapshot?.pools).toHaveLength(50);
    expect(snapshot?.pools[0]).toMatchObject({ native: 5000, label: "claimed, awaiting settle" });
    expect(snapshot?.pools.at(-1)).toMatchObject({ id: "other", label: "12 more" });
    expect(snapshot?.poolNative).toBe(
      5000 + many.reduce((sum, c) => sum + Number(c.chargedCumulativeAmount), 0)
    );
  });

  it("keeps the manager's other verbs reachable through the tracker", async () => {
    const { r } = reporter();
    const store = channelStore([]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    await expect(tracked.refund()).resolves.toEqual([]);
    expect(manager.refund).toHaveBeenCalledTimes(1);
    await tracked.stop();
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("turns a settle that keeps failing into a wedge — retries counted, next retry named, no row", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "2100000", totalClaimed: "0" },
      { channelId: "0xc", chargedCumulativeAmount: "1740000", totalClaimed: "0" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach({
      ...ctx(store),
      listWedgedRefunds: async () => [
        { settlementId: "s_wedged", createdAt: NOW - 7_200_000, native: 400_000 },
      ],
    });
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xa");
    await tracked.claim();

    const failure = Object.assign(new Error("boom https://rpc.secret/key"), {
      errorReason: "settle_transaction_failed",
    });
    manager.failNextSettle(failure);
    await expect(tracked.settle()).rejects.toBe(failure);
    await expect(tracked.settle()).rejects.toBe(failure);
    await flush();

    expect(transport.payouts).toEqual([]);
    const last = transport.pending.at(-1);
    expect(last).toBeDefined();
    if (!last) return;
    expect(last.rail).toBe("x402");
    expect(last.poolNative).toBe(2_100_000 + 1_740_000);
    expect(last.items).toBe(2);
    expect(last.pools).toEqual([
      expect.objectContaining({ native: 2_100_000, label: "claimed, awaiting settle" }),
      { id: "0xc", native: 1_740_000, label: "earned, awaiting claim" },
    ]);
    expect(last.wedged).toEqual([
      expect.objectContaining({
        kind: "settle",
        since: NOW,
        attempts: 2,
        nextRetry: NOW + 300_000,
        lastError: "settle_transaction_failed",
        native: 2_100_000,
      }),
      {
        id: "s_wedged",
        kind: "refund",
        since: NOW - 7_200_000,
        attempts: null,
        nextRetry: null,
        lastError: null,
        native: 400_000,
      },
    ]);

    manager.failNextSettle(undefined);
    await tracked.settle();
    await flush();
    expect(transport.payouts).toHaveLength(1);
    expect(transport.payouts[0].nativeAmount).toBe(2_100_000);
    expect(transport.pending.at(-1)?.wedged).toEqual([
      expect.objectContaining({ id: "s_wedged", kind: "refund" }),
    ]);
  });

  it("names a settle failure by its class, never by a message that could quote an RPC URL", async () => {
    const { r, transport } = reporter();
    const store = channelStore([
      { channelId: "0xa", chargedCumulativeAmount: "10", totalClaimed: "0" },
    ]);
    const manager = fakeManager(store);
    const observer = r.x402Observer();
    observer.attach(ctx(store));
    const tracked = observer.trackManager(manager);
    manager.claimed.push("0xa");
    await tracked.claim();
    manager.failNextSettle(new TypeError("fetch failed: https://rpc.secret/key?token=1 refused"));
    await tracked.settle().catch(() => undefined);
    await flush();
    const wedge = transport.pending.at(-1)?.wedged[0];
    expect(wedge?.lastError).toBe("TypeError: fetch failed: <url> refused");
    expect(wedge?.lastError).not.toContain("secret");
  });

});

describe("the snapshot loop", () => {
  it("starts and stops idempotently without keeping the process alive", () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const interval = vi.spyOn(globalThis, "setInterval");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    const { r } = reporter();
    try {
      r.start();
      r.start();
      expect(timeout).toHaveBeenCalledTimes(1);
      expect(interval).toHaveBeenCalledTimes(1);
      const warmup = timeout.mock.results[0].value as NodeJS.Timeout;
      const timer = interval.mock.results[0].value as NodeJS.Timeout;
      expect(warmup.hasRef()).toBe(false);
      expect(timer.hasRef()).toBe(false);
      r.stop();
      r.stop();
      expect(clearTimeoutSpy).toHaveBeenCalledExactlyOnceWith(warmup);
      expect(clearIntervalSpy).toHaveBeenCalledExactlyOnceWith(timer);
    } finally {
      r.stop();
      timeout.mockRestore();
      interval.mockRestore();
      clearTimeoutSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("snapshots every attached rail and none that is not", async () => {
    const { r, transport } = reporter();
    await r.snapshot();
    expect(transport.pending).toEqual([]);
    r.attachTempo({ listActive: async () => [] });
    await r.snapshot();
    expect(transport.pending.map((p) => p.rail)).toEqual(["tempo"]);
  });
});
