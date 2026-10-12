/**
 * Response-head field stating the job ID of a `POST /v1/job`,
 * `POST /v1/request-resume/:id` or `POST /v1/request-result/:id` 200/202, so a
 * router or caller can learn the job's identity without reading the body. The
 * version is part of the name: a later version is a different field.
 */
export const JOB_IDENTITY_HEADER = "dvm-job-identity-v1";

const JOB_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type JobIdentityHeaderResult =
  | { kind: "absent" }
  | { kind: "valid"; jobId: string }
  | { kind: "invalid" };

/** True when a value satisfies the `DVM-Job-Identity-V1` value grammar. */
export function isJobIdentityValue(value: unknown): value is string {
  return typeof value === "string" && JOB_IDENTITY_PATTERN.test(value);
}

/**
 * Classify the value `Headers.get(JOB_IDENTITY_HEADER)` returned. Fetch joins a
 * repeated field with `", "`, which falls outside the grammar, so a repeated
 * field is invalid even when every copy is equal. Nothing is trimmed and case
 * is never folded: the value must equal the body's `job_id` byte for byte.
 */
export function parseJobIdentityHeader(value: string | null): JobIdentityHeaderResult {
  if (value === null) return { kind: "absent" };
  return isJobIdentityValue(value) ? { kind: "valid", jobId: value } : { kind: "invalid" };
}
