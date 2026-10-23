import { describe, expect, it } from "vitest";

import type { Message } from "../../../lib/messages/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { OutgoingMessage } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";

class DelayedInboundStore extends MemoryJobStore {
  afterRecord?: () => Promise<void>;

  override async recordInbound(jobId: string, message: OutgoingMessage): Promise<number> {
    const seq = await super.recordInbound(jobId, message);
    await this.afterRecord?.();
    return seq;
  }
}

const servers = servedApps();

describe("payment history across hosts", () => {
  it.each([true, false])("delivers final SSE and retained history with paymentAccepted=%s", async (paymentAccepted) => {
    let finish!: () => void;
    const work = new Promise<void>(resolve => { finish = resolve; });
    const descriptor = configureDVM({
      name: "shared-payment-history", capability: "test",
      async onJob(ctx) {
        ctx.working();
        await work;
        ctx.complete("done");
      },
    });
    const backing = new DelayedInboundStore();
    const options = { env: {}, store: new MemoryKVStore(), jobStore: backing, devMode: true, mints: ["https://mint.example.com"] };
    const worker = await createDVMServer(descriptor, options);
    const other = await createDVMServer(descriptor, options);
    const workerUrl = await servers.serve(worker.app);
    const otherUrl = await servers.serve(other.app);
    const abort = new AbortController();
    let release!: () => void;
    let streamed: Promise<Response> | undefined;
    let paid: Promise<Response> | undefined;
    try {
      const submitted = await fetch(`${workerUrl}/v1/job`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "" }),
      });
      expect(submitted.status).toBe(202);
      const { job_id, job_token } = await submitted.json() as { job_id: string; job_token: string };
      const headers = { "Content-Type": "application/json", "X-Job-Token": job_token };
      const job = worker.jobManager.activeJobs.get(job_id)!;
      const initial = await fetch(`${workerUrl}/v1/job/${job_id}/messages`, { headers });
      const initialMessages = (await initial.json() as { messages: Message[] }).messages;
      const initialCursor = Math.max(...initialMessages.map(message => message.seq));
      streamed = fetch(`${workerUrl}/v1/job/${job_id}/messages?after=${initialCursor}`, {
        headers: { ...headers, Accept: "text/event-stream" }, signal: abort.signal,
      });
      job.sdkCtx!.sendMessage("text", { text: "Stream ready" });
      await job.messageAppenderTail;
      const response = await streamed;
      const ready = await fetch(`${workerUrl}/v1/job/${job_id}/messages`, { headers });
      const cursor = Math.max(...(await ready.json() as { messages: Message[] }).messages.map(message => message.seq));
      if (paymentAccepted) {
        let recorded!: () => void;
        const pending = new Promise<void>(resolve => { recorded = resolve; });
        const paused = new Promise<void>(resolve => { release = resolve; });
        backing.afterRecord = async () => { recorded(); await paused; };
        paid = fetch(`${otherUrl}/v1/job/${job_id}/messages`, {
          method: "POST", headers, body: JSON.stringify({ type: "payment", content: { dev_auto: true } }),
        });
        await pending;
      } else {
        await worker.jobManager.recordInboundPending(job, "payment", { dev_auto: true });
      }
      job.sdkCtx!.sendMessage("text", { text: "During verification" });
      await job.messageAppenderTail;
      const during = await fetch(`${workerUrl}/v1/job/${job_id}/messages?after=${cursor}`, { headers });
      expect((await during.json() as { messages: Message[] }).messages).toEqual([]);
      if (paymentAccepted) {
        release();
        expect((await paid!).status).toBe(201);
      }
      finish();
      const messages = (await response.text()).split("\n").filter(line => line.startsWith("data:"))
        .map(line => JSON.parse(line.slice(5).trim()) as Message);
      const expected = paymentAccepted ? ["payment", "text", "complete"] : ["text", "complete"];
      expect(messages[0].content).toMatchObject({ text: "Stream ready" });
      expect(messages.slice(1).map(message => message.type)).toEqual(expected);
      expect(messages.slice(1).every(message => message.seq > cursor)).toBe(true);
      await job.terminalWork;
      const retained = await fetch(`${otherUrl}/v1/job/${job_id}/messages?after=${cursor}`, { headers });
      expect((await retained.json() as { messages: Message[] }).messages.map(message => message.type)).toEqual(expected);
    } finally {
      release?.();
      finish();
      abort.abort();
      await streamed?.catch(() => undefined);
      await paid?.catch(() => undefined);
      worker.jobManager.shutdown();
      other.jobManager.shutdown();
    }
  });
});
