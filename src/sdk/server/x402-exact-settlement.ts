import { createHash } from "node:crypto";

import { usdcToMsats } from "../../lib/payment-amounts";
import { createX402FacilitatorAuthHeaders } from "../../lib/x402/facilitator";
import {
  settleWithFacilitator,
  verifyWithFacilitator,
} from "../../lib/x402/facilitator-request";
import {
  buildPaymentRequirements,
  decodePayment,
  encodeSettleResponseHeader,
  exactEvmAuthorization,
  type PaymentPayload,
  type PaymentRequirementsV1,
  type PaymentRequirementsV2,
  type SettleResponse,
} from "../../lib/x402/spec";
import type { X402Config, X402ExactVersionSupport, X402Receipt } from "../../lib/x402/types";
import type { ProcessedPaymentQuerier } from "./processed-payment-store";
import {
  X402ExactIntentConflictError,
  type X402ExactAuthorizationFacts,
  type X402ExactSettlementAttempt,
  type X402ExactSettlementEffect,
  type X402ExactSettlementIntent,
  type X402ExactSettlementStore,
} from "./x402-exact-settlement-store";

/** Chain evidence recovered for one exact x402 authorization. */
export interface X402ExactSettlementChainEvidence {
  transaction: string;
  amount: string;
}

/** Chain boundary used by exact-settlement recovery. */
export interface X402ExactSettlementEvidenceReader {
  getBlockNumber(): Promise<bigint>;
  findExactPayment?(
    intent: X402ExactSettlementIntent
  ): Promise<X402ExactSettlementChainEvidence | undefined>;
}

/** Result of accepting or recovering one exact x402 authorization. */
export type X402ExactAcceptance<T> =
  | {
      outcome: "accepted";
      intentId: string;
      receipt: X402Receipt;
      committed?: T;
      replayed: boolean;
      admissionPending: boolean;
      effect?: X402ExactSettlementEffect;
    }
  | { outcome: "rejected"; intentId?: string; reason: string }
  | { outcome: "ambiguous"; intentId: string; reason: string };

export interface X402ExactSettlementServerOpts {
  store: X402ExactSettlementStore;
  evidence?: X402ExactSettlementEvidenceReader;
  repair?: (
    effect: X402ExactSettlementEffect | undefined,
    receipt: X402Receipt,
    tx?: ProcessedPaymentQuerier
  ) => Promise<unknown>;
}

/** Durable coordinator for irreversible exact x402 settlement. */
export class X402ExactSettlementServer {
  private readonly activeSubmissions = new Set<string>();

  constructor(private readonly opts: X402ExactSettlementServerOpts) {}

  /** Verify, settle, and atomically finalize one exact authorization. */
  async accept<T>(args: {
    paymentHeader: string;
    config: X402Config;
    requiredUsdcMicro: bigint;
    resource: string;
    btcUsdRate: number;
    exactVersions?: X402ExactVersionSupport;
    dvmId: string;
    effect?: X402ExactSettlementEffect;
    commit: (
      receipt: X402Receipt,
      tx?: ProcessedPaymentQuerier,
      effect?: X402ExactSettlementEffect
    ) => Promise<T>;
  }): Promise<X402ExactAcceptance<T>> {
    const decoded = decodeAndDescribe(args);
    if ("reason" in decoded) return { outcome: "rejected", reason: decoded.reason };
    const { payload, requirements, facts, intentId } = decoded;

    const existing = await this.opts.store.get(args.dvmId, intentId);
    if (!existing) {
      const createAuthHeaders = createX402FacilitatorAuthHeaders(args.config);
      const verified = await verifyWithFacilitator(
        payload,
        requirements,
        args.config,
        createAuthHeaders
      );
      if (!verified.isValid) {
        return {
          outcome: "rejected",
          intentId,
          reason: verified.invalidReason ?? "verify_failed",
        };
      }
    }

    // Run prepare for both first presentation and every retry. Its conflict
    // check is the durable authorization/resource/effect binding; skipping it
    // for an existing row would let a same-nonce authorization borrow the
    // original settlement while finalizing a different local amount.
    await this.opts.store.prepare({
      id: intentId,
      dvmId: args.dvmId,
      resource: args.resource,
      ...facts,
      effect: args.effect,
    });

    return this.advance({ ...args, intentId, payload, requirements });
  }

  /**
   * Verify an authorization and record it as `prepared` without settling it.
   * The caller must run {@link settlePrepared} once the work it pays for has
   * succeeded, or {@link release} when it has not. A presentation whose
   * intent already exists is reported as `replayed` and neither verified nor
   * prepared again, so one authorization admits one piece of work.
   */
  async verifyAndPrepare(args: {
    paymentHeader: string;
    config: X402Config;
    requiredUsdcMicro: bigint;
    resource: string;
    exactVersions?: X402ExactVersionSupport;
    dvmId: string;
    effect: X402ExactSettlementEffect;
    /** Refuse, before any facilitator call, an authorization that expires sooner than this. */
    minValidSeconds: number;
    maxTimeoutSeconds: number;
    nowMs?: number;
  }): Promise<
    | {
        outcome: "prepared";
        intentId: string;
        payload: PaymentPayload;
        requirements: PaymentRequirementsV1 | PaymentRequirementsV2;
        validBeforeMs: number;
      }
    | { outcome: "replayed"; intentId: string }
    | { outcome: "authorization_too_short"; intentId: string; validBefore: string }
    | { outcome: "rejected"; intentId?: string; reason: string }
  > {
    const decoded = decodeAndDescribe(args);
    if ("reason" in decoded) return { outcome: "rejected", reason: decoded.reason };
    const { payload, requirements, facts, intentId } = decoded;
    if (await this.opts.store.get(args.dvmId, intentId)) {
      return { outcome: "replayed", intentId };
    }
    const validBeforeMs = Number(facts.validBefore) * 1000;
    if (
      !Number.isFinite(validBeforeMs) ||
      validBeforeMs - (args.nowMs ?? Date.now()) < args.minValidSeconds * 1000
    ) {
      return { outcome: "authorization_too_short", intentId, validBefore: facts.validBefore };
    }
    const verified = await verifyWithFacilitator(
      payload,
      requirements,
      args.config,
      createX402FacilitatorAuthHeaders(args.config)
    );
    if (!verified.isValid) {
      return { outcome: "rejected", intentId, reason: verified.invalidReason ?? "verify_failed" };
    }
    // The `get` above is only a cheap early exit: presentations that overlap
    // during `/verify` all pass it. The insert is the claim, and only the
    // presentation that created the row may run the work.
    // Each presentation carries its own job id, so the loser of the race also
    // trips the store's binding check against the winner's row.
    const claimed = await this.opts.store
      .claim({
        id: intentId,
        dvmId: args.dvmId,
        resource: args.resource,
        ...facts,
        effect: args.effect,
      })
      .catch((err: unknown) => {
        if (err instanceof X402ExactIntentConflictError) return undefined;
        throw err;
      });
    if (!claimed?.inserted) return { outcome: "replayed", intentId };
    return { outcome: "prepared", intentId, payload, requirements, validBeforeMs };
  }

  /** Settle an authorization recorded by {@link verifyAndPrepare} and commit its local effect. */
  settlePrepared<T>(args: {
    dvmId: string;
    intentId: string;
    payload: PaymentPayload;
    requirements: PaymentRequirementsV1 | PaymentRequirementsV2;
    config: X402Config;
    btcUsdRate: number;
    commit: (
      receipt: X402Receipt,
      tx?: ProcessedPaymentQuerier,
      effect?: X402ExactSettlementEffect
    ) => Promise<T>;
  }): Promise<X402ExactAcceptance<T>> {
    return this.advance(args);
  }

  /**
   * Abandon a prepared authorization whose work did not succeed. The
   * authorization is never sent to the facilitator, so it expires unspent.
   * Returns false when the intent is no longer `prepared`.
   */
  release(dvmId: string, intentId: string, reason: string): Promise<boolean> {
    return this.opts.store.release({ dvmId, intentId, reason });
  }

  private async advance<T>(args: {
    dvmId: string;
    intentId: string;
    payload: PaymentPayload;
    requirements: PaymentRequirementsV1 | PaymentRequirementsV2;
    config: X402Config;
    btcUsdRate: number;
    commit: (
      receipt: X402Receipt,
      tx?: ProcessedPaymentQuerier,
      effect?: X402ExactSettlementEffect
    ) => Promise<T>;
  }): Promise<X402ExactAcceptance<T>> {
    const { intentId, payload, requirements } = args;
    let intent = await this.requiredIntent(args.dvmId, intentId);
    if (intent.status === "released") {
      return { outcome: "rejected", intentId, reason: intent.lastOutcome ?? "released" };
    }
    if (intent.status === "complete") {
      return {
        outcome: "accepted",
        intentId,
        receipt: receiptFromIntent(intent, args.btcUsdRate),
        replayed: true,
        admissionPending: false,
        effect: intent.effect,
      };
    }
    if (intent.status === "local_committed") {
      return {
        outcome: "accepted",
        intentId,
        receipt: receiptFromIntent(intent, args.btcUsdRate),
        replayed: true,
        admissionPending: true,
        effect: intent.effect,
      };
    }
    if (intent.status === "rejected") {
      return { outcome: "rejected", intentId, reason: intent.lastOutcome ?? "settle_failed" };
    }
    if (intent.status === "submitting" || intent.status === "ambiguous") {
      const recovered = await this.recoverEvidence(intent);
      if (!recovered) {
        // A live request in this process owns the call. Once that owner is
        // gone, presenting the same EIP-3009 authorization may submit again:
        // the nonce makes the external effect single-use, while this closes
        // the crash after markSubmitting but before /settle.
        if (this.activeSubmissions.has(intentId)) {
          return {
            outcome: "ambiguous",
            intentId,
            reason: intent.lastOutcome ?? "settlement_in_progress",
          };
        }
      } else {
        intent = recovered;
      }
    }

    if (
      intent.status === "prepared" ||
      intent.status === "submitting" ||
      intent.status === "ambiguous"
    ) {
      if (this.activeSubmissions.has(intentId)) {
        return {
          outcome: "ambiguous",
          intentId,
          reason: intent.lastOutcome ?? "settlement_in_progress",
        };
      }
      this.activeSubmissions.add(intentId);
      let submissionBlock: string | undefined;
      try {
        submissionBlock = (await this.opts.evidence?.getBlockNumber())?.toString();
      } catch {
        // A missing bookmark is retained explicitly by the submitting row. It
        // makes operator repair fail closed rather than hiding the settlement.
      }
      let claimed: boolean;
      try {
        claimed = await this.opts.store.markSubmitting({
          dvmId: args.dvmId,
          intentId,
          submissionBlock,
        });
      } catch (err) {
        this.activeSubmissions.delete(intentId);
        throw err;
      }
      if (!claimed) {
        this.activeSubmissions.delete(intentId);
        intent = await this.requiredIntent(args.dvmId, intentId);
        const recovered = await this.recoverEvidence(intent);
        return recovered
          ? this.finalize(recovered, args.btcUsdRate, args.commit)
          : {
              outcome: "ambiguous",
              intentId,
              reason: intent.lastOutcome ?? "settlement_in_progress",
            };
      }

      try {
        const settleResponse = await settleWithFacilitator(
          payload,
          requirements,
          args.config,
          createX402FacilitatorAuthHeaders(args.config)
        );
        if (settleResponse.success && settleResponse.transaction) {
          intent = await this.opts.store.recordOutcome({
            dvmId: args.dvmId,
            intentId,
            status: "settled",
            outcome: "success",
            transaction: settleResponse.transaction,
            settleResponse: settleResponse as unknown as Record<string, unknown>,
          });
        } else if (settleResponse.success) {
          intent = await this.opts.store.recordOutcome({
            dvmId: args.dvmId,
            intentId,
            status: "ambiguous",
            outcome: "missing_reference",
            detail: "facilitator reported success without a transaction reference",
            settleResponse: settleResponse as unknown as Record<string, unknown>,
          });
        } else if (settlementMayHaveMoved(settleResponse)) {
          intent = await this.opts.store.recordOutcome({
            dvmId: args.dvmId,
            intentId,
            status: "ambiguous",
            outcome: "rejected",
            detail: settleResponse.errorReason ?? "settle_failed",
            settleResponse: settleResponse as unknown as Record<string, unknown>,
          });
        } else {
          await this.opts.store.recordOutcome({
            dvmId: args.dvmId,
            intentId,
            status: "rejected",
            outcome: "rejected",
            detail: settleResponse.errorReason ?? "settle_failed",
            settleResponse: settleResponse as unknown as Record<string, unknown>,
          });
          return {
            outcome: "rejected",
            intentId,
            reason: settleResponse.errorReason ?? "settle_failed",
          };
        }
      } catch (err) {
        intent = await this.opts.store.recordOutcome({
          dvmId: args.dvmId,
          intentId,
          status: "ambiguous",
          outcome: "timeout",
          detail: safeError(err),
        });
      } finally {
        this.activeSubmissions.delete(intentId);
      }
    }

    if (intent.status === "ambiguous" || intent.status === "submitting") {
      const recovered = await this.recoverEvidence(intent);
      if (!recovered) {
        return {
          outcome: "ambiguous",
          intentId,
          reason: intent.lastOutcome ?? "settlement_outcome_unknown",
        };
      }
      intent = recovered;
    }
    return this.finalize(intent, args.btcUsdRate, args.commit);
  }

  get(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent | undefined> {
    return this.opts.store.get(dvmId, intentId);
  }

  list(args: {
    dvmId: string;
    limit: number;
    includeResolved?: boolean;
  }): Promise<X402ExactSettlementIntent[]> {
    return this.opts.store.list(args);
  }

  attempts(dvmId: string, intentId: string): Promise<X402ExactSettlementAttempt[]> {
    return this.opts.store.attempts(dvmId, intentId);
  }

  /** Reconcile and finish one intent from chain evidence. */
  async reconcile(
    dvmId: string,
    intentId: string
  ): Promise<{
    intent: X402ExactSettlementIntent;
    replayed: boolean;
  }> {
    const intent = await this.requiredIntent(dvmId, intentId);
    if (intent.status === "complete" || intent.status === "local_committed") {
      return { intent, replayed: true };
    }
    if (intent.status !== "settled") {
      const recovered = await this.recoverEvidence(intent);
      if (!recovered) throw new X402ExactSettlementEvidenceMissingError(intentId);
      // Recovery persists the settled row; finalization locks and rereads it.
    }
    const repair = this.opts.repair;
    if (!repair) throw new Error("x402 exact settlement repair is not configured");
    const result = await this.opts.store.finalize(dvmId, intentId, (locked, tx) =>
      repair(locked.effect, receiptFromIntent(locked, 0), tx)
    );
    return { intent: result.intent, replayed: result.replayed };
  }

  /** Mark a locally committed upfront settlement complete after its job row lands. */
  completeAdmission(dvmId: string, intentId: string): Promise<X402ExactSettlementIntent> {
    return this.opts.store.markAdmissionComplete(dvmId, intentId);
  }

  private async finalize<T>(
    intent: X402ExactSettlementIntent,
    btcUsdRate: number,
    commit: (
      receipt: X402Receipt,
      tx?: ProcessedPaymentQuerier,
      effect?: X402ExactSettlementEffect
    ) => Promise<T>
  ): Promise<X402ExactAcceptance<T>> {
    const result = await this.opts.store.finalize(intent.dvmId, intent.id, (locked, tx) =>
      commit(receiptFromIntent(locked, btcUsdRate), tx, locked.effect)
    );
    return {
      outcome: "accepted",
      intentId: intent.id,
      receipt: receiptFromIntent(result.intent, btcUsdRate),
      committed: result.value,
      replayed: result.replayed,
      admissionPending: result.intent.status === "local_committed",
      effect: result.intent.effect,
    };
  }

  private async recoverEvidence(
    intent: X402ExactSettlementIntent
  ): Promise<X402ExactSettlementIntent | undefined> {
    if (!this.opts.evidence?.findExactPayment || !intent.submissionBlock) return undefined;
    let evidence: X402ExactSettlementChainEvidence | undefined;
    try {
      evidence = await this.opts.evidence.findExactPayment(intent);
    } catch {
      return undefined;
    }
    if (evidence?.amount !== intent.value) return undefined;
    return this.opts.store.recordOutcome({
      dvmId: intent.dvmId,
      intentId: intent.id,
      status: "settled",
      outcome: "success",
      transaction: evidence.transaction,
      settleResponse: { success: true, transaction: evidence.transaction, recovered: true },
    });
  }

  private async requiredIntent(dvmId: string, intentId: string) {
    const intent = await this.opts.store.get(dvmId, intentId);
    if (!intent) throw new Error(`x402 exact intent ${intentId} was not found`);
    return intent;
  }
}

/** Durable id of the intent a payment header would create, or undefined when it cannot be read. */
export function exactSettlementIntentId(args: {
  paymentHeader: string;
  config: X402Config;
  requiredUsdcMicro: bigint;
  resource: string;
  exactVersions?: X402ExactVersionSupport;
}): string | undefined {
  const decoded = decodeAndDescribe(args);
  return "reason" in decoded ? undefined : decoded.intentId;
}

/** Raised when operator repair cannot prove the payment on chain. */
export class X402ExactSettlementEvidenceMissingError extends Error {
  constructor(readonly intentId: string) {
    super(`no matching on-chain payment was found for x402 exact intent ${intentId}`);
    this.name = "X402ExactSettlementEvidenceMissingError";
  }
}

function decodeAndDescribe(args: {
  paymentHeader: string;
  config: X402Config;
  requiredUsdcMicro: bigint;
  resource: string;
  exactVersions?: X402ExactVersionSupport;
  maxTimeoutSeconds?: number;
}):
  | { reason: string }
  | {
      payload: PaymentPayload;
      requirements: PaymentRequirementsV1 | PaymentRequirementsV2;
      facts: X402ExactAuthorizationFacts;
      intentId: string;
    } {
  let payload: PaymentPayload;
  try {
    payload = decodePayment(args.paymentHeader);
  } catch {
    return { reason: "decode_failed" };
  }
  const versions = args.exactVersions ?? { v1: true, v2: true };
  if ((payload.x402Version === 1 && !versions.v1) || (payload.x402Version === 2 && !versions.v2)) {
    return { reason: "unsupported_version" };
  }
  const requirementOpts = {
    x402Config: args.config,
    requiredUsdcMicro: args.requiredUsdcMicro,
    resource: args.resource,
    maxTimeoutSeconds: args.maxTimeoutSeconds,
  };
  const requirements =
    payload.x402Version === 1
      ? buildPaymentRequirements({ ...requirementOpts, version: 1 })
      : buildPaymentRequirements({ ...requirementOpts, version: 2 });
  const auth = exactEvmAuthorization(payload);
  const facts: X402ExactAuthorizationFacts = {
    network: requirements.network,
    asset: requirements.asset.toLowerCase(),
    from: auth.from.toLowerCase(),
    to: auth.to.toLowerCase(),
    value: auth.value,
    validAfter: auth.validAfter,
    validBefore: auth.validBefore,
    nonce: auth.nonce.toLowerCase(),
    fingerprint: hash([
      payload.x402Version,
      requirements.scheme,
      requirements.network,
      requirements.asset.toLowerCase(),
      auth.from.toLowerCase(),
      auth.to.toLowerCase(),
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce.toLowerCase(),
    ]),
  };
  return {
    payload,
    requirements,
    facts,
    intentId: hash([facts.network, facts.asset, facts.from, facts.nonce]),
  };
}

function receiptFromIntent(intent: X402ExactSettlementIntent, btcUsdRate: number): X402Receipt {
  const amountUsdcMicro = Number.parseInt(intent.value, 10);
  const response = (intent.settleResponse ?? {
    success: true,
    transaction: intent.transaction,
  }) as unknown as SettleResponse;
  return {
    verified: true,
    amountMsats: btcUsdRate > 0 ? usdcToMsats(amountUsdcMicro / 1e6, btcUsdRate) : 0,
    amountUsdcMicro,
    txHash: intent.transaction,
    settleResponseHeader: encodeSettleResponseHeader(response),
  };
}

function settlementMayHaveMoved(response: SettleResponse): boolean {
  const reason = response.errorReason?.toLowerCase() ?? "";
  return (
    reason.includes("authorization_already_used") ||
    reason.includes("authorization already used") ||
    /facilitator_status_5\d\d/.test(reason)
  );
}

function hash(parts: (string | number)[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function safeError(err: unknown): string {
  if (err instanceof Error) return err.name;
  return "settlement_transport_error";
}

/** A verified authorization kept in memory until its job finishes. */
export interface HeldX402Authorization {
  payload: PaymentPayload;
  requirements: PaymentRequirementsV1 | PaymentRequirementsV2;
  config: X402Config;
  btcUsdRate: number;
  validBeforeMs: number;
}

/** How a finished job's deferred authorization ended. */
export type DeferredX402Outcome = "settled" | "unpaid";

export interface DeferredX402Settler {
  hold(intentId: string, held: HeldX402Authorization): void;
  /**
   * Settle the job's authorization. Resolves `settled` once the funding is
   * committed (also when an earlier call already did) and `unpaid` when the
   * payment is definitively not collected. Rejects while the outcome is still
   * unknown, so the caller retries.
   */
  settle(intentId: string): Promise<DeferredX402Outcome>;
  /** Give up the authorization without sending it to the facilitator. */
  release(intentId: string, reason: string): Promise<void>;
}

/**
 * Holds each verified authorization in this process and sends it to the
 * facilitator only when its job succeeds. The signature is a bearer
 * credential, so it is never persisted: a process that loses it can only
 * release the intent, leaving the payer unharmed and the work unpaid.
 */
export class InProcessDeferredX402Settler implements DeferredX402Settler {
  private readonly held = new Map<string, HeldX402Authorization>();

  constructor(
    private readonly opts: {
      settlement: X402ExactSettlementServer;
      dvmId: string;
      commit: (
        receipt: X402Receipt,
        tx?: ProcessedPaymentQuerier,
        effect?: X402ExactSettlementEffect
      ) => Promise<unknown>;
    }
  ) {}

  hold(intentId: string, held: HeldX402Authorization): void {
    this.held.set(intentId, held);
    // An authorization past its own expiry can no longer settle, so keeping it
    // would only leak memory for a job that never reached a terminal.
    const timer = setTimeout(
      () => {
        if (this.held.get(intentId) === held) this.held.delete(intentId);
      },
      Math.max(0, held.validBeforeMs - Date.now()) + 1000
    );
    timer.unref();
  }

  async settle(intentId: string): Promise<DeferredX402Outcome> {
    const { settlement, dvmId } = this.opts;
    const intent = await settlement.get(dvmId, intentId);
    if (intent?.status === "complete") return "settled";
    if (intent?.status === "released" || intent?.status === "rejected") return "unpaid";
    const held = this.held.get(intentId);
    if (!held) {
      await settlement.release(dvmId, intentId, "authorization_unavailable");
      return "unpaid";
    }
    const result = await settlement.settlePrepared({
      dvmId,
      intentId,
      payload: held.payload,
      requirements: held.requirements,
      config: held.config,
      btcUsdRate: held.btcUsdRate,
      commit: this.opts.commit,
    });
    if (result.outcome === "ambiguous") {
      throw new Error(`x402 settlement ${intentId} outcome unknown: ${result.reason}`);
    }
    this.held.delete(intentId);
    return result.outcome === "accepted" ? "settled" : "unpaid";
  }

  async release(intentId: string, reason: string): Promise<void> {
    this.held.delete(intentId);
    await this.opts.settlement.release(this.opts.dvmId, intentId, reason);
  }
}

