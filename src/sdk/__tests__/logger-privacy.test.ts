import { afterEach, describe, expect, it, vi } from "vitest";

import { createConsoleLogger, createStdoutLogger } from "../logger";

describe("public SDK loggers", () => {
  afterEach(() => vi.restoreAllMocks());

  it("replaces caller messages and projects data before the console sink", () => {
    const sink = vi.spyOn(console, "error").mockImplementation(() => {});
    const cyclic: Record<string, unknown> = { nested: "SENTINEL_NESTED" };
    cyclic.self = cyclic;

    createConsoleLogger("SENTINEL_JOB").error("SENTINEL_MESSAGE", {
      required_msats: 42,
      authorization: "SENTINEL_CREDENTIAL",
      cyclic,
    });

    expect(sink).toHaveBeenCalledOnce();
    expect(JSON.parse(String(sink.mock.calls[0][0]))).toEqual({
      event: "diagnostic.message",
      level: "error",
      required_msats: 42,
    });
    expect(String(sink.mock.calls[0][0])).not.toContain("SENTINEL");
  });

  it("does not invoke hostile getters or trust raw identity fields", () => {
    const sink = vi.spyOn(console, "info").mockImplementation(() => {});
    const getter = vi.fn(() => "SENTINEL_GETTER");
    const context = { dvm_slug: "example-dvm" } as Record<string, unknown>;
    const data = {
      count: 2,
      dvm_id: "123e4567-e89b-12d3-a456-426614174000",
    } as Record<string, unknown>;
    Object.defineProperty(context, "builder_id", {
      enumerable: true,
      get: getter,
    });
    Object.defineProperty(data, "amount", { enumerable: true, get: getter });

    createStdoutLogger(context).info("SENTINEL_MESSAGE", data);

    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(String(sink.mock.calls[0][0]))).toEqual({
      event: "diagnostic.message",
      level: "info",
      count: 2,
    });
  });

  it("omits untrusted capability names from direct logger calls", () => {
    const sink = vi.spyOn(console, "warn").mockImplementation(() => {});

    createConsoleLogger("unused").warn("ignored", {
      capability: "customer_support",
      count: 1,
    });

    expect(JSON.parse(String(sink.mock.calls[0][0]))).toEqual({
      event: "diagnostic.message",
      level: "warn",
      count: 1,
    });
  });

  it("does not let a logger sink failure escape to application code", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("sink unavailable");
    });

    expect(() => createConsoleLogger("unused").error("ignored")).not.toThrow();
  });
});
