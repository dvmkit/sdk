import { EventEmitter } from "node:events";

import pg, { type Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PostgresJobStore } from "../../sdk/server/postgres-job-store";
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

  it.each([
    ["query", 3],
    ["query", 10],
    ["claim", 3],
    ["claim", 10],
    ["callback", 3],
  ] as const)("recovers the first %s through %i stale idle clients", async (boundary, size) => {
    const clients: TransportClient[] = [];
    const statements: string[] = [];
    // Only the transport is simulated: pg owns checkout, eviction, release and replacement.
    class TransportClient extends EventEmitter {
      _queryable = true;
      _ending = false;
      stale = false;

      constructor() {
        super();
        clients.push(this);
      }

      connect(callback: (error?: Error) => void): void {
        queueMicrotask(() => callback());
      }

      query(config: string | { text: string }, _values?: unknown, callback?: (error?: unknown, result?: unknown) => void): Promise<unknown> | void {
        const execute = () => {
          if (this.stale) throw new Error("Connection terminated unexpectedly");
          const text = typeof config === "string" ? config : config.text;
          statements.push(text);
          if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
          if (text.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }] };
          if (text.includes("INSERT INTO request_id_claims")) {
            return { rows: [{ job_id: "job-recovery" }], rowCount: 1 };
          }
          return { rows: [{ n: 1 }] };
        };
        if (!callback) return Promise.resolve().then(execute);
        const done = callback;
        queueMicrotask(() => {
          try {
            done(undefined, execute());
          } catch (error) {
            done(error);
          }
        });
      }

      end(callback?: () => void): void {
        this._ending = true;
        queueMicrotask(() => {
          this.emit("end");
          callback?.();
        });
      }
    }

    const pool = new pg.Pool({
      max: size,
      idleTimeoutMillis: 0,
      Client: TransportClient as unknown as typeof pg.Client,
    });
    applyRetryToPool(pool, "test");
    try {
      const checkedOut = await Promise.all(Array.from({ length: size }, () => pool.connect()));
      for (const client of clients) client.stale = true;
      for (const client of checkedOut) client.release();
      expect(pool.idleCount).toBe(size);

      if (boundary === "claim") {
        const store = new PostgresJobStore(pool);
        const claim = {
          requestId: "request-recovery",
          requesterPubkey: "11".repeat(32),
          requesterId: "caller-recovery",
          requestFingerprint: "22".repeat(32),
          jobId: "job-recovery",
          claimToken: "claim-recovery",
        };
        try {
          await expect(store.claimRequestId(claim)).resolves.toEqual({
            jobId: "job-recovery", replayed: false,
          });
          expect(statements.filter((text) => text.includes("INSERT INTO request_id_claims"))).toHaveLength(1);
        } finally {
          await store.releaseRequestIdClaim(claim);
        }
      } else if (boundary === "callback") {
        const client = await new Promise<pg.PoolClient>((resolve, reject) => {
          pool.connect((error, checkedOut) => {
            if (error) reject(error);
            else resolve(checkedOut!);
          });
        });
        try {
          await expect(client.query("SELECT 1 AS n")).resolves.toMatchObject({ rows: [{ n: 1 }] });
        } finally {
          client.release();
        }
      } else {
        await expect(pool.query("SELECT 1 AS n")).resolves.toMatchObject({ rows: [{ n: 1 }] });
      }

      expect(clients).toHaveLength(size + 1);
      expect(clients.slice(0, size).every((client) => client._ending)).toBe(true);
      expect(pool.totalCount).toBe(1);
      expect(pool.idleCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("times out a stalled checkout probe through the pg driver", async () => {
    // A disconnected pg client queues the probe without ever answering it.
    const client = new pg.Client({ host: "db.example.com", user: "test", database: "test" });
    const release = vi.fn(() => { void client.end(); });
    const pool = makePool(async () => ({ rows: [] }), async () => Object.assign(client, { release }));
    pool.options.connectionTimeoutMillis = 20;
    applyRetryToPool(pool, "test");

    await expect(pool.connect()).rejects.toThrow("Query read timeout");
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]).toEqual([expect.any(Error)]);
  });

  it("does not replay business queries after a client has been exposed", async () => {
    const error = new Error("Connection terminated unexpectedly");
    const query = vi.fn(async (config: unknown) => {
      if (typeof config === "string") throw error;
      return { rows: [] };
    });
    const client = { query, release: vi.fn() };
    const connect = vi.fn(async () => client);
    const pool = makePool(async () => ({ rows: [] }), connect);
    applyRetryToPool(pool, "test");

    const checkedOut = await pool.connect();
    try {
      await expect(checkedOut.query("INSERT INTO example VALUES (1)")).rejects.toBe(error);
      expect(query.mock.calls.filter(([config]) => typeof config === "string"))
        .toEqual([["INSERT INTO example VALUES (1)"]]);
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      checkedOut.release();
    }
  });

  it.each(["promise", "callback"])("bounds failed checkout probes using %s checkout", async (mode) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const error = new Error("Connection terminated unexpectedly");
    const release = vi.fn();
    const connect = vi.fn(async () => ({
      query: async () => {
        now += 60;
        throw error;
      },
      release,
    }));
    const pool = makePool(async () => ({ rows: [] }), connect);
    pool.options.connectionTimeoutMillis = 100;
    applyRetryToPool(pool, "test");
    try {
      const checkout = mode === "promise" ? pool.connect() : new Promise((resolve, reject) => {
        pool.connect((failure, client) => failure ? reject(failure) : resolve(client));
      });
      await expect(checkout).rejects.toBe(error);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(release.mock.calls).toEqual([[error], [error]]);
      expect(now - 1_000).toBeLessThanOrEqual(200);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([undefined, 100])("stops slow connection retries within the timeout envelope (%s)", async (timeout) => {
    let now = 1_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const error = new Error("Connection terminated due to connection timeout");
    let calls = 0;
    const pool = makePool(async () => {
      calls += 1;
      now += timeout === undefined ? 6_000 : 60;
      throw error;
    });
    pool.options.max = 10;
    pool.options.connectionTimeoutMillis = timeout;
    applyRetryToPool(pool, "test");
    try {
      await expect(pool.query("SELECT 1")).rejects.toBe(error);
      expect(calls).toBe(2);
      expect(now - 1_000).toBeLessThanOrEqual(2 * (timeout ?? 10_000));
    } finally {
      clock.mockRestore();
    }
  });

  it("caps immediate persistent transport failures at one pool replacement", async () => {
    let calls = 0;
    const error = new Error("Connection terminated unexpectedly");
    const pool = makePool(async () => {
      calls += 1;
      throw error;
    });
    pool.options.max = 3;
    applyRetryToPool(pool, "test");

    await expect(pool.query("SELECT 1")).rejects.toBe(error);
    expect(calls).toBe(4);
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
