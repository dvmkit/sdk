import { loadAgentWallet } from "../wallet-agent/store";

/** Get total balance in msats, optionally filtered to a single mint. */
export function getBalance(mintUrl?: string): number {
  const wallet = loadAgentWallet();
  if (!wallet) return 0;
  const proofs = wallet.proofs.filter(
    (p) => p.status === "valid" && (mintUrl === undefined || p.mint === mintUrl)
  );
  return proofs.reduce((sum, p) => sum + p.amount, 0) * 1000;
}

/** Get balance per mint as a Map of mintUrl → msats. */
export function getBalanceByMint(): Map<string, number> {
  const wallet = loadAgentWallet();
  if (!wallet) return new Map();
  const map = new Map<string, number>();
  for (const p of wallet.proofs) {
    if (p.status !== "valid") continue;
    map.set(p.mint, (map.get(p.mint) ?? 0) + p.amount * 1000);
  }
  return map;
}
