import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

import { BTC_RATE_FILE } from "../defaults";
import type { Currency } from "../sdk/pricing/currency";
import { ensureConfigSubdir } from "./config-dir";
import { fetchCoinGeckoBtcUsd } from "./fx-coingecko";
export { msatsToUsd, msatsToUsdc, msatsToUsdCents, usdcToMsats, usdToMsats } from "./payment-amounts";

/**
 * Per-currency band thresholds used by {@link costAnchor}. Bands are tuned so
 * the same anchor label fires at roughly the same purchasing power across
 * currencies — USD/EUR/GBP collapse to the same scale at v1 granularity, JPY
 * is ×100ish because it has no sub-yen practical denomination. Adding a new
 * Currency means adding a row here; otherwise `costAnchor` falls back to the
 * USD bands.
 */
const COST_ANCHOR_BANDS: Record<string, [number, number, number, number]> = {
  usd: [0.01, 0.1, 1.0, 10.0],
  eur: [0.01, 0.1, 1.0, 10.0],
  gbp: [0.01, 0.1, 1.0, 10.0],
  jpy: [1, 10, 100, 1500],
};

/**
 * Map a fiat amount to a familiar cost-comparison label. Defaults to the USD
 * band table; pass `currency` to apply a non-USD scale. An unknown currency
 * falls back to USD bands so a caller adding a currency at the type layer but
 * not in this table degrades gracefully rather than silently mis-labelling.
 */
export function costAnchor(amount: number, currency: Currency = "usd"): string {
  const bands = COST_ANCHOR_BANDS[currency] ?? COST_ANCHOR_BANDS.usd;
  if (amount < bands[0]) return "fraction of a cent";
  if (amount <= bands[1]) return "comparable to an API call";
  if (amount <= bands[2]) return "comparable to a ChatGPT query";
  if (amount <= bands[3]) return "comparable to a coffee";
  return "significant purchase — review carefully";
}

export function formatUsd(usd: number): string {
  if (usd === 0) return "0.00";
  if (usd >= 0.01) return usd.toFixed(2);
  // Show enough digits so small amounts don't display as $0.00
  const digits = Math.max(2, -Math.floor(Math.log10(usd)) + 1);
  return usd.toFixed(digits);
}

/** Format integer USDC microunits without losing precision through a float conversion. */
export function formatUsdcMicrounits(microunits: string | bigint): string {
  const value = typeof microunits === "bigint" ? microunits : BigInt(microunits);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fraction.padEnd(2, "0") || "00"}`;
}

export async function fetchBtcUsdRate(): Promise<number> {

  if (memRate && Date.now() - memTime < CACHE_TTL) {
    return memRate;
  }

  const disk = readDiskCache();
  if (disk) {
    memRate = disk;
    memTime = Date.now();
    return disk;
  }

  const rate = await fetchFromApi();
  memRate = rate;
  memTime = Date.now();
  writeDiskCache(rate);
  return rate;
}

/**
 * Cached BTC/USD rate paired with the wall-clock instant it was last refreshed.
 * `cachedAt` is the Unix milliseconds the rate was fetched from the upstream
 * (or warmed into memory from disk). Pair this with {@link formatStaleness} to
 * render a human-readable "rate cached N ago" string.
 */
export interface CachedBtcRate {
  rate: number;
  cachedAt: number;
}

/**
 * Return the last known BTC/USD rate alongside its `cachedAt` timestamp, from
 * in-memory or disk cache, ignoring TTL. Use only as an offline fallback when
 * {@link fetchBtcUsdRate} fails — the rate may be stale, but a stale rate is
 * still better than treating the spend as $0 for budget-ledger accounting.
 * The `cachedAt` lets callers surface a freshness signal so users know the
 * rate isn't current.
 */
export function getLastKnownBtcRate(): CachedBtcRate | null {
  if (memRate && memTime > 0) return { rate: memRate, cachedAt: memTime };
  return readDiskCacheStale();
}

/**
 * Render a wall-clock distance as a short human label, e.g. "5 days ago" or
 * "2 hours ago" or "12 minutes ago". Used to tag amounts derived from a stale
 * cached BTC/USD rate so callers can see at a glance how old the conversion is.
 */
export function formatStaleness(cachedAt: number, now: number = Date.now()): string {
  const ageMs = Math.max(0, now - cachedAt);
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const CACHE_TTL = 5 * 60 * 1000;
const CACHE_FILE = BTC_RATE_FILE;

let memRate: number | null = null;
let memTime = 0;

interface DiskCache {
  rate: number;
  timestamp: number;
}

function readDiskCache(): number | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as DiskCache;
    if (Date.now() - data.timestamp >= CACHE_TTL) return null;
    if (!isPlausibleBtcUsdRate(data.rate)) return null;
    return data.rate;
  } catch {
    return null;
  }
}

function readDiskCacheStale(): CachedBtcRate | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as DiskCache;
    if (!isPlausibleBtcUsdRate(data.rate)) return null;
    return { rate: data.rate, cachedAt: data.timestamp };
  } catch {
    return null;
  }
}

function writeDiskCache(rate: number): void {
  try {
    // Resolved from CACHE_FILE rather than CONFIG_DIR so a defaults mock that
    // repoints BTC_RATE_FILE still works.
    ensureConfigSubdir(dirname(CACHE_FILE));
    writeFileSync(CACHE_FILE, JSON.stringify({ rate, timestamp: Date.now() }));
  } catch {
    // Best-effort — don't fail the command if we can't cache
  }
}

/**
 * Sanity bound for the live BTC/USD rate. Above this the upstream must be
 * malformed (or has hit a precision-busting bug); below `0` is rejected by
 * `fetchCoinGeckoBtcUsd` already. Defence-in-depth so a misparsed upstream
 * cannot land an absurd rate in the on-disk cache, and a legacy binary
 * that wrote a NaN/≤0 entry to disk doesn't get its garbage replayed on the
 * fresh-cache read path either (mirrored across both readers).
 */
const MAX_PLAUSIBLE_BTC_USD = 10_000_000;

function isPlausibleBtcUsdRate(rate: unknown): rate is number {
  return (
    typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate < MAX_PLAUSIBLE_BTC_USD
  );
}

async function fetchFromApi(): Promise<number> {
  const spot = await fetchCoinGeckoBtcUsd();
  const rate = spot.btc_usd;
  if (!isPlausibleBtcUsdRate(rate)) {
    throw new Error(`implausible BTC/USD rate from upstream: ${String(rate)}`);
  }
  return rate;
}
