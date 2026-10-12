import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pinDimension, withTraceContext } from "../context";
import { initLoggers } from "../loggers";
import { SpanWriter } from "../span-writer";
import type { SpanRow, SpanTransport } from "../types";
import { setEmitter } from "../with-span";

describe("loggers", () => {
  let captured: SpanRow[];
  let loggers: ReturnType<typeof initLoggers>;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    captured = [];
    const transport: SpanTransport = { async send() {} };
    const writer = new SpanWriter(transport, 60_000);
    loggers = initLoggers(writer, "platform-api");
    // Intercept at the emitter level so we capture without flushing
    setEmitter((row) => {
      captured.push(row);
      writer.enqueue(row);
    });
  });

  afterEach(() => {
    setEmitter(null);
    vi.restoreAllMocks();
  });

  it("info() emits a zero-duration info span", async () => {
    loggers.platform.info("message", { count: 1 });
    // withSpan is async — give it a tick
    await new Promise((r) => setTimeout(r, 10));

    const span = captured[0];
    expect(span).toBeDefined();
    expect(span.dataset).toBe("platform");
    expect(span.name).toBe("message");
    expect(span.level).toBe("info");
    expect(span.status).toBe("ok");
    expect(span.attributes).toEqual({ count: 1 });
  });

  it("warn() emits a warn-level span", async () => {
    loggers.cashu.warn("warning", { count: 500 });
    await new Promise((r) => setTimeout(r, 10));

    const span = captured[0];
    expect(span.dataset).toBe("cashu");
    expect(span.level).toBe("warn");
  });

  it("error() emits an error span with error fields", async () => {
    const err = new Error("test error");
    loggers.platform.error("error", { err, count: 2 });
    await new Promise((r) => setTimeout(r, 10));

    const span = captured[0];
    expect(span.level).toBe("error");
    expect(span.status).toBe("error");
    expect(span.error_message).toBeNull();
    expect(span.error_stack).toBeNull();
    expect(span.attributes).toEqual({ count: 2 });
  });

  it("span() wraps a function and returns its result", async () => {
    const result = await loggers.platform.span(
      "dvm.handler",
      { handler: "job" },
      () => 42,
    );
    expect(result).toBe(42);

    const span = captured[0];
    expect(span.name).toBe("dvm.handler");
    expect(span.attributes).toEqual({ handler: "job" });
    expect(span.status).toBe("ok");
  });

  it("span() captures errors from the wrapped function", async () => {
    await expect(
      loggers.platform.span("error", {}, () => {
        throw new Error("oops");
      }),
    ).rejects.toThrow("oops");

    const span = captured[0];
    expect(span.status).toBe("error");
    expect(span.error_message).toBeNull();
  });

  it("timer() emits a span with real wall-clock duration", async () => {
    const before = Date.now();
    {
      using _timer = loggers.platform.timer("phase", { count: 3 });
      await new Promise((r) => setTimeout(r, 20));
    }
    // Timer dispose fires withSpan async
    await new Promise((r) => setTimeout(r, 10));

    const span = captured[0];
    expect(span).toBeDefined();
    expect(span.name).toBe("phase");
    expect(span.attributes).toEqual({ count: 3 });
    // started_at_ms should reflect timer creation, not dispose time
    expect(span.started_at_ms).toBeGreaterThanOrEqual(before);
    expect(span.started_at_ms).toBeLessThanOrEqual(before + 5);
    // duration should reflect the actual wall-clock time (~20ms), not ~0
    const duration = span.ended_at_ms - span.started_at_ms;
    expect(duration).toBeGreaterThanOrEqual(15);
  });

  it("plain context and logger dimensions cannot mint diagnostic identity", async () => {
    await withTraceContext(
      {
        traceId: "22222222222222222222222222222222",
        spanId: null,
        dimensions: {
          dvm_id: "123e4567-e89b-12d3-a456-426614174000",
          dvm_slug: "plain-context",
        },
        service: "test",
      },
      async () => {
        loggers.platform.set({
          builder_id: "123e4567-e89b-12d3-a456-426614174001",
        });
        loggers.platform.extend({ dvm_slug: "baked-spoof" }).info("after.set", {
          dvm_id: "123e4567-e89b-12d3-a456-426614174002",
        });
        await new Promise((r) => setTimeout(r, 10));
      },
    );

    const span = captured[0];
    expect(span.dimensions).toEqual({});
    expect(span.attributes).toEqual({});
  });

  it("trusted pins override logger attrs, set dimensions, and baked dimensions", async () => {
    await withTraceContext(
      {
        traceId: "22222222222222222222222222222222",
        spanId: null,
        dimensions: {},
        service: "test",
      },
      async () => {
        pinDimension("dvm_id", "123e4567-e89b-12d3-a456-426614174010");
        pinDimension("dvm_slug", "configured-app");
        loggers.platform.set({
          dvm_id: "123e4567-e89b-12d3-a456-426614174011",
          dvm_slug: "set-spoof",
          builder_id: "123e4567-e89b-12d3-a456-426614174012",
        });
        loggers.platform
          .extend({ dvm_slug: "baked-spoof" })
          .info("trusted.log", {
            dvm_id: "123e4567-e89b-12d3-a456-426614174013",
            dvm_slug: "attribute-spoof",
          });
        await new Promise((r) => setTimeout(r, 10));
      },
    );

    const span = captured[0];
    expect(span.dimensions).toEqual({
      dvm_id: "123e4567-e89b-12d3-a456-426614174010",
      dvm_slug: "configured-app",
    });
    expect(span.attributes).toEqual({
      dvm_id: "123e4567-e89b-12d3-a456-426614174010",
      dvm_slug: "configured-app",
    });
  });

  it("extend() does not affect the original logger", async () => {
    loggers.platform.extend({ extra: "dim" });
    loggers.platform.info("original");
    await new Promise((r) => setTimeout(r, 10));

    const span = captured[0];
    expect(span.dimensions).not.toHaveProperty("extra");
  });

  it("tracked() wraps a function in a span", async () => {
    const fn = (a: number, b: number) => a + b;
    const tracked = loggers.platform.tracked(
      "update",
      fn as (...args: never[]) => unknown,
    );
    const result = await (tracked as (a: number, b: number) => Promise<number>)(
      3,
      4,
    );
    expect(result).toBe(7);

    const span = captured[0];
    expect(span.name).toBe("update");
  });

  it("all 9 dataset loggers are available", () => {
    const datasets = [
      "platform",
      "cashu",
      "lightning",
      "stripe",
      "x402",
      "tempo",
      "isolate",
      "audit",
      "cron",
    ] as const;
    for (const ds of datasets) {
      expect(loggers[ds]).toBeDefined();
      expect(typeof loggers[ds].info).toBe("function");
    }
  });
});
