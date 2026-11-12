import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { describe, expect, it } from "vitest";

import { MemoryX402BatchStore } from "../payout-reporter";
import { claimRecoveryFixture, SCOPE } from "./__helpers__/x402-claim-recovery";

describe("explicit multi-batch claim recovery", () => {
  it.each(["rejected", "timeout"])("keeps the first batch's payout after a later %s", async (failure) => {
    const storage = new InMemoryChannelStorage();
    const batches = new MemoryX402BatchStore();
    const f = await claimRecoveryFixture(storage, batches, 101);
    const server = await f.createServer();
    if (failure === "timeout") f.timeOutClaims();
    try {
      await expect(server.claimAndSettle()).rejects.toThrow(failure);
      expect((await storage.list()).filter((channel) => channel.totalClaimed === "40")).toHaveLength(100);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 3000n, voucherCount: 100, claims: 1 });

      // Retrying the failed batch must not book the confirmed batch again.
      await expect(server.claimAndSettle()).rejects.toThrow(failure);
      expect(await batches.get(SCOPE)).toMatchObject({ claimedNative: 3000n, voucherCount: 100, claims: 1 });
      f.allowClaims();
      await server.claimAndSettle();
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
      expect(f.transport.enqueuePayout).toHaveBeenCalledWith(expect.objectContaining({
        nativeAmount: 3030, refs: expect.objectContaining({ voucherCount: 101, claims: 2 }),
      }), undefined);
      await server.claimAndSettle();
      expect(f.transport.enqueuePayout).toHaveBeenCalledTimes(1);
    } finally {
      f.earned.clear();
      await server.stop();
    }
  });
});
