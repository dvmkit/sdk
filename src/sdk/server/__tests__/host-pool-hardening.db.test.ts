/**
 * the SDK host pool must be hardened for Fly
 * suspend/resume and deliberately sized — a
 * resumed machine sees a wall-clock jump and dead TCP sockets, so the pool
 * needs keepAlive (fast dead-socket detection) + applyRetryToPool (re-dial on
 * the first post-resume query instead of a stale-connection 5xx). This asserts
 * host.ts wires both onto the production PostgresJobStore pool; the retry
 * behaviour itself is covered by src/lib/__tests__/pg-retry.test.ts.
 */
import { afterEach, describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { createDVMHost } from "../host";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("SDK host pool hardening for suspend/resume", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it("constructs the host pool with keepAlive + retry wiring", async () => {
    const dvm = configureDVM({
      name: "pool-hardening",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({ devMode: true, port: 0, env: {}, database: DATABASE_URL });
    host.mount(dvm);
    server = await host.serve();

    const pool = host.pool;
    expect(pool).toBeDefined();
    if (!pool) return;

    // keepAlive so a dead post-resume socket surfaces fast (and the dedicated
    // LISTEN client re-connects promptly); matches the platform/router pools.
    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.keepAlive).toBe(true);
    expect(options.keepAliveInitialDelayMillis).toBe(10_000);
    expect(options.idleTimeoutMillis).toBe(30_000);
    expect(options.max).toBe(10);

    // this pool is shared by /v1/job, the job store, KV, the credit
    // ledger and the x402 channel store, so exhaustion has to surface as an
    // error rather than an unbounded queue nobody can see.
    expect(options.connectionTimeoutMillis).toBe(10_000);

    const backend = await pool.query<{ application_name: string }>(
      `SELECT application_name
         FROM pg_stat_activity
        WHERE pid = pg_backend_pid()`
    );
    expect(backend.rows[0]?.application_name).toBe(options.application_name);

    const listener = await pool.query<{ application_name: string }>(
      `SELECT application_name
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND query LIKE 'LISTEN job_messages%'
          AND application_name = $1`,
      [options.application_name]
    );
    expect(listener.rows.length).toBeGreaterThan(0);

    // applyRetryToPool shadows query/connect as own properties on the instance
    // (the retrying wrappers) — on a bare pg.Pool both live on the prototype.
    expect(Object.prototype.hasOwnProperty.call(pool, "query")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(pool, "connect")).toBe(true);
  });

  it("applies a positive integer host-pool override", async () => {
    const dvm = configureDVM({
      name: "pool-override",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: { DVMKIT_POSTGRES_POOL_MAX: "3" },
      database: DATABASE_URL,
    });
    host.mount(dvm);
    server = await host.serve();

    const pool = host.pool;
    expect(pool).toBeDefined();
    if (!pool) return;

    const options = (pool as unknown as { options: Record<string, unknown> }).options;
    expect(options.max).toBe(3);
  });

  it.each(["0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid host-pool override (%s) at boot",
    async (poolMax) => {
      const dvm = configureDVM({
        name: "pool-invalid",
        capability: "test",
        tag: "test",
        onJob(ctx) {
          ctx.complete("ok");
        },
      });

      const host = createDVMHost({
        devMode: true,
        port: 0,
        env: { DVMKIT_POSTGRES_POOL_MAX: poolMax },
        database: DATABASE_URL,
      });
      host.mount(dvm);

      await expect(host.serve()).rejects.toThrow(
        `DVMKIT_POSTGRES_POOL_MAX must be a positive integer; got '${poolMax}'.`
      );
    }
  );

  it("leaves an injected pool's size and lifecycle caller-owned", async () => {
    const pg = await import("pg");
    const suppliedPool = new pg.default.Pool({ connectionString: DATABASE_URL, max: 13 });
    const dvm = configureDVM({
      name: "pool-injected",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });

    try {
      const host = createDVMHost({
        devMode: true,
        port: 0,
        env: { DVMKIT_POSTGRES_POOL_MAX: "7" },
        pool: suppliedPool,
      });
      host.mount(dvm);
      server = await host.serve();

      expect(host.pool).toBe(suppliedPool);
      expect((suppliedPool as unknown as { options: Record<string, unknown> }).options.max).toBe(
        13
      );

      await server.close();
      server = undefined;
      await expect(suppliedPool.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      if (server) {
        await server.close();
        server = undefined;
      }
      await suppliedPool.end();
    }
  });

  it("leaves an injected pool open when boot fails", async () => {
    const pg = await import("pg");
    const suppliedPool = new pg.default.Pool({ connectionString: DATABASE_URL });
    const bootFailure = new Error("descriptor boot failed");
    const dvm = configureDVM({
      name: "pool-injected-boot-failure",
      capability: "test",
      tag: "test",
      onBoot() {
        throw bootFailure;
      },
      onJob(ctx) {
        ctx.complete("never");
      },
    });

    try {
      const host = createDVMHost({
        devMode: true,
        port: 0,
        env: {},
        pool: suppliedPool,
      });
      host.mount(dvm);

      await expect(host.serve()).rejects.toBe(bootFailure);
      await expect(suppliedPool.query("SELECT 1")).resolves.toBeDefined();
    } finally {
      await suppliedPool.end();
    }
  });

  it("closes the host-owned pool when boot fails", async () => {
    let ownedPool: import("pg").Pool | undefined;
    const bootFailure = new Error("descriptor boot failed");
    const dvm = configureDVM({
      name: "pool-owned-boot-failure",
      capability: "test",
      tag: "test",
      onBoot() {
        ownedPool = host.pool;
        throw bootFailure;
      },
      onJob(ctx) {
        ctx.complete("never");
      },
    });
    const host = createDVMHost({
      devMode: true,
      port: 0,
      env: {},
      database: DATABASE_URL,
    });
    host.mount(dvm);

    await expect(host.serve()).rejects.toBe(bootFailure);

    if (!ownedPool) throw new Error("onBoot did not observe the host-owned pool");
    await expect(ownedPool.query("SELECT 1")).rejects.toThrow(/pool after calling end/i);
  });
});
