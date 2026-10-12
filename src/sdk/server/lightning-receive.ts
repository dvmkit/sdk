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
   * Receive-only NWC connection URI (`DVMKIT_NWC_RECEIVE_URI`). Validated at
   * boot: a connection that can *spend* is refused outright.
   */
  uri?: string;
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
 * Prepaid Lightning funding over a receive-safe NWC connection. URI construction validates
 * the advertised method allowlist, refusing spending or unknown authority; the injected
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
  private refreshing = false;
  private permissionRefusal: ReceivePermissionError | undefined;

  private constructor(
    private readonly source: { conn?: NwcConnection; backend?: LightningBackend },
    opts: {
      invoiceTtlSeconds: number;
      fundingMinSats: number;
      health: LightningReceiveHealth;
      nowMs: number;
      railHealth?: LightningRailHealth;
    }
  ) {
    this.invoiceTtlSeconds = opts.invoiceTtlSeconds;
    this.fundingMinSats = opts.fundingMinSats;
    this.health = opts.health;
    this.checkedAtMs = opts.nowMs;
    this.railHealth = opts.railHealth;
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
    try {
      const info = await withNwcPool(
        conn,
        (opts) => new NwcBackend(conn, opts).getInfo(),
        WALLET_TIMEOUT_MS
      );
      validateReceiveMethods(info.methods);
    } catch (err) {
      if (err instanceof ReceivePermissionError) throw err;
      if (!isTransportFailure(err)) throw receivePermissionProbeError(err);
      health = "unreachable";
      warnReceiveUnreachable(err);
    }

    await config.railHealth?.refresh?.();
    return new LightningReceive(
      { conn },
      {
        invoiceTtlSeconds,
        fundingMinSats,
        health,
        nowMs: Date.now(),
        railHealth: config.railHealth,
      }
    );
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

  private async withBackend<T>(
    fn: (backend: LightningBackend) => Promise<T>,
    timeoutMs?: number,
    recordSuccess = true
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
      if (recordSuccess) this.noteOperationOk();
      return result;
    } catch (err) {
      this.noteFailure(err);
      throw err;
    }
  }

  private noteOperationOk(): void {
    if (this.health !== "healthy") return;
    this.checkedAtMs = Date.now();
  }

  private notePermissionsOk(): void {
    this.health = "healthy";
    this.permissionRefusal = undefined;
    this.checkedAtMs = Date.now();
  }

  private notePermissionRefused(refusal: ReceivePermissionError): void {
    const previous = this.permissionRefusal;
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
   * Only a *transport* failure from an ordinary invoice operation is a health
   * signal. Permission-probe refusals are classified by {@link refresh}.
   */
  private noteFailure(err: unknown): void {
    if (!isTransportFailure(err)) return;
    const transitioned = this.health !== "unreachable";
    this.health = "unreachable";
    this.permissionRefusal = undefined;
    this.checkedAtMs = Date.now();
    if (transitioned) warnReceiveUnreachable(err);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const info = await this.withBackend((backend) => backend.getInfo(), WALLET_TIMEOUT_MS, false);
      validateReceiveMethods(info.methods);
      this.notePermissionsOk();
    } catch (err) {
      // Transport failures were already recorded by `withBackend`. Everything
      // else is a successful contact that failed to prove receive-only scope.
      if (!isTransportFailure(err)) {
        this.notePermissionRefused(
          err instanceof ReceivePermissionError ? err : receivePermissionProbeError(err)
        );
      }
    } finally {
      this.refreshing = false;
    }
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

function validateReceiveMethods(value: unknown): string[] {
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
  if (unsafe.length > 0) {
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
