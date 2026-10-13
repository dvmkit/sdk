import type { Pool } from "pg";

import { type LockPubkey, toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { withSdkInitLock } from "./init-lock";
import type { AccumulatorPool, AccumulatorQuerier } from "./wallet-accumulator-store";

export { type LockPubkey, toLockPubkey } from "../../lib/cashu/lock-pubkey";

/**
 * Snapshot of a DVM's published lock-pubkey state at a point in time. `current`
 * is what the SDK advertises as `cashu.lock_pubkeys[0]`; `retired` are the
 * pubkeys inside the rotation grace window plus legacy sentinel-0 entries
 * kept until explicitly cleaned up. Both halves are needed by the
 * receive path (accept proofs locked to any entry) and the admin auth verifier
 * (accept signatures from any entry during grace).
 */
export interface LockPubkeyState {
  current: LockPubkey;
  retired: { pubkey: LockPubkey; retiredAtMs: number }[];
}

/**
 * Lazy accessor for the DVM's lock-pubkey state. Threaded through the SDK
 * server so call sites (info handler, accept flow, admin auth) read the fresh
 * state on every invocation — rotation propagation has to be visible without
 * a process restart.
 */
export type LockPubkeyStateLoader = () => Promise<LockPubkeyState>;

export type LockPubkeyPool = AccumulatorPool;

/**
 * Create the `dvm_lock_pubkeys` table if absent. Each row is one entry in a
 * DVM's lock-pubkey lifecycle: `retired_at_ms IS NULL` is the current pubkey,
 * any non-null value is a retired pubkey that the rotation walker can still
 * derive privkeys for. One current row per `dvm_id` is enforced via a partial
 * unique index — keeps `rotateLockPubkey` honest under concurrent calls.
 */
export async function initLockPubkeyTable(db: LockPubkeyPool): Promise<void> {
  await withSdkInitLock(db, () => createLockPubkeyTable(db));
}

async function createLockPubkeyTable(db: LockPubkeyPool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS dvm_lock_pubkeys (
      id              BIGSERIAL PRIMARY KEY,
      dvm_id          TEXT NOT NULL,
      pubkey          TEXT NOT NULL,
      retired_at_ms   BIGINT,
      created_at_ms   BIGINT NOT NULL
    );
  `);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS dvm_lock_pubkeys_current_uidx
       ON dvm_lock_pubkeys(dvm_id)
       WHERE retired_at_ms IS NULL;`
  );
  await db.query(
    `CREATE INDEX IF NOT EXISTS dvm_lock_pubkeys_dvm_id_idx
       ON dvm_lock_pubkeys(dvm_id, retired_at_ms);`
  );
}

/**
 * Idempotent first-boot seed. Inserts `pubkey` as the current row for `dvmId`
 * only when no current row exists. Reseeding with a different pubkey is a
 * no-op — once the DB has state, `rotateLockPubkey` is the only sanctioned
 * mutator, so a stale `DVMKIT_CASHU_LOCK_PUBKEY` env on a redeploy can't
 * silently reset the DVM's view of "what's current".
 *
 * Also backfills any distinct `lock_pubkey` values found in
 * `wallet_accumulator` for this DVM that aren't yet in `dvm_lock_pubkeys`,
 * inserting them as retired rows with `retired_at_ms = 0` — the
 * "long-retired-still-meltable" sentinel. This handles legacy batches
 * that would otherwise trip the monitor's `orphan_lock_pubkey` alarm every
 * tick. Sentinel-0 rows are exempt from grace-window filtering and
 * `pruneRetired` so they stay visible until the operator melts the legacy
 * batches and the receive path keeps accepting in-flight tokens locked to
 * them.
 *
 * `ON CONFLICT DO NOTHING` protects concurrent seeds invoked reentrantly from
 * one guarded callback. Nested calls bypass the queue to avoid deadlock, so
 * both inserts can pass `WHERE NOT EXISTS` before either commits.
 */
export async function seedLockPubkeyState(
  db: LockPubkeyPool,
  dvmId: string,
  pubkey: string,
  now: number = Date.now()
): Promise<void> {
  await withSdkInitLock(db, () => seedLockPubkeyRows(db, dvmId, pubkey, now));
}

async function seedLockPubkeyRows(
  db: LockPubkeyPool,
  dvmId: string,
  pubkey: string,
  now: number
): Promise<void> {
  await db.query(
    `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
       SELECT $1, $2, NULL, $3
       WHERE NOT EXISTS (
         SELECT 1 FROM dvm_lock_pubkeys WHERE dvm_id = $1 AND retired_at_ms IS NULL
       )
     ON CONFLICT (dvm_id) WHERE retired_at_ms IS NULL DO NOTHING;`,
    [dvmId, toLockPubkey(pubkey), now]
  );
  // Best-effort: if `wallet_accumulator` doesn't exist yet (e.g. a fresh DB
  // where init order ran lock-pubkey first), skip silently.
  try {
    await db.query(
      `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
         SELECT $1, a.lock_pubkey, 0, $2
           FROM (SELECT DISTINCT lock_pubkey FROM wallet_accumulator WHERE dvm_id = $1) a
          WHERE NOT EXISTS (
            SELECT 1 FROM dvm_lock_pubkeys d
              WHERE d.dvm_id = $1 AND d.pubkey = a.lock_pubkey
          );`,
      [dvmId, now]
    );
  } catch (err) {
    // Missing `wallet_accumulator` (Postgres error code 42P01 = undefined_table)
    // is the only expected case here — anything else surfaces.
    if (!(typeof err === "object" && err !== null && (err as { code?: string }).code === "42P01")) {
      throw err;
    }
  }
}

/**
 * Read the active lock-pubkey state for a DVM. Retired rows older than the
 * grace window are filtered out; aged-out rows linger physically until
 * `pruneRetired` deletes them on a monitor tick. Sentinel-0 rows (the
 * `retired_at_ms = 0` legacy backfill from `seedLockPubkeyState`) are always
 * included regardless of grace. Throws when no current row exists — the SDK's
 * accept/info/admin paths must not run before `seedLockPubkeyState` has been
 * called.
 */
export async function loadLockPubkeyState(
  db: AccumulatorQuerier,
  dvmId: string,
  graceMs: number,
  now: number = Date.now()
): Promise<LockPubkeyState> {
  const { rows } = await db.query<{
    pubkey: string;
    retired_at_ms: number | string | null;
  }>(
    `SELECT pubkey, retired_at_ms
       FROM dvm_lock_pubkeys
       WHERE dvm_id = $1
         AND (retired_at_ms IS NULL OR retired_at_ms = 0 OR retired_at_ms > $2)
       ORDER BY retired_at_ms ASC NULLS FIRST`,
    [dvmId, now - graceMs]
  );
  let current: LockPubkey | null = null;
  const retired: { pubkey: LockPubkey; retiredAtMs: number }[] = [];
  for (const r of rows) {
    if (r.retired_at_ms == null) {
      current = toLockPubkey(r.pubkey);
    } else {
      retired.push({ pubkey: toLockPubkey(r.pubkey), retiredAtMs: Number(r.retired_at_ms) });
    }
  }
  if (current == null) {
    throw new Error(
      `dvm_lock_pubkeys: no current pubkey for dvm_id=${dvmId} — seedLockPubkeyState was not called.`
    );
  }
  return { current, retired };
}

/**
 * Atomically demote the current pubkey to retired (stamping `retired_at_ms`)
 * and insert `newPubkey` as the new current row. Wrapped in a transaction so
 * the partial unique index never has two current rows visible mid-rotation.
 * Returns the post-rotation state filtered by the supplied grace window.
 */
export async function rotateLockPubkey(
  db: LockPubkeyPool,
  dvmId: string,
  newPubkey: string,
  graceMs: number,
  now: number = Date.now()
): Promise<LockPubkeyState> {
  const normalised = toLockPubkey(newPubkey);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ pubkey: string }>(
      `SELECT pubkey FROM dvm_lock_pubkeys
         WHERE dvm_id = $1 AND retired_at_ms IS NULL
         FOR UPDATE`,
      [dvmId]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      throw new Error(
        `dvm_lock_pubkeys: cannot rotate dvm_id=${dvmId} — no current pubkey exists.`
      );
    }
    if (rows[0].pubkey === normalised) {
      // Rotation to the same pubkey is a no-op rather than an error so the
      // CLI flow doesn't have to special-case "I already pushed this".
      await client.query("ROLLBACK");
      return await loadLockPubkeyState(db, dvmId, graceMs, now);
    }
    await client.query(
      `UPDATE dvm_lock_pubkeys SET retired_at_ms = $2
         WHERE dvm_id = $1 AND retired_at_ms IS NULL`,
      [dvmId, now]
    );
    await client.query(
      `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
         VALUES ($1, $2, NULL, $3)`,
      [dvmId, normalised, now]
    );
    await client.query("COMMIT");
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
  return loadLockPubkeyState(db, dvmId, graceMs, now);
}

/**
 * Delete retired rows whose `retired_at_ms` is older than `now - graceMs`.
 * Called from the monitor tick so aged-out entries don't accumulate.
 * `wallet_accumulator` rows pointing at those pubkeys remain meltable (the
 * builder can still derive the privkey from the mnemonic + rotation_index) —
 * pruning only affects what the DVM advertises and accepts.
 *
 * Sentinel-0 rows (the legacy backfill from `seedLockPubkeyState`) are
 * exempted from pruning — they exist precisely so the monitor keeps treating
 * legacy `wallet_accumulator` batches as retired-still-meltable rather than
 * orphan.
 */
export async function pruneRetired(
  db: AccumulatorQuerier,
  dvmId: string,
  graceMs: number,
  now: number = Date.now()
): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM dvm_lock_pubkeys
       WHERE dvm_id = $1
         AND retired_at_ms IS NOT NULL
         AND retired_at_ms > 0
         AND retired_at_ms <= $2`,
    [dvmId, now - graceMs]
  );
  return rowCount ?? 0;
}

/**
 * Default rotation grace window in seconds. Override through
 * `SDKServerOpts.lockPubkeyGraceSeconds`.
 */
export const DEFAULT_LOCK_PUBKEY_GRACE_SECONDS = 86_400;

export function activePubkeySet(state: LockPubkeyState): LockPubkey[] {
  return [state.current, ...state.retired.map((r) => r.pubkey)];
}

export type { Pool };
