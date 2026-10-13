import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryKVStore } from "../store";

describe("MemoryKVStore", () => {
  let store: MemoryKVStore;

  beforeEach(() => {
    store = new MemoryKVStore();
  });

  it("get returns undefined for missing keys", async () => {
    expect(await store.get("nope")).toBeUndefined();
  });

  it("set/get round-trip", async () => {
    await store.set("key", { name: "test", count: 42 });
    expect(await store.get<{ name: string; count: number }>("key")).toEqual({ name: "test", count: 42 });
  });

  it("delete removes keys", async () => {
    await store.set("key", "val");
    await store.delete("key");
    expect(await store.get("key")).toBeUndefined();
  });

  it("list returns all keys", async () => {
    await store.set("a", 1);
    await store.set("b", 2);
    const keys = await store.list();
    expect(keys.sort()).toEqual(["a", "b"]);
  });

  it("list filters by prefix", async () => {
    await store.set("user:1", "a");
    await store.set("user:2", "b");
    await store.set("settings:x", "c");
    expect(await store.list("user:")).toEqual(["user:1", "user:2"]);
  });

  describe("TTL", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("returns value before expiry", async () => {
      vi.useFakeTimers();
      await store.set("key", "val", { ttl: 10 });
      vi.advanceTimersByTime(5000);
      expect(await store.get("key")).toBe("val");
    });

    it("returns undefined after expiry", async () => {
      vi.useFakeTimers();
      await store.set("key", "val", { ttl: 1 });
      vi.advanceTimersByTime(2000);
      expect(await store.get("key")).toBeUndefined();
    });

    it("list excludes expired keys", async () => {
      vi.useFakeTimers();
      await store.set("live", "a");
      await store.set("expired", "b", { ttl: 1 });
      vi.advanceTimersByTime(2000);
      expect(await store.list()).toEqual(["live"]);
    });
  });
});
