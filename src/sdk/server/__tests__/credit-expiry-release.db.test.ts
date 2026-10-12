import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreditFundingBasis } from "../credit-ledger";
import { CreditLedger } from "../credit-ledger";
import type { CreditExpiryReleasePayload, RevenueReporterQuerier } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_credit_expiry";
const CALLER = "ab".repeat(32);
const DVM_ID = "dvm_credit_expiry";
const REFUND_PUBKEY = `02${"cd".repeat(32)}`;

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

describe.skipIf(!RUN)("credit-expiry releases", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  let reported: CreditExpiryReleasePayload[];

  beforeAll(async () => {
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    });
    pool = await pinnedPool(SCHEMA);
    ledger = new CreditLedger(pool);
    await ledger.init();
    reported = [];
    ledger.useCreditExpiryReleaseOutbox({
      dvmId: DVM_ID,
      enqueue: async (_tx: RevenueReporterQuerier, payload: CreditExpiryReleasePayload) => {
        reported.push(payload);
      },
    });
  });

  afterAll(async () => {
    await pool.end();
    await withAdminPool(async (admin) => {
      await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    });
  });

  beforeEach(async () => {
    // The sweep is host-wide: every case needs a clean ledger, not just its own
    // credit, or a leftover expired credit joins the next case's page.
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_expiry_releases");
    await pool.query("DELETE FROM credit_funding_lots");
    await pool.query("DELETE FROM credits");
    reported = [];
  });

  async function expiredCredit(
    id: string,
    micro: number,
    opts: { agoMs?: number; rail?: "cashu" | "lightning" | "x402"; tempo?: boolean } = {}
  ): Promise<number> {
    const expiryMs = Date.now() - (opts.agoMs ?? 60_000);
    const rail = opts.rail ?? "lightning";
    const basis: CreditFundingBasis = opts.tempo
      ? {
          rail: "tempo",
          paidMsats: 0,
          nativeAsset: "usdc",
          nativeAmount: micro,
          tempoSession: { channelId: `0x${"ab".repeat(20)}`, cumulativeAmount: String(micro) },
        }
      : { rail, paidMsats: micro };
    await ledger.fund({
      creditId: id,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: micro,
      expiryMs,
      basis,
    });
    return expiryMs;
  }

  async function balanceOf(creditId: string): Promise<number> {
    const { rows } = await pool.query<{ balance_micro: string }>(
      "SELECT balance_micro FROM credits WHERE credit_id = $1",
      [creditId]
    );
    return Number(rows[0].balance_micro);
  }

  async function releaseRows(
    creditId: string
  ): Promise<
    { release_id: string; amount_micro: string; reversed_at: string | null; rail: string | null }[]
  > {
    const { rows } = await pool.query(
      `SELECT release_id, amount_micro, reversed_at, rail
         FROM credit_expiry_releases WHERE credit_id = $1
        ORDER BY released_at, release_id`,
      [creditId]
    );
    return rows as {
      release_id: string;
      amount_micro: string;
      reversed_at: string | null;
      rail: string | null;
    }[];
  }

  it("releases a partly drawn credit's remainder once, and a second pass writes nothing", async () => {
    const expiryMs = await expiredCredit("partly-drawn", 1_000_000, { agoMs: 60_000 });
    // A draw placed and settled before the credit lapsed. `nowMs` is what puts
    // the draw inside the credit's life; the settle never checks expiry.
    await ledger.draw({
      creditId: "partly-drawn",
      drawId: "d1",
      amountMicro: 400_000,
      nowMs: expiryMs - 10_000,
    });
    await ledger.settle({ creditId: "partly-drawn", drawId: "d1" });

    const first = await ledger.sweepExpiredCredits();
    expect(first.released).toHaveLength(1);
    expect(first.released[0]).toMatchObject({
      creditId: "partly-drawn",
      callerPubkey: CALLER,
      rail: "lightning",
      amountMicro: 600_000,
      expiryMs,
      reversedAt: null,
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      dvmId: DVM_ID,
      creditId: "partly-drawn",
      amountMicro: 600_000,
      creditCurrency: "usd",
      expiryMs,
      reversedAt: null,
    });

    const second = await ledger.sweepExpiredCredits();
    expect(second.released).toEqual([]);
    expect(reported).toHaveLength(1);
    expect(await releaseRows("partly-drawn")).toHaveLength(1);
  });

  it("releases nothing for a credit drawn to zero before its ttl", async () => {
    const expiryMs = await expiredCredit("fully-drawn", 500_000);
    await ledger.draw({
      creditId: "fully-drawn",
      drawId: "d1",
      amountMicro: 500_000,
      nowMs: expiryMs - 10_000,
    });
    await ledger.settle({ creditId: "fully-drawn", drawId: "d1" });

    expect((await ledger.sweepExpiredCredits()).released).toEqual([]);
    expect(reported).toEqual([]);
    expect(await releaseRows("fully-drawn")).toEqual([]);
  });

  it("releases nothing for a credit still inside its ttl", async () => {
    await ledger.fund({
      creditId: "live",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 750_000,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "cashu", paidMsats: 750_000 },
    });
    expect((await ledger.sweepExpiredCredits()).released).toEqual([]);
    expect(await releaseRows("live")).toEqual([]);
  });

  it("skips a tempo credit — its undrawn channel value returns to the caller", async () => {
    await expiredCredit("tempo-backed", 800_000, { tempo: true });
    expect((await ledger.sweepExpiredCredits()).released).toEqual([]);
    expect(reported).toEqual([]);
    expect(await releaseRows("tempo-backed")).toEqual([]);
  });

  it("skips a credit with a pending hold, then releases it once the hold resolves", async () => {
    const expiryMs = await expiredCredit("held", 900_000);
    await ledger.draw({
      creditId: "held",
      drawId: "d1",
      amountMicro: 300_000,
      nowMs: expiryMs - 10_000,
    });

    expect((await ledger.sweepExpiredCredits()).released).toEqual([]);
    expect(await releaseRows("held")).toEqual([]);

    await ledger.release({ creditId: "held", drawId: "d1" });
    const swept = await ledger.sweepExpiredCredits();
    expect(swept.released).toHaveLength(1);
    expect(swept.released[0].amountMicro).toBe(900_000);
  });

  it("reverses the release when a later funding revives the credit, and re-releases the new remainder", async () => {
    const firstExpiry = await expiredCredit("revived", 200_000);
    expect((await ledger.sweepExpiredCredits()).released).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(await balanceOf("revived")).toBe(0);

    // Reuse the exact expiry instant: reversal must not make the next episode collide with
    // the old release key.
    await ledger.fund({
      creditId: "revived",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: firstExpiry,
      basis: { rail: "lightning", paidMsats: 50_000 },
    });

    const afterRevival = await releaseRows("revived");
    expect(afterRevival).toHaveLength(1);
    expect(afterRevival[0].reversed_at).not.toBeNull();
    expect(await balanceOf("revived")).toBe(250_000);
    expect(reported).toHaveLength(2);
    expect(reported[1]).toMatchObject({
      creditId: "revived",
      releaseId: afterRevival[0].release_id,
      amountMicro: 200_000,
    });
    expect(reported[1].reversedAt).toBeGreaterThan(0);

    const again = await ledger.sweepExpiredCredits();
    expect(again.released).toHaveLength(1);
    expect(again.released[0].amountMicro).toBe(250_000);
    expect(again.released[0].expiryMs).toBe(firstExpiry);
    expect(again.released[0].releaseId).not.toBe(afterRevival[0].release_id);
    expect(await releaseRows("revived")).toHaveLength(2);
    expect(await balanceOf("revived")).toBe(0);
    expect((await ledger.sweepExpiredCredits()).released).toEqual([]);
    expect(await balanceOf("revived")).toBe(0);
  });

  it("refuses a drain once the release has taken the balance, and allows one after a revival", async () => {
    // The sweep must zero balance, not merely record a release; drains deliberately have no
    // expiry guard.
    await expiredCredit("drainable", 300_000, { rail: "cashu" });
    expect((await ledger.sweepExpiredCredits()).released).toHaveLength(1);

    const drain = {
      creditId: "drainable",
      drainId: "dr1",
      callerPubkey: CALLER,
      method: "cashu" as const,
      payout: { refund_pubkey: REFUND_PUBKEY },
    };
    await expect(ledger.requestDrain(drain)).rejects.toMatchObject({
      code: "nothing_to_drain",
    });

    await ledger.fund({
      creditId: "drainable",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 20_000,
      expiryMs: Date.now() + 3_600_000,
      basis: { rail: "cashu", paidMsats: 20_000 },
    });
    expect(await balanceOf("drainable")).toBe(320_000);
    const result = await ledger.requestDrain({ ...drain, drainId: "dr2" });
    expect(result.drain.amountMicro).toBe(320_000);
    expect(await balanceOf("drainable")).toBe(0);
  });

  it("commits the reversal with the funding that caused it, or not at all", async () => {
    await expiredCredit("rollback", 120_000);
    expect((await ledger.sweepExpiredCredits()).released).toHaveLength(1);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await ledger.fund({
        creditId: "rollback",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 10_000,
        expiryMs: Date.now() + 3_600_000,
        basis: { rail: "lightning", paidMsats: 10_000 },
        tx: client,
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const rows = await releaseRows("rollback");
    expect(rows).toHaveLength(1);
    expect(rows[0].reversed_at).toBeNull();
    expect(await balanceOf("rollback")).toBe(0);
  });

  it("rolls a tx-less funding's own transaction back when its reversal report throws", async () => {
    await expiredCredit("selftx", 70_000, { rail: "cashu" });
    expect((await ledger.sweepExpiredCredits()).released).toHaveLength(1);

    // Inject failure after the funding upsert in the outbox path. A ledger validation refusal
    // would occur before that partial write and could not prove its rollback.
    const failing = new CreditLedger(pool);
    failing.useCreditExpiryReleaseOutbox({
      dvmId: DVM_ID,
      enqueue: () => Promise.reject(new Error("outbox unavailable")),
    });

    await expect(
      failing.fund({
        creditId: "selftx",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 5_000,
        expiryMs: Date.now() + 3_600_000,
        basis: { rail: "cashu", paidMsats: 5_000 },
      })
    ).rejects.toThrow("outbox unavailable");

    expect((await releaseRows("selftx"))[0].reversed_at).toBeNull();
    expect(await balanceOf("selftx")).toBe(0);
    expect(await ledger.listFundingLots("selftx")).toHaveLength(1);
  });

  it("bounds one pass and picks the rest up on the next", async () => {
    for (let i = 0; i < 3; i++) await expiredCredit(`bounded-${i}`, 10_000 * (i + 1));

    const first = await ledger.sweepExpiredCredits({ limit: 2 });
    expect(first.released).toHaveLength(2);
    const second = await ledger.sweepExpiredCredits({ limit: 2 });
    expect(second.released).toHaveLength(1);
    expect((await ledger.sweepExpiredCredits({ limit: 2 })).released).toEqual([]);

    const ids = [...first.released, ...second.released].map((r) => r.creditId).sort();
    expect(ids).toEqual(["bounded-0", "bounded-1", "bounded-2"]);
  });

  it("writes the ledger row even with no outbox wired", async () => {
    const unwired = new CreditLedger(pool);
    await expiredCredit("unwired", 44_000);
    const swept = await unwired.sweepExpiredCredits();
    expect(swept.released).toHaveLength(1);
    expect(reported).toEqual([]);
    expect(await releaseRows("unwired")).toHaveLength(1);
  });
});
