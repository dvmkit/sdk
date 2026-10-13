import { randomBytes } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { type CreditFundingBasis, CreditLedger } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const CALLER = "a".repeat(64);
const FUTURE_MS = Date.now() + 86_400_000;

describe.skipIf(!RUN)("— rail value on the Postgres ledger", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  let creditId: string;
  let seq = 0;

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(pool);
    await ledger.init();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    creditId = `rv-${++seq}-${Date.now()}`;
  });

  async function fund(args: {
    amountMicro: number;
    paidMsats: number;
    nativeAmount?: number;
    rail?: CreditFundingBasis["rail"];
    /**
     * Funding instant, so a multi-lot credit's FIFO order is the one the test
     * means: `openLots` orders on `(created_at, lot_id)` and the id is a random
     * UUID, so two lots written in the same millisecond deplete arbitrarily.
     */
    nowMs?: number;
  }): Promise<void> {
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: args.amountMicro,
      expiryMs: FUTURE_MS,
      nowMs: args.nowMs,
      basis: {
        rail: args.rail ?? "x402",
        paidMsats: args.paidMsats,
        nativeAmount: args.nativeAmount,
        nativeAsset: args.nativeAmount === undefined ? undefined : "usdc",
        fundingRef: `0xfund-${creditId}`,
      },
    });
  }

  it("conserves rail value when the fiat split does not divide evenly", async () => {
    await fund({ amountMicro: 1_001, paidMsats: 999, nativeAmount: 37 });

    let msats = 0;
    let native = 0;
    for (let i = 0; i < 7; i++) {
      const draw = await ledger.draw({ creditId, drawId: `d${i}`, amountMicro: 143 });
      await ledger.settle({ creditId, drawId: `d${i}` });
      msats += draw.railValue.drawMsats;
      native += draw.railValue.drawNative ?? 0;
    }

    expect(msats).toBe(999);
    expect(native).toBe(37);
    const { rows } = await pool.query<{ msats_remaining: string; native_remaining: string }>(
      "SELECT msats_remaining, native_remaining FROM credits WHERE credit_id = $1", [creditId]
    );
    expect(rows[0]).toEqual({ msats_remaining: "0", native_remaining: "0" });
  });

  it("returns a released draw's allocation to the pool", async () => {
    await fund({ amountMicro: 1_000, paidMsats: 1_000, nativeAmount: 500 });

    await ledger.draw({ creditId, drawId: "d1", amountMicro: 500 });
    await ledger.release({ creditId, drawId: "d1" });

    const next = await ledger.draw({ creditId, drawId: "d2", amountMicro: 1_000 });
    expect(next.railValue.drawMsats).toBe(1_000);
    expect(next.railValue.drawNative).toBe(500);
  });

  it("allocates against pending holds, not just the settled balance", async () => {
    await fund({ amountMicro: 1_000, paidMsats: 1_000, nativeAmount: 100 });

    // Both draws are placed before either settles — the second must see the
    // first's allocation as already spoken for, or concurrent jobs would each
    // claim the whole funding.
    const a = await ledger.draw({ creditId, drawId: "a", amountMicro: 400 });
    const b = await ledger.draw({ creditId, drawId: "b", amountMicro: 600 });
    expect(a.railValue.drawMsats + b.railValue.drawMsats).toBe(1_000);
    expect((a.railValue.drawNative ?? 0) + (b.railValue.drawNative ?? 0)).toBe(100);
  });

  it("reads back the credit's rail identity on a lock-free draw read", async () => {
    await fund({ amountMicro: 1_000, paidMsats: 1_000, nativeAmount: 100 });
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 400 });
    await ledger.settle({ creditId, drawId: "d1", nowMs: 1_700_000_000_000 });

    // The terminal path books revenue off exactly this read, so the rail, the
    // asset, the funding reference and the settlement instant all have to
    // survive the round-trip.
    const draw = await ledger.getDraw({ creditId, drawId: "d1" });
    expect(draw?.status).toBe("settled");
    expect(draw?.resolvedAt).toBe(1_700_000_000_000);
    expect(draw?.railValue).toMatchObject({
      rail: "x402",
      nativeAsset: "usdc",
      fundingRef: `0xfund-${creditId}`,
      creditCurrency: "usd",
    });
  });

  it("refuses a cross-rail top-up without mutating the credit", async () => {
    await fund({ amountMicro: 1_000, paidMsats: 1_000, nativeAmount: 100 });

    await expect(
      ledger.fund({
        creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 500 },
      })
    ).rejects.toMatchObject({ code: "rail_mismatch" });

    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(1_000);
    // The snapshot carries the rail so a route can raise this same refusal
    // before the payment rather than after it.
    expect(snap?.rail).toBe("x402");
  });

  it("leaves a legacy credit drawable, with no rail value to allocate", async () => {
    // A row funded before the basis columns existed: the draw still works, it
    // just carries no rail identity, so the terminal books nothing rather than
    // guessing a rail wrong.
    //
    // `fund` can no longer write this shape — made the basis required
    // precisely because a draw against such a credit settles and books no
    // revenue — so the row is downgraded directly. Live databases still hold
    // rows like it: write is closed, read is not. The downgrade must land
    // before the draw, since allocation reads the remainders under the lock.
    await fund({ amountMicro: 1_000, paidMsats: 2_000 });
    await pool.query(
      `UPDATE credits
          SET rail = NULL, native_asset = NULL, mint = NULL, funding_ref = NULL,
              msats_remaining = 0, native_remaining = NULL
        WHERE credit_id = $1`,
      [creditId]
    );

    const draw = await ledger.draw({ creditId, drawId: "d1", amountMicro: 400 });
    expect(draw.railValue.drawMsats).toBe(0);
    expect(draw.railValue.rail).toBeNull();
    await expect(ledger.settle({ creditId, drawId: "d1" })).resolves.toMatchObject({
      status: "settled",
    });
  });

  it("reports the earned native value of an x402 channel's credit", async () => {
    // Unique per run: `credits_x402_channel_uidx` is UNIQUE table-wide, and
    // this database outlives the suite.
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1_100,
        nativeAmount: 1_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "1000" },
      },
    });

    // A pending hold earns nothing — the claim ceiling must not take money a
    // release still owes back.
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 400 });
    expect(await ledger.earnedNativeForX402Channel(channelId)).toBe(0);

    await ledger.settle({ creditId, drawId: "d1" });
    expect(await ledger.earnedNativeForX402Channel(channelId)).toBe(400);

    // The caller's reclaim empties `native_remaining` without earning any of
    // it, which is why the read sums settled draws instead of subtracting.
    await ledger.requestDrain({
      creditId,
      drainId: "drain-1",
      callerPubkey: CALLER,
      method: "x402",
      payout: { channel_id: channelId },
    });
    expect(await ledger.earnedNativeForX402Channel(channelId)).toBe(400);

    // A channel no credit is bound to is unresolvable, not earned-zero: the
    // claim job fails closed on it.
    expect(
      await ledger.earnedNativeForX402Channel(`0x${randomBytes(32).toString("hex")}`)
    ).toBeUndefined();
  });

  /**
   * the same figures the in-memory twin asserts, on the production
   * path. The two ledgers must land on identical integers — a settle that
   * re-prices differently in Postgres than in memory would make every unit
   * test a lie about production.
   */
  describe("one sats authority on a multi-rate Bitcoin credit", () => {
    it("books each settled draw at the deposit it consumed, and the credit closes", async () => {
      // 1,000 sats buys $1.00; the rate then halves and 500 sats buys the next.
      const openedAt = Date.now();
      await fund({ amountMicro: 1_000_000, paidMsats: 1_000_000, rail: "cashu", nowMs: openedAt });
      await fund({
        amountMicro: 1_000_000,
        paidMsats: 500_000,
        rail: "cashu",
        nowMs: openedAt + 1_000,
      });

      const first = await ledger.draw({ creditId, drawId: "d1", amountMicro: 600_000 });
      // The hold is a forecast off the pooled remainder — 1,500 sats over $2.00.
      expect(first.railValue.drawMsats).toBe(450_000);
      expect((await ledger.settle({ creditId, drawId: "d1" })).railValue.drawMsats).toBe(600_000);

      // Straddles both deposits: 400,000 micro of the first, 300,000 of the second.
      await ledger.draw({ creditId, drawId: "d2", amountMicro: 700_000 });
      expect((await ledger.settle({ creditId, drawId: "d2" })).railValue.drawMsats).toBe(550_000);

      // Committed, not just returned — this is the row `bookRevenue` re-reads,
      // and it carries the forecast it replaced beside it, which is what lets
      // that booking correct the job's counter by a delta instead of
      // overwriting it.
      const reread = await ledger.getDraw({ creditId, drawId: "d1" });
      expect(reread?.railValue.drawMsats).toBe(600_000);
      expect(reread?.allocatedMsats).toBe(450_000);

      const { drain } = await ledger.requestDrain({
        creditId,
        drainId: "r1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: { refund_pubkey: `02${"cd".repeat(32)}` },
      });
      expect(drain.amountMicro).toBe(700_000);
      // 350 sats of lot obligation shed, published net of the flat delivery
      // reserve the caller pays to have it handed back.
      expect(drain.owedSats).toBe(350 - DRAIN_DELIVERY_RESERVE_SATS);
      // 600 + 550 booked, 350 reclaimed, 1,500 funded. The pooled figures
      // booked 450 + 525 and left 175 sats attributable to nothing. The
      // reserve is a term in that identity rather than slack around it.
      expect(600 + 550 + (drain.owedSats ?? 0) + DRAIN_DELIVERY_RESERVE_SATS).toBe(1_500);
    });

    it("keeps the pooled figure where the lots cannot price the draw", async () => {
      // Sub-satoshi funding: the lot honestly carries no sats basis, so the
      // settle falls back exactly where the reclaim does.
      await fund({ amountMicro: 1_000_000, paidMsats: 900, rail: "cashu" });
      await ledger.draw({ creditId, drawId: "d1", amountMicro: 400_000 });
      expect((await ledger.settle({ creditId, drawId: "d1" })).railValue.drawMsats).toBe(360);
      // Nothing was superseded, so nothing is recorded as superseded: a draw
      // the settle never re-priced reads its allocation off `draw_msats`.
      expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.allocatedMsats).toBe(360);
    });

    it("re-prices a draw whose pooled forecast has already clamped to zero", async () => {
      // A legacy multi-rate credit after the upgrade: the old settle
      // decremented `msats_remaining` by the blended slice while the lots shed
      // the cheaper FIFO figure, so the pool empties with sats still on
      // deposit. Written straight to the column, since the code that produced
      // the skew is legacy state that current settlement no longer produces.
      await fund({ amountMicro: 1_000_000, paidMsats: 1_000_000, rail: "cashu" });
      await pool.query("UPDATE credits SET msats_remaining = 0 WHERE credit_id = $1", [creditId]);

      const held = await ledger.draw({ creditId, drawId: "d1", amountMicro: 600_000 });
      expect(held.railValue.drawMsats).toBe(0);
      expect((await ledger.settle({ creditId, drawId: "d1" })).railValue.drawMsats).toBe(600_000);
      // `allocated_msats` is written as a real zero, not left NULL: that is
      // what tells `bookRevenue` the job's counter holds the ask rather than
      // an allocation, so the settled figure replaces it outright.
      const reread = await ledger.getDraw({ creditId, drawId: "d1" });
      expect(reread?.railValue.drawMsats).toBe(600_000);
      expect(reread?.allocatedMsats).toBe(0);
    });

    it("leaves a rail with no lots on the pooled allocation", async () => {
      await fund({ amountMicro: 1_000_000, paidMsats: 1_000_000, nativeAmount: 1_000 });
      await ledger.draw({ creditId, drawId: "d1", amountMicro: 400_000 });
      const settled = await ledger.settle({ creditId, drawId: "d1" });
      expect(settled.railValue.drawMsats).toBe(400_000);
      expect(settled.railValue.drawNative).toBe(400);
    });
  });
});
