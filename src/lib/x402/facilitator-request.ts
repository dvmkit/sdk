import { diagnosticConsole } from "../../observability/diagnostic-console";
import { withPaymentStage } from "../../observability/payment-diagnostics";
import type { FacilitatorConfig } from "@x402/core/server";

import { callerLoggers } from "../caller-loggers";
import { X402_DEFAULT_FACILITATOR } from "./constants";
import { createX402FacilitatorAuthHeaders } from "./facilitator";
import type {
  PaymentPayload,
  PaymentRequirementsV1,
  PaymentRequirementsV2,
  SettleResponse,
  VerifyResponse,
} from "./spec";
import type { X402Config } from "./types";

export async function verifyWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirementsV1 | PaymentRequirementsV2,
  config: Pick<X402Config, "facilitator" | "facilitatorAuth"> = {},
  createAuthHeaders:
    | FacilitatorConfig["createAuthHeaders"]
    | undefined = createX402FacilitatorAuthHeaders(config)
): Promise<VerifyResponse> {
  const facilitator = config.facilitator ?? X402_DEFAULT_FACILITATOR;
  const url = facilitator.replace(/\/$/, "") + "/verify";
  return callerLoggers.x402.span(
    "x402.verify_with_facilitator",
    { facilitator_url: url },
    () => withPaymentStage("verifier", async () => {
      const authHeaders = (await createAuthHeaders?.())?.verify ?? {};
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });
      if (!res.ok) {
        const rejection = await readFacilitatorRejection(res);
        if (
          rejection?.isValid === false &&
          typeof rejection.invalidReason === "string" &&
          rejection.invalidReason.length > 0
        ) {
          logRejected("verifier");
          return rejection as unknown as VerifyResponse;
        }
        logRejected("verifier");
        return { isValid: false, invalidReason: `facilitator_status_${res.status}` };
      }
      const data = (await res.json()) as VerifyResponse;
      if (!data.isValid) logRejected("verifier");
      callerLoggers.x402.info("x402.verify_with_facilitator.result", { is_valid: data.isValid });
      return data;
    })
  );
}

export async function settleWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirementsV1 | PaymentRequirementsV2,
  config: Pick<X402Config, "facilitator" | "facilitatorAuth"> = {},
  createAuthHeaders:
    | FacilitatorConfig["createAuthHeaders"]
    | undefined = createX402FacilitatorAuthHeaders(config)
): Promise<SettleResponse> {
  const facilitator = config.facilitator ?? X402_DEFAULT_FACILITATOR;
  const url = facilitator.replace(/\/$/, "") + "/settle";
  return callerLoggers.x402.span(
    "x402.settle_with_facilitator",
    { facilitator_url: url },
    () => withPaymentStage("broadcast", async () => {
      const authHeaders = (await createAuthHeaders?.())?.settle ?? {};
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          x402Version: payload.x402Version,
          paymentPayload: payload,
          paymentRequirements: requirements,
        }),
      });
      if (!res.ok) {
        const rejection = await readFacilitatorRejection(res);
        if (
          rejection?.success === false &&
          typeof rejection.errorReason === "string" &&
          rejection.errorReason.length > 0
        ) {
          logRejected("broadcast");
          return rejection as unknown as SettleResponse;
        }
        logRejected("broadcast");
        return { success: false, errorReason: `facilitator_status_${res.status}` };
      }
      const data = (await res.json()) as SettleResponse;
      if (!data.success) logRejected("broadcast");
      callerLoggers.x402.info("x402.settle_with_facilitator.result", {
        success: data.success,
        tx_hash: data.transaction,
      });
      return data;
    })
  );
}

async function readFacilitatorRejection(res: Response): Promise<Record<string, unknown> | null> {
  // A 400 is the facilitator's normal transport for a structured payment rejection.
  if (res.status !== 400) return null;
  try {
    const body = (await res.json()) as unknown;
    return isRecord(body) ? body : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function logRejected(stage: "verifier" | "broadcast"): void {
  diagnosticConsole.warn({
    event: "x402_credential_rejected",
    rail: "x402",
    failure_category: stage === "verifier" ? "verification_failed" : "settlement_failed",
    failure_stage: stage,
  });
}
