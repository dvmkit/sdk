export interface CallerLogger {
  info(name: string, attrs?: Record<string, unknown>): void;
  span<T>(name: string, attrs: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T>;
}

export interface CallerLoggers {
  cashu: CallerLogger;
  lightning: CallerLogger;
  x402: CallerLogger;
}

export let callerLoggers: CallerLoggers = buildNoopLoggers();

export function initCallerLoggers(nextLoggers: CallerLoggers): void {
  callerLoggers = nextLoggers;
}

function buildNoopLoggers(): CallerLoggers {
  const noopLogger: CallerLogger = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- standalone caller has no exporter
    info() {},
    async span<T>(_name: string, _attrs: Record<string, unknown>, fn: () => Promise<T> | T) {
      return fn();
    },
  };
  return {
    cashu: noopLogger,
    lightning: noopLogger,
    x402: noopLogger,
  };
}
