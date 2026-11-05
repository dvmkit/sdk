import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresKVStore } from "../postgres-kv-store";

describe("PostgresKVStore expiry sweep", () => {
  let store: PostgresKVStore | undefined;

  afterEach(async () => {
    await store?.close();
    store = undefined;
  });

  it("a failing sweep does not fail the write that started it", async () => {
    let sweepAttempted!: () => void;
    const attempted = new Promise<void>((resolve) => {
      sweepAttempted = resolve;
    });
    const query = vi.fn((sql: string) => {
      if (/^\s*DELETE FROM kv_store\s+WHERE key IN/.test(sql)) {
        sweepAttempted();
        return Promise.reject(new Error("statement timeout"));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    store = new PostgresKVStore({ query } as unknown as Pool);

    await expect(store.set("day:2026-11-05", { n: 1 }, { ttl: 60 })).resolves.toBeUndefined();
    await attempted;
    await store.close();

    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO kv_store"))).toBe(true);
    expect(logged.mock.calls.flat().map(String).join("\n")).toContain("kv_expiry_sweep_failed");
  });
});
