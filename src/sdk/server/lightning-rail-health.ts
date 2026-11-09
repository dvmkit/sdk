import { diagnosticConsole } from "../../observability/diagnostic-console";
/** Cached liveness signal for a platform-hosted DVM's Lightning receive rail. */
export interface LightningRailHealth {
  available(): boolean;
  /** Prime the cached signal at boot when the source supports it. */
  refresh?(): Promise<void>;
  /**
   * Return a refresh worth awaiting before a funding menu is built, when the cached signal
   * would withhold the rail and may be out of date, or nothing when the cache already answers.
   * Callers bound the wait; the refresh may outlive it.
   */
  ensureFresh?(): Promise<void> | undefined;
}

export interface PlatformLightningRailHealthConfig {
  /** Authenticated platform endpoint returning the derived rail-health signal. */
  url: string;
  /** Per-DVM platform bearer token. Never the Hub credential. */
  token?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Refresh cadence for the cached platform pull. */
  refreshTtlMs?: number;
  /** Maximum age of a Hub observation that may keep the rail advertised. */
  maxStalenessMs?: number;
  /** Retries after the first failed platform pull. */
  retries?: number;
  /** Ceiling on one platform pull attempt, including its body. */
  timeoutMs?: number;
}

export const LIGHTNING_RAIL_HEALTH_REFRESH_TTL_MS = 5 * 60 * 1000;

/** Fail-open ceiling: three missed hourly Hub observations. */
export const LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS = 3 * 60 * 60 * 1000;

export const LIGHTNING_RAIL_HEALTH_RETRIES = 2;

/**
 * Ceiling on one platform pull attempt. Without it a hung pull holds the shared refresh, so no
 * later refresh starts and every funding menu's bounded wait runs out on it. Two seconds matches
 * the Tempo observer's probe ceiling for the same kind of authenticated platform read, and the
 * menu waits no longer than that anyway, so a slower attempt cannot help the request waiting on
 * it; with the default retries a refresh ends within about six seconds.
 */
export const LIGHTNING_RAIL_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Read platform-derived receive liveness using the per-DVM bearer, without Hub credentials.
 * available remains synchronous and starts background refresh. Use the last observation until
 * its staleness ceiling; with no observation, measure that grace period from construction.
 */
export class PlatformLightningRailHealth implements LightningRailHealth {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshTtlMs: number;
  private readonly maxStalenessMs: number;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly startedAtMs: number;
  private observation: RailHealthObservation | undefined;
  private lastAttemptAtMs: number | undefined;
  private inFlight: Promise<void> | undefined;
  private ceilingLoggedForMs: number | undefined;

  constructor(private readonly config: PlatformLightningRailHealthConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.now = config.now ?? Date.now;
    this.refreshTtlMs = config.refreshTtlMs ?? LIGHTNING_RAIL_HEALTH_REFRESH_TTL_MS;
    this.maxStalenessMs = config.maxStalenessMs ?? LIGHTNING_RAIL_HEALTH_MAX_STALENESS_MS;
    this.retries = config.retries ?? LIGHTNING_RAIL_HEALTH_RETRIES;
    this.timeoutMs = config.timeoutMs ?? LIGHTNING_RAIL_HEALTH_TIMEOUT_MS;
    this.startedAtMs = this.now();
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAtMs = this.now();
    const refresh = this.refreshOnce();
    this.inFlight = refresh;
    try {
      await refresh;
    } finally {
      this.inFlight = undefined;
    }
  }

  /**
   * Offer a refresh to wait on only when the cache would withhold the rail: an observation past
   * the staleness ceiling (as after a long suspend) or one reporting `routable: false`. A
   * positive observation inside the ceiling answers without waiting. Joins a refresh in flight;
   * otherwise starts one only once the pull interval has passed, as {@link available} would, so
   * a recently pulled `routable: false` is answered as is and the platform sees no more pulls.
   */
  ensureFresh(): Promise<void> | undefined {
    const nowMs = this.now();
    if (this.ageMs(nowMs) < this.maxStalenessMs && this.observation?.routable !== false) {
      return undefined;
    }
    if (this.inFlight) return this.inFlight;
    if (this.lastAttemptAtMs !== undefined && nowMs - this.lastAttemptAtMs < this.refreshTtlMs) {
      return undefined;
    }
    return this.refresh();
  }

  available(): boolean {
    const nowMs = this.now();
    if (this.lastAttemptAtMs === undefined || nowMs - this.lastAttemptAtMs >= this.refreshTtlMs) {
      void this.refresh();
    }

    const observedAtMs = this.observation?.observedAtMs ?? this.startedAtMs;
    const ageMs = this.ageMs(nowMs);
    if (ageMs >= this.maxStalenessMs) {
      if (this.ceilingLoggedForMs !== observedAtMs) {
        this.ceilingLoggedForMs = observedAtMs;
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "lightning_rail_health_staleness_ceiling",
            message:
              undefined,
            age_ms: ageMs,
            staleness_ceiling_ms: this.maxStalenessMs,
          }
        );
      }
      return false;
    }
    return this.observation?.routable ?? true;
  }

  private ageMs(nowMs: number): number {
    return Math.max(0, nowMs - (this.observation?.observedAtMs ?? this.startedAtMs));
  }

  private async refreshOnce(): Promise<void> {
    let reason = "unavailable";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const response = await this.fetchFn(this.config.url, {
          headers: {
            ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
            Accept: "application/json",
          },
          signal: abort.signal,
        });
        if (!response.ok) {
          reason = `http_${response.status.toString()}`;
          continue;
        }
        const observation = parseObservation(await response.json());
        if (!observation) {
          reason = "malformed_response";
          continue;
        }
        this.observation = observation;
        this.ceilingLoggedForMs = undefined;
        return;
      } catch {
        reason = "unreachable";
      } finally {
        clearTimeout(timer);
      }
    }

    const nowMs = this.now();
    const observedAtMs = this.observation?.observedAtMs ?? this.startedAtMs;
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "lightning_rail_health_fallback",
        message:
          undefined,
        reason,
        age_ms: Math.max(0, nowMs - observedAtMs),
        staleness_ceiling_ms: this.maxStalenessMs,
      }
    );
  }
}

export function createPlatformLightningRailHealth(
  env: Record<string, string | undefined>
): PlatformLightningRailHealth | undefined {
  const platformUrl = env.DVMKIT_PLATFORM_URL;
  if (!platformUrl) return undefined;
  return new PlatformLightningRailHealth({
    url: `${platformUrl.replace(/\/+$/, "")}/_internal/lightning-rail-health`,
    token: env.DVMKIT_PLATFORM_TOKEN,
  });
}

interface RailHealthObservation {
  routable: boolean;
  observedAtMs: number;
}

function parseObservation(value: unknown): RailHealthObservation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { routable, observed_at_ms } = value as { routable?: unknown; observed_at_ms?: unknown };
  if (
    typeof routable !== "boolean" ||
    typeof observed_at_ms !== "number" ||
    !Number.isSafeInteger(observed_at_ms) ||
    observed_at_ms < 0
  ) {
    return undefined;
  }
  return { routable, observedAtMs: observed_at_ms };
}
