import { describe, expect, it } from "vitest";

import type { Message } from "../../lib/messages/types";
import type { ServerJob } from "../server/job";
import { fromJobRecord, providerMessage, toJobRecord } from "../server/job";
import type { JobRecord } from "../server/job-store";
import { isStreamableJobStore } from "../server/job-store";
import { MemoryJobStore } from "../server/memory-job-store";
import { StepCache } from "../step-cache";

function makeJob(overrides?: Partial<ServerJob>): ServerJob {
  return {
    id: "job-abc-1",
    tags: ["test"],
    capability: "test",
    input: "hello",
    params: { lang: "en" },
    requesterId: "deadbeef",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: { count: 0 },
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: 1000,
    lastActivityAt: 2000,
    ...overrides,
  };
}

function makeRecord(overrides?: Partial<JobRecord>): JobRecord {
  return {
    id: "job-abc-1",
    tags: ["test"],
    capability: "test",
    input: "hello",
    params: { lang: "en" },
    requesterId: "deadbeef",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: { count: 0 },
    createdAt: 1000,
    lastActivityAt: 2000,
    ...overrides,
  };
}

describe("toJobRecord / fromJobRecord", () => {
  it("round-trips persistent fields", () => {
    const stepCache = new StepCache();
    stepCache.set("a", 42);
    stepCache.set("b", "hello");

    const job = makeJob({
      status: "completed",
      summary: "done",
      seq: 5,
      paidMsats: 1000,
      upfrontPayment: { amount_msats: 750, amount_micro: 23, currency: "eur", credit_id: "c", draw_id: "d" },
      paymentMint: "https://mint.example",
      paymentRail: "cashu",
      pendingPaymentMsats: 500,
      pendingMppChallengeIds: ["ch-1", "ch-2"],
      pendingX402Nonce: `0x${"a".repeat(64)}`,
      pendingX402AmountUsdcMicro: "1050",
      stepCache,
      state: { count: 7, items: ["x"] },
    });

    const record = toJobRecord(job);
    expect(record.id).toBe("job-abc-1");
    expect(record.status).toBe("completed");
    expect(record.summary).toBe("done");
    expect(record.seq).toBe(5);
    expect(record.paidMsats).toBe(1000);
    expect(record.upfrontPayment).toEqual({ amount_msats: 750, amount_micro: 23, currency: "eur", credit_id: "c", draw_id: "d" });
    expect(record.paymentMint).toBe("https://mint.example");
    expect(record.paymentRail).toBe("cashu");
    expect(record.pendingMppChallengeIds).toEqual(["ch-1", "ch-2"]);
    expect(record.pendingX402Nonce).toBe(`0x${"a".repeat(64)}`);
    expect(record.pendingX402AmountUsdcMicro).toBe("1050");
    expect(record.stepCache).toEqual([
      { id: "a", value: 42 },
      { id: "b", value: "hello" },
    ]);
    expect(record.state).toEqual({ count: 7, items: ["x"] });
    expect(record.createdAt).toBe(1000);
    expect(record.lastActivityAt).toBe(2000);

    const restored = fromJobRecord(record);
    expect(restored.upfrontPayment).toEqual(job.upfrontPayment);
    expect(restored.id).toBe("job-abc-1");
    expect(restored.status).toBe("completed");
    expect(restored.summary).toBe("done");
    expect(restored.seq).toBe(5);
    expect(restored.paymentRail).toBe("cashu");
    expect(restored.pendingMppChallengeIds).toEqual(["ch-1", "ch-2"]);
    expect(restored.pendingX402Nonce).toBe(`0x${"a".repeat(64)}`);
    expect(restored.pendingX402AmountUsdcMicro).toBe("1050");
    expect(restored.stepCache.has("a")).toBe(true);
    expect(restored.stepCache.get("a")).toBe(42);
    expect(restored.stepCache.has("b")).toBe(true);
    expect(restored.stepCache.get("b")).toBe("hello");
    expect(restored.state).toEqual({ count: 7, items: ["x"] });
  });

  it("restores fresh runtime fields", () => {
    const record = makeRecord();
    const restored = fromJobRecord(record);

    expect(restored.listeners).toBeInstanceOf(Set);
    expect(restored.listeners.size).toBe(0);
    expect(restored.pendingPrompts).toBeInstanceOf(Map);
    expect(restored.pendingPrompts.size).toBe(0);
    expect(restored.pendingPayment).toBeNull();
    expect(restored.sdkCtx).toBeUndefined();
    expect(restored.replayHighSeq).toBeNull();
  });

  it("preserves messages through round-trip", () => {
    const job = makeJob({
      messages: [
        {
          seq: 1,
          from: "provider",
          timestamp: 100,
          type: "text",
          content: { text: "hello" },
        },
        {
          seq: 2,
          from: "provider",
          timestamp: 101,
          type: "complete",
          content: { summary: "done" },
        },
      ],
      seq: 2,
    });

    const record = toJobRecord(job);
    const restored = fromJobRecord(record);
    expect(restored.messages).toHaveLength(2);
    expect(restored.messages[0].type).toBe("text");
    expect(restored.messages[1].type).toBe("complete");
  });
});

describe("MemoryJobStore", () => {
  it.each([undefined, { amount_msats: 0 }, {
    amount_msats: 321, amount_micro: 123, currency: "eur", credit_id: "c", draw_id: "d",
  }])("keeps the original upfront fact through later snapshots (%j)", async (upfrontPayment) => {
    const store = new MemoryJobStore();
    await store.save(makeRecord({ upfrontPayment }));
    await store.save(makeRecord({ paidMsats: 5000, upfrontPayment: { amount_msats: 5000 } }));
    expect((await store.get("job-abc-1"))?.upfrontPayment).toEqual(upfrontPayment);
    await store.save(makeRecord({ status: "completed", paidMsats: 5000 }));
    expect((await store.get("job-abc-1"))?.upfrontPayment).toEqual(upfrontPayment);
  });

  it("returns undefined for missing keys", async () => {
    const store = new MemoryJobStore();
    expect(await store.get("nope")).toBeUndefined();
  });

  it("saves and retrieves a record", async () => {
    const store = new MemoryJobStore();
    const record = makeRecord();
    await store.save(record);

    const retrieved = await store.get("job-abc-1");
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe("job-abc-1");
    expect(retrieved?.tags).toEqual(["test"]);
    expect(retrieved?.params).toEqual({ lang: "en" });
  });

  it("returns clones (not references)", async () => {
    const store = new MemoryJobStore();
    const record = makeRecord();
    await store.save(record);

    const a = await store.get("job-abc-1");
    const b = await store.get("job-abc-1");
    expect(a).not.toBe(b);
    expect(a).toEqual(b);

    // Mutating the retrieved record should not affect the store
    if (a) a.status = "failed";
    const c = await store.get("job-abc-1");
    expect(c?.status).toBe("processing");
  });

  it("upserts on save", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord());
    await store.save(makeRecord({ status: "completed", summary: "done" }));

    const retrieved = await store.get("job-abc-1");
    expect(retrieved?.status).toBe("completed");
    expect(retrieved?.summary).toBe("done");
  });

  it("refuses to overwrite a terminal record with a different status", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord());
    await store.save(makeRecord({ status: "cancelled", summary: "caller cancelled" }));

    // The zombie handler on another machine finishing its work.
    await store.save(makeRecord({ status: "completed", summary: "resurrected" }));

    const retrieved = await store.get("job-abc-1");
    expect(retrieved?.status).toBe("cancelled");
    expect(retrieved?.summary).toBe("caller cancelled");
  });

  it("allows re-saving the same terminal status", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord({ status: "completed", summary: "done" }));
    await store.save(makeRecord({ status: "completed", summary: "done (repersisted)" }));

    const retrieved = await store.get("job-abc-1");
    expect(retrieved?.summary).toBe("done (repersisted)");
  });

  it("cancelJob terminates a live job and appends the cancel message", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord({ status: "processing" }));
    let notified = 0;
    await store.subscribeNotifications("job-abc-1", () => notified++);

    expect(await store.cancelJob("job-abc-1", "caller changed their mind")).toBe(true);

    const retrieved = await store.get("job-abc-1");
    expect(retrieved?.status).toBe("cancelled");
    expect(retrieved?.summary).toBe("caller changed their mind");
    expect(retrieved?.messages.at(-1)).toMatchObject({
      type: "cancel",
      from: "provider",
      content: { reason: "caller changed their mind" },
    });
    // The notify is what wakes the machine running the handler.
    expect(notified).toBe(1);
    expect((await store.getCounters("job-abc-1"))?.summary).toBe("caller changed their mind");
  });

  it("cancelJob refuses a job that already went terminal", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord({ status: "completed", summary: "done" }));

    expect(await store.cancelJob("job-abc-1", "too late")).toBe(false);

    const retrieved = await store.get("job-abc-1");
    expect(retrieved?.status).toBe("completed");
    expect(retrieved?.summary).toBe("done");
    expect(retrieved?.messages.some((m) => m.type === "cancel")).toBe(false);
  });

  it("deletes a record", async () => {
    const store = new MemoryJobStore();
    await store.save(makeRecord());
    await store.delete("job-abc-1");
    expect(await store.get("job-abc-1")).toBeUndefined();
  });

  it("delete is idempotent", async () => {
    const store = new MemoryJobStore();
    await store.delete("nonexistent");
    // no error thrown
  });
});

describe("isStreamableJobStore", () => {
  it("returns true for MemoryJobStore (streamable surface mirrors PostgresJobStore)", () => {
    const store = new MemoryJobStore();
    expect(isStreamableJobStore(store)).toBe(true);
  });

  it("returns false for objects missing the transactional methods", () => {
    const fake = {
      get: async () => undefined,
      save: async () => undefined,
      delete: async () => undefined,
    };
    expect(isStreamableJobStore(fake as never)).toBe(false);
  });

  it("returns true for objects with the full  streamable + transactional surface", () => {
    expect(isStreamableJobStore(fullStreamableSurface() as never)).toBe(true);
  });

  it("returns false for a store that predates cancelJob", () => {
    // The guard is duck-typed, so a store built against the older interface
    // would otherwise sail through it and TypeError inside the DELETE route.
    const { cancelJob: _omitted, ...stale } = fullStreamableSurface();
    expect(isStreamableJobStore(stale as never)).toBe(false);
  });

  it("returns false for a store that predates getVerifiedInbound", () => {
    // Same reason, sharper stakes: the caller reaches for this method only
    // after a mid-job payment's rail and ledger legs have already committed,
    // so a TypeError there is money moved against a job row recording none of
    // it — the exact failure the method exists to recover from.
    const { getVerifiedInbound: _omitted, ...stale } = fullStreamableSurface();
    expect(isStreamableJobStore(stale as never)).toBe(false);
  });

  /** Every member the guard names — drop one and the guard must reject it. */
  function fullStreamableSurface() {
    return {
      get: async () => undefined,
      save: async () => undefined,
      delete: async () => undefined,
      appendOutgoing: async () => 1,
      recordInbound: async () => 1,
      verifyAndCredit: async () => ({
        counters: { status: "processing", paidMsats: 0 },
        alreadyVerified: false,
      }),
      getVerifiedInbound: async () => undefined,
      markInboundFailed: async () => undefined,
      getCounters: async () => undefined,
      cancelJob: async () => true,
      tryReactivationLock: async () => ({ acquired: false }),
      subscribeMessages: async () => () => undefined,
      subscribeNotifications: async () => () => undefined,
      getMessages: async () => [],
      initStreaming: async () => undefined,
      shutdownStreaming: async () => undefined,
    };
  }
});

describe("providerMessage messageAppender", () => {
  it("calls messageAppender when set", () => {
    const appended: Message[] = [];
    const job = makeJob();
    job.messageAppender = (msg) => appended.push(msg);

    providerMessage(job, "text", { text: "hello" });

    expect(appended).toHaveLength(1);
    expect(appended[0].type).toBe("text");
    expect(appended[0].seq).toBe(1);
    expect(job.messages).toHaveLength(1);
  });

  it("does not fail when messageAppender is undefined", () => {
    const job = makeJob();
    providerMessage(job, "text", { text: "hello" });
    expect(job.messages).toHaveLength(1);
  });

  it("skips messageAppender during replay", () => {
    const appended: Message[] = [];
    const job = makeJob({ replayProviderSkip: 1 });
    job.messageAppender = (msg) => appended.push(msg);

    providerMessage(job, "text", { text: "replayed" });

    expect(appended).toHaveLength(0);
    expect(job.messages).toHaveLength(0);
  });
});
