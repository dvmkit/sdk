import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initLoggers } from "../../observability/loggers";
import { SpanWriter } from "../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../observability/types";
import { setEmitter } from "../../observability/with-span";
import { instrumentKVStore } from "../server/instrumented-kv";
import { MemoryKVStore } from "../store";

function expectedHash(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** No-op transport — spans are captured via setEmitter instead. */
const noopTransport: SpanTransport = { send: async () => {} };

describe("instrumentKVStore", () => {
  const emitted: SpanRow[] = [];
  let inner: MemoryKVStore;
  let store: ReturnType<typeof instrumentKVStore>;

  beforeEach(() => {
    emitted.length = 0;
    // Init real loggers so loggers.isolate.span() calls withSpan()
    const writer = new SpanWriter(noopTransport);
    initLoggers(writer, "test");
    // Capture spans via the emitter
    setEmitter((row) => emitted.push(row));
    inner = new MemoryKVStore();
    store = instrumentKVStore(inner);
  });

  afterEach(() => {
    setEmitter(() => {});
  });

  it("delegates get and emits dvm.kv.read span", async () => {
    await inner.set("test-key", "hello");
    const result = await store.get("test-key");
    expect(result).toBe("hello");

    const span = emitted.find((s) => s.name === "dvm.kv.read");
    expect(span).toBeDefined();
    expect(span?.dataset).toBe("isolate");
    expect(span?.attributes.key_hash).toBe(expectedHash("test-key"));
    expect(JSON.stringify(span?.attributes)).not.toContain("test-key");
  });

  it("delegates set and emits dvm.kv.write span with value_size_bytes", async () => {
    await store.set("my-key", { data: "value" });

    const val = await inner.get("my-key");
    expect(val).toEqual({ data: "value" });

    const span = emitted.find((s) => s.name === "dvm.kv.write");
    expect(span).toBeDefined();
    expect(span?.attributes.key_hash).toBe(expectedHash("my-key"));
    expect(span?.attributes.value_size_bytes).toBe(JSON.stringify({ data: "value" }).length);
    expect(JSON.stringify(span?.attributes)).not.toContain("my-key");
  });

  it("delegates delete and emits dvm.kv.delete span", async () => {
    await inner.set("del-key", "val");
    await store.delete("del-key");

    const val = await inner.get("del-key");
    expect(val).toBeUndefined();

    const span = emitted.find((s) => s.name === "dvm.kv.delete");
    expect(span).toBeDefined();
    expect(span?.attributes.key_hash).toBe(expectedHash("del-key"));
    expect(JSON.stringify(span?.attributes)).not.toContain("del-key");
  });

  it("delegates list and emits dvm.kv.list span", async () => {
    await inner.set("prefix:a", 1);
    await inner.set("prefix:b", 2);
    await inner.set("other", 3);

    const keys = await store.list("prefix:");
    expect(keys).toEqual(expect.arrayContaining(["prefix:a", "prefix:b"]));
    expect(keys).not.toContain("other");

    const span = emitted.find((s) => s.name === "dvm.kv.list");
    expect(span).toBeDefined();
    expect(span?.attributes.prefix_hash).toBe(expectedHash("prefix:"));
    expect(JSON.stringify(span?.attributes)).not.toContain("prefix:");
  });
});
