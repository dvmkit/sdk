import { diagnosticConsole } from "../../observability/diagnostic-console";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { type FacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  BATCH_SETTLEMENT_ADDRESS,
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "@x402/evm";
import {
  type AutoSettlementConfig,
  BatchSettlementEvmScheme,
  type Channel,
  type ChannelStorage,
  type ClaimChannelSelector,
  InMemoryChannelStorage,
} from "@x402/evm/batch-settlement/server";
import { computeChannelId } from "@x402/evm/batch-settlement/client";
import type { Pool } from "pg";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { resolveRpcOverride } from "../../lib/payment-rails/rpc";
import { X402_BATCH_CHANNEL_ABI } from "../../lib/x402/batch-abi";
import { createX402FacilitatorClient } from "../../lib/x402/facilitator";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import type { PaymentRequirementsV2 } from "../../lib/x402/spec";
import { X402_BATCH_SETTLEMENT_SCHEME } from "../../lib/x402/spec";
import type {
  X402BatchSettlementConfig,
  X402FacilitatorAuth,
  X402SettlementReconciliationReason,
} from "../../lib/x402/types";
import { loggers } from "../../observability/loggers";
import type { CreditLedgerQuerier } from "./credit-ledger";
import type { HostedFundingReservation } from "./hosting-cleanup-fence";
import type { HostedSettlementReportObligations, HostedEffectReservation } from "./hosting-settlement-report-obligations";
import {
  type X402EarnedNative,
  type X402PayoutObserver,
  type X402WedgedRefund,
  x402EarnedCeiling,
} from "./payout-reporter";
import {
  PostgresX402ChannelStorage,
  X402_RESOLVED_SETTLEMENT_STATUSES,
  X402_WEDGED_SETTLEMENT_STATUSES,
  type X402RefundSettlementGate,
  type X402SettlementCursor,
  type X402SettlementIntent,
  X402SettlementRaceError,
  type X402SettlementStatus,
  type X402SettlementWriteOff,
} from "./x402-channel-store";
import { createX402SelfRelay } from "./x402-self-relay";
import {
  createX402SettlementEvidenceReader,
  type X402SettlementEvidenceReader,
} from "./x402-settlement-evidence";
import {
  createX402FleetSettlementScheduler,
  type X402FleetSettlementScheduler,
  type X402SettlePendingMarker,
} from "./x402-settlement-scheduler";

/** Hosted-facilitator channel network retained for the existing testnet path. */
export const X402_BATCH_SETTLEMENT_NETWORK = "eip155:84532";

/** Base mainnet channel network, enabled only with an in-process relay. */
export const X402_BATCH_SETTLEMENT_MAINNET_NETWORK = "eip155:8453";

/** Default withdrawal grace and minimum outside Base Sepolia; seconds. */
export const X402_BATCH_MIN_WITHDRAW_DELAY_SECONDS = 86_400;

/** Default claim and transfer cadence; comfortably inside the default 24-hour exit window. */
export const X402_BATCH_AUTO_SETTLEMENT: AutoSettlementConfig = {
  claimIntervalSecs: 300,
  settleIntervalSecs: 300,
  maxClaimsPerBatch: 100,
};

/** Natural identity and incremental value carried by an accepted channel voucher. */
export interface X402BatchFunding {
  channelId: string;
  maxClaimableAmount: string;
  paymentId: string;
  amount: string;
}

/** Successful batch-settlement result plus the caller-owned ledger result. */
export interface X402BatchAcceptance<T> {
  funding: X402BatchFunding;
  settlement: SettleResponse;
  committed: T;
}

/** Authoritative contract views needed to refresh one stored batch channel. */
export interface X402BatchChannelObservation {
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  refundNonce: number;
}

/**
 * The chain submission behind an accepted voucher did not return success.
 *
 * Typed and `retryable` because it is a service-availability fault, not a fault
 * in the credential: the voucher verified, the ledger leg rolled back, and the
 * same request first reconciles the durable submission bookmark before it can
 * submit again. Without this, the branch threw a bare `Error`, which
 * `mapLedgerCommitError` could not recognise
 * and `verifyUpfrontPayment` answered as a 402 `payment_invalid` — copy that
 * tells an agent its perfectly good payment can never be reused.
 *
 * It is deliberately *not* the relay submission lock's own error class. Upstream's
 * `BatchSettlementEvmScheme` catches everything the signer throws and returns
 * `{success: false, errorReason}`, so {@link X402RelaySubmissionLockError} never
 * reaches this layer — it arrives as `settle_transaction_failed` with its message
 * in `errorMessage`. Every sibling reason (RPC read, simulation, a reverted
 * submission) is the same class of fault and had the same wrong copy, so the
 * classification is made where upstream draws it rather than by re-deriving the
 * one cause from a string.
 *
 * `errorReason` is upstream's enum and is safe to hand an unauthenticated caller.
 * `errorMessage` — and therefore `.message` — is not: upstream builds it from
 * whatever the signer threw, so it can carry a relay lock holder's backend pid
 * and `client_addr`, or a viem error quoting the RPC URL. The self-relay path
 * drops it before constructing this error; hosted facilitators retain their
 * provider message for server logs. The wire gets the reason in either case.
 */
export class X402SettlementSubmissionError extends Error {
  readonly code = "x402_settlement_submission_failed";
  readonly retryable = true;

  constructor(
    readonly errorReason: string,
    readonly errorMessage?: string
  ) {
    super(errorMessage ? `${errorReason}: ${errorMessage}` : errorReason);
    this.name = "X402SettlementSubmissionError";
  }
}

/** Structured refusal that can be turned back into a corrective 402. */
export interface X402BatchRefusal {
  ok: false;
  reason: string;
  requirements: PaymentRequirementsV2[];
  /**
   * `false` when re-signing cannot fix this: the caller must be answered with a
   * terminal error rather than a 402 carrying fresh requirements, because an
   * agent reads a corrective 402 as "sign this and resubmit" and lands straight
   * back on the same refusal. Omitted means corrective.
   */
  corrective?: boolean;
}

/**
 * Why a positive cooperative refund could not be bounded by the credit it
 * drains. Never a corrective 402: re-signing the voucher cannot fix either
 * failure, so the payer is told to use the timed on-chain withdrawal instead.
 * `/v1/credit` handles an empty balance as `nothing_to_drain` before reaching
 * this layer; a non-positive direct bound is defensively classed as unavailable.
 */
interface X402RefundBoundFailure {
  refundBoundFailure: "refund_bound_unavailable" | "refund_exceeds_channel_escrow";
}

/**
 * What the chain says about one wedged settlement.
 *
 * The four answers are kept apart because their repairs differ and because an
 * operator re-pointing an RPC needs a definitive answer to read as definitive
 * the same split `LightningReceive.lookupSettlement` draws between
 * `invoice_unknown_to_wallet` and `wallet_unreachable`. `findAppliedSettlement`
 * collapses all of them (`undefined` for absent *and* unbookmarked, a throw for
 * transport), so this is where they are separated.
 */
export type X402SettlementEvidenceOutcome =
  /** The chain carries this exact settlement, at this exact amount. */
  | { chain: "found"; transaction: string; amount: string }
  /** Scanned from the submission bookmark to head and found nothing. */
  | { chain: "absent" }
  /** The RPC could not be read — says nothing about whether the money moved. */
  | { chain: "unreachable"; error: string }
  /** No submission bookmark, so there is no range to scan and no answer to give. */
  | { chain: "unbookmarked" };

type X402SubmittingSettlementReconciliation =
  | { reconciled: true; response: SettleResponse }
  | {
      reconciled: false;
      reason: X402SettlementReconciliationReason;
      error?: string;
    };

/** One row of the operator's repair queue: the durable intent plus what the chain says. */
export interface X402WedgedSettlement {
  intent: X402SettlementIntent;
  evidence?: X402SettlementEvidenceOutcome;
}

/** Why {@link X402SettlementRepair.reconcile} could not complete a settlement. */
export type X402SettlementRepairRefusal =
  | { refusal: "settlement_not_found" }
  /** `prepared` — nothing was ever submitted, so there is nothing to repair. */
  | { refusal: "settlement_not_wedged"; status: X402SettlementStatus }
  /** A wedged deposit; the caller's own retry recovers it. See {@link X402SettlementRepair}. */
  | { refusal: "settlement_not_repairable"; operation: "fund" }
  | { refusal: "settlement_unbookmarked" }
  | { refusal: "settlement_not_on_chain" }
  | { refusal: "chain_unreachable"; error: string }
  /** A concurrent repair or a caller retry moved the row out from under this one. */
  | { refusal: "settlement_raced"; error: string };

/** One page of the repair queue, each row carrying what the chain says about it. */
export interface X402WedgedSettlementPage {
  settlements: X402WedgedSettlement[];
  /** Absent when this page was not full — there is nothing behind it. */
  nextAfter?: X402SettlementCursor;
}

/** A settlement the repair completed — or found already complete. */
export interface X402SettlementRepaired<T> {
  intent: X402SettlementIntent;
  /** The chain figure the ledger leg was completed against; absent on a replay. */
  evidence?: X402SettlementEvidenceOutcome & { chain: "found" };
  committed?: T;
  /** True when the settlement was already `complete` and nothing was booked again. */
  replayed: boolean;
}

/**
 * The operator's exit from a settlement stuck between "chain paid" and "ledger
 * booked".
 *
 * `reconcile` is the ordinary recovery path with the chain's figure substituted
 * for the facilitator's: the amount is re-derived from
 * `x402-settlement-evidence.ts` and never supplied by the operator, which is
 * what keeps this door from extinguishing a different figure than the chain
 * actually paid. The ledger legs stay outside this module — they arrive as the
 * same `commit`/`complete` callbacks {@link X402BatchSettlementServer.accept}
 * takes, so the live path and the repair cannot drift about what completing a
 * drain means.
 *
 * Both write verbs are `refund`-only. A wedged `fund` is recovered by the
 * caller's own retry (that leg has no amount guard to wedge on), and its ledger
 * effect is `payment.ts`'s fund-and-draw, which an admin route has no way to
 * reconstruct.
 */
export interface X402SettlementRepair {
  /** One settlement by its own id, with no chain lookup — the repair's own read. */
  get(settlementId: string): Promise<X402SettlementIntent | undefined>;
  list(args: {
    limit: number;
    after?: X402SettlementCursor;
    /** Staleness floor — a settlement younger than this is in flight, not wedged. */
    updatedBeforeMs: number;
    includeResolved?: boolean;
    /** Skip the per-row chain lookups; the queue itself needs no RPC. */
    evidence?: boolean;
  }): Promise<X402WedgedSettlementPage>;
  reconcile<T>(args: {
    settlementId: string;
    commit: (intent: X402SettlementIntent, tx: CreditLedgerQuerier) => Promise<T>;
    complete: (
      evidence: { transaction: string; amount: string },
      committed: T,
      tx: CreditLedgerQuerier
    ) => Promise<T>;
    nowMs?: number;
  }): Promise<X402SettlementRepaired<T> | X402SettlementRepairRefusal>;
  writeOff(args: {
    settlementId: string;
    note?: string;
    nowMs?: number;
  }): Promise<X402SettlementWriteOff | X402SettlementRepairRefusal>;
}

/** Runtime server handle used only by `/v1/credit`. */
export interface X402BatchSettlementServer {
  buildRequirements(amount: string): Promise<PaymentRequirementsV2[]>;
  accept<T>(
    args: {
      paymentHeader: string;
      amount: string;
      effectId: string;
      /**
       * Required on `refund`: the credit's unspent balance in the channel token's
       * own units. It is the ceiling the on-chain payout is sized to, so that a
       * drain returns what the caller is owed and nothing the DVM has earned
       * `commit` must re-assert it against the authoritative ledger
       * figure, since this one is read before the channel lock is taken.
       */
      refundBoundNative?: number;
      hostingFunding?: HostedFundingReservation;
      commit: (funding: X402BatchFunding, tx?: CreditLedgerQuerier) => Promise<T>;
      complete?: (settlement: SettleResponse, committed: T, tx?: CreditLedgerQuerier) => Promise<T>;
    } & (
      | { operation: "fund"; expectedChannelId?: undefined }
      | {
          operation: "refund";
          /**
           * The channel the credit being drained is bound to. Required, and
           * required in the *type*, because the payload the payer presents is
           * what revokes, settles and pays: a refund voucher naming another
           * channel would extinguish this credit's balance out of that channel's
           * escrow. The fund path binds in the ledger
           * (`credit-ledger.ts`'s `rail_mismatch`) and the Tempo close binds in
           * its credential verifier; this is x402's.
           */
          expectedChannelId: string;
        }
    )
  ): Promise<{ ok: true; value: X402BatchAcceptance<T> } | X402BatchRefusal>;
  getChannel(channelId: string): Promise<Channel | undefined>;
  /** Refresh one stored channel from the facilitator without settling or broadcasting anything. */
  observeChannel(channelId: string): Promise<Channel | undefined>;
  claimAndSettle(): Promise<void>;
  /**
   * Operator repair for a settlement wedged between chain and ledger
   * Absent without durable storage: with no settlement rows there
   * is no queue and nothing a repair could act on.
   */
  repair?: X402SettlementRepair;
  /**
   * The durable settlement read the credit ledger gates spending on
   * Absent without durable storage, on the same reasoning as
   * {@link repair}: with no settlement rows nothing can be wedged, so there is
   * nothing to gate.
   */
  settlementGate?: X402RefundSettlementGate;
  stop(): Promise<void>;
}

export interface CreateX402BatchSettlementServerOpts {
  network: string;
  payTo: string;
  facilitator?: string;
  facilitatorAuth?: X402FacilitatorAuth;
  config: X402BatchSettlementConfig;
  /**
   * Chain RPC endpoint for settlement reconciliation; defaults to viem's bundled public one.
   *
   * Takes precedence over {@link X402BatchSettlementConfig.rpcUrl}, which is
   * where a builder configuring the rail declares it.
   */
  rpcUrl?: string;
  db?: Pool;
  /**
   * Durable store to adopt instead of building one from {@link db}.
   *
   * `createDVMServer` builds it at ledger construction, because the credit
   * ledger's spend gate has to exist whether or not this server is ever
   * constructed. Adopting it here keeps one `PostgresX402ChannelStorage` — and
   * so one settlement pool — per mount, which is what the reasoning on
   * {@link PostgresX402ChannelStorage} rests on. Ignored when the config
   * supplies its own {@link X402BatchSettlementConfig.storage}.
   */
  channelStorage?: PostgresX402ChannelStorage;
  allowInMemory?: boolean;
  /**
   * Rail-native value the credit a channel funded has earned, in the channel
   * token's atomic units — `CreditLedgerLike.earnedNativeForX402Channel`.
   * `undefined` means the channel's credit could not be resolved.
   *
   * Required, not optional: it is the ceiling every claim is capped at
   * and a server that cannot derive one must claim nothing rather
   * than fall back to the deposit.
   */
  earnedNative: (channelId: string) => Promise<number | undefined>;
  /** Bounded host-probe result reused during resource initialization. */
  supportedResponse?: SupportedResponse;
  /** Exact-chain evidence override for deterministic tests and custom RPC infrastructure. */
  settlementEvidenceReader?: X402SettlementEvidenceReader;
  /** Authoritative channel-view override for deterministic tests. */
  channelStateReader?: (channelId: string) => Promise<X402BatchChannelObservation>;
  /**
   * The payout tracker. Attached with this server's settle scope
   * and routed every claim and settle, so the batch that lands at `pay_to` is
   * reported with the value claimed into it, and the pending snapshot can say
   * what is still on the channels and whether the settle is wedged.
   *
   * @internal Wired by `createDVMServer` from the platform reporter; not a
   * builder surface, and not part of the extractable SDK contract.
   */
  payout?: X402PayoutObserver;
  /** Server-installed managed-host settlement recorder. */
  hostedObligations?: HostedSettlementReportObligations;
}

function hostedSettlementFacilitator(
  facilitator: FacilitatorClient,
  obligations: HostedSettlementReportObligations,
  network: string
): FacilitatorClient {
  return new Proxy(facilitator, {
    get(target, property, receiver) {
      if (property !== "settle") {
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (payment: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> => {
        const payload = payment.payload as Record<string, unknown>;
        const reservations: HostedEffectReservation[] = [];
        if (payload.type === "claim") {
          if (!Array.isArray(payload.claims) || !payload.claims.length) {
            throw new Error("Hosted x402 claim has no selected vouchers");
          }
          for (const raw of payload.claims) {
            const claim = raw as { voucher?: { channel?: Parameters<typeof computeChannelId>[0] };
              signature?: string; totalClaimed?: string };
            if (!claim.voucher?.channel || !claim.signature || !claim.totalClaimed) {
              throw new Error("Hosted x402 claim lacks original voucher identity");
            }
            const channelId = computeChannelId(claim.voucher.channel, network);
            const reservation = await obligations.reserveX402(channelId, "claim", {
              charged: claim.totalClaimed, signature: claim.signature,
              signedMax: String((claim.voucher as { maxClaimableAmount?: unknown }).maxClaimableAmount),
              authorizationPayload: payload,
              authorizationRequirements: requirements,
            });
            if (!reservation) throw new Error("Hosted x402 selected voucher is not claimable");
            if (reservation.replayed) throw new Error("Hosted x402 claim already has an original effect attempt");
            reservations.push(reservation);
          }
        } else if (payload.type === "refund") {
          const config = payload.channelConfig as Parameters<typeof computeChannelId>[0] | undefined;
          if (!config || typeof payload.refundNonce !== "string" || typeof payload.amount !== "string") {
            throw new Error("Hosted x402 refund lacks original channel identity");
          }
          const channelId = computeChannelId(config, network);
          const claims = payload.claims;
          if (!Array.isArray(claims) || claims.length > 1 ||
            claims.some((raw) => {
              const claim = raw as { voucher?: { channel?: Parameters<typeof computeChannelId>[0] } };
              return !claim.voucher?.channel ||
                computeChannelId(claim.voucher.channel, network).toLowerCase() !== channelId.toLowerCase();
            })) {
            throw new Error("Hosted x402 refund contains an unbound claim");
          }
          const reservation = await obligations.reserveX402(channelId, "refund", {
            refundNonce: payload.refundNonce, refundAmount: payload.amount,
            voucherSignature: String((payload.voucher as { signature?: unknown } | undefined)?.signature),
            signedMax: String((payload.voucher as { maxClaimableAmount?: unknown } | undefined)?.maxClaimableAmount),
            authorizationPayload: payload,
            authorizationRequirements: requirements,
          });
          if (!reservation) throw new Error("Hosted x402 selected channel is not refundable");
          if (reservation.replayed) throw new Error("Hosted x402 refund already has an original effect attempt");
          reservations.push(reservation);
        } else if (payload.type === "settle") {
          const reservation = await obligations.reserveOpenX402Settlement();
          if (reservation.replayed) throw new Error("Hosted x402 settle already has an original effect attempt");
          reservations.push(reservation);
        }
        const response = await target.settle(payment, requirements);
        if (response.success && reservations.length) {
          for (const reservation of reservations) {
            await obligations.recordSubmitted(reservation.id, response.transaction);
          }
        }
        return response;
      };
    },
  });
}

/**
 * Initialize upstream's scheme and channel manager against dvmkit storage.
 * `resource.initialize()` performs the facilitator capability check and is
 * deliberately part of boot, so x402.org's missing authorizer refuses a
 * misconfigured server before it advertises a channel callers could fund.
 */
export async function createX402BatchSettlementServer(
  opts: CreateX402BatchSettlementServerOpts
): Promise<X402BatchSettlementServer> {
  const selfRelayEnabled = !!opts.config.selfRelay;
  if (selfRelayEnabled && opts.network !== X402_BATCH_SETTLEMENT_MAINNET_NETWORK) {
    throw new Error(`x402 selfRelay is Base mainnet-only; got ${opts.network}`);
  }
  if (opts.config.selfRelay && !opts.config.receiverAuthorizerSigner) {
    throw new Error("x402 selfRelay requires a separate receiverAuthorizerSigner");
  }
  if (
    opts.config.selfRelay &&
    opts.config.receiverAuthorizerSigner?.address.toLowerCase() ===
      privateKeyToAccount(opts.config.selfRelay.privateKey).address.toLowerCase()
  ) {
    throw new Error(
      "x402 self-relay gas EOA and receiver authorizer must use different keys; the authorizer is signing-only and must never hold funds"
    );
  }
  if (
    opts.network !== X402_BATCH_SETTLEMENT_NETWORK &&
    !(opts.network === X402_BATCH_SETTLEMENT_MAINNET_NETWORK && selfRelayEnabled)
  ) {
    throw new Error(
      `x402 batch-settlement on Base mainnet requires selfRelay; got ${opts.network}`
    );
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.payTo)) {
    throw new Error("x402 batch-settlement payTo must be a 20-byte EVM address");
  }
  const withdrawDelay = opts.config.withdrawDelay ?? X402_BATCH_MIN_WITHDRAW_DELAY_SECONDS;
  const minimumWithdrawDelay = opts.network === X402_BATCH_SETTLEMENT_NETWORK
    ? 900
    : X402_BATCH_MIN_WITHDRAW_DELAY_SECONDS;
  if (!Number.isInteger(withdrawDelay) || withdrawDelay < minimumWithdrawDelay) {
    throw new Error(
      `x402 batch-settlement withdrawDelay must be at least ${String(minimumWithdrawDelay)} seconds`
    );
  }
  if (opts.config.autoSettlement !== false && opts.config.autoSettlement?.selectRefundChannels) {
    // Upstream's refund job is the one claim path the earned ceiling cannot
    // reach: `buildRefundClaims` reads `chargedCumulativeAmount` off the stored
    // row — the deposit — and pays the payer `balance − charged`, so a channel
    // it picked up would be claimed in full and refunded nothing of what the
    // caller had left unspent. The cooperative drain is the
    // supported refund path; it revokes the charge to the earned figure first.
    throw new Error(
      "x402 batch-settlement autoSettlement.selectRefundChannels is unsupported: it refunds against the fund-time charge, not earned draws. Use the cooperative drain (POST /v1/credit op drain)."
    );
  }

  // A caller-supplied store is already `init`ed; the config's own
  // `storage` still wins, and leaves `postgres` unset exactly as before.
  let postgres = opts.config.storage ? undefined : opts.channelStorage;
  let storage = opts.config.storage ?? postgres;
  if (!storage && opts.db) {
    postgres = new PostgresX402ChannelStorage(opts.db);
    await postgres.init();
    storage = postgres;
  }
  if (!storage) {
    if (!opts.allowInMemory) {
      throw new Error(
        "x402 batch-settlement requires Postgres ChannelStorage outside dev/test mode"
      );
    }
    storage = new InMemoryChannelStorage();
  }
  if (postgres && opts.hostedObligations) {
    opts.hostedObligations.attachX402SettlementStore(postgres);
  }

  // An explicit `facilitatorClient` wins over `selfRelay` below, so no relay —
  // and nothing to serialize — is built in that case. The lock owner and the
  // warn read the same predicate rather than `selfRelayEnabled`, which would
  // stand up a store nothing uses and warn about a relay that doesn't exist.
  const selfRelayActive = selfRelayEnabled && !opts.config.facilitatorClient;
  // The relay's submission lock has to acquire from a terminal pool, and
  // `PostgresX402ChannelStorage` is what owns one. A builder-supplied
  // `ChannelStorage` leaves `postgres` unset, so a database-backed host gets a
  // lock-only store over the same pool: it runs no DDL and reads no channel row,
  // it just owns the settlement pool the acquire lands on. It is the *only*
  // `PostgresX402ChannelStorage` in that configuration, so there is still one
  // settlement pool per machine either way. With no database at all there is
  // nothing fleet-wide to take and the in-process tail is the whole guard —
  // correct single-machine, and worth saying out loud otherwise.
  const relayLockOwner = selfRelayActive
    ? (postgres ?? (opts.db ? new PostgresX402ChannelStorage(opts.db) : undefined))
    : undefined;
  if (selfRelayActive && !relayLockOwner && !opts.allowInMemory) {
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "x402_self_relay_unserialized",
        network: opts.network,
        detail:
          "no database for the fleet-wide submission lock; this relay's gas EOA is serialized in-process only",
      }
    );
  }
  const selfRelay =
    opts.config.selfRelay && selfRelayActive
      ? createX402SelfRelay({
          network: opts.network,
          config: opts.config.selfRelay,
          ...(relayLockOwner ? { submissionLock: relayLockOwner } : {}),
        })
      : undefined;
  const rawFacilitator =
    opts.config.facilitatorClient ??
    selfRelay?.client ??
    createX402FacilitatorClient({
      ...(opts.facilitator ? { facilitator: opts.facilitator } : {}),
      ...(opts.facilitatorAuth ? { facilitatorAuth: opts.facilitatorAuth } : {}),
    });
  const facilitator =
    opts.supportedResponse && !selfRelayEnabled
      ? withCachedSupportedResponse(rawFacilitator, opts.supportedResponse)
      : rawFacilitator;
  const settlementFacilitator = opts.hostedObligations
    ? hostedSettlementFacilitator(facilitator, opts.hostedObligations, opts.network)
    : facilitator;
  const rpcUrl = opts.rpcUrl ?? opts.config.rpcUrl;
  const settlementEvidence =
    opts.settlementEvidenceReader ??
    (await createX402SettlementEvidenceReader({
      network: opts.network,
      ...(rpcUrl ? { rpcUrl } : {}),
    }));
  const channelStateReader =
    opts.channelStateReader ??
    (await createX402BatchChannelStateReader({
      network: opts.network,
      ...(rpcUrl ? { rpcUrl } : {}),
    }));
  const scheme = new BatchSettlementEvmScheme(opts.payTo as `0x${string}`, {
    storage,
    ...(opts.config.receiverAuthorizerSigner
      ? { receiverAuthorizerSigner: opts.config.receiverAuthorizerSigner }
      : {}),
    withdrawDelay,
    ...(opts.config.onchainStateTtlMs !== undefined
      ? { onchainStateTtlMs: opts.config.onchainStateTtlMs }
      : {}),
  });
  const resource = new x402ResourceServer(settlementFacilitator).register(
    opts.network as `${string}:${string}`,
    scheme
  );
  await resource.initialize();

  const network = x402NetworkByCaip2(opts.network);
  if (!network) throw new Error(`No USDC contract configured for ${opts.network}`);
  const token = network.usdc;
  const manager = scheme.createChannelManager(
    settlementFacilitator,
    opts.network as `${string}:${string}`,
    token
  );
  // Serializes the accept lifecycle per channel when there is no Postgres
  // transaction to do it (dev/test): the revocation, reservation and settle
  // must not interleave for one channel.
  const inMemoryChannelTails = new Map<string, Promise<void>>();
  const claimCeiling = claimCeilingSelector(opts.earnedNative);
  const settlementConfig: AutoSettlementConfig = {
    ...X402_BATCH_AUTO_SETTLEMENT,
    ...(opts.config.autoSettlement === false ? {} : opts.config.autoSettlement),
    // Every claim this fleet builds is capped at earned draws — the claim
    // timer, `claimAndSettle()`, and the withdraw-race rush claim all route
    // through this selector. A builder-supplied
    // `autoSettlement.selectClaimChannels` cannot override it: the ceiling is
    // a money invariant, not a policy knob. Upstream's refund job builds its
    // bundled claim from storage instead and never consults a selector, which
    // is why `selectRefundChannels` is refused at boot above.
    selectClaimChannels: claimCeiling,
  };
  // Every claim this fleet lands — scheduled or rushed by the withdraw race —
  // leaves funds in the contract until a `settle(receiver, token)` moves them,
  // and only the marker survives the process that claimed.
  const settleScope = `${opts.network}|${opts.payTo.toLowerCase()}|${token.toLowerCase()}`;
  const marker: X402SettlePendingMarker | undefined = postgres
    ? {
        read: () => postgres.isSettlePending(settleScope),
        write: (pending) => postgres.setSettlePending(settleScope, pending),
      }
    : undefined;
  // the payout tracker sees every claim and settle whichever path
  // runs them — the scheduler, `claimAndSettle()`, the withdraw-race rush
  // claim — because all three go through `tracked`. It answers the pending
  // snapshot from this scope, so it is attached before any of them can run.
  opts.payout?.attach({
    scope: settleScope,
    payTo: opts.payTo,
    network: opts.network,
    storage,
    earnedNative: opts.earnedNative,
    settleIntervalMs:
      (settlementConfig.settleIntervalSecs ??
        X402_BATCH_AUTO_SETTLEMENT.settleIntervalSecs ??
        300) * 1000,
    ...(postgres ? { listWedgedRefunds: () => listWedgedRefunds(postgres) } : {}),
  });
  const tracked = opts.payout ? opts.payout.trackManager(manager) : manager;
  let scheduler: X402FleetSettlementScheduler | undefined;
  if (opts.config.autoSettlement !== false) {
    if (postgres && marker) {
      scheduler = createX402FleetSettlementScheduler({
        manager: tracked,
        storage,
        config: settlementConfig,
        withLock: (operation) => postgres.withFleetSettlementLock(operation),
        marker,
      });
    } else {
      manager.start(settlementConfig);
    }
  }

  const buildRequirements = async (amount: string): Promise<PaymentRequirementsV2[]> => {
    const requirements = await resource.buildPaymentRequirementsFromOptions(
      [
        {
          scheme: X402_BATCH_SETTLEMENT_SCHEME,
          payTo: opts.payTo,
          price: {
            asset: token,
            amount,
            extra: {
              name: network.domainName,
              version: network.domainVersion,
              assetTransferMethod: "eip3009",
            },
          },
          network: opts.network as `${string}:${string}`,
          maxTimeoutSeconds: 60,
        },
      ],
      undefined
    );
    return requirements as PaymentRequirementsV2[];
  };

  selfRelay?.start();
  return {
    buildRequirements,
    async accept<T>(args: {
      paymentHeader: string;
      amount: string;
      operation: "fund" | "refund";
      effectId: string;
      expectedChannelId?: string;
      refundBoundNative?: number;
      hostingFunding?: HostedFundingReservation;
      commit: (funding: X402BatchFunding, tx?: CreditLedgerQuerier) => Promise<T>;
      complete?: (settlement: SettleResponse, committed: T, tx?: CreditLedgerQuerier) => Promise<T>;
    }) {
      let payload: PaymentPayload;
      try {
        payload = decodeBatchPayment(args.paymentHeader);
      } catch {
        return {
          ok: false as const,
          reason: "decode_failed",
          requirements: await buildRequirements(args.amount),
        };
      }
      const requirements = (await buildRequirements(args.amount)) as PaymentRequirements[];
      const matched = resource.findMatchingRequirements(requirements, payload);
      if (!matched) {
        return {
          ok: false as const,
          reason: "requirements_mismatch",
          requirements: requirements as PaymentRequirementsV2[],
        };
      }
      const raw = payload.payload;
      const isRefund = isBatchSettlementRefundPayload(raw);
      if ((args.operation === "refund") !== isRefund) {
        return {
          ok: false as const,
          reason: "wrong_channel_operation",
          requirements: requirements as PaymentRequirementsV2[],
        };
      }
      if (args.operation === "fund" && postgres) {
        if (args.hostingFunding &&
          args.effectId !== `${args.hostingFunding.creditId}:${args.hostingFunding.fundId}`) {
          throw new Error("x402 funding effect conflicts with its hosted admission");
        }
        if (args.hostingFunding &&
          createHash("sha256").update(args.paymentHeader).digest("hex") !==
            args.hostingFunding.paymentArtifactHash) {
          throw new Error("x402 payment differs from its hosted admission artifact");
        }
        await postgres.assertHostingFundingReservation(args.hostingFunding);
      }
      if (isRefund && (raw as { amount?: unknown }).amount !== undefined) {
        // Upstream honours a payer-supplied `amount` verbatim, above any
        // ledger figure, and the DVM's own receiver-authorizer then signs it.
        // The payout is this side's to derive.
        return {
          ok: false as const,
          reason: "refund_amount_not_payer_chosen",
          requirements: requirements as PaymentRequirementsV2[],
        };
      }
      const voucher = batchVoucher(raw);
      if (isRefund) {
        // The credit being drained names one channel; this voucher names
        // whichever one the payer signed. Everything below — the revocation, the
        // refund base, the facilitator payout — follows the *voucher*, so a
        // payer holding two channels here could extinguish one credit's balance
        // out of the other channel's escrow, and the drain row would then name a
        // channel the payout never touched.
        //
        // Checked here rather than at the route: this is the value that pays, so
        // comparing it is exact, where a second decode of the same header can
        // disagree with it. And it precedes every state change — the chain
        // bookmark below, the channel lock, `prepareSettlement`.
        if (!args.expectedChannelId) {
          // Typed as required on `refund`, and re-asserted because the SDK ships
          // as JavaScript: an unbound refund would settle silently.
          throw new Error("x402 refund accept requires the credit's bound channel id");
        }
        if (voucher.channelId.toLowerCase() !== args.expectedChannelId.toLowerCase()) {
          // Non-corrective: nothing about the voucher's own signature is wrong,
          // and a 402 carrying fresh requirements reads to an agent as "re-sign
          // and resubmit" — which its wallet does, for the same channel, landing
          // straight back here.
          return {
            ok: false as const,
            reason: "wrong_channel",
            requirements: requirements as PaymentRequirementsV2[],
            corrective: false as const,
          };
        }
      }
      const settlementId = settlementIdentity(args.operation, args.effectId);
      const paymentBase = `${voucher.channelId.toLowerCase()}:${voucher.maxClaimableAmount}`;
      const depositPaymentId = isBatchSettlementDepositPayload(raw)
        ? depositAuthorizationPaymentId(raw)
        : undefined;
      const funding: X402BatchFunding = {
        channelId: voucher.channelId.toLowerCase(),
        maxClaimableAmount: voucher.maxClaimableAmount,
        // The deposit's ERC-3009 salt names the token authorization that can
        // move money. The voucher base does not: a cooperatively drained and
        // reused channel can present the same cumulative maximum again under a
        // fresh authorization, which made the second legitimate deposit
        // collide with the first row. Conversely, keying by the
        // credit effect would let one signed authorization open several rows.
        //
        // A cooperative refund belongs to one caller drain: after an operator
        // writes a failed drain off, the unchanged channel can legitimately
        // present the same voucher base under a fresh drain id. Keep that new
        // effect out of the old row's `(operation, payment_id)` replay slot
        paymentId: isRefund ? `${paymentBase}:${settlementId}` : (depositPaymentId ?? paymentBase),
        amount: matched.amount,
      };
      const external = isBatchSettlementDepositPayload(raw) || isRefund;
      let channelBeforeVerify: Channel | undefined;
      let pendingId: string | undefined;
      let cancel: ReturnType<typeof resource.createPaymentCancellationDispatcher> | undefined;
      const settlementState = { succeeded: false };
      // Bookmark the chain *before* the transaction opens. This is a
      // public-RPC round trip, and taking it inside would hold a pooled client
      // and the channel advisory lock for its whole duration — a rate-limited
      // endpoint would then stall every other deposit rather than just refusing
      // this one. It stays fail-closed: a throw here precedes `settlePayment`,
      // so nothing has moved. The marker itself is still written inside, after
      // `commit` — a `submitting` row with no chain action behind it is
      // unreconcilable, and a failed commit would leave exactly that.
      //
      // `external && postgres` is exactly when `prepareSettlement` produces an
      // intent to mark; the read is wasted only when that prepare comes back
      // already `settled` and the recovery path returns early.
      const submissionBlock =
        external && postgres ? (await settlementEvidence.getBlockNumber()).toString() : undefined;
      const runLocked = async (tx?: CreditLedgerQuerier) => {
        let prior = external
          ? await postgres?.getSettlement(args.operation, args.effectId)
          : undefined;
        if (prior && postgres) {
          const retryIdentity = assertSettlementRetry(
            prior,
            settlementId,
            funding,
            payload,
            matched
          );
          if (retryIdentity === "legacy_fund" || retryIdentity === "legacy_refund") {
            prior = await postgres.normalizeLegacyPaymentId(
              prior.settlementId,
              prior.operation,
              prior.paymentId,
              funding.paymentId
            );
          }
          if (prior.status === "complete") {
            return correctiveRefusal(
              resource,
              requirements,
              payload,
              "settlement_already_complete"
            );
          }
          if (prior.status === "written_off") {
            // An operator reviewed this settlement and closed it.
            // Say so, rather than falling through to `prepareSettlement` and
            // 500ing on "no longer prepared for retry": the caller needs a
            // reason they can relay, and this effect id is spent either way —
            // a fresh drain id opens a new one against the channel's real
            // remaining balance.
            //
            // Explicitly non-corrective, which is why it does not go through
            // `correctiveRefusal`: nothing about the voucher is wrong, so a 402
            // carrying fresh requirements would have an agent re-sign the same
            // drain id and arrive back here. The caller has to change the drain
            // id, and only a terminal answer says so.
            return {
              ok: false as const,
              reason: "settlement_written_off",
              requirements: requirements as PaymentRequirementsV2[],
              corrective: false as const,
            };
          }
          if (prior.status === "settled" && prior.response) {
            const value = await recoverSettledPayment({
              postgres,
              storage,
              intent: prior,
              funding,
              payload,
              matched,
              commit: args.commit,
              complete: args.complete,
              tx,
            });
            return { ok: true as const, value };
          }
          if (prior.status === "submitting") {
            await clearPending(storage, funding.channelId, prior.pendingId);
            const reconciliation = await reconcileSubmittingSettlement(
              facilitator,
              settlementEvidence,
              prior
            );
            if (!reconciliation.reconciled) {
              if (reconciliation.reason === "settlement_not_on_chain") {
                // This is the one definitive non-settlement answer. Return the
                // intent to the ordinary submission phase, but leave the retry
                // to the caller: automatically resubmitting at this ambiguous
                // boundary would recreate the crash-safety bug this row guards.
                await postgres.markSettlementRetryable(prior.settlementId);
              } else if (reconciliation.reason === "chain_unreachable") {
                // One warning per caller retry makes a persistently broken RPC
                // visible without a background loop. The row deliberately
                // stays `submitting`: no chain answer means no safe resubmit.
                loggers.x402.warn("x402_settlement_reconciliation_chain_unreachable", {
                  "settlement.id": prior.settlementId,
                  "channel.id": prior.channelId,
                  "credit.effect_id": prior.effectId,
                  error: reconciliation.error ?? "chain RPC did not answer",
                });
              } else if (reconciliation.reason === "facilitator_channel_state_unavailable") {
                loggers.x402.warn("x402_settlement_reconciliation_facilitator_unavailable", {
                  "settlement.id": prior.settlementId,
                  "channel.id": prior.channelId,
                  "credit.effect_id": prior.effectId,
                  error: reconciliation.error ?? "matching facilitator channel state unavailable",
                });
              }
              return correctiveRefusal(resource, requirements, payload, reconciliation.reason);
            }
            const reconciled = reconciliation.response;
            await postgres.recordSettlementResponse(prior.settlementId, reconciled);
            const value = await recoverSettledPayment({
              postgres,
              storage,
              intent: { ...prior, status: "settled", response: reconciled },
              funding,
              payload,
              matched,
              commit: args.commit,
              complete: args.complete,
              tx,
            });
            return { ok: true as const, value };
          }
          await clearPending(storage, funding.channelId, prior.pendingId);
        }

        channelBeforeVerify = await storage.get(funding.channelId);
        // Upstream's local verifier carries the mirrored withdrawal timestamp
        // into the reservation checked below, so only a stale voucher row
        // needs this facilitator preflight. Refunds still need live state to
        // derive and sanction their revocation base.
        const refreshOnchainState =
          isBatchSettlementRefundPayload(raw) ||
          (isBatchSettlementVoucherPayload(raw) &&
            voucherNeedsOnchainRefresh(
              channelBeforeVerify,
              scheme.getOnchainStateTtlMs(),
              Date.now()
            ));
        if (refreshOnchainState) {
          let live: VerifyResponse | X402RefundBoundFailure;
          try {
            live = await refreshChannelOnchainState(
              facilitator,
              storage,
              payload,
              matched,
              args.refundBoundNative,
              postgres ? (base, apply) => postgres.withSanctionedRefundBase(base, apply) : undefined
            );
          } catch {
            await restoreRevokedVoucher(storage, funding.channelId, undefined, channelBeforeVerify);
            return correctiveRefusal(resource, requirements, payload, "verify_failed");
          }
          if ("refundBoundFailure" in live) {
            await restoreRevokedVoucher(storage, funding.channelId, undefined, channelBeforeVerify);
            return {
              ok: false as const,
              reason: live.refundBoundFailure,
              requirements: requirements as PaymentRequirementsV2[],
              corrective: false as const,
            };
          }
          if (!live.isValid) {
            await restoreRevokedVoucher(storage, funding.channelId, undefined, channelBeforeVerify);
            return correctiveRefusal(
              resource,
              requirements,
              payload,
              live.invalidReason ?? "verify_failed"
            );
          }
        }

        let verify;
        try {
          verify = await resource.verifyPayment(payload, matched);
        } catch {
          await restoreRevokedVoucher(storage, funding.channelId, undefined, channelBeforeVerify);
          return correctiveRefusal(resource, requirements, payload, "verify_failed");
        }
        if (!verify.isValid) {
          await restoreRevokedVoucher(storage, funding.channelId, undefined, channelBeforeVerify);
          return correctiveRefusal(
            resource,
            requirements,
            payload,
            verify.invalidReason ?? "verify_failed"
          );
        }

        const reserved = await storage.get(funding.channelId);
        pendingId = reserved?.pendingRequest?.pendingId;
        if (reserved?.withdrawRequestedAt) {
          // Release the synthetic refund base and reservation before the
          // channel transaction commits. The fleet claim runs outside this
          // lock to preserve the global-lock → channel-lock ordering.
          await restoreReservation(storage, funding.channelId, pendingId, channelBeforeVerify);
          return { withdrawalPending: true as const };
        }

        let intent: X402SettlementIntent | undefined;
        if (external && postgres) {
          if (!reserved) throw new Error("x402 settlement verification created no channel state");
          intent = await postgres.prepareSettlement({
            settlementId,
            channelId: funding.channelId,
            operation: args.operation,
            effectId: args.effectId,
            paymentId: funding.paymentId,
            payload,
            requirements: matched,
            channelBefore: channelBeforeVerify ?? reserved,
            ...(pendingId ? { pendingId } : {}),
          }, args.hostingFunding);
          if (intent.status === "settled" && intent.response) {
            const value = await recoverSettledPayment({
              postgres,
              storage,
              intent,
              funding,
              payload,
              matched,
              commit: args.commit,
              complete: args.complete,
              tx,
            });
            return { ok: true as const, value };
          }
        }

        cancel = resource.createPaymentCancellationDispatcher(payload, matched);
        // The handler-equivalent ledger work deliberately runs before settle.
        // If it throws, upstream cancellation clears `pendingRequest`. A
        // successful external settle is durably recorded before this
        // transaction completes so a later retry can finish the ledger.
        let committed = await args.commit(funding, tx);
        if (intent && submissionBlock !== undefined) {
          // `reserved`, not `channelBeforeVerify`: the facilitator sizes a
          // refund from the state *after* this request's on-chain refresh and
          // signs it against that `refundNonce`, so this is the snapshot chain
          // evidence must be derived from.
          await postgres?.markSettlementSubmitting(intent.settlementId, submissionBlock, reserved);
        }
        const settlement = await resource.settlePayment(payload, matched);
        if (!settlement.success) {
          // A facilitator failure is not proof that no transaction landed. The
          // self-relay can broadcast successfully and then lose its result to a
          // throttled post-submit channel read, which is exactly the same
          // ambiguous boundary as a crash before `recordSettlementResponse`.
          // Keep the durable intent `submitting` so the identical caller retry
          // scans from its pre-submit bookmark and either recovers the mined
          // deposit or proves absence before returning it to `prepared`.
          // A hosted facilitator's provider message remains useful. A self-relay
          // message is not safe: viem can quote the credential-bearing RPC URL,
          // and the error also reaches spans through `.message`. Its separately
          // classified `x402_self_relay_rpc_failed` event and submission-lock
          // event carry the safe operator evidence.
          const operatorErrorMessage = selfRelayEnabled ? undefined : settlement.errorMessage;
          diagnosticConsole.warn(
            {
              level: "warn",
              event: "x402_settlement_submission_failed",
              network: settlement.network,
              settlement_id: intent?.settlementId,
              error_reason: settlement.errorReason,
              ...(operatorErrorMessage ? { error_message: undefined } : {}),
            }
          );
          // The throw carries the retryable service-fault classification to the
          // caller rather than losing it to a bare `Error`.
          throw new X402SettlementSubmissionError(
            settlement.errorReason ?? "batch_settlement_failed",
            operatorErrorMessage
          );
        }
        settlementState.succeeded = true;
        if (intent) await postgres?.recordSettlementResponse(intent.settlementId, settlement);
        if (args.complete) committed = await args.complete(settlement, committed, tx);
        if (intent) await postgres?.completeSettlement(intent.settlementId);
        return { ok: true as const, value: { funding, settlement, committed } };
      };

      const guarded = async (tx?: CreditLedgerQuerier) => {
        try {
          return await runLocked(tx);
        } catch (error) {
          if (!settlementState.succeeded) {
            await restoreRevokedVoucher(storage, funding.channelId, pendingId, channelBeforeVerify);
          }
          await cancel?.cancel({ reason: "handler_threw", error }).catch(() => undefined);
          await clearPending(storage, funding.channelId, pendingId);
          throw error;
        }
      };
      const result = postgres
        ? await postgres.withChannelTransaction(funding.channelId, (tx) => guarded(tx), args.hostingFunding)
        : await withLocalChannelLock(inMemoryChannelTails, funding.channelId, () => guarded());
      if ("withdrawalPending" in result) {
        try {
          const claim = async () => {
            const results = await tracked.claim({
              maxClaimsPerBatch: 100,
              selectClaimChannels: (channels, context) =>
                claimCeiling(
                  channels.filter(
                    (channel) => channel.channelId.toLowerCase() === funding.channelId
                  ),
                  context
                ),
            });
            if (results.length > 0) await marker?.write(true);
          };
          // Best-effort, and deliberately non-waiting: this branch
          // refuses with `withdrawal_pending` whether or not the claim ran, and
          // a concurrent holder is already claiming this channel (the scheduler
          // claims up to 100 unfiltered). Blocking a request behind a fleet-wide
          // session lock — while holding a pooled connection — is what wedges
          // the shared pool.
          if (postgres) await postgres.withFleetSettlementLock(claim);
          else await claim();
        } catch (error) {
          // The payment is refused either way. A facilitator that rejected the
          // rush claim is a provider fault the caller cannot act on, so it must
          // not turn a corrective 402 into a 500 — and the voucher this branch
          // just verified stays on the row for the next claim to carry.
          diagnosticConsole.error("x402 batch-settlement withdrawal claim failed", error);
        } finally {
          await restoreReservation(storage, funding.channelId, pendingId, channelBeforeVerify);
        }
        return correctiveRefusal(resource, requirements, payload, "withdrawal_pending");
      }
      if (isRefund && opts.hostedObligations && result.ok) {
        const delta = await opts.hostedObligations.refundClaimDelta(
          result.value.settlement.transaction, funding.channelId
        );
        if (delta > 0n) {
          if (!opts.payout?.recordRefundClaim) {
            throw new Error("Hosted x402 refund claim has no durable payout tracker");
          }
          await opts.payout.recordRefundClaim(result.value.settlement.transaction, delta);
        }
      }
      return result;
    },
    getChannel: (channelId: string) => storage.get(channelId),
    async observeChannel(channelId: string): Promise<Channel | undefined> {
      const channel = await storage.get(channelId);
      if (!channel) return channel;
      // A facilitator verifies whether this voucher can settle; its `extra`
      // may echo the channel's historical deposit after a timed withdrawal.
      // The contract views are the authority for what escrow remains now.
      const observed = await channelStateReader(channel.channelId);
      await storage.updateChannel(channel.channelId, (current) =>
        current
          ? {
              ...current,
              balance: observed.balance,
              totalClaimed: observed.totalClaimed,
              withdrawRequestedAt: observed.withdrawRequestedAt,
              refundNonce: observed.refundNonce,
              onchainSyncedAt: Date.now(),
            }
          : current
      );
      return storage.get(channelId);
    },
    ...(postgres
      ? {
          repair: createSettlementRepair(postgres, storage, facilitator, settlementEvidence),
          settlementGate: postgres,
        }
      : {}),
    async claimAndSettle(): Promise<void> {
      // Upstream's `claimAndSettle` settles only when its own claim landed, so
      // it is expanded here: the marker has to be raised between the two legs
      // or a settle that throws leaves claimed funds with nothing recording
      // that they still need transferring.
      const operation = async () => {
        const claims = await tracked.claim({
          maxClaimsPerBatch: 100,
          selectClaimChannels: claimCeiling,
        });
        if (claims.length > 0) await marker?.write(true);
        if (claims.length === 0 && !(await marker?.read())) return;
        // The raw manager, not `tracked`: the loop below re-tries only
        // upstream's "nothing to settle yet" answer, and each of those would
        // otherwise count as a settle attempt a builder reads as a wedge
        // The outcome is recorded once, whichever way it went.
        try {
          const settled = await settleOutstandingClaims(manager);
          await opts.payout?.recordSettle(settled.transaction);
        } catch (error) {
          await opts.payout?.recordSettleFailure(error);
          throw error;
        }
        await marker?.write(false);
      };
      if (postgres) await postgres.withFleetSettlementLock(operation, true);
      else await operation();
    },
    async stop(): Promise<void> {
      selfRelay?.stop();
      scheduler?.stop();
      await manager.stop();
      // Idempotent, and deliberately unconditional: an adopted store
      // is torn down by the same `createDVMServer` shutdown that
      // stops this server, so closing it from either side is correct and
      // closing it from both is a no-op the second time.
      await postgres?.close();
      // Only when it is a store of our own: `postgres` is closed above, and a
      // builder-supplied storage was never ours to close.
      if (relayLockOwner !== postgres) await relayLockOwner?.close();
    },
  };
}

/**
 * Refund settlements wedged between chain and ledger, aged past
 * the repair queue's own floor so an in-flight one is not called stuck — the
 * pending snapshot's `refund` wedges.
 */
async function listWedgedRefunds(
  postgres: PostgresX402ChannelStorage
): Promise<X402WedgedRefund[]> {
  const page = await postgres.listSettlements({
    statuses: X402_WEDGED_SETTLEMENT_STATUSES,
    updatedBeforeMs: Date.now() - WEDGED_REFUND_MIN_AGE_MS,
    limit: 50,
  });
  return page.settlements
    .filter((intent) => intent.operation === "refund")
    .map((intent) => {
      const amount = intent.response?.amount;
      return {
        settlementId: intent.settlementId,
        createdAt: intent.createdAt,
        ...(typeof amount === "string" && /^\d{1,15}$/.test(amount)
          ? { native: Number(amount) }
          : {}),
      };
    });
}

/** How old a wedged refund must be before the snapshot lists it — the admin queue's default floor. */
const WEDGED_REFUND_MIN_AGE_MS = 5 * 60_000;

/** Settle claimed funds after the facilitator's receipt RPC has caught up. */
async function settleOutstandingClaims(manager: {
  settle(): Promise<{ transaction: string }>;
}): Promise<{ transaction: string }> {
  const retryDelaysMs = [250, 500, 1_000, 2_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await manager.settle();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("invalid_batch_settlement_evm_nothing_to_settle") ||
        attempt >= retryDelaysMs.length
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt]));
    }
  }
}

async function reconcileSubmittingSettlement(
  facilitator: FacilitatorClient,
  evidenceReader: X402SettlementEvidenceReader,
  intent: X402SettlementIntent
): Promise<X402SubmittingSettlementReconciliation> {
  const raw = intent.payload.payload;
  if (!isBatchSettlementDepositPayload(raw) && !isBatchSettlementRefundPayload(raw)) {
    throw new Error("x402 reconciliation supports only deposit/refund settlements");
  }
  const evidence = await classifySettlementEvidence(evidenceReader, intent);
  if (evidence.chain !== "found") {
    return {
      reconciled: false,
      reason:
        evidence.chain === "absent"
          ? "settlement_not_on_chain"
          : evidence.chain === "unreachable"
            ? "chain_unreachable"
            : "settlement_unbookmarked",
      ...(evidence.chain === "unreachable" ? { error: evidence.error } : {}),
    };
  }

  const queryPayload: PaymentPayload = isBatchSettlementDepositPayload(raw)
    ? {
        ...intent.payload,
        payload: {
          type: "voucher",
          channelConfig: raw.channelConfig,
          voucher: raw.voucher,
        },
      }
    : intent.payload;
  let verified: VerifyResponse;
  try {
    verified = await facilitator.verify(queryPayload, intent.requirements);
  } catch (error) {
    return {
      reconciled: false,
      reason: "facilitator_channel_state_unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const live = verified.isValid ? strictLiveChannelState(verified.extra) : undefined;
  if (live?.channelId.toLowerCase() !== intent.channelId) {
    return {
      reconciled: false,
      reason: "facilitator_channel_state_unavailable",
      error: verified.isValid
        ? "facilitator returned state for a different or unreadable channel"
        : (verified.invalidReason ?? "facilitator could not verify the channel"),
    };
  }

  return {
    reconciled: true,
    response: {
      success: true,
      transaction: evidence.transaction,
      network: intent.requirements.network,
      payer: raw.channelConfig.payer,
      amount: evidence.amount,
      extra: {
        reconciledFromChainEvidence: true,
        channelState: {
          channelId: live.channelId,
          balance: live.balance,
          totalClaimed: live.totalClaimed,
          withdrawRequestedAt: live.withdrawRequestedAt,
          refundNonce: String(live.refundNonce),
        },
      },
    },
  };
}

/**
 * Ask the chain about one settlement and keep the four possible answers apart
 *
 * `findAppliedSettlement` collapses them — `undefined` for "scanned and found
 * nothing" *and* for "no bookmark to scan from", a throw for "the RPC did not
 * answer". Both the caller recovery and operator repair route through this
 * classifier so neither reports an unreadable chain as a definitive absence.
 */
async function classifySettlementEvidence(
  evidenceReader: X402SettlementEvidenceReader,
  intent: X402SettlementIntent
): Promise<X402SettlementEvidenceOutcome> {
  if (intent.submissionBlock === undefined) return { chain: "unbookmarked" };
  try {
    const evidence = await evidenceReader.findAppliedSettlement(intent);
    return evidence
      ? { chain: "found", transaction: evidence.transaction, amount: evidence.amount }
      : { chain: "absent" };
  } catch (error) {
    return { chain: "unreachable", error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The operator repair — see {@link X402SettlementRepair}.
 *
 * Only constructed against durable storage, so every path here can assume the
 * settlement row exists and the channel transaction is real.
 */
function createSettlementRepair(
  postgres: PostgresX402ChannelStorage,
  storage: ChannelStorage,
  facilitator: FacilitatorClient,
  evidenceReader: X402SettlementEvidenceReader
): X402SettlementRepair {
  const refuseEvidence = (
    outcome: X402SettlementEvidenceOutcome
  ): X402SettlementRepairRefusal | undefined => {
    if (outcome.chain === "found") return undefined;
    if (outcome.chain === "unreachable") {
      return { refusal: "chain_unreachable", error: outcome.error };
    }
    if (outcome.chain === "unbookmarked") return { refusal: "settlement_unbookmarked" };
    return { refusal: "settlement_not_on_chain" };
  };

  return {
    get: (settlementId) => postgres.getSettlementById(settlementId),

    async list(args) {
      const statuses: X402SettlementStatus[] = args.includeResolved
        ? X402_RESOLVED_SETTLEMENT_STATUSES
        : X402_WEDGED_SETTLEMENT_STATUSES;
      const page = await postgres.listSettlements({
        statuses,
        updatedBeforeMs: args.updatedBeforeMs,
        limit: args.limit,
        ...(args.after ? { after: args.after } : {}),
      });
      const nextAfter = page.nextAfter ? { nextAfter: page.nextAfter } : {};
      if (args.evidence === false) {
        return { settlements: page.settlements.map((intent) => ({ intent })), ...nextAfter };
      }
      const rows: X402WedgedSettlement[] = [];
      // Sequential, and bounded by the page size: these are chunked log scans
      // against one RPC endpoint, and a wedged queue is small. Each row's
      // lookup is classified rather than thrown, so one endpoint hiccup marks
      // that row `unreachable` instead of failing the whole page.
      for (const intent of page.settlements) {
        rows.push({ intent, evidence: await classifySettlementEvidence(evidenceReader, intent) });
      }
      return { settlements: rows, ...nextAfter };
    },

    async reconcile(args) {
      const nowMs = args.nowMs ?? Date.now();
      const intent = await postgres.getSettlementById(args.settlementId);
      if (!intent) return { refusal: "settlement_not_found" };
      // Idempotent on the settlement row's own status, like the invoice
      // repair: a replay returns the recorded row and books nothing again.
      if (intent.status === "complete") return { intent, replayed: true };
      if (intent.status === "prepared") {
        return { refusal: "settlement_not_wedged", status: intent.status };
      }
      if (intent.operation !== "refund") {
        return { refusal: "settlement_not_repairable", operation: "fund" };
      }

      // Outside the channel transaction, deliberately: this is a public-RPC
      // round trip, and taking it inside would hold a pooled client and the
      // channel advisory lock for its whole duration.
      const outcome = await classifySettlementEvidence(evidenceReader, intent);
      const refusal = refuseEvidence(outcome);
      if (refusal) return refusal;
      const evidence = outcome as X402SettlementEvidenceOutcome & { chain: "found" };

      // Recorded on the settlement pool before the ledger transaction opens,
      // for the reason the live path records its own response there: it must
      // survive a rollback. It is also what lifts a written-off row back to
      // `settled`, which is what makes the write-off reversible — and it clears
      // the note and resolution stamp with it, so the row never advertises a
      // decision that has been reversed.
      const response = await buildRepairResponse(facilitator, intent, evidence);
      try {
        await postgres.recordSettlementResponse(intent.settlementId, response);
      } catch (error) {
        if (error instanceof X402SettlementRaceError) {
          return { refusal: "settlement_raced", error: error.message };
        }
        throw error;
      }

      const runLedgerLeg = async () =>
        postgres.withChannelTransaction(intent.channelId, async (tx) => {
          await clearPending(storage, intent.channelId, intent.pendingId);
          let value = await args.commit(intent, tx);
          value = await args.complete(
            { transaction: evidence.transaction, amount: evidence.amount },
            value,
            tx
          );
          // Best-effort, and this is where the repair deliberately diverges from
          // the recovery path it otherwise mirrors. There, a refusal means a
          // concurrent attempt owns the channel reservation and aborting is
          // right; here the channel advisory lock is already held, so the only
          // way this refuses is that the stored row has moved on since the
          // settlement was prepared. That row is a cache of chain state —
          // `refreshChannelOnchainState` re-reads it on the next accept, and
          // claims are capped at earned draws either way — so failing the ledger
          // leg over it would strand the caller's liability to keep a cache
          // tidy.
          try {
            await applyRecoveredChannelSettlement(
              storage,
              intent.payload,
              intent.requirements,
              response,
              intent.channelBefore,
              intent.pendingId
            );
          } catch (error) {
            loggers.x402.warn("x402_repair_channel_state_stale", {
              "settlement.id": intent.settlementId,
              "channel.id": intent.channelId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await postgres.completeSettlement(intent.settlementId, nowMs);
          return value;
        });

      let committed;
      try {
        committed = await runLedgerLeg();
      } catch (error) {
        // The ledger leg rolled back, so this reconcile changed nothing — except
        // that recording the response above lifted the row out of `written_off`.
        // Put the operator's decision back, or a refusal (the amount
        // guard, which is exactly what a written-off settlement was closed for)
        // silently returns the row to the queue with the note erased. Restoring
        // is the same CAS the write-off itself uses: the row is `settled` again,
        // which is one of the statuses it accepts.
        if (intent.status === "written_off") {
          await postgres
            .writeOffSettlement(
              intent.settlementId,
              intent.writeOffNote,
              intent.resolvedAt ?? nowMs
            )
            .catch((restoreError: unknown) => {
              loggers.x402.warn("x402_repair_write_off_restore_failed", {
                "settlement.id": intent.settlementId,
                error: restoreError instanceof Error ? restoreError.message : String(restoreError),
              });
            });
        }
        if (error instanceof X402SettlementRaceError) {
          return { refusal: "settlement_raced", error: error.message };
        }
        throw error;
      }

      const repaired = await postgres.getSettlementById(intent.settlementId);
      return { intent: repaired ?? intent, evidence, committed, replayed: false };
    },

    async writeOff(args) {
      const intent = await postgres.getSettlementById(args.settlementId);
      if (!intent) return { refusal: "settlement_not_found" };
      if (intent.status === "complete" || intent.status === "prepared") {
        return { refusal: "settlement_not_wedged", status: intent.status };
      }
      if (intent.operation !== "refund") {
        return { refusal: "settlement_not_repairable", operation: "fund" };
      }
      const outcome = await postgres.writeOffSettlement(
        args.settlementId,
        args.note,
        args.nowMs ?? Date.now()
      );
      return outcome ?? { refusal: "settlement_not_found" };
    },
  };
}

/**
 * The settlement response the repair completes against: the chain's own
 * transaction and amount, over whatever the facilitator recorded.
 *
 * The facilitator's figure is kept under `extra.facilitatorAmount` rather than
 * dropped — a settlement wedges here precisely because those two figures can
 * disagree, so the disagreement is the audit trail. Live channel state is
 * best-effort: a facilitator that will not answer costs the channel-row sync
 * its freshness (the next verify re-syncs it) and nothing else, whereas
 * refusing over it would strand the ledger leg for a reason that has nothing
 * to do with the money.
 */
async function buildRepairResponse(
  facilitator: FacilitatorClient,
  intent: X402SettlementIntent,
  evidence: { transaction: string; amount: string }
): Promise<SettleResponse> {
  const raw = intent.payload.payload;
  if (!isBatchSettlementRefundPayload(raw)) {
    throw new Error("x402 repair supports only cooperative refund settlements");
  }
  const prior = intent.response;
  const extra: Record<string, unknown> = {
    ...(prior?.extra ?? {}),
    repairedFromChainEvidence: true,
    ...(prior?.amount !== undefined ? { facilitatorAmount: prior.amount } : {}),
  };
  if (extra.channelState === undefined) {
    const live = await liveChannelState(facilitator, intent);
    if (live) extra.channelState = live;
  }
  return {
    ...(prior ?? {}),
    success: true,
    network: intent.requirements.network,
    payer: raw.channelConfig.payer,
    transaction: evidence.transaction,
    amount: evidence.amount,
    extra,
  };
}

/** Best-effort live channel snapshot for a repaired settlement's response. */
async function liveChannelState(
  facilitator: FacilitatorClient,
  intent: X402SettlementIntent
): Promise<Record<string, unknown> | undefined> {
  let verified: VerifyResponse;
  try {
    verified = await facilitator.verify(intent.payload, intent.requirements);
  } catch {
    return undefined;
  }
  const live = verified.isValid ? strictLiveChannelState(verified.extra) : undefined;
  // A facilitator answering about some other channel is worse than no answer.
  if (live?.channelId.toLowerCase() !== intent.channelId) return undefined;
  return {
    channelId: live.channelId,
    balance: live.balance,
    totalClaimed: live.totalClaimed,
    withdrawRequestedAt: live.withdrawRequestedAt,
    refundNonce: String(live.refundNonce),
  };
}

function strictLiveChannelState(extra: Record<string, unknown> | undefined):
  | {
      channelId: string;
      balance: string;
      totalClaimed: string;
      withdrawRequestedAt: number;
      refundNonce: number;
    }
  | undefined {
  if (!extra || typeof extra.channelId !== "string") return undefined;
  const balance = strictUintString(extra.balance);
  const totalClaimed = strictUintString(extra.totalClaimed);
  const withdrawRequestedAt = strictUintNumber(extra.withdrawRequestedAt);
  const refundNonce = strictUintNumber(extra.refundNonce);
  if (
    balance === undefined ||
    totalClaimed === undefined ||
    withdrawRequestedAt === undefined ||
    refundNonce === undefined
  ) {
    return undefined;
  }
  return {
    channelId: extra.channelId,
    balance,
    totalClaimed,
    withdrawRequestedAt,
    refundNonce,
  };
}

function strictUintString(value: unknown): string | undefined {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

function strictUintNumber(value: unknown): number | undefined {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0
    ? parsed
    : undefined;
}

const CORRECTIVE_STATE_ERROR = "invalid_batch_settlement_evm_cumulative_amount_mismatch";

async function correctiveRefusal(
  resource: x402ResourceServer,
  requirements: PaymentRequirements[],
  payload: PaymentPayload,
  reason: string
): Promise<X402BatchRefusal> {
  // Upstream exposes channel/voucher correction state only through its
  // cumulative-mismatch response hook. The outer refusal keeps the real reason
  // while this internal trigger asks the scheme to enrich the requirements an
  // agent must use for its next voucher.
  const enriched = await resource.createPaymentRequiredResponse(
    requirements,
    payload.resource ?? { url: "/v1/credit" },
    CORRECTIVE_STATE_ERROR,
    undefined,
    undefined,
    payload
  );
  return {
    ok: false,
    reason,
    requirements: enriched.accepts as PaymentRequirementsV2[],
  };
}

/**
 * Caps every claim at what the channel's credit has actually earned.
 *
 * A fund charges the whole deposit to the channel, because
 * `chargedCumulativeAmount` is the payer's *cumulative authorization* and
 * upstream requires it to advance once per payment — the caller's next voucher
 * is signed against it, and this side keys the fund's replay marker on it. What
 * must not follow is claiming to that ceiling: draws are ledger-side and lag
 * the deposit, so a claim job that swept the full charge emptied the escrow
 * within one interval and left both exits with nothing to return.
 *
 * So the claim presents the earned figure instead. Upstream builds its claims
 * from whatever this selector hands back rather than re-reading storage, and
 * `updateClaimedSessions` writes only `totalClaimed` — so lowering
 * `chargedCumulativeAmount` on a copy changes the claim and persists nothing.
 * The payer's `signedMaxClaimable` and signature ride along untouched: their
 * authorization is a cap, and claiming under it is always valid.
 *
 * The ceiling is **derived, never incremented**: `min(charged, earned)`, and a
 * channel already claimed to or past it is dropped. Deriving is what keeps a
 * channel whose deposit was charged under the old rule from advancing a second
 * time as its draws land; the clamp keeps a claim inside the authorization even
 * if the ledger somehow reports more than was charged; and dropping rather than
 * lowering is what makes an over-claimed channel idle rather than clawed back.
 *
 * Fail closed: a channel whose credit cannot be resolved — no bound credit row,
 * or a ledger read that threw — is dropped from the batch and claims nothing.
 *
 * The reads run before upstream takes any channel lock and hold no transaction,
 * so the fixed channel-then-credit lock order is untouched.
 */
function claimCeilingSelector(earnedNative: X402EarnedNative): ClaimChannelSelector {
  return async (channels: Channel[]): Promise<Channel[]> => {
    const selected: Channel[] = [];
    for (const channel of channels) {
      const charged = BigInt(channel.chargedCumulativeAmount);
      const claimed = BigInt(channel.totalClaimed);
      // Nothing under the authorization is left to present, so upstream would
      // drop this channel whatever the ledger says. Skipping the read keeps an
      // unbounded `storage.list()` from costing one sequential round-trip per
      // settled channel under the fleet lock — and keeps a fully-claimed
      // channel whose credit is gone from warning on every 300s cycle.
      if (charged <= claimed) continue;
      const resolved = await x402EarnedCeiling(channel, earnedNative);
      if (resolved.kind === "unresolved") {
        loggers.x402.warn("x402_claim_ceiling_unresolved", {
          "channel.id": channel.channelId,
          error: resolved.error instanceof Error ? resolved.error.message : String(resolved.error),
        });
        continue;
      }
      if (resolved.kind === "unbound") {
        loggers.x402.warn("x402_claim_ceiling_unbound", { "channel.id": channel.channelId });
        continue;
      }
      const { ceiling } = resolved;
      // Already claimed to or past the earned figure: nothing to present, and
      // no clawback — upstream skips this channel on the same comparison.
      if (ceiling <= claimed) continue;
      selected.push({ ...channel, chargedCumulativeAmount: ceiling.toString() });
    }
    return selected;
  };
}

/** Whether a stored voucher row is too stale for upstream's local verifier. */
function voucherNeedsOnchainRefresh(
  channel: Channel | undefined,
  ttlMs: number,
  now: number
): boolean {
  return (
    channel !== undefined &&
    (channel.onchainSyncedAt === undefined || now - channel.onchainSyncedAt > ttlMs)
  );
}

async function createX402BatchChannelStateReader(endpoint: {
  network: string;
  rpcUrl?: string;
}): Promise<(channelId: string) => Promise<X402BatchChannelObservation>> {
  const spec = x402NetworkByCaip2(endpoint.network);
  if (!spec) throw new Error(`No x402 batch channel chain configured for ${endpoint.network}`);
  const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
  const chain = chains[spec.viemChain] as Parameters<typeof createPublicClient>[0]["chain"];
  const { url } = resolveRpcOverride(endpoint.rpcUrl, chain?.rpcUrls.default.http[0]);
  const client = createPublicClient({ chain, transport: http(url) });
  return async (channelId: string): Promise<X402BatchChannelObservation> => {
    const [channel, withdrawal, refundNonce] = (await Promise.all([
      client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "channels",
        args: [channelId as `0x${string}`],
      }),
      client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "pendingWithdrawals",
        args: [channelId as `0x${string}`],
      }),
      client.readContract({
        address: BATCH_SETTLEMENT_ADDRESS,
        abi: X402_BATCH_CHANNEL_ABI,
        functionName: "refundNonce",
        args: [channelId as `0x${string}`],
      }),
    ])) as [readonly [bigint, bigint | number], readonly [bigint, bigint | number], bigint];
    return {
      balance: channel[0].toString(),
      totalClaimed: BigInt(channel[1]).toString(),
      withdrawRequestedAt: safeUintNumber(withdrawal[1], "withdrawal initiated-at"),
      refundNonce: safeUintNumber(refundNonce, "refund nonce"),
    };
  };
}

function safeUintNumber(value: bigint | number, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`x402 ${label} is outside the safe integer range`);
  }
  return parsed;
}

async function refreshChannelOnchainState(
  facilitator: {
    verify: (payload: PaymentPayload, requirements: PaymentRequirements) => Promise<VerifyResponse>;
  },
  storage: ChannelStorage,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  refundBoundNative?: number,
  sanction?: (base: string, apply: () => Promise<void>) => Promise<void>
): Promise<VerifyResponse | X402RefundBoundFailure> {
  const live = await facilitator.verify(payload, requirements);
  if (!live.isValid) return live;
  const raw = payload.payload;
  if (!isBatchSettlementVoucherPayload(raw) && !isBatchSettlementRefundPayload(raw)) return live;
  const state = live.extra ?? {};
  const channelId = raw.voucher.channelId;
  const refreshed = (current: Channel): Channel => ({
    ...current,
    balance: readUintString(state, "balance", current.balance),
    totalClaimed: readUintString(state, "totalClaimed", current.totalClaimed),
    withdrawRequestedAt: readUintNumber(state, "withdrawRequestedAt", current.withdrawRequestedAt),
    refundNonce: readUintNumber(state, "refundNonce", current.refundNonce),
    onchainSyncedAt: Date.now(),
  });
  const syncOnly = async (): Promise<void> => {
    await storage.updateChannel(channelId, (current) => (current ? refreshed(current) : current));
  };

  if (!isBatchSettlementRefundPayload(raw)) {
    await syncOnly();
    return live;
  }

  // A cooperative drain refunds `balance − chargedCumulativeAmount`, so the
  // payer revokes the DVM's unclaimed claim authority down to a base this side
  // derives from its own ledger — never one the payer supplies.
  // Revoking to the contract's `totalClaimed` instead would hand the payer
  // every micro the DVM had earned but not yet claimed.
  //
  // The base is computed before the write so it can be handed to the store as
  // the one sanctioned decrease; the caller already holds this channel's lock,
  // so the read cannot race the update that follows it.
  const current = await storage.get(channelId);
  if (!current) {
    await syncOnly();
    return live;
  }
  const refundBase = deriveRefundBase(
    current.chargedCumulativeAmount,
    readUintString(state, "totalClaimed", current.totalClaimed),
    refundBoundNative
  );
  if (typeof refundBase !== "string") {
    await syncOnly();
    return refundBase;
  }
  const applyRevocation = async (): Promise<void> => {
    await storage.updateChannel(channelId, (channel) =>
      channel ? { ...refreshed(channel), chargedCumulativeAmount: refundBase } : channel
    );
  };
  if (sanction) await sanction(refundBase, applyRevocation);
  else await applyRevocation();
  return live;
}

/**
 * Chooses the `chargedCumulativeAmount` a cooperative refund must settle
 * against, so that upstream's `balance − chargedCumulativeAmount` payout is
 * exactly what the payer is owed and the bundled claim still pays the DVM
 * everything it earned.
 *
 * Subtracting the bound from what the DVM has **charged**, not from the
 * channel's balance, is what makes an over-sized deposit come out right: the
 * uncredited surplus is the payer's too, so it rides out with their unspent
 * credit instead of being swept into the DVM's claim. It also makes a base
 * above `chargedCumulativeAmount` — claim authority the payer never signed for
 * unreachable by construction rather than by a second guard.
 *
 * Returns a refusal when the escrow cannot cover the drain: the DVM has already
 * claimed the money, so the channel is the wrong instrument for returning it
 * and saying so beats paying out the wrong figure. Since that refusal
 * is unreachable in ordinary operation — {@link claimCeilingSelector} keeps
 * `totalClaimed` at or below the credit's earned draws, which is exactly this
 * base — so it now guards the residue: a channel claimed under the old
 * charge-the-deposit rule, or one whose ledger and chain have diverged.
 */
function deriveRefundBase(
  chargedCumulativeAmount: string,
  totalClaimed: string,
  refundBoundNative: number | undefined
): string | X402RefundBoundFailure {
  if (
    refundBoundNative === undefined ||
    !Number.isSafeInteger(refundBoundNative) ||
    refundBoundNative <= 0
  ) {
    return { refundBoundFailure: "refund_bound_unavailable" as const };
  }
  const base = BigInt(chargedCumulativeAmount) - BigInt(refundBoundNative);
  if (base < BigInt(totalClaimed)) {
    return { refundBoundFailure: "refund_exceeds_channel_escrow" as const };
  }
  return base.toString();
}

async function recoverSettledPayment<T>(args: {
  postgres: PostgresX402ChannelStorage;
  storage: ChannelStorage;
  intent: X402SettlementIntent;
  funding: X402BatchFunding;
  payload: PaymentPayload;
  matched: PaymentRequirements;
  commit: (funding: X402BatchFunding, tx?: CreditLedgerQuerier) => Promise<T>;
  complete?: (settlement: SettleResponse, committed: T, tx?: CreditLedgerQuerier) => Promise<T>;
  tx?: CreditLedgerQuerier;
}): Promise<X402BatchAcceptance<T>> {
  const settlement = args.intent.response;
  if (!settlement?.success) {
    throw new Error(`x402 settlement ${args.intent.settlementId} has no successful response`);
  }
  const recover = async (tx: CreditLedgerQuerier) => {
    let committed = await args.commit(args.funding, tx);
    await applyRecoveredChannelSettlement(
      args.storage,
      args.payload,
      args.matched,
      settlement,
      args.intent.channelBefore,
      args.intent.pendingId
    );
    if (args.complete) committed = await args.complete(settlement, committed, tx);
    await args.postgres.completeSettlement(args.intent.settlementId);
    return { funding: args.funding, settlement, committed };
  };
  return args.tx
    ? recover(args.tx)
    : args.postgres.withChannelTransaction(args.funding.channelId, recover);
}

async function withLocalChannelLock<T>(
  tails: Map<string, Promise<void>>,
  channelId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = tails.get(channelId) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  tails.set(channelId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tails.get(channelId) === tail) tails.delete(channelId);
  }
}

async function applyRecoveredChannelSettlement(
  storage: ChannelStorage,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  settlement: SettleResponse,
  channelBefore: Channel,
  pendingId: string | undefined
): Promise<void> {
  const raw = payload.payload;
  if (!isBatchSettlementDepositPayload(raw) && !isBatchSettlementRefundPayload(raw)) {
    throw new Error("x402 recovery supports only irreversible deposit/refund settlements");
  }
  const channelState = isRecord(settlement.extra?.channelState)
    ? settlement.extra.channelState
    : {};
  const result = await storage.updateChannel(raw.voucher.channelId, (current) => {
    const currentMatchesOriginalAuthority =
      current?.chargedCumulativeAmount === channelBefore.chargedCumulativeAmount &&
      current.signedMaxClaimable === channelBefore.signedMaxClaimable &&
      current.signature === channelBefore.signature &&
      isDeepStrictEqual(current.channelConfig, channelBefore.channelConfig);
    const intentCreatedMissingChannel =
      current === undefined && isBatchSettlementDepositPayload(raw);
    if (
      pendingId &&
      ((current?.pendingRequest && current.pendingRequest.pendingId !== pendingId) ||
        (!current?.pendingRequest &&
          !currentMatchesOriginalAuthority &&
          !intentCreatedMissingChannel))
    ) {
      return current;
    }
    const base = current ?? channelBefore;
    const now = Date.now();
    if (isBatchSettlementRefundPayload(raw)) {
      const balance = readUintString(channelState, "balance", base.balance);
      if (BigInt(balance) <= BigInt(base.chargedCumulativeAmount)) return undefined;
      return {
        ...base,
        balance,
        totalClaimed: readUintString(channelState, "totalClaimed", base.totalClaimed),
        withdrawRequestedAt: readUintNumber(
          channelState,
          "withdrawRequestedAt",
          base.withdrawRequestedAt
        ),
        refundNonce: readUintNumber(channelState, "refundNonce", base.refundNonce),
        onchainSyncedAt: now,
        lastRequestTimestamp: now,
        pendingRequest: undefined,
      };
    }
    return {
      channelId: base.channelId,
      channelConfig: raw.channelConfig,
      chargedCumulativeAmount: (
        BigInt(base.chargedCumulativeAmount) + BigInt(requirements.amount)
      ).toString(),
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      signature: raw.voucher.signature,
      balance: readUintString(channelState, "balance", base.balance),
      totalClaimed: readUintString(channelState, "totalClaimed", base.totalClaimed),
      withdrawRequestedAt: readUintNumber(
        channelState,
        "withdrawRequestedAt",
        base.withdrawRequestedAt
      ),
      refundNonce: readUintNumber(channelState, "refundNonce", base.refundNonce),
      onchainSyncedAt: now,
      lastRequestTimestamp: now,
    };
  });
  if (result.status === "unchanged") {
    throw new Error("x402 recovered settlement no longer owns its channel reservation");
  }
}

function settlementIdentity(operation: "fund" | "refund", effectId: string): string {
  return createHash("sha256").update(operation).update("\0").update(effectId).digest("hex");
}

function depositAuthorizationPaymentId(payload: Record<string, unknown>): string {
  const deposit = isRecord(payload.deposit) ? payload.deposit : undefined;
  const wrapper = isRecord(deposit?.authorization) ? deposit.authorization : undefined;
  const authorization = isRecord(wrapper?.erc3009Authorization)
    ? wrapper.erc3009Authorization
    : undefined;
  const salt = authorization?.salt;
  const voucher = batchVoucher(payload);
  if (typeof salt !== "string" || !/^0x[0-9a-f]{64}$/i.test(salt)) {
    throw new Error("x402 deposit carries no ERC-3009 authorization identity");
  }
  return `${voucher.channelId.toLowerCase()}:deposit:${salt.toLowerCase()}`;
}

function assertSettlementRetry(
  intent: X402SettlementIntent,
  settlementId: string,
  funding: X402BatchFunding,
  payload: PaymentPayload,
  requirements: PaymentRequirements
): "current" | "legacy_fund" | "legacy_refund" | "prepared_refresh" {
  if (
    intent.settlementId !== settlementId ||
    intent.channelId !== funding.channelId ||
    !isDeepStrictEqual(intent.requirements, requirements)
  ) {
    throw new Error("x402 settlement retry does not match its durable credit effect");
  }
  if (!isDeepStrictEqual(intent.payload, payload)) {
    const priorPayload = intent.payload.payload;
    if (
      intent.status === "prepared" &&
      intent.operation === "fund" &&
      isBatchSettlementDepositPayload(priorPayload) &&
      isBatchSettlementDepositPayload(payload.payload)
    ) {
      // The store owns the stricter expiry/shape/CAS check. Reaching it is
      // necessary because a replacement ERC-3009 authorization has a fresh
      // salt and therefore a fresh payment identity by design.
      return "prepared_refresh";
    }
    throw new Error("x402 settlement retry does not match its durable credit effect");
  }
  const legacyFundPaymentId = `${funding.channelId}:${funding.maxClaimableAmount}`;
  const legacyRefundPaymentId = `${funding.channelId}:${funding.maxClaimableAmount}`;
  const paymentIdentity =
    intent.paymentId === funding.paymentId
      ? "current"
      : intent.operation === "fund" && intent.paymentId === legacyFundPaymentId
        ? "legacy_fund"
        : intent.operation === "refund" && intent.paymentId === legacyRefundPaymentId
          ? "legacy_refund"
          : undefined;
  if (paymentIdentity === undefined) {
    throw new Error("x402 settlement retry does not match its durable credit effect");
  }
  return paymentIdentity;
}

function readUintString(value: Record<string, unknown>, key: string, fallback: string): string {
  const field = value[key];
  if (typeof field === "string" && /^\d+$/.test(field)) return field;
  if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) {
    return String(field);
  }
  return fallback;
}

function readUintNumber(value: Record<string, unknown>, key: string, fallback: number): number {
  const field = value[key];
  if (typeof field === "number" && Number.isSafeInteger(field) && field >= 0) return field;
  if (typeof field === "string" && /^\d+$/.test(field)) {
    const parsed = Number(field);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return fallback;
}

function withCachedSupportedResponse(
  facilitator: FacilitatorClient,
  supportedResponse: SupportedResponse
): FacilitatorClient {
  return {
    getSupported: () => Promise.resolve(supportedResponse),
    verify: (payload, requirements) => facilitator.verify(payload, requirements),
    settle: (payload, requirements) => facilitator.settle(payload, requirements),
  };
}

function decodeBatchPayment(header: string): PaymentPayload {
  const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as unknown;
  if (!isRecord(parsed) || parsed.x402Version !== 2 || !isRecord(parsed.accepted)) {
    throw new Error("invalid batch-settlement payment envelope");
  }
  if (
    parsed.accepted.scheme !== X402_BATCH_SETTLEMENT_SCHEME ||
    typeof parsed.accepted.network !== "string" ||
    !isRecord(parsed.payload)
  ) {
    throw new Error("invalid batch-settlement payment envelope");
  }
  if (
    !isBatchSettlementDepositPayload(parsed.payload) &&
    !isBatchSettlementVoucherPayload(parsed.payload) &&
    !isBatchSettlementRefundPayload(parsed.payload)
  ) {
    throw new Error("invalid batch-settlement payload");
  }
  const voucher = parsed.payload.voucher;
  // Upstream's payload guards check voucher field presence, not their types.
  if (
    typeof voucher.channelId !== "string" ||
    typeof voucher.maxClaimableAmount !== "string" ||
    typeof voucher.signature !== "string"
  ) {
    throw new Error("invalid batch-settlement voucher");
  }
  return parsed as PaymentPayload;
}

function batchVoucher(payload: Record<string, unknown>): {
  channelId: string;
  maxClaimableAmount: string;
} {
  if (
    !isBatchSettlementDepositPayload(payload) &&
    !isBatchSettlementVoucherPayload(payload) &&
    !isBatchSettlementRefundPayload(payload)
  ) {
    throw new Error("batch-settlement payload carries no voucher");
  }
  return payload.voucher;
}

async function clearPending(
  storage: ChannelStorage,
  channelId: string,
  pendingId: string | undefined
): Promise<void> {
  if (!pendingId) return;
  await storage.updateChannel(channelId, (current) => {
    if (!current || current.pendingRequest?.pendingId !== pendingId) return current;
    return { ...current, pendingRequest: undefined };
  });
}

/**
 * Release a reservation the refused request took, without ever deleting the row.
 *
 * A pre-verify snapshot is restored when one exists. When it does not — a cold
 * or rebuilt fleet meeting a channel whose row upstream's verify synthesised
 * from the facilitator's `extra` — the voucher on the row is the only payer
 * signature this fleet holds, good for `chargedCumulativeAmount` against a
 * running withdrawal window, so it stays. Deleting is wrong on the success path
 * too: `updateClaimedSessions` leaves `pendingRequest` set, so the guard below
 * still matches on a row that just recorded `totalClaimed`.
 */
async function restoreReservation(
  storage: ChannelStorage,
  channelId: string,
  pendingId: string | undefined,
  before: Channel | undefined
): Promise<void> {
  if (!pendingId) return;
  await storage.updateChannel(channelId, (current) => {
    if (!current || current.pendingRequest?.pendingId !== pendingId) return current;
    if (!before) return { ...current, pendingRequest: undefined };
    return {
      ...current,
      chargedCumulativeAmount: before.chargedCumulativeAmount,
      signedMaxClaimable: before.signedMaxClaimable,
      signature: before.signature,
      pendingRequest: undefined,
    };
  });
}

async function restoreRevokedVoucher(
  storage: ChannelStorage,
  channelId: string,
  pendingId: string | undefined,
  before: Channel | undefined
): Promise<void> {
  if (!before) return;
  await storage.updateChannel(channelId, (current) => {
    if (!current || (current.pendingRequest && current.pendingRequest.pendingId !== pendingId)) {
      return current;
    }
    return {
      ...current,
      chargedCumulativeAmount: before.chargedCumulativeAmount,
      signedMaxClaimable: before.signedMaxClaimable,
      signature: before.signature,
      pendingRequest: undefined,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
