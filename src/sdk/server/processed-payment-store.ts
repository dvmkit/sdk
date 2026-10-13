import type { Pool } from "pg";

import { withSdkInitLock } from "./init-lock";

/**
 * x402/Tempo marker, funding and draw commit in one transaction so a retry
 * cannot fund twice. Cashu retains its separate accumulator replay regime.
 */
export interface ProcessedPaymentStore {
  /**
   * Record that `paymentId` on `rail` funded a credit. Throws
   * {@link ProcessedPaymentReplayError} when the `(dvmId, rail, paymentId)`
   * marker already exists. `tx` (Postgres implementation only) joins the
   * caller-owned transaction so marker + fund + draw commit atomically.
   */
  record(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
    creditId: string;
    drawId: string;
    jobId?: string;
    tx?: ProcessedPaymentQuerier;
    nowMs?: number;
  }): Promise<void>;
  /** Read one marker, `undefined` when absent. */
  get(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
  }): Promise<ProcessedPaymentRecord | undefined>;
  /**
   * Postgres supplies a transaction for marker, fund and draw; failure rolls it
   * back. Memory invokes fn without a transactional handle or rollback.
   */
  withTx<T>(fn: (tx?: ProcessedPaymentQuerier) => Promise<T>): Promise<T>;
}

/** Rails that commit through the marker (Cashu commits via the accumulator). */
export type ProcessedPaymentRail = "x402" | "tempo";

/** One recorded funding marker. */
export interface ProcessedPaymentRecord {
  dvmId: string;
  rail: ProcessedPaymentRail;
  paymentId: string;
  creditId: string;
  drawId: string;
  jobId: string | null;
  createdAt: number;
}

/** Subset of `pg.Pool` the store queries through; `PoolClient` satisfies it too. */
export interface ProcessedPaymentQuerier {
  query: Pool["query"];
}

/** Thrown by `record` when the payment id was already processed on this rail. */
export class ProcessedPaymentReplayError extends Error {
  constructor(
    public readonly rail: ProcessedPaymentRail,
    public readonly paymentId: string
  ) {
    super(`payment ${paymentId} on rail ${rail} was already processed`);
    this.name = "ProcessedPaymentReplayError";
  }
}

/** Postgres-backed {@link ProcessedPaymentStore} — the production implementation. */
export class PostgresProcessedPaymentStore implements ProcessedPaymentStore {
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}

  async withTx<T>(fn: (tx?: ProcessedPaymentQuerier) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // already rolled back or connection dead
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Create the `processed_payments` table if absent. Call once at SDK boot. */
  async init(): Promise<void> {
    await withSdkInitLock(this.pool, () => this.createTables());
  }

  /** The boot DDL itself — always runs under {@link withSdkInitLock}. */
  private async createTables(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS processed_payments (
        dvm_id     TEXT NOT NULL,
        rail       TEXT NOT NULL,
        payment_id TEXT NOT NULL,
        credit_id  TEXT NOT NULL,
        draw_id    TEXT NOT NULL,
        job_id     TEXT,
        created_at BIGINT NOT NULL,
        PRIMARY KEY (dvm_id, rail, payment_id)
      );
    `);
    // `mpp` became `tempo`. The rail is part of the primary key, so
    // an unrewritten row stops colliding with the replay of the payment that
    // wrote it — the one failure this table exists to prevent.
    await this.pool.query(`UPDATE processed_payments SET rail = 'tempo' WHERE rail = 'mpp'`);
  }

  async record(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
    creditId: string;
    drawId: string;
    jobId?: string;
    tx?: ProcessedPaymentQuerier;
    nowMs?: number;
  }): Promise<void> {
    const q = args.tx ?? this.pool;
    try {
      await q.query(
        `INSERT INTO processed_payments (dvm_id, rail, payment_id, credit_id, draw_id, job_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          args.dvmId,
          args.rail,
          args.paymentId,
          args.creditId,
          args.drawId,
          args.jobId ?? null,
          args.nowMs ?? Date.now(),
        ]
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ProcessedPaymentReplayError(args.rail, args.paymentId);
      }
      throw err;
    }
  }

  async get(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
  }): Promise<ProcessedPaymentRecord | undefined> {
    const { rows } = await this.pool.query<ProcessedPaymentRow>(
      `SELECT * FROM processed_payments WHERE dvm_id = $1 AND rail = $2 AND payment_id = $3`,
      [args.dvmId, args.rail, args.paymentId]
    );
    if (rows.length === 0) return undefined;
    const row = rows[0];
    return {
      dvmId: row.dvm_id,
      rail: row.rail,
      paymentId: row.payment_id,
      creditId: row.credit_id,
      drawId: row.draw_id,
      jobId: row.job_id,
      createdAt: Number(row.created_at),
    };
  }
}

/** In-memory {@link ProcessedPaymentStore} for pool-less setups. Per-process. */
export class MemoryProcessedPaymentStore implements ProcessedPaymentStore {
  private readonly markers = new Map<string, ProcessedPaymentRecord>();

  withTx<T>(fn: (tx?: ProcessedPaymentQuerier) => Promise<T>): Promise<T> {
    return fn(undefined);
  }

  record(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
    creditId: string;
    drawId: string;
    jobId?: string;
    tx?: ProcessedPaymentQuerier;
    nowMs?: number;
  }): Promise<void> {
    const key = markerKey(args);
    if (this.markers.has(key)) {
      // Reject (not sync-throw) to match the Postgres store's contract.
      return Promise.reject(new ProcessedPaymentReplayError(args.rail, args.paymentId));
    }
    this.markers.set(key, {
      dvmId: args.dvmId,
      rail: args.rail,
      paymentId: args.paymentId,
      creditId: args.creditId,
      drawId: args.drawId,
      jobId: args.jobId ?? null,
      createdAt: args.nowMs ?? Date.now(),
    });
    return Promise.resolve();
  }

  get(args: {
    dvmId: string;
    rail: ProcessedPaymentRail;
    paymentId: string;
  }): Promise<ProcessedPaymentRecord | undefined> {
    return Promise.resolve(this.markers.get(markerKey(args)));
  }
}

interface ProcessedPaymentRow {
  dvm_id: string;
  rail: ProcessedPaymentRail;
  payment_id: string;
  credit_id: string;
  draw_id: string;
  job_id: string | null;
  created_at: string;
}

function markerKey(args: { dvmId: string; rail: string; paymentId: string }): string {
  return `${args.dvmId}\u0000${args.rail}\u0000${args.paymentId}`;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
