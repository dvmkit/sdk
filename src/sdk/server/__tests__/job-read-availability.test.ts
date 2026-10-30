import { afterEach, describe, expect, it, vi } from "vitest";
import unavailable from "../../../../protocol-fixtures/job-read-unavailable-v1.json";
import { verifyReceipt, type JobReceipt } from "../../../lib/receipt";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryJobStore } from "../memory-job-store";

const hosts: Awaited<ReturnType<typeof createDVMServer>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});

async function fixture() {
  const store = new MemoryJobStore();
  let executions = 0;
  const host = async () => {
    const server = await createDVMServer(configureDVM({
      name: "read-recovery", capability: "work",
      onJob(ctx) { executions++; ctx.text("original output"); ctx.complete("done"); },
    }), {
      env: {}, store: new MemoryKVStore(), jobStore: store, devMode: true,
      receiptKey: "11".repeat(32), dvmId: "example-dvm",
    });
    hosts.push(server);
    return server;
  };
  const owner = await host();
  const other = await host();
  const response = await owner.app.request("/v1/job", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ capability: "work", input: "hello" }),
  });
  expect(response.status).toBe(200);
  const job = await response.json() as { job_id: string; job_token: string };
  return {
    store, owner, other, job, executions: () => executions,
    read(server = other, suffix = "", token: string | undefined = job.job_token, accept = "application/json") {
      return server.app.request(`/v1/job/${job.job_id}${suffix}`, {
        headers: { Accept: accept, ...(token ? { "X-Job-Token": token } : {}) },
      });
    },
  };
}

describe("job reads during storage outages", () => {
  it.each(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "57P03", "53300", undefined])(
    "returns a safe retryable response for %s and recovers the same job and cursor", async code => {
      const f = await fixture();
      const baseline = await (await f.read()).json() as { receipt: JobReceipt };
      const history = await (await f.read(f.other, "/messages")).json() as { messages: { seq: number }[] };
      const cursor = history.messages[0].seq;
      const fault = vi.spyOn(f.store, "get").mockRejectedValue(Object.assign(
        new Error(code ? "postgresql://synthetic-secret@example.com/private SQL" : "timeout exceeded when trying to connect"),
        code ? { code } : {},
      ));
      for (const [server, suffix, accept] of [
        [f.owner, "", "application/json"], [f.other, "", "application/json"],
        [f.other, `/messages?after=${cursor}`, "application/json"],
        [f.other, `/messages?after=${cursor}`, "text/event-stream"],
      ] as const) {
        const failed = await f.read(server, suffix, f.job.job_token, accept);
        expect(failed.status).toBe(unavailable.status);
        expect(failed.headers.get("Retry-After")).toBe(unavailable.headers["Retry-After"]);
        expect(failed.headers.get("Content-Type")).toContain("application/json");
        expect(await failed.json()).toEqual(unavailable.body);
      }
      // Missing credentials must be refused before even consulting unavailable storage.
      fault.mockClear();
      expect((await f.read(f.other, "", "")).status).toBe(401);
      expect((await f.read(f.other, "/messages", "", "text/event-stream")).status).toBe(401);
      expect(fault).not.toHaveBeenCalled();
      fault.mockRestore();

      for (const server of [f.owner, f.other]) {
        const recovered = await (await f.read(server)).json() as { job_id: string; status: string; receipt: JobReceipt };
        expect(recovered).toMatchObject({ job_id: f.job.job_id, status: "completed", receipt: baseline.receipt });
        expect(verifyReceipt(recovered.receipt)).toBe(true);
        const resumed = await (await f.read(server, `/messages?after=${cursor}`)).json();
        expect(resumed.messages).toEqual(history.messages.filter(m => m.seq > cursor));
      }
      const stream = await f.read(f.other, `/messages?after=${cursor}`, f.job.job_token, "text/event-stream");
      const streamed = (await stream.text()).split("\n").filter(line => line.startsWith("data:")).map(line => JSON.parse(line.slice(5)));
      expect(streamed).toEqual(history.messages.filter(m => m.seq > cursor));
      expect(f.executions()).toBe(1);
      expect((await f.read(f.other, "", "wrong-token")).status).toBe(404);
      expect((await f.read(f.other, "/messages", "wrong-token")).status).toBe(404);
      expect((await f.other.app.request("/v1/job/unknown", { headers: { "X-Job-Token": f.job.job_token } })).status).toBe(404);
    },
  );

  it("handles an authenticated message-query failure before SSE opens", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "getMessages").mockRejectedValue(Object.assign(new Error("synthetic-secret"), { code: "ETIMEDOUT" }));
    const response = await f.read(f.other, "/messages", f.job.job_token, "text/event-stream");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable.body);
    expect((await f.read(f.owner, "/messages", "wrong-token")).status).toBe(404);
  });

  it.each(["23505", "42601", "57014", "XX000", undefined])("does not label internal failure %s as retryable", async code => {
    const f = await fixture();
    vi.spyOn(f.store, "get").mockRejectedValue(Object.assign(new Error("synthetic-secret"), code ? { code } : {}));
    for (const suffix of ["", "/messages"]) {
      const response = await f.read(f.other, suffix);
      expect(response.status).toBe(500);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.text()).toBe("Internal Server Error");
    }
  });
});
