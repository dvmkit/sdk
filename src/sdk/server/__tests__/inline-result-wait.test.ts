import { afterEach, expect, it, vi } from "vitest";

import { fromJobRecord } from "../job";
import { inlineResultMessages, waitForInlineResult } from "../inline-result-wait";
import { MemoryJobStore } from "../memory-job-store";
import type { JobRecord, JobStore } from "../job-store";

class ObservedStore extends MemoryJobStore {
  watchers = 0;
  override async subscribeNotifications(id: string, notify: () => void): Promise<() => void> {
    const stop = await super.subscribeNotifications(id, notify);
    this.watchers++;
    return () => { this.watchers--; stop(); };
  }
}

const record: JobRecord = {
  id: "job-example", status: "processing", input: "", params: {}, requesterId: "anonymous",
  tags: [], capability: "work", receivedProofs: [], stepCache: [], state: {},
  messages: [], seq: 0, createdAt: 1, lastActivityAt: 1, paidMsats: 0,
};

afterEach(() => { vi.useRealTimers(); });

it.each(["timeout", "completed", "cancelled", "abort"])("releases the status subscription and timer on %s", async (exit) => {
  vi.useFakeTimers();
  const store = new ObservedStore();
  await store.save(record);
  const controller = new AbortController();
  const local = fromJobRecord(record);
  const waiting = waitForInlineResult(store, record.id, local, 1, controller.signal);
  await vi.advanceTimersByTimeAsync(0);
  expect(store.watchers).toBe(1);
  expect(local.listeners.size).toBe(1);
  if (exit === "timeout") await vi.advanceTimersByTimeAsync(1000);
  if (exit === "completed" || exit === "cancelled") await store.save({ ...record, status: exit });
  if (exit === "abort") controller.abort();
  await waiting;
  expect(store.watchers).toBe(0);
  expect(local.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect((await store.get(record.id))?.status).toBe(exit === "completed" || exit === "cancelled" ? exit : "processing");
});

it("keeps a processing job pending until the exact configured deadline", async () => {
  vi.useFakeTimers();
  const store = new ObservedStore();
  await store.save(record);
  let settled = false;
  const waiting = waitForInlineResult(store, record.id, undefined, 1, new AbortController().signal)
    .then(() => { settled = true; });
  await vi.advanceTimersByTimeAsync(999);
  expect(settled).toBe(false);
  expect(store.watchers).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  await waiting;
  expect(settled).toBe(true);
  expect(store.watchers).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("unsubscribes even when subscription setup finishes after disconnect", async () => {
  const store = new ObservedStore();
  await store.save(record);
  const subscribe = store.subscribeNotifications.bind(store);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let setup!: Promise<() => void>;
  store.subscribeNotifications = (...args) => {
    setup = ready.then(() => subscribe(...args));
    return setup;
  };
  const controller = new AbortController();
  const waiting = waitForInlineResult(store, record.id, undefined, 1, controller.signal);
  controller.abort();
  await waiting;
  release();
  await setup;
  await Promise.resolve();
  expect(store.watchers).toBe(0);
});

it("cleans up when a custom store throws during subscription setup", async () => {
  vi.useFakeTimers();
  const store = new ObservedStore();
  await store.save(record);
  const local = fromJobRecord(record);
  store.subscribeNotifications = () => { throw new Error("subscription unavailable"); };
  await expect(waitForInlineResult(store, record.id, local, 1, new AbortController().signal))
    .rejects.toThrow("subscription unavailable");
  expect(local.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([-1, 0, 1])("caps the serialized UTF-8 message array at 1 MB (offset %s)", async (offset) => {
  // The fixed JSON envelope is 133 bytes; é occupies two UTF-8 bytes.
  const data = "é" + "a".repeat(1_048_576 + offset - 133 - 2);
  const messages: JobRecord["messages"] = [{
    seq: 1, from: "provider", timestamp: 1, type: "artifact",
    content: { mime_type: "application/json", encoding: "utf-8", data },
  }];
  const job: JobRecord = { ...record, status: "completed", messages };
  const store = new MemoryJobStore();
  await store.save(job);
  const result = await inlineResultMessages(store, job);
  if (offset <= 0) expect(result).toEqual(messages);
  else expect(result).toBeUndefined();
});

it("reads terminal artifact history durably instead of using a stale snapshot", async () => {
  const artifact = (data: string): JobRecord["messages"] => [{
    seq: 1, from: "provider", timestamp: 1, type: "artifact", content: { data },
  }];
  const job: JobRecord = { ...record, status: "completed", messages: artifact("stale") };
  const store = new MemoryJobStore();
  await store.save({ ...job, messages: artifact("durable result") });
  expect(await inlineResultMessages(store, job)).toEqual(artifact("durable result"));
});

it("stops durable reads before loading the rest of an oversized transcript", async () => {
  const messages: JobRecord["messages"] = Array.from({ length: 100 }, (_, index) => ({
    seq: index + 1, from: "provider", timestamp: 1, type: "artifact", content: { data: "x".repeat(40_000) },
  }));
  const job: JobRecord = { ...record, status: "completed", messages };
  const store = new MemoryJobStore();
  await store.save(job);
  const read = vi.spyOn(store, "getMessages");
  expect(await inlineResultMessages(store, job)).toBeUndefined();
  expect(read.mock.calls.length).toBeGreaterThan(1);
  const pages = await Promise.all(read.mock.results.map(result => result.value));
  const loaded = pages.flat();
  expect(loaded.length).toBeGreaterThan(0);
  expect(loaded.length).toBeLessThan(messages.length);
  expect(loaded.at(-1)!.seq).toBeLessThan(messages.at(-1)!.seq);
});

it("keeps every under-cap message across durable pages, including escaped and UTF-8 content", async () => {
  const messages: JobRecord["messages"] = Array.from({ length: 100 }, (_, index) => ({
    seq: index * 2 + 1, from: "provider", timestamp: 1, type: "artifact", content: { data: `é\n\"\\ ${index}` },
  }));
  const job: JobRecord = { ...record, status: "completed", messages };
  const store = new MemoryJobStore();
  await store.save(job);
  const read = vi.spyOn(store, "getMessages");
  expect(await inlineResultMessages(store, job)).toEqual(messages);
  expect(read.mock.calls.length).toBeGreaterThan(1);
});

it.each([-1, 0, 1])("counts commas and escaped UTF-8 in multi-message arrays (offset %s)", async (offset) => {
  // Two empty artifact envelopes occupy 265 bytes, including brackets and comma.
  // The first data string adds eight JSON bytes: é, newline, quote, backslash.
  const messages: JobRecord["messages"] = ["é\n\"\\", "a".repeat(1_048_576 + offset - 265 - 8)]
    .map((data, index) => ({
      seq: index + 1, from: "provider", timestamp: 1, type: "artifact",
      content: { mime_type: "application/json", encoding: "utf-8", data },
    }));
  const job: JobRecord = { ...record, status: "completed", messages };
  const store = new MemoryJobStore();
  await store.save(job);
  const result = await inlineResultMessages(store, job);
  if (offset <= 0) expect(result).toEqual(messages);
  else expect(result).toBeUndefined();
});

it("keeps compatibility with custom streamable stores that ignore the page limit", async () => {
  const messages: JobRecord["messages"] = Array.from({ length: 40 }, (_, index) => ({
    seq: index + 1, from: "provider", timestamp: 1, type: "artifact", content: { data: `${index}` },
  }));
  const job: JobRecord = { ...record, status: "completed", messages };
  class LegacyStore extends MemoryJobStore {
    override getMessages(id: string, afterSeq: number, options?: { includeHeld?: boolean }) {
      return super.getMessages(id, afterSeq, { includeHeld: options?.includeHeld });
    }
  }
  const store = new LegacyStore();
  await store.save(job);
  expect(await inlineResultMessages(store, job)).toEqual(messages);
});

it.each(["snapshot", "empty-durable"])("stops serializing an oversized %s fallback before later messages", async (kind) => {
  const tailContent = vi.fn(() => ({ data: "unread tail" }));
  const messages: JobRecord["messages"] = [{
    seq: 1, from: "provider", timestamp: 1, type: "artifact", content: { data: "x".repeat(1_048_576) },
  }, {
    seq: 2, from: "provider", timestamp: 1, type: "artifact", get content() { return tailContent(); },
  }];
  const job: JobRecord = { ...record, status: "completed", messages };
  const store: JobStore = kind === "empty-durable" ? new MemoryJobStore() : {
    get: async () => job, findJobByPaymentTxHash: async () => undefined,
    save: async () => undefined, delete: async () => undefined,
  };
  expect(await inlineResultMessages(store, job)).toBeUndefined();
  expect(tailContent).not.toHaveBeenCalled();
});

it.each(["snapshot", "empty-durable"])("preserves positive-sequence messages in an under-cap %s fallback", async (kind) => {
  const messages: JobRecord["messages"] = [0, 1, 3].map(seq => ({
    seq, from: "provider", timestamp: 1, type: "artifact", content: { data: `${seq}` },
  }));
  const job: JobRecord = { ...record, status: "completed", messages };
  const store: JobStore = kind === "empty-durable" ? new MemoryJobStore() : {
    get: async () => job, findJobByPaymentTxHash: async () => undefined,
    save: async () => undefined, delete: async () => undefined,
  };
  expect(await inlineResultMessages(store, job)).toEqual(messages.slice(1));
});

it.each(["processing", "awaiting-input", "failed", "cancelled"] as const)("does not inline messages for %s jobs", async (status) => {
  const job: JobRecord = { ...record, status, messages: [{
    seq: 1, from: "provider", timestamp: 1, type: "artifact", content: { data: "partial" },
  }] };
  const store = new MemoryJobStore();
  await store.save(job);
  expect(await inlineResultMessages(store, job)).toBeUndefined();
});
