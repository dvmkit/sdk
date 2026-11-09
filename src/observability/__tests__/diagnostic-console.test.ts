import { afterEach, describe, expect, it, vi } from "vitest";

import { diagnosticConsole, emitDiagnostic } from "../diagnostic-console";

describe("diagnosticConsole", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("projects runtime fields before console serialization", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getter = vi.fn(() => "SENTINEL_GETTER");
    const fields: Record<string, unknown> = {
      event: "dvm.request",
      level: "warn",
      facilitator_url: "https://pay.example.com/private/SENTINEL_PATH?token=SENTINEL",
    };
    fields.cycle = fields;
    Object.defineProperty(fields, "authorization", {
      enumerable: true,
      get: getter,
    });

    expect(() => diagnosticConsole.warn(fields)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "dvm.request",
      level: "warn",
      facilitator_url: "https://pay.example.com",
    });
  });

  it("never invokes accessors while naming excess receive permissions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const getter = vi.fn(() => "pay_keysend");
    const methods = ["pay_invoice", "sign_message", "SENTINEL_SECRET"];
    Object.defineProperty(methods, "3", { enumerable: true, get: getter });

    diagnosticConsole.warn({
      event: "lightning_receive_allow_spend_enabled",
      override: "DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true",
      excess_methods: methods,
    });

    expect(getter).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: "lightning_receive_allow_spend_enabled",
      level: "warn",
      override: "DVMKIT_NWC_RECEIVE_ALLOW_SPEND=true",
      excess_methods: ["pay_invoice", "sign_message", "unknown_method"],
    });
  });

  it("does not treat caller text as an event name", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    diagnosticConsole.error("SENTINEL_CUSTOMER_TEXT");

    expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toEqual({
      event: "diagnostic.message",
      level: "error",
    });
  });

  it.each(["57P01", "08006", "ECONNRESET", "ETIMEDOUT"])(
    "retains connection code %s only on Postgres connection events",
    (code) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      for (const event of ["postgres_client_error", "postgres_pool_error", "job_messages_listen_lost", "job_messages_listen_connect_failed"]) {
        emitDiagnostic("error", event, { error_code: code, error: "SENTINEL_SECRET" });
        expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toEqual({ event, level: "error", error_code: code });
      }
      emitDiagnostic("error", "admin_lock_state_unavailable", { error_code: code });
      expect(JSON.parse(String(error.mock.calls.at(-1)?.[0]))).toEqual({
        event: "admin_lock_state_unavailable", level: "error", error_code: "unknown_error",
      });
    },
  );

  it("retains amended static events and approved lowercase/numeric aliases", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    diagnosticConsole.log({
      level: "credit_draw_reconciled",
      currency: "usd",
      durationMs: 12,
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "credit_draw_reconciled",
      level: "info",
      currency: "usd",
      durationMs: 12,
    });
  });

  it("swallows sink failures", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("sink unavailable");
    });

    expect(() => diagnosticConsole.warn({ level: "warning" })).not.toThrow();
  });

  // The block list a platform refuses traffic from; the log may name these
  // regions and nothing else.
  const SANCTIONED_REGIONS = [
    "IR",
    "KP",
    "CU",
    "RU",
    "BY",
    "UA-43",
    "UA-40",
    "UA-14",
    "UA-09",
  ];

  it.each(SANCTIONED_REGIONS)(
    "keeps the refused region %s and its error code on a router.proxy line",
    (region) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      emitDiagnostic("log", "router.proxy", {
        status_code: 451,
        error_code: "region_unavailable",
        sanctions_region: region,
      });

      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
        event: "router.proxy",
        level: "info",
        status_code: 451,
        error_code: "region_unavailable",
        sanctions_region: region,
      });
    },
  );

  it.each([
    ["an unlisted country", "US"],
    ["an unlisted subdivision of a listed country", "UA-30"],
    ["a lowercase code", "ir"],
    ["a free-form place", "Tehran, IR"],
    ["a non-string", 98],
  ])("drops %s from sanctions_region", (_label, region) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    emitDiagnostic("log", "router.proxy", {
      status_code: 451,
      sanctions_region: region,
    });

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "router.proxy",
      level: "info",
      status_code: 451,
    });
  });

  it.each([
    ["error", "sanctions_ip_data_load_failed"],
    ["error", "sanctions_ip_data_incomplete"],
    ["warn", "sanctions_ip_data_stale"],
  ] as const)("names the %s event %s", (level, event) => {
    const sink = vi.spyOn(console, level).mockImplementation(() => undefined);

    emitDiagnostic(level, event);

    expect(JSON.parse(String(sink.mock.calls[0]?.[0]))).toEqual({
      event,
      level,
    });
  });
});
