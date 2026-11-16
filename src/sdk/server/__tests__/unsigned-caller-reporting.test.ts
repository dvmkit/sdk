import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import unsignedReports from "../../../../protocol-fixtures/unsigned-caller-reports-v1.json";
import { verifyReceipt } from "../../../lib/receipt";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MintHealthTracker } from "../mint-health-tracker";
import { MemoryJobStore } from "../memory-job-store";
import { RevenueReporter } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { durableLedger } from "./__helpers__/credit-fixtures";

vi.mock("../../../lib/cashu/verify", async (original) => ({ ...await original<typeof import("../../../lib/cashu/verify")>(), verifyCashuToken: vi.fn() }));
vi.mock("../wallet-accumulator-receive", () => ({ acceptAccumulatorPayment: vi.fn() }));
const { verifyCashuToken } = await import("../../../lib/cashu/verify");
const { acceptAccumulatorPayment } = await import("../wallet-accumulator-receive");
const MINT = "https://mint.example.com";

afterEach(() => vi.unstubAllGlobals());

describe("unsigned paid job reporting", () => {
  it.each([false, true])("stores and reports no caller through upfront and mid-job funding (devMode=%s)", async (devMode) => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_000_000_000);
    const cashu = { ledger: new MemoryCreditLedger(), accumulator: createDisposableCashuStore().accumulator };
    vi.mocked(verifyCashuToken).mockReturnValue({ mint: MINT, totalMsats: 100_000, unit: "sat" });
    vi.mocked(acceptAccumulatorPayment).mockImplementation(async (opts) => {
      const accepted = { requestId: opts.requestId!, mintUrl: MINT,
        grossMsats: 100_000, netMsats: 100_000, paidMsats: 100_000, inputFeeMsats: 0 };
      await opts.beforeCommit?.(accepted);
      await opts.withDisposableLedger?.(cashu.ledger, accepted);
      return { kind: "accumulated", ...accepted };
    });
    // Cashu acceptance and the reporter's external SQL/HTTP transports are replaced.
    // Credit allocation, job completion and receipt signing use production code.
    const pending: { id: string; payload: object; kind: string; retry_count: number; created_at: string }[] = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("INSERT INTO pending_dvm_reports")) {
        pending.push({ id: params[0] as string, payload: JSON.parse(params[1] as string),
          kind: params[3] as string, retry_count: 0, created_at: String(params[2]) });
      }
      if (sql.startsWith("DELETE FROM")) pending.splice(pending.findIndex((row) => row.id === params[0]), 1);
      return { rows: sql.startsWith("SELECT id, payload") ? [...pending] : [], rowCount: 1 };
    });
    const db = { query } as unknown as Pool;
    const reporter = new RevenueReporter(db, "https://platform.example.com", "test-token");
    const outbound: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      outbound.push({ url, body: JSON.parse(init.body as string) });
      return new Response(null, { status: 204 });
    }));
    const descriptor = configureDVM({ name: "unsigned-reports", capability: "work",
      input: z.object({ text: z.string(), pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() }), price: "$0.10",
      credit: { min: "$0.10", max: "$5.00" }, auth: secp256k1Auth({ allowUnsignedPaid: true }),
      async onJob(ctx) {
        await ctx.requestPayment(100_000, "second piece");
        ctx.complete("done");
      },
    });
    const mintHealthTracker = new MintHealthTracker({ mints: [] });
    await mintHealthTracker.runOnce();
    const host = await createDVMServer(descriptor, {
      env: {}, mintHealthTracker, store: new MemoryKVStore(), jobStore: new MemoryJobStore(), devMode,
      creditLedger: durableLedger({ ledger: cashu.ledger }), disposableCashu: cashu.accumulator,
      cashuMode: "p2pk-accumulator", lockPubkey: `02${"11".repeat(32)}`, mints: [MINT],
      receiptKey: "12".repeat(32), dvmId: "test-dvm",
      fxFetcher: { fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
        supportedCurrencies: () => ["usd"] },
      onCreditFunded: (payload) => reporter.enqueueDeposit(db, payload),
      onJobCompleted: (payload) => reporter.report(payload),
    });
    try {
      const submitted = await host.app.request("/v1/job", { method: "POST",
        headers: { "Content-Type": "application/json", "X-Cashu": "test-token", "X-Cashu-Request-Id": "upfront" },
        body: JSON.stringify({ capability: "work", data: { text: "hello" } }),
      });
      expect(submitted.status, await submitted.clone().text()).toBe(202);
      const job = await submitted.json() as { job_id: string; job_token: string };
      const headers = { "Content-Type": "application/json", "X-Job-Token": job.job_token };
      await vi.waitFor(async () => {
        const response = await host.app.request(`/v1/job/${job.job_id}/messages`, { headers });
        const body = await response.json() as { messages: { type: string }[] };
        expect(body.messages.some((message) => message.type === "payment-request")).toBe(true);
      });
      const paid = await host.app.request(`/v1/job/${job.job_id}/messages`, { method: "POST", headers,
        body: JSON.stringify({ type: "payment", content: { cashu_token: "test-topup", cashu_request_id: "midjob" } }),
      });
      expect(paid.status).toBe(201);
      expect(await paid.json()).not.toHaveProperty("draw_funding_receipt");
      const finished = await vi.waitFor(async () => {
        const response = await host.app.request(`/v1/job/${job.job_id}`, { headers });
        const body = await response.json();
        expect(body.status).toBe("completed");
        expect(body.receipt).toBeDefined();
        return body;
      });
      expect(verifyReceipt(finished.receipt)).toBe(true);
      expect(finished.receipt.requester_pubkey).toBeNull();
      expect(finished.draw_funding_receipts).toBeUndefined();
      await vi.waitFor(() => expect(outbound.some((row) => row.url.endsWith("/job-revenue"))).toBe(true));
      await reporter.drainPending();
      const deposits = outbound.filter((row) => row.url.endsWith("/credit-deposit"));
      expect(deposits).toHaveLength(2);
      expect(deposits[0].body).toMatchObject(unsignedReports.deposit.body);
      for (const { body } of deposits) {
        expect(body.callerPubkey).toBeNull();
        const credit = await cashu.ledger.get(body.creditId as string);
        expect(credit?.callerPubkey).toBeNull();
      }
      const revenues = outbound.filter((row) => row.url.endsWith("/job-revenue"));
      expect(revenues).toHaveLength(1);
      expect(revenues[0].body).toMatchObject({ drawAmountMicro: 200_000, jobId: job.job_id });
      for (const { body } of outbound) {
        expect(body.callerPubkey == null || /^[0-9a-f]{64}$/i.test(String(body.callerPubkey))).toBe(true);
        expect(JSON.stringify(body)).not.toMatch(/(?:dev-)?anonymous/);
      }
      const draw = await cashu.ledger.getDrawByJobId(job.job_id);
      expect(draw).toMatchObject({ status: "settled", amountMicro: 200_000 });
      const funding = await cashu.ledger.getFunding({ creditId: draw!.creditId, fundId: "midjob" });
      expect(funding?.callerPubkey).toBeNull();
    } finally {
      await host.shutdown();
    }
  });
});
