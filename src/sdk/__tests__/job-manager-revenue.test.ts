import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../configure";
import type { FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";
import type { JobManager } from "../server/job-manager";

const TERMINAL_LIFECYCLE_DEADLINE_MS = 1_000;
type LifecycleJobManager = Pick<JobManager<unknown, undefined>, "activeJobs">;

async function awaitTerminalBoundary(jobManager: LifecycleJobManager, jobId: string): Promise<void> {
  const terminalWork = await vi.waitFor(() => {
    const work = jobManager.activeJobs.get(jobId)?.terminalWork;
    expect(work).toBeDefined();
    return work!;
  }, { timeout: TERMINAL_LIFECYCLE_DEADLINE_MS });
  await terminalWork;
}

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe("onJobCompleted callback", () => {
  it("does not report revenue for an unpaid completed job", async () => {
    const callback = vi.fn();
    const dvm = configureDVM({
      name: "RevTest",
      capability: "test",
      tag: "test",
      onJob(ctx) {
        ctx.complete("done");
      },
    });

    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      dvmId: "dvm-test-123",
      fxFetcher: stubFx,
      onJobCompleted: callback,
    });

    const res = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect([200, 202]).toContain(res.status);

    const { job_id: jobId } = (await res.json()) as { job_id: string };
    // The terminal promise is definitive: once it settles, any revenue callback
    // this terminal path would emit has run. A brief absence window is not evidence.
    await awaitTerminalBoundary(jobManager, jobId);

    // No price + no payment rails → paidMsats stays 0, so callback should NOT fire
    expect(callback).not.toHaveBeenCalled();

    jobManager.shutdown();
  });

  it("reports declared cost when a caller cancels before the job earns revenue", async () => {
    const revenue = vi.fn();
    const costs = vi.fn();
    const dvm = configureDVM({
      name: "CancelCostTest",
      capability: "test",
      tag: "test",
      async onJob(ctx) {
        ctx.cost({ amount: 0.0025, currency: "usd" });
        await ctx.prompt("wait", "Continue?");
        ctx.complete("done");
      },
    });

    const { app, jobManager } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      dvmId: "dvm-test-cancel-cost",
      fxFetcher: stubFx,
      onJobCompleted: revenue,
      onJobCost: costs,
    });

    const submitted = await app.request("/v1/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "hello" }),
    });
    expect(submitted.status).toBe(202);
    const { job_id: jobId, job_token: jobToken } = (await submitted.json()) as {
      job_id: string;
      job_token: string;
    };
    const cancelled = await app.request(`/v1/job/${jobId}`, {
      method: "DELETE",
      headers: { "X-Job-Token": jobToken },
    });
    expect(cancelled.status).toBe(200);

    expect(revenue).not.toHaveBeenCalled();
    expect(costs).toHaveBeenCalledWith({
      dvmId: "dvm-test-cancel-cost",
      jobId,
      capability: "test",
      outcome: "cancelled",
      costRevision: 1,
      cost: { amountMicro: 2_500, currency: "usd" },
    });
    jobManager.shutdown();
  });
});
