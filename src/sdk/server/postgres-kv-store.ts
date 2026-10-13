import type { Pool } from "pg";

import type { KVStore } from "../types";
import { withSdkInitLock } from "./init-lock";

/**
 * Postgres-backed KVStore. Requires the `pg` package as a peer dependency.
 *
 * Expired rows are filtered on read and list, but never deleted; callers
 * must arrange their own cleanup to bound physical storage.
 */
export class PostgresKVStore implements KVStore {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Run the CREATE TABLE migration. Call once at startup. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
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
