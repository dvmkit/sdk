import { afterEach, describe, expect, it } from "vitest";

import { configureDVM } from "../src/sdk/configure";
import { createDVMServer } from "../src/sdk/server/app";
import { MemoryKVStore } from "../src/sdk/store";

describe("development CORS", () => {
  let shutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await shutdown?.();
  });

  it("handles a preflight header with adversarial whitespace in bounded time", async () => {
    const descriptor = configureDVM({
      name: "cors-regression",
      capability: "echo",
      onJob: () => undefined,
    });
    const server = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
    });
    shutdown = server.shutdown;

    // This shape triggered quadratic backtracking in Hono before 4.12.34.
    // Keep the request inside Node's default 16 KiB HTTP-header limit so the
    // test represents input the development listener can accept.
    const requestedHeaders = `x${" ".repeat(15_000)}y`;
    const request = new Request("http://localhost/v1/info", {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3000",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": requestedHeaders,
      },
    });

    // Vitest runs each test file in a forked process. Process CPU therefore
    // measures this request path without charging time the worker is descheduled.
    const cpuStarted = process.cpuUsage();
    const response = await server.app.fetch(request);
    const cpu = process.cpuUsage(cpuStarted);
    const cpuMs = (cpu.user + cpu.system) / 1_000;

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe(requestedHeaders);
    expect(cpuMs).toBeLessThan(200);
  });
});
