/* Real HTTP over an in-memory ledger checks wire behavior. SQL atomicity is covered separately. */
import { schnorr } from "@noble/curves/secp256k1.js";
import { Credential, Errors as MppxErrors } from "mppx";
import { BaseError, InsufficientFundsError } from "viem";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type DrainReceipt,
  type FundingReceipt,
  verifyDrainReceipt,
  verifyFundingReceipt,
} from "../../../lib/receipt";
import { servedApps } from "../../../test-support/served-app";
import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import type { CreditLedgerLike, CreditLedgerQuerier } from "../credit-ledger";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { derivedFundCreditId, fundingCommitment } from "../funding";
import { MemoryJobStore } from "../memory-job-store";
import type { MppxServer, TempoSessionDrainState } from "../mpp-setup";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import { TempoSettlementReadiness } from "../tempo-settlement-readiness";
import { durableLedger, fundCredit } from "./__helpers__/credit-fixtures";

const stubFx: FxFetcher = {
  fetch: () =>
    Promise.resolve({ rates: { usd: 100_000, eur: 90_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd", "eur"],
};

const signedSchema = z.object({
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]{128}$/),
  timestamp: z.number().int(),
  nonce: z.string().min(8),
  action: z.string(),
});

const PRIVKEY = new Uint8Array(32).fill(3);
const OTHER_PRIVKEY = new Uint8Array(32).fill(4);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const OTHER = hex(schnorr.getPublicKey(OTHER_PRIVKEY));
const FUTURE_MS = Date.now() + 24 * 60 * 60 * 1000;
const COMMITMENT = "ab".repeat(32);

const jobSigner = createSignedRequestVerifier(signedSchema);
const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

const servers = servedApps();

async function startServer(
  opts: {
    credit?: boolean;
    auth?: boolean;
    receiptKey?: string;
    currency?: string;
    ledger?: CreditLedgerLike;
    mpp?: MppxServer;
    tempoSettlementReadiness?: TempoSettlementReadiness;
  } = {}
): Promise<{ url: string; ledger: CreditLedgerLike }> {
  const ledger = opts.ledger ?? durableLedger();
  // a non-USD DVM prices dynamically. A static price is a USD literal
  // by grammar, so `configureDVM` refuses one alongside a non-USD `currency`.
  const currency = opts.currency;
  const pricing = currency
    ? {
        currency,
        onQuote: {
          schema: signedSchema,
          handler: () =>
            Promise.resolve({
              upfront: { amount: 0.1, currency },
              description: "do one",
            }),
        },
      }
    : { price: "$0.10" as const };
  const dvm = configureDVM({
    name: "credit-endpoint-test",
    capability: "do",
    input: signedSchema,
    ...pricing,
    onJob(ctx) {
      ctx.complete("done");
    },
    ...(opts.credit === false ? {} : { credit: { min: "$0.10", max: "$5.00" } }),
    ...(opts.auth === false ? {} : { auth: secp256k1Auth() }),
  });
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: ledger,
    ...(opts.mpp ? { mpp: opts.mpp } : {}),
    ...(opts.receiptKey ? { receiptKey: opts.receiptKey } : {}),
    ...(opts.tempoSettlementReadiness
      ? { tempoSettlementReadiness: opts.tempoSettlementReadiness }
      : {}),
  });
  const url = await servers.serve(app);
  return { url, ledger };
}

function tempoMpp(
  state: TempoSessionDrainState | (() => Promise<TempoSessionDrainState>)
): MppxServer & {
  issueChallenge: ReturnType<typeof vi.fn>;
  closeIntentDrainId: () => string | null;
  forecastPending: () => boolean;
} {
  let closeIntentDrainId: string | null = null;
  let forecastPending = false;
  const issueChallenge = vi.fn(
    (_method: string, _intent: string, options: Record<string, unknown>) =>
      Promise.resolve({
        id: "close-challenge",
        realm: "credit-endpoint.test",
        method: "tempo",
        intent: "session",
        request: { amount: options.amount as string, unitType: "request" },
        meta: options.meta as Record<string, string>,
      })
  );
  const beginTempoSessionClose = async (_channelId: string, drainId: string) => {
    if (closeIntentDrainId && closeIntentDrainId !== drainId) {
      throw new Error("Tempo session channel is already closing for another drain");
    }
    if (forecastPending) throw new Error("Tempo drain refund forecast is still pending");
    closeIntentDrainId = drainId;
  };
  const withTempoSessionCloseIntent = async <value>(
    channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ): Promise<value> => {
    const prior = closeIntentDrainId;
    const priorForecastPending = forecastPending;
    if (closeIntentDrainId && closeIntentDrainId !== drainId) {
      throw new Error("Tempo session channel is already closing for another drain");
    }
    closeIntentDrainId = drainId;
    forecastPending = true;
    try {
      return await operation({} as CreditLedgerQuerier);
    } catch (error) {
      closeIntentDrainId = prior;
      forecastPending = priorForecastPending;
      throw error;
    }
  };
  const resolveTempoSessionCloseForecast = async <value>(
    _channelId: string,
    drainId: string,
    decision: "proceed" | "release",
    operation?: (tx: CreditLedgerQuerier) => Promise<value>
  ) => {
    if (closeIntentDrainId !== drainId) return { outcome: "missing" as const };
    if (!forecastPending) return { outcome: "proceed" as const };
    if (decision === "proceed") {
      forecastPending = false;
      return { outcome: "proceed" as const };
    }
    if (!operation) throw new Error("forecast release operation missing");
    const prior = closeIntentDrainId;
    closeIntentDrainId = null;
    forecastPending = false;
    try {
      return { outcome: "released" as const, value: await operation({} as CreditLedgerQuerier) };
    } catch (error) {
      closeIntentDrainId = prior;
      forecastPending = true;
      throw error;
    }
  };
  const releaseTempoSessionCloseIntent = async <value>(
    _channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ): Promise<value> => {
    const prior = closeIntentDrainId;
    const priorForecastPending = forecastPending;
    if (closeIntentDrainId === drainId) {
      closeIntentDrainId = null;
      forecastPending = false;
    }
    try {
      return await operation({} as CreditLedgerQuerier);
    } catch (error) {
      closeIntentDrainId = prior;
      forecastPending = priorForecastPending;
      throw error;
    }
  };
  return {
    realm: "credit-endpoint.test",
    methods: [{ name: "tempo", intent: "session" } as never],
    challenge: {},
    issueChallenge: issueChallenge as MppxServer["issueChallenge"],
    broadcastCredential: () => Promise.reject(new Error("not used")),
    beginTempoSessionClose,
    withTempoSessionCloseIntent,
    resolveTempoSessionCloseForecast,
    releaseTempoSessionCloseIntent,
    closeIntentDrainId: () => closeIntentDrainId,
    forecastPending: () => forecastPending,
    getTempoSessionSpent: async () => (typeof state === "function" ? await state() : state).spent,
    getTempoSessionDrainState: () =>
      typeof state === "function" ? state() : Promise.resolve(state),
  } as unknown as MppxServer & {
    issueChallenge: ReturnType<typeof vi.fn>;
    closeIntentDrainId: () => string | null;
    forecastPending: () => boolean;
  };
}

function tempoCloseCredential(channelId: string): string {
  return Credential.serialize({
    challenge: {
      id: "close-challenge",
      realm: "credit-endpoint.test",
      method: "tempo",
      intent: "session",
      request: {
        amount: "100000",
        currency: `0x${"11".repeat(20)}`,
        recipient: `0x${"22".repeat(20)}`,
        unitType: "request",
      },
    },
    payload: {
      action: "close",
      channelId,
      cumulativeAmount: "10000",
    },
  });
}

async function tempoClosingCredit(args: {
  creditId: string;
  channelId: string;
  close: { settledToPayee: bigint; refundedToPayer: bigint };
  state?: TempoSessionDrainState;
  receiptKey?: string;
  tempoSettlementReadiness?: TempoSettlementReadiness;
}): Promise<{
  ledger: ReturnType<typeof durableLedger>;
  mpp: ReturnType<typeof tempoMpp>;
  url: string;
}> {
  const ledger = durableLedger();
  await fundCredit(ledger, {
    creditId: args.creditId,
    callerPubkey: CALLER,
    currency: "usd",
    amountMicro: 100_000,
    expiryMs: FUTURE_MS,
    basis: {
      rail: "tempo",
      paidMsats: 0,
      nativeAmount: 100_000,
      nativeAsset: "usdc",
      tempoSession: { channelId: args.channelId, cumulativeAmount: "100000" },
    },
  });
  const mpp = tempoMpp(
    args.state ?? {
      spent: 10_000n,
      settledOnChain: 0n,
      closeRequestedAt: 0n,
      // The pre-broadcast forecast refunds exactly the ledger's 100_000
      // native debit. Individual tests vary the landed close to keep the
      // post-close floor exercised as the race backstop.
      deposit: 110_000n,
      finalized: false,
    }
  );
  mpp.confirmTempoSessionClose = (_channelId, _drainId, reference) => Promise.resolve(reference);
  mpp.getTempoSessionCloseAmounts = () => Promise.resolve(args.close);
  mpp.broadcastCredential = vi.fn(() =>
    Promise.resolve({
      method: "tempo",
      status: "success",
      reference: args.channelId,
      txHash: `0x${"99".repeat(32)}`,
    } as never)
  );
  const { url } = await startServer({
    ledger,
    mpp,
    receiptKey: args.receiptKey,
    tempoSettlementReadiness: args.tempoSettlementReadiness,
  });
  return { ledger, mpp, url };
}

function creditCall(
  url: string,
  fields: Record<string, unknown>,
  privkey: Uint8Array = PRIVKEY,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${url}/v1/credit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(creditSigner.signRequest(privkey, fields)),
  });
}

describe("POST /v1/credit", () => {
  it("returns the caller's balance", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 750_000,
      expiryMs: FUTURE_MS,
    });

    const res = await creditCall(url, { op: "balance" });
    const body = (await res.json()) as {
      op: string;
      credit?: Record<string, unknown>;
      credits: Record<string, unknown>[];
      menu?: Record<string, unknown>;
    };
    expect(res.status).toBe(200);
    expect(body.op).toBe("balance");
    expect(body.credit).toMatchObject({
      credit_id: "c1",
      currency: "usd",
      balance_micro: 750_000,
      remaining_micro: 750_000,
      expired: false,
    });
    expect(body.credits).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(CALLER);

    expect(body.menu).toMatchObject({
      min_micro: 100_000,
      max_micro: 5_000_000,
      currency: "usd",
      ttl_ms: expect.any(Number) as unknown as number,
    });
  });

  it("reports a lost Tempo-backed balance as terminal and offers no drain", async () => {
    const { url, ledger } = await startServer();
    const channelId = `0x${"83".repeat(32)}`;
    await fundCredit(ledger, {
      creditId: "tempo-lost",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 97_000,
      expiryMs: FUTURE_MS,
      basis: {
        rail: "tempo",
        paidMsats: 0,
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
    });

    const balance = await creditCall(url, { op: "balance", credit_id: "tempo-lost" });
    expect(balance.status).toBe(200);
    expect(await balance.json()).toMatchObject({
      credit: {
        credit_id: "tempo-lost",
        status: "unbacked",
        balance_micro: 97_000,
        remaining_micro: 0,
        drainable: false,
      },
    });

    const drain = await creditCall(url, {
      op: "drain",
      credit_id: "tempo-lost",
      drain: { drain_id: "cannot-refund", method: "tempo" },
    });
    expect(drain.status).toBe(409);
    expect(await drain.json()).toMatchObject({ error: "credit_unbacked", retryable: false });
  });

  it("echoes the funding menu on a by-id balance read too", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 750_000,
      expiryMs: FUTURE_MS,
    });

    const res = await creditCall(url, { op: "balance", credit_id: "c1" });
    const body = (await res.json()) as {
      credits: Record<string, unknown>[];
      menu?: Record<string, unknown>;
    };
    expect(res.status).toBe(200);
    expect(body.credits).toHaveLength(1);
    expect(body.menu).toMatchObject({ min_micro: 100_000, max_micro: 5_000_000, currency: "usd" });
  });

  it("lists expired credits — expiry ends spending, not ownership", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "old",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 40_000,
      expiryMs: Date.now() - 1_000,
    });
    const res = await creditCall(url, { op: "balance" });
    const body = (await res.json()) as {
      credit?: unknown;
      credits: { credit_id: string; expired: boolean }[];
    };
    expect(body.credits).toEqual([expect.objectContaining({ credit_id: "old", expired: true })]);

    expect(body.credit).toBeUndefined();
  });

  it("scopes a by-id balance read to the caller", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "theirs",
      callerPubkey: OTHER,
      currency: "usd",
      amountMicro: 750_000,
      expiryMs: FUTURE_MS,
    });
    const res = await creditCall(url, { op: "balance", credit_id: "theirs" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe("credit_not_found");
  });

  describe("drain", () => {
    const REFUND_PUBKEY = "02" + "cd".repeat(32);
    const DRAIN = { drain_id: "d1", method: "cashu", payout: { refund_pubkey: REFUND_PUBKEY } };

    it("drains an expired credit's balance exactly once, idempotent under re-poll", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 400_000,
        expiryMs: Date.now() - 1_000,
      });

      const res = await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });
      const body = (await res.json()) as {
        op: string;
        drain: Record<string, unknown>;
        credit: Record<string, unknown>;
        display: string;
        hint: string;
      };
      expect(res.status).toBe(200);
      expect(body.op).toBe("drain");
      expect(body.drain).toMatchObject({
        drain_id: "d1",
        credit_id: "c1",
        method: "cashu",
        status: "pending",
        amount_micro: 400_000,
        currency: "usd",
      });
      expect(body.credit).toMatchObject({ balance_micro: 0, remaining_micro: 0, drainable: false });
      expect(body.display.length).toBeGreaterThan(0);

      const poll = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1" },
      });
      const pollBody = (await poll.json()) as { drain: Record<string, unknown> };
      expect(poll.status).toBe(200);
      expect(pollBody.drain).toMatchObject({ status: "pending", amount_micro: 400_000 });
      expect((await ledger.get("c1"))?.balanceMicro).toBe(0);
    });

    it("refuses a drain with nothing available", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 400_000,
        expiryMs: FUTURE_MS,
      });
      await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { ...DRAIN, drain_id: "d2" },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(409);
      expect(body.error).toBe("nothing_to_drain");
      expect(typeof body.display).toBe("string");
    });

    // Dust is a permanent refusal despite a nonzero balance; waiting cannot make it drainable.
    it("refuses a sub-satoshi reclaim as permanent, not as a wait-and-retry", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 1_000_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 1_000_000, fundingRef: "dust" },
      });
      await ledger.draw({ creditId: "c1", drawId: "j1", amountMicro: 999_500 });
      await ledger.settle({ creditId: "c1", drawId: "j1" });

      const res = await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "drain_below_dust",
        retryable: false,
        balance_micro: 500,
        remaining_micro: 500,
        owed_sats: 0,
      });
      expect(String(body.display)).toContain("smallest unit of Bitcoin");
      expect(String(body.hint)).not.toContain("Wait for running jobs");
      expect(await ledger.getDrain({ creditId: "c1", drainId: DRAIN.drain_id })).toBeUndefined();
    });

    it("drains only the available balance — pending holds keep their money", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
      });
      await ledger.draw({ creditId: "c1", drawId: "w1", amountMicro: 150_000 });

      const res = await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });
      const body = (await res.json()) as { drain: { amount_micro: number } };
      expect(body.drain.amount_micro).toBe(350_000);

      await ledger.release({ creditId: "c1", drawId: "w1" });
      const second = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { ...DRAIN, drain_id: "d2" },
      });
      const secondBody = (await second.json()) as { drain: { amount_micro: number } };
      expect(second.status).toBe(200);
      expect(secondBody.drain.amount_micro).toBe(150_000);
      expect((await ledger.get("c1"))?.balanceMicro).toBe(0);
    });

    it("validates the payout per method before any money moves", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      // x-only key (64 hex) is NOT a valid cashu refund target.
      const xonly = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1", method: "cashu", payout: { refund_pubkey: CALLER } },
      });
      expect(xonly.status).toBe(400);
      const noPayout = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1", method: "x402" },
      });
      expect(noPayout.status).toBe(400);
      expect((await ledger.get("c1"))?.balanceMicro).toBe(100_000);
    });

    it("reclaims an exact-funded x402 credit to the address the caller names", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "x402-exact",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 250_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "x402", paidMsats: 0, nativeAmount: 250_000, nativeAsset: "usdc" },
      });
      const { url } = await startServer({ ledger, receiptKey: "55".repeat(32) });
      const address = `0x${"ab".repeat(20)}`;

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "x402-exact",
        drain: { drain_id: "d1", method: "x402", payout: { address } },
      });
      const body = (await res.json()) as {
        drain: Record<string, unknown>;
        credit: Record<string, unknown>;
        display: string;
        hint: string;
      };
      expect(res.status).toBe(200);
      expect(body.drain).toMatchObject({
        drain_id: "d1",
        method: "x402",
        status: "pending",
        amount_micro: 250_000,
      });
      expect(body.credit).toMatchObject({ balance_micro: 0, remaining_micro: 0 });
      expect((body.drain.receipts as unknown[]).length).toBe(1);
      expect((await ledger.getDrain({ creditId: "x402-exact", drainId: "d1" }))?.payout).toEqual({
        address,
      });

      expect(body.display).not.toContain("payout batch");
      expect(body.display).toContain("by hand");

      const poll = await creditCall(url, {
        op: "drain",
        credit_id: "x402-exact",
        drain: { drain_id: "d1" },
      });
      expect(poll.status).toBe(200);
      expect(((await poll.json()) as { drain: Record<string, unknown> }).drain).toMatchObject({
        status: "pending",
        amount_micro: 250_000,
      });
    });

    it("names the address and the working alternatives when a stablecoin drain has no destination", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "x402-exact",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 250_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "x402", paidMsats: 0, nativeAmount: 250_000, nativeAsset: "usdc" },
      });
      const { url } = await startServer({ ledger });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "x402-exact",
        drain: { drain_id: "d1", method: "x402", payout: {} },
      });
      const body = (await res.json()) as { error: string; message: string; hint: string };
      expect(res.status).toBe(400);
      expect(body.message).toContain("payout.address");
      expect(body.hint).toContain("--address");
      expect(body.hint).toContain("--method cashu");
      expect((await ledger.get("x402-exact"))?.balanceMicro).toBe(250_000);
    });

    it("reclaims a charge-funded Tempo credit, and asks for an address when none is named", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-charge",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 120_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "tempo", paidMsats: 0, nativeAmount: 120_000, nativeAsset: "usdc" },
      });
      const { url } = await startServer({ ledger });

      const bare = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-charge",
        drain: { drain_id: "d1", method: "tempo" },
      });
      const bareBody = (await bare.json()) as { message: string; hint: string };
      expect(bare.status).toBe(400);
      expect(bareBody.message).toContain("one-off Tempo charge");
      expect(bareBody.hint).toContain("--address");
      expect((await ledger.get("tempo-charge"))?.balanceMicro).toBe(120_000);

      const address = `0x${"cd".repeat(20)}`;
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-charge",
        drain: { drain_id: "d2", method: "tempo", payout: { address } },
      });
      const body = (await res.json()) as { drain: Record<string, unknown>; display: string };
      expect(res.status).toBe(200);
      expect(body.drain).toMatchObject({
        method: "tempo",
        status: "pending",
        amount_micro: 120_000,
      });
      expect((await ledger.get("tempo-charge"))?.balanceMicro).toBe(0);
      expect(body.display).not.toContain("payout batch");
    });

    // A charge-funded credit still leaves running jobs their money: only a
    // cooperative close has to refuse while a hold exists, because only a close
    // makes the later settle uncollectable.
    it("pushes a charge-funded Tempo refund alongside a pending draw", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-charge",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 120_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "tempo", paidMsats: 0, nativeAmount: 120_000, nativeAsset: "usdc" },
      });
      await ledger.draw({ creditId: "tempo-charge", drawId: "working", amountMicro: 20_000 });
      const { url } = await startServer({ ledger });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-charge",
        drain: { drain_id: "d1", method: "tempo", payout: { address: `0x${"cd".repeat(20)}` } },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { drain: { amount_micro: number } }).drain.amount_micro).toBe(
        100_000
      );
    });

    it("refuses a stablecoin payout aimed at a rail the credit was not funded on", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "x402-exact",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 250_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "x402", paidMsats: 0, nativeAmount: 250_000, nativeAsset: "usdc" },
      });
      const { url } = await startServer({ ledger });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "x402-exact",
        drain: { drain_id: "d1", method: "tempo", payout: { address: `0x${"cd".repeat(20)}` } },
      });
      const body = (await res.json()) as { message: string; hint: string };
      expect(res.status).toBe(400);
      expect(body.message).toContain("funded over x402");
      expect(body.hint).toContain("--method x402");
      expect((await ledger.get("x402-exact"))?.balanceMicro).toBe(250_000);
    });

    // The rail check runs above the missing-address one, so a credit that was
    // never a Tempo charge is never told it is one — the caller would go
    // looking for an address that could not have helped them.
    it("blames the funding rail, not a missing address, on a cashu credit drained as mpp", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "cashu-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 90_000,
        expiryMs: FUTURE_MS,
        basis: { rail: "cashu", paidMsats: 90_000, nativeAmount: 90, nativeAsset: "sat" },
      });
      const { url } = await startServer({ ledger });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "cashu-credit",
        drain: { drain_id: "d1", method: "tempo" },
      });
      const body = (await res.json()) as { message: string; hint: string };
      expect(res.status).toBe(400);
      expect(body.message).toContain("funded over cashu");
      expect(body.message).not.toContain("Tempo charge");
      expect(body.hint).toContain("--method cashu");
      expect((await ledger.get("cashu-credit"))?.balanceMicro).toBe(90_000);
    });

    it("refuses a Tempo drain atomically while a draw is in flight", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-pending",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      await ledger.draw({ creditId: "tempo-pending", drawId: "working", amountMicro: 10_000 });
      const { url } = await startServer({
        ledger,
        mpp: tempoMpp({
          spent: 0n,
          settledOnChain: 0n,
          closeRequestedAt: 0n,
          deposit: 100_000n,
          finalized: false,
        }),
      });

      const res = await creditCall(
        url,
        { op: "drain", credit_id: "tempo-pending", drain: { drain_id: "d1", method: "tempo" } },
        PRIVKEY,
        { Authorization: "Payment unusable" }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "drain_conflict",
        drain_registered: false,
        // A running-job conflict must not claim that a refund was already registered.
        display: expect.stringContaining("A job is still running against this prepaid balance"),
        hint: expect.stringContaining("Wait for every running job on this credit to finish"),
        retryable: true,
      });
      expect(body.display).not.toContain("already exists");
      expect(await ledger.getDrain({ creditId: "tempo-pending", drainId: "d1" })).toBeUndefined();
      expect((await ledger.get("tempo-pending"))?.balanceMicro).toBe(100_000);
    });

    it("refuses a conflicting Tempo close intent before registering or debiting a drain", async () => {
      const channelId = `0x${"12".repeat(32)}`;
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-close-conflict",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 10_000n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 100_000n,
        finalized: false,
      });
      await mpp.beginTempoSessionClose?.(channelId, "d1");
      const { url } = await startServer({ ledger, mpp });

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-close-conflict",
          drain: { drain_id: "d2", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      expect(res.status).toBe(409);
      expect((await res.json()) as object).toMatchObject({
        error: "drain_conflict",
        drain_registered: false,
      });
      expect(await ledger.getDrain({ creditId: "tempo-close-conflict", drainId: "d2" })).toBe(
        undefined
      );
      expect((await ledger.get("tempo-close-conflict"))?.balanceMicro).toBe(100_000);
      expect(mpp.closeIntentDrainId()).toBe("d1");
    });

    it("refuses cross-rail payouts from a Tempo-backed credit", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-bound",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"22".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const { url } = await startServer({ ledger });
      const cashu = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-bound",
        drain: { drain_id: "cashu", method: "cashu", payout: { refund_pubkey: REFUND_PUBKEY } },
      });
      const x402 = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-bound",
        drain: {
          drain_id: "x402",
          method: "x402",
          payout: { address: `0x${"33".repeat(20)}` },
        },
      });
      expect(cashu.status).toBe(409);
      expect(x402.status).toBe(409);
      for (const response of [cashu, x402]) {
        const body = (await response.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          error: "drain_conflict",
          display: expect.stringContaining("This refund was not started"),
          hint: expect.stringContaining("--method tempo"),
          retryable: false,
          drain_registered: false,
        });
        expect(body.display).not.toContain("already exists");
      }
      expect((await ledger.get("tempo-bound"))?.balanceMicro).toBe(100_000);
      expect(await ledger.listPendingDrains()).toEqual([]);
    });

    it("refuses cross-rail payouts from an x402-channel-backed credit without registering a drain", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "x402-bound",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "x402",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          x402Channel: {
            channelId: `0x${"23".repeat(32)}`,
            maxClaimableAmount: "100000",
          },
        },
      });
      const { url } = await startServer({ ledger });

      const res = await creditCall(url, {
        op: "drain",
        credit_id: "x402-bound",
        drain: {
          drain_id: "stale-cashu",
          method: "cashu",
          payout: { refund_pubkey: REFUND_PUBKEY },
        },
      });

      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "drain_conflict",
        display: expect.stringContaining("This refund was not started"),
        hint: expect.stringContaining("--method x402"),
        retryable: false,
        drain_registered: false,
      });
      expect(body.display).not.toContain("already exists");
      expect(
        await ledger.getDrain({ creditId: "x402-bound", drainId: "stale-cashu" })
      ).toBeUndefined();
      expect((await ledger.get("x402-bound"))?.balanceMicro).toBe(100_000);
      expect(await ledger.listPendingDrains()).toEqual([]);
    });

    it("returns on-chain exit guidance for a zero-consumption Tempo drain", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-zero",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"33".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 0n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 100_000n,
        finalized: false,
      });
      const { url } = await startServer({ ledger, mpp });
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-zero",
        drain: { drain_id: "d1", method: "tempo" },
      });
      expect(res.status).toBe(409);
      expect((await res.json()) as object).toMatchObject({
        error: "tempo_channel_exit_required",
        drain_registered: false,
        hint: expect.stringContaining("tempo-exit"),
      });
      expect(mpp.issueChallenge).not.toHaveBeenCalled();
      expect(await ledger.getDrain({ creditId: "tempo-zero", drainId: "d1" })).toBeUndefined();
    });

    it("sizes a close challenge at the on-chain settlement watermark", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-settled",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"44".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 20_000n,
        settledOnChain: 30_000n,
        closeRequestedAt: 0n,
        deposit: 100_000n,
        finalized: false,
      });
      const { url } = await startServer({ ledger, mpp });
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-settled",
        drain: { drain_id: "d1", method: "tempo" },
      });
      expect(res.status).toBe(402);
      expect(mpp.issueChallenge).toHaveBeenCalledWith(
        "tempo",
        "session",
        expect.objectContaining({ amount: "0.030000", suggestedDeposit: "0.030000" })
      );
    });

    it("releases an unpaid Tempo drain once chain state proves cooperative close impossible", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-exiting",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"55".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      await ledger.requestDrain({
        creditId: "tempo-exiting",
        drainId: "d1",
        callerPubkey: CALLER,
        method: "tempo",
        payout: {},
        requireNoPending: true,
      });
      const { url } = await startServer({
        ledger,
        receiptKey: "77".repeat(32),
        mpp: tempoMpp({
          spent: 0n,
          settledOnChain: 0n,
          closeRequestedAt: 123n,
          deposit: 100_000n,
          finalized: false,
        }),
      });
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-exiting",
        drain: { drain_id: "d1", method: "tempo" },
      });
      const body = (await res.json()) as {
        drain: { status: string; receipts: DrainReceipt[] };
        credit: { balance_micro: number };
        hint: string;
      };
      expect(res.status).toBe(200);
      expect(body.drain.status).toBe("released");
      expect(body.drain.receipts.at(-1)).toMatchObject({ event: "released" });
      expect(verifyDrainReceipt(body.drain.receipts.at(-1) as DrainReceipt)).toBe(true);
      expect(body.credit.balance_micro).toBe(100_000);
      expect(body.hint).toContain("tempo-exit");
    });

    it("recovers a finalized reserved drain on an unauthenticated poll without restoring value", async () => {
      const channelId = `0x${"5a".repeat(32)}`;
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-finalized-poll",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId, cumulativeAmount: "100000" },
        },
      });
      let finalized = false;
      const mpp = tempoMpp(() =>
        Promise.resolve({
          spent: 10_000n,
          settledOnChain: finalized ? 10_000n : 0n,
          closeRequestedAt: 0n,
          deposit: finalized ? 0n : 110_000n,
          finalized,
        })
      );
      mpp.recoverTempoSessionClose = vi.fn((_channelId, drainId) =>
        Promise.resolve(
          !mpp.forecastPending() && mpp.closeIntentDrainId() === drainId
            ? `channel:${channelId}`
            : null
        )
      );
      mpp.broadcastCredential = vi.fn(() => Promise.reject(new Error("must not broadcast")));

      // Model a process dying after the atomic intent + ledger reservation but
      // before it could forecast or broadcast the credential.
      await mpp.withTempoSessionCloseIntent?.(channelId, "d1", (tx) =>
        ledger.requestDrain({
          creditId: "tempo-finalized-poll",
          drainId: "d1",
          callerPubkey: CALLER,
          method: "tempo",
          payout: {},
          requireNoPending: true,
          tx,
        })
      );
      expect(mpp.forecastPending()).toBe(true);
      expect(
        await ledger.getDrain({ creditId: "tempo-finalized-poll", drainId: "d1" })
      ).toMatchObject({ status: "pending" });
      finalized = true;
      const { url } = await startServer({ ledger, mpp });

      const poll = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-finalized-poll",
        drain: { drain_id: "d1", method: "tempo" },
      });

      expect(poll.status).toBe(200);
      expect((await poll.json()) as object).toMatchObject({
        drain: { drain_id: "d1", status: "sent" },
        credit: { balance_micro: 0 },
      });
      expect(
        await ledger.getDrain({ creditId: "tempo-finalized-poll", drainId: "d1" })
      ).toMatchObject({
        status: "sent",
        sentRef: { tx_hash: `channel:${channelId}`, channel_id: channelId },
      });
      expect(await ledger.get("tempo-finalized-poll")).toMatchObject({
        balanceMicro: 0,
        availableMicro: 0,
        nativeAvailable: 0,
      });
      expect(mpp.forecastPending()).toBe(false);
      expect(mpp.recoverTempoSessionClose).toHaveBeenCalledWith(channelId, "d1");
      expect(mpp.issueChallenge).not.toHaveBeenCalled();
      expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    });

    it("releases a reverted close intent so a fresh drain can close cooperatively", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-reverted-close",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"66".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 10_000n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 110_000n,
        finalized: false,
      });
      mpp.confirmTempoSessionClose = (_channelId, _drainId, reference) =>
        Promise.resolve(reference);
      mpp.broadcastCredential = vi
        .fn()
        .mockRejectedValueOnce(new Error("close transaction reverted"))
        .mockResolvedValueOnce({
          method: "tempo",
          status: "success",
          reference: `0x${"88".repeat(32)}`,
        });
      const { url } = await startServer({ ledger, mpp });

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-reverted-close",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(`0x${"66".repeat(32)}`) }
      );
      const body = (await res.json()) as {
        drain: { status: string };
        credit: { balance_micro: number };
      };
      expect(res.status).toBe(200);
      expect(body.drain.status).toBe("released");
      expect(body.credit.balance_micro).toBe(100_000);
      expect(mpp.closeIntentDrainId()).toBeNull();

      const retry = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-reverted-close",
          drain: { drain_id: "d2", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(`0x${"66".repeat(32)}`) }
      );
      expect(retry.status).toBe(200);
      expect((await retry.json()) as object).toMatchObject({
        drain: { drain_id: "d2", status: "sent" },
        credit: { balance_micro: 0 },
      });
      expect(mpp.closeIntentDrainId()).toBe("d2");
      expect(mpp.broadcastCredential).toHaveBeenCalledTimes(2);
    });

    it("refuses a forecast shortfall before broadcast and restores the balance plus rail basis", async () => {
      const channelId = `0x${"68".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-forecast-short",
        channelId,
        state: {
          spent: 10_000n,
          settledOnChain: 20_000n,
          closeRequestedAt: 0n,
          deposit: 110_000n,
          finalized: false,
        },
        close: { settledToPayee: 10_000n, refundedToPayer: 90_000n },
      });
      const before = await ledger.get("tempo-forecast-short");

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-forecast-short",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(409);
      expect(body).toMatchObject({
        error: "drain_conflict",
        forecast_refund_native: "90000",
        drained_native: 100_000,
        balance_intact: true,
      });
      expect(body.display).toContain("balance is intact");
      expect(body.message).toContain(
        "Tempo close would refund 90000 for a drain requiring at least 100000"
      );

      const after = await ledger.get("tempo-forecast-short");
      expect(after).toMatchObject({
        balanceMicro: before?.balanceMicro,
        availableMicro: before?.availableMicro,
        nativeAvailable: before?.nativeAvailable,
      });
      expect(
        await ledger.getDrain({ creditId: "tempo-forecast-short", drainId: "d1" })
      ).toMatchObject({ status: "released", drainedNative: 100_000, sentRef: null });
      expect(mpp.closeIntentDrainId()).toBeNull();
      expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    });

    it("recovers a channel finalized after challenge without restoring its landed refund", async () => {
      const channelId = `0x${"6d".repeat(32)}`;
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-finalized-after-challenge",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId, cumulativeAmount: "100000" },
        },
      });
      let finalized = false;
      const mpp = tempoMpp(() =>
        Promise.resolve(
          finalized
            ? {
                spent: 10_000n,
                settledOnChain: 10_000n,
                closeRequestedAt: 0n,
                deposit: 0n,
                finalized: true,
              }
            : {
                spent: 10_000n,
                settledOnChain: 0n,
                closeRequestedAt: 0n,
                deposit: 110_000n,
                finalized: false,
              }
        )
      );
      mpp.recoverTempoSessionClose = vi.fn((_channelId, drainId) =>
        Promise.resolve(mpp.closeIntentDrainId() === drainId ? `channel:${channelId}` : null)
      );
      mpp.broadcastCredential = vi.fn(() => Promise.reject(new Error("must not broadcast")));
      const { url } = await startServer({ ledger, mpp });

      const challenge = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-finalized-after-challenge",
        drain: { drain_id: "d1", method: "tempo" },
      });
      expect(challenge.status).toBe(402);
      expect(
        await ledger.getDrain({
          creditId: "tempo-finalized-after-challenge",
          drainId: "d1",
        })
      ).toBeUndefined();

      // The caller signs the challenge, but the channel finalizes and pays its
      // external refund before that credential reaches this service.
      finalized = true;
      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-finalized-after-challenge",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );

      expect(res.status).toBe(200);
      expect((await res.json()) as object).toMatchObject({
        drain: { drain_id: "d1", status: "sent" },
        credit: { balance_micro: 0 },
      });
      expect(
        await ledger.getDrain({
          creditId: "tempo-finalized-after-challenge",
          drainId: "d1",
        })
      ).toMatchObject({
        status: "sent",
        sentRef: { tx_hash: `channel:${channelId}`, channel_id: channelId },
      });
      expect(await ledger.get("tempo-finalized-after-challenge")).toMatchObject({
        balanceMicro: 0,
        availableMicro: 0,
        nativeAvailable: 0,
      });
      expect(mpp.recoverTempoSessionClose).toHaveBeenCalledWith(channelId, "d1");
      expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    });

    it("does not release when a concurrent same-drain retry opens the broadcast gate", async () => {
      const channelId = `0x${"6c".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-forecast-race",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
      });
      let firstReadStarted!: () => void;
      const firstRead = new Promise<void>((resolve) => {
        firstReadStarted = resolve;
      });
      let releaseFirstRead!: () => void;
      const firstState = new Promise<void>((resolve) => {
        releaseFirstRead = resolve;
      });
      let reads = 0;
      mpp.getTempoSessionDrainState = async () => {
        reads += 1;
        if (reads === 1) {
          firstReadStarted();
          await firstState;
          return {
            spent: 10_000n,
            settledOnChain: 20_000n,
            closeRequestedAt: 0n,
            deposit: 110_000n,
            finalized: false,
          };
        }
        return {
          spent: 10_000n,
          settledOnChain: 0n,
          closeRequestedAt: 0n,
          deposit: 110_000n,
          finalized: false,
        };
      };
      const call = () =>
        creditCall(
          url,
          {
            op: "drain",
            credit_id: "tempo-forecast-race",
            drain: { drain_id: "d1", method: "tempo" },
          },
          PRIVKEY,
          { Authorization: tempoCloseCredential(channelId) }
        );

      const forecasting = call();
      await firstRead;
      const completing = await call();
      expect(completing.status).toBe(200);
      expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
      releaseFirstRead();
      const raced = await forecasting;
      expect(raced.status).toBe(200);

      expect(
        await ledger.getDrain({ creditId: "tempo-forecast-race", drainId: "d1" })
      ).toMatchObject({ status: "sent", sentRef: expect.any(Object) as object });
      expect(await ledger.get("tempo-forecast-race")).toMatchObject({
        balanceMicro: 0,
        availableMicro: 0,
        nativeAvailable: 0,
      });
      expect(mpp.closeIntentDrainId()).toBe("d1");
    });

    it("proceeds unchanged when the Tempo rail cannot provide a forecast", async () => {
      const channelId = `0x${"6a".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-no-forecast",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
      });
      mpp.getTempoSessionDrainState = undefined;

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-no-forecast",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      expect(res.status).toBe(200);
      expect(await ledger.getDrain({ creditId: "tempo-no-forecast", drainId: "d1" })).toMatchObject(
        { status: "sent" }
      );
      expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
    });

    it("fails open when the Tempo forecast RPC flaps", async () => {
      const channelId = `0x${"6b".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-forecast-rpc-down",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
      });
      mpp.getTempoSessionDrainState = vi.fn(() =>
        Promise.reject(new Error("tempo rpc unavailable"))
      );

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-forecast-rpc-down",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      expect(res.status).toBe(200);
      expect(
        await ledger.getDrain({ creditId: "tempo-forecast-rpc-down", drainId: "d1" })
      ).toMatchObject({ status: "sent" });
      expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
    });

    it("refuses to book a Tempo close that refunded less than the ledger debited", async () => {
      const channelId = `0x${"69".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-short-refund",
        channelId,
        // The sweep/close race: a settlement landed above terminal consumption
        // while this close was in flight, so the escrow refunded 90_000 of the
        // 100_000 the ledger is extinguishing.
        close: { settledToPayee: 10_000n, refundedToPayer: 90_000n },
      });

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-short-refund",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      const body = (await res.json()) as { error: string; message: string; hint: string };
      expect(res.status).toBe(409);
      expect(body.error).toBe("drain_conflict");
      expect(body.message).toContain(
        "Tempo close refunded 90000 for a drain requiring at least 100000"
      );
      expect(body.hint).toContain("drain_id");

      expect(
        await ledger.getDrain({ creditId: "tempo-short-refund", drainId: "d1" })
      ).toMatchObject({ status: "pending", sentRef: null });
      // The clean forecast covered the debit; the landed close raced below it,
      // so the unchanged post-close floor remains the final backstop.
      expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
    });

    it("marks a covering Tempo close sent and records the payer's channel surplus", async () => {
      const channelId = `0x${"70".repeat(32)}`;
      const { ledger, url } = await tempoClosingCredit({
        creditId: "tempo-surplus-refund",
        channelId,

        close: { settledToPayee: 10_000n, refundedToPayer: 120_000n },
        receiptKey: "77".repeat(32),
      });

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-surplus-refund",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { drain: { receipts: DrainReceipt[] } };
      expect(body).toMatchObject({
        drain: { drain_id: "d1", status: "sent" },
        credit: { balance_micro: 0 },
      });
      expect(body.drain.receipts.map((receipt) => receipt.event)).toEqual(["requested", "sent"]);
      expect(body.drain.receipts.every((receipt) => verifyDrainReceipt(receipt))).toBe(true);
      expect(
        await ledger.getDrain({ creditId: "tempo-surplus-refund", drainId: "d1" })
      ).toMatchObject({
        status: "sent",
        sentRef: {
          channel_id: channelId,
          settled_amount: "120000",
          surplus_native: "20000",
        },
      });

      const replay = await creditCall(url, {
        op: "drain",
        credit_id: "tempo-surplus-refund",
        drain: { drain_id: "d1", method: "tempo" },
      });
      const replayBody = (await replay.json()) as { drain: { receipts: DrainReceipt[] } };
      expect(replay.status).toBe(200);
      expect(replayBody.drain.receipts.map((receipt) => receipt.event)).toEqual([
        "requested",
        "sent",
      ]);
    });

    it("refuses a close credential signed for a channel other than the credit's own, terminally", async () => {
      // Re-signing a close for the same wrong channel cannot repair the binding mismatch.
      const channelId = `0x${"72".repeat(32)}`;
      const otherChannelId = `0x${"73".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-wrong-channel",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
      });
      const beginClose = vi.fn(mpp.beginTempoSessionClose);
      mpp.beginTempoSessionClose = beginClose;

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-wrong-channel",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(otherChannelId) }
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "drain_conflict",

        retryable: false,
        drain_registered: true,
        credit_channel_id: channelId,
        presented_channel_id: otherChannelId,
      });
      expect(body.message).toContain(otherChannelId);
      expect(body.display).toContain("different payment channel");
      expect(body.hint).toContain("The same drain_id still works.");

      expect(mpp.broadcastCredential).not.toHaveBeenCalled();
      expect(beginClose).not.toHaveBeenCalled();

      expect(mpp.closeIntentDrainId()).toBe("d1");
      expect(
        await ledger.getDrain({ creditId: "tempo-wrong-channel", drainId: "d1" })
      ).toMatchObject({ status: "pending", sentRef: null });

      const retry = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-wrong-channel",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );
      expect(retry.status).toBe(200);
      expect((await retry.json()) as object).toMatchObject({
        drain: { drain_id: "d1", status: "sent" },
        credit: { balance_micro: 0 },
      });
      expect(beginClose).toHaveBeenCalledOnce();
    });

    it("keeps the close transaction readable when the floor's chain read fails, so the next poll still applies it", async () => {
      const channelId = `0x${"71".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-read-retry",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 90_000n },
      });
      // After broadcast empties the channel, only a confirmed transaction hash permits receipt-based floor checking.
      const txHash = `0x${"99".repeat(32)}`;
      let confirmed: string | null = null;
      let emptied = false;
      const broadcast = mpp.broadcastCredential.bind(mpp);
      mpp.broadcastCredential = (...broadcastArgs) => {
        emptied = true;
        return broadcast(...broadcastArgs);
      };
      mpp.confirmTempoSessionClose = (_channelId, _drainId, reference) => {
        confirmed = reference;
        return Promise.resolve(reference);
      };
      mpp.recoverTempoSessionClose = (_channelId, drainId) => {
        if (mpp.closeIntentDrainId() !== drainId) return Promise.resolve(null);
        if (confirmed) return Promise.resolve(confirmed);
        return Promise.resolve(emptied ? `channel:${channelId}` : null);
      };
      const reads: string[] = [];
      let rpcDown = true;
      mpp.getTempoSessionCloseAmounts = ({ txHash }) => {
        reads.push(txHash);
        if (rpcDown) {
          rpcDown = false;
          return Promise.reject(new Error("tempo rpc unavailable"));
        }
        return Promise.resolve({ settledToPayee: 10_000n, refundedToPayer: 90_000n });
      };

      const call = () =>
        creditCall(
          url,
          {
            op: "drain",
            credit_id: "tempo-read-retry",
            drain: { drain_id: "d1", method: "tempo" },
          },
          PRIVKEY,
          { Authorization: tempoCloseCredential(channelId) }
        );

      const first = await call();
      expect(first.status).toBe(402);
      expect(await ledger.getDrain({ creditId: "tempo-read-retry", drainId: "d1" })).toMatchObject({
        status: "pending",
        sentRef: null,
      });

      // That poll recovers the real transaction hash, not the synthetic
      // `channel:<id>` reference, so the floor still sees the short refund.
      const second = await call();
      expect(second.status).toBe(409);
      expect(((await second.json()) as { message: string }).message).toContain(
        "Tempo close refunded 90000 for a drain requiring at least 100000"
      );
      expect(reads).toEqual([txHash, txHash]);
      expect(await ledger.getDrain({ creditId: "tempo-read-retry", drainId: "d1" })).toMatchObject({
        status: "pending",
        sentRef: null,
      });
    });

    it("keeps an ambiguous submitted close pending until chain reconciliation proves its outcome", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-close-timeout",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 0,
          nativeAmount: 100_000,
          nativeAsset: "usdc",
          tempoSession: { channelId: `0x${"67".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 10_000n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 110_000n,
        finalized: false,
      });
      mpp.beginTempoSessionClose = () => Promise.resolve();
      mpp.confirmTempoSessionClose = () => Promise.resolve("unreachable");
      mpp.broadcastCredential = vi.fn(() =>
        Promise.reject(new Error("Timed out waiting for transaction receipt"))
      );
      const { url } = await startServer({ ledger, mpp });

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-close-timeout",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(`0x${"67".repeat(32)}`) }
      );
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        error: "payment_invalid",
        drain_registered: true,
        drain_id: "d1",
        hint: expect.stringContaining("Retry this same drain d1"),
      });
      expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
      expect(
        await ledger.getDrain({ creditId: "tempo-close-timeout", drainId: "d1" })
      ).toMatchObject({ status: "pending" });
      expect((await ledger.get("tempo-close-timeout"))?.balanceMicro).toBe(0);
    });

    it("reissues a close challenge when a saved Tempo credential is no longer valid", async () => {
      const channelId = `0x${"66".repeat(32)}`;
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-stale-close-credential",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
      });
      mpp.broadcastCredential = vi.fn(() =>
        Promise.reject(
          new MppxErrors.InvalidChallengeError({
            id: "close-challenge",
            reason: "challenge was not issued by this server",
          })
        )
      );

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-stale-close-credential",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );

      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({
        error: "payment_invalid",
        retryable: true,
        credential_refresh_required: true,
        drain_registered: true,
        drain_id: "d1",
      });
      expect(res.headers.get("WWW-Authenticate")).toContain("tempo");
      expect(mpp.issueChallenge).toHaveBeenCalledOnce();
      expect(
        await ledger.getDrain({ creditId: "tempo-stale-close-credential", drainId: "d1" })
      ).toMatchObject({ status: "pending", sentRef: null });
      expect(await ledger.get("tempo-stale-close-credential")).toMatchObject({
        balanceMicro: 0,
        availableMicro: 0,
      });
    });

    it("restores the credit when the Tempo operator cannot fund the close transaction", async () => {
      const channelId = `0x${"68".repeat(32)}`;
      const readiness = new TempoSettlementReadiness({
        address: "0x1111111111111111111111111111111111111111",
        network: "eip155:4217",
        token: "0x2222222222222222222222222222222222222222",
        readBalance: () => Promise.resolve(100_000n),
      });
      const onFailure = vi.fn().mockResolvedValue(undefined);
      readiness.subscribe({ onFailure });
      const { ledger, mpp, url } = await tempoClosingCredit({
        creditId: "tempo-close-no-fees",
        channelId,
        close: { settledToPayee: 10_000n, refundedToPayer: 100_000n },
        tempoSettlementReadiness: readiness,
      });
      mpp.broadcastCredential = vi.fn(() =>
        Promise.reject(
          new BaseError("Tempo close submission failed", {
            cause: new InsufficientFundsError(),
          })
        )
      );

      const res = await creditCall(
        url,
        {
          op: "drain",
          credit_id: "tempo-close-no-fees",
          drain: { drain_id: "d1", method: "tempo" },
        },
        PRIVKEY,
        { Authorization: tempoCloseCredential(channelId) }
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        drain: { drain_id: "d1", status: "released" },
        credit: { balance_micro: 100_000 },
      });
      expect(
        await ledger.getDrain({ creditId: "tempo-close-no-fees", drainId: "d1" })
      ).toMatchObject({ status: "released" });
      expect((await ledger.get("tempo-close-no-fees"))?.balanceMicro).toBe(100_000);
      expect(mpp.closeIntentDrainId()).toBeNull();
      expect(onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "close",
          channelId,
          creditId: "tempo-close-no-fees",
          drainId: "d1",
          errorClass: "InsufficientFundsError",
        })
      );
      expect(readiness.available()).toBe(false);
      readiness.stop();
    });

    it("refuses to rewrite a recorded payout — drain_conflict", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { ...DRAIN, payout: { refund_pubkey: "03" + "ee".repeat(32) } },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(409);
      expect(body.error).toBe("drain_conflict");

      expect(body.display).toContain("already exists with a different destination");
      expect(body.hint).toContain("Poll with the original method and payout");
      expect(body.retryable).toBe(false);

      // A destination under a DIFFERENT field name is just as much a rewrite
      // disjoint key sets must not slip past the value comparison.
      const renamed = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { ...DRAIN, payout: { address: "0x" + "ab".repeat(20) } },
      });
      expect(renamed.status).toBe(409);
      expect(((await renamed.json()) as { error: string }).error).toBe("drain_conflict");

      const poll = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1", payout: {} },
      });
      expect(poll.status).toBe(200);
    });

    it("answers identically for absent and foreign credits", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "theirs",
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      const foreign = await creditCall(url, { op: "drain", credit_id: "theirs", drain: DRAIN });
      const absent = await creditCall(url, { op: "drain", credit_id: "ghost", drain: DRAIN });
      expect(foreign.status).toBe(404);
      expect(absent.status).toBe(404);
      expect(((await foreign.json()) as { error: string }).error).toBe("credit_not_found");
      expect(((await absent.json()) as { error: string }).error).toBe("credit_not_found");
    });

    it("countersigns every reclaim event into verifiable drain receipts", async () => {
      const { url, ledger } = await startServer({ receiptKey: "77".repeat(32) });
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
      });

      await ledger.draw({ creditId: "c1", drawId: "w1", amountMicro: 150_000 });
      const res = await creditCall(url, { op: "drain", credit_id: "c1", drain: DRAIN });
      const body = (await res.json()) as { drain: { receipts: DrainReceipt[] } };
      expect(body.drain.receipts).toHaveLength(1);
      const requested = body.drain.receipts[0];
      expect(requested).toMatchObject({
        kind: "credit_drain",
        event: "requested",
        credit_id: "c1",
        drain_id: "d1",
        amount_micro: 350_000,
        balance_after_micro: 150_000,
        caller_pubkey: CALLER,
      });
      expect(verifyDrainReceipt(requested)).toBe(true);

      await ledger.parkDrain({ creditId: "c1", drainId: "d1", token: "cashuBparked" });
      // Release the hold before the pickup poll: the picked_up receipt still
      // attests the figure recorded at request time, not the live balance.
      await ledger.release({ creditId: "c1", drawId: "w1" });
      const poll = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1" },
      });
      const pollBody = (await poll.json()) as {
        drain: { receipts: DrainReceipt[]; status: string; token: string };
      };
      expect(pollBody.drain).toMatchObject({ status: "picked_up", token: "cashuBparked" });
      const events = pollBody.drain.receipts.map((r) => r.event);
      expect(events).toEqual(["requested", "picked_up"]);
      expect(pollBody.drain.receipts.map((r) => r.balance_after_micro)).toEqual([150_000, 150_000]);
      expect(pollBody.drain.receipts.every((r) => verifyDrainReceipt(r))).toBe(true);
      const again = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1" },
      });
      const againBody = (await again.json()) as { drain: { receipts: DrainReceipt[] } };
      expect(againBody.drain).toMatchObject({ status: "picked_up", token: "cashuBparked" });
      expect(againBody.drain.receipts).toEqual(pollBody.drain.receipts);
    });

    // Unsupported methods must be refused before the payout-presence check.
    it.each([
      { label: "lightning", method: "lightning", payout: { ln_address: "me@example.com" } },
      { label: "payout-less lightning", method: "lightning", payout: undefined },
      { label: "banana", method: "banana", payout: { refund_pubkey: "nope" } },
    ])("refuses a $label drain before anything is reserved", async ({ method, payout }) => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      const res = await creditCall(url, {
        op: "drain",
        credit_id: "c1",
        drain: { drain_id: "d1", method, ...(payout ? { payout } : {}) },
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        error: "drain_method_unsupported",
        retryable: false,
        drain_registered: false,
        supported_methods: ["cashu", "x402", "tempo"],
      });

      expect(String(body.hint)).toContain("--method cashu");

      expect(await ledger.getDrain({ creditId: "c1", drainId: "d1" })).toBeFalsy();
      const credit = await ledger.get("c1");
      expect(credit?.availableMicro).toBe(100_000);
    });
  });

  describe("auth", () => {
    it("rejects a tampered signature", async () => {
      const { url } = await startServer();
      const signed = creditSigner.signRequest(PRIVKEY, { op: "balance" }) as unknown as Record<
        string,
        unknown
      >;
      const res = await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...signed, op: "drain" }),
      });
      const body = (await res.json()) as { error: string; sub_reason: string };
      expect(res.status).toBe(401);
      expect(body.error).toBe("auth_error");
      expect(body.sub_reason).toBe("signature_invalid");
    });

    it("rejects a stale timestamp", async () => {
      const { url } = await startServer();
      const stale = creditSigner.signRequest(
        PRIVKEY,
        { op: "balance" },
        { timestamp: Math.floor(Date.now() / 1000) - 3600 }
      );
      const res = await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stale),
      });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { sub_reason: string }).sub_reason).toBe("timestamp_drift");
    });

    it("names a schema-violating field rather than blaming the signature", async () => {
      const { url } = await startServer();

      const signed = creditSigner.signRequest(PRIVKEY, { op: "withdraw" }) as unknown as Record<
        string,
        unknown
      >;
      const res = await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(signed),
      });
      const body = (await res.json()) as {
        error: string;
        sub_reason: string;
        display: string;
        hint: string;
      };
      expect(res.status).toBe(401);
      expect(body.error).toBe("auth_error");
      expect(body.sub_reason).toBe("schema_invalid");
      expect(body.display).toContain("op");
      // `/v1/info` publishes capability input schemas, not this route's body —
      // the hint has to point somewhere that can actually answer.
      expect(body.hint).toContain("/docs/protocol");
      expect(body.hint).not.toContain("/v1/info");
    });

    it("rejects a malformed body before anything else", async () => {
      const { url } = await startServer();
      const res = await fetch(`${url}/v1/credit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    });
  });

  describe("credit_not_supported", () => {
    it("answers a DVM that did not opt in", async () => {
      const { url } = await startServer({ credit: false });
      const res = await creditCall(url, { op: "balance" });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(501);
      expect(body.error).toBe("credit_not_supported");

      expect(body.hint).toContain("Pay per call");
      expect(body.retryable).toBe(false);
    });

    it("answers a DVM with no descriptor auth", async () => {
      const { url } = await startServer({ auth: false });
      const res = await creditCall(url, { op: "balance" });
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toBe("credit_not_supported");
    });
  });

  describe("sizing gates", () => {
    it("refuses a top-up below min_micro before touching a rail", async () => {
      const { url } = await startServer();
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 1_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.error).toBe("credit_below_min");
      expect(body.min_micro).toBe(100_000);
    });

    it("refuses a top-up that would push the residual over max_micro", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 4_500_000,
        expiryMs: FUTURE_MS,
      });
      const res = await creditCall(url, {
        op: "fund",
        credit_id: "c1",
        fund: { amount_micro: 1_000_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.error).toBe("credit_over_max");

      expect(body.fundable_micro).toBe(500_000);
      expect(body.remaining_micro).toBe(4_500_000);
    });

    it("refuses a Tempo charge against a session credit on the unpaid discovery request", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-session-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 100_000,
          nativeAmount: 100_000,
          nativeAsset: "pathUSD",
          tempoSession: { channelId: `0x${"77".repeat(32)}`, cumulativeAmount: "100000" },
        },
      });
      const mpp = tempoMpp({
        spent: 0n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 100_000n,
        finalized: false,
      });
      const { url } = await startServer({ ledger, mpp });

      const res = await creditCall(url, {
        op: "fund",
        credit_id: "tempo-session-credit",
        fund: {
          amount_micro: 100_000,
          fund_id: "f-charge",
          commitment: COMMITMENT,
          method: "tempo",
          intent: "charge",
        },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_session",
        credit_channel_id: `0x${"77".repeat(32)}`,
        retryable: false,
      });
      expect(mpp.issueChallenge).not.toHaveBeenCalled();
    });

    it("refuses a Tempo session against a charge credit on the unpaid discovery request", async () => {
      const ledger = durableLedger();
      await fundCredit(ledger, {
        creditId: "tempo-charge-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
        basis: {
          rail: "tempo",
          paidMsats: 100_000,
          nativeAmount: 100_000,
          nativeAsset: "pathUSD",
        },
      });
      const mpp = tempoMpp({
        spent: 0n,
        settledOnChain: 0n,
        closeRequestedAt: 0n,
        deposit: 100_000n,
        finalized: false,
      });
      const { url } = await startServer({ ledger, mpp });

      const res = await creditCall(url, {
        op: "fund",
        credit_id: "tempo-charge-credit",
        fund: {
          amount_micro: 100_000,
          fund_id: "f-session",
          commitment: COMMITMENT,
          method: "tempo",
          intent: "session",
        },
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_charge",
        retryable: false,
      });
      expect(mpp.issueChallenge).not.toHaveBeenCalled();
    });

    it("sums max_micro across the caller's credits, so extra credits don't raise the ceiling", async () => {
      const { url, ledger } = await startServer();
      for (const [creditId, amountMicro] of [
        ["c1", 3_000_000],
        ["c2", 1_500_000],
      ] as const) {
        await fundCredit(ledger, {
          creditId,
          callerPubkey: CALLER,
          currency: "usd",
          amountMicro,
          expiryMs: FUTURE_MS,
        });
      }
      // No `credit_id`: a per-credit ceiling would see a fresh zero-balance
      // credit and wave this through, which is how the bound gets escaped.
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 1_000_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.error).toBe("credit_over_max");
      expect(body.remaining_micro).toBe(4_500_000);
      expect(body.fundable_micro).toBe(500_000);
    });

    it("excludes another caller's balance from the ceiling", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "theirs",
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 5_000_000,
        expiryMs: FUTURE_MS,
      });
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 1_000_000, fund_id: "f1", commitment: COMMITMENT },
      });

      expect(res.status).toBe(402);
    });

    it("excludes expired credits from the ceiling — unspendable value must not lock funding out", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "stale",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 4_500_000,
        expiryMs: Date.now() - 1_000,
      });
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 1_000_000, fund_id: "f1", commitment: COMMITMENT },
      });

      expect(res.status).toBe(402);
    });

    it("requires a fund block on op fund", async () => {
      const { url } = await startServer();
      const res = await creditCall(url, { op: "fund" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    });
  });

  describe("exactly-once top-ups", () => {
    it("returns the original outcome for a replayed fund_id, without a second credit", async () => {
      const { url, ledger } = await startServer({ receiptKey: "55".repeat(32) });
      await fundCredit(ledger, {
        creditId: "c1",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
      });
      // Stand in for a first top-up that already committed: the funding row
      // is what a retry short-circuits on, before any rail is presented.
      await ledger.recordFunding({ creditId: "c1", fundId: "f1", amountMicro: 300_000 });
      const funded = await ledger.get("c1");
      if (!funded) throw new Error("test credit missing");
      await ledger.completeFunding({
        creditId: "c1",
        fundId: "f1",
        callerPubkey: CALLER,
        balanceAfterMicro: funded.availableMicro,
        ledgerSeq: funded.lastLedgerSeq,
      });
      await ledger.draw({ creditId: "c1", drawId: "later-draw", amountMicro: 100_000 });

      const res = await creditCall(url, {
        op: "fund",
        credit_id: "c1",
        fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as {
        replayed: boolean;
        funded_micro: number;
        credit: { balance_micro: number; remaining_micro: number };
        funding_receipt: FundingReceipt;
      };
      expect(res.status).toBe(200);
      expect(body.replayed).toBe(true);
      expect(body.funded_micro).toBe(300_000);
      expect(body.credit.balance_micro).toBe(500_000);
      expect(body.credit.remaining_micro).toBe(400_000);
      expect(body.funding_receipt).toMatchObject({
        credit_id: "c1",
        fund_id: "f1",
        funded_micro: 300_000,
        balance_after_micro: 500_000,
        caller_pubkey: CALLER,
      });
      expect(verifyFundingReceipt(body.funding_receipt)).toBe(true);

      const retry = (await (
        await creditCall(url, {
          op: "fund",
          credit_id: "c1",
          fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
        })
      ).json()) as { funding_receipt: FundingReceipt };
      expect(JSON.stringify(retry.funding_receipt)).toBe(JSON.stringify(body.funding_receipt));
    });

    it("makes a FIRST top-up retry-safe — no credit_id still resolves to one credit", async () => {
      const { url, ledger } = await startServer();
      // What a first top-up leaves behind: the credit id was derived from
      // (pubkey, fund_id), not minted at random, so the retry below can find it.
      const derived = derivedFundCreditId(CALLER, "f1");
      await fundCredit(ledger, {
        creditId: derived,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 300_000,
        expiryMs: FUTURE_MS,
      });
      await ledger.recordFunding({ creditId: derived, fundId: "f1", amountMicro: 300_000 });

      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as {
        replayed: boolean;
        funded_micro: number;
        credit: { credit_id: string; balance_micro: number };
      };
      expect(res.status).toBe(200);
      expect(body.replayed).toBe(true);
      expect(body.funded_micro).toBe(300_000);
      expect(body.credit.credit_id).toBe(derived);

      expect((await ledger.getForCaller(CALLER)).length).toBe(1);
      expect(body.credit.balance_micro).toBe(300_000);
    });

    it("derives the same credit id for the same caller and fund_id, and a different one otherwise", () => {
      expect(derivedFundCreditId(CALLER, "f1")).not.toBe(derivedFundCreditId(CALLER, "f2"));
      expect(derivedFundCreditId(CALLER, "f1")).not.toBe(derivedFundCreditId(OTHER, "f1"));

      expect(derivedFundCreditId(CALLER, "f1").startsWith("fnd:")).toBe(true);
      expect(derivedFundCreditId(CALLER, "f1")).not.toContain(CALLER);
    });

    it("does not honour another caller's fund_id", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: "theirs",
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 200_000,
        expiryMs: FUTURE_MS,
      });
      await ledger.recordFunding({ creditId: "theirs", fundId: "f1", amountMicro: 300_000 });

      const res = await creditCall(url, {
        op: "fund",
        credit_id: "theirs",
        fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
      });

      expect(res.status).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("credit_not_found");
    });
  });

  describe("derived credit ids are server-created", () => {
    it("refuses to open a credit at a caller-named id in a derived namespace", async () => {
      const { url } = await startServer();
      // The squat: pre-open the id the victim's next `fund_id` will derive to,
      // so their top-up settles on the rail and then fails `caller_mismatch`.
      const res = await creditCall(url, {
        op: "fund",
        credit_id: derivedFundCreditId(OTHER, "f1"),
        fund: { amount_micro: 300_000, fund_id: "squat", commitment: COMMITMENT },
      });
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(400);
      expect(body.error).toBe("credit_id_unavailable");

      expect(body.hint).toContain("Omit credit_id");
    });

    it("refuses the implicit-funding namespace too", async () => {
      const { url } = await startServer();
      const res = await creditCall(url, {
        op: "fund",
        credit_id: "imp:cashu:11111111-1111-1111-1111-111111111111",
        fund: { amount_micro: 300_000, fund_id: "squat", commitment: COMMITMENT },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("credit_id_unavailable");
    });

    it("still lets the OWNER name a derived id — that's how top-ups stack", async () => {
      const { url, ledger } = await startServer();
      const derived = derivedFundCreditId(CALLER, "f1");
      await fundCredit(ledger, {
        creditId: derived,
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 300_000,
        expiryMs: FUTURE_MS,
      });
      const res = await creditCall(url, {
        op: "fund",
        credit_id: derived,
        fund: { amount_micro: 300_000, fund_id: "f2", commitment: COMMITMENT },
      });

      expect(res.status).toBe(402);
    });

    it("answers the same for a named derived id that exists and one that doesn't", async () => {
      const { url, ledger } = await startServer();
      const theirs = derivedFundCreditId(OTHER, "f1");
      const probe = async (): Promise<Record<string, unknown>> => {
        const res = await creditCall(url, {
          op: "fund",
          credit_id: theirs,
          fund: { amount_micro: 300_000, fund_id: "probe", commitment: COMMITMENT },
        });
        const body = (await res.json()) as Record<string, unknown>;
        return { status: res.status, error: body.error, message: body.message, hint: body.hint };
      };

      const absent = await probe();
      await fundCredit(ledger, {
        creditId: theirs,
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      // The reservation answers above the existence check, so a probe can't
      // walk an enumerable namespace (`imp:x402:<txHash>` off public chain
      // data, `fnd:` off a pubkey) for which credit ids are real — free, and
      // before the rail or the nonce.
      expect(await probe()).toEqual(absent);
      expect(absent.status).toBe(400);
      expect(absent.error).toBe("credit_id_unavailable");
    });

    it("refuses a derived id squatted by another caller, before any rail", async () => {
      const { url, ledger } = await startServer();
      await fundCredit(ledger, {
        creditId: derivedFundCreditId(CALLER, "f1"),
        callerPubkey: OTHER,
        currency: "usd",
        amountMicro: 100_000,
        expiryMs: FUTURE_MS,
      });
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(409);
      expect(body.error).toBe("credit_id_unavailable");
      expect(body.fund_id).toBe("f1");
    });
  });

  it("returns a 402 with the standard payment envelope when no artifact is attached", async () => {
    const { url } = await startServer();
    const res = await creditCall(url, {
      op: "fund",
      fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
    });
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(402);
    expect(body.error).toBe("payment_required");
    expect(body.required_msats).toBe(300_000);
  });

  describe("fund.commitment", () => {
    const ARTIFACT = "cashuBo2FteUFBQQ";

    it("refuses an artifact that doesn't hash to the signed commitment", async () => {
      const { url } = await startServer();
      const res = await creditCall(
        url,
        { op: "fund", fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT } },
        PRIVKEY,
        { "X-Cashu": ARTIFACT }
      );
      const body = (await res.json()) as Record<string, unknown>;
      // Rejected in the preflight, before any rail: the DVM has no mints
      // wired, so reaching the Cashu branch would surface `cashu_unavailable`.
      expect(res.status).toBe(402);
      expect(body.error).toBe("funding_commitment_mismatch");
    });

    it("lets a matching commitment through to the rail", async () => {
      const { url } = await startServer();
      const res = await creditCall(
        url,
        {
          op: "fund",
          fund: {
            amount_micro: 300_000,
            fund_id: "f1",
            commitment: fundingCommitment(ARTIFACT),
          },
        },
        PRIVKEY,
        { "X-Cashu": ARTIFACT }
      );
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).not.toBe("funding_commitment_mismatch");
      expect(body.error).toBe("cashu_unavailable");
    });
  });

  describe("replay protection", () => {
    it("burns the nonce on balance — a read is not resubmittable", async () => {
      const { url } = await startServer();
      const signed = creditSigner.signRequest(PRIVKEY, { op: "balance" });
      const send = (): Promise<Response> =>
        fetch(`${url}/v1/credit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await send()).status).toBe(200);
      // Unlike a fund, a balance read has no 402 discovery hop to protect, so
      // deferring the burn would just leave it replayable inside the drift window.
      expect((await send()).status).toBe(401);
    });

    it("burns the nonce on drain", async () => {
      const { url } = await startServer();
      // Missing drain block → 400, but the nonce is already burned: a drain
      // has no 402 discovery hop, so nothing may replay the envelope.
      const signed = creditSigner.signRequest(PRIVKEY, { op: "drain", credit_id: "c1" });
      const send = (): Promise<Response> =>
        fetch(`${url}/v1/credit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await send()).status).toBe(400);
      expect((await send()).status).toBe(401);
    });

    it("leaves the nonce unburned when a fund 402s, so the paid retry reuses the envelope", async () => {
      const { url } = await startServer();
      const signed = creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        fund: { amount_micro: 300_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const send = (): Promise<Response> =>
        fetch(`${url}/v1/credit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(signed),
        });
      expect((await send()).status).toBe(402);

      expect((await send()).status).toBe(402);
    });
  });
});

describe("the funding menu on /v1/quote", () => {
  function quote(url: string, privkey?: Uint8Array): Promise<Response> {
    return fetch(`${url}/v1/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capability: "do",
        data: privkey ? jobSigner.signRequest(privkey, { action: "go" }) : undefined,
      }),
    });
  }

  it("advertises the menu, with the balance echo for an authed holder", async () => {
    const { url, ledger } = await startServer();
    await fundCredit(ledger, {
      creditId: "c1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 750_000,
      expiryMs: FUTURE_MS,
    });
    const res = await quote(url, PRIVKEY);
    const body = (await res.json()) as { credit?: Record<string, unknown> };
    expect(res.status).toBe(200);
    expect(body.credit).toMatchObject({
      min_micro: 100_000,
      max_micro: 5_000_000,
      currency: "usd",
      credit_id: "c1",
      remaining_micro: 750_000,
    });
  });

  it("advertises the menu without a balance for an authed caller holding nothing", async () => {
    const { url } = await startServer();
    const res = await quote(url, PRIVKEY);
    const body = (await res.json()) as { credit?: Record<string, unknown> };
    expect(body.credit).toBeDefined();
    expect(body.credit?.balance_micro).toBeUndefined();
  });

  it("omits the block entirely on a DVM that did not opt in", async () => {
    const { url } = await startServer({ credit: false });
    const res = await quote(url, PRIVKEY);
    expect((await res.json()) as { credit?: unknown }).not.toHaveProperty("credit");
  });

  // Credit operations resolve denomination from the DVM declaration because they carry no quote.
  describe("a DVM that prices in EUR", () => {
    it("advertises the menu in EUR on /v1/quote, bounds converted from the USD literals", async () => {
      const { url } = await startServer({ currency: "eur" });
      const res = await quote(url, PRIVKEY);
      const body = (await res.json()) as { credit?: Record<string, unknown> };
      expect(res.status).toBe(200);
      // "$0.10" → 100 sats @ $100k/BTC → €0.09 @ €90k/BTC; "$5.00" → €4.50.
      expect(body.credit).toMatchObject({
        currency: "eur",
        min_micro: 90_000,
        max_micro: 4_500_000,
      });
    });

    it("accepts a top-up above the EUR floor but below the USD floor", async () => {
      const { url } = await startServer({ currency: "eur" });
      const res = await creditCall(url, {
        op: "fund",
        fund: { amount_micro: 95_000, fund_id: "f1", commitment: COMMITMENT },
      });
      expect(res.status).toBe(402);
      expect(await res.json()).toMatchObject({ error: "payment_required" });
    });

    it("picks the caller's EUR credit as primary, not their USD one", async () => {
      const { url, ledger } = await startServer({ currency: "eur" });
      // The USD credit is deliberately the larger balance: primary selection is
      // largest-spendable *within the menu currency*, so a USD winner here would
      // mean the route was still denominating in USD.
      await fundCredit(ledger, {
        creditId: "stranded-usd",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 900_000,
        expiryMs: FUTURE_MS,
      });
      await fundCredit(ledger, {
        creditId: "live-eur",
        callerPubkey: CALLER,
        currency: "eur",
        amountMicro: 300_000,
        expiryMs: FUTURE_MS,
      });

      const res = await creditCall(url, { op: "balance" });
      const body = (await res.json()) as {
        credit?: Record<string, unknown>;
        credits: Record<string, unknown>[];
        menu?: Record<string, unknown>;
      };
      expect(res.status).toBe(200);
      expect(body.credit).toMatchObject({ credit_id: "live-eur", currency: "eur" });

      expect(body.credits).toHaveLength(2);

      expect(body.menu).toMatchObject({ currency: "eur", min_micro: 90_000 });
    });

    it("still refuses a named credit_id in the wrong currency, before any rail", async () => {
      const { url, ledger } = await startServer({ currency: "eur" });
      await fundCredit(ledger, {
        creditId: "usd-credit",
        callerPubkey: CALLER,
        currency: "usd",
        amountMicro: 500_000,
        expiryMs: FUTURE_MS,
      });

      const res = await creditCall(url, {
        op: "fund",
        credit_id: "usd-credit",
        fund: { amount_micro: 200_000, fund_id: "f1", commitment: COMMITMENT },
      });
      const body = (await res.json()) as { error: string; message?: string };

      expect(res.status).toBe(400);
      expect(body.error).toBe("payment_invalid");
      expect(body.message).toMatch(/denominated in usd, not eur/);
    });
  });
});
