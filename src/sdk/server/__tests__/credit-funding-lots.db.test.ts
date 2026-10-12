import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreditLedgerError } from "../credit-ledger";
import { CreditLedger } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_credit_funding_lots";
const CALLER = "ab".repeat(32);
const REFUND_PUBKEY = `02${"cd".repeat(32)}`;
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

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

describe.skipIf(!RUN)("credit funding lots", () => {
  let pool: Pool;
  let ledger: CreditLedger;

  beforeAll(async () => {
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    });
    pool = await pinnedPool(SCHEMA);
    ledger = new CreditLedger(pool);
    await ledger.init();
  });

  afterAll(async () => {
    await pool.end();
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    });
  });

  async function btcCredit(
    id: string,
    sats: number,
    micro = sats * 1_000,
    nowMs?: number
  ): Promise<string> {
    const credit = await ledger.fund({
      creditId: id,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: micro,
      expiryMs: FUTURE_MS,
      basis: { rail: "lightning", paidMsats: sats * 1_000 },
      nowMs,
    });
    return credit.creditId;
  }

  it("records a lot per funding, inside the funding's own transaction", async () => {
    const creditId = await btcCredit("lots-basic", 1_151);
    const lots = await ledger.listFundingLots(creditId);
    expect(lots).toMatchObject([
      { satsFunded: 1_151, creditedMicro: 1_151_000, remainingMicro: 1_151_000 },
    ]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ledger.fund({
        creditId: "lots-rollback",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 5_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 5_000 },
        tx: client,
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await ledger.listFundingLots("lots-rollback")).toEqual([]);
    const orphan = await pool.query(`SELECT 1 FROM credits WHERE credit_id = 'lots-rollback'`);
    expect(orphan.rows.length).toBe(0);
  });

  /*
   * An implicit draw is only a hold: failed jobs release it, so their original funding lot
   * must remain reclaimable.
   */
  it("lots the per-call regime too, because a failed job releases its hold", async () => {
    await ledger.fund({
      creditId: "imp:cashu:req-1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 3_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 3_000 },
    });
    await ledger.draw({ creditId: "imp:cashu:req-1", drawId: "req-1", amountMicro: 3_000 });
    await ledger.release({ creditId: "imp:cashu:req-1", drawId: "req-1" });
    expect(await ledger.listFundingLots("imp:cashu:req-1")).toMatchObject([
      { satsFunded: 3, creditedMicro: 3_000, remainingMicro: 3_000 },
    ]);
    await expect(
      ledger.requestDrain({
        creditId: "imp:cashu:req-1",
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: REFUND_PUBKEY },
      })
    ).rejects.toMatchObject({ code: "drain_below_dust" });

    await ledger.fund({
      creditId: "imp:cashu:req-1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 100_000 },
    });
    const { drain } = await ledger.requestDrain({
      creditId: "imp:cashu:req-1",
      drainId: "r2",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.owedSats).toBe(103 - DRAIN_DELIVERY_RESERVE_SATS);
  });

  it("skips the channel rails, which are in kind through their escrow", async () => {
    await ledger.fund({
      creditId: "lots-channel",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: `0x${"7c".repeat(32)}`, maxClaimableAmount: "100000" },
      },
    });
    expect(await ledger.listFundingLots("lots-channel")).toEqual([]);
  });

  it("depletes lots when a draw settles, and leaves a released hold alone", async () => {
    const creditId = await btcCredit("lots-settle", 1_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 100_000 });
    expect((await ledger.listFundingLots(creditId))[0].remainingMicro).toBe(1_000_000);

    await ledger.settle({ creditId, drawId: "d1" });
    expect((await ledger.listFundingLots(creditId))[0].remainingMicro).toBe(900_000);

    await ledger.draw({ creditId, drawId: "d2", amountMicro: 50_000 });
    await ledger.release({ creditId, drawId: "d2" });
    expect((await ledger.listFundingLots(creditId))[0].remainingMicro).toBe(900_000);
  });

  it("owes the deposited sats pro rata, priced off the lots and not a rate", async () => {
    const creditId = await btcCredit("lots-reclaim", 1_151);
    for (const drawId of ["j1", "j2", "j3"]) {
      await ledger.draw({ creditId, drawId, amountMicro: 3_000 });
      await ledger.settle({ creditId, drawId });
    }
    const { drain } = await ledger.requestDrain({
      creditId,
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.amountMicro).toBe(1_142_000);
    expect(drain.owedSats).toBe(1_142 - DRAIN_DELIVERY_RESERVE_SATS);
    expect(await ledger.listFundingLots(creditId)).toEqual([]);
  });

  it("prices a top-up at its own rate, oldest deposit spent first", async () => {
    // Distinct funding instants: FIFO order is `(created_at, lot_id)` and the
    // id is a surrogate, so two fundings written in one tick would deplete in
    // whichever order the ids happened to sort — a tie a test must not lean on.
    const openedAt = Date.now();
    const creditId = await btcCredit("lots-fifo", 1_000, 1_000_000, openedAt);
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "lightning", paidMsats: 500_000 },
      nowMs: openedAt + 1_000,
    });
    await ledger.draw({ creditId, drawId: "j1", amountMicro: 1_000_000 });
    await ledger.settle({ creditId, drawId: "j1" });

    const { drain } = await ledger.requestDrain({
      creditId,
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.owedSats).toBe(500 - DRAIN_DELIVERY_RESERVE_SATS);
  });

  it("refuses a reclaim worth less than a satoshi instead of opening a dead drain", async () => {
    const creditId = await btcCredit("lots-dust", 1_000);
    await ledger.draw({ creditId, drawId: "j1", amountMicro: 999_500 });
    await ledger.settle({ creditId, drawId: "j1" });
    await expect(
      ledger.requestDrain({
        creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: REFUND_PUBKEY },
      })
    ).rejects.toMatchObject({ code: "drain_below_dust" } satisfies Partial<CreditLedgerError>);
  });

  it("leaves a credit with no sats basis unpriced, for the live-rate fallback", async () => {
    await ledger.fund({
      creditId: "lots-unbacked",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 40_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 0 },
    });
    const { drain } = await ledger.requestDrain({
      creditId: "lots-unbacked",
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.owedSats).toBeNull();
  });

  /*
   * A basisless legacy lot and a later backed deposit cannot be priced together. The entire
   * reclaim must use the live-rate fallback.
   */
  it("keeps a mixed-basis credit out of the in-kind total and flags it whole", async () => {
    await withAdminPool(async (admin) => {
      await admin.query(
        `SET search_path = "${SCHEMA}"; DELETE FROM credits; DELETE FROM credit_funding_lots; DELETE FROM credit_drains;`
      );
    });
    await ledger.fund({
      creditId: "lots-mixed",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 40_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 0 },
    });
    await ledger.fund({
      creditId: "lots-mixed",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 100_000 },
    });

    const liability = await ledger.bitcoinDepositLiability();
    expect(liability).toMatchObject({
      depositSats: 0,
      credits: 1,
      uncoveredCredits: 0,
      unbackedCredits: 1,
      unbackedByCurrency: [{ currency: "usd", micro: 140_000, credits: 1 }],
    });
    const { drain } = await ledger.requestDrain({
      creditId: "lots-mixed",
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.owedSats).toBeNull();
  });

  it("reports mixed-currency gaps without adding their monetary amounts", async () => {
    await withAdminPool(async (admin) => {
      await admin.query(
        `SET search_path = "${SCHEMA}"; DELETE FROM credits; DELETE FROM credit_funding_lots; DELETE FROM credit_drains;`
      );
    });
    for (const [currency, uncovered, basisless] of [
      ["usd", 1_000_000, 200_000],
      ["jpy", 100_000_000, 20_000_000],
    ] as const) {
      const creditId = `gap-${currency}`;
      await ledger.fund({
        creditId,
        callerPubkey: CALLER,
        currency,
        amountMicro: uncovered,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 1_000_000 },
      });
      await pool.query("DELETE FROM credit_funding_lots WHERE credit_id = $1", [creditId]);
      await ledger.fund({
        creditId: `basisless-${currency}`,
        callerPubkey: CALLER,
        currency,
        amountMicro: basisless,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 0 },
      });
    }

    const liability = await ledger.bitcoinDepositLiability();
    expect(liability).toMatchObject({
      depositSats: 0,
      credits: 4,
      uncoveredCredits: 2,
      unbackedCredits: 2,
    });
    expect(liability.uncoveredByCurrency).toEqual([
      { currency: "jpy", micro: 100_000_000, credits: 1 },
      { currency: "usd", micro: 1_000_000, credits: 1 },
    ]);
    expect(liability.unbackedByCurrency).toEqual([
      { currency: "jpy", micro: 20_000_000, credits: 1 },
      { currency: "usd", micro: 200_000, credits: 1 },
    ]);
    expect(liability).not.toHaveProperty("uncoveredMicro");
    expect(liability).not.toHaveProperty("unbackedMicro");
  });

  it("reports the deposit floor the sweep may not bank below", async () => {
    await withAdminPool(async (admin) => {
      await admin.query(
        `SET search_path = "${SCHEMA}"; DELETE FROM credits; DELETE FROM credit_funding_lots; DELETE FROM credit_drains;`
      );
    });
    await btcCredit("floor-a", 1_151);
    await btcCredit("floor-b", 2_000);
    await ledger.draw({ creditId: "floor-b", drawId: "j1", amountMicro: 1_000_000 });
    await ledger.settle({ creditId: "floor-b", drawId: "j1" });

    const liability = await ledger.bitcoinDepositLiability();
    expect(liability).toMatchObject({
      depositSats: 1_151 + 1_000,
      credits: 2,
      uncoveredCredits: 0,
      unbackedCredits: 0,
      byRail: [{ rail: "lightning", sats: 2_151, credits: 2 }],
      byCurrency: [{ currency: "usd", micro: 1_151_000 + 1_000_000, credits: 2 }],
    });
  });

  /*
   * Delete the lots to reproduce a pre-migration credit, then run real init. This tests
   * existing data, not a fresh table.
   */
  it("backfills a lot onto a credit opened before lots existed", async () => {
    await btcCredit("backfill-me", 1_151);
    await ledger.draw({ creditId: "backfill-me", drawId: "j1", amountMicro: 9_000 });
    await ledger.settle({ creditId: "backfill-me", drawId: "j1" });
    await pool.query(`DELETE FROM credit_funding_lots WHERE credit_id = 'backfill-me'`);
    expect(await ledger.listFundingLots("backfill-me")).toEqual([]);

    await new CreditLedger(pool).init();

    expect(await ledger.listFundingLots("backfill-me")).toMatchObject([
      { satsFunded: 1_142, creditedMicro: 1_142_000, remainingMicro: 1_142_000 },
    ]);
    const { drain } = await ledger.requestDrain({
      creditId: "backfill-me",
      drainId: "r1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });
    expect(drain.owedSats).toBe(1_142 - DRAIN_DELIVERY_RESERVE_SATS);
  });

  it("backfills once, and leaves a credit that already has lots alone", async () => {
    const creditId = await btcCredit("backfill-idempotent", 500);
    await ledger.draw({ creditId, drawId: "j1", amountMicro: 100_000 });
    await ledger.settle({ creditId, drawId: "j1" });

    await new CreditLedger(pool).init();
    await new CreditLedger(pool).init();

    expect(await ledger.listFundingLots(creditId)).toMatchObject([
      { satsFunded: 500, creditedMicro: 500_000, remainingMicro: 400_000 },
    ]);
  });
});
