import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { localMessage, providerMessage } from "../job";
import { JobManager } from "../job-manager";
import type { JobStore } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";

describe("inbound payment history", () => {
  it.each([
    { rail: "cashu", content: { cashu_token: "invalid-token" } },
    { rail: "x402", content: { x402_payment: "invalid" } },
    { rail: "tempo", content: { tempo_credential: { challenge: { id: "unsupported" }, payload: {} } } },
  ])("keeps a rejected $rail payment out of GET history", async ({ content }) => {
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
        body: JSON.stringify({ type: "payment", content }),
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

  it.each([false, true])("keeps a late accepted payment reachable with anotherHost=%s", async (anotherHost) => {
    const descriptor = configureDVM({
      name: "payment-cursor", capability: "test", onJob: async () => undefined,
    });
    const backing = new MemoryJobStore();
    const options = { env: {}, store: new MemoryKVStore(), jobStore: backing, devMode: true, mints: ["https://mint.example.com"] };
    const { app, jobManager } = await createDVMServer(descriptor, options);
    const reader = anotherHost ? await createDVMServer(descriptor, options) : undefined;
    try {
      const submitted = await app.request("/v1/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "" }),
      });
      const { job_id, job_token } = await submitted.json() as { job_id: string; job_token: string };
      const headers = { "X-Job-Token": job_token };
      const job = jobManager.activeJobs.get(job_id)!;
      providerMessage(job, "text", { text: "Before payment" });
      await jobManager.persistJob(job);
      job.pendingPaymentMsats = 1000;
      const payment = { type: "payment" as const, content: { dev_auto: true } };
      const seq = await jobManager.recordInboundPending(job, payment.type, payment.content);
      const live: string[] = [];
      job.listeners.add(message => live.push(message.type));
      providerMessage(job, "text", { text: "During verification" });
      await jobManager.persistJob(job);
      async function read(after = 0) {
        const response = await (reader?.app ?? app).request(`/v1/job/${job_id}/messages?after=${after}`, { headers });
        expect(response.status).toBe(200);
        return (await response.json() as { messages: { seq: number; type: string }[] }).messages;
      }
      const during = await read();
      const cursor = Math.max(0, ...during.map(message => message.seq));
      expect(await read(cursor)).toEqual([]);
      expect(live).toEqual([]);
      expect((await jobManager.processPayment(job, payment, seq)).error).toBeUndefined();
      expect((await read(cursor)).map(message => message.type)).toEqual(["payment", "text"]);
      expect(live).toEqual(["payment", "text"]);
    } finally {
      jobManager.shutdown();
      reader?.jobManager.shutdown();
    }
  });

  it("delivers cancellation without waiting for an in-flight payment", async () => {
    const store = new MemoryJobStore();
    const jm = new JobManager(configureDVM({ name: "cancel-payment-history", capability: "test", onJob: async () => undefined }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      fxFetcher: createFxFetcher(),
    });
    try {
      const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
      await jm.persistJob(job);
      const local: string[] = [];
      const durable: string[] = [];
      job.listeners.add(message => local.push(message.type));
      const unsubscribe = await store.subscribeMessages(job.id, 0, message => durable.push(message.type));
      try {
        const payment = { type: "payment" as const, content: { dev_auto: true } };
        const seq = await jm.recordInboundPending(job, payment.type, payment.content);
        providerMessage(job, "text", { text: "Before cancellation" });
        await job.messageAppenderTail;
        await store.cancelJob(job.id, "Stopped");
        localMessage(job, "provider", "cancel", { reason: "Stopped" });
        expect(local).toEqual(["text", "cancel"]);
        expect(durable).toEqual(["text", "cancel"]);
        await expect(jm.processPayment(job, payment, seq)).rejects.toThrow("not found");
        expect(job.messages.filter(message => message.type === "payment")).toEqual([]);
      } finally {
        unsubscribe();
      }
    } finally {
      jm.shutdown();
    }
  });

  it.each([true, false])("holds durable reads and subscriptions behind pending payments, accepted=%s", async (accepted) => {
    const store = new MemoryJobStore();
    const jm = new JobManager(configureDVM({ name: "payment-store-cursor", capability: "test", onJob: async () => undefined }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      fxFetcher: createFxFetcher(),
    });
    try {
      const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
      await jm.persistJob(job);
      const seen: string[] = [];
      const unsubscribe = await store.subscribeMessages(job.id, 0, message => seen.push(message.type));
      try {
        const seq = await store.recordInbound(job.id, { from: "requester", type: "payment", content: { x402_payment: "proof" }, timestamp: 1 });
        await store.appendOutgoing(job.id, { from: "provider", type: "text", content: { text: "During verification" }, timestamp: 2 });
        expect(await store.getMessages(job.id, 0)).toEqual([]);
        expect(seen).toEqual([]);
        if (accepted) await store.verifyAndCredit(job.id, seq, null);
        else await store.markInboundFailed(job.id, seq, "payment_invalid");
        const expected = accepted ? ["payment", "text"] : ["text"];
        expect((await store.getMessages(job.id, 0)).map(message => message.type)).toEqual(expected);
        expect(seen).toEqual(expected);
      } finally {
        unsubscribe();
      }
    } finally {
      jm.shutdown();
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
