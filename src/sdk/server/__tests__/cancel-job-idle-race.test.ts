/**
 * `cancelJobIdle` must not clobber a snapshot that another machine
 * has already driven to terminal via Tx C (cross-machine credit +
 * reactivation). The local idle timer can fire while a passive loser is
 * sitting on a stale `awaiting-input` view; persisting the cancel snapshot
 * from that stale view erases `paid_msats` and replaces the terminal status
 * with `cancelled`, so the caller sees a cancelled job they already paid for.
 */
import { describe, expect, it } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";

function seedRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "requester-1",
    status: "awaiting-input",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function buildManager(jobStore: MemoryJobStore) {
  const descriptor = configureDVM({
    name: "idle-race-test",
    capability: "test",
    tag: "test",
    idleTimeout: 120,
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    devMode: true,
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0,
  });
}

describe("JobManager.cancelJobIdle cross-machine race", () => {
  it("does not clobber a snapshot another machine has driven to terminal", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord());
    const jm = buildManager(store);

    try {
      const record = await store.get("job-1");
      if (!record) throw new Error("seed missing");
      const { job } = jm.reactivateJob(record);

      // Simulate machine B's Tx C credit + reactivation driving the job to
      // `completed` while machine A's idle timer is still ticking.
      await store.save({
        ...record,
        status: "completed",
        paidMsats: 25_000,
        paymentRail: "cashu",
        lastActivityAt: Date.now(),
      });

      // Machine A's idle timer fires.
      await jm.cancelJobIdle(job);

      // Persisted snapshot must reflect machine B's terminal state — neither
      // the status nor the credit may be overwritten by machine A's stale
      // view, and no phantom cancel message may be appended.
      const after = await store.get("job-1");
      expect(after?.status).toBe("completed");
      expect(after?.paidMsats).toBe(25_000);
      expect(after?.paymentRail).toBe("cashu");
      expect(after?.messages).toHaveLength(0);

      // Local view is synced to the persisted terminal status so observers
      // don't lag behind.
      expect(job.status).toBe("completed");
    } finally {
      jm.shutdown();
    }
  });

  it("rejects local pending prompts when the store has gone terminal elsewhere", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord());
    const jm = buildManager(store);

    try {
      const record = await store.get("job-1");
      if (!record) throw new Error("seed missing");
      const { job } = jm.reactivateJob(record);

      // Stage a pending prompt as the suspended handler would.
      const promptPromise = new Promise<unknown>((resolve, reject) => {
        job.pendingPrompts.set("q1", { resolve, reject });
      });

      // Cross-machine completion lands.
      await store.save({ ...record, status: "completed", paidMsats: 1_000 });
      await jm.cancelJobIdle(job);

      await expect(promptPromise).rejects.toThrow(/terminal status "completed"/);
      expect(job.pendingPrompts.size).toBe(0);
    } finally {
      jm.shutdown();
    }
  });

  it("still cancels normally when the store has not moved on", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord());
    const jm = buildManager(store);

    try {
      const record = await store.get("job-1");
      if (!record) throw new Error("seed missing");
      const { job } = jm.reactivateJob(record);

      await jm.cancelJobIdle(job);
      // `persistJob` inside `cancelJobIdle` is fire-and-forget; let the
      // microtask settle before observing the persisted snapshot.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });

      const after = await store.get("job-1");
      expect(after?.status).toBe("cancelled");
      const lastMsg = after?.messages.at(-1);
      expect(lastMsg?.type).toBe("cancel");
      expect((lastMsg?.content as { reason?: string }).reason).toBe("Job timed out (idle)");
      expect(job.status).toBe("cancelled");
    } finally {
      jm.shutdown();
    }
  });
});
