import { describe, expect, it } from "vitest";

import { resolveX402Asset } from "../asset";

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POLYGON_USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** {@link resolveX402Asset} for the chains the hint cases assume are nameable. */

describe("resolveX402Asset", () => {
  it("defaults to native USDC on Base", () => {
    const asset = resolveX402Asset();

    expect(asset).toMatchObject({
      address: BASE_USDC,
      symbol: "USDC",
      label: "native USDC",
      unit: "USDC",
      networkLabel: "Base",
      confusable: "USDbC",
    });
  });

  it("resolves an explicit Base network to the same asset as the default", () => {
    expect(resolveX402Asset("eip155:8453")).toMatchObject({
      address: BASE_USDC, symbol: "USDC", label: "native USDC", unit: "USDC", networkLabel: "Base", confusable: "USDbC",
    });
  });

  it("tracks a non-Base network rather than printing a stale Base contract", () => {
    const asset = resolveX402Asset("eip155:137");

    expect(asset).toMatchObject({
      address: POLYGON_USDC,
      networkLabel: "Polygon",
      // Polygon's bridged dollar is its own — USDC.e from the PoS bridge, not
      // Base's USDbC.
      confusable: "USDC.e",
    });
    expect(asset?.address).not.toBe(BASE_USDC);
  });

  it("names each mainnet's own bridged dollar, and none on a testnet", () => {
    expect(resolveX402Asset("eip155:43114")?.confusable).toBe("USDC.e");
    // Nobody funds a testnet wallet with a bridged testnet dollar by mistake,
    // so there is nothing to warn against and the copy falls back to generic.
    expect(resolveX402Asset("eip155:84532")?.confusable).toBeNull();
  });

  it("returns null for a chain outside the supported table", () => {
    // `--network` rejects both of these at connect time, so this is
    // only reachable from a config persisted before that. There is no asset to
    // name, and a status surface must not invent one.
    expect(resolveX402Asset("eip155:1")).toBeNull();
    expect(resolveX402Asset("solana:mainnet")).toBeNull();
  });
});
