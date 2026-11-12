import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { PostgresX402BatchStore } from "../payout-reporter";
import type { X402BatchSettlementServer } from "../x402-batch-settlement";
import { PostgresX402ChannelStorage } from "../x402-channel-store";
import { claimRecoveryFixture, SCOPE } from "./__helpers__/x402-claim-recovery";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "x402_claim_recovery";

describe.skipIf(!RUN)("durable multi-batch claim recovery", () => {
  let pool: Pool;
  let storage: PostgresX402ChannelStorage;
  let batches: PostgresX402BatchStore;
  let servers: X402BatchSettlementServer[];

  beforeEach(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
    storage = new PostgresX402ChannelStorage(pool);
    batches = new PostgresX402BatchStore(pool);
    servers = [];
    await storage.init();
    await batches.init();
  });

  afterEach(async () => {
    try {
      for (const server of servers) await server.stop();
    } finally {
      vi.useRealTimers();
    }
    await storage.close();
    await pool.end();
    await dropSchemas(SCHEMA);
  });

  it("leaves a timed-out submission unconfirmed without inventing a transfer or payout", async () => {
    const f = await claimRecoveryFixture(storage, batches, 1);
    vi.mocked(f.facilitator.settle).mockRejectedValue(new Error("facilitator timeout"));
    const server = await f.createServer();
    servers.push(server);
    try {
      await expect(server.claimAndSettle()).rejects.toThrow("facilitator timeout");
      expect(await storage.get(f.channels[0].channelId)).toMatchObject({ totalClaimed: "10" });
      expect(await storage.isSettlePending(SCOPE)).toBe(false);
      expect(await batches.get(SCOPE)).toBeUndefined();
      expect(f.transport.enqueuePayout).not.toHaveBeenCalled();
    } finally {
      f.earned.clear();
    }
  });

  it.each(["scheduled", "explicit"])("recovers a partial %s claim in another process exactly once", async (path) => {
    const f = await claimRecoveryFixture(storage, batches, path === "scheduled" ? 2 : 101);
    let failed!: () => void;
    const failure = new Promise<void>((resolve) => { failed = resolve; });
    const onError = vi.fn(failed);
    // Fake scheduler intervals before creation; leave Postgres I/O deadlines real.
    if (path === "scheduled") vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const first = await f.createServer(storage, path === "scheduled" ? {
      maxClaimsPerBatch: 1, claimIntervalSecs: 1, settleIntervalSecs: 3600, onError,
    } : false);
    servers.push(first);
    try {
      if (path === "scheduled") {
        await vi.advanceTimersByTimeAsync(1000);
        await failure;
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("rejected") }));
      } else {
        await expect(first.claimAndSettle()).rejects.toThrow("rejected");
      }
      const confirmed = path === "scheduled" ? 1 : 100;
      const open = await batches.get(SCOPE);
      expect(open).toMatchObject({ claimedNative: BigInt(confirmed * 30), voucherCount: confirmed, claims: 1 });
      expect(await storage.isSettlePending(SCOPE)).toBe(true);
      expect((await storage.list()).filter((channel) => channel.totalClaimed === "40")).toHaveLength(confirmed);
      expect(f.transport.enqueuePayout).not.toHaveBeenCalled();

      // End the first process without letting its shutdown sweep claim anything else.
      f.earned.clear();
      await first.stop();
      await storage.close();
      storage = new PostgresX402ChannelStorage(pool);
      batches = new PostgresX402BatchStore(pool);
      expect(await batches.get(SCOPE)).toEqual(open);
      expect(await storage.isSettlePending(SCOPE)).toBe(true);
      const submissionsBeforeRecovery = vi.mocked(f.facilitator.settle).mock.calls.length;
      let settled!: () => void;
      const settlement = new Promise<void>((resolve) => { settled = resolve; });
      const next = await f.createServer(storage, path === "scheduled" ? {
        claimIntervalSecs: 3600, settleIntervalSecs: 1, onSettle: settled,
      } : false);
      servers.push(next);
      if (path === "scheduled") {
        await vi.advanceTimersByTimeAsync(1000);
        await settlement;
      } else {
        await next.claimAndSettle();
      }
      expect(vi.mocked(f.facilitator.settle).mock.calls.slice(submissionsBeforeRecovery)
        .map(([payment]) => payment.payload.type)).toEqual(["settle"]);
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
      expect(f.transport.enqueuePayout).toHaveBeenCalledWith(expect.objectContaining({
        payoutId: `x402:batch:${open!.batchId}`, nativeAmount: confirmed * 30,
        refs: expect.objectContaining({ voucherCount: confirmed, claims: 1 }),
      }), expect.anything());
      expect(await batches.get(SCOPE)).toBeUndefined();
      expect(await storage.isSettlePending(SCOPE)).toBe(false);
      await next.claimAndSettle();
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
    } finally {
      f.earned.clear();
    }
  });
});
