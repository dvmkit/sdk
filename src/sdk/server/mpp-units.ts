import { msatsToUsd } from "../../lib/payment-amounts";

/**
 * Decimal places for each MPP method's native amount unit. Tempo USDC uses 6
 * decimals (TIP-20 stablecoin convention).
 */
function decimalsFor(methodName: string): number {
  switch (methodName) {
    case "tempo":
      return 6;
    default:
      throw new Error(`mpp-units: unknown method '${methodName}' (expected 'tempo')`);
  }
}

/**
 * Convert msats → method-native amount string for `mppx.challenge.<method>.<intent>({ amount })`.
 * mppx accepts a human-readable decimal string + `decimals`, then calls viem's
 * `parseUnits` internally — so we must format with at least `decimals` digits
 * of precision to avoid silent truncation (`parseUnits("0.001234", 2)` → `0`).
 */
export function msatsToMethodAmount(msats: number, methodName: string, btcUsd: number): string {
  const usd = msatsToUsd(msats, btcUsd);
  return usd.toFixed(decimalsFor(methodName));
}

/** Format fiat microunits as a method-native decimal amount without losing value. */
export function fiatMicroToMethodAmount(amountMicro: number, methodName: string): string {
  if (!Number.isSafeInteger(amountMicro) || amountMicro < 0) {
    throw new Error("mpp-units: fiat amount must be a non-negative safe integer");
  }
  const decimals = decimalsFor(methodName);
  const microDecimals = 6;
  let atomic = BigInt(amountMicro);
  if (decimals < microDecimals) {
    const divisor = 10n ** BigInt(microDecimals - decimals);
    if (atomic % divisor !== 0n) {
      throw new Error(
        `mpp-units: fiat microunits cannot be represented exactly with ${decimals} decimals`
      );
    }
    atomic /= divisor;
  } else if (decimals > microDecimals) {
    atomic *= 10n ** BigInt(decimals - microDecimals);
  }
  return methodNativeAmountToDecimal(atomic, methodName);
}

/** Default decimals for a known MPP method. */
export function methodDecimals(methodName: string): number {
  return decimalsFor(methodName);
}

/** Native asset tag for a given MPP method. */
export function methodNativeAsset(methodName: string): "sats" | "usdc" {
  switch (methodName) {
    case "tempo":
      return "usdc";
    default:
      throw new Error(`mpp-units: unknown method '${methodName}' (expected 'tempo')`);
  }
}

/** Parse the method-native decimal string into atomic units (micro-USDC for Tempo). */
export function methodNativeAmountFromDecimal(amountStr: string, methodName: string): number {
  return Math.round(parseFloat(amountStr) * 10 ** decimalsFor(methodName));
}

/** Format atomic method-native units as the human decimal string mppx request parsers expect. */
export function methodNativeAmountToDecimal(amount: string | bigint, methodName: string): string {
  const nativeAmount = BigInt(amount);
  if (nativeAmount < 0n) {
    throw new Error("mpp-units: amount must be non-negative");
  }
  const decimals = decimalsFor(methodName);
  const scale = 10n ** BigInt(decimals);
  return `${nativeAmount / scale}.${(nativeAmount % scale).toString().padStart(decimals, "0")}`;
}
