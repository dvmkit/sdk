import type {
  CreatedInvoice,
  InvoiceStatus,
  LightningBackend,
  LightningPayment,
  LightningTransactionListOptions,
  LightningTransactionSnapshot,
  LightningWalletInfo,
} from "./lightning-backend";
import type { NwcConnection, NwcRequestOptions } from "./nwc";
import {
  getBalance,
  getInfo,
  listTransactions,
  lookupInvoice,
  makeInvoice,
  payInvoiceReconciling,
} from "./nwc";

/** NWC-backed implementation of LightningBackend. */
export class NwcBackend implements LightningBackend {
  constructor(
    private conn: NwcConnection,
    /** Shared transport options (pool reuse, shorter probe timeouts). */
    private opts: NwcRequestOptions = {}
  ) {}

  async payInvoice(bolt11: string, _amountMsats?: number): Promise<LightningPayment> {
    // NWC pay_invoice infers amount from the bolt11; the explicit amountMsats
    // param is part of the LightningBackend interface but unused here.
    return payInvoiceReconciling(this.conn, bolt11, this.opts);
  }

  async getBalance(): Promise<number> {
    return getBalance(this.conn, this.opts);
  }

  async getInfo(): Promise<LightningWalletInfo> {
    return getInfo(this.conn, this.opts);
  }

  async createInvoice(params: {
    amountMsats: number;
    description?: string;
    expirySeconds?: number;
  }): Promise<CreatedInvoice> {
    const tx = await makeInvoice(this.conn, params, this.opts);
    const expiresAtMs = tx.expiresAt
      ? tx.expiresAt * 1000
      : Date.now() + (params.expirySeconds ?? 3600) * 1000;
    return {
      bolt11: tx.invoice ?? "",
      paymentHash: tx.paymentHash,
      amountMsats: tx.amountMsats || params.amountMsats,
      expiresAt: expiresAtMs,
    };
  }

  async lookupInvoice(paymentHash: string): Promise<InvoiceStatus> {
    const tx = await lookupInvoice(this.conn, { paymentHash }, this.opts);
    return {
      settled: tx.settledAt != null,
      preimage: tx.preimage,
      settledAt: tx.settledAt != null ? tx.settledAt * 1000 : undefined,
      expiresAt: tx.expiresAt != null ? tx.expiresAt * 1000 : undefined,
    };
  }

  async listTransactions(
    options: LightningTransactionListOptions
  ): Promise<LightningTransactionSnapshot[]> {
    return listTransactions(this.conn, options, this.opts);
  }
}
