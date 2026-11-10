import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SpanRow } from "../../../observability/types";
import { setEmitter } from "../../../observability/with-span";
import { configureDVM } from "../../configure";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";

const origin = "http://request.example.com";

// The emitter receives rows after projection, so `http.route` here is what the
// span store keeps: a value with no catalogue template is dropped.
describe.each(["/feed", "/feed/"])("dvm.request route under mount '%s'", (prefix) => {
  const emitted: SpanRow[] = [];
  let instance: Awaited<ReturnType<typeof createDVMServer>>;
  let app: Pick<Hono, "request">;

  beforeEach(async () => {
    emitted.length = 0;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    for (const level of ["log", "info", "warn"] as const) {
      vi.spyOn(console, level).mockImplementation(() => undefined);
    }
    setEmitter((row) => emitted.push(row));
    instance = await createDVMServer(
      configureDVM({
        name: "mounted-span",
        capability: "echo",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      { env: {}, store: new MemoryKVStore(), devMode: true, mountPrefix: prefix },
    );
    app = new Hono().route(prefix, instance.app);
  });

  afterEach(async () => {
    setEmitter(null);
    await instance?.shutdown();
    vi.restoreAllMocks();
  });

  it.each([
    ["/feed", "/"],
    ["/feed/v1/info", "/v1/info"],
    ["/feed/v1/job/123e4567-e89b-12d3-a456-426614174000", "/v1/job/:id"],
  ])("stores %s under the route template %s", async (path, template) => {
    await app.request(`${origin}${path}`);

    const spans = emitted.filter((row) => row.name === "dvm.request");
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["http.route"]).toBe(template);
  });
});
