import { CAPABILITY_NAME_RE } from "../lib/wire-schema";
import {
  assertPaymentRequiredFits,
  assertX402Listing,
  X402_SIZE_CHECK_AMOUNT,
  X402_SIZE_CHECK_ERROR,
  X402_SIZE_CHECK_ORIGIN,
  X402_SIZE_CHECK_TIMEOUT_SECONDS,
  x402ChannelPaymentRequired,
} from "../lib/x402/bazaar";
import { resolveCashuConfig } from "./cashu-locktime";
import { CAPABILITY_SIGNED_FIELDS, missingSignedSchemaFields } from "./signed-envelope-schema";
import { type Currency, InvalidCurrencyError, validateCurrency } from "./pricing/currency";
import { parseUsdPrice } from "./pricing/usd";
import {
  type CapabilityConfig,
  type CapabilityDescriptor,
  type CapabilityChannels,
  type CapabilityRate,
  type CreditConfig,
  DEFAULT_CREDIT_MAX,
  DEFAULT_CREDIT_MIN,
  DEFAULT_CREDIT_TTL_SECONDS,
  DEFAULT_JOB_RETENTION_DAYS,
  type DVMConfig,
  type DVMDescriptor,
  isZodSchema,
  type PriceValue,
  type ResolvedCapabilityChannels,
  type ResolvedCreditConfig,
  type X402ChannelConfig,
  type ZodLike,
} from "./types";

/**
 * Capability names follow the same tag-shape as DVM names: lowercase
 * letters/digits/hyphens, no slashes — so the canonical slash-delimited
 * identifier (`cast/add-episode`) stays unambiguous. Exported so the caller's
 * identifier parser can share the regex rather than duplicate it; the caller CLI
 * carries its own copy of this constant until it depends on the SDK package.
 */
export { CAPABILITY_NAME_RE };

/** Configure a DVM; idleTimeout limits each caller answer/payment window (1–604800 seconds), not processing time. */
export function configureDVM<
  State = Record<string, unknown>,
  InputSchema extends ZodLike | undefined = undefined,
>(config: DVMConfig<State, InputSchema>): DVMDescriptor<State, InputSchema> {
  const tags = collectTags(config);
  const currency = resolvePricingCurrency(config.currency);
  const definitions = buildCapabilityMap<State, InputSchema>(config, currency);
  const partitioned = partitionByChannel(definitions);
  for (const entry of Object.values(partitioned.x402Capabilities)) {
    assertX402ChannelDefinition(entry, config);
  }
  // x402-channel callers are unsigned, so only dvmkit-protocol definitions
  // must preserve the signed envelope.
  if (config.auth) {
    for (const { label, def: cap } of Object.values(partitioned.capabilities)) {
      if (!isZodSchema(cap.input)) continue;
      const missing = missingSignedSchemaFields(cap.input);
      if (missing?.length) {
        throw new Error(
          `configureDVM: ${label} input schema must preserve signed envelope fields: ${missing.join(", ")}. ` +
          "Declare these fields or use .passthrough() / z.looseObject() to retain them."
        );
      }
    }
  }
  const jobRetentionDays = resolveJobRetentionDays(config.jobRetentionDays);
  const capabilities = descriptorMap(partitioned.capabilities);
  const x402Capabilities =
    Object.keys(partitioned.x402Capabilities).length > 0 ? descriptorMap(partitioned.x402Capabilities) : undefined;

  // Single-capability mirror: copy the only entry's input/state/price onto the
  // top-level descriptor so code paths that read from the top level keep
  // working — `inputSchema` feeds the isolate `/v1/info` single-cap shape,
  // `price` the legacy flat price. These are mirrors,
  // not the runtime source of truth: the SDK runtime always reads per-
  // capability (e.g. `JobManager.createJob` clones `cap.state`, never the
  // top-level `state`), so for multi-capability DVMs the top-level fields are
  // left undefined/`{}` and carry zero runtime effect.
  const onlyCapability = singleCapabilityEntry(capabilities);

  const descriptor: DVMDescriptor<State, InputSchema> = {
    name: config.name,
    description: config.description ?? "",
    tags,
    currency,
    price: onlyCapability?.price,
    inputSchema: onlyCapability?.input as InputSchema,
    state: (onlyCapability?.state ?? ({} as State)) as State,
    idleTimeout: resolveIdleTimeout(config.idleTimeout),
    processingWatchdog: config.processingWatchdog,
    jobRetentionDays,
    config,
    capabilities,
    ...(x402Capabilities ? { x402Capabilities } : {}),
    paymentMethods: config.paymentMethods,
    x402: config.x402,
    mpp: config.mpp,
    credit: resolveCreditConfig(config.credit),
    cashu: resolveCashuConfig(config.cashu),
    auth: config.auth,
  };

  CONFIGURED_DVM_DESCRIPTORS.add(descriptor);

  return Object.freeze(descriptor);
}

function resolveIdleTimeout(raw: number | undefined): number {
  const seconds = raw === undefined ? 3600 : raw;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 604800) {
    throw new Error(`configureDVM: idleTimeout must be an integer from 1 through 604800 seconds; received ${String(raw)}`);
  }
  return seconds;
}

function resolveJobRetentionDays(raw: number | undefined): number {
  const days = raw ?? DEFAULT_JOB_RETENTION_DAYS;
  if (!Number.isSafeInteger(days) || days < 0 || days > Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 86_400_000)) {
    throw new Error(
      `configureDVM: jobRetentionDays must be a non-negative whole number of days; received ${JSON.stringify(raw)}`
    );
  }
  return days;
}

/** Check whether this SDK module instance created a value through `configureDVM`. */
export function isConfiguredDVMDescriptor(
  value: unknown
): value is DVMDescriptor<unknown, ZodLike | undefined> {
  return typeof value === "object" && value !== null && CONFIGURED_DVM_DESCRIPTORS.has(value);
}

const CONFIGURED_DVM_DESCRIPTORS = new WeakSet<object>();

/**
 * Resolve the DVM's pricing currency — the single answer every
 * denomination surface reads: the funding menu, `POST /v1/credit`, the quote
 * balance echo, and the ledger rows a job's draw lands on.
 *
 * Undeclared means `"usd"`, which is what every DVM written before the field
 * existed meant, so nothing changes for them. A declared value is validated
 * here rather than at the first quote: an unparseable currency code would
 * otherwise surface as a caller's failed request, and the DVM would have been
 * advertising a menu it could never settle in the whole time.
 */
function resolvePricingCurrency(raw: string | undefined): Currency {
  if (raw === undefined) return "usd";
  try {
    return validateCurrency(raw);
  } catch (err) {
    if (err instanceof InvalidCurrencyError) {
      throw new Error(
        `configureDVM: currency ${JSON.stringify(raw)} is not an ISO 4217 lowercase code ` +
          'like "usd" or "eur". Omit the field to price in USD.',
        { cause: err }
      );
    }
    throw err;
  }
}

/**
 * Fill a builder's `credit` block from the platform defaults, or return
 * `undefined` when the builder didn't declare one (the opt-in gate — no
 * block means no funding menu and no `/v1/credit`).
 *
 * Validation throws, matching the rest of `configureDVM`: a DVM whose credit
 * bounds are inverted or whose TTL is zero would advertise a menu no caller
 * can satisfy, and that is worth crashing at construction rather than
 * discovering from a caller's rejected top-up.
 */
function resolveCreditConfig(credit: CreditConfig | undefined): ResolvedCreditConfig | undefined {
  if (!credit) return undefined;
  const min = credit.min ?? DEFAULT_CREDIT_MIN;
  const max = credit.max ?? DEFAULT_CREDIT_MAX;
  const ttlSeconds = credit.ttl ?? DEFAULT_CREDIT_TTL_SECONDS;
  const minAmount = validatePriceLiteral(min, "credit.min");
  const maxAmount = validatePriceLiteral(max, "credit.max");
  if (minAmount > maxAmount) {
    throw new Error(
      `credit.min (${JSON.stringify(min)}) exceeds credit.max (${JSON.stringify(max)}) — ` +
        "no funding amount could satisfy both."
    );
  }
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(`credit.ttl must be a positive number of seconds (got ${ttlSeconds}).`);
  }
  // Strict opt-in: older descriptors and runtime values forced past the type
  // both stay on the reusable-only default.
  const allowOneShotStablecoin = credit.allowOneShotStablecoin === true;
  return { min, max, ttlSeconds, allowOneShotStablecoin };
}

/**
 * Validate one builder-declared price literal and return its bare USD amount.
 *
 * The gate: a numeric (msats) price is a hard config error, not a
 * coerced value, and the message names the fiat form the builder wants. This
 * runs at construction because the alternative is discovering it from a
 * caller's rejected payment — the price surfaces on `/v1/info` long before
 * anyone submits, and a DVM that boots with an undenominable price advertises
 * a number no rail can settle against.
 *
 * Takes `unknown` rather than `PriceValue`: the type already rules a number
 * out for TypeScript builders, so the value of this check is precisely for
 * the ones it can't reach — JavaScript callers and `as any` escapes.
 *
 * `field` names the offending value for the reader (`configureDVM: capability
 * "count" price`); `key` is the config key the fix goes under (`price`), so
 * the guidance clause reads as something the builder can literally type.
 */
function validatePriceLiteral(value: unknown, field: string, key = field): number {
  if (typeof value === "number") {
    throw new Error(
      `${field} is a number (${value}). Prices are USD literals — write ${key}: "$0.01" for one cent. ` +
        "Callers still pay in sats; the SDK converts at request time. Omit the field for a free " +
        "capability, or use `onQuote` for dynamic pricing."
    );
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a USD literal like "$0.05" (got ${JSON.stringify(value)}).`);
  }
  return parseUsdPrice(value, field);
}

/**
 * Boot-time price check for one capability. Free capabilities omit
 * `price` entirely — `undefined` passes.
 *
 * a static price is a USD literal — `"$0.05"` is the entire grammar
 * so a DVM declaring some other pricing currency cannot express one. All
 * three ways out are worse than refusing: reading `"$0.05"` as €0.05 silently
 * reinterprets what the builder wrote; leaving it USD puts a USD-priced job on
 * a EUR ledger, which is the very mismatch the DVM-level currency exists to
 * close; and converting at request time would put an fx lookup back on the
 * denomination path that deliberately cleared (a rate outage there is
 * how money got taken with no draw recorded). So a non-USD DVM prices
 * dynamically, and boot says so instead of a caller's payment discovering it.
 */
function validateCapabilityPrice(
  price: PriceValue | undefined,
  label: string,
  currency: Currency
): void {
  if (price === undefined) return;
  if (currency !== "usd") {
    throw new Error(
      `configureDVM: ${label} declares a static price ` +
        `(${JSON.stringify(price)}) but this DVM prices in ${currency}. Static prices are USD ` +
        `literals, so they cannot express ${currency} — price this capability with \`onQuote\` ` +
        `returning { amount, currency: ${JSON.stringify(currency)} }, or drop the DVM-level ` +
        "`currency` to price in USD."
    );
  }
  validatePriceLiteral(price, `configureDVM: ${label} price`, "price");
}

/** Longest runtime bound a capability may declare, in seconds. */
export const MAX_RUNTIME_SECONDS_LIMIT = 600;

function validateMaxRuntimeSeconds(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_RUNTIME_SECONDS_LIMIT) {
    throw new Error(
      `configureDVM: ${label} maxRuntimeSeconds must be a whole number ` +
        `of seconds from 1 to ${MAX_RUNTIME_SECONDS_LIMIT}, got ${JSON.stringify(value)}`
    );
  }
}

/**
 * One desugared definition with the `capabilities` entry it came from, so
 * boot errors can name the entry when two share a published name.
 */
interface CapabilityDefinition {
  key: string;
  /** `capability "fetch"`, or `capability "fetch" (entry "fetch-x402")` when the key differs. */
  label: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: CapabilityDescriptor<any, any>;
}

function descriptorMap(
  entries: Record<string, CapabilityDefinition>
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
Record<string, CapabilityDescriptor<any, any>> {
  return Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.def]));
}

function capabilityLabel(name: string, key: string): string {
  return name === key ? `capability "${name}"` : `capability "${name}" (entry "${key}")`;
}

/**
 * Resolve a definition's `channels` declaration. Unset means the dvmkit
 * protocol only; a declaration offers exactly the channels it names, and one
 * that names x402 must also say whether `/v1/job` keeps the definition.
 */
function resolveCapabilityChannels(raw: unknown, label: string): ResolvedCapabilityChannels {
  if (raw === undefined) return Object.freeze({ job: true });
  const at = `configureDVM: ${label} channels`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} must be an object such as { job: true, x402: {} }`);
  }
  const declared = raw as CapabilityChannels & Record<string, unknown>;
  for (const key of Object.keys(declared)) {
    if (key === "listing") {
      throw new Error(`${at}.listing is not a channel; a listing belongs under channels.x402.listing`);
    }
    if (key !== "job" && key !== "x402") {
      throw new Error(`${at}.${key} is not a channel (job, x402)`);
    }
  }
  if (declared.job !== undefined && typeof declared.job !== "boolean") {
    throw new Error(`${at}.job must be true or false (got ${JSON.stringify(declared.job)})`);
  }
  let x402: X402ChannelConfig | undefined;
  if (declared.x402 !== undefined) {
    const channel: unknown = declared.x402;
    if (typeof channel !== "object" || channel === null || Array.isArray(channel)) {
      throw new Error(`${at}.x402 must be an object, such as {} or { listing: { ... } }`);
    }
    for (const key of Object.keys(channel)) {
      if (key !== "listing") throw new Error(`${at}.x402.${key} is not an x402 channel field (listing)`);
    }
    if (declared.job === undefined) {
      throw new Error(
        `${at} declares x402 without job; set job: true to keep it on /v1/job, or job: false for x402 only`
      );
    }
    x402 = deepFreeze(structuredClone(channel as X402ChannelConfig));
  }
  const job = declared.job === true;
  if (!job && !x402) {
    throw new Error(`${at} must offer at least one channel: set job: true, x402: {}, or both`);
  }
  return Object.freeze(x402 ? { job, x402 } : { job });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Split definitions into the dvmkit-protocol map, which `/v1/job` and
 * `/v1/info` read unchanged, and the x402 map. Names are unique within each.
 * Either map may be empty, since every definition offers at least one channel.
 */
function partitionByChannel(definitions: CapabilityDefinition[]): {
  capabilities: Record<string, CapabilityDefinition>;
  x402Capabilities: Record<string, CapabilityDefinition>;
} {
  const capabilities: Record<string, CapabilityDefinition> = {};
  const x402: Record<string, CapabilityDefinition> = {};
  const place = (map: Record<string, CapabilityDefinition>, entry: CapabilityDefinition, channel: string): void => {
    const name = entry.def.name;
    if (Object.hasOwn(map, name)) {
      throw new Error(
        `configureDVM: two capabilities are named "${name}" on ${channel} ` +
          `(entries "${map[name].key}" and "${entry.key}"); names must be unique within a channel`
      );
    }
    map[name] = entry;
  };
  for (const entry of definitions) {
    if (entry.def.channels.job) place(capabilities, entry, "the dvmkit protocol");
    if (entry.def.channels.x402) place(x402, entry, "the x402 channel");
  }
  return { capabilities, x402Capabilities: x402 };
}

/** Boot checks for one definition offered on the x402 channel. */
function assertX402ChannelDefinition(
  entry: CapabilityDefinition,
  config: Pick<DVMConfig<unknown, ZodLike | undefined>, "x402" | "paymentMethods" | "auth">
): void {
  const { def, label } = entry;
  const at = `configureDVM: ${label}`;
  // validateCapabilityName already limited the name to [a-z0-9-], which is
  // path-safe as the last segment of /v1/x402/<name>.
  if (def.maxRuntimeSeconds === undefined) {
    throw new Error(
      `${at} is offered on x402 and must set maxRuntimeSeconds (1 to ${MAX_RUNTIME_SECONDS_LIMIT}); ` +
        "an x402 caller waits for the result within one request"
    );
  }
  const x402Config = config.x402;
  if (config.paymentMethods !== undefined && !config.paymentMethods.includes("x402")) {
    throw new Error(
      `${at} is offered on x402 but paymentMethods (${JSON.stringify(config.paymentMethods)}) ` +
        'leaves out "x402"; add "x402" to paymentMethods or stop offering the capability on x402'
    );
  }
  // The one request carries the payment, so its amount must be known before
  // the handler runs: from the fixed price, or from onQuote run on the body.
  if (def.price === undefined && def.onQuote === undefined) {
    throw new Error(
      def.rates !== undefined
        ? `${at} is offered on x402 and priced only by rates; an x402 caller pays before the ` +
            "handler runs, so set a fixed price or an onQuote that prices the request body"
        : `${at} is offered on x402 but is free; an x402 caller pays before the handler runs, ` +
            "so set a fixed price or an onQuote that prices the request body"
    );
  }
  assertX402InputUnsigned(def, at, config.auth !== undefined);

  const listing = def.channels.x402?.listing;
  if (listing === undefined) return;
  assertX402Listing(label, listing, def.input);
  if (isZodSchema(def.input)) {
    const result = def.input.safeParse(listing.example);
    if (!result.success) {
      throw new Error(
        `${at} channels.x402.listing.example does not satisfy its input schema. ` +
          `Issues: ${formatZodIssues(result.error)}`
      );
    }
  }
  // A host may supply the rail later. Only sizing needs it here; the server
  // reruns sizing at boot with its resolved rail, public origin and timeout.
  if (!x402Config) return;
  assertPaymentRequiredFits(
    label,
    x402ChannelPaymentRequired({
      name: def.name,
      listing,
      input: def.input,
      x402Config,
      publicOrigin: X402_SIZE_CHECK_ORIGIN,
      requiredUsdcMicro: X402_SIZE_CHECK_AMOUNT,
      maxTimeoutSeconds: X402_SIZE_CHECK_TIMEOUT_SECONDS,
      error: X402_SIZE_CHECK_ERROR,
    })
  );
}

/**
 * An x402 caller never sends signed-request fields, so x402 reserves their
 * names. A definition offered on x402 must not declare them, except that one
 * also offered on `/v1/job` under `auth` declares them for that channel and
 * must make them optional for an unsigned body to parse.
 */
function assertX402InputUnsigned(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  def: CapabilityDescriptor<any, any>,
  at: string,
  hasAuth: boolean
): void {
  if (!isZodSchema(def.input)) return;
  const shape = (def.input._zod as { def?: { type?: unknown; shape?: Record<string, unknown> } } | undefined)?.def;
  if (shape?.type !== "object" || !shape.shape) return;
  for (const field of CAPABILITY_SIGNED_FIELDS) {
    if (!Object.hasOwn(shape.shape, field)) continue;
    if (!def.channels.job) {
      throw new Error(
        `${at} is offered on x402 only, whose callers are unsigned, but its input schema declares ` +
          `the signed-request field "${field}"; remove it`
      );
    }
    if (!hasAuth) {
      throw new Error(
        `${at} is offered on x402, whose callers are unsigned, and its input schema declares a field ` +
          `named "${field}", which x402 reserves for the signed-request envelope; rename it`
      );
    }
    const optin = (shape.shape[field] as { _zod?: { optin?: unknown } } | undefined)?._zod?.optin;
    if (optin !== "optional") {
      throw new Error(
        `${at} is offered on both channels, and x402 callers are unsigned, so its input schema's ` +
          `signed-request field "${field}" must be optional (for example z.string().optional())`
      );
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function collectTags(config: DVMConfig<any, any>): string[] {
  const tagSet = new Set<string>();
  if (config.tag) tagSet.add(config.tag);
  if (config.tags) {
    for (const t of config.tags) tagSet.add(t);
  }
  return [...tagSet];
}

/**
 * Resolve the configured shape into a capabilities map. Exactly one of:
 *
 * - **Flat shape** — `config.capability` is a string and the top-level
 * `onJob` is set. Desugar to a one-entry map.
 * - **Explicit shape** — `config.capabilities` is a record. Validate each
 * entry; the top-level handler/input/state/price fields must not also be
 * set.
 *
 * Anything else throws — single-cap descriptors that forget `capability` and
 * multi-cap that mix shapes both surface here, so misconfiguration crashes
 * at construction rather than producing a half-wired DVM.
 */
function buildCapabilityMap<State, InputSchema extends ZodLike | undefined>(
  config: DVMConfig<State, InputSchema>,
  currency: Currency
): CapabilityDefinition[] {
  const hasExplicitBlock = config.capabilities !== undefined;
  const hasFlatCapabilityName = typeof config.capability === "string";
  const hasFlatHandler = typeof config.onJob === "function";

  if (
    hasExplicitBlock &&
    (hasFlatCapabilityName || hasFlatHandler || flatPerCapFieldsSet(config))
  ) {
    throw new Error(
      "configureDVM: pass either the flat single-capability shape (capability + onJob + ...) " +
        "or the explicit `capabilities` block, not both."
    );
  }

  if (hasExplicitBlock) {
    return buildExplicitCapabilities(config.capabilities ?? {}, currency);
  }

  if (!hasFlatHandler) {
    throw new Error("configureDVM: onJob handler is required");
  }
  // Flat shape: builder may declare `capability: "<name>"` explicitly, or let
  // the SDK synthesize from the DVM name (slugified). Synthesis keeps the
  // ergonomic single-line `configureDVM({ name, onJob })` working for unit
  // tests and prototypes while preserving the protocol invariant that every
  // DVM exposes a named capability on the wire.
  const name =
    typeof config.capability === "string" ? config.capability : slugifyCapabilityName(config.name);
  validateCapabilityName(name);
  const label = capabilityLabel(name, name);
  validateCapabilityPrice(config.price, label, currency);
  validateMaxRuntimeSeconds(config.maxRuntimeSeconds, label);
  const channels = resolveCapabilityChannels(config.channels, label);

  validateExampleAgainstInput(label, config.input, config.example);
  if (Object.hasOwn(config, "listing")) {
    throw new Error(
      `configureDVM: ${label} declares listing outside channels.x402; ` +
        "a listing applies only to the x402 channel, as channels.x402.listing"
    );
  }

  // `config.onJob` and the optional message handlers are method-shorthand
  // declarations on `DVMConfig` (existing public surface). eslint flags raw
  // references as unbound-method risk; we copy them onto the desugared
  // CapabilityDescriptor as-is — the runtime never separates them from their
  // descriptor.
  /* eslint-disable @typescript-eslint/unbound-method */
  const entry: CapabilityDescriptor<State, InputSchema> = {
    name,
    channels,
    description: config.description ?? "",
    input: config.input,
    example: config.example,
    state: config.state ?? ({} as State),
    price: config.price,
    onQuote: config.onQuote,
    rates: snapshotRates(config.rates),
    maxRuntimeSeconds: config.maxRuntimeSeconds,
    onJob: config.onJob as CapabilityDescriptor<State, InputSchema>["onJob"],
    onResponse: config.onResponse,
    onPayment: config.onPayment,
    onApproval: config.onApproval,
    onCancel: config.onCancel,
    onMessage: config.onMessage,
  };
  /* eslint-enable @typescript-eslint/unbound-method */
  return [{ key: name, label, def: entry as unknown as CapabilityDescriptor }];
}

/**
 * Build the desugared definitions from an explicit `capabilities` block. Each
 * entry's `state` is structuredCloned at construction so JobManager.createJob
 * can clone it again per-job without sharing references with the descriptor.
 */
function buildExplicitCapabilities(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capabilities: Record<string, CapabilityConfig<any, any, any>>,
  currency: Currency
): CapabilityDefinition[] {
  const keys = Object.keys(capabilities);
  if (keys.length === 0) {
    throw new Error("configureDVM: `capabilities` block must declare at least one capability");
  }

  const out: CapabilityDefinition[] = [];
  for (const key of keys) {
    validateCapabilityName(key);
    const cap = capabilities[key];
    const name: unknown = cap.name === undefined ? key : cap.name;
    if (typeof name !== "string") {
      throw new Error(`configureDVM: capability "${key}" name must be a string (got ${JSON.stringify(name)})`);
    }
    if (name !== key) validateCapabilityName(name);
    const label = capabilityLabel(name, key);
    if (typeof cap.onJob !== "function") {
      throw new Error(`configureDVM: ${label} is missing required onJob handler`);
    }
    validateCapabilityPrice(cap.price, label, currency);
    validateMaxRuntimeSeconds(cap.maxRuntimeSeconds, label);
    validateExampleAgainstInput(label, cap.input, cap.example);
    if (Object.hasOwn(cap, "listing")) {
      throw new Error(
        `configureDVM: ${label} declares listing outside channels.x402; ` +
          "a listing applies only to the x402 channel, as channels.x402.listing"
      );
    }
    const entry: CapabilityDescriptor = {
      name,
      channels: resolveCapabilityChannels(cap.channels, label),
      description: cap.description ?? "",
      // Per-capability `input` is the builder's Zod schema; the `any` widening
      // through `Record<string, CapabilityConfig<any, any, any>>` is unavoidable
      // here.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input: cap.input,
      example: cap.example as Record<string, unknown> | undefined,
      state: cap.state !== undefined ? (structuredClone(cap.state) as unknown) : ({} as unknown),
      price: cap.price,
      onQuote: cap.onQuote,
      rates: snapshotRates(cap.rates),
      maxRuntimeSeconds: cap.maxRuntimeSeconds,
      onJob: cap.onJob as CapabilityDescriptor["onJob"],
      onResponse: cap.onResponse,
      onPayment: cap.onPayment,
      onApproval: cap.onApproval,
      onCancel: cap.onCancel,
      onMessage: cap.onMessage,
    };
    out.push({ key, label, def: entry });
  }
  return out;
}

/** True iff the flat per-capability fields (other than onJob/capability) are populated. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flatPerCapFieldsSet(config: DVMConfig<any, any>): boolean {
  return (
    config.input !== undefined ||
    config.example !== undefined ||
    config.state !== undefined ||
    config.price !== undefined ||
    config.onQuote !== undefined ||
    config.rates !== undefined ||
    config.maxRuntimeSeconds !== undefined ||
    config.channels !== undefined ||
    typeof config.onResponse === "function" ||
    typeof config.onPayment === "function" ||
    typeof config.onApproval === "function" ||
    typeof config.onCancel === "function" ||
    typeof config.onMessage === "function"
  );
}

/**
 * Catch builder/schema drift on the `example` primitive at descriptor
 * construction. The advertised `example` would otherwise become a stale payload that
 * `/v1/info` claims is runnable but the runtime then rejects. No-op when
 * either `example` is absent or `input` isn't a Zod schema (plain JSON-Schema
 * objects can't validate).
 */
function validateExampleAgainstInput(label: string, input: unknown, example: unknown): void {
  if (example === undefined) return;
  if (!isZodSchema(input)) return;
  const result = input.safeParse(example);
  if (result.success) return;
  throw new Error(
    `configureDVM: ${label} example does not satisfy its input schema. ` +
      `Update the example to match the schema (including any \`.refine()\` checks). ` +
      `Issues: ${formatZodIssues(result.error)}`
  );
}

interface ZodIssueLike {
  path: (string | number)[];
  message: string;
}

/**
 * Structured per-field summary of a Zod `safeParse` failure for the
 * descriptor-time throw. Reads the typed `error.issues[]` (each `{ path,
 * message }`) instead of duck-typing the flattened `.message`, so a multi-
 * field mismatch reports every offending path rather than one opaque blob.
 * `ZodLike.safeParse` types `error` as `unknown`, so narrow defensively and
 * fall back to a string render for anything that isn't a Zod-shaped error.
 */
function formatZodIssues(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "issues" in err &&
    Array.isArray((err as { issues: unknown }).issues)
  ) {
    const issues = (err as { issues: ZodIssueLike[] }).issues;
    if (issues.length === 0) return "(no issues reported)";
    return issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message.replace(/\s+/g, " ").trim();
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function validateCapabilityName(name: string): void {
  if (!CAPABILITY_NAME_RE.test(name)) {
    throw new Error(
      `configureDVM: invalid capability name "${name}" — must be lowercase letters/digits/hyphens, ` +
        "must start with a letter or digit, must not contain slashes."
    );
  }
}

/**
 * Synthesize a wire-shape capability name from a DVM display name when the
 * flat shape omits an explicit `capability` declaration. Lowercases, replaces
 * runs of non-alphanumerics with a single hyphen, strips leading/trailing
 * hyphens. The result is fed to `validateCapabilityName` — a name that
 * slug-ifies to the empty string (e.g. all-punctuation) throws there.
 */
function slugifyCapabilityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function singleCapabilityEntry(
  capabilities: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Record<string, CapabilityDescriptor<any, any>>
): CapabilityDescriptor | undefined {
  const keys = Object.keys(capabilities);
  if (keys.length !== 1) return undefined;
  return capabilities[keys[0]];
}

/**
 * Copy and freeze a declared rate card. The server validates the descriptor's
 * rates once at construction and `/v1/info` reads them on every request, so a
 * builder mutating its own array afterwards must not reach the wire.
 * Malformed values are copied as-is and refused by the server's check.
 */
function snapshotRates(rates: CapabilityRate[] | undefined): CapabilityRate[] | undefined {
  if (rates === undefined) return undefined;
  const copy = structuredClone(rates);
  if (Array.isArray(copy)) {
    for (const entry of copy as unknown[]) {
      if (typeof entry === "object" && entry !== null) Object.freeze(entry);
    }
  }
  return Object.freeze(copy) as CapabilityRate[];
}
