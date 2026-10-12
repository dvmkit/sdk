import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS, ERC3009_DEPOSIT_COLLECTOR_ADDRESS } from "@x402/evm";
import { encodeAbiParameters, encodeFunctionData, type Hex, keccak256, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";

import type { X402SettlementIntent } from "../x402-channel-store";
import type { X402ExactSettlementIntent } from "../x402-exact-settlement-store";
import {
  createX402SettlementEvidenceClient,
  createX402SettlementEvidenceReaderFromClient,
  type X402SettlementEvidenceClient,
} from "../x402-settlement-evidence";

const CHANNEL_ID = `0x${"ab".repeat(32)}` as const;
const TRANSACTION_A = `0x${"11".repeat(32)}` as const;
const TRANSACTION_B = `0x${"22".repeat(32)}` as const;
const TRANSACTION_EXACT = `0x${"33".repeat(32)}` as const;
const CALL_ABI = parseAbi([
  "function deposit((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount,address collector,bytes collectorData)",
  "function refund((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount)",
  "function refundWithSignature((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount,uint256 nonce,bytes receiverAuthorizerSignature)",
  "function multicall(bytes[] data) returns (bytes[] results)",
]);
const EXACT_CALL_ABI = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
]);

describe("x402 settlement chain evidence", () => {
  it("accepts exact-payment evidence only when the event and full authorization calldata match", async () => {
    const intent = exactIntent();
    const wrongRecipient = encodeFunctionData({
      abi: EXACT_CALL_ABI,
      functionName: "transferWithAuthorization",
      args: [
        intent.from as Hex,
        "0x9999999999999999999999999999999999999999",
        BigInt(intent.value),
        BigInt(intent.validAfter),
        BigInt(intent.validBefore),
        intent.nonce as Hex,
        27,
        `0x${"66".repeat(32)}`,
        `0x${"77".repeat(32)}`,
      ],
    });
    const exact = encodeFunctionData({
      abi: EXACT_CALL_ABI,
      functionName: "transferWithAuthorization",
      args: [
        intent.from as Hex,
        intent.to as Hex,
        BigInt(intent.value),
        BigInt(intent.validAfter),
        BigInt(intent.validBefore),
        intent.nonce as Hex,
        27,
        `0x${"66".repeat(32)}`,
        `0x${"77".repeat(32)}`,
      ],
    });
    const client = evidenceClient({
      logs: { AuthorizationUsed: [eventLog(TRANSACTION_A), eventLog(TRANSACTION_EXACT)] },
      transactions: { [TRANSACTION_A]: wrongRecipient, [TRANSACTION_EXACT]: exact },
      transactionTo: {
        [TRANSACTION_A]: intent.asset as Hex,
        [TRANSACTION_EXACT]: intent.asset as Hex,
      },
    });

    const findExactPayment = createX402SettlementEvidenceReaderFromClient(client).findExactPayment;
    if (!findExactPayment) throw new Error("exact evidence reader is missing");
    await expect(findExactPayment(intent)).resolves.toEqual({
      transaction: TRANSACTION_EXACT,
      amount: "1000",
    });
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        address: intent.asset,
        fromBlock: 10n,
        toBlock: 25n,
        args: { authorizer: intent.from, nonce: intent.nonce },
      })
    );
  });

  it("reads an uncached height before scanning for a refund mined after its bookmark", async () => {
    const exactRefund = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "refundWithSignature",
      args: [channelConfig(), 300n, 0n, `0x${"55".repeat(65)}`],
    });
    const client = evidenceClient({
      logs: { Refunded: [eventLog(TRANSACTION_EXACT, 300n)] },
      transactions: { [TRANSACTION_EXACT]: exactRefund },
    });
    vi.mocked(client.getBlockNumber).mockImplementation(async (args) =>
      args?.cacheTime === 0 ? 11n : 10n
    );
    vi.mocked(client.getLogs).mockImplementation(async (query) =>
      query.toBlock >= 11n ? [eventLog(TRANSACTION_EXACT, 300n)] : []
    );

    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(refundIntent())
    ).resolves.toEqual({ transaction: TRANSACTION_EXACT, amount: "300" });
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(client.getLogs).toHaveBeenCalledWith(
      expect.objectContaining({
        fromBlock: 10n,
        toBlock: 11n,
      })
    );
  });

  it("requires the operation's authorization and deposit event in the same exact transaction", async () => {
    const intent = depositIntent();
    const wrongDeposit = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "deposit",
      args: [channelConfig(), 2000n, ERC3009_DEPOSIT_COLLECTOR_ADDRESS, "0x"],
    });
    const exactDeposit = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "deposit",
      args: [channelConfig(), 1000n, ERC3009_DEPOSIT_COLLECTOR_ADDRESS, "0x"],
    });
    const client = evidenceClient({
      logs: {
        AuthorizationUsed: [eventLog(TRANSACTION_A), eventLog(TRANSACTION_EXACT)],
        Deposited: [eventLog(TRANSACTION_B, 1000n), eventLog(TRANSACTION_EXACT, 1000n)],
      },
      transactions: {
        [TRANSACTION_A]: exactDeposit,
        [TRANSACTION_B]: wrongDeposit,
        [TRANSACTION_EXACT]: exactDeposit,
      },
    });

    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(intent)
    ).resolves.toEqual({ transaction: TRANSACTION_EXACT, amount: "1000" });
    const authorizationQuery = vi
      .mocked(client.getLogs)
      .mock.calls.map(([query]) => query)
      .find((query) => query.address.toLowerCase() === channelConfig().token.toLowerCase());
    expect(authorizationQuery).toMatchObject({
      fromBlock: 10n,
      toBlock: 25n,
      args: {
        authorizer: channelConfig().payer,
        nonce: keccak256(
          encodeAbiParameters(
            [{ type: "bytes32" }, { type: "uint256" }],
            [CHANNEL_ID, BigInt(`0x${"77".repeat(32)}`)]
          )
        ),
      },
    });

    const unrelated = evidenceClient({
      logs: {
        AuthorizationUsed: [eventLog(TRANSACTION_A)],
        Deposited: [eventLog(TRANSACTION_B, 1000n)],
      },
      transactions: { [TRANSACTION_A]: exactDeposit, [TRANSACTION_B]: exactDeposit },
    });
    await expect(
      createX402SettlementEvidenceReaderFromClient(unrelated).findAppliedSettlement(intent)
    ).resolves.toBeUndefined();
  });

  it("ignores direct and different signed refunds before accepting the exact refund call", async () => {
    const intent = refundIntent();
    const directRefund = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "refund",
      args: [channelConfig(), 100n],
    });
    const differentRefund = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "refundWithSignature",
      args: [channelConfig(), 200n, 0n, `0x${"44".repeat(65)}`],
    });
    const exactRefund = encodeFunctionData({
      abi: CALL_ABI,
      functionName: "refundWithSignature",
      args: [channelConfig(), 300n, 0n, `0x${"55".repeat(65)}`],
    });
    const unrelated = evidenceClient({
      logs: {
        Refunded: [eventLog(TRANSACTION_A, 100n), eventLog(TRANSACTION_B, 200n)],
      },
      transactions: {
        [TRANSACTION_A]: directRefund,
        [TRANSACTION_B]: differentRefund,
      },
    });
    await expect(
      createX402SettlementEvidenceReaderFromClient(unrelated).findAppliedSettlement(intent)
    ).resolves.toBeUndefined();

    const client = evidenceClient({
      logs: {
        Refunded: [
          eventLog(TRANSACTION_A, 100n),
          eventLog(TRANSACTION_B, 200n),
          eventLog(TRANSACTION_EXACT, 300n),
        ],
      },
      transactions: {
        [TRANSACTION_A]: directRefund,
        [TRANSACTION_B]: differentRefund,
        [TRANSACTION_EXACT]: encodeFunctionData({
          abi: CALL_ABI,
          functionName: "multicall",
          args: [["0x12345678", exactRefund]],
        }),
      },
    });

    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(intent)
    ).resolves.toEqual({ transaction: TRANSACTION_EXACT, amount: "300" });
  });
});

describe("a refund is matched against the state it was submitted from", () => {
  // A stale mirror: the row still says 1000/nonce 0 while the chain had already
  // moved to 1500/nonce 2 (a direct on-chain deposit, or a caller-broadcast
  // timed finalize) by the time this settlement went out. The refresh that runs
  // before every refund put the live pair on the channel, and the facilitator
  // sized and signed the payout from it — 1500 − 700 = 800, at nonce 2.
  const staleMirror = () => {
    const intent = refundIntent();
    return {
      ...intent,
      channelAtSubmission: { ...intent.channelBefore, balance: "1500", refundNonce: 2 },
    };
  };
  const submittedRefund = encodeFunctionData({
    abi: CALL_ABI,
    functionName: "refundWithSignature",
    args: [channelConfig(), 800n, 2n, `0x${"55".repeat(65)}`],
  });

  it("finds a refund the pre-refresh mirror would have reported as absent", async () => {
    const client = evidenceClient({
      logs: { Refunded: [eventLog(TRANSACTION_EXACT, 800n)] },
      transactions: { [TRANSACTION_EXACT]: submittedRefund },
    });

    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(staleMirror())
    ).resolves.toEqual({ transaction: TRANSACTION_EXACT, amount: "800" });

    // Same chain, same intent, minus the submission snapshot: this is the
    // legacy derivation, and it is the definitive "nothing moved" that
    // sent the caller into a second broadcast.
    const { channelAtSubmission: _dropped, ...legacyRow } = staleMirror();
    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(legacyRow)
    ).resolves.toBeUndefined();
  });

  it("matches the payload's own amount when it carries one, over the remainder", async () => {
    // Upstream settles `raw.amount` verbatim when the payload names it, so the
    // remainder this would otherwise compute (1500 − 700 = 800) is not what
    // moved.
    const intent = staleMirror();
    const named = {
      ...intent,
      payload: {
        ...intent.payload,
        payload: { ...(intent.payload.payload as object), amount: "250" },
      } as PaymentPayload,
    };
    const client = evidenceClient({
      logs: { Refunded: [eventLog(TRANSACTION_EXACT, 250n)] },
      transactions: {
        [TRANSACTION_EXACT]: encodeFunctionData({
          abi: CALL_ABI,
          functionName: "refundWithSignature",
          args: [channelConfig(), 250n, 2n, `0x${"55".repeat(65)}`],
        }),
      },
    });

    await expect(
      createX402SettlementEvidenceReaderFromClient(client).findAppliedSettlement(named)
    ).resolves.toEqual({ transaction: TRANSACTION_EXACT, amount: "250" });
  });
});

describe("the evidence reader's chain and endpoint", () => {
  it("derives the chain from the CAIP-2 network instead of pinning one", async () => {
    await expect(client({ network: "eip155:84532" })).resolves.toMatchObject({
      chain: { id: 84532 },
    });
    // The mainnet lift must not silently reconcile against testnet.
    await expect(client({ network: "eip155:8453" })).resolves.toMatchObject({
      chain: { id: 8453 },
    });
  });

  it("takes an RPC override and falls back to the chain's bundled endpoint", async () => {
    await expect(
      client({ network: "eip155:84532", rpcUrl: "https://rpc.example/base-sepolia" })
    ).resolves.toMatchObject({ transport: { url: "https://rpc.example/base-sepolia" } });
    // A blank override is an unset one, not an empty endpoint.
    await expect(client({ network: "eip155:84532", rpcUrl: "  " })).resolves.toMatchObject({
      transport: { url: "https://sepolia.base.org" },
    });
  });

  it("refuses a network it has no chain for rather than guessing", async () => {
    await expect(client({ network: "eip155:1" })).rejects.toThrow(
      "no chain configured for eip155:1"
    );
  });
});

/** The reader's viem client, typed loosely enough to assert chain + transport. */
async function client(endpoint: {
  network: string;
  rpcUrl?: string;
}): Promise<{ chain?: { id: number }; transport: { url?: string } }> {
  const built = await createX402SettlementEvidenceClient(endpoint);
  return built as unknown as { chain?: { id: number }; transport: { url?: string } };
}

function evidenceClient(args: {
  logs: Record<string, { transactionHash: Hex; args?: { amount: bigint } }[]>;
  transactions: Record<string, Hex>;
  transactionTo?: Record<string, Hex>;
}): X402SettlementEvidenceClient {
  return {
    getBlockNumber: vi.fn(async () => 25n),
    getLogs: vi.fn(async (query) => args.logs[query.event.name] ?? []),
    getTransaction: vi.fn(async ({ hash }) => ({
      to: args.transactionTo?.[hash] ?? BATCH_SETTLEMENT_ADDRESS,
      input: args.transactions[hash] ?? "0x",
    })),
  };
}

function exactIntent(): X402ExactSettlementIntent {
  return {
    id: "exact-intent",
    dvmId: "dvm-1",
    resource: "/v1/job",
    network: "eip155:8453",
    asset: "0x1111111111111111111111111111111111111111",
    from: "0x2222222222222222222222222222222222222222",
    to: "0x3333333333333333333333333333333333333333",
    value: "1000",
    validAfter: "0",
    validBefore: "9999999999",
    nonce: `0x${"44".repeat(32)}`,
    fingerprint: "fingerprint",
    status: "ambiguous",
    submissionBlock: "10",
    createdAt: 1,
    updatedAt: 2,
  };
}

function eventLog(transactionHash: Hex, amount?: bigint) {
  return { transactionHash, ...(amount !== undefined ? { args: { amount } } : {}) };
}

function depositIntent(): X402SettlementIntent {
  const requirements = paymentRequirements("100");
  return {
    ...baseIntent(requirements),
    operation: "fund",
    payload: {
      x402Version: 2,
      accepted: requirements,
      payload: {
        type: "deposit",
        channelConfig: channelConfig(),
        voucher: {
          channelId: CHANNEL_ID,
          maxClaimableAmount: "100",
          signature: `0x${"66".repeat(65)}`,
        },
        deposit: {
          amount: "1000",
          authorization: {
            erc3009Authorization: {
              validAfter: "0",
              validBefore: "9999999999",
              salt: `0x${"77".repeat(32)}`,
              signature: `0x${"88".repeat(65)}`,
            },
          },
        },
      },
    } as PaymentPayload,
  };
}

function refundIntent(): X402SettlementIntent {
  const requirements = paymentRequirements("0");
  return {
    ...baseIntent(requirements),
    operation: "refund",
    payload: {
      x402Version: 2,
      accepted: requirements,
      payload: {
        type: "refund",
        channelConfig: channelConfig(),
        // The revoked base a cooperative drain settles against: 900 charged
        // less the 200 of unspent credit. The payer never names an amount —
        // the server refuses a refund payload that does — so the payout is
        // reconstructed here as `balance − base` = 300.
        voucher: {
          channelId: CHANNEL_ID,
          maxClaimableAmount: "700",
          signature: `0x${"99".repeat(65)}`,
        },
      },
    } as PaymentPayload,
  };
}

function baseIntent(requirements: PaymentRequirements) {
  return {
    settlementId: "settlement",
    channelId: CHANNEL_ID,
    effectId: "credit:effect",
    paymentId: `${CHANNEL_ID}:100`,
    requirements,
    channelBefore: {
      channelId: CHANNEL_ID,
      channelConfig: channelConfig(),
      chargedCumulativeAmount: "900",
      signedMaxClaimable: "900",
      signature: `0x${"99".repeat(65)}` as const,
      balance: "1000",
      totalClaimed: "0",
      withdrawRequestedAt: 0,
      refundNonce: 0,
      lastRequestTimestamp: 1,
    },
    submissionBlock: "10",
    status: "submitting" as const,
    createdAt: 1,
    updatedAt: 1,
  };
}

function paymentRequirements(amount: string): PaymentRequirements {
  return {
    scheme: "batch-settlement",
    network: "eip155:84532",
    asset: channelConfig().token,
    amount,
    payTo: channelConfig().receiver,
    maxTimeoutSeconds: 60,
    extra: {},
  };
}

function channelConfig() {
  return {
    payer: "0x1111111111111111111111111111111111111111",
    payerAuthorizer: "0x1111111111111111111111111111111111111111",
    receiver: "0x2222222222222222222222222222222222222222",
    receiverAuthorizer: "0x2222222222222222222222222222222222222222",
    token: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    withdrawDelay: 86_400,
    salt: `0x${"aa".repeat(32)}`,
  } as const;
}
