import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryJobStore } from "../server/memory-job-store";
import { MemoryKVStore } from "../store";

/**
 * A seeded anonymous job carries per-job token hash exactly as a
 * live row does — refuses a credential-less write before ownership is
 * evaluated, so a cross-machine pay has to present the token the caller holds.
 */
const SEEDED_JOB_TOKEN = "seeded-job-token";
const SEEDED_JOB_TOKEN_HASH = createHash("sha256").update(SEEDED_JOB_TOKEN).digest("hex");

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

function tick(ms = 30): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

// a paid job whose handler suspends at `ctx.requestPayment` and is
// then resumed on a different machine (i.e. `activeJobs` doesn't hold it) must
// run `processPayment` through `reactivateJob` *before* the handler replays.
// The replay in `context.ts:requestPayment` resolves the payment-message
// positionally from the message log, so if the credit doesn't land first
// `paidMsats` stays at zero and the handler runs unpaid work until the
// 120s idle timer cancels it.
describe("Pattern A reactivation — payment credit", () => {
  const servers = servedApps();

  it("credits paidMsats before the handler replays past requestPayment", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "PayAndComplete",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        await ctx.requestPayment(1_000, "fee");
        ctx.complete("paid");
      },
    });

    const { app, jobManager } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const baseUrl = await servers.serve(app);

    // Create the job — handler yields at `requestPayment`.
    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    await tick();

    const record = await jobStore.get(job_id);
    expect(record?.status).toBe("awaiting-input");
    expect(record?.pendingPaymentMsats).toBe(1_000);

    // Simulate cross-machine resume: evict from the receiving machine's
    // `activeJobs`, forcing `handlePostMessage` to take the reactivation path.
    jobManager.activeJobs.delete(job_id);

    // Post the payment.
    const msgBody = JSON.stringify({
      type: "payment",
      content: { cashu_token: "fake-token", amount_msats: 1_000 },
    });
    const msgRes = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    expect(msgRes.status).toBe(201);
    await tick();

    // Credit must have landed via `processPayment` (devMode path), not just
    // satisfied the replay's positional resolver. `paidMsats === 0` here is
    // the original symptom: replay resolved, handler ran, but no
    // credit was recorded.
    const finalRecord = await jobStore.get(job_id);
    expect(finalRecord?.paidMsats).toBe(1_000);
    expect(finalRecord?.status).toBe("completed");
    expect(finalRecord?.summary).toBe("paid");
  });

  it("surfaces a payment rejection as 402 without invoking the handler", async () => {
    const jobStore = new MemoryJobStore();
    let secondPhaseEntered = false;

    const descriptor = configureDVM({
      name: "PayReject",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        await ctx.requestPayment(1_000, "fee");
        secondPhaseEntered = true;
        ctx.complete("paid");
      },
    });

    const { app, jobManager } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const baseUrl = await servers.serve(app);

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    await tick();

    jobManager.activeJobs.delete(job_id);

    // Stub `processPayment` to return a 402-shaped rejection — verifies the
    // reactivation path surfaces it cleanly without running the handler.
    const processPaymentSpy = vi.spyOn(jobManager, "processPayment").mockResolvedValue({
      error: { body: { error: "wrong_lock_pubkey" }, status: 402 },
    });

    const msgRes = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "fake-token", amount_msats: 1_000 },
      }),
      job_token
    );
    expect(msgRes.status).toBe(402);
    expect(await msgRes.json()).toEqual({ error: "wrong_lock_pubkey" });
    expect(processPaymentSpy).toHaveBeenCalledTimes(1);

    await tick();
    expect(secondPhaseEntered).toBe(false);
    processPaymentSpy.mockRestore();
  });

  // Each reactivation builds a fresh ctx and walks the same call sequence again:
  // every paid ask resolves from its payment in the log, with no double-counting.
  it("re-derives the per-ctx counter on reactivation (invariant)", async () => {
    const jobStore = new MemoryJobStore();
    const observed: { paidMsats: number; pendingAt: string }[] = [];

    const descriptor = configureDVM({
      name: "PerCtxCounter",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        await ctx.requestPayment(3_000, "first");
        observed.push({ paidMsats: ctx.paidMsats, pendingAt: "after-first" });
        await ctx.requestPayment(2_000, "second");
        observed.push({ paidMsats: ctx.paidMsats, pendingAt: "after-second" });
        ctx.complete(`paid:${String(ctx.paidMsats)}`);
      },
    });

    const { app, jobManager } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const baseUrl = await servers.serve(app);

    // First yield: requestPayment(3_000).
    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    await tick();

    let record = await jobStore.get(job_id);
    expect(record?.status).toBe("awaiting-input");
    expect(record?.pendingPaymentMsats).toBe(3_000);

    jobManager.activeJobs.delete(job_id);

    // Pattern A reactivation: pay 3_000. Replay re-walks both
    // requestPayment calls; the first resolves positionally from the
    // payment in the log, the second yields fresh.
    await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "first-token", amount_msats: 3_000 },
      }),
      job_token
    );
    await tick();

    record = await jobStore.get(job_id);
    expect(record?.status).toBe("awaiting-input");
    expect(record?.pendingPaymentMsats).toBe(2_000);
    expect(record?.paidMsats).toBe(3_000);

    jobManager.activeJobs.delete(job_id);

    // Second Pattern A reactivation: pay 2_000. A fresh ctx re-walks both asks, each
    // resolved by its own payment.
    await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "second-token", amount_msats: 2_000 },
      }),
      job_token
    );
    await tick();

    record = await jobStore.get(job_id);
    expect(record?.status).toBe("completed");
    expect(record?.paidMsats).toBe(5_000);
    expect(record?.summary).toBe("paid:5000");
  });

  it("fails fast with [internal_error] if replay resolves without credit", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "ReplayWithoutCredit",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        await ctx.requestPayment(1_000, "fee");
        ctx.complete("paid");
      },
    });

    const { app, jobManager } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const res = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "" }),
    });
    const { job_id, job_token } = await res.json();
    await tick();

    jobManager.activeJobs.delete(job_id);

    // Accept the message without applying its credit, leaving the real payment
    // path to publish it. Replay must reject that inconsistent accounting state.
    const verifyAndCredit = jobStore.verifyAndCredit.bind(jobStore);
    const creditSpy = vi.spyOn(jobStore, "verifyAndCredit").mockImplementation(
      (jobId, seq) => verifyAndCredit(jobId, seq, null)
    );

    const msgRes = await app.request(`/v1/job/${job_id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Job-Token": job_token },
      body: JSON.stringify({
        type: "payment",
        content: { cashu_token: "fake-token", amount_msats: 1_000 },
      }),
    });
    expect(msgRes.status).toBe(201);
    await tick();

    // The handler's onError path runs in-memory but doesn't trigger a full
    // record persist for MemoryJobStore (unlike `complete`/`fail`, which
    // route through `onYield`). Inspect the in-memory job for the failed
    // status and the assertion message.
    const live = jobManager.activeJobs.get(job_id);
    expect(live?.status).toBe("failed");
    const cancelMsg = live?.messages.find((m) => m.type === "cancel");
    expect(cancelMsg).toBeDefined();
    expect((cancelMsg?.content as { reason?: string } | undefined)?.reason).toContain(
      "[internal_error] payment replay reached without credit"
    );
    creditSpy.mockRestore();
    jobManager.shutdown();
  });

  // When two machines race the cross-machine reactivation, the
  // lock-loser previously walked through `reactivateJob` (which adds to
  // `_activeJobs`, wires the appender, starts an idle timer) and then bailed
  // without tearing any of it down. 120s later its idle timer would fire,
  // write a `cancel` provider message via Tx A, and persist `status='cancelled'`
  // clobbering whatever the lock-winner had committed in the meantime.
  // Seed the snapshot directly so no in-process orphan handler races the test.
  it("tears down the in-memory scaffold when the reactivation lock is lost", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "LockLoserCleanup",
      capability: "test",
      tag: "test",
      // Handler body never runs in this test (lock-loss bails before
      // `runReactivation`). It exists only so the descriptor type-checks.
      onJob() {
        return;
      },
    });

    const { app, jobManager } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const baseUrl = await servers.serve(app);

    // Seed a suspended-at-requestPayment snapshot directly. No handler ever
    // ran on this process, so handlePostMessage takes the cross-machine path
    // and no orphan ctx can complete the job out from under the assertions.
    const job_id = "lock-loser-1";
    await jobStore.save({
      id: job_id,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "dev-anonymous",
      requesterTokenHash: SEEDED_JOB_TOKEN_HASH,
      status: "awaiting-input",
      messages: [],
      seq: 0,
      paidMsats: 0,
      pendingPaymentMsats: 1_000,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    // Force lock-loss; Tx C still lands (runs before the lock attempt) and
    // the lock-winner is expected to drive the reactivation. This machine
    // must tear down the scaffold it built in `reactivateJob`.
    const lockSpy = vi
      .spyOn(jobStore, "tryReactivationLock")
      .mockResolvedValue({ acquired: false });
    const clearIdleTimerSpy = vi.spyOn(jobManager, "clearIdleTimer");

    const msgRes = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "fake-token", amount_msats: 1_000 },
      }),
      SEEDED_JOB_TOKEN
    );
    expect(msgRes.status).toBe(201);
    await tick();

    // Scaffold gone: no orphan in activeJobs, idle timer was cleared.
    expect(jobManager.activeJobs.has(job_id)).toBe(false);
    expect(clearIdleTimerSpy).toHaveBeenCalledWith(job_id);

    // Lock-loser must not have persisted its in-memory snapshot. Status stays
    // `awaiting-input` (lock-winner is the only writer that should transition
    // it), and paid_msats reflects the Tx C credit that landed atomically
    // before the lock attempt.
    const record = await jobStore.get(job_id);
    expect(record?.status).toBe("awaiting-input");
    expect(record?.paidMsats).toBe(1_000);
    // No `cancel` provider message ever made it through Tx A from this side.
    const verifiedMsgs = await jobStore.getMessages(job_id, 0);
    expect(verifiedMsgs.some((m) => m.type === "cancel")).toBe(false);

    lockSpy.mockRestore();
    clearIdleTimerSpy.mockRestore();
  });
});

// dead-worker reactivation replay must reproduce the artifact. The
// PAP scenario: base `requestPayment` auto-credits from the upfront pool (no
// payment-request), the size surcharge yields a payment-request, then the
// caller pays and the original worker dies. The reactivating machine replays.
// `replayProviderSkip` used to be seeded from *all* provider messages, but the
// replay's surcharge `requestPayment` auto-credits (pool now covers it) and
// returns before re-emitting the payment-request — so the skip was never
// consumed and swallowed the next provider message: the artifact. The paid job
// then completed with no payload.
describe("Pattern A reactivation — replay skip accounting", () => {
  const servers = servedApps();

  it("dead-worker replay reproduces the artifact (skip excludes the replayed payment-requests)", async () => {
    const jobStore = new MemoryJobStore();
    const BASE = 8_000;
    const SURCHARGE = 2_000;

    let invocations = 0;
    const descriptor = configureDVM({
      name: "ScrapeLike",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        invocations++;
        await ctx.requestPayment(BASE, "base"); // paid on the original run
        await ctx.requestPayment(SURCHARGE, "size"); // yielded originally; paid cross-machine
        ctx.artifact({ data: "# scraped markdown", mime_type: "text/markdown" });
        ctx.complete("scraped");
      },
    });

    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
      reactivationClaimGraceMs: 20, // no live handler to claim; keep the test fast
    });
    const baseUrl = await servers.serve(app);

    // Seed a suspended-at-surcharge job directly — the original worker is gone,
    // so no live handler races the reactivation. Its durable history holds the
    // base ask, its payment and the surcharge ask; only payment-requests, which
    // replay never re-emits, are provider messages.
    const job_id = "scrape-dead-worker-1";
    await jobStore.save({
      id: job_id,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "dev-anonymous",
      requesterTokenHash: SEEDED_JOB_TOKEN_HASH,
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: 0,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
    const ask = (amount_msats: number, reason: string) => jobStore.appendOutgoing(job_id, {
      from: "provider", type: "payment-request", timestamp: Math.floor(Date.now() / 1000),
      content: { amount_msats, reason },
    }, { awaitingInput: true, pendingPaymentDelta: amount_msats });
    await ask(BASE, "base");
    const paidSeq = await jobStore.recordInbound(job_id, {
      from: "requester", type: "payment", timestamp: Math.floor(Date.now() / 1000),
      content: { cashu_token: "base-token", amount_msats: BASE },
    });
    await jobStore.verifyAndCredit(job_id, paidSeq, { paidMsatsDelta: BASE, clearPending: true });
    await ask(SURCHARGE, "size");

    // Pay the surcharge cross-machine. Tx C credits +SURCHARGE, then the
    // reactivation replays the handler: each ask resolves from its payment.
    const msgRes = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({
        type: "payment",
        content: { cashu_token: "fake-token", amount_msats: SURCHARGE },
      }),
      SEEDED_JOB_TOKEN
    );
    expect(msgRes.status).toBe(201);
    await tick(120);

    const record = await jobStore.get(job_id);
    expect(record?.status).toBe("completed");
    // The artifact survives into the terminal snapshot — the whole point.
    expect(record?.messages.some((m) => m.type === "artifact")).toBe(true);
    // paid_msats is exactly upfront + the one mid-job credit (no over-count).
    expect(record?.paidMsats).toBe(BASE + SURCHARGE);
    // Exactly one handler execution (the dead-worker replay). No double run.
    expect(invocations).toBe(1);
  });
});

// a message POST against a job that already reached a terminal status
// must return the structured two-audiences error (code + message + hint) rather
// than a bare `{ error }` string, so an intermediary agent can branch on the
// code and relay the hint instead of blindly re-paying into the 409.
describe("Terminal message POST — structured error", () => {
  const servers = servedApps();

  it("returns job_not_active with a GET hint on a completed job", async () => {
    const jobStore = new MemoryJobStore();
    const descriptor = configureDVM({
      name: "CompletesImmediately",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("done");
      },
    });

    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
    });
    const baseUrl = await servers.serve(app);

    const res = await postJson(
      `${baseUrl}/v1/job`,
      JSON.stringify({ capability: "test", input: "" })
    );
    const { job_id, job_token } = await res.json();
    await tick();
    expect((await jobStore.get(job_id))?.status).toBe("completed");

    const msgRes = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({ type: "text", content: { text: "late" } }),
      job_token
    );
    expect(msgRes.status).toBe(409);
    const body = await msgRes.json();
    expect(body.error).toBe("job_not_active");
    expect(typeof body.message).toBe("string");
    expect(body.hint).toMatch(/GET/);
  });
});
