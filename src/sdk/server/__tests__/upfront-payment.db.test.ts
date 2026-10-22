import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const databaseUrl = process.env.DATABASE_URL;
const run = !!databaseUrl && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(databaseUrl);

describe.skipIf(!run)("immutable upfront payment persistence", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: databaseUrl });
    store = new PostgresJobStore(pool);
    await store.init();
  });
  afterEach(async () => {
    await pool.query("DELETE FROM jobs WHERE id = 'upfront-persistence'");
  });
  afterAll(async () => { await pool.end(); });

  function record(upfrontPayment?: JobRecord["upfrontPayment"]): JobRecord {
    return {
      id: "upfront-persistence", tags: [], capability: "test", input: "", params: {},
      requesterId: "caller", status: "processing", messages: [], seq: 0,
      paidMsats: 321, upfrontPayment, receivedProofs: [], stepCache: [], state: {},
      createdAt: Date.now(), lastActivityAt: Date.now(),
    };
  }

  it.each([undefined, { amount_msats: 0 }, {
    amount_msats: 321, amount_micro: 123, currency: "eur", credit_id: "c", draw_id: "d",
  }])("retains the inserted fact across another store and later snapshots (%j)", async (original) => {
    await store.save(record(original));
    const otherStore = new PostgresJobStore(pool);
    expect((await otherStore.get("upfront-persistence"))?.upfrontPayment).toEqual(original);
    await otherStore.save({ ...record({ amount_msats: 999 }), paidMsats: 999 });
    await store.save({ ...record(), status: "completed", paidMsats: 999 });
    expect((await otherStore.get("upfront-persistence"))?.upfrontPayment).toEqual(original);
  });

  it("adds a nullable column without reconstructing historical amounts", async () => {
    await store.save(record());
    await pool.query("ALTER TABLE jobs DROP COLUMN upfront_payment");
    await store.init();
    expect((await store.get("upfront-persistence"))?.upfrontPayment).toBeUndefined();
  });
});
