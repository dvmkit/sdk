import { randomUUID } from "node:crypto";

import { schnorr } from "@noble/curves/secp256k1.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import snapshotFailure from "../../../../protocol-fixtures/job-snapshot-unavailable.json";
import { encodePayment } from "../../../lib/x402/spec";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import type { JobRecord } from "../job-store";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const PRIVKEY = new Uint8Array(32).fill(9);
const CALLER = Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");
const signedSchema = z.object({
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(), action: z.string(),
});
const signer = createSignedRequestVerifier(signedSchema);
const TOPUP = 500_000;
const TOTAL = 600_000;

class SnapshotFaultStore extends PostgresJobStore {
  failures = 0;
  failedSnapshots = 0;
  failureStatus: JobRecord["status"] = "processing";

  override async save(record: JobRecord): Promise<void> {
    if (record.paidMsats === TOTAL && record.status === this.failureStatus && this.failures > 0) {
      this.failures--;
      this.failedSnapshots++;
      throw Object.assign(new Error("injected snapshot conflict after accounting"), {
        code: "23505", constraint: "idx_jobs_request_id_caller",
      });
    }
    await super.save(record);
  }
}

describe.skipIf(!RUN)("HTTP payment accounting survives a later snapshot failure", () => {
  const schema = `payment_snapshot_${randomUUID().replaceAll("-", "")}`;
  const servers = servedApps();
  let admin: pg.Pool;
  let pool: pg.Pool;
  let ledger: CreditLedger;
  let processed: PostgresProcessedPaymentStore;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: DATABASE_URL, options: `-c search_path=${schema}`, max: 16 });
    ledger = new CreditLedger(pool);
    await ledger.init();
    processed = new PostgresProcessedPaymentStore(pool);
    await processed.init();
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  it.each([
    { cold: false, failures: 2, status: 201, prompt: false },
    { cold: false, failures: Infinity, status: 503, prompt: false },
    { cold: true, failures: Infinity, status: 503, prompt: false },
    { cold: false, failures: 2, status: 201, prompt: true },
    { cold: false, failures: Infinity, status: 503, prompt: true },
  ])("recovers with cold=$cold, failures=$failures, prompt=$prompt", async ({ cold, failures, status, prompt }) => {
    const creditId = randomUUID();
    const drawId = randomUUID();
    const txHash = `0x${randomUUID().replaceAll("-", "")}`;
    const dvmId = "snapshot-payment-test";
    vi.mocked(verifyX402Payment).mockReset();
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true, amountMsats: TOPUP, amountUsdcMicro: TOPUP, txHash,
    } as Awaited<ReturnType<typeof verifyX402Payment>>);
    let paymentResumes = 0;
    let finish!: () => void;
    const finishWork = new Promise<void>(resolve => { finish = resolve; });
    const descriptor = configureDVM({
      name: "snapshot-payment-test", auth: secp256k1Auth(),
      capabilities: {
        metered: {
          input: signedSchema, price: "$0.10",
          async onJob(ctx) {
            const paid = ctx.requestPayment(TOPUP, "more work").then(() => { paymentResumes++; });
            await Promise.all([paid, ...(prompt ? [ctx.prompt("question", "Continue?")] : [])]);
            await finishWork;
            ctx.complete("done");
          },
          onResponse(ctx) { ctx.complete("done"); },
        },
      },
    });
    const store = new SnapshotFaultStore(pool);
    await store.init();
    await store.initStreaming();
    const stores = [store];
    const hosts: Awaited<ReturnType<typeof createDVMServer>>[] = [];
    async function host(jobStore: SnapshotFaultStore) {
      const instance = await createDVMServer(descriptor, {
        env: {}, store: new MemoryKVStore(), jobStore, creditLedger: ledger,
        processedPayments: processed, dvmId, receiptKey: "11".repeat(32),
        fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
        x402: { facilitator: "https://example.com/facilitator", network: "eip155:8453", payTo: "0x1111111111111111111111111111111111111111" },
      });
      hosts.push(instance);
      return { instance, url: await servers.serve(instance.app) };
    }
    try {
      await ledger.fund({ creditId, callerPubkey: CALLER, currency: "usd", amountMicro: 100_000,
        expiryMs: Date.now() + 86_400_000, basis: { rail: "x402", paidMsats: 100_000, fundingRef: "initial-funding" } });
      let { instance, url } = await host(store);
      const submit = await fetch(`${url}/v1/job`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "metered", data: signer.signRequest(PRIVKEY, { action: "go", credit_id: creditId, draw_id: drawId }) }),
      });
      expect(submit.status).toBe(202);
      const job = await submit.json() as { job_id: string; job_token: string };
      const headers = { "Content-Type": "application/json", "X-Job-Token": job.job_token };
      const messages = await fetch(`${url}/v1/job/${job.job_id}/messages`, { headers });
      const asked = await messages.json() as { messages: { type: string; content: { x402?: { nonce?: string } } }[] };
      const nonce = asked.messages.find(message => message.type === "payment-request")?.content.x402?.nonce;
      expect(nonce).toBeTruthy();
      let target = store;
      if (cold) {
        // Only the yield snapshot copies payment-request into jobs.messages;
        // appendOutgoing already commits the status and pending payment.
        await vi.waitFor(async () => {
          expect(await store.get(job.job_id)).toMatchObject({
            status: "awaiting-input", pendingPaymentMsats: TOPUP,
            messages: expect.arrayContaining([expect.objectContaining({ type: "payment-request" })]),
          });
        });
        // Stop the original worker's listeners. The later message lands on a
        // fresh manager with only the persisted snapshot and payment log.
        instance.jobManager.shutdown();
        await store.shutdownStreaming();
        await pool.query("UPDATE jobs SET status='processing' WHERE id=$1", [job.job_id]);
        target = new SnapshotFaultStore(pool);
        await target.initStreaming();
        stores.push(target);
        ({ instance, url } = await host(target));
      }
      if (prompt) {
        // Stop LISTEN delivery so the HTTP dispatch must reopen the remaining
        // prompt wait before resolving the accepted payment.
        await store.shutdownStreaming();
        target.failureStatus = "awaiting-input";
      }
      target.failures = failures;
      const payment = encodePayment({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: {
        signature: "0xdeadbeef", authorization: { from: "0xfrom", to: "0x1111111111111111111111111111111111111111",
          value: String(TOPUP), validAfter: "0", validBefore: "9999999999", nonce: nonce! },
      } });
      async function send(type: string, content: object) {
        return fetch(`${url}/v1/job/${job.job_id}/messages`, { method: "POST", headers, body: JSON.stringify({ type, content }) });
      }
      const paid = await send("payment", { x402_payment: payment });
      expect(paid.status).toBe(status);
      expect(verifyX402Payment).toHaveBeenCalledTimes(1);
      const response = await paid.json();
      if (status === 503) expect(response).toMatchObject({ ...snapshotFailure.body, job_id: job.job_id });
      expect(target.failedSnapshots).toBe(status === 503 ? 3 : 2);
      expect(await target.get(job.job_id)).toMatchObject({ paidMsats: TOTAL, creditId, drawId, pendingPaymentMsats: 0 });
      expect(await ledger.getDraw({ creditId, drawId })).toMatchObject({ amountMicro: TOTAL, status: "pending" });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: TOTAL, availableMicro: 0 });
      expect(await processed.get({ dvmId, rail: "x402", paymentId: txHash })).toMatchObject({ creditId, drawId, jobId: job.job_id });
      if (prompt) {
        expect(paymentResumes).toBe(status === 503 ? 0 : 1);
        const active = instance.jobManager.activeJobs.get(job.job_id);
        if (status === 503) expect(active?.pendingPayment).toBeTruthy();
        else expect(active?.pendingPayment).toBeNull();
        expect(active?.pendingPrompts.has("question")).toBe(true);
        expect((await target.get(job.job_id))?.status).toBe(status === 503 ? "processing" : "awaiting-input");
      }
      const counters = await pool.query("SELECT next_seq, seq FROM jobs WHERE id=$1", [job.job_id]);
      expect(counters.rows[0].next_seq).toBeGreaterThan(counters.rows[0].seq);

      target.failures = 0;
      if (!(prompt && status === 503)) {
        // Exhausted mixed waits recover through their outstanding prompt;
        // the other cases also exercise durable payment replay rejection.
        const replay = await send("payment", { x402_payment: payment });
        expect(replay.status).toBe(409);
        expect(await replay.json()).toMatchObject({ error: "replay_rejected" });
        expect(await ledger.getDraw({ creditId, drawId })).toMatchObject({ amountMicro: TOTAL });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: TOTAL });
      }
      if (cold) {
        expect((await send("response", { prompt_id: "resume", text: "resume accepted work" })).status).toBe(201);
      } else {
        if (prompt) expect((await send("response", { prompt_id: "question", text: "yes" })).status).toBe(201);
        finish();
      }
      await vi.waitFor(async () => {
        expect(await target.get(job.job_id)).toMatchObject({ status: "completed", paidMsats: TOTAL });
        expect(await ledger.getDraw({ creditId, drawId })).toMatchObject({ status: "settled", amountMicro: TOTAL });
      });
      expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 0 });
      if (prompt) expect(paymentResumes).toBe(1);
      if (prompt && status === 503) expect(verifyX402Payment).toHaveBeenCalledTimes(1);
      const funding = await pool.query("SELECT count(*)::int AS n FROM processed_payments WHERE dvm_id=$1 AND payment_id=$2", [dvmId, txHash]);
      expect(funding.rows[0].n).toBe(1);
    } finally {
      for (const instance of hosts) instance.jobManager.shutdown();
      await servers.closeAll();
      for (const item of stores) await item.shutdownStreaming();
    }
  });
});
