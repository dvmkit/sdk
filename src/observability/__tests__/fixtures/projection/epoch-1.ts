import type { SpanRow } from "../../../types";
import catalogue from "./catalogue-1.json";

const base: SpanRow = {
  span_id: "0000000000000001",
  trace_id: "00000000000000000000000000000001",
  parent_span_id: null,
  dataset: "platform",
  name: "diagnostic.unknown",
  level: "info",
  status: "ok",
  started_at_ms: 0,
  ended_at_ms: 0,
  service: "unknown",
  service_version: "unknown",
  host: null,
  pid: null,
  dimensions: {},
  attributes: {},
  error_message: null,
  error_stack: null,
  sample_rate: 1,
};

function fields(values: Record<string, unknown>, context: Partial<SpanRow> = {}): SpanRow {
  return { ...base, ...context, dimensions: values, attributes: values };
}

function fieldValues(keys: readonly string[], values: readonly unknown[], context?: Partial<SpanRow>): SpanRow[] {
  return values.map((value) => fields(Object.fromEntries(keys.map((key) => [key, value])), context));
}

function fieldsForEvents(events: readonly string[], values: Record<string, unknown>, dataset: SpanRow["dataset"]): SpanRow[] {
  return events.map((name) => fields(values, { name, dataset }));
}

const max = Number.MAX_SAFE_INTEGER;
const uuid = "ab000000-0000-0000-0000-000000000001";
const upperUuid = uuid.toUpperCase();
const longSlug = `a${"-".repeat(61)}0`;
const diagnosticIds = ["a", "A", "0", "_", ".", ":", "-", "A0_.:-".repeat(85) + "a0"];
const decimal = "9".repeat(78);
const hex = "a0".repeat(32);
const transactionHashes = [`0x${hex}`, `0x${hex.toUpperCase()}`, `0x${"0".repeat(64)}`];
const [transactionHash] = transactionHashes;
const nativeAmounts = ["0", "1", "1234567890", decimal];
const reportEvents = ["tempo_session_close_report_written_off", "tempo_session_close_report_reopened"];
const payerExit = { name: "tempo_session_close_exit_resolved", dataset: "tempo" } as const;
const checkoutPrefixes = ["cs_", "cs_test_", "cs_live_"];
const longVersionComponent = "1".repeat(60);
const longVersions = [`${longVersionComponent}.0.0`, `0.${longVersionComponent}.0`, `0.0.${longVersionComponent}`];
const shortCapability = "a";
const longCapability = "a" + "0_-".repeat(15) + "_0";
const shortOrigin = "http://a";
const longOrigin = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(49)}.example.com`;
const postgresEvents = [
  "job_messages_listen_lost",
  "job_messages_listen_connect_failed",
  "postgres_pool_error",
  "postgres_client_error",
];
const checkoutEvents = [
  "card_checkout_dispute_lost",
  "card_checkout_recovery_deferred",
  "card_checkout_session_permission_denied",
  "card_checkout_session_missing",
];
const refundEvents = [
  "card_charge_stranded_refunded",
  "card_charge_unsettled",
  "card_refund_expiry_failed",
  "card_refund_pending",
  "card_refund_sweep",
  "card_refund_sweep_step_failed",
];
const facilitatorEvents = ["x402_facilitator_extension_response", "x402_facilitator_request_refused"];
const shutdownClaim = { name: "x402_shutdown_claim_incomplete", dataset: "x402" } as const;
const errorKeys = ["code", "error_code", "error.code"];
const booleanValues = Object.fromEntries(catalogue.booleanFields.map((key) => [key, false]));
const integerValues = Object.fromEntries(catalogue.integerFields.map((key) => [key, 0]));
const fullFields = {
  ...booleanValues,
  ...integerValues,
  ...Object.fromEntries(catalogue.hashFields.map((key) => [key, hex])),
  ...Object.fromEntries(catalogue.transactionHashFields.map((key) => [key, transactionHash])),
  ...Object.fromEntries(catalogue.urlFields.map((key) => [key, shortOrigin])),
  "client.version": "0.0.0",
  "client.protocol_version": 1,
  route: "GET /",
  "http.route": "/",
  resource_path: "/",
  status_code: 100,
  "http.status_code": 100,
  source_status: 100,
  method: "GET",
  "http.method": "GET",
  rail: "cashu",
  channel: "job",
  stage: "input",
};

export const epoch1 = {
  catalogue,
  rows: {
    events: catalogue.events.map((name) => ({ ...base, name })),
    datasets: catalogue.datasets.map((dataset) =>
      fields({ dataset }, { dataset: dataset as SpanRow["dataset"] }),
    ),
    levels: catalogue.levels.map((level) => ({ ...base, level: level as SpanRow["level"] })),
    statuses: catalogue.statuses.map((status) => ({ ...base, status: status as SpanRow["status"] })),
    services: ["platform-api", "router", "admin", "unknown", "isolate-a", "isolate-0", "isolate-0a", `isolate-${longSlug}`]
      .map((service) => ({ ...base, service })),
    releases: ["0.0.0", "v1.2.3", "1.2.3-rc.4", "v1.2.3-rc.4", "abcdef0", "0".repeat(7), "a".repeat(40), ...longVersions, `v${"9".repeat(59)}.0.0`, `v1.2.3-rc.${"9".repeat(54)}`, "v01.02.03-rc.00", "dev", "test", "unknown"]
      .map((service_version) => ({ ...base, service_version })),
    hosts: ["localhost", "0".repeat(12), "a".repeat(12), "f".repeat(32), "a0".repeat(16)].map((host) => ({ ...base, host })),
    envelopeBounds: [
      { ...base, pid: 1, sample_rate: Number.MIN_VALUE },
      { ...base, sample_rate: 0.75 },
      { ...base, sample_rate: 1 - Number.EPSILON / 2 },
      { ...base, span_id: "0123456789abcdef", trace_id: "0123456789abcdef".repeat(2),
        parent_span_id: "abcdef0123456789", ended_at_ms: max },
      {
        ...base, span_id: "ffffffffffffffff", trace_id: "f".repeat(32),
        parent_span_id: "0000000000000001", pid: 2_147_483_647,
        started_at_ms: max, ended_at_ms: max,
      },
    ],
    routeTemplates: catalogue.routeTemplates.map((template) =>
      fields({ route: `GET ${template}`, "http.route": template, resource_path: template }),
    ),
    methods: catalogue.methods.map((method) => fields({ method, "http.method": method, route: `${method} /` })),
    tempoMethods: fieldValues(["method"], ["charge", "session"], { dataset: "tempo" }),
    errorCodes: fieldValues(errorKeys, catalogue.errorCodes),
    postgresErrorCodes: postgresEvents.flatMap((name) =>
      fieldValues(errorKeys, catalogue.postgresErrorCodes, { name }),
    ),
    currencies: fieldValues(["currency", "ask_currency", "asked_topup_currency"], catalogue.currencyTokens),
    booleans: [fields(booleanValues), fieldValues(catalogue.booleanFields, [true])[0]],
    integers: [fields(integerValues), fieldValues(catalogue.integerFields, [max])[0]],
    fieldCountLimit: [fields(Object.fromEntries(Object.entries(fullFields).slice(0, 64)))],
    hashes: fieldValues(catalogue.hashFields, ["AB".repeat(8), "a0".repeat(8), hex, "AB0f".repeat(16)]),
    transactionHashes: fieldValues(catalogue.transactionHashFields, transactionHashes),
    origins: fieldValues(catalogue.urlFields, [shortOrigin, longOrigin, "https://0.example.com", "http://0a-b2.example.com"]),
    identities: [
      fields({ dvm_id: uuid, builder_id: upperUuid, dvm_slug: "a" }),
      fields({ dvm_id: upperUuid, builder_id: uuid, dvm_slug: longSlug }),
      fields({ dvm_resolution: "none", dvm_slug: "0" }),
    ],
    capabilities: [
      ...fieldValues(catalogue.capabilityFields, [shortCapability, longCapability]),
      fields({ capabilities: [shortCapability, ...Array(63).fill(longCapability)] }, { name: "x402_rail_missing" }),
    ],
    clientVersions: fieldValues(catalogue.clientVersionFields, ["0.0.0", "1.2.3-rc.0", "1.2.3-rc.12", `1.2.3-rc.${"9".repeat(55)}`, ...longVersions]),
    enumFields: [
      ...fieldValues(["client.protocol_version"], catalogue.clientProtocolVersions),
      ...fieldValues(["rail"], catalogue.rails),
      ...fieldValues(["stage"], catalogue.stages),
      ...fieldValues(["handler"], catalogue.handlers),
      ...fieldValues(["channel"], catalogue.capabilityChannels),
      ...fieldValues(["reason"], catalogue.paymentSkipReasons),
      ...fieldValues(["cause"], catalogue.denominationCauses),
      ...fieldValues(["source_failure"], catalogue.fxSourceFailures),
      ...fieldValues(["failure_category"], catalogue.paymentFailureCategories),
      ...fieldValues(["failure_stage"], catalogue.paymentFailureStages),
      ...fieldValues(["phase"], catalogue.paymentPhases),
      ...fieldValues(["sanctions_region"], catalogue.sanctionsRegions),
      ...fieldValues(["submit_identity_source"], catalogue.submitIdentitySources),
      ...fieldValues(["funded_runtime_reclaim"], catalogue.fundedRuntimeReclaims),
      ...fieldValues(["suspended_reclaim", "suspended_admin"], catalogue.suspensionReasons),
      ...fieldValues(["prior_status"], catalogue.tempoCloseReportPriorStatuses, { dataset: "tempo" }),
    ],
    additionalFields: [
      ...fieldValues(["status_code", "http.status_code", "source_status"], [100, 599]),
      ...fieldValues(["amount"], [0, Number.MIN_VALUE, 0.5, 2 ** 52 - 0.5, max]),
      ...fieldValues(["forecast.refund_native", "drain.native"], [0, max, ...nativeAmounts]),
      ...fieldValues(["event_id"], ["evt_A", "evt_0", `evt_${"aB0".repeat(21)}z`]),
      fields({ reject_reason: "scanner_probe" }),
      ...fieldValues(
        ["report_kind"],
        ["job_terminal", "revenue", "cost", "deposit", "refund", "release", "drain", "payout", "expiry_release"],
        { name: "platform_report_rejected" },
      ),
      ...fieldValues(["reason"], ["timeout", "failed", "lock_unavailable"], shutdownClaim),
      ...fieldValues(["unclaimed_channels"], [null, 0, max], shutdownClaim),
      ...fieldValues(["unclaimed_amount_native"], [null, ...nativeAmounts], shutdownClaim),
      fields({
        override: "DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true",
        excess_methods: [...catalogue.nwcExcessMethods, "unknown_method"],
      }, { name: "lightning_receive_allow_spend_enabled", dataset: "lightning" }),
      fields({
        variables: Array.from({ length: 64 }, (_, index) => index === 63
          ? `DVMKIT_X402_${"A0_".repeat(21)}Z`
          : `DVMKIT_X402_${index}`),
      }, { name: "x402_env_ignored", dataset: "x402" }),
    ],
    cardCheckout: [
      ...fieldsForEvents(checkoutEvents, { payment_intent: "pi_0", retry_after_ms: 0 }, "stripe"),
      ...fieldsForEvents(checkoutEvents, { payment_intent: "pi__" }, "stripe"),
      ...fieldsForEvents(checkoutEvents, { payment_intent: `pi_${"A_0z".repeat(32)}`, retry_after_ms: max }, "stripe"),
      ...checkoutPrefixes.flatMap((prefix) => [
        ...["a", "Z", "0"].flatMap((suffix) =>
          fieldsForEvents(checkoutEvents, { session_id: prefix + suffix }, "stripe"),
        ),
        ...fieldsForEvents(checkoutEvents, { session_id: `${prefix}${"aB0".repeat(42)}z9` }, "stripe"),
      ]),
    ],
    cardRefund: refundEvents.flatMap((name) => {
      const context = { name, dataset: "stripe" } as const;
      return [
        ...fieldValues(["credit_id", "drain_id", "challenge_id"], diagnosticIds, context),
        ...fieldValues(["payment_intent"], ["pi_a", "pi_A", "pi_A0", "pi_0", `pi_${"zA0".repeat(21)}9`], context),
        ...fieldValues(["stage"], ["plan", "refund", "disputes", "expiry", "retry", "stranded"], context),
        ...fieldValues(["refund_status"], ["planned", "pending", "requires_action", "succeeded", "failed", "canceled", "rejected"], context),
        ...fieldValues(["frozen", "unfrozen", "expiry_refunds", "completed", "pending", "stranded_refunds"], [0, max], context),
      ];
    }),
    facilitator: facilitatorEvents.flatMap((name) => {
      const context = { name, dataset: "x402" } as const;
      return [
        ...fieldValues(["extension", "extension_status"], ["a", "Z", `Z${"aB0_.-".repeat(10)}0_-`], context),
        ...fieldValues(["extension_rejected_reason", "facilitator_message"], ["!", `!${Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("").repeat(2)}${" ~".repeat(32)}!`], context),
      ];
    }),
    tempoDrains: ["tempo_drain_booked_as_refunded", "tempo_drain_released"].flatMap((name) => {
      const context = { name, dataset: "tempo" } as const;
      return [
        fields({ drain_reference: `sha256:${hex}` }, context),
        ...fieldValues(["channel_id"], transactionHashes, context),
        ...fieldValues(["credit_id", "drain_id"], diagnosticIds, context),
        ...fieldValues(["amount_native"], [null, ...nativeAmounts], context),
      ];
    }),
    tempoCloseReports: reportEvents.flatMap((name) => {
      const context = { name, dataset: "tempo" } as const;
      return [
        ...fieldValues(["channel_id"], transactionHashes, context),
        ...fieldValues(["obligation_id"], [uuid, upperUuid], context),
        ...fieldValues(["amount_native", "amount_forgone_native"], nativeAmounts, context),
      ];
    }),
    tempoPayerExit: [
      ...fieldValues(["channel_id"], transactionHashes, payerExit),
      ...fieldValues(["obligation_id"], [uuid, upperUuid], payerExit),
      ...fieldValues(["amount_at_stake_native"], nativeAmounts, payerExit),
    ],
  },
};

// Whitespace-only normalisation at a truncation boundary does not bump the
// epoch when it removes only characters the rule would trim on a second pass.
// The corpus keeps the canonical projected form.
export const facilitatorTruncation = {
  rows: {
    facilitatorTruncation: facilitatorEvents.map((name) =>
      fields({
        extension_rejected_reason: "a".repeat(255),
        facilitator_message: "a".repeat(255),
      }, { name, dataset: "x402" }),
    ),
  },
};

export const settlementUnconfirmed = {
  catalogue: {
    ...catalogue,
    paymentFailureCategories: [...catalogue.paymentFailureCategories, "settlement_unconfirmed"],
  },
  rows: {
    failureCategory: fieldValues(["failure_category"], ["settlement_unconfirmed"]),
  },
};
