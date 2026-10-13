/**
 * Independent servers/pools race live NOTIFY resume against paying-machine replay. Exactly one
 * handler must complete, with durable message sequences/artifacts and one payment credit.
 */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

function postJson(url: string, body: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Job-Token": token } : {}),
    },
    body,
  });
}

// Under full `test:db` load vitest's 5s default per-test timeout can fire before
// waitFor's own budget below does — this test runs two sequential NOTIFY-adjacent
// waits plus two full createDVMServer bring-ups in one it() block. Raise both
// together so the outer timeout does not preempt the test's own wait budget.
vi.setConfig({ testTimeout: 15_000 });

async function waitFor(
  predicate: () => Promise<boolean>,
  // The cross-machine NOTIFY round trip this covers (B pays -> pg_notify -> A's
  // suspended handler resumes -> terminal snapshot) can exceed 3s under full-suite
  // CI load. The predicate returns as soon as it is satisfied, so a higher
  // ceiling costs the passing case nothing.
  timeoutMs = 8000,
  pollMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("waitFor: condition not met within timeout");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

describe.skipIf(!RUN)("reactivation races the live handler", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let storeA: PostgresJobStore;
  let storeB: PostgresJobStore;
  const servers = servedApps();
  let shutdownA: (() => Promise<void>) | undefined;
  let shutdownB: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    storeA = new PostgresJobStore(poolA);
    storeB = new PostgresJobStore(poolB);
    await storeA.init();
    await storeA.initStreaming();
    await storeB.initStreaming();
  });

  afterEach(async () => {
    await servers.closeAll();
    await shutdownA?.();
    await shutdownB?.();
    shutdownA = shutdownB = undefined;
    await poolA.query("DELETE FROM job_messages");
    await poolA.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await storeA.shutdownStreaming();
    await storeB.shutdownStreaming();
    await poolA.end();
    await poolB.end();
  });

  it("exactly one handler execution completes the job, with the artifact (single-execution claim)", async () => {
    let invocations = 0;
    const descriptor = configureDVM({
      name: "ReactRace",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        invocations++;
        await ctx.requestPayment(5_000, "fee");
        ctx.artifact({ data: "# scraped markdown", mime_type: "text/markdown" });
        ctx.complete("scraped");
      },
    });

    // Machine A: hosts the live handler.
    const builtA = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: storeA,
      devMode: true,
    });
    shutdownA = builtA.shutdown;
    const urlA = await servers.serve(builtA.app);

    // Machine B: same descriptor, its own store/pool. Receives the payment.
    const builtB = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: storeB,
      devMode: true,
    });
    shutdownB = builtB.shutdown;
    const urlB = await servers.serve(builtB.app);

    // Create the job on A — the handler runs and suspends at requestPayment.
    const createRes = await postJson(
      `${urlA}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await createRes.json();
    await waitFor(async () => {
      const r = await storeA.get(job_id);
      return r?.status === "awaiting-input" && r.pendingPaymentMsats === 5_000;
    });

    // Pay on B. B has no live handler for this job → cross-machine reactivation.
    // A's suspended handler should wake via NOTIFY, win the claim, and drive the
    // job to completion; B should defer and stand down.
    const payRes = await postJson(
      `${urlB}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "fake-token", amount_msats: 5_000 },
      }),
      job_token
    );
    expect(payRes.status).toBe(201);

    await waitFor(async () => (await storeA.get(job_id))?.status === "completed");

    const record = await storeA.get(job_id);
    expect(record?.status).toBe("completed");
    // Single execution: A ran once (suspend + resume); B never replayed.
    expect(invocations).toBe(1);
    // The artifact survives into the terminal snapshot (the whole point).
    expect(record?.messages.some((m) => m.type === "artifact")).toBe(true);
    // paid_msats is exactly the one mid-job credit — no double-snapshot over-count.
    expect(record?.paidMsats).toBe(5_000);
    // B did not persist a competing terminal snapshot; the winner's stands.
    expect(record?.summary).toBe("scraped");

    const messages = record?.messages ?? [];
    // The caller's payment message was recorded via Tx B on machine B, which
    // never entered A's in-memory array. It must survive into the snapshot.
    const paymentMsg = messages.find((m) => m.type === "payment" && m.from === "requester");
    expect(paymentMsg).toBeDefined();
    // Every durably-recorded message, with its DB seq — no relabeling. The four
    // allocations (payment-request, caller payment, artifact, complete) are
    // contiguous and ascending, matching the DB `next_seq` numbering.
    expect(messages.map((m) => m.type)).toEqual([
      "payment-request",
      "payment",
      "artifact",
      "complete",
    ]);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
    // `next_seq` aligns with the surviving array (no forensic false-positive:
    // `next_seq - 1 === jsonb_array_length(messages)`).
    const { rows } = await poolA.query<{ next_seq: number }>(
      "SELECT next_seq FROM jobs WHERE id = $1",
      [job_id]
    );
    expect(rows[0].next_seq).toBe(messages.length + 1);

    // Cursor replay: a cursor taken just past the caller's own payment message
    // (DB seq 2), applied to the terminal job via a cross-machine read, returns
    // the artifact exactly once — no hole at the terminal boundary. Read from B
    // (no live handler there → the durable-snapshot read path).
    const paymentSeq = paymentMsg?.seq ?? 0;
    const replayRes = await fetch(`${urlB}/v1/job/${job_id}/messages?after=${paymentSeq}`, {
      headers: { "X-Job-Token": job_token },
    });
    const { messages: replayed } = await replayRes.json();
    expect(replayed.filter((m: { type: string }) => m.type === "artifact")).toHaveLength(1);
    expect(replayed.map((m: { seq: number }) => m.seq)).toEqual([3, 4]);
  });
});
