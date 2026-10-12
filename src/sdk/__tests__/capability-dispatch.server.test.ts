import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { servedApps } from "../../test-support/served-app";
import { configureDVM } from "../configure";
import type { FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import type { JobRecord } from "../server/job-store";
import { MemoryJobStore } from "../server/memory-job-store";
import { MemoryKVStore } from "../store";

// Deterministic fx stub — narrow currency conversion stays stable across runs.
const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe("capability dispatch", () => {
  const servers = servedApps();
  let baseUrl: string;

  async function startApp(
    descriptor: ReturnType<typeof configureDVM<any, any>>,
    extra: { jobStore?: MemoryJobStore } = {}
  ): Promise<void> {
    const { app } = await createDVMServer(descriptor, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      fxFetcher: stubFx,
      jobStore: extra.jobStore,
    });
    baseUrl = await servers.serve(app);
  }

  function postJson(
    path: string,
    body: Record<string, unknown>,
    jobToken?: string
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(jobToken ? { "X-Job-Token": jobToken } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("single-capability descriptor exposes one entry under /v1/info.capabilities", async () => {
    await startApp(
      configureDVM({
        name: "narrate",
        capability: "synthesise",
        input: z.object({ text: z.string() }),
        onJob(ctx) {
          ctx.complete(ctx.input.text);
        },
      })
    );

    const res = await fetch(`${baseUrl}/v1/info`);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.capabilities).toBeDefined();
    const caps = body.capabilities as Record<string, Record<string, unknown>>;
    expect(Object.keys(caps)).toEqual(["synthesise"]);
    expect(caps.synthesise.input_schema).toBeDefined();

    // Top-level schema/pricing/quote fields are gone — the per-capability
    // map is now the single source of truth.
    expect(body.input_schema).toBeUndefined();
    expect(body.quote).toBeUndefined();
    expect(body.pricing).toBeUndefined();
  });

  it("multi-capability descriptor exposes one entry per capability", async () => {
    await startApp(
      configureDVM({
        name: "cast",
        description: "Host RSS feeds",
        capabilities: {
          "add-episode": {
            description: "Add an episode",
            input: z.object({ url: z.string() }),
            onJob(ctx) {
              ctx.complete("added");
            },
          },
          "update-feed": {
            description: "Update feed metadata",
            input: z.object({ slug: z.string() }),
            onJob(ctx) {
              ctx.complete("updated");
            },
          },
          "delete-episode": {
            description: "Delete an episode",
            input: z.object({ id: z.string() }),
            onJob(ctx) {
              ctx.complete("deleted");
            },
          },
          "delete-feed": {
            description: "Delete a feed",
            input: z.object({ slug: z.string() }),
            onJob(ctx) {
              ctx.complete("dropped");
            },
          },
        },
      })
    );

    const res = await fetch(`${baseUrl}/v1/info`);
    const body = (await res.json()) as Record<string, unknown>;
    const caps = body.capabilities as Record<string, Record<string, unknown>>;
    expect(Object.keys(caps).sort()).toEqual([
      "add-episode",
      "delete-episode",
      "delete-feed",
      "update-feed",
    ]);
    expect(caps["add-episode"].description).toBe("Add an episode");
    expect(caps["add-episode"].input_schema).toBeDefined();
  });

  it("/v1/info input_schema is emitted in input mode — defaulted fields stay optional", async () => {
    await startApp(
      configureDVM({
        name: "scrape",
        capability: "fetch",
        input: z.object({
          url: z.string().min(1),
          format: z.enum(["markdown", "html"]).optional().default("markdown"),
          screenshot: z.boolean().optional().default(false),
        }),
        onJob(ctx) {
          ctx.complete(ctx.input.url);
        },
      })
    );

    const res = await fetch(`${baseUrl}/v1/info`);
    const body = (await res.json()) as Record<string, unknown>;
    const caps = body.capabilities as Record<string, Record<string, unknown>>;
    const schema = caps.fetch.input_schema as {
      required: string[];
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.required).toEqual(["url"]);
    expect(schema.properties.format.default).toBe("markdown");
    expect(schema.properties.screenshot.default).toBe(false);
  });

  it("renames payment_methods → payment.methods", async () => {
    await startApp(
      configureDVM({
        name: "narrate",
        capability: "synthesise",
        async onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const res = await fetch(`${baseUrl}/v1/info`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.payment).toBeDefined();
    expect((body.payment as { methods: string[] }).methods).toEqual([]);
    expect(body.payment_methods).toBeUndefined();
  });

  it("POST /v1/job rejects missing capability with capability_required 400", async () => {
    await startApp(
      configureDVM({
        name: "narrate",
        capability: "synthesise",
        async onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const res = await postJson("/v1/job", { input: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("capability_required");
    expect(body.hint).toMatch(/synthesise/);
  });

  it("POST /v1/job rejects an unknown capability with unknown_capability 400", async () => {
    await startApp(
      configureDVM({
        name: "narrate",
        capability: "synthesise",
        async onJob(ctx) {
          ctx.complete("ok");
        },
      })
    );

    const res = await postJson("/v1/job", { capability: "translate", input: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_capability");
    expect(body.hint).toMatch(/synthesise/);
  });

  it("dispatches to the right capability's onJob based on body.capability", async () => {
    const calls: string[] = [];
    await startApp(
      configureDVM({
        name: "router",
        capabilities: {
          alpha: {
            input: z.object({ kind: z.string() }),
            onJob(ctx) {
              const input = ctx.input as { kind: string };
              calls.push(`alpha:${input.kind}`);
              ctx.complete("alpha done");
            },
          },
          beta: {
            input: z.object({ kind: z.string() }),
            onJob(ctx) {
              const input = ctx.input as { kind: string };
              calls.push(`beta:${input.kind}`);
              ctx.complete("beta done");
            },
          },
        },
      })
    );

    const res = await postJson("/v1/job", {
      capability: "beta",
      data: { kind: "one" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.summary).toBe("beta done");
    expect(calls).toEqual(["beta:one"]);
  });

  it("each capability's input is parsed against its own schema", async () => {
    await startApp(
      configureDVM({
        name: "router",
        capabilities: {
          textual: {
            input: z.object({ text: z.string() }),
            onJob(ctx) {
              const input = ctx.input as { text: string };
              ctx.complete(input.text);
            },
          },
          numeric: {
            input: z.object({ value: z.number() }),
            onJob(ctx) {
              const input = ctx.input as { value: number };
              ctx.complete(String(input.value));
            },
          },
        },
      })
    );

    // A payload that satisfies "numeric" must be rejected on "textual".
    const wrongCap = await postJson("/v1/job", {
      capability: "textual",
      data: { value: 42 },
    });
    expect(wrongCap.status).toBe(400);
    const wrongBody = (await wrongCap.json()) as Record<string, unknown>;
    expect(wrongBody.error).toBe("invalid_input");

    // Same payload against the right capability completes.
    const rightCap = await postJson("/v1/job", {
      capability: "numeric",
      data: { value: 42 },
    });
    expect(rightCap.status).toBe(200);
    const rightBody = (await rightCap.json()) as Record<string, unknown>;
    expect(rightBody.summary).toBe("42");
  });

  it("POST /v1/quote rejects missing capability with capability_required 400", async () => {
    await startApp(
      configureDVM({
        name: "router",
        capabilities: {
          alpha: {
            input: z.object({ x: z.number() }),
            onJob(ctx) {
              ctx.complete("ok");
            },
            onQuote: {
              schema: z.object({ x: z.number() }),
              handler() {
                return Promise.resolve({
                  upfront: { amount: 0.01, currency: "usd" },
                  description: "Alpha quote",
                });
              },
            },
          },
        },
      })
    );

    const res = await postJson("/v1/quote", { data: { x: 1 } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("capability_required");
  });

  it("POST /v1/job/:id/messages fails legacy rows with unknown capability cleanly", async () => {
    const jobStore = new MemoryJobStore();
    const legacy: JobRecord = {
      id: "legacy-job-1",
      tags: ["test"],
      // Earlier rows surface here with `""` via PostgresJobStore's
      // rowToRecord fallback for the now-nullable column.
      capability: "",
      input: "{}",
      params: {},
      requesterId: "dev-anonymous",
      // per-job token, as a live row carries it — refuses a
      // credential-less write before the capability is ever resolved, so
      // reaching the 410 under test means presenting the owner's token.
      requesterTokenHash: createHash("sha256").update("legacy-token").digest("hex"),
      status: "processing",
      messages: [],
      seq: 0,
      paidMsats: 0,
      receivedProofs: [],
      stepCache: [],
      state: {},
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };
    await jobStore.save(legacy);

    await startApp(
      configureDVM({
        name: "narrate",
        capability: "synthesise",
        onJob(ctx) {
          ctx.complete("ok");
        },
      }),
      { jobStore }
    );

    const res = await postJson(
      `/v1/job/${legacy.id}/messages`,
      { type: "response", content: { text: "hi" } },
      "legacy-token"
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("unknown_capability");

    const updated = await jobStore.get(legacy.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.summary).toMatch(/capability dispatch/);
  });
});

describe("configureDVM capability validation", () => {
  it("rejects providing both flat capability and capabilities block", () => {
    expect(() =>
      configureDVM({
        name: "broken",
        capability: "alpha",

        capabilities: { alpha: { onJob() {} } } as any,
      })
    ).toThrow(/either the flat single-capability shape.*or the explicit/);
  });

  it("rejects a capabilities block with no entries", () => {
    expect(() =>
      configureDVM({
        name: "broken",
        capabilities: {},
      })
    ).toThrow(/at least one capability/);
  });

  it("rejects a multi-cap entry missing onJob", () => {
    expect(() =>
      configureDVM({
        name: "broken",

        capabilities: { alpha: { description: "no handler" } as any },
      })
    ).toThrow(/missing required onJob handler/);
  });

  it("rejects invalid capability names", () => {
    expect(() =>
      configureDVM({
        name: "broken",
        capabilities: {
          "Has Spaces": { onJob() {} } as any,
        },
      })
    ).toThrow(/invalid capability name/);
  });

  it("synthesises a capability name from the DVM name when omitted in flat shape", () => {
    const dvm = configureDVM({
      name: "Slug-Synthesis Example",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    expect(Object.keys(dvm.capabilities)).toEqual(["slug-synthesis-example"]);
  });

  it("populates the capabilities map for the flat shape with the declared name", () => {
    const dvm = configureDVM({
      name: "narrate",
      capability: "synthesise",
      onJob(ctx) {
        ctx.complete("ok");
      },
    });
    expect(Object.keys(dvm.capabilities)).toEqual(["synthesise"]);
    expect(dvm.capabilities.synthesise.onJob).toBe(dvm.config.onJob);
  });
});
