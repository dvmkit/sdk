/**
 * The unit suite pins the guard's logic against `Store.memory()`, where a claim
 * is one synchronous read-modify-write. What only a real database can answer is
 * whether the claim is atomic across *machines*: the lease is taken through
 * `PostgresTempoSessionStore.update`, whose linearization is a per-channel
 * `pg_advisory_xact_lock` plus a `SELECT … FOR UPDATE` in one transaction, and
 * that is exactly what a memory store does not have.
 *
 * Two pools rather than two stores on one pool: one Pool is one machine, the
 * idiom `tempo-session-store.db.test.ts` and `tempo-charge-store.db.test.ts`
 * both use.
 */
import pg from "pg";
import type { Client } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { withPostgresRecoveryContext } from "../../../lib/pg-retry";
import {
  _testing,
  TEMPO_SETTLEMENT_IN_FLIGHT,
  TEMPO_SETTLEMENT_LEASE_FIELD,
  TEMPO_SETTLEMENT_LEASE_OWNER_FIELD,
} from "../mpp-setup";
import { TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS } from "../tempo-close-event";
import { PostgresTempoSessionStore } from "../tempo-session-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const CHANNEL_ID = `0x${"11".repeat(32)}`;
const ESCROW = `0x${"22".repeat(20)}` as `0x${string}`;
const TOKEN = `0x${"44".repeat(20)}` as `0x${string}`;
const TX_HASH = `0x${"33".repeat(32)}` as `0x${string}`;

/** A channel the chain says is force-closing, still owing an accepted voucher. */
const CLOSING = {
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
  createdAt: "2026-08-15T00:00:00.000Z",
};

const CHAIN_STATE = { settled: 20n, deposit: 100n, closeRequestedAt: 123 };

/** A settle that parks until released, standing in for mppx's receipt wait. */
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
    settle: async (): Promise<`0x${string}`> => {
      entered();
      await parked;
      return TX_HASH;
    },
  };
}

(RUN ? describe : describe.skip)("Tempo settlement lease (Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresTempoSessionStore;
  let storeB: PostgresTempoSessionStore;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new PostgresTempoSessionStore(poolA);
    storeB = new PostgresTempoSessionStore(poolB);
    await storeA.init();
  });

  beforeEach(async () => {
    await poolA.query("TRUNCATE mpp_tempo_channels, mpp_tempo_close_intents");
    await storeA.put(CHANNEL_ID, CLOSING);
  });

  afterAll(async () => {
    await poolA.query("TRUNCATE mpp_tempo_channels, mpp_tempo_close_intents");
    await poolA.end();
    await poolB.end();
  });

  /** One machine's Tempo session runtime over its own pool. */
  function machine(
    store: PostgresTempoSessionStore,
    opts: { settle?: () => Promise<`0x${string}`>; chainState?: typeof CHAIN_STATE } = {}
  ) {
    const settleSpy = vi.fn(opts.settle ?? (() => Promise.resolve(TX_HASH)));
    const mpp = _testing.attachTempoSessionRuntime(
      {} as never,
      {
        store,
        account: privateKeyToAccount(generatePrivateKey()),
        getClient: () => Promise.resolve({} as Client),
        settlementSchedule: { intervalMs: 24 * 60 * 60 * 1_000 },
      },
      {
        getChannelStatesBatch: () => Promise.resolve([opts.chainState ?? CHAIN_STATE]),
        settle: settleSpy,
      }
    );
    return { mpp, settle: settleSpy };
  }

  it("lets one machine settle and refuses the other inside the confirmation window", async () => {
    const blocked = blockingSettle();
    const machineA = machine(storeA, { settle: blocked.settle });
    const machineB = machine(storeB);

    const first = machineA.mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    await blocked.started;

    await expect(machineB.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toEqual({
      outcome: "retryable_failure",
      channelId: CHANNEL_ID,
      error: TEMPO_SETTLEMENT_IN_FLIGHT,
    });

    blocked.release();
    await expect(first).resolves.toMatchObject({ outcome: "settled" });
    expect(machineA.settle).toHaveBeenCalledTimes(1);
    expect(machineB.settle).not.toHaveBeenCalled();
  });

  it("hands the lease to exactly one of two simultaneous claims", async () => {
    // Neither claim is ordered behind the other by the test, so the advisory
    // lock is the whole answer. Both settles park rather than resolving
    // instantly: an instant settle lets the winner claim, broadcast and release
    // before the loser's claim ever reaches the lock, which would let two
    // settlements through a *working* guard and flake the assertion below.
    // The park lifts as soon as either call answers — which, when the guard
    // holds, is the loser being refused. The timer is only there so a
    // regression that lets both claim fails on the assertion instead of hanging.
    let claimsSettled!: () => void;
    const contended = new Promise<void>((resolve) => {
      claimsSettled = resolve;
    });
    const park = async (): Promise<`0x${string}`> => {
      await Promise.race([contended, new Promise((resolve) => setTimeout(resolve, 500))]);
      return TX_HASH;
    };
    const machineA = machine(storeA, { settle: park });
    const machineB = machine(storeB, { settle: park });

    const first = machineA.mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    const second = machineB.mpp.settleTempoSessionChannel?.(CHANNEL_ID);
    await Promise.race([first, second]);
    claimsSettled();

    const outcomes = await Promise.all([first, second]);

    const settled = outcomes.filter((outcome) => outcome?.outcome === "settled");
    expect(settled).toHaveLength(1);
    expect(machineA.settle.mock.calls.length + machineB.settle.mock.calls.length).toBe(1);
  });

  it.each(["before", "after"] as const)(
    "broadcasts once when the settlement-lease commit fails %s acknowledgement",
    async (failurePoint) => {
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
      const originalConnect = pool.connect.bind(pool);
      let injected = false;
      const connect = async (): Promise<pg.PoolClient> => {
        const client = await originalConnect();
        const originalQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        let wroteLease = false;
        return {
          query: async (...args: unknown[]) => {
            const sql = typeof args[0] === "string" ? args[0] : "";
            const values = Array.isArray(args[1]) ? args[1] : [];
            const writesLease =
              sql.includes("mpp_tempo_channels") &&
              values.some(
                (value) =>
                  typeof value === "string" && value.includes(TEMPO_SETTLEMENT_LEASE_OWNER_FIELD)
              );
            if (writesLease && failurePoint === "before" && !injected) {
              injected = true;
              throw new Error("Connection terminated unexpectedly");
            }
            const result = await originalQuery(...args);
            if (writesLease) wroteLease = true;
            if (sql === "COMMIT" && wroteLease && failurePoint === "after" && !injected) {
              injected = true;
              throw new Error("Connection terminated unexpectedly");
            }
            return result;
          },
          release: (error?: Error | boolean) => client.release(error),
        } as unknown as pg.PoolClient;
      };
      // Keep pool.query bound to the real Pool: node-pg's query convenience
      // path owns a callback checkout internally, while this test seam only
      // faults the explicit transaction checkouts used by the session store.
      const faultPool = {
        query: pool.query.bind(pool),
        connect,
        options: pool.options,
      } as unknown as pg.Pool;
      const store = new PostgresTempoSessionStore(faultPool);
      const runtime = machine(store);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await expect(
          withPostgresRecoveryContext(
            {
              route: "tempo_close_event",
              channelId: CHANNEL_ID,
              deadlineMs: Date.now() + TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS,
              drainPool: true,
            },
            () => runtime.mpp.settleTempoSessionChannel?.(CHANNEL_ID) ?? Promise.resolve(undefined)
          )
        ).resolves.toMatchObject({ outcome: "settled" });
        expect(injected).toBe(true);
        expect(runtime.settle).toHaveBeenCalledTimes(1);
        await expect(storeB.get(CHANNEL_ID)).resolves.not.toHaveProperty(
          TEMPO_SETTLEMENT_LEASE_FIELD
        );
        await expect(storeB.get(CHANNEL_ID)).resolves.not.toHaveProperty(
          TEMPO_SETTLEMENT_LEASE_OWNER_FIELD
        );
      } finally {
        warn.mockRestore();
        await pool.end();
      }
    }
  );

  it("clears the lease once the settlement lands, so the retry gets a terminal answer", async () => {
    const machineA = machine(storeA);

    await machineA.mpp.settleTempoSessionChannel?.(CHANNEL_ID);

    // Read through the *other* machine's pool: the release is committed state,
    // not something the settling process holds.
    await expect(storeB.get(CHANNEL_ID)).resolves.not.toHaveProperty(TEMPO_SETTLEMENT_LEASE_FIELD);
    await expect(storeB.get(CHANNEL_ID)).resolves.not.toHaveProperty(
      TEMPO_SETTLEMENT_LEASE_OWNER_FIELD
    );

    // The observer's next retry, by which time its chain read shows the landed
    // watermark: it must acknowledge (200 `already_safe`), not churn 503s for
    // the rest of the lease.
    const retry = machine(storeB, {
      chainState: { settled: 60n, deposit: 100n, closeRequestedAt: 123 },
    });
    await expect(retry.mpp.settleTempoSessionChannel?.(CHANNEL_ID)).resolves.toMatchObject({
      outcome: "already_safe",
    });
    expect(retry.settle).not.toHaveBeenCalled();
  });
});
