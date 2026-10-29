import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresX402ExactSettlementStore,
  type X402ExactSettlementEffect,
} from "../x402-exact-settlement-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const DVM_ID = "dvm-exact-settlement-exact-settlement";

describe.skipIf(!RUN)("exact x402 settlement store (Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresX402ExactSettlementStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresX402ExactSettlementStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM x402_exact_settlement_attempts WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM x402_exact_job_auth_bindings WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM x402_exact_settlement_intents WHERE dvm_id = $1", [DVM_ID]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("accepts a structurally unchanged populated effect after a JSONB round trip", async () => {
    const firstEffect: X402ExactSettlementEffect = {
      nativeAmount: 1000,
      fundedMicro: 1000,
      paidMsats: 1000,
      ttlMs: 60_000,
      drawBasis: false,
      creditEnvelope: {
        drawId: "draw-1",
        creditId: "credit-1",
        fund: { commitment: "aa".repeat(32), amountMicro: 1000 },
      },
      jobAdmission: {
        authFingerprint: "auth-fingerprint",
        requestFingerprint: "request-fingerprint",
      },
      jobId: "job-original",
      dvmId: DVM_ID,
      callerId: "caller-1",
      requiredMsats: 1000,
      priceFiat: { amountMicro: 1000, currency: "usd" },
    };
    const reorderedEffect: X402ExactSettlementEffect = {
      priceFiat: { currency: "usd", amountMicro: 1000 },
      requiredMsats: 1000,
      callerId: "caller-1",
      dvmId: DVM_ID,
      jobId: "job-retry-allocation",
      jobAdmission: {
        requestFingerprint: "request-fingerprint",
        authFingerprint: "fresh-auth-fingerprint",
      },
      creditEnvelope: {
        creditId: "credit-1",
        drawId: "draw-1",
        fund: { amountMicro: 1000, commitment: "aa".repeat(32) },
      },
      drawBasis: false,
      ttlMs: 60_000,
      paidMsats: 1000,
      fundedMicro: 1000,
      nativeAmount: 1000,
    };
    const intent = exactIntent("intent-jsonb-effect", firstEffect);

    await expect(store.prepare(intent)).resolves.toMatchObject({ effect: firstEffect });
    await expect(store.prepare({ ...intent, effect: reorderedEffect })).resolves.toMatchObject({
      effect: firstEffect,
    });
    expect(
      (
        await pool.query<{ auth_fingerprint: string; intent_id: string }>(
          `SELECT auth_fingerprint, intent_id
             FROM x402_exact_job_auth_bindings
            WHERE dvm_id = $1
            ORDER BY auth_fingerprint`,
          [DVM_ID]
        )
      ).rows
    ).toEqual([
      { auth_fingerprint: "auth-fingerprint", intent_id: intent.id },
      { auth_fingerprint: "fresh-auth-fingerprint", intent_id: intent.id },
    ]);
  });

  it("rolls back a failed local effect, then commits it with the intent exactly once", async () => {
    await settledIntent(store, "intent-atomic");

    await expect(
      store.finalize(DVM_ID, "intent-atomic", async (_intent, tx) => {
        if (!tx) throw new Error("Postgres finalization did not provide a transaction");
        await tx.query(
          `INSERT INTO x402_exact_settlement_attempts
             (id, dvm_id, intent_id, outcome, detail, created_at)
           VALUES ('injected-effect', $1, $2, 'success', 'local effect', $3)`,
          [DVM_ID, "intent-atomic", Date.now()]
        );
        throw new Error("injected database failure after local effect");
      })
    ).rejects.toThrow("injected database failure after local effect");

    expect((await store.get(DVM_ID, "intent-atomic"))?.status).toBe("settled");
    expect(
      await pool.query("SELECT 1 FROM x402_exact_settlement_attempts WHERE id = $1", [
        "injected-effect",
      ])
    ).toHaveProperty("rowCount", 0);

    const effect = vi.fn(async (_intent, tx) => {
      if (!tx) throw new Error("Postgres finalization did not provide a transaction");
      await tx.query(
        `INSERT INTO x402_exact_settlement_attempts
           (id, dvm_id, intent_id, outcome, detail, created_at)
         VALUES ('committed-effect', $1, $2, 'success', 'local effect', $3)`,
        [DVM_ID, "intent-atomic", Date.now()]
      );
      return "booked";
    });
    const [first, second] = await Promise.all([
      store.finalize(DVM_ID, "intent-atomic", effect),
      store.finalize(DVM_ID, "intent-atomic", effect),
    ]);

    expect(effect).toHaveBeenCalledTimes(1);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect((await store.get(DVM_ID, "intent-atomic"))?.status).toBe("complete");
    expect(
      await pool.query("SELECT 1 FROM x402_exact_settlement_attempts WHERE id = $1", [
        "committed-effect",
      ])
    ).toHaveProperty("rowCount", 1);

    await store.recordOutcome({
      dvmId: DVM_ID,
      intentId: "intent-atomic",
      status: "ambiguous",
      outcome: "timeout",
      detail: "late facilitator response",
    });
    expect((await store.get(DVM_ID, "intent-atomic"))?.status).toBe("complete");
  });

  it("keeps a job-bearing local commit open until admission completes", async () => {
    await settledIntent(store, "intent-job-admission", {
      priceFiat: { currency: "usd", amountMicro: 1000 },
      requiredMsats: 1000,
      callerId: "caller-1",
      dvmId: DVM_ID,
      jobId: "job-original",
      jobAdmission: { requestFingerprint: "request-fingerprint" },
      drawBasis: false,
      ttlMs: 60_000,
      paidMsats: 1000,
      fundedMicro: 1000,
      nativeAmount: 1000,
    });

    await store.finalize(DVM_ID, "intent-job-admission", async () => "booked");
    expect((await store.get(DVM_ID, "intent-job-admission"))?.status).toBe("local_committed");
    await store.recordOutcome({
      dvmId: DVM_ID,
      intentId: "intent-job-admission",
      status: "ambiguous",
      outcome: "timeout",
      detail: "late facilitator response",
    });
    expect((await store.get(DVM_ID, "intent-job-admission"))?.status).toBe("local_committed");

    await store.markAdmissionComplete(DVM_ID, "intent-job-admission");
    expect((await store.get(DVM_ID, "intent-job-admission"))?.status).toBe("complete");
  });

  it("releases only an intent that was never submitted, and stops counting it as unresolved", async () => {
    await store.prepare(exactIntent("intent-released"));
    await store.prepare({ ...exactIntent("intent-submitted"), nonce: `0x${"66".repeat(32)}` });
    await store.markSubmitting({ dvmId: DVM_ID, intentId: "intent-submitted" });

    expect(await store.release({ dvmId: DVM_ID, intentId: "intent-released", reason: "failed" })).toBe(true);
    expect(await store.release({ dvmId: DVM_ID, intentId: "intent-released", reason: "failed" })).toBe(false);
    expect(await store.release({ dvmId: DVM_ID, intentId: "intent-submitted", reason: "failed" })).toBe(false);

    expect(await store.get(DVM_ID, "intent-released")).toMatchObject({
      status: "released",
      lastOutcome: "failed",
    });
    expect((await store.get(DVM_ID, "intent-submitted"))?.status).toBe("submitting");
    expect((await store.list({ dvmId: DVM_ID, limit: 10 })).map((intent) => intent.id)).toEqual([
      "intent-submitted",
    ]);
  });
});

async function settledIntent(
  store: PostgresX402ExactSettlementStore,
  intentId: string,
  effect?: Parameters<PostgresX402ExactSettlementStore["prepare"]>[0]["effect"]
): Promise<void> {
  await store.prepare(exactIntent(intentId, effect));
  expect(
    await store.markSubmitting({
      dvmId: DVM_ID,
      intentId,
      submissionBlock: "100",
    })
  ).toBe(true);
  await store.recordOutcome({
    dvmId: DVM_ID,
    intentId,
    status: "settled",
    outcome: "success",
    transaction: `0x${"55".repeat(32)}`,
  });
}

function exactIntent(
  intentId: string,
  effect?: Parameters<PostgresX402ExactSettlementStore["prepare"]>[0]["effect"]
): Parameters<PostgresX402ExactSettlementStore["prepare"]>[0] {
  return {
    id: intentId,
    dvmId: DVM_ID,
    resource: "/v1/job",
    network: "eip155:8453",
    asset: "0x1111111111111111111111111111111111111111",
    from: "0x2222222222222222222222222222222222222222",
    to: "0x3333333333333333333333333333333333333333",
    value: "1000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"44".repeat(32)}`,
    fingerprint: "fingerprint",
    effect,
  };
}
