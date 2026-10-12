import { diagnosticConsole } from "../../observability/diagnostic-console";
import type { Currency } from "./currency";
import { UnsupportedCurrencyError } from "./currency";

/**
 * Quote-time FX snapshot. `rates` maps configured lowercase currency codes to
 * units of that currency per BTC at `as_of`; partial responses may omit codes.
 * Capture a snapshot once to keep upfront and mid-job charges at one rate.
 */
export interface FxRateSnapshot {
  rates: Record<Currency, number>;
  as_of: string;
  /**
   * Configured currencies whose rate here came from an *earlier* fetch, because
   * the source's latest body omitted them. The rate is the best one
   * this process holds; `as_of` describes the rest of the snapshot, so a
   * consumer pricing one of these is degrading and should say so — the mid-job
   * legs report it as `credit_topup_stale_rate` / `dvm.ask_pin_stale_rate`.
   * Absent on the normal complete-body path.
   */
  carried_forward?: readonly Currency[];
  /**
   * Configured currencies absent from `rates` altogether — the source omitted
   * them and this process has never held one to carry forward. {@link fxRateFor}
   * raises `fx_rate_unavailable` rather than `unsupported_currency` for these:
   * the DVM advertises the currency, so this is a rate outage narrowed to one
   * code, and a caller's agent must read it on the same retryable envelope as
   * any other. Absent on the normal complete-body path.
   */
  unavailable?: readonly Currency[];
}

/**
 * Default fiat set the bundled fx fetcher resolves against BTC. Add a currency
 * here and it flows through `DEFAULT_FX_RATE_SOURCE`, the
 * `UnsupportedCurrencyError` supported-set string, and every fiat-form
 * `requestPayment` call site — no shape change at the SDK or caller surface.
 */
export const DEFAULT_FX_CURRENCIES: readonly Currency[] = ["usd", "eur", "gbp", "jpy"];

/**
 * Default fx-rate source. Points at CoinGecko's free `simple/price` endpoint.
 * Used for self-hosted DVMs and as the fallback when `DVMKIT_FX_SOURCE` is
 * unset. Hosted DVMs hit the platform-served endpoint instead — see
 * {@link PlatformFxSource} and {@link resolveFxSourceFromEnv}.
 */
export const DEFAULT_FX_RATE_SOURCE = `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${DEFAULT_FX_CURRENCIES.join(",")}`;

/**
 * Platform-served fx source. Hosted DVMs hit `${DVMKIT_PLATFORM_URL}/_internal/fx`
 * authenticated with their per-DVM bearer token. The endpoint serves the
 * canonical `fx_rates` snapshot the platform refreshes daily — one upstream
 * fetch covers every hosted DVM. Self-hosted DVMs (no platform wiring) fall
 * back to CoinGecko-direct.
 */
export interface PlatformFxSource {
  kind: "platform";
  url: string;
  token: string;
}

/**
 * Five-minute in-process freshness window. Concurrent quotes share a rate
 * without another network hit; within-job consistency requires capturing the
 * quote snapshot rather than fetching again after the window expires.
 */
export const FX_CACHE_TTL_MS = 300_000;

/** Default retry budget per `fetch()` call before raising `fx_rate_unavailable`. */
export const FX_RETRY_COUNT = 2;

/**
 * Base retry delay in milliseconds, doubled between attempts. The default
 * retry budget waits about 600ms in total, enough to avoid an immediate burst
 * without making a mid-job payment wait for a long outage.
 */
export const FX_RETRY_BASE_DELAY_MS = 200;

export type FxSourceFailureCategory =
  | "network_error"
  | "http_error"
  | "invalid_body"
  | "no_usable_rate"
  | "missing_currency"
  | "unknown";

/** Observed source failure only; never provider text or an inferred root cause. */
export interface FxSourceFailure {
  category: FxSourceFailureCategory;
  httpStatus?: number;
}

export interface FxRateUnavailableCopy {
  display?: string;
  hint?: string;
}

/**
 * The platform's *deliberate* known-stale refusal, threaded through the fetch
 * boundary from the `_internal/fx` 503 body. Present on an
 * {@link FxRateUnavailableError} only when the platform decided the snapshot is
 * too old to price against (`error.code === "fx_rate_unavailable"` with a
 * `detail.stale_days`) — as opposed to a transient unreachability, which carries
 * no `knownStale`. `resolveServerBtcUsdRate` fails closed on this rather than
 * degrading to `lastKnown`: the platform already refused to serve the
 * rate, so pricing off a frozen local copy of it would defeat the refusal.
 */
export interface FxKnownStale {
  staleDays: number;
  staleSource?: string;
  thresholdDays?: number;
}

/**
 * Thrown when the fx source can't be reached or returns an unparseable rate.
 * `code`/`display`/`hint` mirror the structured-error envelope the SDK quote
 * path renders to agents as a 503-style response — operators retry; agents
 * pass `display` to humans.
 *
 * `copy` overrides the quote-flavoured defaults. The payment rails raise the
 * same code from a different moment in the request — an agent that
 * can't be quoted and an agent whose payment couldn't be priced retry the same
 * way, so they share one code, but "nothing was charged" is only true of the
 * latter and must not be said to the former.
 *
 * One code, two envelopes: the quote path renders `{ error: { code, display,
 * hint } }`, the payment path the flat `{ error: "fx_rate_unavailable", display,
 * hint }` that every other payment error uses (`buildPaymentErrorResponse`). So
 * an agent has one retry rule but still two shapes to parse the code out of —
 * that split is the response envelopes', not this error's.
 */
export class FxRateUnavailableError extends Error {
  readonly code = "fx_rate_unavailable";
  readonly display: string;
  readonly hint: string;
  /**
   * Set only when the platform explicitly refused a *known-stale* snapshot.
   * Absent means transient/unreachable — a distinction the payment
   * rail's amount computation branches on: refuse on `knownStale`, degrade to
   * the last-known rate without it. See {@link FxKnownStale}.
   */
  readonly knownStale?: FxKnownStale;

  readonly sourceFailure?: FxSourceFailure;

  constructor(
    message?: string,
    copy?: FxRateUnavailableCopy,
    knownStale?: FxKnownStale,
    sourceFailure?: FxSourceFailure
  ) {
    super(message);
    this.name = "FxRateUnavailableError";
    this.display = copy?.display ?? "Couldn't fetch the BTC reference rate to lock pricing";
    this.hint = copy?.hint ?? "transient — try the quote again in a few seconds";
    this.knownStale = knownStale;
    this.sourceFailure = normalizeFxSourceFailure(sourceFailure);
  }
}

const FX_SOURCE_FAILURE_CATEGORIES: ReadonlySet<string> = new Set<FxSourceFailureCategory>([
  "network_error", "http_error", "invalid_body", "no_usable_rate", "missing_currency", "unknown",
]);

function normalizeFxSourceFailure(input: unknown): FxSourceFailure | undefined {
  if (input === undefined) return undefined;
  try {
    if (typeof input !== "object" || input === null) return { category: "unknown" };
    const categoryDescriptor = Object.getOwnPropertyDescriptor(input, "category");
    const category: unknown = categoryDescriptor && "value" in categoryDescriptor
      ? categoryDescriptor.value : undefined;
    if (typeof category !== "string" || !FX_SOURCE_FAILURE_CATEGORIES.has(category)) {
      return { category: "unknown" };
    }
    const statusDescriptor = Object.getOwnPropertyDescriptor(input, "httpStatus");
    const status: unknown = statusDescriptor && "value" in statusDescriptor
      ? statusDescriptor.value : undefined;
    return {
      category: category as FxSourceFailureCategory,
      ...(category === "http_error" && typeof status === "number" && Number.isInteger(status) &&
        status >= 100 && status <= 599 && { httpStatus: status }),
    };
  } catch {
    return { category: "unknown" };
  }
}

/** Read only data properties; injected accessors and descriptor failures cannot affect payment. */
export function readFxSourceFailure(error: FxRateUnavailableError): FxSourceFailure | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "sourceFailure");
    if (!descriptor) return undefined;
    if (!("value" in descriptor)) return { category: "unknown" };
    return normalizeFxSourceFailure(descriptor.value);
  } catch {
    return { category: "unknown" };
  }
}

/**
 * Snapshot fetcher for BTC against one or more fiat currencies. Caches
 * in-process for {@link FX_CACHE_TTL_MS} so concurrent quotes amortise the
 * rate-limit budget, and a within-window quote → job pair settles at the same
 * "locked" snapshot without an explicit cross-call lock. `supportedCurrencies()`
 * returns the configured set synchronously so callers can preflight an
 * unsupported currency without forcing a network hit.
 */
export interface FxFetcher {
  fetch(): Promise<FxRateSnapshot>;
  supportedCurrencies(): readonly Currency[];
  /**
   * The last snapshot this fetcher successfully retrieved, paired with the Unix
   * ms it was cached, or `null` if none has landed yet. Ignores the freshness
   * TTL — the cache is never cleared, so this survives an upstream outage and is
   * the offline degradation source for the payment rail: when
   * {@link fetch} throws, callers serve this rather than fail a priced request.
   * Optional so lightweight test fakes need not implement it.
   */
  lastKnown?(): { snapshot: FxRateSnapshot; cachedAt: number } | null;
}

/**
 * Options for `createFxFetcher`. `source` accepts either:
 * - a URL string targeting a CoinGecko-shaped endpoint
 * (`{ bitcoin: { <currency>: number, ... } }`), or
 * - a {@link PlatformFxSource} object pointing at the dvmkit platform's
 * `_internal/fx` endpoint (the canonical `fx_rates` snapshot, served with
 * bearer auth).
 *
 * `undefined` falls back to {@link DEFAULT_FX_RATE_SOURCE} (CoinGecko-direct).
 */
export interface CreateFxFetcherOpts {
  source?: string | PlatformFxSource;
  /** Currencies the fetcher advertises support for. Defaults to {@link DEFAULT_FX_CURRENCIES}. */
  currencies?: readonly Currency[];
  fetchFn?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  retries?: number;
  /**
   * Base backoff between retry attempts, doubling each time. Defaults to
   * {@link FX_RETRY_BASE_DELAY_MS}; pass `0` in tests so the retry loop stays
   * instant.
   */
  retryDelayMs?: number;
}

/** Build the default fx fetcher backed by `DVMKIT_FX_SOURCE` (or CoinGecko). */
export function createFxFetcher(opts?: CreateFxFetcherOpts): FxFetcher {
  const currencies = opts?.currencies ?? DEFAULT_FX_CURRENCIES;
  const source: string | PlatformFxSource = opts?.source ?? DEFAULT_FX_RATE_SOURCE;
  const fetchFn = opts?.fetchFn ?? fetch;
  const now = opts?.now ?? ((): number => Date.now());
  const cacheTtlMs = opts?.cacheTtlMs ?? FX_CACHE_TTL_MS;
  const retries = opts?.retries ?? FX_RETRY_COUNT;
  const retryDelayMs = opts?.retryDelayMs ?? FX_RETRY_BASE_DELAY_MS;

  let cached: { snapshot: FxRateSnapshot; cachedAt: number } | null = null;
  let inFlight: Promise<FxRateSnapshot> | null = null;
  // Which partial-body episode we have already warned about, or `null` while
  // bodies are complete. Latched like `btc-rate.ts`'s `staleEpisode` so a source
  // that has permanently stopped carrying a currency doesn't warn every TTL
  // forever, and re-armed when the omitted set changes or the body recovers —
  // a fresh gap months later is news.
  let partialEpisode: string | null = null;

  return {
    supportedCurrencies(): readonly Currency[] {
      return currencies;
    },
    lastKnown(): { snapshot: FxRateSnapshot; cachedAt: number } | null {
      return cached;
    },
    async fetch(): Promise<FxRateSnapshot> {
      const t = now();
      if (cached && t - cached.cachedAt < cacheTtlMs) return cached.snapshot;
      if (inFlight) return inFlight;

      const promise = (async (): Promise<FxRateSnapshot> => {
        let lastErr: unknown = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            const fresh = await fetchOnce(source, currencies, fetchFn);
            const snapshot = carryForward(fresh, cached?.snapshot, currencies);
            partialEpisode = warnPartialRates(sourceLabel(source), snapshot, partialEpisode);
            cached = { snapshot, cachedAt: now() };
            return snapshot;
          } catch (err) {
            lastErr = err;
            // A deliberate known-stale platform refusal is
            // deterministic — retrying just re-fetches the same 503. Surface it
            // immediately, and preserve the typed staleness signal that the
            // end-of-loop rewrap into a fresh FxRateUnavailableError would strip.
            if (err instanceof FxRateUnavailableError && err.knownStale) throw err;
            // Back off before the next attempt. Without this the
            // whole budget fires inside one event-loop turn, which a
            // rate-limited source answers identically every time.
            if (attempt < retries && retryDelayMs > 0) {
              await delay(retryDelayMs * 2 ** attempt);
            }
          }
        }
        throw new FxRateUnavailableError(
          lastErr instanceof Error ? lastErr.message : String(lastErr),
          undefined,
          undefined,
          lastErr instanceof FxRateUnavailableError ? readFxSourceFailure(lastErr) : { category: "unknown" }
        );
      })();

      inFlight = promise;
      try {
        return await promise;
      } finally {
        inFlight = null;
      }
    },
  };
}

/**
 * Prime the last-known snapshot before the first priced request needs it.
 * Fire-and-forget: failures stay silent and never delay or fail startup.
 * Already-warm fetchers are left alone; racing a request shares its in-flight
 * fetch rather than adding an upstream call.
 */
export function warmFxSnapshot(fetcher: FxFetcher): void {
  if (fetcher.lastKnown?.()) return;
  try {
    void fetcher.fetch().catch(() => undefined);
  } catch {
    // `fetch` is typed async, but an injected fetcher can throw before it ever
    // returns a promise — a bad `source` URL parsed eagerly, say. That escapes
    // the `.catch` above and would take the boot down with it, so the two
    // failure shapes get the same silence.
  }
}

/**
 * Look up `currency`'s rate in `snapshot`.
 *
 * Two ways it can be missing, and they are not the same failure:
 *
 * - The snapshot lists it in {@link FxRateSnapshot.unavailable} — the DVM
 * advertises the currency, but its rate source omitted it and this process
 * holds no earlier one. That is a rate outage narrowed to one code, so it
 * raises `fx_rate_unavailable`, retryable, the same envelope every other rate
 * failure reaches the caller's agent on. Answering
 * `unsupported_currency` here would reach the quote path as a `400
 * invalid_quote_result` — telling an agent the DVM's own quote is malformed,
 * and not to retry, over a transient omission upstream.
 * - Anything else — a currency neither configured nor fetched, typically an
 * operator's `DVMKIT_FX_SOURCE` override that doesn't carry it. Raises
 * `UnsupportedCurrencyError` naming the keys actually present, so the message
 * stays truthful about what this snapshot can price.
 */
export function fxRateFor(snapshot: FxRateSnapshot, currency: Currency): number {
  if (!Object.prototype.hasOwnProperty.call(snapshot.rates, currency)) {
    if (snapshot.unavailable?.includes(currency)) {
      throw new FxRateUnavailableError(
        `fx source carries no ${currency.toUpperCase()} rate and this DVM has no cached one.`,
        {
          display: `The ${currency.toUpperCase()} reference rate is unavailable right now.`,
          hint: `The rate source stopped carrying ${currency.toUpperCase()}. Retry in a minute; if it persists the source needs to be reconfigured.`,
        },
        undefined,
        { category: "missing_currency" }
      );
    }
    throw new UnsupportedCurrencyError(currency, Object.keys(snapshot.rates));
  }
  return snapshot.rates[currency];
}

async function fetchOnce(
  source: string | PlatformFxSource,
  currencies: readonly Currency[],
  fetchFn: typeof fetch
): Promise<FxRateSnapshot> {
  if (typeof source === "string") return fetchCoinGeckoShape(source, currencies, fetchFn);
  return fetchPlatformShape(source, currencies, fetchFn);
}

async function fetchCoinGeckoShape(
  source: string,
  currencies: readonly Currency[],
  fetchFn: typeof fetch
): Promise<FxRateSnapshot> {
  const res = await fetchSource(fetchFn, source);
  if (!res.ok) {
    throw new FxRateUnavailableError(
      `fx source ${source} returned ${res.status.toString()}`,
      undefined,
      undefined,
      { category: "http_error", httpStatus: res.status }
    );
  }
  const body = await parseRateBody(res);
  const bitcoin = body?.bitcoin;
  if (!bitcoin || typeof bitcoin !== "object" || Array.isArray(bitcoin)) {
    throw new FxRateUnavailableError(
      `fx source ${source} returned an unparsable rate body`,
      undefined,
      undefined,
      { category: "invalid_body" }
    );
  }
  return {
    rates: collectRates(source, bitcoin as Record<string, unknown>, currencies),
    as_of: new Date().toISOString(),
  };
}

async function fetchPlatformShape(
  source: PlatformFxSource,
  currencies: readonly Currency[],
  fetchFn: typeof fetch
): Promise<FxRateSnapshot> {
  const res = await fetchSource(fetchFn, source.url, {
    headers: { Authorization: `Bearer ${source.token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    // A deliberate staleness refusal carries a typed body the
    // SDK must distinguish from a transient 5xx: the platform decided the rate is
    // too old to price against, so degrading to the last-known rate would price
    // off exactly what it refused. Thread `stale_days` through so the payment
    // rail can fail closed; everything else stays a generic error and
    // degrades as before.
    const knownStale = await parsePlatformStaleRefusal(res);
    if (knownStale) {
      throw new FxRateUnavailableError(
        `fx source ${source.url} refused: rate ${knownStale.staleDays.toString()}d stale` +
          (knownStale.thresholdDays !== undefined
            ? ` (threshold ${knownStale.thresholdDays.toString()}d)`
            : ""),
        undefined,
        knownStale,
        { category: "http_error", httpStatus: res.status }
      );
    }
    throw new FxRateUnavailableError(
      `fx source ${source.url} returned ${res.status.toString()}`,
      undefined,
      undefined,
      { category: "http_error", httpStatus: res.status }
    );
  }
  const body = await parseRateBody(res);
  const raw = body?.rates;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FxRateUnavailableError(
      `fx source ${source.url} returned an unparsable rate body`,
      undefined,
      undefined,
      { category: "invalid_body" }
    );
  }
  const rates = collectRates(source.url, raw as Record<string, unknown>, currencies);
  const as_of = typeof body.as_of === "string" ? body.as_of : new Date().toISOString();
  return { rates, as_of };
}

async function fetchSource(fetchFn: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetchFn(url, init);
  } catch (err) {
    if (err instanceof FxRateUnavailableError) throw err;
    throw new FxRateUnavailableError(
      err instanceof Error ? err.message : String(err),
      undefined,
      undefined,
      { category: "network_error" }
    );
  }
}

async function parseRateBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
  } catch {
    throw new FxRateUnavailableError(
      "fx source returned an unparsable rate body",
      undefined,
      undefined,
      { category: "invalid_body" }
    );
  }
}

/**
 * Keep usable configured rates even when a response omits another currency;
 * no usable rates is an outage. `carryForward` marks or fills missing codes
 * so a partial response cannot disguise an outage as an unsupported currency.
 */
function collectRates(
  source: string,
  raw: Record<string, unknown>,
  currencies: readonly Currency[]
): Record<Currency, number> {
  const rates: Record<Currency, number> = {};
  for (const currency of currencies) {
    const value = raw[currency];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) continue;
    rates[currency] = value;
  }
  if (Object.keys(rates).length === 0) {
    throw new FxRateUnavailableError(
      `fx source ${source} returned no usable rate for any of [${currencies.join(", ")}]`,
      undefined,
      undefined,
      { category: "no_usable_rate" }
    );
  }
  return rates;
}

/**
 * Keep omitted currencies at their last known rate and recompute their tags
 * each fetch, so recovered currencies stop being marked as carried forward.
 * Carrying forward is deliberately unbounded in age, like `lastKnown()`;
 * consumers receive the stale-rate tag instead of a claim of current pricing.
 */
function carryForward(
  fresh: FxRateSnapshot,
  previous: FxRateSnapshot | undefined,
  currencies: readonly Currency[]
): FxRateSnapshot {
  const carried: Currency[] = [];
  const unavailable: Currency[] = [];
  const rates: Record<Currency, number> = { ...fresh.rates };
  for (const currency of currencies) {
    if (Object.prototype.hasOwnProperty.call(fresh.rates, currency)) continue;
    const prior = previous?.rates[currency];
    if (typeof prior === "number") {
      rates[currency] = prior;
      carried.push(currency);
      continue;
    }
    unavailable.push(currency);
  }
  if (carried.length === 0 && unavailable.length === 0) return fresh;
  return {
    rates,
    as_of: fresh.as_of,
    ...(carried.length > 0 && { carried_forward: carried }),
    ...(unavailable.length > 0 && { unavailable }),
  };
}

/**
 * Warn once per partial-body episode, and answer the episode key to latch on.
 * A source that has quietly stopped carrying a currency this host advertises is
 * a config problem and should surface as one — but as a *fact about the source*,
 * not a line per fetch for the life of the process.
 */
function warnPartialRates(
  source: string,
  snapshot: FxRateSnapshot,
  episode: string | null
): string | null {
  const carried = snapshot.carried_forward ?? [];
  const unavailable = snapshot.unavailable ?? [];
  if (carried.length === 0 && unavailable.length === 0) return null;
  const key = `${carried.join(",")}|${unavailable.join(",")}`;
  if (key === episode) return episode;
  diagnosticConsole.warn(
    {
      level: "warn",
      event: "fx_rates_partial",
      source,
      ...(carried.length > 0 && { carried_forward: carried }),
      ...(unavailable.length > 0 && { unavailable }),
    }
  );
  return key;
}

/** The fx source's identity for a log line — the URL either shape is fetched from. */
function sourceLabel(source: string | PlatformFxSource): string {
  return typeof source === "string" ? source : source.url;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract the platform's known-stale refusal from a non-2xx `_internal/fx`
 * response, or `null` if the body isn't one. The refusal shape is
 * `{ error: { code: "fx_rate_unavailable", detail: { stale_days, stale_source,
 * threshold_days } } }`; the platform emits it only once past its own serving
 * bound, so its presence *is* the "known stale, refuse" signal.
 *
 * Anything else — a non-JSON body, a transient 5xx, or the cold-start
 * `fx_snapshot_unavailable` 503 (which carries no `detail`) — returns `null` and
 * stays a transient failure that degrades to the last-known rate.
 */
async function parsePlatformStaleRefusal(res: Response): Promise<FxKnownStale | null> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  if (code !== "fx_rate_unavailable" || !detail || typeof detail !== "object") return null;
  const { stale_days, stale_source, threshold_days } = detail as {
    stale_days?: unknown;
    stale_source?: unknown;
    threshold_days?: unknown;
  };
  if (typeof stale_days !== "number" || !Number.isFinite(stale_days)) return null;
  return {
    staleDays: stale_days,
    staleSource: typeof stale_source === "string" ? stale_source : undefined,
    thresholdDays:
      typeof threshold_days === "number" && Number.isFinite(threshold_days)
        ? threshold_days
        : undefined,
  };
}

/**
 * Resolve an environment override for `createFxFetcher`. An unset
 * `DVMKIT_FX_SOURCE` leaves its default source in effect. `"platform"` requires
 * both `DVMKIT_PLATFORM_URL` and `DVMKIT_PLATFORM_TOKEN`, and becomes an
 * authenticated `PlatformFxSource`; any other nonempty value passes through.
 */
export function resolveFxSourceFromEnv(
  env: Record<string, string | undefined>
): string | PlatformFxSource | undefined {
  const raw = env.DVMKIT_FX_SOURCE;
  if (!raw) return undefined;
  if (raw === "platform") {
    const url = env.DVMKIT_PLATFORM_URL;
    const token = env.DVMKIT_PLATFORM_TOKEN;
    if (!url || !token) {
      throw new Error(
        'DVMKIT_FX_SOURCE="platform" requires DVMKIT_PLATFORM_URL and DVMKIT_PLATFORM_TOKEN to be set'
      );
    }
    return { kind: "platform", url: `${url.replace(/\/+$/, "")}/_internal/fx`, token };
  }
  return raw;
}
