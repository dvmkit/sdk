import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Message, MessageType } from "../../../lib/messages/types";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { providerMessage } from "../job";
import { JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-18T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe.skipIf(!RUN)("cross-machine message streaming", () => {
  let pool: pg.Pool;
  let store: PostgresJobStore;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresJobStore(pool);
    await store.init();
    await store.initStreaming();
  });

  afterEach(async () => {
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM jobs");
  });

  afterAll(async () => {
    await store.shutdownStreaming();
    await pool.end();
  });

  async function ensureJob(jobId: string): Promise<void> {
    const record: JobRecord = {
      id: jobId,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "test",
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: 0,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await store.save(record);
  }

  function outgoing(
    type: MessageType,
    content: object
  ): {
    from: "provider";
    type: MessageType;
    timestamp: number;
    content: object;
  } {
    return {
      from: "provider",
      type,
      timestamp: Math.floor(Date.now() / 1000),
      content,
    };
  }

  it("appendOutgoing writes to job_messages and getMessages reads them", async () => {
    await ensureJob("job-1");
    await store.appendOutgoing("job-1", outgoing("text", { text: "hello" }));
    await store.appendOutgoing("job-1", outgoing("text", { text: "world" }));

    const msgs = await store.getMessages("job-1", 0);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].seq).toBeLessThan(msgs[1].seq);
    expect((msgs[0].content as { text: string }).text).toBe("hello");
  });

  it("persists the exact x402 amount atomically with its payment request", async () => {
    await ensureJob("job-x402-binding");
    const nonce = `0x${"a".repeat(64)}`;

    await store.appendOutgoing(
      "job-x402-binding",
      outgoing("payment-request", {
        amount_msats: 2_000,
        reason: "metered work",
        x402: { nonce, required_usdc_micro: "2050" },
      }),
      {
        pendingPaymentDelta: 2_000,
        pendingX402Nonce: nonce,
        pendingX402AmountUsdcMicro: "2050",
      }
    );

    const bound = await store.get("job-x402-binding");
    expect(bound).toMatchObject({
      pendingPaymentMsats: 2_000,
      pendingX402Nonce: nonce,
      pendingX402AmountUsdcMicro: "2050",
    });

    await store.appendOutgoing(
      "job-x402-binding",
      outgoing("payment-request", { amount_msats: 1_000, reason: "cashu only" }),
      { pendingPaymentDelta: 1_000 }
    );
    const superseded = await store.get("job-x402-binding");
    expect(superseded?.pendingX402Nonce).toBeUndefined();
    expect(superseded?.pendingX402AmountUsdcMicro).toBeUndefined();
  });

  it("clears the persisted x402 binding when cross-machine credit succeeds", async () => {
    await ensureJob("job-x402-credit");
    const nonce = `0x${"b".repeat(64)}`;
    await store.appendOutgoing(
      "job-x402-credit",
      outgoing("payment-request", {
        amount_msats: 2_000,
        reason: "metered work",
        x402: { nonce, required_usdc_micro: "2050" },
      }),
      {
        pendingPaymentDelta: 2_000,
        pendingX402Nonce: nonce,
        pendingX402AmountUsdcMicro: "2050",
      }
    );
    const seq = await store.recordInbound("job-x402-credit", {
      from: "requester",
      type: "payment",
      timestamp: 1,
      content: { x402_payment: "base64_header" },
    });

    await store.verifyAndCredit("job-x402-credit", seq, {
      paidMsatsDelta: 2_000,
      paymentRail: "x402",
      clearPendingX402Binding: true,
    });

    const credited = await store.get("job-x402-credit");
    expect(credited?.pendingX402Nonce).toBeUndefined();
    expect(credited?.pendingX402AmountUsdcMicro).toBeUndefined();
  });

  it("getMessages filters by afterSeq", async () => {
    await ensureJob("job-2");
    await store.appendOutgoing("job-2", outgoing("text", { text: "a" }));
    const seq2 = await store.appendOutgoing("job-2", outgoing("text", { text: "b" }));
    await store.appendOutgoing("job-2", outgoing("text", { text: "c" }));

    const msgs = await store.getMessages("job-2", seq2 - 1);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.every((m) => m.seq >= seq2)).toBe(true);
  });

  it.each([true, false])("preserves cursors across pending payment verification, accepted=%s", async (accepted) => {
    const jobId = `pending-payment-${accepted}`;
    await ensureJob(jobId);
    const received: string[] = [];
    const unsubscribe = await store.subscribeMessages(jobId, 0, message => received.push(message.type));
    try {
      const seq = await store.recordInbound(jobId, {
        from: "requester", type: "payment", timestamp: 1, content: { x402_payment: "proof" },
      });
      await store.appendOutgoing(jobId, outgoing("text", { text: "During verification" }));
      expect(await store.getMessages(jobId, 0)).toEqual([]);
      if (accepted) await store.verifyAndCredit(jobId, seq, null);
      else await store.markInboundFailed(jobId, seq, "payment_invalid");
      const expected = accepted ? ["payment", "text"] : ["text"];
      expect((await store.getMessages(jobId, 0)).map(message => message.type)).toEqual(expected);
      await vi.waitFor(() => expect(received).toEqual(expected));
    } finally {
      unsubscribe();
    }
  });

  it("subscribeMessages delivers initial messages then NOTIFY-driven ones", async () => {
    await ensureJob("job-3");
    await store.appendOutgoing("job-3", outgoing("text", { text: "pre" }));

    const received: Message[] = [];
    const unsub = await store.subscribeMessages("job-3", 0, (msg) => {
      received.push(msg);
    });
    expect(received).toHaveLength(1);

    // Append via a SECOND pool connection (simulates another machine).
    const pool2 = new pg.Pool({ connectionString: DATABASE_URL });
    const store2 = new PostgresJobStore(pool2);
    try {
      await store2.appendOutgoing("job-3", outgoing("text", { text: "cross-machine" }));

      await new Promise((r) => setTimeout(r, 200));

      expect(received).toHaveLength(2);
      expect((received[1].content as { text: string }).text).toBe("cross-machine");
    } finally {
      unsub();
      await pool2.end();
    }
  });

  it("unsubscribe stops delivery", async () => {
    await ensureJob("job-4");
    const received: Message[] = [];
    const unsub = await store.subscribeMessages("job-4", 0, (msg) => {
      received.push(msg);
    });
    unsub();
    await store.appendOutgoing("job-4", outgoing("text", { text: "after-unsub" }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
  });

  it("save with terminal status cleans up job_messages", async () => {
    await ensureJob("job-5");
    await store.appendOutgoing("job-5", outgoing("text", { text: "hello" }));
    expect((await store.getMessages("job-5", 0)).length).toBe(1);

    await store.save({
      id: "job-5",
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "test",
      status: "completed",
      messages: [],
      seq: 1,
      paidMsats: 0,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });

    expect((await store.getMessages("job-5", 0)).length).toBe(0);
  });

  it("chained appendOutgoing preserves seq + subscriber order across rapid back-to-back providerMessage calls", async () => {
    // Reproduces the artifact-drop bug: when a DVM emits `artifact` and then
    // `complete` in immediate succession, two `appendOutgoing` transactions
    // fire fire-and-forget and race for the `jobs` row lock. The losing tx
    // commits second → its NOTIFY arrives second → an SSE subscriber that
    // already saw a yield message (`complete`) has closed its stream by
    // then, and the artifact is silently dropped.
    //
    // The fix in `JobManager.wireMessageAppender` chains each appender call
    // onto a per-job tail Promise. This test drives the real wiring:
    // `reactivateJob` calls `wireMessageAppender`, and `providerMessage`
    // is the same entry point production code uses from `ctx.artifact()` /
    // `ctx.complete()`. A regression in the wiring (lost tail, replaced
    // appender) would fail this test, not just a hand-rolled chain helper.
    const writer = store;
    const subscribePool = new pg.Pool({ connectionString: DATABASE_URL });
    const subscribeStore = new PostgresJobStore(subscribePool);
    await subscribeStore.initStreaming();

    const descriptor = configureDVM({
      name: "dvm-cross-machine-repro",
      capability: "test",
      onJob: () => {
        // Unused — the test drives `providerMessage` directly to bypass
        // the handler-runtime path and exercise only the appender wiring.
      },
    });
    const jobManager = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: writer,
      fxFetcher: stubFx,
    });

    try {
      const N = 10;
      for (let i = 0; i < N; i++) {
        const jobId = `job-dvm-cross-machine-${i}`;
        await ensureJob(jobId);

        const record = await writer.get(jobId);
        if (!record) throw new Error(`ensureJob failed for ${jobId}`);

        const received: Message[] = [];
        const unsub = await subscribeStore.subscribeMessages(jobId, 0, (msg) => {
          received.push(msg);
        });

        // Real wiring: `reactivateJob` installs the chained appender on the
        // job via `wireMessageAppender`. `providerMessage` then fires the
        // appender exactly as `ctx.artifact()` / `ctx.complete()` do.
        const { job } = jobManager.reactivateJob(record);
        providerMessage(job, "artifact", { format: "text/markdown", content: `hello-${i}` });
        providerMessage(job, "complete", { summary: "done" });
        await job.messageAppenderTail;

        // Allow NOTIFY delivery + dispatch to settle.
        await new Promise((r) => setTimeout(r, 100));

        // DB-side ordering: chained appender → call order matches DB seq.
        const dbRows = await writer.getMessages(jobId, 0);
        expect(dbRows.map((m) => [m.seq, m.type])).toEqual([
          [1, "artifact"],
          [2, "complete"],
        ]);

        // Subscriber-side ordering: both messages delivered, in seq order.
        expect(received.map((m) => [m.seq, m.type])).toEqual([
          [1, "artifact"],
          [2, "complete"],
        ]);

        unsub();
      }
    } finally {
      jobManager.shutdown();
      await subscribeStore.shutdownStreaming();
      await subscribePool.end();
    }
  });

  it("multiple subscribers for the same job all receive messages", async () => {
    await ensureJob("job-6");
    const received1: Message[] = [];
    const received2: Message[] = [];

    const unsub1 = await store.subscribeMessages("job-6", 0, (m) => received1.push(m));
    const unsub2 = await store.subscribeMessages("job-6", 0, (m) => received2.push(m));

    await store.appendOutgoing("job-6", outgoing("text", { text: "broadcast" }));
    await new Promise((r) => setTimeout(r, 200));

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);

    unsub1();
    unsub2();
  });

  it("subscribeMessages stays usable after the listen client is forcibly disconnected", async () => {
    await ensureJob("job-7");

    const received: Message[] = [];
    const unsub = await store.subscribeMessages("job-7", 0, (msg) => {
      received.push(msg);
    });

    // A separate pool simulates the cross-machine writer.
    const writerPool = new pg.Pool({ connectionString: DATABASE_URL });
    const writerStore = new PostgresJobStore(writerPool);

    try {
      await writerStore.appendOutgoing("job-7", outgoing("text", { text: "pre-drop" }));
      await waitFor(() => received.length >= 1);
      expect(received).toHaveLength(1);

      // Forcibly drop the store's LISTEN connection from the DB side. The
      // ListenChannel reconnect loop should pick it up and resume dispatch.
      //
      // `pg_stat_activity` is cluster-wide, so without the `datname` filter this
      // also kills the LISTEN backends of a concurrent worktree's test run and of
      // the local dev stack — the same collateral damage per-worktree
      // DBs exist to prevent.
      await writerPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE '%LISTEN job_messages%' AND state = 'idle'`
      );

      // Allow the channel to reconnect (1s initial backoff + buffer).
      await new Promise((r) => setTimeout(r, 1500));

      await writerStore.appendOutgoing("job-7", outgoing("text", { text: "post-drop" }));
      await waitFor(() => received.length >= 2, 5000);
      expect(received).toHaveLength(2);
      expect((received[1].content as { text: string }).text).toBe("post-drop");
    } finally {
      unsub();
      await writerPool.end();
    }
  });
});

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 50
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timed out");
}
