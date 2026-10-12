import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoryConsumedCredentialStore } from "../server/consumed-credential-store";

describe("MemoryConsumedCredentialStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks, recalls, and expires a credential", async () => {
    const store = new MemoryConsumedCredentialStore();
    expect(await store.has("realm.example", "ch_1")).toBe(false);
    await store.mark("realm.example", "ch_1", 60);
    expect(await store.has("realm.example", "ch_1")).toBe(true);
    vi.advanceTimersByTime(60 * 1000 + 1);
    expect(await store.has("realm.example", "ch_1")).toBe(false);
  });

  it("scopes entries by realm so the same id in two realms is independent", async () => {
    const store = new MemoryConsumedCredentialStore();
    await store.mark("realm.a", "ch_shared", 60);
    expect(await store.has("realm.a", "ch_shared")).toBe(true);
    expect(await store.has("realm.b", "ch_shared")).toBe(false);
  });

  it("FIFO-evicts the oldest entry when capacity is reached", async () => {
    const store = new MemoryConsumedCredentialStore({ maxEntries: 3 });
    await store.mark("r", "first", 60);
    await store.mark("r", "second", 60);
    await store.mark("r", "third", 60);
    // Adding a fourth pushes "first" out (FIFO).
    await store.mark("r", "fourth", 60);
    expect(await store.has("r", "first")).toBe(false);
    expect(await store.has("r", "second")).toBe(true);
    expect(await store.has("r", "third")).toBe(true);
    expect(await store.has("r", "fourth")).toBe(true);
  });

  it("re-marking an existing entry refreshes its position in the FIFO order", async () => {
    // Re-mark of an existing entry should move it to the back so a follow-up
    // eviction targets entries that haven't been refreshed.
    const store = new MemoryConsumedCredentialStore({ maxEntries: 3 });
    await store.mark("r", "a", 60);
    await store.mark("r", "b", 60);
    await store.mark("r", "c", 60);
    await store.mark("r", "a", 60); // refresh "a" → now newest
    await store.mark("r", "d", 60); // evicts the oldest, which is now "b"
    expect(await store.has("r", "b")).toBe(false);
    expect(await store.has("r", "a")).toBe(true);
    expect(await store.has("r", "c")).toBe(true);
    expect(await store.has("r", "d")).toBe(true);
  });
});
