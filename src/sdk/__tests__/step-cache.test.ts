import { describe, expect, it } from "vitest";

import { StepCache } from "../step-cache";

describe("StepCache", () => {

  it("has returns true for cached keys", () => {
    const cache = new StepCache();
    cache.set("a", "value");
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("get throws on missing key", () => {
    const cache = new StepCache();
    expect(() => cache.get("missing")).toThrow('StepCache: no cached result for step "missing"');
  });

  it("handles various value types", () => {
    const cache = new StepCache();
    cache.set("string", "hello");
    cache.set("number", 3.14);
    cache.set("object", { nested: true });
    cache.set("array", [1, 2, 3]);
    cache.set("null", null);

    expect(cache.get("string")).toBe("hello");
    expect(cache.get("number")).toBe(3.14);
    expect(cache.get("object")).toEqual({ nested: true });
    expect(cache.get("array")).toEqual([1, 2, 3]);
    expect(cache.get("null")).toBeNull();
  });

  it("serialize produces StepRecord array", () => {
    const cache = new StepCache();
    cache.set("a", 1);
    cache.set("b", "two");
    const records = cache.serialize();
    expect(records).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: "two" },
    ]);
  });

  it("deserialize restores from records", () => {
    const restored = StepCache.deserialize([
      { id: "x", value: { data: true } },
      { id: "y", value: 99 },
    ]);
    expect(restored.get("x")).toEqual({ data: true });
    expect(restored.get("y")).toBe(99);
  });

  it("persists cost declarations only when a step made them", () => {
    const cache = new StepCache();
    cache.set("free", "result");
    cache.set("priced", 42, [
      { amount: 0, currency: "usd" },
      { amount: 0.0004, currency: "usd" },
    ]);

    expect(cache.serialize()).toEqual([
      { id: "free", value: "result" },
      {
        id: "priced",
        value: 42,
        costs: [
          { amount: 0, currency: "usd" },
          { amount: 0.0004, currency: "usd" },
        ],
      },
    ]);

    const restored = StepCache.deserialize(cache.serialize());
    expect(restored.getRecord("priced").costs).toEqual([
      { amount: 0, currency: "usd" },
      { amount: 0.0004, currency: "usd" },
    ]);
  });

  it("serialize/deserialize round-trip", () => {
    const cache = new StepCache();
    cache.set("a", [1, 2]);
    cache.set("b", { key: "val" });

    const restored = StepCache.deserialize(cache.serialize());
    expect(restored.get("a")).toEqual([1, 2]);
    expect(restored.get("b")).toEqual({ key: "val" });
  });
});
