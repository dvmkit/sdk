import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { createDVMServer } from "../app";
import { JobManager } from "../job-manager";
import { fromJobRecord } from "../job";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { verifyReceipt } from "../../../lib/receipt";

const issuer = new ReceiptIssuer({ secret: "11".repeat(32), dvm: "evidence", dvmId: "test-dvm" });
function record(status: JobRecord["status"] = "processing"): JobRecord {
  return {
    id: "test-job",
    tags: [],
    capability: "work",
    input: "",
    params: {},
    requesterId: "test",
    status,
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: 1000,
    lastActivityAt: 1000,
  };
}
function descriptor(
  onJob: (ctx: SDKJobContext<unknown, { text: string }>) => void | Promise<void> = () => undefined,
  onPayment?: () => void
) {
  return configureDVM({
    name: "evidence",
    capability: "work",
    tag: "test",
    input: z.object({ text: z.string() }),
    onJob,
    onPayment,
  });
}
const managers: { shutdown(): void }[] = [];
function manager(
  store = new MemoryJobStore(),
  onJob?: Parameters<typeof descriptor>[0],
  onPayment?: () => void
) {
  const jm = new JobManager(descriptor(onJob, onPayment), {
    env: {},
    store: new MemoryKVStore(),
    jobStore: store,
    fxFetcher: {
      fetch: async () => ({ rates: { usd: 100000 }, as_of: "2026-01-01T00:00:00Z" }),
      supportedCurrencies: () => ["usd"],
    },
    devMode: true,
    receiptIssuer: issuer,
    staleJobTimeoutMs: 100,
    processingWatchdogMs: 100,
    heartbeatIntervalMs: 0,
  });
  managers.push(jm);
  return { jm, store };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const jm of managers.splice(0)) await jm.shutdown();
});

describe("SDK terminal attribution and timing", () => {
  it.each(["completed", "failed", "throw", "throw-prompt", "unknown"] as const)(
    "signs %s handler timing with provider failure attribution",
    async (path) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const { jm, store } = manager(undefined, (ctx) => {
        if (path === "completed") ctx.complete("done");
        else if (path === "failed") ctx.fail("failed");
        else {
          if (path === "throw-prompt") void ctx.prompt("question", "Continue?");
          throw new Error("thrown");
        }
      });
      await store.save(record());
      const job = fromJobRecord(record());
      if (path === "unknown") job.capability = "removed";
      vi.setSystemTime(1400);
      jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
      for (let i = 0; i < 20 && !job.terminalWork; i++) await Promise.resolve();
      await job.terminalWork;
      const receipt = (await store.get(job.id))?.receipt;
      expect(receipt?.timing).toEqual({
        accepted_at_ms: 1000,
        terminal_at_ms: 1400,
        caller_wait_ms: 0,
      });
      expect(receipt?.ended_by).toBe(path === "completed" ? undefined : "provider");
      expect(verifyReceipt(receipt!)).toBe(true);
    }
  );

  it.each([
    "cancel",
    "idle-processing",
    "idle-awaiting",
    "sweep-processing",
    "sweep-awaiting",
  ] as const)("attributes %s from the SDK terminal path", async (path) => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const awaiting = path.endsWith("awaiting");
    const { jm, store } = manager();
    const rec = record(awaiting ? "awaiting-input" : "processing");
    if (path === "idle-awaiting") {
      rec.messages = [{ seq: 1, from: "provider", type: "prompt", timestamp: 1,
        content: { id: "q", text: "Continue?", expires_at_ms: 1500 } }];
      rec.seq = 1;
    }
    await store.save(rec);
    const job = fromJobRecord((await store.get(rec.id))!);
    vi.setSystemTime(1500);
    if (path === "cancel") await jm.dispatchMessage(job, "cancel", { reason: "caller stopped" });
    else if (path.startsWith("idle")) {
      await jm.cancelJobIdle(job);
      await job.terminalWork;
    } else await jm.sweepStaleJobs();
    if (path === "idle-processing") {
      expect((await store.get(rec.id))?.status).toBe("processing");
      expect((await store.get(rec.id))?.receipt).toBeUndefined();
      return;
    }
    const receipt = (await store.get(rec.id))?.receipt;
    expect(receipt?.ended_by).toBe(path === "cancel" || awaiting ? "caller" : "provider");
    expect(receipt?.timing).toEqual({
      accepted_at_ms: 1000,
      terminal_at_ms: 1500,
      caller_wait_ms: awaiting ? 500 : 0,
    });
  });

  it("attributes DELETE to the caller through the HTTP route", async () => {
    const hosted = await createDVMServer(descriptor(), {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      devMode: true,
      dvmId: "test-dvm",
      receiptKey: "11".repeat(32),
    });
    try {
      const submit = await hosted.app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "work", data: { text: "" } }),
      });
      const body = (await submit.json()) as { job_id: string; job_token: string };
      const response = await hosted.app.request(`/v1/job/${body.job_id}`, {
        method: "DELETE",
        headers: { "X-Job-Token": body.job_token },
      });
      expect(response.status).toBe(200);
      const poll = await hosted.app.request(`/v1/job/${body.job_id}`, {
        headers: { "X-Job-Token": body.job_token },
      });
      expect(((await poll.json()) as { receipt: { ended_by: string } }).receipt.ended_by).toBe(
        "caller"
      );
    } finally {
      await hosted.shutdown();
    }
  });

  it("accumulates separate waits and preserves the committed terminal on another machine", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { jm, store } = manager();
    await store.save(record("awaiting-input"));
    vi.setSystemTime(1250);
    await store.claimForProcessing("test-job");
    vi.setSystemTime(1400);
    await store.save({ ...(await store.get("test-job"))!, status: "awaiting-input" });
    vi.setSystemTime(1700);
    await store.cancelJob("test-job", "done waiting");
    vi.setSystemTime(2500);
    await jm.finalizeStoredTerminal("test-job");
    const receipt = (await store.get("test-job"))!.receipt!;
    expect(receipt.timing).toEqual({
      accepted_at_ms: 1000,
      terminal_at_ms: 1700,
      caller_wait_ms: 550,
    });
    expect(receipt.ended_by).toBe("caller");
    await store.save({
      ...record("cancelled"),
      endedBy: "provider",
      terminalAtMs: 2500,
      callerWaitMs: 0,
    });
    expect((await store.get("test-job"))!.receipt).toEqual(receipt);
    expect((await store.get("test-job"))!.terminalAtMs).toBe(1700);
  });

  it.each(["dispatch", "notify"] as const)(
    "shares the payment resume claim when %s commits before its result returns",
    async (first) => {
      const callbacks = new Set<() => void>();
      const store = new MemoryJobStore();
      store.subscribeNotifications = async (_id, cb) => {
        callbacks.add(cb);
        return () => callbacks.delete(cb);
      };
      let executions = 0;
      let fallbackPayments = 0;
      const { jm } = manager(store, async (ctx) => {
        await ctx.requestPayment(1000, "fee");
        executions++;
        ctx.complete("paid");
      }, () => { fallbackPayments++; });
      const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
      await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
      await jm.persistJob(job);
      await store.save({ ...(await store.get(job.id))!, paidMsats: 1000, pendingPaymentMsats: undefined });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let committed!: () => void;
      const started = new Promise<void>((resolve) => { committed = resolve; });
      const claim = store.claimForProcessing.bind(store);
      const claims = vi.spyOn(store, "claimForProcessing").mockImplementation(async (id) => {
        const won = await claim(id);
        if (won) { committed(); await gate; }
        return won;
      });
      let dispatch: Promise<void>;
      if (first === "dispatch") {
        dispatch = jm.dispatchMessage(job, "payment", { amount_msats: 1000 });
        await started;
        for (const cb of callbacks) cb();
      } else {
        for (const cb of callbacks) cb();
        await started;
        dispatch = jm.dispatchMessage(job, "payment", { amount_msats: 1000 });
      }
      for (let i = 0; i < 30; i++) await Promise.resolve();
      release();
      await dispatch;
      expect(job.abort.signal.aborted).toBe(false);
      await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
      await job.terminalWork;
      expect(executions).toBe(1);
      expect(fallbackPayments).toBe(0);
      expect(job.abort.signal.aborted).toBe(false);
      expect((await store.get(job.id))?.status).toBe("completed");
      expect(claims).toHaveBeenCalledTimes(1);
    }
  );

  it("stands down when a different handler owns the payment resume claim", async () => {
    const callbacks = new Set<() => void>();
    const store = new MemoryJobStore();
    store.subscribeNotifications = async (_id, cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    };
    let resumed = false;
    const { jm } = manager(store, async (ctx) => {
      await ctx.requestPayment(1000, "fee");
      resumed = true;
      ctx.complete("duplicate");
    });
    const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
    await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
    await jm.persistJob(job);
    await store.save({ ...(await store.get(job.id))!, paidMsats: 1000, pendingPaymentMsats: undefined });
    await store.claimForProcessing(job.id);
    for (const cb of callbacks) cb();
    await vi.waitFor(() => expect(job.abort.signal.aborted).toBe(true));
    expect(resumed).toBe(false);
    expect(jm.activeJobs.has(job.id)).toBe(false);
    expect((await store.get(job.id))?.status).toBe("processing");
    expect((await store.get(job.id))?.receipt).toBeUndefined();
  });

  it.each(["separate", "simultaneous"] as const)(
    "resolves %s concurrent prompt answers and counts the remaining durable wait",
    async (delivery) => {
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const { jm, store } = manager(undefined, async (ctx) => {
        await Promise.all([ctx.prompt("a", "A?"), ctx.prompt("b", "B?")]);
        ctx.complete("both answered");
      });
      const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
      await jm.persistJob(job);
      now = 1500;
      if (delivery === "separate") {
        await jm.dispatchMessage(job, "response", { prompt_id: "a", text: "yes" });
        expect((await store.get(job.id))?.status).toBe("awaiting-input");
        now = 1900;
        await jm.dispatchMessage(job, "response", { prompt_id: "b", text: "yes" });
      } else {
        await Promise.all([
          jm.dispatchMessage(job, "response", { prompt_id: "a", text: "yes" }),
          jm.dispatchMessage(job, "response", { prompt_id: "b", text: "yes" }),
        ]);
      }
      await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
      await job.terminalWork;
      const durable = (await store.get(job.id))!;
      expect(durable.status).toBe("completed");
      expect(job.pendingPrompts.size).toBe(0);
      expect(durable.receipt?.timing).toEqual({
        accepted_at_ms: 1000,
        terminal_at_ms: now,
        caller_wait_ms: now - 1000,
      });
    }
  );

  it.each([
    { first: "prompt", overlap: false },
    { first: "payment", overlap: false },
    { first: "prompt", overlap: true },
    { first: "payment", overlap: true },
  ] as const)("serializes mixed input with $first first and overlap=$overlap", async ({ first, overlap }) => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const callbacks = new Set<() => void>();
    const store = new MemoryJobStore();
    store.subscribeNotifications = async (_id, cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    };
    let executions = 0;
    const { jm } = manager(store, async (ctx) => {
      await Promise.all([ctx.prompt("question", "Continue?"), ctx.requestPayment(1000, "fee")]);
      executions++;
      ctx.complete("answered and paid");
    });
    const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
    await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
    await jm.persistJob(job);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let committed!: () => void;
    const started = new Promise<void>((resolve) => { committed = resolve; });
    const claim = store.claimForProcessing.bind(store);
    let firstClaim = true;
    const claims = vi.spyOn(store, "claimForProcessing").mockImplementation(async (id) => {
      const won = await claim(id);
      if (won && firstClaim) {
        firstClaim = false;
        committed();
        if (overlap) await gate;
      }
      return won;
    });
    const prompt = () => jm.dispatchMessage(job, "response", { prompt_id: "question", text: "yes" });
    const notify = async () => {
      await store.save({ ...(await store.get(job.id))!, paidMsats: 1000, pendingPaymentMsats: undefined });
      for (const cb of callbacks) cb();
    };
    now = 1500;
    let response: Promise<void>;
    if (first === "prompt") {
      response = prompt();
      await started;
      if (!overlap) {
        await response;
        expect((await store.get(job.id))?.status).toBe("awaiting-input");
        now = 1900;
      }
      await notify();
    } else {
      await notify();
      await started;
      if (!overlap) {
        await vi.waitFor(() => expect(job.pendingPayment).toBeNull());
        await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe("awaiting-input"));
        now = 1900;
      }
      response = prompt();
    }
    for (let i = 0; i < 30; i++) await Promise.resolve();
    const abortedDuringOverlap = job.abort.signal.aborted;
    release();
    await response;
    expect(abortedDuringOverlap).toBe(false);
    await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
    await job.terminalWork;
    const durable = (await store.get(job.id))!;
    expect(executions).toBe(1);
    expect(job.abort.signal.aborted).toBe(false);
    expect(durable.status).toBe("completed");
    expect(durable.paidMsats).toBe(1000);
    expect(job.pendingPrompts.size).toBe(0);
    expect(job.pendingPayment).toBeNull();
    expect(claims).toHaveBeenCalledTimes(2);
    expect(durable.receipt?.timing).toEqual({
      accepted_at_ms: 1000,
      terminal_at_ms: now,
      caller_wait_ms: overlap ? 500 : 900,
    });
  });

  it.each(["dispatch", "notify"] as const)("retains mixed payment waits through a transient %s snapshot failure", async (delivery) => {
    const callbacks = new Set<() => void>();
    const store = new MemoryJobStore();
    store.subscribeNotifications = async (_id, cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    };
    let paymentResumes = 0;
    let executions = 0;
    const { jm } = manager(store, async (ctx) => {
      await Promise.all([
        ctx.prompt("question", "Continue?"),
        ctx.requestPayment(1000, "fee").then(() => { paymentResumes++; }),
      ]);
      executions++;
      ctx.complete("answered and paid");
    });
    const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
    await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
    await jm.persistJob(job);
    const pending = job.pendingPayment;
    const resolversDuringFailure: (typeof job.pendingPayment)[] = [];
    const seq = await store.recordInbound(job.id, {
      from: "requester", type: "payment", content: {}, timestamp: Date.now(),
    });
    await store.verifyAndCredit(job.id, seq, { paidMsatsDelta: 1000, clearPending: true });
    job.paidMsats = 1000;
    job.pendingPaymentMsats = undefined;
    const save = store.save.bind(store);
    let failures = 0;
    vi.spyOn(store, "save").mockImplementation(async (record) => {
      if (record.paidMsats === 1000 && record.status === "awaiting-input" && failures < 2) {
        failures++;
        resolversDuringFailure.push(job.pendingPayment);
        throw new Error("transient partial-payment snapshot failure");
      }
      await save(record);
    });
    if (delivery === "dispatch") {
      await jm.dispatchMessage(job, "payment", { amount_msats: 1000 });
    } else {
      for (const cb of callbacks) cb();
    }
    await vi.waitFor(() => expect(paymentResumes).toBe(1));
    expect(failures).toBe(2);
    for (const resolver of resolversDuringFailure) expect(resolver).toBe(pending);
    expect(job.pendingPayment).toBeNull();
    expect(job.pendingPrompts.has("question")).toBe(true);
    expect((await store.get(job.id))?.status).toBe("awaiting-input");
    await jm.dispatchMessage(job, "response", { prompt_id: "question", text: "yes" });
    await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
    await job.terminalWork;
    expect(executions).toBe(1);
    expect(paymentResumes).toBe(1);
    expect(await store.get(job.id)).toMatchObject({ status: "completed", paidMsats: 1000 });
    expect(job.abort.signal.aborted).toBe(false);
  });

  it.each([
    { delivery: "dispatch", recovery: "prompt" },
    { delivery: "dispatch", recovery: "notify" },
    { delivery: "notify", recovery: "prompt" },
    { delivery: "notify", recovery: "notify" },
    { delivery: "notify", recovery: "cancel" },
  ])("recovers an exhausted $delivery payment snapshot through $recovery", async ({ delivery, recovery }) => {
    const callbacks = new Set<() => void>();
    const store = new MemoryJobStore();
    store.subscribeNotifications = async (_id, cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    };
    let paymentResumes = 0;
    let executions = 0;
    const { jm } = manager(store, async (ctx) => {
      await Promise.all([
        ctx.prompt("question", "Continue?"),
        ctx.requestPayment(1000, "fee").then(() => { paymentResumes++; }),
      ]);
      executions++;
      ctx.complete("answered and paid");
    });
    const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
    await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
    await jm.persistJob(job);
    const pending = job.pendingPayment;
    const claims = vi.spyOn(store, "claimForProcessing");
    const seq = await store.recordInbound(job.id, {
      from: "requester", type: "payment", content: {}, timestamp: Date.now(),
    });
    await store.verifyAndCredit(job.id, seq, { paidMsatsDelta: 1000, clearPending: true });
    job.paidMsats = 1000;
    job.pendingPaymentMsats = undefined;
    const save = store.save.bind(store);
    let unavailable = true;
    let failures = 0;
    vi.spyOn(store, "save").mockImplementation(async (record) => {
      if (unavailable && record.paidMsats === 1000 && record.status === "awaiting-input") {
        failures++;
        throw new Error("partial-payment snapshot unavailable");
      }
      await save(record);
    });
    if (delivery === "dispatch") {
      await expect(jm.dispatchMessage(job, "payment", { amount_msats: 1000 })).rejects.toThrow("Job snapshot could not be persisted");
    } else {
      for (const cb of callbacks) cb();
      await vi.waitFor(() => expect(failures).toBe(3));
    }
    expect(failures).toBe(3);
    expect(paymentResumes).toBe(0);
    expect(job.pendingPayment).toBe(pending);
    expect((await store.get(job.id))?.status).toBe("processing");
    unavailable = false;
    if (recovery === "cancel") {
      await store.save({ ...(await store.get(job.id))!, status: "cancelled", summary: "caller stopped" });
      for (const cb of callbacks) cb();
      await vi.waitFor(() => expect(job.status).toBe("cancelled"));
      expect(job.abort.signal.aborted).toBe(true);
      expect(job.pendingPayment).toBeNull();
      expect(paymentResumes).toBe(0);
      expect(executions).toBe(0);
      expect(await store.get(job.id)).toMatchObject({ status: "cancelled", summary: "caller stopped", paidMsats: 1000 });
      return;
    }
    if (recovery === "notify") {
      for (const cb of callbacks) cb();
      await vi.waitFor(() => expect(paymentResumes).toBe(1));
      expect((await store.get(job.id))?.status).toBe("awaiting-input");
      expect(job.pendingPrompts.has("question")).toBe(true);
    }
    await jm.dispatchMessage(job, "response", { prompt_id: "question", text: "yes" });
    await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
    await job.terminalWork;
    expect(executions).toBe(1);
    expect(paymentResumes).toBe(1);
    expect(claims).toHaveBeenCalledTimes(2);
    expect(job.pendingPayment).toBeNull();
    expect(job.pendingPrompts.size).toBe(0);
    expect(job.abort.signal.aborted).toBe(false);
    expect(await store.get(job.id)).toMatchObject({ status: "completed", paidMsats: 1000 });
  });

  it("excludes a foreign payment claimant while a local prompt is also pending", async () => {
    const callbacks = new Set<() => void>();
    const store = new MemoryJobStore();
    store.subscribeNotifications = async (_id, cb) => {
      callbacks.add(cb);
      return () => callbacks.delete(cb);
    };
    let resumed = false;
    const { jm } = manager(store, async (ctx) => {
      await Promise.all([ctx.prompt("question", "Continue?"), ctx.requestPayment(1000, "fee")]);
      resumed = true;
      ctx.complete("duplicate");
    });
    const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await jm.persistJob(job);
    jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
    await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
    await jm.persistJob(job);
    await store.save({ ...(await store.get(job.id))!, paidMsats: 1000, pendingPaymentMsats: undefined });
    await store.claimForProcessing(job.id);
    for (const cb of callbacks) cb();
    await vi.waitFor(() => expect(job.abort.signal.aborted).toBe(true));
    expect(resumed).toBe(false);
    expect(jm.activeJobs.has(job.id)).toBe(false);
    expect((await store.get(job.id))?.status).toBe("processing");
    expect((await store.get(job.id))?.receipt).toBeUndefined();
  });

});
