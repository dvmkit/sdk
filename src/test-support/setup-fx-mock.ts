/** Intercept provider HTTP, preserving real parsers and per-test fetch overrides.
 * Load after the network guard so canned FX replies precede its refusal.
 * Other hosts pass through; an unstubbed rate lookup stays deterministic. */
import { COINGECKO_SIMPLE_PRICE_URL } from "../lib/fx-coingecko";

/** BTC/USD rate every test sees from an unstubbed CoinGecko call. Round, so `1 sat = $0.001`. */
export const TEST_BTC_USD_RATE = 100_000;

/** USDC/USD rate every test sees from an unstubbed CoinGecko call. */
export const TEST_USDC_USD_RATE = 1;

/** EUR-base reference rates every test sees from an unstubbed ECB call. */
export const TEST_ECB_RATES = {
  eur_usd: 1.1,
  eur_gbp: 0.85,
  eur_chf: 0.95,
  eur_jpy: 160,
};

const COINGECKO_ORIGIN = new URL(COINGECKO_SIMPLE_PRICE_URL).origin;
const ECB_ORIGIN = "https://www.ecb.europa.eu";

const realFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async function fetchWithFxStub(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1]
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith(COINGECKO_ORIGIN)) {
    // Both endpoint variants (`ids=bitcoin` and `ids=bitcoin,usd-coin`) parse out
    // of this one body — the BTC-only caller just ignores the `usd-coin` key.
    return jsonResponse({
      bitcoin: { usd: TEST_BTC_USD_RATE },
      "usd-coin": { usd: TEST_USDC_USD_RATE },
    });
  }
  if (url.startsWith(ECB_ORIGIN)) {
    return xmlResponse(ecbDailyXml());
  }
  return await realFetch(input, init);
} as typeof fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function xmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "Content-Type": "text/xml" } });
}

/**
 * A minimal `eurofxref-daily.xml`, stamped with today's UTC date so the row
 * `coldStartFetch` writes is an exact hit for a same-day lookup — the weekday
 * case, and the one every suite that consumes a fiat rate already assumes.
 */
function ecbDailyXml(): string {
  const today = new Date().toISOString().slice(0, 10);
  const cubes = [
    `<Cube currency='USD' rate='${TEST_ECB_RATES.eur_usd.toString()}'/>`,
    `<Cube currency='GBP' rate='${TEST_ECB_RATES.eur_gbp.toString()}'/>`,
    `<Cube currency='CHF' rate='${TEST_ECB_RATES.eur_chf.toString()}'/>`,
    `<Cube currency='JPY' rate='${TEST_ECB_RATES.eur_jpy.toString()}'/>`,
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <Cube><Cube time='${today}'>${cubes}</Cube></Cube>
</gesmes:Envelope>`;
}
