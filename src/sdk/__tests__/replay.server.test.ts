import { describe, expect, it } from "vitest";
import { z } from "zod";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryJobStore } from "../server/memory-job-store";
import { MemoryKVStore } from "../store";

function postJson(url: string, body: string, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Job-Token": token } : {}),
    },
    body,
  });
}

function tokenHeader(token: string | undefined): Record<string, string> {
  return token ? { "X-Job-Token": token } : {};
}

function tick(ms = 50): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, ms);
  });
}

describe("durable replay", () => {
  const servers = servedApps();
  let baseUrl: string;

  async function startServer(
    descriptor: ReturnType<typeof configureDVM<any, any>>,
    opts: { jobStore: MemoryJobStore; store?: MemoryKVStore; devMode?: boolean }
  ): Promise<void> {
    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: opts.store ?? new MemoryKVStore(),
      jobStore: opts.jobStore,
      devMode: opts.devMode,
    });
    baseUrl = await servers.serve(app);
  }

  it("replays a suspended job on a fresh server", async () => {
    const jobStore = new MemoryJobStore();
    let stepCallCount = 0;

    const descriptor = configureDVM({
      name: "Replay",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        const val = await ctx.step("expensive", async () => {
          stepCallCount++;
          return 42;
        });
        ctx.text(`step result: ${String(val)}`);
        const resp = await ctx.prompt("q1", "Continue?");
        ctx.complete(`${String(val)}-${resp.text}`);
      },
    });

    await startServer(descriptor, { jobStore });

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    expect(stepCallCount).toBe(1);

    const record = await jobStore.get(job_id);
    expect(record).toBeDefined();
    expect(record?.status).toBe("awaiting-input");
    expect(record?.stepCache).toEqual([{ id: "expensive", value: 42 }]);

    await servers.closeAll();
    stepCallCount = 0;

    await startServer(descriptor, { jobStore });

    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "yes" },
    });
    const msgRes = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    expect(msgRes.status).toBe(201);
    await tick();

    expect(stepCallCount).toBe(0);

    const finalStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    const finalData = await finalStatus.json();
    expect(finalData.status).toBe("completed");
    expect(finalData.summary).toBe("42-yes");
    const finalRecord = await jobStore.get(job_id);
    expect(finalRecord?.status).toBe("completed");
    expect(finalRecord?.summary).toBe("42-yes");
  });

  it("replays through multiple yields without duplicates", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "MultiYield",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        ctx.text("step 1");
        const r1 = await ctx.prompt("q1", "First?");
        ctx.text("step 2");
        const r2 = await ctx.prompt("q2", "Second?");
        ctx.complete(`${r1.text}-${r2.text}`);
      },
    });

    await startServer(descriptor, { jobStore });

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({ type: "response", content: { prompt_id: "q1", text: "A" } }),
      job_token
    );
    await tick();

    const recordBefore = await jobStore.get(job_id);
    expect(recordBefore?.status).toBe("awaiting-input");
    expect(recordBefore?.messages.filter((m) => m.from === "provider").map((m) => m.type)).toEqual([
      "text",
      "prompt",
      "text",
      "prompt",
    ]);

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const response = await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({ type: "response", content: { prompt_id: "q2", text: "B" } }),
      job_token
    );
    await tick();

    expect(response.status).toBe(201);
    const finalRecord = await jobStore.get(job_id);
    expect(finalRecord?.status).toBe("completed");
    expect(finalRecord?.summary).toBe("A-B");
    const providerMsgsAfter = finalRecord?.messages.filter((m) => m.from === "provider") ?? [];
    const types = providerMsgsAfter.map((m) => m.type);
    expect(types).toEqual(["text", "prompt", "text", "prompt", "complete"]);
  });

  it("suppresses provider messages during replay, emits new ones after", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "MsgReplay",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        ctx.text("before prompt");
        const resp = await ctx.prompt("q1", "Ask?");
        ctx.text("after prompt");
        ctx.complete(resp.text);
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    const recordBeforeReplay = await jobStore.get(job_id);
    expect(recordBeforeReplay?.messages).toHaveLength(2);
    const seqAtYield = recordBeforeReplay?.seq ?? 0;
    expect(seqAtYield).toBe(2);

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "answer" },
    });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    await tick();

    const finalRecord = await jobStore.get(job_id);
    expect(finalRecord).toBeDefined();
    expect(finalRecord?.status).toBe("completed");

    const providerMsgs = finalRecord?.messages.filter((m) => m.from === "provider") ?? [];
    const types = providerMsgs.map((m) => m.type);
    expect(types).toEqual(["text", "prompt", "text", "complete"]);

    const newMsgs = providerMsgs.filter((m) => m.seq > seqAtYield);
    expect(newMsgs).toHaveLength(2);
    expect(newMsgs[0].type).toBe("text");
    expect(newMsgs[1].type).toBe("complete");
  });

  it("can read job status from store when not in active memory", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "StoreRead",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("done");
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(status.status).toBe("completed");
    expect(status.summary).toBe("done");
  });

  it("returns messages from store for completed jobs on a fresh server", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "MsgStore",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.text("progress");
        ctx.complete("done");
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const msgRes = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, {
      headers: tokenHeader(job_token),
    });
    expect(msgRes.status).toBe(200);
    const { messages } = await msgRes.json();
    expect(messages.length).toBeGreaterThan(0);
    const types = messages.map((m: { type: string }) => m.type);
    expect(types).toContain("text");
    expect(types).toContain("complete");
  });

  it("rejects messages on terminal jobs loaded from store", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "Terminal",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("done");
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "late" },
    });
    const msgRes = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    expect(msgRes.status).toBe(409);
  });

  it("can cancel a job from the store", async () => {
    const jobStore = new MemoryJobStore();

    const descriptor = configureDVM({
      name: "CancelStore",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        await ctx.prompt("q1", "Wait...");
        ctx.complete("done");
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const delRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      method: "DELETE",
      headers: tokenHeader(job_token),
    });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()).status).toBe("cancelled");

    const record = await jobStore.get(job_id);
    expect(record?.status).toBe("cancelled");
  });

  it("body.data persists pre-Zod so replay doesn't double-apply .transform()", async () => {
    const jobStore = new MemoryJobStore();
    const observed: number[] = [];

    const descriptor = configureDVM({
      name: "TransformReplay",
      capability: "test",
      tag: "test",
      input: z.object({ n: z.number().transform((x) => x * 2) }),
      async onJob(ctx) {
        observed.push(ctx.input.n);
        await ctx.prompt("q1", "Continue?");
        ctx.complete(`final: ${String(ctx.input.n)}`);
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", data: { n: 3 } });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    expect(observed).toEqual([6]);

    // The persisted input must be the pre-Zod form so replay re-transforms
    // from the original value, not the already-transformed one.
    const record = await jobStore.get(job_id);
    expect(record?.input).toBe('{"n":3}');

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    await postJson(
      `${baseUrl}/v1/job/${job_id}/messages`,
      JSON.stringify({ type: "response", content: { prompt_id: "q1", text: "yes" } }),
      job_token
    );
    await tick();

    // Replay must produce the same transformed value (6), not 12.
    expect(observed).toEqual([6, 6]);

    const finalStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await finalStatus.json()).summary).toBe("final: 6");
  });

  it("dispatches to onResponse after restart (Pattern B)", async () => {
    const jobStore = new MemoryJobStore();
    let responseText = "";

    const descriptor = configureDVM({
      name: "EventReactivate",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.sendMessage("prompt", { id: "q1", text: "Pick one" });
      },
      onResponse(ctx, content) {
        responseText = content.text;
        ctx.complete(`got: ${content.text}`);
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    const record = await jobStore.get(job_id);
    expect(record?.status).toBe("processing");

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "blue" },
    });
    const msgRes = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    expect(msgRes.status).toBe(201);
    await tick();

    expect(responseText).toBe("blue");

    const finalStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    const finalData = await finalStatus.json();
    expect(finalData.status).toBe("completed");
    expect(finalData.summary).toBe("got: blue");
  });

  it("dispatches to onPayment after restart (Pattern B)", async () => {
    const jobStore = new MemoryJobStore();
    let paymentReceived = false;

    const descriptor = configureDVM({
      name: "PayReactivate",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.sendMessage("payment-request", { amount_msats: 1000, reason: "fee" });
      },
      onPayment(ctx, content) {
        paymentReceived = true;
        ctx.complete(`paid ${String(content.amount_msats)}`);
      },
    });

    await startServer(descriptor, { jobStore, devMode: true });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore, devMode: true });

    const msgBody = JSON.stringify({
      type: "payment",
      content: { cashu_token: "fake-token", amount_msats: 1000 },
    });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    await tick();

    expect(paymentReceived).toBe(true);

    const finalStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await finalStatus.json()).status).toBe("completed");
  });

  it("dispatches to onCancel after restart (Pattern B)", async () => {
    const jobStore = new MemoryJobStore();
    let cancelCalled = false;

    const descriptor = configureDVM({
      name: "CancelReactivate",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.sendMessage("prompt", { id: "q1", text: "Wait..." });
      },
      onCancel() {
        cancelCalled = true;
      },
    });

    await startServer(descriptor, { jobStore });
    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();
    await tick();

    await servers.closeAll();
    await startServer(descriptor, { jobStore });

    const msgBody = JSON.stringify({ type: "cancel", content: { reason: "changed mind" } });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);
    await tick();

    expect(cancelCalled).toBe(true);

    const finalStatus = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await finalStatus.json()).status).toBe("cancelled");
  });
});
