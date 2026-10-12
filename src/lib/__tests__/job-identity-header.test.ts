import { describe, expect, it } from "vitest";

import fixture from "../../../protocol-fixtures/job-identity-v1.json";
import { JOB_IDENTITY_HEADER, parseJobIdentityHeader } from "../job-identity-header";

describe("DVM-Job-Identity-V1 parser", () => {
  it("reads the field under the fixture's name, case-insensitively as Fetch does", () => {
    const headers = new Headers({ [fixture.header]: "job-1" });
    expect(parseJobIdentityHeader(headers.get(JOB_IDENTITY_HEADER))).toEqual({
      kind: "valid",
      jobId: "job-1",
    });
  });

  it.each(fixture.vectors)("$name → $kind", ({ value, kind, jobId }) => {
    expect(parseJobIdentityHeader(value)).toEqual(
      kind === "valid" ? { kind, jobId } : { kind }
    );
  });
});
