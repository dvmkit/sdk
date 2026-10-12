import { isTestMintUrl } from "../../lib/mints";
import type { PaymentMethod, FundingMethod } from "../types";
import type { X402Config } from "../../lib/x402/types";
import type { MppxServer } from "./mpp-setup";
import { TEMPO_MODERATO_CHAIN_ID } from "./mpp-setup";
import { devModeSkipsPaymentVerification } from "./payment";

/** Effective boot-time payment configuration for one mounted DVM. Health may change later. */
export interface PaymentMode {
  mount: string;
  verification: "required" | "skipped";
  storage: "durable" | "disposable";
  rails: Record<PaymentMethod, { status: "verifying" | "unavailable" | "absent"; testFunds: boolean | null }>;
}

/** A completed job's settled customer charge, never the builder's reported cost. */
export interface PaidJobCompletion {
  jobId: string;
  rail: FundingMethod;
  /** Checked integer micro-units in the credit's declared currency. */
  amountMicro: number;
  currency: string;
  /** True only for a recognized test mint/network; null when configuration cannot establish this. */
  testFunds: boolean | null;
}

/** Internal shared report builder. An unavailable configured rail never permits synthetic payment. */
export function resolvePaymentMode(opts: {
  mount: string;
  devMode?: boolean;
  mints?: string[];
  x402?: X402Config;
  mpp?: MppxServer;
  paymentMethods?: PaymentMethod[];
  cashuReady: boolean;
  x402Available: boolean;
  durable: boolean;
}): PaymentMode {
  const active = (rail: PaymentMethod, configured: boolean, ready: boolean) => ({
    status: (!configured && !opts.paymentMethods?.includes(rail) ? "absent" :
      ready && (!opts.paymentMethods || opts.paymentMethods.includes(rail)) ? "verifying" : "unavailable") as PaymentMode["rails"][PaymentMethod]["status"],
    testFunds: rail === "cashu" ? (opts.mints?.length ? opts.mints.every(isTestMintUrl) : null) :
      rail === "x402" ? (opts.x402 ? ["base-sepolia", "eip155:84532"].includes(opts.x402.network) : null) :
      opts.mpp?.tempoConfiguration ? opts.mpp.tempoConfiguration.chainId === TEMPO_MODERATO_CHAIN_ID : null,
  });
  return {
    mount: opts.mount,
    verification: devModeSkipsPaymentVerification(opts) ? "skipped" : "required",
    storage: opts.durable ? "durable" : "disposable",
    rails: {
      cashu: active("cashu", opts.mints !== undefined, opts.cashuReady),
      x402: active("x402", !!opts.x402, !!opts.x402 && opts.x402Available),
      tempo: active("tempo", !!opts.mpp, !!opts.mpp?.methods.some((method) => method.name === "tempo")),
    },
  };
}
