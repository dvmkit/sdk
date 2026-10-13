import type { DatasetName } from "./datasets";
import type {
  DiagnosticCapabilityAuthority,
  DiagnosticIdentityAuthority,
} from "./projection";

/** Severity level for a span (log lines use the same enum). */
export type SpanLevel = "info" | "warn" | "error";

export type SpanStatus = "ok" | "error";

export interface SpanRow {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  dataset: DatasetName;
  name: string;
  level: SpanLevel;
  status: SpanStatus;
  started_at_ms: number;
  ended_at_ms: number;
  service: string;
  service_version: string;
  host: string | null;
  pid: number | null;
  dimensions: Record<string, unknown>;
  attributes: Record<string, unknown>;
  error_message: string | null;
  error_stack: string | null;
  sample_rate: number;
}

/** Request-scoped trace context carried via AsyncLocalStorage. */
export interface TraceContext {
  traceId: string;
  /** Current span ID — used as parent_span_id for child spans. Null at request entry. */
  spanId: string | null;
  /** Pinned dimensions inherited by all spans in this scope. */
  dimensions: Record<string, unknown>;
  /** Service identifier: "router", "platform-api", or `isolate-${slug}`. */
  service: string;
  /** Process-local authority for this app's configured capability names. */
  diagnosticCapabilityAuthority?: DiagnosticCapabilityAuthority;
  /** Process-local authority for configured or authenticated diagnostic identity. */
  diagnosticIdentityAuthority?: DiagnosticIdentityAuthority;
  /** W3C tracestate header value preserved verbatim for outbound propagation. */
  tracestate?: string;
  /**
   * W3C traceparent flags byte. Bit 0 is the `sampled` flag. Preserved from
   * the inbound header (or defaulted to `1` for synthesized root contexts) so
   * the outbound `traceparent` we emit honours the caller's sampling decision
   * required for tail-based sampling.
   */
  flags?: number;
}

export interface SpanTransport {
  send(rows: SpanRow[]): Promise<void>;
}

export interface Logger {
  info(name: string, attrs?: Record<string, unknown>): void;
  warn(name: string, attrs?: Record<string, unknown>): void;
  error(name: string, attrs?: Record<string, unknown> & { err?: Error }): void;
  span<T>(
    name: string,
    attrs: Record<string, unknown>,
    fn: () => Promise<T> | T,
    opts?: { onError?: (err: unknown) => Record<string, unknown> | undefined }
  ): Promise<T>;
  timer(name: string, attrs?: Record<string, unknown>): Disposable;
  set(dims: Record<string, unknown>): void;
  extend(dims: Record<string, unknown>): Logger;
  tracked<T extends (...args: never[]) => unknown>(name: string, fn: T): T;
}
