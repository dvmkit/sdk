import { DvmError } from "../errors";

/** First delay after a transient mint quote-status failure. */
export const MINT_QUOTE_RETRY_BASE_DELAY_MS = 2_000;
/** Longest individual retry delay, including a mint-supplied Retry-After. */
export const MINT_QUOTE_RETRY_MAX_DELAY_MS = 60_000;
/** Healthy time, as a multiple of the active delay, after which backoff resets. */
const MINT_QUOTE_RETRY_DECAY_FACTOR = 4;

export type MintQuoteFailureCause =
  | "rate_limited"
  | "mint_server_error"
  | "mint_unreachable";

/** Backoff carried across repeated quote polls within one wait. */
export interface MintQuoteRetryState {
  backoffMs: number;
  lastRetryAt?: number;
}

/** Clock and deadline seams shared by fund/reserve waits and recovery sweeps. */
export interface MintQuoteRetryOptions {
  /** Absolute epoch/monotonic value, in the same time domain returned by `now`. */
  deadlineMs: number;
  /** Quote identifier included in a structured deadline error. */
  quoteId: string;
  /** Mutable state when backoff must survive more than one operation call. */
  state?: MintQuoteRetryState;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createMintQuoteRetryState(): MintQuoteRetryState {
  return { backoffMs: 0 };
}

/**
 * Retry one mint quote-status operation until it succeeds or its caller's
 * deadline arrives. Unknown/client failures are rethrown immediately.
 */
export async function retryMintQuoteOperation<T>(
  operation: () => Promise<T>,
  opts: MintQuoteRetryOptions
): Promise<T> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? defaultSleep;
  const state = opts.state ?? createMintQuoteRetryState();

  for (;;) {
    try {
      return await operation();
    } catch (err) {
      const cause = classifyMintQuoteError(err);
      if (cause === undefined) throw err;

      const failedAt = now();
      if (
        state.lastRetryAt !== undefined &&
        failedAt - state.lastRetryAt >= state.backoffMs * MINT_QUOTE_RETRY_DECAY_FACTOR
      ) {
        state.backoffMs = 0;
      }

      const grownDelay = Math.min(
        Math.max(state.backoffMs * 2, MINT_QUOTE_RETRY_BASE_DELAY_MS),
        MINT_QUOTE_RETRY_MAX_DELAY_MS
      );
      const retryAfterMs = mintRetryAfterMs(err);
      const delayMs = Math.min(
        Math.max(retryAfterMs ?? grownDelay, MINT_QUOTE_RETRY_BASE_DELAY_MS),
        MINT_QUOTE_RETRY_MAX_DELAY_MS
      );
      const remainingMs = Math.max(0, opts.deadlineMs - failedAt);

      state.backoffMs = delayMs;
      if (remainingMs > 0) {
        await sleep(Math.min(delayMs, remainingMs));
        state.lastRetryAt = now();
      }
      if (now() >= opts.deadlineMs) {
        throw mintQuoteUnavailableError(opts.quoteId, cause, delayMs);
      }
    }
  }
}

/**
 * Classify mint failures without `instanceof`: published bundles can carry
 * more than one cashu-ts copy, and minification changes constructor names.
 */
export function classifyMintQuoteError(err: unknown): MintQuoteFailureCause | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { name, status, code } = err as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
  };
  if (name === "RateLimitError" || status === 429) return "rate_limited";
  if (typeof status === "number" && status >= 500) return "mint_server_error";
  if (name === "NetworkError" || code === "cashu_mint_unreachable") return "mint_unreachable";
  return undefined;
}

/** A mint-supplied Retry-After as carried by cashu-ts. */
export function mintRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function mintQuoteUnavailableError(
  quoteId: string,
  cause: MintQuoteFailureCause,
  retryAfterMs: number
): DvmError {
  return new DvmError(
    "mint_quote_poll_unavailable",
    `The mint did not answer status checks for quote ${quoteId} before the wait ended.`,
    "The quote may still settle. Reconcile the existing quote later instead of starting another payment.",
    {
      quote_id: quoteId,
      cause,
      retryable: true,
      retry_after_ms: retryAfterMs,
    }
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
