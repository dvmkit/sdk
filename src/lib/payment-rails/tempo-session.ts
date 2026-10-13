import { Credential } from "mppx";
import { Mppx } from "mppx/client";
import { Session as TempoSession } from "mppx/tempo";
import { type Chain, decodeFunctionData, formatUnits, isAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";

import { costAnchor, formatUsd, formatUsdcMicrounits } from "../currency";
import { DvmError } from "../errors";
import type { MppxChallenge } from "../messages/types";
import type { CreditMenu } from "../transport/types";
import { redactUrl, redactUrlsInText } from "../url-redact";
import { resolveRpcHttpTransportOptions, resolveRpcOverride, type RpcSource } from "./rpc";
import {
  createTempoChannelStore,
  loadTempoChannelAssociation,
  loadTempoChannelAssociationByKey,
  loadTempoChannelEntry,
  retireTempoChannel,
  retireTempoChannelScope,
  type TempoChannelAssociation,
  tempoChannelControlledBy,
  type TempoChannelController,
  tempoDescriptorController,
  withTempoChannelLock,
} from "./tempo-channel-store";
import { type TempoAccount, tempoBalanceCheckHint, tempoTokenReference } from "./tempo-wallet";
import { maxAdvertisedMicro, withinAdvertisedTolerance } from "./types";

export function offersTempoCreditSession(menu: CreditMenu | undefined): boolean {
  return (
    menu?.tempo?.methods.some(
      (candidate) => candidate.method === "tempo" && candidate.intent === "session"
    ) === true
  );
}

export function offersTempoCreditCharge(menu: CreditMenu | undefined): boolean {
  return (
    menu?.tempo?.methods.some(
      (candidate) => candidate.method === "tempo" && candidate.intent === "charge"
    ) === true
  );
}

/**
 * True when a credit menu names `tempo/session` under `withheld` — the DVM is
 * configured for reusable sessions and is pausing them.
 *
 * Distinct from "absent", and the distinction is what a caller acts on. The
 * pause covers *new* channels only, so a caller already holding an open channel
 * on this credit may still top it up: the DVM issues that credit a session
 * challenge, and a one-shot charge is refused against a channel-bound credit
 * anyway. Absent means the DVM never offered sessions at all, where attempting
 * one buys nothing.
 */
export function withholdsTempoCreditSession(menu: CreditMenu | undefined): boolean {
  return (
    menu?.tempo?.withheld?.some(
      (candidate) => candidate.method === "tempo" && candidate.intent === "session"
    ) === true
  );
}

export function offersTempoCreditFunding(menu: CreditMenu | undefined): boolean {
  return offersTempoCreditSession(menu) || offersTempoCreditCharge(menu);
}

export type TempoSessionClientResolver = NonNullable<
  NonNullable<Parameters<typeof TempoSession.Client.session>[0]>["getClient"]
>;
type TempoSessionMethod = ReturnType<typeof TempoSession.Client.session>;
type TempoSessionChallenge = Parameters<TempoSessionMethod["createCredential"]>[0]["challenge"];

/** Fetch shape used by mppx's challenge-aware Tempo session wrapper. */
export type TempoSessionPaymentFetch = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/** Caller-side scope that keeps mppx's reusable key local to one DVM operator. */
export interface TempoSessionChannelScope {
  channelKey: string;
  operator: string;
}

export function createTempoCreditSession(args: {
  account: TempoAccount;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  maxDepositMicro: number;
  topUpAmountMicro: number;
  operator?: string;
  getClient?: TempoSessionClientResolver;
}): ReturnType<typeof TempoSession.Client.session> {
  return TempoSession.Client.session({
    account: privateKeyToAccount(args.account.privateKey),
    channelStore: createTempoChannelStore({
      endpoint: args.endpoint,
      callerPubkey: args.callerPubkey,
      creditId: args.creditId,
      operator: args.operator ?? zeroAddress,
    }),
    maxDeposit: formatUnits(BigInt(args.maxDepositMicro), 6),
    topUpAmount: formatUnits(BigInt(args.topUpAmountMicro), 6),
    ...(args.getClient ? { getClient: args.getClient } : {}),
  });
}

/** Wrap a credit POST bridge so mppx runs its automatic open/top-up hooks. */
export function createTempoSessionPaymentFetch(
  method: TempoSessionMethod,
  fetch: typeof globalThis.fetch
): TempoSessionPaymentFetch {
  return Mppx.create({
    methods: [method],
    fetch,
    maxPaymentRetries: 5,
    polyfill: false,
  }).fetch;
}

/** Resolve mppx's payment key together with the DVM operator that may reuse it. */
export function tempoSessionChallengeChannelScope(
  challenge: TempoSessionChallenge | undefined
): TempoSessionChannelScope | undefined {
  if (!challenge) return undefined;
  const request = challenge.request as
    | {
        currency?: unknown;
        recipient?: unknown;
        methodDetails?: unknown;
      }
    | undefined;
  if (
    typeof request?.recipient !== "string" ||
    !isAddress(request.recipient, { strict: false }) ||
    typeof request.currency !== "string" ||
    !isAddress(request.currency, { strict: false })
  ) {
    return undefined;
  }
  const methodDetails =
    request.methodDetails && typeof request.methodDetails === "object"
      ? (request.methodDetails as {
          chainId?: unknown;
          escrow?: unknown;
          escrowContract?: unknown;
          operator?: unknown;
        })
      : undefined;
  const chainId = methodDetails?.chainId;
  if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return undefined;
  }
  const challengeEscrow = [methodDetails?.escrowContract, methodDetails?.escrow].find(
    (candidate): candidate is string =>
      typeof candidate === "string" && isAddress(candidate, { strict: false })
  );
  const escrow = challengeEscrow ?? TempoSession.Precompile.Constants.tip20ChannelEscrow;
  const operator = methodDetails?.operator;
  if (
    operator !== undefined &&
    (typeof operator !== "string" || !isAddress(operator, { strict: false }))
  ) {
    return undefined;
  }
  return {
    channelKey: `${request.recipient.toLowerCase()}:${request.currency.toLowerCase()}:${escrow.toLowerCase()}:${String(chainId)}`,
    operator: operator?.toLowerCase() ?? zeroAddress,
  };
}

/** Resolve the operator-local payment scope carried by a saved session credential. */
export function tempoSessionCredentialChannelScope(
  credential: string
): TempoSessionChannelScope | undefined {
  try {
    return tempoSessionChallengeChannelScope(
      Credential.deserialize(credential).challenge as TempoSessionChallenge
    );
  } catch {
    return undefined;
  }
}

/** Find the existing channel a Tempo session challenge or credential will actually reuse. */
export function tempoSessionAssociationByKey(args: {
  endpoint: string;
  callerPubkey: string;
  channelScope: TempoSessionChannelScope | undefined;
  creditId: string;
}): TempoChannelAssociation | undefined {
  return args.channelScope
    ? loadTempoChannelAssociationByKey(
        args.callerPubkey,
        args.channelScope.operator,
        args.channelScope.channelKey
      )
    : loadTempoChannelAssociation(args.endpoint, args.callerPubkey, args.creditId);
}

/**
 * What the reusable channel this funding will use has already authorized,
 * in USD micro-units — the cumulative every ceiling on this leg is rebased over.
 *
 * A provisional entry (`opened: false`, written before an open is broadcast)
 * reads as zero, because nothing on it has been authorized yet.
 */
export function tempoSessionPriorCumulativeMicro(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  association?: TempoChannelAssociation;
}): number {
  const association =
    args.association ??
    loadTempoChannelAssociation(args.endpoint, args.callerPubkey, args.creditId);
  if (!association?.opened) return 0;
  const prior = BigInt(association.cumulativeAmount);
  if (prior < 0n || prior > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DvmError("payment_invalid", "The Tempo channel's cumulative amount is out of range.");
  }
  return Number(prior);
}

/** Rebase one funding allowance over a reusable channel's cumulative authorization. */
export function tempoSessionCumulativeCapMicro(args: {
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  allowanceMicro: number;
  amountMicro: number;
  association?: TempoChannelAssociation;
}): number {
  const prior = BigInt(tempoSessionPriorCumulativeMicro(args));
  const amount = BigInt(Math.max(0, args.amountMicro));
  const explicitAllowance = BigInt(Math.max(args.allowanceMicro, args.amountMicro));
  // `maxDeposit` is also mppx's maximum voucher amount. The DVM's challenge
  // can legitimately sit a little above the caller's dollar ask because the
  // two sides convert through BTC/USD at different moments; every other Tempo
  // guard accepts that shared stablecoin tolerance. Give mppx enough room for
  // the same accepted challenge, while preserving a larger explicit channel
  // allowance as a hard cap rather than adding another 10% to it.
  const allowance = explicitAllowance > amount ? explicitAllowance : maxAdvertisedMicro(amount);
  const cap = prior + allowance;
  if (cap > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DvmError("payment_invalid", "The Tempo session deposit cap is out of range.");
  }
  return Number(cap);
}

/**
 * The on-chain deposit a session credential actually commits, in USD
 * micro-units — the collateral the caller's wallet locks if this credential
 * reaches the DVM or the chain.
 *
 * The session twin of `tempoCredentialAmountMicro`: read what the credential
 * authorizes rather than what the caller asked for, because mppx is free to
 * open at the DVM's `suggestedDeposit` (clamped to `maxDeposit`) and top up by
 * its own headroom arithmetic, so the two figures legitimately differ. An open
 * carries the deposit only inside its signed transaction's escrow calldata; a
 * top-up names it outright; a voucher or a close moves no collateral at all.
 *
 * Throws `DvmError("tempo_session_deposit_unreadable", ...)` when a credential
 * that does commit collateral will not say how much — refusing to broadcast an
 * unreadable deposit is the safe answer.
 */
export function tempoSessionCredentialDepositMicro(credential: string): number {
  return readSessionDeposit(credential).depositMicro;
}

/**
 * Refuse to broadcast a session credential that would push the credit's
 * channel deposit above the cap the caller authorized.
 *
 * mppx applies that cap before it signs, on every automatic path — its open
 * clamps the DVM's `suggestedDeposit` to it and refuses a challenge amount
 * over it, and its top-up refills only the headroom left under it. This is the
 * belt: dvmkit has no hook between mppx's plan and its signature, so the check
 * lands on the figure the finished credential commits, which is also the only
 * figure that can be read rather than trusted. Pre-broadcast is still binding
 * for a deposit — this bridge is the sole conduit to the DVM and the chain, so
 * a signed transaction that is never sent locks nothing. The voucher
 * cumulative rides in a signature rather than a transaction, so it is guarded on
 * both sides of the signing instead: {@link assertTempoSessionChallengeWithinAsk}
 * before and {@link assertTempoSessionVoucherWithinAsk} after.
 */
export function assertTempoSessionDepositWithinCap(args: {
  credential: string;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  capMicro: number;
  channelScope?: TempoSessionChannelScope;
}): void {
  const { action, depositMicro } = readSessionDeposit(args.credential);
  if (depositMicro === 0) return;
  // A top-up adds to collateral already locked; an open is the whole channel.
  const priorMicro =
    action === "topUp"
      ? Number(
          (args.channelScope
            ? loadTempoChannelAssociationByKey(
                args.callerPubkey,
                args.channelScope.operator,
                args.channelScope.channelKey
              )
            : loadTempoChannelAssociation(args.endpoint, args.callerPubkey, args.creditId)
          )?.deposit ?? 0
        )
      : 0;
  const committedMicro = priorMicro + depositMicro;
  if (committedMicro <= args.capMicro) return;
  const committedUsd = committedMicro / 1e6;
  const capUsd = args.capMicro / 1e6;
  throw new DvmError(
    "tempo_session_deposit_exceeds_limit",
    `This Tempo session would lock $${formatUsd(committedUsd)} of channel collateral, above the $${formatUsd(capUsd)} this funding authorized.`,
    "Nothing was sent and no collateral moved. Fund a smaller amount, or ask the DVM operator why its session asks for a deposit this size.",
    {
      committed_usdc_microunits: String(committedMicro),
      max_usdc_microunits: String(args.capMicro),
      anchor: costAnchor(committedUsd),
      display: `Funding refused: the DVM's Tempo session would lock $${formatUsd(committedUsd)} of on-chain collateral, over the $${formatUsd(capUsd)} authorized for this funding.`,
    }
  );
}

/**
 * Refuse a session challenge that asks for materially more than the funding it
 * is paying for — before mppx signs anything.
 *
 * The deposit ceiling above bounds the collateral a channel locks; this bounds
 * the money the DVM can actually capture out of it. They are different numbers
 * on purpose: the caller's per-channel allowance is deliberately sized above one
 * funding so auto-top-up has headroom, and mppx spends that one figure as both
 * its deposit ceiling and its voucher ceiling — so a challenge naming several
 * times the ask signs cleanly under it.
 *
 * The basis is the funding ask, and the figure measured against it is the
 * challenge amount, because that amount is always the *delta*: on an open it
 * becomes the whole cumulative, on a reused channel mppx adds it to a cumulative
 * the caller already authorized. The tolerance is the shared stablecoin one —
 * both sides convert dollars from their own BTC/USD rate, so a small
 * disagreement is legitimate and a large one is a different price.
 *
 * Pre-signature is not pre-collateral: a session can re-challenge after mppx has
 * already opened a channel or had a management top-up accepted, so the refusal
 * copy claims only that no voucher was signed, and names the recovery path for
 * collateral this funding may already have locked.
 */
export function assertTempoSessionChallengeWithinAsk(args: {
  challenges: readonly MppxChallenge[];
  basisMicro: number;
}): void {
  const local = BigInt(Math.max(0, Math.round(args.basisMicro)));
  for (const challenge of args.challenges) {
    if (challenge.method !== "tempo" || challenge.intent !== "session") continue;
    const advertised = BigInt(tempoSessionChallengeMicro(challenge as TempoSessionChallenge));
    if (withinAdvertisedTolerance(advertised, local)) continue;
    const advertisedUsd = Number(advertised) / 1e6;
    const localUsd = Number(local) / 1e6;
    throw new DvmError(
      "tempo_session_amount_exceeds_limit",
      `The DVM's Tempo session asks this funding to authorize $${formatUsd(advertisedUsd)}, more than 10% above the $${formatUsd(localUsd)} of credit it is buying.`,
      "No voucher was signed, so this DVM gained no authority to capture anything. If the funding had already opened or topped up its channel, that collateral is still yours — 'dvm wallet balance' shows it and 'dvm wallet tempo-exit <dvm>' recovers it on-chain. Fund an amount this DVM prices, or ask its operator to check its BTC/USD rate.",
      {
        advertised_usdc_microunits: advertised.toString(),
        local_usdc_microunits: local.toString(),
        max_usdc_microunits: maxAdvertisedMicro(local).toString(),
        anchor: costAnchor(advertisedUsd),
        display: `Funding refused: the DVM's Tempo session wants a $${formatUsd(advertisedUsd)} voucher for $${formatUsd(localUsd)} of credit, over the 10% safety margin.`,
      }
    );
  }
}

/**
 * The cumulative capture authority a session credential hands the DVM, in USD
 * micro-units. `undefined` when the credential authorizes none — a management
 * top-up moves collateral without naming a cumulative, and a replayed journal
 * entry or hand-rolled header is not an mppx credential at all.
 */
export function tempoSessionCredentialCumulativeMicro(credential: string): number | undefined {
  let payload: { cumulativeAmount?: unknown };
  try {
    payload = Credential.deserialize(credential).payload as typeof payload;
  } catch {
    return undefined;
  }
  const { cumulativeAmount } = payload;
  if (typeof cumulativeAmount !== "string" || !/^\d+$/.test(cumulativeAmount)) return undefined;
  const micro = BigInt(cumulativeAmount);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DvmError("payment_invalid", "The Tempo session voucher amount is out of range.");
  }
  return Number(micro);
}

/**
 * Refuse to broadcast a signed voucher that authorizes materially more capture
 * than the funding it pays for.
 *
 * The belt behind {@link assertTempoSessionChallengeWithinAsk}: that one bounds
 * a single challenge, and mppx retries a 402 up to five times, so a DVM that
 * keeps re-challenging at the honest amount would otherwise walk the cumulative
 * up one ask at a time until it hit the whole per-channel allowance. This bounds
 * the total for the funding regardless of how many times mppx signs, and it
 * reads the figure off the credential rather than trusting the challenge that
 * produced it. Pre-broadcast is binding here for the same reason it is for the
 * deposit — this bridge is the sole conduit to the DVM, and a voucher that never
 * leaves the process authorizes nothing.
 *
 * `authorizedMicro` is the delta over the cumulative already authorized when
 * this funding began, so a reused channel is measured on what this funding adds
 * rather than on everything the channel has ever agreed to pay.
 *
 * Collateral is a separate question from capture authority: the open or the
 * management top-up earlier in this same funding may already have moved some,
 * so the copy claims only what it knows about the voucher and names the verb
 * that gets the collateral back.
 */
export function assertTempoSessionVoucherWithinAsk(args: {
  authorizedMicro: number;
  basisMicro: number;
}): void {
  const local = BigInt(Math.max(0, Math.round(args.basisMicro)));
  const authorized = BigInt(args.authorizedMicro);
  // A voucher at or below what the channel already authorized adds no capture
  // authority, so there is nothing to refuse — the ceiling is on what a funding
  // hands over, not on the shape of the arithmetic that got there.
  if (authorized <= 0n || withinAdvertisedTolerance(authorized, local)) return;
  const authorizedUsd = Number(authorized) / 1e6;
  const localUsd = Number(local) / 1e6;
  throw new DvmError(
    "tempo_session_amount_exceeds_limit",
    `This Tempo session voucher would let the DVM capture $${formatUsd(authorizedUsd)}, above the $${formatUsd(localUsd)} of credit this funding is buying.`,
    "The voucher never left this machine, so this DVM can capture nothing against it. Any channel collateral the funding already locked is still yours — 'dvm wallet balance' shows it and 'dvm wallet tempo-exit <dvm>' recovers it on-chain. Fund an amount this DVM prices, or ask its operator why its session charges more than it quoted.",
    {
      advertised_usdc_microunits: authorized.toString(),
      local_usdc_microunits: local.toString(),
      max_usdc_microunits: maxAdvertisedMicro(local).toString(),
      anchor: costAnchor(authorizedUsd),
      display: `Funding refused: the DVM's Tempo session voucher would capture $${formatUsd(authorizedUsd)} for $${formatUsd(localUsd)} of credit, over the 10% safety margin.`,
    }
  );
}

/** Persist an open credential before broadcast so a lost response remains recoverable. */
export async function persistTempoOpenCredential(args: {
  credential: string;
  endpoint: string;
  callerPubkey: string;
  creditId: string;
  opened: boolean;
}): Promise<boolean> {
  try {
    const parsed = Credential.deserialize(args.credential);
    const payload = parsed.payload as {
      action?: unknown;
      channelId?: unknown;
      cumulativeAmount?: unknown;
      descriptor?: unknown;
    };
    if (
      payload.action !== "open" ||
      typeof payload.channelId !== "string" ||
      typeof payload.cumulativeAmount !== "string" ||
      !payload.descriptor ||
      typeof payload.descriptor !== "object"
    ) {
      return false;
    }
    const methodDetails = parsed.challenge.request.methodDetails as
      | { chainId?: unknown; escrowContract?: unknown }
      | undefined;
    if (typeof methodDetails?.chainId !== "number") return false;
    const escrow =
      typeof methodDetails.escrowContract === "string" &&
      isAddress(methodDetails.escrowContract, { strict: false })
        ? methodDetails.escrowContract
        : TempoSession.Precompile.Constants.tip20ChannelEscrow;
    const descriptor = payload.descriptor as Parameters<
      typeof TempoSession.Precompile.Channel.computeId
    >[0];
    const channelId = TempoSession.Precompile.Channel.computeId({
      ...descriptor,
      chainId: methodDetails.chainId,
      escrow,
    });
    if (channelId.toLowerCase() !== payload.channelId.toLowerCase()) return false;
    // What the signed transaction deposits, not what the funding asked for.
    // mppx defers its own (truthful) store write until the response settles,
    // and then skips it because this entry already carries the same channel id
    // so whatever lands here is the deposit every later top-up sizes its
    // headroom against. Recording the ask understated it.
    const depositMicro = tempoSessionCredentialDepositMicro(args.credential);

    const existingAssociation = loadTempoChannelAssociation(
      args.endpoint,
      args.callerPubkey,
      args.creditId
    );
    const existing = existingAssociation
      ? await loadTempoChannelEntry(existingAssociation)
      : undefined;
    await createTempoChannelStore({
      endpoint: args.endpoint,
      callerPubkey: args.callerPubkey,
      creditId: args.creditId,
      operator: descriptor.operator,
    }).set({
      channelId,
      cumulativeAmount: BigInt(payload.cumulativeAmount),
      deposit: BigInt(depositMicro),
      descriptor,
      escrow,
      chainId: methodDetails.chainId,
      opened:
        args.opened ||
        (existing?.opened === true && existing.channelId.toLowerCase() === channelId.toLowerCase()),
    });
    return true;
  } catch (err) {
    // A syntactically valid open can still be refused by the channel store's
    // scope guard. That is an actionable recovery state, not a parse failure:
    // preserve its code and hint so the funding surface tells the caller to
    // exit the channel that owns the scope before replaying this credential.
    if (err instanceof DvmError && err.code === "tempo_channel_scope_occupied") throw err;
    return false;
  }
}

/** Read the first Tempo session challenge retained on a `/v1/credit` error. */
export function tempoSessionChallenge(err: unknown): TempoSessionChallenge | undefined {
  if (!(err instanceof DvmError) || !Array.isArray(err.data?.tempo_challenges)) return undefined;
  const challenge = (err.data.tempo_challenges as MppxChallenge[]).find(
    (candidate) => candidate.method === "tempo" && candidate.intent === "session"
  );
  return challenge as TempoSessionChallenge | undefined;
}

/**
 * Read a Tempo session challenge's transformed raw amount as USD micro-units.
 *
 * The shape is checked before `BigInt` sees it: the figure is server-authored,
 * and a raw `SyntaxError` from a malformed one would escape as an unmapped
 * crash on a path whose whole job is refusing what the DVM asks for.
 */
export function tempoSessionChallengeMicro(challenge: TempoSessionChallenge): number {
  const advertised = (challenge.request as { amount?: unknown } | undefined)?.amount;
  if (typeof advertised !== "string" || !/^\d+$/.test(advertised)) {
    throw new DvmError(
      "payment_invalid",
      `The DVM advertised an unreadable Tempo session amount: '${String(advertised)}'.`,
      "Do not pay this. Ask the DVM operator to return a whole number of USDC micro-units."
    );
  }
  const micro = BigInt(advertised);
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DvmError("payment_invalid", "The Tempo session challenge amount is out of range.");
  }
  return Number(micro);
}

export async function createTempoCloseCredential(args: {
  account: TempoAccount;
  association: TempoChannelAssociation;
  challenge: TempoSessionChallenge;
  cumulativeAmountMicro: number;
  getClient?: TempoSessionClientResolver;
}): Promise<string> {
  const entry = await loadTempoChannelEntry(args.association);
  if (!entry) {
    throw new DvmError(
      "tempo_channel_not_found",
      `The Tempo channel for credit ${args.association.creditId} is missing locally.`,
      "Use 'dvm wallet tempo-exit <dvm>' only when the channel record is present; otherwise contact the DVM operator with the credit id."
    );
  }
  // Manual close signs the requested amount; automatic maxDeposit does not
  // constrain it. Refuse above the locally authorized cumulative cursor.
  if (BigInt(args.cumulativeAmountMicro) > entry.cumulativeAmount) {
    throw new DvmError(
      "tempo_close_amount_unauthorized",
      `The DVM asked to close this Tempo channel at $${formatUsdcMicrounits(BigInt(args.cumulativeAmountMicro))}, above the $${formatUsdcMicrounits(entry.cumulativeAmount)} this wallet has authorized on it.`,
      `No credential was signed and nothing is stranded: run 'dvm wallet tempo-exit <dvm>' to recover the channel's unsettled balance on-chain, and tell the DVM's operator that its close request exceeded the caller's authorization.`
    );
  }
  const durableStore = createTempoChannelStore({
    endpoint: args.association.endpoint,
    callerPubkey: args.association.callerPubkey,
    creditId: args.association.creditId,
    operator: args.association.operator,
  });
  const method = TempoSession.Client.session({
    account: privateKeyToAccount(args.account.privateKey),
    // mppx normally deletes a channel as soon as it signs a manual close.
    // The credential has not reached the DVM at that point, so keep the
    // unilateral-exit record until wallet tempo-exit independently confirms the
    // cooperative close on-chain and retires it.
    channelStore: {
      get: (key) => durableStore.get(key),
      set: (next) => durableStore.set(next),
      delete: () => undefined,
    },
    ...(args.getClient ? { getClient: args.getClient } : {}),
  });
  return method.createCredential({
    challenge: args.challenge,
    context: {
      action: "close",
      descriptor: entry.descriptor,
      cumulativeAmountRaw: String(args.cumulativeAmountMicro),
    },
  });
}

interface TempoReadableChannelExitResult {
  status:
    | "close_requested"
    | "waiting"
    | "withdrawn"
    | "already_closed"
    | "unconfirmed"
    | "abandoned";
  descriptorMissing?: false;
  foreignPayer?: undefined;
  channelId: string;
  /** The channel's TIP-20 token — what the exit's own fees are charged in. */
  channelToken: `0x${string}`;
  transactionHash?: string;
  withdrawAvailableAt?: number;
  depositMicro: number;
  settledMicro: number;
  /**
   * What the exit returns even if the DVM settles everything it is authorized
   * to: the deposit less the highest cumulative this wallet has ever signed.
   * Positive whenever the deposit was sized with top-up headroom the open
   * voucher does not yet authorize, and zero once a cumulative reaches the
   * whole deposit — a floor, not a forecast.
   */
  guaranteedMicro: number;
  /** The deposit less what the chain has already settled: what the exit returns if the DVM claims nothing further. */
  likelyMicro: number;
}

interface TempoDescriptorlessAbandonResult {
  status: "abandoned";
  descriptorMissing: true;
  foreignPayer?: undefined;
  channelId: string;
}

/**
 * Retirement of a record whose descriptor names a wallet this machine's Tempo
 * key is not.
 *
 * It carries no amounts because it reads no chain: the escrow's figure for
 * someone else's channel is not this caller's money, and making the one route
 * out of a stranger's record depend on an RPC that answers would rebuild the
 * dead end it exists to open.
 */
interface TempoForeignAbandonResult {
  status: "abandoned";
  descriptorMissing?: false;
  /** The payer the retired descriptor named — the only wallet that could have closed it. */
  foreignPayer: string;
  channelId: string;
}

export type TempoChannelExitResult =
  | TempoReadableChannelExitResult
  | TempoDescriptorlessAbandonResult
  | TempoForeignAbandonResult;

type TempoChannelExitChain = Pick<
  typeof TempoSession.Precompile.Chain,
  "getChannelState" | "requestCloseOnChain" | "waitForSuccessfulReceipt" | "withdrawOnChain"
>;

/**
 * The chain surface a reconciliation is allowed to touch: the one `view` call.
 *
 * Narrowed rather than documented, so a reconcile that grew a broadcast would
 * not type-check. Nothing on this path may initiate a close or a withdrawal —
 * it runs from `dvm credit drain` and `dvm wallet balance`, neither of which
 * the caller invoked to spend a fee or start a 15-minute grace period.
 */
type TempoChannelReadChain = Pick<typeof TempoSession.Precompile.Chain, "getChannelState">;

type TempoChannelState = Awaited<ReturnType<typeof TempoSession.Precompile.Chain.getChannelState>>;

interface TempoChannelExitArgs {
  /**
   * The connected Tempo key, absent when none is configured.
   *
   * Optional because the outcomes that sign nothing have to keep working for a
   * caller who has already disconnected — retiring a descriptor-less record,
   * and retiring one the escrow has no channel for — and the escrow read that
   * tells those apart needs no key either. Only the broadcast legs refuse
   * without one. A record can be judged *another* wallet's only when there is a
   * connected wallet to judge it against, so that path requires a key too.
   */
  account?: TempoAccount;
  association: TempoChannelAssociation;
  nowSeconds?: number;
  /**
   * Retire a channel the escrow has no record of instead of reporting
   * `unconfirmed`, or retire an association whose descriptor is already gone.
   * Refused for a descriptor-backed channel the chain does know, which has real
   * collateral an exit can still recover.
   */
  abandon?: boolean;

  client?: Parameters<typeof TempoSession.Precompile.Chain.getChannelState>[0];

  chain?: TempoChannelExitChain;
}

/**
 * Advance one channel's unilateral escape hatch by one safe step.
 *
 * The first invocation requests close. A later invocation waits until the
 * protocol's 900-second grace has elapsed, then withdraws. It never sleeps.
 *
 * A channel the escrow has no record of reports `unconfirmed` and keeps its
 * local entry: the open may still be in flight, and the entry is what closes it
 * if it lands. `abandon` is the deliberate way back out of that state — it
 * retires the entry, accepting that a later open would strand its deposit — and
 * it is refused for a channel the chain does know about. If the descriptor is
 * already absent, abandonment performs only the local retirement: there is no
 * chain address left to read and no recovery descriptor left to discard.
 */
export async function advanceTempoChannelExit(
  args: TempoChannelExitArgs
): Promise<TempoChannelExitResult> {
  return withTempoChannelLock(() => advanceTempoChannelExitLocked(args));
}

/**
 * What the escrow says about one recorded channel. `unreadable` is this
 * machine's own failure to ask, never the chain's answer.
 */
export type TempoChannelChainStatus = "open" | "closing" | "closed" | "unconfirmed" | "unreadable";

/** A read-only chain verdict on one recorded channel, and what it cost the local record. */
export interface TempoChannelReconcileResult {
  /** How the escrow classifies the channel this record names. */
  status: TempoChannelChainStatus;
  /** Whether the local record is gone once this call returns. Only ever on `closed`. */
  retired: boolean;

  channelId: string;
  /** The escrow's deposit, falling back to the record's figure when unread. */
  depositMicro: number;
  /** What the escrow has already paid the DVM, zero when unread. */
  settledMicro: number;
  /** Redacted read or local-retirement failure; the chain verdict can still be closed. */
  error?: DvmError;
}

/**
 * Confirm a Tempo channel's fate against the escrow, and retire the local
 * record once — and only once — the chain proves it terminal.
 *
 * The cooperative close is the DVM's transaction to broadcast, so the caller
 * learns of it by being told `sent`. That word is not evidence: the local
 * record is the only copy of the descriptor a unilateral exit needs, and a
 * service must not be able to erase it by claiming to have closed the channel.
 * This is the step that turns the claim into evidence — an independent read of
 * the escrow, on the caller's own RPC, classified by the same rule
 * `dvm wallet tempo-exit` applies.
 *
 * It broadcasts nothing: the chain seam is narrowed to `getChannelState`, and
 * the retirement is a local file write. It also never throws — a drain that
 * moved real money must not come back as an error because an RPC was down, and
 * a balance read must still report the rest of the wallet. Failures are
 * redacted in the result. A read failure is `unreadable`; a local retirement
 * failure retains the chain's `closed` verdict and the record. Still-live
 * channels keep their recovery records.
 */
export async function reconcileTempoChannelOnChain(args: {
  association: TempoChannelAssociation;
  /** Observe terminal state without changing the caller's local channel store. */
  observeOnly?: boolean;
  /** Test seam for the chain client. */
  client?: Parameters<typeof TempoSession.Precompile.Chain.getChannelState>[0];
  /** Test seam for the read. Narrowed so this path cannot grow a broadcast. */
  chain?: TempoChannelReadChain;
}): Promise<TempoChannelReconcileResult> {
  const { association } = args;
  // The record's own figures, worth reporting as what this wallet last knew
  // rather than as what the escrow holds. `status` is what separates the two.
  const unread = {
    retired: false,
    channelId: association.channelId,
    depositMicro: Number(association.deposit),
    settledMicro: 0,
  };
  let entry: TempoChannelEntry;
  let state: TempoChannelState;
  try {
    ({ entry, state } = await readTempoChannelState(args));
  } catch (err) {
    return { ...unread, status: "unreadable", error: asTempoReadError(err) };
  }
  const read = {
    status: classifyTempoChannelState(entry, state),
    channelId: entry.channelId,
    depositMicro: Number(state.deposit),
    settledMicro: Number(state.settled),
  };
  if (read.status !== "closed") return { ...read, retired: false };
  if (args.observeOnly) return { ...read, retired: false };
  try {
    // Re-checked under the lock rather than retiring what the read saw: a
    // sibling process can have funded a fresh channel into this same scope
    // since, and that one's descriptor is the only copy of a live recovery path.
    const retired = await withTempoChannelLock(async () => {
      const current = loadTempoChannelAssociation(
        association.endpoint,
        association.callerPubkey,
        association.creditId
      );
      // Already gone counts as retired: a sibling credit on this same scope
      // reconciles concurrently on a `wallet balance` read, and whichever of
      // them wins the lock retires the scope for both. Only a *different*
      // channel occupying the scope is a reason to leave it alone.
      if (!current) return true;
      if (current.channelId.toLowerCase() !== association.channelId.toLowerCase()) return false;
      // Scope-wide, as the exit's own `already_closed` is: a terminal channel is
      // terminal for every credit that shares it, and a sibling left pointing at
      // it would keep refusing `wallet tempo-disconnect` over collateral the
      // escrow no longer holds.
      await retireTempoChannelScope(current);
      return true;
    });
    return { ...read, retired };
  } catch (err) {
    // The chain's verdict stands whatever the local write did, so it is still
    // reported as `closed` — with the reason the record outlived it.
    return { ...read, retired: false, error: asTempoReadError(err) };
  }
}

async function advanceTempoChannelExitLocked(
  args: TempoChannelExitArgs
): Promise<TempoChannelExitResult> {
  const association = loadTempoChannelAssociation(
    args.association.endpoint,
    args.association.callerPubkey,
    args.association.creditId
  );
  if (association?.channelId.toLowerCase() !== args.association.channelId.toLowerCase()) {
    throw new DvmError(
      "tempo_channel_not_found",
      `No local Tempo channel entry remains for credit ${args.association.creditId}.`
    );
  }
  const entry = await loadTempoChannelEntry(association);
  if (!entry) {
    if (args.abandon) {
      // The descriptor is already gone, so there is no chain address to read
      // and no recovery path this retirement can erase. Drop only this credit's
      // orphaned projection; a sibling association still needs its own explicit
      // action before the key guard releases it.
      await retireTempoChannel(association);
      return {
        status: "abandoned",
        descriptorMissing: true,
        channelId: association.channelId,
      };
    }
    throw new DvmError(
      "tempo_channel_not_found",
      `The Tempo channel record for credit ${association.creditId} has no stored descriptor.`,
      `Run 'dvm wallet tempo-exit ${association.endpoint} --abandon' to retire this unusable local record. Nothing will be broadcast, because there is no descriptor from which to address the escrow.`
    );
  }
  const identity = { channelId: entry.channelId, channelToken: entry.descriptor.token };
  const account = args.account;
  // Whose channel this is, before anything reaches for an RPC. A descriptor
  // naming another wallet is not this key's to close — the escrow refunds the
  // payer it names and nobody else — so an exit run against it would broadcast
  // a transaction the chain rejects, and the guard that protects the key slot
  // must not count it either.
  //
  // A *connected* key is what makes a record a stranger's. With none derivable
  // every descriptor would answer "not yours", and the local-only retirement
  // below would then discard the sole recovery path for an owned channel the
  // escrow still holds collateral for. So the keyless case falls through to the
  // escrow read instead, where `tempo_channel_on_chain` refuses exactly that.
  const controller = tempoDescriptorController(entry.descriptor);
  if (account && controller && !tempoChannelControlledBy(controller, account.address)) {
    if (!args.abandon) throw foreignChannelExitError(association, controller, account);
    // Local only: no chain read, no broadcast, and no descriptor left behind
    // for a key this machine does not hold. Scope-wide because every credit
    // sharing this payment scope shares its descriptor, and so its owner.
    await retireTempoChannelScope(association);
    return {
      status: "abandoned",
      foreignPayer: controller.payer,
      channelId: association.channelId,
    };
  }
  // Resolved even when the client seam is injected: the endpoint is what the
  // failure copy below has to talk about, and resolution is local and pure.
  const rpc = await resolveTempoExitRpc(entry.chainId);
  // Reading the escrow is a `view` call, so a disconnected caller still gets a
  // verdict on the record they are trying to clear — the same keyless read
  // `reconcileTempoChannelOnChain` runs from `dvm wallet balance`.
  const client =
    args.client ?? (account ? await tempoWalletClient(account, rpc) : await tempoPublicClient(rpc));
  const chain = redactingExitChain(
    args.chain ?? TempoSession.Precompile.Chain,
    rpc,
    entry.descriptor.token
  );
  let state = await chain.getChannelState(client, entry.channelId, entry.escrow);
  const amounts = () => {
    // The DVM's outstanding capture authority is the highest cumulative this
    // wallet signed, floored at what the chain has already settled — the same
    // reservation shape the x402 timed exit uses.
    const authorized =
      entry.cumulativeAmount > state.settled ? entry.cumulativeAmount : state.settled;
    return {
      depositMicro: Number(state.deposit),
      settledMicro: Number(state.settled),
      guaranteedMicro: Number(state.deposit > authorized ? state.deposit - authorized : 0n),
      // Clamped because the escrow zeroes a withdrawn channel's deposit while
      // keeping its settled total, so a closed channel reads deposit 0 against
      // a positive settled and the raw subtraction goes negative.
      likelyMicro: Number(state.deposit > state.settled ? state.deposit - state.settled : 0n),
    };
  };
  if (state.deposit === 0n) {
    if (classifyTempoChannelState(entry, state) === "closed") {
      await retireTempoChannelScope(association);
      return { status: "already_closed", ...identity, ...amounts() };
    }
    // Keeping the entry is the safe default, not a permanent one: nothing else
    // ever retires it, and while it is here `assertTempoWalletIdle` refuses to
    // disconnect or replace the Tempo key — an `unconfirmed` open may still be
    // confirming, and this entry is what would close its deposit. An open that
    // a DVM refused outright will never land, so the caller needs a way to say so.
    if (args.abandon) {
      await retireTempoChannel(association);
      return { status: "abandoned", ...identity, ...amounts() };
    }
    return { status: "unconfirmed", ...identity, ...amounts() };
  }
  if (args.abandon) {
    // The chain knows this channel, so its collateral is recoverable and the
    // local entry is the only thing that can recover it. Refuse rather than
    // quietly running a real exit the caller did not ask for.
    throw new DvmError(
      "tempo_channel_on_chain",
      `The Tempo channel for credit ${association.creditId} holds $${formatUsdcMicrounits(state.deposit)} on-chain, so its record cannot be abandoned.`,
      "Close the on-chain channel with its controlling key before retiring the local record.",
      { endpoint: association.endpoint, credit_id: association.creditId, channel_id: association.channelId,
        key_connected: Boolean(account), deposit_micro: state.deposit.toString() }
    );
  }
  // Everything past here signs.
  if (!account) throw tempoExitKeyMissingError();
  // Tempo has no native gas token: fees come out of a TIP-20 stablecoin the
  // sender holds. Naming the channel's own token as a candidate is only worth
  // anything when mppx actually resolves a fee token, and it does that solely
  // for a sponsored transaction or one the sender sponsors itself — with
  // `feePayer` unset it sends with no fee token at all and the chain default
  // decides, which strands a wallet holding nothing but the channel's asset.
  // Passing the same account as its own fee payer takes mppx's self-sponsored
  // branch: it resolves a *funded* token (the account's preference, the chain
  // default, then the channel token) and never enters the co-signing path.
  const exitAccount = privateKeyToAccount(account.privateKey);
  const transactionOptions = {
    account: exitAccount,
    feePayer: exitAccount,
    candidateFeeTokens: [entry.descriptor.token],
  };
  if (state.closeRequestedAt === 0) {
    const hash = await chain.requestCloseOnChain(
      client,
      entry.descriptor,
      entry.escrow,
      transactionOptions
    );
    await chain.waitForSuccessfulReceipt(client, hash);
    state = await chain.getChannelState(client, entry.channelId, entry.escrow);
    return {
      status: "close_requested",
      ...identity,
      transactionHash: hash,
      withdrawAvailableAt: (state.closeRequestedAt + 900) * 1000,
      ...amounts(),
    };
  }
  const withdrawAvailableAt = state.closeRequestedAt + 900;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now < withdrawAvailableAt) {
    return {
      status: "waiting",
      ...identity,
      withdrawAvailableAt: withdrawAvailableAt * 1000,
      ...amounts(),
    };
  }
  const withdrawnAmounts = amounts();
  const hash = await chain.withdrawOnChain(
    client,
    entry.descriptor,
    entry.escrow,
    transactionOptions
  );
  await chain.waitForSuccessfulReceipt(client, hash);
  state = await chain.getChannelState(client, entry.channelId, entry.escrow);
  await retireTempoChannelScope(association);
  return {
    status: "withdrawn",
    ...identity,
    transactionHash: hash,
    ...withdrawnAmounts,
  };
}

/**
 * Refuse an exit the connected key provably cannot perform.
 *
 * The Tempo twin of {@link import("../x402/lifecycle").assertX402ChannelPayer},
 * and named the same way, because it is the same fact: the escrow pays a
 * channel's refund to the payer its descriptor names, so a key that is not that
 * payer can sign a close transaction the chain will simply reject. Saying so is
 * the whole job — the alternative is a broadcast that costs a stablecoin fee
 * and recovers nothing.
 */
function foreignChannelExitError(
  association: TempoChannelAssociation,
  controller: TempoChannelController,
  account: TempoAccount
): DvmError {
  return new DvmError(
    "tempo_wallet_mismatch",
    `The connected Tempo key ${account.address} is not the wallet recorded for the channel with ${association.endpoint} — that channel was opened by ${controller.payer}.`,
    "Only the recorded payer can recover this collateral. Retiring the local record discards its channel descriptor.",
    {
      anchor: "tempo_channel_payer_mismatch",
      endpoint: association.endpoint,
      credit_id: association.creditId,
      channel_id: association.channelId,
      recorded_payer: controller.payer,
      recorded_authorized_signer: controller.authorizedSigner,
      connected_payer: account.address,
    }
  );
}

/** Refuse an exit leg that needs a signing key. */
function tempoExitKeyMissingError(): DvmError {
  return new DvmError(
    "tempo_wallet_missing",
    "The Tempo key that controls this channel is not connected.",
    "The controlling key is required before an on-chain exit can be signed.",
    { anchor: "tempo_channel_key_missing" }
  );
}

/** The mppx entry a reconcile classifies, as the store hands it back. */
type TempoChannelEntry = NonNullable<Awaited<ReturnType<typeof loadTempoChannelEntry>>>;

/** Read one recorded channel's escrow state, or throw a `DvmError` saying why not. */
async function readTempoChannelState(args: {
  association: TempoChannelAssociation;
  client?: Parameters<typeof TempoSession.Precompile.Chain.getChannelState>[0];
  chain?: TempoChannelReadChain;
}): Promise<{ entry: TempoChannelEntry; state: TempoChannelState }> {
  const entry = await loadTempoChannelEntry(args.association);
  if (!entry) {
    throw new DvmError(
      "tempo_channel_not_found",
      `The Tempo channel record for credit ${args.association.creditId} has no stored descriptor.`,
      `That channel can no longer be read or closed from here. Run 'dvm wallet tempo-exit ${args.association.endpoint} --abandon' to retire the unusable local record without broadcasting anything, then retry the wallet change.`
    );
  }
  const rpc = await resolveTempoExitRpc(entry.chainId);
  const client = args.client ?? (await tempoPublicClient(rpc));
  const chain = args.chain ?? TempoSession.Precompile.Chain;
  const state = await guardTempoChannelRead(rpc, () =>
    chain.getChannelState(client, entry.channelId, entry.escrow)
  );
  return { entry, state };
}

/** Keep a raw throw from reaching a surface that promised not to fail on one. */
function asTempoReadError(err: unknown): DvmError {
  if (err instanceof DvmError) return err;
  return new DvmError(
    "tempo_chain_read_failed",
    `The Tempo channel state could not be read: ${redactUrlsInText(
      err instanceof Error ? err.message : String(err)
    )}`
  );
}

/**
 * Which of the four chain states one recorded channel is in.
 *
 * A zero deposit reads the same whether the channel closed and paid out or
 * never reached the chain at all, and the two want opposite handling. The local
 * entry is the sole copy of the descriptor an exit needs, so calling it closed
 * is only safe once something says this channel existed on-chain: the open that
 * mppx saw settle, or a chain marker the escrow only writes for a channel it
 * knows. Retiring on the ambiguous read stranded the deposit of a funding that
 * timed out mid-open and mined afterwards.
 */
function classifyTempoChannelState(
  entry: { opened: boolean },
  state: TempoChannelState
): Exclude<TempoChannelChainStatus, "unreadable"> {
  if (state.deposit > 0n) return state.closeRequestedAt === 0 ? "open" : "closing";
  return entry.opened || state.settled > 0n || state.closeRequestedAt !== 0
    ? "closed"
    : "unconfirmed";
}

/**
 * Wrap the reconcile's one chain call so a failing endpoint cannot carry the
 * caller's URL out with it, and says which knob is theirs to turn.
 *
 * The read twin of {@link redactingExitChain}, and deliberately not it: that
 * one's copy is about a transaction the escrow refused and the stablecoin fees
 * it would have cost, none of which applies to a `view` call that never signs.
 */
async function guardTempoChannelRead<T>(
  rpc: ResolvedTempoExitRpc,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof DvmError) throw err;
    const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
    if (!isTransportFailure(err)) {
      throw new DvmError(
        "tempo_chain_read_failed",
        `The Tempo channel state could not be read: ${cause}`,
        "This failed on-chain rather than in transit, so changing DVM_TEMPO_RPC_URL will not help. The local channel record was kept; 'dvm wallet tempo-exit <dvm>' re-reads the chain and reports where the channel actually is."
      );
    }
    throw new DvmError(
      "tempo_rpc_error",
      `The Tempo channel state could not be read: ${cause}`,
      rpc.source === "override"
        ? `DVM_TEMPO_RPC_URL sent this read to ${redactUrl(rpc.url)}. Correct it, or unset it to fall back to Tempo's bundled endpoint, then re-run — the local channel record was kept until the chain can be read.`
        : `Verify connectivity to Tempo's bundled endpoint (${redactUrl(rpc.url)}), or send the read somewhere else with DVM_TEMPO_RPC_URL, then re-run — the local channel record was kept until the chain can be read.`
    );
  }
}

/** The chain the exit runs against, and the endpoint it reaches it on. */
interface ResolvedTempoExitRpc {
  chain: Chain;
  url: string;
  source: RpcSource;
}

/**
 * Pick the recorded channel's chain and the endpoint to reach it on.
 *
 * `DVM_TEMPO_RPC_URL` goes through {@link resolveRpcOverride} rather than
 * `??`, so a blank or whitespace-only value falls back to viem's bundled
 * endpoint instead of building a transport that cannot resolve — this is the
 * command that recovers stranded escrow, and it must not break on an empty
 * variable the balance read tolerates.
 */
async function resolveTempoExitRpc(chainId: number): Promise<ResolvedTempoExitRpc> {
  const { tempo, tempoModerato } = await import("viem/chains");
  const chain = chainId === tempo.id ? tempo : chainId === tempoModerato.id ? tempoModerato : null;
  if (!chain) {
    throw new DvmError(
      "tempo_chain_unsupported",
      `The recorded Tempo channel uses unsupported chain ${String(chainId)}.`
    );
  }
  const { url, source } = resolveRpcOverride(
    process.env.DVM_TEMPO_RPC_URL,
    chain.rpcUrls.default.http[0]
  );
  return { chain, url, source };
}

/**
 * A keyless client for the reconcile's `view` call.
 *
 * Reading the escrow needs no signature, and the balance surface that
 * reconciles has to work with the Tempo wallet already disconnected — the
 * cleanest moment to discover the channel it was refusing to release is closed.
 */
async function tempoPublicClient(rpc: ResolvedTempoExitRpc) {
  const { createPublicClient, http } = await import("viem");
  const transportOptions = resolveRpcHttpTransportOptions(
    rpc.source,
    process.env.DVM_TEMPO_RPC_HEADERS_JSON
  );
  return createPublicClient({
    chain: rpc.chain,
    transport: transportOptions ? http(rpc.url, transportOptions) : http(rpc.url),
  });
}

async function tempoWalletClient(account: TempoAccount, rpc: ResolvedTempoExitRpc) {
  const { createWalletClient, http } = await import("viem");
  const transportOptions = resolveRpcHttpTransportOptions(
    rpc.source,
    process.env.DVM_TEMPO_RPC_HEADERS_JSON
  );
  return createWalletClient({
    account: privateKeyToAccount(account.privateKey),
    chain: rpc.chain,
    transport: transportOptions ? http(rpc.url, transportOptions) : http(rpc.url),
  });
}

type TempoSerializedTransaction = Parameters<typeof Transaction.deserialize>[0];

function readSessionDeposit(credential: string): { action?: string; depositMicro: number } {
  let payload: { action?: unknown; transaction?: unknown; additionalDeposit?: unknown };
  try {
    payload = Credential.deserialize(credential).payload as typeof payload;
  } catch {
    // Not an mppx credential at all — the replayed-journal and hand-rolled
    // header paths both reach the bridge, and neither commits collateral.
    return { depositMicro: 0 };
  }
  const action = typeof payload.action === "string" ? payload.action : undefined;
  if (action === "topUp") {
    if (typeof payload.additionalDeposit !== "string" || !/^\d+$/.test(payload.additionalDeposit)) {
      throw unreadableDeposit("top-up");
    }
    return { action, depositMicro: depositAsMicro(BigInt(payload.additionalDeposit)) };
  }
  if (action !== "open") return { ...(action ? { action } : {}), depositMicro: 0 };
  if (typeof payload.transaction !== "string") throw unreadableDeposit("channel open");
  let calls: readonly { data?: unknown }[] = [];
  try {
    const deserialized = Transaction.deserialize(payload.transaction as TempoSerializedTransaction);
    if ("calls" in deserialized && Array.isArray(deserialized.calls)) calls = deserialized.calls;
  } catch {
    throw unreadableDeposit("channel open");
  }
  for (const call of calls) {
    if (typeof call.data !== "string") continue;
    try {
      const decoded = decodeFunctionData({
        abi: TempoSession.Precompile.escrowAbi,
        data: call.data as `0x${string}`,
      });
      // `open(payee, operator, token, deposit, salt, authorizedSigner)`.
      if (decoded.functionName !== "open") continue;
      return { action, depositMicro: depositAsMicro(decoded.args[3]) };
    } catch {
      // A prefix call the escrow ABI does not describe — an auto-swap, say.
      continue;
    }
  }
  throw unreadableDeposit("channel open");
}

/** Refuse a collateral-moving credential that will not say how much it moves. */
function unreadableDeposit(leg: string): DvmError {
  return new DvmError(
    "tempo_session_deposit_unreadable",
    `The Tempo session ${leg} credential does not state the deposit it commits.`,
    "Nothing was sent. Retry the funding; if it recurs, the DVM's session challenge is malformed and its operator should be told."
  );
}

/** Range-check a raw TIP-20 deposit before it becomes a JavaScript number. */
function depositAsMicro(deposit: bigint): number {
  if (deposit < 0n || deposit > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DvmError("payment_invalid", "The Tempo session channel deposit is out of range.");
  }
  return Number(deposit);
}

/** viem's transport-layer error names: what its HTTP transport raises when the endpoint misbehaves. */
const TRANSPORT_ERROR_NAMES = new Set([
  "HttpRequestError",
  "ResponseBodyTooLargeError",
  "RpcRequestError",
  "SocketClosedError",
  "TimeoutError",
  "UrlRequiredError",
  "WebSocketRequestError",
]);

/** Node connection errnos, for a throw that never reached viem's wrapper. */
const TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
]);

/** viem's names for a chain-side rejection: the node answered, and the answer was no. */
const REVERT_ERROR_NAMES = new Set(["ContractFunctionRevertedError", "ExecutionRevertedError"]);

/** The JSON-RPC error code a node returns for a reverted execution (viem's `ExecutionRevertedError.code`). */
const EXECUTION_REVERTED_RPC_CODE = 3;

/** Is this link in the chain a node saying the transaction would revert? */
function isRevertLink(err: Error): boolean {
  if (REVERT_ERROR_NAMES.has(err.name)) return true;
  const { code } = err as { code?: unknown };
  return code === EXECUTION_REVERTED_RPC_CODE;
}

/** Is this link viem's transport, or the socket underneath it, reporting that the endpoint failed? */
function isTransportLink(err: Error): boolean {
  if (TRANSPORT_ERROR_NAMES.has(err.name)) return true;
  const { code } = err as { code?: unknown };
  return typeof code === "string" && TRANSPORT_ERROR_CODES.has(code);
}

/**
 * Did the exit fail in transit, or on the chain?
 *
 * mppx raises ordinary errors for on-chain outcomes — `VerificationFailedError`
 * when a precompile transaction reverts, a plain `Error` when no fee token
 * resolves — and neither is the endpoint's fault. Telling a caller whose
 * withdrawal reverted to correct `DVM_TEMPO_RPC_URL` points the agent
 * relaying it at the wrong knob, on the one command that recovers stranded
 * escrow. viem nests its transport failures under action-level wrappers, so the
 * whole cause chain is walked rather than the outermost error alone.
 *
 * A revert anywhere in that chain wins outright, because the likelier refusal
 * never reaches a receipt: `requestClose` and `withdraw` are gas-estimated
 * before broadcast, so an escrow that won't close comes back as
 * `EstimateGasExecutionError -> ExecutionRevertedError -> RpcRequestError` —
 * a transport class carrying a node's considered answer. Matching the transport
 * name alone would blame the endpoint for the most ordinary way this command
 * fails.
 */
function isTransportFailure(err: unknown): boolean {
  let transport = false;
  let cursor: unknown = err;
  for (let depth = 0; cursor instanceof Error && depth < 8; depth += 1) {
    if (isRevertLink(cursor)) return false;
    transport ||= isTransportLink(cursor);
    cursor = cursor.cause;
  }
  return transport;
}

/**
 * Wrap the exit's on-chain steps so an RPC failure cannot carry the caller's
 * endpoint out with it.
 *
 * viem embeds the full URL in `HttpRequestError.message`, and providers put
 * the API key in the URL path. `walletMppExit` has no catch of its own, so an
 * unwrapped throw lands verbatim in the JSON `error.message` an agent relays
 * onward — the trap `getTempoUsdcBalance` closed one rail over.
 * Wrapping the seam rather than each call site keeps every step covered.
 *
 * Redaction is unconditional; the code and the remedy are not. Only a failure
 * that {@link isTransportFailure} recognizes gets `tempo_rpc_error` and advice
 * about the endpoint — a revert is reported as `tempo_exit_failed`, which tells
 * the caller the endpoint is not what to go fix.
 */
function redactingExitChain(
  chain: TempoChannelExitChain,
  rpc: ResolvedTempoExitRpc,
  token: `0x${string}`
): TempoChannelExitChain {
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      // A DvmError was raised deliberately and already says what it means.
      if (err instanceof DvmError) throw err;
      // Redacting only the endpoint we resolved would leave viem's own copy of
      // it sitting unredacted inside the underlying message — and a reverted
      // transaction's error is just as capable of quoting the URL back.
      const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
      if (!isTransportFailure(err)) {
        throw new DvmError(
          "tempo_exit_failed",
          `Tempo channel exit failed: ${cause}`,
          `This failed on-chain rather than in transit, so changing DVM_TEMPO_RPC_URL will not help — a transaction the escrow rejected reads like this, and so does one this wallet cannot pay for. The exit is caller-paid and Tempo charges its fees in a stablecoin rather than a separate gas token, so check that the wallet holds a spendable balance of ${tempoTokenReference(token)} outside the channel. ${tempoBalanceCheckHint(token)} Then re-run 'dvm wallet tempo-exit' — it re-reads the chain and resumes from wherever the channel actually is. If it fails the same way with the wallet funded, the escrow is refusing the exit and the channel needs a closer look.`
        );
      }
      throw new DvmError(
        "tempo_rpc_error",
        `Tempo channel exit failed: ${cause}`,
        // Which knob is the caller's to turn depends on whose endpoint this was.
        rpc.source === "override"
          ? `DVM_TEMPO_RPC_URL sent this exit to ${redactUrl(rpc.url)}. Correct it, or unset it to fall back to Tempo's bundled endpoint, then re-run 'dvm wallet tempo-exit' — it re-reads the chain and resumes from wherever the channel actually is.`
          : `Verify connectivity to Tempo's bundled endpoint (${redactUrl(rpc.url)}), or send the exit somewhere else with DVM_TEMPO_RPC_URL, then re-run 'dvm wallet tempo-exit' — it re-reads the chain and resumes from wherever the channel actually is.`
      );
    }
  };
  return {
    getChannelState: (...args) => guard(() => chain.getChannelState(...args)),
    requestCloseOnChain: (...args) => guard(() => chain.requestCloseOnChain(...args)),
    waitForSuccessfulReceipt: (...args) => guard(() => chain.waitForSuccessfulReceipt(...args)),
    withdrawOnChain: (...args) => guard(() => chain.withdrawOnChain(...args)),
  };
}
