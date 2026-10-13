import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";

import { createX402FacilitatorClient } from "../../lib/x402/facilitator";
import {
  X402_BATCH_SETTLEMENT_SCHEME,
  X402_DEFAULT_FACILITATOR,
  X402_V1_VERSION,
  X402_VERSION,
  x402NetworkToCaip2,
} from "../../lib/x402/spec";
import type { X402Config, X402ExactVersionSupport } from "../../lib/x402/types";

/** Hard wall-clock bound for one complete facilitator capability probe. */
export const X402_FACILITATOR_PROBE_TIMEOUT_MS = 3_000;

/** How often a serving DVM revalidates facilitator capabilities. */
export const X402_FACILITATOR_REFRESH_TTL_MS = 5 * 60 * 1000;

/** Fail-open ceiling for the last successful facilitator capability observation. */
export const X402_FACILITATOR_MAX_STALENESS_MS = 3 * 60 * 60 * 1000;

/** Stable reason why the configured x402 exact rail cannot be advertised. */
export type X402FacilitatorUnavailableReason = "probe_failed" | "unsupported_exact";

/** Versioned settlement capabilities advertised by one facilitator/network pair. */
export interface X402FacilitatorSupport {
  /** True when at least one exact generation can settle. */
  available: boolean;
  exact: X402ExactVersionSupport;
  batchSettlement: boolean;
  facilitator: string;
  network: string;
  reason?: X402FacilitatorUnavailableReason;
  error?: string;
}

/** Test and advanced-client overrides for the facilitator capability probe. */
export interface X402FacilitatorProbeOpts {
  client?: Pick<FacilitatorClient, "getSupported">;
  timeoutMs?: number;
}

/** Construction overrides for the cached facilitator health gate. */
export interface X402FacilitatorHealthOpts extends X402FacilitatorProbeOpts {
  now?: () => number;
  refreshTtlMs?: number;
  maxStalenessMs?: number;
}

/** Live, synchronous capability view consumed while payment responses are rendered. */
export interface X402FacilitatorHealthLike {
  /** Prime or refresh the capability observation. */
  refresh(): Promise<void>;
  /** Return current support and begin a background refresh when its TTL has elapsed. */
  support(): X402FacilitatorSupport;
  /** Last successful raw response, reused by batch initialization without another request. */
  supportedResponse?(): SupportedResponse | undefined;
}

/**
 * Read `/supported` under one wall-clock deadline and classify each capability
 * independently. The HTTP client's own timeout is per attempt; the outer
 * deadline is what prevents its 429 retry/backoff loop from extending boot.
 */
export async function probeX402FacilitatorSupport(
  config: X402Config,
  opts: X402FacilitatorProbeOpts = {}
): Promise<X402FacilitatorSupport> {
  return (await readX402FacilitatorSupport(config, opts)).support;
}

/** Default capability view for direct server construction that bypasses the host probe. */
export function configuredX402FacilitatorSupport(config: X402Config): X402FacilitatorSupport {
  const exact = { v1: true, v2: true };
  return {
    available: true,
    exact,
    batchSettlement: !!config.batchSettlement,
    facilitator: config.facilitator ?? X402_DEFAULT_FACILITATOR,
    network: x402NetworkToCaip2(config.network),
  };
}

/**
 * TTL-cached facilitator capability gate. Failed refreshes retain the last
 * successful observation until the same three-hour ceiling used by the
 * Lightning rail; a cold-start failure temporarily assumes exact dual-serve
 * so a facilitator blip does not suppress a healthy payment rail for a whole
 * process lifetime. Batch settlement is never assumed without an observation.
 */
export class X402FacilitatorHealth implements X402FacilitatorHealthLike {
  private readonly now: () => number;
  private readonly refreshTtlMs: number;
  private readonly maxStalenessMs: number;
  private readonly startedAtMs: number;
  private observation: { support: X402FacilitatorSupport; observedAtMs: number } | undefined;
  private lastAttemptAtMs: number | undefined;
  private inFlight: Promise<void> | undefined;
  private ceilingLoggedForMs: number | undefined;
  private lastSupportedResponse: SupportedResponse | undefined;

  constructor(
    private readonly config: X402Config,
    private readonly opts: X402FacilitatorHealthOpts = {}
  ) {
    this.now = opts.now ?? Date.now;
    this.refreshTtlMs = opts.refreshTtlMs ?? X402_FACILITATOR_REFRESH_TTL_MS;
    this.maxStalenessMs = opts.maxStalenessMs ?? X402_FACILITATOR_MAX_STALENESS_MS;
    this.startedAtMs = this.now();
  }

  /** Refresh the observation, coalescing concurrent requests. */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (this.lastAttemptAtMs !== undefined && nowMs - this.lastAttemptAtMs < this.refreshTtlMs) {
      return;
    }
    this.lastAttemptAtMs = nowMs;
    const refresh = this.refreshOnce();
    this.inFlight = refresh;
    try {
      await refresh;
    } finally {
      this.inFlight = undefined;
    }
  }

  /** Answer synchronously from cache and start a non-blocking refresh when due. */
  support(): X402FacilitatorSupport {
    const nowMs = this.now();
    if (this.lastAttemptAtMs === undefined || nowMs - this.lastAttemptAtMs >= this.refreshTtlMs) {
      void this.refresh();
    }

    const observedAtMs = this.observation?.observedAtMs ?? this.startedAtMs;
    const ageMs = Math.max(0, nowMs - observedAtMs);
    if (ageMs >= this.maxStalenessMs) {
      if (this.ceilingLoggedForMs !== observedAtMs) {
        this.ceilingLoggedForMs = observedAtMs;
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "x402_facilitator_staleness_ceiling",
            facilitator: this.facilitator,
            network: this.network,
            age_ms: ageMs,
            staleness_ceiling_ms: this.maxStalenessMs,
            message:
              undefined,
          }
        );
      }
      return unavailableSupport(
        this.facilitator,
        this.network,
        "facilitator capability observation exceeded its staleness ceiling"
      );
    }

    return this.observation?.support ?? optimisticExactSupport(this.facilitator, this.network);
  }

  /** Return the raw response paired with the last successful observation. */
  supportedResponse(): SupportedResponse | undefined {
    return this.lastSupportedResponse;
  }

  private get facilitator(): string {
    return this.config.facilitator ?? X402_DEFAULT_FACILITATOR;
  }

  private get network(): string {
    return x402NetworkToCaip2(this.config.network);
  }

  private async refreshOnce(): Promise<void> {
    const read = await readX402FacilitatorSupport(this.config, this.opts);
    const { support } = read;
    if (support.reason === "probe_failed") {
      const observedAtMs = this.observation?.observedAtMs ?? this.startedAtMs;
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "x402_facilitator_fallback",
          facilitator: support.facilitator,
          network: support.network,
          error: undefined,
          age_ms: Math.max(0, this.now() - observedAtMs),
          staleness_ceiling_ms: this.maxStalenessMs,
          message:
            undefined,
        }
      );
      return;
    }

    this.observation = { support, observedAtMs: this.now() };
    this.lastSupportedResponse = read.response;
    this.ceilingLoggedForMs = undefined;
    if (!support.available) {
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "x402_facilitator_unavailable",
          facilitator: support.facilitator,
          network: support.network,
          reason: support.reason,
          message:
            undefined,
        }
      );
    } else if (
      !support.exact.v1 ||
      !support.exact.v2 ||
      (this.config.batchSettlement && !support.batchSettlement)
    ) {
      diagnosticConsole.warn(
        {
          level: "warn",
          event: "x402_facilitator_capability_degraded",
          facilitator: support.facilitator,
          network: support.network,
          exact_v1: support.exact.v1,
          exact_v2: support.exact.v2,
          batch_settlement: support.batchSettlement,
          message:
            undefined,
        }
      );
    }
  }
}

interface X402FacilitatorRead {
  support: X402FacilitatorSupport;
  response?: SupportedResponse;
}

async function readX402FacilitatorSupport(
  config: X402Config,
  opts: X402FacilitatorProbeOpts
): Promise<X402FacilitatorRead> {
  const facilitator = config.facilitator ?? X402_DEFAULT_FACILITATOR;
  const network = x402NetworkToCaip2(config.network);
  const timeoutMs = opts.timeoutMs ?? X402_FACILITATOR_PROBE_TIMEOUT_MS;
  const client = opts.client ?? createX402FacilitatorClient(config, { timeoutMs });

  try {
    const response = await withWallClockDeadline(client.getSupported(), timeoutMs);
    const supports = (version: number, scheme: string): boolean =>
      response.kinds.some(
        (kind) =>
          kind.x402Version === version &&
          kind.scheme === scheme &&
          x402NetworkToCaip2(kind.network) === network
      );
    const exact = {
      v1: supports(X402_V1_VERSION, "exact"),
      v2: supports(X402_VERSION, "exact"),
    };
    const available = exact.v1 || exact.v2;
    return {
      support: {
        available,
        exact,
        batchSettlement: supports(X402_VERSION, X402_BATCH_SETTLEMENT_SCHEME),
        facilitator,
        network,
        ...(!available ? { reason: "unsupported_exact" as const } : {}),
      },
      response,
    };
  } catch (err) {
    return {
      support: unavailableSupport(
        facilitator,
        network,
        err instanceof Error ? err.message : String(err)
      ),
    };
  }
}

function optimisticExactSupport(facilitator: string, network: string): X402FacilitatorSupport {
  return {
    available: true,
    exact: { v1: true, v2: true },
    batchSettlement: false,
    facilitator,
    network,
  };
}

function unavailableSupport(
  facilitator: string,
  network: string,
  error: string
): X402FacilitatorSupport {
  return {
    available: false,
    exact: { v1: false, v2: false },
    batchSettlement: false,
    facilitator,
    network,
    reason: "probe_failed",
    error,
  };
}

function withWallClockDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`facilitator capability probe timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    );
  });
}
