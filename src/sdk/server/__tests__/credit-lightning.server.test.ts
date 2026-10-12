/*
 * Drive signed funding and pull settlement through a NIP-47 wallet stub over real WebSockets.
 * This covers URI permission probing and caller-visible routing; SQL transaction behavior
 * lives in the separate database suite.
 */
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Nip47Stub } from "../../../test-support/nip47-stub";
import { startNip47Stub } from "../../../test-support/nip47-stub";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CreditLedgerError, type CreditLedgerLike } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId } from "../funding";
import type { LightningRailHealth } from "../lightning-rail-health";
import { LightningReceive } from "../lightning-receive";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { MemoryJobStore } from "../memory-job-store";
import type { CreditDepositPayload } from "../revenue-reporter";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const RECEIVE_ONLY = ["get_info", "get_balance", "make_invoice", "lookup_invoice"];

const RATE = 100_000;
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: RATE }, as_of: "2026-07-28T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string()
});

const PRIVKEY = new Uint8Array(32).fill(23);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const OTHER_PRIVKEY = new Uint8Array(32).fill(24);

// $0.30 @ $100k/BTC → 300 sats → 300_000 msats; ledger: 300_000 usd-micro.
const TOPUP_MICRO = 300_000;
const TOPUP_MSATS = 300_000;
const PRICE_MICRO = 100_000;

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
const jobSigner = createSignedRequestVerifier(signedSchema);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/*
 * Refuse settlement with a deterministic invalid_basis error, exercising permanent invoice
 * retirement without changing the wallet transport.
 */
class InvalidBasisLedger extends MemoryCreditLedger {
  override settleInvoice(): Promise<never> {
    return Promise.reject(new CreditLedgerError("invalid_basis", "basis is required"));
  }
}

interface Harness {
  url: string;
  ledger: CreditLedgerLike;
  stub: Nip47Stub;
  deposits: CreditDepositPayload[];
}

const servers = servedApps();
let openStub: Nip47Stub | undefined;

async function startHarness(
  opts: {
    lightning?: boolean;
    ledger?: MemoryCreditLedger;
    railHealth?: LightningRailHealth;
    mints?: string[];
    methods?: string[];
    unreachableAtBoot?: boolean;
  } = {}
): Promise<Harness> {
  const stub = await startNip47Stub({
    methods: opts.methods ?? RECEIVE_ONLY,
    balanceMsats: 0
  });
  openStub = stub;
  if (opts.unreachableAtBoot) stub.setFault({ mode: "relay-down" });
  const ledger = durableLedger({ ledger: opts.ledger });
  const deposits: CreditDepositPayload[] = [];
  const dvm = configureDVM({
    name: "credit-lightning-test",
    capability: "do",
    input: signedSchema,
    price: "$0.10",
    onJob(ctx) {
      ctx.complete("done");
    },
    credit: { min: "$0.10", max: "$5.00" },
    auth: secp256k1Auth()
  });
  // Through the URI, not an injected backend: the connect-time probe is part
  // of what this suite exercises. The floor sits below this suite's $0.30
  // top-ups — the receive floor itself is `credit-lightning-floor.test.ts`'s
  // subject, not this one's.
  const lightningReceive =
    opts.lightning === false
      ? undefined
      : await LightningReceive.create({
          uri: stub.uri,
          fundingMinSats: 100,
          railHealth: opts.railHealth
        });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: ledger,
    lightningReceive,
    // A Lightning-funded credit reclaims as P2PK-locked Cashu notes, so the
    // menu withholds the rail without an accepted mint to mint them at
    // Wired here because this suite's subject is the Lightning
    // leg, not that gate; the gate has its own case below.
    mints: opts.mints ?? ["https://mint.example.com"],
    dvmId: "dvm-ln-receive",
    onCreditFunded: (info) => {
      deposits.push(info);
    }
  });
  const url = await servers.serve(app);
  return { url, ledger, stub, deposits };
}

interface FundBody {
  op?: string;
  funded_micro?: number;
  replayed?: boolean;
  error?: string;
  display?: string;
  hint?: string;
  retryable?: boolean;
  credit_id?: string;
  fund_id?: string;
  lightning?: {
    invoice: string;
    payment_hash: string;
    amount_msats: number;
    expires_at_ms: number;
  };
  credit?: { credit_id: string; balance_micro: number; remaining_micro: number };
}

function fundCall(
  url: string,
  fundId: string,
  extra: Record<string, unknown> = {},
  opts: { privkey?: Uint8Array; creditId?: string } = {}
): Promise<Response> {
  return fetch(`${url}/v1/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      creditSigner.signRequest(opts.privkey ?? PRIVKEY, {
        op: "fund",
        ...(opts.creditId ? { credit_id: opts.creditId } : {}),
        fund: {
          amount_micro: TOPUP_MICRO,
          fund_id: fundId,
          method: "lightning",
          ...extra
        }
      })
    )
  });
}

function quote(url: string): Promise<Response> {
  return fetch(`${url}/v1/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      capability: "do",
      data: jobSigner.signRequest(PRIVKEY, { action: "go" })
    })
  });
}

interface QuoteBody {
  credit?: { funding: string[]; lightning_min_micro?: number };
}

afterEach(async () => {
  await openStub?.close();
  openStub = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the funding menu", () => {
  it("advertises lightning when a reachable receive-only wallet is wired", async () => {
    const { url } = await startHarness();
    const body = (await (await quote(url)).json()) as QuoteBody;
    expect(body.credit?.funding).toContain("lightning");
  });

  /*
   * Without an accepted mint, the service cannot return a non-channel Bitcoin credit as
   * locked Cashu notes, so the funding menu must omit Lightning.
   */
  it("withholds lightning when no accepted mint is configured", async () => {
    const { url } = await startHarness({ mints: [] });
    const body = (await (await quote(url)).json()) as QuoteBody;
    expect(body.credit?.funding).not.toContain("lightning");
  });

  it("omits lightning when the wallet is unreachable, leaving other rails alone", async () => {
    const { url, stub } = await startHarness();
    stub.setFault({ mode: "relay-down" });
    await fundCall(url, "offline-1");

    const body = (await (await quote(url)).json()) as QuoteBody;
    expect(body.credit?.funding).not.toContain("lightning");
    expect(body.credit).toBeDefined();
  });

  it("never advertises or issues through a spend-capable wallet restored after boot", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { url, stub } = await startHarness({
      methods: [...RECEIVE_ONLY, "pay_invoice"],
      unreachableAtBoot: true
    });
    expect(((await (await quote(url)).json()) as QuoteBody).credit?.funding).not.toContain("lightning");

    stub.setFault({ mode: "pass" });
    vi.setSystemTime(Date.now() + 60_001);
    await quote(url);
    await vi.waitFor(() => {
      expect(warn.mock.calls.map(([line]) => String(line)).join("\n")).toContain(
        "lightning_receive_permission_refused"
      );
    });

    const recoveredMenu = (await (await quote(url)).json()) as QuoteBody;
    expect(recoveredMenu.credit?.funding).not.toContain("lightning");
    const response = await fundCall(url, "unsafe-recovery");
    expect(response.status).toBe(503);
    expect((await response.json()) as FundBody).toMatchObject({
      error: "lightning_unavailable"
    });
    expect(stub.invoices).toHaveLength(0);
  });

  it("omits lightning and its floor when the platform reports no active Hub channels", async () => {
    const { url } = await startHarness({ railHealth: { available: () => false } });

    const body = (await (await quote(url)).json()) as QuoteBody;
    expect(body.credit).toBeDefined();
    expect(body.credit?.funding).not.toContain("lightning");
    expect(body.credit?.lightning_min_micro).toBeUndefined();
  });

  it("never advertises lightning on a DVM with no receive wallet", async () => {
    const { url } = await startHarness({ lightning: false });
    const body = (await (await quote(url)).json()) as QuoteBody;
    expect(body.credit?.funding).not.toContain("lightning");
  });
});

describe("issue, settle, credit exactly once", () => {
  it("issues one invoice, credits on the settled poll, and no-ops on replays", async () => {
    const { url, ledger, stub, deposits } = await startHarness();

    const first = await fundCall(url, "f1");
    const firstBody = (await first.json()) as FundBody;
    expect(first.status).toBe(402);
    expect(firstBody.error).toBe("lightning_settlement_pending");
    expect(firstBody.lightning?.invoice).toMatch(/^lnbcrt/);
    expect(firstBody.lightning?.amount_msats).toBe(TOPUP_MSATS);
    expect(firstBody.credit_id).toBe(derivedFundCreditId(CALLER, "f1"));
    expect(firstBody.display).toBeTruthy();
    expect(firstBody.hint).toBeTruthy();
    expect(firstBody.retryable).toBe(true);
    expect(stub.invoices.length).toBe(1);

    const unpaid = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(unpaid.lightning?.invoice).toBe(firstBody.lightning?.invoice);
    expect(stub.invoices.length).toBe(1);
    expect((await ledger.getForCaller(CALLER)).length).toBe(0);

    stub.settleInvoice(firstBody.lightning?.payment_hash ?? "");
    expect((await ledger.getForCaller(CALLER)).length).toBe(0);

    const settled = await fundCall(url, "f1");
    const settledBody = (await settled.json()) as FundBody;
    expect(settled.status).toBe(200);
    expect(settledBody.funded_micro).toBe(TOPUP_MICRO);
    expect(settledBody.credit?.balance_micro).toBe(TOPUP_MICRO);
    expect(settledBody.credit?.credit_id).toBe(derivedFundCreditId(CALLER, "f1"));

    expect(deposits.length).toBe(1);
    expect(deposits[0].callerPubkey).toBe(CALLER);
    expect(deposits[0].rail).toBe("lightning");
    expect(deposits[0].amountMicro).toBe(TOPUP_MICRO);
    expect(deposits[0].paidMsats).toBe(TOPUP_MSATS);
    expect(deposits[0].fundingId).toBe(firstBody.lightning?.payment_hash);

    const replayed = (await (await fundCall(url, "f1")).json()) as FundBody;
    expect(replayed.replayed).toBe(true);
    expect(replayed.funded_micro).toBe(TOPUP_MICRO);
    const credits = await ledger.getForCaller(CALLER);
    expect(credits.length).toBe(1);
    expect(credits[0].balanceMicro).toBe(TOPUP_MICRO);
    expect(deposits.length).toBe(1);
  });

  it("credits a paid invoice on a balance read, and books its deposit there", async () => {
    const { url, ledger, stub, deposits } = await startHarness();
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    stub.settleInvoice(issued.lightning?.payment_hash ?? "");

    const res = await fetch(`${url}/v1/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(creditSigner.signRequest(PRIVKEY, { op: "balance" }))
    });
    const body = (await res.json()) as {
      credits?: { balance_micro: number }[];
    };
    expect(res.status).toBe(200);
    expect(body.credits?.[0]?.balance_micro).toBe(TOPUP_MICRO);
    expect((await ledger.getForCaller(CALLER))[0].balanceMicro).toBe(TOPUP_MICRO);

    expect(deposits.length).toBe(1);
    expect(deposits[0].callerPubkey).toBe(CALLER);
    expect(deposits[0].rail).toBe("lightning");
    expect(deposits[0].amountMicro).toBe(TOPUP_MICRO);
    expect(deposits[0].fundingId).toBe(issued.lightning?.payment_hash);
  });

  it("credits every invoice the sweep touches, not just the polled one", async () => {
    const { url, ledger, stub, deposits } = await startHarness();
    // Two top-ups onto ONE caller-named credit. The sweep behind a poll is
    // (caller, credit)-scoped rather than fund-scoped, so the second settles
    // as a sibling of the first — and must book its own deposit.
    const creditId = "8c2f4b1e-shared-credit";
    const one = (await (await fundCall(url, "s1", {}, { creditId })).json()) as FundBody;
    const two = (await (await fundCall(url, "s2", {}, { creditId })).json()) as FundBody;
    expect(stub.invoices.length).toBe(2);

    stub.settleInvoice(one.lightning?.payment_hash ?? "");
    stub.settleInvoice(two.lightning?.payment_hash ?? "");

    const polled = await fundCall(url, "s1", {}, { creditId });
    expect(polled.status).toBe(200);

    expect((await ledger.get(creditId))?.balanceMicro).toBe(TOPUP_MICRO * 2);
    expect(deposits.length).toBe(2);
    expect(deposits.map((d) => d.fundingId).sort()).toEqual(
      [one.lightning?.payment_hash, two.lightning?.payment_hash].sort()
    );
  });

  it("credits a paid invoice on the job submit that draws against it", async () => {
    const { url, ledger, stub, deposits } = await startHarness();
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";
    stub.settleInvoice(issued.lightning?.payment_hash ?? "");

    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "do",
        data: jobSigner.signRequest(PRIVKEY, {
          action: "go",
          credit_id: creditId,
          draw_id: "d1"
        })
      })
    });
    const body = (await res.json()) as { status?: string; error?: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe("completed");

    const snapshot = await ledger.get(creditId);
    expect(snapshot?.balanceMicro).toBe(TOPUP_MICRO - PRICE_MICRO);
    const draw = await ledger.getDraw({ creditId, drawId: "d1" });
    expect(draw?.status).toBe("settled");

    expect(deposits.length).toBe(1);
    expect(deposits[0].fundingId).toBe(issued.lightning?.payment_hash);
    expect(deposits[0].amountMicro).toBe(TOPUP_MICRO);
  });
});

describe("refusals", () => {
  it("retires an unpaid invoice past its expiry, with no ledger effect", async () => {
    const { url, ledger, stub } = await startHarness();
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";
    const receive = await LightningReceive.create({ uri: stub.uri });
    if (!receive) throw new Error("no receive leg");

    // Drive the sweep from a point past `expires_at` plus the grace. The
    // wallet is still asked one last time — an invoice paid at the buzzer must
    // not be thrown away — and only then is the row retired.
    const invoice = await ledger.getInvoice({ creditId, fundId: "f1" });
    if (!invoice) throw new Error("no invoice recorded");
    await receive.settlePending(ledger, {
      callerPubkey: CALLER,
      creditTtlMs: 30 * 24 * 60 * 60 * 1000,
      nowMs: invoice.expiresAt + 10 * 60_000
    });

    expect((await ledger.getInvoice({ creditId, fundId: "f1" }))?.status).toBe("expired");
    expect((await ledger.getForCaller(CALLER)).length).toBe(0);
    expect(stub.invoices.length).toBe(1);

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(402);
    expect(body.error).toBe("lightning_invoice_expired");
    expect(body.retryable).toBe(false);
  });

  it("says so loudly when a fund_id reused on another rail strands a paid invoice", async () => {
    const { url, ledger, stub } = await startHarness();
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";

    // `fund_id` is caller-chosen and keys the fundings table, so the caller can
    // spend the same one on an attach rail after the bolt11 was minted. Model
    // the state that leaves behind, then pay the bolt11 anyway.
    await ledger.recordFunding({
      creditId,
      fundId: "f1",
      amountMicro: 1,
      rail: "cashu"
    });
    stub.settleInvoice(issued.lightning?.payment_hash ?? "");

    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditSigner.signRequest(PRIVKEY, { op: "balance" }))
      });
    } finally {
      console.error = original;
    }

    const invoice = await ledger.getInvoice({ creditId, fundId: "f1" });
    expect(invoice?.status).toBe("blocked");
    expect(invoice?.blockedReason).toBe("funding_replayed_on_cashu");
    const blocked = errors.find((line) => line.includes("lightning_settlement_blocked"));
    expect(blocked).toBeDefined();
    expect(blocked).not.toContain(issued.lightning?.payment_hash ?? "");

    expect(await ledger.listPendingInvoices({ callerPubkey: CALLER, limit: 3 })).toEqual([]);

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(500);
    expect(body.error).toBe("credit_funding_unrecorded");
    expect(body.retryable).toBe(false);
    expect(body.lightning).toBeUndefined();
  });

  it("blocks a stranded invoice without wedging the caller's next one", async () => {
    const { url, ledger, stub, deposits } = await startHarness();

    // A credit id this caller named but someone else opened first. The invoice
    // is minted before any `credits` row exists, so nothing upstream can refuse
    // it — the collision only surfaces when `fund` runs at settlement.
    const contested = "3b6d21af-contested-credit";
    const first = (await (await fundCall(url, "f1", {}, { creditId: contested })).json()) as FundBody;
    await fundCredit(ledger, {
      creditId: contested,
      callerPubkey: hex(schnorr.getPublicKey(OTHER_PRIVKEY)),
      currency: "usd",
      amountMicro: 1,
      expiryMs: Date.now() + 30 * 24 * 60 * 60 * 1000
    });

    const second = (await (await fundCall(url, "f2")).json()) as FundBody;
    stub.settleInvoice(first.lightning?.payment_hash ?? "");
    stub.settleInvoice(second.lightning?.payment_hash ?? "");

    const original = console.error;
    console.error = () => {};
    try {
      await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditSigner.signRequest(PRIVKEY, { op: "balance" }))
      });
    } finally {
      console.error = original;
    }

    expect((await ledger.getInvoice({ creditId: contested, fundId: "f1" }))?.blockedReason).toBe("caller_mismatch");
    expect(
      (
        await ledger.getInvoice({
          creditId: second.credit_id ?? "",
          fundId: "f2"
        })
      )?.status
    ).toBe("settled");
    expect((await ledger.get(second.credit_id ?? ""))?.balanceMicro).toBe(TOPUP_MICRO);
    expect(deposits.map((d) => d.fundingId)).toEqual([second.lightning?.payment_hash]);
  });

  it("retires a deterministic ledger refusal rather than re-sweeping it forever", async () => {
    // Force a permanent invalid_basis refusal after the wallet confirms payment. Retire that
    // row instead of spending the bounded sweep window on it indefinitely.
    const { url, ledger, stub } = await startHarness({
      ledger: new InvalidBasisLedger()
    });
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";
    stub.settleInvoice(issued.lightning?.payment_hash ?? "");

    const errors: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creditSigner.signRequest(PRIVKEY, { op: "balance" }))
      });
    } finally {
      console.error = original;
    }

    const invoice = await ledger.getInvoice({ creditId, fundId: "f1" });
    expect(invoice?.status).toBe("blocked");
    expect(invoice?.blockedReason).toBe("invalid_basis");
    const blocked = errors.find((line) => line.includes("lightning_settlement_blocked"));
    expect(blocked).toBeDefined();
    expect(blocked).not.toContain(issued.lightning?.payment_hash ?? "");

    expect(await ledger.listPendingInvoices({ callerPubkey: CALLER, limit: 3 })).toEqual([]);
  });

  it("never hands one caller's invoice to another", async () => {
    const { url, ledger, stub } = await startHarness();

    // A derived credit id: computable from A's pubkey plus a fund_id, so it is
    // the one an attacker can actually aim at.
    const mine = (await (await fundCall(url, "f1")).json()) as FundBody;
    const derived = await fundCall(
      url,
      "f1",
      {},
      { privkey: OTHER_PRIVKEY, creditId: mine.credit_id }
    );
    const derivedBody = (await derived.json()) as FundBody;
    expect(derived.status).toBe(400);
    expect(derivedBody.error).toBe("credit_id_unavailable");
    expect(derivedBody.lightning).toBeUndefined();

    const chosen = "1f7a0c93-chosen-credit";
    const theirs = (await (await fundCall(url, "f2", {}, { creditId: chosen })).json()) as FundBody;
    const stolen = await fundCall(url, "f2", {}, { privkey: OTHER_PRIVKEY, creditId: chosen });
    const stolenBody = (await stolen.json()) as FundBody;
    expect(stolen.status).toBe(409);
    expect(stolenBody.error).toBe("credit_id_unavailable");
    expect(stolenBody.lightning).toBeUndefined();

    expect(stub.invoices.length).toBe(2);
    stub.settleInvoice(theirs.lightning?.payment_hash ?? "");
    expect(
      (await (await fundCall(url, "f2", {}, { creditId: chosen })).json()) as FundBody
    ).toEqual(expect.objectContaining({ funded_micro: TOPUP_MICRO }));
    expect((await ledger.get(chosen))?.callerPubkey).toBe(CALLER);
  });

  it("mints no invoice for a credit opened on another rail", async () => {
    const { url, ledger } = await startHarness();
    const creditId = "d0f1c2b3-cashu-credit";
    await ledger.fund({
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: TOPUP_MICRO,
      expiryMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
      basis: { rail: "cashu", paidMsats: TOPUP_MSATS }
    });

    const res = await fundCall(url, "f1", {}, { creditId });
    const body = (await res.json()) as FundBody & { credit_rail?: string };
    expect(res.status).toBe(409);
    expect(body.error).toBe("payment_invalid");
    expect(body.credit_rail).toBe("cashu");
    expect(body.hint).toContain("cashu");
    expect(body.lightning).toBeUndefined();
    expect(await ledger.getInvoice({ creditId, fundId: "f1" })).toBeUndefined();
  });

  it("refuses method lightning on a DVM with no receive wallet", async () => {
    const { url } = await startHarness({ lightning: false });
    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(503);
    expect(body.error).toBe("lightning_unavailable");
    expect(body.display).toBeTruthy();
  });

  it("refuses a commitment alongside method lightning", async () => {
    const { url } = await startHarness();
    const res = await fundCall(url, "f1", { commitment: "a".repeat(64) });
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });

  it("still requires a commitment on the attach rails", async () => {
    const { url } = await startHarness();
    const res = await fetch(`${url}/v1/credit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        creditSigner.signRequest(PRIVKEY, {
          op: "fund",
          fund: { amount_micro: TOPUP_MICRO, fund_id: "f1" }
        })
      )
    });
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(400);
    expect(body.error).toBe("invalid_request");
  });
});

describe("what the caller sees once an operator acts", () => {
  /*
   * Reuse fund_id on Cashu after issuing the Lightning invoice; the persisted funding row
   * then belongs to a different payment.
   */
  async function strandOnCashu(
    url: string,
    ledger: CreditLedgerLike
  ): Promise<{ creditId: string; paymentHash: string }> {
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";
    const paymentHash = issued.lightning?.payment_hash ?? "";
    await fundCredit(ledger, {
      creditId,
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 7_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "cashu", paidMsats: 7, fundingRef: "cashu-topup" }
    });
    await ledger.recordFunding({
      creditId,
      fundId: "f1",
      amountMicro: 7_000,
      rail: "cashu"
    });
    await ledger.markInvoiceBlocked({
      creditId,
      fundId: "f1",
      reason: "funding_replayed_on_cashu"
    });
    return { creditId, paymentHash };
  }

  it("does not quote the colliding rail's figure back as a replayed Lightning fund", async () => {
    const { url, ledger } = await startHarness();
    await strandOnCashu(url, ledger);

    // The funding row at this key is the cashu top-up — a *different* payment.
    // Answering `replayed: true, funded_micro: 7000` would tell a caller whose
    // sats are stranded that their bolt11 landed, for someone else's amount.
    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(500);
    expect(body.error).toBe("credit_funding_unrecorded");
    expect(body.replayed).toBeUndefined();
    expect(body.lightning).toBeUndefined();
  });

  it("tells the caller where the money went once it is reconciled", async () => {
    const { url, ledger } = await startHarness();
    const { paymentHash } = await strandOnCashu(url, ledger);
    await ledger.reconcileBlockedInvoice({
      paymentHash,
      targetCreditId: "rescued-credit",
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "lightning",
        paidMsats: TOPUP_MSATS,
        fundingRef: paymentHash
      }
    });

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(200);
    expect(body.funded_micro).toBe(TOPUP_MICRO);
    expect(body.credit?.credit_id).toBe("rescued-credit");
    expect(body.display).toContain("rescued-credit");
    expect(body.hint).toContain("rescued-credit");
    expect(body.lightning).toBeUndefined();
  });

  it("keeps a written-off invoice on the do-not-pay-again answer", async () => {
    const { url, ledger } = await startHarness();
    const { paymentHash } = await strandOnCashu(url, ledger);
    await ledger.writeOffBlockedInvoice({ paymentHash, note: "made whole out of band" });

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(500);
    expect(body.error).toBe("credit_funding_unrecorded");
    expect(body.retryable).toBe(false);
    expect(body.lightning).toBeUndefined();
  });

  it("never hands the bolt11 back for a status this build does not know", async () => {
    const { url, ledger } = await startHarness();
    const issued = (await (await fundCall(url, "f1")).json()) as FundBody;
    const creditId = issued.credit_id ?? "";
    const invoice = await ledger.getInvoice({ creditId, fundId: "f1" });
    Object.assign(invoice as object, { status: "some_future_status" });

    const res = await fundCall(url, "f1");
    const body = (await res.json()) as FundBody;
    expect(res.status).toBe(500);
    expect(body.error).toBe("credit_funding_unrecorded");
    expect(body.lightning).toBeUndefined();
  });
});
