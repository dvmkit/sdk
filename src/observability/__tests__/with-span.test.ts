import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pinDimension, setDimension, withTraceContext } from "../context";
import { createDiagnosticCapabilityAuthority } from "../projection";
import { SpanWriter } from "../span-writer";
import type { SpanRow } from "../types";
import { setEmitter, withSpan } from "../with-span";

describe("withSpan", () => {
  const emitted: SpanRow[] = [];

  beforeEach(() => {
    emitted.length = 0;
    setEmitter((row) => emitted.push(row));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    setEmitter(null);
    vi.restoreAllMocks();
  });

  it("emits a span with correct fields on success", async () => {
    const result = await withSpan({ dataset: "platform", name: "message", attrs: { count: 1 } }, () => 42);

    expect(result).toBe(42);
    expect(emitted).toHaveLength(1);

    const span = emitted[0];
    expect(span.dataset).toBe("platform");
    expect(span.name).toBe("message");
    expect(span.status).toBe("ok");
    expect(span.level).toBe("info");
    expect(span.attributes).toEqual({ count: 1 });
    expect(span.span_id).toHaveLength(16);
    expect(span.trace_id).toHaveLength(32);
    expect(span.service_version).toBeDefined();
    expect(span.host === null || span.host === "localhost").toBe(true);
    expect(span.pid).toBe(process.pid);
  });

  it("captures error on throw and propagates it", async () => {
    const err = new Error("boom");
    await expect(
      withSpan({ dataset: "cashu", name: "fail.op" }, () => {
        throw err;
      })
    ).rejects.toThrow("boom");

    expect(emitted).toHaveLength(1);
    const span = emitted[0];
    expect(span.status).toBe("error");
    expect(span.level).toBe("error");
    expect(span.error_message).toBeNull();
    expect(span.error_stack).toBeNull();
  });

  it("pre-sets error fields from opts.err (logger.error path)", async () => {
    await withSpan(
      {
        dataset: "platform",
        name: "log.error",
        level: "error",
        err: new Error("pre-set")
      },

      () => {}
    );

    const span = emitted[0];
    expect(span.status).toBe("error");
    expect(span.error_message).toBeNull();
  });

  it("async functions work correctly", async () => {
    const result = await withSpan({ dataset: "platform", name: "async.op" }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "async-result";
    });

    expect(result).toBe("async-result");
    expect(emitted).toHaveLength(1);
    expect(emitted[0].status).toBe("ok");
  });

  it("nested spans chain parent IDs", async () => {
    await withSpan({ dataset: "platform", name: "outer" }, async () => {
      await withSpan({ dataset: "platform", name: "inner" }, async () => {
        await withSpan(
          { dataset: "platform", name: "innermost" },

          () => {}
        );
      });
    });

    expect(emitted).toHaveLength(3);
    const [innermost, inner, outer] = emitted;

    expect(innermost.trace_id).toBe(inner.trace_id);
    expect(inner.trace_id).toBe(outer.trace_id);

    expect(innermost.parent_span_id).toBe(inner.span_id);
    expect(inner.parent_span_id).toBe(outer.span_id);
    expect(outer.parent_span_id).toBeNull();
  });

  it("inherits dimensions from ALS context", async () => {
    const ctx = {
      traceId: "22222222222222222222222222222222",
      spanId: "1111111111111111",
      dimensions: { count: 3 } as Record<string, unknown>,
      service: "platform-api"
    };

    await withTraceContext(ctx, async () => {
      await withSpan({ dataset: "platform", name: "with-dims" }, () => {});
    });

    const span = emitted[0];
    expect(span.dimensions).toEqual({ count: 3 });
    expect(span.service).toBe("platform-api");
    expect(span.parent_span_id).toBe("1111111111111111");
  });

  it("merges opts.dims with context dimensions", async () => {
    const ctx = {
      traceId: "22222222222222222222222222222222",
      spanId: null,
      dimensions: { count: 2 } as Record<string, unknown>,
      service: "test",
      diagnosticCapabilityAuthority: createDiagnosticCapabilityAuthority([
        "extract",
      ]),
    };

    await withTraceContext(ctx, async () => {
      await withSpan(
        {
          dataset: "platform",
          name: "message",
          dims: { capability: "extract" }
        },

        () => {}
      );
    });

    const span = emitted[0];
    expect(span.dimensions).toEqual({
      count: 2,
      capability: "extract"
    });
  });

  it("respects startMs/endMs overrides", async () => {
    await withSpan({ dataset: "platform", name: "overridden", startMs: 1000, endMs: 2000 }, () => {});

    const span = emitted[0];
    expect(span.started_at_ms).toBe(1000);
    expect(span.ended_at_ms).toBe(2000);
  });

  it("writes to stdout via writeSpanLine", async () => {
    const writeSpy = vi.spyOn(process.stdout, "write");

    await withSpan({ dataset: "platform", name: "message" }, () => {});

    expect(writeSpy).toHaveBeenCalled();
    const output = writeSpy.mock.calls[0][0] as string;
    expect(output).toContain("platform");
    expect(output).toContain("message");
  });

  it("inspect overrides status and errorMessage", async () => {
    const result = await withSpan(
      {
        dataset: "platform",
        name: "inspected",
        attrs: {},
        inspect: () => ({ status: "error", errorMessage: "bad response" })
      },
      () => "ok"
    );

    expect(result).toBe("ok");
    const span = emitted[0];
    expect(span.status).toBe("error");
    expect(span.error_message).toBeNull();
    expect(span.level).toBe("error");
  });

  it("inspect merges additional attrs", async () => {
    await withSpan(
      {
        dataset: "platform",
        name: "inspected-attrs",
        attrs: { count: 1 },
        inspect: () => ({ attrs: { "http.status_code": 400 } })
      },
      () => {}
    );

    const span = emitted[0];
    expect(span.status).toBe("ok");
    expect(span.attributes).toEqual({ count: 1, "http.status_code": 400 });
  });

  it("inspect returning undefined leaves span unchanged", async () => {
    await withSpan(
      {
        dataset: "platform",
        name: "noop-inspect",
        attrs: { count: 1 },
        inspect: () => undefined
      },
      () => {}
    );

    const span = emitted[0];
    expect(span.status).toBe("ok");
    expect(span.error_message).toBeNull();
    expect(span.attributes).toEqual({ count: 1 });
  });

  it("inspect is not called when fn throws", async () => {
    const inspectFn = vi.fn();
    await expect(
      withSpan({ dataset: "platform", name: "throw-inspect", inspect: inspectFn }, () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(inspectFn).not.toHaveBeenCalled();
    const span = emitted[0];
    expect(span.status).toBe("error");
    expect(span.error_message).toBeNull();
  });

  it("carries late trusted identity through nested scopes and buffered transport", async () => {
    const transported: SpanRow[][] = [];
    const writer = new SpanWriter(
      {
        async send(rows) {
          transported.push(rows);
        },
      },
      10_000,
    );
    setEmitter((row) => writer.enqueue(row));

    await withTraceContext(
      {
        traceId: "33333333333333333333333333333333",
        spanId: null,
        dimensions: {},
        service: "isolate-approved-app",
        diagnosticCapabilityAuthority:
          createDiagnosticCapabilityAuthority(["transcribe"]),
      },
      async () => {
        pinDimension("dvm_id", "123e4567-e89b-12d3-a456-426614174020");
        await withSpan(
          {
            dataset: "isolate",
            name: "dvm.request",
            attrs: {
              dvm_id: "123e4567-e89b-12d3-a456-426614174099",
              dvm_slug: "attribute-spoof",
            },
            dims: {
              dvm_id: "123e4567-e89b-12d3-a456-426614174098",
              dvm_slug: "dimension-spoof",
            },
          },
          async () => {
            pinDimension(
              "dvm_id",
              "123e4567-e89b-12d3-a456-426614174021",
            );
            pinDimension("dvm_slug", "approved-app");
            pinDimension("capability", "transcribe");
            setDimension(
              "dvm_id",
              "123e4567-e89b-12d3-a456-426614174097",
            );
            await withSpan(
              {
                dataset: "isolate",
                name: "message",
                dims: { dvm_slug: "nested-dimension-spoof" },
              },
              () => {
                pinDimension("dvm_slug", "approved-child");
              },
            );
          },
        );
        pinDimension("dvm_id", "123e4567-e89b-12d3-a456-426614174096");
        pinDimension("dvm_slug", "post-emit-mutation");
      },
    );

    await writer.flush();

    const stdout = vi
      .mocked(process.stdout.write)
      .mock.calls.map(([line]) => String(line))
      .join("");
    expect(stdout).toContain(
      "dvm_id=123e4567-e89b-12d3-a456-426614174021",
    );
    expect(stdout).toContain("dvm_slug=approved-app");
    expect(stdout).not.toContain("174097");
    expect(stdout).not.toContain("post-emit-mutation");
    expect(transported).toHaveLength(1);
    const outer = transported[0].find((row) => row.name === "dvm.request");
    const inner = transported[0].find((row) => row.name === "message");
    expect(outer?.dimensions).toEqual({
      dvm_id: "123e4567-e89b-12d3-a456-426614174021",
      dvm_slug: "approved-app",
      capability: "transcribe",
    });
    expect(outer?.attributes).toEqual({
      dvm_id: "123e4567-e89b-12d3-a456-426614174021",
      dvm_slug: "approved-app",
    });
    expect(inner?.dimensions).toEqual({
      dvm_id: "123e4567-e89b-12d3-a456-426614174021",
      dvm_slug: "approved-child",
      capability: "transcribe",
    });
  });

  it.each([
    ["throwing callback", () => {
      throw new Error("SENTINEL_INSPECT_CALLBACK");
    }],
    [
      "hostile proxy",
      () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("SENTINEL_INSPECT_PROXY");
            },
          },
        ),
    ],
    [
      "throwing getter",
      () => ({
        get status() {
          throw new Error("SENTINEL_INSPECT_GETTER");
        },
      }),
    ],
  ])("preserves a successful result when inspect has a %s", async (_name, inspect) => {
    const result = await withSpan(
      { dataset: "platform", name: "message", inspect },
      () => "business-ok",
    );

    expect(result).toBe("business-ok");
    expect(emitted[0]).toMatchObject({
      name: "message",
      status: "ok",
      attributes: {},
    });
    expect(
      vi
        .mocked(process.stdout.write)
        .mock.calls.map(([line]) => String(line))
        .join(""),
    ).not.toContain("SENTINEL");
  });

  it.each([
    ["throwing mapper", () => {
      throw new Error("SENTINEL_ON_ERROR_CALLBACK");
    }],
    [
      "hostile projected overrides",
      () =>
        new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("SENTINEL_ON_ERROR_PROXY");
            },
          },
        ),
    ],
  ])("preserves the original thrown object when onError has %s", async (_name, onError) => {
    const original = Object.freeze({ reason: "business failure" });

    await expect(
      withSpan(
        { dataset: "platform", name: "message", onError },
        () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(emitted[0]).toMatchObject({
      name: "message",
      status: "error",
      attributes: {},
    });
    expect(
      vi
        .mocked(process.stdout.write)
        .mock.calls.map(([line]) => String(line))
        .join(""),
    ).not.toContain("SENTINEL");
  });
});
