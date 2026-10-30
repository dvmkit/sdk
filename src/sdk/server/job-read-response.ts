import { isTransportError } from "../../lib/pg-retry";

export async function withJobReadAvailability(read: () => Promise<Response>): Promise<Response> {
  try {
    return await read();
  } catch (error) {
    if (!isReadUnavailable(error)) throw error;
    return Response.json({
      error: "job_read_unavailable",
      retryable: true,
      display: "Your existing job cannot be read while storage is temporarily unavailable.",
      hint: "Wait 1 second, then read the same job with the same credentials and message cursor. Do not submit a new job or send another payment. This read failure does not establish whether the job charged, completed, or released a hold.",
    }, { status: 503, headers: { "Retry-After": "1" } });
  }
}

function isReadUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (isTransportError(error)) return true;
  const { code, message } = error as { code?: unknown; message?: unknown };
  // These connection/startup/capacity failures say nothing about the job's outcome.
  if (typeof code === "string") return [
    "ETIMEDOUT", "ECONNREFUSED", "EPIPE", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH",
    "08000", "08001", "08003", "08006", "57P01", "57P02", "57P03", "53300",
  ].includes(code);
  return message === "timeout exceeded when trying to connect";
}
