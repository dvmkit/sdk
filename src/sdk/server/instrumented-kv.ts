import { createHash } from "node:crypto";

import { loggers } from "../../observability/loggers";
import type { KVStore } from "../types";

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function instrumentKVStore(inner: KVStore): KVStore {
  return {
    async get<T = unknown>(key: string): Promise<T | undefined> {
      return loggers.isolate.span("dvm.kv.read", { key_hash: hashKey(key) }, async () => {
        const value = await inner.get<T>(key);
        return value;
      });
    },

    async set(key: string, value: unknown, opts?: { ttl?: number }): Promise<void> {
      const valueSize = JSON.stringify(value).length;
      return loggers.isolate.span(
        "dvm.kv.write",
        { key_hash: hashKey(key), value_size_bytes: valueSize },
        () => inner.set(key, value, opts)
      );
    },

    async delete(key: string): Promise<void> {
      return loggers.isolate.span("dvm.kv.delete", { key_hash: hashKey(key) }, () =>
        inner.delete(key)
      );
    },

    async list(prefix?: string): Promise<string[]> {
      const attrs: Record<string, unknown> = {};
      if (prefix !== undefined) attrs.prefix_hash = hashKey(prefix);
      return loggers.isolate.span("dvm.kv.list", attrs, async () => {
        const keys = await inner.list(prefix);
        return keys;
      });
    },
  };
}
