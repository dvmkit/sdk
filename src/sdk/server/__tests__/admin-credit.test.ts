/* SQL is captured, not executed; these tests prove route wiring and guards, not rollback. */
import { readFileSync } from "node:fs";

import { Amount, CheckStateEnum, getEncodedToken } from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { verifyDrainReceipt } from "../../../lib/receipt";
import type { FxFetcher } from "../../pricing/index";
import { buildAdminChallenge } from "../admin-cashu";
import { installAdminCreditRoutes } from "../admin-credit";
import { MemoryConsumedCredentialStore } from "../consumed-credential-store";
import type { CreditFundingBasis, CreditLedgerLike } from "../credit-ledger";
import { DRAIN_DELIVERY_RESERVE_SATS } from "../credit-lots";
import { toLockPubkey } from "../lock-pubkey-store";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import { ReceiptIssuer } from "../receipt-issuer";
import { fundCredit, removeFundingLots } from "./__helpers__/credit-fixtures";

const liabilityFixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/bitcoin-liability.json", import.meta.url), "utf8")
) as { response: Record<string, unknown> };

const PRIVKEY_HEX = "11".repeat(32);
const LOCK_PUBKEY = "02" + hex(schnorr.getPublicKey(hexToBytes(PRIVKEY_HEX)));
const REFUND_PUBKEY = "02" + "cd".repeat(32);
const DVM_ID = "dvm-admin-credit-test";
const MINT_URL = "https://mint.example.com";
const CALLER = "ab".repeat(32);
const OTHER_CALLER = "ef".repeat(32);
const PAYMENT_HASH = "9a".repeat(32);
const SETTLEMENT_ID = "5e".repeat(32);
const X402_CHANNEL = `0x${"7c".repeat(32)}`;
const X402_CREDIT = "c-x402";
const TEMPO_CHANNEL = `0x${"3a".repeat(32)}`;
const TEMPO_TX = `0x${"b1".repeat(32)}`;
const TEMPO_CREDIT = "c-tempo";
const TEMPO_DRAIN = "d-tempo";

const TEMPO_DEBIT_NATIVE = 400_000;
/**
 * Postgres's own `timestamptz` text form, microseconds and all — the queue's
 * cursor carries it verbatim rather than round-tripping through a `Date`, which
 * would truncate it to milliseconds and re-serve the boundary row.
 */
const PAGE_CURSOR_AT = "2026-08-10 16:31:33.123456+00";
const SETTLED_AT = 1_750_000_000_000;
const CREDIT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function hexToBytes(h: string): Uint8Array {
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function p2pkSecret(pubkey: string): string {
  return JSON.stringify(["P2PK", { nonce: "6e", data: pubkey }]);
}

function signAuth(method: string, path: string): string {
  const nonceHex = hex(crypto.getRandomValues(new Uint8Array(16)));
  const unixSeconds = Math.floor(Date.now() / 1000);
  const digest = buildAdminChallenge({
    method,
    path,
    dvmId: DVM_ID,
    nonceHex,
    unixSeconds,
  });
  const sigHex = hex(schnorr.sign(digest, hexToBytes(PRIVKEY_HEX)));
  return `P2PK ${nonceHex}.${unixSeconds}.${sigHex}`;
}

function refundToken(pubkey = REFUND_PUBKEY): string {
  return getEncodedToken({
    mint: MINT_URL,
    proofs: [
      {
        id: "009a1f293253e41e",
        amount: Amount.from(400),
        secret: p2pkSecret(pubkey),
        C: "02" + "33".repeat(32),
      },
    ],
  });
}

interface Harness {
  app: Hono;
  ledger: CreditLedgerLike;
  queries: { text: string; params: unknown[] }[];
  proofStates: { state: CheckStateEnum }[];
  checkProofsStates: ReturnType<typeof vi.fn>;

  deposits: ReturnType<typeof vi.fn>;

  drains: ReturnType<typeof vi.fn>;

  lookupSettlement: ReturnType<typeof vi.fn>;

  repair: StubRepair;

  exactRepair: StubExactRepair;

  tempo: StubTempoRail;
}

/* Chain reads are stubbed; real close-intent persistence is covered by the session-store suites. */
interface StubTempoRail {

  intent: { channelId: string; drainId: string; reference: string | null } | null;
  /** What the close receipt says, `null` for a channel this DVM does not hold. */
  amounts: { refundedToPayer: bigint; settledToPayee: bigint } | null;

  amountsError?: Error;

  reads: string[];
}

interface StubRepair {
  intents: Map<string, Record<string, unknown>>;

  outcome?: { refusal: string; status?: string; error?: string };

  evidence: { transaction: string; amount: string };

  replayed: boolean;
  writeOffResult?: unknown;
  commits: number;

  listArgs: { limit: number; after?: { createdAt: string; settlementId: string } }[];
}

interface StubExactRepair {
  intents: Map<string, Record<string, unknown>>;
  reconcile: (dvmId: string, intentId: string) => void;
}

function makeHarness(
  opts: {
    consumedRows?: Record<string, unknown>[];

    noLightning?: boolean;
    creditCurrency?: string;

    noX402?: boolean;

    noX402Exact?: boolean;

    noTempo?: boolean;

    accumulatorWired?: boolean;
    getLockPubkeyState?: Parameters<typeof installAdminCreditRoutes>[1]["getLockPubkeyState"];
    nonceStore?: Parameters<typeof installAdminCreditRoutes>[1]["nonceStore"];
    onTempoDrainReconciled?: Parameters<
      typeof installAdminCreditRoutes
    >[1]["onTempoDrainReconciled"];
  } = {}
): Harness {
  const queries: { text: string; params: unknown[] }[] = [];
  const proofStates: { state: CheckStateEnum }[] = [{ state: CheckStateEnum.UNSPENT }];
  const query = vi.fn((text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (text.includes("SELECT id, mint_url, proof_keyset_id")) {
      return Promise.resolve({
        rows: opts.consumedRows ?? [
          {
            id: "r1",
            mint_url: MINT_URL,
            proof_keyset_id: "009a1f293253e41e",
            proof_secret: p2pkSecret(LOCK_PUBKEY),
            proof_c: "02" + "11".repeat(32),
            proof_amount: 512,
            melt_status: null,
          },
        ],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const client = { query, release: vi.fn() };
  const db = { query, connect: vi.fn().mockResolvedValue(client) };

  const ledger = new MemoryCreditLedger();
  const checkProofsStates = vi.fn(() => Promise.resolve(proofStates));
  const deposits = vi.fn(() => Promise.resolve());
  const drains = vi.fn(() => Promise.resolve());
  const lookupSettlement = vi.fn(() =>
    Promise.resolve({ settled: true, settledAt: SETTLED_AT, known: true })
  );
  const repair = stubRepair();
  const exactRepair = stubExactRepair();
  const tempo: StubTempoRail = {
    intent: { channelId: TEMPO_CHANNEL, drainId: TEMPO_DRAIN, reference: TEMPO_TX },
    amounts: { refundedToPayer: 400_000n, settledToPayee: 100_000n },
    reads: [],
  };
  const app = new Hono();
  installAdminCreditRoutes(app, {
    db: db as never,
    dvmId: DVM_ID,
    ledger,
    fxFetcher: stubFx,
    getLockPubkeyState:
      opts.getLockPubkeyState ??
      (() => Promise.resolve({ current: toLockPubkey(LOCK_PUBKEY), retired: [] })),
    nonceStore: opts.nonceStore ?? new MemoryConsumedCredentialStore({ maxEntries: 100 }),
    accumulatorWired: opts.accumulatorWired ?? true,
    receiptIssuer: new ReceiptIssuer({ secret: "77".repeat(32), dvm: "test", dvmId: DVM_ID }),
    creditTtlMs: () => CREDIT_TTL_MS,
    creditCurrency: () => opts.creditCurrency ?? "usd",
    enqueueCreditDeposit: deposits as never,
    enqueueCreditDrain: drains as never,
    ...(opts.noLightning ? {} : { lightningReceive: { lookupSettlement } as never }),
    ...(opts.noX402
      ? {}
      : { x402BatchSettlement: () => Promise.resolve({ repair: repairSurface(repair) } as never) }),
    ...(opts.noX402Exact ? {} : { x402ExactSettlement: exactRepairSurface(exactRepair) as never }),
    ...(opts.noTempo ? {} : { tempoDrainRail: () => Promise.resolve(tempoRail(tempo) as never) }),
    walletProvider: vi.fn().mockResolvedValue({ checkProofsStates }) as never,
    onTempoDrainReconciled: opts.onTempoDrainReconciled,
  });
  return {
    app,
    ledger,
    queries,
    proofStates,
    checkProofsStates,
    deposits,
    drains,
    lookupSettlement,
    repair,
    exactRepair,
    tempo,
  };
}

function stubExactRepair(): StubExactRepair {
  return {
    intents: new Map(),
    reconcile: vi.fn(),
  };
}

function exactRepairSurface(stub: StubExactRepair): Record<string, unknown> {
  return {
    list: () => Promise.resolve([...stub.intents.values()]),
    attempts: () =>
      Promise.resolve([
        {
          outcome: "timeout",
          detail: "TypeError",
          createdAt: 1_750_000_000_001,
        },
      ]),
    reconcile: (dvmId: string, intentId: string) => {
      stub.reconcile(dvmId, intentId);
      const intent = stub.intents.get(intentId);
      if (!intent) throw new Error("intent not found");
      return Promise.resolve({ intent: { ...intent, status: "complete" }, replayed: false });
    },
  };
}

function tempoRail(stub: StubTempoRail): Record<string, unknown> {
  return {
    getTempoSessionCloseIntent: () => Promise.resolve(stub.intent),
    getTempoSessionCloseAmounts: (args: { txHash: string }) => {
      stub.reads.push(args.txHash);
      return stub.amountsError ? Promise.reject(stub.amountsError) : Promise.resolve(stub.amounts);
    },
  };
}

function stubRepair(): StubRepair {
  return {
    intents: new Map(),
    evidence: { transaction: "0xrefund", amount: "400000" },
    replayed: false,
    commits: 0,
    listArgs: [],
  };
}

/* Repair chain/store behavior is stubbed; the routes execute their own ledger legs. */
function repairSurface(stub: StubRepair): Record<string, unknown> {
  return {
    get: (settlementId: string) => Promise.resolve(stub.intents.get(settlementId)),
    list: (args: { limit: number; after?: { createdAt: string; settlementId: string } }) => {
      stub.listArgs.push(args);
      const settlements = [...stub.intents.values()].map((intent) => ({
        intent,
        evidence: { chain: "found", ...stub.evidence },
      }));
      return Promise.resolve({
        settlements,
        ...(settlements.length === args.limit
          ? { nextAfter: { createdAt: PAGE_CURSOR_AT, settlementId: SETTLEMENT_ID } }
          : {}),
      });
    },
    reconcile: async (args: {
      settlementId: string;
      commit: (intent: unknown, tx: unknown) => Promise<unknown>;
      complete: (
        evidence: { transaction: string; amount: string },
        committed: unknown,
        tx: unknown
      ) => Promise<unknown>;
    }) => {
      if (stub.outcome) return stub.outcome;
      const intent = stub.intents.get(args.settlementId);
      if (!intent) return { refusal: "settlement_not_found" };
      if (stub.replayed) return { intent, replayed: true };
      const tx = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) };
      stub.commits += 1;
      const committed = await args.commit(intent, tx);
      const done = await args.complete(stub.evidence, committed, tx);
      return {
        intent,
        evidence: { chain: "found", ...stub.evidence },
        committed: done,
        replayed: false,
      };
    },
    writeOff: (args: { settlementId: string; note?: string }) => {
      if (stub.outcome) return Promise.resolve(stub.outcome);
      const intent = stub.intents.get(args.settlementId);
      if (!intent) return Promise.resolve({ refusal: "settlement_not_found" });
      const written = intent.status !== "written_off";
      if (written) {
        intent.status = "written_off";
        intent.writeOffNote = args.note;
      }
      return Promise.resolve({ intent, written });
    },
  };
}

function seedIntent(
  harness: Harness,
  overrides: {
    settlementId?: string;
    channelId?: string;
    effectId?: string;
    operation?: "fund" | "refund";
    status?: string;
  } = {}
): string {
  const settlementId = overrides.settlementId ?? SETTLEMENT_ID;
  harness.repair.intents.set(settlementId, {
    settlementId,
    channelId: overrides.channelId ?? X402_CHANNEL,
    operation: overrides.operation ?? "refund",
    effectId: overrides.effectId ?? `${X402_CREDIT}:d-x402`,
    status: overrides.status ?? "settled",
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_000,
    response: { amount: "999", transaction: "0xstale" },
  });
  return settlementId;
}

function seedExactIntent(harness: Harness): string {
  const intentId = "exact-intent-1";
  harness.exactRepair.intents.set(intentId, {
    id: intentId,
    dvmId: DVM_ID,
    resource: "/v1/job",
    network: "eip155:8453",
    asset: "0x1111111111111111111111111111111111111111",
    from: "0x2222222222222222222222222222222222222222",
    to: "0x3333333333333333333333333333333333333333",
    value: "1000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"44".repeat(32)}`,
    fingerprint: "not-a-bearer-signature",
    status: "settled",
    transaction: "0xexact",
    lastOutcome: "success",
    effect: { jobId: "job-1", drawBasis: true, ttlMs: 60_000 },
    createdAt: 1_750_000_000_000,
    updatedAt: 1_750_000_000_001,
  });
  return intentId;
}

/**
 * A channel-backed credit holding exactly the balance its wedged drain will
 * extinguish — the state the repair finds after the ledger leg rolled back.
 */
async function seedChannelCredit(ledger: CreditLedgerLike): Promise<void> {
  await fundCredit(ledger, {
    creditId: X402_CREDIT,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 400_000,
    expiryMs: Date.now() + 60_000,
    basis: {
      rail: "x402",
      paidMsats: 0,
      nativeAmount: 400_000,
      fundingRef: "0xdeposit",
      x402Channel: { channelId: X402_CHANNEL, maxClaimableAmount: "400000" },
    },
  });
}

/**
 * Seed a blocked invoice — the state exists to repair: a paid bolt11
 * whose `(credit_id, fund_id)` the ledger will refuse forever.
 */
async function seedBlocked(
  ledger: CreditLedgerLike,
  overrides: {
    creditId?: string;
    fundId?: string;
    paymentHash?: string;
    callerPubkey?: string;
    currency?: string;
    amountMicro?: number;
  } = {}
): Promise<void> {
  const creditId = overrides.creditId ?? "c-blocked";
  const fundId = overrides.fundId ?? "f1";
  await ledger.recordInvoice({
    creditId,
    fundId,
    callerPubkey: overrides.callerPubkey ?? CALLER,
    currency: overrides.currency ?? "usd",
    amountMicro: overrides.amountMicro ?? 500_000,
    amountMsats: 500_000,
    paymentHash: overrides.paymentHash ?? PAYMENT_HASH,
    bolt11: "lnbc1...",
    expiresAt: Date.now() + 900_000,
  });
  await ledger.markInvoiceBlocked({ creditId, fundId, reason: "funding_replayed_on_cashu" });
}

async function seedDrain(
  ledger: CreditLedgerLike,
  overrides: {
    method?: "cashu" | "x402" | "tempo";
    payout?: Record<string, string>;

    basis?: CreditFundingBasis;
  } = {}
): Promise<void> {
  await fundCredit(ledger, {
    creditId: "c1",
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 500_000,
    expiryMs: Date.now() + 60_000,
    ...(overrides.basis === undefined ? {} : { basis: overrides.basis }),
  });

  await ledger.draw({ creditId: "c1", drawId: "w1", amountMicro: 100_000 });
  await ledger.requestDrain({
    creditId: "c1",
    drainId: "d1",
    callerPubkey: CALLER,
    method: overrides.method ?? "cashu",
    payout: overrides.payout ?? { refund_pubkey: REFUND_PUBKEY },
  });
}

async function call(
  app: Hono,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Authorization: signAuth(method, path),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * A GET with a query string. The challenge covers `c.req.path`, which excludes
 * the query — so the signature is over the bare path, exactly as the CLI client
 * does it.
 */
async function callQuery(app: Hono, path: string, query: string): Promise<Response> {
  return app.request(`${path}${query}`, {
    method: "GET",
    headers: { Authorization: signAuth("GET", path) },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("admin-credit auth", () => {
  it("returns the shared 503 and safely retries the same signed request after recovery", async () => {
    const getLockPubkeyState = vi
      .fn<Parameters<typeof installAdminCreditRoutes>[1]["getLockPubkeyState"]>()
      .mockRejectedValueOnce(new Error("connection terminated unexpectedly"))
      .mockResolvedValue({ current: toLockPubkey(LOCK_PUBKEY), retired: [] });
    const nonceStore = {
      has: vi.fn(() => Promise.resolve(false)),
      mark: vi.fn(() => Promise.resolve()),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = makeHarness({ getLockPubkeyState, nonceStore });
    const listPendingDrains = vi.spyOn(harness.ledger, "listPendingDrains");
    const path = "/admin/credit/pending-drains";
    const authorization = signAuth("GET", path);

    const unavailable = await harness.app.request(path, {
      headers: { Authorization: authorization },
    });

    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({ error: "admin_state_unavailable" });
    expect(listPendingDrains).not.toHaveBeenCalled();
    expect(nonceStore.has).not.toHaveBeenCalled();
    expect(nonceStore.mark).not.toHaveBeenCalled();
    expect(harness.queries).toEqual([]);

    const recovered = await harness.app.request(path, {
      headers: { Authorization: authorization },
    });
    expect(recovered.status).toBe(200);
    expect(listPendingDrains).toHaveBeenCalledOnce();
    expect(nonceStore.has).toHaveBeenCalledOnce();
    expect(nonceStore.mark).toHaveBeenCalledOnce();
  });

  it("does not enter a mutation handler when lock state cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nonceStore = {
      has: vi.fn(() => Promise.resolve(false)),
      mark: vi.fn(() => Promise.resolve()),
    };
    const harness = makeHarness({
      getLockPubkeyState: () => Promise.reject(new Error("database unavailable")),
      nonceStore,
    });
    const markDrainSent = vi.spyOn(harness.ledger, "markDrainSent");

    const res = await call(harness.app, "POST", "/admin/credit/mark-drain-sent", {
      credit_id: "c1",
      drain_id: "d1",
      sent_ref: { tx: "0x1" },
    });

    expect(res.status).toBe(503);
    expect(markDrainSent).not.toHaveBeenCalled();
    expect(nonceStore.has).not.toHaveBeenCalled();
    expect(nonceStore.mark).not.toHaveBeenCalled();
  });

  it("keeps a genuine signer mismatch as 401 bad_signature", async () => {
    const { app } = makeHarness();
    const path = "/admin/credit/pending-drains";
    const valid = signAuth("GET", path);
    const badSignature = `${valid.slice(0, -1)}${valid.endsWith("0") ? "1" : "0"}`;

    const res = await app.request(path, { headers: { Authorization: badSignature } });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ reason: "bad_signature" });
  });
});

describe("GET /admin/credit/bitcoin-liability", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/bitcoin-liability");
    expect(res.status).toBe(401);
  });

  it("reconciles the floor with the funding lots behind it", async () => {
    const fetchRate = vi.spyOn(stubFx, "fetch");
    const { app, ledger } = makeHarness();
    await fundCredit(ledger, {
      creditId: "btc-1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_151_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "lightning", paidMsats: 1_151_000 },
    });
    await ledger.draw({ creditId: "btc-1", drawId: "j1", amountMicro: 9_000 });
    await ledger.settle({ creditId: "btc-1", drawId: "j1" });

    const res = await call(app, "GET", "/admin/credit/bitcoin-liability");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      deposit_liability_sats: 1_142,
      deposit_credits: 1,
      deposit_by_rail: [{ rail: "lightning", sats: 1_142, credits: 1 }],
      deposit_by_currency: [{ currency: "usd", micro: 1_142_000, credits: 1 }],
      drain_liability_sats: 0,
      total_owed_sats: 1_142,
      uncovered_credits: 0,
      unbacked_credits: 0,
    });

    expect(fetchRate).not.toHaveBeenCalled();
    fetchRate.mockRestore();
  });

  it("counts a registered reclaim beside the undrawn deposits", async () => {
    const { app, ledger } = makeHarness();
    await fundCredit(ledger, {
      creditId: "btc-2",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 500_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "cashu", paidMsats: 500_000 },
    });
    await ledger.requestDrain({
      creditId: "btc-2",
      drainId: "d1",
      callerPubkey: CALLER,
      method: "cashu",
      payout: { refund_pubkey: REFUND_PUBKEY },
    });

    const res = await call(app, "GET", "/admin/credit/bitcoin-liability");

    await expect(res.json()).resolves.toMatchObject({
      deposit_liability_sats: 0,
      drain_liability_sats: 500 - DRAIN_DELIVERY_RESERVE_SATS,
      drain_count: 1,
      total_owed_sats: 500 - DRAIN_DELIVERY_RESERVE_SATS,
    });
  });

  it("names balance the in-kind figure cannot speak for rather than counting it as nothing", async () => {
    const { app, ledger } = makeHarness();
    // No rail basis, so the lot is honest at zero sats and the reclaim will
    // price off a live rate. Folding that into the floor would understate it.
    await fundCredit(ledger, {
      creditId: "btc-3",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 400_000,
      expiryMs: Date.now() + 60_000,
    });

    const res = await call(app, "GET", "/admin/credit/bitcoin-liability");
    await expect(res.json()).resolves.toMatchObject({
      deposit_liability_sats: 0,
      total_owed_sats: 0,
      unbacked_credits: 1,
      unbacked_by_currency: [{ currency: "usd", micro: 400_000, credits: 1 }],
    });
  });

  it("serves the portable mixed-currency liability response", async () => {
    const { app, ledger } = makeHarness();
    for (const [currency, uncovered, basisless] of [
      ["usd", 1_000_000, 200_000],
      ["jpy", 100_000_000, 20_000_000],
    ] as const) {
      const credit = await fundCredit(ledger, {
        creditId: `gap-${currency}`,
        callerPubkey: CALLER,
        currency,
        amountMicro: uncovered,
        expiryMs: Date.now() + 60_000,
        basis: { rail: "cashu", paidMsats: 1_000_000 },
      });
      removeFundingLots(ledger as MemoryCreditLedger, credit.creditId);
      await fundCredit(ledger, {
        creditId: `basisless-${currency}`,
        callerPubkey: CALLER,
        currency,
        amountMicro: basisless,
        expiryMs: Date.now() + 60_000,
        basis: { rail: "cashu", paidMsats: 0 },
      });
    }
    await fundCredit(ledger, {
      creditId: "backed-eur",
      callerPubkey: CALLER,
      currency: "eur",
      amountMicro: 500_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "cashu", paidMsats: 500_000 },
    });

    const res = await call(app, "GET", "/admin/credit/bitcoin-liability");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(liabilityFixture.response);
  });

  it("ignores channel-backed credits, whose unused value never left the escrow", async () => {
    const { app, ledger } = makeHarness();
    await fundCredit(ledger, {
      creditId: "chan-1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 900_000,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "x402",
        paidMsats: 1,
        nativeAmount: 900_000,
        nativeAsset: "usdc",
        x402Channel: { channelId: X402_CHANNEL, maxClaimableAmount: "900000" },
      },
    });

    const res = await call(app, "GET", "/admin/credit/bitcoin-liability");
    await expect(res.json()).resolves.toMatchObject({
      deposit_liability_sats: 0,
      deposit_credits: 0,
      total_owed_sats: 0,
      unbacked_credits: 0,
    });
  });
});

describe("GET /admin/credit/pending-drains", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/pending-drains");
    expect(res.status).toBe(401);
  });

  it("prices pending drains in sats/msats and rolls up liability by rail", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger);
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as {
      drains: Record<string, unknown>[];
      liability: Record<string, unknown>;
    };
    expect(res.status).toBe(200);

    const netSats = 400 - DRAIN_DELIVERY_RESERVE_SATS;
    expect(body.drains).toEqual([
      expect.objectContaining({
        credit_id: "c1",
        drain_id: "d1",
        method: "cashu",
        amount_micro: 400_000,
        amount_sats: netSats,
        amount_msats: netSats * 1000,
        payout: { refund_pubkey: REFUND_PUBKEY },
      }),
    ]);
    expect(body.liability).toMatchObject({ cashu_sats: netSats });

    expect(body.liability).not.toHaveProperty("lightning_msats");
    expect(body.drains[0]).toMatchObject({ settlement: "automatic" });
  });

  // A stablecoin refund has no builder-held send key, so nothing
  // here prices or pays it — `serviceDrains` files it for a person. Without
  // the flag, `amount_sats: null` reads like an fx failure rather than the
  // operator's own worklist.
  it("marks a stablecoin drain unpriced and manual, and totals what only a person settles", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { method: "x402", payout: { address: `0x${"ab".repeat(20)}` } });
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as {
      drains: Record<string, unknown>[];
      liability: Record<string, unknown>;
    };
    expect(res.status).toBe(200);
    expect(body.drains).toEqual([
      expect.objectContaining({
        method: "x402",
        amount_micro: 400_000,
        amount_sats: null,
        amount_msats: null,
        settlement: "manual",
        payout: { address: `0x${"ab".repeat(20)}` },
      }),
    ]);
    expect(body.liability).toMatchObject({
      cashu_sats: 0,
      manual_micro: 400_000,
    });
  });

  /* Bitcoin drain figures are fixed in-kind at registration; listing must not reprice them. */
  it("publishes the in-kind figure and consults no rate to do it", async () => {
    const fetchRate = vi.spyOn(stubFx, "fetch");
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { basis: { rail: "lightning", paidMsats: 500_000 } });
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as {
      drains: Record<string, unknown>[];
      liability: Record<string, unknown>;
    };
    expect(res.status).toBe(200);

    expect(body.drains[0]).toMatchObject({
      amount_micro: 400_000,
      amount_sats: 400 - DRAIN_DELIVERY_RESERVE_SATS,
      amount_msats: (400 - DRAIN_DELIVERY_RESERVE_SATS) * 1000,
      sats_basis: "in_kind",
    });
    expect(body.liability).toMatchObject({ cashu_sats: 400 - DRAIN_DELIVERY_RESERVE_SATS });
    expect(fetchRate).not.toHaveBeenCalled();
    fetchRate.mockRestore();
  });

  it("says when a sats figure came from a live rate instead", async () => {
    const { app, ledger } = makeHarness();

    await seedDrain(ledger);
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as { drains: Record<string, unknown>[] };
    expect(body.drains[0]).toMatchObject({
      amount_sats: 400 - DRAIN_DELIVERY_RESERVE_SATS,
      sats_basis: "rate",
    });
  });

  // Manual payouts use rail-native units, which need not have six decimals.
  it("publishes the drain's rail-native debit, which is what a manual payout is sized in", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, {
      method: "x402",
      payout: { address: `0x${"ab".repeat(20)}` },
      basis: {
        rail: "x402",
        paidMsats: 0,
        nativeAmount: 500_000,
        nativeAsset: "usdc",
        fundingRef: "0xseed",
      },
    });
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as { drains: Record<string, unknown>[] };
    expect(res.status).toBe(200);

    expect(body.drains[0]).toMatchObject({
      amount_micro: 400_000,
      amount_native: 400_000,
      amount_sats: null,
    });
  });

  it("reports no native figure rather than a guessed one when the credit records no basis", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { method: "x402", payout: { address: `0x${"ab".repeat(20)}` } });
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as { drains: Record<string, unknown>[] };
    expect(body.drains[0]).toMatchObject({ amount_native: null, amount_micro: 400_000 });
  });

  // A pending channel close is self-settling, not an operator-funded manual payout.
  it("does not call a channel-backed reclaim manual — its own close settles it", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, {
      method: "tempo",
      payout: {},
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 500_000,
        nativeAsset: "usdc",
        tempoSession: { channelId: "chan-1", cumulativeAmount: "500000" },
      },
    });
    const res = await call(app, "GET", "/admin/credit/pending-drains");
    const body = (await res.json()) as {
      drains: Record<string, unknown>[];
      liability: Record<string, unknown>;
    };
    expect(body.drains[0]).toMatchObject({
      method: "tempo",
      settlement: "channel",
      channel_id: "chan-1",
      amount_micro: 400_000,
    });

    expect(body.liability).toMatchObject({ manual_micro: 0, channel_micro: 400_000 });
  });
});

describe("POST /admin/credit/park-drain", () => {
  const PARK_BODY = {
    credit_id: "c1",
    drain_id: "d1",
    consumed_row_ids: ["r1"],
    keep_proofs: [
      {
        id: "009a1f293253e41e",
        amount: 112,
        secret: p2pkSecret(LOCK_PUBKEY),
        C: "02" + "44".repeat(32),
      },
    ],
  };

  it("returns a typed refusal when accumulator persistence is not wired", async () => {
    const { app, queries } = makeHarness({ accumulatorWired: false });
    const res = await call(app, "POST", "/admin/credit/park-drain", {});

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "accumulator_not_wired" });
    expect(queries).toHaveLength(0);
  });

  it("parks a correctly-locked token in one transaction and countersigns it", async () => {
    const { app, ledger, queries } = makeHarness();
    await seedDrain(ledger);
    const res = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "parked" });

    const drain = await ledger.getDrain({ creditId: "c1", drainId: "d1" });
    expect(drain?.status).toBe("parked");
    expect(drain?.token).toBe(refundToken());

    expect(drain?.receipts).toHaveLength(1);
    expect(verifyDrainReceipt(drain?.receipts[0] as never)).toBe(true);
    expect(drain?.receipts[0]).toMatchObject({
      event: "parked",
      amount_micro: 400_000,
      balance_after_micro: 100_000,
    });

    const texts = queries.map((q) => q.text);
    const begin = texts.findIndex((t) => t === "BEGIN");
    const commit = texts.findIndex((t) => t === "COMMIT");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    expect(texts.some((t) => t.includes("SET melt_status = 'drained'"))).toBe(true);
    expect(texts.some((t) => t.includes("INSERT INTO wallet_accumulator"))).toBe(true);
  });

  it("is idempotent under retry with the same token", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger);
    const first = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
    });
    expect(first.status).toBe(200);
    const retry = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "parked" });

    const conflicting = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken("03" + "ee".repeat(32)),
    });
    expect(conflicting.status).toBe(409);
  });

  it("refuses a token not locked to the drain's refund key", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger);
    const res = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken("03" + "ee".repeat(32)),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("wrong_lock_pubkey");
    expect((await ledger.getDrain({ creditId: "c1", drainId: "d1" }))?.status).toBe("pending");
  });

  it("refuses change proofs not locked to an accepted builder key", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger);
    const res = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
      keep_proofs: [
        {
          id: "009a1f293253e41e",
          amount: 112,
          secret: p2pkSecret("03" + "99".repeat(32)),
          C: "02" + "44".repeat(32),
        },
      ],
    });
    expect(res.status).toBe(422);
  });

  it("refuses a token whose proofs are not UNSPENT at the mint", async () => {
    const { app, ledger, proofStates } = makeHarness();
    await seedDrain(ledger);
    proofStates[0] = { state: CheckStateEnum.SPENT };
    const res = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("proofs_not_unspent");
  });

  it("routes non-cashu drains to mark-drain-sent instead", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { method: "x402", payout: { address: `0x${"ab".repeat(20)}` } });
    const res = await call(app, "POST", "/admin/credit/park-drain", {
      ...PARK_BODY,
      token: refundToken(),
    });
    expect(res.status).toBe(422);
  });

  /* JIT refunds consume no accumulator rows; mint evidence must agree with the token. */
  describe("a just-in-time mint", () => {
    const EVIDENCE = {
      source: "jit_mint" as const,
      mint_url: MINT_URL,
      quote_id: "quote-1",
      face_sats: 400,
      reserve_sats: 8,
      invoice_msats: 400_400,
      routing_fee_msats: 1_100,
    };

    it("parks with no consumed rows and records what the refund cost", async () => {
      const { app, ledger, queries } = makeHarness();
      await seedDrain(ledger);
      const res = await call(app, "POST", "/admin/credit/park-drain", {
        credit_id: "c1",
        drain_id: "d1",
        token: refundToken(),
        consumed_row_ids: [],
        keep_proofs: [],
        mint_evidence: EVIDENCE,
      });
      expect(res.status).toBe(200);

      const drain = await ledger.getDrain({ creditId: "c1", drainId: "d1" });
      expect(drain?.status).toBe("parked");
      expect(drain?.fulfilment).toMatchObject({
        source: "jit_mint",
        mintUrl: MINT_URL,
        quoteId: "quote-1",
        faceSats: 400,
        reserveSats: 8,
        invoiceMsats: 400_400,
        routingFeeMsats: 1_100,
      });

      const texts = queries.map((q) => q.text);
      expect(texts.some((t) => t.includes("SET melt_status = 'drained'"))).toBe(false);
      expect(texts.some((t) => t.includes("INSERT INTO wallet_accumulator"))).toBe(false);
    });

    it("still refuses a park that consumed nothing and says nothing about why", async () => {
      const { app, ledger } = makeHarness();
      await seedDrain(ledger);
      const res = await call(app, "POST", "/admin/credit/park-drain", {
        credit_id: "c1",
        drain_id: "d1",
        token: refundToken(),
        consumed_row_ids: [],
        keep_proofs: [],
      });
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_body" });
    });

    it("refuses evidence naming a mint the token did not come from", async () => {
      const { app, ledger } = makeHarness();
      await seedDrain(ledger);
      const res = await call(app, "POST", "/admin/credit/park-drain", {
        credit_id: "c1",
        drain_id: "d1",
        token: refundToken(),
        consumed_row_ids: [],
        keep_proofs: [],
        mint_evidence: { ...EVIDENCE, mint_url: "https://elsewhere.example.com" },
      });
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ error: "mint_evidence_mismatch" });
    });

    it("refuses evidence claiming a face value the token does not carry", async () => {
      const { app, ledger } = makeHarness();
      await seedDrain(ledger);
      const res = await call(app, "POST", "/admin/credit/park-drain", {
        credit_id: "c1",
        drain_id: "d1",
        token: refundToken(),
        consumed_row_ids: [],
        keep_proofs: [],
        mint_evidence: { ...EVIDENCE, face_sats: 4_000 },
      });
      expect(res.status).toBe(422);
      await expect(res.json()).resolves.toMatchObject({ error: "mint_evidence_mismatch" });
    });

    it("refuses accumulator rows alongside it — a bought refund consumes none", async () => {
      const { app, ledger } = makeHarness();
      await seedDrain(ledger);
      const res = await call(app, "POST", "/admin/credit/park-drain", {
        ...PARK_BODY,
        token: refundToken(),
        mint_evidence: EVIDENCE,
      });
      expect(res.status).toBe(400);
    });
  });
});

describe("POST /admin/credit/mark-drain-sent", () => {

  it("404s an unknown drain", async () => {
    const { app } = makeHarness();
    const res = await call(app, "POST", "/admin/credit/mark-drain-sent", {
      credit_id: "ghost",
      drain_id: "d9",
      sent_ref: {},
    });
    expect(res.status).toBe(404);
  });

  it("records a stablecoin settlement once and says which call did it", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { method: "x402", payout: { address: `0x${"ab".repeat(20)}` } });
    const body = {
      credit_id: "c1",
      drain_id: "d1",
      sent_ref: { transaction: "0xfeed", settled_by: "operator" },
    };

    const first = await call(app, "POST", "/admin/credit/mark-drain-sent", body);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: "sent", replayed: false });

    const again = await call(app, "POST", "/admin/credit/mark-drain-sent", {
      ...body,
      sent_ref: { transaction: "0xdead", settled_by: "operator" },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ replayed: true });

    const drain = await ledger.getDrain({ creditId: "c1", drainId: "d1" });
    expect(drain?.status).toBe("sent");
    expect(drain?.receipts[0]).toMatchObject({
      event: "sent",
      amount_micro: 400_000,
      balance_after_micro: 100_000,
    });

    expect(drain?.sentRef).toMatchObject({ transaction: "0xfeed" });

    expect(drain?.receipts.filter((r) => r.event === "sent")).toHaveLength(1);
  });

  it("refuses a drain that is not pending rather than overwriting its settlement", async () => {
    const { app, ledger } = makeHarness();

    await seedDrain(ledger);
    const res = await call(app, "POST", "/admin/credit/mark-drain-sent", {
      credit_id: "c1",
      drain_id: "d1",
      sent_ref: { transaction: "0xfeed" },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "invalid_drain_state" });
    expect((await ledger.getDrain({ creditId: "c1", drainId: "d1" }))?.status).toBe("pending");
  });

  // The channel close owns this transition; manual marking would bypass its reconciliation.
  it("refuses a channel-bound reclaim rather than recording it by hand", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, {
      method: "tempo",
      payout: {},
      basis: {
        rail: "tempo",
        paidMsats: 0,
        nativeAmount: 500_000,
        nativeAsset: "usdc",
        tempoSession: { channelId: "chan-1", cumulativeAmount: "500000" },
      },
    });
    const res = await call(app, "POST", "/admin/credit/mark-drain-sent", {
      credit_id: "c1",
      drain_id: "d1",
      sent_ref: { transaction: "0xfeed", settled_by: "operator" },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "channel_bound_drain" });

    const drain = await ledger.getDrain({ creditId: "c1", drainId: "d1" });
    expect(drain?.status).toBe("pending");
    expect(drain?.receipts.filter((r) => r.event === "sent")).toHaveLength(0);
  });
});

describe("GET /admin/credit/blocked-invoices", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/blocked-invoices");
    expect(res.status).toBe(401);
  });

  it("lists a blocked invoice with everything the operator needs to act", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    const res = await call(app, "GET", "/admin/credit/blocked-invoices");
    const body = (await res.json()) as { invoices: Record<string, unknown>[] };
    expect(res.status).toBe(200);
    expect(body.invoices).toEqual([
      expect.objectContaining({
        payment_hash: PAYMENT_HASH,
        credit_id: "c-blocked",
        fund_id: "f1",
        caller_pubkey: CALLER,
        amount_micro: 500_000,
        amount_msats: 500_000,
        currency: "usd",
        status: "blocked",
        blocked_reason: "funding_replayed_on_cashu",
      }),
    ]);
  });

  it("hides resolved rows by default and pages with a keyset cursor", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger, { fundId: "f1", paymentHash: "11".repeat(32) });
    await seedBlocked(ledger, { fundId: "f2", paymentHash: "22".repeat(32) });
    await ledger.writeOffBlockedInvoice({ paymentHash: "11".repeat(32), note: "duplicate" });

    const plain = (await (await call(app, "GET", "/admin/credit/blocked-invoices")).json()) as {
      invoices: { payment_hash: string }[];
    };
    expect(plain.invoices.map((i) => i.payment_hash)).toEqual(["22".repeat(32)]);

    const all = (await (
      await callQuery(app, "/admin/credit/blocked-invoices", "?include_resolved=true&limit=1")
    ).json()) as { invoices: { payment_hash: string }[]; next_after?: string };
    expect(all.invoices).toHaveLength(1);
    const cursor = all.next_after ?? "";
    expect(cursor).not.toBe("");

    const next = (await (
      await callQuery(
        app,
        "/admin/credit/blocked-invoices",
        `?include_resolved=true&limit=1&after=${cursor}`
      )
    ).json()) as { invoices: { payment_hash: string }[] };
    expect(next.invoices.map((i) => i.payment_hash)).not.toEqual(
      all.invoices.map((i) => i.payment_hash)
    );
  });

  it("refuses a limit outside the served range", async () => {
    const { app } = makeHarness();
    const res = await callQuery(app, "/admin/credit/blocked-invoices", "?limit=9999");
    expect(res.status).toBe(400);
  });
});

describe("POST /admin/credit/reconcile-invoice", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/reconcile-invoice", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("credits the payment onto the named credit and books the deposit", async () => {
    const { app, ledger, lookupSettlement } = makeHarness();
    await seedBlocked(ledger);
    let outbox: unknown;
    const reconcile = ledger.reconcileBlockedInvoice.bind(ledger);
    vi.spyOn(ledger, "reconcileBlockedInvoice").mockImplementation((args) => {
      outbox = args.depositOutbox?.payload;
      return reconcile(args);
    });
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: "reconciled",
      credit_id: "c-target",
      // The funding lands under the payment hash, not the invoice's own
      // fund_id — which is frequently the key that blocked it in the first place.
      fund_id: PAYMENT_HASH,
      amount_micro: 500_000,
      replayed: false,
    });

    const credit = await ledger.get("c-target");
    expect(credit).toMatchObject({
      callerPubkey: CALLER,
      balanceMicro: 500_000,
      rail: "lightning",
    });
    expect(lookupSettlement).toHaveBeenCalledWith(PAYMENT_HASH);
    // Memory has no transactional outbox. credit-lightning.db.test.ts proves atomic persistence.
    expect(outbox).toMatchObject({
      dvmId: DVM_ID,
      creditId: "c-target",
      fundingId: PAYMENT_HASH,
      rail: "lightning",
      amountMicro: 500_000,
      creditCurrency: "usd",

      fundedAt: SETTLED_AT,

      repaired: true,
    });

    const invoice = await ledger.getInvoiceByPaymentHash(PAYMENT_HASH);
    expect(invoice).toMatchObject({
      status: "reconciled",
      reconciledCreditId: "c-target",
      reconciledFundId: PAYMENT_HASH,
      settledAt: SETTLED_AT,

      blockedReason: "funding_replayed_on_cashu",
    });
  });

  it("credits once under a repeated run", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    const body = { payment_hash: PAYMENT_HASH, credit_id: "c-target" };
    const first = await call(app, "POST", "/admin/credit/reconcile-invoice", body);
    const second = await call(app, "POST", "/admin/credit/reconcile-invoice", body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({ replayed: true });

    const credit = await ledger.get("c-target");
    expect(credit?.balanceMicro).toBe(500_000);
  });

  it("refuses a second target once the money has moved", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-elsewhere",
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "invoice_already_reconciled",
      credit_id: "c-target",
    });
    expect(await ledger.get("c-elsewhere")).toBeUndefined();
  });

  it("refuses a credit another caller holds", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    await fundCredit(ledger, {
      creditId: "c-theirs",
      callerPubkey: OTHER_CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: Date.now() + 60_000,
    });
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-theirs",
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "caller_mismatch",
    });
    expect((await ledger.get("c-theirs"))?.balanceMicro).toBe(1_000);
  });

  it("refuses a credit funded on another rail", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    await fundCredit(ledger, {
      creditId: "c-cashu",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: Date.now() + 60_000,
      basis: { rail: "cashu", paidMsats: 1, fundingRef: "x" },
    });
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-cashu",
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({ error: "rail_mismatch" });
  });

  it("will not open a derived credit id other than the one this invoice derives", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: `fnd:${"00".repeat(32)}:someone-elses`,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "credit_id_unavailable",
    });
    expect(await ledger.get(`fnd:${"00".repeat(32)}:someone-elses`)).toBeUndefined();
  });

  it("never shortens a target credit that has more life left on it", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    // `fund`'s upsert overwrites expiry_ms, so a bare `now + ttl` here would
    // destroy spendable time on a longer-lived credit.
    const farFuture = Date.now() + CREDIT_TTL_MS * 4;
    await fundCredit(ledger, {
      creditId: "c-target",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      expiryMs: farFuture,
      basis: { rail: "lightning", paidMsats: 1, fundingRef: "earlier" },
    });
    await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect((await ledger.get("c-target"))?.expiryMs).toBe(farFuture);
  });

  it("refuses when the wallet says the invoice was never paid", async () => {
    const { app, ledger, lookupSettlement } = makeHarness();
    await seedBlocked(ledger);
    lookupSettlement.mockResolvedValueOnce({ settled: false, known: true } as never);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "invoice_not_settled",
    });
    expect(await ledger.get("c-target")).toBeUndefined();
  });

  it("tells the operator they are pointed at the wrong wallet, not to retry", async () => {
    // A wallet that definitively does not know the invoice needs configuration repair, not retry.
    const { app, ledger, lookupSettlement } = makeHarness();
    await seedBlocked(ledger);
    lookupSettlement.mockResolvedValueOnce({ settled: false, known: false } as never);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ error: "invoice_unknown_to_wallet" });
    expect(String(body.message)).toContain("DVMKIT_NWC_RECEIVE_URI");
    expect(await ledger.get("c-target")).toBeUndefined();
  });

  it("refuses when the wallet cannot be reached", async () => {
    const { app, ledger, lookupSettlement } = makeHarness();
    await seedBlocked(ledger);
    lookupSettlement.mockRejectedValueOnce(new Error("relay timeout") as never);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(502);
    expect(await ledger.get("c-target")).toBeUndefined();
  });

  it("refuses on a DVM with no receive wallet rather than crediting on trust", async () => {
    const { app, ledger } = makeHarness({ noLightning: true });
    await seedBlocked(ledger);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(503);
    expect(await ledger.get("c-target")).toBeUndefined();
  });

  it("refuses an invoice whose denomination the DVM no longer prices in", async () => {
    const { app, ledger } = makeHarness({ creditCurrency: "eur" });
    await seedBlocked(ledger);
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(422);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      error: "currency_drift",
    });
  });

  it("404s an unknown payment hash and 422s a pending invoice", async () => {
    const { app, ledger } = makeHarness();
    const missing = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(missing.status).toBe(404);

    await ledger.recordInvoice({
      creditId: "c-ok",
      fundId: "f-ok",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 1_000,
      amountMsats: 1_000,
      paymentHash: PAYMENT_HASH,
      bolt11: "lnbc1...",
      expiresAt: Date.now() + 900_000,
    });
    const pending = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(pending.status).toBe(422);
    expect((await pending.json()) as Record<string, unknown>).toMatchObject({
      error: "invoice_not_blocked",
    });
  });
});

describe("POST /admin/credit/write-off-invoice", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/write-off-invoice", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("moves the row out of the queue and touches no balance", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    const res = await call(app, "POST", "/admin/credit/write-off-invoice", {
      payment_hash: PAYMENT_HASH,
      note: "caller reused fund_id on cashu; already made whole there",
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toMatchObject({
      status: "written_off",
      amount_micro: 500_000,
    });

    const invoice = await ledger.getInvoiceByPaymentHash(PAYMENT_HASH);
    expect(invoice).toMatchObject({
      status: "written_off",
      writeOffNote: "caller reused fund_id on cashu; already made whole there",
      blockedReason: "funding_replayed_on_cashu",
    });
    expect(await ledger.get("c-blocked")).toBeUndefined();

    const queue = (await (await call(app, "GET", "/admin/credit/blocked-invoices")).json()) as {
      invoices: unknown[];
    };
    expect(queue.invoices).toEqual([]);
  });

  it("logs the amount once, however many times the verb is run", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await call(app, "POST", "/admin/credit/write-off-invoice", {
        payment_hash: PAYMENT_HASH,
        note: "already made whole",
      });
      const second = await call(app, "POST", "/admin/credit/write-off-invoice", {
        payment_hash: PAYMENT_HASH,
        note: "a different reason",
      });
      expect(await first.json()).toMatchObject({ replayed: false });

      expect(await second.json()).toMatchObject({
        replayed: true,
        note: "already made whole",
      });
      const written = warn.mock.calls.filter((args) =>
        String(args[0]).includes("lightning_invoice_written_off")
      );
      expect(written).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("is reversible — a written-off invoice can still be credited", async () => {
    const { app, ledger } = makeHarness();
    await seedBlocked(ledger);
    await call(app, "POST", "/admin/credit/write-off-invoice", { payment_hash: PAYMENT_HASH });
    const res = await call(app, "POST", "/admin/credit/reconcile-invoice", {
      payment_hash: PAYMENT_HASH,
      credit_id: "c-target",
    });
    expect(res.status).toBe(200);
    expect((await ledger.get("c-target"))?.balanceMicro).toBe(500_000);
  });

  it("404s an unknown payment hash", async () => {
    const { app } = makeHarness();
    const res = await call(app, "POST", "/admin/credit/write-off-invoice", {
      payment_hash: PAYMENT_HASH,
    });
    expect(res.status).toBe(404);
  });
});

describe("exact x402 settlement recovery routes", () => {
  it("lists safe intent and attempt evidence without the signed authorization", async () => {
    const harness = makeHarness();
    seedExactIntent(harness);
    const res = await call(harness.app, "GET", "/admin/credit/x402-exact-settlements");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      settlements: [
        {
          settlement_intent_id: "exact-intent-1",
          status: "settled",
          transaction: "0xexact",
          job_id: "job-1",
          attempts: [{ outcome: "timeout", detail: "TypeError" }],
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("signature");
    expect(JSON.stringify(body)).not.toContain("fingerprint");
  });

  it("reconciles by durable intent id without accepting an operator amount or transaction", async () => {
    const harness = makeHarness();
    const intentId = seedExactIntent(harness);
    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-exact-settlement", {
      settlement_intent_id: intentId,
      transaction: "0xoperator-supplied",
      amount: "999999",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "reconciled",
      settlement_status: "complete",
      settlement_intent_id: intentId,
      transaction: "0xexact",
      amount: "1000",
      job_id: "job-1",
      replayed: false,
    });
    expect(harness.exactRepair.reconcile).toHaveBeenCalledWith(DVM_ID, intentId);
  });
});

describe("GET /admin/credit/x402-settlements", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/x402-settlements");
    expect(res.status).toBe(401);
  });

  it("says so when this DVM holds no durable settlements at all", async () => {
    const { app } = makeHarness({ noX402: true });
    const res = await call(app, "GET", "/admin/credit/x402-settlements");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "x402_settlement_unavailable" });
  });

  it("resolves each row's credit and drain from the channel, not by splitting the effect id", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    // A credit id carrying its own colons is the case a naive split gets wrong.
    harness.repair.intents.set(SETTLEMENT_ID, {
      settlementId: SETTLEMENT_ID,
      channelId: X402_CHANNEL,
      operation: "refund",
      effectId: `${X402_CREDIT}:drain:with:colons`,
      status: "settled",
      createdAt: 1,
      updatedAt: 2,
      response: { amount: "999", transaction: "0xstale" },
    });
    const res = await call(harness.app, "GET", "/admin/credit/x402-settlements");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      settlements: [
        {
          settlement_id: SETTLEMENT_ID,
          credit_id: X402_CREDIT,
          drain_id: "drain:with:colons",
          status: "settled",
          settled_amount: "999",
          chain: { chain: "found", amount: "400000" },
        },
      ],
    });
  });

  it("carries the balance the caller is locked out of, so the operator can rank the queue", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);

    const res = await call(harness.app, "GET", "/admin/credit/x402-settlements");
    expect(await res.json()).toMatchObject({
      settlements: [
        {
          credit_id: X402_CREDIT,
          credit_balance_micro: 400_000,
          credit_remaining_micro: 400_000,
          credit_currency: "usd",
          spending_blocked: true,
        },
      ],
    });
  });

  it("reports no hold for a settlement whose channel no longer names a credit", async () => {
    const harness = makeHarness();
    seedIntent(harness);

    const res = await call(harness.app, "GET", "/admin/credit/x402-settlements");
    expect(await res.json()).toMatchObject({
      settlements: [
        {
          credit_id: null,
          credit_balance_micro: null,
          credit_remaining_micro: null,
          credit_currency: null,
          spending_blocked: true,
        },
      ],
    });
  });

  it("hands its cursor back to the store with the timestamp intact", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);

    const first = await callQuery(
      harness.app,
      "/admin/credit/x402-settlements",
      "?limit=1&min_age_ms=0"
    );
    const { next_after: cursor } = (await first.json()) as { next_after?: string };
    expect(cursor).toBeTruthy();

    await callQuery(
      harness.app,
      "/admin/credit/x402-settlements",
      `?limit=1&after=${encodeURIComponent(cursor ?? "")}`
    );

    expect(harness.repair.listArgs[1]?.after).toEqual({
      createdAt: PAGE_CURSOR_AT,
      settlementId: SETTLEMENT_ID,
    });
  });

  it("refuses an unparseable page", async () => {
    const { app } = makeHarness();
    // The last one decodes and shapes correctly but carries a timestamp
    // Postgres would reject — it reaches SQL as a cast, so it must never get
    // there.
    const forgedCursor = Buffer.from(JSON.stringify(["yesterday", SETTLEMENT_ID])).toString(
      "base64url"
    );
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?after=nonsense",
      `?after=${forgedCursor}`,
      "?min_age_ms=-1",
    ]) {
      const res = await callQuery(app, "/admin/credit/x402-settlements", query);
      expect(res.status).toBe(400);
    }
  });
});

describe("POST /admin/credit/reconcile-x402-settlement", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/reconcile-x402-settlement", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("extinguishes the liability at the chain's figure and marks the drain sent", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);

    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "reconciled",
      credit_id: X402_CREDIT,
      drain_id: "d-x402",
      transaction: "0xrefund",
      settled_amount: "400000",
      amount_micro: 400_000,
      replayed: false,
    });
    const drain = await harness.ledger.getDrain({ creditId: X402_CREDIT, drainId: "d-x402" });
    expect(drain).toMatchObject({ status: "sent", method: "x402" });
    expect(drain?.sentRef).toMatchObject({ transaction: "0xrefund", repaired: true });
    expect((await harness.ledger.get(X402_CREDIT))?.balanceMicro).toBe(0);

    expect(harness.drains).toHaveBeenCalledTimes(1);
    expect(harness.drains).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callerPubkey: CALLER,
        amountMicro: 400_000,
        repaired: true,
        repairKind: "x402_settlement_reconciled",
      })
    );
  });

  it("accepts a chain payout above the ledger debit and records its surplus", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);
    harness.repair.evidence = { transaction: "0xrefund", amount: "500000" };

    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });

    expect(res.status).toBe(200);
    expect(
      await harness.ledger.getDrain({ creditId: X402_CREDIT, drainId: "d-x402" })
    ).toMatchObject({
      status: "sent",
      sentRef: { settled_amount: "500000", surplus_native: "100000", repaired: true },
    });
  });

  it("refuses when the chain payout is short of the ledger debit", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);

    harness.repair.evidence = { transaction: "0xrefund", amount: "123456" };

    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("drain_conflict");
    expect(body.message).toContain("123456");
    expect(body.message).toContain("400000");
  });

  it("books nothing twice when the settlement is already complete", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);
    harness.repair.replayed = true;

    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true });
    expect(harness.repair.commits).toBe(0);
    expect(harness.drains).not.toHaveBeenCalled();
  });

  it("keeps an unreadable chain apart from a chain that says nothing happened", async () => {
    for (const [refusal, status] of [
      ["chain_unreachable", 502],
      ["settlement_not_on_chain", 422],
      ["settlement_unbookmarked", 422],
      ["settlement_not_wedged", 422],
      ["settlement_not_found", 404],
      // A lost repair CAS is a structured conflict, not a generic rollback error.
      ["settlement_raced", 409],
    ] as const) {
      const harness = makeHarness();
      await seedChannelCredit(harness.ledger);
      seedIntent(harness);
      harness.repair.outcome = { refusal, status: "prepared", error: "rpc timeout" };
      const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
        settlement_id: SETTLEMENT_ID,
      });
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: refusal });
    }
  });

  it("refuses a body without a settlement id, an unknown settlement, and a deposit", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);

    const bad = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {});
    expect(bad.status).toBe(400);

    const missing = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(missing.status).toBe(404);

    seedIntent(harness, { operation: "fund", effectId: `${X402_CREDIT}:fund-1` });
    const deposit = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(deposit.status).toBe(422);
    expect(await deposit.json()).toMatchObject({ error: "settlement_not_repairable" });
  });

  it("404s a settlement whose channel no longer backs a credit", async () => {
    const harness = makeHarness();
    seedIntent(harness);
    const res = await call(harness.app, "POST", "/admin/credit/reconcile-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "credit_not_bound" });
  });
});

describe("POST /admin/credit/write-off-x402-settlement", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/write-off-x402-settlement", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("records the reason, books nothing, and reports a replay on the second call", async () => {
    const harness = makeHarness();
    await seedChannelCredit(harness.ledger);
    seedIntent(harness);

    const first = await call(harness.app, "POST", "/admin/credit/write-off-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
      note: "chain and ledger disagree",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "written_off",
      note: "chain and ledger disagree",
      replayed: false,
    });

    expect(await harness.ledger.getDrain({ creditId: X402_CREDIT, drainId: "d-x402" })).toBe(
      undefined
    );
    expect((await harness.ledger.get(X402_CREDIT))?.balanceMicro).toBe(400_000);
    expect(harness.drains).not.toHaveBeenCalled();

    const second = await call(harness.app, "POST", "/admin/credit/write-off-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
      note: "second thoughts",
    });
    expect(await second.json()).toMatchObject({
      note: "chain and ledger disagree",
      replayed: true,
    });
  });

  it("404s an unknown settlement", async () => {
    const { app } = makeHarness();
    const res = await call(app, "POST", "/admin/credit/write-off-x402-settlement", {
      settlement_id: SETTLEMENT_ID,
    });
    expect(res.status).toBe(404);
  });
});

/* Unlike an x402 wedge, a Tempo wedge already debited the ledger and has a pending drain. */
async function seedTempoWedge(
  ledger: CreditLedgerLike,
  overrides: { creditId?: string; drainId?: string; amountMicro?: number } = {}
): Promise<void> {
  const creditId = overrides.creditId ?? TEMPO_CREDIT;
  const amountMicro = overrides.amountMicro ?? TEMPO_DEBIT_NATIVE;
  await fundCredit(ledger, {
    creditId,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro,
    expiryMs: Date.now() + 60_000,
    basis: {
      rail: "tempo",
      paidMsats: 0,
      nativeAmount: amountMicro,
      fundingRef: "challenge-1",
      tempoSession: { channelId: TEMPO_CHANNEL, cumulativeAmount: String(amountMicro) },
    },
  });
  await ledger.requestDrain({
    creditId,
    drainId: overrides.drainId ?? TEMPO_DRAIN,
    callerPubkey: CALLER,
    method: "tempo",
    payout: { channel_id: TEMPO_CHANNEL },
  });
}

describe("GET /admin/credit/tempo-losses", () => {
  it("lists immutable loss evidence and offers no repair action", async () => {
    const { app, ledger } = makeHarness();
    const channelId = `0x${"4b".repeat(32)}`;
    const credit = await ledger.fund({
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 97_000,
      expiryMs: Date.now() + 60_000,
      basis: {
        rail: "tempo",
        paidMsats: 1,
        nativeAmount: 97_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "100000" },
      },
    });
    await ledger.terminalizeTempoCredits({
      channelId,
      settledOnChainNative: 0n,
      highestVoucherNative: 3_000n,
      consumedNative: 3_000n,
      observedAt: 456,
    });

    const res = await call(app, "GET", "/admin/credit/tempo-losses");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      losses: [
        {
          credit_id: credit.creditId,
          channel_id: channelId,
          caller_pubkey: CALLER,
          currency: "usd",
          former_balance_micro: 97_000,
          settled_on_chain_native: "0",
          highest_voucher_native: "3000",
          consumed_service_micro: 0,
          consumed_native: "3000",
          observed_at: 456,
          status: "unbacked",
        },
      ],
    });
  });
});

describe("GET /admin/credit/tempo-drains", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/tempo-drains");
    expect(res.status).toBe(401);
  });

  it("answers 503 when the DVM holds no durable Tempo session store", async () => {
    const { app } = makeHarness({ noTempo: true });
    const res = await call(app, "GET", "/admin/credit/tempo-drains");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "tempo_repair_unavailable" });
  });

  it("puts the chain's refund beside the debit it has to cover", async () => {
    const { app, ledger, tempo } = makeHarness();
    await seedTempoWedge(ledger);
    tempo.amounts = { refundedToPayer: 390_000n, settledToPayee: 110_000n };

    const res = await callQuery(app, "/admin/credit/tempo-drains", "?min_age_ms=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drains: Record<string, unknown>[] };
    expect(body.drains).toHaveLength(1);
    expect(body.drains[0]).toMatchObject({
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      channel_id: TEMPO_CHANNEL,
      amount_native: TEMPO_DEBIT_NATIVE,
      currency: "usd",
      status: "pending",
      write_off_note: null,
      chain: {
        chain: "found",
        transaction: TEMPO_TX,
        refundedToPayer: "390000",
        settledToPayee: "110000",
      },
    });
  });

  it("marks a row unreachable rather than failing the operator's whole page", async () => {
    const { app, ledger, tempo } = makeHarness();
    await seedTempoWedge(ledger);
    tempo.amountsError = new Error("rpc timeout");

    const res = await callQuery(app, "/admin/credit/tempo-drains", "?min_age_ms=0");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { drains: { chain?: { chain: string } }[] };
    expect(body.drains[0]?.chain).toEqual({ chain: "unreachable", error: "rpc timeout" });
  });

  it("skips the chain reads entirely when asked for a fast read of the queue", async () => {
    const { app, ledger, tempo } = makeHarness();
    await seedTempoWedge(ledger);

    const res = await callQuery(app, "/admin/credit/tempo-drains", "?evidence=false&min_age_ms=0");
    const body = (await res.json()) as { drains: Record<string, unknown>[] };
    expect(body.drains[0]).not.toHaveProperty("chain");
    expect(tempo.reads).toEqual([]);
  });

  it("hides a written-off drain until the audit view asks for it", async () => {
    const { app, ledger } = makeHarness();
    await seedTempoWedge(ledger);
    await ledger.writeOffDrain({
      creditId: TEMPO_CREDIT,
      drainId: TEMPO_DRAIN,
      note: "chain paid short",
    });

    const live = (await (
      await callQuery(app, "/admin/credit/tempo-drains", "?min_age_ms=0")
    ).json()) as { drains: unknown[] };
    expect(live.drains).toEqual([]);

    const audit = (await (
      await callQuery(app, "/admin/credit/tempo-drains", "?include_resolved=true&min_age_ms=0")
    ).json()) as { drains: Record<string, unknown>[] };
    expect(audit.drains[0]).toMatchObject({ write_off_note: "chain paid short" });
  });

  it("advances its cursor one page at a time instead of re-serving the boundary row", async () => {
    const { app, ledger } = makeHarness();
    await seedTempoWedge(ledger, { creditId: "c-tempo-a", drainId: "d-a" });
    await seedTempoWedge(ledger, { creditId: "c-tempo-b", drainId: "d-b" });

    const first = (await (
      await callQuery(app, "/admin/credit/tempo-drains", "?limit=1&min_age_ms=0")
    ).json()) as {
      drains: { credit_id: string }[];
      next_after?: string;
    };
    expect(first.drains).toHaveLength(1);
    expect(first.next_after).toBeDefined();

    const second = (await (
      await callQuery(
        app,
        "/admin/credit/tempo-drains",
        `?limit=1&min_age_ms=0&after=${encodeURIComponent(first.next_after ?? "")}`
      )
    ).json()) as { drains: { credit_id: string }[] };
    expect(second.drains).toHaveLength(1);
    expect(second.drains[0]?.credit_id).not.toBe(first.drains[0]?.credit_id);
  });

  it("refuses an unparseable page rather than guessing", async () => {
    const { app } = makeHarness();
    for (const query of ["?limit=0", "?limit=51", "?after=not-a-cursor", "?min_age_ms=-1"]) {
      const res = await callQuery(app, "/admin/credit/tempo-drains", query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_query" });
    }
  });
});

describe("POST /admin/credit/reconcile-tempo-drain", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/reconcile-tempo-drain", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("books the drain at the chain's own figure and marks it repaired", async () => {
    const { app, ledger, drains } = makeHarness();
    await seedTempoWedge(ledger);
    const res = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "reconciled",
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      channel_id: TEMPO_CHANNEL,
      transaction: TEMPO_TX,
      settled_amount: "400000",
      replayed: false,
    });
    const drain = await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN });
    expect(drain).toMatchObject({
      status: "sent",
      sentRef: { tx_hash: TEMPO_TX, settled_amount: "400000", repaired: true },
    });

    expect(drains).toHaveBeenCalledTimes(1);
    expect(drains).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callerPubkey: CALLER,
        amountMicro: TEMPO_DEBIT_NATIVE,
        repaired: true,
        repairKind: "tempo_close_reconciled",
      })
    );
    expect(drain?.receipts).toHaveLength(1);
  });

  it("refuses when the close refunded less than the ledger debited, naming both figures", async () => {
    const enqueue = vi.fn(async () => undefined);
    const committed = vi.fn();
    const { app, ledger, tempo, drains } = makeHarness({
      onTempoDrainReconciled: { enqueue, committed },
    });
    await seedTempoWedge(ledger);
    tempo.amounts = { refundedToPayer: 399_999n, settledToPayee: 100_001n };

    const res = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("drain_conflict");
    expect(body.message).toContain("399999");
    expect(body.message).toContain("400000");
    expect(await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN })).toMatchObject({
      status: "pending",
      sentRef: null,
    });
    expect(drains).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
  });

  it("queues the close's payee side inside the booking's transaction, once, never on the replay", async () => {
    const enqueue = vi.fn(async () => undefined);
    const committed = vi.fn();
    const { app, ledger, queries, drains } = makeHarness({
      onTempoDrainReconciled: { enqueue, committed },
    });
    await seedTempoWedge(ledger);
    const body = { credit_id: TEMPO_CREDIT, drain_id: TEMPO_DRAIN };
    expect((await call(app, "POST", "/admin/credit/reconcile-tempo-drain", body)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledWith(
      { channelId: TEMPO_CHANNEL, txHash: TEMPO_TX, settledToPayee: "100000" },
      expect.objectContaining({ query: expect.any(Function) })
    );
    // The drain report and the payout row ride the same client as the booking.
    const texts = queries.map((q) => q.text);
    expect(texts.indexOf("COMMIT")).toBeGreaterThan(texts.indexOf("BEGIN"));
    expect(drains).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.invocationCallOrder[0]).toBeGreaterThan(
      enqueue.mock.invocationCallOrder[0]
    );

    expect((await call(app, "POST", "/admin/credit/reconcile-tempo-drain", body)).status).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
  });

  it("rolls the booking back and fails the call when the payout row cannot be queued", async () => {
    const enqueue = vi.fn(async () => {
      throw new Error("outbox down");
    });
    const committed = vi.fn();
    const { app, ledger, queries } = makeHarness({
      onTempoDrainReconciled: { enqueue, committed },
    });
    await seedTempoWedge(ledger);
    const res = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(res.status).toBe(500);
    const texts = queries.map((q) => q.text);
    expect(texts).toContain("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
    expect(committed).not.toHaveBeenCalled();
  });

  it("books nothing twice, and does not pay for a chain read to find that out", async () => {
    const { app, ledger, drains, tempo } = makeHarness();
    await seedTempoWedge(ledger);
    const body = { credit_id: TEMPO_CREDIT, drain_id: TEMPO_DRAIN };
    await call(app, "POST", "/admin/credit/reconcile-tempo-drain", body);
    const readsAfterFirst = tempo.reads.length;

    const res = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true, settled_amount: "400000" });
    expect(drains).toHaveBeenCalledTimes(1);
    expect(tempo.reads).toHaveLength(readsAfterFirst);

    const drain = await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN });
    expect(drain?.receipts).toHaveLength(1);
  });

  it("keeps an unreadable chain apart from a close that states no figure", async () => {
    const unreachable = makeHarness();
    await seedTempoWedge(unreachable.ledger);
    unreachable.tempo.amountsError = new Error("rpc timeout");
    const down = await call(unreachable.app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ error: "chain_unreachable" });

    const synthetic = makeHarness();
    await seedTempoWedge(synthetic.ledger);
    synthetic.tempo.intent = {
      channelId: TEMPO_CHANNEL,
      drainId: TEMPO_DRAIN,
      reference: `channel:${TEMPO_CHANNEL}`,
    };
    const noReceipt = await call(synthetic.app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(noReceipt.status).toBe(422);
    expect(await noReceipt.json()).toMatchObject({ error: "close_refund_unreported" });

    const unconfirmed = makeHarness();
    await seedTempoWedge(unconfirmed.ledger);
    unconfirmed.tempo.intent = null;
    const noClose = await call(unconfirmed.app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(noClose.status).toBe(422);
    expect(await noClose.json()).toMatchObject({ error: "close_not_confirmed" });
  });

  it("refuses a body without both ids, an unknown drain, and a drain that is not a Tempo close", async () => {
    const { app, ledger } = makeHarness();
    await seedDrain(ledger, { method: "cashu" });

    const noIds = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {});
    expect(noIds.status).toBe(400);

    const unknown = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: "nope",
      drain_id: "nope",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "drain_not_found" });

    const cashu = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: "c1",
      drain_id: "d1",
    });
    expect(cashu.status).toBe(422);
    expect(await cashu.json()).toMatchObject({ error: "drain_not_repairable" });
  });

  it("takes a written-off drain and clears the note it books over", async () => {
    const { app, ledger } = makeHarness();
    await seedTempoWedge(ledger);
    await ledger.writeOffDrain({
      creditId: TEMPO_CREDIT,
      drainId: TEMPO_DRAIN,
      note: "reviewed",
    });

    const res = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(res.status).toBe(200);
    expect(await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN })).toMatchObject({
      status: "sent",
      writeOffNote: null,
      writtenOffAt: null,
    });
  });
});

describe("POST /admin/credit/write-off-tempo-drain", () => {
  it("refuses without auth", async () => {
    const { app } = makeHarness();
    const res = await app.request("/admin/credit/write-off-tempo-drain", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("records the reason, books nothing, and reports a replay on the second call", async () => {
    const { app, ledger, drains } = makeHarness();
    await seedTempoWedge(ledger);
    const before = await ledger.get(TEMPO_CREDIT);

    const res = await call(app, "POST", "/admin/credit/write-off-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      note: "chain paid short; refunded out of band",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "written_off",
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      note: "chain paid short; refunded out of band",
      replayed: false,
    });

    const drain = await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN });
    expect(drain).toMatchObject({ status: "pending", sentRef: null });
    expect((await ledger.get(TEMPO_CREDIT))?.balanceMicro).toBe(before?.balanceMicro);
    expect(drains).not.toHaveBeenCalled();

    const again = await call(app, "POST", "/admin/credit/write-off-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      note: "a different reason",
    });
    expect(await again.json()).toMatchObject({
      replayed: true,
      note: "chain paid short; refunded out of band",
    });
  });

  it("404s an unknown drain", async () => {
    const { app } = makeHarness();
    const res = await call(app, "POST", "/admin/credit/write-off-tempo-drain", {
      credit_id: "nope",
      drain_id: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("refuses a drain that already booked, rather than answering it as a replay", async () => {
    const { app, ledger } = makeHarness();
    await seedTempoWedge(ledger);
    const booked = await call(app, "POST", "/admin/credit/reconcile-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(booked.status).toBe(200);

    const res = await call(app, "POST", "/admin/credit/write-off-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
      note: "chain paid short",
    });
    // A booked refund must not be reported as written off: that can prompt a duplicate payout.
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "drain_not_wedged" });
    expect(await ledger.getDrain({ creditId: TEMPO_CREDIT, drainId: TEMPO_DRAIN })).toMatchObject({
      status: "sent",
      writeOffNote: null,
    });
  });

  it("refuses when a poll books the drain between the status read and the write", async () => {
    const { app, ledger } = makeHarness();
    await seedTempoWedge(ledger);
    const write = ledger.writeOffDrain.bind(ledger);
    vi.spyOn(ledger, "writeOffDrain").mockImplementationOnce(async (args) => {
      await ledger.markDrainSent({
        creditId: args.creditId,
        drainId: args.drainId,
        sentRef: { tx_hash: TEMPO_TX, channel_id: TEMPO_CHANNEL },
      });
      return write(args);
    });

    const res = await call(app, "POST", "/admin/credit/write-off-tempo-drain", {
      credit_id: TEMPO_CREDIT,
      drain_id: TEMPO_DRAIN,
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "drain_not_wedged" });
  });
});
