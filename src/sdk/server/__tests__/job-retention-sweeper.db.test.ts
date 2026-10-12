import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { JobRecord, JobStatus } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const OLD = Date.now() - 200_000;

function record(id: string, status: JobStatus = "completed"): JobRecord {
  return {
    id,
    tags: ["private"],
    capability: "test",
    input: "caller secret",
    params: { prompt: "private" },
    requesterId: "caller-1",
    requesterTokenHash: "hash",
    requesterToken: "clear-token",
    requestFingerprint: "fingerprint",
    requesterPubkey: "ab".repeat(32),
    requestId: `request-${id}`,
    authRequestPath: "/v1/job",
    status,
    summary: "private result",
    messages: [
      {
        seq: 1,
        from: "provider",
        type: "text",
        timestamp: 1,
        content: { text: "private output" },
      },
    ],
    seq: 1,
    paidMsats: 21_000,
    paymentMint: "https://mint.example",
    paymentRail: "cashu",
    paymentTxHash: `tx-${id}`,
    nativeAmount: 21,
    nativeAsset: "sats",
    creditId: `credit-${id}`,
    drawId: `draw-${id}`,
    receivedProofs: [{ amount: 1, id: "proof", secret: "secret", C: "C" }],
    pendingPaymentMsats: 10,
    pendingMppChallengeIds: ["challenge"],
    pendingX402Nonce: `0x${"01".repeat(32)}`,
    pendingX402AmountUsdcMicro: "10",
    pendingPaymentFiatMicro: 10,
    pendingPaymentFiatCurrency: "usd",
    stepCache: [{ id: "step", value: "private" }],
    state: { private: true },
    createdAt: OLD,
    lastActivityAt: OLD,
  };
}

describe.skipIf(!RUN)("job-record retention (Postgres)", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM request_id_claims");
    await pool.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keyset-paginates only expired, terminal, matching-capability rows", async () => {
    for (const id of ["a", "b", "c"]) await store.save(record(id));
    await store.save({ ...record("sibling"), capability: "other" });
    await store.save(record("running", "processing"));
    await store.save({ ...record("fresh"), lastActivityAt: Date.now() });

    const first = await store.listJobsForRetention({
      lastActivityBeforeMs: Date.now() - 1_000,
      limit: 2,
      capabilities: ["test"],
    });
    expect(first.map((job) => job.id)).toEqual(["a", "b"]);
    const second = await store.listJobsForRetention({
      lastActivityBeforeMs: Date.now() - 1_000,
      limit: 2,
      capabilities: ["test"],
      after: { lastActivityAt: first[1].lastActivityAt, id: first[1].id },
    });
    expect(second.map((job) => job.id)).toEqual(["c"]);
  });

  it("redacts content, preserves accounting evidence, and cannot be rehydrated", async () => {
    const original = record("expired");
    await store.save(original);
    const receipt = {
      v: 1,
      job_id: "expired",
      dvm_id: "dvm-1",
      dvm: "test",
      capability: "test",
      outcome: "completed",
      reason: null,
      seq: 1,
      issued_at: 1,
      requester_pubkey: original.requesterPubkey,
      paid: {
        msats: 21_000,
        rail: "cashu",
        native_amount: 21,
        native_asset: "sats",
        tx_hash: "tx-expired",
        mint: "https://mint.example",
      },
      result_hash: "hash",
      receipt_pubkey: "22".repeat(32),
      signature: "33".repeat(64),
    };
    await pool.query("UPDATE jobs SET receipt = $2::jsonb, receipt_seq = 1 WHERE id = $1", [
      "expired",
      JSON.stringify(receipt),
    ]);

    const redactedAt = Date.now();
    expect(
      await store.redactJob({
        jobId: "expired",
        expectedLastActivityAt: OLD,
        redactedAt,
      })
    ).toBe(true);
    expect(
      await store.redactJob({
        jobId: "expired",
        expectedLastActivityAt: OLD,
        redactedAt: redactedAt + 1,
      })
    ).toBe(false);

    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT * FROM jobs WHERE id = 'expired'"
    );
    expect(rows[0]).toMatchObject({
      input: "",
      params: {},
      summary: null,
      messages: [],
      received_proofs: [],
      step_cache: [],
      state: {},
      requester_id: "caller-1",
      requester_token_hash: "hash",
      requester_pubkey: "ab".repeat(32),
      request_id: "request-expired",
      status: "completed",
      paid_msats: "21000",
      payment_rail: "cashu",
      payment_tx_hash: "tx-expired",
      credit_id: "credit-expired",
      draw_id: "draw-expired",
      receipt,
      redacted_at: String(redactedAt),
    });
    expect(rows[0].requester_token).toBeNull();
    expect(rows[0].request_fingerprint).toBeNull();
    expect(rows[0].auth_request_path).toBeNull();
    expect(rows[0].pending_payment_msats).toBeNull();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await store.save(original);
    } finally {
      warn.mockRestore();
    }
    expect((await store.get("expired"))?.input).toBe("");
    expect((await store.get("expired"))?.receipt).toEqual(receipt);
    await expect(
      store.appendOutgoing("expired", {
        from: "provider",
        type: "text",
        timestamp: Date.now(),
        content: { text: "late private output" },
      })
    ).rejects.toThrow("not found");
    await expect(
      store.recordInbound("expired", {
        from: "requester",
        type: "text",
        timestamp: Date.now(),
        content: { text: "late caller secret" },
      })
    ).rejects.toThrow("not found");
    expect(
      await pool.query("SELECT data FROM job_messages WHERE job_id = $1", [original.id])
    ).toMatchObject({ rowCount: 0 });
  });

  it("rolls back redaction when streamed-message deletion fails", async () => {
    const original = record("atomic-failure");
    await store.save(original);
    await pool.query(
      `INSERT INTO job_messages (job_id, seq, data, status)
       VALUES ($1, 1, $2::jsonb, 'verified')`,
      [
        original.id,
        JSON.stringify({
          seq: 1,
          from: "caller",
          type: "text",
          timestamp: 1,
          content: { text: "streamed caller secret" },
        }),
      ]
    );
    await pool.query(`
      CREATE OR REPLACE FUNCTION fail_atomic_retention_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.job_id = 'atomic-failure' THEN
          RAISE EXCEPTION 'forced retention delete failure';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_atomic_retention_delete
        BEFORE DELETE ON job_messages
        FOR EACH ROW EXECUTE FUNCTION fail_atomic_retention_delete();
    `);

    try {
      await expect(
        store.redactJob({
          jobId: original.id,
          expectedLastActivityAt: OLD,
          redactedAt: Date.now(),
        })
      ).rejects.toThrow("forced retention delete failure");

      const retained = await store.get(original.id);
      expect(retained?.input).toBe("caller secret");
      expect(retained?.redactedAt).toBeUndefined();
      expect(
        await store.listJobsForRetention({
          lastActivityBeforeMs: Date.now() - 1_000,
          limit: 10,
          capabilities: ["test"],
        })
      ).toEqual([expect.objectContaining({ id: original.id })]);
      expect(
        await pool.query("SELECT data FROM job_messages WHERE job_id = $1", [original.id])
      ).toMatchObject({ rowCount: 1 });
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS fail_atomic_retention_delete ON job_messages");
      await pool.query("DROP FUNCTION IF EXISTS fail_atomic_retention_delete()");
    }
  });
});
