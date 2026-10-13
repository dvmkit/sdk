/**
 * reusable Tempo session channels are a `/v1/credit` instrument and
 * must not reach the job surface at either end — no `tempo/session` challenge
 * is issued on `/v1/job` or in a mid-job `payment-request`, and a session
 * credential POSTed to either is refused before mppx broadcasts it.
 *
 * mppx charges a session channel *before* the handler runs and disclaims
 * charge-only-on-success, which is exactly the pre-handler semantics the
 * confinement exists to avoid. The mid-job `pendingMppChallengeIds` binding is
 * not a substitute: it stops a credential lifted from a sibling
 * job, but the job issued this challenge itself.
 */
import { Credential } from "mppx";
import { describe, expect, it, vi } from "vitest";

import { TEMPO_SESSION_UPDATED_REASON } from "../../../lib/payment-rails/tempo-wire";
import type { FxFetcher } from "../../pricing/index";
import { StepCache } from "../../step-cache";
import { MemoryKVStore } from "../../store";
import { buildContext } from "../context";
import { CreditLedgerError } from "../credit-ledger";
import { fundingCommitment } from "../funding";
import type { ServerJob } from "../job";
import { MemoryCreditLedger } from "../memory-credit-ledger";
import {
  issueUpfrontChallenges,
  processIncomingPayment,
  verifyIncomingPayment,
  verifyUpfrontPayment,
} from "../payment";

const fx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-08-10T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/** Let the suspended `requestPayment` promise reach its yield. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function blankJob(): ServerJob {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "",
    params: {},
    requesterId: "test",
    status: "processing",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: {},
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: 0,
    lastActivityAt: 0,
  };
}

/**
 * A session-wired mppx handle: `tempo.charge` beside `tempo.session`, which is
 * exactly what `createMppFromOpts` assembles when `tempoSession` is configured.
 */
function sessionWiredMpp() {
  const issueChallenge = vi.fn((method: string, intent: string) =>
    Promise.resolve({ id: `${method}/${intent}`, method, intent, request: {} })
  );
  const broadcastCredential = vi.fn(() =>
    Promise.resolve({ method: "tempo", status: "success", reference: "0xref" })
  );
  return {
    methods: [
      { name: "tempo", intent: "charge" },
      { name: "tempo", intent: "session" },
    ],
    issueChallenge,
    broadcastCredential,
    realm: "test",
  };
}

/** A voucher credential against the session challenge the job would have issued. */
const SESSION_CREDENTIAL = {
  challenge: { id: "tempo/session", method: "tempo", intent: "session", request: {} },
  payload: {
    action: "voucher",
    channelId: `0x${"11".repeat(32)}`,
    cumulativeAmount: "1000000",
  },
};

const CALLER = "aa".repeat(32);

/** An `open` credential: session-intent, but carrying no voucher basis yet. */
const OPEN_CREDENTIAL = {
  challenge: { id: "tempo/session", method: "tempo", intent: "session", request: {} },
  payload: { action: "open", channelId: `0x${"11".repeat(32)}` },
};

describe("upfront Tempo session confinement", () => {
  it("keeps charge per-call, defaults credit to session, and restores charge on opt-in", async () => {
    const mpp = sessionWiredMpp();

    const onJob = await issueUpfrontChallenges(mpp as never, 50_000, "/v1/job", 100_000);
    const onCredit = await issueUpfrontChallenges(mpp as never, 50_000, "/v1/credit", 100_000);
    const optedInCredit = await issueUpfrontChallenges(
      mpp as never,
      50_000,
      "/v1/credit",
      100_000,
      true,
      true
    );

    expect(onJob.map((c) => c.intent)).toEqual(["charge"]);
    expect(onCredit.map((c) => c.intent)).toEqual(["session"]);
    expect(optedInCredit.map((c) => c.intent)).toEqual(["charge", "session"]);
  });

  it("refuses a session voucher on /v1/job before broadcasting it", async () => {
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "credit-1",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: Date.now() + 86_400_000,
      basis: { rail: "tempo", paidMsats: 50_000 },
    });

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: SESSION_CREDENTIAL as never,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      dvmId: "dvm-session-release",
      creditLedger: ledger,
      // The pre-fix live shape: a credit envelope on `/v1/job` widened the
      // issuer, so the caller was handed the very challenge it paid against.
      creditEnvelope: { creditId: "credit-1", drawId: "draw-1" },
    });

    expect(result.paidMsats).toBe(0);
    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "payment_invalid",
      message: "Tempo session channels are accepted only by POST /v1/credit.",
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("refuses a channel open on /v1/job, which carries no voucher basis", async () => {
    const mpp = sessionWiredMpp();

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: OPEN_CREDENTIAL as never,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
    });

    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      message: "Tempo session channels are accepted only by POST /v1/credit.",
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });
});

describe("Tempo credit instrument preflight", () => {
  it("refuses a direct charge top-up by default before broadcast", async () => {
    const mpp = sessionWiredMpp();
    const serialized = Credential.serialize(
      Credential.from({
        challenge: {
          id: "tempo/charge-default-off",
          realm: "dvm-session-origin.test",
          method: "tempo",
          intent: "charge",
          request: {},
        },
        payload: { type: "hash", hash: `0x${"22".repeat(32)}` },
      })
    );

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: serialized,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      fundOnly: {
        creditId: "credit-default-off",
        fundId: "fund-default-off",
        commitment: fundingCommitment(serialized),
      },
    });

    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "one_shot_credit_not_supported",
        display: expect.stringContaining("No money moved"),
        retryable: false,
      },
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("refuses a charge against a session-bound credit before broadcast", async () => {
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "credit-session",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "tempo",
        paidMsats: 50_000,
        nativeAmount: 50_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId: `0x${"11".repeat(32)}`, cumulativeAmount: "50000" },
      },
    });
    const serialized = Credential.serialize(
      Credential.from({
        challenge: {
          id: "tempo/charge",
          realm: "dvm-channel-rebind.test",
          method: "tempo",
          intent: "charge",
          request: {},
        },
        payload: { type: "hash", hash: `0x${"22".repeat(32)}` },
      })
    );

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: serialized,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      dvmId: "dvm-channel-rebind",
      creditLedger: ledger,
      fundOnly: {
        creditId: "credit-session",
        fundId: "fund-charge",
        commitment: fundingCommitment(serialized),
        allowOneShotStablecoin: true,
      },
    });

    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_session",
        credit_channel_id: `0x${"11".repeat(32)}`,
        retryable: false,
      },
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("allows a top-up management credential for the credit's own session channel", async () => {
    const channelId = `0x${"11".repeat(32)}`;
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "credit-session",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "tempo",
        paidMsats: 50_000,
        nativeAmount: 50_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "50000" },
      },
    });
    const descriptor = {
      payer: `0x${"22".repeat(20)}`,
      payee: `0x${"33".repeat(20)}`,
      operator: `0x${"00".repeat(20)}`,
      token: `0x${"44".repeat(20)}`,
      salt: `0x${"55".repeat(32)}`,
      authorizedSigner: `0x${"22".repeat(20)}`,
      expiringNonceHash: `0x${"66".repeat(32)}`,
    };
    const serialized = Credential.serialize({
      challenge: {
        id: "tempo/session-top-up",
        realm: "dvm-channel-rebind.test",
        method: "tempo",
        intent: "session",
        request: {
          amount: "50000",
          currency: descriptor.token,
          recipient: descriptor.payee,
          unitType: "request",
        },
      },
      payload: {
        action: "topUp",
        type: "transaction",
        channelId,
        transaction: `0x${"77".repeat(32)}`,
        descriptor,
        additionalDeposit: "50000",
      },
    } as never);

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: serialized,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      dvmId: "dvm-channel-rebind",
      creditLedger: ledger,
      fundOnly: {
        creditId: "credit-session",
        fundId: "fund-session-top-up",
        commitment: fundingCommitment(serialized),
      },
    });

    expect(result.error).toMatchObject({
      status: 402,
      body: { message: TEMPO_SESSION_UPDATED_REASON },
    });
    expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
  });

  it("refuses a session voucher against a charge-funded credit before broadcast", async () => {
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "credit-charge",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "tempo",
        paidMsats: 50_000,
        nativeAmount: 50_000,
        nativeAsset: "pathUSD",
      },
    });
    const serialized = Credential.serialize({
      challenge: {
        id: "tempo/session",
        realm: "dvm-channel-rebind.test",
        method: "tempo",
        intent: "session",
        request: {
          amount: "50000",
          currency: `0x${"33".repeat(20)}`,
          recipient: `0x${"44".repeat(20)}`,
          unitType: "request",
        },
      },
      payload: {
        action: "close",
        channelId: `0x${"11".repeat(32)}`,
        cumulativeAmount: "50000",
      },
    });

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: serialized,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      dvmId: "dvm-channel-rebind",
      creditLedger: ledger,
      fundOnly: {
        creditId: "credit-charge",
        fundId: "fund-session",
        commitment: fundingCommitment(serialized),
      },
    });

    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_charge",
        retryable: false,
      },
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("reports a late charge binding mismatch as paid and non-corrective", async () => {
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    vi.spyOn(ledger, "fund").mockRejectedValueOnce(
      new CreditLedgerError(
        "rail_mismatch",
        "credit credit-session belongs to a different funding instrument",
        {
          expectedRail: "tempo",
          expectedInstrument: "tempo_session",
          expectedChannelId: `0x${"11".repeat(32)}`,
        }
      )
    );
    const serialized = Credential.serialize(
      Credential.from({
        challenge: {
          id: "tempo/charge-late-mismatch",
          realm: "dvm-channel-rebind.test",
          method: "tempo",
          intent: "charge",
          request: {},
        },
        payload: { type: "hash", hash: `0x${"22".repeat(32)}` },
      })
    );

    const result = await verifyUpfrontPayment({
      requiredMsats: 50_000,
      mpp: mpp as never,
      mppCredential: serialized,
      fxFetcher: fx,
      priceFiat: { currency: "usd", amountMicro: 50_000 },
      callerPubkey: CALLER,
      dvmId: "dvm-channel-rebind",
      creditLedger: ledger,
      fundOnly: {
        creditId: "credit-session",
        fundId: "fund-charge-late-mismatch",
        commitment: fundingCommitment(serialized),
        allowOneShotStablecoin: true,
      },
    });

    expect(mpp.broadcastCredential).toHaveBeenCalledOnce();
    expect(result.error).toMatchObject({
      status: 409,
      body: {
        error: "payment_invalid",
        credit_rail: "tempo",
        credit_instrument: "tempo_session",
        retryable: false,
      },
    });
    expect(result.error?.body.display).toContain("payment went through");
    expect(result.error?.body.display).not.toContain("Nothing was charged");
    expect(result.error?.body.hint).toContain("Do not pay again");
  });
});

describe("mid-job Tempo session confinement", () => {
  it("drops a pre-issued session challenge a builder hands requestPayment", async () => {
    const job = blankJob();
    const mpp = sessionWiredMpp();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      paymentMethods: ["tempo"],
      mpp: mpp as never,
    });

    void ctx.requestPayment({ amount: 0.5, currency: "usd" }, "surcharge", {
      mpp: {
        challenges: [
          { id: "tempo/session", method: "tempo", intent: "session" },
          { id: "tempo/charge", method: "tempo", intent: "charge" },
        ] as never,
      },
    });
    await tick();

    expect(job.pendingMppChallengeIds).toEqual(["tempo/charge"]);
    const ask = job.messages.find((m) => m.type === "payment-request");
    expect(
      (ask?.content as { tempo?: { challenges: { intent: string }[] } }).tempo?.challenges
    ).toEqual([expect.objectContaining({ intent: "charge" })]);
  });

  it("issues no session challenge in a mid-job payment-request", async () => {
    const job = blankJob();
    const mpp = sessionWiredMpp();
    const ctx = buildContext(job, {
      store: new MemoryKVStore(),
      env: {},
      fxFetcher: fx,
      paymentMethods: ["tempo"],
      mpp: mpp as never,
    });

    void ctx.requestPayment({ amount: 0.5, currency: "usd" }, "surcharge");
    await tick();

    expect(mpp.issueChallenge.mock.calls.map((c) => c[1])).toEqual(["charge"]);
    expect(job.pendingMppChallengeIds).toEqual(["tempo/charge"]);
    const ask = job.messages.find((m) => m.type === "payment-request");
    expect(
      (ask?.content as { tempo?: { challenges: { intent: string }[] } }).tempo?.challenges
    ).toEqual([expect.objectContaining({ intent: "charge" })]);
  });

  it("refuses a session voucher on the durable mid-job path before broadcasting it", async () => {
    const mpp = sessionWiredMpp();
    const result = await verifyIncomingPayment(
      { type: "payment", content: { tempo_credential: SESSION_CREDENTIAL } },
      { mpp: mpp as never, fxFetcher: fx },
      {
        pendingPaymentMsats: 50_000,
        // The pre-fix leak: the job issued this challenge itself, so the only
        // gate the mid-job verifier applies already passes.
        pendingMppChallengeIds: ["tempo/session"],
      }
    );

    expect(result.verified).toBeUndefined();
    expect(result.error?.status).toBe(402);
    expect(result.error?.body).toMatchObject({
      error: "payment_invalid",
      message: "Tempo session channels are accepted only by POST /v1/credit.",
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
  });

  it("refuses a session voucher on the isolate mid-job path before broadcasting it", async () => {
    const job = blankJob();
    job.pendingPaymentMsats = 50_000;
    job.pendingMppChallengeIds = ["tempo/session"];
    const mpp = sessionWiredMpp();

    const result = await processIncomingPayment(
      job,
      { type: "payment", content: { tempo_credential: SESSION_CREDENTIAL } },
      { mpp: mpp as never, fxFetcher: fx }
    );

    expect(result?.status).toBe(402);
    expect(result?.body).toMatchObject({
      error: "payment_invalid",
      message: "Tempo session channels are accepted only by POST /v1/credit.",
    });
    expect(mpp.broadcastCredential).not.toHaveBeenCalled();
    expect(job.paidMsats).toBe(0);
  });

  it("still accepts a one-shot charge credential mid-job", async () => {
    const job = blankJob();
    job.pendingPaymentMsats = 50_000;
    job.pendingMppChallengeIds = ["tempo/charge"];
    const mpp = sessionWiredMpp();

    const result = await processIncomingPayment(
      job,
      {
        type: "payment",
        content: {
          tempo_credential: {
            challenge: { id: "tempo/charge", method: "tempo", intent: "charge", request: {} },
            payload: {},
          },
        },
      },
      { mpp: mpp as never, fxFetcher: fx }
    );

    expect(result).toBeNull();
    expect(mpp.broadcastCredential).toHaveBeenCalledTimes(1);
    expect(job.paidMsats).toBe(50_000);
  });
});

describe("mid-job Tempo instrument preflight", () => {
  it("skips the ledger leg for a charge against a session-bound credit", async () => {
    const channelId = `0x${"11".repeat(32)}`;
    const mpp = sessionWiredMpp();
    const ledger = new MemoryCreditLedger();
    await ledger.fund({
      creditId: "credit-session",
      callerPubkey: CALLER,
      currency: "usd",
      amountMicro: 50_000,
      expiryMs: Date.now() + 86_400_000,
      basis: {
        rail: "tempo",
        paidMsats: 50_000,
        nativeAmount: 50_000,
        nativeAsset: "pathUSD",
        tempoSession: { channelId, cumulativeAmount: "50000" },
      },
    });
    await ledger.draw({
      creditId: "credit-session",
      drawId: "draw-1",
      amountMicro: 50_000,
      jobId: "job-1",
    });
    const fund = vi.spyOn(ledger, "fund");

    // A one-shot charge writes no `tempo_channel_id`, so `fund`'s upsert would
    // refuse it against this credit — from inside the rail transaction, after
    // mppx has already broadcast the credential and moved the caller's money.
    const { verified, error } = await verifyIncomingPayment(
      {
        type: "payment",
        content: {
          tempo_credential: {
            challenge: { id: "tempo/charge", method: "tempo", intent: "charge", request: {} },
            payload: {},
          },
        },
      },
      { mpp: mpp as never, fxFetcher: fx, dvmId: "dvm-charge-credit", jobId: "job-1", creditLedger: ledger },
      {
        pendingPaymentMsats: 50_000,
        pendingPaymentFiatMicro: 50_000,
        pendingPaymentFiatCurrency: "usd",
        pendingMppChallengeIds: ["tempo/charge"],
        creditId: "credit-session",
        drawId: "draw-1",
        requesterPubkey: CALLER,
      }
    );

    // The money still moves — a mid-job refusal is a skip, never a throw.
    expect(error).toBeUndefined();
    expect(verified?.paidMsats).toBe(50_000);
    expect(mpp.broadcastCredential).toHaveBeenCalledTimes(1);
    expect(fund).not.toHaveBeenCalled();

    const draw = await ledger.getDraw({ creditId: "credit-session", drawId: "draw-1" });
    expect(draw?.amountMicro).toBe(50_000);
  });
});
