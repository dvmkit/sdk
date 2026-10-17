import type { CreditLedgerQuerier } from "./credit-ledger";

export interface PendingImplicitDrawGroup {
  /** Null when historical funding has no recorded rail. */
  rail: string | null;
  currency: string;
  drawCount: number;
  /** Held amount in integer millionths of this group's currency. */
  amountMicro: number;
  /** Oldest pending draw's creation time, in epoch milliseconds. */
  oldestDrawAt: number;
}

export interface PendingImplicitDrawSummary {
  drawCount: number;
  /** Null when no implicit draws remain pending. */
  oldestDrawAt: number | null;
  byRailCurrency: PendingImplicitDrawGroup[];
}

interface AggregateRow {
  rail: string | null;
  currency: string;
  draw_count: string;
  amount_micro: string;
  oldest_draw_at: string;
}

/**
 * Read database-wide pending holds on implicit credits using a single SELECT. The supplied
 * database must already have the SDK credit schema; this function never initializes it or
 * starts a server. Database access supplies administrative authorization.
 *
 * Includes unfinished jobs and holds without a job record, regardless of stop reason. These
 * funds remain held until settlement or release; this is not a total of payable refunds or
 * all caller balances. No caller identifiers are returned. Unsafe integer totals throw.
 */
export async function readPendingImplicitDraws({
  db,
}: {
  db: CreditLedgerQuerier;
}): Promise<PendingImplicitDrawSummary> {
  const { rows } = await db.query<AggregateRow>(`
    SELECT c.rail, c.currency, COUNT(*)::text AS draw_count,
           SUM(d.amount_micro)::text AS amount_micro,
           MIN(d.created_at)::text AS oldest_draw_at
      FROM credit_draws d
      JOIN credits c ON c.credit_id = d.credit_id
     WHERE d.status = 'pending' AND d.credit_id LIKE 'imp:%'
     GROUP BY c.rail, c.currency
     ORDER BY c.rail NULLS LAST, c.currency
  `);
  const byRailCurrency = rows.map((row) => ({
    rail: row.rail,
    currency: row.currency,
    drawCount: safeInteger(row.draw_count),
    amountMicro: safeInteger(row.amount_micro),
    oldestDrawAt: safeInteger(row.oldest_draw_at),
  }));
  let count = 0n;
  let oldestDrawAt: number | null = null;
  for (const group of byRailCurrency) {
    count += BigInt(group.drawCount);
    oldestDrawAt = oldestDrawAt === null
      ? group.oldestDrawAt : Math.min(oldestDrawAt, group.oldestDrawAt);
  }
  return { drawCount: safeInteger(count.toString()), oldestDrawAt, byRailCurrency };
}

function safeInteger(value: string): number {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) {
    throw new RangeError("pending implicit draws: aggregate outside nonnegative safe integer range");
  }
  return number;
}
