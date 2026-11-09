import { readFileSync } from "node:fs";

import { extractDiscoveryInfo, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildX402Discovery, x402BodySchema } from "../bazaar";

const ORIGIN = "https://dvm.example.com";
const listingFixture = JSON.parse(
  readFileSync(new URL("../../../../protocol-fixtures/x402-listing-v1.json", import.meta.url), "utf8")
) as {
  name: string;
  origin: string;
  mountPrefix: string;
  listing: Parameters<typeof buildX402Discovery>[0]["listing"];
  paymentRequired: ReturnType<typeof buildX402Discovery>;
};

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
      input: shape.input,
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
      input: shapes[1].input,
      publicOrigin: ORIGIN,
    });
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never).valid).toBe(false);
  });

  it("uses an inputSchema override instead of the definition's schema", () => {
    const inputSchema = { type: "object", properties: { q: { type: "string" } }, required: ["q"] };
    const discovery = buildX402Discovery({
      name: "discover",
      listing: { description: "Search.", example: { q: "dvm" }, inputSchema },
      input: shapes[1].input,
      publicOrigin: ORIGIN,
    });
    const schema = discovery.extensions.bazaar.schema as {
      properties: { input: { properties: { body: unknown } } };
    };
    expect(schema.properties.input.properties.body).toEqual(inputSchema);
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
  });

  describe("local references in the nested body schema", () => {
    // Upstream compiles the extension schema as one document with the body
    // nested at properties.input.properties.body, so `#`-rooted pointers
    // must resolve there, not at the extension root.
    function expectListed(listing: Parameters<typeof buildX402Discovery>[0]["listing"], input?: unknown) {
      const discovery = buildX402Discovery({ name: "tree", listing, input, publicOrigin: ORIGIN });
      expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
      const { payload, requirements } = paidRetry(discovery);
      expect(extractDiscoveryInfo(payload as never, requirements as never)?.discoveryInfo).toMatchObject({
        input: { body: listing.example },
      });
      return discovery;
    }

    it("resolves $defs pointers in an inputSchema override", () => {
      const inputSchema = { type: "object", $defs: { u: { type: "string" } }, properties: { url: { $ref: "#/$defs/u" } } };
      expectListed({ description: "Fetch.", example: { url: "https://example.com" }, inputSchema });
      const wrong = buildX402Discovery({
        name: "tree", listing: { description: "Fetch.", example: { url: 1 }, inputSchema }, input: undefined, publicOrigin: ORIGIN,
      });
      expect(validateDiscoveryExtension(wrong.extensions.bazaar as never).valid).toBe(false);
    });

    it("resolves the $defs a Zod .meta({ id }) input emits", () => {
      const Url = z.string().url().meta({ id: "Url" });
      expectListed(
        { description: "Compare two pages.", example: { a: "https://example.com", b: "https://example.org" } },
        z.object({ a: Url, b: Url })
      );
    });

    it("resolves a recursive input's root reference against the body", () => {
      const Node: z.ZodType = z.object({ name: z.string(), get children() { return z.array(Node).optional(); } });
      expectListed({ description: "Walk a tree.", example: { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] } }, Node);
      const missingName = buildX402Discovery({
        name: "tree", listing: { description: "Walk a tree.", example: { name: "a", children: [{}] } }, input: Node, publicOrigin: ORIGIN,
      });
      expect(validateDiscoveryExtension(missingName.extensions.bazaar as never).valid).toBe(false);
    });
  });

  it("uses an inputSchema override for an input Zod cannot convert", () => {
    const inputSchema = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
    const discovery = buildX402Discovery({
      name: "fetch",
      listing: { description: "Fetch.", example: { url: "https://example.com" }, inputSchema },
      input: z.object({ url: z.string(), since: z.date().optional() }),
      publicOrigin: ORIGIN,
    });
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
  });

  it("declares the resource and bazaar extension the listing fixture fixes, at the route under the mount prefix", () => {
    const discovery = buildX402Discovery({
      name: listingFixture.name,
      listing: listingFixture.listing,
      input: z.object({ url: z.string().url(), pubkey: z.string().optional() }),
      publicOrigin: listingFixture.origin,
      mountPrefix: listingFixture.mountPrefix,
    });
    expect(discovery).toEqual(listingFixture.paymentRequired);
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
  });

  it("keeps an explicit resourceUrl", () => {
    const discovery = buildX402Discovery({
      name: "scrape",
      listing: { description: "Scrape.", example: shapes[0].example, resourceUrl: "https://api.example.com/scrape" },
      input: shapes[0].input,
      publicOrigin: ORIGIN,
    });
    const { payload, requirements } = paidRetry(discovery);
    expect(extractDiscoveryInfo(payload as never, requirements as never)?.resourceUrl)
      .toBe("https://api.example.com/scrape");
  });
});
