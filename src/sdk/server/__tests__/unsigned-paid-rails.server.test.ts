/* Unsigned paid calls take Cashu only; x402 and Tempo stay signed-only. */
import { randomBytes, randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { encodePayment } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { stubbedTempoCharge } from "../../__tests__/__helpers__/mppx-stub";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { generateEphemeralReceiptKey } from "../../../lib/receipt-key";
import { createDVMServer } from "../app";
import { createDisposableCashuStore } from "../disposable-cashu-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { wrapMppx } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger } from "./__helpers__/credit-fixtures";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));
const { verifyX402Payment } = await import("../../../lib/x402");

const live = await localMintAvailable();

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: new Date().toISOString() }),
  supportedCurrencies: () => ["usd"],
};

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const schema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  text: z.string().min(1),
});

const PRIVKEY = new Uint8Array(32).fill(6);
const LOCK_PUBKEY = `02${generateEphemeralReceiptKey().pubkey}`;
const signer = createSignedRequestVerifier(schema);
const servers = servedApps();

interface Host {
  url: string;
  ledger: MemoryCreditLedger;
  broadcast: ReturnType<typeof vi.fn>;
}

async function startHost(opts: { allowUnsignedPaid: boolean; cashu?: boolean }): Promise<Host> {
  const ledger = new MemoryCreditLedger();
  const broadcast = vi.fn(() =>
    Promise.resolve({ method: "tempo", status: "success" as const, timestamp: new Date().toISOString(), reference: "0xref" })
  );
  const tempo = stubbedTempoCharge("0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00", broadcast);
  const dvm = configureDVM({
    name: "unsigned-rails",
    capabilities: {
      paid: {
        input: schema,
        price: "$0.016",
        onJob(ctx) {
          ctx.complete("done");
        },
      },
      metered: {
        input: schema,
        price: "$0.016",
        async onJob(ctx) {
          await ctx.requestPayment(16_000, "overage");
          ctx.complete("done");
        },
      },
    },
    credit: { min: "$0.10", max: "$5.00" },
    auth: secp256k1Auth({ allowUnsignedPaid: opts.allowUnsignedPaid }),
  });
  const { app } = await createDVMServer(dvm, {
    env: { DVMKIT_TEMPO_SECRET_KEY: randomBytes(32).toString("hex") },
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: fx,
    creditLedger: durableLedger({ ledger }),
    x402: X402,
    mpp: wrapMppx(
      Mppx.create({ methods: [tempo.method], secretKey: randomBytes(32).toString("hex"), realm: "test.example" })
    ),
    ...(opts.cashu === false
      ? {}
      : {
          mints: [LOCAL_MINT_URL],
          cashuMode: "p2pk-accumulator" as const,
          lockPubkey: LOCK_PUBKEY,
          disposableCashu: createDisposableCashuStore().accumulator,
          dvmId: randomUUID(),
        }),
  });
  return { url: await servers.serve(app), ledger, broadcast };
}

function submit(host: Host, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const unsigned = { capability: "paid", data: { text: "hello" } };
const signed = () => ({ capability: "paid", data: signer.signRequest(PRIVKEY, { text: "hello" }) });

function x402Header(): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: "0xfrom",
        to: X402.payTo,
        value: "16000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"ab".repeat(32)}`,
      },
    },
  });
}

/** A well-formed Tempo charge credential bound to a challenge this host issued to a signed probe. */
async function tempoCredential(host: Host): Promise<string> {
  const probe = await submit(host, signed());
  expect(probe.status).toBe(402);
  const challenge = Challenge.fromHeadersList(probe.headers)[0];
  if (!challenge) throw new Error("signed 402 carried no Tempo challenge");
  return Credential.serialize(
    Credential.from({ challenge, payload: { type: "hash" as const, hash: `0x${"c".repeat(64)}` } })
  );
}

/** Spies on every ledger write a rail could make before a job exists. */
function ledgerWrites(ledger: MemoryCreditLedger) {
  return [vi.spyOn(ledger, "fund"), vi.spyOn(ledger, "draw"), vi.spyOn(ledger, "growDraw")];
}

async function lockedToken(sats: number): Promise<string> {
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(sats * 2);
  let paid = await wallet.checkMintQuoteBolt11(quote.quote);
  for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    paid = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  const proofs: Proof[] = await wallet.mintProofsBolt11(sats * 2, paid);
  const preview = await wallet.ops.send(sats, proofs).asP2PK({ pubkey: LOCK_PUBKEY }).includeFees(true).prepare();
  const swapped = await wallet.completeSwap(preview);
  return getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send });
}

/** Submits a Cashu-paid `metered` job and returns it once its mid-job ask is out. */
async function meteredJobAwaitingPayment(host: Host, data: object) {
  const res = await submit(
    host,
    { capability: "metered", data },
    { "X-Cashu": await lockedToken(16), "X-Cashu-Request-Id": randomUUID() }
  );
  expect(res.status).toBe(202);
  const job = (await res.json()) as { job_id: string; job_token: string };
  for (let n = 0; n < 100; n++) {
    const list = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, { headers: { "X-Job-Token": job.job_token } });
    const { messages } = (await list.json()) as { messages: { type: string; content: Record<string, unknown> }[] };
    const ask = messages.find((m) => m.type === "payment-request");
    if (ask) return { ...job, ask: ask.content };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the metered job never asked for payment");
}

function postPayment(host: Host, job: { job_id: string; job_token: string }, content: Record<string, unknown>) {
  return fetch(`${host.url}/v1/job/${job.job_id}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Job-Token": job.job_token },
    body: JSON.stringify({ type: "payment", content }),
  });
}

afterEach(() => {
  vi.mocked(verifyX402Payment).mockReset();
});

describe.skipIf(!live)("unsigned paid calls are Cashu-only", () => {
  it("offers only Cashu, with no credit menu, in the unsigned 402; the signed 402 keeps every rail", async () => {
    const [on, off] = await Promise.all([
      startHost({ allowUnsignedPaid: true }),
      startHost({ allowUnsignedPaid: false }),
    ]);

    const anon = await submit(on, unsigned);
    expect(anon.status).toBe(402);
    const anonBody = (await anon.json()) as Record<string, unknown>;
    expect(anonBody).toMatchObject({ error: "payment_required", mints: [LOCAL_MINT_URL] });
    expect(anonBody).not.toHaveProperty("accepts");
    expect(anonBody).not.toHaveProperty("x402Version");
    expect(anonBody).not.toHaveProperty("credit");
    expect(anon.headers.get("WWW-Authenticate")).toBeNull();
    expect(anon.headers.get("PAYMENT-REQUIRED")).toBeNull();

    const [signedOn, signedOff] = await Promise.all([submit(on, signed()), submit(off, signed())]);
    expect(signedOn.status).toBe(402);
    expect(signedOff.status).toBe(402);
    const [onBody, offBody] = (await Promise.all([signedOn.json(), signedOff.json()])) as Record<string, unknown>[];
    expect(Object.keys(onBody!).sort()).toEqual(Object.keys(offBody!).sort());
    expect(onBody).toHaveProperty("accepts");
    expect(onBody).toHaveProperty("credit");
    expect(signedOn.headers.get("WWW-Authenticate")).toMatch(/^Payment /);
    expect(signedOn.headers.has("PAYMENT-REQUIRED")).toBe(signedOff.headers.has("PAYMENT-REQUIRED"));
  });

  it("refuses an unsigned x402 payment before any settlement or credit write", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const writes = ledgerWrites(host.ledger);
    const facilitator = vi.spyOn(globalThis, "fetch");
    try {
      for (const header of ["X-PAYMENT", "PAYMENT-SIGNATURE"]) {
        const res = await submit(host, unsigned, { [header]: x402Header() });
        expect(res.status).toBe(402);
        expect(await res.json()).toMatchObject({ error: "payment_method_requires_signature", retryable: false });
      }
      expect(facilitator.mock.calls.some(([url]) => String(url).startsWith(X402.facilitator!))).toBe(false);
    } finally {
      facilitator.mockRestore();
    }
    expect(verifyX402Payment).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("refuses an unsigned Tempo payment before any settlement or credit write", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const credential = await tempoCredential(host);
    const writes = ledgerWrites(host.ledger);
    const res = await submit(host, unsigned, { Authorization: credential });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: "payment_method_requires_signature" });
    expect(host.broadcast).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("still settles the same Tempo credential for a signed caller", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const body = signed();
    const probe = await submit(host, body);
    const challenge = Challenge.fromHeadersList(probe.headers)[0]!;
    const credential = Credential.serialize(
      Credential.from({ challenge, payload: { type: "hash" as const, hash: `0x${"d".repeat(64)}` } })
    );
    const paid = await submit(host, body, { Authorization: credential });
    expect([200, 202]).toContain(paid.status);
    expect(host.broadcast).toHaveBeenCalledOnce();
  });

  it("asks an unsigned job for Cashu alone mid-job, while a signed job's ask keeps x402 and Tempo", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const [anon, signedJob] = await Promise.all([
      meteredJobAwaitingPayment(host, { text: "hello" }),
      meteredJobAwaitingPayment(host, signer.signRequest(PRIVKEY, { text: "hello" })),
    ]);
    expect(anon.ask).toMatchObject({ mints: [LOCAL_MINT_URL] });
    expect(anon.ask).not.toHaveProperty("x402");
    expect(anon.ask).not.toHaveProperty("tempo");
    expect(signedJob.ask).toHaveProperty("x402");
    expect(signedJob.ask).toHaveProperty("tempo");
  }, 30_000);

  it("still settles a signed job's mid-job Tempo payment on an option-on host", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const job = await meteredJobAwaitingPayment(host, signer.signRequest(PRIVKEY, { text: "hello" }));
    const challenge = (job.ask.tempo as { challenges: Parameters<typeof Credential.from>[0]["challenge"][] }).challenges[0]!;
    const credential = Credential.from({ challenge, payload: { type: "hash" as const, hash: `0x${"e".repeat(64)}` } });
    const pay = await postPayment(host, job, { tempo_credential: credential });
    expect(pay.status).toBe(201);
    expect(host.broadcast).toHaveBeenCalledOnce();
  }, 30_000);

  it("refuses an unsigned x402 mid-job payment without verifying it", async () => {
    const host = await startHost({ allowUnsignedPaid: true });
    const token = await lockedToken(16);
    const res = await submit(
      host,
      { capability: "metered", data: { text: "hello" } },
      { "X-Cashu": token, "X-Cashu-Request-Id": randomUUID() }
    );
    expect(res.status).toBe(202);
    const job = (await res.json()) as { job_id: string; job_token: string };
    const writes = ledgerWrites(host.ledger);
    const pay = await fetch(`${host.url}/v1/job/${job.job_id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Job-Token": job.job_token },
      body: JSON.stringify({ type: "payment", content: { x402_payment: x402Header() } }),
    });
    expect(pay.status).toBe(402);
    expect(await pay.json()).toMatchObject({ error: "payment_method_requires_signature" });
    expect(verifyX402Payment).not.toHaveBeenCalled();
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  }, 30_000);
});

describe("an unsigned request on a DVM without Cashu", () => {
  it("gets the auth_error a signed-only DVM gives, since it has nothing to pay with", async () => {
    const [on, off] = await Promise.all([
      startHost({ allowUnsignedPaid: true, cashu: false }),
      startHost({ allowUnsignedPaid: false, cashu: false }),
    ]);
    const [fromOn, fromOff] = await Promise.all([submit(on, unsigned), submit(off, unsigned)]);
    expect(fromOn.status).toBe(401);
    expect(await fromOn.json()).toEqual(await fromOff.json());
  });
});
