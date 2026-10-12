/**
 * Live moderato tests self-fund a fresh key through `tempo_fundAddress`.
 * The faucet provides six-decimal TIP-20 stablecoins for both payment and gas;
 * no provisioned wallet is needed. The RPC and chain ID match mppx testnet
 * defaults. `TEMPO_TESTNET_RPC` also enables the network guard for this tier.
 */

import {
  isNetworkGuardBlocked,
  MODERATO_RPC_DEFAULT,
} from "../../../test-support/network-guard-policy";

/** Moderato (Tempo public testnet) chain id. */
export const MODERATO_CHAIN_ID = 42431;

/**
 * Moderato RPC. Defaults to the public endpoint; override with
 * `TEMPO_TESTNET_RPC` (the env var CI sets to enable this tier).
 */
export const TEMPO_TESTNET_RPC = process.env.TEMPO_TESTNET_RPC ?? MODERATO_RPC_DEFAULT;

/**
 * pathUSD — the TIP-20 stablecoin `tempo_fundAddress` drips and mppx's
 * `resolveCurrency` picks by default on testnet (6 decimals).
 */
export const PATH_USD = "0x20c0000000000000000000000000000000000000";

async function rpc<T>(method: string, params: unknown[], timeoutMs = 8000): Promise<T> {
  const res = await fetch(TEMPO_TESTNET_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(`${method} → ${body.error.message ?? "rpc error"}`);
  return body.result as T;
}

/**
 * Probe `eth_chainId` on {@link TEMPO_TESTNET_RPC}. Returns false on any error,
 * timeout, or a chainId that isn't moderato — so a testnet outage skips the
 * tier cleanly rather than reddening CI.
 *
 * A vitest network-guard block is the one failure it does **not** swallow: that
 * means the tier is enabled but its host was never allowlisted, and reporting it
 * as an outage is what hid the tier's silent skip for months. Rethrow
 * so the run goes red and names the fix.
 */
export async function isTempoTestnetReachable(): Promise<boolean> {
  try {
    const chainIdHex = await rpc<string>("eth_chainId", [], 3000);
    return Number.parseInt(chainIdHex, 16) === MODERATO_CHAIN_ID;
  } catch (err) {
    if (isNetworkGuardBlocked(err)) throw err;
    return false;
  }
}

/** pathUSD balance (raw 6-decimal units) of `address` via `eth_call` balanceOf. */
export async function pathUsdBalance(address: string): Promise<bigint> {
  // balanceOf(address) selector 0x70a08231 + 32-byte left-padded address.
  const data = `0x70a08231${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const hex = await rpc<string>("eth_call", [{ to: PATH_USD, data }, "latest"]);
  return BigInt(hex);
}

/**
 * Fund `address` with test stablecoins via `tempo_fundAddress`, then poll its
 * pathUSD balance until the drip lands (bounded), so callers don't race the
 * faucet. Throws if the balance hasn't increased within the deadline.
 */
export async function fundTestnetAddress(address: string): Promise<void> {
  const before = await pathUsdBalance(address);
  await rpc<string[]>("tempo_fundAddress", [address], 20000);

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if ((await pathUsdBalance(address)) > before) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `fundTestnetAddress: pathUSD balance for ${address} did not increase within 20s ` +
      `after tempo_fundAddress on ${TEMPO_TESTNET_RPC}. The moderato faucet may be down.`
  );
}
