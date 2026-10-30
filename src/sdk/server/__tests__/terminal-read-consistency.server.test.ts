import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { verifyReceipt, type JobReceipt } from "../../../lib/receipt";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { JobRecord } from "../job-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
class GatedStore extends MemoryJobStore {
  readonly entered = deferred();
  readonly gate = deferred();
  override async save(record: JobRecord): Promise<void> {
    if (record.status === "completed") {
      this.entered.resolve();
      await this.gate.promise;
    }
    await super.save(record);
  }
}
const schema = z.object({
  pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string(), action: z.string(),
});
const signer = createSignedRequestVerifier(schema);
const key = new Uint8Array(32).fill(7);
const caller = Buffer.from(schnorr.getPublicKey(key)).toString("hex");
const servers = servedApps();
const hosts: Awaited<ReturnType<typeof createDVMServer>>[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
});
interface Body { job_id: string; job_token: string; status: string; summary?: string; receipt?: JobReceipt }

describe("HTTP terminal read ordering", () => {
  it.each([
    { paid: false, cancel: false },
    { paid: true, cancel: false },
    { paid: true, cancel: true },
  ])("keeps the durable winner and receipt with paid=$paid, cancel=$cancel", async ({ paid, cancel }) => {
    const store = new GatedStore();
    const ledger = new MemoryCreditLedger();
    const finish = deferred();
    let executions = 0;
    if (paid) await ledger.fund({
      creditId: "example-credit", callerPubkey: caller, currency: "usd", amountMicro: 100_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "x402", paidMsats: 100_000, fundingRef: "example-funding" },
    });
    async function start() {
      const server = await createDVMServer(configureDVM({
        name: "terminal-read", ...(paid ? { auth: secp256k1Auth() } : {}),
        capabilities: { work: {
          ...(paid ? { input: schema, price: "$0.10" } : {}),
          async onJob(ctx) { executions++; await finish.promise; ctx.complete("delivered result"); },
        } },
      }), {
        env: {}, store: new MemoryKVStore(), jobStore: store, creditLedger: ledger, devMode: !paid,
        receiptKey: "11".repeat(32), dvmId: "example-dvm",
        fxFetcher: {
          fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
          supportedCurrencies: () => ["usd"],
        },
      });
      hosts.push(server);
      return servers.serve(server.app);
    }
    const owner = await start();
    const other = await start();
    try {
      const submitted = await fetch(`${owner}/v1/job`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capability: "work", ...(paid ? {
          data: signer.signRequest(key, { action: "go", credit_id: "example-credit", draw_id: "example-draw" }),
        } : { input: "hello" }) }),
      });
      expect(submitted.status).toBe(202);
      const job = await submitted.json() as Body;
      const headers = { "X-Job-Token": job.job_token };
      finish.resolve();
      await store.entered.promise;
      const stream = await fetch(`${owner}/v1/job/${job.job_id}/messages`, {
        headers: { ...headers, Accept: "text/event-stream" },
      });
      expect(await stream.text()).toContain('"type":"complete"');
      expect((await store.get(job.job_id))?.status).toBe("processing");
      if (paid) expect((await ledger.getDraw({ creditId: "example-credit", drawId: "example-draw" }))?.status).toBe("pending");

      const get = vi.spyOn(store, "get");
      const pending = fetch(`${owner}/v1/job/${job.job_id}`, { headers }).then(async response => {
        expect(response.status).toBe(200);
        return await response.json() as Body;
      });
      await vi.waitFor(() => expect(get).toHaveBeenCalledWith(job.job_id));
      // Let a premature response reach the caller while terminal save is still blocked.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (cancel) {
        expect((await fetch(`${other}/v1/job/${job.job_id}`, { method: "DELETE", headers })).status).toBe(200);
      }
      const pendingElsewhere = await (await fetch(`${other}/v1/job/${job.job_id}`, { headers })).json() as Body;
      expect(pendingElsewhere.status).toBe(cancel ? "cancelled" : "processing");
      if (!cancel) expect(pendingElsewhere.receipt).toBeUndefined();
      store.gate.resolve();
      const completed = await pending;
      expect(completed.status).toBe(cancel ? "cancelled" : "completed");
      expect(verifyReceipt(completed.receipt!)).toBe(true);
      expect(completed.receipt?.outcome).toBe(completed.status);
      if (!cancel) {
        expect(completed.summary).toBe("delivered result");
        expect(completed.receipt?.result_hash).toBe(createHash("sha256")
          .update('{"artifact_hashes":[],"summary":"delivered result"}').digest("hex"));
      } else {
        expect(completed).not.toHaveProperty("summary");
        expect(completed.receipt?.ended_by).toBe("caller");
      }
      const bytes = JSON.stringify(completed.receipt);
      for (const url of [other, owner, other]) {
        const repeated = await (await fetch(`${url}/v1/job/${job.job_id}`, { headers })).json() as Body;
        expect(repeated.status).toBe(completed.status);
        expect(JSON.stringify(repeated.receipt)).toBe(bytes);
      }
      expect(await store.claimReceiptSeq(job.job_id)).toBe(completed.receipt?.seq);
      if (paid) {
        expect(await ledger.getDraw({ creditId: "example-credit", drawId: "example-draw" })).toMatchObject({
          status: cancel ? "released" : "settled", amountMicro: 100_000, ledgerSeq: 1,
        });
        expect((await ledger.get("example-credit"))?.balanceMicro).toBe(cancel ? 100_000 : 0);
        expect(completed.receipt?.credit?.ledger_seq).toBe(1);
      }
      expect(executions).toBe(1);
    } finally {
      finish.resolve();
      store.gate.resolve();
    }
  });
});
