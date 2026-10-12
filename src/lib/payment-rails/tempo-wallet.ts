/**
 * Imported and generated keys share `config.tempo`. Records without a network
 * retain the mainnet default. Balance reads target the configured token.
 */

import { DvmError } from "../errors";
import { isValidEvmPrivateKey } from "../evm-private-key";
import { redactUrl, redactUrlsInText } from "../url-redact";
import type { RailAsset } from "./asset";
import { resolveRpcHttpTransportOptions, resolveRpcOverride, type RpcSource } from "./rpc";

export interface TempoAccount {
  /** Lowercase 0x-prefixed 40-char EVM address derived from {@link privateKey}. */
  address: `0x${string}`;
  /** 0x-prefixed 32-byte hex private key (kept in `~/.dvm/config.json::tempo.apiKey`). */
  privateKey: `0x${string}`;
  /** Network this key is configured to spend on. */
  network?: TempoNetwork;
}

export type TempoNetwork = "mainnet" | "moderato";

/**
 * Carries the queried endpoint only in redacted form, including on success:
 * provider URLs may contain credentials and consumers may expose this object.
 */
export interface TempoBalance {

  address: `0x${string}`;
  /** Raw configured-token balance, in base units (6 decimals). */
  rawBaseUnits: bigint;
  /** Balance in USDC (`rawBaseUnits / 10^6`, returned as a number for display). */
  usdc: number;
  /** USDC token contract the balance was queried against. */
  tokenAddress: `0x${string}`;
  /** Tempo chain id the RPC was issued against. */
  chainId: number;
  /** Endpoint the query was issued against, redacted to origin + de-identified path. */
  rpcUrlRedacted: string;
  /**
   * Whether {@link rpcUrlRedacted} came from `DVM_TEMPO_RPC_URL` or Tempo's
   * bundled default — which knob a caller has to turn to move a surprising read.
   */
  rpcSource: RpcSource;
  /** Wall-clock ms when the balance was fetched. */
  fetchedAtMs: number;
}

/** Default USDC token on Tempo mainnet (mirrors `mpp-setup.ts`). */
export const TEMPO_USDC_MAINNET = "0x20C000000000000000000000b9537d11c60E8b50" as const;

export const TEMPO_CHAIN_ID = 4217;

export const TEMPO_MODERATO_CHAIN_ID = 42431;

/** Default pathUSD token on Tempo Moderato. */
export const TEMPO_PATH_USD_MODERATO =
  "0x20c0000000000000000000000000000000000000" as const;

export const TEMPO_MODERATO_RPC = "https://rpc.moderato.tempo.xyz" as const;

/** Stable chain, RPC, and default-token identity for a persisted Tempo network. */
export function resolveTempoNetwork(network: TempoNetwork = "mainnet"): {
  network: TempoNetwork;
  chainId: number;
  rpcUrl: string;
  defaultToken: `0x${string}`;
} {
  return network === "moderato"
    ? {
        network,
        chainId: TEMPO_MODERATO_CHAIN_ID,
        rpcUrl: TEMPO_MODERATO_RPC,
        defaultToken: TEMPO_PATH_USD_MODERATO,
      }
    : {
        network,
        chainId: TEMPO_CHAIN_ID,
        rpcUrl: "https://rpc.tempo.xyz",
        defaultToken: TEMPO_USDC_MAINNET,
      };
}

export type TempoAsset = RailAsset;

/**
 * Resolve the Tempo settlement asset from `DVM_TEMPO_CURRENCY`, falling
 * back to the bundled USDC.e mainnet default. Throws
 * `DvmError("tempo_config_invalid", ...)` when the override isn't an address.
 *
 * **Caller-side only.** `DVM_TEMPO_CURRENCY` is what a caller exports on their
 * own machine; the server's counterpart is `DVMKIT_TEMPO_CURRENCY`, read
 * independently in `mpp-setup.ts`. Passing a server `env`
 * here resolves the bundled mainnet default rather than that server's asset,
 * silently — so name the DVM's contract from wherever its env was built.
 */
export function resolveTempoAsset(
  env: NodeJS.ProcessEnv = process.env,
  network: TempoNetwork = "mainnet"
): TempoAsset {
  const address = (env.DVM_TEMPO_CURRENCY ?? resolveTempoNetwork(network).defaultToken) as `0x${string}`;
  if (!HEX_ADDRESS_RE.test(address)) {
    throw new DvmError(
      "tempo_config_invalid",
      `DVM_TEMPO_CURRENCY must be a 0x-prefixed 40-char hex address; got '${address}'.`,
      "Unset DVM_TEMPO_CURRENCY to fall back to the bundled USDC.e mainnet default."
    );
  }
  const symbol = tempoTokenSymbol(address);
  return {
    address,
    symbol,
    label: tempoTokenLabel(address),
    unit: symbol ?? "tokens",
  };
}

/**
 * Name any Tempo token for copy: its symbol when the CLI knows one, else a
 * shortened address.
 *
 * Separate from {@link resolveTempoAsset} because the token a surface has to
 * name is not always the configured settlement asset — a channel records the
 * token it was opened with, and the exit that pays fees in it has to say so
 * whether or not that is what this machine is configured to spend today.
 */
export function tempoTokenLabel(address: string): string {
  return tempoTokenSymbol(address) ?? `the token at ${shortAddress(address)}`;
}

/**
 * Name a Tempo token in copy the reader can act on: its symbol plus its
 * contract, or the bare contract when the CLI has no symbol for it.
 *
 * {@link tempoTokenLabel} is a name and shortens the address to stay readable,
 * which is right for the configured settlement asset (every surface that uses
 * it prints the full address alongside) and wrong for a token the reader has
 * to go fund — a truncated address is one they cannot paste anywhere. Any
 * channel outside mainnet USDC.e lands in that case.
 */
export function tempoTokenReference(address: string): string {
  const symbol = tempoTokenSymbol(address);
  return symbol ? `${symbol} (${address})` : address;
}

/**
 * Whether `dvm wallet balance` answers "how much of this token do I hold?".
 *
 * That command reads only the rail's configured settlement asset (see
 * {@link resolveTempoAsset}), so pointing at it is right when the token in
 * question *is* that asset and misleading otherwise: a channel opened on a
 * testnet, or under a different `DVM_TEMPO_CURRENCY`, reads a
 * believable zero against a contract the reader never asked about.
 */
export function tempoBalanceCheckHint(token: string): string {
  const configured = tryResolveTempoAsset();
  if (configured?.address.toLowerCase() === token.toLowerCase()) {
    return "This channel's token is the rail's configured settlement asset, so 'dvm wallet balance' reads it.";
  }
  return `'dvm wallet balance' reads the rail's configured settlement asset (${configured?.address ?? "unresolvable in this environment"}) rather than this channel's token (${token}), so query that contract directly for the balance that matters here.`;
}

/**
 * {@link resolveTempoAsset} for read-only surfaces, returning null instead of
 * throwing on a malformed `DVM_TEMPO_CURRENCY`.
 *
 * A balance read must fail loudly on a bad override — it would otherwise query
 * the wrong contract. A status or hint surface must not: `dvm wallet balance`
 * still has a Cashu balance to report and a probe error to attribute, and
 * aborting the whole command over a name it only needed for copy is a worse
 * outcome than printing the rest without one.
 */
export function tryResolveTempoAsset(env: NodeJS.ProcessEnv = process.env): TempoAsset | null {
  try {
    return resolveTempoAsset(env);
  } catch {
    return null;
  }
}

function tempoTokenSymbol(address: string): string | null {
  if (address.toLowerCase() === TEMPO_USDC_MAINNET.toLowerCase()) return "USDC.e";
  if (address.toLowerCase() === TEMPO_PATH_USD_MODERATO.toLowerCase()) return "pathUSD";
  return null;
}

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Query the live balance of `account` in the rail's settlement asset (see
 * {@link resolveTempoAsset}) on the Tempo chain. Chain RPC is
 * `DVM_TEMPO_RPC_URL` if set, else viem's bundled `tempo.rpcUrls.default`.
 *
 * Only the settlement contract is queried, so a wallet holding a different
 * Tempo stablecoin reads zero here by construction — callers surface
 * {@link tempoWrongAssetHint} on a zero balance rather than a bare `$0.00`.
 *
 * Throws a `DvmError("tempo_rpc_error", ...)` on RPC failure so callers can
 * surface the address + a "balance not queried" hint in `--human` output.
 */
export async function getTempoUsdcBalance(account: TempoAccount): Promise<TempoBalance> {
  const accountNetwork = account.network ?? "mainnet";
  const network = resolveTempoNetwork(accountNetwork);
  const tokenAddress = resolveTempoAsset(process.env, accountNetwork).address;
  const { createPublicClient, http, erc20Abi } = await import("viem");
  const { tempo, tempoModerato } = await import("viem/chains");
  const chain = accountNetwork === "moderato" ? tempoModerato : tempo;
  const { url: rpcUrl, source: rpcSource } = resolveRpcOverride(
    process.env.DVM_TEMPO_RPC_URL,
    network.rpcUrl
  );

  try {
    const transportOptions = resolveRpcHttpTransportOptions(
      rpcSource,
      process.env.DVM_TEMPO_RPC_HEADERS_JSON
    );
    const client = createPublicClient({
      chain,
      transport: transportOptions ? http(rpcUrl, transportOptions) : http(rpcUrl),
    });
    const raw = await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    return {
      address: account.address,
      rawBaseUnits: raw,
      usdc: Number(raw) / 1_000_000,
      tokenAddress,
      chainId: network.chainId,
      // redacted here rather than at a display surface, so the clear
      // endpoint never leaves this function on the success path either.
      rpcUrlRedacted: redactUrl(rpcUrl),
      rpcSource,
      fetchedAtMs: Date.now(),
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
      "tempo_rpc_error",
      `Tempo USDC balance lookup failed: ${cause}`,
      // A caller who set the override doesn't need to be told to set it. Which
      // knob is theirs to turn depends on whose endpoint this was.
      rpcSource === "override"
        ? `DVM_TEMPO_RPC_URL sent this read to ${redactUrl(rpcUrl)}. Correct it, or unset it to fall back to Tempo's bundled endpoint.`
        : `Verify connectivity to Tempo's bundled endpoint (${redactUrl(rpcUrl)}), or send the read somewhere else with DVM_TEMPO_RPC_URL.`
    );
  }
}

export async function deriveTempoAddress(privateKey: `0x${string}`): Promise<`0x${string}`> {
  if (!isValidEvmPrivateKey(privateKey)) throw invalidTempoPrivateKey();
  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
}

function shortAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function invalidTempoPrivateKey(): DvmError {
  return new DvmError(
    "invalid_api_key",
    "A Tempo private key must be a valid 0x-prefixed 32-byte hex secp256k1 private key.",
    "Generate one with `cast wallet new` or `openssl rand -hex 32` (and prepend 0x)."
  );
}
