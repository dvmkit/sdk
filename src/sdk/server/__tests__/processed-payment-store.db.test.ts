/**
 * durable x402/mpp processed-payment markers. The crash-replay
 * safety claim is a PRIMARY KEY + transaction guarantee, so it's tested
 * against real Postgres.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresProcessedPaymentStore,
  ProcessedPaymentReplayError,
} from "../processed-payment-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const DVM_ID = "dvm-funding-markers";

describe.skipIf(!RUN)("processed-payment markers (Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresProcessedPaymentStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresProcessedPaymentStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM processed_payments WHERE dvm_id = $1", [DVM_ID]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records and reads a marker; a second record of the same payment id throws", async () => {
    await store.record({
      dvmId: DVM_ID,
      rail: "x402",
      paymentId: "0xabc",
      creditId: "imp:x402:0xabc",
      drawId: "0xabc",
      jobId: "job-1",
    });
    const rec = await store.get({ dvmId: DVM_ID, rail: "x402", paymentId: "0xabc" });
    expect(rec?.creditId).toBe("imp:x402:0xabc");
    expect(rec?.jobId).toBe("job-1");

    await expect(
      store.record({
        dvmId: DVM_ID,
        rail: "x402",
        paymentId: "0xabc",
        creditId: "other",
        drawId: "other",
      })
    ).rejects.toThrow(ProcessedPaymentReplayError);

    // Same payment id on the OTHER rail is a distinct key — no collision.
    await store.record({
      dvmId: DVM_ID,
      rail: "tempo",
      paymentId: "0xabc",
      creditId: "imp:mpp:0xabc",
      drawId: "0xabc",
    });
  });

  it("withTx rolls the marker back when the ledger leg throws (crash injection)", async () => {
    await expect(
      store.withTx(async (tx) => {
        await store.record({
          dvmId: DVM_ID,
          rail: "tempo",
          paymentId: "ch-crash",
          creditId: "imp:mpp:ch-crash",
          drawId: "ch-crash",
          tx,
        });
        throw new Error("injected crash before the ledger fund");
      })
    ).rejects.toThrow("injected crash");
    expect(
      await store.get({ dvmId: DVM_ID, rail: "tempo", paymentId: "ch-crash" })
    ).toBeUndefined();
  });

  it("withTx commits marker atomically on success", async () => {
    await store.withTx(async (tx) => {
      await store.record({
        dvmId: DVM_ID,
        rail: "tempo",
        paymentId: "ch-ok",
        creditId: "imp:mpp:ch-ok",
        drawId: "ch-ok",
        tx,
      });
    });
    expect((await store.get({ dvmId: DVM_ID, rail: "tempo", paymentId: "ch-ok" }))?.drawId).toBe(
      "ch-ok"
    );
  });
});
