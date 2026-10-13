import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { fundCredit } from "./__helpers__/credit-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_rail_rename";
const CALLER = "ab".repeat(32);

async function pinnedPool(schema: string): Promise<Pool> {
  const pg = await import("pg");
  return new pg.default.Pool({
    connectionString: DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
}

async function withAdminPool(fn: (pool: Pool) => Promise<void>): Promise<void> {
  const pg = await import("pg");
  const admin = new pg.default.Pool({ connectionString: DATABASE_URL });
  try {
    await fn(admin);
  } finally {
    await admin.end();
  }
}

describe.skipIf(!RUN)("mpp → tempo row migration at boot", () => {
  let pool: Pool;

  beforeAll(async () => {
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    });
    pool = await pinnedPool(SCHEMA);
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    });
  }, 60_000);

  it("rewrites credits.rail, credit_fundings.rail and credit_drains.method — and the credit still draws and drains", async () => {
    const ledger = new CreditLedger(pool);
    await ledger.init();
    const nowMs = Date.now();

    // Build a real credit through the ordinary path, then age it back to the
    // pre-rename spelling. Writing the rows by hand instead would test the
    // UPDATE against a shape only this file believes in.
    const credit = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: nowMs + 24 * 60 * 60 * 1000,
      basis: { rail: "tempo", paidMsats: 0, nativeAmount: 10_000, nativeAsset: "pathUSD" },
    });
    await ledger.recordFunding({
      creditId: credit.creditId,
      fundId: "rail-migration-funding",
      amountMicro: 10_000,
      rail: "tempo",
    });
    await pool.query(`UPDATE credits SET rail = 'mpp' WHERE credit_id = $1`, [credit.creditId]);
    await pool.query(`UPDATE credit_fundings SET rail = 'mpp' WHERE credit_id = $1`, [
      credit.creditId,
    ]);

    await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();

    const rails = await pool.query<{ rail: string }>(
      `SELECT rail FROM credits WHERE credit_id = $1`,
      [credit.creditId]
    );
    expect(rails.rows[0].rail).toBe("tempo");
    const fundings = await pool.query<{ rail: string }>(
      `SELECT rail FROM credit_fundings WHERE credit_id = $1`,
      [credit.creditId]
    );
    expect(fundings.rows.map((r) => r.rail)).toEqual(["tempo"]);

    expect((await ledger.get(credit.creditId))?.rail).toBe("tempo");
    await expect(
      ledger.fund({
        creditId: credit.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 5_000,
        expiryMs: nowMs + 24 * 60 * 60 * 1000,
        basis: { rail: "tempo", paidMsats: 0, nativeAmount: 5_000, nativeAsset: "pathUSD" },
      })
    ).resolves.toBeDefined();
    const draw = await ledger.draw({
      creditId: credit.creditId,
      drawId: "rail-migration-draw",
      amountMicro: 1_000,
      jobId: "job-rail-migration",
    });
    expect(draw.amountMicro).toBe(1_000);
    expect(draw.railValue.rail).toBe("tempo");

    await ledger.requestDrain({
      creditId: credit.creditId,
      drainId: "rail-migration-drain",
      callerPubkey: CALLER,
      method: "tempo",
      payout: {},
    });
    await pool.query(`UPDATE credit_drains SET method = 'mpp' WHERE credit_id = $1`, [
      credit.creditId,
    ]);
    await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();
    const drains = await pool.query<{ method: string }>(
      `SELECT method FROM credit_drains WHERE credit_id = $1`,
      [credit.creditId]
    );
    expect(drains.rows.map((r) => r.method)).toEqual(["tempo"]);
  });

  // The repair reader must recognize a stored tempo method after migration; retaining only
  // the old mpp predicate silently hides existing pending drains.
  it("lists a channel drain under the renamed method, and not under the old one", async () => {
    const ledger = new CreditLedger(pool);
    await ledger.init();
    const nowMs = Date.now();
    const caller = "cd".repeat(32);
    const channelId = "0xchannelmigrationfixture";

    const credit = await fundCredit(ledger, {
      callerPubkey: caller,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: nowMs + 24 * 60 * 60 * 1000,
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 10_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "10000" },
      },
    });
    await ledger.requestDrain({
      creditId: credit.creditId,
      drainId: "channel-migration-drain",
      callerPubkey: caller,
      method: "tempo",
      payout: {},
    });

    const walk = async (): Promise<string[]> =>
      (
        await ledger.listChannelDrains({
          limit: 50,
          createdBeforeMs: nowMs + 60_000,
          rail: "tempo",
        })
      ).map((d) => d.drainId);

    expect(await walk()).toContain("channel-migration-drain");

    await pool.query(`UPDATE credit_drains SET method = 'mpp' WHERE credit_id = $1`, [
      credit.creditId,
    ]);
    expect(await walk()).not.toContain("channel-migration-drain");

    await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();
    expect(await walk()).toContain("channel-migration-drain");
  });

  it("rewrites processed_payments.rail, so the replay guard still matches", async () => {
    const store = new PostgresProcessedPaymentStore(pool);
    await store.init();
    await store.record({
      dvmId: "dvm-rail-migration",
      rail: "tempo",
      paymentId: "credential-1",
      creditId: "imp:tempo:credential-1",
      drawId: "credential-1",
      jobId: "job-1",
    });
    await pool.query(`UPDATE processed_payments SET rail = 'mpp' WHERE dvm_id = 'dvm-rail-migration'`);

    await expect(new PostgresProcessedPaymentStore(pool).init()).resolves.toBeUndefined();

    const marker = await store.get({
      dvmId: "dvm-rail-migration",
      rail: "tempo",
      paymentId: "credential-1",
    });
    expect(marker?.creditId).toBe("imp:tempo:credential-1");
  });

  it("rewrites jobs.payment_rail", async () => {
    const store = new PostgresJobStore(pool);
    await store.init();
    await pool.query(
      `INSERT INTO jobs (id, input, requester_id, status, created_at, last_activity_at, payment_rail)
         VALUES ('job-rail-migration-rail', 'in', 'requester', 'completed', 0, 0, 'mpp')`
    );

    await expect(new PostgresJobStore(pool).init()).resolves.toBeUndefined();

    const row = await pool.query<{ payment_rail: string }>(
      `SELECT payment_rail FROM jobs WHERE id = 'job-rail-migration-rail'`
    );
    expect(row.rows[0].payment_rail).toBe("tempo");
  });
});
