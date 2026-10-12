import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresJobStore } from "../src/sdk/server/postgres-job-store";

const databaseUrl = process.env.DATABASE_URL;
const RUN = !!databaseUrl && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(databaseUrl);
const schema = `sdk_package_${randomUUID().replaceAll("-", "")}`;
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;
const storePool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema}`,
    })
  : undefined;

describe.skipIf(!RUN)("isolated SDK Postgres boundary", () => {
  beforeAll(async () => {
    await adminPool?.query(`CREATE SCHEMA "${schema}"`);
  });

  afterAll(async () => {
    await storePool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool?.end();
  });

  it("boots the SDK-owned job-store schema without platform migrations", async () => {
    if (!storePool) throw new Error("DATABASE_URL is required for the SDK package DB test");
    const store = new PostgresJobStore(storePool);
    await store.init();
    const result = await storePool.query<{ name: string }>(
      "SELECT tablename AS name FROM pg_tables WHERE schemaname = $1 ORDER BY tablename",
      [schema]
    );
    expect(result.rows.map((row) => row.name)).toEqual([
      "job_content_hold_events",
      "job_content_holds",
      "job_messages",
      "jobs",
      "receipt_counter",
      "request_id_claims",
    ]);
  });
});
