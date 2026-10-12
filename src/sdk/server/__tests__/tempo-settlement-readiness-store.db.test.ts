import { randomUUID } from "node:crypto";

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TempoSettlementFailureState } from "../tempo-settlement-readiness";
import { PostgresTempoSettlementReadinessStore } from "../tempo-settlement-readiness-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const TOKEN = "0x2222222222222222222222222222222222222222" as const;

function versionOf(state: TempoSettlementFailureState): string {
  if (!state.version) throw new Error("expected a versioned failure latch");
  return state.version;
}

describe.skipIf(!RUN)("PostgresTempoSettlementReadinessStore", () => {
  let pool: Pool;

  beforeAll(async () => {
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("shares one latch across replicas and clears only on proof of recovery", async () => {
    const options = { dvmId: randomUUID(), address: ADDRESS, token: TOKEN };
    const first = new PostgresTempoSettlementReadinessStore(pool, options);
    const sibling = new PostgresTempoSettlementReadinessStore(pool, options);
    await first.init();

    await expect(sibling.readFailure()).resolves.toEqual({ latched: false });
    const failure = await first.latchFailure();
    const failureVersion = versionOf(failure);
    await expect(sibling.readFailure()).resolves.toEqual(failure);

    await sibling.captureFailureBalance(failureVersion, 100_000n);
    await first.captureFailureBalance(failureVersion, 200_000n);
    await expect(first.readFailure()).resolves.toEqual({
      ...failure,
      balanceMicro: 100_000n,
    });

    await expect(sibling.clearFailureIfRefilled(failureVersion, 100_000n, 10_000n)).resolves.toBe(
      false
    );
    await expect(sibling.readFailure()).resolves.toEqual({
      ...failure,
      balanceMicro: 100_000n,
    });

    await expect(sibling.clearFailureIfRefilled(failureVersion, 100_001n, 10_000n)).resolves.toBe(
      true
    );
    await expect(first.readFailure()).resolves.toEqual({ latched: false });
  });

  it("starts a fresh latch epoch after recovery and after operator rotation", async () => {
    const dvmId = randomUUID();
    const first = new PostgresTempoSettlementReadinessStore(pool, {
      dvmId,
      address: ADDRESS,
      token: TOKEN,
    });
    const rotated = new PostgresTempoSettlementReadinessStore(pool, {
      dvmId,
      address: "0x3333333333333333333333333333333333333333",
      token: TOKEN,
    });
    await first.init();
    const initial = await first.latchFailure();
    const initialVersion = versionOf(initial);
    await first.captureFailureBalance(initialVersion, 50_000n);
    await first.clearFailureAfterSuccessfulTransaction(initialVersion);
    const next = await first.latchFailure();

    await expect(first.readFailure()).resolves.toEqual(next);
    await expect(rotated.readFailure()).resolves.toEqual({ latched: false });
  });

  it("does not let an older recovery erase a newer failure version", async () => {
    const store = new PostgresTempoSettlementReadinessStore(pool, {
      dvmId: randomUUID(),
      address: ADDRESS,
      token: TOKEN,
    });
    await store.init();
    const older = await store.latchFailure();
    const olderVersion = versionOf(older);
    await store.captureFailureBalance(olderVersion, 100_000n);
    const newer = await store.latchFailure();

    await expect(store.clearFailureIfRefilled(olderVersion, 100_001n, 10_000n)).resolves.toBe(
      false
    );
    await expect(store.clearFailureAfterSuccessfulTransaction(olderVersion)).resolves.toBe(false);
    await expect(store.readFailure()).resolves.toEqual(newer);
  });
});
