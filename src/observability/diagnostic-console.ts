import { projectDiagnosticFields, projectEventName } from "./projection";

type ConsoleLevel = "debug" | "info" | "warn" | "error" | "log";

/** Console-compatible sink that never forwards caller text or values verbatim. */
export const diagnosticConsole = {
  debug: (...values: unknown[]) => emit("debug", values),
  info: (...values: unknown[]) => emit("info", values),
  warn: (...values: unknown[]) => emit("warn", values),
  error: (...values: unknown[]) => emit("error", values),
  log: (...values: unknown[]) => emit("log", values),
};

export function emitDiagnostic(
  level: ConsoleLevel,
  event: unknown,
  fields?: unknown,
  dataset?: string,
): void {
  writeDiagnostic(level, event, fields, dataset);
}

function writeDiagnostic(
  sinkLevel: ConsoleLevel,
  event: unknown,
  fields?: unknown,
  dataset?: string,
  severityOverride?: unknown,
): void {
  try {
    const defaultSeverity =
      sinkLevel === "debug" || sinkLevel === "log" ? "info" : sinkLevel;
    const severity =
      severityOverride === "info" ||
      severityOverride === "warn" ||
      severityOverride === "error"
        ? severityOverride
        : defaultSeverity;
    const eventName = projectEventName(event);
    const record = {
      event: eventName,
      level: severity,
      ...projectDiagnosticFields(fields, dataset, undefined, undefined, eventName),
    };
    const sink = sinkLevel === "log" ? console.log : console[sinkLevel];
    sink(JSON.stringify(record));
  } catch {
    // Diagnostics cannot alter the application or request outcome.
  }
}

function emit(level: ConsoleLevel, values: unknown[]): void {
  const parsed =
    values.length === 1 ? parseStructuredValue(values[0]) : undefined;
  if (parsed) {
    const event = ownValue(parsed, "event");
    const legacyEvent = ownValue(parsed, "level");
    const dataset = ownValue(parsed, "dataset");
    writeDiagnostic(
      level,
      event ?? legacyEvent,
      parsed,
      typeof dataset === "string" ? dataset : undefined,
      legacyEvent,
    );
    return;
  }
  emitDiagnostic(level, "diagnostic.message");
}

function parseStructuredValue(value: unknown): object | undefined {
  if (typeof value === "object" && value !== null) return value;
  if (
    typeof value !== "string" ||
    value.length > 64 * 1024 ||
    !value.startsWith("{")
  )
    return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function ownValue(input: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
