/**
 * Exercise remote DELETE through two full apps sharing a store; it must abort the handler on the
 * other machine.
 */
import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { createDVMServer } from "../app";
import type { JobManagerOpts } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

/** Just enough of the Hono app to drive a request — avoids threading its generics. */
interface TestApp {
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
}

/** Deterministic fx stub — $100,000/BTC. */
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/** Let fire-and-forget persists settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The notify-subscriber registry, so a leaked per-job watcher is visible. */
function notifySubscriberCount(store: MemoryJobStore, jobId: string): number {
  const subs = (store as unknown as { notifySubscribers: Map<string, Set<unknown>> })
    .notifySubscribers;
  return subs.get(jobId)?.size ?? 0;
}

describe("cross-machine cancel", () => {
  it("aborts a handler running on another machine, and blocks its late writes", async () => {
    const jobStore = new MemoryJobStore();

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let sawAbort!: () => void;
    const abortReached = new Promise<void>((resolve) => (sawAbort = resolve));

    const handler = {
      abortedWhenResumed: undefined as boolean | undefined,
      cancelReason: undefined as string | undefined,
    };
    const costs: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0][] = [];

    const descriptor = configureDVM({
      name: "cross-machine-cancel",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob: async (ctx: SDKJobContext<unknown, unknown>) => {
        // Deliberately after the submission snapshot and before any yield: B's
        // store-only cancel cannot see this cost, so A must report it when it
        // adopts the durable terminal.
        ctx.cost({ amount: 0.0025, currency: "usd" });
        ctx.signal.addEventListener("abort", () => {
          sawAbort();
        });
        await blocked;
        handler.abortedWhenResumed = ctx.signal.aborted;
        // The zombie's last gasp: neither may reach the durable log.
        ctx.text("late");
        ctx.complete("resurrect");
      },
      onCancel: (ctx, content) => {
        handler.cancelReason = content.reason;
        // The job is already terminal when the hook runs, on this machine as on
        // the one the DELETE landed on — the emit is a no-op warning either way.
        ctx.text("released the lock");
      },
    });

    const serverOpts = {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
      fxFetcher: stubFx,
      dvmId: "dvm-cross-machine-cancel",
      onJobCost: (info: (typeof costs)[number]) => {
        costs.push(info);
      },
    };
    // Machine A runs the handler; machine B only shares the store.
    const machineA = await createDVMServer(descriptor, serverOpts);
    const machineB = await createDVMServer(descriptor, {
      ...serverOpts,
      store: new MemoryKVStore(),
    });

    try {
      const submit = await machineA.app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      expect(submit.status).toBe(202);
      const { job_id: jobId, job_token: jobToken } = (await submit.json()) as {
        job_id: string;
        job_token: string;
      };
      expect(machineA.jobManager.activeJobs.has(jobId)).toBe(true);
      expect(machineB.jobManager.activeJobs.has(jobId)).toBe(false);

      const deleted = await deleteJob(machineB.app, jobId, jobToken, "caller changed their mind");
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ status: "cancelled" });

      // B's cancellation must abort the handler on A even though A has not
      // written anything to the store since the handler started.
      await abortReached;
      const jobOnA = machineA.jobManager.activeJobs.get(jobId);
      expect(jobOnA?.abort.signal.aborted).toBe(true);
      expect(jobOnA?.status).toBe("cancelled");
      expect(handler.cancelReason).toBe("caller changed their mind");
      expect((await jobStore.get(jobId))?.costAmountMicro).toBeUndefined();
      expect(costs).toEqual([
        {
          dvmId: "dvm-cross-machine-cancel",
          jobId,
          capability: "test",
          outcome: "cancelled",
          costRevision: 1,
          cost: { amountMicro: 2_500, currency: "usd" },
        },
      ]);
      // A adopts the whole terminal row, not just its status: a `persistJob`
      // after this point would otherwise write `summary = NULL` over the
      // caller's reason (the sticky `save` admits a same-status re-save).
      expect(jobOnA?.summary).toBe("caller changed their mind");

      // A still holds the job in `activeJobs` for the cleanup window, and serves
      // reads from memory while it does — so the cancel every other machine
      // serves from the durable log has to be there too.
      const onA = await fetchMessages(machineA.app, jobId, jobToken);
      expect(onA.some((m) => m.type === "cancel")).toBe(true);
      expect(onA.some((m) => m.type === "text")).toBe(false); // onCancel's emit, suppressed

      release();
      await settle();
      await settle();

      expect(handler.abortedWhenResumed).toBe(true);
      const record = await jobStore.get(jobId);
      expect(record?.status).toBe("cancelled");
      // The cancel's reason, not the zombie's "resurrect" completion summary.
      expect(record?.summary).toBe("caller changed their mind");
      expect(record?.messages.some((m) => m.type === "cancel")).toBe(true);
      expect(record?.messages.some((m) => m.type === "complete" || m.type === "text")).toBe(false);

      // The watcher is a subscriber on the store's shared LISTEN connection —
      // it must not outlive the job.
      expect(notifySubscriberCount(jobStore, jobId)).toBe(0);
    } finally {
      release();
      machineA.shutdown();
      machineB.shutdown();
    }
  });

  it("closes an SSE stream open on the handler's own machine", async () => {
    // The stream was opened before the cancel, so it has no message to replay —
    // it's parked on `job.listeners` waiting for a yield. The cancel is that
    // yield, and it's committed on another machine. If A adopts the status
    // without materialising the message, this stream hangs until the caller
    // gives up, while a caller polling any *other* machine gets the cancel from
    // the durable log.
    const jobStore = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const descriptor = configureDVM({
      name: "cross-machine-cancel-sse",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob: async (_ctx: SDKJobContext<unknown, unknown>) => {
        await blocked;
      },
    });
    const serverOpts = {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
      fxFetcher: stubFx,
    };
    const machineA = await createDVMServer(descriptor, serverOpts);
    const machineB = await createDVMServer(descriptor, {
      ...serverOpts,
      store: new MemoryKVStore(),
    });

    try {
      const submit = await machineA.app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      const { job_id: jobId, job_token: jobToken } = (await submit.json()) as {
        job_id: string;
        job_token: string;
      };

      const sse = await Promise.resolve(
        machineA.app.request(`/v1/job/${jobId}/messages`, {
          method: "GET",
          headers: { Accept: "text/event-stream", "X-Job-Token": jobToken },
        })
      );
      expect(sse.status).toBe(200);
      const streamed = drain(sse);

      const deleted = await deleteJob(machineB.app, jobId, jobToken, "caller changed their mind");
      expect(deleted.status).toBe(200);

      const body = await within(streamed, 2_000, "SSE stream never closed after the cancel");
      expect(body).toContain('"type":"cancel"');
      expect(body).toContain("caller changed their mind");
    } finally {
      release();
      machineA.shutdown();
      machineB.shutdown();
    }
  });

  it("reports the job as no longer active when it went terminal first", async () => {
    const jobStore = new MemoryJobStore();
    const descriptor = configureDVM({
      name: "cross-machine-cancel-race",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob: (ctx: SDKJobContext<unknown, unknown>) => {
        ctx.complete("done");
      },
    });
    const serverOpts = {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      devMode: true,
      fxFetcher: stubFx,
    };
    const machineA = await createDVMServer(descriptor, serverOpts);
    const machineB = await createDVMServer(descriptor, {
      ...serverOpts,
      store: new MemoryKVStore(),
    });

    try {
      const submit = await machineA.app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "hello" }),
      });
      const { job_id: jobId, job_token: jobToken } = (await submit.json()) as {
        job_id: string;
        job_token: string;
      };
      await settle();
      expect((await jobStore.get(jobId))?.status).toBe("completed");

      // The CAS refuses to cancel an already-terminal job — no phantom `cancel`
      // message gets appended to a completed job's log.
      const deleted = await deleteJob(machineB.app, jobId, jobToken);
      expect(deleted.status).toBe(409);
      const record = await jobStore.get(jobId);
      expect(record?.status).toBe("completed");
      expect(record?.messages.some((m) => m.type === "cancel")).toBe(false);
    } finally {
      machineA.shutdown();
      machineB.shutdown();
    }
  });
});

function deleteJob(
  app: TestApp,
  jobId: string,
  jobToken: string,
  reason?: string
): Promise<Response> {
  return Promise.resolve(
    app.request(`/v1/job/${jobId}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-Job-Token": jobToken },
      body: reason === undefined ? undefined : JSON.stringify({ reason }),
    })
  );
}

/** The JSON read path — served from `job.messages` while the job is locally active. */
async function fetchMessages(
  app: TestApp,
  jobId: string,
  jobToken: string
): Promise<{ type: string }[]> {
  const res = await app.request(`/v1/job/${jobId}/messages`, {
    method: "GET",
    headers: { "X-Job-Token": jobToken },
  });
  const { messages } = (await res.json()) as { messages: { type: string }[] };
  return messages;
}

/** Read an SSE body to completion. Resolves only once the server closes the stream. */
async function drain(res: Response): Promise<string> {
  if (!res.body) throw new Error("SSE response had no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

/** Fail loudly instead of hanging the suite when a stream never closes. */
function within<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
