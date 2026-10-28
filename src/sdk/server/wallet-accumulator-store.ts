import { createHash, randomUUID } from "node:crypto";

import { Amount, type ProofLike, type SerializedDLEQ } from "@cashu/cashu-ts";
import type { Pool } from "pg";

import { type LockPubkey, toLockPubkey } from "../../lib/cashu/lock-pubkey";
import { withSdkInitLock } from "./init-lock";

/**
 * Hex sha256 of a NUT-00 `Proof.secret`. Stored as `proof_secret_hash` on
 * every accumulator row so `UNIQUE(dvm_id, proof_secret_hash)` can close the
 * same-DVM-same-proof-different-request-id replay class.
 */
export function hashProofSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export interface WalletAccumulatorRow {
  id: string;
  dvmId: string;
  /** Lowercase by store invariant — stored via `toLockPubkey` at write time. */
  lockPubkey: LockPubkey;
  mintUrl: string;
  proofKeysetId: string;
  proofSecret: string;
  proofC: string;
  proofAmount: number;
  /** Mint-issued DLEQ evidence, including the proof's blinding factor when present. */
  proofDleq: SerializedDLEQ | null;
  /** Lowercase by store invariant. */
  lockedToPubkey: LockPubkey;
  requestId: string;
  receivedAt: number;
  meltedAt: number | null;
  meltStatus: "melted" | "failed" | "drained" | null;
  /**
   * Mint-issued melt-quote id recorded by the admin `mark-melted` endpoint
   * alongside the payment preimage after an external payout completes. Null
   * until payout audit data is recorded, including on pending rows and legacy
   * rows created before the column existed.
   */
  meltQuoteId: string | null;
  /** NUT-11 locktime at acceptance, in epoch ms; null without a tag.
   * Drives oldest-first ordering and expiring-soon monitoring. */
  tExpire: number | null;
}

/**
 * Sentinel error thrown when an insert collides on the accumulator's replay
 * constraints — either `(dvm_id, request_id, proof_secret)` (same-call replay)
 * or `(dvm_id, proof_secret_hash)` (same-proof under a fresh request_id).
 * Both surface as a single `replay_rejected` to the receive caller.
 */
export class AccumulatorReplayError extends Error {
  constructor(
    public readonly dvmId: string,
    public readonly requestId: string
  ) {
    super(
      `replay: (dvm_id=${dvmId}, request_id=${requestId}) collides on ` +
        `(dvm_id, request_id, proof_secret) or (dvm_id, proof_secret_hash)`
    );
    this.name = "AccumulatorReplayError";
  }
}

/**
 * Subset of `pg.Pool` the store uses for queries. `Pool` and `PoolClient`
 * both satisfy this — important so the accumulator monitor can run reads on a
 * single client that holds the advisory lock.
 */
export interface AccumulatorQuerier {
  query: Pool["query"];
}

/** Pool-shaped handle (`query` + `connect`). Required for the transactional insert path. */
export type AccumulatorPool = Pick<Pool, "query" | "connect">;

/**
 * Create the `wallet_accumulator` table if it doesn't exist. Call once at SDK boot.
 *
 * `lock_pubkey` is stored lowercase by store invariant — every write path
 * brands the value via `toLockPubkey` from `lib/cashu/lock-pubkey` before INSERT.
 * Reads brand back into `LockPubkey` so in-memory comparisons stay
 * structural. `dvm_lock_pubkeys.pubkey` follows the same invariant.
 */
export async function initWalletAccumulatorTable(db: AccumulatorPool): Promise<void> {
  await withSdkInitLock(db, () => createWalletAccumulatorTable(db));
}

async function createWalletAccumulatorTable(db: AccumulatorPool): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wallet_accumulator (
      id                 TEXT PRIMARY KEY,
      dvm_id             TEXT NOT NULL,
      lock_pubkey        TEXT NOT NULL,
      mint_url           TEXT NOT NULL,
      proof_keyset_id    TEXT NOT NULL,
      proof_secret       TEXT NOT NULL,
      proof_c            TEXT NOT NULL,
      proof_amount       INTEGER NOT NULL,
      proof_dleq         JSONB,
      locked_to_pubkey   TEXT NOT NULL,
      request_id         TEXT NOT NULL,
      received_at        BIGINT NOT NULL,
      melted_at          BIGINT,
      melt_status        TEXT,
      melt_quote_id      TEXT,
      CONSTRAINT wallet_accumulator_dvm_request_secret_unique UNIQUE (dvm_id, request_id, proof_secret)
    );
  `);
  await db.query(`ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS melt_quote_id TEXT;`);
  // optional so accumulator rows accepted before this migration and
  // proofs from non-DLEQ mints remain readable.
  await db.query(`ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS proof_dleq JSONB;`);
  await db.query(`ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS payment_preimage TEXT;`);
  await db.query(`ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS t_expire BIGINT;`);
  await db.query(`
    DO $$ BEGIN
      ALTER TABLE wallet_accumulator RENAME COLUMN recovery_pubkey TO lock_pubkey;
    EXCEPTION WHEN undefined_column THEN NULL;
    END $$;
  `);
  await db.query(`DROP INDEX IF EXISTS idx_wallet_accumulator_melt_group;`);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_wallet_accumulator_melt_group
       ON wallet_accumulator(lock_pubkey, mint_url, melted_at);`
  );

  // proof_secret_hash + UNIQUE(dvm_id, proof_secret_hash) closes
  // same-DVM-same-proof-different-request-id replay. Apply in
  // concurrent-safe order: nullable add → backfill → unique index → NOT NULL.
  await db.query(`ALTER TABLE wallet_accumulator ADD COLUMN IF NOT EXISTS proof_secret_hash TEXT;`);
  await backfillProofSecretHash(db);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS wallet_accumulator_dvm_proof_secret_hash_uidx
       ON wallet_accumulator(dvm_id, proof_secret_hash);`
  );
  await db.query(`ALTER TABLE wallet_accumulator ALTER COLUMN proof_secret_hash SET NOT NULL;`);
  // Drop the now-redundant single-column lookup index — every read paths
  // through `(dvm_id, proof_secret_hash)` instead. Safe under IF EXISTS.
  await db.query(`DROP INDEX IF EXISTS idx_wallet_accumulator_proof_secret;`);
  // Column was always stored as '' (no client ever sent a value); safe to drop in place.
  await db.query(`ALTER TABLE wallet_accumulator DROP COLUMN IF EXISTS spend_authorization;`);
}

async function backfillProofSecretHash(db: AccumulatorPool): Promise<void> {
  const { rows } = await db.query<{ id: string; proof_secret: string }>(
    `SELECT id, proof_secret FROM wallet_accumulator WHERE proof_secret_hash IS NULL`
  );
  for (const r of rows) {
    await db.query(`UPDATE wallet_accumulator SET proof_secret_hash = $2 WHERE id = $1`, [
      r.id,
      hashProofSecret(r.proof_secret),
    ]);
  }
}

/**
 * Persist all proofs from a single accepted P2PK token as accumulator rows.
 *
 * With no `tx`, uses its own transaction — one INSERT per proof; on
 * `unique_violation` the whole insert is rolled back and
 * `AccumulatorReplayError` is thrown.
 *
 * With `tx` (a client inside a caller-owned `BEGIN`), issues **no**
 * transaction control: the inserts join the caller's transaction so the rail
 * commit and the `CreditLedger.fund` + `draw` land atomically (spec
 * §2 condition 3). A `unique_violation` still surfaces as
 * `AccumulatorReplayError`, but the caller owns the ROLLBACK — note the
 * transaction is poisoned after the violation (Postgres aborts it), so the
 * caller must not issue further statements before rolling back.
 */
export async function insertAccumulatorRows(
  db: AccumulatorPool,
  args: {
    dvmId: string;
    /**
     * Per-proof matched lock pubkey, parallel to `proofs`. Recording the
     * matched value per row lets the monitor surface retired-batch alerts
     * and lets `dvmctl melt-pending`'s rotation walker pick the
     * right privkey per batch. Branded `LockPubkey` so the lowercase invariant
     * is enforced at the type boundary, not by every call site.
     */
    lockPubkeyByIndex: LockPubkey[];
    mintUrl: string;
    proofs: ProofLike[];
    requestId: string;
    /**
     * NUT-11 locktime (ms since epoch) per proof, parallel to `proofs`. Null
     * for entries whose proof has no `locktime` tag. Omit entirely for legacy
     * callers — every entry is treated as null.
     */
    tExpireMsByIndex?: (number | null)[];
    receivedAt?: number;
    /** External transaction handle — caller owns BEGIN/COMMIT/ROLLBACK. */
    tx?: AccumulatorQuerier;
  }
): Promise<WalletAccumulatorRow[]> {
  if (args.proofs.length === 0) return [];
  if (args.lockPubkeyByIndex.length !== args.proofs.length) {
    throw new Error(
      `insertAccumulatorRows: lockPubkeyByIndex.length (${args.lockPubkeyByIndex.length}) ` +
        `must match proofs.length (${args.proofs.length})`
    );
  }

  if (args.tx) {
    return insertRows(args.tx, args);
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const inserted = await insertRows(client, args);
    await client.query("COMMIT");
    return inserted;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // already rolled back or connection dead
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Claim `requestId` at `dvmId` for the proof set about to be inserted on `tx`.
 * A request id belongs to the first proof set banked under it, so this throws
 * {@link AccumulatorReplayError} when any row already carries it. The
 * transaction-scoped advisory lock serialises concurrent first claims, so two
 * different proof sets cannot both bank under one request id. Run it inside
 * the insert's transaction, before the insert.
 */
export async function claimAccumulatorRequestId(
  tx: AccumulatorQuerier,
  dvmId: string,
  requestId: string
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify(["wallet_accumulator_request", dvmId, requestId]),
  ]);
  const { rows } = await tx.query(
    `SELECT 1 FROM wallet_accumulator WHERE dvm_id = $1 AND request_id = $2 LIMIT 1`,
    [dvmId, requestId]
  );
  if (rows.length > 0) throw new AccumulatorReplayError(dvmId, requestId);
}

/**
 * The request id each of these proof secrets was accepted under at `dvmId`,
 * index-aligned with `secrets`; `undefined` where a secret is not banked, i.e.
 * where {@link insertAccumulatorRows} would not collide on
 * `UNIQUE(dvm_id, proof_secret_hash)`.
 */
export async function acceptedRequestIds(
  db: AccumulatorQuerier,
  dvmId: string,
  secrets: string[]
): Promise<(string | undefined)[]> {
  if (secrets.length === 0) return [];
  const hashes = secrets.map(hashProofSecret);
  const { rows } = await db.query<{ proof_secret_hash: string; request_id: string }>(
    `SELECT proof_secret_hash, request_id FROM wallet_accumulator
      WHERE dvm_id = $1 AND proof_secret_hash = ANY($2::text[])`,
    [dvmId, hashes]
  );
  const byHash = new Map(rows.map((row) => [row.proof_secret_hash, row.request_id]));
  return hashes.map((hash) => byHash.get(hash));
}

/**
 * Group of accumulator rows for a single `(lock_pubkey, mint_url,
 * melt_quote_id)` batch. `oldestReceivedAt` and `totalSats` summarize the
 * batch's age and face value for monitoring and administrative callers.
 * `meltQuoteId` is null for pending batches before payout audit data has been
 * recorded, or for legacy rows with no quote id.
 */
export interface AccumulatorBatch {
  /** Lowercase by store invariant. */
  lockPubkey: LockPubkey;
  mintUrl: string;
  rowIds: string[];
  proofs: { id: string; secret: string; C: string; amount: number; dleq?: SerializedDLEQ }[];
  totalSats: number;
  oldestReceivedAt: number;
  meltQuoteId: string | null;
  /**
   * Minimum `t_expire` (ms since epoch) across the batch's rows; null if every
   * row in the batch lacks a NUT-11 locktime tag. Drives the
   * oldest-first sort surfaced to operators by the admin `pending-batches`
   * endpoint.
   */
  oldestTExpire: number | null;
}

/**
 * Return all unmelted accumulator batches for a DVM, grouped by
 * `(lock_pubkey, mint_url, melt_quote_id)`. Rows with a non-null `melt_status`
 * are excluded.
 */
export async function listPendingBatches(
  db: AccumulatorQuerier,
  dvmId: string
): Promise<AccumulatorBatch[]> {
  // ORDER BY t_expire ASC NULLS LAST surfaces the soonest-to-expire batch
  // first; legacy/unlocked rows fall to the end. The composite tail keeps
  // grouping deterministic across rows that share a t_expire — the first row
  // encountered for a (lock_pubkey, mint_url, melt_quote_id) group sets its
  // insertion order.
  const { rows } = await db.query<BatchRow>(
    `SELECT id, lock_pubkey, mint_url, proof_keyset_id, proof_secret, proof_c, proof_amount, proof_dleq, received_at, melt_quote_id, t_expire
       FROM wallet_accumulator
       WHERE dvm_id = $1 AND melted_at IS NULL AND melt_status IS NULL
       ORDER BY t_expire ASC NULLS LAST, lock_pubkey, mint_url, received_at ASC`,
    [dvmId]
  );
  return groupRowsIntoBatches(rows);
}

/**
 * Per-row tuple returned by `fetchRowsForMelt` — enough to reconstruct a
 * `ProofLike` for NUT-7 checkstate and to inspect the current `melt_status`
 * before transitioning. The admin `mark-melted` endpoint reads this to gate
 * the state transition.
 */
export interface MeltCandidateRow {
  id: string;
  mintUrl: string;
  proofKeysetId: string;
  proofSecret: string;
  proofC: string;
  proofAmount: number;
  meltStatus: "melted" | "failed" | "drained" | null;
}

/**
 * Load the proof tuples for a set of accumulator row ids scoped to `dvmId`.
 * Used by the admin `mark-melted` endpoint to (a) verify ownership (rows
 * belonging to another DVM are silently absent), (b) gate transitions on the
 * current `melt_status`, (c) hand proof tuples to NUT-7 checkstate.
 *
 * Rows missing from the result either don't exist or belong to another DVM —
 * the caller surfaces both as `rows_not_found`.
 */
export async function fetchRowsForMelt(
  db: AccumulatorQuerier,
  dvmId: string,
  rowIds: string[]
): Promise<MeltCandidateRow[]> {
  if (rowIds.length === 0) return [];
  const { rows } = await db.query<{
    id: string;
    mint_url: string;
    proof_keyset_id: string;
    proof_secret: string;
    proof_c: string;
    proof_amount: number | string;
    melt_status: "melted" | "failed" | "drained" | null;
  }>(
    `SELECT id, mint_url, proof_keyset_id, proof_secret, proof_c, proof_amount, melt_status
       FROM wallet_accumulator
       WHERE dvm_id = $1 AND id = ANY($2::text[])`,
    [dvmId, rowIds]
  );
  return rows.map((r) => ({
    id: r.id,
    mintUrl: r.mint_url,
    proofKeysetId: r.proof_keyset_id,
    proofSecret: r.proof_secret,
    proofC: r.proof_c,
    proofAmount: Number(r.proof_amount),
    meltStatus: r.melt_status,
  }));
}

/**
 * Persist the audit fields captured by the admin `mark-melted` endpoint —
 * `melt_quote_id` (mint-issued quote that paid the bolt11) and
 * `payment_preimage` (LN payment proof). Called immediately before
 * `markRowsMelted` so a crash between them leaves an audit trail without
 * advancing state.
 */
export async function recordMeltAudit(
  db: AccumulatorQuerier,
  rowIds: string[],
  audit: { meltQuoteId: string; paymentPreimage: string }
): Promise<void> {
  if (rowIds.length === 0) return;
  await db.query(
    `UPDATE wallet_accumulator
       SET melt_quote_id = $2, payment_preimage = $3
       WHERE id = ANY($1::text[])`,
    [rowIds, audit.meltQuoteId, audit.paymentPreimage]
  );
}

/** Reset failed or legacy melting rows for retry. Absent rowIds selects every
 * eligible row for this DVM; an empty array is a no-op. Melted rows stay intact. */
export async function resetFailedRows(
  db: AccumulatorQuerier,
  dvmId: string,
  rowIds?: string[]
): Promise<number> {
  if (rowIds?.length === 0) return 0;
  const { rowCount } = rowIds
    ? await db.query(
        `UPDATE wallet_accumulator
           SET melt_status = NULL
           WHERE dvm_id = $1
             AND id = ANY($2::text[])
             AND melt_status IN ('failed', 'melting')`,
        [dvmId, rowIds]
      )
    : await db.query(
        `UPDATE wallet_accumulator
           SET melt_status = NULL
           WHERE dvm_id = $1
             AND melt_status IN ('failed', 'melting')`,
        [dvmId]
      );
  return rowCount ?? 0;
}

/** Mark payout rows melted and stamp `melted_at`. */
export async function markRowsMelted(
  db: AccumulatorQuerier,
  rowIds: string[],
  meltedAt: number = Date.now()
): Promise<void> {
  if (rowIds.length === 0) return;
  await db.query(
    `UPDATE wallet_accumulator
       SET melt_status = 'melted', melted_at = $2
       WHERE id = ANY($1::text[])`,
    [rowIds, meltedAt]
  );
}

/**
 * Terminal transition for rows consumed by a credit-drain swap:
 * their proofs were spent at the mint to mint the caller-locked refund notes
 * (change re-enters as fresh rows in the same transaction). `melt_status`
 * `'drained'` keeps the audit distinguishable from a payout melt, and the
 * drain id lands in `melt_quote_id` so the row points back at the
 * `credit_drains` liability it funded.
 */
export async function markRowsDrained(
  db: AccumulatorQuerier,
  rowIds: string[],
  drainId: string,
  drainedAt: number = Date.now()
): Promise<void> {
  if (rowIds.length === 0) return;
  await db.query(
    `UPDATE wallet_accumulator
       SET melt_status = 'drained', melted_at = $2, melt_quote_id = $3
       WHERE id = ANY($1::text[])`,
    [rowIds, drainedAt, `drain:${drainId}`]
  );
}

/** Delete every accumulator row for a DVM. */
export async function clearAccumulatorForDvm(
  db: AccumulatorQuerier,
  dvmId: string
): Promise<number> {
  const { rowCount } = await db.query(`DELETE FROM wallet_accumulator WHERE dvm_id = $1`, [dvmId]);
  return rowCount ?? 0;
}

/**
 * Hash a string into a 64-bit integer suitable for `pg_advisory_lock`. Cheap
 * non-cryptographic hash — collisions across DVMs are tolerable (worst case
 * one ticker waits a tick) and avoiding `pgcrypto` keeps the migration
 * footprint minimal.
 */
export function hashLockKey(input: string): bigint {
  let h = 1469598103934665603n; // FNV-1a 64-bit offset basis
  const prime = 1099511628211n;
  const mask = (1n << 64n) - 1n;
  for (let i = 0; i < input.length; i++) {
    h = (h ^ BigInt(input.charCodeAt(i))) & mask;
    h = (h * prime) & mask;
  }
  // Fold to int8 range. Postgres advisory keys take a signed 64-bit int.
  if (h >= 1n << 63n) h -= 1n << 64n;
  return h;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

/** One INSERT per proof on `q`; maps `unique_violation` to `AccumulatorReplayError`. */
async function insertRows(
  q: AccumulatorQuerier,
  args: {
    dvmId: string;
    lockPubkeyByIndex: LockPubkey[];
    mintUrl: string;
    proofs: ProofLike[];
    requestId: string;
    tExpireMsByIndex?: (number | null)[];
    receivedAt?: number;
  }
): Promise<WalletAccumulatorRow[]> {
  const receivedAt = args.receivedAt ?? Date.now();
  const inserted: WalletAccumulatorRow[] = [];
  for (let i = 0; i < args.proofs.length; i++) {
    const proof = args.proofs[i];
    const lockPubkey = args.lockPubkeyByIndex[i];
    const row: WalletAccumulatorRow = {
      id: randomUUID(),
      dvmId: args.dvmId,
      lockPubkey,
      mintUrl: args.mintUrl,
      proofKeysetId: proof.id,
      proofSecret: proof.secret,
      proofC: proof.C,
      proofAmount: Amount.from(proof.amount).toNumber(),
      proofDleq: proof.dleq ? { ...proof.dleq } : null,
      lockedToPubkey: lockPubkey,
      requestId: args.requestId,
      receivedAt,
      meltedAt: null,
      meltStatus: null,
      meltQuoteId: null,
      tExpire: args.tExpireMsByIndex?.[i] ?? null,
    };
    try {
      await q.query(
        `INSERT INTO wallet_accumulator
           (id, dvm_id, lock_pubkey, mint_url, proof_keyset_id, proof_secret,
            proof_c, proof_amount, proof_dleq, locked_to_pubkey, request_id,
            received_at, proof_secret_hash, t_expire)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          row.id,
          row.dvmId,
          row.lockPubkey,
          row.mintUrl,
          row.proofKeysetId,
          row.proofSecret,
          row.proofC,
          row.proofAmount,
          row.proofDleq,
          row.lockedToPubkey,
          row.requestId,
          row.receivedAt,
          hashProofSecret(row.proofSecret),
          row.tExpire,
        ]
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AccumulatorReplayError(args.dvmId, args.requestId);
      }
      throw err;
    }
    inserted.push(row);
  }
  return inserted;
}

interface BatchRow {
  id: string;
  lock_pubkey: string;
  mint_url: string;
  proof_keyset_id: string;
  proof_secret: string;
  proof_c: string;
  proof_amount: number | string;
  proof_dleq: SerializedDLEQ | null;
  received_at: number | string;
  melt_quote_id: string | null;
  t_expire: number | string | null;
}

function groupRowsIntoBatches(rows: BatchRow[]): AccumulatorBatch[] {
  const groups = new Map<string, AccumulatorBatch>();
  for (const r of rows) {
    // Keep quote ids in the grouping key so separate payout audit records on
    // the same lock pubkey and mint remain separate pending batches.
    // JSON.stringify avoids any chance of separator collision if a mint_url
    // ever contains a literal pipe.
    const key = JSON.stringify([r.lock_pubkey, r.mint_url, r.melt_quote_id ?? null]);
    const rowTExpire = r.t_expire == null ? null : Number(r.t_expire);
    let batch = groups.get(key);
    if (!batch) {
      batch = {
        lockPubkey: toLockPubkey(r.lock_pubkey),
        mintUrl: r.mint_url,
        rowIds: [],
        proofs: [],
        totalSats: 0,
        oldestReceivedAt: Number(r.received_at),
        meltQuoteId: r.melt_quote_id ?? null,
        oldestTExpire: rowTExpire,
      };
      groups.set(key, batch);
    }
    batch.rowIds.push(r.id);
    batch.proofs.push({
      id: r.proof_keyset_id,
      secret: r.proof_secret,
      C: r.proof_c,
      amount: Number(r.proof_amount),
      ...(r.proof_dleq ? { dleq: { ...r.proof_dleq } } : {}),
    });
    batch.totalSats += Number(r.proof_amount);
    batch.oldestReceivedAt = Math.min(batch.oldestReceivedAt, Number(r.received_at));
    if (rowTExpire != null) {
      batch.oldestTExpire =
        batch.oldestTExpire == null ? rowTExpire : Math.min(batch.oldestTExpire, rowTExpire);
    }
  }
  return [...groups.values()];
}
