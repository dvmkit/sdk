import { CAPABILITY_NAME_RE } from "../lib/wire-schema";
import { type Currency, InvalidCurrencyError, validateCurrency } from "./pricing/currency";
import { parseUsdPrice } from "./pricing/usd";
import {
  type CapabilityConfig,
  type CapabilityDescriptor,
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
  type ResolvedCreditConfig,
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
  const capabilities = buildCapabilityMap<State, InputSchema>(config, currency);
  const jobRetentionDays = resolveJobRetentionDays(config.jobRetentionDays);

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
    paymentMethods: config.paymentMethods,
    x402: config.x402,
    mpp: config.mpp,
    credit: resolveCreditConfig(config.credit),
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
  capabilityName: string,
  currency: Currency
): void {
  if (price === undefined) return;
  if (currency !== "usd") {
    throw new Error(
      `configureDVM: capability "${capabilityName}" declares a static price ` +
        `(${JSON.stringify(price)}) but this DVM prices in ${currency}. Static prices are USD ` +
        `literals, so they cannot express ${currency} — price this capability with \`onQuote\` ` +
        `returning { amount, currency: ${JSON.stringify(currency)} }, or drop the DVM-level ` +
        "`currency` to price in USD."
    );
  }
  validatePriceLiteral(price, `configureDVM: capability "${capabilityName}" price`, "price");
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
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
Record<string, CapabilityDescriptor<any, any>> {
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
  validateCapabilityPrice(config.price, name, currency);

  validateExampleAgainstInput(name, config.input, config.example);

  // `config.onJob` and the optional message handlers are method-shorthand
  // declarations on `DVMConfig` (existing public surface). eslint flags raw
  // references as unbound-method risk; we copy them onto the desugared
  // CapabilityDescriptor as-is — the runtime never separates them from their
  // descriptor.
  /* eslint-disable @typescript-eslint/unbound-method */
  const entry: CapabilityDescriptor<State, InputSchema> = {
    name,
    description: config.description ?? "",
    input: config.input,
    example: config.example,
    state: config.state ?? ({} as State),
    price: config.price,
    onQuote: config.onQuote,
    rates: snapshotRates(config.rates),
    onJob: config.onJob as CapabilityDescriptor<State, InputSchema>["onJob"],
    onResponse: config.onResponse,
    onPayment: config.onPayment,
    onApproval: config.onApproval,
    onCancel: config.onCancel,
    onMessage: config.onMessage,
  };
  /* eslint-enable @typescript-eslint/unbound-method */
  return { [name]: entry as unknown as CapabilityDescriptor };
}

/**
 * Build the desugared map from an explicit `capabilities` block. Each entry's
 * `state` is structuredCloned at construction so JobManager.createJob can
 * clone it again per-job without sharing references with the descriptor.
 */
function buildExplicitCapabilities(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  capabilities: Record<string, CapabilityConfig<any, any>>,
  currency: Currency
): // eslint-disable-next-line @typescript-eslint/no-explicit-any
Record<string, CapabilityDescriptor<any, any>> {
  const keys = Object.keys(capabilities);
  if (keys.length === 0) {
    throw new Error("configureDVM: `capabilities` block must declare at least one capability");
  }

  const out: // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Record<string, CapabilityDescriptor<any, any>> = {};
  for (const name of keys) {
    validateCapabilityName(name);
    const cap = capabilities[name];
    if (typeof cap.onJob !== "function") {
      throw new Error(`configureDVM: capability "${name}" is missing required onJob handler`);
    }
    validateCapabilityPrice(cap.price, name, currency);
    validateExampleAgainstInput(name, cap.input, cap.example);
    const entry: CapabilityDescriptor = {
      name,
      description: cap.description ?? "",
      // Per-capability `input` is the builder's Zod schema; the `any` widening
      // through `Record<string, CapabilityConfig<any, any>>` is unavoidable
      // here.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      input: cap.input,
      example: cap.example as Record<string, unknown> | undefined,
      state: cap.state !== undefined ? (structuredClone(cap.state) as unknown) : ({} as unknown),
      price: cap.price,
      onQuote: cap.onQuote,
      rates: snapshotRates(cap.rates),
      onJob: cap.onJob as CapabilityDescriptor["onJob"],
      onResponse: cap.onResponse,
      onPayment: cap.onPayment,
      onApproval: cap.onApproval,
      onCancel: cap.onCancel,
      onMessage: cap.onMessage,
    };
    out[name] = entry;
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
function validateExampleAgainstInput(capName: string, input: unknown, example: unknown): void {
  if (example === undefined) return;
  if (!isZodSchema(input)) return;
  const result = input.safeParse(example);
  if (result.success) return;
  throw new Error(
    `configureDVM: capability "${capName}" example does not satisfy its input schema. ` +
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
