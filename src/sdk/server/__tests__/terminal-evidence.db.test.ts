import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import fixture from "../../../../protocol-fixtures/job-terminal-evidence.json";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext } from "../../types";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { ReceiptIssuer } from "../receipt-issuer";
import { RevenueReporter } from "../revenue-reporter";
import type { JobTerminalReportPayload } from "../revenue-reporter";
const url = process.env.DATABASE_URL;
const run = !!url && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(url);
const issuer = new ReceiptIssuer({ secret: "11".repeat(32), dvm: "example", dvmId: "example-dvm" });
function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "example-job",
    tags: [],
    capability: "work",
    input: "private input",
    params: {},
    requesterId: "private-caller",
    requesterPubkey: "22".repeat(32),
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    stepCache: [],
    state: {},
    createdAt: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}
describe.skipIf(!run)("durable terminal evidence", () => {
  let db: pg.Pool;
  let store: PostgresJobStore;
  let reporter: RevenueReporter;
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    store = new PostgresJobStore(db);
    await store.init();
    reporter = new RevenueReporter(db, "https://platform.example.com", "test-token");
    await reporter.init();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await db.query("DELETE FROM pending_dvm_reports");
    await db.query("DELETE FROM reported_job_terminals");
    await db.query("DELETE FROM job_messages");
    await db.query("DELETE FROM jobs");
  });
  afterAll(async () => {
    reporter.stop();
    await db.end();
  });
  function manager(
    sign = true,
    onJob: (ctx: SDKJobContext<unknown, { text: string }>) => void | Promise<void> = () => undefined
  ) {
    return new JobManager(
      configureDVM({
        name: "example",
        capability: "work",
        tag: "test",
        input: z.object({ text: z.string() }),
        onJob,
      }),
      {
        env: {},
        store: new MemoryKVStore(),
        jobStore: store,
        fxFetcher: {
          fetch: async () => ({ rates: { usd: 100000 }, as_of: "2026-01-01T00:00:00Z" }),
          supportedCurrencies: () => ["usd"],
        },
        devMode: true,
        dvmId: "example-dvm",
        receiptIssuer: sign ? issuer : undefined,
        onJobTerminal: reporter.reportTerminal.bind(reporter),
        staleJobTimeoutMs: 0,
        processingWatchdogMs: 0,
        heartbeatIntervalMs: 0,
      }
    );
  }

  it("keeps the remaining prompt durably resumable and signs its full caller wait", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const jm = manager(true, async (ctx) => {
      await Promise.all([ctx.prompt("a", "A?"), ctx.prompt("b", "B?")]);
      ctx.complete("answered");
    });
    try {
      const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
      await jm.persistJob(job);
      now = 1500;
      await jm.dispatchMessage(job, "response", { prompt_id: "a", text: "yes" });
      expect((await store.get(job.id))?.status).toBe("awaiting-input");
      now = 1900;
      await jm.dispatchMessage(job, "response", { prompt_id: "b", text: "yes" });
      await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
      await job.terminalWork;
      const durable = (await store.get(job.id))!;
      expect(durable.status).toBe("completed");
      expect(durable.receipt?.timing).toEqual({
        accepted_at_ms: 1000,
        terminal_at_ms: 1900,
        caller_wait_ms: 900,
      });
    } finally {
      await jm.shutdown();
    }
  });


  it.each(["prompt", "payment"] as const)(
    "preserves the full durable mixed-input wait when %s arrives first",
    async (first) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
      let now = 1000;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const callbacks = new Set<() => void>();
      vi.spyOn(store, "subscribeNotifications").mockImplementation(async (_id, cb) => {
        callbacks.add(cb);
        return () => callbacks.delete(cb);
      });
      let executions = 0;
      const jm = manager(true, async (ctx) => {
        await Promise.all([ctx.prompt("question", "Continue?"), ctx.requestPayment(1000, "fee")]);
        executions++;
        ctx.complete("answered and paid");
      });
      try {
        const job = jm.createJob({ input: "" }, "test", { paidMsats: 0, receivedProofs: [] }, undefined, "work");
        await jm.persistJob(job);
        jm.runHandler(job, jm.buildAndAttachContext(job, { text: "" }));
        await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
        await jm.persistJob(job);
        const prompt = () => jm.dispatchMessage(job, "response", { prompt_id: "question", text: "yes" });
        const payment = async () => {
          await db.query("UPDATE jobs SET paid_msats=1000, pending_payment_msats=NULL WHERE id=$1", [job.id]);
          for (const cb of callbacks) cb();
          await vi.waitFor(() => expect(job.pendingPayment).toBeNull());
        };
        now = 1500;
        if (first === "prompt") await prompt();
        else await payment();
        await vi.waitFor(async () => expect((await store.get(job.id))?.status).toBe("awaiting-input"));
        expect(job.abort.signal.aborted).toBe(false);
        now = 1900;
        if (first === "prompt") await payment();
        else await prompt();
        await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
        await job.terminalWork;
        const durable = (await store.get(job.id))!;
        expect(executions).toBe(1);
        expect(job.abort.signal.aborted).toBe(false);
        expect(durable.status).toBe("completed");
        expect(durable.paidMsats).toBe(1000);
        expect(durable.receipt?.timing).toEqual({
          accepted_at_ms: 1000,
          terminal_at_ms: 1900,
          caller_wait_ms: 900,
        });
      } finally {
        await jm.shutdown();
      }
    }
  );

  it("adopts two durable waits and the original terminal across machines", async () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await store.saveForDvm(record(), "example-dvm");
    await store.appendOutgoing(
      "example-job",
      {
        from: "provider",
        type: "prompt",
        timestamp: 1,
        content: { id: "question", text: "Continue?" },
      },
      { awaitingInput: true }
    );
    now = 1100;
    await store.recordInbound("example-job", {
      from: "requester",
      type: "response",
      timestamp: 1,
      content: { prompt_id: "question", text: "yes" },
    });
    now = 1200;
    await store.claimForProcessing("example-job");
    now = 1350;
    await store.save({ ...(await store.get("example-job"))!, status: "awaiting-input" });
    now = 1700;
    await store.cancelJob("example-job", "caller stopped");
    now = 2300;
    const jm = manager();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    try {
      const receipt = await jm.finalizeStoredTerminal("example-job");
      expect(receipt?.timing).toEqual({
        accepted_at_ms: 1000,
        terminal_at_ms: 1700,
        caller_wait_ms: 550,
      });
      expect(receipt?.ended_by).toBe("caller");
      await store.save({
        ...record({ status: "cancelled" }),
        endedBy: "provider",
        terminalAtMs: 2300,
      });
      const stored = (await store.get("example-job"))!;
      expect(stored.terminalAtMs).toBe(1700);
      expect(stored.callerWaitMs).toBe(550);
      expect(stored.endedBy).toBe("caller");
      expect(await jm.finalizeStoredTerminal("example-job")).toEqual(receipt);
      expect(
        (await db.query("SELECT * FROM pending_dvm_reports WHERE kind='job_terminal'")).rows
      ).toHaveLength(1);
    } finally {
      jm.shutdown();
    }
  });
  it.each(["processing", "awaiting-input"] as const)(
    "persists watchdog attribution from %s atomically",
    async (status) => {
      await store.saveForDvm(record({ status }), "example-dvm");
      expect(
        await store.cancelStaleJob(
          "example-job",
          Date.now(),
          "expired",
          status === "processing" ? "failed" : "cancelled"
        )
      ).toBe(true);
      const terminal = (await store.get("example-job"))!;
      expect(terminal.endedBy).toBe(status === "processing" ? "provider" : "caller");
      expect(terminal.terminalAtMs).toBeTypeOf("number");
      expect(terminal.awaitingInputAtMs).toBeUndefined();
    }
  );
  it("recovers free unsigned terminals once and delivers only the exact privacy contract", async () => {
    const sent: { url: string; body: Record<string, unknown>; authorization: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({
          url,
          body: JSON.parse(init.body as string),
          authorization: (init.headers as Record<string, string>).Authorization,
        });
        return new Response("", { status: 503 });
      })
    );
    await store.saveForDvm(
      record({
        status: "completed",
        paymentTxHash: "private-reference",
        summary: "private-output",
      }),
      "example-dvm"
    );
    const jm = manager(false);
    try {
      await Promise.all([jm.recoverTerminalCosts(), jm.recoverTerminalCosts()]);
      const rows = (
        await db.query("SELECT payload FROM pending_dvm_reports WHERE kind='job_terminal'")
      ).rows;
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0].payload).sort()).toEqual(
        Object.keys(fixture.terminal_report).sort()
      );
      expect(rows[0].payload).toMatchObject({
        paid: false,
        receiptSeq: null,
        endedBy: null,
        outcome: "completed",
      });
      expect(sent[0].url).toBe("https://platform.example.com/_internal/job-terminal");
      expect(sent[0].authorization).toBe("Bearer test-token");
      expect(JSON.stringify(rows[0].payload)).not.toContain("private");
      // Successful delivery deletes the queue row, but must retain the deduplication fact.
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
      await reporter.drainPending();
      await db.query("UPDATE jobs SET terminal_report_enqueued = false WHERE id='example-job'");
      await jm.recoverTerminalCosts();
      expect(
        (await db.query("SELECT * FROM pending_dvm_reports WHERE kind='job_terminal'")).rows
      ).toHaveLength(0);
      expect(
        (await db.query("SELECT terminal_report_enqueued FROM jobs WHERE id='example-job'")).rows[0]
          .terminal_report_enqueued
      ).toBe(true);
    } finally {
      jm.shutdown();
    }
  });
  it("reports payment presence from durable mid-job accounting rather than a stale handler snapshot", async () => {
    await store.saveForDvm(record(), "example-dvm");
    await store.appendOutgoing(
      "example-job",
      {
        from: "provider",
        type: "payment-request",
        timestamp: 1,
        content: { amount_msats: 1000, reason: "fee" },
      },
      { awaitingInput: true, pendingPaymentDelta: 1000 }
    );
    const seq = await store.recordInbound("example-job", {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { amount_msats: 1000 },
    });
    await store.verifyAndCredit("example-job", seq, { paidMsatsDelta: 1000, clearPending: true });
    await store.claimForProcessing("example-job");
    await store.save(record({ status: "completed", paidMsats: 0 }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    const jm = manager(false);
    try {
      await jm.finalizeStoredTerminal("example-job");
      const rows = (
        await db.query("SELECT payload FROM pending_dvm_reports WHERE kind='job_terminal'")
      ).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].payload.paid).toBe(true);
      expect(Object.keys(rows[0].payload).sort()).toEqual(
        Object.keys(fixture.terminal_report).sort()
      );
    } finally {
      jm.shutdown();
    }
  });

  it("omits unverifiable wait totals for a job accepted before the timing migration", async () => {
    await store.saveForDvm(record({ timingKnown: false, status: "awaiting-input" }), "example-dvm");
    await store.cancelJob("example-job", "caller stopped after upgrade");
    const jm = manager();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    try {
      const receipt = await jm.finalizeStoredTerminal("example-job");
      expect(receipt?.timing).toBeUndefined();
      expect(receipt?.ended_by).toBeUndefined();
      await jm.recoverTerminalCosts();
      expect(fetch).not.toHaveBeenCalled();
      expect((await store.get("example-job"))?.timingKnown).toBe(false);
      expect((await db.query("SELECT * FROM reported_job_terminals")).rows).toHaveLength(0);
    } finally {
      jm.shutdown();
    }
  });

  it("rolls back the deduplication marker when the durable outbox rejects an insert", async () => {
    await store.saveForDvm(record({ status: "failed" }), "example-dvm");
    await db.query(
      "CREATE FUNCTION reject_terminal_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rejection'; END $$"
    );
    await db.query(
      "CREATE TRIGGER reject_terminal_report BEFORE INSERT ON pending_dvm_reports FOR EACH ROW EXECUTE FUNCTION reject_terminal_report()"
    );
    try {
      await expect(
        reporter.reportTerminal(fixture.terminal_report as JobTerminalReportPayload)
      ).rejects.toThrow("test rejection");
      expect(
        (await db.query("SELECT terminal_report_enqueued FROM jobs WHERE id='example-job'")).rows[0]
          .terminal_report_enqueued
      ).toBe(false);
      expect((await db.query("SELECT * FROM reported_job_terminals")).rows).toHaveLength(0);
    } finally {
      await db.query("DROP TRIGGER reject_terminal_report ON pending_dvm_reports");
      await db.query("DROP FUNCTION reject_terminal_report()");
    }
  });
});
