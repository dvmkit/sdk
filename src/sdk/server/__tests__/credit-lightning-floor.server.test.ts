/*
 * At the pinned FX rate, the advertised margined minimum must pass the raw-sats floor. A
 * previously issued invoice bypasses later floor increases, including after payment; new
 * sub-floor requests must mint no invoice.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { Nip47Stub } from "../../../test-support/nip47-stub";
import { startNip47Stub } from "../../../test-support/nip47-stub";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { CreditLedgerError, CreditLedgerLike } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId } from "../funding";
import { LightningReceive } from "../lightning-receive";
import { MemoryJobStore } from "../memory-job-store";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger } from "./__helpers__/credit-fixtures";

const RECEIVE_ONLY = ["get_info", "get_balance", "make_invoice", "lookup_invoice"];
const RATE = 100_000;
const FLOOR_SATS = 2000;
/** The advertised figure: 2000 sats = $2.00, ×1.15 margin. */
const FLOOR_MICRO = 2_300_000;
const SUB_FLOOR_MICRO = 300_000;

let fxDown = false;
const stubFx: FxFetcher = {
  fetch: () =>
    fxDown
      ? Promise.reject(new Error("rate provider down"))
      : Promise.resolve({ rates: { usd: RATE }, as_of: "2026-07-28T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array(32).fill(29);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

interface Harness {
  url: string;
  ledger: CreditLedgerLike;
  stub: Nip47Stub;
}

const servers = servedApps();
let openStub: Nip47Stub | undefined;

async function startHarness(): Promise<Harness> {
  const stub = await startNip47Stub({ methods: RECEIVE_ONLY, balanceMsats: 0 });
  openStub = stub;
  const ledger = durableLedger();
  const dvm = configureDVM({
    name: "credit-lightning-floor-test",
    capability: "do",
    input: signedSchema,
    price: "$0.10",
    onJob(ctx) {
      ctx.complete("done");
    },
    credit: { min: "$0.10", max: "$5.00" },
    auth: secp256k1Auth(),
  });
  const lightningReceive = await LightningReceive.create({
    uri: stub.uri,
    fundingMinSats: FLOOR_SATS,
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: ledger,
    lightningReceive,
    dvmId: "dvm-ln-floor",
  });
  const url = await servers.serve(app);
  return { url, ledger, stub };
}

interface FundBody {
  error?: string;
  funded_micro?: number;
  rail?: string;
  min_micro?: number;
  alternatives?: string[];
  currency?: string;
  retryable?: boolean;
  display?: string;
  hint?: string;
  lightning?: { invoice: string; payment_hash: string; amount_msats: number };
}

function fundCall(url: string, fundId: string, amountMicro: number): Promise<Response> {
  return fetch(`${url}/v1/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        fund: { amount_micro: amountMicro, fund_id: fundId, method: "lightning" },
      })
    ),
  });
}

afterEach(async () => {
  fxDown = false;
  await openStub?.close();
  openStub = undefined;
});

describe("the receive floor on POST /v1/credit", () => {
  it("refuses a sub-floor funding with the structured per-rail refusal, minting nothing", async () => {
    const { url, stub } = await startHarness();
    const res = await fundCall(url, "f-low", SUB_FLOOR_MICRO);
    const body = (await res.json()) as FundBody;

    expect(res.status).toBe(400);
    expect(body.error).toBe("below_rail_minimum");
    expect(body.rail).toBe("lightning");
    expect(body.min_micro).toBe(FLOOR_MICRO);
    expect(Array.isArray(body.alternatives)).toBe(true);
    expect(body.alternatives).not.toContain("lightning");
    expect(body.currency).toBe("usd");
    expect(body.retryable).toBe(false);
    expect(body.display).toBeTruthy();
    expect(body.hint).toBeTruthy();
    expect(stub.invoices.length).toBe(0);
  });

  it("issues an invoice for exactly the advertised (margined) minimum", async () => {
    // Enforce raw sats, not the margined menu figure, so the advertised minimum passes at
    // this unchanged rate.
    const { url, stub } = await startHarness();
    const res = await fundCall(url, "f-at-min", FLOOR_MICRO);
    const body = (await res.json()) as FundBody;

    expect(res.status).toBe(402);
    expect(body.error).toBe("lightning_settlement_pending");
    expect(body.lightning?.amount_msats).toBe(2_300_000);
    expect(stub.invoices.length).toBe(1);
  });

  it("re-polls and settles an outstanding sub-floor invoice — a floor raise strands nothing", async () => {
    const { url, ledger, stub } = await startHarness();
    // Issue under a lower floor, then raise it while that same invoice is still outstanding.
    const preRaise = await LightningReceive.create({ uri: stub.uri, fundingMinSats: 100 });
    const invoice = await preRaise?.issue(ledger, {
      creditId: derivedFundCreditId(CALLER, "f-old"),
      fundId: "f-old",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: SUB_FLOOR_MICRO,
      amountMsats: 300_000,
    });
    expect(invoice).toBeDefined();

    const repoll = await fundCall(url, "f-old", SUB_FLOOR_MICRO);
    const repollBody = (await repoll.json()) as FundBody;
    expect(repoll.status).toBe(402);
    expect(repollBody.error).toBe("lightning_settlement_pending");
    expect(repollBody.lightning?.invoice).toBe(invoice?.bolt11);
    expect(stub.invoices.length).toBe(1);

    stub.settleInvoice(invoice?.paymentHash ?? "");
    const settled = await fundCall(url, "f-old", SUB_FLOOR_MICRO);
    const settledBody = (await settled.json()) as FundBody;
    expect(settled.status).toBe(200);
    expect(settledBody.funded_micro).toBe(SUB_FLOOR_MICRO);
  });

  it("falls through to the fx-outage 503, never a floor refusal, when the rate is down", async () => {
    const { url, stub } = await startHarness();
    fxDown = true;
    const res = await fundCall(url, "f-fx-down", SUB_FLOOR_MICRO);
    const body = (await res.json()) as FundBody;

    // With no rate there is no honest sats reading of the request, so the
    // floor gate must not guess — the conversion step already owns this
    // failure and answers retryable.
    expect(res.status).toBe(503);
    expect(body.error).toBe("fx_rate_unavailable");
    expect(stub.invoices.length).toBe(0);
  });
});

describe("LightningReceive.issue defense in depth", () => {
  it("refuses to mint a sub-floor bolt11 even when called directly", async () => {
    const stub = await startNip47Stub({ methods: RECEIVE_ONLY, balanceMsats: 0 });
    openStub = stub;
    const ledger = durableLedger();
    const receive = await LightningReceive.create({ uri: stub.uri, fundingMinSats: FLOOR_SATS });

    await expect(
      receive?.issue(ledger, {
        creditId: "c-direct",
        fundId: "f-direct",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: SUB_FLOOR_MICRO,
        amountMsats: 300_000,
      })
    ).rejects.toMatchObject(
      expect.objectContaining({
        name: "CreditLedgerError",
        code: "below_rail_minimum",
      }) as CreditLedgerError
    );
    expect(stub.invoices.length).toBe(0);
  });

  it("returns an existing row untouched — replays are never re-gated", async () => {
    const stub = await startNip47Stub({ methods: RECEIVE_ONLY, balanceMsats: 0 });
    openStub = stub;
    const ledger = durableLedger();
    const recorded = await ledger.recordInvoice({
      creditId: "c-old",
      fundId: "f-old",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: SUB_FLOOR_MICRO,
      amountMsats: 300_000,
      paymentHash: "aa".repeat(32),
      bolt11: "lnbcrt-preexisting",
      expiresAt: Date.now() + 60_000,
    });
    const receive = await LightningReceive.create({ uri: stub.uri, fundingMinSats: FLOOR_SATS });

    const replayed = await receive?.issue(ledger, {
      creditId: "c-old",
      fundId: "f-old",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: SUB_FLOOR_MICRO,
      amountMsats: 300_000,
    });
    expect(replayed?.bolt11).toBe(recorded.bolt11);
    expect(stub.invoices.length).toBe(0);
  });
});
