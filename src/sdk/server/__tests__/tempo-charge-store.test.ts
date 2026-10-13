import { describe, expect, it } from "vitest";

import { PostgresTempoChargeStore } from "../tempo-charge-store";

const HASH_KEY = `mppx:charge:0x${"ab".repeat(32)}`;

/** A pool stand-in that records the SQL it is handed and answers a fixed row set. */
function fakePool(rows: { value_json: string }[] = []): {
  pool: never;
  sql: string[];
  params: unknown[][];
} {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const query = (text: string, values?: unknown[]) => {
    sql.push(text.trim());
    params.push(values ?? []);
    return Promise.resolve({ rows: /SELECT value_json/.test(text) ? rows : [] });
  };
  const client = { query, release: () => undefined };
  return {
    pool: { query, connect: () => Promise.resolve(client) } as never,
    sql,
    params,
  };
}

describe("PostgresTempoChargeStore", () => {
  it("rejects a table name that isn't a bare identifier", () => {
    const { pool } = fakePool();
    expect(() => new PostgresTempoChargeStore(pool, { tableName: "bad name" })).toThrow();
    expect(() => new PostgresTempoChargeStore(pool, { tableName: "1leading" })).toThrow();
    expect(() => new PostgresTempoChargeStore(pool, { tableName: "drop;table" })).toThrow();
  });

  it("keeps its atomic actions bound when mppx captures them as callbacks", async () => {
    const { pool } = fakePool();
    const store = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    const update = store.update;
    const get = store.get;
    await expect(update(HASH_KEY, () => ({ op: "set", value: 1, result: true }))).resolves.toBe(
      true
    );
    await expect(get(HASH_KEY)).resolves.toBeNull();
  });

  it("reads a miss as null, which is mppx's 'not yet used' sentinel", async () => {
    const { pool } = fakePool();
    const store = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    await expect(store.get(HASH_KEY)).resolves.toBeNull();
  });

  it("takes the advisory lock before the row lock, so a first write can't double-win", async () => {
    const { pool, sql } = fakePool();
    const store = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    await store.update(HASH_KEY, () => ({ op: "set", value: 1, result: undefined }));
    const verbs = sql.map((text) => text.split("\n")[0]);
    const lock = verbs.findIndex((text) => text.includes("pg_advisory_xact_lock"));
    const select = verbs.findIndex((text) => text.includes("FOR UPDATE"));
    expect(lock).toBeGreaterThan(-1);
    expect(select).toBeGreaterThan(lock);
    expect(verbs[0]).toBe("BEGIN");
    expect(verbs.at(-1)).toBe("COMMIT");
  });

  it("stamps a write's expiry at now + retention", async () => {
    const { pool, sql, params } = fakePool();
    const store = new PostgresTempoChargeStore(pool, {
      gcSampleRate: 0,
      retentionMs: 60_000,
      now: () => 1_700_000_000_000,
    });
    await store.update(HASH_KEY, () => ({ op: "set", value: 7, result: undefined }));
    const insert = sql.findIndex((text) => text.startsWith("INSERT INTO"));
    expect(params[insert]).toEqual([HASH_KEY, "7", 1_700_000_060_000]);
  });

  it("writes nothing on a noop change", async () => {
    const { pool, sql } = fakePool([{ value_json: "1" }]);
    const store = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    // mppx's `markHashUsed` against an already-consumed hash.
    await expect(
      store.update(HASH_KEY, (current) =>
        current !== null
          ? { op: "noop", result: false }
          : { op: "set", value: Date.now(), result: true }
      )
    ).resolves.toBe(false);
    expect(sql.some((text) => text.startsWith("INSERT INTO"))).toBe(false);
    expect(sql.some((text) => text.startsWith("DELETE FROM"))).toBe(false);
  });

  it("rolls back and rethrows when the change function throws", async () => {
    const { pool, sql } = fakePool();
    const store = new PostgresTempoChargeStore(pool, { gcSampleRate: 0 });
    await expect(
      store.update(HASH_KEY, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(sql.at(-1)).toBe("ROLLBACK");
  });
});
