import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { UpfrontPayment } from "../../../lib/upfront-payment";

import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { expectJobIdentity, expectNoJobIdentity } from "./__helpers__/job-identity";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");
const upfrontFixture = JSON.parse(readFileSync(
  new URL("../../../../protocol-fixtures/upfront-payment-v1.json", import.meta.url), "utf8"
)) as { stored: UpfrontPayment; implicit: UpfrontPayment; free_response: { upfront_payment: UpfrontPayment } };

const schema = z
  .object({
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    signature: z.string().regex(/^[0-9a-f]{128}$/),
    timestamp: z.number().int(),
    nonce: z.string().min(8),
    action: z.string(),
  })
  .strict();
const signer = createSignedRequestVerifier(schema);
const PRIVKEY = new Uint8Array(32).fill(7);
const OTHER_PRIVKEY = new Uint8Array(32).fill(9);
const CALLER_PUBKEY = hex(schnorr.getPublicKey(PRIVKEY));
const PRICE_MSATS = 100_000;
const PRICE_MICRO = 100_000;
const TX_HASH = `0x${"ab".repeat(32)}`;
const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
const X402_HEADER = encodePayment({
  x402Version: X402_V1_VERSION,
  scheme: "exact",
  network: X402.network,
  payload: {
    signature: `0x${"cd".repeat(32)}`,
    authorization: {
      from: "0x2222222222222222222222222222222222222222",
      to: X402.payTo,
      value: String(PRICE_MICRO),
      validAfter: "0",
      validBefore: "99999999999",
      nonce: `0x${"ef".repeat(32)}`,
    },
  },
});
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date(0).toISOString() }),
  supportedCurrencies: () => ["usd"],
};

const servers = servedApps();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: PRICE_MSATS,
    amountUsdcMicro: PRICE_MICRO,
    txHash: TX_HASH,
    settleResponseHeader: "settled",
  });
});

describe("public request recovery", () => {
  it("distinguishes an accepted free job from historical missing evidence", async () => {
    const h = await startServer({ free: true });
    const requestId = "free-or-unknown";
    const body = () => requestBody(requestId, "go");
    const accepted = await submit(h.url, body());
    const original = await accepted.json() as { job_id: string; job_token?: string; upfront_payment?: UpfrontPayment };
    expect(accepted.status).toBe(200);
    expect(original.upfront_payment).toEqual(upfrontFixture.free_response.upfront_payment);
    expect(await (await lookup(h.url, requestId, body())).json()).toMatchObject({ upfront_payment: { amount_msats: 0 } });

    // A historical job has no acceptance snapshot even when its payment total
    // happens to be zero. Recovery must not manufacture evidence from totals.
    const record = await h.jobStore.get(original.job_id);
    if (!record) throw new Error("accepted job missing");
    await h.jobStore.delete(original.job_id);
    await h.jobStore.save({ ...record, upfrontPayment: undefined });
    const historical = await lookup(h.url, requestId, body());
    expect(historical.status).toBe(200);
    expect(await historical.json()).not.toHaveProperty("upfront_payment");
  });

  it.each(["stored", "implicit"] as const)("keeps the %s upfront hold on active recovery, resume and later payment", async (kind) => {
    let rate = 100_000;
    const ledger = new MemoryCreditLedger();
    const h = await startServer({ ledger, x402: true, fxFetcher: {
      fetch: () => Promise.resolve({ rates: { usd: rate }, as_of: new Date().toISOString() }),
      supportedCurrencies: () => ["usd"],
    } });
    if (kind === "stored") {
      await ledger.fund({
        creditId: "stored-credit", callerPubkey: CALLER_PUBKEY, currency: "usd",
        amountMicro: 100_000, expiryMs: Date.now() + 60_000,
        basis: { rail: "x402", paidMsats: 150_000, nativeAmount: 100_000, nativeAsset: "usdc" },
      });
    }
    const requestId = `${kind}-active-payment`;
    const creditId = kind === "stored" ? "stored-credit" : `imp:x402:${TX_HASH}`;
    const drawId = kind === "stored" ? "stored-draw" : TX_HASH;
    const body = () => requestBody(requestId, "metered", PRIVKEY,
      kind === "stored" ? { credit_id: creditId, draw_id: drawId } : {});
    const accepted = await submit(h.url, body(), kind === "implicit" ? { "X-PAYMENT": X402_HEADER } : {});
    const original = await accepted.json() as { job_id: string; job_token?: string; upfront_payment?: UpfrontPayment };
    const expected = upfrontFixture[kind];
    expect(accepted.status).toBe(202);
    expect(original.upfront_payment).toEqual(expected);
    expect((await ledger.getDraw({ creditId, drawId }))?.status).toBe("pending");

    rate = 200_000;
    for (const recover of [lookup, resume]) {
      const response = await recover(h.url, requestId, body());
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ job_id: original.job_id, upfront_payment: expected });
    }
    expect((await ledger.get(creditId))?.lastLedgerSeq).toBe(1);
    expect(h.handled()).toBe(1);
    expect(verifyX402Payment).toHaveBeenCalledTimes(kind === "implicit" ? 1 : 0);

    const jobHeaders = { "X-Job-Token": original.job_token! };
    const messages = await (await fetch(`${h.url}/v1/job/${original.job_id}/messages`, { headers: jobHeaders })).json() as {
      messages: { type: string; content: { x402?: { nonce?: string } } }[];
    };
    const nonce = messages.messages.find((m) => m.type === "payment-request")?.content.x402?.nonce;
    expect(nonce).toBeDefined();
    vi.mocked(verifyX402Payment).mockResolvedValue({
      verified: true, amountMsats: 500_000, amountUsdcMicro: 500_000, txHash: `0x${"dc".repeat(32)}`,
    });
    const payment = encodePayment({
      x402Version: X402_V1_VERSION, scheme: "exact", network: X402.network,
      payload: { signature: `0x${"cd".repeat(32)}`, authorization: {
        from: "0x2222222222222222222222222222222222222222", to: X402.payTo,
        value: "500000", validAfter: "0", validBefore: "99999999999", nonce: nonce!,
      } },
    });
    const paid = await fetch(`${h.url}/v1/job/${original.job_id}/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", ...jobHeaders },
      body: JSON.stringify({ type: "payment", content: { x402_payment: payment } }),
    });
    expect(paid.status).toBe(201);
    await vi.waitFor(async () => expect((await h.jobStore.get(original.job_id))?.status).toBe("completed"));
    expect((await ledger.getDraw({ creditId, drawId }))?.amountMicro).toBe(600_000);
    const recovered = await lookup(h.url, requestId, body());
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ upfront_payment: expected });
    expect((await h.jobStore.get(original.job_id))?.paidMsats).toBeGreaterThan(expected.amount_msats);
    expect(h.handled()).toBe(1);
  });

  it("recovers a lost x402 response read-only and refuses caller/body mismatches without a token", async () => {
    const h = await startServer({ x402: true });
    const requestId = "x402-lost-response";
    const original = requestBody(requestId, "go");

    const info = (await (await fetch(`${h.url}/v1/info`)).json()) as Record<string, unknown>;
    expect(info.request_recovery).toBe(true);

    const probe = await submit(h.url, original);
    expect(probe.status).toBe(402);
    expectNoJobIdentity(probe);
    expect(verifyX402Payment).not.toHaveBeenCalled();

    const accepted = await submit(h.url, original, { "X-PAYMENT": X402_HEADER });
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(accepted.status).toBe(200);
    expect(acceptedBody.upfront_payment).toMatchObject({ amount_msats: 100_000, amount_micro: 100_000, currency: "usd" });
    expect(acceptedBody.job_id).toEqual(expect.any(String));
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(h.handled()).toBe(1);

    // Signed callers normally need no job token. Seed one deliberately to pin
    // the stronger recovery invariant: it crosses the lookup boundary only
    // after the caller and full request fingerprint have both matched.
    const acceptedRecord = await h.jobStore.get(String(acceptedBody.job_id));
    if (!acceptedRecord) throw new Error("expected the accepted job to be durable");
    await h.jobStore.save({ ...acceptedRecord, requesterToken: "sensitive-job-token" });
    const writesBeforeLookup = h.saveSpy.mock.calls.length;

    const fresh = requestBody(requestId, "go");
    const recovered = await lookup(h.url, requestId, fresh);
    const recoveredBody = (await recovered.json()) as Record<string, unknown>;
    expect(recovered.status).toBe(200);
    expectJobIdentity(recovered, recoveredBody);
    expect(recoveredBody).toMatchObject({
      request_id: requestId,
      job_id: acceptedBody.job_id,
      job_token: "sensitive-job-token",
      status: "completed",
      transaction_hash: TX_HASH,
      upfront_payment: acceptedBody.upfront_payment,
    });
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(h.handled()).toBe(1);
    expect(h.saveSpy).toHaveBeenCalledTimes(writesBeforeLookup);

    const serialized = JSON.stringify(recoveredBody);
    expect(serialized).not.toContain(String((original.data as Record<string, unknown>).signature));
    expect(serialized).not.toContain(X402_HEADER);
    expect(serialized).not.toContain("cashu_token");
    expect(serialized).not.toContain("tempo_credential");
    expect(serialized).not.toContain("Bearer ");

    const duplicate = await submit(h.url, requestBody(requestId, "go"));
    expect(duplicate.status).toBe(409);
    expectNoJobIdentity(duplicate);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(h.handled()).toBe(1);

    for (const mismatch of [
      requestBody(requestId, "different"),
      requestBody(requestId, "go", OTHER_PRIVKEY),
      requestBody("another-id", "go"),
    ]) {
      const refused = await lookup(h.url, requestId, mismatch);
      const refusedBody = (await refused.json()) as Record<string, unknown>;
      expect(refused.status).toBe(404);
      expectNoJobIdentity(refused);
      expect(refusedBody).toMatchObject({ error: "request_not_found", status: "unknown" });
      expect(refusedBody).not.toHaveProperty("job_id");
      expect(refusedBody).not.toHaveProperty("job_token");
      expect(refusedBody).not.toHaveProperty("receipt");
    }

    const tampered = requestBody(requestId, "go");
    tampered.data.request_id = "tampered-after-signing";
    const unsignedTamper = await lookup(h.url, requestId, tampered);
    const unsignedTamperBody = (await unsignedTamper.json()) as Record<string, unknown>;
    expect(unsignedTamper.status).toBe(401);
    expect(unsignedTamperBody).not.toHaveProperty("job_id");
    expect(unsignedTamperBody).not.toHaveProperty("job_token");

    const missing = await lookup(h.url, "missing-id", requestBody("missing-id", "go"));
    expect(missing.status).toBe(404);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);
    expect(h.handled()).toBe(1);
    expect(h.saveSpy).toHaveBeenCalledTimes(writesBeforeLookup);
  });

  it("recovers a prepaid draw without a second debit, handler run, or store write", async () => {
    const ledger = new MemoryCreditLedger();
    const h = await startServer({ ledger });
    const requestId = "prepaid-draw-lost-response";
    await fundCredit(ledger, {
      creditId: "credit-1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: Date.now() + 60_000,
    });
    const body = requestBody(requestId, "go", PRIVKEY, {
      credit_id: "credit-1",
      draw_id: requestId,
    });

    const accepted = await submit(h.url, body);
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(accepted.status).toBe(200);
    const afterSubmit = await ledger.get("credit-1");
    expect(afterSubmit?.lastLedgerSeq).toBe(1);
    expect(afterSubmit?.balanceMicro).toBe(1_000_000 - PRICE_MICRO);
    const writesBeforeLookup = h.saveSpy.mock.calls.length;

    for (let i = 0; i < 2; i += 1) {
      const recovered = await lookup(
        h.url,
        requestId,
        requestBody(requestId, "go", PRIVKEY, {
          credit_id: "credit-1",
          draw_id: requestId,
        })
      );
      const recoveredBody = (await recovered.json()) as Record<string, unknown>;
      expect(recoveredBody.job_id).toBe(acceptedBody.job_id);
      expect(recoveredBody.job_token).toBe(acceptedBody.job_token);
    }

    const afterLookup = await ledger.get("credit-1");
    expect(afterLookup).toMatchObject({
      lastLedgerSeq: 1,
      balanceMicro: 1_000_000 - PRICE_MICRO,
    });
    expect(h.handled()).toBe(1);
    expect(h.saveSpy).toHaveBeenCalledTimes(writesBeforeLookup);
    expect(verifyX402Payment).not.toHaveBeenCalled();
  });
});

describe("job identity on recovery responses", () => {
  it("states the job identity on a request-result 202 for a job still running", async () => {
    const h = await startServer({ x402: true });
    const requestId = "x402-still-running";
    const accepted = await submit(h.url, requestBody(requestId, "hold"), { "X-PAYMENT": X402_HEADER });
    expect(accepted.status).toBe(202);

    const recovered = await lookup(h.url, requestId, requestBody(requestId, "hold"));
    const body = (await recovered.json()) as Record<string, unknown>;
    expect(recovered.status).toBe(202);
    expect(body.status).toBe("processing");
    expectJobIdentity(recovered, body);
  });

  it("states the job identity on a request-resume of an accepted request, and not on a refusal", async () => {
    const h = await startServer({ x402: true });
    const requestId = "x402-resume";
    const accepted = await submit(h.url, requestBody(requestId, "go"), { "X-PAYMENT": X402_HEADER });
    const acceptedBody = (await accepted.json()) as Record<string, unknown>;
    expect(accepted.status).toBe(200);

    const resumed = await resume(h.url, requestId, requestBody(requestId, "go"));
    const body = (await resumed.json()) as Record<string, unknown>;
    expect(resumed.status).toBe(200);
    expect(body.job_id).toBe(acceptedBody.job_id);
    expectJobIdentity(resumed, body);
    expect(verifyX402Payment).toHaveBeenCalledTimes(1);

    const refused = await resume(h.url, "never-accepted", requestBody("never-accepted", "go"));
    expect(refused.status).toBe(409);
    expectNoJobIdentity(refused);
  });
});

async function startServer(opts: { x402?: boolean; ledger?: MemoryCreditLedger; fxFetcher?: FxFetcher; free?: boolean }): Promise<{
  url: string;
  jobStore: MemoryJobStore;
  saveSpy: ReturnType<typeof vi.spyOn>;
  handled: () => number;
}> {
  let handled = 0;
  const jobStore = new MemoryJobStore();
  const saveSpy = vi.spyOn(jobStore, "save");
  const dvm = configureDVM({
    name: "request-recovery-test",
    capabilities: {
      run: {
        input: schema,
        ...(opts.free
          ? { onQuote: { schema: z.object({ action: z.string() }), handler: async () => ({ upfront: { amount: 0, currency: "usd" as const }, description: "No upfront charge" }) } }
          : { price: "$0.10" }),
        async onJob(ctx) {
          handled += 1;
          if ((ctx.input as { action?: string }).action === "metered") {
            await ctx.requestPayment(500_000, "additional work");
          }
          // "hold" leaves the job running so recovery reads see a non-terminal job.
          if ((ctx.input as { action?: string }).action !== "hold") ctx.complete("done");
        },
      },
    },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore,
    fxFetcher: opts.fxFetcher ?? stubFx,
    receiptKey: "11".repeat(32),
    ...(opts.x402 ? { x402: X402 } : {}),
    ...(opts.ledger ? { creditLedger: opts.ledger } : {}),
  });
  const url = await servers.serve(app);
  return { url, jobStore, saveSpy, handled: () => handled };
}

function requestBody(
  requestId: string,
  action: string,
  privkey: Uint8Array = PRIVKEY,
  extra: Record<string, unknown> = {}
): { capability: string; data: Record<string, unknown> } {
  return {
    capability: "run",
    data: signer.signRequest(privkey, {
      action,
      request_id: requestId,
      ...extra,
    }) as unknown as Record<string, unknown>,
  };
}

function submit(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function resume(url: string, requestId: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/request-resume/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function lookup(url: string, requestId: string, body: unknown): Promise<Response> {
  return fetch(`${url}/v1/request-result/${requestId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
