/**
 * RevenueReporter table ownership and legacy migration against real Postgres.
 * The renamed SDK outbox preserves in-flight SDK rows, while an unknown table
 * under the retired name stops boot before a funding transaction can reach it.
 */
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  dropSchemas,
  pinnedPool,
  recreateSchema,
} from "../../../test-support/schema-isolation";
import { RevenueReporter } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = `dvm_revenue_migration_revenue_reporter_${process.pid}`;

describe.skipIf(!RUN)("RevenueReporter table migration", () => {
  let pool: Pool;

  beforeEach(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
  });

  afterEach(async () => {
    await pool.end();
    await dropSchemas(SCHEMA);
  });

  it("copies legacy SDK rows into the renamed outbox idempotently", async () => {
    await pool.query(`
      CREATE TABLE pending_revenue_reports (
        id            TEXT PRIMARY KEY,
        payload       JSONB NOT NULL,
        retry_count   INTEGER NOT NULL DEFAULT 0,
        next_retry_at BIGINT NOT NULL DEFAULT 0,
        stale         BOOLEAN NOT NULL DEFAULT false,
        created_at    BIGINT NOT NULL
      )
    `);
    await pool.query(
      `INSERT INTO pending_revenue_reports (id, payload, retry_count, next_retry_at, stale, created_at)
       VALUES ($1, $2, 3, 1234, true, 5678)`,
      ["legacy-report", JSON.stringify({ dvmId: "dvm", jobId: "job" })]
    );

    const reporter = new RevenueReporter(pool, "https://platform.invalid", "token");
    await reporter.init();

    const { rows } = await pool.query(
      `SELECT id, payload, retry_count, next_retry_at, stale, stale_reason, created_at, kind
       FROM pending_dvm_reports`
    );
    expect(rows).toEqual([
      {
        id: "legacy-report",
        payload: { dvmId: "dvm", jobId: "job" },
        retry_count: 3,
        next_retry_at: "1234",
        stale: true,
        stale_reason: null,
        created_at: "5678",
        kind: "revenue",
      },
    ]);

    expect(await pool.query("SELECT 1 FROM pending_revenue_reports")).toMatchObject({
      rowCount: 0,
    });
    // Successful delivery removes the target row. A later boot must not
    // resurrect it from the retired legacy source.
    await pool.query("DELETE FROM pending_dvm_reports");
    await reporter.init();
    expect(await pool.query("SELECT 1 FROM pending_dvm_reports")).toMatchObject({ rowCount: 0 });
  });

  it("fails boot with both owners named when the legacy table shape is unknown", async () => {
    await pool.query(`
      CREATE TABLE pending_revenue_reports (
        id      TEXT PRIMARY KEY,
        payload JSONB NOT NULL
      )
    `);

    const reporter = new RevenueReporter(pool, "https://platform.invalid", "token");
    await expect(reporter.init()).rejects.toThrow(
      /SDK owns "pending_dvm_reports"; the platform owns "pending_revenue_reports"/
    );
  });
});
