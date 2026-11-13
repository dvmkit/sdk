import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type { CreditLedgerQuerier } from "./credit-ledger";
import { withSdkInitLock } from "./init-lock";

// Booking and its ledger/outbox writes share a transaction. Refunding is committed before
// Stripe is called, so a crash after the refund cannot let a later poll book the charge.
export type StripeCheckoutState = "creating" | "open" | "booked" | "expired" | "refunding" | "refunded";

export interface StripeCheckoutRecord {
  storeNamespace: string;
  dvmId: string;
  leaseToken?: string;
  leaseUntil?: number;
  nextRecoveryAt?: number;
  terminalReason?: "dispute_lost";
  fundId: string;
  creditId: string;
  callerPubkey: string;
  amountMicro: number;
  createdAt: number;
  expiresAt: number;
  successUrl: string;
  productName: string;
  state: StripeCheckoutState;
  sessionId?: string;
}

export interface LockedStripeCheckout {
  record: StripeCheckoutRecord;
  tx: CreditLedgerQuerier;
  transition(from: StripeCheckoutState, to: StripeCheckoutState, sessionId?: string, patch?: Partial<Pick<StripeCheckoutRecord, "leaseToken" | "leaseUntil" | "nextRecoveryAt" | "terminalReason">>): Promise<void>;
}

export interface StripeCheckoutStore {
  readonly durable: true;
  readonly namespace: string;
  /** Commits the attempt before any Stripe request. An existing fund id is never replaced. */
  create(record: StripeCheckoutRecord): Promise<void>;
  get(fundId: string): Promise<StripeCheckoutRecord | undefined>;
  /** Short, nonwaiting lock. Never call Stripe in this callback; join ledger writes to tx. */
  withRecord<T>(fundId: string, run: (locked: LockedStripeCheckout) => Promise<T>): Promise<T>;
  listRecoverable(nowMs: number, limit: number): Promise<string[]>;
}

export async function createPostgresStripeCheckoutStore(pool: Pool): Promise<StripeCheckoutStore> {
  let namespace!: string;
  await withSdkInitLock(pool, async () => {
    await pool.query(`CREATE TABLE IF NOT EXISTS stripe_checkout_store_identity (
      singleton BOOLEAN PRIMARY KEY CHECK (singleton), namespace TEXT NOT NULL
    )`);
    await pool.query(`INSERT INTO stripe_checkout_store_identity VALUES (TRUE,$1) ON CONFLICT DO NOTHING`, [randomUUID()]);
    namespace = (await pool.query<{ namespace: string }>("SELECT namespace FROM stripe_checkout_store_identity WHERE singleton=TRUE")).rows[0]!.namespace;
    await pool.query(`CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
      fund_id TEXT PRIMARY KEY,
      record JSONB NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('creating','open','booked','expired','refunding','refunded')),
      expires_at BIGINT NOT NULL
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_stripe_checkout_recovery
      ON stripe_checkout_sessions(expires_at) WHERE state IN ('creating','open','refunding')`);
  });
  return {
    durable: true,
    namespace,
    async create(record) {
      await pool.query(`INSERT INTO stripe_checkout_sessions (fund_id, record, state, expires_at)
        VALUES ($1,$2::jsonb,$3,$4) ON CONFLICT (fund_id) DO NOTHING`,
      [record.fundId, JSON.stringify(record), record.state, record.expiresAt]);
    },
    async get(fundId) {
      const { rows } = await pool.query<{ record: StripeCheckoutRecord }>(
        "SELECT record FROM stripe_checkout_sessions WHERE fund_id=$1", [fundId]
      );
      return rows[0]?.record;
    },
    async withRecord(fundId, run) {
      const tx = await pool.connect();
      try {
        await tx.query("BEGIN");
        const { rows } = await tx.query<{ record: StripeCheckoutRecord }>(
          "SELECT record FROM stripe_checkout_sessions WHERE fund_id=$1 FOR UPDATE NOWAIT", [fundId]
        );
        const record = rows[0]?.record;
        if (!record) throw new Error("Checkout session record is missing");
        const value = await run({
          record,
          tx,
          async transition(from, to, sessionId, patch) {
            const next = { ...record, ...patch, state: to, ...(sessionId && { sessionId }) };
            const updated = await tx.query(`UPDATE stripe_checkout_sessions SET state=$3, record=$4::jsonb
              WHERE fund_id=$1 AND state=$2`, [fundId, from, to, JSON.stringify(next)]);
            if (updated.rowCount !== 1) throw new Error("Checkout state transition lost its claim");
            Object.assign(record, next);
          },
        });
        await tx.query("COMMIT");
        return value;
      } catch (err) {
        await tx.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        tx.release();
      }
    },
    async listRecoverable(nowMs, limit) {
      const { rows } = await pool.query<{ fund_id: string }>(`SELECT fund_id FROM stripe_checkout_sessions
        WHERE state IN ('creating','open','refunding')
          AND (expires_at <= $1 OR (state='creating' AND expires_at-1800000 <= $1))
          AND COALESCE((record->>'nextRecoveryAt')::bigint,0) <= $1
        ORDER BY COALESCE((record->>'nextRecoveryAt')::bigint,expires_at), expires_at LIMIT $2`, [nowMs, limit]);
      return rows.map((row) => row.fund_id);
    },
  };
}
