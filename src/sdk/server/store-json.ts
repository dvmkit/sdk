const BIGINT_TAG = "#__bigint";
const TAGGED_BIGINT = /^-?\d+#__bigint$/;

/**
 * Serialize a value bound for a Postgres-backed mppx `Store` column, tagging
 * bigints so they survive the round-trip through TEXT.
 *
 * `JSON.stringify` hard-throws on a bigint, and mppx's store values are opaque
 * to us — a Tempo session's channel state carries them today, and a charge
 * replay marker or sponsor-budget row could grow one on any version bump. The
 * `#__bigint` tag is the convention ox's `Json` gives `Store.memory()`, so a
 * value written by either backend reads back the same shape.
 *
 * `what` names the caller in the failure message; the only way to reach it is a
 * root value `JSON.stringify` drops entirely (`undefined`, a function).
 */
export function stringifyStoreValue(value: unknown, what = "Store value"): string {
  const encoded: unknown = JSON.stringify(value, (_key: string, item: unknown): unknown =>
    typeof item === "bigint" ? `${item.toString()}${BIGINT_TAG}` : item
  );
  if (typeof encoded !== "string") throw new Error(`${what} is not serializable`);
  return encoded;
}

/** Inverse of {@link stringifyStoreValue}: parse JSON, restoring tagged bigints. */
export function parseStoreValue(value: string): unknown {
  const parsed: unknown = JSON.parse(value, (_key: string, item: unknown): unknown => {
    if (typeof item === "string" && TAGGED_BIGINT.test(item)) {
      return BigInt(item.slice(0, -BIGINT_TAG.length));
    }
    return item;
  });
  return parsed;
}
