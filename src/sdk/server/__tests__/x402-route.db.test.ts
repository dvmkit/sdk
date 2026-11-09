/* POST /v1/x402/<capability> answers a stock x402 client's paid request in the same response. */
import { readFileSync } from "node:fs";

import { extractDiscoveryInfo, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { Hono } from "hono";
import type { Pool } from "pg";
import { encodeEventTopics, encodeFunctionData, type Hex, parseAbi, parseAbiItem } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { X402_PAYMENT_REQUIRED_MAX_BYTES, X402_SIZE_CHECK_ERROR } from "../../../lib/x402/bazaar";
import { x402NetworkByCaip2 } from "../../../lib/x402/networks";
import { diagnosticConsole } from "../../../observability/diagnostic-console";
import { decodePaymentRequiredHeader, encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { dropSchemas, pinnedPool, recreateSchema } from "../../../test-support/schema-isolation";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import type { SDKJobContext, X402Listing } from "../../types";
import { createDVMServer } from "../app";
import { CreditLedger } from "../credit-ledger";
import { PostgresJobStore } from "../postgres-job-store";
import { PostgresProcessedPaymentStore } from "../processed-payment-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { PostgresX402ExactSettlementStore, type X402ExactSettlementIntent } from "../x402-exact-settlement-store";
import { SETTLE_WINDOW_CLOSED_REASON, X402_ROUTE_COPY } from "../x402-route";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/x402-route-v1.json", import.meta.url), "utf8")
) as Record<string, { status: number; body: Record<string, unknown>; requiredFields: string[]; omittedFields: string[] }> & {
  identityHeader: string;
};
const DATABASE_URL = process.env.DATABASE_URL;
const RUN = !!DATABASE_URL && /\/dvmkit_test(_[0-9a-f]{8})?(\?|$)/.test(DATABASE_URL);
const SCHEMA = "x402_route_test";
const DVM_ID = "x402-route-test";
const PRICE_MICRO = 16_000;
const TRANSACTION = `0x${"77".repeat(32)}`;
const X402: X402Config = {
  facilitator: "https://facilitator.example.com",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};
const EXAMPLE = { url: "https://example.com" };
const LISTING: X402Listing = { description: "Fetch one page.", example: EXAMPLE, tags: ["web"] };

/** The JSON body the server posts to the facilitator's `/verify` or `/settle`. */
interface FacilitatorRequest {
  paymentPayload: Record<string, unknown>;
  paymentRequirements: { resource: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Behaviour = (ctx: SDKJobContext<any, unknown>) => Promise<void>;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((open) => { resolve = open; });
  return { promise, resolve };
}

/** `validFor` is seconds from now, or the exact `validBefore` to sign. */
function authorization(validFor: number | string, nonce = "33", amount = PRICE_MICRO): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: X402.network,
    payload: {
      signature: `0x${"ab".repeat(65)}`,
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: X402.payTo,
        value: String(amount),
        validAfter: "0",
        validBefore: typeof validFor === "string" ? validFor : String(Math.floor(Date.now() / 1000) + validFor),
        nonce: `0x${nonce.repeat(32)}`,
      },
    },
  });
}

/** A chain RPC that is at block 100 and answers nothing else. */
function chainRpcAnswer(body: unknown): Response {
  const parsed = JSON.parse(typeof body === "string" ? body : "{}") as { id?: number; method?: string } | { id?: number; method?: string }[];
  const answer = (call: { id?: number; method?: string }) =>
    call.method === "eth_blockNumber"
      ? { jsonrpc: "2.0", id: call.id, result: "0x64" }
      : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `${call.method} is not answered in this test` } };
  return Response.json(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed));
}

const AUTHORIZATION_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");
const TRANSFER_WITH_AUTHORIZATION = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
]);
const BLOCK_HASH = `0x${"88".repeat(32)}`;

/** A chain RPC at block 100 whose one transaction there settled `intent`, as recovery reads it. */
function chainSettledAnswer(body: unknown, intent: X402ExactSettlementIntent): Response {
  const parsed = JSON.parse(typeof body === "string" ? body : "{}") as { id?: number; method?: string };
  const result = (method: string | undefined): unknown => {
    if (method === "eth_blockNumber") return "0x64";
    if (method === "eth_getLogs") {
      return [{
        address: intent.asset,
        topics: encodeEventTopics({ abi: [AUTHORIZATION_USED], args: { authorizer: intent.from as Hex, nonce: intent.nonce as Hex } }),
        data: "0x",
        blockNumber: "0x64",
        blockHash: BLOCK_HASH,
        transactionHash: TRANSACTION,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
      }];
    }
    if (method === "eth_getTransactionByHash") {
      return {
        hash: TRANSACTION,
        from: intent.to,
        to: intent.asset,
        input: encodeFunctionData({
          abi: TRANSFER_WITH_AUTHORIZATION,
          args: [intent.from as Hex, intent.to as Hex, BigInt(intent.value), BigInt(intent.validAfter), BigInt(intent.validBefore), intent.nonce as Hex, `0x${"ab".repeat(65)}`],
        }),
        blockHash: BLOCK_HASH,
        blockNumber: "0x64",
        transactionIndex: "0x0",
        nonce: "0x0",
        gas: "0x186a0",
        value: "0x0",
        type: "0x2",
        chainId: "0x2105",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
        accessList: [],
        v: "0x0",
        yParity: "0x0",
        r: `0x${"01".repeat(32)}`,
        s: `0x${"01".repeat(32)}`,
      };
    }
    throw new Error(`${method} is not answered in this test`);
  };
  return Response.json({ jsonrpc: "2.0", id: parsed.id, result: result(parsed.method) });
}

function settleHeader(response: Response): Record<string, unknown> {
  const header = response.headers.get("PAYMENT-RESPONSE");
  expect(header).toEqual(expect.any(String));
  expect(response.headers.get("X-PAYMENT-RESPONSE")).toBe(header);
  return JSON.parse(Buffer.from(header!, "base64").toString("utf8")) as Record<string, unknown>;
}

const FORGED_RESOURCE = { url: "https://attacker.example/listing", description: "Planted text.", serviceName: "Planted" };
const FORGED_EXTENSIONS = { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: {} }, other: { planted: true } };

/**
 * An authorization carrying a caller-chosen `resource` and `extensions`: a v2
 * payload names them as fields, and a v1 payload has them as extra top-level
 * keys, which the v1 decoder does not drop.
 */
function forgedAuthorization(version: 1 | 2, accepted: Record<string, unknown>, nonce = "55"): string {
  const decoded = JSON.parse(Buffer.from(authorization(60, nonce), "base64").toString("utf8")) as Record<string, unknown>;
  const forged = version === 1
    ? { ...decoded, resource: FORGED_RESOURCE, extensions: FORGED_EXTENSIONS }
    : { x402Version: 2, resource: FORGED_RESOURCE, accepted, payload: decoded.payload, extensions: FORGED_EXTENSIONS };
  return Buffer.from(JSON.stringify(forged), "utf8").toString("base64");
}

/** Resolves when `signal` aborts, as a real fetch does, so facilitator timeouts behave. */
function aborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe.skipIf(!RUN)("x402 route (Postgres)", () => {
  const servers = servedApps();
  const shutdowns: Array<() => Promise<void>> = [];
  let pool: Pool;
  let jobs: PostgresJobStore;
  let ledger: CreditLedger;
  let payments: PostgresProcessedPaymentStore;
  let settlements: PostgresX402ExactSettlementStore;
  let facilitatorCalls: string[];
  let verifyDelayMs: number;
  let settleAnswer: () => Promise<Response>;
  let settleRequests: Array<FacilitatorRequest>;
  let verifyRequests: Array<FacilitatorRequest>;
  let verifyAnswer: () => Response;
  let chainRpc: (body: unknown) => Response | Promise<Response>;
  let handled: number;
  let release: Array<() => void>;
  /** Waits for the terminal work of every job the last started server holds. */
  let drain: () => Promise<unknown>;

  beforeEach(async () => {
    await recreateSchema(SCHEMA);
    pool = await pinnedPool(SCHEMA);
    jobs = new PostgresJobStore(pool);
    settlements = new PostgresX402ExactSettlementStore(pool);
    ledger = new CreditLedger(pool);
    payments = new PostgresProcessedPaymentStore(pool);
    // The host starts streaming; the route's inline wait listens for the terminal save.
    await Promise.all([jobs.init(), jobs.initStreaming(), ledger.init(), payments.init()]);
    facilitatorCalls = [];
    settleRequests = [];
    verifyRequests = [];
    verifyAnswer = () => Response.json({ isValid: true });
    chainRpc = chainRpcAnswer;
    verifyDelayMs = 0;
    handled = 0;
    release = [];
    settleAnswer = async () => Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (request, init) => {
      const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
      // The settlement server bookmarks a block before each submission; answer
      // it here so no test waits on, or depends on, a public chain RPC.
      if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname) && !url.startsWith(`${X402.facilitator}/`)) {
        return chainRpc(init?.body);
      }
      if (!url.startsWith(`${X402.facilitator}/`)) return realFetch(request, init);
      facilitatorCalls.push(new URL(url).pathname);
      if (url === `${X402.facilitator}/verify`) {
        verifyRequests.push(JSON.parse(String(init?.body)) as FacilitatorRequest);
        await new Promise((resolve) => setTimeout(resolve, verifyDelayMs));
        return verifyAnswer();
      }
      if (url === `${X402.facilitator}/settle`) {
        settleRequests.push(JSON.parse(String(init?.body)) as FacilitatorRequest);
        return Promise.race([settleAnswer(), aborted(init?.signal)]);
      }
      throw new Error(`Unexpected facilitator request: ${url}`);
    });
  });

  afterEach(async () => {
    for (const open of release.splice(0)) open();
    await servers.closeAll();
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await jobs?.shutdownStreaming();
    await pool?.end();
    await dropSchemas(SCHEMA);
    vi.restoreAllMocks();
  });

  async function start(
    opts: {
      behaviour?: Behaviour;
      bound?: number;
      facilitatorTimeoutMs?: number;
      x402Only?: boolean;
      devMode?: boolean;
      /** Mount the server under this path, as a host does for `mount(..., { prefix })`. */
      prefix?: string;
      /** The listing `fetch` is offered with on x402. */
      listing?: X402Listing;
    } = {}
  ) {
    // Listen first, so the server can be told the address callers reach it at.
    let served: { fetch: (request: Request) => Response | Promise<Response> } | undefined;
    const url = await servers.serve({ fetch: (request) => served!.fetch(request) });
    const x402 = { ...X402, ...(opts.facilitatorTimeoutMs !== undefined && { facilitatorTimeoutMs: opts.facilitatorTimeoutMs }) };
    const behaviour = opts.behaviour ?? (async (ctx) => { ctx.complete("done"); });
    const descriptor = configureDVM({
      name: "x402-route-test",
      auth: secp256k1Auth({ allowUnsignedPaid: true }),
      x402,
      capabilities: {
        ...(!opts.x402Only && {
          other: { input: z.looseObject({ text: z.string() }), price: "$0.01", onJob(ctx) { ctx.complete("other"); } },
        }),
        fetch: {
          channels: { job: false, x402: { listing: opts.listing ?? LISTING } },
          input: z.object({ url: z.string() }),
          price: "$0.016",
          maxRuntimeSeconds: opts.bound ?? 5,
          async onJob(ctx) {
            handled++;
            await behaviour(ctx);
          },
        },
        pages: {
          channels: { job: false, x402: { listing: { description: "Price by pages.", example: { pages: 3 } } } },
          input: z.object({ pages: z.number().int().positive() }),
          onQuote: {
            schema: z.object({ pages: z.number() }),
            handler: async ({ data }) => ({
              upfront: { amount: data.pages * 0.01, currency: "usd" as const },
              description: "One cent a page.",
            }),
          },
          maxRuntimeSeconds: 5,
          onJob(ctx) { handled++; ctx.complete("paged"); },
        },
        unlisted: {
          channels: { job: false, x402: {} },
          input: z.object({ url: z.string() }),
          price: "$0.016",
          maxRuntimeSeconds: 5,
          onJob(ctx) { handled++; ctx.complete("unlisted"); },
        },
      },
    });
    const instance = await createDVMServer(descriptor, {
      env: opts.devMode ? {} : { DVMKIT_PUBLIC_URL: url },
      devMode: opts.devMode,
      ...(opts.prefix && { mountPrefix: opts.prefix }),
      db: pool,
      dvmId: DVM_ID,
      store: new MemoryKVStore(),
      jobStore: jobs,
      creditLedger: ledger,
      processedPayments: payments,
      x402,
      fxFetcher: {
        fetch: async () => ({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
        supportedCurrencies: () => ["usd"],
      },
    });
    drain = () => Promise.all([...instance.jobManager.activeJobs.values()].map((job) => job.terminalWork));
    shutdowns.push(async () => {
      await drain();
      await instance.shutdown();
    });
    served = opts.prefix ? new Hono().route(opts.prefix, instance.app) : instance.app;
    return url;
  }

  function call(url: string, opts: { name?: string; body?: string; payment?: string; headers?: Record<string, string> } = {}) {
    return fetch(`${url}/v1/x402/${opts.name ?? "fetch"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(opts.payment ? { "X-PAYMENT": opts.payment } : {}),
        ...opts.headers,
      },
      body: opts.body ?? JSON.stringify(EXAMPLE),
    });
  }

  async function intentStatus(jobId: string): Promise<{ status: string; lastOutcome?: string } | undefined> {
    const job = await jobs.get(jobId);
    const intentId = job?.creditId?.slice("x402d:".length);
    return intentId ? settlements.get(DVM_ID, intentId) : undefined;
  }

  it("quotes an unpaid request and answers the paid retry with the result once a slow settlement lands", async () => {
    const url = await start({
      behaviour: async (ctx) => {
        ctx.artifact({ name: "page", data: "paid-for output" });
        ctx.complete("done");
      },
    });
    settleAnswer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    };
    const quote = await call(url);
    expect(quote.status).toBe(402);
    const quoted = await quote.json() as { accepts: { resource: string; maxAmountRequired: string; maxTimeoutSeconds: number }[]; mints?: unknown };
    expect(quoted.accepts).toEqual([
      expect.objectContaining({ resource: `${url}/v1/x402/fetch`, maxAmountRequired: String(PRICE_MICRO) }),
    ]);
    // Only x402 is offered here: no Cashu request in the body or the headers.
    expect(quoted.mints).toBeUndefined();
    expect(quote.headers.get("X-Cashu")).toBeNull();
    expect(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!).accepts).toHaveLength(1);
    expect(handled).toBe(0);

    const paid = await call(url, { payment: authorization(quoted.accepts[0]!.maxTimeoutSeconds) });
    expect(paid.status).toBe(fixture.charged.status);
    const body = await paid.json() as Record<string, unknown>;
    expect(body).toMatchObject(fixture.charged.body);
    for (const field of fixture.charged.requiredFields) expect(body).toHaveProperty(field);
    expect(JSON.stringify(body.messages)).toContain("paid-for output");
    expect(paid.headers.get(fixture.identityHeader)).toBe(body.job_id);
    expect(settleHeader(paid)).toMatchObject({ success: true, transaction: TRANSACTION });
    expect(facilitatorCalls).toEqual(["/verify", "/settle"]);
  }, 20_000);

  it("answers a failed handler with 500, never settles, and releases the authorization", async () => {
    const url = await start({ behaviour: async (ctx) => { ctx.fail("blocked"); } });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.handlerFailed.status);
    const body = await response.json() as { job_id: string };
    expect(body).toMatchObject({ ...fixture.handlerFailed.body, reason: "blocked" });
    expect(response.headers.get(fixture.identityHeader)).toBe(body.job_id);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(await intentStatus(body.job_id)).toMatchObject({ status: "released" });
  });

  it("aborts a handler still running at its runtime bound and answers 503 without settling", async () => {
    let signal: AbortSignal | undefined;
    const url = await start({
      bound: 1,
      behaviour: async (ctx) => {
        signal = ctx.signal;
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
      },
    });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.runtimeBound.status);
    const body = await response.json() as { job_id: string };
    expect(body).toMatchObject(fixture.runtimeBound.body);
    expect(response.headers.get(fixture.identityHeader)).toBe(body.job_id);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(await intentStatus(body.job_id)).toMatchObject({ status: "released" });
  });

  it("stops the handler when the request's budget runs out, counting the time verification took", async () => {
    verifyDelayMs = 1500;
    let sentAt = 0;
    let abortedAfterMs: number | undefined;
    const url = await start({
      bound: 3,
      behaviour: async (ctx) => {
        await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve));
        abortedAfterMs = Date.now() - sentAt;
      },
    });
    sentAt = Date.now();
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.runtimeBound.status);
    const body = await response.json() as { job_id: string };
    expect(body).toMatchObject(fixture.runtimeBound.body);
    // Three seconds from arrival, not three seconds after the 1.5-second verification.
    expect(abortedAfterMs).toBeGreaterThanOrEqual(2900);
    expect(abortedAfterMs).toBeLessThan(3700);
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(await intentStatus(body.job_id)).toMatchObject({ status: "released" });
  }, 20_000);

  it("never starts a handler whose request spent its runtime bound on verification, and answers 503", async () => {
    // A /verify slower than the one-second bound, though within the facilitator timeout.
    verifyDelayMs = 1500;
    const url = await start({
      bound: 1,
      facilitatorTimeoutMs: 2000,
      behaviour: async (ctx) => { await new Promise((resolve) => ctx.signal.addEventListener("abort", resolve)); },
    });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.runtimeBound.status);
    const body = await response.json() as { job_id: string };
    expect(body).toMatchObject(fixture.runtimeBound.body);
    expect(handled).toBe(0);
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(await intentStatus(body.job_id)).toMatchObject({ status: "released" });
  }, 20_000);

  it("answers 503, not unknown, when the settle window closes before a started settlement sends the authorization", async () => {
    // The settlement bookmarks a chain block before it sends; hold that read past the deadline.
    const bookmark = gate();
    release.push(bookmark.resolve);
    let settling = false;
    let bookmarks = 0;
    chainRpc = async (body) => {
      if (settling) {
        bookmarks++;
        await bookmark.promise;
      }
      return chainRpcAnswer(body);
    };
    const url = await start({
      bound: 1,
      facilitatorTimeoutMs: 1000,
      behaviour: async (ctx) => {
        settling = true;
        ctx.artifact({ name: "page", data: "paid-for output" });
        ctx.complete("done");
      },
    });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.settleWindowClosed.status);
    const text = await response.text();
    expect(text).not.toContain("paid-for output");
    const body = JSON.parse(text) as { job_id: string };
    expect(body).toMatchObject({
      ...fixture.settleWindowClosed.body,
      reason: SETTLE_WINDOW_CLOSED_REASON,
      ...X402_ROUTE_COPY.settle_window_closed,
    });
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(await intentStatus(body.job_id)).toMatchObject({ status: "released", lastOutcome: "settle_window_closed" });
    // The settlement had started: it was waiting on its bookmark at the deadline.
    expect(bookmarks).toBe(1);

    // It resumes, finds the authorization released, ends unpaid rather than
    // throwing, and never sends it.
    const errors = vi.spyOn(diagnosticConsole, "error");
    bookmark.resolve();
    expect(await drain()).toHaveLength(1);
    expect(facilitatorCalls).toEqual(["/verify"]);
    expect(errors.mock.calls.map(([value]) => (value as { event?: string }).event)).not.toContain("credit_resolve_failed");
  }, 20_000);

  it("answers charged when a started settlement claims the authorization while the deadline release is tried", async () => {
    const bookmark = gate();
    release.push(bookmark.resolve);
    let settling = false;
    chainRpc = async (body) => {
      if (settling) await bookmark.promise;
      return chainRpcAnswer(body);
    };
    // The route reads the intent as unsent, then the settlement claims and settles it before the release lands.
    const realRelease = PostgresX402ExactSettlementStore.prototype.release;
    vi.spyOn(PostgresX402ExactSettlementStore.prototype, "release").mockImplementation(async function (this: PostgresX402ExactSettlementStore, args) {
      bookmark.resolve();
      await vi.waitFor(async () => expect((await settlements.get(DVM_ID, args.intentId))?.status).toBe("complete"), { timeout: 5000 });
      return realRelease.call(this, args);
    });
    const url = await start({
      bound: 1,
      facilitatorTimeoutMs: 1000,
      behaviour: async (ctx) => {
        settling = true;
        ctx.artifact({ name: "page", data: "paid-for output" });
        ctx.complete("done");
      },
    });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.charged.status);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject(fixture.charged.body);
    expect(text).toContain("paid-for output");
    expect(settleHeader(response)).toMatchObject({ success: true, transaction: TRANSACTION });
    expect(facilitatorCalls).toEqual(["/verify", "/settle"]);
  }, 20_000);

  it("names the transaction and network in PAYMENT-RESPONSE when the settlement is recovered from the chain", async () => {
    // A facilitator that reports success with no transaction leaves the outcome to chain evidence.
    settleAnswer = async () => Response.json({ success: true, network: X402.network });
    chainRpc = async (body) => {
      const [intent] = await settlements.list({ dvmId: DVM_ID, limit: 1, includeResolved: true });
      return chainSettledAnswer(body, intent!);
    };
    const url = await start();
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.charged.status);
    expect(await response.json()).toMatchObject(fixture.charged.body);
    // The client paid with v1 requirements, which name the network by its v1 slug.
    const network = x402NetworkByCaip2(X402.network)!.slug;
    expect(settleHeader(response)).toMatchObject({ success: true, transaction: TRANSACTION, network });
  }, 20_000);

  it.each(["", "/feed"])("names the capability's own address under the mount %j as the resource, whatever query or encoding the request carried", async (prefix) => {
    const url = await start({ prefix });
    const base = `${url}${prefix}`;
    const resource = `${base}/v1/x402/fetch`;
    for (const name of [`fetch?pad=${"p".repeat(6000)}`, "fe%74ch"]) {
      const quote = await call(base, { name });
      expect(quote.status).toBe(402);
      const header = quote.headers.get("PAYMENT-REQUIRED")!;
      expect(header.length).toBeLessThanOrEqual(X402_PAYMENT_REQUIRED_MAX_BYTES);
      expect(decodePaymentRequiredHeader(header).resource.url).toBe(resource);
      expect((await quote.json() as { accepts: { resource: string }[] }).accepts[0]?.resource).toBe(resource);
    }
    const paid = await call(base, { name: "fe%74ch", payment: authorization(60) });
    expect(paid.status).toBe(200);
    expect(settleRequests.map((request) => request.paymentRequirements.resource)).toEqual([resource]);
    // The schema the route's hints point to is this mount's own.
    const unknown = await call(base, { name: "nope" });
    const hint = (await unknown.json() as { hint: string }).hint;
    expect(hint).toContain(`${base}/v1/info`);
    expect((await fetch(`${base}/v1/info`)).status).toBe(200);
  });

  it("names the request's own origin as the resource in devMode without DVMKIT_PUBLIC_URL", async () => {
    const url = await start({ devMode: true });
    const quote = await call(url);
    expect(quote.status).toBe(402);
    expect(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!).resource.url).toBe(`${url}/v1/x402/fetch`);
  });

  it("bounds the refusal of an authorization whose validBefore is no usable time", async () => {
    const url = await start();
    const response = await call(url, { payment: authorization(`1${"0".repeat(6000)}`) });
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: "payment_authorization_too_short" });
    const header = response.headers.get("PAYMENT-REQUIRED")!;
    expect(header.length).toBeLessThanOrEqual(X402_PAYMENT_REQUIRED_MAX_BYTES);
    // The boot check sizes the challenge with an `error` of this length.
    expect(decodePaymentRequiredHeader(header).error?.length).toBeLessThanOrEqual(X402_SIZE_CHECK_ERROR.length);
    expect(facilitatorCalls).toEqual([]);
  });

  it("answers a refused settlement with 402 and the facilitator's refusal, and no result", async () => {
    const url = await start({ behaviour: async (ctx) => { ctx.artifact({ name: "page", data: "paid-for output" }); ctx.complete("done"); } });
    settleAnswer = async () => Response.json({ success: false, errorReason: "insufficient_funds", network: X402.network });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(fixture.settlementRefused.status);
    const text = await response.text();
    expect(text).not.toContain("paid-for output");
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body).toMatchObject(fixture.settlementRefused.body);
    for (const field of fixture.settlementRefused.omittedFields) expect(body).not.toHaveProperty(field);
    expect(settleHeader(response)).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(response.headers.get(fixture.identityHeader)).toBe(body.job_id);
  });

  it.each([
    { outcome: "charged", status: 200, settled: { success: true, transaction: TRANSACTION } },
    { outcome: "refused", status: 400, settled: { success: false, errorReason: `invalid_request ${"x".repeat(4000)}` } },
  ])("returns only the allowed, bounded settle fields in a $outcome PAYMENT-RESPONSE", async ({ status, settled }) => {
    const url = await start({ behaviour: async (ctx) => { ctx.complete("done"); } });
    settleAnswer = async () => Response.json({
      ...settled,
      network: X402.network,
      payer: `0x${"ab".repeat(2000)}`,
      errorMessage: "facilitator-internal detail",
      extensions: { bazaar: { status: "processing", padding: "y".repeat(4000) } },
    }, { status });
    const response = await call(url, { payment: authorization(60) });
    const answer = settleHeader(response);
    expect(Object.keys(answer).sort()).toEqual(
      settled.success ? ["network", "success", "transaction"] : ["errorReason", "network", "success", "transaction"]
    );
    expect(answer).toMatchObject({ success: settled.success, network: X402.network });
    if (!settled.success) expect((answer.errorReason as string).startsWith("invalid_request")).toBe(true);
    expect(response.headers.get("PAYMENT-RESPONSE")!.length).toBeLessThan(512);
    if (settled.success) {
      // A later read of the job repeats the settlement header with the same fields.
      const { job_id, job_token } = await response.json() as { job_id: string; job_token: string };
      const read = await fetch(`${url}/v1/job/${job_id}`, { headers: { "X-Job-Token": job_token } });
      expect(settleHeader(read)).toEqual(answer);
    }
  });

  it("answers 202 with the job token when the settlement outcome is unknown at the deadline, and a later read resolves it", async () => {
    const prefix = "/feed";
    const url = await start({
      prefix,
      bound: 1,
      facilitatorTimeoutMs: 1000,
      behaviour: async (ctx) => { ctx.artifact({ name: "page", data: "paid-for output" }); ctx.complete("done"); },
    });
    const held = gate();
    release.push(held.resolve);
    settleAnswer = async () => {
      await held.promise;
      return Response.json({ success: true, transaction: TRANSACTION, network: X402.network });
    };
    const response = await call(`${url}${prefix}`, { payment: authorization(60) });
    expect(response.status).toBe(fixture.unknown.status);
    const text = await response.text();
    expect(text).not.toContain("paid-for output");
    const body = JSON.parse(text) as { job_id: string; job_token: string; hint: string };
    expect(body).toMatchObject(fixture.unknown.body);
    expect(body.hint).toMatch(/do not pay again/i);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get(fixture.identityHeader)).toBe(body.job_id);
    // The hint names the job's address under the mount, which the read below follows.
    const jobPath = /GET (\S+)/.exec(body.hint)?.[1];
    expect(jobPath).toBe(`${prefix}/v1/job/${body.job_id}`);

    held.resolve();
    await vi.waitFor(async () => {
      const read = await fetch(`${url}${jobPath}`, { headers: { "X-Job-Token": body.job_token } });
      expect(await read.json()).toMatchObject({ status: "completed", summary: "done" });
      expect(settleHeader(read)).toMatchObject({ success: true, transaction: TRANSACTION });
    }, { timeout: 10_000, interval: 250 });
    // The read resent the authorization the timed-out attempt had already submitted.
    expect(facilitatorCalls).toEqual(["/verify", "/settle", "/settle"]);
  }, 20_000);

  it("leaves a result over the inline cap on the messages endpoint and says so", async () => {
    const big = "x".repeat(1_100_000);
    const url = await start({ behaviour: async (ctx) => { ctx.artifact({ name: "page", data: big }); ctx.complete("done"); } });
    const response = await call(url, { payment: authorization(60) });
    expect(response.status).toBe(200);
    const body = await response.json() as { job_id: string; job_token: string };
    expect(body).toMatchObject({ ...fixture.charged.body, payload_in: "messages", has_artifacts: true });
    expect(body).not.toHaveProperty("messages");
    const messages = await fetch(`${url}/v1/job/${body.job_id}/messages`, { headers: { "X-Job-Token": body.job_token } });
    expect(await messages.text()).toContain(big);
  }, 20_000);

  it.each([
    ["no body", ""],
    ["an empty object", "{}"],
  ])("quotes an unpaid request with %s on a listed capability from its example, and runs nothing", async (_, sent) => {
    const url = await start();
    const response = await call(url, { name: "pages", body: sent });
    expect(response.status).toBe(402);
    const body = await response.json() as { accepts: { maxAmountRequired: string }[] };
    // The example asks for 3 pages at $0.01 each.
    expect(body.accepts[0]?.maxAmountRequired).toBe("30000");
    expect(handled).toBe(0);
    expect(facilitatorCalls).toEqual([]);
  });

  it("quotes a valid unpaid body from the body itself", async () => {
    const url = await start();
    const response = await call(url, { name: "pages", body: JSON.stringify({ pages: 5 }) });
    expect(response.status).toBe(402);
    expect((await response.json() as { accepts: { maxAmountRequired: string }[] }).accepts[0]?.maxAmountRequired).toBe("50000");
  });

  it("refuses an invalid body when unlisted or paid, before any payment call or work", async () => {
    const url = await start();
    expect((await call(url, { name: "unlisted", body: "" })).status).toBe(400);
    for (const sent of ["", "{}", "not json"]) {
      const response = await call(url, { body: sent, payment: authorization(60) });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_input" });
    }
    expect(facilitatorCalls).toEqual([]);
    expect(handled).toBe(0);
  });

  it("refuses a body carrying a signing field on a DVM with an auth scheme, before any payment call", async () => {
    const url = await start();
    const response = await call(url, {
      body: JSON.stringify({ ...EXAMPLE, pubkey: "ff".repeat(32) }),
      payment: authorization(60),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "signed_fields_not_accepted" });
    expect(facilitatorCalls).toEqual([]);
    expect(handled).toBe(0);
  });

  it("refuses every payment but x402, pointing to /v1/job", async () => {
    const url = await start();
    const response = await call(url, { headers: { "X-Cashu": "cashuBexample" } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "payment_method_not_accepted", hint: expect.stringContaining("/v1/job") });
  });

  it("serves only names offered on x402, and /v1/job does not serve an x402-only name", async () => {
    const url = await start();
    expect((await call(url, { name: "other" })).status).toBe(404);
    const viaJob = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "fetch", data: EXAMPLE }),
    });
    expect(viaJob.status).toBe(400);
    expect(await viaJob.json()).toMatchObject({ error: "unknown_capability" });
  });

  it("serves a DVM offered only on x402, whose /v1/job has no capability to run", async () => {
    const origin = await start({ x402Only: true, prefix: "/feed" });
    const url = `${origin}/feed`;
    const paid = await call(url, { payment: authorization(60) });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toMatchObject({ status: "completed", charge_outcome: "charged" });

    const info = await fetch(`${url}/v1/info`);
    expect(info.status).toBe(200);
    const viaJob = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "fetch", data: EXAMPLE }),
    });
    expect(viaJob.status).toBe(400);
    expect(await viaJob.json()).toMatchObject({ error: "unknown_capability" });
    const unnamed = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: EXAMPLE }),
    });
    expect(unnamed.status).toBe(400);
    expect(await unnamed.json()).toMatchObject({ error: "capability_required", hint: expect.stringContaining("POST /feed/v1/x402/") });
  });

  it("refuses a second payment from a wallet with a job running, saying when to retry", async () => {
    const running = gate();
    release.push(running.resolve);
    const url = await start({ bound: 5, behaviour: async (ctx) => { await running.promise; ctx.complete("done"); } });
    const first = call(url, { payment: authorization(60) });
    await vi.waitFor(() => expect(handled).toBe(1));
    const second = await call(url, { payment: authorization(60, "44") });
    expect(second.status).toBe(429);
    // Bound plus the default ten-second settle timeout.
    expect(second.headers.get("Retry-After")).toBe("15");
    expect(await second.json()).toMatchObject({ error: "x402_payer_busy", hint: expect.stringContaining("15 seconds") });
    running.resolve();
    expect((await first).status).toBe(200);
  }, 20_000);

  it.each(["", "/feed"])("lets a browser read the x402 payment headers on the route under the mount %j", async (prefix) => {
    const url = await start({ prefix });
    const base = `${url}${prefix}`;
    const preflight = await fetch(`${base}/v1/x402/fetch`, {
      method: "OPTIONS",
      headers: { Origin: "https://wallet.example", "Access-Control-Request-Method": "POST" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const quote = await call(base, { headers: { Origin: "https://wallet.example" } });
    for (const response of [preflight, quote]) {
      const exposed = response.headers.get("Access-Control-Expose-Headers")?.split(",") ?? [];
      expect(exposed).toEqual(expect.arrayContaining(["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE"]));
    }
  });

  // Hono joins a mount to its routes less one trailing slash: `/feed/` serves
  // `/feed/v1/...` and `/feed//` serves `/feed//v1/...`.
  it.each(["", "/feed", "/feed/", "/feed//"])("puts the listing's resource and bazaar extension on a listed capability's 402 under the mount %j, and nothing on the v1 body", async (prefix) => {
    const url = await start({ prefix });
    const base = `${url}${prefix.replace(/\/$/, "")}`;
    const quote = await call(base);
    expect(quote.status).toBe(402);
    const required = decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!);
    expect(required.resource).toEqual({
      url: `${base}/v1/x402/fetch`,
      description: LISTING.description,
      mimeType: "application/json",
      tags: ["web"],
    });
    const bazaar = required.extensions?.bazaar as { info: { input: { method: string } } } | undefined;
    expect(validateDiscoveryExtension(bazaar as never)).toEqual({ valid: true });
    expect(bazaar?.info.input.method).toBe("POST");
    // A stock client echoes the 402's resource and extensions in its paid retry.
    const accepted = required.accepts[0]!;
    const payload = { x402Version: 2, resource: required.resource, accepted, payload: {}, extensions: required.extensions };
    expect(extractDiscoveryInfo(payload as never, accepted as never)).toMatchObject({
      resourceUrl: `${base}/v1/x402/fetch`,
      method: "POST",
      description: LISTING.description,
      discoveryInfo: { input: { type: "http", method: "POST", bodyType: "json", body: EXAMPLE } },
    });
    const v1 = await quote.text();
    expect(v1).not.toContain("bazaar");
    expect(v1).not.toContain(LISTING.description);
    expect((JSON.parse(v1) as { accepts: { resource: string }[] }).accepts[0]?.resource).toBe(`${base}/v1/x402/fetch`);
    // /v1/info names the same address for the route.
    const info = await (await fetch(`${base}/v1/info`)).json() as { x402_capabilities: Record<string, { url: string }> };
    expect(info.x402_capabilities.fetch?.url).toBe(required.resource.url);
  });

  it("names a configured resourceUrl as the listed resource, while payment stays bound to the route's own address", async () => {
    const resourceUrl = "https://catalog.example.com/fetch";
    const url = await start({ listing: { ...LISTING, resourceUrl } });
    const quote = await call(url);
    expect(decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!).resource.url).toBe(resourceUrl);
    expect((await quote.json() as { accepts: { resource: string }[] }).accepts[0]?.resource).toBe(`${url}/v1/x402/fetch`);
  });

  it("puts no listing on an unlisted capability's 402", async () => {
    const url = await start();
    const quote = await call(url, { name: "unlisted" });
    expect(quote.status).toBe(402);
    const required = decodePaymentRequiredHeader(quote.headers.get("PAYMENT-REQUIRED")!);
    expect(required.resource).toEqual({ url: `${url}/v1/x402/unlisted`, mimeType: "application/json" });
    expect(required.extensions?.bazaar).toBeUndefined();
  });

  it.each([1, 2] as const)("sends the facilitator the server's resource and extensions, never a v%d caller's, on verify and settle", async (version) => {
    const url = await start();
    // Each settlement needs its own transaction: one transaction books one payment.
    let settled = 0;
    settleAnswer = async () => Response.json({ success: true, transaction: `0x${String(++settled).repeat(64)}`, network: X402.network });
    const listed = decodePaymentRequiredHeader((await call(url)).headers.get("PAYMENT-REQUIRED")!);
    const paid = await call(url, { payment: forgedAuthorization(version, listed.accepts[0]! as never) });
    expect(paid.status).toBe(200);
    const unlisted = decodePaymentRequiredHeader((await call(url, { name: "unlisted" })).headers.get("PAYMENT-REQUIRED")!);
    const unlistedPaid = await call(url, { name: "unlisted", payment: forgedAuthorization(version, unlisted.accepts[0]! as never, "66") });
    expect(unlistedPaid.status).toBe(200);

    expect(verifyRequests).toHaveLength(2);
    expect(settleRequests).toHaveLength(2);
    for (const sent of [verifyRequests[0]!, settleRequests[0]!]) {
      const payload = sent.paymentPayload;
      expect(JSON.stringify(payload)).not.toContain("attacker.example");
      expect(JSON.stringify(payload)).not.toContain("planted");
      if (version === 2) {
        expect(payload.resource).toEqual(listed.resource);
        expect(payload.extensions).toEqual({ bazaar: listed.extensions!.bazaar });
      } else {
        expect(payload).not.toHaveProperty("resource");
        expect(payload).not.toHaveProperty("extensions");
      }
    }
    for (const sent of [verifyRequests[1]!, settleRequests[1]!]) {
      const payload = sent.paymentPayload;
      expect(JSON.stringify(payload)).not.toContain("attacker.example");
      expect(payload).not.toHaveProperty("extensions");
      if (version === 2) expect(payload.resource).toEqual(unlisted.resource);
      else expect(payload).not.toHaveProperty("resource");
    }
  }, 20_000);

  it("logs the facilitator's EXTENSION-RESPONSES, processing and rejected alike, and passes neither on to the caller", async () => {
    const reason = "listing refused: planted reason text";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");
    verifyAnswer = () => Response.json({ isValid: true }, {
      headers: { "EXTENSION-RESPONSES": encode({ bazaar: { status: "processing" } }) },
    });
    const settledHeader = encode({ bazaar: { status: "rejected", rejectedReason: reason } });
    settleAnswer = async () => Response.json({ success: true, transaction: TRANSACTION, network: X402.network }, {
      headers: { "EXTENSION-RESPONSES": settledHeader },
    });
    const sinks = (["info", "warn"] as const).map((level) => vi.spyOn(console, level));
    const url = await start();
    const paid = await call(url, { payment: authorization(60) });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("EXTENSION-RESPONSES")).toBeNull();
    const seen = `${[...paid.headers].map(([name, value]) => `${name}: ${value}`).join("\n")}\n${await paid.text()}`;
    expect(seen).not.toContain(settledHeader);
    expect(seen).not.toContain("planted reason");
    expect(seen).not.toContain("processing");

    const logged = sinks.flatMap((sink) => sink.mock.calls.map(([line]) => String(line)))
      .filter((line) => line.includes("x402_facilitator_extension_response"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(logged).toEqual(expect.arrayContaining([
      expect.objectContaining({ extension: "bazaar", extension_status: "processing", failure_stage: "verifier" }),
      expect.objectContaining({ extension: "bazaar", extension_status: "rejected", extension_rejected_reason: reason }),
    ]));
  }, 20_000);
});
