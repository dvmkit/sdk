import { redactUrl } from "../../lib/url-redact";
import { loggers } from "../../observability/loggers";

/**
 * Create a fetch wrapper that emits `dvm.fetch` spans via `loggers.isolate`.
 *
 * `signal` is the job's cancellation signal. When supplied, every
 * request made through this fetch aborts on job cancel — that is what stops
 * provider spend mid-job. It is *merged* with any caller-supplied
 * `init.signal` rather than replacing it, so a per-request timeout (scrapfly,
 * cast's ranged GET, …) keeps working and either signal can abort the call.
 */
export function createInstrumentedFetch(signal?: AbortSignal): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const requestSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const merged = mergeSignals(signal, requestSignal);

    return loggers.isolate.span(
      "dvm.fetch",
      { url: redactUrl(url), method: method.toUpperCase() },
      async () => {
        const response = await globalThis.fetch(input, merged ? { ...init, signal: merged } : init);
        return response;
      }
    );
  };
}

function mergeSignals(a?: AbortSignal, b?: AbortSignal | null): AbortSignal | undefined {
  if (!a) return b ?? undefined;
  if (!b) return a;
  return AbortSignal.any([a, b]);
}
