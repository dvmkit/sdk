import { diagnosticConsole } from "../observability/diagnostic-console";
import { AsyncLocalStorage } from "node:async_hooks";

import type { Pool, PoolClient } from "pg";

/** One request-scoped budget for draining stale Postgres sockets. */
export interface PostgresRecoveryContext {
  route: string;
  channelId?: string;
  deadlineMs: number;
  drainPool: boolean;
}

const postgresRecovery = new AsyncLocalStorage<PostgresRecoveryContext>();
const queryingPool = new AsyncLocalStorage<Pool>();

/** Run database work under a bounded request-specific transport-recovery budget. */
export function withPostgresRecoveryContext<value>(
  context: PostgresRecoveryContext,
  operation: () => Promise<value>
): Promise<value> {
  return postgresRecovery.run(context, operation);
}

const checkoutCancellation = new AsyncLocalStorage<AbortSignal>();

/** Include connection establishment and the health probe in a caller's cancellation scope. */
export function withPostgresCheckoutCancellation<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  pool?: Pick<Pool, "connect">
): Promise<T> {
  if (pool) installCheckoutCancellation(pool);
  return checkoutCancellation.run(signal, operation);
}

type CheckoutCallback = (error: Error | undefined, client?: PoolClient, release?: PoolClient["release"]) => void;
type PendingCheckout = { callback: CheckoutCallback; timedOut?: boolean };
type ConnectingClient = Omit<PoolClient, "connect"> & {
  connect(callback: (error?: Error) => void): void;
  end(callback?: () => void): void;
  connection?: { stream: { destroy(): void } };
};
type CancellablePool = Pool & {
  Client: new (...args: unknown[]) => ConnectingClient;
  newClient(pending: PendingCheckout): void;
  _pendingQueue: PendingCheckout[];
  _remove(client: ConnectingClient, callback: () => void): void;
  _pulseQueue(): void;
};
type CheckoutTicket = {
  signal: AbortSignal | undefined;
  settled: boolean;
  pending?: PendingCheckout;
  cancel?: (error: Error) => void;
};
const cancellablePools = new WeakSet<object>();

/**
 * pg retains connecting clients in its pool before a lease exists. Its native
 * queue/newClient boundary identifies which checkout owns a handshake; ambient
 * async context alone can accidentally adopt an unrelated queued checkout when
 * a failed connection pulses the queue. Keep that ownership until checkout,
 * including pg's optional asynchronous onConnect hook.
 */
function installCheckoutCancellation(candidate: Pick<Pool, "connect">): void {
  if (cancellablePools.has(candidate)) return;
  const pool = candidate as CancellablePool;
  if (typeof pool.Client !== "function" || typeof pool.newClient !== "function" ||
      !Array.isArray(pool._pendingQueue) || typeof pool._remove !== "function" || typeof pool._pulseQueue !== "function") return;
  cancellablePools.add(pool);
  const queued = new WeakMap<PendingCheckout, CheckoutTicket>();
  let entering: CheckoutTicket | undefined;
  let constructing: ((client: ConnectingClient) => void) | undefined;
  pool.Client = new Proxy(pool.Client, {
    construct(target, args, newTarget) {
      const client = Reflect.construct(target, args, newTarget) as ConnectingClient;
      constructing?.(client);
      return client;
    },
  });
  const newClient = pool.newClient.bind(pool);
  pool.newClient = (pending) => {
    const ticket = queued.get(pending) ?? entering;
    if (!ticket?.signal) {
      const previous = constructing;
      constructing = undefined;
      try { newClient(pending); } finally { constructing = previous; }
      return;
    }
    const signal = ticket.signal;
    if (ticket.settled || signal.aborted) {
      pending.callback(asError(signal.reason));
      queueMicrotask(() => pool._pulseQueue());
      return;
    }
    let client: ConnectingClient | undefined;
    let rejectHandshake: ((error: Error) => boolean) | undefined;
    let cancelled = false;
    ticket.cancel = (error) => {
      if (cancelled) return;
      cancelled = true;
      pending.timedOut = true;
      // Run pg's handshake callback once to clear its native connection timer
      // and registry entry, then destroy TCP/TLS rather than graceful end().
      const connecting = rejectHandshake?.(error);
      if (client) {
        if (client.connection) client.connection.stream.destroy();
        else client.end();
        if (!connecting) pool._remove(client, () => pool._pulseQueue());
      }
      pending.callback(error);
    };
    const previous = constructing;
    constructing = (created) => {
      client = created;
      const connect = client.connect.bind(client);
      client.connect = (callback) => {
        let called = false;
        const complete = (error?: Error): boolean => {
          if (called) return false;
          called = true;
          callback(error);
          return true;
        };
        rejectHandshake = complete;
        if (signal.aborted) ticket.cancel?.(asError(signal.reason));
        else connect(complete);
      };
    };
    try { newClient(pending); } finally { constructing = previous; }
  };
  const connect = pool.connect.bind(pool);
  pool.connect = ((callback?: CheckoutCallback) => {
    const signal = checkoutCancellation.getStore();
    const ticket: CheckoutTicket = { signal, settled: false };
    const pending = new Promise<PoolClient>((resolve, reject) => {
      const complete: CheckoutCallback = (error, client) => {
        if (ticket.settled) return;
        ticket.settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) {
          ticket.cancel?.(error);
          reject(error);
        } else {
          ticket.cancel = undefined;
          resolve(client!);
        }
      };
      const abort = () => {
        if (ticket.settled) return;
        const error = asError(signal?.reason);
        if (ticket.cancel) ticket.cancel(error);
        else {
          const item = ticket.pending;
          if (item) {
            const index = pool._pendingQueue.indexOf(item);
            if (index !== -1) pool._pendingQueue.splice(index, 1);
            item.timedOut = true;
            item.callback(error);
            pool._pulseQueue();
          } else complete(error);
        }
      };
      if (signal?.aborted) { complete(asError(signal.reason)); return; }
      signal?.addEventListener("abort", abort, { once: true });
      const previous = entering;
      const before = new Set(pool._pendingQueue);
      entering = ticket;
      try { connect(complete); } catch (error) { complete(asError(error)); }
      finally { entering = previous; }
      for (const item of pool._pendingQueue) {
        if (!before.has(item) && !queued.has(item)) {
          queued.set(item, ticket);
          ticket.pending = item;
        }
      }
      if (signal?.aborted) abort();
    });
    if (!callback) return pending;
    void pending.then(
      (client) => callback(undefined, client, client.release),
      (error: unknown) => callback(asError(error), undefined, () => undefined)
    );
  }) as Pool["connect"];
}

async function probeCheckedOutClient(client: PoolClient, probe: { text: string; query_timeout: number }): Promise<void> {
  const signal = checkoutCancellation.getStore();
  if (!signal) {
    await client.query(probe);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    client.query(probe).then(() => resolve(), reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Returns true for TCP/network transport errors that warrant transport recovery.
 * Excludes Postgres-level error codes (5-char alphanumeric, e.g. '23505') — those must never be retried. */
export function isTransportError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  const msg = (err as { message?: unknown }).message;
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return false;
  return (
    (typeof msg === "string" && msg.includes("Connection terminated")) ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND"
  );
}

/** Calls fn, retrying up to delays.length times on transport errors.
 * Logs a warning on each retry. Non-transport errors are rethrown immediately. */
export async function withInitRetry(
  fn: () => Promise<void>,
  label: string,
  delays: number[] = [1000, 4000, 15000]
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      if (!isTransportError(err) || attempt >= delays.length) throw err;
      const wait = delays[attempt];
      diagnosticConsole.warn();
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

const POSTGRES_APPLICATION_NAME_MAX_BYTES = 63;

/** Build the Postgres backend label for a subsystem and optional Fly machine. */
export function formatPostgresApplicationName(
  label: string,
  machineId: string | null | undefined = process.env.FLY_MACHINE_ID
): string {
  const machineSuffix = machineId ? `@${machineId}` : "";
  const boundedMachineSuffix = truncateUtf8(machineSuffix, POSTGRES_APPLICATION_NAME_MAX_BYTES);
  const labelBudget =
    POSTGRES_APPLICATION_NAME_MAX_BYTES - Buffer.byteLength(boundedMachineSuffix, "utf8");
  return `${truncateUtf8(label, labelBudget)}${boundedMachineSuffix}`;
}

const patchedPools = new WeakSet<object>();

/** Checked-out clients that already carry our 'error' guard — deduped so a
 * pooled client's release/re-checkout cycle doesn't stack listeners. */
const guardedClients = new WeakSet<object>();

/** Patches pool.query and pool.connect in-place to retry transport errors.
 * Idempotent — safe to call multiple times on the same pool instance.
 * Recovery may replace every socket in the configured pool. The connection
 * timeout bounds how long ordinary work starts retries; a request context can
 * supply its own deadline.
 * Registers pool.on("error") to prevent idle-client eviction errors from crashing the process,
 * and attaches an 'error' guard to every checked-out client for the same reason (see
 * {@link guardCheckedOutClient}). */
export function applyRetryToPool(pool: Pool, label = "pg-pool"): void {
  if (patchedPools.has(pool)) return;
  patchedPools.add(pool);
  installCheckoutCancellation(pool);

  // pg-pool passes `options` to every new Client, so this startup parameter
  // labels ordinary and dedicated LISTEN connections without a per-checkout
  // SET/RESET cycle. Settlement pools override the inherited host label here.
  pool.options.application_name = formatPostgresApplicationName(label);

  pool.on("error", (err: Error) => {
    diagnosticConsole.error({ event: "postgres_pool_error", error_code: postgresErrorCode(err) });
  });

  type AnyPool = Record<string, (...args: unknown[]) => Promise<unknown>>;
  const p = pool as unknown as AnyPool;

  const origQuery = p.query.bind(pool);
  p.query = (...args: unknown[]) =>
    withTransportRecovery(pool, label, "pool.query", () =>
      queryingPool.run(pool, () => origQuery(...args))
    );

  const origConnect = pool.connect.bind(pool);
  type ConnectCallback = Parameters<Pool["connect"]>[0];
  pool.connect = ((callback?: ConnectCallback) => {
    // pool.query already retries its own statement. Only direct checkouts need
    // a probe, before callers can acquire locks or start money-moving work.
    if (queryingPool.getStore() === pool) {
      return queryingPool.exit(() => callback ? origConnect(callback) : origConnect());
    }
    const pending = withTransportRecovery(pool, label, "pool.connect", async () => {
      checkoutCancellation.getStore()?.throwIfAborted();
      const client = await origConnect();
      guardCheckedOutClient(client, label);
      const remainingMs = (postgresRecovery.getStore()?.deadlineMs ?? Infinity) - Date.now();
      const probe = {
        text: "SELECT 1",
        query_timeout: Math.max(1, Math.min(connectionTimeoutMs(pool), remainingMs)),
      };
      try {
        await probeCheckedOutClient(client, probe);
        return client;
      } catch (error) {
        client.release(asError(error));
        throw error;
      }
    });
    if (!callback) return pending;
    void pending.then(
      (client) => callback(undefined, client, client.release),
      (error: unknown) => callback(asError(error), undefined, () => undefined)
    );
  }) as Pool["connect"];
}

/**
 * Run one database-only transaction, replacing a checked-out client when its
 * transport dies and restarting the transaction from the beginning.
 *
 * Callbacks must keep every side effect inside `client`: a transport failure
 * around `COMMIT` is ambiguous, so the callback can run again and must derive
 * its answer from durable database state. Tempo's settlement-lease update is
 * the canonical caller — its operation token makes an ambiguously committed
 * retry return the same claim without authorising a second chain broadcast.
 */
export function withPostgresTransactionRecovery<value>(
  pool: Pool,
  label: string,
  operation: string,
  callback: (client: PoolClient) => Promise<value>
): Promise<value> {
  return withTransportRecovery(pool, label, operation, async () => {
    const client = await pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      const value = await callback(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isTransportError(error)) releaseError = asError(error);
      throw error;
    } finally {
      client.release(releaseError);
    }
  });
}

async function withTransportRecovery<value>(
  pool: Pool,
  label: string,
  operation: string,
  callback: () => Promise<value>
): Promise<value> {
  const context = postgresRecovery.getStore();
  const maxAttempts = context?.drainPool === false ? 2 : hostPoolSize(pool) + 1;
  const startedAt = Date.now();
  // Stop launching retries within one connect-timeout window. An in-flight
  // attempt still uses pg's timeout, so recovery cannot multiply that wait by
  // pool size. Do not race database writes against an uncancellable timer.
  const deadlineMs = context?.deadlineMs ?? startedAt + connectionTimeoutMs(pool);
  let firstError: Error | undefined;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const value = await callback();
      if (firstError) {
        logTransportRecovery({
          context,
          label,
          operation,
          attempts: attempt,
          elapsedMs: Date.now() - startedAt,
          outcome: "recovered",
          error: firstError.message,
        });
      }
      return value;
    } catch (error) {
      if (!isTransportError(error)) throw error;
      firstError ??= asError(error);
      const elapsedMs = Date.now() - startedAt;
      if (attempt >= maxAttempts || Date.now() >= deadlineMs) {
        logTransportRecovery({
          context,
          label,
          operation,
          attempts: attempt,
          elapsedMs,
          outcome: "exhausted",
          error: asError(error).message,
        });
        throw error;
      }
    }
  }
}

function connectionTimeoutMs(pool: Pool): number {
  const configured = pool.options.connectionTimeoutMillis;
  return typeof configured === "number" && Number.isFinite(configured) && configured > 0
    ? configured
    : 10_000;
}

function hostPoolSize(pool: Pool): number {
  const configured = pool.options.max;
  return typeof configured === "number" && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : 10;
}

function logTransportRecovery(args: {
  context: PostgresRecoveryContext | undefined;
  label: string;
  operation: string;
  attempts: number;
  elapsedMs: number;
  outcome: "recovered" | "exhausted";
  error: string;
}): void {
  diagnosticConsole.warn(
    {
      level: "postgres_transport_recovery",
      label: args.label,
      route: args.context?.route,
      channel_id: args.context?.channelId,
      operation: args.operation,
      attempts: args.attempts,
      elapsed_ms: args.elapsedMs,
      outcome: args.outcome,
      error: undefined,
    }
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Checked-out socket errors are events, not promise rejections; query retry cannot catch them.
 * Keep one listener per physical client across release/re-checkout while query errors still reject.
 */
function guardCheckedOutClient(client: unknown, _label: string): void {
  if (client === null || typeof client !== "object") return;
  const emitter = client as { on?: (event: string, cb: (err: Error) => void) => void };
  if (typeof emitter.on !== "function" || guardedClients.has(client)) return;
  guardedClients.add(client);
  emitter.on("error", (err: Error) => {
    diagnosticConsole.error({ event: "postgres_client_error", error_code: postgresErrorCode(err) });
  });
}

/** Extract only the code for diagnostic projection; never stringify a database error. */
export function postgresErrorCode(error: unknown): string {
  try {
    if (error !== null && typeof error === "object") {
      const descriptor = Object.getOwnPropertyDescriptor(error, "code");
      const code: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (typeof code === "string") return code;
    }
  } catch {
    // Untrusted error objects may reject property inspection.
  }
  return "unknown_error";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  let result = "";
  for (const character of value) {
    const next = result + character;
    if (Buffer.byteLength(next, "utf8") > maxBytes) break;
    result = next;
  }
  return result;
}
