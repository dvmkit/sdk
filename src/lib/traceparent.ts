export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  flags: number;
}

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ALL_ZERO_TRACE = "00000000000000000000000000000000";
const ALL_ZERO_SPAN = "0000000000000000";

/**
 * Parse a W3C `traceparent` header into its component fields.
 *
 * Returns null on any validation failure — never throws. Rejects all-zero
 * traceId or parentSpanId per the W3C Trace Context spec.
 *
 * The returned `traceId` is the full 32-char hex from the header. Callers
 * that use a shorter internal format (e.g. 16-char) should truncate.
 */
export function parseTraceparent(header: string | undefined): ParsedTraceparent | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;

  const [, traceId, parentSpanId, flagsHex] = match;
  if (traceId === ALL_ZERO_TRACE || parentSpanId === ALL_ZERO_SPAN) return null;

  return { traceId, parentSpanId, flags: parseInt(flagsHex, 16) };
}

/**
 * Build a W3C `traceparent` header value from trace + span IDs.
 *
 * `flags` defaults to `1` (sampled) for callers that don't track sampling
 * state. Pass the inbound flags through verbatim to honour upstream sampling
 * decisions, including tail-sampling decisions made upstream.
 */
export function buildTraceparent(traceId: string, spanId: string, flags = 1): string {
  const flagsHex = (flags & 0xff).toString(16).padStart(2, "0");
  return `00-${traceId}-${spanId}-${flagsHex}`;
}
