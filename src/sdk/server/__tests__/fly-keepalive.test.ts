import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import type { JobManager } from "../job-manager";

const flyEnv = { FLY_APP_NAME: "example-app", FLY_MACHINE_ID: "example-machine" };
const incompleteEnvs: Record<string, string>[] = [{}, { FLY_APP_NAME: "example-app" }, { FLY_MACHINE_ID: "example-machine" }];
const managers: JobManager<unknown, undefined>[] = [];

async function manager(
  onJob: (ctx: SDKJobContext<unknown, unknown>) => void | Promise<void>,
  env: Record<string, string> = flyEnv,
) {
  const { JobManager } = await import("../job-manager");
  const instance = new JobManager(configureDVM({
    name: "keepalive-test", capability: "work", jobRetentionDays: 0, onJob,
  }), {
    env, store: new MemoryKVStore(), devMode: true, fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0, processingWatchdogMs: 0, heartbeatIntervalMs: 0,
  });
  managers.push(instance);
  return instance;
}

async function start(instance: JobManager<unknown, undefined>) {
  const job = instance.createJob({ input: "" }, "caller", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
  await instance.persistJob(job);
  instance.runHandler(job, instance.buildAndAttachContext(job, ""));
  return job;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});

afterEach(async () => {
  for (const instance of managers.splice(0)) instance.shutdown();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Fly keepalive handler lifetime", () => {
  it("pings at 15 seconds only during execution, stopping before the cleanup window ends", async () => {
    const gate = Promise.withResolvers<void>();
    const instance = await manager(async ctx => { await gate.promise; ctx.complete("done"); });
    const intervals = vi.spyOn(globalThis, "setInterval");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();

    const job = await start(instance);
    expect(intervals).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15_000);
    expect(intervals.mock.results[0].value.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const target = new URL(String(url));
    expect(target).toMatchObject({
      protocol: "http:", pathname: "/_sdk/keepalive", port: "", search: "", hash: "", username: "", password: "",
    });
    expect(target.hostname.split(".")).toEqual(["example-app", "flycast"]);
    expect(init).toEqual({
      headers: { "fly-force-instance-id": "example-machine" },
      signal: expect.any(AbortSignal), redirect: "error",
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await job.terminalWork;
    expect(job.status).toBe("completed");
    expect(instance.activeJobs.has(job.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(instance.activeJobs.has(job.id)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["same manager", "different managers"])("shares one timer for overlapping handlers in %s", async where => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const gates = [first, second];
    const onJob = async (ctx: SDKJobContext<unknown, unknown>) => {
      await gates.shift()!.promise;
      ctx.complete("done");
    };
    const one = await manager(onJob);
    const two = where === "same manager" ? one : await manager(onJob);
    const intervals = vi.spyOn(globalThis, "setInterval");
    await start(one);
    await vi.advanceTimersByTimeAsync(5_000);
    await start(two);
    expect(intervals).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps protecting a terminal job until its handler promise settles", async () => {
    const tail = Promise.withResolvers<void>();
    const instance = await manager(async ctx => { ctx.complete("done"); await tail.promise; });
    const job = await start(instance);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(job.status).toBe("completed");
    expect(fetch).toHaveBeenCalledTimes(1);
    tail.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(incompleteEnvs)(
    "creates no timer with incomplete explicit environment %j", async env => {
      vi.stubEnv("FLY_APP_NAME", "ambient-app");
      vi.stubEnv("FLY_MACHINE_ID", "ambient-machine");
      const gate = Promise.withResolvers<void>();
      const instance = await manager(() => gate.promise, env);
      const intervals = vi.spyOn(globalThis, "setInterval");
      await start(instance);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(intervals).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      gate.resolve();
    },
  );

  it.each(["synchronous", "asynchronous"])("releases protection when a handler throws %s", async kind => {
    const gate = Promise.withResolvers<void>();
    const instance = await manager(kind === "synchronous"
      ? () => { throw new Error("handler failed"); }
      : async () => { await gate.promise; throw new Error("handler failed"); });
    const job = await start(instance);
    if (kind === "asynchronous") {
      await vi.advanceTimersByTimeAsync(15_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await job.terminalWork;
    expect(job.status).toBe("failed");
    const count = vi.mocked(fetch).mock.calls.length;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(count);
  });

  it("retries DNS and HTTP failures, warns once across idle periods, and preserves the job result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ENOTFOUND"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const first = Promise.withResolvers<void>();
    const instance = await manager(async ctx => { await first.promise; ctx.complete("done"); });
    const job = await start(instance);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await job.terminalWork;
    expect(job.status).toBe("completed");
    instance.shutdown();

    vi.mocked(fetch).mockRejectedValueOnce(new Error("ENOTFOUND"));
    const second = Promise.withResolvers<void>();
    const other = await manager(async ctx => { await second.promise; ctx.complete("done"); });
    const next = await start(other);
    await vi.advanceTimersByTimeAsync(15_000);
    second.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await next.terminalWork;
    expect(next.status).toBe("completed");
    expect(warn.mock.calls.filter(([line]) => JSON.parse(String(line)).event === "fly_keepalive_failed")).toHaveLength(1);
  });

  it("aborts a slow request after five seconds and retries without overlap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const gate = Promise.withResolvers<void>();
    const instance = await manager(() => gate.promise);
    await start(instance);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(signal?.aborted).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    gate.resolve();
  });

  it("does not pile up requests while an aborted fetch is still settling", async () => {
    const request = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => request.promise);
    const gate = Promise.withResolvers<void>();
    const instance = await manager(() => gate.promise);
    await start(instance);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    request.resolve(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    gate.resolve();
  });

  it("shutdown aborts in-flight requests and later settlements cannot restart the timer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let signal: AbortSignal | undefined;
    vi.mocked(fetch).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const gate = Promise.withResolvers<void>();
    const instance = await manager(() => gate.promise);
    await start(instance);
    await vi.advanceTimersByTimeAsync(15_000);
    instance.shutdown();
    instance.shutdown();
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("shutting down one manager preserves another manager's active protection", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const one = await manager(() => first.promise);
    const two = await manager(() => second.promise);
    await start(one);
    await start(two);
    one.shutdown();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    first.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    second.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("restarts during an intentional abort without warning or overlapping requests", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const request = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => request.promise);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const one = await manager(() => first.promise);
    const two = await manager(() => second.promise);
    await start(one);
    await vi.advanceTimersByTimeAsync(15_000);
    one.shutdown();
    await start(two);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    request.reject(new Error("aborted"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    first.resolve();
    second.resolve();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
