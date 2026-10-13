export function msatsToUsd(msats: number, rate: number): number {
  return (msats / 100_000_000_000) * rate;
}

export function usdToMsats(usd: number, rate: number): number {
  return Math.round((usd / rate) * 100_000_000_000);
}

export function msatsToUsdCents(msats: number, btcPriceUsd: number): number {
  const usd = msatsToUsd(msats, btcPriceUsd);
  return Math.round(usd * 100);
}

/** Convert millisatoshis to USDC amount (6-decimal micro-units). USDC ≈ USD. */
export function msatsToUsdc(msats: number, btcUsdRate: number): number {
  if (!Number.isSafeInteger(msats) || msats < 0) {
    throw new RangeError("msats must be a non-negative safe integer");
  }
  if (!Number.isFinite(btcUsdRate) || btcUsdRate <= 0) {
    throw new RangeError("BTC/USD rate must be finite and positive");
  }

  // Interpret the rate's decimal representation exactly so binary residue cannot change the ceiling.
  const [mantissa, exponent = "0"] = btcUsdRate.toString().split("e");
  const decimalPlaces = mantissa.split(".")[1]?.length ?? 0;
  const shift = Number(exponent) - decimalPlaces;
  let numerator = BigInt(msats) * BigInt(mantissa.replace(".", ""));
  let denominator = 100_000n;
  if (shift > 0) numerator *= 10n ** BigInt(shift);
  else if (shift < 0) denominator *= 10n ** BigInt(-shift);

  const micro = (numerator + denominator - 1n) / denominator;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("USDC micro-unit amount exceeds the safe integer range");
  }
  return Number(micro);
}

/** Convert USDC amount (human-readable, e.g. 1.50) to millisatoshis. */
export function usdcToMsats(usdc: number, btcUsdRate: number): number {
  return usdToMsats(usdc, btcUsdRate);
}

export function msatsToMicro(msats: number, btcRate: number): number {
  return Math.round(msatsToUsd(msats, btcRate) * 1_000_000);
}

/** Convert a micro-unit USD amount into whole sats (ceil) at the given rate. */
export function microToSats(micro: number, btcRate: number): number {
  return Math.ceil(usdToMsats(micro / 1_000_000, btcRate) / 1000);
}
