import { diagnosticConsole } from "../../observability/diagnostic-console";
import { BaseError, InsufficientFundsError } from "viem";

/** Default operator fee-token reserve: $0.01 for Tempo's 6-decimal tokens. */
export const TEMPO_SETTLEMENT_DEFAULT_LOW_BALANCE_MICRO = 10_000n;

/** Default cadence for the in-process operator fee-token gauge. */
export const TEMPO_SETTLEMENT_BALANCE_INTERVAL_MS = 5 * 60 * 1_000;

/** A configured Tempo operator fee-token balance reading. */
export interface TempoSettlementBalanceObservation {
  address: `0x${string}`;
  network: string;
  token: `0x${string}`;
  balanceMicro: bigint;
  lowBalanceMicro: bigint;
  checkedAt: number;
  /** Whether balance and any fee-rejection latch both permit new sessions. */
  ready: boolean;
}

/** A redacted operator-funded transaction rejection. */
export interface TempoSettlementFailureObservation {
  address: `0x${string}`;
  network: string;
  token: `0x${string}`;
  operation: "settle" | "close";
  errorClass: "InsufficientFundsError";
  checkedAt: number;
  balanceMicro?: bigint;
  channelId?: string;
  creditId?: string;
  drainId?: string;
}

/** Listener for platform reporting and builder-supplied observability. */
export interface TempoSettlementReadinessListener {
  onBalance?(observation: TempoSettlementBalanceObservation): Promise<void> | undefined;
  onFailure?(observation: TempoSettlementFailureObservation): Promise<void> | undefined;
}

/** Fleet-wide persisted state for one DVM/operator/token readiness epoch. */
export interface TempoSettlementFailureState {
  latched: boolean;
  version?: string;
  balanceMicro?: bigint;
}

/** Durable latch operations shared by every Machine serving a hosted DVM. */
export interface TempoSettlementReadinessStateStore {
  readFailure(): Promise<TempoSettlementFailureState>;
  latchFailure(): Promise<TempoSettlementFailureState>;
  captureFailureBalance(version: string, balanceMicro: bigint): Promise<boolean>;
  clearFailureIfRefilled(
    version: string,
    balanceMicro: bigint,
    lowBalanceMicro: bigint
  ): Promise<boolean>;
  clearFailureAfterSuccessfulTransaction(version: string): Promise<boolean>;
}

export interface TempoSettlementReadinessOptions {
  address: `0x${string}`;
  network: string;
  token: `0x${string}`;
  lowBalanceMicro?: bigint;
  balanceCheckIntervalMs?: number;
  readBalance(): Promise<bigint>;
  stateStore?: TempoSettlementReadinessStateStore;
  now?: () => number;
}

/**
 * Readiness gate for the account that funds Tempo session settlement.
 *
 * The timer is deliberately unref'd: it reports only while the Fly Machine is
 * awake and can never keep one awake or cause an external wake. An explicit
 * fee rejection is stronger evidence than a balance reading, so hosted DVMs
 * persist that latch in their shared database until a later successful operator
 * transaction or an observed refill clears it for every Machine.
 */
export class TempoSettlementReadiness {
  private readonly lowBalanceMicro: bigint;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<TempoSettlementReadinessListener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<TempoSettlementBalanceObservation> | undefined;
  private lastBalanceMicro: bigint | undefined;
  private failureBalanceMicro: bigint | undefined;
  private failureVersion: string | undefined;
  private failureLatched = false;
  private failureStateKnown: boolean;
  private localFailureGeneration = 0;
  private pendingFailureGeneration = 0;
  private failurePersistence: Promise<void> | undefined;

  constructor(private readonly opts: TempoSettlementReadinessOptions) {
    this.lowBalanceMicro = opts.lowBalanceMicro ?? TEMPO_SETTLEMENT_DEFAULT_LOW_BALANCE_MICRO;
    this.intervalMs = opts.balanceCheckIntervalMs ?? TEMPO_SETTLEMENT_BALANCE_INTERVAL_MS;
    this.now = opts.now ?? Date.now;
    this.failureStateKnown = !opts.stateStore;
    if (this.lowBalanceMicro <= 0n) {
      throw new Error("Tempo settlement lowBalanceMicro must be positive");
    }
    if (!Number.isFinite(this.intervalMs) || this.intervalMs <= 0) {
      throw new Error("Tempo settlement balanceCheckIntervalMs must be positive");
    }
  }

  /** Whether new Tempo session channels may be offered at this instant. */
  available(): boolean {
    return (
      !this.failureLatched &&
      this.failureStateKnown &&
      this.lastBalanceMicro !== undefined &&
      this.lastBalanceMicro >= this.lowBalanceMicro
    );
  }

  /** Refresh shared failure state and hold the first balance read before gating. */
  async ensureFresh(): Promise<void> {
    if (this.lastBalanceMicro === undefined) {
      await this.checkBalance().catch(() => undefined);
      return;
    }
    const state = await this.refreshFailureState().catch((error: unknown) => {
      logStateFailure(error);
      return undefined;
    });
    if (state?.latched && state.balanceMicro === undefined) {
      await this.checkBalance().catch(() => undefined);
    }
  }

  /** Add a reporting listener; the disposer removes only that listener. */
  subscribe(listener: TempoSettlementReadinessListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Start the boot reading and in-process cadence. Idempotent. */
  start(): void {
    if (this.timer) return;
    void this.checkBalance().catch(logBalanceFailure);
    this.timer = setInterval(
      () => void this.checkBalance().catch(logBalanceFailure),
      this.intervalMs
    );
    this.timer.unref();
  }

  /** Stop the cadence without affecting any in-flight reading. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async checkBalance(opts?: {
    successfulTransaction?: boolean;
    recoveryVersion?: string;
  }): Promise<TempoSettlementBalanceObservation> {
    if (this.inFlight) {
      const current = await this.inFlight;
      if (!opts?.successfulTransaction) return current;
    }
    const check = this.checkBalanceOnce(opts).finally(() => {
      if (this.inFlight === check) this.inFlight = undefined;
    });
    this.inFlight = check;
    return check;
  }

  /** Latch fleet-wide and report every redacted fee-funding rejection. */
  async recordInsufficientFunds(
    failure: Omit<
      TempoSettlementFailureObservation,
      "address" | "network" | "token" | "errorClass" | "checkedAt" | "balanceMicro"
    >
  ): Promise<void> {
    this.failureLatched = true;
    this.failureStateKnown = true;
    this.failureBalanceMicro = undefined;
    this.failureVersion = undefined;
    let sharedLatchWritten = false;
    if (this.opts.stateStore) {
      this.localFailureGeneration += 1;
      this.pendingFailureGeneration = this.localFailureGeneration;
      try {
        await this.persistPendingFailure();
        sharedLatchWritten = this.pendingFailureGeneration === 0;
      } catch (error) {
        logStateFailure(error);
      }
    } else {
      this.failureBalanceMicro ??= this.lastBalanceMicro;
    }
    const observation: TempoSettlementFailureObservation = {
      address: this.opts.address,
      network: this.opts.network,
      token: this.opts.token,
      operation: failure.operation,
      errorClass: "InsufficientFundsError",
      checkedAt: this.now(),
      ...(this.lastBalanceMicro !== undefined ? { balanceMicro: this.lastBalanceMicro } : {}),
      ...(failure.channelId ? { channelId: failure.channelId } : {}),
      ...(failure.creditId ? { creditId: failure.creditId } : {}),
      ...(failure.drainId ? { drainId: failure.drainId } : {}),
    };
    diagnosticConsole.warn(
      {
        level: "warn",
        event: "tempo_settlement_insufficient_funds",
        address: observation.address,
        network: observation.network,
        token: observation.token,
        operation: observation.operation,
        error_class: observation.errorClass,
        ...(observation.channelId ? { channel_id: observation.channelId } : {}),
        ...(observation.creditId ? { credit_id: observation.creditId } : {}),
        ...(observation.drainId ? { drain_id: observation.drainId } : {}),
      }
    );
    await this.notify((listener) => listener.onFailure?.(observation));
    if (sharedLatchWritten && this.failureBalanceMicro === undefined) {
      await this.captureFailureBalance().catch(logBalanceFailure);
    }
  }

  /** Snapshot the failure version an operator-funded transaction may recover. */
  async captureRecoveryVersion(): Promise<string | undefined> {
    const state = await this.refreshFailureState().catch((error: unknown) => {
      logStateFailure(error);
      return undefined;
    });
    return state?.latched ? state.version : undefined;
  }

  /** Re-check after a landed transaction and recover only its preflight version. */
  async recordSuccessfulTransaction(recoveryVersion?: string): Promise<void> {
    await this.checkBalance({
      successfulTransaction: true,
      ...(recoveryVersion ? { recoveryVersion } : {}),
    }).catch(logBalanceFailure);
  }

  /** Exposed for timer-lifecycle assertions without reaching into Node internals. */
  timerHasRef(): boolean | undefined {
    return this.timer?.hasRef();
  }

  private async checkBalanceOnce(opts?: {
    successfulTransaction?: boolean;
    recoveryVersion?: string;
  }): Promise<TempoSettlementBalanceObservation> {
    const state = await this.refreshFailureState().catch((error: unknown) => {
      logStateFailure(error);
      return this.currentFailureState();
    });
    const balanceMicro = await this.opts.readBalance();
    if (this.opts.stateStore && state?.latched && state.version) {
      if (
        opts?.successfulTransaction &&
        opts.recoveryVersion &&
        balanceMicro >= this.lowBalanceMicro
      ) {
        await this.opts.stateStore.clearFailureAfterSuccessfulTransaction(opts.recoveryVersion);
      }
      if (state.balanceMicro === undefined) {
        await this.opts.stateStore.captureFailureBalance(state.version, balanceMicro);
      } else {
        await this.opts.stateStore.clearFailureIfRefilled(
          state.version,
          balanceMicro,
          this.lowBalanceMicro
        );
      }
      await this.refreshFailureState().catch(logStateFailure);
    } else if (!this.opts.stateStore) {
      const refilled =
        this.failureLatched &&
        this.failureBalanceMicro !== undefined &&
        balanceMicro > this.failureBalanceMicro;
      if (
        this.failureLatched &&
        balanceMicro >= this.lowBalanceMicro &&
        (opts?.successfulTransaction || refilled)
      ) {
        this.failureLatched = false;
        this.failureBalanceMicro = undefined;
      }
    }
    this.lastBalanceMicro = balanceMicro;
    return this.reportBalance(balanceMicro);
  }

  private async captureFailureBalance(): Promise<void> {
    if (!this.opts.stateStore || !this.failureVersion) return;
    const version = this.failureVersion;
    const balanceMicro = await this.opts.readBalance();
    await this.opts.stateStore.captureFailureBalance(version, balanceMicro);
    await this.refreshFailureState();
    this.lastBalanceMicro = balanceMicro;
    await this.reportBalance(balanceMicro);
  }

  private async refreshFailureState(): Promise<TempoSettlementFailureState | undefined> {
    if (!this.opts.stateStore) return undefined;
    try {
      await this.persistPendingFailure();
      const generation = this.localFailureGeneration;
      const state = await this.opts.stateStore.readFailure();
      if (generation !== this.localFailureGeneration || this.pendingFailureGeneration !== 0) {
        return this.currentFailureState();
      }
      this.applyFailureState(state);
      return state;
    } catch (error) {
      if (this.pendingFailureGeneration !== 0) {
        this.failureLatched = true;
        this.failureStateKnown = true;
      } else {
        this.failureStateKnown = false;
      }
      throw error;
    }
  }

  private async persistPendingFailure(): Promise<void> {
    if (!this.opts.stateStore) return;
    while (this.pendingFailureGeneration !== 0) {
      if (this.failurePersistence) {
        await this.failurePersistence;
        continue;
      }
      const generation = this.pendingFailureGeneration;
      const persistence = this.opts.stateStore.latchFailure().then((state) => {
        if (this.pendingFailureGeneration !== generation) return;
        this.pendingFailureGeneration = 0;
        this.applyFailureState(state);
      });
      this.failurePersistence = persistence;
      try {
        await persistence;
      } finally {
        if (this.failurePersistence === persistence) this.failurePersistence = undefined;
      }
    }
  }

  private applyFailureState(state: TempoSettlementFailureState): void {
    this.failureLatched = state.latched;
    this.failureVersion = state.latched ? state.version : undefined;
    this.failureBalanceMicro = state.latched ? state.balanceMicro : undefined;
    this.failureStateKnown = true;
  }

  private currentFailureState(): TempoSettlementFailureState {
    return {
      latched: this.failureLatched,
      ...(this.failureVersion ? { version: this.failureVersion } : {}),
      ...(this.failureBalanceMicro !== undefined ? { balanceMicro: this.failureBalanceMicro } : {}),
    };
  }

  private async reportBalance(balanceMicro: bigint): Promise<TempoSettlementBalanceObservation> {
    const observation: TempoSettlementBalanceObservation = {
      address: this.opts.address,
      network: this.opts.network,
      token: this.opts.token,
      balanceMicro,
      lowBalanceMicro: this.lowBalanceMicro,
      checkedAt: this.now(),
      ready: this.available(),
    };
    diagnosticConsole.info(
      {
        level: "info",
        event: "tempo_settlement_fee_balance",
        address: observation.address,
        network: observation.network,
        token: observation.token,
        balance_micro: observation.balanceMicro.toString(),
        low_balance_micro: observation.lowBalanceMicro.toString(),
        ready: observation.ready,
      }
    );
    await this.notify((listener) => listener.onBalance?.(observation));
    return observation;
  }

  private async notify(
    invoke: (listener: TempoSettlementReadinessListener) => Promise<void> | undefined
  ): Promise<void> {
    await Promise.all(
      [...this.listeners].map((listener) =>
        Promise.resolve(invoke(listener)).catch(() => undefined)
      )
    );
  }
}

/** True only when viem's causal chain contains its stable insufficient-funds class. */
export function isTempoInsufficientFundsError(error: unknown): boolean {
  if (error instanceof InsufficientFundsError) return true;
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof InsufficientFundsError) !== null
  );
}

function logBalanceFailure(_error: unknown): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "tempo_settlement_fee_balance_failed",
      error_name: undefined,
    }
  );
}

function logStateFailure(_error: unknown): void {
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "tempo_settlement_readiness_state_failed",
      error_name: undefined,
    }
  );
}
