import { describe, expect, it } from "vitest";

import { devPageHtml } from "../server/dev-page";

describe("devPageHtml", () => {
  it("returns valid HTML with DVM name", () => {
    const html = devPageHtml("My Cool DVM");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("My Cool DVM");
    expect(html).toContain("<title>My Cool DVM");
  });

  it("escapes HTML in DVM name", () => {
    const html = devPageHtml("<script>alert('xss')</script>");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("includes job submission form", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("form-container");
    expect(html).toContain("Submit Job");
    expect(html).toContain("capability: currentCapability");
  });

  it("includes polling and message handling JS", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("/v1/job");
    expect(html).toContain("startPolling");
    expect(html).toContain("handleMessage");
  });

  it("includes auto-approve payment logic", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("autoApprovePayment");
    expect(html).toContain("auto-approved");
  });

  it("includes prompt response handling", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("sendResponse");
    expect(html).toContain("prompt-form");
  });

  it("includes schema form initialization", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("initSchemaForm");
    expect(html).toContain("renderSchemaForm");
    expect(html).toContain("/v1/info");
    expect(html).toContain("info.capabilities || {}");
    expect(html).toContain("capability.input_schema");
  });

  it("includes multi-capability selection", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("capability-container");
    expect(html).toContain("renderCapabilityPicker");
    expect(html).toContain("if (names.length < 2) return");
    expect(html).toContain('select.id = "capability-select"');
  });

  it("carries the submit job token on every job request", () => {
    const html = devPageHtml("Test");
    expect(html).toContain('jobToken = typeof r.data.job_token === "string"');
    expect(html).toContain("headers: jobHeaders(false)");
    expect(html.match(/headers: jobHeaders\(true\)/g)).toHaveLength(2);
    expect(html).toContain('headers["X-Job-Token"] = jobToken');
  });

  it("includes raw JSON toggle", () => {
    const html = devPageHtml("Test");
    expect(html).toContain("toggleRawJson");
    expect(html).toContain("raw-json-area");
    expect(html).toContain("raw-toggle");
  });
});
