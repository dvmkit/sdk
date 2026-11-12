import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPostgresCardChargeJournal } from "../card-charge-journal";
import { runCardRefundSweep } from "../card-refund-sweep";
import { CreditLedger, type CreditLedgerLike } from "../credit-ledger";
import { fundStripeCheckout } from "../stripe-checkout-funding";
import type { CreditDepositPayload } from "../revenue-reporter";
import { derivedFundCreditId } from "../funding";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { CHECKOUT_ABANDONED_AFTER_MS, CHECKOUT_RECOVERY_BACKOFF_MS } from "../stripe-checkout-recovery";
import { createPostgresStripeCheckoutStore } from "../stripe-checkout-store";
import { CALLER } from "./__helpers__/card-credit";
import { checkoutFund, checkoutServer, fakeCheckoutAccount } from "./__helpers__/stripe-checkout";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_stripe_checkout";

async function pool(schema?: string): Promise<Pool> {
  const pg = await import("pg");
  return new pg.default.Pool({ connectionString: DATABASE_URL,
    max: 10, connectionTimeoutMillis: 2000,
    ...(schema && { options: `-c search_path=${schema}` }),
  });
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, wait: async () => { enter(); await released; } };
}

describe.skipIf(!RUN)("Checkout funding and recovery on Postgres", () => {
  let db: Pool;
  let siblingDb: Pool;
  let ledger: CreditLedger;
  let processed: PostgresProcessedPaymentStore;
  let store: Awaited<ReturnType<typeof createPostgresStripeCheckoutStore>>;
  let siblingStore: Awaited<ReturnType<typeof createPostgresStripeCheckoutStore>>;

  beforeAll(async () => {
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    await admin.end();
    db = await pool(SCHEMA);
    siblingDb = await pool(SCHEMA);
    ledger = new CreditLedger(db);
    await ledger.init();
    processed = new PostgresProcessedPaymentStore(db);
    await processed.init();
    store = await createPostgresStripeCheckoutStore(db);
    siblingStore = await createPostgresStripeCheckoutStore(siblingDb);
    await db.query("CREATE TABLE checkout_test_deposits (funding_id TEXT PRIMARY KEY, amount_micro BIGINT NOT NULL)");
  });

  beforeEach(async () => {
    await db.query("TRUNCATE credits CASCADE");
    await db.query("TRUNCATE credit_fundings, processed_payments, stripe_checkout_sessions, checkout_test_deposits");
  });

  afterAll(async () => {
    await db.end();
    await siblingDb.end();
    const admin = await pool();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.end();
  });

  async function server(account = fakeCheckoutAccount(), checkoutStore = store, customLedger: CreditLedgerLike = ledger) {
    const deposits: CreditDepositPayload[] = [];
    const current = await checkoutServer({ account, checkoutStore, ledger: customLedger, deposits,
      serverOpts: { processedPayments: processed, dvmId: "checkout-test" },
    });
    return { ...current, deposits };
  }

  async function age(fundId: string) {
    const createdAt = Date.now() - CHECKOUT_ABANDONED_AFTER_MS - 1000;
    await db.query(`UPDATE stripe_checkout_sessions SET expires_at=$2,
      record=record || jsonb_build_object('createdAt',$3::bigint,'expiresAt',$2::bigint) WHERE fund_id=$1`,
    [fundId, createdAt + 3600_000, createdAt]);
  }

  async function sweep(current: Awaited<ReturnType<typeof server>>) {
    return runCardRefundSweep({ ledger, stripe: current.rail.refunds, checkout: current.rail.checkout,
      journal: await createPostgresCardChargeJournal(db), drainReport: {} });
  }

  it("ten simultaneous creates and paid polls across pools book one lot, marker, and deposit", async () => {
    const one = await server();
    const two = await server(one.account, siblingStore);
    const apps = [one.app, two.app];
    const pending = await Promise.all(Array.from({ length: 10 }, () => checkoutFund(one.app, "concurrent")));
    expect(pending.every((r) => [202, 503].includes(r.status))).toBe(true);
    expect((await checkoutFund(one.app, "concurrent")).status).toBe(202);
    expect(one.account.forms).toHaveLength(1);
    one.account.paid("concurrent");
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => checkoutFund(apps[i % 2]!, "concurrent")));
    expect(responses.every((r) => [200, 503].includes(r.status))).toBe(true);
    expect((await checkoutFund(one.app, "concurrent")).status).toBe(200);
    const creditId = derivedFundCreditId(CALLER, "concurrent");
    expect((await ledger.get(creditId))?.balanceMicro).toBe(5_000_000);
    expect(await ledger.listFundingLots(creditId)).toHaveLength(1);
    expect([...one.deposits, ...two.deposits]).toHaveLength(1);
    expect((await db.query("SELECT * FROM processed_payments WHERE credit_id=$1", [creditId])).rows).toHaveLength(1);
    await age("concurrent");
    expect((await sweep(two)).strandedRefunds).toEqual([]);
    expect(one.account.refunds).toEqual([]);
  });

  it.each([false, true])("retries a busy internal create save or lease release (lost reply: %s)", async (lostReply) => {
    const one = await server();
    if (lostReply) one.account.loseCreateReply();
    const held = await siblingDb.connect();
    let unlock: Promise<void> | undefined;
    one.account.onCreate(async () => {
      await held.query("BEGIN");
      await held.query("SELECT 1 FROM stripe_checkout_sessions WHERE fund_id='create-save' FOR UPDATE");
      unlock = delay(200).then(async () => { await held.query("ROLLBACK"); });
    });
    try {
      expect((await checkoutFund(one.app, "create-save")).status).toBe(lostReply ? 503 : 202);
      await unlock;
      one.account.onCreate();
      const record = (await store.get("create-save"))!;
      expect(record.leaseToken).toBeUndefined();
      expect(record.leaseUntil).toBeUndefined();
      expect((await checkoutFund(one.app, "create-save")).status).toBe(202);
      expect(one.account.sessions.size).toBe(1);
      expect((await store.get("create-save"))?.state).toBe("open");
    } finally {
      await unlock;
      await held.query("ROLLBACK");
      held.release();
    }
  });

  it("rolls back ledger, marker, and booked state when the deposit outbox fails", async () => {
    const broken = await server();
    await checkoutFund(broken.app, "outbox");
    broken.account.paid("outbox");
    const failed = await fundStripeCheckout({
      rail: broken.rail.checkout!, fundId: "outbox", creditId: derivedFundCreditId(CALLER, "outbox"),
      callerPubkey: CALLER, amountMicro: 5_000_000, productName: "Test prepaid credit",
      preflight: async () => undefined,
      opts: { requiredMsats: 0, creditLedger: ledger, processedPayments: processed, dvmId: "checkout-test",
        enqueueCreditDeposit: async (tx, payload) => {
          await tx.query("INSERT INTO checkout_test_deposits VALUES ($1,$2)", [payload.fundingId, payload.amountMicro]);
          throw new Error("Outbox unavailable");
        },
      },
    });
    expect(failed.funded).toBe(false);
    if (!failed.funded) expect(failed.response.status).toBe(503);
    expect((await db.query("SELECT * FROM checkout_test_deposits")).rows).toEqual([]);
    const creditId = derivedFundCreditId(CALLER, "outbox");
    expect(await ledger.get(creditId)).toBeUndefined();
    expect(await ledger.getFunding({ creditId, fundId: "outbox" })).toBeUndefined();
    expect((await db.query("SELECT state FROM stripe_checkout_sessions WHERE fund_id='outbox'")).rows[0].state).toBe("open");
    const recovered = await server(broken.account, siblingStore);
    expect((await checkoutFund(recovered.app, "outbox")).status).toBe(200);
    expect(await ledger.listFundingLots(creditId)).toHaveLength(1);
  });

  it("cannot book while a sibling sweep is refunding, including after its refund reply", async () => {
    const one = await server();
    const two = await server(one.account, siblingStore);
    await checkoutFund(one.app, "sweep-wins");
    one.account.paid("sweep-wins");
    await age("sweep-wins");
    const gate = barrier();
    one.account.onRefund(gate.wait);
    const refunding = sweep(two);
    await gate.entered;
    try {
      const response = await checkoutFund(one.app, "sweep-wins");
      expect(response.status).toBe(409);
      expect((await response.json()).error).toBe("checkout_expired");
    } finally { gate.release(); }
    expect((await refunding).strandedRefunds).toContain("pi_cs_test_1");
    const late = await (await checkoutFund(one.app, "sweep-wins")).json();
    expect(late).toMatchObject({ error: "checkout_expired" });
    expect(late.hint).toContain("refunded to the card");
    expect(await ledger.get(derivedFundCreditId(CALLER, "sweep-wins"))).toBeUndefined();
    expect(one.account.refunds).toHaveLength(1);
  });

  it("cannot refund while a sibling poll commits its booking transaction", async () => {
    const gate = barrier();
    const slow = new Proxy(ledger, {
      get(target, property, receiver) {
        if (property === "fund") return async (args: Parameters<CreditLedgerLike["fund"]>[0]) => {
          await gate.wait();
          return target.fund(args);
        };
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const one = await server(fakeCheckoutAccount(), store, slow);
    const two = await server(one.account, siblingStore);
    await checkoutFund(one.app, "poll-wins"); one.account.paid("poll-wins"); await age("poll-wins");
    const booking = checkoutFund(one.app, "poll-wins");
    await gate.entered;
    try {
      expect((await sweep(two)).strandedRefunds).toEqual([]);
      expect(one.account.refunds).toEqual([]);
    } finally { gate.release(); }
    expect((await booking).status).toBe(200);
    expect((await ledger.get(derivedFundCreditId(CALLER, "poll-wins")))?.balanceMicro).toBe(5_000_000);
  });

  it("expires an unshown session after a lost create reply without adopting or refunding it", async () => {
    const one = await server();
    one.account.loseCreateReply();
    expect((await checkoutFund(one.app, "lost")).status).toBe(503);
    await age("lost");
    const result = await sweep(one);
    expect(result.strandedRefunds).toEqual([]);
    expect(one.account.forms).toHaveLength(1);
    expect(one.account.searches).toBe(0);
    expect(one.account.refunds).toEqual([]);
    expect((await checkoutFund(one.app, "lost")).status).toBe(409);
  });

  it("keeps the shared pool available while ten Stripe reads are stalled", async () => {
    const one = await server();
    await checkoutFund(one.app, "slow");
    const gate = barrier();
    one.account.onRead(gate.wait);
    const polls = Array.from({ length: 10 }, () => checkoutFund(one.app, "slow"));
    await gate.entered;
    try {
      await delay(25);
      for (let attempt = 0; attempt < 100 && db.idleCount !== db.totalCount; attempt++) await delay(5);
      const unrelated = await db.query("SELECT 1 AS available");
      expect(unrelated.rows).toEqual([{ available: 1 }]);
      expect(db.idleCount).toBe(db.totalCount);
    } finally { gate.release(); one.account.onRead(); }
    expect((await Promise.all(polls)).every((r) => [202, 503].includes(r.status))).toBe(true);
  });

  it("returns immediately when another transaction owns the booking row", async () => {
    const one = await server();
    await checkoutFund(one.app, "busy");
    one.account.paid("busy");
    const held = await db.connect();
    await held.query("BEGIN");
    await held.query("SELECT * FROM stripe_checkout_sessions WHERE fund_id='busy' FOR UPDATE");
    const polling = checkoutFund(one.app, "busy");
    try {
      const response = await Promise.race([polling, delay(1000, undefined, { ref: false })]);
      expect(response, "a busy row must not queue the poll").toBeDefined();
      expect(response!.status).toBe(503);
      expect((await response!.json()).retryable).toBe(true);
    } finally { await held.query("ROLLBACK"); held.release(); await polling; }
    expect((await checkoutFund(one.app, "busy")).status).toBe(200);
  });

  it("serializes refund claims across sibling sweep workers", async () => {
    const one = await server();
    const two = await server(one.account, siblingStore);
    await checkoutFund(one.app, "sweeps"); one.account.paid("sweeps"); await age("sweeps");
    const results = await Promise.all([sweep(one), sweep(two)]);
    expect(one.account.refunds).toHaveLength(1);
    expect(results.flatMap((result) => result.strandedRefunds)).toEqual(["pi_cs_test_1"]);
    expect((await store.get("sweeps"))?.state).toBe("refunded");
  });

  it("uses one persisted namespace across store instances and a new namespace in another schema", async () => {
    expect(siblingStore.namespace).toBe(store.namespace);
    const alternate = await pool();
    await alternate.query("CREATE SCHEMA checkout_namespace_test");
    const isolated = await pool("checkout_namespace_test");
    try {
      const other = await createPostgresStripeCheckoutStore(isolated);
      expect(other.namespace).not.toBe(store.namespace);
    } finally {
      await isolated.end();
      await alternate.query("DROP SCHEMA checkout_namespace_test CASCADE");
      await alternate.end();
    }
  });

  it("backs off a disputed refund so a newer abandoned session is not starved", async () => {
    const one = await server();
    await checkoutFund(one.app, "blocked"); one.account.paid("blocked"); await age("blocked");
    one.account.dispute("pi_cs_test_1", "needs_response");
    const run = (nowMs = Date.now()) => runCardRefundSweep({ ledger, stripe: one.rail.refunds, checkout: one.rail.checkout, drainReport: {} }, { limit: 1, nowMs });
    await run();
    expect((await store.get("blocked"))?.state).toBe("refunding");
    expect((await store.get("blocked"))!.nextRecoveryAt).toBeGreaterThan(Date.now());
    one.account.dispute("pi_cs_test_1", "won");
    await checkoutFund(one.app, "newer"); one.account.paid("newer"); await age("newer");
    expect((await run(Date.now() + CHECKOUT_RECOVERY_BACKOFF_MS + 1000)).strandedRefunds).toEqual(["pi_cs_test_2"]);
    expect((await store.get("blocked"))?.state).toBe("refunding");
    expect((await run(Date.now() + CHECKOUT_RECOVERY_BACKOFF_MS + 1000)).strandedRefunds).toEqual(["pi_cs_test_1"]);
    expect((await store.get("blocked"))?.state).toBe("refunded");
  });

  it("expires unpaid sessions and does not feed Checkout to the token charge journal", async () => {
    const one = await server();
    await checkoutFund(one.app, "unpaid");
    one.account.sessions.get("cs_test_1")!.status = "expired";
    await age("unpaid");
    await sweep(one);
    expect(one.account.refunds).toEqual([]);
    expect(one.account.searches).toBe(0);
    expect((await db.query("SELECT * FROM card_charge_attempts")).rows).toEqual([]);
    expect((await db.query("SELECT state FROM stripe_checkout_sessions WHERE fund_id='unpaid'")).rows[0].state).toBe("expired");
  });
});
