import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying a router-issued, DVM/job-bound feedback attribution claim. */
export const ROUTER_FEEDBACK_CLAIM_HEADER = "x-dvmkit-router-feedback-claim";

/** Lifetime of a routed job's feedback attribution claim. */
export const ROUTER_FEEDBACK_CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Immutable attribution carried by a verified router feedback claim. */
export interface RouterFeedbackClaim {
  /** Immutable platform DVM ID resolved by the router. */
  dvmId: string;
  /** Client-visible job ID returned by the proxied provider. */
  jobId: string;
  /** Canonical host where the caller submitted the routed job. */
  endpointHost: string;
  /** Unix timestamp in milliseconds after which the claim is invalid. */
  expiresAt: number;
}

/** Normalize an endpoint URL or HTTP Host header for feedback claim binding. */
export function normalizeFeedbackEndpointHost(endpointOrHost: string): string | null {
  try {
    const url = new URL(
      endpointOrHost.includes("://") ? endpointOrHost : `https://${endpointOrHost}`
    );
    return url.host === "" ? null : url.host.toLowerCase();
  } catch {
    return null;
  }
}

/** Sign a short-lived feedback claim for one successfully proxied job. */
export function issueRouterFeedbackClaim(
  secret: string,
  attribution: Pick<RouterFeedbackClaim, "dvmId" | "jobId" | "endpointHost">,
  now: number = Date.now()
): string {
  const body: RouterFeedbackClaimPayload = {
    v: 2,
    dvm_id: attribution.dvmId,
    job_id: attribution.jobId,
    endpoint_host: attribution.endpointHost,
    exp: now + ROUTER_FEEDBACK_CLAIM_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

/** Verify and decode a router feedback claim, returning null for every invalid form. */
export function verifyRouterFeedbackClaim(
  secret: string,
  token: string,
  now: number = Date.now()
): RouterFeedbackClaim | null {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const encoded = token.slice(0, dot);
  const presentedSignature = token.slice(dot + 1);
  const expectedSignature = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!safeEqual(expectedSignature, presentedSignature)) return null;

  let body: RouterFeedbackClaimWire;
  try {
    body = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as RouterFeedbackClaimWire;
  } catch {
    return null;
  }
  if (
    body.v !== 2 ||
    typeof body.dvm_id !== "string" ||
    body.dvm_id.length === 0 ||
    typeof body.job_id !== "string" ||
    body.job_id.length === 0 ||
    typeof body.endpoint_host !== "string" ||
    body.endpoint_host.length === 0 ||
    typeof body.exp !== "number" ||
    !Number.isFinite(body.exp) ||
    body.exp <= now
  ) {
    return null;
  }

  return {
    dvmId: body.dvm_id,
    jobId: body.job_id,
    endpointHost: body.endpoint_host,
    expiresAt: body.exp,
  };
}

/** Serialized form protected by the HMAC signature when a router issues a claim. */
interface RouterFeedbackClaimPayload {
  v: 2;
  dvm_id: string;
  job_id: string;
  endpoint_host: string;
  exp: number;
}

/** Untrusted serialized form decoded from a signed router feedback claim. */
interface RouterFeedbackClaimWire {
  v?: unknown;
  dvm_id?: unknown;
  job_id?: unknown;
  endpoint_host?: unknown;
  exp?: unknown;
}

/** Constant-time equality that safely handles different-length strings. */
function safeEqual(expected: string, presented: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const presentedBuffer = Buffer.from(presented);
  return (
    expectedBuffer.length === presentedBuffer.length &&
    timingSafeEqual(expectedBuffer, presentedBuffer)
  );
}
