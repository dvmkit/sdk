/**
 * x402 Bazaar discovery declaration for capabilities offered on the x402
 * channel. Mirrors upstream `declareDiscoveryExtension` for an HTTP body
 * resource (`@x402/extensions`, `bazaar/http/resourceService.ts`), with the
 * request-time enrichment upstream's middleware would add folded in, because
 * dvmkit builds its 402 by hand and that middleware never runs.
 */
import { toJSONSchema, type z } from "zod";

import { CAPABILITY_SIGNED_FIELDS } from "../../sdk/signed-envelope-schema";
import type { X402Listing } from "../../sdk/types";
import { encodePaymentRequiredHeader, type PaymentRequiredV2, type ResourceInfo } from "./spec";

/** Path prefix of the x402 channel route; the capability name follows it. */
export const X402_CHANNEL_PATH_PREFIX = "/v1/x402/";

/** Longest resource description the facilitator verifies and settles. */
export const X402_LISTING_DESCRIPTION_MAX = 500;

/**
 * Largest base64 `PAYMENT-REQUIRED` header the SDK emits. Common proxies and
 * servers cap a request header near 8 KiB, and a paying client echoes the
 * resource and extensions back in `PAYMENT-SIGNATURE`.
 */
export const X402_PAYMENT_REQUIRED_MAX_BYTES = 8192;

// Upstream's facilitator limits (`sanitizeResourceServiceMetadata`). It drops
// a value outside them silently, so the SDK refuses them at start instead.
export const X402_SERVICE_NAME_MAX = 32;
export const X402_TAG_MAX = 32;
export const X402_TAGS_MAX = 5;
export const X402_ICON_URL_MAX = 2048;

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

/** The bazaar extension: discovery `info` and the JSON Schema it satisfies. */
export interface X402BazaarExtension {
  info: {
    input: {
      type: "http";
      method: "POST";
      bodyType: "json";
      body: Record<string, unknown>;
    };
    output?: { type: "json"; example: Record<string, unknown> };
  };
  schema: Record<string, unknown>;
}

/** The parts of a `PAYMENT-REQUIRED` declaration a listing contributes. */
export interface X402Discovery {
  /**
   * Complete v2 resource object, including the service metadata that
   * `paymentRequiredV2FromV1` does not copy.
   */
  resource: ResourceInfo;
  extensions: { bazaar: X402BazaarExtension };
}

/** Path of the x402 channel route for a capability name. */
export function x402ChannelPath(name: string): string {
  return `${X402_CHANNEL_PATH_PREFIX}${name}`;
}

/**
 * The flat JSON Schema an x402 caller's request body must satisfy: the
 * capability's Zod input schema in input mode, without the signed-request
 * fields, which an unsigned x402 caller never sends.
 */
export function x402BodySchema(input: unknown): Record<string, unknown> {
  if (!isZodLike(input)) return { type: "object" };
  const schema = toJSONSchema(input as z.ZodType, { io: "input" }) as Record<string, unknown>;
  // The dialect belongs on the extension's root schema, not on a subschema.
  delete schema.$schema;
  const properties = schema.properties;
  if (isRecord(properties)) {
    const kept = { ...properties };
    for (const field of CAPABILITY_SIGNED_FIELDS) delete kept[field];
    schema.properties = kept;
  }
  if (Array.isArray(schema.required)) {
    const signed = new Set<string>(CAPABILITY_SIGNED_FIELDS);
    schema.required = (schema.required as unknown[]).filter(
      (field) => typeof field !== "string" || !signed.has(field)
    );
  }
  return schema;
}

/** Inputs for {@link buildX402Discovery}. */
export interface BuildX402DiscoveryOpts {
  /** Published capability name. */
  name: string;
  listing: X402Listing;
  /** Default body schema, normally {@link x402BodySchema} of the definition's input. */
  bodySchema: Record<string, unknown>;
  /** Public origin, such as `https://dvm.example.com`, used when `listing.resourceUrl` is unset. */
  publicOrigin: string;
}

/** Build the resource object and bazaar extension for one listed capability. */
export function buildX402Discovery(opts: BuildX402DiscoveryOpts): X402Discovery {
  const { listing } = opts;
  const body = listing.inputSchema ?? opts.bodySchema;
  const url = listing.resourceUrl ?? `${opts.publicOrigin.replace(/\/+$/, "")}${x402ChannelPath(opts.name)}`;
  const resource: ResourceInfo = {
    url,
    description: listing.description,
    mimeType: "application/json",
    ...(listing.serviceName !== undefined ? { serviceName: listing.serviceName } : {}),
    ...(listing.tags !== undefined ? { tags: [...listing.tags] } : {}),
    ...(listing.iconUrl !== undefined ? { iconUrl: listing.iconUrl } : {}),
  };
  const output = listing.outputExample;
  const bazaar: X402BazaarExtension = {
    info: {
      input: { type: "http", method: "POST", bodyType: "json", body: listing.example },
      ...(output !== undefined ? { output: { type: "json", example: output } } : {}),
    },
    schema: {
      $schema: JSON_SCHEMA_DIALECT,
      type: "object",
      properties: {
        input: {
          type: "object",
          properties: {
            type: { type: "string", const: "http" },
            method: { type: "string", enum: ["POST"] },
            bodyType: { type: "string", enum: ["json"] },
            body,
          },
          required: ["type", "method", "bodyType", "body"],
          additionalProperties: false,
        },
        ...(output !== undefined
          ? {
              output: {
                type: "object",
                properties: { type: { type: "string" }, example: { type: "object" } },
                required: ["type"],
              },
            }
          : {}),
      },
      required: ["input"],
    },
  };
  return { resource, extensions: { bazaar } };
}

/** Encoded size, in bytes, of a `PAYMENT-REQUIRED` header carrying `required`. */
export function encodedPaymentRequiredBytes(required: PaymentRequiredV2): number {
  return encodePaymentRequiredHeader(required).length;
}

/** Throw when `required` would encode to a `PAYMENT-REQUIRED` header over the limit. */
export function assertPaymentRequiredFits(name: string, required: PaymentRequiredV2): void {
  const bytes = encodedPaymentRequiredBytes(required);
  if (bytes > X402_PAYMENT_REQUIRED_MAX_BYTES) {
    throw new Error(
      `capability ${JSON.stringify(name)} channels.x402.listing makes the encoded PAYMENT-REQUIRED ` +
        `header ${bytes} bytes, over the ${X402_PAYMENT_REQUIRED_MAX_BYTES}-byte limit; shorten the ` +
        "description, example, outputExample or input schema"
    );
  }
}

/**
 * Refuse listing metadata the facilitator would reject or silently drop. Runs
 * on `unknown` values because JavaScript builders bypass the declared type.
 * `bodySchema` is the default body schema the listing would publish.
 */
export function assertX402Listing(
  name: string,
  listing: unknown,
  bodySchema: Record<string, unknown>
): void {
  const at = `capability ${JSON.stringify(name)} channels.x402.listing`;
  const refuse = (detail: string): never => {
    throw new Error(`${at}.${detail}`);
  };
  if (!isRecord(listing)) throw new Error(`${at} must be an object`);

  const description = listing.description;
  if (typeof description !== "string" || description.trim() === "") {
    refuse("description must be a non-empty string");
  }
  if ((description as string).length > X402_LISTING_DESCRIPTION_MAX) {
    refuse(
      `description is ${(description as string).length} characters; the limit is ` +
        `${X402_LISTING_DESCRIPTION_MAX}, above which the facilitator refuses to verify or settle the payment`
    );
  }

  const example = listing.example;
  if (!isRecord(example)) refuse("example must be a JSON object of the capability input");
  for (const field of CAPABILITY_SIGNED_FIELDS) {
    if (Object.hasOwn(example as object, field)) {
      refuse(`example must not carry the signed-request field ${JSON.stringify(field)}; x402 callers are unsigned`);
    }
  }
  if (listing.outputExample !== undefined && !isRecord(listing.outputExample)) {
    refuse("outputExample must be a JSON object");
  }

  if (listing.inputSchema !== undefined) {
    if (!isRecord(listing.inputSchema)) refuse("inputSchema must be a JSON Schema object");
    const properties = (listing.inputSchema as Record<string, unknown>).properties;
    if (isRecord(properties)) {
      for (const field of CAPABILITY_SIGNED_FIELDS) {
        if (Object.hasOwn(properties, field)) {
          refuse(`inputSchema must not declare the signed-request field ${JSON.stringify(field)}; x402 callers are unsigned`);
        }
      }
    }
  }
  const schema = (listing.inputSchema as Record<string, unknown> | undefined) ?? bodySchema;
  const field = listing.inputSchema !== undefined ? "inputSchema" : "input schema";
  const external = externalSchemaReference(schema, "");
  if (external) {
    refuse(
      `${field} has ${external.key} ${JSON.stringify(external.value)} at ${external.path || "(root)"}; ` +
        "every $ref and $id must be a local reference starting with \"#\""
    );
  }
  if (listing.serviceName !== undefined) {
    const value = listing.serviceName;
    if (typeof value !== "string" || value.length === 0 || value.length > X402_SERVICE_NAME_MAX || !PRINTABLE_ASCII.test(value)) {
      refuse(`serviceName must be 1 to ${X402_SERVICE_NAME_MAX} printable ASCII characters (got ${JSON.stringify(value)})`);
    }
  }

  if (listing.tags !== undefined) {
    const tags = listing.tags;
    if (!Array.isArray(tags) || tags.length > X402_TAGS_MAX) {
      refuse(`tags must be an array of at most ${X402_TAGS_MAX} tags`);
    }
    const seen = new Set<string>();
    (tags as unknown[]).forEach((tag, i) => {
      if (typeof tag !== "string" || tag.length === 0 || tag.length > X402_TAG_MAX || !PRINTABLE_ASCII.test(tag)) {
        refuse(`tags[${i}] must be 1 to ${X402_TAG_MAX} printable ASCII characters (got ${JSON.stringify(tag)})`);
      }
      const key = (tag as string).toLowerCase();
      if (seen.has(key)) refuse(`tags[${i}] repeats ${JSON.stringify(tag)}; tags are compared case-insensitively`);
      seen.add(key);
    });
  }

  if (listing.iconUrl !== undefined) {
    const problem = iconUrlProblem(listing.iconUrl);
    if (problem) refuse(`iconUrl ${problem}`);
  }

  if (listing.resourceUrl !== undefined) {
    if (!isAbsoluteHttpUrl(listing.resourceUrl)) {
      refuse(`resourceUrl must be an absolute http or https URL (got ${JSON.stringify(listing.resourceUrl)})`);
    }
  }
}

function iconUrlProblem(value: unknown): string | undefined {
  const limit = `must be an http or https URL of at most ${X402_ICON_URL_MAX} characters`;
  if (typeof value !== "string" || value.length === 0 || value.length > X402_ICON_URL_MAX) return limit;
  if (CONTROL_CHARS.test(value)) return `${limit} without control characters`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return limit;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return limit;
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  const host = url.hostname.toLowerCase();
  if (
    url.host.startsWith("[") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    /^\d+$/.test(host) ||
    /^0x[0-9a-f]+$/.test(host)
  ) {
    return "must name a DNS host, not an IP address literal";
  }
  if (LOOPBACK_HOSTNAMES.has(host)) return "must not name a loopback host";
  if (url.pathname.toLowerCase().endsWith(".svg")) return "must not be an SVG image";
  return undefined;
}

function externalSchemaReference(
  node: unknown,
  path: string
): { key: string; value: unknown; path: string } | undefined {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const found = externalSchemaReference(node[i], `${path}/${i}`);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(node)) return undefined;
  for (const [key, value] of Object.entries(node)) {
    if ((key === "$ref" || key === "$id") && (typeof value !== "string" || !value.startsWith("#"))) {
      return { key, value, path };
    }
    const found = externalSchemaReference(value, `${path}/${key}`);
    if (found) return found;
  }
  return undefined;
}

function isAbsoluteHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isZodLike(value: unknown): boolean {
  return typeof value === "object" && value !== null && "_zod" in value && "safeParse" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
