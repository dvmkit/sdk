import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { CreditLedgerLike } from "../credit-ledger";
import { JobManager, type JobManagerOpts } from "../job-manager";
import type { JobRecord, JobStatus } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { fundCredit } from "./__helpers__/credit-fixtures";

const DAY_MS = 24 * 60 * 60_000;
const OLD = Date.now() - 2 * DAY_MS;
const CALLER = "ab".repeat(32);

function record(id: string, status: JobStatus = "completed"): JobRecord {
  return {
    id,
    tags: ["private"],
    capability: "test",
    input: "caller secret",
    params: { prompt: "private" },
    requesterId: "caller-1",
    requesterTokenHash: "hash",
    requesterToken: "clear-token",
    requestFingerprint: "fingerprint",
    requesterPubkey: CALLER,
    requestId: `request-${id}`,
    authRequestPath: "/v1/job",
    status,
    summary: "private result",
    messages: [
      {
        seq: 1,
        from: "provider",
        type: "text",
        timestamp: 1,
        content: { text: "private output" },
      },
    ],
    seq: 1,
    paidMsats: 21_000,
    paymentMint: "https://mint.example",
    paymentRail: "cashu",
    paymentTxHash: `tx-${id}`,
    nativeAmount: 21,
    nativeAsset: "sats",
    receivedProofs: [{ amount: 1, id: "proof", secret: "secret", C: "C" }],
    pendingPaymentMsats: 10,
    pendingMppChallengeIds: ["challenge"],
    pendingX402Nonce: `0x${"01".repeat(32)}`,
    pendingX402AmountUsdcMicro: "10",
    pendingPaymentFiatMicro: 10,
    pendingPaymentFiatCurrency: "usd",
    stepCache: [{ id: "step", value: "private" }],
    state: { private: true },
    createdAt: OLD,
    lastActivityAt: OLD,
  };
}

function manager(
  store: MemoryJobStore,
  ledger: CreditLedgerLike = new MemoryCreditLedger(),
  extra: Partial<JobManagerOpts> = {},
  jobRetentionDays = 1
): JobManager<unknown, undefined> {
  const descriptor = configureDVM({
    name: "retention-test",
    capability: "test",
    jobRetentionDays,
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: store,
    creditLedger: ledger,
    devMode: true,
    dvmId: "dvm-under-test",
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0,
    processingWatchdogMs: 0,
    heartbeatIntervalMs: 0,
    orphanDrawSweepIntervalMs: 0,
    jobRetentionSweepIntervalMs: 0,
    jobRetentionSweepBootDelayMs: 0,
    ...extra,
  });
}

describe("JobManager job-record retention", () => {
  it("redacts expired terminal content while retaining accounting and identity fields", async () => {
    const store = new MemoryJobStore();
    const expired = record("expired");
    const staleSnapshot = structuredClone(expired);
    await store.save(expired);
    await store.save({ ...record("fresh", "completed"), lastActivityAt: Date.now() });
    await store.save(record("running", "processing"));
    await store.save({ ...record("sibling"), capability: "other" });

    const jm = manager(store);
    try {
      expect(await jm.sweepJobRetention()).toEqual({ examined: 1, redacted: 1, complete: true });
      const redacted = await store.get("expired");
      expect(redacted).toMatchObject({
        id: "expired",
        capability: "test",
        requesterId: "caller-1",
        requesterTokenHash: "hash",
        requesterPubkey: CALLER,
        requestId: "request-expired",
        status: "completed",
        paidMsats: 21_000,
        paymentRail: "cashu",
        paymentTxHash: "tx-expired",
        input: "",
        params: {},
        messages: [],
        receivedProofs: [],
        stepCache: [],
        state: {},
      });
      expect(redacted?.redactedAt).toBeTypeOf("number");
      expect(redacted?.summary).toBeUndefined();
      expect(redacted?.requesterToken).toBeUndefined();
      expect(redacted?.requestFingerprint).toBeUndefined();
      expect(redacted?.authRequestPath).toBeUndefined();
      expect(redacted?.pendingPaymentMsats).toBeUndefined();

      // A same-terminal snapshot from another machine must not restore content.
      await store.save(staleSnapshot);
      expect((await store.get("expired"))?.input).toBe("");
      await expect(
        store.appendOutgoing("expired", {
          from: "provider",
          type: "text",
          timestamp: Date.now(),
          content: { text: "late private output" },
        })
      ).rejects.toThrow("not found");
      await expect(
        store.recordInbound("expired", {
          from: "requester",
          type: "text",
          timestamp: Date.now(),
          content: { text: "late caller secret" },
        })
      ).rejects.toThrow("not found");
      expect(await store.getMessages("expired", 0)).toEqual([]);
      expect((await store.get("fresh"))?.input).toBe("caller secret");
      expect((await store.get("running"))?.input).toBe("caller secret");
      expect((await store.get("sibling"))?.input).toBe("caller secret");
    } finally {
      jm.shutdown();
    }
  });

  it("persists a signed receipt before removing the output it attests", async () => {
    const store = new MemoryJobStore();
    await store.save(record("receipt"));
    const jm = manager(store, new MemoryCreditLedger(), {
      receiptIssuer: new ReceiptIssuer({
        secret: "11".repeat(32),
        dvm: "retention-test",
        dvmId: "dvm-under-test",
      }),
    });
    try {
      await jm.sweepJobRetention();
      const retained = await store.get("receipt");
      expect(retained?.messages).toEqual([]);
      expect(retained?.receipt).toMatchObject({
        job_id: "receipt",
        outcome: "completed",
        requester_pubkey: CALLER,
      });
      expect(retained?.receipt?.result_hash).not.toBeNull();
    } finally {
      jm.shutdown();
    }
  });

  it("settles the bound hold and releases every unbound hold before redaction", async () => {
    const store = new MemoryJobStore();
    const ledger = new MemoryCreditLedger();
    const bound = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + DAY_MS,
    });
    const unbound = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + DAY_MS,
    });
    await ledger.draw({
      creditId: bound.creditId,
      drawId: "bound",
      amountMicro: 20_000,
      jobId: "paid",
      nowMs: OLD,
    });
    await ledger.draw({
      creditId: unbound.creditId,
      drawId: "unbound",
      amountMicro: 10_000,
      jobId: "paid",
      nowMs: OLD,
    });
    await store.save({ ...record("paid"), creditId: bound.creditId, drawId: "bound" });

    const originalRedact = store.redactJob.bind(store);
    const redact = vi.spyOn(store, "redactJob").mockImplementation(async (args) => {
      const draws = await ledger.listDrawsByJobId(args.jobId);
      expect(draws.every((draw) => draw.status !== "pending")).toBe(true);
      return originalRedact(args);
    });
    const jm = manager(store, ledger, { onJobCompleted: vi.fn() });
    try {
      await jm.sweepJobRetention();
      expect(redact).toHaveBeenCalledOnce();
      expect((await ledger.getDraw({ creditId: bound.creditId, drawId: "bound" }))?.status).toBe(
        "settled"
      );
      expect(
        (await ledger.getDraw({ creditId: unbound.creditId, drawId: "unbound" }))?.status
      ).toBe("released");
      expect((await store.get("paid"))?.redactedAt).toBeDefined();
    } finally {
      jm.shutdown();
    }
  });

  it("keeps a row intact on a live-hold failure, alerts, then clears on recovery", async () => {
    const store = new MemoryJobStore();
    const ledger = new MemoryCreditLedger();
    const funded = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + DAY_MS,
    });
    await ledger.draw({
      creditId: funded.creditId,
      drawId: "held",
      amountMicro: 20_000,
      jobId: "blocked",
      nowMs: OLD,
    });
    await store.save({ ...record("blocked"), creditId: funded.creditId, drawId: "held" });
    const realSettle = ledger.settle.bind(ledger);
    vi.spyOn(ledger, "settle").mockRejectedValueOnce(new Error("ledger unavailable"));
    const failed = vi.fn();
    const recovered = vi.fn();
    const jm = manager(store, ledger, {
      onJobRetentionSweepFailed: failed,
      onJobRetentionSweepRecovered: recovered,
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(jm.sweepJobRetention()).rejects.toThrow(/retention candidate/);
      expect((await store.get("blocked"))?.input).toBe("caller secret");
      expect((await ledger.getDraw({ creditId: funded.creditId, drawId: "held" }))?.status).toBe(
        "pending"
      );
      expect(failed).toHaveBeenCalledWith(
        expect.objectContaining({ dvmId: "dvm-under-test", retentionDays: 1 })
      );
      expect(recovered).not.toHaveBeenCalled();

      vi.mocked(ledger.settle).mockImplementation(realSettle);
      await expect(jm.sweepJobRetention()).resolves.toMatchObject({ redacted: 1, complete: true });
      expect((await store.get("blocked"))?.redactedAt).toBeDefined();
      expect(recovered).toHaveBeenCalledWith(
        expect.objectContaining({ dvmId: "dvm-under-test", redacted: 1 })
      );
    } finally {
      error.mockRestore();
      jm.shutdown();
    }
  });

  it("uses keyset pages so a failed head row cannot starve later jobs", async () => {
    const store = new MemoryJobStore();
    const ledger = new MemoryCreditLedger();
    const funded = await fundCredit(ledger, {
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + DAY_MS,
    });
    await ledger.draw({
      creditId: funded.creditId,
      drawId: "wall",
      amountMicro: 1,
      jobId: "00-wall",
      nowMs: OLD,
    });
    await store.save({
      ...record("00-wall"),
      creditId: funded.creditId,
      drawId: "wall",
      lastActivityAt: OLD - 1,
    });
    for (let i = 0; i < 50; i++) {
      await store.save({ ...record(`job-${String(i).padStart(2, "0")}`), paidMsats: 0 });
    }
    vi.spyOn(ledger, "settle").mockRejectedValue(new Error("held"));
    const jm = manager(store, ledger);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(jm.sweepJobRetention()).rejects.toThrow();
      expect((await store.get("00-wall"))?.redactedAt).toBeUndefined();
      for (let i = 0; i < 50; i++) {
        expect((await store.get(`job-${String(i).padStart(2, "0")}`))?.redactedAt).toBeDefined();
      }
    } finally {
      error.mockRestore();
      jm.shutdown();
    }
  });

  it("honours the per-DVM opt-out", async () => {
    const store = new MemoryJobStore();
    await store.save(record("kept"));
    const jm = manager(store, new MemoryCreditLedger(), {}, 0);
    try {
      expect(await jm.sweepJobRetention()).toEqual({ examined: 0, redacted: 0, complete: false });
      expect((await store.get("kept"))?.input).toBe("caller secret");
    } finally {
      jm.shutdown();
    }
  });
});
