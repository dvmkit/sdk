import { isValidEvmPrivateKey } from "./evm-private-key";
import { X402_DEFAULT_NETWORK } from "./x402/spec";
import type { X402Wallet } from "./x402/types";

/** Credential projection only; config persistence and replacement policy belong to its owner. */
export interface WalletCredentialConfig {
  x402?: { privateKey: string; network?: string };
  tempo?: { method: string; apiKey?: string; network?: "mainnet" | "moderato" };
}

export interface TempoCredentialAccount {
  address: `0x${string}`;
  privateKey: `0x${string}`;
  network?: "mainnet" | "moderato";
}

export function x402WalletFromConfig(config: WalletCredentialConfig | null): X402Wallet | null {
  const x402 = config?.x402;
  const privateKey = x402?.privateKey;
  if (!privateKey || !isValidEvmPrivateKey(privateKey)) return null;
  return { privateKey, address: "", network: x402.network ?? X402_DEFAULT_NETWORK };
}

export async function tempoAccountFromConfig(
  config: WalletCredentialConfig | null
): Promise<TempoCredentialAccount | null> {
  if (config?.tempo?.method !== "tempo") return null;
  const privateKey = config.tempo.apiKey;
  if (!privateKey || !isValidEvmPrivateKey(privateKey)) return null;
  const { privateKeyToAccount } = await import("viem/accounts");
  const address = privateKeyToAccount(privateKey).address.toLowerCase() as `0x${string}`;
  return { privateKey, address, network: config.tempo.network ?? "mainnet" };
}
