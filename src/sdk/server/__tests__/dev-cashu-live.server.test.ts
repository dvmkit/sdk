import { randomUUID } from "node:crypto";
import { Amount, getEncodedToken, Wallet } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { configureDVM } from "../../configure";
import { verifyReceipt, type JobReceipt } from "../../../lib/receipt";
import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { serve } from "../serve";
import type { PaidJobCompletion } from "../payment-mode";

const live = await localMintAvailable();

describe.skipIf(!live)("real disposable Cashu host", () => {
  it("requires real payment, signs its receipt, rejects forged proofs/reuse and rotates identity", async () => {
    const events: PaidJobCompletion[] = [];
    const descriptor = configureDVM({ name: "dev-paid", capability: "test", tag: "test",
      price: "$0.016", onJob(ctx) { ctx.complete("paid"); } });
    const options = { devMode: true, port: 0, env: {}, mints: [LOCAL_MINT_URL],
      fx: { fetch: async () => ({ rates: { usd: 100000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] },
      onPaidJobCompleted: (event: PaidJobCompletion) => { events.push(event); } };
    let running = await serve(descriptor, options);
    try {
      expect(running.paymentModes[0]?.rails.cashu).toEqual({ status: "verifying", testFunds: true });
      const info = await (await fetch(`${running.url}/v1/info`)).json() as { cashu: { lock_pubkeys: string[]; canonical_id: string } };
      const submit = (token?: string, requestId = randomUUID()) => fetch(`${running.url}/v1/job`, {
        method: "POST", headers: { "Content-Type": "application/json", ...(token ? { "X-Cashu": token, "X-Cashu-Request-Id": requestId } : {}) },
        body: JSON.stringify({ capability: "test" }),
      });
      expect((await submit()).status).toBe(402);
      const wallet = new Wallet(LOCAL_MINT_URL);
      await wallet.loadMint();
      const quote = await wallet.createMintQuoteBolt11(64);
      let paid = await wallet.checkMintQuoteBolt11(quote.quote);
      for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        paid = await wallet.checkMintQuoteBolt11(quote.quote);
      }
      const minted = await wallet.mintProofsBolt11(64, paid);
      // Same prepare/complete/encode path as the published caller. DLEQ must survive it.
      const preview = await wallet.ops.send(16, minted).asP2PK({ pubkey: info.cashu.lock_pubkeys[0]! }).includeFees(true).prepare();
      const swapped = await wallet.completeSwap(preview);
      expect(swapped.send.every((proof) => proof.dleq)).toBe(true);
      const token = getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send });
      const forged = getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send.map((proof) => ({ ...proof, amount: Amount.from(32) })) });
      expect((await submit(forged)).status).toBe(402);
      const responses = await Promise.all([submit(token), submit(token)]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const response = responses.find((item) => item.status === 200)!;
      const body = await response.json() as { job_id: string; receipt: JobReceipt };
      expect(body.receipt.outcome).toBe("completed");
      expect(verifyReceipt(body.receipt)).toBe(true);
      expect(body.receipt.paid.rail).toBe("cashu");
      expect(events).toContainEqual({ jobId: body.job_id, rail: "cashu", amountMicro: 16000, currency: "usd", testFunds: true });
      expect((await submit(token)).status).toBe(409);
      await running.close();
      running = await serve(descriptor, options);
      const next = await (await fetch(`${running.url}/v1/info`)).json() as typeof info;
      expect(next.cashu.lock_pubkeys).not.toEqual(info.cashu.lock_pubkeys);
      expect(next.cashu.canonical_id).not.toEqual(info.cashu.canonical_id);
      let restarted = await submit(token);
      for (let n = 0; restarted.status === 503 && n < 100; n++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        restarted = await submit(token);
      }
      expect(restarted.status).toBe(402);
    } finally { await running.close(); }
  }, 30000);
  it("refuses a lock whose refund path opens too soon, on the wire with its copy", async () => {
    const descriptor = configureDVM({ name: "dev-lock", capability: "test", tag: "test",
      price: "$0.016", onJob(ctx) { ctx.complete("paid"); } });
    const running = await serve(descriptor, { devMode: true, port: 0, env: {}, mints: [LOCAL_MINT_URL],
      fx: { fetch: async () => ({ rates: { usd: 100000 }, as_of: new Date().toISOString() }), supportedCurrencies: () => ["usd"] } });
    try {
      const info = await (await fetch(`${running.url}/v1/info`)).json() as { cashu: { lock_pubkeys: string[]; min_locktime: number } };
      expect(info.cashu.min_locktime).toBe(604800);
      const wallet = new Wallet(LOCAL_MINT_URL);
      await wallet.loadMint();
      const quote = await wallet.createMintQuoteBolt11(32);
      let paid = await wallet.checkMintQuoteBolt11(quote.quote);
      for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        paid = await wallet.checkMintQuoteBolt11(quote.quote);
      }
      const minted = await wallet.mintProofsBolt11(32, paid);
      const preview = await wallet.ops.send(16, minted).asP2PK({
        pubkey: info.cashu.lock_pubkeys[0]!,
        locktime: Math.floor(Date.now() / 1000) + 3600,
        refundKeys: ["02" + "ef".repeat(32)],
      }).includeFees(true).prepare();
      const swapped = await wallet.completeSwap(preview);
      const response = await fetch(`${running.url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cashu": getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send }), "X-Cashu-Request-Id": randomUUID() },
        body: JSON.stringify({ capability: "test" }),
      });
      expect(response.status).toBe(402);
      const body = await response.json() as { error: string; display: string; hint: string; retryable: boolean };
      expect(body).toMatchObject({ error: "lock_not_exclusive", retryable: false });
      // The payer must learn which lock is accepted: the first advertised key, refund no sooner than the floor.
      expect(body.display).toContain("Nothing was charged");
      expect(body.hint).toContain("cashu.lock_pubkeys[0]");
      expect(body.hint).toContain("cashu.min_locktime minus 24 hours");
    } finally { await running.close(); }
  }, 30000);
});
