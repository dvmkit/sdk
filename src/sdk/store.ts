import type { KVStore } from "./types";

interface Entry {
  value: unknown;
  expiry: number | undefined;
}

/** In-memory KVStore implementation for local development and testing. */
export class MemoryKVStore implements KVStore {
  private data = new Map<string, Entry>();

  /** Retrieve a value by key. Returns undefined if not found or expired. */
  get<T = unknown>(key: string): Promise<T | undefined> {
    const entry = this.data.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expiry !== undefined && Date.now() > entry.expiry) {
      this.data.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value as T);
  }

  /** Store a value. Optionally set a TTL in seconds. */
  set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
    const expiry = opts?.ttl !== undefined ? Date.now() + opts.ttl * 1000 : undefined;
    this.data.set(key, { value, expiry });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }

  /** List keys, optionally filtered by prefix. Excludes expired entries. */
  list(prefix?: string): Promise<string[]> {
    const now = Date.now();
    const keys: string[] = [];
    for (const [key, entry] of this.data) {
      if (entry.expiry !== undefined && now > entry.expiry) {
        this.data.delete(key);
        continue;
      }
      if (prefix === undefined || key.startsWith(prefix)) {
        keys.push(key);
      }
    }
    return Promise.resolve(keys);
  }
}
