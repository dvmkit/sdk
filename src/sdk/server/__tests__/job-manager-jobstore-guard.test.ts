/**
 * Direct JobManager construction must enforce durable storage without relying on the host's
 * separate boot guard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { JobManager, type JobManagerOpts } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";

function buildOpts(overrides: Partial<JobManagerOpts> = {}): JobManagerOpts {
  return {
    env: {},
    store: new MemoryKVStore(),
    fxFetcher: createFxFetcher(),
    staleJobTimeoutMs: 0,
    ...overrides,
  };
}

function buildDescriptor() {
  return configureDVM({
    name: "jobstore-guard-test",
    capability: "test",
    tag: "test",
    idleTimeout: 120,
    onJob(ctx) {
      ctx.complete("ok");
    },
  });
}

describe("JobManager jobStore guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws in production when neither jobStore nor devMode is provided", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new JobManager(buildDescriptor(), buildOpts())).toThrow(
      /JobManager requires a persistent jobStore/
    );
  });

  it("permits the MemoryJobStore fallback when devMode is true", () => {
    vi.stubEnv("NODE_ENV", "production");
    const manager = new JobManager(buildDescriptor(), buildOpts({ devMode: true }));
    expect(manager.store).toBeInstanceOf(MemoryJobStore);
    manager.shutdown();
  });

  it("permits the MemoryJobStore fallback under NODE_ENV=test (vitest default)", () => {
    expect(process.env.NODE_ENV).toBe("test");
    const manager = new JobManager(buildDescriptor(), buildOpts());
    expect(manager.store).toBeInstanceOf(MemoryJobStore);
    manager.shutdown();
  });

  it("uses an explicit jobStore regardless of NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", "production");
    const jobStore = new MemoryJobStore();
    const manager = new JobManager(buildDescriptor(), buildOpts({ jobStore }));
    expect(manager.store).toBe(jobStore);
    manager.shutdown();
  });
});
