/**
 * Concurrent CREATE IF NOT EXISTS can still collide in Postgres catalogs. Independent cold boots
 * must serialize their DDL and all reach serving state.
 */
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  dropSchemas,
  pinnedPool,
  recreateSchema,
} from "../../../test-support/schema-isolation";
import { CreditLedger } from "../credit-ledger";
import { withSdkInitLock } from "../init-lock";
import { initLockPubkeyTable, seedLockPubkeyState } from "../lock-pubkey-store";
import { initMppSecretStateTable } from "../mpp-secret-state";
import { PostgresConsumedCredentialStore } from "../postgres-consumed-credential-store";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresKVStore } from "../postgres-kv-store";
import { PostgresReplayStore } from "../postgres-replay-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { RevenueReporter } from "../revenue-reporter";
import { PostgresTempoChargeStore } from "../tempo-charge-store";
import { PostgresTempoSessionStore } from "../tempo-session-store";
import { initWalletAccumulatorTable } from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

/**
 * Throwaway schemas isolated from `public` (which the shared suite fills with
 * the current shape). Each run gets a fresh one so the DDL does real work —
 * the only state in which the race window is open; against a schema that
 * already has the tables every statement no-ops and the window closes.
 */
const SCHEMA_PREFIX = "sdk_boot_ddl";

// Independent boots racing per schema, each on its own Pool (its own backend
// sessions) — one Pool is one machine. More than two widens the overlap: the
// pre-fix catalog race needs two sessions inside the same `CREATE TABLE` at
// once, so four boots × three fresh schemas trips it reliably rather than on a
// lucky interleave.
const CONCURRENCY = 4;
const ITERATIONS = 3;

// Reentrant seeds can overlap inside an outer lock callback. Their single
// INSERT has a narrow collision window, so use a warm pool and several rounds.
const SEED_CONCURRENCY = 8;
const SEED_ITERATIONS = 8;

const DVM_ID = "boot-ddl-service";
const LOCK_PUBKEY = `02${"a".repeat(64)}`;

/**
 * The SDK boot schema sequence, in `host.ts`'s order: the Cashu accumulator
 * inits + seed (`cashu-env.ts`), the MPP secret table, then the
 * parallel store batch, then the per-mount revenue reporter.
 */
async function bootSdkSchema(pool: Pool): Promise<void> {
  await initWalletAccumulatorTable(pool);
  await initLockPubkeyTable(pool);
  await seedLockPubkeyState(pool, DVM_ID, LOCK_PUBKEY);
  await initMppSecretStateTable(pool);
  await Promise.all([
    new PostgresJobStore(pool).init(),
    new PostgresKVStore(pool).init(),
    new PostgresReplayStore(pool).init(),
    new PostgresConsumedCredentialStore(pool).init(),
    new PostgresTempoSessionStore(pool).init(),
    new PostgresTempoChargeStore(pool).init(),
    new CreditLedger(pool).init(),
    new PostgresProcessedPaymentStore(pool).init(),
  ]);
  await new RevenueReporter(pool, "https://platform.invalid", "token").init();
}

/** One table from each init in `bootSdkSchema`, so a silently-skipped one fails. */
const EXPECTED_TABLES = [
  "wallet_accumulator",
  "dvm_lock_pubkeys",
  "mpp_secret_state",
  "jobs",
  "request_id_claims",
  "kv_store",
  "signed_request_replays",
  "consumed_credentials",
  "mpp_tempo_channels",
  "mpp_tempo_close_intents",
  "mpp_tempo_charge_replays",
  "credits",
  "processed_payments",
  "pending_dvm_reports",
];

(RUN ? describe : describe.skip)("SDK boot DDL concurrency", () => {
  const schemas: string[] = [];

  afterAll(async () => {
    await dropSchemas(...schemas);
  }, 60_000);

  it("boots N machines simultaneously against a fresh schema without a catalog 23505", async () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const schema = `${SCHEMA_PREFIX}_${i}`;
      await recreateSchema(schema);
      schemas.push(schema);

      const pools = await Promise.all(
        Array.from({ length: CONCURRENCY }, () => pinnedPool(schema))
      );
      try {
        // Sanity: the pools really are isolated, not falling back to `public`.
        const cs = await pools[0].query<{ s: string }>("SELECT current_schema() AS s");
        expect(cs.rows[0].s).toBe(schema);

        await expect(Promise.all(pools.map((p) => bootSdkSchema(p)))).resolves.toBeDefined();

        for (const table of EXPECTED_TABLES) {
          const reg = await pools[0].query<{ r: string | null }>("SELECT to_regclass($1) AS r", [
            `${schema}.${table}`,
          ]);
          expect(reg.rows[0].r, `${table} created`).not.toBeNull();
        }

        // Every boot seeds the same DVM identity; only one current row remains.
        const seeded = await pools[0].query<{ n: string }>(
          "SELECT COUNT(*)::text AS n FROM dvm_lock_pubkeys WHERE retired_at_ms IS NULL"
        );
        expect(seeded.rows[0].n).toBe("1");
      } finally {
        await Promise.all(pools.map((p) => p.end()));
      }
    }
  }, 120_000);

  it("serializes same-store initialization on a shared pool for fresh and warm schemas", async () => {
    const schema = `${SCHEMA_PREFIX}_shared_pool`;
    await recreateSchema(schema);
    schemas.push(schema);
    const pool = await pinnedPool(schema);
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.query("SELECT 1")));
      for (let pass = 0; pass < 2; pass++) {
        await expect(
          withDeadline(
            Promise.all(Array.from({ length: CONCURRENCY }, () => initWalletAccumulatorTable(pool))),
            20_000,
            "same-pool accumulator initialization"
          )
        ).resolves.toHaveLength(CONCURRENCY);
        const { rows } = await pool.query<{ table_name: string | null; index_name: string | null }>(
          `SELECT to_regclass('wallet_accumulator')::text AS table_name,
                  to_regclass('idx_wallet_accumulator_melt_group')::text AS index_name`
        );
        expect(rows[0]).toEqual({
          table_name: "wallet_accumulator",
          index_name: "idx_wallet_accumulator_melt_group",
        });
      }
    } finally {
      await pool.end();
    }
  }, 60_000);

  // A second pool must acquire the database lock itself, so this catches a
  // leaked Postgres advisory lock after the first callback throws.
  it("releases the lock when the guarded work throws", async () => {
    const schema = `${SCHEMA_PREFIX}_throw`;
    await recreateSchema(schema);
    schemas.push(schema);

    const [thrower, follower] = await Promise.all([pinnedPool(schema), pinnedPool(schema)]);
    try {
      await expect(
        withSdkInitLock(thrower, async () => {
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      // `pg_advisory_lock` waits forever, so bound it here rather than letting a
      // regression read as a generic suite timeout.
      await expect(
        withDeadline(bootSdkSchema(follower), 20_000, "blocked on a leaked advisory lock")
      ).resolves.toBeUndefined();
    } finally {
      await Promise.all([thrower.end(), follower.end()]);
    }
  }, 60_000);

  // Top-level calls queue, but sibling seeds nested inside an outer callback
  // run concurrently. Their `ON CONFLICT DO NOTHING` must resolve an insert
  // collision without failing the boot.
  it("seeds once when reentrant same-pool calls overlap", async () => {
    const schema = `${SCHEMA_PREFIX}_seed`;
    await recreateSchema(schema);
    schemas.push(schema);

    const pool = await pinnedPool(schema);
    try {
      await initLockPubkeyTable(pool);
      // Warm connections so the overlapping INSERTs reach the same snapshot.
      await Promise.all(Array.from({ length: SEED_CONCURRENCY }, () => pool.query("SELECT 1")));

      for (let i = 0; i < SEED_ITERATIONS; i++) {
        const dvmId = `${DVM_ID}_seed_${i}`;
        await withSdkInitLock(pool, async () => {
          await Promise.all(
            Array.from({ length: SEED_CONCURRENCY }, () =>
              seedLockPubkeyState(pool, dvmId, LOCK_PUBKEY)
            )
          );
        });
        const seeded = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM dvm_lock_pubkeys
             WHERE dvm_id = $1 AND retired_at_ms IS NULL`,
          [dvmId]
        );
        expect(seeded.rows[0].n, `${dvmId} seeded once`).toBe("1");
      }
    } finally {
      await pool.end();
    }
  }, 60_000);
});

/** Reject with `label` if `work` hasn't settled within `ms`. */
async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
