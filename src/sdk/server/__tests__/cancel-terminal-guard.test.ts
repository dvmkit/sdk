/**
 * Two defects composed into a cancelled job resurrecting itself as `completed`:
 * the cancel dispatch never signalled the running handler (so it kept burning
 * provider spend), and `ctx.complete` / `ctx.fail` wrote `job.status`
 * unconditionally (so the handler's eventual terminal call overwrote the
 * cancel, booked revenue, and reported success to the caller who cancelled).
 */
import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

type Handler = (ctx: SDKJobContext<unknown, unknown>) => Promise<void> | void;

function buildManager(
  jobStore: MemoryJobStore,
  onJob: Handler,
  onJobCompleted?: (event: { jobId: string }) => Promise<void>
) {
  const descriptor = configureDVM({
    name: "cancel-guard-test",
    capability: "test",
    tag: "test",
    idleTimeout: 120,
    onJob,
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    devMode: true,
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0,
    dvmId: "dvm-1",
    onJobCompleted,
  });
}

/** Start a job whose handler blocks until `release()` resolves it. */
function startJob(jm: ReturnType<typeof buildManager>, paid = false) {
  const job = jm.createJob(
    { input: "hello" },
    "requester-1",
    paid
      ? { paidMsats: 5_000, receivedProofs: [], paymentRail: "cashu" as const }
      : { paidMsats: 0, receivedProofs: [] },
    paid ? 5_000 : undefined,
    "test"
  );
  const ctx = jm.buildAndAttachContext(job, "hello");
  jm.runHandler(job, ctx as SDKJobContext<unknown, unknown>);
  return { job, ctx };
}

/** Let fire-and-forget persists settle. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("cancel is terminal", () => {
  it("aborts ctx.signal inside the running handler", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let abortedInHandler: boolean | undefined;

    const jm = buildManager(store, async (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        release();
      });
      await blocked;
      abortedInHandler = ctx.signal.aborted;
      ctx.complete("resurrect");
    });

    try {
      const { job } = startJob(jm);
      await jm.dispatchMessage(job, "cancel", { reason: "probe" });
      await settle();

      expect(abortedInHandler).toBe(true);
      expect(job.abort.signal.aborted).toBe(true);
    } finally {
      release();
      jm.shutdown();
    }
  });

  it("ignores ctx.complete() from a handler that outlived the cancel", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const jm = buildManager(store, async (ctx) => {
      await blocked;
      ctx.text("still going");
      ctx.complete("resurrect");
    });

    try {
      const { job } = startJob(jm);
      await jm.dispatchMessage(job, "cancel", { reason: "probe" });

      release();
      await settle();
      await settle();

      expect(job.status).toBe("cancelled");
      expect(job.summary).toBeUndefined();
      expect(job.messages.some((m) => m.type === "complete")).toBe(false);
      expect(job.messages.some((m) => m.type === "text" && m.content.text === "still going")).toBe(
        false
      );

      // The store must agree — the DELETE route dispatches the cancel without
      // persisting, so an unpersisted cancel would read back as `processing`
      // and get swept to `failed`.
      const record = await store.get(job.id);
      expect(record?.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });

  it("ignores ctx.fail() and ctx.working() from a handler that outlived the cancel", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));

    const jm = buildManager(store, async (ctx) => {
      await blocked;
      ctx.working(5, "still going");
      ctx.fail("boom");
    });

    try {
      const { job } = startJob(jm);
      await jm.dispatchMessage(job, "cancel", { reason: "probe" });

      release();
      await settle();
      await settle();

      expect(job.status).toBe("cancelled");
      expect(job.messages.some((m) => m.type === "working")).toBe(false);
      const record = await store.get(job.id);
      expect(record?.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });

  it("rejects a ctx.prompt() issued after the cancel instead of hanging", async () => {
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    let promptError: unknown;

    const jm = buildManager(store, async (ctx) => {
      await blocked;
      try {
        await ctx.prompt("q1", "still there?");
      } catch (err) {
        promptError = err;
      }
    });

    try {
      const { job } = startJob(jm);
      await jm.dispatchMessage(job, "cancel", { reason: "probe" });

      release();
      await settle();
      await settle();

      expect(promptError).toBeInstanceOf(Error);
      expect(job.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });

  it("aborts an in-flight ctx.fetch on cancel", async () => {
    const store = new MemoryJobStore();
    const seen: (AbortSignal | undefined)[] = [];
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.signal ?? undefined);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        });
      });

    const jm = buildManager(store, async (ctx) => {
      await ctx.fetch("https://provider.example/tts").catch(() => undefined);
      ctx.complete("resurrect");
    });

    try {
      const { job } = startJob(jm);
      await settle();
      await jm.dispatchMessage(job, "cancel", { reason: "probe" });
      await settle();
      await settle();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.aborted).toBe(true);
      expect(job.status).toBe("cancelled");
    } finally {
      fetchSpy.mockRestore();
      jm.shutdown();
    }
  });

  it("adopts a cancel that landed on another machine, and books no revenue", async () => {
    // The persist-driven backstop, not the prompt NOTIFY path (that's
    // `cross-machine-cancel.test.ts`): a bare terminal write to the store, with
    // no notification — a cancel that commits in the window between this
    // handler's durable read and its write. This process's `job.status` stays
    // `processing`, and the in-memory guard alone would let `ctx.complete()`
    // through; `persistJob`'s durable re-check is what stops it.
    const store = new MemoryJobStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const revenue = vi.fn(() => Promise.resolve());

    const jm = buildManager(
      store,
      async (ctx) => {
        await blocked;
        ctx.complete("resurrect");
      },
      revenue
    );

    try {
      const { job, ctx } = startJob(jm, true);
      await jm.persistJob(job);

      const record = await store.get(job.id);
      if (!record) throw new Error("job was not persisted");
      record.status = "cancelled";
      record.lastActivityAt = Date.now();
      await store.save(record);

      release();
      await settle();
      await settle();

      expect((await store.get(job.id))?.status).toBe("cancelled");
      expect((await store.get(job.id))?.summary).toBeUndefined();
      expect(job.status).toBe("cancelled");
      expect(revenue).not.toHaveBeenCalled();
      expect(ctx.signal.aborted).toBe(true);
    } finally {
      release();
      jm.shutdown();
    }
  });

  it("clears pending prompt resolvers so a late response can't reopen the job", async () => {
    const store = new MemoryJobStore();
    const jm = buildManager(store, async (ctx) => {
      await ctx.prompt("q1", "which style?").catch(() => undefined);
    });

    try {
      const { job } = startJob(jm);
      await settle();
      expect(job.status).toBe("awaiting-input");

      await jm.dispatchMessage(job, "cancel", { reason: "probe" });
      expect(job.pendingPrompts.size).toBe(0);

      await jm.dispatchMessage(job, "response", { prompt_id: "q1", text: "loud" });
      expect(job.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });
});
