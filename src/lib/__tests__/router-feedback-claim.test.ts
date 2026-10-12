import { describe, expect, it } from "vitest";

import {
  issueRouterFeedbackClaim,
  ROUTER_FEEDBACK_CLAIM_TTL_MS,
  verifyRouterFeedbackClaim,
} from "../router-feedback-claim";

const SECRET = "router-feedback-claim-test-secret";
const NOW = 1_780_000_000_000;

describe("router feedback claims", () => {
  it("binds immutable DVM, job ID, and endpoint host", () => {
    const token = issueRouterFeedbackClaim(
      SECRET,
      { dvmId: "dvm-a", jobId: "job-a", endpointHost: "dvm-a.example.com" },
      NOW
    );
    expect(verifyRouterFeedbackClaim(SECRET, token, NOW)).toEqual({
      dvmId: "dvm-a",
      jobId: "job-a",
      endpointHost: "dvm-a.example.com",
      expiresAt: NOW + ROUTER_FEEDBACK_CLAIM_TTL_MS,
    });
  });

  it("rejects a modified or expired claim", () => {
    const token = issueRouterFeedbackClaim(
      SECRET,
      { dvmId: "dvm-a", jobId: "job-a", endpointHost: "dvm-a.example.com" },
      NOW
    );
    expect(verifyRouterFeedbackClaim(SECRET, `${token}x`, NOW)).toBeNull();
    expect(verifyRouterFeedbackClaim(SECRET, token, NOW + ROUTER_FEEDBACK_CLAIM_TTL_MS)).toBeNull();
  });
});
