import { DvmError } from "../errors";
import { isValidEvmPrivateKey } from "../evm-private-key";
import {
  resolveRpcHttpTransportOptions,
  resolveRpcOverride,
  type RpcSource,
} from "../payment-rails/rpc";
import { redactUrl, redactUrlsInText } from "../url-redact";
import { x402NetworkByCaip2, x402SupportedNetworksHint } from "./networks";
import { X402_DEFAULT_NETWORK } from "./spec";
import type { X402Wallet } from "./types";

export async function ensureAddress(wallet: X402Wallet): Promise<X402Wallet> {
  if (!isValidEvmPrivateKey(wallet.privateKey)) throw invalidX402PrivateKey();
  if (wallet.address) return wallet;
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(wallet.privateKey);
  return { ...wallet, address: account.address };
}

export async function generateX402PrivateKey(): Promise<`0x${string}`> {
  const { generatePrivateKey } = await import("viem/accounts");
  return generatePrivateKey();
}

/** What `saveX402Wallet` persisted — the derived address and the chain it resolved to. */
export interface X402ConnectedWallet {
  address: string;
  /** CAIP-2 chain the wallet pays on: explicit argument > previously configured > Base. */
  network: string;
}

/** What changing a connected x402 wallet's settlement chain preserved and updated. */
export interface X402RepinnedWallet {
  /** Address derived from the private key that stayed connected. */
  address: string;
  /** Chain new payments used before this update. */
  previousNetwork: string;
  /** Chain new payments use after this update. */
  network: string;
}

function invalidX402PrivateKey(): DvmError {
  return new DvmError(
    "invalid_key",
    "Invalid secp256k1 private key.",
    "Reconnect with `dvm wallet x402-connect --key-file <path>`, set DVM_X402_KEY, or pipe a valid 0x-prefixed 32-byte secp256k1 private key through stdin."
  );
}

/**
 * Live balance result from {@link getX402Balance}.
 *
 * As on the Tempo rail, the endpoint comes back only in redacted form — a
 * caller's `DVM_X402_RPC_URL` usually holds a provider API key in its path,
 * and this object is one JSON spread away from caller-visible output
 */
export interface X402Balance {
  /** Account whose USDC balance was queried. */
  address: string;
  /** Balance in USDC (base units / 10^6, returned as a number for display). */
  usdc: number;
  /** CAIP-2 chain the read was issued on. */
  network: string;
  /** USDC token contract the balance was queried against. */
  tokenAddress: `0x${string}`;
  /**
   * Endpoint the query was issued against, redacted to origin + de-identified
   * path. Undefined only for a chain viem ships no default endpoint for, where
   * the transport falls back to viem's own resolution.
   */
  rpcUrlRedacted: string | undefined;
  /**
   * Whether {@link rpcUrlRedacted} came from `DVM_X402_RPC_URL` or the chain's
   * bundled default — which knob a caller has to turn to move a surprising read.
   */
  rpcSource: RpcSource;
}

/**
 * Fetch USDC balance for a wallet.
 *
 * The contract and the viem chain both come off one network row, so a chain
 * this can read a balance on is exactly a chain the rail can pay on — the two
 * used to be separate lists, and the four chains in one but not the other were
 * the source of past network-support drift.
 *
 * Chain RPC is `DVM_X402_RPC_URL` if set, else the bundled default for the
 * pinned chain that ships with `viem/chains`. Those defaults are shared and
 * rate-limited, so a caller whose read gets a 429 needs somewhere else to point
 * it — the same escape hatch the Tempo rail has.
 *
 * Throws a `DvmError` on a chain outside the table, and another on an RPC that
 * didn't answer, so the probe layer can carry the code through and `dvm doctor`
 * can say which chain is unsupported — or which endpoint failed — rather than
 * implying the install is broken.
 *
 * The resolved endpoint comes back on the success path too. A read
 * that succeeds against the wrong endpoint — an override left pointing at
 * another chain — is the case with no signal at all: it reports a plausible
 * $0.00 that nothing else distinguishes from an unfunded wallet.
 */
export async function getX402Balance(wallet: X402Wallet): Promise<X402Balance> {
  const w = await ensureAddress(wallet);
  const spec = x402NetworkByCaip2(w.network);
  if (!spec) {
    throw new DvmError(
      "x402_unsupported_network",
      `The x402 wallet is configured for ${w.network}, a chain this rail can't settle on.`,
      `${x402SupportedNetworksHint()} Re-pin the connected wallet without handling its key: 'dvm wallet x402-network ${X402_DEFAULT_NETWORK}'.`
    );
  }
  // Both imports stay outside the try: viem is an optional peer dependency, and
  // a missing one has to keep reaching the "ensure viem is installed" remedy
  // instead of being relabelled as an endpoint that didn't answer.
  const chains = (await import("viem/chains")) as unknown as Record<string, unknown>;
  const { createPublicClient, http, erc20Abi } = await import("viem");
  const chain = chains[spec.viemChain] as Parameters<typeof createPublicClient>[0]["chain"];
  const { url: rpcUrl, source: rpcSource } = resolveRpcOverride(
    process.env.DVM_X402_RPC_URL,
    chain?.rpcUrls.default.http[0]
  );

  try {
    const transportOptions = resolveRpcHttpTransportOptions(
      rpcSource,
      process.env.DVM_X402_RPC_HEADERS_JSON
    );
    const client = createPublicClient({
      chain,
      transport: transportOptions ? http(rpcUrl, transportOptions) : http(rpcUrl),
    });
    const balance = await client.readContract({
      address: spec.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [w.address as `0x${string}`],
    });
    return {
      address: w.address,
      usdc: Number(balance) / 1e6,
      network: w.network,
      tokenAddress: spec.usdc,
      // redacted here rather than at a display surface, so the clear
      // endpoint never leaves this function on the success path either.
      rpcUrlRedacted: rpcUrl ? redactUrl(rpcUrl) : undefined,
      rpcSource,
    };
  } catch (err) {
    // Every endpoint named here is redacted to origin + de-identified path.
    // The providers a caller reaches for put their API key in the URL path,
    // and this text is built to be relayed onward by an agent. viem prints
    // its own `URL: …` line into the error, so the underlying message needs
    // the same sweep — redacting only the endpoint we resolved would leave a
    // second, unredacted copy sitting inside it.
    const cause = redactUrlsInText(err instanceof Error ? err.message : String(err));
    throw new DvmError(
      "x402_rpc_error",
      `x402 USDC balance lookup on ${spec.label} failed: ${cause}`,
      // A caller who set the override doesn't need to be told to set it. Which
      // knob is theirs to turn depends on whose endpoint this was.
      rpcSource === "override"
        ? `DVM_X402_RPC_URL sent this read to ${redactUrl(rpcUrl)}. Correct it, or unset it to fall back to ${spec.label}'s bundled endpoint.`
        : `Verify connectivity to ${spec.label}'s bundled endpoint${rpcUrl ? ` (${redactUrl(rpcUrl)})` : ""}, or send the read somewhere else with DVM_X402_RPC_URL.`
    );
  }
}
