import { withSdkInitLock } from "./init-lock";
import type { AccumulatorPool, AccumulatorQuerier } from "./wallet-accumulator-store";

/**
 * Default rotation window — 5 minutes, matching mppx's `Expires.minutes(5)`
 * default challenge TTL. A credential signed under the previous secret can
 * only be issued from a challenge that hasn't yet expired, so matching the
 * mppx default means the previous-slot window expires no earlier than the
 * last possible valid challenge it could verify.
 */
export const DEFAULT_ROTATION_WINDOW_MS = 5 * 60 * 1_000;

/**
 * Subset of `pg.Pool` used by the mpp-secret-state store. Shares the
 * `AccumulatorPool` / `AccumulatorQuerier` types so the SDK's "pass me a
 * Postgres pool" surface is uniform across stores.
 */
export type MppSecretStatePool = AccumulatorPool;
export type MppSecretStateQuerier = AccumulatorQuerier;

/**
 * Snapshot of the DVM's MPP secret rotation state at a point in time. The
 * SDK verify path reads this on every credential verification — `active` is
 * the env-bound HMAC secret used for signing; `previous` is the prior
 * secret retained for the rotation window so credentials signed before the
 * env change still verify. `rapidRotationAtMs` is set when the most recent
 * rotation overwrote a still-valid previous slot (operator rotated twice
 * inside the window); verify-fail messages surface it so the operator can
 * recognise the rapid-rotation failure mode.
 */
export interface MppSecretState {
  active: string;
  previous: { secret: string; expiresAtMs: number } | null;
  rapidRotationAtMs: number | null;
}

/**
 * Result of `applyMppSecretRotation`. `rapidRotation` is true when the
 * rotation overwrote a previous secret that was still inside its window —
 * the older secret is dropped and any challenge signed with it can no
 * longer be verified.
 */
export interface ApplyMppSecretRotationResult {
  state: MppSecretState;
  rapidRotation: boolean;
}

/**
 * Create the `mpp_secret_state` table if absent. Single-row table — the
 * primary-key `singleton` boolean is constrained to `TRUE` so only one row
 * ever exists. Idempotent: safe to call on every SDK boot.
 */
export async function initMppSecretStateTable(db: MppSecretStatePool): Promise<void> {
  await withSdkInitLock(db, () => createMppSecretStateTable(db));
}

/** The boot DDL itself — always runs under {@link withSdkInitLock}. */
async function createMppSecretStateTable(db: MppSecretStatePool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS mpp_secret_state (
      singleton           BOOLEAN PRIMARY KEY DEFAULT TRUE,
      active_secret       TEXT NOT NULL,
      previous_secret     TEXT,
      previous_expires_at BIGINT,
      rapid_rotation_at   BIGINT,
      updated_at          BIGINT NOT NULL,
      CONSTRAINT mpp_secret_state_singleton CHECK (singleton)
    );
  `);
}

/**
 * Read the current secret state, filtering an expired `previous` slot back
 * to null. Returns `null` when the table is empty (no boot rotation has
 * been applied yet) so callers can distinguish "no row" from "row with no
 * previous". `rapidRotationAtMs` is dropped when it falls outside the
 * rotation window because the operator's grace for debugging the
 * rapid-rotation failure ends when the previous slot itself expires.
 */
export async function loadMppSecretState(
  db: MppSecretStateQuerier,
  now: number = Date.now()
): Promise<MppSecretState | null> {
  const { rows } = await db.query<{
    active_secret: string;
    previous_secret: string | null;
    previous_expires_at: number | string | null;
    rapid_rotation_at: number | string | null;
  }>(
    `SELECT active_secret, previous_secret, previous_expires_at, rapid_rotation_at
       FROM mpp_secret_state
       WHERE singleton = TRUE`
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const previousExpiresAt =
    row.previous_expires_at == null ? null : Number(row.previous_expires_at);
  const previous =
    row.previous_secret != null && previousExpiresAt != null && previousExpiresAt > now
      ? { secret: row.previous_secret, expiresAtMs: previousExpiresAt }
      : null;
  const rapidRotationAtRaw = row.rapid_rotation_at == null ? null : Number(row.rapid_rotation_at);
  const rapidRotationAtMs =
    rapidRotationAtRaw != null && previous != null ? rapidRotationAtRaw : null;
  return {
    active: row.active_secret,
    previous,
    rapidRotationAtMs,
  };
}

/**
 * Serialize warm rotations with a row lock. Cold insert losers re-read under
 * that lock before applying their secret; there was no row to lock initially.
 * A rotation within the previous key's window displaces that older key and
 * records rapid rotation for verification diagnostics.
 */
export async function applyMppSecretRotation(
  db: MppSecretStatePool,
  envSecret: string,
  rotationWindowMs: number,
  now: number = Date.now()
): Promise<ApplyMppSecretRotationResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const lockedRead = async (): Promise<StoredRow[]> => {
      const { rows } = await client.query<StoredRow>(
        `SELECT active_secret, previous_secret, previous_expires_at, rapid_rotation_at
           FROM mpp_secret_state
           WHERE singleton = TRUE
           FOR UPDATE`
      );
      return rows;
    };

    let rows = await lockedRead();

    if (rows.length === 0) {
      const inserted = await client.query(
        `INSERT INTO mpp_secret_state
           (singleton, active_secret, previous_secret, previous_expires_at, rapid_rotation_at, updated_at)
           VALUES (TRUE, $1, NULL, NULL, NULL, $2)
           ON CONFLICT (singleton) DO NOTHING`,
        [envSecret, now]
      );
      if ((inserted.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return {
          state: { active: envSecret, previous: null, rapidRotationAtMs: null },
          rapidRotation: false,
        };
      }
      // Lost the cold-boot race. `DO NOTHING` waited out the conflicting
      // insert, so reporting zero rows means that boot committed — re-read
      // under the lock and continue as if the row had been there all along.
      rows = await lockedRead();
      if (rows.length === 0) {
        throw new Error(
          "mpp_secret_state: cold-boot insert conflicted but no row is visible afterwards"
        );
      }
    }

    const row = rows[0];
    if (row.active_secret === envSecret) {
      // No-op redeploy. Don't touch the row — preserves an in-flight
      // rotation window across same-secret boots.
      await client.query("COMMIT");
      const previousExpiresAt =
        row.previous_expires_at == null ? null : Number(row.previous_expires_at);
      const previous =
        row.previous_secret != null && previousExpiresAt != null && previousExpiresAt > now
          ? { secret: row.previous_secret, expiresAtMs: previousExpiresAt }
          : null;
      const rapidRotationAtRaw =
        row.rapid_rotation_at == null ? null : Number(row.rapid_rotation_at);
      const rapidRotationAtMs =
        rapidRotationAtRaw != null && previous != null ? rapidRotationAtRaw : null;
      return {
        state: { active: envSecret, previous, rapidRotationAtMs },
        rapidRotation: false,
      };
    }

    // Genuine rotation: shift active → previous, install env as active.
    const prevExpiresAtPrior =
      row.previous_expires_at == null ? null : Number(row.previous_expires_at);
    const rapidRotation =
      row.previous_secret != null && prevExpiresAtPrior != null && prevExpiresAtPrior > now;
    const previousExpiresAt = now + rotationWindowMs;
    const rapidRotationAt = rapidRotation ? now : null;
    await client.query(
      `UPDATE mpp_secret_state
         SET active_secret = $1,
             previous_secret = $2,
             previous_expires_at = $3,
             rapid_rotation_at = $4,
             updated_at = $5
         WHERE singleton = TRUE`,
      [envSecret, row.active_secret, previousExpiresAt, rapidRotationAt, now]
    );
    await client.query("COMMIT");
    return {
      state: {
        active: envSecret,
        previous: { secret: row.active_secret, expiresAtMs: previousExpiresAt },
        rapidRotationAtMs: rapidRotationAt,
      },
      rapidRotation,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // connection may already be torn down
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Raw `mpp_secret_state` row shape; BIGINT columns arrive as strings. */
interface StoredRow {
  active_secret: string;
  previous_secret: string | null;
  previous_expires_at: number | string | null;
  rapid_rotation_at: number | string | null;
}
