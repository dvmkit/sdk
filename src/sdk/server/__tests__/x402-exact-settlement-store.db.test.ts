import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresX402ExactSettlementStore,
  X402ExactPayerLimitError,
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

  it("lets exactly one of several concurrent claims of the same intent insert it", async () => {
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => store.claim(exactIntent("intent-claimed")))
    );

    expect(claims.filter((claim) => claim.inserted)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.intent.id))).toEqual(new Set(["intent-claimed"]));
    expect((await store.claim(exactIntent("intent-claimed"))).inserted).toBe(false);
  });

  it("admits one of many parallel claims for a payer, across separate pools", async () => {
    const otherPool = new pg.Pool({ connectionString: DATABASE_URL });
    const stores = [store, new PostgresX402ExactSettlementStore(otherPool)];
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) =>
          stores[i % 2].claim(exactIntent(`intent-race-${i}`, undefined, PAYER_A, i), {
            maxOutstandingPerPayer: 1,
          })
        )
      );
      const admitted = outcomes.filter((o) => o.status === "fulfilled");
      const refused = outcomes.filter((o) => o.status === "rejected");
      expect(admitted).toHaveLength(1);
      expect(refused).toHaveLength(7);
      for (const o of refused) {
        expect((o as PromiseRejectedResult).reason).toBeInstanceOf(X402ExactPayerLimitError);
      }
      const { rows } = await pool.query(
        "SELECT count(*)::int AS n FROM x402_exact_settlement_intents WHERE dvm_id = $1",
        [DVM_ID]
      );
      expect(rows[0].n).toBe(1);
    } finally {
      await otherPool.end();
    }
  });

  it("does not let one payer's cap block another payer", async () => {
    await store.claim(exactIntent("intent-a", undefined, PAYER_A, 1), { maxOutstandingPerPayer: 1 });
    await expect(
      store.claim(exactIntent("intent-a2", undefined, PAYER_A, 2), { maxOutstandingPerPayer: 1 })
    ).rejects.toBeInstanceOf(X402ExactPayerLimitError);
    const b = await store.claim(exactIntent("intent-b", undefined, PAYER_B, 3), {
      maxOutstandingPerPayer: 1,
    });
    expect(b.inserted).toBe(true);
  });

  it("treats a replay of an admitted authorization as a replay, not a second outstanding one", async () => {
    await store.claim(exactIntent("intent-a", undefined, PAYER_A, 1), { maxOutstandingPerPayer: 1 });
    const replay = await store.claim(exactIntent("intent-a", undefined, PAYER_A, 1), {
      maxOutstandingPerPayer: 1,
    });
    expect(replay.inserted).toBe(false);
  });

  it("stops counting an authorization once it is past valid_before or released", async () => {
    const expired = { ...exactIntent("intent-old", undefined, PAYER_A, 1), validBefore: "1000" };
    await store.claim(expired, { maxOutstandingPerPayer: 1 });
    await store.claim(exactIntent("intent-new", undefined, PAYER_A, 2), {
      maxOutstandingPerPayer: 1,
    });
    await expect(
      store.claim(exactIntent("intent-third", undefined, PAYER_A, 3), { maxOutstandingPerPayer: 1 })
    ).rejects.toBeInstanceOf(X402ExactPayerLimitError);
    await store.release({ dvmId: DVM_ID, intentId: "intent-new", reason: "test" });
    expect(
      (
        await store.claim(exactIntent("intent-third", undefined, PAYER_A, 3), {
          maxOutstandingPerPayer: 1,
        })
      ).inserted
    ).toBe(true);
  });

  it("stops counting a submitted or ambiguous authorization once it is past valid_before", async () => {
    const options = { maxOutstandingPerPayer: 1 };
    const submitted = { ...exactIntent("intent-submitting", undefined, PAYER_A, 1), validBefore: "1000" };
    await store.claim(submitted, options);
    await store.markSubmitting({ dvmId: DVM_ID, intentId: "intent-submitting" });
    const ambiguous = exactIntent("intent-ambiguous", undefined, PAYER_B, 2);
    await store.claim(ambiguous, options);
    await store.markSubmitting({ dvmId: DVM_ID, intentId: "intent-ambiguous" });
    await store.recordOutcome({
      dvmId: DVM_ID,
      intentId: "intent-ambiguous",
      status: "ambiguous",
      outcome: "timeout",
    });

    // The submitting row expired long ago; the ambiguous one can still settle.
    expect(
      (await store.claim(exactIntent("intent-next-a", undefined, PAYER_A, 3), options)).inserted
    ).toBe(true);
    await expect(
      store.claim(exactIntent("intent-next-b", undefined, PAYER_B, 4), options)
    ).rejects.toBeInstanceOf(X402ExactPayerLimitError);
  });

  it("retires only a submitted or ambiguous intent as unused, leaving release prepared-only", async () => {
    await store.prepare(exactIntent("intent-prepared", undefined, PAYER_A, 1));
    await store.prepare(exactIntent("intent-ambiguous", undefined, PAYER_A, 2));
    await store.markSubmitting({ dvmId: DVM_ID, intentId: "intent-ambiguous" });
    await store.recordOutcome({
      dvmId: DVM_ID,
      intentId: "intent-ambiguous",
      status: "ambiguous",
      outcome: "timeout",
    });
    await settledIntent(store, "intent-settled", undefined);
    const expire = (intentId: string) =>
      store.expireUnused?.({ dvmId: DVM_ID, intentId, reason: "authorization_expired_unused" });

    expect(await expire("intent-prepared")).toBe(false);
    expect(await expire("intent-settled")).toBe(false);
    expect(await expire("intent-ambiguous")).toBe(true);
    expect(await expire("intent-ambiguous")).toBe(false);

    expect(await store.get(DVM_ID, "intent-ambiguous")).toMatchObject({
      status: "rejected",
      lastOutcome: "authorization_expired_unused",
    });
    expect((await store.get(DVM_ID, "intent-prepared"))?.status).toBe("prepared");
    expect((await store.get(DVM_ID, "intent-settled"))?.status).toBe("settled");
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

const PAYER_A = "0x2222222222222222222222222222222222222222";
const PAYER_B = "0x5555555555555555555555555555555555555555";

function exactIntent(
  intentId: string,
  effect?: Parameters<PostgresX402ExactSettlementStore["prepare"]>[0]["effect"],
  from = PAYER_A,
  nonceSeed?: number
): Parameters<PostgresX402ExactSettlementStore["prepare"]>[0] {
  return {
    id: intentId,
    dvmId: DVM_ID,
    resource: "/v1/job",
    network: "eip155:8453",
    asset: "0x1111111111111111111111111111111111111111",
    from,
    to: "0x3333333333333333333333333333333333333333",
    value: "1000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce:
      nonceSeed === undefined
        ? `0x${"44".repeat(32)}`
        : `0x${nonceSeed.toString(16).padStart(64, "0")}`,
    fingerprint: "fingerprint",
    effect,
  };
}
