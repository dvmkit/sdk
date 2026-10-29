/**
 * Dev mode skips verification only without configured mints. Explicit dev_auto
 * has no payment proof and is accepted only in development; any attached proof
 * still takes its real rail.
 */
import { describe, expect, it, vi } from "vitest";

import { configureDVM } from "../../configure";
import type { FxFetcher, FxRateSnapshot } from "../../pricing/fx";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { ServerJob } from "../job";
import { JobManager } from "../job-manager";
import { MemoryJobStore } from "../memory-job-store";
import { hasPaymentProof, PAYMENT_PROOF_KEYS } from "../payment";

vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));

const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");

const RATE = 100_000;
const DVM_ID = "dvm-1";
const JOB_ID = "job-1";
const MINT = "https://mint.example";
const ASK_MSATS = 50_000;
const LOCK_PUBKEYS = ["02" + "ab".repeat(32)] as never;

function warmFetcher(): FxFetcher {
  return {
    fetch: vi.fn(() =>
      Promise.resolve({
        rates: { usd: RATE } as FxRateSnapshot["rates"],
        as_of: new Date(0).toISOString(),
      })
    ),
    supportedCurrencies: () => ["usd"],
    lastKnown: vi.fn(() => null),
  };
}

/**
 * A `JobManager` in the shape `serve()` builds it. `cashu` toggles accumulator
 * readiness so the "mints without a mode" configuration can be pinned too.
 */
function manager(opts: {
  devMode?: boolean;
  mints?: string[];
  cashu?: boolean;
}): JobManager<unknown, undefined> {
  const descriptor = configureDVM({
    name: "devmode-skip-test",
    capability: "test",
    tag: "test",
    onJob: () => undefined,
  });
  return new JobManager(descriptor, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: warmFetcher(),
    dvmId: DVM_ID,
    devMode: opts.devMode,
    mints: opts.mints,
    ...(opts.cashu ? { cashuMode: "p2pk-accumulator" as const, db: {} as never } : {}),
  });
}

function awaitingJob(): ServerJob {
  return {
    id: JOB_ID,
    requesterId: "dev-anonymous",
    paidMsats: 0,
    pendingPaymentMsats: ASK_MSATS,
    pendingPrompts: new Map(),
    status: "awaiting-input",
  } as ServerJob;
}

function cashuPayment(extra: Record<string, unknown> = {}) {
  return {
    type: "payment" as const,
    content: { cashu_token: "cashuTok", cashu_request_id: "req-1", ...extra },
  };
}

function acceptFullPayment(): void {
  vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
    const accepted = {
      grossMsats: ASK_MSATS,
      inputFeeMsats: 0,
      mintUrl: MINT,
      netMsats: ASK_MSATS,
      paidMsats: ASK_MSATS,
      requestId: opts.requestId ?? "",
    };
    await opts.withCommitTx?.({} as never, accepted);
    return { kind: "accumulated" as const, ...accepted };
  });
}

describe("hasPaymentProof", () => {
  it("is true for each rail the mid-job dispatch keys on, and false with none", () => {
    for (const key of PAYMENT_PROOF_KEYS) {
      expect(hasPaymentProof({ [key]: "proof" })).toBe(true);
    }
    expect(hasPaymentProof({})).toBe(false);
    // `dev_auto` is a flag, not a proof — that asymmetry is the whole point.
    expect(hasPaymentProof({ dev_auto: true, amount_msats: ASK_MSATS })).toBe(false);
    // An empty credential is no credential; the rail dispatch skips it too.
    expect(hasPaymentProof({ cashu_token: "" })).toBe(false);
  });
});

describe("the mid-job skip reads the same predicate as the upfront one", () => {
  it.each([false, true])("keeps a prompt waiting when the fallback skips payment with dev_auto=%s", async (explicit) => {
    const jm = manager({ devMode: true, ...(explicit ? { mints: [MINT] } : {}) });
    const job = awaitingJob();
    job.pendingPrompts.set("question", { resolve: () => undefined, reject: () => undefined });
    try {
      await jm.processPayment(job, { type: "payment", content: explicit ? { dev_auto: true } : {} }, null);
      expect(job.status).toBe("awaiting-input");
      expect(job.paidMsats).toBe(ASK_MSATS);
      expect(job.pendingPaymentMsats).toBeUndefined();
      expect(job.reactivationPaymentApplied).toBe(true);
    } finally {
      jm.shutdown();
    }
  });

  it("auto-credits a dev server with no mints, without touching the rail", async () => {
    const jm = manager({ devMode: true });
    const job = awaitingJob();
    try {
      const res = await jm.processPayment(job, cashuPayment(), null);
      expect(res).toEqual({});
    } finally {
      jm.shutdown();
    }

    expect(acceptAccumulatorPayment).not.toHaveBeenCalled();
    expect(job.paidMsats).toBe(ASK_MSATS);
    expect(job.pendingPaymentMsats).toBeUndefined();
    expect(job.status).toBe("processing");
    expect(job.reactivationPaymentApplied).toBe(true);
  });

  it("runs the real rail verify on a dev server wired to a mint", async () => {
    acceptFullPayment();
    const jm = manager({ devMode: true, mints: [MINT], cashu: true });
    const job = awaitingJob();
    try {
      const res = await jm.processPayment(job, cashuPayment(), null, {
        lockPubkeys: LOCK_PUBKEYS,
      });
      expect(res).toEqual({});
    } finally {
      jm.shutdown();
    }

    // Accumulator receipt and recorded rail fields prove the real accept path ran.
    expect(acceptAccumulatorPayment).toHaveBeenCalledTimes(1);
    expect(job.paidMsats).toBe(ASK_MSATS);
    expect(job.paymentRail).toBe("cashu");
    expect(job.paymentMint).toBe(MINT);
    expect(job.reactivationPaymentApplied).toBe(true);
  });

  it("refuses a mid-job cashu payment a dev server can't verify", async () => {
    // Mints configured but no accumulator mode — the same 402 the upfront path
    // already answers for this configuration. Deliberately not special-cased:
    // making the predicate accumulator-aware would change the upfront skip too.
    const jm = manager({ devMode: true, mints: [MINT] });
    try {
      const res = await jm.processPayment(awaitingJob(), cashuPayment(), null, {
        lockPubkeys: LOCK_PUBKEYS,
      });
      expect(res.error?.status).toBe(402);
      expect(res.error?.body.error).toBe("cashu_not_p2pk_locked");
    } finally {
      jm.shutdown();
    }
    expect(acceptAccumulatorPayment).not.toHaveBeenCalled();
  });
});

describe("`dev_auto` is the explicit dev-console hatch", () => {
  it("auto-credits on a dev server that has mints wired", async () => {
    const jm = manager({ devMode: true, mints: [MINT], cashu: true });
    const job = awaitingJob();
    try {
      const res = await jm.processPayment(
        job,
        { type: "payment", content: { dev_auto: true, amount_msats: ASK_MSATS } },
        null,
        { lockPubkeys: LOCK_PUBKEYS }
      );
      expect(res).toEqual({});
    } finally {
      jm.shutdown();
    }

    expect(acceptAccumulatorPayment).not.toHaveBeenCalled();
    expect(job.paidMsats).toBe(ASK_MSATS);
    expect(job.status).toBe("processing");
  });

  it("loses to a real token riding the same message", async () => {
    // The flag must never leave money on the wire unspent against a credited
    // job: a message that carries a proof always takes the rail.
    acceptFullPayment();
    const jm = manager({ devMode: true, mints: [MINT], cashu: true });
    const job = awaitingJob();
    try {
      const res = await jm.processPayment(job, cashuPayment({ dev_auto: true }), null, {
        lockPubkeys: LOCK_PUBKEYS,
      });
      expect(res).toEqual({});
    } finally {
      jm.shutdown();
    }

    expect(acceptAccumulatorPayment).toHaveBeenCalledTimes(1);
    expect(job.paymentRail).toBe("cashu");
  });

  it.each(PAYMENT_PROOF_KEYS)("credits nothing when a %s rides beside it", async (key) => {
    // Every declared proof key must defeat the dev_auto shortcut, even when its
    // rail is not configured and therefore refuses verification.
    const jm = manager({ devMode: true, mints: [MINT] });
    const job = awaitingJob();
    try {
      await jm.processPayment(
        job,
        { type: "payment", content: { [key]: "proof", dev_auto: true, amount_msats: ASK_MSATS } },
        null,
        { lockPubkeys: LOCK_PUBKEYS }
      );
    } finally {
      jm.shutdown();
    }
    expect(job.paidMsats).toBe(0);
    expect(job.pendingPaymentMsats).toBe(ASK_MSATS);
    expect(job.status).toBe("awaiting-input");
  });

  it("credits nothing off dev mode", async () => {
    const jm = manager({ mints: [MINT], cashu: true });
    const job = awaitingJob();
    try {
      const res = await jm.processPayment(
        job,
        { type: "payment", content: { dev_auto: true, amount_msats: ASK_MSATS } },
        null,
        { lockPubkeys: LOCK_PUBKEYS }
      );
      // A development flag without a configured rail must explicitly refuse
      // production payment acceptance while leaving the outstanding ask intact.
      expect(res).toMatchObject({ error: { status: 402, body: { error: "payment_invalid" } } });
    } finally {
      jm.shutdown();
    }
    expect(job.paidMsats).toBe(0);
    expect(job.pendingPaymentMsats).toBe(ASK_MSATS);
  });

  /**
   * The dev console uses the route with a streamable store, exercising
   * the inboundSeq branch rather than a direct JobManager call.
   */
  describe("through `POST /v1/job/:id/messages`", () => {
    async function postDevAutoPayment(opts: {
      devMode: boolean;
      mints?: string[];
    }): Promise<{ res: Response; status: () => Promise<Record<string, unknown>> }> {
      const dvm = configureDVM({
        name: "dev-auto-validation",
        capability: "test",
        async onJob(ctx) {
          await ctx.requestPayment(ASK_MSATS, "fee");
          ctx.complete("paid");
        },
      });
      const { app } = await createDVMServer(dvm, {
        env: {},
        store: new MemoryKVStore(),
        devMode: opts.devMode,
        mints: opts.mints,
      });
      const jobRes = await app.request("/v1/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "test", input: "test" }),
      });
      const { job_id, job_token } = (await jobRes.json()) as {
        job_id: string;
        job_token?: string;
      };
      const headers = {
        "Content-Type": "application/json",
        ...(job_token ? { "X-Job-Token": job_token } : {}),
      };
      await new Promise((r) => setTimeout(r, 50));
      const res = await app.request(`/v1/job/${job_id}/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "payment", content: { dev_auto: true } }),
      });
      return {
        res,
        status: async () => {
          await new Promise((r) => setTimeout(r, 50));
          const s = await app.request(`/v1/job/${job_id}`, { headers });
          return (await s.json()) as Record<string, unknown>;
        },
      };
    }

    it("admits a proofless `dev_auto` payment on a dev server", async () => {
      const { res } = await postDevAutoPayment({ devMode: true });
      expect(res.status).toBe(201);
    });

    it("resumes the suspended handler on a dev server that has mints wired", async () => {
      // With mints configured, the dev console must use explicit dev_auto for its
      // proof-free payment; ordinary payments still verify.
      const { res, status } = await postDevAutoPayment({ devMode: true, mints: [MINT] });
      expect(res.status).toBe(201);
      expect(await status()).toMatchObject({ status: "completed", summary: "paid" });
    });

    it("rejects it everywhere else", async () => {
      const { res } = await postDevAutoPayment({ devMode: false });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_message");
      expect(body.message).toContain("cashu_token");
    });
  });
});
