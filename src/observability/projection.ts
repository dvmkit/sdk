import { isIP } from "node:net";

import catalogue from "./diagnostic-catalogue-v1.json";
import type { SpanRow } from "./types";

export const DIAGNOSTIC_CATALOGUE_VERSION = catalogue.version;

const PAYMENT_ENUMS: Record<string, ReadonlySet<string>> = {
  reason: new Set(catalogue.paymentSkipReasons),
  cause: new Set(catalogue.denominationCauses),
  source_failure: new Set(catalogue.fxSourceFailures),
  failure_category: new Set(catalogue.paymentFailureCategories),
  failure_stage: new Set(catalogue.paymentFailureStages),
  phase: new Set(catalogue.paymentPhases),
};

// Dimensions the router pins on `router.proxy`. The suspension keys carry the
// platform's suspension reason, or `operator` when none is recorded.
const ROUTER_ENUMS: Record<string, ReadonlySet<string>> = {
  submit_identity_source: new Set(catalogue.submitIdentitySources),
  funded_runtime_reclaim: new Set(catalogue.fundedRuntimeReclaims),
  suspended_reclaim: new Set(catalogue.suspensionReasons),
  suspended_admin: new Set(catalogue.suspensionReasons),
};

const EVENTS = new Set<string>(catalogue.events);
const ROUTE_TEMPLATES = [...catalogue.routeTemplates].sort(
  compareRouteTemplates,
);
const ERROR_CODES = new Set<string>(catalogue.errorCodes);
const DATASETS = new Set<string>(catalogue.datasets);
const LEVELS = new Set<string>(catalogue.levels);
const STATUSES = new Set<string>(catalogue.statuses);
const METHODS = new Set<string>(catalogue.methods);
const RAILS = new Set<string>(catalogue.rails);
const STAGES = new Set<string>(catalogue.stages);
const HANDLERS = new Set<string>(catalogue.handlers);
const CURRENCIES = new Set<string>(catalogue.currencyTokens);
const TEMPO_CLOSE_REPORT_PRIOR_STATUSES = new Set<string>(catalogue.tempoCloseReportPriorStatuses);
const BOOLEAN_FIELDS = new Set<string>(catalogue.booleanFields);
const INTEGER_FIELDS = new Set<string>(catalogue.integerFields);
const TOKEN_FIELDS = new Set<string>(catalogue.tokenFields);
const HASH_FIELDS = new Set<string>(catalogue.hashFields);
const TRANSACTION_HASH_FIELDS = new Set<string>(catalogue.transactionHashFields);
const URL_FIELDS = new Set<string>(catalogue.urlFields);
const IDENTITY_FIELDS = new Set<string>(catalogue.identityFields);
const CAPABILITY_FIELDS = new Set<string>(catalogue.capabilityFields);
const CLIENT_PROTOCOL_VERSIONS = new Set<number>(
  catalogue.clientProtocolVersions,
);
const CLIENT_VERSION_FIELDS = new Set<string>(catalogue.clientVersionFields);
// A fixed list rather than a code pattern, so the field can never carry a
// free-form location.
const SANCTIONS_REGIONS = new Set<string>(catalogue.sanctionsRegions);

const SPAN_ID_RE = /^(?!0{16}$)[0-9a-f]{16}$/;
const TRACE_ID_RE = /^(?!0{32}$)[0-9a-f]{32}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MACHINE_ID_RE = /^[0-9a-f]{12,32}$/;
const RELEASE_RE =
  /^(?:v?\d+\.\d+\.\d+(?:-rc\.\d+)?|[0-9a-f]{7,40}|dev|test|unknown)$/;
const CAPABILITY_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const CLIENT_VERSION_RE =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.(?:0|[1-9]\d*))?$/;
const HASH_RE = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/i;
const DECIMAL_RE = /^(?:0|[1-9]\d{0,77})$/;
const STRIPE_EVENT_RE = /^evt_[A-Za-z0-9]{1,64}$/;
const REDACTED_SEGMENT_RE = /^:(?:uuid|hex|n|b58|token)$/;
const SERVICE_NAMES = new Set([
  "platform-api",
  "router",
  "admin",
  "unknown",
]);

declare const diagnosticCapabilityAuthorityBrand: unique symbol;
declare const diagnosticIdentityAuthorityBrand: unique symbol;

/** Opaque, process-local proof that capability names came from one app definition. */
export interface DiagnosticCapabilityAuthority {
  readonly [diagnosticCapabilityAuthorityBrand]: true;
}

/** Opaque, process-local proof that diagnostic identities came from trusted context. */
export interface DiagnosticIdentityAuthority {
  readonly [diagnosticIdentityAuthorityBrand]: true;
}

const AUTHORITY_CAPABILITIES = new WeakMap<object, ReadonlySet<string>>();
const VALUE_AUTHORITIES = new WeakMap<object, DiagnosticCapabilityAuthority>();
const AUTHORITY_IDENTITIES = new WeakMap<
  object,
  Readonly<Record<string, string>>
>();
const VALUE_IDENTITY_AUTHORITIES = new WeakMap<
  object,
  DiagnosticIdentityAuthority
>();

/** Capture one app's configured capability names without creating a process-wide union. */
export function createDiagnosticCapabilityAuthority(
  capabilityNames: readonly string[],
): DiagnosticCapabilityAuthority {
  const allowed = new Set(
    capabilityNames.filter(
      (name) => typeof name === "string" && CAPABILITY_RE.test(name),
    ),
  );
  const authority = Object.freeze({}) as DiagnosticCapabilityAuthority;
  AUTHORITY_CAPABILITIES.set(authority, allowed);
  return authority;
}

/** Attach an existing process-local authority to a value without serializing it. */
export function bindDiagnosticCapabilityAuthority<T extends object>(
  value: T,
  authority: DiagnosticCapabilityAuthority | undefined,
): T {
  if (authority && AUTHORITY_CAPABILITIES.has(authority)) {
    VALUE_AUTHORITIES.set(value, authority);
  }
  return value;
}

/** Extend trusted identity context without accepting identity values from a row. */
export function extendDiagnosticIdentityAuthority(
  authority: DiagnosticIdentityAuthority | undefined,
  key: string,
  value: unknown,
): DiagnosticIdentityAuthority | undefined {
  if (!IDENTITY_FIELDS.has(key)) return authority;
  const projected = validateIdentity(key, value);
  if (projected === undefined) return authority;
  const identities = {
    ...(authority && AUTHORITY_IDENTITIES.get(authority)),
    [key]: projected,
  };
  const next = Object.freeze({}) as DiagnosticIdentityAuthority;
  AUTHORITY_IDENTITIES.set(next, Object.freeze(identities));
  return next;
}

/** Attach trusted identity context to a detached value without serializing it. */
export function bindDiagnosticIdentityAuthority<T extends object>(
  value: T,
  authority: DiagnosticIdentityAuthority | undefined,
): T {
  if (authority && AUTHORITY_IDENTITIES.has(authority)) {
    VALUE_IDENTITY_AUTHORITIES.set(value, authority);
  }
  return value;
}

export type SpanProjectionResult =
  | { ok: true; row: SpanRow }
  | {
      ok: false;
      code:
        | "invalid_span"
        | "invalid_span_id"
        | "invalid_trace_id"
        | "invalid_parent_span_id"
        | "invalid_dataset"
        | "invalid_level"
        | "invalid_status"
        | "invalid_timestamp";
    };

/** Project an untrusted row into the versioned diagnostic catalogue. */
export function projectSpanRow(input: unknown): SpanProjectionResult {
  try {
    if (!isObject(input)) return { ok: false, code: "invalid_span" };
    const authority = VALUE_AUTHORITIES.get(input);
    const identityAuthority = VALUE_IDENTITY_AUTHORITIES.get(input);

    const spanId = ownValue(input, "span_id");
    if (typeof spanId !== "string" || !SPAN_ID_RE.test(spanId)) {
      return { ok: false, code: "invalid_span_id" };
    }
    const traceId = ownValue(input, "trace_id");
    if (typeof traceId !== "string" || !TRACE_ID_RE.test(traceId)) {
      return { ok: false, code: "invalid_trace_id" };
    }
    const parentSpanId = ownValue(input, "parent_span_id");
    if (
      parentSpanId !== null &&
      (typeof parentSpanId !== "string" || !SPAN_ID_RE.test(parentSpanId))
    ) {
      return { ok: false, code: "invalid_parent_span_id" };
    }
    const dataset = ownValue(input, "dataset");
    if (typeof dataset !== "string" || !DATASETS.has(dataset)) {
      return { ok: false, code: "invalid_dataset" };
    }
    const level = ownValue(input, "level");
    if (typeof level !== "string" || !LEVELS.has(level)) {
      return { ok: false, code: "invalid_level" };
    }
    const status = ownValue(input, "status");
    if (typeof status !== "string" || !STATUSES.has(status)) {
      return { ok: false, code: "invalid_status" };
    }
    const startedAtMs = ownValue(input, "started_at_ms");
    const endedAtMs = ownValue(input, "ended_at_ms");
    if (
      !isEpochMs(startedAtMs) ||
      !isEpochMs(endedAtMs) ||
      endedAtMs < startedAtMs
    ) {
      return { ok: false, code: "invalid_timestamp" };
    }

    const sampleRate = ownValue(input, "sample_rate");
    const pid = ownValue(input, "pid");
    const name = projectEventName(ownValue(input, "name"));

    const row: SpanRow = {
      span_id: spanId,
      trace_id: traceId,
      parent_span_id: parentSpanId,
      dataset: dataset as SpanRow["dataset"],
      name,
      level: level as SpanRow["level"],
      status: status as SpanRow["status"],
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      service: projectService(ownValue(input, "service")),
      service_version: projectServiceVersion(
        ownValue(input, "service_version"),
      ),
      host: projectHost(ownValue(input, "host")),
      pid:
        Number.isInteger(pid) &&
        (pid as number) >= 1 &&
        (pid as number) <= 2_147_483_647
          ? (pid as number)
          : null,
      dimensions: projectFields(
        ownValue(input, "dimensions"),
        dataset,
        authority,
        identityAuthority,
        name,
      ),
      attributes: projectFields(
        ownValue(input, "attributes"),
        dataset,
        authority,
        identityAuthority,
        name,
      ),
      error_message: null,
      error_stack: null,
      sample_rate:
        typeof sampleRate === "number" &&
        Number.isFinite(sampleRate) &&
        sampleRate > 0 &&
        sampleRate <= 1
          ? sampleRate
          : 1,
    };
    bindDiagnosticCapabilityAuthority(row, authority);
    bindDiagnosticIdentityAuthority(row, identityAuthority);
    return {
      ok: true,
      row,
    };
  } catch {
    return { ok: false, code: "invalid_span" };
  }
}

/** Project arbitrary diagnostic fields without invoking getters or coercion hooks. */
export function projectDiagnosticFields(
  input: unknown,
  dataset?: string,
  authority?: DiagnosticCapabilityAuthority,
  identityAuthority?: DiagnosticIdentityAuthority,
  eventName?: string,
): Record<string, unknown> {
  try {
    const inheritedAuthority = isObject(input)
      ? VALUE_AUTHORITIES.get(input)
      : undefined;
    const effectiveAuthority = validAuthority(authority) ?? inheritedAuthority;
    const inheritedIdentityAuthority = isObject(input)
      ? VALUE_IDENTITY_AUTHORITIES.get(input)
      : undefined;
    const effectiveIdentityAuthority =
      validIdentityAuthority(identityAuthority) ?? inheritedIdentityAuthority;
    const output = projectFields(
      input,
      dataset,
      effectiveAuthority,
      effectiveIdentityAuthority,
      eventName,
    );
    bindDiagnosticCapabilityAuthority(output, effectiveAuthority);
    bindDiagnosticIdentityAuthority(output, effectiveIdentityAuthority);
    return output;
  } catch {
    return {};
  }
}

/** Select a known event name without reflecting untrusted input. */
export function projectEventName(
  input: unknown,
  fallback = "diagnostic.unknown",
): string {
  return typeof input === "string" && EVENTS.has(input) ? input : fallback;
}

function projectFields(
  input: unknown,
  dataset?: string,
  authority?: DiagnosticCapabilityAuthority,
  identityAuthority?: DiagnosticIdentityAuthority,
  eventName?: string,
): Record<string, unknown> {
  if (!isObject(input)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of ownDataEntries(input, 64)) {
    if (key.length > 64) continue;
    const projected = projectField(
      key,
      value,
      dataset,
      authority,
      identityAuthority,
      eventName,
    );
    if (projected !== undefined) output[key] = projected;
  }
  return output;
}

function projectField(
  key: string,
  value: unknown,
  dataset?: string,
  authority?: DiagnosticCapabilityAuthority,
  identityAuthority?: DiagnosticIdentityAuthority,
  eventName?: string,
): unknown {
  const closedEnum = Object.hasOwn(PAYMENT_ENUMS, key)
    ? PAYMENT_ENUMS[key]
    : Object.hasOwn(ROUTER_ENUMS, key)
      ? ROUTER_ENUMS[key]
      : undefined;
  if (closedEnum)
    return typeof value === "string" && closedEnum.has(value) ? value : undefined;
  if (dataset === "tempo") {
    if (key === "prior_status")
      return typeof value === "string" && TEMPO_CLOSE_REPORT_PRIOR_STATUSES.has(value) ? value : undefined;
    const closeReportEvent = eventName === "tempo_session_close_report_written_off" ||
      eventName === "tempo_session_close_report_reopened";
    const payerExitEvent = eventName === "tempo_session_close_exit_resolved";
    if (closeReportEvent || payerExitEvent) {
      if (key === "obligation_id")
        return typeof value === "string" && UUID_RE.test(value) ? value : undefined;
      if (key === "channel_id")
        return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
      if ((closeReportEvent && (key === "amount_native" || key === "amount_forgone_native")) ||
        (payerExitEvent && key === "amount_at_stake_native"))
        return typeof value === "string" && DECIMAL_RE.test(value) ? value : undefined;
    }
  }
  if (BOOLEAN_FIELDS.has(key))
    return typeof value === "boolean" ? value : undefined;
  if (INTEGER_FIELDS.has(key))
    return isNonnegativeSafeInteger(value) ? value : undefined;
  if (HASH_FIELDS.has(key))
    return typeof value === "string" && HASH_RE.test(value) ? value : undefined;
  if (TRANSACTION_HASH_FIELDS.has(key))
    return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? value : undefined;
  if (URL_FIELDS.has(key)) return projectOrigin(value);
  if (IDENTITY_FIELDS.has(key)) return projectIdentity(key, identityAuthority);
  if (TOKEN_FIELDS.has(key)) return undefined;
  if (CAPABILITY_FIELDS.has(key)) return projectCapability(value, authority);
  if (CLIENT_VERSION_FIELDS.has(key)) return projectClientVersion(value);
  if (key === "client.protocol_version")
    return typeof value === "number" && CLIENT_PROTOCOL_VERSIONS.has(value)
      ? value
      : undefined;
  if (key === "route") return projectQualifiedRoute(value);
  if (key === "http.route" || key === "resource_path")
    return projectRouteTemplate(value);
  if (key === "status_code" || key === "http.status_code" || key === "source_status") {
    return Number.isInteger(value) &&
      (value as number) >= 100 &&
      (value as number) <= 599
      ? value
      : undefined;
  }
  if (key === "method" || key === "http.method") {
    if (typeof value !== "string") return undefined;
    if (METHODS.has(value)) return value;
    return key === "method" &&
      dataset === "tempo" &&
      (value === "charge" || value === "session")
      ? value
      : undefined;
  }
  if (key === "rail")
    return typeof value === "string" && RAILS.has(value) ? value : undefined;
  if (key === "stage")
    return typeof value === "string" && STAGES.has(value) ? value : undefined;
  if (key === "handler")
    return typeof value === "string" && HANDLERS.has(value) ? value : undefined;
  if (key === "dataset")
    return typeof value === "string" && DATASETS.has(value) ? value : undefined;
  if (key === "error.code" || key === "error_code" || key === "code") {
    if (typeof value !== "string") return undefined;
    return ERROR_CODES.has(value)
      ? value
      : key === "error.code" || key === "error_code"
        ? "unknown_error"
        : undefined;
  }
  if (
    key === "currency" ||
    key === "ask_currency" ||
    key === "asked_topup_currency"
  ) {
    return typeof value === "string" && CURRENCIES.has(value)
      ? value
      : undefined;
  }
  if (key === "amount") {
    return typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= Number.MAX_SAFE_INTEGER
      ? value
      : undefined;
  }
  if (key === "forecast.refund_native" || key === "drain.native") {
    if (isNonnegativeSafeInteger(value)) return value;
    return typeof value === "string" && DECIMAL_RE.test(value)
      ? value
      : undefined;
  }
  if (key === "event_id")
    return typeof value === "string" && STRIPE_EVENT_RE.test(value)
      ? value
      : undefined;
  if (key === "reject_reason")
    return value === "scanner_probe" ? value : undefined;
  if (key === "sanctions_region")
    return typeof value === "string" && SANCTIONS_REGIONS.has(value)
      ? value
      : undefined;
  return undefined;
}

function projectService(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  if (SERVICE_NAMES.has(value)) return value;
  if (value.startsWith("isolate-") && SLUG_RE.test(value.slice(8)))
    return value;
  return "unknown";
}

function projectServiceVersion(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 64 &&
    RELEASE_RE.test(value)
    ? value
    : "unknown";
}

function projectHost(value: unknown): string | null {
  if (value === "localhost") return value;
  return typeof value === "string" && MACHINE_ID_RE.test(value) ? value : null;
}

function validateIdentity(key: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (key === "dvm_slug") return SLUG_RE.test(value) ? value : undefined;
  return value.length <= 36 && UUID_RE.test(value) ? value : undefined;
}

function projectIdentity(
  key: string,
  authority: DiagnosticIdentityAuthority | undefined,
): string | undefined {
  return authority && AUTHORITY_IDENTITIES.get(authority)?.[key];
}

function projectCapability(
  value: unknown,
  authority: DiagnosticCapabilityAuthority | undefined,
): string | undefined {
  if (typeof value !== "string" || !CAPABILITY_RE.test(value)) return undefined;
  const allowed = authority && AUTHORITY_CAPABILITIES.get(authority);
  return allowed?.has(value) ? value : undefined;
}

function projectClientVersion(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 64 &&
    CLIENT_VERSION_RE.test(value)
    ? value
    : undefined;
}

function validAuthority(
  authority: DiagnosticCapabilityAuthority | undefined,
): DiagnosticCapabilityAuthority | undefined {
  return authority && AUTHORITY_CAPABILITIES.has(authority)
    ? authority
    : undefined;
}

function validIdentityAuthority(
  authority: DiagnosticIdentityAuthority | undefined,
): DiagnosticIdentityAuthority | undefined {
  return authority && AUTHORITY_IDENTITIES.has(authority)
    ? authority
    : undefined;
}

function projectOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      hostname === "localhost" ||
      isIP(hostname) !== 0 ||
      !isDnsName(hostname)
    ) {
      return undefined;
    }
    return `${parsed.protocol}//${hostname}`;
  } catch {
    return undefined;
  }
}

function projectQualifiedRoute(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 320) return undefined;
  const separator = value.indexOf(" ");
  if (separator <= 0) return undefined;
  const method = value.slice(0, separator);
  const template = projectRouteTemplate(value.slice(separator + 1));
  return METHODS.has(method) && template ? `${method} ${template}` : undefined;
}

function projectRouteTemplate(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length > 263 ||
    !value.startsWith("/") ||
    value.includes("?") ||
    value.includes("#") ||
    value.includes("@")
  ) {
    return undefined;
  }
  return ROUTE_TEMPLATES.find((template) => routeMatches(template, value));
}

function routeMatches(template: string, value: string): boolean {
  if (template === value) return true;
  const expected = template.split("/");
  const actual = value.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, index) => {
    if (segment.startsWith(":")) {
      return (
        actual[index].length > 0 &&
        (REDACTED_SEGMENT_RE.test(actual[index]) ||
          !actual[index].startsWith(":"))
      );
    }
    return segment === actual[index];
  });
}

function compareRouteTemplates(left: string, right: string): number {
  const leftParams = left
    .split("/")
    .filter((segment) => segment.startsWith(":")).length;
  const rightParams = right
    .split("/")
    .filter((segment) => segment.startsWith(":")).length;
  return (
    leftParams - rightParams ||
    right.length - left.length ||
    left.localeCompare(right)
  );
}

function isDnsName(value: string): boolean {
  return (
    value.length <= 253 &&
    value.split(".").every((label) => SLUG_RE.test(label))
  );
}

function isEpochMs(value: unknown): value is number {
  return isNonnegativeSafeInteger(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

function ownValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function ownDataEntries(
  input: object,
  limit: number,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor)) continue;
    entries.push([key, descriptor.value]);
    if (entries.length >= limit) break;
  }
  return entries;
}
