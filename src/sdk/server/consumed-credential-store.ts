/**
 * Tracks MPP challenge ids that have already been consumed by an upfront-flow
 * request, scoped per-DVM realm. Entries auto-expire after a TTL and the store
 * is bounded so a long-running DVM doesn't accumulate state without bound.
 *
 * Used by `verifyUpfrontPayment` to reject replay of an MPP credential whose
 * `(realm, challenge.id)` was already accepted within the current TTL window
 * Mid-job replay is handled separately via per-job
 * `pendingMppChallengeIds`.
 */
export interface ConsumedCredentialStore {
  /** Atomically consume a nonce only if no unexpired mark exists. */
  consume?(realm: string, challengeId: string, ttlSeconds: number): Promise<boolean>;
  /** True iff `(realm, challengeId)` was marked and the entry has not expired. */
  has(realm: string, challengeId: string): Promise<boolean>;
  /** Mark `(realm, challengeId)` as consumed for `ttlSeconds`. */
  mark(realm: string, challengeId: string, ttlSeconds: number): Promise<void>;
}

export interface MemoryConsumedCredentialStoreOpts {
  /** FIFO eviction kicks in when entry count would exceed this. Default: 10_000. */
  maxEntries?: number;
}

/**
 * In-memory `ConsumedCredentialStore`. Insertion-ordered Map provides FIFO
 * eviction at the configured cap; TTL is enforced lazily on `has()` (same
 * pattern as `MemoryKVStore`).
 *
 * Per-process and not multi-instance-safe — each replica tracks its own
 * consumed set, so a credential redirected to a different replica still works
 * once. Use only for a single-instance DVM; swap to a shared backend before
 * deploying multiple replicas.
 */
export class MemoryConsumedCredentialStore implements ConsumedCredentialStore {
  private readonly maxEntries: number;
  // Map<key, expiryMs>. Insertion-ordered, so the oldest entry is `keys().next()`.
  private readonly data = new Map<string, number>();

  constructor(opts?: MemoryConsumedCredentialStoreOpts) {
    this.maxEntries = opts?.maxEntries ?? 10_000;
  }

  has(realm: string, challengeId: string): Promise<boolean> {
    const key = `${realm}:${challengeId}`;
    const expiry = this.data.get(key);
    if (expiry === undefined) return Promise.resolve(false);
    if (Date.now() > expiry) {
      this.data.delete(key);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  consume(realm: string, challengeId: string, ttlSeconds: number): Promise<boolean> {
    const key = `${realm}:${challengeId}`;
    const now = Date.now();
    if ((this.data.get(key) ?? 0) > now) return Promise.resolve(false);
    // Active admin marks must not be evicted before their replay window ends.
    for (const [entry, expiry] of this.data) if (expiry <= now) this.data.delete(entry);
    if (this.data.size >= this.maxEntries) return Promise.reject(new Error("Nonce store capacity exhausted"));
    this.data.set(key, now + ttlSeconds * 1000);
    return Promise.resolve(true);
  }

  mark(realm: string, challengeId: string, ttlSeconds: number): Promise<void> {
    const key = `${realm}:${challengeId}`;
    // Re-insert (delete + set) so a refreshed entry moves to the back of the
    // FIFO, matching its renewed expiry. Stops "old but recently-refreshed"
    // entries from being evicted before genuinely older entries.
    if (this.data.has(key)) this.data.delete(key);
    while (this.data.size >= this.maxEntries) {
      const oldest = this.data.keys().next().value;
      if (oldest === undefined) break;
      this.data.delete(oldest);
    }
    this.data.set(key, Date.now() + ttlSeconds * 1000);
    return Promise.resolve();
  }
}
