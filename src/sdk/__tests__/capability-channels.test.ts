import { describe, expect, it } from "vitest";
import { z } from "zod";

import { capabilityForChannel } from "../capability-channels";
import { configureDVM } from "../configure";
import { secp256k1Auth } from "../server/secp256k1-auth";
import type { CapabilityConfig, X402Listing } from "../types";

const x402 = { payTo: "0x1111111111111111111111111111111111111111", network: "eip155:8453" };
const onJob = (): void => {};
const jobFetch = (): void => {};
const boundedFetch = (): void => {};

const scrapeListing: X402Listing = {
  description: "Fetch a public web page and return its readable text.",
  example: { url: "https://example.com/article" },
};

function withX402(
  overrides: Partial<CapabilityConfig<Record<string, unknown>, z.ZodType>> = {},
  listing: unknown = scrapeListing
) {
  return configureDVM({
    name: "example",
    x402,
    capabilities: {
      echo: { onJob },
      fetch: {
        input: z.object({ url: z.string().url() }),
        maxRuntimeSeconds: 15,
        channels: { x402: { listing: listing as X402Listing } },
        onJob,
        ...overrides,
      },
    },
  });
}

describe("capability channels", () => {
  it("serves different definitions of one name on each channel", () => {
    const dvm = configureDVM({
      name: "example",
      x402,
      capabilities: {
        fetch: { input: z.object({ url: z.string(), depth: z.number() }), price: "$0.05", onJob: jobFetch },
        "fetch-x402": {
          name: "fetch",
          channels: { x402: {} },
          input: z.object({ url: z.string() }),
          price: "$0.01",
          maxRuntimeSeconds: 10,
          onJob: boundedFetch,
        },
      },
    });
    expect(capabilityForChannel(dvm, "fetch", "job")?.onJob).toBe(jobFetch);
    expect(capabilityForChannel(dvm, "fetch", "x402")?.onJob).toBe(boundedFetch);
    expect(capabilityForChannel(dvm, "fetch", "x402")?.price).toBe("$0.01");
    // /v1/job reads `capabilities`, which must not expose the x402-only definition under any key.
    expect(Object.keys(dvm.capabilities)).toEqual(["fetch"]);
    expect(capabilityForChannel(dvm, "fetch-x402", "job")).toBeUndefined();
    expect(capabilityForChannel(dvm, "fetch-x402", "x402")).toBeUndefined();
  });

  it("offers an undeclared capability on the dvmkit protocol only", () => {
    const explicit = configureDVM({ name: "example", x402, capabilities: { fetch: { onJob } } });
    const flat = configureDVM({ name: "example", x402, capability: "fetch", onJob });
    for (const dvm of [explicit, flat]) {
      expect(capabilityForChannel(dvm, "fetch", "job")).toBeDefined();
      expect(capabilityForChannel(dvm, "fetch", "x402")).toBeUndefined();
      expect(dvm.x402Capabilities).toBeUndefined();
    }
  });

  it("returns one definition declared on both channels for each", () => {
    const explicit = configureDVM({
      name: "example",
      x402,
      capabilities: { fetch: { channels: { job: true, x402: {} }, maxRuntimeSeconds: 10, onJob } },
    });
    const flat = configureDVM({
      name: "example", x402, capability: "fetch", channels: { job: true, x402: {} }, maxRuntimeSeconds: 10, onJob,
    });
    for (const dvm of [explicit, flat]) {
      const job = capabilityForChannel(dvm, "fetch", "job");
      expect(job).toBeDefined();
      expect(capabilityForChannel(dvm, "fetch", "x402")).toBe(job);
    }
  });

  it("does not resolve prototype member names", () => {
    const dvm = withX402();
    expect(capabilityForChannel(dvm, "constructor", "job")).toBeUndefined();
    expect(capabilityForChannel(dvm, "constructor", "x402")).toBeUndefined();
  });

  it("refuses a duplicate name within a channel", () => {
    expect(() => configureDVM({
      name: "example",
      capabilities: { fetch: { onJob }, other: { name: "fetch", onJob } },
    })).toThrow('two capabilities are named "fetch" on the dvmkit protocol');
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: {
        a: { name: "fetch", channels: { x402: {} }, maxRuntimeSeconds: 5, onJob },
        b: { name: "fetch", channels: { job: true, x402: {} }, maxRuntimeSeconds: 5, onJob },
      },
    })).toThrow('two capabilities are named "fetch" on the x402 channel');
  });

  it("refuses a channels declaration that offers nothing", () => {
    for (const channels of [{}, { job: false }]) {
      expect(() => configureDVM({ name: "example", capabilities: { fetch: { channels, onJob } } }))
        .toThrow('capability "fetch" channels must offer at least one channel');
    }
  });

  it("requires maxRuntimeSeconds and x402 configuration on the x402 channel", () => {
    expect(() => withX402({ maxRuntimeSeconds: undefined }))
      .toThrow('capability "fetch" is offered on x402 and must set maxRuntimeSeconds (1 to 600)');
    expect(() => configureDVM({
      name: "example",
      capabilities: { fetch: { channels: { job: true, x402: {} }, maxRuntimeSeconds: 5, onJob } },
    })).toThrow('capability "fetch" is offered on x402 but the DVM has no x402 configuration');
  });

  it("refuses a listing on a capability not offered on x402", () => {
    const listing = scrapeListing;
    expect(() => configureDVM({
      name: "example",
      // @ts-expect-error a listing is not a channel
      capabilities: { fetch: { channels: { job: true, listing }, onJob } },
    })).toThrow('capability "fetch" channels.listing is not a channel; a listing belongs under channels.x402.listing');
    expect(() => configureDVM({
      name: "example",
      // @ts-expect-error a listing is not a capability field
      capabilities: { fetch: { listing, onJob } },
    })).toThrow('capability "fetch" declares listing outside channels.x402');
  });

  it("refuses an x402 name that is not path-safe", () => {
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: { a: { name: "../info", channels: { x402: {} }, maxRuntimeSeconds: 5, onJob } },
    })).toThrow('invalid capability name "../info"');
  });

  it("refuses a listing example the definition's input rejects", () => {
    expect(() => withX402({}, { ...scrapeListing, example: { url: "not a url" } }))
      .toThrow(/capability "fetch" channels\.x402\.listing\.example does not satisfy its input schema.*url/);
  });

  describe("listing limits", () => {
    const cases: [string, Partial<X402Listing> & Record<string, unknown>, string][] = [
      ["description", { description: "x".repeat(501) }, "description is 501 characters; the limit is 500"],
      ["serviceName", { serviceName: "x".repeat(33) }, "serviceName must be 1 to 32 printable ASCII"],
      ["serviceName", { serviceName: "café" }, "serviceName must be 1 to 32 printable ASCII"],
      ["tags", { tags: ["a", "b", "c", "d", "e", "f"] }, "tags must be an array of at most 5 tags"],
      ["tags", { tags: ["x".repeat(33)] }, "tags[0] must be 1 to 32 printable ASCII"],
      ["tags", { tags: ["Web", "web"] }, "tags[1] repeats"],
      ["iconUrl", { iconUrl: `https://example.com/${"x".repeat(2048)}.png` }, "iconUrl must be an http or https URL of at most 2048"],
      ["iconUrl", { iconUrl: "https://203.0.113.7/icon.png" }, "iconUrl must name a DNS host, not an IP address literal"],
      ["iconUrl", { iconUrl: "https://[2001:db8::1]/icon.png" }, "iconUrl must name a DNS host, not an IP address literal"],
      ["iconUrl", { iconUrl: "https://example.com/icon.svg" }, "iconUrl must not be an SVG image"],
      ["iconUrl", { iconUrl: "https://localhost/icon.png" }, "iconUrl must not name a loopback host"],
      ["iconUrl", { iconUrl: "data:image/png;base64,AAAA" }, "iconUrl must be an http or https URL"],
      ["inputSchema", { inputSchema: { $ref: "https://example.com/schema.json" } }, 'inputSchema has $ref "https://example.com/schema.json"'],
      ["inputSchema", { inputSchema: { properties: { a: { $id: "urn:x" } } } }, 'inputSchema has $id "urn:x" at /properties/a'],
      ["example", { example: { url: "https://example.com", nonce: "n" } }, 'example must not carry the signed-request field "nonce"'],
      ["resourceUrl", { resourceUrl: "/v1/x402/fetch" }, "resourceUrl must be an absolute http or https URL"],
    ];
    it.each(cases)("refuses %s outside its limit", (_field, patch, message) => {
      expect(() => withX402({}, { ...scrapeListing, ...patch }))
        .toThrow(`capability "fetch" channels.x402.listing.${message}`);
    });

    it("accepts values at the limits", () => {
      expect(() => withX402({}, {
        ...scrapeListing,
        description: "x".repeat(500),
        serviceName: "x".repeat(32),
        tags: ["a", "b", "c", "d", "x".repeat(32)],
        iconUrl: "https://cdn.example.com/icon.png",
        inputSchema: { type: "object", $defs: { u: { type: "string" } }, properties: { url: { $ref: "#/$defs/u" } } },
      })).not.toThrow();
    });

    it("refuses a listing whose PAYMENT-REQUIRED header exceeds 8 KiB", () => {
      const outputExample = { text: "x".repeat(6000) };
      expect(() => withX402({}, { ...scrapeListing, outputExample }))
        .toThrow(/capability "fetch" channels\.x402\.listing makes the encoded PAYMENT-REQUIRED header \d+ bytes, over the 8192-byte limit/);
      expect(() => withX402({}, { ...scrapeListing, outputExample: { text: "x".repeat(4000) } })).not.toThrow();
    });
  });

  describe("signed-request fields", () => {
    const auth = secp256k1Auth({ replayStore: null });
    const envelope = { pubkey: z.string(), signature: z.string(), timestamp: z.number(), nonce: z.string() };
    const optionalEnvelope = {
      pubkey: z.string().optional(), signature: z.string().optional(),
      timestamp: z.number().optional(), nonce: z.string().optional(),
    };

    it("does not require them on an x402-only definition", () => {
      expect(() => configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: {
          fetch: { input: z.object({ url: z.string(), ...envelope }), onJob },
          "fetch-x402": {
            name: "fetch",
            channels: { x402: { listing: scrapeListing } },
            input: z.object({ url: z.string() }),
            maxRuntimeSeconds: 10,
            onJob,
          },
        },
      })).not.toThrow();
    });

    it("refuses them on an x402-only definition", () => {
      expect(() => configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: {
          fetch: { input: z.object({ url: z.string(), ...envelope }), onJob },
          other: { channels: { x402: {} }, input: z.object({ pubkey: z.string() }), maxRuntimeSeconds: 10, onJob },
        },
      })).toThrow('capability "other" is offered on x402 only, whose callers are unsigned, but its input schema declares the signed-request field "pubkey"');
    });

    it("still requires them for /v1/job on a definition offered on both channels", () => {
      const both = (input: z.ZodType) => () => configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: { fetch: { channels: { job: true, x402: {} }, input, maxRuntimeSeconds: 10, onJob } },
      });
      expect(both(z.object({ url: z.string() })))
        .toThrow('capability "fetch" input schema must preserve signed envelope fields: pubkey, signature, timestamp, nonce');
      expect(both(z.object({ url: z.string(), ...envelope })))
        .toThrow('signed-request field "pubkey" must be optional');
      expect(both(z.object({ url: z.string(), ...optionalEnvelope }))).not.toThrow();
      expect(both(z.looseObject({ url: z.string() }))).not.toThrow();
    });
  });
});
