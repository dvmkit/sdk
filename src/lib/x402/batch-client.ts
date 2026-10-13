import {
  decodePaymentResponseHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { BATCH_SETTLEMENT_ADDRESS, type ClientEvmSigner, toClientEvmSigner } from "@x402/evm";
import {
  BatchSettlementEvmScheme,
  computeChannelId,
  readChannelBalanceAndTotalClaimed,
} from "@x402/evm/batch-settlement/client";
import { createPublicClient, encodeAbiParameters, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as chains from "viem/chains";

import { DvmError } from "../errors";
import { resolveRpcHttpTransportOptions } from "../payment-rails/rpc";
import type { CreditOpResult } from "../transport/types";
import { redactUrlsInText } from "../url-redact";
import { X402_BATCH_CHANNEL_ABI } from "./batch-abi";
import { resolveX402ChannelRpc, type X402ChannelRpc } from "./channel-rpc";
import {
  DvmX402ChannelStorage,
  findX402Channel,
  listPendingX402FundingsForChannel,
  type PendingX402Funding,
  recordX402ChannelMetadata,
  type StoredX402ChannelConfig,
  type StoredX402ChannelMetadata,
  withX402ChannelLock,
  x402PendingRetired,
} from "./channel-store";
import { assertX402ChannelPayer } from "./lifecycle";
import { x402NetworkByCaip2, x402NetworkLabel } from "./networks";
import { X402_BATCH_SETTLEMENT_SCHEME } from "./spec";
import type { X402Wallet } from "./types";
import { isX402SettlementReconciliationReason } from "./types";
import {
  x402ChannelReservation,
  type X402VoucherFacts,
  x402VoucherFactsFromPayload,
} from "./voucher-cap";
import { assertNoRivalX402Voucher, type X402VoucherPendingState } from "./voucher-pending";

/** Signed payment, the channel it advances, and what its signature covers. */
export interface X402BatchPayment extends X402VoucherFacts {
  paymentHeader: string;
  channelId: `0x${string}`;
  scheme: BatchSettlementEvmScheme;
}

export async function createX402BatchPayment(args: {
  wallet: X402Wallet;
  paymentRequired: PaymentRequired;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  /** Deposit policy in token micro-units, raised to upstream's required minimum. */
  depositMicro: number;
}): Promise<X402BatchPayment> {
  const accepted = selectBatchRequirement(args.paymentRequired, args.wallet.network);
  const { scheme } = createScheme(args.wallet, args.depositMicro);
  const config = scheme.buildChannelConfig(accepted) as StoredX402ChannelConfig;
  const channelId = computeChannelId(config, accepted.network);
  assertNoRivalVoucher(channelId, args.creditId);
  // Before upstream reads `balance` to decide whether this payload is a deposit
  // or a voucher, and how large — a projection inflated by a refusal sizes the
  // top-up short.
  await reconcileLapsedRefusals(args.wallet, channelId);
  const created = await scheme.createPaymentPayload(2, accepted, {
    extensions: args.paymentRequired.extensions,
  });
  recordX402ChannelMetadata({
    channelId,
    endpoint: normalizeEndpoint(args.endpoint),
    callerPubkey: args.callerPubkey,
    creditId: args.creditId,
    network: accepted.network,
    config,
    updatedAt: Date.now(),
  });
  const payload: PaymentPayload = {
    ...created,
    resource: args.paymentRequired.resource,
    accepted,
    extensions: { ...args.paymentRequired.extensions, ...created.extensions },
  };
  const facts = x402VoucherFactsFromPayload(created.payload);
  if (!facts) {
    throw new DvmError(
      "x402_voucher_unreadable",
      "The signed x402 payload carries no cumulative voucher to journal.",
      "This is an upstream payload-shape change; do not retry until the CLI is updated."
    );
  }
  return {
    ...facts,
    paymentHeader: encodePaymentSignatureHeader(payload),
    channelId,
    scheme,
  };
}

function formatX402VoucherPendingRefusal(
  blocking: X402VoucherPendingState,
  data: Record<string, unknown> = {}
): DvmError {
  const base = {
    credit_id: blocking.creditId,
    fund_id: blocking.fundId,
    channel_id: blocking.channelId,
    ...data,
  };
  if (!blocking.retired) {
    return new DvmError(
      "x402_voucher_pending",
      `A signed x402 voucher for credit ${blocking.creditId} is still waiting for its acknowledgement, so this channel cannot sign another.`,
      `Retry that funding ('dvm credit fund ${blocking.endpoint} --credit-id ${blocking.creditId}'), or retire it with 'dvm wallet x402-clear-pending --credit-id ${blocking.creditId}' if the DVM is gone.`,
      base
    );
  }
  const until = new Date(blocking.blockedUntil).toISOString();
  const signedDeadline = blocking.depositExpiresAt !== undefined;
  return new DvmError(
    "x402_voucher_pending",
    signedDeadline
      ? `The deposit this channel signed for credit ${blocking.creditId} was refused by the DVM but can still be submitted, so the channel cannot sign a second one yet.`
      : `The funding this channel signed for credit ${blocking.creditId} was refused by the DVM, and it names no deadline after which it stops being submittable, so the channel cannot sign a second one yet.`,
    signedDeadline
      ? `Fund again after ${until}, when that authorization expires and this block lifts by itself.`
      : `Fund again after ${until} — a conservative cutoff this CLI picks when a signature carries no expiry of its own, not a deadline the DVM agreed to. The block lifts by itself then.`,
    { ...base, refused: true, funding_blocked_until: until }
  );
}

/** Advance durable cumulative state from a successful PAYMENT-RESPONSE. */
export async function processX402BatchResponse(
  scheme: BatchSettlementEvmScheme,
  paymentResponse: string | undefined
): Promise<void> {
  if (!paymentResponse) {
    throw new DvmError(
      "x402_payment_response_missing",
      "The DVM accepted prepaid-credit funding through x402 without a PAYMENT-RESPONSE header.",
      "Retry the same funding. Its signed voucher remains journalled verbatim and will not advance locally until the DVM acknowledges it."
    );
  }
  const response = decodePaymentResponseHeader(paymentResponse);
  const clearProvenance = storageForScheme(scheme).stageNextUnobservedBalanceProvenance(
    dvmBalanceProvenance(response)
  );
  try {
    await scheme.processSettleResponse(response);
  } finally {
    clearProvenance();
  }
}

/** Recreate the durable scheme and process an acknowledgement after a restart. */
export async function processX402BatchResponseForWallet(args: {
  wallet: X402Wallet;
  depositMicro: number;
  paymentResponse: string | undefined;
}): Promise<void> {
  const { scheme } = createScheme(args.wallet, args.depositMicro);
  await processX402BatchResponse(scheme, args.paymentResponse);
}

/**
 * Recover the local success transition when the original response was lost
 * and `/v1/credit` confirms the same `fund_id` as a replay. The replay is the
 * acknowledgement; the verbatim journal supplies the exact voucher/deposit
 * fields that its header no longer needs to echo.
 */
export async function acknowledgeReplayedX402Payment(paymentHeader: string): Promise<void> {
  const payment = decodePaymentSignatureHeader(paymentHeader);
  const payload = payment.payload as {
    type?: string;
    voucher?: { channelId?: string; maxClaimableAmount?: string };
    deposit?: { amount?: string };
  };
  const channelId = payload.voucher?.channelId;
  const charged = payload.voucher?.maxClaimableAmount;
  if (!channelId || charged === undefined) {
    throw new Error("Journalled x402 batch payment has no cumulative voucher");
  }
  const storage = new DvmX402ChannelStorage();
  const previous = (await storage.get(channelId)) ?? {};
  const deposited = payload.type === "deposit" ? BigInt(payload.deposit?.amount ?? "0") : 0n;
  const alreadyApplied = BigInt(previous.chargedCumulativeAmount ?? "0") >= BigInt(charged);
  const applied = alreadyApplied ? 0n : deposited;
  const context = {
    ...previous,
    chargedCumulativeAmount: charged,
    balance: (BigInt(previous.balance ?? "0") + applied).toString(),
  };
  // The one balance write on this rail that nothing authoritative backs. A
  // replay says the DVM's ledger holds this fund; it does not say the ERC-3009
  // authorization behind it ever reached the chain, and a DVM that refuses the
  // funding afterwards leaves the money in the wallet with this sum already
  // counting it. Stamped rather than withheld, because the figure is right in
  // the ordinary case and upstream sizes the next deposit from it — and the
  // stamp is what lets `reconcileRefusedX402Deposits` and the surfaces that
  // report the projection tell an observation from an assumption.
  //
  // The `alreadyApplied` pass writes `balance` back unchanged, so it observes
  // nothing and must leave the stamp alone. That branch is not hypothetical: it
  // is the crash window `fundOverX402` designs for, where the acknowledgement
  // lands and the journal clear does not, so the next run replays the same
  // header. Clearing there would certify the local sum on exactly the path
  // where it is most likely to be the drifted one.
  if (applied > 0n) await storage.setLocallyAppliedDeposit(channelId, context);
  else await storage.setUnchangedBalance(channelId, context);
}

/** What a `channels()` read did to one channel's stored balance projection. */
export interface X402ChannelReconciliation {
  channelId: `0x${string}`;
  /** The stored figure the read replaced, absent when the record held none. */
  previousBalanceMicro?: string;
  /** What the contract says the channel still holds, in token micro-units. */
  balanceMicro: string;
  /** What the contract says has already been claimed out of it. */
  totalClaimedMicro: string;
  /**
   * Refused candidate IDs associated with replacing the whole-channel projection,
   * not individually subtracted amounts. Only one is necessarily proven expired
   * and unused; the remaining authorizations may still be live.
   */
  fundIds: string[];
}

/**
 * Replace the channel projection from `channels()` only after a refused deposit
 * is expired and its nonce proven unused. Subtracting a local deposit would
 * not establish chain truth; reading while it can still land races submission.
 * Keep the authorized cumulative cursor, which the DVM may already have used.
 */
export async function reconcileRefusedX402Deposits(args: {
  wallet: X402Wallet;
  channelId: `0x${string}`;
  /** Journalled entries on that channel; only refused ones with a deposit qualify. */
  pending: PendingX402Funding[];
  nowSeconds?: number;
}): Promise<X402ChannelReconciliation | undefined> {
  const candidates = args.pending.filter(
    (entry) => x402PendingRetired(entry) && entry.depositMicro !== undefined
  );
  if (candidates.length === 0) return undefined;
  // One proof is the whole gate: `channels()` answers for the entire channel, so
  // a second lapsed entry changes nothing about the figure it returns. Probing
  // past the first would buy an extra `authorizationState` read per refused
  // entry on every funding, forever — a retired entry is never removed without
  // `--force`. An entry still inside its validity window costs no read at all,
  // since `canReplaceExpiredX402Deposit` refuses on the clock first.
  let proven = false;
  for (const entry of candidates) {
    proven = await canReplaceExpiredX402Deposit({
      wallet: args.wallet,
      paymentHeader: entry.paymentHeader,
      ...(args.nowSeconds !== undefined ? { nowSeconds: args.nowSeconds } : {}),
    });
    if (proven) break;
  }
  if (!proven) return undefined;
  // The channel's own chain, not today's pin — a re-pinned wallet must not send
  // this read to a chain where the settlement contract answers for a channel id
  // that never existed there.
  const network = findX402Channel({ channelId: args.channelId })?.network ?? args.wallet.network;
  const reader = channelChainReader(network, args.wallet.network);
  if (!reader) {
    throw new DvmError(
      "x402_unsupported_network",
      `The channel ${args.channelId} is recorded on ${network}, a chain this rail can't read.`,
      "Its stored balance stays marked as an unverified local figure until a chain this build understands can answer for it."
    );
  }
  const [balance, totalClaimed] = await reader.readContract({
    address: BATCH_SETTLEMENT_ADDRESS,
    abi: X402_BATCH_CHANNEL_ABI,
    functionName: "channels",
    args: [args.channelId],
  });
  const storage = new DvmX402ChannelStorage();
  const previous = await storage.get(args.channelId);
  await storage.reconcileChainState(args.channelId, {
    balance: balance.toString(),
    totalClaimed: totalClaimed.toString(),
  });
  return {
    channelId: args.channelId,
    ...(previous?.balance !== undefined ? { previousBalanceMicro: previous.balance } : {}),
    balanceMicro: balance.toString(),
    totalClaimedMicro: totalClaimed.toString(),
    fundIds: candidates.map((entry) => entry.fundId),
  };
}

/** Prove an expired journalled ERC-3009 deposit was never consumed onchain. */
export async function canReplaceExpiredX402Deposit(args: {
  wallet: X402Wallet;
  paymentHeader: string;
  nowSeconds?: number;
}): Promise<boolean> {
  const payment = decodePaymentSignatureHeader(args.paymentHeader);
  const payload = payment.payload as {
    type?: string;
    channelConfig?: { payer?: `0x${string}` };
    voucher?: { channelId?: `0x${string}` };
    deposit?: {
      authorization?: {
        erc3009Authorization?: { validBefore?: string; salt?: string };
      };
    };
  };
  const accepted = payment.accepted;
  const authorization = payload.deposit?.authorization?.erc3009Authorization;
  const channelId = payload.voucher?.channelId;
  const payer = payload.channelConfig?.payer;
  if (
    payload.type !== "deposit" ||
    !authorization?.validBefore ||
    authorization.salt === undefined ||
    !channelId ||
    !payer
  ) {
    return false;
  }
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (BigInt(authorization.validBefore) >= BigInt(now)) return false;

  const spec = x402NetworkByCaip2(accepted.network);
  if (accepted.asset.toLowerCase() !== spec?.usdc.toLowerCase()) return false;
  // The chain comes from the journalled authorization, not from today's pin, so
  // this read spans chains the same way the drain does — and takes the same
  // endpoint scoping.
  const client = channelChainReader(accepted.network, args.wallet.network);
  if (!client) return false;
  const nonce = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }],
      [channelId, BigInt(authorization.salt)]
    )
  );
  const consumed = await client.readContract({
    address: spec.usdc,
    abi: [
      {
        type: "function",
        name: "authorizationState",
        stateMutability: "view",
        inputs: [
          { name: "authorizer", type: "address" },
          { name: "nonce", type: "bytes32" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ],
    functionName: "authorizationState",
    args: [payer, nonce],
  });
  return !consumed;
}

/** Repair a stale cumulative base from the DVM's signed corrective challenge. */
export async function processX402BatchCorrection(args: {
  wallet: X402Wallet;
  paymentRequired: PaymentRequired;
  depositMicro: number;
}): Promise<boolean> {
  const { scheme } = createScheme(args.wallet, args.depositMicro);
  return scheme.processCorrectivePaymentRequired(args.paymentRequired);
}

/** A cooperative refund, and the outstanding claim authority it proceeded through. */
export interface X402RefundOutcome {
  result: CreditOpResult;
  paymentResponse: string;
  /** Channel value at risk to journalled vouchers, in token micro-units. */
  atRiskMicro: bigint;
  /** The journalled vouchers that exposure belongs to. */
  pendingFundings: PendingX402Funding[];
}

/**
 * Drive upstream's cooperative refund over dvmkit's signed POST `/v1/credit`
 * route. The adapter preserves upstream's probe/correction/retry lifecycle
 * while returning the DVM's credit result to the CLI.
 */
export async function refundX402BatchChannel(args: X402RefundArgs): Promise<X402RefundOutcome> {
  return withX402ChannelLock(() => refundX402BatchChannelLocked(args));
}

export interface X402RefundArgs {
  wallet: X402Wallet;
  endpoint: string;

  callerPubkey: string;

  creditId: string;
  depositMicro: number;
  post: (paymentHeader?: string) => Promise<CreditOpResult>;
}

async function refundX402BatchChannelLocked(args: X402RefundArgs): Promise<X402RefundOutcome> {
  let initialRequired: PaymentRequired;
  try {
    const replay = await args.post();
    // A drain the DVM has already settled needs no reservation: the money is
    // out and there is nothing left to hold back from.
    return {
      result: replay,
      paymentResponse: replay.x402PaymentResponse ?? "",
      atRiskMicro: 0n,
      pendingFundings: [],
    };
  } catch (err) {
    if (!(err instanceof DvmError)) throw err;
    const required = x402RequiredFromError(err);
    if (!required) throw err;
    initialRequired = required;
  }
  // Follow the channel that was recorded when it opened, not the one today's
  // config would derive. Both inputs to the derivation below are
  // mutable after the fact — a reconnect mints a fresh payer, `x402-network`
  // re-pins the chain — and the settlement contract shares one address across
  // chains, so a derivation that has drifted reads a channel that never existed
  // and answers (0, 0). That is indistinguishable from a channel the DVM has
  // emptied, which is how an untouched balance came to be reported as gone.
  //
  // The two halves diverge on what following means. A payer that no longer
  // matches is a dead end — only the recorded key can move the money — so it
  // refuses. A chain that no longer matches is not: the payer key is the same
  // key on either chain, and the only genuinely chain-bound pieces are which
  // challenge row is selected and which endpoint the read goes to. So the drain
  // follows the channel onto its own chain and a re-pin costs nothing, exactly
  // as `wallet x402-network` already promises.
  //
  // The credit-scoped lookup is the precise one. Keep the fallback for records
  // an older CLI relabelled after a refused cross-credit attempt: it is what the
  // timed exit already does, and it can only reach a channel the same payer
  // opened. The DVM challenge below still has to derive this exact channel.
  const recorded =
    findX402Channel({
      endpoint: args.endpoint,
      callerPubkey: args.callerPubkey,
      creditId: args.creditId,
    }) ?? findX402Channel({ endpoint: args.endpoint, callerPubkey: args.callerPubkey });
  if (recorded) {
    assertX402ChannelPayer(
      recorded,
      privateKeyToAccount(args.wallet.privateKey as `0x${string}`).address
    );
  }
  const network = recorded?.network ?? args.wallet.network;
  const { scheme, signer, rpc } = createScheme(
    args.wallet,
    args.depositMicro,
    network,
    recorded?.config.salt
  );
  const accepted = selectBatchRequirement(initialRequired, network, recorded);
  const config = scheme.buildChannelConfig(accepted);
  const channelId = computeChannelId(config, accepted.network);
  assertRecordedChannel(recorded, channelId);
  const journalled = listPendingX402FundingsForChannel(channelId);
  let atRiskMicro: bigint;
  // Only the chain read in this block can be broken by the endpoint; what
  // follows it is arithmetic and a local write, where naming the RPC scoping
  // would read as an explanation for a failure it had no part in.
  let readingChain = true;
  try {
    const [balance, totalClaimed] = await readChannelBalanceAndTotalClaimed(signer, channelId);
    readingChain = false;
    if (balance <= totalClaimed) {
      throw new Error(
        `the DVM has already claimed this channel's escrow (balance=${String(balance)}, totalClaimed=${String(totalClaimed)})`
      );
    }
    // A voucher the DVM has not acknowledged is claim authority it may still
    // exercise, and upstream persists nothing at signing time — so the local
    // channel record understates what this channel still owes and the journal
    // is the only place that figure exists. The drain proceeds
    // because that already-signed authority exists in either posture, but the
    // caller needs the figure before closing the channel forecloses a retry.
    //
    // Read under the channel lock the refund already holds, so an entry cannot
    // be written between this report and the settlement it describes.
    const reserved = x402ChannelReservation(journalled, totalClaimed);
    // Cap the reported figure at the balance: on the fail-closed
    // `x402VoucherCap` path `reserved` is `MAX_UINT128`, and the raw difference
    // would reach the caller — and whatever agent relays it — as a nonsense
    // USDC amount. An unreadable authorization puts the whole balance at risk.
    atRiskMicro = (reserved > balance ? balance : reserved) - totalClaimed;
    const storage = new DvmX402ChannelStorage();
    const previous = (await storage.get(channelId)) ?? {};
    await storage.setRefundProbe(channelId, {
      ...previous,
      balance: balance.toString(),
      totalClaimed: totalClaimed.toString(),
      // Seed the first voucher at the contract's floor purely so upstream's
      // own `balance <= charged` guard lets the request out. How much comes
      // back is the DVM's to decide: it settles against a base derived from
      // the credit it owes, and corrects this one over a 402 when they differ
      // Deliberately no `amount` below, for the same reason.
      //
      // The exposure above deliberately does *not* raise this seed. The
      // voucher signed here is fresh claim authority handed to the DVM, and
      // minting it up to a cap the DVM may never have received would create
      // the very hazard the report exists to expose. It is information for the
      // caller, never a larger signature or a gate on the drain.
      chargedCumulativeAmount: totalClaimed.toString(),
    });
  } catch (err) {
    throw x402RefundError(err, { network, rpc, endpointInPath: readingChain });
  }
  let result: CreditOpResult | undefined;
  let responseHeader: string | undefined;
  // The DVM's own terminal answer to the last post, if it gave one. Whatever
  // upstream's scheme throws afterwards is flattened below into
  // `x402_refund_failed`, whose hint sends the caller to the 24-hour on-chain
  // exit — the wrong advice for every refusal the credit route answers from
  // inside `accept()`, which a retry, a re-sign or simply waiting would clear
  // Held verbatim so the code, copy and `data` reach `credit.ts`,
  // whose unwind branches read `drain_id_retired` and `drain_registered`.
  //
  // Reassigned on every answer rather than only ever set, so a refusal from an
  // earlier attempt can't outlive the correction that cleared it: upstream
  // retries the refund once after a recoverable 402.
  let dvmRefusal: DvmError | undefined;
  const responseStorage = storageForScheme(scheme);
  let clearResponseProvenance: (() => void) | undefined;
  let probePending = true;
  const adaptedFetch: typeof fetch = async (_input, init) => {
    const payment = new Headers(init?.headers).get("PAYMENT-SIGNATURE") ?? undefined;
    if (!payment && probePending) {
      probePending = false;
      return new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(initialRequired) },
      });
    }
    try {
      result = await args.post(payment);
      // A refusal from an earlier attempt is stale the moment the DVM answers
      // with a drain record. Upstream can still fail this call afterwards — a
      // 200 carrying no `PAYMENT-RESPONSE` is one way — and reporting that
      // superseded refusal as the reason would name a state the DVM has since
      // moved past.
      dvmRefusal = undefined;
      responseHeader = result.x402PaymentResponse;
      clearResponseProvenance?.();
      clearResponseProvenance = responseHeader
        ? responseStorage.stageNextUnobservedBalanceProvenance("unreconciled")
        : undefined;
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...(responseHeader ? { "PAYMENT-RESPONSE": responseHeader } : {}),
        },
      });
    } catch (err) {
      if (!(err instanceof DvmError)) throw err;
      const required = x402RequiredFromError(err);
      dvmRefusal = isTerminalDvmRefusal(err, required) ? err : undefined;
      if (required) {
        return new Response(JSON.stringify({ error: err.code }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(required) },
        });
      }
      throw err;
    }
  };
  let settled;
  try {
    settled = await scheme.refund(`${normalizeEndpoint(args.endpoint)}/v1/credit`, {
      fetch: adaptedFetch,
    });
  } catch (err) {
    // A record the DVM gave us outlives whatever upstream makes of the envelope
    // it arrived in. The clearest way there is a drain that flipped
    // to `sent` between the header-less probe and this signed post — a
    // concurrent operator repair does exactly that — so the DVM answers from a
    // path that books no fresh settlement and attaches no `PAYMENT-RESPONSE`,
    // which upstream treats as fatal on a 200. Reporting that as
    // `x402_refund_failed` tells the caller their money is still in the channel
    // and sends them to the 24-hour exit, when the money has already moved.
    //
    // A refusal wins, because `dvmRefusal` is cleared on every answered post:
    // one that is still set is the DVM's own latest word, and `result` behind it
    // is a superseded earlier attempt. With neither, the scheme failed on its
    // own terms — upstream holds the same resolved endpoint and reads the
    // channel through it while refunding, so that one is in the endpoint's path.
    //
    // The residual is upstream's local channel record, which keeps the refund
    // probe's seed rather than absorbing a settlement it never saw. That is
    // already the posture of the settled-replay path at the top of this
    // function, which returns before writing anything at all.
    if (dvmRefusal || !result) {
      throw dvmRefusal ?? x402RefundError(err, { network, rpc, endpointInPath: true });
    }
  } finally {
    clearResponseProvenance?.();
  }
  // Not a live branch: upstream resolves only after a post the DVM answered,
  // and the catch above rethrows when there wasn't one. It stays as the
  // narrowing that lets the return below read `result` directly, so the
  // impossible case is a typed assertion rather than a silent non-null claim.
  if (!result) {
    throw x402RefundError(new Error("cooperative refund returned no credit response"), {
      network,
      rpc,
    });
  }
  const encoded = responseHeader ?? (settled ? encodePaymentResponseHeader(settled) : "");
  return { result, paymentResponse: encoded, atRiskMicro, pendingFundings: journalled };
}

export function x402RequiredFromError(err: DvmError): PaymentRequired | undefined {
  const raw = err.data?.x402_payment_required;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as PaymentRequired;
}

/**
 * Assert that a DVM challenge still derives the channel recorded for this
 * payer. No payload is created or signed: callers use this to validate a
 * stale-credit fallback before treating its chain as the credit's own.
 */
export function assertX402RequirementDescribesChannel(args: {
  wallet: X402Wallet;
  paymentRequired: PaymentRequired;
  recorded: StoredX402ChannelMetadata;
  depositMicro: number;
}): void {
  assertX402ChannelPayer(
    args.recorded,
    privateKeyToAccount(args.wallet.privateKey as `0x${string}`).address
  );
  const accepted = selectBatchRequirement(
    args.paymentRequired,
    args.recorded.network,
    args.recorded
  );
  const { scheme } = createScheme(
    args.wallet,
    args.depositMicro,
    args.recorded.network,
    args.recorded.config.salt
  );
  const config = scheme.buildChannelConfig(accepted);
  const channelId = computeChannelId(config, accepted.network);
  assertRecordedChannel(args.recorded, channelId);
}

const schemeStorage = new WeakMap<BatchSettlementEvmScheme, DvmX402ChannelStorage>();

function dvmBalanceProvenance(response: {
  extra?: Record<string, unknown>;
}): "unreconciled" | "unchanged" {
  const channelState = response.extra?.channelState;
  return typeof channelState === "object" &&
    channelState !== null &&
    "balance" in channelState &&
    channelState.balance !== undefined
    ? "unreconciled"
    : "unchanged";
}

function storageForScheme(scheme: BatchSettlementEvmScheme): DvmX402ChannelStorage {
  const storage = schemeStorage.get(scheme);
  if (!storage) throw new Error("x402 batch scheme has no dvmkit channel storage");
  return storage;
}

/**
 * Refuse when the channel this drain is about to sign against is not the one the
 * caller funded.
 *
 * The payer is pinned to the record by the time this runs and the chain is the
 * record's own, so what is left is the half of the tuple the DVM supplies in
 * its challenge — its
 * payout address, its authorizer, the token, the withdraw delay. Any of those
 * moving since the channel opened yields a different id, and the old channel is
 * then reachable only through the timed exit, which reads the recorded config
 * verbatim. Saying so beats reading the new id's empty balance as a claim
 * against the old one.
 */
function assertRecordedChannel(
  recorded: StoredX402ChannelMetadata | undefined,
  derived: `0x${string}`
): void {
  if (!recorded || recorded.channelId.toLowerCase() === derived.toLowerCase()) return;
  throw new DvmError(
    "x402_channel_mismatch",
    `${recorded.endpoint} now offers channel terms that do not describe the channel this credit funded — its settlement address, authorizer, token or withdraw delay has changed since ${recorded.channelId} was opened.`,
    `The recorded channel's balance is untouched, but the DVM can no longer be asked to return it cooperatively. Recover it on-chain: 'dvm wallet x402-withdraw-initiate --channel-id ${recorded.channelId}', then finalize after the delay.`,
    {
      anchor: "x402_channel_terms_changed",
      channel_id: recorded.channelId,
      derived_channel_id: derived,
      endpoint: recorded.endpoint,
      network: recorded.network,
    },
    `This service's payment channel details have changed since your prepaid balance was funded, so it can't hand the balance back on request any more. The money is still yours and still on the chain — it comes back through the slower timed withdrawal instead.`
  );
}

/**
 * A read-only viem client on a channel's own chain, scoped the way every other
 * cross-chain x402 read is: `DVM_X402_RPC_URL` stays on the pinned chain and
 * every other chain goes through its bundled endpoint. `undefined`
 * when this build knows no such chain, which every caller answers for itself.
 */
function channelChainReader(network: string, walletNetwork: string) {
  const spec = x402NetworkByCaip2(network);
  if (!spec) return undefined;
  const chain = chains[spec.viemChain as keyof typeof chains] as Parameters<
    typeof createPublicClient
  >[0]["chain"];
  const { url, source } = resolveX402ChannelRpc(
    network,
    walletNetwork,
    chain?.rpcUrls.default.http[0]
  );
  const transportOptions = resolveRpcHttpTransportOptions(
    source,
    process.env.DVM_X402_RPC_HEADERS_JSON
  );
  return createPublicClient({
    chain,
    transport: transportOptions ? http(url, transportOptions) : http(url),
  });
}

/**
 * Repair the stored projection before upstream sizes the next deposit from it.
 *
 * Placed after the rival-voucher gate, which is what makes the read productive:
 * anything refused that is still blocking has already thrown, so a refused
 * entry reaching here is one whose deposit authorization is past its deadline —
 * exactly the state {@link reconcileRefusedX402Deposits} can prove. A chain that
 * doesn't answer is never a reason to refuse the funding: the record keeps its
 * unreconciled stamp and the next attempt tries again.
 */
async function reconcileLapsedRefusals(
  wallet: X402Wallet,
  channelId: `0x${string}`
): Promise<void> {
  const pending = listPendingX402FundingsForChannel(channelId);
  if (!pending.some((entry) => x402PendingRetired(entry) && entry.depositMicro !== undefined)) {
    return;
  }
  try {
    await reconcileRefusedX402Deposits({ wallet, channelId, pending });
  } catch {
    // Reporting is not worth a funding refusal; the stamp already says the
    // stored figure is a local sum rather than an observation.
  }
}

function createScheme(
  wallet: X402Wallet,
  depositMicro: number,
  /**
   * Chain this scheme acts on: the recorded channel's own on the drain path,
   * which spans chains, and the wallet's pin everywhere else, which cannot.
   */
  network: string = wallet.network,
  /** Salt recorded when the channel opened; absent when nothing is on record. */
  recordedSalt?: `0x${string}`
): {
  scheme: BatchSettlementEvmScheme;
  signer: ClientEvmSigner;
  rpc: X402ChannelRpc;
} {
  const spec = x402NetworkByCaip2(network);
  if (!spec) throw new DvmError("x402_unsupported_network", `Unsupported x402 network ${network}.`);
  const chain = chains[spec.viemChain as keyof typeof chains] as Parameters<
    typeof createPublicClient
  >[0]["chain"];
  // `DVM_X402_RPC_URL` is a single global URL, so it keeps exactly its
  // pre-existing scope — the pinned chain — and every other chain is reached
  // through its bundled endpoint. Sending a channel's read to another chain's
  // endpoint does not error: the settlement contract shares one address across
  // chains, so it finds the real contract, misses the channel id and answers
  // `(0, 0)` — a funded channel reported as one the DVM has already claimed
  // Following the channel onto its own chain is only safe
  // because the endpoint follows it too.
  const rpc = resolveX402ChannelRpc(network, wallet.network, chain?.rpcUrls.default.http[0]);
  const url = rpc.url;
  const transportOptions = resolveRpcHttpTransportOptions(
    rpc.source,
    process.env.DVM_X402_RPC_HEADERS_JSON
  );
  const publicClient = createPublicClient({
    chain,
    transport: transportOptions ? http(url, transportOptions) : http(url),
  });
  const account = privateKeyToAccount(wallet.privateKey as `0x${string}`);
  const signer = toClientEvmSigner(account, publicClient);
  const storage = new DvmX402ChannelStorage();
  // Deriving is how a channel is *opened*; a channel that already exists is
  // followed by its recorded salt instead, so the formula changing under a
  // caller who is mid-channel cannot silently point them at a different one.
  const salt =
    recordedSalt ??
    keccak256(toBytes(`dvmkit:x402-batch:${network}:${account.address.toLowerCase()}`));
  const scheme = new BatchSettlementEvmScheme(signer, {
    storage,
    salt,
    // Use at least the policy amount and upstream minimum, rather than its 5x default.
    depositStrategy: ({ minimumDepositAmount }) =>
      (BigInt(minimumDepositAmount) > BigInt(depositMicro)
        ? BigInt(minimumDepositAmount)
        : BigInt(depositMicro)
      ).toString(),
    ...(url ? { rpcUrl: url } : {}),
  });
  schemeStorage.set(scheme, storage);
  return { scheme, signer, rpc };
}

/**
 * Preserve structured DVM refusals verbatim instead of replacing their recovery
 * metadata with a timed-exit error. Challenge-bearing answers normally belong
 * to upstream's re-signing handshake; settlement-reconciliation refusals are
 * terminal exceptions. Without a challenge, boolean data.retryable identifies
 * a structured answer, while transport failures retain the timed-exit fallback.
 */
function isTerminalDvmRefusal(err: DvmError, required: PaymentRequired | undefined): boolean {
  if (required) return isX402SettlementReconciliationReason(err.code);
  return typeof err.data?.retryable === "boolean";
}

/** Where a failed drain was talking to — absent before the chain is chosen. */
interface X402RefundChain {
  network: string;
  rpc: X402ChannelRpc;
  /** Whether the endpoint was in this failure's path, so naming it explains it. */
  endpointInPath?: boolean;
}

function x402RefundError(err: unknown, chain?: X402RefundChain): DvmError {
  if (err instanceof DvmError && err.code === "x402_refund_failed") return err;
  // The drain's chain read goes over the caller's own `DVM_X402_RPC_URL`, and
  // viem prints its own `URL:` line into the message — with the provider API
  // key in the path — so the text needs the same sweep every sibling x402
  // reader applies. Both copies matter: `handleError` spreads
  // `data` to the top level of the JSON error, so `cause` is a second one.
  const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
  // Said only where an endpoint could plausibly be the cause and the caller's
  // override silently wasn't it: the drain follows the channel onto its own
  // chain, so a channel opened elsewhere reads through that chain's bundled
  // endpoint. Naming that beats leaving them tuning a knob that was
  // never in this path — but saying it over a failure the endpoint had no part
  // in, like an escrow the DVM has already claimed, is worse than silence.
  const scoping =
    chain?.endpointInPath && chain.rpc.overrideOutOfScope
      ? ` DVM_X402_RPC_URL did not apply here: it stays on the chain the wallet is pinned to, and this channel is on ${x402NetworkLabel(chain.network)}.`
      : "";
  return new DvmError(
    "x402_refund_failed",
    `The x402 channel could not complete its cooperative refund: ${cause}`,
    `Retry 'dvm credit drain <dvm>'.${scoping} If the DVM remains unavailable, use 'dvm wallet x402-withdraw-initiate <dvm>' to start the timed on-chain fallback.`,
    { cause, ...(chain ? { network: chain.network, rpc_source: chain.rpc.source } : {}) },
    "The DVM could not cooperatively return this x402 channel balance. The funds remain in the channel and can still be recovered with the timed withdrawal fallback."
  );
}

/**
 * Unacknowledged rival funding can otherwise create a second independently
 * spendable deposit nonce. Check channel identity across endpoint/credit scopes.
 * Live same-credit entries are allowed here; callers own verbatim replay.
 * Retired entries keep blocking until their authorization is no longer live.
 */
function assertNoRivalVoucher(channelId: `0x${string}`, creditId: string): void {
  const pending = listPendingX402FundingsForChannel(channelId);
  try {
    assertNoRivalX402Voucher(channelId, creditId, pending);
  } catch (state) {
    if (
      typeof state !== "object" || state === null ||
      !("code" in state) || state.code !== "x402_voucher_pending" ||
      !("creditId" in state) || typeof state.creditId !== "string" ||
      !("fundId" in state) || typeof state.fundId !== "string" ||
      !("channelId" in state) || typeof state.channelId !== "string" ||
      !("endpoint" in state) || typeof state.endpoint !== "string" ||
      !("retired" in state) || typeof state.retired !== "boolean" ||
      !("blockedUntil" in state) || typeof state.blockedUntil !== "number"
    ) {
      throw state;
    }
    // Keep caller output unchanged while the shared gate exposes only facts.
    throw formatX402VoucherPendingRefusal(state as X402VoucherPendingState);
  }
}

/**
 * Pick the challenge row this operation settles through, on the chain it acts
 * on.
 *
 * The refusal splits on whether a channel is already open there. Without one
 * the chain is simply the wallet's pin and re-pinning is the remedy. With one,
 * re-pinning is no remedy at all — the drain already follows the channel onto
 * its own chain, so a DVM that has retired that chain has retired the
 * cooperative route to this balance, and the timed exit is what is left.
 * Reusing the pin's copy there would send the caller to a command that changes
 * nothing.
 */
function selectBatchRequirement(
  required: PaymentRequired,
  network: string,
  /** The channel this operation is closing, when one is on record. */
  recorded?: StoredX402ChannelMetadata
): PaymentRequirements {
  const accepted = required.accepts.find(
    (entry) => entry.scheme === X402_BATCH_SETTLEMENT_SCHEME && entry.network === network
  );
  if (accepted) return accepted;
  const networkCopy = x402NetworkLabel(network);
  if (recorded) {
    throw new DvmError(
      "x402_batch_not_offered",
      `${recorded.endpoint} no longer offers a batch-settlement channel on ${networkCopy}, the chain the channel backing this credit was opened on.`,
      `A channel stays on the chain it was opened on, so re-pinning the wallet cannot reach it. Its balance is untouched: recover it on-chain with 'dvm wallet x402-withdraw-initiate --channel-id ${recorded.channelId}', then finalize after the delay.`,
      {
        anchor: "x402_batch_chain_retired",
        channel_id: recorded.channelId,
        endpoint: recorded.endpoint,
        network: recorded.network,
      },
      "This service no longer settles payment channels on the chain your prepaid balance was funded on, so it can't hand that balance back on request any more. The money is still yours and still on the chain — it comes back through the slower timed withdrawal instead."
    );
  }
  throw new DvmError(
    "x402_batch_not_offered",
    `The DVM offered no batch-settlement channel on the wallet's ${networkCopy} network.`,
    `This DVM does not take x402 channel funding on ${networkCopy}. Fund over another rail, or re-pin the connected x402 wallet to a chain this DVM settles ('dvm wallet x402-network <caip2>').`
  );
}

function normalizeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint.replace(/\/+$/, "");
  }
}
