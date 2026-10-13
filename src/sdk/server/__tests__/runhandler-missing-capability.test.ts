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
    name: "missing-cap-test",
    capability: "test",
    tag: "test",
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

describe("JobManager.runHandler missing capability", () => {
  it("force-terminates with pending prompts + payment instead of stalling", async () => {
    const store = new MemoryJobStore();
    await store.save(seedRecord());
    const jm = buildManager(store);

    try {
      const record = await store.get("job-1");
      if (!record) throw new Error("seed missing");
      const { job, sdkCtx } = jm.reactivateJob(record);

      // Simulate the capability having been deleted from the descriptor after
      // this job was persisted — the row reactivates with a name `getCapability`
      // can't resolve.
      job.capability = "deleted-cap";

      // Stage the pending prompt + payment a suspended handler would leave
      // behind on `awaiting-input`. Attach catches up front so the synchronous
      // rejection inside `runHandler` doesn't surface as unhandled.
      const promptPromise = new Promise<unknown>((resolve, reject) => {
        job.pendingPrompts.set("q1", { resolve, reject });
      });
      const paymentPromise = new Promise<unknown>((resolve, reject) => {
        job.pendingPayment = { resolve, reject };
      });
      const promptSettled = expect(promptPromise).rejects.toThrow(
        /Unknown capability "deleted-cap"/
      );
      const paymentSettled = expect(paymentPromise).rejects.toThrow(
        /Unknown capability "deleted-cap"/
      );

      jm.runHandler(job, sdkCtx);

      // Job is driven terminal, both pending resolvers reject, and a cancel
      // message carrying the reason is emitted for the caller.
      expect(job.status).toBe("failed");
      expect(job.pendingPrompts.size).toBe(0);
      expect(job.pendingPayment).toBeNull();

      const lastMsg = job.messages.at(-1);
      expect(lastMsg?.type).toBe("cancel");
      expect((lastMsg?.content as { reason?: string }).reason).toMatch(
        /Unknown capability "deleted-cap" on descriptor "missing-cap-test"/
      );

      await promptSettled;
      await paymentSettled;
    } finally {
      jm.shutdown();
    }
  });
});
