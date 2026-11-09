import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { LightningBackend } from "../../lib/lightning-backend";
import { type NwcConnection, NwcError, parseNwcUri, withNwcPool } from "../../lib/nwc";
import { NwcBackend } from "../../lib/nwc-backend";
import type {
  CreditFundingBasis,
  CreditInvoiceRecord,
  CreditLedgerLike,
  FundingRecord,
  InvoiceSettlement,
} from "./credit-ledger";
import { CreditLedgerError } from "./credit-ledger";
import type { LightningRailHealth } from "./lightning-rail-health";
import type { CreditDepositEnqueue } from "./revenue-reporter";

export interface LightningReceiveConfig {
  /**
   * NWC connection URI (`DVMKIT_NWC_RECEIVE_URI`). Validated at boot:
   * spending authority is refused unless `allowSpend` is explicitly true.
   */
  uri?: string;
  /**
   * Accept excess NWC permissions (`DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true`). Use only
   * when the DVM already holds a spend credential for the same wallet or the wallet
   * cannot issue receive-only connections. A compromised DVM could spend wallet funds.
   * Required receive methods and a readable method list are still enforced.
   */
  allowSpend?: boolean;
  /**
   * Pre-built backend, bypassing URI parsing and the connect-time probe. Test
   * seam only — production always goes through `uri` so the receive-only
   * property is actually checked.
   */
  backend?: LightningBackend;
  /** Invoice lifetime in seconds. Defaults to {@link DEFAULT_INVOICE_TTL_SECONDS}. */
  invoiceTtlSeconds?: number;
  /**
   * Smallest funding this deployment can receive over Lightning, in sats
   * (`DVMKIT_LIGHTNING_FUNDING_MIN_SATS`). The floor is a property of the
   * receive wallet's channel policy (`htlc_minimum_msat` upstream), so it is
   * per-deployment and sats-physical — the menu renders it into fiat with a
   * margin, but everything that *enforces* it compares raw sats. Defaults to
   * {@link DEFAULT_LIGHTNING_FUNDING_MIN_SATS}.
   */
  fundingMinSats?: number;
  /**
   * Optional platform-derived channel-liveness gate. Platform-hosted DVMs use
   * it alongside their NWC reachability probe; self-hosted DVMs omit it.
   */
  railHealth?: LightningRailHealth;
}

/** Default bolt11 lifetime — long enough to pay by hand, short enough to retire. */
export const DEFAULT_INVOICE_TTL_SECONDS = 900;

/**
 * Default receive minimum in sats. Configure a deployment’s measured channel-policy floor; do
 * not issue a new invoice below that configured minimum.
 */
export const DEFAULT_LIGHTNING_FUNDING_MIN_SATS = 2000;

/**
 * Floor on the invoice lifetime: twice the signed-request drift window, so the
 * bolt11 always outlives the funding negotiation that produced it. A shorter one would
 * expire inside the caller's own retry budget and strand them mid-top-up.
 */
export const MIN_INVOICE_TTL_SECONDS = 600;

const HEALTH_TTL_MS = 60_000;

/**
 * Longest a funding menu waits for stale Lightning health before answering from the cache.
 * It matches the Tempo observer's probe ceiling, so the menu's parallel waits share one worst
 * case, and sits under {@link WALLET_TIMEOUT_MS}: a healthy wallet answers `get_info` in well
 * under a second including relay connection, while a hung one falls back here instead of
 * holding the request for the full wallet deadline.
 */
export const LIGHTNING_HEALTH_WAIT_MS = 2_000;

/**
 * Wallet deadline in milliseconds. These operations run on caller requests; an unreachable
 * wallet should not consume the ordinary long wallet timeout.
 */
const WALLET_TIMEOUT_MS = 5_000;

const MAX_SETTLE_CHECKS = 3;

/** Slack past `expires_at` before an unpaid invoice is retired. */
const EXPIRY_GRACE_MS = 60_000;

const RECEIVE_SAFE_METHODS: ReadonlySet<string> = new Set([
  "get_info",
  "get_balance",
  "get_budget",
  "make_invoice",
  "make_hold_invoice",
  "settle_hold_invoice",
  "cancel_hold_invoice",
  "lookup_invoice",
  "list_transactions",
]);

const REQUIRED_RECEIVE_METHODS = ["make_invoice", "lookup_invoice"] as const;

type LightningReceiveHealth = "healthy" | "unreachable" | "permission_refused";

type PermissionRefusalReason =
  | "methods_absent"
  | "methods_malformed"
  | "missing_required_methods"
  | "unsafe_methods"
  | "get_info_refused";

/**
 * Identity, denomination, rail and invalid-basis refusals are deterministic for this
 * invoice’s persisted data. Retire them from the bounded sweep rather than repeatedly
 * blocking payable rows. funding_replayed needs a funding-row read to distinguish a
 * concurrent Lightning settlement from another rail occupying the caller-chosen key.
 */
const PERMANENT_SETTLE_FAILURES: ReadonlySet<string> = new Set([
  "caller_mismatch",
  "currency_mismatch",
  "rail_mismatch",
  "invalid_basis",
]);

function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof NwcError)) return false;
  const transport = ["timeout", "relay_unreachable", "publish_rejected", "invalid_response"];
  return transport.includes(err.code.toLowerCase());
}

/**
 * Prepaid Lightning funding over NWC, with receive-safe permissions required by default.
 * `allowSpend` accepts excess authority explicitly; URI construction still validates the
 * advertised method list and required receive methods. The injected
 * backend seam bypasses that probe. Receive-safe methods include invoice, read and
 * hold-invoice operations.
 *
 * Crediting is pull-based: later requests observe settlement against the durable invoice
 * binding, so sleeping hosts need no watcher. Reachability is cached and refreshed in the
 * background for funding menus.
 */
export class LightningReceive {
  readonly invoiceTtlSeconds: number;
  readonly fundingMinSats: number;

  private health: LightningReceiveHealth;
  private checkedAtMs: number;
  private refreshInFlight: Promise<void> | undefined;
  /** A healthy receive's first probe transport failure, waiting for the next probe to confirm it. */
  private probeStrike = false;
  private freshness: { settled: Promise<void>; deadlineMs: number } | undefined;
  private spendOverrideWarned = false;
  private readonly allowSpendEnabled: boolean;
  private permissionRefusal: ReceivePermissionError | undefined;

  private constructor(
    private readonly source: { conn?: NwcConnection; backend?: LightningBackend },
    opts: {
      allowSpend?: boolean;
      invoiceTtlSeconds: number;
      fundingMinSats: number;
      health: LightningReceiveHealth;
      nowMs: number;
      railHealth?: LightningRailHealth;
    }
  ) {
    this.allowSpendEnabled = opts.allowSpend === true;
    this.invoiceTtlSeconds = opts.invoiceTtlSeconds;
    this.fundingMinSats = opts.fundingMinSats;
    this.health = opts.health;
    this.checkedAtMs = opts.nowMs;
    this.railHealth = opts.railHealth;
  }

  /** Whether excess NWC permissions were explicitly allowed for this connection. */
  get allowSpend(): boolean {
    return this.allowSpendEnabled;
  }

  private readonly railHealth: LightningRailHealth | undefined;

  /**
   * Return undefined when unconfigured. Permission/URI failures refuse construction with a
   * corrective message; wallet transport failure constructs an unavailable receive leg so
   * other rails can still boot. Recovery must validate method scope before advertising
   * Lightning.
   */
  static async create(config: LightningReceiveConfig): Promise<LightningReceive | undefined> {
    const invoiceTtlSeconds = resolveInvoiceTtl(config.invoiceTtlSeconds);
    const fundingMinSats = resolveFundingMinSats(config.fundingMinSats);
    if (config.backend) {
      await config.railHealth?.refresh?.();
      return new LightningReceive(
        { backend: config.backend },
        {
          allowSpend: config.allowSpend,
          invoiceTtlSeconds,
          fundingMinSats,
          health: "healthy",
          nowMs: Date.now(),
          railHealth: config.railHealth,
        }
      );
    }
    if (!config.uri) return undefined;

    let conn: NwcConnection;
    try {
      conn = parseNwcUri(config.uri);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `DVMKIT_NWC_RECEIVE_URI is not a valid NWC connection string: ${detail}. ` +
          "Copy the full nostr+walletconnect:// URI from your wallet's app-connection screen.",
        { cause: err }
      );
    }

    let health: LightningReceiveHealth = "healthy";
    let methods: string[] = [];
    try {
      const info = await withNwcPool(
        conn,
        (opts) => new NwcBackend(conn, opts).getInfo(),
        WALLET_TIMEOUT_MS
      );
      methods = validateReceiveMethods(info.methods, config.allowSpend === true);
    } catch (err) {
      if (err instanceof ReceivePermissionError) throw err;
      if (!isTransportFailure(err)) throw receivePermissionProbeError(err);
      health = "unreachable";
      warnReceiveUnreachable(err);
    }

    await config.railHealth?.refresh?.();
    const receive = new LightningReceive(
      { conn },
      {
        invoiceTtlSeconds,
        fundingMinSats,
        health,
        allowSpend: config.allowSpend,
        nowMs: Date.now(),
        railHealth: config.railHealth,
      }
    );
    receive.warnSpendOverride(methods);
    return receive;
  }

  /**
   * Answer from cached wallet and optional rail-health observations without blocking. A stale
   * wallet observation starts a background refresh.
   */
  available(): boolean {
    if (Date.now() - this.checkedAtMs > HEALTH_TTL_MS) void this.refresh();
    return this.health === "healthy" && (this.railHealth?.available() ?? true);
  }

  /**
   * Give stale negative health one bounded chance to recover before a funding menu reads
   * {@link available}. Waits on the wallet probe only when an unreachable observation is past
   * its TTL, and on the rail-health source only when it offers a refresh that could restore it;
   * a stale healthy answer is served as is and revalidated in the background. Concurrent
   * callers share one refresh and one deadline, so no caller waits longer than
   * {@link LIGHTNING_HEALTH_WAIT_MS}; past it, the refresh continues and the cache answers.
   */
  async ensureFresh(): Promise<void> {
    let round = this.freshness;
    if (!round) {
      const waits: Promise<void>[] = [];
      const probing =
        this.health === "unreachable" && Date.now() - this.checkedAtMs > HEALTH_TTL_MS;
      if (probing) waits.push(this.refresh());
      // The rail signal can change the answer only when the wallet is, or may become, healthy;
      // a refused or freshly unreachable wallet withholds Lightning whatever the rail says.
      const rail = this.health === "healthy" || probing ? this.railFreshness() : undefined;
      if (rail) waits.push(rail);
      if (waits.length === 0) return;
      const settled = Promise.allSettled(waits).then(() => undefined);
      const started = { settled, deadlineMs: Date.now() + LIGHTNING_HEALTH_WAIT_MS };
      this.freshness = started;
      void settled.then(() => {
        if (this.freshness === started) this.freshness = undefined;
      });
      round = started;
    }
    await settleWithin(round.settled, round.deadlineMs - Date.now());
  }

  /** A rail-health hook that throws offers nothing to wait on rather than failing the menu. */
  private railFreshness(): Promise<void> | undefined {
    try {
      return this.railHealth?.ensureFresh?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Return the stored invoice on retry: two payable bolt11s for one fund ID could charge
   * twice while only one credits. Caller and amount are bound to the recorded credit/funding
   * pair, without a caller-supplied artifact hash.
   */
  async issue(
    ledger: CreditLedgerLike,
    args: {
      creditId: string;
      fundId: string;
      callerPubkey: string;
      currency: string;
      amountMicro: number;
      amountMsats: number;
      description?: string;
    }
  ): Promise<CreditInvoiceRecord> {
    const existing = await ledger.getInvoice({ creditId: args.creditId, fundId: args.fundId });
    if (existing) {
      // Check the invoice’s recorded owner even before settlement creates a credit row.
      // Direct SDK callers can name another caller’s (credit_id, fund_id); route preflight
      // alone cannot protect this read.
      if (existing.callerPubkey !== args.callerPubkey) {
        throw new CreditLedgerError(
          "caller_mismatch",
          `funding ${args.fundId} on credit ${args.creditId} was issued to another caller`
        );
      }
      return existing;
    }

    // The menu is advisory, not an authorization boundary: a caller can post
    // `method: "lightning"` even while it is omitted. Refuse before touching
    // the wallet so an unsafe recovery observation cannot mint an invoice.
    if (!this.available()) {
      throw new Error("Lightning receive is unavailable; no funding invoice was issued.");
    }

    // Apply the configured raw-sats floor only after returning an existing invoice. Raising
    // the floor must not strand a previously issued invoice that may already be paid. Direct
    // SDK issue calls need this guard as well as the route’s sizing check.
    if (args.amountMsats < this.fundingMinSats * 1000) {
      throw new CreditLedgerError(
        "below_rail_minimum",
        `funding of ${args.amountMsats} msats is below this deployment's ` +
          `${this.fundingMinSats}-sat Lightning receive floor`
      );
    }

    const created = await this.withBackend(
      (backend) =>
        backend.createInvoice({
          amountMsats: args.amountMsats,
          description: args.description,
          expirySeconds: this.invoiceTtlSeconds,
        }),
      WALLET_TIMEOUT_MS
    );
    return ledger.recordInvoice({
      creditId: args.creditId,
      fundId: args.fundId,
      callerPubkey: args.callerPubkey,
      currency: args.currency,
      // Pin fiat and millisatoshi amounts at issue time; settlement does not reprice them
      // after FX changes.
      amountMicro: args.amountMicro,
      amountMsats: created.amountMsats || args.amountMsats,
      paymentHash: created.paymentHash,
      bolt11: created.bolt11,
      expiresAt: created.expiresAt,
    });
  }

  /**
   * Re-observe the wallet payment before an operator credits a blocked invoice and recover
   * its settlement instant. Unlike settlePending, lookup failures throw. NOT_FOUND returns
   * known:false, distinguishing the wrong wallet/unknown hash from an unpaid known invoice.
   */
  async lookupSettlement(
    paymentHash: string
  ): Promise<{ settled: boolean; settledAt?: number; known: boolean }> {
    try {
      const status = await this.withBackend(
        (backend) => backend.lookupInvoice(paymentHash),
        WALLET_TIMEOUT_MS
      );
      return { ...status, known: true };
    } catch (err) {
      if (err instanceof NwcError && err.code.toUpperCase() === "NOT_FOUND") {
        return { settled: false, known: false };
      }
      throw err;
    }
  }

  /**
   * Read pending invoices locally, then check at most MAX_SETTLE_CHECKS on bounded wallet
   * deadlines. Log failures without throwing into the request.
   *
   * An invoice-specific failure must not suppress payable siblings; wallet transport failure
   * ends the pass. Deterministic refusals retire that row as blocked for operator repair,
   * while transient failures remain pending.
   */
  async settlePending(
    ledger: CreditLedgerLike,
    args: {
      callerPubkey: string;
      creditId?: string;
      creditTtlMs: number;
      dvmId?: string;
      enqueueCreditDeposit?: CreditDepositEnqueue;
      nowMs?: number;
    }
  ): Promise<InvoiceSettlement[]> {
    let pending: CreditInvoiceRecord[];
    try {
      pending = await ledger.listPendingInvoices({
        callerPubkey: args.callerPubkey,
        creditId: args.creditId,
        limit: MAX_SETTLE_CHECKS,
      });
    } catch (err) {
      warnSettleFailure("list_failed", err);
      return [];
    }
    if (pending.length === 0) return [];

    const nowMs = args.nowMs ?? Date.now();
    const settled: InvoiceSettlement[] = [];
    try {
      await this.withBackend(async (backend) => {
        for (const invoice of pending) {
          try {
            const outcome = await this.applyOne(ledger, backend, invoice, {
              creditTtlMs: args.creditTtlMs,
              dvmId: args.dvmId,
              enqueueCreditDeposit: args.enqueueCreditDeposit,
              nowMs,
            });
            if (outcome) settled.push(outcome);
          } catch (err) {
            if (isTransportFailure(err)) throw err;
            await this.retireOrLog(ledger, invoice, err);
          }
        }
      }, WALLET_TIMEOUT_MS);
    } catch (err) {
      this.noteFailure(err);
      warnSettleFailure("wallet_unreachable", err);
    }
    return settled;
  }

  private async applyOne(
    ledger: CreditLedgerLike,
    backend: LightningBackend,
    invoice: CreditInvoiceRecord,
    opts: {
      creditTtlMs: number;
      dvmId?: string;
      enqueueCreditDeposit?: CreditDepositEnqueue;
      nowMs: number;
    }
  ): Promise<InvoiceSettlement | undefined> {
    let status: { settled: boolean; settledAt?: number };
    try {
      status = await backend.lookupInvoice(invoice.paymentHash);
    } catch (err) {
      // A wallet that doesn't know the hash is answering "not paid", not
      // "I'm down" — don't let it flip the rail's health.
      if (err instanceof NwcError && err.code.toUpperCase() === "NOT_FOUND") return undefined;
      throw err;
    }

    if (!status.settled) {
      // Past expiry plus slack and still unpaid: retire it. A bolt11 is
      // unpayable after its expiry, so this needs no ledger effect — and the
      // final lookup above is what makes that claim safe rather than assumed.
      if (opts.nowMs > invoice.expiresAt + EXPIRY_GRACE_MS) {
        await ledger.markInvoiceExpired({
          creditId: invoice.creditId,
          fundId: invoice.fundId,
        });
      }
      return undefined;
    }

    const basis: CreditFundingBasis = {
      rail: "lightning",
      paidMsats: invoice.amountMsats,
      fundingRef: invoice.paymentHash,
    };
    const fundedAt = status.settledAt ?? opts.nowMs;
    const expiryMs = opts.nowMs + opts.creditTtlMs;
    const depositOutbox =
      opts.dvmId && opts.enqueueCreditDeposit
        ? {
            enqueue: opts.enqueueCreditDeposit,
            payload: {
              dvmId: opts.dvmId,
              creditId: invoice.creditId,
              callerPubkey: invoice.callerPubkey,
              fundingId: invoice.paymentHash,
              rail: "lightning",
              paidMsats: invoice.amountMsats,
              amountMicro: invoice.amountMicro,
              creditCurrency: invoice.currency,
              fundedAt,
              expiryMs,
            },
          }
        : undefined;
    return ledger.settleInvoice({
      creditId: invoice.creditId,
      fundId: invoice.fundId,
      expiryMs,
      basis,
      depositOutbox,
      settledAtMs: status.settledAt,
      nowMs: opts.nowMs,
    });
  }

  /**
   * Retire a deterministic uncreditable payment as blocked so it no longer occupies the
   * bounded sweep window. Transient failures stay pending for a later request; report the
   * payment hash for operator repair.
   */
  private async retireOrLog(
    ledger: CreditLedgerLike,
    invoice: CreditInvoiceRecord,
    err: unknown
  ): Promise<void> {
    const reason = await this.blockingReason(ledger, invoice, err);
    if (!reason) {
      warnSettleFailure("settle_failed", err, invoice);
      return;
    }
    try {
      await ledger.markInvoiceBlocked({
        creditId: invoice.creditId,
        fundId: invoice.fundId,
        reason,
      });
    } catch (markErr) {
      // The row stays `pending` and will be re-derived next request. Say so
      // rather than losing the finding to the failed write.
      warnSettleFailure("block_failed", markErr, invoice);
    }
    diagnosticConsole.error(
      {
        level: "error",
        event: "lightning_settlement_blocked",
        message:
          undefined,
        reason,
        credit_id: invoice.creditId,
        fund_id: invoice.fundId,
        payment_hash: invoice.paymentHash,
        amount_msats: invoice.amountMsats,
        amount_micro: invoice.amountMicro,
        currency: invoice.currency,
      }
    );
  }

  /**
   * Classify funding_replayed by reading the existing funding’s rail. A Lightning row can
   * represent a concurrent applied check; another rail at this caller-chosen key is a
   * different payment, leaving the invoice’s sats uncredited. A failed diagnostic read
   * remains transient, never a guessed permanent refusal.
   */
  private async blockingReason(
    ledger: CreditLedgerLike,
    invoice: CreditInvoiceRecord,
    err: unknown
  ): Promise<string | undefined> {
    if (!(err instanceof CreditLedgerError)) return undefined;
    if (err.code === "funding_replayed") {
      let funding: FundingRecord | undefined;
      try {
        funding = await ledger.getFunding({
          creditId: invoice.creditId,
          fundId: invoice.fundId,
        });
      } catch {
        // The read is diagnostic only; failing it must not retire the invoice
        // on a guess. Treated as transient, so a later pass classifies it.
        return undefined;
      }
      // `settleInvoice` is the only writer of a `lightning` row at this key, so
      // any other rail (or a rail-less row) is by construction not this payment.
      if (!funding || funding.rail === "lightning") return undefined;
      return `funding_replayed_on_${funding.rail}`;
    }
    return PERMANENT_SETTLE_FAILURES.has(err.code) ? err.code : undefined;
  }

  /**
   * Run one wallet operation. An invoice operation's outcome updates health directly; a
   * permission probe's outcome is classified by {@link refresh}.
   */
  private async withBackend<T>(
    fn: (backend: LightningBackend) => Promise<T>,
    timeoutMs?: number,
    probe = false
  ): Promise<T> {
    try {
      let result: T;
      if (this.source.backend) {
        result = await fn(this.source.backend);
      } else {
        const conn = this.source.conn;
        if (!conn) throw new Error("lightning receive has no backend");
        // One pool for the whole callback so a multi-invoice sweep shares its
        // relay sockets instead of reconnecting per lookup.
        result = await withNwcPool(conn, (opts) => fn(new NwcBackend(conn, opts)), timeoutMs);
      }
      if (!probe) this.noteOperationOk();
      return result;
    } catch (err) {
      if (!probe) this.noteFailure(err);
      throw err;
    }
  }

  private noteOperationOk(): void {
    this.probeStrike = false;
    if (this.health !== "healthy") return;
    this.checkedAtMs = Date.now();
  }

  private notePermissionsOk(): void {
    this.probeStrike = false;
    this.health = "healthy";
    this.permissionRefusal = undefined;
    this.checkedAtMs = Date.now();
  }

  private notePermissionRefused(refusal: ReceivePermissionError): void {
    const previous = this.permissionRefusal;
    this.probeStrike = false;
    this.health = "permission_refused";
    this.permissionRefusal = refusal;
    this.checkedAtMs = Date.now();
    if (previous?.fingerprint === refusal.fingerprint) return;
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "lightning_receive_permission_refused",
        reason: refusal.reason,
        message: undefined,
        hint: undefined,
        ...(refusal.advertisedMethods ? { advertised_methods: refusal.advertisedMethods } : {}),
      }
    );
  }

  /**
   * Only a *transport* failure is a health signal. One from an invoice operation marks the
   * rail unreachable at once; permission-probe outcomes are classified by {@link refresh}.
   */
  private noteFailure(err: unknown): void {
    if (!isTransportFailure(err)) return;
    this.probeStrike = false;
    const transitioned = this.health !== "unreachable";
    this.health = "unreachable";
    this.permissionRefusal = undefined;
    this.checkedAtMs = Date.now();
    if (transitioned) warnReceiveUnreachable(err);
  }

  private warnSpendOverride(methods: string[]): void {
    if (!this.allowSpend || this.spendOverrideWarned) return;
    const unsafe = methods.filter((method) => !RECEIVE_SAFE_METHODS.has(methodName(method)));
    if (unsafe.length === 0) return;
    this.spendOverrideWarned = true;
    diagnosticConsole.warn({
      level: "warn",
      event: "lightning_receive_allow_spend_enabled",
      override: "DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true",
      excess_methods: unsafe.map(methodName),
    });
  }

  private refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const probe = this.probeOnce().finally(() => {
      if (this.refreshInFlight === probe) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = probe;
    return probe;
  }

  private async probeOnce(): Promise<void> {
    try {
      const info = await this.withBackend((backend) => backend.getInfo(), WALLET_TIMEOUT_MS, true);
      const methods = validateReceiveMethods(info.methods, this.allowSpend);
      this.warnSpendOverride(methods);
      this.notePermissionsOk();
    } catch (err) {
      if (isTransportFailure(err)) {
        this.noteProbeTransportFailure(err);
        return;
      }
      // Anything else is a successful contact that failed to prove receive-only scope.
      this.notePermissionRefused(
        err instanceof ReceivePermissionError ? err : receivePermissionProbeError(err)
      );
    }
  }

  /**
   * A healthy receive stays advertised through one background probe's transport failure:
   * after a long idle the first `get_info` can time out on relay reconnection while the next
   * answers promptly, and dropping the rail on it withholds Lightning for a full TTL. The
   * second consecutive failure marks it unreachable. `checkedAtMs` is left stale after the
   * first, so the next caller's {@link available} sends the confirming probe at once rather
   * than a TTL later. Any successful probe or invoice operation clears the strike.
   */
  private noteProbeTransportFailure(err: unknown): void {
    if (this.health === "healthy" && !this.probeStrike) {
      this.probeStrike = true;
      diagnosticConsole.warn({
        level: "warn",
        event: "lightning_receive_probe_failed",
      });
      return;
    }
    this.noteFailure(err);
  }
}

class ReceivePermissionError extends Error {
  readonly fingerprint: string;

  constructor(
    readonly reason: PermissionRefusalReason,
    message: string,
    readonly hint: string,
    readonly advertisedMethods?: string[],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ReceivePermissionError";
    this.fingerprint = `${reason}:${advertisedMethods?.join("\n") ?? ""}`;
  }
}

function validateReceiveMethods(value: unknown, allowSpend = false): string[] {
  if (!Array.isArray(value)) {
    throw new ReceivePermissionError(
      "methods_malformed",
      "DVMKIT_NWC_RECEIVE_URI returned a malformed permitted-method list, so dvmkit cannot verify it is receive-only.",
      receivePermissionHint()
    );
  }
  if (value.length === 0) {
    throw new ReceivePermissionError(
      "methods_absent",
      "DVMKIT_NWC_RECEIVE_URI points at a wallet that does not advertise which methods the connection permits, so dvmkit cannot verify it is receive-only.",
      receivePermissionHint(),
      []
    );
  }
  if (value.some((method) => typeof method !== "string" || method.trim().length === 0)) {
    throw new ReceivePermissionError(
      "methods_malformed",
      "DVMKIT_NWC_RECEIVE_URI returned a malformed permitted-method list, so dvmkit cannot verify it is receive-only.",
      receivePermissionHint()
    );
  }

  const methods = value.map((method: string) => method.trim());
  const unsafe = methods.filter((method) => !RECEIVE_SAFE_METHODS.has(methodName(method)));
  if (unsafe.length > 0 && !allowSpend) {
    throw new ReceivePermissionError(
      "unsafe_methods",
      `DVMKIT_NWC_RECEIVE_URI advertises methods that are not receive-safe: ${unsafe.join(", ")}. ` +
        "This DVM would hold a credential with capabilities outside invoice receive/read access. " +
        "Create a receive-only connection instead.",
      receivePermissionHint(),
      methods
    );
  }

  const normalized = new Set(methods.map(methodName));
  const missing = REQUIRED_RECEIVE_METHODS.filter((method) => !normalized.has(method));
  if (missing.length > 0) {
    throw new ReceivePermissionError(
      "missing_required_methods",
      `DVMKIT_NWC_RECEIVE_URI is missing ${missing.join(" and ")} (advertised methods: ` +
        `${methods.join(", ")}). Without make_invoice the DVM cannot issue a funding invoice; ` +
        "without lookup_invoice it could never credit one that was paid.",
      "Re-create the connection with both make_invoice and lookup_invoice permitted.",
      methods
    );
  }
  return methods;
}

function receivePermissionProbeError(err: unknown): ReceivePermissionError {
  const detail = err instanceof Error ? err.message : String(err);
  const code = err instanceof NwcError ? err.code : "invalid_response";
  return new ReceivePermissionError(
    "get_info_refused",
    `DVMKIT_NWC_RECEIVE_URI did not provide a usable get_info permission observation (${code}: ${detail}), so dvmkit cannot verify it is receive-only.`,
    receivePermissionHint(),
    undefined,
    { cause: err }
  );
}

function receivePermissionHint(): string {
  return (
    "Use a wallet that reports its permissions (for example Alby Hub), then create a receive-only " +
    "connection that permits get_info, get_balance, make_invoice and lookup_invoice without any " +
    "payment capability."
  );
}

/** Resolve when `promise` settles or after `ms`, whichever is first, leaving no timer behind. */
async function settleWithin(promise: Promise<void>, ms: number): Promise<void> {
  if (ms <= 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function methodName(method: string): string {
  return method.slice(method.lastIndexOf(".") + 1);
}

function warnReceiveUnreachable(_err: unknown): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "lightning_receive_unreachable",
      message:
        undefined,
      error: undefined,
    }
  );
}

export function resolveInvoiceTtl(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_INVOICE_TTL_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < MIN_INVOICE_TTL_SECONDS) {
    throw new Error(
      `DVMKIT_NWC_RECEIVE_INVOICE_TTL_SECONDS must be a whole number of seconds and at least ` +
        `${MIN_INVOICE_TTL_SECONDS} (got ${seconds}) — a shorter invoice can expire inside the ` +
        "caller's own funding retry window."
    );
  }
  return seconds;
}

/**
 * Require a positive whole-number receive floor in sats, including when overriding the
 * deployment default.
 */
export function resolveFundingMinSats(sats: number | undefined): number {
  if (sats === undefined) return DEFAULT_LIGHTNING_FUNDING_MIN_SATS;
  if (!Number.isSafeInteger(sats) || sats < 1) {
    throw new Error(
      `DVMKIT_LIGHTNING_FUNDING_MIN_SATS must be a whole number of sats, at least 1 (got ${sats}). ` +
        "Set it to your receive wallet's measured routing floor."
    );
  }
  return sats;
}

function warnSettleFailure(reason: string, err: unknown, invoice?: CreditInvoiceRecord): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "lightning_settlement_check_failed",
      reason,
      message:
        undefined,
      ...(invoice
        ? {
            credit_id: invoice.creditId,
            fund_id: invoice.fundId,
            payment_hash: invoice.paymentHash,
          }
        : {}),
      error: undefined,
    }
  );
}
