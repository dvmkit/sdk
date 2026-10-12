import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { toLockPubkey } from "../../../lib/cashu/lock-pubkey";
import { _acquireLockForTest } from "../wallet-accumulator-monitor";
import {
  AccumulatorReplayError,
  clearAccumulatorForDvm,
  fetchRowsForMelt,
  initWalletAccumulatorTable,
  insertAccumulatorRows,
  listPendingBatches,
  markRowsMelted,
  recordMeltAudit,
  resetFailedRows,
} from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const lockPubkey = "02" + "ab".repeat(32);
const mintUrl = "https://mint.example.test";

// Test-only convenience: every proof in these fixtures is locked to the same
// pubkey, so we expand it into the per-index array `insertAccumulatorRows`
// requires. The production receive path (`acceptAccumulatorPayment`) builds
// `lockPubkeyByIndex` per-proof from the matched active pubkey.
async function insertRows(
  pool: pg.Pool,
  args: Omit<Parameters<typeof insertAccumulatorRows>[1], "lockPubkeyByIndex"> & {
    lockPubkey: string;
  }
): Promise<ReturnType<typeof insertAccumulatorRows>> {
  const { lockPubkey: lock, ...rest } = args;
  const branded = toLockPubkey(lock);
  return insertAccumulatorRows(pool, {
    ...rest,
    lockPubkeyByIndex: rest.proofs.map(() => branded),
  });
}

(RUN ? describe : describe.skip)("wallet_accumulator (real Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await initWalletAccumulatorTable(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE wallet_accumulator");
  });

  it("inserts proofs and groups them into batches by (lock_pubkey, mint_url)", async () => {
    const dvmId = "test-dvm-batch";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [
        {
          id: "k1",
          amount: 100,
          secret: "s1",
          C: "C1",
          dleq: { e: "dleq-e", s: "dleq-s", r: "blind-r" },
        } as never,
        { id: "k1", amount: 200, secret: "s2", C: "C2" } as never,
      ],
      requestId: "req-batch-1",
    });

    const batches = await listPendingBatches(pool, dvmId);
    expect(batches).toHaveLength(1);
    expect(batches[0].totalSats).toBe(300);
    expect(batches[0].rowIds).toHaveLength(2);
    expect(batches[0].mintUrl).toBe(mintUrl);
    const proofsBySecret = new Map(batches[0].proofs.map((proof) => [proof.secret, proof]));
    expect(proofsBySecret.get("s1")?.dleq).toEqual({
      e: "dleq-e",
      s: "dleq-s",
      r: "blind-r",
    });
    expect(proofsBySecret.get("s2")?.dleq).toBeUndefined();
  });

  it("rejects a duplicate (dvm_id, request_id, proof_secret) with AccumulatorReplayError", async () => {
    const dvmId = "test-dvm-replay-3tuple";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 100, secret: "s-shared", C: "C1" } as never],
      requestId: "req-replay",
    });
    // Same proof secret submitted under the same request_id — 3-tuple
    // UNIQUE catches it before the proof_secret_hash one.
    await expect(
      insertRows(pool, {
        dvmId,
        lockPubkey,
        mintUrl,
        proofs: [{ id: "k1", amount: 100, secret: "s-shared", C: "C-other" } as never],
        requestId: "req-replay",
      })
    ).rejects.toBeInstanceOf(AccumulatorReplayError);
  });

  it("rejects same proof_secret under a different request_id via UNIQUE(dvm_id, proof_secret_hash)", async () => {
    // This is the meaningful replay class: without the constraint, an agent
    // could swap a previously accumulated
    // proof into a fresh-request_id submission and bypass replay protection.
    const dvmId = "test-dvm-replay-hash";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 100, secret: "s-shared-hash", C: "C1" } as never],
      requestId: "req-A",
    });
    await expect(
      insertRows(pool, {
        dvmId,
        lockPubkey,
        mintUrl,
        proofs: [{ id: "k1", amount: 100, secret: "s-shared-hash", C: "C2" } as never],
        requestId: "req-B",
      })
    ).rejects.toBeInstanceOf(AccumulatorReplayError);
  });

  it("only one of two simultaneous claims wins via pg_try_advisory_lock", async () => {
    const dvmId = "test-dvm-lock";
    const a = await _acquireLockForTest(pool, dvmId);
    expect(a.acquired).toBe(true);

    const b = await _acquireLockForTest(pool, dvmId);
    expect(b.acquired).toBe(false);

    await a.release();
    await b.release();
  });

  it("persists t_expire per row; listPendingBatches sorts oldest-first and surfaces oldestTExpire", async () => {
    const { rows: columns } = await pool.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'wallet_accumulator' AND column_name = 't_expire'`
    );
    expect(columns).toEqual([{ data_type: "bigint" }]);
    const dvmId = "test-dvm-t-expire";
    const lockA = "02" + "aa".repeat(32);
    const lockB = "02" + "bb".repeat(32);
    const lockC = "02" + "cc".repeat(32);
    const earlier = 1_800_000_000_000;
    const later = 1_900_000_000_000;

    // Batch A: two rows, t_expire = {earlier, later} → oldestTExpire = earlier
    await insertRows(pool, {
      dvmId,
      lockPubkey: lockA,
      mintUrl,
      proofs: [
        { id: "k1", amount: 100, secret: "exp-a1", C: "C1" } as never,
        { id: "k1", amount: 200, secret: "exp-a2", C: "C2" } as never,
      ],
      requestId: "exp-req-a",
      tExpireMsByIndex: [later, earlier],
    });
    // Batch B: one row, t_expire between earlier and later → orders after A but before C
    await insertRows(pool, {
      dvmId,
      lockPubkey: lockB,
      mintUrl,
      proofs: [{ id: "k1", amount: 50, secret: "exp-b1", C: "Cb" } as never],
      requestId: "exp-req-b",
      tExpireMsByIndex: [(earlier + later) / 2],
    });
    // Batch C: legacy / no locktime → oldestTExpire null → sorts last (NULLS LAST).
    await insertRows(pool, {
      dvmId,
      lockPubkey: lockC,
      mintUrl,
      proofs: [{ id: "k1", amount: 10, secret: "exp-c1", C: "Cc" } as never],
      requestId: "exp-req-c",
    });

    // Per-row t_expire persisted exactly.
    const { rows: persisted } = await pool.query<{ proof_secret: string; t_expire: string | null }>(
      `SELECT proof_secret, t_expire FROM wallet_accumulator WHERE dvm_id = $1`,
      [dvmId]
    );
    const byProof = new Map(persisted.map((r) => [r.proof_secret, r.t_expire]));
    expect(byProof.get("exp-a1")).toBe(String(later));
    expect(byProof.get("exp-a2")).toBe(String(earlier));
    expect(byProof.get("exp-b1")).toBe(String((earlier + later) / 2));
    expect(byProof.get("exp-c1")).toBeNull();

    // Batches come back oldest-first; null-t_expire group last.
    const batches = await listPendingBatches(pool, dvmId);
    expect(batches.map((b) => b.lockPubkey)).toEqual([lockA, lockB, lockC]);
    expect(batches[0].oldestTExpire).toBe(earlier);
    expect(batches[1].oldestTExpire).toBe((earlier + later) / 2);
    expect(batches[2].oldestTExpire).toBeNull();
  });

  it("fetchRowsForMelt scopes to dvm_id and surfaces melt_status", async () => {
    const dvmA = "test-dvm-fetch-a";
    const dvmB = "test-dvm-fetch-b";
    await insertRows(pool, {
      dvmId: dvmA,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 100, secret: "fetch-s1", C: "C1" } as never],
      requestId: "fetch-req-a",
    });
    await insertRows(pool, {
      dvmId: dvmB,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 200, secret: "fetch-s2", C: "C2" } as never],
      requestId: "fetch-req-b",
    });

    const batchesA = await listPendingBatches(pool, dvmA);
    const batchesB = await listPendingBatches(pool, dvmB);
    const aRowId = batchesA[0].rowIds[0];
    const bRowId = batchesB[0].rowIds[0];

    // Cross-DVM lookup must not return dvmB's row even when its id is supplied.
    const fetched = await fetchRowsForMelt(pool, dvmA, [aRowId, bRowId]);
    expect(fetched).toHaveLength(1);
    expect(fetched[0].id).toBe(aRowId);
    expect(fetched[0].mintUrl).toBe(mintUrl);
    expect(fetched[0].meltStatus).toBeNull();
  });

  it("recordMeltAudit + markRowsMelted transition rows and persist audit fields", async () => {
    const dvmId = "test-dvm-mark-melted";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [
        { id: "k1", amount: 100, secret: "mark-s1", C: "C1" } as never,
        { id: "k1", amount: 200, secret: "mark-s2", C: "C2" } as never,
      ],
      requestId: "mark-req",
    });
    const batches = await listPendingBatches(pool, dvmId);
    const rowIds = batches[0].rowIds;

    await recordMeltAudit(pool, rowIds, {
      meltQuoteId: "quote-final",
      paymentPreimage: "preimage-final",
    });
    await markRowsMelted(pool, rowIds);

    const { rows } = await pool.query<{
      id: string;
      melt_status: string | null;
      melt_quote_id: string | null;
      payment_preimage: string | null;
      melted_at: string | null;
    }>(
      `SELECT id, melt_status, melt_quote_id, payment_preimage, melted_at
         FROM wallet_accumulator WHERE dvm_id = $1`,
      [dvmId]
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.melt_status).toBe("melted");
      expect(r.melt_quote_id).toBe("quote-final");
      expect(r.payment_preimage).toBe("preimage-final");
      expect(r.melted_at).not.toBeNull();
    }

    // After mark-melted the rows must drop out of pending-batches.
    const remaining = await listPendingBatches(pool, dvmId);
    expect(remaining).toHaveLength(0);
  });

  it("resetFailedRows clears melt_status for 'melting' and 'failed' rows scoped to the DVM", async () => {
    const dvmId = "test-dvm-restart-failed";
    const otherDvm = "test-dvm-restart-other";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [
        { id: "k1", amount: 10, secret: "reset-s1", C: "C1" } as never,
        { id: "k1", amount: 20, secret: "reset-s2", C: "C2" } as never,
        { id: "k1", amount: 30, secret: "reset-s3", C: "C3" } as never,
      ],
      requestId: "reset-req",
    });
    await insertRows(pool, {
      dvmId: otherDvm,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 99, secret: "reset-other", C: "Co" } as never],
      requestId: "reset-other-req",
    });

    const batches = await listPendingBatches(pool, dvmId);
    const [meltingRow, failedRow, untouchedRow] = batches[0].rowIds;
    await pool.query(`UPDATE wallet_accumulator SET melt_status = 'melting' WHERE id = $1`, [
      meltingRow,
    ]);
    await pool.query(`UPDATE wallet_accumulator SET melt_status = 'failed' WHERE id = $1`, [
      failedRow,
    ]);
    // Force the otherDvm row into 'melting' to confirm cross-DVM scoping.
    const otherBatches = await listPendingBatches(pool, otherDvm);
    await pool.query(`UPDATE wallet_accumulator SET melt_status = 'melting' WHERE id = $1`, [
      otherBatches[0].rowIds[0],
    ]);

    const restarted = await resetFailedRows(pool, dvmId);
    expect(restarted).toBe(2);

    const { rows } = await pool.query<{ id: string; melt_status: string | null }>(
      `SELECT id, melt_status FROM wallet_accumulator WHERE dvm_id = $1 ORDER BY id`,
      [dvmId]
    );
    const byId = new Map(rows.map((r) => [r.id, r.melt_status]));
    expect(byId.get(meltingRow)).toBeNull();
    expect(byId.get(failedRow)).toBeNull();
    expect(byId.get(untouchedRow)).toBeNull();

    // otherDvm's melting row must still be melting — scope check.
    const { rows: otherRows } = await pool.query<{ melt_status: string | null }>(
      `SELECT melt_status FROM wallet_accumulator WHERE dvm_id = $1`,
      [otherDvm]
    );
    expect(otherRows[0].melt_status).toBe("melting");
  });

  it("resetFailedRows with explicit row_ids only clears those ids", async () => {
    const dvmId = "test-dvm-restart-scoped";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [
        { id: "k1", amount: 10, secret: "scoped-s1", C: "C1" } as never,
        { id: "k1", amount: 20, secret: "scoped-s2", C: "C2" } as never,
      ],
      requestId: "scoped-req",
    });
    const batches = await listPendingBatches(pool, dvmId);
    const [keepRow, resetRow] = batches[0].rowIds;
    await pool.query(`UPDATE wallet_accumulator SET melt_status = 'failed'`);

    const restarted = await resetFailedRows(pool, dvmId, [resetRow]);
    expect(restarted).toBe(1);

    const { rows } = await pool.query<{ id: string; melt_status: string | null }>(
      `SELECT id, melt_status FROM wallet_accumulator WHERE dvm_id = $1`,
      [dvmId]
    );
    const byId = new Map(rows.map((r) => [r.id, r.melt_status]));
    expect(byId.get(keepRow)).toBe("failed");
    expect(byId.get(resetRow)).toBeNull();
  });

  it("clearAccumulatorForDvm removes all rows for a DVM", async () => {
    const dvmId = "test-dvm-clear";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 1, secret: "s-clear", C: "C-clear" } as never],
      requestId: "req-clear",
    });
    const deleted = await clearAccumulatorForDvm(pool, dvmId);
    expect(deleted).toBe(1);
    const batches = await listPendingBatches(pool, dvmId);
    expect(batches).toHaveLength(0);
  });

  it("upgrade-in-place: drops spend_authorization column and preserves existing rows", async () => {
    // Re-add the dead column to simulate a pre-migration schema.
    await pool.query(
      `ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS spend_authorization TEXT NOT NULL DEFAULT ''`
    );
    // Insert a row while the column exists — DEFAULT '' fills it automatically.
    const dvmId = "test-dvm-migrate";
    await insertRows(pool, {
      dvmId,
      lockPubkey,
      mintUrl,
      proofs: [{ id: "k1", amount: 5, secret: "s-migrate", C: "C-migrate" } as never],
      requestId: "req-migrate",
    });
    // Re-running initWalletAccumulatorTable should drop the column idempotently.
    await initWalletAccumulatorTable(pool);
    // Column must be gone.
    const { rows: cols } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'wallet_accumulator' AND column_name = 'spend_authorization'`
    );
    expect(cols).toHaveLength(0);
    // Row must survive intact.
    const batches = await listPendingBatches(pool, dvmId);
    expect(batches).toHaveLength(1);
    expect(batches[0].totalSats).toBe(5);
  });
});
