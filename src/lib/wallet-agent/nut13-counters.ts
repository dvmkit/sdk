/**
 * NUT-13 deterministic-secret counter source backed by the agent wallet
 * file. cashu-ts calls `reserve(keysetId, n)` whenever it needs
 * a contiguous block of counters for a swap / mint / send operation; we
 * read the current `next` from `wallet.nut13_counters[mintUrl][keysetId]`,
 * return `{ start, count: n }`, and atomically write `start + n` back.
 *
 * Every mutation goes through {@link withWalletLock} so concurrent
 * `dvm wallet …` invocations against the same wallet file can't regress
 * a counter — a regression would cause the mint to refuse outputs with
 * `outputs_already_signed` (error 11003) and silently forfeit the loser's
 * blinded outputs.
 */
import type { CounterRange, CounterSource } from "@cashu/cashu-ts";

import { DvmError } from "../errors";
import { loadAgentWallet, saveAgentWallet, withWalletLock } from "./store";

/**
 * Wallet-file-backed {@link CounterSource} for one mint. One instance per
 * cashu-ts `Wallet`, constructed inside {@link getWallet} when `bip39seed`
 * is active. Pure mint-scoped state — counters for different mints live
 * under different keys in `wallet.nut13_counters` and never overlap.
 */
export class PersistentCounterSource implements CounterSource {
  constructor(private readonly mintUrl: string) {}

  /**
   * Reserve `n` counters for `keysetId`. Returns `{ start, count: n }`
   * and bumps the persisted `next` to `start + n` under the wallet lock.
   *
   * Per cashu-ts contract, `n === 0` MUST NOT mutate state and is a
   * pure peek — we honour that by returning `{ start, count: 0 }`
   * without acquiring the lock.
   */
  async reserve(keysetId: string, n: number): Promise<CounterRange> {
    if (n === 0) {
      const wallet = loadAgentWallet();
      const current = wallet?.nut13_counters[this.mintUrl]?.[keysetId] ?? 0;
      return { start: current, count: 0 };
    }
    return withWalletLock(() => {
      const wallet = this.loadOrThrow();
      const current = wallet.nut13_counters[this.mintUrl]?.[keysetId] ?? 0;
      saveAgentWallet(this.withCounter(wallet, keysetId, current + n));
      return { start: current, count: n };
    });
  }

  /**
   * Monotonic bump: ensure the persisted `next` for `keysetId` is at
   * least `minNext`. No-op if the wallet is already ahead. Used by
   * cashu-ts when the mint reports `outputs_already_signed` — the
   * losing wallet rolls forward past the colliding counter.
   */
  async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
    await withWalletLock(() => {
      const wallet = this.loadOrThrow();
      const current = wallet.nut13_counters[this.mintUrl]?.[keysetId] ?? 0;
      if (current >= minNext) return;
      saveAgentWallet(this.withCounter(wallet, keysetId, minNext));
    });
  }

  /**
   * Snapshot the per-keyset `next` map for this mint. Useful for
   * `dvm wallet show` and test assertions; cashu-ts itself does not
   * depend on `snapshot` being implemented.
   */
  snapshot(): Promise<Record<string, number>> {
    const wallet = loadAgentWallet();
    const counters = wallet?.nut13_counters[this.mintUrl] ?? {};
    const out: Record<string, number> = {};
    for (const [keyset, next] of Object.entries(counters)) {
      if (typeof next === "number") out[keyset] = next;
    }
    return Promise.resolve(out);
  }

  /**
   * Hard-set the persisted `next` for `keysetId`. Used by
   * `dvm wallet restore` to re-anchor counters after walking
   * `batchRestore` per keyset. cashu-ts also exposes this on
   * `wallet.counters.setNext`.
   */
  async setNext(keysetId: string, next: number): Promise<void> {
    await withWalletLock(() => {
      const wallet = this.loadOrThrow();
      saveAgentWallet(this.withCounter(wallet, keysetId, next));
    });
  }

  private loadOrThrow(): ReturnType<typeof loadAgentWallet> & object {
    const wallet = loadAgentWallet();
    if (!wallet) {
      throw new DvmError(
        "wallet_missing",
        "NUT-13 counter persistence requires an agent wallet at ~/.dvm/wallet.json.",
        "Run `dvm wallet init` or `dvm wallet recover --file <path>` (or pipe the mnemonic via stdin) first."
      );
    }
    return wallet;
  }

  private withCounter(
    wallet: NonNullable<ReturnType<typeof loadAgentWallet>>,
    keysetId: string,
    next: number
  ): NonNullable<ReturnType<typeof loadAgentWallet>> {
    return {
      ...wallet,
      nut13_counters: {
        ...wallet.nut13_counters,
        [this.mintUrl]: {
          ...(wallet.nut13_counters[this.mintUrl] ?? {}),
          [keysetId]: next,
        },
      },
    };
  }
}
