import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

import unsignedReports from "../../../../protocol-fixtures/unsigned-caller-reports-v1.json";
import { emitDiagnostic } from "../../../observability/diagnostic-console";
import { RevenueReporter } from "../revenue-reporter";

afterEach(() => vi.unstubAllGlobals());

describe("permanently rejected reports", () => {
  it.each([
    ["deposit", 400, "client_error:400"],
    ["revenue", 401, "token_rotated"],
    ["release", 403, "client_error:403"],
    ["expiry_release", 422, "client_error:422"],
  ])("emits projected report kind and status after marking %s stale on %s", async (kind, status, reason) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "test-report", kind,
      payload: { dvmId: "test-dvm", creditId: "test-credit" }, retry_count: 0, created_at: String(Date.now()) }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private response text", { status: Number(status) })));
    const reporter = new RevenueReporter({ query } as unknown as Pool, "https://platform.example.com", "test-token");
    await reporter.drainPending();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET stale = true"), [reason, "test-report"]);
    expect(warn.mock.calls.map(([line]) => JSON.parse(line as string))).toContainEqual({
      event: "platform_report_rejected", level: "warn", report_kind: kind, status_code: status,
    });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET retry_count"))).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private response text");
  });

  it.each([409, 503])("keeps retryable refund status %s out of the rejection diagnostic", async (status) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "refund", kind: "refund",
      payload: { dvmId: "test-dvm" }, retry_count: 0, created_at: String(Date.now()) }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
    await new RevenueReporter({ query } as unknown as Pool, "https://platform.example.com", "test-token").drainPending();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET stale = true"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("SET retry_count"))).toBe(true);
    expect(warn.mock.calls.some(([line]) => String(line).includes("platform_report_rejected"))).toBe(false);
  });

  it("drops arbitrary report-kind text at the final diagnostic sink", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    emitDiagnostic("warn", "platform_report_rejected", { report_kind: "private caller text", status_code: 400 });
    expect(warn).toHaveBeenCalledWith(JSON.stringify({ event: "platform_report_rejected", level: "warn", status_code: 400 }));
  });

  it("serializes the nullable expiry-release contract through its transactional enqueue", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const db = { query } as unknown as Pool;
    const reporter = new RevenueReporter(db, "https://platform.example.com", "test-token");
    await reporter.enqueueCreditExpiryRelease(db, unsignedReports.expiry_release.body);
    const stored = JSON.parse(query.mock.calls[0][1][1]);
    query.mockResolvedValue({ rows: [{ id: "expiry", kind: "expiry_release", payload: stored,
      retry_count: 0, created_at: String(Date.now()) }] });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await reporter.drainPending();
    expect(fetch).toHaveBeenCalledWith(`https://platform.example.com${unsignedReports.expiry_release.endpoint}`,
      expect.objectContaining({ body: JSON.stringify(unsignedReports.expiry_release.body) }));
  });

  it.each(["anonymous", "dev-anonymous"])("clears the caller when delivering a queued legacy %s report", async (callerPubkey) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "legacy", kind: "deposit",
      payload: { dvmId: "test-dvm", callerPubkey }, retry_count: 0, created_at: String(Date.now()) }] });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await new RevenueReporter({ query } as unknown as Pool, "https://platform.example.com", "test-token").drainPending();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ dvmId: "test-dvm", callerPubkey: null });
  });
});
