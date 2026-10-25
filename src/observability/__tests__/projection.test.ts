import { describe, expect, it, vi } from "vitest";

import {
  bindDiagnosticCapabilityAuthority,
  bindDiagnosticIdentityAuthority,
  createDiagnosticCapabilityAuthority,
  DIAGNOSTIC_CATALOGUE_VERSION,
  extendDiagnosticIdentityAuthority,
  projectDiagnosticFields,
  projectSpanRow,
} from "../projection";
import type { SpanRow } from "../types";

function makeSpan(overrides: Partial<SpanRow> = {}): SpanRow {
  return {
    span_id: "1111111111111111",
    trace_id: "22222222222222222222222222222222",
    parent_span_id: null,
    dataset: "isolate",
    name: "dvm.request",
    level: "info",
    status: "ok",
    started_at_ms: 1_716_062_100_123,
    ended_at_ms: 1_716_062_100_165,
    service: "isolate-example-dvm",
    service_version: "v1.2.3-rc.4",
    host: "localhost",
    pid: 1234,
    dimensions: {},
    attributes: {},
    error_message: null,
    error_stack: null,
    sample_rate: 1,
    ...overrides,
  };
}

describe("trusted DVM resolution", () => {
  const dvmId = "123e4567-e89b-12d3-a456-426614174000";

  it("projects the authority's mark instead of the input value", () => {
    const authority = extendDiagnosticIdentityAuthority(undefined, "dvm_resolution", "none");
    const fields = { dvm_resolution: "untrusted", dvm_id: dvmId };
    expect(projectDiagnosticFields(fields, undefined, undefined, authority)).toEqual({
      dvm_resolution: "none",
    });

    const input = bindDiagnosticIdentityAuthority(
      makeSpan({ dimensions: fields, attributes: fields }),
      authority,
    );
    expect(projectSpanRow(input)).toEqual({
      ok: true,
      row: expect.objectContaining({
        dimensions: { dvm_resolution: "none" },
        attributes: { dvm_resolution: "none" },
      }),
    });
    expect(projectDiagnosticFields(bindDiagnosticIdentityAuthority(fields, authority))).toEqual({
      dvm_resolution: "none",
    });
    expect(projectSpanRow(JSON.parse(JSON.stringify(input)))).toEqual({
      ok: true,
      row: expect.objectContaining({ dimensions: {}, attributes: {} }),
    });
  });

  it.each(["unbound", "unrelated", "forged"])("drops a mark with %s authority", (kind) => {
    const authority = kind === "unrelated"
      ? extendDiagnosticIdentityAuthority(undefined, "dvm_slug", "example-app")
      : kind === "forged"
        ? {} as NonNullable<ReturnType<typeof extendDiagnosticIdentityAuthority>>
        : undefined;
    const fields = { dvm_resolution: "none" };
    expect(projectDiagnosticFields(fields, undefined, undefined, authority)).toEqual({});
    expect(projectSpanRow(bindDiagnosticIdentityAuthority(
      makeSpan({ dimensions: fields, attributes: fields }),
      authority,
    ))).toEqual({
      ok: true,
      row: expect.objectContaining({ dimensions: {}, attributes: {} }),
    });
  });

  it.each([
    "", "NONE", "none ", "resolved", dvmId, null, undefined, false, 0,
    ["none"], { toString: () => "none" },
  ])("refuses invalid authority value %j", (value) => {
    expect(extendDiagnosticIdentityAuthority(undefined, "dvm_resolution", value)).toBeUndefined();
    const existing = extendDiagnosticIdentityAuthority(undefined, "dvm_slug", "example-app");
    const authority = extendDiagnosticIdentityAuthority(existing, "dvm_resolution", value);
    expect(projectDiagnosticFields(
      { dvm_slug: "spoof", dvm_resolution: "none" }, undefined, undefined, authority,
    )).toEqual({ dvm_slug: "example-app" });
    const marked = extendDiagnosticIdentityAuthority(existing, "dvm_resolution", "none");
    expect(projectDiagnosticFields(
      { dvm_resolution: value }, undefined, undefined,
      extendDiagnosticIdentityAuthority(marked, "dvm_resolution", value),
    )).toEqual({ dvm_resolution: "none" });
  });

  it.each([true, false])("gives DVM identity precedence when the mark is pinned first: %s", (markFirst) => {
    const entries = markFirst
      ? [["dvm_resolution", "none"], ["dvm_id", dvmId]]
      : [["dvm_id", dvmId], ["dvm_resolution", "none"]];
    let authority;
    for (const [key, value] of entries) {
      authority = extendDiagnosticIdentityAuthority(authority, key, value);
    }
    expect(projectDiagnosticFields(
      { dvm_id: "spoof", dvm_resolution: "none" }, undefined, undefined, authority,
    )).toEqual({ dvm_id: dvmId });
    expect(projectDiagnosticFields(
      { dvm_resolution: "none" }, undefined, undefined, authority,
    )).toEqual({});
    expect(projectSpanRow(bindDiagnosticIdentityAuthority(makeSpan({
      dimensions: { dvm_id: "spoof", dvm_resolution: "none" },
      attributes: { dvm_resolution: "none" },
    }), authority))).toEqual({
      ok: true,
      row: expect.objectContaining({ dimensions: { dvm_id: dvmId }, attributes: {} }),
    });
  });
});

describe("projectSpanRow", () => {
  it("implements diagnostic catalogue version 1", () => {
    expect(DIAGNOSTIC_CATALOGUE_VERSION).toBe(1);
  });

  it("retains approved facts and removes customer text, credentials, and nested values", () => {
    const cyclic: Record<string, unknown> = { customer: "SENTINEL_CUSTOMER" };
    cyclic.self = cyclic;
    const result = projectSpanRow(
      makeSpan({
        dimensions: {
          dvm_id: "123e4567-e89b-12d3-a456-426614174000",
          dvm_slug: "example-dvm",
          builder_id: "123e4567-e89b-12d3-a456-426614174001",
          bearer: "SENTINEL_CREDENTIAL",
        },
        attributes: {
          "http.method": "POST",
          "http.route": "/dvms/private/jobs/job-private/status",
          "http.status_code": 201,
          amount: 12.5,
          currency: "USDC",
          required_usdc_micro: 12_500_000,
          facilitator_url:
            "https://pay.example.com/private/SENTINEL_CUSTOMER?q=SENTINEL_CREDENTIAL#x",
          nested: cyclic,
          error: "SENTINEL_ERROR",
        },
        error_message: "SENTINEL_ERROR",
        error_stack: "/private/SENTINEL_STACK",
      }),
    );

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({
        dimensions: {},
        attributes: {
          "http.method": "POST",
          "http.route": "/dvms/:dvmId/jobs/:jobId/status",
          "http.status_code": 201,
          amount: 12.5,
          currency: "USDC",
          required_usdc_micro: 12_500_000,
          facilitator_url: "https://pay.example.com",
        },
        error_message: null,
        error_stack: null,
      }),
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  it("preserves method-qualified routes and sanitized DNS origins", () => {
    const result = projectSpanRow(
      makeSpan({
        dimensions: {
          route: "POST /v1/job",
          status_code: 502,
          private_route: "SENTINEL_ROUTE",
        },
        attributes: {
          method: "POST",
          url: "https://user:pass@example.com:8443/private/SENTINEL_PATH?token=SENTINEL_QUERY#SENTINEL_FRAGMENT",
          "error.code": "invalid_input",
          count: 3,
          customer: "SENTINEL_CUSTOMER",
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({
        dimensions: { route: "POST /v1/job", status_code: 502 },
        attributes: {
          method: "POST",
          url: "https://example.com",
          "error.code": "invalid_input",
          count: 3,
        },
      }),
    });
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
  });

  it.each([
    ["route", "GET /dvms/private/jobs/job-private/status", "GET /dvms/:dvmId/jobs/:jobId/status"],
    ["http.route", "/orgs/acme/members/history", "/orgs/:handle/members/history"],
    ["resource_path", "/dvms/:uuid/jobs/:b58/status", "/dvms/:dvmId/jobs/:jobId/status"],
  ])("normalizes approved %s values to the most specific template", (key, value, expected) => {
    expect(projectDiagnosticFields({ [key]: value })).toEqual({
      [key]: expected,
    });
  });

  it.each([
    ["unknown method", { route: "TRACE /v1/job" }],
    ["unknown route", { route: "POST /customer/private" }],
    ["route query", { route: "POST /v1/job?token=SENTINEL" }],
    ["template trailing slash", { "http.route": "/v1/job/" }],
    ["unapproved redacted segment", { resource_path: "/dvms/:customer/jobs/:private/status" }],
    ["oversized template", { "http.route": `/dvms/example/kv/${"x".repeat(300)}` }],
  ])("omits %s", (_name, fields) => {
    expect(projectDiagnosticFields(fields)).toEqual({});
  });

  it.each([
    ["credential, port, path, query, and fragment", "https://user:pass@EXAMPLE.com:8443/private/SENTINEL?token=SENTINEL#SENTINEL", "https://example.com"],
    ["plain DNS origin", "http://api.example.com/jobs/123", "http://api.example.com"],
  ])("retains the safe origin after removing %s", (_name, value, expected) => {
    expect(projectDiagnosticFields({ url: value })).toEqual({ url: expected });
  });

  it.each([
    ["localhost", "https://localhost/private"],
    ["IPv4", "https://127.0.0.1/private"],
    ["IPv6", "https://[::1]/private"],
    ["unsupported scheme", "ftp://example.com/private"],
    ["malformed URL", "not a URL"],
    ["oversized URL", `https://example.com/${"x".repeat(2048)}`],
  ])("omits an unsafe %s origin", (_name, value) => {
    expect(projectDiagnosticFields({ url: value })).toEqual({});
  });

  it("omits syntactically valid customer tokens without trusted app definitions", () => {
    const result = projectSpanRow(
      makeSpan({
        dimensions: {
          capability: "customer_support",
          protocol: "customer_protocol",
        },
        attributes: {
          capability: "private_report",
          protocol_version: "customer_version",
          client_protocol_version: "customer_client_protocol",
          client_version: "customer_client_version",
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({ dimensions: {}, attributes: {} }),
    });
  });

  it("retains only capability names from the bound app definition", () => {
    const firstApp = createDiagnosticCapabilityAuthority(["transcribe"]);
    createDiagnosticCapabilityAuthority(["private_report"]);
    const candidate = makeSpan({
      dimensions: { capability: "transcribe" },
      attributes: {
        capability: "private_report",
        diagnostic_capabilities: ["private_report"],
      },
    });
    bindDiagnosticCapabilityAuthority(candidate, firstApp);

    const result = projectSpanRow(candidate);

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({
        dimensions: { capability: "transcribe" },
        attributes: {},
      }),
    });
  });

  it("retains exact client compatibility categories and omits capability arrays", () => {
    const result = projectSpanRow(
      makeSpan({
        attributes: {
          "client.version": "1.2.3-rc.4",
          "client.protocol_version": 1,
          "client.version_valid": true,
          "client.protocol_version_valid": true,
          "client.capabilities_valid": false,
          "client.capabilities": ["request-resume"],
          protocol: "customer_protocol",
          protocol_version: "1",
          client_protocol_version: "1",
          client_version: "1.2.3",
        },
      }),
    );

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({
        attributes: {
          "client.version": "1.2.3-rc.4",
          "client.protocol_version": 1,
          "client.version_valid": true,
          "client.protocol_version_valid": true,
          "client.capabilities_valid": false,
        },
      }),
    });
    expect(
      projectDiagnosticFields({
        "client.version": "1.2.3-beta.1",
        "client.protocol_version": 2,
      }),
    ).toEqual({});
  });

  it.each([
    ["admin", "admin"],
    ["operator-admin", "unknown"],
  ])("projects administrative service %s through the fixed catalogue", (service, expected) => {
    expect(projectSpanRow(makeSpan({ service }))).toEqual({
      ok: true,
      row: expect.objectContaining({ service: expected }),
    });
  });

  it("uses fixed fallbacks for unknown event, service, version, host, and sample rate", () => {
    const result = projectSpanRow(
      makeSpan({
        name: "customer supplied event SENTINEL",
        service: "private-workstation",
        service_version: "registry.example.com/private/image:latest",
        host: "person@example.com",
        pid: -1,
        sample_rate: Number.NaN,
      }),
    );

    expect(result).toEqual({
      ok: true,
      row: expect.objectContaining({
        name: "diagnostic.unknown",
        service: "unknown",
        service_version: "unknown",
        host: null,
        pid: null,
        sample_rate: 1,
      }),
    });
  });

  it("does not invoke getters and returns a detached plain record", () => {
    const getter = vi.fn(() => 7);
    const attributes = { count: 3 } as Record<string, unknown>;
    Object.defineProperty(attributes, "attempt", {
      enumerable: true,
      get: getter,
    });
    const result = projectSpanRow(makeSpan({ attributes }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    attributes.count = 99;
    expect(getter).not.toHaveBeenCalled();
    expect(result.row.attributes).toEqual({ count: 3 });
    expect(Object.getPrototypeOf(result.row.attributes)).toBe(Object.prototype);
  });

  it("rejects malformed required structure with bounded codes", () => {
    expect(projectSpanRow(makeSpan({ span_id: "0".repeat(16) }))).toEqual({
      ok: false,
      code: "invalid_span_id",
    });
    expect(projectSpanRow(makeSpan({ ended_at_ms: 1 }))).toEqual({
      ok: false,
      code: "invalid_timestamp",
    });
    expect(
      projectSpanRow(
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw new Error("SENTINEL_PROXY");
            },
          },
        ),
      ),
    ).toEqual({ ok: false, code: "invalid_span" });
  });
});

describe("router.proxy dimensions", () => {
  function projectRouterDimensions(
    dimensions: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = projectSpanRow(
      makeSpan({
        dataset: "platform",
        name: "router.proxy",
        service: "router",
        dimensions,
      }),
    );
    if (!result.ok) throw new Error(`span refused: ${result.code}`);
    return result.row.dimensions;
  }

  // The rollout check counts diagnostics by this value, so each of the four
  // must survive projection as written.
  it.each(["header", "header_absent", "header_invalid", "not_extracted"])(
    "keeps submit_identity_source %s",
    (source) => {
      expect(
        projectRouterDimensions({ submit_identity_source: source }),
      ).toEqual({ submit_identity_source: source });
    },
  );

  it.each([
    ["an unlisted value", "header_missing"],
    ["a different case", "HEADER"],
    ["the header's own value", "job_7f3a"],
    ["a non-string", true],
  ])("drops %s from submit_identity_source", (_label, source) => {
    expect(projectRouterDimensions({ submit_identity_source: source })).toEqual(
      {},
    );
  });

  it("keeps the funded runtime reclaim pin", () => {
    expect(
      projectRouterDimensions({ funded_runtime_reclaim: "closed" }),
    ).toEqual({ funded_runtime_reclaim: "closed" });
  });

  // The platform's suspension reasons, plus the router's `operator` fallback
  // for a suspension with no recorded reason.
  it.each([
    "request_limit",
    "dvm_limit",
    "behaviour",
    "free_tier_idle",
    "admin_org_suspend",
    "builder_pause",
    "withdrawn",
    "operator",
  ])("keeps the suspension reason %s on both suspension pins", (reason) => {
    expect(
      projectRouterDimensions({
        suspended_reclaim: reason,
        suspended_admin: reason,
      }),
    ).toEqual({ suspended_reclaim: reason, suspended_admin: reason });
  });

  it("drops a free-form suspension reason and an unlisted reclaim state", () => {
    expect(
      projectRouterDimensions({
        suspended_reclaim: "abuse report from a caller",
        suspended_admin: "",
        funded_runtime_reclaim: "open",
      }),
    ).toEqual({});
  });

  it("keeps hosting_identity_revoke_failed as an error code", () => {
    expect(
      projectDiagnosticFields({
        error_code: "hosting_identity_revoke_failed",
      }),
    ).toEqual({ error_code: "hosting_identity_revoke_failed" });
  });
});
