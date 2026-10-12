import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { applyRetryToPool, formatPostgresApplicationName } from "../../../lib/pg-retry";
import { PostgresX402ChannelStorage, X402RelaySubmissionLockError } from "../x402-channel-store";
import { createX402SelfRelaySigner, type X402SelfRelaySignerBackend } from "../x402-self-relay";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const CONTRACT = "0x2222222222222222222222222222222222222222" as const;
const HASH = `0x${"33".repeat(32)}` as const;
const LOCK_KEY = `x402-self-relay:eip155:8453:${ADDRESS.toLowerCase()}`;

describe.skipIf(!RUN)("x402 self-relay replica submission lock", () => {
  let pool: Pool;
  const stores: PostgresX402ChannelStorage[] = [];

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 2 });
    applyRetryToPool(pool, "dvm-host");
  });

  afterAll(async () => {
    // The settlement pools are the stores' own; ending them keeps the run from
    // outliving its connections.
    await Promise.all(stores.map((store) => store.close()));
    await pool.end();
  });

  function store(relaySubmissionLockTimeoutMs?: number): PostgresX402ChannelStorage {
    const created = new PostgresX402ChannelStorage(
      pool,
      relaySubmissionLockTimeoutMs === undefined ? undefined : { relaySubmissionLockTimeoutMs }
    );
    stores.push(created);
    return created;
  }

  it("serializes the same per-DVM EOA across two signer instances", async () => {
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstBackend = backend();
    firstBackend.writeContract = vi.fn(async () => {
      firstEntered();
      await pending;
      return HASH;
    });
    const secondBackend = backend();
    const firstSigner = createX402SelfRelaySigner({
      backend: firstBackend,
      network: "eip155:8453",
      submissionLock: store(),
    });
    const secondSigner = createX402SelfRelaySigner({
      backend: secondBackend,
      network: "eip155:8453",
      submissionLock: store(),
    });

    const first = firstSigner.writeContract({
      address: CONTRACT,
      abi: [],
      functionName: "settle",
      args: [],
      gas: 120_000n,
    });
    await entered;
    const second = secondSigner.sendTransaction({ to: CONTRACT, data: "0x1234" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondBackend.sendTransaction).not.toHaveBeenCalled();
    } finally {
      releaseFirst();
    }
    await expect(Promise.all([first, second])).resolves.toEqual([HASH, HASH]);
    expect(secondBackend.sendTransaction).toHaveBeenCalledOnce();
  });

  // the acquire used to be an untimed `pg_advisory_lock`, so a wedged
  // fleet-mate blocked it for as long as it liked — while the caller held a
  // host-pool client and a channel advisory lock. It must now refuse, and refuse
  // *without* submitting: two machines writing from one EOA collide on the nonce.
  it("refuses with a typed retryable error when a fleet-mate holds the lock", async () => {
    const holder = await pool.connect();
    const wallet = backend();
    const signer = createX402SelfRelaySigner({
      backend: wallet, network: "eip155:8453", submissionLock: store(250),
    });
    try {
      await holder.query("SELECT pg_advisory_lock(hashtextextended($1, 1759))", [LOCK_KEY]);
      await holder.query("SELECT 'wedged-fleet-mate'");

      const refusal = await signer.sendTransaction({ to: CONTRACT, data: "0x1234" }).then(
        () => undefined,
        (error: unknown) => error
      );

      expect(refusal).toBeInstanceOf(X402RelaySubmissionLockError);
      const typed = refusal as X402RelaySubmissionLockError;
      expect(typed.code).toBe("x402_relay_submission_lock_timeout");
      expect(typed.retryable).toBe(true);
      expect(typed.lockKey).toBe(LOCK_KEY);
      // Best-effort, but this holder is our own backend on the same role, so it
      // is nameable — that is the whole point of the diagnostic.
      expect(typed.holder?.pid).toBeGreaterThan(0);
      expect(typed.holder?.applicationName).toBe(formatPostgresApplicationName("dvm-host"));
      expect(typed.message).toContain(String(typed.holder?.pid));
      expect(typed.message).toContain(String(typed.holder?.applicationName));
      expect(wallet.sendTransaction).not.toHaveBeenCalled();
    } finally {
      await holder
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 1759))", [LOCK_KEY])
        .catch(() => undefined);
      holder.release();
    }
    await expect(signer.sendTransaction({ to: CONTRACT, data: "0x1234" })).resolves.toBe(HASH);
    expect(wallet.sendTransaction).toHaveBeenCalledOnce();
  });
});

function backend(): X402SelfRelaySignerBackend {
  return {
    address: ADDRESS,
    readContract: vi.fn(async () => 0n),
    verifyTypedData: vi.fn(async () => true),
    writeContract: vi.fn(async () => HASH),
    sendTransaction: vi.fn(async () => HASH),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
    getCode: vi.fn(async () => undefined),
  };
}
