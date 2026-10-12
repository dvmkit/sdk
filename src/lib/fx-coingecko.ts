export const COINGECKO_SIMPLE_PRICE_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,usd-coin&vs_currencies=usd";

/** BTC-only endpoint: a degraded USDC field cannot prevent a BTC quote. */
export const COINGECKO_BTC_USD_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_USER_AGENT = "dvmkit-platform/1.0 (+https://dvmkit.com)";

export interface CoinGeckoFetchOptions {

  url?: string;
  /** Per-attempt timeout in ms. Default 5000. */
  timeoutMs?: number;

  fetchImpl?: typeof fetch;

  userAgent?: string;
}

/**
 * Spot snapshot returned by one successful CoinGecko `simple/price` call.
 * `as_of` is the wall-clock instant the response was parsed (CoinGecko's
 * free tier returns no upstream timestamp, so this is the closest signal a
 * caller has).
 */
export interface CoinGeckoSpot {
  btc_usd: number;
  usdc_usd: number;
  as_of: string;
}

export interface CoinGeckoBtcSpot {
  btc_usd: number;
  as_of: string;
}

/**
 * One raw call to CoinGecko's `simple/price` endpoint for **both** BTC and
 * USDC. No cache, no retry — callers wrap with their own. Use
 * {@link fetchCoinGeckoBtcUsd} instead when only BTC/USD is needed; this
 * variant throws if upstream returns a degraded `usd-coin.usd`.
 */
export async function fetchCoinGeckoSpot(opts?: CoinGeckoFetchOptions): Promise<CoinGeckoSpot> {
  const body = await fetchCoinGeckoBody(opts, COINGECKO_SIMPLE_PRICE_URL);
  const btc = body.bitcoin?.usd;
  const usdc = body["usd-coin"]?.usd;
  if (!isPositiveNumber(btc)) {
    throw new Error("coingecko response missing bitcoin.usd");
  }
  if (!isPositiveNumber(usdc)) {
    throw new Error("coingecko response missing usd-coin.usd");
  }
  return { btc_usd: btc, usdc_usd: usdc, as_of: new Date().toISOString() };
}

/**
 * One raw call to CoinGecko's `simple/price` endpoint for **BTC only**. No
 * cache, no retry. Hits the bitcoin-only URL by default — narrower upstream
 * surface, and a malformed `usd-coin.usd` cannot break this caller.
 */
export async function fetchCoinGeckoBtcUsd(
  opts?: CoinGeckoFetchOptions
): Promise<CoinGeckoBtcSpot> {
  const body = await fetchCoinGeckoBody(opts, COINGECKO_BTC_USD_URL);
  const btc = body.bitcoin?.usd;
  if (!isPositiveNumber(btc)) {
    throw new Error("coingecko response missing bitcoin.usd");
  }
  return { btc_usd: btc, as_of: new Date().toISOString() };
}

interface CoinGeckoBody {
  bitcoin?: { usd?: unknown };
  "usd-coin"?: { usd?: unknown };
}

async function fetchCoinGeckoBody(
  opts: CoinGeckoFetchOptions | undefined,
  defaultUrl: string
): Promise<CoinGeckoBody> {
  const url = opts?.url ?? defaultUrl;
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts?.userAgent ?? DEFAULT_USER_AGENT;

  const res = await fetchImpl(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`coingecko returned HTTP ${res.status.toString()}`);
  }
  return (await res.json()) as CoinGeckoBody;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}
