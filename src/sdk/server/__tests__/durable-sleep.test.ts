import { afterEach, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { createTestContext } from "../../testing";
import { createDVMServer } from "../app";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

afterEach(() => vi.useRealTimers());

it("rechecks the wall clock at one hour and retries the wake fence before continuing", async () => {
  vi.useFakeTimers();
  const start = Date.UTC(2026, 0, 1);
  vi.setSystemTime(start);
  const store = new MemoryJobStore();
  const end = store.endSleep.bind(store);
  const finish = vi.spyOn(store, "endSleep").mockRejectedValueOnce(new Error("store offline"))
    .mockImplementation(end);
  const manager = new JobManager(configureDVM({
    name: "timer-test",
    capability: "test",
    tag: "test",
    async onJob(ctx) {
      await ctx.sleep("period", 5_400_000, { hint: "Checking later" });
      ctx.text("woke");
    },
  }), { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher(),
    processingWatchdogMs: 0, staleJobTimeoutMs: 0 });

  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    manager.runHandler(job, manager.buildAndAttachContext(job, ""));
    await vi.advanceTimersByTimeAsync(0);
    expect(await store.get(job.id)).toMatchObject({
      status: "working", sleepId: "sleep:period", sleepUntilMs: start + 5_400_000,
      stepCache: [{ id: "sleep:period", value: { wake_at_ms: start + 5_400_000 } }],
    });
    expect((await store.getMessages(job.id, 0)).find((m) => m.type === "working")?.content).toEqual({
      estimate_seconds: 5400, wake_at_ms: start + 5_400_000, hint: "Checking later",
    });

    // The clock steps forward while the first timer is armed. A single 90-minute timer would miss wake.
    vi.setSystemTime(start + 1_800_000);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(await store.get(job.id)).toHaveProperty("sleepId", "sleep:period");
    expect((await store.getMessages(job.id, 0)).some((m) => m.type === "text")).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(finish).toHaveBeenCalledTimes(2);
    expect((await store.get(job.id))?.sleepUntilMs).toBeUndefined();
    expect((await store.getMessages(job.id, 0)).find((m) => m.type === "text")?.content).toEqual({ text: "woke" });
  } finally {
    manager.shutdown();
  }
});

it("rejects sleep while a prompt, payment ask or another sleep is pending", async () => {
  const store = new MemoryJobStore();
  const manager = new JobManager(configureDVM({
    name: "wait-test", capability: "test", tag: "test", onJob() {},
  }), { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher(), devMode: true });
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    const ctx = manager.buildAndAttachContext(job, "");
    const prompt = ctx.prompt("prompt", "Your choice?");
    await expect(ctx.sleep("during-prompt", 0)).rejects.toThrow("payment ask or prompt is open");
    await manager.dispatchMessage(job, "response", { prompt_id: "prompt", text: "go" });
    await prompt;

    const ask = ctx.requestPayment(10, "next step");
    const askRejected = expect(ask).rejects.toMatchObject({ name: "JobCancelledError" });
    await expect(ctx.sleep("during-ask", 0)).rejects.toThrow("payment ask or prompt is open");
    await expect.poll(() => job.pendingPayment).not.toBeNull();
    await manager.dispatchMessage(job, "cancel", { reason: "stop" });
    await askRejected;

    const other = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(other);
    const sleeping = manager.buildAndAttachContext(other, "");
    const first = sleeping.sleep("first", 60_000);
    const firstRejected = expect(first).rejects.toMatchObject({ name: "JobCancelledError" });
    await expect(sleeping.sleep("second", 0)).rejects.toThrow("sleep is pending");
    await manager.dispatchMessage(other, "cancel", { reason: "stop" });
    await firstRejected;
  } finally {
    manager.shutdown();
  }
});

it("records immediate sleeps in testing and reuses the original deadline with a shared step cache", async () => {
  vi.useFakeTimers();
  const stepCache = new StepCache();
  vi.setSystemTime(10_000);
  const ctx = createTestContext({ stepCache });
  await ctx.sleep("first", 120_000);
  await ctx.sleepUntil("second", new Date(210_000));
  expect(ctx.sleeps).toEqual([{ id: "first", wake_at_ms: 130_000 }, { id: "second", wake_at_ms: 210_000 }]);

  vi.setSystemTime(20_000);
  const replay = createTestContext({ stepCache });
  await replay.sleep("first", 120_000);
  expect(replay.sleeps).toEqual([{ id: "first", wake_at_ms: 130_000 }]);
  for (const value of [-1, Infinity, NaN]) {
    await expect(replay.sleep("invalid", value)).rejects.toThrow(RangeError);
  }
  for (const value of [Infinity, new Date(NaN)]) {
    await expect(replay.sleepUntil("invalid", value)).rejects.toThrow(RangeError);
  }

  const real = createTestContext({ sleep: "real" });
  const wait = real.sleepUntil("real", 90_000);
  const rejected = expect(wait).rejects.toMatchObject({ name: "JobCancelledError" });
  await vi.advanceTimersByTimeAsync(0);
  real.cancel();
  await rejected;
});

it("does not park if the working message cannot be appended to durable history", async () => {
  const store = new MemoryJobStore();
  const append = store.appendOutgoing.bind(store);
  vi.spyOn(store, "appendOutgoing").mockImplementation(async (id, msg, options) => {
    if (msg.type === "working") throw new Error("append unavailable");
    return append(id, msg, options);
  });
  const manager = new JobManager(configureDVM({
    name: "append-test", capability: "test", tag: "test",
    async onJob(ctx) {
      await ctx.sleep("wait", 60_000);
      ctx.text("woke");
    },
  }), { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher() });
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    manager.runHandler(job, manager.buildAndAttachContext(job, ""));
    await expect.poll(() => job.status).toBe("failed");
    expect((await store.get(job.id))?.sleepUntilMs).toBeUndefined();
    expect((await store.getMessages(job.id, 0)).some((m) => m.type === "working")).toBe(false);
  } finally {
    manager.shutdown();
  }
});

it("keeps the adopted memory job when a stale executor completes, fails or reaps it", async () => {
  const store = new MemoryJobStore();
  const manager = new JobManager(configureDVM({
    name: "terminal-fence-test", capability: "test", tag: "test", onJob() {},
  }), { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher() });
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    const now = Date.now();
    await store.beginSleep(job.id, { sleepId: "sleep:wait", wakeAtMs: now + 60_000, generation: 0 });
    await store.claimSleepingJob(job.id, now);
    const adopted = (await store.get(job.id))!;
    expect(adopted.sleepGeneration).toBe(1);
    const before = await store.getMessages(job.id, 0);

    await expect(store.appendOutgoing(job.id, {
      from: "provider", type: "complete", timestamp: Math.floor(now / 1000), content: { summary: "stale" },
    }, { sleepGeneration: 0 })).rejects.toMatchObject({ name: "JobSupersededError" });
    await expect(store.save({ ...adopted, status: "completed", sleepGeneration: 0 }))
      .rejects.toMatchObject({ name: "JobSupersededError" });
    await expect(store.failJob(job.id, "stale", 0)).rejects.toMatchObject({ name: "JobSupersededError" });
    await expect(store.declineJob(job.id, "stale", 0)).rejects.toMatchObject({ name: "JobSupersededError" });
    expect(await store.cancelStaleJob(job.id, Date.now(), "stale reaper", "failed",
      { generation: 0, parked: true })).toBe(false);
    expect(await store.cancelStaleJob(job.id, Date.now(), "was awake", "failed",
      { generation: 1, parked: false })).toBe(false);

    expect(await store.get(job.id)).toEqual(adopted);
    expect(await store.getMessages(job.id, 0)).toEqual(before);
    expect(await store.cancelJob(job.id, "Caller stopped the job")).toBe(true);
    expect((await store.get(job.id))?.status).toBe("cancelled");
  } finally {
    manager.shutdown();
  }
});

it("commits a caller DELETE after the memory executor parks and loses ownership", async () => {
  const store = new MemoryJobStore();
  const awake = Promise.withResolvers<void>();
  const park = Promise.withResolvers<void>();
  const options = { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher(), devMode: true };
  const descriptor = configureDVM({
    name: "caller-cancel-test", capability: "test", tag: "test",
    async onJob(ctx) {
      awake.resolve();
      await park.promise;
      await ctx.sleep("wait", 60_000);
    },
  });
  const original = await createDVMServer(descriptor, options);
  const replacement = await createDVMServer(descriptor, options);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const pause = vi.spyOn(store, "openPaymentIntentUntil").mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    return undefined;
  });
  try {
    const submit = await original.app.request("/v1/job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "" }),
    });
    expect(submit.status).toBe(202);
    const { job_id: id, job_token: token } = await submit.json() as { job_id: string; job_token: string };
    await awake.promise;
    const cancel = original.app.request(`/v1/job/${id}`, { method: "DELETE", headers: { "X-Job-Token": token } });
    await entered.promise;
    park.resolve();
    await expect.poll(() => store.get(id)).toMatchObject({ sleepId: "sleep:wait" });
    expect(await store.claimSleepingJob(id, Date.now())).toMatchObject({ sleepGeneration: 1 });
    const { job: adopted } = replacement.jobManager.reactivateJob((await store.get(id))!);
    expect(await store.beginSleep(id, { sleepId: "sleep:wait", wakeAtMs: Date.now() + 60_000, generation: 1 })).toBe(true);
    release.resolve();

    const response = await cancel;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cancelled" });
    expect(await store.get(id)).toMatchObject({ status: "cancelled", sleepGeneration: 1 });
    await expect.poll(() => adopted.abort.signal.aborted).toBe(true);
  } finally {
    pause.mockRestore();
    park.resolve();
    release.resolve();
    original.jobManager.shutdown();
    replacement.jobManager.shutdown();
  }
});

function probeManager(store: MemoryJobStore) {
  return new JobManager(configureDVM({ name: "sleep-fence-test", capability: "test", tag: "test", onJob() {} }),
    { env: {}, store: new MemoryKVStore(), jobStore: store, fxFetcher: createFxFetcher() });
}

it("cannot refresh an adopted sleeper with an adapter missing the fenced heartbeat", async () => {
  const store = new MemoryJobStore();
  const manager = probeManager(store);
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    const now = Date.now();
    await store.beginSleep(job.id, { sleepId: "sleep:test", wakeAtMs: now + 60_000, generation: 0 });
    expect(await store.claimSleepingJob(job.id, now, now - 100_000)).toMatchObject({ sleepGeneration: 1 });
    const oldActivity = (await store.get(job.id))!.lastActivityAt;
    Object.defineProperty(store, "heartbeatJobExecutors", { value: undefined });
    await manager.heartbeatActiveJobs().catch(() => undefined);
    expect((await store.get(job.id))?.lastActivityAt).toBe(oldActivity);
    expect("heartbeatActiveJobs" in store).toBe(false);
  } finally {
    manager.shutdown();
  }
});

it("still fences a re-park when a MemoryJobStore subclass awaits before save", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let park = false;
  class DelayedStore extends MemoryJobStore {
    override async save(record: import("../job-store").JobRecord) {
      if (park && (record.state as { phase?: string }).phase === "old") {
        entered.resolve();
        await release.promise;
      }
      return super.save(record);
    }
  }
  const store = new DelayedStore();
  const manager = probeManager(store);
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    const now = Date.now();
    await store.beginSleep(job.id, { sleepId: "sleep:test", wakeAtMs: now + 60_000, generation: 0 });
    expect(await store.claimSleepingJob(job.id, now)).toMatchObject({ sleepGeneration: 1 });
    const { sleepGeneration: _, ...snapshot } = (await store.get(job.id))!;
    park = true;
    const staleSave = store.saveSleepSnapshot({ ...snapshot, status: "working", state: { phase: "old" } }, 1).catch(() => false);
    await entered.promise;
    expect(await store.claimSleepingJob(job.id, Date.now())).toMatchObject({ sleepGeneration: 2 });
    await store.save({ ...(await store.get(job.id))!, state: { phase: "new" } });
    release.resolve();
    await expect(staleSave).resolves.toBe(false);
    expect(await store.get(job.id)).toMatchObject({ sleepGeneration: 2, state: { phase: "new" } });
  } finally {
    release.resolve();
    manager.shutdown();
  }
});

it.each(["cancel", "decline"] as const)("dispatches a trusted caller %s even if the supplied executor was retired", async type => {
  const store = new MemoryJobStore();
  const manager = probeManager(store);
  try {
    const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0 }, undefined, "test");
    await manager.persistJob(job);
    const now = Date.now();
    await store.beginSleep(job.id, { sleepId: "sleep:test", wakeAtMs: now + 60_000, generation: 0 });
    expect(await store.claimSleepingJob(job.id, now)).toMatchObject({ sleepGeneration: 1 });
    await manager.heartbeatActiveJobs();
    expect(job.superseded).toBe(true);
    if (type === "decline") {
      await store.appendOutgoing(job.id, {
        from: "provider", type: "prompt", timestamp: 1, content: { id: "check", text: "Continue?" },
      }, { awaitingInput: true, sleepGeneration: 1 });
    }
    await manager.dispatchMessage(job, type, { reason: "Caller requested stop" });
    expect(await store.get(job.id)).toMatchObject({ status: "cancelled", sleepGeneration: 1 });
  } finally {
    manager.shutdown();
  }
});
