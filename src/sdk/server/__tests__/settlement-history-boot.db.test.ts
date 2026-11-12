import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";

import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { createDVMHost } from "../host";
import { HostedSettlementReportObligations } from "../hosting-settlement-report-obligations";
import { MemoryJobStore } from "../memory-job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresTempoSessionStore } from "../tempo-session-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

function service(name: string) {
  return configureDVM({
    name, capability: "echo", tag: "test",
    onJob(ctx) { ctx.complete("done"); },
  });
}

describe.skipIf(!RUN)("settlement history at boot without hosting control (real Postgres)", () => {
  const schemas: string[] = [];
  const pools: Pool[] = [];
  const closers: Array<() => Promise<void>> = [];

  /** A pool on a fresh schema, or another pool on an existing one to stand in for a later process. */
  async function database(schema?: string): Promise<{ schema: string; pool: Pool }> {
    const name = schema ?? `settlement_boot_${randomUUID().slice(0, 8)}`;
    if (!schema) {
      await recreateSchema(name);
      schemas.push(name);
    }
    const pool = await pinnedPool(name);
    pools.push(pool);
    return { schema: name, pool };
  }

  async function evidence(pool: Pool, dvmId: string) {
    const tables = await pool.query<{ history: boolean; obligations: boolean; control: boolean }>(
      `SELECT to_regclass('sdk_hosted_settlement_report_history') IS NOT NULL AS history,
              to_regclass('sdk_hosted_settlement_report_obligations') IS NOT NULL AS obligations,
              to_regclass('sdk_hosting_control') IS NOT NULL AS control`
    );
    if (!tables.rows[0].history) return { ...tables.rows[0], complete: undefined, identity: [] };
    const history = await pool.query<{ complete: boolean }>(
      "SELECT complete FROM sdk_hosted_settlement_report_history"
    );
    const identity = await pool.query<{ scope: string; instance_id: string; boot_epoch: string }>(
      "SELECT scope,instance_id,boot_epoch FROM sdk_hosted_settlement_report_identity WHERE dvm_id=$1",
      [dvmId]
    );
    return { ...tables.rows[0], complete: history.rows[0]?.complete, identity: identity.rows };
  }

  /** A directly built server, as a caller without the host would assemble it. */
  async function serverOn(pool: Pool, dvmId: string, name: string): Promise<void> {
    const jobStore = new PostgresJobStore(pool);
    await jobStore.init();
    const server = await createDVMServer(service(name), {
      env: {}, store: new MemoryKVStore(), jobStore, db: pool, dvmId, devMode: true,
    });
    closers.push(server.shutdown);
  }

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close().catch(() => undefined);
    await Promise.all(pools.splice(0).map((pool) => pool.end().catch(() => undefined)));
    await dropSchemas(...schemas.splice(0));
  });

  it("a directly built server establishes complete history on a fresh database", async () => {
    const { pool } = await database();
    const dvmId = `dvm-${randomUUID()}`;
    await serverOn(pool, dvmId, "history-direct");
    expect(await evidence(pool, dvmId)).toMatchObject({
      history: true, obligations: true, control: false, complete: true,
      identity: [{ boot_epoch: "1" }],
    });
  });

  it("a host with several mounts establishes complete history once and keeps its identity across a restart", async () => {
    const first = await database();
    const dvmId = `dvm-${randomUUID()}`;
    const boot = async (pool: Pool) => {
      const host = createDVMHost({ devMode: true, port: 0, pool, env: { DVMKIT_DVM_ID: dvmId } });
      host.mount(service("history-a"), { prefix: "/a" });
      host.mount(service("history-b"), { prefix: "/b" });
      const served = await host.serve();
      closers.push(served.close);
      return served;
    };
    await boot(first.pool);
    const booted = await evidence(first.pool, dvmId);
    expect(booted).toMatchObject({ history: true, obligations: true, control: false, complete: true,
      identity: [{ boot_epoch: "1" }] });

    const restarted = await database(first.schema);
    await boot(restarted.pool);
    const after = await evidence(restarted.pool, dvmId);
    expect(after.complete).toBe(true);
    expect(after.identity).toEqual([{ ...booted.identity[0], boot_epoch: "2" }]);
  });

  it("a host given its own job store still initializes history on the supplied database", async () => {
    const { pool } = await database();
    const dvmId = `dvm-${randomUUID()}`;
    const host = createDVMHost({ devMode: true, port: 0, pool, jobStore: new MemoryJobStore(),
      env: { DVMKIT_DVM_ID: dvmId } });
    host.mount(service("history-custom-store"));
    const served = await host.serve();
    closers.push(served.close);
    expect(await evidence(pool, dvmId)).toMatchObject({
      history: true, obligations: true, complete: true, identity: [{ boot_epoch: "1" }],
    });
  });

  it("an earlier financial table keeps history incomplete through restarts, emptied rows and a lost marker", async () => {
    const first = await database();
    const dvmId = `dvm-${randomUUID()}`;
    await new PostgresTempoSessionStore(first.pool).init();
    const boot = (pool: Pool) => serverOn(pool, dvmId, "history-earlier");
    await boot(first.pool);
    expect((await evidence(first.pool, dvmId)).complete).toBe(false);

    await first.pool.query("DELETE FROM mpp_tempo_channels");
    const restarted = await database(first.schema);
    await boot(restarted.pool);
    expect((await evidence(restarted.pool, dvmId)).complete).toBe(false);

    await restarted.pool.query("DELETE FROM sdk_hosted_settlement_report_history");
    const recovered = await database(first.schema);
    await boot(recovered.pool);
    expect((await evidence(recovered.pool, dvmId)).complete).toBe(false);
  });

  it("competing first boots agree on one reporting identity and one complete marker", async () => {
    const first = await database();
    const second = await database(first.schema);
    const dvmId = `dvm-${randomUUID()}`;
    await Promise.all([first.pool, second.pool].map((pool) =>
      new HostedSettlementReportObligations(pool, dvmId).init()));
    const settled = await evidence(first.pool, dvmId);
    expect(settled.complete).toBe(true);
    expect(settled.identity).toMatchObject([{ scope: "default", boot_epoch: "2" }]);
  });
});
