import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { signDeployAttestation, attestationEnv } from "../../../test-support/deploy-attestation";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import type { SDKJobContext } from "../../types";
import { CreditLedger } from "../credit-ledger";
import { createDVMHost } from "../host";
import { JobManager } from "../job-manager";
import { isStreamableJobStore } from "../job-store";
import { mandatePaymentId, settleMandateAsk } from "../mandate-payment";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const schema = `sdk_mandate_http_${randomUUID().replaceAll("-", "")}`;
const key = Buffer.from("12".repeat(32), "hex");
const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
const signer = createSignedRequestVerifier(z.object({}), { replayStore: null });
const attestation = signDeployAttestation({ builderSecret: "23".repeat(32),
  builderPubkey: Buffer.from(schnorr.getPublicKey(Buffer.from("23".repeat(32), "hex"))).toString("hex"),
  dvmId: "example-mandate-service", slug: "mandate-service", capabilities: ["run", "paid"], withReceiptKey: true });
const audience = { dvm_id: attestation.payload.dvm_id, builder_pubkey: attestation.identityPubkey };
const ASK = 1_000;
const fixture = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/standing-mandate-v1.json", import.meta.url), "utf8")) as {
  standing_decline: { unsupported_display: string; response: { seq: number; stop_requested: boolean; display: string }; status_fields: { stop_requested: boolean; display: string } };
  mandate_payment: { message: { from: string; type: string; content: { credit: Record<string, unknown> } };
    payment_id: { prefix: string; vector: { job_id: string; request_seq: number; preimage: string; payment_id: string } } };
};
// The documented derivation, so a caller can name the payment for an ask without reading it back.
const documentedPaymentId = (jobId: string, requestSeq: number) =>
  fixture.mandate_payment.payment_id.prefix + createHash("sha256").update(JSON.stringify(["mandate", jobId, requestSeq])).digest("hex");

type Script = "one" | "two" | "late" | "prompt" | "hold" | "asked-mid-prompt" | "stop" | "stop-prompt" | "progress" | "concurrent-prompt";

it("derives the published payment_id vector byte for byte", () => {
  const { prefix, vector } = fixture.mandate_payment.payment_id;
  // The preimage is pinned as text, so a whitespace or key-order change in the derivation shows here.
  expect(prefix + createHash("sha256").update(Buffer.from(vector.preimage, "utf8")).digest("hex")).toBe(vector.payment_id);
  expect(mandatePaymentId(vector.job_id, vector.request_seq)).toBe(vector.payment_id);
  expect(fixture.mandate_payment.message.content.credit.payment_id).toBe(vector.payment_id);
});

describe.skipIf(!process.env.DATABASE_URL)("standing mandate pays asks through production host wiring", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  const completions = new Map<string, number>();
  // A `late` job asks only once the test opens its gate, so the test sets the scene without racing a clock.
  const gates = new Map<string, { opened: Promise<void>; open: () => void; arrived: Promise<void>; arrive: () => void }>();
  const gate = (jobId: string) => {
    let entry = gates.get(jobId);
    if (!entry) {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => { open = resolve; });
      let arrive!: () => void;
      const arrived = new Promise<void>((resolve) => { arrive = resolve; });
      entry = { opened, open, arrived, arrive };
      gates.set(jobId, entry);
    }
    return entry;
  };
  const hosts: ReturnType<typeof createDVMHost>[] = [];
  const warnings: Record<string, unknown>[] = [];
  beforeAll(async () => {
    await recreateSchema(schema);
    pool = await pinnedPool(schema);
    ledger = new CreditLedger(pool);
  });
  let managers: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Hosts do not expose their job managers; every manager runs this once at start-up.
    managers = vi.spyOn(JobManager.prototype, "recoverTerminalCosts");
    const warn = console.warn.bind(console);
    vi.spyOn(console, "warn").mockImplementation((...values: unknown[]) => {
      if (typeof values[0] === "string" && values[0].startsWith("{")) {
        try { warnings.push(JSON.parse(values[0]) as Record<string, unknown>); } catch { /* not a diagnostic */ }
      }
      warn(...values);
    });
  });
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.shutdown();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await pool?.end();
    await dropSchemas(schema);
  });

  async function server(opts: { onCancel?: () => Promise<void>; balancePayments?: boolean } = {}) {
    const host = createDVMHost({ pool, port: 0, env: {
      ...attestationEnv(attestation), ...(opts.balancePayments === false ? { DVMKIT_BALANCE_PAYMENTS: "false" } : {}),
    } });
    hosts.push(host);
    const input = z.object({ action: z.string(), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() });
    const onJob = async (ctx: SDKJobContext<Record<string, unknown>, unknown>) => {
      const script = (ctx.input as { action: Script }).action;
      if (script === "late") {
        const hold = gate(ctx.jobId);
        hold.arrive();
        await hold.opened;
      }
      // A prompt left open across the ask keeps the job awaiting input after the ask is paid.
      const earlier = script === "asked-mid-prompt" ? ctx.prompt("earlier", "Anything else?") : undefined;
      const payment = ctx.requestPayment({ amount: 0.001, currency: "usd" }, "next hour");
      if (script === "progress") {
        await gate(ctx.jobId).opened;
        ctx.progress(50);
      }
      if (script === "concurrent-prompt") {
        await gate(ctx.jobId).opened;
        await ctx.prompt("concurrent", "Continue?");
      }
      await payment;
      await earlier;
      if (script === "stop" || script === "stop-prompt") {
        const hold = gate(ctx.jobId);
        hold.arrive();
        await hold.opened;
        if (script === "stop-prompt") void ctx.prompt("later", "Anything else?").catch(() => undefined);
        await ctx.requestPayment({ amount: 0.001, currency: "usd" }, "next hour", { finishedChargeMicro: 600 });
      }
      if (script === "prompt" || script === "hold") await ctx.prompt("continue", "Continue?");
      if (script === "two" || script === "prompt") await ctx.requestPayment({ amount: 0.001, currency: "usd" }, "next hour");
      completions.set(ctx.jobId, (completions.get(ctx.jobId) ?? 0) + 1);
      ctx.complete("done");
    };
    host.mount(configureDVM({ name: "mandate-service", credit: {}, auth: secp256k1Auth(), capabilities: {
      run: { input, onJob, onCancel: opts.onCancel },
      paid: { price: "$0.001", input, onJob, onCancel: opts.onCancel },
    } }));
    return (await host.serve()).url;
  }
  function post(url: string, body: unknown, token?: string) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Job-Token": token } : {}) }, body: JSON.stringify(body) });
  }
  async function fund(creditId: string, amountMicro = 10_000) {
    await ledger.fund({ creditId, callerPubkey: pubkey, currency: "usd", amountMicro,
      expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: Math.floor(amountMicro / 2) } });
  }
  async function submit(url: string, opts: { creditId: string; drawId?: string; priced?: boolean; script: Script;
    maxTotal?: number; maxAsk?: number; expiresInMs?: number }) {
    const capability = opts.priced ? "paid" : "run";
    const drawId = opts.drawId ?? `draw-${opts.creditId}`;
    const expiresAtMs = Date.now() + (opts.expiresInMs ?? 86_400_000);
    const mandate = opts.maxTotal === undefined ? {} : { credit_id: opts.creditId, draw_id: drawId,
      mandate: { max_total_micro: opts.maxTotal, max_ask_micro: opts.maxAsk ?? ASK, expires_at_ms: expiresAtMs } };
    const data = signer.signRequest(key, { action: opts.script, ...mandate },
      undefined, { audience, method: "POST", path: "/v1/job", capability });
    const created = await post(`${url}/v1/job`, { capability, data });
    expect(created.status, await created.clone().text()).toBe(202);
    const job = await created.json() as { job_id: string; job_token: string };
    return { ...job, creditId: opts.creditId, drawId, expiresAtMs };
  }
  type Stored = { seq: number; from: string; type: string; content: Record<string, unknown> };
  // Live rows while the job runs; a terminal job's history is compacted onto its row.
  async function messages(jobId: string): Promise<Stored[]> {
    const live = (await pool.query<{ data: Stored }>(
      "SELECT data FROM job_messages WHERE job_id=$1 AND status='verified' ORDER BY seq", [jobId])).rows.map((row) => row.data);
    if (live.length) return live;
    return (await pool.query<{ messages: Stored[] }>("SELECT messages FROM jobs WHERE id=$1", [jobId])).rows[0]?.messages ?? [];
  }
  /** The latest ask exactly as a caller reads it from the job's messages endpoint. */
  async function servedAsk(url: string, job: { job_id: string; job_token: string }) {
    const response = await fetch(`${url}/v1/job/${job.job_id}/messages`, { headers: { "X-Job-Token": job.job_token } });
    expect(response.status).toBe(200);
    const body = await response.json() as { messages: { type: string; from: string; content: { mandate_skipped?: unknown } }[] };
    return body.messages.findLast((m) => m.from === "provider" && m.type === "payment-request")!;
  }
  async function status(jobId: string) {
    return (await pool.query("SELECT status FROM jobs WHERE id=$1", [jobId])).rows[0]?.status as string | undefined;
  }
  async function openAsk(jobId: string) {
    await expect.poll(async () => (await pool.query("SELECT status,pending_payment_fiat_micro FROM jobs WHERE id=$1", [jobId])).rows[0],
      { timeout: 10_000 }).toEqual({ status: "awaiting-input", pending_payment_fiat_micro: String(ASK) });
    return (await messages(jobId)).findLast((m) => m.type === "payment-request")!;
  }
  function signedPayment(job: { job_id: string }, askSeq: number, creditId: string, drawId: string, paymentId = `signed-${job.job_id}-${askSeq}`) {
    return { type: "payment", content: { credit: signer.signRequest(key, { credit_id: creditId, draw_id: drawId,
      payment_id: paymentId, request_seq: askSeq, amount_micro: ASK, currency: "usd" }, undefined,
    { audience, method: "POST", path: `/v1/job/${job.job_id}/messages`, capability: null }) } };
  }
  async function balancePayments(jobId: string) {
    return (await pool.query("SELECT payment_id, request_seq FROM credit_balance_payments WHERE job_id=$1 ORDER BY request_seq", [jobId])).rows;
  }
  /** The job manager of the host started most recently. */
  function latestManager() {
    return managers.mock.contexts.at(-1) as JobManager<unknown, undefined>;
  }
  /** Runs `observe` before every query on the shared pool; a throw fails that query. */
  function observeQueries(observe: (sql: unknown, params: unknown) => void | Promise<void>) {
    const originals = new Map<PoolClient, PoolClient["query"]>();
    const inject = (client: PoolClient) => {
      if (originals.has(client)) return;
      const query = client.query.bind(client);
      originals.set(client, query);
      client.query = ((...args: unknown[]) => {
        const invoke = async () => {
          await observe(args[0], args[1]);
          return (query as (...args: unknown[]) => Promise<unknown>)(...args);
        };
        const callback = args.at(-1);
        // Pool.query uses callbacks internally; injecting an error must also release that client.
        if (typeof callback === "function") {
          void invoke().catch((error: unknown) => { callback(error); });
          return;
        }
        return invoke();
      }) as typeof client.query;
    };
    pool.on("acquire", inject);
    return () => {
      pool.off("acquire", inject);
      for (const [client, query] of originals) client.query = query;
    };
  }
  /** Fails every mandate settlement after its draw has grown, before the payment is verified, so none commits. */
  function failSettlements() {
    let failed = 0;
    const restore = observeQueries((sql) => {
      if (typeof sql === "string" && sql.startsWith("UPDATE job_messages SET status='verified'")) {
        failed++;
        throw new Error("worker stopped");
      }
    });
    return { failed: () => failed, restore };
  }
  /** An unpaid ask whose worker stopped before settling it. */
  async function strandedAsk(creditId: string, { mandate = true, script = "one" }: {
    mandate?: boolean;
    script?: "one" | "progress" | "concurrent-prompt";
  } = {}) {
    const url = await server();
    await fund(creditId);
    const failure = mandate ? failSettlements() : undefined;
    try {
      const job = await submit(url, { creditId, script, maxTotal: mandate ? 5 * ASK : undefined });
      const ask = await openAsk(job.job_id);
      if (failure) await expect.poll(failure.failed).toBeGreaterThan(0);
      if (script !== "one") gate(job.job_id).open();
      if (script === "progress") {
        await expect.poll(async () => (await messages(job.job_id)).findLast((message) => message.from === "provider"))
          .toMatchObject({ type: "progress" });
      }
      if (script === "concurrent-prompt") {
        await expect.poll(async () => (await messages(job.job_id)).find((message) =>
          message.seq > ask.seq && message.type === "prompt" && message.content.id === "concurrent"),
        { timeout: 5_000 }).toBeDefined();
        const answer = await post(`${url}/v1/job/${job.job_id}/messages`,
          { type: "response", content: { prompt_id: "concurrent", text: "yes" } }, job.job_token);
        expect(answer.status, await answer.clone().text()).toBe(201);
        await openAsk(job.job_id);
      }
      await hosts[0].shutdown();
      return { job, ask };
    } finally {
      failure?.restore();
    }
  }
  async function expectPaidOnceAndDone(job: { job_id: string; drawId: string }, creditId: string, askSeq: number) {
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toEqual([{ payment_id: documentedPaymentId(job.job_id, askSeq), request_seq: String(askSeq) }]);
    // The only requester message is the provider-written mandate payment: the caller sent nothing.
    expect((await messages(job.job_id)).filter((m) => m.from === "requester" && m.type !== "request").map((m) => m.content.credit))
      .toEqual([expect.objectContaining({ mandate: true, request_seq: askSeq })]);
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId })).toMatchObject({ status: "settled", amountMicro: ASK });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - ASK);
  }
  // Past the sweep's grace window without waiting it out.
  const afterGrace = () => Date.now() + 60_000;

  async function decline(url: string, job: { job_id: string; job_token: string }) {
    return post(`${url}/v1/job/${job.job_id}/messages`, { type: "decline", content: { reason: "stop after this piece" } }, job.job_token);
  }
  async function stoppedJob(creditId: string, script: Script = "stop") {
    const url = await server();
    await fund(creditId);
    const job = await submit(url, { creditId, priced: true, script, maxTotal: 5 * ASK });
    await gate(job.job_id).arrived;
    expect(latestManager().activeJobs.get(job.job_id)?.pendingPayment).toBeNull();
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    expect(await status(job.job_id)).toBe("processing");
    const stopped = await decline(url, job);
    expect(stopped.status, await stopped.clone().text()).toBe(201);
    expect(await stopped.json()).toEqual({ ...fixture.standing_decline.response, seq: expect.any(Number) });
    const read = await fetch(`${url}/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token } });
    expect(await read.json()).toMatchObject({ status: "processing", ...fixture.standing_decline.status_fields });
    return { url, job };
  }
  async function expectDeclined(job: { job_id: string; creditId: string; drawId: string }) {
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("cancelled");
    // The upfront piece finished at ask 1; the next piece used 600 of its 1,000 micro cap.
    await expect.poll(() => ledger.getDraw({ creditId: job.creditId, drawId: job.drawId }))
      .toMatchObject({ status: "settled", amountMicro: 1_600 });
    expect((await ledger.get(job.creditId))?.balanceMicro).toBe(8_400);
    expect((await ledger.get(job.creditId))?.availableMicro).toBe(8_400);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    expect(completions.get(job.job_id)).toBeUndefined();
  }

  it("accepts a decline while a paid ask finishes resuming into the between-asks gate", async () => {
    let releaseResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
    let resumeEntered!: () => void;
    const resuming = new Promise<void>((resolve) => { resumeEntered = resolve; });
    let releaseIntent!: () => void;
    const intentGate = new Promise<void>((resolve) => { releaseIntent = resolve; });
    let intentEntered!: () => void;
    const checkingIntent = new Promise<void>((resolve) => { intentEntered = resolve; });
    const url = await server();
    const manager = latestManager();
    const resumeOwner = manager as unknown as { adoptPaymentMetadata: (...args: unknown[]) => Promise<boolean> };
    const adopt = resumeOwner.adoptPaymentMetadata.bind(manager);
    const resumeSpy = vi.spyOn(resumeOwner, "adoptPaymentMetadata").mockImplementation(async (...args) => {
      resumeEntered();
      await resumeGate;
      return adopt(...args);
    });
    const arrivalStore = manager.store as unknown as { openPaymentIntentUntil: (...args: unknown[]) => Promise<number | undefined> };
    const checkIntent = arrivalStore.openPaymentIntentUntil.bind(manager.store);
    let intentSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const creditId = "stop-resume-transition";
      await fund(creditId);
      const job = await submit(url, { creditId, priced: true, script: "stop", maxTotal: 5 * ASK });
      await resuming;
      expect(await status(job.job_id)).toBe("processing");
      expect(manager.activeJobs.get(job.job_id)?.pendingPayment).not.toBeNull();
      intentSpy = vi.spyOn(arrivalStore, "openPaymentIntentUntil").mockImplementation(async (...args) => {
        intentEntered();
        await intentGate;
        return checkIntent(...args);
      });
      const pending = decline(url, job);
      await checkingIntent;
      releaseResume();
      await gate(job.job_id).arrived;
      const live = manager.activeJobs.get(job.job_id)!;
      expect(live.status).toBe("processing");
      expect(live.pendingPayment).toBeNull();
      expect(live.pendingPrompts.size).toBe(0);
      expect(live.pendingPaymentMsats ?? 0).toBe(0);
      expect(await status(job.job_id)).toBe("processing");
      releaseIntent();
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toEqual({ ...fixture.standing_decline.response, seq: expect.any(Number) });
      gate(job.job_id).open();
      await expectDeclined(job);
    } finally {
      releaseResume();
      releaseIntent();
      resumeSpy.mockRestore();
      intentSpy?.mockRestore();
    }
  }, 30_000);

  it("records an idempotent standing decline and charges only finished work at the next ask", async () => {
    const { url, job } = await stoppedJob("stop-next");
    const repeated = await decline(url, job);
    expect(repeated.status).toBe(201);
    expect(await repeated.json()).toEqual({ ...fixture.standing_decline.response, seq: expect.any(Number) });
    expect(await status(job.job_id)).toBe("processing");
    gate(job.job_id).open();
    await expectDeclined(job);
  }, 30_000);

  it("preserves a standing decline across a provider restart before the next ask", async () => {
    const { job } = await stoppedJob("stop-restart");
    await hosts[0].shutdown();
    // Leave the old handler parked; only the replacement worker's gate will be released.
    gates.delete(job.job_id);
    await server();
    const manager = latestManager();
    const store = manager.store;
    if (!isStreamableJobStore(store)) throw new Error("restart requires a streamable store");
    const saved = (await store.get(job.job_id))!;
    expect(saved.stopRequested).toBe(true);
    saved.messages = await store.getMessages(job.job_id, 0);
    saved.seq = Math.max(saved.seq, ...saved.messages.map((message) => message.seq));
    // Mid-piece processing recovery is explicit; the HTTP inbound path only replays suspended asks.
    const replay = manager.reactivateJob(saved);
    replay.job.replayHighSeq = saved.seq;
    manager.runHandler(replay.job, replay.sdkCtx);
    await gate(job.job_id).arrived;
    gate(job.job_id).open();
    await expectDeclined(job);
  }, 30_000);

  it.each([false, true])("never pays a stopped job's stranded ask from the sweep (prompt=%s)", async (prompt) => {
    const { job } = await stoppedJob(`stop-sweep-${prompt}`, prompt ? "stop-prompt" : "stop");
    const settle = vi.spyOn(JobManager.prototype as unknown as { payAskFromMandate: () => Promise<void> }, "payAskFromMandate")
      .mockResolvedValue(undefined);
    try {
      gate(job.job_id).open();
      await expect.poll(async () => (await messages(job.job_id)).filter((m) => m.type === "payment-request")).toHaveLength(2);
      await hosts[0].shutdown();
    } finally { settle.mockRestore(); }
    await server();
    await latestManager().sweepMandateAsks(afterGrace());
    await expectDeclined(job);
  }, 30_000);

  it("reads a committed stop after waiting for the settlement row lock", async () => {
    const { job } = await stoppedJob("stop-lock");
    const suppress = vi.spyOn(JobManager.prototype as unknown as { payAskFromMandate: () => Promise<void> }, "payAskFromMandate")
      .mockResolvedValue(undefined);
    try {
      gate(job.job_id).open();
      await expect.poll(async () => (await messages(job.job_id)).filter((m) => m.type === "payment-request")).toHaveLength(2);
    } finally { suppress.mockRestore(); }
    await pool.query("UPDATE jobs SET stop_requested=FALSE WHERE id=$1", [job.job_id]);
    const tx = await pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query("SELECT id FROM jobs WHERE id=$1 FOR UPDATE", [job.job_id]);
      // A stop is committing while settlement waits: a lock-free read sees the old false flag.
      await tx.query("UPDATE jobs SET stop_requested=TRUE WHERE id=$1", [job.job_id]);
      let lockAttempt!: () => void;
      const attempted = new Promise<void>((resolve) => { lockAttempt = resolve; });
      const restore = observeQueries((sql) => {
        if (sql === "SELECT * FROM jobs WHERE id=$1 FOR UPDATE") lockAttempt();
      });
      const pending = settleMandateAsk({ pool, ledger, jobId: job.job_id, dvmId: audience.dvm_id });
      try {
        await attempted;
        await expect.poll(async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND query='SELECT * FROM jobs WHERE id=$1 FOR UPDATE'
          AND wait_event_type='Lock'`)).rows[0].n).toBeGreaterThan(0);
        await tx.query("COMMIT");
        expect(await pending).toMatchObject({ outcome: "declined" });
      } finally { restore(); }
    } finally { await tx.query("ROLLBACK"); tx.release(); }
    await latestManager().sweepMandateAsks(afterGrace());
    await expectDeclined(job);
  }, 30_000);

  it.each(["payment ask", "prompt"] as const)("preserves the live decline transcript and summary at an open %s", async (kind) => {
    const url = await server();
    const creditId = `stop-open-${kind.replaceAll(" ", "-")}`;
    await fund(creditId);
    const job = await submit(url, { creditId, priced: true, script: kind === "prompt" ? "hold" : "one",
      maxTotal: 5 * ASK, maxAsk: kind === "prompt" ? ASK : ASK - 1 });
    if (kind === "prompt") {
      await expect.poll(async () => (await messages(job.job_id)).some((m) => m.type === "prompt")).toBe(true);
    } else {
      await openAsk(job.job_id);
    }
    const response = await decline(url, job);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ seq: expect.any(Number) });
    await expect.poll(() => status(job.job_id)).toBe("cancelled");
    const history = await messages(job.job_id);
    expect.soft(history.filter((m) => m.type === "decline" || m.type === "cancel"))
      .toEqual([expect.objectContaining({ from: "requester", type: "decline", content: { reason: "stop after this piece" } })]);
    expect.soft((await pool.query("SELECT summary FROM jobs WHERE id=$1", [job.job_id])).rows[0].summary).toBeNull();
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId }))
      .toMatchObject({ status: "settled", amountMicro: ASK });
    expect(await balancePayments(job.job_id)).toHaveLength(kind === "prompt" ? 1 : 0);
  });

  it("awaits live decline cleanup without requiring the optional store-only decline method", async () => {
    let entered = false;
    let finished = false;
    let finish!: () => void;
    const cleanup = new Promise<void>((resolve) => { finish = resolve; });
    const url = await server({ onCancel: async () => { entered = true; await cleanup; finished = true; } });
    const creditId = "stop-custom-open";
    await fund(creditId);
    const job = await submit(url, { creditId, priced: true, script: "one", maxTotal: 5 * ASK, maxAsk: ASK - 1 });
    await openAsk(job.job_id);
    const store = latestManager().store as { declineJob?: unknown };
    const original = store.declineJob;
    store.declineJob = undefined;
    let responded = false;
    const pending = decline(url, job).then((response) => { responded = true; return response; });
    try {
      await expect.poll(() => entered).toBe(true);
      expect(responded).toBe(false);
      finish();
      const response = await pending;
      expect(response.status).toBe(201);
      expect(finished).toBe(true);
    } finally {
      finish();
      await pending;
      store.declineJob = original;
    }
  });

  it("adapts the pending stop response and status to the reading host's payment support", async () => {
    const { url, job } = await stoppedJob("stop-disabled-display");
    const disabled = await server({ balancePayments: false });
    const response = await decline(disabled, job);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ...fixture.standing_decline.response,
      display: fixture.standing_decline.unsupported_display, seq: expect.any(Number) });
    const read = async (base: string) => (await fetch(`${base}/v1/job/${job.job_id}`,
      { headers: { "X-Job-Token": job.job_token } })).json();
    expect(await read(disabled)).toMatchObject({ ...fixture.standing_decline.status_fields,
      display: fixture.standing_decline.unsupported_display });
    expect(await read(url)).toMatchObject(fixture.standing_decline.status_fields);
  });

  it("refuses a live standing decline with the old error when its store lacks declineJob", async () => {
    const url = await server();
    const creditId = "stop-custom-running";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "late", maxTotal: 5 * ASK });
    await gate(job.job_id).arrived;
    const store = latestManager().store as { declineJob?: unknown };
    const original = store.declineJob;
    store.declineJob = undefined;
    try {
      const response = await decline(url, job);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "no_open_ask",
        message: "The job has no open payment request or prompt to decline.",
        hint: "Decline answers an open ask. To stop a running job, cancel it with DELETE /v1/job/:id." });
      expect((await pool.query("SELECT status,stop_requested FROM jobs WHERE id=$1", [job.job_id])).rows[0])
        .toEqual({ status: "processing", stop_requested: false });
    } finally { store.declineJob = original; }
  }, 30_000);

  it("keeps the exact between-asks refusal on a job without a mandate", async () => {
    const url = await server();
    const data = signer.signRequest(key, { action: "late" }, undefined,
      { audience, method: "POST", path: "/v1/job", capability: "run" });
    const created = await post(`${url}/v1/job`, { capability: "run", data });
    const job = await created.json() as { job_id: string; job_token: string };
    const response = await decline(url, job);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "no_open_ask",
      message: "The job has no open payment request or prompt to decline.",
      hint: "Decline answers an open ask. To stop a running job, cancel it with DELETE /v1/job/:id." });
    expect(await status(job.job_id)).toBe("processing");
    await hosts[0].shutdown();
    const other = await server();
    const remote = await decline(other, job);
    expect(remote.status).toBe(409);
    expect(await remote.json()).toEqual({ error: "no_open_ask",
      message: "The job has no open payment request or prompt to decline.",
      hint: "Decline answers an open ask. To stop a running job, cancel it with DELETE /v1/job/:id." });
    expect(await status(job.job_id)).toBe("processing");
  });

  it.each([false, true])("pays each later ask from credit with no caller message (upfront=%s)", async (priced) => {
    const url = await server();
    const creditId = `metered-${priced}`;
    await fund(creditId);
    const upfront = priced ? ASK : 0;
    const job = await submit(url, { creditId, priced, script: "two", maxTotal: upfront + 2 * ASK });
    await expect.poll(() => status(job.job_id), { timeout: 10_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);

    const history = await messages(job.job_id);
    const asks = history.filter((m) => m.type === "payment-request");
    expect(asks).toHaveLength(2);
    for (const ask of asks) {
      // The mandate's payment is the very next message after the ask it pays.
      const payment = history.find((m) => m.seq === ask.seq + 1)!;
      expect(payment).toMatchObject({ from: fixture.mandate_payment.message.from, type: fixture.mandate_payment.message.type });
      const credit = payment.content.credit as Record<string, unknown>;
      expect(Object.keys(credit).sort()).toEqual(Object.keys(fixture.mandate_payment.message.content.credit).sort());
      expect(credit).toEqual({ mandate: true, request_seq: ask.seq, amount_micro: ASK, currency: "usd",
        credit_id: creditId, draw_id: job.drawId, payment_id: documentedPaymentId(job.job_id, ask.seq) });
    }
    expect(await balancePayments(job.job_id)).toEqual(asks.map((ask) => ({
      payment_id: documentedPaymentId(job.job_id, ask.seq), request_seq: String(ask.seq),
    })));

    const row = (await pool.query("SELECT credit_id,draw_id,payment_rail,pieces,receipt FROM jobs WHERE id=$1", [job.job_id])).rows[0];
    expect(row).toMatchObject({ credit_id: creditId, draw_id: job.drawId, payment_rail: "cashu" });
    // Each ask bought its own piece, bound to the payment message that paid it.
    expect((row.pieces as { amountMicro: number; paidSeq: number }[]).slice(-2)).toEqual(asks.map((ask) =>
      expect.objectContaining({ amountMicro: ASK, paidSeq: ask.seq + 1 })));
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId }))
      .toMatchObject({ status: "settled", amountMicro: upfront + 2 * ASK, jobId: job.job_id });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - upfront - 2 * ASK);
    await expect.poll(async () => (await pool.query("SELECT receipt FROM jobs WHERE id=$1", [job.job_id])).rows[0]?.receipt?.credit?.amount)
      .toBe(upfront + 2 * ASK);
    // A repeated settlement of a paid ask is a no-op, never a second charge.
    expect(await settleMandateAsk({ pool, ledger, jobId: job.job_id, dvmId: audience.dvm_id }))
      .toEqual({ outcome: "none" });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - upfront - 2 * ASK);
    // A mandate that pays every ask never marks one as skipped.
    expect(asks.filter((m) => "mandate_skipped" in m.content)).toEqual([]);
  }, 30_000);

  it.each([
    { reason: "mandate_expired", script: "late" as const, expiresInMs: 3_000 },
    { reason: "mandate_ask_cap", maxAsk: ASK - 1 },
    { reason: "mandate_total_cap", priced: true, maxTotal: 2 * ASK - 1 },
    { reason: "mandate_balance", balance: ASK - 1 },
    { reason: "mandate_draw_owned_elsewhere", script: "late" as const, takenDraw: true },
  ])("leaves the ask open for a signed payment when $reason", async (row) => {
    const url = await server();
    const creditId = `fallback-${row.reason}`;
    await fund(creditId, row.balance ?? 10_000);
    const before = warnings.length;
    const job = await submit(url, { creditId, priced: row.priced, script: row.script ?? "one",
      maxTotal: row.maxTotal ?? 5 * ASK, maxAsk: row.maxAsk, expiresInMs: row.expiresInMs });
    if (row.takenDraw) await ledger.draw({ creditId, drawId: job.drawId, amountMicro: 100, jobId: "another-job" });
    if (row.expiresInMs) await new Promise((resolve) => setTimeout(resolve, Math.max(0, job.expiresAtMs - Date.now() + 50)));
    if (row.script === "late") gate(job.job_id).open();
    const available = row.priced ? (row.balance ?? 10_000) - ASK : (row.balance ?? 10_000) - (row.takenDraw ? 100 : 0);

    const ask = await openAsk(job.job_id);
    await expect.poll(() => warnings.slice(before).filter((w) => w.event === "mandate_payment_skipped").map((w) => w.reason))
      .toEqual([row.reason]);
    // The caller sees the skip with its reason on the open ask itself.
    await expect.poll(async () => (await servedAsk(url, job)).content.mandate_skipped).toEqual({ reason: row.reason });
    expect((await messages(job.job_id)).filter((m) => m.from === "requester" && m.type === "payment")).toEqual([]);
    expect(await balancePayments(job.job_id)).toEqual([]);
    expect((await ledger.get(creditId))?.availableMicro).toBe(available);

    // Only the provider writes mandate payments; a caller's unsigned copy is refused.
    const forged = await post(`${url}/v1/job/${job.job_id}/messages`, { type: "payment", content: { credit: { mandate: true,
      credit_id: creditId, draw_id: job.drawId, payment_id: documentedPaymentId(job.job_id, ask.seq), request_seq: ask.seq,
      amount_micro: ASK, currency: "usd" } } }, job.job_token);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await balancePayments(job.job_id)).toEqual([]);

    if (row.balance !== undefined) await fund(creditId, 10_000);
    // An unbound job's signed payment opens its own draw; a taken draw id cannot be reused.
    const drawId = row.priced ? job.drawId : `signed-${job.drawId}`;
    const paid = await post(`${url}/v1/job/${job.job_id}/messages`, signedPayment(job, ask.seq, creditId, drawId), job.job_token);
    expect(paid.status, await paid.clone().text()).toBe(201);
    await expect.poll(() => status(job.job_id), { timeout: 10_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toEqual([{ payment_id: `signed-${job.job_id}-${ask.seq}`, request_seq: String(ask.seq) }]);
    await expect.poll(async () => (await ledger.getDraw({ creditId, drawId }))?.status).toBe("settled");
  }, 30_000);

  it("settles once when the settlement fails after the ledger move and the job resumes on another worker", async () => {
    const creditId = "crash-credit";
    const { job } = await strandedAsk(creditId);
    expect(await ledger.getDraw({ creditId, drawId: job.drawId })).toBeUndefined();
    expect((await ledger.get(creditId))?.availableMicro).toBe(10_000);
    expect((await messages(job.job_id)).filter((m) => m.type === "payment")).toEqual([]);

    const resumed = await server();
    const response = await post(`${resumed}/v1/job/${job.job_id}/messages`,
      { type: "response", content: { prompt_id: "resume", text: "continue" } }, job.job_token);
    expect(response.status).toBe(201);
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId })).toMatchObject({ status: "settled", amountMicro: ASK });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - ASK);
  }, 40_000);

  it.each([
    { mandate: true, sweepers: 2, script: "one", pendingVerification: false },
    { mandate: false, sweepers: 1, script: "one", pendingVerification: false },
    { mandate: false, sweepers: 2, script: "one", pendingVerification: false },
    { mandate: false, sweepers: 1, script: "progress", pendingVerification: false },
    { mandate: false, sweepers: 1, script: "one", pendingVerification: true },
    { mandate: false, sweepers: 1, script: "concurrent-prompt", pendingVerification: false },
    { mandate: true, sweepers: 1, script: "concurrent-prompt", pendingVerification: false },
  ] as const)("resumes a committed signed payment after worker loss (mandate=$mandate, sweepers=$sweepers, script=$script, held=$pendingVerification)",
  async ({ mandate, sweepers, script, pendingVerification }) => {
    const creditId = `sweep-signed-crash-${mandate}-${sweepers}-${script}-${pendingVerification}`;
    const { job, ask } = await strandedAsk(creditId, { mandate, script });
    const receiving = await server();
    const store = latestManager().store;
    if (!isStreamableJobStore(store)) throw new Error("expected a streaming job store");
    if (pendingVerification) {
      await store.recordInbound(job.job_id, { from: "requester", type: "payment",
        timestamp: Math.floor(Date.now() / 1000), content: { cashu_token: "pending" } });
    }
    let written = false;
    let committed = false;
    let failed = false;
    const restore = observeQueries((sql, params) => {
      if (typeof sql !== "string") return;
      if (sql.startsWith("INSERT INTO credit_balance_payments")) written = true;
      if (written && sql === "COMMIT") committed = true;
      if (!failed && committed && sql === "SELECT pg_notify('job_messages', $1)" && (params as unknown[])[0] === job.job_id) {
        failed = true;
        throw new Error("worker stopped before resume");
      }
    });
    try {
      const paid = await post(`${receiving}/v1/job/${job.job_id}/messages`, signedPayment(job, ask.seq, creditId, job.drawId), job.job_token);
      expect(paid.status, await paid.clone().text()).toBe(201);
      expect(failed).toBe(true);
      expect(await store.get(job.job_id)).toMatchObject({
        status: "awaiting-input", drawId: job.drawId, pendingPaymentMsats: undefined,
      });
      if (pendingVerification) {
        expect(await store.getMessages(job.job_id, ask.seq)).toEqual([]);
      }
      await hosts[1].shutdown();
    } finally { restore(); }
    await server();
    const first = latestManager();
    if (sweepers === 1) {
      await first.sweepMandateAsks(afterGrace());
    } else {
      await server();
      const second = latestManager();
      const both = Promise.withResolvers<void>();
      let claims = 0;
      const restoreClaims = observeQueries((sql, params) => {
        // Both workers must reach the real advisory lock before either tries to acquire it.
        if (sql === "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS got" && (params as unknown[])[0] === job.job_id) {
          if (++claims === 2) both.resolve();
          return both.promise;
        }
      });
      try {
        const sweep = Promise.all([first.sweepMandateAsks(afterGrace()), second.sweepMandateAsks(afterGrace())]);
        try {
          await expect.poll(() => claims).toBe(2);
        } finally {
          both.resolve();
          await sweep;
        }
      } finally {
        restoreClaims();
      }
    }
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toEqual([{ payment_id: `signed-${job.job_id}-${ask.seq}`, request_seq: String(ask.seq) }]);
    const inbound = (await messages(job.job_id)).filter((m) => m.from === "requester" && m.type !== "request");
    expect(inbound.map((message) => message.type)).toEqual(script === "concurrent-prompt" ? ["response", "payment"] : ["payment"]);
    expect(inbound.at(-1)?.content.credit).toMatchObject({ request_seq: ask.seq });
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId })).toMatchObject({ status: "settled", amountMicro: ASK });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - ASK);
  }, 40_000);

  it("stands down when the live worker opens a prompt before the sweep locks the paid wait", async () => {
    const url = await server();
    const original = latestManager();
    const store = original.store;
    if (!isStreamableJobStore(store)) throw new Error("expected a streaming job store");
    const creditId = "sweep-new-prompt";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "hold" });
    const ask = await openAsk(job.job_id);

    const wake = Promise.withResolvers<void>();
    const readCounters = store.getCounters.bind(store);
    vi.spyOn(store, "getCounters").mockImplementation(async (id) => {
      const counters = await readCounters(id);
      if (id === job.job_id && counters?.balancePaymentSatisfied) await wake.promise;
      return counters;
    });
    try {
      const paid = await post(`${url}/v1/job/${job.job_id}/messages`, signedPayment(job, ask.seq, creditId, job.drawId), job.job_token);
      expect(paid.status, await paid.clone().text()).toBe(201);
      await server();
      const sweeper = latestManager();
      const run = vi.spyOn(sweeper, "runHandler");
      const lock = Promise.withResolvers<void>();
      let claimReached = false;
      const restore = observeQueries((sql, params) => {
        if (!claimReached && typeof sql === "string" && /^SELECT status\b.*FROM jobs WHERE id=\$1 FOR UPDATE$/.test(sql) &&
            (params as unknown[])[0] === job.job_id) {
          claimReached = true;
          return lock.promise;
        }
      });
      try {
        const sweep = sweeper.sweepMandateAsks(afterGrace());
        try {
          await expect.poll(() => claimReached, { timeout: 5_000 }).toBe(true);
          // The grace polls are over, so only the row-locked comparison can observe the new wait.
          wake.resolve();
          await expect.poll(async () => (await messages(job.job_id)).filter((message) => message.type === "prompt"),
            { timeout: 5_000 }).toEqual([expect.objectContaining({ content: expect.objectContaining({ id: "continue" }) })]);
          expect(await status(job.job_id)).toBe("awaiting-input");
        } finally {
          lock.resolve();
          await sweep;
        }
      } finally {
        restore();
      }
      await sweeper.sweepMandateAsks(afterGrace());
      expect(run).not.toHaveBeenCalled();
      expect(sweeper.activeJobs.has(job.job_id)).toBe(false);
      const answer = await post(`${url}/v1/job/${job.job_id}/messages`,
        { type: "response", content: { prompt_id: "continue", text: "yes" } }, job.job_token);
      expect(answer.status, await answer.clone().text()).toBe(201);
      await expect.poll(() => status(job.job_id)).toBe("completed");
      expect(completions.get(job.job_id)).toBe(1);
      await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId })).toMatchObject({ status: "settled", amountMicro: ASK });
      expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - ASK);
    } finally {
      wake.resolve();
    }
  }, 30_000);

  it.each([false, true])("leaves an unpaid ask without a mandate suspended (later verified payment=%s)", async (verified) => {
    const url = await server();
    const creditId = `sweep-unpaid-${verified}`;
    const job = await submit(url, { creditId, script: "one" });
    const ask = await openAsk(job.job_id);
    await hosts[0].shutdown();
    await server();
    const manager = latestManager();
    const store = manager.store;
    if (!isStreamableJobStore(store)) throw new Error("expected a streaming job store");
    if (verified) {
      const seq = await store.recordInbound(job.job_id, { from: "requester", type: "payment",
        timestamp: Math.floor(Date.now() / 1000), content: { credit: { credit_id: creditId, request_seq: ask.seq } } });
      await store.verifyAndCredit(job.job_id, seq, null);
      expect(await store.getMessages(job.job_id, ask.seq)).toEqual([expect.objectContaining({ seq, from: "requester", type: "payment" })]);
    }
    const run = vi.spyOn(manager, "runHandler");
    await manager.sweepMandateAsks(afterGrace());
    expect(run).not.toHaveBeenCalled();
    expect(await store.get(job.job_id)).toMatchObject({ status: "awaiting-input", pendingPaymentMsats: ASK });
    expect(await balancePayments(job.job_id)).toEqual([]);
  });

  it("does not resume an expired unpaid ask with a later verified payment", async () => {
    const url = await server();
    const creditId = "sweep-unpaid-history";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "one", maxTotal: 5 * ASK, maxAsk: ASK - 1 });
    const ask = await openAsk(job.job_id);
    await hosts[0].shutdown();
    await server();
    const manager = latestManager();
    const store = manager.store;
    if (!isStreamableJobStore(store)) throw new Error("expected a streaming job store");
    // Real late rail payments are hidden as `balance`, not `verified`. Construct
    // the inconsistent history through the store to exercise the resumer's independent guard.
    const expiredAskSeq = await store.appendOutgoing(job.job_id, { from: "provider", type: "payment-request",
      timestamp: Math.floor(Date.now() / 1000), content: { ...ask.content, expires_at_ms: Date.now() - 60_000 } });
    const paymentSeq = await store.recordInbound(job.job_id, { from: "requester", type: "payment",
      timestamp: Math.floor(Date.now() / 1000), content: { credit: { credit_id: creditId, request_seq: expiredAskSeq } } });
    await store.verifyAndCredit(job.job_id, paymentSeq, null);
    expect((await messages(job.job_id)).findLast((m) => m.from === "requester" && m.type === "payment"))
      .toMatchObject({ seq: paymentSeq });
    expect(paymentSeq).toBeGreaterThan(expiredAskSeq);
    expect(await store.get(job.job_id)).toMatchObject({ status: "awaiting-input", pendingPaymentMsats: ASK });
    expect(await settleMandateAsk({ pool, ledger, jobId: job.job_id, dvmId: audience.dvm_id })).toEqual({ outcome: "none" });

    const run = vi.spyOn(manager, "runHandler");
    await manager.sweepMandateAsks(afterGrace());
    expect(run).not.toHaveBeenCalled();
    expect(manager.activeJobs.has(job.job_id)).toBe(false);
    expect(await store.get(job.job_id)).toMatchObject({ status: "awaiting-input", pendingPaymentMsats: ASK });
    expect(completions.has(job.job_id)).toBe(false);
    expect(await balancePayments(job.job_id)).toEqual([]);
    expect(await ledger.getDraw({ creditId, drawId: job.drawId })).toBeUndefined();
    expect((await ledger.get(creditId))?.availableMicro).toBe(10_000);
  }, 30_000);

  it.each(["credit lock", "commit"] as const)("does not pay when the mandate expires while waiting for %s", async (boundary) => {
    const url = await server();
    const creditId = `expiry-${boundary.replaceAll(" ", "-")}`;
    await fund(creditId);
    const job = await submit(url, { creditId, script: "late", maxTotal: 5 * ASK, expiresInMs: 10_000 });
    await gate(job.job_id).arrived;
    const tx = await pool.connect();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const atCommit = new Promise<void>((resolve) => { entered = resolve; });
    let paymentWritten = false;
    let restore = () => {};
    const warningStart = warnings.length;
    try {
      if (boundary === "credit lock") {
        await tx.query("BEGIN");
        await tx.query("SELECT credit_id FROM credits WHERE credit_id=$1 FOR UPDATE", [creditId]);
      } else {
        restore = observeQueries(async (sql, params) => {
          if (typeof sql !== "string") return;
          if (sql.startsWith("INSERT INTO credit_balance_payments")) paymentWritten = true;
          if (paymentWritten && sql === "SELECT pg_notify('job_messages', $1)" && (params as unknown[])[0] === job.job_id) {
            entered();
            await paused;
          }
        });
      }
      gate(job.job_id).open();
      if (boundary === "credit lock") {
        await expect.poll(async () => (await pool.query(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
          WHERE datname=current_database() AND query LIKE 'SELECT%FROM credits%FOR UPDATE'
          AND wait_event_type='Lock'`)).rows[0].n, { timeout: 5_000 }).toBeGreaterThan(0);
      } else { await atCommit; }
      expect(Date.now()).toBeLessThan(job.expiresAtMs);
      // The lock/commit barrier is held across the real authorization expiry, not a scheduling delay.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, job.expiresAtMs - Date.now() + 25)));
      if (boundary === "credit lock") await tx.query("COMMIT");
      else release();
      await expect.poll(async () => warnings.slice(warningStart).some((w) => w.reason === "mandate_expired") ||
        await status(job.job_id) === "completed", { timeout: 5_000 }).toBe(true);
      expect(await balancePayments(job.job_id)).toEqual([]);
      expect((await messages(job.job_id)).filter((m) => m.type === "payment")).toEqual([]);
      expect(await status(job.job_id)).toBe("awaiting-input");
      expect(await ledger.getDraw({ creditId, drawId: job.drawId })).toBeUndefined();
      expect((await ledger.get(creditId))?.availableMicro).toBe(10_000);
    } finally {
      release();
      restore();
      await tx.query("ROLLBACK");
      tx.release();
    }
  }, 30_000);

  it("settles a stranded ask and resumes the job from the sweep, with no caller message", async () => {
    const creditId = "sweep-unsettled";
    const { job, ask } = await strandedAsk(creditId);
    await server();
    await latestManager().sweepMandateAsks(afterGrace());
    await expectPaidOnceAndDone(job, creditId, ask.seq);
  }, 40_000);

  it("resumes a job whose ask was settled but never claimed", async () => {
    const creditId = "sweep-unclaimed";
    const { job, ask } = await strandedAsk(creditId);
    // A worker that paid the ask and stopped before its handler woke.
    expect(await settleMandateAsk({ pool, ledger, jobId: job.job_id, dvmId: audience.dvm_id }))
      .toMatchObject({ outcome: "paid", requestSeq: ask.seq, replayed: false });
    await server();
    await latestManager().sweepMandateAsks(afterGrace());
    await expectPaidOnceAndDone(job, creditId, ask.seq);
  }, 40_000);

  it("charges and runs once when two workers sweep the same stranded ask", async () => {
    const creditId = "sweep-race";
    const { job, ask } = await strandedAsk(creditId);
    await server();
    const first = latestManager();
    await server();
    const second = latestManager();
    expect(second).not.toBe(first);
    await Promise.all([first.sweepMandateAsks(afterGrace()), second.sweepMandateAsks(afterGrace())]);
    await expectPaidOnceAndDone(job, creditId, ask.seq);
  }, 40_000);

  it("sweeps a stranded ask on a job whose earlier prompt was answered", async () => {
    const url = await server();
    const creditId = "sweep-answered-prompt";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "prompt", maxTotal: 5 * ASK });
    await expect.poll(async () => (await messages(job.job_id)).some((m) => m.type === "prompt"), { timeout: 10_000 }).toBe(true);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    const failure = failSettlements();
    try {
      const answered = await post(`${url}/v1/job/${job.job_id}/messages`,
        { type: "response", content: { prompt_id: "continue", text: "go" } }, job.job_token);
      expect(answered.status).toBe(201);
      await expect.poll(async () => (await messages(job.job_id)).filter((m) => m.type === "payment-request").length, { timeout: 10_000 }).toBe(2);
      await expect.poll(failure.failed, { timeout: 10_000 }).toBeGreaterThan(0);
      await hosts[0].shutdown();
    } finally {
      failure.restore();
    }
    await server();
    await latestManager().sweepMandateAsks(afterGrace());
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toHaveLength(2);
  }, 40_000);

  it("pays a balance-held ask from the sweep once a top-up covers it", async () => {
    const url = await server();
    const manager = latestManager();
    const creditId = "sweep-topped-up";
    await fund(creditId, ASK - 1);
    const job = await submit(url, { creditId, script: "one", maxTotal: 5 * ASK });
    await openAsk(job.job_id);
    await manager.sweepMandateAsks(afterGrace());
    expect(await balancePayments(job.job_id)).toEqual([]);
    expect((await servedAsk(url, job)).content.mandate_skipped).toEqual({ reason: "mandate_balance" });
    await fund(creditId, 10_000);
    await manager.sweepMandateAsks(afterGrace());
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    // The ask is paid now, so it no longer claims the mandate will not pay it.
    const asks = (await messages(job.job_id)).filter((m) => m.type === "payment-request");
    expect(asks).toHaveLength(1);
    expect(asks.filter((m) => "mandate_skipped" in m.content)).toEqual([]);
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
  }, 40_000);

  it("pays a balance-held ask from the sweep once another job's hold on the credit is released", async () => {
    const url = await server();
    const manager = latestManager();
    const creditId = "sweep-released";
    await fund(creditId, 1_500);
    await ledger.draw({ creditId, drawId: "other-hold", amountMicro: ASK, jobId: "other-job" });
    const job = await submit(url, { creditId, script: "one", maxTotal: 5 * ASK });
    await openAsk(job.job_id);
    await manager.sweepMandateAsks(afterGrace());
    expect(await balancePayments(job.job_id)).toEqual([]);
    // A whole release frees the hold without touching the credit's balance or ledger sequence.
    await ledger.release({ creditId, drawId: "other-hold" });
    expect((await ledger.get(creditId))?.availableMicro).toBe(1_500);
    await manager.sweepMandateAsks(afterGrace());
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
  }, 40_000);

  it("leaves a job alone once its paid ask was claimed, though a prompt keeps it awaiting input", async () => {
    const url = await server();
    const live = latestManager();
    const creditId = "sweep-claimed";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "asked-mid-prompt", maxTotal: 5 * ASK });
    await expect.poll(() => balancePayments(job.job_id), { timeout: 10_000 }).toHaveLength(1);
    // The live handler has resumed past the ask and now waits on the earlier prompt.
    await expect.poll(() => live.activeJobs.get(job.job_id)?.pendingPayment ?? null).toBeNull();
    await expect.poll(() => status(job.job_id)).toBe("awaiting-input");
    await server();
    const sweeper = latestManager();
    await sweeper.sweepMandateAsks(afterGrace());
    expect(sweeper.activeJobs.has(job.job_id)).toBe(false);
    const answered = await post(`${url}/v1/job/${job.job_id}/messages`,
      { type: "response", content: { prompt_id: "earlier", text: "no" } }, job.job_token);
    expect(answered.status).toBe(201);
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(completions.get(job.job_id)).toBe(1);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
  }, 40_000);

  it.each([false, true])("wakes a replayed open ask when a signed payment reaches the reactivating worker (mandate=%s)", async (withMandate) => {
    const url = await server();
    const creditId = `replayed-ask-${withMandate}`;
    await fund(creditId);
    const drawId = `draw-${creditId}`;
    // A mandate whose ask cap refuses the ask, so the caller pays it either way.
    const fields = withMandate
      ? { action: "one", credit_id: creditId, draw_id: drawId,
        mandate: { max_total_micro: 5 * ASK, max_ask_micro: ASK - 1, expires_at_ms: Date.now() + 86_400_000 } }
      : { action: "one" };
    const data = signer.signRequest(key, fields, undefined, { audience, method: "POST", path: "/v1/job", capability: "run" });
    const created = await post(`${url}/v1/job`, { capability: "run", data });
    expect(created.status, await created.clone().text()).toBe(202);
    const job = await created.json() as { job_id: string; job_token: string };
    const ask = await openAsk(job.job_id);
    await hosts[0].shutdown();

    const resumed = await server();
    const manager = latestManager();
    const response = await post(`${resumed}/v1/job/${job.job_id}/messages`,
      { type: "response", content: { prompt_id: "resume", text: "continue" } }, job.job_token);
    expect(response.status).toBe(201);
    // The replay has re-opened the ask on this worker.
    await expect.poll(() => manager.activeJobs.get(job.job_id)?.pendingPayment ?? null, { timeout: 10_000 }).not.toBeNull();
    const paid = await post(`${resumed}/v1/job/${job.job_id}/messages`, signedPayment(job, ask.seq, creditId, drawId), job.job_token);
    expect(paid.status, await paid.clone().text()).toBe(201);
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
  }, 40_000);

  it("replays a mandate-paid ask as paid after the worker stops, charging each ask once", async () => {
    const url = await server();
    const creditId = "replay-credit";
    await fund(creditId);
    const job = await submit(url, { creditId, script: "prompt", maxTotal: 5 * ASK });
    await expect.poll(async () => (await messages(job.job_id)).some((m) => m.type === "prompt"), { timeout: 10_000 }).toBe(true);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    await hosts[0].shutdown();

    const resumed = await server();
    const response = await post(`${resumed}/v1/job/${job.job_id}/messages`,
      { type: "response", content: { prompt_id: "continue", text: "go" } }, job.job_token);
    expect(response.status).toBe(201);
    await expect.poll(() => status(job.job_id), { timeout: 15_000 }).toBe("completed");
    expect(completions.get(job.job_id)).toBe(1);
    const history = await messages(job.job_id);
    expect(history.filter((m) => m.type === "payment-request")).toHaveLength(2);
    expect(history.filter((m) => m.type === "payment" && m.from === "requester")).toHaveLength(2);
    expect(await balancePayments(job.job_id)).toHaveLength(2);
    await expect.poll(() => ledger.getDraw({ creditId, drawId: job.drawId })).toMatchObject({ status: "settled", amountMicro: 2 * ASK });
    expect((await ledger.get(creditId))?.balanceMicro).toBe(10_000 - 2 * ASK);
  }, 40_000);

  it.each([true, false])("charges once when a signed payment races the mandate for one ask (mandate first=%s)", async (mandateFirst) => {
    const url = await server();
    const creditId = `race-${mandateFirst}`;
    // Too little to pay the ask at first, so it stays open until both payers race for it.
    await fund(creditId, ASK - 1);
    // The job stays active after the ask is paid, so a late payer still finds it running.
    const job = await submit(url, { creditId, script: "hold", maxTotal: 5 * ASK });
    const ask = await openAsk(job.job_id);
    await fund(creditId, 10_000);
    const settle = () => settleMandateAsk({ pool, ledger, jobId: job.job_id, dvmId: audience.dvm_id });
    const signed = (paymentId?: string) => post(`${url}/v1/job/${job.job_id}/messages`,
      signedPayment(job, ask.seq, creditId, job.drawId, paymentId), job.job_token);
    const [first, second] = mandateFirst ? await Promise.all([settle(), signed()]) : (await Promise.all([signed(), settle()])).reverse();
    const settled = first as Awaited<ReturnType<typeof settle>>;
    const response = second as Response;
    expect([settled.outcome === "paid", response.status === 201].filter(Boolean)).toHaveLength(1);
    await expect.poll(async () => (await messages(job.job_id)).some((m) => m.type === "prompt"), { timeout: 10_000 }).toBe(true);
    // Payers arriving after the winner move no money, whichever path they take.
    // A repeated mandate settlement reports the winner's payment and never pays again.
    expect(await settle()).toEqual(settled.outcome === "paid" ? { ...settled, replayed: true } : { outcome: "none" });
    expect((await signed("signed-late")).status).toBe(409);
    expect(await balancePayments(job.job_id)).toHaveLength(1);
    expect((await messages(job.job_id)).filter((m) => m.type === "payment" && m.from === "requester")).toHaveLength(1);
    expect((await ledger.get(creditId))?.availableMicro).toBe(ASK - 1 + 10_000 - ASK);
    expect((await ledger.listDrawsByJobId(job.job_id)).map((draw) => draw.amountMicro)).toEqual([ASK]);
  }, 30_000);
});
