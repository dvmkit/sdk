import { projectSpanRow } from "./projection";
import type { SpanRow } from "./types";

const isTTY = typeof process.stdout.isTTY === "boolean" && process.stdout.isTTY;
const RED = isTTY ? "\x1b[31m" : "";
const YELLOW = isTTY ? "\x1b[33m" : "";
const RESET = isTTY ? "\x1b[0m" : "";

/** Format a span as a single human-readable line after catalogue projection. */
export function formatSpanLine(span: SpanRow): string {
  const result = projectSpanRow(span);
  if (!result.ok) return "";
  const safeSpan = result.row;
  const ts = new Date(safeSpan.started_at_ms).toISOString();
  const levelStr = colorLevel(safeSpan.level);
  const parts: string[] = [`[${ts}]`, safeSpan.dataset, `${levelStr}:`, safeSpan.name];

  if (safeSpan.trace_id) {
    parts.push(`trace=${safeSpan.trace_id}`);
  }

  for (const [k, v] of Object.entries(safeSpan.dimensions)) {
    parts.push(formatKV(k, v));
  }
  for (const [k, v] of Object.entries(safeSpan.attributes)) {
    parts.push(formatKV(k, v));
  }

  const durationMs = safeSpan.ended_at_ms - safeSpan.started_at_ms;
  if (durationMs > 0) {
    parts.push(`duration=${durationMs}ms`);
  }
  return parts.join(" ");
}

export function writeSpanLine(span: SpanRow): void {
  const line = formatSpanLine(span);
  if (line) process.stdout.write(line + "\n");
}

function colorLevel(level: string): string {
  if (level === "error") return `${RED}error${RESET}`;
  if (level === "warn") return `${YELLOW}warn${RESET}`;
  return level;
}

function formatKV(key: string, value: unknown): string {
  return `${key}=${truncate(stringify(value), 80)}`;
}

/**
 * Convert any attribute value to a string for stdout formatting. `JSON.stringify`
 * returns `undefined` for `undefined`, functions, and symbols — coerce all those
 * to stable strings so `truncate` never sees a non-string.
 */
function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "function") return "[function]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "bigint") return value.toString();
  return JSON.stringify(value);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}
