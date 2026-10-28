/*
 * A replayed Cashu payment recovers a prior job only under the request id its
 * proofs were accepted with. Real host, real local mint, no mocked payment layer.
 */
import { randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { secp256k1Auth } from "../secp256k1-auth";
import { serve } from "../serve";
import { createSignedRequestVerifier } from "../signed-request";

const live = await localMintAvailable();

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

const FIRST_KEY = new Uint8Array(32).fill(5);
const OTHER_KEY = new Uint8Array(32).fill(6);

interface Host {
  url: string;
  info: { auth_audience: { dvm_id: string; builder_pubkey: string }; cashu: { lock_pubkeys: string[] } };
  signed: boolean;
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function startHost(signed: boolean): Promise<Host> {
  const descriptor = configureDVM({
    name: "cashu-replay-binding",
    capabilities: {
      paid: {
        input: signed ? signedSchema : z.object({ text: z.string().min(1) }),
        price: "$0.016",
        onJob(ctx) {
          ctx.complete(`result:${(ctx.input as { text: string }).text}`);
        },
      },
    },
    ...(signed ? { auth: secp256k1Auth({ allowUnsignedPaid: true }) } : {}),
  });
  const running = await serve(descriptor, { devMode: true, port: 0, env: {}, mints: [LOCAL_MINT_URL], fx });
  closers.push(() => running.close());
  const info = (await (await fetch(`${running.url}/v1/info`)).json()) as Host["info"];
  return { url: running.url, info, signed };
}

function body(host: Host, text: string, key?: Uint8Array): unknown {
  if (!key) return { capability: "paid", data: { text } };
  const signer = createSignedRequestVerifier(signedSchema, {
    domain: { audience: host.info.auth_audience, method: "POST", path: "/v1/job", capability: "paid" },
  });
  return { capability: "paid", data: signer.signRequest(key, { text }) };
}

function submit(host: Host, payload: unknown, proofs: Proof[], requestId: string): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Cashu": getEncodedToken({ mint: LOCAL_MINT_URL, proofs }),
      "X-Cashu-Request-Id": requestId,
    },
    body: JSON.stringify(payload),
  });
}

/** Mint test sats and lock `count` proof sets of `sats` each to the host. */
async function lockedProofs(host: Host, count: number, locktime?: number): Promise<Proof[][]> {
  const sats = 16;
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(sats * count * 2);
  let paid = await wallet.checkMintQuoteBolt11(quote.quote);
  for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    paid = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  let proofs: Proof[] = await wallet.mintProofsBolt11(sats * count * 2, paid);
  const sets: Proof[][] = [];
  for (let n = 0; n < count; n++) {
    const preview = await wallet.ops
      .send(sats, proofs)
      .asP2PK({
        pubkey: host.info.cashu.lock_pubkeys[0]!,
        ...(locktime !== undefined && { locktime, refundKeys: ["02" + "ef".repeat(32)] }),
      })
      .includeFees(true)
      .prepare();
    const swapped = await wallet.completeSwap(preview);
    sets.push(swapped.send);
    proofs = swapped.keep;
  }
  return sets;
}

interface Job {
  job_id?: string;
  job_token?: string;
  summary?: string;
  error?: string;
}

async function paidJob(host: Host, proofs: Proof[], requestId: string, payload: unknown): Promise<Job> {
  const res = await submit(host, payload, proofs, requestId);
  expect(res.status).toBe(200);
  const job = (await res.json()) as Job;
  expect(job.job_token).toMatch(/^[0-9a-f]{64}$/);
  return job;
}

async function expectRefusedWithout(res: Response, job: Job): Promise<void> {
  expect(res.status).toBe(409);
  const text = await res.text();
  expect((JSON.parse(text) as Job).error).toBe("replay_rejected");
  expect(text).not.toContain(job.job_token!);
  expect(text).not.toContain(job.job_id!);
}

/** The prior job is untouched: it still reads under its own token, with its own result. */
async function expectIntact(host: Host, job: Job, text: string): Promise<void> {
  const res = await fetch(`${host.url}/v1/job/${job.job_id}`, { headers: { "X-Job-Token": job.job_token! } });
  expect(res.status).toBe(200);
  expect(JSON.stringify(await res.json())).toContain(`result:${text}`);
}

describe.skipIf(!live)("Cashu replay recovery is bound to the proofs' own request id", () => {
  const callers = [
    { dvm: "a DVM without auth", signed: false, key: undefined, other: undefined },
    { dvm: "a signed-request DVM, unsigned callers", signed: true, key: undefined, other: undefined },
    { dvm: "a signed-request DVM, signed callers", signed: true, key: FIRST_KEY, other: OTHER_KEY },
  ] as const;

  for (const caller of callers) {
    describe(`on ${caller.dvm}`, () => {
      it("recovers no job for proofs accepted under a different request id than the one presented", async () => {
        const host = await startHost(caller.signed);
        const [firstProofs, secondProofs] = await lockedProofs(host, 2);
        const firstId = randomUUID();
        const first = await paidJob(host, firstProofs!, firstId, body(host, "first", caller.key));
        await paidJob(host, secondProofs!, randomUUID(), body(host, "second", caller.other));

        const presented = await submit(host, body(host, "first", caller.other), secondProofs!, firstId);
        await expectRefusedWithout(presented, first);
        await expectIntact(host, first, "first");
      }, 30_000);

      it("recovers the original job for the same proofs, request id and body", async () => {
        const host = await startHost(caller.signed);
        const [proofs] = await lockedProofs(host, 1);
        const requestId = randomUUID();
        const original = await paidJob(host, proofs!, requestId, body(host, "mine", caller.key));

        const retry = await submit(host, body(host, "mine", caller.key), proofs!, requestId);
        expect(retry.status).toBe(200);
        const recovered = (await retry.json()) as Job;
        expect(recovered.job_id).toBe(original.job_id);
        expect(recovered.job_token).toBe(original.job_token);
        expect(recovered.summary).toBe("result:mine");
      }, 30_000);

      it("still recovers after the proofs' locktime has fallen below the floor", async () => {
        const host = await startHost(caller.signed);
        const t0 = Date.now();
        const [proofs] = await lockedProofs(host, 1, Math.floor(t0 / 1000) + 7 * 86_400);
        const requestId = randomUUID();
        const original = await paidJob(host, proofs!, requestId, body(host, "aged", caller.key));

        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(t0 + 36 * 60 * 60 * 1000);
        const retry = await submit(host, body(host, "aged", caller.key), proofs!, requestId);
        expect(retry.status).toBe(200);
        const recovered = (await retry.json()) as Job;
        expect(recovered.job_id).toBe(original.job_id);
        expect(recovered.job_token).toBe(original.job_token);
      }, 30_000);

      it("recovers neither job when the presented proofs were accepted under two request ids", async () => {
        const host = await startHost(caller.signed);
        const [firstProofs, secondProofs] = await lockedProofs(host, 2);
        const firstId = randomUUID();
        const secondId = randomUUID();
        const first = await paidJob(host, firstProofs!, firstId, body(host, "first", caller.key));
        const second = await paidJob(host, secondProofs!, secondId, body(host, "second", caller.key));
        const mixed = [...firstProofs!, ...secondProofs!];

        await expectRefusedWithout(await submit(host, body(host, "first", caller.key), mixed, firstId), first);
        await expectRefusedWithout(await submit(host, body(host, "second", caller.key), mixed, secondId), second);
        await expectIntact(host, first, "first");
        await expectIntact(host, second, "second");
      }, 30_000);
    });
  }

  it("refuses other proofs under a request id another payment already holds, as the Postgres store does", async () => {
    const host = await startHost(false);
    const [firstProofs, otherProofs] = await lockedProofs(host, 2);
    const requestId = randomUUID();
    const first = await paidJob(host, firstProofs!, requestId, body(host, "first"));

    const res = await submit(host, body(host, "first"), otherProofs!, requestId);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect((JSON.parse(text) as Job).error).toBe("request_id_reused");
    expect(text).not.toContain(first.job_token!);
    // Nothing was kept: the same proofs pay under a new request id.
    await paidJob(host, otherProofs!, randomUUID(), body(host, "second"));
  }, 30_000);

  it("never recovers a signed caller's job for an unsigned retry with its proofs", async () => {
    const host = await startHost(true);
    const [proofs] = await lockedProofs(host, 1);
    const requestId = randomUUID();
    const signed = await paidJob(host, proofs!, requestId, body(host, "signed", FIRST_KEY));

    await expectRefusedWithout(await submit(host, body(host, "signed"), proofs!, requestId), signed);
  }, 30_000);
});
