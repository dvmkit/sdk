/** Error prose fields whose value may have originated outside the CLI. */
export type DvmErrorProseField = "message" | "hint" | "display";

/** Explicit origin metadata carried with a DvmError until JSON serialization. */
export type DvmErrorProseSources = Partial<Record<DvmErrorProseField, "provider">>;

/** Structured error for DVM operations — carries a machine-readable code and optional user hint. */
export class DvmError extends Error {
  constructor(
    /** Machine-readable error code (e.g. "wallet_missing", "timeout") */
    public code: string,
    message: string,
    /** Actionable guidance for the caller (agent or human) */
    public hint?: string,
    /** Extra structured fields to surface on the error JSON (e.g. fundingOptions) */
    public data?: Record<string, unknown>,
    /** Relay-ready explanation an agent can show its human verbatim. */
    public display?: string,
    /** Provider origin for prose fields; absent fields are CLI-authored. */
    public proseSources?: DvmErrorProseSources
  ) {
    super(message);
    this.name = "DvmError";
  }
}

/** Identify provider-authored prose present on one or more remote error objects. */
export function providerProseSources(
  ...sources: (Partial<Record<DvmErrorProseField, unknown>> | undefined)[]
): DvmErrorProseSources | undefined {
  const provenance: DvmErrorProseSources = {};
  for (const source of sources) {
    if (!source) continue;
    for (const field of ["message", "hint", "display"] as const) {
      if (typeof source[field] === "string") provenance[field] = "provider";
    }
  }
  return Object.keys(provenance).length > 0 ? provenance : undefined;
}

/** Detect fetch AbortError / TimeoutError — the two names browsers and Node use for signal-aborted requests. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Return the first safe Node/undici transport code found on an error or its causes. */
export function transportErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && isErrorLike(current) && !seen.has(current); depth++) {
    seen.add(current);
    const code = current.code;
    if (typeof code === "string" && /^(?:E[A-Z0-9_]{1,63}|UND_ERR_[A-Z0-9_]{1,63})$/.test(code)) {
      return code;
    }
    current = current.cause;
  }
  return undefined;
}

function isErrorLike(value: unknown): value is { code?: unknown; cause?: unknown } {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}
