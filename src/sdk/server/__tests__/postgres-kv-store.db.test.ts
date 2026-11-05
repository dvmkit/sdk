import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresKVStore } from "../postgres-kv-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

(RUN ? describe : describe.skip)("PostgresKVStore expiry (real Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresKVStore | undefined;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    const setup = new PostgresKVStore(pool);
    await setup.init();
    await setup.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE kv_store");
  });

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  async function storedKeys(): Promise<string[]> {
    const { rows } = await pool.query<{ key: string }>("SELECT key FROM kv_store ORDER BY key");
    return rows.map((row) => row.key);
  }

  it("the periodic sweep deletes expired rows and keeps live ones", async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO kv_store (key, value, expires_at) VALUES
         ('expired:a', '1', $1), ('expired:b', '2', $2),
         ('live', '3', $3), ('forever', '4', NULL)`,
      [now - 60_000, now - 1, now + 3_600_000]
    );

    store = new PostgresKVStore(pool, { sweepIntervalMs: 50 });
    await store.init();

    // A row that expires after init is removed by a later tick, not the boot sweep.
    await pool.query("INSERT INTO kv_store (key, value, expires_at) VALUES ('expired:c', '5', $1)", [
      Date.now() + 100,
    ]);
    await vi.waitFor(async () => {
      expect(await storedKeys()).toEqual(["forever", "live"]);
    }, { timeout: 5_000, interval: 25 });
  });

  /** The pool, recording the row count of each sweep DELETE statement. */
  function recordingSweeps(): { pool: pg.Pool; batches: number[] } {
    const batches: number[] = [];
    const recording = {
      query: async (sql: string, params?: unknown[]) => {
        const result = await pool.query(sql, params);
        if (/^\s*DELETE FROM kv_store\s+WHERE key = ANY/.test(sql)) batches.push(result.rowCount ?? 0);
        return result;
      },
    };
    return { pool: recording as unknown as pg.Pool, batches };
  }

  it("a sweep deletes at most 1,000 rows per statement and continues until the backlog is gone", async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO kv_store (key, value, expires_at)
       SELECT 'expired:' || i, '0', $1 FROM generate_series(1, 2500) AS i`,
      [now - 1_000]
    );
    await pool.query("INSERT INTO kv_store (key, value, expires_at) VALUES ('live', '1', $1)", [
      now + 3_600_000,
    ]);
    const recorded = recordingSweeps();
    store = new PostgresKVStore(recorded.pool);

    expect(await store.sweepExpired()).toBe(2500);
    expect(recorded.batches).toEqual([1000, 1000, 500]);
    expect(await storedKeys()).toEqual(["live"]);
  });

  it("one sweep deletes at most 100,000 rows and the next continues", async () => {
    await pool.query(
      `INSERT INTO kv_store (key, value, expires_at)
       SELECT 'expired:' || i, '0', $1 FROM generate_series(1, 100500) AS i`,
      [Date.now() - 1_000]
    );
    const recorded = recordingSweeps();
    store = new PostgresKVStore(recorded.pool);

    expect(await store.sweepExpired()).toBe(100_000);
    expect(recorded.batches).toHaveLength(100);
    expect(await store.sweepExpired()).toBe(500);
    expect(await storedKeys()).toEqual([]);
  }, 60_000);

  it("skips a row another transaction holds without waiting and keeps its renewal", async () => {
    const now = Date.now();
    await pool.query(
      "INSERT INTO kv_store (key, value, expires_at) VALUES ('held', '1', $1), ('free', '2', $1)",
      [now - 1_000]
    );
    const renewal = await pool.connect();
    try {
      await renewal.query("BEGIN");
      await renewal.query("UPDATE kv_store SET value = '3', expires_at = $1 WHERE key = 'held'", [
        now + 3_600_000,
      ]);
      store = new PostgresKVStore(pool);

      const outcome = await Promise.race([
        store.sweepExpired(),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]);
      await renewal.query("COMMIT");

      expect(outcome).toBe(1);
    } finally {
      renewal.release();
    }
    await store.close();
    const { rows } = await pool.query<{ key: string; value: number }>(
      "SELECT key, value FROM kv_store"
    );
    expect(rows).toEqual([{ key: "held", value: 3 }]);
  });

  it("never deletes a key renewed while the sweep is running", async () => {
    const now = Date.now();
    await pool.query("INSERT INTO kv_store (key, value, expires_at) VALUES ('k', '1', $1)", [
      now - 1_000,
    ]);
    const renewal = await pool.connect();
    let sweep: Promise<number>;
    try {
      await renewal.query("BEGIN");
      await renewal.query("UPDATE kv_store SET value = '2', expires_at = $1 WHERE key = 'k'", [
        now + 3_600_000,
      ]);
      store = new PostgresKVStore(pool);
      sweep = store.sweepExpired();
      // Commit only after the sweep has read the expired version of the row.
      await new Promise((resolve) => setTimeout(resolve, 500));
      await renewal.query("COMMIT");
    } finally {
      renewal.release();
    }

    await sweep;
    const { rows } = await pool.query<{ key: string; value: number }>(
      "SELECT key, value FROM kv_store"
    );
    expect(rows).toEqual([{ key: "k", value: 2 }]);
  });
});
