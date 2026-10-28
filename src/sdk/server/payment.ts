import { upfrontPaymentFromDraw } from "./upfront-payment";
import type { UpfrontPayment } from "../../lib/upfront-payment";
import { withPaymentDiagnostics, withPaymentStage } from "../../observability/payment-diagnostics";
import { paymentFailureFields } from "./payment-diagnostics";
import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { DisposableCashuCommit } from "./disposable-cashu-store";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ProofLike } from "@cashu/cashu-ts";
import { Challenge } from "mppx";

import type { LockPubkey } from "../../lib/cashu/lock-pubkey";
import { verifyCashuToken } from "../../lib/cashu/verify";
import { msatsToUsdc } from "../../lib/payment-amounts";
import type { MessageType, MppxCredential } from "../../lib/messages/types";
import { TEMPO_SESSION_UPDATED_REASON } from "../../lib/payment-rails/tempo-wire";
import type { FundingReceipt } from "../../lib/receipt";
import {
  buildPaymentRequirements,
  decodePayment,
  encodePaymentRequiredHeader,
  exactEvmAuthorization,
  type PaymentRequiredV2,
  paymentRequiredV2FromV1,
  type PaymentRequirements,
  type PaymentRequirementsV2,
  X402_BATCH_SETTLEMENT_SCHEME,
  X402_V1_VERSION,
  X402_VERSION,
} from "../../lib/x402/spec";
import type {
  X402Config,
  X402ExactVersionSupport,
  X402SettlementReconciliationReason,
} from "../../lib/x402/types";
import { loggers } from "../../observability/loggers";
import type { FxFetcher } from "../pricing/fx";
import { createFxFetcher } from "../pricing/index";
import type { CashuMode, FundingMethod, PaymentMethod } from "../types";
import { rateUnavailablePaymentError, resolveServerBtcUsdRate } from "./btc-rate";
import type { ConsumedCredentialStore } from "./consumed-credential-store";
import type { CreditEnvelope } from "./credit-envelope";
import { stablecoinCreditInstrumentAllowed } from "./credit-funding-policy";
import type {
  CreditLedgerLike,
  CreditLedgerQuerier,
  CreditSnapshot,
  DrawResult,
  FundingRecord,
} from "./credit-ledger";
import { CreditLedgerError, isFundingRail } from "./credit-ledger";
import {
  drawSettlementRef,
  type FiatDenomination,
  fundedMicroFor,
  fundingCommitment,
  IMPLICIT_CREDIT_TTL_MS,
  implicitCreditId,
  isDerivedCreditId,
  msatsToFiatMicro,
  type PriceFiat,
  x402RequiredUsdcMicro,
  x402SettledShare,
} from "./funding";
import type { ServerJob } from "./job";
import type { TopUpCapUnenforcedReason } from "./job-store";
import { UNCAPPABLE_ASK_TOTAL } from "./job-store";
import type { MintHealthTracker } from "./mint-health-tracker";
import { challengeMeta, type MppxServer } from "./mpp-setup";
import {
  fiatMicroToMethodAmount,
  methodNativeAmountFromDecimal,
  methodNativeAmountToDecimal,
  methodNativeAsset,
  msatsToMethodAmount,
} from "./mpp-units";
import type { ProcessedPaymentStore } from "./processed-payment-store";
import { ProcessedPaymentReplayError } from "./processed-payment-store";
import type { CreditDepositEnqueue, CreditDepositPayload } from "./revenue-reporter";
import {
  acceptAccumulatorPayment,
  type AccumulatorRejectionCode,
} from "./wallet-accumulator-receive";
import type { AccumulatorPool, AccumulatorQuerier } from "./wallet-accumulator-store";
import {
  type X402BatchSettlementServer,
  X402SettlementSubmissionError,
} from "./x402-batch-settlement";
import type { X402ExactSettlementServer } from "./x402-exact-settlement";
import type { X402ExactSettlementEffect } from "./x402-exact-settlement-store";

/** Validity window for upfront-flow mppx challenges. */
const UPFRONT_CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * TTL for consumed-credential tracking. 2× UPFRONT_CHALLENGE_TTL_MS
 * so a credential whose challenge expiry just lapsed is still detected as a
 * replay attempt rather than only rejected as expired.
 */
const CONSUMED_CREDENTIAL_TTL_MS = 2 * UPFRONT_CHALLENGE_TTL_MS;

export interface PaymentInfo {
  /** Immutable acceptance fact, separate from cumulative job accounting. */
  upfrontPayment?: UpfrontPayment;
  /**
   * Rail value this payment contributes to the job, in millisatoshis.
   *
   * For a credit-drawn job this is the **draw's** allocated share of
   * the credit's rail value, not the amount the caller handed over on this
   * request — under an explicit fund-and-draw the caller may have funded twenty
   * jobs' worth. That makes it the revenue basis for this job: mid-job top-ups
   * accumulate onto it, and the terminal books exactly what the job consumed.
   */
  paidMsats: number;
  paymentMint?: string;
  /**
   * Rail that satisfied the upfront payment, if any. A {@link FundingMethod}
   * rather than a `PaymentMethod`: a draw against a Lightning-funded credit
   * reports `"lightning"` here, which is what lets the revenue
   * ledger book it instead of silently dropping the row.
   */
  paymentRail?: FundingMethod;
  receivedProofs: ProofLike[];
  /**
   * Settlement reference for the credit. x402 carries the EVM tx hash from
   * the facilitator; mpp carries the credential's `challenge.id`,
   * HMAC-bound to the realm so cross-DVM collisions are impossible;
   * cashu accumulator sets it to the `X-Cashu-Request-Id` UUID
   * Required by the platform revenue ledger for `tempo`/`x402`
   * rails; nullable for cashu's `tx_hash` column.
   */
  paymentTxHash?: string;
  /** Chain transaction returned to a caller recovering this accepted request. */
  paymentTransactionHash?: string;
  /**
   * Stablecoin micro-units for Tempo and x402. Cashu leaves this unset; its revenue is derived
   * from paidMsats.
   */
  nativeAmount?: number;

  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";
  /**
   * Discriminator written into `revenue_events.metadata.cashu_flow` so ops
   * queries can split per-call cashu rows by source path.
   */
  cashuFlow?: "p2pk_accumulator";
  /**
   * Base64-encoded x402 `SettleResponse` for the `X-PAYMENT-RESPONSE`
   * response header. Set on the upfront-flow x402 success path;
   * `app.ts` attaches it to the 2xx response per x402 spec.
   */
  x402SettleResponseHeader?: string;
  /** Exact-settlement admission retained until the matching upfront job row is durable. */
  x402ExactAdmission?: { intentId: string; jobId: string; replayed: boolean };
  /**
   * Credit-ledger linkage. Set whenever the payment funded and/or
   * drew the ledger — every paid job with a ledger wired. Persisted on the
   * job so the terminal funnel can settle/release the draw and the receipt
   * can countersign the `ReceiptCredit` block.
   */
  creditId?: string;
  /** The draw placed for this job on `creditId`. */
  drawId?: string;
  /** The draw's fiat amount, 1e-6 of {@link creditCurrency}. */
  drawAmountMicro?: number;
  /** Currency the credit — and therefore the draw — is denominated in. */
  creditCurrency?: string;
  /**
   * The funding leg, when this request actually moved money onto a credit
   * Reported to the platform as a **deposit**: a liability until
   * drawn, never summed into revenue. Absent on a pure draw against an
   * existing balance.
   */
  funding?: CreditFundingReport;
  /** Signed proof and snapshot for an explicit fund-and-draw funding leg. */
  fundingReceipt?: FundingReceipt;
  fundingCredit?: CreditSnapshot;
  /**
   * Fiat micro of {@link creditCurrency} this payment funded that bought the
   * job **nothing** — a second payment for an ask the job's draw
   * already covers, or the overpaid tail of an oversized one. It is available
   * balance on {@link creditId}, drainable at once, and the caller has to be
   * told or they will re-send. Absent on every ordinary payment.
   */
  unappliedMicro?: number;
  /**
   * The ledger's own record of a mid-job funding accepted against the job's
   * pending draw, fixed inside the rail transaction. Carries the immutable
   * signing inputs for the caller-facing draw funding receipt.
   */
  drawFunding?: FundingRecord;
}

/**
 * A funding event as the platform books it — one deposit row (spec
 * §10). Keyed on `(dvmId, creditId, fundingId)`, so a retried report is a
 * no-op rather than a double-count.
 */
export interface CreditFundingReport {
  creditId: string;
  /** Canonical owner returned by the ledger after applying the funding. */
  callerPubkey: string;
  /** The rail's own settlement reference — the deposit's idempotency key. */
  fundingId: string;
  rail: FundingMethod;
  /** Rail value received, in millisatoshis. */
  paidMsats: number;
  /** Gross Cashu proof face before its receiver input fee; Cashu only. */
  grossPaidMsats?: number;
  /** Standalone NUT-02 fee reserved by the received Cashu proofs; Cashu only. */
  cashuInputFeeMsats?: number;
  /** Rail-native atomic units; omitted for cashu (the platform derives from msats). */
  nativeAmount?: number;
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";
  mint?: string;
  /** Fiat micro credited to the ledger, and the currency it's denominated in. */
  amountMicro: number;
  currency: string;
  fundedAt: number;
  /** Current credit expiry after this funding committed (epoch ms). */
  expiryMs: number;
  /** The funded credit's stored instrument; absent for Cashu. */
  instrument?: CreditInstrument;
  /** TIP-1034 voucher identity, present only for session-funded credit. */
  tempoSession?: { channelId: string; cumulativeAmount: string };
  /** TIP-1034 chain binding, reported so the platform can route a close. */
  tempoChannel?: TempoChannelReport;
}

/**
 * The chain identity of a TIP-1034 channel, as reported to the platform
 * alongside its deposit. Read from the DVM's own durable channel
 * store, never from the caller's credential.
 */
export interface TempoChannelReport {
  chainId: number;
  escrow: string;
  payee?: string;
}

export interface UpfrontPaymentOpts {
  /** Server-created hosted admission that predates rail side effects. */
  hostingAdmissionId?: string;
  hostingPaymentArtifactHash?: string;
  cashuToken?: string;
  requiredMsats?: number;
  mints?: string[];
  /** Base64-encoded x402 `PaymentPayload` from the `X-PAYMENT` header. */
  x402Payment?: string;
  x402Config?: X402Config;
  /** Durable exact-settlement coordinator. Production hosts wire this automatically. */
  x402ExactSettlement?: X402ExactSettlementServer;
  /** Exact generations the facilitator currently advertises. Defaults to both. */
  x402ExactVersions?: X402ExactVersionSupport;
  /** Reusable channel acceptor. Only consulted for fund-only `/v1/credit` requests. */
  x402BatchSettlement?: X402BatchSettlementServer;
  /**
   * Resource URL the client retried against. Bound into the rebuilt
   * `PaymentRequirements` when verifying x402, and surfaced on the 402 body
   * `accepts` array for x402 dual-serve.
   */
  x402Resource?: string;
  /** Either the structured credential object or its serialized `Authorization: Payment <…>` value. */
  mppCredential?: MppxCredential | string;
  mpp?: MppxServer;
  /**
   * Request path of the resource being paid for (e.g. `/v1/job`). Bound into
   * each issued mppx challenge's `meta.path` so a credential can't be replayed
   * against a different paid endpoint of the same DVM.
   */
  resourcePath?: string;
  /**
   * Whether `tempo/session` may be issued and newly accepted right now — the
   * platform close-observer and hosted settlement-readiness gates, resolved per
   * request by `DVMServer`. Absent means offered: a
   * self-hosted DVM operates these responsibilities itself.
   *
   * `false` refuses a session credential that would open a channel the platform
   * cannot safely protect or settle, and withholds session
   * challenges from every 402 this call emits, *except* on a credit already
   * bound to a TIP-1034 channel. That deposit is already exposed, so refusing
   * its vouchers only strands it; and since a channel-bound credit can be funded
   * no other way, withholding the challenge as well would have made the
   * acceptance carve-out unreachable through ordinary discovery.
   */
  tempoSessionOffered?: boolean;
  /** Machine-readable cause when {@link tempoSessionOffered} is false. */
  tempoSessionUnavailableReason?: "observer_unhealthy" | "settlement_unhealthy";
  /**
   * Tracks consumed `(realm, challenge.id)` pairs so a credential that was
   * already accepted on the upfront path can't be replayed within its
   * `expires` window. Optional: when absent, the upfront flow has
   * no per-process replay protection beyond mppx's own expiry check.
   */
  consumedCredentialStore?: ConsumedCredentialStore;

  cashuMode?: CashuMode;
  /** Per-DVM Postgres pool — required for the `p2pk-accumulator` path. */
  accumulatorDb?: AccumulatorPool;
  disposableCashu?: DisposableCashuCommit;
  /** DVM identifier — required for the `p2pk-accumulator` path. */
  dvmId?: string;
  /**
   * Active NUT-11 P2PK lock pubkeys — required for the `p2pk-accumulator`
   * path. Includes the current pubkey followed by retired pubkeys still
   * within the rotation grace window. Caller resolves via
   * `loadLockPubkeyState` per-request so rotations propagate without a
   * server restart.
   */
  lockPubkeys?: LockPubkey[];
  /** UUIDv4 from `X-Cashu-Request-Id` header. */
  requestId?: string;
  /**
   * Runtime mint-health tracker. Receive path short-circuits with
   * `cashu_mint_sick` when the token's mint is currently flagged sick, so
   * agents retry against a healthy alternative without waiting for the
   * per-call mint timeout to fire inside `acceptAccumulatorPayment`.
   */
  mintHealthTracker?: MintHealthTracker;
  /**
   * Host fx fetcher used to price the non-sat rails (x402 USDC, mppx fiat)
   * through the same BTC/USD source the quote path uses. On a hosted
   * DVM this is the platform-served snapshot; self-hosted defaults to
   * CoinGecko-direct. Optional: a lazy default fetcher stands in when unset, so
   * the payment path never reaches `fetchBtcUsdRate`.
   */
  fxFetcher?: FxFetcher;
  /**
   * Attached payments fund and draw an implicit per-job credit atomically with
   * rail accounting. Omitting the ledger uses the legacy ledgerless path;
   * a configured ledger requires a fiat-denominated price before acceptance.
   */
  creditLedger?: CreditLedgerLike;
  /**
   * Durable processed-payment markers for the x402/mpp rails.
   * Those rails commit money outside dvmkit, so the marker row — written in
   * the same transaction as the ledger fund — is what makes a crash-replayed
   * credential unable to fund twice.
   */
  processedPayments?: ProcessedPaymentStore;
  /**
   * Reporter-owned transactional outbox enqueue. When present,
   * every funding awaits this inside the rail's commit transaction, so money
   * and its durable deposit report land together.
   */
  enqueueCreditDeposit?: CreditDepositEnqueue;
  /**
   * The job price's fiat denomination, pinned by the caller from the same
   * quote surface that produced `requiredMsats`. The ledger is
   * fiat-micro denominated; fund = draw = this amount in the exact-payment
   * case, so no fresh fx conversion happens on the verify hot path.
   */
  priceFiat?: PriceFiat;
  /** Pre-allocated job id — recorded on the draw so replays can recover the job. */
  jobId?: string;
  /** Durable submit fingerprint paired with {@link jobId} for exact-x402 job admission. */
  requestFingerprint?: string;
  /** Fingerprint including the caller-auth envelope, reserved to this exact intent. */
  requestAuthFingerprint?: string;
  /** Verified caller pubkey from the signed-request envelope, when the DVM has auth. */
  callerPubkey?: string;
  /** Requester id — funder identity fallback for DVMs without descriptor auth. */
  requesterId?: string;
  /**
   * Explicit credit fields extracted from the signed body (the signed credit contract). Their
   * signature coverage and structural validation happen in `app.ts` before
   * payment verification; this layer enforces ownership, the funding
   * commitment, and the draw itself.
   */
  creditEnvelope?: CreditEnvelope;
  /**
   * Turn this verification into a **fund-only top-up**: the rails
   * verify and commit exactly as they do for a job, but the ledger leg funds
   * without drawing — there is no job to pay for. Set by `POST /v1/credit`;
   * `requiredMsats` / `priceFiat` carry the requested top-up amount rather
   * than a job price.
   */
  fundOnly?: FundOnlyRequest;
  /**
   * Credit lifetime to mint, in ms — the DVM's advertised `credit.ttl`.
   * Defaults to {@link IMPLICIT_CREDIT_TTL_MS}. Threading it keeps the
   * funding menu honest: a DVM advertising a 7-day TTL must not mint 90-day
   * credits.
   */
  creditTtlMs?: number;
}

/** A fund-only top-up's identity: which credit, under which client-generated id. */
export interface FundOnlyRequest {
  /**
   * Target credit. `/v1/credit` always supplies one — either the caller's
   * `credit_id` or the deterministic id derived from `(pubkey, fund_id)` — so
   * a retry lands on the same credit and hits the `credit_fundings` key.
   */
  creditId?: string;
  /**
   * Builder opt-in for one-payment stablecoin credit. Absent fails closed;
   * only `POST /v1/credit` supplies this policy input.
   */
  allowOneShotStablecoin?: boolean;
  /** Client-generated idempotency key for this deposit (`credit_fundings` PK). */
  fundId: string;
  /**
   * SHA-256 hex over the raw funding artifact, signed by the caller (the signed credit contract
   * condition 3). Checked before any rail work: it is what binds the artifact
   * presented on the header to the deposit named in the signed body.
   */
  commitment: string;
}

export interface PaymentErrorDetail {
  body: Record<string, unknown>;
  status: number;
  /**
   * mppx challenges to advertise via `WWW-Authenticate` headers on the 402
   * response. Populated whenever the DVM has an mppx handle and
   * the request is short on payment — including on payment_invalid, since
   * draft-ryan-httpauth-payment-01 requires a fresh challenge on rejection.
   */
  mppChallenges?: Challenge.Challenge[];
  /**
   * x402 `PaymentRequirements` to merge into the 402 body's `accepts`
   * array under the `x402Version` envelope. Populated when the
   * DVM has x402 wired and dual-serve is on.
   */
  x402Requirements?: PaymentRequirements[];
  /** x402 v2-only requirements, including reusable batch-settlement channels. */
  x402V2Requirements?: PaymentRequirementsV2[];
  /**
   * Scheme-level error code for the x402 v2 envelope, kept apart from the
   * body's human `message` because a scheme client matches on it verbatim to
   * decide whether a 402 is correctable.
   */
  x402ErrorCode?: string;
  /**
   * On a `replay_rejected` from the x402/mpp processed-payment marker
   * the payment id the original funding committed under. The
   * route feeds it to the recovery gates (jobs persist it as
   * `payment_tx_hash`) so a crash-replayed credential can recover its
   * original job instead of a bare 409.
   */
  replayPaymentId?: string;
  /**
   * A short payment that was kept under the fail-closed posture and settled
   * on the spot. The route books it as revenue under a synthetic
   * job id — no job exists to carry it — tagged so it stays separable from
   * per-job service revenue.
   */
  forfeit?: ShortPayForfeit;
  /**
   * Money that landed on a credit even though this request failed. Set when a
   * short mid-job pay funds without completing its ask,
   * or an explicit upfront fund-and-draw commits the deposit but the combined
   * balance cannot cover the draw. In both cases the caller keeps an available
   * balance they can reclaim under the drain. That is a liability, so
   * the deposit has to reach the platform on the 402 path exactly as it does on
   * the success path, or the outstanding-liability view is short by precisely
   * the money we still owe.
   *
   * The same 402's body carries the credit id (`credit_id` / `credited_micro`
   * / `credit_currency`), so the caller can act on it without deriving one.
   *
   * Distinct from {@link forfeit}, which is money nothing is owed against:
   * that gets settled on the spot and booked as tagged revenue instead.
   */
  funding?: CreditFundingReport;
}

/** A kept-but-undelivered short payment, ready to be booked as tagged revenue. */
export interface ShortPayForfeit {
  /** Cashu request id — the rail settlement reference. */
  paymentId: string;
  paidMsats: number;
  mint?: string;
  creditId: string;
  drawId: string;
  amountMicro: number;
  currency: string;
  settledAt: number;
}

type PaymentResult = PaymentInfo & {
  error?: PaymentErrorDetail;
  /**
   * The signed body's `(credit_id, draw_id)` matches an already-recorded
   * draw (the draw-idempotency rule — the explicit idempotency regime).
   * No rail work ran and no second hold was placed; the route applies the
   * proof-of-origin gates and re-issues the original job's response.
   */
  replayedDraw?: { creditId: string; drawId: string; jobId: string | null };
};

/**
 * Whether a dev-mode server skips payment verification outright.
 *
 * Both upfront and mid-job acceptance require verification whenever any Cashu,
 * x402, or Tempo rail is configured. An unusable configured rail fails closed;
 * it never silently becomes synthetic development payment.
 *
 * Truthiness on the array reference is deliberate: `mints: []` does not skip.
 */
export function devModeSkipsPaymentVerification(opts: {
  devMode?: boolean;
  mints?: string[];
  x402?: X402Config;
  mpp?: MppxServer;
  paymentMethods?: PaymentMethod[];
}): boolean {
  return Boolean(opts.devMode) && !opts.mints && !opts.x402 && !opts.mpp &&
    !opts.paymentMethods?.some((method) => method === "cashu" || method === "x402" || method === "tempo");
}

/**
 * The keys a `payment` message carries money on, in the order
 * {@link verifyIncomingPayment} dispatches them. Adding a mid-job rail means
 * adding it here in the same commit — see {@link hasPaymentProof}.
 */
export const PAYMENT_PROOF_KEYS = ["cashu_token", "x402_payment", "tempo_credential"] as const;

/**
 * Whether a `payment` message carries a proof on any mid-job rail.
 *
 * Deliberately colocated with the rail dispatch it mirrors, because two call
 * sites decide on it: `validateMessageContent` (`server/app.ts`) admits a
 * proofless message only on a dev server, and `JobManager.processPayment`
 * drops the dev console's `dev_auto` flag whenever a proof rides beside it. A
 * rail added to the dispatch but not to {@link PAYMENT_PROOF_KEYS} would let
 * `dev_auto` credit the job for free and leave the caller's proof unspent.
 */
export function hasPaymentProof(content: Record<string, unknown>): boolean {
  return PAYMENT_PROOF_KEYS.some((key) => Boolean(content[key]));
}

/**
 * Issue one mppx Challenge per registered method for the upfront HTTP-transport
 * 402 path. Mirrors the message-based issuance loop in
 * `context.ts` but binds challenges via `meta` (resource path + per-request
 * nonce) instead of the per-job `pendingMppChallengeIds` binding —
 * there's no job at upfront challenge-issue time, so the binding has to live
 * inside the challenge itself.
 *
 * `meta.nonce` is unique-per-issue and HMAC-bound; consumed-id tracking on
 * the verification side is wired via `ConsumedCredentialStore`, so
 * a successfully-accepted credential can't be replayed within its `expires`
 * window even if it lands on the same paid endpoint.
 *
 * `btcUsdRate` is resolved once per request by the caller rather
 * than fetched here, so every rail this request advertises or verifies prices
 * off the same number and a rate-provider outage is handled in one place.
 *
 * `sessionIssuable` is the platform close-observer gate, threaded in
 * by `DVMServer` and defaulting to issuable for a self-hosted DVM that watches
 * its own closes. It used to gate advertisement only, so a `/v1/credit` 402
 * kept issuing `tempo/session` challenges the DVM had just stopped advertising
 * and its own interface doc said "advertised **and** issued". The
 * caller resolves it as "the gate is open, **or** this credit is already bound
 * to a channel", so a top-up on an existing channel keeps its challenge while
 * the gate is closed; `verifyUpfrontPayment` still refuses any *other* channel
 * before it is broadcast. `tempo/charge` is never withheld by observer
 * health. On the credit surface, `allowOneShotStablecoin` independently
 * suppresses it unless the builder accepts the manual-refund obligation; job
 * surfaces always keep charge.
 */
export async function issueUpfrontChallenges(
  mpp: MppxServer,
  requiredMsats: number,
  resourcePath: string,
  btcUsdRate: number,
  sessionIssuable = true,
  allowOneShotStablecoin: unknown = false,
  priceFiat?: PriceFiat
): Promise<Challenge.Challenge[]> {
  return loggers.tempo.span(
    "tempo.issue_challenges",
    {
      method_count: mpp.methods.length,
      required_msats: requiredMsats,
      resource_path: resourcePath,
    },
    async () => {
      const expires = new Date(Date.now() + UPFRONT_CHALLENGE_TTL_MS).toISOString();
      const challenges: Challenge.Challenge[] = [];
      // The partition is the resource path and nothing else:
      // reusable sessions are confined to `/v1/credit`; every other surface
      // offers one-shot charges only. The credit surface accepts a one-shot
      // charge only under the builder's explicit policy opt-in.
      // It used to widen for a `/v1/job` carrying a credit envelope, which put
      // a session challenge on the job surface the confinement excludes — and
      // `verifyUpfrontPayment` now refuses what that widening advertised, so
      // the two halves would contradict each other.
      //
      // `sessionIssuable` is the second, independent reason to skip one: the
      // platform's close observer is not confirmed to be watching, so a
      // channel opened against this challenge would be unprotected.
      const creditSurface = resourcePath.endsWith("/v1/credit");
      for (const m of mpp.methods) {
        const meta = m as { name: string; intent: string };
        if (meta.intent === "session" && (!creditSurface || !sessionIssuable)) continue;
        if (
          creditSurface &&
          meta.intent === "charge" &&
          !stablecoinCreditInstrumentAllowed(allowOneShotStablecoin, "tempo_charge")
        ) {
          continue;
        }
        const amount =
          priceFiat?.currency === "usd"
            ? fiatMicroToMethodAmount(priceFiat.amountMicro, meta.name)
            : msatsToMethodAmount(requiredMsats, meta.name, btcUsdRate);
        const ch = await mpp.issueChallenge(meta.name, meta.intent, {
          amount,
          ...(meta.intent === "session" && { suggestedDeposit: amount, unitType: "request" }),
          expires,
          meta: { path: resourcePath, nonce: randomBytes(16).toString("hex") },
        });
        challenges.push(ch);
      }
      return challenges;
    }
  );
}

export async function verifyUpfrontPayment(opts: UpfrontPaymentOpts): Promise<PaymentResult> {
  const result = await withPaymentDiagnostics(() => verifyUpfrontPaymentInScope(opts));
  if (!result.error && !result.replayedDraw && !result.upfrontPayment && !opts.fundOnly) {
    // Credit-backed results carry the committed draw separately. Legacy rail
    // payments use verified rail facts; a successful unpaid gate knows zero.
    result.upfrontPayment = {
      amount_msats: result.paidMsats,
      ...(result.paymentRail && { rail: result.paymentRail }),
      ...(result.nativeAmount !== undefined && result.nativeAsset !== undefined && {
        native_amount: result.nativeAmount, native_asset: result.nativeAsset,
      }),
    };
  }
  return result;
}

async function verifyUpfrontPaymentInScope(opts: UpfrontPaymentOpts): Promise<PaymentResult> {
  const {
    cashuToken,
    requiredMsats,
    mints,
    x402Payment,
    x402Config,
    x402Resource,
    mppCredential,
    mpp,
    resourcePath,
    consumedCredentialStore,
  } = opts;
  // Absent means offered: a self-hosted DVM has no platform observer to gate on.
  const sessionOffered = opts.tempoSessionOffered ?? true;
  const sessionUnavailable = tempoSessionUnavailableCopy(opts.tempoSessionUnavailableReason);
  const x402PriceFiat = opts.priceFiat?.currency === "usd" ? opts.priceFiat : undefined;
  // A presented authorization must meet the same currency gate as discovery.
  // Refuse before resolving a rate or invoking a facilitator: there is no
  // honest USDC requirement for a non-USD price, so no payment may move.
  if (x402Payment && x402Config && requiredMsats && !x402PriceFiat) {
    return x402NotOfferedResult(opts.priceFiat?.currency);
  }
  // Issuance is the wider of the two halves of the gate, and deliberately so.
  // Acceptance keys on the *channel* the credential names, so a closed gate that
  // also withheld every challenge left that carve-out unreachable by ordinary
  // discovery: a caller holding an open channel POSTs `/v1/credit`, gets a
  // charge-only 402, and has nothing to sign a voucher against — the top-up the
  // gate is supposed to keep working stops working. A credit already bound to a
  // channel therefore still gets its session challenge. It is not a
  // hole in the gate: the credit's binding proves the exposure predates this
  // outage, and a credential naming any *other* channel still meets the
  // acceptance refusal below, before mppx broadcasts anything.
  const sessionIssuable = sessionOffered || (await targetCreditHoldsTempoChannel(opts));
  // Only rails whose native amount must be derived from msats need a BTC/USD
  // rate. x402 is offered only when `priceFiat.amountMicro` already states the
  // exact USD requirement, just as Cashu is already stated in sats; neither
  // should touch the rate provider on the payment hot path. MPP still needs
  // the conversion.
  const x402ExactVersions = opts.x402ExactVersions ?? { v1: true, v2: true };
  const x402Advertised =
    Boolean(x402Config) &&
    Boolean(x402PriceFiat) &&
    (x402Config?.dualServe ?? true) &&
    (x402ExactVersions.v1 || x402ExactVersions.v2);
  const needsRate = Boolean(requiredMsats) && Boolean(mpp);
  // Resolve once per request, before any rail's `try` block — a rate-provider
  // outage inside one of those would be caught by its credential-verification
  // `catch` and reported to the caller as `payment_invalid`, blaming a payment
  // that was fine.
  const rate = needsRate ? await resolveRateOrNull(opts.fxFetcher) : null;
  // `rate === null` says two different things: "no rail here wants one" and
  // "a rail here wants one and neither a live nor a cached rate exists". Only
  // the second is a failure.
  const rateOutage = needsRate && rate === null;

  // Build the x402 `accepts` array once per request so 402 errors and the
  // upfront verify path agree on the requirements being advertised. Only emit
  // when dual-serve is on (default true; explicit false suppresses). The USD
  // price is statable without a rate; other pricing currencies are gated out.
  const x402Requirements =
    x402Config &&
    x402Advertised &&
    x402PriceFiat &&
    requiredMsats &&
    (!opts.fundOnly ||
      stablecoinCreditInstrumentAllowed(opts.fundOnly.allowOneShotStablecoin, "x402_exact"))
      ? buildX402Requirements(x402Config, x402Resource ?? "/v1/job", x402PriceFiat)
      : undefined;
  const x402BatchRequirements =
    opts.fundOnly &&
    opts.x402BatchSettlement &&
    x402Advertised &&
    x402PriceFiat &&
    requiredMsats
      ? await opts.x402BatchSettlement.buildRequirements(
          String(x402RequiredUsdcMicro(x402PriceFiat))
        )
      : undefined;

  // Every rail payment below is reinterpreted as fund_credit + draw. A free
  // job or a DVM with no ledger wired runs legacy (ledger-less) semantics; a
  // paid job that can't be fiat-denominated throws rather than
  // taking money the ledger will never see.
  const ledgerCtx = resolveLedgerContext(opts);
  const creditEnv = opts.creditEnvelope;
  const fundingArtifact =
    cashuToken ?? x402Payment ?? (typeof mppCredential === "string" ? mppCredential : undefined);
  // Which rail an attached artifact will commit on, in the same precedence the
  // rail branches below try them. Meaningful only alongside `fundingArtifact`.
  const attachedRail = cashuToken ? "cashu" : x402Payment ? "x402" : "tempo";
  const attachedBinding = await incomingCreditBinding({
    rail: attachedRail,
    x402Payment,
    mppCredential,
  });

  // A `/v1/credit` top-up has no draw, so it doesn't travel the credit-
  // envelope path below — but its `fund.commitment` binds the artifact to the
  // deposit exactly the same way, and the binding has to be checked before
  // any rail commits. A *missing* artifact is the 402 discovery hop (POST →
  // 402 → pay → resubmit), not a mismatch, so only a present-and-wrong
  // artifact refuses here.
  if (opts.fundOnly && fundingArtifact) {
    if (fundingCommitment(fundingArtifact) !== opts.fundOnly.commitment) {
      logCreditRejected("fund_commitment_mismatch", opts.fundOnly.creditId);
      return creditRefusal(
        "funding_commitment_mismatch",
        "fund.commitment does not match the SHA-256 of the attached funding artifact."
      );
    }
    // Same reason the mid-job preflight checks the rail. The
    // route's own `checkTargetCredit` cannot cover this one: which rail is
    // arriving is a property of the headers, not the signed body, so it is
    // only knowable here — but still before anything commits.
    const creditId = opts.fundOnly.creditId;
    if (creditId && opts.creditLedger) {
      const refusal = crossRailRefusal(await opts.creditLedger.get(creditId), {
        creditId,
        binding: attachedBinding,
      });
      if (refusal) return refusal;
      const channelRefusal = await crossCreditChannelRefusal(opts.creditLedger, {
        creditId,
        binding: attachedBinding,
      });
      if (channelRefusal) return channelRefusal;
    }
  }

  // Runs before any rail work so a malformed or mismatched request commits
  // nothing. Only priced requests participate — credit fields on a free job
  // are ignored (nothing to fund, nothing to draw).
  if (creditEnv && requiredMsats) {
    const ledger = opts.creditLedger;
    if (!ledger) {
      return creditRefusal("payment_invalid", "This DVM has no credit ledger wired.");
    }
    if (!opts.callerPubkey) {
      return creditRefusal(
        "payment_invalid",
        "Credit fields require signed-request auth — the draw is keyed to the caller's pubkey."
      );
    }
    if (!ledgerCtx) {
      return creditRefusal(
        "payment_invalid",
        "The job price cannot be denominated in the ledger currency right now — retry later or pay per-job without credit fields."
      );
    }
    if (creditEnv.fund) {
      if (!fundingArtifact) {
        return creditRefusal(
          "funding_commitment_mismatch",
          "The signed body carries a fund block but no funding artifact (X-Cashu / X-PAYMENT / Authorization: Payment) is attached."
        );
      }
      if (fundingCommitment(fundingArtifact) !== creditEnv.fund.commitment) {
        return creditRefusal(
          "funding_commitment_mismatch",
          "fund.commitment does not match the SHA-256 of the attached funding artifact."
        );
      }
    } else if (fundingArtifact) {
      return creditRefusal(
        "funding_commitment_mismatch",
        "A funding artifact is attached but the signed body carries no fund block binding it to the credit."
      );
    }
    // Explicit idempotency regime (the draw-idempotency rule): a recorded
    // (credit_id, draw_id) means this request already ran — no rail work, no
    // second hold. Ownership gates before honoring the replay.
    const existingDraw = await ledger.getDraw({
      creditId: creditEnv.creditId,
      drawId: creditEnv.drawId,
    });
    const credit = await ledger.get(creditEnv.creditId);
    // The job path's half of the derived-namespace rule: a caller
    // may draw on a derived credit it owns, but may never open one — a credit
    // squatted here would cost the id's rightful owner a settled payment on
    // their next `/v1/credit` top-up. One answer covers "someone else's" and
    // "doesn't exist" alike, and that is deliberate: both namespaces are
    // computable from public inputs, so distinguishable refusals would make
    // this route an existence oracle over other callers' credits.
    if (isDerivedCreditId(creditEnv.creditId) && credit?.callerPubkey !== opts.callerPubkey) {
      logCreditRejected("derived_credit_id_denied", creditEnv.creditId);
      return creditRefusal(
        "credit_id_unavailable",
        `credit_id ${creditEnv.creditId} is in a namespace this provider derives — reference one you own, or let the provider open it.`
      );
    }
    if (credit && credit.callerPubkey !== opts.callerPubkey) {
      logCreditRejected("caller_mismatch", creditEnv.creditId);
      return creditRefusal(
        "payment_invalid",
        "The referenced credit belongs to a different caller."
      );
    }
    if (existingDraw) {
      return {
        paidMsats: 0,
        receivedProofs: [],
        replayedDraw: {
          creditId: creditEnv.creditId,
          drawId: creditEnv.drawId,
          jobId: existingDraw.jobId,
        },
      };
    }
    if (credit && credit.currency !== ledgerCtx.priceFiat.currency) {
      logCreditRejected("currency_mismatch", creditEnv.creditId);
      return creditRefusal(
        "payment_invalid",
        `The referenced credit is denominated in ${credit.currency}, not ${ledgerCtx.priceFiat.currency}.`
      );
    }
    if (creditEnv.fund) {
      const refusal = crossRailRefusal(credit, {
        creditId: creditEnv.creditId,
        binding: attachedBinding,
      });
      if (refusal) return refusal;
      const channelRefusal = await crossCreditChannelRefusal(ledger, {
        creditId: creditEnv.creditId,
        binding: attachedBinding,
      });
      if (channelRefusal) return channelRefusal;
    }
    if (!credit && !creditEnv.fund) {
      return creditRefusal(
        "credit_not_found",
        `No credit exists under id ${creditEnv.creditId} — fund it before drawing.`
      );
    }
  }

  if (cashuToken) {
    if (!mints?.length) {
      return {
        paidMsats: 0,
        receivedProofs: [],
        error: {
          body: paymentErrorBody("cashu_unavailable", {
            message: "This DVM is not configured to accept Cashu payments.",
          }),
          status: 402,
          ...(x402Requirements && { x402Requirements }),
        },
      };
    }

    // Agent-wallet: the SDK accepts P2PK-locked proofs from agents,
    // verifies the lock, and either accumulates (sub-threshold) or swaps
    // on-receive (above-threshold).
    if (
      opts.cashuMode === "p2pk-accumulator" &&
      (opts.accumulatorDb || opts.disposableCashu) &&
      opts.dvmId &&
      opts.lockPubkeys &&
      opts.lockPubkeys.length > 0
    ) {
      return verifyAccumulatorReceipt(opts, mints, requiredMsats, ledgerCtx);
    }

    // Unlocked Cashu proofs are no longer accepted. Only P2PK-locked
    // proofs via the agent-wallet accumulator path are valid.
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("cashu_not_p2pk_locked", {
          message: "This DVM requires P2PK-locked Cashu proofs. Initialize an agent wallet first.",
          extra: { mints },
        }),
        status: 402,
        ...(x402Requirements && { x402Requirements }),
      },
    };
  }

  if (
    x402Payment &&
    x402Config &&
    requiredMsats &&
    paymentScheme(x402Payment) === X402_BATCH_SETTLEMENT_SCHEME
  ) {
    if (!x402PriceFiat) return x402NotOfferedResult(opts.priceFiat?.currency);
    if (!opts.fundOnly || !opts.x402BatchSettlement) {
      return creditRefusal(
        "payment_invalid",
        "Reusable x402 channels are accepted only by POST /v1/credit."
      );
    }
    if (rateOutage) return rateUnavailableResult();
    if (!ledgerCtx?.fundOnly?.creditId) {
      throw new Error("x402 batch settlement requires a named credit funding effect");
    }
    if (ledgerCtx.hostingAdmissionId && !ledgerCtx.hostingPaymentArtifactHash) {
      throw new Error("Hosted x402 funding lacks its original payment artifact");
    }
    const requiredUsdcMicro = x402RequiredUsdcMicro(x402PriceFiat);
    try {
      const accepted = await opts.x402BatchSettlement.accept({
        paymentHeader: x402Payment,
        amount: String(requiredUsdcMicro),
        operation: "fund",
        effectId: `${ledgerCtx.fundOnly.creditId}:${ledgerCtx.fundOnly.fundId}`,
        ...(ledgerCtx.hostingAdmissionId && {
          hostingFunding: {
            admissionId: ledgerCtx.hostingAdmissionId,
            creditId: ledgerCtx.fundOnly.creditId,
            fundId: ledgerCtx.fundOnly.fundId,
            callerPubkey: ledgerCtx.callerId,
            commitment: ledgerCtx.fundOnly.commitment,
            paymentArtifactHash: ledgerCtx.hostingPaymentArtifactHash ?? "",
          },
        }),
        commit: async (funding, tx) => {
          return commitMarkedFunding(
            ledgerCtx,
            {
              rail: "x402",
              paymentId: funding.paymentId,
              paidMsats: requiredMsats,
              fundedMicro: ledgerCtx.priceFiat.amountMicro,
              nativeAmount: requiredUsdcMicro,
              nativeAsset: "usdc",
              x402Channel: {
                channelId: funding.channelId,
                maxClaimableAmount: funding.maxClaimableAmount,
              },
            },
            tx
          );
        },
      });
      if (!accepted.ok) {
        return {
          paidMsats: 0,
          receivedProofs: [],
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: `x402 channel payment refused: ${accepted.reason}`,
            }),
            status: 402,
            ...(x402Requirements && { x402Requirements }),
            x402V2Requirements: accepted.requirements,
            x402ErrorCode: accepted.reason,
          },
        };
      }
      const credited = accepted.value.committed;
      return withDrawBasis(
        {
          paidMsats: requiredMsats,
          paymentRail: "x402",
          receivedProofs: [],
          paymentTxHash: accepted.value.funding.paymentId,
          nativeAmount: requiredUsdcMicro,
          nativeAsset: "usdc",
          x402SettleResponseHeader: Buffer.from(JSON.stringify(accepted.value.settlement)).toString(
            "base64"
          ),
        },
        ledgerCtx,
        credited
      );
    } catch (err) {
      const mapped = mapLedgerCommitError(err, x402Requirements);
      if (mapped) {
        logCredentialRejected("x402", "upfront", err);
        return mapped;
      }
      logCredentialRejected("x402", "upfront", err);
      return {
        paidMsats: 0,
        receivedProofs: [],
        error: {
          body: paymentErrorBody("payment_invalid", {
            message: "x402 channel payment verification failed",
          }),
          status: 402,
          ...(x402Requirements && { x402Requirements }),
          ...(x402BatchRequirements && { x402V2Requirements: x402BatchRequirements }),
        },
      };
    }
  }

  if (x402Payment && x402Config && requiredMsats) {
    if (!x402PriceFiat) return x402NotOfferedResult(opts.priceFiat?.currency);
    if (
      opts.fundOnly &&
      !stablecoinCreditInstrumentAllowed(opts.fundOnly.allowOneShotStablecoin, "x402_exact")
    ) {
      return oneShotCreditRefusal("x402 exact");
    }
    if (rateOutage) return rateUnavailableResult();
    try {
      // The same derivation `buildX402Requirements` advertised with, not a
      // second one. A 402 has no server-side row, so the figure the
      // settlement is valued against is reconstructed here — and while that
      // reconstruction went through the BTC rate it was not stable across an
      // fx refresh, which turned a conformant caller's exact payment into a
      // post-settlement `funding_commitment_mismatch`.
      const requiredUsdcMicro = BigInt(x402RequiredUsdcMicro(x402PriceFiat));
      // Explicit fund amount check, run BEFORE `/settle`. The
      // valuation needs nothing the facilitator has to tell us: the signed
      // authorization's `value` is what settles verbatim (`verifyX402Payment`
      // reads the same field off the same payload), so the identical
      // comparison the post-settlement gate makes below is computable from a
      // local decode. Running it here is what turns this whole bug class from
      // a money loss into a clean re-present. A header this can't decode — or
      // one authorizing
      // less than `maxAmountRequired` — falls through: the facilitator reports
      // both canonically, and blaming the caller's arithmetic for a malformed
      // or underfunded credential would be wrong.
      if (creditEnv?.fund && ledgerCtx) {
        const predicted = predictX402FundedMicro(
          x402Payment,
          ledgerCtx.priceFiat.amountMicro,
          Number(requiredUsdcMicro)
        );
        if (predicted !== undefined && creditEnv.fund.amountMicro !== predicted) {
          logCreditRejected("fund_amount_mismatch_presettle", creditEnv.creditId);
          return creditRefusal(
            "funding_commitment_mismatch",
            `fund.amount_micro (${creditEnv.fund.amountMicro}) does not match the attached authorization's value at the quoted price (${predicted}).`,
            {
              extra: { expected_micro: predicted },
              // Nothing settled, so the EIP-3009 nonce is unspent and the same
              // header is still payable — unlike the post-settlement branch
              // below, where saying this would be telling the caller to pay
              // twice.
              hint: `Nothing was settled — re-sign this request with fund.amount_micro set to expected_micro (${predicted}), re-attach this same X-PAYMENT header, and resubmit.`,
            }
          );
        }
      }
      if (opts.x402ExactSettlement) {
        return await acceptDurableExactUpfront({
          settlement: opts.x402ExactSettlement,
          paymentHeader: x402Payment,
          config: x402Config,
          requiredUsdcMicro,
          resource: x402Resource ?? "/v1/job",
          btcUsdRate: rate ?? 0,
          exactVersions: x402ExactVersions,
          dvmId: opts.dvmId ?? "",
          requiredMsats,
          ledgerCtx,
          x402Requirements,
        });
      }
      const { verifyX402Payment } = await import("../../lib/x402");
      const receipt = await withPaymentStage("verifier_broadcast", () => verifyX402Payment(
        x402Payment,
        x402Config,
        requiredUsdcMicro,
        x402Resource ?? "/v1/job",
        rate ?? 0,
        x402ExactVersions
      ));
      if (receipt.verified) {
        // Value the settlement against the figure the 402 advertised, in the
        // rail's own units — never by re-deriving millisatoshis
        // from it, which is not the inverse of the conversion that produced
        // the advertisement. `x402SettledShare` restates both frames at one
        // ratio, so an authorization for exactly `maxAmountRequired` is
        // exactly the quote and an overpayment stays pro-rata. That exactness
        // is only reachable because `requiredUsdcMicro` above is the figure
        // this request would advertise rather than a re-derivation off a
        // moving rate. A receipt with no rail-native figure
        // (nothing in-tree emits one) keeps the old msat reading.
        const settledUsdcMicro = receipt.amountUsdcMicro;
        const paidMsats =
          settledUsdcMicro === undefined
            ? receipt.amountMsats
            : x402SettledShare(requiredMsats, Number(requiredUsdcMicro), settledUsdcMicro);
        // Ledger leg (spec condition 3): the money moved at the
        // facilitator's /settle, so the durable commit dvmkit owns is the
        // processed-payment marker + fund + draw, all in one transaction
        // keyed on the settlement tx hash. A marker collision means this
        // payment already funded — route to the recovery gates.
        let credited: CommittedFunding | undefined;
        const paymentId = receipt.txHash;
        if (ledgerCtx && !paymentId) {
          if (creditEnv?.fund) {
            // The caller signed an explicit funding commitment, but the rail
            // returned no settlement reference to key the marker on — the
            // funding can't be committed idempotently, and silently minting
            // no credit would leave the caller believing they funded one.
            // Money already moved at the facilitator, so fail closed like
            // the amount-mismatch branch below.
            logCreditRejected("x402_missing_tx_hash_explicit_fund", creditEnv.creditId);
            return creditRefusal(
              "payment_invalid",
              "The payment settled but returned no transaction reference, so the signed funding commitment cannot be recorded. The explicit funding was refused; retry without a fund block or contact the service operator."
            );
          }
          // Implicit N=1: no settlement reference to key the marker on — skip
          // the ledger leg (legacy semantics) rather than mint an unkeyed
          // funding. Money is never refused for a rail metadata gap.
          logCreditRejected("x402_missing_tx_hash", undefined);
        }
        if (ledgerCtx && paymentId) {
          // The fiat half of the same valuation — one rounding, in USDC.
          // Threaded to the commit below rather than left to `fundAndDraw`'s
          // own `fundedMicroFor`: a gate that accepted `price_micro` while the
          // ledger minted `price_micro + 1` would be the reported bug moved
          // one layer down, where nothing refuses it.
          const fundedMicro =
            settledUsdcMicro === undefined
              ? fundedMicroFor(ledgerCtx.priceFiat, paidMsats, ledgerCtx.requiredMsats)
              : x402SettledShare(
                  ledgerCtx.priceFiat.amountMicro,
                  Number(requiredUsdcMicro),
                  settledUsdcMicro
                );
          if (creditEnv?.fund && creditEnv.fund.amountMicro !== fundedMicro) {
            // Reachable only for a header `predictX402FundedMicro` declined to
            // judge — in practice one it could not decode, since
            // the other decline, an authorization below `maxAmountRequired`,
            // never gets past `/verify` to settle. For everything else the
            // pre-settle gate above already made this exact comparison on this
            // exact `value`. Kept as the backstop, not deleted: it is the one
            // that holds if the two valuations ever drift, and the drift is a
            // money bug.
            //
            // The facilitator has already settled — money moved. Fail closed
            // (no job, no credit) like every post-commit refusal;
            // the mismatch is a malformed client, and the tx hash is in the
            // log for reconciliation.
            logCreditRejected("fund_amount_mismatch", creditEnv.creditId, { paymentId });
            return creditRefusal(
              "funding_commitment_mismatch",
              `fund.amount_micro (${creditEnv.fund.amountMicro}) does not match the settled payment's value at the quoted price (${fundedMicro}).`,
              // `expected_micro` states the valuation, but carries no corrective
              // hint here: the facilitator already settled, so re-presenting
              // this credential would be a second payment.
              { extra: { expected_micro: fundedMicro } }
            );
          }
          try {
            credited = await commitMarkedFunding(ledgerCtx, {
              rail: "x402",
              paymentId,
              paidMsats,
              fundedMicro,
              nativeAmount: receipt.amountUsdcMicro,
              nativeAsset: "usdc",
            });
          } catch (err) {
            const mapped = mapLedgerCommitError(err, x402Requirements, true);
            if (mapped) {
              logCredentialRejected("x402", "upfront", err);
              return mapped;
            }
            throw err;
          }
        }
        if (credited?.drawRefusal) {
          return creditLedgerErrorResult(credited.drawRefusal, x402Requirements, credited.deposit);
        }
        return withDrawBasis(
          {
            paidMsats,
            paymentRail: "x402",
            receivedProofs: [],
            paymentTxHash: receipt.txHash,
            paymentTransactionHash: receipt.txHash,
            nativeAmount: receipt.amountUsdcMicro,
            nativeAsset: "usdc",
            x402SettleResponseHeader: receipt.settleResponseHeader,
          },
          ledgerCtx,
          credited
        );
      }
      return {
        paidMsats: 0,
        receivedProofs: [],
        error: {
          body: paymentErrorBody("payment_invalid", {
            message: "x402 payment verification failed",
          }),
          status: 402,
          ...(x402Requirements && { x402Requirements }),
        },
      };
    } catch (err) {
      // Verifier internals must not become a caller-facing credential oracle.
      logCredentialRejected("x402", "upfront", err);
      return {
        paidMsats: 0,
        receivedProofs: [],
        error: {
          body: paymentErrorBody("payment_invalid", { message: "x402 verification error" }),
          status: 402,
          ...(x402Requirements && { x402Requirements }),
        },
      };
    }
  }

  if (mppCredential && mpp && requiredMsats) {
    if (rate === null) return rateUnavailableResult();
    try {
      // Normalize so we can read challenge.method without re-deserializing.
      const { Credential } = await import("mppx");
      const cred =
        typeof mppCredential === "string" ? Credential.deserialize(mppCredential) : mppCredential;
      if (
        opts.fundOnly &&
        cred.challenge.intent === "charge" &&
        !stablecoinCreditInstrumentAllowed(opts.fundOnly.allowOneShotStablecoin, "tempo_charge")
      ) {
        return oneShotCreditRefusal("Tempo charge");
      }
      // The upfront half of the `/v1/credit` confinement, and the
      // twin of the x402 batch-settlement guard above. `fundOnly` is set by
      // `POST /v1/credit` and by nothing else, so this refuses every reusable
      // channel presented anywhere on the job surface — including an `open` or
      // `topUp`, which carry no voucher basis and so would slip a
      // `sessionBasis`-shaped test. It runs before `broadcastCredential`
      // because mppx charges the channel there, so a later refusal would
      // already have moved the caller's money.
      if (isMppSessionCredential(cred) && !opts.fundOnly) {
        return creditRefusal("payment_invalid", MPP_SESSION_ONLY_ON_CREDIT);
      }
      // The acceptance half of the close-observer gate. Withholding
      // the advertisement was never enough on its own: a caller holding a
      // cached `/v1/info`, or one that simply posts a credential, reached this
      // path and opened a channel nobody was watching — the exact loss the
      // gate exists to prevent. A channel already in this DVM's own store is
      // let through, because its deposit is already exposed and refusing its
      // vouchers would strand the caller's money rather than protect it; only
      // a channel we have never seen is a *new* exposure. Unknown reads as new
      // (including a store that cannot answer), so the gate stays fail-closed.
      //
      // Placed above `broadcast` for the same reason as the refusal above it:
      // mppx opens and charges the channel there.
      if (isMppSessionCredential(cred) && !sessionOffered) {
        const channelId = mppSessionChannelId(cred);
        const known = channelId
          ? await mpp.getTempoSessionBinding?.(channelId).catch(() => null)
          : null;
        if (!known) {
          diagnosticConsole.warn(
            {
              level: "warn",
              event: "tempo_session_open_refused",
              message: undefined,
              channel_id: channelId,
              // True means the credit is bound to some *other* channel — a
              // stale client, not a caller trying to open a fresh one.
              credit_channel_bound: sessionIssuable,
            }
          );
          return {
            paidMsats: 0,
            receivedProofs: [],
            error: {
              body: paymentErrorBody("payment_invalid", {
                message: sessionUnavailable.message,
                display: sessionUnavailable.display,
                // Two different retries, so two different hints. On a
                // channel-bound credit the challenges below still carry a
                // session, and the caller's own channel is the one thing that
                // can fund it — a charge would be refused by the ledger. On any
                // other credit the session is withheld. Charge is a credit
                // fallback only under the builder's explicit opt-in; otherwise
                // it remains a per-call alternative, not a challenge this
                // credit request can act on.
                hint: sessionIssuable
                  ? "Re-sign against the challenge attached to this response, using the channel " +
                    "already open for this credit — that one is unaffected."
                  : opts.fundOnly &&
                      !stablecoinCreditInstrumentAllowed(
                        opts.fundOnly.allowOneShotStablecoin,
                        "tempo_charge"
                      )
                    ? "Wait until this service can open a reusable Tempo channel, or pay for a single call with tempo/charge instead. This DVM does not accept tempo/charge for prepaid credit."
                    : "Fund the credit with a tempo/charge credential instead — it is unaffected " +
                      "and is offered on the challenges attached to this response.",
              }),
              status: 402,
              mppChallenges: await issueUpfrontChallenges(
                mpp,
                requiredMsats,
                resourcePath ?? "/v1/job",
                rate,
                sessionIssuable,
                opts.fundOnly?.allowOneShotStablecoin,
                opts.priceFiat
              ),
            },
          };
        }
      }
      const expectedAmount =
        opts.priceFiat?.currency === "usd"
          ? fiatMicroToMethodAmount(opts.priceFiat.amountMicro, cred.challenge.method)
          : msatsToMethodAmount(requiredMsats, cred.challenge.method, rate);
      const sessionBasis = mppSessionBasis(cred);
      // mppx resolves its realm from process env and leaves it undefined when
      // nothing names one; it then verifies the credential against the
      // challenge's own HMAC-bound realm. Key replay on that same realm, which
      // is always a string, so the Postgres store's NOT NULL realm column has one.
      const replayRealm = mpp.realm ?? cred.challenge.realm;
      // Refuse a credential whose `(realm, challenge.id)` was already accepted
      // within the consumed-store TTL before anything broadcasts or commits:
      // the session path commits its funding inside the broadcast, so a later
      // refusal would answer 402 for a credit the ledger keeps. The realm is
      // not yet HMAC-verified here; a tampered one can only miss, and the
      // broadcast then refuses the credential. Per-job mid-flow replay is
      // handled separately by `pendingMppChallengeIds` in `processIncomingPayment`.
      if (
        consumedCredentialStore &&
        await withPaymentStage("replay_store", () =>
          consumedCredentialStore.has(replayRealm, cred.challenge.id))
      ) {
        // Spec-compliant retry shape: hand the client a fresh challenge so
        // it has something to pay against on the next attempt.
        const mppChallenges = await issueUpfrontChallenges(
          mpp,
          requiredMsats,
          resourcePath ?? "/v1/job",
          rate,
          sessionIssuable,
          opts.fundOnly?.allowOneShotStablecoin,
          opts.priceFiat
        );
        return {
          paidMsats: 0,
          receivedProofs: [],
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: "MPP credential already used",
            }),
            status: 402,
            mppChallenges,
            ...(x402Requirements && { x402Requirements }),
          },
        };
      }
      // Pass `request.amount` so mppx asserts the credential's HMAC-bound amount
      // equals what the SDK actually requires. Without it, a credential bound to
      // amount X passes verification for a request that wanted amount Y, opening
      // a short-pay vector. Pass `meta` built from the *live* request path plus
      // the credential's own nonce: mppx rebuilds the expected challenge with
      // `meta = { path: resourcePath, nonce }` and deep-equals it against the
      // credential's actual meta, so a credential bought for `/v1/job` fails
      // when replayed against any other paid endpoint. The nonce is
      // HMAC-bound and server-issued, so trusting the credential's value for
      // the rebuild is sound; the path is *not* HMAC-bound across endpoints,
      // which is exactly why this comparison has to be against the live path.
      let tempoReceipt: { reference?: unknown; txHash?: unknown } | undefined;
      const broadcast = async () => {
        const receipt = await loggers.tempo.span(
          "tempo.verify_credential",
          {
            method: cred.challenge.method,
            challenge_id: cred.challenge.id,
            amount: expectedAmount,
          },
          () =>
            withPaymentStage("verifier_broadcast", () => mpp.broadcastCredential(mppCredential, {
              request: { amount: expectedAmount },
              ...(opts.hostingAdmissionId && {
                hostedPaymentIntent: {
                  admissionId: opts.hostingAdmissionId,
                  jobId: opts.jobId,
                  paymentArtifactHash: opts.hostingPaymentArtifactHash,
                  ...(ledgerCtx?.fundOnly && {
                    creditId: ledgerCtx.fundOnly.creditId,
                    fundId: ledgerCtx.fundOnly.fundId,
                    callerPubkey: ledgerCtx.callerId,
                    fundingCommitment: ledgerCtx.fundOnly.commitment,
                  }),
                },
              }),
              meta: {
                path: resourcePath ?? "/v1/job",
                nonce: challengeMeta(cred.challenge)?.nonce ?? "",
              },
            })),
        { onError: paymentFailureFields }
        );
        tempoReceipt = receipt as { reference?: unknown; txHash?: unknown };
        return receipt;
      };
      let credited: CommittedFunding | undefined;
      if (sessionBasis && ledgerCtx && mpp.withTempoSessionAcceptance) {
        const funding: RailFunding & { rail: "tempo" } = {
          rail: "tempo",
          paymentId: mppPaymentId(cred),
          tempoSession: sessionBasis,
          paidMsats: requiredMsats,
          nativeAmount: methodNativeAmountFromDecimal(expectedAmount, cred.challenge.method),
          nativeAsset: methodNativeAsset(cred.challenge.method),
        };
        try {
          if (ledgerCtx.hostingAdmissionId && ledgerCtx.fundOnly &&
            !ledgerCtx.hostingPaymentArtifactHash) {
            throw new Error("Hosted Tempo funding lacks its original payment artifact");
          }
          const voucherAcceptance = {
            channelId: sessionBasis.channelId,
            cumulativeAmount: BigInt(sessionBasis.cumulativeAmount),
            ...(ledgerCtx.hostingAdmissionId && ledgerCtx.fundOnly && {
              hostingFunding: {
                admissionId: ledgerCtx.hostingAdmissionId,
                creditId: ledgerCtx.fundOnly.creditId,
                fundId: ledgerCtx.fundOnly.fundId,
                callerPubkey: ledgerCtx.callerId,
                commitment: ledgerCtx.fundOnly.commitment,
                paymentArtifactHash: ledgerCtx.hostingPaymentArtifactHash ?? "",
              },
            }),
          };
          const accepted = await mpp.withTempoSessionAcceptance(
            voucherAcceptance,
            async (tx, voucher) => {
              // read the channel's chain binding from our own store
              // never the caller's credential — and report it alongside the
              // deposit so the platform can route a later close event back
              // here. Inside the acceptance transaction on purpose: the
              // registration and the funding that created its liability commit
              // together, and the store reuses this transaction's client —
              // which is why the store writes the channel row before invoking
              // this callback.
              const binding = await mpp.getTempoSessionBinding?.(sessionBasis.channelId);
              if (binding) {
                funding.tempoChannel = {
                  chainId: binding.chainId,
                  escrow: binding.escrowContract,
                  ...(binding.payee && { payee: binding.payee }),
                };
              } else {
                // an unreadable binding is a channel the platform's
                // close observer will never watch, and everything downstream
                // succeeds — the deposit records, the credit funds, health
                // answers `observing: 0` as healthy. This log is the only
                // signal the loss produces, so it must not be silent. The
                // deposit still commits: refusing here would take the caller's
                // money and hand back nothing.
                logTempoBindingUnavailable({
                  channelId: sessionBasis.channelId,
                  creditId: ledgerCtx.fundOnly?.creditId,
                  dvmId: ledgerCtx.dvmId,
                });
              }
              return commitExactTempoVoucherFunding(ledgerCtx, funding, voucher.delta, tx);
            },
            broadcast
          );
          credited = accepted.result;
        } catch (err) {
          const mapped = mapLedgerCommitError(err, x402Requirements, true);
          if (mapped) {
            logCredentialRejected("tempo", "upfront", err);
            return mapped;
          }
          throw err;
        }
      } else {
        await broadcast();
      }
      if (cred.challenge.intent === "session" && !sessionBasis) {
        const mppChallenges = await issueUpfrontChallenges(
          mpp,
          requiredMsats,
          resourcePath ?? "/v1/job",
          rate,
          sessionIssuable,
          opts.fundOnly?.allowOneShotStablecoin,
          opts.priceFiat
        );
        return {
          paidMsats: 0,
          receivedProofs: [],
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: TEMPO_SESSION_UPDATED_REASON,
            }),
            status: 402,
            mppChallenges,
          },
        };
      }
      // The rail's transaction-hash guard already protects a proven charge.
      // A failed challenge mark must not strand paid work before accounting.
      if (consumedCredentialStore && !sessionBasis) {
        await withPaymentStage("replay_store", () => consumedCredentialStore.mark(
          replayRealm, cred.challenge.id, CONSUMED_CREDENTIAL_TTL_MS / 1000
        )).catch((error: unknown) => {
          const transactionHash = tempoReceiptTransactionHash(tempoReceipt);
          // Zero-dollar proofs have no chain payment to recover and may rely
          // on this store alone for challenge replay protection.
          if (!transactionHash) throw error;
          diagnosticConsole.error({
            level: "error",
            event: "tempo_replay_mark_failed",
            phase: "upfront",
            rail: "tempo",
            transaction_hash: transactionHash,
            ...paymentFailureFields(error),
          });
        });
      }
      // Ledger leg: the credential was settled by the payer's mpp
      // server; the durable dvmkit-side commit is the marker + fund + draw
      // transaction keyed on the challenge id. mpp pays exactly the required
      // amount, so fund = draw = the quoted fiat price.
      if (ledgerCtx) {
        try {
          credited ??= await commitMppFunding(ledgerCtx, cred, {
            rail: "tempo",
            paymentId: mppPaymentId(cred),
            tempoSession: sessionBasis,
            paidMsats: requiredMsats,
            nativeAmount: methodNativeAmountFromDecimal(expectedAmount, cred.challenge.method),
            nativeAsset: methodNativeAsset(cred.challenge.method),
          });
        } catch (err) {
          const mapped = mapLedgerCommitError(err, x402Requirements, true);
          if (mapped) {
            logCredentialRejected("tempo", "upfront", err);
            return mapped;
          }
          throw err;
        }
      }
      if (sessionBasis && consumedCredentialStore) {
        // The funding above is committed, so a failure here must not answer 402:
        // the caller would be told it paid nothing for a balance it now holds.
        // The voucher store's cumulative-amount acceptance and the processed-payment
        // marker already make a replayed session credential book nothing; this
        // mark only adds the (realm, challenge id) refusal on top.
        await withPaymentStage("replay_store", () => consumedCredentialStore.mark(
          replayRealm,
          cred.challenge.id,
          CONSUMED_CREDENTIAL_TTL_MS / 1000
        )).catch((error: unknown) => {
          diagnosticConsole.warn({
            level: "warn",
            event: "tempo_replay_mark_failed",
            phase: "upfront",
            rail: "tempo",
            ...paymentFailureFields(error),
          });
        });
      }
      if (credited) {
        await mpp.completeHostedTempoCharge?.(cred.challenge.id).catch((error: unknown) => {
          console.warn("Hosted Tempo charge completion remains unresolved", error);
        });
      }
      if (credited?.drawRefusal) {
        return creditLedgerErrorResult(credited.drawRefusal, x402Requirements, credited.deposit);
      }
      return withDrawBasis(
        {
          paidMsats: requiredMsats,
          paymentRail: "tempo",
          receivedProofs: [],
          paymentTxHash: cred.challenge.id,
          paymentTransactionHash: tempoReceiptTransactionHash(tempoReceipt),
          nativeAmount: methodNativeAmountFromDecimal(expectedAmount, cred.challenge.method),
          nativeAsset: methodNativeAsset(cred.challenge.method),
        },
        ledgerCtx,
        credited
      );
    } catch (err) {
      // surface the underlying mppx error in structured form. The
      // response body stays generic so we don't leak verifier internals to
      // unauthenticated callers.
      logCredentialRejected("tempo", "upfront", err);
      // Per draft-ryan-httpauth-payment-01, a rejected credential gets a
      // fresh challenge — otherwise the client has nothing to retry against.
      const mppChallenges = await issueUpfrontChallenges(
        mpp,
        requiredMsats,
        resourcePath ?? "/v1/job",
        rate,
        sessionIssuable,
        opts.fundOnly?.allowOneShotStablecoin,
        opts.priceFiat
      );
      return {
        paidMsats: 0,
        receivedProofs: [],
        error: {
          body: paymentErrorBody("payment_invalid", {
            message: "MPP credential verification failed",
          }),
          status: 402,
          mppChallenges,
          ...(x402Requirements && { x402Requirements }),
        },
      };
    }
  }

  // Signed body references a credit, no funding artifact attached: the job is
  // paid from the existing balance. Preflight above already verified auth,
  // ownership, currency, and the replay regime, so what's left is the draw
  // itself — its refusals (insufficient balance, expiry) map to structured
  // 402-class errors the caller can act on.
  if (creditEnv && !fundingArtifact && requiredMsats && ledgerCtx) {
    try {
      const draw = await ledgerCtx.ledger.draw({
        creditId: creditEnv.creditId,
        drawId: creditEnv.drawId,
        amountMicro: ledgerCtx.priceFiat.amountMicro,
        jobId: ledgerCtx.jobId,
        hostingAdmissionId: ledgerCtx.hostingAdmissionId,
        hostingPaymentSeq: ledgerCtx.hostingPaymentSeq,
      });
      if (draw.replayed) {
        // Lost the race with a concurrent identical request — same recovery
        // path as the preflight replay hit.
        const rec = await ledgerCtx.ledger.getDraw({
          creditId: draw.creditId,
          drawId: draw.drawId,
        });
        return {
          paidMsats: 0,
          receivedProofs: [],
          replayedDraw: { creditId: draw.creditId, drawId: draw.drawId, jobId: rec?.jobId ?? null },
        };
      }
      // the job is paid, just not by this request's rail traffic —
      // it consumed a slice of the credit's funding. Carrying that slice's
      // rail identity is what makes the terminal book a revenue event; before
      // this, a draw against an existing balance booked nothing at all.
      const rv = draw.railValue;
      return {
        paidMsats: rv.drawMsats > 0 ? rv.drawMsats : requiredMsats,
        receivedProofs: [],
        paymentRail: railAsFundingMethod(rv.rail),
        paymentMint: rv.mint ?? undefined,
        paymentTxHash: drawSettlementRef(ledgerCtx.dvmId, draw.creditId, draw.drawId),
        nativeAmount: rv.drawNative ?? undefined,
        nativeAsset: rv.nativeAsset as PaymentInfo["nativeAsset"],
        ...(rv.rail === "cashu" && { cashuFlow: "p2pk_accumulator" as const }),
        creditId: draw.creditId,
        drawId: draw.drawId,
        drawAmountMicro: draw.amountMicro,
        creditCurrency: ledgerCtx.priceFiat.currency,
        upfrontPayment: upfrontPaymentFromDraw(draw),
      };
    } catch (err) {
      if (err instanceof CreditLedgerError) return creditLedgerErrorResult(err, x402Requirements);
      throw err;
    }
  }

  if (requiredMsats) {
    // No rail-specific token/credential satisfied the requirement. Cashu is
    // quoted in sats and needs no rate, so a rate outage still yields a payable
    // 402 as long as this DVM takes Cashu. When it doesn't, every rail we could
    // advertise is priced in a non-sat unit we can't state — say so
    // rather than hand back a 402 with no way to satisfy it.
    if (rateOutage && !mints?.length) return rateUnavailableResult();
    // When the DVM has an mppx handle, issue challenges so plain-MPP-HTTP
    // clients can pay via `WWW-Authenticate`. Otherwise fall back to
    // the bare JSON 402 (Cashu/x402-only DVMs unchanged).
    const mppChallenges =
      mpp && rate !== null
        ? await issueUpfrontChallenges(
            mpp,
            requiredMsats,
            resourcePath ?? "/v1/job",
            rate,
            sessionIssuable,
            opts.fundOnly?.allowOneShotStablecoin,
            opts.priceFiat
          )
        : undefined;
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: {
          error: "payment_required",
          required_msats: requiredMsats,
          ...(mints && { mints }),
        },
        status: 402,
        ...(mppChallenges && { mppChallenges }),
        ...(x402Requirements && { x402Requirements }),
        ...(x402BatchRequirements && { x402V2Requirements: x402BatchRequirements }),
      },
    };
  }

  return { paidMsats: 0, receivedProofs: [] };
}

function tempoReceiptTransactionHash(
  receipt: { reference?: unknown; txHash?: unknown } | undefined
): string | undefined {
  const value = typeof receipt?.txHash === "string" ? receipt.txHash : receipt?.reference;
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
}

/**
 * Natural replay key for a TIP-1034 voucher. One channel may issue many
 * challenges for the same cumulative authorization, so challenge ids are not
 * a money idempotency boundary; `(channelId,cumulativeAmount)` is.
 */
function mppPaymentId(credential: MppxCredential): string {
  if (credential.challenge.intent !== "session") return credential.challenge.id;
  const payload = credential.payload as {
    channelId?: unknown;
    cumulativeAmount?: unknown;
  };
  if (typeof payload.channelId !== "string" || typeof payload.cumulativeAmount !== "string") {
    return credential.challenge.id;
  }
  return `${payload.channelId}:${payload.cumulativeAmount}`;
}

/**
 * Refusal text for a reusable Tempo channel presented on the job surface.
 *
 * The twin of the x402 batch-settlement guard in {@link verifyUpfrontPayment}
 * ("Reusable x402 channels are accepted only by POST /v1/credit"), and the
 * acceptance-side half of the issuance partition in {@link
 * issueUpfrontChallenges} and `context.ts`. All three verifiers —
 * upfront, durable mid-job, isolate mid-job — refuse *before*
 * `broadcastCredential`: mppx charges a session channel ahead of the handler
 * and disclaims charge-only-on-success, so a refusal that ran after the
 * credential was broadcast would already have moved the caller's money.
 */
const MPP_SESSION_ONLY_ON_CREDIT = "Tempo session channels are accepted only by POST /v1/credit.";

/**
 * Refusal text for a session credential opening a channel while the platform's
 * close observer is not confirmed healthy.
 *
 * The acceptance-side half of the gate `issueUpfrontChallenges` now applies to
 * advertisement and issuance. Only a channel this DVM has never seen is
 * refused — an existing one may keep topping up, since its deposit is already
 * exposed and refusing its vouchers strands the caller rather than protecting
 * them, and {@link targetCreditHoldsTempoChannel} is what keeps issuing it the
 * challenge to do so.
 */
const TEMPO_SESSION_OBSERVER_UNHEALTHY =
  "New Tempo session channels are not being opened: the close observer is not confirmed healthy. " +
  "tempo/charge per-call payment is unaffected.";

function tempoSessionUnavailableCopy(reason: UpfrontPaymentOpts["tempoSessionUnavailableReason"]): {
  message: string;
  display: string;
} {
  if (reason === "settlement_unhealthy") {
    return {
      message:
        "New Tempo session channels are not being opened: the operator cannot reliably fund settlement fees. tempo/charge is unaffected.",
      display:
        "This service isn't opening new prepaid payment channels right now because its operator cannot reliably pay the channel settlement fees.",
    };
  }
  return {
    message: TEMPO_SESSION_OBSERVER_UNHEALTHY,
    display:
      "This service isn't opening new prepaid payment channels right now because the monitor that protects them isn't confirmed running.",
  };
}

/** True when a credential carries a reusable TIP-1034 session channel. */
function isMppSessionCredential(credential: MppxCredential): boolean {
  return credential.challenge.intent === "session";
}

function mppSessionBasis(
  credential: MppxCredential
): { channelId: string; cumulativeAmount: string } | undefined {
  const channelId = mppSessionChannelId(credential);
  if (!channelId) return undefined;
  const payload = credential.payload as {
    cumulativeAmount?: unknown;
  };
  return typeof payload.cumulativeAmount === "string"
    ? { channelId, cumulativeAmount: payload.cumulativeAmount }
    : undefined;
}

/**
 * Whether the credit this request tops up is already bound to a TIP-1034
 * channel — the one case where a closed close-observer gate must still issue a
 * `tempo/session` challenge.
 *
 * `fundOnly` is set by `POST /v1/credit` and by nothing else, so this reads the
 * credit the caller signed for. A channel-bound credit can be funded no other
 * way — `checkTargetCredit` refuses a one-shot charge against it — so a caller
 * with an open channel and no session challenge has no way to top up at all,
 * which is what made the acceptance carve-out unreachable.
 *
 * Ownership is re-checked here rather than assumed from the route's own gate:
 * this decides whether to issue a channel-scoped credential, and it is cheap.
 * Anything unreadable answers `false`, keeping the gate fail-closed.
 */
async function targetCreditHoldsTempoChannel(opts: UpfrontPaymentOpts): Promise<boolean> {
  const creditId = opts.fundOnly?.creditId;
  if (!creditId || !opts.creditLedger || !opts.callerPubkey) return false;
  const credit = await opts.creditLedger.get(creditId).catch(() => undefined);
  return Boolean(credit?.tempoChannelId) && credit?.callerPubkey === opts.callerPubkey;
}

/** Read the channel identity from any Tempo session action, including open/top-up management. */
function mppSessionChannelId(credential: MppxCredential): string | undefined {
  if (credential.challenge.intent !== "session") return undefined;
  const payload = credential.payload as { channelId?: unknown };
  return typeof payload.channelId === "string" ? payload.channelId : undefined;
}

/**
 * A management credential signed for a channel other than the one required
 *
 * Typed rather than a bare `Error` because the drain route has to tell it apart
 * from the transport and chain failures its catch ladder reconciles: this one is
 * terminal and names what the caller signed wrong, where those stay pending for
 * the next poll. A message match would break the moment this wording changes.
 */
export class TempoSessionChannelMismatchError extends Error {
  /** The channel the credit is bound to — the only one this close may name. */
  readonly expectedChannelId: string;
  /** The channel the presented credential was actually signed for. */
  readonly presentedChannelId: string;

  constructor(expectedChannelId: string, presentedChannelId: string) {
    super(
      `Tempo session credential belongs to a different channel: expected ${expectedChannelId}, got ${presentedChannelId}`
    );
    this.name = "TempoSessionChannelMismatchError";
    this.expectedChannelId = expectedChannelId;
    this.presentedChannelId = presentedChannelId;
  }
}

/** Verify a TIP-1034 management credential without funding the credit ledger. */
export async function verifyTempoSessionManagementCredential(args: {
  credential: string;
  mpp: MppxServer;
  resourcePath: string;
  action: "close" | "topUp" | "open";
  expectedChannelId?: string;
  /** Hosted close only: authenticate the credential without a rail write before reserving its effect. */
  preflightBeforeBound?: boolean;
  /**
   * Runs once the credential is decoded and bound to `expectedChannelId`, and
   * before anything broadcasts.
   *
   * The drain route re-asserts its close intent here rather than a line above
   * the call so that a credential signed for another channel is refused before
   * the reservation is touched. Only this function knows where that
   * seam is, so putting the hook here makes the ordering structural instead of a
   * comment the next edit can reorder past. A throw propagates to the caller
   * with nothing broadcast.
   */
  onBound?: () => Promise<void>;
}): Promise<{ reference: string; channelId: string; cumulativeAmount?: string }> {
  const { Credential } = await import("mppx");
  const credential = Credential.deserialize(args.credential);
  if (credential.challenge.method !== "tempo" || credential.challenge.intent !== "session") {
    throw new Error("Expected a tempo/session credential");
  }
  const payload = credential.payload as {
    action?: unknown;
    channelId?: unknown;
    cumulativeAmount?: unknown;
  };
  if (payload.action !== args.action || typeof payload.channelId !== "string") {
    throw new Error(`Expected a Tempo session ${args.action} credential`);
  }
  if (
    args.expectedChannelId &&
    payload.channelId.toLowerCase() !== args.expectedChannelId.toLowerCase()
  ) {
    throw new TempoSessionChannelMismatchError(args.expectedChannelId, payload.channelId);
  }
  const challengeAmount = credential.challenge.request.amount;
  if (typeof challengeAmount !== "string" && typeof challengeAmount !== "bigint") {
    throw new Error("Tempo session challenge has an invalid amount");
  }
  const verifyOptions = {
    request: {
      amount: methodNativeAmountToDecimal(challengeAmount, credential.challenge.method),
    },
    meta: {
      path: args.resourcePath,
      nonce: challengeMeta(credential.challenge)?.nonce ?? "",
    },
  };
  if (args.preflightBeforeBound) {
    if (!args.mpp.validateCredential) {
      throw new Error("Hosted Tempo close requires non-mutating credential validation");
    }
    await args.mpp.validateCredential(credential, verifyOptions);
    if (args.action === "close") {
      // mppx checks the voucher against the stored channel only inside the
      // broadcast, after the hosted obligation is reserved. A voucher it would
      // refuse there must be refused here, or the reservation outlives a close
      // that never submitted.
      if (!args.mpp.assertTempoSessionCloseVoucher) {
        throw new Error("Hosted Tempo close requires stored-channel voucher validation");
      }
      const { cumulativeAmount, signature } = credential.payload as {
        cumulativeAmount?: unknown;
        signature?: unknown;
      };
      if (typeof cumulativeAmount !== "string" || typeof signature !== "string") {
        throw new Error("Expected a Tempo session close voucher");
      }
      await args.mpp.assertTempoSessionCloseVoucher({
        channelId: payload.channelId,
        cumulativeAmount: BigInt(cumulativeAmount),
        signature,
        descriptor: (credential.payload as { descriptor?: unknown }).descriptor,
        request: credential.challenge.request as Record<string, unknown>,
      });
    }
  }
  await args.onBound?.();
  const receipt = await args.mpp.broadcastCredential(credential, verifyOptions);
  const sessionReceipt = receipt as unknown as { txHash?: unknown };
  return {
    reference:
      typeof sessionReceipt.txHash === "string" ? sessionReceipt.txHash : receipt.reference,
    channelId: payload.channelId,
    ...(typeof payload.cumulativeAmount === "string" && {
      cumulativeAmount: payload.cumulativeAmount,
    }),
  };
}

/**
 * Every machine code a flat payment-error body can carry — the six
 * codes constructed directly in this file plus the agent-wallet cashu rejection
 * codes ({@link AccumulatorRejectionCode}), which surface verbatim through the
 * accumulator branch of {@link verifyAccumulatorReceipt}. `fx_rate_unavailable`
 * (btc-rate.ts) and the `payment_required` x402 challenge are intentionally not
 * here: the former is already complete, the latter is a challenge envelope, not
 * an error report.
 */
export type PaymentErrorCode =
  | "payment_invalid"
  | "x402_not_offered"
  | "x402_settlement_ambiguous"
  | "cashu_unavailable"
  | "cashu_not_p2pk_locked"
  | "mint_health_pending"
  | "cashu_mint_sick"
  | "payment_insufficient"
  | "payment_unapplied"
  | "insufficient_credit"
  | "credit_expired"
  | "credit_unbacked"
  | "credit_not_found"
  | "tempo_channel_closing"
  | "settlement_pending"
  | "draw_conflict"
  | "funding_commitment_mismatch"
  | "credit_not_supported"
  | "one_shot_credit_not_supported"
  | "credit_below_min"
  | "below_rail_minimum"
  | "credit_over_max"
  | "credit_id_unavailable"
  | "nothing_to_drain"
  | "drain_below_dust"
  | "drain_not_found"
  | "drain_conflict"
  | "drain_method_unsupported"
  | "tempo_channel_exit_required"
  | "x402_settlement_submission_failed"
  | X402SettlementReconciliationReason
  | "lightning_settlement_pending"
  | "lightning_invoice_expired"
  | "lightning_unavailable"
  | AccumulatorRejectionCode;

/**
 * Agent-facing copy for one payment-error code. `display` is relayed to a human
 * verbatim (no rail names the caller didn't choose, no jargon); `hint` is the
 * default actionable next step; `retryable` says whether re-sending the same
 * request could ever succeed. `message` is not here — it stays per-site as the
 * operator log line.
 */
interface PaymentErrorCopy {
  display: string;
  hint: string;
  retryable: boolean;
}

/**
 * Per-code copy for the payment-error builder. Being a `Record` over
 * {@link PaymentErrorCode}, a new code can't be added to that union without an
 * entry here — a bare `{ error, message }` fails typecheck rather than shipping.
 */
const PAYMENT_ERROR_COPY: Record<PaymentErrorCode, PaymentErrorCopy> = {
  payment_invalid: {
    display:
      "The payment couldn't be verified, so the request wasn't accepted. Nothing was charged.",
    hint: "Request a fresh quote and pay again — the previous payment can't be reused.",
    retryable: false,
  },
  x402_not_offered: {
    display:
      "This service does not offer x402 payment for prices in its configured currency. Nothing was charged.",
    hint: "Use one of the payment methods advertised by this service and submit the request again.",
    retryable: false,
  },
  x402_settlement_ambiguous: {
    display:
      "The stablecoin payment may have settled, but the service has not finished recording what it bought. Do not pay again.",
    hint: "Retry the identical request with the same signed payment. If it remains pending, give settlement_intent_id to the service operator; do not request a fresh quote or sign another authorization.",
    retryable: true,
  },
  cashu_unavailable: {
    display: "This service can't accept the payment right now. Nothing was charged.",
    hint: "The service is misconfigured for this payment method; retrying won't help. Contact the service operator.",
    retryable: false,
  },
  cashu_not_p2pk_locked: {
    display:
      "The payment token wasn't in the locked form this service requires. Nothing was charged.",
    hint: "Initialize an agent wallet so tokens are P2PK-locked, then pay again. Run: dvm wallet init",
    retryable: false,
  },
  mint_health_pending: {
    display:
      "The service is still starting up and briefly can't verify payments. Try again in a moment.",
    hint: "The service just started and is validating its mints; retry in a few seconds.",
    retryable: true,
  },
  cashu_mint_sick: {
    display:
      "The payment couldn't be processed because the token's mint is currently unavailable. Retry with a token from a healthy mint.",
    hint: "Retry with a token minted at one of the healthy mints listed in this response.",
    retryable: true,
  },
  // Only the Cashu accumulator emits this code, and it evaluates each call's
  // own proofs — nothing sums a partial with a later one, on any path. So the
  // retry owes the full amount: implicit upfront the shortfall was forfeited
  // mid-job it sits on a credit the per-site hint names
  // Explicit upfront short deposits use `insufficient_credit`
  // instead. Telling a caller to "send the difference" produced a
  // second short pay either way.
  payment_insufficient: {
    display:
      "The payment was less than the amount required, so it didn't cover the request. The full amount is still owed.",
    hint: "Retry with a single payment of required_msats — a partial payment does not reduce what is owed.",
    retryable: true,
  },
  // the rail and the ledger leg commit together, but the job row is
  // written by a *second* transaction (`verifyAndCredit`). When that one can't
  // be made to land, the money is real and the caller's — it just isn't on the
  // job. Say so rather than answering a bare 500: the per-site body names the
  // credit it landed on, so the caller can retry the ask or reclaim the money
  // without deriving an id.
  //
  // Two things this copy must not get wrong. "Retry" means a NEW payment — the
  // spent one collides on the rail's replay key (the accumulator's request id,
  // the `processed_payments` marker). And a drain is only ever a *later* option,
  // never one this default may promise: whether there is a balance to reclaim at
  // all depends on the site. So the registry entry states only what holds
  // everywhere — the route (`unappliedCopy` in `job-manager.ts`) always
  // overrides both fields, with the credit named where there is one and with a
  // "read the job first" when the outcome is unknown. An agent relays this
  // verbatim, so a promise that resolves to a refusal is a refusal handed
  // straight to its human.
  payment_unapplied: {
    display:
      "The payment was received, but a fault at the service stopped it being applied to this job. The job's payment request is still outstanding.",
    hint: "The payment does not reduce what this job owes. Send a new payment to satisfy the request — re-sending this one will be rejected as already used.",
    retryable: true,
  },
  insufficient_credit: {
    display:
      "The prepaid balance with this service is too low to cover this job. Nothing was charged.",
    hint: 'Top up at POST /v1/credit with op "fund" — shortfall_micro is the minimum that clears this job — or attach a payment for the full price with the request.',
    retryable: true,
  },
  credit_expired: {
    display:
      "The prepaid balance with this service has expired for new spending. The remaining balance is preserved and can be reclaimed.",
    hint: 'Fund the same credit_id again at POST /v1/credit (op "fund") to revive it, reclaim the balance with op "drain", or attach a payment for the full price.',
    retryable: true,
  },
  credit_unbacked: {
    display:
      "This prepaid balance is closed because its Tempo channel finalized before the service could collect the value it had accepted. No drawable or reclaimable balance remains.",
    hint: "Do not retry, top up, or drain this credit. Pay per call or open a separate prepaid balance.",
    retryable: false,
  },
  credit_not_found: {
    display:
      "No prepaid balance exists at this service under the referenced credit. Nothing was charged.",
    hint: 'Check the credit_id, or open one at POST /v1/credit (op "fund") before drawing on it.',
    retryable: true,
  },
  tempo_channel_closing: {
    display:
      "This prepaid balance's channel has started closing, so it cannot accept a new job. Nothing was charged.",
    hint: "Use a different prepaid balance or pay per call. To reclaim this balance after running jobs finish, inspect it with 'dvm wallet tempo-exit <dvm>'.",
    retryable: false,
  },
  // a refund on this credit's payment channel reached the chain and
  // never finished booking, so the escrow behind the balance may already have
  // been paid back. Spending it would buy work the service can never collect
  // for. The copy must not promise the money is gone *or* that it is safe to
  // spend — only that it is the caller's and reclaimable — and it must not
  // read as a retry: nothing the caller re-sends changes the answer, only the
  // operator finishing or closing out the refund does. Nor may it send the
  // agent to `op: "drain"` unconditionally — while the refund is unresolved a
  // *fresh* drain_id is refused with this same code, and only the drain_id
  // already in flight is admitted (that carve-out is what lets the caller's
  // own retry finish the wedge). A drain on a new id works once the refund is
  // closed out, which `settlement_status` in `extra` tells the agent about.
  settlement_pending: {
    display:
      "This prepaid balance is on hold: a refund of its payment channel is still being finalized, so it can't be spent right now. Nothing was charged, and the balance is still yours.",
    hint: 'Pay per call, or use another prepaid balance, while this one settles. Reclaiming this balance with op "drain" at POST /v1/credit is refused the same way while the refund is open — only re-sending the drain_id that was already in flight goes through, and a new one works once the operator closes the refund out. Retrying this request will not clear the hold.',
    retryable: false,
  },
  credit_not_supported: {
    display: "This service doesn't offer a prepaid balance. Nothing was charged.",
    hint: "Pay per call instead: attach a payment with each request. Retrying the credit endpoint won't help.",
    retryable: false,
  },
  one_shot_credit_not_supported: {
    display:
      "This service accepts stablecoin prepaid credit only through reusable payment channels. No money moved and no credit was added.",
    hint: "Use reusable funding for prepaid credit, or use the one-payment stablecoin method to pay for a single call instead.",
    retryable: false,
  },
  credit_below_min: {
    display:
      "The top-up was smaller than this service's minimum. Nothing was charged and no balance changed.",
    hint: "Fund at least min_micro (in the credit block of any quote) and try again.",
    retryable: true,
  },
  // a per-rail floor, not the menu-wide minimum — today only the
  // lightning rail carries one (the receive channel's routing floor). Refused
  // before any invoice is minted, so nothing is ever paid against this code;
  // `retryable: false` because re-sending the identical request can never
  // succeed — the fix is a different amount or a different rail, both named.
  below_rail_minimum: {
    display:
      "This amount is below the minimum this service can receive over Lightning, so no invoice was issued. Nothing was charged.",
    hint: "Fund at least min_micro over Lightning, or use one of the rails in alternatives — ecash has no rail minimum here.",
    retryable: false,
  },
  credit_over_max: {
    display:
      "The top-up would push the prepaid balance over this service's ceiling. Nothing was charged and no balance changed.",
    hint: "Fund at most fundable_micro, or spend some of the existing balance first.",
    retryable: true,
  },
  credit_id_unavailable: {
    display:
      "The service can't use that prepaid-balance id. Nothing was charged and no balance changed.",
    hint: "Omit credit_id and let the service pick one, or retry with a fresh fund_id. Ids starting imp: or fnd: are derived by the service — reference one it already gave you, never open a new one.",
    retryable: true,
  },
  draw_conflict: {
    display: "This draw id was already used for a different request, so nothing was charged again.",
    hint: "Reuse a draw_id only to retry the identical request; generate a fresh draw_id for a new job.",
    retryable: false,
  },
  nothing_to_drain: {
    display:
      "There is no spendable balance to reclaim from this service right now. Nothing changed.",
    hint: "The balance is zero or fully held by in-flight jobs. Wait for running jobs to finish, then request the drain again with a fresh drain_id.",
    retryable: true,
  },
  // Distinct from `nothing_to_drain` because the balance is real and
  // waiting changes nothing: a reusable Bitcoin balance is a deposit the
  // service owes back in the asset it received, and what is left here converts
  // to less than one satoshi at the rate its own funding landed at. There is
  // no smaller unit to send, so the only thing that makes it reclaimable is a
  // top-up that carries it back over a satoshi — which the hint names instead
  // of promising a retry.
  drain_below_dust: {
    display:
      "What's left on this prepaid balance is worth less than the smallest unit of Bitcoin the service can send, so there is nothing it can pay out. The balance is untouched and still yours.",
    hint: "Re-sending this drain never succeeds. Top the balance up and the whole amount becomes reclaimable again, or spend it down on this service — it stays spendable either way.",
    retryable: false,
  },
  drain_not_found: {
    display: "No refund with that id exists for this balance. Nothing changed.",
    hint: "Check drain_id and credit_id, or start a reclaim by including method and payout in the drain block.",
    retryable: true,
  },
  drain_method_unsupported: {
    display:
      "This service can't pay a refund out that way. Nothing was reclaimed and the balance is unchanged.",
    hint: "Reclaim the balance as ecash instead — 'dvm credit drain <dvm> --method cashu' parks it locked to your wallet's key. A credit funded through a stablecoin channel uses that channel's own rail (--method x402 or --method tempo). Re-sending the same method never succeeds.",
    retryable: false,
  },
  drain_conflict: {
    display:
      "A refund with this id already exists with a different destination, so nothing was changed.",
    hint: "Poll with the original method and payout to collect the existing refund, or use a fresh drain_id — the payout of a recorded drain can't be rewritten.",
    retryable: false,
  },
  tempo_channel_exit_required: {
    display:
      "This prepaid balance's channel can no longer be closed cooperatively. The service did not send a second refund.",
    hint: "Run 'dvm wallet tempo-exit <dvm>' to inspect the channel, request its on-chain exit if needed, and withdraw after the 15-minute grace period.",
    retryable: false,
  },
  // The voucher verified and the ledger leg rolled back with the
  // failed submission, so nothing was charged and nothing about the payment is
  // wrong — which is exactly what the `payment_invalid` this replaced got
  // backwards, telling an agent to discard a credential that is still good. The
  // copy must not send them to a fresh quote (the channel voucher is reusable
  // and re-signing changes nothing) and must not read as their fault: the one
  // action that helps is the same request again, shortly.
  x402_settlement_submission_failed: {
    display:
      "The service couldn't put this payment through to the chain just now, so the request didn't run. Nothing was charged, and the payment is still good.",
    hint: "Retry the same request shortly — it's a service-side chain problem, not a problem with the payment. Don't request a fresh quote or re-sign; if it persists, contact the service operator.",
    retryable: true,
  },
  settlement_not_on_chain: {
    display:
      "The service checked the chain and found that this refund did not move. Your balance is still in the x402 channel.",
    hint: "Retry this drain with the same drain_id. The service returned the refund attempt to its safe submission state, so the next request can try again.",
    retryable: true,
  },
  chain_unreachable: {
    display:
      "The service can't reach its chain endpoint, so it cannot tell whether this refund moved. This is a service-side problem, not a failure of your payment.",
    hint: "Do not re-sign repeatedly. Retry after the service operator restores chain access; if this persists, contact the operator and keep the same drain_id.",
    retryable: true,
  },
  settlement_unbookmarked: {
    display:
      "The service has no chain checkpoint for this refund attempt, so it cannot safely tell whether the refund moved. This is a service-side recovery problem.",
    hint: "Keep the same drain_id and contact the service operator. Re-signing cannot create the missing checkpoint.",
    retryable: false,
  },
  facilitator_channel_state_unavailable: {
    display:
      "The service found this refund on chain but could not confirm the matching channel state with its settlement service. Your payment did not fail.",
    hint: "Keep the same drain_id and retry after the service operator restores its settlement service. If this persists, contact the operator.",
    retryable: true,
  },
  funding_commitment_mismatch: {
    display:
      "The attached payment doesn't match the signed funding commitment, so the request was refused. Nothing was charged.",
    hint: "Recompute fund.commitment as the SHA-256 hex of the exact payment artifact attached, and set fund.amount_micro to its value at the quoted price. When the amount is what mismatched, expected_micro on this body states the provider's own valuation.",
    retryable: false,
  },
  missing_request_id: {
    display:
      "The payment was missing a required identifier and couldn't be processed. Nothing was charged.",
    hint: "Include the X-Cashu-Request-Id header and pay again.",
    retryable: false,
  },
  missing_lock_pubkey: {
    display: "This service can't accept the payment right now. Nothing was charged.",
    hint: "The service is missing payment configuration; retrying won't help. Contact the service operator.",
    retryable: false,
  },
  invalid_token: {
    display: "The payment token couldn't be read. Nothing was charged.",
    hint: "The token was malformed or from an unsupported mint. Send a valid token.",
    retryable: false,
  },
  not_p2pk_locked: {
    display:
      "The payment token wasn't locked in the form this service requires. Nothing was charged.",
    hint: "Submit a P2PK-locked token — the one sent was unlocked or its lock had expired.",
    retryable: false,
  },
  wrong_lock_pubkey: {
    display: "The payment token was locked to the wrong key. Nothing was charged.",
    hint: "Re-fetch this service's current lock key from /v1/info and lock a fresh token to it.",
    retryable: false,
  },
  lock_not_exclusive: {
    display:
      "The payment token's lock would let a key other than this service's spend it, so it wasn't accepted. Nothing was charged.",
    hint: "Lock a fresh token with data set to cashu.lock_pubkeys[0] from /v1/info as a 33-byte compressed hex key. Use only the locktime, refund, pubkeys, n_sigs, sigflag and n_sigs_refund tags, each once and with a value: pubkeys may list only other cashu.lock_pubkeys entries, n_sigs must be 1, sigflag SIG_INPUTS, refund keys compressed and distinct, n_sigs_refund at most the number of refund keys, and any locktime at least cashu.min_locktime minus 24 hours in the future.",
    retryable: false,
  },
  proof_not_unspent: {
    display: "The payment token has already been spent. Nothing was charged.",
    hint: "Those funds are gone; pay with a fresh token.",
    retryable: false,
  },
  mint_unreachable: {
    display:
      "The payment couldn't be confirmed because the mint didn't respond. Try again shortly.",
    hint: "The mint was unreachable or returned an invalid response; retry in a few seconds.",
    retryable: true,
  },
  proof_pending: {
    display: "The payment is still settling at the mint. Try again shortly.",
    hint: "The token's proofs are pending at the mint; retry in a few seconds.",
    retryable: true,
  },
  // Not failures — the two `lightning_*` states below are the normal
  // shape of an interactive funding leg, which is why both are retryable and
  // neither `display` implies anything went wrong.
  lightning_settlement_pending: {
    display:
      "There's a Lightning invoice waiting to be paid for this top-up. Nothing has been charged yet, and paying it adds the balance to your account with this service.",
    hint: "Pay the bolt11 in `lightning.invoice`, then re-send this exact request — the same fund_id — to have the balance credited. Don't start a new top-up; a second fund_id issues a second invoice.",
    retryable: true,
  },
  lightning_invoice_expired: {
    display:
      "The Lightning invoice for this top-up expired before it was paid. Nothing was charged.",
    hint: "Start a fresh top-up with a new fund_id to be issued a new invoice. This one can no longer be paid.",
    retryable: false,
  },
  lightning_unavailable: {
    display:
      "This service can't take a Lightning payment at the moment. Nothing was charged, and its other payment options still work.",
    hint: "Fund over one of the rails in the `funding` list on the credit menu, or retry Lightning shortly.",
    retryable: true,
  },
  replay_rejected: {
    display: "This payment was already submitted, so it wasn't charged again.",
    // this hint reaches a caller whose money already landed — the
    // accumulator holds these proofs under this request id. It used to read
    // "use a fresh token and a new request id for the next payment", which an
    // agent could follow straight into paying twice for the same charge.
    hint: "Don't re-send this payment — the proofs already landed under this request id. Only a genuinely new charge needs a fresh token and request id.",
    retryable: false,
  },
};

/**
 * Per-code display, hint and retryability may be overridden for a particular
 * refusal. Keep the hint and retry decision consistent. Extra fields merge
 * last, so callers can supply code-specific amounts and alternatives.
 */
export function paymentErrorBody(
  code: PaymentErrorCode,
  opts: {
    message: string;
    display?: string;
    hint?: string;
    retryable?: boolean;
    extra?: Record<string, unknown>;
  }
): Record<string, unknown> {
  const copy = PAYMENT_ERROR_COPY[code];
  return {
    error: code,
    message: opts.message,
    display: opts.display ?? copy.display,
    hint: opts.hint ?? copy.hint,
    retryable: opts.retryable ?? copy.retryable,
    ...(opts.extra ?? {}),
  };
}

/**
 * Build a payment-error response carrying a JSON error body plus one
 * `WWW-Authenticate: Payment <serialized challenge>` header per mppx challenge
 * (per draft-ryan-httpauth-payment-01). When `challenges` is empty,
 * returns a plain JSON response (Cashu/x402-only DVMs).
 *
 * Status defaults to 402 (Payment Required) but callers can override — e.g.
 * the sick-mint short-circuit returns 503 because the failure is a
 * mint-side outage, not a payment problem.
 *
 * When `x402Requirements` is present (x402 dual-serve), merge the
 * x402-spec envelope `{ x402Version, accepts: [...] }` into the body next to
 * the existing dvmkit error fields so x402 clients can find their retry
 * shape on the same response. The MPP `WWW-Authenticate` header and the
 * x402 body envelope coexist — clients pick whichever they speak.
 *
 * `Cache-Control: no-store` matches mppx's own HTTP transport — challenges
 * are single-use and shared caches must not return them to other clients.
 */
export function buildPaymentErrorResponse(
  body: Record<string, unknown>,
  challenges?: Challenge.Challenge[],
  x402Requirements?: PaymentRequirements[],
  status?: number,
  x402V2Requirements?: PaymentRequirementsV2[],
  x402V2Resource = "/v1/credit",
  x402ExactVersions: X402ExactVersionSupport = { v1: true, v2: true },
  x402ErrorCode?: string
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  let mergedBody = body;
  const hasV1Exact = x402ExactVersions.v1 && (x402Requirements?.length ?? 0) > 0;
  const hasV2Exact = x402ExactVersions.v2 && (x402Requirements?.length ?? 0) > 0;
  const hasV2 = hasV2Exact || (x402V2Requirements?.length ?? 0) > 0;
  const hasX402 = hasV1Exact || hasV2;
  const hasMpp = challenges && challenges.length > 0;
  if (hasV1Exact && x402Requirements) {
    mergedBody = { ...body, x402Version: X402_V1_VERSION, accepts: x402Requirements };
  }
  if (hasV2) {
    const accepts = [
      ...(x402V2Requirements ?? []),
      ...(hasV2Exact && x402Requirements ? paymentRequiredV2FromV1(x402Requirements).accepts : []),
    ];
    // The envelope's `error` is what a scheme's client matches on to decide
    // whether a 402 is correctable (upstream's `processCorrectivePaymentRequired`
    // string-compares it against its own error constants), so a scheme code is
    // emitted verbatim and the human prose stays on the body's `message`.
    // Wrapping the code in a sentence silently disables every corrective
    // handshake the batch-settlement rail depends on.
    const envelopeError =
      x402ErrorCode ?? (typeof body.message === "string" ? body.message : undefined);
    const envelope: PaymentRequiredV2 =
      hasV2Exact && x402Requirements
        ? paymentRequiredV2FromV1(x402Requirements, envelopeError)
        : {
            x402Version: X402_VERSION,
            ...(envelopeError !== undefined ? { error: envelopeError } : {}),
            resource: { url: x402V2Resource },
            accepts: [],
            extensions: {},
          };
    headers.set(
      "PAYMENT-REQUIRED",
      encodePaymentRequiredHeader({
        ...envelope,
        accepts,
      })
    );
  }
  if (hasMpp) {
    for (const ch of challenges) {
      headers.append("WWW-Authenticate", Challenge.serialize(ch));
    }
  }
  if (hasX402 || hasMpp) {
    headers.set("Cache-Control", "no-store");
  }
  return new Response(JSON.stringify(mergedBody), { status: status ?? 402, headers });
}

export interface IncomingPaymentOpts {
  /** Durable pending-verification message sequence written before this rail is touched. */
  hostingPaymentSeq?: number;
  mints?: string[];
  x402Config?: X402Config;
  /** Declared DVM pricing currency. x402 is accepted only when this is USD. */
  pricingCurrency?: string;
  /** Durable exact-settlement coordinator shared with the upfront path. */
  x402ExactSettlement?: X402ExactSettlementServer;
  /** Exact generations the facilitator currently advertises. Defaults to both. */
  x402ExactVersions?: X402ExactVersionSupport;
  mpp?: MppxServer;
  /** Resource URL bound into the rebuilt x402 `PaymentRequirements`. */
  resourcePath?: string;
  /** Cashu receive mode. Mirrors {@link UpfrontPaymentOpts.cashuMode}. */
  cashuMode?: CashuMode;
  /** Per-DVM Postgres pool — required for the `p2pk-accumulator` path. */
  accumulatorDb?: AccumulatorPool;
  disposableCashu?: DisposableCashuCommit;
  /** DVM identifier — required for the `p2pk-accumulator` path. */
  dvmId?: string;
  /** Active NUT-11 P2PK lock pubkeys (current + retired-in-grace). */
  lockPubkeys?: LockPubkey[];
  /** Runtime mint-health tracker. */
  mintHealthTracker?: MintHealthTracker;
  /**
   * Host fx fetcher for the non-sat rails. See
   * {@link UpfrontPaymentOpts.fxFetcher}.
   */
  fxFetcher?: FxFetcher;
  /**
   * Credit ledger the mid-job top-up funds and grows (the credit lifecycle contract:
   * "mid-job `requestPayment` becomes a top-up"). Absent ⇒ the payment is
   * accepted with pre-credits semantics, exactly as before.
   */
  creditLedger?: CreditLedgerLike;
  /**
   * Durable processed-payment markers. x402/mpp money moves outside
   * dvmkit, so the marker + `fund` + `growDraw` in one transaction is what
   * makes the mid-job ledger leg atomic and crash-replay safe — the cashu path
   * gets the same property from the accumulator's own commit transaction.
   */
  processedPayments?: ProcessedPaymentStore;
  /**
   * Reporter-owned transactional outbox enqueue. Runs inside the
   * mid-job rail transaction after the ledger top-up/growth and before commit.
   */
  enqueueCreditDeposit?: CreditDepositEnqueue;
  /** Job the top-up pays for — recorded on a freshly-minted implicit credit's draw. */
  jobId?: string;
  /** Credit lifetime to mint when a top-up opens a fresh implicit credit. */
  creditTtlMs?: number;
}

/**
 * Job state read by incoming-payment verification; the job itself is not mutated. Rail
 * acceptance and ledger funding can still occur before the caller applies the returned credit in
 * Tx C.
 */
export interface VerifyIncomingSnapshot {
  pendingPaymentMsats?: number;
  pendingMppChallengeIds?: string[];
  /**
   * Per-job x402 binding. When set, the incoming `x402_payment`'s
   * decoded `authorization.nonce` must match this value or the credential is
   * rejected — closes the pre-settlement cross-job replay window. Pre-fix
   * DVMs leave this `undefined`; the verify-side check no-ops for them.
   */
  pendingX402Nonce?: string;
  /** Exact advertised USDC microunits paired with `pendingX402Nonce`. */
  pendingX402AmountUsdcMicro?: string;
  paymentRail?: FundingMethod;
  /** The credit the upfront leg funded and drew, when it had one. */
  creditId?: string;
  /** The draw this job holds on {@link creditId}; the top-up grows it. */
  drawId?: string;
  /**
   * The job's current settlement reference. Used to tell an explicit
   * fund-and-draw job (whose reference is a per-draw `drawSettlementRef`) from
   * an implicit N=1 one, so a top-up preserves whichever revenue basis the
   * upfront leg established.
   */
  paymentTxHash?: string;
  /** Fiat envelope pinned when the ask was emitted. See `JobRecord`. */
  pendingPaymentFiatMicro?: number;
  pendingPaymentFiatCurrency?: string;
  /**
   * Everything this job has asked for mid-job, summed and never decremented
   * the ceiling on its draw growth. See `JobRecord`, including
   * why it can't be derived from the outstanding figure above.
   */
  askedTopUpMicro?: number;
  askedTopUpCurrency?: string;
  /** Why the total above can't express a ceiling, when it can't. */
  topUpCapUnenforcedReason?: TopUpCapUnenforcedReason;
  /**
   * Caller identity for a top-up that has to mint a *fresh* implicit credit
   * (free-then-paid job). An existing credit's owner is read off the ledger
   * instead — `fund` guards on `caller_pubkey`, and the mid-job message is
   * owner-gated rather than signed, so re-deriving would refuse the money.
   */
  requesterPubkey?: string;
  requesterId?: string;
}

export interface VerifiedIncomingPayment {
  paidMsats: number;
  paymentMint?: string;
  paymentRail: PaymentMethod;
  paymentTxHash?: string;
  nativeAmount?: number;
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";
  cashuFlow?: "p2pk_accumulator";
  /** True when this credit should accumulate onto an existing same-rail native amount. */
  sameRail: boolean;
  /**
   * Credit this top-up opened. Only set when the job had none — a
   * free-then-paid job — so Tx C can bind it; a job that already holds a credit
   * keeps its binding, because the top-up grew that draw.
   */
  creditId?: string;
  /** The draw opened alongside {@link creditId}. */
  drawId?: string;
  /** The funding leg, reported to the platform as a deposit. */
  funding?: CreditFundingReport;
  /**
   * Fiat micro this payment funded that the job's draw did not take
   * See `PaymentInfo.unappliedMicro`. When it equals the whole
   * funding, the payment moved no job counters at all and Tx C is handed a
   * `null` delta.
   */
  unappliedMicro?: number;
  /**
   * The ledger funding row a mid-job top-up fixed for this payment, when the
   * job already held a draw. The route issues the signed draw funding receipt
   * from it; absent when the payment ran ledger-less or opened a fresh credit.
   */
  drawFunding?: FundingRecord;
}

/**
 * Verify an incoming payment without mutating the job. Returns the credit
 * shape on success or an error envelope on failure.
 *
 * The rails dispatched on below are the list {@link PAYMENT_PROOF_KEYS}
 * carries — add one here and it must be added there in the same commit.
 */
export async function verifyIncomingPayment(
  body: { type: MessageType; content: Record<string, unknown> },
  opts: IncomingPaymentOpts,
  snapshot: VerifyIncomingSnapshot
): Promise<{
  verified?: VerifiedIncomingPayment;
  error?: {
    body: Record<string, unknown>;
    status: number;
    /**
     * A short mid-job pay that funded a credit before this request failed
     * still a deposit, still reported. See `PaymentErrorDetail`.
     */
    funding?: CreditFundingReport;
    /** The rail payment id a `replay_rejected` collided on, so the route can return its original evidence. */
    replayPaymentId?: string;
  };
}> {
  return withPaymentDiagnostics(() => verifyIncomingPaymentInScope(body, opts, snapshot));
}

async function verifyIncomingPaymentInScope(
  body: { type: MessageType; content: Record<string, unknown> },
  opts: IncomingPaymentOpts,
  snapshot: VerifyIncomingSnapshot
): Promise<{
  verified?: VerifiedIncomingPayment;
  error?: {
    body: Record<string, unknown>;
    status: number;
    /**
     * A short mid-job pay that funded a credit before this request failed
     * still a deposit, still reported. See `PaymentErrorDetail`.
     */
    funding?: CreditFundingReport;
    /** The rail payment id a `replay_rejected` collided on, so the route can return its original evidence. */
    replayPaymentId?: string;
  };
}> {
  if (body.type !== "payment") return {};

  if (body.content.cashu_token) {
    if (
      opts.cashuMode === "p2pk-accumulator" &&
      (opts.accumulatorDb || opts.disposableCashu) &&
      opts.dvmId &&
      opts.lockPubkeys &&
      opts.lockPubkeys.length > 0
    ) {
      const mints = opts.mints ?? [];
      if (mints.length === 0) {
        return {
          error: {
            body: paymentErrorBody("cashu_unavailable", {
              message: "No mints configured for cashu receive.",
            }),
            status: 402,
          },
        };
      }
      const requestId =
        typeof body.content.cashu_request_id === "string"
          ? body.content.cashu_request_id
          : undefined;
      // the ledger leg rides the accumulator's own commit
      // transaction, so the proofs and the top-up land together or not at all.
      const ledgerCtx = await resolveTopUpLedgerContext(opts, snapshot, { rail: "cashu" });
      const result = await verifyAccumulatorReceipt(
        {
          cashuToken: body.content.cashu_token as string,
          accumulatorDb: opts.accumulatorDb,
          disposableCashu: opts.disposableCashu,
          dvmId: opts.dvmId,
          lockPubkeys: opts.lockPubkeys,
          requestId,
          mintHealthTracker: opts.mintHealthTracker,
        },
        mints,
        snapshot.pendingPaymentMsats,
        ledgerCtx
      );
      if (result.error) {
        return {
          error: {
            body: result.error.body,
            status: result.error.status,
            ...(result.error.funding && { funding: result.error.funding }),
          },
        };
      }
      return {
        verified: {
          paidMsats: result.paidMsats,
          paymentMint: result.paymentMint,
          paymentRail: "cashu",
          paymentTxHash: result.paymentTxHash,
          cashuFlow: result.cashuFlow,
          sameRail: snapshot.paymentRail === "cashu",
          ...topUpBinding(result, snapshot),
        },
      };
    }
    return {
      error: {
        body: paymentErrorBody("cashu_not_p2pk_locked", {
          message: "This DVM requires P2PK-locked Cashu proofs. Initialize an agent wallet first.",
        }),
        status: 402,
      },
    };
  }
  if (body.content.x402_payment && opts.x402Config) {
    if ((opts.pricingCurrency ?? "usd") !== "usd") {
      return { error: x402NotOfferedPaymentError(opts.pricingCurrency) };
    }
    // The facilitator requirement comes from the amount persisted when the
    // payment-request was advertised, so an FX refresh cannot reprice it. The
    // shared verifier still converts the receipt at the current rate, but this
    // mid-job path credits the original pending msat requirement below.
    const rate = await resolveRateOrNull(opts.fxFetcher);
    if (rate === null) return { error: rateUnavailablePaymentError() };
    try {
      const requiredMsats = snapshot.pendingPaymentMsats ?? 0;
      const requiredUsdcMicro =
        snapshot.pendingX402AmountUsdcMicro !== undefined
          ? BigInt(snapshot.pendingX402AmountUsdcMicro)
          : BigInt(msatsToUsdc(requiredMsats, rate));
      if (opts.x402ExactSettlement) {
        return await acceptDurableExactIncoming({
          settlement: opts.x402ExactSettlement,
          paymentHeader: body.content.x402_payment as string,
          config: opts.x402Config,
          requiredUsdcMicro,
          resource: opts.resourcePath ?? "/v1/job",
          btcUsdRate: rate,
          exactVersions: opts.x402ExactVersions,
          opts,
          snapshot,
        });
      }
      const { verifyX402Payment } = await import("../../lib/x402");
      const receipt = await withPaymentStage("verifier_broadcast", () => verifyX402Payment(
        body.content.x402_payment as string,
        opts.x402Config!,
        requiredUsdcMicro,
        opts.resourcePath ?? "/v1/job",
        rate,
        opts.x402ExactVersions
      ));
      if (!receipt.verified) {
        return {
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: "x402 signature verification failed",
            }),
            status: 402,
          },
        };
      }
      // Per-job binding: a payment-request that included an x402
      // envelope stamped a fresh server-issued `bytes32` nonce on the wire,
      // captured into `pendingX402Nonce`. The facilitator's EIP-3009 check
      // proves the authorization is well-signed but doesn't bind it to *this*
      // job — a payload with the right `(payTo, value)` lifted from a sibling
      // job's payment-request could otherwise satisfy this one before its
      // `transferWithAuthorization` settles. Checked after the cryptographic
      // verify so error-shape side-channels can't reveal bound nonces; gated
      // on `pendingX402Nonce !== undefined` for backwards-compat with pre-fix
      // DVMs. Compare as raw hex strings — no bigint coercion, no asymmetric
      // `0x` stripping.
      if (snapshot.pendingX402Nonce !== undefined) {
        const incomingNonce = decodePayment(body.content.x402_payment as string).payload
          .authorization.nonce;
        if (incomingNonce !== snapshot.pendingX402Nonce) {
          return {
            error: {
              body: paymentErrorBody("payment_invalid", {
                message: "x402 payment not bound to this job",
              }),
              status: 402,
            },
          };
        }
      }
      // the money moved outside dvmkit, so the durable commit is the
      // processed-payment marker + fund + growDraw in one transaction — the
      // same shape the upfront path uses, and the first crash-replay protection
      // this leg has ever had (the per-job nonce above is cleared on accept).
      const ledgerCtx = await resolveTopUpLedgerContext(
        opts,
        snapshot,
        await incomingCreditBinding({
          rail: "x402",
          x402Payment: body.content.x402_payment as string,
        })
      );
      let credited: CommittedFunding | undefined;
      const paymentId = receipt.txHash;
      if (ledgerCtx && !paymentId) {
        // No settlement reference to key the marker on — skip the ledger leg
        // (legacy semantics) rather than mint an unkeyed funding, exactly as
        // the upfront implicit path does. Money is never refused for a rail
        // metadata gap.
        logCreditRejected("x402_missing_tx_hash", undefined);
      }
      if (ledgerCtx && paymentId) {
        try {
          credited = await commitMarkedFunding(ledgerCtx, {
            rail: "x402",
            paymentId,
            paidMsats: midJobFundedMsats(snapshot, receipt.amountMsats),
            nativeAmount: receipt.amountUsdcMicro,
            nativeAsset: "usdc",
          });
        } catch (err) {
          const mapped = mapLedgerCommitError(err, undefined, true);
          if (mapped?.error) {
            logCredentialRejected("x402", "mid-job", err);
            return {
              error: {
                body: mapped.error.body,
                status: mapped.error.status,
                ...(mapped.error.replayPaymentId && { replayPaymentId: mapped.error.replayPaymentId }),
              },
            };
          }
          throw err;
        }
      }
      const info = withDrawBasis(
        {
          // The exact advertised USDC authorization satisfied this pending
          // requirement. A later FX move must not shrink the credit and leave
          // an already-settled job suspended.
          paidMsats: snapshot.pendingPaymentMsats ?? receipt.amountMsats,
          paymentRail: "x402",
          receivedProofs: [],
          paymentTxHash: receipt.txHash,
          nativeAmount: receipt.amountUsdcMicro,
          nativeAsset: "usdc",
        },
        ledgerCtx,
        credited
      );
      return {
        verified: {
          paidMsats: info.paidMsats,
          paymentRail: "x402",
          paymentTxHash: info.paymentTxHash,
          nativeAmount: info.nativeAmount,
          nativeAsset: "usdc",
          sameRail: snapshot.paymentRail === "x402",
          ...topUpBinding(info, snapshot),
        },
      };
    } catch (err) {
      logCredentialRejected("x402", "mid-job", err);
      return {
        error: {
          body: paymentErrorBody("payment_invalid", { message: "x402 verification error" }),
          status: 402,
        },
      };
    }
  }
  if (body.content.tempo_credential && opts.mpp) {
    const mppServer = opts.mpp;
    // Same reasoning as the x402 branch — resolve before the `try`.
    const rate = await resolveRateOrNull(opts.fxFetcher);
    if (rate === null) return { error: rateUnavailablePaymentError() };
    try {
      const credential = body.content.tempo_credential as MppxCredential;
      if (isMppSessionCredential(credential)) {
        return {
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: MPP_SESSION_ONLY_ON_CREDIT,
            }),
            status: 402,
          },
        };
      }
      const expectedMsats = snapshot.pendingPaymentMsats ?? 0;
      if (expectedMsats <= 0) {
        return {
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: "MPP credential without pending payment-request",
            }),
            status: 402,
          },
        };
      }
      if (!snapshot.pendingMppChallengeIds?.includes(credential.challenge.id)) {
        return {
          error: {
            body: paymentErrorBody("payment_invalid", {
              message: "MPP credential not bound to this job",
            }),
            status: 402,
          },
        };
      }
      const expectedAmount =
        snapshot.pendingPaymentFiatCurrency === "usd" &&
        snapshot.pendingPaymentFiatMicro !== undefined
          ? fiatMicroToMethodAmount(
              snapshot.pendingPaymentFiatMicro,
              credential.challenge.method
            )
          : msatsToMethodAmount(expectedMsats, credential.challenge.method, rate);
      const expectedMeta = challengeMeta(credential.challenge);
      const creditNative = methodNativeAmountFromDecimal(
        expectedAmount,
        credential.challenge.method
      );
      const nativeAsset = methodNativeAsset(credential.challenge.method);
      const ledgerCtx = await resolveTopUpLedgerContext(
        opts,
        snapshot,
        await incomingCreditBinding({ rail: "tempo", mppCredential: credential })
      );
      const funding: RailFunding & { rail: "tempo" } = {
        rail: "tempo",
        paymentId: mppPaymentId(credential),
        paidMsats: expectedMsats,
        nativeAmount: creditNative,
        nativeAsset,
      };
      // No session-acceptance arm here, and that is the guard above being
      // load-bearing rather than belt-and-braces: the only credential that
      // reaches this line is a one-shot charge, so voucher acceptance and its
      // atomic ledger composition live solely on the `/v1/credit` upfront path.
      await loggers.tempo.span(
        "tempo.verify_credential",
        {
          method: credential.challenge.method,
          challenge_id: credential.challenge.id,
          amount: expectedAmount,
        },
        () =>
          withPaymentStage("verifier_broadcast", () => mppServer.broadcastCredential(credential, {
            request: { amount: expectedAmount },
            ...(opts.hostingPaymentSeq !== undefined && {
              hostedPaymentIntent: { jobId: opts.jobId, paymentSeq: opts.hostingPaymentSeq },
            }),
            ...(expectedMeta && { meta: expectedMeta }),
          })),
        { onError: paymentFailureFields }
      );
      // same durable commit as x402 — marker + fund + growDraw in one
      // transaction, keyed on the credential's challenge id.
      let credited: CommittedFunding | undefined;
      if (ledgerCtx) {
        try {
          credited = await commitMppFunding(ledgerCtx, credential, funding);
        } catch (err) {
          const mapped = mapLedgerCommitError(err, undefined, true);
          if (mapped?.error) {
            logCredentialRejected("tempo", "mid-job", err);
            return {
              error: {
                body: mapped.error.body,
                status: mapped.error.status,
                ...(mapped.error.replayPaymentId && { replayPaymentId: mapped.error.replayPaymentId }),
              },
            };
          }
          throw err;
        }
      }
      if (credited) {
        await mppServer.completeHostedTempoCharge?.(credential.challenge.id).catch((error: unknown) => {
          console.warn("Hosted Tempo charge completion remains unresolved", error);
        });
      }
      const info = withDrawBasis(
        {
          paidMsats: expectedMsats,
          paymentRail: "tempo",
          receivedProofs: [],
          paymentTxHash: credential.challenge.id,
          nativeAmount: creditNative,
          nativeAsset,
        },
        ledgerCtx,
        credited
      );
      return {
        verified: {
          paidMsats: info.paidMsats,
          paymentRail: "tempo",
          paymentTxHash: info.paymentTxHash,
          nativeAmount: info.nativeAmount,
          nativeAsset,
          sameRail: snapshot.paymentRail === "tempo",
          ...topUpBinding(info, snapshot),
        },
      };
    } catch (err) {
      logCredentialRejected("tempo", "mid-job", err);
      return {
        error: {
          body: paymentErrorBody("payment_invalid", {
            message: "MPP credential verification failed",
          }),
          status: 402,
        },
      };
    }
  }

  return { error: { status: 402, body: paymentErrorBody("payment_invalid", {
    message: "Payment method is not configured",
  }) } };
}

/**
 * Rail value a mid-job funding is worth, in msats.
 *
 * The outstanding ask is preferred, and deliberately so (sibling
 * reasoning): the authorization the caller signed satisfied *that* figure, and
 * an fx move between the ask and the settle must not shrink the credit under an
 * already-settled job. But a **cleared** ask is not a pinned amount, it is the
 * absence of one — a payment arriving after the ask was met has only
 * the rail's own figure to go on, and sizing it at zero would fund nothing and
 * roll the rail leg back over money that has already moved.
 */
function midJobFundedMsats(snapshot: VerifyIncomingSnapshot, railMsats: number): number {
  const pending = snapshot.pendingPaymentMsats ?? 0;
  return pending > 0 ? pending : railMsats;
}

async function acceptDurableExactIncoming(args: {
  settlement: X402ExactSettlementServer;
  paymentHeader: string;
  config: X402Config;
  requiredUsdcMicro: bigint;
  resource: string;
  btcUsdRate: number;
  exactVersions?: X402ExactVersionSupport;
  opts: IncomingPaymentOpts;
  snapshot: VerifyIncomingSnapshot;
}): Promise<{
  verified?: VerifiedIncomingPayment;
  error?: { body: Record<string, unknown>; status: number; funding?: CreditFundingReport };
}> {
  const authorization = exactEvmAuthorization(decodePayment(args.paymentHeader));
  if (
    args.snapshot.pendingX402Nonce !== undefined &&
    authorization.nonce !== args.snapshot.pendingX402Nonce
  ) {
    return {
      error: {
        body: paymentErrorBody("payment_invalid", {
          message: "x402 payment not bound to this job",
        }),
        status: 402,
      },
    };
  }
  const requiredMsats = args.snapshot.pendingPaymentMsats ?? 0;
  const authorizedUsdcMicro = Number.parseInt(authorization.value, 10);
  const ledgerCtx = await resolveTopUpLedgerContext(
    args.opts,
    args.snapshot,
    await incomingCreditBinding({ rail: "x402", x402Payment: args.paymentHeader })
  );
  const paidMsats = midJobFundedMsats(
    args.snapshot,
    x402SettledShare(requiredMsats, Number(args.requiredUsdcMicro), authorizedUsdcMicro)
  );
  const fundedMicro = ledgerCtx
    ? fundedMicroFor(ledgerCtx.priceFiat, paidMsats, ledgerCtx.requiredMsats)
    : 0;
  const accepted = await args.settlement.accept({
    paymentHeader: args.paymentHeader,
    config: args.config,
    requiredUsdcMicro: args.requiredUsdcMicro,
    resource: args.resource,
    btcUsdRate: args.btcUsdRate,
    exactVersions: args.exactVersions,
    dvmId: args.opts.dvmId ?? "",
    effect: ledgerCtx
      ? exactSettlementEffect(ledgerCtx, {
          paidMsats,
          fundedMicro,
          nativeAmount: authorizedUsdcMicro,
        })
      : undefined,
    commit: async (receipt, tx) => {
      if (!ledgerCtx || !receipt.txHash) return undefined;
      return commitMarkedFunding(
        ledgerCtx,
        {
          rail: "x402",
          paymentId: receipt.txHash,
          paidMsats,
          fundedMicro,
          nativeAmount: authorizedUsdcMicro,
          nativeAsset: "usdc",
        },
        tx
      );
    },
  });
  if (accepted.outcome === "ambiguous") {
    return {
      error: {
        body: paymentErrorBody("x402_settlement_ambiguous", {
          message: `Exact x402 settlement ${accepted.intentId} has an economically ambiguous outcome.`,
          extra: {
            settlement_intent_id: accepted.intentId,
            settlement_status: "ambiguous",
          },
        }),
        status: 503,
      },
    };
  }
  if (accepted.outcome === "rejected") {
    return {
      error: {
        body: paymentErrorBody("payment_invalid", {
          message: "x402 signature verification failed",
        }),
        status: 402,
      },
    };
  }
  let replayedDrawFound = false;
  let replayedCreditId: string | undefined;
  let replayedDrawId: string | undefined;
  if (accepted.replayed && ledgerCtx && accepted.receipt.txHash) {
    replayedCreditId =
      ledgerCtx.topUp?.creditId ??
      ledgerCtx.creditEnvelope?.creditId ??
      implicitCreditId("x402", accepted.receipt.txHash);
    replayedDrawId =
      ledgerCtx.topUp?.drawId ?? ledgerCtx.creditEnvelope?.drawId ?? accepted.receipt.txHash;
    replayedDrawFound =
      (await ledgerCtx.ledger.getDraw({
        creditId: replayedCreditId,
        drawId: replayedDrawId,
      })) !== undefined;
  }
  // A replayed mid-job settlement recovers as a verified result rather than a
  // 409, so the original funding row is what carries its evidence back.
  const replayedDrawFunding =
    accepted.replayed && ledgerCtx?.topUp && accepted.receipt.txHash
      ? await ledgerCtx.ledger.getFunding({
          creditId: ledgerCtx.topUp.creditId,
          fundId: accepted.receipt.txHash,
        })
      : undefined;
  const info = withDrawBasis(
    {
      ...(replayedDrawFunding && { drawFunding: replayedDrawFunding }),
      paidMsats: args.snapshot.pendingPaymentMsats ?? accepted.receipt.amountMsats,
      paymentRail: "x402",
      receivedProofs: [],
      paymentTxHash:
        replayedDrawFound && replayedCreditId && replayedDrawId
          ? drawSettlementRef(ledgerCtx?.dvmId ?? "", replayedCreditId, replayedDrawId)
          : accepted.receipt.txHash,
      nativeAmount: authorizedUsdcMicro,
      nativeAsset: "usdc",
      ...(replayedDrawFound && replayedCreditId && replayedDrawId
        ? { creditId: replayedCreditId, drawId: replayedDrawId }
        : {}),
    },
    ledgerCtx,
    accepted.committed
  );
  return {
    verified: {
      paidMsats: info.paidMsats,
      paymentRail: "x402",
      paymentTxHash: info.paymentTxHash,
      nativeAmount: info.nativeAmount,
      nativeAsset: "usdc",
      sameRail: args.snapshot.paymentRail === "x402",
      ...topUpBinding(info, args.snapshot),
    },
  };
}

/**
 * The credit fields a mid-job top-up hands back to Tx C.
 *
 * `creditId`/`drawId` are bound **only** when the job had none — a free-then-
 * paid job whose top-up minted a fresh implicit credit. A job that already
 * holds a binding keeps it: the top-up grew that draw rather than opening a
 * second one, so re-reporting it would invite a rebind on a job whose ledger
 * linkage is already the source of truth for the receipt.
 *
 * The deposit always rides along. Money that landed on a credit is a liability
 * whether or not the job that triggered it ever completes, and the platform's
 * outstanding-liability view is short by exactly the top-ups it never sees.
 *
 * `unappliedMicro` rides along too when the job's draw declined part or all of
 * it — that slice is balance the caller can drain, and only the 201
 * can tell them so.
 */
function topUpBinding(
  info: PaymentInfo,
  snapshot: VerifyIncomingSnapshot
): Pick<VerifiedIncomingPayment, "creditId" | "drawId" | "funding" | "unappliedMicro" | "drawFunding"> {
  const fresh = !snapshot.creditId && info.creditId && info.drawId;
  return {
    ...(fresh && { creditId: info.creditId, drawId: info.drawId }),
    ...(info.funding && { funding: info.funding }),
    ...(info.unappliedMicro !== undefined && { unappliedMicro: info.unappliedMicro }),
    ...(info.drawFunding && { drawFunding: info.drawFunding }),
  };
}

/**
 * Apply a verified payment result to the in-memory job. Used by callers that
 * don't run Tx C (e.g., the legacy isolate-job-manager path).
 */
export function applyPaymentInfoToJob(job: ServerJob, info: VerifiedIncomingPayment): void {
  job.paidMsats += info.paidMsats;
  // Set-if-null: only a top-up that minted a fresh implicit credit
  // reports one, and an existing binding is the receipt's source of truth.
  job.creditId ??= info.creditId;
  job.drawId ??= info.drawId;
  if (info.paymentMint) job.paymentMint = info.paymentMint;
  job.paymentRail = info.paymentRail;
  if (info.paymentTxHash) job.paymentTxHash = info.paymentTxHash;
  if (info.nativeAmount !== undefined) {
    job.nativeAmount = info.sameRail
      ? (job.nativeAmount ?? 0) + info.nativeAmount
      : info.nativeAmount;
  }
  if (info.nativeAsset) job.nativeAsset = info.nativeAsset;
  if (info.cashuFlow) job.cashuFlow = info.cashuFlow;
  if (info.paymentRail === "tempo") {
    job.pendingMppChallengeIds = undefined;
  }
  if (info.paymentRail === "x402") {
    // This ask is fulfilled; discard its amount and nonce binding.
    job.pendingX402Nonce = undefined;
    job.pendingX402AmountUsdcMicro = undefined;
  }
  creditPendingPayment(job);
}

/**
 * Legacy ledgerless payment path. Mutates the job on acceptance; durable credit hosts use
 * verifyIncomingPayment and apply its result in Tx C.
 */
export async function processIncomingPayment(
  job: ServerJob,
  body: { type: MessageType; content: Record<string, unknown> },
  opts: IncomingPaymentOpts
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  return withPaymentDiagnostics(() => processIncomingPaymentInScope(job, body, opts));
}

async function processIncomingPaymentInScope(
  job: ServerJob,
  body: { type: MessageType; content: Record<string, unknown> },
  opts: IncomingPaymentOpts
): Promise<{ body: Record<string, unknown>; status: number } | null> {
  if (body.type !== "payment") return null;

  if (body.content.cashu_token) {
    // route P2PK-locked mid-job cashu through the accumulator when
    // the receive-side rails are wired (mirrors the upfront `verifyUpfrontPayment`
    // routing). Unconfigured DVMs still reject with `cashu_not_p2pk_locked` so
    // bare-token mid-job pays — which retired — surface the same error.
    if (
      opts.cashuMode === "p2pk-accumulator" &&
      (opts.accumulatorDb || opts.disposableCashu) &&
      opts.dvmId &&
      opts.lockPubkeys &&
      opts.lockPubkeys.length > 0
    ) {
      const mints = opts.mints ?? [];
      if (mints.length === 0) {
        return {
          body: paymentErrorBody("cashu_unavailable", {
            message: "No mints configured for cashu receive.",
          }),
          status: 402,
        };
      }
      const requestId =
        typeof body.content.cashu_request_id === "string"
          ? body.content.cashu_request_id
          : undefined;
      const result = await verifyAccumulatorReceipt(
        {
          cashuToken: body.content.cashu_token as string,
          accumulatorDb: opts.accumulatorDb,
          disposableCashu: opts.disposableCashu,
          dvmId: opts.dvmId,
          lockPubkeys: opts.lockPubkeys,
          requestId,
          mintHealthTracker: opts.mintHealthTracker,
        },
        mints,
        job.pendingPaymentMsats
      );
      if (result.error) {
        return { body: result.error.body, status: result.error.status };
      }
      job.paidMsats += result.paidMsats;
      if (result.paymentMint) job.paymentMint = result.paymentMint;
      job.paymentRail = "cashu";
      // Cashu credits track `paymentTxHash` via the request id; `nativeAmount`
      // is left unset because the platform derives sats from `paidMsats / 1000`
      // for cashu rows.
      job.paymentTxHash = result.paymentTxHash;
      job.cashuFlow = result.cashuFlow;
      creditPendingPayment(job);
      return null;
    }
    return {
      body: paymentErrorBody("cashu_not_p2pk_locked", {
        message: "This DVM requires P2PK-locked Cashu proofs. Initialize an agent wallet first.",
      }),
      status: 402,
    };
  } else if (body.content.x402_payment && opts.x402Config) {
    if ((opts.pricingCurrency ?? "usd") !== "usd") {
      return x402NotOfferedPaymentError(opts.pricingCurrency);
    }
    // The exact facilitator requirement is the amount advertised and persisted
    // with the pending nonce; the fallback covers legacy records. The
    // original pending msat requirement remains the credit value even if this
    // later rate changes the receipt's converted msat amount.
    const rate = await resolveRateOrNull(opts.fxFetcher);
    if (rate === null) return rateUnavailablePaymentError();
    try {
      const requiredMsats = job.pendingPaymentMsats ?? 0;
      const requiredUsdcMicro =
        job.pendingX402AmountUsdcMicro !== undefined
          ? BigInt(job.pendingX402AmountUsdcMicro)
          : BigInt(msatsToUsdc(requiredMsats, rate));
      const { verifyX402Payment } = await import("../../lib/x402");
      const receipt = await withPaymentStage("verifier_broadcast", () => verifyX402Payment(
        body.content.x402_payment as string,
        opts.x402Config!,
        requiredUsdcMicro,
        opts.resourcePath ?? "/v1/job",
        rate,
        opts.x402ExactVersions
      ));
      if (receipt.verified) {
        // Per-job binding: see `verifyIncomingPayment` for the full
        // rationale. Checked after the facilitator's cryptographic verify so
        // an unauthenticated client can't probe bound nonces via error-shape
        // side-channels; gated on `pendingX402Nonce !== undefined` for
        // backwards-compat with pre-fix DVMs.
        if (job.pendingX402Nonce !== undefined) {
          const incomingNonce = decodePayment(body.content.x402_payment as string).payload
            .authorization.nonce;
          if (incomingNonce !== job.pendingX402Nonce) {
            return {
              body: paymentErrorBody("payment_invalid", {
                message: "x402 payment not bound to this job",
              }),
              status: 402,
            };
          }
        }
        job.paidMsats += job.pendingPaymentMsats ?? receipt.amountMsats;
        // accumulate rail-native amount across multi-credit jobs so
        // the platform's `revenue_events.gross_native` row reflects the sum,
        // not just the upfront credit. Same-rail credits accumulate; a
        // cross-rail switch resets — single-row accounting can't represent
        // mixed-asset gross natively, mirroring the pre-existing
        // paymentRail-clobber. Cross-rail mid-job isn't exercised by
        // first-party DVMs today.
        const sameRail = job.paymentRail === "x402";
        job.nativeAmount =
          (sameRail ? (job.nativeAmount ?? 0) : 0) + (receipt.amountUsdcMicro ?? 0);
        job.nativeAsset = "usdc";
        job.paymentTxHash = receipt.txHash;
        job.paymentRail = "x402";
        // Clear the per-job binding on accept.
        job.pendingX402Nonce = undefined;
        job.pendingX402AmountUsdcMicro = undefined;
        creditPendingPayment(job);
      } else {
        return {
          body: paymentErrorBody("payment_invalid", {
            message: "x402 signature verification failed",
          }),
          status: 402,
        };
      }
    } catch (err) {
      logCredentialRejected("x402", "mid-job", err);
      return {
        body: paymentErrorBody("payment_invalid", { message: "x402 verification error" }),
        status: 402,
      };
    }
  } else if (body.content.tempo_credential && opts.mpp) {
    const mppHandle = opts.mpp;
    // Same reasoning as the x402 branch — resolve before the `try`.
    const rate = await resolveRateOrNull(opts.fxFetcher);
    if (rate === null) return rateUnavailablePaymentError();
    try {
      const credential = body.content.tempo_credential as MppxCredential;
      if (isMppSessionCredential(credential)) {
        // The isolate verifier's copy of the durable path's guard, and the one
        // with the worse failure behind it: this path carries no ledger context
        // at all, so an accepted voucher would move the channel's on-chain
        // state and credit nothing.
        return {
          body: paymentErrorBody("payment_invalid", { message: MPP_SESSION_ONLY_ON_CREDIT }),
          status: 402,
        };
      }
      const expectedMsats = job.pendingPaymentMsats ?? 0;
      if (expectedMsats <= 0) {
        // No outstanding payment-request to satisfy. Refuse rather than blanket-
        // accept — accepting would let an unsolicited credential silently bump
        // job.paidMsats.
        return {
          body: paymentErrorBody("payment_invalid", {
            message: "MPP credential without pending payment-request",
          }),
          status: 402,
        };
      }
      const expectedAmount =
        job.pendingPaymentFiatCurrency === "usd" && job.pendingPaymentFiatMicro !== undefined
          ? fiatMicroToMethodAmount(job.pendingPaymentFiatMicro, credential.challenge.method)
          : msatsToMethodAmount(expectedMsats, credential.challenge.method, rate);
      // Same defense as upfront: pass the SDK-required amount so mppx rejects
      // any credential whose bound amount differs. Echo the credential's own
      // meta back so mppx's rebuild doesn't reject server-issued correlation
      // values — replay protection here is via `pendingMppChallengeIds`
      // checked below; the HMAC already proves the meta is
      // server-issued, so trusting it for the rebuild is sound.
      const expectedMeta = challengeMeta(credential.challenge);
      await loggers.tempo.span(
        "tempo.verify_credential",
        {
          method: credential.challenge.method,
          challenge_id: credential.challenge.id,
          amount: expectedAmount,
        },
        () =>
          withPaymentStage("verifier_broadcast", () => mppHandle.broadcastCredential(credential, {
            request: { amount: expectedAmount },
            ...(opts.hostingPaymentSeq !== undefined && {
              hostedPaymentIntent: { jobId: opts.jobId, paymentSeq: opts.hostingPaymentSeq },
            }),
            ...(expectedMeta && { meta: expectedMeta }),
          })),
        { onError: paymentFailureFields }
      );
      // Per-job binding: reject credentials whose challenge wasn't
      // issued for this job. mppx HMAC binds realm/method/amount/expiry — not
      // the dvmkit job-id — so a sibling job that requested the same fields
      // would otherwise accept a credential lifted from this one's issuance
      // within the expiry window. Checked after the cryptographic verify so
      // an unauthenticated client can't probe for currently-bound challenge
      // ids via error-shape side-channels.
      if (!job.pendingMppChallengeIds?.includes(credential.challenge.id)) {
        return {
          body: paymentErrorBody("payment_invalid", {
            message: "MPP credential not bound to this job",
          }),
          status: 402,
        };
      }
      job.paidMsats += expectedMsats;
      // accumulate native amounts across multi-credit mpp jobs (see
      // x402 branch above for the same-rail/cross-rail rationale).
      const sameRail = job.paymentRail === "tempo";
      const creditNative = methodNativeAmountFromDecimal(
        expectedAmount,
        credential.challenge.method
      );
      job.nativeAmount = (sameRail ? (job.nativeAmount ?? 0) : 0) + creditNative;
      job.nativeAsset = methodNativeAsset(credential.challenge.method);
      job.paymentTxHash = credential.challenge.id;
      job.paymentRail = "tempo";
      job.pendingMppChallengeIds = undefined;
      creditPendingPayment(job);
      await mppHandle.completeHostedTempoCharge?.(credential.challenge.id).catch((error: unknown) => {
        console.warn("Hosted Tempo charge completion remains unresolved", error);
      });
    } catch (err) {
      logCredentialRejected("tempo", "mid-job", err);
      return {
        body: paymentErrorBody("payment_invalid", {
          message: "MPP credential verification failed",
        }),
        status: 402,
      };
    }
  }

  return null;
}

/** Credit a pending payment and transition the job to processing if satisfied. */
function creditPendingPayment(job: ServerJob): void {
  if (
    job.status === "awaiting-input" &&
    job.pendingPaymentMsats &&
    job.paidMsats >= job.pendingPaymentMsats
  ) {
    job.status = "processing";
    job.pendingPaymentMsats = undefined;
  }
}

/** Fields {@link verifyAccumulatorReceipt} reads — common to upfront + mid-job paths. */
interface AccumulatorReceiveCommonOpts {
  cashuToken?: string;
  accumulatorDb?: AccumulatorPool;
  disposableCashu?: DisposableCashuCommit;
  dvmId?: string;
  lockPubkeys?: LockPubkey[];
  requestId?: string;
  mintHealthTracker?: MintHealthTracker;
}

/**
 * Accumulator-path receive. Routes through
 * `acceptAccumulatorPayment`, which verifies the P2PK lock, runs NUT-7
 * checkstate, and persists. Replay protection is enforced by the
 * `wallet_accumulator` UNIQUE constraints; the receive path returns
 * `replay_rejected` on collision. Returns a `PaymentResult` shaped to match
 * the existing rails so the caller's error/credit branches don't change.
 */
async function verifyAccumulatorReceipt(
  opts: AccumulatorReceiveCommonOpts,
  mints: string[],
  requiredMsats: number | undefined,
  ledgerCtx?: LedgerContext
): Promise<PaymentResult> {
  const { cashuToken, accumulatorDb, dvmId, lockPubkeys, mintHealthTracker } = opts;
  if (!cashuToken || (!accumulatorDb && !opts.disposableCashu) || !dvmId || !lockPubkeys || lockPubkeys.length === 0) {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("cashu_unavailable", {
          message: "Accumulator path is not fully configured.",
        }),
        status: 402,
      },
    };
  }

  // hold paid calls until the tracker's first probe lands. Boot no
  // longer fail-fasts on mint health before binding the port, so in the brief
  // post-`listen` window before the initial probe resolves the tracker gives
  // every mint benefit-of-the-doubt (`isHealthy` → true) — accepting a token
  // here would route it at an unvalidated mint. Composes with the sick gate
  // below: once the probe lands this passes through and per-token health
  // (incl. all-mints-unhealthy) is enforced there.
  if (mintHealthTracker && !mintHealthTracker.initialProbeComplete()) {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("mint_health_pending", {
          message: "Mint health check is still in progress — retry in a moment.",
          extra: { mints },
        }),
        status: 503,
      },
    };
  }

  // short-circuit when the token's mint is currently sick. Decode
  // the token up-front (cheap — no network) so the mint URL is known before
  // we drop into `acceptAccumulatorPayment`'s NUT-7 round-trip, which would
  // otherwise hang on a dead mint until the per-call timeout fires.
  // rides the same decode: the mint is the credit's funding basis
  // (it derives the deposit's and every later draw's `chain_id`), and it has
  // to be known before the commit transaction opens.
  let tokenMint: string | undefined;
  try {
    tokenMint = verifyCashuToken(cashuToken, mints).mint;
  } catch {
    // Decode failed (invalid token, mint not in allowlist, etc.) — fall
    // through to `acceptAccumulatorPayment`, which reports the canonical
    // rejection code with the correct status.
  }
  if (mintHealthTracker && tokenMint && !mintHealthTracker.isHealthy(tokenMint)) {
    const healthy = mintHealthTracker.healthyMints();
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("cashu_mint_sick", {
          message: `Mint ${tokenMint} is currently unhealthy. Retry with a token minted at a healthy mint.`,
          hint:
            healthy.length > 0
              ? `Try one of: ${healthy.join(", ")}`
              : "All configured mints are currently unhealthy — wait and retry.",
          extra: { mints: healthy.length > 0 ? healthy : mints },
        }),
        status: 503,
      },
    };
  }

  // Ledger leg (spec condition 3): fund + draw run inside the SAME
  // transaction as the accumulator insert, via the receive path's
  // `withCommitTx` hook — the money commits iff the ledger credit commits.
  // Only wired when a request id exists (its absence is rejected below with
  // `missing_request_id` before the hook would run).
  let credited: CommittedFunding | undefined;
  const requestId = opts.requestId;
  const signedFund = ledgerCtx?.creditEnvelope?.fund;
  const beforeCommit =
    ledgerCtx && signedFund
      ? (accepted: { paidMsats: number }) => {
          const expected = fundedMicroFor(
            ledgerCtx.priceFiat,
            accepted.paidMsats,
            ledgerCtx.requiredMsats
          );
          if (signedFund.amountMicro !== expected) {
            throw new CashuFundingAmountMismatchError(signedFund.amountMicro, expected);
          }
        }
      : undefined;
  const withCommitTx =
    ledgerCtx && requestId
      ? async (
          tx: AccumulatorQuerier,
          accepted: { paidMsats: number; grossMsats: number; inputFeeMsats: number }
        ) => {
          credited = await fundAndDraw(
            ledgerCtx,
            {
              rail: "cashu",
              paymentId: requestId,
              paidMsats: accepted.paidMsats,
              grossPaidMsats: accepted.grossMsats,
              cashuInputFeeMsats: accepted.inputFeeMsats,
              mint: tokenMint,
            },
            tx
          );
        }
      : undefined;

  let result: Awaited<ReturnType<typeof acceptAccumulatorPayment>>;
  try {
    result = await acceptAccumulatorPayment({
      cashuToken,
      requestId: opts.requestId,
      mints,
      db: accumulatorDb,
      disposable: opts.disposableCashu,
      withDisposableLedger: ledgerCtx && requestId ? async (ledger, accepted) => {
        credited = await fundAndDraw({ ...ledgerCtx, ledger }, {
          rail: "cashu", paymentId: requestId, paidMsats: accepted.paidMsats,
          grossPaidMsats: accepted.grossMsats, cashuInputFeeMsats: accepted.inputFeeMsats,
          mint: tokenMint,
        });
      } : undefined,
      dvmId,
      lockPubkeys,
      beforeCommit,
      withCommitTx,
    });
  } catch (err) {
    if (err instanceof CashuFundingAmountMismatchError) {
      return creditRefusal("funding_commitment_mismatch", err.message, {
        extra: { expected_micro: err.expectedMicro },
        hint: `Nothing was captured — re-sign this same token with fund.amount_micro set to expected_micro (${err.expectedMicro}) and resubmit.`,
      });
    }
    // A throw from the ledger leg rolled the whole transaction back — no
    // proofs accepted, no credit. Map to the structured surface.
    const mapped = mapLedgerCommitError(err);
    if (mapped) return mapped;
    throw err;
  }

  if (result.kind === "rejected") {
    const status = result.code === "replay_rejected" ? 409 : 402;
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody(result.code, { message: result.message, extra: { mints } }),
        status,
        // The accumulator keys replay on the request id, which is also the
        // funding id a mid-job top-up committed under, so the route can hand
        // back the original draw funding evidence beside the 409.
        ...(status === 409 && requestId && { replayPaymentId: requestId }),
      },
    };
  }

  // an explicit short deposit may still leave the named credit below
  // the full-price draw. `fundAndDraw` preserves that expected refusal instead
  // of throwing it through `withCommitTx`, so the accumulator insert and the
  // deposit commit together while no draw lands. Return the ledger's
  // actionable shortfall and carry the deposit to the platform as a liability.
  if (credited?.drawRefusal) {
    return creditLedgerErrorResult(credited.drawRefusal, undefined, credited.deposit);
  }

  // Short-pay forfeiture belongs only to implicit N=1. Fund-only deposits are
  // caller money whatever their size, while an explicit fund-and-draw has two
  // independent authorities: the signed fund amount binds what was deposited,
  // and the ledger decides whether the full-price draw is covered. A short
  // explicit token is therefore a smaller deposit, never a failed per-call
  // payment whose balance-funded draw may be forfeited.
  if (
    requiredMsats &&
    result.paidMsats < requiredMsats &&
    !ledgerCtx?.fundOnly &&
    !ledgerCtx?.creditEnvelope
  ) {
    // The proofs are already committed (today's keep-the-money posture), so
    // the implicit draw that landed with them is settled immediately: no job
    // will ever resolve it, and ledger truth must equal money truth.
    //
    // Never on a **mid-job** payment — top-up or free-then-paid.
    // Forfeit's premise is that no job exists to carry the money; mid-job there
    // always is one, and its handler is still running. `fundAndDraw` has
    // already declined to place or grow a draw for a short mid-job pay, so
    // `credited.draw` is unset on that path and this gate is the second lock on
    // the same door: a settle here would close a live job's debit mid-flight,
    // or book a phantom against a job still working.
    let forfeit: ShortPayForfeit | undefined;
    if (credited?.draw && ledgerCtx && !ledgerCtx.midJob) {
      const drawId = credited.draw.drawId;
      try {
        const settled = await ledgerCtx.ledger.settle({ creditId: credited.creditId, drawId });
        // Kept money is revenue. No job will ever
        // book it, so the route reports it directly under a synthetic job id
        // and a `short_pay_forfeit` tag — kept out of per-job service revenue
        // in analytics, and queryable if the refund posture changes.
        // Deliberately NOT a deposit: nothing was left owing to the caller, so
        // a liability line here would be a phantom that never clears.
        forfeit = {
          paymentId: credited.deposit.fundingId,
          paidMsats: result.paidMsats,
          mint: result.mintUrl,
          creditId: credited.creditId,
          drawId,
          amountMicro: settled.amountMicro,
          currency: ledgerCtx.priceFiat.currency,
          settledAt: settled.resolvedAt,
        };
      } catch (err) {
        logCreditRejected("short_pay_settle_failed", credited.creditId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // A short mid-job pay funded a credit and stopped (no draw placed or grown,
    // no forfeit settled), so the caller still holds a claim on money this DVM
    // is now carrying. Name that credit in the body. On a free-then-paid job
    // the credit is brand new — the job row isn't bound to it yet, so without
    // this the caller would have to derive `imp:<rail>:<payment_id>` to reach
    // the drain. `/v1/credit`'s fund response already hands
    // `credit_id` back; a deposit that landed on the failure path is owed the
    // same.
    const held = ledgerCtx?.midJob ? credited : undefined;
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("payment_insufficient", {
          message: `Payment of ${result.paidMsats} msats is short of the ${requiredMsats} msats required.`,
          ...(held && {
            // Per-code copy can't say where the money went, and this is the one
            // site where that is the caller's next action.
            hint: `The ${result.paidMsats} msats already sent are held on credit ${held.creditId} and do not reduce what is owed — retry with a single payment of required_msats, or reclaim the held balance with op "drain" at POST /v1/credit.`,
          }),
          extra: {
            required_msats: requiredMsats,
            received_msats: result.paidMsats,
            mints,
            ...(held && {
              credit_id: held.creditId,
              credited_micro: held.deposit.amountMicro,
              credit_currency: held.deposit.currency,
            }),
          },
        }),
        status: 402,
        forfeit,
        // Report the deposit on the failure path too, or the platform never
        // learns about a liability it is carrying. Mutually exclusive with
        // `forfeit` by construction: one is money still owed, the other is
        // money nothing is owed against.
        ...(held && { funding: held.deposit }),
      },
    };
  }

  return withDrawBasis(
    {
      paidMsats: result.paidMsats,
      paymentMint: result.mintUrl,
      paymentRail: "cashu",
      receivedProofs: [],
      // requestId is non-null here because acceptAccumulatorPayment returns
      // kind:"rejected" with code "missing_request_id" when unset (handled by
      // the rejected branch above). Thread it as the per-call settlement
      // reference for revenue_events.tx_hash. Unique per
      // (dvm_id, request_id) by the wallet_accumulator UNIQUE constraint, so
      // it serves as a stable id even though it isn't an on-chain hash.
      paymentTxHash: opts.requestId,
      cashuFlow: "p2pk_accumulator",
    },
    ledgerCtx,
    credited
  );
}

/**
 * Build the x402 `PaymentRequirements` array that the 402 response advertises
 * Today it's a single requirement; the array shape is a
 * forward-compatibility hook for multi-network/multi-asset DVMs once the
 * x402 spec stabilises support for it.
 *
 * USDC is treated as the rail-native asset, and the per-call required amount
 * comes from {@link x402RequiredUsdcMicro} — the quoted USD price verbatim.
 * Non-USD DVMs are gated before this builder. The caller must sign this
 * advertised `maxAmountRequired`; its own BTC/USD rate is only a sanity ceiling
 * and ledger conversion, so rate-window drift cannot make the facilitator
 * reject an otherwise valid authorization.
 *
 * The verify branch derives the same figure through the same helper, which is
 * the whole point: the 402 carries no server-side state, so anything
 * this advertises has to be reconstructible at submit from the request alone.
 */
function buildX402Requirements(
  config: X402Config,
  resource: string,
  priceFiat: PriceFiat
): PaymentRequirements[] {
  const requiredUsdcMicro = BigInt(x402RequiredUsdcMicro(priceFiat));
  return [
    buildPaymentRequirements({
      x402Config: config,
      requiredUsdcMicro,
      resource,
      version: X402_V1_VERSION,
    }),
  ];
}

/**
 * The fiat micro-units an attached x402 authorization will fund, predicted from
 * a local decode before the facilitator settles — or `undefined`
 * when the header cannot be read as a payload carrying a usable `value`.
 *
 * This is deliberately the same arithmetic the post-settlement gate performs,
 * on the same input: `verifyX402Payment` takes its rail-native amount from
 * `payload.authorization.value`, the field decoded here, so predicting is exact
 * rather than approximate. The two must never diverge — a prediction that
 * refused a payment the settled valuation would have accepted turns a working
 * caller away, and one that accepted a payment the settled gate then refuses
 * puts the money loss back where it was.
 *
 * An authorization BELOW `maxAmountRequired` is nobody's arithmetic error and is
 * declined here on purpose. `/verify` rejects it before `/settle`, so the
 * post-settlement gate has never seen an underpayment and predicting one would
 * report a case this function was not written to judge: the pro-rata figure
 * falls under `price_micro`, so the mismatch fires first and shadows the real
 * error with a correction that cannot help — no `fund.amount_micro` makes an
 * underfunded authorization settle. Leave it to the facilitator, which is the
 * only party that can say why the credential is short.
 */
function predictX402FundedMicro(
  paymentHeader: string,
  priceMicro: number,
  requiredUsdcMicro: number
): number | undefined {
  let value: number;
  try {
    value = Number.parseInt(exactEvmAuthorization(decodePayment(paymentHeader)).value, 10);
  } catch {
    return undefined;
  }
  if (!Number.isFinite(value) || value <= 0 || value < requiredUsdcMicro) return undefined;
  return x402SettledShare(priceMicro, requiredUsdcMicro, value);
}

/**
 * Narrow a credit's stored rail onto {@link FundingMethod}. A credit funded
 * before carries none, so its draws degrade to the pre-1437 behaviour
 * (no rail → the terminal books nothing) rather than guessing a rail wrong.
 *
 * `lightning` belongs here even though it is not a wire method: a
 * credit funded by invoice backs draws like any other, and leaving it out is
 * what would make those draws book no revenue at all.
 *
 * **A rail present in `credits.rail` but absent from the recognised set settles
 * its draws and books nothing, silently overstating outstanding liability
 * forever** — the shape, which happened because this reader kept its
 * own hand-written list of rails. It no longer does: `isFundingRail` reads
 * `FUNDING_RAILS`, an exhaustive `Record<FundingMethod, true>` that is also
 * what `CreditFundingBasis.rail` is typed against, so the write side and the
 * read side cannot list different rails. `JobManager.bookRevenue` is the
 * backstop for the residue live databases already hold: any draw reaching no
 * revenue event logs `revenue_skipped_no_rail`, with
 * `reason: "credit_rail_unrecognized"` for exactly this case.
 */
function railAsFundingMethod(rail: string | null): FundingMethod | undefined {
  return isFundingRail(rail) ? rail : undefined;
}

/** What one rail actually paid, as handed to the ledger leg. */
interface RailFunding {
  rail: "cashu" | "x402" | "tempo";
  /** Rail settlement reference: cashu request id / EVM tx hash / mpp challenge id. */
  paymentId: string;
  paidMsats: number;
  /** Gross Cashu proof face before the receiver input fee; Cashu only. */
  grossPaidMsats?: number;
  /** Standalone NUT-02 input fee for the received Cashu proofs; Cashu only. */
  cashuInputFeeMsats?: number;
  /**
   * Fiat micro this payment funds, when the rail values itself in its own
   * units rather than through the msat quote (x402, against the
   * `maxAmountRequired` the 402 advertised). Set only where the amount gate
   * upstream computed the same figure, so the gated and credited valuations
   * are one number. Omitted elsewhere: `fundedMicroFor` is the default.
   */
  fundedMicro?: number;
  nativeAmount?: number;
  nativeAsset?: "sats" | "usdc" | "usdc.e" | "usd-cents";
  mint?: string;
  tempoSession?: { channelId: string; cumulativeAmount: string };
  /** TIP-1034 chain binding, reported so the platform can route a close. */
  tempoChannel?: TempoChannelReport;
  x402Channel?: { channelId: string; maxClaimableAmount: string };
}

/** Everything the ledger leg of a rail commit needs, assembled per request. */
interface LedgerContext {
  ledger: CreditLedgerLike;
  processedPayments?: ProcessedPaymentStore;
  enqueueCreditDeposit?: CreditDepositEnqueue;
  priceFiat: PriceFiat;
  requiredMsats: number;
  /** Funder identity: verified caller pubkey, else requester id, else "anonymous". */
  callerId: string;
  jobId?: string;
  hostingAdmissionId?: string;
  hostingPaymentSeq?: number;
  hostingPaymentArtifactHash?: string;
  jobAdmission?: { requestFingerprint: string; authFingerprint?: string };
  dvmId: string;
  creditEnvelope?: CreditEnvelope;
  /**
   * Set for a `/v1/credit` top-up: fund, don't draw. `creditId` is
   * resolved once here — minting it lazily per rail branch would let the
   * processed-payment marker and the ledger disagree about which credit the
   * money landed in.
   */
  fundOnly?: Required<Pick<FundOnlyRequest, "creditId">> & FundOnlyRequest;
  /**
   * Set for a mid-job `requestPayment` top-up: fund this credit and
   * **grow** the draw the upfront leg already placed, rather than opening a
   * second one. One job keeps one draw, so the receipt's `ReceiptCredit` block
   * sums to the job's full cost and `revenue_events` still books one row.
   */
  /**
   * `ledgerSeq` is the draw's own sequence, read with the draw in the preflight.
   * Optional because a persisted x402 settlement effect from before it was
   * recorded carries none; the funding leg then reads it off the draw.
   */
  topUp?: { creditId: string; drawId: string; ledgerSeq?: number };
  /**
   * Ceiling on this job's cumulative draw growth, in fiat micro of
   * {@link priceFiat}'s currency — what the job has cumulatively
   * asked for mid-job. `growDraw` clips against it under the credit row's
   * lock, which is the only place two concurrent payments for one ask can be
   * told apart. Undefined when the job's ask total isn't expressible as a
   * ceiling (see `JobRecord.askedTopUpMicro`); growth is then unbounded, as
   * before.
   */
  topUpCapMicro?: number;
  /**
   * Set when a mid-job payment lands on a job whose ask is **already
   * satisfied**: the duplicate arrived after the winner's Tx C
   * cleared `pending_payment_msats`, so there is no ask left to price it
   * against and nothing for it to buy. `fundAndDraw` funds the credit and
   * stops — the same fund-and-stop shape a short mid-job pay takes. Without
   * it the preflight would refuse outright and the money would be kept with no
   * ledger record at all.
   */
  askSatisfied?: true;
  /**
   * True for every mid-job payment, including a free-then-paid job's
   * first one — where there is no {@link topUp} because there is no draw yet.
   *
   * The distinction that matters is "a job exists and is still running", not
   * "the job already holds a draw": it is what makes a short payment a deposit
   * rather than a forfeit, and it is the only signal `fundAndDraw` and the
   * accumulator's short-pay branch have to tell the two apart.
   */
  midJob?: true;
  /**
   * True when this job's revenue basis is the **draw**, not the rail traffic
   * Upfront that means an explicit fund-and-draw — one funding
   * backs N jobs, so the amounts the rail moved are the deposit's, not this
   * job's. A mid-job top-up inherits the job's existing basis: growing an
   * explicit draw must keep booking the per-draw settlement reference, or the
   * top-up would overwrite it with a rail reference the ledger doesn't know.
   * Implicit N=1 leaves it false, which is what keeps per-job payment
   * byte-identical to the pre-credits model.
   */
  drawBasis: boolean;
  /** Credit lifetime to mint, from the DVM's advertised `credit.ttl`. */
  ttlMs: number;
}

/**
 * Assemble the {@link LedgerContext}, or `undefined` when this request's
 * payments run with legacy (ledger-less) semantics: no ledger wired, or a
 * free job.
 *
 * A paid job with no fiat denomination is an invariant violation, not an
 * outage, so it throws. Every price form is fiat-exact now —
 * `configureDVM` rejects a static price it can't denominate and
 * `validateQuoteResult` rejects a dynamic one — so the only way here is a new
 * price producer that forgot to denominate, and that must not degrade quietly
 * into unledgered revenue. Safe to throw: this runs above every rail branch,
 * before any proofs are received or any credential is settled.
 */
function resolveLedgerContext(opts: UpfrontPaymentOpts): LedgerContext | undefined {
  if (!opts.creditLedger || !opts.requiredMsats) return undefined;
  if (!opts.priceFiat) {
    throw new PriceDenominationError(opts.requiredMsats);
  }
  return {
    ledger: opts.creditLedger,
    processedPayments: opts.processedPayments,
    enqueueCreditDeposit: opts.enqueueCreditDeposit,
    priceFiat: opts.priceFiat,
    requiredMsats: opts.requiredMsats,
    callerId: opts.callerPubkey ?? opts.requesterId ?? "anonymous",
    jobId: opts.jobId,
    hostingAdmissionId: opts.hostingAdmissionId,
    hostingPaymentArtifactHash: opts.hostingPaymentArtifactHash,
    jobAdmission:
      opts.jobId && opts.requestFingerprint
        ? {
            requestFingerprint: opts.requestFingerprint,
            authFingerprint: opts.requestAuthFingerprint,
          }
        : undefined,
    dvmId: opts.dvmId ?? "",
    creditEnvelope: opts.creditEnvelope,
    fundOnly: opts.fundOnly
      ? { ...opts.fundOnly, creditId: opts.fundOnly.creditId ?? randomUUID() }
      : undefined,
    drawBasis: !!opts.creditEnvelope,
    ttlMs: opts.creditTtlMs ?? IMPLICIT_CREDIT_TTL_MS,
  };
}

/**
 * Assemble the {@link LedgerContext} for a mid-job `requestPayment` top-up
 * (the credit lifecycle contract), or `undefined` when this payment runs ledger-less.
 *
 * Every refusal here is a **skip, not an error**. The rail commit and the
 * ledger leg share one transaction, so a `fund` that threw inside it would
 * roll back cashu proofs the caller already sent — and on x402/mpp the money
 * has already moved outside dvmkit, so refusing would take the caller's
 * payment and hand back nothing. Money is never refused over an accounting
 * problem (the posture). Each skip is logged loud instead.
 *
 * The preflight reads the target credit rather than assuming it, because
 * `fund`'s upsert guards on `caller_pubkey`, `currency`, `rail` and **both
 * channel columns** — all of them are checked here, outside the transaction, so
 * none of them can become a rollback. `binding` is what the arriving artifact
 * would write, read off the artifact itself; the rail alone is not
 * enough, because an x402 exact payment and an x402 channel voucher agree on it
 * and disagree on `x402_channel_id`.
 */
async function resolveTopUpLedgerContext(
  opts: IncomingPaymentOpts,
  snapshot: VerifyIncomingSnapshot,
  binding: IncomingCreditBinding
): Promise<LedgerContext | undefined> {
  const ledger = opts.creditLedger;
  const rail = binding.rail;
  const requiredMsats = snapshot.pendingPaymentMsats ?? 0;
  if (!ledger) return undefined;
  // no outstanding ask. A payment still arrives here — the caller
  // retried after a lost response and the winner's Tx C has since cleared the
  // ask. It buys nothing, but it is the caller's money, so a job already bound
  // to a credit funds that credit and grows nothing. Without a binding there is
  // no credit to name and no ask to price against, so it stays ledger-less.
  // (Only cashu and x402 reach this: the mpp branch refuses a credential with
  // no outstanding challenge before it ever asks for a ledger context.)
  const askSatisfied = requiredMsats <= 0;
  if (askSatisfied && !(snapshot.creditId && snapshot.drawId)) return undefined;
  const dvmId = opts.dvmId ?? "";

  const logTopUp = (event: string, extra?: Record<string, unknown>): void => {
    diagnosticConsole.warn(
      {
        level: "warn",
        event,
        rail,
        job_id: opts.jobId,
        credit_id: snapshot.creditId,
        draw_id: snapshot.drawId,
        ...extra,
        ...(typeof opts.jobId === "string" && {
          job_id_hash: createHash("sha256").update(opts.jobId, "utf8").digest("hex"),
        }),
      }
    );
  };
  const logSkip = (reason: string, extra?: Record<string, unknown>): void => {
    logTopUp("credit_topup_skipped", { reason, ...extra });
  };

  let topUp: { creditId: string; drawId: string; ledgerSeq?: number } | undefined;
  let callerId: string;
  let currency: string;
  let drawBasis = false;

  if (snapshot.creditId && snapshot.drawId) {
    const [credit, draw] = await Promise.all([
      ledger.get(snapshot.creditId).catch(() => undefined),
      ledger
        .getDraw({ creditId: snapshot.creditId, drawId: snapshot.drawId })
        .catch(() => undefined),
    ]);
    if (!credit || !draw) {
      logSkip("credit_or_draw_missing");
      return undefined;
    }
    // A resolved draw means the job already reached terminal (a cross-machine
    // cancel, the stale sweeper). There is nothing left to grow, and reopening
    // a settled debit would move money after the receipt attested it.
    if (draw.status !== "pending") {
      logSkip("draw_not_pending", { status: draw.status });
      return undefined;
    }
    // `growDraw` guards on this too, and a throw there lands inside the rail
    // transaction — the one outcome this preflight exists to prevent. The draw
    // is already in hand, so mirror the guard here where a refusal costs
    // nothing. Unreachable while the job row is the only source of the pair.
    if (opts.jobId !== undefined && (draw.jobId ?? null) !== opts.jobId) {
      logSkip("draw_job_mismatch", { draw_job_id: draw.jobId });
      return undefined;
    }
    // `rail` is null on a credit funded before — it has no basis to
    // conflict with, so a top-up is fine. A *different* rail is refused by
    // `fund` itself (sats and USDC microunits aren't summable), so catch it here
    // where a refusal is free.
    const creditRail = draw.railValue.rail;
    if (creditRail !== null && creditRail !== rail) {
      logSkip("rail_mismatch", { credit_rail: creditRail });
      return undefined;
    }
    // The channel half of the same rule. `fund`'s upsert compares
    // `tempo_channel_id` and `x402_channel_id` on both sides as well as the
    // rail, and an exact x402 payment agrees with a channel-bound credit's rail
    // while disagreeing about its channel — so without this rung the refusal
    // lands inside the rail transaction, with the caller's USDC already
    // transferred. Rail-independent, exactly as the upsert's `WHERE` is: the
    // credit's channel columns are on the row whatever `credits.rail` says, so
    // this also covers the legacy `rail IS NULL` row the rung above skips.
    //
    // No settlement-gate rung rides alongside it: a wedged x402
    // refund is only ever held against a credit's *bound* channel, and every
    // such credit is turned away right here, so `blockingX402Refund` on this
    // path could never answer anything. Admitting a mid-job channel voucher —
    // deliberately out of scope, reusable channels are a `/v1/credit`
    // instrument — is what would make it reachable, and it must land in the
    // same change.
    const incomingChannels = incomingChannelColumns(binding);
    const storedChannels = storedChannelColumns(credit);
    if (
      incomingChannels &&
      (incomingChannels.tempo !== storedChannels.tempo ||
        incomingChannels.x402 !== storedChannels.x402)
    ) {
      logSkip("channel_binding_mismatch", {
        credit_rail: creditRail,
        credit_tempo_channel_id: storedChannels.tempo,
        credit_x402_channel_id: storedChannels.x402,
        ...(binding.instrument ? { payment_instrument: binding.instrument } : {}),
        ...(binding.channelId ? { payment_channel_id: binding.channelId } : {}),
      });
      return undefined;
    }
    topUp = { creditId: snapshot.creditId, drawId: snapshot.drawId, ledgerSeq: draw.ledgerSeq };
    callerId = credit.callerPubkey;
    currency = credit.currency;
    // Inherit the job's revenue basis. An explicit fund-and-draw stamped a
    // per-draw settlement reference upfront; recomputing it identifies that job
    // exactly, and keeps the top-up from overwriting the reference with a rail
    // one `revenue_events` can't tie back to the draw.
    drawBasis =
      snapshot.paymentTxHash === drawSettlementRef(dvmId, snapshot.creditId, snapshot.drawId);
  } else {
    // Free-then-paid job: the upfront leg placed no draw, so this money opens a
    // fresh implicit credit — the same shape an upfront implicit N=1 payment
    // would have created, just later in the job's life.
    callerId = snapshot.requesterPubkey ?? snapshot.requesterId ?? "anonymous";
    currency = snapshot.pendingPaymentFiatCurrency ?? "usd";
  }

  // With no ask outstanding there is no pinned envelope to fund against, so
  // the reference converts into a plain rate and `fundedMicroFor`'s pro-rata
  // rule applies it to whatever landed.
  const priceBasisMsats = askSatisfied ? NO_ASK_RATE_REFERENCE_MSATS : requiredMsats;
  const denomination = askSatisfied
    ? await msatsToFiatMicro({
        msats: priceBasisMsats,
        currency,
        fxFetcher: opts.fxFetcher ?? createFxFetcher(),
      })
    : await resolveTopUpFiat(snapshot, currency, priceBasisMsats, opts.fxFetcher);
  if (!denomination.ok) {
    // Keep the fixed cause, never the provider detail carried by denomination.
    logSkip("denomination_unavailable", {
      currency,
      cause: denomination.reason,
      ...(denomination.sourceFailure && {
        source_failure: denomination.sourceFailure.category,
        source_status: denomination.sourceFailure.httpStatus,
      }),
    });
    return undefined;
  }
  const priceFiat = denomination.price;
  // The top-up is denominated, but off a snapshot the rate provider could no
  // longer confirm. The ledger row is truthful about what was quoted;
  // the rate behind it may have drifted, and this is the only record of that.
  //
  // Its own event, deliberately not a `credit_topup_skipped` reason: nothing was
  // skipped, and an operator alarming on that event must not be paged by the
  // degradation that exists to keep this path working.
  if (denomination.stale) {
    logTopUp("credit_topup_stale_rate", {
      currency,
      amount_micro: priceFiat.amountMicro,
      // Which rung degraded: the whole snapshot fell back to `lastKnown()`, or
      // the live fetch landed without this currency and it was carried forward
      // from an earlier one. The first is the rate source down, the
      // second is the rate source having quietly stopped carrying a currency
      // this DVM advertises — a config problem, and a different repair.
      ...(denomination.carriedForward === true && { rate_carried_forward: true }),
      ...(denomination.cachedAt !== undefined && {
        rate_cached_at: new Date(denomination.cachedAt).toISOString(),
      }),
    });
  }

  const topUpCapMicro = topUp ? resolveTopUpCap(snapshot, currency, logSkip) : undefined;

  return {
    ledger,
    processedPayments: opts.processedPayments,
    enqueueCreditDeposit: opts.enqueueCreditDeposit,
    priceFiat,
    requiredMsats: priceBasisMsats,
    callerId,
    jobId: opts.jobId,
    hostingPaymentSeq: opts.hostingPaymentSeq,
    dvmId,
    topUp,
    topUpCapMicro,
    ...(askSatisfied && { askSatisfied: true as const }),
    midJob: true,
    drawBasis,
    ttlMs: opts.creditTtlMs ?? IMPLICIT_CREDIT_TTL_MS,
  };
}

/**
 * A rate carrier, not a price. A payment landing on a job whose ask
 * is already satisfied has nothing to be priced against, but `fundAndDraw`
 * still needs a fiat figure to fund the credit with. Converting this reference
 * and letting `fundedMicroFor` pro-rate against it applies the live rate to
 * whatever actually arrived. 1000 sats is large enough that the conversion's
 * rounding is well below a micro-unit on any plausible rate.
 */
const NO_ASK_RATE_REFERENCE_MSATS = 1_000_000;

/**
 * The ceiling on this job's cumulative mid-job draw growth, or
 * `undefined` when the job's ask total can't express one.
 *
 * Deliberately no fx hop, unlike `resolveTopUpFiat`. A cap is a refusal, and a
 * refusal converted at a rate that has moved since the asks were pinned would
 * clip a payment the caller legitimately owes — money taken for work the job
 * then never performs.
 *
 * moved the conversion to where it can be pinned instead of skipped:
 * `ctx.requestPayment` denominates every ask in the job's own sticky currency,
 * seeded from the credit it is bound to (or from the DVM's declaration, which is
 * what its first payment will open the credit in). So the total arrives already
 * speaking the credit's currency, and the ceiling is the *same pinned integer*
 * `resolveTopUpFiat` hands `fundedMicroFor` — which is why a rate move between
 * the ask and the payment is structurally incapable of clipping anything, rather
 * than merely unlikely to.
 *
 * Both branches below are therefore backstops. Reaching the first means the
 * rate provider was down when an ask was emitted (`ask_unpriceable`, the one
 * remaining door — see `JobRecord.topUpCapUnenforcedReason`, which records it
 * durably) or the row predates the column. Reaching the second means a total
 * summed under an older build, or in a currency this job is no longer bound to;
 * converting here is exactly the bias this function exists to refuse.
 */
function resolveTopUpCap(
  snapshot: VerifyIncomingSnapshot,
  currency: string,
  logSkip: (reason: string, extra?: Record<string, unknown>) => void
): number | undefined {
  const asked = snapshot.askedTopUpMicro;
  if (asked === undefined || asked === UNCAPPABLE_ASK_TOTAL || asked <= 0) {
    logSkip("topup_cap_unavailable", {
      asked_topup_micro: asked ?? null,
      cap_unenforced_reason: snapshot.topUpCapUnenforcedReason ?? null,
    });
    // Only a total this build KNOWS it lost feeds the counted signal — the
    // sentinel, or the reason column that always accompanies it. A row simply
    // carrying no total is the ordinary shape of a job that predates the column
    // and of a payment landing on a job that never asked, so counting it would
    // hold the alarm above zero for the life of every in-flight job at rollout
    // and drown the one event worth paging on.
    if (asked === UNCAPPABLE_ASK_TOTAL || snapshot.topUpCapUnenforcedReason) {
      countUncappedTopUp("topup_cap_unavailable", snapshot);
    } else {
      loggers.isolate.info("dvm.topup_cap_absent", {
        at: "topup_preflight",
        asked_topup_micro: asked ?? null,
      });
    }
    return undefined;
  }
  if (snapshot.askedTopUpCurrency !== currency) {
    logSkip("topup_cap_currency_mismatch", {
      asked_topup_currency: snapshot.askedTopUpCurrency ?? null,
      credit_currency: currency,
    });
    countUncappedTopUp("topup_cap_currency_mismatch", snapshot);
    return undefined;
  }
  return asked;
}

/**
 * The same span `ctx.requestPayment` emits when an ask poisons the total
 * so one alarm counts both the ask-time and the pay-time door — a
 * top-up that grows a draw with no ceiling is the event worth watching, and it
 * is only observable here.
 *
 * Reserved for a ceiling this build lost: a total absent because the row
 * predates the column, or because the job never asked, emits
 * `dvm.topup_cap_absent` at `info` instead. That one is expected in bulk at
 * rollout, and an alarm that can't sit at zero is an alarm nobody reads.
 */
function countUncappedTopUp(skip: string, snapshot: VerifyIncomingSnapshot): void {
  loggers.isolate.warn("dvm.topup_cap_unenforceable", {
    reason: snapshot.topUpCapUnenforcedReason ?? skip,
    at: "topup_preflight",
    asked_topup_currency: snapshot.askedTopUpCurrency ?? null,
  });
}

/**
 * The mid-job ask's fiat envelope, in the target credit's currency.
 *
 * The envelope pinned at ask time is used verbatim when it already speaks the
 * credit's currency — that is the exact figure a fiat-form `ctx.requestPayment`
 * named, and pinning is what keeps a rate move between the ask and the payment
 * out of the ledger. After that is every ask this build emits, since
 * the pin is denominated in the credit's currency at ask time; the convert
 * fallback is the backstop for a row an older build wrote, and it fires under
 * the same condition as `resolveTopUpCap`'s mismatch skip — so a *converted*
 * fund figure never meets a *pinned* ceiling, in either direction.
 *
 * That backstop is also the whole of the bare-msats path's denomination
 * `ctx.requestPayment(5000, …)` carries no envelope, so a pin the
 * ask-time fetch lost leaves this the only leg left, and it runs against the
 * very fetcher that just failed. `msatsToFiatMicro` degrades onto the
 * last-known snapshot rather than treating one blip as no rate at all.
 */
async function resolveTopUpFiat(
  snapshot: VerifyIncomingSnapshot,
  currency: string,
  requiredMsats: number,
  fxFetcher?: FxFetcher
): Promise<FiatDenomination> {
  if (snapshot.pendingPaymentFiatMicro && snapshot.pendingPaymentFiatCurrency === currency) {
    return {
      ok: true,
      price: { currency, amountMicro: snapshot.pendingPaymentFiatMicro },
      stale: false,
    };
  }
  return msatsToFiatMicro({
    msats: requiredMsats,
    currency,
    fxFetcher: fxFetcher ?? createFxFetcher(),
  });
}

/**
 * Thrown when a paid request reaches the ledger leg with no fiat
 * denomination. Unreachable through any shipped price form; it
 * exists so a future one that skips denomination fails at the request rather
 * than booking money the ledger never sees.
 */
class PriceDenominationError extends Error {
  readonly code = "price_denomination_missing";
  constructor(readonly requiredMsats: number) {
    super(
      `paid request (${requiredMsats} msats) has no fiat denomination — every price must resolve ` +
        "to a PriceFiat before the ledger leg runs"
    );
    this.name = "PriceDenominationError";
  }
}

/**
 * Sentinel thrown when the in-transaction draw turns out to be a replay — an
 * earlier request owns this `(credit_id, draw_id)`. The rail transaction is
 * rolled back (no proofs accepted, no fund) and the verifier returns the
 * `replayedDraw` recovery shape instead.
 */
class ReplayedDrawError extends Error {
  constructor(readonly draw: DrawResult) {
    super(`draw ${draw.drawId} on credit ${draw.creditId} already recorded`);
    this.name = "ReplayedDrawError";
  }
}

/** A signed Cashu fund amount that disagrees with the pre-commit net valuation. */
class CashuFundingAmountMismatchError extends Error {
  constructor(
    readonly signedMicro: number,
    readonly expectedMicro: number
  ) {
    super(
      `fund.amount_micro (${signedMicro}) does not match the attached token's net value at the quoted price (${expectedMicro}).`
    );
    this.name = "CashuFundingAmountMismatchError";
  }
}

/**
 * Overlay the draw-sized revenue basis onto a rail's `PaymentInfo`.
 *
 * Under the **explicit** regime one funding backs N jobs, so the amounts the
 * rail just moved are the deposit's, not this job's: the job books what its
 * draw consumed, stamped with a per-draw settlement reference (the funding's
 * own reference is reused by every sibling draw, and `revenue_events` drops
 * cross-job reuse of one reference by design).
 *
 * Under the **implicit N=1** regime fund and draw are the same money in the
 * same request, so this is a no-op overlay and the rail's own values survive
 * verbatim — that is what keeps per-job payment byte-identical to the
 * pre-credits model.
 */
function withDrawBasis(
  info: PaymentInfo,
  ctx: LedgerContext | undefined,
  committed: CommittedFunding | undefined
): PaymentInfo {
  if (!committed || !ctx) return info;
  const base: PaymentInfo = {
    ...info,
    creditId: committed.creditId,
    creditCurrency: ctx.priceFiat.currency,
    funding: committed.deposit,
    ...(committed.fundingCredit ? { fundingCredit: committed.fundingCredit } : {}),
    ...(committed.unappliedMicro !== undefined && {
      unappliedMicro: committed.unappliedMicro,
    }),
    ...(committed.drawFunding && { drawFunding: committed.drawFunding }),
  };
  // A `/v1/credit` top-up funds and stops: it is a deposit with no
  // job to draw for, so there is no revenue basis to overlay — but the deposit
  // above still has to reach the platform, or the credit's later draws book
  // revenue against a liability that was never recorded.
  const draw = committed.draw;
  if (!draw) return base;
  const drawId = draw.drawId;
  const withDraw: PaymentInfo = {
    ...base,
    drawId,
    drawAmountMicro: draw.amountMicro,
    ...(!ctx.midJob && !ctx.fundOnly && { upfrontPayment: upfrontPaymentFromDraw(draw) }),
  };
  if (!ctx.drawBasis) return withDraw;
  // What THIS leg contributed: the whole draw upfront, the increment on a
  // mid-job top-up — the job's counters accumulate deltas, so
  // handing back the grown draw's running total would double-count it.
  const { drawMsats, drawNative } = committed.added ?? draw.railValue;
  return {
    ...withDraw,
    paidMsats: drawMsats > 0 ? drawMsats : info.paidMsats,
    paymentTxHash: drawSettlementRef(ctx.dvmId, committed.creditId, drawId),
    ...(info.nativeAmount !== undefined && drawNative !== null && { nativeAmount: drawNative }),
  };
}

/** A committed funding: the deposit the platform books, plus the draw it backs. */
interface CommittedFunding {
  creditId: string;
  /** Snapshot fixed immediately after this request's funding leg, before any draw. */
  fundingCredit?: CreditSnapshot;
  /**
   * Absent for a `/v1/credit` fund-only top-up — money landed on the
   * credit with no job to pay for — for a short mid-job pay, which funds
   * without drawing or growing, and for an explicit short deposit
   * whose combined balance cannot cover the draw. On a mid-job
   * top-up this is the **grown** draw, so `amountMicro` is the job's running
   * total, not this leg's contribution.
   */
  draw?: DrawResult;
  /**
   * An explicit short deposit committed, but the combined available balance
   * could not cover the full-price draw. Preserved instead of
   * thrown so the rail receive and deposit commit atomically with no draw.
   */
  drawRefusal?: CreditLedgerError;
  /**
   * What this leg added to an already-placed draw. Set only on a
   * mid-job top-up; the upfront legs contribute the whole draw, so they leave
   * it unset and `draw.railValue` is the same thing.
   */
  added?: { amountMicro: number; drawMsats: number; drawNative: number | null };
  /**
   * Fiat micro that landed on the credit but grew no draw — a
   * duplicate payment for an ask already satisfied, the clipped tail of an
   * oversized one, or a payment that arrived after the ask was met. It stays
   * the caller's available balance; `UnappliedCredit` on the 201 is how they
   * find out.
   */
  unappliedMicro?: number;
  /** The `credit_fundings` row a mid-job top-up fixed beside its fund/grow leg. */
  drawFunding?: FundingRecord;
  deposit: CreditFundingReport;
}

/**
 * The fund + draw pair every rail commit runs (the credit lifecycle contract): fund the
 * paid amount at the quote-pinned fiat ratio, then place the job's draw.
 * Implicit N=1 (no credit envelope) derives single-use ids from the payment
 * id and draws the full funded amount; an explicit envelope uses the
 * caller's ids, funds the artifact's value, and draws the quoted price.
 *
 * `ctx.fundOnly` (a `/v1/credit` top-up) funds and **stops** — a
 * deposit with no job to pay for. It records the funding under the caller's
 * `fund_id` in the same transaction, which is what makes a retried top-up
 * return the original outcome instead of crediting twice.
 *
 * A short `ctx.midJob` pay funds and stops too, for the opposite reason: there
 * is a job, it is still running, and a partial payment neither completes its
 * ask nor ends it. See `shortMidJob` below.
 *
 * The rail's own value rides along as the credit's funding basis so
 * each draw can later be allocated the slice of it that job consumed — that
 * allocation is what makes a settled draw bookable as revenue on this rail.
 * Both regimes hand back the deposit: money that landed on a credit is a
 * liability whether or not this request also spent some of it.
 */
async function fundAndDraw(
  ctx: LedgerContext,
  funding: RailFunding,
  tx?: CreditLedgerQuerier
): Promise<CommittedFunding> {
  return withPaymentStage("funding_ledger", () => fundAndDrawInScope(ctx, funding, tx));
}

async function fundAndDrawInScope(
  ctx: LedgerContext,
  funding: RailFunding,
  tx?: CreditLedgerQuerier
): Promise<CommittedFunding> {
  const env = ctx.creditEnvelope;
  const fundedMicro =
    funding.fundedMicro ?? fundedMicroFor(ctx.priceFiat, funding.paidMsats, ctx.requiredMsats);
  // A **short** mid-job pay funds and stops — on every mid-job shape, whether
  // the job already held a draw or this payment would have opened its first
  // A job exists and its handler is still running, so nothing here
  // is closable: growing a live draw by a partial amount would tell the receipt
  // the caller had paid for work the ask says they still owe, and *placing* a
  // draw would hand the accumulator's short-pay branch a debit to settle as
  // forfeit — money booked as earned against a job that is still going. The
  // deposit is reported instead: the money lands on a credit the caller owns
  // and can reclaim under the drain, which is strictly better than
  // today's keep-it-with-no-ledger-record.
  //
  // What it is NOT is progress on the ask. `requiredMsats` is the whole
  // outstanding amount and no partial decrements it, so the next attempt still
  // owes the full ask; partial balance never satisfies it. The 402's
  // hint says so, and names the credit. On the top-up shape the deposits at
  // least pile onto the job's own credit; on the free-then-paid shape each one
  // opens its own `imp:<rail>:<payment_id>`, so repeated partials fragment
  // across credits and each needs its own drain.
  //
  // Forfeit is for money no job will ever carry; that is the upfront submit,
  // never this path.
  const shortMidJob = ctx.midJob === true && funding.paidMsats < ctx.requiredMsats;
  const fundedAt = Date.now();
  const expiryMs = fundedAt + ctx.ttlMs;
  const basis = {
    rail: funding.rail,
    paidMsats: funding.paidMsats,
    nativeAmount: funding.nativeAmount,
    nativeAsset: funding.nativeAsset,
    mint: funding.mint,
    fundingRef: funding.paymentId,
    tempoSession: funding.tempoSession,
    x402Channel: funding.x402Channel,
  };
  const deposit = {
    creditId:
      ctx.fundOnly?.creditId ??
      ctx.topUp?.creditId ??
      env?.creditId ??
      implicitCreditId(funding.rail, funding.paymentId),
    fundingId: funding.paymentId,
    rail: funding.rail,
    paidMsats: funding.paidMsats,
    grossPaidMsats: funding.grossPaidMsats,
    cashuInputFeeMsats: funding.cashuInputFeeMsats,
    nativeAmount: funding.nativeAmount,
    nativeAsset: funding.nativeAsset,
    mint: funding.mint,
    amountMicro: fundedMicro,
    currency: ctx.priceFiat.currency,
    fundedAt,
    expiryMs,
    tempoSession: funding.tempoSession,
    tempoChannel: funding.tempoChannel,
  } satisfies Omit<CreditFundingReport, "callerPubkey">;
  // An implicit short upfront payment is settled immediately as tagged
  // revenue, so it creates no caller liability and therefore no deposit row.
  // Every other funding is a deposit, including short mid-job payments and
  // explicit short fund-and-draw attempts whose balance remains reclaimable.
  const createsDepositLiability = !(
    !ctx.midJob &&
    !ctx.fundOnly &&
    !env &&
    funding.paidMsats < ctx.requiredMsats
  );
  const enqueue = ctx.enqueueCreditDeposit;
  if (createsDepositLiability && enqueue && (!tx || !ctx.dvmId)) {
    // Fail before the first ledger write. Falling back to a pool query here
    // would recreate the crash window this seam exists to remove.
    throw new Error("deposit outbox enqueue requires the rail's open transaction and a DVM id");
  }
  const commitDeposit = async (
    result: Omit<CommittedFunding, "deposit">,
    credit: CreditSnapshot
  ): Promise<CommittedFunding> => {
    // `fund` returns the ledger's authoritative owner. Build the report only
    // after that read/write succeeds so a request field can never become the
    // identity on a deposit for a differently-owned credit. The instrument is
    // read from the same snapshot for the same reason: the report names what
    // the credit is bound to, not what this request's artifact looked like.
    const instrument = credit.rail ? storedCreditBinding(credit).instrument : undefined;
    const report: CreditFundingReport = {
      ...deposit,
      expiryMs: credit.expiryMs,
      callerPubkey: credit.callerPubkey,
      ...(instrument && { instrument }),
    };
    if (createsDepositLiability && enqueue && tx) {
      await enqueue(tx, creditDepositPayload(ctx.dvmId, report));
    }
    return { ...result, deposit: report };
  };
  if (ctx.fundOnly) {
    const { creditId } = ctx.fundOnly;
    // Record first: the PK on (credit_id, fund_id) is the top-up's
    // idempotency key, so a duplicate loses here — before the balance moves.
    await ctx.ledger.recordFunding({
      creditId,
      fundId: ctx.fundOnly.fundId,
      amountMicro: fundedMicro,
      rail: funding.rail,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingCallerPubkey: ctx.callerId,
      tx,
    });
    const credit = await ctx.ledger.fund({
      creditId,
      callerPubkey: ctx.callerId,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingFundId: ctx.fundOnly.fundId,
      currency: ctx.priceFiat.currency,
      amountMicro: fundedMicro,
      expiryMs,
      basis,
      tx,
    });
    await ctx.ledger.completeFunding({
      creditId,
      fundId: ctx.fundOnly.fundId,
      callerPubkey: ctx.callerId,
      balanceAfterMicro: credit.availableMicro,
      ledgerSeq: credit.lastLedgerSeq,
      tx,
    });
    return commitDeposit({ creditId }, credit);
  }
  if (ctx.topUp) {
    const { creditId, drawId } = ctx.topUp;
    // The funding row is the durable home of the mid-job funding evidence:
    // recorded under the rail payment id before the balance moves, completed
    // with the committed tuple after it, all inside the rail's transaction.
    // The row's job/draw bindings are what let a job read or a replayed
    // payment re-issue the same artifact after a lost acknowledgement.
    await ctx.ledger.recordFunding({
      creditId,
      fundId: funding.paymentId,
      amountMicro: fundedMicro,
      rail: funding.rail,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingJobId: ctx.jobId,
      hostingPaymentSeq: ctx.hostingPaymentSeq,
      jobId: ctx.jobId,
      drawId,
      paymentSeq: ctx.hostingPaymentSeq,
      tx,
    });
    const credit = await ctx.ledger.fund({
      creditId,
      callerPubkey: ctx.callerId,
      hostingJobId: ctx.jobId,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingPaymentSeq: ctx.hostingPaymentSeq,
      currency: ctx.priceFiat.currency,
      amountMicro: fundedMicro,
      expiryMs,
      basis,
      tx,
    });
    // `ledgerSeq` is the draw's own sequence, never the credit high-water
    // mark: another draw or drain can sit above it, and the terminal receipt
    // names the draw's sequence, which is what the caller reconciles against.
    // A draw whose sequence cannot be established leaves the row incomplete,
    // which withholds the artifact rather than signing a guess.
    const drawLedgerSeq = async (): Promise<number | undefined> =>
      ctx.topUp?.ledgerSeq ?? (await ctx.ledger.getDraw({ creditId, drawId }))?.ledgerSeq;
    const completeDrawFunding = async (
      balanceAfterMicro: number,
      ledgerSeq: number | undefined
    ): Promise<FundingRecord | undefined> =>
      ledgerSeq === undefined
        ? undefined
        : ctx.ledger.completeFunding({
            creditId,
            fundId: funding.paymentId,
            callerPubkey: credit.callerPubkey,
            balanceAfterMicro,
            ledgerSeq,
            tx,
          });
    // the ask this payment was for is already paid. There is nothing
    // to grow and nothing to price against, so the money is a deposit — the
    // fund-and-stop shape above, reached for the opposite reason.
    if (ctx.askSatisfied) {
      const drawFunding = await completeDrawFunding(credit.availableMicro, await drawLedgerSeq());
      return commitDeposit({ creditId, unappliedMicro: fundedMicro, drawFunding }, credit);
    }
    if (shortMidJob) {
      const drawFunding = await completeDrawFunding(credit.availableMicro, await drawLedgerSeq());
      return commitDeposit({ creditId, drawFunding }, credit);
    }
    const grown = await ctx.ledger.growDraw({
      creditId,
      drawId,
      addAmountMicro: fundedMicro,
      // never grow the draw past what the job cumulatively asked.
      // The available-balance guard inside `growDraw` cannot do this — the
      // `fund` above raised the balance by exactly this amount — so a second
      // payment for one ask would otherwise be absorbed and settle as revenue.
      capMicro: ctx.topUpCapMicro,
      // Earmark the money that just landed to this increment rather than
      // letting it blend into the credit's pool. A pro-rata share of a credit
      // whose micro:msat ratio has drifted would credit the job *less* than
      // the caller paid, and this figure is the job's `paid_msats` delta —
      // short by a rounding tail, the ask never clears and a fully-paid job
      // hangs until the idle timeout.
      addRailValue: { drawMsats: funding.paidMsats, drawNative: funding.nativeAmount ?? null },
      jobId: ctx.jobId,
      tx,
    });
    if (grown.addedAmountMicro <= 0) {
      // The cap refused the whole growth: the draw already covers every ask
      // this job has made. Report it as a deposit and leave the draw alone.
      const drawFunding = await completeDrawFunding(credit.availableMicro, grown.ledgerSeq);
      return commitDeposit({ creditId, unappliedMicro: grown.cappedMicro, drawFunding }, credit);
    }
    const drawFunding = await completeDrawFunding(grown.balanceAfterMicro, grown.ledgerSeq);
    return commitDeposit(
      {
        creditId,
        draw: grown,
        added: { amountMicro: grown.addedAmountMicro, ...grown.addedRailValue },
        ...(grown.cappedMicro > 0 && { unappliedMicro: grown.cappedMicro }),
        drawFunding,
      },
      credit
    );
  }
  const creditId = deposit.creditId;
  const drawId = env?.drawId ?? funding.paymentId;
  const drawMicro = env ? ctx.priceFiat.amountMicro : fundedMicro;
  if (env) {
    await ctx.ledger.recordFunding({
      creditId,
      fundId: funding.paymentId,
      amountMicro: fundedMicro,
      rail: funding.rail,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingJobId: ctx.jobId,
      hostingPaymentSeq: ctx.hostingPaymentSeq,
      tx,
    });
  }
  const fundedCredit = await ctx.ledger.fund({
    creditId,
    callerPubkey: ctx.callerId,
    hostingJobId: ctx.jobId,
    hostingAdmissionId: ctx.hostingAdmissionId,
    hostingPaymentSeq: ctx.hostingPaymentSeq,
    currency: ctx.priceFiat.currency,
    amountMicro: fundedMicro,
    expiryMs,
    basis,
    tx,
  });
  // Free-then-paid job, short pay: fund the fresh credit and place no draw at
  // all. See `shortMidJob` above — the alternative is a draw nothing resolves.
  if (shortMidJob) return commitDeposit({ creditId }, fundedCredit);
  let draw: DrawResult;
  try {
    draw = await ctx.ledger.draw({
      creditId,
      drawId,
      amountMicro: drawMicro,
      jobId: ctx.jobId,
      hostingAdmissionId: ctx.hostingAdmissionId,
      hostingPaymentSeq: ctx.hostingPaymentSeq,
      tx,
    });
  } catch (err) {
    // on an explicit short fund-and-draw, the token is a deposit,
    // not the job's per-call payment. If the combined balance still cannot
    // cover the full-price draw, commit the rail receive + fund together and
    // return the ledger refusal after the transaction closes. Every other
    // ledger failure still throws, rolling the rail and ledger leg back
    // together under the existing atomicity contract.
    if (
      env &&
      funding.paidMsats < ctx.requiredMsats &&
      err instanceof CreditLedgerError &&
      err.code === "insufficient_credit"
    ) {
      await ctx.ledger.completeFunding({
        creditId,
        fundId: funding.paymentId,
        callerPubkey: ctx.callerId,
        balanceAfterMicro: fundedCredit.availableMicro,
        ledgerSeq: fundedCredit.lastLedgerSeq,
        tx,
      });
      return commitDeposit(
        { creditId, drawRefusal: err, fundingCredit: fundedCredit },
        fundedCredit
      );
    }
    throw err;
  }
  if (draw.replayed) throw new ReplayedDrawError(draw);
  if (env) {
    await ctx.ledger.completeFunding({
      creditId,
      fundId: funding.paymentId,
      callerPubkey: ctx.callerId,
      balanceAfterMicro: fundedCredit.availableMicro,
      ledgerSeq: fundedCredit.lastLedgerSeq,
      tx,
    });
  }
  return commitDeposit(
    {
      creditId,
      draw,
      ...(env ? { fundingCredit: fundedCredit } : {}),
    },
    fundedCredit
  );
}

/**
 * Convert the ledger-facing funding shape into the platform deposit wire
 * payload.
 *
 * Exported because the builder-supplied `onCreditFunded` override is a second
 * door onto the same report, and both must say the same thing: hand-rolling the
 * mapping there once dropped the `tempoChannel` block, so a DVM
 * reporting through the override registered no channel with the close observer
 * One builder, no drift.
 */
export function creditDepositPayload(
  dvmId: string,
  funding: CreditFundingReport
): CreditDepositPayload {
  return {
    dvmId,
    creditId: funding.creditId,
    callerPubkey: funding.callerPubkey,
    fundingId: funding.fundingId,
    rail: funding.rail,
    paidMsats: funding.paidMsats,
    grossPaidMsats: funding.grossPaidMsats,
    cashuInputFeeMsats: funding.cashuInputFeeMsats,
    nativeAmount: funding.nativeAmount,
    nativeAsset: funding.nativeAsset,
    paymentMint: funding.mint,
    amountMicro: funding.amountMicro,
    creditCurrency: funding.currency,
    fundedAt: funding.fundedAt,
    expiryMs: funding.expiryMs,
    ...(funding.instrument && { instrument: funding.instrument }),
    // label a session-funded deposit as one, whether or not the chain
    // binding below could be read. `rail: "tempo"` alone does not say — a
    // `tempo/charge` one-shot funds a credit with no channel at all — so this is
    // what lets the platform tell a routine charge from a session whose binding
    // was lost and whose escrow nothing is watching.
    ...(funding.tempoSession && {
      tempoSession: { channelId: funding.tempoSession.channelId.toLowerCase() },
    }),
    // the channel registration rides the deposit report, so it
    // commits with the voucher acceptance that created the channel's liability.
    ...(funding.tempoChannel &&
      funding.tempoSession && {
        tempoChannel: {
          chainId: funding.tempoChannel.chainId,
          channelId: funding.tempoSession.channelId.toLowerCase(),
          escrow: funding.tempoChannel.escrow.toLowerCase(),
          ...(funding.tempoChannel.payee && {
            payee: funding.tempoChannel.payee.toLowerCase(),
          }),
        },
      }),
  };
}

/** Finish the local ledger effect retained by a durable exact-settlement intent. */
export async function repairX402ExactSettlementEffect(args: {
  effect: X402ExactSettlementEffect | undefined;
  paymentId: string;
  ledger: CreditLedgerLike;
  processedPayments?: ProcessedPaymentStore;
  enqueueCreditDeposit?: CreditDepositEnqueue;
  tx?: CreditLedgerQuerier;
}): Promise<CommittedFunding | undefined> {
  if (!args.effect) return;
  const effect = args.effect;
  const ctx: LedgerContext = {
    ledger: args.ledger,
    processedPayments: args.processedPayments,
    enqueueCreditDeposit: args.enqueueCreditDeposit,
    priceFiat: effect.priceFiat,
    requiredMsats: effect.requiredMsats,
    callerId: effect.callerId,
    dvmId: effect.dvmId,
    jobId: effect.jobId,
    hostingAdmissionId: effect.hostingAdmissionId,
    hostingPaymentSeq: effect.hostingPaymentSeq,
    jobAdmission: effect.jobAdmission,
    creditEnvelope: effect.creditEnvelope,
    fundOnly: effect.fundOnly,
    topUp: effect.topUp,
    topUpCapMicro: effect.topUpCapMicro,
    askSatisfied: effect.askSatisfied,
    midJob: effect.midJob,
    drawBasis: effect.drawBasis,
    ttlMs: effect.ttlMs,
  };
  return commitMarkedFunding(
    ctx,
    {
      rail: "x402",
      paymentId: args.paymentId,
      paidMsats: effect.paidMsats,
      fundedMicro: effect.fundedMicro,
      nativeAmount: effect.nativeAmount,
      nativeAsset: "usdc",
    },
    args.tx
  );
}

async function acceptDurableExactUpfront(args: {
  settlement: X402ExactSettlementServer;
  paymentHeader: string;
  config: X402Config;
  requiredUsdcMicro: bigint;
  resource: string;
  btcUsdRate: number;
  exactVersions: X402ExactVersionSupport;
  dvmId: string;
  requiredMsats: number;
  ledgerCtx?: LedgerContext;
  x402Requirements?: PaymentRequirements[];
}): Promise<PaymentResult> {
  const authorizedUsdcMicro = Number.parseInt(
    exactEvmAuthorization(decodePayment(args.paymentHeader)).value,
    10
  );
  const paidMsats = x402SettledShare(
    args.requiredMsats,
    Number(args.requiredUsdcMicro),
    authorizedUsdcMicro
  );
  const fundedMicro = args.ledgerCtx
    ? x402SettledShare(
        args.ledgerCtx.priceFiat.amountMicro,
        Number(args.requiredUsdcMicro),
        authorizedUsdcMicro
      )
    : 0;
  const funding = {
    rail: "x402" as const,
    paymentId: "",
    paidMsats,
    fundedMicro,
    nativeAmount: authorizedUsdcMicro,
    nativeAsset: "usdc" as const,
  };
  const effect = args.ledgerCtx
    ? exactSettlementEffect(args.ledgerCtx, {
        paidMsats,
        fundedMicro,
        nativeAmount: authorizedUsdcMicro,
      })
    : undefined;
  const accepted = await args.settlement.accept({
    paymentHeader: args.paymentHeader,
    config: args.config,
    requiredUsdcMicro: args.requiredUsdcMicro,
    resource: args.resource,
    btcUsdRate: args.btcUsdRate,
    exactVersions: args.exactVersions,
    dvmId: args.dvmId,
    effect,
    commit: async (receipt, tx, persistedEffect) => {
      if (!args.ledgerCtx || !receipt.txHash) return undefined;
      if (persistedEffect) {
        return repairX402ExactSettlementEffect({
          effect: persistedEffect,
          paymentId: receipt.txHash,
          ledger: args.ledgerCtx.ledger,
          processedPayments: args.ledgerCtx.processedPayments,
          enqueueCreditDeposit: args.ledgerCtx.enqueueCreditDeposit,
          tx,
        });
      }
      return commitMarkedFunding(args.ledgerCtx, { ...funding, paymentId: receipt.txHash }, tx);
    },
  });
  if (accepted.outcome === "ambiguous") {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("x402_settlement_ambiguous", {
          message: `Exact x402 settlement ${accepted.intentId} has an economically ambiguous outcome.`,
          extra: {
            settlement_intent_id: accepted.intentId,
            settlement_status: "ambiguous",
          },
        }),
        status: 503,
      },
    };
  }
  if (accepted.outcome === "rejected") {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("payment_invalid", {
          message: "x402 payment verification failed",
        }),
        status: 402,
        ...(args.x402Requirements && { x402Requirements: args.x402Requirements }),
      },
    };
  }
  if (accepted.replayed && !accepted.admissionPending && accepted.receipt.txHash) {
    return (
      mapLedgerCommitError(
        new ProcessedPaymentReplayError("x402", accepted.receipt.txHash),
        args.x402Requirements,
        true
      ) ?? {
        paidMsats: 0,
        receivedProofs: [],
      }
    );
  }
  const credited = accepted.committed;
  if (credited?.drawRefusal) {
    return creditLedgerErrorResult(credited.drawRefusal, args.x402Requirements, credited.deposit);
  }
  return withDrawBasis(
    {
      paidMsats,
      paymentRail: "x402",
      receivedProofs: [],
      paymentTxHash: accepted.receipt.txHash,
      paymentTransactionHash: accepted.receipt.txHash,
      nativeAmount: authorizedUsdcMicro,
      nativeAsset: "usdc",
      x402SettleResponseHeader: accepted.receipt.settleResponseHeader,
      ...(accepted.admissionPending &&
        accepted.effect?.jobId && {
          x402ExactAdmission: {
            intentId: accepted.intentId,
            jobId: accepted.effect.jobId,
            replayed: accepted.replayed,
          },
        }),
    },
    args.ledgerCtx,
    credited
  );
}

function exactSettlementEffect(
  ctx: LedgerContext,
  funding: { paidMsats: number; fundedMicro: number; nativeAmount: number }
): X402ExactSettlementEffect {
  return {
    priceFiat: ctx.priceFiat,
    requiredMsats: ctx.requiredMsats,
    callerId: ctx.callerId,
    dvmId: ctx.dvmId,
    jobId: ctx.jobId,
    hostingAdmissionId: ctx.hostingAdmissionId,
    hostingPaymentSeq: ctx.hostingPaymentSeq,
    jobAdmission: ctx.jobAdmission,
    creditEnvelope: ctx.creditEnvelope,
    fundOnly: ctx.fundOnly,
    topUp: ctx.topUp,
    topUpCapMicro: ctx.topUpCapMicro,
    askSatisfied: ctx.askSatisfied,
    midJob: ctx.midJob,
    drawBasis: ctx.drawBasis,
    ttlMs: ctx.ttlMs,
    ...funding,
  };
}

/**
 * The x402/mpp durable commit: processed-payment marker + fund +
 * draw in ONE transaction, keyed by the rail's payment id. A marker
 * collision throws {@link ProcessedPaymentReplayError} — crash-replay safe:
 * the second presentation of an already-processed payment funds nothing.
 */
async function commitMarkedFunding(
  ctx: LedgerContext,
  funding: RailFunding & { rail: "x402" | "tempo" },
  outerTx?: CreditLedgerQuerier
): Promise<CommittedFunding> {
  const store = ctx.processedPayments;
  if (!store) return fundAndDraw(ctx, funding, outerTx);
  const commit = async (tx?: CreditLedgerQuerier): Promise<CommittedFunding> => {
    const env = ctx.creditEnvelope;
    // A fund-only top-up has no draw; the marker's `drawId` column is really
    // "the operation this payment paid for", so the caller's `fund_id` goes
    // there. Reusing the column keeps the marker's PK semantics intact
    // without a DDL change.
    const creditId =
      ctx.fundOnly?.creditId ??
      ctx.topUp?.creditId ??
      env?.creditId ??
      implicitCreditId(funding.rail, funding.paymentId);
    const drawId = ctx.fundOnly?.fundId ?? ctx.topUp?.drawId ?? env?.drawId ?? funding.paymentId;
    await withPaymentStage("replay_store", () => store.record({
      dvmId: ctx.dvmId,
      rail: funding.rail,
      paymentId: funding.paymentId,
      creditId,
      drawId,
      jobId: ctx.jobId,
      tx,
    }));
    return fundAndDraw(ctx, funding, tx);
  };
  return outerTx ? commit(outerTx) : withPaymentStage("replay_store", () => store.withTx(commit));
}

async function commitMppFunding(
  ctx: LedgerContext,
  credential: MppxCredential,
  funding: RailFunding & { rail: "tempo" }
): Promise<CommittedFunding> {
  const session = mppSessionBasis(credential);
  if (session) {
    throw new CreditLedgerError(
      "invalid_basis",
      "Tempo session voucher acceptance requires the durable atomic channel store"
    );
  }
  return commitMarkedFunding(ctx, funding);
}

async function commitExactTempoVoucherFunding(
  ctx: LedgerContext,
  funding: RailFunding & { rail: "tempo" },
  voucherDelta: bigint,
  tx: CreditLedgerQuerier
): Promise<CommittedFunding> {
  if (funding.nativeAmount === undefined) {
    throw new CreditLedgerError("invalid_basis", "Tempo session funding has no native amount");
  }
  const expected = BigInt(funding.nativeAmount);
  // Zero is an idempotent replay: the processed-payment marker returns the
  // normal replay result. A newly accepted voucher must book its exact delta.
  if (voucherDelta !== 0n && voucherDelta !== expected) {
    throw new CreditLedgerError(
      "invalid_amount",
      `Tempo voucher delta ${voucherDelta} does not match required amount ${expected}`
    );
  }
  return commitMarkedFunding(ctx, funding, tx);
}

function paymentScheme(header: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepted?: { scheme?: unknown };
    };
    return typeof parsed.accepted?.scheme === "string" ? parsed.accepted.scheme : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Map a throw from the marked-funding commit into its `PaymentResult`, or
 * `undefined` for errors the caller should rethrow (unexpected — DB down,
 * bugs). Marker collisions become the 409 `replay_rejected` shape carrying
 * the payment id for the recovery gates; ledger refusals map to
 * their structured codes; an in-transaction draw replay becomes the
 * `replayedDraw` recovery shape.
 */
function mapLedgerCommitError(
  err: unknown,
  x402Requirements?: PaymentRequirements[],
  paymentCommitted = false
): PaymentResult | undefined {
  if (err instanceof ProcessedPaymentReplayError) {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        body: paymentErrorBody("replay_rejected", {
          message: `Payment ${err.paymentId} on rail ${err.rail} was already processed at this DVM.`,
        }),
        status: 409,
        replayPaymentId: err.paymentId,
        ...(x402Requirements && { x402Requirements }),
      },
    };
  }
  if (err instanceof ReplayedDrawError) {
    return {
      paidMsats: 0,
      receivedProofs: [],
      replayedDraw: { creditId: err.draw.creditId, drawId: err.draw.drawId, jobId: null },
    };
  }
  if (err instanceof CreditLedgerError) {
    return creditLedgerErrorResult(err, x402Requirements, undefined, paymentCommitted);
  }
  // a chain submission whose durable bookmark the settlement layer
  // will reconcile on the identical retry. 503 rather than 402, and deliberately
  // without `x402Requirements`: a challenge envelope is an instruction to sign
  // something new, and there is nothing new to sign — the caller's voucher is
  // intact and the retry is the identical request.
  if (err instanceof X402SettlementSubmissionError) {
    return {
      paidMsats: 0,
      receivedProofs: [],
      error: {
        // A fixed message plus the reason enum, never `err.message`: that string
        // is upstream's and may include the relay lock holder's
        // backend pid and `client_addr`. The detail is logged where the throw is.
        body: paymentErrorBody("x402_settlement_submission_failed", {
          message: "x402 batch settlement submission failed",
          extra: { settlement_error: err.errorReason },
        }),
        status: 503,
      },
    };
  }
  return undefined;
}

/** Map a {@link CreditLedgerError} onto the structured payment-error surface. */
function creditLedgerErrorResult(
  err: CreditLedgerError,
  x402Requirements?: PaymentRequirements[],
  funding?: CreditFundingReport,
  paymentCommitted = false
): PaymentResult {
  const code: PaymentErrorCode =
    err.code === "insufficient_credit" ||
    err.code === "credit_expired" ||
    err.code === "credit_unbacked" ||
    err.code === "credit_not_found" ||
    err.code === "tempo_channel_closing" ||
    err.code === "settlement_pending" ||
    err.code === "draw_conflict"
      ? err.code
      : "payment_invalid";
  if (code === "payment_invalid") logCreditRejected(err.code, undefined);
  // Wire naming: `remaining_micro` is the spendable figure the
  // caller acts on (the ledger's `availableMicro`); `balance_micro` is funded
  // balance with pending holds still counted. `shortfall_micro` saves every
  // caller the same subtraction before they can size a top-up.
  const extra: Record<string, unknown> = {};
  if (err.details.availableMicro !== undefined) {
    extra.remaining_micro = err.details.availableMicro;
    if (err.details.requestedMicro !== undefined) {
      extra.shortfall_micro = err.details.requestedMicro - err.details.availableMicro;
    }
  }
  if (err.details.balanceMicro !== undefined) extra.balance_micro = err.details.balanceMicro;
  if (err.details.expiryMs !== undefined) extra.expiry_ms = err.details.expiryMs;
  if (err.details.expectedRail !== undefined) extra.credit_rail = err.details.expectedRail;
  if (err.details.expectedInstrument !== undefined) {
    extra.credit_instrument = err.details.expectedInstrument;
  }
  if (err.details.expectedChannelId) extra.credit_channel_id = err.details.expectedChannelId;
  if (err.details.boundCreditId) extra.bound_credit_id = err.details.boundCreditId;
  // The handle the operator's repair verbs take. Safe to disclose: it is a
  // digest of an operation on the caller's own channel, and without it a caller
  // reporting the hold has nothing to name.
  if (err.details.settlementId) extra.settlement_id = err.details.settlementId;
  if (err.details.settlementStatus) extra.settlement_status = err.details.settlementStatus;
  // The hint above promises that "only re-sending the drain_id that was already
  // in flight goes through" and had no way to say which one. It is
  // the caller's own drain on their own credit, so naming it costs nothing and
  // is the difference between relayable advice and a riddle.
  if (err.details.blockingDrainId) extra.settlement_drain_id = err.details.blockingDrainId;
  if (funding) {
    extra.credit_id = funding.creditId;
    extra.credited_micro = funding.amountMicro;
    extra.credit_currency = funding.currency;
  }
  const retainedShortDeposit = funding && code === "insufficient_credit";
  const bindingMismatch = err.code === "rail_mismatch";
  return {
    paidMsats: 0,
    receivedProofs: [],
    error: {
      body: paymentErrorBody(code, {
        message: err.message,
        ...(retainedShortDeposit && {
          display:
            "The deposit was added to your prepaid balance with this service, but the total is still too low to cover the job. The job did not run.",
          hint: 'Top up credit_id by at least shortfall_micro, then retry the job against that credit. To reclaim the balance instead, use op "drain" at POST /v1/credit.',
        }),
        ...(bindingMismatch && {
          display: paymentCommitted
            ? "Your payment went through, but the service could not add it to the requested prepaid balance. The balance was not increased."
            : "The payment does not match this prepaid balance's funding instrument. Nothing was charged.",
          hint: paymentCommitted
            ? "Do not pay again or retry this payment. Contact the service operator to reconcile the completed payment against the credit binding named in this response."
            : "Do not retry this payment against this credit. Use the funding instrument named in this response, or open a separate credit.",
        }),
        extra,
      }),
      status:
        err.code === "draw_conflict" ||
        err.code === "tempo_channel_closing" ||
        err.code === "settlement_pending" ||
        bindingMismatch
          ? 409
          : 402,
      ...(funding && { funding }),
      ...(x402Requirements && { x402Requirements }),
    },
  };
}

/**
 * Refuse a top-up whose rail or funding instrument disagrees with the credit
 * it targets, or `undefined` when they agree — or when there is nothing yet to
 * disagree with: an unopened credit, or an artifact whose instrument this
 * preflight cannot read with certainty.
 *
 * `fund` is the authority on this rule, but it applies it from inside the rail
 * transaction — after the proofs swapped, after the facilitator settled — so
 * its rollback hands the caller nothing back for money that has already moved.
 * The preflights therefore check first, where a refusal is free, and each one
 * already holds the credit it passes in.
 *
 * A credit funded before rail basis was recorded is not exempt.
 * Its rail is unreadable, but `fund`'s upsert compares both channel columns
 * regardless of `credits.rail`, so a legacy row is bound exactly as tightly as
 * a modern one — and that half is checked here rather than left to strand
 * funds inside the rail transaction.
 */
function crossRailRefusal(
  credit: CreditSnapshot | undefined,
  args: { creditId: string; binding: IncomingCreditBinding }
): PaymentResult | undefined {
  if (!credit) return undefined;
  if (!credit.rail) return legacyChannelRefusal(credit, args);
  const expected = storedCreditBinding(credit);
  if (credit.rail !== args.binding.rail) {
    logCreditRejected("fund_rail_mismatch", args.creditId, {
      credit_rail: credit.rail,
      payment_rail: args.binding.rail,
    });
    return bindingRefusal(
      `Credit ${args.creditId} was funded on the ${credit.rail} rail; a ${args.binding.rail} top-up cannot be added to it. ` +
        `Top it up over ${credit.rail}, or omit credit_id to open a separate ${args.binding.rail} credit.`,
      { expected }
    );
  }
  if (!expected.instrument || !args.binding.instrument) return undefined;
  if (
    expected.instrument === args.binding.instrument &&
    (!expected.channelId || expected.channelId === args.binding.channelId)
  ) {
    return undefined;
  }
  logCreditRejected("fund_instrument_mismatch", args.creditId, {
    credit_rail: credit.rail,
    credit_instrument: expected.instrument,
    payment_instrument: args.binding.instrument,
    ...(expected.channelId ? { credit_channel_id: expected.channelId } : {}),
    ...(args.binding.channelId ? { payment_channel_id: args.binding.channelId } : {}),
  });
  return bindingRefusal(instrumentMismatchMessage(args.creditId, expected, args.binding), {
    expected,
  });
}

/**
 * The channel half of the binding rule, for a credit whose rail was never
 * recorded. Which channel a credit is bound to is a fact the row
 * carries whatever `credits.rail` says, so it is comparable here; the rail and
 * the instrument are not, and the refusal names neither rather than guessing.
 */
function legacyChannelRefusal(
  credit: CreditSnapshot,
  args: { creditId: string; binding: IncomingCreditBinding }
): PaymentResult | undefined {
  const incoming = incomingChannelColumns(args.binding);
  if (!incoming) return undefined;
  const stored = storedChannelColumns(credit);
  if (stored.tempo === incoming.tempo && stored.x402 === incoming.x402) return undefined;
  const bound = stored.x402
    ? ({ rail: "x402", instrument: "x402_channel", channelId: stored.x402 } as const)
    : stored.tempo
      ? ({ rail: "tempo", instrument: "tempo_session", channelId: stored.tempo } as const)
      : undefined;
  logCreditRejected("fund_instrument_mismatch", args.creditId, {
    payment_rail: args.binding.rail,
    ...(args.binding.instrument ? { payment_instrument: args.binding.instrument } : {}),
    ...(args.binding.channelId ? { payment_channel_id: args.binding.channelId } : {}),
    ...(bound ? { credit_rail: bound.rail, credit_channel_id: bound.channelId } : {}),
  });
  if (bound) {
    return bindingRefusal(
      `Credit ${args.creditId} is bound to ${bound.rail === "x402" ? "x402 settlement" : "Tempo session"} channel ${bound.channelId}; only that channel can top it up.`,
      { expected: bound }
    );
  }
  const channel = incoming.x402 ? "x402 settlement" : "Tempo session";
  return bindingRefusal(
    `Credit ${args.creditId} was not opened by a reusable ${channel} channel and cannot adopt one; omit credit_id to open a separate credit for this channel.`,
    { expected: {} }
  );
}

/**
 * The channel columns an attached artifact would write, or `undefined` when
 * its instrument is not readable with certainty — the rail verifier reports
 * that, and a preflight must not refuse on a guess.
 */
function incomingChannelColumns(
  binding: IncomingCreditBinding
): { tempo: string | null; x402: string | null } | undefined {
  if (binding.rail === "cashu") return { tempo: null, x402: null };
  if (!binding.instrument) return undefined;
  const reusable = binding.instrument === "tempo_session" || binding.instrument === "x402_channel";
  if (reusable && !binding.channelId) return undefined;
  return {
    tempo: binding.instrument === "tempo_session" ? (binding.channelId ?? null) : null,
    x402: binding.instrument === "x402_channel" ? (binding.channelId ?? null) : null,
  };
}

/**
 * The channel columns a credit row already carries, in the same lowercase form
 * {@link incomingChannelColumns} produces so the two compare directly. Readable
 * whatever `credits.rail` says — which is why the channel rungs apply to a
 * legacy rail-less row that the rail rung has nothing to say about.
 */
function storedChannelColumns(credit: CreditSnapshot): {
  tempo: string | null;
  x402: string | null;
} {
  return {
    tempo: credit.tempoChannelId?.toLowerCase() ?? null,
    x402: credit.x402ChannelId?.toLowerCase() ?? null,
  };
}

/** Refuse a reusable x402 channel that another credit already owns. */
async function crossCreditChannelRefusal(
  ledger: CreditLedgerLike,
  args: { creditId: string; binding: IncomingCreditBinding }
): Promise<PaymentResult | undefined> {
  if (args.binding.instrument !== "x402_channel" || !args.binding.channelId) return undefined;
  const bound = await ledger.getCreditByX402Channel(args.binding.channelId);
  if (!bound || bound.creditId === args.creditId) return undefined;
  logCreditRejected("fund_channel_bound_elsewhere", args.creditId, {
    credit_rail: "x402",
    credit_instrument: "x402_channel",
    credit_channel_id: args.binding.channelId,
    bound_credit_id: bound.creditId,
  });
  return bindingRefusal(
    `x402 channel ${args.binding.channelId} is already bound to credit ${bound.creditId}; it cannot fund ${args.creditId}.`,
    {
      expected: {
        rail: "x402",
        instrument: "x402_channel",
        channelId: args.binding.channelId,
      },
      boundCreditId: bound.creditId,
    }
  );
}

type CreditInstrument = NonNullable<CreditDepositPayload["instrument"]>;

interface IncomingCreditBinding {
  rail: "cashu" | "x402" | "tempo";
  instrument?: CreditInstrument;
  channelId?: string;
}

interface StoredCreditBinding {
  /** Absent only for a legacy credit funded before rail basis was recorded. */
  rail?: string;
  instrument?: CreditInstrument;
  channelId?: string;
}

/** Read the attached funding instrument without broadcasting or settling it. */
async function incomingCreditBinding(args: {
  rail: IncomingCreditBinding["rail"];
  x402Payment?: string;
  mppCredential?: string | MppxCredential;
}): Promise<IncomingCreditBinding> {
  if (args.rail === "cashu") return { rail: "cashu" };
  if (args.rail === "x402") {
    if (!args.x402Payment) return { rail: "x402" };
    if (paymentScheme(args.x402Payment) !== X402_BATCH_SETTLEMENT_SCHEME) {
      return { rail: "x402", instrument: "x402_exact" };
    }
    const channelId = x402ChannelId(args.x402Payment);
    return {
      rail: "x402",
      instrument: "x402_channel",
      ...(channelId ? { channelId } : {}),
    };
  }
  if (!args.mppCredential) return { rail: "tempo" };
  try {
    const credential =
      typeof args.mppCredential === "string"
        ? (await import("mppx")).Credential.deserialize(args.mppCredential)
        : args.mppCredential;
    if (!isMppSessionCredential(credential)) {
      return { rail: "tempo", instrument: "tempo_charge" };
    }
    const channelId = mppSessionChannelId(credential);
    return {
      rail: "tempo",
      instrument: "tempo_session",
      ...(channelId ? { channelId: channelId.toLowerCase() } : {}),
    };
  } catch {
    // The rail verifier will report the malformed credential. This preflight
    // only judges identity it can read with certainty.
    return { rail: "tempo" };
  }
}

function x402ChannelId(header: string): string | undefined {
  try {
    const envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      payload?: { voucher?: { channelId?: unknown } };
    };
    return typeof envelope.payload?.voucher?.channelId === "string"
      ? envelope.payload.voucher.channelId.toLowerCase()
      : undefined;
  } catch {
    return undefined;
  }
}

function storedCreditBinding(credit: CreditSnapshot): StoredCreditBinding {
  const rail = credit.rail;
  if (!rail) throw new Error("storedCreditBinding requires a credit rail");
  if (rail === "tempo") {
    return credit.tempoChannelId
      ? {
          rail,
          instrument: "tempo_session",
          channelId: credit.tempoChannelId.toLowerCase(),
        }
      : { rail, instrument: "tempo_charge" };
  }
  if (rail === "x402") {
    return credit.x402ChannelId
      ? {
          rail,
          instrument: "x402_channel",
          channelId: credit.x402ChannelId.toLowerCase(),
        }
      : { rail, instrument: "x402_exact" };
  }
  return { rail };
}

function bindingRefusal(
  message: string,
  args: {
    expected: StoredCreditBinding;
    boundCreditId?: string;
  }
): PaymentResult {
  return creditRefusal("payment_invalid", message, {
    status: 409,
    extra: {
      ...(args.expected.rail ? { credit_rail: args.expected.rail } : {}),
      ...(args.expected.instrument ? { credit_instrument: args.expected.instrument } : {}),
      ...(args.expected.channelId ? { credit_channel_id: args.expected.channelId } : {}),
      ...(args.boundCreditId ? { bound_credit_id: args.boundCreditId } : {}),
    },
    hint:
      args.expected.instrument === "tempo_session"
        ? "This credit must be topped up through its existing Tempo session channel. Do not send a one-shot charge."
        : undefined,
  });
}

function instrumentMismatchMessage(
  creditId: string,
  expected: StoredCreditBinding,
  incoming: IncomingCreditBinding
): string {
  if (expected.instrument === "tempo_session") {
    return `Credit ${creditId} is bound to Tempo session channel ${expected.channelId}; a ${incoming.instrument} top-up cannot be added to it.`;
  }
  if (expected.instrument === "tempo_charge") {
    return `Credit ${creditId} was opened by a one-shot Tempo charge; a reusable Tempo session cannot fund it.`;
  }
  if (expected.instrument === "x402_channel") {
    return `Credit ${creditId} is bound to x402 settlement channel ${expected.channelId}; an ${incoming.instrument} top-up cannot be added to it.`;
  }
  return `Credit ${creditId} was opened by an exact x402 payment; a reusable x402 channel cannot fund it.`;
}

/**
 * Flat refusal helper for the credit preflight — 402 unless the code says
 * otherwise. `extra` merges code-specific fields into the flat body (the
 * `paymentErrorBody` bag `remaining_micro` / `shortfall_micro` already ride);
 * `hint` overrides the code's shared copy where one site can say something
 * truer than the others (pre-commit corrective retry).
 */
function creditRefusal(
  code: PaymentErrorCode,
  message: string,
  opts?: { extra?: Record<string, unknown>; hint?: string; status?: number }
): PaymentResult {
  return {
    paidMsats: 0,
    receivedProofs: [],
    error: {
      body: paymentErrorBody(code, { message, extra: opts?.extra, hint: opts?.hint }),
      status: opts?.status ?? 402,
    },
  };
}

/** Refuse a one-payment stablecoin top-up before its credential can settle. */
function oneShotCreditRefusal(instrument: string): PaymentResult {
  return creditRefusal(
    "one_shot_credit_not_supported",
    `${instrument} is available for per-call payment, but this DVM accepts only reusable stablecoin channels for prepaid credit.`,
    { status: 409 }
  );
}

/** Structured log for credit refusals whose wire body stays generic. */
function logCreditRejected(
  reason: string,
  creditId: string | undefined,
  extra?: Record<string, unknown>
): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "credit_rejected",
      reason,
      credit_id: creditId,
      ...extra,
    }
  );
}

/**
 * Structured log for a Tempo session funding whose channel binding could not be
 * read — the deposit therefore reports no `tempoChannel` block, the
 * platform registers no channel, and the close observer never watches this
 * escrow. Nothing downstream errors, so this line is the whole signal.
 */
function logTempoBindingUnavailable(args: {
  channelId: string;
  creditId?: string;
  dvmId: string;
}): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "tempo_channel_binding_unavailable",
      channel_id: args.channelId,
      credit_id: args.creditId,
      dvm_id: args.dvmId,
    }
  );
}

/**
 * The request's BTC/USD rate, or `null` when the provider is down and this
 * process has never cached one. Null is the caller's cue to refuse
 * with {@link rateUnavailablePaymentError} — pricing a paid request at `0`
 * would give the work away, so an unpriceable request is refused, not
 * discounted.
 */
async function resolveRateOrNull(fetcher?: FxFetcher): Promise<number | null> {
  try {
    return (await resolveServerBtcUsdRate(fetcher)).rate;
  } catch {
    return null;
  }
}

/** `verifyUpfrontPayment`'s no-rate refusal, in its `PaymentResult` shape. */
function rateUnavailableResult(): PaymentResult {
  return { paidMsats: 0, receivedProofs: [], error: rateUnavailablePaymentError() };
}

/** Typed refusal shared by upfront and mid-job x402 acceptance gates. */
function x402NotOfferedPaymentError(currency?: string): PaymentErrorDetail {
  return {
    body: paymentErrorBody("x402_not_offered", {
      message: `x402 is offered only by USD-priced DVMs; this DVM prices in ${currency ?? "an unknown currency"}.`,
    }),
    status: 402,
  };
}

/** `verifyUpfrontPayment`'s currency refusal, in its `PaymentResult` shape. */
function x402NotOfferedResult(currency?: string): PaymentResult {
  return {
    paidMsats: 0,
    receivedProofs: [],
    error: x402NotOfferedPaymentError(currency),
  };
}

// Fixed categories identify failures without reflecting upstream exception text.
function logCredentialRejected(
  rail: "tempo" | "x402",
  phase: "upfront" | "mid-job",
  err: unknown
): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: `${rail}_credential_rejected`,
      phase,
      rail,
      ...paymentFailureFields(err),
    }
  );
}
