/**
 * The durable x402 batch store's transactional close, against
 * Postgres: the payout row is queued exactly when the batch row goes, and a
 * failed enqueue leaves the batch for the next settle. It runs in its own
 * schema so its durable queue assertions are isolated from the shared database.
 */
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  dropSchemas,
  pinnedPool,
  recreateSchema,
} from "../../../test-support/schema-isolation";
import { PostgresX402BatchStore, type X402OpenBatch } from "../payout-reporter";
import { RevenueReporter } from "../revenue-reporter";

const DATABASE_URL = process.env.DATABASE_URL ?? process.env.PLATFORM_DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "payout_reporter_sdk";
const SCOPE = "eip155:84532|0xpayto|0xusdc";

describe.skipIf(!RUN)("PostgresX402BatchStore.settle", () => {
  let pool: Pool;
  let store: PostgresX402BatchStore;
  let reporter: RevenueReporter;

  beforeAll(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
    store = new PostgresX402BatchStore(pool);
    await store.init();

    reporter = new RevenueReporter(pool, "http://127.0.0.1:9", "token");
    await reporter.init();
  }, 60_000);

  afterAll(async () => {
    reporter.stop();
    await pool.end();
    await dropSchemas(SCHEMA);
  });

  function batch(batchId: string): X402OpenBatch {
    return {
      scope: SCOPE,
      batchId,
      claimedNative: 1_500_000n,
      voucherCount: 4,
      claims: 2,
      openedAt: Date.now(),
      attempts: 0,
      firstFailedAt: null,
      lastError: null,
      nextRetryAt: null,
    };
  }

  async function queued(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM pending_dvm_reports WHERE kind = 'payout'"
    );
    return Number(rows[0].n);
  }

  it("queues the payout in the transaction that closes the batch", async () => {
    await store.put(batch("b-1"));
    const before = await queued();
    const closed = await store.settle(SCOPE, "b-1", (tx) =>
      reporter.enqueuePayout(
        {
          dvmId: "dvm",
          payoutId: "x402:batch:b-1",
          rail: "x402",
          kind: "batch",
          nativeAmount: 1_500_000,
          nativeAsset: "usdc",
          recipient: "0xpayto",
          refs: {},
          landedAt: Date.now(),
        },
        tx
      )
    );
    expect(closed).toBe(true);
    expect(await store.get(SCOPE)).toBeUndefined();
    expect(await queued()).toBe(before + 1);
  });

  it("keeps the batch when the enqueue throws, so the next settle reports it", async () => {
    await store.put(batch("b-2"));
    const before = await queued();
    await expect(
      store.settle(SCOPE, "b-2", async () => {
        throw new Error("outbox down");
      })
    ).rejects.toThrow("outbox down");
    expect(await store.get(SCOPE)).toMatchObject({ batchId: "b-2", claimedNative: 1_500_000n });
    expect(await queued()).toBe(before);

    await expect(
      store.settle(SCOPE, "b-2", (tx) =>
        (tx ?? pool)
          .query("INSERT INTO pending_dvm_reports (id) VALUES (NULL)")
          .then(() => undefined)
      )
    ).rejects.toThrow();
    expect(await store.get(SCOPE)).toMatchObject({ batchId: "b-2" });
    expect(await queued()).toBe(before);
    await store.delete(SCOPE);
  });

  it("refuses to close a batch a sibling already replaced, and queues nothing", async () => {
    await store.put(batch("b-3"));
    const enqueue = vi.fn(async () => undefined);
    expect(await store.settle(SCOPE, "b-older", enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
    expect(await store.get(SCOPE)).toMatchObject({ batchId: "b-3" });
    await store.delete(SCOPE);
  });
});
