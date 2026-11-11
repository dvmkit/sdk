import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { PostgresX402ChannelStorage } from "../x402-channel-store";
import { createX402SelfRelay } from "../x402-self-relay";
import { connectForX402ShutdownClaim, waitForX402ShutdownClaim, x402ShutdownClaimSignal } from "../x402-shutdown-claim";

// The external database grants advisory locks; the production store must release their sessions on expiry.
function databaseClient() {
  return {
    query: vi.fn(async () => ({ rows: [{ locked: true }] })),
    release: vi.fn(),
  };
}

describe("shutdown claim database cleanup", () => {
  it("destroys a held fleet-lock session and resolves its caller when the budget expires", async () => {
    const client = databaseClient();
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const storage = new PostgresX402ChannelStorage(pool);
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const work = x402ShutdownClaimSignal.run(controller.signal, () => storage.withFleetSettlementLock(async () => {
      started();
      await new Promise(() => undefined);
    }));
    const rejected = expect(work).rejects.toThrow("deadline");
    await entered;
    controller.abort(new Error("deadline"));
    await rejected;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls).toHaveLength(1);
    // A timed-out local reservation must not prevent the next local operation.
    await expect(storage.withFleetSettlementLock(async () => undefined)).resolves.toBe(true);
  });

  it("releases a connection acquired after shutdown stopped waiting, without using it", async () => {
    const client = databaseClient();
    let finish!: (client: PoolClient) => void;
    const pool = { connect: vi.fn(() => new Promise((resolve) => { finish = resolve; })) } as unknown as Pool;
    const controller = new AbortController();
    const work = x402ShutdownClaimSignal.run(controller.signal, () => connectForX402ShutdownClaim(pool));
    const rejected = expect(work).rejects.toThrow("deadline");
    controller.abort(new Error("deadline"));
    await rejected;
    finish(client as unknown as PoolClient);
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe("shutdown claim RPC cancellation", () => {
  it("aborts the self-relay's HTTP request with the claim's deadline", async () => {
    let entered!: (signal: AbortSignal) => void;
    const requested = new Promise<AbortSignal>((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      entered(signal);
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const relay = createX402SelfRelay({
      network: "eip155:8453",
      config: { privateKey: `0x${"11".repeat(32)}`, rpcUrl: "https://base.example.com" },
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    try {
      const work = x402ShutdownClaimSignal.run(controller.signal, () => waitForX402ShutdownClaim(() => relay.checkBalance()));
      const rejected = expect(work).rejects.toThrow("deadline");
      const signal = await requested;
      controller.abort(new Error("deadline"));
      await rejected;
      expect(signal.aborted).toBe(true);
      await vi.runAllTimersAsync();
    } finally {
      relay.stop();
      vi.useRealTimers();
    }
  });
});
