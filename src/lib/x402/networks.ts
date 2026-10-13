import { DvmError } from "../errors";

/** Everything the x402 rail needs to know about one settlement chain. */
export interface X402Network {
  /** CAIP-2 chain id — the form the caller wallet and DVM configs are written in. */
  caip2: string;
  /** Legacy v1 network slug; v2 uses CAIP-2. */
  slug: string;
  /** Human name for copy ("Base"). */
  label: string;
  /** Circle's native USDC contract on this chain. */
  usdc: `0x${string}`;
  /** EIP-712 domain `name` of that contract (EIP-3009 signing). */
  domainName: string;
  /** EIP-712 domain `version` of that contract. */
  domainVersion: string;
  /**
   * Export name of this chain's object in `viem/chains`. A string rather than
   * the object itself because viem is an optional peer dependency, so every
   * use of it is a lazy `await import`.
   */
  viemChain: string;
  /**
   * Ticker of the token this chain charges gas in — what a caller has to hold
   * before the timed channel exit can submit anything.
   *
   * A column rather than a read of viem's `nativeCurrency.symbol` because the
   * refusal that names it is copy, and copy is what this table is for; the row
   * test pins it against viem so the two can't drift.
   */
  nativeGas: string;
  /** Bridged token commonly confused with native USDC, or null if unnamed. */
  confusable: string | null;
}

export const X402_NETWORKS: readonly X402Network[] = [
  {
    caip2: "eip155:8453",
    slug: "base",
    label: "Base",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    domainName: "USD Coin",
    domainVersion: "2",
    viemChain: "base",
    nativeGas: "ETH",
    confusable: "USDbC",
  },
  {
    caip2: "eip155:84532",
    slug: "base-sepolia",
    label: "Base Sepolia",
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    domainName: "USDC",
    domainVersion: "2",
    viemChain: "baseSepolia",
    nativeGas: "ETH",
    confusable: null,
  },
  {
    caip2: "eip155:43114",
    slug: "avalanche",
    label: "Avalanche",
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
    domainName: "USD Coin",
    domainVersion: "2",
    viemChain: "avalanche",
    nativeGas: "AVAX",
    confusable: "USDC.e",
  },
  {
    caip2: "eip155:43113",
    slug: "avalanche-fuji",
    label: "Avalanche Fuji",
    usdc: "0x5425890298aed601595a70AB815c96711a31Bc65",
    domainName: "USD Coin",
    domainVersion: "2",
    viemChain: "avalancheFuji",
    nativeGas: "AVAX",
    confusable: null,
  },
  {
    caip2: "eip155:137",
    slug: "polygon",
    label: "Polygon",
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    domainName: "USD Coin (PoS)",
    domainVersion: "2",
    viemChain: "polygon",
    nativeGas: "POL",
    confusable: "USDC.e",
  },
  {
    caip2: "eip155:80002",
    slug: "polygon-amoy",
    label: "Polygon Amoy",
    usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
    domainName: "USDC",
    domainVersion: "2",
    viemChain: "polygonAmoy",
    nativeGas: "POL",
    confusable: null,
  },
];

/** Look up a chain by CAIP-2 id (`eip155:8453`). Undefined when unsupported. */
export function x402NetworkByCaip2(caip2: string): X402Network | undefined {
  return BY_CAIP2.get(caip2);
}

/** Look up a chain by x402 slug (`base`). Undefined when unsupported. */
export function x402NetworkBySlug(slug: string): X402Network | undefined {
  return BY_SLUG.get(slug);
}

/** Name a chain for relayable copy, falling back to its raw CAIP-2 id. */
export function x402NetworkLabel(network: string): string {
  const spec = x402NetworkByCaip2(network);
  return spec ? `${spec.label} (${network})` : network;
}

/**
 * The accepted chains as one printable list — `eip155:8453 (Base), …`.
 *
 * CAIP-2 first because that's what `--network` takes; the label follows so a
 * human reading the relayed error recognises the chain without looking up a
 * number.
 */
export function x402NetworkListForCopy(): string {
  return X402_NETWORKS.map((n) => `${n.caip2} (${n.label})`).join(", ");
}

/**
 * Throw unless `network` is a chain this rail can both pay and read on.
 *
 * Called at connect time, on the way into config — the whole point is that an
 * unsupported chain never gets persisted, because its only later symptom is a
 * balance read that fails and a wallet that reports as broken. Deliberately
 * *not* called on load: a config already carrying an unsupported chain has to
 * stay loadable so `dvm doctor` can diagnose it rather than crash on it.
 */
export function assertSupportedX402Network(network: string): void {
  if (x402NetworkByCaip2(network)) return;
  throw new DvmError(
    "unsupported_network",
    `Unsupported x402 network: ${network}.`,
    `${x402SupportedNetworksHint()} If a wallet is connected, run 'dvm wallet x402-network <caip2>'. For a first connection, pass --network to 'dvm wallet x402-connect'.`
  );
}

/** The one sentence naming what the rail accepts, shared by every surface that has to say it. */
export function x402SupportedNetworksHint(): string {
  return `This rail settles native USDC on: ${x402NetworkListForCopy()}.`;
}

const BY_CAIP2 = new Map(X402_NETWORKS.map((n) => [n.caip2, n]));
const BY_SLUG = new Map(X402_NETWORKS.map((n) => [n.slug, n]));
