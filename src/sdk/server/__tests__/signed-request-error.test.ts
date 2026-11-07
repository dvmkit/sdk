import { describe, expect, it } from "vitest";
import { z } from "zod";

import { authErrorBody } from "../auth-error";
import { isSignedRequestError, SignedRequestError, type SignedRequestFailure } from "../signed-request";

describe("the supported signed-request error contract", () => {
  it.each<SignedRequestFailure>([
    "schema_invalid", "signature_required", "signature_invalid", "timestamp_drift", "replay_detected",
  ])("recognizes %s without disclosing the exception message", reason => {
    const error = new SignedRequestError("SECRET_EXCEPTION", reason);
    expect(isSignedRequestError(error)).toBe(true);
    expect(JSON.stringify(authErrorBody(error))).not.toContain("SECRET_EXCEPTION");
  });

  it.each([
    [z.object({ text: z.string().max(3) }), "long", "too long (max 3 chars)"],
    [z.object({ text: z.string().min(1) }), "", "required"],
    [z.object({ text: z.number() }), "", "expected number"],
    [z.object({ text: z.enum(["a", "b"]) }), "", "must be one of: a, b"],
    [z.object({ text: z.email() }), "", "invalid email"],
    [z.object({ text: z.number().multipleOf(2) }), 3, "must be a multiple of 2"],
    [z.object({}).strict(), "", "unrecognized field(s): text"],
  ] as const)("accepts real schema issues used by the disclosure renderer (%#)", (schema, text, display) => {
    const rejection = schema.safeParse({ text });
    if (rejection.success) throw new Error("fixture must violate the published schema");
    const error = new SignedRequestError("input did not satisfy schema", "schema_invalid", rejection.error.issues);
    expect(isSignedRequestError(error)).toBe(true);
    expect(authErrorBody(error)).toMatchObject({ error: "auth_error", sub_reason: "schema_invalid", display: expect.stringContaining(display) });
  });

  it.each([
    null, "auth_error", {}, new Error("unknown"),
    { name: "SignedRequestError", code: "auth_error", sub_reason: "signature_invalid" },
    Object.assign(new Error(), { code: "auth_error", sub_reason: "signature_invalid" }),
    Object.assign(new Error(), { name: "SignedRequestError", code: "other", sub_reason: "signature_invalid" }),
    Object.assign(new Error(), { name: "SignedRequestError", code: "auth_error", sub_reason: "future_reason" }),
  ])("rejects unrelated exceptions and unsupported reasons (%#)", error => {
    expect(isSignedRequestError(error)).toBe(false);
  });

  it.each([
    null, {}, [null], [{ path: null }],
    [{ code: "custom", path: [{}], message: "invalid" }],
    [{ code: "too_big", path: [], message: "invalid" }],
    [{ code: "too_small", path: [], message: "invalid", minimum: {} }],
    [{ code: "not_multiple_of", path: [], message: "invalid", divisor: null }],
    [{ code: "invalid_type", path: [], message: "invalid", expected: {} }],
    [{ code: "invalid_format", path: [], message: "invalid", format: {} }],
    [{ code: "unrecognized_keys", path: [], message: "invalid", keys: [null] }],
    [{ code: "invalid_value", path: [], message: "invalid", values: [{}] }],
  ])("rejects an issue list the renderer cannot safely consume (%#)", issues => {
    const error = Object.assign(new SignedRequestError("unknown", "schema_invalid"), { issues });
    expect(isSignedRequestError(error)).toBe(false);
  });
});
