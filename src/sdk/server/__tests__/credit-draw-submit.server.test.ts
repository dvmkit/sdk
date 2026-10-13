/* Signed credit draws use pure-signature replay protection, without a funding artifact. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { JobReceipt } from "../../../lib/receipt";
import { verifyReceipt } from "../../../lib/receipt";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedgerError } from "../credit-ledger";
import { derivedFundCreditId, fundingCommitment } from "../funding";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { fundCredit } from "./__helpers__/credit-fixtures";
import { expectJobIdentity } from "./__helpers__/job-identity";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const strictSchema = signedSchema.strict();

const PRIVKEY = new Uint8Array(32).fill(7);
const OTHER_PRIVKEY = new Uint8Array(32).fill(9);
const CALLER_PUBKEY = hex(schnorr.getPublicKey(PRIVKEY));
const RECEIPT_KEY = "11".repeat(32);
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;

const PRICE_MICRO = 100_000;

const signer = createSignedRequestVerifier(signedSchema);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

interface SubmitBody {
  job_id?: string;
  job_token?: string;
  status?: string;
  error?: string;
  remaining_micro?: number;
  shortfall_micro?: number;
  display?: string;
  hint?: string;
  retryable?: boolean;
  receipt?: JobReceipt;
}

const servers = servedApps();

async function startServer(
  ledger = new MemoryCreditLedger(),
  opts?: { onDelayedJob?: () => Promise<void> }
): Promise<{ url: string; ledger: MemoryCreditLedger }> {
  const dvm = configureDVM({
    name: "credit-draw-test",
    capabilities: {
      do: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.complete("done");
        },
      },
      boom: {
        input: signedSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.fail("nope");
        },
      },
      delayed: {
        input: signedSchema,
        price: "$0.10",
        async onJob(ctx) {
          await opts?.onDelayedJob?.();
          ctx.complete("done");
        },
      },

      strict: {
        input: strictSchema,
        price: "$0.10",
        onJob(ctx) {
          ctx.complete("done");
        },
      },
    },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    receiptKey: RECEIPT_KEY,
    creditLedger: ledger,
  });
  const url = await servers.serve(app);
  return { url, ledger };
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

function drawBody(
  capability: string,
  fields: Record<string, unknown>,
  privkey: Uint8Array = PRIVKEY
): unknown {
  return { capability, data: signer.signRequest(privkey, { action: "go", ...fields }) };
}

describe("explicit credit draws", () => {
  it("pays a job from the credit, settles the draw, and countersigns the receipt", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");

    const receipt = body.receipt;
    if (!receipt) throw new Error("submit response carried no receipt");
    expect(verifyReceipt(receipt)).toBe(true);
    expect(receipt.credit).toEqual({
      credit_id: "c1",
      draw_id: "d1",
      amount: PRICE_MICRO,
      balance_after: 1_000_000 - PRICE_MICRO,
      ledger_seq: 1,
    });

    const draw = await ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.status).toBe("settled");
    const snap = await ledger.get("c1");
    expect(snap?.balanceMicro).toBe(1_000_000 - PRICE_MICRO);
    expect(snap?.availableMicro).toBe(1_000_000 - PRICE_MICRO);
  });

  it("double-submit with the same draw_id debits once and returns the original job", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const first = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    const original = (await first.json()) as SubmitBody;
    expect(first.status).toBe(200);

    // The resume sweep re-signs on every attempt: fresh nonce/timestamp,
    // same caller, same request, same draw_id.
    const replay = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    const recovered = (await replay.json()) as SubmitBody;
    expect(replay.status).toBe(200);
    expectJobIdentity(replay, recovered);
    expect(recovered.job_id).toBe(original.job_id);
    expect(recovered.job_token).toBe(original.job_token);

    const snap = await ledger.get("c1");
    expect(snap?.lastLedgerSeq).toBe(1);
    expect(snap?.balanceMicro).toBe(1_000_000 - PRICE_MICRO);
  });

  it("refuses a replayed draw_id whose body differs (fingerprint gate)", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const first = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    expect(first.status).toBe(200);

    const replay = await submit(url, {
      capability: "do",
      data: signer.signRequest(PRIVKEY, {
        action: "DIFFERENT",
        credit_id: "c1",
        draw_id: "d1",
      }),
    });
    const body = (await replay.json()) as SubmitBody;
    expect(replay.status).toBe(409);
    expect(body.error).toBe("draw_conflict");
    expect(body.job_token).toBeUndefined();
  });

  it("refuses a draw against someone else's credit", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(
      url,
      drawBody("do", { credit_id: "c1", draw_id: "d-thief" }, OTHER_PRIVKEY)
    );
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("payment_invalid");
    const draw = await ledger.getDraw({ creditId: "c1", drawId: "d-thief" });
    expect(draw).toBeUndefined();
  });

  it("rejects tampered credit fields — the signature covers them", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const signed = signer.signRequest(PRIVKEY, {
      action: "go",
      credit_id: "c1",
      draw_id: "d1",
    }) as unknown as Record<string, unknown>;
    const res = await submit(url, {
      capability: "do",
      data: { ...signed, draw_id: "d-swapped" },
    });
    expect(res.status).toBe(401);
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d-swapped" })).toBeUndefined();
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toBeUndefined();
  });

  it("returns structured insufficient_credit with the available balance", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("insufficient_credit");

    expect(body.remaining_micro).toBe(50_000);
    expect(body.shortfall_micro).toBe(50_000);
    const snap = await ledger.get("c1");
    expect(snap?.balanceMicro).toBe(50_000);
    expect(snap?.lastLedgerSeq).toBe(0);
  });

  it("returns a typed refusal when the credit's Tempo channel is closing", async () => {
    const ledger = new MemoryCreditLedger();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });
    vi.spyOn(ledger, "draw").mockRejectedValue(
      new CreditLedgerError(
        "tempo_channel_closing",
        "credit c1 is bound to a Tempo channel that is closing or finalized"
      )
    );
    const { url } = await startServer(ledger);

    const res = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "tempo_channel_closing",
      retryable: false,
      display: expect.stringContaining("channel has started closing"),
      hint: expect.stringContaining("pay per call"),
    });
  });

  it("releases the draw on a failed job — receipt shows the balance restored", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("boom", { credit_id: "c1", draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;
    // Only `completed` earns a 200 on the synchronous submit; a failed
    // terminal answers 202 with the terminal fields (incl. receipt) attached.
    expect(res.status).toBe(202);

    const receipt = body.receipt;
    expect(receipt?.outcome).toBe("failed");

    expect(receipt?.credit).toEqual({
      credit_id: "c1",
      draw_id: "d1",
      amount: PRICE_MICRO,
      balance_after: 1_000_000,
      ledger_seq: 1,
    });
    const draw = await ledger.getDraw({ creditId: "c1", drawId: "d1" });
    expect(draw?.status).toBe("released");
    const snap = await ledger.get("c1");
    expect(snap?.balanceMicro).toBe(1_000_000);
    expect(snap?.availableMicro).toBe(1_000_000);
  });

  it("countersigns zero when Tempo backing disappears before a completed job resolves", async () => {
    let markStarted: (() => void) | undefined;
    let unblock: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const ledger = new MemoryCreditLedger();
    const { url } = await startServer(ledger, {
      onDelayedJob: async () => {
        markStarted?.();
        await blocked;
      },
    });
    const channelId = `0x${"91".repeat(32)}`;
    await fundCredit(ledger, {
      creditId: "tempo-loss",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 1_000_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "1000000" },
      },
    });

    const pending = submit(
      url,
      drawBody("delayed", { credit_id: "tempo-loss", draw_id: "lost-draw" })
    );
    await started;
    await ledger.terminalizeTempoCredits({
      channelId,
      settledOnChainNative: 0n,
      highestVoucherNative: 100_000n,
      consumedNative: 100_000n,
    });
    unblock?.();

    const res = await pending;
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(200);
    expect(body.receipt?.credit).toEqual({
      credit_id: "tempo-loss",
      draw_id: "lost-draw",
      amount: PRICE_MICRO,
      balance_after: 0,
      ledger_seq: 1,
    });
    expect(await ledger.getDraw({ creditId: "tempo-loss", drawId: "lost-draw" })).toMatchObject({
      status: "released",
    });
  });

  it("rejects a funding commitment that doesn't hash the attached artifact — before any rail work", async () => {
    const { url, ledger } = await startServer();

    const res = await submit(
      url,
      drawBody("do", {
        credit_id: "c-new",
        draw_id: "d1",
        fund: { amount_micro: PRICE_MICRO, commitment: fundingCommitment("not-the-artifact") },
      }),
      { "X-Cashu": "cashuAdeadbeef", "X-Cashu-Request-Id": "req-1" }
    );
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("funding_commitment_mismatch");
    expect(await ledger.get("c-new")).toBeUndefined();
  });

  it("refuses to OPEN a credit at a server-derived id", async () => {
    const { url, ledger } = await startServer();
    // Fund-and-draw at an id that doesn't exist yet creates the credit, so
    // this route is the other way to squat an id `/v1/credit` will later
    // derive for its rightful owner — who would then pay and hold nothing.
    const squatted = derivedFundCreditId(hex(schnorr.getPublicKey(OTHER_PRIVKEY)), "f1");

    const res = await submit(
      url,
      drawBody("do", {
        credit_id: squatted,
        draw_id: "d1",
        fund: { amount_micro: PRICE_MICRO, commitment: fundingCommitment("cashuAdeadbeef") },
      }),
      { "X-Cashu": "cashuAdeadbeef", "X-Cashu-Request-Id": "req-1" }
    );
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("credit_id_unavailable");
    expect(await ledger.get(squatted)).toBeUndefined();
  });

  it("answers the same for a derived id that exists and one that doesn't", async () => {
    const { url, ledger } = await startServer();
    const theirs = derivedFundCreditId(hex(schnorr.getPublicKey(OTHER_PRIVKEY)), "f1");
    const probe = async (): Promise<Record<string, unknown>> => {
      const res = await submit(url, drawBody("do", { credit_id: theirs, draw_id: "d1" }));
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(402);
      return {
        error: body.error,
        message: body.message,
        display: body.display,
        hint: body.hint,
      };
    };

    const absent = await probe();
    await fundCredit(ledger, {
      creditId: theirs,
      callerPubkey: hex(schnorr.getPublicKey(OTHER_PRIVKEY)),
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });
    // Derived ids are computable from public inputs, so a refusal that varied
    // with existence would let anyone enumerate other callers' credits from
    // chain data or a pubkey — `payment_invalid` here would be that tell.
    expect(await probe()).toEqual(absent);
    expect(absent.error).toBe("credit_id_unavailable");
    expect(await ledger.getDraw({ creditId: theirs, drawId: "d1" })).toBeUndefined();
  });

  it("still lets a job draw from a derived credit its owner holds", async () => {
    const { url, ledger } = await startServer();
    const derived = derivedFundCreditId(CALLER_PUBKEY, "f1");
    await fundCredit(ledger, {
      creditId: derived,
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("do", { credit_id: derived, draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
  });

  it("rejects an attached artifact with credit fields but no fund block", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("do", { credit_id: "c1", draw_id: "d1" }), {
      "X-Cashu": "cashuAdeadbeef",
      "X-Cashu-Request-Id": "req-1",
    });
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("funding_commitment_mismatch");
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d1" })).toBeUndefined();
  });

  it("400s structurally broken credit fields before auth or payment", async () => {
    const { url } = await startServer();
    const res = await submit(url, {
      capability: "do",
      data: signer.signRequest(PRIVKEY, { action: "go", credit_id: "c1" }),
    });
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_credit_fields");
  });
});

// Credit envelopes belong to the protocol and must survive strict capability schemas.
describe("a strict capability schema draws credit", () => {
  it("pays a job from the credit end-to-end", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const res = await submit(url, drawBody("strict", { credit_id: "c1", draw_id: "d1" }));
    const body = (await res.json()) as SubmitBody;
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");
    expect(body.receipt?.credit).toEqual({
      credit_id: "c1",
      draw_id: "d1",
      amount: PRICE_MICRO,
      balance_after: 1_000_000 - PRICE_MICRO,
      ledger_seq: 1,
    });
    expect((await ledger.getDraw({ creditId: "c1", drawId: "d1" }))?.status).toBe("settled");
  });

  it("carries a fund block through the parse to the rail", async () => {
    const { url } = await startServer();
    const artifact = "cashuAdeadbeef";

    const res = await submit(
      url,
      drawBody("strict", {
        credit_id: "c-new",
        draw_id: "d1",
        fund: { amount_micro: PRICE_MICRO, commitment: fundingCommitment(artifact) },
      }),
      { "X-Cashu": artifact, "X-Cashu-Request-Id": "req-1" }
    );
    const body = (await res.json()) as SubmitBody;

    expect(res.status).toBe(402);
    expect(body.error).toBe("cashu_unavailable");
  });

  it("quotes with the credit envelope on the body", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "strict",
        data: signer.signRequest(PRIVKEY, { action: "go", credit_id: "c1", draw_id: "d1" }),
      }),
    });
    // The quote path verifies over the raw wire body, so the envelope is right
    // there in front of the schema with no parse to have removed it.
    expect(res.status).toBe(200);
  });

  it("still names an unknown field — the diagnostic strictness buys", async () => {
    const { url } = await startServer();
    const res = await submit(
      url,
      drawBody("strict", { actionn: "typo", credit_id: "c1", draw_id: "d1" })
    );
    const body = (await res.json()) as SubmitBody & { message?: string };
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_input");
    expect(body.message).toContain("actionn");
  });

  it("still refuses tampered credit fields — they are unvalidated, not unsigned", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER_PUBKEY,
      currency: "usd",
      amountMicro: 1_000_000,
      expiryMs: FUTURE_MS,
    });

    const signed = signer.signRequest(PRIVKEY, {
      action: "go",
      credit_id: "c1",
      draw_id: "d1",
    }) as unknown as Record<string, unknown>;
    const res = await submit(url, {
      capability: "strict",
      data: { ...signed, draw_id: "d-swapped" },
    });
    expect(res.status).toBe(401);
    expect(await ledger.getDraw({ creditId: "c1", drawId: "d-swapped" })).toBeUndefined();
  });
});
