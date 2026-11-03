/*
 * A request that would end a job while one of its payments is being verified
 * waits briefly, polling with backoff, then answers 409 payment_in_progress
 * rather than holding the caller past a proxy's timeout.
 */
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { isTerminal } from "../job";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { PAYMENT_INTENT_LEASE_MS, PAYMENT_INTENT_REQUEST_WAIT_MS } from "../payment-arrival";

const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/payment-in-progress-v1.json", import.meta.url), "utf8")) as {
  status: number; headers: Record<string, string>; body: Record<string, unknown>;
};

afterEach(() => { vi.useRealTimers(); });

async function host(jobStore: MemoryJobStore) {
  const dvm = configureDVM({
    name: "intent-wait", capability: "test",
    async onJob(ctx) { await ctx.requestPayment(1_000, "next step"); ctx.complete("done"); },
  });
  const { app, jobManager } = await createDVMServer(dvm, { env: {}, store: new MemoryKVStore(), jobStore, devMode: true });
  const submitted = await app.request("/v1/job", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ capability: "test", input: "" }),
  });
  const { job_id, job_token } = await submitted.json() as { job_id: string; job_token: string };
  await vi.waitFor(async () => expect((await jobStore.get(job_id))?.status).toBe("awaiting-input"));
  const arrival = await jobStore.recordPaymentArrival(job_id, { from: "requester", type: "payment", timestamp: 0,
    content: { cashu_token: "token" } }, { arrivedAtMs: Date.now(), leaseMs: PAYMENT_INTENT_LEASE_MS });
  return { app, jobManager, jobId: job_id, headers: { "Content-Type": "application/json", "X-Job-Token": job_token }, arrival };
}

describe("ending a job while one of its payments is verified", () => {
  it.each(["the handler's machine", "another machine"] as const)("answers a cancel on %s 409 payment_in_progress after a bounded, backed-off wait", async (where) => {
    const jobStore = new MemoryJobStore();
    const { app, jobManager, jobId, headers, arrival } = await host(jobStore);
    try {
      if (where === "another machine") jobManager.activeJobs.delete(jobId);
      const looks = vi.spyOn(jobStore, where === "another machine" ? "cancelJob" : "openPaymentIntentUntil");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const pending = app.request(`/v1/job/${jobId}`, { method: "DELETE", headers });
      await vi.advanceTimersByTimeAsync(PAYMENT_INTENT_REQUEST_WAIT_MS);
      const res = await pending;
      vi.useRealTimers();

      expect(res.status).toBe(fixture.status);
      expect(res.headers.get("Retry-After")).toBe(fixture.headers["Retry-After"]);
      expect(await res.json()).toMatchObject(fixture.body);
      expect((await jobStore.get(jobId))?.status).toBe("awaiting-input");
      // Doubling waits look about seven times in the window, not every 100 ms.
      expect(looks.mock.calls.length).toBeLessThanOrEqual(8);

      await jobStore.markInboundFailed(jobId, arrival.seq, "payment_invalid");
      expect((await app.request(`/v1/job/${jobId}`, { method: "DELETE", headers })).status).toBe(200);
    } finally {
      jobManager.shutdown();
    }
  });

  it("answers a message for a job whose capability is gone 409 payment_in_progress instead of failing", async () => {
    const jobStore = new MemoryJobStore();
    const { app, jobManager, jobId, headers, arrival } = await host(jobStore);
    try {
      jobManager.activeJobs.delete(jobId);
      await jobStore.save({ ...(await jobStore.get(jobId))!, capability: "retired" });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const pending = app.request(`/v1/job/${jobId}/messages`, {
        method: "POST", headers, body: JSON.stringify({ type: "text", content: { text: "still there?" } }),
      });
      await vi.advanceTimersByTimeAsync(PAYMENT_INTENT_REQUEST_WAIT_MS);
      const res = await pending;
      vi.useRealTimers();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject(fixture.body);

      await jobStore.markInboundFailed(jobId, arrival.seq, "payment_invalid");
      const retried = await app.request(`/v1/job/${jobId}/messages`, {
        method: "POST", headers, body: JSON.stringify({ type: "text", content: { text: "still there?" } }),
      });
      expect(retried.status).toBe(410);
      expect((await jobStore.get(jobId))?.status).toBe("failed");
    } finally {
      jobManager.shutdown();
    }
  });
});

describe("a terminal write that falls back to failing the job", () => {
  class TerminalSaveOutage extends MemoryJobStore {
    outage = false;
    override save(record: JobRecord): Promise<void> {
      if (this.outage && isTerminal(record.status)) return Promise.reject(new Error("store unavailable"));
      return super.save(record);
    }
  }

  it("waits for an open payment intent instead of throwing it", async () => {
    vi.useFakeTimers();
    const store = new TerminalSaveOutage();
    const jm = new JobManager(configureDVM({ name: "fail-fallback", capability: "test", onJob: () => undefined }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true, fxFetcher: createFxFetcher(), heartbeatIntervalMs: 0,
      staleJobSweepIntervalMs: 86_400_000,
    });
    try {
      const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
      const ctx = jm.buildAndAttachContext(job, "");
      await jm.persistJob(job);
      const arrival = await store.recordPaymentArrival(job.id, { from: "requester", type: "payment", timestamp: 0,
        content: { cashu_token: "token" } }, { arrivedAtMs: Date.now(), leaseMs: PAYMENT_INTENT_LEASE_MS });
      store.outage = true;
      ctx.complete("done");
      let settled: unknown = "pending";
      const terminal = Promise.resolve(job.terminalWork).then(() => { settled = "resolved"; }, (error: unknown) => { settled = error; });
      // The completion's snapshot retries exhaust, so the job falls back to failing, which the intent holds.
      await vi.advanceTimersByTimeAsync(35_000);
      expect(settled).toBe("pending");
      expect((await store.get(job.id))?.status).not.toBe("failed");

      await store.verifyAndCredit(job.id, arrival.seq, null);
      await vi.advanceTimersByTimeAsync(5_000);
      await terminal;
      expect(settled).toBe("resolved");
      expect((await store.get(job.id))?.status).toBe("failed");
    } finally {
      jm.shutdown();
    }
  });
});
