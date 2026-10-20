import { randomUUID } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { signDeployAttestation, attestationEnv } from "../../../test-support/deploy-attestation";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { configureDVM } from "../../configure";
import { commitBalancePayment } from "../balance-payment";
import { CreditLedger } from "../credit-ledger";
import { createDVMHost } from "../host";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

const schema = `sdk_balance_http_${randomUUID().replaceAll("-", "")}`;
const key = Buffer.from("12".repeat(32), "hex");
const pubkey = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
const signer = createSignedRequestVerifier(z.object({}), { replayStore: null });
const attestation = signDeployAttestation({ builderSecret: "23".repeat(32),
  builderPubkey: Buffer.from(schnorr.getPublicKey(Buffer.from("23".repeat(32), "hex"))).toString("hex"),
  dvmId: "example-balance-service", slug: "balance-service", capabilities: ["run"], withReceiptKey: true });
const audience = { dvm_id: attestation.payload.dvm_id, builder_pubkey: attestation.identityPubkey };

describe.skipIf(!process.env.DATABASE_URL)("balance payments through production host wiring", () => {
  let pool: Pool;
  let ledger: CreditLedger;
  let completions = 0;
  const completionWorkers: number[] = [];
  const hosts: ReturnType<typeof createDVMHost>[] = [];
  beforeAll(async () => {
    await recreateSchema(schema);
    pool = await pinnedPool(schema);
    ledger = new CreditLedger(pool);
  });
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.shutdown();
  });
  afterAll(async () => {
    await pool?.end();
    await dropSchemas(schema);
  });

  async function server(outcome: "complete" | "fail" | "wait" | "twice" = "complete", enabled = true, reporting = false) {
    const host = createDVMHost({ pool, port: 0, env: { ...attestationEnv(attestation), ...(reporting && { DVMKIT_PLATFORM_URL: "http://127.0.0.1:1", DVMKIT_PLATFORM_TOKEN: "test-platform-token" }), ...(!enabled && { DVMKIT_BALANCE_PAYMENTS: "false" }) } });
    hosts.push(host);
    const worker = hosts.length;
    host.mount(configureDVM({ name: "balance-service", credit: {}, auth: secp256k1Auth(), capabilities: {
      run: { input: z.object({ action: z.string(), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() }), async onJob(ctx) {
        if (reporting) ctx.cost({ amount: 0.000002, currency: "usd" });
        await ctx.requestPayment({ amount: 0.001, currency: "usd" }, "one step");
        if (outcome === "twice") await ctx.requestPayment({ amount: 0.001, currency: "usd" }, "second step");
        if (outcome === "complete" || outcome === "twice") { completions++; completionWorkers.push(worker); ctx.complete("done"); }
        if (outcome === "fail") ctx.fail("work failed");
        if (outcome === "wait") await ctx.prompt("continue", "Continue?");
      } },
    } }));
    return (await host.serve()).url;
  }
  function post(url: string, body: unknown, token?: string) {
    return fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Job-Token": token } : {}) }, body: JSON.stringify(body) });
  }
  async function pending(url: string) {
    expect((await (await fetch(`${url}/v1/info`)).json()).auth_audience).toEqual(audience);
    const data = signer.signRequest(key, { action: "run" }, undefined, { audience, method: "POST", path: "/v1/job", capability: "run" });
    const created = await post(`${url}/v1/job`, { capability: "run", data });
    expect(created.status, await created.clone().text()).toBe(202);
    const job = await created.json();
    await expect.poll(async () => (await pool.query("SELECT pending_payment_fiat_micro FROM jobs WHERE id=$1", [job.job_id])).rows[0]?.pending_payment_fiat_micro).toBe("1000");
    const ask = (await pool.query("SELECT data FROM job_messages WHERE job_id=$1 AND data->>'type'='payment-request'", [job.job_id])).rows[0].data;
    expect(ask.content.credit).toEqual({ amount_micro: 1_000, currency: "usd" });
    return { ...job, ask };
  }
  async function fund(creditId: string) {
    await ledger.fund({ creditId, callerPubkey: pubkey, currency: "usd", amountMicro: 10_000,
      expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: 5_000 } });
  }
  function payment(job: { job_id: string; ask: { seq: number } }, creditId: string, drawId = `draw-${creditId}`) {
    return { type: "payment", content: { credit: signer.signRequest(key, { credit_id: creditId,
      draw_id: drawId, payment_id: `payment-${creditId}`, request_seq: job.ask.seq,
      amount_micro: 1_000, currency: "usd" }, undefined,
    { audience, method: "POST", path: `/v1/job/${job.job_id}/messages`, capability: null }) } };
  }

  it("negotiates support and completes a zero-upfront job using owner credit, with terminal replay", async () => {
    const url = await server();
    const receiver = await server();
    const before = completions;
    const info = await (await fetch(`${url}/v1/info`)).json();
    expect(info.credit.balance_payment).toBe(true);
    const job = await pending(url);
    await fund("complete-credit");
    const body = payment(job, "complete-credit");
    const path = `${url}/v1/job/${job.job_id}/messages`;
    expect((await post(path, body)).status).toBe(401);
    expect((await post(path, body, "wrong-token")).status).toBe(404);
    expect((await post(path, { ...body, content: { ...body.content, cashu_token: "fake" } }, job.job_token)).status).toBe(400);
    expect((await ledger.get("complete-credit"))?.availableMicro).toBe(10_000);
    const accepted = await post(`${receiver}/v1/job/${job.job_id}/messages`, body, job.job_token);
    expect(accepted.status).toBe(201);
    const original = await accepted.json();
    await expect.poll(async () => (await ledger.getDraw({ creditId: "complete-credit", drawId: "draw-complete-credit" }))?.status).toBe("settled");
    const restarted = await server();
    const replay = await post(`${restarted}/v1/job/${job.job_id}/messages`, body, job.job_token);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(original);
    expect((await ledger.get("complete-credit"))?.balanceMicro).toBe(9_000);
    await expect.poll(async () => (await pool.query("SELECT receipt FROM jobs WHERE id=$1", [job.job_id])).rows[0]?.receipt?.credit?.amount).toBe(1_000);
    expect(completions - before).toBe(1);
    expect(completionWorkers.at(-1)).toBe(1);
  }, 20_000);

  it("recovers an accepted payment after the worker stopped before saving progress or replying", async () => {
    const url = await server();
    const originalHost = hosts[hosts.length - 1];
    const job = await pending(url);
    await originalHost.shutdown();
    await fund("lost-response-credit");
    const body = payment(job, "lost-response-credit");
    const accepted = await commitBalancePayment({ pool, ledger, auth: secp256k1Auth(),
      domain: { audience, method: "POST", path: `/v1/job/${job.job_id}/messages`, capability: null },
      jobId: job.job_id, dvmId: audience.dvm_id, raw: body.content.credit });
    const recovered = await server();
    const replay = await post(`${recovered}/v1/job/${job.job_id}/messages`, body, job.job_token);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(accepted.response);
    await expect.poll(async () => (await ledger.getDraw({ creditId: "lost-response-credit", drawId: "draw-lost-response-credit" }))?.status).toBe("settled");
    expect((await ledger.get("lost-response-credit"))?.balanceMicro).toBe(9_000);
  }, 20_000);

  it.each([false, true])("keeps a later ask unpaid after a delayed real COMMIT acknowledgement (remote=%s)", async (remote) => {
    const url = await server("twice");
    let receiver = remote ? await server("twice") : url;
    const job = await pending(url);
    const creditId = `two-asks-${remote}`;
    await fund(creditId);
    const before = completions;
    const originals = new Map<PoolClient, PoolClient["query"]>();
    const delayCommit = (client: PoolClient) => {
      if (originals.has(client)) return;
      const query = client.query.bind(client);
      originals.set(client, query);
      let accepted = false;
      client.query = (async (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("INSERT INTO credit_balance_payments")) accepted = true;
        const result = await (query as (...args: unknown[]) => Promise<unknown>)(...args);
        if (args[0] === "COMMIT" && accepted) {
          accepted = false;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        return result;
      }) as typeof client.query;
    };
    pool.on("acquire", delayCommit);
    const body = payment(job, creditId);
    try {
      expect((await post(`${receiver}/v1/job/${job.job_id}/messages`, body, job.job_token)).status).toBe(201);
    } finally { pool.off("acquire", delayCommit); for (const [client, query] of originals) client.query = query; }
    await expect.poll(async () => (await pool.query("SELECT asked_topup_micro FROM jobs WHERE id=$1", [job.job_id])).rows[0]?.asked_topup_micro).toBe("2000");
    expect(completions).toBe(before);
    await expect.poll(async () => (await pool.query("SELECT status,pending_payment_fiat_micro FROM jobs WHERE id=$1", [job.job_id])).rows[0])
      .toEqual({ status: "awaiting-input", pending_payment_fiat_micro: "1000" });
    // The old authorization must not claim the next wait even after its worker stops.
    await hosts[0].shutdown();
    receiver = await server("twice");
    expect((await post(`${receiver}/v1/job/${job.job_id}/messages`, body, job.job_token)).status).toBe(201);
    expect(completions).toBe(before);
    expect((await pool.query("SELECT asked_topup_micro,status FROM jobs WHERE id=$1", [job.job_id])).rows[0])
      .toEqual({ asked_topup_micro: "2000", status: "awaiting-input" });
    const ask = (await pool.query("SELECT data FROM job_messages WHERE job_id=$1 AND data->>'type'='payment-request' ORDER BY seq DESC LIMIT 1", [job.job_id])).rows[0].data;
    const next = payment({ ...job, ask }, creditId);
    next.content.credit = signer.signRequest(key, { credit_id: creditId, draw_id: `draw-${creditId}`,
      payment_id: `second-${creditId}`, request_seq: ask.seq, amount_micro: 1000, currency: "usd" }, undefined,
      { audience, method: "POST", path: `/v1/job/${job.job_id}/messages`, capability: null });
    expect((await post(`${receiver}/v1/job/${job.job_id}/messages`, next, job.job_token)).status).toBe(201);
    await expect.poll(() => completions).toBe(before + 1);
    await expect.poll(async () => (await ledger.getDraw({ creditId, drawId: `draw-${creditId}` }))?.status).toBe("settled");
    expect((await ledger.get(creditId))?.balanceMicro).toBe(8000);
  }, 20_000);

  it.each(["payment", "response", "implicit"])("recovers a positive fiat draw with zero rail allocation through %s replay", async (resumeType) => {
    const url = await server();
    const original = hosts.at(-1)!;
    const job = await pending(url);
    await original.shutdown();
    const drawId = `draw-zero-${resumeType}`;
    const creditId = resumeType === "implicit" ? `imp:cashu:${drawId}` : `zero-${resumeType}`;
    await ledger.fund({ creditId, callerPubkey: pubkey, currency: "usd", amountMicro: 10_000,
      expiryMs: Date.now() + 86_400_000, basis: { rail: "cashu", paidMsats: 1 } });
    const body = payment(job, creditId, drawId);
    const accepted = await commitBalancePayment({ pool, ledger, auth: secp256k1Auth(),
      domain: { audience, method: "POST", path: `/v1/job/${job.job_id}/messages`, capability: null },
      jobId: job.job_id, dvmId: audience.dvm_id, raw: body.content.credit });
    expect((await ledger.getDraw({ creditId, drawId }))?.railValue.drawMsats).toBe(0);
    const before = completions;
    const recovered = await server("complete", true, true);
    const responses = await Promise.all(Array.from({ length: resumeType === "payment" ? 3 : 1 }, () =>
      post(`${recovered}/v1/job/${job.job_id}/messages`, resumeType !== "response" ? body :
        { type: "response", content: { prompt_id: "resume", text: "continue" } }, job.job_token)));
    for (const response of responses) {
      expect(response.status).toBe(201);
      if (resumeType !== "response") expect(await response.json()).toEqual(accepted.response);
    }
    await expect.poll(async () => (await ledger.getDraw({ creditId, drawId }))?.status).toBe("settled");
    expect(completions).toBe(before + 1);
    await expect.poll(async () => (await pool.query("SELECT receipt,paid_msats FROM jobs WHERE id=$1", [job.job_id])).rows[0])
      .toMatchObject({ receipt: { credit: { amount: 1000 } }, paid_msats: "0" });
    await expect.poll(async () => (await pool.query("SELECT payload FROM pending_dvm_reports WHERE kind='revenue' AND payload->>'jobId'=$1", [job.job_id])).rowCount).toBe(1);
    const reports = (await pool.query("SELECT kind,payload FROM pending_dvm_reports WHERE payload->>'jobId'=$1", [job.job_id])).rows;
    expect(reports.filter((report) => report.kind === "revenue")).toEqual([expect.objectContaining({ payload: expect.objectContaining({
      paidMsats: 0, creditId, drawId, drawAmountMicro: 1000, creditCurrency: "usd",
      cost: { amountMicro: 2, currency: "usd" },
    }) })]);
    expect(reports.filter((report) => report.kind === "cost")).toHaveLength(0);
    const replay = await post(`${recovered}/v1/job/${job.job_id}/messages`, body, job.job_token);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(accepted.response);
    expect((await pool.query("SELECT 1 FROM pending_dvm_reports WHERE kind='revenue' AND payload->>'jobId'=$1", [job.job_id])).rowCount).toBe(1);
    await hosts.at(-1)!.shutdown();
    await server("complete", true, true);
    // Boot recovery must not report a second copy of the cost carried by revenue.
    expect((await pool.query("SELECT 1 FROM pending_dvm_reports WHERE kind='cost' AND payload->>'jobId'=$1", [job.job_id])).rowCount).toBe(0);
    const terminal = (await pool.query("SELECT payload FROM pending_dvm_reports WHERE kind='job_terminal' AND payload->>'jobId'=$1", [job.job_id])).rows;
    expect(terminal).toEqual([expect.objectContaining({ payload: expect.objectContaining({ paid: true, outcome: "completed" }) })]);
  }, 20_000);

  it("withholds balance payments from in-memory development hosts", async () => {
    const host = createDVMHost({ devMode: true, port: 0, env: {} });
    hosts.push(host);
    host.mount(configureDVM({ name: "memory-example", capability: "run", credit: {},
      auth: secp256k1Auth(), onJob(ctx) { ctx.complete("done"); } }));
    const result = await host.serve();
    const info = await (await fetch(`${result.url}/v1/info`)).json();
    expect(info.credit.balance_payment).toBeUndefined();
  }, 20_000);

  it("can withhold advertisement and refuse spending during a rolling upgrade", async () => {
    const url = await server("complete", false);
    const info = await (await fetch(`${url}/v1/info`)).json();
    expect(info.credit.balance_payment).toBeUndefined();
    const job = await pending(url);
    await fund("rollout-credit");
    const response = await post(`${url}/v1/job/${job.job_id}/messages`, payment(job, "rollout-credit"), job.job_token);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "balance_payment_unavailable" });
    expect((await ledger.get("rollout-credit"))?.availableMicro).toBe(10_000);
  }, 20_000);

  it("releases the full balance hold on provider failure and caller cancellation", async () => {
    for (const outcome of ["fail", "wait"] as const) {
      const url = await server(outcome);
      const job = await pending(url);
      const creditId = `${outcome}-credit`;
      await fund(creditId);
      expect((await post(`${url}/v1/job/${job.job_id}/messages`, payment(job, creditId), job.job_token)).status).toBe(201);
      if (outcome === "wait") {
        await fetch(`${url}/v1/job/${job.job_id}`, { method: "DELETE", headers: { "X-Job-Token": job.job_token } });
      }
      await expect.poll(async () => (await ledger.getDraw({ creditId, drawId: `draw-${creditId}` }))?.status).toBe("released");
      expect((await ledger.get(creditId))?.availableMicro).toBe(10_000);
    }
  }, 20_000);
});
