/* Charging by the piece on the Postgres job store and ledger; the in-memory runner shares the suite. */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, vi } from "vitest";

import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { pieceSettlementSuite } from "./__helpers__/piece-settlement";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("Postgres", () => {
  const schema = `piece_settlement_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
    await new CreditLedger(pool).init();
    await new PostgresJobStore(pool).init();
    await new PostgresProcessedPaymentStore(pool).init();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  pieceSettlementSuite("charging by the piece, Postgres stores", vi.mocked(verifyX402Payment) as never, async () => {
    const jobStore = new PostgresJobStore(pool);
    await jobStore.initStreaming();
    return {
      jobStore,
      ledger: new CreditLedger(pool),
      processedPayments: new PostgresProcessedPaymentStore(pool),
      forgetPieces: async (jobId: string) => {
        await pool.query("UPDATE jobs SET pieces = NULL WHERE id = $1", [jobId]);
      },
      close: () => jobStore.shutdownStreaming(),
    };
  });
});
