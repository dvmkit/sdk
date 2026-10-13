import { emitDiagnostic } from "../observability/diagnostic-console";
import { projectDiagnosticFields } from "../observability/projection";
import type { Logger } from "./types";

export function createConsoleLogger(_jobId: string): Logger {
  return {
    debug(_message, data) {
      emitDiagnostic("debug", "diagnostic.message", data);
    },
    info(_message, data) {
      emitDiagnostic("info", "diagnostic.message", data);
    },
    warn(_message, data) {
      emitDiagnostic("warn", "diagnostic.message", data);
    },
    error(_message, data) {
      emitDiagnostic("error", "diagnostic.message", data);
    }
  };
}

/**
 * Create a logger that emits one structured JSON line per call to stdout/stderr,
 * matching the platform alert modules' `console.log(JSON.stringify({ ... }))`
 * convention. For host-level call sites that have no per-job context (e.g. the
 * cleanup-route handler), where `createConsoleLogger`'s job-id prefix doesn't
 * apply. `context` tags every line (e.g. `{ dvm: "cast" }`); per-call `data`
 * wins on key collision.
 */
export function createStdoutLogger(context?: Record<string, unknown>): Logger {
  const emit =
    (level: "debug" | "info" | "warn" | "error") =>
    (_message: string, data?: Record<string, unknown>): void => {
      emitDiagnostic(level, "diagnostic.message", {
        ...projectDiagnosticFields(context),
        ...projectDiagnosticFields(data)
      });
    };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error")
  };
}

export function createNoopLogger(): Logger {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
