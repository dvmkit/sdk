import { describe, expect, it } from "vitest";
import { tempoAccountFromConfig, x402WalletFromConfig } from "../wallet-credentials";

const key = `0x${"0".repeat(63)}1`;

describe("credential projections without configuration IO", () => {
  it("preserves the x402 default and explicit network without resolving or persisting an address", () => {
    expect(x402WalletFromConfig({ x402: { privateKey: key } })).toEqual({
      privateKey: key, address: "", network: "eip155:8453",
    });
    expect(x402WalletFromConfig({ x402: { privateKey: key, network: "eip155:137" } })?.network).toBe("eip155:137");
  });

  it("derives the scalar-one Tempo account and preserves its configured network", async () => {
    expect(await tempoAccountFromConfig({ tempo: { method: "tempo", apiKey: key, network: "moderato" } })).toEqual({
      privateKey: key,
      address: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
      network: "moderato",
    });
    expect((await tempoAccountFromConfig({ tempo: { method: "tempo", apiKey: key } }))?.network).toBe("mainnet");
  });

  it("treats absent credentials, an unsupported method and out-of-range scalars as unconnected", async () => {
    expect(x402WalletFromConfig(null)).toBeNull();
    expect(await tempoAccountFromConfig(null)).toBeNull();
    expect(await tempoAccountFromConfig({ tempo: { method: "other", apiKey: key } })).toBeNull();
    for (const invalid of ["0x" + "0".repeat(64), "0x" + "f".repeat(64), "not-a-key"]) {
      expect(x402WalletFromConfig({ x402: { privateKey: invalid } })).toBeNull();
      expect(await tempoAccountFromConfig({ tempo: { method: "tempo", apiKey: invalid } })).toBeNull();
    }
  });
});
