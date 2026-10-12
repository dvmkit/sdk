import { BaseError, InsufficientFundsError } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTempoInsufficientFundsError,
  type TempoSettlementFailureState,
  TempoSettlementReadiness,
  type TempoSettlementReadinessStateStore,
} from "../tempo-settlement-readiness";

const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;

function monitor(readBalance: () => Promise<bigint>) {
  return new TempoSettlementReadiness({
    address: ADDRESS,
    network: "eip155:4217",
    token: TOKEN,
    lowBalanceMicro: 10_000n,
    balanceCheckIntervalMs: 60_000,
    readBalance,
    now: () => 1_700_000_000_000,
  });
}

class SharedFailureStore implements TempoSettlementReadinessStateStore {
  private state: TempoSettlementFailureState = { latched: false };
  private version = 0;

  constructor(private latchFailuresRemaining = 0) {}

  async readFailure(): Promise<TempoSettlementFailureState> {
    return { ...this.state };
  }

  async latchFailure(): Promise<TempoSettlementFailureState> {
    if (this.latchFailuresRemaining > 0) {
      this.latchFailuresRemaining -= 1;
      throw new Error("database unavailable");
    }
    this.version += 1;
    this.state = { latched: true, version: `failure-${this.version}` };
    return { ...this.state };
  }

  async captureFailureBalance(version: string, balanceMicro: bigint): Promise<boolean> {
    if (
      this.state.latched &&
      this.state.version === version &&
      this.state.balanceMicro === undefined
    ) {
      this.state = { latched: true, version, balanceMicro };
      return true;
    }
    return false;
  }

  async clearFailureIfRefilled(
    version: string,
    balanceMicro: bigint,
    lowBalanceMicro: bigint
  ): Promise<boolean> {
    if (
      this.state.latched &&
      this.state.version === version &&
      this.state.balanceMicro !== undefined &&
      balanceMicro >= lowBalanceMicro &&
      balanceMicro > this.state.balanceMicro
    ) {
      this.state = { latched: false };
      return true;
    }
    return false;
  }

  async clearFailureAfterSuccessfulTransaction(version: string): Promise<boolean> {
    if (!this.state.latched || this.state.version !== version) return false;
    this.state = { latched: false };
    return true;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Tempo settlement readiness", () => {
  it("reports the configured fee token at boot without keeping the process alive", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const readiness = monitor(async () => 20_000n);
    const onBalance = vi.fn().mockResolvedValue(undefined);
    readiness.subscribe({ onBalance });

    readiness.start();
    expect(readiness.timerHasRef()).toBe(false);
    await readiness.ensureFresh();

    expect(readiness.available()).toBe(true);
    expect(onBalance).toHaveBeenCalledWith({
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      balanceMicro: 20_000n,
      lowBalanceMicro: 10_000n,
      checkedAt: 1_700_000_000_000,
      ready: true,
    });
    expect(info.mock.calls.flat().join("\n")).not.toContain("private");
    readiness.stop();
  });

  it("withholds below the floor and recovers after a refill", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let balance = 5_000n;
    const readiness = monitor(async () => balance);

    await readiness.checkBalance();
    expect(readiness.available()).toBe(false);

    balance = 10_000n;
    await readiness.checkBalance();
    expect(readiness.available()).toBe(true);
  });

  it("latches an above-floor rejection until balance increases", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let balance = 100_000n;
    const readiness = monitor(async () => balance);
    const onFailure = vi.fn().mockResolvedValue(undefined);
    const onBalance = vi.fn().mockResolvedValue(undefined);
    readiness.subscribe({ onFailure, onBalance });
    await readiness.checkBalance();

    await readiness.recordInsufficientFunds({
      operation: "close",
      channelId: "channel-1",
      creditId: "credit-1",
      drainId: "drain-1",
    });
    await readiness.recordInsufficientFunds({ operation: "close", drainId: "drain-2" });
    expect(readiness.available()).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "close",
        errorClass: "InsufficientFundsError",
        balanceMicro: 100_000n,
        creditId: "credit-1",
        drainId: "drain-1",
      })
    );
    expect(onFailure).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ operation: "close", drainId: "drain-2" })
    );

    await readiness.checkBalance();
    expect(readiness.available()).toBe(false);
    balance = 100_001n;
    await readiness.checkBalance();
    expect(readiness.available()).toBe(true);
    expect(onBalance).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  });

  it("shares the failure latch and recovery across sibling Machines", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let balance = 100_000n;
    const stateStore = new SharedFailureStore();
    const options = {
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      lowBalanceMicro: 10_000n,
      balanceCheckIntervalMs: 60_000,
      readBalance: async () => balance,
      stateStore,
    } as const;
    const first = new TempoSettlementReadiness(options);
    const sibling = new TempoSettlementReadiness(options);
    const siblingBalance = vi.fn().mockResolvedValue(undefined);
    sibling.subscribe({ onBalance: siblingBalance });

    await first.checkBalance();
    await sibling.checkBalance();
    expect(first.available()).toBe(true);
    expect(sibling.available()).toBe(true);

    await first.recordInsufficientFunds({ operation: "settle", channelId: "channel-1" });
    await sibling.ensureFresh();
    expect(first.available()).toBe(false);
    expect(sibling.available()).toBe(false);

    await sibling.checkBalance();
    expect(sibling.available()).toBe(false);
    expect(siblingBalance).toHaveBeenLastCalledWith(expect.objectContaining({ ready: false }));

    balance += 1n;
    await sibling.checkBalance();
    await first.ensureFresh();
    expect(sibling.available()).toBe(true);
    expect(first.available()).toBe(true);
  });

  it("retries a failed shared latch before a healthy read can reopen sessions", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let balance = 100_000n;
    const stateStore = new SharedFailureStore(1);
    const readiness = new TempoSettlementReadiness({
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      readBalance: async () => balance,
      stateStore,
    });
    await readiness.checkBalance();

    await readiness.recordInsufficientFunds({ operation: "settle", channelId: "channel-1" });
    expect(readiness.available()).toBe(false);
    await expect(stateStore.readFailure()).resolves.toEqual({ latched: false });

    await readiness.ensureFresh();
    expect(readiness.available()).toBe(false);
    await expect(stateStore.readFailure()).resolves.toEqual(
      expect.objectContaining({ latched: true, balanceMicro: 100_000n })
    );

    balance += 1n;
    await readiness.checkBalance();
    expect(readiness.available()).toBe(true);
  });

  it("claims a missing failure baseline during an ordinary gated balance check", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let balance = 100_000n;
    const stateStore = new SharedFailureStore();
    const readiness = new TempoSettlementReadiness({
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      readBalance: async () => balance,
      stateStore,
    });
    await readiness.checkBalance();
    await stateStore.latchFailure();

    await readiness.ensureFresh();
    expect(readiness.available()).toBe(false);
    await expect(stateStore.readFailure()).resolves.toEqual(
      expect.objectContaining({ latched: true, balanceMicro: 100_000n })
    );

    balance += 1n;
    await readiness.checkBalance();
    expect(readiness.available()).toBe(true);
  });

  it("cannot clear a newer failure with an older in-flight balance check", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let balance = 100_000n;
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    let blockRead = false;
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    const blockedRead = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const stateStore = new SharedFailureStore();
    const readiness = new TempoSettlementReadiness({
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      readBalance: async () => {
        if (blockRead) {
          markReadStarted?.();
          await blockedRead;
        }
        return balance;
      },
      stateStore,
    });
    await readiness.checkBalance();
    await readiness.recordInsufficientFunds({ operation: "settle" });

    balance += 1n;
    blockRead = true;
    const olderCheck = readiness.checkBalance();
    await readStarted;
    const newerFailure = await stateStore.latchFailure();
    blockRead = false;
    releaseRead?.();
    await olderCheck;

    expect(readiness.available()).toBe(false);
    await expect(stateStore.readFailure()).resolves.toEqual(newerFailure);
  });

  it("cannot clear a newer failure with an older successful transaction", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const stateStore = new SharedFailureStore();
    const readiness = new TempoSettlementReadiness({
      address: ADDRESS,
      network: "eip155:4217",
      token: TOKEN,
      readBalance: async () => 100_000n,
      stateStore,
    });
    await readiness.checkBalance();
    await readiness.recordInsufficientFunds({ operation: "settle" });
    const olderVersion = await readiness.captureRecoveryVersion();
    const newerFailure = await stateStore.latchFailure();

    await readiness.recordSuccessfulTransaction(olderVersion);

    expect(readiness.available()).toBe(false);
    await expect(stateStore.readFailure()).resolves.toEqual(
      expect.objectContaining({ ...newerFailure, balanceMicro: 100_000n })
    );
  });

  it("accepts a successful operator transaction as recovery proof", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const readiness = monitor(async () => 100_000n);
    await readiness.checkBalance();
    await readiness.recordInsufficientFunds({ operation: "settle", channelId: "channel-1" });

    await readiness.recordSuccessfulTransaction();

    expect(readiness.available()).toBe(true);
  });

  it("classifies only viem's insufficient-funds causal chain", () => {
    expect(isTempoInsufficientFundsError(new InsufficientFundsError())).toBe(true);
    expect(
      isTempoInsufficientFundsError(
        new BaseError("Tempo close submission failed", {
          cause: new InsufficientFundsError(),
        })
      )
    ).toBe(true);
    expect(isTempoInsufficientFundsError(new Error("insufficient funds"))).toBe(false);
  });
});
