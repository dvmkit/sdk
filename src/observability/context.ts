import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";

import type { TraceContext } from "./types";
import { extendDiagnosticIdentityAuthority } from "./projection";

const storage = new AsyncLocalStorage<TraceContext>();

let defaultService = "unknown";

export function setDefaultService(service: string): void {
  defaultService = service;
}

/** Generate a W3C-compliant trace ID (32 hex chars / 16 bytes, UUIDv7 time-ordered). */
export function randomTraceId(): string {
  const buf = randomBytes(16);
  const now = Date.now();
  // Bytes 0–5: 48-bit Unix timestamp in milliseconds
  buf.writeUInt16BE(Math.floor(now / 0x100000000), 0);
  buf.writeUInt32BE(now % 0x100000000, 2);
  // Byte 6 high nibble: version 7
  buf[6] = (buf[6] & 0x0f) | 0x70;
  // Byte 8 high 2 bits: variant 10
  buf[8] = (buf[8] & 0x3f) | 0x80;
  return buf.toString("hex");
}

/** Generate a W3C-compliant span ID (16 hex chars / 8 bytes). */
export function randomSpanId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 16);
}

export function withTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Return the current trace context, or synthesize a root context with a
 * fresh traceId when called outside any scope (cron tick, top-level script).
 */
export function currentContext(service?: string): TraceContext {
  const ctx = storage.getStore();
  if (ctx) return ctx;
  return {
    traceId: randomTraceId(),
    spanId: null,
    dimensions: {},
    service: service ?? defaultService,
  };
}

/**
 * Pin a dimension key/value in the current ALS scope. Every subsequent span
 * emitted within this scope inherits the pinned dimension.
 */
export function pinDimension(key: string, value: unknown): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx.dimensions = { ...ctx.dimensions, [key]: value };
    ctx.diagnosticIdentityAuthority = extendDiagnosticIdentityAuthority(
      ctx.diagnosticIdentityAuthority,
      key,
      value,
    );
  }
}

/** Set an ordinary logger dimension without granting diagnostic identity authority. */
export function setDimension(key: string, value: unknown): void {
  const ctx = storage.getStore();
  if (ctx) {
    ctx.dimensions = { ...ctx.dimensions, [key]: value };
  }
}

/**
 * Return the raw ALS store (or undefined). Used by withSpan to check
 * whether a context is active without synthesizing one.
 */
export function rawContext(): TraceContext | undefined {
  return storage.getStore();
}
