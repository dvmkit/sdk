import { diagnosticConsole } from "../../observability/diagnostic-console";
import { formatStaleness } from "../../lib/currency";
import type { FxFetcher, FxKnownStale } from "../pricing/fx";
import { createFxFetcher, fxRateFor, FxRateUnavailableError } from "../pricing/fx";

/**
 * A BTC/USD rate resolved inside a running DVM, tagged with whether it came
 * from a live fetch or the last-known in-process rate. `stale: true` means the
 * rate provider was unreachable and this is the last rate this process saw;
 * `cachedAt` is the Unix ms it was fetched.
 */
export interface ServerBtcRate {
  rate: number;
  stale: boolean;
  cachedAt?: number;
}

/**
 * How long to keep serving the cached rate after a failed live fetch, instead
 * of re-probing a source that just told us it was down. The fetcher's `fetch()`
 * retries then throws on a sustained outage, so without this every priced
 * request past the 5-minute freshness TTL would pay the full retry budget
 * before falling back — against a source already failing us. One minute bounds
 * the recovery lag to the same order as the freshness window we're degrading
 * from.
 */
export const STALE_RATE_COOLDOWN_MS = 60_000;

/**
 * Resolve a BTC/USD rate for a server-side conversion (x402 USDC amounts, mppx
 * challenge amounts) through the host's {@link FxFetcher} — the same fetcher the
 * quote path uses. On a hosted DVM (`DVMKIT_FX_SOURCE=platform`) that
 * fetcher serves the platform's durable `fx_rates` snapshot, so the payment rail
 * rides one upstream fetch shared across every hosted DVM and survives a
 * CoinGecko outage instead of fanning out to CoinGecko per-process. A
 * self-hosted DVM's fetcher defaults to CoinGecko-direct, unchanged. When no
 * fetcher is threaded (unit tests), a lazy default fetcher stands in — the
 * payment path never reaches `src/lib/currency.ts`'s `fetchBtcUsdRate`.
 *
 * Keeps degradation semantics: degrade to the last snapshot the
 * fetcher saw when the source is unreachable, raise a typed `fx_rate_unavailable`
 * when there is none. The caller-side twin is `resolveBtcUsdRate`
 * (`src/lib/btc-rate.ts`); this one warns into structured logs rather than a
 * human's stderr, and raises the SDK's `FxRateUnavailableError` — the same code
 * `/v1/quote` and the dynamic-price `/v1/job` path already return, so an agent
 * reads one code for "the BTC rate source is down" whichever half of the request
 * tripped over it. The *envelope* still differs by path (the quote path nests
 * `error.code`; the payment path is flat, per `buildPaymentErrorResponse`).
 *
 * A DVM host is long-lived, so the fetcher's last-known snapshot absorbs an
 * outage that starts after boot, and {@link STALE_RATE_COOLDOWN_MS} keeps a
 * sustained one off the payment hot path. A *cold* process during an outage has
 * no snapshot at all, and that is a hard failure: pricing a paid request at `0`
 * would give the work away, so the request is refused with something the caller
 * can act on instead. For hosted DVMs the platform snapshot is durable, so a
 * cold boot during a CoinGecko outage still prices normally — the durability
 * lives on the platform, not here.
 */
export async function resolveServerBtcUsdRate(fetcher?: FxFetcher): Promise<ServerBtcRate> {
  const fx = fetcher ?? lazyFxFetcher();

  // Inside the cool-down we don't re-probe at all: the last attempt failed, and
  // a request that would have been served off the cached snapshot anyway
  // shouldn't wait out the retry budget to learn that again. A cold process has
  // nothing to serve, so it keeps probing — it has to, to recover.
  if (Date.now() < cooldownUntil) {
    const cached = usableCachedRate(fx);
    if (cached) {
      warnStaleRate(cached.cachedAt);
      return { rate: cached.rate, stale: true, cachedAt: cached.cachedAt };
    }
  }

  try {
    const snapshot = await fx.fetch();
    const rate = fxRateFor(snapshot, "usd");
    // The fetcher's parse layer already rejects a non-positive rate, but the
    // cost of a `0` slipping through is a paid request priced at nothing — check
    // again and treat a bad rate as an outage rather than give the work away.
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("implausible usd rate from fx source");
    staleEpisode = false;
    staleRefusalEpisode = false;
    cooldownUntil = 0;
    return { rate, stale: false };
  } catch (err) {
    // The platform explicitly refused a *known-stale* snapshot: it
    // decided the rate is too old to serve (≥ its 5-day CoinGecko / 7-day ECB
    // bound). Degrading to the last-known rate would price off exactly what the
    // platform refused, so fail closed — do not touch the cached snapshot and do
    // not arm the cool-down. A transient blip (no `knownStale`) still degrades
    // below, preserving availability during transient upstream failures.
    if (err instanceof FxRateUnavailableError && err.knownStale) {
      warnKnownStaleRefusal(err.knownStale);
      throw rateStaleRefused(err.knownStale);
    }
    const cached = usableCachedRate(fx);
    if (cached) {
      cooldownUntil = Date.now() + STALE_RATE_COOLDOWN_MS;
      warnStaleRate(cached.cachedAt);
      return { rate: cached.rate, stale: true, cachedAt: cached.cachedAt };
    }
    throw rateUnavailable();
  }
}

/**
 * The `fx_rate_unavailable` payment-error detail, shaped like every other flat
 * payment error: a flat machine `error` code plus `message` and the
 * `display`/`hint`/`retryable` fields an agent relays verbatim and branches
 * retries on — the shape the `paymentErrorBody` builder enforces for the sibling
 * 503s (`mint_health_pending`, `cashu_mint_sick`) and the 402 family alike. This
 * one is built by hand rather than through the builder because its copy already
 * lives on `FxRateUnavailableError`, shared with the quote path's nested
 * envelope. 503 rather than 402 — the caller's payment isn't the problem, our
 * pricing is.
 */
export function rateUnavailablePaymentError(): {
  body: Record<string, unknown>;
  status: number;
} {
  const err = rateUnavailable();
  return {
    body: {
      error: err.code,
      message: err.message,
      hint: err.hint,
      display: err.display,
      retryable: true,
    },
    status: 503,
  };
}

/**
 * True while the process is serving stale rates. Reset on the next live fetch,
 * so a fresh outage warns again — unlike the CLI's once-per-process latch, a
 * DVM host runs for weeks and a recurrence months later is news.
 */
let staleEpisode = false;

/**
 * True while the process is refusing to price against a platform-declared
 * known-stale snapshot. Separate latch from {@link staleEpisode} (that one
 * covers transient last-known fallback) so each episode warns once, and a
 * recovery followed by a fresh freeze is news again. Reset on the next live fetch.
 */
let staleRefusalEpisode = false;

/** Unix ms until which a failed live fetch suppresses further probes. */
let cooldownUntil = 0;

/**
 * Process-wide fallback fx fetcher for callers (typically unit tests) that don't
 * thread one in. Instantiated lazily so a process that never prices a non-sat
 * rail pays no boot cost, and mirrors `context.ts`'s `lazyFxFetcher` — the point
 * is that the payment path always resolves through an {@link FxFetcher}, never
 * `src/lib/currency.ts`'s CoinGecko-direct `fetchBtcUsdRate`.
 *
 * Scoped to `["usd"]`: this resolver only ever reads the usd rate (x402 USDC,
 * mppx amounts), so a usd-only fetch is both sufficient and cheaper than pulling
 * the full `DEFAULT_FX_CURRENCIES` set the host fetcher carries for the fiat quote
 * path. Mid-job fiat charges in an arbitrary currency go through `context.ts`'s
 * lazy fetcher, which keeps the full set.
 */
let _lazyFxFetcher: FxFetcher | null = null;
function lazyFxFetcher(): FxFetcher {
  _lazyFxFetcher ??= createFxFetcher({ currencies: ["usd"] });
  return _lazyFxFetcher;
}

/**
 * The last usable BTC/USD rate the fetcher saw, or `null`. Reads the fetcher's
 * own last-known snapshot (ignoring freshness TTL) so the payment rail and quote
 * path degrade off the same number. The fetcher's parse layer already rejects a
 * non-positive rate, but the cost of a `0` slipping through here is a paid
 * request priced at nothing, so check again.
 */
function usableCachedRate(fx: FxFetcher): { rate: number; cachedAt: number } | null {
  const cached = fx.lastKnown?.();
  if (!cached) return null;
  const rate = cached.snapshot.rates.usd;
  if (typeof rate === "number" && Number.isFinite(rate) && rate > 0) {
    return { rate, cachedAt: cached.cachedAt };
  }
  return null;
}

function warnStaleRate(cachedAt: number): void {
  if (staleEpisode) return;
  staleEpisode = true;
  diagnosticConsole.warn(
    {
      level: "btc_rate_stale_fallback",
      message:
        undefined,
      cached_at: new Date(cachedAt).toISOString(),
      age: formatStaleness(cachedAt),
    }
  );
}

function warnKnownStaleRefusal(knownStale: FxKnownStale): void {
  if (staleRefusalEpisode) return;
  staleRefusalEpisode = true;
  diagnosticConsole.warn(
    {
      level: "btc_rate_stale_refused",
      message:
        undefined,
      stale_days: knownStale.staleDays,
      stale_source: knownStale.staleSource,
      threshold_days: knownStale.thresholdDays,
    }
  );
}

/**
 * The refusal raised when the platform declares its FX snapshot known-stale
 * Same `fx_rate_unavailable` code as {@link rateUnavailable} so an
 * agent keeps one retry rule, but the copy names the *staleness* cause rather
 * than unreachability — here the DVM has a cached rate; it's the platform that
 * refused to serve a fresh one.
 */
function rateStaleRefused(knownStale: FxKnownStale): FxRateUnavailableError {
  return new FxRateUnavailableError(
    `Could not price this payment: the platform refused its BTC/USD snapshot as ${knownStale.staleDays.toString()}d stale.`,
    {
      display:
        "BTC/USD rate is stale — the platform refused to price this payment, so nothing was charged.",
      hint: `The platform's FX snapshot is ${knownStale.staleDays.toString()} days stale (its refresh is stalled). Retry once rates refresh.`,
    },
    knownStale
  );
}

function rateUnavailable(): FxRateUnavailableError {
  return new FxRateUnavailableError(
    "Could not price this payment: the BTC/USD rate provider is unreachable and this DVM has no cached rate.",
    {
      display:
        "BTC/USD rate unavailable — the payment could not be priced, so nothing was charged.",
      hint: "The rate provider (CoinGecko) is rate-limiting or down and this DVM has never cached a rate. Retry in a minute.",
    }
  );
}
