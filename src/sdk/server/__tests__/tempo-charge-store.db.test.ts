/**
 * The guard under test is mppx's, not ours: `tempo.charge`'s `markHashUsed` is
 * exactly one `update(key, cur => cur === null ? set : noop)` against the store
 * it is handed, and it runs *before* the broadcast. So the store's CAS is the
 * whole refusal, and the acceptance question — "does a credential re-presented
 * to a second machine get refused?" — is answerable here without a chain.
 * One test drives mppx itself rather than a copy of that CAS, so the contract
 * is pinned in the database suite; `money-loop:tempo`, which broadcasts for
 * real, runs outside per-change CI.
 *
 * Two pools rather than two stores on one pool: one Pool is one machine, the
 * idiom `tempo-session-store.db.test.ts` and `cross-machine-cancel.db.test.ts`
 * both use.
 */
import { randomBytes } from "node:crypto";

import { Credential, type Store } from "mppx";
import { tempo as tempoClient } from "mppx/client";
import { Mppx, tempo } from "mppx/server";
import pg from "pg";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresTempoChargeStore } from "../tempo-charge-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const TEST_TABLE = "mpp_tempo_charge_replays_test";
const HASH_KEY = `mppx:charge:0x${"ab".repeat(32)}`;
const BUDGET_KEY = "mppx:charge:sponsor-budget:42431:0xfeed";

// Zero-amount so the credential signs and verifies offline (no RPC, no
// settlement) — the same trick `payment-mpp-roundtrip.test.ts` uses.
const CURRENCY = "0x20C000000000000000000000b9537d11c60E8b50";
const REALM = "tempo-charge-store.db";

/**
 * One machine's mppx handle. Two of these over two stores, sharing a realm and
 * a secret so either can verify a credential the other issued, are a fleet
 * behind a load balancer.
 */
function machine(store: Store.AtomicStore, secretKey: string, recipient: `0x${string}`) {
  return Mppx.create({
    methods: [tempo.charge({ recipient, currency: CURRENCY, decimals: 6, store })],
    secretKey,
    realm: REALM,
  });
}

/** mppx's `markHashUsed`, verbatim — first taker wins, everyone after is refused. */
async function markUsed(store: PostgresTempoChargeStore, key: string): Promise<boolean> {
  return store.update(key, (current) => {
    if (current !== null) return { op: "noop", result: false };
    return { op: "set", value: Date.now(), result: true };
  });
}

(RUN ? describe : describe.skip)("PostgresTempoChargeStore (real Postgres)", () => {
  let poolA: pg.Pool;
  let poolB: pg.Pool;
  let machineA: PostgresTempoChargeStore;
  let machineB: PostgresTempoChargeStore;

  beforeAll(async () => {
    poolA = new pg.Pool({ connectionString: DATABASE_URL });
    poolB = new pg.Pool({ connectionString: DATABASE_URL });
    // gcSampleRate: 0 — GC has its own test at rate 1, so the shared instances
    // never race a DELETE against another test's SELECT.
    machineA = new PostgresTempoChargeStore(poolA, { tableName: TEST_TABLE, gcSampleRate: 0 });
    machineB = new PostgresTempoChargeStore(poolB, { tableName: TEST_TABLE, gcSampleRate: 0 });
    await machineA.init();
  });

  afterAll(async () => {
    await poolA.query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
    await Promise.all([poolA.end(), poolB.end()]);
  });

  beforeEach(async () => {
    await poolA.query(`TRUNCATE ${TEST_TABLE}`);
  });

  it("init() is idempotent across machines", async () => {
    await machineA.init();
    await machineB.init();
    const { rows } = await poolA.query<{ exists: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1) AS exists`,
      [TEST_TABLE]
    );
    expect(rows[0]?.exists).toBe(true);
  });

  it("mppx itself refuses a credential re-presented to a second machine", async () => {
    // `markUsed` above is a hand-copy, so it would keep passing if mppx moved
    // its key shape or its CAS contract. This drives the real thing: two mppx
    // handles, one per store, one credential presented to each. It is the proof
    // keyspace rather than the hash one because only a zero-amount credential
    // verifies without a chain — and that guard is off entirely until a store
    // is supplied, so this pins the side effect of the fix as well.
    const recipient = privateKeyToAccount(generatePrivateKey()).address;
    const payer = privateKeyToAccount(generatePrivateKey());
    const secretKey = randomBytes(32).toString("hex");
    const mppxA = machine(machineA, secretKey, recipient);
    const mppxB = machine(machineB, secretKey, recipient);

    const challenge = await mppxA.challenge.tempo.charge({ amount: "0" });
    const clientMethod = tempoClient.charge({ account: payer });
    type ClientChallenge = Parameters<typeof clientMethod.createCredential>[0]["challenge"];
    const credential = Credential.deserialize(
      await clientMethod.createCredential({
        challenge: challenge as ClientChallenge,
        context: { account: payer },
      })
    );

    const receipt = await mppxA.broadcastCredential(credential);
    expect(receipt.status).toBe("success");
    // The row mppx wrote is ours, under its own key shape.
    expect(await machineB.get(`mppx:charge:proof:${challenge.id}`)).not.toBeNull();

    await expect(mppxB.broadcastCredential(credential)).rejects.toThrow(/already been used/i);
  });

  it("elects exactly one winner when both machines mark one hash at once", async () => {
    // The first write of a key is the race that `FOR UPDATE` alone cannot cover
    // there is no row to lock — so this is what the advisory lock buys.
    const results = await Promise.all([
      markUsed(machineA, HASH_KEY),
      markUsed(machineB, HASH_KEY),
      markUsed(machineA, HASH_KEY),
      markUsed(machineB, HASH_KEY),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await markUsed(machineA, HASH_KEY)).toBe(false);
    expect(await markUsed(machineB, HASH_KEY)).toBe(false);
  });

  it("a released hash is markable again (mppx's compensating delete)", async () => {
    expect(await markUsed(machineA, HASH_KEY)).toBe(true);
    // `releaseHashUse` — mppx unwinds the marker when a broadcast never left.
    await machineA.delete(HASH_KEY);
    expect(await machineB.get(HASH_KEY)).toBeNull();
    expect(await markUsed(machineB, HASH_KEY)).toBe(true);
  });

  it("distinct keys are independent", async () => {
    expect(await markUsed(machineA, HASH_KEY)).toBe(true);
    expect(await markUsed(machineB, `${HASH_KEY}beef`)).toBe(true);
    expect(await markUsed(machineB, "mppx:charge:proof:challenge-1")).toBe(true);
  });

  it("round-trips the sponsor-budget state object mppx shares this store for", async () => {
    // Same raw store, unprefixed keyspace, object values (`Charge.ts:81`).
    const state = {
      reservations: {
        "0xdead": {
          expiresAt: 1_700_000_025_000,
          fee: "18000000000000000",
          leaseUntil: 1_700_000_030_000,
          owner: "owner-1",
          phase: "prepared",
          transactionHash: "0xdead",
        },
      },
      version: 1,
    };
    await machineA.put(BUDGET_KEY, state);
    expect(await machineB.get(BUDGET_KEY)).toEqual(state);

    // The read-modify-write `SponsorBudget.reserve` performs, across machines.
    await machineB.update(BUDGET_KEY, (current) => {
      const reservations = { ...(current as typeof state).reservations, "0xbeef": { fee: "1" } };
      return { op: "set", value: { reservations, version: 1 }, result: undefined };
    });
    const merged = (await machineA.get(BUDGET_KEY)) as { reservations: Record<string, unknown> };
    expect(Object.keys(merged.reservations).sort()).toEqual(["0xbeef", "0xdead"]);
  });

  it("round-trips a bigint value", async () => {
    // mppx's charge values are plain JSON today; the tagging keeps a future
    // shape from taking the rail down with a `JSON.stringify` throw.
    await machineA.put(BUDGET_KEY, { fee: 18_000_000_000_000_000n });
    expect(await machineB.get(BUDGET_KEY)).toEqual({ fee: 18_000_000_000_000_000n });
  });

  it("a noop update leaves no row", async () => {
    await machineA.update(HASH_KEY, () => ({ op: "noop", result: undefined }));
    expect(await machineA.get(HASH_KEY)).toBeNull();
  });

  it("GC sweeps rows past their retention and keeps the rest", async () => {
    const clock = 1_700_000_000_000;
    const gcStore = new PostgresTempoChargeStore(poolA, {
      tableName: TEST_TABLE,
      gcSampleRate: 1,
      now: () => clock,
    });
    await poolA.query(
      `INSERT INTO ${TEST_TABLE} (store_key, value_json, expires_at) VALUES ($1, $2, $3)`,
      ["stale", "1", clock - 1000]
    );
    await poolA.query(
      `INSERT INTO ${TEST_TABLE} (store_key, value_json, expires_at) VALUES ($1, $2, $3)`,
      ["fresh", "1", clock + 600_000]
    );
    await markUsed(gcStore, HASH_KEY);

    const deadline = Date.now() + 2000;
    let staleCount = 1;
    while (Date.now() < deadline) {
      const { rows } = await poolA.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE store_key = 'stale'`
      );
      staleCount = Number(rows[0]?.count ?? "1");
      if (staleCount === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(staleCount).toBe(0);

    const { rows: fresh } = await poolA.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${TEST_TABLE} WHERE store_key = 'fresh'`
    );
    expect(Number(fresh[0]?.count ?? "0")).toBe(1);
  });

  it("a write refreshes the row's retention rather than aging it out", async () => {
    let clock = 1_700_000_000_000;
    const ttlStore = new PostgresTempoChargeStore(poolA, {
      tableName: TEST_TABLE,
      gcSampleRate: 0,
      retentionMs: 60_000,
      now: () => clock,
    });
    await ttlStore.put(BUDGET_KEY, { version: 1 });
    clock += 30_000;
    await ttlStore.put(BUDGET_KEY, { version: 1 });
    const { rows } = await poolA.query<{ expires_at: string }>(
      `SELECT expires_at FROM ${TEST_TABLE} WHERE store_key = $1`,
      [BUDGET_KEY]
    );
    expect(Number(rows[0]?.expires_at)).toBe(clock + 60_000);
  });
});
