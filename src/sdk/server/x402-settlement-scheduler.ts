import { diagnosticConsole } from "../../observability/diagnostic-console";
import type {
  AutoSettlementConfig,
  AutoSettlementContext,
  ChannelStorage,
  ClaimOptions,
  ClaimResult,
  RefundResult,
  SettleResult,
} from "@x402/evm/batch-settlement/server";

export interface X402ChannelManagerLike {
  claim(opts?: ClaimOptions): Promise<ClaimResult[]>;
  settle(): Promise<SettleResult>;
  refund(channelIds?: string[]): Promise<RefundResult[]>;
}

/**
 * Fleet-wide replacement for upstream's in-process `pendingSettle` flag.
 *
 * Upstream only settles after a claim landed, so an idle receiver never pays
 * gas for a transfer of nothing. That flag lives in one process; a Postgres
 * fleet claims under an advisory lock from whichever machine won the tick, so
 * the marker has to outlive the process that set it.
 */
export interface X402SettlePendingMarker {
  read(): Promise<boolean>;
  write(pending: boolean): Promise<void>;
}

export interface X402FleetSettlementSchedulerOpts {
  manager: X402ChannelManagerLike;
  storage: ChannelStorage;
  config: AutoSettlementConfig;
  /** Runs one job under the fleet-wide settlement lock; `false` when another machine holds it. */
  withLock: (operation: () => Promise<void>) => Promise<boolean>;
  marker: X402SettlePendingMarker;
}

/** Handle for tearing the scheduler's timers down at shutdown. */
export interface X402FleetSettlementScheduler {
  stop(): void;
}

/**
 * Start the claim, settle and refund timers for a Postgres-backed DVM.
 *
 * Upstream's `manager.start()` coordinates one process: its timers, its job
 * queue, its `pendingSettle`. A dvmkit fleet shares one database, so every job
 * runs under the fleet settlement lock instead and the settle gate reads a
 * durable {@link X402SettlePendingMarker}. Everything else mirrors upstream's
 * `runClaimJob` / `runSettleJob` / `runRefundJob` — the same
 * {@link AutoSettlementConfig} a builder writes has to mean the same thing in
 * production as it does against in-memory storage in dev.
 *
 * The marker is written *after* a claim lands, not before. A crash in that
 * window leaves claimed funds sitting unsettled until the next claim sets it —
 * the batching model's own latency — where a pessimistic write would leave a
 * marker no settle can ever clear, which is the every-interval settle storm
 * this scheduler exists to end.
 */
export function createX402FleetSettlementScheduler(
  opts: X402FleetSettlementSchedulerOpts
): X402FleetSettlementScheduler {
  const { manager, storage, config, withLock, marker } = opts;
  const timers: ReturnType<typeof setInterval>[] = [];
  const queued = new Set<SettlementJob>();
  let draining = false;
  let stopped = false;
  let lastClaimTime = Date.now();
  let lastSettleTime = Date.now();

  const context = (pendingSettle: boolean): AutoSettlementContext => ({
    now: Date.now(),
    lastClaimTime,
    lastSettleTime,
    pendingSettle,
  });

  const report = (error: unknown): void => {
    if (config.onError) config.onError(error);
    else diagnosticConsole.error("x402 batch-settlement scheduler failed", error);
  };

  const runClaim = async (): Promise<void> => {
    const results = await manager.claim({
      maxClaimsPerBatch: config.maxClaimsPerBatch ?? 100,
      ...(config.selectClaimChannels ? { selectClaimChannels: config.selectClaimChannels } : {}),
    });
    if (results.length > 0) await marker.write(true);
    lastClaimTime = Date.now();
    for (const result of results) config.onClaim?.(result);
  };

  const runSettle = async (): Promise<void> => {
    if (!(await marker.read())) return;
    if (config.shouldSettle && !(await config.shouldSettle(context(true)))) return;
    const result = await manager.settle();
    await marker.write(false);
    lastSettleTime = Date.now();
    config.onSettle?.(result);
  };

  const runRefund = async (): Promise<void> => {
    const selector = config.selectRefundChannels;
    if (!selector) return;
    const channels = await storage.list();
    const targets = await selector(channels, context(await marker.read()));
    for (const target of targets) {
      // A refund whose channel still owes vouchers claims them on-chain in the
      // same multicall and then deletes the row, so no later claim can ever
      // raise the marker for it. Whether it claimed is read from the pre-refund
      // snapshot, not from the result — a refund that carried no claims must
      // not leave a marker behind for a settle with nothing to transfer.
      const claiming = BigInt(target.chargedCumulativeAmount) > BigInt(target.totalClaimed);
      // One channel per call so a facilitator failure part-way through a batch
      // still leaves the marker raised for the refunds that already landed.
      const results = await manager.refund([target.channelId]);
      if (claiming && results.length > 0) await marker.write(true);
      for (const result of results) config.onRefund?.(result);
    }
  };

  const run = async (job: SettlementJob): Promise<void> => {
    if (job === "claim") return runClaim();
    if (job === "settle") return runSettle();
    return runRefund();
  };

  const drain = async (): Promise<void> => {
    draining = true;
    try {
      while (!stopped && queued.size > 0) {
        const job = JOB_PRIORITY.find((candidate) => queued.has(candidate));
        if (!job) return;
        queued.delete(job);
        // A tick that loses the fleet lock is skipped, not retried: another
        // machine is doing this job right now.
        await withLock(() => run(job)).catch(report);
      }
    } finally {
      draining = false;
    }
  };

  const enqueue = (job: SettlementJob): void => {
    if (stopped) return;
    queued.add(job);
    if (!draining) void drain();
  };

  const startTimer = (job: SettlementJob, intervalSecs: number | undefined): void => {
    if (intervalSecs === undefined) return;
    const timer = setInterval(() => {
      enqueue(job);
    }, intervalSecs * 1000);
    timer.unref();
    timers.push(timer);
  };

  startTimer("claim", config.claimIntervalSecs);
  startTimer("settle", config.settleIntervalSecs);
  startTimer("refund", config.refundIntervalSecs);

  return {
    stop(): void {
      stopped = true;
      queued.clear();
      for (const timer of timers) clearInterval(timer);
      timers.length = 0;
    },
  };
}

/** Claim before settle before refund, matching upstream's `AUTO_JOB_PRIORITY`. */
const JOB_PRIORITY = ["claim", "settle", "refund"] as const;

type SettlementJob = (typeof JOB_PRIORITY)[number];
