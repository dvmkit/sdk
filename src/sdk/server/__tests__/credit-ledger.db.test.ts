/*
 * Real Postgres tests retain row-lock serialization, primary-key races and transaction
 * rollback; memory-ledger assertions cannot establish these guarantees.
 */
import { randomBytes } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { CreditLedger, CreditLedgerError } from "../credit-ledger";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { describeCreditLedgerConformance } from "./__helpers__/credit-ledger-conformance";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const CALLER = "ab".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

async function expectLedgerError(
  p: Promise<unknown>,
  code: CreditLedgerError["code"]
): Promise<CreditLedgerError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(CreditLedgerError);
    const ledgerErr = err as CreditLedgerError;
    expect(ledgerErr.code).toBe(code);
    return ledgerErr;
  }
  throw new Error(`expected CreditLedgerError(${code}), but the call succeeded`);
}

describe.skipIf(!RUN)("credit ledger (Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let ledger: CreditLedger;
  let ledgerB: CreditLedger;

  async function clearLedgerTables(): Promise<void> {
    await poolA.query("DELETE FROM x402_credit_losses");
    await poolA.query("DELETE FROM tempo_credit_losses");
    await poolA.query("DELETE FROM credit_invoices");
    await poolA.query("DELETE FROM credit_draws");
    await poolA.query("DELETE FROM credit_drains");
    await poolA.query("DELETE FROM credit_funding_lots");
    await poolA.query("DELETE FROM credit_fundings");
    await poolA.query("DELETE FROM credits");
  }

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(poolA);
    ledgerB = new CreditLedger(poolB);
    await ledger.init();
    await clearLedgerTables();
  });

  afterEach(async () => {
    await clearLedgerTables();
  });

  afterAll(async () => {
    await poolA.end();
    await poolB.end();
  });

  async function fund(amountMicro: number, overrides: { expiryMs?: number } = {}): Promise<string> {
    const snap = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro,
      expiryMs: overrides.expiryMs ?? FUTURE_MS,
    });
    return snap.creditId;
  }

  describeCreditLedgerConformance(() => ledger);

  it("parallel draws from two machines: exactly-once, no lost updates, gap-free seq", async () => {
    const creditId = await fund(100_000);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        (i % 2 === 0 ? ledger : ledgerB)
          .draw({ creditId, drawId: `draw-${i}`, amountMicro: 10_000 })
          .then(
            (r) => ({ ok: true as const, r }),
            (err: unknown) => ({ ok: false as const, err })
          )
      )
    );
    const won = attempts.filter((a) => a.ok);
    const lost = attempts.filter((a) => !a.ok);
    expect(won).toHaveLength(10);
    expect(lost).toHaveLength(10);
    for (const l of lost) {
      expect(l.err).toBeInstanceOf(CreditLedgerError);
      expect((l.err as CreditLedgerError).code).toBe("insufficient_credit");
    }
    const seqs = won.map((w) => w.r.ledgerSeq).sort((a, b) => a - b);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(100_000);
    expect(snap?.availableMicro).toBe(0);
  });

  it("concurrent same-draw_id race: one placement, one replay, identical tuples", async () => {
    const creditId = await fund(50_000);
    const args = { creditId, drawId: "same-draw", amountMicro: 10_000 };
    const [a, b] = await Promise.all([ledger.draw(args), ledgerB.draw(args)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(a.ledgerSeq).toBe(b.ledgerSeq);
    expect(a.balanceAfterMicro).toBe(b.balanceAfterMicro);
    const { rows } = await poolA.query(`SELECT COUNT(*)::int AS n FROM credit_draws`);
    expect(rows[0].n).toBe(1);
    expect((await ledger.get(creditId))?.availableMicro).toBe(40_000);
  });

  it("persists one immutable Tempo loss across retries and ledger instances", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const credit = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 100_316,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "100316" },
      },
    });
    await ledger.draw({ creditId: credit.creditId, drawId: "served", amountMicro: 3_000 });
    await ledger.settle({ creditId: credit.creditId, drawId: "served" });

    const first = await ledger.terminalizeTempoCredits({
      channelId,
      settledOnChainNative: 0n,
      highestVoucherNative: 3_000n,
      consumedNative: 3_000n,
      observedAt: 123,
    });
    const retry = await ledgerB.terminalizeTempoCredits({
      channelId,
      settledOnChainNative: 1n,
      highestVoucherNative: 4_000n,
      consumedNative: 4_000n,
      observedAt: 456,
    });

    expect(retry).toEqual(first);
    expect(await ledgerB.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 97_000,
      availableMicro: 0,
      nativeAvailable: 0,
    });
    await expect(ledgerB.listTempoCreditLosses()).resolves.toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        formerBalanceMicro: 97_000,
        settledOnChainNative: 0n,
        highestVoucherNative: 3_000n,
        consumedServiceMicro: 3_000,
        consumedNative: 3_000n,
        observedAt: 123,
      }),
    ]);
  });

  it("persists one immutable x402 loss and removes the exited credit from availability", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const credit = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "100000" },
      },
    });
    await ledger.draw({ creditId: credit.creditId, drawId: "served", amountMicro: 3_000 });
    await ledger.settle({ creditId: credit.creditId, drawId: "served" });

    const first = await ledger.terminalizeX402Credit({
      channelId,
      channelBalanceNative: 3_000n,
      totalClaimedNative: 3_000n,
      observedAt: 123,
    });
    const retry = await ledgerB.terminalizeX402Credit({
      channelId,
      channelBalanceNative: 4_000n,
      totalClaimedNative: 4_000n,
      observedAt: 456,
    });

    expect(retry).toEqual(first);
    expect(await ledgerB.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 97_000,
      availableMicro: 0,
      nativeAvailable: 0,
    });
    await expect(ledgerB.listX402CreditLosses()).resolves.toEqual([
      expect.objectContaining({
        creditId: credit.creditId,
        formerBalanceMicro: 97_000,
        channelBalanceNative: 3_000n,
        totalClaimedNative: 3_000n,
        consumedServiceMicro: 3_000,
        observedAt: 123,
      }),
    ]);
  });

  it("keeps a fully settled x402 credit refillable and repairs a prior zero-liability terminalization", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const basis = {
      rail: "x402",
      paidMsats: 1,
      nativeAmount: 100_000,
      nativeAsset: "usdc",
      x402Channel: { channelId, maxClaimableAmount: "100000" },
    } as const;
    const credit = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis,
    });
    await ledger.requestDrain({
      creditId: credit.creditId,
      drainId: "settled-drain",
      callerPubkey: CALLER,
      method: "x402",
      payout: { address: `0x${"ab".repeat(20)}` },
      requireNoPending: true,
    });
    await ledger.markDrainSent({
      creditId: credit.creditId,
      drainId: "settled-drain",
      sentRef: { transaction: "0xsettled" },
    });

    const evidence = {
      channelId,
      channelBalanceNative: 0n,
      totalClaimedNative: 0n,
      observedAt: 123,
    };
    await expect(ledger.terminalizeX402Credit(evidence)).resolves.toEqual([]);
    expect(await ledger.get(credit.creditId)).toMatchObject({ status: "active", balanceMicro: 0 });

    // Simulate the zero-balance terminal row an older server version wrote.
    await poolA.query(`UPDATE credits SET status = 'unbacked' WHERE credit_id = $1`, [
      credit.creditId,
    ]);
    await poolA.query(
      `INSERT INTO x402_credit_losses
         (credit_id, channel_id, caller_pubkey, currency, former_balance_micro,
          channel_balance_native, total_claimed_native, consumed_service_micro, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [credit.creditId, channelId, CALLER, "usd", 0, 0, 0, 0, 122]
    );

    await Promise.all([
      ledger.terminalizeX402Credit(evidence),
      ledgerB.terminalizeX402Credit({ ...evidence, observedAt: 124 }),
    ]);
    expect(await ledger.get(credit.creditId)).toMatchObject({ status: "active", balanceMicro: 0 });
    await expect(ledger.listX402CreditLosses()).resolves.toEqual([]);

    await expect(
      ledger.fund({
        creditId: credit.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis,
      })
    ).resolves.toMatchObject({ status: "active", balanceMicro: 100_000 });
  });

  it("keeps an unsettled x402 drain terminal when the channel has no backing", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const credit = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 100_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "100000" },
      },
    });
    await ledger.requestDrain({
      creditId: credit.creditId,
      drainId: "pending-drain",
      callerPubkey: CALLER,
      method: "x402",
      payout: { address: `0x${"ab".repeat(20)}` },
      requireNoPending: true,
    });

    await expect(
      ledger.terminalizeX402Credit({
        channelId,
        channelBalanceNative: 0n,
        totalClaimedNative: 0n,
        observedAt: 123,
      })
    ).resolves.toEqual([
      expect.objectContaining({ creditId: credit.creditId, formerBalanceMicro: 0 }),
    ]);
    expect(await ledger.get(credit.creditId)).toMatchObject({
      status: "unbacked",
      balanceMicro: 0,
    });
  });

  it("same draw_id with different amount or job is a conflict, not a replay", async () => {
    const creditId = await fund(30_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 12_000, jobId: "j1" });
    const amountErr = await expectLedgerError(
      ledger.draw({ creditId, drawId: "d1", amountMicro: 13_000, jobId: "j1" }),
      "draw_conflict"
    );
    expect(amountErr.details.expectedAmountMicro).toBe(12_000);
    await expectLedgerError(
      ledger.draw({ creditId, drawId: "d1", amountMicro: 12_000, jobId: "other-job" }),
      "draw_conflict"
    );
    expect((await ledger.get(creditId))?.availableMicro).toBe(18_000);
  });

  it("replay after expiry still returns the original result (lost-response recovery)", async () => {
    const creditId = await fund(30_000);
    const first = await ledger.draw({ creditId, drawId: "d1", amountMicro: 12_000, jobId: "j1" });
    const afterExpiry = FUTURE_MS + 1;
    expect(first).toMatchObject({ replayed: false, balanceAfterMicro: 18_000, ledgerSeq: 1 });
    const replay = await ledgerB.draw({
      creditId,
      drawId: "d1",
      amountMicro: 12_000,
      jobId: "j1",
      nowMs: afterExpiry,
    });
    expect(replay).toEqual({ ...first, replayed: true });
    expect((await ledger.get(creditId))?.availableMicro).toBe(18_000);
    expect((await ledger.get(creditId))?.lastLedgerSeq).toBe(1);
    await expectLedgerError(
      ledger.draw({ creditId, drawId: "d2", amountMicro: 1_000, nowMs: afterExpiry }),
      "credit_expired"
    );
  });

  it("pending hold is excluded from available; release restores it; settle finalizes", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });
    let snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(100_000);
    expect(snap?.availableMicro).toBe(70_000);

    const released = await ledger.release({ creditId, drawId: "d1" });
    expect(released.status).toBe("released");
    expect(released.replayed).toBe(false);
    expect(released.availableMicro).toBe(100_000);
    snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(100_000);
    expect(snap?.availableMicro).toBe(100_000);

    await ledger.draw({ creditId, drawId: "d2", amountMicro: 40_000 });
    const settled = await ledger.settle({ creditId, drawId: "d2" });
    expect(settled.status).toBe("settled");
    expect(settled.availableMicro).toBe(60_000);
    snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(60_000);
    expect(snap?.availableMicro).toBe(60_000);
  });

  it("rolls back a release when its durable report cannot be queued", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });

    await expect(
      ledger.release({
        creditId,
        drawId: "d1",
        releaseOutbox: {
          dvmId: "dvm-test",
          enqueue: async () => {
            throw new Error("queue unavailable");
          },
        },
      })
    ).rejects.toThrow("queue unavailable");

    const pending = await poolA.query(
      "SELECT status FROM credit_draws WHERE credit_id = $1 AND draw_id = 'd1'",
      [creditId]
    );
    expect(pending.rows[0]?.status).toBe("pending");
    expect((await ledger.get(creditId))?.availableMicro).toBe(70_000);

    const enqueueCalls: string[] = [];
    const released = await ledger.release({
      creditId,
      drawId: "d1",
      releaseOutbox: {
        dvmId: "dvm-test",
        enqueue: async (_tx, payload) => {
          enqueueCalls.push(`${payload.dvmId}:${payload.creditId}:${payload.drawId}`);
        },
      },
    });
    expect(released.status).toBe("released");
    expect(enqueueCalls).toEqual([`dvm-test:${creditId}:d1`]);

    await ledger.release({
      creditId,
      drawId: "d1",
      releaseOutbox: {
        dvmId: "dvm-test",
        enqueue: async () => {
          enqueueCalls.push("replayed");
        },
      },
    });
    expect(enqueueCalls).toHaveLength(1);
  });

  it("settle and release are idempotent; cross-state transitions are refused", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });
    await ledger.draw({ creditId, drawId: "d2", amountMicro: 20_000 });

    const settled = await ledger.settle({ creditId, drawId: "d1" });
    const settledAgain = await ledgerB.settle({ creditId, drawId: "d1" });
    expect(settledAgain.replayed).toBe(true);
    expect(settledAgain.ledgerSeq).toBe(settled.ledgerSeq);
    expect(settledAgain.balanceAfterMicro).toBe(settled.balanceAfterMicro);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(70_000);

    const released = await ledger.release({ creditId, drawId: "d2" });
    const releasedAgain = await ledgerB.release({ creditId, drawId: "d2" });
    expect(releasedAgain.replayed).toBe(true);
    expect(releasedAgain.ledgerSeq).toBe(released.ledgerSeq);
    expect((await ledger.get(creditId))?.availableMicro).toBe(70_000);

    const releaseSettled = await expectLedgerError(
      ledger.release({ creditId, drawId: "d1" }),
      "invalid_draw_state"
    );
    expect(releaseSettled.details.currentStatus).toBe("settled");
    await expectLedgerError(ledger.settle({ creditId, drawId: "d2" }), "invalid_draw_state");
    await expectLedgerError(ledger.settle({ creditId, drawId: "nope" }), "draw_not_found");
  });

  it("settle and release succeed after expiry — a pre-expiry hold must not leak", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 30_000 });
    await ledger.draw({ creditId, drawId: "d2", amountMicro: 20_000 });
    const afterExpiry = FUTURE_MS + 1;
    const settled = await ledger.settle({ creditId, drawId: "d1", nowMs: afterExpiry });
    expect(settled.status).toBe("settled");
    const released = await ledger.release({ creditId, drawId: "d2", nowMs: afterExpiry });
    expect(released.status).toBe("released");
    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(70_000);
    expect(snap?.availableMicro).toBe(70_000);
  });

  it("growDraw enlarges the hold in place, keeping the draw's gap-free ledger_seq", async () => {
    const creditId = await fund(100_000);
    const placed = await ledger.draw({ creditId, drawId: "d1", amountMicro: 60_000, jobId: "j1" });
    // A sibling burns the next sequence number, so a re-taken seq would be
    // visibly wrong rather than coincidentally right.
    await ledger.draw({ creditId, drawId: "d2", amountMicro: 10_000, jobId: "j2" });

    const grown = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 25_000,
      jobId: "j1",
    });
    expect(grown.amountMicro).toBe(85_000);
    expect(grown.addedAmountMicro).toBe(25_000);
    expect(grown.ledgerSeq).toBe(placed.ledgerSeq);
    expect(grown.balanceAfterMicro).toBe(5_000);

    const snap = await ledger.get(creditId);
    expect(snap?.availableMicro).toBe(5_000);
    expect(snap?.lastLedgerSeq).toBe(2);

    const settled = await ledger.settle({ creditId, drawId: "d1" });
    expect(settled.amountMicro).toBe(85_000);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(15_000);
  });

  it("growDraw takes the credit row lock — concurrent grows can't oversubscribe", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });
    await ledger.draw({ creditId, drawId: "d2", amountMicro: 10_000, jobId: "j2" });

    const results = await Promise.allSettled([
      ledger.growDraw({ creditId, drawId: "d1", addAmountMicro: 60_000 }),
      ledgerB.growDraw({ creditId, drawId: "d2", addAmountMicro: 60_000 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const { reason } = failed[0];
    expect(reason).toBeInstanceOf(CreditLedgerError);
    expect((reason as CreditLedgerError).code).toBe("insufficient_credit");
    expect((await ledger.get(creditId))?.availableMicro).toBe(20_000);
  });

  it("growDraw refuses a resolved draw and an unknown one", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });
    await ledger.settle({ creditId, drawId: "d1" });

    const resolved = await expectLedgerError(
      ledger.growDraw({ creditId, drawId: "d1", addAmountMicro: 1_000 }),
      "invalid_draw_state"
    );
    expect(resolved.details.currentStatus).toBe("settled");
    await expectLedgerError(
      ledger.growDraw({ creditId, drawId: "nope", addAmountMicro: 1_000 }),
      "draw_not_found"
    );
  });

  it("growDraw earmarks the funding's own rail value to the increment", async () => {
    const snap = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 900_000, fundingRef: "first" },
    });
    const creditId = snap.creditId;
    await ledger.draw({ creditId, drawId: "sib", amountMicro: 500_000, jobId: "j-sib" });
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 100_000, jobId: "j1" });
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 55_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 50_000, fundingRef: "topup" },
    });

    const grown = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 55_000,
      addRailValue: { drawMsats: 50_000, drawNative: null },
      jobId: "j1",
    });
    // Exactly what the top-up paid; a pro-rata slice of the blended pool would
    // be 49_560, and that shortfall is the job's `paid_msats` delta.
    expect(grown.addedRailValue.drawMsats).toBe(50_000);
    expect(grown.railValue.drawMsats).toBe(140_000);

    const proRata = await ledger.growDraw({ creditId, drawId: "sib", addAmountMicro: 55_000 });
    expect(proRata.addedRailValue.drawMsats).toBeLessThan(50_000);
  });

  it("growDraw clips growth at the cap and refuses the rest, never throwing", async () => {
    // Fund raises balance before growth, so only the cumulative ask cap can reject a
    // duplicate payment. Refused excess remains funded balance.
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });

    const first = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 30_000,
      capMicro: 30_000,
      jobId: "j1",
    });
    expect(first.addedAmountMicro).toBe(30_000);
    expect(first.cappedMicro).toBe(0);
    expect(first.amountMicro).toBe(40_000);

    const duplicate = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 30_000,
      capMicro: 30_000,
      jobId: "j1",
    });
    expect(duplicate.addedAmountMicro).toBe(0);
    expect(duplicate.cappedMicro).toBe(30_000);
    expect(duplicate.amountMicro).toBe(40_000);
    expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.amountMicro).toBe(40_000);

    const clipped = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 25_000,
      capMicro: 40_000,
      jobId: "j1",
    });
    expect(clipped.addedAmountMicro).toBe(10_000);
    expect(clipped.cappedMicro).toBe(15_000);
    expect(clipped.amountMicro).toBe(50_000);
    expect((await ledger.get(creditId))?.availableMicro).toBe(50_000);
  });

  it("growDraw's clip scales the rail earmark up, never short of the ask", async () => {
    // A clipped paid_msats delta must round up to reach the paid ask’s resume threshold.
    const snap = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 100_000, fundingRef: "base" },
    });
    const creditId = snap.creditId;
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 30_001,
      expiryMs: FUTURE_MS,
      basis: { rail: "cashu", paidMsats: 30_000, fundingRef: "topup" },
    });

    // ceil(30_000 × 20_000 / 30_001) = 20_000; floor would return 19_999.
    const grown = await ledger.growDraw({
      creditId,
      drawId: "d1",
      addAmountMicro: 30_001,
      addRailValue: { drawMsats: 30_000, drawNative: null },
      capMicro: 20_000,
      jobId: "j1",
    });
    expect(grown.addedAmountMicro).toBe(20_000);
    expect(grown.addedRailValue.drawMsats).toBe(20_000);
  });

  it("growDraw's cap is enforced under the credit row lock — two pools, one grant", async () => {
    // Both pools race with the same available ask. The winner’s grown_micro must be visible
    // under the credit lock before the loser chooses its grant.
    const creditId = await fund(200_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });

    const grows = await Promise.all([
      ledger.growDraw({ creditId, drawId: "d1", addAmountMicro: 50_000, capMicro: 50_000 }),
      ledgerB.growDraw({ creditId, drawId: "d1", addAmountMicro: 50_000, capMicro: 50_000 }),
    ]);
    const granted = grows.filter((g) => g.addedAmountMicro > 0);
    expect(granted).toHaveLength(1);
    expect(granted[0].addedAmountMicro).toBe(50_000);
    expect(grows.filter((g) => g.cappedMicro === 50_000)).toHaveLength(1);
    expect((await ledger.getDraw({ creditId, drawId: "d1" }))?.amountMicro).toBe(60_000);
  });

  it("growDraw joins a caller transaction — a rollback un-grows the draw", async () => {
    const creditId = await fund(100_000);
    await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000, jobId: "j1" });

    const client = await poolA.connect();
    try {
      await client.query("BEGIN");
      await ledger.growDraw({ creditId, drawId: "d1", addAmountMicro: 20_000, tx: client });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    const draw = await ledger.getDraw({ creditId, drawId: "d1" });
    expect(draw?.amountMicro).toBe(10_000);
  });

  it("fund inside an aborted caller transaction leaves no credit row", async () => {
    const client = await poolA.connect();
    try {
      await client.query("BEGIN");
      const snap = await fundCredit(ledger, {
        creditId: "tx-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 50_000,
        expiryMs: FUTURE_MS,
        tx: client,
      });
      expect(snap.balanceMicro).toBe(50_000);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(await ledger.get("tx-credit")).toBeUndefined();
  });

  it("fund inside a committed caller transaction is visible from the other machine", async () => {
    const client = await poolA.connect();
    try {
      await client.query("BEGIN");
      await fundCredit(ledger, {
        creditId: "tx-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 50_000,
        expiryMs: FUTURE_MS,
        tx: client,
      });
      const topped = await fundCredit(ledger, {
        creditId: "tx-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 25_000,
        expiryMs: FUTURE_MS,
        tx: client,
      });
      expect(topped.balanceMicro).toBe(75_000);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await ledgerB.get("tx-credit"))?.balanceMicro).toBe(75_000);
  });

  it("top-up refuses a caller or currency mismatch instead of merging money", async () => {
    const creditId = await fund(10_000);
    await expectLedgerError(
      fundCredit(ledger, {
        creditId,
        callerPubkey: "cd".repeat(32),
        currency: "usd",
        amountMicro: 5_000,
        expiryMs: FUTURE_MS,
      }),
      "caller_mismatch"
    );
    await expectLedgerError(
      fundCredit(ledger, {
        creditId,
        callerPubkey: CALLER,
        currency: "eur",
        amountMicro: 5_000,
        expiryMs: FUTURE_MS,
      }),
      "currency_mismatch"
    );
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000);
  });

  it("refuses mixing one-shot MPP charge and Tempo session funding", async () => {
    const shared = {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    };
    const charge = await ledger.fund({
      ...shared,
      basis: { rail: "tempo", paidMsats: 1, nativeAmount: 10_000, nativeAsset: "pathUSD" },
    });
    await expectLedgerError(
      ledger.fund({
        ...shared,
        creditId: charge.creditId,
        basis: {
          rail: "tempo",
          paidMsats: 1,
          nativeAmount: 10_000,
          nativeAsset: "pathUSD",
          tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "10000" },
        },
      }),
      "rail_mismatch"
    );

    const session = await ledger.fund({
      ...shared,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 10_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: `0x${"22".repeat(32)}`, cumulativeAmount: "10000" },
      },
    });
    await expectLedgerError(
      ledger.fund({
        ...shared,
        creditId: session.creditId,
        basis: { rail: "tempo", paidMsats: 1, nativeAmount: 10_000, nativeAsset: "pathUSD" },
      }),
      "rail_mismatch"
    );
  });

  it("maps the x402 channel unique index to a typed refusal naming its credit", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    await ledger.fund({
      creditId: `bound-${channelId}`,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 10_000,
        nativeAsset: "usdc",
        x402Channel: { channelId, maxClaimableAmount: "10000" },
      },
    });

    const err = await expectLedgerError(
      ledger.fund({
        creditId: `fresh-${channelId}`,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 10_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 10_000,
          nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "20000" },
        },
      }),
      "rail_mismatch"
    );
    expect(err.details).toMatchObject({
      expectedRail: "x402",
      expectedInstrument: "x402_channel",
      expectedChannelId: channelId,
      boundCreditId: `bound-${channelId}`,
    });
  });

  // Pin one-shot versus reusable channel funding symmetrically; the channel-wide unique index
  // alone does not prevent mixing sources on one credit.
  it("refuses mixing one-shot x402 exact and batch-settlement channel funding", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const shared = {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    };
    const exactBasis = {
      rail: "x402" as const,
      paidMsats: 1,
      nativeAmount: 10_000,
      nativeAsset: "usdc",
    };

    const exact = await ledger.fund({ ...shared, basis: exactBasis });
    const adopted = await expectLedgerError(
      ledger.fund({
        ...shared,
        creditId: exact.creditId,
        basis: { ...exactBasis, x402Channel: { channelId, maxClaimableAmount: "10000" } },
      }),
      "rail_mismatch"
    );
    expect(adopted.details).toMatchObject({
      expectedRail: "x402",
      expectedInstrument: "x402_exact",
      expectedChannelId: null,
    });
    const afterRefusal = await ledger.get(exact.creditId);
    expect(afterRefusal?.balanceMicro).toBe(10_000);
    expect(afterRefusal?.x402ChannelId).toBeNull();

    const channel = await ledger.fund({
      ...shared,
      basis: { ...exactBasis, x402Channel: { channelId, maxClaimableAmount: "10000" } },
    });
    const downgraded = await expectLedgerError(
      ledger.fund({ ...shared, creditId: channel.creditId, basis: exactBasis }),
      "rail_mismatch"
    );
    expect(downgraded.details).toMatchObject({
      expectedRail: "x402",
      expectedInstrument: "x402_channel",
      expectedChannelId: channelId,
    });
    expect((await ledger.get(channel.creditId))?.balanceMicro).toBe(10_000);
  });

  it("keeps a channel's claim ceiling free of draws it never funded", async () => {
    const channelId = `0x${randomBytes(32).toString("hex")}`;
    const exactBasis = {
      rail: "x402" as const,
      paidMsats: 1,
      nativeAmount: 5_000,
      nativeAsset: "usdc",
    };
    const exact = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 5_000,
      expiryMs: FUTURE_MS,
      basis: exactBasis,
    });
    await ledger.draw({ creditId: exact.creditId, drawId: "d1", amountMicro: 5_000 });
    await ledger.settle({ creditId: exact.creditId, drawId: "d1" });

    // A fresh $3 channel deposit naming the same credit is refused. Were it
    // admitted, `earnedNativeForX402Channel` would read the exact-funded draw
    // as this channel's earnings and the first claim tick would present the
    // whole deposit with none of it consumed.
    await expectLedgerError(
      ledger.fund({
        creditId: exact.creditId,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 3_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 3_000,
          nativeAsset: "usdc",
          x402Channel: { channelId, maxClaimableAmount: "3000" },
        },
      }),
      "rail_mismatch"
    );

    expect(await ledger.earnedNativeForX402Channel(channelId)).toBeUndefined();
  });

  it("refuses a channel deposit onto a legacy rail-less credit without naming an instrument", async () => {
    // A row written before rail basis was recorded: `rail`,
    // `native_asset` and both channel columns are NULL and unknowable.
    await poolA.query(
      `INSERT INTO credits (credit_id, caller_pubkey, currency, balance_micro, expiry_ms, status, created_at)
       VALUES ('legacy-credit', $1, 'usd', 10000, $2, 'active', $3)`,
      [CALLER, FUTURE_MS, Date.now()]
    );

    const err = await expectLedgerError(
      ledger.fund({
        creditId: "legacy-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 10_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 1,
          nativeAmount: 10_000,
          nativeAsset: "usdc",
          x402Channel: {
            channelId: `0x${randomBytes(32).toString("hex")}`,
            maxClaimableAmount: "10000",
          },
        },
      }),
      "rail_mismatch"
    );
    expect(err.message).toContain("is not bound to an x402 batch-settlement channel");
    expect(err.details).not.toHaveProperty("expectedInstrument");
    expect((await ledger.get("legacy-credit"))?.balanceMicro).toBe(10_000);
  });

  it("post-TTL draws are refused with a typed error; balance stays readable", async () => {
    const expiryMs = Date.now() - 1_000;
    const creditId = await fund(40_000, { expiryMs });
    const err = await expectLedgerError(
      ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000 }),
      "credit_expired"
    );
    expect(err.details.expiryMs).toBe(expiryMs);
    expect(err.details.balanceMicro).toBe(40_000);
    const snap = await ledger.get(creditId);
    expect(snap?.balanceMicro).toBe(40_000);
    expect(snap?.expired).toBe(true);
  });

  it("a top-up with a future expiry revives an expired credit (carry-forward)", async () => {
    const creditId = await fund(40_000, { expiryMs: Date.now() - 1_000 });
    const revived = await fundCredit(ledger, {
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 10_000,
      expiryMs: FUTURE_MS,
    });
    expect(revived.balanceMicro).toBe(50_000);
    expect(revived.expired).toBe(false);
    const drawn = await ledger.draw({ creditId, drawId: "d1", amountMicro: 10_000 });
    expect(drawn.balanceAfterMicro).toBe(40_000);
  });

  it("refuses negative, fractional, and unsafe amounts before touching the DB", async () => {
    const creditId = await fund(10_000);
    for (const amountMicro of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
      await expectLedgerError(
        ledger.draw({ creditId, drawId: "bad", amountMicro }),
        "invalid_amount"
      );
      await expectLedgerError(
        fundCredit(ledger, {
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro,
          expiryMs: FUTURE_MS,
        }),
        "invalid_amount"
      );
    }
    // Zero is a valid draw (free job under a credit) but an invalid funding.
    const zero = await ledger.draw({ creditId, drawId: "zero", amountMicro: 0 });
    expect(zero.ledgerSeq).toBe(1);
    expect(zero.balanceAfterMicro).toBe(10_000);
    await expectLedgerError(
      fundCredit(ledger, {
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 0,
        expiryMs: FUTURE_MS,
      }),
      "invalid_amount"
    );
    await expectLedgerError(
      fundCredit(ledger, { callerPubkey: CALLER, currency: "usd", amountMicro: 1, expiryMs: -5 }),
      "invalid_expiry"
    );
  });

  describe("stale-draw reconciliation concurrency", () => {
    it("two machines sweeping one orphan release it exactly once", async () => {
      const creditId = await fund(100_000);
      await ledger.draw({
        creditId,
        drawId: "orphan",
        amountMicro: 30_000,
        jobId: "job-never-persisted",
        nowMs: 1_000,
      });
      expect((await ledger.get(creditId))?.availableMicro).toBe(70_000);

      const [seenA, seenB] = await Promise.all([
        ledger.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 }),
        ledgerB.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 }),
      ]);
      expect([seenA.length, seenB.length]).toEqual([1, 1]);

      const resolutions = await Promise.all([
        ledger.release({ creditId, drawId: "orphan" }),
        ledgerB.release({ creditId, drawId: "orphan" }),
      ]);
      expect(resolutions.filter((r) => !r.replayed)).toHaveLength(1);
      expect(resolutions.every((r) => r.status === "released")).toBe(true);
      expect(new Set(resolutions.map((r) => r.resolvedAt)).size).toBe(1);

      const snap = await ledgerB.get(creditId);
      expect(snap?.availableMicro).toBe(100_000);
      expect(snap?.balanceMicro).toBe(100_000);
      expect(await ledger.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 })).toEqual([]);
    });

    it("two machines reconciling one completed job settle it exactly once", async () => {
      // Exactly one racing settle returns replayed:false; that bit controls revenue booking,
      // not only balance idempotency.
      const creditId = await fund(100_000);
      await ledger.draw({
        creditId,
        drawId: "stranded",
        amountMicro: 30_000,
        jobId: "job-terminal",
        nowMs: 1_000,
      });

      const [seenA, seenB] = await Promise.all([
        ledger.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 }),
        ledgerB.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 }),
      ]);
      expect([seenA.length, seenB.length]).toEqual([1, 1]);

      const resolutions = await Promise.all([
        ledger.settle({ creditId, drawId: "stranded" }),
        ledgerB.settle({ creditId, drawId: "stranded" }),
      ]);
      expect(resolutions.filter((r) => !r.replayed)).toHaveLength(1);
      expect(resolutions.every((r) => r.status === "settled")).toBe(true);
      expect(new Set(resolutions.map((r) => r.resolvedAt)).size).toBe(1);

      const snap = await ledgerB.get(creditId);
      expect(snap?.balanceMicro).toBe(70_000);
      expect(snap?.availableMicro).toBe(70_000);
      expect(await ledger.listStalePendingDraws({ createdBeforeMs: 5_000, limit: 10 })).toEqual([]);
    });
  });

  describe("credit_fundings", () => {
    it("records a funding and reads it back", async () => {
      const creditId = await fund(10_000);
      const rec = await ledger.recordFunding({ creditId, fundId: "f1", amountMicro: 5_000 });
      expect(rec).toMatchObject({ creditId, fundId: "f1", amountMicro: 5_000, rail: null });
      expect(await ledger.getFunding({ creditId, fundId: "f1" })).toMatchObject({
        amountMicro: 5_000,
      });
      expect(await ledger.getFunding({ creditId, fundId: "nope" })).toBeUndefined();
    });

    it("lets exactly one of two racing machines win the same fund_id", async () => {
      const creditId = await fund(10_000);
      const results = await Promise.allSettled([
        ledger.recordFunding({ creditId, fundId: "race", amountMicro: 5_000 }),
        ledgerB.recordFunding({ creditId, fundId: "race", amountMicro: 5_000 }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(1);
      const reason: unknown = rejected[0].reason;
      expect(reason).toBeInstanceOf(CreditLedgerError);
      expect((reason as CreditLedgerError).code).toBe("funding_replayed");
      const { rows } = await poolA.query<{ count: string }>(
        "SELECT COUNT(*) AS count FROM credit_fundings WHERE credit_id = $1",
        [creditId]
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    it("rolls back with the caller's transaction — no funding without the money", async () => {
      // Throw after funding record and balance writes on the same caller transaction; neither
      // may survive rollback.
      const creditId = await fund(10_000);
      const client = await poolA.connect();
      try {
        await client.query("BEGIN");
        await ledger.recordFunding({ creditId, fundId: "tx1", amountMicro: 5_000, tx: client });
        await fundCredit(ledger, {
          creditId,
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro: 5_000,
          expiryMs: FUTURE_MS,
          tx: client,
        });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect(await ledger.getFunding({ creditId, fundId: "tx1" })).toBeUndefined();
      expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000);
    });

    it("commits with the caller's transaction and is visible from the other machine", async () => {
      const creditId = await fund(10_000);
      const client = await poolA.connect();
      try {
        await client.query("BEGIN");
        await ledger.recordFunding({ creditId, fundId: "tx2", amountMicro: 5_000, tx: client });
        await fundCredit(ledger, {
          creditId,
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro: 5_000,
          expiryMs: FUTURE_MS,
          tx: client,
        });
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      expect(await ledgerB.getFunding({ creditId, fundId: "tx2" })).toMatchObject({
        amountMicro: 5_000,
      });
      expect((await ledgerB.get(creditId))?.balanceMicro).toBe(15_000);
    });

    it("refuses a non-positive funding amount", async () => {
      const creditId = await fund(10_000);
      await expectLedgerError(
        ledger.recordFunding({ creditId, fundId: "z", amountMicro: 0 }),
        "invalid_amount"
      );
    });
  });

  describe("credit_drains", () => {
    const PAYOUT = { refund_pubkey: "02" + "cd".repeat(32) };

    it("two machines racing one drain_id: the balance zeroes exactly once", async () => {
      const creditId = await fund(100_000);
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 === 0 ? ledger : ledgerB)
            .requestDrain({
              creditId,
              drainId: "d1",
              callerPubkey: CALLER,
              method: "cashu",
              payout: PAYOUT,
            })
            .catch((err: unknown) => err)
        )
      );
      const ok = results.filter(
        (r): r is Awaited<ReturnType<CreditLedger["requestDrain"]>> =>
          typeof r === "object" && r !== null && "drain" in r
      );
      expect(ok).toHaveLength(10);
      expect(ok.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(ok.map((r) => r.drain.amountMicro))).toEqual(new Set([100_000]));
      expect((await ledgerB.get(creditId))?.balanceMicro).toBe(0);
    });

    it("a drain racing concurrent draws never over- or under-counts", async () => {
      const creditId = await fund(100_000);
      const [drainResult, ...drawResults] = await Promise.all([
        ledger.requestDrain({
          creditId,
          drainId: "d1",
          callerPubkey: CALLER,
          method: "cashu",
          payout: PAYOUT,
        }),
        ...Array.from({ length: 5 }, (_, i) =>
          ledgerB
            .draw({ creditId, drawId: `w${i}`, amountMicro: 10_000 })
            .then(() => "drawn" as const)
            .catch(() => "refused" as const)
        ),
      ]);
      const drawn = drawResults.filter((r) => r === "drawn").length;
      expect(drainResult.drain.amountMicro + drawn * 10_000).toBe(100_000);
      expect(drainResult.drain.balanceAfterMicro).toBe(drawn * 10_000);
      const snap = await ledgerB.get(creditId);
      expect(snap?.balanceMicro).toBe(drawn * 10_000);
      expect(snap?.availableMicro).toBe(0);
    });

    it("drain seq shares the gap-free chain with draws, enforced by the unique index", async () => {
      const creditId = await fund(50_000);
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 10_000 });
      const drained = await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      expect(drained.drain.ledgerSeq).toBe(2);
      expect(drained.drain.balanceAfterMicro).toBe(10_000);
      expect((await ledger.get(creditId))?.lastLedgerSeq).toBe(2);
    });

    it("takes the rail-value remainder with the fiat — later draws can't over-allocate", async () => {
      const snap = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 500_000_000 },
      });
      const creditId = snap.creditId;
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 100_000 });
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      const { rows } = await poolA.query<{ msats_remaining: string }>(
        "SELECT msats_remaining FROM credits WHERE credit_id = $1",
        [creditId]
      );
      expect(Number(rows[0].msats_remaining)).toBe(100_000_000);
      await ledger.release({ creditId, drawId: "w1" });
      const w2 = await ledger.draw({ creditId, drawId: "w2", amountMicro: 100_000 });
      expect(w2.railValue.drawMsats).toBe(100_000_000);
    });

    it("atomically refuses a channel drain while a draw is pending", async () => {
      const creditId = await fund(100_000);
      await ledger.draw({ creditId, drawId: "w1", amountMicro: 10_000 });
      await expectLedgerError(
        ledger.requestDrain({
          creditId,
          drainId: "d1",
          callerPubkey: CALLER,
          method: "tempo",
          payout: {},
          requireNoPending: true,
        }),
        "drain_conflict"
      );
      expect(await ledgerB.getDrain({ creditId, drainId: "d1" })).toBeUndefined();
      expect((await ledgerB.get(creditId))?.balanceMicro).toBe(100_000);
    });

    it("releases an unpaid channel drain and restores its exact native basis", async () => {
      const funded = await ledger.fund({
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      await ledger.requestDrain({
        creditId: funded.creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "tempo",
        payout: {},
        requireNoPending: true,
      });
      const released = await ledgerB.releaseDrain({ creditId: funded.creditId, drainId: "d1" });
      expect(released).toMatchObject({ replayed: false, drain: { status: "released" } });
      expect(released.credit.balanceMicro).toBe(100_000);
      expect(
        (await ledger.releaseDrain({ creditId: funded.creditId, drainId: "d1" })).replayed
      ).toBe(true);
      const draw = await ledger.draw({
        creditId: funded.creditId,
        drawId: "after-release",
        amountMicro: 100_000,
      });
      expect(draw.railValue.drawNative).toBe(100_000);
    });

    it("park/pickup/sent transitions are CAS-guarded and idempotent", async () => {
      const creditId = await fund(30_000);
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      await expectLedgerError(
        ledger.markDrainPickedUp({ creditId, drainId: "d1" }),
        "invalid_drain_state"
      );
      await ledger.parkDrain({ creditId, drainId: "d1", token: "cashuB1" });
      expect((await ledgerB.parkDrain({ creditId, drainId: "d1", token: "cashuB1" })).status).toBe(
        "parked"
      );
      await expectLedgerError(
        ledgerB.parkDrain({ creditId, drainId: "d1", token: "cashuB2" }),
        "drain_conflict"
      );
      // The CAS winner alone reports `replayed: false` — the drain report is
      // emitted off that bit, so exactly one caller may see it.
      const picked = await ledgerB.markDrainPickedUp({ creditId, drainId: "d1" });
      expect(picked.drain.status).toBe("picked_up");
      expect(picked.replayed).toBe(false);
      const rePicked = await ledger.markDrainPickedUp({ creditId, drainId: "d1" });
      expect(rePicked.drain.status).toBe("picked_up");
      expect(rePicked.replayed).toBe(true);
      await expectLedgerError(
        ledger.markDrainSent({ creditId, drainId: "d1", sentRef: {} }),
        "drain_conflict"
      );
    });

    it("parkDrain joins an external transaction — rollback leaves the drain pending", async () => {
      const creditId = await fund(30_000);
      await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "cashu",
        payout: PAYOUT,
      });
      const client = await poolA.connect();
      try {
        await client.query("BEGIN");
        await ledger.parkDrain({ creditId, drainId: "d1", token: "cashuB1", tx: client });
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      expect((await ledgerB.getDrain({ creditId, drainId: "d1" }))?.status).toBe("pending");
    });

    it("drains an expired credit and appends receipts", async () => {
      const creditId = await fund(30_000, { expiryMs: Date.now() + 1 });
      await new Promise((r) => setTimeout(r, 5));
      const result = await ledger.requestDrain({
        creditId,
        drainId: "d1",
        callerPubkey: CALLER,
        method: "x402",
        payout: { address: `0x${"ab".repeat(20)}` },
      });
      expect(result.drain.amountMicro).toBe(30_000);
      await ledger.appendDrainReceipt({
        creditId,
        drainId: "d1",
        receipt: { event: "requested", v: 1 },
      });
      await ledger.appendDrainReceipt({
        creditId,
        drainId: "d1",
        receipt: { event: "sent", v: 1 },
      });
      const drain = await ledgerB.getDrain({ creditId, drainId: "d1" });
      expect(drain?.receipts.map((r) => r.event)).toEqual(["requested", "sent"]);
    });
  });

  describe("x402 spend gate", () => {
    /*
     * Hold the credit lock while the refund gate changes. A draw already waiting for this
     * lock must read the changed gate after acquiring it; a pre-lock read would allow
     * spending paid-out backing.
     */
    it("consults the gate under the credit lock, so a settlement landing mid-wait still refuses", async () => {
      const channelId = `0x${randomBytes(20).toString("hex")}`;
      const snap = await ledger.fund({
        creditId: `race-${randomBytes(4).toString("hex")}`,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 400_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 0,
          fundingRef: "0xdeposit",
          x402Channel: { channelId, maxClaimableAmount: "400" },
        },
      });
      const creditId = snap.creditId;
      let settled = false;
      ledger.useX402SettlementGate({
        // Answers only for this channel, so the gate stays inert on the shared
        // ledger instance once this test has flipped it.
        pendingRefundSettlement: (id) =>
          Promise.resolve(
            settled && id === channelId
              ? {
                  settlementId: "settlement-race",
                  effectId: `${creditId}:drain-race`,
                  status: "settled" as const,
                }
              : undefined
          ),
      });

      const holder = await poolB.connect();
      try {
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const holderPid = rows[0].pid;
        await holder.query("BEGIN");
        await holder.query("SELECT credit_id FROM credits WHERE credit_id = $1 FOR UPDATE", [
          creditId,
        ]);

        const draw = ledger.draw({ creditId, drawId: "draw-race", amountMicro: 1_000 });
        // Waiting on *this* holder specifically: the assertion is only a
        // regression test if the draw has already passed the point where the
        // old code read the gate, and blocking on the lock proves it has.
        await waitForBlockedOn(poolA, holderPid);
        settled = true;
        await holder.query("COMMIT");

        const err = await expectLedgerError(draw, "settlement_pending");
        expect(err.details).toMatchObject({
          settlementId: "settlement-race",
          settlementStatus: "settled",
        });
      } finally {
        holder.release();
      }
      const { rows: draws } = await poolA.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM credit_draws WHERE credit_id = $1",
        [creditId]
      );
      expect(draws[0].n).toBe("0");
    });
  });
});

/** Resolve once some backend is blocked on a lock `holderPid` is holding. */
async function waitForBlockedOn(pool: pg.Pool, holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid]
    );
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("no backend ever blocked on the credit row lock");
}
