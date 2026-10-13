import { AsyncLocalStorage } from "node:async_hooks";

import type { Pool, PoolClient } from "pg";

/**
 * Pool-shaped handle the lock needs — `connect`, since the lock and the unlock
 * must ride one pinned client, plus `pg`'s resolved config when it's there (a
 * hand-rolled pool shape won't have it) so the size check below can run.
 * Declared here rather than reusing `AccumulatorPool` so the stores can depend
 * on this module without an import cycle; every SDK pool type (`Pool`,
 * `AccumulatorPool`, `CreditLedgerPool`) structurally satisfies it.
 */
export type InitLockPool = Pick<Pool, "connect"> & {
  readonly options?: { readonly max?: number };
};

/**
 * All SDK boot DDL shares one advisory-lock key. CREATE TABLE IF NOT EXISTS
 * can still race in Postgres system catalogs across machines. Reusing one key
 * also prevents inconsistent lock acquisition order between SDK stores.
 */
export const SDK_INIT_ADVISORY_LOCK = 17320927;

/**
 * Overlapping callers on one pool share a pinned session lock and run their
 * guarded work in order. A nested call from the active callback is reentrant.
 * The last caller unlocks, preserving protection against other pools/processes.
 * DDL runs on another connection; pools smaller than two are rejected.
 * The pinned client is released in finally, including guarded failures.
 */
export async function withSdkInitLock<T>(db: InitLockPool, fn: () => Promise<T>): Promise<T> {
  const context = activeInits.getStore();
  if (context?.get(db)?.active) return fn();
  assertPoolFitsLock(db);
  let holder = holders.get(db);
  if (holder) {
    holder.refs += 1;
  } else {
    holder = { refs: 1, acquired: acquire(db), tail: Promise.resolve() };
    holders.set(db, holder);
  }
  const predecessor = holder.tail;
  let finishTurn!: () => void;
  holder.tail = new Promise<void>((resolve) => { finishTurn = resolve; });
  let guardedFailed = false;
  try {
    await holder.acquired;
    await predecessor;
    const token = { active: true };
    const nextContext = new Map(context);
    nextContext.set(db, token);
    try {
      return await activeInits.run(nextContext, fn);
    } finally {
      token.active = false;
    }
  } catch (err) {
    guardedFailed = true;
    throw err;
  } finally {
    // A failed unlock must not mask the caller's own error — the DDL failure is
    // what an operator needs to see, and the release path destroys the client
    // either way, which drops the session's advisory locks with the connection.
    try {
      await releaseHolder(db, holder, guardedFailed);
    } finally {
      finishTurn();
    }
  }
}

interface Holder {
  refs: number;
  acquired: Promise<PoolClient>;
  tail: Promise<void>;
}

/**
 * Weak pool keys do not retain discarded pools. Sharing applies only to the
 * same pool identity.
 */
const holders = new WeakMap<object, Holder>();
const activeInits = new AsyncLocalStorage<Map<InitLockPool, { active: boolean }>>();

function assertPoolFitsLock(db: InitLockPool): void {
  const max = db.options?.max;
  if (max === undefined || max >= 2) return;
  throw new Error(
    `withSdkInitLock: the SDK boot lock needs a pool that allows at least 2 connections (got max=${max}). ` +
      `The lock is held on one pinned client while the guarded DDL runs on another, so boot would hang forever.`
  );
}

async function acquire(db: InitLockPool): Promise<PoolClient> {
  const client = await db.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(${SDK_INIT_ADVISORY_LOCK})`);
  } catch (err) {
    client.release();
    throw err;
  }
  return client;
}

async function releaseHolder(
  db: InitLockPool,
  holder: Holder,
  guardedFailed: boolean
): Promise<void> {
  holder.refs -= 1;
  if (holder.refs > 0) return;
  holders.delete(db);
  let client: PoolClient;
  try {
    client = await holder.acquired;
  } catch {
    // Acquisition failed — nothing to unlock, and the original error already
    // propagates out of the caller's `await holder.acquired`.
    return;
  }
  try {
    await client.query(`SELECT pg_advisory_unlock(${SDK_INIT_ADVISORY_LOCK})`);
    client.release();
  } catch (err) {
    // Never hand a session that may still hold the lock back to the pool —
    // `release(err)` destroys the connection instead, and Postgres drops a
    // session's advisory locks when it disconnects. A plain `release()` here
    // would wedge every later acquisition on this database forever.
    client.release(err instanceof Error ? err : new Error(String(err)));
    if (!guardedFailed) throw err;
  }
}
