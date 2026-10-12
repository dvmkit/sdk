import { AsyncLocalStorage } from "node:async_hooks";

export type PaymentFailureStage =
  | "verifier"
  | "broadcast"
  | "verifier_broadcast"
  | "replay_store"
  | "funding_ledger"
  | "unknown";

interface PaymentFailure {
  error: unknown;
  stage: PaymentFailureStage;
}

const scopes = new AsyncLocalStorage<{ failure?: PaymentFailure }>();

/** Keep concurrent payments and nested operations from overwriting each other's failure stage. */
export function withPaymentDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  return scopes.run({}, fn);
}

/** Record the narrowest observed operation without wrapping or replacing its exception. */
export async function withPaymentStage<T>(stage: PaymentFailureStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const scope = scopes.getStore();
    if (scope && (!scope.failure || !Object.is(scope.failure.error, error))) {
      scope.failure = { error, stage };
    }
    throw error;
  }
}

export function paymentFailureStage(error: unknown): PaymentFailureStage {
  const failure = scopes.getStore()?.failure;
  return failure && Object.is(failure.error, error) ? failure.stage : "unknown";
}
