import { describe, expect, it, vi } from "vitest";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import type { JobRecord } from "../job-store";
import { ReceiptIssuer } from "../receipt-issuer";

describe("paid completion observer", () => {
  it("uses settled currency and repeats stable facts for consumer deduplication", async () => {
    const ledger = new MemoryCreditLedger();
    const store = new MemoryJobStore();
    const callback = vi.fn();
    const manager = new JobManager(configureDVM({ name: "observer", capability: "test", tag: "test", onJob() {} }), {
      env: {}, fxFetcher: { fetch: async () => ({ rates: { usd: 100000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] }, store: new MemoryKVStore(), jobStore: store, creditLedger: ledger, onPaidJobCompleted: callback,
      receiptIssuer: new ReceiptIssuer({ secret: "11".repeat(32), dvm: "observer", dvmId: "observer" }),
    });
    const record = { id: "paid", tags: [], capability: "test", input: "", params: {}, requesterId: "caller", status: "completed", messages: [], seq: 0, paidMsats: 999999,
      paymentRail: "cashu", creditId: "credit", drawId: "draw", receivedProofs: [], stepCache: [], state: {}, createdAt: Date.now(), lastActivityAt: Date.now() } as JobRecord;
    await ledger.fund({ creditId: "credit", callerPubkey: "caller", currency: "eur", amountMicro: 12345, expiryMs: Date.now() + 60000,
      basis: { rail: "cashu", paidMsats: 1000, mint: "http://localhost:3338", fundingRef: "verified" } });
    await ledger.draw({ creditId: "credit", drawId: "draw", amountMicro: 12345, jobId: "paid" });
    await store.save(record);
    const receipt = await manager.issueReceipt(record);
    expect(receipt).toBeDefined();
    await manager.issueReceipt({ ...record, receipt });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls[0]![0]).toEqual({ jobId: "paid", rail: "cashu", amountMicro: 12345, currency: "eur", testFunds: null });
    expect(callback.mock.calls[1]).toEqual(callback.mock.calls[0]);
    for (const status of ["failed", "cancelled"] as const) await manager.issueReceipt({ ...record, id: status, status, receipt: undefined });
    await manager.issueReceipt({ ...record, id: "synthetic", creditId: undefined, drawId: undefined, receipt: undefined });
    expect(callback).toHaveBeenCalledTimes(2);
  });
});
