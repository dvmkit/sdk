import { diagnosticConsole } from "../../observability/diagnostic-console";
import { randomBytes } from "node:crypto";

import type { Context } from "hono";
import { Errors as MppxErrors } from "mppx";
import { z } from "zod";

import type { SignedRequestDomain } from "../../lib/signed-request-statement";
import { encodeSettleResponseHeader } from "../../lib/x402/spec";
import { isX402SettlementReconciliationReason } from "../../lib/x402/types";
import { loggers } from "../../observability/loggers";
import type { FxFetcher, FxRateSnapshot } from "../pricing/fx";
import { fiatToSatsCeil, fxRateFor } from "../pricing/index";
import type { ResolvedCreditConfig } from "../types";
import type { AppEnv } from "./app";
import { authErrorBody } from "./auth-error";
import { DrainRefundFloorError, refundFloorEvidence } from "./credit-drain-floor";
import type { DrainReportWiring } from "./credit-drain-report";
import type { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import { commitTerminalDrain } from "./credit-drain-report";
import { stablecoinCreditInstrumentAllowed } from "./credit-funding-policy";
import type {
  CreditDrainRecord,
  CreditInvoiceRecord,
  CreditLedgerLike,
  CreditSnapshot,
  DrainConflictReason,
  DrainMethod,
  DrainReleaseResult,
} from "./credit-ledger";
import {
  CreditLedgerError,
  DRAIN_METHODS,
  isDrainMethod,
  isFundingRail,
  x402SettlementPending,
} from "./credit-ledger";
import type { CreditMenu } from "./credit-menu";
import { lightningFloorMicro } from "./credit-menu";
import { derivedFundCreditId, isDerivedCreditId } from "./funding";
import { fundingReceiptFor } from "./funding-receipt";
import type { LightningReceive } from "./lightning-receive";
import type { TempoSessionDrainState } from "./mpp-setup";
import type { PaymentErrorDetail, PaymentInfo, UpfrontPaymentOpts } from "./payment";
import {
  buildPaymentErrorResponse,
  paymentErrorBody,
  TempoSessionChannelMismatchError,
  verifyTempoSessionManagementCredential,
  verifyUpfrontPayment,
} from "./payment";
import type { ReceiptIssuer } from "./receipt-issuer";
import type { DVMAuthScheme } from "./secp256k1-auth";
import type { CanonicalEnvelope } from "./signed-request";
import { SignedRequestError } from "./signed-request";
import type { TempoDrainRail } from "./tempo-drain-leg";
import { completeTempoChannelDrain, tempoCloseRefund } from "./tempo-drain-leg";
import {
  isTempoInsufficientFundsError,
  type TempoSettlementReadiness,
} from "./tempo-settlement-readiness";
import {
  X402_SPEND_BLOCKING_SETTLEMENT_STATUSES,
  X402_WEDGED_SETTLEMENT_STATUSES,
} from "./x402-channel-store";
import { completeX402ChannelDrain } from "./x402-drain-leg";

/**
 * Schema hints point at the credit reference; /v1/info describes capability job input, not
 * this signed operation schema.
 */
const CREDIT_SCHEMA_DOC_URL = "https://dvmkit.com/docs/protocol#post-v1credit";

/**
 * Authenticate the raw body, including op. Its schema is independent of job-input credit/draw
 * envelopes; normal job schema projection must not define this wire contract.
 */
export const CREDIT_REQUEST_SCHEMA = z.object({
  op: z.enum(["fund", "balance", "drain"]),
  credit_id: z.string().min(1).optional(),
  fund: z
    .object({
      amount_micro: z.number().int().positive(),
      /** Client-generated idempotency key — a retry with the same id credits once. */
      fund_id: z.string().min(1),
      /**
       * SHA-256 hex over the raw funding artifact (the funding-commitment rule).
       * Required for every attach rail; absent on `method: "lightning"`, which
       * carries no caller-supplied artifact to hash — see {@link CreditRequest}.
       */
      commitment: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      /**
       * Lightning names an invoice request; MPP names the charge/session
       * intent before a credential exists, so a bound credit can refuse the
       * wrong instrument before issuing or broadcasting anything.
       */
      method: z.enum(["lightning", "tempo"]).optional(),
      /** Required with `method: "tempo"`; invalid on every other funding rail. */
      intent: z.enum(["charge", "session"]).optional(),
    })
    .optional(),
  drain: z
    .object({
      /** Client-generated idempotency key — the same id polls/collects one drain. */
      drain_id: z.string().min(1),
      /**
       * Required on a fresh drain, optional on poll. Keep this a string so an unsupported
       * rail receives its specific typed refusal before payout-shape validation.
       */
      method: z.string().min(1).optional(),
      /**
       * Method-specific payout target, signature-covered like everything
       * else in this body: `refund_pubkey` (cashu — 33-byte compressed key
       * the parked notes are P2PK-locked to; the caller's auth pubkey is
       * x-only, so it cannot be inferred) or `address` (x402/mpp). Required
       * with `method`.
       */
      payout: z
        .object({
          refund_pubkey: z.string().optional(),
          address: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
  pubkey: z.string(),
  signature: z.string(),
  timestamp: z.number(),
  nonce: z.string(),
});

export type CreditRequest = z.infer<typeof CREDIT_REQUEST_SCHEMA>;

export interface CreditRouteDeps {
  hostedSettlementReports?: HostedSettlementReportObligations;
  menu: () => Promise<CreditMenu | undefined>;
  creditConfig: ResolvedCreditConfig | undefined;
  auth: DVMAuthScheme | undefined;
  /** Exact `/v1/credit` audience and operation expected by the auth gate. */
  authDomain?: SignedRequestDomain;
  ledger: CreditLedgerLike;
  fxFetcher: FxFetcher;
  railOpts: (c: Context<AppEnv>) => Promise<UpfrontPaymentOpts>;
  /**
   * Report committed fund-only top-ups as deposits. They have no job terminal to book the
   * liability; replay must not report it twice.
   */
  onDeposit: (funding: NonNullable<PaymentInfo["funding"]>) => void;
  /**
   * Optional terminal drain report wiring: Cashu pickup and channel completion commit their
   * ledger transition with its report.
   */
  drainReport: DrainReportWiring;
  /**
   * Optional signer for reclaim observations. The ledger transition remains authoritative;
   * signature issuance happens after commit and may fail separately.
   */
  receiptIssuer: ReceiptIssuer | undefined;
  /**
   * Optional receive-only Lightning funding leg. Issuance uses the wallet; polling uses the
   * shared settlement hook. An absent leg refuses method:lightning.
   */
  lightning: { receive: LightningReceive } | undefined;
  /**
   * Apply any Lightning invoice this caller has paid since the last check, and
   * book the deposit for each one that credits. A no-op when the
   * rail isn't configured. Runs before the read ops so a balance reflects a
   * top-up that settled out of band, and behind the fund poll so a sibling
   * invoice on the same credit is swept with it.
   */
  settleLightning: (callerPubkey: string, creditId?: string) => Promise<void>;
  /** Hosting gate around a fresh funding operation, after caller auth and before any rail effect. */
  withFundingAdmission?: (c: Context<AppEnv>, body: CreditRequest, run: () => Promise<Response>) => Promise<Response>;
  tempoSettlementReadiness?: TempoSettlementReadiness;
}

export async function handleCreditRequest(
  c: Context<AppEnv>,
  deps: CreditRouteDeps
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(
      {
        error: "invalid_request",
        message: "Request body is not valid JSON.",
        hint: 'Send a JSON object: { "op": "balance" | "fund" | "drain", … } signed with the request envelope.',
      },
      400
    );
  }

  const menu = await deps.menu();
  if (!menu || !deps.auth) {
    return c.json(
      paymentErrorBody("credit_not_supported", {
        message: "This DVM does not advertise prepaid credit.",
      }),
      501
    );
  }

  let envelope: CanonicalEnvelope;
  let body: CreditRequest;
  try {
    const result = deps.auth.checkAuth(CREDIT_REQUEST_SCHEMA, raw, deps.authDomain);
    envelope = result.envelope;
    body = result.envelope as unknown as CreditRequest;
  } catch (err) {
    if (err instanceof SignedRequestError) {
      return c.json(authErrorBody(err, { schemaUrl: CREDIT_SCHEMA_DOC_URL }), 401);
    }
    throw err;
  }
  const callerPubkey = envelope.pubkey;

  switch (body.op) {
    case "balance": {
      // Burn the nonce up front. `/v1/job` (and the fund op below) defer it
      // only because an unpaid submit has to be resubmittable with the same
      // envelope after the 402 discovery hop; a read and a stub have no such
      // hop, so deferring would just leave them replayable inside the drift
      // window.
      const rejected = await burnNonce(c, deps, envelope);
      if (rejected) return rejected;
      await deps.settleLightning(callerPubkey, body.credit_id);
      return handleBalance(c, deps, { callerPubkey, creditId: body.credit_id, menu });
    }
    case "drain":
      await deps.settleLightning(callerPubkey, body.credit_id);
      return handleDrain(c, deps, { callerPubkey, body, envelope });
    case "fund":
      if (deps.withFundingAdmission && body.fund) {
        const creditId = body.credit_id ?? derivedFundCreditId(callerPubkey, body.fund.fund_id);
        const [prior, invoice] = await Promise.all([
          deps.ledger.getFunding({ creditId, fundId: body.fund.fund_id }),
          body.fund.method === "lightning"
            ? deps.ledger.getInvoice({ creditId, fundId: body.fund.fund_id })
            : Promise.resolve(undefined),
        ]);
        const priorCredit = prior ? await deps.ledger.get(creditId) : undefined;
        if (priorCredit?.callerPubkey === callerPubkey || invoice?.callerPubkey === callerPubkey) {
          return handleFund(c, deps, { callerPubkey, body, envelope, menu });
        }
        return deps.withFundingAdmission(c, body, () => handleFund(c, deps, { callerPubkey, body, envelope, menu }));
      }
      return handleFund(c, deps, { callerPubkey, body, envelope, menu });
  }
}

async function handleBalance(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { callerPubkey: string; creditId?: string; menu: CreditMenu }
): Promise<Response> {
  let all = await deps.ledger.getForCaller(args.callerPubkey);
  const pendingChannels = new Set<string>();
  const active = args.creditId ? all.filter((credit) => credit.creditId === args.creditId) : all;
  const tempoChannels = [
    ...new Set(
      active
        .filter((credit) => credit.status === "active")
        .map((credit) => credit.tempoChannelId)
        .filter((channelId): channelId is string => channelId !== null)
    ),
  ];
  const x402Channels = [
    ...new Set(
      active
        .filter((credit) => credit.status === "active")
        .map((credit) => credit.x402ChannelId)
        .filter((channelId): channelId is string => channelId !== null)
    ),
  ];
  if (tempoChannels.length > 0 || x402Channels.length > 0) {
    const rails = await deps.railOpts(c);
    const mpp = rails.mpp;
    for (const channelId of tempoChannels) {
      if (!mpp?.getTempoSessionDrainState) {
        pendingChannels.add(channelId);
        continue;
      }
      try {
        await mpp.getTempoSessionDrainState(channelId);
      } catch {
        pendingChannels.add(channelId);
      }
    }
    for (const channelId of x402Channels) {
      try {
        await rails.x402BatchSettlement?.observeChannel(channelId);
      } catch {
        // A balance read remains available while the facilitator is down. The
        // ledger stays active until a later observation can prove the backing
        // exited; no failure is evidence that it did.
      }
    }
    all = await deps.ledger.getForCaller(args.callerPubkey);
  }
  if (args.creditId) {
    const one = all.find((credit) => credit.creditId === args.creditId);
    if (!one) {
      return c.json(
        paymentErrorBody("credit_not_found", {
          message: `No credit ${args.creditId} for this caller.`,
        }),
        404
      );
    }
    return c.json({
      op: "balance",
      credit: creditBody(one, pendingChannels.has(one.tempoChannelId ?? "")),
      credits: [creditBody(one, pendingChannels.has(one.tempoChannelId ?? ""))],
      menu: args.menu,
    });
  }
  const primary = pickPrimary(all, args.menu.currency);
  return c.json({
    op: "balance",
    // Keep expired credit records visible. Nominal expiry alone does not release ownership;
    // an expiry sweep can later zero the undrawn balance.
    credits: all.map((credit) =>
      creditBody(credit, pendingChannels.has(credit.tempoChannelId ?? ""))
    ),
    ...(primary
      ? { credit: creditBody(primary, pendingChannels.has(primary.tempoChannelId ?? "")) }
      : {}),
    menu: args.menu,
  });
}

/**
 * Reserve available balance as a reclaim liability; terminal pickup or channel completion
 * discharges it. Nominal expiry alone does not prevent reclaim before the expiry sweep
 * commits. Channel closes require all holds to finish; push refunds may leave held jobs
 * outstanding.
 */
async function handleDrain(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { callerPubkey: string; body: CreditRequest; envelope: CanonicalEnvelope }
): Promise<Response> {
  const { body } = args;
  const drain = body.drain;
  if (!body.credit_id || !drain) {
    const rejected = await burnNonce(c, deps, args.envelope);
    if (rejected) return rejected;
    return c.json(
      {
        error: "invalid_request",
        message: 'op "drain" requires credit_id and a `drain` block.',
        hint: "Send credit_id plus drain: { drain_id, method, payout } to request a reclaim, or drain: { drain_id } to poll one.",
      },
      400
    );
  }
  const creditId = body.credit_id;

  const credit = await deps.ledger.get(creditId);
  if (credit?.callerPubkey !== args.callerPubkey) {
    const rejected = await burnNonce(c, deps, args.envelope);
    if (rejected) return rejected;
    return c.json(
      paymentErrorBody("credit_not_found", {
        message: `No credit ${creditId} for this caller.`,
      }),
      404
    );
  }
  if (credit.status === "unbacked") {
    const rejected = await burnNonce(c, deps, args.envelope);
    if (rejected) return rejected;
    return jsonPaymentError("credit_unbacked", 409, {
      message: `Credit ${creditId} is terminal because its Tempo backing finalized before the DVM was protected.`,
    });
  }

  let existing = await deps.ledger.getDrain({ creditId, drainId: drain.drain_id });
  if (existing) {
    // Only a *channel* poll has a discovery hop to spare the nonce for: the
    // caller comes back unauthenticated to collect a close challenge. A
    // charge-funded credit has no challenge to collect, so its poll is an
    // ordinary signed read and burns its nonce like every other one.
    const tempoDiscovery =
      existing.method === "tempo" &&
      existing.status === "pending" &&
      drain.method === "tempo" &&
      !!credit.tempoChannelId &&
      !c.req.header("Authorization");
    if (!tempoDiscovery) {
      const rejected = await burnNonce(c, deps, args.envelope);
      if (rejected) return rejected;
    }
    // A poll’s re-stated method and payout must equal the recorded destination. Ignoring a
    // new destination could pay one the caller now disavows.
    if (
      (drain.method && drain.method !== existing.method) ||
      (drain.payout && !payoutMatches(existing, drain.payout))
    ) {
      return jsonPaymentError("drain_conflict", 409, {
        message: `drain ${drain.drain_id} was recorded with a different method or payout.`,
      });
    }
    if (credit.tempoChannelId && existing.method !== "tempo" && existing.status === "pending") {
      const released = await releaseTempoDrain(c, deps, existing, credit.tempoChannelId);
      return respondDrain(c, deps, { record: released, credit });
    }
    if (existing.method === "tempo" && existing.status === "pending" && credit.tempoChannelId) {
      if (credit.balanceMicro !== credit.availableMicro) {
        const released = await releaseTempoDrain(c, deps, existing, credit.tempoChannelId);
        return respondDrain(c, deps, { record: released, credit });
      }
      if (!c.req.header("Authorization")) {
        return issueTempoCloseChallenge(c, deps, credit.tempoChannelId, { existing, credit });
      }
      const completed = await completeTempoDrain(c, deps, existing, credit.tempoChannelId, credit);
      if (isHttpResponse(completed)) return completed;
      existing = completed;
    }
    return respondDrain(c, deps, { record: await deliverIfParked(deps, existing), credit });
  }

  if (credit.tempoChannelId && drain.method !== "tempo") {
    const rejected = await burnNonce(c, deps, args.envelope);
    if (rejected) return rejected;
    return channelDrainMethodConflictResponse("Tempo");
  }

  if (credit.x402ChannelId) {
    if (drain.method !== "x402") {
      const rejected = await burnNonce(c, deps, args.envelope);
      if (rejected) return rejected;
      return channelDrainMethodConflictResponse("x402");
    }
    return handleX402ChannelDrain(c, deps, {
      callerPubkey: args.callerPubkey,
      envelope: args.envelope,
      credit,
      drainId: drain.drain_id,
    });
  }

  // Charge-funded Tempo credit has no channel challenge. Unauthenticated drain discovery is
  // valid only for channel-backed credit.
  if (drain.method === "tempo" && credit.tempoChannelId && !c.req.header("Authorization")) {
    return issueTempoCloseChallenge(c, deps, credit.tempoChannelId);
  }

  const rejected = await burnNonce(c, deps, args.envelope);
  if (rejected) return rejected;

  const target = validateDrainTarget(drain);
  if ("error" in target) return c.json(target.error, 400);
  // Refuse an incompatible funding rail before asking for that rail’s payout shape.
  const railMismatch = railMismatchRefusal(credit, target.method);
  if (railMismatch) return c.json(railMismatch, 400);
  // One-shot stablecoin refunds require an explicit signed payout address. A reusable channel
  // instead returns undrawn collateral to its bound payer.
  const tempoChargeDrain = target.method === "tempo" && !credit.tempoChannelId;
  if (tempoChargeDrain && !target.payout.address) {
    return c.json(
      {
        error: "invalid_request",
        message:
          "This credit was funded by a one-off Tempo charge, not a session channel, so its refund needs somewhere to be sent.",
        hint: "Send drain.payout.address (the Tempo address to refund to) — 'dvm credit drain <dvm> --method tempo --address 0x…', which defaults to your connected Tempo wallet. '--method cashu' also reclaims this balance, as ecash locked to your wallet's key.",
      },
      400
    );
  }

  const tempoMpp = target.method === "tempo" ? (await deps.railOpts(c)).mpp : undefined;
  const tempoCloseReservation =
    target.method === "tempo" && credit.tempoChannelId && tempoMpp?.withTempoSessionCloseIntent
      ? {
          channelId: credit.tempoChannelId,
          reserve: tempoMpp.withTempoSessionCloseIntent.bind(tempoMpp),
        }
      : undefined;
  if (target.method === "tempo" && credit.tempoChannelId && !tempoCloseReservation) {
    return jsonPaymentError("payment_invalid", 402, {
      message: "Tempo session close persistence is unavailable at this DVM.",
    });
  }

  try {
    const request = (tx?: Parameters<CreditRouteDeps["ledger"]["requestDrain"]>[0]["tx"]) =>
      deps.ledger.requestDrain({
        creditId,
        drainId: drain.drain_id,
        callerPubkey: args.callerPubkey,
        method: target.method,
        payout: target.payout,
        // A cooperative close forecloses the holds it leaves behind, so it
        // refuses atomically while any exists. A push refund doesn't: it takes
        // the available balance and leaves running jobs their money.
        requireNoPending: target.method === "tempo" && !!credit.tempoChannelId,
        tx,
      });
    const result = tempoCloseReservation
      ? await tempoCloseReservation.reserve(
          tempoCloseReservation.channelId,
          drain.drain_id,
          request
        )
      : await request();
    let record = result.drain;
    if (!result.replayed && deps.receiptIssuer) {
      record = await countersignDrain(deps, record, "requested");
    }
    record = await deliverIfParked(deps, record);
    if (!result.replayed && target.method === "tempo" && credit.tempoChannelId) {
      const completed = await completeTempoDrain(
        c,
        deps,
        record,
        credit.tempoChannelId,
        result.credit
      );
      if (isHttpResponse(completed)) return completed;
      record = completed;
    }
    return await respondDrain(c, deps, { record, credit: result.credit });
  } catch (err) {
    if (err instanceof CreditLedgerError) {
      return drainLedgerErrorResponse(err, creditId, drain.drain_id);
    }
    if (
      target.method === "tempo" &&
      err instanceof Error &&
      err.message.includes("already closing for another drain")
    ) {
      return jsonPaymentError("drain_conflict", 409, {
        message: err.message,
        extra: { drain_registered: false },
      });
    }
    throw err;
  }
}

async function issueTempoCloseChallenge(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  channelId: string,
  opts?: { existing: CreditDrainRecord; credit: CreditSnapshot }
): Promise<Response> {
  const rail = await deps.railOpts(c);
  const mpp = rail.mpp;
  if (!mpp?.getTempoSessionSpent || !menuHasTempoSession(await deps.menu())) {
    return jsonPaymentError("payment_invalid", 402, {
      message: "Tempo session close is not available at this DVM.",
    });
  }
  try {
    const state = mpp.getTempoSessionDrainState
      ? await mpp.getTempoSessionDrainState(channelId)
      : {
          spent: await mpp.getTempoSessionSpent(channelId),
          settledOnChain: 0n,
          closeRequestedAt: 0n,
          deposit: 1n,
          finalized: false,
        };
    const unclosable = state.finalized || state.deposit === 0n || state.closeRequestedAt !== 0n;
    const closeAmount = maxBigInt(state.spent, state.settledOnChain);
    if (unclosable || closeAmount === 0n) {
      if (opts) {
        const forecastResolution = await mpp.resolveTempoSessionCloseForecast?.(
          channelId,
          opts.existing.drainId,
          "proceed"
        );
        // A durable reservation means this drain already extinguished the
        // ledger balance. Once the channel has begun or completed another
        // terminal path, recovery owns the answer: releasing here could add
        // ledger value after the external refund landed. `missing` preserves
        // the legacy/unreserved fallback (and an idempotent concurrent release).
        if (forecastResolution && forecastResolution.outcome !== "missing") {
          const recovered = await recoverTempoDrain(deps, mpp, opts.existing, channelId);
          if (recovered) {
            if (isHttpResponse(recovered)) return recovered;
            return await respondDrain(c, deps, { record: recovered, credit: opts.credit });
          }
          return jsonPaymentError("payment_invalid", 402, {
            message: "The Tempo channel exit is still being reconciled; retry this drain.",
            hint: `Retry drain ${opts.existing.drainId}; do not request another close credential.`,
          });
        }
        const released = await releaseTempoDrain(c, deps, opts.existing, channelId);
        return await respondDrain(c, deps, { record: released, credit: opts.credit });
      }
      return jsonPaymentError("tempo_channel_exit_required", 409, {
        message:
          closeAmount === 0n
            ? "A zero-consumption Tempo channel cannot issue a non-zero cooperative close challenge."
            : "This Tempo channel has already started or completed its on-chain exit.",
        extra: { drain_registered: false, channel_id: channelId },
      });
    }
    const amount = formatTempoAmount(closeAmount);
    const challenge = await mpp.issueChallenge("tempo", "session", {
      amount,
      suggestedDeposit: amount,
      unitType: "request",
      meta: { path: c.req.path, nonce: randomBytes(16).toString("hex") },
    });
    return buildPaymentErrorResponse(
      paymentErrorBody("payment_invalid", {
        message: opts
          ? "The saved Tempo session close credential is no longer valid; attach a fresh credential for this same drain."
          : "Attach a Tempo session close credential to complete this drain.",
        ...(opts && {
          display:
            "The saved close approval expired or belongs to an older service deployment. No close was broadcast and your existing reclaim remains registered.",
          hint: `Sign the fresh Tempo close challenge and submit drain ${opts.existing.drainId} again. Keep the same drain_id and channel.`,
          retryable: true,
          extra: {
            credential_refresh_required: true,
            drain_registered: true,
            drain_id: opts.existing.drainId,
          },
        }),
      }),
      [challenge]
    );
  } catch (error) {
    loggers.tempo.warn("tempo_session_close_challenge_failed", {
      channel_id: channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonPaymentError("payment_invalid", 402, {
      message: "The Tempo session close state could not be reconciled; retry this drain.",
      hint: "Retry the same drain after the service can read Tempo chain state.",
    });
  }
}

function formatTempoAmount(raw: bigint): string {
  const scale = 1_000_000n;
  return `${raw / scale}.${(raw % scale).toString().padStart(6, "0")}`;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

async function completeTempoDrain(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  record: CreditDrainRecord,
  expectedChannelId: string | null,
  credit: CreditSnapshot
): Promise<CreditDrainRecord | Response> {
  const rail = await deps.railOpts(c);
  if (!rail.mpp || !expectedChannelId) {
    return jsonPaymentError("payment_invalid", 402, {
      message: "This prepaid credit was not funded through a recoverable Tempo stablecoin channel.",
    });
  }
  const forecastRefusal = await refuseShortTempoDrainForecast(
    deps,
    rail.mpp,
    record,
    expectedChannelId
  );
  if (forecastRefusal) return forecastRefusal;
  const recovered = await recoverTempoDrain(deps, rail.mpp, record, expectedChannelId);
  if (recovered) return recovered;
  if (
    !rail.mppCredential ||
    typeof rail.mppCredential !== "string" ||
    !rail.mpp.beginTempoSessionClose ||
    !rail.mpp.confirmTempoSessionClose
  ) {
    return jsonPaymentError("payment_invalid", 402, {
      message: "Draining a Tempo-backed credit requires a Tempo session close credential.",
    });
  }
  const beginClose = rail.mpp.beginTempoSessionClose.bind(rail.mpp);
  let recoveryVersion: string | undefined;
  let hostedObligationId: string | undefined;
  try {
    const closed = await verifyTempoSessionManagementCredential({
      credential: rail.mppCredential,
      mpp: rail.mpp,
      resourcePath: c.req.path,
      action: "close",
      expectedChannelId,
      preflightBeforeBound: !!deps.hostedSettlementReports,
      // Reassert the intent only after the verifier binds the credential to this channel, and
      // before broadcast. A wrong-channel signature cannot create or cancel its close intent.
      onBound: async () => {
        await beginClose(expectedChannelId, record.drainId);
        recoveryVersion = await deps.tempoSettlementReadiness?.captureRecoveryVersion();
        if (deps.hostedSettlementReports) {
          hostedObligationId = await reserveHostedTempoClose(
            deps.hostedSettlementReports, rail.mpp!, record, expectedChannelId
          );
          if (!rail.mpp?.permitHostedTempoClose) {
            throw new Error("Hosted Tempo close credential guard is unavailable");
          }
          rail.mpp.permitHostedTempoClose(rail.mppCredential!, hostedObligationId);
        }
      },
    });
    if (hostedObligationId) {
      await deps.hostedSettlementReports?.recordSubmitted(hostedObligationId, closed.reference);
    }
    // Persist the confirmed transaction hash before the floor’s chain read. If that read
    // fails, recovery needs the real hash; starting again from zero would lose it.
    const reference = await rail.mpp.confirmTempoSessionClose(
      expectedChannelId,
      record.drainId,
      closed.reference
    );
    await deps.tempoSettlementReadiness?.recordSuccessfulTransaction(recoveryVersion);
    return await markTempoDrainSent(deps, rail.mpp, record, closed.channelId, reference);
  } catch (error) {
    if (isTempoInsufficientFundsError(error)) {
      await deps.tempoSettlementReadiness?.recordInsufficientFunds({
        operation: "close",
        channelId: expectedChannelId,
        creditId: record.creditId,
        drainId: record.drainId,
      });
    }
    // A credential signed for another channel is a terminal answer about the
    // caller's own signature, decided before any chain state was read — so it
    // is answered above the ladder rather than falling through it.
    const wrongChannel = tempoWrongChannelRefusal(error, record);
    if (wrongChannel) return wrongChannel;
    if (error instanceof HostedTempoCloseAttemptsExhaustedError) {
      return jsonPaymentError("tempo_channel_exit_required", 409, {
        message: `Tempo drain ${record.drainId} reached its limit of cooperative close attempts that never reached the chain.`,
        display:
          "The service could not complete a cooperative close of this stablecoin channel after several attempts. Your funds stay in the channel; use the timed on-chain exit to recover them.",
        hint: "Start the channel's timed on-chain exit. Retrying this drain with another close credential is refused.",
        extra: { drain_registered: true, drain_id: record.drainId, channel_id: expectedChannelId },
      });
    }
    // A refund short of the debit is a terminal answer about money, not one of
    // the ambiguous close failures the ladder below reconciles — it must never
    // reach the release arm, which would re-credit a balance the chain has
    // already partly refunded.
    const refused = tempoFloorRefusal(error, record);
    if (refused) return refused;
    // The caller retains its close credential across retries, but embedded challenges expire
    // or rotate. Refresh the challenge for the same held drain instead of releasing and
    // debiting again.
    if (tempoCloseCredentialNeedsRefresh(error)) {
      loggers.tempo.warn("tempo_close_credential_refresh_required", {
        credit_id: record.creditId,
        drain_id: record.drainId,
        error: error instanceof Error ? error.message : String(error),
      });
      return issueTempoCloseChallenge(c, deps, expectedChannelId, { existing: record, credit });
    }
    loggers.tempo.warn("tempo_session_close_failed", {
      credit_id: record.creditId,
      drain_id: record.drainId,
      error: error instanceof Error ? error.message : String(error),
    });
    try {
      const state = await rail.mpp.getTempoSessionDrainState?.(expectedChannelId);
      if (state?.finalized || state?.deposit === 0n) {
        const recovered = await rail.mpp.recoverTempoSessionClose?.(
          expectedChannelId,
          record.drainId
        );
        if (recovered) {
          return await markTempoDrainSent(deps, rail.mpp, record, expectedChannelId, recovered);
        }
      }
      // A submitted close may still land after a receipt wait times out, so an
      // open snapshot alone never authorizes re-credit. Release only when the
      // chain already chose unilateral exit, or mppx observed a reverted
      // receipt (definitive non-payment); every ambiguous failure stays
      // pending for recoverTempoSessionClose to reconcile on the next poll.
      if (state && (state.closeRequestedAt !== 0n || isDefinitiveTempoCloseFailure(error))) {
        return await releaseTempoDrain(c, deps, record, expectedChannelId);
      }
    } catch (reconcileError) {
      const refusedOnRecovery = tempoFloorRefusal(reconcileError, record);
      if (refusedOnRecovery) return refusedOnRecovery;
      loggers.tempo.warn("tempo_session_close_failure_reconcile_failed", {
        credit_id: record.creditId,
        drain_id: record.drainId,
        error: reconcileError instanceof Error ? reconcileError.message : String(reconcileError),
      });
    }
    return jsonPaymentError("payment_invalid", 402, {
      message: "The Tempo session close outcome is still being reconciled.",
      display:
        "The service could not yet prove whether the stablecoin channel closed. Your reclaim is still pending; no second reclaim was created.",
      hint: `Retry this same drain ${record.drainId}. The caller will replay its saved close authorization; do not create a replacement drain or channel.`,
      extra: { drain_registered: true, drain_id: record.drainId },
    });
  }
}

/**
 * How old an unsubmitted hosted close reservation must be before another
 * attempt may retire it. It matches the Tempo settlement lease, above mppx's
 * 180-second receipt wait. It is not a bound on how long an attempt runs: RPC
 * retries before the broadcast can carry one past it, and such an attempt's
 * landed close is recorded on the successor reservation.
 */
const HOSTED_TEMPO_CLOSE_STALE_MS = 300_000;
/** Retired attempts per drain before cooperative close is refused for it. */
const HOSTED_TEMPO_CLOSE_MAX_RELEASES = 3;
const HOSTED_TEMPO_CLOSE_IN_FLIGHT = "Hosted Tempo close already has an original effect attempt";

class HostedTempoCloseAttemptsExhaustedError extends Error {}

/**
 * Reserve the hosted close obligation this attempt broadcasts under.
 *
 * An earlier attempt that failed before recording a transaction (mppx's own
 * verify failing on a chain read, or a receipt wait that gave up) leaves its
 * reservation behind. Once it is older than the receipt wait and the chain
 * still shows the channel open, it is retired and replaced in one
 * transaction. The successor stays outstanding for the same drain, so a late
 * landing of the earlier close is recorded on it and reported once; the chain
 * closes the channel only once.
 */
async function reserveHostedTempoClose(
  reports: HostedSettlementReportObligations,
  mpp: NonNullable<UpfrontPaymentOpts["mpp"]>,
  record: CreditDrainRecord,
  channelId: string
): Promise<string> {
  const pending = await reports.pendingTempoClose(channelId, record.drainId);
  if (!pending) {
    const reserved = await reports.reserveTempo(channelId, "close", record.drainId);
    if (reserved.replayed) throw new Error(HOSTED_TEMPO_CLOSE_IN_FLIGHT);
    return reserved.id;
  }
  if (pending.txHash || !mpp.getTempoSessionDrainState) throw new Error(HOSTED_TEMPO_CLOSE_IN_FLIGHT);
  const state = await mpp.getTempoSessionDrainState(channelId);
  if (state.finalized || state.deposit === 0n || state.closeRequestedAt !== 0n) {
    throw new Error(HOSTED_TEMPO_CLOSE_IN_FLIGHT);
  }
  const result = await reports.releaseStaleTempoClose(pending.id, channelId, record.drainId, {
    staleAfterMs: HOSTED_TEMPO_CLOSE_STALE_MS,
    maxReleases: HOSTED_TEMPO_CLOSE_MAX_RELEASES,
  });
  if (result.outcome === "in_flight") throw new Error(HOSTED_TEMPO_CLOSE_IN_FLIGHT);
  if (result.outcome === "exhausted") {
    loggers.tempo.warn("tempo_session_close_attempts_exhausted", {
      credit_id: record.creditId,
      drain_id: record.drainId,
      channel_id: channelId,
      obligation_id: pending.id,
      attempt: result.releases + 1,
    });
    throw new HostedTempoCloseAttemptsExhaustedError(
      `Tempo drain ${record.drainId} exhausted its cooperative close attempts`
    );
  }
  loggers.tempo.warn("tempo_session_close_reservation_released", {
    credit_id: record.creditId,
    drain_id: record.drainId,
    channel_id: channelId,
    obligation_id: pending.id,
    attempt: result.releases + 1,
  });
  return result.id;
}

function tempoCloseCredentialNeedsRefresh(error: unknown): boolean {
  return (
    error instanceof MppxErrors.InvalidChallengeError ||
    error instanceof MppxErrors.PaymentExpiredError
  );
}

async function recoverTempoDrain(
  deps: CreditRouteDeps,
  mpp: NonNullable<UpfrontPaymentOpts["mpp"]>,
  record: CreditDrainRecord,
  channelId: string
): Promise<CreditDrainRecord | Response | null> {
  try {
    const reference = await mpp.recoverTempoSessionClose?.(channelId, record.drainId);
    return reference ? await markTempoDrainSent(deps, mpp, record, channelId, reference) : null;
  } catch (error) {
    const refused = tempoFloorRefusal(error, record);
    if (refused) return refused;
    loggers.tempo.warn("tempo_session_close_recovery_failed", {
      credit_id: record.creditId,
      drain_id: record.drainId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonPaymentError("payment_invalid", 402, {
      message: "The Tempo session close is still being reconciled; retry this drain.",
    });
  }
}

/**
 * Before broadcast, refuse a reconciled forecast below the reserved drain’s native floor. A
 * missing RPC forecast cannot prove a shortfall; the landed-close floor remains the backstop.
 * Recheck the durable intent because another request may already have opened its broadcast
 * gate.
 */
async function refuseShortTempoDrainForecast(
  deps: CreditRouteDeps,
  mpp: NonNullable<UpfrontPaymentOpts["mpp"]>,
  record: CreditDrainRecord,
  channelId: string
): Promise<Response | null> {
  if (!mpp.resolveTempoSessionCloseForecast) return null;
  if (!mpp.getTempoSessionDrainState) {
    return resolveTempoDrainForecastProceed(mpp, record, channelId);
  }
  let state: TempoSessionDrainState;
  try {
    state = await mpp.getTempoSessionDrainState(channelId);
  } catch (error) {
    loggers.tempo.warn("tempo_drain_refund_forecast_unavailable", {
      credit_id: record.creditId,
      drain_id: record.drainId,
      channel_id: channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return resolveTempoDrainForecastProceed(mpp, record, channelId);
  }
  // This snapshot is no longer a forecast of a cooperative close: the chain
  // has already chosen (or begun) another terminal path. In particular, a
  // finalized zero-deposit channel may have paid its external refund after the
  // challenge was issued. Restoring the ledger here would create that value a
  // second time, so irreversibly open the gate and let the recovery/failure
  // ladder above reconcile the landed exit.
  if (state.finalized || state.deposit === 0n || state.closeRequestedAt !== 0n) {
    return resolveTempoDrainForecastProceed(mpp, record, channelId);
  }
  const forecastRefund = state.deposit - maxBigInt(state.spent, state.settledOnChain);
  try {
    refundFloorEvidence({
      rail: "tempo",
      refundedNative: forecastRefund,
      debitedNative: record.drainedNative,
      creditId: record.creditId,
      drainId: record.drainId,
    });
    return await resolveTempoDrainForecastProceed(mpp, record, channelId);
  } catch (error) {
    if (!(error instanceof DrainRefundFloorError)) throw error;
    const resolution = await mpp.resolveTempoSessionCloseForecast<DrainReleaseResult>(
      channelId,
      record.drainId,
      "release",
      (tx) =>
        deps.ledger.releaseDrain({
          creditId: record.creditId,
          drainId: record.drainId,
          tx,
        })
    );
    // Another request already opened the gate and may now be broadcasting.
    // Its decision wins: the landed-close floor remains the safe backstop,
    // while restoring here would create value twice if that close lands.
    if (resolution.outcome === "proceed") return null;
    let released = resolution.outcome === "released" ? resolution.value.drain : record;
    if (resolution.outcome === "released" && !resolution.value.replayed && deps.receiptIssuer) {
      released = await countersignDrain(deps, released, "released");
    }
    loggers.tempo.warn("tempo_drain_refund_forecast_below_debit", {
      credit_id: released.creditId,
      drain_id: released.drainId,
      channel_id: channelId,
      "forecast.refund_native": forecastRefund.toString(),
      "drain.native": released.drainedNative,
    });
    return tempoForecastRefusal(released, forecastRefund);
  }
}

async function resolveTempoDrainForecastProceed(
  mpp: NonNullable<UpfrontPaymentOpts["mpp"]>,
  record: CreditDrainRecord,
  channelId: string
): Promise<Response | null> {
  const resolution = await mpp.resolveTempoSessionCloseForecast?.(
    channelId,
    record.drainId,
    "proceed"
  );
  if (resolution?.outcome !== "missing") return null;
  return jsonPaymentError("drain_conflict", 409, {
    message: `Tempo drain ${record.drainId} was released by a concurrent refund forecast before this request could broadcast its close.`,
    display:
      "The service did not broadcast this Tempo close. Another request restored the drain, so your balance is intact.",
    hint: `Retry with a fresh drain_id after the channel's latest settlement is visible. Drain ${record.drainId} was released and cannot be reused.`,
    extra: { drain_registered: true, balance_intact: true },
  });
}

function tempoForecastRefusal(record: CreditDrainRecord, forecastRefund: bigint): Response {
  return jsonPaymentError("drain_conflict", 409, {
    message: `Tempo close would refund ${forecastRefund.toString()} for a drain requiring at least ${String(record.drainedNative)}; no close was broadcast and the balance was restored.`,
    display:
      "This Tempo close would return less than your recorded balance, so the service did not broadcast it. Your balance is intact.",
    hint: `Retry with a fresh drain_id after the channel's latest settlement is visible. Drain ${record.drainId} was released and cannot be reused.`,
    extra: {
      drain_registered: true,
      forecast_refund_native: forecastRefund.toString(),
      drained_native: record.drainedNative,
      balance_intact: true,
    },
  });
}

/**
 * A wrong-channel signature is terminal before chain state changes. Keep the
 * already-registered Tempo drain ID so the caller can retry it with the correct credential.
 */
function tempoWrongChannelRefusal(error: unknown, record: CreditDrainRecord): Response | null {
  if (!(error instanceof TempoSessionChannelMismatchError)) return null;
  loggers.tempo.warn("tempo_close_credential_wrong_channel", {
    credit_id: record.creditId,
    drain_id: record.drainId,
    channel_id: error.expectedChannelId,
    presented_channel_id: error.presentedChannelId,
  });
  return jsonPaymentError("drain_conflict", 409, {
    message: `credit ${record.creditId} is bound to Tempo channel ${error.expectedChannelId}, and the session close credential presented was signed for channel ${error.presentedChannelId}`,
    display:
      "That close approval was signed for a different payment channel than the one holding this prepaid balance. Nothing was closed and no refund was sent.",
    hint: `Re-sign the Tempo session close for channel ${error.expectedChannelId} — the one this credit was funded through — and resubmit. The same drain_id still works.`,
    extra: {
      drain_registered: true,
      credit_channel_id: error.expectedChannelId,
      presented_channel_id: error.presentedChannelId,
    },
  });
}

/**
 * A measured payout shortfall is terminal: the close landed, so retrying or releasing its
 * ledger debit would misstate caller funds. Keep the registered drain ID for operator repair.
 */
function tempoFloorRefusal(error: unknown, record: CreditDrainRecord): Response | null {
  if (!(error instanceof DrainRefundFloorError)) return null;
  loggers.tempo.warn("tempo_drain_refund_below_debit", {
    credit_id: record.creditId,
    drain_id: record.drainId,
    "drain.native": record.drainedNative,
    error: error.message,
  });
  return jsonPaymentError("drain_conflict", 409, {
    message: `${error.message}. Drain ${record.drainId} on credit ${record.creditId} was left unbooked.`,
    display:
      "The Tempo channel closed, but the refund it paid on chain is smaller than the balance this service recorded. Your on-chain refund arrived; the difference has to be reconciled by the service operator.",
    hint: `Report drain ${record.drainId} on credit ${record.creditId} to the service operator. Retrying this drain, or requesting a new drain_id, lands here again — the channel is already closed.`,
    extra: { drain_registered: true },
  });
}

function isDefinitiveTempoCloseFailure(error: unknown): boolean {
  if (isTempoInsufficientFundsError(error)) return true;
  return error instanceof Error && /(?:precompile )?transaction reverted/i.test(error.message);
}

async function releaseTempoDrain(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  record: CreditDrainRecord,
  channelId: string
): Promise<CreditDrainRecord> {
  const release = (tx?: Parameters<CreditRouteDeps["ledger"]["releaseDrain"]>[0]["tx"]) =>
    deps.ledger.releaseDrain({
      creditId: record.creditId,
      drainId: record.drainId,
      tx,
    });
  const mpp = (await deps.railOpts(c)).mpp;
  const releaseCloseIntent = mpp?.releaseTempoSessionCloseIntent?.bind(mpp);
  const released = releaseCloseIntent
    ? await releaseCloseIntent(channelId, record.drainId, release)
    : await release();
  return !released.replayed && deps.receiptIssuer
    ? countersignDrain(deps, released.drain, "released")
    : released.drain;
}

async function markTempoDrainSent(
  deps: CreditRouteDeps,
  mpp: TempoDrainRail,
  record: CreditDrainRecord,
  channelId: string,
  reference: string
): Promise<CreditDrainRecord> {
  const completed = await completeTempoChannelDrain({
    deps,
    creditId: record.creditId,
    drainId: record.drainId,
    channelId,
    refundedNative: await tempoCloseRefund(mpp, channelId, reference),
    debitedNative: record.drainedNative,
    reference,
  });
  return !completed.replayed && deps.receiptIssuer
    ? countersignDrain(deps, completed.drain, "sent")
    : completed.drain;
}

async function handleX402ChannelDrain(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: {
    callerPubkey: string;
    envelope: CanonicalEnvelope;
    credit: CreditSnapshot;
    drainId: string;
  }
): Promise<Response> {
  const rail = await deps.railOpts(c);
  const channel = rail.x402BatchSettlement;
  const channelId = args.credit.x402ChannelId;
  if (!channelId) throw new Error("x402 channel drain called for an unbound credit");
  if (!channel) {
    return c.json(
      paymentErrorBody("payment_invalid", {
        message: "This credit's x402 channel settlement service is unavailable.",
      }),
      503
    );
  }
  // Checked above the challenge, deliberately: an earlier refund on this
  // channel that reached the chain and never booked refuses this drain in the
  // ledger leg anyway, and issuing the 402 first would have the caller sign a
  // refund voucher we already know we cannot accept. The wedged
  // drain's *own* id is exempt — re-presenting it is how the reclaim finishes.
  const blocking = await channel.settlementGate?.pendingRefundSettlement(
    channelId,
    X402_WEDGED_SETTLEMENT_STATUSES
  );
  if (blocking && blocking.effectId !== `${args.credit.creditId}:${args.drainId}`) {
    const rejected = await burnNonce(c, deps, args.envelope);
    if (rejected) return rejected;
    const pending = x402SettlementPending(args.credit.creditId, blocking);
    return x402SettlementPendingRefusal({
      door: "drain",
      message: pending.message,
      drainId: args.drainId,
      settlementId: blocking.settlementId,
      settlementStatus: blocking.status,
      ...(pending.details.blockingDrainId
        ? { blockingDrainId: pending.details.blockingDrainId }
        : {}),
    });
  }
  if (!rail.x402Payment) {
    return buildPaymentErrorResponse(
      {
        error: "payment_required",
        message:
          "A cooperative x402 refund voucher is required to drain prepaid credit funded through this reusable channel.",
        display:
          "This prepaid credit was funded through a reusable x402 channel, so it needs your signed refund approval before it can be returned.",
        hint: "Sign the batch-settlement refund requirement in PAYMENT-REQUIRED, attach it as PAYMENT-SIGNATURE, and resubmit this drain.",
        retryable: true,
      },
      undefined,
      undefined,
      402,
      await channel.buildRequirements("0")
    );
  }

  const rejected = await burnNonce(c, deps, args.envelope);
  if (rejected) return rejected;
  const refundBoundNative = args.credit.nativeAvailable;
  if (refundBoundNative === null) {
    return x402RefundBoundFailureResponse(args.credit.creditId, "refund_bound_unavailable");
  }
  if (refundBoundNative <= 0) {
    // Return the ledger’s empty-credit refusal before an unsizable-refund challenge; an empty
    // balance is not an unpaid request.
    return jsonPaymentError("nothing_to_drain", 409, {
      message: `credit ${args.credit.creditId} has no x402 balance left to refund.`,
      extra: {
        balance_micro: args.credit.balanceMicro,
        remaining_micro: Math.max(0, args.credit.availableMicro),
      },
    });
  }
  let terminalReplayed: boolean | undefined;
  try {
    const accepted = await channel.accept({
      paymentHeader: rail.x402Payment,
      amount: "0",
      operation: "refund",
      effectId: `${args.credit.creditId}:${args.drainId}`,
      expectedChannelId: channelId,
      refundBoundNative,
      commit: async (_funding, tx) => {
        const requested = await deps.ledger.requestDrain({
          creditId: args.credit.creditId,
          drainId: args.drainId,
          callerPubkey: args.callerPubkey,
          method: "x402",
          payout: { channel_id: channelId },
          tx,
        });
        if (requested.credit.balanceMicro !== 0) {
          throw new CreditLedgerError(
            "drain_conflict",
            "x402 channel refund requires all pending credit draws to finish first",
            { drainConflict: "pending_draws" }
          );
        }
        // The bound above was read outside this lock. If a draw settled in
        // between, the refund the channel is about to pay no longer matches
        // what the ledger owes — roll the whole thing back rather than
        // overpay, and let the retry re-read.
        if (requested.drain.drainedNative !== refundBoundNative) {
          throw new CreditLedgerError(
            "drain_conflict",
            `credit ${args.credit.creditId} changed balance while the drain was being settled`,
            { drainConflict: "balance_moved" }
          );
        }
        return requested;
      },
      complete: async (settlement, requested, tx) => {
        const terminal = await completeX402ChannelDrain({
          deps,
          creditId: args.credit.creditId,
          drainId: args.drainId,
          channelId,
          settledAmount: settlement.amount,
          debitedNative: requested.drain.drainedNative,
          transaction: settlement.transaction,
          tx,
        });
        terminalReplayed = terminal.replayed;
        return { ...requested, drain: terminal.drain };
      },
    });
    if (!accepted.ok && accepted.corrective === false) {
      if (isX402RefundBoundFailureReason(accepted.reason)) {
        return x402RefundBoundFailureResponse(args.credit.creditId, accepted.reason);
      }
      if (accepted.reason === "wrong_channel") {
        return jsonPaymentError("drain_conflict", 409, {
          message: `credit ${args.credit.creditId} is bound to x402 channel ${channelId}, and the refund voucher presented was signed for a different channel`,
          display:
            "That refund approval was signed for a different payment channel than the one holding this prepaid balance. Nothing was refunded and the balance is untouched.",
          hint: `Re-sign the refund requirement for channel ${channelId} — the one this credit was funded through — and resubmit. The same drain_id still works.`,
          extra: { drain_registered: false, credit_channel_id: channelId },
        });
      }
      // An operator-written-off attempt retires its drain ID. The balance remains
      // reclaimable through a fresh drain ID, not by retrying this closed effect.
      return jsonPaymentError("drain_conflict", 409, {
        message: `x402 cooperative refund refused: ${accepted.reason}. Drain ${args.drainId} on credit ${args.credit.creditId} was closed by the operator without booking.`,
        display:
          "The service closed this refund attempt without paying it. Your balance is still here — a fresh refund request can reclaim it.",
        hint: `Reclaim it again with 'dvm credit drain <dvm>' — that run takes a new drain_id, which is what this needs; retrying ${args.drainId} will always land here.`,
        ...(accepted.reason === "settlement_written_off"
          ? { extra: { drain_id_retired: true } }
          : {}),
      });
    }
    if (!accepted.ok) {
      const errorCode = isX402SettlementReconciliationReason(accepted.reason)
        ? accepted.reason
        : "payment_invalid";
      return buildPaymentErrorResponse(
        paymentErrorBody(errorCode, {
          message: `x402 cooperative refund refused: ${accepted.reason}`,
        }),
        undefined,
        undefined,
        402,
        accepted.requirements,
        undefined,
        undefined,
        accepted.reason
      );
    }
    c.header("PAYMENT-RESPONSE", encodeSettleResponseHeader(accepted.value.settlement));
    const result = accepted.value.committed;
    let record = result.drain;
    if (deps.receiptIssuer && !result.replayed) {
      record = await countersignDrain(deps, record, "requested");
    }
    if (deps.receiptIssuer && terminalReplayed === false) {
      record = await countersignDrain(deps, record, "sent");
    }
    return await respondDrain(c, deps, { record, credit: result.credit });
  } catch (error) {
    if (error instanceof CreditLedgerError) {
      return drainLedgerErrorResponse(error, args.credit.creditId, args.drainId);
    }
    throw error;
  }
}

function isX402RefundBoundFailureReason(
  reason: string
): reason is "refund_bound_unavailable" | "refund_exceeds_channel_escrow" {
  return reason === "refund_bound_unavailable" || reason === "refund_exceeds_channel_escrow";
}

function x402RefundBoundFailureResponse(
  creditId: string,
  reason: "refund_bound_unavailable" | "refund_exceeds_channel_escrow"
): Response {
  const unavailable = reason === "refund_bound_unavailable";
  return jsonPaymentError("drain_conflict", 409, {
    message: unavailable
      ? `credit ${creditId} records no usable x402 token basis to size a cooperative refund.`
      : `credit ${creditId} cannot be refunded cooperatively because its channel no longer has enough unclaimed escrow.`,
    display: unavailable
      ? "The service can't safely calculate this cooperative refund. Your x402 channel still has a timed on-chain exit."
      : "The service can't return this whole balance cooperatively because the x402 channel no longer holds enough unclaimed funds. The timed on-chain exit can still recover whatever remains.",
    hint: "Run 'dvm wallet x402-withdraw-initiate <dvm>' to start the timed on-chain exit. It closes the whole channel position and reports the guaranteed and likely recovery.",
  });
}

/**
 * Cashu pickup is terminal delivery: transition and report commit together. Countersigning
 * follows that commit; replay returns the existing token.
 */
async function deliverIfParked(
  deps: CreditRouteDeps,
  record: CreditDrainRecord
): Promise<CreditDrainRecord> {
  if (record.status !== "parked") return record;
  const { drain: picked } = await commitTerminalDrain(deps.drainReport, (tx) =>
    deps.ledger.markDrainPickedUp({ creditId: record.creditId, drainId: record.drainId, tx })
  );
  return deps.receiptIssuer ? countersignDrain(deps, picked, "picked_up") : picked;
}

async function countersignDrain(
  deps: CreditRouteDeps,
  record: CreditDrainRecord,
  event: "requested" | "picked_up" | "sent" | "released"
): Promise<CreditDrainRecord> {
  if (!deps.receiptIssuer) return record;
  const receipt = deps.receiptIssuer.issueDrain({
    creditId: record.creditId,
    drainId: record.drainId,
    event,
    method: record.method,
    amountMicro: record.amountMicro,
    balanceAfterMicro: record.balanceAfterMicro,
    ledgerSeq: record.ledgerSeq,
    callerPubkey: record.callerPubkey,
  }) as unknown as Record<string, unknown>;
  await deps.ledger.appendDrainReceipt({
    creditId: record.creditId,
    drainId: record.drainId,
    receipt,
  });
  return { ...record, receipts: [...record.receipts, receipt] };
}

async function respondDrain(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { record: CreditDrainRecord; credit: CreditSnapshot }
): Promise<Response> {
  // The credit snapshot may predate the drain debit on the replay path —
  // re-read so the echoed balance is always post-drain.
  const fresh = (await deps.ledger.get(args.record.creditId)) ?? args.credit;
  return c.json({
    op: "drain",
    drain: drainBody(args.record),
    credit: creditBody(fresh),
    ...drainCopy(args.record),
  });
}

/**
 * Validate the payout target for a fresh drain. Each rail names exactly one
 * destination field; anything else in `payout` is dropped rather than stored.
 * The cashu key is a 33-byte compressed pubkey — NOT the x-only auth key: the
 * caller's wallet holds a separate Cashu lock keypair, and parked notes must
 * be locked to a key it can actually witness-spend.
 */
function validateDrainTarget(drain: {
  method?: string;
  payout?: { refund_pubkey?: string; address?: string };
}): { method: DrainMethod; payout: Record<string, string> } | { error: Record<string, unknown> } {
  const refuse = (message: string, hint: string): { error: Record<string, unknown> } => ({
    error: { error: "invalid_request", message, hint },
  });
  const missingFields = (): { error: Record<string, unknown> } =>
    refuse(
      "A new drain requires drain.method and drain.payout.",
      'Send drain: { drain_id, method: "cashu" | "x402" | "tempo", payout: { … } }. Only a poll of an existing drain_id may omit them.'
    );
  const method = drain.method;
  if (!method) return missingFields();
  // Refuse unsupported payout rails before requiring their target, so a typo or receive-only
  // Lightning rail gets a rail refusal rather than a missing-address prompt.
  if (!isDrainMethod(method)) {
    return {
      error: paymentErrorBody("drain_method_unsupported", {
        message: `"${method}" is not a payout rail this service reclaims over.`,
        extra: { supported_methods: [...DRAIN_METHODS], drain_registered: false },
      }),
    };
  }
  if (!drain.payout && method !== "tempo") return missingFields();
  switch (method) {
    case "cashu": {
      const refundPubkey = drain.payout?.refund_pubkey;
      if (!refundPubkey || !/^0[23][0-9a-f]{64}$/i.test(refundPubkey)) {
        return refuse(
          "cashu drains require payout.refund_pubkey — a 33-byte compressed secp256k1 key (66 hex chars starting 02/03).",
          "Use your Cashu wallet's lock pubkey (dvm wallet: lock_pubkey), not the request-signing key — the refund notes are P2PK-locked to it."
        );
      }
      return { method: "cashu", payout: { refund_pubkey: refundPubkey.toLowerCase() } };
    }
    case "x402":
    case "tempo": {
      if (method === "tempo" && !drain.payout) {
        return { method: "tempo", payout: {} };
      }
      const address = drain.payout?.address;
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return refuse(
          `${method} drains require payout.address (0x + 40 hex chars).`,
          `Provide the EVM address the refund should be sent back to — 'dvm credit drain <dvm> --method ${method} --address 0x…' supplies it, and defaults to the wallet already connected on that rail. '--method cashu' reclaims the same balance as ecash if you would rather be paid there.`
        );
      }
      return { method, payout: { address } };
    }
  }
}

/**
 * Channel-less stablecoin refunds must use the credit’s funding rail. Reusable channels
 * return collateral through their own lifecycle; non-channel Bitcoin refunds use Cashu.
 */
function railMismatchRefusal(
  credit: CreditSnapshot,
  method: DrainMethod
): Record<string, unknown> | undefined {
  if (method !== "x402" && method !== "tempo") return undefined;
  if (!isFundingRail(credit.rail) || credit.rail === method) return undefined;
  const target =
    credit.rail === "cashu" || credit.rail === "lightning"
      ? "--method cashu"
      : `--method ${credit.rail} --address 0x…`;
  return {
    error: "invalid_request",
    message: `This credit was funded over ${credit.rail}, so it cannot be refunded as an ${method} payout.`,
    hint: `Reclaim it on the rail that funded it — 'dvm credit drain <dvm> ${target}' — or take the refund as ecash with '--method cashu'.`,
  };
}

function menuHasTempoSession(menu: CreditMenu | undefined): boolean {
  return !!menu?.tempo?.methods.some(
    (method) => method.method === "tempo" && method.intent === "session"
  );
}

/**
 * True when a re-stated payout names the same destination the drain was
 * recorded with. The comparison is over the FULL objects, not just shared
 * keys — a poll restating a destination under a different field name (e.g.
 * `address` against a recorded `refund_pubkey`) names a different payout and
 * must refuse as `drain_conflict`, exactly like a changed value. An empty
 * re-statement (`payout: {}`) states nothing and matches.
 */
function payoutMatches(
  record: CreditDrainRecord,
  payout: Record<string, string | undefined>
): boolean {
  const restatedKeys = Object.keys(payout).filter((key) => payout[key] !== undefined);
  if (restatedKeys.length === 0) return true;
  const recordedKeys = Object.keys(record.payout);
  if (restatedKeys.length !== recordedKeys.length) return false;
  return recordedKeys.every(
    (key) => payout[key]?.toLowerCase() === record.payout[key].toLowerCase()
  );
}

function drainBody(record: CreditDrainRecord): Record<string, unknown> {
  return {
    drain_id: record.drainId,
    credit_id: record.creditId,
    method: record.method,
    status: record.status,
    amount_micro: record.amountMicro,
    currency: record.currency,
    // Fixed in-kind Bitcoin refund obligation after the delivery reserve. It reflects the
    // funding lots remaining at request time; null means no whole-balance in-kind price was
    // available.
    ...(record.owedSats !== null ? { owed_sats: record.owedSats } : {}),
    ledger_seq: record.ledgerSeq,
    created_at: record.createdAt,
    ...(record.token !== null ? { token: record.token } : {}),
    ...(record.sentRef !== null ? { sent: record.sentRef } : {}),
    receipts: record.receipts,
  };
}

function drainCopy(record: CreditDrainRecord): { display: string; hint: string } {
  switch (record.status) {
    case "pending":
      if (record.method === "cashu") {
        return {
          display:
            record.owedSats === null
              ? "The refund is approved and being prepared. The balance is already set aside for you."
              :
                `The refund is approved and being prepared: ${record.owedSats} sats, the share of the Bitcoin you deposited that you haven't spent, less whatever the mint charges to hand it over. That figure won't move while you wait, whatever the price does.`,
          hint: "Poll this op with the same drain_id until a token appears. Preparation can be delayed (e.g. the mint is temporarily down) — the refund stays owed to you either way.",
        };
      }
      if (!record.payout.address) {
        return {
          display:
            "The refund is approved against the payment channel and the balance is already set aside for you; the on-chain settlement has not completed yet.",
          hint: "Poll this op with the same drain_id; it flips to sent with the settlement reference once the channel pays out.",
        };
      }
      return {
        display:
          "The refund is approved and recorded as a debt this service owes you at the address you named. The balance is already set aside — but stablecoin refunds are not paid automatically here: someone at the service settles this one by hand, so it can take longer than an ecash refund.",
        hint: "Poll this op with the same drain_id; it flips to sent with the on-chain transaction once the service settles it. The signed `requested` receipt in this response is your evidence of the debt until then — keep it, and chase the service with the drain_id if the wait becomes unreasonable. Where this service also offers ecash, a refund there is paid by an automatic job rather than by a person.",
      };
    case "parked":
    case "picked_up":
      return {
        display: "The refund is ready: the token in this response is locked to your refund key.",
        hint: "Redeem the token with your Cashu wallet. Polling again returns the same token — it can only be claimed by your key.",
      };
    case "sent":
      return {
        display: "The refund was sent to the payout destination you provided.",
        hint: "See `sent` for the settlement reference (e.g. the on-chain transaction hash).",
      };
    case "released":
      return {
        display:
          "The channel could not complete this refund, so the service restored the amount to your prepaid balance.",
        hint: "Run 'dvm wallet tempo-exit <dvm>' to recover the channel on-chain. This released drain is terminal and should not be polled again.",
      };
  }
}

async function handleFund(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: {
    callerPubkey: string;
    body: CreditRequest;
    envelope: CanonicalEnvelope;
    menu: CreditMenu;
  }
): Promise<Response> {
  const { menu, body } = args;
  const fund = body.fund;
  if (!fund) {
    return c.json(
      {
        error: "invalid_request",
        message: 'op "fund" requires a `fund` block.',
        hint: "Send fund: { amount_micro, fund_id, commitment } and attach the payment artifact on the matching header.",
      },
      400
    );
  }
  // Hash header-borne funding into the signed commitment. Lightning instead binds the
  // server-issued invoice by its durable (credit_id, fund_id) row and accepts no artifact
  // hash.
  let commitment = "";
  if (fund.method === "lightning") {
    if (fund.commitment !== undefined) {
      return c.json(
        {
          error: "invalid_request",
          message: 'fund.commitment does not apply to method "lightning".',
          hint: "Drop fund.commitment: the invoice this DVM issues is already bound to the credit_id, fund_id and amount in your signed body.",
        },
        400
      );
    }
    if (fund.intent !== undefined) {
      return c.json(
        {
          error: "invalid_request",
          message: 'fund.intent applies only to method "tempo".',
          hint: 'Drop fund.intent from the Lightning request, or send fund.method: "tempo" with a Tempo intent.',
        },
        400
      );
    }
  } else {
    if (fund.method === "tempo" && fund.intent === undefined) {
      return c.json(
        {
          error: "invalid_request",
          message: 'fund.intent is required with method "tempo".',
          hint: 'Set fund.intent to "charge" or "session" so the provider can check the credit binding before money moves.',
        },
        400
      );
    }
    if (fund.method !== "tempo" && fund.intent !== undefined) {
      return c.json(
        {
          error: "invalid_request",
          message: 'fund.intent requires method "tempo".',
          hint: 'Send fund.method: "tempo", or drop fund.intent for a header-discriminated rail.',
        },
        400
      );
    }
    if (fund.commitment === undefined) {
      return c.json(
        {
          error: "invalid_request",
          message: 'fund.commitment is required unless fund.method is "lightning".',
          hint: 'Set fund.commitment to the SHA-256 hex of the payment artifact you attach, or send fund.method: "lightning" to be issued an invoice instead.',
        },
        400
      );
    }
    commitment = fund.commitment;
  }

  const creditId = body.credit_id ?? derivedFundCreditId(args.callerPubkey, fund.fund_id);

  const replayed = await replayedFunding(c, deps, {
    creditId,
    fundId: fund.fund_id,
    callerPubkey: args.callerPubkey,
    method: fund.method,
  });
  if (replayed) return replayed;

  // Return a known invoice above current sizing checks. It may already be paid; policy, FX or
  // balance changes must not strand it.
  if (fund.method === "lightning") {
    const outstanding = await lightningPoll(c, deps, {
      creditId,
      fundId: fund.fund_id,
      callerPubkey: args.callerPubkey,
      named: body.credit_id !== undefined,
      menu,
      envelope: args.envelope,
    });
    if (outstanding) return outstanding;
  }

  const sizing = await checkSizing(deps, {
    callerPubkey: args.callerPubkey,
    creditId,
    named: body.credit_id !== undefined,
    fundId: fund.fund_id,
    amountMicro: fund.amount_micro,
    menu,
    rail: fund.method,
    tempoIntent: fund.method === "tempo" ? fund.intent : undefined,
  });
  if (sizing) return sizing;

  // Preserve a bound instrument’s specific refusal. A fresh one-shot stablecoin deposit is
  // refused before settlement unless explicitly enabled; an already-committed replay remains
  // valid.
  if (
    fund.method === "tempo" &&
    fund.intent === "charge" &&
    !stablecoinCreditInstrumentAllowed(deps.creditConfig?.allowOneShotStablecoin, "tempo_charge")
  ) {
    return jsonPaymentError("one_shot_credit_not_supported", 409, {
      message:
        "Tempo charge remains available for per-call payment, but this DVM accepts only reusable Tempo sessions for prepaid credit.",
    });
  }

  let requiredMsats: number;
  try {
    const fx = await deps.fxFetcher.fetch();
    requiredMsats =
      fiatToSatsCeil(fund.amount_micro / 1_000_000, fxRateFor(fx, menu.currency)) * 1000;
  } catch {
    return c.json(
      {
        error: "fx_rate_unavailable",
        message: `Could not price a ${menu.currency} top-up in sats right now.`,
        display: "The service can't work out the exchange rate right now. Nothing was charged.",
        hint: "Retry in a few moments.",
        retryable: true,
      },
      503
    );
  }

  if (fund.method === "lightning") {
    return lightningIssue(c, deps, {
      creditId,
      fundId: fund.fund_id,
      callerPubkey: args.callerPubkey,
      named: body.credit_id !== undefined,
      currency: menu.currency,
      amountMicro: fund.amount_micro,
      amountMsats: requiredMsats,
      menu,
    });
  }

  const railOpts = await deps.railOpts(c);
  let error: PaymentErrorDetail | undefined;
  let x402SettleResponseHeader: string | undefined;
  try {
    const result = await loggers.isolate.span(
      "dvm.credit.fund",
      { required_msats: requiredMsats },
      () =>
        verifyUpfrontPayment({
          ...railOpts,
          requiredMsats,
          priceFiat: { currency: menu.currency, amountMicro: fund.amount_micro },
          callerPubkey: args.callerPubkey,
          fundOnly: {
            creditId,
            fundId: fund.fund_id,
            commitment,
            allowOneShotStablecoin: deps.creditConfig?.allowOneShotStablecoin,
          },
        }),
      { onError: () => ({ "error.code": "credit_fund_failed" }) }
    );
    error = result.error;
    x402SettleResponseHeader = result.x402SettleResponseHeader;
    if (result.funding) deps.onDeposit(result.funding);
  } catch (err) {
    if (err instanceof CreditLedgerError) {
      if (err.code === "funding_replayed") {
        const raced = await replayedFunding(c, deps, {
          creditId,
          fundId: fund.fund_id,
          callerPubkey: args.callerPubkey,
        });
        if (raced) return raced;
      }
      return c.json(
        paymentErrorBody(mapLedgerCode(err), { message: err.message }),
        err.code === "caller_mismatch" ? 403 : 402
      );
    }
    throw err;
  }

  if (error) {
    return buildPaymentErrorResponse(
      error.body,
      error.mppChallenges,
      error.x402Requirements,
      error.status,
      error.x402V2Requirements,
      undefined,
      railOpts.x402ExactVersions,
      error.x402ErrorCode
    );
  }

  if (x402SettleResponseHeader) {
    c.header("PAYMENT-RESPONSE", x402SettleResponseHeader);
  }

  // Burn the nonce only after funding verifies. The unpaid discovery request and paid
  // resubmission use the same signed envelope.
  const rejected = await burnNonce(c, deps, args.envelope);
  if (rejected) return rejected;

  const recorded = await deps.ledger.getFunding({ creditId, fundId: fund.fund_id });
  const credit = await deps.ledger.get(creditId);
  if (!recorded || !credit) {
    return creditFundingUnrecorded(c, {
      creditId,
      fundId: fund.fund_id,
      requestedMicro: fund.amount_micro,
    });
  }
  if (x402SettleResponseHeader) {
    c.header("PAYMENT-RESPONSE", x402SettleResponseHeader);
    c.header("X-PAYMENT-RESPONSE", x402SettleResponseHeader);
  }
  const fundingReceipt = await fundingReceiptFor(deps.ledger, deps.receiptIssuer, recorded);
  return c.json({
    op: "fund",
    funded_micro: recorded.amountMicro,
    replayed: false,
    credit: creditBody(credit),
    ...(fundingReceipt && { funding_receipt: fundingReceipt }),
  });
}

/**
 * A known invoice returns the same bolt11 until its recorded state changes. Poll through the
 * shared settlement hook so caller/credit-scoped sibling settlements and deposit reports are
 * included.
 */
async function lightningPoll(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    named: boolean;
    menu: CreditMenu;
    envelope: CanonicalEnvelope;
  }
): Promise<Response | undefined> {
  const lightning = deps.lightning;
  if (!lightning) return lightningUnavailable(c, args.menu);

  const existing = await deps.ledger.getInvoice({
    creditId: args.creditId,
    fundId: args.fundId,
  });
  if (!existing) return undefined;
  // Ownership is checked on the invoice's own recorded pubkey, not the
  // caller-named credit: the derived `fnd:` id is predictable from a pubkey
  // plus a guessed fund_id, so answering it for anyone else would leak both
  // the bolt11 and the amount. It must **refuse** rather than fall through —
  // the fallthrough is `lightningIssue`, which would read the same row and
  // hand it over anyway.
  if (existing.callerPubkey !== args.callerPubkey) {
    return foreignInvoice(c, args);
  }

  if (existing.status === "pending") {
    await deps.settleLightning(args.callerPubkey, args.creditId);
  }

  const invoice = await deps.ledger.getInvoice({
    creditId: args.creditId,
    fundId: args.fundId,
  });
  if (invoice?.status === "settled") {
    return lightningSettledResponse(c, deps, {
      invoice,
      callerPubkey: args.callerPubkey,
      envelope: args.envelope,
    });
  }
  if (invoice?.status === "expired") {
    return jsonPaymentError("lightning_invoice_expired", 402, {
      message: `The invoice for funding ${args.fundId} expired without being paid.`,
      extra: { credit_id: args.creditId, fund_id: args.fundId },
    });
  }
  if (invoice?.status === "reconciled") {
    return lightningReconciledResponse(c, deps, {
      invoice,
      callerPubkey: args.callerPubkey,
      envelope: args.envelope,
    });
  }
  // Only pending invoices may return a payable bolt11. Blocked, written-off or unknown
  // terminal states must fail closed rather than inviting payment again.
  if (invoice?.status !== "pending") {
    const terminal = invoice ?? existing;
    return creditFundingUnrecorded(c, {
      creditId: args.creditId,
      fundId: args.fundId,
      requestedMicro: terminal.amountMicro,
      invoiceStatus: terminal.status,
    });
  }
  return c.json(
    paymentErrorBody("lightning_settlement_pending", {
      message: `Invoice for funding ${args.fundId} has not settled yet.`,
      extra: lightningInvoiceBlock(invoice),
    }),
    402
  );
}

async function lightningIssue(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: {
    creditId: string;
    fundId: string;
    callerPubkey: string;
    named: boolean;
    currency: string;
    amountMicro: number;
    amountMsats: number;
    menu: CreditMenu;
  }
): Promise<Response> {
  const lightning = deps.lightning;
  if (!lightning) return lightningUnavailable(c, args.menu);

  let invoice;
  try {
    invoice = await lightning.receive.issue(deps.ledger, {
      creditId: args.creditId,
      fundId: args.fundId,
      callerPubkey: args.callerPubkey,
      currency: args.currency,
      amountMicro: args.amountMicro,
      amountMsats: args.amountMsats,
      description: `Credit top-up ${args.fundId}`,
    });
  } catch (err) {
    if (err instanceof CreditLedgerError && err.code === "caller_mismatch") {
      return foreignInvoice(c, args);
    }
    // The route normally checks sizing first. Still translate an issue-time floor refusal
    // into the same structured response.
    if (err instanceof CreditLedgerError && err.code === "below_rail_minimum") {
      return jsonPaymentError("below_rail_minimum", 400, {
        message: err.message,
        extra: {
          rail: "lightning",
          ...(args.menu.lightning_min_micro !== undefined
            ? { min_micro: args.menu.lightning_min_micro }
            : {}),
          alternatives: args.menu.funding.filter((rail) => rail !== "lightning"),
          currency: args.menu.currency,
        },
      });
    }
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "lightning_invoice_issue_failed",
        credit_id: args.creditId,
        fund_id: args.fundId,
        error: undefined,
      }
    );
    return lightningUnavailable(c, args.menu);
  }

  return c.json(
    paymentErrorBody("lightning_settlement_pending", {
      message: `Pay the invoice to fund ${args.amountMicro} ${args.currency} onto credit ${args.creditId}.`,
      extra: lightningInvoiceBlock(invoice),
    }),
    402
  );
}

/*
 * Consume the signed nonce only on the successful funded response, leaving discovery
 * resubmittable. Deposits are booked by the shared settlement hook, including
 * balance/drain/job observations; booking again here would duplicate them.
 */
async function lightningSettledResponse(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { invoice: CreditInvoiceRecord; callerPubkey: string; envelope: CanonicalEnvelope }
): Promise<Response> {
  const { invoice } = args;
  const [funding, credit] = await Promise.all([
    deps.ledger.getFunding({ creditId: invoice.creditId, fundId: invoice.fundId }),
    deps.ledger.get(invoice.creditId),
  ]);
  if (!funding || !credit) {
    return creditFundingUnrecorded(c, {
      creditId: invoice.creditId,
      fundId: invoice.fundId,
      requestedMicro: invoice.amountMicro,
    });
  }

  const rejected = await burnNonce(c, deps, args.envelope);
  if (rejected) return rejected;

  const fundingReceipt = await fundingReceiptFor(deps.ledger, deps.receiptIssuer, funding);
  return c.json({
    op: "fund",
    funded_micro: funding.amountMicro,
    replayed: false,
    credit: creditBody(credit),
    ...(fundingReceipt && { funding_receipt: fundingReceipt }),
  });
}

/**
 * A reconciled invoice returns the operator’s target credit, which may differ from the
 * original invoice credit. Preserve the original invoice identity for ownership checks and
 * never invite payment again.
 */
async function lightningReconciledResponse(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { invoice: CreditInvoiceRecord; callerPubkey: string; envelope: CanonicalEnvelope }
): Promise<Response> {
  const { invoice } = args;
  const targetCreditId = invoice.reconciledCreditId;
  const targetFundId = invoice.reconciledFundId;
  if (!targetCreditId || !targetFundId) {
    return creditFundingUnrecorded(c, {
      creditId: invoice.creditId,
      fundId: invoice.fundId,
      requestedMicro: invoice.amountMicro,
      invoiceStatus: invoice.status,
    });
  }
  const [funding, credit] = await Promise.all([
    deps.ledger.getFunding({ creditId: targetCreditId, fundId: targetFundId }),
    deps.ledger.get(targetCreditId),
  ]);
  if (!funding || credit?.callerPubkey !== args.callerPubkey) {
    return creditFundingUnrecorded(c, {
      creditId: invoice.creditId,
      fundId: invoice.fundId,
      requestedMicro: invoice.amountMicro,
      invoiceStatus: invoice.status,
    });
  }

  const rejected = await burnNonce(c, deps, args.envelope);
  if (rejected) return rejected;

  const fundingReceipt = await fundingReceiptFor(deps.ledger, deps.receiptIssuer, funding);
  return c.json({
    op: "fund",
    funded_micro: funding.amountMicro,
    replayed: false,
    reconciled: true,
    credit: creditBody(credit),
    ...(fundingReceipt && { funding_receipt: fundingReceipt }),
    display: `This payment couldn't be applied to the top-up you asked for, so the provider's operator credited it to ${targetCreditId} instead. The balance is there now.`,
    hint: `Your balance is on credit_id ${targetCreditId}, not ${invoice.creditId}. Name that credit on future requests, or list your credits with op "balance".`,
  });
}

function lightningInvoiceBlock(invoice: CreditInvoiceRecord): Record<string, unknown> {
  return {
    credit_id: invoice.creditId,
    fund_id: invoice.fundId,
    lightning: {
      invoice: invoice.bolt11,
      payment_hash: invoice.paymentHash,
      amount_msats: invoice.amountMsats,
      // Wire timestamp is milliseconds; bolt11 lifetimes are conventionally expressed in
      // seconds.
      expires_at_ms: invoice.expiresAt,
    },
  };
}

/**
 * Check the recorded invoice owner before returning it. Keep absent and foreign rows
 * indistinguishable to callers, including derived-ID probes.
 */
function foreignInvoice(
  c: Context<AppEnv>,
  args: { creditId: string; fundId: string; named: boolean }
): Response {
  if (args.named && isDerivedCreditId(args.creditId)) {
    return jsonPaymentError("credit_id_unavailable", 400, {
      message: `credit_id ${args.creditId} is in a namespace this provider derives and cannot be opened by a caller.`,
    });
  }
  return jsonPaymentError("credit_id_unavailable", 409, {
    message: `The funding invoice for fund_id ${args.fundId} on credit ${args.creditId} was issued to another caller.`,
    extra: { fund_id: args.fundId },
  });
}

function lightningUnavailable(c: Context<AppEnv>, menu?: CreditMenu): Response {
  const others = menu?.funding.filter((rail) => rail !== "lightning") ?? [];
  return c.json(
    paymentErrorBody("lightning_unavailable", {
      message: "This DVM cannot issue a Lightning invoice right now.",
      ...(others.length > 0
        ? {
            hint: `Fund over ${others.join(" or ")} instead, or retry Lightning in a few minutes.`,
          }
        : {}),
      extra: { funding: others },
    }),
    503
  );
}

/*
 * Preflight the arriving amount against minimum and caller-wide residual spendable balance in
 * this currency. Expired and unbacked credits do not count. The ceiling is per caller rather
 * than per credit, so opening fresh IDs cannot evade it. Reject excess instead of accepting
 * money the caller did not intend to leave; fundable_micro supports a corrected request. This
 * read is not an atomic cap against concurrent fundings.
 */
async function checkSizing(
  deps: CreditRouteDeps,
  args: {
    callerPubkey: string;
    creditId: string;
    named: boolean;
    fundId: string;
    amountMicro: number;
    menu: CreditMenu;
    rail?: string;
    tempoIntent?: "charge" | "session";
  }
): Promise<Response | undefined> {
  const { menu } = args;
  if (args.amountMicro < menu.min_micro) {
    return jsonPaymentError("credit_below_min", 400, {
      message: `Top-up of ${args.amountMicro} is below the ${menu.min_micro} minimum.`,
      extra: { min_micro: menu.min_micro, max_micro: menu.max_micro, currency: menu.currency },
    });
  }

  // Check the raw sats floor at current FX, not the margined menu figure. On an FX failure,
  // leave the existing fiat-to-msats conversion to return fx_rate_unavailable rather than
  // guessing.
  const floorSats = deps.lightning?.receive.fundingMinSats;
  if (args.rail === "lightning" && floorSats !== undefined) {
    let fx: FxRateSnapshot | undefined;
    try {
      fx = await deps.fxFetcher.fetch();
    } catch {
      fx = undefined;
    }
    if (fx) {
      const sats = fiatToSatsCeil(args.amountMicro / 1_000_000, fxRateFor(fx, menu.currency));
      if (sats < floorSats) {
        const alternatives = menu.funding.filter((rail) => rail !== "lightning");
        return jsonPaymentError("below_rail_minimum", 400, {
          message: `Top-up of ${args.amountMicro} ${menu.currency} is ${sats} sats — below the ${floorSats}-sat Lightning receive floor.`,
          extra: {
            rail: "lightning",
            min_micro:
              menu.lightning_min_micro ?? lightningFloorMicro(floorSats, fx, menu.currency),
            alternatives,
            currency: menu.currency,
          },
        });
      }
    }
  }

  const held = await deps.ledger.getForCaller(args.callerPubkey);
  const target = await checkTargetCredit(deps, { ...args, held });
  if (target) return target;

  const heldMicro = held
    .filter((credit) => spendable(credit, menu.currency))
    .reduce((sum, credit) => sum + credit.availableMicro, 0);
  const fundableMicro = menu.max_micro - heldMicro;
  if (args.amountMicro > fundableMicro) {
    return jsonPaymentError("credit_over_max", 400, {
      message: `Top-up of ${args.amountMicro} would leave a residual balance above the ${menu.max_micro} ceiling.`,
      extra: {
        max_micro: menu.max_micro,
        remaining_micro: heldMicro,
        fundable_micro: Math.max(0, fundableMicro),
        currency: menu.currency,
      },
    });
  }
  return undefined;
}

/*
 * Check owner, denomination and known rail/instrument or channel-refund state before payment.
 * The ledger repeats its binding checks, but a late refusal could leave externally paid money
 * uncredited. A caller may top up a derived ID they hold but cannot open a reserved ID. Check
 * that namespace before existence so probes do not disclose whether derived IDs are
 * populated.
 */
async function checkTargetCredit(
  deps: CreditRouteDeps,
  args: {
    creditId: string;
    named: boolean;
    fundId: string;
    held: CreditSnapshot[];
    menu: CreditMenu;
    rail?: string;
    tempoIntent?: "charge" | "session";
  }
): Promise<Response | undefined> {
  const mine = args.held.find((credit) => credit.creditId === args.creditId);
  if (mine) {
    if (mine.status === "unbacked") {
      return jsonPaymentError("credit_unbacked", 409, {
        message: `Credit ${args.creditId} is terminal because its Tempo backing finalized before the DVM was protected.`,
      });
    }
    if (mine.currency !== args.menu.currency) {
      return jsonPaymentError("payment_invalid", 400, {
        message: `Credit ${args.creditId} is denominated in ${mine.currency}, not ${args.menu.currency}.`,
      });
    }
    // Refuse a known cross-rail deposit before issuing a Lightning invoice; a paid invoice on
    // an incompatible credit would require operator repair.
    if (args.rail !== undefined && mine.rail !== null && mine.rail !== args.rail) {
      return jsonPaymentError("payment_invalid", 409, {
        message: `Credit ${args.creditId} was funded on the ${mine.rail} rail; a ${args.rail} top-up cannot be added to it.`,
        hint: `Top this credit up over ${mine.rail}, or omit credit_id to open a separate ${args.rail} credit.`,
        extra: { credit_rail: mine.rail },
      });
    }
    // A channel whose refund is unresolved cannot accept deposits: its escrow may already
    // have paid back. Preflight before external payment, then let the ledger repeat the rule
    // within funding.
    const wedged = await deps.ledger.blockingX402Refund?.(
      mine.x402ChannelId,
      X402_SPEND_BLOCKING_SETTLEMENT_STATUSES
    );
    if (wedged) {
      const pending = x402SettlementPending(args.creditId, wedged);
      return x402SettlementPendingRefusal({
        door: "top_up",
        message: pending.message,
        settlementId: wedged.settlementId,
        settlementStatus: wedged.status,
        ...(pending.details.blockingDrainId
          ? { blockingDrainId: pending.details.blockingDrainId }
          : {}),
      });
    }
    if (args.rail === "tempo" && args.tempoIntent) {
      const expectedIntent = mine.tempoChannelId ? "session" : "charge";
      if (expectedIntent !== args.tempoIntent) {
        const creditInstrument = `tempo_${expectedIntent}`;
        return jsonPaymentError("payment_invalid", 409, {
          message: mine.tempoChannelId
            ? `Credit ${args.creditId} is bound to Tempo session channel ${mine.tempoChannelId}; a one-shot charge cannot fund it.`
            : `Credit ${args.creditId} was opened by a one-shot Tempo charge; a reusable session cannot fund it.`,
          display:
            expectedIntent === "session"
              ? "This prepaid balance belongs to an existing reusable Tempo channel. No charge was made."
              : "This prepaid balance was opened by a one-shot Tempo payment and cannot be moved into a reusable channel. No charge was made.",
          hint:
            expectedIntent === "session"
              ? "Retry when the provider offers Tempo session funding again; do not replace it with a one-shot charge."
              : "Open a separate credit for a reusable Tempo session, or top this credit up with another one-shot charge.",
          extra: {
            credit_rail: "tempo",
            credit_instrument: creditInstrument,
            ...(mine.tempoChannelId ? { credit_channel_id: mine.tempoChannelId } : {}),
          },
        });
      }
    }
    return undefined;
  }

  // Above the existence check on purpose: a caller naming a derived id they
  // don't hold gets this same answer whether or not the id is real, so the
  // route can't be walked as an existence oracle over a namespace anyone can
  // enumerate (`imp:x402:<txHash>` from public chain data, `fnd:` from a
  // pubkey plus a guessed fund_id). The owner is already past, above.
  if (args.named && isDerivedCreditId(args.creditId)) {
    return jsonPaymentError("credit_id_unavailable", 400, {
      message: `credit_id ${args.creditId} is in a namespace this provider derives and cannot be opened by a caller.`,
    });
  }

  if (await deps.ledger.get(args.creditId)) {
    return args.named
      ? jsonPaymentError("credit_not_found", 404, {
          message: `No credit ${args.creditId} for this caller.`,
        })
      : jsonPaymentError("credit_id_unavailable", 409, {
          message: `The credit id derived for fund_id ${args.fundId} is held by another caller.`,
          extra: { fund_id: args.fundId },
        });
  }
  return undefined;
}

/**
 * Return committed funding only for this caller’s credit. Its original tuple and stored
 * receipt support replay without another rail settlement; an unowned credit is
 * indistinguishable from no funding.
 */
async function replayedFunding(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  args: { creditId: string; fundId: string; callerPubkey: string; method?: string }
): Promise<Response | undefined> {
  const prior = await deps.ledger.getFunding({ creditId: args.creditId, fundId: args.fundId });
  if (!prior) return undefined;
  if (args.method === "lightning") {
    const invoice = await deps.ledger.getInvoice({
      creditId: args.creditId,
      fundId: args.fundId,
    });
    if (
      invoice &&
      (invoice.status === "blocked" ||
        invoice.status === "written_off" ||
        invoice.status === "reconciled")
    ) {
      return undefined;
    }
  }
  const credit = await deps.ledger.get(args.creditId);
  if (credit?.callerPubkey !== args.callerPubkey) return undefined;
  const fundingReceipt = await fundingReceiptFor(deps.ledger, deps.receiptIssuer, prior);
  return c.json({
    op: "fund",
    funded_micro: prior.amountMicro,
    replayed: true,
    credit: creditBody(credit),
    ...(fundingReceipt && { funding_receipt: fundingReceipt }),
  });
}

function creditFundingUnrecorded(
  c: Context<AppEnv>,
  args: {
    creditId: string;
    fundId: string;
    requestedMicro: number;
    /**
     * Distinguish blocked from written_off in the operator signal; neither is an ordinary
     * settled funding response.
     */
    invoiceStatus?: string;
  }
): Response {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "credit_funding_unrecorded",
      credit_id: args.creditId,
      fund_id: args.fundId,
      requested_micro: args.requestedMicro,
      ...(args.invoiceStatus ? { invoice_status: args.invoiceStatus } : {}),
    }
  );
  return c.json(
    {
      error: "credit_funding_unrecorded",
      message: "The payment was accepted but no funding was recorded against the credit.",
      display:
        "Your payment went through, but the service didn't record the balance. Contact the operator with the reference below — don't pay again.",
      hint: "Do not retry: the payment already settled. Report credit_id and fund_id to the service operator.",
      retryable: false,
      credit_id: args.creditId,
      fund_id: args.fundId,
    },
    500
  );
}

async function burnNonce(
  c: Context<AppEnv>,
  deps: CreditRouteDeps,
  envelope: CanonicalEnvelope
): Promise<Response | undefined> {
  try {
    await deps.auth?.recordReplay(envelope);
  } catch (err) {
    if (err instanceof SignedRequestError) {
      return c.json(authErrorBody(err, { schemaUrl: CREDIT_SCHEMA_DOC_URL }), 401);
    }
    throw err;
  }
  return undefined;
}

function jsonPaymentError(
  code: Parameters<typeof paymentErrorBody>[0],
  status: 400 | 402 | 404 | 409,
  opts: {
    message: string;
    display?: string;
    hint?: string;
    retryable?: boolean;
    extra?: Record<string, unknown>;
  }
): Response {
  return Response.json(paymentErrorBody(code, opts), { status });
}

function channelDrainMethodConflictResponse(rail: "Tempo" | "x402"): Response {
  const method = rail === "Tempo" ? "tempo" : "x402";
  const article = rail === "Tempo" ? "a" : "an";
  return jsonPaymentError("drain_conflict", 409, {
    message: `This credit is bound to ${article} ${rail} channel and must be reclaimed cooperatively through that channel.`,
    display: `This refund was not started because the prepaid balance is tied to ${article} ${rail} channel. Nothing moved, and the credit balance is unchanged.`,
    hint: `Reclaim this credit through its channel with --method ${method}; do not retry this refund over another rail.`,
    retryable: false,
    extra: { drain_registered: false },
  });
}

interface DrainConflictCopy {
  display: string;
  hint: (ids: { creditId: string; drainId: string }) => string;
  retryable: boolean;
  /** Whether the caller keeps this `drain_id`; `credit.ts` drops it on `false`. */
  drainRegistered: boolean;
}

/**
 * Classify drain conflicts by ledger tag. Duplicate payout, pending holds, moved balance and
 * measured refund shortfall require different retry/ID instructions; an unclassified tag
 * keeps generic duplicate-payout behavior.
 */
const DRAIN_CONFLICT_COPY: Record<DrainConflictReason, DrainConflictCopy> = {
  pending_draws: {
    display:
      "A job is still running against this prepaid balance, so the refund was not started. Nothing was charged and nothing changed.",
    hint: () =>
      "Wait for every running job on this credit to finish, then retry with a fresh drain_id.",
    retryable: true,
    drainRegistered: false,
  },
  balance_moved: {
    display:
      "A job on this prepaid balance finished while the refund was being paid out, so the service rolled the refund back rather than send the wrong amount. Nothing changed.",
    hint: () =>
      "Retry with a fresh drain_id — the next attempt reads the balance again and refunds what is actually left.",
    retryable: true,
    drainRegistered: false,
  },
  refund_floor: {
    display:
      "The refund reached the chain, but it paid less than the balance this service had recorded, so nothing was booked here. Your on-chain refund arrived; the difference has to be reconciled by the service operator.",
    hint: ({ creditId, drainId }) =>
      `Report drain ${drainId} on credit ${creditId} to the service operator — only they can reconcile the difference. Retrying this drain, or requesting a new drain_id, lands here again.`,
    retryable: false,
    // The settlement evidence survives outside the rolled-back ledger transaction. Keep
    // drain_registered:true so the caller retains this effect ID for repair even when no
    // drain row committed.
    drainRegistered: true,
  },
};

/**
 * Discriminate drain requests from top-ups: only a posted drain ID receives drain_registered.
 * An omitted field must not turn a drain response into a top-up response.
 */
type X402SettlementPendingDoor = { door: "drain"; drainId: string } | { door: "top_up" };

/**
 * Return a terminal settlement_pending refusal rather than a new payment challenge. Drain
 * requests retain drain_registered:true and name the admitted blocking drain ID when known;
 * top-ups have no posted drain to register.
 *
 * A written-off refund still blocks funding, but reclaim requires a fresh drain ID, so the
 * old blocking ID is withheld. Optional settlement ID/status carry operator context; draw
 * refusals use the ledger-error response separately.
 */
function x402SettlementPendingRefusal(
  args: {
    message: string;
    settlementId?: string;
    settlementStatus?: string;
    blockingDrainId?: string;
  } & X402SettlementPendingDoor
): Response {
  const admitted = args.blockingDrainId;
  const closedOut = args.settlementStatus === "written_off";
  const topUpReclaim = closedOut
    ? 'Reclaim the balance already on it with op "drain" at POST /v1/credit under a fresh drain_id — the refund was closed out, so the id it was recorded under is dead and only a new one goes through.'
    : admitted
      ? `Reclaim the balance already on it with op "drain" at POST /v1/credit under drain_id ${admitted} — the id this channel's unfinished refund is recorded under, and the only one admitted while the hold is open.`
      : 'Reclaiming it with op "drain" at POST /v1/credit is refused the same way until the service operator closes the refund out, except under a drain_id that was already in flight.';
  return jsonPaymentError("settlement_pending", 409, {
    message: args.message,
    display:
      args.door === "drain"
        ? "An earlier refund of this prepaid balance's payment channel is still being finalized, so this reclaim was not started. Nothing changed, and the balance is still yours."
        : closedOut
          ? "No money was added: an earlier refund of this prepaid balance's payment channel was closed out without being paid, so the channel can't take a deposit. Nothing was charged, and the balance already on it is still yours to reclaim."
          : "No money was added: a refund of this prepaid balance's payment channel is still being finalized, so it can't take a deposit right now. Nothing was charged, and the balance already on it is still yours.",
    hint:
      args.door === "drain"
        ? admitted
          ? `Re-run the reclaim under drain_id ${admitted} — the id this channel's unfinished refund is recorded under, and the only one admitted while the hold is open. Drain ${args.drainId} lands here again, and so does any other fresh drain_id.`
          : "An earlier reclaim on this channel is still being finalized. Retry this drain once the service operator has closed it out; a fresh drain_id will not clear the hold."
        : closedOut
          ? `Topping this balance up lands here again, so there is nothing to retry. ${topUpReclaim} Pay per call, or fund a separate prepaid balance, meanwhile.`
          : `Topping this balance up lands here again until the service operator closes the refund out, so there is nothing to retry. ${topUpReclaim} Pay per call, or fund a separate prepaid balance, meanwhile.`,
    extra: {
      ...(args.door === "drain" ? { drain_registered: true } : {}),
      ...(args.settlementId ? { settlement_id: args.settlementId } : {}),
      ...(args.settlementStatus ? { settlement_status: args.settlementStatus } : {}),
      ...(admitted ? { settlement_drain_id: admitted } : {}),
    },
  });
}

function drainLedgerErrorResponse(
  error: CreditLedgerError,
  creditId: string,
  drainId: string
): Response {
  if (error.code === "nothing_to_drain") {
    return jsonPaymentError("nothing_to_drain", 409, {
      message: `credit ${creditId} has no available balance to drain.`,
      extra: {
        balance_micro: error.details.balanceMicro ?? 0,
        remaining_micro: Math.max(0, error.details.availableMicro ?? 0),
      },
    });
  }
  if (error.code === "drain_below_dust") {
    // The currently available refund is below the net payable floor after delivery reserve.
    // Released job holds can increase it; distinguish this refusal from an empty balance.
    return jsonPaymentError("drain_below_dust", 409, {
      message: error.message,
      extra: {
        balance_micro: error.details.balanceMicro ?? 0,
        remaining_micro: Math.max(0, error.details.availableMicro ?? 0),
        owed_sats: 0,
      },
    });
  }
  if (error.code === "drain_conflict") {
    const copy = error.details.drainConflict
      ? DRAIN_CONFLICT_COPY[error.details.drainConflict]
      : undefined;
    return jsonPaymentError("drain_conflict", 409, {
      message: error.message,
      display: copy?.display,
      hint: copy?.hint({ creditId, drainId }),
      retryable: copy?.retryable,
      extra: { drain_registered: copy?.drainRegistered ?? false },
    });
  }
  if (error.code === "settlement_pending") {
    return x402SettlementPendingRefusal({
      door: "drain",
      message: error.message,
      drainId,
      ...(error.details.settlementId ? { settlementId: error.details.settlementId } : {}),
      ...(error.details.settlementStatus
        ? { settlementStatus: error.details.settlementStatus }
        : {}),
      ...(error.details.blockingDrainId ? { blockingDrainId: error.details.blockingDrainId } : {}),
    });
  }
  if (error.code === "caller_mismatch" || error.code === "credit_not_found") {
    // Same probe-blind answer as the top-of-route gate — a race with a
    // concurrent credit mutation must not widen what a probe learns.
    return jsonPaymentError("credit_not_found", 404, {
      message: `No credit ${creditId} for this caller.`,
    });
  }
  return jsonPaymentError(mapLedgerCode(error), 402, { message: error.message });
}

function isHttpResponse(value: CreditDrainRecord | Response): value is Response {
  return (
    value instanceof Response ||
    (typeof value === "object" && "headers" in value && typeof value.status === "number")
  );
}

function mapLedgerCode(err: CreditLedgerError): Parameters<typeof paymentErrorBody>[0] {
  switch (err.code) {
    case "insufficient_credit":
    case "credit_expired":
    case "credit_unbacked":
    case "credit_not_found":
    case "tempo_channel_closing":
    case "settlement_pending":
    case "nothing_to_drain":
    case "drain_below_dust":
    case "drain_not_found":
    case "drain_conflict":
      return err.code;
    default:
      return "payment_invalid";
  }
}

/**
 * Exclude the owner pubkey from caller balance projection; remaining_micro excludes holds.
 */
function creditBody(
  credit: CreditSnapshot,
  reconciliationPending = false
): Record<string, unknown> {
  return {
    status: credit.status,
    credit_id: credit.creditId,
    currency: credit.currency,
    balance_micro: credit.balanceMicro,
    remaining_micro: credit.availableMicro,
    expiry_ms: credit.expiryMs,
    expired: credit.expired,
    // Nominal expiry does not itself reclaim ownership; a committed sweep can remove undrawn
    // value.
    drainable: credit.status === "active" && credit.availableMicro > 0,
    ...(reconciliationPending && { reconciliation_pending: true }),
    ledger_seq: credit.lastLedgerSeq,
  };
}

/**
 * Active, unexpired, same-currency credits count toward bounds. Positive available value is a
 * separate selection check.
 */
function spendable(credit: CreditSnapshot, currency: string): boolean {
  return !credit.expired && credit.status === "active" && credit.currency === currency;
}

function pickPrimary(credits: CreditSnapshot[], currency: string): CreditSnapshot | undefined {
  let best: CreditSnapshot | undefined;
  for (const credit of credits) {
    if (!spendable(credit, currency) || credit.availableMicro <= 0) continue;
    if (
      !best ||
      credit.availableMicro > best.availableMicro ||
      (credit.availableMicro === best.availableMicro && credit.createdAt > best.createdAt)
    ) {
      best = credit;
    }
  }
  return best;
}
