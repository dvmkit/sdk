import { describe, expect, it, vi } from "vitest";

vi.mock("fs");
vi.mock("../../defaults", () => ({ BTC_RATE_FILE: "/mock/.dvm/btc-rate.json" }));

import { existsSync, readFileSync } from "fs";

describe("BTC rate cache validation", () => {
  it("ignores a poisoned cache instead of using it when the provider fails", async () => {
    vi.resetModules();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ rate: 999_999_999, timestamp: Date.now() }));
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 429 })));
    const { fetchBtcUsdRate, getLastKnownBtcRate } = await import("../currency");
    expect(getLastKnownBtcRate()).toBeNull();
    await expect(fetchBtcUsdRate()).rejects.toThrow();
  });
});
