import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createDVMServer } from "../app";
import fixture from "../../../../protocol-fixtures/job-receipt-pending-v1.json";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { verifyReceipt } from "../../../lib/receipt";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { ReceiptIssuer } from "../receipt-issuer";
import type { JobRecord } from "../job-store";

const managers: { shutdown(): void | Promise<void> }[] = [];
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdown();
  vi.useRealTimers();
});
class CostRecoveryStore extends MemoryJobStore {
  async saveForDvm(record: JobRecord): Promise<void> { await this.save(record); }
  async listUnreportedTerminalCosts(): Promise<JobRecord[]> { return []; }
  async markTerminalCostReported(): Promise<boolean> { return true; }
}
async function setup(withCostRecovery = false) {
  const store = withCostRecovery ? new CostRecoveryStore() : new MemoryJobStore();
  const ledger = new MemoryCreditLedger();
  const manager = new JobManager(configureDVM({ name: "durable-result", capability: "work", onJob() {} }), {
    env: {}, store: new MemoryKVStore(), jobStore: store, creditLedger: ledger, devMode: true, dvmId: "example-dvm",
    fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }), supportedCurrencies: () => ["usd"] },
    receiptIssuer: new ReceiptIssuer({ secret: "11".repeat(32), dvm: "example", dvmId: "example-dvm" }),
    staleJobTimeoutMs: 0, processingWatchdogMs: 0, heartbeatIntervalMs: 0, orphanDrawSweepIntervalMs: 0,
  });
  managers.push(manager);
  await ledger.fund({ creditId: "credit", callerPubkey: "22".repeat(32), currency: "usd", amountMicro: 1_000_000,
    expiryMs: Date.now() + 3600_000, basis: { rail: "cashu", paidMsats: 1_000_000 } });
  const job = manager.createJob({ input: "hello" }, "test", {
    paidMsats: 100_000, receivedProofs: [], paymentRail: "cashu", creditId: "credit", drawId: "draw",
  }, undefined, "work");
  await ledger.draw({ creditId: "credit", drawId: "draw", jobId: job.id, amountMicro: 100_000 });
  await manager.persistJob(job);
  return { manager, job, store, ledger, ctx: manager.buildAndAttachContext(job, "hello") };
}

describe("terminal result durability", () => {
  it("holds settlement while outgoing writes fail, then stores every result in order", async () => {
    vi.useFakeTimers();
    const { manager, job, store, ledger, ctx } = await setup();
    for (let i = 0; i < 4; i++) {
      const seq = await store.recordInbound(job.id, { from: "requester", type: "response", timestamp: 1, content: { text: String(i) } });
      await store.verifyAndCredit(job.id, seq, null);
    }
    let unavailable = true;
    const saveReceipt = store.saveReceipt.bind(store);
    vi.spyOn(store, "saveReceipt").mockImplementation(async (...args) => {
      if (unavailable) throw new Error("receipt unavailable");
      return saveReceipt(...args);
    });
    const append = store.appendOutgoing.bind(store);
    vi.spyOn(store, "appendOutgoing").mockImplementation(async (...args) => {
      if (unavailable) throw new Error("append unavailable");
      return append(...args);
    });
    ctx.artifact({ mime_type: "text/plain", data: "result" });
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(0);
    const initial = (await store.get(job.id))!;
    expect({ status: initial.status, draw: (await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status,
      terminalMessages: (await store.getMessages(job.id, 4)).map(m => m.type), receipt: initial.receipt,
    }).toEqual({ status: "processing", draw: "pending", terminalMessages: [], receipt: undefined });
    unavailable = false;
    await vi.advanceTimersByTimeAsync(1000);
    await job.terminalWork;
    const record = (await store.get(job.id))!;
    expect((await store.getMessages(job.id, 4)).map(m => m.type)).toEqual(["artifact", "complete"]);
    expect(record.status).toBe("completed");
    expect(verifyReceipt(record.receipt!)).toBe(true);
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("settled");
    const seq = record.receipt!.seq;
    await Promise.all([manager.ensureReceipt(record), manager.ensureReceipt(record)]);
    expect(await store.claimReceiptSeq(job.id)).toBe(seq);
  });

  it("fails and releases after the retry budget, even when append remains unavailable", async () => {
    vi.useFakeTimers();
    const { job, store, ledger, ctx } = await setup(true);
    vi.spyOn(store, "appendOutgoing").mockRejectedValue(new Error("append unavailable"));
    ctx.cost({ amount: 0.025, currency: "usd" });
    ctx.artifact({ mime_type: "text/plain", data: "result" });
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(31_000);
    await job.terminalWork;
    const record = (await store.get(job.id))!;
    expect(record.status).toBe("failed");
    expect(record).toMatchObject({ costAmountMicro: 25_000, costCurrency: "usd", costRevision: 1 });
    expect(record.receipt).toMatchObject({ outcome: "failed", reason: "terminal_persistence_failed" });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("released");
    expect((await ledger.get("credit"))?.availableMicro).toBe(1_000_000);
  });

  it("retries a lost append acknowledgement without duplicating terminal messages", async () => {
    vi.useFakeTimers();
    const { job, store, ctx } = await setup();
    const append = store.appendOutgoing.bind(store);
    let lost = false;
    vi.spyOn(store, "appendOutgoing").mockImplementation(async (...args) => {
      const seq = await append(...args);
      if (!lost) { lost = true; throw new Error("lost commit acknowledgement"); }
      return seq;
    });
    ctx.artifact({ data: "result" });
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(1000);
    await job.terminalWork;
    expect((await store.getMessages(job.id, 0)).map(m => m.type)).toEqual(["artifact", "complete"]);
  });

  it("honors a competing cancellation while completion is retrying", async () => {
    vi.useFakeTimers();
    const { manager, job, store, ledger, ctx } = await setup();
    vi.spyOn(store, "appendOutgoing").mockRejectedValue(new Error("append unavailable"));
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(0);
    await store.cancelJob(job.id, "caller stopped");
    await vi.advanceTimersByTimeAsync(1000);
    await job.terminalWork;
    await manager.ensureReceipt((await store.get(job.id))!);
    const record = (await store.get(job.id))!;
    expect(record.status).toBe("cancelled");
    expect(record.receipt).toMatchObject({ outcome: "cancelled", reason: "caller stopped" });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("released");
  });

  it("keeps the failure decision and retries its durable write when storage returns", async () => {
    vi.useFakeTimers();
    const { job, store, ledger, ctx } = await setup();
    vi.spyOn(store, "appendOutgoing").mockRejectedValue(new Error("append unavailable"));
    const fault = vi.spyOn(store, "failJob").mockRejectedValue(new Error("failure write unavailable"));
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(30_500);
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("pending");
    fault.mockRestore();
    await vi.advanceTimersByTimeAsync(1500);
    await job.terminalWork;
    expect((await store.get(job.id))?.receipt).toMatchObject({ outcome: "failed", reason: "terminal_persistence_failed" });
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("released");
  });

  it("does not schedule more failure writes after shutdown during an outstanding write", async () => {
    vi.useFakeTimers();
    const { manager, job, store, ctx } = await setup();
    vi.spyOn(store, "appendOutgoing").mockRejectedValue(new Error("append unavailable"));
    let reject!: (error: Error) => void;
    const fault = vi.spyOn(store, "failJob").mockImplementation(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
    ctx.complete("done");
    await vi.advanceTimersByTimeAsync(30_000);
    manager.shutdown();
    fault.mockRejectedValue(new Error("closed store"));
    reject(new Error("closed store"));
    await job.terminalWork;
    const calls = fault.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(fault).toHaveBeenCalledTimes(calls);
  });

  it("reports pending receipts and recovers their sequence after replacing the host", async () => {
    const { manager, job, store, ledger, ctx } = await setup();
    const token = "example-token";
    job.requesterTokenHash = createHash("sha256").update(token).digest("hex");
    await manager.persistJob(job);
    const fault = vi.spyOn(store, "saveReceipt").mockRejectedValue(new Error("receipt unavailable"));
    ctx.artifact({ data: "result" });
    ctx.complete("done");
    await job.terminalWork;
    const seq = await store.claimReceiptSeq(job.id);
    await manager.shutdown();
    const settle = vi.spyOn(ledger, "settle");
    const server = await createDVMServer(configureDVM({ name: "durable-result", capability: "work", onJob() { throw new Error("must not execute"); } }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, creditLedger: ledger, devMode: true,
      receiptKey: "11".repeat(32), dvmId: "example-dvm",
    });
    managers.push(server);
    expect(server.jobManager.activeJobs.size).toBe(0);
    const read = () => server.app.request(`/v1/job/${job.id}`, { headers: { "X-Job-Token": token } });
    expect(await (await read()).json()).toMatchObject(fixture.pending);
    fault.mockRestore();
    const responses = await Promise.all([read(), read(), read()]);
    const bodies = await Promise.all(responses.map(response => response.json()));
    for (const body of bodies) {
      expect(body.receipt_pending).toBeUndefined();
      expect(verifyReceipt(body.receipt)).toBe(true);
      expect(body.receipt.seq).toBe(seq);
      expect(body.receipt).toEqual(bodies[0].receipt);
    }
    expect(settle).not.toHaveBeenCalled();
  });
});
