import type { Pool } from "pg";

/**
 * A durable note of every card charge this DVM attempts, written before Stripe is called.
 *
 * A charge that succeeds at Stripe but is never booked (the process dies before the ledger
 * commits, and the caller does not resend within the challenge's five minutes) leaves the
 * card charged with no credit behind it. Stripe tags the PaymentIntent with the challenge id
 * (`metadata.mpp_challenge_id`), but nothing in that metadata says which DVM charged it, and
 * several DVMs can share one Stripe account. This journal is what scopes recovery to this
 * DVM: the card-refund sweep looks up only the challenges recorded here.
 */
export interface CardChargeJournal {
  record(challengeId: string): Promise<void>;
  /** Unresolved attempts recorded at or before `olderThanMs`, oldest first. */
  listUnresolved(args: { olderThanMs: number; limit: number }): Promise<CardChargeAttempt[]>;
  resolve(challengeId: string, outcome: string): Promise<void>;
}

export interface CardChargeAttempt {
  challengeId: string;
  createdAt: number;
}

export async function createPostgresCardChargeJournal(
  pool: Pool,
  opts: { now?: () => number } = {}
): Promise<CardChargeJournal> {
  const now = opts.now ?? Date.now;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS card_charge_attempts (
      challenge_id TEXT PRIMARY KEY,
      created_at   BIGINT NOT NULL,
      resolved_at  BIGINT,
      outcome      TEXT
    )
  `);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_card_charge_attempts_open
       ON card_charge_attempts(created_at) WHERE resolved_at IS NULL`
  );
  return {
    async record(challengeId) {
      await pool.query(
        `INSERT INTO card_charge_attempts (challenge_id, created_at) VALUES ($1, $2)
         ON CONFLICT (challenge_id) DO NOTHING`,
        [challengeId, now()]
      );
    },
    async listUnresolved({ olderThanMs, limit }) {
      const { rows } = await pool.query<{ challenge_id: string; created_at: string }>(
        `SELECT challenge_id, created_at FROM card_charge_attempts
          WHERE resolved_at IS NULL AND created_at <= $1
          ORDER BY created_at LIMIT $2`,
        [olderThanMs, limit]
      );
      return rows.map((row) => ({ challengeId: row.challenge_id, createdAt: Number(row.created_at) }));
    },
    async resolve(challengeId, outcome) {
      await pool.query(
        `UPDATE card_charge_attempts SET resolved_at = $2, outcome = $3
          WHERE challenge_id = $1 AND resolved_at IS NULL`,
        [challengeId, now(), outcome]
      );
    },
  };
}
