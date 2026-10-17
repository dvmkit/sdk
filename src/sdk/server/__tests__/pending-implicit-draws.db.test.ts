import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { readPendingImplicitDraws } from "../pending-implicit-draws";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_pending_implicit_draws";
const START = 1700000000000;

describe.skipIf(!RUN)("pending implicit draws (Postgres)", () => {
  let admin: pg.Pool;
  let pool: pg.Pool;
  let reader: pg.Pool;
  let ledger: CreditLedger;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
    ledger = new CreditLedger(pool);
    await ledger.init();
    reader = new pg.Pool({
      connectionString: DATABASE_URL,
      options: `-c search_path=${SCHEMA} -c default_transaction_read_only=on`,
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE credit_draws, credit_funding_lots, credits");
  });

  afterAll(async () => {
    await reader?.end();
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await admin.end();
    }
  });

  async function draw(
    id: string,
    amountMicro: number,
    { rail = "cashu", currency = "usd", at = START, creditId = `imp:${rail}:${id}` }: {
      rail?: "cashu" | "x402" | "tempo";
      currency?: string;
      at?: number;
      creditId?: string;
    } = {}
  ) {
    await ledger.fund({
      creditId, callerPubkey: "ab".repeat(32), currency, amountMicro,
      expiryMs: START + 86400000,
      basis: { rail, paidMsats: 0 },
    });
    await ledger.draw({ creditId, drawId: id, amountMicro, nowMs: at });
    return { creditId, drawId: id };
  }

  it("totals two pending holds and excludes released, settled, and explicit credits on a read-only connection", async () => {
    await draw("pending-a", 125000, { at: START + 200 });
    await draw("pending-b", 275000, { at: START + 100 });
    await ledger.release(await draw("released", 900000, { at: START }));
    await ledger.settle(await draw("settled", 800000, { at: START }));
    await draw("explicit", 700000, { creditId: "explicit-credit" });
    await draw("funded", 600000, { creditId: "fnd:server-derived-credit" });

    expect(await readPendingImplicitDraws({ db: reader })).toEqual({
      drawCount: 2,
      oldestDrawAt: START + 100,
      byRailCurrency: [{
        rail: "cashu", currency: "usd", drawCount: 2,
        amountMicro: 400000, oldestDrawAt: START + 100,
      }],
    });
    // Verify the connection really refuses writes; SELECT-only credentials suffice for reads.
    await expect(reader.query("UPDATE credits SET balance_micro = 0")).rejects.toMatchObject({
      code: "25006",
    });
  });

  it("separates rail/currency pairs and preserves an unknown historical rail", async () => {
    await draw("cashu-usd", 100000);
    await draw("cashu-eur", 200000, { currency: "eur", at: START + 20 });
    await draw("x402-usd", 300000, { rail: "x402", at: START + 10 });
    await draw("tempo-usd", 400000, { rail: "tempo", at: START + 30 });
    const legacy = await draw("legacy", 500000, { at: START + 40 });
    await pool.query("UPDATE credits SET rail = NULL WHERE credit_id = $1", [legacy.creditId]);
    expect(await readPendingImplicitDraws({ db: reader })).toEqual({
      drawCount: 5, oldestDrawAt: START,
      byRailCurrency: [
        { rail: "cashu", currency: "eur", drawCount: 1, amountMicro: 200000, oldestDrawAt: START + 20 },
        { rail: "cashu", currency: "usd", drawCount: 1, amountMicro: 100000, oldestDrawAt: START },
        { rail: "tempo", currency: "usd", drawCount: 1, amountMicro: 400000, oldestDrawAt: START + 30 },
        { rail: "x402", currency: "usd", drawCount: 1, amountMicro: 300000, oldestDrawAt: START + 10 },
        { rail: null, currency: "usd", drawCount: 1, amountMicro: 500000, oldestDrawAt: START + 40 },
      ],
    });
  });

  it("returns zero after the last hold releases", async () => {
    await ledger.release(await draw("last", 100));
    expect(await readPendingImplicitDraws({ db: reader })).toEqual({
      drawCount: 0, oldestDrawAt: null, byRailCurrency: [],
    });
  });

  it("refuses a currency total that exceeds safe integers even when each draw is safe", async () => {
    await draw("large-a", 4503599627370496);
    await draw("large-b", 4503599627370496);
    await expect(readPendingImplicitDraws({ db: reader })).rejects.toThrow(RangeError);
  });
});
