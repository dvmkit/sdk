import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import type { JobRecord } from "../job-store";
import type { HostingCleanupFence } from "../hosting-cleanup-fence";
import { PostgresJobStore } from "../postgres-job-store";

const job: JobRecord = {
  id: "snapshot-retry", tags: [], capability: "test", input: "hello", params: {}, requesterId: "requester",
  requesterPubkey: "11".repeat(32), requestId: "request-retry", status: "processing",
  messages: [], seq: 0, paidMsats: 0, receivedProofs: [], stepCache: [], state: {},
  createdAt: 1, lastActivityAt: 1,
};
const duplicate = () => Object.assign(new Error("duplicate caller/request"), {
  code: "23505", constraint: "idx_jobs_request_id_caller",
});

describe("snapshot retry classification", () => {
  it.each(["save", "saveForDvm"] as const)("%s retries the secondary-index conflict after confirming the same job owns the pair", async method => {
    const query = vi.fn()
      .mockRejectedValueOnce(duplicate())
      .mockResolvedValueOnce({ rows: [{ id: job.id }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const store = new PostgresJobStore({ query } as unknown as Pool);
    await store[method]({ ...job }, "snapshot-dvm");
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("does not retry when a different job owns the caller/request pair", async () => {
    const error = duplicate();
    const query = vi.fn().mockRejectedValueOnce(error).mockResolvedValue({ rows: [{ id: "other-job" }] });
    const store = new PostgresJobStore({ query } as unknown as Pool);
    await expect(store.save(job)).rejects.toBe(error);
  });

  it("does not swallow unrelated uniqueness violations", async () => {
    const error = Object.assign(new Error("other constraint"), { code: "23505", constraint: "another_unique_index" });
    const query = vi.fn().mockRejectedValue(error);
    await expect(new PostgresJobStore({ query } as unknown as Pool).save(job)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("bounds repeated deadlocks instead of holding the caller indefinitely", async () => {
    const error = Object.assign(new Error("deadlock"), { code: "40P01" });
    const query = vi.fn().mockRejectedValue(error);
    await expect(new PostgresJobStore({ query } as unknown as Pool).save(job)).rejects.toBe(error);
    expect(query).toHaveBeenCalledTimes(8);
  });

  it("rolls back a hosted deadlock and restarts its whole transaction on a released client", async () => {
    const statements: string[] = [];
    let fault = true;
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.startsWith("SELECT dvm_id")) return { rows: [{ dvm_id: "snapshot-dvm" }], rowCount: 1 };
      if (sql.includes("INSERT INTO jobs") && fault) {
        fault = false;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query, release } as unknown as PoolClient);
    const store = new PostgresJobStore({ connect } as unknown as Pool);
    store.useHostingCleanupFence({ dvmId: "snapshot-dvm" } as HostingCleanupFence);
    await store.saveForDvm({ ...job }, "snapshot-dvm");
    expect(statements.filter(sql => ["BEGIN", "ROLLBACK", "COMMIT"].includes(sql)))
      .toEqual(["BEGIN", "ROLLBACK", "BEGIN", "COMMIT"]);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });
});
