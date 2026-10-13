import { diagnosticConsole } from "../../observability/diagnostic-console";
/** In-process mint health gates advertising and new receives. Paid calls wait for
 * the first probe; NUT incompatibility fails immediately, transient failures
 * use a consecutive threshold. Existing accumulator proofs remain at their mint. */

import { checkMintHealth, type CheckMintHealthOptions } from "../../lib/cashu/health";
import { normaliseMintUrl } from "../../lib/cashu/verify";

export const DEFAULT_TICK_INTERVAL_MS = 5 * 60 * 1000;

export const DEFAULT_FAILURES_TO_SICK = 3;

export interface MintHealthSnapshot {
  /** Last-observed wall-clock latency of the probe in ms. */
  latencyMs?: number;
  /** Consecutive failures up to the most recent tick. Reset on any success. */
  consecutiveFailures: number;
  /**
   * True once the mint is considered unhealthy for routing: either
   * `consecutiveFailures` crossed the threshold, or the last probe reached the
   * mint but it fails the NUT gate, a deterministic, permanent config error
   * that flips `sick` immediately.
   */
  sick: boolean;
  /**
   * True when the last successful probe reached the mint but it fails the NUT
   * capability gate ({@link assertNutSupport}'s required NUTs + bolt11/sat).
   * Distinct from a plain outage: NUT-incompatibility is deterministic and
   * never resolves without a config/mint change.
   */
  nutIncompatible?: boolean;
  version?: string;
  errorCode?: string;
}

export interface MintHealthTrackerOptions {
  /** Cashu mint URLs the DVM accepts. The tracker probes every entry. */
  mints: string[];
  /** Host environment used for default timing and failure settings. */
  env?: Record<string, string | undefined>;
  /**
   * Tick cadence in ms. Defaults to {@link DEFAULT_TICK_INTERVAL_MS} or the
   * `DVMKIT_MINT_HEALTH_TICK_MS` env var when set.
   */
  tickIntervalMs?: number;
  /**
   * Consecutive failed probes before flipping a mint to `sick`. Defaults to
   * {@link DEFAULT_FAILURES_TO_SICK} or `DVMKIT_MINT_FAILURES_TO_SICK` env.
   */
  consecutiveFailuresToSick?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Forwarded to checkMintHealth; fetchImpl is supplied on the tracker. */
  probe?: Omit<CheckMintHealthOptions, "fetchImpl">;
}

export class MintHealthTracker {
  private readonly mints: string[];
  private readonly tickIntervalMs: number;
  private readonly failuresToSick: number;
  private readonly fetchImpl?: typeof fetch;
  private readonly probeOpts: CheckMintHealthOptions;
  private readonly nowFn: () => number;
  private readonly state: Map<string, MintHealthSnapshot>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private inFlight?: Promise<void>;
  private firstProbeComplete = false;

  constructor(opts: MintHealthTrackerOptions) {
    this.mints = [...opts.mints];
    this.tickIntervalMs = opts.tickIntervalMs ?? resolveEnvTickMs(opts.env);
    this.failuresToSick = opts.consecutiveFailuresToSick ?? resolveEnvFailuresToSick(opts.env);
    this.fetchImpl = opts.fetchImpl;
    this.probeOpts = { ...opts.probe, fetchImpl: opts.fetchImpl };
    this.nowFn = opts.now ?? Date.now;
    // State keyed by normalised URL so lookups against caller-supplied values
    // (e.g. `meta.mint` from a token) tolerate trailing-slash / case drift.
    this.state = new Map(
      this.mints.map((m) => [normaliseMintUrl(m), { consecutiveFailures: 0, sick: false }] as const)
    );
  }

  /** Kick off the periodic probe. Runs one tick immediately. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.tickIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the timer. Safe to call multiple times. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Probe every configured mint once. Sequential per mint to bound concurrent
   * outbound load; the tick cadence makes parallelism unnecessary.
   */
  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        for (const mintUrl of this.mints) {
          const result = await checkMintHealth(mintUrl, this.probeOpts);
          this.applyResult(mintUrl, result);
        }
      } finally {
        this.inFlight = undefined;
        // Mark complete only after every configured mint has been applied; summarize once.
        if (!this.firstProbeComplete) {
          this.firstProbeComplete = true;
          this.logBootHealth();
        }
      }
    })();
    return this.inFlight;
  }

  /**
   * True once the first full probe tick has landed. Before this, paid calls
   * are held at `503 mint_health_pending` rather than accepted against
   * unvalidated mints.
   */
  initialProbeComplete(): boolean {
    return this.firstProbeComplete;
  }

  /**
   * True when the mint is either healthy or unknown to the tracker. Unknown
   * mints (e.g. a value coming in via an externally-supplied tracker) get the
   * benefit of the doubt — the receive path's mint-allowlist check is the
   * authoritative gate on which mints the DVM accepts.
   */
  isHealthy(mintUrl: string): boolean {
    const snapshot = this.state.get(normaliseMintUrl(mintUrl));
    if (!snapshot) return true;
    return !snapshot.sick;
  }

  /** Currently-healthy subset of the configured mints, preserving config order. */
  healthyMints(): string[] {
    return this.mints.filter((m) => this.isHealthy(m));
  }

  /**
   * True when the last probe reached the mint but it failed the NUT capability
   * gate — a deterministic, permanent config error, unlike a transient outage.
   * Unknown mints return false. `advertisedMints()` uses this to keep a
   * permanently-unsettleable mint off `/v1/info` even in the all-sick fallback,
   * where a merely-flapping mint is still published.
   */
  isNutIncompatible(mintUrl: string): boolean {
    return this.state.get(normaliseMintUrl(mintUrl))?.nutIncompatible ?? false;
  }

  snapshot(): Record<string, MintHealthSnapshot> {
    return Object.fromEntries(Array.from(this.state.entries()).map(([k, v]) => [k, { ...v }]));
  }

  private applyResult(mintUrl: string, result: Awaited<ReturnType<typeof checkMintHealth>>): void {
    const key = normaliseMintUrl(mintUrl);
    const previous = this.state.get(key) ?? { consecutiveFailures: 0, sick: false };

    if (result.ok && result.nutCompliant) {
      const next: MintHealthSnapshot = {
        consecutiveFailures: 0,
        sick: false,
        latencyMs: result.latencyMs,
        version: result.version,
      };
      this.state.set(key, next);
      if (previous.sick) {
        diagnosticConsole.log(
          {
            level: "cashu_mint_runtime_recovered",
            mintUrl,
            latencyMs: result.latencyMs,
            version: result.version,
            observedAt: this.nowFn(),
          }
        );
      }
      return;
    }

    // Reachable but NUT-incompatible: a deterministic, permanent config error.
    // Flip `sick` immediately (bypass the consecutive-failure threshold) so the
    // mint drops off `/v1/info` and the receive path from the very first probe
    // a benefit-of-the-doubt window would advertise a mint we can never
    // settle against.
    const nutIncompatible = result.ok && !result.nutCompliant;
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const sick = previous.sick || nutIncompatible || consecutiveFailures >= this.failuresToSick;
    this.state.set(key, {
      consecutiveFailures,
      sick,
      nutIncompatible: nutIncompatible || undefined,
      latencyMs: result.latencyMs,
      version: nutIncompatible ? result.version : previous.version,
      errorCode: nutIncompatible ? "nut_support_missing" : result.error?.code,
    });
    if (!previous.sick && sick) {
      diagnosticConsole.log(
        nutIncompatible
            ? {
                level: "cashu_mint_nut_incompatible",
                mintUrl,
                version: result.version,
                observedAt: this.nowFn(),
              }
            : {
                level: "cashu_mint_runtime_sick",
                mintUrl,
                consecutiveFailures,
                error: undefined,
                observedAt: this.nowFn(),
              }
      );
    }
  }

  /** One boot summary, including an all-unhealthy warning. */
  private logBootHealth(): void {
    // Report whether each mint's *last probe passed* (`consecutiveFailures ===
    // 0`), not the sticky `sick` flag — a mint that failed its very first probe
    // isn't `sick` yet (that needs the full failure threshold), but at boot we
    // want the honest "did it answer right now" signal so the all-unhealthy
    // warning fires on a genuine cold outage.
    const mints = Object.entries(this.snapshot()).map(([mintUrl, s]) => ({
      mintUrl,
      probeOk: s.consecutiveFailures === 0,
      nutIncompatible: s.nutIncompatible ?? false,
      latencyMs: s.latencyMs,
      version: s.version,
      errorCode: s.errorCode,
    }));
    const healthy = mints.filter((m) => m.probeOk).length;
    diagnosticConsole.log(
      {
        level: healthy === 0 && mints.length > 0 ? "warn" : "cashu_mint_boot_health",
        event: "cashu_mint_boot_health",
        healthyMints: healthy,
        totalMints: mints.length,
        allUnhealthy: healthy === 0 && mints.length > 0,
        mints,
        observedAt: this.nowFn(),
      }
    );
  }
}

function resolveEnvTickMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DVMKIT_MINT_HEALTH_TICK_MS;
  if (!raw) return DEFAULT_TICK_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TICK_INTERVAL_MS;
  return Math.floor(parsed);
}

function resolveEnvFailuresToSick(env: Record<string, string | undefined> = process.env): number {
  const raw = env.DVMKIT_MINT_FAILURES_TO_SICK;
  if (!raw) return DEFAULT_FAILURES_TO_SICK;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_FAILURES_TO_SICK;
  return parsed;
}
