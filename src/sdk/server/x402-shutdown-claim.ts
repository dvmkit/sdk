import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";

// Resolve host-provided environment without adding an option to the public factory.
export const x402ShutdownClaimEnvironment = new AsyncLocalStorage<Record<string, string | undefined>>();

// Only the final claim inherits this budget; ordinary payment and settlement work does not.
export const x402ShutdownClaimSignal = new AsyncLocalStorage<AbortSignal>();

export function waitForX402ShutdownClaim<T>(operation: () => Promise<T>): Promise<T> {
  const signal = x402ShutdownClaimSignal.getStore();
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Stop upstream continuations from starting another storage or facilitator operation after expiry. */
export function withX402ShutdownClaimBudget<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property);
      return typeof value === "function"
        ? (...args: unknown[]) => waitForX402ShutdownClaim(() => Reflect.apply(value, object, args))
        : value;
    },
  });
}

/** A timed-out session must be destroyed: returning a held advisory lock would block the fleet. */
export async function connectForX402ShutdownClaim(pool: Pool): Promise<PoolClient> {
  const signal = x402ShutdownClaimSignal.getStore();
  if (!signal) return pool.connect();
  signal.throwIfAborted();
  const pending = pool.connect();
  let client: PoolClient;
  try {
    client = await waitForX402ShutdownClaim(() => pending);
  } catch (error) {
    // A connection acquired after the caller stopped waiting still belongs to this attempt.
    void pending.then((late) => late.release(true), () => undefined);
    throw error;
  }
  let released = false;
  const release = (destroy?: boolean | Error) => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", abort);
    client.release(destroy);
  };
  const abort = () => release(true);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  return new Proxy(client, {
    get(object, property) {
      if (property === "release") return release;
      if (property === "query") {
        return (...args: unknown[]) => waitForX402ShutdownClaim(() => Reflect.apply(object.query, object, args));
      }
      return Reflect.get(object, property);
    },
  });
}

/** Use a cancellable checkout for the final claim's pool queries, including channel reads and its marker. */
export function poolForX402ShutdownClaim(pool: Pool): Pool {
  if (!x402ShutdownClaimSignal.getStore()) return pool;
  return new Proxy(pool, {
    get(object, property) {
      if (property === "query") {
        return async (...args: unknown[]) => {
          const client = await connectForX402ShutdownClaim(object);
          try {
            return await Reflect.apply(client.query, client, args);
          } finally {
            client.release();
          }
        };
      }
      return Reflect.get(object, property);
    },
  });
}
