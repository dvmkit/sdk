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

  it("a sweep larger than one batch deletes every expired row", async () => {
    const now = Date.now();
    await pool.query(
      `INSERT INTO kv_store (key, value, expires_at)
       SELECT 'expired:' || i, '0', $1 FROM generate_series(1, 2500) AS i`,
      [now - 1_000]
    );
    await pool.query("INSERT INTO kv_store (key, value, expires_at) VALUES ('live', '1', $1)", [
      now + 3_600_000,
    ]);
    store = new PostgresKVStore(pool);

    expect(await store.sweepExpired()).toBe(2500);
    expect(await storedKeys()).toEqual(["live"]);
  });
});
