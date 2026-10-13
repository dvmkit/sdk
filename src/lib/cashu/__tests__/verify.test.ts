import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cashu/cashu-ts", () => ({
  getTokenMetadata: vi.fn(),
}));

import { getTokenMetadata } from "@cashu/cashu-ts";

import { DvmError } from "../../errors";
import { verifyCashuToken } from "../verify";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("verifyCashuToken", () => {
  it("returns mint and totalMsats for valid token at accepted mint", () => {
    vi.mocked(getTokenMetadata).mockReturnValue({
      mint: "https://mint.a",
      unit: "sat",
      amount: { toNumber: () => 12 } as never,
      incompleteProofs: [],
      proofAmounts: [],
    });

    const result = verifyCashuToken("cashuBtoken", ["https://mint.a"]);

    expect(result.mint).toBe("https://mint.a");
    expect(result.totalMsats).toBe(12_000);
    expect(result.unit).toBe("sat");
  });

  it("throws cashu_invalid_token for unparseable token", () => {
    vi.mocked(getTokenMetadata).mockImplementation(() => {
      throw new Error("bad");
    });

    expect(() => verifyCashuToken("garbage", ["https://mint.a"])).toThrow(DvmError);
    expect(() => verifyCashuToken("garbage", ["https://mint.a"])).toThrow("could not be decoded");
  });

  it("throws cashu_mint_not_accepted when mint is not in accepted list", () => {
    vi.mocked(getTokenMetadata).mockReturnValue({
      mint: "https://evil.mint",
      unit: "sat",
      amount: { toNumber: () => 1 } as never,
      incompleteProofs: [],
      proofAmounts: [],
    });

    expect(() => verifyCashuToken("cashuBtoken", ["https://mint.a"])).toThrow(DvmError);

    try {
      verifyCashuToken("cashuBtoken", ["https://mint.a"]);
    } catch (e) {
      expect((e as DvmError).code).toBe("cashu_mint_not_accepted");
    }
  });

  it("normalises mint URLs for comparison (case-insensitive, trailing slash)", () => {
    vi.mocked(getTokenMetadata).mockReturnValue({
      mint: "https://MINT.A/",
      unit: "usd",
      amount: { toNumber: () => 2 } as never,
      incompleteProofs: [],
      proofAmounts: [],
    });

    const result = verifyCashuToken("cashuBtoken", ["https://mint.a"]);
    expect(result.mint).toBe("https://MINT.A/");
    expect(result.totalMsats).toBe(2_000);
    expect(result.unit).toBe("usd");
  });

});
