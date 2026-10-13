import { diagnosticConsole } from "../../observability/diagnostic-console";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import type { SupportedResponse } from "@x402/core/types";
import type { FacilitatorEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import type {
  X402SelfRelayBalanceObservation,
  X402SelfRelayConfig,
  X402SelfRelayRpcFailureReason,
  X402SelfRelayRpcHealthObservation,
} from "../../lib/x402/types";
import { type X402RelaySubmissionLock, X402RelaySubmissionLockError } from "./x402-channel-store";

/** Default reserve floor: 0.001 ETH, ample runway at Base's normal fees. */
export const X402_SELF_RELAY_DEFAULT_LOW_BALANCE_WEI = 1_000_000_000_000_000n;

/** Default cadence for the relay gas-balance gauge. */
export const X402_SELF_RELAY_BALANCE_INTERVAL_MS = 5 * 60 * 1_000;

/** Live local facilitator plus its gas-balance monitor. */
export interface X402SelfRelay {
  client: FacilitatorClient;
  address: `0x${string}`;
  checkBalance(): Promise<X402SelfRelayBalanceObservation>;
  start(): void;
  stop(): void;
}

export interface CreateX402SelfRelayOpts {
  network: string;
  config: X402SelfRelayConfig;
  /**
   * Fleet-wide serialisation of this EOA's submissions. Absent leaves the
   * in-process tail as the only guard — correct on a single machine, and
   * announced at boot (`x402_self_relay_unserialized`) anywhere else.
   */
  submissionLock?: X402RelaySubmissionLock;
}

/** Chain and wallet operations wrapped by the self-relay signer. */
export interface X402SelfRelaySignerBackend extends Omit<FacilitatorEvmSigner, "getAddresses"> {
  address: `0x${string}`;
}

/** Inputs for the relay signer adapter, exposed for custom transports and tests. */
export interface CreateX402SelfRelaySignerOpts {
  backend: X402SelfRelaySignerBackend;
  network: string;
  submissionLock?: X402RelaySubmissionLock;
}

/** Build an in-process batch facilitator over one dedicated per-DVM Base EOA. */
export function createX402SelfRelay(opts: CreateX402SelfRelayOpts): X402SelfRelay {
  if (!opts.config.rpcUrl.trim()) throw new Error("x402 self-relay requires an explicit RPC URL");
  if (opts.config.lowBalanceWei !== undefined && opts.config.lowBalanceWei <= 0n) {
    throw new Error("x402 self-relay lowBalanceWei must be positive");
  }
  if (
    opts.config.balanceCheckIntervalMs !== undefined &&
    (!Number.isFinite(opts.config.balanceCheckIntervalMs) ||
      opts.config.balanceCheckIntervalMs <= 0)
  ) {
    throw new Error("x402 self-relay balanceCheckIntervalMs must be positive");
  }
  const chain = relayChain(opts.network);
  const account = privateKeyToAccount(opts.config.privateKey);
  const transport = http(opts.config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });
  const observeRpcFailure = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      const reason = classifyX402SelfRelayRpcFailure(error);
      if (reason) await reportRpcFailure(opts.config, account.address, opts.network, reason);
      throw error;
    }
  };
  const signer = createX402SelfRelaySigner({
    network: opts.network,
    ...(opts.submissionLock ? { submissionLock: opts.submissionLock } : {}),
    backend: {
      address: account.address,
      readContract: (args) => observeRpcFailure(() => publicClient.readContract(args as never)),
      verifyTypedData: (args) =>
        observeRpcFailure(() => publicClient.verifyTypedData(args as never)),
      writeContract: (args) => observeRpcFailure(() => walletClient.writeContract(args as never)),
      sendTransaction: (args) =>
        observeRpcFailure(() => walletClient.sendTransaction(args as never)),
      waitForTransactionReceipt: async (args) => {
        const receipt = await observeRpcFailure(() => publicClient.waitForTransactionReceipt(args));
        return { status: receipt.status, logs: receipt.logs };
      },
      getCode: (args) => observeRpcFailure(() => publicClient.getCode(args)),
    },
  });

  const local = new x402Facilitator().register(
    opts.network as `${string}:${string}`,
    new BatchSettlementEvmScheme(signer)
  );
  const client: FacilitatorClient = {
    verify: (payload, requirements) => local.verify(payload, requirements),
    settle: (payload, requirements) => local.settle(payload, requirements),
    getSupported: () => Promise.resolve(local.getSupported() as SupportedResponse),
  };

  const lowBalanceWei = opts.config.lowBalanceWei ?? X402_SELF_RELAY_DEFAULT_LOW_BALANCE_WEI;
  const intervalMs = opts.config.balanceCheckIntervalMs ?? X402_SELF_RELAY_BALANCE_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  const checkBalance = async (): Promise<X402SelfRelayBalanceObservation> => {
    const checkedAt = Date.now();
    let balanceWei: bigint;
    try {
      balanceWei = await publicClient.getBalance({ address: account.address });
    } catch (error) {
      const reason = classifyX402SelfRelayRpcFailure(error) ?? "transport";
      await reportRpcFailure(opts.config, account.address, opts.network, reason, checkedAt);
      throw error;
    }
    const observation = {
      address: account.address,
      network: opts.network,
      balanceWei,
      lowBalanceWei,
      checkedAt,
    };
    diagnosticConsole.info(
      {
        level: "info",
        event: "x402_self_relay_gas_balance",
        address: observation.address,
        network: observation.network,
        balance_wei: observation.balanceWei.toString(),
        low_balance_wei: observation.lowBalanceWei.toString(),
      }
    );
    await Promise.all([
      opts.config.onBalance?.(observation),
      opts.config.onRpcHealth?.({
        address: account.address,
        network: opts.network,
        status: "healthy",
        checkedAt,
      }),
    ]);
    return observation;
  };

  return {
    client,
    address: account.address,
    checkBalance,
    start() {
      if (timer) return;
      void checkBalance().catch(logBalanceFailure);
      timer = setInterval(() => void checkBalance().catch(logBalanceFailure), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Adapt a dedicated wallet backend to every operation the x402 facilitator requires. */
export function createX402SelfRelaySigner(
  opts: CreateX402SelfRelaySignerOpts
): FacilitatorEvmSigner {
  const submissionLock = createSubmissionLock(
    opts.submissionLock,
    opts.network,
    opts.backend.address
  );
  return {
    getAddresses: () => [opts.backend.address],
    readContract: (args) => opts.backend.readContract(args),
    verifyTypedData: (args) => opts.backend.verifyTypedData(args),
    writeContract: (args) => submissionLock(() => opts.backend.writeContract(args)),
    sendTransaction: (args) => submissionLock(() => opts.backend.sendTransaction(args)),
    waitForTransactionReceipt: (args) => opts.backend.waitForTransactionReceipt(args),
    getCode: (args) => opts.backend.getCode(args),
  };
}

function relayChain(network: string): typeof base {
  if (network === "eip155:8453") return base;
  throw new Error(`x402 self-relay supports Base mainnet only; got ${network}`);
}

/**
 * Serialize this EOA's chain submissions, in-process and then fleet-wide.
 *
 * The in-process tail comes first and is load-bearing beyond its own ordering:
 * it is what caps the process at one durable acquire — and so one pooled
 * connection — no matter how many deposits land at once. The durable
 * half is the store's, which holds the acquire on a terminal pool and bounds it
 * with a `lock_timeout`; this module deliberately owns no connection of its own,
 * because every path that reaches it is already holding a host-pool client.
 *
 * A refusal is inherited by whoever was **already queued** behind it, rather
 * than each of them starting a fresh wait. The `lock_timeout` bounds one
 * acquire, so without this a fleet-mate wedged for minutes costs N × the
 * ceiling: every queued caller is holding a host-pool client and a channel
 * advisory lock for its whole turn, so the queue amplifies exactly the thing
 * the ceiling exists to bound. Inheriting collapses a burst to one casualty.
 * A caller arriving *after* the refusal took its own snapshot and so attempts
 * normally — which is what lets the lock recover with no prober and no
 * cooldown to tune.
 */
function createSubmissionLock(
  lock: X402RelaySubmissionLock | undefined,
  network: string,
  address: string
): <T>(operation: () => Promise<T>) => Promise<T> {
  const key = `x402-self-relay:${network}:${address.toLowerCase()}`;
  let tail = Promise.resolve();
  let lastRefusal: X402RelaySubmissionLockError | undefined;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const refusalAtEntry = lastRefusal;
    const prior = tail;
    let releaseLocal!: () => void;
    tail = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    await prior;
    try {
      if (!lock) return await operation();
      if (lastRefusal && lastRefusal !== refusalAtEntry) throw lastRefusal;
      return await lock.withRelaySubmissionLock(key, operation);
    } catch (error) {
      // Identity, not `instanceof`: an inherited refusal is the same object, and
      // one wedge must produce one log line rather than one per queued caller.
      if (error instanceof X402RelaySubmissionLockError && error !== lastRefusal) {
        lastRefusal = error;
        logSubmissionLockTimeout(error);
      }
      throw error;
    } finally {
      releaseLocal();
    }
  };
}

function logSubmissionLockTimeout(error: X402RelaySubmissionLockError): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "x402_self_relay_submission_lock_timeout",
      lock_key: error.lockKey,
      timeout_ms: error.timeoutMs,
      ...(error.holder
        ? {
            holder_pid: error.holder.pid,
            ...(error.holder.applicationName
              ? { holder_application: error.holder.applicationName }
              : {}),
            ...(error.holder.clientAddr ? { holder_client_addr: error.holder.clientAddr } : {}),
            ...(error.holder.state ? { holder_state: error.holder.state } : {}),
            ...(error.holder.heldSeconds !== undefined
              ? { holder_held_seconds: error.holder.heldSeconds }
              : {}),
          }
        : {}),
    }
  );
}

function logBalanceFailure(_error: unknown): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "x402_self_relay_gas_balance_failed",
      error_name: undefined,
    }
  );
}

/** Classify only provider/transport faults that require an operator response. */
export function classifyX402SelfRelayRpcFailure(
  error: unknown
): X402SelfRelayRpcFailureReason | undefined {
  for (const candidate of errorChain(error)) {
    const status = numericField(candidate, "status") ?? numericField(candidate, "statusCode");
    const code = stringField(candidate, "code");
    const name = stringField(candidate, "name");
    const message = stringField(candidate, "message")?.toLowerCase() ?? "";
    if (
      status === 401 ||
      status === 403 ||
      /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication/.test(message)
    ) {
      return "authentication";
    }
    if (status === 429 || /\b429\b|rate[ -]?limit|too many requests/.test(message)) {
      return "rate_limit";
    }
    if (
      ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"].includes(code ?? "") ||
      ["HttpRequestError", "TimeoutError", "SocketError", "FetchError"].includes(name ?? "") ||
      /fetch failed|failed to fetch|network error|timed? out|connection (?:refused|reset)|socket hang up|http request failed/.test(
        message
      )
    ) {
      return "transport";
    }
  }
  return undefined;
}

async function reportRpcFailure(
  config: X402SelfRelayConfig,
  address: `0x${string}`,
  network: string,
  reason: X402SelfRelayRpcFailureReason,
  checkedAt = Date.now()
): Promise<void> {
  const observation: X402SelfRelayRpcHealthObservation = {
    address,
    network,
    status: "failed",
    reason,
    checkedAt,
  };
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "x402_self_relay_rpc_failed",
      address,
      network,
      reason,
    }
  );
  await Promise.resolve(config.onRpcHealth?.(observation)).catch(() => {
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "x402_self_relay_rpc_health_report_failed",
        address,
        network,
        reason,
      }
    );
  });
}

function errorChain(error: unknown): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth += 1) {
    const candidate = current as Record<string, unknown>;
    chain.push(candidate);
    current = candidate.cause;
  }
  return chain;
}

function numericField(value: Record<string, unknown>, field: string): number | undefined {
  return typeof value[field] === "number" ? value[field] : undefined;
}

function stringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}
