import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import { PostgresConsumedCredentialStore } from "../postgres-consumed-credential-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const TEST_TABLE = "consumed_credentials_test";
const REALM = "mpp-realm-x";
const TTL = 600;

(RUN ? describe : describe.skip)("PostgresConsumedCredentialStore (real Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresConsumedCredentialStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // gcSampleRate: 0 — GC is exercised by a dedicated test with its own store
    // at rate 1, so the shared instance doesn't race DELETEs with SELECTs.
    store = new PostgresConsumedCredentialStore(pool, { tableName: TEST_TABLE, gcSampleRate: 0 });
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
    const { rows } = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [TEST_TABLE]
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("mark-then-has: unmarked is false, marked is true", async () => {
    expect(await store.has(REALM, "cred-1")).toBe(false);
    await store.mark(REALM, "cred-1", TTL);
    expect(await store.has(REALM, "cred-1")).toBe(true);
  });

  it("distinct (realm, challengeId) pairs are independent", async () => {
    await store.mark(REALM, "cred-1", TTL);
    // Same id, different realm → not consumed.
    expect(await store.has("admin-cashu", "cred-1")).toBe(false);
    // Same realm, different id → not consumed.
    expect(await store.has(REALM, "cred-2")).toBe(false);
  });

  it("expired entries read as not-consumed (TTL enforced via expires_at)", async () => {
    // now seam at a fixed instant; mark with a TTL that lapses by the read.
    let clock = 1_700_000_000_000;
    const ttlStore = new PostgresConsumedCredentialStore(pool, {
      tableName: TEST_TABLE,
      gcSampleRate: 0,
      now: () => clock,
    });
    await ttlStore.mark(REALM, "cred-ttl", 60); // expires at clock + 60_000
    expect(await ttlStore.has(REALM, "cred-ttl")).toBe(true);
    clock += 61_000; // advance past expiry
    expect(await ttlStore.has(REALM, "cred-ttl")).toBe(false);
  });

  it("re-mark refreshes the expiry (ON CONFLICT DO UPDATE)", async () => {
    let clock = 1_700_000_000_000;
    const ttlStore = new PostgresConsumedCredentialStore(pool, {
      tableName: TEST_TABLE,
      gcSampleRate: 0,
      now: () => clock,
    });
    await ttlStore.mark(REALM, "cred-refresh", 60);
    clock += 30_000;
    await ttlStore.mark(REALM, "cred-refresh", 60); // expiry now clock(+30s) + 60s
    clock += 40_000; // 70s past original mark, but only 40s past refresh
    expect(await ttlStore.has(REALM, "cred-refresh")).toBe(true);
  });

  it("GC sweep deletes expired rows on a sampled hit, keeps fresh ones", async () => {
    const clock = 1_700_000_000_000;
    const gcStore = new PostgresConsumedCredentialStore(pool, {
      tableName: TEST_TABLE,
      gcSampleRate: 1, // sweep on every mark
      now: () => clock,
    });
    // Plant a stale row directly (already expired relative to the clock).
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (realm, challenge_id, expires_at) VALUES ($1, $2, $3)`,
      [REALM, "cred-stale", clock - 1000]
    );
    await pool.query(
      `INSERT INTO ${TEST_TABLE} (realm, challenge_id, expires_at) VALUES ($1, $2, $3)`,
      [REALM, "cred-fresh", clock + 600_000]
    );
    // Trigger a sweep via an unrelated mark.
    await gcStore.mark(REALM, "cred-trigger", TTL);

    const deadline = Date.now() + 2000;
    let staleCount = 1;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE challenge_id = 'cred-stale'`
      );
      staleCount = Number(rows[0]?.count ?? "1");
      if (staleCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(staleCount).toBe(0);

    const { rows: fresh } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE challenge_id = 'cred-fresh'`
    );
    expect(Number(fresh[0]?.count ?? "0")).toBe(1);
  });

  it("rejects an invalid table name at construction", () => {
    expect(() => new PostgresConsumedCredentialStore(pool, { tableName: "bad name" })).toThrow();
    expect(
      () => new PostgresConsumedCredentialStore(pool, { tableName: "1leading-digit" })
    ).toThrow();
    expect(() => new PostgresConsumedCredentialStore(pool, { tableName: "drop;table" })).toThrow();
  });

  // The bug closes: a per-process in-memory store lets a captured
  // one-time-use credential be honored once per machine via the load balancer.
  // The Postgres-backed store closes it because the row is visible to every
  // replica sharing the pool.
  describe("cross-machine replay", () => {
    it("in-memory stores (the bug): each machine accepts the same credential once", async () => {
      const machineA = new MemoryConsumedCredentialStore();
      const machineB = new MemoryConsumedCredentialStore();
      // Machine A consumes the credential.
      expect(await machineA.has(REALM, "cred-mm")).toBe(false);
      await machineA.mark(REALM, "cred-mm", TTL);
      expect(await machineA.has(REALM, "cred-mm")).toBe(true);
      // Same credential redirected to machine B is still unseen — replay works.
      expect(await machineB.has(REALM, "cred-mm")).toBe(false);
    });

    it("Postgres stores (the fix): a credential consumed on one machine is seen on the other", async () => {
      const machineA = new PostgresConsumedCredentialStore(pool, {
        tableName: TEST_TABLE,
        gcSampleRate: 0,
      });
      const machineB = new PostgresConsumedCredentialStore(pool, {
        tableName: TEST_TABLE,
        gcSampleRate: 0,
      });
      expect(await machineA.has(REALM, "cred-mm")).toBe(false);
      await machineA.mark(REALM, "cred-mm", TTL);
      // Redirected to machine B: the shared row blocks the replay.
      expect(await machineB.has(REALM, "cred-mm")).toBe(true);
    });
  });
});
