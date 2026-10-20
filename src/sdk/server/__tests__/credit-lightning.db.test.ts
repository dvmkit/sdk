/*
 * Real Postgres invoice settlement proves row-lock serialization and rollback of funding,
 * credit and invoice status. Reconcile callback assertions cover its invocation; durable
 * reporter rows are exercised by the deposit-outbox integration suite.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { type CreditFundingBasis, CreditLedger, CreditLedgerError } from "../credit-ledger";
import { fundCredit } from "./__helpers__/credit-fixtures";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const CALLER = "cd".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AMOUNT_MICRO = 300_000;
const AMOUNT_MSATS = 300_000;

const LN_BASIS: CreditFundingBasis = { rail: "lightning", paidMsats: AMOUNT_MSATS };

function settleLn(
  ledger: CreditLedger,
  args: { creditId: string; fundId: string; expiryMs: number }
): ReturnType<CreditLedger["settleInvoice"]> {
  return ledger.settleInvoice({ ...args, basis: LN_BASIS });
}

describe.skipIf(!RUN)("Lightning settlement (Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let ledger: CreditLedger;
  let ledgerB: CreditLedger;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(poolA);
    ledgerB = new CreditLedger(poolB);
    await ledger.init();
  });

  afterEach(async () => {
    await poolA.query("DELETE FROM credit_invoices");
    await poolA.query("DELETE FROM credit_draws");
    await poolA.query("DELETE FROM credit_fundings");
    await poolA.query("DELETE FROM credits");
  });

  afterAll(async () => {
    await poolA.end();
    await poolB.end();
  });

  async function issue(
    fundId: string,
    overrides: { creditId?: string; paymentHash?: string; expiresAt?: number } = {}
  ): Promise<string> {
    const creditId = overrides.creditId ?? `ln-${fundId}`;
    await ledger.recordInvoice({
      creditId,
      fundId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: AMOUNT_MICRO,
      amountMsats: AMOUNT_MSATS,
      paymentHash: overrides.paymentHash ?? `hash-${fundId}`,
      bolt11: `lnbcrt3000n1${fundId}`,
      expiresAt: overrides.expiresAt ?? FUTURE_MS,
    });
    return creditId;
  }

  it("credits the ledger and flips the invoice in one transaction", async () => {
    const creditId = await issue("f1");
    const result = await settleLn(ledger, { creditId, fundId: "f1", expiryMs: FUTURE_MS });

    expect(result.replayed).toBe(false);
    expect(result.invoice.status).toBe("settled");
    expect(result.funding?.amountMicro).toBe(AMOUNT_MICRO);
    expect(result.funding?.rail).toBe("lightning");
    expect(result.credit?.balanceMicro).toBe(AMOUNT_MICRO);
    const snap = await ledger.get(creditId);
    expect(snap?.callerPubkey).toBe(CALLER);
  });

  it("reports the preserved longer expiry when another invoice funds the same credit", async () => {
    const creditId = await issue("f1");
    const longerExpiry = FUTURE_MS + 180 * 86_400_000;
    await settleLn(ledger, { creditId, fundId: "f1", expiryMs: longerExpiry });
    await issue("f2", { creditId });
    const seen: unknown[] = [];
    const result = await ledger.settleInvoice({
      creditId, fundId: "f2", expiryMs: FUTURE_MS, basis: LN_BASIS,
      depositOutbox: {
        enqueue: (_tx, payload) => { seen.push(payload); return Promise.resolve(); },
        payload: {
          dvmId: "dvm-lightning-funding", creditId, callerPubkey: CALLER, fundingId: "hash-f2",
          rail: "lightning", paidMsats: AMOUNT_MSATS, amountMicro: AMOUNT_MICRO,
          creditCurrency: "usd", fundedAt: Date.now(), expiryMs: FUTURE_MS,
        },
      },
    });
    expect(result.credit?.expiryMs).toBe(longerExpiry);
    expect(seen).toEqual([expect.objectContaining({ expiryMs: longerExpiry })]);
  });

  it("re-issues nothing and returns the original bolt11 for a known fund_id", async () => {
    const creditId = await issue("f1");
    const again = await ledger.recordInvoice({
      creditId,
      fundId: "f1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: AMOUNT_MICRO,
      amountMsats: AMOUNT_MSATS,
      paymentHash: "hash-DIFFERENT",
      bolt11: "lnbcrt3000n1DIFFERENT",
      expiresAt: FUTURE_MS,
    });
    expect(again.bolt11).toBe(`lnbcrt3000n1f1`);
    expect(again.paymentHash).toBe("hash-f1");
  });

  it("refuses to bind one payment hash to two fundings", async () => {
    await issue("f1");
    await expect(
      ledger.recordInvoice({
        creditId: "ln-f2",
        fundId: "f2",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: AMOUNT_MICRO,
        amountMsats: AMOUNT_MSATS,
        paymentHash: "hash-f1",
        bolt11: "lnbcrt3000n1f2",
        expiresAt: FUTURE_MS,
      })
    ).rejects.toBeInstanceOf(CreditLedgerError);
  });

  it("rolls back refused and interrupted settlements, then retries the same invoice", async () => {
    const creditId = await issue("f1");

    // A currency conflict happens after recordFunding on the invoice transaction; that
    // partial funding must roll back.
    await fundCredit(ledger, {
      creditId,
      callerPubkey: CALLER,
      currency: "eur",
      amountMicro: 1,
      expiryMs: FUTURE_MS,
    });
    await expect(
      settleLn(ledger, { creditId, fundId: "f1", expiryMs: FUTURE_MS })
    ).rejects.toMatchObject({ code: "currency_mismatch" });

    expect(await ledger.getFunding({ creditId, fundId: "f1" })).toBeUndefined();
    expect((await ledger.getInvoice({ creditId, fundId: "f1" }))?.status).toBe("pending");

    const creditId2 = await issue("f2");
    await expect(
      ledger.settleInvoice({
        creditId: creditId2, fundId: "f2", expiryMs: FUTURE_MS, basis: LN_BASIS,
        depositOutbox: {
          enqueue: async () => { throw new Error("interrupted invoice commit"); },
          payload: {
            dvmId: "test-dvm", creditId: creditId2, callerPubkey: CALLER,
            fundingId: "hash-f2", rail: "lightning", paidMsats: AMOUNT_MSATS,
            amountMicro: AMOUNT_MICRO, creditCurrency: "usd",
            fundedAt: FUTURE_MS, expiryMs: FUTURE_MS,
          },
        },
      })
    ).rejects.toThrow("interrupted invoice commit");
    expect(await ledger.get(creditId2)).toBeUndefined();
    expect(await ledger.getFunding({ creditId: creditId2, fundId: "f2" })).toBeUndefined();
    expect((await ledger.getInvoice({ creditId: creditId2, fundId: "f2" }))?.status).toBe("pending");
    const first = await settleLn(ledger, {
      creditId: creditId2,
      fundId: "f2",
      expiryMs: FUTURE_MS,
    });
    expect(first.replayed).toBe(false);
    const second = await settleLn(ledger, {
      creditId: creditId2,
      fundId: "f2",
      expiryMs: FUTURE_MS,
    });
    expect(second.replayed).toBe(true);
    expect((await ledger.get(creditId2))?.balanceMicro).toBe(AMOUNT_MICRO);
  });

  it("credits once when two machines observe the same settlement together", async () => {
    const creditId = await issue("f1");

    const [a, b] = await Promise.allSettled([
      settleLn(ledger, { creditId, fundId: "f1", expiryMs: TTL_MS + Date.now() }),
      settleLn(ledgerB, { creditId, fundId: "f1", expiryMs: TTL_MS + Date.now() }),
    ]);

    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    const replayFlags = [a, b].map((r) => r.status === "fulfilled" ? r.value.replayed : undefined);
    expect(replayFlags.sort()).toEqual([false, true]);
    const applied = [a, b].filter((r) => r.status === "fulfilled" && !r.value.replayed);
    expect(applied.length).toBe(1);
    expect((await ledger.get(creditId))?.balanceMicro).toBe(AMOUNT_MICRO);
    const rows = await poolA.query("SELECT COUNT(*) FROM credit_fundings WHERE credit_id = $1", [
      creditId,
    ]);
    expect(Number(rows.rows[0].count)).toBe(1);
  });

  it("lists only this caller's outstanding invoices", async () => {
    await issue("f1");
    await issue("f2");
    const settledCredit = await issue("f3");
    await settleLn(ledger, { creditId: settledCredit, fundId: "f3", expiryMs: FUTURE_MS });
    await ledger.recordInvoice({
      creditId: "ln-other",
      fundId: "other",
      callerPubkey: "ef".repeat(32),
      currency: "usd",
      amountMicro: AMOUNT_MICRO,
      amountMsats: AMOUNT_MSATS,
      paymentHash: "hash-other",
      bolt11: "lnbcrt3000n1other",
      expiresAt: FUTURE_MS,
    });

    const pending = await ledger.listPendingInvoices({ callerPubkey: CALLER, limit: 10 });
    expect(pending.map((i) => i.fundId).sort()).toEqual(["f1", "f2"]);

    const scoped = await ledger.listPendingInvoices({
      callerPubkey: CALLER,
      creditId: "ln-f1",
      limit: 10,
    });
    expect(scoped.map((i) => i.fundId)).toEqual(["f1"]);
  });

  it("retires an expired invoice without touching the ledger, and only once", async () => {
    const creditId = await issue("f1");
    const expired = await ledger.markInvoiceExpired({ creditId, fundId: "f1" });
    expect(expired?.status).toBe("expired");
    expect(await ledger.get(creditId)).toBeUndefined();

    const again = await ledger.markInvoiceExpired({ creditId, fundId: "f1" });
    expect(again?.status).toBe("expired");
    const settledCredit = await issue("f2");
    await settleLn(ledger, { creditId: settledCredit, fundId: "f2", expiryMs: FUTURE_MS });
    const settlementWins = await ledger.markInvoiceExpired({ creditId: settledCredit, fundId: "f2" });
    expect(settlementWins?.status).toBe("settled");
  });

  it("retires a paid-but-uncreditable invoice, and never over a settlement", async () => {
    const creditId = await issue("f1");
    const blocked = await ledger.markInvoiceBlocked({
      creditId,
      fundId: "f1",
      reason: "funding_replayed_on_cashu",
    });
    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blockedReason).toBe("funding_replayed_on_cashu");
    expect(await ledger.get(creditId)).toBeUndefined();
    expect(await ledger.listPendingInvoices({ callerPubkey: CALLER, limit: 10 })).toEqual([]);

    const settledCredit = await issue("f2");
    await settleLn(ledger, { creditId: settledCredit, fundId: "f2", expiryMs: FUTURE_MS });
    const loser = await ledger.markInvoiceBlocked({
      creditId: settledCredit,
      fundId: "f2",
      reason: "caller_mismatch",
    });
    expect(loser?.status).toBe("settled");
    expect(loser?.blockedReason).toBeNull();
  });
});

describe.skipIf(!RUN)("reconciling a blocked invoice (Postgres)", () => {
  let pool: pg.Pool;
  let ledger: CreditLedger;

  const HASH = "hash-blocked";

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(pool);
    await ledger.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM credit_invoices");
    await pool.query("DELETE FROM credit_draws");
    await pool.query("DELETE FROM credit_fundings");
    await pool.query("DELETE FROM credits");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function blocked(
    overrides: { creditId?: string; fundId?: string; paymentHash?: string } = {}
  ): Promise<{ creditId: string; fundId: string; paymentHash: string }> {
    const creditId = overrides.creditId ?? "ln-blocked";
    const fundId = overrides.fundId ?? "fb";
    const paymentHash = overrides.paymentHash ?? HASH;
    await ledger.recordInvoice({
      creditId,
      fundId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: AMOUNT_MICRO,
      amountMsats: AMOUNT_MSATS,
      paymentHash,
      bolt11: `lnbcrt3000n1${fundId}`,
      expiresAt: FUTURE_MS,
    });
    await ledger.markInvoiceBlocked({ creditId, fundId, reason: "funding_replayed_on_cashu" });
    return { creditId, fundId, paymentHash };
  }

  function outbox(seen: unknown[]) {
    return {
      enqueue: async (tx: { query: pg.Pool["query"] }, payload: unknown) => {
        seen.push(payload);
        await tx.query(
          `CREATE TEMP TABLE IF NOT EXISTS sdk_lightning_outbox (payload TEXT) ON COMMIT DROP`
        );
      },
      payload: {
        dvmId: "dvm-lightning-funding",
        creditId: "ln-target",
        callerPubkey: CALLER,
        fundingId: HASH,
        rail: "lightning",
        paidMsats: AMOUNT_MSATS,
        amountMicro: AMOUNT_MICRO,
        creditCurrency: "usd",
        fundedAt: FUTURE_MS,
        expiryMs: FUTURE_MS,
      },
    };
  }

  it("reports the committed expiry when reconciliation funds a longer-lived target", async () => {
    await blocked();
    const longerExpiry = FUTURE_MS + 180 * 86_400_000;
    await ledger.fund({ creditId: "ln-target", callerPubkey: CALLER, currency: "usd",
      amountMicro: AMOUNT_MICRO, expiryMs: longerExpiry, basis: LN_BASIS });
    const seen: unknown[] = [];
    const result = await ledger.reconcileBlockedInvoice({
      paymentHash: HASH, targetCreditId: "ln-target", expiryMs: FUTURE_MS,
      basis: LN_BASIS, depositOutbox: outbox(seen),
    });
    expect(result.credit?.expiryMs).toBe(longerExpiry);
    expect(seen).toEqual([expect.objectContaining({ expiryMs: longerExpiry })]);
  });

  it("credits the balance and enqueues the deposit exactly once under a repeated run", async () => {
    await blocked();
    const seen: unknown[] = [];

    const first = await ledger.reconcileBlockedInvoice({
      paymentHash: HASH,
      targetCreditId: "ln-target",
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
      settledAtMs: FUTURE_MS - 1000,
      depositOutbox: outbox(seen),
    });
    expect(first.replayed).toBe(false);
    expect(first.credit?.balanceMicro).toBe(AMOUNT_MICRO);
    expect(first.funding).toMatchObject({ creditId: "ln-target", fundId: HASH, rail: "lightning" });

    const second = await ledger.reconcileBlockedInvoice({
      paymentHash: HASH,
      targetCreditId: "ln-target",
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
      depositOutbox: outbox(seen),
    });
    expect(second.replayed).toBe(true);
    expect(second.credit?.balanceMicro).toBe(AMOUNT_MICRO);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ callerPubkey: CALLER });

    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM credit_fundings WHERE credit_id = 'ln-target'`
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it("records where the money went and keeps the reason it needed an operator", async () => {
    await blocked();
    await ledger.reconcileBlockedInvoice({
      paymentHash: HASH,
      targetCreditId: "ln-target",
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
      settledAtMs: FUTURE_MS - 5000,
    });
    const invoice = await ledger.getInvoiceByPaymentHash(HASH);
    expect(invoice).toMatchObject({
      status: "reconciled",
      reconciledCreditId: "ln-target",
      reconciledFundId: HASH,
      blockedReason: "funding_replayed_on_cashu",
      settledAt: FUTURE_MS - 5000,
    });
    expect(invoice?.resolvedAt).toBeGreaterThan(0);
  });

  it("rolls the balance, the funding row and the outbox write back together", async () => {
    await blocked();
    await expect(
      ledger.reconcileBlockedInvoice({
        paymentHash: HASH,
        targetCreditId: "ln-target",
        expiryMs: FUTURE_MS,
        basis: LN_BASIS,
        depositOutbox: {
          enqueue: () => Promise.reject(new Error("outbox write failed")),
          payload: outbox([]).payload,
        },
      })
    ).rejects.toThrow("outbox write failed");

    expect(await ledger.get("ln-target")).toBeUndefined();
    expect(await ledger.getFunding({ creditId: "ln-target", fundId: HASH })).toBeUndefined();
    expect((await ledger.getInvoiceByPaymentHash(HASH))?.status).toBe("blocked");
  });

  it("credits onto the invoice's own credit even when that key is already taken", async () => {
    // The `funding_replayed_on_cashu` shape: the caller reused fund_id on
    // cashu, so `(credit_id, fund_id)` holds a different payment — and the
    // operator's natural target is that same credit.
    const { creditId, fundId } = await blocked();
    await fundCredit(ledger, {
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
    });
    await ledger.recordFunding({ creditId, fundId, amountMicro: 1_000, rail: "cashu" });

    const result = await ledger.reconcileBlockedInvoice({
      paymentHash: HASH,
      targetCreditId: creditId,
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
    });
    expect(result.replayed).toBe(false);
    expect(result.credit?.balanceMicro).toBe(1_000 + AMOUNT_MICRO);
  });

  it("refuses an invoice that is not blocked, and one that does not exist", async () => {
    const creditId = "ln-pending";
    await ledger.recordInvoice({
      creditId,
      fundId: "fp",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: AMOUNT_MICRO,
      amountMsats: AMOUNT_MSATS,
      paymentHash: "hash-pending",
      bolt11: "lnbcrt3000n1fp",
      expiresAt: FUTURE_MS,
    });
    await expect(
      ledger.reconcileBlockedInvoice({
        paymentHash: "hash-pending",
        targetCreditId: "ln-target",
        expiryMs: FUTURE_MS,
        basis: LN_BASIS,
      })
    ).rejects.toMatchObject({ code: "invoice_not_blocked" });
    await expect(
      ledger.reconcileBlockedInvoice({
        paymentHash: "hash-nothing",
        targetCreditId: "ln-target",
        expiryMs: FUTURE_MS,
        basis: LN_BASIS,
      })
    ).rejects.toMatchObject({ code: "invoice_not_found" });
    expect(await ledger.get("ln-target")).toBeUndefined();
  });

  it("pages the queue on a keyset and hides resolved rows by default", async () => {
    await blocked({ creditId: "c-a", fundId: "fa", paymentHash: "hash-a" });
    await blocked({ creditId: "c-b", fundId: "fb2", paymentHash: "hash-b" });
    await blocked({ creditId: "c-c", fundId: "fc", paymentHash: "hash-c" });
    await ledger.writeOffBlockedInvoice({ paymentHash: "hash-b", note: "already made whole" });

    const open = await ledger.listBlockedInvoices({ limit: 50 });
    expect(open.map((i) => i.paymentHash).sort()).toEqual(["hash-a", "hash-c"]);

    const page = await ledger.listBlockedInvoices({ limit: 1, includeResolved: true });
    expect(page).toHaveLength(1);
    const next = await ledger.listBlockedInvoices({
      limit: 50,
      includeResolved: true,
      after: {
        createdAt: page[0].createdAt,
        creditId: page[0].creditId,
        fundId: page[0].fundId,
      },
    });
    expect(next.map((i) => i.paymentHash)).not.toContain(page[0].paymentHash);
    expect(next).toHaveLength(2);
  });

  it("writes off idempotently, moves no money, and stays reversible", async () => {
    await blocked();
    const first = await ledger.writeOffBlockedInvoice({ paymentHash: HASH, note: "first call" });
    const second = await ledger.writeOffBlockedInvoice({ paymentHash: HASH, note: "second call" });
    expect(first?.invoice.status).toBe("written_off");
    expect(second?.invoice.writeOffNote).toBe("first call");
    expect(first?.written).toBe(true);
    expect(second?.written).toBe(false);
    expect(await ledger.get("ln-blocked")).toBeUndefined();

    const revived = await ledger.reconcileBlockedInvoice({
      paymentHash: HASH,
      targetCreditId: "ln-target",
      expiryMs: FUTURE_MS,
      basis: LN_BASIS,
    });
    expect(revived.credit?.balanceMicro).toBe(AMOUNT_MICRO);
  });
});
