import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresReplayStore } from "../postgres-replay-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const TEST_TABLE = "signed_request_replays_test";

(RUN ? describe : describe.skip)("PostgresReplayStore (real Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresReplayStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresReplayStore(pool, {
      tableName: TEST_TABLE,
      // gcSampleRate: 0 — GC is exercised by a dedicated test that builds its
      // own store with rate 1. Keep the shared instance off so other tests
      // don't see spurious DELETEs racing with their SELECTs.
      gcSampleRate: 0,
    });
    await store.init();
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${TEST_TABLE}`);
  });

  it("init() is idempotent", async () => {
    await store.init();
    await store.init();
    // No throw; table still exists.
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [TEST_TABLE]
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("insert-then-detect: first call returns false, second returns true", async () => {
    const now = 1_700_000_000;
    const first = await store.checkAndRecord("pubkey-a", 1_700_000_000, "nonce-1", now);
    expect(first).toBe(false);
    const second = await store.checkAndRecord("pubkey-a", 1_700_000_000, "nonce-1", now);
    expect(second).toBe(true);
  });

  it("distinct (pubkey, timestamp, nonce) tuples are independent", async () => {
    const now = 1_700_000_000;
    expect(await store.checkAndRecord("pubkey-a", 1_700_000_000, "nonce-1", now)).toBe(false);
    // Different pubkey → not a replay.
    expect(await store.checkAndRecord("pubkey-b", 1_700_000_000, "nonce-1", now)).toBe(false);
    // Different timestamp → not a replay.
    expect(await store.checkAndRecord("pubkey-a", 1_700_000_001, "nonce-1", now)).toBe(false);
    // Different nonce → not a replay.
    expect(await store.checkAndRecord("pubkey-a", 1_700_000_000, "nonce-2", now)).toBe(false);
  });

  it("concurrent inserts of the same key — exactly one sees false", async () => {
    const now = 1_700_000_000;
    const key = ["pubkey-c", 1_700_000_000, "nonce-concurrent", now] as const;
    // Fire many in parallel; the PK + ON CONFLICT DO NOTHING guarantees only
    // one INSERT writes a row, so only one promise resolves to `false`.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.checkAndRecord(...key))
    );
    const falses = results.filter((r) => !r);
    const trues = results.filter((r) => r);
    expect(falses).toHaveLength(1);
    expect(trues).toHaveLength(7);
  });

  it("GC eviction: rows older than the window are swept on a sampled hit", async () => {
    const gcStore = new PostgresReplayStore(pool, {
      tableName: TEST_TABLE,
      windowSeconds: 600,
      gcSampleRate: 1, // sweep on every checkAndRecord
    });
    const now = 1_700_010_000;
    // Plant a stale row well past the window.
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (pubkey, timestamp, nonce, recorded_at) VALUES ($1, $2, $3, $4)`,
      ["pubkey-stale", 1_700_000_000, "nonce-stale", now - 3600]
    );
    // Plant a fresh row inside the window.
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (pubkey, timestamp, nonce, recorded_at) VALUES ($1, $2, $3, $4)`,
      ["pubkey-fresh", 1_700_009_500, "nonce-fresh", now - 100]
    );
    // Trigger a sweep via an unrelated insert.
    await gcStore.checkAndRecord("pubkey-trigger", 1_700_010_000, "nonce-trigger", now);

    // GC is fire-and-forget; poll until the stale row is gone (sub-second on
    // an idle local DB).
    const deadline = Date.now() + 2000;
    let staleCount = 1;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE pubkey = 'pubkey-stale'`
      );
      staleCount = Number(rows[0]?.count ?? "1");
      if (staleCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(staleCount).toBe(0);

    const { rows: fresh } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE pubkey = 'pubkey-fresh'`
    );
    expect(Number(fresh[0]?.count ?? "0")).toBe(1);
  });

  it("rejects an invalid table name at construction", () => {
    expect(() => new PostgresReplayStore(pool, { tableName: "bad name" })).toThrow();
    expect(() => new PostgresReplayStore(pool, { tableName: "1starts-with-digit" })).toThrow();
    expect(() => new PostgresReplayStore(pool, { tableName: "drop;table" })).toThrow();
  });
});
