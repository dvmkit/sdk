import { AsyncLocalStorage } from "node:async_hooks";

import type { Store } from "mppx";
import type { Pool, PoolClient } from "pg";

import { withPostgresTransactionRecovery } from "../../lib/pg-retry";
import type { CreditLedgerQuerier } from "./credit-ledger";
import { withSdkInitLock } from "./init-lock";
import { HostingCleanupFence, type HostedFundingReservation } from "./hosting-cleanup-fence";
import { parseStoreValue, stringifyStoreValue } from "./store-json";

/** One durable Tempo session-channel row exposed to reconciliation workers. */
export interface TempoSessionRow {
  key: string;
  state: Record<string, unknown>;
  updatedAt: number;
}

/** Cursor for stable pagination over active Tempo session channels. */
export interface TempoSessionCursor {
  updatedAt: number;
  key: string;
}

/** Durable state joining a credit drain to its cooperative channel close. */
export interface TempoSessionCloseRecord {
  channelId: string;
  drainId: string;
  reference: string | null;
}

/** Decision one close-refund forecast asks the durable intent gate to apply. */
export type TempoSessionCloseForecastDecision = "proceed" | "release";

/** Cross-replica outcome of resolving a close intent's refund forecast. */
export type TempoSessionCloseForecastResolution<value> =
  | { outcome: "proceed" }
  | { outcome: "released"; value: value }
  | { outcome: "missing" };

/** The voucher increment observed while holding the channel row lock. */
export interface TempoVoucherDelta {
  key: string;
  cumulativeAmount: bigint;
  priorCumulativeAmount: bigint;
  delta: bigint;
}

/** Result of a ledger resolution composed with terminal channel consumption. */
export interface TempoSessionConsumption<value> {
  value: value;
  amount: bigint;
  consume: boolean;
}

/** Channel lifecycle fields exposed while its row lock is held. */
export interface TempoSessionLifecycle {
  finalized: boolean;
  closeRequestedAt: bigint;
  spent: bigint;
  settledOnChain: bigint;
  highestVoucherAmount: bigint;
}

/**
 * Postgres implementation of mppx's atomic channel store.
 *
 * Every mutation takes an advisory transaction lock keyed by the channel
 * before locking its row with `FOR UPDATE`, applies mppx's synchronous
 * transition and commits before returning. Transaction recovery may retry a callback
 * attempt; a rolled-back attempt is not a second committed transition. The advisory lock
 * covers a channel's first write, when there is no row for `FOR UPDATE` to
 * lock. Together these are the cross-machine linearization point for voucher,
 * top-up, spend, and close state; mppx's process-local fallback is
 * intentionally never used in a durable SDK host.
 *
 * Lock order remains channel before credit: mutation paths take the advisory
 * lock and then the row lock, while terminal consumption requires an existing
 * row and starts there. Both own the channel lock before the ledger takes its
 * parent-credit lock through the same client.
 *
 * {@link withVoucherAcceptance} acquires its pooled client **lazily**, on the
 * first store mutation rather than up front. Its `operation` is
 * mppx's credential verification, which does the chain work before it touches
 * the store: an `open` submits the escrow transaction and awaits its receipt,
 * a `voucher` reads channel state over public RPC. Holding a connection across
 * that starves everything else on the shared host pool — `/v1/job`, the job
 * store, KV, the credit ledger, the replay store — and exposes the open
 * transaction to `idle_in_transaction_session_timeout`. This is the same shape
 * removed from the x402 settlement path. Laziness costs nothing in
 * atomicity: the `FOR UPDATE` row lock was always taken at the first mutation,
 * never at `BEGIN`, so the critical section is unchanged — only the
 * connection-holding window shrinks to the database work it actually covers.
 */
export class PostgresTempoSessionStore implements Store.AtomicStore {
  private hostingCleanupFence?: HostingCleanupFence;

  useHostingCleanupFence(fence: HostingCleanupFence): void {
    this.hostingCleanupFence = fence;
  }
  private readonly acceptance = new AsyncLocalStorage<AcceptanceContext>();

  constructor(private readonly pool: Pool) {
    // mppx's ChannelStore adapter captures `store.update` as a standalone
    // function, so the AtomicStore boundary must not depend on method-call
    // receiver binding.
    this.update = this.update.bind(this);
  }

  async init(): Promise<void> {
    await withSdkInitLock(this.pool, async () => {
      const before = await this.pool.query<{ existed: boolean }>(
        "SELECT to_regclass('mpp_tempo_channels') IS NOT NULL AS existed"
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mpp_tempo_channels (
          channel_key TEXT PRIMARY KEY,
          state_json  TEXT NOT NULL,
          updated_at  BIGINT NOT NULL
        )
      `);
      await this.pool.query(
        `CREATE INDEX IF NOT EXISTS idx_mpp_tempo_channels_updated
           ON mpp_tempo_channels(updated_at)`
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mpp_tempo_channel_tombstones (
          channel_key TEXT PRIMARY KEY,
          state_json TEXT NOT NULL,
          deleted_at_ms BIGINT NOT NULL
        )
      `);
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mpp_tempo_channel_history (
          singleton BOOLEAN PRIMARY KEY CHECK (singleton),
          complete BOOLEAN NOT NULL
        )
      `);
      await this.pool.query(
        `INSERT INTO mpp_tempo_channel_history (singleton,complete) VALUES (TRUE,$1)
         ON CONFLICT (singleton) DO NOTHING`, [!before.rows[0].existed]
      );
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS mpp_tempo_close_intents (
          channel_id      TEXT PRIMARY KEY,
          drain_id        TEXT NOT NULL,
          reference       TEXT,
          forecast_pending BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at      BIGINT NOT NULL
        )
      `);
      // Existing in-flight intents predate the forecast gate and may already
      // have broadcast. Default them to ready; only new reservations opt into
      // the pending state explicitly, so rollout can never release old value.
      await this.pool.query(
        `ALTER TABLE mpp_tempo_close_intents
           ADD COLUMN IF NOT EXISTS forecast_pending BOOLEAN NOT NULL DEFAULT FALSE`
      );
      // Recovery state for a close whose own result was lost: where a paused
      // search for its transaction resumes, and the on-chain settled amount the
      // close started from (what its settlement callback reports against).
      await this.pool.query(
        `ALTER TABLE mpp_tempo_close_intents
           ADD COLUMN IF NOT EXISTS close_search_before BIGINT,
           ADD COLUMN IF NOT EXISTS settled_before_close NUMERIC(78,0)`
      );
    });
  }

  async get(key: string): Promise<unknown> {
    // Reuse the acceptance transaction's client once it exists, so a read is
    // never a second checkout from the pool that already holds it — a client
    // acquiring from its own pool is the self-deadlock. Before the
    // first mutation there is no client to reuse, and this deliberately does
    // not force one: mppx reads the channel ahead of its chain call, and
    // acquiring here would pull that call back inside the transaction.
    const client = this.acceptance.getStore()?.client;
    const { rows } = await (client ?? this.pool).query<{ state_json: string }>(
      `SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1`,
      [key]
    );
    return rows[0] ? parseStoreValue(rows[0].state_json) : null;
  }

  /** Replace one channel snapshot. Used by mppx only for non-RMW maintenance. */
  async put(key: string, value: unknown): Promise<void> {
    await this.update(key, () => ({ op: "set", value, result: undefined }));
  }

  async delete(key: string): Promise<void> {
    await this.update(key, () => ({ op: "delete", result: undefined }));
  }

  /** Atomic read-modify-write using a row lock shared by every SDK replica. */
  async update<result>(
    key: string,
    fn: (current: unknown) => Store.Change<unknown, result>
  ): Promise<result> {
    const acceptance = this.acceptance.getStore();
    if (acceptance) {
      const client = await this.acceptanceClient(acceptance);
      return this.updateInTransaction(client, key, fn, acceptance);
    }

    return this.transaction("tempo_session.update", (client) =>
      this.updateInTransaction(client, key, fn)
    );
  }

  /** Compose voucher acceptance and its ledger mutation under the channel-row lock. */
  async withVoucherAcceptance<value, result>(
    voucher: { channelId: string; cumulativeAmount: bigint; hostingFunding?: HostedFundingReservation },
    commit: (tx: PoolClient, voucher: TempoVoucherDelta) => Promise<result>,
    operation: () => Promise<value>
  ): Promise<{ value: value; result: result | undefined }> {
    if (this.hostingCleanupFence) {
      if (!voucher.hostingFunding) throw new Error("Hosted Tempo voucher has no original funding admission");
      const reservation = voucher.hostingFunding;
      await this.hostingCleanupFence.withNewIntent({
        admissionId: reservation.admissionId,
        creditId: reservation.creditId,
        fundId: reservation.fundId,
        callerPubkey: reservation.callerPubkey,
        fundingCommitment: reservation.commitment,
      }, (tx) => this.hostingCleanupFence!.assertFundingReservation(tx, reservation));
    }
    const context: AcceptanceContext = {
      commit,
      channelId: voucher.channelId.toLowerCase(),
      cumulativeAmount: voucher.cumulativeAmount,
    };
    try {
      const value = await this.acceptance.run(context, operation);
      await context.client?.query("COMMIT");
      return { value, result: context.result as result | undefined };
    } catch (error) {
      await context.client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      // Drop the handle *before* releasing it. `get()` resolves its client off
      // this context, so anything still running inside it would otherwise
      // interleave queries on a connection the pool has already handed to
      // someone else. Release through the pending promise rather than the
      // resolved field, so a checkout still in flight is returned too.
      const pending = context.pendingClient;
      context.client = undefined;
      context.pendingClient = undefined;
      (await pending?.catch(() => undefined))?.release();
    }
  }

  /**
   * Check out the acceptance transaction's client, opening it on first demand.
   *
   * An operation that never mutates the store therefore never takes a
   * connection and never opens an empty transaction — the caller sees the same
   * `result: undefined` it saw before, because nothing committed either way.
   *
   * The in-flight checkout is memoized, not just its result: mppx awaits each
   * store call today, but two concurrent first mutations would otherwise open
   * two transactions and leak the one nobody keeps a handle to.
   */
  private acceptanceClient(acceptance: AcceptanceContext): Promise<PoolClient> {
    acceptance.pendingClient ??= (async () => {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
      } catch (error) {
        client.release();
        throw error;
      }
      acceptance.client = client;
      return client;
    })();
    return acceptance.pendingClient;
  }

  /** Serialize a credit draw with the channel lifecycle that authorizes it. */
  async withDrawPlacement<value>(
    channelId: string,
    operation: (tx: CreditLedgerQuerier, lifecycle: TempoSessionLifecycle) => Promise<value>,
    tx?: CreditLedgerQuerier
  ): Promise<value> {
    if (tx) return this.withLockedLifecycle(tx, channelId, operation);

    return this.transaction("tempo_session.draw_placement", (client) =>
      this.withLockedLifecycle(client, channelId, operation)
    );
  }

  private async withLockedLifecycle<value>(
    client: CreditLedgerQuerier,
    channelId: string,
    operation: (tx: CreditLedgerQuerier, lifecycle: TempoSessionLifecycle) => Promise<value>
  ): Promise<value> {
    const key = channelId.toLowerCase();
    const { rows } = await client.query<{ state_json: string }>(
      `SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1 FOR UPDATE`,
      [key]
    );
    if (!rows[0]) throw new Error(`Tempo session channel ${key} not found`);
    const current = parseStoreValue(rows[0].state_json);
    if (!isRecord(current)) throw new Error(`Tempo session channel ${key} has invalid state`);
    return operation(client, lifecycleFromState(current));
  }

  /**
   * Compose a terminal ledger resolution with the channel's consumed value.
   *
   * Voucher acceptance records spending authority; only a successful job
   * consumes it. Holding the channel row while the callback locks and settles
   * the credit keeps that distinction atomic across machines and preserves the
   * shared channel -> credit lock order.
   */
  async withTerminalConsumption<value>(
    channelId: string,
    operation: (
      tx: PoolClient,
      lifecycle: TempoSessionLifecycle
    ) => Promise<TempoSessionConsumption<value>>
  ): Promise<value> {
    const key = channelId.toLowerCase();
    return this.transaction("tempo_session.terminal_consumption", async (client) => {
      const { rows } = await client.query<{ state_json: string }>(
        `SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1 FOR UPDATE`,
        [key]
      );
      if (!rows[0]) throw new Error(`Tempo session channel ${key} not found`);
      const current = parseStoreValue(rows[0].state_json);
      if (!isRecord(current)) throw new Error(`Tempo session channel ${key} has invalid state`);

      const lifecycle = lifecycleFromState(current);
      const resolved = await operation(client, lifecycle);
      if (resolved.consume) {
        if (lifecycle.finalized || lifecycle.closeRequestedAt !== 0n) {
          throw new Error("Tempo session channel is closing or finalized");
        }
        if (resolved.amount < 0n) throw new Error("Tempo session consumption cannot be negative");
        const spent = lifecycle.spent;
        const highestVoucherAmount = asBigInt(current.highestVoucherAmount);
        if (highestVoucherAmount === undefined || spent + resolved.amount > highestVoucherAmount) {
          throw new Error(`Tempo session consumption exceeds accepted voucher authority`);
        }
        const next = {
          ...current,
          spent: spent + resolved.amount,
          units: Number(current.units ?? 0) + 1,
        };
        assertMonotonicTransition(current, next);
        await client.query(
          `UPDATE mpp_tempo_channels SET state_json = $2, updated_at = $3
            WHERE channel_key = $1`,
          [key, stringifyStoreValue(next, "Tempo session state"), Date.now()]
        );
      }
      return resolved.value;
    });
  }

  /** Retire lost backing while holding the channel row ahead of every credit lock. */
  async withFinalizedCreditLoss<value>(
    channelId: string,
    operation: (tx: PoolClient, lifecycle: TempoSessionLifecycle) => Promise<value>
  ): Promise<value> {
    const key = channelId.toLowerCase();
    return this.transaction("tempo_session.finalized_credit_loss", async (client) => {
      const { rows } = await client.query<{ state_json: string }>(
        `SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1 FOR UPDATE`,
        [key]
      );
      if (!rows[0]) throw new Error(`Tempo session channel ${key} not found`);
      const current = parseStoreValue(rows[0].state_json);
      if (!isRecord(current)) throw new Error(`Tempo session channel ${key} has invalid state`);
      return operation(client, lifecycleFromState(current));
    });
  }

  /** Page active channel snapshots for the close/settlement watcher. */
  async listActive(limit = 100, cursor?: TempoSessionCursor): Promise<TempoSessionRow[]> {
    const { rows } = await this.pool.query<{
      channel_key: string;
      state_json: string;
      updated_at: string;
    }>(
      `SELECT channel_key, state_json, updated_at
        FROM mpp_tempo_channels
        WHERE (state_json::jsonb ->> 'finalized') IS DISTINCT FROM 'true'
          AND ($2::BIGINT IS NULL OR (updated_at, channel_key) > ($2, $3))
        ORDER BY updated_at, channel_key
        LIMIT $1`,
      [limit, cursor?.updatedAt ?? null, cursor?.key ?? null]
    );
    return rows.map((row) => ({
      key: row.channel_key,
      state: parseStoreValue(row.state_json) as Record<string, unknown>,
      updatedAt: Number(row.updated_at),
    }));
  }

  /** Persist a drain's close intent before its credential is broadcast. */
  async beginClose(channelId: string, drainId: string): Promise<TempoSessionCloseRecord> {
    return this.runCloseIntentTransaction(channelId, drainId, async (tx, record) => {
      const { rows } = await tx.query<{ pending: boolean; forecast_pending: boolean | null }>(
        `SELECT EXISTS (
           SELECT 1
             FROM credit_drains d
             JOIN credits c ON c.credit_id = d.credit_id
            WHERE c.tempo_channel_id = $1
              AND d.drain_id = $2
              AND d.status = 'pending'
         ) AS pending,
         (SELECT forecast_pending
            FROM mpp_tempo_close_intents
           WHERE channel_id = $1 AND drain_id = $2) AS forecast_pending`,
        [channelId.toLowerCase(), drainId]
      );
      if (!rows[0]?.pending) {
        throw new Error(`Tempo session drain ${drainId} is no longer pending`);
      }
      if (rows[0].forecast_pending !== false) {
        throw new Error(`Tempo session drain ${drainId} refund forecast is still pending`);
      }
      const channel = await tx.query<{ state_json: string }>(
        "SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1",
        [channelId.toLowerCase()]
      );
      const state = channel.rows[0] ? parseStoreValue(channel.rows[0].state_json) : null;
      const settled = (state as { settledOnChain?: unknown } | null)?.settledOnChain;
      await tx.query(
        `UPDATE mpp_tempo_close_intents SET settled_before_close = $3
          WHERE channel_id = $1 AND drain_id = $2`,
        [channelId.toLowerCase(), drainId, typeof settled === "bigint" ? settled.toString() : null]
      );
      return record;
    });
  }

  /** Reserve a close intent and run its ledger debit in the same transaction. */
  async withCloseIntent<value>(
    channelId: string,
    drainId: string,
    operation: (tx: PoolClient) => Promise<value>
  ): Promise<value> {
    return this.runCloseIntentTransaction(channelId, drainId, operation);
  }

  /**
   * Resolve a reserved close's forecast under the intent row lock.
   *
   * `proceed` opens the broadcast gate. `release` deletes the intent and runs
   * the ledger restore in the same transaction, but only while the gate is
   * still pending. A concurrent proceed wins by returning `proceed` to the
   * releaser, which must not restore value that may already be broadcasting.
   */
  async resolveCloseForecast<value>(
    channelId: string,
    drainId: string,
    decision: TempoSessionCloseForecastDecision,
    operation?: (tx: PoolClient) => Promise<value>
  ): Promise<TempoSessionCloseForecastResolution<value>> {
    return this.transaction("tempo_session.resolve_close_forecast", async (client) => {
      const { rows } = await client.query<{ forecast_pending: boolean }>(
        `SELECT forecast_pending
           FROM mpp_tempo_close_intents
          WHERE channel_id = $1 AND drain_id = $2
          FOR UPDATE`,
        [channelId.toLowerCase(), drainId]
      );
      if (!rows[0]) {
        return { outcome: "missing" };
      }
      if (!rows[0].forecast_pending) {
        return { outcome: "proceed" };
      }
      if (decision === "proceed") {
        await client.query(
          `UPDATE mpp_tempo_close_intents
              SET forecast_pending = FALSE, updated_at = $3
            WHERE channel_id = $1 AND drain_id = $2`,
          [channelId.toLowerCase(), drainId, Date.now()]
        );
        return { outcome: "proceed" };
      }
      if (!operation) {
        throw new Error("A Tempo close forecast release requires a ledger operation");
      }
      await client.query(
        `DELETE FROM mpp_tempo_close_intents
          WHERE channel_id = $1 AND drain_id = $2`,
        [channelId.toLowerCase(), drainId]
      );
      const value = await operation(client);
      return { outcome: "released", value };
    });
  }

  /** Delete a matching close intent and release its ledger debit atomically. */
  async releaseCloseIntent<value>(
    channelId: string,
    drainId: string,
    operation: (tx: PoolClient) => Promise<value>
  ): Promise<value> {
    return this.transaction("tempo_session.release_close_intent", async (client) => {
      await client.query(
        `DELETE FROM mpp_tempo_close_intents
          WHERE channel_id = $1 AND drain_id = $2`,
        [channelId.toLowerCase(), drainId]
      );
      return operation(client);
    });
  }

  /** Read a persisted cooperative-close intent or confirmed result. */
  async getClose(channelId: string): Promise<TempoSessionCloseRecord | null> {
    const { rows } = await this.pool.query<{
      channel_id: string;
      drain_id: string;
      reference: string | null;
    }>(
      `SELECT channel_id, drain_id, reference
         FROM mpp_tempo_close_intents
        WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    );
    return rows[0] ? closeRecord(rows[0]) : null;
  }

  /** Persist proof that a cooperative close reached terminal chain state. */
  async confirmClose(
    channelId: string,
    drainId: string,
    reference: string
  ): Promise<TempoSessionCloseRecord> {
    const { rows } = await this.pool.query<{
      channel_id: string;
      drain_id: string;
      reference: string | null;
    }>(
      `UPDATE mpp_tempo_close_intents
          SET reference = COALESCE(reference, $3), updated_at = $4
        WHERE channel_id = $1 AND drain_id = $2 AND forecast_pending = FALSE
        RETURNING channel_id, drain_id, reference`,
      [channelId.toLowerCase(), drainId, reference, Date.now()]
    );
    if (!rows[0]) throw new Error(`Tempo session close intent not found`);
    return closeRecord(rows[0]);
  }

  /** Set a close's reference only if none is set, reporting whether this call set it. */
  async claimCloseReference(
    channelId: string,
    drainId: string,
    reference: string
  ): Promise<{ reference: string | null; claimed: boolean }> {
    const { rows } = await this.pool.query<{ reference: string | null }>(
      `UPDATE mpp_tempo_close_intents
          SET reference = $3, updated_at = $4
        WHERE channel_id = $1 AND drain_id = $2 AND forecast_pending = FALSE
          AND reference IS NULL
        RETURNING reference`,
      [channelId.toLowerCase(), drainId, reference, Date.now()]
    );
    if (rows[0]) return { reference: rows[0].reference, claimed: true };
    const current = await this.getClose(channelId);
    if (current?.drainId !== drainId || current.reference === null) {
      throw new Error(`Tempo session close intent not found`);
    }
    return { reference: current.reference, claimed: false };
  }

  async getCloseRecovery(channelId: string): Promise<{
    updatedAtMs: number;
    searchBefore: bigint | null;
    settledBeforeClose: bigint | null;
  } | null> {
    const { rows } = await this.pool.query<{
      updated_at: string;
      close_search_before: string | null;
      settled_before_close: string | null;
    }>(
      `SELECT updated_at, close_search_before, settled_before_close
         FROM mpp_tempo_close_intents
        WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      updatedAtMs: Number(row.updated_at),
      searchBefore: row.close_search_before === null ? null : BigInt(row.close_search_before),
      settledBeforeClose: row.settled_before_close === null ? null : BigInt(row.settled_before_close),
    };
  }

  /** Record where a paused close search resumes; the cursor only moves back. */
  async recordCloseSearch(channelId: string, drainId: string, resumeAt: bigint): Promise<void> {
    await this.pool.query(
      `UPDATE mpp_tempo_close_intents
          SET close_search_before = LEAST(COALESCE(close_search_before, $3), $3)
        WHERE channel_id = $1 AND drain_id = $2`,
      [channelId.toLowerCase(), drainId, resumeAt.toString()]
    );
  }

  private async runCloseIntentTransaction<value>(
    channelId: string,
    drainId: string,
    operation: (tx: PoolClient, record: TempoSessionCloseRecord) => Promise<value>
  ): Promise<value> {
    return this.transaction("tempo_session.close_intent", async (client) => {
      const record = await this.writeCloseIntent(client, channelId, drainId);
      return operation(client, record);
    });
  }

  private transaction<value>(
    operation: string,
    callback: (client: PoolClient) => Promise<value>
  ): Promise<value> {
    return withPostgresTransactionRecovery(this.pool, "dvm-host", operation, callback);
  }

  private async writeCloseIntent(
    query: Pool | PoolClient,
    channelId: string,
    drainId: string
  ): Promise<TempoSessionCloseRecord> {
    const normalized = channelId.toLowerCase();
    const { rows } = await query.query<{
      channel_id: string;
      drain_id: string;
      reference: string | null;
    }>(
      `INSERT INTO mpp_tempo_close_intents
         (channel_id, drain_id, reference, forecast_pending, updated_at)
       VALUES ($1, $2, NULL, TRUE, $3)
       ON CONFLICT (channel_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
       RETURNING channel_id, drain_id, reference`,
      [normalized, drainId, Date.now()]
    );
    const row = rows[0];
    if (row.drain_id !== drainId) {
      throw new Error(`Tempo session channel ${normalized} is already closing for another drain`);
    }
    return closeRecord(row);
  }

  private async updateInTransaction<result>(
    client: PoolClient,
    key: string,
    fn: (current: unknown) => Store.Change<unknown, result>,
    acceptance?: AcceptanceContext
  ): Promise<result> {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 1762))`, [key]);
    const { rows } = await client.query<{ state_json: string }>(
      `SELECT state_json FROM mpp_tempo_channels WHERE channel_key = $1 FOR UPDATE`,
      [key]
    );
    const current = rows[0] ? parseStoreValue(rows[0].state_json) : null;
    const change = fn(current);
    if (change.op === "set") {
      const cumulativeAmount = acceptanceVoucherAmount(acceptance, key, current, change.value);
      let value = change.value;
      // mppx's session handler accounts the accepted request immediately.
      // For credit-backed jobs that request is funding authority, not consumed
      // service: terminal CreditLedger.settle advances these fields instead.
      // Clamp every mutation in the acceptance transaction because mppx may
      // write the voucher and request accounting as separate store updates.
      if (acceptance?.channelId === key.toLowerCase() && isRecord(current)) {
        value = {
          ...(change.value as Record<string, unknown>),
          spent: asBigInt(current.spent) ?? 0n,
          units: Number(current.units ?? 0),
        };
      }
      assertMonotonicTransition(current, value);
      if (current === null) {
        const prior = await client.query<{ state_json: string }>(
          "SELECT state_json FROM mpp_tempo_channel_tombstones WHERE channel_key=$1 FOR UPDATE", [key]
        );
        if (prior.rows[0]) assertMonotonicTransition(parseStoreValue(prior.rows[0].state_json), value);
      }
      if (!acceptance && this.hostingCleanupFence && (current === null ||
        (asBigInt((value as Record<string, unknown>).highestVoucherAmount) ?? 0n) >
          (isRecord(current) ? asBigInt(current.highestVoucherAmount) ?? 0n : 0n))) {
        await this.hostingCleanupFence.assertNewIntent(client);
      }
      await client.query(
        `INSERT INTO mpp_tempo_channels (channel_key, state_json, updated_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (channel_key) DO UPDATE
           SET state_json = EXCLUDED.state_json, updated_at = EXCLUDED.updated_at`,
        [key, stringifyStoreValue(value, "Tempo session state"), Date.now()]
      );
      // The ledger leg runs *after* the channel row is written, never before
      // `get()` resolves this transaction's own client, so a
      // commit callback reading the store reads what this statement just
      // wrote — but only if the statement has run. On a channel's first
      // voucher there is no earlier row and mppx's `handleOpenCredential`
      // performs exactly one store update, so a callback that ran ahead of the
      // INSERT read `null` and silently reported no chain binding: the channel
      // was never registered with the platform's close observer, and a caller
      // could close on chain and withdraw with every alarm green. Ordering it
      // here costs nothing in atomicity — both statements are the one
      // transaction `withVoucherAcceptance` commits — and it keeps the
      // monotonicity refusal above the ledger work it would have to undo.
      if (acceptance && cumulativeAmount !== undefined && acceptance.result === undefined) {
        const priorCumulativeAmount = isRecord(current)
          ? (asBigInt(current.highestVoucherAmount) ?? 0n)
          : 0n;
        acceptance.result = await acceptance.commit(client, {
          key,
          cumulativeAmount,
          priorCumulativeAmount,
          delta: cumulativeAmount - priorCumulativeAmount,
        });
      }
    } else if (change.op === "delete") {
      if (current !== null) {
        const prior = await client.query<{ state_json: string }>(
          "SELECT state_json FROM mpp_tempo_channel_tombstones WHERE channel_key=$1 FOR UPDATE", [key]
        );
        if (prior.rows[0]) assertMonotonicTransition(parseStoreValue(prior.rows[0].state_json), current);
        await client.query(
          `INSERT INTO mpp_tempo_channel_tombstones (channel_key,state_json,deleted_at_ms)
           VALUES ($1,$2,$3) ON CONFLICT (channel_key) DO UPDATE
             SET state_json=EXCLUDED.state_json,deleted_at_ms=EXCLUDED.deleted_at_ms`,
          [key, rows[0].state_json, Date.now()]
        );
      }
      await client.query(`DELETE FROM mpp_tempo_channels WHERE channel_key = $1`, [key]);
    }
    return change.result;
  }
}

function lifecycleFromState(state: Record<string, unknown>): TempoSessionLifecycle {
  return {
    finalized: state.finalized === true,
    closeRequestedAt: asBigInt(state.closeRequestedAt) ?? 0n,
    spent: asBigInt(state.spent) ?? 0n,
    settledOnChain: asBigInt(state.settledOnChain) ?? 0n,
    highestVoucherAmount: asBigInt(state.highestVoucherAmount) ?? 0n,
  };
}

interface AcceptanceContext {
  /** Undefined until the operation's first store mutation opens the transaction. */
  client?: PoolClient;
  /** The in-flight checkout, so concurrent first mutations share one transaction. */
  pendingClient?: Promise<PoolClient>;
  channelId: string;
  cumulativeAmount: bigint;
  commit: (tx: PoolClient, voucher: TempoVoucherDelta) => Promise<unknown>;
  result?: unknown;
}

function closeRecord(row: {
  channel_id: string;
  drain_id: string;
  reference: string | null;
}): TempoSessionCloseRecord {
  return {
    channelId: row.channel_id,
    drainId: row.drain_id,
    reference: row.reference,
  };
}

/** Refuse a backend or callback that attempts to roll channel authority back. */
export function assertMonotonicTransition(current: unknown, next: unknown): void {
  if (!isRecord(next)) throw new Error("Tempo session state must be an object");
  if (!isRecord(current)) return;
  for (const field of [
    "channelId",
    "chainId",
    "escrowContract",
    "payee",
    "payer",
    "token",
    "authorizedSigner",
    "operator",
  ]) {
    if (current[field] !== undefined && next[field] !== current[field]) {
      throw new Error(`Tempo session immutable field changed: ${field}`);
    }
  }
  for (const field of ["highestVoucherAmount", "settledOnChain", "spent", "deposit"]) {
    const before = asBigInt(current[field]);
    const after = asBigInt(next[field]);
    // Deposit becomes zero at terminal cooperative close; all other fields in
    // this list are monotonic. closeRequestedAt is chain-authoritative and is
    // intentionally checked separately because a reverted close clears it.
    const terminalReset = next.finalized === true && after === 0n && field === "deposit";
    if (before !== undefined && after !== undefined && after < before && !terminalReset) {
      throw new Error(`Tempo session monotonic field decreased: ${field}`);
    }
  }
  const closeRequestedAt = asBigInt(next.closeRequestedAt);
  if (closeRequestedAt !== undefined && closeRequestedAt < 0n) {
    throw new Error("Tempo session closeRequestedAt cannot be negative");
  }
  if (current.finalized === true && next.finalized !== true) {
    throw new Error("Tempo session finalized state cannot be reopened");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function increasedVoucherAmount(current: unknown, next: unknown): bigint | undefined {
  if (!isRecord(next)) return undefined;
  const after = asBigInt(next.highestVoucherAmount);
  const before = isRecord(current) ? (asBigInt(current.highestVoucherAmount) ?? 0n) : 0n;
  return after !== undefined && after > before ? after : undefined;
}

function acceptanceVoucherAmount(
  acceptance: AcceptanceContext | undefined,
  key: string,
  current: unknown,
  next: unknown
): bigint | undefined {
  if (key.toLowerCase() !== acceptance?.channelId) return undefined;
  const increased = increasedVoucherAmount(current, next);
  if (increased !== undefined) return increased;
  const authorized = isRecord(current) ? asBigInt(current.highestVoucherAmount) : undefined;
  return authorized !== undefined && authorized >= acceptance.cumulativeAmount
    ? acceptance.cumulativeAmount
    : undefined;
}
