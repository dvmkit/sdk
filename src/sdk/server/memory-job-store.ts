import { callerDeadline, hasCallerDeadline } from "./job";
import { applyContentHoldMutation, ContentHoldError, type ContentHoldHistory, type ContentHoldMutation } from "./content-retention";
import type { Message } from "../../lib/messages/types";
import type { JobReceipt } from "../../lib/receipt";
import { isTerminal } from "./job";
import type {
  AppendOutgoingOptions,
  JobCounters,
  JobRecord,
  JobRetentionCursor,
  OutgoingMessage,
  PaymentCreditDelta,
  ReceiptIssuingStore,
  RequestIdClaim,
  RequestIdClaimResult,
  StreamableJobStore,
  VerifyAndCreditResult,
} from "./job-store";
import { accumulateAskedTopUp } from "./job-store";

interface StoredMessage {
  message: Message;
  status: "verified" | "pending-verification" | "failed-verify";
}

interface MessageSubscriber {
  afterSeq: number;
  cb: (msg: Message) => void;
}

interface StoredRequestIdClaim extends RequestIdClaim {
  holderToken?: string;
}

/**
 * In-memory JobStore implementing the transactional + streaming surface;
 * used by unit tests and not production-safe — there's no real
 * concurrency control beyond JS's single-threaded execution.
 */
export class MemoryJobStore implements StreamableJobStore, ReceiptIssuingStore {
  private contentHolds = new Map<string, ContentHoldHistory>();
  private data = new Map<string, JobRecord>();
  private messages = new Map<string, StoredMessage[]>();
  private nextSeq = new Map<string, number>();
  private messageSubscribers = new Map<string, Set<MessageSubscriber>>();
  private notifySubscribers = new Map<string, Set<() => void>>();
  private reactivationLocks = new Set<string>();
  private requestIdClaims = new Map<string, StoredRequestIdClaim>();
  private receiptCounter = 0;
  private receiptSeqs = new Map<string, number>();

  get(id: string): Promise<JobRecord | undefined> {
    const record = this.data.get(id);
    return Promise.resolve(record ? structuredClone(record) : undefined);
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

  save(record: JobRecord): Promise<void> {
    // terminal is terminal — mirrors `PostgresJobStore.save`'s
    // ON CONFLICT guard. A handler still running on another machine (the cancel
    // landed there, not here) must not overwrite the cancelled row with
    // `completed`. Re-saving the same terminal status is allowed (idempotent
    // re-persist of the same outcome).
    const existing = this.data.get(record.id);
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
    // `receipt` and `receiptSeq` are owned by `saveReceipt` /
    // `claimReceiptSeq`, never by the snapshot path — mirrors the Postgres
    // store, whose `save` statement simply doesn't list those columns. Without
    // this, a snapshot taken before the receipt was signed would clear it.
    const snapshot = structuredClone(record);
    if (existing) snapshot.createdAt = existing.createdAt;
    if (existing && isTerminal(existing.status)) snapshot.lastActivityAt = existing.lastActivityAt;
    if (existing?.receipt) snapshot.receipt = existing.receipt;
    snapshot.timingKnown = existing ? existing.timingKnown ?? false : record.timingKnown ?? true;
    applyTiming(snapshot, existing, Date.now());
    this.data.set(record.id, snapshot);
    const cur = this.nextSeq.get(record.id) ?? 1;
    this.nextSeq.set(record.id, Math.max(cur, record.seq + 1));
    if (isTerminal(record.status)) {
      this.messages.delete(record.id);
    }
    return Promise.resolve();
  }

  delete(id: string): Promise<void> {
    this.contentHolds.delete(id);
    this.data.delete(id);
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
    record.receivedProofs = [];
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
    this.notify(jobId, fullMessage);
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

  verifyAndCredit(
    jobId: string,
    seq: number,
    credit: PaymentCreditDelta | null
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
    stored.status = "verified";
    if (credit) {
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
    this.notify(jobId, stored.message);
    return Promise.resolve({
      counters: snapshotCounters(record),
      alreadyVerified: false,
      ...creditBinding(record),
    });
  }

  getVerifiedInbound(jobId: string, seq: number): Promise<VerifyAndCreditResult | undefined> {
    const record = this.data.get(jobId);
    const stored = this.messagesFor(jobId).find((m) => m.message.seq === seq);
    if (!record || stored?.status !== "verified") return Promise.resolve(undefined);
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
    }
    return Promise.resolve();
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

  heartbeatActiveJobs(jobIds: string[], now: number): Promise<void> {
    for (const id of jobIds) {
      const record = this.data.get(id);
      if (record && (record.status === "processing" || record.status === "working")) {
        record.lastActivityAt = now;
      }
    }
    return Promise.resolve();
  }

  cancelStaleJob(
    jobId: string,
    expectedActivityBefore: number,
    reason: string,
    terminalStatus: "failed" | "cancelled"
  ): Promise<boolean> {
    return this.terminateJob(jobId, reason, terminalStatus, expectedActivityBefore);
  }

  cancelJob(jobId: string, reason: string): Promise<boolean> {
    return this.terminateJob(jobId, reason, "cancelled", null);
  }

  getCounters(jobId: string): Promise<JobCounters | undefined> {
    const record = this.data.get(jobId);
    if (!record) return Promise.resolve(undefined);
    return Promise.resolve(snapshotCounters(record));
  }

  claimForProcessing(jobId: string): Promise<boolean> {
    const record = this.data.get(jobId);
    if (record?.status !== "awaiting-input") return Promise.resolve(false);
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

  getMessages(jobId: string, afterSeq: number): Promise<Message[]> {
    const stored = this.messagesFor(jobId);
    return Promise.resolve(
      stored
        .filter((m) => m.status === "verified" && m.message.seq > afterSeq)
        .map((m) => m.message)
    );
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
    expectedActivityBefore: number | null
  ): Promise<boolean> {
    const record = this.data.get(jobId);
    if (!record) return Promise.resolve(false);
    const eligible =
      (record.status === "processing" ||
        record.status === "working" ||
        record.status === "awaiting-input") &&
      (expectedActivityBefore === null || record.lastActivityAt <= expectedActivityBefore);
    if (!eligible) return Promise.resolve(false);
    let terminalMessages = record.messages;
    if (expectedActivityBefore !== null) {
      const messages = this.messagesFor(jobId).filter((entry) => entry.status === "verified").map((entry) => entry.message);
      const history = messages.length ? messages : record.messages;
      terminalMessages = history;
      const deadline = callerDeadline({ ...record, messages: history });
      const awaiting = deadline !== undefined || (record.status === "awaiting-input" && !hasCallerDeadline(history));
      if ((terminalStatus === "cancelled") !== awaiting || (deadline !== undefined && Date.now() < deadline)) return Promise.resolve(false);
    }
    const seq = this.allocateSeq(jobId);
    const cancelMsg: Message = {
      seq,
      from: "provider",
      timestamp: Math.floor(Date.now() / 1000),
      type: "cancel",
      content: { reason },
    } as Message;
    // Insert the cancel row before clearing — mirrors the Postgres impl's
    // ordering so any subscribeMessages listener still hanging on the
    // snapshot sees the cancel via the live stream before terminal cleanup.
    this.messagesFor(jobId).push({ message: cancelMsg, status: "verified" });
    record.endedBy = expectedActivityBefore === null || terminalStatus === "cancelled" ? "caller" : "provider";
    applyTiming(record, structuredClone(record), Date.now(), terminalStatus);
    record.status = terminalStatus;
    record.summary = record.summary ?? reason;
    record.messages = [...terminalMessages, cancelMsg];
    record.seq = seq;
    record.lastActivityAt = Date.now();
    this.notify(jobId, cancelMsg);
    this.messages.delete(jobId);
    return Promise.resolve(true);
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

  private notify(jobId: string, message: Message): void {
    const subs = this.messageSubscribers.get(jobId);
    if (subs) {
      for (const sub of subs) {
        if (message.seq > sub.afterSeq) {
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
