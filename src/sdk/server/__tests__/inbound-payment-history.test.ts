import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { providerMessage } from "../job";
import { JobManager } from "../job-manager";
import type { JobStore } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";

describe("inbound payment history", () => {
  it("keeps a rejected payment out of GET history while the job awaits payment", async () => {
    const { app, jobManager } = await createDVMServer(configureDVM({
      name: "payment-history", capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(1000, "More work");
        ctx.complete("done");
      },
    }), {
      env: {}, store: new MemoryKVStore(), devMode: true,
      mints: ["https://mint.example.com"],
    });
    try {
      const submitted = await app.request("/v1/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "" }),
      });
      expect(submitted.status).toBe(202);
      const { job_id, job_token } = await submitted.json() as { job_id: string; job_token: string };
      const headers = { "Content-Type": "application/json", "X-Job-Token": job_token };
      const rejected = await app.request(`/v1/job/${job_id}/messages`, {
        method: "POST", headers,
        body: JSON.stringify({ type: "payment", content: { cashu_token: "invalid-token" } }),
      });
      expect(rejected.status).toBe(402);
      const history = await app.request(`/v1/job/${job_id}/messages`, { headers });
      expect(history.status).toBe(200);
      const { messages } = await history.json() as { messages: { type: string }[] };
      expect(messages.some(message => message.type === "payment-request")).toBe(true);
      expect(messages.filter(message => message.type === "payment")).toEqual([]);
    } finally {
      jobManager.shutdown();
    }
  });

  it.each([true, false])("publishes only accepted payments with streamable=%s", async (streamable) => {
    const backing = new MemoryJobStore();
    const store: JobStore = streamable ? backing : {
      get: backing.get.bind(backing),
      save: backing.save.bind(backing),
      delete: backing.delete.bind(backing),
      findJobByPaymentTxHash: backing.findJobByPaymentTxHash.bind(backing),
    };
    const jm = new JobManager(configureDVM({
      name: "payment-history", capability: "test", onJob: async () => undefined,
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      mints: ["https://mint.example.com"],
      fxFetcher: {
        fetch: async () => ({ rates: { usd: 100_000 }, as_of: "2026-01-01T00:00:00Z" }),
        supportedCurrencies: () => ["usd"],
      },
    });
    const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
    job.pendingPaymentMsats = 1000;
    try {
      await jm.persistJob(job);
      const rejected = { type: "payment" as const, content: { cashu_token: "invalid-token" } };
      const rejectedSeq = await jm.recordInboundPending(job, rejected.type, rejected.content);
      // A concurrent snapshot must not turn a pending attempt into accepted history.
      await jm.persistJob(job);
      expect((await store.get(job.id))?.messages).toEqual([]);
      expect(job.messages).toEqual([]);

      const result = await jm.processPayment(job, rejected, rejectedSeq);
      expect(result.error).toMatchObject({ status: 402, body: { error: "cashu_not_p2pk_locked" } });
      expect(job.paidMsats).toBe(0);
      expect(job.pendingPaymentMsats).toBe(1000);
      expect(job.messages).toEqual([]);

      const accepted = { type: "payment" as const, content: { dev_auto: true } };
      const acceptedSeq = await jm.recordInboundPending(job, accepted.type, accepted.content);
      // Provider output while verification is pending must retain its sequence order.
      providerMessage(job, "text", { text: "Still working" });
      expect((await jm.processPayment(job, accepted, acceptedSeq)).error).toBeUndefined();
      expect(job.paidMsats).toBe(1000);
      expect(job.messages.map(message => message.type)).toEqual(["payment", "text"]);
      expect(job.messages[0]).toMatchObject({ from: "requester", content: accepted.content });
      expect(job.messages[0].seq).toBeLessThan(job.messages[1].seq);
      if (streamable) {
        await jm.processPayment(job, accepted, acceptedSeq);
        expect(job.messages.filter(message => message.type === "payment")).toHaveLength(1);
      }
      job.status = "completed";
      await jm.persistJob(job);
      expect((await store.get(job.id))?.messages.map(message => message.type)).toEqual(["payment", "text"]);
    } finally {
      jm.shutdown();
    }
  });
});
