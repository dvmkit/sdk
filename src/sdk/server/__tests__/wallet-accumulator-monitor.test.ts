import type { Pool, PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";

vi.mock("../../../lib/cashu/mint-info", () => ({
  getKeysetFinalExpiry: vi.fn(),
}));

const { getKeysetFinalExpiry } = await import("../../../lib/cashu/mint-info");
const { startAccumulatorMonitor, EXPIRING_SOON_THRESHOLD_MS } =
  await import("../wallet-accumulator-monitor");

const mockKeysetFinalExpiry = vi.mocked(getKeysetFinalExpiry);

const LOCK_PUBKEY = toLockPubkey("02" + "ab".repeat(32));
const MINT = "https://mint.example.com";
const DVM_ID = "dvm-monitor-1";

interface QueryRecord {
  text: string;
  params: unknown[];
}

interface MockPoolBuilder {
  pool: Pool;
  queries: QueryRecord[];
  setLockAcquired(value: boolean): void;
  setPendingBatch(rows: Record<string, unknown>[]): void;
  setReaperKeysets(rows: { mint_url: string; proof_keyset_id: string }[]): void;
}

function buildMockPool(): MockPoolBuilder {
  const queries: QueryRecord[] = [];
  let lockAcquired = true;
  let pendingRows: Record<string, unknown>[] = [];
  let reaperKeysets: { mint_url: string; proof_keyset_id: string }[] = [];

  const query = vi.fn((text: string, params?: unknown[]) => {
    queries.push({ text, params: params ?? [] });
    if (text.startsWith("SELECT pg_try_advisory_lock")) {
      return Promise.resolve({
        rows: [{ acquired: lockAcquired }],
        rowCount: 1
      });
    }
    if (text.startsWith("SELECT pg_advisory_unlock")) {
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    if (text.includes("FROM wallet_accumulator") && text.includes("melted_at IS NULL")) {
      return Promise.resolve({
        rows: pendingRows,
        rowCount: pendingRows.length
      });
    }
    if (text.includes("SELECT DISTINCT mint_url, proof_keyset_id")) {
      return Promise.resolve({
        rows: reaperKeysets,
        rowCount: reaperKeysets.length
      });
    }
    if (text.startsWith("DELETE FROM wallet_accumulator")) {
      return Promise.resolve({ rows: [], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });

  const client: Pick<PoolClient, "query" | "release"> = {
    query: query as unknown as PoolClient["query"],
    release: vi.fn()
  };
  const connect = vi.fn(() => Promise.resolve(client as unknown as PoolClient));

  const pool = {
    query,
    connect
  } as unknown as Pool;

  return {
    pool,
    queries,
    setLockAcquired(value: boolean) {
      lockAcquired = value;
    },
    setPendingBatch(rows) {
      pendingRows = rows;
    },
    setReaperKeysets(rows) {
      reaperKeysets = rows;
    }
  };
}

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "row-1",
    lock_pubkey: LOCK_PUBKEY,
    mint_url: MINT,
    proof_keyset_id: "keyset-1",
    proof_secret: "secret-1",
    proof_c: "C-1",
    proof_amount: 100,
    received_at: 1_000_000,
    melt_quote_id: null,
    t_expire: null,
    ...overrides
  };
}

describe("startAccumulatorMonitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKeysetFinalExpiry.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips the tick when the advisory lock is held by another replica", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const builder = buildMockPool();
    builder.setLockAcquired(false);
    builder.setPendingBatch([makeRow({ t_expire: fixedNow - 1000 })]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    expect(builder.queries.some((q) => q.text.startsWith("SELECT pg_try_advisory_lock"))).toBe(true);
    const eventLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_"));
    expect(eventLine).toBeUndefined();
    log.mockRestore();
  });

  it("emits wallet_accumulator_batch_expired when t_expire is in the past", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const builder = buildMockPool();
    builder.setPendingBatch([
      makeRow({
        id: "row-expired",
        proof_amount: 250,
        t_expire: fixedNow - 5_000
      })
    ]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    const expiredLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_expired"));
    expect(expiredLine).toBeDefined();
    expect(expiredLine).not.toContain(LOCK_PUBKEY);
    expect(expiredLine).not.toContain("row-expired");
    log.mockRestore();
  });

  it("emits wallet_accumulator_batch_expiring_soon when t_expire is within the threshold", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const remainingMs = EXPIRING_SOON_THRESHOLD_MS - 60_000;
    const builder = buildMockPool();
    builder.setPendingBatch([
      makeRow({
        id: "row-soon",
        proof_amount: 700,
        t_expire: fixedNow + remainingMs
      })
    ]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    const soonLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_expiring_soon"));
    expect(soonLine).toBeDefined();
    expect(soonLine).not.toContain(String(remainingMs));
    expect(soonLine).not.toContain("row-soon");
    log.mockRestore();
  });

  it("emits nothing when t_expire is farther out than the threshold", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const builder = buildMockPool();
    builder.setPendingBatch([makeRow({ t_expire: fixedNow + EXPIRING_SOON_THRESHOLD_MS + 60_000 })]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    const eventLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_"));
    expect(eventLine).toBeUndefined();
    log.mockRestore();
  });

  it("emits nothing when t_expire is null on every row", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const builder = buildMockPool();
    builder.setPendingBatch([makeRow({ t_expire: null })]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID
    });
    await handle.runOnce();
    handle.stop();

    const eventLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_"));
    expect(eventLine).toBeUndefined();
    log.mockRestore();
  });

  it("reaps accumulator rows whose keyset has passed final_expiry", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const builder = buildMockPool();
    builder.setReaperKeysets([{ mint_url: MINT, proof_keyset_id: "keyset-old" }]);
    const fixedNow = 2_000_000_000_000; // ms
    // final_expiry is in seconds and elapsed.
    mockKeysetFinalExpiry.mockResolvedValueOnce(Math.floor(fixedNow / 1000) - 3600);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    expect(mockKeysetFinalExpiry).toHaveBeenCalledWith(MINT, "keyset-old");
    const deleteQuery = builder.queries.find((q) => q.text.startsWith("DELETE FROM wallet_accumulator"));
    expect(deleteQuery).toBeDefined();
    expect(deleteQuery?.params).toEqual([DVM_ID, MINT, "keyset-old"]);
    const reapedLine = logSpy.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_reaped_expired_keyset"));
    expect(reapedLine).toBeDefined();
    expect(reapedLine).not.toContain("keyset-old");
    logSpy.mockRestore();
  });

  it("leaves rows alone when the keyset's final_expiry has not yet elapsed", async () => {
    const builder = buildMockPool();
    builder.setReaperKeysets([{ mint_url: MINT, proof_keyset_id: "keyset-fresh" }]);
    const fixedNow = 2_000_000_000_000;
    mockKeysetFinalExpiry.mockResolvedValueOnce(Math.floor(fixedNow / 1000) + 3600);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow
    });
    await handle.runOnce();
    handle.stop();

    expect(builder.queries.some((q) => q.text.startsWith("DELETE FROM wallet_accumulator"))).toBe(false);
  });

  it("leaves rows alone when the mint doesn't advertise final_expiry", async () => {
    // Mint without NUT-02 `final_expiry` returns undefined — preserve rows
    // rather than guess at a default. A transient mint outage falls into
    // the same branch via the helper's try/catch.
    const builder = buildMockPool();
    builder.setReaperKeysets([{ mint_url: MINT, proof_keyset_id: "keyset-unknown" }]);
    mockKeysetFinalExpiry.mockResolvedValueOnce(undefined);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID
    });
    await handle.runOnce();
    handle.stop();

    expect(builder.queries.some((q) => q.text.startsWith("DELETE FROM wallet_accumulator"))).toBe(false);
  });

  it("emits wallet_accumulator_batch_retired_lock_pubkey for batches sitting on a retired pubkey", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const RETIRED_PUBKEY = toLockPubkey("03" + "cd".repeat(32));
    const builder = buildMockPool();
    builder.setPendingBatch([
      makeRow({
        id: "row-retired",
        lock_pubkey: RETIRED_PUBKEY,
        proof_amount: 420
      })
    ]);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow,
      getLockPubkeyState: () =>
        Promise.resolve({
          current: LOCK_PUBKEY,
          retired: [{ pubkey: RETIRED_PUBKEY, retiredAtMs: fixedNow - 60_000 }]
        }),
      lockPubkeyGraceSeconds: 86_400
    });
    await handle.runOnce();
    handle.stop();

    const retiredLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_retired_lock_pubkey"));
    expect(retiredLine).toBeDefined();
    expect(retiredLine).not.toContain(RETIRED_PUBKEY);
    log.mockRestore();
  });

  it("does NOT emit retired event for a batch on the current pubkey", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fixedNow = 1_700_000_000_000;
    const builder = buildMockPool();
    builder.setPendingBatch([makeRow()]);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      now: () => fixedNow,
      getLockPubkeyState: () => Promise.resolve({ current: LOCK_PUBKEY, retired: [] }),
      lockPubkeyGraceSeconds: 86_400
    });
    await handle.runOnce();
    handle.stop();

    const retiredLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_retired_lock_pubkey"));
    expect(retiredLine).toBeUndefined();
    log.mockRestore();
  });

  it("issues a DELETE against dvm_lock_pubkeys to prune retired entries each tick", async () => {
    const builder = buildMockPool();
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      getLockPubkeyState: () => Promise.resolve({ current: LOCK_PUBKEY, retired: [] }),
      lockPubkeyGraceSeconds: 86_400
    });
    await handle.runOnce();
    handle.stop();

    const pruneQuery = builder.queries.find((q) => q.text.startsWith("DELETE FROM dvm_lock_pubkeys"));
    expect(pruneQuery).toBeDefined();
  });

  it("emits wallet_accumulator_batch_orphan_lock_pubkey for batches whose lock pubkey is past the grace window", async () => {
    // Once `pruneRetired` deletes a row whose grace expired, batches still
    // locked to that pubkey are no longer current and no longer retired-in-grace.
    // They're still meltable via the rotation walker — operators need a
    // distinct signal so dead-capital cases don't go silent.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ORPHAN_PUBKEY = toLockPubkey("03" + "ef".repeat(32));
    const builder = buildMockPool();
    builder.setPendingBatch([
      makeRow({
        id: "row-orphan",
        lock_pubkey: ORPHAN_PUBKEY,
        proof_amount: 99
      })
    ]);

    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID,
      // Active state contains neither the orphan pubkey nor any retired entry —
      // simulates the post-grace pruned state.
      getLockPubkeyState: () => Promise.resolve({ current: LOCK_PUBKEY, retired: [] }),
      lockPubkeyGraceSeconds: 86_400
    });
    await handle.runOnce();
    handle.stop();

    const orphanLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_orphan_lock_pubkey"));
    expect(orphanLine).toBeDefined();
    expect(orphanLine).not.toContain(ORPHAN_PUBKEY);
    const unknownLines = log.mock.calls
      .flat()
      .map(String)
      .filter((c) => c.includes("wallet_accumulator_batch_orphan_lock_pubkey"));
    expect(unknownLines).toHaveLength(1);
    log.mockRestore();
  });

  it("does NOT emit orphan event when getLockPubkeyState is not wired", async () => {
    // Legacy/test wiring without the loader skips the rotation housekeeping
    // entirely — no current/retired/orphan classification runs.
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ORPHAN_PUBKEY = toLockPubkey("03" + "ef".repeat(32));
    const builder = buildMockPool();
    builder.setPendingBatch([
      makeRow({
        id: "row-orphan",
        lock_pubkey: ORPHAN_PUBKEY,
        proof_amount: 99
      })
    ]);
    const handle = startAccumulatorMonitor({
      pool: builder.pool,
      dvmId: DVM_ID
    });
    await handle.runOnce();
    handle.stop();

    const orphanLine = log.mock.calls
      .flat()
      .map(String)
      .find((c) => c.includes("wallet_accumulator_batch_orphan_lock_pubkey"));
    expect(orphanLine).toBeUndefined();
    log.mockRestore();
  });
});
