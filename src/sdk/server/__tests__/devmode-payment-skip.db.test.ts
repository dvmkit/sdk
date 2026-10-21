import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { JobManager } from "../job-manager";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const ASK_MSATS = 50_000;

describe.skipIf(!RUN)("development payment skips preserve durable input claims", () => {
  const schema = `dev_payment_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool;
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}` });
    store = new PostgresJobStore(pool);
    await store.init();
  });

  afterAll(async () => {
    await store?.shutdownStreaming();
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it.each([
    { explicit: false, prompt: true, foreignClaim: false },
    { explicit: true, prompt: true, foreignClaim: false },
    { explicit: false, prompt: false, foreignClaim: false },
    { explicit: true, prompt: false, foreignClaim: false },
    { explicit: true, prompt: true, foreignClaim: true },
  ])("handles explicit=$explicit, prompt=$prompt, foreignClaim=$foreignClaim", async ({ explicit, prompt, foreignClaim }) => {
    let paymentResumes = 0;
    const answers: string[] = [];
    let finish!: () => void;
    const finishWork = new Promise<void>(resolve => { finish = resolve; });
    const descriptor = configureDVM({
      name: "dev-payment-claims",
      capability: "test",
      async onJob(ctx) {
        await ctx.requestPayment(ASK_MSATS, "fee");
        paymentResumes++;
        if (prompt) answers.push((await ctx.prompt("question", "Continue?")).text);
        await finishWork;
        ctx.complete("done");
      },
    });
    const jm = new JobManager(descriptor, {
      env: {}, store: new MemoryKVStore(), jobStore: store, db: pool,
      devMode: true,
      ...(explicit ? { mints: ["https://mint.example.com"] } : {}),
      fxFetcher: {
        fetch: async () => ({ rates: { usd: 100_000 }, as_of: "2026-01-01T00:00:00Z" }),
        supportedCurrencies: () => ["usd"],
      },
      staleJobTimeoutMs: 0, processingWatchdogMs: 0, heartbeatIntervalMs: 0,
    });
    const job = jm.createJob({ input: "" }, "requester", { paidMsats: 0, receivedProofs: [] }, undefined, "test");
    const payment = { type: "payment" as const, content: explicit ? { dev_auto: true } : {} };
    async function pay() {
      const seq = await jm.recordInboundPending(job, payment.type, payment.content);
      expect(await jm.processPayment(job, payment, seq)).toEqual({});
      await jm.dispatchMessage(job, payment.type, payment.content);
      await jm.persistJob(job);
      return seq;
    }

    try {
      await jm.persistJob(job);
      jm.runHandler(job, jm.buildAndAttachContext(job, undefined));
      await vi.waitFor(() => expect(job.pendingPayment).not.toBeNull());
      await jm.persistJob(job);
      const firstSeq = await pay();
      await vi.waitFor(() => expect(paymentResumes).toBe(1));
      expect(job.reactivationPaymentApplied).toBe(true);
      expect(await store.get(job.id)).toMatchObject({ paidMsats: ASK_MSATS, pendingPaymentMsats: undefined });
      // Re-verifying the same inbound cannot credit or resume the paid wait twice.
      expect(await jm.processPayment(job, payment, firstSeq)).toEqual({});
      await jm.dispatchMessage(job, payment.type, payment.content);
      expect(paymentResumes).toBe(1);

      if (prompt) {
        await vi.waitFor(() => expect(job.pendingPrompts.has("question")).toBe(true));
        await jm.persistJob(job);
        await pay();
        const waitingStatus = (await store.get(job.id))?.status;
        if (foreignClaim) expect(await store.claimForProcessing(job.id)).toBe(true);
        const response = { prompt_id: "question", text: "yes" };
        const seq = await jm.recordInboundPending(job, "response", response);
        await jm.markInboundVerified(job.id, seq);
        await jm.dispatchMessage(job, "response", response);
        if (foreignClaim) {
          expect(answers).toEqual([]);
          expect(job.pendingPrompts.has("question")).toBe(true);
          expect((await store.get(job.id))?.status).toBe("processing");
          return;
        }
        await vi.waitFor(() => expect({ waitingStatus, answers }).toEqual({ waitingStatus: "awaiting-input", answers: ["yes"] }));
        await jm.dispatchMessage(job, "response", response);
        expect(answers).toEqual(["yes"]);
      }

      expect(await store.claimForProcessing(job.id)).toBe(false);
      finish();
      await vi.waitFor(() => expect(job.terminalWork).toBeDefined());
      await job.terminalWork;
      expect(await store.get(job.id)).toMatchObject({ status: "completed", summary: "done", paidMsats: ASK_MSATS });
      expect(paymentResumes).toBe(1);
    } finally {
      finish();
      if (job.pendingPrompts.size || job.pendingPayment) {
        await jm.dispatchMessage(job, "cancel", { reason: "test cleanup" });
        await job.terminalWork;
      }
      jm.shutdown();
    }
  });
});
