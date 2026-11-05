import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PostgresKVStore } from "../postgres-kv-store";

const SWEEP_SQL = /^\s*DELETE FROM kv_store\s+WHERE key = ANY/;

function sweepFailedLogs(logged: { mock: { calls: unknown[][] } }): number {
  return logged.mock.calls.filter((call) => call.map(String).join(" ").includes("kv_expiry_sweep_failed"))
    .length;
}

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
      if (SWEEP_SQL.test(sql)) {
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
    expect(sweepFailedLogs(logged)).toBe(1);
  });

  it("logs one failure per failed sweep, not per write made while it ran", async () => {
    let failSweep!: (err: Error) => void;
    let sweeps = 0;
    const query = vi.fn((sql: string) => {
      if (SWEEP_SQL.test(sql)) {
        sweeps++;
        return new Promise((_, reject) => {
          failSweep = reject;
        });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // An interval of 1 ms makes every write eligible to start a sweep.
    store = new PostgresKVStore({ query } as unknown as Pool, { sweepIntervalMs: 1 });

    await store.set("a", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.set("b", 2);
    await store.set("c", 3);
    failSweep(new Error("statement timeout"));
    await store.close();

    expect(sweeps).toBe(1);
    expect(sweepFailedLogs(logged)).toBe(1);
  });
});
