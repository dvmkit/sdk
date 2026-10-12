import { describe, expect, it } from "vitest";

import { buildTraceparent, parseTraceparent } from "../../lib/traceparent";

describe("parseTraceparent", () => {
  it("parses a valid traceparent header", () => {
    const result = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
    expect(result).toEqual({
      traceId: "0af7651916cd43dd8448eb211c80319c",
      parentSpanId: "b7ad6b7169203331",
      flags: 1,
    });
  });

  it("parses unsampled flags", () => {
    const result = parseTraceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00");
    expect(result).not.toBeNull();
    expect(result?.flags).toBe(0);
  });

  it("trims whitespace", () => {
    const result = parseTraceparent("  00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01  ");
    expect(result).not.toBeNull();
  });

  it("rejects absent, malformed, unsupported, and zero-identity traceparents", () => {
    for (const [reason, header] of [
      ["absent", undefined],
      ["empty", ""],
      ["zero trace ID", "00-00000000000000000000000000000000-b7ad6b7169203331-01"],
      ["zero span ID", "00-0af7651916cd43dd8448eb211c80319c-0000000000000000-01"],
      ["unsupported version", "01-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"],
      ["short trace ID", "00-0af7651916cd43dd-b7ad6b7169203331-01"],
      ["long trace ID", "00-0af7651916cd43dd8448eb211c80319c00-b7ad6b7169203331-01"],
      ["short span ID", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b71-01"],
      ["long span ID", "00-0af7651916cd43dd8448eb211c80319c-b7ad6b716920333100-01"],
      ["missing fields", "00-0af7651916cd43dd8448eb211c80319c"],
      ["uppercase hex", "00-0AF7651916CD43DD8448EB211C80319C-B7AD6B7169203331-01"],
      ["garbage", "not-a-traceparent"],
    ] as const) {
      expect(parseTraceparent(header), reason).toBeNull();
    }
  });

  });

describe("buildTraceparent", () => {
  it("builds a valid traceparent with the sampled flag by default", () => {
    expect(buildTraceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331")).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
    );
  });

  it("formats the flags byte as 2-hex", () => {
    expect(buildTraceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", 0)).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00"
    );
    expect(buildTraceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331", 0xff)).toBe(
      "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-ff"
    );
  });
});

describe("round-trip", () => {
  it("preserves sampled and unsampled flags through build and parse", () => {
    const traceId = "0af7651916cd43dd8448eb211c80319c";
    const spanId = "b7ad6b7169203331";
    for (const flags of [1, 0]) {
      expect(parseTraceparent(buildTraceparent(traceId, spanId, flags))).toEqual({ traceId, parentSpanId: spanId, flags });
    }
  });

  });
