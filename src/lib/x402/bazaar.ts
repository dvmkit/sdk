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
import {
  buildPaymentRequirements,
  encodePaymentRequiredHeader,
  paymentRequiredV2FromV1,
  type PaymentRequiredV2,
  type ResourceInfo,
  X402_V1_VERSION,
} from "./spec";
import type { X402Config } from "./types";

/** Path prefix of the x402 channel route; the capability name follows it. */
export const X402_CHANNEL_PATH_PREFIX = "/v1/x402/";

/** Longest resource description the facilitator verifies and settles. */
export const X402_LISTING_DESCRIPTION_MAX = 500;

/**
 * Largest base64 `PAYMENT-REQUIRED` header a listing may produce: 8 KiB, a
 * common proxy and server cap on one header, less 1 KiB because the paid
 * retry echoes the resource and extensions back in `PAYMENT-SIGNATURE` with
 * one accept and its signed authorization in place of the full accepts list
 * and `error`.
 */
export const X402_PAYMENT_REQUIRED_MAX_BYTES = 8192 - 1024;

// Upstream's facilitator limits (`sanitizeResourceServiceMetadata`). It drops
// a value outside them silently, so the SDK refuses them at start instead.
export const X402_SERVICE_NAME_MAX = 32;
export const X402_TAG_MAX = 32;
export const X402_TAGS_MAX = 5;
export const X402_ICON_URL_MAX = 2048;

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
// Where the body schema sits inside the extension schema. Upstream compiles
// the extension schema as one document, so a `#`-rooted pointer in the body
// resolves against the extension root unless it is moved here.
const BODY_SCHEMA_POINTER = "#/properties/input/properties/body";
// Keywords whose values are instance data, not subschemas: a `$ref` key
// inside them is data and is neither rewritten nor resolved. They are
// keywords only in a schema; under a name map they are names.
const DATA_KEYWORDS = new Set(["const", "enum", "default", "examples"]);
// Keywords whose value maps names to subschemas, so each key is a name (which
// may be spelled like a keyword, such as a property named `default`).
const NAME_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]);
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
 * Address of a capability's x402 route: the public origin, then the path a
 * host mounted the server under (`""` at the root), then the route's path.
 */
export function x402RouteUrl(publicOrigin: string, mountPrefix: string, name: string): string {
  return `${publicOrigin.replace(/\/+$/, "")}${mountPrefix}${x402ChannelPath(name)}`;
}

/**
 * The mount prefix a route path's base names, less one trailing slash, which
 * is what Hono drops when it joins a mount to its routes: a root mount `/`
 * serves `/v1/...`, `/feed/` serves `/feed/v1/...`, and `/feed//` serves
 * `/feed//v1/...`.
 */
export function x402MountPrefix(base: string | undefined): string {
  return (base ?? "").replace(/\/$/, "");
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
  /**
   * The definition's input schema. Converted with {@link x402BodySchema} only
   * when `listing.inputSchema` is unset, so an override can stand in for an
   * input Zod cannot express as JSON Schema.
   */
  input: unknown;
  /** Public origin, such as `https://dvm.example.com`, used when `listing.resourceUrl` is unset. */
  publicOrigin: string;
  /** Path the host mounted the server under, such as `/feed`; see {@link x402RouteUrl}. */
  mountPrefix?: string;
}

/** Build the resource object and bazaar extension for one listed capability. */
export function buildX402Discovery(opts: BuildX402DiscoveryOpts): X402Discovery {
  const { listing } = opts;
  const body = nestBodySchema(listing.inputSchema ?? x402BodySchema(opts.input));
  const url = listing.resourceUrl ?? x402RouteUrl(opts.publicOrigin, opts.mountPrefix ?? "", opts.name);
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

/**
 * Stand-ins for the parts of an x402 channel challenge unknown when it is
 * checked: an origin longer than typical public origins, the largest unsigned
 * 64-bit amount, a four-digit timeout and an `error` longer than any the
 * payment path writes on a 402.
 */
export const X402_SIZE_CHECK_ORIGIN = `https://${"x".repeat(100)}.example.com`;
export const X402_SIZE_CHECK_AMOUNT = 18_446_744_073_709_551_615n;
export const X402_SIZE_CHECK_TIMEOUT_SECONDS = 3600;
export const X402_SIZE_CHECK_ERROR = "x".repeat(256);

/** What one x402 channel challenge is built from. */
export interface X402ChannelPaymentRequiredOpts {
  name: string;
  listing: X402Listing | undefined;
  /** The definition's input schema; see {@link BuildX402DiscoveryOpts.input}. */
  input: unknown;
  x402Config: X402Config;
  publicOrigin: string;
  /** See {@link BuildX402DiscoveryOpts.mountPrefix}. */
  mountPrefix?: string;
  requiredUsdcMicro: bigint;
  maxTimeoutSeconds: number;
  error: string;
}

/**
 * The `PAYMENT-REQUIRED` challenge for one capability on the x402 channel,
 * built the way the payment path builds it: the exact scheme on the
 * configured network, v1 requirements lifted to v2, and, when listed, the
 * listing's resource and discovery extension.
 */
export function x402ChannelPaymentRequired(opts: X402ChannelPaymentRequiredOpts): PaymentRequiredV2 {
  const mountPrefix = opts.mountPrefix ?? "";
  const discovery =
    opts.listing &&
    buildX402Discovery({ name: opts.name, listing: opts.listing, input: opts.input, publicOrigin: opts.publicOrigin, mountPrefix });
  const required = paymentRequiredV2FromV1(
    [
      buildPaymentRequirements({
        x402Config: opts.x402Config,
        requiredUsdcMicro: opts.requiredUsdcMicro,
        // Payment is bound to the route's own address, even when the listing
        // names another resourceUrl for the catalog.
        resource: x402RouteUrl(opts.publicOrigin, mountPrefix, opts.name),
        maxTimeoutSeconds: opts.maxTimeoutSeconds,
        version: X402_V1_VERSION,
      }),
    ],
    opts.error
  );
  return withX402Discovery(required, discovery);
}

/**
 * `required` with a listing's resource and discovery extension, or unchanged
 * without one. The one place a listing reaches a `PAYMENT-REQUIRED`.
 */
export function withX402Discovery(required: PaymentRequiredV2, discovery: X402Discovery | undefined): PaymentRequiredV2 {
  if (!discovery) return required;
  return { ...required, resource: discovery.resource, extensions: { ...required.extensions, ...discovery.extensions } };
}

/** Encoded size, in bytes, of a `PAYMENT-REQUIRED` header carrying `required`. */
export function encodedPaymentRequiredBytes(required: PaymentRequiredV2): number {
  return encodePaymentRequiredHeader(required).length;
}

/**
 * Throw when `required` would encode to a `PAYMENT-REQUIRED` header over the
 * limit. `label` names the capability, such as `capability "fetch"`;
 * `remedy` names what the builder can shorten.
 */
export function assertPaymentRequiredFits(
  label: string,
  required: PaymentRequiredV2,
  remedy = "the description, example, outputExample or input schema"
): void {
  const bytes = encodedPaymentRequiredBytes(required);
  if (bytes > X402_PAYMENT_REQUIRED_MAX_BYTES) {
    throw new Error(
      `${label} channels.x402.listing makes the encoded PAYMENT-REQUIRED header ${bytes} bytes, ` +
        `over the ${X402_PAYMENT_REQUIRED_MAX_BYTES}-byte limit (8 KiB less 1 KiB for the paid ` +
        `retry's PAYMENT-SIGNATURE echo); shorten ${remedy}`
    );
  }
}

/**
 * Refuse listing metadata the facilitator would reject or silently drop. Runs
 * on `unknown` values because JavaScript builders bypass the declared type.
 * `label` names the capability, such as `capability "fetch"`; `input` is the
 * definition's input schema, converted only when `inputSchema` is unset.
 */
export function assertX402Listing(label: string, listing: unknown, input: unknown): void {
  const at = `${label} channels.x402.listing`;
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
  let schema: Record<string, unknown>;
  if (listing.inputSchema !== undefined) {
    schema = listing.inputSchema as Record<string, unknown>;
  } else {
    try {
      schema = x402BodySchema(input);
    } catch (err) {
      throw new Error(
        `${label} input cannot be published as the x402 listing's JSON Schema ` +
          `(${err instanceof Error ? err.message : String(err)}); set ` +
          "channels.x402.listing.inputSchema to the JSON Schema callers should see",
        { cause: err }
      );
    }
  }
  const field = listing.inputSchema !== undefined ? "inputSchema" : "input schema";
  const external = externalSchemaReference(schema, "");
  if (external) {
    refuse(
      `${field} has ${external.key} ${JSON.stringify(external.value)} at ${external.path || "(root)"}; ` +
        "every $ref and $id must be a local reference starting with \"#\""
    );
  }
  const reference = unresolvableSchemaReference(schema);
  if (reference) refuse(`${field} ${reference}`);
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

/**
 * Copy of `body` for nesting at {@link BODY_SCHEMA_POINTER}: JSON-pointer
 * references (`#` and `#/...`) are moved onto the nested location so they
 * still name the body's own subschemas, and a root `$schema`, which belongs
 * only on the extension root, is dropped. `$anchor` references (`#name`)
 * resolve anywhere in the document and are left as they are.
 */
function nestBodySchema(body: Record<string, unknown>): Record<string, unknown> {
  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!isRecord(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if ((key === "$ref" || key === "$dynamicRef") && typeof value === "string" && isPointerReference(value)) {
        out[key] = `${BODY_SCHEMA_POINTER}${value.slice(1)}`;
      } else if (DATA_KEYWORDS.has(key)) {
        out[key] = structuredClone(value);
      } else if (NAME_MAP_KEYWORDS.has(key) && isRecord(value)) {
        out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, rewrite(sub)]));
      } else {
        out[key] = rewrite(value);
      }
    }
    return out;
  };
  const nested = rewrite(body) as Record<string, unknown>;
  delete nested.$schema;
  return nested;
}

/**
 * Why `schema` cannot keep its references once nested, or `undefined`. A
 * `$id` would re-root every reference beneath it, and a pointer or anchor
 * that names nothing makes upstream fail to compile the extension, after
 * which the facilitator drops the listing without saying so.
 */
function unresolvableSchemaReference(schema: Record<string, unknown>): string | undefined {
  const anchors = new Set<string>();
  const refs: { key: string; value: string; path: string }[] = [];
  let id: string | undefined;
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}/${i}`));
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, value] of Object.entries(node)) {
      if (DATA_KEYWORDS.has(key)) continue;
      if (key === "$id" && id === undefined) id = path || "(root)";
      if ((key === "$anchor" || key === "$dynamicAnchor") && typeof value === "string") anchors.add(value);
      if ((key === "$ref" || key === "$dynamicRef") && typeof value === "string") refs.push({ key, value, path });
      if (NAME_MAP_KEYWORDS.has(key) && isRecord(value)) {
        for (const [name, sub] of Object.entries(value)) walk(sub, `${path}/${key}/${name}`);
      } else {
        walk(value, `${path}/${key}`);
      }
    }
  };
  walk(schema, "");
  if (id !== undefined) {
    return (
      `has $id at ${id}; the body schema is nested inside the discovery extension, where $id ` +
      "changes what its references resolve to, so remove it (use $anchor to name a subschema)"
    );
  }
  for (const ref of refs) {
    const resolves = isPointerReference(ref.value)
      ? resolvePointer(schema, ref.value.slice(1)) !== undefined
      : anchors.has(ref.value.slice(1));
    if (!resolves) {
      return `has ${ref.key} ${JSON.stringify(ref.value)} at ${ref.path || "(root)"}, which names nothing in the schema`;
    }
  }
  return undefined;
}

function isPointerReference(ref: string): boolean {
  return ref === "#" || ref.startsWith("#/");
}

/** Resolve an RFC 6901 pointer taken from a URI fragment; `undefined` when it names nothing. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  let node = root;
  for (const raw of pointer.slice(1).split("/")) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(token) && Number(token) < node.length) {
      node = node[Number(token)];
    } else if (isRecord(node) && Object.hasOwn(node, token)) {
      node = node[token];
    } else {
      return undefined;
    }
  }
  return node;
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
