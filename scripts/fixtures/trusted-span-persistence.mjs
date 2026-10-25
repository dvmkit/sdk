import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import {
  bindDiagnosticCapabilityAuthority,
  bindDiagnosticIdentityAuthority,
  createDiagnosticCapabilityAuthority,
  DbTransport,
  extendDiagnosticIdentityAuthority,
  initLoggers,
  insertSpanBatch,
  pinDimension,
  SpanWriter,
  withTraceContext,
} from "@dvmkit/sdk/internal";
import pg from "pg";

const adminUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_URL is required for the trusted span persistence probe");

const databaseName = `dvmkit_test_sdk_persist_${process.pid}_${randomBytes(4).toString("hex")}`;
const targetUrl = new URL(adminUrl);
targetUrl.pathname = `/${databaseName}`;

const admin = new pg.Pool({ connectionString: adminUrl });
let target;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  target = new pg.Pool({ connectionString: targetUrl.toString() });
  await target.query(`
    CREATE SCHEMA observability;
    CREATE TABLE observability.spans (
      span_id text NOT NULL,
      trace_id text NOT NULL,
      parent_span_id text,
      dataset text NOT NULL,
      name text NOT NULL,
      level text NOT NULL,
      status text NOT NULL,
      started_at_ms bigint NOT NULL,
      ended_at_ms bigint NOT NULL,
      service text NOT NULL,
      service_version text NOT NULL,
      host text,
      pid integer,
      dimensions jsonb NOT NULL,
      attributes jsonb NOT NULL,
      error_message text,
      error_stack text,
      sample_rate double precision NOT NULL,
      PRIMARY KEY (dataset, span_id)
    )
  `);

  const trustedDvmId = "123e4567-e89b-12d3-a456-426614174000";
  const trustedBuilderId = "123e4567-e89b-12d3-a456-426614174001";
  const spoofDvmId = "223e4567-e89b-12d3-a456-426614174000";
  const spoofBuilderId = "223e4567-e89b-12d3-a456-426614174001";
  const capabilityAuthority = createDiagnosticCapabilityAuthority(["transcribe"]);
  const otherAppAuthority = createDiagnosticCapabilityAuthority(["summarize"]);
  let identityAuthority = extendDiagnosticIdentityAuthority(undefined, "dvm_id", trustedDvmId);
  identityAuthority = extendDiagnosticIdentityAuthority(identityAuthority, "dvm_slug", "trusted-app");
  identityAuthority = extendDiagnosticIdentityAuthority(
    identityAuthority,
    "builder_id",
    trustedBuilderId,
  );

  const trusted = span("1111111111111111", {
    dimensions: {
      dvm_id: spoofDvmId,
      dvm_slug: "spoof-app",
      builder_id: spoofBuilderId,
      capability: "transcribe",
      authorization: "SENTINEL_AUTHORIZATION",
    },
    attributes: {
      dvm_id: spoofDvmId,
      dvm_slug: "spoof-app",
      builder_id: spoofBuilderId,
      capability: "transcribe",
      count: 7,
      url: "https://127.0.0.1/private?token=SENTINEL_TOKEN",
      customer: "SENTINEL_CUSTOMER",
    },
    error_message: "SENTINEL_ERROR",
  });
  bindDiagnosticCapabilityAuthority(trusted, capabilityAuthority);
  bindDiagnosticIdentityAuthority(trusted, identityAuthority);

  const unbound = span("2222222222222222", {
    dimensions: {
      dvm_id: trustedDvmId,
      dvm_slug: "trusted-app",
      builder_id: trustedBuilderId,
      capability: "transcribe",
    },
    attributes: { capability: "transcribe", count: 2 },
  });

  const serialized = JSON.parse(JSON.stringify(trusted));
  serialized.span_id = "3333333333333333";

  const forged = span("4444444444444444", {
    dimensions: { dvm_id: trustedDvmId, capability: "transcribe" },
    attributes: { builder_id: trustedBuilderId, capability: "transcribe", count: 4 },
  });
  const forgedAuthority = /** @type {any} */ (Object.freeze({}));
  bindDiagnosticCapabilityAuthority(forged, forgedAuthority);
  bindDiagnosticIdentityAuthority(forged, forgedAuthority);

  const crossApp = span("5555555555555555", {
    dimensions: { capability: "transcribe" },
    attributes: { capability: "transcribe", count: 5 },
  });
  bindDiagnosticCapabilityAuthority(crossApp, otherAppAuthority);

  await insertSpanBatch(target, [trusted, unbound, serialized, forged, crossApp]);

  const result = await target.query(
    `SELECT span_id, dimensions, attributes, error_message, error_stack
       FROM observability.spans
      ORDER BY span_id`,
  );
  assert.deepEqual(result.rows, [
    {
      span_id: "1111111111111111",
      dimensions: {
        dvm_id: trustedDvmId,
        dvm_slug: "trusted-app",
        builder_id: trustedBuilderId,
        capability: "transcribe",
      },
      attributes: {
        dvm_id: trustedDvmId,
        dvm_slug: "trusted-app",
        builder_id: trustedBuilderId,
        capability: "transcribe",
        count: 7,
      },
      error_message: null,
      error_stack: null,
    },
    {
      span_id: "2222222222222222",
      dimensions: {},
      attributes: { count: 2 },
      error_message: null,
      error_stack: null,
    },
    {
      span_id: "3333333333333333",
      dimensions: {},
      attributes: { count: 7 },
      error_message: null,
      error_stack: null,
    },
    {
      span_id: "4444444444444444",
      dimensions: {},
      attributes: { count: 4 },
      error_message: null,
      error_stack: null,
    },
    {
      span_id: "5555555555555555",
      dimensions: {},
      attributes: { count: 5 },
      error_message: null,
      error_stack: null,
    },
  ]);
  assert.equal(JSON.stringify(result.rows).includes("SENTINEL"), false);

  const writer = new SpanWriter(new DbTransport(target));
  const loggers = initLoggers(writer, "router");
  await withTraceContext({
    traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    spanId: null,
    dimensions: {},
    service: "router",
  }, () => loggers.platform.span("router.proxy", { dvm_resolution: "spoof" }, () => {
    pinDimension("dvm_resolution", "none");
  }));
  await writer.shutdown();
  const pinned = await target.query(
    "SELECT dimensions, attributes FROM observability.spans WHERE trace_id = $1",
    ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  );
  assert.deepEqual(pinned.rows, [{
    dimensions: { dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  }]);

  const unboundMark = span("6666666666666666", {
    dimensions: { dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  });
  const marked = bindDiagnosticIdentityAuthority(span("7777777777777777", {
    dimensions: { dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  }), extendDiagnosticIdentityAuthority(undefined, "dvm_resolution", "none"));
  const serializedMark = JSON.parse(JSON.stringify(marked));
  const unrelatedMark = bindDiagnosticIdentityAuthority(span("8888888888888888", {
    dimensions: { dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  }), identityAuthority);
  const conflictingMark = bindDiagnosticIdentityAuthority(span("9999999999999999", {
    dimensions: { dvm_id: spoofDvmId, dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  }), extendDiagnosticIdentityAuthority(identityAuthority, "dvm_resolution", "none"));
  const forgedMark = bindDiagnosticIdentityAuthority(span("aaaaaaaaaaaaaaaa", {
    dimensions: { dvm_resolution: "none" },
    attributes: { dvm_resolution: "none" },
  }), forgedAuthority);

  await insertSpanBatch(target, [unboundMark, serializedMark, unrelatedMark, conflictingMark, forgedMark]);
  const marks = await target.query(
    `SELECT span_id, dimensions, attributes FROM observability.spans
      WHERE span_id = ANY($1::text[]) ORDER BY span_id`,
    [["6666666666666666", "7777777777777777", "8888888888888888", "9999999999999999", "aaaaaaaaaaaaaaaa"]],
  );
  assert.deepEqual(marks.rows, [
    { span_id: "6666666666666666", dimensions: {}, attributes: {} },
    { span_id: "7777777777777777", dimensions: {}, attributes: {} },
    { span_id: "8888888888888888", dimensions: {}, attributes: {} },
    { span_id: "9999999999999999", dimensions: { dvm_id: trustedDvmId }, attributes: {} },
    { span_id: "aaaaaaaaaaaaaaaa", dimensions: {}, attributes: {} },
  ]);
} finally {
  if (target) await target.end();
  try {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
  } finally {
    await admin.end();
  }
}

/** @param {string} spanId @param {Record<string, unknown>} [overrides] */
function span(spanId, overrides = {}) {
  return {
    span_id: spanId,
    trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parent_span_id: null,
    dataset: "platform",
    name: "dvm.request",
    level: "info",
    status: "ok",
    started_at_ms: 1_700_000_000_000,
    ended_at_ms: 1_700_000_000_001,
    service: "platform-api",
    service_version: "v1.0.0",
    host: null,
    pid: null,
    dimensions: {},
    attributes: {},
    error_message: null,
    error_stack: null,
    sample_rate: 1,
    ...overrides,
  };
}
