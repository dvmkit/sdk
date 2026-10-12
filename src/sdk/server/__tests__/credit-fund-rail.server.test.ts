/* HTTP funding uses a mocked facilitator and a real ledger. Fund-only short pays remain deposits. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { msatsToUsdc } from "../../../lib/currency";
import type { X402Config } from "../../../lib/x402/types";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { CreditLedgerLike } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId, fundingCommitment } from "../funding";
import { MemoryJobStore } from "../memory-job-store";
import type { CreditDepositPayload } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

vi.mock("../../../lib/x402", () => ({ verifyX402Payment: vi.fn() }));

const { verifyX402Payment } = await import("../../../lib/x402");

const RATE = 100_000;
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const X402: X402Config = {
  facilitator: "https://x402.test/facilitator",
  network: "eip155:8453",
  payTo: "0x1111111111111111111111111111111111111111",
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array(32).fill(11);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const ARTIFACT = "eyJ4NDAyIjoicGF5bG9hZCJ9";
const COMMITMENT = fundingCommitment(ARTIFACT);

const TOPUP_MICRO = 300_000;
const TOPUP_MSATS = 300_000;

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const servers = servedApps();

async function startServer(
  opts: {
    loseFundings?: boolean;
    deposits?: CreditDepositPayload[];
    allowOneShotStablecoin?: boolean;
    ledger?: CreditLedgerLike;
  } = {}
): Promise<{ url: string; ledger: CreditLedgerLike }> {
  const ledger = opts.ledger ?? durableLedger({ loseFundings: opts.loseFundings });
  const dvm = configureDVM({
    name: "credit-fund-rail-test",
    capability: "do",
    input: signedSchema,
    price: "$0.10",
    onJob(ctx) {
      ctx.complete("done");
    },
    credit: {
      min: "$0.10",
      max: "$5.00",

      allowOneShotStablecoin: opts.allowOneShotStablecoin ?? true,
    },
    auth: secp256k1Auth(),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: ledger,
    x402: X402,
    ...(opts.deposits && {
      dvmId: "dvm-fund-rail",
      onCreditFunded: (info) => {
        opts.deposits?.push(info);
      },
    }),
  });
  const url = await servers.serve(app);
  return { url, ledger };
}

function fundCall(url: string, fundId: string, creditId?: string): Promise<Response> {
  return fetch(`${url}/v1/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": ARTIFACT },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        ...(creditId ? { credit_id: creditId } : {}),
        fund: { amount_micro: TOPUP_MICRO, fund_id: fundId, commitment: COMMITMENT },
      })
    ),
  });
}

function settles(paidMsats: number, txHash = "0xabc"): void {
  vi.mocked(verifyX402Payment).mockResolvedValue({
    verified: true,
    amountMsats: paidMsats,
    amountUsdcMicro: msatsToUsdc(paidMsats, RATE),
    txHash,
    settleResponseHeader: "hdr",
  });
}

interface FundBody {
  funded_micro: number;
  replayed: boolean;
  error?: string;
  display?: string;
  credit_rail?: string;
  credit?: { credit_id: string; balance_micro: number; remaining_micro: number };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/v1/credit fund against a live rail", () => {
  it("refuses exact credit funding by default before facilitator settlement", async () => {
    const { url, ledger } = await startServer({ allowOneShotStablecoin: false });
    settles(TOPUP_MSATS);

    const response = await fundCall(url, "f-default-off");
    const body = (await response.json()) as FundBody;
    expect(response.status).toBe(409);
    expect(body.error).toBe("one_shot_credit_not_supported");
    expect(body.display).toContain("No money moved");
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
    expect(
      await ledger.getFunding({
        creditId: derivedFundCreditId(CALLER, "f-default-off"),
        fundId: "f-default-off",
      })
    ).toBeUndefined();
  });

  it("credits an exact top-up and reports it", async () => {
    const { url, ledger } = await startServer();
    settles(TOPUP_MSATS);

    const response = await fundCall(url, "f1");
    const body = (await response.json()) as FundBody;
    expect(body.replayed).toBe(false);
    expect(body.funded_micro).toBe(TOPUP_MICRO);
    expect(body.credit?.balance_micro).toBe(TOPUP_MICRO);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("hdr");
    expect(response.headers.get("X-PAYMENT-RESPONSE")).toBe("hdr");

    expect(body.credit?.credit_id).toBe(derivedFundCreditId(CALLER, "f1"));
    expect((await ledger.getForCaller(CALLER)).length).toBe(1);
  });

  it("makes a retried FIRST top-up idempotent end-to-end", async () => {
    const deposits: CreditDepositPayload[] = [];
    const { url, ledger } = await startServer({ deposits });
    settles(TOPUP_MSATS);
    const first = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(first.replayed).toBe(false);

    // Replay must return before presenting the spent artifact to the facilitator again.
    settles(TOPUP_MSATS, "0xdef");
    const retry = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(retry.replayed).toBe(true);
    expect(retry.funded_micro).toBe(TOPUP_MICRO);
    expect(retry.credit?.credit_id).toBe(first.credit?.credit_id);

    const held = await ledger.getForCaller(CALLER);
    expect(held.length).toBe(1);
    expect(held[0]?.balanceMicro).toBe(TOPUP_MICRO);

    expect(vi.mocked(verifyX402Payment).mock.calls.length).toBe(1);
    expect(deposits).toHaveLength(1);
  });

  it("replays an already committed exact funding after the policy turns off", async () => {
    const firstServer = await startServer({ allowOneShotStablecoin: true });
    settles(TOPUP_MSATS);
    const first = (await (await fundCall(firstServer.url, "f-policy-replay")).json()) as FundBody;
    expect(first.replayed).toBe(false);

    // Retire the first server before the next `listen(0)` — the port may be
    // recycled, and only destroying its pooled sockets stops the replay reaching
    // the server that still allows the policy.
    await servers.closeAll();
    const secondServer = await startServer({
      allowOneShotStablecoin: false,
      ledger: firstServer.ledger,
    });
    const replay = (await (await fundCall(secondServer.url, "f-policy-replay")).json()) as FundBody;
    expect(replay.replayed).toBe(true);
    expect(replay.error).toBeUndefined();
    expect(vi.mocked(verifyX402Payment)).toHaveBeenCalledTimes(1);
  });

  it("stacks distinct fund_ids onto the same derived-then-named credit", async () => {
    const { url, ledger } = await startServer();
    settles(TOPUP_MSATS);
    const first = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = first.credit?.credit_id;

    settles(TOPUP_MSATS, "0xdef");
    const second = (await (await fundCall(url, "f2", creditId)).json()) as FundBody;
    expect(second.replayed).toBe(false);
    expect(second.credit?.balance_micro).toBe(TOPUP_MICRO * 2);
    expect((await ledger.getForCaller(CALLER)).length).toBe(1);
  });

  it("fails loudly when the payment settled but no funding was recorded", async () => {
    const { url } = await startServer({ loseFundings: true });
    settles(TOPUP_MSATS);

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;

    expect(res.status).toBe(500);
    expect(body.error).toBe("credit_funding_unrecorded");
    expect(body.replayed).toBeUndefined();
  });

  it("refuses a squatted derived credit id WITHOUT presenting the artifact", async () => {
    const { url, ledger } = await startServer();
    // Namespace ownership must be checked before settlement; a later ledger refusal cannot undo payment.
    await fundCredit(ledger, {
      creditId: derivedFundCreditId(CALLER, "f1"),
      callerPubkey: "ff".repeat(32),
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + 86_400_000,
    });
    settles(TOPUP_MSATS);

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(409);
    expect(body.error).toBe("credit_id_unavailable");

    expect(vi.mocked(verifyX402Payment).mock.calls.length).toBe(0);
  });

  it("refuses a cross-rail top-up WITHOUT presenting the artifact", async () => {
    const { url, ledger } = await startServer();
    const creditId = "b7c1d2e3-cashu-credit";
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "cashu", paidMsats: 100_000 },
    });
    settles(TOPUP_MSATS);

    const res = await fundCall(url, "f1", creditId);
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(409);
    expect(body.error).toBe("payment_invalid");
    expect(body.credit_rail).toBe("cashu");
    // `fund` raises `rail_mismatch` too, but only from inside the rail
    // transaction — by then the facilitator has settled and the rollback hands
    // the caller nothing back for money that has already moved.
    expect(vi.mocked(verifyX402Payment).mock.calls.length).toBe(0);
    expect(await ledger.getFunding({ creditId, fundId: "f1" })).toBeUndefined();
  });

  it("refuses exact x402 against a channel-bound credit before facilitator settlement", async () => {
    const { url, ledger } = await startServer();
    const creditId = "channel-bound-credit";
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 100_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "x402",
        paidMsats: 100_000,
        nativeAmount: 100_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: `0x${"44".repeat(32)}`, maxClaimableAmount: "100000" },
      },
    });
    settles(TOPUP_MSATS);

    const res = await fundCall(url, "f-exact", creditId);
    const body = (await res.json()) as FundBody & {
      credit_instrument?: string;
      credit_channel_id?: string;
    };
    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      error: "payment_invalid",
      credit_rail: "x402",
      credit_instrument: "x402_channel",
      credit_channel_id: `0x${"44".repeat(32)}`,
    });
    expect(vi.mocked(verifyX402Payment)).not.toHaveBeenCalled();
  });

  it("books the top-up as a deposit — a fund-only credit still creates a liability", async () => {
    const deposits: CreditDepositPayload[] = [];
    const { url } = await startServer({ deposits });
    settles(TOPUP_MSATS);

    const body = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(body.funded_micro).toBe(TOPUP_MICRO);

    expect(deposits.length).toBe(1);
    expect(deposits[0]).toMatchObject({
      creditId: derivedFundCreditId(CALLER, "f1"),
      callerPubkey: CALLER,

      fundingId: "0xabc",
      rail: "x402",
      paidMsats: TOPUP_MSATS,
      nativeAmount: msatsToUsdc(TOPUP_MSATS, RATE),
      amountMicro: TOPUP_MICRO,
      creditCurrency: "usd",
      instrument: "x402_exact",
    });
  });

  it("books the deposit at what landed on a SHORT pay, not what was asked for", async () => {
    const deposits: CreditDepositPayload[] = [];
    const { url, ledger } = await startServer({ deposits });
    settles(TOPUP_MSATS / 2);

    const body = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(body.funded_micro).toBe(TOPUP_MICRO / 2);
    expect(body.credit?.balance_micro).toBe(TOPUP_MICRO / 2);
    const recorded = await ledger.getFunding({
      creditId: derivedFundCreditId(CALLER, "f1"),
      fundId: "f1",
    });
    expect(recorded?.amountMicro).toBe(TOPUP_MICRO / 2);

    expect(deposits[0]?.amountMicro).toBe(TOPUP_MICRO / 2);
    expect(deposits[0]?.paidMsats).toBe(TOPUP_MSATS / 2);
  });

  it("refuses once the caller's total spendable balance would clear max_micro", async () => {
    const { url } = await startServer();
    // 17 × $0.30 = $5.10, one hop past the $5.00 ceiling. Each opens its own
    // credit (distinct fund_id, no credit_id), which is exactly the shape a
    // per-credit ceiling would wave through forever.
    let last: FundBody | undefined;
    for (let i = 0; i < 17; i++) {
      settles(TOPUP_MSATS, `0x${i}`);
      last = (await (await fundCall(url, `f${i}`)).json()) as FundBody;
      if (last.error) break;
    }
    expect(last?.error).toBe("credit_over_max");
  });
});
