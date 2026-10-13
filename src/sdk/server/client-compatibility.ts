import type { Context, MiddlewareHandler } from "hono";

/** Protocol version spoken by this SDK generation. */
export const DVM_PROTOCOL_VERSION = "1";

/** HTTP headers used by the additive client-compatibility contract. */
export const CLIENT_COMPATIBILITY_HEADERS = {
  client: "DVM-Client",
  protocolVersion: "DVM-Protocol-Version",
  capabilities: "DVM-Client-Capabilities",
} as const;

export interface ClientSemVer {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (string | number)[];
}

export interface ClientCompatibility {
  readonly clientVersion?: ClientSemVer;
  readonly protocolVersion?: number;
  readonly capabilities: readonly string[];
  readonly present: {
    readonly client: boolean;
    readonly protocolVersion: boolean;
    readonly capabilities: boolean;
  };
  readonly valid: {
    readonly client: boolean;
    readonly protocolVersion: boolean;
    readonly capabilities: boolean;
  };
}

export interface ClientCompatibilityRequirement {
  /** Additive capability tokens the caller must advertise. */
  readonly requiredCapabilities?: readonly string[];
  /** Lowest `dvm` SemVer accepted by this endpoint. */
  readonly minimumClientVersion?: string;
}

export type ClientCompatibilityGate = (
  requirement: ClientCompatibilityRequirement
) => MiddlewareHandler<ClientCompatibilityEnv>;

export interface ClientCompatibilityEnv {
  Variables: { clientCompatibility?: ClientCompatibility };
}

/** Parse and validate compatibility headers without trusting them as identity. */
export function parseClientCompatibility(headers: Headers): ClientCompatibility {
  const rawClient = headers.get(CLIENT_COMPATIBILITY_HEADERS.client);
  const rawProtocol = headers.get(CLIENT_COMPATIBILITY_HEADERS.protocolVersion);
  const rawCapabilities = headers.get(CLIENT_COMPATIBILITY_HEADERS.capabilities);
  const clientVersion = rawClient === null ? undefined : parseDvmClient(rawClient);
  const protocolVersion = rawProtocol === null ? undefined : parseProtocolVersion(rawProtocol);
  const capabilities =
    rawCapabilities === null ? undefined : parseClientCapabilities(rawCapabilities);

  return {
    ...(clientVersion ? { clientVersion } : {}),
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    capabilities: capabilities ?? [],
    present: {
      client: rawClient !== null,
      protocolVersion: rawProtocol !== null,
      capabilities: rawCapabilities !== null,
    },
    valid: {
      client: rawClient === null || clientVersion !== undefined,
      protocolVersion: rawProtocol === null || protocolVersion !== undefined,
      capabilities: rawCapabilities === null || capabilities !== undefined,
    },
  };
}

/** Parse the exact `dvm/<semver>` client header. */
export function parseDvmClient(value: string): ClientSemVer | undefined {
  if (!value.startsWith("dvm/")) return undefined;
  return parseSemVer(value.slice(4));
}

/** Parse a canonical non-negative integer protocol version. */
export function parseProtocolVersion(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parse a sorted, unique comma-separated capability list. */
export function parseClientCapabilities(value: string): readonly string[] | undefined {
  if (value === "") return [];
  const tokens = value.split(",");
  if (
    tokens.some((token) => !CAPABILITY_TOKEN_RE.test(token)) ||
    new Set(tokens).size !== tokens.length ||
    tokens.some((token, index) => index > 0 && tokens[index - 1] >= token)
  ) {
    return undefined;
  }
  return tokens;
}

/** Structured request-span attributes for support and rollout observation. */
export function clientCompatibilityAttributes(
  compatibility: ClientCompatibility
): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (compatibility.present.client) {
    attrs["client.version"] = compatibility.clientVersion?.version ?? null;
    attrs["client.version_valid"] = compatibility.valid.client;
  }
  if (compatibility.present.protocolVersion) {
    attrs["client.protocol_version"] = compatibility.protocolVersion ?? null;
    attrs["client.protocol_version_valid"] = compatibility.valid.protocolVersion;
  }
  if (compatibility.present.capabilities) {
    attrs["client.capabilities"] = compatibility.capabilities;
    attrs["client.capabilities_valid"] = compatibility.valid.capabilities;
  }
  return attrs;
}

/** Parse request metadata and advertise the server protocol version on every response. */
export function clientCompatibilityMiddleware(): MiddlewareHandler<ClientCompatibilityEnv> {
  return async (c, next) => {
    c.set("clientCompatibility", parseClientCompatibility(c.req.raw.headers));
    await next();
    c.res.headers.set(CLIENT_COMPATIBILITY_HEADERS.protocolVersion, DVM_PROTOCOL_VERSION);
  };
}

export const requireClientCompatibility: ClientCompatibilityGate = (requirement) => {
  const normalized = normalizeRequirement(requirement);
  return async (c, next) => {
    const compatibility =
      c.get("clientCompatibility") ?? parseClientCompatibility(c.req.raw.headers);
    const missingCapabilities = normalized.requiredCapabilities.filter(
      (capability) => !compatibility.capabilities.includes(capability)
    );
    const belowMinimum =
      normalized.minimumClientVersion !== undefined &&
      (compatibility.clientVersion === undefined ||
        compareSemVer(compatibility.clientVersion, normalized.minimumClientVersion) < 0);

    if (missingCapabilities.length > 0 || belowMinimum) {
      return renderClientUpgradeRequired(c, compatibility, normalized);
    }
    await next();
  };
};

export function clientUpgradeRequired(
  c: Context,
  compatibility: ClientCompatibility,
  requirement: ClientCompatibilityRequirement
): Response {
  return renderClientUpgradeRequired(c, compatibility, normalizeRequirement(requirement));
}

function renderClientUpgradeRequired(
  c: Context,
  compatibility: ClientCompatibility,
  normalized: NormalizedClientCompatibilityRequirement
): Response {
  c.header(CLIENT_COMPATIBILITY_HEADERS.protocolVersion, DVM_PROTOCOL_VERSION);
  const minimum = normalized.minimumClientVersion?.version;
  const current = compatibility.clientVersion?.version;
  const needs = [
    normalized.requiredCapabilities.length > 0
      ? `capabilities ${normalized.requiredCapabilities.join(", ")}`
      : undefined,
    minimum ? `dvm ${minimum} or newer` : undefined,
  ].filter((part): part is string => part !== undefined);
  return c.json(
    {
      error: "client_upgrade_required",
      required_capabilities: normalized.requiredCapabilities,
      ...(minimum ? { minimum_client_version: minimum } : {}),
      ...(current ? { current_client_version: current } : {}),
      display: "This request needs a newer dvm client.",
      hint: `Upgrade or reinstall dvm with support for ${needs.join(" and ")}, then retry this request.`,
    },
    426
  );
}

interface NormalizedClientCompatibilityRequirement {
  readonly requiredCapabilities: readonly string[];
  readonly minimumClientVersion?: ClientSemVer;
}

const CAPABILITY_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

function parseSemVer(value: string): ClientSemVer | undefined {
  const match = SEMVER_RE.exec(value);
  if (!match) return undefined;
  const core = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  const prerelease = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  if (prerelease.some((part) => typeof part === "number" && !Number.isSafeInteger(part))) {
    return undefined;
  }
  return {
    version: value,
    major: core[0],
    minor: core[1],
    patch: core[2],
    prerelease,
  };
}

function normalizeRequirement(
  requirement: ClientCompatibilityRequirement
): NormalizedClientCompatibilityRequirement {
  const requiredCapabilities = [...(requirement.requiredCapabilities ?? [])].sort();
  if (
    requiredCapabilities.some((token) => !CAPABILITY_TOKEN_RE.test(token)) ||
    new Set(requiredCapabilities).size !== requiredCapabilities.length
  ) {
    throw new Error("required client capabilities must be unique lowercase kebab-case tokens");
  }
  const configuredMinimumClientVersion = requirement.minimumClientVersion;
  const minimumClientVersion =
    configuredMinimumClientVersion !== undefined
      ? parseSemVer(configuredMinimumClientVersion)
      : undefined;
  if (configuredMinimumClientVersion !== undefined && !minimumClientVersion) {
    throw new Error("minimum client version must be a valid SemVer value");
  }
  return { requiredCapabilities, ...(minimumClientVersion ? { minimumClientVersion } : {}) };
}

function compareSemVer(left: ClientSemVer, right: ClientSemVer): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "string") return -1;
    if (typeof a === "string" && typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}
