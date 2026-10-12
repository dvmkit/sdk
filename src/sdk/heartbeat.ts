export interface ProgressHeartbeatOpts {
  /**
   * Progress emitter — typically `ctx.progress.bind(ctx)` in a handler, or a
   * plumbed-through callback in DVM internals. When omitted, the helper just
   * runs `fn` with no overhead.
   */
  onProgress?: (percentComplete: number, phase: string) => void;

  phase: string;
  /** Percent (0-100) emitted with each heartbeat. Stays constant across the run. */
  percent: number;
  /**
   * Heartbeat cadence in milliseconds. Default 30s, so a single missed tick
   * still emits progress within the one-minute contract.
   */
  intervalMs?: number;
}

/**
 * Wrap a long-running async op with a periodic progress heartbeat at fixed
 * `phase` and `percent`. Emits one heartbeat synchronously on entry, then
 * repeats every `intervalMs` until `fn` settles. Use to keep agents informed
 * during slow single-call operations (e.g. Whisper transcribe, diariser
 * polling) where the percent doesn't naturally advance.
 *
 * Phase transitions should still be emitted directly via `ctx.progress(...)`
 * before/after the wrapped call — this helper only covers the "I'm alive,
 * still in this phase" case.
 */
export async function withProgressHeartbeat<T>(
  opts: ProgressHeartbeatOpts,
  fn: () => Promise<T>
): Promise<T> {
  const onProgress = opts.onProgress;
  if (!onProgress) return fn();

  const intervalMs = opts.intervalMs ?? 30_000;
  onProgress(opts.percent, opts.phase);
  const timer = setInterval(() => {
    onProgress(opts.percent, opts.phase);
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
