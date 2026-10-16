import { randomBytes } from "node:crypto";

import { Credential, Errors, type Receipt } from "mppx";
import { Mppx } from "mppx/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MppxCredential } from "../../lib/messages/types";
import { encodePayment } from "../../lib/x402/spec";
import { TEST_BTC_USD_RATE } from "../../test-support/setup-fx-mock";
import type { FxFetcher } from "../pricing/index";
import { CreditLedgerError } from "../server/credit-ledger";
import { MemoryCreditLedger } from "../server/memory-credit-ledger";
import { MemoryProcessedPaymentStore, ProcessedPaymentReplayError } from "../server/processed-payment-store";
import { MemoryConsumedCredentialStore } from "../server/consumed-credential-store";
import type { ServerJob } from "../server/job";
import { challengeMeta, type MppxServer, wrapMppx } from "../server/mpp-setup";
import { methodNativeAmountToDecimal } from "../server/mpp-units";
import { processIncomingPayment, verifyUpfrontPayment } from "../server/payment";
import { StepCache } from "../step-cache";
import { stubbedTempoCharge } from "./__helpers__/mppx-stub";

function makeJob(overrides?: Partial<ServerJob>): ServerJob {
  return {
    id: "job-1",
    tags: [],
    capability: "test",
    input: "test",
    params: {},
    requesterId: "user-1",
    status: "awaiting-input",
    messages: [],
    seq: 0,
    paidMsats: 0,
    receivedProofs: [],
    pendingPaymentMsats: 1000,
    listeners: new Set(),
    abort: new AbortController(),
    stepCache: new StepCache(),
    state: {},
    pendingPrompts: new Map(),
    pendingPayment: null,
    replayHighSeq: null,
    replayProviderSkip: 0,
    replayPaymentIndex: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    ...overrides
  };
}

const TEMPO_RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00";
const SECRET_KEY = randomBytes(32).toString("hex");

/**
 * The credential's HMAC-bound amount and the SDK's required amount must use the same
 * deterministic FX snapshot.
 */
const BTC_USD = TEST_BTC_USD_RATE;

/**
 * Deterministic fx source handed to every call that prices a non-sat rail
 * (mppx fiat, x402 USDC). Calls with no such rail — Cashu-only, or a bare
 * `payment_required` — resolve no rate at all (`needsRate` in
 * `verifyUpfrontPayment`) and deliberately don't take it.
 */
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: BTC_USD }, as_of: "2026-07-25T00:00:00Z" }),
  supportedCurrencies: () => ["usd"]
};

/**
 * Build an Mppx server whose settlement is stubbed so unit tests don't need a
 * Tempo RPC. Everything upstream of settlement — HMAC binding, amount pinning,
 * meta/route binding, expiry — is still real mppx. Default returns success;
 * tests override per case. See `stubbedTempoCharge` for why the stub goes on
 * the method before `Mppx.create` rather than on `mpp.methods` after it.
 */
function makeMppx(): {
  mpp: MppxServer;
  setVerify: (fn: () => Promise<Receipt.Receipt>) => void;
} {
  const { method, setBroadcast } = stubbedTempoCharge(TEMPO_RECIPIENT);
  const mpp = wrapMppx(
    Mppx.create({
      methods: [method],
      secretKey: SECRET_KEY,
      realm: "test.example"
    })
  );
  return { mpp, setVerify: setBroadcast };
}

async function makeTempoCredential(mpp: MppxServer, amountMsats: number): Promise<MppxCredential> {
  const usd = (amountMsats / 100_000_000_000) * BTC_USD;
  // Use the registered handler so the request goes through the schema transform
  // (decimal "0.001234" → integer micro-USDC "1234") and the HMAC matches.
  // Mirror `issueUpfrontChallenges`: bind `opaque.{path,nonce}` so the verify
  // path's resourcePath check has something to match against.
  const challenge = await mpp.challenge.tempo.charge({
    amount: usd.toFixed(6),
    meta: { path: "/v1/job", nonce: randomBytes(16).toString("hex") }
  });
  return Credential.from({
    challenge,
    payload: { type: "hash" as const, hash: `0x${"a".repeat(64)}` }
  });
}

const mockVerifyX402 = vi.fn();

vi.mock("../../lib/x402", () => ({
  verifyX402Payment: (...args: unknown[]) => mockVerifyX402(...args),
}));

const mockReceiveCashuToken = vi.fn();

vi.mock("../../lib/cashu/verify", async (importActual) => {
  const actual = await importActual();
  return {
    ...(actual as Record<string, unknown>),
    receiveCashuToken: (...args: unknown[]) => mockReceiveCashuToken(...args),
  };
});

const X402_CONFIG = { payTo: "0xabc", network: "eip155:8453" };

/**
 * Build a base64-encoded `X-PAYMENT` header carrying the given EIP-3009
 * `bytes32` nonce. The `verifyX402Payment` mock returns `verified: true`
 * unconditionally — this fixture exists so `decodePayment` inside the
 * per-job binding check can read back the nonce we control.
 */
function makeX402PaymentHeader(nonce: string): string {
  return encodePayment({
    x402Version: 1,
    scheme: "exact",
    network: "base-sepolia",
    payload: {
      signature: "0xdeadbeef",
      authorization: {
        from: "0xfrom",
        to: "0xto",
        value: "1000000",
        validAfter: "0",
        validBefore: "9999999999",
        nonce
      }
    }
  });
}

describe("verifyUpfrontPayment", () => {
  it("formats method-native atomic amounts for mppx request parsing", () => {
    expect(methodNativeAmountToDecimal("10000", "tempo")).toBe("0.010000");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns payment_required when requiredMsats is set but no payment provided", async () => {
    const result = await verifyUpfrontPayment({ requiredMsats: 1000 });
    expect(result.error?.body.error).toBe("payment_required");
    expect(result.error?.status).toBe(402);
  });

  it("verifies x402 signature via facilitator and surfaces native amount + tx hash", async () => {
    // An authorization for exactly the advertised amount. The rail-native
    // figure and the msat quote coincide at the test rate (one msat is one
    // µUSDC at $100k/BTC), so what this pins is that `nativeAmount` is the
    // USDC microunit count and not the payment restated in sats.
    mockVerifyX402.mockResolvedValue({
      verified: true,
      amountMsats: 1000,
      amountUsdcMicro: 1_000,
      txHash: "0xevmhash",
      settleResponseHeader: "c2V0dGxlZA=="
    });
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      x402Payment: "encoded-payload",
      x402Config: X402_CONFIG,
      priceFiat: { currency: "usd", amountMicro: 1_000 },
      x402Resource: "/v1/job",
      fxFetcher: stubFx
    });
    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(1000);
    expect(result.paymentRail).toBe("x402");
    expect(result.nativeAmount).toBe(1_000);
    expect(result.nativeAsset).toBe("usdc");
    expect(result.paymentTxHash).toBe("0xevmhash");
    expect(result.x402SettleResponseHeader).toBe("c2V0dGxlZA==");
    expect(mockVerifyX402).toHaveBeenCalled();
    const call = mockVerifyX402.mock.calls[0];
    expect(call[0]).toBe("encoded-payload");
    expect(call[1]).toMatchObject({ payTo: "0xabc", network: "eip155:8453" });
    expect(call[2]).toBe(1_000n);
    expect(call[3]).toBe("/v1/job");
  });

  it("returns payment_invalid when x402 verification fails", async () => {
    mockVerifyX402.mockResolvedValue({ verified: false, amountMsats: 0 });
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      x402Payment: "bad-payload",
      x402Config: X402_CONFIG,
      priceFiat: { currency: "usd", amountMicro: 1_000 },
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
  });

  it("returns payment_invalid when x402 verification throws", async () => {
    mockVerifyX402.mockRejectedValue(new Error("network error"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      x402Payment: "encoded-payload",
      x402Config: X402_CONFIG,
      priceFiat: { currency: "usd", amountMicro: 1_000 },
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
    expect(result.error?.body.message).toBe("x402 verification error");
    // the generic body still carries a relayable display + a retry
    // signal; display must not echo the internal `message`.
    expect(typeof result.error?.body.display).toBe("string");
    expect(result.error?.body.display).not.toBe(result.error?.body.message);
    expect(result.error?.body.retryable).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).not.toContain("network error");
    warn.mockRestore();
  });

  it("verifies an MPP credential via mppx.broadcastCredential when amount matches", async () => {
    const { mpp, setVerify } = makeMppx();
    const transactionHash = `0x${"ab".repeat(32)}`;
    setVerify(() =>
      Promise.resolve({
        method: "tempo",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: transactionHash
      })
    );
    const credential = await makeTempoCredential(mpp, 1000);
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mppCredential: credential,
      mpp,
      fxFetcher: stubFx
    });
    expect(result.error).toBeUndefined();
    // Amount equality is now enforced via mppx's request.amount check, so the
    // SDK credits exactly the requested msats rather than the credential's
    // bound amount.
    expect(result.paidMsats).toBe(1000);
    expect(result.paymentRail).toBe("tempo");
    // + native fields surfaced for revenue-ledger wiring.
    // Tempo settles in USDC; nativeAmount is micro-USDC derived from the
    // credential's method-native decimal amount.
    expect(result.nativeAmount).toBe(1_000);
    expect(result.nativeAsset).toBe("usdc");
    expect(result.paymentTxHash).toBe(credential.challenge.id);
    expect(result.paymentTransactionHash).toBe(transactionHash);
  });

  it("names a charge-funded credit's instrument on its deposit report", async () => {
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    const ledger = new MemoryCreditLedger();
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx,
      priceFiat: { currency: "usd", amountMicro: 1000 },
      creditLedger: ledger, processedPayments: new MemoryProcessedPaymentStore(),
      consumedCredentialStore: new MemoryConsumedCredentialStore(), dvmId: "example-dvm"
    });
    expect(result.error).toBeUndefined();
    expect(result.funding).toMatchObject({ rail: "tempo", instrument: "tempo_charge" });
    const credit = await ledger.get(result.funding?.creditId ?? "");
    expect(credit?.rail).toBe("tempo");
    expect(credit?.tempoChannelId ?? null).toBeNull();
  });

  it("rejects an MPP credential whose bound amount differs from the requested amount", async () => {
    const { mpp } = makeMppx();
    // Credential is bound to 5000 msats but the SDK's request is 1000 msats —
    // mppx must reject the mismatch instead of trusting the credential.
    const credential = await makeTempoCredential(mpp, 5000);
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mppCredential: credential,
      mpp,
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
    expect(result.paidMsats).toBe(0);
  });

  it("returns payment_invalid when mppx.broadcastCredential rejects", async () => {
    const { mpp, setVerify } = makeMppx();
    setVerify(async () => {
      throw new Error("bad signature");
    });
    const credential = await makeTempoCredential(mpp, 1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mppCredential: credential,
      mpp,
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: "warn",
      event: "tempo_credential_rejected",
      rail: "tempo",
      phase: "upfront",
      failure_category: "unknown",
      failure_stage: "verifier_broadcast"
    });
    expect(JSON.stringify(logged)).not.toContain("bad signature");
    warn.mockRestore();
  });

  it("retains a typed challenge refusal without exposing its reason", async () => {
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    credential.challenge.id = "SENTINEL_CHALLENGE";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await verifyUpfrontPayment({ requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx });
      expect(result.error?.body.error).toBe("payment_invalid");
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        failure_category: "invalid_challenge", failure_stage: "verifier_broadcast"
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SENTINEL");
    } finally { warn.mockRestore(); }
  });

  it.each(["replay_store", "funding_ledger"] as const)("identifies an unexpected %s failure after broadcast", async (stage) => {
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    const ledger = new MemoryCreditLedger();
    const processedPayments = new MemoryProcessedPaymentStore();
    const consumedCredentialStore = new MemoryConsumedCredentialStore();
    const failure = new TypeError("SENTINEL_DATABASE https://example.com/?secret=SENTINEL");
    const failingOperation = stage === "replay_store"
      ? vi.spyOn(processedPayments, "record").mockRejectedValue(failure)
      : vi.spyOn(ledger, "fund").mockRejectedValue(failure);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await verifyUpfrontPayment({
        requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx,
        priceFiat: { currency: "usd", amountMicro: 1000 },
        creditLedger: ledger, processedPayments, consumedCredentialStore, dvmId: "example-dvm"
      });
      expect(failingOperation).toHaveBeenCalled();
      expect(result.error?.body.error).toBe("payment_invalid");
      expect(result.paidMsats).toBe(0);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        failure_category: "unknown", failure_stage: stage, phase: "upfront"
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SENTINEL");
      expect(await ledger.get(`imp:tempo:${credential.challenge.id}`)).toBeUndefined();
    } finally { vi.restoreAllMocks(); }
  });

  it.each([false, true])("honours a proven charge when its replay mark fails (ledger: %s)", async (withLedger) => {
    const { mpp, setVerify } = makeMppx();
    const transactionHash = `0x${"ab".repeat(32)}`;
    const broadcast = vi.fn(async (): Promise<Receipt.Receipt> => ({
      method: "tempo", status: "success", timestamp: new Date().toISOString(),
      reference: transactionHash,
    }));
    setVerify(broadcast);
    const credential = await makeTempoCredential(mpp, 1000);
    const ledger = new MemoryCreditLedger();
    const processedPayments = new MemoryProcessedPaymentStore();
    const consumedCredentialStore = new MemoryConsumedCredentialStore();
    vi.spyOn(consumedCredentialStore, "mark").mockRejectedValue(new Error("SENTINEL_DATABASE"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await verifyUpfrontPayment({
        requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx,
        consumedCredentialStore,
        ...(withLedger && {
          priceFiat: { currency: "usd" as const, amountMicro: 1000 },
          creditLedger: ledger, processedPayments, dvmId: "example-dvm", jobId: "job-1",
        }),
      });
      expect(result.error).toBeUndefined();
      expect(result.paidMsats).toBe(1000);
      expect(result.paymentTransactionHash).toBe(transactionHash);
      expect(broadcast).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledOnce();
      expect(JSON.parse(String(error.mock.calls[0][0]))).toEqual({
        event: "tempo_replay_mark_failed", level: "error", phase: "upfront", rail: "tempo",
        transaction_hash: transactionHash, failure_category: "unknown", failure_stage: "replay_store",
      });
      expect(JSON.stringify(error.mock.calls)).not.toContain("SENTINEL");
      if (withLedger) {
        const creditId = `imp:tempo:${credential.challenge.id}`;
        expect(await processedPayments.get({
          dvmId: "example-dvm", rail: "tempo", paymentId: credential.challenge.id,
        })).toMatchObject({ creditId, jobId: "job-1" });
        expect(await ledger.get(creditId)).toMatchObject({ balanceMicro: 1000 });
        expect(await ledger.getDrawByJobId("job-1")).toMatchObject({
          creditId, amountMicro: 1000, status: "pending",
        });
      }
    } finally { vi.restoreAllMocks(); }
  });

  it("keeps a failed replay mark fail-closed without an on-chain receipt", async () => {
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    const consumedCredentialStore = new MemoryConsumedCredentialStore();
    vi.spyOn(consumedCredentialStore, "mark").mockRejectedValue(new Error("store unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await verifyUpfrontPayment({
        requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx,
        consumedCredentialStore,
      });
      expect(result.error?.status).toBe(402);
      expect(result.paidMsats).toBe(0);
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({
        event: "tempo_credential_rejected", failure_stage: "replay_store",
      });
    } finally { vi.restoreAllMocks(); }
  });

  it.each([
    ["replay_detected", "replay_store", "replay_rejected"],
    ["ledger_refused", "funding_ledger", "credit_not_found"],
  ] as const)("retains a mapped %s refusal and its original response", async (category, stage, code) => {
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    const ledger = new MemoryCreditLedger();
    const processedPayments = new MemoryProcessedPaymentStore();
    if (stage === "replay_store") {
      vi.spyOn(processedPayments, "record").mockRejectedValue(new ProcessedPaymentReplayError("tempo", "SENTINEL_PAYMENT"));
    } else {
      vi.spyOn(ledger, "fund").mockRejectedValue(new CreditLedgerError("credit_not_found", "SENTINEL_LEDGER"));
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await verifyUpfrontPayment({
        requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx,
        priceFiat: { currency: "usd", amountMicro: 1000 }, creditLedger: ledger, processedPayments, dvmId: "example-dvm"
      });
      expect(result.error?.body.error).toBe(code);
      expect(result.paidMsats).toBe(0);
      const logged = warn.mock.calls.map((call) => JSON.parse(String(call[0])));
      expect(logged).toContainEqual(expect.objectContaining({
        event: "tempo_credential_rejected", failure_category: category, failure_stage: stage
      }));
      expect(JSON.stringify(logged)).not.toContain("SENTINEL");
    } finally { vi.restoreAllMocks(); }
  });

  it("does not classify a forged exception name as a payment refusal", async () => {
    const { mpp, setVerify } = makeMppx();
    setVerify(async () => { throw { name: "InvalidChallengeError", message: "SENTINEL", cause: new Errors.InvalidChallengeError() }; });
    const credential = await makeTempoCredential(mpp, 1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await verifyUpfrontPayment({ requiredMsats: 1000, mppCredential: credential, mpp, fxFetcher: stubFx });
      expect(JSON.parse(String(warn.mock.calls[0][0]))).toMatchObject({ failure_category: "unknown" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SENTINEL");
    } finally { warn.mockRestore(); }
  });

  it("does not require mints for payment_required when only x402/mpp configured", async () => {
    const { mpp } = makeMppx();
    const result = await verifyUpfrontPayment({
      requiredMsats: 5000,
      x402Config: X402_CONFIG,
      mpp,
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_required");
    expect(result.error?.body.mints).toBeUndefined();
  });

  it("attaches a fresh mppx challenge per registered method when mpp is wired and no credential is sent", async () => {
    const { mpp } = makeMppx();
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mpp,
      resourcePath: "/v1/job",
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_required");
    const issued = result.error?.mppChallenges;
    expect(issued).toBeDefined();
    expect(issued).toHaveLength(1);
    const ch = issued?.[0];
    if (!ch) throw new Error("expected challenge");
    expect(ch.method).toBe("tempo");
    expect(ch.intent).toBe("charge");
    expect(ch.realm).toBe("test.example");
    expect(challengeMeta(ch)?.path).toBe("/v1/job");
    expect(challengeMeta(ch)?.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(ch.expires).toBeTruthy();
  });

  it("omits mppChallenges when mpp is not wired (Cashu/Lightning/x402-only DVMs)", async () => {
    const result = await verifyUpfrontPayment({ requiredMsats: 1000 });
    expect(result.error?.body.error).toBe("payment_required");
    expect(result.error?.mppChallenges).toBeUndefined();
  });

  it("rejects an MPP credential whose meta.path differs from the verifying resourcePath", async () => {
    // Cross-endpoint replay: a credential bought for `/v1/job` MUST NOT verify
    // against a different paid endpoint of the same DVM. mppx HMAC binds the
    // meta but not the live request path, so the SDK has to pin `meta.path` to
    // the request path inside `verifyUpfrontPayment`, where challenge path binding is checked.
    // `makeTempoCredential` issues with `meta.path = "/v1/job"`.
    const { mpp } = makeMppx();
    const credential = await makeTempoCredential(mpp, 1000);
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mppCredential: credential,
      mpp,
      resourcePath: "/v1/some-other-paid-endpoint",
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
    expect(result.paidMsats).toBe(0);
    // And a fresh challenge is issued for the actual endpoint, so the client
    // can retry against the correct binding.
    const fresh = result.error?.mppChallenges?.[0];
    if (!fresh) throw new Error("expected fresh challenge");
    expect(challengeMeta(fresh)?.path).toBe("/v1/some-other-paid-endpoint");
  });

  it("re-issues a fresh challenge when the supplied MPP credential is rejected", async () => {
    const { mpp, setVerify } = makeMppx();
    setVerify(async () => {
      throw new Error("bad signature");
    });
    const credential = await makeTempoCredential(mpp, 1000);
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      mppCredential: credential,
      mpp,
      resourcePath: "/v1/job",
      fxFetcher: stubFx
    });
    expect(result.error?.body.error).toBe("payment_invalid");
    expect(result.error?.mppChallenges).toHaveLength(1);
    const fresh = result.error?.mppChallenges?.[0];
    if (!fresh) throw new Error("expected fresh challenge");
    // Fresh challenge has a different id than the rejected credential's
    // challenge — bound nonce is freshly generated per issuance.
    expect(fresh.id).not.toBe(credential.challenge.id);
  });

  it("succeeds with no error when no payment is required", async () => {
    const result = await verifyUpfrontPayment({});
    expect(result.error).toBeUndefined();
    expect(result.paidMsats).toBe(0);
  });

  it("returns cashu_unavailable when cashu token sent but mints not configured", async () => {
    const result = await verifyUpfrontPayment({
      requiredMsats: 1000,
      cashuToken: "cashuAeyJ..."
    });
    expect(result.error?.body.error).toBe("cashu_unavailable");
    expect(result.error?.status).toBe(402);
    expect(result.error?.body.message).toMatch(/cashu/i);
  });

  describe("upfront replay protection", () => {
    it("rejects a credential whose challenge.id was already consumed", async () => {
      const { mpp } = makeMppx();
      const credential = await makeTempoCredential(mpp, 1000);
      const consumedCredentialStore = new MemoryConsumedCredentialStore();

      const first = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        consumedCredentialStore,
        fxFetcher: stubFx
      });
      expect(first.error).toBeUndefined();
      expect(first.paidMsats).toBe(1000);

      const second = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        consumedCredentialStore,
        fxFetcher: stubFx
      });
      expect(second.error?.body.error).toBe("payment_invalid");
      expect(second.error?.body.message).toMatch(/already used/);
      expect(second.paidMsats).toBe(0);
      // Spec-compliant retry shape: a fresh challenge so the client can pay
      // again rather than getting stuck with no actionable response.
      const fresh = second.error?.mppChallenges?.[0];
      if (!fresh) throw new Error("expected fresh challenge");
      expect(fresh.id).not.toBe(credential.challenge.id);
    });

    it("does not enforce replay protection when no store is wired", async () => {
      // Locks the contract that replay protection is opt-in via the store
      // arg, not a side effect of the verify path. Without a store, mppx's
      // own expiry check is the only defense — same as legacy behavior.
      const { mpp } = makeMppx();
      const credential = await makeTempoCredential(mpp, 1000);

      const first = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        fxFetcher: stubFx
      });
      const second = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        fxFetcher: stubFx
      });
      expect(first.error).toBeUndefined();
      expect(second.error).toBeUndefined();
    });

    it("does not mark a credential as consumed when HMAC verify fails", async () => {
      // A failed verify must not poison the store — otherwise an attacker
      // could burn legitimate credentials by submitting them with a tampered
      // body. The mark only happens after `mpp.broadcastCredential` succeeds.
      const { mpp, setVerify } = makeMppx();
      const credential = await makeTempoCredential(mpp, 1000);
      const consumedCredentialStore = new MemoryConsumedCredentialStore();

      setVerify(async () => {
        throw new Error("bad signature");
      });
      const failed = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        consumedCredentialStore,
        fxFetcher: stubFx
      });
      expect(failed.error?.body.error).toBe("payment_invalid");

      // Restore verify and submit again — should succeed because the prior
      // failed attempt did not mark the credential.
      setVerify(async () => ({
        method: "tempo",
        status: "success",
        timestamp: new Date().toISOString(),
        reference: "0xref"
      }));
      const ok = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: credential,
        mpp,
        resourcePath: "/v1/job",
        consumedCredentialStore,
        fxFetcher: stubFx
      });
      expect(ok.error).toBeUndefined();
      expect(ok.paidMsats).toBe(1000);
    });
  });
});

describe("processIncomingPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-payment messages", async () => {
    const job = makeJob();
    const result = await processIncomingPayment(
      job,
      { type: "response", content: { prompt_id: "p1", text: "yes" } },
      {}
    );
    expect(result).toBeNull();
    expect(job.paidMsats).toBe(0);
  });

  describe("x402 payments", () => {
    it("credits an unbound legacy job on valid x402 signature", async () => {
      mockVerifyX402.mockResolvedValue({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 5_000,
        txHash: "0xevmhash"
      });
      const job = makeJob();

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { x402_payment: "encoded-payload" } },
        { x402Config: X402_CONFIG, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(1000);
      expect(job.status).toBe("processing");
      expect(job.pendingPaymentMsats).toBeUndefined();
      // native fields are now populated on every credit (was
      // upfront-only post-). The platform's revenue callback reads
      // these to write `revenue_events.{gross_native, tx_hash}`.
      expect(job.paymentRail).toBe("x402");
      expect(job.nativeAmount).toBe(5_000);
      expect(job.nativeAsset).toBe("usdc");
      expect(job.paymentTxHash).toBe("0xevmhash");
    });

    it("returns error on invalid x402 signature", async () => {
      mockVerifyX402.mockResolvedValue({ verified: false, amountMsats: 0 });
      const job = makeJob();

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { x402_payment: "bad-payload" } },
        { x402Config: X402_CONFIG, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(job.paidMsats).toBe(0);
      expect(job.status).toBe("awaiting-input");
    });

    it("does not process x402 when no x402Config provided", async () => {
      const job = makeJob();

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { x402_payment: "encoded-payload" } },
        {}
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(0);
      expect(mockVerifyX402).not.toHaveBeenCalled();
    });

    // The signed authorization must also match this job's pending nonce.
    it("refuses x402 on a non-USD DVM before facilitator verification", async () => {
      const job = makeJob();

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { x402_payment: "encoded-payload" } },
        { x402Config: X402_CONFIG, pricingCurrency: "eur", fxFetcher: stubFx }
      );

      expect(result?.body).toMatchObject({ error: "x402_not_offered", retryable: false });
      expect(result?.status).toBe(402);
      expect(job.paidMsats).toBe(0);
      expect(mockVerifyX402).not.toHaveBeenCalled();
    });

    it("credits the job when the x402 nonce matches the per-job binding", async () => {
      const nonce = `0x${"a".repeat(64)}`;
      mockVerifyX402.mockResolvedValue({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 5_000,
        txHash: "0xevmhash"
      });
      const job = makeJob({ pendingX402Nonce: nonce });

      const result = await processIncomingPayment(
        job,
        {
          type: "payment",
          content: { x402_payment: makeX402PaymentHeader(nonce) }
        },
        { x402Config: X402_CONFIG, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(1000);
      expect(job.paymentRail).toBe("x402");
      // Cleared on success so a second submission can't credit again via
      // this code path.
      expect(job.pendingX402Nonce).toBeUndefined();
    });

    it("rejects an x402 payment whose nonce wasn't issued for this job (cross-job replay)", async () => {
      const boundNonce = `0x${"a".repeat(64)}`;
      const replayedNonce = `0x${"b".repeat(64)}`;
      // Facilitator says the EIP-3009 sig is valid — replay scenario is a
      // valid payload lifted from a sibling job's payment-request.
      mockVerifyX402.mockResolvedValue({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 5_000,
        txHash: "0xevmhash"
      });
      const job = makeJob({ pendingX402Nonce: boundNonce });

      const result = await processIncomingPayment(
        job,
        {
          type: "payment",
          content: { x402_payment: makeX402PaymentHeader(replayedNonce) }
        },
        { x402Config: X402_CONFIG, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(result?.body.message).toMatch(/not bound to this job/i);
      expect(result?.status).toBe(402);
      expect(job.paidMsats).toBe(0);
      expect(job.status).toBe("awaiting-input");
      // Binding stays so the legitimate credential can still arrive.
      expect(job.pendingX402Nonce).toBe(boundNonce);
    });
  });

  describe("MPP payments", () => {
    it("credits the job on valid MPP credential", async () => {
      const { mpp } = makeMppx();
      // makeJob() sets pendingPaymentMsats: 1000; credential bound to the same.
      const credential = await makeTempoCredential(mpp, 1000);
      const job = makeJob({ pendingMppChallengeIds: [credential.challenge.id] });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(1000);
      expect(job.status).toBe("processing");
      expect(job.paymentRail).toBe("tempo");
      // Cleared on success so a second submission can't credit again.
      expect(job.pendingMppChallengeIds).toBeUndefined();
      // + native fields populated on every credit. Tempo
      // settles in USDC; nativeAmount is micro-USDC.
      expect(job.nativeAmount).toBe(1_000);
      expect(job.nativeAsset).toBe("usdc");
      expect(job.paymentTxHash).toBe(credential.challenge.id);
    });

    it("rejects a credential whose challenge wasn't issued for this job (cross-job replay)", async () => {
      const { mpp } = makeMppx();
      // Credential is cryptographically valid against `tempo` and bound to the
      // right amount, but the challenge.id wasn't issued for *this* job —
      // simulating a credential lifted from a sibling job whose payment-request
      // had identical realm/method/amount.
      const credential = await makeTempoCredential(mpp, 1000);
      const job = makeJob({ pendingMppChallengeIds: ["someone-elses-challenge"] });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(result?.body.message).toMatch(/not bound to this job/i);
      expect(result?.status).toBe(402);
      expect(job.paidMsats).toBe(0);
      expect(job.status).toBe("awaiting-input");
      // Binding stays so the legitimate credential can still arrive.
      expect(job.pendingMppChallengeIds).toEqual(["someone-elses-challenge"]);
    });

    it("rejects a credential when no MPP binding has been set on the job", async () => {
      const { mpp } = makeMppx();
      const credential = await makeTempoCredential(mpp, 1000);
      const job = makeJob({ pendingMppChallengeIds: undefined });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(result?.body.message).toMatch(/not bound to this job/i);
      expect(job.paidMsats).toBe(0);
    });

    it("rejects an MPP credential whose bound amount differs from pendingPaymentMsats", async () => {
      const { mpp } = makeMppx();
      const credential = await makeTempoCredential(mpp, 5000);
      const job = makeJob({ pendingPaymentMsats: 1000 });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(job.paidMsats).toBe(0);
    });

    it("rejects an MPP credential when no payment-request is pending", async () => {
      const { mpp } = makeMppx();
      const credential = await makeTempoCredential(mpp, 1000);
      const job = makeJob({ pendingPaymentMsats: undefined });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(result?.body.message).toMatch(/pending/i);
      expect(job.paidMsats).toBe(0);
    });

    it("returns payment_invalid when broadcastCredential throws", async () => {
      const { mpp, setVerify } = makeMppx();
      setVerify(async () => {
        throw new Error("invalid signature");
      });
      const credential = await makeTempoCredential(mpp, 1000);
      const job = makeJob();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: credential } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result?.body.error).toBe("payment_invalid");
      expect(job.paidMsats).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).not.toContain("invalid signature");
      warn.mockRestore();
    });
  });

  // a job that takes multiple x402/mpp credits (upfront +
  // mid-job) must accumulate `nativeAmount` so the platform's
  // `revenue_events.gross_native` row sums all credits, not just the
  // upfront one. Earlier only `paidMsats` accumulated.
  describe("multi-credit native accumulation", () => {
    it("accumulates nativeAmount + updates paymentTxHash across upfront + mid-job x402 credits", async () => {
      // Upfront credit via verifyUpfrontPayment — same flow the platform's
      // intake (IsolateJobManager.createAndRunJob) uses. Each x402 credit
      // pays exactly its 1_000 microUSDC ask.
      mockVerifyX402.mockResolvedValueOnce({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 1_000,
        txHash: "0xupfront"
      });
      const upfront = await verifyUpfrontPayment({
        requiredMsats: 1000,
        x402Payment: "encoded-payload-1",
        x402Config: X402_CONFIG,
        priceFiat: { currency: "usd", amountMicro: 1_000 },
        fxFetcher: stubFx
      });

      // Hydrate a ServerJob from the upfront PaymentInfo, mirroring
      // `IsolateJobManager.createAndRunJob`'s PaymentInfo→ServerJob copy.
      const job = makeJob({
        paidMsats: upfront.paidMsats,
        paymentRail: upfront.paymentRail,
        paymentTxHash: upfront.paymentTxHash,
        nativeAmount: upfront.nativeAmount,
        nativeAsset: upfront.nativeAsset,
        // Re-armed for a mid-job payment-request yield.
        pendingPaymentMsats: 1000,
        status: "awaiting-input"
      });

      // Mid-job credit — second x402 payment via processIncomingPayment.
      mockVerifyX402.mockResolvedValueOnce({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 1_000,
        txHash: "0xmidjob"
      });
      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { x402_payment: "encoded-payload-2" } },
        { x402Config: X402_CONFIG, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(2000);
      // Earlier this was 1_000 (upfront only); now sums both credits.
      expect(job.nativeAmount).toBe(2_000);
      expect(job.nativeAsset).toBe("usdc");
      expect(job.paymentRail).toBe("x402");
      // Most-recent credit's hash wins — single-row accounting follows
      // the same "most recent" semantics as paymentRail.
      expect(job.paymentTxHash).toBe("0xmidjob");
    });

    it("accumulates nativeAmount + updates paymentTxHash across upfront + mid-job mpp credits", async () => {
      const { mpp } = makeMppx();

      // Upfront credit.
      const upfrontCred = await makeTempoCredential(mpp, 1000);
      const upfront = await verifyUpfrontPayment({
        requiredMsats: 1000,
        mppCredential: upfrontCred,
        mpp,
        fxFetcher: stubFx
      });

      // Mid-job credential bound to a fresh challenge.
      const midjobCred = await makeTempoCredential(mpp, 1000);
      const job = makeJob({
        paidMsats: upfront.paidMsats,
        paymentRail: upfront.paymentRail,
        paymentTxHash: upfront.paymentTxHash,
        nativeAmount: upfront.nativeAmount,
        nativeAsset: upfront.nativeAsset,
        pendingPaymentMsats: 1000,
        pendingMppChallengeIds: [midjobCred.challenge.id],
        status: "awaiting-input"
      });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: midjobCred } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(2000);
      // upfront micro-USDC + mid-job micro-USDC (same rail).
      const perCredit = 1_000;
      expect(job.nativeAmount).toBe(perCredit * 2);
      expect(job.nativeAsset).toBe("usdc");
      expect(job.paymentRail).toBe("tempo");
      expect(job.paymentTxHash).toBe(midjobCred.challenge.id);
    });

    // A switch reports the new rail's native amount, rather than mixing rail totals.
    it("resets nativeAmount on a cross-rail switch (x402 upfront → mpp mid-job)", async () => {
      mockVerifyX402.mockResolvedValueOnce({
        verified: true,
        amountMsats: 1000,
        amountUsdcMicro: 1_000,
        txHash: "0xupfront"
      });
      const upfront = await verifyUpfrontPayment({
        requiredMsats: 1000,
        x402Payment: "encoded-payload",
        x402Config: X402_CONFIG,
        priceFiat: { currency: "usd", amountMicro: 1_000 },
        fxFetcher: stubFx
      });

      const { mpp } = makeMppx();
      const midjobCred = await makeTempoCredential(mpp, 1000);
      const job = makeJob({
        paidMsats: upfront.paidMsats,
        paymentRail: upfront.paymentRail,
        paymentTxHash: upfront.paymentTxHash,
        nativeAmount: upfront.nativeAmount,
        nativeAsset: upfront.nativeAsset,
        pendingPaymentMsats: 1000,
        pendingMppChallengeIds: [midjobCred.challenge.id],
        status: "awaiting-input"
      });

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { tempo_credential: midjobCred } },
        { mpp, fxFetcher: stubFx }
      );

      expect(result).toBeNull();
      expect(job.paidMsats).toBe(2000);
      // Accumulator reset to the mpp credit's micro-USDC — NOT
      // 1_000 + micro (the would-be asset-mixed sum if the same-rail guard
      // were dropped).
      expect(job.nativeAmount).toBe(1_000);
      expect(job.nativeAsset).toBe("usdc");
      expect(job.paymentRail).toBe("tempo");
      expect(job.paymentTxHash).toBe(midjobCred.challenge.id);
    });
  });

  describe("Cashu mid-flow payments rejected", () => {
    it("rejects unlocked Cashu tokens with cashu_not_p2pk_locked", async () => {
      const job = makeJob();

      const result = await processIncomingPayment(
        job,
        { type: "payment", content: { cashu_token: "cashuAeyJ..." } },
        { mints: ["https://mint.example.com"] }
      );

      expect(result?.body.error).toBe("cashu_not_p2pk_locked");
      expect(result?.status).toBe(402);
      // the "dvm wallet init" hint now lives in the copy table, and
      // the body carries display + retryable alongside it.
      expect(result?.body.hint).toMatch(/dvm wallet init/);
      expect(typeof result?.body.display).toBe("string");
      expect(result?.body.retryable).toBe(false);
      expect(job.paidMsats).toBe(0);
    });
  });
});
