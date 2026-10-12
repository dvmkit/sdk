/**
 * SQL replay lookup must preserve the accepted request's fingerprint, caller and returned job
 * token.
 */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { JobRecord, RequestIdClaim } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("findJobByPaymentTxHash", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM request_id_claims");
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  function record(id: string, requestId: string, overrides: Partial<JobRecord> = {}): JobRecord {
    return {
      id,
      tags: [],
      capability: "test",
      input: "hello",
      params: {},
      requesterId: "anonymous",
      requesterTokenHash: "hash-of-token",
      requesterToken: "token-plain",
      requestFingerprint: "fp-abc",
      requesterPubkey: "ab".repeat(32),
      authRequestPath: "/v1/request-resume/recover-1",
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: 100_000,
      paymentRail: "cashu",
      paymentTxHash: requestId,
      cashuFlow: "p2pk_accumulator",
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...overrides,
    };
  }

  it("round-trips the replay gate and the token the caller gets back", async () => {
    const requestId = randomUUID();
    await store.save(record("job-1260-1", requestId));

    const found = await store.findJobByPaymentTxHash(requestId);
    expect(found?.id).toBe("job-1260-1");
    expect(found?.requestFingerprint).toBe("fp-abc");
    expect(found?.requesterPubkey).toBe("ab".repeat(32));
    expect(found?.requesterToken).toBe("token-plain");
    expect(found?.authRequestPath).toBe("/v1/request-resume/recover-1");
  });

  it("returns undefined for a request id that paid for no job here", async () => {
    await store.save(record("job-1260-2", randomUUID()));
    expect(await store.findJobByPaymentTxHash(randomUUID())).toBeUndefined();
  });

  it("keeps the submission provenance when a later snapshot save lands", async () => {
    const requestId = randomUUID();
    const original = record("job-1260-3", requestId);
    await store.save(original);
    // The handler finishes and persists its snapshot. `toJobRecord` carries the
    // provenance, but the INSERT-only ON CONFLICT branch is what guarantees a
    // caller can still recover the job even if some future write path drops it.
    await store.save({
      ...original,
      status: "completed",
      summary: "done",
      requesterToken: undefined,
      requestFingerprint: undefined,
      requesterPubkey: undefined,
      authRequestPath: undefined,
    });

    const found = await store.findJobByPaymentTxHash(requestId);
    expect(found?.status).toBe("completed");
    expect(found?.requesterToken).toBe("token-plain");
    expect(found?.requestFingerprint).toBe("fp-abc");
    expect(found?.authRequestPath).toBe("/v1/request-resume/recover-1");
  });

  it("round-trips public recovery fields and uniquely binds one id per caller", async () => {
    const publicId = `public-${randomUUID()}`;
    const caller = "cd".repeat(32);
    await store.save(
      record("job-public-1", randomUUID(), {
        requesterPubkey: caller,
        requestId: publicId,
        paymentTransactionHash: `0x${"ab".repeat(32)}`,
      })
    );

    const found = await store.findJobByRequestId(publicId, caller);
    expect(found).toMatchObject({
      id: "job-public-1",
      requestId: publicId,
      paymentTransactionHash: `0x${"ab".repeat(32)}`,
    });
    await expect(
      store.save(
        record("job-public-2", randomUUID(), {
          requesterPubkey: caller,
          requestId: publicId,
        })
      )
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("atomically hands one concurrent request-id claim to exactly one caller", async () => {
    const base: Omit<RequestIdClaim, "claimToken"> = {
      requestId: `claim-${randomUUID()}`,
      requesterPubkey: "ef".repeat(32),
      requesterId: "anonymous",
      requestFingerprint: "fingerprint-1",
      jobId: `job-${randomUUID()}`,
    };
    const first = { ...base, claimToken: "claim-a" };
    const second = { ...base, claimToken: "claim-b" };
    const results = await Promise.all([store.claimRequestId(first), store.claimRequestId(second)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? first : second;
    await store.releaseRequestIdClaim(winner);
    const replay = { ...base, jobId: `ignored-${randomUUID()}`, claimToken: "claim-c" };
    await expect(store.claimRequestId(replay)).resolves.toEqual({
      jobId: base.jobId,
      replayed: true,
    });
    await store.releaseRequestIdClaim(replay);
  });

  it("never reopens a released id for a different fingerprint and stores no credential bytes", async () => {
    const claim: RequestIdClaim = {
      requestId: `safe-${randomUUID()}`,
      requesterPubkey: "12".repeat(32),
      requesterId: "anonymous",
      requestFingerprint: "safe-fingerprint",
      jobId: `job-${randomUUID()}`,
      claimToken: "owner-token",
    };
    expect(await store.claimRequestId(claim)).toEqual({ jobId: claim.jobId, replayed: false });
    await store.releaseRequestIdClaim(claim);
    expect(
      await store.claimRequestId({
        ...claim,
        requestFingerprint: "different-fingerprint",
        claimToken: "other-token",
      })
    ).toBeUndefined();

    const { rows } = await pool.query<Record<string, unknown>>(
      "SELECT * FROM request_id_claims WHERE requester_pubkey = $1 AND request_id = $2",
      [claim.requesterPubkey, claim.requestId]
    );
    const persisted = JSON.stringify(rows[0]);
    expect(Object.keys(rows[0]).sort()).toEqual([
      "created_at",
      "job_id",
      "request_fingerprint",
      "request_id",
      "requester_id",
      "requester_pubkey",
      "updated_at",
    ]);
    for (const secret of [
      "cashu-secret-proof",
      "x402-secret-credential",
      "tempo-secret-credential",
      "Bearer secret-token",
      "request-auth-signature",
    ]) {
      expect(persisted).not.toContain(secret);
    }
  });

  it("resume acquires only an existing exact binding and never creates one", async () => {
    const claim: RequestIdClaim = {
      requestId: `resume-${randomUUID()}`,
      requesterPubkey: "34".repeat(32),
      requesterId: "caller-34",
      requestFingerprint: "resume-fingerprint",
      jobId: `job-${randomUUID()}`,
      claimToken: "resume-owner",
    };

    expect(await store.resumeRequestId(claim)).toBeUndefined();
    expect(
      (
        await pool.query(
          "SELECT 1 FROM request_id_claims WHERE requester_pubkey = $1 AND request_id = $2",
          [claim.requesterPubkey, claim.requestId]
        )
      ).rowCount
    ).toBe(0);

    expect(await store.claimRequestId(claim)).toEqual({ jobId: claim.jobId, replayed: false });
    await store.releaseRequestIdClaim(claim);
    const resumed = { ...claim, jobId: "ignored-on-resume", claimToken: "resume-second" };
    expect(await store.resumeRequestId(resumed)).toEqual({ jobId: claim.jobId, replayed: true });
    await store.releaseRequestIdClaim(resumed);

    expect(
      await store.resumeRequestId({
        ...resumed,
        requestFingerprint: "wrong-fingerprint",
        claimToken: "resume-mismatch",
      })
    ).toBeUndefined();
  });
});
