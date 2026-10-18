import { hostname } from "node:os";

import {
  currentContext,
  randomSpanId,
  rawContext,
  withTraceContext,
} from "./context";
import type { DatasetName } from "./datasets";
import {
  bindDiagnosticCapabilityAuthority,
  bindDiagnosticIdentityAuthority,
  projectDiagnosticFields,
  projectSpanRow,
} from "./projection";
import { writeSpanLine } from "./stdout-sink";
import type { SpanLevel, SpanRow, SpanStatus } from "./types";

let emitter: ((row: SpanRow) => void) | null = null;

/** Wire the span writer. Pass `null` to detach (used by tests during teardown). */
export function setEmitter(fn: ((row: SpanRow) => void) | null): void {
  emitter = fn;
}

const cachedHost = hostname();
const serviceVersion =
  process.env.GIT_SHA ?? process.env.FLY_IMAGE_REF ?? "dev";

/** Result of an `inspect` callback — override span fields based on the return value. */
export interface InspectResult {
  status?: SpanStatus;
  errorMessage?: string;
  attrs?: Record<string, unknown>;
  /**
   * Override the emitted severity independently of `status`. Lets a span mark
   * itself `status: "error"` (so it stays countable / non-2xx) while logging at
   * `warn` — e.g. scanner-probe 404s that shouldn't outrank real failures in a
   * `--level error` sweep. When omitted, level derives from `status`.
   */
  level?: SpanLevel;
}

export interface WithSpanOpts {
  dataset: DatasetName;
  name: string;
  level?: SpanLevel;
  attrs?: Record<string, unknown>;
  dims?: Record<string, unknown>;
  /** Pre-extracted error fields (used by logger.error). */
  err?: Error;
  /** Override the span start timestamp (epoch ms). Used by timer() to propagate real wall-clock start. */
  startMs?: number;
  /** Override the span end timestamp (epoch ms). Used by timer() to propagate real wall-clock end. */
  endMs?: number;
  /**
   * Post-completion inspector: override span status/error based on the return value.
   * Called after `fn()` succeeds but before the span row is emitted.
   * Not called when `fn()` throws (the catch path handles that).
   */
  inspect?: (result: unknown) => InspectResult | undefined;
  /**
   * Error-path twin of `inspect`: maps the thrown error to extra span
   * attributes (e.g. a structured `error.code`). Called in the catch path
   * before the error row is emitted; the returned attrs are merged into the
   * span. Return `undefined` to attach nothing.
   */
  onError?: (err: unknown) => Record<string, unknown> | undefined;
}

function ownDataValue(input: unknown, key: string): unknown {
  if ((typeof input !== "object" || input === null) && typeof input !== "function") {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new TypeError("accessor override");
  return descriptor.value;
}

function ownIdentityKeys(input: unknown): string[] {
  try {
    return ["dvm_id", "dvm_slug", "builder_id"].filter((key) => {
      const descriptor =
        ((typeof input === "object" && input !== null) ||
          typeof input === "function") &&
        Object.getOwnPropertyDescriptor(input, key);
      return descriptor && "value" in descriptor;
    });
  } catch {
    return [];
  }
}

/**
 * Core span function — every logger form funnels here.
 *
 * Runs `fn` inside a nested ALS context where this span's ID is the parent.
 * On completion (success or error), emits a SpanRow to the writer + stdout.
 */
export async function withSpan<T>(
  opts: WithSpanOpts,
  fn: () => Promise<T> | T,
): Promise<T> {
  const spanId = randomSpanId();
  const existingCtx = rawContext();
  const ctx = existingCtx ?? currentContext();
  const authority = ctx.diagnosticCapabilityAuthority;
  const identityAuthority = ctx.diagnosticIdentityAuthority;
  const startMs = opts.startMs ?? Date.now();
  const attributeInput = opts.attrs;
  const attributeIdentityKeys = ownIdentityKeys(attributeInput);

  let status: SpanStatus = "ok";
  let level = opts.level;
  if (opts.err) {
    status = "error";
  }

  let attributes = projectDiagnosticFields(
    attributeInput,
    opts.dataset,
    authority,
    identityAuthority,
    opts.name,
  );

  const childDimensions = bindDiagnosticIdentityAuthority(
    bindDiagnosticCapabilityAuthority(
      {
        ...projectDiagnosticFields(
          ctx.dimensions,
          opts.dataset,
          authority,
          identityAuthority,
          opts.name,
        ),
        ...projectDiagnosticFields(
          opts.dims,
          opts.dataset,
          authority,
          identityAuthority,
          opts.name,
        ),
      },
      authority,
    ),
    identityAuthority,
  );
  const childCtx = {
    traceId: ctx.traceId,
    spanId,
    dimensions: childDimensions,
    service: ctx.service,
    tracestate: ctx.tracestate,
    diagnosticCapabilityAuthority: authority,
    diagnosticIdentityAuthority: identityAuthority,
  };

  const latestIdentityAuthority = () =>
    childCtx.diagnosticIdentityAuthority;

  const refreshAttributes = () => {
    const identityCandidates = Object.fromEntries(
      attributeIdentityKeys.map((key) => [key, null]),
    );
    attributes = projectDiagnosticFields(
      { ...attributes, ...identityCandidates },
      opts.dataset,
      authority,
      latestIdentityAuthority(),
      opts.name,
    );
  };

  const emitRow = () => {
    const activeIdentityAuthority = latestIdentityAuthority();
    const endMs = opts.endMs ?? Date.now();
    const row: SpanRow = {
      span_id: spanId,
      trace_id: ctx.traceId,
      parent_span_id: ctx.spanId,
      dataset: opts.dataset,
      name: opts.name,
      level: level ?? (status === "error" ? "error" : "info"),
      status,
      started_at_ms: startMs,
      ended_at_ms: endMs,
      service: ctx.service,
      service_version: serviceVersion,
      host: cachedHost,
      pid: process.pid,
      dimensions: projectDiagnosticFields(
        childCtx.dimensions,
        opts.dataset,
        authority,
        activeIdentityAuthority,
        opts.name,
      ),
      attributes,
      error_message: null,
      error_stack: null,
      sample_rate: 1.0,
    };
    bindDiagnosticCapabilityAuthority(row, authority);
    bindDiagnosticIdentityAuthority(row, activeIdentityAuthority);
    const projected = projectSpanRow(row);
    if (!projected.ok) return;
    try {
      writeSpanLine(projected.row);
    } catch {
      // Diagnostics must not alter application control flow.
    }
    try {
      if (emitter) emitter(projected.row);
    } catch {
      // Diagnostics must not alter application control flow.
    }
  };

  let result: T;
  try {
    result = await withTraceContext(childCtx, () => fn());
  } catch (err) {
    status = "error";
    refreshAttributes();
    try {
      const onError = opts.onError;
      if (onError) {
        const overrides = onError(err);
        attributes = {
          ...attributes,
          ...projectDiagnosticFields(
            overrides,
            opts.dataset,
            authority,
            latestIdentityAuthority(),
            opts.name,
          ),
        };
      }
    } catch {
      // Diagnostic enrichment must not replace the application error.
    }
    emitRow();
    throw err;
  }

  refreshAttributes();
  try {
    const inspect = opts.inspect;
    if (inspect) {
      const overrides = inspect(result);
      const nextStatus = ownDataValue(overrides, "status");
      const nextLevel = ownDataValue(overrides, "level");
      const nextAttributes = ownDataValue(overrides, "attrs");
      const projectedAttributes =
        nextAttributes === undefined
          ? undefined
          : projectDiagnosticFields(
              nextAttributes,
              opts.dataset,
              authority,
              latestIdentityAuthority(),
              opts.name,
            );

      if (nextStatus === "ok" || nextStatus === "error") status = nextStatus;
      if (nextLevel === "info" || nextLevel === "warn" || nextLevel === "error") {
        level = nextLevel;
      }
      if (projectedAttributes) {
        attributes = { ...attributes, ...projectedAttributes };
      }
    }
  } catch {
    // Diagnostic enrichment must not replace the application result.
  }
  emitRow();
  return result;
}
