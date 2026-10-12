import { describe, expect, it } from "vitest";

import {
  bindDiagnosticIdentityAuthority,
  extendDiagnosticIdentityAuthority,
} from "../projection";
import { formatSpanLine } from "../stdout-sink";
import type { SpanRow } from "../types";

function makeSpan(overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    span_id: "1111111111111111",
    trace_id: "22222222222222222222222222222222",
    parent_span_id: null,
    dataset: "platform",
    name: "dvm.request",
    level: "info",
    status: "ok",
    started_at_ms: 1716062100123,
    ended_at_ms: 1716062100123,
    service: "platform-api",
    service_version: "abcdef1",
    host: "localhost",
    pid: 1234,
    dimensions: {},
    attributes: {},
    error_message: null,
    error_stack: null,
    sample_rate: 1.0,
    ...overrides
  };
}

describe("formatSpanLine", () => {
  it("formats a basic span", () => {
    const line = formatSpanLine(makeSpan());
    expect(line).toContain("platform");
    expect(line).toContain("info:");
    expect(line).toContain("dvm.request");
    expect(line).toContain("trace=22222222222222222222222222222222");
  });

  it("includes dimensions and attributes", () => {
    const span = makeSpan({
      dimensions: { dvm_slug: "example-dvm" },
      attributes: { count: 5 }
    });
    const authority = extendDiagnosticIdentityAuthority(
      undefined,
      "dvm_slug",
      "example-dvm"
    );
    bindDiagnosticIdentityAuthority(span, authority);

    const line = formatSpanLine(span);
    expect(line).toContain("dvm_slug=example-dvm");
    expect(line).toContain("count=5");
  });

  it("shows duration for non-zero spans", () => {
    const line = formatSpanLine(
      makeSpan({
        started_at_ms: 1000,
        ended_at_ms: 1042
      })
    );
    expect(line).toContain("duration=42ms");
  });

  it("omits duration for zero-duration spans", () => {
    const line = formatSpanLine(makeSpan());
    expect(line).not.toContain("duration=");
  });

  it("removes error messages", () => {
    const line = formatSpanLine(
      makeSpan({
        error_message: "something broke"
      })
    );
    expect(line).not.toContain("something broke");
  });

  it("truncates long values", () => {
    const longVal = "x".repeat(200);
    const line = formatSpanLine(
      makeSpan({
        attributes: { error: longVal }
      })
    );
    expect(line).not.toContain(longVal);
    expect(line.length).toBeLessThan(500);
  });

  it("handles undefined and null attribute values without throwing", () => {
    // Regression: when a span attr resolves to undefined (e.g. an optional
    // field upstream wasn't set), formatKV used to call JSON.stringify which
    // returns undefined, and truncate() then threw on `.length`.
    const line = formatSpanLine(
      makeSpan({
        dimensions: { dvm_slug: undefined as unknown as string },
        attributes: { count: null, amount: 2 }
      })
    );
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("null");
    expect(line).toContain("amount=2");
  });
});
