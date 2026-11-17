import { describe, expect, it } from "vitest";

import { assertTempoCloseReport, CLOSE_TEST } from "../scripts/stress-tempo-close.mjs";

const report = (status: string, success = true, failureMessages: string[] = []) => ({
  success,
  testResults: [{ assertionResults: [{ fullName: `hosted Tempo close ${CLOSE_TEST}`, status, failureMessages }] }],
});

describe("Tempo close stress evidence", () => {
  it("accepts a passed case among other filtered tests", () => {
    const evidence = report("passed");
    evidence.testResults[0].assertionResults.push({ fullName: "another test", status: "pending", failureMessages: [] });
    expect(() => assertTempoCloseReport(evidence)).not.toThrow();
  });

  it.each(["pending", "failed", "todo"])("rejects a %s target", status => {
    expect(() => assertTempoCloseReport(report(status))).toThrow("must run and pass");
  });

  it("rejects a missing target", () => {
    expect(() => assertTempoCloseReport({ success: true, testResults: [] })).toThrow("must run and pass");
  });

  it("rejects failure elsewhere in the concurrent full suite", () => {
    expect(() => assertTempoCloseReport(report("passed", false))).toThrow("must run and pass");
  });

  it("requires the negative control to detect two searches", () => {
    const control = { negativeControl: true };
    expect(() => assertTempoCloseReport(report("failed", false,
      ['expected "spy" to be called 1 times, but got 2 times']), control)).not.toThrow();
    expect(() => assertTempoCloseReport(report("failed", false, ["database unavailable"]), control)).toThrow("two searches");
    expect(() => assertTempoCloseReport(report("pending", false), control)).toThrow("two searches");
    expect(() => assertTempoCloseReport(report("passed"), control)).toThrow("two searches");
  });
});
