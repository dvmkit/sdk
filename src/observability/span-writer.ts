import type { Pool } from "pg";

import { diagnosticConsole } from "./diagnostic-console";
import { projectSpanRow } from "./projection";
import type { SpanRow, SpanTransport } from "./types";

// eslint-disable-next-line @typescript-eslint/no-empty-function -- fire-and-forget catch handler
const noop = () => {};

/** Postgres NOTIFY channel fired after each successful span batch INSERT. */
export const SPANS_INSERTED_CHANNEL = "spans_inserted";

/** Hard cap on buffered spans — protects memory if the DB is unavailable. */
const MAX_BUFFERED_SPANS = 10_000;

/** Per-row JSONB payload size limit (bytes). */
const MAX_ROW_JSONB_BYTES = 64 * 1024;

/** Per-string-value cap within attributes (bytes). */
const MAX_STRING_VALUE_BYTES = 4 * 1024;

/** Flush when the buffer reaches this many rows. */
const FLUSH_THRESHOLD = 1_000;

/** Maximum consecutive failures before backoff caps. */
const MAX_BACKOFF_EXPONENT = 6; // 2^6 * base = 64× base interval

/**
 * Buffered span writer. Collects SpanRow objects in memory and flushes them
 * to a transport (direct DB or HTTP POST) on a timer or threshold.
 */
export class SpanWriter {
  private buffer: SpanRow[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private dropCount = 0;
  private truncatedSpanCount = 0;
  private consecutiveFailures = 0;
  private backoffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private transport: SpanTransport,
    private flushIntervalMs = 10_000
  ) {}

  /** Enqueue a span row. Non-blocking — truncates oversize JSONB and appends to buffer. */
  enqueue(row: SpanRow): void {
    const projected = projectSpanRow(row);
    if (!projected.ok) return;
    row = projected.row;
    const originalBytes = JSON.stringify({
      attributes: row.attributes,
      dimensions: row.dimensions
    }).length;
    if (originalBytes > MAX_ROW_JSONB_BYTES) {
      row = this.truncateForSize(row, originalBytes);
    }

    if (this.buffer.length >= MAX_BUFFERED_SPANS) {
      this.dropCount++;
      if (this.dropCount === 1 || this.dropCount % 1000 === 0) {
        diagnosticConsole.error({
          event: "span_buffer_drop",
          reason: "buffer_full",
          total_dropped: this.dropCount,
          buffer_size: this.buffer.length
        });
      }
      return;
    }

    this.buffer.push(row);

    if (this.buffer.length >= FLUSH_THRESHOLD && !this.flushing) {
      void this.flush().catch(noop);
    }
  }

  startFlush(): void {
    this.flushTimer = setInterval(() => {
      void this.flush().catch(noop);
    }, this.flushIntervalMs);
  }

  stopFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
  }

  /** Flush buffered spans. Single-flight: concurrent calls exit early. */
  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;

    const queuedBatch = this.buffer;
    this.buffer = [];

    try {
      const batch = queuedBatch.flatMap((row) => {
        const projected = projectSpanRow(row);
        return projected.ok ? [projected.row] : [];
      });
      await this.transport.send(batch);
      this.consecutiveFailures = 0;
    } catch (_err) {
      this.consecutiveFailures++;
      diagnosticConsole.error({
        event: "span_flush_failed",
        error: undefined,
        batch_size: queuedBatch.length,
        consecutive_failures: this.consecutiveFailures
      });

      const room = MAX_BUFFERED_SPANS - this.buffer.length;
      if (room > 0) {
        this.buffer.unshift(...queuedBatch.slice(0, room));
      }

      // Exponential backoff: skip next N flush intervals
      if (this.consecutiveFailures > 1) {
        const exponent = Math.min(this.consecutiveFailures - 1, MAX_BACKOFF_EXPONENT);
        const backoffMs = this.flushIntervalMs * Math.pow(2, exponent);
        this.stopFlush();
        this.backoffTimer = setTimeout(() => {
          this.backoffTimer = null;
          this.startFlush();
        }, backoffMs);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopFlush();
    await this.flush();
  }

  getDropCount(): number {
    return this.dropCount;
  }

  /** Number of spans truncated due to oversized JSONB payload. */
  getTruncatedSpanCount(): number {
    return this.truncatedSpanCount;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  /** Consecutive flush failures; resets to 0 on the next successful flush. */
  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  /**
   * Two-pass truncation: cap individual string values, then fall back to
   * wholesale attribute replacement if the blob is still over the limit.
   */
  private truncateForSize(row: SpanRow, originalBytes: number): SpanRow {
    // Pass 1 — per-string-value cap on attributes (one level deep)
    const truncatedAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row.attributes)) {
      if (typeof value === "string" && value.length > MAX_STRING_VALUE_BYTES) {
        const omitted = value.length - MAX_STRING_VALUE_BYTES;
        truncatedAttrs[key] = `${value.slice(0, MAX_STRING_VALUE_BYTES)}… [truncated, ${omitted} chars omitted]`;
      } else {
        truncatedAttrs[key] = value;
      }
    }

    const afterStringPass = JSON.stringify({
      attributes: truncatedAttrs,
      dimensions: row.dimensions
    }).length;

    let mode: "string_pass" | "wholesale_fallback";

    if (afterStringPass <= MAX_ROW_JSONB_BYTES) {
      row.attributes = truncatedAttrs;
      mode = "string_pass";
    } else {
      // Check if dimensions alone are oversized (shouldn't happen)
      const dimSize = JSON.stringify(row.dimensions).length;
      if (dimSize > MAX_ROW_JSONB_BYTES) {
        diagnosticConsole.error({
          event: "span_dimension_oversized",
          name: row.name,
          dataset: row.dataset,
          dimension_bytes: dimSize
        });
      }

      // Pass 2 — wholesale attribute replacement
      row.attributes = {
        _truncated: true,
        original_bytes: originalBytes,
        original_keys: Object.keys(row.attributes).sort()
      };
      mode = "wholesale_fallback";
    }

    this.truncatedSpanCount++;
    if (this.truncatedSpanCount === 1 || this.truncatedSpanCount % 100 === 0) {
      diagnosticConsole.error({
        event: "span_truncated",
        name: row.name,
        dataset: row.dataset,
        original_bytes: originalBytes,
        after_string_pass_bytes: afterStringPass,
        mode,
        total_truncated: this.truncatedSpanCount
      });
    }

    return row;
  }
}

export const SPAN_COLUMNS = [
  "span_id",
  "trace_id",
  "parent_span_id",
  "dataset",
  "name",
  "level",
  "status",
  "started_at_ms",
  "ended_at_ms",
  "service",
  "service_version",
  "host",
  "pid",
  "dimensions",
  "attributes",
  "error_message",
  "error_stack",
  "sample_rate"
] as const;

/**
 * Build and execute a multi-row INSERT into observability.spans.
 * Accepts either typed SpanRow[] or loosely-typed Record<string, unknown>[]
 * (the HTTP ingestion endpoint validates fields before calling this).
 */
export async function insertSpanBatch(
  pool: Pool,
  rows: readonly Record<string, unknown>[] | readonly SpanRow[]
): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders: string[] = [];
  let idx = 1;

  for (const candidate of rows) {
    const projected = projectSpanRow(candidate);
    if (!projected.ok) continue;
    const row = projected.row;
    const rowPlaceholders: string[] = [];
    for (const col of SPAN_COLUMNS) {
      let val = row[col] ?? null;
      // sample_rate is NOT NULL DEFAULT 1.0; an explicit column list defeats the
      // DB default, so an unset value must bind 1.0 (fully sampled) rather than NULL.
      if (col === "sample_rate" && val == null) {
        val = 1.0;
      }
      if (col === "dimensions" || col === "attributes") {
        rowPlaceholders.push(`$${idx}::jsonb`);
        values.push(typeof val === "string" ? val : JSON.stringify(val ?? {}));
      } else {
        rowPlaceholders.push(`$${idx}`);
        values.push(val);
      }
      idx++;
    }
    placeholders.push(`(${rowPlaceholders.join(", ")})`);
  }

  if (placeholders.length === 0) return;

  await pool.query(
    `INSERT INTO observability.spans (${SPAN_COLUMNS.join(", ")})
     VALUES ${placeholders.join(",\n")}
     ON CONFLICT (dataset, span_id) DO NOTHING`,
    values
  );

  // Wake up live span-stream listeners. Best-effort — a
  // missed notification just means the tail client waits for the next one.
  try {
    await pool.query(`SELECT pg_notify('${SPANS_INSERTED_CHANNEL}', '')`);
  } catch {
    // swallow — the INSERT succeeded, notification is optional
  }
}

/** Direct Postgres INSERT transport for platform-api and router. */
export class DbTransport implements SpanTransport {
  constructor(private pool: Pool) {}

  async send(rows: SpanRow[]): Promise<void> {
    await insertSpanBatch(this.pool, rows);
  }
}

/** HTTP POST transport for DVM isolates sending spans to platform-api. */
export class HttpTransport implements SpanTransport {
  constructor(
    private platformUrl: string,
    private serviceToken: string
  ) {}

  async send(rows: SpanRow[]): Promise<void> {
    const safeRows = rows.flatMap((row) => {
      const projected = projectSpanRow(row);
      return projected.ok ? [projected.row] : [];
    });
    if (safeRows.length === 0) return;

    const resp = await fetch(`${this.platformUrl.replace(/\/$/, "")}/_internal/spans`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.serviceToken}`
      },
      body: JSON.stringify({ spans: safeRows })
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Span ingestion failed: ${resp.status} ${text}`);
    }
  }
}
