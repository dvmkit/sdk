import { extractDiscoveryInfo, validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildX402Discovery } from "../../lib/x402/bazaar";
import { capabilityForChannel } from "../capability-channels";
import { configureDVM } from "../configure";
import { secp256k1Auth } from "../server/secp256k1-auth";
import type { CapabilityConfig, DVMDescriptor, X402Listing } from "../types";

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
        price: "$0.01",
        maxRuntimeSeconds: 15,
        channels: { job: false, x402: { listing: listing as X402Listing } },
        onJob,
        ...overrides,
      },
    },
  });
}

/**
 * Every listing a booted DVM declares must pass upstream's own validation and
 * extraction; a listing that fails either is silently dropped from catalogs.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function expectListingsAcceptedUpstream(dvm: DVMDescriptor<any, any>): void {
  const listed = Object.values(dvm.x402Capabilities ?? {}).filter((def) => def.channels.x402?.listing);
  expect(listed.length).toBeGreaterThan(0);
  for (const def of listed) {
    const listing = def.channels.x402!.listing!;
    const discovery = buildX402Discovery({ name: def.name, listing, input: def.input, publicOrigin: "https://dvm.example.com" });
    expect(validateDiscoveryExtension(discovery.extensions.bazaar as never)).toEqual({ valid: true });
    const accepted = { scheme: "exact", network: x402.network, amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: x402.payTo, maxTimeoutSeconds: 60, extra: {} };
    const payload = { x402Version: 2, resource: discovery.resource, accepted, payload: {}, extensions: discovery.extensions };
    expect(extractDiscoveryInfo(payload as never, accepted as never)?.discoveryInfo).toMatchObject({
      input: { body: listing.example },
    });
  }
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
          channels: { job: false, x402: {} },
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
      capabilities: { fetch: { channels: { job: true, x402: {} }, price: "$0.01", maxRuntimeSeconds: 10, onJob } },
    });
    const flat = configureDVM({
      name: "example", x402, capability: "fetch", channels: { job: true, x402: {} }, price: "$0.01", maxRuntimeSeconds: 10, onJob,
    });
    for (const dvm of [explicit, flat]) {
      const job = capabilityForChannel(dvm, "fetch", "job");
      expect(job).toBeDefined();
      expect(capabilityForChannel(dvm, "fetch", "x402")).toBe(job);
    }
  });

  it("does not resolve prototype member names", () => {
    const dvm = withX402();
    expectListingsAcceptedUpstream(dvm);
    expect(capabilityForChannel(dvm, "constructor", "job")).toBeUndefined();
    expect(capabilityForChannel(dvm, "constructor", "x402")).toBeUndefined();
  });

  it("refuses a duplicate name within a channel", () => {
    expect(() => configureDVM({
      name: "example",
      capabilities: { fetch: { onJob }, other: { name: "fetch", onJob } },
    })).toThrow('two capabilities are named "fetch" on the dvmkit protocol (entries "fetch" and "other")');
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: {
        echo: { onJob },
        a: { name: "fetch", channels: { job: false, x402: {} }, price: "$0.01", maxRuntimeSeconds: 5, onJob },
        b: { name: "fetch", channels: { job: true, x402: {} }, price: "$0.01", maxRuntimeSeconds: 5, onJob },
      },
    })).toThrow('two capabilities are named "fetch" on the x402 channel (entries "a" and "b")');
  });

  it("refuses a channels declaration that offers nothing", () => {
    for (const channels of [{}, { job: false }]) {
      expect(() => configureDVM({ name: "example", capabilities: { fetch: { channels, onJob } } }))
        .toThrow('capability "fetch" channels must offer at least one channel');
    }
  });

  it("requires job to be stated whenever x402 is declared", () => {
    // Adding x402 must not silently take a capability off /v1/job.
    for (const channels of [{ x402: {} }, { x402: { listing: scrapeListing } }]) {
      expect(() => configureDVM({
        name: "example",
        x402,
        capabilities: { echo: { onJob }, fetch: { channels, price: "$0.01", maxRuntimeSeconds: 5, onJob } },
      })).toThrow(
        'capability "fetch" channels declares x402 without job; set job: true to keep it on /v1/job, or job: false for x402 only'
      );
    }
  });

  it("refuses an x402 definition whose amount is unknown before the handler runs", () => {
    const boot = (pricing: Pick<CapabilityConfig, "rates" | "onQuote">) => () => configureDVM({
      name: "example",
      x402,
      capabilities: { echo: { onJob }, fetch: { channels: { job: true, x402: {} }, maxRuntimeSeconds: 5, onJob, ...pricing } },
    });
    expect(boot({})).toThrow('capability "fetch" is offered on x402 but is free; an x402 caller pays before the handler runs');
    expect(boot({ rates: [{ label: "page", amount: "0.01", currency: "USD", per: "page" }] }))
      .toThrow('capability "fetch" is offered on x402 and priced only by rates');
    expect(boot({ onQuote: { schema: {}, handler: () => Promise.resolve({ upfront: { amount: 0.01, currency: "usd" }, description: "One page." }) } })).not.toThrow();
  });

  it("requires x402 in an explicit paymentMethods list", () => {
    const boot = (paymentMethods: ("cashu" | "x402")[]) => () => configureDVM({
      name: "example",
      x402,
      paymentMethods,
      capabilities: { echo: { onJob }, fetch: { channels: { job: true, x402: {} }, price: "$0.01", maxRuntimeSeconds: 5, onJob } },
    });
    expect(boot(["cashu"])).toThrow(
      'capability "fetch" is offered on x402 but paymentMethods (["cashu"]) leaves out "x402"'
    );
    expect(boot(["cashu", "x402"])).not.toThrow();
  });

  it("names the entry when its published name differs", () => {
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: {
        fetch: { onJob },
        "fetch-x402": { name: "fetch", channels: { job: false, x402: {} }, price: "$0.01", onJob },
      },
    })).toThrow('capability "fetch" (entry "fetch-x402") is offered on x402 and must set maxRuntimeSeconds');
  });

  it("refuses a data field named like a signed-request field on a DVM without auth", () => {
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: {
        f: { channels: { job: true, x402: {} }, input: z.object({ timestamp: z.number() }), price: "$0.01", maxRuntimeSeconds: 5, onJob },
      },
    })).toThrow(
      'capability "f" is offered on x402, whose callers are unsigned, and its input schema declares a field named "timestamp", which x402 reserves'
    );
  });

  it("freezes the listing so it cannot change after boot", () => {
    const listing = { ...scrapeListing, tags: ["web"], outputExample: { text: { lang: "en" } } };
    const dvm = withX402({}, listing);
    expectListingsAcceptedUpstream(dvm);
    const booted = dvm.x402Capabilities!.fetch.channels.x402!.listing!;
    expect(() => (booted.tags as string[]).push("search")).toThrow(TypeError);
    expect(() => { (booted.outputExample!.text as Record<string, unknown>).lang = "fr"; }).toThrow(TypeError);
    // The builder's own object stays theirs to change.
    listing.tags.push("search");
    expect(booted.tags).toEqual(["web"]);
  });

  it("refuses a DVM offered only on x402 as a current limitation", () => {
    expect(() => configureDVM({
      name: "example",
      x402,
      capabilities: { fetch: { channels: { job: false, x402: {} }, price: "$0.01", maxRuntimeSeconds: 5, onJob } },
    })).toThrow("A DVM offered only on x402 is not supported yet; this is a current limitation of the SDK.");
  });

  it("requires maxRuntimeSeconds and x402 configuration on the x402 channel", () => {
    expect(() => withX402({ maxRuntimeSeconds: undefined }))
      .toThrow('capability "fetch" is offered on x402 and must set maxRuntimeSeconds (1 to 600)');
    expect(() => configureDVM({
      name: "example",
      capabilities: { fetch: { channels: { job: true, x402: {} }, price: "$0.01", maxRuntimeSeconds: 5, onJob } },
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
      capabilities: { a: { name: "../info", channels: { job: false, x402: {} }, maxRuntimeSeconds: 5, onJob } },
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

    it("accepts values at the limits, in a listing upstream accepts", () => {
      expectListingsAcceptedUpstream(withX402({}, {
        ...scrapeListing,
        description: "x".repeat(500),
        serviceName: "x".repeat(32),
        tags: ["a", "b", "c", "d", "x".repeat(32)],
        iconUrl: "https://cdn.example.com/icon.png",
        inputSchema: { type: "object", $defs: { u: { type: "string" } }, properties: { url: { $ref: "#/$defs/u" } } },
      }));
    });

    it("boots listings with local references that upstream accepts", () => {
      const Url = z.string().url().meta({ id: "Url" });
      expectListingsAcceptedUpstream(withX402(
        { input: z.object({ url: Url, canonical: Url.optional() }) },
        { ...scrapeListing, example: { url: "https://example.com", canonical: "https://example.com/a" } }
      ));
      const Node: z.ZodType = z.object({ name: z.string(), get children() { return z.array(Node).optional(); } });
      expectListingsAcceptedUpstream(withX402(
        { input: Node },
        { description: "Walk a tree.", example: { name: "a", children: [{ name: "b", children: [{ name: "c" }] }] } }
      ));
    });

    it("treats keyword-named properties as subschemas, not data", () => {
      // Under properties and $defs, `default`, `enum`, `const` and `examples`
      // are names, so the references inside them must be moved too.
      expectListingsAcceptedUpstream(withX402({}, {
        ...scrapeListing,
        inputSchema: {
          type: "object",
          $defs: { u: { type: "string" }, default: { $ref: "#/$defs/u" } },
          properties: { url: { $ref: "#/$defs/default" }, default: { $ref: "#/$defs/u" } },
          // Draft-07 `dependencies` maps property names to subschemas too.
          dependencies: { default: { properties: { default: { $ref: "#/$defs/u" } } } },
        },
      }));
      const Url = z.string().url().meta({ id: "Url" });
      expectListingsAcceptedUpstream(withX402(
        { input: z.object({ default: Url, other: Url }) },
        { ...scrapeListing, example: { default: "https://example.com", other: "https://example.org" } }
      ));
    });

    it("refuses a dangling reference under a property named like a keyword", () => {
      expect(() => withX402({}, { ...scrapeListing, inputSchema: { type: "object", properties: { examples: { $ref: "#/$defs/missing" } } } }))
        .toThrow('inputSchema has $ref "#/$defs/missing" at /properties/examples, which names nothing');
    });

    it("refuses an inputSchema whose references cannot resolve once nested", () => {
      expect(() => withX402({}, { ...scrapeListing, inputSchema: { type: "object", properties: { url: { $ref: "#/$defs/missing" } } } }))
        .toThrow('capability "fetch" channels.x402.listing.inputSchema has $ref "#/$defs/missing" at /properties/url, which names nothing');
      expect(() => withX402({}, { ...scrapeListing, inputSchema: { type: "object", properties: { url: { $ref: "#absent" } } } }))
        .toThrow('inputSchema has $ref "#absent" at /properties/url, which names nothing');
      expect(() => withX402({}, { ...scrapeListing, inputSchema: { $id: "#", type: "object" } }))
        .toThrow('capability "fetch" channels.x402.listing.inputSchema has $id at (root)');
    });

    it("lets an inputSchema stand in for an input Zod cannot convert", () => {
      const input = z.object({ url: z.string().url(), since: z.date().optional() });
      const inputSchema = { type: "object", properties: { url: { type: "string" } }, required: ["url"] };
      expectListingsAcceptedUpstream(withX402({ input }, { ...scrapeListing, inputSchema }));
      expect(() => withX402({ input }))
        .toThrow(/capability "fetch" input cannot be published as the x402 listing's JSON Schema \(Date cannot be represented in JSON Schema\); set channels\.x402\.listing\.inputSchema/);
    });
  });

  describe("PAYMENT-REQUIRED size", () => {
    // The x402 header a common proxy accepts is 8 KiB; the paid retry echoes
    // the resource and extensions in PAYMENT-SIGNATURE beside a signed
    // authorization, so the largest listing that boots must still leave that
    // echo under 8 KiB.
    const boots = (n: number) => {
      try {
        withX402({}, { ...scrapeListing, outputExample: { text: "x".repeat(n) } });
        return true;
      } catch {
        return false;
      }
    };
    let lo = 0;
    let hi = 8192;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (boots(mid)) lo = mid;
      else hi = mid;
    }
    const largest = lo;

    it("refuses one byte past the 7168-byte limit", () => {
      expectListingsAcceptedUpstream(withX402({}, { ...scrapeListing, outputExample: { text: "x".repeat(largest) } }));
      let message = "";
      try {
        withX402({}, { ...scrapeListing, outputExample: { text: "x".repeat(largest + 1) } });
      } catch (err) {
        message = (err as Error).message;
      }
      const bytes = Number(/header (\d+) bytes, over the 7168-byte limit/.exec(message)?.[1]);
      // base64 grows in 4-character steps.
      expect(bytes).toBeGreaterThan(7168);
      expect(bytes).toBeLessThanOrEqual(7172);
    });

    it("leaves the paid retry's PAYMENT-SIGNATURE echo under 8 KiB", () => {
      const listing = { ...scrapeListing, outputExample: { text: "x".repeat(largest) } };
      const discovery = buildX402Discovery({
        name: "fetch", listing, input: z.object({ url: z.string().url() }), publicOrigin: `https://${"x".repeat(100)}.example.com`,
      });
      const signature = {
        x402Version: 2,
        resource: discovery.resource,
        accepted: {
          scheme: "exact", network: x402.network, amount: "18446744073709551615",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: x402.payTo, maxTimeoutSeconds: 3600,
          extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
        },
        payload: {
          signature: `0x${"a".repeat(130)}`,
          authorization: {
            from: `0x${"b".repeat(40)}`, to: x402.payTo, value: "18446744073709551615",
            validAfter: "1767225600", validBefore: "1767229200", nonce: `0x${"c".repeat(64)}`,
          },
        },
        extensions: discovery.extensions,
      };
      expect(Buffer.from(JSON.stringify(signature)).toString("base64").length).toBeLessThanOrEqual(8192);
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
      expectListingsAcceptedUpstream(configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: {
          fetch: { input: z.object({ url: z.string(), ...envelope }), onJob },
          "fetch-x402": {
            name: "fetch",
            channels: { job: false, x402: { listing: scrapeListing } },
            input: z.object({ url: z.string() }),
            price: "$0.01",
            maxRuntimeSeconds: 10,
            onJob,
          },
        },
      }));
    });

    it("refuses them on an x402-only definition", () => {
      expect(() => configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: {
          fetch: { input: z.object({ url: z.string(), ...envelope }), onJob },
          other: { channels: { job: false, x402: {} }, input: z.object({ pubkey: z.string() }), price: "$0.01", maxRuntimeSeconds: 10, onJob },
        },
      })).toThrow('capability "other" is offered on x402 only, whose callers are unsigned, but its input schema declares the signed-request field "pubkey"');
    });

    it("still requires them for /v1/job on a definition offered on both channels", () => {
      const both = (input: z.ZodType) => () => configureDVM({
        name: "example",
        auth,
        x402,
        capabilities: { fetch: { channels: { job: true, x402: {} }, input, price: "$0.01", maxRuntimeSeconds: 10, onJob } },
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
