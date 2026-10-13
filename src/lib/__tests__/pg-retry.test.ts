import { EventEmitter } from "node:events";

import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyRetryToPool,
  formatPostgresApplicationName,
  isTransportError,
  withInitRetry,
  withPostgresRecoveryContext,
  withPostgresTransactionRecovery,
} from "../pg-retry";

describe("isTransportError", () => {
  it("returns true for 'Connection terminated'", () => {
    expect(isTransportError(new Error("Connection terminated unexpectedly"))).toBe(true);
  });

  it("returns true for ECONNRESET", () => {
    expect(
      isTransportError(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }))
    ).toBe(true);
  });

  it("returns true for ENOTFOUND", () => {
    expect(
      isTransportError(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }))
    ).toBe(true);
  });

  it("returns false for a Postgres unique-violation (23505)", () => {
    expect(isTransportError(Object.assign(new Error("duplicate key"), { code: "23505" }))).toBe(
      false
    );
  });

  it("returns false for a generic Error with no code", () => {
    expect(isTransportError(new Error("some random error"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isTransportError(null)).toBe(false);
    expect(isTransportError("string error")).toBe(false);
  });
});

function makePool(
  queryImpl: (...args: unknown[]) => Promise<unknown>,
  connectImpl?: (...args: unknown[]) => Promise<unknown>
): Pool {
  return {
    query: queryImpl,
    connect: connectImpl ?? (async () => ({})),
    on: vi.fn(),
    options: {}
  } as unknown as Pool;
}

describe("formatPostgresApplicationName", () => {
  it("uses only the subsystem label without a machine id", () => {
    expect(formatPostgresApplicationName("dvm-host", null)).toBe("dvm-host");
  });

  it("adds the machine id while preserving the suffix when the label is long", () => {
    const machineId = "machine-123456";

    expect(formatPostgresApplicationName("x".repeat(100), machineId)).toBe(`${"x".repeat(48)}@machine-123456`);
  });

  it("truncates at a UTF-8 character boundary", () => {
    expect(formatPostgresApplicationName("é".repeat(40), null)).toBe("é".repeat(31));
  });
});

describe("applyRetryToPool", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress output during tests
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("retries query once on transport error, resolves on second call", async () => {
    let calls = 0;
    const pool = makePool(async () => {
      calls++;
      if (calls === 1) throw new Error("Connection terminated unexpectedly");
      return { rows: [{ n: 1 }] };
    });

    applyRetryToPool(pool, "test");
    const result = await pool.query("SELECT 1");

    expect(result).toEqual({ rows: [{ n: 1 }] });
    expect(calls).toBe(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "postgres_transport_recovery",
      level: "warn"
    });
  });

  it("does NOT retry on a Postgres query error", async () => {
    let calls = 0;
    const pgErr = Object.assign(new Error("duplicate key value"), { code: "23505" });
    const pool = makePool(async () => {
      calls++;
      throw pgErr;
    });

    applyRetryToPool(pool, "test");
    await expect(pool.query("INSERT INTO foo VALUES (1)")).rejects.toBe(pgErr);
    expect(calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("propagates transport error if retry also fails", async () => {
    const err = new Error("Connection terminated unexpectedly");
    const pool = makePool(async () => {
      throw err;
    });

    applyRetryToPool(pool, "test");
    await expect(pool.query("SELECT 1")).rejects.toBe(err);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("drains a full stale pool inside the Tempo close recovery budget", async () => {
    let calls = 0;
    const pool = makePool(async () => {
      calls += 1;
      if (calls <= 3) throw new Error("Connection terminated unexpectedly");
      return { rows: [{ n: 1 }] };
    });
    pool.options.max = 3;

    applyRetryToPool(pool, "dvm-host");
    const result = await withPostgresRecoveryContext(
      {
        route: "tempo_close_event",
        channelId: "0xchannel",
        deadlineMs: Date.now() + 1_000,
        drainPool: true
      },
      () => pool.query("SELECT 1")
    );

    expect(result).toEqual({ rows: [{ n: 1 }] });
    expect(calls).toBe(4);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
      event: "postgres_transport_recovery",
      elapsed_ms: expect.any(Number),
      level: "warn"
    });
  });

  it("does not start another recovery attempt after the close budget expires", async () => {
    let calls = 0;
    const pool = makePool(async () => {
      calls += 1;
      throw new Error("Connection terminated unexpectedly");
    });
    pool.options.max = 10;
    applyRetryToPool(pool, "dvm-host");

    await expect(
      withPostgresRecoveryContext(
        {
          route: "tempo_close_event",
          deadlineMs: Date.now() - 1,
          drainPool: true
        },
        () => pool.query("SELECT 1")
      )
    ).rejects.toThrow("Connection terminated unexpectedly");
    expect(calls).toBe(1);
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
      event: "postgres_transport_recovery",
      elapsed_ms: expect.any(Number),
      level: "warn"
    });
  });

  it("is idempotent — calling twice does not double-wrap", async () => {
    let calls = 0;
    const pool = makePool(async () => {
      calls++;
      if (calls === 1) throw new Error("Connection terminated unexpectedly");
      return { rows: [] };
    });

    applyRetryToPool(pool, "test");
    applyRetryToPool(pool, "test"); // second call should be a no-op

    const result = await pool.query("SELECT 1");
    expect(result).toEqual({ rows: [] });
    // 1 (transport error) + 1 (retry success) = 2; a double-wrap would cause a third call
    expect(calls).toBe(2);
  });

  it("retries connect once on transport error", async () => {
    let calls = 0;
    const fakeClient = { query: vi.fn(), release: vi.fn() };
    const pool = makePool(
      async () => ({ rows: [] }),
      async () => {
        calls++;
        if (calls === 1) throw new Error("Connection terminated unexpectedly");
        return fakeClient;
      }
    );

    applyRetryToPool(pool, "test");
    const client = await pool.connect();

    expect(client).toBe(fakeClient);
    expect(calls).toBe(2);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toEqual({
      event: "postgres_transport_recovery",
      elapsed_ms: expect.any(Number),
      level: "warn"
    });
  });

  it("registers pool.on('error') handler", () => {
    const onMock = vi.fn();
    const pool = makePool(async () => ({ rows: [] }));
    (pool as unknown as Record<string, unknown>).on = onMock;
    applyRetryToPool(pool, "test");
    expect(onMock).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("sets the pool startup application name from the retry label", () => {
    const pool = makePool(async () => ({ rows: [] }));

    applyRetryToPool(pool, "dvm-host");

    expect(pool.options.application_name).toBe("dvm-host");
  });

  it("guards a checked-out client so a dead-socket 'error' doesn't crash the process", async () => {
    // A pooled client handed back from connect() has no 'error' listener — pg
    // detaches the pool's idle guard on checkout. Emitting 'error' on a bare
    // EventEmitter throws (the process crash we saw after a Fly suspend→resume).
    const fakeClient = Object.assign(new EventEmitter(), {
      query: vi.fn(),
      release: vi.fn()
    });
    const pool = makePool(
      async () => ({ rows: [] }),
      async () => fakeClient
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {
      // suppress output during tests
    });

    applyRetryToPool(pool, "test");
    const client = (await pool.connect()) as unknown as EventEmitter;

    expect(client).toBe(fakeClient);
    expect(() => client.emit("error", new Error("Connection terminated unexpectedly"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith('{"event":"diagnostic.message","level":"error"}');
    errorSpy.mockRestore();
  });

  it("does not stack 'error' listeners across re-checkouts of the same client", async () => {
    const fakeClient = Object.assign(new EventEmitter(), { query: vi.fn(), release: vi.fn() });
    const pool = makePool(
      async () => ({ rows: [] }),
      async () => fakeClient
    );

    applyRetryToPool(pool, "test");
    await pool.connect();
    await pool.connect();
    await pool.connect();

    // One guard total, however many times the physical client is checked out.
    expect(fakeClient.listenerCount("error")).toBe(1);
  });

  it("restarts a transaction on fresh clients after checked-out transports fail", async () => {
    const staleReleases = [vi.fn(), vi.fn(), vi.fn()];
    const healthyRelease = vi.fn();
    let connects = 0;
    const pool = makePool(
      async () => ({ rows: [] }),
      async () => {
        const index = connects++;
        if (index < staleReleases.length) {
          return {
            query: () => Promise.reject(new Error("Connection terminated unexpectedly")),
            release: staleReleases[index]
          };
        }
        return {
          query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
          release: healthyRelease
        };
      }
    );
    pool.options.max = 3;

    const result = await withPostgresRecoveryContext(
      {
        route: "tempo_close_event",
        channelId: "0xchannel",
        deadlineMs: Date.now() + 1_000,
        drainPool: true
      },
      () =>
        withPostgresTransactionRecovery(pool, "dvm-host", "tempo_session.update", async (tx) => {
          await tx.query("SELECT 1");
          return "committed";
        })
    );

    expect(result).toBe("committed");
    expect(connects).toBe(4);
    expect(staleReleases.every((release) => release.mock.calls[0]?.[0] instanceof Error)).toBe(true);
    expect(healthyRelease).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "postgres_transport_recovery",
      level: "warn"
    });
  });

  it("does not restart a transaction for a Postgres application error", async () => {
    const release = vi.fn();
    let connects = 0;
    const client = {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release
    };
    const pool = makePool(
      async () => ({ rows: [] }),
      async () => {
        connects += 1;
        return client;
      }
    );
    const postgresError = Object.assign(new Error("duplicate key value"), {
      code: "23505"
    });

    await expect(
      withPostgresTransactionRecovery(pool, "dvm-host", "tempo_session.update", async () => {
        throw postgresError;
      })
    ).rejects.toBe(postgresError);

    expect(connects).toBe(1);
    expect(release).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("withInitRetry", () => {
  const NO_DELAY: number[] = [0, 0, 0];

  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      // suppress output during tests
    });
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("resolves immediately on success, no warnings", async () => {
    let calls = 0;
    await withInitRetry(
      async () => {
        calls++;
      },
      "test",
      NO_DELAY
    );
    expect(calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("retries multiple times and succeeds after N transport errors", async () => {
    let calls = 0;
    await withInitRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("Connection terminated unexpectedly");
      },
      "test",
      NO_DELAY
    );
    expect(calls).toBe(3);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[0]?.[0]).toBe('{"event":"diagnostic.message","level":"warn"}');
  });

  it("throws after exhausting all retries", async () => {
    const err = new Error("Connection terminated unexpectedly");
    let calls = 0;
    await expect(
      withInitRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        NO_DELAY
      )
    ).rejects.toBe(err);
    // 1 initial + 3 retries = 4 total attempts
    expect(calls).toBe(4);
    expect(warnSpy).toHaveBeenCalledTimes(3);
  });

  it("does not retry on a non-transport error", async () => {
    const err = Object.assign(new Error("duplicate key"), { code: "23505" });
    let calls = 0;
    await expect(
      withInitRetry(
        async () => {
          calls++;
          throw err;
        },
        "test",
        NO_DELAY
      )
    ).rejects.toBe(err);
    expect(calls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
