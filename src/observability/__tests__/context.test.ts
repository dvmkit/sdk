import { describe, expect, it } from "vitest";

import {
  currentContext,
  pinDimension,
  rawContext,
  setDefaultService,
  withTraceContext,
} from "../context";

describe("context", () => {
  it("currentContext returns a synthesized context outside any scope", () => {
    const ctx = currentContext();
    expect(ctx.traceId).toHaveLength(32);
    expect(ctx.spanId).toBeNull();
    expect(ctx.dimensions).toEqual({});
  });

  it("uses the default service name for synthesized contexts", () => {
    setDefaultService("test-service");
    const ctx = currentContext();
    expect(ctx.service).toBe("test-service");
    setDefaultService("unknown"); // reset
  });

  it("currentContext returns override service when passed", () => {
    const ctx = currentContext("custom");
    expect(ctx.service).toBe("custom");
  });

  it("withTraceContext propagates context to nested calls", () => {
    const outer = {
      traceId: "abc123",
      spanId: "span1",
      dimensions: { builder_id: "b1" },
      service: "router",
    };

    withTraceContext(outer, () => {
      const inner = currentContext();
      expect(inner.traceId).toBe("abc123");
      expect(inner.spanId).toBe("span1");
      expect(inner.dimensions).toEqual({ builder_id: "b1" });
      expect(inner.service).toBe("router");
    });
  });

  it("rawContext returns undefined outside scope", () => {
    expect(rawContext()).toBeUndefined();
  });

  it("rawContext returns the store inside scope", () => {
    const ctx = {
      traceId: "t1",
      spanId: null,
      dimensions: {},
      service: "test",
    };
    withTraceContext(ctx, () => {
      expect(rawContext()).toBe(ctx);
    });
  });

  it("pinDimension adds dimensions inside a scope", () => {
    const ctx = {
      traceId: "t2",
      spanId: null,
      dimensions: {} as Record<string, unknown>,
      service: "test",
    };
    withTraceContext(ctx, () => {
      pinDimension("key1", "val1");
      const current = currentContext();
      expect(current.dimensions).toEqual({ key1: "val1" });
    });
  });

  it("pinDimension is a no-op outside scope", () => {
    pinDimension("x", "y");
  });

  it("parallel async chains do not bleed dimensions", async () => {
    const results: Record<string, unknown>[] = [];

    const chain = (service: string, key: string, value: string) =>
      new Promise<void>((resolve) => {
        const ctx = {
          traceId: `trace-${service}`,
          spanId: null,
          dimensions: {} as Record<string, unknown>,
          service,
        };
        withTraceContext(ctx, () => {
          pinDimension(key, value);
          // Yield to event loop so the other chain can interleave
          setTimeout(() => {
            withTraceContext(currentContext(), () => {
              results.push({ service, dims: { ...currentContext().dimensions } });
              resolve();
            });
          }, 5);
        });
      });

    await Promise.all([chain("svc-a", "a_key", "a_val"), chain("svc-b", "b_key", "b_val")]);

    const svcA = results.find((r) => r.service === "svc-a");
    const svcB = results.find((r) => r.service === "svc-b");

    expect(svcA?.dims).toEqual({ a_key: "a_val" });
    expect(svcB?.dims).toEqual({ b_key: "b_val" });
  });
});
