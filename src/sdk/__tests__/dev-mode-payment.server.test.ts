import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../sdk/index";
import { servedApps } from "../../test-support/served-app";
import { createFxFetcher, type FxFetcher } from "../pricing/index";
import { createDVMServer } from "../server/app";
import { MemoryKVStore } from "../store";

const stubFx: FxFetcher = {
  fetch: () => Promise.resolve({ rates: { usd: 100_000 }, as_of: "2026-05-13T00:00:00Z" }),
  supportedCurrencies: () => ["usd"],
};

describe("dev mode payment bypass", () => {
  const servers = servedApps({ teardown: "all" });
  let url: string;

  const dvm = configureDVM({
    name: "Payment Test",
    capability: "test",
    price: "$0.10",
    async onJob(ctx) {
      ctx.complete("done without payment");
    },
  });

  beforeAll(async () => {
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      fxFetcher: stubFx,
    });

    url = await servers.serve(app);
  });

  it("skips upfront payment in dev mode when no mints configured", async () => {
    const res = await fetch(`${url}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "test" }),
    });

    expect(res.status).not.toBe(402);
    const data = (await res.json()) as { job_id: string; status?: string };
    expect(data.job_id).toBeDefined();
  });

  it("completes a priced job without fetching FX when dev payments are skipped", async () => {
    const failedFetch = vi.fn(async () => new Response(null, { status: 429 }));
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      fxFetcher: createFxFetcher({
        source: "https://example.com/fx",
        currencies: ["usd"],
        fetchFn: failedFetch as typeof fetch,
        retries: 0,
      }),
    });
    const freeUrl = await servers.serve(app);

    const res = await fetch(`${freeUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "test" }),
    });
    expect([200, 202]).toContain(res.status);
    const { job_id, job_token } = (await res.json()) as { job_id: string; job_token: string };
    await vi.waitFor(async () => {
      const status = await fetch(`${freeUrl}/v1/job/${job_id}`, {
        headers: { "X-Job-Token": job_token },
      });
      expect(await status.json()).toMatchObject({
        status: "completed",
        summary: "done without payment",
      });
    });
    expect(failedFetch).not.toHaveBeenCalled();
  });

  it("returns the retryable FX envelope when a configured rail needs a rate", async () => {
    const failedFetch = vi.fn(async () => new Response(null, { status: 429 }));
    const { app } = await createDVMServer(dvm, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      mints: [],
      fxFetcher: createFxFetcher({
        source: "https://example.com/fx",
        currencies: ["usd"],
        fetchFn: failedFetch as typeof fetch,
        retries: 0,
      }),
    });
    const paidUrl = await servers.serve(app);

    const res = await fetch(`${paidUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", input: "test" }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: {
        code: "fx_rate_unavailable",
        display: "Couldn't fetch the BTC reference rate to lock pricing",
        hint: "transient — try the quote again in a few seconds",
      },
    });
    expect(failedFetch).toHaveBeenCalledOnce();
  });

  it("validates a dynamic quote without converting it when dev payments are skipped", async () => {
    const failedFetch = vi.fn(async () => new Response(null, { status: 429 }));
    const quote = vi.fn(async () => ({
      upfront: { amount: 0.01, currency: "usd" as const },
      description: "one job",
    }));
    const dynamic = configureDVM({
      name: "Dynamic Payment Test",
      capability: "test",
      input: z.object({ text: z.string() }),
      onQuote: { schema: z.object({ text: z.string() }), handler: quote },
      onJob(ctx) {
        ctx.complete(ctx.input.text);
      },
    });
    const { app } = await createDVMServer(dynamic, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      fxFetcher: createFxFetcher({
        source: "https://example.com/fx",
        currencies: ["usd"],
        fetchFn: failedFetch as typeof fetch,
        retries: 0,
      }),
    });
    const freeUrl = await servers.serve(app);

    const res = await fetch(`${freeUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", data: { text: "done" } }),
    });
    expect([200, 202]).toContain(res.status);
    const { job_id, job_token } = (await res.json()) as { job_id: string; job_token: string };
    await vi.waitFor(async () => {
      const status = await fetch(`${freeUrl}/v1/job/${job_id}`, {
        headers: { "X-Job-Token": job_token },
      });
      expect(await status.json()).toMatchObject({ status: "completed", summary: "done" });
    });
    expect(quote).toHaveBeenCalledOnce();
    expect(failedFetch).not.toHaveBeenCalled();
  });

  it("uses a static price without validating onQuote when both are declared", async () => {
    const quote = vi.fn(async () => ({
      upfront: { amount: 0.02, currency: "usd" as const },
      description: "dynamic price",
    }));
    const both = configureDVM({
      name: "Static Payment Test",
      capability: "test",
      price: "$0.01",
      input: z.object({ text: z.string() }),
      onQuote: { schema: z.object({ quoteOnly: z.number() }), handler: quote },
      onJob(ctx) {
        ctx.complete(ctx.input.text);
      },
    });
    const { app } = await createDVMServer(both, {
      env: {},
      store: new MemoryKVStore(),
      devMode: true,
      fxFetcher: stubFx,
    });
    const freeUrl = await servers.serve(app);

    const res = await fetch(`${freeUrl}/v1/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability: "test", data: { text: "done" } }),
    });
    expect([200, 202]).toContain(res.status);
    const { job_id, job_token } = (await res.json()) as { job_id: string; job_token: string };
    await vi.waitFor(async () => {
      const status = await fetch(`${freeUrl}/v1/job/${job_id}`, {
        headers: { "X-Job-Token": job_token },
      });
      expect(await status.json()).toMatchObject({ status: "completed", summary: "done" });
    });
    expect(quote).not.toHaveBeenCalled();
  });

  it("serves /_dev page in dev mode", async () => {
    const res = await fetch(`${url}/_dev`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Payment Test");
    expect(html).toContain("Submit Job");
  });
});
