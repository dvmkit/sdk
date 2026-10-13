import { schnorr } from "@noble/curves/secp256k1.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import type { FxFetcher } from "../../pricing/index";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";
import { CREDIT_REQUEST_SCHEMA } from "../credit-routes";
import { MemoryJobStore } from "../memory-job-store";
import type { MppxServer } from "../mpp-setup";
import { verifyUpfrontPayment } from "../payment";
import { secp256k1Auth } from "../secp256k1-auth";
import { createSignedRequestVerifier } from "../signed-request";
import type { TempoObserverHealth } from "../tempo-observer-health";
import { TempoSettlementReadiness } from "../tempo-settlement-readiness";
import { durableLedger } from "./__helpers__/credit-fixtures";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-27T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

const creditSigner = createSignedRequestVerifier(CREDIT_REQUEST_SCHEMA);
const PRIVKEY = new Uint8Array(32).fill(7);
const CALLER = hex(schnorr.getPublicKey(PRIVKEY));
const CHANNEL_ID = `0x${"11".repeat(32)}`;

function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** An mppx handle advertising both Tempo intents. */
function bothIntentsMpp() {
  return {
    realm: "tempo-withholding.test",
    methods: [
      { name: "tempo", intent: "charge" },
      { name: "tempo", intent: "session" },
    ],
    challenge: {},
    issueChallenge: vi.fn((method: string, intent: string, options: Record<string, unknown> = {}) =>
      Promise.resolve({
        id: `${method}/${intent}`,
        realm: "tempo-withholding.test",
        method,
        intent,
        request: { amount: (options.amount as string) ?? "0" },
        expires: options.expires as string,
        meta: options.meta as Record<string, string>,
      })
    ),
    broadcastCredential: vi.fn(() =>
      Promise.resolve({ method: "tempo", status: "success", reference: "0xref" })
    ),
    /** Non-null only for a channel this DVM already holds. */
    getTempoSessionBinding: vi.fn((channelId: string) =>
      Promise.resolve(
        channelId === CHANNEL_ID ? { chainId: 42431, escrowContract: `0x${"22".repeat(20)}` } : null
      )
    ),
  };
}

/** A voucher against an existing channel — the top-up shape. */
const VOUCHER_CREDENTIAL = {
  challenge: { id: "tempo/session", method: "tempo", intent: "session", request: {} },
  payload: { action: "voucher", channelId: CHANNEL_ID, cumulativeAmount: "1000000" },
};

/** An `open` against a channel this DVM has never seen — a new exposure. */
const OPEN_CREDENTIAL = {
  challenge: { id: "tempo/session", method: "tempo", intent: "session", request: {} },
  payload: { action: "open", channelId: `0x${"99".repeat(32)}` },
};

/**
 * A ledger holding exactly one credit, bound to `tempoChannelId` when given.
 *
 * `verifyUpfrontPayment` reads only `get` for the issuance carve-out, and no
 * rail commits in these cases, so a two-field stub is the whole surface.
 */
function ledgerHolding(credit: { tempoChannelId: string | null; callerPubkey?: string }) {
  return {
    get: vi.fn((creditId: string) =>
      Promise.resolve(
        creditId === "credit-1"
          ? { creditId, callerPubkey: credit.callerPubkey ?? CALLER, ...credit }
          : undefined
      )
    ),
  };
}

async function startServer(observerHealthy: boolean | undefined) {
  const dvm = configureDVM({
    name: "tempo-withholding-test",
    capability: "do",
    input: z.object({ text: z.string() }),
    price: "$0.01",
    onJob(ctx) {
      ctx.complete("done");
    },
    credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true },
    auth: secp256k1Auth(),
  });
  const tempoObserverHealth: TempoObserverHealth | undefined =
    observerHealthy === undefined ? undefined : { available: () => observerHealthy };
  const mpp = bothIntentsMpp();
  const { app } = await createDVMServer(dvm, {
    env: {},
    store: new MemoryKVStore(),
    jobStore: new MemoryJobStore(),
    fxFetcher: stubFx,
    creditLedger: durableLedger(),
    mpp: mpp as unknown as MppxServer,
    ...(tempoObserverHealth ? { tempoObserverHealth } : {}),
  });
  return { app, mpp };
}

async function infoFor(observerHealthy: boolean | undefined) {
  const { app } = await startServer(observerHealthy);
  const res = await app.request("/v1/info");
  return (await res.json()) as {
    tempo?: {
      methods: { method: string; intent: string }[];
      withheld?: { method: string; intent: string; reason: string }[];
    };
    credit?: {
      tempo?: {
        methods: { method: string; intent: string }[];
        withheld?: { method: string; intent: string; reason: string }[];
      };
    };
  };
}

/** An unpaid `/v1/credit` fund — the 402 discovery hop that issues challenges. */
async function fundDiscovery402(observerHealthy: boolean) {
  const { app, mpp } = await startServer(observerHealthy);
  const res = await app.request("/v1/credit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      creditSigner.signRequest(PRIVKEY, {
        op: "fund",
        fund: {
          amount_micro: 500_000,
          fund_id: "f1",
          method: "tempo",
          intent: "charge",
          commitment: "ab".repeat(32),
        },
      })
    ),
  });
  return {
    res,
    status: res.status,
    issuedIntents: mpp.issueChallenge.mock.calls.map((call) => call[1]),
  };
}

describe("tempo/session withholding on /v1/info", () => {
  it("advertises both intents while the observer is healthy", async () => {
    const info = await infoFor(true);

    expect(info.tempo?.methods).toEqual([
      { method: "tempo", intent: "charge" },
      { method: "tempo", intent: "session" },
    ]);
    expect(info.tempo?.withheld).toBeUndefined();
  });

  it("names the withheld instrument rather than letting it vanish", async () => {
    // An agent that only sees the shortened list cannot tell a DVM
    // that never did sessions from one whose observer is down for a minute —
    // and the platform's deploy probe reads this to decide whether the DVM
    // belongs in the close observer's payee fallback at all.
    const info = await infoFor(false);

    expect(info.tempo?.withheld).toEqual([
      { method: "tempo", intent: "session", reason: "observer_unhealthy" },
    ]);
    expect(info.tempo?.methods).toEqual([{ method: "tempo", intent: "charge" }]);
    expect(info.credit?.tempo?.methods).toEqual([{ method: "tempo", intent: "charge" }]);
    expect(info.credit?.tempo?.withheld).toEqual([
      { method: "tempo", intent: "session", reason: "observer_unhealthy" },
    ]);
  });

  it("withholds nothing on a self-hosted DVM, which watches its own closes", async () => {
    const info = await infoFor(undefined);

    expect(info.tempo?.methods).toContainEqual({ method: "tempo", intent: "session" });
    expect(info.tempo?.withheld).toBeUndefined();
  });

  it("names an unsafe operator balance separately while keeping charge available", async () => {
    const dvm = configureDVM({
      name: "tempo-settlement-withholding-test",
      capability: "do",
      input: z.object({ text: z.string() }),
      price: "$0.01",
      onJob(ctx) {
        ctx.complete("done");
      },
      credit: { min: "$0.10", max: "$5.00" },
      auth: secp256k1Auth(),
    });
    const readiness = new TempoSettlementReadiness({
      address: "0x1111111111111111111111111111111111111111",
      network: "eip155:4217",
      token: "0x2222222222222222222222222222222222222222",
      lowBalanceMicro: 10_000n,
      readBalance: () => Promise.resolve(5_000n),
    });
    const server = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      creditLedger: durableLedger(),
      mpp: bothIntentsMpp() as unknown as MppxServer,
      tempoObserverHealth: { available: () => true },
      tempoSettlementReadiness: readiness,
    });

    const info = (await (await server.app.request("/v1/info")).json()) as {
      tempo?: {
        methods: { intent: string }[];
        withheld?: { intent: string; reason: string }[];
      };
    };
    expect(info.tempo?.methods).toEqual([{ method: "tempo", intent: "charge" }]);
    expect(info.tempo?.withheld).toEqual([
      { method: "tempo", intent: "session", reason: "settlement_unhealthy" },
    ]);
    server.shutdown();
    readiness.stop();
  });
});

describe("tempo/session issuance while the observer is unhealthy", () => {

  it("issues no session challenge on a /v1/credit 402 the server itself builds", async () => {
    // The wiring test: `DVMServer` resolves the gate per request and threads it
    // into `verifyUpfrontPayment`. Without that, the advertisement surfaces
    // withheld the session and the very next 402 handed one straight back.
    // Asserted on `issueChallenge` rather than the header, because a serialized
    // challenge does not carry the word "session" in the clear — a header
    // assertion here would pass whatever the gate did.
    const withheld = await fundDiscovery402(false);
    const offered = await fundDiscovery402(true);

    expect(withheld.status).toBe(402);
    expect(withheld.issuedIntents).toEqual(["charge"]);
    expect(withheld.res.headers.get("WWW-Authenticate")).toContain("Payment");
    // The control: the same request against a healthy observer does issue one.
    expect(offered.issuedIntents).toEqual(["charge", "session"]);
  });
});

describe("issuance for a credit that already holds a channel", () => {
  /**
   * The carve-out acceptance makes for an existing channel is only reachable if
   * issuance makes the same one. Withholding every session challenge left a
   * caller with an open channel unable to sign a voucher at all — and a
   * channel-bound credit takes no other rail, since `checkTargetCredit` refuses
   * a one-shot charge against it — so the top-up the gate is meant to keep
   * working stopped working.
   */
  async function challengesFor(ledger: ReturnType<typeof ledgerHolding> | undefined) {
    const mpp = bothIntentsMpp();
    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly: {
        creditId: "credit-1",
        fundId: "fund-1",
        commitment: "ab".repeat(32),
        allowOneShotStablecoin: true,
      },
      tempoSessionOffered: false,
      ...(ledger ? { creditLedger: ledger as never } : {}),
    });
    return result.error?.mppChallenges?.map((c) => c.intent);
  }

  it("still issues a session challenge for a channel-bound credit", async () => {
    expect(await challengesFor(ledgerHolding({ tempoChannelId: CHANNEL_ID }))).toEqual([
      "charge",
      "session",
    ]);
  });

  it("issues charge only for a credit with no channel behind it", async () => {
    // The case the gate exists for: this top-up would open a fresh channel.
    expect(await challengesFor(ledgerHolding({ tempoChannelId: null }))).toEqual(["charge"]);
  });

  it("issues charge only when the bound credit belongs to someone else", async () => {
    // The route gates ownership too, but this decides whether to hand out a
    // channel-scoped credential, so it re-checks rather than assuming.
    const other = ledgerHolding({
      tempoChannelId: CHANNEL_ID,
      callerPubkey: `0x${"ab".repeat(32)}`,
    });
    expect(await challengesFor(other)).toEqual(["charge"]);
  });

  it("issues charge only when there is no ledger to ask", async () => {
    // Unreadable reads as unbound, so the gate stays fail-closed.
    expect(await challengesFor(undefined)).toEqual(["charge"]);
  });
});

describe("tempo/session acceptance while the observer is unhealthy", () => {
  // A well-formed commitment, so nothing here turns on the artifact binding —
  // every case is about which channel the credential names.
  const fundOnly = {
    creditId: "credit-1",
    fundId: "fund-1",
    commitment: "ab".repeat(32),
    allowOneShotStablecoin: true,
  };

  it("refuses a channel this DVM has never seen, before broadcasting it", async () => {
    // The refusal has to run above `broadcastCredential`: mppx opens the
    // channel there, so a later refusal would already have put the caller's
    // deposit into an escrow nobody is watching.
    const mpp = bothIntentsMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: OPEN_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly,
      tempoSessionOffered: false,
    });

    expect(result.paidMsats).toBe(0);
    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "payment_invalid",
      message: expect.stringContaining("close observer is not confirmed healthy"),
      hint: expect.stringContaining("Fund the credit with a tempo/charge credential"),
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    // The caller is left a rail they can actually pay on, not a dead end.
    expect(result.error?.mppChallenges?.map((c) => c.intent)).toEqual(["charge"]);
  });

  it("does not recommend charge credit when one-shot funding is disabled", async () => {
    const mpp = bothIntentsMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: OPEN_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly: { ...fundOnly, allowOneShotStablecoin: false },
      tempoSessionOffered: false,
    });

    expect(result.paidMsats).toBe(0);
    expect(result.error).toMatchObject({
      status: 402,
      body: {
        error: "payment_invalid",
        hint: expect.stringContaining("does not accept tempo/charge for prepaid credit"),
      },
      mppChallenges: [],
    });
    expect(result.error?.body.hint).toContain("pay for a single call");
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("lets an existing channel keep topping up", async () => {
    // That deposit is already exposed. Refusing its vouchers would strand the
    // caller's money rather than protect it — only a channel we have never
    // seen is a *new* exposure.
    const mpp = bothIntentsMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: VOUCHER_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly,
      tempoSessionOffered: false,
    });

    expect(result.error).toBeUndefined();
    expect(mpp.broadcastCredential).toHaveBeenCalled();
  });

  it("accepts a brand-new channel again once the observer is healthy", async () => {
    const mpp = bothIntentsMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: OPEN_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly,
      tempoSessionOffered: true,
    });

    expect(mpp.broadcastCredential).toHaveBeenCalled();
    // An `open` carries no voucher basis, so the ordinary handshake answers.
    expect(result.error?.body).toMatchObject({
      message: expect.stringContaining("attach the next voucher"),
    });
  });

  it("still refuses an unknown channel on a credit bound to a different one", async () => {
    // The widened issuance must not widen what may be *opened*. Acceptance
    // keys on the channel the credential names, so a credit already bound to
    // CHANNEL_ID buys no permission to open a second one — and the retry hint
    // points at the channel it does hold rather than at a charge the ledger
    // would refuse.
    const mpp = bothIntentsMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: OPEN_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly,
      tempoSessionOffered: false,
      creditLedger: ledgerHolding({ tempoChannelId: CHANNEL_ID }) as never,
    });

    expect(result.error?.status).toBe(402);
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    expect(result.error?.body).toMatchObject({
      hint: expect.stringContaining("already open for this credit"),
    });
    expect(result.error?.mppChallenges?.map((c) => c.intent)).toEqual(["charge", "session"]);
  });

  it("treats a store that cannot answer as an unknown channel", async () => {
    // Fail-closed all the way down: an unreadable store is not evidence that
    // this DVM already holds the channel.
    const mpp = bothIntentsMpp();
    mpp.getTempoSessionBinding = vi.fn(() => Promise.reject(new Error("store down")));

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as unknown as MppxServer,
      mppCredential: VOUCHER_CREDENTIAL as never,
      fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      resourcePath: "/v1/credit",
      fundOnly,
      tempoSessionOffered: false,
    });

    expect(result.error?.status).toBe(402);
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });
});

/**
 * what the DVM tells the platform about itself on the same poll.
 *
 * `dvms.tempo_session_advertised_at` bounds the close observer's payee
 * fallback, and it was written once per container deploy — so a builder
 * enabling sessions with `dvmctl env --set` stayed invisible to the fallback
 * indefinitely, and a close beating its first channel's registration had no
 * route at all. The capability the poll now carries has to answer from
 * configuration: reading the withholding gate above would put the
 * hole back on a one-minute cadence.
 */
describe("declared Tempo session capability", () => {
  /** Boot a server against a gate that records what capability it declared. */
  async function bootWithGate(opts: {
    observerHealthy?: boolean;
    credit?: boolean;
    auth?: boolean;
    mpp?: boolean;
  }): Promise<{
    read: (() => boolean) | undefined;
    disposed: () => boolean;
    server: Awaited<ReturnType<typeof createDVMServer>>;
  }> {
    const dvm = configureDVM({
      name: "tempo-capability-test",
      capability: "do",
      input: z.object({ text: z.string() }),
      price: "$0.01",
      onJob(ctx) {
        ctx.complete("done");
      },
      ...(opts.credit === false
        ? {}
        : { credit: { min: "$0.10", max: "$5.00", allowOneShotStablecoin: true } }),
      ...(opts.auth === false ? {} : { auth: secp256k1Auth() }),
    });
    let read: (() => boolean) | undefined;
    let disposed = false;
    const tempoObserverHealth: TempoObserverHealth = {
      available: () => opts.observerHealthy ?? true,
      declareSessionCapability: (reader) => {
        read = reader;
        return () => {
          disposed = true;
        };
      },
    };
    const server = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      jobStore: new MemoryJobStore(),
      fxFetcher: stubFx,
      creditLedger: durableLedger(),
      ...(opts.mpp === false ? {} : { mpp: bothIntentsMpp() as unknown as MppxServer }),
      tempoObserverHealth,
    });
    return { read, disposed: () => disposed, server };
  }

  /** What this DVM would carry up on its next poll. */
  async function declaredCapability(
    opts: Parameters<typeof bootWithGate>[0]
  ): Promise<boolean | undefined> {
    return (await bootWithGate(opts)).read?.();
  }

  it("declares itself capable while the gate is withholding sessions", async () => {
    // Capability depends on configuration, not current observer health. A DVM that keeps its stamp through an
    // observer outage stays reachable for the close that outage did not stop.
    expect(await declaredCapability({ observerHealthy: false })).toBe(true);
  });

  it("declares itself capable while the observer is healthy", async () => {
    expect(await declaredCapability({ observerHealthy: true })).toBe(true);
  });

  it("declares nothing capable when no session method is configured", async () => {
    expect(await declaredCapability({ mpp: false })).toBe(false);
  });

  it("stays credit-scoped: a DVM with no credit menu cannot take a session", async () => {
    // Sessions are confined to `POST /v1/credit`, so a DVM that never
    // advertises credit is not a channel anyone can open — and not a candidate
    // the payee fallback should wake. Same rule the deploy probe applies.
    expect(await declaredCapability({ credit: false })).toBe(false);
  });

  it("stays auth-scoped, like the credit menu itself", async () => {
    expect(await declaredCapability({ auth: false })).toBe(false);
  });

  it("withdraws its vote when the mount shuts down", async () => {
    // The health client is per platform token, not per mount, so on a host
    // serving several DVMs a torn-down one would otherwise keep voting `true`
    // into the OR forever.
    const booted = await bootWithGate({});
    expect(booted.disposed()).toBe(false);

    booted.server.shutdown();

    expect(booted.disposed()).toBe(true);
  });
});
