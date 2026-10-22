import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { StepRecord } from "../../step-cache";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

const managers: { shutdown(): void }[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.shutdown(); });

function context(saveStep?: (jobId: string, record: StepRecord) => Promise<void>) {
  const descriptor = configureDVM({
    name: "step-test", capability: "test", onJob: async () => {},
  });
  const store = Object.assign(new MemoryJobStore(), { saveStep });
  const manager = new JobManager(descriptor, {
    env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true, staleJobTimeoutMs: 0, fxFetcher: createFxFetcher(),
  });
  managers.push(manager);
  const job = manager.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
  return { job, ctx: manager.buildAndAttachContext(job, "") };
}

describe("step persistence", () => {
  it("waits for the write, including cache hits while the write is pending, and includes costs", async () => {
    const write = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const save = vi.fn(async () => { started.resolve(); await write.promise; });
    const { ctx, job } = context(save);
    const body = vi.fn(async () => {
      ctx.cost({ amount: 0.25, currency: "usd" });
      return "reservation";
    });
    let resolved = false;
    const step = ctx.step("reserve", body).then(value => { resolved = true; return value; });
    await started.promise;
    const cached = vi.fn();
    const hit = ctx.step("reserve", body).then(cached);
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(cached).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledWith(job.id, {
      id: "reserve", value: "reservation", costs: [{ amount: 0.25, currency: "usd" }],
    });
    write.resolve();
    expect(await step).toBe("reservation");
    await hit;
    expect(cached).toHaveBeenCalledWith("reservation");
    expect(body).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });

  it("retries only persistence after transient failures", async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
      .mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(undefined);
    const { ctx } = context(save);
    const body = vi.fn(async () => 42);
    expect(await ctx.step("reserve", body)).toBe(42);
    expect(save).toHaveBeenCalledTimes(3);
    expect(body).toHaveBeenCalledOnce();
  });

  it("logs exhausted writes and keeps the completed result available for later snapshots", async () => {
    const save = vi.fn().mockRejectedValue(new Error("unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx, job } = context(save);
    const body = vi.fn(async () => "reservation");
    expect(await ctx.step("reserve", body)).toBe("reservation");
    expect(save).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line))))
      .toContainEqual({ event: "step_persist_failed", level: "warn" });
    expect(await ctx.step("reserve", body)).toBe("reservation");
    expect(body).toHaveBeenCalledOnce();
    expect(job.stepCache.serialize()).toEqual([{ id: "reserve", value: "reservation" }]);
  });

  it("does not store a failed body", async () => {
    const save = vi.fn();
    const { ctx, job } = context(save);
    await expect(ctx.step("reserve", async () => { throw new Error("vendor failed"); }))
      .rejects.toThrow("vendor failed");
    expect(save).not.toHaveBeenCalled();
    expect(job.stepCache.has("reserve")).toBe(false);
  });
});
