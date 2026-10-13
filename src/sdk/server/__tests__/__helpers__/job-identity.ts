import { expect } from "vitest";

import { JOB_IDENTITY_HEADER, parseJobIdentityHeader } from "../../../../lib/job-identity-header";

/**
 * Asserts the response head states exactly one `DVM-Job-Identity-V1` equal to
 * the body's `job_id`. A repeated field reads back comma-joined and parses as
 * invalid, so this also rules out duplicates.
 */
export function expectJobIdentity(response: Response, body: { job_id?: unknown }): void {
  expect(typeof body.job_id).toBe("string");
  expect(parseJobIdentityHeader(response.headers.get(JOB_IDENTITY_HEADER))).toEqual({
    kind: "valid",
    jobId: body.job_id,
  });
}

export function expectNoJobIdentity(response: Response): void {
  expect(response.headers.get(JOB_IDENTITY_HEADER)).toBeNull();
}
