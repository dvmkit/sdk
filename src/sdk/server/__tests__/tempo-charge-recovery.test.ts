/**
 * A node can include a charge transaction and still fail the synchronous send.
 * These cases fake only the RPC transport; mppx's verifier and the SDK's
 * broadcast wrapper run for real.
 */
import { Credential, Store } from "mppx";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FxFetcher } from "../../pricing/index";
import {
  createMppFromOpts,
  readTempoChargePayer,
  TEMPO_CHARGE_RECOVERY_BUDGET_MS,
  TempoChargeSettlementError,
} from "../mpp-setup";
import { verifyUpfrontPayment } from "../payment";
import { paymentFailureFields } from "../payment-diagnostics";

const PAYER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const SPONSOR = privateKeyToAccount(`0x${"22".repeat(32)}`);
const RECIPIENT = `0x${"33".repeat(20)}` as const;
const TOKEN = `0x${"44".repeat(20)}` as const;
const OTHER = `0x${"55".repeat(20)}` as const;
const PRICE_MICRO = 100_000;
const META = { path: "/v1/job", nonce: "test-charge" };

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-07-30T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

/** The challenge-bound memo an mppx client attaches to its transfer. */
function paymentMemo(challenge: { id: string; realm: string }): Hex {
  return `0x${keccak256(toHex("mpp")).slice(2, 10)}01${keccak256(toHex(challenge.realm)).slice(2, 22)}${"00".repeat(10)}${keccak256(toHex(challenge.id)).slice(2, 16)}`;
}

type Lookup = "found" | "none" | "error" | "stalled";

interface Chain {
  /** What `eth_sendRawTransactionSync` does once the node has the transaction. */
  send: "throws" | "confirms";
  receipt: Lookup;
  /** Whether `eth_getTransactionByHash` knows the transaction. */
  pooled: boolean;
  status?: Hex;
  token?: Hex;
  to?: Hex;
  amount?: number;
  memo?: Hex;
  simulation?: "fails";
}

function tempoServer(store: Store.AtomicStore | null = Store.memory()) {
  return createMppFromOpts({
    tempoRecipient: RECIPIENT,
    realm: "payments.example.com",
    ...(store && { tempoCharge: { store } }),
  }, {
    DVMKIT_TEMPO_SECRET_KEY: "42".repeat(32),
    DVMKIT_TEMPO_CURRENCY: TOKEN,
  })!;
}

async function signedCharge(
  mpp: ReturnType<typeof tempoServer>, options: { feePayer?: boolean; path?: string } = {}
) {
  const meta = { ...META, ...(options.path && { path: options.path }) };
  const challenge = await mpp.issueChallenge("tempo", "charge", { amount: "0.10", meta });
  const memo = paymentMemo(challenge);
  const signature = await PAYER.signTransaction({
    type: "tempo",
    chainId: 4217,
    nonce: 1,
    gas: 200_000n,
    maxFeePerGas: 20_000_000_000n,
    maxPriorityFeePerGas: 1n,
    calls: [{
      to: TOKEN,
      data: encodeFunctionData({
        abi: Abis.tip20, functionName: "transferWithMemo", args: [RECIPIENT, BigInt(PRICE_MICRO), memo],
      }),
    }],
    ...(options.feePayer && { feePayer: SPONSOR }),
  }, { serializer: Transaction.serialize });
  const credential = Credential.serialize(Credential.from({
    challenge,
    payload: { type: "transaction", signature },
    source: `did:pkh:eip155:4217:${PAYER.address}`,
  }));
  return { credential, memo, hash: keccak256(signature), meta };
}

/** Routes JSON-RPC by method and counts what the SDK asked the node. */
function fakeRpc(chain: Chain, charge: { memo: Hex; hash: Hex }) {
  const calls: Record<string, number> = {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rpc = JSON.parse(input instanceof Request ? await input.text() : String(init?.body)) as {
      id: number; method: string; params: unknown[];
    };
    calls[rpc.method] = (calls[rpc.method] ?? 0) + 1;
    const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    const receipt = {
      status: chain.status ?? "0x1",
      transactionHash: charge.hash,
      from: PAYER.address,
      to: TOKEN,
      logs: chain.status === "0x0" ? [] : [{
        address: chain.token ?? TOKEN,
        topics: encodeEventTopics({
          abi: Abis.tip20,
          eventName: "TransferWithMemo",
          args: { from: PAYER.address, to: chain.to ?? RECIPIENT, memo: chain.memo ?? charge.memo },
        }),
        data: encodeAbiParameters([{ type: "uint256" }], [BigInt(chain.amount ?? PRICE_MICRO)]),
        logIndex: "0x0",
      }],
    };
    switch (rpc.method) {
      case "eth_call":
        if (chain.simulation === "fails") return new Response("simulation unavailable", { status: 500 });
        return answer("0x");
      case "eth_sendRawTransactionSync":
        expect(keccak256(rpc.params[0] as Hex)).toBe(charge.hash);
        if (chain.send === "throws") return new Response("upstream timed out", { status: 504 });
        return answer(receipt);
      case "eth_getTransactionReceipt":
        expect(rpc.params).toEqual([charge.hash]);
        if (chain.receipt === "stalled") return new Promise<Response>(() => undefined);
        if (chain.receipt === "error") return new Response("lookup unavailable", { status: 500 });
        return answer(chain.receipt === "found" ? receipt : null);
      case "eth_getTransactionByHash":
        expect(rpc.params).toEqual([charge.hash]);
        return answer(chain.pooled ? { hash: charge.hash, blockNumber: null } : null);
      default:
        throw new Error(`Unexpected test RPC method: ${rpc.method}`);
    }
  }));
  return calls;
}

/** Runs past the recovery budget and reports how the broadcast ended. */
async function outcomeOf<T>(work: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  const settled = work.then((value) => ({ value }), (error: unknown) => ({ error }));
  await vi.advanceTimersByTimeAsync(TEMPO_CHARGE_RECOVERY_BUDGET_MS);
  const result = await Promise.race([settled, Promise.resolve("pending" as const)]);
  if (result === "pending") throw new Error("The broadcast outlived its recovery budget");
  return result;
}

function broadcast(mpp: ReturnType<typeof tempoServer>, charge: { credential: string; meta: typeof META }) {
  return mpp.broadcastCredential(charge.credential, { request: { amount: "0.10" }, meta: charge.meta });
}

describe("a Tempo charge whose broadcast call fails", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["a self-paid transaction", {}],
    // The SDK configures no fee payer, so a transaction that names one is
    // still sent exactly as the caller signed it.
    ["a transaction naming a fee payer", { feePayer: true }],
  ])("settles %s from the receipt and keeps its hash consumed", async (_, options) => {
    const mpp = tempoServer();
    const charge = await signedCharge(mpp, options);
    const chain: Chain = { send: "throws", receipt: "found", pooled: true };
    const calls = fakeRpc(chain, charge);

    const settled = await outcomeOf(broadcast(mpp, charge));

    expect(settled).toEqual({ value: expect.objectContaining({ status: "success", reference: charge.hash }) });
    if (!("value" in settled)) return;
    expect(readTempoChargePayer(settled.value)).toBe(PAYER.address.toLowerCase());

    chain.send = "confirms";
    const replay = await outcomeOf(broadcast(mpp, charge));
    expect(replay).toHaveProperty("error");
    expect(calls.eth_sendRawTransactionSync).toBe(1);
  });

  it.each([
    ["a reverted transaction", { status: "0x0" }, "rejected_on_chain", "settlement_failed"],
    ["a transfer to another recipient", { to: OTHER }, "rejected_on_chain", "settlement_failed"],
    ["a transfer of another amount", { amount: PRICE_MICRO - 1 }, "rejected_on_chain", "settlement_failed"],
    ["a transfer of another token", { token: OTHER }, "rejected_on_chain", "settlement_failed"],
    ["a transfer bound to another challenge", {
      memo: paymentMemo({ id: "another-challenge", realm: "payments.example.com" }),
    }, "rejected_on_chain", "settlement_failed"],
    ["a failing receipt lookup", { receipt: "error" }, "unconfirmed", "settlement_unconfirmed"],
    ["a receipt lookup that never answers", { receipt: "stalled" }, "unconfirmed", "settlement_unconfirmed"],
    ["a transaction still waiting in the pool", { receipt: "none" }, "unconfirmed", "settlement_unconfirmed"],
  ] as const)("refuses %s and keeps the hash consumed", async (_, fault, outcome, category) => {
    const mpp = tempoServer();
    const charge = await signedCharge(mpp);
    const chain: Chain = { send: "throws", receipt: "found", pooled: true, ...fault };
    const calls = fakeRpc(chain, charge);

    const refused = await outcomeOf(broadcast(mpp, charge));

    expect(refused).toEqual({ error: expect.any(TempoChargeSettlementError) });
    if (!("error" in refused)) return;
    expect(refused.error).toMatchObject({ outcome });
    expect(paymentFailureFields(refused.error)).toMatchObject({ failure_category: category });

    Object.assign(chain, { send: "confirms", receipt: "found", status: "0x1", to: RECIPIENT });
    expect(await outcomeOf(broadcast(mpp, charge))).toHaveProperty("error");
    expect(calls.eth_sendRawTransactionSync).toBe(1);
  });

  it("releases the hash of a transaction the node never took, so the same credential pays on retry", async () => {
    const mpp = tempoServer();
    const charge = await signedCharge(mpp);
    const chain: Chain = { send: "throws", receipt: "none", pooled: false };
    const calls = fakeRpc(chain, charge);

    const refused = await outcomeOf(broadcast(mpp, charge));
    expect(refused).toEqual({ error: expect.objectContaining({ outcome: "not_broadcast" }) });

    chain.send = "confirms";
    const retried = await outcomeOf(broadcast(mpp, charge));
    expect(retried).toEqual({ value: expect.objectContaining({ status: "success", reference: charge.hash }) });
    expect(calls.eth_sendRawTransactionSync).toBe(2);
  });

  it("ends unconfirmed at the budget when the replay store never finishes releasing the hash", async () => {
    const store = Store.memory();
    const mpp = tempoServer({ ...store, delete: () => new Promise<never>(() => undefined) });
    const charge = await signedCharge(mpp);
    fakeRpc({ send: "throws", receipt: "none", pooled: false }, charge);

    const refused = await outcomeOf(broadcast(mpp, charge));

    expect(refused).toEqual({ error: expect.objectContaining({ outcome: "unconfirmed" }) });
  });

  it("keeps the hash consumed when no replay store is configured to release it from", async () => {
    const mpp = tempoServer(null);
    const charge = await signedCharge(mpp);
    const chain: Chain = { send: "throws", receipt: "none", pooled: false };
    const calls = fakeRpc(chain, charge);

    const refused = await outcomeOf(broadcast(mpp, charge));
    expect(refused).toEqual({ error: expect.objectContaining({ outcome: "unconfirmed" }) });

    chain.send = "confirms";
    expect(await outcomeOf(broadcast(mpp, charge))).toHaveProperty("error");
    expect(calls.eth_sendRawTransactionSync).toBe(1);
  });

  it("leaves a failure before any send to the verifier, without consulting the chain", async () => {
    const mpp = tempoServer();
    const charge = await signedCharge(mpp);
    const calls = fakeRpc({ send: "confirms", receipt: "found", pooled: true, simulation: "fails" }, charge);

    const refused = await outcomeOf(broadcast(mpp, charge));

    expect(refused).toHaveProperty("error");
    expect(refused).not.toEqual({ error: expect.any(TempoChargeSettlementError) });
    expect(calls).not.toHaveProperty("eth_sendRawTransactionSync");
    expect(calls).not.toHaveProperty("eth_getTransactionReceipt");
  });

  describe.each(["/v1/job", "/v1/credit"])("through upfront payment on %s", (path) => {
    const upfront = (mpp: ReturnType<typeof tempoServer>, credential: string) => verifyUpfrontPayment({
      requiredMsats: PRICE_MICRO,
      priceFiat: { currency: "usd", amountMicro: PRICE_MICRO },
      mpp,
      mppCredential: credential,
      resourcePath: path,
      fxFetcher: stubFx,
    });

    it("accepts the payment the receipt proves, under its transaction hash", async () => {
      const mpp = tempoServer();
      const charge = await signedCharge(mpp, { path });
      fakeRpc({ send: "throws", receipt: "found", pooled: true }, charge);

      const paid = await outcomeOf(upfront(mpp, charge.credential));

      expect(paid).toEqual({ value: expect.objectContaining({
        paidMsats: PRICE_MICRO, paymentRail: "tempo", paymentTransactionHash: charge.hash,
      }) });
    });

    it("tells the caller not to pay again while the outcome is unknown", async () => {
      const mpp = tempoServer();
      const charge = await signedCharge(mpp, { path });
      fakeRpc({ send: "throws", receipt: "error", pooled: true }, charge);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const refused = await outcomeOf(upfront(mpp, charge.credential));

      expect(refused).toEqual({ value: expect.objectContaining({ paidMsats: 0 }) });
      if (!("value" in refused)) return;
      expect(refused.value.error).toMatchObject({
        status: 402,
        body: { error: "payment_invalid", retryable: false, rail: "tempo", reason: "settlement_unconfirmed" },
      });
      expect(warn.mock.calls.map(([row]) => JSON.parse(String(row)) as unknown)).toContainEqual(
        expect.objectContaining({
          event: "tempo_credential_rejected",
          failure_category: "settlement_unconfirmed",
          failure_stage: "verifier_broadcast",
        })
      );
    });

    it("invites a retry of the same payment once its hash is released", async () => {
      const mpp = tempoServer();
      const charge = await signedCharge(mpp, { path });
      const chain: Chain = { send: "throws", receipt: "none", pooled: false };
      fakeRpc(chain, charge);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);

      const refused = await outcomeOf(upfront(mpp, charge.credential));
      expect(refused).toEqual({ value: expect.objectContaining({
        paidMsats: 0,
        error: expect.objectContaining({
          body: expect.objectContaining({ retryable: true, rail: "tempo", reason: "not_broadcast" }),
        }),
      }) });

      chain.send = "confirms";
      const retried = await outcomeOf(upfront(mpp, charge.credential));
      expect(retried).toEqual({ value: expect.objectContaining({
        paidMsats: PRICE_MICRO, paymentTransactionHash: charge.hash,
      }) });
    });
  });
});
