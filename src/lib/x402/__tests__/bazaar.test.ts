import { extractDiscoveryInfo, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildX402Discovery, x402BodySchema } from "../bazaar";

const ORIGIN = "https://dvm.example.com";

/** A paid retry as a stock client sends it: the 402's resource and extensions echoed back. */
function paidRetry(discovery: ReturnType<typeof buildX402Discovery>) {
  const accepted = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "10000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0x1111111111111111111111111111111111111111",
    maxTimeoutSeconds: 60,
    extra: {},
  };
  return {
    payload: {
      x402Version: 2 as const,
      resource: discovery.resource,
      accepted,
      payload: {},
      extensions: discovery.extensions,
    },
    requirements: accepted,
  };
}

const shapes = [
  {
    kind: "scrape",
    name: "scrape",
    input: z.object({
      url: z.string().url(),
      format: z.enum(["markdown", "text"]).default("markdown"),
      pubkey: z.string().optional(),
      signature: z.string().optional(),
      timestamp: z.number().optional(),
      nonce: z.string().optional(),
    }),
    example: { url: "https://example.com/article" },
    field: "url",
  },
  {
    kind: "discover",
    name: "discover",
    input: z.object({ query: z.string().min(1), limit: z.number().int().max(50).optional() }),
    example: { query: "open source vector databases" },
    field: "query",
  },
];

describe("x402 bazaar discovery", () => {
  it.each(shapes)("is accepted by upstream validation and extraction ($kind)", (shape) => {
    const discovery = buildX402Discovery({
      name: shape.name,
      listing: {
        description: `Example ${shape.kind} capability.`,
        example: shape.example,
        outputExample: { ok: true },
        serviceName: "Example DVM",
        tags: ["web", "search"],
        iconUrl: "https://cdn.example.com/icon.png",
      },
      bodySchema: x402BodySchema(shape.input),
      publicOrigin: ORIGIN,
    });

    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });

    const { payload, requirements } = paidRetry(discovery);
    const extracted = extractDiscoveryInfo(payload as never, requirements as never);
    expect(extracted).toMatchObject({
      resourceUrl: `${ORIGIN}/v1/x402/${shape.name}`,
      method: "POST",
      description: `Example ${shape.kind} capability.`,
      mimeType: "application/json",
      serviceName: "Example DVM",
      tags: ["web", "search"],
      iconUrl: "https://cdn.example.com/icon.png",
      discoveryInfo: {
        input: { type: "http", method: "POST", bodyType: "json", body: shape.example },
        output: { type: "json", example: { ok: true } },
      },
    });
  });

  it("publishes a flat body schema without signed-request fields", () => {
    const body = x402BodySchema(shapes[0].input);
    expect(body).toMatchObject({ type: "object", required: ["url"] });
    expect(Object.keys(body.properties as object).sort()).toEqual(["format", "url"]);
    expect(body).not.toHaveProperty("properties.capability");
    expect(body).not.toHaveProperty("properties.data");
  });

  it("rejects an example the published body schema refuses", () => {
    const discovery = buildX402Discovery({
      name: "discover",
      listing: { description: "Search.", example: { limit: 5 } },
      bodySchema: x402BodySchema(shapes[1].input),
      publicOrigin: ORIGIN,
    });
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never).valid).toBe(false);
  });

  it("uses an inputSchema override instead of the definition's schema", () => {
    const inputSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const discovery = buildX402Discovery({
      name: "discover",
      listing: { description: "Search.", example: { q: "dvm" }, inputSchema },
      bodySchema: x402BodySchema(shapes[1].input),
      publicOrigin: ORIGIN,
    });
    const schema = discovery.extensions.bazaar.schema as {
      properties: { input: { properties: { body: unknown } } };
    };
    expect(schema.properties.input.properties.body).toEqual(inputSchema);
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
  });

  it("keeps an explicit resourceUrl", () => {
    const discovery = buildX402Discovery({
      name: "scrape",
      listing: { description: "Scrape.", example: shapes[0].example, resourceUrl: "https://api.example.com/scrape" },
      bodySchema: x402BodySchema(shapes[0].input),
      publicOrigin: ORIGIN,
    });
    const { payload, requirements } = paidRetry(discovery);
    expect(extractDiscoveryInfo(payload as never, requirements as never)?.resourceUrl)
      .toBe("https://api.example.com/scrape");
  });
});
