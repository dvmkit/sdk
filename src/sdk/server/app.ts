import { BalancePaymentError, commitBalancePayment } from "./balance-payment";
import { completeTempoChannelDrain } from "./tempo-drain-leg";
import { installAdminContentRoutes } from "./admin-content";
import { contentMetadata, isContentHoldStore } from "./content-retention";
import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { PaidJobCompletion, PaymentMode } from "./payment-mode";
import type { DisposableCashuCommit } from "./disposable-cashu-store";
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Context } from "hono";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Pool } from "pg";
import { toJSONSchema, z } from "zod";
import { HostedChannelEvidenceReader } from "./hosting-channel-evidence";

import { shortSha } from "../../lib/git-sha";
import { JOB_IDENTITY_HEADER, isJobIdentityValue } from "../../lib/job-identity-header";
import type { Message, MessageType } from "../../lib/messages/types";
import { withPostgresRecoveryContext } from "../../lib/pg-retry";
import type { FundingReceipt, JobReceipt } from "../../lib/receipt";
import { attestedDvmIdentity } from "../../lib/receipt-verify";
import { isPublicRequestId } from "../../lib/request-id";
import {
  canonicalRequestPath,
  type SignedRequestAudience,
  type SignedRequestDomain,
} from "../../lib/signed-request-statement";
import { parseTraceparent } from "../../lib/traceparent";
import type { V1InfoCapability, V1InfoResponse } from "../../lib/transport/types";
import { X402_BATCH_SETTLEMENT_SCHEME, X402_EXACT_SCHEME } from "../../lib/x402/spec";
import { x402NetworkByCaip2 } from "../../lib/x402/networks";
import type {
  X402Config,
  X402SelfRelayBalanceObservation,
  X402SelfRelayRpcHealthObservation,
} from "../../lib/x402/types";
import { pinDimension, withTraceContext } from "../../observability/context";
import { loggers } from "../../observability/loggers";
import {
  createDiagnosticCapabilityAuthority,
  type DiagnosticCapabilityAuthority,
} from "../../observability/projection";
import type { TraceContext } from "../../observability/types";
import { withSpan } from "../../observability/with-span";
import type { FxFetcher } from "../pricing/index";
import {
  createFxFetcher,
  fiatToSatsCeil,
  fxRateFor,
  InvalidCurrencyError,
  resolveFxSourceFromEnv,
  UnsupportedCurrencyError,
  validateCurrency,
} from "../pricing/index";
import type {
  CapabilityDescriptor,
  CashuMode,
  DVMDescriptor,
  FundingMethod,
  KVStore,
  PaymentMethod,
  QuoteContext,
  QuoteResult,
  ZodLike,
} from "../types";
import { isZodSchema, RAIL_REFUNDABLE } from "../types";
import { createAdminCashuNonceStore, installAdminCashuRoutes } from "./admin-cashu";
import { installAdminCreditRoutes } from "./admin-credit";
import { authErrorBody, callerInputIssues, infoSchemaUrl } from "./auth-error";
import { callerFacingRequestUrl, resolvePublicOrigin } from "./caller-facing-url";
import {
  type ClientCompatibility,
  clientCompatibilityAttributes,
  clientCompatibilityMiddleware,
} from "./client-compatibility";
import {
  type ConsumedCredentialStore,
  MemoryConsumedCredentialStore,
} from "./consumed-credential-store";
import { type CreditEnvelope, CreditEnvelopeError, extractCreditEnvelope } from "./credit-envelope";
import type { CreditExpirySweepOpts } from "./credit-expiry-sweep";
import { startCreditExpirySweep } from "./credit-expiry-sweep";
import { CreditLedger, type CreditLedgerLike, type CreditSnapshot, type DrawRecord } from "./credit-ledger";
import type { PostgresTempoChargeStore } from "./tempo-charge-store";
import type { PostgresTempoSessionStore } from "./tempo-session-store";
import type { CreditMenu } from "./credit-menu";
import {
  attachCreditMenu,
  buildCreditMenu,
  creditMenuConfigured,
  selectPrimaryCredit,
  toCreditTerms,
  toCreditView,
} from "./credit-menu";
import { handleCreditRequest } from "./credit-routes";
import { devPageHtml } from "./dev-page";
import type { PriceFiat } from "./funding";
import {
  derivedFundCreditId,
  drawSettlementRef,
  IMPLICIT_CREDIT_TTL_MS,
  priceFiatMicro,
  resolvePriceFiat,
} from "./funding";
import { fundingReceiptFor } from "./funding-receipt";
import { HostingControl, type HostingClosureCommand, type HostingClosureSupport,
  type HostingControlCommand, type HostingControlConfig } from "./hosting-control";
import { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import type { BuilderIdentity, OwnerDisplay } from "./host";
import { createInstrumentedFetch } from "./instrumented-fetch";
import type { ServerJob } from "./job";
import { isTerminal, isYieldMessage, localMessage } from "./job";
import { jobCredentialGate } from "./job-credential";
import {
  JobManager,
  JobSnapshotPersistenceError,
  retryJobSnapshot,
  type JobManagerOpts,
  MissingStructuredInputError,
  ReactivationAuthSchemaError,
  type UnappliedCredit,
} from "./job-manager";
import type {
  JobRecord,
  JobStatus,
  JobStore,
  RequestIdClaim,
  RequestIdClaimResult,
} from "./job-store";
import { isStreamableJobStore } from "./job-store";
import type { LightningReceive } from "./lightning-receive";
import {
  activePubkeySet,
  DEFAULT_LOCK_PUBKEY_GRACE_SECONDS,
  loadLockPubkeyState,
  type LockPubkey,
  type LockPubkeyState,
  toLockPubkey,
} from "./lock-pubkey-store";
import { MemoryCreditLedger } from "./memory-credit-ledger";
import { MintHealthTracker } from "./mint-health-tracker";
import { advertisedMethods, installHostedTempoChargeGuard,
  installHostedTempoCloseGuard, type MppxServer } from "./mpp-setup";
import type {
  PaymentErrorDetail,
  PaymentInfo,
  ShortPayForfeit,
  UpfrontPaymentOpts,
} from "./payment";
import {
  buildPaymentErrorResponse,
  creditDepositPayload,
  devModeSkipsPaymentVerification,
  hasPaymentProof,
  PAYMENT_PROOF_KEYS,
  paymentErrorBody,
  repairX402ExactSettlementEffect,
  verifyUpfrontPayment,
} from "./payment";
import type { PayoutReporter } from "./payout-reporter";
import type { ProcessedPaymentStore } from "./processed-payment-store";
import { MemoryProcessedPaymentStore, PostgresProcessedPaymentStore } from "./processed-payment-store";
import { PostgresJobStore } from "./postgres-job-store";
import { ReceiptIssuer } from "./receipt-issuer";
import {
  hasInvalidRequestId,
  requestIdFromEnvelope,
  stripProtocolEnvelope,
} from "./request-envelope";
import { requestFingerprint } from "./request-fingerprint";
import type {
  CreditDepositEnqueue,
  CreditDepositPayload,
  CreditDrainEnqueue,
  CreditDrawReleaseEnqueue,
  CreditDrawRefundEnqueue,
  RevenueSkippedNoRailPayload,
  RevenueReporter,
} from "./revenue-reporter";
import type { CanonicalEnvelope } from "./signed-request";
import { SignedRequestError, signedRequestInput } from "./signed-request";
import {
  handleTempoCloseEvent,
  parseTempoCloseEventLocator,
  serializeTempoSettlementOutcome,
  TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS,
  tempoCloseEventStatus,
} from "./tempo-close-event";
import type { TempoObserverHealth } from "./tempo-observer-health";
import type { TempoSettlementReadiness } from "./tempo-settlement-readiness";
import {
  createX402BatchSettlementServer,
  type X402BatchSettlementServer,
} from "./x402-batch-settlement";
import { PostgresX402ChannelStorage } from "./x402-channel-store";
import { X402ExactSettlementServer } from "./x402-exact-settlement";
import { PostgresX402ExactSettlementStore } from "./x402-exact-settlement-store";
import {
  configuredX402FacilitatorSupport,
  type X402FacilitatorHealthLike,
  type X402FacilitatorSupport,
} from "./x402-facilitator-support";
import { createX402SettlementEvidenceReader } from "./x402-settlement-evidence";
import { humanizeZodError, humanizeZodIssues, zodIssuesOf } from "./zod-error";

export interface RevenueBootCheckOpts {
  /**
   * Reporter readiness ignores this host strict-mode flag.
   */
  failFast?: boolean;
  devMode?: boolean;
  platformToken: string | undefined;
  platformUrl: string | undefined;
  dvmId: string | undefined;
  hasPgPool: boolean;
}

/**
 * Hosted boots (a platform URL is set) require a token, DVM ID and database;
 * partial wiring is fatal regardless of `failFast`. Self-hosted and `devMode`
 * boots skip this assertion. The exemption does not disable an already wired
 * reporter; the banner separately describes whether reporting is active.
 */
export function assertRevenueReporterReady(opts: RevenueBootCheckOpts): void {
  if (opts.devMode) return;

  if (!opts.platformUrl) return;

  const pieces = {
    DVMKIT_PLATFORM_TOKEN: opts.platformToken,
    DVMKIT_DVM_ID: opts.dvmId,
    database: opts.hasPgPool ? "connected" : undefined,
  };
  const missing = Object.entries(pieces)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length === 0) return;

  const msg =
    `[FATAL] Platform-hosted DVM with incomplete revenue-reporter wiring. ` +
    `DVMKIT_PLATFORM_URL is set but missing: ${missing.join(", ")}. ` +
    `Either complete the configuration or unset DVMKIT_PLATFORM_URL to opt out.`;
  diagnosticConsole.error(msg);
  throw new Error(msg);
}

/** What the host's boot banner knows about the revenue reporter's wiring. */
export interface ReporterBannerOpts {
  /** `DVMKIT_PLATFORM_URL` — the platform-hosted signal. */
  platformUrl: string | undefined;
  /** Whether `DVMKIT_PLATFORM_TOKEN` resolved — never the token itself. */
  hasPlatformToken: boolean;
  /** Whether `DVMKIT_DVM_ID` resolved. */
  hasDvmId: boolean;
  databaseConnected: boolean;
  devMode: boolean;
}

/**
 * Render the boot banner's `Platform rep.` line.
 *
 * Lives here, next to the assertion, because `active` has to mirror the
 * reporter's own wiring gate in `createDVMServer` below — token **and** dvmId
 * **and** database. Miss one and the banner claims a reporter that was never
 * constructed.
 *
 * Partial dev wiring reaches the banner because the boot assertion is exempt;
 * it reports a dev status rather than a production configuration failure.
 */
export function revenueReporterBannerState(s: ReporterBannerOpts): string {
  if (!s.platformUrl) return "(self-hosted)";
  if (s.hasPlatformToken && s.hasDvmId && s.databaseConnected) return "active";
  return s.devMode ? "(dev — not reporting)" : "misconfigured";
}

export interface SDKServerOpts {
  env: Record<string, string>;
  store: KVStore;
  mints?: string[];
  /** Persistent backing store for job records. Default: in-memory. */
  jobStore?: JobStore;
  /** When true, use a fixed test requesterId ("dev-anonymous"). */
  devMode?: boolean;
  /** Payment methods this DVM accepts. Default: derived from configured rails — adds "cashu" when `mints` is set, "x402" when `x402` is set, "tempo" when `tempo` is set. */
  paymentMethods?: PaymentMethod[];
  x402?: X402Config;
  /** Live facilitator capability gate. Hosts wire this after probing `/supported`. */
  x402FacilitatorHealth?: X402FacilitatorHealthLike;
  /** MPP multi-rail payment handle (built via `createMppFromOpts`). */
  mpp?: MppxServer;
  /**
   * Tracks already-consumed upfront-flow MPP credentials so the same
   * credential can't satisfy `POST /v1/job` twice within its `expires`
   * window. Default: in-memory, bounded, per-process. Swap for a
   * shared backend before deploying multiple replicas.
   */
  consumedCredentialStore?: ConsumedCredentialStore;
  /**
   * Tracks already-consumed admin-endpoint nonces so a signed P2PK challenge
   * can't be replayed within the 5-minute sliding window. Default:
   * in-memory, bounded, per-process. Swap for a shared backend before
   * deploying multiple replicas.
   */
  adminCashuNonceStore?: ConsumedCredentialStore;
  /**
   * Optional override for `GET /health`. When set, the SDK installs this
   * handler instead of the default `{ status: "ok" }` responder. DVMs use it
   * to expose runtime-specific health (pool depth, draining state, etc.) and
   * to control the response status code (e.g. 503 while draining). Registered
   * before any other route so it always wins, regardless of caller-side
   * registration order.
   */
  healthHandler?: (c: Context<AppEnv>) => Response | Promise<Response>;
  /** Cashu receive mode. */
  cashuMode?: CashuMode;
  /**
   * Builder's NUT-11 P2PK lock pubkey. Used as the seed pubkey for
   * `seedLockPubkeyState` on first boot, as the admin-auth identity, and as
   * part of the gate for whether `/v1/info` advertises `cashu`. After first
   * boot, the authoritative `[current, ...retired]` state lives in the DVM's
   * Postgres via `dvm_lock_pubkeys`; rotations mutate that store
   * directly.
   */
  lockPubkey?: string;
  /** Test-only atomic Cashu backend, supplied by the development host. */
  disposableCashu?: DisposableCashuCommit;
  /**
   * Rotation grace window (seconds) — retired pubkeys remain advertised on
   * `cashu.lock_pubkeys` and accepted by the receive path until they age out.
   * Defaults to 24h.
   */
  lockPubkeyGraceSeconds?: number;
  /**
   * Per-DVM canonical identifier. Advertised on `/v1/info` as
   * `cashu.canonical_id` so agents can derive the matching per-DVM refund
   * subkey at `m/1789'/2'/hashed(canonical_dvm_id)'`. Defaults to `dvmId`
   * (the platform's DVM UUID) when unset — keeps `/v1/info` self-consistent
   * without a separate env var.
   */
  canonicalDvmId?: string;
  /** Postgres pool for builder admin state and wallet accumulator persistence. */
  db?: Pool;
  /** Enables authenticated, durable hosting admission and bounded drain. Requires Postgres and dvmId. */
  hostingControl?: HostingControlConfig;
  /** Internal host wiring: shared ledger rows cannot certify one of several mounts. */
  hostingCleanupSingleMount?: boolean;
  /** Internal host wiring: every configured rail uses SDK-owned durable stores. */
  hostingCleanupKnownRailStores?: boolean;
  hostingTempoSessionStore?: PostgresTempoSessionStore;
  hostingTempoChargeStore?: PostgresTempoChargeStore;
  /**
   * Host strict-mode flag. Reporter readiness follows hosted context regardless
   * of this value.
   */
  failFast?: boolean;
  /** Agent-wallet: per-DVM identifier — drives the monitor advisory lock + replay key. */
  dvmId?: string;
  /**
   * Runtime mint-health tracker. When omitted, the server builds a
   * fresh one whenever `mints?.length > 0`. Healthy mints are preferred in
   * `/v1/info`; when none are healthy, transiently sick mints remain advertised.
   * NUT-incompatible mints are excluded even from that fallback.
   */
  mintHealthTracker?: MintHealthTracker;
  /** Shared upfront/mid-job fiat conversion fetcher. Defaults to `DVMKIT_FX_SOURCE` or CoinGecko. */
  fxFetcher?: FxFetcher;
  /**
   * Platform API token for revenue reporting. Read from
   * `opts.env.DVMKIT_PLATFORM_TOKEN` when not set explicitly. When both
   * `platformToken` and `platformUrl` are present alongside `db` and `dvmId`,
   * the SDK auto-constructs a `RevenueReporter` and wires it into the
   * `JobManager`'s completion path.
   */
  platformToken?: string;
  /**
   * Platform API URL for revenue reporting. Read from
   * `opts.env.DVMKIT_PLATFORM_URL` when not set explicitly.
   */
  platformUrl?: string;
  /** Observes completed jobs with a positive settled draw; failures are logged and swallowed. */
  onPaidJobCompleted?: (event: PaidJobCompletion) => void | Promise<void>;
  paymentMode?: PaymentMode;
  /** Overrides automatic RevenueReporter wiring; the caller owns revenue delivery. */
  onJobCompleted?: JobManagerOpts["onJobCompleted"];
  /**
   * Advanced override for a declared cost on a terminal job that emitted no
   * revenue report. Auto-wired to the reporter's durable
   * job-cost path; intended for tests and advanced integrations only.
   */
  onJobCost?: JobManagerOpts["onJobCost"];
  onJobTerminal?: JobManagerOpts["onJobTerminal"];
  /**
   * Advanced override: callback fired when the stale-job reaper force-fails a
   * *paid* job. Auto-wired to the `RevenueReporter`'s paid-job-death
   * report alongside `onJobCompleted`; set explicitly only for tests / advanced
   * integrations that own their own reporting.
   */
  onPaidJobDeath?: JobManagerOpts["onPaidJobDeath"];
  /**
   * Advanced override: callback fired when a settled credit draw could not
   * book revenue because its rail was unavailable. Auto-wired to
   * the platform reporter alongside the completion and paid-job-death paths.
   */
  onRevenueSkippedNoRail?: (info: RevenueSkippedNoRailPayload) => void | Promise<void>;
  /** Advanced operator-alert callback for failed job-retention passes. */
  onJobRetentionSweepFailed?: JobManagerOpts["onJobRetentionSweepFailed"];
  /** Advanced clear-on-recovery callback for clean job-retention passes. */
  onJobRetentionSweepRecovered?: JobManagerOpts["onJobRetentionSweepRecovered"];
  /**
   * Advanced override: callback fired when a payment funds a credit.
   * Auto-wired to the `RevenueReporter`'s deposit report alongside
   * `onJobCompleted`; set explicitly only for tests / advanced integrations
   * that own their own reporting. Fundings are deposits — a liability until
   * drawn — reported separately from the draws that become revenue (the deposit-accounting rule).
   */
  onCreditFunded?: (info: CreditDepositPayload) => void | Promise<void>;
  /**
   * Grace window (ms) a reactivating machine waits for a live original handler
   * to win the single-execution claim before replaying an `awaiting-input` job
   * Defaults to the JobManager's built-in value; exposed as an ops
   * override and a test seam.
   */
  reactivationClaimGraceMs?: JobManagerOpts["reactivationClaimGraceMs"];
  /**
   * Builder identity for `/v1/info#builder`. Inline alternative
   * to the `DVMKIT_BUILDER_PUBKEY` / `_ATTESTATION` / `_SIGNATURE` env vars
   * the platform's deploy pipeline injects as Fly secrets. When set,
   * `builder.{pubkey, attestation, signature}` take per-field precedence
   * over the env vars; all three must resolve (from either source) for the
   * `/v1/info#builder` block to be emitted.
   */
  builder?: BuilderIdentity;
  /** Owner display identity for `/v1/info#owner`. Falls back to env vars. */
  owner?: OwnerDisplay;
  /**
   * Per-DVM receipt-signing secret, 32 bytes hex. Resolved at the
   * host boundary from `DVMKIT_RECEIPT_KEY` — the deploy pipeline provisions
   * it as a Fly secret, derived one-way from the builder identity key and
   * bound into the deploy attestation's `receipt_pubkey`.
   *
   * Absent means no receipts: the DVM terminates jobs exactly as it did
   * before and `/v1/info` omits the `receipts` flag, so a caller can tell the
   * difference between "no receipt issued" and "receipts not supported here".
   */
  receiptKey?: string;
  /**
   * Credit ledger every payment funds and draws through. The host
   * passes the Postgres `CreditLedger` when a pool exists; standalone /
   * pool-less setups default to a per-server `MemoryCreditLedger` so the
   * fund+draw semantics (and receipts' credit block) hold everywhere.
   */
  creditLedger?: CreditLedgerLike;
  /**
   * Durable x402/mpp processed-payment markers. Defaults to the
   * in-memory store; the host passes the Postgres one alongside the ledger.
   */
  processedPayments?: ProcessedPaymentStore;
  /**
   * Lightning credit-funding receive leg, when the host resolved a
   * receive-only NWC connection. Absent ⇒ `lightning` never appears on the
   * funding menu and `POST /v1/credit` refuses the method.
   */
  lightningReceive?: LightningReceive;
  /**
   * Liveness of the platform's Tempo close observer. Absent ⇒ this
   * DVM is self-hosted and answers for its own close watching, so nothing is
   * withheld. Present and unhealthy ⇒ `tempo/session` is withheld while
   * `tempo/charge` stays available.
   */
  tempoObserverHealth?: TempoObserverHealth;
  /** Platform-hosted operator fee-token readiness; absent outside hosted sessions. */
  tempoSettlementReadiness?: TempoSettlementReadiness;
  /**
   * Tuning for the credit-expiry sweep. Omitted, the sweep runs on
   * its own defaults whenever the ledger supports it; tests pass `intervalMs: 0`
   * and `bootDelayMs: 0` to hold the clock still and drive `runOnce` by hand.
   */
  creditExpirySweep?: CreditExpirySweepOpts;
}

/** Internal reporter wiring added after the public server options are resolved. */
interface InternalSDKServerOpts extends SDKServerOpts {
  hostingControlInstance?: HostingControl;
  hostedSettlementReports?: HostedSettlementReportObligations;
  hostingClosureSupport?: HostingClosureSupport;
  enqueueCreditDeposit?: CreditDepositEnqueue;
  enqueueCreditDrain?: CreditDrainEnqueue;
  enqueueCreditDrawRelease?: CreditDrawReleaseEnqueue;
  enqueueCreditDrawRefund?: CreditDrawRefundEnqueue;
  x402BatchSettlement?: X402BatchSettlementServer;
  x402BatchSettlementFactory?: () => Promise<X402BatchSettlementServer>;
  x402ExactSettlement?: X402ExactSettlementServer;
  /** The payout reporter, present exactly when the revenue reporter is. */
  payoutReporter?: PayoutReporter;
}

export async function createDVMServer<State, InputSchema extends ZodLike | undefined>(
  descriptor: DVMDescriptor<State, InputSchema>,
  opts: SDKServerOpts
): Promise<{
  app: Hono<AppEnv>;
  authAudience?: SignedRequestAudience;
  shutdown: () => Promise<void>;
  jobManager: JobManager<State, InputSchema>;
  revenueReporterActive: boolean;
  /** The payout reporter, for the host to attach its Tempo readers to. */
  payoutReporter?: PayoutReporter;
}> {
  let revenueReporter: RevenueReporter | undefined;
  let payoutReporter: PayoutReporter | undefined;
  let unsubscribeTempoSettlementReadiness: (() => void) | undefined;
  let creditExpirySweep: ReturnType<typeof startCreditExpirySweep>;
  let x402ChannelStorage: PostgresX402ChannelStorage | undefined;
  let x402BatchSettlement: X402BatchSettlementServer | undefined;
  let server: DVMServer<State, InputSchema> | undefined;
  let hostingControl: HostingControl | undefined;
  let hostedSettlementReports: HostedSettlementReportObligations | undefined;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> =>
    (shutdownPromise ??= (async () => {
      const errors: unknown[] = [];
      const capture = async (operation: () => void | Promise<void>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };

      // Start the only asynchronous server leg before stopping the synchronous
      // background loops, as before, but keep its promise so teardown has an
      // observable completion boundary.
      let settlementStopped: Promise<void> | undefined;
      if (server) {
        try {
          settlementStopped = server.shutdown();
        } catch (error) {
          errors.push(error);
        }
      } else if (x402BatchSettlement) {
        try {
          settlementStopped = x402BatchSettlement.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      await capture(() => payoutReporter?.stop());
      await capture(() => revenueReporter?.stop());
      await capture(() => creditExpirySweep?.stop());
      await capture(() => unsubscribeTempoSettlementReadiness?.());
      if (settlementStopped) await capture(() => settlementStopped);
      if (x402ChannelStorage) {
        // Stop the settlement server before closing its shared pool. Always attempt
        // the dependent close even if stop rejects; expose both failures.
        await capture(() => x402ChannelStorage?.close());
      }

      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, `${String(errors.length)} DVM shutdown operations failed`);
      }
    })());

  try {
  if (opts.env.DVMKIT_CASHU_MINTS && opts.cashuMode === undefined) {
    diagnosticConsole.warn(
      {
        level: "cashu_opts_env_ignored",
        message:
          undefined,
      }
    );
  }

  const envMaybe = opts.env as Record<string, string | undefined>;
  const platformToken = opts.platformToken ?? envMaybe.DVMKIT_PLATFORM_TOKEN;
  const platformUrl = opts.platformUrl ?? envMaybe.DVMKIT_PLATFORM_URL;
  const dvmId = opts.dvmId;

  if (opts.hostingControl && opts.db && dvmId && typeof opts.db.connect === "function") {
    hostedSettlementReports = new HostedSettlementReportObligations(
      opts.db, dvmId, opts.hostingControl.scope
    );
    await hostedSettlementReports.init();
    if (opts.x402?.batchSettlement) {
      const network = x402NetworkByCaip2(opts.x402.network);
      if (!network) throw new Error("Hosted x402 batch network is unsupported");
      hostedSettlementReports.configureX402({
        network: opts.x402.network,
        receiver: opts.x402.payTo,
        token: network.usdc,
        ...(opts.x402.batchSettlement.rpcUrl ? { rpcUrl: opts.x402.batchSettlement.rpcUrl } : {}),
      });
    }
    if (opts.hostingTempoSessionStore && opts.mpp?.tempoConfiguration) {
      const { Session: TempoSession } = await import("mppx/tempo");
      const tempo = opts.mpp.tempoConfiguration;
      hostedSettlementReports.configureTempo({
        network: `eip155:${tempo.chainId}`,
        escrow: TempoSession.Precompile.Constants.tip20ChannelEscrow,
        payee: tempo.recipient,
        token: tempo.paymentToken,
        ...(envMaybe.DVMKIT_TEMPO_RPC_URL ? { rpcUrl: envMaybe.DVMKIT_TEMPO_RPC_URL } : {}),
      });
    }
  }

  if (!opts.onJobCompleted && platformToken && platformUrl && dvmId && opts.db) {
    const { RevenueReporter } = await import("./revenue-reporter");
    const reporter = new RevenueReporter(opts.db, platformUrl, platformToken,
      hostedSettlementReports);
    revenueReporter = reporter;
    await reporter.init();
    reporter.startRetryLoop();
    // payouts and pending pools ride the same reporter's durable
    // queue and token, so they exist exactly when revenue reporting does. A
    // query-only test double keeps the open x402 batch in memory, as the exact
    // settlement store below stays off Postgres for the same doubles.
    const { MemoryX402BatchStore, PayoutReporter } = await import("./payout-reporter");
    payoutReporter = new PayoutReporter({
      dvmId,
      db: opts.db,
      transport: reporter,
      ...(hostedSettlementReports ? { hostedObligations: hostedSettlementReports } : {}),
      // The same condition the admin routes and the accumulator monitor mount on.
      cashu: opts.cashuMode === "p2pk-accumulator" && !!opts.lockPubkey,
      ...(typeof opts.db.connect === "function" ? {} : { batchStore: new MemoryX402BatchStore() }),
    });
    await payoutReporter.init();
    payoutReporter.start();
  }

  assertRevenueReporterReady({
    failFast: opts.failFast ?? false,
    devMode: opts.devMode,
    platformToken,
    platformUrl,
    dvmId,
    hasPgPool: !!opts.db,
  });
  const activeRevenueReporter = revenueReporter;

  const effectiveOnJobCompleted =
    opts.onJobCompleted ??
    (activeRevenueReporter
      ? (info: Parameters<NonNullable<JobManagerOpts["onJobCompleted"]>>[0]) =>
          activeRevenueReporter.report(info)
      : undefined);

  // A terminal that produced no revenue still carries a builder-incurred cost
  // through the same durable reporter queue, under its own rail-less contract.
  const effectiveOnJobCost =
    opts.onJobCost ??
    (activeRevenueReporter
      ? (info: Parameters<NonNullable<JobManagerOpts["onJobCost"]>>[0]) =>
          activeRevenueReporter.reportCost(info)
      : undefined);

  // the paid-job-death report rides the same reporter. Wired whenever
  // the RevenueReporter is auto-wired, so every container first-party DVM gets
  // released-draw notice structurally — no per-DVM alert wiring.
  const effectiveOnPaidJobDeath =
    opts.onPaidJobDeath ??
    (activeRevenueReporter
      ? (info: Parameters<NonNullable<JobManagerOpts["onPaidJobDeath"]>>[0]) =>
          activeRevenueReporter.reportPaidJobDeath(info)
      : undefined);

  // the settled-draw/no-rail report rides the same reporter. It is
  // deliberately best-effort; the SDK's structured log remains the durable
  // backstop and the platform owns dedup + operator delivery.
  const effectiveOnRevenueSkippedNoRail =
    opts.onRevenueSkippedNoRail ??
    (activeRevenueReporter
      ? (info: RevenueSkippedNoRailPayload) =>
          activeRevenueReporter.reportRevenueSkippedNoRail(info)
      : undefined);

  // the hosted deposit book joins the rail's own transaction. The
  // explicit callback remains an advanced override that owns its delivery
  // semantics; only the SDK-owned reporter can supply the local-DB outbox.
  const enqueueCreditDeposit =
    !opts.onCreditFunded && activeRevenueReporter
      ? activeRevenueReporter.enqueueDeposit.bind(activeRevenueReporter)
      : undefined;

  // the reclaim's own outbox, on the same terms. Unlike the deposit
  // seam there is no builder-supplied override to defer to — a drain report
  // has no `onCreditFunded` analogue — so it rides the reporter alone.
  const enqueueCreditDrain = activeRevenueReporter
    ? activeRevenueReporter.enqueueCreditDrain.bind(activeRevenueReporter)
    : undefined;
  const enqueueCreditDrawRefund = activeRevenueReporter
    ? activeRevenueReporter.enqueueCreditDrawRefund.bind(activeRevenueReporter)
    : undefined;
  const enqueueCreditDrawRelease = activeRevenueReporter
    ? activeRevenueReporter.enqueueCreditDrawRelease.bind(activeRevenueReporter)
    : undefined;

  unsubscribeTempoSettlementReadiness = opts.tempoSettlementReadiness?.subscribe({
    onBalance: (observation) =>
      activeRevenueReporter && dvmId
        ? activeRevenueReporter.reportTempoSettlementBalance({
            dvmId,
            address: observation.address,
            network: observation.network,
            token: observation.token,
            balanceMicro: observation.balanceMicro.toString(),
            lowBalanceMicro: observation.lowBalanceMicro.toString(),
            checkedAt: observation.checkedAt,
            ready: observation.ready,
          })
        : undefined,
    onFailure: (observation) =>
      activeRevenueReporter && dvmId
        ? activeRevenueReporter.reportTempoSettlementFailure({
            dvmId,
            address: observation.address,
            network: observation.network,
            token: observation.token,
            operation: observation.operation,
            errorClass: observation.errorClass,
            checkedAt: observation.checkedAt,
            ...(observation.balanceMicro !== undefined
              ? { balanceMicro: observation.balanceMicro.toString() }
              : {}),
            ...(observation.channelId ? { channelId: observation.channelId } : {}),
            ...(observation.creditId ? { creditId: observation.creditId } : {}),
            ...(observation.drainId ? { drainId: observation.drainId } : {}),
          })
        : undefined,
  });
  opts.tempoSettlementReadiness?.start();

  // Resolved here rather than inside `DVMServer` so the batch-settlement
  // server — constructed before it, and lazily after it — reads its claim
  // ceiling off the same ledger the payments write to.
  const creditLedger: CreditLedgerLike = opts.creditLedger ?? new MemoryCreditLedger();
  // Expiry extinguishes the undrawn claim on eligible rails; releasing a draw
  // restores available credit instead. Bind the outbox to the ledger so every
  // funding path can reverse a prior expiry release. Sweep even without a reporter:
  // the ledger fact is independent of reporting.
  if (activeRevenueReporter && dvmId) {
    creditLedger.useCreditExpiryReleaseOutbox?.({
      dvmId,
      enqueue: activeRevenueReporter.enqueueCreditExpiryRelease.bind(activeRevenueReporter),
    });
  }
  creditExpirySweep = startCreditExpirySweep(creditLedger, opts.creditExpirySweep);
  const processedPayments = opts.processedPayments ?? new MemoryProcessedPaymentStore();

  const bootX402Support = opts.x402
    ? (opts.x402FacilitatorHealth?.support() ?? configuredX402FacilitatorSupport(opts.x402))
    : undefined;
  const x402Config = opts.x402;
  const x402BatchConfig = x402Config?.batchSettlement;
  const selfRelayEnabled = !!x402BatchConfig?.selfRelay;
  const effectiveX402BatchConfig = x402BatchConfig?.selfRelay
    ? {
        ...x402BatchConfig,
        selfRelay: {
          ...x402BatchConfig.selfRelay,
          onBalance: async (observation: X402SelfRelayBalanceObservation) => {
            if (activeRevenueReporter && dvmId) {
              await activeRevenueReporter.reportX402SelfRelayGasBalance({
                dvmId,
                address: observation.address,
                network: observation.network,
                balanceWei: observation.balanceWei.toString(),
                lowBalanceWei: observation.lowBalanceWei.toString(),
                checkedAt: observation.checkedAt,
              });
            }
            await x402BatchConfig.selfRelay?.onBalance?.(observation);
          },
          onRpcHealth: async (observation: X402SelfRelayRpcHealthObservation) => {
            if (activeRevenueReporter && dvmId) {
              await activeRevenueReporter.reportX402SelfRelayRpcHealth({
                dvmId,
                ...observation,
              });
            }
            await x402BatchConfig.selfRelay?.onRpcHealth?.(observation);
          },
        },
      }
    : x402BatchConfig;

  // Build the ledger gate independently of facilitator availability: draws read
  // durable settlement state without a facilitator. Initialize its table before
  // fail-closed reads. Share the store with the settlement factory to keep one pool.
  x402ChannelStorage =
    opts.db && x402Config && effectiveX402BatchConfig && !effectiveX402BatchConfig.storage
      ? new PostgresX402ChannelStorage(opts.db, {
          ...(opts.hostingControl ? { hostedNetwork: x402Config.network } : {}),
          terminalizeUnbackedCredit: (evidence, tx) =>
            creditLedger.terminalizeX402Credit(evidence, tx),
        })
      : undefined;
  if (x402ChannelStorage) {
    await x402ChannelStorage.init();
    creditLedger.useX402SettlementGate?.(x402ChannelStorage);
  }

  const x402BatchSettlementFactory =
    x402Config && effectiveX402BatchConfig
      ? () =>
          createX402BatchSettlementServer({
            channelStorage: x402ChannelStorage,
            network: x402Config.network,
            payTo: x402Config.payTo,
            facilitator: x402Config.facilitator,
            ...(x402Config.facilitatorAuth ? { facilitatorAuth: x402Config.facilitatorAuth } : {}),
            config: effectiveX402BatchConfig,
            db: opts.db,
            allowInMemory: opts.devMode,
            earnedNative: (channelId) => creditLedger.earnedNativeForX402Channel(channelId),
            supportedResponse: selfRelayEnabled
              ? undefined
              : opts.x402FacilitatorHealth?.supportedResponse?.(),
            payout: payoutReporter?.x402Observer(),
            hostedObligations: hostedSettlementReports,
          })
      : undefined;
  x402BatchSettlement =
    x402BatchSettlementFactory && (bootX402Support?.batchSettlement || selfRelayEnabled)
      ? await x402BatchSettlementFactory()
      : undefined;
  // Exact settlement recovery is a durable production primitive. Dev servers
  // without Postgres retain the legacy in-process exact path; a memory intent
  // would advertise recovery that disappears on the process failure it exists
  // to survive. The connect check also keeps query-only test doubles on that
  // legacy path.
  const x402ExactStore =
    x402Config && opts.db && typeof opts.db.connect === "function"
      ? new PostgresX402ExactSettlementStore(opts.db)
      : undefined;
  await x402ExactStore?.init();
  const x402ExactEvidence =
    x402Config && x402ExactStore
      ? await createX402SettlementEvidenceReader({
          network: x402Config.network,
          ...(x402BatchConfig?.rpcUrl ? { rpcUrl: x402BatchConfig.rpcUrl } : {}),
        })
      : undefined;
  const x402ExactSettlement =
    x402Config && x402ExactStore
      ? new X402ExactSettlementServer({
          store: x402ExactStore,
          evidence: x402ExactEvidence,
          repair: async (effect, receipt, tx) => {
            if (!receipt.txHash) throw new Error("settled exact x402 intent has no transaction");
            await repairX402ExactSettlementEffect({
              effect,
              paymentId: receipt.txHash,
              ledger: creditLedger,
              processedPayments,
              enqueueCreditDeposit,
              tx,
            });
          },
        })
      : undefined;

  if (opts.hostingControl) {
    if (!opts.db || !opts.dvmId || !(opts.jobStore instanceof PostgresJobStore)) {
      throw new Error("Hosting control requires a Postgres pool, dvmId, and PostgresJobStore");
    }
    if (descriptor.credit && !opts.creditLedger?.durable) {
      throw new Error("Hosting control with credit requires a durable credit ledger");
    }
    const channelReader = await HostedChannelEvidenceReader.fromServerConfig(opts.db, {
      ...(x402BatchConfig && x402ChannelStorage && x402Config ? { x402: {
        network: x402Config.network,
        ...(x402BatchConfig.rpcUrl ? { rpcUrl: x402BatchConfig.rpcUrl } : {}),
      } } : {}),
      ...(opts.hostingTempoSessionStore && opts.mpp ? { tempoEnv: opts.env } : {}),
    });
    hostingControl = new HostingControl(opts.db, opts.dvmId, opts.hostingControl, channelReader);
    await hostingControl.init();
    if (opts.hostingCleanupSingleMount ?? true) {
      if (opts.creditLedger instanceof CreditLedger) {
        opts.creditLedger.useHostingCleanupFence(hostingControl.cleanupFence);
      }
      opts.jobStore.useHostingCleanupFence(hostingControl.cleanupFence);
      x402ExactStore?.useHostingCleanupFence(hostingControl.cleanupFence);
      x402ChannelStorage?.useHostingCleanupFence(hostingControl.cleanupFence);
      opts.hostingTempoSessionStore?.useHostingCleanupFence(hostingControl.cleanupFence);
      opts.hostingTempoChargeStore?.useHostingCleanupFence(hostingControl.cleanupFence);
      if (opts.mpp && opts.hostingTempoChargeStore) {
        installHostedTempoChargeGuard(opts.mpp, opts.hostingTempoChargeStore);
      }
      if (opts.mpp && opts.hostingTempoSessionStore && hostedSettlementReports) {
        installHostedTempoCloseGuard(opts.mpp, hostedSettlementReports);
      }
    }
  }
  const hostingClosureSupport: HostingClosureSupport | undefined = hostingControl ? {
    singleMount: opts.hostingCleanupSingleMount ?? true,
    durableLedger: opts.creditLedger instanceof CreditLedger,
    durableJobStore: opts.jobStore instanceof PostgresJobStore,
    durableReporter: !!activeRevenueReporter,
    durablePaymentReplay: processedPayments instanceof PostgresProcessedPaymentStore,
    knownRailStores: (opts.hostingCleanupKnownRailStores ?? !opts.mpp) &&
      (!x402Config || (!!x402ExactStore && (!x402BatchConfig || !!x402ChannelStorage))),
  } : undefined;
  server = new DVMServer(descriptor, {
    ...opts,
    platformUrl,
    hostingControlInstance: hostingControl,
    hostedSettlementReports,
    hostingClosureSupport,
    creditLedger,
    processedPayments,
    onJobCompleted: effectiveOnJobCompleted,
    onJobCost: effectiveOnJobCost,
    onJobTerminal: activeRevenueReporter?.reportTerminal.bind(activeRevenueReporter),
    onPaidJobDeath: effectiveOnPaidJobDeath,
    onRevenueSkippedNoRail: effectiveOnRevenueSkippedNoRail,
    onCreditFunded: opts.onCreditFunded,
    enqueueCreditDeposit,
    enqueueCreditDrain,
    enqueueCreditDrawRelease,
    enqueueCreditDrawRefund,
    x402BatchSettlement,
    x402BatchSettlementFactory,
    x402ExactSettlement,
    payoutReporter,
  });
  // Close the terminal-row-to-cost-outbox crash window before boot returns.
  // The reporter was initialized above, so a successful callback means the
  // recovered payload is already in its durable queue; JobManager keeps a
  // periodic pass running for crashes on sibling machines after this boot.
  await server.jobManager.recoverTerminalCosts();
  return {
    app: server.app,
    authAudience: server.authAudience,
    shutdown,
    jobManager: server.jobManager,
    revenueReporterActive: !!activeRevenueReporter,
    payoutReporter,
  };
  } catch (initializationError) {
    // A mount that never returns cannot publish its shutdown callback to the
    // host, so it must unwind its own partially initialized resources here.
    // Preserve the useful construction failure if teardown also rejects.
    await shutdown().catch(() => undefined);
    throw initializationError;
  }
}

/**
 * Hono env for the SDK's DVM app. `unknownRoute` is set by
 * {@link unknownRouteNotFound} so the `dvm.request` span can classify a 404 as
 * scanner-probe noise vs a registered route's own 404.
 *
 * Exported as a type only, for route modules split out of this file
 * (`credit-routes.ts`) — a type-only import erases at compile time, so it
 * introduces no runtime cycle back into `app.ts`.
 */
export interface AppEnv {
  Variables: {
    requesterId: string;
    unknownRoute?: boolean;
    clientCompatibility?: ClientCompatibility;
  };
}

interface RequestRecoveryJobStore extends JobStore {
  findJobByRequestId(requestId: string, requesterPubkey: string): Promise<JobRecord | undefined>;
  claimRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined>;
  resumeRequestId(claim: RequestIdClaim): Promise<RequestIdClaimResult | undefined>;
  releaseRequestIdClaim(claim: RequestIdClaim): Promise<void>;
}

/**
 * `notFound` handler for paths that match no registered route — scanner probes
 * (`GET /robots.txt`, `/.env`, …). Tags the request context so the `dvm.request`
 * span downgrades the 404 to `warn`-level probe noise instead of
 * crowding out real errors in a `--level error` sweep, and returns a
 * machine-parseable JSON 404 (Hono's default is plain text). Registered on both
 * the DVM app (standalone `createDVMServer`) and the host app (mounted path):
 * `app.route()` discards a sub-app's notFound handler, so the host owns it in
 * production.
 *
 * Takes a loosely-typed `Context` because the host app is a bare `Hono` — the
 * reader side (`c.get("unknownRoute")` on {@link AppEnv}) stays typed.
 */
export function unknownRouteNotFound(c: Context): Response {
  c.set("unknownRoute", true);
  return c.json({ error: "not_found" }, 404);
}

class DVMServer<State, InputSchema extends ZodLike | undefined> {
  readonly app: Hono<AppEnv>;
  readonly jobManager: JobManager<State, InputSchema>;
  readonly mintHealthTracker?: MintHealthTracker;

  private readonly descriptor: DVMDescriptor<State, InputSchema>;
  private readonly opts: InternalSDKServerOpts;
  /** Validated `DVMKIT_PUBLIC_URL` origin, or request-derived URLs when absent. */
  private readonly publicOrigin: string | undefined;
  private readonly consumedCredentialStore: ConsumedCredentialStore;
  private readonly adminCashuNonceStore: ConsumedCredentialStore;
  private readonly ownsMintHealthTracker: boolean;
  private readonly fxFetcher: FxFetcher;
  /**
   * The currency this DVM prices in and denominates its credit ledger in,
   * resolved once at construction.
   *
   * `configureDVM` and the CLI loader both resolve this field. The server is
   * also exported for direct JavaScript callers, so defaulting at the one
   * boundary every denomination surface reads remains cheap defence-in-depth
   * for a value forced past the public descriptor contract.
   */
  private readonly pricingCurrency: string;
  /**
   * Last-good lock-pubkey state observed from Postgres. Used as the
   * fallback when `loadLockPubkeyState` throws — degrades more gracefully than
   * falling back to the env-derived seed, which post-rotation is the *retired*
   * pubkey. Null until the first successful read.
   */
  private cachedLockPubkeyState: LockPubkeyState | null = null;
  private tempoSweepInFlight = false;
  private tempoSweepLastAttemptMs = 0;
  private readonly receiptIssuer?: ReceiptIssuer;
  private readonly creditLedger: CreditLedgerLike;
  private readonly processedPayments: ProcessedPaymentStore;
  readonly authAudience?: SignedRequestAudience;
  /** Lazily constructed when a refreshed facilitator probe gains batch support. */
  private x402BatchSettlement?: X402BatchSettlementServer;
  /** Coalesces concurrent requests that first observe batch support. */
  private x402BatchSettlementInit?: Promise<X402BatchSettlementServer>;
  private readonly x402ExactSettlement?: X402ExactSettlementServer;
  /** Withdraws this mount's Tempo session capability from the poll. */
  private undeclareSessionCapability?: () => void;
  private hostingSweepTimer?: ReturnType<typeof setInterval>;
  private readonly diagnosticCapabilityAuthority: DiagnosticCapabilityAuthority;

  constructor(descriptor: DVMDescriptor<State, InputSchema>, opts: InternalSDKServerOpts) {
    this.descriptor = descriptor;
    this.diagnosticCapabilityAuthority = createDiagnosticCapabilityAuthority(
      Object.keys(descriptor.capabilities),
    );
    this.pricingCurrency = (descriptor.currency as string | undefined) ?? "usd";
    this.opts = opts;
    this.publicOrigin = resolvePublicOrigin(opts.env.DVMKIT_PUBLIC_URL);
    this.authAudience = this.resolveAuthAudience();
    this.x402BatchSettlement = opts.x402BatchSettlement;
    this.x402ExactSettlement = opts.x402ExactSettlement;
    this.consumedCredentialStore =
      opts.consumedCredentialStore ?? new MemoryConsumedCredentialStore();
    this.adminCashuNonceStore = opts.adminCashuNonceStore ?? createAdminCashuNonceStore();
    const fxEnv = opts.env as Record<string, string | undefined>;
    // route the env-derived source through `resolveFxSourceFromEnv` so
    // the platform-injected `DVMKIT_FX_SOURCE="platform"` resolves to
    // an authenticated `PlatformFxSource` rather than being passed verbatim as a
    // URL string — `createFxFetcher({ source: "platform" })` would `fetch("platform")`
    // and throw `Failed to parse URL from platform`, surfacing as `fx_rate_unavailable`.
    this.fxFetcher = opts.fxFetcher ?? createFxFetcher({ source: resolveFxSourceFromEnv(fxEnv) });
    // Validate the declared denomination against the fetcher's supported currencies
    // at boot; a valid code can still be unsupported by this rate source.
    const fxCurrencies = this.fxFetcher.supportedCurrencies();
    if (!fxCurrencies.includes(this.pricingCurrency)) {
      throw new Error(
        `createDVMServer: this DVM prices in ${JSON.stringify(this.pricingCurrency)} ` +
          `(DVMConfig.currency) but its fx fetcher only quotes [${fxCurrencies.join(", ")}]. ` +
          `Wire a fetcher that carries it — createFxFetcher({ currencies: [..., ` +
          `${JSON.stringify(this.pricingCurrency)}] }) — or price in one of the above.`
      );
    }
    assertCapabilityRates(descriptor.capabilities);
    // runtime mint-health tracker. Drive `/v1/info` filtering and
    // receive-time gating. Caller-supplied trackers (test seam, or a single
    // shared tracker across multiple sub-DVMs in one process) are used as-is;
    // otherwise we own the lifecycle and start it once construction succeeds.
    if (opts.mintHealthTracker) {
      this.mintHealthTracker = opts.mintHealthTracker;
      this.ownsMintHealthTracker = false;
    } else if (opts.mints && opts.mints.length > 0) {
      this.mintHealthTracker = new MintHealthTracker({ mints: opts.mints, env: opts.env });
      this.ownsMintHealthTracker = true;
    } else {
      this.ownsMintHealthTracker = false;
    }
    // the receipt issuer's existence is the "this DVM signs
    // receipts" switch — it gates both terminal-path issuance and the
    // `/v1/info#receipts` advertisement, so the two can't disagree. Built once
    // here so the key is validated at boot rather than at the first terminal.
    this.receiptIssuer = opts.receiptKey
      ? new ReceiptIssuer({
          secret: opts.receiptKey,
          dvm: this.receiptDvmSlug(),
          dvmId: this.receiptDvmId(),
        })
      : undefined;
    this.creditLedger = opts.creditLedger ?? new MemoryCreditLedger();
    this.opts.mpp?.useTempoCreditLedger?.(this.creditLedger, async (drain, evidence) => {
      const completed = await completeTempoChannelDrain({
        deps: { ledger: this.creditLedger, drainReport: {
          db: this.opts.db, dvmId: this.opts.dvmId, enqueueCreditDrain: this.opts.enqueueCreditDrain,
        } },
        creditId: drain.creditId, drainId: drain.drainId, channelId: drain.channelId!,
        refundedNative: evidence.refundedNative, debitedNative: drain.drainedNative,
        reference: evidence.reference,
        finalization: { outcome: evidence.creditUnbacked ? `${evidence.outcome}_unbacked` : evidence.outcome,
          creditUnbacked: evidence.creditUnbacked },
      });
      if (!completed.replayed && this.receiptIssuer) {
        const receipt = this.receiptIssuer.issueDrain({
          creditId: drain.creditId, drainId: drain.drainId, event: "sent", method: drain.method,
          amountMicro: drain.amountMicro, balanceAfterMicro: drain.balanceAfterMicro,
          ledgerSeq: drain.ledgerSeq, callerPubkey: drain.callerPubkey,
        });
        await this.creditLedger.appendDrainReceipt({ creditId: drain.creditId, drainId: drain.drainId,
          receipt: receipt as unknown as Record<string, unknown> });
      }
      return !completed.replayed;
    });
    this.processedPayments = opts.processedPayments ?? new MemoryProcessedPaymentStore();
    this.jobManager = new JobManager(descriptor, {
      receiptIssuer: this.receiptIssuer,
      creditLedger: this.creditLedger,
      env: opts.env,
      store: opts.store,
      mints: opts.mints,
      jobStore: opts.jobStore,
      devMode: opts.devMode,
      // Use the same derived rail list as discovery/upfront payment; otherwise
      // default-configured rails vanish from mid-job asks. Availability is rechecked
      // per ask.
      paymentMethods: (opts.paymentMethods ?? this.defaultPaymentMethods()).filter(
        (method) => method !== "x402" || this.x402CurrencySupported()
      ),
      x402: opts.x402,
      x402ExactSettlement: this.x402ExactSettlement,
      x402FacilitatorHealth: opts.x402FacilitatorHealth,
      mpp: opts.mpp,
      cashuMode: opts.cashuMode,
      lockPubkey: opts.lockPubkey,
      disposableCashu: opts.disposableCashu,
      db: opts.db,
      dvmId: opts.dvmId,
      authAudience: this.authAudience,
      fxFetcher: this.fxFetcher,
      // the mid-job top-up leg needs the same rail wiring the upfront
      // path gets — a divergence here would be a DVM whose upfront payment funds
      // a credit and whose mid-job payment silently doesn't.
      processedPayments: this.processedPayments,
      enqueueCreditDeposit: opts.enqueueCreditDeposit,
      enqueueCreditDrawRelease: opts.enqueueCreditDrawRelease,
      creditTtlMs: descriptor.credit ? descriptor.credit.ttlSeconds * 1000 : undefined,
      pricingCurrency: this.pricingCurrency,
      onCreditFunded: opts.onCreditFunded,
      onJobCompleted: opts.onJobCompleted,
      onPaidJobCompleted: opts.onPaidJobCompleted,
      paymentMode: opts.paymentMode,
      onJobCost: opts.onJobCost,
      onJobTerminal: opts.onJobTerminal,
      onPaidJobDeath: opts.onPaidJobDeath,
      onRevenueSkippedNoRail: opts.onRevenueSkippedNoRail,
      onJobRetentionSweepFailed: opts.onJobRetentionSweepFailed,
      onJobRetentionSweepRecovered: opts.onJobRetentionSweepRecovered,
      reactivationClaimGraceMs: opts.reactivationClaimGraceMs,
    });
    this.app = new Hono<AppEnv>();
    try {
      this.registerRoutes();
      if (opts.hostingControlInstance) {
        this.hostingSweepTimer = setInterval(() => {
          void this.sweepHostingDeadline().catch((error: unknown) => {
            diagnosticConsole.error("Hosting deadline sweep failed:", error);
          });
        }, 1000);
        this.hostingSweepTimer.unref();
        void this.sweepHostingDeadline().catch((error: unknown) => {
          diagnosticConsole.error("Hosting deadline sweep failed:", error);
        });
      }
      if (this.ownsMintHealthTracker) this.mintHealthTracker?.start();
      // Refresh after declaring capabilities: host boot primes the client before
      // mounts exist, and a traffic-idle process may otherwise keep that empty probe.
      if (this.opts.tempoObserverHealth?.declareSessionCapability) {
        this.undeclareSessionCapability =
          this.opts.tempoObserverHealth.declareSessionCapability(() =>
            this.tempoSessionCapability()
          );
        void this.opts.tempoObserverHealth.refresh?.();
      }
    } catch (error) {
      try {
        this.jobManager.shutdown();
      } catch {}
      try {
        if (this.ownsMintHealthTracker) this.mintHealthTracker?.stop();
      } catch {}
      try {
        this.undeclareSessionCapability?.();
      } catch {}
      this.undeclareSessionCapability = undefined;
      throw error;
    }
  }

  /**
   * Tear down this mount. Every leg is synchronous except the batch-settlement
   * server's own `stop()`; the returned promise settles once that has finished,
   * so a caller holding a resource behind it — the settlement pool the spend
   * gate's store owns — can sequence its close instead of pulling it
   * out from under an in-flight stop. A rejection remains observable so the app
   * and host teardown layers can finish later cleanup before surfacing it.
   */
  shutdown(): Promise<void> {
    if (this.hostingSweepTimer) clearInterval(this.hostingSweepTimer);
    this.jobManager.shutdown();
    // A settlement server still being constructed owns the same pool the moment
    // it resolves, so stop that one too rather than only what is already built.
    const settlement = this.x402BatchSettlementInit ?? Promise.resolve(this.x402BatchSettlement);
    const stopped = settlement.then((s) => s?.stop());
    if (this.ownsMintHealthTracker) this.mintHealthTracker?.stop();
    // the health client outlives a single mount on a multi-DVM host,
    // so a torn-down capability must stop voting in its OR.
    this.undeclareSessionCapability?.();
    this.undeclareSessionCapability = undefined;
    return stopped;
  }

  private async sweepHostingDeadline(): Promise<void> {
    const control = this.opts.hostingControlInstance;
    if (!control) return;
    const status = await control.status();
    const store = this.jobManager.store;
    if (!(store instanceof PostgresJobStore)) return;
    for (const jobId of status.activeJobIds) {
      if (await control.dispatchDeadlineReached(jobId) &&
        await store.cancelJobForHosting(jobId, "Hosting drain deadline reached")) {
        await this.jobManager.finalizeStoredTerminal(jobId);
      }
    }
  }

  private async handleHostingCommand(c: Context<AppEnv>, statusOnly: boolean): Promise<Response> {
    const control = this.opts.hostingControlInstance;
    if (!control) return c.json({ error: "not_found" }, 404);
    let command: HostingControlCommand;
    try {
      command = await c.req.json<HostingControlCommand>();
    } catch {
      return c.json({ error: "invalid_hosting_control" }, 400);
    }
    if (!command || (statusOnly ? command.action !== "status" :
      command.action !== "drain" && command.action !== "resume")) {
      return c.json({ error: "invalid_hosting_control" }, 400);
    }
    if (!(await control.authorize(command, c.req.header("X-DVM-Hosting-Signature")))) {
      return c.json({ error: "hosting_control_unauthorized" }, 401);
    }
    if (!statusOnly && command.action === "resume") await this.sweepHostingDeadline();
    if (!statusOnly && await control.transition(command) === "conflict") {
      return c.json({ error: "hosting_generation_conflict" }, 409);
    }
    if (!statusOnly) await this.sweepHostingDeadline();
    return c.json(await control.status());
  }

  private async handleHostingClosure(c: Context<AppEnv>, certificateOnly: boolean): Promise<Response> {
    const control = this.opts.hostingControlInstance;
    const support = this.opts.hostingClosureSupport;
    if (!control || !support) return c.json({ error: "not_found" }, 404);
    let command: HostingClosureCommand;
    try {
      command = await c.req.json<HostingClosureCommand>();
    } catch {
      return c.json({ error: "invalid_hosting_closure" }, 400);
    }
    if (!command || command.action !== (certificateOnly ? "certificate" : "close")) {
      return c.json({ error: "invalid_hosting_closure" }, 400);
    }
    if (!(await control.authorizeClosure(command, c.req.header("X-DVM-Hosting-Signature")))) {
      return c.json({ error: "hosting_closure_unauthorized" }, 401);
    }
    if (!certificateOnly && await control.close(command, support) === "conflict") {
      return c.json({ error: "hosting_closure_conflict" }, 409);
    }
    // Close obligations otherwise resolve only on the traffic-driven sweep, and
    // an unresolved one withholds the certificate from a DVM being shut down.
    await this.opts.mpp?.reconcileTempoSessionCloses?.().catch(() => {
      diagnosticConsole.warn({ level: "tempo_routine_sweep_failed", dvm_id: this.opts.dvmId, error: undefined });
    });
    const evidence = await control.certificate({ ...command, action: "certificate" }, support);
    if (!evidence) return c.json({ error: "hosting_closure_stale" }, 409);
    return c.json(evidence);
  }

  private registerRoutes(): void {
    const dvmSlug = this.descriptor.name;
    this.app.use("*", async (c, next) => {
      const raw = c.req.header("traceparent");
      const parsed = raw ? parseTraceparent(raw) : null;
      const traceCtx: TraceContext = {
        traceId: parsed ? parsed.traceId : randomUUID().replace(/-/g, ""),
        spanId: parsed ? parsed.parentSpanId : null,
        dimensions: {},
        service: `isolate-${dvmSlug}`,
        flags: parsed?.flags ?? 1,
        diagnosticCapabilityAuthority: this.diagnosticCapabilityAuthority,
      };
      return withTraceContext(traceCtx, async () => {
        if (this.opts.dvmId) pinDimension("dvm_id", this.opts.dvmId);
        pinDimension("dvm_slug", dvmSlug);
        await next();
      });
    });

    // Additive compatibility metadata is advisory until an individual route
    // declares a requirement. The parsed values are request telemetry, not an
    // authenticated caller identity; signed-request auth remains separate.
    this.app.use("*", clientCompatibilityMiddleware());

    // entry-level span for every isolate HTTP request. Wraps the
    // full request lifecycle so even pre-handler failures (auth, validation,
    // payment) appear in the trace. Skips /health and internal /_* routes.
    this.app.use("*", async (c, next) => {
      if (c.req.path === "/health" || c.req.path === "/healthz" || c.req.path.startsWith("/_"))
        return next();

      let statusCode = 200;
      let errorCode: string | undefined;
      let errorMsg: string | undefined;
      // set when the 404 came from `unknownRouteNotFound` (no
      // registered route matched) — a scanner probe, not a caller-meaningful
      // failure like an unknown job id on `/v1/job/:id`.
      let probe = false;

      await withSpan(
        {
          dataset: "isolate",
          name: "dvm.request",
          attrs: {
            "http.method": c.req.method,
            "http.route": c.req.path,
            ...clientCompatibilityAttributes(
              c.get("clientCompatibility") ?? {
                capabilities: [],
                present: { client: false, protocolVersion: false, capabilities: false },
                valid: { client: true, protocolVersion: true, capabilities: true },
              }
            ),
          },
          inspect: () => {
            const attrs: Record<string, unknown> = { "http.status_code": statusCode };
            if (errorCode) attrs["error.code"] = errorCode;
            if (probe) attrs["http.probe"] = true;
            if (statusCode >= 400) {
              // Probe 404s stay `status: "error"` (still countable / non-2xx,
              // unchanged alerting) but log at `warn` so `--level error` incident
              // sweeps aren't drowned in `/robots.txt`-style internet noise.
              return {
                status: "error",
                errorMessage: errorMsg ?? `HTTP ${statusCode}`,
                attrs,
                ...(probe ? { level: "warn" as const } : {}),
              };
            }
            return { attrs };
          },
        },
        async () => {
          await next();
          statusCode = c.res.status;
          if (statusCode >= 400) {
            probe = c.get("unknownRoute") === true;
            try {
              const cloned = c.res.clone();
              const body = (await cloned.json()) as Record<string, unknown>;
              if (typeof body.error === "string") errorCode = body.error;
              else if (typeof body.error === "object" && body.error !== null) {
                const code = (body.error as Record<string, unknown>).code;
                if (typeof code === "string") errorCode = code;
              }
              errorMsg =
                typeof body.message === "string"
                  ? body.message
                  : typeof body.display === "string"
                    ? body.display
                    : typeof body.error === "object" &&
                        body.error !== null &&
                        typeof (body.error as Record<string, unknown>).message === "string"
                      ? String((body.error as Record<string, unknown>).message)
                      : undefined;
            } catch {
              /* non-JSON response — leave fields undefined */
            }
          }
        }
      );
    });

    const customHealth = this.opts.healthHandler;
    this.app.get(
      "/health",
      customHealth ? (c) => customHealth(c) : (c) => c.json({ status: "ok" })
    );
    // Deploy provenance — public, unauthenticated (registered before the auth
    // middleware). Reports the live machine's baked gitSha / deployedAt at
    // parity with the platform and router. This is what
    // makes the proxied `<slug>.example.com/healthz` reflect the DVM's own commit
    // instead of the router's. Read per-request to match /v1/info's
    // sdk_sha; `deployedAt` is "unknown" on images built before BUILD_TIME was
    // threaded into the DVM build args.
    this.app.get("/healthz", (c) =>
      c.json({
        ok: true,
        // shortSha, not .slice(0, 7): a dirty-tree deploy bakes a `-dirty`
        // marker that a raw truncation would cut off the end,
        // leaving this endpoint claiming a clean commit while /v1/info's
        // untruncated sdk_sha says otherwise — same image, two answers.
        gitSha: shortSha(this.opts.env.GIT_SHA ?? "unknown"),
        deployedAt: this.opts.env.BUILD_TIME ?? "unknown",
        deployId: this.opts.env.DVMKIT_DEPLOY_ID ?? "unknown",
      })
    );
    if (this.opts.devMode) {
      this.app.use("*", cors());
      this.app.get("/_dev", (c) => c.html(devPageHtml(this.descriptor.name)));
      this.app.all("/_proxy/*", (c) => this.handleProxy(c));
    }
    this.registerTempoCloseEventRoute();
    this.app.notFound(unknownRouteNotFound);
    this.registerAuthMiddleware();
    this.app.get("/v1/info", (c) => this.handleInfo(c));
    this.app.post("/v1/quote", (c) => this.handleQuote(c));
    this.app.post("/v1/job", (c) => this.handleCreateJob(c));
    if (this.opts.hostingControlInstance) {
      this.app.post("/_hosting/control", (c) => this.handleHostingCommand(c, false));
      this.app.post("/_hosting/status", (c) => this.handleHostingCommand(c, true));
      this.app.post("/_hosting/closure", (c) => this.handleHostingClosure(c, false));
      this.app.post("/_hosting/closure-certificate", (c) => this.handleHostingClosure(c, true));
    }
    this.app.post("/v1/request-resume/:requestId", (c) => this.handleCreateJob(c, true));
    this.app.post("/v1/request-result/:requestId", (c) => this.handleRequestResult(c));
    this.app.get("/v1/job/:id", (c) => this.handleGetJob(c));
    this.app.get("/v1/job/:id/messages", (c) => this.handleGetMessages(c));
    this.app.post("/v1/job/:id/messages", (c) => this.handlePostMessage(c));
    this.app.delete("/v1/job/:id", (c) => this.handleDeleteJob(c));
    // Registered unconditionally: a DVM that doesn't offer credit
    // answers `credit_not_supported` with relayable copy, which tells an agent
    // "pay per call instead" — a bare 404 would read as "wrong URL" and invite
    // a retry loop.
    this.app.post("/v1/credit", (c) => this.handleCredit(c));
    // Builder admin auth belongs to the persisted lock identity, independent
    // of whether this DVM accepts Cashu. Accumulator routes retain their
    // stricter mode gate; generic credit repair routes need only the identity.
    if (this.opts.db && this.opts.dvmId && this.opts.lockPubkey) {
      const db = this.opts.db;
      const dvmId = this.opts.dvmId;
      const payoutReporter = this.opts.payoutReporter;
      const accumulatorWired = this.opts.cashuMode === "p2pk-accumulator";
      if (accumulatorWired) {
        // The builder-local melt loop pulls batches, verifies proofs are SPENT
        // at the mint, and transitions accumulator rows. Nothing in this route
        // family is meaningful without accumulator persistence.
        installAdminCashuRoutes(this.app, {
          db,
          dvmId,
          getLockPubkeyState: () => this.loadActiveLockPubkeyState(db, dvmId),
          graceSeconds: this.graceSeconds(),
          nonceStore: this.adminCashuNonceStore,
          ...(payoutReporter ? { onMelted: payoutReporter.meltHook() } : {}),
        });
      }
      // The drain and repair surface shares builder-lock auth. `park-drain`
      // enforces the accumulator capability itself so callers get a typed
      // refusal while every accumulator-independent route remains available.
      installAdminContentRoutes(this.app, {
        dvmId, store: this.jobManager.store, retentionDays: this.descriptor.jobRetentionDays,
        getLockPubkeyState: () => this.loadActiveLockPubkeyState(db, dvmId), nonceStore: this.adminCashuNonceStore,
      });
      installAdminCreditRoutes(this.app, {
        db,
        dvmId,
        ledger: this.creditLedger,
        fxFetcher: this.fxFetcher,
        getLockPubkeyState: () => this.loadActiveLockPubkeyState(db, dvmId),
        nonceStore: this.adminCashuNonceStore,
        accumulatorWired,
        receiptIssuer: this.receiptIssuer,
        creditTtlMs: () => this.creditTtlMs(),
        creditCurrency: () => this.creditCurrency(),
        enqueueCreditDrawRefund: this.opts.enqueueCreditDrawRefund,
        enqueueCreditDeposit: this.opts.enqueueCreditDeposit,
        enqueueCreditDrain: this.opts.enqueueCreditDrain,
        requireDrainReport: !!this.opts.platformUrl,
        lightningReceive: this.opts.lightningReceive,
        // x402 repair queue rides the same surface, and resolves
        // the rail the same lazy way the verify path does — constructing the
        // settlement server probes the facilitator, which must not happen just
        // because the admin routes were mounted.
        x402BatchSettlement: () => this.resolveX402BatchSettlement(),
        x402ExactSettlement: this.x402ExactSettlement,
        // Tempo repair queue, same surface again. The mppx handle is
        // already built by the time routes mount, so the thunk is uniformity
        // rather than laziness — and it is the *handle*, not the store, so a
        // DVM wired with an in-memory session store resolves to a rail with no
        // close-intent read and the verbs answer 503.
        tempoDrainRail: () => Promise.resolve(this.opts.mpp),
        ...(this.opts.hostedSettlementReports ? {
          hostedSettlementReports: { store: this.opts.hostedSettlementReports },
        } : {}),
        // Health-filtered, and read per request rather than captured: the
        // servicer picking a mint to buy a refund at wants the list that
        // excludes a mint currently failing its probe.
        mints: () => this.advertisedMints(),
        ...(payoutReporter ? { onTempoDrainReconciled: payoutReporter.tempoRepairHook() } : {}),
      });
    }
  }

  private graceSeconds(): number {
    return this.opts.lockPubkeyGraceSeconds ?? DEFAULT_LOCK_PUBKEY_GRACE_SECONDS;
  }

  /**
   * Load the live lock-pubkey state for this DVM. Reads from
   * `dvm_lock_pubkeys` on every call so rotations propagate without needing
   * a process restart. On success the result is cached so a later
   * DB outage can degrade to the last-observed state instead of the
   * env-derived seed (which post-rotation is the *retired* pubkey).
   */
  private async loadActiveLockPubkeyState(db: Pool, dvmId: string): Promise<LockPubkeyState> {
    const state = await loadLockPubkeyState(db, dvmId, this.graceSeconds() * 1000);
    this.cachedLockPubkeyState = state;
    return state;
  }

  /**
   * Mid-job and upfront receive paths use current plus grace-period retired keys.
   * Without accumulator mode this is undefined and the receive path refuses it.
   */
  private async resolveLockPubkeysForReceive(): Promise<LockPubkey[] | undefined> {
    if (this.opts.disposableCashu && this.opts.lockPubkey) return [toLockPubkey(this.opts.lockPubkey)];
    if (
      this.opts.cashuMode !== "p2pk-accumulator" ||
      !this.opts.db ||
      !this.opts.dvmId ||
      !this.opts.lockPubkey
    ) {
      return undefined;
    }
    try {
      const active = await this.lockPubkeyStateForRead(this.opts.db, this.opts.dvmId);
      return activePubkeySet(active);
    } catch {
      return undefined;
    }
  }

  /**
   * Read Postgres first, then fall back to last-observed state, then the env seed.
   * Caching avoids reverting an observed rotation to the old seed during an outage.
   */
  private async lockPubkeyStateForRead(db: Pool, dvmId: string): Promise<LockPubkeyState> {
    try {
      return await this.loadActiveLockPubkeyState(db, dvmId);
    } catch {
      if (this.cachedLockPubkeyState) return this.cachedLockPubkeyState;
      if (this.opts.lockPubkey) return { current: toLockPubkey(this.opts.lockPubkey), retired: [] };
      throw new Error("no lock pubkey state available");
    }
  }

  /**
   * Opportunistic traffic avoids a timer that keeps an idle machine awake. Forced
   * close servicing is independent. Fire-and-forget, one sweep at a time; failures
   * are logged. The throttle bounds scans, not each channel's settlement schedule.
   */
  private maybeSweepTempoSessions(): void {
    const sweep = this.opts.mpp?.sweepTempoSessions;
    if (!sweep || this.tempoSweepInFlight) return;
    const now = Date.now();
    if (now - this.tempoSweepLastAttemptMs < TEMPO_ROUTINE_SWEEP_MIN_INTERVAL_MS) return;
    this.tempoSweepLastAttemptMs = now;
    this.tempoSweepInFlight = true;
    void sweep()
      .then((result) => {
        // `inFlight` counts too: a sweep that settled nothing because the
        // close-event path already held the lease is the guard doing
        // its job, and it is the only signal that says so.
        if (result.settled > 0 || result.closeRequested > 0 || result.inFlight > 0) {
          diagnosticConsole.info(
            {
              level: "tempo_routine_sweep",
              dvm_id: this.opts.dvmId,
              ...result,
            }
          );
        }
      })
      .catch((_err: unknown) => {
        diagnosticConsole.warn(
          {
            level: "tempo_routine_sweep_failed",
            dvm_id: this.opts.dvmId,
            error: undefined,
          }
        );
      })
      .finally(() => {
        this.tempoSweepInFlight = false;
      });
  }

  /**
   * Whether one advertised MPP method may still be offered.
   *
   * Only `tempo/session` is gated, and only when this DVM is platform-hosted:
   * a session channel is safe to accept exactly while something is watching
   * the chain for its close, and on a hosted DVM that something is the
   * platform's observer. `tempo/charge` moves money outright with no channel
   * to close, so it is never withheld — which is what keeps a DVM sellable
   * through an observer outage.
   *
   * A self-hosted DVM has no `tempoObserverHealth` wired and is unaffected:
   * operating a close watcher and fee-funded operator is the self-hosted
   * builder's own responsibility.
   */
  private tempoSessionOffered(method: { method: string; intent: string }): boolean {
    return this.tempoSessionWithheldReason(method) === undefined;
  }

  private tempoSessionWithheldReason(method: {
    method: string;
    intent: string;
  }): TempoSessionWithheldReason | undefined {
    if (method.method !== "tempo" || method.intent !== "session") return undefined;
    if (this.opts.tempoSettlementReadiness && !this.opts.tempoSettlementReadiness.available()) {
      return "settlement_unhealthy";
    }
    if (this.opts.tempoObserverHealth && !this.opts.tempoObserverHealth.available()) {
      return "observer_unhealthy";
    }
    return undefined;
  }

  private async ensureTempoSessionHealth(): Promise<void> {
    await Promise.all([
      this.opts.tempoObserverHealth?.ensureFresh?.(),
      this.opts.tempoSettlementReadiness?.ensureFresh(),
    ]);
  }

  /**
   * Report configured session capability independently of current availability.
   * A temporary observer outage must not remove the platform's watch signal.
   * Credit menu, auth and session method configuration still gate that capability.
   */
  private tempoSessionCapability(): boolean {
    if (!this.opts.mpp) return false;
    if (
      !creditMenuConfigured({
        runtime: "container",
        config: this.descriptor.credit,
        hasAuth: !!this.descriptor.auth,
        ledger: this.creditLedger,
        devMode: this.opts.devMode,
      })
    ) {
      return false;
    }
    return advertisedMethods(this.opts.mpp).some(
      (method) => method.method === "tempo" && method.intent === "session"
    );
  }

  /**
   * Unauthenticated wake carrying only an event locator. After parsing, verify
   * the receipt from the DVM's own RPC, including chain, escrow, topic and local
   * channel ownership before settlement. The observer needs no spending secret.
   * Syntactically valid requests can still consume unthrottled provider RPC quota;
   * malformed locators return 400 before that read.
   */
  private registerTempoCloseEventRoute(): void {
    const mpp = this.opts.mpp;
    const settle = mpp?.settleTempoSessionChannel;
    const getBinding = mpp?.getTempoSessionBinding;
    const getReceipt = mpp?.getTempoReceipt;
    if (!settle || !getBinding || !getReceipt) return;

    this.app.post("/_internal/tempo-close-event", async (c) => {
      const locator = parseTempoCloseEventLocator(await c.req.json().catch(() => null));
      if (!locator) {
        return c.json({ status: "refused", reason: "malformed_locator" }, 400);
      }
      const recoveryDeadlineMs = Date.now() + TEMPO_CLOSE_DB_RECOVERY_BUDGET_MS;
      const recoverPostgres = <value>(channelId: string, operation: () => Promise<value>) =>
        withPostgresRecoveryContext(
          {
            route: "tempo_close_event",
            channelId,
            deadlineMs: recoveryDeadlineMs,
            drainPool: true,
          },
          operation
        );
      const result = await handleTempoCloseEvent(locator, {
        fetchReceipt: ({ chainId, txHash }) => getReceipt({ chainId, txHash }),
        getBinding: (channelId) => recoverPostgres(channelId, () => getBinding(channelId)),
        settle: (channelId) => recoverPostgres(channelId, () => settle(channelId)),
      });
      // `/_*` paths are excluded from the request span, so this log is the
      // DVM-side record of every close event it was asked to act on.
      diagnosticConsole.info(
        {
          level: "tempo_close_event",
          dvm_id: this.opts.dvmId,
          chain_id: locator.chainId,
          tx_hash: locator.txHash,
          log_index: locator.logIndex,
          ...(result.status === "ok"
            ? {
                outcome: result.outcome.outcome,
                channel_id: result.outcome.channelId,
                ...(result.outcome.outcome === "retryable_failure" && {
                  error: undefined,
                }),
              }
            : { outcome: result.status, reason: result.reason }),
        }
      );
      return c.json(
        result.status === "ok"
          ? { status: "ok", ...serializeTempoSettlementOutcome(result.outcome) }
          : {
              status: result.status,
              reason: result.reason,
              ...(result.status === "refused" &&
                result.channelId && { channel_id: result.channelId }),
            },
        tempoCloseEventStatus(result)
      );
    });
  }

  private registerAuthMiddleware(): void {
    // Caller identity on the protocol surface is anonymous-by-default; the only
    // real auth is the descriptor-level secp256k1 signed-request slot
    // (`descriptor.auth`), wired separately on `/v1/job` + `/v1/quote`. devMode
    // gets a fixed test requesterId so e2e jobs are owner-stable.
    this.app.use("*", async (c, next) => {
      c.set("requesterId", this.opts.devMode ? "dev-anonymous" : "anonymous");
      return next();
    });
  }

  /**
   * Options override environment per field. Emit only when pubkey, attestation
   * and signature all exist; malformed attestation JSON omits the block.
   */
  private builderAttestationBlock(): {
    pubkey: string;
    attestation: Record<string, unknown>;
    signature: string;
  } | null {
    const builder = this.opts.builder;
    const env = this.opts.env as Record<string, string | undefined>;
    const pubkey = builder?.pubkey ?? env.DVMKIT_BUILDER_PUBKEY;
    const signature = builder?.signature ?? env.DVMKIT_BUILDER_SIGNATURE;
    const attestation = builder?.attestation
      ? ({ ...builder.attestation } as Record<string, unknown>)
      : this.parseAttestationFromEnv(env);
    if (!pubkey || !signature || !attestation) return null;
    return { pubkey, attestation, signature };
  }

  /** Audience and concrete operation a v2 caller proof must name. */
  private signedRequestDomain(c: Context<AppEnv>, capability: string | null): SignedRequestDomain {
    if (!this.authAudience) throw new AuthAudienceError();
    return {
      audience: this.authAudience,
      method: c.req.method,
      path: canonicalRequestPath(c.req.url),
      capability,
    };
  }

  /** Resolve the signed audience from the verified builder attestation. */
  private resolveAuthAudience(): SignedRequestAudience | undefined {
    if (!this.descriptor.auth) return undefined;
    const identity = attestedDvmIdentity(this.builderAttestationBlock());
    if (identity) {
      return { dvm_id: identity.dvmId, builder_pubkey: identity.builderPubkey };
    }
    // Tests and local dev have no deploy pipeline. Give them a deterministic,
    // explicitly non-production audience; hosted/non-dev boots must carry the
    // real attestation so callers never sign for a self-asserted target.
    if (this.opts.devMode || process.env.NODE_ENV === "test") {
      const dvmId = this.opts.dvmId ?? `dev:${this.descriptor.name}`;
      return {
        dvm_id: dvmId,
        builder_pubkey: createHash("sha256").update(`dvmkit-dev:${dvmId}`).digest("hex"),
      };
    }
    throw new AuthAudienceError();
  }

  /**
   * The slug every receipt is stamped with. Read off the signed
   * attestation payload, which is the only place the *attested* slug lives —
   * a receipt claiming a different name than the attestation binds would be
   * unverifiable. Falls back to the descriptor name for dev/self-host boots
   * with no attestation, where nothing is attested anyway.
   */
  private receiptDvmSlug(): string {
    const attestation = this.builderAttestationBlock()?.attestation;
    const slug = attestation?.slug;
    return typeof slug === "string" && slug.length > 0 ? slug : this.descriptor.name;
  }

  private receiptDvmId(): string {
    const attestation = this.builderAttestationBlock()?.attestation;
    const dvmId = attestation?.dvm_id;
    return typeof dvmId === "string" && dvmId.length > 0
      ? dvmId
      : (this.opts.dvmId ?? this.descriptor.name);
  }

  private parseAttestationFromEnv(
    env: Record<string, string | undefined>
  ): Record<string, unknown> | null {
    const raw = env.DVMKIT_BUILDER_ATTESTATION;
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Owner display block for `/v1/info#owner`. Resolved from
   * `opts.owner` or env vars injected by the platform deploy pipeline.
   * Returns null when no owner identity is configured — pre-unification
   * DVMs that haven't been redeployed omit the block.
   */
  private ownerDisplayBlock(): {
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    type: string;
  } | null {
    const owner = this.opts.owner;
    const env = this.opts.env as Record<string, string | undefined>;
    const handle = owner?.handle ?? env.DVMKIT_OWNER_HANDLE;
    if (!handle) return null;
    const type = owner?.type ?? env.DVMKIT_OWNER_TYPE ?? "builder";
    const displayName =
      owner?.displayName ??
      env.DVMKIT_OWNER_DISPLAY_NAME ?? null;
    const avatarUrl =
      owner?.avatarUrl ??
      env.DVMKIT_OWNER_AVATAR_URL ?? null;
    return { handle, display_name: displayName, avatar_url: avatarUrl, type };
  }

  private defaultPaymentMethods(): PaymentMethod[] {
    const methods: PaymentMethod[] = [];
    if (this.opts.mints?.length) {
      const accumulatorReady =
        this.opts.cashuMode === "p2pk-accumulator" && !!this.opts.lockPubkey && (!!this.opts.db || !!this.opts.disposableCashu);
      if (accumulatorReady) methods.push("cashu");
    }
    if (this.opts.x402 && this.x402CurrencySupported()) methods.push("x402");
    if (this.opts.mpp) methods.push("tempo");
    return methods;
  }

  private x402Support(): X402FacilitatorSupport | undefined {
    if (!this.opts.x402) return undefined;
    const support =
      this.opts.x402FacilitatorHealth?.support() ??
      configuredX402FacilitatorSupport(this.opts.x402);
    if (!this.opts.x402.batchSettlement?.selfRelay) return support;
    return { ...support, batchSettlement: true };
  }

  private x402CurrencySupported(): boolean {
    return this.pricingCurrency === "usd";
  }

  /**
   * Settleable rails for this DVM, honouring an explicit `opts.paymentMethods`
   * override and otherwise deriving from wired rails. Single source of truth so
   * the `/v1/info` and `/v1/quote` rail enumerations can't drift.
   */
  private resolvePaymentMethods(): PaymentMethod[] {
    const configured = this.opts.paymentMethods ?? this.defaultPaymentMethods();
    const currencyFiltered = configured.filter(
      (method) => method !== "x402" || this.x402CurrencySupported()
    );
    if (!this.opts.x402) return currencyFiltered;
    const x402Available = this.x402CurrencySupported() && (this.x402Support()?.available ?? false);
    return currencyFiltered.filter((method) => method !== "x402" || x402Available);
  }

  /**
   * Rails a **credit top-up** may arrive on — the funding menu's list
   * A superset of {@link resolvePaymentMethods}, and deliberately
   * a separate read: `lightning` funds a credit but is not an attached-proof
   * wire method, so it must never reach `/v1/info` or `/v1/quote`'s
   * `payment.methods`.
   *
   * The rail drops out of the funding menu when the receive wallet is unreachable;
   * advertising it then would hand the caller an option that
   * fails on use, while the other rails would have closed the sale.
   */
  private resolveFundingMethods(): FundingMethod[] {
    // A one-shot MPP `charge` can fund the durable credit ledger even when the
    // reusable session optimization is unavailable. The distinction belongs
    // in the `credit.mpp.methods` menu, not in the top-level funding rail.
    //
    // x402 exact follows the hosted facilitator's health through
    // `resolvePaymentMethods`. A healthy batch server is an independent credit
    // funding leg, though: mainnet self-relay must remain usable when hosted
    // exact is unavailable or stale. Which flavour to use rides
    // {@link creditX402Schemes}, so this list names the rail when either is live.
    const creditMpp = this.creditMppMethods().length > 0;
    const methods: FundingMethod[] = this.resolvePaymentMethods().filter(
      (method) => method !== "tempo" || creditMpp
    );
    if (
      this.x402CurrencySupported() &&
      this.x402BatchAvailable() &&
      !methods.includes("x402")
    ) {
      methods.push("x402");
    }
    if (this.opts.lightningReceive?.available()) methods.push("lightning");
    return methods;
  }

  private creditMppMethods(): { method: string; intent: "charge" | "session" }[] {
    return this.creditMppSplit().offered;
  }

  /**
   * The credit menu's MPP instruments, split into what is on offer right now
   * and what this DVM is configured for but withholding.
   *
   * The split has to survive into the response rather than being filtered
   * away, because "not offered right now" and "not configured" are different
   * facts with different consequences. The platform's post-deploy `/v1/info`
   * probe reads capability off `methods ∪ withheld` to decide
   * `tempo_session_advertised_at`, and stamping that NULL over a momentary
   * observer blip dropped the DVM out of the close observer's payee fallback
   * until its next container deploy. An agent reading the menu gets the same
   * distinction, and a reason it can relay.
   */
  private creditMppSplit(): {
    offered: { method: string; intent: "charge" | "session" }[];
    withheld: { method: string; intent: "charge" | "session"; reason: string }[];
  } {
    if (!this.opts.mpp) return { offered: [], withheld: [] };
    const configured = advertisedMethods(this.opts.mpp)
      .filter(
        (method): method is { method: string; intent: "charge" | "session" } =>
          method.intent === "charge" || method.intent === "session"
      )
      .sort(
        (left, right) => Number(right.intent === "session") - Number(left.intent === "session")
      );
    return {
      offered: configured.filter((method) => this.tempoSessionOffered(method)),
      withheld: configured.flatMap((method) => {
        const reason = this.tempoSessionWithheldReason(method);
        return reason ? [{ ...method, reason }] : [];
      }),
    };
  }

  /**
   * Which x402 flavours a credit top-up may arrive on — the funding menu's
   * `x402` sub-block. Hosted health buys `exact`; a genuinely wired
   * batch server buys `batch-settlement` independently, including while the
   * hosted facilitator is unavailable or stale.
   *
   * Deliberately synchronous — the lazy construction can throw, and a menu
   * rung must degrade the terms rather than fail the sale. A probe that hasn't
   * answered therefore costs a caller the channel, not the rail.
   */
  private creditX402Schemes(): { scheme: string; network: string }[] {
    const x402 = this.opts.x402;
    const support = this.x402Support();
    if (!this.x402CurrencySupported() || !x402 || !support) return [];
    return [
      ...(support.available ? [{ scheme: X402_EXACT_SCHEME, network: x402.network }] : []),
      ...(this.x402BatchAvailable()
        ? [{ scheme: X402_BATCH_SETTLEMENT_SCHEME, network: x402.network }]
        : []),
    ];
  }

  private x402BatchAvailable(): boolean {
    return (
      !!this.x402Support()?.batchSettlement &&
      !!(this.opts.x402BatchSettlement ?? this.opts.x402BatchSettlementFactory)
    );
  }

  /**
   * Apply any Lightning funding invoice this caller has paid since we last
   * looked — the pull half of pull-based crediting.
   *
   * Called from every authenticated surface where the balance is about to
   * matter: the `/v1/credit` ops and the `/v1/job` submit. Deliberately **not**
   * from `/v1/quote` — a quote moves no money and is the hottest path, so it
   * stays free of wallet I/O; a caller polling their funding is on
   * `/v1/credit` anyway.
   *
   * Cheap by construction: the ledger's pending-invoice read is local and
   * indexed, so the wallet is only consulted when something is genuinely
   * outstanding, and never blocks the request when it fails.
   *
   * The SDK-owned reporter queues each Lightning deposit inside
   * `settleInvoice`'s transaction. The loop below only preserves
   * the explicit `onCreditFunded` override, whose caller owns its durability.
   */
  private async settleLightningFunding(
    callerPubkey: string | undefined,
    creditId?: string
  ): Promise<void> {
    const receive = this.opts.lightningReceive;
    // No verified pubkey ⇒ nothing to settle: an invoice belongs to the caller
    // who signed for it, and `"anonymous"` pools every unauthenticated caller
    // under one identity (see `selectPrimaryCredit`).
    if (!receive || !callerPubkey || callerPubkey === "anonymous") return;
    const settlements = await receive.settlePending(this.creditLedger, {
      callerPubkey,
      creditId,
      creditTtlMs: this.creditTtlMs(),
      dvmId: this.opts.dvmId,
      enqueueCreditDeposit: this.opts.enqueueCreditDeposit,
    });
    for (const { invoice, funding, credit, replayed } of settlements) {
      // A replay moved no money, so the custom callback has nothing to book;
      // the pass that did move it fired once. Without both the funding and
      // current credit row there is not enough durable data to report the
      // amount and expiry truthfully.
      if (replayed || !funding || !credit) continue;
      this.reportCreditDeposit({
        creditId: invoice.creditId,
        callerPubkey: credit.callerPubkey,
        // The payment hash is Lightning's own settlement reference, so it is
        // what keys the deposit — a redelivered report collides rather than
        // double-counts.
        fundingId: invoice.paymentHash,
        rail: "lightning",
        paidMsats: invoice.amountMsats,
        amountMicro: funding.amountMicro,
        currency: invoice.currency,
        fundedAt: invoice.settledAt ?? Date.now(),
        expiryMs: credit.expiryMs,
      });
    }
  }

  private creditTtlMs(): number {
    return this.descriptor.credit
      ? this.descriptor.credit.ttlSeconds * 1000
      : IMPLICIT_CREDIT_TTL_MS;
  }

  private async resolveX402BatchSettlement(): Promise<X402BatchSettlementServer | undefined> {
    if (!this.x402BatchAvailable()) return undefined;
    if (this.x402BatchSettlement) return this.x402BatchSettlement;

    const factory = this.opts.x402BatchSettlementFactory;
    if (!factory) return undefined;

    this.x402BatchSettlementInit ??= factory();
    try {
      this.x402BatchSettlement = await this.x402BatchSettlementInit;
      return this.x402BatchSettlement;
    } finally {
      this.x402BatchSettlementInit = undefined;
    }
  }

  /**
   * The per-DVM + per-request rail wiring every payment verification needs —
   * everything except what the *operation* contributes (its price, its job or
   * fund id, the caller's credit fields). Shared by `/v1/job`'s upfront gate
   * and `/v1/credit`'s top-up so a rail wired into one is wired
   * into both by construction; a divergence here would be a rail that funds
   * jobs but silently can't fund credits.
   */
  private async railVerifyOpts(c: Context<AppEnv>): Promise<UpfrontPaymentOpts> {
    // `tempoSessionOffered` below is fail-closed, and `/v1/credit` is the only
    // surface that issues or accepts a session at all — so give the
    // gate a chance to hold an observation before it decides, exactly as
    // `/v1/info` and the menu do. Skipped on every other path, where a session
    // is confined out anyway and this would only add a cold-start probe to the
    // job hot path.
    if (c.req.path.endsWith("/v1/credit")) {
      await this.ensureTempoSessionHealth();
    }
    // Extract the MPP credential from the `Authorization: Payment <…>` header
    // (spec form) and pass the WHOLE `Payment <…>` scheme string to mppx —
    // `Credential.deserialize` expects the scheme token in front of the
    // base64url payload and rejects a bare payload with MissingPaymentSchemeError.
    // previously this stripped the token (`slice(8)`), which only worked
    // because the client double-prefixed (`Payment Payment <…>`); a spec-conformant
    // peer (mpp-rs) sends a single `Payment <…>` and was wrongly rejected.
    //
    // Use `Credential.extractPaymentScheme` rather than a `startsWith("Payment ")`
    // gate: auth-scheme tokens are case-insensitive per RFC 9110 (mppx's own
    // `deserialize` matches `/^Payment\s+/i`), and a header may carry multiple
    // comma-separated schemes. A strict capitalized-and-space-only gate would drop
    // a conformant peer sending `payment ` or a tab separator — the exact
    // independent-peer mismatch class this rail's conformance check exists to catch.
    const authHeader = c.req.header("Authorization");
    const { Credential } = await import("mppx");
    const mppCredential = authHeader
      ? (Credential.extractPaymentScheme(authHeader) ?? undefined)
      : undefined;
    // Resolve the active lock-pubkey set per-request so a rotation propagates
    // mid-flight without a server restart. The accept path checks
    // the witness against every entry in this array. On a DB outage
    // `lockPubkeyStateForRead` returns the last-good cached state instead of
    // the env-derived seed, so we don't accept proofs locked to the retired
    // pubkey during a transient flap.
    let lockPubkeys: LockPubkey[] | undefined = this.opts.disposableCashu && this.opts.lockPubkey
      ? [toLockPubkey(this.opts.lockPubkey)] : undefined;
    if (
      this.opts.cashuMode === "p2pk-accumulator" &&
      this.opts.db &&
      this.opts.dvmId &&
      this.opts.lockPubkey
    ) {
      const active = await this.lockPubkeyStateForRead(this.opts.db, this.opts.dvmId);
      lockPubkeys = activePubkeySet(active);
    }
    const x402Support = this.x402Support();
    const x402BatchSettlement = await this.resolveX402BatchSettlement();
    const x402Payment = this.x402CurrencySupported()
      ? x402Support?.exact.v2 || x402Support?.batchSettlement
        ? c.req.header("PAYMENT-SIGNATURE")
        : undefined
      : (c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT"));
    return {
      cashuToken: c.req.header("X-Cashu"),
      mints: this.opts.mints,
      // Prefer v2 only when the facilitator advertises it; otherwise accept
      // the v1 compatibility header only when that generation is supported.
      x402Payment: x402Payment ?? (x402Support?.exact.v1 ? c.req.header("X-PAYMENT") : undefined),
      x402Config: this.opts.x402,
      x402ExactSettlement: this.x402ExactSettlement,
      x402ExactVersions: x402Support?.exact,
      x402BatchSettlement,
      x402Resource: callerFacingRequestUrl(c.req.url, this.publicOrigin),
      mppCredential,
      mpp: this.opts.mpp,
      resourcePath: c.req.path,
      // the gate covers issuance and new-channel acceptance,
      // not just the two advertisement surfaces. `ensureFresh` above makes this
      // an observation rather than a cold-start default on the one surface that
      // can act on it.
      tempoSessionOffered: this.tempoSessionOffered({ method: "tempo", intent: "session" }),
      tempoSessionUnavailableReason: this.tempoSessionWithheldReason({
        method: "tempo",
        intent: "session",
      }),
      consumedCredentialStore: this.consumedCredentialStore,
      cashuMode: this.opts.cashuMode,
      accumulatorDb: this.opts.cashuMode === "p2pk-accumulator" ? this.opts.db : undefined,
      disposableCashu: this.opts.disposableCashu,
      dvmId: this.opts.dvmId,
      lockPubkeys,
      requestId: c.req.header("X-Cashu-Request-Id"),
      mintHealthTracker: this.mintHealthTracker,
      fxFetcher: this.fxFetcher,
      creditLedger: this.creditLedger,
      processedPayments: this.processedPayments,
      enqueueCreditDeposit: this.opts.enqueueCreditDeposit,
      requesterId: c.get("requesterId"),
      creditTtlMs: this.descriptor.credit ? this.descriptor.credit.ttlSeconds * 1000 : undefined,
    };
  }

  private balancePaymentSupported(includeDisabled = false): boolean {
    return (includeDisabled || this.opts.env.DVMKIT_BALANCE_PAYMENTS !== "false") && !!this.descriptor.credit && !!this.opts.db && this.creditLedger instanceof CreditLedger &&
      this.jobManager.store instanceof PostgresJobStore && !!this.authAudience && !!this.descriptor.auth;
  }

  /**
   * Assemble this DVM's funding menu for a response denominated in
   * `currency`. All the refusal logic — including the credits-spec
   * §3 isolate gate — lives in {@link buildCreditMenu}; this just supplies the
   * server's state. `callerPubkey` must be a *verified* envelope pubkey: the
   * balance echo is per-caller money and there is no safe fallback identity.
   */
  private async creditMenu(
    currency: string,
    callerPubkey?: string
  ): Promise<CreditMenu | undefined> {
    // Same reason as `/v1/info`: `creditMppMethods()` withholds
    // `tempo/session` on an unconfirmed observer, so the confirmation has to
    // have been attempted before the menu is built rather than after.
    await this.ensureTempoSessionHealth();
    const mppSplit = this.creditMppSplit();
    const menu = await buildCreditMenu({
      runtime: "container",
      config: this.descriptor.credit,
      currency,
      funding: this.resolveFundingMethods(),
      tempoMethods: mppSplit.offered,
      tempoWithheld: mppSplit.withheld,
      x402Schemes: this.creditX402Schemes(),
      lightningFundingMinSats: this.opts.lightningReceive?.fundingMinSats,
      // Configured, not advertised: `advertisedMints()` is health
      // filtered, and a rail that comes and goes with a mint's uptime is worse
      // product than one that is honestly absent.
      hasAcceptedMint: (this.opts.mints?.length ?? 0) > 0,
      fxFetcher: this.fxFetcher,
      hasAuth: !!this.descriptor.auth,
      ledger: this.creditLedger,
      devMode: this.opts.devMode,
      callerPubkey,
    });
    if (menu && this.balancePaymentSupported()) menu.balance_payment = true;
    return menu;
  }

  private async handleCredit(c: Context<AppEnv>): Promise<Response> {
    let hostingFundingAdmissionId: string | undefined;
    let hostingFundingArtifactHash: string | undefined;
    this.maybeSweepTempoSessions();
    return handleCreditRequest(c, {
      hostedSettlementReports: this.opts.hostedSettlementReports,
      menu: () => this.creditMenu(this.creditCurrency()),
      creditConfig: this.descriptor.credit,
      auth: this.descriptor.auth,
      authDomain: this.authAudience ? this.signedRequestDomain(c, null) : undefined,
      ledger: this.creditLedger,
      fxFetcher: this.fxFetcher,
      railOpts: async (ctx) => ({
        ...(await this.railVerifyOpts(ctx)),
        hostingAdmissionId: hostingFundingAdmissionId,
        hostingPaymentArtifactHash: hostingFundingArtifactHash,
      }),
      onDeposit: (funding) => {
        this.reportCreditDeposit(funding);
      },
      drainReport: {
        db: this.opts.db,
        dvmId: this.opts.dvmId,
        enqueueCreditDrain: this.opts.enqueueCreditDrain,
      },
      receiptIssuer: this.receiptIssuer,
      lightning: this.opts.lightningReceive ? { receive: this.opts.lightningReceive } : undefined,
      settleLightning: (callerPubkey, creditId) =>
        this.settleLightningFunding(callerPubkey, creditId),
      withFundingAdmission: this.opts.hostingControlInstance
        ? async (ctx, body, run) => {
            const control = this.opts.hostingControlInstance!;
            let admissionId: string = randomUUID();
            const fundId = body.fund?.fund_id ?? admissionId;
            const creditId = body.credit_id ?? derivedFundCreditId(body.pubkey, fundId);
            const workId = `credit-fund:${creditId}:${fundId}`;
            const paymentAuthorization = ctx.req.header("Authorization");
            const mppArtifact = paymentAuthorization
              ? (await import("mppx")).Credential.extractPaymentScheme(paymentAuthorization)
              : undefined;
            const attachedPayment = ctx.req.header("X-Cashu") ?? ctx.req.header("PAYMENT-SIGNATURE") ??
              ctx.req.header("X-PAYMENT") ?? mppArtifact;
            const paymentArtifactHash = attachedPayment
              ? createHash("sha256").update(attachedPayment).digest("hex") : undefined;
            hostingFundingArtifactHash = paymentArtifactHash;
            if (!(await control.admit(admissionId, workId, {
              creditId, fundId, callerPubkey: body.pubkey,
              fundingCommitment: body.fund?.commitment,
              paymentArtifactHash,
            }))) {
              const prior = body.fund?.commitment
                ? await control.acceptedFundingAdmission(
                    creditId, fundId, body.pubkey, body.fund.commitment,
                    paymentArtifactHash
                  ) : undefined;
              if (!prior) {
                return ctx.json({
                  error: "hosting_draining",
                  message: "This service is draining and is not accepting new credit funding.",
                  hint: "Balance, reclaim, and already-issued funding recovery remain available.",
                }, 503);
              }
              admissionId = prior;
            }
            hostingFundingAdmissionId = admissionId;
            const authorization = ctx.req.header("Authorization");
            const paymentArtifact = Boolean(
              ctx.req.header("X-Cashu") || ctx.req.header("PAYMENT-SIGNATURE") ||
              ctx.req.header("X-PAYMENT") || (authorization && /^Payment\s/i.test(authorization))
            );
            let outcome: "accepted" | "failed" | "unresolved" = paymentArtifact ? "unresolved" : "failed";
            try {
              const response = await run();
              if (response.ok || (body.fund?.method === "lightning" &&
                await this.creditLedger.getInvoice({ creditId, fundId }))) outcome = "accepted";
              return response;
            } finally {
              await control.finishAdmission(admissionId, outcome);
            }
          }
        : undefined,
      tempoSettlementReadiness: this.opts.tempoSettlementReadiness,
    });
  }

  /**
   * Currency this DVM's credit ledger is denominated in — the builder's
   * declared pricing currency, `"usd"` unless they said otherwise.
   *
   * Every denomination surface reads this one answer: the funding menu on
   * `/v1/quote` and the 402, `POST /v1/credit`, and the quote balance echo.
   * The rails still pin `priceFiat` per request from the quoted price, but
   * both of its sources are held to this currency — `configureDVM` refuses a
   * static (USD-literal) price on a non-USD DVM, and a quote denominated
   * elsewhere is refused as `quote_currency_mismatch` — so what a job draws in
   * is what a top-up funded in, on every path.
   */
  private creditCurrency(): string {
    return this.pricingCurrency;
  }

  /**
   * Advertise the same method list as info. Refundability describes the rail
   * itself; failed jobs release their pending credit draw separately.
   */
  private quotePaymentBlock(): { methods: PaymentMethod[]; refundable: Record<string, boolean> } {
    const methods = this.resolvePaymentMethods();
    return {
      methods,
      refundable: Object.fromEntries(methods.map((m) => [m, RAIL_REFUNDABLE[m]])),
    };
  }

  private async handleProxy(c: Context<AppEnv>): Promise<Response> {
    const raw = getCookie(c, "dvmkit_target");
    const target = raw ? decodeURIComponent(raw) : null;
    if (!target) return c.json({ error: "no proxy target configured" }, 400);

    const path = c.req.path.replace("/_proxy", "");
    const query = new URL(c.req.url).search;
    const url = target + path + query;

    try {
      const headers: Record<string, string> = {
        "Content-Type": c.req.header("Content-Type") ?? "application/json",
      };
      const jobToken = c.req.header("X-Job-Token");
      if (jobToken) headers["X-Job-Token"] = jobToken;
      const resp = await fetch(url, {
        method: c.req.method,
        headers,
        body: ["GET", "HEAD"].includes(c.req.method) ? undefined : await c.req.text(),
      });
      return new Response(await resp.text(), {
        status: resp.status,
        headers: { "Content-Type": resp.headers.get("Content-Type") ?? "application/json" },
      });
    } catch (err) {
      return c.json({ error: "proxy: " + (err instanceof Error ? err.message : String(err)) }, 502);
    }
  }

  private async handleInfo(c: Context<AppEnv>): Promise<Response> {
    // `info.mpp.methods` below is gated on observer health, and the
    // gate is fail-closed — so give it a chance to have an observation before
    // it decides. Free once one is cached; on a cold start it is one bounded
    // probe, which is cheaper than telling the caller sessions do not exist.
    await this.ensureTempoSessionHealth();
    const info: V1InfoResponse = {
      name: this.descriptor.name,
      description: this.descriptor.description || undefined,
      tags: this.descriptor.tags,
      auth: this.descriptor.auth ? [this.descriptor.auth.id] : ["none"],
      ...(this.authAudience ? { auth_audience: this.authAudience } : {}),
      protocol_version: 1,
      sdk_sha: this.opts.env.GIT_SHA ?? "unknown",
      deploy_id: this.opts.env.DVMKIT_DEPLOY_ID ?? "unknown",
    };
    const ownerBlock = this.ownerDisplayBlock();
    if (ownerBlock) info.owner = ownerBlock;
    // Builder identity attestation block. Served verbatim from the
    // env vars the platform's deploy pipeline injected as Fly secrets — the
    // SDK never re-signs at runtime. Pre-upgrade DVMs that haven't been
    // re-deployed under v0.1.x lack these vars; the block is omitted in that
    // case and consumers fall back to registry trust.
    const builderBlock = this.builderAttestationBlock();
    if (builderBlock) info.builder = builderBlock;
    // Signed receipts. Advertised only when the DVM will actually
    // issue them — a key *and* a store that can allocate sequence numbers and
    // persist bytes write-once (`jobStore` is a public option, so a custom one
    // may satisfy `JobStore` without `ReceiptIssuingStore`; that case also
    // warns at boot). A caller can then distinguish "this job produced no
    // receipt" from "this DVM doesn't issue them" — which is what keeps the
    // isolate-tier gap honest. Whether the signing key is *attested* is read
    // off the `builder` block: its `attestation.receipt_pubkey` is what a
    // receipt chains to.
    if (this.jobManager.receiptsEnabled) info.receipts = true;
    if (this.descriptor.auth && requestRecoveryStore(this.jobManager.store)) {
      info.request_recovery = true;
    }
    const credit = await this.creditMenu(this.creditCurrency());
    if (credit) info.credit = toCreditTerms(credit);
    if (this.opts.mints) info.mints = this.advertisedMints();
    info.capabilities = this.renderCapabilities();
    info.payment = { methods: this.resolvePaymentMethods() };
    if (this.x402CurrencySupported() && this.opts.x402 && this.x402Support()?.available) {
      info.x402 = {
        pay_to: this.opts.x402.payTo,
        network: this.opts.x402.network,
        asset: this.opts.x402.asset ?? "USDC",
        ...(this.opts.x402.facilitator && { facilitator: this.opts.x402.facilitator }),
        // Advertises whether 402 challenges include x402 PaymentRequirements.
        dual_serve: this.opts.x402.dualServe ?? true,
      };
    }
    if (this.opts.mpp) {
      const configured = advertisedMethods(this.opts.mpp);
      const withheld = configured.flatMap((method) => {
        const reason = this.tempoSessionWithheldReason(method);
        return reason ? [{ ...method, reason }] : [];
      });
      info.tempo = {
        // withheld sessions are withheld here too. `/v1/info` is
        // where a caller decides what to attempt, so advertising a session the
        // credit menu will refuse just sends them down a dead end.
        methods: configured.filter((method) => this.tempoSessionOffered(method)),
        // …but say so rather than letting it vanish: an agent that
        // sees only the shortened list cannot tell a DVM that never did
        // sessions from one whose observer is down for a minute.
        ...(withheld.length && { withheld }),
        ...(this.opts.mpp.realm && { realm: this.opts.mpp.realm }),
        ...(this.opts.mpp.tempoConfiguration && {
          recipient: this.opts.mpp.tempoConfiguration.recipient,
          payment_token: this.opts.mpp.tempoConfiguration.paymentToken,
          chain_id: this.opts.mpp.tempoConfiguration.chainId,
          ...(this.opts.mpp.tempoConfiguration.operator && {
            operator: this.opts.mpp.tempoConfiguration.operator,
          }),
          ...(this.opts.mpp.tempoConfiguration.feeToken && {
            fee_token: this.opts.mpp.tempoConfiguration.feeToken,
          }),
        }),
      };
    }
    // Agent-wallet: advertise the P2PK acceptance path.
    // `cashu.lock_pubkeys` is `[current, ...retired_in_grace]` so agents on a
    // stale `/v1/info` cache can still pay during rotation. The dynamic
    // current+retired set is loaded from the DVM's Postgres when a pool is
    // wired; on a transient DB outage `lockPubkeyStateForRead` falls back to
    // the last-good cached state (and only as a last resort to the env seed),
    // so we never advertise a stale pubkey through a flap.
    if (
      this.opts.cashuMode === "p2pk-accumulator" &&
      this.opts.mints &&
      this.opts.mints.length > 0 &&
      this.opts.lockPubkey
    ) {
      // Health-filter here too: mirror the top-level `info.mints`
      // so a sick / NUT-incompatible mint is never advertised in the P2PK
      // block either. `advertisedMints()` falls back to the transiently-sick
      // mints (never NUT-incompatible ones) when nothing is healthy, so the
      // rail stays published through a flap without republishing a broken mint.
      const mints = this.advertisedMints();
      const active: LockPubkeyState =
        this.opts.db && this.opts.dvmId
          ? await this.lockPubkeyStateForRead(this.opts.db, this.opts.dvmId)
          : { current: toLockPubkey(this.opts.lockPubkey), retired: [] };
      info.cashu = {
        mints,
        lock_pubkeys: activePubkeySet(active),
        lock_pubkey_grace_seconds: this.graceSeconds(),
        min_locktime: 604800,
        canonical_id: this.opts.canonicalDvmId ?? this.opts.dvmId ?? null,
      };
    }
    return c.json(info);
  }

  /**
   * Input-mode JSON Schema keeps defaulted fields optional on the advertised
   * wire contract. Capability names are the descriptor's keys.
   */
  private renderCapabilities(): Record<string, V1InfoCapability> {
    const out: Record<string, V1InfoCapability> = {};
    for (const [name, cap] of Object.entries(this.descriptor.capabilities)) {
      const entry: V1InfoCapability = {};
      if (cap.description) entry.description = cap.description;
      if (cap.input && isZodSchema(cap.input)) {
        // emit input-mode JSON Schema so `.default()` fields stay out
        // of `required` and the advertised contract matches what the server's
        // Zod safeParse/parse actually accepts. Output mode (the Zod 4 default)
        // marks defaulted fields as required because they're guaranteed to be
        // present *after* parsing — wrong story for an input-receiving surface.
        entry.input_schema = toJSONSchema(cap.input as z.ZodType, { io: "input" });
      }
      // builder-supplied example payload. The CLI prefers this over
      // schema-derived placeholders so cross-field refinements (e.g. narrate's
      // text-XOR-dialogue) get a runnable `--data` value instead of `'{}'`.
      if (cap.example !== undefined) entry.example = cap.example as Record<string, unknown>;
      let pricing: V1InfoCapability["pricing"];
      if (cap.onQuote?.schema) {
        const qs = cap.onQuote.schema;
        pricing = {
          quote: {
            schema: isZodSchema(qs) ? toJSONSchema(qs as z.ZodType, { io: "input" }) : qs,
          },
        };
      } else {
        const max = this.jobManager.currentPricingMax(name);
        if (max) pricing = { max };
      }
      // Published verbatim: the construction-time check already holds every
      // entry to the limits independent clients parse, so nothing is rewritten.
      if (cap.rates) pricing = { ...pricing, rates: cap.rates };
      if (pricing) entry.pricing = pricing;
      out[name] = entry;
    }
    return out;
  }

  private async handleQuote(c: Context<AppEnv>): Promise<Response> {
    const parsed = await this.requireJsonBody<{
      capability?: string;
      input?: string;
      params?: Record<string, string>;
      data?: Record<string, unknown>;
    }>(c);
    if ("error" in parsed) return parsed.error;
    const body = parsed.body;
    if (hasInvalidRequestId(body.data)) {
      return c.json(
        {
          error: "invalid_request_id",
          message: "request_id must be 1–128 URL-safe characters.",
        },
        400
      );
    }
    const publicRequestId = requestIdFromEnvelope(body.data);
    if (
      publicRequestId &&
      (!this.descriptor.auth || !requestRecoveryStore(this.jobManager.store))
    ) {
      return c.json(
        {
          error: "request_recovery_unsupported",
          message: "This DVM cannot durably recover public request ids.",
        },
        400
      );
    }

    const capabilityResult = this.requireCapabilityFromBody(c, body.capability);
    if ("error" in capabilityResult) return capabilityResult.error;
    const capabilityName = capabilityResult.name;
    const cap = this.descriptor.capabilities[capabilityName];

    // Builder input errors use the same structured classification as job submit.
    // Envelope-only errors defer to auth; missing structured input is a quote probe.
    let deferredInputError: unknown;
    try {
      await loggers.isolate.span(
        "dvm.input.validate",
        { capability: capabilityName, stage: "input" },
        () => this.jobManager.parseInput(body, capabilityName),
        { onError: () => ({ "error.code": "invalid_input" }) }
      );
    } catch (err) {
      // A body carrying no structured input at all is a price probe, not a
      // schema violation: `dvm quote -d discover/search` (all three input flags
      // are optional) asks "what does this cost?" before the caller has
      // assembled anything to send, and the docs tell them to. `/v1/job` still
      // refuses it — a submit with nothing to run is a mistake — so this is the
      // one place the two endpoints deliberately differ, and only on the input
      // the schema was never shown. converged the *schema-invalid*
      // answer; it does not make quoting conditional on already having a body.
      if (err instanceof MissingStructuredInputError) {
      } else if (!this.deferToAuthGate(err)) {
        return this.invalidInputResponse(c, err);
      } else {
        deferredInputError = err;
      }
    }

    // Quote auth checks signature and drift without committing replay state,
    // so its nonce remains usable for a separately job-bound proof.
    let quotePubkey: string | undefined;
    if (this.descriptor.auth) {
      const auth = this.descriptor.auth;
      try {
        quotePubkey = await loggers.isolate.span(
          "dvm.auth.verify",
          { capability: capabilityName },
          () => {
            if (!cap.input || !isZodSchema(cap.input)) {
              throw new AuthSchemaError();
            }
            return auth.checkAuth(
              cap.input,
              signedRequestInput(body),
              this.signedRequestDomain(c, capabilityName)
            ).pubkey;
          },
          { onError: authVerifyErrorCode }
        );
      } catch (err) {
        if (err instanceof AuthSchemaError) {
          return c.json(
            {
              error: "auth_error",
              sub_reason: "schema_invalid",
              display: "Capability has no input schema to verify against",
              hint: "This DVM declares descriptor-level auth but the capability omits an input schema. Operator must wire one to sign over.",
            },
            500
          );
        }
        if (err instanceof SignedRequestError)
          return buildAuthErrorResponse(c, err, this.publicOrigin);
        throw err;
      }
    }

    // the same backstop `/v1/job` carries — an envelope-side input
    // failure the gate above declined to reject is a disagreement between two
    // parses of one schema, not a quotable request.
    if (deferredInputError !== undefined) {
      return this.invalidInputResponse(c, deferredInputError);
    }

    if (cap.onQuote) {
      const onQuote = cap.onQuote;
      // Select the same raw structured input as auth (data before JSON-string input),
      // then apply the quote schema separately. Authentication does not sign parsed
      // output or schema defaults.
      let data = quoteInputData(body);
      if (isZodSchema(onQuote.schema)) {
        const schema = onQuote.schema;
        // the quote body may carry the credit envelope (the caller
        // signs one body and sends it to both endpoints). It is the protocol's,
        // not the quote schema's — strip before validating, same rule as the
        // capability parse on the submit path.
        const quoteData = stripProtocolEnvelope(schema, data);
        try {
          data = await loggers.isolate.span(
            "dvm.input.validate",
            { capability: capabilityName, stage: "quote" },
            () => {
              const parsed = schema.safeParse(quoteData);
              if (!parsed.success) throw parsed.error;
              return parsed.data;
            },
            { onError: () => ({ "error.code": "invalid_quote_data" }) }
          );
        } catch (err) {
          const schemaUrl = infoSchemaUrl(c.req.url, this.publicOrigin);
          const { message, hint } =
            err instanceof z.ZodError
              ? humanizeZodError(err, { schemaUrl })
              : {
                  message: "Quote-input validation failed",
                  hint: `Inspect ${schemaUrl} for the expected input schema.`,
                };
          return c.json({ error: "invalid_quote_data", message, hint }, 400);
        }
      }
      try {
        const quoteCtx = await this.buildQuoteContext({
          data,
          input: body.input,
          params: body.params,
          callerPubkey: quotePubkey,
        });
        const result = await loggers.isolate.span(
          "dvm.quote",
          { handler: "quote", capability: capabilityName },
          () => onQuote.handler(quoteCtx)
        );
        const validated = validateQuoteResult(result, this.pricingCurrency);
        const res: Record<string, unknown> = {
          upfront: withExactMicro(
            validated.upfront,
            priceFiatMicro({ dynamicUpfront: validated.upfront })
          ),
          description: validated.description,
        };
        if (validated.hint !== undefined) res.hint = validated.hint;
        if (validated.shape !== undefined) res.shape = validated.shape;
        if (validated.rate !== undefined) res.rate = validated.rate;
        if (this.opts.mints) res.mints = this.advertisedMints();
        res.payment = this.quotePaymentBlock();
        // the funding menu rides the same currency the quote is
        // denominated in, so `min_micro`/`max_micro`/`balance_micro` are all
        // comparable to `upfront` without a second conversion. read
        // that currency off the DVM rather than off this response — the
        // validation above has already refused a quote that disagrees, so the
        // two are equal, and sourcing every menu from the one answer is what
        // stops a future call site from reintroducing the split.
        attachCreditMenu(res, await this.creditMenu(this.creditCurrency(), quotePubkey));
        return c.json(res);
      } catch (err) {
        if (err instanceof InvalidQuoteResultError) {
          diagnosticConsole.error("invalid QuoteResult from onQuote:", err);
          return c.json({ error: { code: err.code, message: err.message } }, 500);
        }
        if (err instanceof QuoteCurrencyMismatchError) {
          diagnosticConsole.error("quote currency mismatch:", err);
          return c.json({ error: { code: err.code, message: err.message } }, 500);
        }
        if (err instanceof InvalidCurrencyError) {
          return c.json({ error: { code: "invalid_currency", message: err.message } }, 500);
        }
        const fxErr = pickFxRateUnavailable(err);
        if (fxErr) return c.json({ error: fxErr }, 503);
        // Surface structured errors (`code`+`display`+`hint` on the error or
        // its `cause`) as 400 JSON envelopes so agents can pass `display`
        // straight through to a human caller. Anything unstructured falls
        // back to a 500 with the raw message.
        const structured = pickStructuredError(err);
        if (structured) return c.json({ error: structured }, 400);
        const message = err instanceof Error ? err.message : String(err);
        diagnosticConsole.error("quote handler failed:", err);
        return c.json({ error: { code: "internal", message } }, 500);
      }
    }

    // `pricingMax` is USD, and correctly so: a static price is a USD literal
    // and `configureDVM` refuses one on a DVM that declares another currency,
    // so reaching here at all means this DVM prices in USD. The free branch has
    // no such tie — zero is zero in any denomination — so it takes the DVM's
    // own currency, which is what the funding menu below is in.
    // `pricingMax` is `roundUsd(parseUsdPrice(price))` while the
    // ledger pins `Math.round(parseUsdPrice(price) × 1e6)`. The two agree today
    // only because `parseUsdPrice` refuses a literal finer than four decimals —
    // stating the ledger's own integer alongside the decimal is what stops that
    // coincidence from being load-bearing.
    const pricingMax = this.jobManager.currentPricingMax(capabilityName);
    const res: Record<string, unknown> = pricingMax
      ? {
          upfront: withExactMicro(
            pricingMax,
            priceFiatMicro({ price: typeof cap.price === "string" ? cap.price : undefined })
          ),
          description: cap.description || this.descriptor.description || "Static price",
          shape: "fixed" as const,
        }
      : {
          upfront: { amount: 0, currency: this.pricingCurrency },
          description: "Free",
          shape: "fixed" as const,
        };
    if (this.opts.mints) res.mints = this.advertisedMints();
    res.payment = this.quotePaymentBlock();
    attachCreditMenu(res, await this.creditMenu(this.creditCurrency(), quotePubkey));
    return c.json(res);
  }

  /**
   * Callers supply quote-schema-parsed data when a quote schema exists, alongside
   * raw input text and params. Quote and job pricing share these runtime helpers.
   */
  private async buildQuoteContext(args: {
    data: unknown;
    input?: string;
    params?: Record<string, string>;
    callerPubkey?: string;
  }): Promise<QuoteContext> {
    const ctx: QuoteContext = {
      data: args.data as Record<string, unknown>,
      input: args.input,
      params: args.params,
      env: this.opts.env,
      fetch: createInstrumentedFetch(),
    };
    if (!args.callerPubkey) return ctx;
    ctx.callerPubkey = args.callerPubkey;
    if (!this.descriptor.credit) return ctx;
    const snapshot = await selectPrimaryCredit({
      ledger: this.creditLedger,
      callerPubkey: args.callerPubkey,
      currency: this.creditCurrency(),
    });
    if (snapshot) ctx.credit = toCreditView(snapshot);
    return ctx;
  }

  /**
   * Missing or unknown capabilities return structured errors with the current
   * info-schema URL.
   */
  private requireCapabilityFromBody(
    c: Context<AppEnv>,
    capability: string | undefined
  ): { name: string } | { error: Response } {
    const known = this.jobManager.capabilityNames();
    const infoUrl = infoSchemaUrl(c.req.url, this.publicOrigin);
    if (typeof capability !== "string" || capability.length === 0) {
      return {
        error: c.json(
          {
            error: "capability_required",
            message: 'Request body is missing the required "capability" field.',
            hint: `Set body.capability to one of: ${known.join(", ")}. See ${infoUrl}.`,
          },
          400
        ),
      };
    }
    if (!this.jobManager.hasCapability(capability)) {
      return {
        error: c.json(
          {
            error: "unknown_capability",
            message: `"${capability}" is not a capability of "${this.descriptor.name}".`,
            hint: `Known capabilities: ${known.join(", ")}. See ${infoUrl}.`,
          },
          400
        ),
      };
    }
    return { name: capability };
  }

  /**
   * Parse the request body as JSON, or return a structured 400 the caller can
   * relay verbatim. Without this guard, malformed bodies (probe traffic,
   * Fly-proxy cold-start retries that arrive empty, half-sent requests) fall
   * through to Hono's default handler as 500s — polluting the error-rate
   * metric and dumping a SyntaxError stack trace to the logs.
   */
  // T is used only in the return position so callers get a typed body without
  // a cast at every callsite — ergonomic generic, not a runtime constraint.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  private async requireJsonBody<T>(c: Context<AppEnv>): Promise<{ body: T } | { error: Response }> {
    try {
      return { body: await c.req.json<T>() };
    } catch {
      const infoUrl = infoSchemaUrl(c.req.url, this.publicOrigin);
      return {
        error: c.json(
          {
            error: "invalid_request",
            message: "Request body must be valid JSON.",
            hint: `Send a JSON body with Content-Type: application/json. Inspect ${infoUrl} for the expected request shape.`,
          },
          400
        ),
      };
    }
  }

  /**
   * Shared schema-violation response for quote and submit, including auth-less
   * DVMs. A 400 classifies caller input without requiring an auth gate; `display`
   * and `message` carry the same relayable explanation.
   */
  private invalidInputResponse(c: Context<AppEnv>, err: unknown): Response {
    const schemaUrl = infoSchemaUrl(c.req.url, this.publicOrigin);
    const issues = zodIssuesOf(err);
    if (issues) {
      // Render the caller's half alone when there is one, so a body that is
      // both unsigned and misshapen names the field rather than the envelope —
      // the same input-wins precedence `authErrorBody` applies. An
      // envelope-only failure reaches here on an auth-less DVM, where nothing
      // below would answer it.
      const inputIssues = callerInputIssues(issues);
      const { message, hint } = humanizeZodIssues(inputIssues.length > 0 ? inputIssues : issues, {
        schemaUrl,
      });
      return c.json(
        {
          error: "invalid_input",
          display: `Request input doesn't satisfy the published schema — ${message}`,
          message,
          hint,
        },
        400
      );
    }
    if (err instanceof MissingStructuredInputError) {
      return c.json(
        {
          error: "invalid_input",
          display: "Request carries no structured input to validate",
          message: err.message,
          hint: `Pass structured fields via body.data, or a JSON-encoded body.input. Inspect ${schemaUrl} for the expected shape.`,
        },
        400
      );
    }
    const message = err instanceof Error ? err.message : "Input validation failed";
    return c.json(
      {
        error: "invalid_input",
        display: `Request input couldn't be read — ${message}`,
        message,
        hint: `Inspect ${schemaUrl} for the expected input schema.`,
      },
      400
    );
  }

  /**
   * On authenticated DVMs, envelope-only parse failures defer to auth
   * (401 signature_invalid). Builder input issues remain 400 invalid_input.
   * Auth reparses the same schema/raw input; a backstop refuses disagreement.
   */
  private deferToAuthGate(err: unknown): boolean {
    if (!this.descriptor.auth) return false;
    const issues = zodIssuesOf(err);
    return issues !== undefined && callerInputIssues(issues).length === 0;
  }

  /**
   * Mints to advertise to clients on `/v1/info` and `/v1/quote`. Filters the
   * configured list through the runtime health tracker. When every
   * mint is currently sick it falls back to the still-configured list rather
   * than publish an empty rail — a *transient* outage shouldn't read as "no
   * Cashu" and push well-behaved agents to bypass the rail. But NUT-incompatible
   * mints are excluded even from that fallback: NUT-incompatibility
   * is a permanent, deterministic config error the DVM can never settle
   * against, so such a mint is never advertised. If *every*
   * configured mint is NUT-incompatible the rail correctly goes empty.
   */
  private advertisedMints(): string[] {
    const all = this.opts.mints ?? [];
    if (!this.mintHealthTracker || all.length === 0) return all;
    const tracker = this.mintHealthTracker;
    const healthy = tracker.healthyMints();
    if (healthy.length > 0) return healthy;
    return all.filter((m) => !tracker.isNutIncompatible(m));
  }

  /** Authenticated, read-only recovery of a previously accepted public request id. */
  private async handleRequestResult(c: Context<AppEnv>): Promise<Response> {
    const requestId = c.req.param("requestId");
    const store = requestRecoveryStore(this.jobManager.store);
    if (!isPublicRequestId(requestId) || !this.descriptor.auth || !store) {
      return requestResultNotFound(c, requestId ?? "");
    }

    const parsed = await this.requireJsonBody<{
      capability?: string;
      input?: string;
      params?: Record<string, string>;
      data?: unknown;
    }>(c);
    if ("error" in parsed) return parsed.error;
    const body = parsed.body;
    const capabilityResult = this.requireCapabilityFromBody(c, body.capability);
    if ("error" in capabilityResult) return capabilityResult.error;
    const capabilityName = capabilityResult.name;
    const cap = this.descriptor.capabilities[capabilityName];

    let authPubkey: string;
    try {
      if (!cap.input || !isZodSchema(cap.input)) throw new AuthSchemaError();
      authPubkey = this.descriptor.auth.checkAuth(
        cap.input,
        signedRequestInput(body),
        this.signedRequestDomain(c, capabilityName)
      ).pubkey;
    } catch (error) {
      if (error instanceof AuthSchemaError) {
        return c.json(
          {
            error: "auth_error",
            sub_reason: "schema_invalid",
            display: "Capability has no input schema to verify against",
          },
          500
        );
      }
      if (error instanceof SignedRequestError)
        return buildAuthErrorResponse(c, error, this.publicOrigin);
      throw error;
    }

    const signedRequestId = requestIdFromEnvelope(body.data);
    if (hasInvalidRequestId(body.data) || signedRequestId !== requestId) {
      return requestResultNotFound(c, requestId);
    }

    try {
      this.jobManager.parseInput(body, capabilityName);
    } catch {
      return requestResultNotFound(c, requestId);
    }

    const fingerprint = requestFingerprint(
      { capability: capabilityName, input: body.input, params: body.params, data: body.data },
      { stripAuthEnvelope: true }
    );
    const prior = await store.findJobByRequestId(requestId, authPubkey);
    if (
      prior?.requestId !== requestId ||
      prior.requesterPubkey !== authPubkey ||
      prior.requestFingerprint !== fingerprint ||
      prior.requesterId !== c.get("requesterId")
    ) {
      return requestResultNotFound(c, requestId);
    }

    return buildRequestResultResponse(c, requestId, prior, await this.contentFields(prior));
  }

  private async handleCreateJob(c: Context<AppEnv>, resumeOnly = false): Promise<Response> {
    if (!resumeOnly) this.maybeSweepTempoSessions();
    const parsed = await this.requireJsonBody<{
      capability?: string;
      input?: string;
      params?: Record<string, string>;
      data?: unknown;
    }>(c);
    if ("error" in parsed) return parsed.error;
    const body = parsed.body;
    if (hasInvalidRequestId(body.data)) {
      return c.json(
        {
          error: "invalid_request_id",
          message: "request_id must be 1–128 URL-safe characters.",
        },
        400
      );
    }
    const publicRequestId = requestIdFromEnvelope(body.data);
    const recoveryStore = requestRecoveryStore(this.jobManager.store);
    const resumedRequestId = resumeOnly ? c.req.param("requestId") : undefined;
    if (
      resumeOnly &&
      (!isPublicRequestId(resumedRequestId) || publicRequestId !== resumedRequestId)
    ) {
      return requestNotAccepted(c, resumedRequestId ?? "");
    }
    if (publicRequestId && (!this.descriptor.auth || !recoveryStore)) {
      return c.json(
        {
          error: "request_recovery_unsupported",
          message: "This DVM cannot durably recover public request ids.",
        },
        400
      );
    }

    const capabilityResult = this.requireCapabilityFromBody(c, body.capability);
    if ("error" in capabilityResult) return capabilityResult.error;
    const capabilityName = capabilityResult.name;
    // The dispatcher is the authority on what this request will run. Pin its
    // answer while the entry span is still open so both the `dvm.request` row
    // and every downstream span carry the same capability. Missing/unknown
    // requests return above and remain honestly unattributed.
    pinDimension("capability", capabilityName);
    const cap = this.descriptor.capabilities[capabilityName];

    // Input validation runs first so dynamic-priced capabilities (those that
    // declare `onQuote` instead of a static `price`) can recompute the
    // required price from the parsed input before the upfront-payment gate.
    // Accepts either body.data (structured, preferred) or body.input (legacy
    // JSON-encoded string). See JobManager.parseInput.
    let parsedInput: unknown;
    let deferredInputError: unknown;
    try {
      parsedInput = await loggers.isolate.span(
        "dvm.input.validate",
        { capability: capabilityName, stage: "input" },
        () => this.jobManager.parseInput(body, capabilityName),
        { onError: () => ({ "error.code": "invalid_input" }) }
      );
    } catch (err) {
      if (!this.deferToAuthGate(err)) return this.invalidInputResponse(c, err);
      deferredInputError = err;
    }

    // envelope-level credit fields ride the signed body's `data`
    // (the signed credit contract). Extract them from the RAW wire object — `parseInput` above
    // removed them before the capability schema ran — and refuse
    // structurally broken shapes before auth or payment run. A malformed
    // envelope is stripped like a well-formed one, so it lands here as
    // `invalid_credit_fields` rather than as a schema error blaming the input.
    let creditEnvelope: CreditEnvelope | undefined;
    try {
      creditEnvelope = extractCreditEnvelope(body.data);
    } catch (err) {
      if (err instanceof CreditEnvelopeError) {
        return c.json(
          {
            error: "invalid_credit_fields",
            message: err.message,
            hint: "Send credit_id and draw_id together as non-empty strings; fund (optional) must be { amount_micro, commitment }.",
          },
          400
        );
      }
      throw err;
    }

    // Authenticate before pricing/payment. Replay is committed later, only after
    // payment verifies and immediately before job creation.
    let authEnvelope: CanonicalEnvelope | undefined;
    let authPubkey: string | undefined;
    if (this.descriptor.auth) {
      const auth = this.descriptor.auth;
      // verify over the RAW wire body — never `parsedInput`. The
      // caller signed what they put on the wire, and Zod's parse rewrites it
      // (defaults filled at any depth, transforms applied, undeclared keys
      // dropped), so verifying the parsed form made this endpoint disagree
      // with `/v1/quote` for any schema whose parse isn't an identity. The
      // credit fields the caller signed over need no re-merge for the same
      // reason: they never left. `secp256k1Auth` still removes them for its
      // own schema check, never from the bytes it verifies.
      try {
        const result = await loggers.isolate.span(
          "dvm.auth.verify",
          { capability: capabilityName },
          () => {
            if (!cap.input || !isZodSchema(cap.input)) {
              throw new AuthSchemaError();
            }
            return auth.checkAuth(
              cap.input,
              signedRequestInput(body),
              this.signedRequestDomain(c, capabilityName)
            );
          },
          { onError: authVerifyErrorCode }
        );
        authEnvelope = result.envelope;
        // pinned on the job record so a retried paid submit has to
        // come from the same caller, not just carry the same body.
        authPubkey = result.pubkey;
      } catch (err) {
        if (err instanceof AuthSchemaError) {
          return c.json(
            {
              error: "auth_error",
              sub_reason: "schema_invalid",
              display: "Capability has no input schema to verify against",
              hint: "This DVM declares descriptor-level auth but the capability omits an input schema. Operator must wire one to sign over.",
            },
            500
          );
        }
        if (err instanceof SignedRequestError)
          return buildAuthErrorResponse(c, err, this.publicOrigin);
        throw err;
      }
    }

    // an envelope-side input failure was left to the gate above, and
    // it re-parses the same schema over the same bytes — so reaching here with
    // one means the two parses disagreed. Answer it rather than run the job on
    // an input that never validated.
    if (deferredInputError !== undefined) {
      return this.invalidInputResponse(c, deferredInputError);
    }

    // Normalise body.input so durable replay always has a JSON-encoded string
    // to feed back through parseInput. When the request used body.data,
    // store the pre-Zod form so replay is idempotent — schemas with
    // .transform() must not double-apply on resume. Primitive-input DVMs
    // keep whatever the caller sent (or "" when absent).
    const normalisedBody: { input: string; params?: Record<string, string> } = {
      input: cap.input && body.data !== undefined ? JSON.stringify(body.data) : (body.input ?? ""),
      params: body.params,
    };

    // what this call asks the DVM to do, hashed. Persisted on the
    // job, and the thing a retried paid submit must reproduce to be handed
    // that job back instead of a bare 409.
    const fingerprint = requestFingerprint(
      { capability: capabilityName, input: body.input, params: body.params, data: body.data },
      { stripAuthEnvelope: this.descriptor.auth !== undefined }
    );
    const authFingerprint = this.descriptor.auth
      ? requestFingerprint(
          { capability: capabilityName, input: body.input, params: body.params, data: body.data },
          { stripAuthEnvelope: false }
        )
      : undefined;
    const authorization = c.req.header("Authorization");
    const mppArtifact = authorization
      ? (await import("mppx")).Credential.extractPaymentScheme(authorization)
      : undefined;
    const attachedPayment = c.req.header("X-Cashu") ?? c.req.header("PAYMENT-SIGNATURE") ??
      c.req.header("X-PAYMENT") ?? mppArtifact;
    const hostingPaymentArtifactHash = attachedPayment
      ? createHash("sha256").update(attachedPayment).digest("hex") : undefined;

    // A previously accepted payment artifact may recover its original job
    // while hosting admission is closed. The durable reservation binds the
    // exact artifact to that job; no rail verifier or new settlement runs here.
    if (!resumeOnly && this.opts.hostingControlInstance && hostingPaymentArtifactHash) {
      const priorId = await this.opts.hostingControlInstance.acceptedJobByPaymentArtifactHash(
        hostingPaymentArtifactHash
      );
      const prior = priorId ? await this.jobManager.store.get(priorId) : undefined;
      if (prior && prior.requestFingerprint === fingerprint &&
        prior.requesterId === c.get("requesterId") &&
        (!this.descriptor.auth || prior.requesterPubkey === authPubkey)) {
        await this.jobManager.ensureReceipt(prior);
        return await this.submitResponse(c, prior, prior.requesterToken);
      }
    }
    if (!resumeOnly && this.opts.hostingControlInstance && creditEnvelope && authPubkey) {
      const draw = await this.creditLedger.getDraw({
        creditId: creditEnvelope.creditId, drawId: creditEnvelope.drawId,
      });
      if (draw?.jobId && await this.jobManager.store.get(draw.jobId)) {
        const recovered = await this.recoverDrawnJob(c, {
          creditId: creditEnvelope.creditId, drawId: creditEnvelope.drawId,
          jobId: draw.jobId, fingerprint, callerPubkey: authPubkey,
        });
        if (recovered) return recovered;
      }
    }

    // Bind and lock before pricing and before every rail side effect. The
    // binding survives forever; Postgres owns the live advisory lock, so two
    // machines cannot both reach payment validation and a dead connection
    // cannot strand the request forever. Exact retries reuse the first job id
    // and can therefore pick up a draw committed before the job row landed.
    let publicRequestClaim: RequestIdClaim | undefined;
    let publicRequestClaimResult: RequestIdClaimResult | undefined;
    let hostingAdmissionId: string | undefined;
    let hostingAdmissionAccepted = false;
    let hostingPaymentMayHaveLanded = false;
    if (publicRequestId && authPubkey && recoveryStore) {
      publicRequestClaim = {
        requestId: publicRequestId,
        requesterPubkey: authPubkey,
        requesterId: c.get("requesterId"),
        requestFingerprint: fingerprint,
        jobId: this.jobManager.allocateJobId(),
        claimToken: randomBytes(32).toString("hex"),
      };
      publicRequestClaimResult = resumeOnly
        ? await recoveryStore.resumeRequestId(publicRequestClaim)
        : await recoveryStore.claimRequestId(publicRequestClaim);
      if (!publicRequestClaimResult) {
        return resumeOnly
          ? requestNotAccepted(c, publicRequestId)
          : requestIdExists(c, publicRequestId);
      }
    }

    try {
      // Migration/backstop: jobs written before the claim table existed still
      // own their public ids. Holding the new claim closes the race while this
      // lookup checks the existing unique jobs index.
      if (publicRequestId && authPubkey && recoveryStore) {
        const prior = await recoveryStore.findJobByRequestId(publicRequestId, authPubkey);
        if (prior) {
          return resumeOnly
            ? await this.submitResponse(c, prior, prior.requesterToken)
            : requestIdExists(c, publicRequestId);
        }
      }

      // Resolve the required price. `currentPriceMsats(capability)` only knows
      // about the capability's static `price`. For dynamic-priced capabilities
      // (declared via `onQuote`), re-invoke the quote handler at job-submission
      // time so the upfront-payment gate has a real `requiredMsats` to enforce —
      // without this, dynamic-priced capabilities let unpaid jobs through
      let jobId = publicRequestClaimResult?.jobId ?? this.jobManager.allocateJobId();
      if (!resumeOnly && this.opts.hostingControlInstance) {
        hostingAdmissionId = randomUUID();
        if (!(await this.opts.hostingControlInstance.admit(hostingAdmissionId, jobId, {
          paymentArtifactHash: hostingPaymentArtifactHash,
        }))) {
          return c.json({
            error: "hosting_draining",
            message: "This service is draining and is not accepting new jobs or payments.",
            hint: "Keep any existing job token to fetch its result or reclaim unused credit. Retry a new job after service resumes.",
          }, 503);
        }
      }
      let payment: PaymentInfo = { paidMsats: 0, receivedProofs: [] };
      let resumedAcceptedPayment = false;
      if (resumeOnly) {
        const durableDraw = await this.creditLedger.getDrawByJobId(jobId);
        const recoveredPayment = durableDraw
          ? recordedDrawPayment(durableDraw, {
              dvmId: this.opts.dvmId ?? "",
              ...(creditEnvelope
                ? {}
                : { paymentId: durableDraw.railValue.fundingRef ?? undefined }),
            })
          : undefined;
        if (!recoveredPayment || durableDraw?.status !== "pending") {
          return requestNotAccepted(c, publicRequestId ?? "");
        }
        payment = recoveredPayment;
        resumedAcceptedPayment = true;
      }

      const skipPayment = devModeSkipsPaymentVerification(this.opts);
      let priceMsats = resumeOnly ? payment.paidMsats || undefined : undefined;
      if (!resumeOnly && !skipPayment) {
        try {
          priceMsats = await this.jobManager.currentPriceMsats(capabilityName);
        } catch (err) {
          const fxErr = pickFxRateUnavailable(err);
          if (fxErr) return c.json({ error: fxErr }, 503);
          throw err;
        }
      }
      let dynamicUpfront: { amount: number; currency: string } | undefined;
      // A static price takes precedence when a capability also declares onQuote.
      if (!resumeOnly && cap.price === undefined && priceMsats === undefined && cap.onQuote) {
        const dyn = await this.computeDynamicPrice(
          cap.onQuote,
          parsedInput,
          normalisedBody,
          authPubkey,
          skipPayment
        );
        if (dyn.error) return c.json(dyn.error.body, dyn.error.status);
        priceMsats = dyn.priceMsats;
        dynamicUpfront = dyn.upfront;
      }

      // pin the price's fiat denomination from the same quote surface
      // that produced `priceMsats` — the ledger is fiat-micro denominated, and
      // pinning here keeps fresh fx lookups out of the rail verify path.
      const priceFiat = resumeOnly
        ? undefined
        : resolvePriceFiat({
            price: typeof cap.price === "string" ? cap.price : undefined,
            priceMsats,
            dynamicUpfront,
          });

      // this submit is the caller's "next request", so it is what
      // drives pull-based Lightning crediting — a top-up they paid a moment ago
      // lands on the ledger here, before the draw is attempted, rather than
      // refusing a job whose money already arrived. Costs one indexed SELECT
      // when nothing is outstanding, and never fails the submit.
      if (!resumeOnly && creditEnvelope?.creditId) {
        await this.settleLightningFunding(authPubkey, creditEnvelope.creditId);
      }

      let replayedDraw: { creditId: string; drawId: string; jobId: string | null } | undefined;
      if (!resumeOnly && publicRequestClaimResult?.replayed) {
        const durableDraw = await this.creditLedger.getDrawByJobId(jobId);
        if (durableDraw) {
          const recoveredPayment = recordedDrawPayment(durableDraw, {
            dvmId: this.opts.dvmId ?? "",
            requiredMsats: priceMsats,
            // Implicit per-call payments use their funding reference as the
            // job settlement reference. An explicit prepaid draw uses its own
            // per-draw reference so sibling jobs never collide in revenue.
            ...(creditEnvelope ? {} : { paymentId: durableDraw.railValue.fundingRef ?? undefined }),
          });
          if (recoveredPayment && durableDraw.status === "pending") {
            payment = recoveredPayment;
            resumedAcceptedPayment = true;
          }
        }
      }
      if (!skipPayment && !resumedAcceptedPayment) {
        const railOpts = await this.railVerifyOpts(c);
        hostingPaymentMayHaveLanded = Boolean(
          creditEnvelope || railOpts.cashuToken || railOpts.x402Payment || railOpts.mppCredential
        );
        try {
          payment = await loggers.isolate.span(
            "dvm.payment.validate",
            { capability: capabilityName, required_msats: priceMsats },
            async () => {
              const result = await verifyUpfrontPayment({
                ...railOpts,
                hostingAdmissionId,
                hostingPaymentArtifactHash,
                requiredMsats: priceMsats,
                priceFiat,
                jobId,
                requestFingerprint: fingerprint,
                requestAuthFingerprint: authFingerprint,
                callerPubkey: authPubkey,
                creditEnvelope,
              });
              if (result.error) {
                throw new PaymentValidationError(result.error);
              }
              if (result.replayedDraw) replayedDraw = result.replayedDraw;
              // the funding is a deposit and it is committed *now* —
              // report it here rather than at the job terminal, because a
              // funding whose job later fails (or never gets created, e.g. the
              // `recordReplay` fail-closed below) is still money we hold.
              this.reportCreditDeposit(result.funding);
              return result;
            },
            {
              onError: (err) =>
                err instanceof PaymentValidationError
                  ? { "error.code": String(err.detail.body.error) }
                  : undefined,
            }
          );
        } catch (err) {
          if (err instanceof PaymentValidationError) {
            // an explicit short fund-and-draw can commit its deposit
            // but still refuse the draw with `insufficient_credit`. The money
            // remains the caller's liability, so report it on the error path
            // just like JobManager does for a short mid-job top-up.
            this.reportCreditDeposit(err.detail.funding);
            // a short payment we kept and settled on the spot. No job
            // exists to carry it, so book it here under a synthetic id, tagged
            // `short_pay_forfeit` so it stays out of per-job service revenue.
            this.reportShortPayForfeit(err.detail.forfeit);
            // Replay recovery requires the original request binding, not just spent proofs.
            // Header-keyed rail markers and explicit draw keys remain separate regimes;
            // try the draw key when a marker cannot resolve an explicitly funded job.
            if (err.detail.body.error === "replay_rejected") {
              const recovered = await this.recoverReplayedJob(c, {
                requestId: err.detail.replayPaymentId ?? c.req.header("X-Cashu-Request-Id"),
                fingerprint,
                callerPubkey: authPubkey,
              });
              if (recovered) return recovered;
              if (creditEnvelope) {
                const drawRecovered = await this.recoverDrawnJob(c, {
                  creditId: creditEnvelope.creditId,
                  drawId: creditEnvelope.drawId,
                  jobId: null,
                  fingerprint,
                  callerPubkey: authPubkey,
                });
                if (drawRecovered) return drawRecovered;
              }
              if (publicRequestClaimResult && err.detail.replayPaymentId) {
                const recoveredPayment = await this.recoverProcessedPaymentAcceptance({
                  paymentId: err.detail.replayPaymentId,
                  jobId: publicRequestClaimResult.jobId,
                  requiredMsats: priceMsats,
                });
                if (recoveredPayment) {
                  payment = recoveredPayment;
                  resumedAcceptedPayment = true;
                }
              }
            }
            if (!resumedAcceptedPayment) {
              // Attach the prepaid menu in this request's ledger denomination, including
              // free requests that have no priceFiat.
              attachCreditMenu(
                err.detail.body,
                await this.creditMenu(this.creditCurrency(), authPubkey)
              );
              // Return the same price_micro and required_msats used for this request's
              // funding ratio; a second quote may use a different FX snapshot.
              if (priceFiat) {
                err.detail.body.price_micro = priceFiat.amountMicro;
                err.detail.body.price_currency = priceFiat.currency;
              }
              return buildPaymentErrorResponse(
                err.detail.body,
                err.detail.mppChallenges,
                err.detail.x402Requirements,
                err.detail.status,
                err.detail.x402V2Requirements,
                undefined,
                this.x402Support()?.exact,
                err.detail.x402ErrorCode
              );
            }
          }
          throw err;
        }
      }

      // the signed body's (credit_id, draw_id) matched a recorded
      // draw — the explicit idempotency regime. Apply the same proof-of-origin
      // gates as the header regime and re-issue the original job's response;
      // anything short of proof falls to the 409.
      if (replayedDraw) {
        const recovered = await this.recoverDrawnJob(c, {
          ...replayedDraw,
          fingerprint,
          callerPubkey: authPubkey,
        });
        if (recovered) return recovered;
        if (publicRequestClaimResult) {
          const recoveredPayment = await this.recoverDrawAcceptance({
            ...replayedDraw,
            expectedJobId: publicRequestClaimResult.jobId,
            requiredMsats: priceMsats,
          });
          if (recoveredPayment) {
            payment = recoveredPayment;
            replayedDraw = undefined;
          }
        }
      }
      if (replayedDraw) {
        return buildPaymentErrorResponse(
          paymentErrorBody("draw_conflict", {
            message:
              "Draw already recorded, and the retry did not prove it is the original request.",
          }),
          undefined,
          undefined,
          409
        );
      }

      const exactAdmission = payment.x402ExactAdmission;
      hostingPaymentMayHaveLanded ||= resumedAcceptedPayment || payment.paidMsats > 0 ||
        Boolean(payment.funding || exactAdmission);
      if (exactAdmission) {
        jobId = exactAdmission.jobId;
        if (hostingAdmissionId) {
          await this.opts.hostingControlInstance!.rebindAdmissionJob(hostingAdmissionId, jobId);
        }
        const prior = await this.jobManager.store.get(jobId);
        if (prior) {
          if (
            prior.requestFingerprint !== fingerprint ||
            prior.requesterPubkey !== authPubkey ||
            prior.requesterId !== c.get("requesterId")
          ) {
            throw new Error(`x402 exact job ${jobId} conflicts with its durable admission`);
          }
          await this.x402ExactSettlement?.completeAdmission(
            this.opts.dvmId ?? "",
            exactAdmission.intentId
          );
          await this.jobManager.ensureReceipt(prior);
          return await this.submitResponse(c, prior, prior.requesterToken);
        }
      }

      // Commit replay only after accepted payment and before creating the job.
      // Duplicate auth fails closed after rail acceptance; this path adds no
      // rail-specific compensation. Durable exact-admission continuation is handled
      // separately below.
      if (this.descriptor.auth && authEnvelope) {
        try {
          await this.descriptor.auth.recordReplay(authEnvelope);
        } catch (err) {
          if (
            err instanceof SignedRequestError &&
            err.sub_reason === "replay_detected" &&
            exactAdmission?.replayed
          ) {
            // The same durable exact-payment intent already committed this
            // request's bound local effect, but its job row did not land. Its
            // stored job id and request fingerprint make this a continuation;
            // prepare also reserved this full auth-envelope fingerprint to
            // this intent, so another exact payment cannot borrow the replay.
          } else if (err instanceof SignedRequestError) {
            return buildAuthErrorResponse(c, err, this.publicOrigin);
          } else {
            throw err;
          }
        }
      }

      // Create job and context. anonymous callers (auth=["none"] or
      // devMode) collapse to a single `requesterId`, so ownership checks on
      // `/v1/job/:id/*` would be tautological. Mint a 32-byte opaque `job_token`
      // at creation, persist its sha256 on the record, and return it to the
      // caller — subsequent reads/writes present it as `X-Job-Token` and the
      // ownership predicate gates on the hash.
      const jm = this.jobManager;
      const requesterId = c.get("requesterId");
      if (payment.funding && creditEnvelope?.fund) {
        const funding = await this.creditLedger.getFunding({
          creditId: payment.funding.creditId,
          fundId: payment.funding.fundingId,
        });
        if (funding) {
          payment.fundingReceipt = await fundingReceiptFor(
            this.creditLedger,
            this.receiptIssuer,
            funding
          );
        }
      }
      const isAnonymous = requesterId === "anonymous" || requesterId === "dev-anonymous";
      const jobToken = isAnonymous ? randomBytes(32).toString("hex") : undefined;
      const requesterTokenHash = jobToken
        ? createHash("sha256").update(jobToken).digest("hex")
        : undefined;
      const job = jm.createJob(
        normalisedBody,
        requesterId,
        payment,
        priceMsats,
        capabilityName,
        requesterTokenHash,
        {
          requesterToken: jobToken,
          requestFingerprint: fingerprint,
          requesterPubkey: authPubkey,
          requestId: publicRequestId,
          authRequestPath: this.descriptor.auth ? canonicalRequestPath(c.req.url) : undefined,
          jobId,
        }
      );

      await jm.persistJob(job);
      if (hostingAdmissionId) {
        await this.opts.hostingControlInstance!.finishAdmission(hostingAdmissionId, "accepted", jobId);
        hostingAdmissionAccepted = true;
      }
      await this.opts.hostingControlInstance?.status();
      if (this.opts.hostingControlInstance &&
        await this.opts.hostingControlInstance.dispatchDeadlineReached(jobId)) {
        const store = jm.store;
        if (store instanceof PostgresJobStore &&
          await store.cancelJobForHosting(jobId, "Hosting drain deadline reached")) {
          await jm.finalizeStoredTerminal(jobId);
        }
        const terminal = await store.get(jobId);
        if (terminal) return await this.submitResponse(c, terminal, jobToken);
      }
      if (exactAdmission) {
        await this.x402ExactSettlement?.completeAdmission(
          this.opts.dvmId ?? "",
          exactAdmission.intentId
        );
      }

      const sdkCtx = jm.buildAndAttachContext(job, parsedInput);

      jm.startIdleTimer(job);
      jm.runHandler(job, sdkCtx);

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      // a job that finished inside the tick above is about to be
      // answered with a 200, and that response has to carry the same receipt the
      // poll would. Signing needs two store round-trips, so wait for the terminal
      // chain the handler parked on `job.terminalWork` — bounded, because a
      // wedged store must degrade to "response without a receipt" rather than
      // hold the caller's request open.
      await awaitTerminalWork(job);

      let response: Response = await this.submitResponse(c, job, jobToken);
      // Dual-serve window: v2 and v1 clients receive the same base64 settlement
      // artifact under their respective response header names.
      if (payment.x402SettleResponseHeader) {
        response = new Response(response.body, response);
        response.headers.set("PAYMENT-RESPONSE", payment.x402SettleResponseHeader);
        response.headers.set("X-PAYMENT-RESPONSE", payment.x402SettleResponseHeader);
      }
      return response;
    } finally {
      if (hostingAdmissionId && !hostingAdmissionAccepted) {
        await this.opts.hostingControlInstance!.finishAdmission(
          hostingAdmissionId,
          hostingPaymentMayHaveLanded ? "unresolved" : "failed"
        );
      }
      if (publicRequestClaim && recoveryStore) {
        await recoveryStore.releaseRequestIdClaim(publicRequestClaim);
      }
    }
  }

  /**
   * Book a committed funding as a deposit (the deposit-accounting rule). Fire-and-forget
   * onto the reporter's durable queue: a funding is a liability the platform
   * must show, but a reporting hiccup must never fail the paid request that
   * just succeeded.
   */
  private reportCreditDeposit(funding: PaymentInfo["funding"]): void {
    const onCreditFunded = this.opts.onCreditFunded;
    if (!funding || !onCreditFunded || !this.opts.dvmId) return;
    // Built by the same function the reporter's outbox uses, so the override
    // cannot report a narrower deposit than the SDK-owned path.
    Promise.resolve(onCreditFunded(creditDepositPayload(this.opts.dvmId, funding))).catch(
      (err: unknown) => {
        diagnosticConsole.error(`[${funding.creditId}] Deposit reporting failed:`, err);
      }
    );
  }

  /**
   * Book a kept short payment as tagged revenue.
   * The proofs are committed and the draw was settled on the spot, so the money
   * is earned — but no job exists to carry it, hence the synthetic job id. It
   * is deliberately **not** a deposit: nothing is owed back, so a liability
   * line would be a phantom that never clears.
   */
  private reportShortPayForfeit(forfeit: ShortPayForfeit | undefined): void {
    const onJobCompleted = this.opts.onJobCompleted;
    if (!forfeit || !onJobCompleted || !this.opts.dvmId) return;
    Promise.resolve(
      onJobCompleted({
        dvmId: this.opts.dvmId,
        jobId: `shortpay:${forfeit.paymentId}`,
        paidMsats: forfeit.paidMsats,
        paymentMint: forfeit.mint,
        rail: "cashu",
        paymentTxHash: forfeit.paymentId,
        cashuFlow: "p2pk_accumulator",
        creditId: forfeit.creditId,
        drawId: forfeit.drawId,
        drawAmountMicro: forfeit.amountMicro,
        creditCurrency: forfeit.currency,
        settledAt: forfeit.settledAt,
        kind: "short_pay_forfeit",
      })
    ).catch((err: unknown) => {
      diagnosticConsole.error(`[${forfeit.paymentId}] Short-pay forfeit reporting failed:`, err);
    });
  }

  /**
   * Recover a lost paid response only for matching request fingerprint,
   * authenticated pubkey and requester identity. A spent bearer token alone
   * is not proof of request ownership.
   */
  private async recoverReplayedJob(
    c: Context<AppEnv>,
    opts: { requestId?: string; fingerprint: string; callerPubkey?: string }
  ): Promise<Response | undefined> {
    if (!opts.requestId) return undefined;
    const prior = await this.jobManager.store.findJobByPaymentTxHash(opts.requestId);
    if (!prior) return undefined;

    const bodyMatches =
      prior.requestFingerprint !== undefined && prior.requestFingerprint === opts.fingerprint;
    // On a descriptor-auth DVM the signing key is the caller's identity, so pin
    // it. Everywhere else `requesterId` is what the read paths gate on
    // (`isJobOwner`) — pin it too, so a DVM that ever grows identified callers
    // can't hand caller B the job caller A's body happens to fingerprint to.
    const pubkeyMatches =
      this.descriptor.auth === undefined ||
      (prior.requesterPubkey !== undefined && prior.requesterPubkey === opts.callerPubkey);
    const requesterMatches = prior.requesterId === c.get("requesterId");

    if (!bodyMatches || !pubkeyMatches || !requesterMatches) {
      diagnosticConsole.warn(
        {
          level: "paid_submit_replay_refused",
          jobId: prior.id,
          requestId: opts.requestId,
          reason: !bodyMatches
            ? "fingerprint_mismatch"
            : !pubkeyMatches
              ? "pubkey_mismatch"
              : "requester_mismatch",
        }
      );
      return undefined;
    }
    await this.jobManager.ensureReceipt(prior);
    return await this.submitResponse(c, prior, prior.requesterToken);
  }

  /**
   * Resolve the recorded draw's job under the same fingerprint/pubkey/requester
   * checks as header recovery. If no job exists, the caller may still recover a
   * pending durable acceptance under its bound public request-id claim.
   */
  private async recoverDrawnJob(
    c: Context<AppEnv>,
    opts: {
      creditId: string;
      drawId: string;
      jobId: string | null;
      fingerprint: string;
      callerPubkey?: string;
    }
  ): Promise<Response | undefined> {
    let jobId = opts.jobId;
    if (!jobId) {
      const draw = await this.creditLedger.getDraw({
        creditId: opts.creditId,
        drawId: opts.drawId,
      });
      jobId = draw?.jobId ?? null;
    }
    const prior = jobId ? await this.jobManager.store.get(jobId) : undefined;
    if (!prior) {
      diagnosticConsole.warn(
        {
          level: "drawn_job_recovery_refused",
          creditId: opts.creditId,
          drawId: opts.drawId,
          jobId,
          reason: "job_not_found",
        }
      );
      return undefined;
    }
    const bodyMatches =
      prior.requestFingerprint !== undefined && prior.requestFingerprint === opts.fingerprint;
    const pubkeyMatches =
      prior.requesterPubkey !== undefined && prior.requesterPubkey === opts.callerPubkey;
    const requesterMatches = prior.requesterId === c.get("requesterId");
    if (!bodyMatches || !pubkeyMatches || !requesterMatches) {
      diagnosticConsole.warn(
        {
          level: "paid_submit_replay_refused",
          jobId: prior.id,
          creditId: opts.creditId,
          drawId: opts.drawId,
          reason: !bodyMatches
            ? "fingerprint_mismatch"
            : !pubkeyMatches
              ? "pubkey_mismatch"
              : "requester_mismatch",
        }
      );
      return undefined;
    }
    await this.jobManager.ensureReceipt(prior);
    return await this.submitResponse(c, prior, prior.requesterToken);
  }

  /**
   * Resume the gap between a durable x402/Tempo marker+draw commit and the
   * initial job save. The public request-id lock has already re-established
   * the exact caller/fingerprint binding; the marker must also name the job id
   * allocated by that binding before its recorded draw can pay the job.
   */
  private async recoverProcessedPaymentAcceptance(opts: {
    paymentId: string;
    jobId: string;
    requiredMsats?: number;
  }): Promise<PaymentInfo | undefined> {
    if (!this.opts.dvmId) return undefined;
    for (const rail of ["x402", "tempo"] as const) {
      const marker = await this.processedPayments.get({
        dvmId: this.opts.dvmId,
        rail,
        paymentId: opts.paymentId,
      });
      if (!marker) continue;
      if (marker.jobId !== opts.jobId) {
        diagnosticConsole.warn(
          {
            level: "request_acceptance_recovery_refused",
            rail,
            paymentId: opts.paymentId,
            expectedJobId: opts.jobId,
            recordedJobId: marker.jobId,
            reason: "job_id_mismatch",
          }
        );
        return undefined;
      }
      return this.recoverDrawAcceptance({
        creditId: marker.creditId,
        drawId: marker.drawId,
        expectedJobId: opts.jobId,
        requiredMsats: opts.requiredMsats,
        paymentId: marker.paymentId,
        expectedRail: rail,
      });
    }
    return undefined;
  }

  private async recoverDrawAcceptance(opts: {
    creditId: string;
    drawId: string;
    expectedJobId: string;
    requiredMsats?: number;
    paymentId?: string;
    expectedRail?: "x402" | "tempo";
  }): Promise<PaymentInfo | undefined> {
    const dvmId = this.opts.dvmId;
    if (!dvmId) return undefined;
    const draw = await this.creditLedger.getDraw({
      creditId: opts.creditId,
      drawId: opts.drawId,
    });
    if (
      draw?.jobId !== opts.expectedJobId ||
      draw.status !== "pending" ||
      (opts.expectedRail !== undefined && draw.railValue.rail !== opts.expectedRail)
    ) {
      return undefined;
    }
    const payment = recordedDrawPayment(draw, {
      dvmId,
      requiredMsats: opts.requiredMsats,
      paymentId: opts.paymentId,
    });
    if (payment) {
      diagnosticConsole.warn(
        {
          level: "request_acceptance_recovered",
          jobId: opts.expectedJobId,
          creditId: opts.creditId,
          drawId: opts.drawId,
          rail: payment.paymentRail,
        }
      );
    }
    return payment;
  }

  /**
   * Recompute dynamic upfront pricing from parsed job input, applying the quote
   * schema separately. Refuse invalid input/results, currency mismatch or missing
   * FX when payment needs a price (400/500/503 as classified below).
   */
  private async computeDynamicPrice(
    onQuote: NonNullable<CapabilityDescriptor["onQuote"]>,
    parsedInput: unknown,
    body: { input: string; params?: Record<string, string> },
    callerPubkey?: string,
    skipRateConversion = false
  ): Promise<{
    priceMsats?: number;
    upfront?: { amount: number; currency: string };
    error?: { body: Record<string, unknown>; status: 400 | 500 | 503 };
  }> {
    let data: unknown = parsedInput;
    if (isZodSchema(onQuote.schema)) {
      const parsed = onQuote.schema.safeParse(parsedInput);
      if (!parsed.success) {
        return {
          error: {
            body: {
              error: "quote_unavailable",
              message:
                "DVM uses dynamic pricing but the job input does not satisfy onQuote.schema. Submit the same payload to /v1/quote to confirm pricing.",
            },
            status: 400,
          },
        };
      }
      data = parsed.data;
    }

    try {
      const result = await onQuote.handler(
        await this.buildQuoteContext({
          data,
          input: body.input,
          params: body.params,
          callerPubkey,
        })
      );
      const validated = validateQuoteResult(result, this.pricingCurrency);
      const upfrontCurrency = validated.upfront.currency;
      const supported = this.fxFetcher.supportedCurrencies();
      if (!supported.includes(upfrontCurrency)) {
        throw new UnsupportedCurrencyError(upfrontCurrency, supported);
      }
      if (skipRateConversion) {
        return { upfront: { amount: validated.upfront.amount, currency: upfrontCurrency } };
      }
      const fx = await this.fxFetcher.fetch();
      const priceMsats =
        fiatToSatsCeil(validated.upfront.amount, fxRateFor(fx, upfrontCurrency)) * 1000;
      return {
        priceMsats,
        upfront: { amount: validated.upfront.amount, currency: upfrontCurrency },
      };
    } catch (err) {
      if (err instanceof InvalidCurrencyError || err instanceof UnsupportedCurrencyError) {
        return {
          error: {
            body: { error: "invalid_quote_result", message: err.message },
            status: 400,
          },
        };
      }
      // the DVM's own two declarations disagree — nothing the caller
      // sent could have avoided it, so answer 5xx rather than sending them off
      // to fix an input. Matches what `/v1/quote` returns for the same defect.
      if (err instanceof QuoteCurrencyMismatchError) {
        diagnosticConsole.error("quote currency mismatch:", err);
        return {
          error: { body: { error: err.code, message: err.message }, status: 500 },
        };
      }
      // keep the fx-error envelope in lockstep with `/v1/quote` —
      // agents see the same `fx_rate_unavailable` 503 regardless of which path
      // surfaced the failure, so retry policy is consistent.
      const fxErr = pickFxRateUnavailable(err);
      if (fxErr) {
        return { error: { body: { error: fxErr }, status: 503 } };
      }
      // Preserve structured code/display/hint errors on job pricing as on quote,
      // so callers have the same remedy when they skip a separate price probe.
      const structured = pickStructuredError(err);
      if (structured) {
        return { error: { body: { error: structured }, status: 400 } };
      }
      return {
        error: {
          body: {
            error: "quote_failed",
            message: err instanceof Error ? err.message : "Quote computation failed",
          },
          status: 400,
        },
      };
    }
  }

  private async submitResponse(c: Context<AppEnv>, job: TerminalFieldSource & { lastActivityAt: number; redactedAt?: number }, jobToken: string | undefined): Promise<Response> {
    // Handler completion can mutate the cached job while the durable metadata read waits.
    const snapshot = { ...job, messages: [...job.messages] };
    return buildSubmitResponse(c, snapshot, jobToken, await this.contentFields(snapshot));
  }

  private async contentFields(job: { id: string; status: JobStatus; lastActivityAt: number; redactedAt?: number }): Promise<Record<string, unknown>> {
    const store = this.jobManager.store;
    const responseStatus = job.status;
    if (isContentHoldStore(store)) {
      const snapshot = await store.getContentSnapshot(job.id);
      if (snapshot) return { ...contentMetadata({ ...snapshot.job, status: responseStatus }, this.descriptor.jobRetentionDays, snapshot.history.holds) };
    }
    // Unsupported custom stores cannot vouch for durable availability or holds.
    return isContentHoldStore(store) ? { ...contentMetadata(job, this.descriptor.jobRetentionDays) } : {};
  }

  private async messageFields(job: { id: string; status: JobStatus; lastActivityAt: number; redactedAt?: number }, messages: Message[]): Promise<Record<string, unknown>> {
    const fields = await this.contentFields(job);
    return { messages: fields.content_available === false ? [] : messages, ...fields };
  }

  private async handleGetJob(c: Context<AppEnv>): Promise<Response> {
    // Reject missing credentials before lookup, independent of job existence.
    // Wrong credentials still receive 404.
    if (!jobCredential.presents(c.req)) return c.json(jobCredential.body(), 401);
    const id = c.req.param("id") ?? "";
    const job = this.jobManager.activeJobs.get(id);
    if (job) {
      if (!isJobOwner(c, job)) return c.json({ error: "Job not found" }, 404);
      await this.jobManager.ensureReceipt(job);
      const res: Record<string, unknown> = { job_id: job.id, status: job.status };
      Object.assign(res, terminalResponseFields(job), await this.contentFields(job));
      removeUnavailableContent(res);
    return c.json(res);
    }

    const record = await this.jobManager.store.get(id);
    if (!record) return c.json({ error: "Job not found" }, 404);
    if (!isJobOwner(c, record)) return c.json({ error: "Job not found" }, 404);
    await this.jobManager.ensureReceipt(record);
    const res: Record<string, unknown> = { job_id: record.id, status: record.status };
    Object.assign(res, terminalResponseFields(record), await this.contentFields(record));
    removeUnavailableContent(res);
    return c.json(res);
  }

  private async handleGetMessages(c: Context<AppEnv>): Promise<Response> {
    // Ahead of the SSE branch too, so a stream never opens on an unreadable job.
    if (!jobCredential.presents(c.req)) return c.json(jobCredential.body(), 401);
    const id = c.req.param("id") ?? "";
    const job = this.jobManager.activeJobs.get(id);
    const after = Number(c.req.query("after") ?? "0");
    const accept = c.req.header("Accept") ?? "";

    if (!job) {
      const store = this.jobManager.store;
      const record = await store.get(id);
      if (!record) return c.json({ error: "Job not found" }, 404);
      if (!isJobOwner(c, record)) return c.json({ error: "Job not found" }, 404);
      const filtered = record.messages.filter((m) => m.seq > after);

      if (accept.includes("text/event-stream")) {
        // Cross-machine live stream: subscribe via NOTIFY when the job is
        // still in-flight on another machine and the store supports it.
        if (isStreamableJobStore(store) && !isTerminal(record.status)) {
          return streamSSE(c, async (stream) => {
            let unsubFn: (() => void) | undefined;

            await new Promise<void>((resolve) => {
              let settled = false;
              let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
              let lastSeq = after;

              const finish = (): void => {
                if (settled) return;
                settled = true;
                clearTimeout(inactivityTimer);
                unsubFn?.();
                resolve();
              };

              const resetInactivityTimer = (): void => {
                clearTimeout(inactivityTimer);
                inactivityTimer = setTimeout(finish, 60_000);
              };

              // Sweep committed rows before closing on a yield; an out-of-order notification
              // must not strand a later message.
              const drainAndFinish = async (): Promise<void> => {
                if (settled) return;
                try {
                  const remaining = await store.getMessages(id, lastSeq);
                  for (const extra of remaining) {
                    if (extra.seq > lastSeq) {
                      lastSeq = extra.seq;
                      await stream.writeSSE({
                        data: JSON.stringify(extra),
                        event: "message",
                      });
                    }
                  }
                } catch {
                  // Drain is best-effort; fall through to finish.
                  // A concurrent onAbort that called finish() will have
                  // closed the stream — `finish()` below is a no-op then.
                }
                finish();
              };

              store
                .subscribeMessages(id, after, (msg) => {
                  if (settled) return;
                  // Deduplicate by sequence across the drain and notification reads, which may
                  // return the same committed row.
                  if (msg.seq <= lastSeq) return;
                  lastSeq = msg.seq;
                  resetInactivityTimer();
                  stream
                    .writeSSE({ data: JSON.stringify(msg), event: "message" })
                    .then(() => {
                      if (isYieldMessage(msg)) void drainAndFinish();
                    })
                    .catch(() => {
                      finish();
                    });
                })
                .then((u) => {
                  unsubFn = u;
                  resetInactivityTimer();
                  stream.onAbort(finish);
                })
                .catch(() => {
                  resolve();
                });
            });
          });
        }

        const fields = await this.contentFields(record);
        return streamSSE(c, async (stream) => {
          if (fields.content_available === false) return;
          for (const msg of filtered) {
            await stream.writeSSE({ data: JSON.stringify(msg), event: "message" });
          }
        });
      }

      if (isStreamableJobStore(store) && !isTerminal(record.status)) {
        const msgs = await store.getMessages(id, after);
        if (msgs.length > 0) return c.json(await this.messageFields(record, msgs));
      }
      return c.json(await this.messageFields(record, filtered));
    }

    if (!isJobOwner(c, job)) return c.json({ error: "Job not found" }, 404);

    if (accept.includes("text/event-stream")) {
      const fields = await this.contentFields(job);
      return streamSSE(c, async (stream) => {
        if (fields.content_available === false) return;
        const existing = job.messages.filter((m) => m.seq > after);
        let yielded = false;
        for (const msg of existing) {
          await stream.writeSSE({ data: JSON.stringify(msg), event: "message" });
          if (isYieldMessage(msg)) yielded = true;
        }
        if (yielded) return;
        if (isTerminal(job.status)) return;

        await new Promise<void>((resolve) => {
          const listener = (msg: Message): void => {
            stream
              .writeSSE({ data: JSON.stringify(msg), event: "message" })
              .then(() => {
                if (isYieldMessage(msg)) {
                  job.listeners.delete(listener);
                  resolve();
                }
              })
              .catch(() => {
                job.listeners.delete(listener);
                resolve();
              });
          };
          job.listeners.add(listener);
          stream.onAbort(() => {
            job.listeners.delete(listener);
            resolve();
          });
        });
      });
    }

    return c.json(await this.messageFields(job, job.messages.filter((m) => m.seq > after)));
  }

  private jobNotActiveResponse(c: Context<AppEnv>): Response {
    return c.json(
      {
        error: "job_not_active",
        message: "Job already reached a terminal status and no longer accepts messages.",
        hint: "The job is finished — fetch results with GET /v1/job/:id/messages.",
      },
      409
    );
  }

  private async handlePostMessage(c: Context<AppEnv>): Promise<Response> {
    // no credential → 401 before any lookup (see `handleGetJob`).
    // Above every payment path, so nothing is verified or credited first.
    if (!jobCredential.presents(c.req)) return c.json(jobCredential.body(), 401);
    const id = c.req.param("id") ?? "";
    const jm = this.jobManager;
    const activeJob = jm.activeJobs.get(id);
    const wire = await c.req.raw.clone().json().catch(() => undefined) as
      { type?: string; content?: Record<string, unknown> } | undefined;
    if (wire?.type === "payment" && wire.content && typeof wire.content === "object" && "credit" in wire.content) {
      const record = await jm.store.get(id);
      if (!record || !isJobOwner(c, record)) return c.json({ error: "Job not found" }, 404);
      if (Object.keys(wire.content).some((key) => key !== "credit")) {
        return c.json({ error: "invalid_message", message: "Credit authorization cannot be combined with a rail payment" }, 400);
      }
      if (!this.balancePaymentSupported(true) || !this.opts.db || !this.descriptor.auth ||
          !(this.creditLedger instanceof CreditLedger)) {
        return c.json({ error: "balance_payment_unavailable" }, 409);
      }
      try {
        const result = await commitBalancePayment({ pool: this.opts.db, ledger: this.creditLedger,
          auth: this.descriptor.auth, domain: this.signedRequestDomain(c, null), jobId: id,
          dvmId: this.opts.dvmId ?? "", raw: wire.content.credit,
          allowFresh: this.opts.env.DVMKIT_BALANCE_PAYMENTS !== "false" });
        try {
          // Wake the existing claim/resume owner. A COMMIT acknowledgement may
          // arrive after NOTIFY has already advanced the handler to another ask.
          await this.opts.db.query("SELECT pg_notify('job_messages', $1)", [id]);
          if (!activeJob) {
            const fresh = await jm.store.get(id);
            if (fresh?.status === "awaiting-input" && isStreamableJobStore(jm.store)) {
              fresh.messages = await jm.store.getMessages(id, 0);
              fresh.seq = Math.max(fresh.seq, ...fresh.messages.map((message) => message.seq));
              const ask = fresh.messages.findLast((message) => message.from === "provider" && message.type === "payment-request");
              const authorized = wire.content.credit as { request_seq: number };
              if (ask?.seq === authorized.request_seq && !jm.activeJobs.has(id)) {
                const { job } = jm.reactivateJob(fresh);
                const lock = await jm.store.tryReactivationLock(id, () =>
                  this.runReactivation(jm, job, { type: "payment", content: wire.content! }, fresh.status));
                if (!lock.acquired) this.teardownReactivationScaffold(jm, job);
              }
            }
          }
        } catch {
          // The accepted outcome is durable. A progress failure must never ask
          // the caller to spend again; a non-payment resume can recover it.
          diagnosticConsole.error({ level: "balance_payment_resume_unavailable", job_id: id });
        }
        return c.json(result.response, 201);
      } catch (error) {
        if (error instanceof SignedRequestError) return buildAuthErrorResponse(c, error, this.publicOrigin);
        if (error instanceof BalancePaymentError) return c.json(error.body, error.status);
        throw error;
      }
    }

    if (activeJob) {
      if (!isJobOwner(c, activeJob)) return c.json({ error: "Job not found" }, 404);
      if (isTerminal(activeJob.status)) {
        return this.jobNotActiveResponse(c);
      }

      const parsed = await this.requireJsonBody<{
        type: MessageType;
        content: Record<string, unknown>;
      }>(c);
      if ("error" in parsed) return parsed.error;
      const body = parsed.body;
      const contentErr = validateMessageContent(
        body.type,
        body.content,
        this.opts.devMode === true
      );
      if (contentErr) return c.json({ error: "invalid_message", message: contentErr }, 400);

      const inboundSeq = await jm.recordInboundPending(activeJob, body.type, body.content);

      const lockPubkeys = await this.resolveLockPubkeysForReceive();
      let unappliedCredit: UnappliedCredit | undefined;
      if (body.type === "payment") {
        const outcome = await jm.processPayment(activeJob, body, inboundSeq, {
          lockPubkeys,
          mintHealthTracker: this.mintHealthTracker,
        });
        // Not `as 402`: the branch also carries 500 (`payment_unapplied`) and
        // 503 (the sick-mint short-circuit).
        if (outcome.error)
          return c.json(outcome.error.body, outcome.error.status as ContentfulStatusCode);
        unappliedCredit = outcome.unappliedCredit;
      } else {
        // Non-payment inbound: flip status to verified so cross-machine
        // SSE readers see the row.
        await jm.markInboundVerified(activeJob.id, inboundSeq);
      }

      jm.startIdleTimer(activeJob);
      try {
        await jm.dispatchMessage(activeJob, body.type, body.content);
        await this.persistMessageSnapshot(jm, activeJob, body.type);
      } catch (error) {
        const response = this.postPaymentSnapshotFailure(c, error, activeJob, body.type, inboundSeq, unappliedCredit);
        if (response) return response;
        throw error;
      }
      const lastMsg = activeJob.messages[activeJob.messages.length - 1];
      // `credit` is present only when this payment funded a credit the
      // job row didn't take — a concurrent free-then-paid top-up that lost the
      // set-if-null bind. The payment succeeded; the money is simply the
      // caller's balance rather than this job's.
      return c.json({ seq: lastMsg.seq, ...(unappliedCredit && { credit: unappliedCredit }) }, 201);
    }

    const record = await jm.store.get(id);
    if (!record) return c.json({ error: "Job not found" }, 404);
    if (!isJobOwner(c, record)) return c.json({ error: "Job not found" }, 404);
    if (isTerminal(record.status)) {
      return this.jobNotActiveResponse(c);
    }

    const parsed = await this.requireJsonBody<{
      type: MessageType;
      content: Record<string, unknown>;
    }>(c);
    if ("error" in parsed) return parsed.error;
    const body = parsed.body;

    // Legacy missing capabilities and capabilities removed during execution cannot
    // reactivate. Fail the job and return structured 410 before content validation.
    if (!jm.hasCapability(record.capability)) {
      const summary = record.capability
        ? `Capability "${record.capability}" is no longer registered on this DVM`
        : "Job predates capability dispatch and cannot be resumed";
      await jm.store.save({
        ...record,
        status: "failed",
        summary,
        lastActivityAt: Date.now(),
      });
      const infoUrl = infoSchemaUrl(c.req.url, this.publicOrigin);
      return c.json(
        {
          error: "unknown_capability",
          message: summary,
          hint: `Inspect ${infoUrl} for the current capability set.`,
        },
        410
      );
    }

    const contentErr = validateMessageContent(body.type, body.content, this.opts.devMode === true);
    if (contentErr) return c.json({ error: "invalid_message", message: contentErr }, 400);

    if (isStreamableJobStore(jm.store)) {
      record.messages = await jm.store.getMessages(id, 0);
      record.seq = Math.max(record.seq, ...record.messages.map((message) => message.seq));
    }

    // Credit is committed before handler dispatch. Reactivation re-verifies persisted
    // auth without drift/replay checks; failed verification terminally refuses the job.
    let job: ServerJob;
    try {
      ({ job } = jm.reactivateJob(record));
    } catch (err) {
      if (err instanceof SignedRequestError) {
        await jm.store
          .save({
            ...record,
            status: "failed",
            summary: "Persisted auth envelope failed signature re-verification on reactivation",
            lastActivityAt: Date.now(),
          })
          .catch(() => undefined);
        return buildAuthErrorResponse(c, err, this.publicOrigin);
      }
      if (err instanceof ReactivationAuthSchemaError) {
        return c.json(
          {
            error: "auth_error",
            sub_reason: "schema_invalid",
            display: "Capability has no input schema to verify against",
            hint: "This DVM declares descriptor-level auth but the capability omits an input schema. Operator must wire one to sign over.",
          },
          500
        );
      }
      throw err;
    }

    const inboundSeq = await jm.recordInboundPending(job, body.type, body.content);

    const lockPubkeys = await this.resolveLockPubkeysForReceive();
    let unappliedCredit: UnappliedCredit | undefined;
    if (body.type === "payment") {
      const outcome = await jm.processPayment(job, body, inboundSeq, {
        lockPubkeys,
        mintHealthTracker: this.mintHealthTracker,
      });
      if (outcome.error) {
        this.teardownReactivationScaffold(jm, job);
        return c.json(outcome.error.body, outcome.error.status as ContentfulStatusCode);
      }
      unappliedCredit = outcome.unappliedCredit;
    } else {
      await jm.markInboundVerified(job.id, inboundSeq);
    }
    const creditBlock = unappliedCredit ? { credit: unappliedCredit } : {};

    const elapsed = Date.now() - record.lastActivityAt;
    if (elapsed >= this.descriptor.idleTimeout * 1000) {
      await jm.cancelJobIdle(job);
      const lastMsg = job.messages[job.messages.length - 1];
      return c.json({ seq: lastMsg.seq, ...creditBlock }, 201);
    }
    jm.startIdleTimer(job);

    // Reactivation under an advisory lock prevents two
    // simultaneous inbounds on different machines from double-reactivating.
    // The lock is tx-scoped on Postgres; the memory store mirrors the
    // semantics with a simple Set guard so unit tests exercise the same path.
    try {
      if (isStreamableJobStore(jm.store)) {
        const store = jm.store;
        const lockResult = await store.tryReactivationLock(job.id, async () => {
          await this.runReactivation(jm, job, body, record.status);
        });
        if (!lockResult.acquired) {
          // Our credit is durable, but another machine owns reactivation. Remove this
          // local scaffold and idle timer; never persist its stale snapshot or it could
          // later cancel/clobber the winner.
          this.teardownReactivationScaffold(jm, job);
        }
      } else {
        await this.runReactivation(jm, job, body, record.status);
      }
    } catch (error) {
      const response = this.postPaymentSnapshotFailure(c, error, job, body.type, inboundSeq, unappliedCredit);
      if (response) return response;
      throw error;
    }

    const lastMsg = job.messages[job.messages.length - 1];
    return c.json({ seq: lastMsg.seq, ...creditBlock }, 201);
  }

  private async persistMessageSnapshot(
    jm: JobManager<State, InputSchema>,
    job: ServerJob,
    type: MessageType
  ): Promise<void> {
    if (type === "payment") {
      await retryJobSnapshot(() => jm.persistJob(job));
    } else {
      await jm.persistJob(job);
    }
  }

  private postPaymentSnapshotFailure(
    c: Context<AppEnv>,
    error: unknown,
    job: ServerJob,
    type: MessageType,
    inboundSeq: number | null,
    unappliedCredit?: UnappliedCredit
  ): Response | undefined {
    if (!(error instanceof JobSnapshotPersistenceError) || type !== "payment" ||
      inboundSeq === null || !isStreamableJobStore(this.jobManager.store)) return undefined;
    // processPayment returned success, so the inbound CAS and accounting are
    // recorded. This is a snapshot failure, never a request for another spend.
    diagnosticConsole.error({ level: "job_snapshot_unavailable", job_id: job.id, seq: inboundSeq });
    return c.json({
      error: "job_snapshot_unavailable",
      message: "Payment was recorded but the job snapshot could not be persisted.",
      display: "Your payment was recorded. The service could not save the latest job progress.",
      hint: "Do not send another payment. Read the job status and messages; if the worker stopped, resume with a non-payment message.",
      retryable: false,
      payment_status: "recorded",
      job_id: job.id,
      seq: inboundSeq,
      ...(unappliedCredit && { credit: unappliedCredit }),
    }, 503);
  }

  /**
   * Run the handler or dispatch the inbound after Tx B + Tx C have already
   * committed the credit. Status decides the behaviour: `awaiting-input`
   * replays the suspended handler; everything else delivers the message to
   * the descriptor's event-driven handlers.
   */
  private async runReactivation(
    jm: JobManager<State, InputSchema>,
    job: ServerJob,
    body: { type: MessageType; content: Record<string, unknown> },
    priorStatus: JobRecord["status"]
  ): Promise<void> {
    if (priorStatus === "awaiting-input") {
      // A concurrent inbound may have replaced this recovery scaffold while
      // the advisory lock was acquired. Never borrow that scaffold's ask.
      if (jm.activeJobs.get(job.id) !== job) {
        this.teardownReactivationScaffold(jm, job);
        return;
      }
      // A live suspended handler may claim processing after the payment notification.
      // Wait a bounded grace period and replay only after winning the durable claim,
      // preventing duplicate handler execution and conflicting snapshots.
      const claimed = await jm.claimAwaitingInputForReactivation(job.id);
      if (!claimed) {
        this.teardownReactivationScaffold(jm, job);
        return;
      }
      const sdkCtx = job.sdkCtx;
      if (!sdkCtx) throw new Error(`runReactivation: job ${job.id} missing sdkCtx`);
      job.replayHighSeq = job.seq;
      // Count only provider messages replay will emit. Payment-request messages are
      // resolved from cached payment/upfront credit before emission, so including
      // them would consume a skip slot intended for a later artifact.
      job.replayProviderSkip = job.messages.filter(
        (m) => m.from === "provider" && m.type !== "payment-request"
      ).length;
      jm.runHandler(job, sdkCtx);
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    } else {
      await jm.dispatchMessage(job, body.type, body.content);
      await this.persistMessageSnapshot(jm, job, body.type);
    }
  }

  /**
   * Tear down this machine's in-memory reactivation scaffold when it stands
   * down after losing the reactivation advisory lock or deferring to a live original
   * handler that won the single-execution claim. Leaving
   * the job in `activeJobs` with a live idle timer would, one idle window
   * later, fire `cancelJobIdle` → Tx A `cancel` and clobber the winner. We also
   * must not persist our stale snapshot; clearing the appender prevents that.
   */
  private teardownReactivationScaffold(jm: JobManager<State, InputSchema>, job: ServerJob): void {
    if (jm.activeJobs.get(job.id) === job) {
      jm.clearIdleTimer(job.id);
      jm.unwatchDurableStatus(job.id);
      jm.activeJobs.delete(job.id);
    }
    job.messageAppender = undefined;
  }

  private async handleDeleteJob(c: Context<AppEnv>): Promise<Response> {
    // no credential → 401 before any lookup (see `handleGetJob`).
    if (!jobCredential.presents(c.req)) return c.json(jobCredential.body(), 401);
    const id = c.req.param("id") ?? "";
    const jm = this.jobManager;
    const job = jm.activeJobs.get(id);

    let reason: string | undefined;
    try {
      const body = await c.req.json<{ reason?: string }>();
      reason = body.reason;
    } catch {
      // no body is fine
    }

    if (!job) {
      const record = await jm.store.get(id);
      if (!record) return c.json({ error: "Job not found" }, 404);

      if (!isJobOwner(c, record)) return c.json({ error: "Job not found" }, 404);

      if (isTerminal(record.status)) {
        return this.jobNotActiveResponse(c);
      }

      // Cancel in the store, atomically. The handler is running on
      // another machine — `cancelJob` commits the terminal status, the `cancel`
      // message, and the NOTIFY in one transaction, so that machine adopts the
      // status and aborts `ctx.signal` within a round-trip instead of grinding
      // through the provider call the caller just cancelled. A `false` return
      // means someone else drove the job terminal between our read and the CAS.
      const store = jm.store;
      if (isStreamableJobStore(store)) {
        const cancelled = await store.cancelJob(id, reason ?? "Job cancelled");
        if (!cancelled) return this.jobNotActiveResponse(c);
        // this machine wrote the terminal, so it issues the receipt.
        // The handler's machine will try too when it adopts the status — the
        // store's write-once persist makes whichever loses take the winner's
        // bytes rather than sign a second time.
        await jm.finalizeStoredTerminal(id);
        return c.json({ status: "cancelled" });
      }

      // Non-streamable store: single-machine by construction (no cross-machine
      // streaming, so no handler elsewhere to notify and no writer to race).
      record.endedBy = "caller";
      record.status = "cancelled";
      record.lastActivityAt = Date.now();
      await jm.store.save(record);
      await jm.finalizeStoredTerminal(id);
      return c.json({ status: "cancelled" });
    }

    if (!isJobOwner(c, job)) return c.json({ error: "Job not found" }, 404);

    if (isTerminal(job.status)) {
      return this.jobNotActiveResponse(c);
    }

    // Dispatch cancel through listener fan-out so an open SSE stream receives its
    // yield event; persistence follows the normal dispatch path.
    localMessage(job, "requester", "cancel", { reason });
    job.lastActivityAt = Date.now();
    await jm.dispatchMessage(job, "cancel", { reason });
    return c.json({ status: "cancelled" });
  }
}

/**
 * the SDK's credential gate. `acceptsBearer: false` — this server's
 * auth middleware pins `requesterId` to `anonymous`/`dev-anonymous`, so every
 * job here is gated on the `X-Job-Token` and a Bearer header is not a
 * job credential. (The isolate tier, which does derive identity from Bearer,
 * builds its own gate.)
 */
const jobCredential = jobCredentialGate({ acceptsBearer: false });

/**
 * Anonymous jobs require the matching opaque X-Job-Token; identified jobs
 * require requesterId equality. Wrong credentials return 404, while missing
 * credentials were refused before lookup to avoid disclosing job existence.
 */
function isJobOwner(
  c: Context<AppEnv>,
  job: { requesterId: string; requesterTokenHash?: string }
): boolean {
  if (job.requesterTokenHash) {
    const token = c.req.header("X-Job-Token");
    if (!token) return false;
    const provided = createHash("sha256").update(token).digest("hex");
    return timingSafeEqualHex(provided, job.requesterTokenHash);
  }
  return c.get("requesterId") === job.requesterId;
}

/**
 * Compare equal-length hex strings without exiting on a differing character.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The `POST /v1/job` success body. Shared by the fresh-submit path and the
 * idempotent-replay path so a recovered job is indistinguishable
 * on the wire from the response the caller lost — same fields, same status
 * codes (200 once completed, 202 otherwise).
 */
function buildSubmitResponse(
  c: Context<AppEnv>,
  job: TerminalFieldSource,
  jobToken: string | undefined,
  contentFields: Record<string, unknown>
): Response {
  const res: Record<string, unknown> = { job_id: job.id };
  if (jobToken) res.job_token = jobToken;
  if (job.status === "awaiting-input") res.status = "awaiting-input";
  else if (job.status === "completed") res.status = "completed";
  Object.assign(res, terminalResponseFields(job), contentFields);
  removeUnavailableContent(res);
  return c.json(res, job.status === "completed" ? 200 : 202, jobIdentityHeaders(job.id));
}

function requestRecoveryStore(store: JobStore): RequestRecoveryJobStore | undefined {
  return store.findJobByRequestId &&
    store.claimRequestId &&
    store.resumeRequestId &&
    store.releaseRequestIdClaim
    ? (store as RequestRecoveryJobStore)
    : undefined;
}

function recordedDrawPayment(
  draw: DrawRecord,
  opts: { dvmId: string; requiredMsats?: number; paymentId?: string }
): PaymentInfo | undefined {
  const rail = fundingMethodFromStored(draw.railValue.rail);
  if (!rail) return undefined;
  const nativeAsset = nativeAssetFromStored(draw.railValue.nativeAsset);
  const paymentTxHash = opts.paymentId ?? drawSettlementRef(opts.dvmId, draw.creditId, draw.drawId);
  return {
    paidMsats: draw.railValue.drawMsats > 0 ? draw.railValue.drawMsats : (opts.requiredMsats ?? 0),
    paymentRail: rail,
    receivedProofs: [],
    paymentTxHash,
    ...(rail === "x402" && /^0x[0-9a-f]{64}$/i.test(paymentTxHash)
      ? { paymentTransactionHash: paymentTxHash }
      : {}),
    ...(draw.railValue.drawNative !== null && nativeAsset
      ? { nativeAmount: draw.railValue.drawNative, nativeAsset }
      : {}),
    ...(draw.railValue.mint ? { paymentMint: draw.railValue.mint } : {}),
    ...(rail === "cashu" ? { cashuFlow: "p2pk_accumulator" as const } : {}),
    creditId: draw.creditId,
    drawId: draw.drawId,
    drawAmountMicro: draw.amountMicro,
    ...(draw.railValue.creditCurrency ? { creditCurrency: draw.railValue.creditCurrency } : {}),
  };
}

function fundingMethodFromStored(value: string | null): FundingMethod | undefined {
  return value === "cashu" || value === "x402" || value === "tempo" || value === "lightning"
    ? value
    : undefined;
}

function nativeAssetFromStored(value: string | null): PaymentInfo["nativeAsset"] {
  return value === "sats" || value === "usdc" || value === "usdc.e" || value === "usd-cents"
    ? value
    : undefined;
}

function requestIdExists(c: Context<AppEnv>, requestId: string): Response {
  return c.json(
    {
      error: "request_id_exists",
      message: "This request id is already reserved or bound to an accepted request.",
      hint: `Run dvm request-result ${requestId}; do not submit or pay again.`,
      request_id: requestId,
    },
    409
  );
}

function requestNotAccepted(c: Context<AppEnv>, requestId: string): Response {
  return c.json(
    {
      error: "request_not_accepted",
      message: "No committed server acceptance is available for this request id.",
      hint: "No credential was replayed and no job ran. Do not create a new stablecoin authorization automatically; Cashu proof recovery remains in the pending-submission journal. Use request-result for a read-only check.",
      request_id: requestId,
      server_acceptance: "absent",
      payment_state: "unknown",
    },
    409
  );
}

function buildRequestResultResponse(
  c: Context<AppEnv>,
  requestId: string,
  job: JobRecord,
  contentFields: Record<string, unknown>
): Response {
  const status = job.status === "working" ? "processing" : job.status;
  const res: Record<string, unknown> = {
    request_id: requestId,
    job_id: job.id,
    status,
  };
  if (job.requesterToken) res.job_token = job.requesterToken;
  if (job.paymentTransactionHash) res.transaction_hash = job.paymentTransactionHash;
  Object.assign(res, terminalResponseFields(job), contentFields);
  removeUnavailableContent(res);
  return c.json(res, isTerminal(job.status) ? 200 : 202, jobIdentityHeaders(job.id));
}

/**
 * States the body's `job_id` in the response head. An ID outside the field's
 * grammar gets no field rather than one a router or caller would reject. The
 * field goes in at construction: under `@hono/node-server`, a header set on the
 * built response is lost when the x402 settlement path rewraps it.
 */
function jobIdentityHeaders(jobId: string): Record<string, string> {
  return isJobIdentityValue(jobId) ? { [JOB_IDENTITY_HEADER]: jobId } : {};
}

function requestResultNotFound(c: Context<AppEnv>, requestId: string): Response {
  return c.json(
    {
      error: "request_not_found",
      status: "unknown",
      request_id: requestId,
      message: "No matching accepted request is recorded for this caller and request body.",
      hint: "Do not submit or pay for a replacement. Confirm the original request id and caller identity, then retry this read-only lookup.",
    },
    404
  );
}

/**
 * Ceiling for awaiting a just-terminal job's receipt before responding without it.
 */
const TERMINAL_WORK_WAIT_MS = 2000;

/**
 * Floor between opportunistic Tempo settlement sweeps.
 *
 * The cadence a channel actually settles on is `settlementSchedule.intervalMs`
 * (24h in production) and the sweep re-checks it per channel; this only bounds
 * how often a busy DVM pays for the store scan behind that check.
 */
const TEMPO_ROUTINE_SWEEP_MIN_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Reason a configured Tempo session is withheld: close observer or settlement
 * health. Advertised separately from an absent capability so callers can relay it.
 */
type TempoSessionWithheldReason = "observer_unhealthy" | "settlement_unhealthy";

/**
 * Await the terminal chain a handler parked on `job.terminalWork`, capped at
 * {@link TERMINAL_WORK_WAIT_MS}. No-op for a job that hasn't terminated (the
 * common case — the caller polls) or for one that terminated through a path
 * that doesn't park work.
 */
async function awaitTerminalWork(job: ServerJob): Promise<void> {
  if (!job.terminalWork) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    job.terminalWork,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, TERMINAL_WORK_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
}

interface TerminalFieldSource {
  id: string;
  status: JobStatus;
  messages: Message[];
  summary?: string;
  receipt?: JobReceipt;
  fundingReceipt?: FundingReceipt;
  fundingCredit?: CreditSnapshot;
}

function removeUnavailableContent(fields: Record<string, unknown>): void {
  if (fields.content_available === false) {
    delete fields.summary;
    fields.has_artifacts = false;
    delete fields.artifact_count;
    delete fields.payload_in;
  }
}

/**
 * Completed jobs expose summary/artifact location; all terminal outcomes may
 * carry persisted signed receipts. Gate receipt delivery on the response status:
 * signing can precede the terminal snapshot save, so an in-flight row must not
 * expose a terminal receipt yet.
 */
function terminalResponseFields(job: TerminalFieldSource): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (job.status === "completed") {
    if (job.summary !== undefined) fields.summary = job.summary;
    const artifactCount = job.messages.filter((m) => m.type === "artifact").length;
    fields.has_artifacts = artifactCount > 0;
    if (artifactCount > 0) fields.artifact_count = artifactCount;
    fields.payload_in = artifactCount > 0 ? "messages" : "summary";
  }
  if (job.receipt && isTerminal(job.status)) fields.receipt = job.receipt;
  if (job.fundingReceipt && job.fundingCredit) {
    fields.funded_micro = job.fundingReceipt.funded_micro;
    fields.funding_receipt = job.fundingReceipt;
    fields.credit = fundingCreditBody(job.fundingCredit);
  }
  return fields;
}

function fundingCreditBody(credit: CreditSnapshot): Record<string, unknown> {
  return {
    credit_id: credit.creditId,
    currency: credit.currency,
    balance_micro: credit.balanceMicro,
    remaining_micro: credit.availableMicro,
    native_available: credit.nativeAvailable,
    expiry_ms: credit.expiryMs,
    expired: credit.expired,
    status: credit.status,
    ledger_seq: credit.lastLedgerSeq,
    rail: credit.rail,
    ...(credit.tempoChannelId && { tempo_channel_id: credit.tempoChannelId }),
    ...(credit.x402ChannelId && { x402_channel_id: credit.x402ChannelId }),
  };
}

/**
 * Add the exact integer micro amount without mutating the builder's fiat envelope.
 * Free or non-denominable amounts have no exact ledger figure.
 */
function withExactMicro(
  upfront: { amount: number; currency: string },
  exact: PriceFiat | undefined
): Record<string, unknown> {
  return { ...upfront, ...(exact && { amount_micro: exact.amountMicro }) };
}

/**
 * Raw structured input selection shared with auth, narrowed to a plain object.
 * Text input, JSON scalars and absence become {}; a quote schema, when present,
 * parses this result before handler invocation.
 */
function quoteInputData(body: {
  input?: string;
  data?: Record<string, unknown>;
}): Record<string, unknown> {
  const signed = signedRequestInput(body);
  if (signed === null || typeof signed !== "object" || Array.isArray(signed)) return {};
  return signed as Record<string, unknown>;
}

/**
 * Refuse malformed quote results and denomination mismatches before exposing
 * them to callers. dvmCurrency is the ledger denomination, not an FX target.
 */
function validateQuoteResult(result: unknown, dvmCurrency: string): QuoteResult {
  if (!result || typeof result !== "object") {
    throw new InvalidQuoteResultError("onQuote handler did not return an object");
  }
  const r = result as Partial<QuoteResult>;
  if (!r.upfront || typeof r.upfront !== "object") {
    throw new InvalidQuoteResultError("QuoteResult.upfront missing or not an object");
  }
  const u = r.upfront as { amount?: unknown; currency?: unknown };
  if (typeof u.amount !== "number" || !Number.isFinite(u.amount) || u.amount < 0) {
    throw new InvalidQuoteResultError("QuoteResult.upfront.amount must be a non-negative number");
  }
  if (typeof u.currency !== "string") {
    throw new InvalidQuoteResultError("QuoteResult.upfront.currency must be a string");
  }
  validateCurrency(u.currency);
  if (u.currency !== dvmCurrency) {
    throw new QuoteCurrencyMismatchError(u.currency, dvmCurrency);
  }
  // Positive prices must round to a safe integer of at least one fiat micro-unit;
  // otherwise a sats charge would have no recordable ledger denomination. Zero
  // remains legal for jobs that charge later.
  const upfrontMicro = Math.round(u.amount * 1_000_000);
  if (u.amount > 0 && upfrontMicro < 1) {
    throw new InvalidQuoteResultError(
      `QuoteResult.upfront.amount (${u.amount}) is below one micro-unit of ${u.currency} — ` +
        "the ledger cannot denominate it. Quote 0 for a free job, or at least 0.000001."
    );
  }
  if (!Number.isSafeInteger(upfrontMicro)) {
    throw new InvalidQuoteResultError(
      `QuoteResult.upfront.amount (${u.amount}) is too large to denominate in micro-units of ${u.currency}.`
    );
  }
  if (typeof r.description !== "string") {
    throw new InvalidQuoteResultError("QuoteResult.description must be a string");
  }
  return r as QuoteResult;
}

class InvalidQuoteResultError extends Error {
  readonly code = "invalid_quote_result";
}

/**
 * A valid quote in a different currency is provider misconfiguration. Both
 * quote paths return 500, since changing caller input cannot resolve it.
 */
class QuoteCurrencyMismatchError extends Error {
  readonly code = "quote_currency_mismatch";
  constructor(quoted: string, declared: string) {
    super(
      `onQuote priced in ${quoted} but this DVM declares currency: ${JSON.stringify(declared)}. ` +
        `Quote in ${declared}, or change the DVM-level \`currency\` to ${JSON.stringify(quoted)} — ` +
        "the credit ledger denominates per DVM, so the two must agree."
    );
  }
}

/**
 * Both quote paths use the same retryable 503 envelope for FX unavailability.
 */
function pickFxRateUnavailable(
  err: unknown
): { code: string; display?: string; hint?: string; message?: string } | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { code?: unknown; display?: unknown; hint?: unknown; message?: unknown };
  if (e.code !== "fx_rate_unavailable") return null;
  const out: { code: string; display?: string; hint?: string; message?: string } = {
    code: "fx_rate_unavailable",
  };
  if (typeof e.display === "string") out.display = e.display;
  if (typeof e.hint === "string") out.hint = e.hint;
  if (typeof e.message === "string") out.message = e.message;
  return out;
}

/**
 * Preserve a structured error or its cause without coupling to a vendor class.
 * The caller can relay display and hint verbatim.
 */
function pickStructuredError(
  err: unknown
): { code: string; display: string; hint: string; sub_reason?: string } | null {
  const cause = err && typeof err === "object" ? (err as { cause?: unknown }).cause : undefined;
  for (const candidate of [err, cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    const e = candidate as {
      code?: unknown;
      display?: unknown;
      hint?: unknown;
      sub_reason?: unknown;
    };
    if (typeof e.code === "string" && typeof e.display === "string" && typeof e.hint === "string") {
      const out: { code: string; display: string; hint: string; sub_reason?: string } = {
        code: e.code,
        display: e.display,
        hint: e.hint,
      };
      if (typeof e.sub_reason === "string") out.sub_reason = e.sub_reason;
      return out;
    }
  }
  return null;
}

/** Sentinel: auth slot requires a schema but the capability doesn't declare one. */
class AuthSchemaError extends Error {
  constructor() {
    super("Capability has no input schema to verify against");
    this.name = "AuthSchemaError";
  }
}

/** Auth was enabled without a target identity a caller can bind to. */
class AuthAudienceError extends Error {
  constructor() {
    super("secp256k1Auth requires a valid /v1/info builder attestation outside development");
    this.name = "AuthAudienceError";
  }
}

/**
 * `onError` mapper for `dvm.auth.verify` spans: both failure classes
 * (`AuthSchemaError`, `SignedRequestError`) surface as `auth_error` in the
 * response body, so the child span carries the same structured code. Other
 * (unexpected) throws are rethrown to `dvm.request` and left uncoded here.
 */
function authVerifyErrorCode(err: unknown): Record<string, unknown> | undefined {
  return err instanceof AuthSchemaError || err instanceof SignedRequestError
    ? { "error.code": "auth_error" }
    : undefined;
}

class PaymentValidationError extends Error {
  constructor(readonly detail: PaymentErrorDetail) {
    const msg = detail.body.message ?? detail.body.error;
    super(typeof msg === "string" ? msg : "Payment validation failed");
    this.name = "PaymentValidationError";
  }
}

/**
 * Schema failures disclose only the caller-input half; envelope failures are
 * classified by authErrorBody without exposing signing details.
 */
function buildAuthErrorResponse(
  c: Context<AppEnv>,
  err: SignedRequestError,
  publicOrigin: string | undefined
): Response {
  return c.json(authErrorBody(err, { schemaUrl: infoSchemaUrl(c.req.url, publicOrigin) }), 401);
}

/**
 * Validate that message content has the required fields for its type. Returns
 * an error string or null.
 *
 * `dev_auto` is the dev console's stand-in for a wallet: the `/_dev`
 * page has no proofs to send, so its auto-approve button satisfies a mid-job
 * ask with a bare flag. It carries no payment proof and so is admitted **only**
 * on a dev-mode server — `JobManager.processPayment` applies the same gate
 * before crediting, and additionally drops the flag when a proof rides beside
 * it, so this relaxation only ever admits a message that carries no money.
 */
function validateMessageContent(
  type: MessageType,
  content: Record<string, unknown>,
  devMode: boolean
): string | null {
  if (type === "response") {
    if (typeof content.prompt_id !== "string")
      return "response message requires prompt_id (string)";
    if (typeof content.text !== "string") return "response message requires text (string)";
  } else if (type === "payment") {
    if (devMode && content.dev_auto === true) return null;
    if (!hasPaymentProof(content)) {
      return `payment message requires one of ${PAYMENT_PROOF_KEYS.join(", ")}`;
    }
  }
  return null;
}

const MAX_RATES = 5;
const MAX_RATE_AMOUNT_LENGTH = 12;
const MAX_RATE_TEXT_LENGTH = 24;
const RATE_AMOUNT_RE = /^\d+(\.\d+)?$/;
const RATE_KEYS = new Set(["label", "amount", "currency", "per"]);

/**
 * Refuse a rate card that `/v1/info` could not publish exactly as declared.
 * The limits match the independent client parsers (see
 * `protocol-fixtures/capability-rates.json`), so an entry they would drop is
 * refused at start instead of disappearing downstream. The checks run on
 * `unknown` because JavaScript builders bypass the declared type.
 */
function assertCapabilityRates(
  capabilities: Record<string, { price?: unknown; onQuote?: unknown; rates?: unknown }>
): void {
  for (const [name, cap] of Object.entries(capabilities)) {
    if (cap.rates === undefined) continue;
    const refuse = (detail: string): never => {
      throw new Error(`createDVMServer: capability ${JSON.stringify(name)}: ${detail}`);
    };
    const rates = cap.rates;
    if (!Array.isArray(rates) || rates.length === 0 || rates.length > MAX_RATES) {
      refuse(`rates must be an array of 1 to ${MAX_RATES} entries`);
    }
    if (cap.price === undefined && cap.onQuote === undefined) {
      refuse("rates is declared on a free capability; set `price` or `onQuote`, or remove `rates`");
    }
    (rates as unknown[]).forEach((rate, i) => {
      const at = `rates[${i}]`;
      if (typeof rate !== "object" || rate === null || Array.isArray(rate)) {
        refuse(`${at} must be an object with amount, currency and per`);
      }
      const entry = rate as Record<string, unknown>;
      for (const key of Object.keys(entry)) {
        if (!RATE_KEYS.has(key)) refuse(`${at}.${key} is not a rate field (label, amount, currency, per)`);
      }
      const amount = entry.amount;
      if (
        typeof amount !== "string" ||
        amount.length > MAX_RATE_AMOUNT_LENGTH ||
        !RATE_AMOUNT_RE.test(amount) ||
        // Above zero without parsing to a float: some digit is non-zero.
        !/[1-9]/.test(amount)
      ) {
        refuse(
          `${at}.amount must be a decimal dollar string above zero of at most ` +
            `${MAX_RATE_AMOUNT_LENGTH} characters, like "0.00015" (got ${JSON.stringify(amount)})`
        );
      }
      if (entry.currency !== "USD") {
        refuse(`${at}.currency must be "USD" (got ${JSON.stringify(entry.currency)})`);
      }
      assertRateText(entry.per, `${at}.per`, refuse);
      if (entry.label !== undefined) assertRateText(entry.label, `${at}.label`, refuse);
    });
  }
}

function assertRateText(value: unknown, field: string, refuse: (detail: string) => never): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_RATE_TEXT_LENGTH ||
    value.trim() !== value
  ) {
    refuse(
      `${field} must be a string of 1 to ${MAX_RATE_TEXT_LENGTH} characters with no leading or ` +
        `trailing whitespace (got ${JSON.stringify(value)})`
    );
  }
}
