import * as viemChains from "viem/chains";
import { describe, expect, it } from "vitest";

import {
  X402_NETWORKS,
  x402NetworkByCaip2,
  x402NetworkBySlug
} from "../networks";
import { caip2ToX402Network, chainIdFromCaip2, usdcContractByCaip2 } from "../spec";

describe("X402_NETWORKS", () => {
  it("accepts exactly the six chains the rail serves end to end", () => {
    expect(X402_NETWORKS.map((n) => n.caip2)).toEqual([
      "eip155:8453",
      "eip155:84532",
      "eip155:43114",
      "eip155:43113",
      "eip155:137",
      "eip155:80002",
    ]);
  });

  it.each(X402_NETWORKS)("$caip2 carries every fact the rail needs", (network) => {
    // A chain object viem actually exports, on the chain id the CAIP-2 promises:
    // the balance read builds its public client from this, and a name that
    // resolves to the wrong chain would read someone else's balance.
    const chain = (
      viemChains as unknown as Record<
        string,
        { id: number; nativeCurrency: { symbol: string } } | undefined
      >
    )[network.viemChain];
    expect(chain, `viem/chains has no export named ${network.viemChain}`).toBeDefined();
    expect(chain?.id).toBe(chainIdFromCaip2(network.caip2));

    // The gas refusal on the timed exit names this ticker, and a caller reading
    // it goes and buys the token. Pinned against viem so the copy can't drift
    // from what the chain actually charges.
    expect(network.nativeGas).toBe(chain?.nativeCurrency.symbol);

    expect(network.usdc).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(network.domainName.length).toBeGreaterThan(0);
    expect(network.domainVersion).toBe("2");
    expect(network.label.length).toBeGreaterThan(0);
  });

  it("keeps the spec accessors reading off the same rows", () => {
    for (const network of X402_NETWORKS) {
      expect(caip2ToX402Network(network.caip2)).toBe(network.slug);
      expect(usdcContractByCaip2(network.caip2)).toBe(network.usdc);
      expect(x402NetworkBySlug(network.slug)).toBe(network);
    }
  });

  it("returns undefined for a chain outside the table", () => {
    // Ethereum mainnet used to have a chain loader and no USDC contract, which
    // is exactly the half-support this table exists to make impossible.
    expect(x402NetworkByCaip2("eip155:1")).toBeUndefined();
    expect(x402NetworkByCaip2("eip155:8543")).toBeUndefined();
    expect(x402NetworkByCaip2("solana:mainnet")).toBeUndefined();
    // CAIP-2 is the wallet's form; the wire slug is not an accepted --network.
    expect(x402NetworkByCaip2("base")).toBeUndefined();
  });
});
