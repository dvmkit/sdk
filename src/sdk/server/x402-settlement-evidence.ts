import {
  BATCH_SETTLEMENT_ADDRESS,
  ERC3009_DEPOSIT_COLLECTOR_ADDRESS,
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
} from "@x402/evm";
import {
  type AbiEvent,
  type Address,
  createPublicClient,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  type Hex,
  http,
  isAddressEqual,
  keccak256,
  parseAbi,
  parseAbiItem,
} from "viem";

import { resolveRpcOverride } from "../../lib/payment-rails/rpc";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import type { X402SettlementIntent } from "./x402-channel-store";
import type {
  X402ExactSettlementChainEvidence,
  X402ExactSettlementEvidenceReader,
} from "./x402-exact-settlement";
import type { X402ExactSettlementIntent } from "./x402-exact-settlement-store";

/** Exact successful chain action recovered for one ambiguous settlement attempt. */
export interface X402SettlementChainEvidence {
  transaction: string;
  amount: string;
}

/** Chain boundary used to bookmark and reconcile irreversible x402 submissions. */
export interface X402SettlementEvidenceReader extends X402ExactSettlementEvidenceReader {
  getBlockNumber(): Promise<bigint>;
  findAppliedSettlement(
    intent: X402SettlementIntent
  ): Promise<X402SettlementChainEvidence | undefined>;
}

/** Minimal viem-compatible read surface used by exact settlement reconciliation. */
export interface X402SettlementEvidenceClient {
  getBlockNumber(args?: { cacheTime?: number }): Promise<bigint>;
  getLogs(args: EvidenceLogQuery & { fromBlock: bigint; toBlock: bigint }): Promise<EvidenceLog[]>;
  getTransaction(args: { hash: Hex }): Promise<{ to: Address | null; input: Hex }>;
}

const AUTHORIZATION_USED_EVENT = parseAbiItem(
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)"
);
const DEPOSITED_EVENT = parseAbiItem(
  "event Deposited(bytes32 indexed channelId, address indexed sender, uint128 amount, uint128 newBalance)"
);
const REFUNDED_EVENT = parseAbiItem(
  "event Refunded(bytes32 indexed channelId, address indexed sender, uint128 amount)"
);
const BATCH_SETTLEMENT_CALL_ABI = parseAbi([
  "function deposit((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount,address collector,bytes collectorData)",
  "function refundWithSignature((address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt) config,uint128 amount,uint256 nonce,bytes receiverAuthorizerSignature)",
  "function multicall(bytes[] data) returns (bytes[] results)",
]);
const EXACT_SETTLEMENT_CALL_ABI = parseAbi([
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)",
]);
const LOG_CHUNK_SIZE = 10_000n;

/** Where the reconciliation reader reads chain state from. */
export interface X402SettlementEvidenceEndpoint {
  /** CAIP-2 chain id the settlements being reconciled live on. */
  network: string;
  /** Operator RPC override; falls back to viem's bundled public endpoint. */
  rpcUrl?: string;
}

export async function createX402SettlementEvidenceReader(
  endpoint: X402SettlementEvidenceEndpoint
): Promise<X402SettlementEvidenceReader> {
  const client = await createX402SettlementEvidenceClient(endpoint);
  return createX402SettlementEvidenceReaderFromClient(client);
}

/**
 * Build the viem client the reader reads through.
 *
 * The chain is derived from the CAIP-2 network rather than pinned, so a
 * settlement is always reconciled against the chain it was submitted on — a
 * pinned testnet chain would silently find no evidence for every mainnet
 * settlement and leave it unrecoverable.
 */
export async function createX402SettlementEvidenceClient(
  endpoint: X402SettlementEvidenceEndpoint
): Promise<X402SettlementEvidenceClient> {
  const spec = x402NetworkByCaip2(endpoint.network);
  if (!spec) {
    throw new Error(
      `x402 settlement reconciliation has no chain configured for ${endpoint.network}`
    );
  }
  const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
  const chain = chains[spec.viemChain] as Parameters<typeof createPublicClient>[0]["chain"];
  const { url } = resolveRpcOverride(endpoint.rpcUrl, chain?.rpcUrls.default.http[0]);
  const client = createPublicClient({ chain, transport: http(url) });
  return client as unknown as X402SettlementEvidenceClient;
}

export function createX402SettlementEvidenceReaderFromClient(
  client: X402SettlementEvidenceClient
): X402SettlementEvidenceReader {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    findAppliedSettlement: (intent) => findAppliedSettlement(client, intent),
    findExactPayment: (intent) => findExactPayment(client, intent),
  };
}

async function findExactPayment(
  client: X402SettlementEvidenceClient,
  intent: X402ExactSettlementIntent
): Promise<X402ExactSettlementChainEvidence | undefined> {
  if (intent.submissionBlock === undefined) return undefined;
  const fromBlock = BigInt(intent.submissionBlock);
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  if (fromBlock > toBlock) return undefined;
  const logs = await getLogsInChunks(
    client,
    {
      address: getAddress(intent.asset),
      event: AUTHORIZATION_USED_EVENT,
      args: { authorizer: getAddress(intent.from), nonce: intent.nonce as Hex },
    },
    fromBlock,
    toBlock
  );
  for (const log of logs) {
    if (!log.transactionHash) continue;
    const transaction = await client.getTransaction({ hash: log.transactionHash });
    if (!transaction.to || !isAddressEqual(transaction.to, getAddress(intent.asset))) continue;
    try {
      const decoded = decodeFunctionData({
        abi: EXACT_SETTLEMENT_CALL_ABI,
        data: transaction.input,
      });
      const [from, to, value, validAfter, validBefore, nonce] = decoded.args;
      if (
        isAddressEqual(from, getAddress(intent.from)) &&
        isAddressEqual(to, getAddress(intent.to)) &&
        value === BigInt(intent.value) &&
        validAfter === BigInt(intent.validAfter) &&
        validBefore === BigInt(intent.validBefore) &&
        nonce.toLowerCase() === intent.nonce.toLowerCase()
      ) {
        return { transaction: log.transactionHash, amount: value.toString() };
      }
    } catch {
      // A matching AuthorizationUsed log from a different token entry point is
      // not enough evidence to book this exact payment.
    }
  }
  return undefined;
}

async function findAppliedSettlement(
  client: X402SettlementEvidenceClient,
  intent: X402SettlementIntent
): Promise<X402SettlementChainEvidence | undefined> {
  if (intent.submissionBlock === undefined) return undefined;
  const fromBlock = BigInt(intent.submissionBlock);
  // The bookmark is read immediately before submission, so viem's default
  // block-number cache can still contain that pre-submission height when an
  // operator asks for evidence. A cached upper bound turns a mined settlement
  // into a definitive absence until the polling window expires.
  const toBlock = await client.getBlockNumber({ cacheTime: 0 });
  if (fromBlock > toBlock) return undefined;
  const raw = intent.payload.payload;
  if (isBatchSettlementDepositPayload(raw)) {
    const authorization = raw.deposit.authorization.erc3009Authorization;
    if (!authorization) return undefined;
    const authorizationNonce = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }],
        [raw.voucher.channelId, BigInt(authorization.salt)]
      )
    );
    const [authorizationLogs, depositLogs] = await Promise.all([
      getLogsInChunks(
        client,
        {
          address: getAddress(intent.requirements.asset),
          event: AUTHORIZATION_USED_EVENT,
          args: {
            authorizer: getAddress(raw.channelConfig.payer),
            nonce: authorizationNonce,
          },
        },
        fromBlock,
        toBlock
      ),
      getLogsInChunks(
        client,
        {
          address: getAddress(BATCH_SETTLEMENT_ADDRESS),
          event: DEPOSITED_EVENT,
          args: { channelId: raw.voucher.channelId },
        },
        fromBlock,
        toBlock
      ),
    ]);
    const authorizationTransactions = new Set(
      authorizationLogs.flatMap((log) => (log.transactionHash ? [log.transactionHash] : []))
    );
    for (const log of depositLogs) {
      const transaction = log.transactionHash;
      if (!transaction || !authorizationTransactions.has(transaction)) continue;
      const amount = logAmount(log);
      if (amount !== BigInt(raw.deposit.amount)) continue;
      if (await transactionMatchesDeposit(client, transaction, intent)) {
        return { transaction, amount: amount.toString() };
      }
    }
    return undefined;
  }

  if (isBatchSettlementRefundPayload(raw)) {
    const refundLogs = await getLogsInChunks(
      client,
      {
        address: getAddress(BATCH_SETTLEMENT_ADDRESS),
        event: REFUNDED_EVENT,
        args: { channelId: raw.voucher.channelId },
      },
      fromBlock,
      toBlock
    );
    for (const log of refundLogs) {
      const transaction = log.transactionHash;
      const amount = logAmount(log);
      if (!transaction || amount === undefined) continue;
      if (await transactionMatchesRefund(client, transaction, intent)) {
        return { transaction, amount: amount.toString() };
      }
    }
  }
  return undefined;
}

interface EvidenceLog {
  transactionHash: Hex | null;
  args?: unknown;
}

interface EvidenceLogQuery {
  address: Address;
  event: AbiEvent;
  args: Record<string, unknown>;
}

async function getLogsInChunks(
  client: X402SettlementEvidenceClient,
  query: EvidenceLogQuery,
  fromBlock: bigint,
  toBlock: bigint
): Promise<EvidenceLog[]> {
  const logs: EvidenceLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK_SIZE) {
    const end = start + LOG_CHUNK_SIZE - 1n < toBlock ? start + LOG_CHUNK_SIZE - 1n : toBlock;
    logs.push(...(await client.getLogs({ ...query, fromBlock: start, toBlock: end })));
  }
  return logs;
}

async function transactionMatchesDeposit(
  client: X402SettlementEvidenceClient,
  transactionHash: Hex,
  intent: X402SettlementIntent
): Promise<boolean> {
  const transaction = await client.getTransaction({ hash: transactionHash });
  if (!transaction.to || !isAddressEqual(transaction.to, BATCH_SETTLEMENT_ADDRESS)) return false;
  try {
    const decoded = decodeFunctionData({ abi: BATCH_SETTLEMENT_CALL_ABI, data: transaction.input });
    if (decoded.functionName !== "deposit") return false;
    const [config, amount, collector] = decoded.args;
    const raw = intent.payload.payload;
    return (
      isBatchSettlementDepositPayload(raw) &&
      channelConfigMatches(config, raw.channelConfig) &&
      amount === BigInt(raw.deposit.amount) &&
      isAddressEqual(collector, ERC3009_DEPOSIT_COLLECTOR_ADDRESS)
    );
  } catch {
    return false;
  }
}

async function transactionMatchesRefund(
  client: X402SettlementEvidenceClient,
  transactionHash: Hex,
  intent: X402SettlementIntent
): Promise<boolean> {
  const transaction = await client.getTransaction({ hash: transactionHash });
  if (!transaction.to || !isAddressEqual(transaction.to, BATCH_SETTLEMENT_ADDRESS)) return false;
  return calldataMatchesRefund(transaction.input, intent);
}

function calldataMatchesRefund(data: Hex, intent: X402SettlementIntent): boolean {
  try {
    const decoded = decodeFunctionData({ abi: BATCH_SETTLEMENT_CALL_ABI, data });
    if (decoded.functionName === "multicall") {
      const [calls] = decoded.args;
      return calls.some((call) => calldataMatchesRefund(call, intent));
    }
    if (decoded.functionName !== "refundWithSignature") return false;
    const raw = intent.payload.payload;
    if (!isBatchSettlementRefundPayload(raw)) return false;
    const [config, amount, nonce] = decoded.args;
    // The channel as it stood when this settlement was submitted. `channelBefore`
    // is the fallback for rows an older build wrote: it is a *pre-refresh*
    // mirror, and the facilitator sizes and signs the refund from live state, so
    // whenever the mirror was stale (a caller-broadcast timed finalize, a direct
    // on-chain deposit) both comparisons below missed and a refund that had
    // settled was reported as one that never happened — a definitive absence
    // that sends the caller into a second broadcast.
    const submitted = intent.channelAtSubmission ?? intent.channelBefore;
    // Upstream pins `voucher.maxClaimableAmount === chargedCumulativeAmount`
    // before it settles, so the voucher carries the base the payout was
    // derived from and `balance − base` is the amount that actually moved.
    // Deriving it from the intent's own `chargedCumulativeAmount` instead
    // reconstructs the *pre-revocation* base, which is short by exactly the
    // drained balance — so this never matched and a refund that settled on
    // chain but lost its response stayed unrecoverable. A payload
    // that names its own `amount` overrides the remainder, because that is what
    // the facilitator settles verbatim.
    const expectedAmount =
      raw.amount !== undefined
        ? BigInt(raw.amount)
        : BigInt(submitted.balance) - BigInt(raw.voucher.maxClaimableAmount);
    return (
      channelConfigMatches(config, raw.channelConfig) &&
      amount === expectedAmount &&
      nonce === BigInt(submitted.refundNonce)
    );
  } catch {
    return false;
  }
}

function channelConfigMatches(
  actual: {
    payer: Address;
    payerAuthorizer: Address;
    receiver: Address;
    receiverAuthorizer: Address;
    token: Address;
    withdrawDelay: number;
    salt: Hex;
  },
  expected: X402SettlementIntent["channelBefore"]["channelConfig"]
): boolean {
  return (
    isAddressEqual(actual.payer, expected.payer) &&
    isAddressEqual(actual.payerAuthorizer, expected.payerAuthorizer) &&
    isAddressEqual(actual.receiver, expected.receiver) &&
    isAddressEqual(actual.receiverAuthorizer, expected.receiverAuthorizer) &&
    isAddressEqual(actual.token, expected.token) &&
    BigInt(actual.withdrawDelay) === BigInt(expected.withdrawDelay) &&
    actual.salt.toLowerCase() === expected.salt.toLowerCase()
  );
}

function logAmount(log: EvidenceLog): bigint | undefined {
  const value =
    typeof log.args === "object" && log.args !== null
      ? (log.args as Record<string, unknown>).amount
      : undefined;
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}
