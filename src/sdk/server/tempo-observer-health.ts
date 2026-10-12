import { diagnosticConsole } from "../../observability/diagnostic-console";
/**
 * Cached liveness signal for the platform's central Tempo close observer
 *
 * A TIP-1034 session channel is only safe to accept while something is
 * watching the chain for its close: without that, a caller can consume value,
 * request a close, wait out the 900-second grace period and withdraw. So this
 * gate is **fail-closed**, which is the opposite of `lightning-rail-health.ts`
 * there, withholding a rail over an outage costs a sale; here, advertising
 * one costs the money. `tempo/charge` is untouched either way: a charge is an
 * ordinary payment with no channel and no close to watch.
 */
export interface TempoObserverHealth {
  /** Whether `tempo/session` may be advertised and issued at this instant. */
  available(): boolean;
  /**
   * Await a usable observation before a menu is rendered.
   *
   * The gate is fail-closed and `available()` is synchronous, so without this
   * the first render after every cold start — and after every resume from a
   * suspend long enough to age the cache out — would withhold `tempo/session`
   * purely because the probe had not returned yet. On a scale-to-zero DVM that
   * is the request that decides the funding path, so it must not be the one
   * request that is answered from no data. Cheap in steady state: it returns
   * without awaiting anything while a usable observation is in hand.
   */
  ensureFresh?(): Promise<void>;
  /** Prime the cached signal at boot. */
  refresh?(): Promise<void>;
  /**
   * Report the OR of mounted session capabilities to keep the platform's
   * observer watch signal current. Readers must use configuration, not current
   * availability: an observer outage must not erase the capability it watches.
   * The returned disposer removes a mount's contribution on shutdown.
   */
  declareSessionCapability?(read: () => boolean): () => void;
}

export interface PlatformTempoObserverHealthConfig {
  /** Authenticated platform endpoint returning observer cursor freshness. */
  url: string;
  /** Per-DVM platform bearer token. */
  token?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  /** How often to revalidate. */
  refreshTtlMs?: number;
  /** Oldest cursor advance that still counts as watching. */
  maxCursorAgeMs?: number;
  /** How long an unreachable platform may be tolerated before withholding. */
  maxStalenessMs?: number;
  /** Ceiling on one probe, so a blocking `ensureFresh` cannot hang a menu. */
  timeoutMs?: number;
}

/** How often a DVM revalidates observer health. */
export const TEMPO_OBSERVER_HEALTH_REFRESH_TTL_MS = 60 * 1000;

/**
 * Oldest cursor advance that still counts as watching.
 *
 * The observer polls every 30s; two minutes is four missed ticks, and still
 * leaves most of the 900-second grace period to notice, wake and settle.
 */
export const TEMPO_OBSERVER_HEALTH_MAX_CURSOR_AGE_MS = 2 * 60 * 1000;

/**
 * How long a DVM keeps offering sessions while the platform is unreachable.
 *
 * Not zero, because a single failed poll is usually a blip and dropping the
 * offer on it would make sessions unusable. Short, because past this we cannot
 * tell a blip from an observer that has been down for an hour.
 */
export const TEMPO_OBSERVER_HEALTH_MAX_STALENESS_MS = 5 * 60 * 1000;

/**
 * Ceiling on one probe.
 *
 * Only a blocking {@link PlatformTempoObserverHealth.ensureFresh} ever waits on
 * it, and only when there is no usable observation to answer from — so this is
 * the worst a cold start adds to the request that renders a funding menu. Past
 * it the render proceeds fail-closed, which is the same answer an unreachable
 * platform gets anyway.
 */
export const TEMPO_OBSERVER_HEALTH_TIMEOUT_MS = 2_000;

/**
 * Pulls observer freshness over the existing per-DVM bearer channel.
 *
 * `available()` is synchronous because it runs while every funding menu is
 * rendered; a stale cache kicks off a background refresh and the last
 * observation stays authoritative until the staleness ceiling.
 */
export class PlatformTempoObserverHealth implements TempoObserverHealth {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly refreshTtlMs: number;
  private readonly maxCursorAgeMs: number;
  private readonly maxStalenessMs: number;
  private readonly timeoutMs: number;
  private observation: { healthy: boolean; receivedAtMs: number } | undefined;
  private lastAttemptAtMs: number | undefined;
  private inFlight: { probe: Promise<void>; epoch: number } | undefined;
  private withheldLogged = false;
  private sessionCapabilityReaders: (() => boolean)[] = [];
  /**
   * Bumped by every declaration, and stamped on the probe in flight.
   *
   * A probe that started before the newest declaration was built from a
   * capability that is no longer this deployment's answer — at boot, from no
   * capability at all — so {@link refresh} must not hand it back as one.
   */
  private declarationEpoch = 0;

  constructor(private readonly config: PlatformTempoObserverHealthConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.now = config.now ?? Date.now;
    this.refreshTtlMs = config.refreshTtlMs ?? TEMPO_OBSERVER_HEALTH_REFRESH_TTL_MS;
    this.maxCursorAgeMs = config.maxCursorAgeMs ?? TEMPO_OBSERVER_HEALTH_MAX_CURSOR_AGE_MS;
    this.maxStalenessMs = config.maxStalenessMs ?? TEMPO_OBSERVER_HEALTH_MAX_STALENESS_MS;
    this.timeoutMs = config.timeoutMs ?? TEMPO_OBSERVER_HEALTH_TIMEOUT_MS;
  }

  /**
   * Block only when there is nothing usable to answer from.
   *
   * Three cases, and only the last one waits. A fresh observation returns
   * immediately. A usable-but-past-TTL one revalidates in the background and
   * answers from what it has — the cache is still inside the staleness ceiling,
   * so it is authoritative. No observation at all (a cold start) or one aged
   * past that ceiling (a long suspend) is the case where `available()` would
   * withhold on absence rather than evidence, so it waits out one bounded
   * probe first.
   */
  async ensureFresh(): Promise<void> {
    const nowMs = this.now();
    const usable =
      this.observation !== undefined && nowMs - this.observation.receivedAtMs < this.maxStalenessMs;
    if (!usable) {
      await this.refresh();
      return;
    }
    if (this.lastAttemptAtMs === undefined || nowMs - this.lastAttemptAtMs >= this.refreshTtlMs) {
      void this.refresh();
    }
  }

  /**
   * Register one mount's session capability.
   *
   * A host can serve several DVMs behind one `DVMKIT_PLATFORM_TOKEN`, and the
   * platform row that token identifies is the deployment as a whole — so the
   * answer carried upward is the **OR** across mounts: if any of them can take
   * a session channel, the close observer must be able to reach this
   * deployment.
   */
  declareSessionCapability(read: () => boolean): () => void {
    this.sessionCapabilityReaders.push(read);
    this.declarationEpoch += 1;
    return () => {
      // No epoch bump: a mount going away is a teardown, and the next ordinary
      // probe carries the corrected answer. Firing one from a shutdown path
      // would race the process exit for no gain.
      this.sessionCapabilityReaders = this.sessionCapabilityReaders.filter((r) => r !== read);
    };
  }

  /**
   * De-duplicate probes only while their declaration epoch is current. A mount
   * declared during boot or another mount's probe must await a fresh probe so
   * the platform receives the updated capability, even before traffic arrives.
   */
  async refresh(): Promise<void> {
    const open = this.inFlight;
    if (open) {
      if (open.epoch >= this.declarationEpoch) return open.probe;
      // Wait the stale probe out rather than racing a second one alongside it,
      // then re-enter: another declaration may have landed in the meantime.
      await open.probe;
      return this.refresh();
    }
    this.lastAttemptAtMs = this.now();
    const epoch = this.declarationEpoch;
    // The clear rides the probe's own chain, so anyone awaiting `probe` is
    // guaranteed to see `inFlight` already released.
    const probe: Promise<void> = this.refreshOnce().finally(() => {
      if (this.inFlight?.probe === probe) this.inFlight = undefined;
    });
    this.inFlight = { probe, epoch };
    await probe;
  }

  available(): boolean {
    const nowMs = this.now();
    if (this.lastAttemptAtMs === undefined || nowMs - this.lastAttemptAtMs >= this.refreshTtlMs) {
      void this.refresh();
    }

    // No successful observation yet: withhold. A DVM that has never confirmed
    // the observer is alive must not open a channel nobody is watching.
    if (!this.observation) return this.withhold("no_observation");
    if (!this.observation.healthy) return this.withhold("observer_stale");
    if (nowMs - this.observation.receivedAtMs >= this.maxStalenessMs) {
      return this.withhold("health_signal_stale");
    }
    this.withheldLogged = false;
    return true;
  }

  private withhold(reason: string): boolean {
    if (!this.withheldLogged) {
      this.withheldLogged = true;
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "tempo_session_withheld",
          message:
            undefined,
          reason,
        }
      );
    }
    return false;
  }

  /**
   * The probe URL, carrying this deployment's session capability when a mount
   * has declared one.
   *
   * Absent means "no signal", not "no sessions": a container running an older
   * SDK build sends nothing, and the platform must leave its stamp exactly
   * where the deploy probe put it rather than reading silence as a retraction.
   */
  private probeUrl(): string {
    if (this.sessionCapabilityReaders.length === 0) return this.config.url;
    const capable = this.sessionCapabilityReaders.some((read) => read());
    const separator = this.config.url.includes("?") ? "&" : "?";
    return `${this.config.url}${separator}tempo_session=${capable ? "1" : "0"}`;
  }

  private async refreshOnce(): Promise<void> {
    try {
      const response = await this.fetchFn(this.probeUrl(), {
        headers: {
          ...(this.config.token ? { Authorization: `Bearer ${this.config.token}` } : {}),
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        observing?: unknown;
        oldest_cursor_advanced_at_ms?: unknown;
        observed_at_ms?: unknown;
      };
      const observedAt = body.observed_at_ms;
      if (typeof observedAt !== "number") return;
      const oldest = body.oldest_cursor_advanced_at_ms;
      // A platform watching no escrows yet is healthy, not stale: the observer
      // derives its watch set from channel registrations, so the first channel
      // opened is what creates the escrow to watch — and the observer's
      // cold-start lookback covers the blocks in between.
      //
      // `null` therefore means "nothing to watch", and only that. An escrow
      // that IS registered but has never been scanned reports its registration
      // instant here rather than nothing (platform side), so it ages
      // past `maxCursorAgeMs` exactly like a stalled cursor. Before that, an
      // observer that could never reach the chain read as healthy forever.
      const healthy =
        oldest === null ||
        oldest === undefined ||
        (typeof oldest === "number" && observedAt - oldest < this.maxCursorAgeMs);
      this.observation = { healthy, receivedAtMs: this.now() };
    } catch {
      // Leave the last observation in place; the staleness ceiling in
      // `available()` is what eventually withholds.
    }
  }
}

/** Build the platform client only for a platform-hosted DVM. */
export function createPlatformTempoObserverHealth(
  env: Record<string, string | undefined>
): PlatformTempoObserverHealth | undefined {
  const platformUrl = env.DVMKIT_PLATFORM_URL;
  if (!platformUrl) return undefined;
  return new PlatformTempoObserverHealth({
    url: `${platformUrl.replace(/\/+$/, "")}/_internal/tempo-observer-health`,
    token: env.DVMKIT_PLATFORM_TOKEN,
  });
}
