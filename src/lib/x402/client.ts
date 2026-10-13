import { type PaymentRequirementsV1, type PaymentRequirementsV2 } from "./spec";

/** Whether an exact requirement uses the supported EIP-3009 transfer method. */
export function isSignableExactRequirement(
  requirement: PaymentRequirementsV1 | PaymentRequirementsV2
): boolean {
  // `extra` is spec-optional: a chain that needs no EIP-712 domain advertises
  // none, which means the default transfer method rather than an unsupported one.
  const transferMethod = requirement.extra?.assetTransferMethod;
  return (
    requirement.scheme === "exact" && (transferMethod === undefined || transferMethod === "eip3009")
  );
}
