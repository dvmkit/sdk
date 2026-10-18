import { diagnosticConsole } from "../../observability/diagnostic-console";
import {
  Amount,
  CheckStateEnum,
  getP2PKExpectedWitnessPubkeys,
  getTokenMetadata,
  type ProofLike,
} from "@cashu/cashu-ts";
import type { Context, Hono } from "hono";
import type { BlankSchema, Env } from "hono/types";
import type { Pool } from "pg";

import { normaliseMintUrl } from "../../lib/cashu/verify";
import { getWallet } from "../../lib/cashu/wallet";
import type { FxFetcher } from "../pricing/fx";
import { fiatToSatsCeil, fxRateFor } from "../pricing/index";
import { loadAdminLockPubkeyState } from "./admin-auth-state";
import { verifyAdminAuth } from "./admin-cashu";
import type { ConsumedCredentialStore } from "./consumed-credential-store";
import { commitTerminalDrain } from "./credit-drain-report";
import type {
  BlockedInvoiceCursor,
  ChannelDrainCursor,
  CreditDrainRecord,
  CreditFundingBasis,
  CreditInvoiceRecord,
  CreditLedgerLike,
  DrainStatus,
  DrainTransitionResult,
} from "./credit-ledger";
import type { DrainFulfilment } from "./credit-ledger";
import { CreditLedgerError, DRAIN_METHODS } from "./credit-ledger";
import { netOwedSats } from "./credit-lots";
import { derivedFundCreditId, isDerivedCreditId } from "./funding";
import type { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import type { LightningReceive } from "./lightning-receive";
import type { LockPubkeyState, LockPubkeyStateLoader } from "./lock-pubkey-store";
import { toLockPubkey } from "./lock-pubkey-store";
import type { TempoCloseReconciled, TransactionalPayoutHook } from "./payout-reporter";
import type { ReceiptIssuer } from "./receipt-issuer";
import type { CreditDepositEnqueue, CreditDrainEnqueue } from "./revenue-reporter";
import type { TempoCloseEvidence, TempoDrainRail } from "./tempo-drain-leg";
import { classifyTempoCloseEvidence, completeTempoChannelDrain } from "./tempo-drain-leg";
import {
  fetchRowsForMelt,
  insertAccumulatorRows,
  markRowsDrained,
} from "./wallet-accumulator-store";
import type {
  X402BatchSettlementServer,
  X402SettlementRepair,
  X402WedgedSettlement,
} from "./x402-batch-settlement";
import {
  X402_SPEND_BLOCKING_SETTLEMENT_STATUSES,
  type X402SettlementCursor,
} from "./x402-channel-store";
import { completeX402ChannelDrain } from "./x402-drain-leg";
import {
  X402ExactSettlementEvidenceMissingError,
  type X402ExactSettlementServer,
} from "./x402-exact-settlement";

export interface InstallAdminCreditRoutesOpts {
  /** Pool against the SDK's Postgres — admin state and credit ledger share it. */
  db: Pool;
  /** Identifier of this DVM — bound into every signed admin challenge. */
  dvmId: string;
  ledger: CreditLedgerLike;
  fxFetcher: FxFetcher;
  /** Same accepted-signer set as the cashu admin routes (current + grace). */
  getLockPubkeyState: LockPubkeyStateLoader;
  /** Replay-protection store — shared realm with the cashu admin routes. */
  nonceStore: ConsumedCredentialStore;
  accumulatorWired: boolean;
  /** Countersigns `parked` / `sent` reclaim events when a receipt key exists. */
  receiptIssuer: ReceiptIssuer | undefined;
  /** Credit lifetime this DVM mints, ms — the reconcile verb's TTL. */
  creditTtlMs: () => number;
  /** The DVM's declared ledger denomination — see the drift check in `handleReconcileInvoice`. */
  creditCurrency: () => string;
  /** Reporter-owned deposit outbox write, run inside the reconcile transaction. */
  enqueueCreditDeposit?: CreditDepositEnqueue;
  /** Reporter-owned drain outbox write, run inside the mark-sent transaction. */
  enqueueCreditDrain?: CreditDrainEnqueue;
  /** Receive wallet — re-verifies a blocked invoice was really paid before crediting it. */
  lightningReceive?: LightningReceive;
  /**
   * Resolve lazily so hosts without x402 still mount repair routes and return
   * x402_settlement_unavailable instead of 404. Construction can probe the facilitator.
   */
  x402BatchSettlement?: () => Promise<X402BatchSettlementServer | undefined>;
  x402ExactSettlement?: X402ExactSettlementServer;
  /**
   * Resolve lazily; hosts without Tempo still mount repair routes and return
   * tempo_repair_unavailable instead of 404.
   */
  tempoDrainRail?: () => Promise<TempoDrainRail | undefined>;
  /**
   * Read health-filtered refund mints per request. Unlike funding eligibility, this list
   * answers where a refund should be minted now; absent configuration yields an empty list.
   */
  mints?: () => string[];
  /**
   * Enqueue the repaired close’s payee payout inside its ledger booking transaction. A throw
   * rolls back booking; committed runs only after commit.
   */
  onTempoDrainReconciled?: TransactionalPayoutHook<TempoCloseReconciled>;
  hostedSettlementReports?: { store: HostedSettlementReportObligations };
  walletProvider?: typeof getWallet;
  /** Override for the current time (tests). Returns ms since epoch. */
  now?: () => number;
}

/**
 * Builder-authenticated repair and drain routes share Cashu admin challenge authentication.
 * Credit state is host-wide, so this credential sees all mounted ledger rows.
 *
 * Reconciliation requires wallet or chain evidence, not operator-supplied amounts. Lightning
 * credits the operator’s named target; x402 reconstructs a rolled-back drain effect; Tempo
 * books its already-debited pending drain. Write-off records a decision without moving or
 * restoring money.
 *
 * Bitcoin liability includes undrawn deposits as well as registered drains, so a builder
 * payout sweep can retain caller-owned sats.
 */
export function installAdminCreditRoutes<E extends Env = Env, S extends BlankSchema = BlankSchema>(
  app: Hono<E, S>,
  opts: InstallAdminCreditRoutesOpts
): void {
  app.get("/admin/credit/pending-drains", (c) => handlePendingDrains(c, opts));
  app.get("/admin/credit/bitcoin-liability", (c) => handleBitcoinLiability(c, opts));
  app.post("/admin/credit/park-drain", (c) => handleParkDrain(c, opts));
  app.post("/admin/credit/mark-drain-sent", (c) => handleMarkDrainSent(c, opts));
  app.get("/admin/credit/blocked-invoices", (c) => handleBlockedInvoices(c, opts));
  app.post("/admin/credit/reconcile-invoice", (c) => handleReconcileInvoice(c, opts));
  app.post("/admin/credit/write-off-invoice", (c) => handleWriteOffInvoice(c, opts));
  app.get("/admin/credit/x402-settlements", (c) => handleX402Settlements(c, opts));
  app.post("/admin/credit/reconcile-x402-settlement", (c) => handleReconcileX402(c, opts));
  app.post("/admin/credit/write-off-x402-settlement", (c) => handleWriteOffX402(c, opts));
  app.get("/admin/credit/x402-exact-settlements", (c) => handleX402ExactSettlements(c, opts));
  app.post("/admin/credit/reconcile-x402-exact-settlement", (c) =>
    handleReconcileX402Exact(c, opts)
  );
  app.get("/admin/credit/tempo-close-reports", (c) => handleTempoCloseReports(c, opts));
  app.post("/admin/credit/retry-tempo-close-report", (c) => handleTempoCloseReportAction(c, opts, "retry"));
  app.post("/admin/credit/write-off-tempo-close-report", (c) => handleTempoCloseReportAction(c, opts, "write-off"));
  app.get("/admin/credit/tempo-drains", (c) => handleTempoDrains(c, opts));
  app.get("/admin/credit/tempo-losses", (c) => handleTempoLosses(c, opts));
  app.post("/admin/credit/reconcile-tempo-drain", (c) => handleReconcileTempo(c, opts));
  app.post("/admin/credit/write-off-tempo-drain", (c) => handleWriteOffTempo(c, opts));
}

async function handleX402ExactSettlements(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  if (!opts.x402ExactSettlement) {
    return c.json(
      {
        error: "x402_exact_repair_unavailable",
        message: "Exact x402 settlement repair is not configured on this DVM.",
      },
      503
    );
  }
  const settlement = opts.x402ExactSettlement;
  const limit = c.req.query("limit") === undefined ? 20 : Number(c.req.query("limit"));
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return c.json({ error: "invalid_query", message: "limit must be an integer in 1..50." }, 400);
  }
  const includeResolved = c.req.query("include_resolved") === "true";
  const intents = await settlement.list({
    dvmId: opts.dvmId,
    limit,
    includeResolved,
  });
  const settlements = await Promise.all(
    intents.map(async (intent) => ({
      settlement_intent_id: intent.id,
      status: intent.status,
      network: intent.network,
      asset: intent.asset,
      authorizer: intent.from,
      recipient: intent.to,
      amount: intent.value,
      nonce: intent.nonce,
      transaction: intent.transaction ?? null,
      submission_block: intent.submissionBlock ?? null,
      last_outcome: intent.lastOutcome ?? null,
      credit_id:
        intent.effect?.fundOnly?.creditId ?? intent.effect?.creditEnvelope?.creditId ?? null,
      draw_id: intent.effect?.creditEnvelope?.drawId ?? intent.effect?.topUp?.drawId ?? null,
      job_id: intent.effect?.jobId ?? null,
      created_at: intent.createdAt,
      updated_at: intent.updatedAt,
      resolved_at: intent.resolvedAt ?? null,
      attempts: (await settlement.attempts(opts.dvmId, intent.id)).map((attempt) => ({
        outcome: attempt.outcome,
        detail: attempt.detail ?? null,
        transaction: attempt.transaction ?? null,
        created_at: attempt.createdAt,
      })),
    }))
  );
  return c.json({ settlements });
}

async function handleReconcileX402Exact(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  if (!opts.x402ExactSettlement) {
    return c.json(
      {
        error: "x402_exact_repair_unavailable",
        message: "Exact x402 settlement repair is not configured on this DVM.",
      },
      503
    );
  }
  const body = (await c.req.json().catch(() => null)) as {
    settlement_intent_id?: unknown;
  } | null;
  if (!body || typeof body.settlement_intent_id !== "string" || !body.settlement_intent_id) {
    return c.json(
      {
        error: "invalid_request",
        message: "settlement_intent_id must be a non-empty string.",
      },
      400
    );
  }
  try {
    const result = await opts.x402ExactSettlement.reconcile(opts.dvmId, body.settlement_intent_id);
    return c.json({
      status: "reconciled",
      settlement_status: result.intent.status,
      settlement_intent_id: result.intent.id,
      transaction: result.intent.transaction ?? null,
      amount: result.intent.value,
      credit_id:
        result.intent.effect?.fundOnly?.creditId ??
        result.intent.effect?.creditEnvelope?.creditId ??
        null,
      draw_id:
        result.intent.effect?.creditEnvelope?.drawId ?? result.intent.effect?.topUp?.drawId ?? null,
      job_id: result.intent.effect?.jobId ?? null,
      replayed: result.replayed,
    });
  } catch (err) {
    if (err instanceof X402ExactSettlementEvidenceMissingError) {
      return c.json(
        {
          error: "x402_exact_settlement_not_evidenced",
          message: err.message,
          settlement_intent_id: err.intentId,
        },
        409
      );
    }
    throw err;
  }
}

async function handleTempoLosses(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? 20 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    return c.json({ error: "invalid_query", message: "limit must be an integer in 1..50." }, 400);
  }
  const losses = await opts.ledger.listTempoCreditLosses({ limit });
  return c.json({
    losses: losses.map((loss) => ({
      credit_id: loss.creditId,
      channel_id: loss.channelId,
      caller_pubkey: loss.callerPubkey,
      currency: loss.currency,
      former_balance_micro: loss.formerBalanceMicro,
      settled_on_chain_native: loss.settledOnChainNative.toString(),
      highest_voucher_native: loss.highestVoucherNative.toString(),
      consumed_service_micro: loss.consumedServiceMicro,
      consumed_native: loss.consumedNative.toString(),
      observed_at: loss.observedAt,
      status: "unbacked",
    })),
  });
}

async function requireAuth(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<{ state: LockPubkeyState } | { response: Response }> {
  const loaded = await loadAdminLockPubkeyState(c, opts);
  if ("response" in loaded) return loaded;
  const { state } = loaded;
  const auth = await verifyAdminAuth({
    authHeader: c.req.header("Authorization"),
    method: c.req.method,
    path: c.req.path,
    dvmId: opts.dvmId,
    acceptedPubkeys: [state.current, ...state.retired.map((r) => r.pubkey)],
    nonceStore: opts.nonceStore,
    now: opts.now,
  });
  if (!auth.ok) {
    return { response: c.json({ error: "unauthorized", reason: auth.reason }, 401) };
  }
  return { state };
}

async function handlePendingDrains(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const pending = await opts.ledger.listPendingDrains();
  // Fetch FX only for Cashu drains lacking a recorded in-kind obligation. An outage must not
  // block listing already-priced liabilities.
  const needsRate = pending.some((d) => d.method === "cashu" && d.owedSats === null);
  let rateFor: (currency: string) => number = () => 0;
  if (needsRate) {
    try {
      const fx = await opts.fxFetcher.fetch();
      rateFor = (currency) => fxRateFor(fx, currency);
    } catch {
      return c.json(
        {
          error: "fx_rate_unavailable",
          message: "Cannot price pending drains in sats right now; retry shortly.",
        },
        503
      );
    }
  }

  const drains = pending.map((d) => {
    // Cashu refunds can be serviced as caller-locked notes. Stablecoin rows have no sats
    // payout; a null amount_sats is not an FX failure.
    const automatic = d.method === "cashu";
    // Use the fixed in-kind obligation when available. The legacy live-rate fallback
    // subtracts the same delivery reserve so it does not promise a larger refund on that
    // basis.
    const amountSats = !automatic
      ? null
      : (d.owedSats ?? netOwedSats(fiatToSatsCeil(d.amountMicro / 1_000_000, rateFor(d.currency))));
    // Channel-backed stablecoin drains belong to cooperative reconciliation, not manual
    // settlement. Classifying them as manual could hide the pending close behind an
    // operator’s sent booking.
    const settlement = automatic ? "automatic" : d.channelId === null ? "manual" : "channel";
    return {
      credit_id: d.creditId,
      drain_id: d.drainId,
      method: d.method,
      payout: d.payout,
      currency: d.currency,
      amount_micro: d.amountMicro,
      amount_sats: amountSats,
      amount_msats: amountSats === null ? null : amountSats * 1000,
      sats_basis: amountSats === null ? null : d.owedSats === null ? "rate" : "in_kind",
      // Rail-native debit, distinct from fiat amount_micro. This is the channel refund floor
      // and the size a manual payout must cover.
      amount_native: d.drainedNative,
      settlement,
      channel_id: d.channelId,
      created_at: d.createdAt,
    };
  });

  // Only pending drains remain liabilities: parked notes are caller-locked and sent payouts
  // have left. The Cashu total reserves refunds ahead of a builder payout sweep.
  const liability = {
    cashu_sats: drains
      .filter((d) => d.method === "cashu")
      .reduce((sum, d) => sum + (d.amount_sats ?? 0), 0),
    by_method_micro: DRAIN_METHODS.reduce<Record<string, number>>((acc, method) => {
      acc[method] = pending
        .filter((d) => d.method === method)
        .reduce((sum, d) => sum + d.amountMicro, 0);
      return acc;
    }, {}),
    manual_micro: drains
      .filter((d) => d.settlement === "manual")
      .reduce((sum, d) => sum + d.amount_micro, 0),
    channel_micro: drains
      .filter((d) => d.settlement === "channel")
      .reduce((sum, d) => sum + d.amount_micro, 0),
  };

  // Carry health-filtered mints on this response because a zero-float worker has no
  // accumulator batch from which to discover them.
  return c.json({ drains, liability, mints: opts.mints?.() ?? [] });
}

/**
 * Sum undrawn Bitcoin deposit obligations and registered Cashu drains; neither contains the
 * other. Read funding lots without FX because the liability is in the received asset.
 * Uncovered and basisless balances are reported separately and excluded from this priced sum.
 */
async function handleBitcoinLiability(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const deposit = await opts.ledger.bitcoinDepositLiability();
  const pending = await opts.ledger.listPendingDrains();
  const promised = pending.filter((d) => d.method === "cashu" && d.status === "pending");
  const drainSats = promised.reduce((sum, d) => sum + (d.owedSats ?? 0), 0);
  const drainsUnpriced = promised.filter((d) => d.owedSats === null).length;

  return c.json({
    deposit_liability_sats: deposit.depositSats,
    deposit_credits: deposit.credits,
    deposit_by_rail: deposit.byRail.map((rail) => ({
      rail: rail.rail,
      sats: rail.sats,
      credits: rail.credits,
    })),
    deposit_by_currency: deposit.byCurrency.map((currency) => ({
      currency: currency.currency,
      micro: currency.micro,
      credits: currency.credits,
    })),
    drain_liability_sats: drainSats,
    drain_count: promised.length,
    total_owed_sats: deposit.depositSats + drainSats,
    // Uncovered or basisless balances require whole-balance live-rate pricing and do not
    // contribute to deposit_liability_sats. total_owed_sats alone cannot reserve their
    // eventual refunds.
    uncovered_credits: deposit.uncoveredCredits,
    uncovered_by_currency: deposit.uncoveredByCurrency.map((currency) => ({
      currency: currency.currency,
      micro: currency.micro,
      credits: currency.credits,
    })),
    unbacked_credits: deposit.unbackedCredits,
    unbacked_by_currency: deposit.unbackedByCurrency.map((currency) => ({
      currency: currency.currency,
      micro: currency.micro,
      credits: currency.credits,
    })),
    unpriced_drains: drainsUnpriced,
  });
}

/**
 * Atomically retire consumed accumulator rows, insert change and park the refund token.
 * Independently check caller P2PK locks, accepted builder change locks and NUT-7 UNSPENT
 * states; a tool’s token is not trusted merely because the tool is authenticated.
 */
async function handleParkDrain(c: Context, opts: InstallAdminCreditRoutesOpts): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  if (!opts.accumulatorWired) {
    return c.json(
      {
        error: "accumulator_not_wired",
        message: "Cashu accumulator persistence is not configured on this DVM.",
      },
      503
    );
  }

  let body: {
    credit_id?: unknown;
    drain_id?: unknown;
    token?: unknown;
    consumed_row_ids?: unknown;
    keep_proofs?: unknown;
    mint_evidence?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }
  const creditId = body.credit_id;
  const drainId = body.drain_id;
  const token = body.token;
  if (
    typeof creditId !== "string" ||
    creditId.length === 0 ||
    typeof drainId !== "string" ||
    drainId.length === 0 ||
    typeof token !== "string" ||
    token.length === 0
  ) {
    return c.json(
      {
        error: "invalid_body",
        message: "credit_id, drain_id, and token must be non-empty strings.",
      },
      400
    );
  }
  // Accumulator swaps consume stored rows. A just-in-time Lightning mint consumes none and
  // produces no change, so it must supply its cost evidence.
  const mintEvidence = parseMintEvidence(body.mint_evidence);
  if (mintEvidence === "invalid") {
    return c.json(
      {
        error: "invalid_body",
        message:
          "mint_evidence must be { source: 'jit_mint', mint_url, quote_id, face_sats, reserve_sats, invoice_msats, routing_fee_msats? }.",
      },
      400
    );
  }
  const rowIds = body.consumed_row_ids;
  if (
    !Array.isArray(rowIds) ||
    !rowIds.every((id): id is string => typeof id === "string" && id.length > 0) ||
    (mintEvidence ? rowIds.length > 0 : rowIds.length === 0)
  ) {
    return c.json(
      {
        error: "invalid_body",
        message: mintEvidence
          ? "consumed_row_ids must be empty on a just-in-time mint — it consumed no accumulator rows."
          : "consumed_row_ids must be a non-empty string array.",
      },
      400
    );
  }
  const keepProofs = parseProofArray(body.keep_proofs);
  if (keepProofs === undefined) {
    return c.json(
      {
        error: "invalid_body",
        message: "keep_proofs must be an array of { id, amount, secret, C } (may be empty).",
      },
      400
    );
  }
  if (mintEvidence && keepProofs.length > 0) {
    return c.json(
      {
        error: "invalid_body",
        message:
          "keep_proofs must be empty on a just-in-time mint — the quote was for the refund's face value, so there is no change.",
      },
      400
    );
  }

  const drain = await opts.ledger.getDrain({ creditId, drainId });
  if (!drain) {
    return c.json(
      { error: "drain_not_found", message: `No drain ${drainId} on ${creditId}.` },
      404
    );
  }
  if (drain.method !== "cashu") {
    return c.json(
      {
        error: "invalid_drain_state",
        message: `Drain ${drainId} pays out on ${drain.method}; use mark-drain-sent.`,
      },
      422
    );
  }
  if ((drain.status === "parked" || drain.status === "picked_up") && drain.token === token) {
    return c.json({ status: drain.status, credit_id: creditId, drain_id: drainId });
  }
  if (drain.status !== "pending") {
    return c.json(
      {
        error: "drain_conflict",
        message: `Drain ${drainId} is ${drain.status} with a different token.`,
      },
      409
    );
  }

  // The parked token must be locked to the refund key the caller signed.
  // `getTokenMetadata` yields proofs sans keyset id — enough for both the
  // witness check and NUT-7 checkstate, which key on the secret alone.
  let parsed: { mint: string; faceSats: number; proofs: { secret: string }[] };
  try {
    const meta = getTokenMetadata(token);
    parsed = {
      mint: meta.mint,
      faceSats: Amount.from(meta.amount).toNumber(),
      proofs: meta.incompleteProofs,
    };
  } catch {
    return c.json({ error: "invalid_token", message: "token could not be decoded." }, 400);
  }
  if (parsed.proofs.length === 0) {
    return c.json({ error: "invalid_token", message: "token carries no proofs." }, 400);
  }
  // Validate reported mint and face value against the actual token; otherwise the audit trail
  // would describe a different refund.
  if (mintEvidence) {
    if (normaliseMintUrl(mintEvidence.mintUrl) !== normaliseMintUrl(parsed.mint)) {
      return c.json(
        {
          error: "mint_evidence_mismatch",
          message: `mint_evidence names ${mintEvidence.mintUrl} but the token was minted at ${parsed.mint}.`,
        },
        422
      );
    }
    if (mintEvidence.faceSats !== parsed.faceSats) {
      return c.json(
        {
          error: "mint_evidence_mismatch",
          message: `mint_evidence claims ${mintEvidence.faceSats} sats of face value but the token carries ${parsed.faceSats}.`,
        },
        422
      );
    }
  }
  const refundPubkey = drain.payout.refund_pubkey.toLowerCase();
  for (const proof of parsed.proofs) {
    if (!lockedTo(proof, refundPubkey)) {
      return c.json(
        {
          error: "wrong_lock_pubkey",
          message:
            "One or more parked proofs are not P2PK-locked to the drain's refund_pubkey — refusing to park a token the caller could lose.",
        },
        422
      );
    }
  }
  const accepted = new Set([auth.state.current, ...auth.state.retired.map((r) => r.pubkey)]);
  const keepLockByIndex = keepProofs.map((proof) => {
    const witnesses = witnessPubkeys(proof);
    const match = witnesses.find((w) => accepted.has(toLockPubkey(w)));
    return match ? toLockPubkey(match) : undefined;
  });
  if (keepLockByIndex.some((lock) => lock === undefined)) {
    return c.json(
      {
        error: "wrong_lock_pubkey",
        message: "One or more keep_proofs are not locked to an accepted builder lock pubkey.",
      },
      422
    );
  }

  // NUT-7 rejects spent or pending proofs; a correctly locked but spent token cannot pay a
  // refund.
  const walletProvider = opts.walletProvider ?? getWallet;
  try {
    const wallet = await walletProvider(parsed.mint);
    const states = await wallet.checkProofsStates(parsed.proofs);
    if (states.length !== parsed.proofs.length) {
      throw new Error(
        `mint returned ${states.length} proof states for ${parsed.proofs.length} proofs`
      );
    }
    const offender = states.find((s) => s.state !== CheckStateEnum.UNSPENT);
    if (offender) {
      return c.json(
        {
          error: "proofs_not_unspent",
          message: `Mint reports a parked proof as ${offender.state} — refusing to park a token that cannot be redeemed.`,
        },
        422
      );
    }
  } catch (mintErr) {
    return c.json(
      {
        error: "mint_unreachable",
        message:
          mintErr instanceof Error
            ? mintErr.message
            : "Mint checkstate failed; retry once the mint is reachable.",
        mint_url: parsed.mint,
      },
      502
    );
  }

  const consumed = await fetchRowsForMelt(opts.db, opts.dvmId, rowIds);
  if (consumed.length !== rowIds.length) {
    const found = new Set(consumed.map((r) => r.id));
    return c.json(
      {
        error: "rows_not_found",
        message: "One or more consumed_row_ids do not exist for this DVM.",
        missing_row_ids: rowIds.filter((id) => !found.has(id)),
      },
      404
    );
  }
  const alreadyGone = consumed.filter(
    (r) => r.meltStatus === "melted" || r.meltStatus === "drained"
  );
  if (alreadyGone.length > 0) {
    return c.json(
      {
        error: "rows_already_melted",
        message: "One or more rows already left the accumulator.",
        row_ids: alreadyGone.map((r) => r.id),
      },
      409
    );
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const client = await opts.db.connect();
  try {
    await client.query("BEGIN");
    await markRowsDrained(client, rowIds, drainId, nowMs);
    if (keepProofs.length > 0) {
      await insertAccumulatorRows(opts.db, {
        dvmId: opts.dvmId,
        lockPubkeyByIndex: keepLockByIndex.map((lock) => lock as NonNullable<typeof lock>),
        mintUrl: parsed.mint,
        proofs: keepProofs,
        requestId: `drain:${drainId}`,
        receivedAt: nowMs,
        tx: client,
      });
    }
    await opts.ledger.parkDrain({
      creditId,
      drainId,
      token,
      ...(mintEvidence ? { fulfilment: mintEvidence } : {}),
      tx: client,
      nowMs,
    });
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
    }
    if (err instanceof CreditLedgerError) {
      return c.json({ error: err.code, message: err.message }, 409);
    }
    throw err;
  } finally {
    client.release();
  }

  // Countersign after commit — the transition is the source of truth and the
  // caller collects this receipt on their next poll.
  if (opts.receiptIssuer) {
    const receipt = opts.receiptIssuer.issueDrain({
      creditId,
      drainId,
      event: "parked",
      method: "cashu",
      amountMicro: drain.amountMicro,
      balanceAfterMicro: drain.balanceAfterMicro,
      ledgerSeq: drain.ledgerSeq,
      callerPubkey: drain.callerPubkey,
    });
    await opts.ledger.appendDrainReceipt({
      creditId,
      drainId,
      receipt: receipt as unknown as Record<string, unknown>,
    });
  }

  return c.json({ status: "parked", credit_id: creditId, drain_id: drainId });
}

async function handleMarkDrainSent(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  let body: { credit_id?: unknown; drain_id?: unknown; sent_ref?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }
  const creditId = body.credit_id;
  const drainId = body.drain_id;
  if (
    typeof creditId !== "string" ||
    creditId.length === 0 ||
    typeof drainId !== "string" ||
    drainId.length === 0
  ) {
    return c.json(
      { error: "invalid_body", message: "credit_id and drain_id must be non-empty strings." },
      400
    );
  }
  const sentRef =
    body.sent_ref !== null && typeof body.sent_ref === "object" && !Array.isArray(body.sent_ref)
      ? (body.sent_ref as Record<string, unknown>)
      : {};

  // A reusable channel’s cooperative lifecycle owns this transition. Manual sent booking
  // would hide a pending close from reconciliation and report a payout without its channel
  // evidence. Refuse before CAS or report.
  const existing = await opts.ledger.getDrain({ creditId, drainId });
  if (existing && existing.channelId !== null) {
    return c.json(
      {
        error: "channel_bound_drain",
        message: `drain ${drainId} on credit ${creditId} settles through channel ${existing.channelId}, not by hand`,
      },
      409
    );
  }

  // Commit the terminal CAS and drain report together. Only the non-replayed transition
  // queues it; recovery calls may repeat this endpoint.
  let record: CreditDrainRecord;
  let replayed: boolean;
  try {
    ({ drain: record, replayed } = await commitTerminalDrain(
      {
        db: opts.db,
        dvmId: opts.dvmId,
        enqueueCreditDrain: opts.enqueueCreditDrain,
      },
      (tx) => opts.ledger.markDrainSent({ creditId, drainId, sentRef, tx })
    ));
  } catch (err) {
    if (err instanceof CreditLedgerError) {
      return c.json({ error: err.code, message: err.message }, ledgerRefusalStatus(err.code));
    }
    throw err;
  }

  // Countersign only the transition winner. The store appends observations, so repeating
  // issuance on every recovery call would stack duplicate sent receipts.
  if (!replayed && opts.receiptIssuer) {
    const receipt = opts.receiptIssuer.issueDrain({
      creditId,
      drainId,
      event: "sent",
      method: record.method,
      amountMicro: record.amountMicro,
      balanceAfterMicro: record.balanceAfterMicro,
      ledgerSeq: record.ledgerSeq,
      callerPubkey: record.callerPubkey,
    });
    await opts.ledger.appendDrainReceipt({
      creditId,
      drainId,
      receipt: receipt as unknown as Record<string, unknown>,
    });
  }

  return c.json({ status: "sent", credit_id: creditId, drain_id: drainId, replayed });
}

/**
 * Use keyset pagination so an unresolved queue head cannot starve later blocked invoices. The
 * ledger has no dvm_id: this read spans all mounts sharing the host’s ledger.
 */
async function handleBlockedInvoices(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const limit = parseLimit(c.req.query("limit"));
  if (limit === undefined) {
    return c.json(
      { error: "invalid_query", message: `limit must be an integer in 1..${MAX_INVOICE_PAGE}.` },
      400
    );
  }
  const rawAfter = c.req.query("after");
  const after = rawAfter === undefined ? undefined : parseCursor(rawAfter);
  if (rawAfter !== undefined && after === undefined) {
    return c.json(
      {
        error: "invalid_query",
        message: "after must be a `next_after` value from a previous response.",
      },
      400
    );
  }

  const includeResolved = c.req.query("include_resolved") === "true";
  const invoices = await opts.ledger.listBlockedInvoices({ limit, after, includeResolved });
  const last = invoices.length === limit ? invoices[invoices.length - 1] : undefined;
  return c.json({
    invoices: invoices.map(invoiceBody),
    ...(last ? { next_after: encodeCursor(last) } : {}),
  });
}

/**
 * Credit the amount, currency, caller and rail basis recorded on the blocked invoice to the
 * operator’s named target. Reverify payment first. Skip ordinary residual-balance and
 * rail-minimum sizing because refusing already-received money would strand it again.
 */
async function handleReconcileInvoice(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  let body: { payment_hash?: unknown; credit_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }
  const paymentHash = body.payment_hash;
  const targetCreditId = body.credit_id;
  if (
    typeof paymentHash !== "string" ||
    paymentHash.length === 0 ||
    typeof targetCreditId !== "string" ||
    targetCreditId.length === 0
  ) {
    return c.json(
      { error: "invalid_body", message: "payment_hash and credit_id must be non-empty strings." },
      400
    );
  }

  const invoice = await opts.ledger.getInvoiceByPaymentHash(paymentHash);
  if (!invoice) {
    return c.json(
      { error: "invoice_not_found", message: `No invoice for payment hash ${paymentHash}.` },
      404
    );
  }
  if (
    invoice.status !== "blocked" &&
    invoice.status !== "written_off" &&
    invoice.status !== "reconciled"
  ) {
    return c.json(
      {
        error: "invoice_not_blocked",
        message: `Invoice ${paymentHash} is ${invoice.status}; only a blocked or written-off invoice needs reconciling.`,
      },
      422
    );
  }
  // A reconciled replay must name its original target; another credit would be a second
  // application of the same payment.
  if (invoice.status === "reconciled" && invoice.reconciledCreditId !== targetCreditId) {
    return c.json(
      {
        error: "invoice_already_reconciled",
        message: `Invoice ${paymentHash} was already credited to ${String(invoice.reconciledCreditId)}.`,
        credit_id: invoice.reconciledCreditId,
      },
      409
    );
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  let settledAtMs: number | undefined;
  if (invoice.status !== "reconciled") {
    const verified = await verifySettled(c, opts, invoice);
    if ("response" in verified) return verified.response;
    settledAtMs = verified.settledAt;

    // Refuse denomination drift rather than create a credit no current job can spend.
    // Operator write-off remains available.
    const declared = opts.creditCurrency();
    if (invoice.currency !== declared) {
      return c.json(
        {
          error: "currency_drift",
          message: `Invoice ${paymentHash} is denominated in ${invoice.currency} but this DVM now prices in ${declared}; a credit in ${invoice.currency} could never be drawn from.`,
        },
        422
      );
    }

    const refusal = await checkReconcileTarget(c, opts, invoice, targetCreditId);
    if (refusal) return refusal;
  }

  const existing = await opts.ledger.get(targetCreditId, { nowMs });
  const basis: CreditFundingBasis = {
    rail: "lightning",
    paidMsats: invoice.amountMsats,
    fundingRef: invoice.paymentHash,
  };
  // `fund` overwrites expiry on top-up, so preserve any longer life already
  // present on the target credit.
  const expiryMs = Math.max(nowMs + opts.creditTtlMs(), existing?.expiryMs ?? 0);
  try {
    const result = await opts.ledger.reconcileBlockedInvoice({
      paymentHash,
      targetCreditId,
      expiryMs,
      basis,
      ...(settledAtMs === undefined ? {} : { settledAtMs }),
      ...(opts.enqueueCreditDeposit
        ? {
            depositOutbox: {
              enqueue: opts.enqueueCreditDeposit,
              payload: {
                dvmId: opts.dvmId,
                creditId: targetCreditId,
                callerPubkey: invoice.callerPubkey,
                // The payment hash keys the deposit, as it does on the ordinary
                // settlement path — so a redelivered report collides rather
                // than double-counts.
                fundingId: invoice.paymentHash,
                rail: "lightning",
                paidMsats: invoice.amountMsats,
                amountMicro: invoice.amountMicro,
                creditCurrency: invoice.currency,
                fundedAt: settledAtMs ?? invoice.settledAt ?? nowMs,
                expiryMs,
                repaired: true,
              },
            },
          }
        : {}),
      nowMs,
    });
    return c.json({
      status: "reconciled",
      payment_hash: paymentHash,
      credit_id: targetCreditId,
      fund_id: invoice.paymentHash,
      amount_micro: invoice.amountMicro,
      currency: invoice.currency,
      replayed: result.replayed,
      ...(result.credit ? { credit: creditBody(result.credit) } : {}),
    });
  } catch (err) {
    if (err instanceof CreditLedgerError) {
      // funding_replayed is not invoice reconciliation: a different payment may already
      // occupy the caller-chosen (target, payment_hash) key. Reconcile onto another target
      // rather than claim this invoice credited.
      const status =
        err.code === "invoice_not_found"
          ? 404
          : err.code === "funding_replayed"
            ? 409
            : ledgerRefusalStatus(err.code);
      return c.json({ error: err.code, message: err.message }, status);
    }
    throw err;
  }
}

/**
 * Write-off creates no credit or per-job revenue row. Log the amount on the transition
 * because that decision has no money-report equivalent; wallet funds remain untouched.
 */
async function handleWriteOffInvoice(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  let body: { payment_hash?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400);
  }
  const paymentHash = body.payment_hash;
  if (typeof paymentHash !== "string" || paymentHash.length === 0) {
    return c.json(
      { error: "invalid_body", message: "payment_hash must be a non-empty string." },
      400
    );
  }
  const note = typeof body.note === "string" && body.note.length > 0 ? body.note : undefined;

  const nowMs = opts.now ? opts.now() : Date.now();
  const outcome = await opts.ledger.writeOffBlockedInvoice({ paymentHash, note, nowMs });
  if (!outcome) {
    return c.json(
      { error: "invoice_not_found", message: `No invoice for payment hash ${paymentHash}.` },
      404
    );
  }
  const written = outcome.invoice;
  if (written.status !== "written_off") {
    return c.json(
      {
        error: "invoice_not_blocked",
        message: `Invoice ${paymentHash} is ${written.status}; only a blocked invoice can be written off.`,
      },
      422
    );
  }

  // Log only the transition so retries do not duplicate the recorded operator decision.
  if (outcome.written) {
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "lightning_invoice_written_off",
        message:
          undefined,
        payment_hash: written.paymentHash,
        credit_id: written.creditId,
        fund_id: written.fundId,
        blocked_reason: written.blockedReason,
        amount_msats: written.amountMsats,
        amount_micro: written.amountMicro,
        currency: written.currency,
        note: undefined,
      }
    );
  }

  return c.json({
    status: "written_off",
    payment_hash: paymentHash,
    amount_micro: written.amountMicro,
    currency: written.currency,
    note: written.writeOffNote,
    replayed: !outcome.written,
  });
}

/**
 * The facilitator response survives outside the refused ledger transaction. Age and
 * keyset-page unresolved rows; per-row chain-read failure is classified as unreachable
 * without failing the page.
 */
async function handleX402Settlements(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const repair = await resolveX402Repair(c, opts);
  if ("response" in repair) return repair.response;

  const limit = parseX402Limit(c.req.query("limit"));
  if (limit === undefined) {
    return c.json(
      {
        error: "invalid_query",
        message: `limit must be an integer in 1..${MAX_X402_SETTLEMENT_PAGE}.`,
      },
      400
    );
  }
  const rawAfter = c.req.query("after");
  const after = rawAfter === undefined ? undefined : parseX402Cursor(rawAfter);
  if (rawAfter !== undefined && after === undefined) {
    return c.json(
      {
        error: "invalid_query",
        message: "after must be a `next_after` value from a previous response.",
      },
      400
    );
  }
  const minAge = parseMinAge(c.req.query("min_age_ms"));
  if (minAge === undefined) {
    return c.json(
      { error: "invalid_query", message: "min_age_ms must be a non-negative integer." },
      400
    );
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const page = await repair.repair.list({
    limit,
    ...(after ? { after } : {}),
    updatedBeforeMs: nowMs - minAge,
    includeResolved: c.req.query("include_resolved") === "true",
    evidence: c.req.query("evidence") !== "false",
  });
  const rows = await Promise.all(
    page.settlements.map((row) =>
      settlementBody(row, opts.ledger.getCreditByX402Channel.bind(opts.ledger))
    )
  );
  return c.json({
    settlements: rows,
    ...(page.nextAfter ? { next_after: encodeX402Cursor(page.nextAfter) } : {}),
  });
}

/**
 * Reconstruct the refund’s ledger effect from chain evidence. Require at least the native
 * liability; record excess as caller surplus. Shortfalls require write-off rather than
 * lowering the floor.
 */
async function handleReconcileX402(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const repair = await resolveX402Repair(c, opts);
  if ("response" in repair) return repair.response;

  const parsed = await readSettlementId(c);
  if ("response" in parsed) return parsed.response;
  const settlementId = parsed.settlementId;

  const bound = await resolveDrainEffect(c, opts, repair.repair, settlementId);
  if ("response" in bound) return bound.response;
  const { creditId, drainId, callerPubkey, channelId } = bound;

  const nowMs = opts.now ? opts.now() : Date.now();
  let outcome;
  try {
    outcome = await repair.repair.reconcile({
      settlementId,
      nowMs,
      commit: async (_intent, tx) => {
        const requested = await opts.ledger.requestDrain({
          creditId,
          drainId,
          callerPubkey,
          method: "x402",
          payout: { channel_id: channelId },
          tx,
        });
        // The caller path's guard, and it holds here for the same reason: a
        // channel closed while a job's hold is outstanding leaves that job's
        // later settle uncollectable.
        if (requested.credit.balanceMicro !== 0) {
          throw new CreditLedgerError(
            "drain_conflict",
            `credit ${creditId} has pending draws that must finish before its channel can be reconciled`
          );
        }
        return requested;
      },
      complete: async (evidence, requested, tx) => {
        const terminal = await completeX402ChannelDrain({
          deps: {
            ledger: opts.ledger,
            drainReport: {
              db: opts.db,
              dvmId: opts.dvmId,
              ...(opts.enqueueCreditDrain ? { enqueueCreditDrain: opts.enqueueCreditDrain } : {}),
            },
          },
          creditId,
          drainId,
          channelId,
          settledAmount: evidence.amount,
          debitedNative: requested.drain.drainedNative,
          transaction: evidence.transaction,
          repaired: true,
          tx,
        });
        return { ...requested, drain: terminal.drain };
      },
    });
  } catch (err) {
    if (err instanceof CreditLedgerError) {
      return c.json({ error: err.code, message: err.message }, ledgerRefusalStatus(err.code));
    }
    throw err;
  }
  if ("refusal" in outcome) return x402RefusalResponse(c, outcome);

  const drain = outcome.committed?.drain ?? (await opts.ledger.getDrain({ creditId, drainId }));
  if (drain && opts.receiptIssuer && !outcome.replayed) {
    const receipt = opts.receiptIssuer.issueDrain({
      creditId,
      drainId,
      event: "sent",
      method: drain.method,
      amountMicro: drain.amountMicro,
      balanceAfterMicro: drain.balanceAfterMicro,
      ledgerSeq: drain.ledgerSeq,
      callerPubkey: drain.callerPubkey,
    });
    await opts.ledger.appendDrainReceipt({
      creditId,
      drainId,
      receipt: receipt as unknown as Record<string, unknown>,
    });
  }

  return c.json({
    status: "reconciled",
    settlement_id: settlementId,
    channel_id: channelId,
    credit_id: creditId,
    drain_id: drainId,
    transaction: outcome.evidence?.transaction ?? null,
    settled_amount: outcome.evidence?.amount ?? null,
    amount_micro: drain?.amountMicro ?? null,
    currency: drain?.currency ?? null,
    replayed: outcome.replayed,
  });
}

/**
 * Write-off books and unwinds no money. A later reconcile may still accept the settlement;
 * the transition log records the operator’s decision separately.
 */
async function handleWriteOffX402(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const repair = await resolveX402Repair(c, opts);
  if ("response" in repair) return repair.response;

  const parsed = await readSettlementId(c);
  if ("response" in parsed) return parsed.response;
  let note: string | undefined;
  try {
    const body: { note?: unknown } = await c.req.json();
    note = typeof body.note === "string" && body.note.length > 0 ? body.note : undefined;
  } catch {
    note = undefined;
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const outcome = await repair.repair.writeOff({
    settlementId: parsed.settlementId,
    ...(note === undefined ? {} : { note }),
    nowMs,
  });
  if ("refusal" in outcome) return x402RefusalResponse(c, outcome);

  // Log only the transition; retries must not duplicate the operator decision.
  if (outcome.written) {
    const credit = await opts.ledger.getCreditByX402Channel(outcome.intent.channelId);
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "x402_settlement_written_off",
        message:
          undefined,
        settlement_id: outcome.intent.settlementId,
        channel_id: outcome.intent.channelId,
        operation: outcome.intent.operation,
        effect_id: outcome.intent.effectId,
        credit_id: credit?.creditId ?? null,
        settled_amount: outcome.intent.response?.amount ?? null,
        note: undefined,
      }
    );
  }

  return c.json({
    status: "written_off",
    settlement_id: outcome.intent.settlementId,
    channel_id: outcome.intent.channelId,
    effect_id: outcome.intent.effectId,
    note: outcome.intent.writeOffNote ?? null,
    replayed: !outcome.written,
  });
}

export interface TempoCloseReportSummary {
  obligation_id: string;
  channel_id: string;
  /** Potential builder payout, as a decimal string in native token units. */
  amount_native: string;
  status: "unmatched" | "no_report";
  created_at_ms: number;
  updated_at_ms: number;
  delivered_at_ms: number | null;
  /** Snapshot of the store's retry predicate; a later state change can still cause a conflict. */
  retryable: boolean;
  write_off_allowed: boolean;
  /** True when a retained write-off decision exists, including after an explicit retry. */
  written_off: boolean;
  write_off_note: string | null;
  written_off_at_ms: number | null;
}

export interface TempoCloseReportsResponse {
  reports: TempoCloseReportSummary[];
  next_after?: string;
}

export interface RetryTempoCloseReportResponse {
  status: "reserved";
  obligation_id: string;
}

export interface WriteOffTempoCloseReportResponse {
  status: "written_off";
  obligation_id: string;
  channel_id: string;
  /** Builder payout abandoned, as a decimal string in native token units. */
  amount_forgone_native: string;
  note: string;
}

function tempoCloseReportsUnavailable(c: Context): Response {
  return c.json({
    error: "tempo_close_report_unavailable",
    message: "Hosted settlement reports are not configured on this DVM.",
  }, 503);
}

async function handleTempoCloseReports(c: Context, opts: InstallAdminCreditRoutesOpts): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  if (!opts.hostedSettlementReports) return tempoCloseReportsUnavailable(c);
  const limit = parseTempoLimit(c.req.query("limit"));
  if (limit === undefined) {
    return c.json({ error: "invalid_query", message: "limit must be an integer in 1..50." }, 400);
  }
  let after: { createdAtMs: number; obligationId: string } | undefined;
  const rawAfter = c.req.query("after");
  if (rawAfter !== undefined) {
    try {
      const value: unknown = JSON.parse(Buffer.from(rawAfter, "base64url").toString("utf8"));
      if (!Array.isArray(value) || value.length !== 2 || !Number.isSafeInteger(value[0]) ||
        value[0] < 0 || typeof value[1] !== "string" || !value[1]) throw new Error("invalid cursor");
      after = { createdAtMs: value[0] as number, obligationId: value[1] };
    } catch {
      return c.json({ error: "invalid_query", message: "after must be a next_after value from a previous response." }, 400);
    }
  }
  const all = c.req.query("all");
  if (all !== undefined && all !== "0" && all !== "1") {
    return c.json({ error: "invalid_query", message: "all must be 0 or 1." }, 400);
  }
  const rows = await opts.hostedSettlementReports.store.listTempoCloseReports({ limit, after, all: all === "1" });
  const last = rows.length === limit ? rows.at(-1) : undefined;
  const response: TempoCloseReportsResponse = {
    reports: rows.map(row => ({
      obligation_id: row.id, channel_id: row.channelId, amount_native: row.amountNative,
      status: row.status, created_at_ms: row.createdAtMs, updated_at_ms: row.updatedAtMs,
      delivered_at_ms: row.deliveredAtMs, retryable: row.retryable,
      write_off_allowed: row.writeOffAllowed, written_off: row.writtenOff,
      write_off_note: row.writeOffNote, written_off_at_ms: row.writtenOffAtMs,
    })),
    ...(last ? { next_after: Buffer.from(JSON.stringify([last.createdAtMs, last.id])).toString("base64url") } : {}),
  };
  return c.json(response);
}

async function handleTempoCloseReportAction(
  c: Context, opts: InstallAdminCreditRoutesOpts, action: "retry" | "write-off"
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;
  const reports = opts.hostedSettlementReports;
  if (!reports) return tempoCloseReportsUnavailable(c);
  const body = await c.req.json().catch(() => null) as { obligation_id?: unknown; note?: unknown } | null;
  if (!body || typeof body.obligation_id !== "string" || !body.obligation_id.trim()) {
    return c.json({ error: "invalid_request", message: "obligation_id must be a non-empty string." }, 400);
  }
  const obligationId = body.obligation_id.trim();
  if (action === "retry") {
    if (await reports.store.reopenTempoClose(obligationId)) {
      const response: RetryTempoCloseReportResponse = { status: "reserved", obligation_id: obligationId };
      return c.json(response);
    }
  } else {
    if (typeof body.note !== "string" || !body.note.trim() || body.note.trim().length > 2_000) {
      return c.json({ error: "invalid_request", message: "note must contain 1 to 2000 characters after trimming." }, 400);
    }
    const note = body.note.trim();
    const result = await reports.store.writeOffTempoClose(obligationId, note);
    if (result) {
      const response: WriteOffTempoCloseReportResponse = {
        status: "written_off", obligation_id: obligationId, channel_id: result.channelId,
        amount_forgone_native: result.amount, note,
      };
      return c.json(response);
    }
  }
  if (!await reports.store.hasTempoCloseReport(obligationId)) {
    return c.json({ error: "tempo_close_report_not_found", message: "Close-report obligation not found.",
      obligation_id: obligationId }, 404);
  }
  return c.json({ error: "tempo_close_report_conflict",
    message: action === "retry"
      ? "Retry requires an unsubmitted unmatched or no_report close obligation without a competing report."
      : "Write-off requires an unsubmitted unmatched close obligation.",
    obligation_id: obligationId }, 409);
}

/**
 * Tempo reserves and debits its drain before checking the landed refund. A shortfall
 * therefore leaves a closed channel and pending debited drain, unlike x402’s rolled-back
 * drain. Age and keyset-page these rows; classify each chain-read failure without failing the
 * page.
 */
async function handleTempoDrains(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const rail = await resolveTempoRepair(c, opts);
  if ("response" in rail) return rail.response;

  const limit = parseTempoLimit(c.req.query("limit"));
  if (limit === undefined) {
    return c.json(
      {
        error: "invalid_query",
        message: `limit must be an integer in 1..${MAX_TEMPO_DRAIN_PAGE}.`,
      },
      400
    );
  }
  const rawAfter = c.req.query("after");
  const after = rawAfter === undefined ? undefined : parseTempoCursor(rawAfter);
  if (rawAfter !== undefined && after === undefined) {
    return c.json(
      {
        error: "invalid_query",
        message: "after must be a `next_after` value from a previous response.",
      },
      400
    );
  }
  const minAge = parseMinAge(c.req.query("min_age_ms"));
  if (minAge === undefined) {
    return c.json(
      { error: "invalid_query", message: "min_age_ms must be a non-negative integer." },
      400
    );
  }

  const nowMs = opts.now ? opts.now() : Date.now();
  const drains = await opts.ledger.listChannelDrains({
    limit,
    ...(after ? { after } : {}),
    createdBeforeMs: nowMs - minAge,
    rail: "tempo",
    includeResolved: c.req.query("include_resolved") === "true",
  });
  const wantsEvidence = c.req.query("evidence") !== "false";
  const rows: Record<string, unknown>[] = [];
  for (const drain of drains) {
    const evidence =
      wantsEvidence && drain.channelId
        ? await classifyTempoCloseEvidence(rail.rail, drain.channelId)
        : undefined;
    rows.push(tempoDrainBody(drain, evidence));
  }
  const last = drains.length === limit ? drains[drains.length - 1] : undefined;
  return c.json({
    drains: rows,
    ...(last
      ? {
          next_after: encodeTempoCursor({
            createdAt: last.createdAt,
            creditId: last.creditId,
            drainId: last.drainId,
          }),
        }
      : {}),
  });
}

/*
 * Repair a drain by re-reading the chain close evidence named by its confirmed intent, then
 * use the same completion/floor path as caller polling. Read RPC evidence before acquiring a
 * SQL client. A shortfall refuses with both amounts; write-off records an operator decision
 * without booking it.
 */
async function handleReconcileTempo(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const rail = await resolveTempoRepair(c, opts);
  if ("response" in rail) return rail.response;

  const parsed = await readTempoDrainId(c);
  if ("response" in parsed) return parsed.response;

  const drain = await requireWedgedTempoDrain(c, opts, parsed, true);
  if ("response" in drain) return drain.response;
  const { record, channelId } = drain;

  // Return already-sent evidence before chain RPC; replay must not issue a second receipt.
  if (record.status === "sent") return tempoReconciledBody(c, record, channelId, true);

  const evidence = await classifyTempoCloseEvidence(rail.rail, channelId);
  if (evidence.chain !== "found") return tempoEvidenceRefusal(c, evidence);

  // Ledger booking, drain report and payout report share this caller-owned transaction. A
  // refusal or enqueue failure rolls back all three.
  const client = await opts.db.connect();
  let booked: DrainTransitionResult;
  try {
    await client.query("BEGIN");
    booked = await completeTempoChannelDrain({
      deps: {
        ledger: opts.ledger,
        drainReport: {
          db: opts.db,
          dvmId: opts.dvmId,
          ...(opts.enqueueCreditDrain ? { enqueueCreditDrain: opts.enqueueCreditDrain } : {}),
        },
      },
      creditId: record.creditId,
      drainId: record.drainId,
      channelId,
      refundedNative: evidence.refundedToPayer,
      debitedNative: record.drainedNative,
      reference: evidence.transaction,
      repaired: true,
      tx: client,
    });
    if (opts.onTempoDrainReconciled && !booked.replayed) {
      await opts.onTempoDrainReconciled.enqueue(
        {
          channelId,
          txHash: evidence.transaction,
          settledToPayee: evidence.settledToPayee,
        },
        client
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err instanceof CreditLedgerError) {
      return c.json({ error: err.code, message: err.message }, ledgerRefusalStatus(err.code));
    }
    throw err;
  } finally {
    client.release();
  }
  if (!booked.replayed) opts.onTempoDrainReconciled?.committed();

  // Only the transition winner countersigns, including when caller polling races this repair.
  // A duplicate signed receipt would claim the same payment again.
  if (opts.receiptIssuer && !booked.replayed) {
    const receipt = opts.receiptIssuer.issueDrain({
      creditId: booked.drain.creditId,
      drainId: booked.drain.drainId,
      event: "sent",
      method: booked.drain.method,
      amountMicro: booked.drain.amountMicro,
      balanceAfterMicro: booked.drain.balanceAfterMicro,
      ledgerSeq: booked.drain.ledgerSeq,
      callerPubkey: booked.drain.callerPubkey,
    });
    await opts.ledger.appendDrainReceipt({
      creditId: booked.drain.creditId,
      drainId: booked.drain.drainId,
      receipt: receipt as unknown as Record<string, unknown>,
    });
  }

  return tempoReconciledBody(c, booked.drain, channelId, booked.replayed);
}

/**
 * Write-off leaves the drain pending and its balance debited; it neither refunds ledger value
 * nor books a missing chain payout. Later reconciliation can clear the note transactionally.
 * Refuse already-sent drains rather than describing a booked close as unpaid.
 */
async function handleWriteOffTempo(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<Response> {
  const auth = await requireAuth(c, opts);
  if ("response" in auth) return auth.response;

  const parsed = await readTempoDrainId(c);
  if ("response" in parsed) return parsed.response;
  let note: string | undefined;
  try {
    const body: { note?: unknown } = await c.req.json();
    note = typeof body.note === "string" && body.note.length > 0 ? body.note : undefined;
  } catch {
    note = undefined;
  }

  const drain = await requireWedgedTempoDrain(c, opts, parsed, false);
  if ("response" in drain) return drain.response;

  const outcome = await opts.ledger.writeOffDrain({
    creditId: parsed.creditId,
    drainId: parsed.drainId,
    ...(note === undefined ? {} : { note }),
    nowMs: opts.now ? opts.now() : Date.now(),
  });
  if (!outcome) {
    return c.json(
      {
        error: "drain_not_found",
        message: `drain ${parsed.drainId} on credit ${parsed.creditId} not found`,
      },
      404
    );
  }
  // Recheck the CAS result because caller polling can book after the initial status read. A
  // no-op on sent must not answer written_off.
  if (!outcome.written && outcome.drain.status !== "pending") {
    return tempoNotWedgedRefusal(c, parsed, outcome.drain.status);
  }

  // Log only the transition; retries must not duplicate the operator decision.
  if (outcome.written) {
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "tempo_drain_written_off",
        message:
          undefined,
        credit_id: outcome.drain.creditId,
        drain_id: outcome.drain.drainId,
        channel_id: outcome.drain.channelId,
        amount_micro: outcome.drain.amountMicro,
        amount_native: outcome.drain.drainedNative,
        currency: outcome.drain.currency,
        note: undefined,
      }
    );
  }

  return c.json({
    status: "written_off",
    credit_id: outcome.drain.creditId,
    drain_id: outcome.drain.drainId,
    channel_id: outcome.drain.channelId,
    amount_micro: outcome.drain.amountMicro,
    amount_native: outcome.drain.drainedNative,
    currency: outcome.drain.currency,
    note: outcome.drain.writeOffNote ?? null,
    replayed: !outcome.written,
  });
}

const MAX_INVOICE_PAGE = 200;

/**
 * Chain-log scans make this page more expensive than blocked-invoice pages.
 */
const MAX_X402_SETTLEMENT_PAGE = 50;

/**
 * Age out ordinary in-flight settlements before showing them as repair work.
 */
const DEFAULT_X402_MIN_AGE_MS = 5 * 60_000;

async function resolveX402Repair(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<{ repair: X402SettlementRepair } | { response: Response }> {
  const server = opts.x402BatchSettlement ? await opts.x402BatchSettlement() : undefined;
  if (!server?.repair) {
    return {
      response: c.json(
        {
          error: "x402_settlement_unavailable",
          message:
            "This DVM has no durable x402 batch-settlement store, so it holds no settlements to repair.",
        },
        503
      ),
    };
  }
  return { repair: server.repair };
}

async function readSettlementId(
  c: Context
): Promise<{ settlementId: string } | { response: Response }> {
  let body: { settlement_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return {
      response: c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400),
    };
  }
  const settlementId = body.settlement_id;
  if (typeof settlementId !== "string" || settlementId.length === 0) {
    return {
      response: c.json(
        { error: "invalid_body", message: "settlement_id must be a non-empty string." },
        400
      ),
    };
  }
  return { settlementId };
}

/**
 * Turn a wedged refund settlement back into the ledger effect it was supposed
 * to book: the credit, its owner, and the drain id the effect encodes.
 *
 * The credit is resolved from the **channel**, not by splitting `effect_id` on
 * a colon — credit ids carry their own (`imp:<rail>:<payment id>`, `fnd:…`), so
 * a naive split lands on the wrong side of one. With the credit id in hand the
 * drain id is what remains of the effect after its prefix, which is exact.
 */
async function resolveDrainEffect(
  c: Context,
  opts: InstallAdminCreditRoutesOpts,
  repair: X402SettlementRepair,
  settlementId: string
): Promise<
  | { creditId: string; drainId: string; callerPubkey: string; channelId: string }
  | { response: Response }
> {
  const intent = await repair.get(settlementId);
  if (!intent) {
    return {
      response: c.json(
        { error: "settlement_not_found", message: `No x402 settlement ${settlementId}.` },
        404
      ),
    };
  }
  if (intent.operation !== "refund") {
    return {
      response: c.json(
        {
          error: "settlement_not_repairable",
          message: `Settlement ${settlementId} is a deposit, not a refund. A wedged deposit is recovered by the caller re-presenting it, and its ledger leg is a fund-and-draw this surface cannot reconstruct.`,
        },
        422
      ),
    };
  }
  const credit = await opts.ledger.getCreditByX402Channel(intent.channelId);
  if (!credit) {
    return {
      response: c.json(
        {
          error: "credit_not_bound",
          message: `No credit is bound to x402 channel ${intent.channelId}, so there is no liability to extinguish.`,
        },
        404
      ),
    };
  }
  const prefix = `${credit.creditId}:`;
  if (!intent.effectId.startsWith(prefix)) {
    return {
      response: c.json(
        {
          error: "settlement_not_repairable",
          message: `Settlement ${settlementId} names effect ${intent.effectId}, which is not a drain on credit ${credit.creditId}.`,
        },
        422
      ),
    };
  }
  return {
    creditId: credit.creditId,
    drainId: intent.effectId.slice(prefix.length),
    callerPubkey: credit.callerPubkey,
    channelId: intent.channelId,
  };
}

/** Repair refusals → HTTP. The chain-outcome split is the load-bearing part. */
function x402RefusalResponse(
  c: Context,
  outcome: { refusal: string; status?: string; error?: string }
): Response {
  switch (outcome.refusal) {
    case "settlement_not_found":
      return c.json({ error: "settlement_not_found", message: "No such x402 settlement." }, 404);
    case "settlement_not_wedged":
      return c.json(
        {
          error: "settlement_not_wedged",
          message: `Settlement is ${outcome.status ?? "unknown"}; only one stuck between chain and ledger can be repaired.`,
        },
        422
      );
    case "settlement_not_repairable":
      return c.json(
        {
          error: "settlement_not_repairable",
          message:
            "This settlement is a deposit, not a cooperative refund. A wedged deposit is recovered by the caller re-presenting it.",
        },
        422
      );
    case "settlement_unbookmarked":
      return c.json(
        {
          error: "settlement_unbookmarked",
          message:
            "This settlement recorded no submission block, so there is no range to scan and no definitive answer to give. Write it off rather than guessing.",
        },
        422
      );
    case "settlement_raced":
      // Two repairs on one settlement, or a caller retry that completed it
      // mid-repair. Nothing was booked twice — the loser's CAS is what failed —
      // so this is a re-read, not a repair: `x402-wedged` will show whether the
      // winner finished it.
      return c.json(
        {
          error: "settlement_raced",
          message: `Another repair or a caller retry moved this settlement while it was being reconciled (${outcome.error ?? "status changed"}). Nothing was booked twice; re-read the settlement before acting again.`,
        },
        409
      );
    case "settlement_not_on_chain":
      // Definitive, and deliberately not the same answer as an unreachable
      // RPC: the chain was read from the submission bookmark to head and this
      // settlement is not on it, which is a fact an operator can act on.
      return c.json(
        {
          error: "settlement_not_on_chain",
          message:
            "The chain carries no settlement matching this intent between its submission block and head. Nothing was booked.",
        },
        422
      );
    default:
      return c.json(
        {
          error: "chain_unreachable",
          message: `Could not read the chain to confirm this settlement: ${outcome.error ?? "unknown error"}. This says nothing about whether the money moved — retry, or re-point the RPC endpoint first.`,
        },
        502
      );
  }
}

/**
 * Wire projection of one repair-queue row.
 *
 * Carries the credit's own figures alongside the settlement's, because the two
 * together are the decision: `credit_balance_micro` is what the caller is still
 * holding against escrow the chain may already have paid back, and
 * `spending_blocked` says whether draws on it are being refused
 * `settlement_pending` in the meantime. A row with a live balance and
 * spending blocked is a caller who cannot use their money until this is closed
 * out — the item to reach for first.
 */
async function settlementBody(
  row: X402WedgedSettlement,
  creditForChannel: (
    channelId: string
  ) => Promise<
    { creditId: string; balanceMicro: number; availableMicro: number; currency: string } | undefined
  >
): Promise<Record<string, unknown>> {
  const { intent } = row;
  const credit = await creditForChannel(intent.channelId);
  const prefix = credit ? `${credit.creditId}:` : undefined;
  return {
    settlement_id: intent.settlementId,
    channel_id: intent.channelId,
    operation: intent.operation,
    effect_id: intent.effectId,
    credit_id: credit?.creditId ?? null,
    drain_id:
      prefix && intent.effectId.startsWith(prefix) ? intent.effectId.slice(prefix.length) : null,
    credit_balance_micro: credit?.balanceMicro ?? null,
    credit_remaining_micro: credit?.availableMicro ?? null,
    credit_currency: credit?.currency ?? null,
    spending_blocked: X402_SPEND_BLOCKING_SETTLEMENT_STATUSES.includes(intent.status),
    status: intent.status,
    submission_block: intent.submissionBlock ?? null,
    settled_amount: intent.response?.amount ?? null,
    settled_transaction: intent.response?.transaction ?? null,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
    resolved_at: intent.resolvedAt ?? null,
    write_off_note: intent.writeOffNote ?? null,
    ...(row.evidence ? { chain: row.evidence } : {}),
  };
}

function parseX402Limit(raw: string | undefined): number | undefined {
  if (raw === undefined) return 20;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_X402_SETTLEMENT_PAGE) {
    return undefined;
  }
  return parsed;
}

function parseMinAge(raw: string | undefined): number | undefined {
  if (raw === undefined) return DEFAULT_X402_MIN_AGE_MS;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

/**
 * Postgres's own `timestamptz` text form, which is what the cursor carries and
 * what it is cast back to. Validated rather than trusted: the value reaches SQL
 * as a `::timestamptz` cast, so anything else is a 500 from a failed cast where
 * the operator is owed a 400 naming the bad cursor.
 */
const PG_TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2}){0,2}$/;

function encodeX402Cursor(cursor: X402SettlementCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.settlementId])).toString("base64url");
}

function parseX402Cursor(raw: string): X402SettlementCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [createdAt, settlementId] = parsed as unknown[];
    if (typeof createdAt !== "string" || typeof settlementId !== "string") return undefined;
    if (!PG_TIMESTAMPTZ.test(createdAt)) return undefined;
    return { createdAt, settlementId };
  } catch {
    return undefined;
  }
}

/**
 * Largest page `tempo-drains` will serve. The x402 queue's ceiling, for the
 * same reason: every row may cost an RPC round trip for its close receipt.
 */
const MAX_TEMPO_DRAIN_PAGE = 50;

function parseTempoLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return 20;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_TEMPO_DRAIN_PAGE) {
    return undefined;
  }
  return parsed;
}

/**
 * Preserve epoch milliseconds in the Tempo cursor. Unlike timestamptz text, this BIGINT value
 * has no microsecond precision to lose on a round trip.
 */
function encodeTempoCursor(cursor: ChannelDrainCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.creditId, cursor.drainId])).toString(
    "base64url"
  );
}

function parseTempoCursor(raw: string): ChannelDrainCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [createdAt, creditId, drainId] = parsed as unknown[];
    if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0) {
      return undefined;
    }
    if (typeof creditId !== "string" || typeof drainId !== "string") return undefined;
    return { createdAt, creditId, drainId };
  } catch {
    return undefined;
  }
}

async function resolveTempoRepair(
  c: Context,
  opts: InstallAdminCreditRoutesOpts
): Promise<{ rail: TempoDrainRail } | { response: Response }> {
  const rail = opts.tempoDrainRail ? await opts.tempoDrainRail() : undefined;
  if (!rail?.getTempoSessionCloseIntent) {
    return {
      response: c.json(
        {
          error: "tempo_repair_unavailable",
          message:
            "This DVM has no durable Tempo session store, so it holds no cooperative closes to repair.",
        },
        503
      ),
    };
  }
  return { rail };
}

async function readTempoDrainId(
  c: Context
): Promise<{ creditId: string; drainId: string } | { response: Response }> {
  let body: { credit_id?: unknown; drain_id?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return {
      response: c.json({ error: "invalid_body", message: "Request body must be JSON." }, 400),
    };
  }
  const { credit_id: creditId, drain_id: drainId } = body;
  if (typeof creditId !== "string" || creditId.length === 0) {
    return {
      response: c.json(
        { error: "invalid_body", message: "credit_id must be a non-empty string." },
        400
      ),
    };
  }
  if (typeof drainId !== "string" || drainId.length === 0) {
    return {
      response: c.json(
        { error: "invalid_body", message: "drain_id must be a non-empty string." },
        400
      ),
    };
  }
  return { creditId, drainId };
}

/**
 * Only reconciliation admits sent as replay. Write-off accepts pending alone; otherwise its
 * no-op CAS could misreport an already-booked payout as written_off.
 */
async function requireWedgedTempoDrain(
  c: Context,
  opts: InstallAdminCreditRoutesOpts,
  args: { creditId: string; drainId: string },
  admitBooked: boolean
): Promise<{ record: CreditDrainRecord; channelId: string } | { response: Response }> {
  const record = await opts.ledger.getDrain(args);
  if (!record) {
    return {
      response: c.json(
        {
          error: "drain_not_found",
          message: `drain ${args.drainId} on credit ${args.creditId} not found`,
        },
        404
      ),
    };
  }
  if (record.method !== "tempo" || record.channelId === null) {
    return {
      response: c.json(
        {
          error: "drain_not_repairable",
          message: `drain ${args.drainId} pays out on ${record.method} without a Tempo session channel; this verb repairs cooperative closes only.`,
        },
        422
      ),
    };
  }
  if (record.status !== "pending" && !(admitBooked && (record.status === "sent" || record.status === "exit_required"))) {
    return { response: tempoNotWedgedRefusal(c, args, record.status) };
  }
  return { record, channelId: record.channelId };
}

function tempoNotWedgedRefusal(
  c: Context,
  args: { creditId: string; drainId: string },
  status: DrainStatus
): Response {
  return c.json(
    {
      error: "drain_not_wedged",
      message:
        status === "sent"
          ? `drain ${args.drainId} on credit ${args.creditId} is already booked as sent, so there is nothing to write off — its close paid, and recording a write-off would say otherwise.`
          : `drain ${args.drainId} on credit ${args.creditId} is ${status}, so no close is waiting to be booked.`,
    },
    422
  );
}

/**
 * A missing confirmed close or receipt is 422: this admin route cannot broadcast or discover
 * one. RPC unreachability is 502 and establishes nothing about payment. Caller polling can
 * still confirm an unconfirmed close.
 */
function tempoEvidenceRefusal(
  c: Context,
  evidence: Exclude<TempoCloseEvidence, { chain: "found" }>
): Response {
  if (evidence.chain === "unreachable") {
    return c.json(
      {
        error: "chain_unreachable",
        message: `The Tempo RPC could not be read, so what the close paid is still unknown: ${evidence.error}`,
      },
      502
    );
  }
  if (evidence.chain === "unconfirmed") {
    return c.json(
      {
        error: "close_not_confirmed",
        message:
          "This drain has no confirmed cooperative close, so there is no receipt to book it against. The caller's own drain poll is what submits and confirms one.",
      },
      422
    );
  }
  return c.json(
    {
      error: "close_refund_unreported",
      message: `Close reference ${evidence.reference} names no transaction receipt, so the chain states no refund figure. A close this DVM did not broadcast is booked by the caller's own drain poll.`,
    },
    422
  );
}

function tempoReconciledBody(
  c: Context,
  drain: CreditDrainRecord,
  channelId: string,
  replayed: boolean
): Response {
  const sentRef = drain.sentRef ?? {};
  return c.json({
    status: "reconciled",
    credit_id: drain.creditId,
    drain_id: drain.drainId,
    channel_id: channelId,
    transaction: typeof sentRef.tx_hash === "string" ? sentRef.tx_hash : null,
    settled_amount: typeof sentRef.settled_amount === "string" ? sentRef.settled_amount : null,
    amount_micro: drain.amountMicro,
    amount_native: drain.drainedNative,
    currency: drain.currency,
    replayed,
  });
}

function tempoDrainBody(
  drain: CreditDrainRecord,
  evidence: TempoCloseEvidence | undefined
): Record<string, unknown> {
  return {
    credit_id: drain.creditId,
    drain_id: drain.drainId,
    channel_id: drain.channelId,
    // Both figures side by side: the fiat the caller was debited, and the
    // rail-native debit that is what the chain's refund has to cover.
    amount_micro: drain.amountMicro,
    amount_native: drain.drainedNative,
    currency: drain.currency,
    caller_pubkey: drain.callerPubkey,
    status: drain.status,
    created_at: drain.createdAt,
    write_off_note: drain.writeOffNote,
    written_off_at: drain.writtenOffAt,
    ...(evidence ? { chain: evidence } : {}),
  };
}

function invoiceBody(invoice: CreditInvoiceRecord): Record<string, unknown> {
  return {
    payment_hash: invoice.paymentHash,
    credit_id: invoice.creditId,
    fund_id: invoice.fundId,
    caller_pubkey: invoice.callerPubkey,
    currency: invoice.currency,
    amount_micro: invoice.amountMicro,
    amount_msats: invoice.amountMsats,
    status: invoice.status,
    blocked_reason: invoice.blockedReason,
    created_at: invoice.createdAt,
    settled_at: invoice.settledAt,
    reconciled_credit_id: invoice.reconciledCreditId,
    resolved_at: invoice.resolvedAt,
    write_off_note: invoice.writeOffNote,
  };
}

function creditBody(credit: {
  creditId: string;
  currency: string;
  balanceMicro: number;
  availableMicro: number;
  expiryMs: number;
}): Record<string, unknown> {
  return {
    credit_id: credit.creditId,
    currency: credit.currency,
    balance_micro: credit.balanceMicro,
    remaining_micro: credit.availableMicro,
    expiry_ms: credit.expiryMs,
  };
}

/**
 * Confirm with the wallet that a blocked invoice really was paid, and recover
 * the settlement instant the blocked row never got to write.
 */
async function verifySettled(
  c: Context,
  opts: InstallAdminCreditRoutesOpts,
  invoice: CreditInvoiceRecord
): Promise<{ settledAt: number | undefined } | { response: Response }> {
  const receive = opts.lightningReceive;
  if (!receive) {
    return {
      response: c.json(
        {
          error: "lightning_receive_not_configured",
          message:
            "This DVM has no Lightning receive wallet wired, so it cannot confirm the invoice was paid. Boot it with DVMKIT_NWC_RECEIVE_URI and retry.",
        },
        503
      ),
    };
  }
  let status: { settled: boolean; settledAt?: number; known: boolean };
  try {
    status = await receive.lookupSettlement(invoice.paymentHash);
  } catch (err) {
    return {
      response: c.json(
        {
          error: "wallet_unreachable",
          message: `Could not confirm payment ${invoice.paymentHash} with the receive wallet: ${err instanceof Error ? err.message : String(err)}`,
        },
        502
      ),
    };
  }
  if (!status.known) {
    // An unknown payment hash differs from a known unpaid invoice and a transport failure. It
    // may indicate the receive wallet changed; retrying the same connection does not
    // establish payment.
    return {
      response: c.json(
        {
          error: "invoice_unknown_to_wallet",
          message:
            `The receive wallet has no record of payment ${invoice.paymentHash}. This DVM is ` +
            `wired to a different wallet than the one that issued this invoice; point ` +
            `DVMKIT_NWC_RECEIVE_URI at the wallet holding the payment and retry.`,
        },
        422
      ),
    };
  }
  if (!status.settled) {
    return {
      response: c.json(
        {
          error: "invoice_not_settled",
          message: `The receive wallet reports payment ${invoice.paymentHash} as unpaid; there is nothing to credit.`,
        },
        422
      ),
    };
  }
  return { settledAt: status.settledAt };
}

/**
 * Preflight bindings before the money transaction. Unlike caller routes, this
 * builder-authenticated surface already exposes the queue, so an existence answer precedes
 * derived-namespace checks. Preserve that distinction.
 */
async function checkReconcileTarget(
  c: Context,
  opts: InstallAdminCreditRoutesOpts,
  invoice: CreditInvoiceRecord,
  targetCreditId: string
): Promise<Response | undefined> {
  const target = await opts.ledger.get(targetCreditId);
  if (!target) {
    // Opening a derived id is the caller-facing prohibition, and it holds here
    // for every id except the one this very invoice derives: `fnd:` ids are
    // computable from public inputs, so pre-opening someone else's would let
    // the money they later send hit `caller_mismatch`. The invoice's own
    // derived id belongs to the invoice's own caller — it is precisely the
    // credit their top-up was going to open.
    const ownDerived = derivedFundCreditId(invoice.callerPubkey, invoice.fundId);
    if (isDerivedCreditId(targetCreditId) && targetCreditId !== ownDerived) {
      return c.json(
        {
          error: "credit_id_unavailable",
          message: `credit_id ${targetCreditId} is in a namespace this provider derives and does not yet exist; name an existing credit, or ${ownDerived} — the one this invoice's top-up would have opened.`,
        },
        400
      );
    }
    return undefined;
  }
  if (target.callerPubkey !== invoice.callerPubkey) {
    return c.json(
      {
        error: "caller_mismatch",
        message: `Credit ${targetCreditId} belongs to another caller; this payment was made by ${invoice.callerPubkey}.`,
      },
      422
    );
  }
  if (target.currency !== invoice.currency) {
    return c.json(
      {
        error: "currency_mismatch",
        message: `Credit ${targetCreditId} is denominated in ${target.currency}; this payment funds ${invoice.currency}.`,
      },
      422
    );
  }
  if (target.rail !== null && target.rail !== "lightning") {
    return c.json(
      {
        error: "rail_mismatch",
        message: `Credit ${targetCreditId} was funded on ${target.rail}; sats and ${target.rail} units aren't summable, so this payment needs a different credit.`,
      },
      422
    );
  }
  return undefined;
}

function ledgerRefusalStatus(code: string): 404 | 409 | 422 {
  if (code === "drain_not_found") return 404;
  if (code === "drain_conflict") return 409;
  return 422;
}

function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return 50;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_INVOICE_PAGE) return undefined;
  return parsed;
}

function encodeCursor(invoice: CreditInvoiceRecord): string {
  return Buffer.from(
    JSON.stringify([invoice.createdAt, invoice.creditId, invoice.fundId])
  ).toString("base64url");
}

function parseCursor(raw: string): BlockedInvoiceCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 3) return undefined;
    const [createdAt, creditId, fundId] = parsed as unknown[];
    if (!Number.isSafeInteger(createdAt) || typeof creditId !== "string") return undefined;
    if (typeof fundId !== "string") return undefined;
    return { createdAt: createdAt as number, creditId, fundId };
  } catch {
    return undefined;
  }
}

/** The P2PK witness pubkeys a proof's secret admits, `[]` for non-P2PK secrets. */
function witnessPubkeys(proof: { secret: string }): string[] {
  try {
    return getP2PKExpectedWitnessPubkeys(proof.secret).map((pk) => pk.toLowerCase());
  } catch {
    return [];
  }
}

function lockedTo(proof: { secret: string }, pubkey: string | undefined): boolean {
  if (!pubkey) return false;
  return witnessPubkeys(proof).includes(pubkey);
}

/**
 * Keep absent evidence distinct from malformed evidence so a bad just-in-time mint report
 * receives an evidence error rather than an accumulator-row refusal.
 */
function parseMintEvidence(raw: unknown): DrainFulfilment | undefined | "invalid" {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") return "invalid";
  const body = raw as Record<string, unknown>;
  if (body.source !== "jit_mint") return "invalid";
  const { mint_url: mintUrl, quote_id: quoteId } = body;
  if (typeof mintUrl !== "string" || mintUrl.length === 0) return "invalid";
  if (typeof quoteId !== "string" || quoteId.length === 0) return "invalid";
  const faceSats = wholeSats(body.face_sats);
  const reserveSats = wholeSats(body.reserve_sats);
  const invoiceMsats = wholeSats(body.invoice_msats);
  if (faceSats === undefined || faceSats <= 0) return "invalid";
  if (reserveSats === undefined || invoiceMsats === undefined) return "invalid";
  let routingFeeMsats: number | null = null;
  if (body.routing_fee_msats !== undefined && body.routing_fee_msats !== null) {
    const routing = wholeSats(body.routing_fee_msats);
    if (routing === undefined) return "invalid";
    routingFeeMsats = routing;
  }
  return {
    source: "jit_mint",
    mintUrl,
    quoteId,
    faceSats,
    reserveSats,
    invoiceMsats,
    routingFeeMsats,
  };
}

function wholeSats(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function parseProofArray(raw: unknown): ProofLike[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProofLike[] = [];
  for (const entry of raw) {
    const proof = entry as {
      id?: unknown;
      amount?: unknown;
      secret?: unknown;
      C?: unknown;
      dleq?: unknown;
    };
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof proof.id !== "string" ||
      typeof proof.secret !== "string" ||
      typeof proof.C !== "string" ||
      typeof proof.amount !== "number" ||
      !Number.isSafeInteger(proof.amount) ||
      proof.amount <= 0
    ) {
      return undefined;
    }
    const dleq = parseSerializedDleq(proof.dleq);
    if (proof.dleq !== undefined && !dleq) return undefined;
    out.push({
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
      ...(dleq ? { dleq } : {}),
    });
  }
  return out;
}

function parseSerializedDleq(raw: unknown): { e: string; s: string; r?: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const dleq = raw as { e?: unknown; s?: unknown; r?: unknown };
  if (typeof dleq.e !== "string" || typeof dleq.s !== "string") return undefined;
  if (dleq.r !== undefined && typeof dleq.r !== "string") return undefined;
  return { e: dleq.e, s: dleq.s, ...(dleq.r !== undefined ? { r: dleq.r } : {}) };
}
