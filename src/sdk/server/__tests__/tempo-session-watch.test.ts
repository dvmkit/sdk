import { Store } from "mppx";
import { BaseError, InsufficientFundsError } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";

import type { CreditLedgerQuerier } from "../credit-ledger";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { _testing } from "../mpp-setup";

const CHANNEL_ID = `0x${"11".repeat(32)}` as `0x${string}`;
const ESCROW = `0x${"22".repeat(20)}` as `0x${string}`;
const TOKEN = `0x${"44".repeat(20)}` as `0x${string}`;

describe("Tempo close watcher", () => {
  it("terminalizes the bound credit before persisting a finalized channel", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 1n,
      deposit: 100_000n,
      finalized: false,
      highestVoucherAmount: 3_000n,
      spent: 3_000n,
      settledOnChain: 0n,
      createdAt: new Date().toISOString(),
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const ledger = new MemoryCreditLedger();
    const credit = await ledger.fund({
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "100000" },
      },
    });
    await ledger.draw({ creditId: credit.creditId, drawId: "served", amountMicro: 3_000 });
    await ledger.settle({ creditId: credit.creditId, drawId: "served" });
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
      },
      {
        getChannelStatesBatch: () =>
          Promise.resolve([{ settled: 0n, deposit: 0n, closeRequestedAt: 0 }]),
      }
    );
    mpp.useTempoCreditLedger?.(ledger);

    await expect(mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 1,
      closeRequested: 0,
      settled: 0,
      inFlight: 0,
    });
    expect(await ledger.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 97_000,
      availableMicro: 0,
    });
    expect(await ledger.listTempoCreditLosses()).toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        channelId: CHANNEL_ID,
        settledOnChainNative: 0n,
        highestVoucherNative: 3_000n,
        consumedServiceMicro: 3_000,
        consumedNative: 3_000n,
      }),
    ]);
  });

  it("batch-detects a unilateral close and settles its outstanding voucher", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 0n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 60n,
      settledOnChain: 20n,
      createdAt: new Date().toISOString(),
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const getChannelStatesBatch = vi.fn(() =>
      Promise.resolve([{ settled: 20n, deposit: 100n, closeRequestedAt: 123 }])
    );
    const settle = vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`));
    const account = privateKeyToAccount(generatePrivateKey());
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account,
        getClient: () => Promise.resolve({} as never),
        settlementSchedule: { intervalMs: 24 * 60 * 60 * 1_000 },
      },
      { getChannelStatesBatch, settle }
    );

    await expect(mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 1,
      closeRequested: 1,
      settled: 1,
      inFlight: 0,
    });
    expect(getChannelStatesBatch).toHaveBeenCalledWith({}, [CHANNEL_ID], ESCROW);
    expect(settle).toHaveBeenCalledWith(
      store,
      {},
      CHANNEL_ID,
      expect.objectContaining({ account, escrowContract: ESCROW, feeToken: TOKEN })
    );
    await expect(memory.get(CHANNEL_ID)).resolves.toMatchObject({ closeRequestedAt: 123n });
  });

  it("reports an immediate redacted failure when settlement cannot fund fees", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 4217,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 0n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 60n,
      settledOnChain: 20n,
      createdAt: new Date(0).toISOString(),
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const onInsufficientFunds = vi.fn().mockResolvedValue(undefined);
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
        settlementSchedule: { intervalMs: 1 },
        onInsufficientFunds,
      },
      {
        getChannelStatesBatch: () =>
          Promise.resolve([{ settled: 20n, deposit: 100n, closeRequestedAt: 123 }]),
        settle: () =>
          Promise.reject(
            new BaseError("Tempo settlement failed", {
              cause: new InsufficientFundsError(),
            })
          ),
      }
    );

    await expect(mpp.sweepTempoSessions?.()).rejects.toBeInstanceOf(BaseError);
    expect(onInsufficientFunds).toHaveBeenCalledWith({
      operation: "settle",
      channelId: CHANNEL_ID,
    });
  });

  it("pages and batches every active channel in one sweep", async () => {
    const memory = Store.memory();
    const rows = await Promise.all(
      Array.from({ length: 101 }, async (_, index) => {
        const channelId = `0x${index.toString(16).padStart(64, "0")}` as `0x${string}`;
        const state = {
          channelId,
          chainId: 42431,
          escrowContract: ESCROW,
          token: TOKEN,
          closeRequestedAt: 0n,
          deposit: 100n,
          finalized: false,
          highestVoucherAmount: 0n,
          spent: 0n,
          settledOnChain: 0n,
          createdAt: new Date().toISOString(),
        };
        await memory.put(channelId, state);
        return { key: channelId, state, updatedAt: index };
      })
    );
    const listActive = vi.fn((_limit = 100, cursor?: { updatedAt: number; key: string }) => {
      const start = cursor ? rows.findIndex((row) => row.key === cursor.key) + 1 : 0;
      return Promise.resolve(rows.slice(start, start + 100));
    });
    const store = Object.assign(memory, { listActive });
    const getChannelStatesBatch = vi.fn((_client, channelIds: readonly `0x${string}`[]) =>
      Promise.resolve(channelIds.map(() => ({ settled: 0n, deposit: 0n, closeRequestedAt: 0 })))
    );
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
      },
      {
        getChannelStatesBatch,
        settle: vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`)),
      }
    );

    await expect(mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 101,
      closeRequested: 0,
      settled: 0,
      inFlight: 0,
    });
    expect(listActive).toHaveBeenCalledTimes(2);
    expect(getChannelStatesBatch).toHaveBeenCalledTimes(2);
    expect(getChannelStatesBatch.mock.calls.flatMap((call) => call[1])).toHaveLength(101);
  });

  it("recovers a confirmed close from durable intent and terminal chain state", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 1n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 60n,
      settledOnChain: 20n,
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    let intent: { channelId: string; drainId: string; reference: string | null } | null = null;
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([]),
      beginClose: (channelId: string, drainId: string) => {
        intent = { channelId, drainId, reference: null };
        return Promise.resolve(intent);
      },
      withCloseIntent: async <value>(
        channelId: string,
        drainId: string,
        operation: (tx: CreditLedgerQuerier) => Promise<value>
      ) => {
        intent = { channelId, drainId, reference: null };
        return operation({} as CreditLedgerQuerier);
      },
      releaseCloseIntent: async <value>(
        channelId: string,
        drainId: string,
        operation: (tx: CreditLedgerQuerier) => Promise<value>
      ) => {
        if (intent?.channelId === channelId && intent.drainId === drainId) intent = null;
        return operation({} as CreditLedgerQuerier);
      },
      getClose: () => Promise.resolve(intent),
      confirmClose: (channelId: string, drainId: string, reference: string) => {
        intent = { channelId, drainId, reference };
        return Promise.resolve(intent);
      },
    });
    const getChannelStatesBatch = vi.fn(() =>
      Promise.resolve([{ settled: 60n, deposit: 0n, closeRequestedAt: 0 }])
    );
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
      },
      {
        getChannelStatesBatch,
        settle: vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`)),
      }
    );

    await expect(
      mpp.withTempoSessionCloseIntent?.(CHANNEL_ID, "drain-1", () => Promise.resolve("reserved"))
    ).resolves.toBe("reserved");
    await expect(mpp.recoverTempoSessionClose?.(CHANNEL_ID, "drain-1")).resolves.toBe(
      `channel:${CHANNEL_ID}`
    );
    await expect(mpp.recoverTempoSessionClose?.(CHANNEL_ID, "drain-1")).resolves.toBe(
      `channel:${CHANNEL_ID}`
    );
    expect(getChannelStatesBatch).toHaveBeenCalledTimes(1);
    await expect(
      mpp.releaseTempoSessionCloseIntent?.(CHANNEL_ID, "drain-1", () => Promise.resolve("released"))
    ).resolves.toBe("released");
    expect(intent).toBeNull();
  });

  it("settles accepted funding during forced close while unspent value remains ledger-backed", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 0n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 20n,
      settledOnChain: 0n,
      createdAt: new Date().toISOString(),
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const settle = vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`));
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
      },
      {
        getChannelStatesBatch: () =>
          Promise.resolve([{ settled: 0n, deposit: 100n, closeRequestedAt: 123 }]),
        settle,
      }
    );

    await expect(mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 1,
      closeRequested: 1,
      settled: 1,
      inFlight: 0,
    });
    expect(settle).toHaveBeenCalledWith(
      store,
      {},
      CHANNEL_ID,
      expect.objectContaining({ escrowContract: ESCROW, feeToken: TOKEN })
    );
  });

  it("does not settle partial consumption on routine cadence before cooperative close", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 0n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 20n,
      settledOnChain: 0n,
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, {
      listActive: () => Promise.resolve([{ key: CHANNEL_ID, state, updatedAt: 1 }]),
    });
    const settle = vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`));
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
        settlementSchedule: { intervalMs: 1_000 },
      },
      {
        getChannelStatesBatch: () =>
          Promise.resolve([{ settled: 0n, deposit: 100n, closeRequestedAt: 0 }]),
        settle,
      }
    );

    await expect(mpp.sweepTempoSessions?.()).resolves.toEqual({
      scanned: 1,
      closeRequested: 0,
      settled: 0,
      inFlight: 0,
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it("reconciles a reverted close timestamp back to chain truth", async () => {
    const state = {
      channelId: CHANNEL_ID,
      chainId: 42431,
      escrowContract: ESCROW,
      token: TOKEN,
      closeRequestedAt: 999n,
      deposit: 100n,
      finalized: false,
      highestVoucherAmount: 60n,
      spent: 20n,
      settledOnChain: 10n,
    };
    const memory = Store.memory();
    await memory.put(CHANNEL_ID, state);
    const store = Object.assign(memory, { listActive: () => Promise.resolve([]) });
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as never),
      },
      {
        getChannelStatesBatch: () =>
          Promise.resolve([{ settled: 10n, deposit: 100n, closeRequestedAt: 0 }]),
        settle: vi.fn(() => Promise.resolve(`0x${"33".repeat(32)}` as `0x${string}`)),
      }
    );

    await expect(mpp.getTempoSessionDrainState?.(CHANNEL_ID)).resolves.toEqual({
      spent: 20n,
      settledOnChain: 10n,
      closeRequestedAt: 0n,
      deposit: 100n,
      finalized: false,
    });
    await expect(memory.get(CHANNEL_ID)).resolves.toMatchObject({ closeRequestedAt: 0n });
  });
});
