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

/** Facilitator `errorReason` for a settlement that was submitted and has not confirmed yet. */
export const X402_SETTLEMENT_PENDING = "settlement_pending";
/** `invalidReason` of a verify that the facilitator did not answer in time. */
export const FACILITATOR_TIMEOUT_REASON = "facilitator_timeout";
/** Default bound on one facilitator call. */
export const X402_DEFAULT_FACILITATOR_TIMEOUT_MS = 10_000;
/**
 * Header in which a facilitator reports, as base64 JSON keyed by extension
 * name, what each extension made of a verify or settle request. It is logged
 * and never passed on to the caller.
 */
export const X402_EXTENSION_RESPONSES_HEADER = "EXTENSION-RESPONSES";

// One facilitator answer logs at most this many extension entries; the rest
// are counted on a single truncation line, so a hostile header cannot flood
// the log.
const X402_EXTENSION_RESPONSES_LOGGED_MAX = 8;

/** A facilitator call that did not complete within its bound; its effect, if any, is unknown. */
export class X402FacilitatorTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`x402 facilitator did not answer within ${timeoutMs}ms`);
    this.name = "X402FacilitatorTimeoutError";
  }
}

/**
 * Run one facilitator call under a deadline that also covers reading the
 * response body. The timer is cleared however the call ends.
 */
async function withTimeout<T>(
  config: Pick<X402Config, "facilitatorTimeoutMs">,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = config.facilitatorTimeoutMs ?? X402_DEFAULT_FACILITATOR_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new X402FacilitatorTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  const call = run(controller.signal);
  // The deadline wins the race; the aborted call's own rejection is expected.
  call.catch(() => undefined);
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirementsV1 | PaymentRequirementsV2,
  config: Pick<X402Config, "facilitator" | "facilitatorAuth" | "facilitatorTimeoutMs"> = {},
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
      try {
        return await withTimeout(config, async (signal) => {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({
              x402Version: payload.x402Version,
              paymentPayload: payload,
              paymentRequirements: requirements,
            }),
            signal,
          });
          logExtensionResponses(res, "verifier");
          if (!res.ok) {
            const rejection = await readFacilitatorRejection(res, res.status === 400);
            if (
              rejection?.isValid === false &&
              typeof rejection.invalidReason === "string" &&
              rejection.invalidReason.length > 0
            ) {
              logRejected("verifier");
              return rejection as unknown as VerifyResponse;
            }
            logRejected("verifier");
            logRefusedRequest("verifier", res.status, rejection);
            return { isValid: false, invalidReason: `facilitator_status_${res.status}` };
          }
          const data = (await res.json()) as VerifyResponse;
          if (!data.isValid) logRejected("verifier");
          callerLoggers.x402.info("x402.verify_with_facilitator.result", { is_valid: data.isValid });
          return data;
        });
      } catch (err) {
        // Verify moves no money, so a facilitator that does not answer in time
        // refuses admission instead of holding the caller.
        if (!(err instanceof X402FacilitatorTimeoutError)) throw err;
        logRejected("verifier");
        return { isValid: false, invalidReason: FACILITATOR_TIMEOUT_REASON };
      }
    })
  );
}

export async function settleWithFacilitator(
  payload: PaymentPayload,
  requirements: PaymentRequirementsV1 | PaymentRequirementsV2,
  config: Pick<X402Config, "facilitator" | "facilitatorAuth" | "facilitatorTimeoutMs"> = {},
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
      return withTimeout(config, async (signal) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            x402Version: payload.x402Version,
            paymentPayload: payload,
            paymentRequirements: requirements,
          }),
          signal,
        });
        logExtensionResponses(res, "broadcast");
        if (!res.ok) {
          // CDP answers a settlement that is still confirming with a 500, so the
          // pending marker is read on any status; other rejections only on 400.
          const rejection = await readFacilitatorRejection(res, true);
          if (
            rejection?.success === false &&
            typeof rejection.errorReason === "string" &&
            rejection.errorReason.length > 0 &&
            (res.status === 400 || rejection.errorReason === X402_SETTLEMENT_PENDING)
          ) {
            if (rejection.errorReason !== X402_SETTLEMENT_PENDING) logRejected("broadcast");
            return rejection as unknown as SettleResponse;
          }
          logRejected("broadcast");
          logRefusedRequest("broadcast", res.status, rejection);
          return { success: false, errorReason: `facilitator_status_${res.status}` };
        }
        const data = (await res.json()) as SettleResponse;
        if (!data.success && data.errorReason !== X402_SETTLEMENT_PENDING) logRejected("broadcast");
        callerLoggers.x402.info("x402.settle_with_facilitator.result", {
          success: data.success,
          tx_hash: data.transaction,
        });
        return data;
      });
    })
  );
}

async function readFacilitatorRejection(
  res: Response,
  readBody: boolean
): Promise<Record<string, unknown> | null> {
  // A 400 is the facilitator's normal transport for a structured payment rejection.
  if (!readBody) return null;
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

/**
 * Log what each extension reported. Every status is logged, `processing`
 * included: a facilitator may never report `success` for a listing that
 * still completes. A header that is not base64 JSON is ignored.
 */
function logExtensionResponses(res: Response, stage: "verifier" | "broadcast"): void {
  const header = res.headers.get(X402_EXTENSION_RESPONSES_HEADER);
  if (!header) return;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(decoded)) return;
  const entries = Object.entries(decoded);
  for (const [extension, value] of entries.slice(0, X402_EXTENSION_RESPONSES_LOGGED_MAX)) {
    const entry = isRecord(value) ? value : {};
    const rejectedReason = entry.rejectedReason ?? entry.reason;
    diagnosticConsole[entry.status === "rejected" ? "warn" : "info"]({
      event: "x402_facilitator_extension_response",
      rail: "x402",
      failure_stage: stage,
      extension,
      extension_status: entry.status,
      ...(rejectedReason !== undefined && { extension_rejected_reason: rejectedReason }),
    });
  }
  if (entries.length > X402_EXTENSION_RESPONSES_LOGGED_MAX) {
    diagnosticConsole.warn({
      event: "x402_facilitator_extension_responses_truncated",
      rail: "x402",
      failure_stage: stage,
      count: entries.length - X402_EXTENSION_RESPONSES_LOGGED_MAX,
    });
  }
}

/**
 * Log a refusal the caller sees only as `facilitator_status_<code>`, with the
 * facilitator's own `errorMessage` (such as CDP's reason for an
 * `invalid_request`) for the builder; the log projection bounds its length.
 */
function logRefusedRequest(
  stage: "verifier" | "broadcast",
  status: number,
  body: Record<string, unknown> | null
): void {
  diagnosticConsole.warn({
    event: "x402_facilitator_request_refused",
    rail: "x402",
    failure_stage: stage,
    status_code: status,
    ...(body?.errorMessage !== undefined && { facilitator_message: body.errorMessage }),
  });
}

function logRejected(stage: "verifier" | "broadcast"): void {
  diagnosticConsole.warn({
    event: "x402_credential_rejected",
    rail: "x402",
    failure_category: stage === "verifier" ? "verification_failed" : "settlement_failed",
    failure_stage: stage,
  });
}
