import type { Pool } from "pg";

import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { KVStore } from "../types";
import { withSdkInitLock } from "./init-lock";

const KV_EXPIRY_SWEEP_INTERVAL_MS = 60_000;
const KV_EXPIRY_SWEEP_BATCH_SIZE = 1_000;
// Statements one sweep runs at most; a larger backlog continues next interval.
const KV_EXPIRY_SWEEP_MAX_BATCHES = 100;

/** Expiry sweep tuning for a directly constructed {@link PostgresKVStore}. */
export interface PostgresKVStoreOpts {
  /**
   * Milliseconds between expiry sweeps. Defaults to 60,000. While the store
   * is running, the worst-case delay between a row's expiry and its deletion
   * is one interval while fewer than 100,000 rows expire per interval.
   */
  sweepIntervalMs?: number;
}

/**
 * Postgres-backed KVStore. Requires the `pg` package as a peer dependency.
 *
 * Expired rows are hidden from reads at once and physically deleted by a
 * sweep: `init()` runs one and starts a timer that sweeps every
 * `sweepIntervalMs` (default one minute), and a write also starts one when
 * the last began at least an interval ago. A sweep deletes in bounded batches
 * of 1,000 rows, at most 100 batches per sweep, so while a store is running a
 * row is deleted within one interval of its `expires_at`, or of the next
 * `init()` after a stop, while fewer than 100,000 rows expire per interval; a
 * larger backlog drains at that rate. Several machines sharing a database may
 * sweep concurrently. Call `close()` before ending the pool; otherwise each
 * later sweep fails and logs `kv_expiry_sweep_failed`.
 */
export class PostgresKVStore implements KVStore {
  private pool: Pool;
  private sweepIntervalMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private sweepInFlight: Promise<number> | undefined;
  private lastSweepStartedAt = 0;
  private closed = false;

  constructor(pool: Pool, opts?: PostgresKVStoreOpts) {
    const interval = opts?.sweepIntervalMs ?? KV_EXPIRY_SWEEP_INTERVAL_MS;
    if (!Number.isFinite(interval) || interval <= 0) {
      throw new Error("PostgresKVStore: sweepIntervalMs must be a positive number");
    }
    this.pool = pool;
    this.sweepIntervalMs = interval;
  }

  /** Run the CREATE TABLE migration and start the expiry sweep. Call once at startup. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
    if (this.closed || this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepInBackground(), this.sweepIntervalMs);
    this.sweepTimer.unref();
    // A restarted machine clears the backlog left while it was down.
    this.sweepInBackground();
  }

  /** Stop the expiry sweep and wait for one in progress. The pool stays open. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    await this.sweepInFlight?.catch(() => undefined);
  }

  /**
   * Delete expired rows in bounded batches and return how many were deleted.
   * Concurrent calls share one sweep.
   */
  sweepExpired(): Promise<number> {
    this.sweepInFlight ??= this.runSweep().finally(() => {
      this.sweepInFlight = undefined;
    });
    return this.sweepInFlight;
  }

  private sweepInBackground(): void {
    // Joining a running sweep would log its failure once per joiner.
    if (this.closed || this.sweepInFlight) return;
    this.sweepExpired().catch((err: unknown) => {
      diagnosticConsole.error({
        level: "error",
        event: "kv_expiry_sweep_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  private async runSweep(): Promise<number> {
    this.lastSweepStartedAt = Date.now();
    const now = this.lastSweepStartedAt;
    let deleted = 0;
    for (let batch = 0; batch < KV_EXPIRY_SWEEP_MAX_BATCHES && !this.closed; batch++) {
      // The keys are collected first as an array so the delete probes the
      // primary key per key instead of scanning the table for each batch.
      // SKIP LOCKED leaves a row another transaction holds (a concurrent `set`
      // or sweeper) for a later sweep instead of waiting on it. The outer
      // expiry check repeats the condition on the row version being deleted.
      const { rowCount } = await this.pool.query(
        `DELETE FROM kv_store
         WHERE key = ANY(ARRAY(
           SELECT key FROM kv_store
           WHERE expires_at IS NOT NULL AND expires_at <= $1
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )) AND expires_at <= $1`,
        [now, KV_EXPIRY_SWEEP_BATCH_SIZE]
      );
      deleted += rowCount ?? 0;
      if ((rowCount ?? 0) < KV_EXPIRY_SWEEP_BATCH_SIZE) break;
    }
    return deleted;
  }

  private async createTables(): Promise<void> {
    await this.pool.query(`
      -- Single-tenant KV table aligned with the platform's isolate storage schema.
      -- The only structural difference is the absence of dvm_id (SDK is single-DVM-per-DB).
      -- Keep column additions aligned with the platform isolate schema.
      CREATE TABLE IF NOT EXISTS kv_store (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        expires_at BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_kv_store_expires_at ON kv_store (expires_at)
        WHERE expires_at IS NOT NULL;
    `);
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const { rows } = await this.pool.query(
      "SELECT value FROM kv_store WHERE key = $1 AND (expires_at IS NULL OR expires_at > $2)",
      [key, Date.now()]
    );
    if (rows.length === 0) return undefined;
    return (rows[0] as Record<string, unknown>).value as T;
  }

  async set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
    const expiresAt = opts?.ttl !== undefined ? Date.now() + opts.ttl * 1000 : null;
    await this.pool.query(
      `INSERT INTO kv_store (key, value, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
      [key, JSON.stringify(value), expiresAt]
    );
    // Writes keep the sweep going if the timer is not running, e.g. before
    // `init()` on a store whose table already exists.
    if (Date.now() - this.lastSweepStartedAt >= this.sweepIntervalMs) {
      this.sweepInBackground();
    }
  }

  async delete(key: string): Promise<void> {
    await this.pool.query("DELETE FROM kv_store WHERE key = $1", [key]);
  }

  async list(prefix?: string): Promise<string[]> {
    const now = Date.now();
    if (prefix !== undefined) {
      const escaped = prefix.replace(/%/g, "\\%").replace(/_/g, "\\_");
      const { rows } = await this.pool.query(
        "SELECT key FROM kv_store WHERE key LIKE $1 AND (expires_at IS NULL OR expires_at > $2)",
        [`${escaped}%`, now]
      );
      return rows.map((r: Record<string, unknown>) => r.key as string);
    }
    const { rows } = await this.pool.query(
      "SELECT key FROM kv_store WHERE expires_at IS NULL OR expires_at > $1",
      [now]
    );
    return rows.map((r: Record<string, unknown>) => r.key as string);
  }
}
