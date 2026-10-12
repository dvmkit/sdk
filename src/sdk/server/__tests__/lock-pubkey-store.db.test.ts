import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  initLockPubkeyTable,
  loadLockPubkeyState,
  pruneRetired,
  rotateLockPubkey,
  seedLockPubkeyState,
} from "../lock-pubkey-store";
import { initWalletAccumulatorTable } from "../wallet-accumulator-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const pubkeyA = "02" + "ab".repeat(32);
const pubkeyB = "03" + "cd".repeat(32);
const pubkeyC = "02" + "ef".repeat(32);
const graceSeconds = 24 * 60 * 60;
const graceMs = graceSeconds * 1000;

let legacyRowSeq = 0;
async function insertLegacyAccumulatorRow(
  pool: pg.Pool,
  dvmId: string,
  lockPubkey: string
): Promise<void> {
  legacyRowSeq++;
  await pool.query(
    `INSERT INTO wallet_accumulator
       (id, dvm_id, lock_pubkey, mint_url, proof_keyset_id, proof_secret, proof_c,
        proof_amount, locked_to_pubkey, request_id, received_at, proof_secret_hash)
     VALUES ($1, $2, $3, 'https://mint.example.com', 'keyset-1', $4, 'C', 1, $3,
             'req-legacy', 1000, $5)`,
    [
      `legacy-row-${legacyRowSeq}`,
      dvmId,
      lockPubkey,
      `secret-legacy-${legacyRowSeq}`,
      `hash-legacy-${legacyRowSeq}`,
    ]
  );
}

(RUN ? describe : describe.skip)("dvm_lock_pubkeys (real Postgres)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await initLockPubkeyTable(pool);
    await initWalletAccumulatorTable(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE dvm_lock_pubkeys");
    await pool.query("TRUNCATE TABLE wallet_accumulator");
  });

  it("seed inserts the current pubkey; reseeding with a different pubkey is a no-op", async () => {
    const dvmId = "test-seed";
    await seedLockPubkeyState(pool, dvmId, pubkeyA);
    let state = await loadLockPubkeyState(pool, dvmId, graceMs);
    expect(state.current).toBe(pubkeyA);
    expect(state.retired).toEqual([]);

    await seedLockPubkeyState(pool, dvmId, pubkeyB);
    state = await loadLockPubkeyState(pool, dvmId, graceMs);
    expect(state.current).toBe(pubkeyA);
  });

  it("rotateLockPubkey demotes the prior current to retired and sets a new current", async () => {
    const dvmId = "test-rotate";
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);
    const post = await rotateLockPubkey(pool, dvmId, pubkeyB, graceMs, 2_000);
    expect(post.current).toBe(pubkeyB);
    expect(post.retired).toHaveLength(1);
    expect(post.retired[0].pubkey).toBe(pubkeyA);
    expect(post.retired[0].retiredAtMs).toBe(2_000);

    const post2 = await rotateLockPubkey(pool, dvmId, pubkeyC, graceMs, 3_000);
    expect(post2.current).toBe(pubkeyC);
    expect(post2.retired.map((r) => r.pubkey).sort()).toEqual([pubkeyA, pubkeyB].sort());
  });

  it("loadLockPubkeyState filters retired entries past the grace window", async () => {
    const dvmId = "test-grace-filter";
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);
    await rotateLockPubkey(pool, dvmId, pubkeyB, graceMs, 2_000);

    const withinGrace = await loadLockPubkeyState(pool, dvmId, graceMs, 2_000 + 60 * 60 * 1000);
    expect(withinGrace.retired).toHaveLength(1);

    const pastGrace = await loadLockPubkeyState(pool, dvmId, graceMs, 2_000 + 25 * 60 * 60 * 1000);
    expect(pastGrace.retired).toEqual([]);
    expect(pastGrace.current).toBe(pubkeyB);
  });

  it("pruneRetired deletes only retired rows past the grace window", async () => {
    const dvmId = "test-prune";
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);
    await rotateLockPubkey(pool, dvmId, pubkeyB, graceMs, 2_000);
    await rotateLockPubkey(pool, dvmId, pubkeyC, graceMs, 25 * 60 * 60 * 1000 + 2_000);

    const deleted = await pruneRetired(pool, dvmId, graceMs, 25 * 60 * 60 * 1000 + 10_000);
    expect(deleted).toBe(1);

    const state = await loadLockPubkeyState(pool, dvmId, graceMs, 25 * 60 * 60 * 1000 + 10_000);
    expect(state.current).toBe(pubkeyC);
    expect(state.retired.map((r) => r.pubkey)).toEqual([pubkeyB]);
  });

  it("rotateLockPubkey to the same pubkey is a no-op", async () => {
    const dvmId = "test-noop";
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);
    const post = await rotateLockPubkey(pool, dvmId, pubkeyA, graceMs, 2_000);
    expect(post.current).toBe(pubkeyA);
    expect(post.retired).toEqual([]);
  });

  it("rotateLockPubkey throws when no current pubkey exists", async () => {
    await expect(rotateLockPubkey(pool, "unseeded", pubkeyB, graceMs, 1_000)).rejects.toThrow(
      /no current pubkey exists/
    );
  });

  it("seedLockPubkeyState backfills legacy wallet_accumulator pubkeys as retired_at_ms=0 sentinels", async () => {
    const dvmId = "test-legacy-backfill";
    const legacyA = "02" + "11".repeat(32);
    const legacyB = "03" + "22".repeat(32);
    await insertLegacyAccumulatorRow(pool, dvmId, legacyA);
    await insertLegacyAccumulatorRow(pool, dvmId, legacyB);

    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);

    const { rows } = await pool.query<{ pubkey: string; retired_at_ms: number | string | null }>(
      `SELECT pubkey, retired_at_ms FROM dvm_lock_pubkeys WHERE dvm_id = $1 ORDER BY pubkey`,
      [dvmId]
    );
    expect(rows).toHaveLength(3);
    const sentinels = rows.filter((r) => r.retired_at_ms != null && Number(r.retired_at_ms) === 0);
    expect(sentinels.map((s) => s.pubkey).sort()).toEqual([legacyA, legacyB].sort());
  });

  it("loadLockPubkeyState returns retired_at_ms=0 sentinels regardless of grace window", async () => {
    const dvmId = "test-sentinel-survives-grace";
    const legacy = "02" + "33".repeat(32);
    await insertLegacyAccumulatorRow(pool, dvmId, legacy);
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);

    const state = await loadLockPubkeyState(pool, dvmId, graceMs, 10_000_000_000_000);
    expect(state.current).toBe(pubkeyA);
    expect(state.retired).toEqual([{ pubkey: legacy, retiredAtMs: 0 }]);
  });

  it("pruneRetired preserves retired_at_ms=0 sentinels", async () => {
    const dvmId = "test-sentinel-survives-prune";
    const legacy = "02" + "44".repeat(32);
    await insertLegacyAccumulatorRow(pool, dvmId, legacy);
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);

    const deleted = await pruneRetired(pool, dvmId, graceMs, 10_000_000_000_000);
    expect(deleted).toBe(0);
    const state = await loadLockPubkeyState(pool, dvmId, graceMs, 10_000_000_000_000);
    expect(state.retired.map((r) => r.pubkey)).toEqual([legacy]);
  });

  it("partial unique index allows multiple retired rows but only one current per DVM", async () => {
    const dvmId = "test-unique";
    await seedLockPubkeyState(pool, dvmId, pubkeyA, 1_000);
    const retired = await pool.query(
      `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
       VALUES ($1, $2, 2000, 1000), ($1, $3, 3000, 1000)`,
      [dvmId, pubkeyB, pubkeyC]
    );
    expect(retired.rowCount).toBe(2);
    await expect(pool.query(
      `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
       VALUES ($1, $2, NULL, 1000)`,
      [dvmId, pubkeyB]
    )).rejects.toMatchObject({ code: "23505", constraint: "dvm_lock_pubkeys_current_uidx" });
    const otherDvm = await pool.query(
      `INSERT INTO dvm_lock_pubkeys (dvm_id, pubkey, retired_at_ms, created_at_ms)
       VALUES ($1, $2, NULL, 1000)`,
      ["another-dvm", pubkeyB]
    );
    expect(otherDvm.rowCount).toBe(1);
  });
});
