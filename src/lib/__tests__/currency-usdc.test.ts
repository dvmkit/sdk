import { describe, expect, it } from "vitest";

import { formatUsdcMicrounits, msatsToUsdc, usdcToMsats } from "../currency";

describe("formatUsdcMicrounits", () => {
  it("formats microunits exactly without float rounding", () => {
    expect(formatUsdcMicrounits("2050")).toBe("0.00205");
    expect(formatUsdcMicrounits(500_000n)).toBe("0.50");
    expect(formatUsdcMicrounits(4_300_000n)).toBe("4.30");
    expect(formatUsdcMicrounits(1_234_560n)).toBe("1.23456");
    expect(formatUsdcMicrounits(1_000_000n)).toBe("1.00");
  });
});

describe("msatsToUsdc", () => {
  it("does not round an exact micro-unit up because of float residue", () => {
    // 500,000 msats is 1/200,000 BTC; at $70,000/BTC it is exactly $0.35.
    expect(msatsToUsdc(500_000, 70_000)).toBe(350_000);
  });

  it("keeps the ceiling on either side of an exact micro-unit", () => {
    expect(msatsToUsdc(499_999, 70_000)).toBe(350_000);
    expect(msatsToUsdc(500_001, 70_000)).toBe(350_001);
  });

  it("uses the stated decimal rate when deciding the micro-unit ceiling", () => {
    expect(msatsToUsdc(500_000, 70_000.2)).toBe(350_001);
    expect(msatsToUsdc(500_000, 70_000.1)).toBe(350_001);
    expect(msatsToUsdc(100_000, 70_000.01)).toBe(70_001);
  });

  it("converts millisats to USDC micro-units at rate 100_000", () => {
    // 100_000_000 msats = $100 at rate 100k => 100 * 1e6 = 100_000_000 USDC micro-units
    const result = msatsToUsdc(100_000_000, 100_000);
    expect(result).toBe(100_000_000);
  });

  it("rounds up for fractional amounts", () => {
    // 1 msat at rate 100k = very tiny USD, but should ceil to at least 1
    const result = msatsToUsdc(1, 80_000);
    expect(result).toBe(1);
  });

  it("handles zero", () => {
    expect(msatsToUsdc(0, 100_000)).toBe(0);
  });
});

describe("usdcToMsats", () => {
  it("converts USDC (human-readable) to millisats at rate 100_000", () => {
    // $1 USDC at rate 100k => 1_000_000 msats
    const result = usdcToMsats(1, 100_000);
    expect(result).toBe(1_000_000);
    expect(usdcToMsats(0.000002, 55_000)).toBe(4);
  });

});
