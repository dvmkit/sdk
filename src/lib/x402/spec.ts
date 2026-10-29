/** Wire compatibility requires independent v1 and v2 reference-client checks. */
import { X402_DEFAULT_FACILITATOR } from "./constants";
import { x402NetworkByCaip2, x402NetworkBySlug } from "./networks";
import type { X402Config } from "./types";

/** Current x402 protocol version preferred by dvmkit clients and servers. */
export const X402_VERSION = 2;

/** Legacy x402 protocol version retained during the dual-serve window. */
export const X402_V1_VERSION = 1;

/** Authorization validity, in seconds, requested when a capability sets no runtime bound. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** x402 protocol versions supported by dvmkit's hand-rolled exact codec. */
export type X402Version = typeof X402_V1_VERSION | typeof X402_VERSION;

/**
 * Chain a caller's x402 wallet reads when it was connected without an explicit
 * `--network`. Single source of truth for the default: the wallet loader, the
 * connect output and the asset resolver all read it from here.
 */
export const X402_DEFAULT_NETWORK = "eip155:8453";

/**
 * Scheme name of the per-call rail — one signed authorization settling one
 * resource. Shared with the credit funding menu's `x402.schemes` block, which
 * has to name the same string the requirement carries.
 */
export const X402_EXACT_SCHEME = "exact";

/**
 * Scheme name of the reusable v2 channel rail. Single source of truth: the
 * facilitator probe, the requirement the server builds, the header dispatch,
 * the caller's requirement selection, and the credit menu's `x402.schemes`
 * block all read it from here — the menu advertises exactly what the challenge
 * will carry, so a rename cannot leave one of them advertising a flavour the
 * others no longer speak.
 */
export const X402_BATCH_SETTLEMENT_SCHEME = "batch-settlement";

export { X402_DEFAULT_FACILITATOR };

/**
 * x402-spec PaymentRequirements — the shape advertised on a 402 response's
 * `accepts` array, mirrored from the facilitator's `PaymentRequirementsSchema`
 * (see `x402/types/index.d.ts` in the published `x402` package).
 */
export interface PaymentRequirementsV1 {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** x402 v2 resource metadata echoed by a paying client. */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** x402 v2 PaymentRequirements, carried in `PAYMENT-REQUIRED`. */
export interface PaymentRequirementsV2 {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  /**
   * Optional *and* nullable, mirroring the vendor schema's `OptionalAny` — an
   * `exact` payment on a chain that needs no EIP-712 domain carries none.
   */
  extra?: Record<string, unknown> | null;
}

/** Legacy alias retained for server internals that carry the v1 body requirements. */
export type PaymentRequirements = PaymentRequirementsV1;

/**
 * EIP-3009 `TransferWithAuthorization` parameters that the client signs and
 * the facilitator submits on settlement.
 */
export interface ExactEvmPayloadAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Signed EIP-3009 transfer authorization (the `payload` of a PaymentPayload). */
export interface ExactEvmPayload {
  signature: string;
  authorization: ExactEvmPayloadAuthorization;
}

/**
 * x402-spec PaymentPayload — the JSON shape carried inside the `X-PAYMENT`
 * header (base64-encoded). `payload` is scheme-specific; alpha only supports
 * `scheme: "exact"` against an EVM network.
 */
export interface PaymentPayloadV1 {
  x402Version: typeof X402_V1_VERSION;
  scheme: "exact";
  network: string;
  payload: ExactEvmPayload;
}

/** x402 v2 payment payload carried in `PAYMENT-SIGNATURE`. */
export interface PaymentPayloadV2 {
  x402Version: typeof X402_VERSION;
  resource?: ResourceInfo;
  accepted: PaymentRequirementsV2;
  payload: ExactEvmPayload;
  extensions?: Record<string, unknown>;
}

/** Exact EVM payment payload accepted by the dual-version codec. */
export type PaymentPayload = PaymentPayloadV1 | PaymentPayloadV2;

/** Facilitator `/verify` response. */
export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

/** Facilitator `/settle` response — what we base64 into `X-PAYMENT-RESPONSE`. */
export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
  amount?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Body envelope used to carry x402 PaymentRequirements on a 402 response.
 * The x402 spec puts requirements in the JSON body under `accepts`; the
 * `WWW-Authenticate: Payment` header carries the MPP method advertisements
 * separately, so the two protocols don't fight for the same header slot.
 */
export interface X402ResponseBody {
  x402Version: typeof X402_V1_VERSION;
  accepts: PaymentRequirementsV1[];
  error?: string;
}

/** x402 v2 payment-required declaration encoded into `PAYMENT-REQUIRED`. */
export interface PaymentRequiredV2 {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: ResourceInfo;
  accepts: PaymentRequirementsV2[];
  extensions?: Record<string, unknown>;
}

/** Either challenge shape understood by dvmkit callers. */
export type PaymentRequired = X402ResponseBody | PaymentRequiredV2;

/** Inputs for `buildPaymentRequirements`. */
export interface BuildPaymentRequirementsOpts {
  x402Config: X402Config;
  requiredUsdcMicro: bigint;
  resource: string;
  description?: string;
  mimeType?: string;
  version?: X402Version;
  /**
   * Validity window, in seconds, a compliant client gives its authorization.
   * Facilitators do not enforce it; a server that settles after the work must
   * read the signed `validBefore` instead.
   */
  maxTimeoutSeconds?: number;
}

/**
 * V1 carries the resource URL in each requirement; v2 carries it in the outer
 * response. This metadata is not part of the EIP-3009 authorization signature.
 */
export function buildPaymentRequirements(
  opts: BuildPaymentRequirementsOpts & { version: typeof X402_V1_VERSION }
): PaymentRequirementsV1;
export function buildPaymentRequirements(
  opts:
    | (BuildPaymentRequirementsOpts & { version: typeof X402_VERSION })
    | (BuildPaymentRequirementsOpts & { version?: undefined })
): PaymentRequirementsV2;
export function buildPaymentRequirements(
  opts: BuildPaymentRequirementsOpts
): PaymentRequirementsV1 | PaymentRequirementsV2 {
  const { x402Config, requiredUsdcMicro, resource, description, mimeType } = opts;
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const version = opts.version ?? X402_VERSION;
  const network =
    version === X402_V1_VERSION ? caip2ToX402Network(x402Config.network) : x402Config.network;
  const usdcContract = usdcContractByCaip2(x402Config.network);
  const configuredAsset = x402Config.asset;
  const asset =
    version === X402_VERSION && configuredAsset?.toUpperCase() === "USDC"
      ? (usdcContract ?? configuredAsset)
      : (configuredAsset ?? usdcContract ?? "USDC");
  const extra = paymentRequirementExtra(x402Config.network, asset, usdcContract, version);
  if (version === X402_VERSION) {
    return {
      scheme: "exact",
      network,
      amount: requiredUsdcMicro.toString(),
      payTo: x402Config.payTo,
      asset,
      maxTimeoutSeconds,
      extra,
    };
  }
  return {
    scheme: "exact",
    network,
    maxAmountRequired: requiredUsdcMicro.toString(),
    resource,
    description: description ?? x402Config.description ?? "",
    mimeType: mimeType ?? "application/json",
    payTo: x402Config.payTo,
    asset,
    maxTimeoutSeconds,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/** Build the canonical x402 v2 declaration for a `PAYMENT-REQUIRED` header. */
export function buildPaymentRequiredV2(
  opts: Omit<BuildPaymentRequirementsOpts, "version"> & { error?: string }
): PaymentRequiredV2 {
  const description = opts.description ?? opts.x402Config.description ?? "";
  const mimeType = opts.mimeType ?? "application/json";
  return {
    x402Version: X402_VERSION,
    ...(opts.error ? { error: opts.error } : {}),
    resource: {
      url: opts.resource,
      ...(description ? { description } : {}),
      ...(mimeType ? { mimeType } : {}),
    },
    accepts: [buildPaymentRequirements({ ...opts, version: X402_VERSION })],
    extensions: {},
  };
}

/** Convert the server's legacy body requirements into the parallel v2 declaration. */
export function paymentRequiredV2FromV1(
  requirements: PaymentRequirementsV1[],
  error?: string
): PaymentRequiredV2 {
  const first = requirements.at(0);
  if (!first) throw new Error("Cannot build PAYMENT-REQUIRED without requirements");
  return {
    x402Version: X402_VERSION,
    ...(error ? { error } : {}),
    resource: {
      url: first.resource,
      ...(first.description ? { description: first.description } : {}),
      ...(first.mimeType ? { mimeType: first.mimeType } : {}),
    },
    accepts: requirements.map((requirement) => {
      const network = x402NetworkBySlug(requirement.network)?.caip2 ?? requirement.network;
      const usdcContract = usdcContractByCaip2(network);
      const asset =
        requirement.asset.toUpperCase() === "USDC"
          ? (usdcContract ?? requirement.asset)
          : requirement.asset;
      return {
        scheme: "exact",
        network,
        amount: requirement.maxAmountRequired,
        asset,
        payTo: requirement.payTo,
        maxTimeoutSeconds: requirement.maxTimeoutSeconds,
        extra: {
          ...requirement.extra,
          ...paymentRequirementExtra(network, asset, usdcContract, X402_VERSION),
          assetTransferMethod: "eip3009",
        },
      };
    }),
    extensions: {},
  };
}

/** Legacy v1 network slugs; unknown identifiers pass through unchanged. */
export function caip2ToX402Network(network: string): string {
  return x402NetworkByCaip2(network)?.slug ?? network;
}

/** Translate a legacy x402 network slug back to its CAIP-2 chain id. */
export function x402NetworkToCaip2(network: string): string {
  return x402NetworkBySlug(network)?.caip2 ?? network;
}

/** EIP-712 chain id derived from a CAIP-2 chain id. */
export function chainIdFromCaip2(network: string): number {
  const parts = network.split(":");
  return Number.parseInt(parts[1] ?? "8453", 10);
}

/** USDC contract address for a network slug (post-translation). */
export function usdcContractFor(networkSlug: string): `0x${string}` | undefined {
  return x402NetworkBySlug(networkSlug)?.usdc;
}

export function usdcContractByCaip2(caip2: string): `0x${string}` | undefined {
  return x402NetworkByCaip2(caip2)?.usdc;
}

/** USDC EIP-712 domain `name` for a network slug. */
export function usdcDomainNameFor(networkSlug: string): string | undefined {
  return x402NetworkBySlug(networkSlug)?.domainName;
}

/** USDC EIP-712 domain `version` for a network slug. */
export function usdcDomainVersionFor(networkSlug: string): string | undefined {
  return x402NetworkBySlug(networkSlug)?.domainVersion;
}

/**
 * Decode a base64-encoded `X-PAYMENT` header into a structured `PaymentPayload`.
 * Throws on malformed input rather than silently returning a partial — the
 * server treats decode failures as `payment_invalid` per the spec.
 */
export function decodePayment(header: string): PaymentPayload {
  const decoded = Buffer.from(header, "base64").toString("utf-8");
  const parsed = JSON.parse(decoded) as Record<string, unknown> | null;
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid payment header shape");
  const version = parsed.x402Version;
  const scheme =
    version === X402_V1_VERSION
      ? parsed.scheme
      : version === X402_VERSION && isRecord(parsed.accepted)
        ? parsed.accepted.scheme
        : undefined;
  if (typeof scheme !== "string") throw new Error("Invalid payment scheme");
  const decoder = PAYMENT_SCHEME_DECODERS[scheme];
  if (!decoder) throw new Error(`Unsupported x402 payment scheme: ${scheme}`);
  return decoder(parsed);
}

/**
 * Encode a `PaymentPayload` for transport in the `X-PAYMENT` header. JSON
 * serialization uses string-typed integer fields (the spec encodes uint256
 * values as decimal strings, so `bigint` must already be stringified by the
 * caller).
 */
export function encodePayment(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
}

/** Encode a v2 `PaymentRequired` declaration for the HTTP response header. */
export function encodePaymentRequiredHeader(required: PaymentRequiredV2): string {
  return Buffer.from(JSON.stringify(required), "utf-8").toString("base64");
}

/** Decode and structurally validate a v2 `PAYMENT-REQUIRED` header. */
export function decodePaymentRequiredHeader(header: string): PaymentRequiredV2 {
  const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf-8")) as unknown;
  if (!isRecord(parsed) || parsed.x402Version !== X402_VERSION || !isRecord(parsed.resource)) {
    throw new Error("Invalid PAYMENT-REQUIRED header shape");
  }
  if (typeof parsed.resource.url !== "string" || !Array.isArray(parsed.accepts)) {
    throw new Error("Invalid PAYMENT-REQUIRED header shape");
  }
  for (const requirement of parsed.accepts) validateV2Requirements(requirement);
  return parsed as unknown as PaymentRequiredV2;
}

/** Read the exact EIP-3009 authorization carried by either protocol version. */
export function exactEvmAuthorization(payload: PaymentPayload): ExactEvmPayloadAuthorization {
  return payload.payload.authorization;
}

/**
 * Encode a `SettleResponse` for the `X-PAYMENT-RESPONSE` header that the
 * server emits on a 2xx after a successful settlement (per the
 * x402 spec).
 */
export function encodeSettleResponseHeader(response: SettleResponse): string {
  return Buffer.from(JSON.stringify(response), "utf-8").toString("base64");
}

type PaymentSchemeDecoder = (parsed: Record<string, unknown>) => PaymentPayload;

const PAYMENT_SCHEME_DECODERS: Partial<Record<string, PaymentSchemeDecoder>> = {
  exact: decodeExactPayment,
};

function decodeExactPayment(parsed: Record<string, unknown>): PaymentPayload {
  validateExactEvmPayload(parsed.payload);
  if (parsed.x402Version === X402_V1_VERSION) {
    if (parsed.scheme !== "exact" || typeof parsed.network !== "string") {
      throw new Error("Invalid x402 v1 exact payload");
    }
    return parsed as unknown as PaymentPayloadV1;
  }
  if (parsed.x402Version === X402_VERSION) {
    validateV2Requirements(parsed.accepted);
    if (parsed.resource !== undefined && !isResourceInfo(parsed.resource)) {
      throw new Error("Invalid x402 v2 resource");
    }
    if (parsed.extensions !== undefined && !isRecord(parsed.extensions)) {
      throw new Error("Invalid x402 v2 extensions");
    }
    return parsed as unknown as PaymentPayloadV2;
  }
  throw new Error(`Unsupported x402 version: ${String(parsed.x402Version)}`);
}

function validateV2Requirements(value: unknown): asserts value is PaymentRequirementsV2 {
  if (
    !isRecord(value) ||
    typeof value.scheme !== "string" ||
    typeof value.network !== "string" ||
    typeof value.amount !== "string" ||
    typeof value.asset !== "string" ||
    typeof value.payTo !== "string" ||
    typeof value.maxTimeoutSeconds !== "number" ||
    !isOptionalRecord(value.extra)
  ) {
    throw new Error("Invalid x402 v2 payment requirements");
  }
}

function validateExactEvmPayload(value: unknown): asserts value is ExactEvmPayload {
  if (!isRecord(value) || typeof value.signature !== "string" || !isRecord(value.authorization)) {
    throw new Error("Invalid exact EVM payload");
  }
  const authorization = value.authorization;
  for (const field of ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const) {
    if (typeof authorization[field] !== "string") throw new Error("Invalid exact authorization");
  }
}

function paymentRequirementExtra(
  caip2: string,
  asset: string,
  usdcContract: string | undefined,
  version: X402Version
): Record<string, unknown> {
  if (asset.toLowerCase() !== usdcContract?.toLowerCase()) return {};
  const network = x402NetworkByCaip2(caip2);
  if (!network) return {};
  return {
    ...(version === X402_VERSION ? { assetTransferMethod: "eip3009" } : {}),
    name: network.domainName,
    version: network.domainVersion,
  };
}

function isResourceInfo(value: unknown): value is ResourceInfo {
  return isRecord(value) && typeof value.url === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * A field the x402 v2 schema declares `OptionalAny` — optional *and* nullable.
 * Omission and an explicit `null` are both conformant, so only a present
 * non-record value is a structural error.
 */
function isOptionalRecord(value: unknown): boolean {
  return value === undefined || value === null || isRecord(value);
}
