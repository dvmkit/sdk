/** Mppx upgrades require independent-client conformance, beyond same-library round trips. */
import { createHash, randomUUID } from "node:crypto";

import type { Challenge, Credential, Method, Receipt, Store } from "mppx";
import { Credential as MppCredential, Errors as MppxErrors, PaymentRequest } from "mppx";
import { Mppx, tempo } from "mppx/server";
import { Session as TempoSession } from "mppx/tempo";
import type { HostedIntent } from "./hosting-cleanup-fence";
import type { HostedSettlementReportObligations } from "./hosting-settlement-report-obligations";
import type { PostgresTempoChargeStore } from "./tempo-charge-store";
import type { Account, Client, Hex } from "viem";

import { loggers } from "../../observability/loggers";
import type { CreditLedgerLike, CreditLedgerQuerier } from "./credit-ledger";
import type { MppSecretState } from "./mpp-secret-state";
import type {
  TempoSessionCloseForecastDecision,
  TempoSessionCloseForecastResolution,
  TempoSessionCloseRecord,
  TempoSessionLifecycle,
} from "./tempo-session-store";
import { isTempoInsufficientFundsError } from "./tempo-settlement-readiness";

/**
 * Reason string emitted by mppx's `broadcastCredential` when the HMAC binding
 * doesn't match the verifier's `secretKey` (mppx 0.8.15 `src/server/Mppx.ts:608`
 * and `:1210`, both wrapped in `Errors.InvalidChallengeError`). The dual-key
 * wrapper uses this to discriminate "wrong secret, retry with previous" from
 * "credential bad for other reasons" (expiry, schema, etc).
 *
 * Exported so `payment-mpp-dual-key.test.ts` can assert a *real* mppx error
 * still carries it. Nothing else in mppx's public surface distinguishes an
 * HMAC mismatch from any other `InvalidChallengeError`, so a reword upstream
 * would silently stop the rotation retry — rejecting every credential signed
 * with the pre-rotation key for the length of the rotation window.
 */
export const MPPX_HMAC_MISMATCH_REASON = "challenge was not issued by this server";

/**
 * Channel-state field holding the epoch-ms deadline of an in-flight settlement
 * Lives inside the channel's own state rather than a table of its
 * own so the guard rides the `Store.AtomicStore` boundary every backend already
 * implements, and so it is written under the same per-channel lock as every
 * other mutation of that row.
 */
export const TEMPO_SETTLEMENT_LEASE_FIELD = "settlementLeaseUntil";

/** Operation token paired with the settlement lease for ambiguous DB commits. */
export const TEMPO_SETTLEMENT_LEASE_OWNER_FIELD = "settlementLeaseOwner";

/**
 * How long a settlement holds its lease before another path may retry it.
 *
 * Five minutes, and the floor is not negotiable: mppx's `settle` awaits
 * `waitForSuccessfulReceipt`, which calls viem's `waitForTransactionReceipt`
 * with no `timeout` and so inherits its 180-second default. A lease shorter
 * than that lapses while the transaction is still pending, and the sibling
 * machine it exists to hold off claims and broadcasts the duplicate — the
 * process-local marker only covers the machine that is settling. Five minutes
 * clears that ceiling with room for the submission ahead of it, and is still
 * well inside the 900-second unilateral-close grace period, so a lease orphaned
 * by a machine that died mid-broadcast costs at most one settlement round of
 * the protection window. `tempoSession.settlementSchedule.leaseMs` overrides
 * it; keep any override above the receipt timeout for the same reason.
 */
export const TEMPO_SETTLEMENT_LEASE_MS = 300_000;

/** The refusal a settlement path answers while another holds the lease. */
export const TEMPO_SETTLEMENT_IN_FLIGHT = "settlement already in flight";

/**
 * Tempo USDC contract on mainnet (chain id 4217). Pinned here as the default
 * currency so the SDK can advertise concrete defaults at create time —
 * `tempo.charge({})` resolves the same value at runtime via
 * `defaults.resolveCurrency`, but its type-level defaults only include fields
 * explicitly passed, so the challenge handler would otherwise require
 * `currency` per call. Override via `DVMKIT_TEMPO_CURRENCY` for testnet/devnet.
 */
export const TEMPO_USDC_MAINNET = "0x20C000000000000000000000b9537d11c60E8b50";

/** Tempo mainnet chain id. */
export const TEMPO_MAINNET_CHAIN_ID = 4217;

/** Tempo Moderato testnet chain id. */
export const TEMPO_MODERATO_CHAIN_ID = 42431;

/** Default payment token on Tempo Moderato. */
export const TEMPO_PATH_USD_MODERATO = "0x20c0000000000000000000000000000000000000";

/** Tempo Moderato's public RPC endpoint. */
export const TEMPO_MODERATO_RPC = "https://rpc.moderato.tempo.xyz";

/** Hex address shape: `0x` + 40 hex chars (EVM contract / EOA). */
const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Options for assembling an Mppx server handle from explicit recipient strings
 * and the surrounding environment. The SDK boundary owns env reads so DVM
 * authors only think in terms of "set DVMKIT_TEMPO_RECIPIENT /
 * DVMKIT_TEMPO_SECRET_KEY in your DVM env" — same pattern as the existing
 * payment-rail inputs.
 */
export interface MppOpts {
  /**
   * Tempo recipient (0x-prefixed 40-char hex address). When set, registers
   * `tempo/charge`. Supported chains are Tempo mainnet (4217) and Moderato
   * (42431). Currency defaults per chain; override it with
   * `DVMKIT_TEMPO_CURRENCY`.
   */
  tempoRecipient?: string;
  /**
   * Server realm for advertising on `/v1/info`. Default resolution lives in
   * mppx (env vars `MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`, request URL,
   * `"MPP Payment"`).
   */
  realm?: string;
  /**
   * When set, only register MPP methods whose name appears in this list, even
   * if the per-rail env var (`DVMKIT_TEMPO_RECIPIENT`) is configured
   * Lets operators temporarily disable a rail without unsetting
   * other knobs. Empty/undefined falls back to "register everything that has
   * a configured recipient".
   */
  methodsAllowlist?: string[];
  /**
   * Durable replay protection for the one-shot `tempo/charge` method
   * Omit and mppx falls back to `Store.memory()`, whose consumed
   * transaction hashes are per-process — invisible to sibling machines and lost
   * on restart. Pass a cross-machine store (`PostgresTempoChargeStore`) on any
   * multi-instance deploy.
   *
   * The same store also backs mppx's fee-sponsor budget and, because mppx
   * enables proof-credential replay protection only when a store is supplied,
   * turns that guard on as a side effect.
   */
  tempoCharge?: {
    store: Store.AtomicStore;
  };
  /**
   * Durable TIP-1034 session support. Omit to keep the existing one-shot
   * `tempo/charge` method only. The account must be able to submit settlement
   * transactions as the channel payee/operator; an address-only client is not
   * sufficient.
   */
  tempoSession?: {
    store: Store.AtomicStore;
    hostedObligations?: HostedSettlementReportObligations;
    account: Account;
    getClient?: (parameters: { chainId?: number }) => Client | Promise<Client>;
    chainId?: number;
    settlementSchedule?: {
      units?: number;
      amount?: string | bigint;
      intervalMs?: number;
      /**
       * How long a settlement holds its in-flight lease. Defaults to
       * {@link TEMPO_SETTLEMENT_LEASE_MS}, which documents the receipt-timeout
       * floor an override has to stay above.
       */
      leaseMs?: number;
    };
    beforeSessionSettlement?: () => string | undefined | Promise<string | undefined>;
    onSessionSettlement?: (context: {
      txHash: `0x${string}`;
      channelId: `0x${string}`;
      trigger: "settle" | "close" | "scheduled";
      amount: bigint;
      delta: bigint;
      recoveryVersion?: string;
    }) => void | Promise<void>;
    onInsufficientFunds?: (context: {
      operation: "settle";
      channelId: string;
    }) => void | Promise<void>;
  };
}

/**
 * Loose runtime view of an `Mppx.create(...)` handle. mppx's full generic
 * typing is precise but propagates badly through layers — the SDK boundary
 * only needs the method list, the challenge-by-name dispatcher, and
 * `broadcastCredential`. We accept the type-safety loss here in exchange for
 * not threading method generics through every caller (`payment.ts`,
 * `context.ts`, `app.ts`, `serve.ts`, every DVM serve file).
 *
 * Deliberately omits mppx's deprecated `verifyCredential` alias so no caller
 * of ours can reach the un-dual-keyed door — see `createDualKeyMppxFromOpts`.
 */
export interface MppxServer {
  /** Undefined when neither `Mppx.create` nor mppx's environment lookup names a realm. */
  realm?: string;
  methods: readonly Method.AnyServer[];
  /** Public, non-secret Tempo bindings resolved from the exact live method configuration. */
  tempoConfiguration?: {
    recipient: string;
    paymentToken: string;
    chainId: number;
    operator?: string;
    feeToken?: string;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  challenge: any;
  /**
   * Re-validate and broadcast a credential, returning a receipt. Accepting
   * payment is always this mutating path; `validateCredential` below is only
   * the hosted close's preflight.
   */
  broadcastCredential(
    credential: Credential.Credential | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any
  ): Promise<Receipt.Receipt>;
  /** Non-mutating mppx HMAC, route, expiry and method preflight. */
  validateCredential?(
    credential: Credential.Credential | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: any
  ): Promise<Method.Validation>;
  completeHostedTempoCharge?: (challengeId: string) => Promise<void>;
  permitHostedTempoClose?: (credential: Credential.Credential | string, reservationId: string) => void;
  /**
   * Typed dispatcher over `mppx.challenge.<method>.<intent>(opts)`. Localizes
   * the cast across the open challenge dispatcher so callers don't repeat it.
   * Attached to the handle by `createMppFromOpts` (mppx returns a structurally
   * compatible object that doesn't carry this method natively).
   */
  issueChallenge(
    method: string,
    intent: string,
    opts: Record<string, unknown>
  ): Promise<Challenge.Challenge>;
  /**
   * Reconcile active TIP-1034 channels; present only on a durable session
   * handle. `inFlight` counts channels the sweep found due but declined to
   * settle because another path already holds their settlement lease
   * a deferral, not a failure.
   */
  sweepTempoSessions?: () => Promise<{
    scanned: number;
    closeRequested: number;
    settled: number;
    inFlight: number;
  }>;
  /**
   * Reconcile and, if the channel is at risk, settle exactly one TIP-1034
   * channel. The forced-close protection path: a verified on-chain
   * `CloseRequested` event authorises this and nothing else.
   *
   * Needs no `listActive`, unlike {@link sweepTempoSessions} — a store that
   * cannot page can still protect a channel it is told about by name.
   */
  settleTempoSessionChannel?: (channelId: string) => Promise<TempoChannelSettlementOutcome>;
  /** Run verification with voucher acceptance joined to a caller-owned ledger callback. */
  withTempoSessionAcceptance?<value, result>(
    voucher: { channelId: string; cumulativeAmount: bigint },
    commit: (
      tx: CreditLedgerQuerier,
      voucher: {
        key: string;
        cumulativeAmount: bigint;
        priorCumulativeAmount: bigint;
        delta: bigint;
      }
    ) => Promise<result>,
    operation: () => Promise<value>
  ): Promise<{ value: value; result: result | undefined }>;
  /** Persist a cooperative-close intent before broadcasting its credential. */
  beginTempoSessionClose?: (channelId: string, drainId: string) => Promise<void>;
  /** Reserve a close intent and debit its drain in one database transaction. */
  withTempoSessionCloseIntent?<value>(
    channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ): Promise<value>;
  /** Serialize a refund forecast decision with same-drain completion across replicas. */
  resolveTempoSessionCloseForecast?<value>(
    channelId: string,
    drainId: string,
    decision: TempoSessionCloseForecastDecision,
    operation?: (tx: CreditLedgerQuerier) => Promise<value>
  ): Promise<TempoSessionCloseForecastResolution<value>>;
  /** Clear a close intent and restore its drain in one database transaction. */
  releaseTempoSessionCloseIntent?<value>(
    channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ): Promise<value>;
  /** Persist a confirmed cooperative-close transaction before draining the ledger. */
  confirmTempoSessionClose?: (
    channelId: string,
    drainId: string,
    reference: string
  ) => Promise<string>;
  /** Recover a close result after a process failure between chain and ledger commits. */
  recoverTempoSessionClose?: (channelId: string, drainId: string) => Promise<string | null>;
  /**
   * Read a channel's close intent without touching it.
   *
   * The operator repair needs the reference a confirmed close already carries,
   * and it must not be `recoverTempoSessionClose`: that one *writes* — an
   * unconfirmed intent on a finalized channel gets the synthetic
   * `channel:<id>` reference recorded against it, which is a decision the
   * caller's own poll is entitled to make and a repair queue listing is not.
   */
  getTempoSessionCloseIntent?: (channelId: string) => Promise<TempoSessionCloseRecord | null>;
  /** Read terminally consumed value for an exact cooperative-close challenge. */
  getTempoSessionSpent?: (channelId: string) => Promise<bigint>;
  /**
   * Refuse a cooperative close voucher that mppx's close would refuse before
   * submitting, using only the stored channel: no chain read and no write.
   * A hosted close runs it before reserving its settlement-report obligation,
   * so a voucher that could never broadcast does not leave a reservation behind.
   */
  assertTempoSessionCloseVoucher?: (voucher: {
    channelId: string;
    cumulativeAmount: bigint;
    signature: string;
    /** The credential's TIP-1034 channel descriptor, unchecked. */
    descriptor: unknown;
    /** The HMAC-verified challenge request the credential answers. */
    request: Record<string, unknown>;
  }) => Promise<void>;
  /**
   * Read the immutable chain binding of a stored channel, or `null`
   * when this DVM holds no such channel. What a close event must match before
   * it may authorise anything.
   */
  getTempoSessionBinding?: (channelId: string) => Promise<TempoChannelBinding | null>;
  /**
   * Fetch a transaction receipt from this DVM's **own** configured Tempo RPC
   * the independent read that makes a close-event locator
   * self-verifying rather than something the platform asserts.
   */
  getTempoReceipt?: (args: { chainId: number; txHash: `0x${string}` }) => Promise<{
    logs: readonly { address: string; topics: readonly string[]; logIndex: number }[];
  } | null>;
  /**
   * Read what a landed cooperative close actually paid out.
   *
   * mppx decodes `ChannelClosed` while verifying the close credential and then
   * drops both amounts — its session receipt carries only the channel, the
   * accepted cumulative and the transaction hash — so the refund figure the
   * drain's payout floor is sized against exists nowhere but the chain. `null`
   * when this DVM holds no such channel.
   */
  getTempoSessionCloseAmounts?: (args: {
    channelId: string;
    txHash: `0x${string}`;
  }) => Promise<TempoChannelCloseAmounts | null>;
  /** Reconcile one channel to chain state before deciding how its drain proceeds. */
  getTempoSessionDrainState?: (channelId: string) => Promise<TempoSessionDrainState>;
  /** Bind the credit ledger that must be terminalized when Tempo backing is lost. */
  useTempoCreditLedger?: (ledger: CreditLedgerLike) => void;
}

/** What a `ChannelClosed` event split the escrow into. Atomic token units. */
export interface TempoChannelCloseAmounts {
  /** Amount captured by the payee — this DVM. */
  settledToPayee: bigint;
  /** Amount refunded to the payer — what a cooperative drain owes the caller. */
  refundedToPayer: bigint;
}

/**
 * What a targeted single-channel settlement did.
 *
 * The platform's close observer acknowledges its durable event on a terminal
 * outcome and retries otherwise, so the distinctions here are a delivery
 * contract, not diagnostics:
 *
 * - `settled` — a settlement transaction landed for this channel.
 * - `already_safe` — the on-chain watermark already covers every accepted
 * voucher, so there is nothing to protect. A replay lands here.
 * - `unknown_channel` — not in this DVM's durable store. Terminal: a DVM must
 * never settle a channel it does not own.
 * - `finalized_before_protection` — the channel finalized while it still owed
 * us value. A **money incident**, not a success: the grace period elapsed
 * without settlement and the deposit is gone. Preserved and paged, never
 * quietly acknowledged.
 * - `retryable_failure` — a chain read or settlement attempt failed, or another
 * path is already broadcasting a settlement for this channel. The
 * event stays pending and is retried inside the grace period.
 */
export type TempoChannelSettlementOutcome =
  | { outcome: "settled"; channelId: string; settledAmount: bigint }
  | { outcome: "already_safe"; channelId: string; settledOnChain: bigint }
  | { outcome: "unknown_channel"; channelId: string }
  | {
      outcome: "finalized_before_protection";
      channelId: string;
      owed: bigint;
      settledOnChain: bigint;
    }
  | { outcome: "retryable_failure"; channelId: string; error: string };

/**
 * The immutable chain identity a TIP-1034 channel was opened against
 *
 * Doubles as the close-event authorisation record and as what the DVM reports
 * to the platform so a close can be routed back to it. `payee` is the DVM's
 * on-chain recipient, which is what the platform falls back to when an event
 * arrives before its channel registration.
 */
export interface TempoChannelBinding {
  chainId: number;
  escrowContract: string;
  payee?: string;
}

/** Chain-reconciled fields that govern a Tempo cooperative credit drain. */
export interface TempoSessionDrainState {
  spent: bigint;
  settledOnChain: bigint;
  closeRequestedAt: bigint;
  deposit: bigint;
  finalized: boolean;
}

/**
 * Read a challenge's server-defined correlation data (`{ path, nonce }` on our
 * paid routes) as a record, whichever half of mppx's split shape it arrived in.
 *
 * mppx 0.8.x separated the two: `meta` is the parsed record, `opaque` its
 * base64url wire form — where 0.6.x put the record on `opaque` itself. A
 * challenge we just issued carries both; one recovered from a credential off
 * the wire (`Credential.deserialize`) carries only `opaque`, because the record
 * never travels. The call sites in `payment.ts` have to *read* it to build the
 * expected meta they hand back to verify.
 *
 * `opaque` wins when both are present, deliberately. It is the slot the
 * challenge id's HMAC covers (mppx 0.8.15 `src/Challenge.ts:667`), and mppx's
 * own `hydrateCredentialMeta` (`src/server/Mppx.ts:2106`) overwrites `meta`
 * from it before comparing — so reading `meta` first would derive the
 * *expected* binding from an unauthenticated field while mppx derives the
 * *actual* one from the signed field. That divergence is reachable: on the
 * mid-job path the whole credential, `meta` included, arrives in the caller's
 * JSON body. It fails closed either way (a tampered `meta` simply mismatches),
 * but both sides should read the same source.
 *
 * Returns `undefined` on an unparseable `opaque` rather than throwing: it is
 * HMAC-bound, so a mangled one belongs in mppx's binding-mismatch 402, not in
 * a 500 raised before verification ever runs.
 */
export function challengeMeta(challenge: Challenge.Challenge): Record<string, string> | undefined {
  if (challenge.opaque) {
    try {
      return PaymentRequest.deserialize(challenge.opaque) as Record<string, string>;
    } catch {
      return undefined;
    }
  }
  return challenge.meta;
}

/**
 * Build an `Mppx.create(...)` handle from `opts` and `env`. Returns
 * `undefined` when no rail is configured (no `tempoRecipient`). Throws when
 * a rail is configured but `DVMKIT_TEMPO_SECRET_KEY` is missing — HMAC binding
 * is non-optional for stateless verification.
 */
export function createMppFromOpts(
  opts: MppOpts = {},
  env: NodeJS.ProcessEnv = process.env
): MppxServer | undefined {
  const built = buildMppMethods(opts, env);
  if (!built) return undefined;

  const secretKey = env.DVMKIT_TEMPO_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "Tempo requires DVMKIT_TEMPO_SECRET_KEY env var. Generate one with 'openssl rand -hex 32'."
    );
  }

  return Object.assign(
    attachTempoSessionRuntime(
      wrapMppx(
        Mppx.create({
          methods: built.methods,
          secretKey,
          ...(opts.realm && { realm: opts.realm }),
        })
      ),
      opts.tempoSession
    ),
    { tempoConfiguration: built.tempoConfiguration }
  );
}

/**
 * Like {@link createMppFromOpts}, but wraps `broadcastCredential` with a
 * dual-key fallback. On HMAC mismatch against the active env secret, the
 * wrapper consults `stateLoader()` (a fresh read of `mpp_secret_state`)
 * and retries with the previous secret if it's still inside the rotation
 * window. Signing always uses the active secret (env-bound).
 *
 * A transient mppx handle is constructed per retry rather than caching
 * two long-lived handles. mppx's `Mppx.create()` is in-memory only —
 * cheap enough that paying the construction cost only on the slow path
 * (HMAC mismatch) keeps the steady-state verify path identical to the
 * single-key flow.
 */
export function createDualKeyMppxFromOpts(
  opts: MppOpts,
  env: NodeJS.ProcessEnv,
  stateLoader: () => Promise<MppSecretState | null>
): MppxServer | undefined {
  const built = buildMppMethods(opts, env);
  if (!built) return undefined;

  const activeSecret = env.DVMKIT_TEMPO_SECRET_KEY;
  if (!activeSecret) {
    throw new Error(
      "Tempo requires DVMKIT_TEMPO_SECRET_KEY env var. Generate one with 'openssl rand -hex 32'."
    );
  }

  const activeMppx = Object.assign(
    attachTempoSessionRuntime(
      wrapMppx(
        Mppx.create({
          methods: built.methods,
          secretKey: activeSecret,
          ...(opts.realm && { realm: opts.realm }),
        })
      ),
      opts.tempoSession
    ),
    { tempoConfiguration: built.tempoConfiguration }
  );

  // Capture the original broadcast before reassignment — `Object.assign`
  // below mutates `activeMppx.broadcastCredential` to the wrapped version, so
  // calling `activeMppx.broadcastCredential(...)` inside the wrapper would
  // recurse into itself. Bind to the original via the underlying handle.
  const activeVerify: MppxServer["broadcastCredential"] =
    activeMppx.broadcastCredential.bind(activeMppx);
  const activeValidate = activeMppx.validateCredential?.bind(activeMppx);

  const validateWithDualKey: NonNullable<MppxServer["validateCredential"]> = async (
    credential, verifyOpts
  ) => {
    if (!activeValidate) throw new Error("Tempo credential validation is unavailable");
    try {
      return await activeValidate(credential, verifyOpts);
    } catch (err) {
      if (!isHmacMismatch(err)) throw err;
      const state = await stateLoader();
      const previous = state?.previous;
      if (!previous) throw err;
      const previousMppx = wrapMppx(Mppx.create({
        methods: built.methods,
        secretKey: previous.secret,
        ...(opts.realm && { realm: opts.realm }),
      }));
      if (!previousMppx.validateCredential) {
        throw new Error("Tempo rotated-key credential validation is unavailable");
      }
      return previousMppx.validateCredential(credential, verifyOpts);
    }
  };

  const verifyWithDualKey: MppxServer["broadcastCredential"] = async (credential, verifyOpts) => {
    try {
      return await activeVerify(credential, verifyOpts);
    } catch (err) {
      if (!isHmacMismatch(err)) throw err;
      const state = await stateLoader();
      const previous = state?.previous;
      if (!previous) {
        if (state?.rapidRotationAtMs != null) {
          throw decorateRapidRotation(err, state.rapidRotationAtMs);
        }
        throw err;
      }
      const previousMppx = wrapMppx(
        Mppx.create({
          methods: built.methods,
          secretKey: previous.secret,
          ...(opts.realm && { realm: opts.realm }),
        })
      );
      try {
        return await previousMppx.broadcastCredential(credential, verifyOpts);
      } catch (retryErr) {
        if (state.rapidRotationAtMs != null) {
          throw decorateRapidRotation(retryErr, state.rapidRotationAtMs);
        }
        throw retryErr;
      }
    }
  };

  // Both names, deliberately. mppx keeps `verifyCredential` as a deprecated
  // alias by assigning *the same function reference* to a second property on
  // the returned (unfrozen) handle — `verifyCredentialFn = broadcastCredentialFn`
  // at mppx 0.8.15 `src/server/Mppx.ts:787`. Overriding only `broadcastCredential`
  // would leave the alias pointing at the raw, un-dual-keyed function, so
  // anything reaching for it — a future call site, a DVM poking the handle —
  // would skip the previous-secret retry and reject every credential signed
  // with the pre-rotation key until the rotation window closed. `MppxServer`
  // doesn't declare the alias, so this is defence against a door our own types
  // can't see rather than something we call.
  return Object.assign(activeMppx, {
    broadcastCredential: verifyWithDualKey,
    verifyCredential: verifyWithDualKey,
    validateCredential: validateWithDualKey,
  });
}

/** Install the hosted charge reservation ahead of either active or rotated-key broadcast. */
export function installHostedTempoChargeGuard(
  server: MppxServer, store: PostgresTempoChargeStore
): void {
  const broadcast = server.broadcastCredential.bind(server);
  const guarded: MppxServer["broadcastCredential"] = async (input, options) => {
    const credential = typeof input === "string"
      ? (await import("mppx")).Credential.deserialize(input) : input;
    if (credential.challenge.intent !== "charge") return broadcast(input, options);
    const intent = (options as { hostedPaymentIntent?: HostedIntent } | undefined)?.hostedPaymentIntent;
    if (!intent || (intent.jobId === undefined && intent.admissionId === undefined)) {
      throw new Error("Hosted Tempo charge has no original payment intent");
    }
    const serialized = typeof input === "string"
      ? input : (await import("mppx")).Credential.serialize(input);
    await store.reserveHostedCharge(serialized, intent);
    const { hostedPaymentIntent: _reserved, ...railOptions } = options ?? {};
    return broadcast(input, railOptions);
  };
  Object.assign(server, {
    broadcastCredential: guarded,
    verifyCredential: guarded,
    completeHostedTempoCharge: (id: string) => store.completeHostedCharge(id),
  });
}

/** Only the authenticated credit drain may present a pre-reserved close to mppx. */
export function installHostedTempoCloseGuard(
  server: MppxServer, obligations: HostedSettlementReportObligations
): void {
  const permits = new Map<string, string>();
  const digest = (input: Credential.Credential | string): string => {
    const credential = typeof input === "string" ? MppCredential.deserialize(input) : input;
    return createHash("sha256").update(MppCredential.serialize(credential)).digest("hex");
  };
  const broadcast = server.broadcastCredential.bind(server);
  const guarded: MppxServer["broadcastCredential"] = async (input, options) => {
    const credential = typeof input === "string" ? MppCredential.deserialize(input) : input;
    const payload = credential.payload as { action?: unknown; channelId?: unknown };
    if (credential.challenge.intent !== "session" || payload.action !== "close") {
      return broadcast(input, options);
    }
    if (typeof payload.channelId !== "string") throw new Error("Hosted Tempo close has no channel");
    const key = digest(input);
    const reservationId = permits.get(key);
    if (!reservationId) throw new Error("Hosted Tempo close has no authenticated original drain permit");
    permits.delete(key);
    await obligations.assertReservedTempoClose(reservationId, payload.channelId);
    return broadcast(input, options);
  };
  Object.assign(server, {
    broadcastCredential: guarded,
    verifyCredential: guarded,
    permitHostedTempoClose: (credential: Credential.Credential | string, reservationId: string) => {
      permits.set(digest(credential), reservationId);
    },
  });
}

/**
 * Shared method-build path between {@link createMppFromOpts} and
 * {@link createDualKeyMppxFromOpts}. Returns `undefined` when no rail is
 * configured (no `tempoRecipient`) or when the allowlist gates every
 * available rail — matches the prior "drop `tempo` from advertised methods"
 * behaviour. Throws on malformed recipient / currency at boot.
 */
function buildMppMethods(
  opts: MppOpts,
  env: NodeJS.ProcessEnv
):
  | {
      methods: Method.AnyServer[];
      tempoConfiguration: NonNullable<MppxServer["tempoConfiguration"]>;
    }
  | undefined {
  if (!opts.tempoRecipient) return undefined;

  const allowlist = opts.methodsAllowlist;
  const isAllowed = (name: string): boolean =>
    !allowlist || allowlist.length === 0 || allowlist.includes(name);

  const methods: Method.AnyServer[] = [];
  let tempoConfiguration: NonNullable<MppxServer["tempoConfiguration"]> | undefined;

  if (isAllowed("tempo")) {
    if (!HEX_ADDRESS_RE.test(opts.tempoRecipient)) {
      // Reject malformed recipients at boot rather than letting a typo land a
      // broken `tempo.charge` on the wire (challenges still issue, clients
      // sign, on-chain transfers fail at settlement). The CLI side already
      // enforces hex shape on the wallet apiKey; mirror it here.
      throw new Error(
        `DVMKIT_TEMPO_RECIPIENT must be a 0x-prefixed 40-char hex address; got '${opts.tempoRecipient}'.`
      );
    }
    const { chainId, currency: tempoCurrency } = resolveTempoNetwork(env);
    if (!HEX_ADDRESS_RE.test(tempoCurrency)) {
      throw new Error(
        `DVMKIT_TEMPO_CURRENCY must be a 0x-prefixed 40-char hex address; got '${tempoCurrency}'.`
      );
    }
    if (
      opts.tempoSession?.chainId !== undefined &&
      opts.tempoSession.chainId !== chainId
    ) {
      throw new Error(
        `Tempo session chain ${opts.tempoSession.chainId} does not match the configured Tempo chain ${chainId}.`
      );
    }
    tempoConfiguration = {
      recipient: opts.tempoRecipient,
      paymentToken: tempoCurrency,
      chainId,
      ...(opts.tempoSession && {
        operator: opts.tempoSession.account.address,
        feeToken: tempoCurrency,
      }),
    };
    methods.push(
      tempo.charge({
        recipient: opts.tempoRecipient as `0x${string}`,
        currency: tempoCurrency as `0x${string}`,
        // mppx resolves the route's verification requirement from `testnet`.
        // Passing `chainId` only adds a challenge default, so a Moderato
        // challenge can otherwise be re-derived as mainnet when the credential
        // returns and fail before payment verification.
        testnet: chainId === TEMPO_MODERATO_CHAIN_ID,
        decimals: 6,
        // Without this mppx installs `Store.memory()`, so the consumed-hash
        // guard is per-process and a credential replayed onto a sibling machine
        // (or after a restart) reaches a broadcast the chain then rejects
        // instead of a cheap refusal.
        ...(opts.tempoCharge && { store: opts.tempoCharge.store }),
      })
    );
    if (opts.tempoSession) {
      methods.push(withAuthenticationOnlyValidation(
        tempo.session({
          recipient: opts.tempoRecipient as `0x${string}`,
          account: opts.tempoSession.account,
          operator: opts.tempoSession.account.address,
          currency: tempoCurrency as `0x${string}`,
          // A server-driven settle/close must spend fees from the same TIP-20
          // token the channel carries. Leaving this implicit lets an account's
          // stale fee preference win even when that token has too little left
          // to broadcast, while the channel token is funded.
          feeToken: tempoCurrency as `0x${string}`,
          decimals: 6,
          unitType: "request",
          store: opts.tempoSession.store,
          channelStateTtl: 5_000,
          // dvmkit's watcher owns scheduled settlement because it gates on
          // terminal ledger consumption. mppx's in-request scheduler settles
          // the full accepted voucher and can capture caller-owned balance.
          chainId: opts.tempoSession.chainId ?? chainId,
          ...(opts.tempoSession.getClient && { getClient: opts.tempoSession.getClient }),
          ...(opts.tempoSession.onSessionSettlement && {
            onSessionSettlement: opts.tempoSession.onSessionSettlement,
          }),
        })
      ));
    }
  }

  if (methods.length === 0 || !tempoConfiguration) return undefined;
  // Method.AnyServer intentionally erases method generics to `any` at the SDK boundary.

  return { methods, tempoConfiguration };
}

/**
 * Give a method without a non-mutating `validate` hook one that accepts what
 * mppx has already authenticated.
 *
 * mppx 0.8.15's `tempo/session` has no `validate`, so `validateCredential`
 * refuses it outright and a hosted close, which must authenticate before it
 * reserves its settlement-report obligation, could never broadcast. Before
 * calling `validate`, mppx's `validateCredential` has already checked the
 * challenge HMAC, expiry, payload schema and route binding (amount, path and
 * nonce), which is the authentication the hosted preflight needs. Voucher
 * signature and channel-state checks still run inside the broadcast, which
 * re-verifies everything. mppx 0.8.15 runs `validate` ahead of a broadcast
 * only for a method that also defines `broadcast`; `tempo/session` defines
 * only `verify`, so payment acceptance does not reach this hook. A method that
 * ships its own `validate` keeps it.
 */
function withAuthenticationOnlyValidation(method: Method.AnyServer): Method.AnyServer {
  if (method.validate) return method;
  const validate = async ({ credential, request }: {
    credential: Credential.Credential;
    request: Record<string, unknown>;
  }): Promise<Method.Validation> => ({
    challenge: credential.challenge,
    credential,
    details: undefined,
    intent: method.intent,
    method: method.name,
    request,
    ...(credential.source !== undefined && { source: credential.source }),
  });
  return { ...method, validate } as Method.AnyServer;
}

/** Resolve the mainnet (4217) or Moderato (42431) identity used by every host payment path. */
export function resolveTempoNetwork(env: NodeJS.ProcessEnv): {
  chainId: number;
  currency: string;
  testnet: boolean;
} {
  const testnet = env.DVMKIT_TEMPO_TESTNET === "1" || env.DVMKIT_TEMPO_TESTNET === "true";
  const rawChainId = env.DVMKIT_TEMPO_CHAIN_ID?.trim();
  const chainId = rawChainId
    ? Number(rawChainId)
    : testnet
      ? TEMPO_MODERATO_CHAIN_ID
      : TEMPO_MAINNET_CHAIN_ID;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error(
      `DVMKIT_TEMPO_CHAIN_ID must be a positive safe integer; got '${env.DVMKIT_TEMPO_CHAIN_ID}'.`
    );
  }
  if (chainId !== TEMPO_MAINNET_CHAIN_ID && chainId !== TEMPO_MODERATO_CHAIN_ID) {
    throw new Error(
      `DVMKIT_TEMPO_CHAIN_ID must be ${TEMPO_MAINNET_CHAIN_ID} (mainnet) or ${TEMPO_MODERATO_CHAIN_ID} (Moderato); got '${chainId}'.`
    );
  }

  const currency =
    env.DVMKIT_TEMPO_CURRENCY ??
    (chainId === TEMPO_MODERATO_CHAIN_ID ? TEMPO_PATH_USD_MODERATO : TEMPO_USDC_MAINNET);
  const normalizedCurrency = currency.toLowerCase();
  if (
    chainId === TEMPO_MODERATO_CHAIN_ID &&
    normalizedCurrency === TEMPO_USDC_MAINNET.toLowerCase()
  ) {
    throw new Error(
      `DVMKIT_TEMPO_CURRENCY ${currency} is incompatible with DVMKIT_TEMPO_CHAIN_ID ${chainId}.`
    );
  }
  return { chainId, currency, testnet };
}

/**
 * True when `err` is mppx's HMAC-mismatch failure — credential's challenge
 * was not signed by this verifier's `secretKey`. Keyed on the class *and*
 * {@link MPPX_HMAC_MISMATCH_REASON}, which `payment-mpp-dual-key.test.ts`
 * pins against a real mppx error. On match, the dual-key wrapper retries with
 * the previous secret; on miss it re-throws so callers see the original error
 * class (expiry, schema, scope, etc).
 */
function isHmacMismatch(err: unknown): boolean {
  if (!(err instanceof MppxErrors.InvalidChallengeError)) return false;
  return typeof err.message === "string" && err.message.includes(MPPX_HMAC_MISMATCH_REASON);
}

/**
 * Rewrap a verification failure with a rapid-rotation marker so
 * `logCredentialRejected` in `payment.ts` surfaces the case to operators.
 * Only called when `mpp_secret_state.rapid_rotation_at` is non-null and
 * within the current rotation window — the only reproducible cause of a
 * verify-fail that names the rapid-rotation failure mode.
 */
function decorateRapidRotation(original: unknown, rapidRotationAtMs: number): Error {
  const base = original instanceof Error ? original : new Error(String(original));
  const decorated = new Error(
    `${base.message} (rapid_rotation=true; last_rotation_at_ms=${rapidRotationAtMs})`
  );
  decorated.name = base.name;
  decorated.stack = base.stack;
  return decorated;
}

/**
 * Attach the typed `issueChallenge` dispatcher to a freshly-created mppx
 * handle. Production builds via `createMppFromOpts`; tests build via
 * `Mppx.create(...)` directly and use `wrapMppx` to satisfy the SDK boundary.
 *
 * Accepts `unknown` because mppx's `Mppx<methods, transport>` generic doesn't
 * collapse cleanly through `ReturnType<typeof Mppx.create>` — the default
 * pins `methods: readonly []` and rejects any concrete method tuple. We cast
 * inside the wrapper instead of leaking the generic onto every caller.
 */
export function wrapMppx(mppx: unknown): MppxServer {
  const dispatcher = (mppx as { challenge: unknown }).challenge as Record<
    string,
    Record<string, ((o: Record<string, unknown>) => Promise<Challenge.Challenge>) | undefined>
  >;
  const server = mppx as MppxServer;
  const issueChallenge: MppxServer["issueChallenge"] = (method, intent, o) => {
    const handler = dispatcher[method][intent];
    if (!handler) {
      throw new Error(`Mppx: no challenge handler registered for ${method}/${intent}`);
    }
    const chainId = method === "tempo" ? server.tempoConfiguration?.chainId : undefined;
    return handler(chainId === undefined ? o : { chainId, ...o });
  };
  return Object.assign(server, { issueChallenge });
}

interface TempoSessionState {
  channelId: Hex;
  chainId: number;
  escrowContract: `0x${string}`;
  token: `0x${string}`;
  closeRequestedAt: bigint;
  deposit: bigint;
  finalized: boolean;
  highestVoucherAmount: bigint;
  spent: bigint;
  settledOnChain: bigint;
  createdAt?: string;
  lastSettlementAt?: string;
}

type ReconcileStore = Store.AtomicStore & {
  listActive?: (
    limit?: number,
    cursor?: { updatedAt: number; key: string }
  ) => Promise<{ key: string; state: Record<string, unknown>; updatedAt: number }[]>;
  withVoucherAcceptance?: <value, result>(
    voucher: { channelId: string; cumulativeAmount: bigint },
    commit: (
      tx: CreditLedgerQuerier,
      voucher: {
        key: string;
        cumulativeAmount: bigint;
        priorCumulativeAmount: bigint;
        delta: bigint;
      }
    ) => Promise<result>,
    operation: () => Promise<value>
  ) => Promise<{ value: value; result: result | undefined }>;
  beginClose?: (channelId: string, drainId: string) => Promise<unknown>;
  withCloseIntent?: <value>(
    channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ) => Promise<value>;
  resolveCloseForecast?: <value>(
    channelId: string,
    drainId: string,
    decision: TempoSessionCloseForecastDecision,
    operation?: (tx: CreditLedgerQuerier) => Promise<value>
  ) => Promise<TempoSessionCloseForecastResolution<value>>;
  releaseCloseIntent?: <value>(
    channelId: string,
    drainId: string,
    operation: (tx: CreditLedgerQuerier) => Promise<value>
  ) => Promise<value>;
  getClose?: (
    channelId: string
  ) => Promise<{ channelId: string; drainId: string; reference: string | null } | null>;
  confirmClose?: (
    channelId: string,
    drainId: string,
    reference: string
  ) => Promise<{ reference: string | null }>;
  withFinalizedCreditLoss?: <value>(
    channelId: string,
    operation: (tx: CreditLedgerQuerier, lifecycle: TempoSessionLifecycle) => Promise<value>
  ) => Promise<value>;
};

interface TempoSessionChainOps {
  getChannelStatesBatch(
    client: Client,
    channelIds: readonly Hex[],
    escrowContract: `0x${string}`
  ): Promise<{ settled: bigint; deposit: bigint; closeRequestedAt: number }[]>;
  settle(
    store: Store.AtomicStore,
    client: Client,
    channelId: Hex,
    options: {
      account: Account;
      escrowContract: `0x${string}`;
      feeToken: `0x${string}`;
      onSessionSettlement?: NonNullable<MppOpts["tempoSession"]>["onSessionSettlement"];
    }
  ): Promise<Hex>;
  readChannelClose(client: Client, channelId: Hex, txHash: Hex): Promise<TempoChannelCloseAmounts>;
  /**
   * The transaction that emitted this channel's `ChannelClosed`, searched back
   * from the chain head no further than blocks older than `notBeforeMs`. Null
   * only when that whole range was searched and holds no close.
   */
  findChannelClose(
    client: Client,
    channelId: Hex,
    escrowContract: `0x${string}`,
    notBeforeMs: number
  ): Promise<Hex | null>;
}

/** Blocks per `eth_getLogs` call, inside the default range cap of common Tempo RPC nodes. */
const TEMPO_CLOSE_LOG_WINDOW = 5_000n;
/** Clock skew tolerated between this host and block timestamps. */
const TEMPO_CLOSE_LOG_SLACK_MS = 10 * 60 * 1_000;
const TEMPO_CLOSE_LOG_MAX_WINDOWS = 500;

const DEFAULT_TEMPO_SESSION_CHAIN_OPS: TempoSessionChainOps = {
  getChannelStatesBatch: TempoSession.Precompile.Chain.getChannelStatesBatch,
  settle: TempoSession.Server.settle,
  readChannelClose: async (client, channelId, txHash) =>
    TempoSession.Precompile.Chain.readChannelClosedReceiptFields(
      TempoSession.Precompile.Chain.getChannelEvent(
        await TempoSession.Precompile.Chain.waitForSuccessfulReceipt(client as never, txHash),
        "ChannelClosed",
        channelId
      )
    ),
  findChannelClose: async (client, channelId, escrowContract, notBeforeMs) => {
    const { getBlock, getBlockNumber, getLogs } = await import("viem/actions");
    const event = TempoSession.Precompile.escrowAbi.find(
      (item) => item.type === "event" && item.name === "ChannelClosed"
    );
    if (!event || event.type !== "event") throw new Error("Tempo escrow ABI has no ChannelClosed event");
    let toBlock = await getBlockNumber(client as never);
    for (let window = 0; window < TEMPO_CLOSE_LOG_MAX_WINDOWS; window += 1) {
      const fromBlock = toBlock >= TEMPO_CLOSE_LOG_WINDOW ? toBlock - TEMPO_CLOSE_LOG_WINDOW + 1n : 0n;
      const logs = await getLogs(client as never, {
        address: escrowContract,
        event,
        args: { channelId },
        fromBlock,
        toBlock,
      });
      const closed = logs.find((log) => log.transactionHash);
      if (closed?.transactionHash) return closed.transactionHash;
      if (fromBlock === 0n) return null;
      const start = await getBlock(client as never, { blockNumber: fromBlock });
      if (Number(start.timestamp) * 1_000 < notBeforeMs - TEMPO_CLOSE_LOG_SLACK_MS) return null;
      toBlock = fromBlock - 1n;
    }
    throw new Error(`Tempo close search for channel ${channelId} exceeded its block budget`);
  },
};

function attachTempoSessionRuntime(
  mppx: MppxServer,
  config: MppOpts["tempoSession"],
  // Per-op rather than all-or-nothing, so a test stubbing the reads its path
  // uses doesn't have to restate the ones it doesn't. An op nobody overrode
  // still runs mppx's own, against whatever client `getClient` hands back.
  chainOpOverrides: Partial<TempoSessionChainOps> = {}
): MppxServer {
  let creditLedger: CreditLedgerLike | undefined;
  Object.assign(mppx, {
    useTempoCreditLedger: (ledger: CreditLedgerLike) => {
      creditLedger = ledger;
    },
  });
  const chainOps: TempoSessionChainOps = {
    ...DEFAULT_TEMPO_SESSION_CHAIN_OPS,
    ...chainOpOverrides,
  };
  const store = config?.store as ReconcileStore | undefined;
  if (store?.withVoucherAcceptance) {
    Object.assign(mppx, {
      withTempoSessionAcceptance: store.withVoucherAcceptance.bind(store),
    });
  }
  if (store) {
    Object.assign(mppx, {
      assertTempoSessionCloseVoucher: async (voucher: {
        channelId: string;
        cumulativeAmount: bigint;
        signature: string;
        descriptor: unknown;
        request: Record<string, unknown>;
      }) => {
        // The same refusals, in the same order, as mppx 0.8.15's close
        // verification ahead of its submit: the descriptor checks first, then
        // the stored channel. Nothing here reads the chain or writes.
        const descriptor = readChannelDescriptor(voucher.descriptor);
        if (!descriptor) {
          throw new MppxErrors.VerificationFailedError({
            reason: "descriptor required for TIP-1034 session action",
          });
        }
        const details = isStateRecord(voucher.request.methodDetails)
          ? voucher.request.methodDetails
          : {};
        const stored = await store.get(voucher.channelId.toLowerCase());
        const state = readTempoSessionState(stored);
        const chainId = typeof details.chainId === "number" ? details.chainId : state?.chainId;
        const escrow = typeof details.escrowContract === "string"
          ? details.escrowContract
          : state?.escrowContract;
        if (chainId === undefined || escrow === undefined) {
          throw new MppxErrors.VerificationFailedError({ reason: "invalid session request" });
        }
        const computed = TempoSession.Precompile.Channel.computeId({
          ...descriptor,
          chainId,
          escrow: escrow as `0x${string}`,
        });
        if (computed.toLowerCase() !== voucher.channelId.toLowerCase()) {
          throw new MppxErrors.VerificationFailedError({
            reason: "channel descriptor does not match channelId",
          });
        }
        if (!sameHex(descriptor.payee, voucher.request.recipient)) {
          throw new MppxErrors.VerificationFailedError({
            reason: "channel descriptor payee does not match server destination",
          });
        }
        if (!sameHex(descriptor.token, voucher.request.currency)) {
          throw new MppxErrors.VerificationFailedError({
            reason: "channel descriptor token does not match server token",
          });
        }
        if (!sameHex(descriptor.operator, details.operator ?? ZERO_ADDRESS)) {
          throw new MppxErrors.VerificationFailedError({
            reason: "channel descriptor operator does not match server operator",
          });
        }
        if (!state || !isStateRecord(stored)) {
          throw new MppxErrors.ChannelNotFoundError({ reason: "channel not found" });
        }
        if (stored.backend !== "precompile") {
          throw new MppxErrors.VerificationFailedError({
            reason: "channel is not precompile-backed",
          });
        }
        const storedDescriptor = readChannelDescriptor(stored.descriptor);
        if (!storedDescriptor || !sameDescriptor(descriptor, storedDescriptor)) {
          throw new MppxErrors.VerificationFailedError({
            reason: "credential descriptor does not match stored channel",
          });
        }
        const signer = stored.authorizedSigner;
        if (typeof signer !== "string" || !HEX_ADDRESS_RE.test(signer)) {
          throw new MppxErrors.ChannelNotFoundError({ reason: "channel not found" });
        }
        if (state.finalized) {
          throw new MppxErrors.ChannelClosedError({ reason: "channel is already finalized" });
        }
        if (state.closeRequestedAt !== 0n) {
          throw new MppxErrors.ChannelClosedError({ reason: "channel has a pending close request" });
        }
        if (state.deposit === 0n && (voucher.cumulativeAmount !== 0n || state.spent !== 0n)) {
          throw new MppxErrors.ChannelClosedError({ reason: "channel deposit is zero (settled)" });
        }
        if (voucher.cumulativeAmount < state.spent) {
          throw new MppxErrors.VerificationFailedError({
            reason: `close voucher amount must be >= ${state.spent} (spent)`,
          });
        }
        if (voucher.cumulativeAmount < state.settledOnChain) {
          throw new MppxErrors.VerificationFailedError({
            reason: `close voucher amount must be >= ${state.settledOnChain} (on-chain settled)`,
          });
        }
        const valid = TempoSession.Precompile.Voucher.verifyVoucher(
          escrow as `0x${string}`,
          chainId,
          {
            channelId: voucher.channelId as Hex,
            cumulativeAmount: voucher.cumulativeAmount,
            signature: voucher.signature as Hex,
          },
          signer as `0x${string}`
        );
        if (!valid) {
          throw new MppxErrors.InvalidSignatureError({ reason: "invalid voucher signature" });
        }
        if (maxBigInt(state.spent, state.settledOnChain) > state.deposit) {
          throw new MppxErrors.AmountExceedsDepositError({
            reason: "close capture amount exceeds on-chain deposit",
          });
        }
      },
      getTempoSessionSpent: async (channelId: string) => {
        const state = readTempoSessionState(await store.get(channelId.toLowerCase()));
        if (!state) throw new Error(`Tempo session channel ${channelId} not found`);
        return state.spent;
      },
    });
  }
  const getClient = config?.getClient;
  const listActive = store?.listActive;
  if (!config || !getClient || !store) return mppx;

  const terminalizeLostBacking = async (
    channel: TempoSessionState,
    chainState: { settled: bigint; deposit: bigint }
  ): Promise<void> => {
    if (chainState.deposit !== 0n) return;
    if (!creditLedger) return;
    const ledger = creditLedger;
    const retire = async (
      lifecycle: Pick<TempoSessionLifecycle, "settledOnChain" | "highestVoucherAmount" | "spent">,
      tx?: CreditLedgerQuerier
    ) => {
      const settledOnChain = maxBigInt(lifecycle.settledOnChain, chainState.settled);
      if (lifecycle.highestVoucherAmount <= settledOnChain) return;
      await ledger.terminalizeTempoCredits(
        {
          channelId: channel.channelId,
          settledOnChainNative: settledOnChain,
          highestVoucherNative: lifecycle.highestVoucherAmount,
          consumedNative: lifecycle.spent,
        },
        tx
      );
    };
    if (store.withFinalizedCreditLoss) {
      await store.withFinalizedCreditLoss(channel.channelId, (tx, lifecycle) =>
        retire(lifecycle, tx)
      );
      return;
    }
    await retire(channel);
  };

  const getTempoSessionDrainState = async (channelId: string): Promise<TempoSessionDrainState> => {
    const normalized = channelId.toLowerCase();
    const current = readTempoSessionState(await store.get(normalized));
    if (!current) throw new Error(`Tempo session channel ${channelId} not found`);
    const client = await getClient({ chainId: current.chainId });
    const [chainState] = await chainOps.getChannelStatesBatch(
      client,
      [current.channelId],
      current.escrowContract
    );
    await terminalizeLostBacking(current, chainState);
    const chainFinalized = chainState.deposit === 0n;
    await store.update(normalized, (value) => {
      const active = readTempoSessionState(value);
      if (!active) return { op: "noop", result: undefined };
      return {
        op: "set",
        value: {
          ...(value as Record<string, unknown>),
          finalized: active.finalized || chainFinalized,
          closeRequestedAt: chainFinalized ? 0n : BigInt(chainState.closeRequestedAt),
          deposit: chainFinalized ? 0n : maxBigInt(active.deposit, chainState.deposit),
          settledOnChain: maxBigInt(active.settledOnChain, chainState.settled),
        },
        result: undefined,
      };
    });
    const reconciled = readTempoSessionState(await store.get(normalized));
    if (!reconciled) throw new Error(`Tempo session channel ${channelId} disappeared`);
    return {
      spent: reconciled.spent,
      settledOnChain: reconciled.settledOnChain,
      closeRequestedAt: reconciled.closeRequestedAt,
      deposit: reconciled.deposit,
      finalized: reconciled.finalized,
    };
  };
  Object.assign(mppx, { getTempoSessionDrainState });

  /**
   * Merge reconciled chain state onto the stored channel. Shared by the sweep
   * and the targeted close-event path so both see one view of the channel.
   * Returns whether the chain considers the channel finalized.
   */
  const writeBackChainState = async (
    channel: TempoSessionState,
    chainState: { settled: bigint; deposit: bigint; closeRequestedAt: number }
  ): Promise<boolean> => {
    const chainFinalized = chainState.deposit === 0n;
    await store.update(channel.channelId, (current) => {
      const active = readTempoSessionState(current);
      if (!active) return { op: "noop", result: undefined };
      return {
        op: "set",
        value: {
          ...(current as Record<string, unknown>),
          finalized: active.finalized || chainFinalized,
          closeRequestedAt: chainFinalized ? 0n : BigInt(chainState.closeRequestedAt),
          deposit: chainFinalized ? 0n : maxBigInt(active.deposit, chainState.deposit),
          settledOnChain: maxBigInt(active.settledOnChain, chainState.settled),
        },
        result: undefined,
      };
    });
    return chainFinalized;
  };

  /**
   * Channels this process is currently broadcasting a settlement for
   * The fast half of the guard: a same-machine collision is
   * answered without a database round trip, and it covers a store with no
   * durable backing at all (`dvmctl dev`, the unit suites).
   */
  const settlingHere = new Set<string>();
  const leaseMs = config.settlementSchedule?.leaseMs ?? TEMPO_SETTLEMENT_LEASE_MS;

  /**
   * Reserve the right to broadcast a settlement for one channel.
   *
   * The durable half is a lease stamped into the channel's own row, taken
   * through `store.update` — already the cross-machine linearization point
   * (advisory lock, `SELECT … FOR UPDATE`, write, one transaction), so exactly
   * one caller across the fleet sees `true`. It exists because a process flag
   * does not survive a fleet: mppx's `settle` submits and then awaits the
   * receipt, routinely longer than the platform's 30-second wake timeout, so
   * the observer's retry lands on a sibling machine while the first broadcast
   * is still confirming and reads the same pre-settlement watermark.
   *
   * The lease is taken immediately before the broadcast rather than before the
   * chain read, so a delivery that turns out not to be due costs no write. That
   * still excludes a second claimant when both chain reads precede the claim: the
   * atomic store update elects one lease owner. The process marker additionally
   * rejects duplicate work on this runtime.
   */
  const claimSettlement = async (channelId: string): Promise<boolean> => {
    if (settlingHere.has(channelId)) return false;
    settlingHere.add(channelId);
    const leaseOwner = randomUUID();
    const leaseUntil = Date.now() + leaseMs;
    try {
      const claimed = await store.update(channelId, (current): Store.Change<unknown, boolean> => {
        if (!isStateRecord(current)) return { op: "noop", result: false };
        const until = current[TEMPO_SETTLEMENT_LEASE_FIELD];
        const owner = current[TEMPO_SETTLEMENT_LEASE_OWNER_FIELD];
        if (typeof until === "number" && until > Date.now() && owner !== leaseOwner) {
          return { op: "noop", result: false };
        }
        return {
          op: "set",
          value: {
            ...current,
            [TEMPO_SETTLEMENT_LEASE_FIELD]: leaseUntil,
            [TEMPO_SETTLEMENT_LEASE_OWNER_FIELD]: leaseOwner,
          },
          result: true,
        };
      });
      if (!claimed) settlingHere.delete(channelId);
      return claimed;
    } catch (err) {
      settlingHere.delete(channelId);
      throw err;
    }
  };

  /**
   * Release a settlement lease after the transaction landed.
   *
   * Only ever called on success, and deliberately so: mppx's `settle` can throw
   * either side of the broadcast — a rejected gas estimate and a receipt
   * timeout on a transaction that is still in flight look identical from here —
   * so a failed attempt leaves its lease to expire instead. Clearing it on
   * success is what lets the *next* wake read the advanced watermark and answer
   * `already_safe` (a 200 the observer stops retrying) rather than churning
   * 503s for the rest of the lease.
   *
   * A release that cannot reach the store is swallowed rather than reported:
   * the transaction has already landed, so the caller's answer is `settled`
   * and turning it into a failure would invite a retry against a settlement
   * that succeeded. The lease expires on its own, which is the whole reason it
   * carries a deadline.
   */
  const releaseSettlement = async (channelId: string): Promise<void> => {
    try {
      await store.update(channelId, (current): Store.Change<unknown, undefined> => {
        if (!isStateRecord(current)) return { op: "noop", result: undefined };
        const next = Object.fromEntries(
          Object.entries(current).filter(
            ([field]) =>
              field !== TEMPO_SETTLEMENT_LEASE_FIELD && field !== TEMPO_SETTLEMENT_LEASE_OWNER_FIELD
          )
        );
        return { op: "set", value: next, result: undefined };
      });
    } catch {
      // Intentionally ignored — see above.
    } finally {
      settlingHere.delete(channelId);
    }
  };

  /**
   * Settle one channel on chain under its in-flight guard. The only call site
   * of `chainOps.settle`, shared by the sweep and the close-event path so the
   * two cannot disagree about when a settlement may be broadcast.
   *
   * Returns `false` when another path already holds the channel's lease. The
   * caller refuses rather than waiting: awaiting would hold the close-event
   * request across the very receipt wait that blew the wake timeout in the
   * first place, and would serialize a whole sweep behind one chain call.
   * Nothing is lost by refusing — the close event is a durable platform row
   * that retries until it is acknowledged.
   */
  const settleChannel = async (channel: TempoSessionState, client: Client): Promise<boolean> => {
    if (!(await claimSettlement(channel.channelId))) return false;
    try {
      const recoveryVersion = await config.beforeSessionSettlement?.();
      const reservation = await config.hostedObligations?.reserveTempo(channel.channelId, "settle");
      if (reservation?.replayed) {
        throw new Error("Hosted Tempo settlement already has an original effect attempt");
      }
      const txHash = await chainOps.settle(store, client, channel.channelId, {
        account: config.account,
        escrowContract: channel.escrowContract,
        // The session method pins the channel token for credential-driven
        // cooperative closes. This explicit observer/sweep path calls mppx's
        // public settle helper directly, so it must carry the same fee-token
        // choice itself. Leaving it implicit makes Tempo prepare the operator
        // transaction without a spendable fee token and fail before broadcast.
        feeToken: channel.token,
        ...(config.onSessionSettlement && {
          onSessionSettlement: (context) =>
            config.onSessionSettlement?.({
              ...context,
              ...(recoveryVersion ? { recoveryVersion } : {}),
            }),
        }),
      });
      if (reservation) await config.hostedObligations?.recordSubmitted(reservation.id, txHash);
    } catch (err) {
      // The durable lease deliberately outlives a failure (see
      // {@link releaseSettlement}); the process-local marker must not. It has
      // no expiry, so holding it would wedge this machine on the channel for
      // the life of the process — long after the lease other machines answer
      // on has lapsed.
      settlingHere.delete(channel.channelId);
      if (isTempoInsufficientFundsError(err)) {
        await config.onInsufficientFunds?.({
          operation: "settle",
          channelId: channel.channelId,
        });
      }
      throw err;
    }
    await releaseSettlement(channel.channelId);
    return true;
  };

  /**
   * Targeted single-channel protection — the forced-close path.
   *
   * Reads one channel, reconciles it against its own chain state and settles
   * it through the same predicate the sweep uses. Never invents a forced close
   * the chain does not show: a verified `CloseRequested` log whose chain state
   * has not caught up is `retryable_failure`, so the platform retries inside
   * the grace period rather than settling above terminal consumption — the
   * money rule the routine cadence is bound by (see {@link tempoSettlementDue}).
   */
  const settleTempoSessionChannel: NonNullable<MppxServer["settleTempoSessionChannel"]> = async (
    channelId
  ) => {
    const normalized = channelId.toLowerCase();
    const channel = readTempoSessionState(await store.get(normalized));
    if (!channel) return { outcome: "unknown_channel", channelId: normalized };

    try {
      const client = await getClient({ chainId: channel.chainId });
      const [chainState] = await chainOps.getChannelStatesBatch(
        client,
        [channel.channelId],
        channel.escrowContract
      );
      await terminalizeLostBacking(channel, chainState);
      const chainFinalized = await writeBackChainState(channel, chainState);
      const settledOnChain = maxBigInt(channel.settledOnChain, chainState.settled);

      if (chainFinalized) {
        // The deposit is gone. If it left owing us value, the grace period
        // elapsed without protection — preserve it and let the caller page.
        const owed = channel.highestVoucherAmount - settledOnChain;
        return owed > 0n
          ? {
              outcome: "finalized_before_protection",
              channelId: normalized,
              owed,
              settledOnChain,
            }
          : { outcome: "already_safe", channelId: normalized, settledOnChain };
      }

      const forcedClose = BigInt(chainState.closeRequestedAt) !== 0n;
      if (!forcedClose) {
        return {
          outcome: "retryable_failure",
          channelId: normalized,
          error: "chain reports no close request yet",
        };
      }
      if (
        !tempoSettlementDue({
          channel,
          chainSettled: chainState.settled,
          forcedClose,
          intervalMs: config.settlementSchedule?.intervalMs,
        })
      ) {
        return { outcome: "already_safe", channelId: normalized, settledOnChain };
      }

      if (!(await settleChannel(channel, client))) {
        return {
          outcome: "retryable_failure",
          channelId: normalized,
          error: TEMPO_SETTLEMENT_IN_FLIGHT,
        };
      }
      return {
        outcome: "settled",
        channelId: normalized,
        settledAmount: channel.highestVoucherAmount,
      };
    } catch (err) {
      return {
        outcome: "retryable_failure",
        channelId: normalized,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
  const getTempoSessionBinding: NonNullable<MppxServer["getTempoSessionBinding"]> = async (
    channelId
  ) => {
    const stored = await store.get(channelId.toLowerCase());
    const channel = readTempoSessionState(stored);
    if (!channel) return null;
    const payee = (stored as { payee?: unknown } | null)?.payee;
    return {
      chainId: channel.chainId,
      escrowContract: channel.escrowContract,
      ...(typeof payee === "string" && { payee }),
    };
  };
  const getTempoReceipt: NonNullable<MppxServer["getTempoReceipt"]> = async ({
    chainId,
    txHash,
  }) => {
    // Imported lazily: `viem` is an optional peer dependency, and this runtime
    // is only reachable on a DVM that already wired a Tempo session client.
    const { getTransactionReceipt } = await import("viem/actions");
    const client = await getClient({ chainId });
    return getTransactionReceipt(client as never, { hash: txHash });
  };
  const getTempoSessionCloseAmounts: NonNullable<
    MppxServer["getTempoSessionCloseAmounts"]
  > = async ({ channelId, txHash }) => {
    const current = readTempoSessionState(await store.get(channelId.toLowerCase()));
    if (!current) return null;
    const client = await getClient({ chainId: current.chainId });
    return chainOps.readChannelClose(client, current.channelId, txHash);
  };
  Object.assign(mppx, {
    settleTempoSessionChannel,
    getTempoSessionBinding,
    getTempoReceipt,
    getTempoSessionCloseAmounts,
  });

  if (!listActive) return mppx;

  const sweepTempoSessions: NonNullable<MppxServer["sweepTempoSessions"]> = async () => {
    const rows: Awaited<ReturnType<NonNullable<ReconcileStore["listActive"]>>> = [];
    let cursor: { updatedAt: number; key: string } | undefined;
    do {
      const page = await listActive.call(store, 100, cursor);
      rows.push(...page);
      const last = page.at(-1);
      cursor = last ? { updatedAt: last.updatedAt, key: last.key } : undefined;
      if (page.length < 100) break;
    } while (cursor);
    let closeRequested = 0;
    let settled = 0;
    let inFlight = 0;

    const groups = new Map<string, TempoSessionState[]>();
    for (const row of rows) {
      const state = readTempoSessionState(row.state);
      if (!state) continue;
      const groupKey = `${state.chainId}:${state.escrowContract.toLowerCase()}`;
      const group = groups.get(groupKey) ?? [];
      group.push(state);
      groups.set(groupKey, group);
    }

    for (const groupedChannels of groups.values()) {
      for (let offset = 0; offset < groupedChannels.length; offset += 100) {
        const channels = groupedChannels.slice(offset, offset + 100);
        const first = channels[0];
        const client = await getClient({ chainId: first.chainId });
        const chainStates = await chainOps.getChannelStatesBatch(
          client,
          channels.map((channel) => channel.channelId),
          first.escrowContract
        );

        for (const [index, channel] of channels.entries()) {
          const chainState = chainStates[index];
          await terminalizeLostBacking(channel, chainState);
          const chainFinalized = await writeBackChainState(channel, chainState);

          const forcedClose = !chainFinalized && BigInt(chainState.closeRequestedAt) !== 0n;
          if (forcedClose) closeRequested += 1;
          if (
            !tempoSettlementDue({
              channel,
              chainSettled: chainState.settled,
              forcedClose,
              intervalMs: config.settlementSchedule?.intervalMs,
            })
          ) {
            continue;
          }
          if (await settleChannel(channel, client)) settled += 1;
          else inFlight += 1;
        }
      }
    }

    return { scanned: rows.length, closeRequested, settled, inFlight };
  };

  const recoverTempoSessionClose = async (
    channelId: string,
    drainId: string
  ): Promise<string | null> => {
    if (!store.getClose || !store.confirmClose) return null;
    const intent = await store.getClose(channelId);
    if (intent?.drainId !== drainId) return null;
    if (intent.reference) return intent.reference;
    const current = readTempoSessionState(await store.get(channelId));
    if (!current) throw new Error(`Tempo session channel ${channelId} not found`);
    let finalized = current.finalized;
    if (!finalized) {
      const client = await getClient({ chainId: current.chainId });
      const [chainState] = await chainOps.getChannelStatesBatch(
        client,
        [current.channelId],
        current.escrowContract
      );
      await terminalizeLostBacking(current, chainState);
      finalized = chainState.deposit === 0n;
    }
    if (!finalized) return null;
    // A close this DVM broadcast can land after its receipt wait gave up. Its
    // hosted obligation then holds no transaction, and without one the payout
    // report for what the close paid this DVM is never sent. Record the
    // landed close's transaction on the obligation before the drain completes;
    // the payout reporter delivers from there, once per obligation.
    const pending = await config.hostedObligations?.pendingTempoClose(channelId, drainId);
    let reference = pending?.txHash ?? undefined;
    if (pending && !reference) {
      const client = await getClient({ chainId: current.chainId });
      const txHash = await chainOps.findChannelClose(
        client,
        current.channelId,
        current.escrowContract as `0x${string}`,
        pending.reservedAtMs
      );
      if (txHash) {
        await config.hostedObligations!.recordSubmitted(pending.id, txHash);
        reference = txHash;
      } else {
        // The obligation keeps no transaction, so no payout report follows and
        // it counts as unresolved until an operator settles it.
        loggers.tempo.warn("tempo_session_close_recovery_unmatched", {
          channel_id: current.channelId,
          drain_id: drainId,
          obligation_id: pending.id,
        });
      }
    }
    const recovered = await store.confirmClose(
      channelId,
      drainId,
      reference ?? `channel:${channelId}`
    );
    return recovered.reference;
  };

  const getClose = store.getClose?.bind(store) ?? (() => Promise.resolve(null));
  const beginClose = store.beginClose?.bind(store);
  const withCloseIntent = store.withCloseIntent?.bind(store);
  const resolveCloseForecast = store.resolveCloseForecast?.bind(store);
  const releaseCloseIntent = store.releaseCloseIntent?.bind(store);
  const confirmClose = store.confirmClose?.bind(store);
  return Object.assign(mppx, {
    sweepTempoSessions,
    ...(beginClose && {
      beginTempoSessionClose: async (channelId: string, drainId: string) => {
        await beginClose(channelId, drainId);
      },
    }),
    ...(withCloseIntent && { withTempoSessionCloseIntent: withCloseIntent }),
    ...(resolveCloseForecast && {
      resolveTempoSessionCloseForecast: resolveCloseForecast,
    }),
    ...(releaseCloseIntent && { releaseTempoSessionCloseIntent: releaseCloseIntent }),
    ...(confirmClose && {
      confirmTempoSessionClose: async (channelId: string, drainId: string, reference: string) =>
        (await confirmClose(channelId, drainId, reference)).reference ?? reference,
    }),
    ...(store.getClose && store.confirmClose && { recoverTempoSessionClose }),
    ...(store.getClose && {
      getTempoSessionCloseIntent: (channelId: string) => getClose(channelId.toLowerCase()),
    }),
  });
}

function readTempoSessionState(value: unknown): TempoSessionState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const state = value as Partial<TempoSessionState>;
  if (
    typeof state.channelId !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(state.channelId) ||
    typeof state.chainId !== "number" ||
    typeof state.escrowContract !== "string" ||
    typeof state.token !== "string" ||
    !HEX_ADDRESS_RE.test(state.token) ||
    typeof state.closeRequestedAt !== "bigint" ||
    typeof state.deposit !== "bigint" ||
    typeof state.highestVoucherAmount !== "bigint" ||
    typeof state.spent !== "bigint" ||
    typeof state.settledOnChain !== "bigint"
  ) {
    return undefined;
  }
  return state as TempoSessionState;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function isStateRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const ZERO_ADDRESS = `0x${"00".repeat(20)}`;
const DESCRIPTOR_ADDRESSES = ["payer", "payee", "operator", "token", "authorizedSigner"] as const;
const DESCRIPTOR_WORDS = ["salt", "expiringNonceHash"] as const;
type ChannelDescriptor = Omit<
  Parameters<typeof TempoSession.Precompile.Channel.computeId>[0], "chainId" | "escrow"
>;

function readChannelDescriptor(value: unknown): ChannelDescriptor | undefined {
  if (!isStateRecord(value)) return undefined;
  for (const field of DESCRIPTOR_ADDRESSES) {
    if (typeof value[field] !== "string" || !HEX_ADDRESS_RE.test(value[field])) return undefined;
  }
  for (const field of DESCRIPTOR_WORDS) {
    if (typeof value[field] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value[field])) {
      return undefined;
    }
  }
  return value as unknown as ChannelDescriptor;
}

function sameHex(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" &&
    left.toLowerCase() === right.toLowerCase();
}

function sameDescriptor(left: ChannelDescriptor, right: ChannelDescriptor): boolean {
  return DESCRIPTOR_ADDRESSES.every((field) => sameHex(left[field], right[field])) &&
    DESCRIPTOR_WORDS.every((field) => sameHex(left[field], right[field]));
}

/**
 * The single settlement predicate, shared by the routine sweep and the
 * targeted close-event path. Two callers, one rule — a second copy
 * of this decision is how a DVM starts settling amounts a cooperative close
 * can no longer express.
 *
 * Settle iff the channel is due (forced close, or the routine cadence has
 * elapsed), the on-chain watermark does not already cover every accepted
 * voucher, and — on the routine cadence only — the accepted vouchers equal
 * terminal consumption.
 *
 * That last clause is the money rule: settling above terminal consumption
 * would make a later exact-consumption cooperative-close voucher lower than
 * the on-chain watermark and therefore invalid. Once the unilateral-close
 * timer starts there is no cooperative path left, so a forced close settles
 * the highest accepted funding voucher before its backing can lapse after the
 * 900-second grace period.
 */
function tempoSettlementDue(args: {
  channel: TempoSessionState;
  chainSettled: bigint;
  forcedClose: boolean;
  intervalMs: number | undefined;
}): boolean {
  const { channel, chainSettled, forcedClose, intervalMs } = args;
  const settlementBoundary = Date.parse(channel.lastSettlementAt ?? channel.createdAt ?? "");
  const scheduled =
    intervalMs !== undefined &&
    Number.isFinite(settlementBoundary) &&
    Date.now() - settlementBoundary >= intervalMs;
  if (!forcedClose && !scheduled) return false;
  if (channel.highestVoucherAmount <= chainSettled) return false;
  if (!forcedClose && channel.highestVoucherAmount !== channel.spent) return false;
  return true;
}

/**
 * Parse a comma-separated `DVMKIT_TEMPO_METHODS` env value into a method-name
 * list. Returns `undefined` when the env is unset/blank so callers can pass
 * it straight into `createMppFromOpts({ methodsAllowlist })`.
 */
export function parseMppMethodsAllowlist(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/** Method-intent advertised by an Mppx handle, suitable for `/v1/info`. */
export interface MppxAdvertisedMethod {
  method: string;
  intent: string;
}

/** Extract `{ method, intent }` pairs from an Mppx handle. */
export function advertisedMethods(mppx: MppxServer): MppxAdvertisedMethod[] {
  return mppx.methods.map((m) => {
    // Method.AnyServer is `Server<any, any, any>` which collapses to `any`;
    // narrow back to the structural Method shape that's guaranteed at runtime.
    const method = m as { name: string; intent: string };
    return { method: method.name, intent: method.intent };
  });
}

/** Test-only seams for deterministic watcher coverage without a live Tempo RPC. */
export const _testing = {
  attachTempoSessionRuntime,
};
