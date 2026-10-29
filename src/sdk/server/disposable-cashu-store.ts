import type { Proof } from "@cashu/cashu-ts";

import type { CreditLedgerLike } from "./credit-ledger";
import { MemoryCreditLedger } from "./memory-credit-ledger";
import { AccumulatorReplayError } from "./wallet-accumulator-store";

/** Typed transaction boundary; proof ownership and accounting commit together. */
export interface DisposableCashuCommit {
  commit(
    requestId: string,
    proofs: Proof[],
    account: (ledger: CreditLedgerLike) => Promise<void>
  ): Promise<void>;
  /** The request id each secret was committed under, index-aligned; `undefined` where not committed. */
  acceptedRequestIds(secrets: string[]): Promise<(string | undefined)[]>;
}

/** A process-local, test-funds-only store. Never substitutes for durable production storage. */
export function createDisposableCashuStore(): {
  ledger: CreditLedgerLike;
  accumulator: DisposableCashuCommit;
} {
  let current = new MemoryCreditLedger();
  let tail = Promise.resolve();
  const requests = new Set<string>();
  const secrets = new Map<string, string>();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }
  // Reads queue too: nobody can observe a partially funded transaction. Calls
  // inside commit use the staged ledger directly and never reacquire this lock.
  const ledger = new Proxy(current, {
    get(_target, key) {
      const member = Reflect.get(current, key) as unknown;
      if (typeof member !== "function") return member;
      // Configuration is synchronous and occurs before the host admits jobs.
      if (key === "useX402SettlementGate") return member.bind(current);
      return (...args: unknown[]) => exclusive(async () => {
        const method = Reflect.get(current, key) as (...values: unknown[]) => unknown;
        return await method.apply(current, args);
      });
    },
  });
  return {
    ledger,
    accumulator: {
      commit(requestId, proofs, account) {
        return exclusive(async () => {
          const incoming = proofs.map((proof) => proof.secret);
          if (requests.has(requestId) || new Set(incoming).size !== incoming.length ||
              incoming.some((secret) => secrets.has(secret))) {
            throw new AccumulatorReplayError("disposable", requestId);
          }
          const staged = current.forkForTransaction();
          await account(staged);
          // No awaits between these writes: publication is atomic in this process.
          current = staged;
          requests.add(requestId);
          for (const secret of incoming) secrets.set(secret, requestId);
        });
      },
      acceptedRequestIds(incoming) {
        return exclusive(() => Promise.resolve(incoming.map((secret) => secrets.get(secret))));
      },
    },
  };
}
