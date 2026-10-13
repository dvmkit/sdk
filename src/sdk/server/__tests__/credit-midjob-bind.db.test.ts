/* Faults occur before or after real Postgres COMMIT, distinguishing rollback from lost acknowledgement.
 * Rail funding commits before job binding; every failure must leave the deposit durably discoverable. */
import { schnorr } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import type { ServerJob } from "../job";
import { CREDIT_INBOUND_ATTEMPTS, CREDIT_INBOUND_READ_ATTEMPTS, JobManager } from "../job-manager";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);

const RATE = 100_000;
const DVM_ID = "dvm-credit-binding-bind";
const PRIVKEY = new Uint8Array(32).fill(7);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const REFUND_PUBKEY = "02" + "cd".repeat(32);

const ASK_MICRO = 50_000;
const ASK_MSATS = 50_000;
const ASK_USDC = 50_000;

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function warmFetcher(): FxFetcher {
  return {
    fetch: () =>
      Promise.resolve({
        rates: { usd: RATE } as FxRateSnapshot["rates"],
        as_of: new Date(0).toISOString(),
      }),
    supportedCurrencies: () => ["usd"],
    lastKnown: () => null,
  };
}

/**
 * Where an injected `COMMIT` failure lands relative to Postgres seeing it.
 * `"before"` is the ordinary rollback; `"after"` is the ambiguous commit — the
 * transaction is durable and the caller is told it failed.
 */
type CommitFault = "before" | "after";

interface FaultInjector {

  arm(fault: CommitFault, times: number): void;

  remaining(): number;

  armReads(times: number): void;

  readsRemaining(): number;
}

/** The one statement `getVerifiedInbound` issues — nothing else joins this way. */
const READBACK_SQL = "JOIN job_messages m";

/* Patch only promise-form connect(), restoring each client on release. Pool.query uses callback connect().
 * Fault read-back by its SQL, independently of COMMIT, so unrelated queries cannot absorb the fault. */
function flakyPool(pool: pg.Pool): { pool: pg.Pool; faults: FaultInjector } {
  let fault: CommitFault = "before";
  let remaining = 0;
  let readsRemaining = 0;

  async function patch(client: pg.PoolClient): Promise<pg.PoolClient> {
    const originalQuery = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const originalRelease = client.release.bind(client) as (err?: Error | boolean) => void;
    const patched = client as unknown as Record<string, unknown>;
    patched.query = async (...args: unknown[]): Promise<unknown> => {
      if (args[0] === "COMMIT" && remaining > 0) {
        remaining--;
        if (fault === "before") throw new Error("injected: lost the connection before COMMIT");
        await originalQuery(...args);
        throw new Error("injected: lost the connection after COMMIT");
      }
      return originalQuery(...args);
    };
    patched.release = (err?: Error | boolean): void => {
      patched.query = originalQuery;
      patched.release = originalRelease;
      originalRelease(err);
    };
    return client;
  }

  const connect = (cb?: unknown): unknown => {
    const raw = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    if (typeof cb === "function") return raw(cb);
    return (raw() as Promise<pg.PoolClient>).then(patch);
  };

  const query = (...args: unknown[]): unknown => {
    const raw = pool.query.bind(pool) as (...a: unknown[]) => unknown;
    if (readsRemaining > 0 && typeof args[0] === "string" && args[0].includes(READBACK_SQL)) {
      readsRemaining--;
      return Promise.reject(new Error("injected: lost the connection on the read-back"));
    }
    return raw(...args);
  };

  const proxy = new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect") return connect;
      if (prop === "query") return query;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
  return {
    pool: proxy,
    faults: {
      arm: (nextFault, times) => {
        fault = nextFault;
        remaining = times;
      },
      remaining: () => remaining,
      armReads: (times) => {
        readsRemaining = times;
      },
      readsRemaining: () => readsRemaining,
    },
  };
}

describe.skipIf(!RUN)("the mid-job Tx C seam", () => {
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let processedPayments: PostgresProcessedPaymentStore;
  let jobStore: PostgresJobStore;
  let faults: FaultInjector;
  const servers = servedApps();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    ledger = new CreditLedger(pool);
    await ledger.init();
    processedPayments = new PostgresProcessedPaymentStore(pool);
    await processedPayments.init();
    const flaky = flakyPool(pool);
    faults = flaky.faults;
    jobStore = new PostgresJobStore(flaky.pool);
    await jobStore.init();
  });

  beforeEach(() => {
    vi.mocked(verifyX402Payment).mockReset();
    faults.arm("before", 0);
    faults.armReads(0);
  });

  afterEach(async () => {
    await servers.closeAll();
    await pool.query("DELETE FROM job_messages");
    await pool.query("DELETE FROM jobs WHERE id LIKE 'bind-%'");
    await pool.query("DELETE FROM processed_payments WHERE dvm_id = $1", [DVM_ID]);
    await pool.query("DELETE FROM credit_drains WHERE credit_id LIKE 'imp:x402:bindtx-%'");
    await pool.query("DELETE FROM credit_draws WHERE credit_id LIKE 'imp:x402:bindtx-%'");
    await pool.query("DELETE FROM credits WHERE credit_id LIKE 'imp:x402:bindtx-%'");
  });

  afterAll(async () => {
    await pool.end();
  });

  function facilitatorSettles(txHash: string): void {
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true,
      amountMsats: ASK_MSATS,
      amountUsdcMicro: ASK_USDC,
      txHash,
    } as Awaited<ReturnType<typeof verifyX402Payment>>);
  }

  function manager(
    opts: {
      onCreditFunded?: (info: unknown) => void;
      onJobCompleted?: (info: unknown) => void;

      ledgerless?: boolean;
    } = {}
  ): JobManager<unknown, undefined> {
    const descriptor = configureDVM({
      name: "midjob-bind-test",
      capability: "test",
      tag: "test",
      idleTimeout: 120,
      onJob: () => undefined,
    });
    return new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore,
      fxFetcher: warmFetcher(),
      dvmId: DVM_ID,
      x402: X402,
      creditLedger: opts.ledgerless ? undefined : ledger,
      processedPayments,
      onCreditFunded: opts.onCreditFunded,
      onJobCompleted: opts.onJobCompleted,
      // Aged-out gates so the reconciler can be driven inline; every timer off.
      orphanDrawAgeMs: 1,
      terminalDrawReconcileAgeMs: 1,
      orphanDrawSweepIntervalMs: 0,
      staleJobTimeoutMs: 0,
      processingWatchdogMs: 0,
      heartbeatIntervalMs: 0,
    });
  }

  async function seedJob(jobId: string): Promise<ServerJob> {
    const record: JobRecord = {
      id: jobId,
      tags: [],
      capability: "test",
      input: "",
      params: {},
      requesterId: "requester-1",
      requesterPubkey: CALLER,
      status: "awaiting-input",
      messages: [],
      seq: 0,
      paidMsats: 0,
      pendingPaymentMsats: ASK_MSATS,
      pendingPaymentFiatMicro: ASK_MICRO,
      pendingPaymentFiatCurrency: "usd",
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await jobStore.save(record);
    return {
      id: jobId,
      requesterId: "requester-1",
      requesterPubkey: CALLER,
      status: "awaiting-input",
      messages: [],
      seq: 0,
      paidMsats: 0,
      pendingPaymentMsats: ASK_MSATS,
      pendingPaymentFiatMicro: ASK_MICRO,
      pendingPaymentFiatCurrency: "usd",
    } as unknown as ServerJob;
  }

  // Arm after inbound recording so only job binding, not admission, encounters the COMMIT fault.
  async function payMidJob(
    jm: JobManager<unknown, undefined>,
    job: ServerJob,
    arm?: { fault: CommitFault; times: number; reads?: number }
  ) {
    const body = { type: "payment" as const, content: { x402_payment: "base64_header" } };
    const seq = await jm.recordInboundPending(job, body.type, body.content);
    if (arm) {
      faults.arm(arm.fault, arm.times);
      faults.armReads(arm.reads ?? 0);
    }
    return jm.processPayment(job, body, seq);
  }

  async function jobRow(jobId: string): Promise<JobRecord | undefined> {
    return jobStore.get(jobId);
  }

  it("retries a rolled-back Tx C and credits the job exactly once", async () => {
    const jobId = "bind-retry-1";
    facilitatorSettles("bindtx-retry");
    const jm = manager();
    const job = await seedJob(jobId);
    try {
      const outcome = await payMidJob(jm, job, { fault: "before", times: 1 });

      expect(outcome.error).toBeUndefined();
      expect(outcome.unappliedCredit).toBeUndefined();
      expect(faults.remaining()).toBe(0);
    } finally {
      jm.shutdown();
    }

    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(ASK_MSATS);

    expect(row?.pendingPaymentMsats).toBe(0);
    expect(row?.creditId).toBe("imp:x402:bindtx-retry");
    expect(row?.drawId).toBe("bindtx-retry");

    const draw = await ledger.getDraw({
      creditId: "imp:x402:bindtx-retry",
      drawId: "bindtx-retry",
    });
    expect(draw).toMatchObject({ status: "pending", amountMicro: ASK_MICRO, jobId });
    expect(job.creditId).toBe("imp:x402:bindtx-retry");
  });

  it("does not double-credit when the COMMIT landed but the ack was lost", async () => {
    const jobId = "bind-ambiguous-1";
    facilitatorSettles("bindtx-ambiguous");
    const jm = manager();
    const job = await seedJob(jobId);
    try {
      // The first Tx C is durable; the caller is told it failed. The retry must
      // find the `job_messages` row already `verified` and re-apply nothing.
      const outcome = await payMidJob(jm, job, { fault: "after", times: 1 });
      expect(outcome.error).toBeUndefined();
    } finally {
      jm.shutdown();
    }

    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(ASK_MSATS);
    expect(row?.pendingPaymentMsats).toBe(0);
    expect(row?.creditId).toBe("imp:x402:bindtx-ambiguous");

    expect(job.creditId).toBe("imp:x402:bindtx-ambiguous");
    expect(job.paidMsats).toBe(ASK_MSATS);
  });

  it("recovers when EVERY attempt commits and loses the ack", async () => {
    // Lose every COMMIT acknowledgement, including no-op retries; only read-back can prove the final outcome.
    const jobId = "bind-ambiguous-all";
    facilitatorSettles("bindtx-ambiguous-all");
    const jm = manager();
    const job = await seedJob(jobId);
    let outcome;
    try {
      outcome = await payMidJob(jm, job, { fault: "after", times: CREDIT_INBOUND_ATTEMPTS });
      expect(faults.remaining()).toBe(0);
    } finally {
      jm.shutdown();
    }

    expect(outcome.error).toBeUndefined();
    expect(outcome.unappliedCredit).toBeUndefined();

    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(ASK_MSATS);
    expect(row?.pendingPaymentMsats).toBe(0);
    expect(row?.creditId).toBe("imp:x402:bindtx-ambiguous-all");
    expect(row?.drawId).toBe("bindtx-ambiguous-all");

    const draw = await ledger.getDraw({
      creditId: "imp:x402:bindtx-ambiguous-all",
      drawId: "bindtx-ambiguous-all",
    });
    expect(draw).toMatchObject({ status: "pending", amountMicro: ASK_MICRO, jobId });

    expect(job.paidMsats).toBe(ASK_MSATS);
    expect(job.pendingPaymentMsats).toBe(0);
    expect(job.creditId).toBe("imp:x402:bindtx-ambiguous-all");
  });

  it("retries the read-back, so one bad connection doesn't lose the recovery", async () => {
    // The post-exhaustion read uses the same pool; a fresh-connection retry must recover its own failure.
    const jobId = "bind-readretry-1";
    facilitatorSettles("bindtx-readretry");
    const jm = manager();
    const job = await seedJob(jobId);
    let outcome;
    try {
      outcome = await payMidJob(jm, job, {
        fault: "after",
        times: CREDIT_INBOUND_ATTEMPTS,
        reads: CREDIT_INBOUND_READ_ATTEMPTS - 1,
      });
      expect(faults.readsRemaining()).toBe(0);
    } finally {
      jm.shutdown();
    }

    expect(outcome.error).toBeUndefined();
    expect(outcome.unappliedCredit).toBeUndefined();
    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(ASK_MSATS);
    expect(row?.creditId).toBe("imp:x402:bindtx-readretry");
    expect(job.paidMsats).toBe(ASK_MSATS);
  });

  it("says unconfirmed, not unapplied, when the read-back never reaches the row", async () => {
    // Both commit acknowledgements and read-backs failed: the caller must read the job, not pay again.
    const jobId = "bind-unconfirmed-1";
    facilitatorSettles("bindtx-unconfirmed");
    const jm = manager();
    const job = await seedJob(jobId);
    let outcome;
    try {
      outcome = await payMidJob(jm, job, {
        fault: "after",
        times: CREDIT_INBOUND_ATTEMPTS,
        reads: CREDIT_INBOUND_READ_ATTEMPTS,
      });
      expect(faults.remaining()).toBe(0);
      expect(faults.readsRemaining()).toBe(0);
    } finally {
      jm.shutdown();
    }

    expect(outcome.error?.status).toBe(500);
    expect(outcome.error?.body).toMatchObject({
      error: "payment_unapplied",
      credit_id: "imp:x402:bindtx-unconfirmed",
      credited_micro: ASK_MICRO,
      credit_currency: "usd",
    });
    const hint = String(outcome.error?.body.hint);
    expect(hint).toContain("Read this job's status before paying again");
    expect(hint).not.toContain("does not reduce what this job owes");

    const display = String(outcome.error?.body.display);
    expect(display).toContain("unclear whether it was applied to this job");
    expect(display).not.toContain("still outstanding");

    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(ASK_MSATS);
    expect(row?.creditId).toBe("imp:x402:bindtx-unconfirmed");
    expect(row?.drawId).toBe("bindtx-unconfirmed");
    // And `markInboundFailed` left it alone — its CAS is on
    // `pending-verification`, so a verified inbound is never marked failed on
    // the strength of a read nobody could make.
    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM job_messages WHERE job_id = $1",
      [jobId]
    );
    expect(rows.map((r) => r.status)).toEqual(["verified"]);
  });

  it("answers payment_unapplied naming the credit when every attempt fails", async () => {
    const jobId = "bind-exhausted-1";
    facilitatorSettles("bindtx-exhausted");
    const deposits: unknown[] = [];
    const revenue: unknown[] = [];
    const jm = manager({
      onCreditFunded: (info) => deposits.push(info),
      onJobCompleted: (info) => revenue.push(info),
    });
    const job = await seedJob(jobId);
    let outcome;
    try {
      outcome = await payMidJob(jm, job, { fault: "before", times: 10 });
      faults.arm("before", 0);
      await new Promise((r) => setTimeout(r, 0));

      expect(outcome.error?.status).toBe(500);
      expect(outcome.error?.body).toMatchObject({
        error: "payment_unapplied",
        retryable: true,
        credit_id: "imp:x402:bindtx-exhausted",
        credited_micro: ASK_MICRO,
        credit_currency: "usd",
      });
      expect(String(outcome.error?.body.hint)).toContain("imp:x402:bindtx-exhausted");

      const row = await jobRow(jobId);
      expect(row?.paidMsats).toBe(0);
      expect(row?.pendingPaymentMsats).toBe(ASK_MSATS);
      expect(row?.creditId).toBeUndefined();

      const credit = await ledger.get("imp:x402:bindtx-exhausted");
      expect(credit).toMatchObject({ balanceMicro: ASK_MICRO, callerPubkey: CALLER });
      expect(credit?.availableMicro).toBe(0);
      expect(deposits).toHaveLength(1);

      const terminal = await jobRow(jobId);
      if (!terminal) throw new Error("job row vanished");
      await jobStore.save({ ...terminal, status: "completed" });
      const swept = await jm.sweepOrphanDraws();
      expect(swept).toMatchObject({ reconciled: 1 });
    } finally {
      jm.shutdown();
    }

    const after = await ledger.get("imp:x402:bindtx-exhausted");
    expect(after?.availableMicro).toBe(ASK_MICRO);
    expect(revenue).toHaveLength(0);
  });

  describe("ledger-less, where there is no credit to name", () => {
    // A ledger-less DVM still needs honest outcome-unknown copy without naming a nonexistent reclaim.

    it("promises no balance and no drain when the row was read", async () => {
      const jobId = "bind-noledger-1";
      facilitatorSettles("bindtx-noledger");
      const jm = manager({ ledgerless: true });
      const job = await seedJob(jobId);
      let outcome;
      try {
        outcome = await payMidJob(jm, job, { fault: "before", times: 10 });
        faults.arm("before", 0);
      } finally {
        jm.shutdown();
      }

      expect(outcome.error?.status).toBe(500);
      expect(outcome.error?.body).toMatchObject({ error: "payment_unapplied" });
      expect(outcome.error?.body.credit_id).toBeUndefined();
      const display = String(outcome.error?.body.display);
      const hint = String(outcome.error?.body.hint);

      expect(hint).toContain("Send a new payment");
      expect(`${display} ${hint}`).not.toContain("drain");
      expect(display).not.toContain("prepaid balance with this service,");
    });

    it("still says unconfirmed when the read-back never reaches the row", async () => {
      const jobId = "bind-noledger-2";
      facilitatorSettles("bindtx-noledger-2");
      const jm = manager({ ledgerless: true });
      const job = await seedJob(jobId);
      let outcome;
      try {
        outcome = await payMidJob(jm, job, {
          fault: "after",
          times: CREDIT_INBOUND_ATTEMPTS,
          reads: CREDIT_INBOUND_READ_ATTEMPTS,
        });
      } finally {
        jm.shutdown();
      }

      expect(outcome.error?.status).toBe(500);
      const display = String(outcome.error?.body.display);
      const hint = String(outcome.error?.body.hint);
      expect(display).toContain("unclear whether it was applied to this job");
      expect(display).not.toContain("still outstanding");
      expect(hint).toContain("Read this job's status before paying again");
      expect(`${display} ${hint}`).not.toContain("drain");

      const row = await jobRow(jobId);
      expect(row?.paidMsats).toBe(ASK_MSATS);
    });
  });

  it("names the loser when two free-then-paid top-ups race", async () => {
    const jobId = "bind-race-1";
    const jmA = manager();
    const jmB = manager();
    const jobA = await seedJob(jobId);

    const jobB = { ...jobA, messages: [] } as ServerJob;

    // Two machines, two rail payments, one job — neither sees the other's
    // credit in its snapshot, so each opens its own implicit one.
    const bodyA = { type: "payment" as const, content: { x402_payment: "header-a" } };
    const bodyB = { type: "payment" as const, content: { x402_payment: "header-b" } };
    const seqA = await jmA.recordInboundPending(jobA, bodyA.type, bodyA.content);
    const seqB = await jmB.recordInboundPending(jobB, bodyB.type, bodyB.content);

    let outcomeA, outcomeB;
    try {
      facilitatorSettles("bindtx-racea");
      outcomeA = await jmA.processPayment(jobA, bodyA, seqA);
      facilitatorSettles("bindtx-raceb");
      outcomeB = await jmB.processPayment(jobB, bodyB, seqB);
    } finally {
      jmA.shutdown();
      jmB.shutdown();
    }

    expect(outcomeA.error).toBeUndefined();
    expect(outcomeB.error).toBeUndefined();

    // Concurrent free-then-paid top-ups create separate draws. The loser releases at terminal; this is not existing-draw growth.
    const row = await jobRow(jobId);
    expect(row?.paidMsats).toBe(2 * ASK_MSATS);
    expect(row?.creditId).toBe("imp:x402:bindtx-racea");

    expect(outcomeA.unappliedCredit).toBeUndefined();
    expect(outcomeB.unappliedCredit).toMatchObject({
      credit_id: "imp:x402:bindtx-raceb",
      credited_micro: ASK_MICRO,
      credit_currency: "usd",
    });
    expect(outcomeB.unappliedCredit?.hint).toContain("drain");

    expect(jobB.creditId).toBe("imp:x402:bindtx-racea");
  });

  describe("the deposit is reachable from durable state, not just the response", () => {

    async function creditEndpoint(): Promise<string> {
      const dvm = configureDVM({
        name: "midjob-bind-credit",
        capability: "do",
        input: z.object({ q: z.string() }),
        price: "$0.10" as const,
        credit: { min: "$0.01", max: "$5.00" },
        auth: secp256k1Auth(),
        onJob: (ctx) => {
          ctx.complete("done");
        },
      });
      const { app } = await createDVMServer(dvm, {
        env: {},
        store: new MemoryKVStore(),
        jobStore,
        fxFetcher: warmFetcher(),
        creditLedger: ledger,
      });
      return servers.serve(app);
    }

    function creditCall(url: string, fields: Record<string, unknown>): Promise<Response> {
      return fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditSigner.signRequest(PRIVKEY, fields)),
      });
    }

    it("lists an unapplied deposit under the caller's key and drains it once released", async () => {
      const jobId = "bind-durable-1";
      facilitatorSettles("bindtx-durable");
      const jm = manager();
      const job = await seedJob(jobId);
      try {
        await payMidJob(jm, job, { fault: "before", times: 10 });
        faults.arm("before", 0);

        const url = await creditEndpoint();
        const held = (await (await creditCall(url, { op: "balance" })).json()) as {
          credits: { credit_id: string; balance_micro: number; remaining_micro: number }[];
        };
        const entry = held.credits.find((c) => c.credit_id === "imp:x402:bindtx-durable");

        expect(entry).toMatchObject({ balance_micro: ASK_MICRO, remaining_micro: 0 });

        const terminal = await jobRow(jobId);
        if (!terminal) throw new Error("job row vanished");
        await jobStore.save({ ...terminal, status: "cancelled" });
        await jm.sweepOrphanDraws();

        const res = await creditCall(url, {
          op: "drain",
          credit_id: "imp:x402:bindtx-durable",
          drain: { drain_id: "d1", method: "cashu", payout: { refund_pubkey: REFUND_PUBKEY } },
        });
        const drained = (await res.json()) as { drain: Record<string, unknown> };
        expect(res.status).toBe(200);
        expect(drained.drain).toMatchObject({
          credit_id: "imp:x402:bindtx-durable",
          amount_micro: ASK_MICRO,
          currency: "usd",
          status: "pending",
        });
      } finally {
        jm.shutdown();
      }
    });
  });
});
