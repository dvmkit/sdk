import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { Pool } from "pg";

import { withSdkInitLock } from "./init-lock";
import type { SignedRequestReplayStore } from "./signed-request";

const DEFAULT_TABLE_NAME = "signed_request_replays";
const DEFAULT_WINDOW_SECONDS = 10 * 60;
const DEFAULT_GC_SAMPLE_RATE = 0.01;
const VALID_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface PostgresReplayStoreOpts {
  /** Table name. Defaults to `"signed_request_replays"`. Must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. */
  tableName?: string;
  /**
   * Retention window in seconds — rows older than `now - windowSeconds` are
   * eligible for the sampled-in-line GC sweep. Defaults to 600 (10 minutes),
   * matching the SDK's signed-request retention default.
   */
  windowSeconds?: number;
  /**
   * Probability (per `checkAndRecord` call) of firing a fire-and-forget GC
   * sweep. Defaults to 0.01 — every ~100 writes runs one DELETE. Set to 0 to
   * disable GC entirely (rely on an external sweeper).
   */
  gcSampleRate?: number;
}

/**
 * The (pubkey, timestamp, nonce) primary key detects concurrent duplicates
 * atomically across machines. The caller owns the pool lifecycle.
 */
export class PostgresReplayStore implements SignedRequestReplayStore {
  private pool: Pool;
  private tableName: string;
  private windowSeconds: number;
  private gcSampleRate: number;

  constructor(pool: Pool, opts?: PostgresReplayStoreOpts) {
    const tableName = opts?.tableName ?? DEFAULT_TABLE_NAME;
    if (!VALID_IDENTIFIER.test(tableName)) {
      throw new Error(
        `PostgresReplayStore: tableName must match ${VALID_IDENTIFIER.source}, got "${tableName}"`
      );
    }
    this.pool = pool;
    this.tableName = tableName;
    this.windowSeconds = opts?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;
    this.gcSampleRate = opts?.gcSampleRate ?? DEFAULT_GC_SAMPLE_RATE;
  }

  /** Run the CREATE TABLE migration. Idempotent — safe to call repeatedly. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  /** The boot DDL itself — always runs under {@link withSdkInitLock}. */
  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        pubkey      TEXT NOT NULL,
        timestamp   BIGINT NOT NULL,
        nonce       TEXT NOT NULL,
        recorded_at BIGINT NOT NULL,
        PRIMARY KEY (pubkey, timestamp, nonce)
      );
      CREATE INDEX IF NOT EXISTS ${this.tableName}_recorded_at_idx
        ON ${this.tableName} (recorded_at);
    `);
  }

  async checkAndRecord(
    pubkey: string,
    timestamp: number,
    nonce: string,
    now: number
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO ${this.tableName} (pubkey, timestamp, nonce, recorded_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [pubkey, timestamp, nonce, now]
    );
    if (this.gcSampleRate > 0 && Math.random() < this.gcSampleRate) {
      this.gcSweep(now);
    }
    return rowCount === 0;
  }

  private gcSweep(now: number): void {
    const cutoff = now - this.windowSeconds;
    this.pool
      .query(`DELETE FROM ${this.tableName} WHERE recorded_at < $1`, [cutoff])
      .catch((err: unknown) => {
        diagnosticConsole.error("PostgresReplayStore GC sweep failed:", err);
      });
  }
}
