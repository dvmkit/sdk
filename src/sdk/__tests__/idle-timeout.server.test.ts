import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
import { MemoryJobStore } from "../server/memory-job-store";
import { MemoryKVStore } from "../store";

/** POST JSON to a URL. */
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

/** header object for the anonymous-flow per-job token. */
function tokenHeader(token: string | undefined): Record<string, string> {
  return token ? { "X-Job-Token": token } : {};
}

describe("idle timeout", () => {
  const servers = servedApps();
  let baseUrl: string;
  const shutdowns: (() => Promise<void>)[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await servers.closeAll();
    for (const shutdown of shutdowns.splice(0)) await shutdown();
  });

  async function startApp(descriptor: ReturnType<typeof configureDVM<any, any>>, jobStore?: MemoryJobStore): Promise<() => Promise<void>> {
    const { app, shutdown } = await createDVMServer(descriptor, {
      env: {},
      jobStore,
      devMode: true,
      store: new MemoryKVStore(),
    });
    baseUrl = await servers.serve(app);
    shutdowns.push(shutdown);
    return shutdown;
  }

  it.each(["prompt", "payment-request"] as const)("expires event-driven %s without replaying onJob", async (type) => {
    const jobStore = new MemoryJobStore();
    let calls = 0;
    const descriptor = configureDVM({ name: "Events", capability: "test", idleTimeout: 3,
      onJob(ctx) {
        calls++;
        if (type === "prompt") ctx.sendMessage(type, { id: "q1", text: "Continue?" });
        else ctx.sendMessage(type, { amount_msats: 1000, reason: "Next block" });
      },
    });
    const stop = await startApp(descriptor, jobStore);
    const submitted = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await submitted.json();
    const messages = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, { headers: tokenHeader(job_token) });
    const ask = (await messages.json()).messages.find((m: { type: string }) => m.type === type);
    await stop();
    await jobStore.shutdownStreaming();
    await vi.advanceTimersByTimeAsync(1000);
    await startApp(descriptor, jobStore);
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, JSON.stringify({ type: "text", content: { text: "thinking" } }), job_token);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(Math.max(0, ask.content.expires_at_ms - Date.now() + 100));
    const result = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    expect((await result.json()).status).toBe("cancelled");
    expect((await jobStore.get(job_id))?.endedBy).toBe("caller");
  });

  it("completes a working job after three idle windows", async () => {
    await startApp(configureDVM({ name: "Working", capability: "test", idleTimeout: 1,
      async onJob(ctx) {
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          ctx.progress(i / 6);
        }
        ctx.complete("done");
      },
    }));
    const res = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await res.json();
    await vi.advanceTimersByTimeAsync(3100);
    const result = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    expect((await result.json()).status).toBe("completed");
  });

  it.each(["prompt", "payment-request"] as const)("keeps a delayed %s deadline through HTTP reactivation", async (type) => {
    const jobStore = new MemoryJobStore();
    const descriptor = configureDVM({ name: "Delayed", capability: "test", idleTimeout: 3,
      async onJob(ctx) {
        await ctx.step("work", () => new Promise((resolve) => setTimeout(() => resolve("done"), 2500)));
        if (type === "prompt") await ctx.prompt("q1", "Continue?");
        else await ctx.requestPayment(1000, "Next block");
        ctx.complete("done");
      },
    });
    await startApp(descriptor, jobStore);
    const res = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await res.json();
    await vi.advanceTimersByTimeAsync(2500);
    const first = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, { headers: tokenHeader(job_token) });
    const initial = await first.json();
    const ask = initial.messages.find((m: { type: string }) => m.type === type);
    expect(ask.content.expires_at_ms).toBeGreaterThan(Date.now() + 2800);
    await vi.advanceTimersByTimeAsync(1000);
    await startApp(descriptor, jobStore);
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, JSON.stringify({ type: "text", content: { text: "thinking" } }), job_token);
    const recovered = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    const waiting = await recovered.json();
    expect(waiting.status).toBe("awaiting-input");
    const replayedMessages = await fetch(`${baseUrl}/v1/job/${job_id}/messages`, { headers: tokenHeader(job_token) });
    expect((await replayedMessages.json()).messages.filter((m: { type: string }) => m.type === type)).toEqual([ask]);
    await vi.advanceTimersByTimeAsync(Math.max(0, ask.content.expires_at_ms - Date.now() + 100));
    const final = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    expect((await final.json()).status).toBe("cancelled");
    expect((await jobStore.get(job_id))?.endedBy).toBe("caller");
  });

  it.each(["response", "payment"] as const)("resumes recovery when a late %s has already satisfied the ask", async (type) => {
    const jobStore = new MemoryJobStore();
    const descriptor = configureDVM({ name: "Recovery", capability: "test", idleTimeout: 1,
      async onJob(ctx) {
        if (type === "response") await ctx.prompt("q1", "Continue?");
        else await ctx.requestPayment(1000, "Next block");
        ctx.complete("done");
      },
    });
    const stop = await startApp(descriptor, jobStore);
    const res = await postJson(`${baseUrl}/v1/job`, JSON.stringify({ capability: "test", input: "" }));
    const { job_id, job_token } = await res.json();
    await stop();
    await jobStore.shutdownStreaming();
    await vi.advanceTimersByTimeAsync(1500);
    await startApp(descriptor, jobStore);
    const content = type === "response" ? { prompt_id: "q1", text: "yes" } : { cashu_token: "fake-token", amount_msats: 1000 };
    const answered = await postJson(`${baseUrl}/v1/job/${job_id}/messages`, JSON.stringify({ type, content }), job_token);
    expect(answered.status).toBe(201);
    const final = await fetch(`${baseUrl}/v1/job/${job_id}`, { headers: tokenHeader(job_token) });
    expect((await final.json()).status).toBe("completed");
  });

  it("cancels a job after idleTimeout expires", async () => {
    await startApp(
      configureDVM({
        name: "Idle",
        capability: "test",
        tag: "test",
        idleTimeout: 5, // 5 seconds
        async onJob(ctx) {
          await ctx.prompt("q1", "Question?");
          ctx.complete("done");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await statusRes.json()).status).toBe("awaiting-input");

    // Advance time past the idle timeout
    vi.advanceTimersByTime(6_000);

    // Allow microtasks to settle
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    const finalRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await finalRes.json()).status).toBe("cancelled");
  });

  it("starts a fresh window when the next prompt is emitted", async () => {
    await startApp(
      configureDVM({
        name: "IdleReset",
        capability: "test",
        tag: "test",
        idleTimeout: 5,
        async onJob(ctx) {
          const r1 = await ctx.prompt("q1", "First?");
          const r2 = await ctx.prompt("q2", "Second?");
          ctx.complete(`${r1.text}-${r2.text}`);
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    // Advance 4 seconds (less than timeout)
    vi.advanceTimersByTime(4_000);

    // Answering the first prompt lets the handler emit the second.
    const msgBody = JSON.stringify({
      type: "response",
      content: { prompt_id: "q1", text: "A" },
    });
    await postJson(`${baseUrl}/v1/job/${job_id}/messages`, msgBody, job_token);

    // Allow handler to resume
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    // Advance another 4 seconds (total 8s from start, but only 4s since last activity)
    vi.advanceTimersByTime(4_000);

    // Job should still be awaiting second prompt (not cancelled)
    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await statusRes.json()).status).toBe("awaiting-input");

    // Now advance past the second idle timeout
    vi.advanceTimersByTime(6_000);
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    const finalRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await finalRes.json()).status).toBe("cancelled");
  });

  it("does not cancel a completed job", async () => {
    await startApp(
      configureDVM({
        name: "FastComplete",
        capability: "test",
        tag: "test",
        idleTimeout: 2,
        onJob(ctx) {
          ctx.complete("instant");
        },
      })
    );

    const body = JSON.stringify({ capability: "test", input: "" });
    const res = await postJson(`${baseUrl}/v1/job`, body);
    const { job_id, job_token } = await res.json();

    // Advance past timeout
    vi.advanceTimersByTime(3_000);
    await new Promise((r) => {
      setTimeout(r, 0);
    });

    const statusRes = await fetch(`${baseUrl}/v1/job/${job_id}`, {
      headers: tokenHeader(job_token),
    });
    expect((await statusRes.json()).status).toBe("completed");
  });
});
