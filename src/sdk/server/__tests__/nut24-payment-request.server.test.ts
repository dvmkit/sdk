/*
 * NUT-24 per-call Cashu: the unpaid 402 carries an `X-Cashu` payment request,
 * and a wallet pays it with only an `X-Cashu` token. Real host, real local mint.
 */
import { readFileSync } from "node:fs";

import { randomUUID } from "node:crypto";

import { decodePaymentRequest, getEncodedToken, type P2PKOptions, type Proof, Wallet } from "@cashu/cashu-ts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ArtifactContent } from "../../../lib/messages/types";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { proofSetRequestId } from "../cashu-payment-request";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { serve } from "../serve";
import { createSignedRequestVerifier } from "../signed-request";

const inlineContract = JSON.parse(readFileSync(new URL("../../../../protocol-fixtures/nut24-inline-result-v1.json", import.meta.url), "utf8"));

const live = await localMintAvailable();

// $0.016 is 16 sats at 100,000 USD/BTC, 20 sats at 80,000 and 25 at 64,000.
const PRICE = "$0.016";

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

interface Host {
  url: string;
  info: {
    auth_audience?: { dvm_id: string; builder_pubkey: string };
    cashu: { mints: string[]; lock_pubkeys: string[] };
  };
  /** Sets the BTC/USD rate the host's fx source serves from now on. */
  setRate(rate: number): void;
  nextProcessingRead(): Promise<void>;
  /** Holds every fx fetch from now on until {@link Host.release} answers it. */
  holdFetches(): void;
  /** Resolves once `count` fetches are waiting. */
  waitingFetches(count: number): Promise<void>;
  /** Answers the waiting fetches in arrival order with these rates, in one synchronous step, and stops holding. */
  release(rates: number[]): void;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function handlerGate() {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  closers.push(async () => { release(); });
  return { release, enter: () => held };
}

async function startHost(signed: boolean, options: { wait?: number; prompt?: boolean; fail?: boolean; artifact?: ArtifactContent; redactOnMessageRead?: boolean; onStart?: () => void | Promise<void> } = {}): Promise<Host> {
  let handlerStarted = false;
  const processingReaders = new Set<() => void>();
  class ObservedStore extends MemoryJobStore {
    override async getMessages(...args: Parameters<MemoryJobStore["getMessages"]>) {
      const messages = await super.getMessages(...args);
      const record = await super.get(args[0]);
      if (options.redactOnMessageRead && record?.status === "completed" && record.redactedAt === undefined) {
        await this.redactJob({ jobId: record.id, expectedLastActivityAt: record.lastActivityAt, redactedAt: Date.now() });
      }
      return messages;
    }
    override async get(id: string) {
      const afterAdmission = handlerStarted;
      const snapshot = await super.get(id);
      if (afterAdmission && snapshot?.status === "processing") {
        const readers = [...processingReaders];
        processingReaders.clear();
        // Let snapshot consumers finish before the test releases the handler.
        setImmediate(() => { for (const ready of readers) ready(); });
      }
      return snapshot;
    }
  }
  const jobStore = new ObservedStore();
  let rate = 100_000;
  let holding = false;
  const waiting: ((usd: number) => void)[] = [];
  const snapshot = (usd: number) => ({ rates: { usd }, as_of: new Date().toISOString() });
  const fx: FxFetcher = {
    fetch: () =>
      holding
        ? new Promise((resolve) => waiting.push((usd) => resolve(snapshot(usd))))
        : Promise.resolve(snapshot(rate)),
    supportedCurrencies: () => ["usd"],
  };
  const descriptor = configureDVM({
    name: "nut24-payment-request",
    ...(options.wait === undefined ? {} : { cashu: { unsignedResultWaitSeconds: options.wait } }),
    capabilities: {
      paid: {
        input: signed ? signedSchema : z.object({ text: z.string().min(1) }),
        price: PRICE,
        async onJob(ctx) {
          handlerStarted = true;
          await options.onStart?.();
          if (options.prompt) await ctx.prompt("next", "Continue?");
          if (options.fail) { ctx.fail("cannot complete"); return; }
          if (options.artifact) ctx.artifact(options.artifact);
          ctx.complete(`result:${(ctx.input as { text: string }).text}`);
        },
      },
    },
    ...(signed ? { auth: secp256k1Auth({ allowUnsignedPaid: true }) } : {}),
  });
  const running = await serve(descriptor, { devMode: true, port: 0, env: {}, jobStore, mints: [LOCAL_MINT_URL], fx });
  closers.push(() => running.close());
  const info = (await (await fetch(`${running.url}/v1/info`)).json()) as Host["info"];
  return {
    url: running.url,
    info,
    setRate: (next) => (rate = next),
    nextProcessingRead: () => new Promise((resolve) => { processingReaders.add(resolve); }),
    holdFetches: () => (holding = true),
    async waitingFetches(count) {
      for (let n = 0; waiting.length < count && n < 400; n++) await new Promise((r) => setTimeout(r, 5));
      expect(waiting.length).toBe(count);
    },
    release(rates) {
      holding = false;
      rate = rates.at(-1)!;
      const answers = waiting.splice(0);
      expect(answers.length).toBe(rates.length);
      answers.forEach((answer, i) => answer(rates[i]!));
    },
  };
}

function submit(host: Host, text: string, token?: string, requestId?: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token && { "X-Cashu": token }),
      ...(requestId && { "X-Cashu-Request-Id": requestId }),
    },
    body: JSON.stringify({ capability: "paid", data: { text } }),
  });
}

/** The payment request off an unpaid 402, decoded the way a NUT-24 wallet does. */
async function paymentRequest(host: Host, text: string) {
  const res = await submit(host, text);
  expect(res.status).toBe(402);
  expect((await res.json()) as { error: string }).toMatchObject({ error: "payment_required" });
  const header = res.headers.get("X-Cashu");
  expect(header).toMatch(/^creqA/);
  return decodePaymentRequest(header!);
}

async function mintedProofs(sats: number): Promise<{ wallet: Wallet; proofs: Proof[] }> {
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(sats);
  let paid = await wallet.checkMintQuoteBolt11(quote.quote);
  for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    paid = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  return { wallet, proofs: await wallet.mintProofsBolt11(sats, paid) };
}

/** Pay `sats` (default: the request's amount) locked as the request's `nut10` asks, or as `lockTo` says. */
async function payRequest(
  request: ReturnType<typeof decodePaymentRequest>,
  sats?: number,
  lockTo?: string | P2PKOptions
): Promise<string> {
  return (await payRequestWithProofs(request, sats, lockTo)).token;
}

async function payRequestWithProofs(
  request: ReturnType<typeof decodePaymentRequest>,
  sats?: number,
  lockTo?: string | P2PKOptions
): Promise<{ token: string; proofs: Proof[] }> {
  const amount = sats ?? request.amount!.toNumber();
  const { wallet, proofs } = await mintedProofs(amount * 2);
  const lock = typeof lockTo === "string" ? { pubkey: lockTo } : (lockTo ?? request.toP2PKOptions()!);
  const preview = await wallet.ops.send(amount, proofs).asP2PK(lock).includeFees(true).prepare();
  const { send } = await wallet.completeSwap(preview);
  return { token: getEncodedToken({ mint: request.mints![0]!, proofs: send, unit: request.unit }), proofs: send };
}

async function unlockedToken(sats: number): Promise<string> {
  const { wallet, proofs } = await mintedProofs(sats * 2);
  const { send } = await wallet.send(sats, proofs, { includeFees: true });
  return getEncodedToken({ mint: LOCAL_MINT_URL, proofs: send, unit: "sat" });
}

interface Job {
  job_id?: string;
  job_token?: string;
  summary?: string;
  error?: string;
}

async function expectRefused(res: Response, status: number, error: string): Promise<void> {
  expect(res.status).toBe(status);
  expect(res.headers.get("X-Cashu")).toBeNull();
  expect(((await res.json()) as Job).error).toBe(error);
}

describe.skipIf(!live)("NUT-24 payment requests", () => {
  const dvms = [
    { dvm: "a DVM without auth", signed: false },
    { dvm: "an allowUnsignedPaid DVM, unsigned callers", signed: true },
  ] as const;

  for (const { dvm, signed } of dvms) {
    describe(`on ${dvm}`, () => {
      it("advertises the amount, unit, mints and lock as a NUT-18 request with no transport", async () => {
        const host = await startHost(signed);
        const request = await paymentRequest(host, "ask");
        expect(request.amount?.toNumber()).toBe(16);
        expect(request.unit).toBe("sat");
        expect(request.mints).toEqual(host.info.cashu.mints);
        expect(request.nut10).toEqual({ kind: "P2PK", data: host.info.cashu.lock_pubkeys[0], tags: [] });
        expect(request.transport).toBeUndefined();
        expect(request.id).toBeUndefined();
        expect(request.description).toBeUndefined();
        expect(request.singleUse).toBe(false);
      }, 30_000);

      it("accepts a token sent with only X-Cashu and recovers the job when the same token is retried", async () => {
        const gate = handlerGate();
        const host = await startHost(signed, { onStart: gate.enter });
        const token = await payRequest(await paymentRequest(host, "mine"));

        const processingRead = host.nextProcessingRead();
        const paying = submit(host, "mine", token);
        await processingRead;
        gate.release();
        const paid = await paying;
        expect(paid.status).toBe(inlineContract.completed.status);
        const job = (await paid.json()) as Job;
        expect(job.summary).toBe("result:mine");
        for (const field of inlineContract.completed.requiredFields) expect(job).toHaveProperty(field);
        expect(job).toMatchObject(inlineContract.completed.body);
        expect(paid.headers.get(inlineContract.identityHeader)).toBe(job.job_id);

        const retry = await submit(host, "mine", token);
        expect(retry.status).toBe(200);
        const recovered = (await retry.json()) as Job;
        expect(recovered.job_id).toBe(job.job_id);
        expect(recovered.job_token).toBe(job.job_token);
        expect(recovered.summary).toBe("result:mine");

        // The token is bound to the request it paid: another body recovers nothing and runs nothing.
        const other = await submit(host, "other", token);
        expect(other.status).toBe(409);
        expect(other.headers.get("X-Cashu")).toBeNull();
        const text = await other.text();
        expect((JSON.parse(text) as Job).error).toBe("replay_rejected");
        expect(text).not.toContain(job.job_token!);
      }, 30_000);

      it("returns artifact bytes and the same durable messages inline on paid retries", async () => {
        const gate = handlerGate();
        const host = await startHost(signed, { artifact: inlineContract.artifacts.artifact, onStart: gate.enter });
        const token = await payRequest(await paymentRequest(host, "artifact"));
        const processingRead = host.nextProcessingRead();
        const paying = submit(host, "artifact", token);
        await processingRead;
        gate.release();
        const paid = await paying;
        expect(paid.status).toBe(inlineContract.artifacts.status);
        const job = await paid.json();
        expect(job).toMatchObject(inlineContract.artifacts.body);
        for (const field of inlineContract.artifacts.requiredFields) expect(job).toHaveProperty(field);
        expect(job.messages.find((message: { type: string }) => message.type === "artifact").content)
          .toEqual(inlineContract.artifacts.artifact);
        const headers = { "X-Job-Token": job.job_token };
        const history = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, { headers });
        expect((await history.json()).messages).toEqual(job.messages);
        const status = await fetch(`${host.url}/v1/job/${job.job_id}`, { headers });
        expect(await status.json()).not.toHaveProperty("messages");
        const replay = await submit(host, "artifact", token);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(job);
      }, 30_000);

      it("answers a wrong mint, an unlocked token and a short payment 400 without X-Cashu-Request-Id", async () => {
        const host = await startHost(signed);
        const request = await paymentRequest(host, "bad");
        const { proofs } = await mintedProofs(16);
        const wrongMint = getEncodedToken({ mint: "https://mint.example.com", proofs, unit: "sat" });

        await expectRefused(await submit(host, "bad", wrongMint), 400, "invalid_token");
        await expectRefused(await submit(host, "bad", await unlockedToken(16)), 400, "not_p2pk_locked");
        const stranger = Buffer.from(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true)).toString("hex");
        await expectRefused(await submit(host, "bad", await payRequest(request, 16, stranger)), 400, "wrong_lock_pubkey");
        // A lock that anyone may spend once its locktime passes is not exclusive to the DVM.
        const expiring = { ...request.toP2PKOptions()!, locktime: Math.floor(Date.now() / 1000) + 60 };
        await expectRefused(await submit(host, "bad", await payRequest(request, 16, expiring)), 400, "lock_not_exclusive");
        const short = await payRequest(request, 15);
        await expectRefused(await submit(host, "bad", short), 400, "payment_insufficient");
        // A short payment is kept, as one with a request id is: it cannot be presented again.
        await expectRefused(await submit(host, "bad", short), 409, "replay_rejected");
      }, 60_000);

      it("answers the same failures as before when X-Cashu-Request-Id is sent", async () => {
        const host = await startHost(signed);
        const request = await paymentRequest(host, "bad");
        const { proofs } = await mintedProofs(16);
        const wrongMint = getEncodedToken({ mint: "https://mint.example.com", proofs, unit: "sat" });

        await expectRefused(await submit(host, "bad", wrongMint, randomUUID()), 402, "invalid_token");
        await expectRefused(await submit(host, "bad", await unlockedToken(16), randomUUID()), 402, "not_p2pk_locked");
        await expectRefused(
          await submit(host, "bad", await payRequest(request, 15), randomUUID()),
          402,
          "payment_insufficient"
        );
      }, 60_000);

      it("refuses a caller-chosen derived id, so it cannot pre-claim the id an honest header-less payment needs", async () => {
        const host = await startHost(signed);
        const { token, proofs } = await payRequestWithProofs(await paymentRequest(host, "claimed"));
        const derived = proofSetRequestId(proofs.map((p) => p.secret));

        await expectRefused(await submit(host, "claimed", token, derived), 400, "reserved_request_id");
        await expectRefused(await submit(host, "claimed", token, "nut24-anything"), 400, "reserved_request_id");
        // Refused before pricing, so a caller is told before paying rather than handed a 402 it cannot pay under that id.
        await expectRefused(await submit(host, "claimed", undefined, derived), 400, "reserved_request_id");

        const paid = await submit(host, "claimed", token);
        expect(paid.status).toBe(200);
        expect(((await paid.json()) as Job).summary).toBe("result:claimed");
      }, 30_000);

      it("gives no price hold to a payment sent with X-Cashu-Request-Id", async () => {
        const host = await startHost(signed);
        const before = await paymentRequest(host, "with-id");
        host.setRate(80_000);
        await expectRefused(
          await submit(host, "with-id", await payRequest(before), randomUUID()),
          402,
          "payment_insufficient"
        );
      }, 60_000);

      it("keeps the hold of the rates that priced a payment when a refresh lands before it is verified", async () => {
        const host = await startHost(signed);
        const quoted = await paymentRequest(host, "raced"); // 16 sats at 100,000
        const token = await payRequest(quoted);

        host.holdFetches();
        const paying = submit(host, "raced", token);
        await host.waitingFetches(1);
        const other = submit(host, "other"); // an unpaid request whose price fetch lands second
        await host.waitingFetches(2);
        // The payment is priced at 80,000 (20 sats; the 16-sat quote is held), and the other request's
        // fetch moves the rates to 64,000 before the payment's hold is read.
        host.release([80_000, 64_000]);

        const paid = await paying;
        expect(paid.status).toBe(200);
        expect(((await paid.json()) as Job).summary).toBe("result:raced");
        expect((await other).status).toBe(402);
      }, 60_000);

      it("accepts a payment covering the previous rate snapshot's amount, not one two snapshots back", async () => {
        const host = await startHost(signed);
        const before = await paymentRequest(host, "held");
        expect(before.amount?.toNumber()).toBe(16);

        host.setRate(80_000);
        const paid = await submit(host, "held", await payRequest(before));
        expect(paid.status).toBe(200);
        expect(((await paid.json()) as Job).summary).toBe("result:held");

        const stale = await paymentRequest(host, "stale");
        expect(stale.amount?.toNumber()).toBe(20);
        host.setRate(64_000);
        await expectRefused(await submit(host, "stale", await payRequest(before)), 400, "payment_insufficient");
      }, 60_000);
    });
  }

  it("returns the unchanged accepted response at expiry and leaves the result available to polling", async () => {
    const gate = handlerGate();
    const host = await startHost(false, { wait: 1, onStart: gate.enter });
    const token = await payRequest(await paymentRequest(host, "slow"));
    const paid = await submit(host, "slow", token);
    expect(paid.status).toBe(inlineContract.fallback.status);
    const job = await paid.json() as Required<Pick<Job, "job_id" | "job_token">>;
    for (const field of inlineContract.fallback.requiredFields) expect(job).toHaveProperty(field);
    expect(job).not.toHaveProperty("status");
    expect(job).not.toHaveProperty("summary");
    expect(paid.headers.get(inlineContract.identityHeader)).toBe(job.job_id);
    gate.release();
    await expect.poll(async () => {
      const response = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, { headers: { "X-Job-Token": job.job_token } });
      const body = await response.json() as { messages: { type: string; content: { summary?: string } }[] };
      return body.messages.find((message) => message.type === "complete")?.content.summary;
    }, { timeout: 10_000 }).toBe("result:slow");
  }, 30_000);

  it("keeps oversized artifacts on the messages endpoint", async () => {
    const gate = handlerGate();
    const data = "x".repeat(inlineContract.artifacts.maxMessagesBytes + 1);
    const host = await startHost(false, { artifact: { mime_type: "application/json", data }, onStart: gate.enter });
    const token = await payRequest(await paymentRequest(host, "large"));
    const processingRead = host.nextProcessingRead();
    const paying = submit(host, "large", token);
    await processingRead;
    gate.release();
    const paid = await paying;
    expect(paid.status).toBe(inlineContract.artifacts.overCap.status);
    const job = await paid.json();
    expect(job).toMatchObject(inlineContract.artifacts.overCap.body);
    for (const field of inlineContract.artifacts.overCap.omittedFields) expect(job).not.toHaveProperty(field);
    const history = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, { headers: { "X-Job-Token": job.job_token } });
    expect((await history.json()).messages.find((message: { type: string }) => message.type === "artifact").content.data).toBe(data);
  }, 30_000);

  it("omits content redacted during the durable message read", async () => {
    const gate = handlerGate();
    const host = await startHost(false, { artifact: inlineContract.artifacts.artifact, redactOnMessageRead: true, onStart: gate.enter });
    const token = await payRequest(await paymentRequest(host, "redacted"));
    const processingRead = host.nextProcessingRead();
    const paying = submit(host, "redacted", token);
    await processingRead;
    gate.release();
    const paid = await paying;
    expect(paid.status).toBe(200);
    const job = await paid.json();
    expect(job).toMatchObject({ content_available: false, has_artifacts: false });
    expect(job).not.toHaveProperty("messages");
    expect(job).not.toHaveProperty("summary");
    const history = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, { headers: { "X-Job-Token": job.job_token } });
    expect((await history.json()).messages).toEqual([]);
  }, 30_000);

  it.each(["signed", "request-id"])("does not inline completed artifact messages for %s submits", async (scope) => {
    const host = await startHost(scope === "signed", { artifact: inlineContract.artifacts.artifact });
    const token = await payRequest(await paymentRequest(host, "scope"));
    const data = scope === "signed"
      ? createSignedRequestVerifier(signedSchema, { domain: { audience: host.info.auth_audience!, method: "POST", path: "/v1/job", capability: "paid" } })
        .signRequest(new Uint8Array(32).fill(5), { text: "scope" })
      : { text: "scope" };
    const paid = await fetch(`${host.url}/v1/job`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Cashu": token, "X-Cashu-Request-Id": randomUUID() },
      body: JSON.stringify({ capability: "paid", data }),
    });
    expect(paid.status).toBe(200);
    const job = await paid.json();
    expect(job).toMatchObject(inlineContract.artifacts.body);
    expect(job).not.toHaveProperty("messages");
  }, 30_000);

  it("recovers a still-running job after disconnect without running it twice", async () => {
    let runs = 0;
    const gate = handlerGate();
    const host = await startHost(false, { onStart: () => { runs++; return gate.enter(); } });
    const token = await payRequest(await paymentRequest(host, "disconnected"));
    const controller = new AbortController();
    const firstProcessingRead = host.nextProcessingRead();
    const first = submit(host, "disconnected", token, undefined, controller.signal);
    const dropped = expect(first).rejects.toThrow();
    await firstProcessingRead;
    controller.abort();
    await dropped;
    const replayProcessingRead = host.nextProcessingRead();
    const recovering = submit(host, "disconnected", token);
    await replayProcessingRead;
    gate.release();
    const retry = await recovering;
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ summary: "result:disconnected", status: "completed" });
    expect(runs).toBe(1);
  }, 30_000);

  it("returns awaiting-input promptly instead of waiting for the deadline", async () => {
    const gate = handlerGate();
    const host = await startHost(false, { wait: 20, prompt: true, onStart: gate.enter });
    const token = await payRequest(await paymentRequest(host, "prompt"));
    const processingRead = host.nextProcessingRead();
    const paying = submit(host, "prompt", token);
    await processingRead;
    const releasedAt = performance.now();
    gate.release();
    const paid = await paying;
    expect(paid.status).toBe(202);
    expect(await paid.json()).toMatchObject({ status: "awaiting-input", job_id: expect.any(String), job_token: expect.any(String) });
    expect(performance.now() - releasedAt).toBeLessThan(5000);
  }, 30_000);

  it("returns failure inline with the same status mapping as replay", async () => {
    const gate = handlerGate();
    const host = await startHost(false, { fail: true, onStart: gate.enter });
    const token = await payRequest(await paymentRequest(host, "fail"));
    const processingRead = host.nextProcessingRead();
    const paying = submit(host, "fail", token);
    await processingRead;
    gate.release();
    const paid = await paying;
    expect(paid.status).toBe(202);
    const job = await paid.json();
    const state = await fetch(`${host.url}/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token } });
    expect(await state.json()).toMatchObject({ status: "failed" });
    const retry = await submit(host, "fail", token);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject(job);
  }, 30_000);

  it.each(["disabled", "request-id", "signed"])("keeps asynchronous submits immediate for %s callers", async (scope) => {
    const gate = handlerGate();
    const host = await startHost(scope === "signed", { wait: scope === "disabled" ? 0 : 20, onStart: gate.enter });
    const request = await paymentRequest(host, "scope");
    const token = await payRequest(request);
    const started = Date.now();
    let paid: Response;
    if (scope === "signed") {
      const signer = createSignedRequestVerifier(signedSchema, {
        domain: { audience: host.info.auth_audience!, method: "POST", path: "/v1/job", capability: "paid" },
      });
      paid = await fetch(`${host.url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Cashu": token, "X-Cashu-Request-Id": randomUUID() },
        body: JSON.stringify({ capability: "paid", data: signer.signRequest(new Uint8Array(32).fill(5), { text: "scope" }) }),
      });
    } else paid = await submit(host, "scope", token, scope === "request-id" ? randomUUID() : undefined);
    expect(paid.status).toBe(202);
    expect(await paid.json()).not.toHaveProperty("summary");
    expect(Date.now() - started).toBeLessThan(8000);
    gate.release();
  }, 30_000);

  it("keeps the signed 402 free of a payment request it could not accept without a request id", async () => {
    const host = await startHost(true);
    const signer = createSignedRequestVerifier(signedSchema, {
      domain: { audience: host.info.auth_audience!, method: "POST", path: "/v1/job", capability: "paid" },
    });
    const res = await fetch(`${host.url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "paid", data: signer.signRequest(new Uint8Array(32).fill(5), { text: "signed" }) }),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("X-Cashu")).toBeNull();
  }, 30_000);

  it("exposes X-Cashu to browser wallets on a preflight", async () => {
    const host = await startHost(false);
    const res = await fetch(`${host.url}/v1/job`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://wallet.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-cashu",
      },
    });
    expect(res.headers.get("Access-Control-Expose-Headers")?.split(",")).toContain("X-Cashu");
  }, 30_000);
});
