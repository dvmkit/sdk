import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { verifyReceipt, type JobReceipt } from "../../../lib/receipt";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { JobManager } from "../job-manager";
import type { ServerJob } from "../job";
import { PostgresJobStore } from "../postgres-job-store";
import { ReceiptIssuer } from "../receipt-issuer";

const url = process.env.DATABASE_URL;
const run = !!url && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(url);
const descriptor = configureDVM({ name: "durable-result", capability: "work", onJob() {} });
const fxFetcher = { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }), supportedCurrencies: () => ["usd"] };
const token = "example-job-token";
const issuer = new ReceiptIssuer({ secret: "11".repeat(32), dvm: "example", dvmId: "example-dvm" });

describe.skipIf(!run)("terminal result durability (Postgres)", () => {
  let db: pg.Pool;
  let store: PostgresJobStore;
  let ledger: CreditLedger;
  const hosts: { shutdown(): void | Promise<void> }[] = [];
  const jobs: ServerJob[] = [];
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    store = new PostgresJobStore(db);
    ledger = new CreditLedger(db);
    await store.init();
    await ledger.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(jobs.splice(0).map(job => job.terminalWork));
    for (const host of hosts.splice(0)) await host.shutdown();
    await db.query("DELETE FROM job_messages");
    await db.query("DELETE FROM jobs");
    await db.query("DELETE FROM credit_draws");
    await db.query("DELETE FROM credit_funding_lots");
    await db.query("DELETE FROM credits");
  });
  afterAll(async () => { await db.end(); });

  function manager(jobStore = store, creditLedger = ledger) {
    const jm = new JobManager(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore, creditLedger, devMode: true, fxFetcher,
      receiptIssuer: issuer, dvmId: "example-dvm", staleJobTimeoutMs: 0, processingWatchdogMs: 0,
      heartbeatIntervalMs: 0, orphanDrawSweepIntervalMs: 0,
    });
    hosts.push(jm);
    return jm;
  }
  async function seed(jm = manager()) {
    await ledger.fund({ creditId: "credit", callerPubkey: "22".repeat(32), currency: "usd", amountMicro: 1_000_000,
      expiryMs: Date.now() + 3600_000, basis: { rail: "cashu", paidMsats: 1_000_000 } });
    const job = jm.createJob({ input: "hello" }, "test", {
      paidMsats: 100_000, receivedProofs: [], paymentRail: "cashu", creditId: "credit", drawId: "draw",
    }, undefined, "work", createHash("sha256").update(token).digest("hex"));
    await ledger.draw({ creditId: "credit", drawId: "draw", jobId: job.id, amountMicro: 100_000 });
    await jm.persistJob(job);
    jobs.push(job);
    return { jm, job, ctx: jm.buildAndAttachContext(job, "hello") };
  }
  async function check(jobId: string, status: "completed" | "failed", reason?: string) {
    const record = (await store.get(jobId))!;
    expect(record.status).toBe(status);
    expect(record.receipt?.outcome).toBe(status);
    if (reason) expect(record.receipt?.reason).toBe(reason);
    expect(verifyReceipt(record.receipt!)).toBe(true);
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe(status === "completed" ? "settled" : "released");
    expect((await ledger.get("credit"))?.availableMicro).toBe(status === "completed" ? 900_000 : 1_000_000);
    return record;
  }

  it("retries a 20-second append outage when an earlier yield resumes across completion", async () => {
    const { jm, job, ctx } = await seed();
    jm.unwatchDurableStatus(job.id);
    // These accepted caller messages never enter the owner's local array. A
    // length-only snapshot guard would mistake this longer log for complete output.
    for (let i = 0; i < 4; i++) {
      const seq = await store.recordInbound(job.id, { from: "requester", type: "response", timestamp: 1, content: { text: String(i) } });
      await store.verifyAndCredit(job.id, seq, null);
    }
    let entered!: () => void;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const counters = store.getCounters.bind(store);
    vi.spyOn(store, "getCounters").mockImplementationOnce(async (...args) => {
      const snapshot = await counters(...args);
      entered();
      await gate;
      return snapshot;
    });
    ctx.sendMessage("prompt", { id: "question", text: "Continue?" });
    await paused;
    const append = store.appendOutgoing.bind(store);
    const until = Date.now() + 20_000;
    const saveReceipt = store.saveReceipt.bind(store);
    vi.spyOn(store, "saveReceipt").mockImplementation(async (...args) => {
      if (Date.now() < until) throw new Error("injected receipt outage");
      return saveReceipt(...args);
    });
    vi.spyOn(store, "appendOutgoing").mockImplementation(async (...args) => {
      if (Date.now() < until) throw new Error("injected append outage");
      return append(...args);
    });
    ctx.artifact({ name: "one", data: "first result" });
    ctx.artifact({ name: "two", data: "second result" });
    ctx.complete("done");
    release();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await store.get(job.id))?.status).toBe("processing");
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("pending");
    await job.terminalWork;
    const record = await check(job.id, "completed");
    const messages = await store.getMessages(job.id, 4);
    expect(messages.map(m => m.type)).toEqual(["prompt", "artifact", "artifact", "complete"]);
    expect(messages.filter(m => m.type !== "prompt").map(m => [m.type, m.content])).toEqual([
      ["artifact", { name: "one", data: "first result" }], ["artifact", { name: "two", data: "second result" }], ["complete", { summary: "done" }],
    ]);
    const other = manager(new PostgresJobStore(db), new CreditLedger(db));
    await Promise.all([jm.ensureReceipt(record), other.ensureReceipt((await store.get(job.id))!)]);
    expect(await store.claimReceiptSeq(job.id)).toBe(record.receipt!.seq);
    await jm.sweepStaleJobs();
    expect((await check(job.id, "completed")).receipt).toEqual(record.receipt);
  }, 40_000);

  it.each(["append", "snapshot"] as const)("releases and records failure when %s stays unavailable past the budget", async phase => {
    const { jm, job, ctx } = await seed();
    if (phase === "append") vi.spyOn(store, "appendOutgoing").mockRejectedValue(new Error("append outage"));
    else {
      const save = store.save.bind(store);
      vi.spyOn(store, "save").mockImplementation(async record => {
        if (record.status === "completed") throw new Error("snapshot outage");
        await save(record);
      });
    }
    ctx.cost({ amount: 0.025, currency: "usd" });
    ctx.artifact({ data: "result" });
    ctx.complete("done");
    await job.terminalWork;
    const record = await check(job.id, "failed", "terminal_persistence_failed");
    expect(record).toMatchObject({ costAmountMicro: 25_000, costCurrency: "usd", costRevision: 1 });
    await jm.sweepStaleJobs();
    expect((await check(job.id, "failed", "terminal_persistence_failed")).receipt).toEqual(record.receipt);
  }, 40_000);

  it("preserves a refusal's own reason and releases immediately after a failed step write", async () => {
    const { jm, job, ctx } = await seed();
    vi.spyOn(store, "saveStep").mockRejectedValue(new Error("step unavailable"));
    await ctx.step("check", async () => "insufficient coverage");
    ctx.fail("insufficient coverage");
    await job.terminalWork;
    await check(job.id, "failed", "insufficient coverage");
    await jm.sweepStaleJobs();
    await check(job.id, "failed", "insufficient coverage");
  });

  it("deduplicates a committed append whose acknowledgement was lost, including its payment counters", async () => {
    const { job } = await seed();
    const message = { from: "provider", type: "payment-request", timestamp: 1, content: { amount_msats: 10_000, reason: "more" } } as const;
    const opts = { appendId: "example-append", pendingPaymentDelta: 10_000, pendingPaymentFiatMicro: 10_000, pendingPaymentFiatCurrency: "usd" };
    const seq = await store.appendOutgoing(job.id, message, opts);
    // A second machine has no local knowledge of the first COMMIT.
    const other = new PostgresJobStore(db);
    expect(await other.appendOutgoing(job.id, message, opts)).toBe(seq);
    expect((await store.getCounters(job.id))?.pendingPaymentMsats).toBe(10_000);
    expect((await store.get(job.id))?.askedTopUpMicro).toBe(10_000);
    expect(await store.getMessages(job.id, 0)).toHaveLength(1);
    await store.cancelJob(job.id, "stopped");
    expect(await other.appendOutgoing(job.id, message, opts)).toBe(seq);
    expect((await store.getMessages(job.id, 0)).filter(m => m.type === "payment-request")).toHaveLength(1);
  });

  it("recovers a pending receipt after restart from the stored result and settled draw without settling again", async () => {
    const { jm, job, ctx } = await seed();
    vi.spyOn(store, "saveReceipt").mockRejectedValue(new Error("receipt unavailable"));
    ctx.artifact({ data: "durable result" });
    ctx.complete("done");
    await job.terminalWork;
    expect((await store.get(job.id))?.receipt).toBeUndefined();
    const seq = await store.claimReceiptSeq(job.id);
    expect((await ledger.getDraw({ creditId: "credit", drawId: "draw" }))?.status).toBe("settled");
    await jm.shutdown();
    const freshStore = new PostgresJobStore(db);
    const freshLedger = new CreditLedger(db);
    const settle = vi.spyOn(freshLedger, "settle");
    const server = await createDVMServer(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: freshStore, creditLedger: freshLedger,
      devMode: true, fxFetcher, receiptKey: "11".repeat(32), dvmId: "example-dvm",
    });
    hosts.push(server);
    expect(server.jobManager.activeJobs.size).toBe(0);
    const saveReceipt = freshStore.saveReceipt.bind(freshStore);
    const receiptFault = vi.spyOn(freshStore, "saveReceipt").mockRejectedValue(new Error("receipt still unavailable"));
    const read = () => server.app.request(`/v1/job/${job.id}`, { headers: { "X-Job-Token": token } });
    const pending = await (await read()).json();
    expect(pending).toMatchObject({ status: "completed", receipt_pending: true });
    expect(pending.receipt).toBeUndefined();
    receiptFault.mockImplementation(saveReceipt);
    const bodies = await Promise.all(Array.from({ length: 3 }, async () => await (await read()).json() as { receipt: JobReceipt; receipt_pending?: boolean }));
    for (const body of bodies) {
      expect(body.receipt_pending).toBeUndefined();
      expect(verifyReceipt(body.receipt)).toBe(true);
      expect(body.receipt).toEqual(bodies[0].receipt);
      expect(body.receipt.seq).toBe(seq);
      expect(body.receipt.credit).toMatchObject({ amount: 100_000, balance_after: 900_000 });
    }
    expect(settle).not.toHaveBeenCalled();
    expect((await ledger.get("credit"))?.balanceMicro).toBe(900_000);
  });
});
