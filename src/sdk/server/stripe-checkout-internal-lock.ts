import { setTimeout as delay } from "node:timers/promises";

import type { LockedStripeCheckout, StripeCheckoutStore } from "./stripe-checkout-store";

// Internal bookkeeping must survive a sibling's brief NOWAIT transaction. Release the
// connection between attempts; client-facing booking polls still use withRecord directly.
export async function withCheckoutInternalLock<T>(
  store: StripeCheckoutStore, fundId: string, run: (locked: LockedStripeCheckout) => Promise<T>
): Promise<T> {
  const deadline = Date.now() + 1000;
  for (;;) {
    try { return await store.withRecord(fundId, run); }
    catch (error) {
      if ((error as { code?: string })?.code !== "55P03" || Date.now() >= deadline) throw error;
      await delay(10);
    }
  }
}
