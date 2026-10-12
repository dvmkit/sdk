import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import { createDVMServer } from "../server/app";
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

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await servers.closeAll();
  });

  async function startApp(descriptor: ReturnType<typeof configureDVM<any, any>>): Promise<void> {
    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
    });
    baseUrl = await servers.serve(app);
  }

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

  it("resets idle timer when a message arrives", async () => {
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

    // Send response — should reset timer
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
