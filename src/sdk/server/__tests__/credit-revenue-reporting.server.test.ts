/* Draws earn revenue; funding creates deposits. HTTP terminal wiring must conserve both. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { JobManager, type JobManagerOpts } from "../job-manager";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import {
  clampPooledRailValueToZero,
  LegacyNullRailLedger,
  UNRECOGNIZED_RAIL,
  UnrecognizedRailLedger,
} from "./__helpers__/credit-fixtures";

type RevenueReport = Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0];
type CostReport = Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0];
type RevenueSkipReport = Parameters<NonNullable<JobManagerOpts["onRevenueSkippedNoRail"]>>[0];

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string()
});

const PRIVKEY = new Uint8Array(32).fill(7);
const CALLER_PUBKEY = hex(schnorr.getPublicKey(PRIVKEY));
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const PRICE_MICRO = 100_000;
const FUNDED_MICRO = 20 * PRICE_MICRO;

const signer = createSignedRequestVerifier(signedSchema);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const servers = servedApps();

interface Harness {
  url: string;
  ledger: MemoryCreditLedger;
  reports: RevenueReport[];
  costs: CostReport[];
  alerts: RevenueSkipReport[];
}

async function startServer(ledger: MemoryCreditLedger = new MemoryCreditLedger()): Promise<Harness> {
  const reports: RevenueReport[] = [];
  const costs: CostReport[] = [];
  const alerts: RevenueSkipReport[] = [];
  const dvm = configureDVM({
    name: "credit-revenue-test",
    capabilities: {
      do: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.complete("done");
        }
      },
      boom: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.fail("nope");
        }
      },
      gratis: {
        input: signedSchema,
        onJob(ctx) {
          ctx.complete("free");
        }
      },
      "free-cost": {
        input: signedSchema,
        onJob(ctx) {
          ctx.cost({ amount: 0.0004, currency: "usd" });
          ctx.complete("free");
        }
      },
      "failed-cost": {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.cost({ amount: 0.0011, currency: "usd" });
          ctx.fail("vendor failed");
        }
      },
      "free-mixed-cost": {
        input: signedSchema,
        onJob(ctx) {
          ctx.cost({ amount: 0.0004, currency: "usd" });
          ctx.cost({ amount: 0.0005, currency: "eur" });
          ctx.complete("free");
        }
      },

      costly: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.cost({ amount: 0.0004, currency: "usd" });
          ctx.cost({ amount: 0.0011, currency: "usd" });
          ctx.cost({ amount: 0.02, currency: "usd" });
          ctx.complete("done");
        }
      },

      mixed: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.cost({ amount: 0.5, currency: "usd" });
          ctx.cost({ amount: 0.4, currency: "eur" });
          ctx.complete("done");
        }
      }
    },
    auth: secp256k1Auth()
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    dvmId: "dvm-1",
    creditLedger: ledger,
    onJobCompleted: (info) => {
      reports.push(info);
    },
    onJobCost: (info) => {
      costs.push(info);
    },
    onRevenueSkippedNoRail: (info) => {
      alerts.push(info);
    }
  });
  const url = await servers.serve(app);
  return { url, ledger, reports, costs, alerts };
}

async function fundCredit(ledger: MemoryCreditLedger, amountMicro = FUNDED_MICRO): Promise<void> {
  await ledger.fund({
    creditId: "c1",
    callerPubkey: CALLER_PUBKEY,
    currency: "usd",
    amountMicro,
    expiryMs: FUTURE_MS,
    basis: {
      rail: "cashu",
      paidMsats: amountMicro,
      mint: "https://mint.example",
      fundingRef: "req-funding-1"
    }
  });
}

async function drawJob(url: string, capability: string, drawId: string): Promise<Response> {
  return fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability,
      data: signer.signRequest(PRIVKEY, {
        action: "go",
        credit_id: "c1",
        draw_id: drawId
      })
    })
  });
}

/** The revenue callback is fired fire-and-forget off the terminal path. */
function settleReports(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

describe("draws are the revenue events", () => {
  it("books one revenue event per settled draw, conserving the funding's rail value", async () => {
    const { url, ledger, reports, alerts } = await startServer();
    await fundCredit(ledger, 2 * PRICE_MICRO);

    for (let i = 0; i < 2; i++) {
      const res = await drawJob(url, "do", `d${i}`);
      expect(res.status).toBe(200);
    }
    await settleReports();

    expect(reports).toHaveLength(2);
    expect(alerts).toHaveLength(0);
    const hashes = reports.map((r) => r.paymentTxHash);
    expect(new Set(hashes).size).toBe(2);
    for (const hash of hashes) expect(hash).toMatch(/^draw:[0-9a-f]{64}$/);

    for (const r of reports) {
      expect(r.capability).toBe("do");
      expect(r.drawAmountMicro).toBe(PRICE_MICRO);
      expect(r.creditCurrency).toBe("usd");
      expect(r.creditId).toBe("c1");
      expect(r.rail).toBe("cashu");
      expect(r.fundingRef).toBe("req-funding-1");
      expect(r.settledAt).toBeGreaterThan(0);
      const draw = await ledger.getDraw({ creditId: "c1", drawId: r.drawId! });
      expect(r.settledAt).toBe(draw?.resolvedAt);
      expect(r).not.toHaveProperty("cost");
    }
    expect(reports.reduce((s, r) => s + r.paidMsats, 0)).toBe(200_000);
    expect(reports.reduce((s, r) => s + (r.drawAmountMicro ?? 0), 0)).toBe(200_000);
  });

  it("books nothing for a failed job's released draw", async () => {
    const { url, ledger, reports } = await startServer();
    await fundCredit(ledger);

    await drawJob(url, "do", "ok-1");
    await drawJob(url, "boom", "failed-1");
    await drawJob(url, "do", "ok-2");
    await settleReports();

    expect(reports.map((r) => r.drawId).sort()).toEqual(["ok-1", "ok-2"]);

    const released = await ledger.getDraw({ creditId: "c1", drawId: "failed-1" });
    expect(released?.status).toBe("released");
  });

  it("does not double-book when a completed job is polled repeatedly", async () => {
    const { url, ledger, reports } = await startServer();
    await fundCredit(ledger);

    const res = await drawJob(url, "do", "d1");
    const body = (await res.json()) as { job_id: string; job_token: string };
    // The read path re-enters `issueReceipt` — and therefore the draw
    // resolution — whenever a job carries no persisted receipt, which is every
    // job on a DVM without a receipt key. Booking from there instead of from
    // the terminal would turn a polling caller into a queue amplifier.
    for (let i = 0; i < 2; i++) {
      const poll = await fetch(`${url}/v1/job/${body.job_id}`, {
        headers: { "X-Job-Token": body.job_token }
      });
      expect(poll.status).toBe(200);
    }
    await settleReports();

    expect(reports).toHaveLength(1);
  });

  it("logs the lost booking when a settled draw has no rail to report under", async () => {
    // A legacy rail-less credit can settle a draw but cannot identify its revenue rail; expose the skipped booking.
    const { url, ledger, reports, alerts } = await startServer(new LegacyNullRailLedger());
    await fundCredit(ledger);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lines: Record<string, unknown>[];
    try {
      expect((await drawJob(url, "do", "d1")).status).toBe(200);
      await settleReports();
      lines = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "revenue_skipped_no_rail");
    } finally {
      warn.mockRestore();
    }

    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.status).toBe("settled");
    expect((await ledger.get("c1"))?.balanceMicro).toBe(FUNDED_MICRO - PRICE_MICRO);

    expect(reports).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: "warn",
      event: "revenue_skipped_no_rail"
    });
    expect(alerts).toEqual([
      expect.objectContaining({
        dvmId: "dvm-1",
        jobId: expect.any(String),
        creditId: "c1",
        drawId: "d1",
        paidMsats: expect.any(Number),
        drawAmountMicro: PRICE_MICRO,
        creditCurrency: "usd",
        creditRail: null,
        reason: "credit_rail_null"
      })
    ]);
  });

  it("names the allow-list gap apart from the legacy row when the rail is unknown", async () => {
    // An unknown recorded rail needs a different diagnosis from an absent legacy rail.
    const { url, ledger, reports, alerts } = await startServer(new UnrecognizedRailLedger());
    await fundCredit(ledger);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lines: Record<string, unknown>[];
    try {
      expect((await drawJob(url, "do", "d1")).status).toBe(200);
      await settleReports();
      lines = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "revenue_skipped_no_rail");
    } finally {
      warn.mockRestore();
    }

    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.status).toBe("settled");
    expect(reports).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: "warn",
      event: "revenue_skipped_no_rail"
    });
    expect(alerts).toEqual([
      expect.objectContaining({
        creditId: "c1",
        drawId: "d1",
        drawAmountMicro: PRICE_MICRO,
        creditRail: UNRECOGNIZED_RAIL,
        reason: "credit_rail_unrecognized"
      })
    ]);
  });

  it("names a manager built without a ledger apart from a rail it can't read", async () => {
    // createDVMServer supplies a default ledger; only direct JobManager construction reaches this missing-ledger guard.
    const reports: RevenueReport[] = [];
    const alerts: RevenueSkipReport[] = [];
    const descriptor = configureDVM({
      name: "ledger-less-mount",
      capability: "do",
      tag: "test",
      idleTimeout: 120,
      onJob(ctx) {
        ctx.complete("done");
      }
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      devMode: true,
      dvmId: "dvm-1",

      onJobCompleted: (info) => {
        reports.push(info);
      },
      onRevenueSkippedNoRail: (info) => {
        alerts.push(info);
      },
      staleJobTimeoutMs: 0
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let lines: Record<string, unknown>[];
    try {
      const job = jm.createJob(
        { input: "hi" },
        "requester-1",
        { paidMsats: 21_000, receivedProofs: [], creditId: "c1", drawId: "d1" },
        21_000,
        "do"
      );
      jm.runHandler(job, jm.buildAndAttachContext(job, "hi"));
      await job.terminalWork;
      lines = warn.mock.calls
        .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
        .filter((entry) => entry.event === "revenue_skipped_no_rail");
    } finally {
      warn.mockRestore();
      jm.shutdown();
    }

    expect(reports).toHaveLength(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      level: "warn",
      event: "revenue_skipped_no_rail"
    });
    // With no ledger, the diagnostic cannot attest a draw amount; it must identify missing wiring.
    expect(lines[0].drawAmountMicro).toBeUndefined();
    expect(alerts).toEqual([
      expect.objectContaining({
        jobId: expect.any(String),
        creditId: "c1",
        drawId: "d1",
        paidMsats: 21_000,
        drawAmountMicro: undefined,
        creditRail: null,
        reason: "ledger_not_configured"
      })
    ]);
    expect(warn.mock.calls.filter(([line]) => String(line).includes("revenue_skipped_unsettled_draw"))).toEqual([]);
  });

  it("says nothing about a free job, which owes no revenue event", async () => {
    const { url, reports } = await startServer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await fetch(`${url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: "gratis",
          data: signer.signRequest(PRIVKEY, { action: "go" })
        })
      });
      expect(res.status).toBe(200);
      await settleReports();
      expect(warn.mock.calls.filter(([line]) => String(line).includes("revenue_skipped_no_rail"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
    expect(reports).toHaveLength(0);
  });

  it("emits no revenue for an unpaid submit without credit fields", async () => {
    const { url, reports } = await startServer();
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "do",
        data: signer.signRequest(PRIVKEY, { action: "go" })
      })
    });
    expect(res.status).toBe(402);
    await settleReports();
    expect(reports).toHaveLength(0);
  });
});

describe("a multi-rate credit books what the deposit was worth", () => {
  /** $1.00 at 1,000 sats, then $1.00 at 2,000 sats — 3,000 sats over $2.00. */
  const CHEAP_MSATS = 1_000_000;
  const DEAR_MSATS = 2_000_000;

  async function fundTwice(ledger: MemoryCreditLedger, jobsPerDeposit = 10): Promise<void> {
    // Distinct instants: `fifoOrder` breaks a same-millisecond tie on the
    // lot's surrogate id, which is a random UUID, so two fundings written in
    // one tick would deplete in an arbitrary order.
    const openedAt = Date.now();
    for (const [msats, ref, at] of [
      [CHEAP_MSATS, "req-cheap", openedAt],
      [DEAR_MSATS, "req-dear", openedAt + 1_000]
    ] as const) {
      await ledger.fund({
        creditId: "c1",
        callerPubkey: CALLER_PUBKEY,
        currency: "usd",
        amountMicro: jobsPerDeposit * PRICE_MICRO,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "cashu",
          paidMsats: msats,
          mint: "https://mint.example",
          fundingRef: ref
        },
        nowMs: at
      });
    }
  }

  /**
   * One job through `JobManager` directly, against a draw already placed on
   * `ledger`. Both shapes below are job rows whose counter and whose draw
   * disagree by construction, which is what the paths under test leave behind
   * and what an HTTP round trip has no way to produce.
   */
  async function bookOneJob(ledger: MemoryCreditLedger, paidMsats: number): Promise<RevenueReport[]> {
    const reports: RevenueReport[] = [];
    const descriptor = configureDVM({
      name: "midjob-topup-mount",
      capability: "do",
      tag: "test",
      idleTimeout: 120,
      onJob(ctx) {
        ctx.complete("done");
      }
    });
    const jm = new JobManager(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      devMode: true,
      dvmId: "dvm-1",
      creditLedger: ledger,
      onJobCompleted: (info) => {
        reports.push(info);
      },
      staleJobTimeoutMs: 0
    });
    try {
      const job = jm.createJob(
        { input: "hi" },
        "requester-1",
        {
          paidMsats,
          paymentRail: "cashu",
          receivedProofs: [],
          creditId: "c1",
          drawId: "d1"
        },
        PRICE_MICRO,
        "do"
      );
      jm.runHandler(job, jm.buildAndAttachContext(job, "hi"));
      await job.terminalWork;
      await settleReports();
    } finally {
      jm.shutdown();
    }
    return reports;
  }

  it("reports each job at its own deposit's rate, and the four sum to the sats funded", async () => {
    const { url, ledger, reports, alerts } = await startServer();
    await fundTwice(ledger, 2);

    for (let i = 0; i < 4; i++) {
      expect((await drawJob(url, "do", `d${i}`)).status).toBe(200);
    }
    await settleReports();

    expect(alerts).toHaveLength(0);
    expect(reports).toHaveLength(4);
    // Conservation alone misses blended pricing: two draws consume each lot, cheap first and dear second.
    const byDraw = new Map(reports.map((r) => [r.drawId, r.paidMsats]));
    for (let i = 0; i < 2; i++) expect(byDraw.get(`d${i}`)).toBe(500_000);
    for (let i = 2; i < 4; i++) expect(byDraw.get(`d${i}`)).toBe(1_000_000);
    expect(reports.reduce((sum, r) => sum + r.paidMsats, 0)).toBe(CHEAP_MSATS + DEAR_MSATS);
  });

  it("corrects the draw's share of the job's counter and leaves an unabsorbed top-up alone", async () => {
    // Correct the allocated-to-settled draw delta without dropping paid top-ups the ledger never recorded.
    const ledger = new MemoryCreditLedger();
    await fundTwice(ledger);
    const draw = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: PRICE_MICRO });

    expect(draw.railValue.drawMsats).toBe(150_000);
    const TOPUP_MSATS = 40_000;

    const reports = await bookOneJob(ledger, 150_000 + TOPUP_MSATS);

    // Preserve the 40000-msat unledgered top-up while replacing the 150000 forecast with 100000 settled msats.
    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.railValue.drawMsats).toBe(
      100_000
    );
    expect(reports).toHaveLength(1);
    expect(reports[0].capability).toBe("do");
    expect(reports[0].paidMsats).toBe(100_000 + TOPUP_MSATS);
  });

  it("books the lots' figure where the pooled forecast had already clamped to zero", async () => {
    // A legacy pool can reach zero while lots retain sats; zero allocation must not suppress FIFO settlement correction.
    const ledger = new MemoryCreditLedger();
    await fundTwice(ledger);
    clampPooledRailValueToZero(ledger, "c1");
    const draw = await ledger.draw({ creditId: "c1", drawId: "d1", amountMicro: PRICE_MICRO });
    expect(draw.railValue.drawMsats).toBe(0);

    const ASK_MSATS = 150_000;
    const reports = await bookOneJob(ledger, ASK_MSATS);

    expect(reports).toHaveLength(1);
    expect(reports[0].paidMsats).toBe(100_000);
  });
});

// Builder cost is reported independently of caller revenue; terminals with no revenue use the cost-only channel.
describe("a job reports what it cost the builder", () => {
  it("carries the handler's declared cost, summed, in millionths", async () => {
    const h = await startServer();
    await fundCredit(h.ledger);
    expect((await drawJob(h.url, "costly", "d-cost-1")).status).toBe(200);
    await settleReports();

    expect(h.reports).toHaveLength(1);
    // 0.0004 + 0.0011 + 0.02 = 0.0215 usd. Cents would have reported 2 and
    // thrown away the two sub-cent vendor calls entirely.
    expect(h.reports[0].cost).toEqual({ amountMicro: 21_500, currency: "usd" });

    expect(h.reports[0].drawAmountMicro).toBe(PRICE_MICRO);
    expect(h.costs).toHaveLength(0);
  });

  it("reports a free completed job's declared cost without booking revenue", async () => {
    const h = await startServer();
    const response = await fetch(`${h.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "free-cost",
        data: signer.signRequest(PRIVKEY, { action: "go" })
      })
    });
    expect(response.status).toBe(200);
    await settleReports();

    expect(h.reports).toHaveLength(0);
    expect(h.costs).toEqual([
      {
        dvmId: "dvm-1",
        jobId: expect.any(String),
        capability: "free-cost",
        outcome: "completed",
        costRevision: 1,
        cost: { amountMicro: 400, currency: "usd" }
      }
    ]);
  });

  it("reports a failed job's declared cost without booking its released draw", async () => {
    const h = await startServer();
    await fundCredit(h.ledger);
    expect((await drawJob(h.url, "failed-cost", "d-cost-failed")).status).toBe(202);
    await settleReports();

    expect(h.reports).toHaveLength(0);
    expect(h.costs).toEqual([
      {
        dvmId: "dvm-1",
        jobId: expect.any(String),
        capability: "failed-cost",
        outcome: "failed",
        costRevision: 1,
        cost: { amountMicro: 1_100, currency: "usd" }
      }
    ]);
    expect((await h.ledger.getDraw({ creditId: "c1", drawId: "d-cost-failed" }))?.status).toBe("released");
  });

  it("emits a higher-revision invalidation when a later declaration switches currency", async () => {
    const h = await startServer();
    const response = await fetch(`${h.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "free-mixed-cost",
        data: signer.signRequest(PRIVKEY, { action: "go" })
      })
    });
    expect(response.status).toBe(200);
    await settleReports();

    expect(h.reports).toHaveLength(0);
    expect(h.costs).toEqual([
      {
        dvmId: "dvm-1",
        jobId: expect.any(String),
        capability: "free-mixed-cost",
        outcome: "completed",
        costRevision: 2,
        cost: null
      }
    ]);
  });

  it("sends no cost key when one job named two currencies", async () => {
    const h = await startServer();
    await fundCredit(h.ledger);
    expect((await drawJob(h.url, "mixed", "d-cost-3")).status).toBe(200);
    await settleReports();

    expect(h.reports).toHaveLength(1);

    expect(h.reports[0]).not.toHaveProperty("cost");
    expect(h.reports[0].drawAmountMicro).toBe(PRICE_MICRO);
  });
});
