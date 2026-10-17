import { describe, expect, it, vi } from "vitest";

import type { CreditLedgerQuerier } from "../credit-ledger";
import { readPendingImplicitDraws } from "../pending-implicit-draws";

function database(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string) => ({ rows }));
  return { query, db: { query } as unknown as CreditLedgerQuerier };
}

describe("pending implicit draw summary", () => {
  it("returns an empty summary using one SELECT and no transaction or initialization", async () => {
    const { db, query } = database([]);
    expect(await readPendingImplicitDraws({ db })).toEqual({
      drawCount: 0, oldestDrawAt: null, byRailCurrency: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0];
    expect(sql.trim()).toMatch(/^SELECT\b/i);
    expect(sql).not.toMatch(/\b(BEGIN|COMMIT|INSERT|UPDATE|DELETE|CREATE|ALTER|CALL)\b|;/i);
  });

  it("converts database integers, totals counts, and finds the oldest draw without returning identifiers", async () => {
    const { db } = database([
      { rail: "cashu", currency: "usd", draw_count: "2", amount_micro: "400000",
        oldest_draw_at: "1700000000200", caller_pubkey: "secret-caller" },
      { rail: null, currency: "eur", draw_count: "1", amount_micro: "9007199254740991",
        oldest_draw_at: "1700000000100", credit_id: "secret-credit" },
    ]);
    expect(await readPendingImplicitDraws({ db })).toEqual({
      drawCount: 3,
      oldestDrawAt: 1700000000100,
      byRailCurrency: [
        { rail: "cashu", currency: "usd", drawCount: 2, amountMicro: 400000,
          oldestDrawAt: 1700000000200 },
        { rail: null, currency: "eur", drawCount: 1, amountMicro: 9007199254740991,
          oldestDrawAt: 1700000000100 },
      ],
    });
  });

  it.each(["draw_count", "amount_micro", "oldest_draw_at"])("rejects an unsafe %s", async (field) => {
    const { db } = database([{
      rail: "cashu", currency: "usd", draw_count: "1", amount_micro: "10",
      oldest_draw_at: "1700000000000", [field]: "9007199254740993",
    }]);
    await expect(readPendingImplicitDraws({ db })).rejects.toThrow(RangeError);
  });

  it("rejects a combined draw count outside the safe integer range", async () => {
    const { db } = database(["cashu", "x402"].map((rail) => ({
      rail, currency: "usd", draw_count: "4503599627370496", amount_micro: "10",
      oldest_draw_at: "1700000000000",
    })));
    await expect(readPendingImplicitDraws({ db })).rejects.toThrow(RangeError);
  });

  it("propagates database failures instead of reporting zero held money", async () => {
    const { db, query } = database([]);
    query.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(readPendingImplicitDraws({ db })).rejects.toThrow("database unavailable");
  });
});
