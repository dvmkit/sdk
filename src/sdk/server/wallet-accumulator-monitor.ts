import { diagnosticConsole } from "../../observability/diagnostic-console";
import { type Pool, type PoolClient } from "pg";

import { type LockPubkey, toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { getKeysetFinalExpiry } from "../../lib/cashu/mint-info";
import {
  DEFAULT_LOCK_PUBKEY_GRACE_SECONDS,
  type LockPubkeyState,
  type LockPubkeyStateLoader,
  pruneRetired,
} from "./lock-pubkey-store";
import {
  type AccumulatorBatch,
  type AccumulatorQuerier,
  hashLockKey,
  listPendingBatches,
} from "./wallet-accumulator-store";

/** Tick cadence — every 30 seconds (§6.4 of cashu-integration-from-first-principles). */
export const DEFAULT_TICK_INTERVAL_MS = 30_000;

/**
 * Emit `wallet_accumulator_batch_expiring_soon` once a batch's earliest
 * NUT-11 `t_expire` falls within this window. 36h gives the builder roughly
 * one business day to run `dvmctl melt-pending` before agents could attempt
 * refund-races at the mint.
 */
export const EXPIRING_SOON_THRESHOLD_MS = 36 * 60 * 60 * 1000;

/**
 * The expiring-soon threshold for a DVM whose shortest enforced lock window
 * is `shortestLockWindowSeconds`: 36h, or half that window when it is
 * shorter. Half keeps an honest payment at the floor silent on arrival while
 * still warning with half its window left before the earliest deadline. The
 * default windows (518400s) leave the threshold at 36h.
 */
export function expiringSoonThresholdMs(shortestLockWindowSeconds: number): number {
  return Math.min(EXPIRING_SOON_THRESHOLD_MS, Math.max(0, shortestLockWindowSeconds) * 500);
}

export interface AccumulatorMonitorOpts {
  /** Pool that exposes both `query` and `connect` (used for advisory locks). */
  pool: Pool;
  /** DVM identifier — used to derive the advisory-lock key. */
  dvmId: string;
  /** How often the monitor ticks. Default 30s. */
  tickIntervalMs?: number;
  /**
   * Live lock-pubkey state loader. Each tick reads the current +
   * retired-in-grace set, prunes aged-out retired entries, and emits a
   * `wallet_accumulator_batch_retired_lock_pubkey` event for batches whose
   * `lock_pubkey` is retired-but-still-in-grace. Omitted on legacy/test wiring
   * that branch only runs the expiry/reap sweeps.
   */
  getLockPubkeyState?: LockPubkeyStateLoader;
  /**
   * Rotation grace window (seconds). Required when `getLockPubkeyState` is set
   * drives the prune sweep. Defaults to 24h.
   */
  lockPubkeyGraceSeconds?: number;
  /** When a batch counts as expiring soon. Defaults to {@link EXPIRING_SOON_THRESHOLD_MS}. */
  expiringSoonThresholdMs?: number;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

export interface AccumulatorMonitorHandle {
  /** Force one tick immediately — for tests and operator-triggered drains. */
  runOnce(): Promise<void>;
  stop(): void;
}

/**
 * Start the periodic accumulator monitor. Each tick wraps in
 * `pg_try_advisory_lock(hashLockKey('wallet_accumulator:' + dvmId))` so a
 * single replica owns the emit — others ride out the tick.
 *
 * The monitor never melts: it walks unmelted accumulator batches, emits
 * structured logs for batches whose NUT-11 `t_expire` is near or past,
 * and reaps rows whose mint keyset has aged past `final_expiry`.
 * Melt itself runs builder-local via `dvmctl melt-pending`.
 */
export function startAccumulatorMonitor(opts: AccumulatorMonitorOpts): AccumulatorMonitorHandle {
  const tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const lockKey = hashLockKey(`wallet_accumulator:${opts.dvmId}`);

  let stopped = false;
  let inFlight: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;
    if (inFlight) return inFlight;
    inFlight = (async (): Promise<void> => {
      try {
        await runTick({
          ...opts,
          now,
          lockKey,
          graceSeconds: opts.lockPubkeyGraceSeconds ?? DEFAULT_LOCK_PUBKEY_GRACE_SECONDS,
          expiringSoonThresholdMs: opts.expiringSoonThresholdMs ?? EXPIRING_SOON_THRESHOLD_MS,
        });
      } catch (_err) {
        diagnosticConsole.error(
          {
            level: "wallet_accumulator_tick_error",
            dvmId: opts.dvmId,
            error: undefined,
          }
        );
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const timer = setInterval(() => {
    void tick();
  }, tickMs);
  // Don't keep the event loop alive if nothing else is.
  if (typeof timer.unref === "function") timer.unref();

  return {
    runOnce: tick,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

interface ResolvedTickOpts {
  pool: Pool;
  dvmId: string;
  now: () => number;
  lockKey: bigint;
  getLockPubkeyState?: LockPubkeyStateLoader;
  graceSeconds: number;
  expiringSoonThresholdMs: number;
}

async function runTick(opts: ResolvedTickOpts): Promise<void> {
  // Keep the per-DVM session lock on one checked-out client; unlock before releasing it.
  const client = await opts.pool.connect();
  try {
    const { rows } = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS acquired`,
      [opts.lockKey.toString()]
    );
    if (!rows[0]?.acquired) {
      return;
    }
    try {
      // Lock-pubkey housekeeping runs before expiry/reap so the
      // retired-batch event reflects the post-prune state. Failures here
      // (e.g. table missing on legacy DVMs) shouldn't block the other sweeps.
      let activeState: LockPubkeyState | null = null;
      if (opts.getLockPubkeyState) {
        try {
          await pruneRetired(client, opts.dvmId, opts.graceSeconds * 1000, opts.now());
          activeState = await opts.getLockPubkeyState();
        } catch (_err) {
          diagnosticConsole.error(
            {
              level: "wallet_accumulator_lock_pubkey_prune_failed",
              dvmId: opts.dvmId,
              error: undefined,
            }
          );
        }
      }
      await emitExpiryEvents(opts, client, activeState);
      await reapExpiredKeysetRows(opts, client);
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [opts.lockKey.toString()]);
    }
  } finally {
    client.release();
  }
}

async function emitExpiryEvents(
  opts: ResolvedTickOpts,
  db: AccumulatorQuerier,
  activeState: LockPubkeyState | null
): Promise<void> {
  const batches = await listPendingBatches(db, opts.dvmId);
  if (batches.length === 0) return;
  const now = opts.now();
  const retiredMap = new Map<LockPubkey, number>();
  if (activeState) {
    for (const r of activeState.retired) {
      retiredMap.set(r.pubkey, r.retiredAtMs);
    }
  }
  const currentPubkey: LockPubkey | null = activeState ? activeState.current : null;
  for (const batch of batches) {
    if (activeState) {
      const batchPubkey = toLockPubkey(batch.lockPubkey);
      const retiredAtMs = retiredMap.get(batchPubkey);
      if (retiredAtMs != null) {
        emitRetiredLockPubkey(opts.dvmId, batch, retiredAtMs);
      } else if (currentPubkey != null && batchPubkey !== currentPubkey) {
        // Batch locked to a pubkey that's neither current nor in the grace
        // window. The retired row was pruned (or never seeded) — agents can
        // no longer pay this rail, but the batch is still meltable via the
        // rotation walker in `dvmctl melt-pending`. Surface a distinct event
        // so an operator who missed the grace window still gets nudged.
        emitOrphanBatch(opts.dvmId, batch);
      }
    }
    if (batch.oldestTExpire == null) continue;
    const delta = batch.oldestTExpire - now;
    if (delta < 0) {
      emitExpired(opts.dvmId, batch, -delta);
    } else if (delta < opts.expiringSoonThresholdMs) {
      emitExpiringSoon(opts.dvmId, batch, delta);
    }
  }
}

function emitRetiredLockPubkey(dvmId: string, batch: AccumulatorBatch, retiredAtMs: number): void {
  diagnosticConsole.log(
    {
      level: "wallet_accumulator_batch_retired_lock_pubkey",
      dvmId,
      mintUrl: batch.mintUrl,
      lockPubkey: batch.lockPubkey,
      retiredAtMs,
      totalSats: batch.totalSats,
      rowIds: batch.rowIds,
    }
  );
}

function emitOrphanBatch(dvmId: string, batch: AccumulatorBatch): void {
  diagnosticConsole.log(
    {
      level: "wallet_accumulator_batch_orphan_lock_pubkey",
      dvmId,
      mintUrl: batch.mintUrl,
      lockPubkey: batch.lockPubkey,
      totalSats: batch.totalSats,
      rowIds: batch.rowIds,
    }
  );
}

function emitExpired(dvmId: string, batch: AccumulatorBatch, tExpiredAgoMs: number): void {
  diagnosticConsole.log(
    {
      level: "wallet_accumulator_batch_expired",
      dvmId,
      mintUrl: batch.mintUrl,
      lockPubkey: batch.lockPubkey,
      totalSats: batch.totalSats,
      rowIds: batch.rowIds,
      tExpiredAgoMs,
    }
  );
}

function emitExpiringSoon(dvmId: string, batch: AccumulatorBatch, timeToExpireMs: number): void {
  diagnosticConsole.log(
    {
      level: "wallet_accumulator_batch_expiring_soon",
      dvmId,
      mintUrl: batch.mintUrl,
      lockPubkey: batch.lockPubkey,
      totalSats: batch.totalSats,
      rowIds: batch.rowIds,
      timeToExpireMs,
    }
  );
}

/**
 * reaper: drop accumulator rows whose mint keyset has passed
 * `final_expiry`. At that point the mint has likely GC'd its own spent-set,
 * so `UNIQUE(dvm_id, proof_secret_hash)` loses enforcement meaning and
 * holding the row only blooms the table. Network failures on
 * `getKeysetFinalExpiry` return `undefined` and the row is preserved —
 * dropping a row on a transient mint outage would be worse than carrying
 * dead state another tick.
 */
async function reapExpiredKeysetRows(
  opts: ResolvedTickOpts,
  db: AccumulatorQuerier
): Promise<void> {
  const { rows } = await db.query<{ mint_url: string; proof_keyset_id: string }>(
    `SELECT DISTINCT mint_url, proof_keyset_id
       FROM wallet_accumulator
       WHERE dvm_id = $1`,
    [opts.dvmId]
  );
  if (rows.length === 0) return;
  const nowSec = Math.floor(opts.now() / 1000);
  for (const { mint_url, proof_keyset_id } of rows) {
    const finalExpiry = await getKeysetFinalExpiry(mint_url, proof_keyset_id);
    if (finalExpiry === undefined || finalExpiry > nowSec) continue;
    const { rowCount } = await db.query(
      `DELETE FROM wallet_accumulator
         WHERE dvm_id = $1 AND mint_url = $2 AND proof_keyset_id = $3`,
      [opts.dvmId, mint_url, proof_keyset_id]
    );
    if ((rowCount ?? 0) > 0) {
      diagnosticConsole.log(
        {
          level: "wallet_accumulator_reaped_expired_keyset",
          dvmId: opts.dvmId,
          mintUrl: mint_url,
          keysetId: proof_keyset_id,
          finalExpiry,
          rowCount,
        }
      );
    }
  }
}

/** Claim a session-level advisory lock and return the client. Test helper. */
export async function _acquireLockForTest(
  pool: Pool,
  dvmId: string
): Promise<{ client: PoolClient; release: () => Promise<void>; acquired: boolean }> {
  const lockKey = hashLockKey(`wallet_accumulator:${dvmId}`);
  const client = await pool.connect();
  const { rows } = await client.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS acquired`,
    [lockKey.toString()]
  );
  return {
    client,
    acquired: rows[0]?.acquired ?? false,
    async release() {
      await client.query(`SELECT pg_advisory_unlock($1)`, [lockKey.toString()]);
      client.release();
    },
  };
}
