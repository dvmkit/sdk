import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  bindDiagnosticCapabilityAuthority,
  bindDiagnosticIdentityAuthority,
  createDiagnosticCapabilityAuthority,
  extendDiagnosticIdentityAuthority,
  projectSpanRow,
} from "../projection";
import { HttpTransport, SpanWriter } from "../span-writer";
import type { SpanRow, SpanTransport } from "../types";

function makeSpan(overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    span_id: Math.random().toString(16).slice(2).padEnd(16, "1").slice(0, 16),
    trace_id: "22222222222222222222222222222222",
    parent_span_id: null,
    dataset: "platform",
    name: "dvm.request",
    level: "info",
    status: "ok",
    started_at_ms: Date.now(),
    ended_at_ms: Date.now(),
    service: "platform-api",
    service_version: "v1.0.0",
    host: "localhost",
    pid: 1,
    dimensions: {},
    attributes: {},
    error_message: null,
    error_stack: null,
    sample_rate: 1.0,
    ...overrides,
  };
}

function createMockTransport(): SpanTransport & {
  sent: SpanRow[][];
  fail: boolean;
} {
  const transport = {
    sent: [] as SpanRow[][],
    fail: false,
    async send(rows: SpanRow[]) {
      if (transport.fail) throw new Error("transport error");
      transport.sent.push([...rows]);
    },
  };
  return transport;
}

describe("SpanWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("enqueues and flushes spans", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 10_000);

    writer.enqueue(makeSpan());
    writer.enqueue(makeSpan());
    expect(writer.getBufferSize()).toBe(2);

    await writer.flush();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toHaveLength(2);
    expect(writer.getBufferSize()).toBe(0);
  });

  it("drops spans when buffer is full (10k cap)", () => {
    // Use a transport whose flush never resolves, keeping the single-flight
    // guard locked. This prevents the eager-flush at 1000 rows from actually
    // draining the buffer, so we can hit the 10k cap.
    const transport = createMockTransport();
    transport.send = () =>
      new Promise<void>(() => {
        /* never resolves */
      });
    const writer = new SpanWriter(transport, 60_000);

    // The eager flush at 1000 rows synchronously swaps the buffer (moving
    // 1000 to the in-flight batch), then awaits the never-resolving send.
    // The single-flight guard stays locked, so subsequent eager flushes
    // are no-ops. We need 1000 (flushed) + 10000 (fills buffer) + 1 (dropped).
    for (let i = 0; i < 11_001; i++) {
      writer.enqueue(makeSpan());
    }

    expect(writer.getDropCount()).toBeGreaterThanOrEqual(1);
  });

  it("projects cyclic and oversized unapproved values before size measurement", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 10_000);
    const cyclic: Record<string, unknown> = {
      secret: "SENTINEL".repeat(10_000),
    };
    cyclic.self = cyclic;

    expect(() =>
      writer.enqueue(
        makeSpan({
          attributes: { count: 2, nested: cyclic },
          dimensions: { authorization: "SENTINEL_CREDENTIAL" },
        }),
      ),
    ).not.toThrow();
    expect(writer.getTruncatedSpanCount()).toBe(0);

    await writer.flush();
    expect(transport.sent[0][0].attributes).toEqual({ count: 2 });
    expect(transport.sent[0][0].dimensions).toEqual({});
  });

  it("keeps bound membership through detached buffering and transport re-projection", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 10_000);
    const authority = createDiagnosticCapabilityAuthority(["transcribe"]);
    let identityAuthority = extendDiagnosticIdentityAuthority(
      undefined,
      "dvm_slug",
      "configured-app",
    );
    identityAuthority = extendDiagnosticIdentityAuthority(
      identityAuthority,
      "dvm_id",
      "123e4567-e89b-12d3-a456-426614174000",
    );
    const candidate = makeSpan({
      dimensions: {
        capability: "transcribe",
        dvm_slug: "configured-app",
        dvm_id: "123e4567-e89b-12d3-a456-426614174000",
      },
    });
    bindDiagnosticCapabilityAuthority(candidate, authority);
    bindDiagnosticIdentityAuthority(candidate, identityAuthority);

    writer.enqueue(candidate);
    candidate.dimensions.capability = "private_report";
    await writer.flush();

    expect(transport.sent[0][0].dimensions).toEqual({
      capability: "transcribe",
      dvm_slug: "configured-app",
      dvm_id: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(projectSpanRow(transport.sent[0][0])).toEqual({
      ok: true,
      row: expect.objectContaining({
        dimensions: {
          capability: "transcribe",
          dvm_slug: "configured-app",
          dvm_id: "123e4567-e89b-12d3-a456-426614174000",
        },
      }),
    });
  });

  it("projects rows again before HTTP transport serialization", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const transport = new HttpTransport(
      "https://platform.example.com",
      "service-token",
    );

    await transport.send([
      makeSpan({
        attributes: {
          count: 2,
          capability: "private_report",
          dvm_id: "123e4567-e89b-12d3-a456-426614174000",
          authorization: "SENTINEL_CREDENTIAL",
          customer: "SENTINEL_CUSTOMER",
        },
        dimensions: { dvm_slug: "customer-app" },
        error_message: "SENTINEL_ERROR",
      }),
    ]);

    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.spans[0].attributes).toEqual({ count: 2 });
    expect(body.spans[0].error_message).toBeNull();
    expect(JSON.stringify(body)).not.toContain("SENTINEL");

    const authority = createDiagnosticCapabilityAuthority(["transcribe"]);
    const trusted = makeSpan({
      attributes: { capability: "transcribe" },
    });
    bindDiagnosticCapabilityAuthority(trusted, authority);
    await transport.send([trusted]);

    const trustedBody = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(trustedBody.spans[0].attributes).toEqual({
      capability: "transcribe",
    });
  });

  it("leaves normal-sized spans unchanged", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 10_000);

    const attrs = {
      method: "GET",
      "http.status_code": 200,
      resource_path: "/v1/job",
    };
    const dims = { stage: "input", verified: true };
    writer.enqueue(makeSpan({ attributes: attrs, dimensions: dims }));

    expect(writer.getBufferSize()).toBe(1);
    expect(writer.getTruncatedSpanCount()).toBe(0);

    await writer.flush();
    const flushed = transport.sent[0][0];
    expect(flushed.attributes).toEqual(attrs);
    expect(flushed.dimensions).toEqual(dims);
  });

  it("flushes on the timer interval", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 100);
    writer.startFlush();

    writer.enqueue(makeSpan());
    expect(transport.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(150);
    expect(transport.sent).toHaveLength(1);

    writer.stopFlush();
  });

  it("flushes eagerly at 1000-row threshold", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 60_000);

    for (let i = 0; i < 1000; i++) {
      writer.enqueue(makeSpan());
    }

    // The eager flush is async — need to let it complete
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.sent.length).toBeGreaterThanOrEqual(1);
  });

  it("re-queues on flush failure", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 10_000);

    writer.enqueue(makeSpan());
    writer.enqueue(makeSpan());

    transport.fail = true;
    await writer.flush().catch(() => undefined);

    expect(writer.getBufferSize()).toBe(2);

    transport.fail = false;
    await writer.flush();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toHaveLength(2);
  });

  it("retries from an unexposed projected snapshot after transport mutation", async () => {
    const attempts: SpanRow[][] = [];
    const transport: SpanTransport = {
      async send(rows) {
        attempts.push(rows);
        if (attempts.length === 1) {
          rows[0].attributes = { customer: "SENTINEL_RETRY_LEAK" };
          rows[0].dimensions = { dvm_slug: "customer-private" };
          throw new Error("transport unavailable");
        }
      },
    };
    const writer = new SpanWriter(transport, 10_000);
    writer.enqueue(makeSpan({ attributes: { count: 1 } }));

    await writer.flush();
    await writer.flush();

    expect(attempts).toHaveLength(2);
    expect(attempts[1][0].attributes).toEqual({ count: 1 });
    expect(attempts[1][0].dimensions).toEqual({});
    expect(JSON.stringify(attempts[1])).not.toContain("SENTINEL");
  });

  it("single-flight guard prevents concurrent flushes", async () => {
    const transport = createMockTransport();
    let resolveFlush: (() => void) | null = null;
    transport.send = (rows) => {
      transport.sent.push([...rows]);
      return new Promise<void>((resolve) => {
        resolveFlush = resolve;
      });
    };

    const writer = new SpanWriter(transport, 10_000);
    writer.enqueue(makeSpan());

    const first = writer.flush();
    writer.enqueue(makeSpan());
    const second = writer.flush(); // should exit early due to guard

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- assigned inside Promise callback
    resolveFlush!();
    await first;
    await second;

    expect(transport.sent).toHaveLength(1);
    expect(writer.getBufferSize()).toBe(1);
  });

  it("shutdown flushes remaining spans", async () => {
    const transport = createMockTransport();
    const writer = new SpanWriter(transport, 60_000);
    writer.startFlush();

    writer.enqueue(makeSpan());
    await writer.shutdown();

    expect(transport.sent).toHaveLength(1);
  });
});
