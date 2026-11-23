import { isDeepStrictEqual } from "node:util";
import { callerDeadline, hasCallerDeadline } from "./job";
import { applyContentHoldMutation, ContentHoldError, type ContentHoldHistory, type ContentHoldMutation } from "./content-retention";
import type { Message } from "../../lib/messages/types";
import type { StepRecord } from "../step-cache";
import type { JobReceipt } from "../../lib/receipt";
import { hasOpenAsk, isTerminal, isTerminalMessage } from "./job";
import { JobEndedError, JobSupersededError, TERMINAL_OUTPUT, withTerminalOutput } from "./job-store";
import type {
  AppendOutgoingOptions,
  DeclineOutcome,
  JobCounters,
  JobRecord,
  JobRetentionCursor,
  OutgoingMessage,
  TerminalSnapshot,
  PaymentCreditDelta,
  ReceiptIssuingStore,
  RequestIdClaim,
  RequestIdClaimResult,
  StreamableJobStore,
  VerifyAndCreditOptions,
  VerifyAndCreditResult,
} from "./job-store";
import { accumulateAskedTopUp } from "./job-store";
import { incomingPaymentSnapshot } from "./payment";
import { appendPiece, endPieces, finishRunningPiece, type PieceEnding, terminalEnding } from "./pieces";
import {
  decidePaymentDisposition,
  PaymentIntentOpenError,
  type PaymentArrivalStore,
  type RecordedPaymentArrival,
} from "./payment-arrival";

const SLEEP_SNAPSHOT = Symbol("sleep snapshot");
type MemorySleepSnapshot = JobRecord & { [SLEEP_SNAPSHOT]?: true };

interface StoredMessage {
  message: Message;
  status: "verified" | "pending-verification" | "failed-verify" | "balance";
}

interface MessageSubscriber {
  afterSeq: number;
  cb: (msg: Message) => void;
}

interface StoredRequestIdClaim extends RequestIdClaim {
  holderToken?: string;
}

interface PaymentIntent {
  leaseExpiresAtMs: number;
  resolved: boolean;
}

/**
 * In-memory JobStore implementing the transactional + streaming surface;
 * used by unit tests and not production-safe — there's no real
 * concurrency control beyond JS's single-threaded execution.
 */
export class MemoryJobStore implements StreamableJobStore, ReceiptIssuingStore, PaymentArrivalStore {
  private contentHolds = new Map<string, ContentHoldHistory>();
  private paymentIntents = new Map<string, Map<number, PaymentIntent>>();
  private data = new Map<string, JobRecord>();
  private verifiedInboundVersions = new Map<string, symbol>();
  private observedInboundVersions = new WeakMap<JobRecord, symbol | undefined>();
  private messages = new Map<string, StoredMessage[]>();
  private nextSeq = new Map<string, number>();
  private outgoingAppends = new Map<string, Map<string, number>>();
  private messageSubscribers = new Map<string, Set<MessageSubscriber>>();
  private notifySubscribers = new Map<string, Set<() => void>>();
  private reactivationLocks = new Set<string>();
  private requestIdClaims = new Map<string, StoredRequestIdClaim>();
  private receiptCounter = 0;
  private receiptSeqs = new Map<string, number>();

  get(id: string): Promise<JobRecord | undefined> {
    const record = this.data.get(id);
    if (!record) return Promise.resolve(undefined);
    const observed = structuredClone(record);
    this.observedInboundVersions.set(observed, this.verifiedInboundVersions.get(id));
    return Promise.resolve(observed);
  }

  findJobByPaymentTxHash(txHash: string): Promise<JobRecord | undefined> {
    for (const record of this.data.values()) {
      if (record.paymentTxHash === txHash) return Promise.resolve(structuredClone(record));
    }
    return Promise.resolve(undefined);
  }

  findJobByRequestId(requestId: string, requesterPubkey: string): Promise<JobRecord | undefined> {
    for (const record of this.data.values()) {
      if (record.requestId === requestId && record.requesterPubkey === requesterPubkey) {
        return Promise.resolve(structuredClone(record));
      }
    }
    return Promise.resolve(undefined);
  }

  claimRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined> {
    const key = requestIdClaimKey(claim.requesterPubkey, claim.requestId);
    const existing = this.requestIdClaims.get(key);
    if (!existing) {
      this.requestIdClaims.set(key, { ...claim, holderToken: claim.claimToken });
      return Promise.resolve({ jobId: claim.jobId, replayed: false });
    }
    if (
      existing.holderToken !== undefined ||
      existing.requestFingerprint !== claim.requestFingerprint ||
      existing.requesterId !== claim.requesterId
    ) {
      return Promise.resolve(undefined);
    }
    this.requestIdClaims.set(key, { ...existing, holderToken: claim.claimToken });
    return Promise.resolve({ jobId: existing.jobId, replayed: true });
  }

  resumeRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined> {
    const key = requestIdClaimKey(claim.requesterPubkey, claim.requestId);
    const existing = this.requestIdClaims.get(key);
    if (
      !existing ||
      existing.holderToken !== undefined ||
      existing.requestFingerprint !== claim.requestFingerprint ||
      existing.requesterId !== claim.requesterId
    ) {
      return Promise.resolve(undefined);
    }
    this.requestIdClaims.set(key, { ...existing, holderToken: claim.claimToken });
    return Promise.resolve({ jobId: existing.jobId, replayed: true });
  }

  releaseRequestIdClaim(claim: RequestIdClaim): Promise<void> {
    const key = requestIdClaimKey(claim.requesterPubkey, claim.requestId);
    const existing = this.requestIdClaims.get(key);
    if (existing?.holderToken === claim.claimToken) {
      this.requestIdClaims.set(key, { ...existing, holderToken: undefined });
    }
    return Promise.resolve();
  }

  async saveStep(id: string, step: StepRecord, sleepGeneration?: number): Promise<void> {
    const record = this.data.get(id);
    if (sleepGeneration !== undefined && (!record || isTerminal(record.status) || record.redactedAt !== undefined ||
        (record.sleepGeneration ?? 0) !== sleepGeneration)) throw new JobSupersededError();
    if (!record || isTerminal(record.status) || record.redactedAt !== undefined) {
      throw new Error("Step persistence requires a live job");
    }
    if (!record.stepCache.some((cached) => cached.id === step.id)) {
      record.stepCache.push(structuredClone(step));
    }
  }

  save(record: JobRecord): Promise<void> {
    // terminal is terminal — mirrors `PostgresJobStore.save`'s
    // ON CONFLICT guard. A handler still running on another machine (the cancel
    // landed there, not here) must not overwrite the cancelled row with
    // `completed`. Re-saving the same terminal status is allowed (idempotent
    // re-persist of the same outcome).
    const existing = this.data.get(record.id);
    if (record.sleepGeneration !== undefined &&
        (existing?.sleepGeneration ?? 0) !== record.sleepGeneration) {
      return Promise.reject(new JobSupersededError());
    }
    if ((record as MemorySleepSnapshot)[SLEEP_SNAPSHOT] &&
        (!existing || (existing.status !== "processing" && existing.status !== "working"))) {
      return Promise.reject(new JobSupersededError());
    }
    if (!existing && record.requestId && record.requesterPubkey) {
      for (const prior of this.data.values()) {
        if (
          prior.requestId === record.requestId &&
          prior.requesterPubkey === record.requesterPubkey
        ) {
          return Promise.reject(new Error("duplicate caller request id"));
        }
      }
    }
    if (
      existing &&
      (existing.redactedAt !== undefined ||
        (isTerminal(existing.status) && existing.status !== record.status))
    ) {
      return Promise.resolve();
    }
    if (existing && !isTerminal(existing.status) && isTerminal(record.status)) {
      const until = this.openIntentUntil(record.id, Date.now());
      if (until !== undefined) return Promise.reject(new PaymentIntentOpenError(record.id, until));
    }
    const output = (record as TerminalSnapshot)[TERMINAL_OUTPUT];
    if (output && isTerminal(record.status)) {
      if (existing && isTerminal(existing.status)) return Promise.resolve();
      const history = this.visibleMessages(record.id, 0, true);
      record = withTerminalOutput(record, history.length ? history : record.messages.filter(message => !isTerminalMessage(message)), this.nextSeq.get(record.id) ?? 1, output);
    }
    // `receipt` and `receiptSeq` are owned by `saveReceipt` /
    // `claimReceiptSeq`, never by the snapshot path — mirrors the Postgres
    // store, whose `save` statement simply doesn't list those columns. Without
    // this, a snapshot taken before the receipt was signed would clear it.
    // Older callers can supply the removed field as an extra property on JobRecord.
    const { receivedProofs: _legacyProofs, ...jobFields } = record as JobRecord & { receivedProofs?: unknown };
    const snapshot = structuredClone(jobFields);
    delete snapshot.pieceEnding;
    snapshot.sleepUntilMs = existing?.sleepUntilMs;
    snapshot.sleepId = existing?.sleepId;
    snapshot.sleepGeneration = existing?.sleepGeneration ?? 0;
    snapshot.sleepResumes = existing?.sleepResumes ?? 0;
    if (existing) {
      const steps = new Map(snapshot.stepCache.map((step) => [step.id, step]));
      for (const step of existing.stepCache) steps.set(step.id, structuredClone(step));
      snapshot.stepCache = [...steps.values()];
      snapshot.createdAt = existing.createdAt;
      snapshot.mandate = structuredClone(existing.mandate);
      snapshot.stopRequested = existing.stopRequested;
      snapshot.upfrontPayment = structuredClone(existing.upfrontPayment);
      // Store-owned after insert, like the Postgres columns.
      snapshot.pieces = structuredClone(existing.pieces);
      snapshot.settlement = structuredClone(existing.settlement);
    }
    if (isTerminal(record.status) && (!existing || !isTerminal(existing.status))) {
      // A row inserted already terminal takes the settlement the SDK froze on the snapshot.
      const ended = !existing && record.settlement
        ? { pieces: snapshot.pieces, settlement: snapshot.settlement }
        : endPieces(snapshot.pieces, terminalEnding(record));
      snapshot.pieces = ended.pieces;
      snapshot.settlement = ended.settlement;
    }
    if (existing && isTerminal(existing.status)) snapshot.lastActivityAt = existing.lastActivityAt;
    if (existing?.receipt) snapshot.receipt = existing.receipt;
    snapshot.timingKnown = existing ? existing.timingKnown ?? false : record.timingKnown ?? true;
    applyTiming(snapshot, existing, Date.now());
    this.data.set(record.id, snapshot);
    const cur = this.nextSeq.get(record.id) ?? 1;
    this.nextSeq.set(record.id, Math.max(cur, record.seq + 1));
    if (isTerminal(record.status)) {
      this.notify(record.id);
      this.deleteResolvedMessages(record.id);
    }
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.contentHolds.delete(id);
    this.paymentIntents.delete(id);
    this.data.delete(id);
    this.verifiedInboundVersions.delete(id);
    this.outgoingAppends.delete(id);
    this.messages.delete(id);
    this.nextSeq.delete(id);
    this.receiptSeqs.delete(id);
    return Promise.resolve();
  }

  listJobsForRetention(args: {
    lastActivityBeforeMs: number;
    limit: number;
    capabilities: string[] | null;
    after?: JobRetentionCursor;
  }): Promise<JobRecord[]> {
    const capabilitySet = args.capabilities === null ? null : new Set(args.capabilities);
    const matches = [...this.data.values()]
      .filter(
        (record) =>
          record.redactedAt === undefined &&
          isTerminal(record.status) &&
          record.lastActivityAt < args.lastActivityBeforeMs &&
          (capabilitySet === null || capabilitySet.has(record.capability)) &&
          (!args.after || compareRetentionKey(record, args.after) > 0)
      )
      .sort(compareRetentionKey)
      .slice(0, args.limit)
      .map((record) => structuredClone(record));
    return Promise.resolve(matches);
  }

  redactJob(args: {
    jobId: string;
    expectedLastActivityAt: number;
    redactedAt: number;
  }): Promise<boolean> {
    const record = this.data.get(args.jobId);
    if (
      !record ||
      record.redactedAt !== undefined ||
      !isTerminal(record.status) ||
      this.contentHolds.get(args.jobId)?.holds.some((hold) => hold.cleared_at === null) ||
      record.lastActivityAt !== args.expectedLastActivityAt
    ) {
      return Promise.resolve(false);
    }
    record.input = "";
    record.params = {};
    record.summary = undefined;
    record.messages = [];
    record.pendingPaymentMsats = undefined;
    record.pendingMppChallengeIds = undefined;
    record.pendingX402Nonce = undefined;
    record.pendingX402AmountUsdcMicro = undefined;
    record.pendingPaymentFiatMicro = undefined;
    record.pendingPaymentFiatCurrency = undefined;
    record.stepCache = [];
    record.state = {};
    record.requesterToken = undefined;
    record.requestFingerprint = undefined;
    record.authRequestPath = undefined;
    record.redactedAt = args.redactedAt;
    this.messages.delete(args.jobId);
    return Promise.resolve(true);
  }

  getContentSnapshot(jobId: string): Promise<{ job: JobRecord; history: ContentHoldHistory } | undefined> {
    const job = this.data.get(jobId);
    return Promise.resolve(job ? structuredClone({ job, history: this.contentHolds.get(jobId) ?? { holds: [], events: [] } }) : undefined);
  }

  mutateContentHold(jobId: string, mutation: ContentHoldMutation): Promise<ContentHoldHistory> {
    const job = this.data.get(jobId);
    if (!job) return Promise.reject(new ContentHoldError("job_not_found"));
    const history = applyContentHoldMutation(job, this.contentHolds.get(jobId) ?? { holds: [], events: [] }, mutation);
    this.contentHolds.set(jobId, history);
    return Promise.resolve(structuredClone(history));
  }

  claimReceiptSeq(jobId: string): Promise<number> {
    if (!this.data.has(jobId)) {
      return Promise.reject(new Error(`claimReceiptSeq: job ${jobId} not found`));
    }
    const existing = this.receiptSeqs.get(jobId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.receiptCounter += 1;
    this.receiptSeqs.set(jobId, this.receiptCounter);
    return Promise.resolve(this.receiptCounter);
  }

  saveReceipt(jobId: string, receipt: JobReceipt): Promise<JobReceipt | undefined> {
    const record = this.data.get(jobId);
    if (!record) return Promise.resolve(undefined);
    record.receipt ??= structuredClone(receipt);
    return Promise.resolve(structuredClone(record.receipt));
  }

  appendOutgoing(
    jobId: string,
    message: OutgoingMessage,
    opts?: AppendOutgoingOptions
  ): Promise<number> {
    const record = this.data.get(jobId);
    if (!record || record.redactedAt !== undefined) {
      return Promise.reject(new Error(`appendOutgoing: job ${jobId} not found`));
    }
    if (opts?.sleepGeneration !== undefined && (record.sleepGeneration ?? 0) !== opts.sleepGeneration) {
      return Promise.reject(new JobSupersededError());
    }
    if (opts?.sleepGeneration !== undefined && isTerminal(record.status)) {
      return Promise.reject(new JobEndedError(jobId));
    }
    if (isTerminalMessage(message)) {
      return Promise.reject(new Error("Provider terminal messages require a terminal snapshot"));
    }
    const prior = opts?.appendId ? this.outgoingAppends.get(jobId)?.get(opts.appendId) : undefined;
    if (prior !== undefined) return Promise.resolve(prior);
    if ((message.type === "payment-request" || message.type === "prompt") && isTerminal(record.status)) {
      return Promise.reject(new JobEndedError(jobId));
    }
    if (message.type === "payment-request" && record.pieces) {
      record.pieces = finishRunningPiece(record.pieces, opts?.finishedChargeMicro);
    }
    const seq = this.allocateSeq(jobId);
    const fullMessage = { ...message, seq } as Message;
    if (opts?.awaitingInput && !isTerminal(record.status)) {
      applyTiming(record, structuredClone(record), Date.now(), "awaiting-input");
      record.status = "awaiting-input";
    }
    this.messagesFor(jobId).push({ message: fullMessage, status: "verified" });
    if (opts?.pendingPaymentDelta !== undefined) {
      if (opts.pendingPaymentDelta !== 0) {
        record.pendingPaymentMsats = (record.pendingPaymentMsats ?? 0) + opts.pendingPaymentDelta;
      }
      record.pendingMppChallengeIds = opts.pendingMppChallengeIds;
      record.pendingX402Nonce = opts.pendingX402Nonce;
      record.pendingX402AmountUsdcMicro = opts.pendingX402AmountUsdcMicro;
      if (opts.pendingPaymentFiatMicro === undefined) {
        record.pendingPaymentFiatMicro = undefined;
        record.pendingPaymentFiatCurrency = undefined;
      } else {
        record.pendingPaymentFiatMicro =
          record.pendingPaymentFiatCurrency === opts.pendingPaymentFiatCurrency
            ? (record.pendingPaymentFiatMicro ?? 0) + opts.pendingPaymentFiatMicro
            : opts.pendingPaymentFiatMicro;
        record.pendingPaymentFiatCurrency = opts.pendingPaymentFiatCurrency;
      }
      const asked = accumulateAskedTopUp(
        {
          micro: record.askedTopUpMicro,
          currency: record.askedTopUpCurrency,
          reason: record.topUpCapUnenforcedReason,
        },
        { micro: opts.pendingPaymentFiatMicro, currency: opts.pendingPaymentFiatCurrency }
      );
      record.askedTopUpMicro = asked.micro;
      record.askedTopUpCurrency = asked.currency;
      record.topUpCapUnenforcedReason = asked.reason;
    }
    if (!isTerminal(record.status)) record.lastActivityAt = Date.now();
    if (seq > record.seq) record.seq = seq;
    if (opts?.appendId) {
      let appends = this.outgoingAppends.get(jobId);
      if (!appends) this.outgoingAppends.set(jobId, appends = new Map());
      appends.set(opts.appendId, seq);
    }
    this.notify(jobId);
    return Promise.resolve(seq);
  }

  recordInbound(jobId: string, message: OutgoingMessage): Promise<number> {
    const record = this.data.get(jobId);
    if (!record || record.redactedAt !== undefined) {
      return Promise.reject(new Error(`recordInbound: job ${jobId} not found`));
    }
    const seq = this.allocateSeq(jobId);
    const fullMessage = { ...message, seq } as Message;
    this.messagesFor(jobId).push({ message: fullMessage, status: "pending-verification" });
    if (!isTerminal(record.status)) record.lastActivityAt = Date.now();
    if (seq > record.seq) record.seq = seq;
    // pending-verification rows are not delivered via subscribeMessages, but
    // raw notifies still fire so counter-driven resolvers can wake.
    this.fireNotifyOnly(jobId);
    return Promise.resolve(seq);
  }

  recordPaymentArrival(
    jobId: string,
    message: { from: "requester"; type: "payment"; timestamp: number; content: Record<string, unknown> },
    opts: { arrivedAtMs: number; leaseMs: number }
  ): Promise<RecordedPaymentArrival> {
    const record = this.data.get(jobId);
    if (!record || record.redactedAt !== undefined) {
      return Promise.reject(new Error(`recordPaymentArrival: job ${jobId} not found`));
    }
    const ask = this.messagesFor(jobId).findLast((entry) => entry.status === "verified" &&
      entry.message.from === "provider" && entry.message.type === "payment-request")?.message;
    const disposition = decidePaymentDisposition({
      status: record.status,
      pendingPaymentMsats: record.pendingPaymentMsats,
      ask,
      arrivedAtMs: opts.arrivedAtMs,
    });
    const seq = this.allocateSeq(jobId);
    this.messagesFor(jobId).push({ message: { ...message, seq } as Message, status: "pending-verification" });
    if (!isTerminal(record.status)) record.lastActivityAt = Date.now();
    if (seq > record.seq) record.seq = seq;
    let intents = this.paymentIntents.get(jobId);
    if (!intents) this.paymentIntents.set(jobId, intents = new Map());
    intents.set(seq, { leaseExpiresAtMs: opts.arrivedAtMs + opts.leaseMs, resolved: false });
    this.fireNotifyOnly(jobId);
    return Promise.resolve({ seq, disposition, snapshot: incomingPaymentSnapshot({
      ...record, messages: ask ? [ask] : [],
    }) });
  }

  openPaymentIntentUntil(jobId: string, nowMs: number): Promise<number | undefined> {
    return Promise.resolve(this.openIntentUntil(jobId, nowMs));
  }

  verifyAndCredit(
    jobId: string,
    seq: number,
    credit: PaymentCreditDelta | null,
    opts?: VerifyAndCreditOptions
  ): Promise<VerifyAndCreditResult> {
    const record = this.data.get(jobId);
    if (!record) return Promise.reject(new Error(`verifyAndCredit: job ${jobId} not found`));
    const stored = this.messagesFor(jobId).find((m) => m.message.seq === seq);
    if (!stored)
      return Promise.reject(new Error(`verifyAndCredit: message ${jobId}/${seq} not found`));
    if (stored.status !== "pending-verification") {
      return Promise.resolve({
        counters: snapshotCounters(record),
        alreadyVerified: true,
        ...creditBinding(record),
      });
    }
    this.resolveIntent(jobId, seq);
    // An ended job takes no payment and no credit binding; the caller lands the money as balance.
    const refused = credit !== null && isTerminal(record.status);
    stored.status = opts?.landedAsBalance || refused ? "balance" : "verified";
    if (stored.status === "verified") this.verifiedInboundVersions.set(jobId, Symbol());
    if (credit && !refused) {
      record.paidMsats += credit.paidMsatsDelta;
      // the pinned fiat ask dies with the msat ask it denominates. A
      // partially-paid ask keeps its envelope so the remainder still funds at
      // the rate the caller was quoted.
      if (credit.clearPending || (record.pendingPaymentMsats ?? 0) <= credit.paidMsatsDelta) {
        record.pendingPaymentFiatMicro = undefined;
        record.pendingPaymentFiatCurrency = undefined;
      }
      if (credit.clearPending) {
        record.pendingPaymentMsats = undefined;
      } else {
        record.pendingPaymentMsats = Math.max(
          0,
          (record.pendingPaymentMsats ?? 0) - credit.paidMsatsDelta
        );
        if (record.pendingPaymentMsats === 0) record.pendingPaymentMsats = undefined;
      }
      // Set-if-null: only a top-up that minted a fresh implicit credit binds
      // one here; an existing binding stands, since the top-up grew that draw.
      record.creditId ??= credit.creditId;
      record.drawId ??= credit.drawId;
      if (record.pieces && credit.piece && credit.piece.amountMicro > 0 && record.drawId === credit.piece.drawId) {
        record.pieces = appendPiece(record.pieces, credit.piece.amountMicro, seq);
      }
      if (credit.paymentMint) record.paymentMint = credit.paymentMint;
      if (credit.paymentRail) record.paymentRail = credit.paymentRail;
      if (credit.paymentTxHash) record.paymentTxHash = credit.paymentTxHash;
      if (credit.nativeAmount !== undefined) {
        record.nativeAmount = credit.accumulateNative
          ? (record.nativeAmount ?? 0) + credit.nativeAmount
          : credit.nativeAmount;
      }
      if (credit.nativeAsset) record.nativeAsset = credit.nativeAsset;
      if (credit.cashuFlow) record.cashuFlow = credit.cashuFlow;
      if (credit.clearPendingX402Binding) {
        record.pendingX402Nonce = undefined;
        record.pendingX402AmountUsdcMicro = undefined;
      }
    }
    if (!isTerminal(record.status)) record.lastActivityAt = Date.now();
    this.notify(jobId);
    return Promise.resolve({
      counters: snapshotCounters(record),
      alreadyVerified: false,
      ...creditBinding(record),
      ...(refused && { creditRefused: "job_ended" as const }),
    });
  }

  getVerifiedInbound(jobId: string, seq: number): Promise<VerifyAndCreditResult | undefined> {
    const record = this.data.get(jobId);
    const stored = this.messagesFor(jobId).find((m) => m.message.seq === seq);
    if (!record || (stored?.status !== "verified" && stored?.status !== "balance")) return Promise.resolve(undefined);
    return Promise.resolve({
      counters: snapshotCounters(record),
      alreadyVerified: true,
      ...creditBinding(record),
    });
  }

  markInboundFailed(jobId: string, seq: number, _reason: string): Promise<void> {
    const stored = this.messagesFor(jobId).find((m) => m.message.seq === seq);
    if (stored?.status === "pending-verification") {
      stored.status = "failed-verify";
      this.resolveIntent(jobId, seq);
      this.notify(jobId);
    }
    return Promise.resolve();
  }

  async saveSleepSnapshot(record: JobRecord, generation: number): Promise<boolean> {
    const existing = this.data.get(record.id);
    if (!existing || existing.sleepGeneration !== generation ||
        (existing.status !== "processing" && existing.status !== "working")) return false;
    try {
      const snapshot: MemorySleepSnapshot = { ...record, sleepGeneration: generation, [SLEEP_SNAPSHOT]: true };
      await this.save(snapshot);
      return true;
    } catch (error) {
      if (error instanceof JobSupersededError) return false;
      throw error;
    }
  }

  async heartbeatJobExecutors(jobs: { id: string; generation: number }[], now: number): Promise<string[]> {
    const refreshed: string[] = [];
    for (const { id, generation } of jobs) {
      const existing = this.data.get(id);
      if (existing && existing.sleepGeneration === generation &&
          (existing.status === "processing" || existing.status === "working")) {
        existing.lastActivityAt = now;
        refreshed.push(id);
      }
    }
    return refreshed;
  }

  async beginSleep(id: string, sleep: { sleepId: string; wakeAtMs: number; generation: number }): Promise<boolean> {
    const record = this.data.get(id);
    if (!record || (record.status !== "processing" && record.status !== "working") ||
        record.sleepGeneration !== sleep.generation) return false;
    record.sleepUntilMs = sleep.wakeAtMs;
    record.sleepId = sleep.sleepId;
    record.sleepResumes = 0;
    return true;
  }

  async endSleep(id: string, generation: number): Promise<boolean> {
    const record = this.data.get(id);
    if (!record || (record.status !== "processing" && record.status !== "working") ||
        record.sleepGeneration !== generation) return false;
    delete record.sleepUntilMs;
    delete record.sleepId;
    return true;
  }

  async claimSleepingJob(id: string, expectedActivityBefore: number, now = Date.now()):
    Promise<{ sleepGeneration: number; sleepResumes: number } | undefined> {
    const record = this.data.get(id);
    if (!record || (record.status !== "processing" && record.status !== "working") ||
        record.sleepUntilMs === undefined || record.lastActivityAt > expectedActivityBefore) return;
    record.lastActivityAt = now;
    const sleepGeneration = record.sleepGeneration = (record.sleepGeneration ?? 0) + 1;
    const sleepResumes = record.sleepResumes = (record.sleepResumes ?? 0) + 1;
    return { sleepGeneration, sleepResumes };
  }

  findStaleJobs(
    processingThresholdMs: number,
    awaitingThresholdMs: number,
    limit: number,
    capabilities: string[] | null
  ): Promise<JobRecord[]> {
    const capabilitySet = capabilities === null ? null : new Set(capabilities);
    const matches: JobRecord[] = [];
    for (const record of this.data.values()) {
      const isProcessing = record.status === "processing" || record.status === "working";
      const isAwaiting = record.status === "awaiting-input";
      const eligibleStatus =
        (isProcessing && record.lastActivityAt <= processingThresholdMs) ||
        (isAwaiting && record.lastActivityAt <= awaitingThresholdMs);
      const eligibleCapability = capabilitySet === null || capabilitySet.has(record.capability);
      if (eligibleStatus && eligibleCapability) {
        matches.push(structuredClone(record));
      }
    }
    matches.sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    return Promise.resolve(matches.slice(0, limit));
  }

  async cancelStaleJob(
    jobId: string,
    expectedActivityBefore: number,
    reason: string,
    terminalStatus: "failed" | "cancelled",
    sleep?: { generation: number; parked: boolean }
  ): Promise<boolean> {
    return (await this.terminateJob(jobId, reason, terminalStatus, expectedActivityBefore,
      { kind: "release" }, { sleepGeneration: sleep?.generation, parked: sleep?.parked })) === "ended";
  }

  /** A caller's cancel stops the piece in progress and charges it. */
  async cancelJob(jobId: string, reason: string): Promise<boolean> {
    return (await this.terminateJob(jobId, reason, "cancelled", null, { kind: "stop" })) === "ended";
  }

  async failReactivation(observed: JobRecord, reason: string): Promise<boolean> {
    return (await this.terminateJob(observed.id, reason, "failed", null, { kind: "release" },
      { reactivation: observed })) === "ended";
  }

  async failJob(jobId: string, reason: string, sleepGeneration?: number): Promise<boolean> {
    return (await this.terminateJob(jobId, reason, "failed", null, { kind: "release" },
      { sleepGeneration })) === "ended";
  }

  async declineJob(jobId: string, reason: string, sleepGeneration?: number, requesterMessage = false): Promise<DeclineOutcome> {
    const outcome = await this.terminateJob(jobId, reason, "cancelled", null, { kind: "release" }, { requireOpenAsk: true, sleepGeneration, requesterMessage });
    return outcome === "ended" ? "declined" : outcome;
  }


  getCounters(jobId: string): Promise<JobCounters | undefined> {
    const record = this.data.get(jobId);
    if (!record) return Promise.resolve(undefined);
    return Promise.resolve(snapshotCounters(record));
  }

  claimForProcessing(jobId: string, sleepGeneration?: number): Promise<boolean> {
    const record = this.data.get(jobId);
    if (record?.status !== "awaiting-input" ||
        (sleepGeneration !== undefined && (record.sleepGeneration ?? 0) !== sleepGeneration)) return Promise.resolve(false);
    applyTiming(record, structuredClone(record), Date.now(), "processing");
    record.status = "processing";
    if (!isTerminal(record.status)) record.lastActivityAt = Date.now();
    return Promise.resolve(true);
  }

  async tryReactivationLock<T>(
    jobId: string,
    fn: () => Promise<T>
  ): Promise<{ acquired: true; result: T } | { acquired: false }> {
    if (this.reactivationLocks.has(jobId)) return { acquired: false };
    this.reactivationLocks.add(jobId);
    try {
      const result = await fn();
      return { acquired: true, result };
    } finally {
      this.reactivationLocks.delete(jobId);
    }
  }

  async subscribeMessages(
    jobId: string,
    afterSeq: number,
    onMessage: (msg: Message) => void
  ): Promise<() => void> {
    const sub: MessageSubscriber = { afterSeq, cb: onMessage };
    let subs = this.messageSubscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      this.messageSubscribers.set(jobId, subs);
    }
    subs.add(sub);

    const existing = await this.getMessages(jobId, afterSeq);
    for (const msg of existing) {
      if (msg.seq > sub.afterSeq) {
        sub.afterSeq = msg.seq;
        onMessage(msg);
      }
    }

    const subSet = subs;
    return () => {
      subSet.delete(sub);
      if (subSet.size === 0) this.messageSubscribers.delete(jobId);
    };
  }

  subscribeNotifications(jobId: string, onNotify: () => void): Promise<() => void> {
    let subs = this.notifySubscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      this.notifySubscribers.set(jobId, subs);
    }
    subs.add(onNotify);
    const subSet = subs;
    return Promise.resolve(() => {
      subSet.delete(onNotify);
      if (subSet.size === 0) this.notifySubscribers.delete(jobId);
    });
  }

  async getMessages(jobId: string, afterSeq: number, options?: { includeHeld?: boolean; limit?: number }): Promise<Message[]> {
    if (options?.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
      throw new RangeError("Message limit must be a positive safe integer");
    }
    return this.visibleMessages(jobId, afterSeq, options?.includeHeld, options?.limit);
  }

  initStreaming(): Promise<void> {
    return Promise.resolve();
  }

  shutdownStreaming(): Promise<void> {
    this.messageSubscribers.clear();
    this.notifySubscribers.clear();
    return Promise.resolve();
  }

  /**
   * Shared body of `cancelStaleJob` (activity cutoff supplied) and `cancelJob`
   * (`null` cutoff — unconditional). Mirrors `PostgresJobStore.terminateJob`:
   * the terminal status and the final `cancel` message land together and the
   * notify fires before the incremental log is cleaned up.
   */
  private terminateJob(
    jobId: string,
    reason: string,
    terminalStatus: "failed" | "cancelled",
    expectedActivityBefore: number | null,
    ending: PieceEnding,
    options: { requireOpenAsk?: boolean; sleepGeneration?: number; parked?: boolean; requesterMessage?: boolean; reactivation?: JobRecord } = {}
  ): Promise<"ended" | "stop_requested" | "not_active" | "no_open_ask"> {
    const record = this.data.get(jobId);
    if (!record) return Promise.resolve("not_active");
    const eligible =
      (record.status === "processing" ||
        record.status === "working" ||
        record.status === "awaiting-input") &&
      (expectedActivityBefore === null || record.lastActivityAt <= expectedActivityBefore);
    const observed = options.reactivation;
    if (!eligible || (observed && (!this.observedInboundVersions.has(observed) ||
        this.observedInboundVersions.get(observed) !== this.verifiedInboundVersions.get(jobId) ||
        !isDeepStrictEqual(record, observed)))) {
      return Promise.resolve("not_active");
    }
    if (options.sleepGeneration !== undefined && (record.sleepGeneration ?? 0) !== options.sleepGeneration) {
      return expectedActivityBefore === null ? Promise.reject(new JobSupersededError()) : Promise.resolve("not_active");
    }
    if (options.parked !== undefined && options.parked !== (record.sleepUntilMs !== undefined)) {
      return Promise.resolve("not_active");
    }
    const until = this.openIntentUntil(jobId, Date.now());
    if (until !== undefined) return Promise.reject(new PaymentIntentOpenError(jobId, until));
    const messages = this.messagesFor(jobId).filter(entry => entry.status === "verified" && !isTerminalMessage(entry.message)).map(entry => entry.message);
    const terminalMessages = messages.length ? messages : record.messages.filter(message => !isTerminalMessage(message));
    if (expectedActivityBefore !== null) {
      const deadline = callerDeadline({ ...record, messages: terminalMessages });
      const awaiting = deadline !== undefined || (record.status === "awaiting-input" && !hasCallerDeadline(terminalMessages));
      if ((terminalStatus === "cancelled") !== awaiting || (deadline !== undefined && Date.now() < deadline)) return Promise.resolve("not_active");
    }
    if (options.requireOpenAsk && !hasOpenAsk({ ...record, messages: terminalMessages })) {
      if (!record.mandate) return Promise.resolve("no_open_ask");
      record.stopRequested = true;
      return Promise.resolve("stop_requested");
    }
    const seq = this.allocateSeq(jobId);
    const terminalMessage: Message = {
      seq,
      from: options.requesterMessage ? "requester" : "provider",
      timestamp: Math.floor(Date.now() / 1000),
      type: options.requesterMessage ? "decline" : "cancel",
      content: { reason },
    } as Message;
    // Insert the cancel row before clearing — mirrors the Postgres impl's
    // ordering so any subscribeMessages listener still hanging on the
    // snapshot sees the cancel via the live stream before terminal cleanup.
    this.messagesFor(jobId).push({ message: terminalMessage, status: "verified" });
    record.endedBy = terminalStatus === "cancelled" ? "caller" : "provider";
    const ended = endPieces(record.pieces, ending);
    record.pieces = ended.pieces;
    record.settlement = ended.settlement;
    applyTiming(record, structuredClone(record), Date.now(), terminalStatus);
    record.status = terminalStatus;
    if (!options.requesterMessage) record.summary ??= reason;
    record.messages = [...terminalMessages, terminalMessage];
    record.seq = seq;
    record.lastActivityAt = Date.now();
    this.notify(jobId);
    this.deleteResolvedMessages(jobId);
    return Promise.resolve("ended");
  }

  /** The latest lease among this job's unresolved, unexpired payment intents. */
  private openIntentUntil(jobId: string, nowMs: number): number | undefined {
    let until: number | undefined;
    for (const intent of this.paymentIntents.get(jobId)?.values() ?? []) {
      if (!intent.resolved && intent.leaseExpiresAtMs > nowMs) until = Math.max(until ?? 0, intent.leaseExpiresAtMs);
    }
    return until;
  }

  /**
   * Terminal log cleanup. Mirrors `PostgresJobStore`: a payment still being
   * verified keeps its row, so its outcome can still be recorded.
   */
  private deleteResolvedMessages(jobId: string): void {
    const pending = this.messagesFor(jobId).filter((entry) =>
      entry.status === "pending-verification" && entry.message.type === "payment");
    if (pending.length) this.messages.set(jobId, pending);
    else this.messages.delete(jobId);
  }

  private resolveIntent(jobId: string, seq: number): void {
    const intent = this.paymentIntents.get(jobId)?.get(seq);
    if (intent) intent.resolved = true;
  }

  private allocateSeq(jobId: string): number {
    const seq = this.nextSeq.get(jobId) ?? 1;
    this.nextSeq.set(jobId, seq + 1);
    return seq;
  }

  private messagesFor(jobId: string): StoredMessage[] {
    let list = this.messages.get(jobId);
    if (!list) {
      list = [];
      this.messages.set(jobId, list);
    }
    return list;
  }

  private visibleMessages(jobId: string, afterSeq: number, includeHeld = false, limit?: number): Message[] {
    const stored = this.messagesFor(jobId);
    const record = this.data.get(jobId);
    const terminal = record && isTerminal(record.status);
    let boundary = Infinity;
    if (!includeHeld && !terminal) {
      for (const entry of stored) {
        if (entry.status === "pending-verification" && entry.message.type === "payment") {
          boundary = Math.min(boundary, entry.message.seq);
        }
      }
    }
    const messages = new Map<number, Message>();
    const retain = (message: Message) => {
      messages.set(message.seq, message);
      if (limit !== undefined && messages.size > limit) {
        let lastSeq = -Infinity;
        for (const seq of messages.keys()) lastSeq = Math.max(lastSeq, seq);
        messages.delete(lastSeq);
      }
    };
    if (terminal) {
      for (const message of record.messages) if (message.seq > afterSeq) retain(message);
    }
    for (const entry of stored) {
      if (entry.status === "verified" && entry.message.seq > afterSeq && entry.message.seq < boundary &&
          (!isTerminalMessage(entry.message) || (terminal && record.messages.some(message => isDeepStrictEqual(message, entry.message))))) {
        retain(entry.message);
      }
    }
    return [...messages.values()].sort((a, b) => a.seq - b.seq);
  }

  private notify(jobId: string): void {
    const subs = this.messageSubscribers.get(jobId);
    if (subs) {
      for (const sub of subs) {
        for (const message of this.visibleMessages(jobId, sub.afterSeq)) {
          sub.afterSeq = message.seq;
          sub.cb(message);
        }
      }
    }
    this.fireNotifyOnly(jobId);
  }

  private fireNotifyOnly(jobId: string): void {
    const subs = this.notifySubscribers.get(jobId);
    if (subs) for (const cb of subs) cb();
  }
}

function compareRetentionKey(
  a: Pick<JobRecord, "lastActivityAt" | "id">,
  b: Pick<JobRecord, "lastActivityAt" | "id">
): number {
  return a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id);
}

function requestIdClaimKey(requesterPubkey: string, requestId: string): string {
  return `${requesterPubkey}\u0000${requestId}`;
}

function creditBinding(record: JobRecord): { creditId?: string; drawId?: string } {
  return {
    ...(record.creditId !== undefined && { creditId: record.creditId }),
    ...(record.drawId !== undefined && { drawId: record.drawId }),
  };
}

function snapshotCounters(record: JobRecord): JobCounters {
  return {
    status: record.status,
    paidMsats: record.paidMsats,
    pendingPaymentMsats: record.pendingPaymentMsats,
    summary: record.summary,
    ...(record.pieces && { pieces: structuredClone(record.pieces) }),
  };
}

/** Timing follows committed status transitions, not snapshot activity stamps. */
function applyTiming(next: JobRecord, prior: JobRecord | undefined, now: number, status = next.status): void {
  if (prior && isTerminal(prior.status)) {
    next.endedBy = prior.endedBy;
    next.terminalAtMs = prior.terminalAtMs;
    next.callerWaitMs = prior.callerWaitMs;
    next.awaitingInputAtMs = undefined;
    return;
  }
  const start = prior?.awaitingInputAtMs ?? (prior?.status === "awaiting-input" ? prior.lastActivityAt : undefined);
  next.callerWaitMs = (prior?.callerWaitMs ?? next.callerWaitMs ?? 0) +
    (start !== undefined && status !== "awaiting-input" ? Math.max(0, now - start) : 0);
  next.awaitingInputAtMs = status === "awaiting-input" ? start ?? now : undefined;
  if (isTerminal(status)) {
    next.terminalAtMs = now;
    next.endedBy = status === "completed" ? undefined : next.endedBy ?? "provider";
  }
}
