/* Builder-set Cashu refund-locktime floors, paid over a real local Cashu mint. */
import { randomUUID } from "node:crypto";

import { getEncodedToken, type Proof, Wallet } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { LOCAL_MINT_URL, localMintAvailable } from "../../../lib/cashu/__tests__/__helpers__/local-mint";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import type { CashuConfig } from "../../types";
import { secp256k1Auth } from "../secp256k1-auth";
import { serve } from "../serve";
import { createSignedRequestVerifier } from "../signed-request";

const live = await localMintAvailable();

const HOUR = 3_600;
const DAY = 86_400;

// The 0.17.1 hint, which a DVM on the default floors must keep serving verbatim.
const DEFAULT_LOCK_HINT =
  "Lock a fresh token with data set to cashu.lock_pubkeys[0] from /v1/info as a 33-byte compressed hex key. Use only the locktime, refund, pubkeys, n_sigs, sigflag and n_sigs_refund tags, each once and with a value: pubkeys may list only other cashu.lock_pubkeys entries, n_sigs must be 1, sigflag SIG_INPUTS, refund keys compressed and distinct, n_sigs_refund at most the number of refund keys, and any locktime at least cashu.min_locktime minus 24 hours in the future.";

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
const unsignedSchema = z.object({ text: z.string().min(1) });

const CALLER_PRIVKEY = new Uint8Array(32).fill(7);
const REFUND_KEY = `02${Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(9))).toString("hex")}`;

interface Info {
  auth?: string[];
  auth_audience?: { dvm_id: string; builder_pubkey: string };
  cashu: { lock_pubkeys: string[]; min_locktime: number; unsigned_min_locktime?: number };
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

async function startHost(opts: { auth: "signed" | "none"; cashu?: CashuConfig }): Promise<Host> {
  const dvm =
    opts.auth === "signed"
      ? configureDVM({
          name: "locktime-floor",
          capability: "paid",
          input: schema,
          price: "$0.016",
          ...(opts.cashu && { cashu: opts.cashu }),
          auth: secp256k1Auth({ allowUnsignedPaid: true }),
          onJob(ctx) {
            ctx.complete(ctx.auth?.pubkey ?? "anonymous");
          },
        })
      : configureDVM({
          name: "locktime-floor-open",
          capability: "paid",
          input: unsignedSchema,
          price: "$0.016",
          ...(opts.cashu && { cashu: opts.cashu }),
          onJob(ctx) {
            ctx.complete("anonymous");
          },
        });
  const running = await serve(dvm, { devMode: true, port: 0, env: {}, mints: [LOCAL_MINT_URL], fx });
  const info = (await (await fetch(`${running.url}/v1/info`)).json()) as Info;
  const host = { url: running.url, info, close: () => running.close() };
  hosts.push(host);
  return host;
}

function signed(host: Host, text: string) {
  const data = createSignedRequestVerifier(schema, {
    domain: { audience: host.info.auth_audience!, method: "POST", path: "/v1/job", capability: "paid" },
  }).signRequest(CALLER_PRIVKEY, { text });
  return { capability: "paid", data };
}

function unsigned(text: string) {
  return { capability: "paid", data: { text } };
}

/** Pay with `X-Cashu-Request-Id`, as the reference caller does. */
function submit(host: Host, body: unknown, token: string): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cashu": token, "X-Cashu-Request-Id": randomUUID() },
    body: JSON.stringify(body),
  });
}

/** Pay with the token alone, as a NUT-24 wallet does. */
function submitNut24(host: Host, body: unknown, token: string): Promise<Response> {
  return fetch(`${host.url}/v1/job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Cashu": token },
    body: JSON.stringify(body),
  });
}

/**
 * Mint test sats into one token per entry of `locktimesFromNow`, each locked
 * to the host with a refund path to a payer key opening that many seconds
 * from now.
 */
async function refundableTokens(host: Host, locktimesFromNow: number[]): Promise<string[]> {
  const sats = 16;
  const wallet = new Wallet(LOCAL_MINT_URL);
  await wallet.loadMint();
  const total = sats * locktimesFromNow.length * 2;
  const quote = await wallet.createMintQuoteBolt11(total);
  let paid = await wallet.checkMintQuoteBolt11(quote.quote);
  for (let n = 0; paid.state !== "PAID" && n < 100; n++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    paid = await wallet.checkMintQuoteBolt11(quote.quote);
  }
  let proofs: Proof[] = await wallet.mintProofsBolt11(total, paid);
  const tokens: string[] = [];
  for (const fromNow of locktimesFromNow) {
    const preview = await wallet.ops
      .send(sats, proofs)
      .asP2PK({
        pubkey: host.info.cashu.lock_pubkeys[0]!,
        locktime: Math.floor(Date.now() / 1000) + fromNow,
        refundKeys: [REFUND_KEY],
      })
      .includeFees(true)
      .prepare();
    const swapped = await wallet.completeSwap(preview);
    tokens.push(getEncodedToken({ mint: LOCAL_MINT_URL, proofs: swapped.send }));
    proofs = swapped.keep;
  }
  return tokens;
}

async function refusal(res: Response): Promise<{ status: number; error: unknown; hint: unknown }> {
  const body = (await res.json()) as { error?: unknown; hint?: unknown };
  return { status: res.status, error: body.error, hint: body.hint };
}

describe.skipIf(!live)("Cashu refund-locktime floors on a real Cashu host", () => {
  it("keeps the default floors, /v1/info block and hint when the builder sets none", async () => {
    const host = await startHost({ auth: "signed" });
    expect(host.info.cashu.min_locktime).toBe(604_800);
    expect(host.info.cashu).not.toHaveProperty("unsigned_min_locktime");

    // A 24-hour refund path is below the 6-day enforced floor on every path.
    // A NUT-24 payment's payer-fixable refusal answers 400.
    const [lock, atFloor] = await refundableTokens(host, [DAY, 6 * DAY + 5 * 60]);
    const refused = { error: "lock_not_exclusive", hint: DEFAULT_LOCK_HINT };
    expect(await refusal(await submitNut24(host, unsigned("u"), lock!))).toEqual({ status: 400, ...refused });
    expect(await refusal(await submit(host, unsigned("u"), lock!))).toEqual({ status: 402, ...refused });
    expect(await refusal(await submit(host, signed(host, "s"), lock!))).toEqual({ status: 402, ...refused });
    expect((await submitNut24(host, unsigned("at floor"), atFloor!)).status).toBe(200);
  }, 60_000);

  it("judges a NUT-24 payment against the unsigned floor and a signed one against the signed floor", async () => {
    const host = await startHost({ auth: "signed", cashu: { unsignedMinLocktimeSeconds: 12 * HOUR } });
    expect(host.info.cashu.min_locktime).toBe(604_800);
    expect(host.info.cashu.unsigned_min_locktime).toBe(12 * HOUR);

    const [banked, forSigned, tooShort] = await refundableTokens(host, [DAY, DAY, HOUR]);
    const accepted = await submitNut24(host, unsigned("wallet"), banked!);
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { summary?: string }).summary).toBe("anonymous");

    expect(await refusal(await submit(host, signed(host, "same lock"), forSigned!))).toEqual({
      status: 402,
      error: "lock_not_exclusive",
      hint: DEFAULT_LOCK_HINT,
    });
    const short = await refusal(await submitNut24(host, unsigned("short"), tooShort!));
    expect(short).toMatchObject({ status: 400, error: "lock_not_exclusive" });
    expect(short.hint).toContain("any locktime at least cashu.unsigned_min_locktime seconds in the future.");

    // Proofs banked under the unsigned floor sit below the signed one; a
    // signed presentation of them is still the replay it is.
    const replay = await refusal(await submit(host, signed(host, "replay"), banked!));
    expect(replay).toMatchObject({ status: 409, error: "replay_rejected" });
  }, 60_000);

  it("enforces a configured signed floor at min_locktime minus 24 hours", async () => {
    const host = await startHost({ auth: "signed", cashu: { minLocktimeSeconds: 2 * DAY } });
    expect(host.info.cashu.min_locktime).toBe(2 * DAY);

    const [above, below] = await refundableTokens(host, [DAY + 5 * 60, DAY - 5 * 60]);
    expect((await submit(host, signed(host, "above"), above!)).status).toBe(200);
    expect(await refusal(await submit(host, signed(host, "below"), below!))).toEqual({
      status: 402,
      error: "lock_not_exclusive",
      hint: DEFAULT_LOCK_HINT,
    });
  }, 60_000);

  it("on a DVM without auth, holds a payment with a request id to the signed floor and a NUT-24 one to the unsigned floor", async () => {
    const host = await startHost({ auth: "none", cashu: { unsignedMinLocktimeSeconds: 12 * HOUR } });
    expect(host.info.cashu.unsigned_min_locktime).toBe(12 * HOUR);

    // A refused payment records nothing, so the same 24-hour lock is then
    // presented without the header.
    const [lock, tooShort] = await refundableTokens(host, [DAY, HOUR]);
    expect(await refusal(await submit(host, unsigned("with id"), lock!))).toEqual({
      status: 402,
      error: "lock_not_exclusive",
      hint: DEFAULT_LOCK_HINT,
    });
    expect((await submitNut24(host, unsigned("nut-24"), lock!)).status).toBe(200);
    const short = await refusal(await submitNut24(host, unsigned("short"), tooShort!));
    expect(short).toMatchObject({ status: 400, error: "lock_not_exclusive" });
    expect(short.hint).toContain("cashu.unsigned_min_locktime");
  }, 60_000);
});
