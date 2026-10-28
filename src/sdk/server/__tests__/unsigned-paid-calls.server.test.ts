/* Unsigned paid per-call jobs on a signed DVM, paid over a real local Cashu mint. */
import { randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import type { QuoteContext } from "../../types";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { serve } from "../serve";
import { createSignedRequestVerifier } from "../signed-request";
import { fundCredit } from "./__helpers__/credit-fixtures";

const live = await localMintAvailable();

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};

const schema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

const PRIVKEY = new Uint8Array(32).fill(5);
const CALLER_PUBKEY = Buffer.from(schnorr.getPublicKey(PRIVKEY)).toString("hex");

function descriptor(allowUnsignedPaid: boolean) {
  return configureDVM({
    name: "unsigned-paid",
    capabilities: {
      paid: {
        input: schema,
        price: "$0.016",
        onJob(ctx) {
          ctx.complete(`${ctx.auth?.pubkey ?? "anonymous"}:${(ctx.input as { text: string }).text}`);
        },
      },
      // Reuses the capability schema as its quote schema, envelope fields and all.
      quoted: {
        input: schema,
        onQuote: {
          schema,
          handler: (ctx: QuoteContext) =>
            Promise.resolve({
              upfront: { amount: ctx.data.text === "nothing" ? 0 : 0.016, currency: "usd" as const },
              description: "per-call price",
            }),
        },
        onJob(ctx) {
          ctx.complete(`${ctx.auth?.pubkey ?? "anonymous"}:${(ctx.input as { text: string }).text}`);
        },
      },
      free: {
        input: schema,
        onJob(ctx) {
          ctx.complete(`${ctx.auth?.pubkey ?? "anonymous"}:${(ctx.input as { text: string }).text}`);
        },
      },
    },
    auth: secp256k1Auth({ allowUnsignedPaid }),
  });
}

interface Info {
  auth: string[];
  auth_audience: { dvm_id: string; builder_pubkey: string };
  cashu: { lock_pubkeys: string[] };
}

interface Host {
  url: string;
  info: Info;
  close(): Promise<void>;
}

const hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
});

async function startHost(allowUnsignedPaid: boolean): Promise<Host> {
  const running = await serve(descriptor(allowUnsignedPaid), {
    devMode: true,
    port: 0,
    env: {},
    mints: [LOCAL_MINT_URL],
    fx,
  });
  const info = (await (await fetch(`${running.url}/v1/info`)).json()) as Info;
  const host = { url: running.url, info, close: () => running.close() };
  hosts.push(host);
  return host;
}

function sign(host: Host, capability: string, body: Record<string, unknown>) {
  return createSignedRequestVerifier(schema, {
    domain: { audience: host.info.auth_audience, method: "POST", path: "/v1/job", capability },
  }).signRequest(PRIVKEY, body);
}

function submit(host: Host, body: unknown, token?: string, requestId = randomUUID()): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-Cashu": token, "X-Cashu-Request-Id": requestId } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Mint test sats and split them into `count` tokens of `sats`, each locked to the host. */
async function lockedTokens(host: Host, sats: number, count: number): Promise<string[]> {
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(sats * count * 2);
  let paid = await wallet.checkMintQuoteBolt11(quote.quote);
  for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    paid = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  let proofs: Proof[] = await wallet.mintProofsBolt11(sats * count * 2, paid);
  const tokens: string[] = [];
  for (let n = 0; n < count; n++) {
    const preview = await wallet.ops
      .send(sats, proofs)
      .asP2PK({ pubkey: host.info.cashu.lock_pubkeys[0]! })
      .includeFees(true)
      .prepare();
    const swapped = await wallet.completeSwap(preview);
    tokens.push(getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send }));
    proofs = swapped.keep;
  }
  return tokens;
}

describe.skipIf(!live)("secp256k1Auth({ allowUnsignedPaid: true }) on a real Cashu host", () => {
  it("advertises both schemes, signed first, only when the option is on", async () => {
    const [on, off] = await Promise.all([startHost(true), startHost(false)]);
    expect(on.info.auth).toEqual(["secp256k1-schnorr-v2", "none"]);
    expect(off.info.auth).toEqual(["secp256k1-schnorr-v2"]);
  });

  it("challenges an unsigned unpaid request with a payable 402, then runs it paid as the anonymous requester", async () => {
    const host = await startHost(true);
    const unsigned = { capability: "paid", data: { text: "hello" } };

    const challenge = await submit(host, unsigned);
    expect(challenge.status).toBe(402);
    const body = (await challenge.json()) as Record<string, unknown>;
    // No quote call is needed: the challenge carries the amount and where to pay it.
    expect(body).toMatchObject({ error: "payment_required", required_msats: 16_000, price_micro: 16_000 });
    expect(JSON.stringify(body)).toContain(LOCAL_MINT_URL);

    const [token] = await lockedTokens(host, 16, 1);
    const requestId = randomUUID();
    const paid = await submit(host, unsigned, token, requestId);
    expect(paid.status).toBe(200);
    const job = (await paid.json()) as { job_id: string; job_token: string; summary?: string };
    expect(job.job_token).toMatch(/^[0-9a-f]{64}$/);
    expect(job.summary).toBe("anonymous:hello");

    // A retry with the same proofs, request id and body recovers the job;
    // the same payment under a different body does not.
    const retry = await submit(host, unsigned, token, requestId);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ job_id: job.job_id, job_token: job.job_token });
    const other = await submit(host, { capability: "paid", data: { text: "other" } }, token, requestId);
    expect(other.status).toBe(409);

    const status = await fetch(`${host.url}/v1/job/${job.job_id}`, {
      headers: { "X-Job-Token": job.job_token },
    });
    expect(status.status).toBe(200);
  }, 30_000);

  it("refuses an unsigned free request exactly as a signed-only DVM does", async () => {
    const [on, off] = await Promise.all([startHost(true), startHost(false)]);
    const unsigned = { capability: "free", data: { text: "hello" } };
    const [fromOn, fromOff] = await Promise.all([submit(on, unsigned), submit(off, unsigned)]);
    expect(fromOn.status).toBe(401);
    expect(fromOff.status).toBe(401);
    const offBody = (await fromOff.json()) as Record<string, unknown>;
    expect(offBody.error).toBe("auth_error");
    expect(await fromOn.json()).toEqual(offBody);
  });

  it("keeps refusing unsigned paid requests when the option is off", async () => {
    const host = await startHost(false);
    const [token] = await lockedTokens(host, 16, 1);
    const res = await submit(host, { capability: "paid", data: { text: "hello" } }, token);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("auth_error");
  }, 30_000);

  it.each([
    ["credit_id and draw_id", { credit_id: "c1", draw_id: "d1" }],
    ["a lone fund block", { fund: { amount_micro: 1, commitment: "0".repeat(64) } }],
  ])("refuses an unsigned body carrying %s", async (_label, fields) => {
    const host = await startHost(true);
    const res = await submit(host, { capability: "paid", data: { text: "hello", ...fields } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_credit_fields");
  });

  it("refuses an unsigned body carrying a public request id", async () => {
    const host = await startHost(true);
    const res = await submit(host, { capability: "paid", data: { text: "hello", request_id: "r-1" } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: "request_recovery_unsupported",
      message: "Public request ids require a signed request.",
    });
  });

  it("prices an unsigned request through onQuote: 402, then paid; a zero quote is refused", async () => {
    const host = await startHost(true);
    const unsigned = { capability: "quoted", data: { text: "hello" } };

    const challenge = await submit(host, unsigned);
    const challengeBody = await challenge.json();
    expect(challengeBody).toMatchObject({ error: "payment_required", required_msats: 16_000 });
    expect(challenge.status).toBe(402);

    const [token] = await lockedTokens(host, 16, 1);
    const paid = await submit(host, unsigned, token);
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { summary?: string }).summary).toBe("anonymous:hello");

    const zero = await submit(host, { capability: "quoted", data: { text: "nothing" } });
    expect(zero.status).toBe(401);
    expect(await zero.json()).toMatchObject({ error: "auth_error" });
  }, 30_000);

  it("verifies any envelope field and never falls back to unsigned, before touching the payment", async () => {
    const host = await startHost(true);
    const [token] = await lockedTokens(host, 16, 1);
    const tampered = { ...sign(host, "paid", { text: "hello" }), text: "changed" };
    const bad = await submit(host, { capability: "paid", data: tampered }, token);
    expect(bad.status).toBe(401);
    expect(await bad.json()).toMatchObject({ error: "auth_error", sub_reason: "signature_invalid" });

    const partial = await submit(host, { capability: "paid", data: { text: "hello", nonce: "abcdefgh" } }, token);
    expect(partial.status).toBe(401);

    // Neither refusal spent the attached proofs.
    const paid = await submit(host, { capability: "paid", data: { text: "hello" } }, token);
    expect(paid.status).toBe(200);
  }, 30_000);

  it("runs a signed paid request as before: unpaid probe keeps the nonce, payment burns it", async () => {
    const host = await startHost(true);
    const [first, second] = await lockedTokens(host, 16, 2);
    const signed = { capability: "paid", data: sign(host, "paid", { text: "hello" }) };

    expect((await submit(host, signed)).status).toBe(402);
    const paid = await submit(host, signed, first);
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { summary?: string }).summary).toBe(`${CALLER_PUBKEY}:hello`);

    const replay = await submit(host, signed, second);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ sub_reason: "replay_detected" });
  }, 30_000);
});

describe("signed credit draws with allowUnsignedPaid on", () => {
  const servers = servedApps();

  it("pays a signed job from prepaid credit and returns the original job on a draw retry", async () => {
    const ledger = new MemoryCreditLedger();
    const { app } = await createDVMServer(descriptor(true), {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: fx,
      creditLedger: ledger,
    });
    const url = await servers.serve(app);
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: Date.now() + 86_400_000,
    });
    const signer = createSignedRequestVerifier(schema);
    const draw = () =>
      fetch(`${url}/v1/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: "paid",
          data: signer.signRequest(PRIVKEY, { text: "hello", credit_id: "c1", draw_id: "d1" }),
        }),
      });

    const first = await draw();
    expect(first.status).toBe(200);
    const original = (await first.json()) as { job_id: string; summary?: string };
    expect(original.summary).toBe(`${CALLER_PUBKEY}:hello`);

    const retry = await draw();
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { job_id: string }).job_id).toBe(original.job_id);
    expect((await ledger.get("c1"))?.balanceMicro).toBe(1_000_000 - 16_000);
  });
});
