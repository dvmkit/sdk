import { randomUUID } from "node:crypto";

import type { Pool } from "pg";

import { withSdkInitLock } from "./init-lock";
import type {
  TempoSettlementFailureState,
  TempoSettlementReadinessStateStore,
} from "./tempo-settlement-readiness";

export interface PostgresTempoSettlementReadinessStoreOptions {
  dvmId: string;
  address: `0x${string}`;
  token: `0x${string}`;
  now?: () => number;
}

/**
 * Postgres failure latch shared by every Machine serving one hosted DVM.
 *
 * The operator address and token join the DVM id in the key so rotating either
 * starts a fresh readiness epoch instead of inheriting a previous account's
 * failure. Balance reads remain in-process; only the stronger failure latch is
 * durable because that is the state siblings must agree on before advertising
 * or accepting a new session.
 */
export class PostgresTempoSettlementReadinessStore implements TempoSettlementReadinessStateStore {
  private readonly address: string;
  private readonly token: string;
  private readonly now: () => number;

  constructor(
    private readonly pool: Pool,
    private readonly opts: PostgresTempoSettlementReadinessStoreOptions
  ) {
    this.address = opts.address.toLowerCase();
    this.token = opts.token.toLowerCase();
    this.now = opts.now ?? Date.now;
  }

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, async () => {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS tempo_settlement_readiness (
          dvm_id                TEXT NOT NULL,
          operator_address      TEXT NOT NULL,
          token                 TEXT NOT NULL,
          failure_latched       BOOLEAN NOT NULL DEFAULT FALSE,
          failure_version       TEXT,
          failure_balance_micro NUMERIC(78, 0),
          updated_at            BIGINT NOT NULL,
          PRIMARY KEY (dvm_id, operator_address, token)
        )
      `);
      await this.pool.query(
        `ALTER TABLE tempo_settlement_readiness
           ADD COLUMN IF NOT EXISTS failure_version TEXT`
      );
      await this.pool.query(
        `UPDATE tempo_settlement_readiness
            SET failure_version = 'legacy:' || dvm_id || ':' || operator_address || ':' || token || ':' || updated_at
          WHERE failure_latched = TRUE AND failure_version IS NULL`
      );
    });
  }

  /** Read the fleet-wide failure latch; an absent row is healthy. */
  async readFailure(): Promise<TempoSettlementFailureState> {
    const { rows } = await this.pool.query<{
      failure_latched: boolean;
      failure_version: string | null;
      failure_balance_micro: string | null;
    }>(
      `SELECT failure_latched, failure_version, failure_balance_micro
         FROM tempo_settlement_readiness
        WHERE dvm_id = $1 AND operator_address = $2 AND token = $3`,
      this.keyParams()
    );
    const row = rows.at(0);
    return {
      latched: row?.failure_latched ?? false,
      ...(row?.failure_latched && row.failure_version ? { version: row.failure_version } : {}),
      ...(row?.failure_balance_micro !== null && row?.failure_balance_micro !== undefined
        ? { balanceMicro: BigInt(row.failure_balance_micro) }
        : {}),
    };
  }

  /** Start a new failure version and discard the previous version's baseline. */
  async latchFailure(): Promise<TempoSettlementFailureState> {
    const version = randomUUID();
    await this.pool.query(
      `INSERT INTO tempo_settlement_readiness
         (dvm_id, operator_address, token, failure_latched, failure_version, failure_balance_micro, updated_at)
       VALUES ($1, $2, $3, TRUE, $4, NULL, $5)
       ON CONFLICT (dvm_id, operator_address, token) DO UPDATE SET
         failure_latched = TRUE,
         failure_version = EXCLUDED.failure_version,
         failure_balance_micro = NULL,
         updated_at = EXCLUDED.updated_at`,
      [...this.keyParams(), version, this.now()]
    );
    return { latched: true, version };
  }

  /** Save the first balance read for one failure version. */
  async captureFailureBalance(version: string, balanceMicro: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tempo_settlement_readiness
          SET failure_balance_micro = $5, updated_at = $6
        WHERE dvm_id = $1 AND operator_address = $2 AND token = $3
          AND failure_latched = TRUE
          AND failure_version = $4
          AND failure_balance_micro IS NULL`,
      [...this.keyParams(), version, balanceMicro.toString(), this.now()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Clear only when the observed balance proves a post-failure refill. */
  async clearFailureIfRefilled(
    version: string,
    balanceMicro: bigint,
    lowBalanceMicro: bigint
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tempo_settlement_readiness
          SET failure_latched = FALSE, failure_version = NULL,
              failure_balance_micro = NULL, updated_at = $7
        WHERE dvm_id = $1 AND operator_address = $2 AND token = $3
          AND failure_latched = TRUE
          AND failure_version = $4
          AND failure_balance_micro IS NOT NULL
          AND $5::NUMERIC >= $6::NUMERIC
          AND $5::NUMERIC > failure_balance_micro`,
      [
        ...this.keyParams(),
        version,
        balanceMicro.toString(),
        lowBalanceMicro.toString(),
        this.now(),
      ]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** Clear after a landed operator transaction proves fee funding works. */
  async clearFailureAfterSuccessfulTransaction(version: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE tempo_settlement_readiness
          SET failure_latched = FALSE, failure_version = NULL,
              failure_balance_micro = NULL, updated_at = $5
        WHERE dvm_id = $1 AND operator_address = $2 AND token = $3
          AND failure_latched = TRUE
          AND failure_version = $4`,
      [...this.keyParams(), version, this.now()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  private keyParams(): [string, string, string] {
    return [this.opts.dvmId, this.address, this.token];
  }
}
