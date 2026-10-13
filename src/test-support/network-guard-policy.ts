/** Setup imports this before each file, so keep imports lightweight. Live hosts
 * open only for explicitly enabled tiers. Typed refusals must be rethrown by
 * probes rather than mistaken for outages. Include env override and library
 * default URLs for each tier: a client may choose its own default endpoint. */

/** Moderato — the Tempo public testnet RPC. Matches mppx's own testnet default. */
export const MODERATO_RPC_DEFAULT = "https://rpc.moderato.tempo.xyz";

/** Base Sepolia public RPC. */
export const BASE_SEPOLIA_RPC_DEFAULT = "https://sepolia.base.org";

/** The free, no-API-key x402 facilitator that settles Base Sepolia. */
export const X402_FACILITATOR_DEFAULT = "https://x402.org/facilitator";

export type EnvLike = Record<string, string | undefined>;

/** A test tier that talks to a live network host, and the env that enables it. */
export interface TestnetTier {
  name: string;
  /** Every one of these must be non-empty for the tier — and its hosts — to be enabled. */
  enabledBy: readonly string[];
  /** Every URL the tier can reach when enabled: env overrides plus built-in defaults. */
  urls: (env: EnvLike) => readonly string[];
}

/**
 * The live-network tiers. `enabledBy` mirrors each test file's own `ENABLED`
 * expression — the allowlist must open exactly when the tier runs, never wider.
 */
export const TESTNET_TIERS: readonly TestnetTier[] = [
  {
    // src/sdk/__tests__/payment-mpp-tempo.integration.test.ts
    name: "tempo",
    enabledBy: ["TEMPO_TESTNET_RPC"],
    urls: (env) => [env.TEMPO_TESTNET_RPC ?? MODERATO_RPC_DEFAULT, MODERATO_RPC_DEFAULT],
  },
  {
    // src/sdk/__tests__/payment-x402-base-sepolia.integration.test.ts
    name: "x402",
    enabledBy: ["X402_TESTNET_RPC", "X402_TESTNET_PRIVATE_KEY"],
    urls: (env) => [
      env.X402_TESTNET_RPC ?? BASE_SEPOLIA_RPC_DEFAULT,
      BASE_SEPOLIA_RPC_DEFAULT,
      env.X402_TESTNET_FACILITATOR ?? X402_FACILITATOR_DEFAULT,
      X402_FACILITATOR_DEFAULT,
    ],
  },
];

/** Thrown by the network guard for an outbound `fetch` it refuses to make. */
export class NetworkGuardBlockedError extends Error {
  /**
   * Brand read by {@link isNetworkGuardBlocked}. A property rather than an
   * `instanceof` check, so the predicate holds even if the setup file and the
   * test file end up with separate instances of this module.
   */
  readonly isNetworkGuardBlocked = true;
  readonly url: string;

  constructor(url: string, message: string) {
    super(message);
    this.name = "NetworkGuardBlockedError";
    this.url = url;
  }
}

/** True when `err` is the network guard refusing a request, rather than a real network failure. */
export function isNetworkGuardBlocked(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { isNetworkGuardBlocked?: unknown }).isNetworkGuardBlocked === true
  );
}

/** Whether every env var gating `tier` is set and non-empty. */
export function testnetTierEnabled(tier: TestnetTier, env: EnvLike = process.env): boolean {
  return tier.enabledBy.every((name) => Boolean(env[name]));
}

/**
 * Hostnames the guard lets through for the tiers `env` enables — empty when none
 * is. Unparseable URLs are skipped rather than thrown: a malformed override is
 * the tier's own problem to report, not something that should take down every
 * test file's setup.
 */
export function allowedTestnetHosts(env: EnvLike = process.env): Set<string> {
  const hosts = new Set<string>();
  for (const tier of TESTNET_TIERS) {
    if (!testnetTierEnabled(tier, env)) continue;
    for (const url of tier.urls(env)) {
      try {
        hosts.add(new URL(url).hostname);
      } catch {
        // Malformed override — nothing to allow.
      }
    }
  }
  return hosts;
}
