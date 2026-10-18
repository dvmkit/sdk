import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStdoutLogger } from "../../sdk/logger";
import { diagnosticConsole } from "../diagnostic-console";
import { projectDiagnosticFields, projectSpanRow } from "../projection";
import { DbTransport, HttpTransport, SpanWriter } from "../span-writer";
import { formatSpanLine } from "../stdout-sink";
import type { SpanRow } from "../types";
import { setEmitter, withSpan } from "../with-span";

const approved = {
  reason: "denomination_unavailable",
  cause: "rate_unavailable",
  source_failure: "http_error",
  source_status: 429,
  job_id_hash: "026ab639c21df8aa80e5789370a9db1b8b524b776fd8a0c2ba71efb377ecc7d9",
  transaction_hash: `0x${"ab".repeat(32)}`,
  failure_category: "unknown",
  failure_stage: "replay_store",
  phase: "upfront",
};

function span(attributes: Record<string, unknown>): SpanRow {
  return {
    span_id: "1111111111111111", trace_id: "22222222222222222222222222222222",
    parent_span_id: null, dataset: "tempo", name: "tempo.verify_credential",
    level: "warn", status: "error", started_at_ms: 1, ended_at_ms: 2,
    service: "unknown", service_version: "test", host: null, pid: 1,
    dimensions: {}, attributes, error_message: "SENTINEL_EXCEPTION",
    error_stack: "SENTINEL_STACK", sample_rate: 1,
  };
}

afterEach(() => {
  setEmitter(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("payment diagnostic catalogue", () => {
  it.each(["0xref", "ab".repeat(32), `0x${"ab".repeat(31)}`, `0x${"ab".repeat(33)}`, `0x${"gg".repeat(32)}`])("omits an invalid transaction hash (%s)", (transaction_hash) => {
    expect(projectDiagnosticFields({ transaction_hash })).toEqual({});
  });

  it.each([
    ["reason", ["credit_or_draw_missing", "draw_not_pending", "draw_job_mismatch", "rail_mismatch", "channel_binding_mismatch", "denomination_unavailable", "topup_cap_unavailable", "topup_cap_currency_mismatch", "unknown"]],
    ["cause", ["no_msats", "sub_micro", "unsupported_currency", "rate_unavailable", "rate_stale_refused", "unknown"]],
    ["source_failure", ["network_error", "http_error", "invalid_body", "no_usable_rate", "missing_currency", "unknown"]],
    ["failure_category", ["invalid_challenge", "malformed_credential", "payment_expired", "verification_failed", "insufficient_funds", "invalid_signature", "unsupported_method", "replay_detected", "ledger_refused", "settlement_failed", "unsupported_version", "unknown"]],
    ["failure_stage", ["verifier", "broadcast", "verifier_broadcast", "replay_store", "funding_ledger", "unknown"]],
    ["phase", ["upfront", "mid-job"]],
  ] as const)("retains the independently documented %s values", (field, values) => {
    for (const value of values) expect(projectDiagnosticFields({ [field]: value })).toEqual({ [field]: value });
  });

  it.each(["SENTINEL", {}, ["rate_unavailable"], new String("rate_unavailable"), new Error("SENTINEL"), null, 42])("omits unrecognized or nonprimitive payment fields (%j)", (value) => {
    expect(projectDiagnosticFields(Object.fromEntries(Object.keys(approved).map((key) => [key, value])))).toEqual({});
  });

  it.each([100, 429, 599])("retains numeric HTTP source status %s", (source_status) => {
    expect(projectDiagnosticFields({ source_status })).toEqual({ source_status });
  });

  it.each([99, 600, 429.5, NaN, Infinity, "429", new Number(429), { valueOf: () => 429 }])("omits invalid source status %s", (source_status) => {
    expect(projectDiagnosticFields({ source_status })).toEqual({});
  });

  it("does not invoke getters, toJSON, or coercion hooks in payment fields", () => {
    const getter = vi.fn(() => "rate_unavailable");
    const coercion = vi.fn(() => "rate_unavailable");
    const fields = {
      reason: { toJSON: coercion }, cause: { toString: coercion },
      failure_category: new Proxy({}, { get: getter }),
    };
    Object.defineProperty(fields, "failure_stage", { get: getter, enumerable: true });
    Object.defineProperty(fields, "source_failure", { get: getter, enumerable: true });
    Object.defineProperty(fields, "source_status", { get: getter, enumerable: true });
    expect(projectDiagnosticFields(fields)).toEqual({});
    expect(getter).not.toHaveBeenCalled();
    expect(coercion).not.toHaveBeenCalled();
  });

  it.each(["console", "sdk logger", "span stdout", "span emitter", "buffer", "http", "database"].flatMap((sink) => [ [sink, false], [sink, true] ] as const))("preserves the allowlist at the %s sink (hostile enums: %s)", async (sink, hostile) => {
    const expected = hostile ? {} : approved;
    const attributes: Record<string, unknown> = {
      ...Object.fromEntries(Object.entries(approved).map(([key, value]) => [key, hostile ? { value, secret: "SENTINEL" } : value])), error_name: "SENTINEL_NAME", error_message: "SENTINEL_MESSAGE",
      detail: "https://example.com/SENTINEL?token=SENTINEL", headers: { authorization: "SENTINEL" },
      credential: { proof: "SENTINEL" }, nested: { cause: "SENTINEL" },
      job_id: "SENTINEL_JOB", credit_id: "SENTINEL_CREDIT", draw_id: "SENTINEL_DRAW",
    };
    attributes.cycle = attributes;
    const row = span(attributes);
    let output: unknown;
    if (sink === "console") {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      diagnosticConsole.warn({ event: "tempo_credential_rejected", ...attributes });
      output = JSON.parse(String(warn.mock.calls[0][0]));
      expect(output).toMatchObject(expected);
    } else if (sink === "sdk logger") {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      createStdoutLogger().warn("SENTINEL_MESSAGE", attributes);
      output = JSON.parse(String(warn.mock.calls[0][0]));
      expect(output).toMatchObject(expected);
    } else if (sink === "span stdout") {
      output = formatSpanLine(row);
      for (const [key, value] of Object.entries(expected)) expect(output).toContain(`${key}=${value}`);
    } else if (sink === "span emitter") {
      const rows: SpanRow[] = [];
      setEmitter((safe) => rows.push(safe));
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      await withSpan({ dataset: "tempo", name: "tempo.verify_credential", attrs: attributes }, () => undefined);
      output = rows;
      expect(rows[0].attributes).toEqual(expected);
    } else if (sink === "buffer") {
      const rows: SpanRow[] = [];
      const writer = new SpanWriter({ send: async (batch) => { rows.push(...batch); } }, 60_000);
      try {
        writer.enqueue(row);
        await writer.flush();
        output = rows;
        expect(rows[0].attributes).toEqual(expected);
      } finally { await writer.shutdown(); }
    } else if (sink === "http") {
      const fetch = vi.fn(async () => new Response("", { status: 200 }));
      vi.stubGlobal("fetch", fetch);
      await new HttpTransport("https://example.com", "test-token").send([row]);
      output = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect((output as { spans: SpanRow[] }).spans[0].attributes).toEqual(expected);
    } else {
      const query = vi.fn(async () => ({ rows: [] }));
      await new DbTransport({ query } as unknown as Pool).send([row]);
      output = query.mock.calls;
      expect(JSON.stringify(output)).toContain(JSON.stringify(JSON.stringify(expected)));
    }
    expect(JSON.stringify(output)).not.toContain("SENTINEL");
    if (hostile) for (const key of Object.keys(approved)) expect(JSON.stringify(output)).not.toContain(key);
  });
});

it.each([
  "tempo_session_close_report_reopened",
  "tempo_session_close_report_written_off",
])("preserves bounded audit fields only for %s while rejecting arbitrary text", async (event) => {
  const captured: SpanRow[] = [];
  setEmitter(row => captured.push(row));
  const attributes = {
    obligation_id: "11111111-1111-4111-8111-111111111111",
    channel_id: `0x${"3a".repeat(32)}`,
    prior_status: "no_report",
    written_off: true,
    amount_native: "9007199254740993",
    amount_forgone_native: "9007199254740993",
  };
  await withSpan({ dataset: "tempo", name: event, attrs: { ...attributes, amount_at_stake_native: "9007199254740993" } }, async () => undefined);
  expect(captured).toEqual([expect.objectContaining({
    name: event, attributes,
  })]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  diagnosticConsole.warn({ dataset: "tempo", event, ...attributes, amount_at_stake_native: "9007199254740993" });
  expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event, level: "warn", dataset: "tempo", ...attributes });
  expect(projectDiagnosticFields({
    obligation_id: "private free text", channel_id: "not-a-channel", prior_status: "arbitrary text",
    written_off: "yes", amount_native: "1e9", amount_forgone_native: "-1",
  }, "tempo", undefined, undefined, event)).toEqual({});
});

it("drops close-report identifiers and amounts on another Tempo event", async () => {
  const attributes = {
    channel_id: `0x${"3a".repeat(32)}`,
    obligation_id: "11111111-1111-4111-8111-111111111111",
    amount_native: "9007199254740993",
    amount_forgone_native: "9007199254740993",
    amount_at_stake_native: "9007199254740993",
    count: 1,
  };
  expect(projectDiagnosticFields(attributes, "tempo")).toEqual({ count: 1 });
  const event = "tempo_session_drain_finalized";
  expect(projectSpanRow({ ...span(attributes), name: event })).toEqual({
    ok: true, row: expect.objectContaining({ name: event, attributes: { count: 1 } }),
  });
  const captured: SpanRow[] = [];
  setEmitter(row => captured.push(row));
  await withSpan({ dataset: "tempo", name: event, attrs: attributes }, async () => undefined);
  expect(captured).toEqual([expect.objectContaining({ name: event, attributes: { count: 1 } })]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  diagnosticConsole.warn({ dataset: "tempo", event, ...attributes });
  expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({
    event, level: "warn", dataset: "tempo", count: 1,
  });
});


it("retains only the payer-exit report identifiers and amount", async () => {
  const event = "tempo_session_close_exit_resolved";
  const expected = {
    channel_id: `0x${"3a".repeat(32)}`,
    obligation_id: "11111111-1111-4111-8111-111111111111",
    amount_at_stake_native: "9007199254740993",
  };
  const attributes = { ...expected, drain_id: "private-drain", amount_native: "123", amount_forgone_native: "456" };
  const captured: SpanRow[] = [];
  setEmitter(row => captured.push(row));
  await withSpan({ dataset: "tempo", name: event, attrs: attributes }, async () => undefined);
  expect(captured).toEqual([expect.objectContaining({ name: event, attributes: expected })]);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  diagnosticConsole.warn({ dataset: "tempo", event, ...attributes });
  expect(JSON.parse(String(warn.mock.calls[0]![0]))).toEqual({ event, level: "warn", dataset: "tempo", ...expected });
  expect(projectDiagnosticFields({ channel_id: "not-a-channel", obligation_id: "not-a-uuid",
    amount_at_stake_native: "-1" }, "tempo", undefined, undefined, event)).toEqual({});
});
