import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe } from "vitest";

import { PostgresJobStore } from "../postgres-job-store";
import { pieceStoreContract } from "./__helpers__/piece-store-contract";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("Postgres job store", () => {
  const schema = `piece_store_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  pieceStoreContract("Postgres store", () => Promise.resolve(store));
});
