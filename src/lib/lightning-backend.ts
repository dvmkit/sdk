export interface CreatedInvoice {
  bolt11: string;
  /** Payment hash (hex) — primary key for looking up settlement. */
  paymentHash: string;
  /** Amount in millisatoshis. */
  amountMsats: number;
  /** Unix milliseconds when the invoice expires. */
  expiresAt: number;
}

export interface InvoiceStatus {
  /** True once the invoice has been paid and preimage is known. */
  settled: boolean;
  /** Preimage (hex) — present only after settlement. */
  preimage?: string;
  /** Unix milliseconds when the invoice settled (if settled). */
  settledAt?: number;
  /** Unix milliseconds when the invoice expires. */
  expiresAt?: number;
}

/** How a payment reached a settled state — see `payInvoiceReconciling`. */
export type LightningPayOutcome = "paid" | "reconciled" | "republished";

export interface LightningPayment {
  /** Payment preimage (hex) — proof the invoice was paid. */
  preimage: string;
  /** Routing fee reported by the wallet, in millisatoshis. Absent means unknown. */
  feesPaidMsats?: number;
  /** Whether the wallet answered directly, or the outcome had to be reconciled. */
  outcome: LightningPayOutcome;
}

export interface LightningTransactionListOptions {
  /** Include transactions created at or after this Unix timestamp (seconds). */
  from?: number;
  /** Maximum number of transactions the wallet may return. */
  limit?: number;
}

/**
 * Credential-safe transaction evidence used to account for a wallet debit.
 *
 * Invoice, payment hash and preimage are deliberately replaced by digests or
 * omitted. `fingerprint` identifies the complete reduced row; `invoiceHash`
 * lets a caller bind an outgoing row to the invoice it just paid.
 */
export interface LightningTransactionSnapshot {
  fingerprint: string;
  invoiceHash?: string;
  type: "incoming" | "outgoing";
  amountMsats: number;
  /** Wallet-reported routing fee. Absent when the wallet omitted it. */
  feesPaidMsats?: number;
  createdAt: number;
  settledAt?: number;
}

export interface LightningWalletInfo {
  alias?: string;
  /** Operations the wallet supports (e.g. `pay_invoice`, `lookup_invoice`). */
  methods: string[];
  /**
   * Budget fields the wallet volunteered, if any.
   *
   * No rail behind this interface is required to expose a connection's
   * spending cap, and NWC — today's only implementation — has no method that
   * returns one. Present it when a wallet offers it, never infer it.
   */
  walletReportedBudget?: Record<string, unknown>;
}

export interface LightningBackend {
  /**
   * Pay a bolt11 invoice exactly once. Returns the preimage on success.
   *
   * Implementations must never re-send a payment on an unknown outcome without
   * first reconciling against the wallet — the rails behind this interface have
   * no idempotency key, so a blind retry is a second payment.
   *
   * `amountMsats` is passed when known (callers always have it from the
   * provider's payment-request). Backends that don't need it may ignore the
   * param.
   */
  payInvoice(bolt11: string, amountMsats?: number): Promise<LightningPayment>;
  /** Get wallet balance in millisatoshis. */
  getBalance(): Promise<number>;
  getInfo(): Promise<LightningWalletInfo>;
  createInvoice(params: {
    amountMsats: number;
    description?: string;
    expirySeconds?: number;
  }): Promise<CreatedInvoice>;
  lookupInvoice(paymentHash: string): Promise<InvoiceStatus>;
  /**
   * Return a bounded, credential-safe transaction snapshot when supported.
   * Optional so existing backends remain source-compatible; without it an
   * exact total wallet debit cannot be attributed.
   */
  listTransactions?(
    options: LightningTransactionListOptions
  ): Promise<LightningTransactionSnapshot[]>;
}
