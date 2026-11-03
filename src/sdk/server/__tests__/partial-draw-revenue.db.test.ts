/* Revenue for a job that did not complete but whose draw settled in part, on Postgres stores. */
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { describePartialDrawRevenue } from "./__helpers__/partial-draw-revenue";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "sdk_partial_draw_revenue";

describe.skipIf(!RUN)("partly settled draw revenue (Postgres job store)", () => {
  let pool: pg.Pool;
  let jobStore: PostgresJobStore;
  let ledger: CreditLedger;

  beforeAll(async () => {
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${SCHEMA}"`);
    await admin.end();
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${SCHEMA}` });
    jobStore = new PostgresJobStore(pool);
    ledger = new CreditLedger(pool);
    await jobStore.init();
    await ledger.init();
  });

  afterEach(async () => {
    await pool.query("TRUNCATE jobs, credit_draws, credit_funding_lots, credit_fundings, credits CASCADE");
  });

  afterAll(async () => {
    await pool.end();
    const admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.end();
  });

  describePartialDrawRevenue(() => Promise.resolve({ jobStore, ledger }));
});
