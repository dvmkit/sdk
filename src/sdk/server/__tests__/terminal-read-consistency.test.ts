import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { verifyReceipt, type JobReceipt } from "../../../lib/receipt";
import { createDVMServer } from "../app";
import type { JobRecord } from "../job-store";
import { JobManager } from "../job-manager";
import { ReceiptIssuer } from "../receipt-issuer";
import { MemoryJobStore } from "../memory-job-store";

class FaultStore extends MemoryJobStore {
  fail = true;
  override async save(record: JobRecord): Promise<void> {
    if (this.fail && record.status === "completed") throw new Error("terminal storage unavailable");
    await super.save(record);
  }
}
const hosts: { shutdown(): void | Promise<void> }[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});
async function host(store: MemoryJobStore, onJob: () => void = () => undefined) {
  const server = await createDVMServer(configureDVM({
    name: "terminal-read", capability: "work", onJob: ctx => { onJob(); ctx.complete("delivered result"); },
  }), {
    env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
    receiptKey: "11".repeat(32), dvmId: "example-dvm",
  });
  hosts.push(server);
  return server;
}
interface Body { job_id: string; job_token: string; status?: string; summary?: string; receipt?: JobReceipt }
async function submit(server: Awaited<ReturnType<typeof host>>) {
  return server.app.request("/v1/job", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "work", input: "hello" }),
  });
}
function read(server: Awaited<ReturnType<typeof host>>, job: Body) {
  return server.app.request(`/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token } });
}

describe("terminal read recovery", () => {
  it("preserves live working status while a handler is paused, then serves a durable terminal winner", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    const server = await createDVMServer(configureDVM({
      name: "working-read", capability: "work",
      async onJob(ctx) {
        ctx.working(30, "Preparing result");
        await paused;
        ctx.complete("done");
      },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      receiptKey: "11".repeat(32), dvmId: "example-dvm",
    });
    hosts.push(server);
    try {
      const submitted = await submit(server);
      expect(submitted.status).toBe(202);
      const job = await submitted.json() as Body;
      const working = await read(server, job);
      expect(working.status).toBe(200);
      expect((await working.json() as Body).status).toBe("working");

      // A missed notification must not let live progress mask a committed cancellation.
      server.jobManager.unwatchDurableStatus(job.job_id);
      await store.cancelJob(job.job_id, "Caller stopped");
      const cancelled = await (await read(server, job)).json() as Body;
      expect(cancelled.status).toBe("cancelled");
      expect(verifyReceipt(cancelled.receipt!)).toBe(true);
      expect(cancelled.receipt).toMatchObject({ outcome: "cancelled", reason: "Caller stopped" });
    } finally {
      release();
      const active = [...server.jobManager.activeJobs.values()][0];
      // Let the resumed handler and its terminal work finish before host teardown.
      await new Promise<void>(resolve => { setImmediate(resolve); });
      await active?.terminalWork;
    }
  });

  it("keeps failed terminal saves recoverable on the same job without re-executing the handler", async () => {
    const store = new FaultStore();
    let executions = 0;
    const owner = await host(store, () => { executions++; });
    const other = await host(store);
    const submitted = await submit(owner);
    expect(submitted.status).toBe(202);
    const job = await submitted.json() as Body;
    const pending = await (await read(owner, job)).json() as Body;
    expect(pending.status).toBe("processing");
    expect(pending).not.toHaveProperty("receipt");
    expect(pending).not.toHaveProperty("summary");
    store.fail = false;
    const recovered = await Promise.all([read(owner, job), read(owner, job)]);
    const completed = await recovered[0].json() as Body;
    expect(completed).toMatchObject({ job_id: job.job_id, status: "completed", summary: "delivered result" });
    expect(verifyReceipt(completed.receipt!)).toBe(true);
    expect(completed.receipt?.result_hash).toBe(createHash("sha256").update('{"artifact_hashes":[],"summary":"delivered result"}').digest("hex"));
    const bytes = JSON.stringify(completed.receipt);
    for (const response of [recovered[1], await read(other, job), await read(owner, job)]) {
      expect(JSON.stringify((await response.json() as Body).receipt)).toBe(bytes);
    }
    expect(executions).toBe(1);
    expect(await store.claimReceiptSeq(job.job_id)).toBe(completed.receipt?.seq);
  });

  it("can repair a stale read from inside terminal reporting without waiting on its own repair", async () => {
    const store = new FaultStore();
    let stale: JobRecord | undefined;
    let repairing = false;
    let nestedFinished = false;
    const manager = new JobManager(configureDVM({
      name: "terminal-report", capability: "work", onJob: ctx => { ctx.complete("done"); },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      receiptIssuer: new ReceiptIssuer({ secret: "11".repeat(32), dvm: "terminal-report", dvmId: "example-dvm" }),
      dvmId: "example-dvm",
      fxFetcher: {
        fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }),
        supportedCurrencies: () => ["usd"],
      },
      async onJobTerminal() {
        if (repairing) return;
        repairing = true;
        await manager.ensureReceipt(stale!);
        nestedFinished = true;
      },
    });
    hosts.push(manager);
    const job = manager.createJob({ input: "hello" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
    await manager.persistJob(job);
    manager.runHandler(job, manager.buildAndAttachContext(job, "hello"));
    await job.terminalWork;
    stale = await store.get(job.id);
    store.fail = false;
    await manager.ensureReceipt(stale!);
    expect(nestedFinished).toBe(true);
    expect(stale?.status).toBe("completed");
    expect(verifyReceipt(stale!.receipt!)).toBe(true);
  });

  it.each(["snapshot", "receipt"])("bounds a blocked %s write and permits later same-job recovery", async phase => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    if (phase === "snapshot") {
      const save = store.save.bind(store);
      store.save = async record => {
        if (record.status === "completed") await gate;
        await save(record);
      };
    } else {
      const save = store.saveReceipt.bind(store);
      store.saveReceipt = async (id, receipt) => { await gate; return save(id, receipt); };
    }
    const owner = await host(store);
    const other = await host(store);
    try {
      const submitted = await submit(owner);
      const job = await submitted.json() as Body;
      const started = performance.now();
      const pending = await read(phase === "snapshot" ? owner : other, job);
      expect(performance.now() - started).toBeLessThan(3000);
      expect(pending.status).toBe(200);
      const pendingBody = await pending.json() as Body;
      expect(pendingBody.status).toBe(phase === "snapshot" ? "processing" : "completed");
      expect(pendingBody.receipt).toBeUndefined();
      release();
      const completed = await (await read(owner, job)).json() as Body;
      expect(verifyReceipt(completed.receipt!)).toBe(true);
      const repeated = await (await read(other, job)).json() as Body;
      expect(JSON.stringify(repeated.receipt)).toBe(JSON.stringify(completed.receipt));
    } finally {
      release();
    }
  }, 10_000);
});
