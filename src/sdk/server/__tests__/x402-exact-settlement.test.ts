import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodePayment, X402_V1_VERSION } from "../../../lib/x402/spec";
import type { X402Config } from "../../../lib/x402/types";
import {
  type X402ExactSettlementEvidenceReader,
  X402ExactSettlementServer,
} from "../x402-exact-settlement";
import {
  MemoryX402ExactSettlementStore,
  X402ExactIntentConflictError,
  type X402ExactSettlementEffect,
} from "../x402-exact-settlement-store";

const CONFIG: X402Config = {
  network: "eip155:8453",
  asset: "0x1111111111111111111111111111111111111111",
  payTo: "0x2222222222222222222222222222222222222222",
  facilitator: "https://facilitator.test",
};
const TRANSACTION = `0x${"33".repeat(32)}`;

function header(nonce = `0x${"44".repeat(32)}`, value = "1000"): string {
  return encodePayment({
    x402Version: X402_V1_VERSION,
    scheme: "exact",
    network: CONFIG.network,
    payload: {
      signature: `0x${"55".repeat(65)}`,
      authorization: {
        from: "0x6666666666666666666666666666666666666666",
        to: CONFIG.payTo,
        value,
        validAfter: "0",
        validBefore: "9999999999",
        nonce,
      },
    },
  });
}

function evidence(transaction?: string): X402ExactSettlementEvidenceReader {
  return {
    getBlockNumber: vi.fn(async () => 100n),
    findExactPayment: vi.fn(async (intent) =>
      transaction ? { transaction, amount: intent.value } : undefined
    ),
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function accept<T>(
  server: X402ExactSettlementServer,
  commit: (txHash: string) => Promise<T>,
  paymentHeader = header(),
  opts: { requiredUsdcMicro?: bigint; effect?: X402ExactSettlementEffect } = {}
) {
  return server.accept({
    paymentHeader,
    config: CONFIG,
    requiredUsdcMicro: opts.requiredUsdcMicro ?? 1000n,
    resource: "/v1/credit",
    btcUsdRate: 100_000,
    dvmId: "dvm-1",
    effect: opts.effect,
    commit: async (receipt) => commit(receipt.txHash ?? ""),
  });
}

function jobEffect(jobId: string): X402ExactSettlementEffect {
  return {
    priceFiat: { currency: "usd", amountMicro: 1000 },
    requiredMsats: 1000,
    callerId: "caller-1",
    dvmId: "dvm-1",
    jobId,
    jobAdmission: {
      requestFingerprint: "request-fingerprint",
      authFingerprint: "caller-auth-fingerprint",
    },
    drawBasis: false,
    ttlMs: 60_000,
    paidMsats: 1000,
    fundedMicro: 1000,
    nativeAmount: 1000,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("durable exact x402 settlement", () => {
  it("lets concurrent presentations submit and finalize the authorization once", async () => {
    const store = new MemoryX402ExactSettlementStore();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/verify")) return response({ isValid: true });
      if (url.endsWith("/settle")) {
        await Promise.resolve();
        return response({ success: true, transaction: TRANSACTION });
      }
      throw new Error(`unexpected facilitator URL ${url}`);
    });
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });
    const commit = vi.fn(async () => "booked");

    const results = await Promise.all([accept(server, commit), accept(server, commit)]);

    expect(results.some((result) => result.outcome === "accepted")).toBe(true);
    expect(results.every((result) => result.outcome !== "rejected")).toBe(true);
    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(1);
    expect(commit).toHaveBeenCalledTimes(1);
    const [intent] = await store.list({ dvmId: "dvm-1", limit: 10, includeResolved: true });
    await store.recordOutcome({
      dvmId: "dvm-1",
      intentId: intent.id,
      status: "ambiguous",
      outcome: "timeout",
      detail: "late facilitator response",
    });
    expect((await store.get("dvm-1", intent.id))?.status).toBe("complete");
  });

  it("retains settlement across a local commit failure and retries without settling again", async () => {
    const store = new MemoryX402ExactSettlementStore();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });
    const commit = vi
      .fn<(txHash: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce("booked");

    await expect(accept(server, commit)).rejects.toThrow("database unavailable");
    await expect(accept(server, commit)).resolves.toMatchObject({
      outcome: "accepted",
      committed: "booked",
      replayed: false,
      receipt: { txHash: TRANSACTION },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(
      (await store.list({ dvmId: "dvm-1", limit: 10, includeResolved: true }))[0]
    ).toMatchObject({ status: "complete", transaction: TRANSACTION });
  });

  it("rejects a same-nonce retry whose durable authorization binding changed", async () => {
    const store = new MemoryX402ExactSettlementStore();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });

    await expect(
      accept(server, async () => {
        throw new Error("database unavailable");
      })
    ).rejects.toThrow("database unavailable");
    const largerCommit = vi.fn(async () => "wrong amount booked");
    await expect(
      accept(server, largerCommit, header(undefined, "2000"), { requiredUsdcMicro: 2000n })
    ).rejects.toBeInstanceOf(X402ExactIntentConflictError);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(largerCommit).not.toHaveBeenCalled();
  });

  it("resubmits the same authorization after a crash before the facilitator call", async () => {
    class CrashBeforeSubmitStore extends MemoryX402ExactSettlementStore {
      private crash = true;

      override async markSubmitting(
        args: Parameters<MemoryX402ExactSettlementStore["markSubmitting"]>[0]
      ) {
        const claimed = await super.markSubmitting(args);
        if (this.crash) {
          this.crash = false;
          throw new Error("process crashed before /settle");
        }
        return claimed;
      }
    }

    const store = new CrashBeforeSubmitStore();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });

    await expect(accept(server, async () => "not reached")).rejects.toThrow(
      "process crashed before /settle"
    );
    await expect(accept(server, async () => "booked")).resolves.toMatchObject({
      outcome: "accepted",
      receipt: { txHash: TRANSACTION },
    });

    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(1);
  });

  it("does not let one caller-auth envelope admit two exact payment intents", async () => {
    const store = new MemoryX402ExactSettlementStore();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }))
      .mockResolvedValueOnce(response({ isValid: true }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });

    await expect(
      accept(server, async () => "booked", header(), { effect: jobEffect("job-original") })
    ).resolves.toMatchObject({ outcome: "accepted", admissionPending: true });
    await expect(
      accept(server, async () => "not reached", header(`0x${"77".repeat(32)}`), {
        effect: jobEffect("job-other-payment"),
      })
    ).rejects.toBeInstanceOf(X402ExactIntentConflictError);

    expect(fetch.mock.calls.filter(([input]) => String(input).endsWith("/settle"))).toHaveLength(1);
  });

  it("rejects a settled intent retried with a different job request fingerprint", async () => {
    const store = new MemoryX402ExactSettlementStore();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });

    await expect(
      accept(server, async () => "booked", header(), { effect: jobEffect("job-original") })
    ).resolves.toMatchObject({ outcome: "accepted", admissionPending: true });
    const differentRequest = jobEffect("job-retry-allocation");
    differentRequest.jobAdmission = {
      ...differentRequest.jobAdmission,
      requestFingerprint: "different-request-fingerprint",
    };
    await expect(
      accept(server, async () => "not reached", header(), { effect: differentRequest })
    ).rejects.toBeInstanceOf(X402ExactIntentConflictError);

    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("admits a freshly signed retry after operator-repaired job funding", async () => {
    const store = new MemoryX402ExactSettlementStore();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true, transaction: TRANSACTION }));
    const repair = vi.fn(async () => "funding repaired");
    const server = new X402ExactSettlementServer({ store, evidence: evidence(), repair });
    const originalEffect = jobEffect("job-original");

    await expect(
      accept(
        server,
        async () => {
          throw new Error("job admission unavailable");
        },
        header(),
        { effect: originalEffect }
      )
    ).rejects.toThrow("job admission unavailable");
    const [intent] = await store.list({ dvmId: "dvm-1", limit: 10 });
    await expect(server.reconcile("dvm-1", intent.id)).resolves.toMatchObject({
      intent: { status: "local_committed" },
    });
    await expect(server.reconcile("dvm-1", intent.id)).resolves.toMatchObject({
      intent: { status: "local_committed" },
      replayed: true,
    });

    const retryCommit = vi.fn(async () => "not reached");
    const retryEffect = jobEffect("job-retry-allocation");
    const retryAdmission = retryEffect.jobAdmission;
    if (!retryAdmission) throw new Error("expected a job admission effect");
    retryEffect.jobAdmission = {
      ...retryAdmission,
      authFingerprint: "fresh-caller-auth-fingerprint",
    };
    await expect(
      accept(server, retryCommit, header(), { effect: retryEffect })
    ).resolves.toMatchObject({
      outcome: "accepted",
      replayed: true,
      admissionPending: true,
      effect: { jobId: "job-original" },
    });
    expect(retryCommit).not.toHaveBeenCalled();
    await store.recordOutcome({
      dvmId: "dvm-1",
      intentId: intent.id,
      status: "ambiguous",
      outcome: "timeout",
      detail: "late facilitator response",
    });
    expect((await store.get("dvm-1", intent.id))?.status).toBe("local_committed");
    await server.completeAdmission("dvm-1", intent.id);
    expect((await store.get("dvm-1", intent.id))?.status).toBe("complete");
  });

  it("recovers a timeout-after-settle from chain evidence", async () => {
    const store = new MemoryX402ExactSettlementStore();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const server = new X402ExactSettlementServer({ store, evidence: evidence(TRANSACTION) });

    await expect(accept(server, async () => "booked")).resolves.toMatchObject({
      outcome: "accepted",
      committed: "booked",
      receipt: { txHash: TRANSACTION },
    });
    const [intent] = await store.list({ dvmId: "dvm-1", limit: 10, includeResolved: true });
    expect((await store.attempts("dvm-1", intent.id)).map((attempt) => attempt.outcome)).toEqual([
      "submitting",
      "timeout",
      "success",
    ]);
  });

  it("surfaces a success without transaction reference as economically ambiguous", async () => {
    const store = new MemoryX402ExactSettlementStore();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(response({ success: true }));
    const server = new X402ExactSettlementServer({ store, evidence: evidence() });

    await expect(accept(server, async () => "not reached")).resolves.toMatchObject({
      outcome: "ambiguous",
      reason: "missing_reference",
    });
    const [intent] = await store.list({ dvmId: "dvm-1", limit: 10 });
    expect(intent.status).toBe("ambiguous");
  });

  it("converges authorization_already_used through the original chain transaction", async () => {
    const store = new MemoryX402ExactSettlementStore();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ isValid: true }))
      .mockResolvedValueOnce(
        response({ success: false, errorReason: "authorization_already_used" }, 400)
      );
    const server = new X402ExactSettlementServer({ store, evidence: evidence(TRANSACTION) });

    await expect(accept(server, async () => "booked")).resolves.toMatchObject({
      outcome: "accepted",
      receipt: { txHash: TRANSACTION },
    });
  });
});
