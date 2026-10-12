/** Real Postgres insert/row-lock contention, beyond the fake-pool branch tests. */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  applyMppSecretRotation,
  DEFAULT_ROTATION_WINDOW_MS,
  initMppSecretStateTable,
  loadMppSecretState,
} from "../mpp-secret-state";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const secretA = "a".repeat(64);
const secretB = "b".repeat(64);
const secretC = "c".repeat(64);

/** Warm both sockets so TCP/auth setup does not serialize the intended race. */
async function warmPoolClients(dbPool: pg.Pool, count: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: count }, () => dbPool.connect()));
  for (const client of clients) {
    client.release();
  }
}

(RUN ? describe : describe.skip)("mpp_secret_state (real Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await initMppSecretStateTable(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE mpp_secret_state");
  });

  it("cold boot inserts envSecret as active; loadMppSecretState reflects it", async () => {
    const now = Date.now();
    const result = await applyMppSecretRotation(pool, secretA, DEFAULT_ROTATION_WINDOW_MS, now);
    expect(result.state.active).toBe(secretA);
    expect(result.state.previous).toBeNull();

    const state = await loadMppSecretState(pool, now);
    expect(state?.active).toBe(secretA);
    expect(state?.previous).toBeNull();
  });

  it("two concurrent boots with the same secret serialize to a single insert", async () => {
    const now = Date.now();
    await warmPoolClients(pool, 2);
    const [a, b] = await Promise.all([
      applyMppSecretRotation(pool, secretA, DEFAULT_ROTATION_WINDOW_MS, now),
      applyMppSecretRotation(pool, secretA, DEFAULT_ROTATION_WINDOW_MS, now + 50),
    ]);
    expect(a.state.active).toBe(secretA);
    expect(b.state.active).toBe(secretA);
    expect(a.state.previous).toBeNull();
    expect(b.state.previous).toBeNull();

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM mpp_secret_state"
    );
    expect(rows[0].count).toBe("1");
  });

  it("two concurrent boots with different secrets serialize via FOR UPDATE", async () => {
    const now = Date.now();
    // Seed first so both racers see an existing row to lock against.
    await applyMppSecretRotation(pool, secretA, DEFAULT_ROTATION_WINDOW_MS, now);

    await warmPoolClients(pool, 2);
    const [r1, r2] = await Promise.all([
      applyMppSecretRotation(pool, secretB, DEFAULT_ROTATION_WINDOW_MS, now + 100),
      applyMppSecretRotation(pool, secretC, DEFAULT_ROTATION_WINDOW_MS, now + 101),
    ]);

    // One of them wins the second slot. Whichever lost must see the
    // winner's secret already in `active`, so its own write demotes the
    // winner into `previous` rather than secretA. Net: exactly one row,
    // active = whoever ran second, previous = whoever ran first.
    const winners = new Set([r1.state.active, r2.state.active]);
    expect(winners.size).toBe(2);
    expect(winners.has(secretB)).toBe(true);
    expect(winners.has(secretC)).toBe(true);

    const state = await loadMppSecretState(pool, now + 200);
    // The DB's final state matches one of the two boot orderings: the
    // race winner's secret ends up as active; the loser's secret ends up
    // as previous (because the second writer demoted it). secretA is
    // always demoted on the first non-A rotation and dropped on the
    // second (rapid double rotation).
    expect(state?.active).toBeDefined();
    expect([secretB, secretC]).toContain(state?.active);
    if (state?.active === secretB) {
      expect(state.previous?.secret).toBe(secretC);
    } else {
      expect(state?.previous?.secret).toBe(secretB);
    }
  });

  it("rotation persists rapid_rotation_at across reads when within the window", async () => {
    const now = Date.now();
    await applyMppSecretRotation(pool, secretA, DEFAULT_ROTATION_WINDOW_MS, now);
    await applyMppSecretRotation(pool, secretB, DEFAULT_ROTATION_WINDOW_MS, now + 1_000);
    const result = await applyMppSecretRotation(
      pool,
      secretC,
      DEFAULT_ROTATION_WINDOW_MS,
      now + 2_000
    );
    expect(result.rapidRotation).toBe(true);

    const state = await loadMppSecretState(pool, now + 2_500);
    expect(state?.rapidRotationAtMs).toBe(now + 2_000);
    expect(state?.previous?.secret).toBe(secretB);
  });
});
