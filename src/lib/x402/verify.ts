import { diagnosticConsole } from "../../observability/diagnostic-console";
import { callerLoggers } from "../caller-loggers";
import { usdcToMsats } from "../payment-amounts";
import { createX402FacilitatorAuthHeaders } from "./facilitator";
import { settleWithFacilitator, verifyWithFacilitator } from "./facilitator-request";
import {
  buildPaymentRequirements,
  decodePayment,
  encodeSettleResponseHeader,
  exactEvmAuthorization,
} from "./spec";
import type { X402Config, X402ExactVersionSupport, X402Receipt } from "./types";

/**
 * Verify an x402 `X-PAYMENT` header per the x402 spec.
 *
 * Flow:
 * 1. Decode the base64 `PaymentPayload`
 * 2. Rebuild the `PaymentRequirements` the server advertised on the 402 — the
 * facilitator deep-equals these against the payload's authorization, so a
 * credential bought against any other set fails verification.
 * 3. Call the facilitator's `/verify`
 * 4. On valid, call the facilitator's `/settle` to broadcast the EIP-3009
 * `transferWithAuthorization`. The on-chain tx hash flows through to the
 * receipt and into `X-PAYMENT-RESPONSE` for the client.
 *
 * A positive `btcUsdRate` converts the settled USDC back to msats. Zero means
 * the requirement was already stated exactly in USD and no rate was needed;
 * in that case `amountMsats` degrades to zero while `amountUsdcMicro` remains
 * authoritative. Upfront accounting values that native amount against the
 * advertised requirement, so it never books the degraded field.
 */
export async function verifyX402Payment(
  paymentHeader: string,
  config: X402Config,
  requiredUsdcMicro: bigint,
  resource: string,
  btcUsdRate: number,
  exactVersions: X402ExactVersionSupport = { v1: true, v2: true }
): Promise<X402Receipt> {
  return callerLoggers.x402.span(
    "x402.verify_payment",
    {
      resource,
      required_usdc_micro: Number(requiredUsdcMicro),
      facilitator_url: config.facilitator,
    },
    async () => {
      let payload;
      try {
        payload = decodePayment(paymentHeader);
      } catch {
        logRejected("malformed_credential", "verifier");
        return { verified: false, amountMsats: 0, invalidReason: "decode_failed" };
      }
      if (
        (payload.x402Version === 1 && !exactVersions.v1) ||
        (payload.x402Version === 2 && !exactVersions.v2)
      ) {
        logRejected("unsupported_version", "verifier");
        return { verified: false, amountMsats: 0, invalidReason: "unsupported_version" };
      }

      const requirementOpts = { x402Config: config, requiredUsdcMicro, resource };
      const requirements =
        payload.x402Version === 1
          ? buildPaymentRequirements({ ...requirementOpts, version: 1 })
          : buildPaymentRequirements({ ...requirementOpts, version: 2 });
      const createAuthHeaders = createX402FacilitatorAuthHeaders(config);

      const verifyRes = await verifyWithFacilitator(
        payload,
        requirements,
        config,
        createAuthHeaders
      );
      if (!verifyRes.isValid) {
        return {
          verified: false,
          amountMsats: 0,
          invalidReason: verifyRes.invalidReason ?? "verify_failed",
        };
      }

      const settleRes = await settleWithFacilitator(
        payload,
        requirements,
        config,
        createAuthHeaders
      );
      if (!settleRes.success) {
        return {
          verified: false,
          amountMsats: 0,
          invalidReason: settleRes.errorReason ?? "settle_failed",
        };
      }

      // Trust the EIP-3009 authorization's `value` for the rail-native amount —
      // the facilitator already cryptographically validated it against the
      // requirements, so re-deriving from msats would be a lossy round-trip.
      const amountUsdcMicro = Number.parseInt(exactEvmAuthorization(payload).value, 10);
      const amountMsats = btcUsdRate > 0 ? usdcToMsats(amountUsdcMicro / 1e6, btcUsdRate) : 0;

      callerLoggers.x402.info("x402.verify_payment.result", {
        verified: true,
        tx_hash: settleRes.transaction,
        amount_msats: amountMsats,
      });

      return {
        verified: true,
        amountMsats,
        amountUsdcMicro,
        txHash: settleRes.transaction,
        settleResponseHeader: encodeSettleResponseHeader(settleRes),
      };
    }
  );
}

function logRejected(category: string, stage: "verifier" | "broadcast"): void {
  diagnosticConsole.warn({
    event: "x402_credential_rejected",
    rail: "x402",
    failure_category: category,
    failure_stage: stage,
  });
}
