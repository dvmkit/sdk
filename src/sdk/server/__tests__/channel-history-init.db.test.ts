/* Real Postgres: the x402 and Tempo channel stores decide once, at first initialization, whether
 * their history is complete, serialize that decision against concurrent writes, and pin the chain
 * an x402 channel was first written on. */
import { randomUUID } from "node:crypto";

import pg from "pg";
import { BATCH_SETTLEMENT_ADDRESS } from "@x402/evm";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresTempoSessionStore } from "../tempo-session-store";
import { PostgresX402ChannelStorage } from "../x402-channel-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

describe.skipIf(!RUN)("channel store history and chain binding (real Postgres)", () => {
  const schema = `channel_history_${randomUUID().slice(0, 8)}`;
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let x402Storage: PostgresX402ChannelStorage;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: DATABASE_URL });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    x402Storage = new PostgresX402ChannelStorage(pool);
    await x402Storage.init();
  });

  afterAll(async () => {
    await x402Storage.close();
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });

  it("keeps empty pre-instrumentation channel tables historically unknown", async () => {
    const oldSchema = `channel_old_${randomUUID().slice(0, 8)}`;
    await adminPool.query(`CREATE SCHEMA ${oldSchema}`);
    const oldPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${oldSchema}` });
    const oldX402 = new PostgresX402ChannelStorage(oldPool, { hostedNetwork: "eip155:84532" });
    const oldTempo = new PostgresTempoSessionStore(oldPool);
    try {
      await adminPool.query(`CREATE TABLE ${oldSchema}.x402_batch_channels
        (LIKE ${schema}.x402_batch_channels)`);
      await adminPool.query(`CREATE TABLE ${oldSchema}.mpp_tempo_channels
        (channel_key TEXT PRIMARY KEY,state_json TEXT NOT NULL,updated_at BIGINT NOT NULL)`);
      await Promise.all([oldX402.init(), oldTempo.init()]);
      await Promise.all([oldX402.init(), oldTempo.init()]);
      const markers = await oldPool.query<{ x402: boolean; tempo: boolean }>(
        `SELECT (SELECT complete FROM x402_batch_channel_history WHERE singleton) AS x402,
                (SELECT complete FROM mpp_tempo_channel_history WHERE singleton) AS tempo`
      );
      expect(markers.rows[0]).toEqual({ x402: false, tempo: false });
    } finally {
      await oldX402.close();
      await oldPool.end();
      await adminPool.query(`DROP SCHEMA ${oldSchema} CASCADE`);
    }
  });

  it("serializes fresh channel history initialization ahead of concurrent writes and deletions", async () => {
    const freshSchema = `channel_fresh_${randomUUID().slice(0, 8)}`;
    const channelId = `0x${"ea".repeat(32)}`;
    await adminPool.query(`CREATE SCHEMA ${freshSchema}`);
    const freshPool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${freshSchema}` });
    const first = new PostgresTempoSessionStore(freshPool);
    const second = new PostgresTempoSessionStore(freshPool);
    try {
      await Promise.all([first.init(), second.init().then(async () => {
        await second.put(channelId, { channelId, highestVoucherAmount: 1n, spent: 0n,
          settledOnChain: 0n, deposit: 1n, closeRequestedAt: 0n, finalized: false });
        await second.delete(channelId);
      })]);
      const result = await freshPool.query<{ complete: boolean; tombstones: string }>(
        `SELECT (SELECT complete FROM mpp_tempo_channel_history WHERE singleton) AS complete,
                (SELECT COUNT(*)::text FROM mpp_tempo_channel_tombstones) AS tombstones`
      );
      expect(result.rows[0]).toEqual({ complete: true, tombstones: "1" });
      await first.init();
      const retained = await freshPool.query<{ complete: boolean; state_json: string }>(
        `SELECT h.complete,t.state_json FROM mpp_tempo_channel_history h
         JOIN mpp_tempo_channel_tombstones t ON t.channel_key=$1`, [channelId]
      );
      expect(retained.rows[0].complete).toBe(true);
      expect(retained.rows[0].state_json).toContain(channelId);
    } finally {
      await freshPool.end();
      await adminPool.query(`DROP SCHEMA ${freshSchema} CASCADE`);
    }
  });

  it("retains the first hosted x402 chain binding across concurrent first writes and later updates", async () => {
    const channelId = `0x${"ce".repeat(32)}`;
    const sepolia = new PostgresX402ChannelStorage(pool, { hostedNetwork: "eip155:84532" });
    const mainnet = new PostgresX402ChannelStorage(pool, { hostedNetwork: "eip155:8453" });
    const state: Channel = {
      channelId,
      channelConfig: { payer: `0x${"11".repeat(20)}`, payerAuthorizer: `0x${"11".repeat(20)}`,
        receiver: `0x${"22".repeat(20)}`, receiverAuthorizer: `0x${"22".repeat(20)}`,
        token: `0x${"33".repeat(20)}`, withdrawDelay: 86_400,
        salt: `0x${"44".repeat(32)}` },
      chargedCumulativeAmount: "0", signedMaxClaimable: "0", signature: "0x",
      balance: "0", totalClaimed: "0", withdrawRequestedAt: 0, refundNonce: 0,
      lastRequestTimestamp: 1,
    };
    try {
      await Promise.all([sepolia.init(), mainnet.init()]);
      await Promise.all([sepolia.updateChannel(channelId, () => state),
        mainnet.updateChannel(channelId, () => state)]);
      const binding = await pool.query<{ hosting_binding: { network: string; chainId: number;
        channelId: string; contract: string; version: string } }>(
        "SELECT hosting_binding FROM x402_batch_channels WHERE channel_id=$1", [channelId]
      );
      const original = binding.rows[0].hosting_binding;
      expect(["eip155:84532", "eip155:8453"]).toContain(original.network);
      expect(original).toMatchObject({ channelId, contract: BATCH_SETTLEMENT_ADDRESS.toLowerCase(),
        version: "x402-batch-settlement-v1", chainId: Number(original.network.split(":")[1]) });
      const other = original.network === "eip155:84532" ? mainnet : sepolia;
      expect((await other.updateChannel(channelId, (current) => ({ ...current!, lastRequestTimestamp: 2 }))).status)
        .toBe("updated");
      const after = await pool.query<{ hosting_binding: typeof original }>(
        "SELECT hosting_binding FROM x402_batch_channels WHERE channel_id=$1", [channelId]
      );
      expect(after.rows[0].hosting_binding).toEqual(original);
    } finally {
      await pool.query("DELETE FROM x402_batch_channels WHERE channel_id=$1", [channelId]);
      await Promise.all([sepolia.close(), mainnet.close()]);
    }
  });
});
