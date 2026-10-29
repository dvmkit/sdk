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

  // pg-pool passes `options` to every new Client, so this startup parameter
  // labels ordinary and dedicated LISTEN connections without a per-checkout
  // SET/RESET cycle. Settlement pools override the inherited host label here.
  pool.options.application_name = formatPostgresApplicationName(label);

  pool.on("error", (_err: Error) => {
    diagnosticConsole.error();
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
      const client = await origConnect();
      guardCheckedOutClient(client, label);
      const remainingMs = (postgresRecovery.getStore()?.deadlineMs ?? Infinity) - Date.now();
      const probe = {
        text: "SELECT 1",
        query_timeout: Math.max(1, Math.min(connectionTimeoutMs(pool), remainingMs)),
      };
      try {
        await client.query(probe);
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
  emitter.on("error", (_err: Error) => {
    diagnosticConsole.error();
  });
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
