import type { FacilitatorClient } from "@x402/core/server";
import type {
  AuthorizerSigner,
  AutoSettlementConfig,
  ChannelStorage,
} from "@x402/evm/batch-settlement/server";

/** One native-gas balance observation emitted by an in-process x402 relay. */
export interface X402SelfRelayBalanceObservation {
  address: `0x${string}`;
  network: string;
  balanceWei: bigint;
  lowBalanceWei: bigint;
  checkedAt: number;
}

/** Stable operator-facing classification for an x402 self-relay RPC outage. */
export type X402SelfRelayRpcFailureReason = "authentication" | "rate_limit" | "transport";

/** One health transition emitted by the in-process x402 relay's RPC transport. */
export type X402SelfRelayRpcHealthObservation =
  | {
      address: `0x${string}`;
      network: string;
      status: "healthy";
      checkedAt: number;
    }
  | {
      address: `0x${string}`;
      network: string;
      status: "failed";
      reason: X402SelfRelayRpcFailureReason;
      checkedAt: number;
    };

/** Builder-facing configuration for an in-process x402 batch-settlement relay. */
export interface X402SelfRelayConfig {
  /** Dedicated per-DVM Base EOA private key. Never reuse it across DVM deployments. */
  privateKey: `0x${string}`;
  /** Explicit Base RPC endpoint used for reads and transaction submission. */
  rpcUrl: string;
  /** Balance below which the platform pages. Defaults to 0.001 ETH. */
  lowBalanceWei?: bigint;
  /** Balance probe cadence. Defaults to five minutes. */
  balanceCheckIntervalMs?: number;
  /** Advanced observation hook; platform-hosted DVMs receive an automatic reporter. */
  onBalance?: (observation: X402SelfRelayBalanceObservation) => void | Promise<void>;
  /** Advanced RPC-health hook; platform-hosted DVMs receive an automatic reporter. */
  onRpcHealth?: (observation: X402SelfRelayRpcHealthObservation) => void | Promise<void>;
}

/** Caller-visible reasons an ambiguous x402 settlement could not be reconciled. */
export type X402SettlementReconciliationReason =
  | "settlement_not_on_chain"
  | "chain_unreachable"
  | "settlement_unbookmarked"
  | "facilitator_channel_state_unavailable";

/** Whether a payment error names an ambiguous x402 settlement reconciliation outcome. */
export function isX402SettlementReconciliationReason(
  value: string
): value is X402SettlementReconciliationReason {
  return (
    value === "settlement_not_on_chain" ||
    value === "chain_unreachable" ||
    value === "settlement_unbookmarked" ||
    value === "facilitator_channel_state_unavailable"
  );
}

/** Builder-facing configuration for reusable x402 batch-settlement channels. */
export interface X402BatchSettlementConfig {
  /** Receiver-authorizer signer used when the facilitator advertises none. */
  receiverAuthorizerSigner?: AuthorizerSigner;
  /**
   * Immutable payer withdrawal grace in integer seconds; defaults to 86400 (24 hours).
   * Base Sepolia (`eip155:84532`) permits an explicit value >=900 (15 minutes).
   * All other networks retain the 86400 minimum, including in dev/test mode.
   */
  withdrawDelay?: number;
  /** Freshness window for local voucher verification. */
  onchainStateTtlMs?: number;
  /** Advanced storage override. Production hosts normally receive Postgres automatically. */
  storage?: ChannelStorage;
  /** Claim/settle scheduler override; `false` disables timers for deterministic tests. */
  autoSettlement?: AutoSettlementConfig | false;
  /** Facilitator override used by tests and the future in-process relay. */
  facilitatorClient?: FacilitatorClient;
  /** In-process facilitator for Base channels. Omit to keep hosted-facilitator behavior. */
  selfRelay?: X402SelfRelayConfig;
  /**
   * Chain RPC endpoint used to reconcile ambiguous settlements. Defaults to
   * viem's bundled public endpoint for the configured network, which is rate
   * limited hard enough to refuse channel opens and drains under load.
   */
  rpcUrl?: string;
}

/** API credentials used to authenticate requests to a hosted x402 facilitator. */
export interface X402FacilitatorAuth {
  /** Facilitator API key identifier. */
  keyId: string;
  /** Facilitator API key secret; CDP accepts ES256 PEM and Ed25519 base64 keys. */
  keySecret: string;
}

/**
 * Provider-side x402 configuration — where to receive stablecoin payments,
 * how the dvmkit DVM should advertise the rail on its 402 response.
 */
export interface X402Config {
  payTo: string;
  /** CAIP-2 chain id (`eip155:8453` for Base). */
  network: string;
  /** Asset ticker or contract address. Defaults to USDC for known networks. */
  asset?: string;
  /** Override the default facilitator (`https://x402.org/facilitator`). */
  facilitator?: string;
  /** Optional hosted-facilitator authentication. Omit for public facilitators such as x402.org. */
  facilitatorAuth?: X402FacilitatorAuth;
  /**
   * When true (default), the SDK includes x402 `PaymentRequirements` on the
   * 402 response body alongside MPP's `WWW-Authenticate: Payment` header so
   * x402-speaking agents (Coinbase reference client, thirdweb-ecosystem)
   * can pay. Flip to `false` for MPP-only DVMs.
   */
  dualServe?: boolean;
  /** Human-readable description carried on the `PaymentRequirements`. */
  description?: string;
  /**
   * Reusable v2 batch-settlement channels for `/v1/credit` only. Omit to keep
   * the existing one-payment `exact` rail unchanged.
   */
  batchSettlement?: X402BatchSettlementConfig;
}

/** Exact-protocol generations the configured facilitator currently supports. */
export interface X402ExactVersionSupport {
  v1: boolean;
  v2: boolean;
}

/** Client-side x402 wallet — EVM key pair for signing payments. */
export interface X402Wallet {
  privateKey: string;
  address: string;
  /** CAIP-2 chain id this wallet pays on. */
  network: string;
}

/** Server-side receipt from verifying an x402 payment. */
export interface X402Receipt {
  verified: boolean;
  amountMsats: number;
  /**
   * Native USDC amount in 6-decimal microunits. Captured from the
   * payment payload's `value` field so the platform revenue ledger records
   * the rail-native value without re-deriving it from `amountMsats` + a
   * fresh BTC rate (lossy and racy across the boundary).
   */
  amountUsdcMicro?: number;
  /** On-chain tx hash returned by the facilitator on settlement. */
  txHash?: string;
  /**
   * Base64-encoded `SettleResponse` for the `X-PAYMENT-RESPONSE` header the
   * server attaches to the 2xx response per x402 spec.
   */
  settleResponseHeader?: string;
  /** When `verified === false`, a short stable code surfacing the reason. */
  invalidReason?: string;
}
