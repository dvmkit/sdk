/**
 * Real-Postgres coverage for TIP-1034 channel linearization.
 *
 * The accepted voucher, its following mppx state mutation, and the ledger-side
 * marker share one database transaction; the concurrency cases prove two SDK machines cannot lose an
 * existing-row update or race past a channel's first insert.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyRetryToPool, withPostgresRecoveryContext } from "../../../lib/pg-retry";
import { CreditLedger, type CreditLedgerQuerier } from "../credit-ledger";
import { TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS } from "../tempo-close-event";
import { PostgresTempoSessionStore } from "../tempo-session-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const CHANNEL_ID = `0x${"11".repeat(32)}`;

const BASE = {
  channelId: CHANNEL_ID,
  chainId: 42431,
  escrowContract: `0x${"22".repeat(20)}`,
  payee: `0x${"33".repeat(20)}`,
  payer: `0x${"44".repeat(20)}`,
  token: `0x${"55".repeat(20)}`,
  authorizedSigner: `0x${"66".repeat(20)}`,
  operator: `0x${"77".repeat(20)}`,
  highestVoucherAmount: 10n,
  settledOnChain: 0n,
  spent: 0n,
  units: 0,
  deposit: 100n,
  closeRequestedAt: 0n,
  finalized: false,
};

async function waitForLockWaiters(pool: pg.Pool, applicationNames: string[]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{
      application_name: string;
      wait_event_type: string | null;
    }>(
      `SELECT application_name, wait_event_type
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = ANY($1::TEXT[])`,
      [applicationNames]
    );
    if (
      applicationNames.every((name) =>
        rows.some((row) => row.application_name === name && row.wait_event_type === "Lock")
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Tempo first-write contenders did not reach their database locks");
}

(RUN ? describe : describe.skip)("Tempo session store (Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresTempoSessionStore;
  let storeB: PostgresTempoSessionStore;
  let ledger: CreditLedger;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new PostgresTempoSessionStore(poolA);
    storeB = new PostgresTempoSessionStore(poolB);
    ledger = new CreditLedger(poolA, storeA);
    await Promise.all([storeA.init(), ledger.init()]);
    await poolA.query(
      `CREATE TABLE IF NOT EXISTS tempo_session_atomic_probe (id TEXT PRIMARY KEY)`
    );
  });

  beforeEach(async () => {
    await poolA.query(
      "TRUNCATE mpp_tempo_channels, mpp_tempo_close_intents, tempo_session_atomic_probe"
    );
    await poolA.query("TRUNCATE credit_draws, credit_fundings, credit_drains, credits");
    await storeA.put(CHANNEL_ID, BASE);
  });

  afterAll(async () => {
    await poolA.query("DROP TABLE IF EXISTS tempo_session_atomic_probe");
    await poolA.query("TRUNCATE mpp_tempo_channels, mpp_tempo_close_intents");
    await poolA.end();
    await poolB.end();
  });

  it("rolls back voucher acceptance, following state, and ledger marker together", async () => {
    await expect(
      storeA.withVoucherAcceptance(
        { channelId: CHANNEL_ID, cumulativeAmount: 20n },
        async (tx, voucher) => {
          expect(voucher).toMatchObject({
            cumulativeAmount: 20n,
            priorCumulativeAmount: 10n,
            delta: 10n,
          });
          await tx.query("INSERT INTO tempo_session_atomic_probe (id) VALUES ('voucher')");
          return "funded";
        },
        async () => {
          await storeA.update(CHANNEL_ID, (current) => ({
            op: "set",
            value: { ...(current as typeof BASE), highestVoucherAmount: 20n },
            result: undefined,
          }));
          await storeA.update(CHANNEL_ID, (current) => ({
            op: "set",
            value: { ...(current as typeof BASE), spent: 20n, units: 2 },
            result: undefined,
          }));
          throw new Error("fault after mppx state update");
        }
      )
    ).rejects.toThrow("fault after mppx state update");

    await expect(storeA.get(CHANNEL_ID)).resolves.toEqual(BASE);
    const marker = await poolA.query("SELECT id FROM tempo_session_atomic_probe");
    expect(marker.rows).toEqual([]);
  });

  it("serializes concurrent updates from independent SDK machines", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).update(CHANNEL_ID, (current) => {
          const state = current as typeof BASE;
          return {
            op: "set",
            value: { ...state, deposit: state.deposit + 1n },
            result: undefined,
          };
        })
      )
    );
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ deposit: 120n });
  });

  it("drains a host-sized pool of stale lookup sockets in one close delivery", async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
    const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    let staleClients = 10;
    (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (
      ...args
    ) => {
      if (staleClients > 0) {
        staleClients -= 1;
        throw new Error("Connection terminated unexpectedly");
      }
      return originalQuery(...args);
    };
    applyRetryToPool(pool, "dvm-host");
    const store = new PostgresTempoSessionStore(pool);
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
          () => store.get(CHANNEL_ID)
        )
      ).resolves.toEqual(BASE);
      expect(staleClients).toBe(0);
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: "postgres_transport_recovery",
        elapsed_ms: expect.any(Number),
        level: "warn",
      });
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });

  it("replaces every stale transaction client before acquiring the channel lock", async () => {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
    const originalConnect = pool.connect.bind(pool);
    const staleReleases: ReturnType<typeof vi.fn>[] = [];
    let staleClients = 10;
    (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
      if (staleClients > 0) {
        staleClients -= 1;
        const release = vi.fn();
        staleReleases.push(release);
        return {
          query: () => Promise.reject(new Error("Connection terminated unexpectedly")),
          release,
        } as unknown as pg.PoolClient;
      }
      return originalConnect();
    };
    applyRetryToPool(pool, "dvm-host");
    const store = new PostgresTempoSessionStore(pool);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await withPostgresRecoveryContext(
        {
          route: "tempo_close_event",
          channelId: CHANNEL_ID,
          deadlineMs: Date.now() + TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS,
          drainPool: true,
        },
        () =>
          store.update(CHANNEL_ID, (current) => ({
            op: "set",
            value: { ...(current as typeof BASE), closeRequestedAt: 123n },
            result: undefined,
          }))
      );
      await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ closeRequestedAt: 123n });
      expect(staleClients).toBe(0);
      expect(staleReleases.every((release) => release.mock.calls[0]?.[0] instanceof Error)).toBe(
        true
      );
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
        event: "postgres_transport_recovery",
        elapsed_ms: expect.any(Number),
        level: "warn",
      });
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });

  it("serializes concurrent first writes before the second callback reads", async () => {
    await poolA.query("DELETE FROM mpp_tempo_channels WHERE channel_key = $1", [CHANNEL_ID]);
    const applicationNames = [
      `dvm-tempo-boot-tempo-first-a-${process.pid}`,
      `dvm-tempo-boot-tempo-first-b-${process.pid}`,
    ];
    const firstPool = new pg.Pool({
      connectionString: DATABASE_URL,
      application_name: applicationNames[0],
      max: 1,
    });
    const secondPool = new pg.Pool({
      connectionString: DATABASE_URL,
      application_name: applicationNames[1],
      max: 1,
    });
    const blocker = await poolA.connect();
    const observed: unknown[] = [];
    let blockerOpen = false;
    let updates: Promise<unknown[]> | undefined;
    try {
      await blocker.query("BEGIN");
      blockerOpen = true;
      // SELECT ... FOR UPDATE remains free to read the absent row, while both
      // eventual INSERTs wait. With the advisory lock, only the first callback
      // can run before this table lock is released; without it both callbacks
      // observe null and one increment is silently overwritten.
      await blocker.query("LOCK TABLE mpp_tempo_channels IN SHARE MODE");

      const increment = (store: PostgresTempoSessionStore) =>
        store.update(CHANNEL_ID, (current) => {
          observed.push(current);
          const state = current === null ? { ...BASE, deposit: 0n } : (current as typeof BASE);
          return {
            op: "set" as const,
            value: { ...state, deposit: state.deposit + 1n },
            result: undefined,
          };
        });
      updates = Promise.all([
        increment(new PostgresTempoSessionStore(firstPool)),
        increment(new PostgresTempoSessionStore(secondPool)),
      ]);

      await waitForLockWaiters(poolA, applicationNames);
      await blocker.query("COMMIT");
      blockerOpen = false;
      await updates;

      expect(observed).toHaveLength(2);
      expect(observed[0]).toBeNull();
      expect(observed[1]).toMatchObject({ deposit: 1n });
      await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ deposit: 2n });
    } finally {
      if (blockerOpen) await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
      await updates?.catch(() => undefined);
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it("leaves the pool usable while more acceptances than it has connections wait on chain work", async () => {
    // `operation` is mppx's credential verification, which broadcasts
    // the escrow transaction and awaits its receipt before it touches the
    // store. With the connection taken up front, four of these against a
    // two-connection pool checked out every client and wedged every unrelated
    // query behind them — and the SDK host pool is shared with /v1/job, the job
    // store, KV and the credit ledger.
    // connectionTimeoutMillis so a regression fails as a stated timeout rather
    // than hanging the suite on an unbounded acquire queue.
    const pool = new pg.Pool({
      connectionString: DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 5_000,
    });
    const store = new PostgresTempoSessionStore(pool);
    let releaseChain: (() => void) | undefined;
    const chainWork = new Promise<void>((resolve) => (releaseChain = resolve));
    try {
      const accepted = Array.from({ length: 4 }, (_, index) =>
        store.withVoucherAcceptance(
          { channelId: CHANNEL_ID, cumulativeAmount: BigInt(20 + index) },
          () => Promise.resolve("funded"),
          async () => {
            await chainWork;
            return store.update(CHANNEL_ID, (current) => ({
              op: "set",
              value: {
                ...(current as typeof BASE),
                highestVoucherAmount: (current as typeof BASE).highestVoucherAmount + 1n,
              },
              result: undefined,
            }));
          }
        )
      );

      // Every acceptance is parked on the chain work; the pool must still serve.
      await expect(pool.query("SELECT 1 AS ok")).resolves.toMatchObject({
        rows: [{ ok: 1 }],
      });

      releaseChain?.();
      await Promise.all(accepted);
      await expect(store.get(CHANNEL_ID)).resolves.toMatchObject({ highestVoucherAmount: 14n });
    } finally {
      releaseChain?.();
      await pool.end();
    }
  });

  it("advances spent only when a session-backed draw settles successfully", async () => {
    await ledger.fund({
      creditId: "tempo-terminal",
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await ledger.draw({ creditId: "tempo-terminal", drawId: "success", amountMicro: 4 });
    await ledger.draw({ creditId: "tempo-terminal", drawId: "failure", amountMicro: 3 });

    await ledger.release({ creditId: "tempo-terminal", drawId: "failure" });
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ spent: 0n, units: 0 });

    await ledger.settle({ creditId: "tempo-terminal", drawId: "success" });
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ spent: 4n, units: 1 });

    const replay = await ledger.settle({ creditId: "tempo-terminal", drawId: "success" });
    expect(replay.replayed).toBe(true);
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ spent: 4n, units: 1 });
  });

  it("settles a covered draw during close without advancing channel consumption", async () => {
    await ledger.fund({
      creditId: "tempo-closing",
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await ledger.draw({ creditId: "tempo-closing", drawId: "pending", amountMicro: 4 });
    await storeA.update(CHANNEL_ID, (current) => ({
      op: "set",
      value: {
        ...(current as typeof BASE),
        closeRequestedAt: 123n,
        settledOnChain: 10n,
      },
      result: undefined,
    }));

    await expect(
      ledger.settle({ creditId: "tempo-closing", drawId: "pending" })
    ).resolves.toMatchObject({ status: "settled", replayed: false, availableMicro: 6 });
    await expect(
      ledger.getDraw({ creditId: "tempo-closing", drawId: "pending" })
    ).resolves.toMatchObject({ status: "settled" });
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ spent: 0n, units: 0 });

    await expect(
      ledger.requestDrain({
        creditId: "tempo-closing",
        drainId: "after-close",
        callerPubkey: "ab".repeat(32),
        method: "tempo",
        payout: {},
        requireNoPending: true,
      })
    ).resolves.toMatchObject({ credit: { balanceMicro: 0, availableMicro: 0 } });
  });

  it("does not let sibling draws reuse a partial on-chain watermark", async () => {
    await ledger.fund({
      creditId: "tempo-partial-watermark",
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await ledger.draw({ creditId: "tempo-partial-watermark", drawId: "first", amountMicro: 3 });
    await ledger.draw({ creditId: "tempo-partial-watermark", drawId: "second", amountMicro: 3 });
    await storeA.update(CHANNEL_ID, (current) => ({
      op: "set",
      value: {
        ...(current as typeof BASE),
        closeRequestedAt: 123n,
        settledOnChain: 6n,
      },
      result: undefined,
    }));

    for (const drawId of ["first", "second"]) {
      await expect(
        ledger.settle({ creditId: "tempo-partial-watermark", drawId })
      ).rejects.toMatchObject({ code: "tempo_settlement_pending" });
      await expect(
        ledger.getDraw({ creditId: "tempo-partial-watermark", drawId })
      ).resolves.toMatchObject({ status: "pending" });
    }

    await storeA.update(CHANNEL_ID, (current) => ({
      op: "set",
      value: { ...(current as typeof BASE), settledOnChain: 10n },
      result: undefined,
    }));
    for (const drawId of ["first", "second"]) {
      await expect(
        ledger.settle({ creditId: "tempo-partial-watermark", drawId })
      ).resolves.toMatchObject({ status: "settled", replayed: false });
    }
    await expect(ledger.get("tempo-partial-watermark")).resolves.toMatchObject({
      balanceMicro: 4,
      availableMicro: 4,
    });
    await expect(storeA.get(CHANNEL_ID)).resolves.toMatchObject({ spent: 0n, units: 0 });
  });

  it("refuses a fresh draw after close while preserving a pre-close replay", async () => {
    await ledger.fund({
      creditId: "tempo-no-new-draws",
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await ledger.draw({
      creditId: "tempo-no-new-draws",
      drawId: "before-close",
      amountMicro: 2,
      jobId: "job-before-close",
    });
    await storeA.update(CHANNEL_ID, (current) => ({
      op: "set",
      value: { ...(current as typeof BASE), closeRequestedAt: 123n },
      result: undefined,
    }));

    await expect(
      ledger.draw({
        creditId: "tempo-no-new-draws",
        drawId: "before-close",
        amountMicro: 2,
        jobId: "job-before-close",
      })
    ).resolves.toMatchObject({ replayed: true, status: "pending" });
    await expect(
      ledger.draw({ creditId: "tempo-no-new-draws", drawId: "after-close", amountMicro: 1 })
    ).rejects.toMatchObject({
      code: "tempo_channel_closing",
    });
    await expect(
      ledger.getDraw({ creditId: "tempo-no-new-draws", drawId: "after-close" })
    ).resolves.toBeUndefined();
  });

  it("releases an uncovered hold once the channel has finalized", async () => {
    await ledger.fund({
      creditId: "tempo-finalized",
      callerPubkey: "ab".repeat(32),
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await ledger.draw({ creditId: "tempo-finalized", drawId: "pending", amountMicro: 4 });
    await storeA.update(CHANNEL_ID, (current) => ({
      op: "set",
      value: {
        ...(current as typeof BASE),
        deposit: 0n,
        finalized: true,
      },
      result: undefined,
    }));

    await expect(
      ledger.settle({ creditId: "tempo-finalized", drawId: "pending" })
    ).resolves.toMatchObject({ status: "released", replayed: false, availableMicro: 10 });
    await expect(
      ledger.requestDrain({
        creditId: "tempo-finalized",
        drainId: "after-finalize",
        callerPubkey: "ab".repeat(32),
        method: "tempo",
        payout: {},
        requireNoPending: true,
      })
    ).resolves.toMatchObject({ credit: { balanceMicro: 0, availableMicro: 0 } });
  });

  it("persists close intent and confirmation across store instances", async () => {
    await storeA.withCloseIntent(CHANNEL_ID, "drain-1", () => Promise.resolve());
    await expect(storeB.getClose(CHANNEL_ID)).resolves.toEqual({
      channelId: CHANNEL_ID,
      drainId: "drain-1",
      reference: null,
    });
    await expect(storeA.resolveCloseForecast(CHANNEL_ID, "drain-1", "proceed")).resolves.toEqual({
      outcome: "proceed",
    });
    await storeB.confirmClose(CHANNEL_ID, "drain-1", `0x${"99".repeat(32)}`);
    await expect(storeA.getClose(CHANNEL_ID)).resolves.toMatchObject({
      drainId: "drain-1",
      reference: `0x${"99".repeat(32)}`,
    });
    await expect(
      storeB.withCloseIntent(CHANNEL_ID, "drain-2", () => Promise.resolve())
    ).rejects.toThrow(/already closing for another drain/);
  });

  it("lets exactly one replica claim a recovered close's reference", async () => {
    await storeA.withCloseIntent(CHANNEL_ID, "drain-1", () => Promise.resolve());
    await storeA.resolveCloseForecast(CHANNEL_ID, "drain-1", "proceed");
    const reference = `0x${"99".repeat(32)}`;
    const claims = await Promise.all([
      storeA.claimCloseReference(CHANNEL_ID, "drain-1", reference),
      storeB.claimCloseReference(CHANNEL_ID, "drain-1", reference),
    ]);
    expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect(claims.map(({ reference: claimedReference }) => claimedReference))
      .toEqual([reference, reference]);
    // A confirmation that already landed leaves nothing to claim.
    await expect(storeB.claimCloseReference(CHANNEL_ID, "drain-1", reference))
      .resolves.toEqual({ reference, claimed: false });
  });

  it("does not let one replica release after another opens the forecast gate", async () => {
    const callerPubkey = "ab".repeat(32);
    await ledger.fund({
      creditId: "tempo-forecast-race",
      callerPubkey,
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });
    await storeA.withCloseIntent(CHANNEL_ID, "drain-race", (tx) =>
      ledger.requestDrain({
        creditId: "tempo-forecast-race",
        drainId: "drain-race",
        callerPubkey,
        method: "tempo",
        payout: {},
        requireNoPending: true,
        tx,
      })
    );
    await expect(storeB.resolveCloseForecast(CHANNEL_ID, "drain-race", "proceed")).resolves.toEqual(
      { outcome: "proceed" }
    );
    const release = vi.fn((tx: CreditLedgerQuerier) =>
      ledger.releaseDrain({ creditId: "tempo-forecast-race", drainId: "drain-race", tx })
    );

    await expect(
      storeA.resolveCloseForecast(CHANNEL_ID, "drain-race", "release", release)
    ).resolves.toEqual({ outcome: "proceed" });
    expect(release).not.toHaveBeenCalled();
    await expect(ledger.get("tempo-forecast-race")).resolves.toMatchObject({ balanceMicro: 0 });
    await expect(storeA.beginClose(CHANNEL_ID, "drain-race")).resolves.toMatchObject({
      drainId: "drain-race",
    });
  });

  it("releases a close intent with its drain so a fresh drain can reserve the channel", async () => {
    const callerPubkey = "ab".repeat(32);
    await ledger.fund({
      creditId: "tempo-close-retry",
      callerPubkey,
      currency: "usd",
      amountMicro: 10,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: CHANNEL_ID, cumulativeAmount: "10" },
      },
    });

    await storeA.withCloseIntent(CHANNEL_ID, "drain-1", (tx) =>
      ledger.requestDrain({
        creditId: "tempo-close-retry",
        drainId: "drain-1",
        callerPubkey,
        method: "tempo",
        payout: {},
        requireNoPending: true,
        tx,
      })
    );
    await expect(storeB.getClose(CHANNEL_ID)).resolves.toMatchObject({ drainId: "drain-1" });
    await expect(ledger.get("tempo-close-retry")).resolves.toMatchObject({ balanceMicro: 0 });
    await storeA.resolveCloseForecast(CHANNEL_ID, "drain-1", "proceed");
    await expect(storeB.beginClose(CHANNEL_ID, "drain-1")).resolves.toMatchObject({
      drainId: "drain-1",
    });

    await storeB.releaseCloseIntent(CHANNEL_ID, "drain-1", (tx) =>
      ledger.releaseDrain({ creditId: "tempo-close-retry", drainId: "drain-1", tx })
    );
    await expect(storeA.getClose(CHANNEL_ID)).resolves.toBeNull();
    await expect(ledger.get("tempo-close-retry")).resolves.toMatchObject({ balanceMicro: 10 });
    await expect(storeA.beginClose(CHANNEL_ID, "drain-1")).rejects.toThrow(/no longer pending/);
    await expect(storeA.getClose(CHANNEL_ID)).resolves.toBeNull();

    await storeB.withCloseIntent(CHANNEL_ID, "drain-2", (tx) =>
      ledger.requestDrain({
        creditId: "tempo-close-retry",
        drainId: "drain-2",
        callerPubkey,
        method: "tempo",
        payout: {},
        requireNoPending: true,
        tx,
      })
    );
    await expect(storeA.getClose(CHANNEL_ID)).resolves.toMatchObject({ drainId: "drain-2" });
    await expect(
      ledger.getDrain({ creditId: "tempo-close-retry", drainId: "drain-2" })
    ).resolves.toMatchObject({ status: "pending", amountMicro: 10 });
  });
});
