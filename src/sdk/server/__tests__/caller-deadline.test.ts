import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import fixture from "../../../../protocol-fixtures/caller-deadline-v1.json";
import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

const START = 1700000000000;
const managers: { shutdown(): void | Promise<void> }[] = [];
function manager(onJob: (ctx: SDKJobContext<unknown, unknown>) => Promise<void>, idleTimeout = 3, store = new MemoryJobStore()) {
  const jm = new JobManager(configureDVM({ name: "deadline", capability: "test", idleTimeout, onJob }), {
    env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
    fxFetcher: createFxFetcher(), staleJobTimeoutMs: 1, heartbeatIntervalMs: 0,
    staleJobSweepIntervalMs: 100000, processingWatchdogMs: 1000,
  });
  managers.push(jm);
  return { jm, store };
}
async function start(jm: ReturnType<typeof manager>["jm"]) {
  const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
  const ctx = jm.buildAndAttachContext(job, "");
  await jm.persistJob(job);
  jm.runHandler(job, ctx);
  await vi.advanceTimersByTimeAsync(0);
  return job;
}
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(async () => {
  for (const jm of managers.splice(0)) await jm.shutdown();
  vi.useRealTimers();
});

describe("caller deadlines", () => {
  it("allows work and progress beyond idleTimeout", async () => {
    const { jm } = manager(async (ctx) => {
      for (let i = 0; i < 6; i++) { await delay(500); ctx.progress(i / 6); }
      ctx.complete("done");
    }, 1);
    const job = await start(jm);
    // Also exercise the defensive timer entry point used by recovery.
    jm.startIdleTimer(job);
    await vi.advanceTimersByTimeAsync(3000);
    expect(job.status).toBe("completed");
    expect(job.messages.filter((m) => m.type === "progress")).toHaveLength(6);
    expect(job.messages.some((m) => m.type === "cancel")).toBe(false);
  });

  it.each(["prompt", "payment-request"] as const)("stamps %s at emission and ignores unrelated input", async (type) => {
    const { jm, store } = manager(async (ctx) => {
      await delay(2500);
      if (type === "prompt") await ctx.prompt("q1", "Continue?", { options: fixture.prompt.options });
      else await ctx.requestPayment(1000, "Next block");
      ctx.complete("done");
    });
    const job = await start(jm);
    await vi.advanceTimersByTimeAsync(2500);
    const ask = job.messages.find((m) => m.type === type)!;
    if (type === "prompt") expect(ask.content).toEqual(fixture.prompt);
    else expect(ask.content).toMatchObject(fixture.payment_request);
    await vi.advanceTimersByTimeAsync(2000);
    const seq = await jm.recordInboundPending(job, "text", { text: "still thinking" });
    await jm.markInboundVerified(job.id, seq);
    await jm.dispatchMessage(job, "text", { text: "still thinking" });
    await jm.persistJob(job);
    expect(job.status).toBe("awaiting-input");
    expect(await jm.sweepStaleJobs()).toEqual({ swept: 0 });
    // Bypass the manager to exercise the store's last-line expiry guard.
    expect(await store.cancelStaleJob(job.id, Date.now(), "stale", "cancelled")).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(job.status).toBe("awaiting-input");
    expect(ask.content).toHaveProperty("expires_at_ms", fixture.prompt.expires_at_ms);
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe("cancelled");
    expect((await store.get(job.id))?.endedBy).toBe("caller");
  });

  it("stops the answered prompt's timer while work resumes", async () => {
    const { jm } = manager(async (ctx) => {
      await ctx.prompt("q1", "Continue?");
      await delay(4000);
      ctx.complete("done");
    });
    const job = await start(jm);
    await vi.advanceTimersByTimeAsync(2000);
    const content = { prompt_id: "q1", text: "yes" };
    const seq = await jm.recordInboundPending(job, "response", content);
    await jm.markInboundVerified(job.id, seq);
    await jm.dispatchMessage(job, "response", content);
    await vi.advanceTimersByTimeAsync(4000);
    expect(job.status).toBe("completed");
  });

  it("does not cancel an answered stamped turn between verification and dispatch", async () => {
    const { jm, store } = manager(async (ctx) => { await ctx.prompt("q1", "Continue?"); ctx.complete("done"); });
    const job = await start(jm);
    jm.clearIdleTimer(job.id);
    vi.setSystemTime(START + 3001);
    const content = { prompt_id: "q1", text: "yes" };
    const seq = await jm.recordInboundPending(job, "response", content);
    await jm.markInboundVerified(job.id, seq);
    expect(await store.cancelStaleJob(job.id, Date.now(), "stale", "cancelled")).toBe(false);
    await jm.dispatchMessage(job, "response", content);
    await vi.advanceTimersByTimeAsync(0);
    expect(job.status).toBe("completed");
  });

  it("keeps the processing watchdog active after an answered stamped prompt", async () => {
    const { jm, store } = manager(async (ctx) => {
      await ctx.prompt("q1", "Continue?");
      await delay(4000);
      ctx.complete("done");
    });
    const job = await start(jm);
    const content = { prompt_id: "q1", text: "yes" };
    const seq = await jm.recordInboundPending(job, "response", content);
    await jm.markInboundVerified(job.id, seq);
    await jm.dispatchMessage(job, "response", content);
    await jm.persistJob(job);
    // Heartbeats are disabled in this harness to model a dead worker.
    await vi.advanceTimersByTimeAsync(1001);
    expect(await jm.sweepStaleJobs()).toEqual({ swept: 1 });
    expect((await store.get(job.id))?.status).toBe("failed");
    expect((await store.get(job.id))?.endedBy).toBe("provider");
  });

  it("stops the payment timer after verified payment resumes work", async () => {
    const { jm } = manager(async (ctx) => {
      await ctx.requestPayment(1000, "Next block");
      await delay(4000);
      ctx.complete("done");
    });
    const job = await start(jm);
    await vi.advanceTimersByTimeAsync(2000);
    const body = { type: "payment" as const, content: { amount_msats: 1000 } };
    const seq = await jm.recordInboundPending(job, body.type, body.content);
    const outcome = await jm.processPayment(job, body, seq, { lockPubkeys: [] });
    expect(outcome.error).toBeUndefined();
    await jm.dispatchMessage(job, body.type, body.content);
    await vi.advanceTimersByTimeAsync(4000);
    expect(job.status).toBe("completed");
  });

  it("retains the remaining prompt's original deadline after another answer", async () => {
    const { jm } = manager(async (ctx) => {
      const first = ctx.prompt("first", "First?");
      await delay(1000);
      const second = ctx.prompt("second", "Second?");
      await Promise.all([first, second]);
      ctx.complete("done");
    });
    const job = await start(jm);
    await vi.advanceTimersByTimeAsync(2000);
    const content = { prompt_id: "first", text: "yes" };
    const seq = await jm.recordInboundPending(job, "response", content);
    await jm.markInboundVerified(job.id, seq);
    await jm.dispatchMessage(job, "response", content);
    await vi.advanceTimersByTimeAsync(1999);
    expect(job.status).toBe("awaiting-input");
    await vi.advanceTimersByTimeAsync(1);
    expect(job.status).toBe("cancelled");
  });

  it("emits a new charge after replaying a paid ask and an answered prompt", async () => {
    const handler = async (ctx: SDKJobContext<unknown, unknown>) => {
      await ctx.requestPayment(1000, "First block");
      await ctx.prompt("continue", "Continue?");
      await ctx.requestPayment(2000, "Second block");
      ctx.complete("done");
    };
    const { jm, store } = manager(handler);
    const job = await start(jm);
    await vi.advanceTimersByTimeAsync(2000);
    const body = { type: "payment" as const, content: { amount_msats: 1000 } };
    const paidSeq = await jm.recordInboundPending(job, body.type, body.content);
    expect((await jm.processPayment(job, body, paidSeq, { lockPubkeys: [] })).error).toBeUndefined();
    await jm.dispatchMessage(job, body.type, body.content);
    await vi.advanceTimersByTimeAsync(0);
    await jm.persistJob(job);
    jm.shutdown();
    await store.shutdownStreaming();
    await vi.advanceTimersByTimeAsync(2000);
    const recovered = manager(handler, 3, store).jm;
    const record = (await store.get(job.id))!;
    record.messages = await store.getMessages(job.id, 0);
    const { job: replay, sdkCtx } = recovered.reactivateJob(record);
    const response = { prompt_id: "continue", text: "yes" };
    const seq = await recovered.recordInboundPending(replay, "response", response);
    await recovered.markInboundVerified(job.id, seq);
    await store.claimForProcessing(job.id);
    replay.replayHighSeq = replay.seq;
    replay.replayProviderSkip = replay.messages.filter((m) => m.from === "provider" && m.type !== "payment-request").length;
    recovered.runHandler(replay, sdkCtx);
    await vi.advanceTimersByTimeAsync(0);
    const asks = replay.messages.filter((m) => m.type === "payment-request");
    expect(asks).toHaveLength(2);
    expect(asks[1].content).toMatchObject({ amount_msats: 2000, reason: "Second block", expires_at_ms: START + 7000 });
    await vi.advanceTimersByTimeAsync(2999);
    expect(replay.status).toBe("awaiting-input");
    await vi.advanceTimersByTimeAsync(1);
    expect(replay.status).toBe("cancelled");
  });

  it.each(["prompt", "payment-request"] as const)("replays an unanswered %s without extending its deadline", async (type) => {
    const handler = async (ctx: SDKJobContext<unknown, unknown>) => {
      if (type === "prompt") await ctx.prompt("q1", "Continue?");
      else await ctx.requestPayment(1000, "Next block");
      ctx.complete("done");
    };
    const { jm, store } = manager(handler);
    const job = await start(jm);
    const original = structuredClone(job.messages.find((m) => m.type === type)!);
    await jm.persistJob(job);
    await jm.shutdown();
    await vi.advanceTimersByTimeAsync(2000);
    const recovered = manager(handler, 3, store).jm;
    const record = (await store.get(job.id))!;
    record.messages = await store.getMessages(job.id, 0);
    const { job: replay, sdkCtx } = recovered.reactivateJob(record);
    await store.claimForProcessing(job.id);
    replay.replayHighSeq = replay.seq;
    replay.replayProviderSkip = replay.messages.filter((m) => m.from === "provider" && m.type !== "payment-request").length;
    recovered.runHandler(replay, sdkCtx);
    await vi.advanceTimersByTimeAsync(0);
    expect(replay.messages.filter((m) => m.type === type)).toEqual([original]);
    expect(await recovered.sweepStaleJobs()).toEqual({ swept: 0 });
    await vi.advanceTimersByTimeAsync(999);
    expect(replay.status).toBe("awaiting-input");
    await vi.advanceTimersByTimeAsync(1);
    expect(replay.status).toBe("cancelled");
  });
});
