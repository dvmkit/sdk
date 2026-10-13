import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { Pool } from "pg";

import type { ConsumedCredentialStore } from "./consumed-credential-store";
import { withSdkInitLock } from "./init-lock";

const DEFAULT_TABLE_NAME = "consumed_credentials";
const DEFAULT_GC_SAMPLE_RATE = 0.01;
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PostgresConsumedCredentialStoreOpts {
  /** Table name. Defaults to `"consumed_credentials"`. Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. */
  tableName?: string;
  /**
   * Probability (per successful `mark` or `consume` call) of firing a fire-and-forget GC sweep that
   * deletes expired rows. Defaults to 0.01 — every ~100 writes runs one
   * DELETE. Set to 0 to disable GC entirely (rely on an external sweeper).
   */
  gcSampleRate?: number;
  /** Clock source (ms). Defaults to `Date.now`. Test seam for deterministic TTL. */
  now?: () => number;
}

/**
 * Committed marks are visible to all machines sharing this database. Realm
 * namespaces separate credential classes. The caller owns the pool lifecycle.
 */
export class PostgresConsumedCredentialStore implements ConsumedCredentialStore {
  private pool: Pool;
  private tableName: string;
  private gcSampleRate: number;
  private now: () => number;

  constructor(pool: Pool, opts?: PostgresConsumedCredentialStoreOpts) {
    const tableName = opts?.tableName ?? DEFAULT_TABLE_NAME;
    if (!VALID_IDENTIFIER.test(tableName)) {
      throw new Error(
        `PostgresConsumedCredentialStore: tableName must match ${VALID_IDENTIFIER.source}, got "${tableName}"`
      );
    }
    this.pool = pool;
    this.tableName = tableName;
    this.gcSampleRate = opts?.gcSampleRate ?? DEFAULT_GC_SAMPLE_RATE;
    this.now = opts?.now ?? (() => Date.now());
  }

  /** Run the CREATE TABLE migration. Idempotent — safe to call repeatedly. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  /** The boot DDL itself — always runs under {@link withSdkInitLock}. */
  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        realm        TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        expires_at   BIGINT NOT NULL,
        PRIMARY KEY (realm, challenge_id)
      );
      CREATE INDEX IF NOT EXISTS ${this.tableName}_expires_at_idx
        ON ${this.tableName} (expires_at);
    `);
  }

  async has(realm: string, challengeId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM ${this.tableName}
       WHERE realm = $1 AND challenge_id = $2 AND expires_at > $3`,
      [realm, challengeId, this.now()]
    );
    return (rowCount ?? 0) > 0;
  }

  async consume(realm: string, challengeId: string, ttlSeconds: number): Promise<boolean> {
    const now = this.now();
    const { rowCount } = await this.pool.query(
      `INSERT INTO ${this.tableName}(realm,challenge_id,expires_at) VALUES($1,$2,$3)
       ON CONFLICT(realm,challenge_id) DO UPDATE SET expires_at=EXCLUDED.expires_at
       WHERE ${this.tableName}.expires_at <= $4`,
      [realm, challengeId, now + ttlSeconds * 1000, now]
    );
    if (rowCount === 1 && this.gcSampleRate > 0 && Math.random() < this.gcSampleRate) {
      this.gcSweep(now);
    }
    return rowCount === 1;
  }

  async mark(realm: string, challengeId: string, ttlSeconds: number): Promise<void> {
    const now = this.now();
    const expiresAt = now + ttlSeconds * 1000;
    await this.pool.query(
      `INSERT INTO ${this.tableName} (realm, challenge_id, expires_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (realm, challenge_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [realm, challengeId, expiresAt]
    );
    if (this.gcSampleRate > 0 && Math.random() < this.gcSampleRate) {
      this.gcSweep(now);
    }
  }

  private gcSweep(now: number): void {
    this.pool
      .query(`DELETE FROM ${this.tableName} WHERE expires_at < $1`, [now])
      .catch((err: unknown) => {
        diagnosticConsole.error("PostgresConsumedCredentialStore GC sweep failed:", err);
      });
  }
}
