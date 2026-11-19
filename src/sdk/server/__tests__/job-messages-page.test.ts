import { describe, expect, it, vi } from "vitest";
import fixture from "../../../../protocol-fixtures/job-messages-page-v1.json";
import type { Message } from "../../../lib/messages/types";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { deferredX402Id } from "../funding";
import type { JobRecord, JobStore } from "../job-store";
import { MemoryJobStore } from "../memory-job-store";
import { contentJob, TOKEN } from "./__helpers__/content-fixtures";

function host(jobStore: JobStore) {
  return createDVMServer(configureDVM({
    name: "example", capability: "work", jobRetentionDays: 0, onJob() {},
  }), { env: {}, store: new MemoryKVStore(), jobStore, devMode: true });
}

const headers = { "X-Job-Token": TOKEN };
const history = fixture.history as Message[];

describe("JSON message pages", () => {
  it.each(["streamable", "snapshot"])("reconstructs a %s transcript using returned cursors", async mode => {
    const backing = new MemoryJobStore();
    const store: JobStore = mode === "streamable" ? backing : {
      get: backing.get.bind(backing),
      save: backing.save.bind(backing),
      delete: backing.delete.bind(backing),
      findJobByPaymentTxHash: backing.findJobByPaymentTxHash.bind(backing),
    };
    await store.save({ ...contentJob(), messages: history, seq: 9 });
    const runtime = await host(store);
    const messageReads = vi.spyOn(backing, "getMessages");
    try {
      let after: number | undefined;
      const received: Message[] = [];
      for (const example of fixture.pages) {
        const query = after === undefined ? "?limit=2" : `?limit=2&after=${after}`;
        expect(query).toBe(example.query);
        const response = await runtime.app.request(fixture.path + query, { headers });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject(example.body);
        received.push(...body.messages);
        after = body.next_after;
      }
      expect(received).toEqual(history);
      if (mode === "streamable") {
        expect(messageReads.mock.calls).toEqual([0, 3, 9].map(cursor => [
          "example-job", cursor, { includeHeld: true, limit: 3 },
        ]));
      }
      const legacy = await (await runtime.app.request(fixture.path, { headers })).json();
      expect(legacy).toEqual(mode === "streamable"
        ? { messages: history, content_available: true, content_expires_at: null }
        : { messages: history });
      const sse = await runtime.app.request(fixture.path + "?limit=1", {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      expect(sse.headers.get("Content-Type")).toContain("text/event-stream");
      const delivered = (await sse.text()).split("\n").filter(line => line.startsWith("data:"))
        .map(line => JSON.parse(line.slice(5)));
      expect(delivered).toEqual(history);
    } finally {
      await runtime.shutdown();
    }
  });

  it("rejects invalid paging for authorized callers before reading messages", async () => {
    const store = new MemoryJobStore();
    await store.save(contentJob());
    const runtime = await host(store);
    const messageReads = vi.spyOn(store, "getMessages");
    try {
      for (const query of ["limit=", "limit=0", "limit=51", "limit=1.5", "limit=1e1",
        "limit=1&after=-1", "limit=1&after=1.5", "limit=1&after=9007199254740992"]) {
        const response = await runtime.app.request(`${fixture.path}?${query}`, { headers });
        expect(response.status, query).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_query" });
      }
      expect((await runtime.app.request(fixture.path + "?limit=0")).status).toBe(401);
      expect((await runtime.app.request(fixture.path + "?limit=0", {
        headers: { "X-Job-Token": "incorrect" },
      })).status).toBe(404);
      expect(messageReads).not.toHaveBeenCalled();
      expect((await runtime.app.request(fixture.path + "?limit=50", { headers })).status).toBe(200);
    } finally {
      await runtime.shutdown();
    }
  });

  it("resumes from before a pending payment once the payment is accepted", async () => {
    const store = new MemoryJobStore();
    const job = { ...contentJob(), status: "processing" } satisfies JobRecord;
    await store.save(job);
    const first = await store.appendOutgoing(job.id, {
      from: "provider", type: "text", timestamp: 1, content: { text: "before" },
    });
    const payment = await store.recordInbound(job.id, {
      from: "requester", type: "payment", timestamp: 2, content: { x402_payment: "example" },
    });
    const last = await store.appendOutgoing(job.id, {
      from: "provider", type: "text", timestamp: 3, content: { text: "after" },
    });
    const runtime = await host(store);
    try {
      const read = async (after: number) => (await runtime.app.request(
        fixture.path + `?limit=1&after=${after}`, { headers },
      )).json();
      expect(await read(0)).toMatchObject({
        messages: [{ seq: first }], next_after: first, has_more: false,
      });
      expect(await read(first)).toMatchObject({ messages: [], next_after: first, has_more: false });
      await store.verifyAndCredit(job.id, payment, null);
      expect(await read(first)).toMatchObject({
        messages: [{ seq: payment, type: "payment" }], next_after: payment, has_more: true,
      });
      expect(await read(payment)).toMatchObject({
        messages: [{ seq: last }], next_after: last, has_more: false,
      });
    } finally {
      await runtime.shutdown();
    }
  });

  it("counts only releasable messages on an unpaid terminal job", async () => {
    const store = new MemoryJobStore();
    const runtime = await host(store);
    try {
      const cancel: Message = { seq: 12, from: "provider", type: "cancel", timestamp: 4, content: { reason: "Payment failed" } };
      await store.save({
        ...contentJob(), status: "failed", creditId: deferredX402Id("example"),
        messages: [...history.slice(0, 3), cancel], seq: cancel.seq,
      });
      const response = await runtime.app.request(fixture.path + "?limit=1", { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ messages: [cancel], next_after: cancel.seq, has_more: false });
    } finally {
      await runtime.shutdown();
    }
  });
});
