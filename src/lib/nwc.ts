import type { Filter } from "nostr-tools/filter";
import { decrypt, encrypt } from "nostr-tools/nip04";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import type { VerifiedEvent } from "nostr-tools/pure";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import WebSocket from "ws";

import { callerLoggers } from "./caller-loggers";
import { sha256hex } from "./hash";
import type {
  LightningTransactionListOptions,
  LightningTransactionSnapshot,
} from "./lightning-backend";

let webSocketImplementationConfigured = false;

/** Install Node's WebSocket only when an NWC operation actually opens or uses a pool. */
function ensureWebSocketImplementation(): void {
  if (webSocketImplementationConfigured) return;
  useWebSocketImplementation(WebSocket);
  webSocketImplementationConfigured = true;
}

/** Parsed NWC (NIP-47) connection — everything needed to talk to a remote wallet. */
export interface NwcConnection {
  /** Wallet service pubkey (hex) */
  walletPubkey: string;
  /**
   * Wallet relay URLs (wss://). NIP-47 allows the `relay` param to appear more
   * than once; every entry is published to and subscribed on, so a single dead
   * relay doesn't take the connection down with it.
   */
  relays: string[];
  /** Client secret key — 32 bytes, used to sign and encrypt NWC requests */
  secret: Uint8Array;
  /** Client pubkey derived from secret — identifies this connection to the wallet */
  clientPubkey: string;
}

/** Successful payment response from the wallet. */
export interface PayInvoiceResult {
  /** Payment preimage (hex) — proof that the invoice was paid */
  preimage: string;
  /** Routing fee the wallet reports, in millisatoshis. Absent means unknown. */
  feesPaidMsats?: number;
}

/**
 * How a payment reached a settled state — the audit trail for
 * {@link payInvoiceReconciling}'s no-double-pay discipline.
 *
 * - `paid` — the wallet answered our first publish.
 * - `reconciled` — the response was lost, but `lookup_invoice` proved the
 * wallet had already settled it. Nothing was re-sent.
 * - `republished` — `lookup_invoice` proved it had *not* settled, and the
 * byte-identical signed event was re-published inside the wallet's dedup
 * window (same event id ⇒ wallet-side dedup if it did see the first copy).
 */
export type PayOutcome = "paid" | "reconciled" | "republished";

/** Settled payment plus how it got there. */
export interface PayInvoiceOutcome extends PayInvoiceResult {
  outcome: PayOutcome;
}

/** Metadata returned by the wallet's get_info method. */
export interface WalletInfo {
  alias?: string;
  methods: string[];
  /**
   * Non-spec budget fields the wallet volunteered on `get_info`.
   *
   * NIP-47 has **no** method that returns a connection's budget or remaining
   * allowance — the budget is write-only from the client's perspective. Some
   * wallets nonetheless echo `budget_renewal` / `max_amount` style fields.
   * When they do we relay them labelled as wallet-reported; when they don't,
   * nothing is inferred and nothing is fabricated.
   */
  walletReportedBudget?: Record<string, unknown>;
}

/** A single Lightning transaction returned by make_invoice or lookup_invoice. */
export interface NwcTransaction {
  /** "incoming" for invoices we created, "outgoing" for payments we sent. */
  type: "incoming" | "outgoing";
  /** BOLT11 payment request string. */
  invoice?: string;
  description?: string;
  /** Payment hash (hex) — primary key for looking up settlement status. */
  paymentHash: string;
  /** Preimage (hex) — present only after settlement. */
  preimage?: string;
  /** Amount in millisatoshis. */
  amountMsats: number;
  /** Fees paid (msats). Absent when the wallet did not report them. */
  feesPaidMsats?: number;
  /** Unix seconds when the invoice was created. */
  createdAt: number;
  /** Unix seconds when the invoice expires. */
  expiresAt?: number;
  /** Unix seconds when the invoice settled (null/undefined means unpaid). */
  settledAt?: number;
}

export class NwcError extends Error {
  constructor(
    public code: string,
    message: string,
    /**
     * The NIP-47 method the wallet refused, when the wallet itself answered
     * with an error. A refusal is only actionable once you know *what* was
     * refused: `RESTRICTED` on `pay_invoice` and `RESTRICTED` on `get_info`
     * are granted in different places in a wallet app. Undefined
     * for transport failures, where no method reached a wallet.
     */
    public method?: string
  ) {
    super(message);
    this.name = "NwcError";
  }
}

export interface NwcRequestOptions {
  /** Reuse an existing pool instead of opening (and closing) a fresh one. */
  pool?: SimplePool;
  /** Override the response timeout. Defaults to {@link nwcTimeoutMs}. */
  timeoutMs?: number;
}

export interface PayInvoiceReconcilingOptions extends NwcRequestOptions {
  /**
   * How long a wallet is assumed to dedup identical event ids. A byte-identical
   * re-publish is only safe inside this window. Defaults to
   * {@link nwcDedupWindowMs} (240s — deliberately under Coinos's ~5 minutes).
   */
  dedupWindowMs?: number;
  /** `Date.now` override for tests. */
  now?: () => number;
}

/** Default NIP-47 response timeout, overridable via `DVM_NWC_TIMEOUT_SEC`. */
export function nwcTimeoutMs(): number {
  return positiveSecondsEnv("DVM_NWC_TIMEOUT_SEC", 30);
}

/**
 * Window inside which a byte-identical event re-publish is considered safe,
 * overridable via `DVM_NWC_DEDUP_WINDOW_SEC`.
 *
 * Wallets dedup by event id for minutes, not hours — Coinos keeps a capped
 * Redis sorted set for roughly five. The default sits under that so a
 * re-publish either gets deduped or reaches a wallet that provably never
 * settled the first copy.
 */
export function nwcDedupWindowMs(): number {
  return positiveSecondsEnv("DVM_NWC_DEDUP_WINDOW_SEC", 240);
}

/**
 * Run several round trips over one shared relay connection.
 *
 * Each NWC call otherwise opens and tears down its own websocket, so a
 * two-call sequence like connect's `get_info` + `get_balance` pays the
 * handshake — and a full timeout budget — twice.
 */
export async function withNwcPool<T>(
  conn: NwcConnection,
  fn: (opts: NwcRequestOptions) => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  return withPool(undefined, conn, (pool) => fn({ pool, timeoutMs }));
}

export function parseNwcUri(uri: string): NwcConnection {
  if (!uri.startsWith("nostr+walletconnect://")) {
    throw new NwcError("invalid_uri", "NWC URI must start with nostr+walletconnect://");
  }

  const withoutScheme = uri.slice("nostr+walletconnect://".length);
  const [walletPubkey, queryString] = withoutScheme.split("?", 2);

  if (!walletPubkey || !queryString) {
    throw new NwcError("invalid_uri", "NWC URI missing pubkey or query params");
  }

  const params = new URLSearchParams(queryString);
  // NIP-47: the `relay` param "may be more than one".
  const relays = params.getAll("relay").filter((r) => r.length > 0);
  const secretHex = params.get("secret");

  if (relays.length === 0) throw new NwcError("invalid_uri", "NWC URI missing relay param");
  if (!secretHex) throw new NwcError("invalid_uri", "NWC URI missing secret param");
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    throw new NwcError("invalid_uri", "NWC URI secret must be 64 hex characters");
  }

  const secret = hexToBytes(secretHex);
  const clientPubkey = getPublicKey(secret);

  return { walletPubkey, relays, secret, clientPubkey };
}

/**
 * Pay a Lightning invoice via NWC, once and only once.
 *
 * NIP-47 has no `pay_invoice` idempotency key, so a lost response plus a
 * re-signed retry is a double payment. The discipline here is reconcile-first:
 *
 * 1. Sign the request event **once** and publish it. A publish that never
 * opened a socket is `relay_unreachable` — nothing was transmitted, so it is
 * an ordinary network failure and not a payment in doubt.
 * 2. On any unknown outcome (timeout, or an unacked publish), ask the wallet
 * what actually happened via `lookup_invoice` **before** sending anything
 * again.
 * 3. Settled → done, nothing re-sent. Provably unsettled and still inside the
 * wallet's dedup window → re-publish the *byte-identical* event (same id,
 * so a wallet that did see the first copy discards this one).
 * 4. Unsettled but past the window, or no usable answer from `lookup_invoice`
 * → give up with `payment_unknown`. An unknown payment is surfaced, never
 * retried.
 *
 * The signed event is never regenerated — `finalizeEvent` is called exactly
 * once per call, which is what makes the wallet's dedup meaningful.
 */
export async function payInvoiceReconciling(
  conn: NwcConnection,
  bolt11: string,
  opts: PayInvoiceReconcilingOptions = {}
): Promise<PayInvoiceOutcome> {
  return callerLoggers.lightning.span(
    "lightning.pay_invoice",
    {
      relays: conn.relays.join(","),
      wallet_pubkey: conn.walletPubkey,
      bolt11_hash: sha256hex(bolt11).slice(0, 16),
    },
    async () => {
      const now = opts.now ?? (() => Date.now());
      const dedupWindowMs = opts.dedupWindowMs ?? nwcDedupWindowMs();

      return withPool(opts.pool, conn, async (pool) => {
        const method = "pay_invoice";
        const event = buildRequestEvent(conn, method, { invoice: bolt11 });
        const publishedAtMs = now();

        const first = await attemptPayment(conn, method, event, pool, opts.timeoutMs);
        if (first.kind === "settled") {
          return settledOutcome(first, "paid");
        }
        if (first.kind === "rejected") throw first.error;
        if (first.kind === "not_sent") {
          // No relay connection was ever opened, so the request never left this
          // process. There is nothing to reconcile and nothing at risk — a
          // network outage should read as one, not as a payment we can't
          // account for.
          throw first.error;
        }

        // Unknown outcome. Reconcile before considering any re-send.
        const reconciled = await reconcile(conn, bolt11, pool, opts.timeoutMs);
        if (reconciled.kind === "settled") {
          callerLoggers.lightning.info("lightning.pay_invoice.reconciled", { republished: false });
          return settledOutcome(reconciled, "reconciled");
        }
        if (reconciled.kind === "unknown") {
          throw new NwcError(
            "payment_unknown",
            "The wallet never answered and could not confirm whether the payment went through."
          );
        }

        // Provably unpaid. Re-publishing is only safe while the wallet still
        // dedups this event id — past that a re-publish is a second payment.
        if (now() - publishedAtMs >= dedupWindowMs) {
          throw new NwcError(
            "payment_unknown",
            "The wallet never answered and too much time has passed to safely retry the payment."
          );
        }

        callerLoggers.lightning.info("lightning.pay_invoice.republish", { event_id: event.id });
        const second = await attemptPayment(conn, method, event, pool, opts.timeoutMs);
        if (second.kind === "settled") {
          return settledOutcome(second, "republished");
        }
        if (second.kind === "rejected") throw second.error;
        // A `not_sent` here is *not* reportable as "nothing happened": the first
        // publish did reach a relay, so it falls through to the reconcile below
        // like any other unknown.

        // Still nothing. One last reconcile — the re-publish may have landed
        // with only the response lost again.
        const final = await reconcile(conn, bolt11, pool, opts.timeoutMs);
        if (final.kind === "settled") {
          return settledOutcome(final, "republished");
        }
        throw new NwcError(
          "payment_unknown",
          "The wallet never answered and could not confirm whether the payment went through."
        );
      });
    }
  );
}

/** Get wallet balance in millisatoshis. */
export async function getBalance(
  conn: NwcConnection,
  opts: NwcRequestOptions = {}
): Promise<number> {
  return callerLoggers.lightning.span(
    "lightning.get_balance",
    { relays: conn.relays.join(","), wallet_pubkey: conn.walletPubkey },
    async () => {
      const result = await sendNwcRequest(conn, "get_balance", {}, opts);
      const balance = result.balance ?? 0;
      callerLoggers.lightning.info("lightning.get_balance.result", { balance_msats: balance });
      return balance;
    }
  );
}

export async function getInfo(
  conn: NwcConnection,
  opts: NwcRequestOptions = {}
): Promise<WalletInfo> {
  return callerLoggers.lightning.span(
    "lightning.get_info",
    { relays: conn.relays.join(","), wallet_pubkey: conn.walletPubkey },
    async () => {
      const result = await sendNwcRequest(conn, "get_info", {}, opts);
      const info: WalletInfo = { alias: result.alias, methods: result.methods ?? [] };
      const volunteered = extractWalletReportedBudget(result);
      if (volunteered) info.walletReportedBudget = volunteered;
      callerLoggers.lightning.info("lightning.get_info.result", {
        alias: info.alias,
        methods: info.methods,
        wallet_reported_budget: volunteered !== undefined,
      });
      return info;
    }
  );
}

/**
 * Create a Lightning invoice on the remote wallet.
 * Returns the parsed transaction including the BOLT11 string and payment hash.
 */
export async function makeInvoice(
  conn: NwcConnection,
  params: { amountMsats: number; description?: string; expirySeconds?: number },
  opts: NwcRequestOptions = {}
): Promise<NwcTransaction> {
  return callerLoggers.lightning.span(
    "lightning.make_invoice",
    {
      relays: conn.relays.join(","),
      wallet_pubkey: conn.walletPubkey,
      amount_msats: params.amountMsats,
    },
    async () => {
      const body: Record<string, unknown> = { amount: params.amountMsats };
      if (params.description !== undefined) body.description = params.description;
      if (params.expirySeconds !== undefined) body.expiry = params.expirySeconds;

      const result = await sendNwcRequest(conn, "make_invoice", body, opts);
      const tx = toTransaction(result);
      if (!tx.invoice) {
        throw new NwcError("missing_invoice", "Wallet did not return a BOLT11 invoice");
      }
      if (!tx.paymentHash) {
        throw new NwcError("missing_payment_hash", "Wallet did not return a payment hash");
      }
      callerLoggers.lightning.info("lightning.make_invoice.result", {
        payment_hash_hash: sha256hex(tx.paymentHash).slice(0, 16),
      });
      return tx;
    }
  );
}

/**
 * Look up an invoice by payment hash or by the BOLT11 string itself. Returns
 * the transaction with `settledAt` populated if it has been paid.
 */
export async function lookupInvoice(
  conn: NwcConnection,
  params: { paymentHash?: string; invoice?: string },
  opts: NwcRequestOptions = {}
): Promise<NwcTransaction> {
  return callerLoggers.lightning.span(
    "lightning.lookup_invoice",
    {
      relays: conn.relays.join(","),
      wallet_pubkey: conn.walletPubkey,
      payment_hash_hash: params.paymentHash
        ? sha256hex(params.paymentHash).slice(0, 16)
        : undefined,
    },
    async () => {
      const body: Record<string, unknown> = {};
      if (params.paymentHash) body.payment_hash = params.paymentHash;
      if (params.invoice) body.invoice = params.invoice;
      if (!body.payment_hash && !body.invoice) {
        throw new NwcError("bad_request", "lookupInvoice requires payment_hash or invoice");
      }

      const result = await sendNwcRequest(conn, "lookup_invoice", body, opts);
      return toTransaction(result);
    }
  );
}

/**
 * List a bounded set of credential-safe wallet transactions.
 *
 * Raw invoices, payment hashes and preimages never cross this boundary. They
 * contribute only to SHA-256 identities used to compare repeated snapshots.
 */
export async function listTransactions(
  conn: NwcConnection,
  options: LightningTransactionListOptions,
  opts: NwcRequestOptions = {}
): Promise<LightningTransactionSnapshot[]> {
  return callerLoggers.lightning.span(
    "lightning.list_transactions",
    {
      relays: conn.relays.join(","),
      wallet_pubkey: conn.walletPubkey,
      from: options.from,
      limit: options.limit,
    },
    async () => {
      const body: Record<string, unknown> = {};
      if (options.from !== undefined) body.from = options.from;
      if (options.limit !== undefined) body.limit = options.limit;
      const result = await sendNwcRequest(conn, "list_transactions", body, opts);
      if (!Array.isArray(result.transactions)) {
        throw new NwcError("invalid_response", "Wallet did not return a transaction list.");
      }
      const transactions = result.transactions.map(toTransactionSnapshot);
      callerLoggers.lightning.info("lightning.list_transactions.result", {
        transaction_count: transactions.length,
      });
      return transactions;
    }
  );
}

/** Raw NIP-47 transaction payload (internal — converted to NwcTransaction on return). */
interface RawTransaction {
  type?: "incoming" | "outgoing";
  invoice?: string;
  description?: string;
  payment_hash?: string;
  preimage?: string;
  amount?: number;
  fees_paid?: number | null;
  created_at?: number;
  expires_at?: number;
  settled_at?: number | null;
}

/** Decrypted kind-23195 response envelope from the wallet. */
interface NwcResponse {
  result?: {
    preimage?: string;
    balance?: number;
    alias?: string;
    methods?: string[];
    transactions?: unknown[];
  } & RawTransaction &
    Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
  };
}

type NwcResult = NonNullable<NwcResponse["result"]>;

type PaymentAttempt =
  | { kind: "settled"; preimage: string; feesPaidMsats?: number }
  /** The wallet answered with an error — authoritative, no retry. */
  | { kind: "rejected"; error: NwcError }
  /**
   * No relay connection could be opened, so the request never left this
   * process. Nothing is at risk — this is a network failure, not a payment.
   */
  | { kind: "not_sent"; error: NwcError }
  /** No usable answer. Nothing is known about whether money moved. */
  | { kind: "unknown" };

type Reconciliation =
  | { kind: "settled"; preimage: string; feesPaidMsats?: number }
  /** The wallet is reachable and says this invoice has not been paid. */
  | { kind: "unpaid" }
  /** The wallet couldn't tell us — treat the payment as unknown. */
  | { kind: "unknown" };

/**
 * Non-spec budget keys some wallets volunteer on `get_info`. Nothing in NIP-47
 * requires these and no method exists to ask for them, so they are relayed
 * verbatim when present and never synthesised when absent.
 */
const VOLUNTEERED_BUDGET_KEYS = [
  "budget",
  "budget_renewal",
  "budget_msats",
  "budget_amount",
  "max_amount",
  "remaining_budget",
  "budget_remaining",
  "renews_at",
] as const;

function extractWalletReportedBudget(result: NwcResult): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const key of VOLUNTEERED_BUDGET_KEYS) {
    const value = result[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function attemptPayment(
  conn: NwcConnection,
  method: string,
  event: VerifiedEvent,
  pool: SimplePool,
  timeoutMs?: number
): Promise<PaymentAttempt> {
  let result: NwcResult;
  try {
    result = await publishAndAwait(conn, method, event, pool, timeoutMs);
  } catch (err) {
    // Nothing was ever transmitted: no socket to a relay was open, so the
    // wallet cannot have seen this request. Distinct from the cases below,
    // which all leave the payment's fate genuinely unknown.
    if (err instanceof NwcError && err.code === "relay_unreachable") {
      return { kind: "not_sent", error: err };
    }
    // `publish_rejected` means the bytes went out on an open socket and no
    // relay acked — a relay may still have forwarded them to the wallet.
    if (err instanceof NwcError && (err.code === "timeout" || err.code === "publish_rejected")) {
      return { kind: "unknown" };
    }
    // A decrypt/parse failure means the wallet answered something we can't
    // read — we don't know whether it paid.
    if (err instanceof NwcError && err.code === "invalid_response") return { kind: "unknown" };
    if (err instanceof NwcError) return { kind: "rejected", error: err };
    throw err;
  }
  if (!result.preimage) {
    return {
      kind: "rejected",
      error: new NwcError("missing_preimage", "Wallet did not return a payment preimage."),
    };
  }
  const feesPaidMsats = optionalFeeMsats(result.fees_paid);
  return {
    kind: "settled",
    preimage: result.preimage,
    ...(feesPaidMsats !== undefined ? { feesPaidMsats } : {}),
  };
}

async function reconcile(
  conn: NwcConnection,
  bolt11: string,
  pool: SimplePool,
  timeoutMs?: number
): Promise<Reconciliation> {
  try {
    const tx = await lookupInvoice(conn, { invoice: bolt11 }, { pool, timeoutMs });
    // A buggy or stale wallet lookup must not settle (or disprove) a different
    // invoice. Treat a missing identity the same way: ambiguity forbids both a
    // success claim and a re-publish.
    if (tx.invoice !== bolt11) return { kind: "unknown" };
    if (tx.settledAt != null && tx.preimage) {
      return {
        kind: "settled",
        preimage: tx.preimage,
        ...(tx.feesPaidMsats !== undefined ? { feesPaidMsats: tx.feesPaidMsats } : {}),
      };
    }
    if (tx.settledAt != null) {
      // Settled but no preimage surfaced — the money moved, which is the part
      // that matters for not paying twice.
      return {
        kind: "settled",
        preimage: "",
        ...(tx.feesPaidMsats !== undefined ? { feesPaidMsats: tx.feesPaidMsats } : {}),
      };
    }
    return { kind: "unpaid" };
  } catch (err) {
    // NOT_FOUND is the wallet telling us it has never seen this invoice, which
    // is a definitive "not paid". Anything else leaves us in the dark.
    if (err instanceof NwcError && err.code.toUpperCase() === "NOT_FOUND") {
      return { kind: "unpaid" };
    }
    return { kind: "unknown" };
  }
}

async function sendNwcRequest(
  conn: NwcConnection,
  method: string,
  params: Record<string, unknown>,
  opts: NwcRequestOptions
): Promise<NwcResult> {
  return withPool(opts.pool, conn, (pool) =>
    publishAndAwait(conn, method, buildRequestEvent(conn, method, params), pool, opts.timeoutMs)
  );
}

/** Sign one kind-23194 request event. Called exactly once per logical request. */
function buildRequestEvent(
  conn: NwcConnection,
  method: string,
  params: Record<string, unknown>
): VerifiedEvent {
  const content = JSON.stringify({ method, params });
  const encrypted = encrypt(conn.secret, conn.walletPubkey, content);
  return finalizeEvent(
    {
      kind: 23194,
      tags: [["p", conn.walletPubkey]],
      content: encrypted,
      created_at: Math.floor(Date.now() / 1000),
    },
    conn.secret
  );
}

/** Publish unchanged request bytes and await the reply. Payment retries must
 * reconcile first and remain inside the configured wallet dedup window. */
async function publishAndAwait(
  conn: NwcConnection,
  method: string,
  event: VerifiedEvent,
  pool: SimplePool,
  timeoutMs?: number
): Promise<NwcResult> {
  const relays = conn.relays;
  const budgetMs = timeoutMs ?? nwcTimeoutMs();

  // Subscribe before publishing so a fast wallet can't answer into a void.
  const waiter = awaitResponse(pool, relays, conn.walletPubkey, event.id, budgetMs);

  try {
    await publishEvent(pool, relays, event);
  } catch (err) {
    waiter.cancel();
    if (err instanceof NwcError) throw err;
    throw new NwcError(
      "publish_rejected",
      `No relay accepted the request (${relays.join(", ")}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }

  const response = await waiter.promise;
  if (response === null) {
    throw new NwcError("timeout", `Wallet did not respond within ${Math.round(budgetMs / 1000)}s`);
  }

  let decrypted: string;
  try {
    decrypted = decrypt(conn.secret, conn.walletPubkey, response);
  } catch {
    throw new NwcError("invalid_response", "Wallet response could not be decrypted.");
  }

  let parsed: NwcResponse;
  try {
    parsed = JSON.parse(decrypted) as NwcResponse;
  } catch {
    throw new NwcError("invalid_response", "Wallet returned a malformed response.");
  }

  if (parsed.error) {
    // The method rides along: this is the wallet refusing one specific call,
    // and the remedy for a refusal depends on which one.
    throw new NwcError(
      parsed.error.code ?? "wallet_error",
      parsed.error.message ?? "Wallet error",
      method
    );
  }

  return parsed.result ?? {};
}

interface ResponseWaiter {
  promise: Promise<string | null>;
  cancel: () => void;
}

function awaitResponse(
  pool: SimplePool,
  relays: string[],
  walletPubkey: string,
  eventId: string,
  timeoutMs: number
): ResponseWaiter {
  let settle: ((value: string | null) => void) | undefined;
  const promise = new Promise<string | null>((resolve) => {
    const done = (value: string | null): void => {
      clearTimeout(timer);
      sub.close();
      resolve(value);
    };
    settle = done;
    const timer = setTimeout(() => {
      done(null);
    }, timeoutMs);
    const sub = pool.subscribeMany(
      relays,
      {
        kinds: [23195],
        authors: [walletPubkey],
        "#e": [eventId],
      } as Filter,
      {
        onevent(ev) {
          done(ev.content);
        },
        // required by nostr-tools
        oneose() {}, // eslint-disable-line @typescript-eslint/no-empty-function
      }
    );
  });
  return {
    promise,
    cancel: () => {
      settle?.(null);
    },
  };
}

/**
 * Run `fn` against a pool, opening (and closing) a private one when the caller
 * didn't supply theirs. Callers that make several round trips on one
 * connection should pass a pool so the sockets are shared.
 */
async function withPool<T>(
  external: SimplePool | undefined,
  conn: NwcConnection,
  fn: (pool: SimplePool) => Promise<T>
): Promise<T> {
  ensureWebSocketImplementation();
  if (external) return fn(external);
  const pool = new SimplePool();
  try {
    return await fn(pool);
  } finally {
    pool.close(conn.relays);
  }
}

function toTransaction(raw: RawTransaction): NwcTransaction {
  const feesPaidMsats = optionalFeeMsats(raw.fees_paid);
  return {
    type: raw.type ?? "incoming",
    invoice: raw.invoice,
    description: raw.description,
    paymentHash: raw.payment_hash ?? "",
    preimage: raw.preimage,
    amountMsats: raw.amount ?? 0,
    ...(feesPaidMsats !== undefined ? { feesPaidMsats } : {}),
    createdAt: raw.created_at ?? Math.floor(Date.now() / 1000),
    expiresAt: raw.expires_at,
    settledAt: raw.settled_at ?? undefined,
  };
}

function toTransactionSnapshot(value: unknown): LightningTransactionSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NwcError("invalid_response", "Wallet returned a malformed transaction.");
  }
  const raw = value as Record<string, unknown>;
  if (raw.type !== "incoming" && raw.type !== "outgoing") {
    throw new NwcError("invalid_response", "Wallet returned an invalid transaction type.");
  }
  const amountMsats = requiredNonNegativeInteger(raw.amount, "amount");
  const createdAt = requiredNonNegativeInteger(raw.created_at, "creation time");
  const feesPaidMsats = optionalFeeMsats(raw.fees_paid);
  if (raw.fees_paid != null && feesPaidMsats === undefined) {
    throw new NwcError("invalid_response", "Wallet returned an invalid transaction fee.");
  }
  const settledAt = optionalNonNegativeInteger(raw.settled_at);
  if (raw.settled_at != null && settledAt === undefined) {
    throw new NwcError("invalid_response", "Wallet returned an invalid settlement time.");
  }
  const invoice = optionalPrivateString(raw.invoice, "invoice");
  const paymentHash = optionalPrivateString(raw.payment_hash, "payment hash");
  const reducedIdentity = {
    type: raw.type,
    invoice: invoice ?? null,
    paymentHash: paymentHash ?? null,
    amountMsats,
    feesPaidMsats: feesPaidMsats ?? null,
    createdAt,
    settledAt: settledAt ?? null,
  };
  return {
    fingerprint: sha256hex(JSON.stringify(reducedIdentity)),
    ...(invoice ? { invoiceHash: sha256hex(invoice) } : {}),
    type: raw.type,
    amountMsats,
    ...(feesPaidMsats !== undefined ? { feesPaidMsats } : {}),
    createdAt,
    ...(settledAt !== undefined ? { settledAt } : {}),
  };
}

function settledOutcome(
  payment: { preimage: string; feesPaidMsats?: number },
  outcome: PayOutcome
): PayInvoiceOutcome {
  return {
    preimage: payment.preimage,
    outcome,
    ...(payment.feesPaidMsats !== undefined ? { feesPaidMsats: payment.feesPaidMsats } : {}),
  };
}

function optionalFeeMsats(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requiredNonNegativeInteger(value: unknown, field: string): number {
  const parsed = optionalNonNegativeInteger(value);
  if (parsed === undefined) {
    throw new NwcError("invalid_response", `Wallet returned an invalid transaction ${field}.`);
  }
  return parsed;
}

function optionalPrivateString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new NwcError("invalid_response", `Wallet returned an invalid transaction ${field}.`);
  }
  return value;
}

/**
 * Publish an event, distinguishing "nothing ever left this process" from
 * "the bytes went out and nobody acked".
 *
 * That distinction is the whole reason this isn't `Promise.any(pool.publish())`:
 * `SimplePool.publish` folds a failed connection into a *resolved* string, so
 * `any` over it succeeds against a relay that was never reachable — and, worse,
 * cannot tell an unreachable relay from a request the wallet may already be
 * acting on. Connecting explicitly keeps the two apart, which is what lets the
 * payment path report a network outage as `relay_unreachable` (definitively
 * unsent, safe to retry) instead of an unknown payment.
 */
async function publishEvent(
  pool: SimplePool,
  relays: string[],
  event: VerifiedEvent
): Promise<void> {
  const connections = await Promise.allSettled(relays.map((url) => pool.ensureRelay(url)));
  const live = connections.flatMap((c) => (c.status === "fulfilled" ? [c.value] : []));
  if (live.length === 0) {
    throw new NwcError(
      "relay_unreachable",
      `Could not connect to any of the wallet's relays (${relays.join(", ")}): ${describeRejections(
        connections
      )}`
    );
  }

  try {
    await Promise.any(live.map((relay) => relay.publish(event)));
  } catch (err) {
    // At least one socket was open when the event was written to it, so a
    // relay that never acked may still have forwarded it to the wallet.
    throw new NwcError(
      "publish_rejected",
      `No relay accepted the request (${relays.join(", ")}): ${describeAggregate(err)}`
    );
  }
}

function describeRejections(results: PromiseSettledResult<unknown>[]): string {
  const reasons = results.flatMap((r) => (r.status === "rejected" ? [errorText(r.reason)] : []));
  return reasons.length > 0 ? reasons.join("; ") : "no relays configured";
}

function describeAggregate(err: unknown): string {
  if (err instanceof AggregateError) {
    return err.errors.map((e: unknown) => errorText(e)).join("; ");
  }
  return errorText(err);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function positiveSecondsEnv(name: string, fallbackSec: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackSec * 1_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackSec * 1_000;
  return Math.floor(n) * 1_000;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
