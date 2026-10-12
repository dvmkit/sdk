import { Errors } from "mppx";

import { paymentFailureStage } from "../../observability/payment-diagnostics";
import { CreditLedgerError } from "./credit-ledger";
import { ProcessedPaymentReplayError } from "./processed-payment-store";

/** Class identity is evidence; exception names, prose, details and nested causes are not. */
export function paymentFailureFields(error: unknown): Record<string, unknown> {
  let category = "unknown";
  try {
    if (error instanceof ProcessedPaymentReplayError) category = "replay_detected";
    else if (error instanceof CreditLedgerError) category = "ledger_refused";
    else if (error instanceof Errors.InvalidChallengeError) category = "invalid_challenge";
    else if (error instanceof Errors.MalformedCredentialError || error instanceof Errors.InvalidPayloadError) category = "malformed_credential";
    else if (error instanceof Errors.PaymentExpiredError) category = "payment_expired";
    else if (error instanceof Errors.VerificationFailedError) category = "verification_failed";
    else if (error instanceof Errors.PaymentInsufficientError || error instanceof Errors.InsufficientBalanceError) category = "insufficient_funds";
    else if (error instanceof Errors.InvalidSignatureError) category = "invalid_signature";
    else if (error instanceof Errors.PaymentMethodUnsupportedError) category = "unsupported_method";
  } catch {
    // A hostile Proxy must not replace the payment error or expose its properties.
  }
  return { failure_category: category, failure_stage: paymentFailureStage(error) };
}
