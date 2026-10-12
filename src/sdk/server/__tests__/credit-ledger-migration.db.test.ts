import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { fundCredit } from "./__helpers__/credit-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_credit_drains_migration";

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

describe.skipIf(!RUN)(
  "CreditLedger.init() migration from a legacy DB",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      await withAdminPool(async (admin) => {
        await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
        await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
      });
      pool = await pinnedPool(SCHEMA);
    });

    afterAll(async () => {
      await pool.end();
      await withAdminPool(async (admin) => {
        await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      });
    });

    it("backfills credit_drains.balance_after_micro and credit_fundings.rail onto a pre-existing table, and requestDrain succeeds", async () => {
      const ledger = new CreditLedger(pool);
      await ledger.init();
      const nowMs = Date.now();
      const caller = "ab".repeat(32);
      const historicalCredit = await fundCredit(ledger, {
        callerPubkey: caller,
        currency: "usd",
        amountMicro: 5_000,
        expiryMs: nowMs + 24 * 60 * 60 * 1000,
      });
      await ledger.requestDrain({
        creditId: historicalCredit.creditId,
        drainId: "drain-migration-historical-drain",
        callerPubkey: caller,
        method: "cashu",
        payout: { refund_pubkey: "02" + "cd".repeat(32) },
      });

      // Remove columns from existing tables before init; CREATE TABLE IF NOT EXISTS alone
      // cannot restore them.
      await pool.query(`
        ALTER TABLE credit_drains DROP COLUMN IF EXISTS balance_after_micro;
        ALTER TABLE credit_fundings DROP COLUMN IF EXISTS rail;
      `);

      await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();

      const drainsCol = await pool.query(
        `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'credit_drains' AND column_name = 'balance_after_micro'
             AND table_schema = current_schema()`
      );
      expect(drainsCol.rows.length, "credit_drains.balance_after_micro exists").toBe(1);

      const fundingsCol = await pool.query(
        `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'credit_fundings' AND column_name = 'rail'
             AND table_schema = current_schema()`
      );
      expect(fundingsCol.rows.length, "credit_fundings.rail exists").toBe(1);

      const backfilled = await pool.query<{ balance_after_micro: string }>(
        `SELECT balance_after_micro FROM credit_drains WHERE credit_id = $1 AND drain_id = $2`,
        [historicalCredit.creditId, "drain-migration-historical-drain"]
      );
      expect(backfilled.rows[0].balance_after_micro).toBe("0");

      const credit = await fundCredit(ledger, {
        callerPubkey: caller,
        currency: "usd",
        amountMicro: 10_000,
        expiryMs: nowMs + 24 * 60 * 60 * 1000,
      });
      const { drain } = await ledger.requestDrain({
        creditId: credit.creditId,
        drainId: "drain-migration-drain",
        callerPubkey: caller,
        method: "cashu",
        payout: { refund_pubkey: "02" + "cd".repeat(32) },
      });
      expect(drain.amountMicro).toBe(10_000);
      expect(drain.balanceAfterMicro).toBe(0);
    });

    it("backfills credit_draws.grown_micro and growDraw's cap still bounds a live draw", async () => {
      const ledger = new CreditLedger(pool);
      await ledger.init();
      const caller = "cd".repeat(32);
      const credit = await fundCredit(ledger, {
        callerPubkey: caller,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: Date.now() + 24 * 60 * 60 * 1000,
      });
      await ledger.draw({
        creditId: credit.creditId,
        drawId: "cap-migration-draw",
        amountMicro: 10_000,
        jobId: "cap-migration-job",
      });

      // Remove grown_micro from an existing draw table; init must add it with historical
      // default zero.
      await pool.query(`ALTER TABLE credit_draws DROP COLUMN IF EXISTS grown_micro`);
      await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();

      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns
           WHERE table_name = 'credit_draws' AND column_name = 'grown_micro'
             AND table_schema = current_schema()`
      );
      expect(col.rows.length, "credit_draws.grown_micro exists").toBe(1);

      const grown = await ledger.growDraw({
        creditId: credit.creditId,
        drawId: "cap-migration-draw",
        addAmountMicro: 20_000,
        capMicro: 5_000,
        jobId: "cap-migration-job",
      });
      expect(grown.addedAmountMicro).toBe(5_000);
      expect(grown.cappedMicro).toBe(15_000);
      expect(grown.amountMicro).toBe(15_000);
    });

    it("backfills the credit_invoices reconcile columns and repairs a blocked row", async () => {
      const ledger = new CreditLedger(pool);
      await ledger.init();
      const caller = "cd".repeat(32);
      const paymentHash = "lightning-migration-migration-hash";
      await ledger.recordInvoice({
        creditId: "lightning-migration-blocked",
        fundId: "f1",
        callerPubkey: caller,
        currency: "usd",
        amountMicro: 4_000,
        amountMsats: 4_000,
        paymentHash,
        bolt11: "lnbcrt1migrationfixture",
        expiresAt: Date.now() + 900_000,
      });
      await ledger.markInvoiceBlocked({
        creditId: "lightning-migration-blocked",
        fundId: "f1",
        reason: "funding_replayed_on_cashu",
      });

      // Downgrade to the legacy shape. The blocked-queue index depends
      // on none of them, but it is dropped alongside so the re-run rebuilds
      // both halves — a `CREATE TABLE IF NOT EXISTS` reaches neither.
      await pool.query(`
        DROP INDEX IF EXISTS idx_credit_invoices_blocked;
        ALTER TABLE credit_invoices DROP COLUMN IF EXISTS reconciled_credit_id;
        ALTER TABLE credit_invoices DROP COLUMN IF EXISTS reconciled_fund_id;
        ALTER TABLE credit_invoices DROP COLUMN IF EXISTS resolved_at;
        ALTER TABLE credit_invoices DROP COLUMN IF EXISTS write_off_note;
      `);

      await expect(new CreditLedger(pool).init()).resolves.toBeUndefined();

      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_name = 'credit_invoices' AND table_schema = current_schema()`
      );
      const names = cols.rows.map((r) => r.column_name);
      expect(names).toEqual(
        expect.arrayContaining([
          "reconciled_credit_id",
          "reconciled_fund_id",
          "resolved_at",
          "write_off_note",
        ])
      );

      const result = await ledger.reconcileBlockedInvoice({
        paymentHash,
        targetCreditId: "lightning-migration-target",
        expiryMs: Date.now() + 24 * 60 * 60 * 1000,
        basis: { rail: "lightning", paidMsats: 4_000, fundingRef: paymentHash },
      });
      expect(result.replayed).toBe(false);
      expect(result.credit?.balanceMicro).toBe(4_000);
      expect((await ledger.getInvoiceByPaymentHash(paymentHash))?.reconciledCreditId).toBe(
        "lightning-migration-target"
      );
    });
  }
);
