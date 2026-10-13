/**
 * It used to ride the per-DVM watcher machine's four-minute poll — which is
 * precisely what kept an idle DVM awake and billing its builder. It cannot
 * move to a timer for the same reason. The forced-close guarantee does not
 * depend on this path at all; that is the chain-event wake.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";
import type { MppxServer } from "../mpp-setup";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

function sweepingMpp(sweep: ReturnType<typeof vi.fn>): MppxServer {
  return {
    realm: "tempo-routine-sweep.test",
    methods: [],
    challenge: {},
    sweepTempoSessions: sweep
  } as unknown as MppxServer;
}

async function startDvm(sweep?: ReturnType<typeof vi.fn>) {
  const dvm = configureDVM({
    name: "tempo-routine-sweep-test",
    capability: "do",
    input: z.object({ text: z.string() }),
    onJob(ctx) {
      ctx.complete("done");
    }
  });
  return createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    ...(sweep ? { mpp: sweepingMpp(sweep) } : {})
  });
}

function submit(app: Awaited<ReturnType<typeof startDvm>>["app"]) {
  return app.request("/v1/job", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "do", data: { text: "hi" } })
  });
}

describe("opportunistic Tempo settlement", () => {
  it("kicks the sweep off ordinary job traffic", async () => {
    const sweep = vi.fn(() =>
      Promise.resolve({ scanned: 1, closeRequested: 0, settled: 0, inFlight: 0 })
    );
    const { app } = await startDvm(sweep);

    await submit(app);

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("throttles, so a busy DVM does not scan its store per request", async () => {
    const sweep = vi.fn(() =>
      Promise.resolve({ scanned: 1, closeRequested: 0, settled: 0, inFlight: 0 })
    );
    const { app } = await startDvm(sweep);

    await submit(app);
    await submit(app);
    await submit(app);

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("never makes the request wait on it", async () => {
    // A settlement that hangs must not hang the caller's job submit.
    const sweep = vi.fn(() => new Promise<never>(() => undefined));
    const { app } = await startDvm(sweep);

    const res = await submit(app);

    expect(res.status).toBe(200);
    expect(sweep).toHaveBeenCalled();
  });

  it("swallows a failing sweep rather than failing the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sweep = vi.fn(() => Promise.reject(new Error("rpc down")));
    const { app } = await startDvm(sweep);

    const res = await submit(app);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      '{"event":"tempo_routine_sweep_failed","level":"warn"}'
    );
    warn.mockRestore();
  });

  it("records a sweep that only deferred to an in-flight settlement", async () => {
    // Settling nothing because the close-event path already holds the lease is
    // the guard working, and this log is the only place that is visible.
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const sweep = vi.fn(() =>
      Promise.resolve({
        scanned: 1,
        closeRequested: 0,
        settled: 0,
        inFlight: 1
      })
    );
    const { app } = await startDvm(sweep);

    await submit(app);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const logged = info.mock.calls.map(([l]) => String(l)).join("\n");
    expect(logged).toContain('{"event":"tempo_routine_sweep","level":"info"}');
    expect(logged).not.toContain("inFlight");
    info.mockRestore();
  });

  it("is inert on a DVM with no Tempo session runtime", async () => {
    const { app } = await startDvm();

    expect((await submit(app)).status).toBe(200);
  });
});
