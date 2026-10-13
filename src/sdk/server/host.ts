import { diagnosticConsole } from "../../observability/diagnostic-console";
import { resolvePaymentMode, type PaymentMode, type PaidJobCompletion } from "./payment-mode";
import { randomUUID } from "node:crypto";
import { createDisposableCashuStore } from "./disposable-cashu-store";
import type { Server } from "node:http";

import { serve as honoServe } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import type { Pool } from "pg";
import { privateKeyToAccount } from "viem/accounts";

import type { AttestationPayload } from "../../lib/builder-identity";
import { isTestMintUrl } from "../../lib/mints";
import { resolveRpcOverride } from "../../lib/payment-rails/rpc";
import { applyRetryToPool } from "../../lib/pg-retry";
import { generateEphemeralReceiptKey, receiptPubkeyFromSecret } from "../../lib/receipt-key";
import { validateX402Env } from "../../lib/x402/env";
import { assertSupportedX402Network } from "../../lib/x402/networks";
import {
  X402_DEFAULT_FACILITATOR,
  X402_DEFAULT_NETWORK,
  x402NetworkToCaip2,
} from "../../lib/x402/spec";
import type { X402Config } from "../../lib/x402/types";
import { initLoggers } from "../../observability/loggers";
import { HttpTransport, SpanWriter } from "../../observability/span-writer";
import { envFlag } from "../env";
import type { FxFetcher } from "../pricing/index";
import { MemoryKVStore } from "../store";
import type { CashuMode, DVMDescriptor, KVStore, PaymentMethod, ZodLike } from "../types";
import { createDVMServer, revenueReporterBannerState, unknownRouteNotFound } from "./app";
import type { PostgresTempoChargeStore } from "./tempo-charge-store";
import type { ResolvedCashuOpts } from "./cashu-env";
import { resolveCashuOptsFromEnv } from "./cashu-env";
import {
  type ClientCompatibilityGate,
  clientCompatibilityMiddleware,
  requireClientCompatibility,
} from "./client-compatibility";
import type { ConsumedCredentialStore } from "./consumed-credential-store";
import type { CreditLedgerLike } from "./credit-ledger";
import type { PostgresTempoSessionStore } from "./tempo-session-store";
import type { JobStore, StreamableJobStore } from "./job-store";
import { isStreamableJobStore } from "./job-store";
import type { JobManagerOpts } from "./job-manager";
import type { HostingControlConfig } from "./hosting-control";
import { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import { createPlatformLightningRailHealth } from "./lightning-rail-health";
import type { LightningReceiveConfig } from "./lightning-receive";
import { LightningReceive } from "./lightning-receive";
import type { MintHealthTracker } from "./mint-health-tracker";
import type { MppSecretState } from "./mpp-secret-state";
import {
  type MppOpts,
  type MppxServer,
  resolveTempoNetwork,
  TEMPO_MODERATO_CHAIN_ID,
  TEMPO_MODERATO_RPC,
} from "./mpp-setup";
import type { PayoutReporter, TempoPayoutReader, TempoSessionSettled } from "./payout-reporter";
import type { ProcessedPaymentStore } from "./processed-payment-store";
import type { ReplayStoreBackend } from "./secp256k1-auth";
import type { SignedRequestReplayStore } from "./signed-request";
import { createPlatformTempoObserverHealth } from "./tempo-observer-health";
import {
  TEMPO_SETTLEMENT_DEFAULT_LOW_BALANCE_MICRO,
  TempoSettlementReadiness,
} from "./tempo-settlement-readiness";
import { PostgresTempoSettlementReadinessStore } from "./tempo-settlement-readiness-store";
import { X402FacilitatorHealth, type X402FacilitatorSupport } from "./x402-facilitator-support";

/**
 * Owner display identity surfaced on `/v1/info#owner`. Personal orgs
 * resolve to the owner builder's profile; shared orgs resolve to the org's own
 * profile. Container DVMs read from env vars; isolate DVMs resolve from Postgres.
 */
export interface OwnerDisplay {
  handle: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  type: "builder" | "org";
}

/** Builder identity advertised on /v1/info. */
export interface BuilderIdentity {
  id?: string;
  name?: string;
  url?: string;
  /**
   * Builder identity x-only secp256k1 pubkey. When populated, the
   * `/v1/info#builder` block also carries `attestation` + `signature` so
   * consumers can verify the deploy was signed by the holder of this key.
   * Populated at deploy time from `DVMKIT_BUILDER_PUBKEY` (Fly secret); the
   * SDK never re-signs at runtime.
   */
  pubkey?: string;
  /** Canonical deploy-time attestation payload. Served verbatim. */
  attestation?: AttestationPayload;
  /** Schnorr signature over `canonicaliseForSigning(attestation)`. */
  signature?: string;
}

/** Platform reporter overrides — the host falls back to env when omitted. */
export interface PlatformReporterOpts {
  /** Bearer token. Defaults to `DVMKIT_PLATFORM_TOKEN` env. */
  token?: string;
  /** Platform internal URL. Defaults to `DVMKIT_PLATFORM_URL` env. */
  url?: string;
}

export interface DVMServeResult {
  url: string;
  close: () => Promise<void>;
  /** Boot snapshot for each mount; configured but unusable rails remain payment-required. */
  paymentModes: PaymentMode[];
}

export interface DVMHostOpts {
  /** Dedicated hosting-management authority for each mounted DVM. Requires durable Postgres. */
  hostingControl?: HostingControlConfig;
  /**
   * Postgres connection string. Defaults to `DATABASE_URL` env.
   * Required at runtime. Boot fails when missing unless `jobStore`
   * is explicitly supplied or `devMode` is true (test/dev escape hatches).
   */
  database?: string;
  /** Listen port. Defaults to `PORT` env or 8080. */
  port?: number;
  /**
   * Environment variables. Defaults to `process.env` when omitted. A supplied
   * object is the complete host configuration: absent fields do not fall back
   * to ambient process variables.
   */
  env?: Record<string, string>;

  builder?: BuilderIdentity;
  /** Owner display identity for `/v1/info#owner`. Falls back to env vars. */
  owner?: OwnerDisplay;
  /** Platform reporter overrides. Defaults to env-derived values. */
  platformReporter?: PlatformReporterOpts;
  /** Override the SDK's fx fetcher. Defaults to env-configured CoinGecko. */
  fx?: FxFetcher;
  /**
   * Custom `/health` handler. When set, the SDK installs this instead of the
   * default `{ status: "ok" }` responder — useful for runtime-specific health
   * (pool depth, draining state, 503 while draining).
   */
  healthHandler?: (c: Context) => Response | Promise<Response>;
  /** KV store override. Defaults to PostgresKVStore (or MemoryKVStore in dev). */
  store?: KVStore;
  /** JobStore override. Takes precedence over `database`. */
  jobStore?: JobStore;
  /**
   * Existing Postgres pool to reuse instead of opening one from `database`
   * (also useful as a test seam). When set, the host builds its JobStore / KVStore /
   * cashu accumulator on this pool and leaves it open at shutdown — the caller
   * owns it. Lets the e2e harness run DVMs in `p2pk-accumulator` mode against
   * its single shared pool rather than spawning a pool per DVM.
   */
  pool?: Pool;
  /** Cashu mints accepted. Defaults to env `DVMKIT_CASHU_MINTS`. */
  mints?: string[];

  cashuMode?: CashuMode;
  /** MPP handle override. Defaults to env-resolved via `createMppFromOpts`. */
  mpp?: MppxServer;
  /** x402 stablecoin payment configuration. Defaults to env-resolved. */
  x402?: X402Config;
  /** Payment methods override. Defaults to derived from configured rails. */
  paymentMethods?: PaymentMethod[];
  /**
   * Lightning receive leg for credit funding. Defaults to the
   * env-resolved `DVMKIT_NWC_RECEIVE_URI` /
   * `DVMKIT_NWC_RECEIVE_INVOICE_TTL_SECONDS`. Pass `backend` to inject a
   * wallet directly — a test seam that skips the connect-time probe, so
   * production must always come through the URI.
   */
  lightningReceive?: LightningReceiveConfig;
  /** Observe verified completed charges after settlement and receipt issuance, when enabled.
   * May repeat after reconciliation/reload: deduplicate by jobId. Exceptions are logged and
   * cannot undo a completed job. Free, synthetic development, failed and released draws do not emit.
   */
  onPaidJobCompleted?: (event: PaidJobCompletion) => void | Promise<void>;
  /** When true, payment is skipped only when no payment rail is configured. */
  devMode?: boolean;

  consumedCredentialStore?: ConsumedCredentialStore;

  mintHealthTracker?: MintHealthTracker;
  /** Operator-alert boundary for failed terminal-job retention passes. */
  onJobRetentionSweepFailed?: JobManagerOpts["onJobRetentionSweepFailed"];
  /** Clear-on-recovery boundary invoked after a complete clean retention pass. */
  onJobRetentionSweepRecovered?: JobManagerOpts["onJobRetentionSweepRecovered"];
  /**
   * Wrap the SDK compatibility gate before it is exposed to descriptor custom
   * routes. Platform hosts use this to enforce their independently released
   * caller rollout policy; self-hosted SDK consumers receive the default gate.
   */
  wrapRouteClientCompatibility?: (sdkGate: ClientCompatibilityGate) => ClientCompatibilityGate;
}

export interface MountOpts {
  /** Path prefix for this DVM's protocol routes (e.g. `/delete-feed`). */
  prefix?: string;
}

export interface DVMHost {
  /**
   * Underlying Hono app for custom non-protocol routes that belong to the
   * host (cross-DVM `/admin`, cron callbacks, etc.). For DVM-scoped routes,
   * declare `routes(app)` on the descriptor.
   */
  readonly app: Hono;
  /**
   * Resolved Postgres pool — undefined before `host.serve()` completes
   * database resolution, set thereafter. Exposed so DVM-local Postgres
   * consumers (e.g. scrape's `ScrapeDb` per-fetch event store)
   * can reuse the host's pool rather than constructing their own. Wire
   * inside descriptor `onBoot` (fires after pool init, before listener opens).
   */
  readonly pool: Pool | undefined;
  /**
   * Money-safe credit ledger — undefined before `host.serve()`
   * resolves stores, set thereafter. Postgres-backed when a pool exists;
   * pool-less hosts get a shared in-memory ledger so the fund+draw
   * semantics hold everywhere. Same wiring window as `pool` (descriptor
   * `onBoot` fires after init, before the listener opens).
   */
  readonly creditLedger: CreditLedgerLike | undefined;
  /**
   * Add a DVM to this host. Multiple mounts compose at distinct prefixes;
   * a single mount with no prefix attaches at root.
   */
  mount<S, I extends ZodLike | undefined>(descriptor: DVMDescriptor<S, I>, opts?: MountOpts): void;

  serve(opts?: { port?: number }): Promise<DVMServeResult>;
  /** Graceful shutdown. Runs descriptor `onShutdown` hooks in reverse mount order. */
  shutdown(): Promise<void>;
}

/**
 * Default connection ceiling for the SDK host's shared Postgres pool. A
 * three-machine hosted DVM with x402 batch settlement enabled can reserve up
 * to 3 × (10 host + 4 settlement + 1 LISTEN) = 45 connections, well below
 * postgres-flex's 300-connection ceiling and with headroom for operator access.
 */
const DEFAULT_HOST_POOL_MAX = 10;

// Re-check often enough that a request which finishes during shutdown does
// not leave its newly-idle keep-alive socket delaying the remaining teardown.
const IDLE_CONNECTION_SWEEP_MS = 50;

interface MountEntry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  descriptor: DVMDescriptor<any, any>;
  prefix?: string;
  shutdown?: () => Promise<void>;
  bootCompleted: boolean;
}

/**
 * Single wiring locus for SDK-side construction. Replaces both the
 * `serve()` wrapper and the `createDVMServer` direct path. Reads env once,
 * resolves payment rails, owns the Postgres pool, and mounts each DVM
 * descriptor as a Hono sub-app on `host.app`.
 */
export function createDVMHost(opts: DVMHostOpts = {}): DVMHost {
  const app = new Hono();
  app.use("*", clientCompatibilityMiddleware());
  const routeClientCompatibility =
    opts.wrapRouteClientCompatibility?.(requireClientCompatibility) ?? requireClientCompatibility;
  const mounts: MountEntry[] = [];
  const paymentModes: PaymentMode[] = [];
  // When the caller injects a pool, it owns the lifecycle — we never end it.
  const ownsPool = !opts.pool;
  let pgPool: Pool | undefined;
  let creditLedger: CreditLedgerLike | undefined;
  let tempoSessionStore: PostgresTempoSessionStore | undefined;
  let tempoChargeStore: PostgresTempoChargeStore | undefined;
  // the Tempo half of payout reporting is host-level state — one
  // session store, one recipient — attached to the mount's reporter once it
  // exists, and fed from mppx's settlement callback through the sink.
  const tempoPayoutReader: TempoPayoutReader = {};
  const payoutSinks: { tempoSettled?: (event: TempoSessionSettled) => Promise<void> } = {};
  let tempoPayoutOwner: PayoutReporter | undefined;
  let tempoSettlementReadiness: TempoSettlementReadiness | undefined;
  let processedPayments: ProcessedPaymentStore | undefined;
  let pgStreamStore: StreamableJobStore | undefined;
  let nodeServer: Server | undefined;
  let spanWriter: SpanWriter | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let serveAttempted = false;

  function mount<S, I extends ZodLike | undefined>(
    descriptor: DVMDescriptor<S, I>,
    mountOpts?: MountOpts
  ): void {
    mounts.push({ descriptor, prefix: mountOpts?.prefix, bootCompleted: false });
  }

  async function boot(serveOpts?: {
    port?: number;
  }): Promise<DVMServeResult> {
    const env: Record<string, string> =
      opts.env ??
      (Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ) as Record<string, string>);
    const envMaybe = env as Record<string, string | undefined>;
    const hostingSecret = envMaybe.DVMKIT_HOSTING_CONTROL_SECRET;
    const hostingScope = envMaybe.DVMKIT_HOSTING_CONTROL_SCOPE;
    if (!opts.hostingControl && Boolean(hostingSecret) !== Boolean(hostingScope)) {
      throw new Error("Hosting control requires both DVMKIT_HOSTING_CONTROL_SECRET and DVMKIT_HOSTING_CONTROL_SCOPE");
    }
    const hostingControl = opts.hostingControl ??
      (hostingSecret && hostingScope ? { secret: hostingSecret, scope: hostingScope } : undefined);

    const port = serveOpts?.port ?? opts.port ?? Number(envMaybe.PORT ?? "8080");

    // Attribute cold-start latency: nothing binds the HTTP port until every
    // phase below completes, so an autostopped machine's first request waits
    // out this whole sequence. `mark(phase)` stamps cumulative elapsed ms; the
    // full breakdown is logged as `dvm_boot_phase_timings` just before the
    // listener opens. Cheap (a Date.now() per phase) and pure-additive.
    const bootStart = Date.now();
    const phaseMarks: { phase: string; atMs: number }[] = [];
    const mark = (phase: string): void => {
      phaseMarks.push({ phase, atMs: Date.now() - bootStart });
    };

    // Required for production deploys. The test/dev escape hatch:
    // explicit `jobStore` or `devMode: true` bypass the requirement.
    const databaseUrl = opts.database ?? envMaybe.DATABASE_URL;
    const dbRequired = !opts.jobStore && !opts.devMode && !opts.pool;
    if (!databaseUrl && dbRequired) {
      throw new Error(
        "createDVMHost requires a Postgres database. Pass `database` opt or set DATABASE_URL env."
      );
    }

    let store: KVStore = opts.store ?? new MemoryKVStore();
    let kvBackend: StoreBackend = opts.store ? "user-supplied" : "memory";
    let jobStore: JobStore | undefined = opts.jobStore;

    // Independent `CREATE TABLE IF NOT EXISTS` (+ one LISTEN) passes on the same
    // pool — jobStore, KV, replay, and consumed-credential stores each own their
    // own tables and don't depend on one another. Collecting their
    // `.init()` promises here and awaiting them together at the `stores` mark
    // overlaps the DDL instead of paying five serial round-trips against a cold
    // DB. The store *objects* are constructed synchronously (cheap) so downstream
    // wiring can hold their references; only the awaits are deferred, and nothing
    // between construction and the `Promise.all` queries them.
    const pendingInits: Promise<void>[] = [];

    if (!jobStore && (databaseUrl || opts.pool)) {
      const pg = await import("pg");
      // keepAlive + retry so a Fly suspend/resume (memory snapshot → dead TCP
      // sockets, wall-clock jump) self-heals: the first post-resume query
      // re-dials instead of serving a stale-connection 5xx, and the dedicated
      // LISTEN client (ListenChannel) surfaces its dead socket faster.
      // connectionTimeoutMillis so a saturated pool is a loud 5xx rather than a
      // silent, unbounded queue — this pool is shared by /v1/job, the job store,
      // KV, the credit ledger, the x402 channel store, the Tempo
      // session store and the Tempo charge replay store.
      // `max` is stated rather than left to node-pg's default so the bound every
      // one of those contends for is greppable from here — raise it and each
      // holder's checkout window is what pays for it.
      // The env override applies only to a host-owned pool; an injected pool's
      // sizing and lifecycle remain entirely caller-owned.
      const pool =
        opts.pool ??
        new pg.default.Pool({
          connectionString: databaseUrl,
          max: parseHostPoolMax(envMaybe.DVMKIT_POSTGRES_POOL_MAX),
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 10_000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
        });
      applyRetryToPool(pool, "dvm-host");
      pgPool = pool;
      const { PostgresJobStore } = await import("./postgres-job-store");
      const pgJobStore = new PostgresJobStore(pool);
      pendingInits.push(pgJobStore.init(), pgJobStore.initStreaming());
      jobStore = pgJobStore;
      pgStreamStore = pgJobStore;
      if (!opts.store) {
        const { PostgresKVStore } = await import("./postgres-kv-store");
        const pgKvStore = new PostgresKVStore(pool);
        pendingInits.push(pgKvStore.init());
        store = pgKvStore;
        kvBackend = "postgres";
      }
    }

    const mintsFromEnv = envMaybe.DVMKIT_CASHU_MINTS?.split(",")
      .map((m) => m.trim()).filter(Boolean);
    const effectiveMints = opts.mints ?? mintsFromEnv;
    const disposableCashu = opts.devMode && !pgPool && (effectiveMints?.length ?? 0) > 0
      ? createDisposableCashuStore() : undefined;
    if (disposableCashu && !effectiveMints!.every(isTestMintUrl)) {
      throw new Error("Disposable development Cashu accepts only known test or loopback mints. Real or unknown mints require durable PostgreSQL storage.");
    }
    if (disposableCashu && opts.cashuMode === undefined) {
      diagnosticConsole.log({ level: "info", message: undefined });
    }
    const cashuOpts = disposableCashu ? {
      cashuMode: "p2pk-accumulator" as const,
      lockPubkey: `02${generateEphemeralReceiptKey().pubkey}`,
      lockPubkeyGraceSeconds: 0,
      dvmId: randomUUID(),
      canonicalDvmId: undefined,
      db: undefined,
    } : await resolveCashuOptsFromEnv(env, pgPool, opts.cashuMode);
    const hostedSettlementReports = hostingControl && pgPool && cashuOpts.dvmId && mounts.length === 1
      ? new HostedSettlementReportObligations(pgPool, cashuOpts.dvmId, hostingControl.scope)
      : undefined;
    await hostedSettlementReports?.init();
    if (envMaybe.BUILDER_LOCK_PRIVKEY) {
      throw new Error("BUILDER_LOCK_PRIVKEY must not be set on a DVM machine.");
    }

    // A platform-hosted DVM (DVMKIT_PLATFORM_URL set) configured with a
    // FakeWallet / test mint settles no real money — every payment silently
    // no-ops and revenue reads $0 until someone notices the dashboard. Refuse
    // to boot unless the operator explicitly opts in.
    //
    // `devMode` boots are exempt: it's the SDK's canonical "this is a dev/test
    // run" signal (set by `dvmctl dev`, `serve.ts`, the money-loop, and the
    // e2e/smoke harnesses — all of which spread `...process.env` and legitimately
    // use the FakeWallet mint), and production first-party boots go through the
    // platform runtime, which never sets it. Without this exemption a harness
    // run on an operator shell that happens to export DVMKIT_PLATFORM_URL would
    // trip the FATAL throw. The intentionally-fake staging fleet is
    // platform-hosted and *not* devMode, so it keeps the explicit
    // DVMKIT_ALLOW_TEST_MINTS=true opt-in until staging is identified by the
    // DVMKIT_ENV discriminator instead of this explicit override.
    if (
      !opts.devMode &&
      effectiveMints &&
      effectiveMints.length > 0 &&
      envMaybe.DVMKIT_PLATFORM_URL
    ) {
      const testMints = effectiveMints.filter(isTestMintUrl);
      if (testMints.length > 0) {
        if (!envFlag(envMaybe.DVMKIT_ALLOW_TEST_MINTS)) {
          throw new Error(
            `[FATAL] Refusing to boot: platform-hosted DVM configured with test mint(s) ` +
              `[${testMints.join(", ")}]. A test/FakeWallet mint settles no real money — every ` +
              `payment would silently no-op and revenue would read $0. If this is intentional ` +
              `(dev stack, smoke test, or the staging fleet), set DVMKIT_ALLOW_TEST_MINTS=true.`
          );
        }
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "platform_hosted_test_mint_allowed",
            mints: testMints,
            message:
              undefined,
          }
        );
      }
    }

    // Boot used to run a fail-fast mint check and refuse to start before
    // binding the port. moves that off the critical path: the
    // per-mount runtime `MintHealthTracker` (constructed in the mount loop
    // below, started before `listen`) now owns mint health — it probes the
    // same mints, reproduces the boot NUT gate (`nutCompliant`), and holds
    // paid calls at `mint_health_pending` until its first probe lands. Nothing
    // to await here; the port binds without waiting on the mint probe.

    // The descriptor-level x402 is resolved per-mount below (since cast etc.
    // can mount multiple descriptors). Host-level x402 (the opts.x402) wins.
    const rawX402Base = opts.x402 ?? buildX402FromEnv(envMaybe);
    const x402Base = rawX402Base ? normalizeX402Config(rawX402Base) : undefined;
    // Dual-serve is a default-true opt-out: unset (or anything but "false")
    // ⇒ enabled. `envFlag` only matches "1"/"true", so it can't express a
    // default-true flag — keep the `!== "false"` rule but compute it once.
    const dualServeEnabled = envMaybe.DVMKIT_X402_DUAL_SERVE !== "false";
    const x402WithDualServe = x402Base
      ? {
          ...x402Base,
          dualServe: dualServeEnabled ? (x402Base.dualServe ?? true) : false,
        }
      : undefined;
    const x402HealthCache = new Map<string, X402FacilitatorHealth>();
    let bootX402 = x402WithDualServe;
    let bootX402Support: X402FacilitatorSupport | undefined;

    const x402Health = (config: X402Config): X402FacilitatorHealth => {
      const key = `${config.facilitator ?? X402_DEFAULT_FACILITATOR}\n${config.network}\n${config.facilitatorAuth?.keyId ?? ""}`;
      const cached = x402HealthCache.get(key);
      if (cached) return cached;
      const health = new X402FacilitatorHealth(config);
      x402HealthCache.set(key, health);
      return health;
    };

    // Resolved here rather than in `configureDVM`, which is pure and env-free;
    // these values belong to the host environment rather than the descriptor.
    const lightningReceiveConfig: LightningReceiveConfig = {
      ...(opts.lightningReceive ?? {
        uri: envMaybe.DVMKIT_NWC_RECEIVE_URI,
        invoiceTtlSeconds: parseInvoiceTtlEnv(envMaybe.DVMKIT_NWC_RECEIVE_INVOICE_TTL_SECONDS),
        fundingMinSats: parseFundingMinSatsEnv(envMaybe.DVMKIT_LIGHTNING_FUNDING_MIN_SATS),
      }),
      // DVMKIT_PLATFORM_URL is the platform-hosted signal. The client only
      // receives the platform's derived boolean via its existing bearer
      // channel; it never receives the Hub URL or readonly token.
      railHealth: opts.lightningReceive?.railHealth ?? createPlatformLightningRailHealth(envMaybe),
    };
    const lightningReceive = await LightningReceive.create(lightningReceiveConfig);

    // on a platform-hosted DVM, whether the central Tempo close
    // observer is watching. Undefined when self-hosted — a self-hosted builder
    // runs their own observer and wake path, so nothing here withholds their
    // session offers.
    const tempoObserverHealth = createPlatformTempoObserverHealth(envMaybe);
    // Prime it off the request path. Every surface that reads it also awaits
    // `ensureFresh()`, so this is an optimization rather than the guarantee —
    // it keeps the probe out of the first request when boot has any slack, and
    // costs nothing when it doesn't (`refresh()` de-dupes an in-flight call).
    void tempoObserverHealth?.refresh();

    // Resolve once because the same stable, per-DVM secret anchors receipts
    // and (through a separately-domain-derived child key) the Tempo session
    // operator. Generating two dev keys here would make the advertised
    // operator unrelated to the receipt identity and change it within one
    // process boot.
    const receiptKey =
      envMaybe.DVMKIT_RECEIPT_KEY ??
      (opts.devMode ? generateEphemeralReceiptKey().secret : undefined);

    let mpp = opts.mpp;
    let mppSecretState: MppSecretState | null = null;
    // An injected handle owns whatever stores its own methods were built with.
    let tempoChargeBackend: StoreBackend = "user-supplied";
    const mppTempoRecipient = envMaybe.DVMKIT_TEMPO_RECIPIENT;
    if (!mpp && mppTempoRecipient) {
      const { createMppFromOpts, createDualKeyMppxFromOpts, parseMppMethodsAllowlist } =
        await import("./mpp-setup");
      // `tempo/charge` registers on DVMKIT_TEMPO_RECIPIENT alone — a far
      // wider gate than the session store's below — so its replay guard is
      // wired off the pool and nothing else.
      tempoChargeBackend = pgPool ? "postgres" : "memory";
      let tempoCharge: NonNullable<MppOpts["tempoCharge"]> | undefined;
      if (pgPool) {
        const { PostgresTempoChargeStore } = await import("./tempo-charge-store");
        const chargeStore = new PostgresTempoChargeStore(pgPool);
        tempoChargeStore = chargeStore;
        pendingInits.push(chargeStore.init());
        tempoCharge = { store: chargeStore };
      }
      let tempoSession: NonNullable<MppOpts["tempoSession"]> | undefined;
      const tempoOperatorKey = resolveTempoOperatorKey(envMaybe.DVMKIT_TEMPO_OPERATOR_KEY);
      if (envMaybe.DVMKIT_TEMPO_OPERATOR_MIN_BALANCE_MICRO?.trim() && !tempoOperatorKey) {
        throw new Error(
          "DVMKIT_TEMPO_OPERATOR_MIN_BALANCE_MICRO requires DVMKIT_TEMPO_OPERATOR_KEY."
        );
      }
      if (
        pgPool &&
        receiptKey &&
        tempoOperatorKey &&
        mounts.some((entry) => !!entry.descriptor.credit && !!entry.descriptor.auth)
      ) {
        const [
          { PostgresTempoSessionStore },
          { privateKeyToAccount },
          { createPublicClient, createWalletClient, erc20Abi, http },
          { tempo: tempoMainnet, tempoModerato },
        ] = await Promise.all([
          import("./tempo-session-store"),
          import("viem/accounts"),
          import("viem"),
          import("viem/chains"),
        ]);
        const sessionStore = new PostgresTempoSessionStore(pgPool);
        tempoSessionStore = sessionStore;
        tempoPayoutReader.listActive = (limit, cursor) => sessionStore.listActive(limit, cursor);
        pendingInits.push(sessionStore.init());
        const operator = privateKeyToAccount(tempoOperatorKey);
        const tempoNetwork = resolveTempoNetwork(envMaybe);
        const tempoCurrency = tempoNetwork.currency as `0x${string}`;
        if (hostedSettlementReports) {
          const { Session: TempoSession } = await import("mppx/tempo");
          hostedSettlementReports.configureTempo({
            network: `eip155:${tempoNetwork.chainId}`,
            escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
            payee: mppTempoRecipient,
            token: tempoCurrency,
            ...(envMaybe.DVMKIT_TEMPO_RPC_URL ? { rpcUrl: envMaybe.DVMKIT_TEMPO_RPC_URL } : {}),
          });
        }
        const selectedChain =
          tempoNetwork.chainId === tempoModerato.id
            ? tempoModerato
            : tempoNetwork.chainId === tempoMainnet.id
              ? tempoMainnet
              : { ...(tempoNetwork.testnet ? tempoModerato : tempoMainnet), id: tempoNetwork.chainId };
        const bundledRpc =
          tempoNetwork.chainId === TEMPO_MODERATO_CHAIN_ID
            ? TEMPO_MODERATO_RPC
            : selectedChain.rpcUrls.default.http[0];
        const tempoRpc = resolveRpcOverride(envMaybe.DVMKIT_TEMPO_RPC_URL, bundledRpc).url;
        const publicClient = createPublicClient({
          chain: selectedChain,
          transport: http(tempoRpc),
        });
        if (envMaybe.DVMKIT_PLATFORM_URL) {
          if (!cashuOpts.dvmId) {
            throw new Error("Hosted Tempo session readiness requires DVMKIT_DVM_ID.");
          }
          const readinessStore = new PostgresTempoSettlementReadinessStore(pgPool, {
            dvmId: cashuOpts.dvmId,
            address: operator.address,
            token: tempoCurrency,
          });
          pendingInits.push(readinessStore.init());
          tempoSettlementReadiness = new TempoSettlementReadiness({
            address: operator.address,
            network: `eip155:${tempoNetwork.chainId}`,
            token: tempoCurrency,
            lowBalanceMicro: parseTempoSettlementFloor(envMaybe),
            stateStore: readinessStore,
            readBalance: () =>
              publicClient.readContract({
                address: tempoCurrency,
                abi: erc20Abi,
                functionName: "balanceOf",
                args: [operator.address],
              }),
          });
        }
        tempoSession = {
          store: sessionStore,
          ...(hostedSettlementReports ? { hostedObligations: hostedSettlementReports } : {}),
          account: operator,
          chainId: tempoNetwork.chainId,
          getClient: ({ chainId }) => {
            if (chainId !== undefined && chainId !== tempoNetwork.chainId) {
              throw new Error(
                `Tempo session requested chain ${chainId}, but the host is configured for chain ${tempoNetwork.chainId}.`
              );
            }
            return createWalletClient({
              account: operator,
              chain: selectedChain,
              // Trimmed, so a blank DVMKIT_TEMPO_RPC_URL falls back to the
              // chain's bundled endpoint rather than becoming the transport
              // target.
              transport: http(tempoRpc),
            });
          },
          settlementSchedule: { intervalMs: 24 * 60 * 60 * 1_000 },
          beforeSessionSettlement: () => tempoSettlementReadiness?.captureRecoveryVersion(),
          onInsufficientFunds: (failure) =>
            tempoSettlementReadiness?.recordInsufficientFunds(failure),
          onSessionSettlement: async (settlement) => {
            if (hostedSettlementReports) {
              const original = await hostedSettlementReports.findPendingTempo(settlement.channelId,
                settlement.trigger === "close" ? "close" : "settle");
              if (original) {
                await hostedSettlementReports.recordSubmitted(original.id, settlement.txHash);
              } else if (await hostedSettlementReports.hasCompleteHistory()) {
                throw new Error("Hosted Tempo settlement has no original pre-effect reservation");
              }
            }
            await tempoSettlementReadiness?.recordSuccessfulTransaction(settlement.recoveryVersion);
            diagnosticConsole.info(
              {
                level: "info",
                event: "tempo_session_settled",
                channel_id: settlement.channelId,
                tx_hash: settlement.txHash,
                trigger: settlement.trigger,
                amount: settlement.amount.toString(),
                delta: settlement.delta.toString(),
              }
            );
            // money that landed at the recipient is a payout. The
            // reporter never throws, so this cannot fail the settlement.
            await payoutSinks.tempoSettled?.({
              txHash: settlement.txHash,
              channelId: settlement.channelId,
              trigger: settlement.trigger,
              amount: settlement.amount,
              delta: settlement.delta,
            });
          },
        };
      }
      const mppOpts = {
        tempoRecipient: mppTempoRecipient,
        methodsAllowlist: parseMppMethodsAllowlist(envMaybe.DVMKIT_TEMPO_METHODS),
        ...(tempoCharge && { tempoCharge }),
        ...(tempoSession && { tempoSession }),
      };
      const envSecret = envMaybe.DVMKIT_TEMPO_SECRET_KEY;
      // Dual-key zero-downtime rotation needs DVM-local Postgres
      // for the persisted `mpp_secret_state` row. Skip the rotation
      // bookkeeping in the test/dev path that's running without a pool
      // (e.g. `devMode` + an explicit `jobStore`) — single-key behaviour
      // is preserved there.
      if (pgPool && envSecret) {
        const {
          initMppSecretStateTable,
          applyMppSecretRotation,
          loadMppSecretState,
          DEFAULT_ROTATION_WINDOW_MS,
        } = await import("./mpp-secret-state");
        await initMppSecretStateTable(pgPool);
        const rotation = await applyMppSecretRotation(
          pgPool,
          envSecret,
          DEFAULT_ROTATION_WINDOW_MS
        );
        mppSecretState = rotation.state;
        if (rotation.rapidRotation) {
          diagnosticConsole.warn(
            {
              level: "warn",
              event: "mpp_rapid_rotation_detected",
              message:
                undefined,
              rapid_rotation_at_ms: rotation.state.rapidRotationAtMs,
              previous_expires_at_ms: rotation.state.previous?.expiresAtMs,
            }
          );
        }
        const localPool = pgPool;
        mpp = createDualKeyMppxFromOpts(mppOpts, env as NodeJS.ProcessEnv, () =>
          loadMppSecretState(localPool)
        );
      } else {
        mpp = createMppFromOpts(mppOpts, env as NodeJS.ProcessEnv);
      }
    }

    // Raw mode string for the boot summary (`"platform"` | a URL | undefined).
    const fxSource = envMaybe.DVMKIT_FX_SOURCE;
    // Imported unconditionally, because the warm-up below applies to an
    // injected fetcher too — the host is the only place that knows every
    // mounted descriptor, so it is the only place that can decide to prime one.
    const { createFxFetcher, resolveFxSourceFromEnv, warmFxSnapshot } = await import("../pricing");
    // resolve `DVMKIT_FX_SOURCE` through `resolveFxSourceFromEnv` so the
    // platform-injected `"platform"` magic string becomes an authenticated
    // `PlatformFxSource` instead of being treated as a literal URL. Passing it raw
    // makes `createFxFetcher` `fetch("platform")` → `Failed to parse URL from platform`,
    // which surfaces to callers as a 503 `fx_rate_unavailable` on every priced job.
    const fxFetcher = opts.fx ?? createFxFetcher({ source: resolveFxSourceFromEnv(envMaybe) });
    // one fetcher serves every mount (it goes down to `DVMServer` at
    // the mount loop below, and from there to the quote path, the static-price
    // translation, the credit menu, the ask-time pin and the verify-time hop),
    // so a single warm covers all of them. It has to happen here rather than in
    // `DVMServer`'s constructor: that constructor is synchronous, is the door
    // every unit test builds a server through, and knows one descriptor rather
    // than the mount set. Fired before the port binds and never awaited, so the
    // snapshot is usually in hand by the first request and the boot never waits
    // on the rate source either way.
    //
    // A host-level rail counts for every mount, including mounts whose own
    // descriptors declare no rail; see `mountNeedsFx`.
    const hostRailConfigured =
      (opts.paymentMethods?.length ?? 0) > 0 ||
      (effectiveMints?.length ?? 0) > 0 ||
      !!x402WithDualServe ||
      !!mpp;
    if (mounts.some((entry) => mountNeedsFx(entry, hostRailConfigured))) warmFxSnapshot(fxFetcher);

    const platformToken = opts.platformReporter?.token ?? envMaybe.DVMKIT_PLATFORM_TOKEN;
    const platformUrl = opts.platformReporter?.url ?? envMaybe.DVMKIT_PLATFORM_URL;

    const failFast = envFlag(envMaybe.DVMKIT_FAIL_FAST);

    // `dvmctl deploy` derives this one-way from the builder identity key and
    // provisions it as a Fly secret, having bound the matching pubkey into the
    // deploy attestation — so a receipt chains back to the cold builder key.
    //
    // A dev boot with no key mints an ephemeral one so `dvmctl dev` and the
    // local stack exercise the real signing path; those receipts verify but
    // nothing attests them (no `/v1/info#builder` block to chain to). Ephemeral
    // is confined to dev on purpose: replicas would each sign under a different
    // key, so a caller couldn't tell a rotation from a forgery. Production
    // without the env var simply doesn't issue receipts.
    assertReceiptIdentity(envMaybe, opts.builder, receiptKey, cashuOpts.dvmId, opts.devMode);

    // For every mounted descriptor whose auth scheme is `secp256k1Auth`,
    // hand the SDK-resolved replay store down to the scheme. When the host
    // owns a pool we share a single `PostgresReplayStore` across mounts so
    // (pubkey, timestamp, nonce) is unique across machines and across DVMs
    // on the same host. Falling back to in-memory outside `devMode` is a
    // multi-machine replay hazard — warn loudly, throw under fail-fast.
    let sharedPgReplayStore: SignedRequestReplayStore | undefined;
    if (pgPool) {
      const { PostgresReplayStore } = await import("./postgres-replay-store");
      const store = new PostgresReplayStore(pgPool);
      pendingInits.push(store.init());
      sharedPgReplayStore = store;
    }
    const replayStoreSummaries: ReplayStoreSummaryEntry[] = [];
    for (const entry of mounts) {
      const auth = entry.descriptor.auth;
      if (!auth) continue;
      const backend: ReplayStoreBackend = auth.resolveReplayStore
        ? auth.resolveReplayStore({ postgresStore: sharedPgReplayStore })
        : "user-supplied";
      replayStoreSummaries.push({ mount: entry.descriptor.name, backend });
      if (backend === "memory" && !opts.devMode) {
        const msg =
          `secp256k1Auth on "${entry.descriptor.name}" fell back to the in-memory replay store. ` +
          `Multi-machine deploys MUST use a cross-machine store (e.g. PostgresReplayStore) — ` +
          `each machine's per-process window otherwise lets an attacker replay a captured ` +
          `signed envelope once per machine via the load balancer. Set DATABASE_URL or pass ` +
          `\`replayStore\` to secp256k1Auth().`;
        if (failFast) {
          throw new Error(`[FATAL] ${msg}`);
        }
        diagnosticConsole.warn(
          {
            level: "warn",
            event: "secp256k1_auth_replay_store_in_memory",
            mount: entry.descriptor.name,
            message: undefined,
          }
        );
      }
    }

    // Same archetype as the replay store above: in-memory by default,
    // per-process under multi-machine. When the host owns a pool we share a
    // single PostgresConsumedCredentialStore across both payment-replay sites
    // (realm-namespaced into one table), so a captured one-time-use MPP
    // credential or signed P2PK admin nonce can't be replayed once per machine
    // via the load balancer. Falling back to in-memory while the relevant rail
    // is active is a multi-machine money-loss hazard — warn loudly, throw
    // under fail-fast. Gated on rail-activeness so a free DVM with no payment
    // rails doesn't refuse to boot purely for lacking these stores.
    let sharedPgConsumedStore: ConsumedCredentialStore | undefined;
    if (pgPool) {
      const { PostgresConsumedCredentialStore } =
        await import("./postgres-consumed-credential-store");
      const consumedStore = new PostgresConsumedCredentialStore(pgPool);
      pendingInits.push(consumedStore.init());
      sharedPgConsumedStore = consumedStore;
    }

    // Unconditional when a pool exists — the ledger is the settlement layer
    // for ALL rails (the durable-ledger requirement), not a Cashu-gated feature
    // like the accumulator, so it doesn't ride resolveCashuOptsFromEnv. Joins
    // the parallel-DDL batch; the verifier funds/draws it per
    // payment. Pool-less hosts get one shared MemoryCreditLedger
    // across every mount — the ledger is host-wide by design.
    if (pgPool) {
      const { CreditLedger } = await import("./credit-ledger");
      const pgLedger = new CreditLedger(pgPool, tempoSessionStore);
      pendingInits.push(pgLedger.init());
      creditLedger = pgLedger;
      const { PostgresProcessedPaymentStore } = await import("./processed-payment-store");
      const pgProcessed = new PostgresProcessedPaymentStore(pgPool);
      pendingInits.push(pgProcessed.init());
      processedPayments = pgProcessed;
    } else {
      const { MemoryCreditLedger } = await import("./memory-credit-ledger");
      creditLedger = disposableCashu?.ledger ?? new MemoryCreditLedger();
      const { MemoryProcessedPaymentStore } = await import("./processed-payment-store");
      processedPayments = new MemoryProcessedPaymentStore();
    }
    // Await the independent store-init DDL as one parallel batch.
    // First consumer is the mount loop below; the replay-summaries loop above
    // only holds the store reference, never queries it, so this is the earliest
    // point every store must actually be ready.
    await Promise.all(pendingInits);
    mark("stores");

    const storeSummaries: StoreSummaryEntry[] = [];
    const checkStoreFallback = (
      label: string,
      event: string,
      active: boolean,
      backend: StoreBackend,
      hazardHint: string
    ): void => {
      storeSummaries.push({ label, backend });
      if (active && backend === "memory" && !opts.devMode) {
        const msg =
          `The ${label} store fell back to in-memory. Multi-machine deploys MUST use a ` +
          `cross-machine store (set DATABASE_URL) — each machine's per-process window ` +
          `otherwise lets an attacker ${hazardHint} once per machine via the load balancer.`;
        if (failFast) {
          throw new Error(`[FATAL] ${msg}`);
        }
        diagnosticConsole.warn({ level: "warn", event, message: undefined });
      }
    };

    const mppActive = mounts.some((e) => (e.descriptor.mpp ?? mpp) !== undefined);
    const adminActive = !!cashuOpts.db && !!cashuOpts.dvmId && !!cashuOpts.lockPubkey;
    const consumedBackend: StoreBackend = opts.consumedCredentialStore
      ? "user-supplied"
      : pgPool
        ? "postgres"
        : "memory";
    const adminCashuBackend: StoreBackend = pgPool ? "postgres" : "memory";

    checkStoreFallback(
      "consumed-credential",
      "consumed_credential_store_in_memory",
      mppActive,
      consumedBackend,
      "replay a captured MPP credential"
    );
    checkStoreFallback(
      "tempo-charge-replay",
      "tempo_charge_replay_store_in_memory",
      mppActive,
      tempoChargeBackend,
      "replay a captured Tempo charge credential"
    );
    checkStoreFallback(
      "admin-cashu-nonce",
      "admin_cashu_nonce_store_in_memory",
      adminActive,
      adminCashuBackend,
      "replay a signed P2PK admin challenge"
    );
    checkStoreFallback(
      "kv",
      "kv_store_in_memory",
      true,
      kvBackend,
      "diverge builder KV state across replicas"
    );

    // SDK isolate-side instrumentation: buffer spans in-process and POST
    // to platform-api's /_internal/spans endpoint on a 5-second timer.
    // When the platform URL isn't set (self-hosted builders) or the env
    // flag disables it, the default no-op loggers stay in place — zero
    // overhead for third-party builders who don't use the platform.
    const obsDisabled = envFlag(envMaybe.DVMKIT_OBSERVABILITY_DISABLED);
    if (!obsDisabled && platformUrl && platformToken) {
      const transport = new HttpTransport(platformUrl, platformToken);
      spanWriter = new SpanWriter(transport, 5_000);
      const serviceName = `isolate-${mounts[0]?.descriptor.name ?? "unknown"}`;
      initLoggers(spanWriter, serviceName);
      spanWriter.startFlush();
    }

    for (const entry of mounts) {
      const descriptor = entry.descriptor;
      // Resolve per-descriptor x402 (descriptor.x402 if set, else host-level)
      const descX402 = descriptor.x402 ? normalizeX402Config(descriptor.x402) : x402WithDualServe;
      const descX402WithDualServe = descX402
        ? {
            ...descX402,
            dualServe: dualServeEnabled ? (descX402.dualServe ?? true) : false,
          }
        : undefined;
      if (!bootX402 && descX402WithDualServe) bootX402 = descX402WithDualServe;
      const descX402Health = descX402WithDualServe ? x402Health(descX402WithDualServe) : undefined;
      await descX402Health?.refresh();
      const descX402Support = descX402Health?.support();
      if (!bootX402Support && descX402Support) bootX402Support = descX402Support;
      const descMpp = descriptor.mpp ?? mpp;
      const x402Settleable = isConfiguredX402Settleable(
        descX402Support,
        descX402WithDualServe
      );
      if (descX402Support && !x402Settleable) {
        const message = `x402 network ${descX402Support.network} has no settleable kind at facilitator ${descX402Support.facilitator}. Use eip155:84532 (Base Sepolia) with x402.org for test funds, or a facilitator supporting your configured mainnet. No network was changed.`;
        if (failFast) throw new Error(message);
        diagnosticConsole.warn({ level: "warn", event: "x402_network_unsupported", message });
      }
      const paymentMode = resolvePaymentMode({
        mount: descriptor.name, devMode: opts.devMode, mints: effectiveMints,
        x402: descX402WithDualServe, mpp: descMpp,
        paymentMethods: opts.paymentMethods ?? descriptor.paymentMethods,
        cashuReady: !!cashuOpts.lockPubkey && !!(cashuOpts.db || disposableCashu) && !!effectiveMints?.length,
        x402Available: x402Settleable,
        durable: !!pgPool,
      });
      paymentModes.push(paymentMode);
      diagnosticConsole.log({ level: "info", event: "payment_mode", ...paymentMode,
        ...(disposableCashu ? { message: undefined } : {}),
      });

      const {
        app: subApp,
        shutdown,
        authAudience,
        payoutReporter,
      } = await createDVMServer(descriptor, {
        env,
        store,
        mints: effectiveMints,
        jobStore,
        devMode: opts.devMode,
        onPaidJobCompleted: opts.onPaidJobCompleted,
        paymentMode,
        paymentMethods: opts.paymentMethods ?? descriptor.paymentMethods,
        x402: descX402WithDualServe,
        x402FacilitatorHealth: descX402Health,
        mpp: descMpp,
        consumedCredentialStore: opts.consumedCredentialStore ?? sharedPgConsumedStore,
        adminCashuNonceStore: sharedPgConsumedStore,
        cashuMode: cashuOpts.cashuMode,
        disposableCashu: disposableCashu?.accumulator,
        lockPubkey: cashuOpts.lockPubkey,
        lockPubkeyGraceSeconds: cashuOpts.lockPubkeyGraceSeconds,
        canonicalDvmId: cashuOpts.canonicalDvmId,
        db: hostingControl ? pgPool : cashuOpts.db,
        hostingControl,
        hostingCleanupSingleMount: mounts.length === 1,
        hostingCleanupKnownRailStores: !mpp || tempoChargeBackend === "postgres",
        hostingTempoSessionStore: tempoSessionStore,
        hostingTempoChargeStore: tempoChargeStore,
        dvmId: cashuOpts.dvmId,
        failFast,
        mintHealthTracker: opts.mintHealthTracker,
        fxFetcher,
        healthHandler: opts.healthHandler,
        platformToken,
        platformUrl,
        builder: opts.builder,
        owner: opts.owner,
        receiptKey,
        creditLedger,
        processedPayments,
        lightningReceive,
        tempoObserverHealth,
        tempoSettlementReadiness,
        onJobRetentionSweepFailed: opts.onJobRetentionSweepFailed,
        onJobRetentionSweepRecovered: opts.onJobRetentionSweepRecovered,
      });
      entry.shutdown = shutdown;
      // Tempo state is host-level — one session store, one recipient — so its
      // payouts and its pending pool are attributed to the first mounted DVM
      // and reported once: a second mount's reporter would book the same
      // settlement again under its own id and count the same pool twice.
      if (payoutReporter && !tempoPayoutOwner) {
        tempoPayoutOwner = payoutReporter;
        const ledger = creditLedger;
        payoutReporter.attachTempo({
          ...tempoPayoutReader,
          ...(mppTempoRecipient ? { recipient: mppTempoRecipient } : {}),
          listChannelDrains: (args) => ledger.listChannelDrains(args),
        });
        payoutSinks.tempoSettled = (event) => payoutReporter.tempoSettled(event);
      }

      // DVM-scoped routes register on the sub-app so they inherit the mount
      // prefix automatically. For cross-DVM/host-level routes, the
      // builder uses `host.app` directly.
      if (descriptor.config.routes) {
        await descriptor.config.routes(subApp, {
          authAudience,
          requireClientCompatibility: routeClientCompatibility,
        });
      }

      if (entry.prefix) {
        app.route(entry.prefix, subApp);
      } else {
        app.route("/", subApp);
      }
    }

    // a path matching no mounted route is a scanner probe. Registered
    // on the host app because `app.route()` copies only a sub-app's routes, not
    // its notFound handler — so the SDK app's own notFound never fires here. The
    // handler tags the shared request context; the `dvm.request` span (mounted
    // from the sub-app as `/*` middleware, so it still runs on unmatched paths)
    // reads the tag and downgrades the 404 to `warn`.
    app.notFound(unknownRouteNotFound);
    mark("mount");

    // A throw from any onBoot propagates out of host.serve() — listener
    // never opens, caller's top-level await surfaces the error.
    for (const entry of mounts) {
      if (entry.descriptor.config.onBoot) {
        await entry.descriptor.config.onBoot(env);
      }
      entry.bootCompleted = true;
    }
    mark("onboot");

    logBootSummary({
      mounts: mounts.map((e) => ({ name: e.descriptor.name, prefix: e.prefix })),
      databaseConnected: !!pgPool,
      mints: effectiveMints,
      cashuOpts,
      mpp,
      mppSecretState,
      x402: bootX402,
      x402Support: bootX402Support,
      lightningReceive,
      fxSource,
      hasPlatformToken: !!platformToken,
      hasDvmId: !!cashuOpts.dvmId,
      platformUrl,
      devMode: !!opts.devMode,
      failFast,
      observability: spanWriter ? "active" : obsDisabled ? "disabled (env)" : "(no platform URL)",
      replayStores: replayStoreSummaries,
      stores: storeSummaries,
    });

    return new Promise((resolvePromise, rejectPromise) => {
      const server = honoServe({ fetch: app.fetch, port }, (info) => {
        // Only a bind failure belongs to this promise; a later runtime 'error'
        // must not be swallowed by an already-settled boot.
        server.off("error", rejectPromise);
        const url = `http://{authority}`.replace("{authority}", `localhost:${info.port}`);
        nodeServer = server as Server;
        // Emit the boot-phase breakdown. `port_bind` is the moment
        // the socket starts accepting — the total an autostopped machine's
        // first caller waits out. Per-phase deltas attribute where it went.
        const portBindMs = Date.now() - bootStart;
        const deltas: Record<string, number> = {};
        let prev = 0;
        for (const { phase, atMs } of phaseMarks) {
          deltas[phase] = atMs - prev;
          prev = atMs;
        }
        deltas.listen = portBindMs - prev;
        diagnosticConsole.log(
          {
            level: "dvm_boot_phase_timings",
            totalMsToPortBind: portBindMs,
            phaseMs: deltas,
            // removed the pre-`listen` `mint_wait` phase: mint health
            // is now validated by the runtime tracker after the port binds, so
            // `totalMsToPortBind` no longer carries the mint-probe tail.
          }
        );
        diagnosticConsole.log(`DVM host running at ${url}`);
        resolvePromise({
          url,
          paymentModes,
          close() {
            return shutdownInternal();
          },
        });
      });
      // `listen()` reports EADDRINUSE/EACCES asynchronously as an 'error'
      // event; unhandled, it crashes the process and this promise never
      // settles. Rejecting with the raw errno error lets serveFn roll back boot
      // and callers branch on `code`.
      server.once("error", rejectPromise);
    });
  }

  async function serveFn(serveOpts?: {
    port?: number;
  }): Promise<DVMServeResult> {
    if (serveAttempted) {
      throw new Error("A DVM host can only serve once. Create a new host to retry after shutdown.");
    }
    serveAttempted = true;
    try {
      return await boot(serveOpts);
    } catch (bootError) {
      // Boot is transactional: a failed store init, mount, route hook, or
      // descriptor hook must release everything initialized before it. Cleanup
      // failures remain observable through host.shutdown(), but the serve()
      // rejection keeps the original boot error that tells the operator what
      // prevented the listener from opening.
      await shutdownInternal().catch(() => undefined);
      throw bootError;
    }
  }

  function shutdownInternal(): Promise<void> {
    return (shutdownPromise ??= performShutdown());
  }

  async function performShutdown(): Promise<void> {
    const errors: unknown[] = [];
    const capture = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    if (nodeServer) {
      // Establish the graceful request boundary before tearing down anything a
      // handler can reach. Node's callback fires only after in-flight requests
      // drain, so mount and pool teardown cannot race accepted work.
      const server = nodeServer;
      await capture(
        () =>
          new Promise<void>((resolve) => {
            const idleSweep = setInterval(() => {
              server.closeIdleConnections();
            }, IDLE_CONNECTION_SWEEP_MS);
            idleSweep.unref();
            server.close(() => {
              clearInterval(idleSweep);
              resolve();
            });
            // `close()` stops new connections, but an existing idle keep-alive
            // socket can otherwise hold its callback open. Repeat the idle-only
            // sweep above because an in-flight request can become idle after this
            // first call. `closeAllConnections()` would also sever requests that
            // are still draining.
            server.closeIdleConnections();
          })
      );
      nodeServer = undefined;
    }

    // Flush remaining spans before tearing down mounts + pool.
    if (spanWriter) {
      const writer = spanWriter;
      spanWriter = undefined;
      await capture(() => writer.shutdown());
    }
    // Reverse mount order: later mounts shut down first so a
    // dependency-on-runtime mount can still see earlier mounts during teardown.
    for (let i = mounts.length - 1; i >= 0; i--) {
      const entry = mounts[i];
      if (entry.bootCompleted && entry.descriptor.config.onShutdown) {
        try {
          await entry.descriptor.config.onShutdown();
        } catch (_err) {
          diagnosticConsole.error();
        }
      }
      // Mount teardown is sequential as well as reverse-ordered: a later mount
      // fully releases its runtime before an earlier dependency is touched. A
      // failure is retained for the caller, but cannot strand the remaining
      // mounts or host-owned resources.
      await capture(() => entry.shutdown?.());
    }
    if (pgStreamStore && isStreamableJobStore(pgStreamStore)) {
      await capture(() => pgStreamStore?.shutdownStreaming());
    }
    if (pgPool && ownsPool) {
      const ownedPool = pgPool;
      await capture(() => ownedPool.end());
    }
    pgPool = undefined;
    creditLedger = undefined;
    processedPayments = undefined;
    if (tempoSettlementReadiness) {
      const readiness = tempoSettlementReadiness;
      tempoSettlementReadiness = undefined;
      await capture(() => readiness.stop());
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `${String(errors.length)} host shutdown operations failed`);
    }
  }

  return {
    app,
    get pool() {
      return pgPool;
    },
    get creditLedger() {
      return creditLedger;
    },
    mount,
    serve: serveFn,
    shutdown: shutdownInternal,
  };
}

/** A discovered batch kind is usable only when this DVM configured its batch server. */
export function isConfiguredX402Settleable(
  support: X402FacilitatorSupport | undefined,
  config: X402Config | undefined
): boolean {
  if (!support || !config) return false;
  if (support.available) return true;
  const batch = config.batchSettlement;
  return !!batch && (support.batchSettlement || !!batch.selfRelay);
}

/**
 * Whether this mount can end up translating through the fx snapshot, and so is
 * worth priming the shared fetcher for at boot.
 *
 * Two disjoint signals are required because a free-to-submit mount that charges
 * only through a mid-job payment request carries neither a price nor a `credit` block.
 *
 * **Declared surfaces.** A `credit` block denominates its ledger in fiat on
 * every draw and top-up; a static `price` translates on `/v1/info`; an
 * `onQuote` translates on `/v1/quote`.
 *
 * **A wired payment rail** (`hostRailConfigured`, or a descriptor-level x402 /
 * MPP / `paymentMethods` override). This is the rung the declared surfaces miss: a
 * free-to-submit DVM that charges purely through a mid-job
 * `ctx.requestPayment(5000, …)` — `payOnDeliveryFixture` in
 * `standalone development tooling`, the shape `dvm-e2e-test` Phase 7 walks —
 * declares no price, no quote and no credit block, yet its ask-time pin is
 * exactly the fetch that has nothing to degrade onto. `configureDVM` leaves
 * `descriptor.credit` undefined unless a builder writes the block, and the
 * implicit free-then-paid credit never needs one. A mid-job ask has to be
 * payable to be worth making, so "the host resolved a rail" is the signal that
 * survives a descriptor declaring nothing.
 *
 * A DVM with neither can charge nowhere, and must not fire a boot-time request
 * on a rate it will never consult — which is also what keeps this out of the
 * unit suite, where a free descriptor with no rails is the norm.
 */
function mountNeedsFx(entry: MountEntry, hostRailConfigured: boolean): boolean {
  const descriptor = entry.descriptor;
  if (descriptor.credit || descriptor.price) return true;
  if (hostRailConfigured || descriptor.x402 || descriptor.mpp) return true;
  if ((descriptor.paymentMethods?.length ?? 0) > 0) return true;
  return Object.values(descriptor.capabilities).some((cap) => !!cap.price || !!cap.onQuote);
}

/**
 * Refuse a production receipt signer whose injected runtime identity, signed
 * attestation, or receipt secret disagree. A valid receipt under a key bound
 * to another DVM is worse than no receipt: callers see cryptographic evidence
 * that points at the wrong provider.
 */
function assertReceiptIdentity(
  env: Record<string, string | undefined>,
  builder: BuilderIdentity | undefined,
  receiptKey: string | undefined,
  resolvedDvmId: string | undefined,
  devMode: boolean | undefined
): void {
  if (!receiptKey || devMode) return;

  const injectedDvmId = env.DVMKIT_DVM_ID;
  const canonicalDvmId = env.DVMKIT_CANONICAL_DVM_ID;
  const attestation = builder?.attestation ?? parseAttestationEnv(env.DVMKIT_BUILDER_ATTESTATION);
  const expectedPubkey = attestation?.receipt_pubkey;
  const derivedPubkey = receiptPubkeyFromSecret(receiptKey);

  if (
    !injectedDvmId ||
    !attestation ||
    typeof attestation.dvm_id !== "string" ||
    attestation.dvm_id !== injectedDvmId ||
    (canonicalDvmId != null && canonicalDvmId !== injectedDvmId) ||
    (resolvedDvmId != null && resolvedDvmId !== injectedDvmId) ||
    expectedPubkey?.toLowerCase() !== derivedPubkey
  ) {
    throw new Error(
      "[FATAL] Receipt-signing identity is incomplete or contradictory: DVMKIT_DVM_ID, " +
        "DVMKIT_CANONICAL_DVM_ID (when set), the builder attestation dvm_id, and " +
        "DVMKIT_RECEIPT_KEY must name the same immutable DVM. Re-deploy with dvmctl."
    );
  }
}

/** Parse the deploy-injected builder attestation without making malformed env fatal. */
function parseAttestationEnv(raw: string | undefined): AttestationPayload | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as AttestationPayload)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse `DVMKIT_NWC_RECEIVE_INVOICE_TTL_SECONDS`. Rejects a non-numeric value
 * here rather than letting `Number(...)` turn a typo into `NaN` and thence into
 * `resolveInvoiceTtl`'s floor check with a confusing message.
 */
function parseInvoiceTtlEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `DVMKIT_NWC_RECEIVE_INVOICE_TTL_SECONDS must be a whole number of seconds; got '${raw}'.`
    );
  }
  return parsed;
}

/**
 * Parse `DVMKIT_LIGHTNING_FUNDING_MIN_SATS`. Same posture as
 * {@link parseInvoiceTtlEnv}: reject garbage here so `resolveFundingMinSats`
 * sees a number or nothing.
 */
function parseFundingMinSatsEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `DVMKIT_LIGHTNING_FUNDING_MIN_SATS must be a whole number of sats; got '${raw}'.`
    );
  }
  return parsed;
}

/** Parse the per-machine ceiling for the SDK-owned shared Postgres pool. */
function parseHostPoolMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_HOST_POOL_MAX;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`DVMKIT_POSTGRES_POOL_MAX must be a positive integer; got '${raw}'.`);
  }
  return parsed;
}

const X402_PAY_TO_RE = /^0x[0-9a-fA-F]{40}$/;

function normalizeX402Config(config: X402Config): X402Config {
  const network = x402NetworkToCaip2(config.network);
  assertSupportedX402Network(network);
  return { ...config, network };
}

function buildX402FromEnv(env: Record<string, string | undefined>): X402Config | undefined {
  validateX402Env(env);
  const payTo = env.DVMKIT_X402_PAY_TO;
  const batchEnabled = env.DVMKIT_X402_BATCH_SETTLEMENT === "true";
  if (!payTo) {
    if (batchEnabled) {
      throw new Error("DVMKIT_X402_BATCH_SETTLEMENT requires DVMKIT_X402_PAY_TO.");
    }
    return undefined;
  }
  // Reject malformed pay-to addresses at boot rather than letting a typo
  // land a broken x402 advertisement on the wire (clients sign, on-chain
  // transfers go to a wrong / unowned address). Mirrors mpp-setup.ts.
  if (!X402_PAY_TO_RE.test(payTo)) {
    throw new Error(
      `DVMKIT_X402_PAY_TO must be a 0x-prefixed 40-char hex address; got '${payTo}'.`
    );
  }
  const network = env.DVMKIT_X402_NETWORK;
  const asset = env.DVMKIT_X402_ASSET;
  const facilitator = env.DVMKIT_X402_FACILITATOR;
  const facilitatorKeyId = env.DVMKIT_X402_FACILITATOR_KEY_ID;
  const facilitatorKeySecret = env.DVMKIT_X402_FACILITATOR_KEY_SECRET;
  if (!!facilitatorKeyId !== !!facilitatorKeySecret) {
    throw new Error(
      "DVMKIT_X402_FACILITATOR_KEY_ID and DVMKIT_X402_FACILITATOR_KEY_SECRET must be configured together."
    );
  }
  const dualServe = env.DVMKIT_X402_DUAL_SERVE;
  const description = env.DVMKIT_X402_DESCRIPTION;
  const receiverAuthorizerKey = env.DVMKIT_X402_RECEIVER_AUTHORIZER_KEY;
  const rpcUrl = env.DVMKIT_X402_RPC_URL?.trim();
  const selfRelayKey = env.DVMKIT_X402_SELF_RELAY_KEY;
  const selfRelayLowBalanceRaw = env.DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI?.trim();
  if (selfRelayLowBalanceRaw && !selfRelayKey) {
    throw new Error("DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI requires DVMKIT_X402_SELF_RELAY_KEY.");
  }
  let selfRelayLowBalanceWei: bigint | undefined;
  if (selfRelayLowBalanceRaw) {
    try {
      selfRelayLowBalanceWei = BigInt(selfRelayLowBalanceRaw);
    } catch {
      throw new Error("DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI must be a positive integer.");
    }
    if (selfRelayLowBalanceWei <= 0n) {
      throw new Error("DVMKIT_X402_SELF_RELAY_MIN_BALANCE_WEI must be a positive integer.");
    }
  }
  const withdrawDelayRaw = env.DVMKIT_X402_WITHDRAW_DELAY_SECONDS;
  const withdrawDelay = withdrawDelayRaw === undefined ? undefined : Number(withdrawDelayRaw);
  if (withdrawDelay !== undefined && (!Number.isInteger(withdrawDelay) || withdrawDelay < 0)) {
    throw new Error("DVMKIT_X402_WITHDRAW_DELAY_SECONDS must be a non-negative integer.");
  }
  return {
    payTo,
    network: network ?? X402_DEFAULT_NETWORK,
    ...(asset ? { asset } : {}),
    ...(facilitator ? { facilitator } : {}),
    ...(facilitatorKeyId && facilitatorKeySecret
      ? { facilitatorAuth: { keyId: facilitatorKeyId, keySecret: facilitatorKeySecret } }
      : {}),
    dualServe: dualServe !== "false",
    ...(description ? { description } : {}),
    ...(batchEnabled
      ? {
          batchSettlement: {
            ...(receiverAuthorizerKey
              ? {
                  receiverAuthorizerSigner: privateKeyToAccount(
                    receiverAuthorizerKey as `0x${string}`
                  ),
                }
              : {}),
            ...(withdrawDelay !== undefined ? { withdrawDelay } : {}),
            ...(rpcUrl ? { rpcUrl } : {}),
            ...(selfRelayKey && rpcUrl
              ? {
                  selfRelay: {
                    privateKey: selfRelayKey as `0x${string}`,
                    rpcUrl,
                    ...(selfRelayLowBalanceWei !== undefined
                      ? { lowBalanceWei: selfRelayLowBalanceWei }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

interface ReplayStoreSummaryEntry {
  mount: string;
  backend: ReplayStoreBackend;
}

/** Resolved backend for a per-process-fallback-prone store. */
type StoreBackend = "postgres" | "memory" | "user-supplied";

interface StoreSummaryEntry {
  label: string;
  backend: StoreBackend;
}

interface BootSummary {
  mounts: { name: string; prefix?: string }[];
  databaseConnected: boolean;
  mints?: string[];
  cashuOpts: ResolvedCashuOpts;
  mpp?: MppxServer;
  mppSecretState?: MppSecretState | null;
  x402?: X402Config;
  /** Facilitator capability observed before the x402 rail was mounted. */
  x402Support?: X402FacilitatorSupport;
  /** Lightning credit-funding receive leg, when one is configured. */
  lightningReceive?: LightningReceive;
  fxSource?: string;
  /** Whether a platform reporter token is wired — never the token itself. */
  hasPlatformToken: boolean;
  /** Whether DVMKIT_DVM_ID resolved — the reporter needs it alongside the token and DB. */
  hasDvmId: boolean;
  platformUrl?: string;
  /** Dev/test boot — exempt from the platform-hosted reporter guard. */
  devMode: boolean;
  failFast: boolean;
  observability: string;
  replayStores: ReplayStoreSummaryEntry[];
  stores: StoreSummaryEntry[];
}

function resolveTempoOperatorKey(raw: string | undefined): `0x${string}` | undefined {
  if (!raw) return undefined;
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      "DVMKIT_TEMPO_OPERATOR_KEY must be a 32-byte hex private key for a fee-funded Tempo account"
    );
  }
  return normalized as `0x${string}`;
}

function parseTempoSettlementFloor(env: Record<string, string | undefined>): bigint {
  const raw = env.DVMKIT_TEMPO_OPERATOR_MIN_BALANCE_MICRO?.trim();
  if (!raw) return TEMPO_SETTLEMENT_DEFAULT_LOW_BALANCE_MICRO;
  let parsed: bigint;
  try {
    parsed = BigInt(raw);
  } catch {
    throw new Error("DVMKIT_TEMPO_OPERATOR_MIN_BALANCE_MICRO must be a positive integer.");
  }
  if (parsed <= 0n) {
    throw new Error("DVMKIT_TEMPO_OPERATOR_MIN_BALANCE_MICRO must be a positive integer.");
  }
  return parsed;
}

/**
 * Log every inferred opt at boot. An operator running `fly logs`
 * sees the resolved configuration at a glance — no source-reading required.
 */
function logBootSummary(s: BootSummary): void {
  diagnosticConsole.log(
    `  Mounts:        ${s.mounts.map((m) => m.name + (m.prefix ?? "")).join(", ") || "(none)"}`
  );
  diagnosticConsole.log(`  Database:      ${s.databaseConnected ? "connected" : "(not configured)"}`);
  diagnosticConsole.log(`  Mints:         ${s.mints && s.mints.length > 0 ? s.mints.join(", ") : "(none)"}`);
  diagnosticConsole.log(`  Cashu mode:    ${s.cashuOpts.cashuMode ?? "(disabled)"}`);
  // Labelled by the rail, not the envelope: the mppx handle exists
  // only when `DVMKIT_TEMPO_RECIPIENT` is set and carries only tempo methods,
  // so a builder who configured Tempo must read Tempo back here, beside the
  // other rail rows. `realm` stays MPP's word because it is one — it is the
  // envelope's `WWW-Authenticate` realm, a value rather than a label.
  diagnosticConsole.log(`  Tempo:         ${s.mpp ? `realm=${s.mpp.realm ?? "(unset)"}` : "(unconfigured)"}`);
  if (s.mpp) {
    const rotState = !s.mppSecretState
      ? "single-key (no DB-backed rotation)"
      : s.mppSecretState.previous
        ? `dual-key (previous expires ${new Date(s.mppSecretState.previous.expiresAtMs).toISOString()})`
        : "active-only";
    diagnosticConsole.log(`  Tempo secret:  ${rotState}`);
  }
  diagnosticConsole.log(
    `  x402:          ${
      s.x402
        ? `${s.x402.network} → ${s.x402.payTo}${
            s.x402Support?.available === false
              ? isConfiguredX402Settleable(s.x402Support, s.x402)
                ? " (exact unavailable — batch configured)"
                : " (no configured settleable path)"
              : ""
          }`
        : "(unconfigured)"
    }`
  );
  diagnosticConsole.log(
    `  LN receive:    ${
      s.lightningReceive
        ? `receive-only NWC (${s.lightningReceive.available() ? "reachable" : "unreachable — omitted from the funding menu"})`
        : "(unconfigured)"
    }`
  );
  diagnosticConsole.log(
    `  Platform rep.: ${revenueReporterBannerState({
      platformUrl: s.platformUrl,
      hasPlatformToken: s.hasPlatformToken,
      hasDvmId: s.hasDvmId,
      databaseConnected: s.databaseConnected,
      devMode: s.devMode,
    })}`
  );
  diagnosticConsole.log(`  FX source:     ${s.fxSource ?? "(default — CoinGecko)"}`);
  diagnosticConsole.log(`  Fail-fast:     ${s.failFast ? "on" : "off"}`);
  diagnosticConsole.log(`  Observability: ${s.observability}`);
  for (const entry of s.replayStores) {
    diagnosticConsole.log(`  Replay store:  ${entry.mount} → ${formatReplayBackend(entry.backend)}`);
  }
  for (const entry of s.stores) {
    diagnosticConsole.log(`  ${storeLabel(entry.label)} ${formatStoreBackend(entry.backend)}`);
  }
}

function storeLabel(label: string): string {
  const display: Record<string, string> = {
    "consumed-credential": "Consumed cred:",
    "tempo-charge-replay": "Charge replay:",
    "admin-cashu-nonce": "Admin nonce:  ",
    kv: "KV store:     ",
  };
  return display[label] ?? `${label}:`;
}

function formatStoreBackend(backend: StoreBackend): string {
  switch (backend) {
    case "postgres":
      return "postgres (cross-machine)";
    case "memory":
      return "memory (per-process — multi-machine UNSAFE)";
    case "user-supplied":
      return "user-supplied";
  }
}

function formatReplayBackend(backend: ReplayStoreBackend): string {
  switch (backend) {
    case "postgres":
      return "postgres (cross-machine)";
    case "memory":
      return "memory (per-process — multi-machine UNSAFE)";
    case "user-supplied":
      return "user-supplied";
    case "disabled":
      return "disabled (user opt-out)";
  }
}
