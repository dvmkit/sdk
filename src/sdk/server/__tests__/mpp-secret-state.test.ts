import { describe, expect, it } from "vitest";

import {
  applyMppSecretRotation,
  DEFAULT_ROTATION_WINDOW_MS,
  loadMppSecretState,
  type MppSecretStatePool,
} from "../mpp-secret-state";

interface Row {
  active_secret: string;
  previous_secret: string | null;
  previous_expires_at: number | null;
  rapid_rotation_at: number | null;
  updated_at: number;
}

/**
 * In-memory shim of the `mpp_secret_state` table that satisfies the
 * subset of `pg.Pool` used by the store (`query` + `connect` + a tx-scoped
 * `client`). Lets us exercise the boot/load/rotation logic without a live
 * Postgres connection — the DB test covers `FOR UPDATE` serialization.
 */
function memoryPool(): MppSecretStatePool & { __row(): Row | null } {
  let row: Row | null = null;
  let exists = false;

  const runQuery = async (
    text: string,
    params?: unknown[]
  ): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const trimmed = text.trim();
    // The SDK boot lock wraps the DDL — answer it rather than
    // letting it fall through to the row-returning SELECT branch below.
    if (trimmed.startsWith("SELECT pg_advisory_")) return { rows: [] };
    if (
      trimmed.startsWith("CREATE TABLE") ||
      trimmed === "BEGIN" ||
      trimmed === "COMMIT" ||
      trimmed === "ROLLBACK"
    ) {
      return { rows: [] };
    }
    if (trimmed.startsWith("SELECT")) {
      if (!exists || !row) return { rows: [] };
      return { rows: [row] };
    }
    if (trimmed.startsWith("INSERT")) {
      // Mirrors `ON CONFLICT (singleton) DO NOTHING`: an existing row is
      // left alone and the insert reports zero rows affected.
      if (exists) return { rows: [], rowCount: 0 };
      const [active, updatedAt] = params as [string, number];
      row = {
        active_secret: active,
        previous_secret: null,
        previous_expires_at: null,
        rapid_rotation_at: null,
        updated_at: updatedAt,
      };
      exists = true;
      return { rows: [], rowCount: 1 };
    }
    if (trimmed.startsWith("UPDATE")) {
      const [active, previous, expiresAt, rapidAt, updatedAt] = params as [
        string,
        string | null,
        number | null,
        number | null,
        number,
      ];
      row = {
        active_secret: active,
        previous_secret: previous,
        previous_expires_at: expiresAt,
        rapid_rotation_at: rapidAt,
        updated_at: updatedAt,
      };
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${text}`);
  };

  // `connect()` returns a `pg.PoolClient` in production; tests only need
  // `query` + `release`, so we cast through `unknown` to satisfy the
  // store's typed connect call without re-implementing the full client.
  const pool = {
    query: runQuery,
    async connect(): Promise<unknown> {
      return {
        query: runQuery,
        release(): void {},
      };
    },
    __row(): Row | null {
      return row;
    },
  };
  return pool as unknown as MppSecretStatePool & { __row(): Row | null };
}

/**
 * Shim of the losing side of a cold-boot race: the first
 * `SELECT ... FOR UPDATE` sees an empty table, the `INSERT ... ON CONFLICT
 * DO NOTHING` reports zero rows because the other boot committed while it
 * waited, and every read after that sees the winner's row. `__verbs()`
 * exposes the statement keywords in order so a test can assert which branch
 * the re-read fell through to.
 */
function coldBootRaceLoserPool(winner: Row): MppSecretStatePool & { __verbs(): string[] } {
  const verbs: string[] = [];
  let selects = 0;

  const runQuery = async (text: string): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const trimmed = text.trim();
    verbs.push(trimmed.split(/\s+/)[0]);
    if (trimmed.startsWith("SELECT")) {
      selects += 1;
      return selects === 1 ? { rows: [] } : { rows: [winner] };
    }
    if (trimmed.startsWith("INSERT")) return { rows: [], rowCount: 0 };
    return { rows: [] };
  };

  const pool = {
    query: runQuery,
    async connect(): Promise<unknown> {
      return { query: runQuery, release(): void {} };
    },
    __verbs(): string[] {
      return verbs;
    },
  };
  return pool as unknown as MppSecretStatePool & { __verbs(): string[] };
}

describe("mpp_secret_state — unit", () => {
  const secretA = "a".repeat(64);
  const secretB = "b".repeat(64);
  const secretC = "c".repeat(64);
  const t0 = 1_700_000_000_000;
  const window = DEFAULT_ROTATION_WINDOW_MS;

  it("a cold boot that loses the insert race adopts the winner's row", async () => {
    const pool = coldBootRaceLoserPool({
      active_secret: secretA,
      previous_secret: null,
      previous_expires_at: null,
      rapid_rotation_at: null,
      updated_at: t0,
    });
    const result = await applyMppSecretRotation(pool, secretA, window, t0 + 50);
    expect(result.rapidRotation).toBe(false);
    expect(result.state.active).toBe(secretA);
    expect(result.state.previous).toBeNull();
    // Same secret, so the re-read lands on the no-op branch: two locked
    // reads, no UPDATE.
    expect(pool.__verbs()).toEqual(["BEGIN", "SELECT", "INSERT", "SELECT", "COMMIT"]);
  });

  it("a race loser booting a different secret rotates the winner's into previous", async () => {
    const pool = coldBootRaceLoserPool({
      active_secret: secretA,
      previous_secret: null,
      previous_expires_at: null,
      rapid_rotation_at: null,
      updated_at: t0,
    });
    const result = await applyMppSecretRotation(pool, secretB, window, t0 + 50);
    expect(result.state.active).toBe(secretB);
    expect(result.state.previous).toEqual({ secret: secretA, expiresAtMs: t0 + 50 + window });
    expect(result.rapidRotation).toBe(false);
    expect(pool.__verbs()).toContain("UPDATE");
  });

  it("no-op redeploy with the same env secret doesn't touch the row", async () => {
    const pool = memoryPool();
    await applyMppSecretRotation(pool, secretA, window, t0);
    const updatedAtBefore = pool.__row()?.updated_at;
    const result = await applyMppSecretRotation(pool, secretA, window, t0 + 10_000);
    expect(result.rapidRotation).toBe(false);
    expect(result.state.active).toBe(secretA);
    expect(result.state.previous).toBeNull();
    expect(pool.__row()?.updated_at).toBe(updatedAtBefore);
  });

  it("rotation shifts prior active into previous with the rotation window expiry", async () => {
    const pool = memoryPool();
    await applyMppSecretRotation(pool, secretA, window, t0);
    const result = await applyMppSecretRotation(pool, secretB, window, t0 + 1_000);
    expect(result.rapidRotation).toBe(false);
    expect(result.state.active).toBe(secretB);
    expect(result.state.previous).toEqual({
      secret: secretA,
      expiresAtMs: t0 + 1_000 + window,
    });
    expect(result.state.rapidRotationAtMs).toBeNull();
  });

  it("loadMppSecretState filters an expired previous back to null", async () => {
    const pool = memoryPool();
    await applyMppSecretRotation(pool, secretA, window, t0);
    await applyMppSecretRotation(pool, secretB, window, t0 + 1_000);

    const withinWindow = await loadMppSecretState(pool, t0 + 1_000 + window / 2);
    expect(withinWindow?.previous?.secret).toBe(secretA);

    const pastWindow = await loadMppSecretState(pool, t0 + 1_000 + window + 1);
    expect(pastWindow?.previous).toBeNull();
    expect(pastWindow?.active).toBe(secretB);
  });

  it("loadMppSecretState returns null when no row exists", async () => {
    const pool = memoryPool();
    const state = await loadMppSecretState(pool, t0);
    expect(state).toBeNull();
  });

  it("rapid double rotation flags rapidRotation=true and drops the oldest secret", async () => {
    const pool = memoryPool();
    await applyMppSecretRotation(pool, secretA, window, t0);
    await applyMppSecretRotation(pool, secretB, window, t0 + 1_000);
    const result = await applyMppSecretRotation(pool, secretC, window, t0 + 2_000);
    expect(result.rapidRotation).toBe(true);
    expect(result.state.active).toBe(secretC);
    // previous now holds secretB; secretA is dropped (no longer recoverable).
    expect(result.state.previous?.secret).toBe(secretB);
    expect(result.state.rapidRotationAtMs).toBe(t0 + 2_000);
  });

  it("non-rapid rotation after window has elapsed clears rapidRotationAtMs", async () => {
    const pool = memoryPool();
    await applyMppSecretRotation(pool, secretA, window, t0);
    await applyMppSecretRotation(pool, secretB, window, t0 + 1_000);
    const after = await applyMppSecretRotation(pool, secretC, window, t0 + 1_000 + window + 1);
    expect(after.rapidRotation).toBe(false);
    expect(after.state.rapidRotationAtMs).toBeNull();
    expect(after.state.previous?.secret).toBe(secretB);
  });
});
