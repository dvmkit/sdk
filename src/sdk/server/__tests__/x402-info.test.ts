/*
 * /v1/info names x402 channel capabilities apart from the dvmkit-protocol
 * `capabilities` map, so a reader never takes an x402 `fetch` for the
 * `/v1/job` `fetch` of the same name, and finds each one's own route.
 */
import { readFileSync } from "node:fs";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { configureDVM } from "../../configure";
import { createFxFetcher } from "../../pricing";
import { MemoryKVStore } from "../../store";
import { createDVMServer } from "../app";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/x402-info-v1.json", import.meta.url), "utf8")
) as { origin: string; mountPrefix: string; info: { capabilities: Record<string, unknown>; x402_capabilities: Record<string, unknown> } };
const x402 = { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:8453", facilitator: "https://facilitator.example.com" };

function dvm() {
  return configureDVM({
    name: "info-check",
    x402,
    capabilities: {
      fetch: {
        description: "Fetch a page and its links.",
        input: z.object({ url: z.string(), depth: z.number().int() }),
        price: "$0.05",
        onJob(ctx) { ctx.complete("job fetch"); },
      },
      "fetch-x402": {
        name: "fetch",
        description: "Fetch one page.",
        input: z.object({ url: z.string() }),
        price: "$0.016",
        maxRuntimeSeconds: 20,
        channels: { job: false, x402: { listing: { description: "Fetch one page.", example: { url: "https://example.com" } } } },
        onJob(ctx) { ctx.complete("x402 fetch"); },
      },
    },
  });
}

async function info(prefix: string): Promise<Record<string, unknown>> {
  const instance = await createDVMServer(dvm(), {
    env: { DVMKIT_PUBLIC_URL: fixture.origin },
    store: new MemoryKVStore(),
    x402,
    fxFetcher: createFxFetcher(),
    devMode: true,
    mountPrefix: prefix,
  });
  try {
    const app = prefix ? new Hono().route(prefix, instance.app) : instance.app;
    const response = await app.request(`${fixture.origin}${prefix.replace(/\/$/, "")}/v1/info`);
    expect(response.status).toBe(200);
    return (await response.json()) as Record<string, unknown>;
  } finally {
    await instance.shutdown();
  }
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));
  for (const level of ["log", "info", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("/v1/info for x402 channel capabilities", () => {
  it("lists the /v1/job fetch in capabilities and the x402 fetch apart, with its route and price, as the fixture fixes them", async () => {
    const body = await info(fixture.mountPrefix);
    expect(body.capabilities).toEqual(fixture.info.capabilities);
    expect(body.x402_capabilities).toEqual(fixture.info.x402_capabilities);
  });

  it("names the route at the server's own mount", async () => {
    const body = (await info("")) as { x402_capabilities: Record<string, { url: string }> };
    expect(body.x402_capabilities.fetch?.url).toBe(`${fixture.origin}/v1/x402/fetch`);
  });

  it("names a mount at a prefix with a trailing slash where the route is served, without a double slash", async () => {
    const body = (await info(`${fixture.mountPrefix}/`)) as { x402_capabilities: Record<string, { url: string }> };
    expect(body.x402_capabilities.fetch?.url).toBe(`${fixture.origin}${fixture.mountPrefix}/v1/x402/fetch`);
  });
});
