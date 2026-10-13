import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initLoggers } from "../../observability/loggers";
import { SpanWriter } from "../../observability/span-writer";
import type { SpanRow, SpanTransport } from "../../observability/types";
import { setEmitter } from "../../observability/with-span";
import { createInstrumentedFetch } from "../server/instrumented-fetch";

/** No-op transport — spans are captured via setEmitter instead. */
const noopTransport: SpanTransport = { send: async () => {} };

describe("createInstrumentedFetch", () => {
  const emitted: SpanRow[] = [];
  let instrumentedFetch: typeof globalThis.fetch;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    emitted.length = 0;
    const writer = new SpanWriter(noopTransport);
    initLoggers(writer, "test");
    setEmitter((row) => emitted.push(row));
    instrumentedFetch = createInstrumentedFetch();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setEmitter(() => {});
  });

  it("delegates to globalThis.fetch and emits dvm.fetch span", async () => {
    const mockResponse = new Response("ok", { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await instrumentedFetch("https://api.example.com/data");
    expect(result).toBe(mockResponse);
    expect(globalThis.fetch).toHaveBeenCalledWith("https://api.example.com/data", undefined);

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span).toBeDefined();
    expect(span?.dataset).toBe("isolate");
    expect(span?.attributes.url).toBe("https://api.example.com");
    expect(span?.attributes.method).toBe("GET");
  });

  it("captures POST method", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    await instrumentedFetch("https://api.example.com/data", {
      method: "POST",
      body: "test"
    });

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span?.attributes.method).toBe("POST");
  });

  it("redacts query strings from URL attribute", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    await instrumentedFetch("https://api.example.com/search?q=secret&token=abc123");

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span?.attributes.url).toBe("https://api.example.com");
    expect(String(span?.attributes.url)).not.toContain("secret");
    expect(String(span?.attributes.url)).not.toContain("abc123");
  });

  it("redacts UUID path segments", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));

    await instrumentedFetch("https://api.example.com/users/550e8400-e29b-41d4-a716-446655440000/profile");

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span?.attributes.url).toBe("https://api.example.com");
  });

  it("redacts opaque provider credentials before emitting the span", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const key = "tenant@aB0OcD1IeF2lgH3JkL4MnP5QrS6TuV+=";

    await instrumentedFetch(`https://base-mainnet.g.alchemy.com/v2/${key}`);

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span?.attributes.url).toBe("https://base-mainnet.g.alchemy.com");
    expect(String(span?.attributes.url)).not.toContain(key);
  });

  it("captures error spans when fetch throws", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    await expect(instrumentedFetch("https://api.example.com/fail")).rejects.toThrow("network error");

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span).toBeDefined();
    expect(span?.status).toBe("error");
    expect(span?.error_message).toBeNull();
  });

  it("extracts method from Request object input", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const req = new Request("https://api.example.com/items/99999", {
      method: "DELETE"
    });

    await instrumentedFetch(req);

    const span = emitted.find((s) => s.name === "dvm.fetch");
    expect(span?.attributes.url).toBe("https://api.example.com");
    expect(span?.attributes.method).toBe("DELETE");
  });
});
